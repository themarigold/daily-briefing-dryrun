// B2-M1-T3: reciprocal worktree metadata is evidence, never a path grant from the webview.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hardenArgs } from "./harden";
import { gitIn, gitOut, HGIT_MAX_BYTES, type RepoGit } from "./hgit";
import { byteCmp } from "./groups";
import { safeFactName } from "./remotes";
import { norm } from "../subprojects";
import type { RunRecord } from "../runRecord";
import type { RepoFacts } from "./types";

/** Inputs are already canonical, UTF-8 paths; do not realpath fixture placeholders or hash a label. */
export function projectKey(repoRealPath: string, repoRelativeRoot: string): string {
  return createHash("sha256").update(repoRealPath + "\0" + repoRelativeRoot).digest("hex").slice(0, 32);
}

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
};

/** Bounded, no-follow metadata-file read; reject an identity/stamp change during the read. */
export async function metadata(path: string): Promise<string> {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await f.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(HGIT_MAX_BYTES)) throw new Error("metadata type/cap");
    const buf = Buffer.alloc(Number(before.size) + 1);
    let n = 0;
    while (n < buf.length) {
      const r = await f.read(buf, n, buf.length - n, null);
      if (r.bytesRead === 0) break;
      n += r.bytesRead;
    }
    const after = await f.stat({ bigint: true });
    if (n !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("metadata changed");
    return buf.subarray(0, n).toString("utf8");
  } finally { await f.close(); }
}

/** `branch` is null on a detached HEAD: a real checkout, so its folders count, but it holds no branch to launch. */
async function checkout(rg: RepoGit, commonDir: string, candidate: string, entry: string | null): Promise<{ path: string; branch: string | null } | null> {
  try {
    if (rg.budget.callTimeoutMs() === undefined) return null;
    const path = await realpath(candidate);
    if (!safeFactName(path)) return null;
    const dotgit = join(path, ".git");
    const kind = await lstat(dotgit);
    if (kind.isSymbolicLink()) return null;
    if (entry === null) {
      if (kind.isDirectory()) {
        if (await realpath(dotgit) !== commonDir) return null;
      } else if (kind.isFile()) {
        const match = /^gitdir: ([^\n\0]+)\n?$/.exec(await metadata(dotgit));
        if (!match || await realpath(resolve(path, match[1]!)) !== commonDir) return null;
      } else return null;
    } else {
      if (!kind.isFile()) return null;
      const text = await metadata(dotgit);
      const match = /^gitdir: ([^\n\0]+)\n?$/.exec(text);
      if (!match) return null;
      const gitDir = await realpath(resolve(path, match[1]!));
      if (gitDir !== entry || !within(join(commonDir, "worktrees"), gitDir)) return null;
      const commondir = (await metadata(join(entry, "commondir"))).replace(/\n$/, "");
      if (await realpath(resolve(entry, commondir)) !== commonDir) return null;
      const backlink = (await metadata(join(entry, "gitdir"))).replace(/\n$/, "");
      if (!isAbsolute(backlink) || await realpath(backlink) !== await realpath(dotgit)) return null;
    }
    const h = await hardenArgs(path, rg.budget, { lazyFetch: rg.lead.includes("--no-lazy-fetch") });
    if ("unknown" in h || await realpath(h.commonDir) !== commonDir || await realpath(h.toplevel) !== path) return null;
    if (await realpath(h.gitDir) !== (entry ?? commonDir)) return null;
    const branch = await gitIn({ ...rg, repo: path, lead: h.lead }, ["symbolic-ref", "--quiet", "HEAD"]);
    if (branch.code === 1) return { path, branch: null };
    const m = /^refs\/heads\/([^\n]+)\n$/.exec(branch.out);
    return branch.code === 0 && m ? { path, branch: m[1]! } : null;
  } catch { return null; }
}

export async function readCheckoutFacts(rg: RepoGit, common: string, facts: RepoFacts, labels: RunRecord["labels"] | null, names: readonly string[]): Promise<RepoFacts> {
  const result: RepoFacts = { ...facts, roots: null, cardKeys: null, branches: facts.branches?.map((b) => ({ ...b, checkoutPath: null })) ?? null };
  let repo: string, commonDir: string;
  try { repo = await realpath(rg.repo); commonDir = await realpath(common); }
  catch { return result; }
  if (repo !== facts.path || !safeFactName(repo)) return result;
  // Root -> the public card keys that map to it: `norm`, the one rule that builds `labels[].key` (status.ts); and the first of
  // its labels as written, which is what the rest of the app shows for it. The join needs no checkout, so it comes first.
  const roots = new Map<string, { keys: Set<string>; displayLabel: string | null }>();
  for (const [label, item] of Object.entries(labels ?? {}).sort(([a], [b]) => byteCmp(a, b))) {
    try {
      if (await realpath(item.repo) !== repo) continue;
      const root = item.root ?? "";
      const entry = roots.get(root) ?? { keys: new Set<string>(), displayLabel: null };
      roots.set(root, entry);
      const key = norm(label);
      if (!safeFactName(key)) continue;
      entry.keys.add(key);
      if (safeFactName(label)) entry.displayLabel ??= label;
    } catch { /* no canonical project identity */ }
  }
  result.cardKeys = [...new Set([...roots.values()].flatMap((r) => [...r.keys]))].sort(byteCmp);
  if (result.branches === null) return result;
  const candidates: { path: string; entry: string | null }[] = [];
  if (basename(commonDir) === ".git") candidates.push({ path: dirname(commonDir), entry: null });
  // A configured subdirectory's record roots are relative to it, so a checkout reaches them through this. Unknown: no roots.
  let configuredDir: string, canonicalTop: string;
  try {
    // A main checkout may have a separate git dir; a normal .git directory still must agree above.
    const top = (await gitOut(rg, ["rev-parse", "--show-toplevel"])).replace(/\n$/, "");
    if (!isAbsolute(top)) return result;
    if (!candidates.some((c) => c.path === top)) candidates.push({ path: top, entry: null });
    canonicalTop = await realpath(top);
    if (!within(canonicalTop, repo)) return result;
    configuredDir = relative(canonicalTop, repo).split(sep).join("/");
  } catch { return result; }
  // Validating a checkout takes several spawns, and the author's repo has 55 worktrees. A worktree not on a branch this
  // reply asks about holds no target, so only those on one are validated, plus the configured checkout for its roots.
  const asked = new Set(result.branches.filter((b) => b.refFormatOk && names.includes(b.name)).map((b) => b.name));
  const mayHold = async (entry: string, checkoutDir: string): Promise<boolean> => {
    const on = /^ref: refs\/heads\/([^\n]+)\n?$/.exec(await metadata(join(entry, "HEAD")).catch(() => ""))?.[1];
    return (on !== undefined && asked.has(on)) || await realpath(checkoutDir).catch(() => null) === canonicalTop;
  };
  try {
    const dir = join(commonDir, "worktrees");
    const st = await lstat(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
    if (st !== null) {
      if (!st.isDirectory() || st.isSymbolicLink()) return result;
      let bytes = 0;
      for (const d of await readdir(dir, { withFileTypes: true })) {
        bytes += Buffer.byteLength(d.name);
        if (bytes > HGIT_MAX_BYTES || rg.budget.callTimeoutMs() === undefined) return result;
        if (!d.isDirectory() || d.isSymbolicLink()) continue;
        const entry = await realpath(join(dir, d.name));
        if (dirname(entry) !== await realpath(dir)) continue;
        try {
          const backlink = (await metadata(join(entry, "gitdir"))).replace(/\n$/, "");
          if (isAbsolute(backlink) && basename(backlink) === ".git" && await mayHold(entry, dirname(backlink))) candidates.push({ path: dirname(backlink), entry });
        } catch { /* forged/unreadable entry */ }
      }
    }
  } catch { return result; }
  const checked: { path: string; branch: string | null }[] = [];
  for (const c of candidates) {
    const valid = await checkout(rg, commonDir, c.path, c.entry);
    if (valid !== null && !checked.some((v) => v.path === valid.path)) checked.push(valid);
  }
  for (const branch of result.branches) {
    const matches = checked.filter((c) => c.branch === branch.name);
    if (names.includes(branch.name) && branch.refFormatOk && matches.length === 1) branch.checkoutPath = matches[0]!.path;
  }
  const listed: NonNullable<RepoFacts["roots"]> = [];
  const add = async (root: string): Promise<void> => {
    if (root !== "" && !safeFactName(root)) return;
    if (isAbsolute(root) || root.includes("\\") || (root !== "" && root.split("/").some((p) => p === "" || p === "." || p === ".."))) return;
    const fromTop = [configuredDir, root].filter((p) => p !== "").join("/");
    if (fromTop !== "" && !safeFactName(fromTop)) return;
    // `root` is what a target joins onto a checkout; a project's identity stays the record's own repo and root.
    const { keys, displayLabel } = roots.get(root) ?? { keys: new Set<string>(), displayLabel: null };
    if (await concrete(checked, fromTop, configuredDir)) listed.push({ root: fromTop, project: projectKey(repo, root), labelKeys: [...keys].sort(byteCmp), displayLabel });
  };
  for (const root of [...roots.keys()].sort(byteCmp)) await add(root);
  // Checked, and no label names a folder that is here: no accepted record, none of today's work was here, or the labels' only
  // folders have gone. Its own folder is still a project, with no card's name or key.
  if (listed.length === 0) await add("");
  result.roots = listed;
  return result;
}

/** A directory in some validated checkout, and leaving the configured folder in none. Rust joins a root onto the branch's own
 *  checkout, which may be any of these, so one checkout's real folder says nothing about another's link. A checkout with no
 *  such folder takes nothing away: the branch there may simply predate it. */
async function concrete(checked: readonly { path: string }[], fromTop: string, configuredDir: string): Promise<boolean> {
  let found = false;
  for (const c of checked) {
    try {
      const folder = await realpath(join(c.path, fromTop));
      // Inside the configured folder, not just the checkout: a link can lead from one to elsewhere in the other.
      if (!within(await realpath(join(c.path, configuredDir)), folder) || !within(c.path, folder) || !safeFactName(folder)) return false;
      if ((await stat(folder)).isDirectory()) found = true;
    } catch { /* this checkout has no such folder */ }
  }
  return found;
}
