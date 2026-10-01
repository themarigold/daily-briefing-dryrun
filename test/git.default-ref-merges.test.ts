// test/git.default-ref-merges.test.ts — tier B, T3.1: `GitTimeoutError` (D2 revised), the git budget,
// `listDefaultRefMerges` and `mergeMembers` (spec §4.3 "How PR facts are derived" items 1–6, D6, D9, D15).
// Cases P21, P22, P23, P25, P26, P27, P29, P30a of spec §5.4 (plan §7), plus the plan-added pins.
//
// THE KILL MECHANISM (plan §1 / T3.1, round 5 MED 2): a PASS-THROUGH `spyOn(Bun, "spawn")` substitutes
// `sh -c 'kill -KILL $$'` — a child that kills itself at once — for EXACTLY ONE of B's argvs; every other
// spawn (this file's own fixture git calls included) reaches the real `Bun.spawn`. Bun reports that child
// exactly as a timeout kill (`exitCode: null`, `signalCode: "SIGKILL"`), it spends ~0 ms of budget, so
// every LATER call still starts, and it needs no timing. The ONE real per-call-timeout kill in the whole
// build is the `sleep 5` rev-list under an explicit 2 500 ms budget below. One variant of the instant
// kill, `sh -c 'sleep 5 & kill -KILL $$'`, adds a grandchild that holds the pipes (dash's own shape
// under that real kill) to pin that the timeout classifier runs before the incomplete-read gate.
//
// Test hygiene: `beforeAll` warms the process-wide `_supportsSinceAsFilter` cache with one real call
// before any spy is installed; clones for `origin/*` are made here with `git clone` into temp dirs;
// `build-repo.ts` is not extended.
import { test, expect, describe, beforeAll, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import {
  runGit, gitDirExists, IncompleteReadError, GitTimeoutError, GIT_TIMEOUT_MS, GIT_FLUSH_MS,
  perCallTimeoutMs, startGitBudget, listDefaultRefMerges, mergeMembers, listPrMerges,
} from "../src/git";

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────

/** The REAL spawn, captured before any spy so the fixture helpers and the pass-through both use it. */
const realSpawn = Bun.spawn;
type SpawnArgs = Parameters<typeof Bun.spawn>;

/** Fixture commands run under a NEUTRAL git config: the developer's global/system gitconfig (a
 *  `fetch.prune`, a `followRemoteHEAD`, a signing key) must not shape what the fixtures contain. The code
 *  under test (`runGit`) still runs under the real environment, as in production. */
const NEUTRAL_GIT = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
async function sh(args: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const p = realSpawn(args, { cwd, env: { ...process.env, ...NEUTRAL_GIT, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`${args.join(" ")} in ${cwd}: ${err}`);
  return out;
}
const git = (args: string[], cwd: string, env: Record<string, string> = {}) => sh(["git", ...args], cwd, env);
const tmp = (label: string) => removeAtRunEnd(mkdtempSync(join(tmpdir(), `dba-drm-${label}-`)));

/** ISO dates on ONE earlier local day (`yesterdayNoon`, plan §1), spaced by minutes. */
const day = new Date(); day.setHours(12, 0, 0, 0); day.setDate(day.getDate() - 1);
const at = (minutes: number): string => new Date(day.getTime() + minutes * 60_000).toISOString();
const WINDOW_START = new Date(day.getTime() - 6 * 3600_000);
const NOW = new Date(day.getTime() + 6 * 3600_000);
const dated = (iso: string) => ({ GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });

async function initRepo(branch: string): Promise<string> {
  const dir = tmp("origin");
  await git(["init", "-q", "-b", branch], dir);
  await git(["config", "user.name", "Test"], dir);
  await git(["config", "user.email", "test@example.com"], dir);
  return dir;
}
async function commit(repo: string, file: string, iso: string, message = `add ${file}`): Promise<string> {
  await Bun.write(join(repo, file), `${file} ${iso}\n`);
  await git(["add", "."], repo);
  await git(["commit", "-q", "-m", message], repo, dated(iso));
  return (await git(["rev-parse", "HEAD"], repo)).trim();
}
/** A topic branch from `from` with one commit, merged back into the current branch with `subject`. */
async function prMerge(repo: string, branch: string, file: string, iso: string, subject: string): Promise<string> {
  const base = (await git(["rev-parse", "HEAD"], repo)).trim();
  await git(["checkout", "-q", "-b", branch, base], repo);
  await commit(repo, file, iso);
  await git(["checkout", "-q", "-"], repo);
  await git(["merge", "-q", "--no-ff", "-m", subject, branch], repo, dated(iso));
  return (await git(["rev-parse", "HEAD"], repo)).trim();
}
async function clone(origin: string): Promise<string> {
  const dir = tmp("clone");
  await git(["clone", "-q", origin, dir], process.cwd());
  await git(["config", "user.name", "Test"], dir);
  await git(["config", "user.email", "test@example.com"], dir);
  return dir;
}
const generous = () => startGitBudget(60_000);
const prs = (r: { merges: { pr?: { number: number } }[] }) => r.merges.map((m) => m.pr?.number ?? null);

/** The pass-through spy: `substitute(argv)` returns a replacement argv for the ONE call to hijack, or
 *  undefined to let it through. Restored by the caller's `finally`. */
function spawnSpy(substitute: (argv: string[]) => string[] | undefined) {
  const calls: string[][] = [];
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: SpawnArgs[0], opts: SpawnArgs[1]) => {
    const argv = cmd as string[];
    calls.push(argv);
    const sub = substitute(argv);
    return realSpawn(sub ?? argv, opts as any);
  }) as typeof Bun.spawn);
  return { spy, calls };
}
const KILL = ["sh", "-c", "kill -KILL $$"];
const isRevListRange = (argv: string[]) => argv[0] === "git" && argv[1] === "rev-list" && /^[0-9a-f]+\.\.[0-9a-f]+$/.test(argv[2] ?? "");
const isMergeLog = (argv: string[]) => argv[0] === "git" && argv[1] === "log" && argv.includes("--first-parent") && argv.includes("--merges");
const isSymbolicRef = (argv: string[]) => argv[0] === "git" && argv[1] === "symbolic-ref" && argv.includes("refs/remotes/origin/HEAD");

beforeAll(async () => {
  // Warm the process-wide `_supportsSinceAsFilter` cache (git.ts) with one REAL call, before any spy:
  // `windowArgs` probes `git --version` once per process, and a probe under a spy would be order-dependent.
  const warm = await initRepo("main");
  await commit(warm, "w.txt", at(0));
  await listPrMerges(warm, WINDOW_START, NOW);
});

// ── GitTimeoutError and the budget ─────────────────────────────────────────────────────────────────

describe("GitTimeoutError (D2 revised) and the git budget", () => {
  test("GitTimeoutError is an Error with the plain failure's message, and orElse swallows it like any other git failure", async () => {
    const e = new GitTimeoutError("git log failed in /r: killed");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(GitTimeoutError);
    expect(e.name).toBe("GitTimeoutError");
    expect(e.message).toBe("git log failed in /r: killed");
    expect(new GitTimeoutError("x")).not.toBeInstanceOf(IncompleteReadError);
    // `orElse` (module-private) is what `gitDirExists` catches with: a kill on its `rev-parse` is
    // swallowed to `false`, exactly as a plain failure is — backward-compatible by construction.
    const repo = await initRepo("main");
    const { spy } = spawnSpy((argv) => (argv[1] === "rev-parse" && argv[2] === "--git-dir" ? KILL : undefined));
    try {
      expect(await gitDirExists(repo)).toBe(false);
    } finally { spy.mockRestore(); }
    expect(await gitDirExists(repo)).toBe(true);
  });

  test("[TB-P29] runGit classifies a timeout kill as GitTimeoutError: exitCode null and signalCode SIGKILL, nothing else", async () => {
    const repo = await initRepo("main");
    const { spy } = spawnSpy((argv) => (argv[1] === "status" ? KILL : undefined));
    try {
      const err = await runGit(["status", "--porcelain"], repo).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(GitTimeoutError);
      expect(err.message).toMatch(/^git status --porcelain failed in /);
    } finally { spy.mockRestore(); }
    // …and the same child, observed raw, is what Bun reports for a timeout kill
    const p = realSpawn(KILL, { stdout: "pipe", stderr: "pipe" });
    await p.exited;
    expect([p.exitCode, p.signalCode]).toEqual([null, "SIGKILL"]);
  });

  test("[TB-P29] a timeout kill whose grandchild still holds the pipes is GitTimeoutError, not IncompleteReadError", async () => {
    // `sleep 5 &` leaves a grandchild holding stdout/stderr open; `kill -KILL $$` then kills `sh` at once,
    // exactly as a timeout kill reports (exitCode null, SIGKILL). The flush race gives up after
    // GIT_FLUSH_MS with stdout INCOMPLETE — so both classifications apply, and the classifier must win
    // over the incomplete-read gate (what the real-timeout rev-list case relies on under Linux dash).
    const repo = await initRepo("main");
    const { spy } = spawnSpy((argv) => (argv[1] === "status" ? ["sh", "-c", "sleep 5 & kill -KILL $$"] : undefined));
    try {
      const err = await runGit(["status", "--porcelain"], repo).then(() => null, (e) => e);
      expect(err).not.toBeInstanceOf(IncompleteReadError);
      expect(err).toBeInstanceOf(GitTimeoutError);
    } finally { spy.mockRestore(); }
  });

  test("a git killed by a non-timeout signal is not a timeout", async () => {
    const repo = await initRepo("main");
    const { spy } = spawnSpy((argv) => (argv[1] === "status" ? ["sh", "-c", "kill -TERM $$"] : undefined));
    try {
      const err = await runGit(["status", "--porcelain"], repo).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(GitTimeoutError);
      expect(err.message).toMatch(/^git status --porcelain failed in /);
    } finally { spy.mockRestore(); }
    const p = realSpawn(["sh", "-c", "kill -TERM $$"], { stdout: "pipe", stderr: "pipe" });
    await p.exited;
    expect([p.exitCode, p.signalCode]).toEqual([null, "SIGTERM"]);
  });

  test("the per-call git timeout is an integer ≥ 1, or the call does not start", () => {
    // remaining → timeout (plan §4 T3.1; round 4 MED 2's inputs)
    expect(perCallTimeoutMs(1000)).toBeUndefined();                  // 0 → not started (0 would mean NO timeout to Bun)
    expect(perCallTimeoutMs(1000.9)).toBeUndefined();                // refused by the ≥ 1 check (0 with floor, 0.9 without)
    expect(perCallTimeoutMs(1001)).toBe(1);
    expect(perCallTimeoutMs(40_000)).toBe(GIT_TIMEOUT_MS);
    // why the reserve is 1 000 ms: a call killed at its timeout (remaining − 1 000) still races its pipes
    // for GIT_FLUSH_MS after exiting, so it ends inside the budget only while GIT_FLUSH_MS < 1 000
    expect(GIT_FLUSH_MS).toBeLessThan(1000);
    expect(perCallTimeoutMs(0)).toBeUndefined();
    expect(perCallTimeoutMs(-5)).toBeUndefined();
    // the two FRACTIONAL inputs that START a call — what catches a dropped floor: Bun rejects 1.5 and 500.5
    for (const [remaining, want] of [[1001.5, 1], [1500.5, 500]] as const) {
      const t = perCallTimeoutMs(remaining);
      expect(t).toBe(want);
      expect(Number.isInteger(t)).toBe(true);
    }
    // the budget object applies the same rule to its own clock, which starts at the first read
    let clock = 0;
    const b = startGitBudget(2500, () => clock);
    expect(b.remainingMs()).toBe(2500);                              // started now, nothing spent
    clock = 1000;
    expect(b.remainingMs()).toBe(1500);
    expect(b.callTimeoutMs()).toBe(500);
    clock = 1498.5;
    expect(b.callTimeoutMs()).toBe(1);                               // 1001.5 left: floor(1001.5) − 1000
    clock = 1499.5;
    expect(b.callTimeoutMs()).toBeUndefined();                       // 1000.5 left: floor → 0, not started
    clock = 1500;
    expect(b.callTimeoutMs()).toBeUndefined();                       // exactly 1 000 left: not started
    clock = 9999;
    expect(b.remainingMs()).toBe(0);
    expect(startGitBudget(0, () => 0).callTimeoutMs()).toBeUndefined();
    // the clock starts LAZILY: a budget built early spends nothing until its first read
    let c2 = 0;
    const late = startGitBudget(3000, () => c2);
    c2 = 5000;
    expect(late.remainingMs()).toBe(3000);
  });
});

// ── listDefaultRefMerges (§4.3 items 1–2, 5) ───────────────────────────────────────────────────────

describe("listDefaultRefMerges: the default refs' first-parent PR merges, in the window", () => {
  test("[TB-P21] first-parent only: a back-merge into a topic branch is not a unit", async () => {
    // main: A → M(#7, feat/x) → C → M(#10, feat/y); on feat/y a BACK-MERGE of main (#9) before #10.
    const repo = await initRepo("main");
    const a = await commit(repo, "a.txt", at(0));
    await prMerge(repo, "feat/x", "x.txt", at(10), "Merge pull request #7 from owner/feat/x");
    await git(["checkout", "-q", "-b", "feat/y", a], repo);
    await commit(repo, "y.txt", at(20));
    await git(["checkout", "-q", "main"], repo);
    await commit(repo, "c.txt", at(30));
    await git(["checkout", "-q", "feat/y"], repo);
    await git(["merge", "-q", "--no-ff", "-m", "Merge pull request #9 from owner/main", "main"], repo, dated(at(40)));
    await git(["checkout", "-q", "main"], repo);
    await git(["merge", "-q", "--no-ff", "-m", "Merge pull request #10 from owner/feat/y", "feat/y"], repo, dated(at(50)));
    const r = await listDefaultRefMerges(repo, WINDOW_START, NOW, generous());
    expect(r.unread).toBe(false);
    expect(prs(r)).toEqual([10, 7]);                                 // #9 is on feat/y's first-parent chain, not main's
    expect(r.merges.every((m) => m.parents.length === 2)).toBe(true);
    // the same walk WITHOUT --first-parent would list #9 too — the fixture really contains it
    const all = await runGit(["log", "--merges", "--format=%s", "main"], repo);
    expect(all).toContain("#9");
  });

  test("[TB-P22] the UNION: a merge only on origin/<default> yields a fact", async () => {
    const origin = await initRepo("main");
    await commit(origin, "a.txt", at(0));
    await prMerge(origin, "feat/x", "x.txt", at(10), "Merge pull request #7 from owner/feat/x");
    const work = await clone(origin);
    // the clone's LOCAL main lags behind origin/main: the merge is only on the remote ref
    await git(["reset", "-q", "--hard", "HEAD~1"], work);
    expect((await git(["log", "--merges", "--format=%s", "main"], work)).trim()).toBe("");
    const r = await listDefaultRefMerges(work, WINDOW_START, NOW, generous());
    expect(prs(r)).toEqual([7]);
    expect(r.merges[0]!.pr).toEqual({ number: 7, branch: "feat/x" });
    // …and listed ONCE although main and origin/main are both walked (dedupe by SHA)
    await git(["reset", "-q", "--hard", "origin/main"], work);
    expect(prs(await listDefaultRefMerges(work, WINDOW_START, NOW, generous()))).toEqual([7]);
  });

  test("[TB-P23] origin/HEAD still names master while the work is on main: facts from both", async () => {
    // cloned before a master→main rename: origin/HEAD stays origin/master (fetch never refreshes it)
    const origin = await initRepo("master");
    await commit(origin, "a.txt", at(0));
    await prMerge(origin, "feat/x", "x.txt", at(10), "Merge pull request #7 from owner/feat/x");
    const work = await clone(origin);
    expect((await git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], work)).trim()).toBe("origin/master");
    await git(["branch", "-m", "master", "main"], origin);
    await prMerge(origin, "feat/z", "z.txt", at(20), "Merge pull request #11 from owner/feat/z");
    // No prune and no origin/HEAD refresh on this fetch — the pre-2.48 behaviour the case models (a
    // newer git's `remote.<name>.followRemoteHEAD` can refresh the symbol; a user's `fetch.prune` would
    // drop the tracking ref). Then the stale symbol is pinned explicitly as the state under test.
    await git(["-c", "fetch.prune=false", "-c", "remote.origin.followRemoteHEAD=never", "fetch", "-q", "origin"], work);
    await git(["checkout", "-q", "-b", "main", "origin/main"], work);
    await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"], work);
    expect((await git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], work)).trim()).toBe("origin/master");
    expect((await git(["for-each-ref", "--format=%(refname)", "refs/remotes/origin/master"], work)).trim()).toBe("refs/remotes/origin/master");   // still a live tracking ref
    const r = await listDefaultRefMerges(work, WINDOW_START, NOW, generous());
    expect(r.unread).toBe(false);
    expect(prs(r)).toEqual([11, 7]);                                 // newest first (git log order): #11 on main, #7 from master's history
    // a precedence chain (origin/HEAD alone) would have walked origin/master only and missed #11
  });

  test("[TB-P25] the window rule: a merge before windowStart, and one at or after now, give nothing", async () => {
    const repo = await initRepo("main");
    await commit(repo, "a.txt", at(-8 * 60));
    await prMerge(repo, "feat/old", "old.txt", at(-7 * 60), "Merge pull request #1 from owner/feat/old");   // before windowStart (−6 h)
    await prMerge(repo, "feat/edge", "edge.txt", WINDOW_START.toISOString(), "Merge pull request #2 from owner/feat/edge");   // exactly windowStart: IN
    await prMerge(repo, "feat/in", "in.txt", at(10), "Merge pull request #3 from owner/feat/in");            // in
    await prMerge(repo, "feat/now", "now.txt", NOW.toISOString(), "Merge pull request #4 from owner/feat/now");           // exactly now: OUT
    await prMerge(repo, "feat/late", "late.txt", at(7 * 60), "Merge pull request #5 from owner/feat/late");  // after now
    const r = await listDefaultRefMerges(repo, WINDOW_START, NOW, generous());
    expect(prs(r)).toEqual([3, 2]);                                  // newest first: #3 at +10 min, #2 exactly at windowStart
    for (const m of r.merges) {
      const t = new Date(m.timestamp).getTime();
      expect(t >= WINDOW_START.getTime() && t < NOW.getTime()).toBe(true);
    }
  });

  test("[TB-P26] a non-GitHub subject is not a PR", async () => {
    const repo = await initRepo("main");
    await commit(repo, "a.txt", at(0));
    await prMerge(repo, "feat/plain", "p.txt", at(10), "Merge branch 'feat/plain'");
    await prMerge(repo, "feat/pr", "q.txt", at(20), "Merge pull request #7 from owner/feat/pr");
    await prMerge(repo, "feat/lower", "r.txt", at(30), "merge pull request #8 from owner/feat/lower");        // wrong case: not the form
    const r = await listDefaultRefMerges(repo, WINDOW_START, NOW, generous());
    expect(r.merges.map((m) => [m.subject, m.pr?.number ?? null])).toEqual([
      ["merge pull request #8 from owner/feat/lower", null],
      ["Merge pull request #7 from owner/feat/pr", 7],
      ["Merge branch 'feat/plain'", null],
    ]);
    expect(r.merges.filter((m) => m.pr === undefined)).toHaveLength(2);   // still merges — their members count toward K (D6)
  });

  test("[TB-P27] a branch with no `/` parses whole; the remainder after the first `/` otherwise", async () => {
    const repo = await initRepo("main");
    await commit(repo, "a.txt", at(0));
    await prMerge(repo, "feat-only", "f.txt", at(10), "Merge pull request #12 from feat-only");
    await prMerge(repo, "feat/deep", "d.txt", at(20), "Merge pull request #13 from owner/feat/deep/er");
    const r = await listDefaultRefMerges(repo, WINDOW_START, NOW, generous());
    expect(r.merges.map((m) => m.pr)).toEqual([{ number: 13, branch: "feat/deep/er" }, { number: 12, branch: "feat-only" }]);
  });

  test("[TB-P30a] no origin and no main/master: no facts, no throw", async () => {
    const repo = await initRepo("trunk");
    await commit(repo, "a.txt", at(0));
    await prMerge(repo, "feat/x", "x.txt", at(10), "Merge pull request #7 from owner/feat/x");
    expect((await git(["for-each-ref", "--format=%(refname)"], repo)).trim().split("\n").sort()).toEqual(["refs/heads/feat/x", "refs/heads/trunk"]);
    const budget = generous();
    const r = await listDefaultRefMerges(repo, WINDOW_START, NOW, budget);
    expect(r).toEqual({ merges: [], unread: false });
    expect(await mergeMembers(repo, r.merges, budget)).toEqual({ members: new Map(), read: 0, timedOut: 0 });
  });

  test("[TB-P29] a listing killed by its timeout reads no merges for that repo and does not throw", async () => {
    const repo = await initRepo("main");
    await commit(repo, "a.txt", at(0));
    await prMerge(repo, "feat/x", "x.txt", at(10), "Merge pull request #7 from owner/feat/x");
    const { spy, calls } = spawnSpy((argv) => (isMergeLog(argv) ? KILL : undefined));
    try {
      const r = await listDefaultRefMerges(repo, WINDOW_START, NOW, generous());
      expect(r).toEqual({ merges: [], unread: true });
    } finally { spy.mockRestore(); }
    expect(calls.filter(isMergeLog)).toHaveLength(1);                // the ONE log call was the one hijacked
    expect(prs(await listDefaultRefMerges(repo, WINDOW_START, NOW, generous()))).toEqual([7]);   // unspied: read
  });

  test("[TB-P29] a symbolic-ref killed by its timeout reads no merges for that repo and does not throw", async () => {
    // The catch's `instanceof GitTimeoutError` branch: a kill re-throws to the listing rule. Observable
    // only because the kill is INSTANT — a swallowed kill would let the fallback `for-each-ref` start
    // (no budget was spent), list {main}, and come back `unread: false`.
    const origin = await initRepo("main");
    await commit(origin, "a.txt", at(0));
    await prMerge(origin, "feat/x", "x.txt", at(10), "Merge pull request #7 from owner/feat/x");
    const work = await clone(origin);
    const { spy, calls } = spawnSpy((argv) => (isSymbolicRef(argv) ? KILL : undefined));
    try {
      const r = await listDefaultRefMerges(work, WINDOW_START, NOW, generous());
      expect(r).toEqual({ merges: [], unread: true });
    } finally { spy.mockRestore(); }
    expect(calls.filter(isSymbolicRef)).toHaveLength(1);
    expect(calls.some(isMergeLog)).toBe(false);                      // nothing after the kill
    // …whereas a MISSING origin/HEAD (a real non-zero exit) is D15's swallow, not a throw and not unread
    const bare = await initRepo("main");
    await commit(bare, "a.txt", at(0));
    await prMerge(bare, "feat/x", "x.txt", at(10), "Merge pull request #7 from owner/feat/x");
    await expect(git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], bare)).rejects.toThrow();
    const r2 = await listDefaultRefMerges(bare, WINDOW_START, NOW, generous());
    expect([r2.unread, prs(r2)]).toEqual([false, [7]]);
  });

  test("[TB-P29] a zero budget lists nothing, reads nothing, and does not throw", async () => {
    const repo = await initRepo("main");
    await commit(repo, "a.txt", at(0));
    await prMerge(repo, "feat/x", "x.txt", at(10), "Merge pull request #7 from owner/feat/x");
    const { spy, calls } = spawnSpy(() => undefined);
    try {
      const r = await listDefaultRefMerges(repo, WINDOW_START, NOW, startGitBudget(0));
      expect(r).toEqual({ merges: [], unread: true });
      // …and a budget that runs out BETWEEN the listing calls: a REFUSAL, not a kill. The first call
      // (`symbolic-ref`) reads the clock at 0 → 2 000 left → a 1 000 ms timeout, and completes (no
      // `origin` here: D15's swallow). The clock then reads 1 000 → 1 000 left → floor(1 000) − 1 000 = 0,
      // below the ≥ 1 start threshold, so `for-each-ref` is refused (`git.ts`'s `t2` branch) and the repo
      // is unread. (A 1 001 ms budget would give the FIRST call a 1 ms timeout — a second real kill.)
      let clock = 0;
      const tight = startGitBudget(2000, () => clock);
      const p = listDefaultRefMerges(repo, WINDOW_START, NOW, tight);
      clock = 1000;                                                  // after the first call's start: 1 000 ms left, the second is refused
      expect(await p).toEqual({ merges: [], unread: true });
    } finally { spy.mockRestore(); }
    expect(calls.filter((a) => a[0] === "git" && a[1] === "symbolic-ref")).toHaveLength(1);   // the tight budget's first call only
    expect(calls.some(isMergeLog)).toBe(false);
  });

  test("[TB-P29] a budget that runs out between for-each-ref and the merge log refuses the log: unread, no throw", async () => {
    // The THIRD refusal (`git.ts`'s `t3` branch). The injected clock stands at 0 for the first two reads
    // (2 000 left → 1 000 ms timeouts for `symbolic-ref` and `for-each-ref`, both started and completed),
    // and jumps to 1 000 when `for-each-ref` SPAWNS — so the read after it sees 1 000 left → 0 → refused.
    // `main` exists here, so a missing refusal would run the log and come back `unread: false` with #7.
    const repo = await initRepo("main");
    await commit(repo, "a.txt", at(0));
    await prMerge(repo, "feat/x", "x.txt", at(10), "Merge pull request #7 from owner/feat/x");
    let clock = 0;
    const { spy, calls } = spawnSpy((argv) => { if (argv[1] === "for-each-ref") clock = 1000; return undefined; });
    try {
      expect(await listDefaultRefMerges(repo, WINDOW_START, NOW, startGitBudget(2000, () => clock))).toEqual({ merges: [], unread: true });
    } finally { spy.mockRestore(); }
    expect(calls.map((a) => a[1])).toEqual(["symbolic-ref", "for-each-ref"]);                 // both started; the log never did
    expect(calls.some(isMergeLog)).toBe(false);
  });

  test("a listing that fails any other way still throws (a real non-zero exit is `exception`, not unread)", async () => {
    const repo = await initRepo("main");
    await commit(repo, "a.txt", at(0));
    const { spy } = spawnSpy((argv) => (argv[1] === "for-each-ref" ? ["sh", "-c", "exit 3"] : undefined));
    try {
      const err = await listDefaultRefMerges(repo, WINDOW_START, NOW, generous()).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(GitTimeoutError);
    } finally { spy.mockRestore(); }
  });
});

// ── mergeMembers (§4.3 item 4) ─────────────────────────────────────────────────────────────────────

describe("mergeMembers: serial rev-lists under the budget", () => {
  async function twoMerges(): Promise<{ repo: string; merges: Awaited<ReturnType<typeof listDefaultRefMerges>>["merges"]; x: string; y: string }> {
    const repo = await initRepo("main");
    await commit(repo, "a.txt", at(0));
    await prMerge(repo, "feat/x", "x.txt", at(10), "Merge pull request #7 from owner/feat/x");
    await prMerge(repo, "feat/y", "y.txt", at(20), "Merge pull request #8 from owner/feat/y");
    const x = (await git(["rev-parse", "feat/x"], repo)).trim(), y = (await git(["rev-parse", "feat/y"], repo)).trim();
    const { merges } = await listDefaultRefMerges(repo, WINDOW_START, NOW, generous());
    expect(prs({ merges }).sort()).toEqual([7, 8]);
    return { repo, merges, x, y };
  }

  test("members of each merge are `rev-list <p1>..<p2>`, keyed by merge SHA; read counts completed rev-lists", async () => {
    const { repo, merges, x, y } = await twoMerges();
    const r = await mergeMembers(repo, merges, generous());
    expect([r.read, r.timedOut]).toEqual([2, 0]);
    const by = (n: number) => r.members.get(merges.find((m) => m.pr?.number === n)!.sha);
    expect(by(7)).toEqual([x]);
    expect(by(8)).toEqual([y]);
  });

  test("[TB-P29] THE one real per-call-timeout kill: a rev-list that outlives its timeout counts in timedOut, no facts, no throw", async () => {
    // Budget 2 500 ms → per-call timeout min(30 000, 2 500 − 1 000) = 1 500 ms; the `sh` child is killed
    // at 1.5 s (exitCode null, SIGKILL — D2's classifier), the merge counts `timedOut`, and no later call is
    // expected (about 1 000 ms remain, under the start threshold). On Linux, dash FORKS `sleep` rather
    // than exec-ing it, so the kill reaches only `sh`: the `sleep` grandchild keeps the pipes open to 5 s,
    // runGit's flush race gives up after GIT_FLUSH_MS (≈ 2.0 s total), and the read is INCOMPLETE — it is
    // still a GitTimeoutError only because the classifier runs before the incomplete-read gate (pinned on
    // every platform by the `sleep 5 & kill -KILL $$` case under the GitTimeoutError describe).
    const { repo, merges } = await twoMerges();
    const { spy, calls } = spawnSpy((argv) => (isRevListRange(argv) ? ["sh", "-c", "sleep 5"] : undefined));
    const started = performance.now();
    try {
      const r = await mergeMembers(repo, merges.slice(0, 1), startGitBudget(2500));
      expect([r.read, r.timedOut, r.members.size]).toEqual([0, 1, 0]);
    } finally { spy.mockRestore(); }
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(4500);
    expect(calls.filter(isRevListRange)).toHaveLength(1);
  }, 6000);

  test("[TB-P29] a rev-list killed by its timeout counts in timedOut and the NEXT rev-list still runs (the instant kill spends no budget)", async () => {
    const { repo, merges, x } = await twoMerges();
    let first = true;
    const { spy, calls } = spawnSpy((argv) => { if (isRevListRange(argv) && first) { first = false; return KILL; } return undefined; });
    try {
      const r = await mergeMembers(repo, merges, generous());
      expect([r.read, r.timedOut, r.members.size]).toEqual([1, 1, 1]);
      // merges list newest-first (git log order): #8 was the first rev-list, the killed one; #7's members read
      expect([...r.members.values()]).toEqual([[x]]);
      expect(r.members.has(merges.find((m) => m.pr?.number === 8)!.sha)).toBe(false);
    } finally { spy.mockRestore(); }
    expect(calls.filter(isRevListRange)).toHaveLength(2);
    // …and a budget the second merge never reaches counts it in timedOut too, without a spawn
    let clock = 0;
    const tight = startGitBudget(1500, () => clock);
    const { spy: spy2, calls: calls2 } = spawnSpy(() => undefined);
    try {
      const p = mergeMembers(repo, merges, tight);
      clock = 600;                                                   // after the first rev-list started (timeout 500); 900 ms left, the second is refused
      const r = await p;
      expect([r.read, r.timedOut]).toEqual([1, 1]);
    } finally { spy2.mockRestore(); }
    expect(calls2.filter(isRevListRange)).toHaveLength(1);
  });

  test("a rev-list that exits non-zero rethrows a plain Error", async () => {
    const { repo, merges } = await twoMerges();
    const { spy } = spawnSpy((argv) => (isRevListRange(argv) ? ["sh", "-c", "exit 3"] : undefined));
    try {
      const err = await mergeMembers(repo, merges, generous()).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(GitTimeoutError);
      expect(err.message).toMatch(/^git rev-list [0-9a-f]+\.\.[0-9a-f]+ failed in /);
    } finally { spy.mockRestore(); }
  });

  test("a rev-list killed by a non-timeout signal is a plain Error too, and a merge without two parents is skipped", async () => {
    const { repo, merges } = await twoMerges();
    const { spy } = spawnSpy((argv) => (isRevListRange(argv) ? ["sh", "-c", "kill -TERM $$"] : undefined));
    try {
      const err = await mergeMembers(repo, merges, generous()).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(GitTimeoutError);
    } finally { spy.mockRestore(); }
    const r = await mergeMembers(repo, [{ ...merges[0]!, parents: [merges[0]!.parents[0]!] }], generous());
    expect(r).toEqual({ members: new Map(), read: 0, timedOut: 0 });
  });
});
