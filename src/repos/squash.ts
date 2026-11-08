// src/repos/squash.ts — the squash check (B1-M2-T6, wave-2 plan; B1 spec "Pushed", the kept branch).
//
// A kept local branch counts as MERGED when its changes match a squash commit S on the default ref whose
// subject ends "(#N)", among the "(#N)" commits newer than the branch's merge-base with the default ref
// (the default ref is the union `defaultRefs` gives: the merge-base is git's own, of the tip and every
// default ref's SHA). At most `SQUASH_CHECK_CAP` candidate checks per repo, shared by its branches; past
// it a branch keeps its amber "N not pushed".
//   the primary test: `merge-tree --write-tree --end-of-options <S>^ <tip>` gives exactly `S^{tree}`. It
//     runs with a THROWAWAY object directory (`GIT_OBJECT_DIRECTORY` a fresh 0700 temp dir, the repo's
//     objects as `GIT_ALTERNATE_OBJECT_DIRECTORIES`), removed in a `finally`, so nothing is written to the
//     repo; a repo-scoped merge driver is emptied by the hardening's lead, which makes git report a
//     conflict (the designed fallback). An objects path holding the alternates separator is not passed.
//   the fallback, when merge-tree refuses (exit 1 a conflict, a git before 2.38, any other refusal): the
//     patch-id of the branch's cumulative change (merge-base to tip) equals S's (S^ to S). Each diff is
//     `diff --no-textconv --no-ext-diff --no-color --src-prefix=a/ --dst-prefix=b/ --end-of-options <a>
//     <b>` read through a capped pipe (over 1 MiB: killed, amber, no spool or patch-id), then written
//     into a 0700 temp dir; `patch-id
//     --stable` reads it; the dir is removed in a `finally`. Never `log -p` (an emptied textconv makes it
//     fatal) and never `patchIds` (it runs outside the hardening).
//   otherwise amber, the residual (a branch edited after the merge; a squash that resolved a conflict).
// A check Rust kills past its read bound runs no `finally`, so its throwaway dirs stay: each later check removes
// the stale ones first (`sweepStaleSquashDirs`, called by status.ts).
// Every revision is a 40-hex SHA (each ref resolved first), after `--end-of-options`.
import { lstat, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LISTING_MAX_BYTES } from "../git";
import { gitIn, gitOut, resolveIn, RepoUnknown } from "./hgit";
import type { RepoScan, SquashMatch } from "./groups";

/** At most this many candidate checks per repo in a `repos status` call. */
export const SQUASH_CHECK_CAP = 16;
/** A spooled diff over this answers amber without running `patch-id`. */
export const SPOOL_MAX_BYTES = 1024 * 1024;

const SHA40 = /^[0-9a-f]{40}$/;
/** The separator of `GIT_ALTERNATE_OBJECT_DIRECTORIES` (`git help git`). */
const ALT_SEP = process.platform === "win32" ? ";" : ":";

/** Where the throwaway object directories and spools are made (a test points it at its own tree). */
export type SquashOpts = { tmpRoot?: string };

/** The throwaway dirs' name: this prefix and `mkdtemp`'s six characters. */
const TEMP_PREFIX = "dba-squash-";
const TEMP_NAME = /^dba-squash-[A-Za-z0-9]{6}$/;
/** A throwaway dir older than this was left by a check that was killed (Rust kills the engine's process
 *  group past its 30 s read bound, and a `finally` does not run): far longer than any check lives. */
export const SQUASH_STALE_MS = 5 * 60_000;

/** Remove what killed checks left in `root`: each entry named exactly as `withTempDir` names one, that is a
 *  real directory (never a symlink, never followed), owned by this user, and last modified more than
 *  `SQUASH_STALE_MS` ago (the real clock). Nothing else in `root` is touched; every failure is ignored.
 *  Answers how many it removed. */
export async function sweepStaleSquashDirs(root: string, nowMs: number = Date.now()): Promise<number> {
  let names: string[];
  try { names = await readdir(root); } catch { return 0; }
  const uid = process.getuid?.();
  let removed = 0;
  for (const name of names) {
    if (!TEMP_NAME.test(name)) continue;
    const path = join(root, name);
    try {
      const st = await lstat(path);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || nowMs - st.mtimeMs <= SQUASH_STALE_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed++;
    } catch { /* gone, or not ours to remove */ }
  }
  return removed;
}

async function withTempDir<T>(root: string, f: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(root, TEMP_PREFIX));   // mkdtemp makes it 0700
  try { return await f(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** The patch-id of `diff <a> <b>`, or null (an empty or failed diff, a spool over `SPOOL_MAX_BYTES`, or a
 *  patch-id that printed none). A timeout throws `RepoUnknown`. */
async function patchIdOf(scan: RepoScan, a: string, b: string, root: string): Promise<string | null> {
  return withTempDir(root, async (dir) => {
    const spool = join(dir, "change.diff");
    let d;
    try {
      d = await gitIn(scan.rg, ["diff", "--no-textconv", "--no-ext-diff", "--no-color", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--end-of-options", a, b], { stdoutPath: spool, maxBytes: SPOOL_MAX_BYTES });
    } catch (e) {
      if (e instanceof RepoUnknown && e.reason === "error") return null; // capped or unreadable diff: amber
      throw e;
    }
    if (d.code !== 0) return null;
    const st = await stat(spool).catch(() => null);
    if (st === null || st.size === 0) return null;
    const p = await gitIn(scan.rg, ["patch-id", "--stable"], { stdinPath: spool });
    if (p.code !== 0) return null;
    const id = p.out.split(/\s+/)[0] ?? "";
    return SHA40.test(id) ? id : null;
  });
}

/** `merge-tree --write-tree` of `<s>^` and `tip` into a throwaway object directory: the tree it wrote, or
 *  "refused" (any exit but 0, or output that is not one tree line). A timeout throws `RepoUnknown`. */
async function mergeTree(scan: RepoScan, s: string, tip: string, objects: string, root: string): Promise<string | "refused"> {
  return withTempDir(root, async (dir) => {
    let r;
    try {
      r = await gitIn(scan.rg, ["merge-tree", "--write-tree", "--end-of-options", `${s}^`, tip],
        { env: { GIT_OBJECT_DIRECTORY: dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects } });
    } catch (e) {
      if (e instanceof RepoUnknown && e.reason === "error") return "refused";   // its output passed the cap
      throw e;
    }
    const first = r.out.split("\n")[0] ?? "";
    return r.code === 0 && SHA40.test(first) ? first : "refused";
  });
}

/** Whether `branchRef` (a full `refs/heads/…` name, not a default ref) counts as squash-merged: the
 *  matching PR, or null. Each candidate checked spends one of `cap.left`. Throws `RepoUnknown` when a
 *  call fails or the budget runs out. */
export async function squashMatch(scan: RepoScan, branchRef: string, commonDir: string, cap: { left: number }, opts: SquashOpts = {}): Promise<SquashMatch | null> {
  const root = opts.tmpRoot ?? tmpdir();
  const { refs } = await scan.defaults();
  if (!branchRef.startsWith("refs/heads/") || refs.includes(branchRef) || refs.length === 0) return null;
  const squashes = await scan.squashes();
  if (squashes.length === 0 || cap.left <= 0) return null;
  const tip = await resolveIn(scan.rg, `${branchRef}^{commit}`);
  if (tip === null) return null;
  const defaults = await scan.defaultShas();
  if (defaults.length === 0) return null;
  const mbr = await gitIn(scan.rg, ["merge-base", "--end-of-options", tip, ...defaults]);
  const mbLines = mbr.out.split("\n").filter((l) => l !== "");
  if (mbr.code === 1 && mbLines.length === 0) return null;              // no merge-base: amber
  if (mbr.code !== 0 || mbLines.length !== 1 || !SHA40.test(mbLines[0]!)) throw new RepoUnknown("error", "merge-base");
  const mb = mbLines[0]!;
  // the "(#N)" candidates newer than the merge-base: on the default refs and not reachable from it
  const newer = new Set((await gitOut(scan.rg, ["rev-list", "--end-of-options", ...defaults, `^${mb}`], { maxBytes: LISTING_MAX_BYTES })).split("\n"));
  const candidates = squashes.filter((s) => newer.has(s.sha));
  const objects = join(commonDir, "objects");
  const canMergeTree = !objects.includes(ALT_SEP);
  let branchId: string | null | undefined;
  for (const s of candidates) {
    if (cap.left <= 0) break;
    cap.left--;
    const tree = canMergeTree ? await mergeTree(scan, s.sha, tip, objects, root) : "refused";
    if (tree !== "refused") {
      if (tree === (await resolveIn(scan.rg, `${s.sha}^{tree}`))) return { number: s.number, sha: s.sha, title: s.title };
      continue;
    }
    if (branchId === undefined) branchId = await patchIdOf(scan, mb, tip, root);
    if (branchId === null) continue;
    if ((await patchIdOf(scan, `${s.sha}^`, s.sha, root)) === branchId) return { number: s.number, sha: s.sha, title: s.title };
  }
  return null;
}

/** `squashMatch` for each of `branchRefs` in order, sharing `cap`: the branches that count as merged. */
export async function squashMatches(scan: RepoScan, branchRefs: readonly string[], commonDir: string, cap: { left: number }, opts: SquashOpts = {}): Promise<Map<string, SquashMatch>> {
  const out = new Map<string, SquashMatch>();
  for (const ref of branchRefs) {
    const m = await squashMatch(scan, ref, commonDir, cap, opts);
    if (m !== null) out.set(ref, m);
  }
  return out;
}
