// test/repos.squash.test.ts — B1-M2-T6 (wave-2 plan): the squash check (B1 spec "Pushed", the kept
// branch). Scratch repos built per test under a per-test global config (fixtures/repos-fixtures.ts).
import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startGitBudget } from "../src/git";
import { hardenArgs } from "../src/repos/harden";
import { RepoUnknown, type RepoGit } from "../src/repos/hgit";
import { openScan, groupLabel } from "../src/repos/groups";
import { pushFacts, branchPushes, countPush, branchLine } from "../src/repos/push";
import { squashMatch, squashMatches, SQUASH_CHECK_CAP, SPOOL_MAX_BYTES } from "../src/repos/squash";
import { g, gRaw, isolatedGit, newRepo, withGit, commitAt, armHostile, signCommits, runControls, markerScript, scratch, gitAtLeast } from "./fixtures/repos-fixtures";

// Every test here is dozens of real git spawns and asserts nothing about wall time, so bun's 5 s default was only a
// load test: "no temp object dir…" takes 4.8 s on an idle machine (it waits out two 3 s budgets), and others passed
// 5 s beside a second suite. A test that times out also keeps running, with the git spy still installed, and fails
// the next test on the spawn guard. Bun scopes this default to the file (measured, 1.3.14).
setDefaultTimeout(60_000);

const LAZY = { lazyFetch: true };
const WINDOW = new Date("2026-01-01T00:00:00Z");
const day = (d: number) => `2026-01-${String(d).padStart(2, "0")}T10:00:00Z`;
type Ctx = { rg: RepoGit; commonDir: string };
async function ctxFor(repo: string, ms = 60_000): Promise<Ctx> {
  const budget = startGitBudget(ms);
  const h = await hardenArgs(repo, budget, LAZY);
  if ("unknown" in h) throw new Error(`unknown: ${h.unknown}`);
  return { rg: { repo, lead: h.lead, budget }, commonDir: h.commonDir };
}
const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const text = (over: Record<number, string> = {}) => TEN.map((l, i) => over[i + 1] ?? l).join("\n") + "\n";
const objectCount = async (repo: string, env: Record<string, string>) => {
  const v = await g(repo, ["count-objects", "-v"], env);
  return Number(/^count: (\d+)/m.exec(v)![1]) + Number(/^in-pack: (\d+)/m.exec(v)![1]);
};

/** base (k.txt = TEN) on main; a kept branch `k` changing line 9 in two commits; main then lands the PRs
 *  `between` (each changing `between[i].file` at `between[i].line`), then the squash S of k, `(#9)`. */
async function keptSquash(env: Record<string, string>, opts: { between?: { line?: number; file?: string; subject: string }[]; editAfter?: boolean; dir?: string } = {}) {
  const repo = opts.dir ?? (await newRepo({ "k.txt": text() }));
  if (opts.dir) {
    await g(repo, ["init", "-q", "-b", "main"], env);
    await g(repo, ["config", "user.name", "T"], env);
    await g(repo, ["config", "user.email", "t@x"], env);
    await commitAt(repo, env, { "k.txt": text() }, "base", day(2));
  }
  await g(repo, ["checkout", "-q", "-b", "k"], env);
  const o1 = await commitAt(repo, env, { "k.txt": text({ 9: "branch half" }) }, "o1", day(3));
  const o2 = await commitAt(repo, env, { "k.txt": text({ 9: "branch done" }) }, "o2", day(4));
  await g(repo, ["checkout", "-q", "main"], env);
  let main = text();
  let d = 5;
  for (const b of opts.between ?? []) {
    if (b.file) await commitAt(repo, env, { [b.file]: `${b.subject}\n` }, b.subject, day(d++));
    else { main = text({ 1: `main ${b.subject}` }); await commitAt(repo, env, { "k.txt": main }, b.subject, day(d++)); }
  }
  const merged = main.split("\n").map((l, i) => (i === 8 ? "branch done" : l)).join("\n");
  const s = await commitAt(repo, env, { "k.txt": merged }, "Kept work (#9)", day(d++));
  let o3: string | undefined;
  if (opts.editAfter) {
    await g(repo, ["checkout", "-q", "k"], env);
    o3 = await commitAt(repo, env, { "k.txt": text({ 9: "branch done", 10: "edited after" }) }, "o3", day(d++));
    await g(repo, ["checkout", "-q", "main"], env);
  }
  return { repo, o1, o2, o3, s };
}
async function check(env: Record<string, string>, repo: string, opts: { cap?: number; ms?: number; tmpRoot?: string; substitute?: (a: string[]) => string[] | undefined } = {}) {
  const tmpRoot = opts.tmpRoot ?? scratch("tmproot");
  const out = await withGit(env, async () => {
    const c = await ctxFor(repo, opts.ms);
    const cap = { left: opts.cap ?? SQUASH_CHECK_CAP };
    return { match: await squashMatch(openScan(c.rg, WINDOW, new Date()), "refs/heads/k", c.commonDir, cap, { tmpRoot }), cap };
  }, opts.substitute);
  return { ...out, tmpRoot };
}
const subcommand = (argv: string[], name: string) => argv.includes(name);

describe("the kept-branch test", () => {
  for (const upstream of [false, true]) test(`squash grouping suppresses ${upstream ? "not-pushed" : "never-pushed"} branch-line warnings while preserving behind`, async () => {
    const { env } = isolatedGit();
    const { repo, o1, o2, s } = await keptSquash(env);
    await g(repo, ["remote", "add", "origin", "https://example.invalid/fixture.git"], env);
    await g(repo, ["update-ref", "refs/remotes/origin/main", s], env);
    if (upstream) {
      await g(repo, ["config", "branch.k.remote", "origin"], env);
      await g(repo, ["config", "branch.k.merge", "refs/heads/main"], env);
    }
    const { result } = await withGit(env, async () => {
      const c = await ctxFor(repo);
      const scan = openScan(c.rg, WINDOW, new Date());
      const facts = await pushFacts(scan);
      const branches = await branchPushes(scan, facts);
      const before = await countPush(scan, branches, { merged: new Set(), pageShas: null, remoteRefs: facts.remoteRefs });
      const beforeLine = await branchLine(scan, facts, before, { key: "app", name: "k" });
      const matched = await squashMatches(scan, ["refs/heads/k"], c.commonDir, { left: SQUASH_CHECK_CAP }, { tmpRoot: scratch("t") });
      const rows = await groupLabel(scan, [o1, o2, s].map((sha) => ({ sha, token: sha.slice(0, 7) })), matched);
      const push = await countPush(scan, branches, { merged: new Set(matched.keys()), pageShas: null, remoteRefs: facts.remoteRefs });
      return { beforeLine, rows, push, line: await branchLine(scan, facts, push, { key: "app", name: "k" }) };
    });
    expect(result.beforeLine).toMatchObject({ state: "live", notPushed: 2, neverPushed: !upstream, behind: upstream ? 1 : 0 });
    expect(result.rows).toEqual([{ kind: "pr", number: 9, title: "Kept work", commits: [s, o2, o1].map((sha) => ({ sha, token: sha.slice(0, 7) })) }]);
    expect(result.push).toMatchObject({ tile: { commits: 0, branches: 0 } });
    expect(result.line).toEqual({ key: "app", name: "k", state: "live", notPushed: 0, neverPushed: false, behind: upstream ? 1 : 0 });
  });
  test.skipIf(!gitAtLeast(2, 38))("a kept squash-merged branch matches its (#N) commit by merge-tree, writing nothing to the repo", async () => {
    const { env } = isolatedGit();
    const { repo, s } = await keptSquash(env);
    const before = await objectCount(repo, env);
    const { result, tmpRoot } = await check(env, repo);
    expect(result.match).toEqual({ number: 9, sha: s, title: "Kept work" });
    expect(result.cap.left).toBe(SQUASH_CHECK_CAP - 1);
    expect(await objectCount(repo, env)).toBe(before);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(SQUASH_CHECK_CAP).toBe(16);
  });

  test.skipIf(!gitAtLeast(2, 38))("the same branch edited after the merge does not match (amber, the residual), and the object count is unchanged", async () => {
    const { env } = isolatedGit();
    // another PR landed in between, so merge-tree's merged tree is a NEW object (a trivial merge writes none)
    const { repo } = await keptSquash(env, { editAfter: true, between: [{ file: "other.txt", subject: "Other (#1)" }] });
    const before = await objectCount(repo, env);
    const { result, calls } = await check(env, repo);
    expect(result.match).toBeNull();
    expect(calls.some((a) => subcommand(a, "merge-tree"))).toBe(true);
    expect(calls.some((a) => subcommand(a, "patch-id"))).toBe(false);   // merge-tree answered (exit 0, another tree): no fallback
    expect(await objectCount(repo, env)).toBe(before);
    // CONTROL: the same merge-tree without the throwaway object directory writes its tree into the repo
    const s = (await g(repo, ["log", "-1", "--format=%H", "main"], env)).trim();
    await g(repo, ["merge-tree", "--write-tree", `${s}^`, "k"], env);
    expect(await objectCount(repo, env)).toBeGreaterThan(before);
  });

  test.skipIf(!gitAtLeast(2, 38))("a squash after another PR landed in between matches by merge-tree; one that resolved a conflict with it is amber", async () => {
    const { env } = isolatedGit();
    const clean = await keptSquash(env, { between: [{ file: "other.txt", subject: "Other (#1)" }] });
    expect((await check(env, clean.repo)).result.match).toEqual({ number: 9, sha: clean.s, title: "Kept work" });
    // a conflict: main's PR changed line 9 too, and the squash resolved it
    const repo = await newRepo({ "k.txt": text() });
    await g(repo, ["checkout", "-q", "-b", "k"], env);
    await commitAt(repo, env, { "k.txt": text({ 9: "branch done" }) }, "o1", day(3));
    await g(repo, ["checkout", "-q", "main"], env);
    await commitAt(repo, env, { "k.txt": text({ 9: "main nine" }) }, "Main nine (#1)", day(4));
    await commitAt(repo, env, { "k.txt": text({ 9: "branch done, with main nine" }) }, "Kept work (#9)", day(5));
    const { result, calls } = await check(env, repo);
    expect(result.match).toBeNull();
    expect(calls.some((a) => subcommand(a, "patch-id"))).toBe(true);    // the conflict took the fallback, which differs too
  });

  test.skipIf(!gitAtLeast(2, 38))("past the cap the branch stays amber: a newer non-matching candidate spends the only check", async () => {
    const { env } = isolatedGit();
    const { repo, s } = await keptSquash(env);
    const q = await commitAt(repo, env, { "q.txt": "q\n" }, "Unrelated (#10)", day(20));
    void q;
    expect((await check(env, repo, { cap: 1 })).result.match).toBeNull();
    expect((await check(env, repo, { cap: 0 })).calls.some((a) => subcommand(a, "merge-tree"))).toBe(false);
    expect((await check(env, repo)).result.match).toEqual({ number: 9, sha: s, title: "Kept work" });
  });

  test.skipIf(!gitAtLeast(2, 38))("squashMatches checks each branch, sharing the cap; groupLabel then puts the kept branch's commits in the PR row", async () => {
    const { env } = isolatedGit();
    const { repo, o1, o2, s } = await keptSquash(env);
    const { result } = await withGit(env, async () => {
      const c = await ctxFor(repo);
      const scan = openScan(c.rg, WINDOW, new Date());
      const cap = { left: SQUASH_CHECK_CAP };
      const matched = await squashMatches(scan, ["refs/heads/k", "refs/heads/main"], c.commonDir, cap, { tmpRoot: scratch("t") });
      return { matched, rows: await groupLabel(scan, [o1, o2, s].map((sha) => ({ sha, token: sha.slice(0, 7) })), matched) };
    });
    expect([...result.matched.keys()]).toEqual(["refs/heads/k"]);
    expect(result.rows).toEqual([{ kind: "pr", number: 9, title: "Kept work", commits: [s, o2, o1].map((sha) => ({ sha, token: sha.slice(0, 7) })) }]);
  });
});

describe("the fallback: patch-id over spooled diffs", () => {
  test.skipIf(!gitAtLeast(2, 38))("a repo-scoped merge driver attributed to the changed file never runs: emptied, merge-tree reports a conflict (exit 1) and the patch-id path answers", async () => {
    const { env } = isolatedGit();
    const { repo, s } = await keptSquash(env, { between: [{ subject: "Main one (#1)" }] });   // main changed line 1, the branch line 9: both touch k.txt
    const marker = join(scratch("marker"), "ran");
    await g(repo, ["config", "merge.x.driver", `${markerScript(scratch("bin"), "merge.sh", marker, "exit 0")} %O %A %B`], env);
    writeFileSync(join(repo, ".git", "info", "attributes"), "k.txt merge=x\n");
    const { result, calls } = await check(env, repo);
    expect(result.match).toEqual({ number: 9, sha: s, title: "Kept work" });
    expect(calls.some((a) => subcommand(a, "merge-tree") && a.includes("merge.x.driver="))).toBe(true);
    expect(calls.some((a) => subcommand(a, "patch-id"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
    await gRaw(repo, ["merge-tree", "--write-tree", `${s}^`, "k"], env);    // CONTROL: plain git runs the driver
    expect(existsSync(marker)).toBe(true);
  });

  test("an objects path holding the alternates separator skips merge-tree and takes the patch-id path", async () => {
    const { env } = isolatedGit();
    const dir = join(scratch("sep"), "a:b");
    mkdirSync(dir);
    const { repo, s } = await keptSquash(env, { dir });
    const { result, calls } = await check(env, repo);
    expect(result.match).toEqual({ number: 9, sha: s, title: "Kept work" });
    expect(calls.some((a) => subcommand(a, "merge-tree"))).toBe(false);
    expect(calls.some((a) => subcommand(a, "patch-id"))).toBe(true);
  });

  test("a git refusing --write-tree (git before 2.38) takes the patch-id path", async () => {
    const { env } = isolatedGit();
    const { repo, s } = await keptSquash(env);
    const refuse = (a: string[]) => (subcommand(a, "merge-tree") ? ["sh", "-c", "echo 'error: unknown option `write-tree`' >&2; exit 129"] : undefined);
    const { result, calls } = await check(env, repo, { substitute: refuse });
    expect(result.match).toEqual({ number: 9, sha: s, title: "Kept work" });
    expect(calls.some((a) => subcommand(a, "patch-id"))).toBe(true);
    for (const a of calls.filter((x) => subcommand(x, "diff"))) {
      expect(a).toEqual(expect.arrayContaining(["--no-textconv", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--end-of-options"]));
      expect(a.slice(a.indexOf("--end-of-options") + 1).every((x) => /^[0-9a-f]{40}(\^)?$/.test(x))).toBe(true);
    }
  });

  test("a spool over 1 MiB answers amber without running patch-id", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo({ "k.txt": text() });
    await g(repo, ["checkout", "-q", "-b", "k"], env);
    const big = Array.from({ length: 40_000 }, (_, i) => `big line ${i} ${"z".repeat(20)}`).join("\n") + "\n";   // ~1.3 MiB of diff
    await commitAt(repo, env, { "big.txt": big }, "o1", day(3));
    await g(repo, ["checkout", "-q", "main"], env);
    await commitAt(repo, env, { "big.txt": big }, "Big (#9)", day(4));
    expect(SPOOL_MAX_BYTES).toBe(1024 * 1024);
    const refuse = (a: string[]) => (subcommand(a, "merge-tree") ? ["sh", "-c", "exit 129"] : undefined);
    const { result, calls, tmpRoot } = await check(env, repo, { substitute: refuse });
    expect(result.match).toBeNull();
    expect(calls.some((a) => subcommand(a, "diff"))).toBe(true);
    expect(calls.some((a) => subcommand(a, "patch-id"))).toBe(false);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
});

describe("nothing is left behind", () => {
  test.skipIf(!gitAtLeast(2, 38))("no temp object dir and no spool after a normal call, a conflict, and calls killed by their timeout", async () => {
    const { env } = isolatedGit();
    const ok = await keptSquash(env);
    expect(readdirSync((await check(env, ok.repo)).tmpRoot)).toEqual([]);
    const conflict = await keptSquash(env, { between: [{ subject: "Main one (#1)" }] });
    writeFileSync(join(conflict.repo, ".git", "info", "attributes"), "k.txt merge=x\n");
    await g(conflict.repo, ["config", "merge.x.driver", "false"], env);
    expect(readdirSync((await check(env, conflict.repo)).tmpRoot)).toEqual([]);
    // merge-tree killed by its timeout: the repo answers unknown, the object dir is gone
    const sleepMergeTree = (a: string[]) => (subcommand(a, "merge-tree") ? ["sh", "-c", "exec sleep 10"] : undefined);
    const t1 = scratch("tmproot");
    await expect(check(env, ok.repo, { ms: 3_000, tmpRoot: t1, substitute: sleepMergeTree })).rejects.toBeInstanceOf(RepoUnknown);
    expect(readdirSync(t1)).toEqual([]);
    // the diff killed by its timeout (merge-tree refused): the spool dir is gone
    const sleepDiff = (a: string[]) => (subcommand(a, "merge-tree") ? ["sh", "-c", "exit 129"] : subcommand(a, "diff") ? ["sh", "-c", "exec sleep 10"] : undefined);
    const t2 = scratch("tmproot");
    await expect(check(env, ok.repo, { ms: 3_000, tmpRoot: t2, substitute: sleepDiff })).rejects.toBeInstanceOf(RepoUnknown);
    expect(readdirSync(t2)).toEqual([]);
  });
});

describe("hostile repo: no repo-scoped program runs through T6's calls", () => {
  test.skipIf(!gitAtLeast(2, 38))("resolutions, merge-base, the candidate listing, merge-tree, the diffs and patch-id run none of the armed programs; the controls run them", async () => {
    const { env } = isolatedGit();
    const dir = scratch("hostile");
    const repo = await newRepo({ "k.txt": text() });
    await signCommits(repo, env, dir);
    // main changes line 1, the branch line 9 of the same file: merge-tree must merge k.txt (the merge driver's
    // file), and a second kept branch with a conflict forces the fallback's diffs and patch-id too
    await g(repo, ["checkout", "-q", "-b", "k"], env);
    const o1 = await commitAt(repo, env, { "k.txt": text({ 9: "branch done" }) }, "o1", day(3));
    await g(repo, ["checkout", "-q", "-b", "c", "main"], env);
    const c1 = await commitAt(repo, env, { "k.txt": text({ 1: "conflicting" }) }, "c1", day(3));
    await g(repo, ["checkout", "-q", "main"], env);
    const p = await commitAt(repo, env, { "k.txt": text({ 1: "main one" }) }, "Main one (#1)", day(4));
    const s = await commitAt(repo, env, { "k.txt": text({ 1: "main one", 9: "branch done" }) }, "Kept work (#9)", day(5));
    const hostile = await armHostile(repo, env, dir);
    const { result, calls } = await withGit(env, async () => {
      const c = await ctxFor(repo);
      const scan = openScan(c.rg, WINDOW, new Date());
      return squashMatches(scan, ["refs/heads/k", "refs/heads/c"], c.commonDir, { left: SQUASH_CHECK_CAP }, { tmpRoot: scratch("t") });
    });
    expect([...result.entries()]).toEqual([["refs/heads/k", { number: 9, sha: s, title: "Kept work" }]]);
    expect(calls.some((a) => subcommand(a, "patch-id"))).toBe(true);
    expect(hostile.ran()).toEqual([]);
    await runControls(repo, env, { diff: [p, s], signed: s, merge: [o1, c1] });
    expect(hostile.ran()).toEqual(expect.arrayContaining(["gpg", "diff-command", "merge-driver"]));
  });
});


describe("B1-M2 checkpoint regressions", () => {
  for (const scope of ["--local", "--global"]) {
    test(`diff.relative=true ${scope}: an unmatched change outside the configured subdirectory prevents a squash match`, async () => {
      const { env } = isolatedGit();
      const repo = await newRepo({ "sub/a.txt": text(), "other/c.txt": text() });
      await g(repo, ["checkout", "-q", "-b", "k"], env);
      await commitAt(repo, env, { "sub/a.txt": text({ 9: "branch" }), "other/c.txt": text({ 1: "branch" }) }, "branch", day(12));
      await g(repo, ["checkout", "-q", "main"], env);
      await commitAt(repo, env, { "other/c.txt": text({ 1: "main" }) }, "conflict", day(13));
      await commitAt(repo, env, { "sub/a.txt": text({ 9: "branch" }) }, "Only sub (#9)", day(14));
      await g(repo, ["config", scope, "diff.relative", "true"], env);
      const { result, calls } = await check(env, join(repo, "sub"));
      expect(result.match).toBeNull();
      expect(calls.some((a) => a.includes("patch-id"))).toBe(true);
      const diffs = calls.filter((a) => a.includes("diff"));
      expect(diffs.length).toBeGreaterThan(0);
      expect(diffs.every((a) => a.includes("--no-relative") && a.includes("diff.relative=false"))).toBe(true);
    });
  }

  test("default SHAs are resolved once per repo scan, shared across branches", async () => {
    const { env } = isolatedGit();
    const { repo } = await keptSquash(env);
    await g(repo, ["branch", "k2", "k"], env);
    const { result, calls } = await withGit(env, async () => {
      const c = await ctxFor(repo);
      return squashMatches(openScan(c.rg, WINDOW, new Date()), ["refs/heads/k", "refs/heads/k2"], c.commonDir, { left: SQUASH_CHECK_CAP }, { tmpRoot: scratch("t") });
    });
    expect([...result.keys()]).toEqual(["refs/heads/k", "refs/heads/k2"]);
    expect(calls.filter((a) => a.includes("rev-parse") && a.includes("refs/heads/main^{commit}"))).toHaveLength(1);
  });

  test("an over-cap diff shim is killed before it finishes and never reaches patch-id", async () => {
    const { env } = isolatedGit();
    const { repo } = await keptSquash(env);
    const marker = join(scratch("writer"), "finished");
    const script = `const fs = require("node:fs"); fs.writeSync(1, Buffer.alloc(${SPOOL_MAX_BYTES + 65536})); await Bun.sleep(400); fs.writeFileSync(process.argv[1], "finished");`;
    const substitute = (a: string[]) => a.includes("merge-tree") ? ["sh", "-c", "exit 129"]
      : a.includes("diff") ? [process.execPath, "-e", script, marker] : undefined;
    const { result, calls, tmpRoot } = await check(env, repo, { substitute });
    expect(result.match).toBeNull();
    expect(calls.some((a) => a.includes("diff"))).toBe(true);
    expect(calls.some((a) => a.includes("patch-id"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  test("merge-tree output over the cap refuses and falls back to patch-id (M12)", async () => {
    const { env } = isolatedGit();
    const { repo, s } = await keptSquash(env);
    const substitute = (a: string[]) => a.includes("merge-tree")
      ? [process.execPath, "-e", `require("node:fs").writeSync(1, Buffer.alloc(${SPOOL_MAX_BYTES + 65536})); await Bun.sleep(10000);`] : undefined;
    const { result, calls } = await check(env, repo, { substitute });
    expect(result.match).toEqual({ number: 9, sha: s, title: "Kept work" });
    expect(calls.some((a) => a.includes("patch-id"))).toBe(true);
  });

  test("a (#N) commit older than the branch merge-base is not a candidate (M13)", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo({ "k.txt": text() });
    await commitAt(repo, env, { "k.txt": text({ 9: "done" }) }, "Old work (#9)", day(12));
    await commitAt(repo, env, { "k.txt": text() }, "revert old work", day(13));
    await g(repo, ["checkout", "-q", "-b", "k"], env);
    await commitAt(repo, env, { "k.txt": text({ 9: "done" }) }, "new work", day(14));
    await g(repo, ["checkout", "-q", "main"], env);
    const { result, calls } = await check(env, repo);
    expect(result.match).toBeNull();
    expect(result.cap.left).toBe(SQUASH_CHECK_CAP);
    expect(calls.some((a) => a.includes("merge-tree") || a.includes("patch-id"))).toBe(false);
  });

  test("merge-base uses ALL diverged default SHAs; the squash on origin/main uses its closer base (M33)", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo({ "k.txt": text() });
    await g(repo, ["checkout", "-q", "-b", "k"], env);
    const prefix = await commitAt(repo, env, { "prefix.txt": "already landed" }, "prefix", day(12));
    await commitAt(repo, env, { "k.txt": text({ 9: "done" }) }, "remaining work", day(13));
    await g(repo, ["checkout", "-q", "--detach", prefix], env);
    const squash = await commitAt(repo, env, { "k.txt": text({ 9: "done" }) }, "Remote work (#9)", day(14));
    await g(repo, ["update-ref", "refs/remotes/origin/main", squash], env);
    await g(repo, ["checkout", "-q", "main"], env);
    const local = await commitAt(repo, env, { "local.txt": "local" }, "local main diverged", day(14));
    const substitute = (a: string[]) => a.includes("merge-tree") ? ["sh", "-c", "exit 129"] : undefined;
    const { result, calls } = await check(env, repo, { substitute });
    expect(result.match).toEqual({ number: 9, sha: squash, title: "Remote work" });
    const mergeBase = calls.find((a) => a.includes("merge-base") && !a.includes("--is-ancestor"))!;
    expect(mergeBase.slice(mergeBase.indexOf("--end-of-options") + 2)).toEqual([local, squash]);
    expect(calls.some((a) => a.includes("diff") && a.slice(-2)[0] === prefix)).toBe(true);
  });
});
