// B2-M1-T4: optional private facts, read only after B1 finishes both passes. Failures here never
// change B1's rows or repo states; unavailable fields remove only the actions that require them.
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { mapLimit } from "../extractor";
import { startGitBudget, type GitBudget } from "../git";
import type { RunRecord } from "../runRecord";
import { readRemoteFacts, safeFactName } from "./remotes";
import { readReachFacts } from "./reach";
import { metadata, readCheckoutFacts } from "./checkouts";
import { cleanGitEnv } from "./env";
import { byteCmp, type SquashMatch } from "./groups";
import { gitIn, type RepoGit } from "./hgit";
import type { ActionFacts, RepoFacts } from "./types";

// Orchestrator-sourced measurement: worst of five runs = 3462 ms; twice, rounded up = 7000 ms.
export const B2_FACTS_BUDGET_MS = 7_000;

type StatInputs = NonNullable<RepoFacts["statInputs"]>;
type Stamp = StatInputs[number]["stamp"];

/** More inputs than this for one repo is no answer: a partial set must not look complete. */
export const STAT_INPUTS_CAP = 512;
/** Past this many symlinks on one path the kernel itself would refuse it (ELOOP). */
const LINK_HOPS_CAP = 40;

/** R5-M1: the decimal strings of `lstat`'s bigint fields, never through a JS number. ENOENT and ENOTDIR are `missing`,
 *  as git treats them; any other error is no stamp at all, which mints nothing. */
export async function encodeStamp(path: string): Promise<Stamp> {
  try {
    const st = await lstat(path, { bigint: true });
    const kind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "file";
    return { mtimeNs: st.mtimeNs.toString(), size: st.size.toString(), kind, target: kind === "symlink" ? await readlink(path) : null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { mtimeNs: "0", size: "0", kind: "missing", target: null } : null;
  }
}

// `unknown` is git's own word: Apple Git prints it for the Xcode system config. The origin rule below admits it only
// with a `file:` origin; refusing it would mint nothing on any Mac with Xcode, with every NOSYSTEM suite green.
const CONFIG_SCOPES = new Set(["system", "global", "local", "worktree", "command", "unknown"]);

/** `git config --list --show-origin --show-scope -z`, whose records are `<scope>\0<origin>\0<key>\n<value>\0`.
 *  Origins only: the values are dropped here, unread. Any other shape is null, which mints nothing (Q-M2). */
export function parseConfigOrigins(out: string): string[] | null {
  if (out === "") return [];
  if (!out.endsWith("\0")) return null;
  const parts = out.slice(0, -1).split("\0");
  if (parts.length % 3 !== 0) return null;
  const origins = new Set<string>();
  for (let i = 0; i < parts.length; i += 3) {
    const scope = parts[i]!, origin = parts[i + 1]!, entry = parts[i + 2]!;
    const nl = entry.indexOf("\n");
    if (!CONFIG_SCOPES.has(scope) || !(nl < 0 ? entry : entry.slice(0, nl)).includes(".")) return null;
    if (origin.startsWith("file:") && origin.length > "file:".length) origins.add(origin.slice("file:".length));
    else if (scope !== "command" || origin !== "command line:") return null;
  }
  return [...origins];
}

/** Whether or not they exist, so creating one later stales handles (Q-M2): read from the environment `hgit` hands git. */
export function globalConfigCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ? [env.HOME + sep + ".gitconfig"] : [];
  if (env.XDG_CONFIG_HOME) return [...home, env.XDG_CONFIG_HOME + sep + "git" + sep + "config"];
  return env.HOME ? [...home, env.HOME + sep + ".config" + sep + "git" + sep + "config"] : home;
}

/** What `readStatInputs` stamped before the facts were read: what every fact reads, and each worktree apart, because only
 *  the ones whose checkout becomes a reported `checkoutPath` are reported (`selectStatInputs`). */
export type StatRead = {
  inputs: Map<string, Stamp>;
  worktrees: { checkout: string; inputs: Map<string, Stamp> }[];
  /** Main checkouts beside their common dir; a configured linked worktree still needs its stamped entry. */
  mains: string[];
};

/** B2's own stat inputs for one repo (plan B2-M2-T7), with stamps taken BEFORE the facts are read and before each thing
 *  they lead to is read: a change after a stamp is a change Rust sees. Never an input: a `.git` directory or a worktree's
 *  own directory, whose times move with every git command, and the `worktrees/` folder, which moves with every other
 *  worktree. Null when the set itself cannot be established (the origin listing failed, a link cycle, over the cap). */
export async function readStatInputs(rg: RepoGit, commonDir: string, gitDir: string): Promise<StatRead | null> {
  const base = new Map<string, Stamp>();
  const stampOnce = async (into: Map<string, Stamp>, path: string) => { if (!into.has(path)) into.set(path, await encodeStamp(path)); };
  /** Resolve `path` as the kernel would, `..` after a link included, telling `onLink` each symlink on the way. */
  async function settle(path: string, onLink: (link: string) => Promise<void>): Promise<string> {
    const { root } = parse(path);
    const queue = path.slice(root.length).split(process.platform === "win32" ? /[\\/]/ : sep).filter((p) => p !== "");
    let current = root, hops = 0;
    while (queue.length > 0) {
      const part = queue.shift()!;
      if (part === ".") continue;
      if (part === "..") { current = dirname(current); continue; }
      const next = join(current, part);
      const st = await lstat(next).catch(() => null);
      if (st === null) return join(next, ...queue); // missing, or no stamp: the encoder says which
      if (st.isSymbolicLink()) {
        if (++hops > LINK_HOPS_CAP) throw new Error("link cycle");
        await onLink(next);
        const target = await readlink(next);
        if (isAbsolute(target)) current = parse(target).root;
        queue.unshift(...target.slice(isAbsolute(target) ? parse(target).root.length : 0).split(process.platform === "win32" ? /[\\/]/ : sep).filter((p) => p !== ""));
      } else current = next;
    }
    return current;
  }
  /** `path`: each symlink on the way is an input, then the file itself. */
  async function record(path: string, into: Map<string, Stamp> = base): Promise<void> {
    if (into.size > STAT_INPUTS_CAP || rg.budget.callTimeoutMs() === undefined) throw new Error("stat inputs cap");
    await stampOnce(into, await settle(path, (link) => stampOnce(into, link)));
  }
  /** A gitfile, or a symlink as itself: what either leads to is a git directory, whose time moves with every git command. */
  async function recordGitfile(path: string, into: Map<string, Stamp> = base): Promise<void> {
    const st = await lstat(path).catch(() => null);
    if (st === null || st.isFile()) await record(path, into);
    else if (st.isSymbolicLink()) await stampOnce(into, join(await settle(dirname(path), (link) => stampOnce(into, link)), basename(path)));
  }
  async function walk(dir: string): Promise<void> {
    await record(dir);
    const entries = await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT" || e.code === "ENOTDIR") return []; throw e; });
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(dir, entry.name));
      else await record(join(dir, entry.name));
    }
  }
  try {
    const repo = resolve(rg.repo);
    for (const candidate of globalConfigCandidates(cleanGitEnv())) await record(isAbsolute(candidate) ? candidate : repo + sep + candidate);
    await record(join(commonDir, "config"));
    await record(join(commonDir, "config.worktree"));
    await record(join(gitDir, "config.worktree"));
    await recordGitfile(join(repo, ".git"));
    // A main checkout whose git dir lives elsewhere (`--separate-git-dir`, a submodule): its own top is its main checkout, a
    // configured subdirectory's top holding the gitfile. Unknown is no main: a checkout relying on it then mints nothing.
    let ownTop: string | null = null;
    const top = await gitIn(rg, ["rev-parse", "--show-toplevel"]).catch(() => null);
    const printed = top?.code === 0 && top.out.endsWith("\n") ? top.out.slice(0, -1) : null;
    if (gitDir === commonDir && printed !== null && isAbsolute(printed) && printed !== dirname(commonDir)) {
      ownTop = await realpath(printed).catch(() => null);
      if (ownTop !== null && ownTop !== repo) await recordGitfile(join(ownTop, ".git"));
    }
    const worktrees: StatRead["worktrees"] = [];
    const folder = join(commonDir, "worktrees");
    const entries = await readdir(folder, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT" || e.code === "ENOTDIR") return []; throw e; });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const backlink = (await metadata(join(folder, entry.name, "gitdir"))).replace(/\n$/, "");
        // The same canonical checkout as checkouts.ts:46, including the filesystem's case spelling.
        if (!isAbsolute(backlink) || basename(backlink) !== ".git") continue;
        const checkout = await realpath(dirname(backlink)).catch(() => null);
        if (checkout === null) continue;
        const inputs = new Map<string, Stamp>();
        await record(join(folder, entry.name, "gitdir"), inputs);
        await record(join(folder, entry.name, "commondir"), inputs);
        await recordGitfile(backlink, inputs);
        worktrees.push({ checkout, inputs });
      } catch { /* one unreadable/forged entry, including a link cycle, never voids the other checkouts */ }
    }
    await walk(join(commonDir, "remotes"));
    await walk(join(commonDir, "branches"));
    // Last, so a config edit after the fixed files' stamps shows on those stamps; the files it names are stamped here.
    const r = await gitIn(rg, ["config", "--list", "--show-origin", "--show-scope", "-z"]);
    const origins = r.code === 0 ? parseConfigOrigins(r.out) : null;
    if (origins === null) return null;
    // Never normalised: git prints an include as written, and `link/../x` is not `x` when `link` is a symlink. A relative
    // origin is from the top git moved to, not a configured subdirectory: `.git/config` there is `<top>/.git/config`.
    const from = printed !== null && isAbsolute(printed) ? printed : repo;
    for (const origin of origins) await record(isAbsolute(origin) ? origin : from + sep + origin);
    const mains = await realpath(dirname(commonDir)).then((main) => [main]).catch(() => [] as string[]);
    return { inputs: base, worktrees, mains: ownTop === null ? mains : [...mains, ownTop] };
  } catch { return null; }
}

/** The stat inputs a repo reports, once its facts are read: the fixed ones plus the entries of each worktree whose checkout
 *  became a `checkoutPath`, all stamped earlier, never here. A checkout with no such entry appeared after those stamps, so
 *  it has none from before the read: no answer, which mints nothing. Worktrees no fact relies on come and go freely. */
export function selectStatInputs(read: StatRead | null, branches: RepoFacts["branches"]): StatInputs | null {
  if (read === null) return null;
  const stamps = new Map(read.inputs);
  for (const checkout of new Set((branches ?? []).flatMap((b) => b.checkoutPath ?? []))) {
    const entries = read.worktrees.filter((w) => w.checkout === checkout);
    if (entries.length === 0 && !read.mains.includes(checkout)) return null;
    for (const [path, stamp] of entries.flatMap((w) => [...w.inputs])) if (!stamps.has(path)) stamps.set(path, stamp);
  }
  if (stamps.size > STAT_INPUTS_CAP) return null;
  const inputs = [...stamps].sort(([a], [b]) => byteCmp(a, b)).map(([path, stamp]) => ({ path, stamp }));
  return inputs.every((i) => safeFactName(i.path) && (i.stamp?.target == null || safeFactName(i.stamp.target))) ? inputs : null;
}

export async function readActionFacts(
  repos: readonly { rg: RepoGit; commonDir: string; gitDir: string; commits: readonly string[]; squashed: ReadonlyMap<string, SquashMatch> }[],
  opts: { branches: readonly string[]; overall: GitBudget; concurrency: number; labels: RunRecord["labels"] | null; windowStart: Date; now: Date },
): Promise<ActionFacts> {
  const budget = startGitBudget(Math.min(B2_FACTS_BUDGET_MS, opts.overall.remainingMs()));
  budget.remainingMs();
  if (budget.callTimeoutMs() === undefined) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budget.remainingMs());
  });
  async function beforeDeadline<T>(read: Promise<T>): Promise<T | null> {
    const result = await Promise.race([read, expired]);
    // A filesystem completion may win the event-loop race after the clock's deadline.
    return budget.remainingMs() > 0 ? result : null;
  }
  try {
    const facts = await mapLimit([...repos], opts.concurrency, async (repo): Promise<RepoFacts | null> => {
      if (budget.callTimeoutMs() === undefined) return null;
      const rg = { ...repo.rg, budget }; // B1's per-repo slice is finished, never reused or extended.
      try {
        const statRead = await beforeDeadline(readStatInputs(rg, repo.commonDir, repo.gitDir));
        let result = await beforeDeadline(readRemoteFacts(rg, repo.commonDir));
        if (result === null || (result.remotes === null && result.branches === null)) return null;
        if (budget.callTimeoutMs() !== undefined) {
          result = await beforeDeadline(readReachFacts(rg, result, repo.commits, opts.windowStart, opts.now, repo.squashed)) ?? result;
        }
        if (budget.callTimeoutMs() !== undefined) {
          result = await beforeDeadline(readCheckoutFacts(rg, repo.commonDir, result, opts.labels, opts.branches)) ?? result;
        }
        return { ...result, statInputs: selectStatInputs(statRead, result.branches) };
      } catch { return null; } // A missing/replaced repo cannot fail the already-completed B1 reply.
    });
    return facts.filter((f): f is RepoFacts => f !== null);
  } finally { clearTimeout(timer); }
}
