// test/repos.push.test.ts — B1-M2-T7 (wave-2 plan): push state, the one population, the branch line's
// live words (B1 spec "Pushed", "Which branches count", "What N and M count"). Scratch repos built per test
// under a per-test global config; every remote is a local bare repo in the test's temp tree.
import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { startGitBudget } from "../src/git";
import { hardenArgs } from "../src/repos/harden";
import type { RepoGit } from "../src/repos/hgit";
import { openScan, groupLabel, type RepoScan } from "../src/repos/groups";
import { pushFacts, parseHeads, repoPush, rowPush, branchLine, pushCards, type RepoPush } from "../src/repos/push";
import { g, isolatedGit, newRepo, withGit, commitAt, armHostile, signCommits, runControls, scratch } from "./fixtures/repos-fixtures";

const LAZY = { lazyFetch: true };
const WINDOW = new Date("2026-01-01T00:00:00Z");
const day = (d: number) => `2026-01-${String(d).padStart(2, "0")}T10:00:00Z`;
const CRED = "ghp_AbCdEfGhIjKlMnOpQrStUv123456";
async function scanFor(repo: string): Promise<RepoScan> {
  const budget = startGitBudget(60_000);
  const h = await hardenArgs(repo, budget, LAZY);
  if ("unknown" in h) throw new Error(`unknown: ${h.unknown}`);
  const rg: RepoGit = { repo, lead: h.lead, budget };
  return openScan(rg, WINDOW, new Date());
}
/** A repo on main (one commit, dated before the window) with a bare `origin` that holds main. */
async function withOrigin(env: Record<string, string>, opts: { push?: boolean } = {}) {
  const repo = await newRepo();
  const bare = join(scratch("remote"), "o.git");
  await g(scratch("cwd"), ["init", "-q", "--bare", bare], env);
  await g(repo, ["remote", "add", "origin", bare], env);
  if (opts.push !== false) await g(repo, ["push", "-q", "-u", "origin", "main"], env);
  return { repo, bare };
}
async function pushOf(env: Record<string, string>, repo: string, opts: { merged?: Set<string>; pageShas?: Set<string> | null } = {}) {
  return withGit(env, async () => {
    const scan = await scanFor(repo);
    const facts = await pushFacts(scan);
    return { facts, push: await repoPush(scan, facts, { merged: opts.merged ?? new Set(), pageShas: opts.pageShas ?? null }) };
  });
}
const byName = (p: RepoPush, name: string) => (p.noRemote ? undefined : p.branches.find((b) => b.name === name));

describe("the for-each-ref parse, on real output", () => {
  test("%1f separates refname, upstream and objectname (not %x1f, which for-each-ref prints literally)", async () => {
    const { env } = isolatedGit();
    const { repo } = await withOrigin(env);
    await g(repo, ["branch", "side"], env);
    const out = await g(repo, ["for-each-ref", "--format=%(refname)%1f%(upstream)%1f%(objectname)", "refs/heads/"], env);
    expect(out).toContain("\x1f");
    const tip = (await g(repo, ["rev-parse", "HEAD"], env)).trim();
    expect(parseHeads(out)).toEqual([
      { ref: "refs/heads/main", upstream: "refs/remotes/origin/main", tip },
      { ref: "refs/heads/side", upstream: "", tip },
    ]);
    const literal = await g(repo, ["for-each-ref", "--format=%(refname)%x1f%(upstream)", "refs/heads/"], env);
    expect(literal).toContain("%x1f");                                // why the format is %1f
  });
});

describe("push state", () => {
  test("origin configured but never pushed is amber (never pushed), beside a repo with no remote (no push state)", async () => {
    const { env } = isolatedGit();
    const { repo } = await withOrigin(env, { push: false });
    await g(repo, ["checkout", "-q", "-b", "fresh"], env);
    const f1 = await commitAt(repo, env, { "f.txt": "1\n" }, "f1", day(5));
    const { result } = await pushOf(env, repo);
    expect(result.push.noRemote).toBe(false);
    expect(byName(result.push, "fresh")).toMatchObject({ state: "never", neverPushed: true, population: [f1] });
    const base = (await g(repo, ["rev-parse", "main"], env)).trim();
    expect(byName(result.push, "main")).toMatchObject({ isDefault: true, state: "never", neverPushed: true, population: [base] });
    expect(result.push.noRemote === false && result.push.tile).toEqual({ commits: 2, branches: 2 });
    const lone = await newRepo();
    await commitAt(lone, env, { "l.txt": "1\n" }, "l1", day(5));
    const none = await pushOf(env, lone);
    expect(none.result.facts.noRemote).toBe(true);
    expect(none.result.push).toEqual({ noRemote: true });
  });

  test("unmerged and pushed; partly pushed; a push without -u; an upstream that is gone (never \"never pushed\")", async () => {
    const { env } = isolatedGit();
    const { repo } = await withOrigin(env);
    // unmerged, pushed with -u
    await g(repo, ["checkout", "-q", "-b", "pushed", "main"], env);
    await commitAt(repo, env, { "p.txt": "1\n" }, "p1", day(5));
    await g(repo, ["push", "-q", "-u", "origin", "pushed"], env);
    // partly pushed: two more after the push
    await g(repo, ["checkout", "-q", "-b", "partly", "main"], env);
    await commitAt(repo, env, { "q.txt": "1\n" }, "q1", day(5));
    await g(repo, ["push", "-q", "-u", "origin", "partly"], env);
    const q2 = await commitAt(repo, env, { "q.txt": "2\n" }, "q2", day(6));
    const q3 = await commitAt(repo, env, { "q.txt": "3\n" }, "q3", day(7));
    // a push without -u: no upstream, but a remote ref reaches it
    await g(repo, ["checkout", "-q", "-b", "nou", "main"], env);
    await commitAt(repo, env, { "n.txt": "1\n" }, "n1", day(5));
    await g(repo, ["push", "-q", "origin", "nou"], env);
    // upstream gone: pushed with -u, then the tracking ref pruned, then one more commit
    await g(repo, ["checkout", "-q", "-b", "gone", "main"], env);
    const x1 = await commitAt(repo, env, { "x.txt": "1\n" }, "x1", day(5));
    await g(repo, ["push", "-q", "-u", "origin", "gone"], env);
    await g(repo, ["update-ref", "-d", "refs/remotes/origin/gone"], env);
    const x2 = await commitAt(repo, env, { "x.txt": "2\n" }, "x2", day(6));
    const { result } = await pushOf(env, repo);
    expect(byName(result.push, "pushed")).toMatchObject({ state: "pushed", neverPushed: false, population: [] });
    expect(byName(result.push, "partly")).toMatchObject({ state: "partly", neverPushed: false, population: [q3, q2] });
    expect(byName(result.push, "nou")).toMatchObject({ state: "pushed", neverPushed: false, population: [] });
    expect(byName(result.push, "gone")).toMatchObject({ state: "partly", neverPushed: false, population: [x2, x1] });
    expect(result.push.noRemote === false && result.push.tile).toEqual({ commits: 4, branches: 2 });
  });
});

describe("the one population", () => {
  test("a row's N not pushed, the tile and the push card count the same commits; a row's N can exceed its commit count", async () => {
    const { env } = isolatedGit();
    const { repo } = await withOrigin(env);
    await g(repo, ["checkout", "-q", "-b", "spike", "main"], env);
    const s1 = await commitAt(repo, env, { "s.txt": "1\n" }, "s1", day(5));
    const s2 = await commitAt(repo, env, { "s.txt": "2\n" }, "s2", day(6));
    const s3 = await commitAt(repo, env, { "s.txt": "3\n" }, "s3", day(7));
    await g(repo, ["checkout", "-q", "main"], env);
    const m1 = await commitAt(repo, env, { "m.txt": "1\n" }, "m1", day(8));
    const { result } = await withGit(env, async () => {
      const scan = await scanFor(repo);
      const facts = await pushFacts(scan);
      const push = await repoPush(scan, facts, { merged: new Set(), pageShas: null });
      const rows = await groupLabel(scan, [{ sha: s2, token: s2.slice(0, 7) }, { sha: m1, token: m1.slice(0, 7) }]);
      return { push, rows, card: pushCards([{ repoKey: "r1", storeKey: "s", repoName: "proj", path: repo, firstLabel: "Proj", firstLabelIndex: 0, push }]) };
    });
    const spikeRow = result.rows.find((r) => r.kind === "branch")!;
    expect(spikeRow.commits.length).toBe(1);
    expect(rowPush(spikeRow, result.push)).toEqual({ state: "never", notPushed: 3 });   // 3 > the row's 1 commit
    expect(rowPush(result.rows.find((r) => r.kind === "default")!, result.push)).toEqual({ state: "partly", notPushed: 1 });
    expect(result.push.noRemote === false && result.push.tile).toEqual({ commits: 4, branches: 2 });
    expect(result.card).toEqual([{ repoKey: "r1", storeKey: "s", firstLabel: "Proj", repoName: "proj", branches: [{ name: "spike", commits: 3 }], onDefault: { name: "main", commits: 1 } }]);
    void s1; void s3;
  });

  test("tag-group and orphan commits are in no count; a merged (squash-matched) branch never counts; a commit before the window start does not count", async () => {
    const { env } = isolatedGit();
    const { repo } = await withOrigin(env);
    await g(repo, ["checkout", "-q", "--detach", "main"], env);
    const t1 = await commitAt(repo, env, { "t.txt": "1\n" }, "t1", day(5));
    await g(repo, ["tag", "v1", t1], env);
    await commitAt(repo, env, { "o.txt": "1\n" }, "orphan", day(6));
    await g(repo, ["checkout", "-q", "-b", "merged", "main"], env);
    await commitAt(repo, env, { "m.txt": "1\n" }, "m1", day(5));
    await g(repo, ["checkout", "-q", "-b", "old", "main"], env);
    await commitAt(repo, env, { "old.txt": "1\n" }, "old", "2025-12-01T10:00:00Z");
    await g(repo, ["checkout", "-q", "main"], env);
    const { result } = await pushOf(env, repo, { merged: new Set(["refs/heads/merged"]) });
    expect(result.push.noRemote === false && result.push.tile).toEqual({ commits: 0, branches: 0 });
    expect(byName(result.push, "old")).toMatchObject({ state: "never", population: [] });
    expect(result.push.noRemote === false && result.push.counted.map((b) => b.name)).toEqual([]);
  });

  test("without a run record only branches holding page commits count", async () => {
    const { env } = isolatedGit();
    const { repo } = await withOrigin(env);
    await g(repo, ["checkout", "-q", "-b", "cited", "main"], env);
    const c1 = await commitAt(repo, env, { "c.txt": "1\n" }, "c1", day(5));
    await g(repo, ["checkout", "-q", "-b", "uncited", "main"], env);
    await commitAt(repo, env, { "u.txt": "1\n" }, "u1", day(5));
    await g(repo, ["checkout", "-q", "main"], env);
    const withRecord = await pushOf(env, repo, { pageShas: null });
    expect(withRecord.result.push.noRemote === false && withRecord.result.push.tile).toEqual({ commits: 2, branches: 2 });
    const noRecord = await pushOf(env, repo, { pageShas: new Set([c1]) });
    expect(noRecord.result.push.noRemote === false && noRecord.result.push.tile).toEqual({ commits: 1, branches: 1 });
    expect(noRecord.result.push.noRemote === false && noRecord.result.push.counted.map((b) => b.name)).toEqual(["cited"]);
  });

  test("a credential-shaped branch reads [redacted] in the push state, the tile's data and the push card", async () => {
    const { env } = isolatedGit();
    const { repo } = await withOrigin(env);
    await g(repo, ["checkout", "-q", "-b", CRED, "main"], env);
    await commitAt(repo, env, { "c.txt": "1\n" }, "c1", day(5));
    const { result } = await pushOf(env, repo);
    const cards = pushCards([{ repoKey: "r1", storeKey: "s", repoName: "proj", path: repo, firstLabel: null, firstLabelIndex: null, push: result.push }]);
    expect(cards[0]!.branches).toEqual([{ name: "[redacted]", commits: 1 }]);
    const shown = result.push.noRemote ? [] : result.push.branches.map((b) => ({ ...b, ref: undefined }));
    expect(JSON.stringify([shown, cards, result.push.noRemote === false && result.push.tile])).not.toContain("ghp_");
  });
});

describe("push cards (pure)", () => {
  const push = (n: number): RepoPush => ({
    noRemote: false, tile: { commits: n, branches: 1 }, branches: [], merged: new Set(), counted: [{ ref: "refs/heads/x", name: "x", isDefault: false, neverPushed: true, state: "never", population: Array.from({ length: n }, (_, i) => String(i).repeat(40)) }],
  });
  test("one per repo with commits, by the repo's first label in card order, then repos with no page label by path", () => {
    const cards = pushCards([
      { repoKey: "rz", storeKey: "s", repoName: "z", path: "/z", firstLabel: null, firstLabelIndex: null, push: push(1) },
      { repoKey: "rb", storeKey: "s", repoName: "b", path: "/b", firstLabel: "B", firstLabelIndex: 2, push: push(1) },
      { repoKey: "ra", storeKey: "s", repoName: "a", path: "/a", firstLabel: null, firstLabelIndex: null, push: push(1) },
      { repoKey: "rc", storeKey: "s", repoName: "c", path: "/c", firstLabel: "C", firstLabelIndex: 0, push: push(2) },
      { repoKey: "r0", storeKey: "s", repoName: "zero", path: "/0", firstLabel: "Z", firstLabelIndex: 1, push: push(0) },
      { repoKey: "rn", storeKey: "s", repoName: "none", path: "/n", firstLabel: "N", firstLabelIndex: 3, push: { noRemote: true } },
    ]);
    expect(cards.map((c) => c.repoKey)).toEqual(["rc", "rb", "ra", "rz"]);
    expect(cards[0]).toEqual({ repoKey: "rc", storeKey: "s", firstLabel: "C", repoName: "c", branches: [{ name: "x", commits: 2 }], onDefault: null });
  });
});

describe("the branch line's live words", () => {
  test("a live branch (not pushed, never pushed, behind), a missing one, a [redacted] name, and a no-remote repo's branch", async () => {
    const { env } = isolatedGit();
    const { repo, bare } = await withOrigin(env);
    await g(repo, ["checkout", "-q", "-b", "work", "main"], env);
    await commitAt(repo, env, { "w.txt": "1\n" }, "w1", day(5));
    await g(repo, ["push", "-q", "-u", "origin", "work"], env);
    await commitAt(repo, env, { "w.txt": "2\n" }, "w2", day(6));
    // the upstream moves on in another clone; a fetch brings it here: behind 1, from local data only
    const other = join(scratch("other"), "o");
    await g(scratch("cwd"), ["clone", "-q", "-b", "work", bare, other], env);
    await g(other, ["config", "user.name", "T"], env);
    await g(other, ["config", "user.email", "t@x"], env);
    await commitAt(other, env, { "r.txt": "1\n" }, "remote ahead", day(7));
    await g(other, ["push", "-q", "origin", "work"], env);
    await g(repo, ["fetch", "-q", "origin"], env);
    await g(repo, ["checkout", "-q", "-b", "fresh", "main"], env);
    await commitAt(repo, env, { "f.txt": "1\n" }, "f1", day(5));
    const { result, calls } = await withGit(env, async () => {
      const scan = await scanFor(repo);
      const facts = await pushFacts(scan);
      const push = await repoPush(scan, facts, { merged: new Set(), pageShas: null });
      return Promise.all([
        branchLine(scan, facts, push, { key: "proj", name: "work" }),
        branchLine(scan, facts, push, { key: "proj", name: "fresh" }),
        branchLine(scan, facts, push, { key: "proj", name: "deleted" }),
        branchLine(scan, facts, push, { key: "proj", name: "[redacted]" }),
      ]);
    });
    expect(result).toEqual([
      { key: "proj", name: "work", state: "live", notPushed: 1, neverPushed: false, behind: 1 },
      { key: "proj", name: "fresh", state: "live", notPushed: 1, neverPushed: true, behind: 0 },
      { key: "proj", name: "deleted", state: "missing" },
      { key: "proj", name: "[redacted]", state: "missing" },
    ]);
    expect(calls.flat()).not.toContain("fetch");
    expect(calls.flat().some((a) => a === "work" || a === "deleted" || a === "fresh")).toBe(false);   // the page's names never reach an argv
    const lone = await newRepo();
    const noRemote = await withGit(env, async () => {
      const scan = await scanFor(lone);
      const facts = await pushFacts(scan);
      return branchLine(scan, facts, await repoPush(scan, facts, { merged: new Set(), pageShas: null }), { key: "l", name: "main" });
    });
    expect(noRemote.result).toEqual({ key: "l", name: "main", state: "noRemote" });
  });
});

describe("argv safety and a hostile repo", () => {
  test("a branch named refs/heads/-n: counted, and every revision is a full ref after --end-of-options", async () => {
    const { env } = isolatedGit();
    const { repo } = await withOrigin(env);
    await g(repo, ["checkout", "-q", "-b", "tmp", "main"], env);
    const n1 = await commitAt(repo, env, { "n.txt": "1\n" }, "n1", day(5));
    await g(repo, ["update-ref", "refs/heads/-n", n1], env);
    await g(repo, ["checkout", "-q", "main"], env);
    await g(repo, ["branch", "-D", "tmp"], env);
    const { result, calls } = await pushOf(env, repo);
    expect(byName(result.push, "-n")).toMatchObject({ state: "never", population: [n1] });
    expect(calls.flat()).not.toContain("-n");
    for (const a of calls.filter((x) => x.includes("rev-list") && x.includes("--end-of-options"))) {
      expect(a.slice(a.indexOf("--end-of-options") + 1).every((x) => /^\^?refs\//.test(x))).toBe(true);
    }
  });

  test("remote, for-each-ref, the counts, the windowed listing and behind run none of the armed programs; the controls run them", async () => {
    const { env } = isolatedGit();
    const dir = scratch("hostile");
    const { repo } = await withOrigin(env);
    await signCommits(repo, env, dir);
    await g(repo, ["checkout", "-q", "-b", "w", "main"], env);
    const w1 = await commitAt(repo, env, { "f.txt": "w1\n" }, "w1", day(5));
    await g(repo, ["push", "-q", "-u", "origin", "w"], env);
    const w2 = await commitAt(repo, env, { "f.txt": "w2\n" }, "w2", day(6));
    await g(repo, ["checkout", "-q", "-b", "y", "main"], env);
    const y1 = await commitAt(repo, env, { "f.txt": "y1\n" }, "y1", day(6));
    const hostile = await armHostile(repo, env, dir);
    const { result } = await withGit(env, async () => {
      const scan = await scanFor(repo);
      const facts = await pushFacts(scan);
      const push = await repoPush(scan, facts, { merged: new Set(), pageShas: null });
      return { push, line: await branchLine(scan, facts, push, { key: "k", name: "w" }) };
    });
    expect(result.push.noRemote === false && result.push.tile).toEqual({ commits: 2, branches: 2 });
    expect(result.line).toEqual({ key: "k", name: "w", state: "live", notPushed: 1, neverPushed: false, behind: 0 });
    expect(hostile.ran()).toEqual([]);
    await runControls(repo, env, { diff: [w1, w2], signed: w2, merge: [w2, y1] });
    expect(hostile.ran()).toEqual(expect.arrayContaining(["gpg", "diff-command", "merge-driver"]));
  });
});



describe("B1-M2 checkpoint regressions", () => {
  test("an empty remote clone has a configured upstream but main is not pushed", async () => {
    const { env } = isolatedGit();
    const root = scratch("empty-clone");
    const bare = join(root, "o.git");
    await g(root, ["init", "-q", "--bare", "-b", "main", bare], env);
    await g(root, ["clone", "-q", bare, "work"], env);
    const repo = join(root, "work");
    await g(repo, ["config", "user.name", "T"], env);
    await g(repo, ["config", "user.email", "t@x"], env);
    const c = await commitAt(repo, env, { "a.txt": "a" }, "first", day(12));
    const { result } = await pushOf(env, repo);
    expect(result.facts.noRemote).toBe(false);
    expect(result.facts.remoteRefs).toEqual([]);
    expect(result.facts.heads[0]!.upstream).toBe("refs/remotes/origin/main");
    expect(byName(result.push, "main")).toMatchObject({ isDefault: true, neverPushed: true, state: "never", population: [c] });
    expect(rowPush({ kind: "default", name: "main", commits: [] }, result.push)).toEqual({ state: "never", notPushed: 1 });
  });

  test("stacked card counts assign each population commit once to its nearest tip; tile deduplicates overlapping populations", async () => {
    const { env } = isolatedGit();
    const { repo } = await withOrigin(env);
    await g(repo, ["checkout", "-q", "-b", "a"], env);
    const a1 = await commitAt(repo, env, { "a.txt": "1" }, "a1", day(12));
    const a2 = await commitAt(repo, env, { "a.txt": "2" }, "a2", day(13));
    await g(repo, ["checkout", "-q", "-b", "b"], env);
    const b1 = await commitAt(repo, env, { "b.txt": "1" }, "b1", day(14));
    const { result } = await pushOf(env, repo);
    if (result.push.noRemote) throw new Error("expected push state");
    // Both populations intentionally overlap: this also kills sum(population.length) for the tile.
    expect(byName(result.push, "a")!.population).toEqual([a2, a1]);
    expect(byName(result.push, "b")!.population).toEqual([b1, a2, a1]);
    expect(result.push.tile).toEqual({ commits: 3, branches: 2 });
    const card = pushCards([{ repoKey: "r", storeKey: "s", repoName: "r", path: repo, firstLabel: null, firstLabelIndex: null, push: result.push }])[0]!;
    expect(card.branches).toEqual([{ name: "a", commits: 2 }, { name: "b", commits: 1 }]);
    expect(card.branches.reduce((n, b) => n + b.commits, card.onDefault?.commits ?? 0)).toBe(result.push.tile.commits);
  });

  test("remote exclusion chunks intersect to the same answer as one unchunked query", async () => {
    const { env } = isolatedGit();
    const { repo } = await withOrigin(env);
    await g(repo, ["checkout", "-q", "-b", "work"], env);
    const a = await commitAt(repo, env, { "a.txt": "1" }, "a", day(12));
    const b = await commitAt(repo, env, { "a.txt": "2" }, "b", day(13));
    const c = await commitAt(repo, env, { "a.txt": "3" }, "c", day(14));
    await g(repo, ["update-ref", "refs/remotes/origin/a", a], env);
    await g(repo, ["update-ref", "refs/remotes/origin/b", b], env);
    const { result, calls } = await withGit(env, async () => {
      const fullScan = await scanFor(repo);
      const facts = await pushFacts(fullScan);
      const full = await repoPush(fullScan, facts, { merged: new Set(), pageShas: null });
      const chunked = await repoPush(await scanFor(repo), facts, { merged: new Set(), pageShas: null, refsPerCall: 1 });
      return { full, chunked };
    });
    expect(result.chunked).toEqual(result.full);
    expect(byName(result.chunked, "work")).toMatchObject({ state: "partly", population: [c] });
    const queries = calls.filter((a) => a.includes("rev-list") && a.some((r) => r.startsWith("^refs/remotes/")));
    expect(queries.some((a) => a.filter((r) => r.startsWith("^refs/remotes/")).length === 3)).toBe(true);
    const chunkStart = calls.findLastIndex((a) => a.includes("--absolute-git-dir"));
    const chunkedQueries = calls.slice(chunkStart).filter((a) => a.includes("rev-list"));
    expect(chunkedQueries.length).toBeGreaterThan(3);
    expect(chunkedQueries.every((a) => {
      // work's own range also excludes origin/main as a default ref, independently of the chunk.
      const ownDefaultExclusions = a.includes("^refs/heads/main") ? 1 : 0;
      return a.filter((r) => r.startsWith("^refs/remotes/")).length <= ownDefaultExclusions + 1;
    })).toBe(true);
  });

  test("the population JS window rejects a commit inside the two-day listing slack (M25)", async () => {
    const { env } = isolatedGit();
    const { repo } = await withOrigin(env);
    await g(repo, ["checkout", "-q", "-b", "work"], env);
    const old = await commitAt(repo, env, { "a.txt": "old" }, "old", "2025-12-31T10:00:00Z");
    const boundary = await commitAt(repo, env, { "a.txt": "boundary" }, "boundary", "2026-01-01T00:00:00Z");
    const recent = await commitAt(repo, env, { "a.txt": "recent" }, "recent", day(2));
    const { result, calls } = await pushOf(env, repo);
    expect(byName(result.push, "work")!.population).toEqual([recent, boundary]);
    expect(byName(result.push, "work")!.population).not.toContain(old);
    expect(calls.flat().some((a) => a.startsWith("--since-as-filter=2025-12-30"))).toBe(true);
  });
});


test("card assignment uses byte-order ties and keeps shared unpushed ancestors of default refs", async () => {
  const { env } = isolatedGit();
  const { repo } = await withOrigin(env, { push: false });
  const base = (await g(repo, ["rev-parse", "main"], env)).trim();
  await commitAt(repo, env, { "m.txt": "main" }, "main", day(12));
  await g(repo, ["checkout", "-q", "-b", "master", base], env);
  await commitAt(repo, env, { "m.txt": "master" }, "master", day(13));
  const { result } = await pushOf(env, repo);
  if (result.push.noRemote) throw new Error("expected push state");
  // final4 L4: the two default refs are ONE default branch in M, as the card shows them (one onDefault).
  expect(result.push.tile).toEqual({ commits: 3, branches: 1 });
  expect(byName(result.push, "main")!.cardCommits).toBe(2);
  expect(byName(result.push, "master")!.cardCommits).toBe(1);
  const card = pushCards([{ repoKey: "r", storeKey: "s", repoName: "r", path: repo, firstLabel: null, firstLabelIndex: null, push: result.push }])[0]!;
  expect(card.onDefault).toEqual({ name: "main", commits: 3 });
});

test("final3 L3 same-tip branches both count in M and retain their aggregate contributions", async () => {
  const { env } = isolatedGit();
  const { repo } = await withOrigin(env);
  await g(repo, ["checkout", "-q", "-b", "feat"], env);
  await commitAt(repo, env, { "work.txt": "w" }, "work", day(12));
  await g(repo, ["branch", "feat-backup"], env);
  const { result } = await pushOf(env, repo);
  expect(result.push.noRemote).toBe(false);
  if (result.push.noRemote) throw new Error("remote missing");
  expect(result.push.tile).toEqual({ commits: 1, branches: 2 });
  expect(result.push.counted.map((b) => b.cardCommits)).toEqual([1, 0]);
  expect(pushCards([{ repoKey: "r", storeKey: "s", repoName: "app", path: repo, firstLabel: "app", firstLabelIndex: 0, push: result.push }])[0]!.branches).toEqual([{ name: "feat", commits: 1 }, { name: "feat-backup", commits: 0 }]);
});

test("final3 L7 default nearest walk excludes every remote ref and still assigns its population", async () => {
  const { env } = isolatedGit();
  const { repo } = await withOrigin(env);
  await g(repo, ["update-ref", "refs/remotes/backup/main", "main"], env);
  await commitAt(repo, env, { "local.txt": "local" }, "local", day(12));
  const { result, calls } = await pushOf(env, repo);
  expect(result.push.noRemote === false && result.push.tile).toEqual({ commits: 1, branches: 1 });
  expect(byName(result.push, "main")?.cardCommits).toBe(1);
  const walks = calls.filter((c) => c.includes("rev-list") && c.includes("--topo-order") && c.includes("refs/heads/main"));
  expect(walks).toHaveLength(1);
  expect(walks[0]).toContain("^refs/remotes/origin/main");
  expect(walks[0]).toContain("^refs/remotes/backup/main");
});
