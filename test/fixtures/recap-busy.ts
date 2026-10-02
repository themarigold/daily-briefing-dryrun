// test/fixtures/recap-busy.ts — a BUSY morning for the tier-B (Stage-2 recap campaigns) runCore tests.
//
// One real git repo, built by ONE `sh` spawn (a 40-commit `buildRepo` would cost ~120 spawns), whose
// commits each touch their OWN file with a subject that shares no leading phrase and no campaign token
// with any other (`adjust q<i> widget`) — so Stage 1 forms NO group and `topLevelRecapCount` of the
// parsed recap is exactly the number of recap bullets the canned reply carries. That is what lets the
// gate pins set `(commits, top)` precisely. Every commit sits on ONE earlier local day, the
// `yesterdayNoon` idiom (plan §1 fixture dating; `windowStart` stops at the most recent earlier day with
// a commit, so a spread would drop all but the nearest day), i minutes apart.
//
// The dir comes from `buildRepo([])`, so it is registered for run-end removal like every other repo
// fixture (`test/fixtures/temp-dirs.ts`).
import { basename } from "node:path";
import { buildRepo } from "./build-repo";
import type { Config } from "../../src/types";

export const yesterdayNoon = (): Date => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d; };

export type BusyRepo = { dir: string; label: string; shas: string[] };

/** `n` commits, oldest first in `shas`. */
export async function busyRepo(n: number): Promise<BusyRepo> {
  const dir = await buildRepo([]);
  const base = yesterdayNoon().getTime();
  const script = ["set -e"];
  for (let i = 0; i < n; i++) {
    const iso = new Date(base + i * 60_000).toISOString();
    script.push(`printf 'q${i}\\n' > f${i}.txt && git add f${i}.txt && GIT_AUTHOR_DATE=${iso} GIT_COMMITTER_DATE=${iso} git commit -q -m 'adjust q${i} widget'`);
  }
  // A NEUTRAL git config, as `buildRepo` itself uses (round-4 harden D4-L1): a developer's global
  // `commit.gpgsign=true` must not call their real signer here (measured: it failed every busyRepo).
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const p = Bun.spawnSync(["sh", "-c", script.join("\n")], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`busyRepo: ${p.stderr.toString()}`);
  const log = Bun.spawnSync(["git", "log", "--reverse", "--format=%H"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  const shas = log.stdout.toString().trim().split("\n").filter(Boolean);
  if (shas.length !== n) throw new Error(`busyRepo: ${shas.length} commits, wanted ${n}`);
  return { dir, label: basename(dir), shas };
}

/** The span bullets 1 and 2 share — a valid campaign title over items G1 and G2 (§4.6: verbatim, 3–48
 *  code points, a meaning word, no label, no hex run). */
export const CAMPAIGN_TITLE = "rework ledger rounding";
/** A reply the grouper returns: ONE campaign over the first two offered items. */
export const CAMPAIGN_REPLY = JSON.stringify({ campaigns: [{ title: CAMPAIGN_TITLE, items: ["G1", "G2"] }] });

/** The canned MAIN-call reply: one RESUME bullet, `lines` RECAP bullets citing the first `lines` commits
 *  (bullets 1–2 carry `CAMPAIGN_TITLE`, the rest are distinct), one SUGGESTION. */
export function busyReply(repo: BusyRepo, lines: number): string {
  const recap = repo.shas.slice(0, lines).map((sha, i) =>
    `- [${repo.label}] ${i < 2 ? `${CAMPAIGN_TITLE} step ${i + 1}` : `polish piece number ${i}`} | evidence: ${sha.slice(0, 7)}`);
  return ["## RESUME", `- [${repo.label}] resume the ledger rework`, "## RECAP", ...recap,
    "## SUGGESTIONS", `- [${repo.label}] finish the ledger rework`].join("\n");
}

/** A minimal valid Config over the repo (the `test/core.test.ts` `mkCfg` shape), plus `extra`. */
export const busyCfg = (repo: BusyRepo, extra: Record<string, unknown> = {}): Config => ({
  repos: [repo.dir], excludeCommitPatterns: [], lookbackCapDays: 30,
  provider: { cli: "echo", argv: [], promptVia: "stdin" },
  ...extra,
} as Config);
