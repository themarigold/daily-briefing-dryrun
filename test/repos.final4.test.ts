import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// test/repos.final4.test.ts — B1 final review round 4 (engine half): the path-free store and tree keys, the
// main worktree preferred for an unrecorded card, the default branch counted once in M, the live path's C
// locales, and the sweep of squash-check temp dirs a killed check left behind. Scratch repos only.
import { test, expect, spyOn } from "bun:test";
import { existsSync, lstatSync, lutimesSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as G from "../src/git";
import type { GitBudget } from "../src/git";
import { reposStatus, repoKeyFor, type StatusDeps } from "../src/repos/status";
import { SQUASH_STALE_MS, sweepStaleSquashDirs } from "../src/repos/squash";
import type { ReposEngineReply, ReposRequest } from "../src/repos/types";
import { g, isolatedGit, newRepo, withGit, commitAt, scratch } from "./fixtures/repos-fixtures";

const PAGE_DATE = "2026-01-12";
const at = (d: number, h = 10) => `2026-01-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`;
const t7 = (sha: string) => sha.slice(0, 7);
const req = (o: Partial<ReposRequest> = {}): ReposRequest => ({ scope: "all", pageDate: PAGE_DATE, labels: [], branches: [], ...o });
const recorded = (repos: string[]): StatusDeps["readRecord"] => async () => ({
  accepted: true,
  record: { schemaVersion: 1, date: PAGE_DATE, repos, windowStartUtc: "2026-01-01T00:00:00.000Z", labels: {}, commits: [], missing: [] },
});
async function status(env: Record<string, string>, request: ReposRequest, deps: StatusDeps = {}) {
  const { result } = await withGit(env, () => reposStatus(request, {
    tmpRoot: scratch("squash"), readRecord: async () => ({ accepted: false }), loadConfig: async () => ({}), now: () => new Date(at(13)), ...deps,
  }));
  return result as ReposEngineReply;
}

/** A repo on main pushed to a bare origin, then `feat` with two commits never pushed. */
async function pushedRepo(env: Record<string, string>) {
  const repo = await newRepo();
  const bare = join(scratch("remote"), "o.git");
  await g(scratch("cwd"), ["init", "-q", "--bare", bare], env);
  await g(repo, ["remote", "add", "origin", bare], env);
  await g(repo, ["push", "-q", "-u", "origin", "main"], env);
  await g(repo, ["checkout", "-q", "-b", "feat"], env);
  const f1 = await commitAt(repo, env, { "f1.txt": "1\n" }, "f1", at(12, 11));
  const f2 = await commitAt(repo, env, { "f2.txt": "1\n" }, "f2", at(12, 12));
  await g(repo, ["checkout", "-q", "main"], env);
  return { repo, f1, f2 };
}

test("final4 M1/L2 store and tree keys: one store for every checkout, one tree for a repo and its subdirectory, hashes only", async () => {
  const { env } = isolatedGit();
  const a = await pushedRepo(env);
  const wt = join(scratch("linked"), "wt");
  await g(a.repo, ["worktree", "add", "-q", "--detach", wt, "main"], env);
  const sub = join(a.repo, "sub"); mkdirSync(sub);
  const paths = [a.repo, sub, wt];
  const r = await status(env, req({ labels: [{ key: "app", tokens: [t7(a.f1), t7(a.f2)] }] }), { readRecord: recorded(paths) });
  const view = (p: string) => {
    const v = r.repoViews.find((x) => x.key === repoKeyFor(p));
    if (v === undefined || v.state !== "ok") throw new Error(`no ok view for ${p}`);
    return v;
  };
  const [vr, vs, vw] = [view(a.repo), view(sub), view(wt)];
  for (const v of [vr, vs, vw]) {
    expect(v.storeKey).toMatch(/^s[0-9a-f]{12}$/);
    expect(v.treeKey).toMatch(/^t[0-9a-f]{12}$/);
  }
  expect(new Set([vr.storeKey, vs.storeKey, vw.storeKey]).size).toBe(1);
  expect(vs.treeKey).toBe(vr.treeKey);                  // the subdirectory is the repo's own working tree
  expect(vw.treeKey).not.toBe(vr.treeKey);              // a linked worktree is a tree of its own
  expect(r.pushCards).toHaveLength(1);
  expect(r.pushCards[0]!.storeKey).toBe(vr.storeKey);
  // The engine-only stat list and B2's private actionFacts (both stripped by Rust before IPC, B2 spec :23)
  // still carry the paths; nothing else in the reply does.
  const { repos: stat, actionFacts: _facts, ...shown } = r;
  expect(stat.length).toBe(3);
  const text = JSON.stringify(shown);
  for (const p of [a.repo, wt, realpathSync(a.repo), realpathSync(wt), ...stat.flatMap((x) => [x.gitDir, x.commonDir])]) expect(text).not.toContain(p);
});

test("final4 L3 without a record, a card resolved in a shared store takes the store's main worktree, not the first configured checkout", async () => {
  const { env } = isolatedGit();
  const a = await pushedRepo(env);
  const wt = join(scratch("linked"), "wt");
  await g(a.repo, ["worktree", "add", "-q", "--detach", wt, "main"], env);
  writeFileSync(join(a.repo, "dirty.txt"), "x\n");                 // only the main tree is dirty
  const r = await status(env, req({ labels: [{ key: "app", tokens: [t7(a.f1), t7(a.f2)] }] }), { loadConfig: async () => ({ repos: [wt, a.repo] }) });
  expect(r.labels[0]!.notMatched).toBe(0);
  expect(r.labels[0]!.repoKey).toBe(repoKeyFor(a.repo));
  const v = r.repoViews.find((x) => x.key === r.labels[0]!.repoKey)!;
  expect(v.uncommitted).toEqual({ count: 1 });
  // the configured order is kept when no checkout is the main worktree's
  const wt2 = join(scratch("linked2"), "wt2");
  await g(a.repo, ["worktree", "add", "-q", "--detach", wt2, "main"], env);
  const r2 = await status(env, req({ labels: [{ key: "app", tokens: [t7(a.f1)] }] }), { loadConfig: async () => ({ repos: [wt2, wt] }) });
  expect(r2.labels[0]!.repoKey).toBe(repoKeyFor(wt2));
});

test("final4 L4 local main and master both holding unpushed work count as ONE default branch in M, as the push card shows them", async () => {
  const { env } = isolatedGit();
  const repo = await newRepo();
  const bare = join(scratch("remote"), "o.git");
  await g(scratch("cwd"), ["init", "-q", "--bare", bare], env);
  await g(repo, ["remote", "add", "origin", bare], env);
  await g(repo, ["push", "-q", "-u", "origin", "main"], env);
  await g(repo, ["branch", "master"], env);
  await commitAt(repo, env, { "m.txt": "m\n" }, "on main", at(12, 11));
  await g(repo, ["checkout", "-q", "master"], env);
  await commitAt(repo, env, { "k.txt": "k\n" }, "on master", at(12, 12));
  await g(repo, ["checkout", "-q", "main"], env);
  const r = await status(env, req(), { readRecord: recorded([repo]) });
  expect(r.repoViews[0]!.state).toBe("ok");
  expect(r.pushCards).toHaveLength(1);
  const c = r.pushCards[0]!;
  const cardBranches = c.branches.length + (c.onDefault !== null ? 1 : 0);
  const cardCommits = c.branches.reduce((n, b) => n + b.commits, 0) + (c.onDefault?.commits ?? 0);
  expect(r.tile).toEqual({ commits: 2, branches: 1 });
  expect({ commits: cardCommits, branches: cardBranches }).toEqual(r.tile);
});

test("final4 L5 the live path's shared git calls run with C locales; the morning's calls are unchanged", async () => {
  const repo = await newRepo({ "a.txt": "a\n", "b.txt": "b\n" });
  const { env } = isolatedGit();
  const [p1, p2] = (await g(repo, ["rev-list", "HEAD"], env)).trim().split("\n").reverse() as [string, string];
  const merge = { sha: p2, parents: [p1, p2], timestamp: at(11), subject: "x" };
  const budget = (): GitBudget => ({ remainingMs: () => 60_000, callTimeoutMs: () => 20_000 });
  const realSpawn = Bun.spawn;
  const seen: { argv: string[]; env: Record<string, string | undefined> | undefined }[] = [];
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: Parameters<typeof Bun.spawn>[0], opts: Parameters<typeof Bun.spawn>[1]) => {
    const argv = cmd as string[];
    if (argv[0] === "git" && argv[1] !== "--version") seen.push({ argv, env: (opts as { env?: Record<string, string> } | undefined)?.env });
    return realSpawn(cmd as any, opts as any);
  }) as typeof Bun.spawn);
  let live: typeof seen, morning: typeof seen;
  try {
    await G.listDefaultRefMerges(repo, new Date(at(1)), new Date(at(13)), budget(), { lead: [] });
    await G.mergeMembers(repo, [merge], budget(), { lead: [] });
    live = seen.splice(0);
    await G.listDefaultRefMerges(repo, new Date(at(1)), new Date(at(13)), budget());
    await G.mergeMembers(repo, [merge], budget());
    morning = seen.splice(0);
  } finally { spy.mockRestore(); }
  expect(live.map((c) => c.argv[1])).toEqual(["symbolic-ref", "for-each-ref", "log", "rev-list"]);
  for (const c of live) expect([c.env?.LC_ALL, c.env?.LANGUAGE, Object.keys(c.env ?? {}).filter((k) => k.startsWith("GIT_"))]).toEqual(["C", "C", []]);
  expect(morning.map((c) => c.argv[1])).toEqual(["symbolic-ref", "for-each-ref", "log", "rev-list"]);
  for (const c of morning) expect(c.env).toBeUndefined();
});

test("final4 L6 a check sweeps squash dirs a killed check left behind: only stale real directories named as this code names them", async () => {
  const root = scratch("sweep-root");
  const old = new Date(Date.now() - 60 * 60_000);
  const mk = (name: string, stale = true) => {
    const p = join(root, name);
    mkdirSync(p);
    writeFileSync(join(p, "spool.diff"), "x");
    if (stale) utimesSync(p, old, old);
    return p;
  };
  const staleDir = mk("dba-squash-Ab12Cd");
  const fresh = mk("dba-squash-Ef34Gh", false);
  const otherPrefix = mk("dba-squashed-Ab12Cd");
  const longer = mk("dba-squash-Ab12Cd-keep");
  const fileOne = join(root, "dba-squash-Ij56Kl");
  writeFileSync(fileOne, "a file, not a dir");
  utimesSync(fileOne, old, old);
  const outside = join(scratch("sweep-outside"), "target");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "keep");
  const link = join(root, "dba-squash-Mn78Op");
  symlinkSync(outside, link);
  // final5 L5: the link AND its target are stale, so only the never-follow rule (`lstat`) spares them; a fresh
  // pair would be skipped as too new whatever the sweep follows.
  utimesSync(outside, old, old);
  lutimesSync(link, old, old);
  expect([lstatSync(outside).mtimeMs, lstatSync(link).mtimeMs].every((m) => Date.now() - m > SQUASH_STALE_MS)).toBe(true); // PREMISE
  const removed = await sweepStaleSquashDirs(root);
  expect(removed).toBe(1);
  expect(existsSync(staleDir)).toBe(false);
  for (const kept of [fresh, otherPrefix, longer, fileOne]) expect(existsSync(kept)).toBe(true);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(lstatSync(outside).isDirectory()).toBe(true);
  expect(readdirSync(outside)).toEqual(["keep.txt"]);
  expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
  // A missing root is no error.
  expect(await sweepStaleSquashDirs(join(root, "missing"))).toBe(0);
  // And a real check sweeps its own tmp root before it starts.
  const { env } = isolatedGit();
  const repo = await newRepo();
  const tmpRoot = scratch("sweep-check");
  mkdirSync(join(tmpRoot, "dba-squash-Qr90St"));
  utimesSync(join(tmpRoot, "dba-squash-Qr90St"), old, old);
  await status(env, req(), { readRecord: recorded([repo]), tmpRoot });
  expect(existsSync(join(tmpRoot, "dba-squash-Qr90St"))).toBe(false);
});
