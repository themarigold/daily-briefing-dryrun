// src/repos/harden.ts — the live git check's hardening (B1-M1-T2, wave-2 plan; B1 spec "Hardening").
//
// No repo-supplied code runs, nothing is written to the repo, and nothing is fetched. Every git call the
// live check makes in a repo carries `hardenArgs`' `lead`:
//   --no-optional-locks   git's own control: no `index.lock`, no index refresh write (`git.html`'s
//                         `--no-optional-locks`, the same as GIT_OPTIONAL_LOCKS=0);
//   --no-lazy-fetch       when this git accepts it (`lazyFetchProbe`): a partial clone's missing object
//                         fails the call instead of fetching it from the promisor remote; when the flag
//                         is refused, a repo that is (or may be) a partial clone answers `unknown`;
//   -c core.fsmonitor=false
//                         no fsmonitor hook;
//   --no-replace-objects  read real objects; the base -c settings also disable signature programs,
//                         external diffs, renormalization and hooks, and prevent submodule descent;
//   the repo-scoped drivers, emptied (OD2, orchestrator-settled 2026-10-24): every `filter.<d>`,
//                         `merge.<d>` and `diff.<d>` driver whose config entry has scope `local` or
//                         `worktree` (an `include.path` file reached from the repo's config reports
//                         `local`, measured) gets `-c filter.<d>.clean= -c filter.<d>.process=
//                         -c filter.<d>.smudge=`, `-c merge.<d>.driver=`, `-c diff.<d>.textconv=
//                         -c diff.<d>.command=`. Drivers from global or system config are the user's own
//                         tools and run as git runs them (overriding a global `required` filter such as
//                         `filter.lfs` would make every LFS repo fail).
// The callers add the rest per command: `--ignore-submodules=all` on every `status`; `NO_SHOW_SIGNATURE`
// and an explicit `--format` on every `log` and `show` (so `gpg.program` never runs); `--no-textconv
// --no-ext-diff --no-color` on every patch or diff; and never `log -p` (an emptied textconv makes it
// fatal, measured).
import type { GitBudget } from "../git";
import { partialCloneFrom } from "../git";
import { hgit, type HgitResult } from "./hgit";
import { isAbsolute, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";

/** Why a repo cannot be read safely. `partial-clone`: git refused `--no-lazy-fetch` and the repo is a
 *  partial clone, which could then fetch. */
export type HardenUnknown = "dubious-ownership" | "timeout" | "error" | "required-filter" | "partial-clone" | "elsewhere";
/** `toplevel` is the working tree's root (`--show-toplevel`): a configured subdirectory shares its checkout's. */
export type Hardened = { lead: string[]; gitDir: string; commonDir: string; toplevel: string };

/** True iff `git --version` output reports at least `major.minor`. Pure. */
export function gitVersionAtLeast(output: string, major: number, minor: number): boolean {
  const m = /git version (\d+)\.(\d+)/.exec(output);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a > major || (a === major && b >= minor);
}

/** The floor: `rev-parse --path-format=absolute` (git 2.31). `--end-of-options` is older (2.24 for the
 *  parser, 2.30 for rev-parse; git's release notes), so this floor covers every argv form the check uses. */
export const GIT_FLOOR = [2, 31] as const;

export type GitProbe = { lazyFetch: boolean; version: string; tooOld: boolean };

/** Once per `repos status` call: `git --no-lazy-fetch --version` (exit 0 means the flag is accepted, and
 *  its output is the version), else one plain `git --version`. Below `GIT_FLOOR` (or no readable version)
 *  the call is `tooOld` and no repo is run. */
export async function lazyFetchProbe(timeoutMs: number): Promise<GitProbe> {
  const flagged = await hgit(null, ["--no-lazy-fetch", "--version"], { lead: [], timeoutMs });
  let version: string;
  let lazyFetch: boolean;
  if (flagged.code === 0 && flagged.complete) {
    lazyFetch = true;
    version = flagged.out;
  } else {
    lazyFetch = false;
    const plain = await hgit(null, ["--version"], { lead: [], timeoutMs });
    version = plain.code === 0 && plain.complete ? plain.out : "";
  }
  return { lazyFetch, version, tooOld: !gitVersionAtLeast(version, GIT_FLOOR[0], GIT_FLOOR[1]) };
}

export type Driver = { section: "filter" | "merge" | "diff"; name: string };

/** Parse `git config --show-scope --name-only --get-regexp '^(filter|merge|diff)\.'` (plan B1-M1-T2,
 *  "Parsing the listing"). Each line is `<scope>\t<key>`; only `local` and `worktree` scopes count. In the
 *  key the section is the text before the FIRST `.`, the variable the text after the LAST `.`, and the
 *  driver name everything between, dots kept (`filter.a.b.clean` is driver `a.b`). A key with exactly
 *  ONE dot (`merge.ff`, `diff.renames`) is a two-part setting, not a driver, and is skipped. An empty
 *  subsection is a driver: `filter..clean` is the driver named "" (`[filter ""]`). A name `-c` cannot
 *  carry (`=` ends the key in `-c`; a newline cannot reach `-c` at all) makes the listing `bad`. Pure. */
export function parseDriverListing(out: string): { drivers: Driver[] } | { bad: true } {
  const drivers: Driver[] = [];
  const seen = new Set<string>();
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    if (tab === -1) return { bad: true };
    const scope = line.slice(0, tab), key = line.slice(tab + 1);
    if (scope !== "local" && scope !== "worktree") continue;
    const first = key.indexOf("."), last = key.lastIndexOf(".");
    if (first === -1 || first === last) continue;
    const section = key.slice(0, first);
    if (section !== "filter" && section !== "merge" && section !== "diff") continue;
    const name = key.slice(first + 1, last);
    if (name.includes("=") || name.includes("\n") || name.includes("\0")) return { bad: true };
    const id = `${section}\0${name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    drivers.push({ section, name });
  }
  return { drivers };
}

/** The `-c` pairs that empty each driver's commands. Pure. */
export function driverOverrides(drivers: readonly Driver[]): string[] {
  const vars = { filter: ["clean", "process", "smudge"], merge: ["driver"], diff: ["textconv", "command"] } as const;
  return drivers.flatMap((d) => vars[d.section].flatMap((v) => ["-c", `${d.section}.${d.name}.${v}=`]));
}

/** A `config` query's three outcomes: its output; "none" (exit 1 with empty output, git's "no match");
 *  or a failure. */
function configAnswer(r: HgitResult): { out: string } | "none" | { unknown: "timeout" | "error" } {
  if (r.timedOut) return { unknown: "timeout" };
  if (!r.complete) return { unknown: "error" };
  if (r.code === 0) return { out: r.out };
  if (r.code === 1 && r.out.trim() === "") return "none";
  return { unknown: "error" };
}

/** `isPartialClone`'s three `config` queries (src/git.ts), through `hgit`, decided by `partialCloneFrom`.
 *  Strict where `isPartialClone` fails open: "no match" only on exit 1 with empty output; any other exit
 *  or a timeout is `unknown` (`isPartialClone` reads every failure as `false`). */
export async function partialCloneStrict(repo: string, lead: readonly string[], timeoutMs: number): Promise<"partial" | "not-partial" | "unknown"> {
  const reads = await Promise.all([
    hgit(repo, ["config", "--local", "--get-regexp", "^extensions\\.partialclone$"], { lead, timeoutMs }),
    hgit(repo, ["config", "--type=bool", "--get-regexp", "^remote\\..+\\.promisor$"], { lead, timeoutMs }),
    hgit(repo, ["config", "--get-regexp", "^remote\\..+\\.partialclonefilter$"], { lead, timeoutMs }),
  ]);
  const outs: string[] = [];
  for (const r of reads) {
    const a = configAnswer(r);
    if (a === "none") outs.push("");
    else if ("out" in a) outs.push(a.out);
    else return "unknown";
  }
  return partialCloneFrom(outs[0]!, outs[1]!, outs[2]!) ? "partial" : "not-partial";
}

const BASE_LEAD = [
  "--no-optional-locks", "--no-replace-objects",
  "-c", "diff.ignoreSubmodules=all", "-c", "diff.submodule=short",
  "-c", "log.showSignature=false", "-c", "diff.external=", "-c", "diff.relative=false",
  "-c", "merge.renormalize=false", "-c", "core.hooksPath=/dev/null",
];

/** The hardening for one repo, or why it cannot be had. Every call starts only when `budget` allows. */
export async function hardenArgs(repo: string, budget: GitBudget, laz: { lazyFetch: boolean }): Promise<Hardened | { unknown: HardenUnknown }> {
  const t = (): number | undefined => budget.callTimeoutMs();
  // 1. The first call: the git dir, common dir and worktree root, all ABSOLUTE (`--path-format=absolute`: without it
  //    a primary checkout prints its common dir relative, measured). It is also the call that detects
  //    "dubious ownership": `config --get-regexp` exits 1 silently on such a repo, `rev-parse` exits 128
  //    naming it (measured). Nothing is ever added to `safe.directory`.
  const t1 = t();
  if (t1 === undefined) return { unknown: "timeout" };
  const rp = await hgit(repo, ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir", "--show-toplevel"], { lead: BASE_LEAD, timeoutMs: t1 });
  if (rp.dubious) return { unknown: "dubious-ownership" };
  if (rp.timedOut) return { unknown: "timeout" };
  if (rp.code !== 0 || !rp.complete) return { unknown: "error" };
  const dirs = rp.out.split("\n").filter((l) => l !== "");
  if (dirs.length !== 3 || !dirs.every((d) => isAbsolute(d))) return { unknown: "error" };
  const [gitDir, commonDir, toplevel] = dirs as [string, string, string];
  // A configured subdirectory may use its enclosing worktree, but only without core.worktree:
  // a redirect to an ancestor would otherwise pass containment and let status walk that ancestor.
  // Git/common dirs may still live elsewhere (linked worktrees).
  try {
    const within = relative(await realpath(toplevel), await realpath(repo));
    if (within !== "") {
      if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return { unknown: "elsewhere" };
      const timeoutMs = t();
      if (timeoutMs === undefined) return { unknown: "timeout" };
      const worktree = configAnswer(await hgit(repo, ["config", "--get", "core.worktree"], { lead: BASE_LEAD, timeoutMs }));
      if (worktree !== "none") {
        if (!("out" in worktree)) return worktree;
        if (worktree.out.replace(/\n$/, "") !== "") return { unknown: "elsewhere" };
      }
    }
  } catch { return { unknown: "error" }; }

  // 2. The repo-scoped drivers, from ONE listing (exit 1: none).
  const t2 = t();
  if (t2 === undefined) return { unknown: "timeout" };
  const listing = configAnswer(await hgit(repo, ["config", "--show-scope", "--name-only", "--get-regexp", "^(filter|merge|diff)\\."], { lead: BASE_LEAD, timeoutMs: t2 }));
  if (listing !== "none" && !("out" in listing)) return listing;
  const parsed = parseDriverListing(listing === "none" ? "" : listing.out);
  if ("bad" in parsed) return { unknown: "error" };
  const drivers = parsed.drivers;

  // 3. A repo-scoped filter that is `required` cannot be emptied honestly: git then fails the call
  //    ("clean filter 'x' failed", measured), so the repo answers `unknown`, never weakened to
  //    `required = false`. Read through git's own boolean parser; the LAST value of a key wins, as in git.
  const filters = drivers.filter((d) => d.section === "filter");
  if (filters.length > 0) {
    const t3 = t();
    if (t3 === undefined) return { unknown: "timeout" };
    const req = configAnswer(await hgit(repo, ["config", "--type=bool", "--get-regexp", "^filter\\..*\\.required$"], { lead: BASE_LEAD, timeoutMs: t3 }));
    if (req !== "none" && !("out" in req)) return req;
    const last = new Map<string, string>();
    for (const line of (req === "none" ? "" : req.out).split("\n")) {
      const sp = line.lastIndexOf(" ");   // the value is `true` / `false`; a driver name may hold spaces
      if (sp === -1) continue;
      last.set(line.slice(0, sp), line.slice(sp + 1));
    }
    if (filters.some((d) => last.get(`filter.${d.name}.required`) === "true")) return { unknown: "required-filter" };
  }

  // 4. A git that refuses --no-lazy-fetch: only a conclusively non-partial repo runs without it.
  if (!laz.lazyFetch) {
    const t4 = t();
    if (t4 === undefined) return { unknown: "timeout" };
    const pc = await partialCloneStrict(repo, BASE_LEAD, t4);
    if (pc === "partial") return { unknown: "partial-clone" };
    if (pc === "unknown") return { unknown: "error" };
  }

  return {
    lead: [...BASE_LEAD, ...(laz.lazyFetch ? ["--no-lazy-fetch"] : []), "-c", "core.fsmonitor=false", ...driverOverrides(drivers)],
    gitDir,
    commonDir,
    toplevel,
  };
}
