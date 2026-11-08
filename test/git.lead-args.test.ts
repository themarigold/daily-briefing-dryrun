// test/git.lead-args.test.ts — B1-M1-T1 (wave-2 plan): one optional `opts` on `listDefaultRefMerges` and
// `mergeMembers`, `windowArgs`' optional probe timeout, and the extractions `defaultRefs`,
// `partialCloneFrom` and `shownBranch`.
//
// THE MORNING'S ARGV IS PINNED BY LITERALS CAPTURED ON THE BASE (plan B1-M1-T1, round 5 LOW): the
// `MORNING_SPAWNS` and `MORNING_TRACE` constants below were recorded by running this file against the
// base tree (8ed74e9ea, before `src/git.ts` changed) and pasted here as string literals. The new code's
// spawns and trace are compared against them, never against a trace of the new code itself. There is no
// `runGit` injection seam, so the records are (1) a pass-through `spyOn(Bun, "spawn")`, which sees every
// argv element (global options included) and the per-call `timeout`, and (2) `GIT_TRACE`, git's own
// record of the command it ran, taken in a child process (fixtures/lead-args-child.ts). The trace drops
// global options such as `--no-optional-locks` (measured on git 2.50.1), so the lead is checked through
// the spy.
//
// The module is imported as a namespace so the file LOADS on the base: there the new names are
// `undefined` and their tests fail on that, while the morning-argv test runs and is the capture.
import { test, expect, describe, beforeAll, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import * as G from "../src/git";
import type { GitBudget } from "../src/git";
import * as RC from "../src/recapCampaigns";
import { REDACTION } from "../src/transcripts/credentials";

const realSpawn = Bun.spawn;
type SpawnArgs = Parameters<typeof Bun.spawn>;
const NEUTRAL_GIT = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
async function git(args: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const p = realSpawn(["git", ...args], { cwd, env: { ...process.env, ...NEUTRAL_GIT, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${err}`);
  return out;
}
const tmp = (label: string) => removeAtRunEnd(mkdtempSync(join(tmpdir(), `dba-lead-${label}-`)));

// Fixed dates, so the window argument and the fixture are the same on every run.
const WINDOW_START = new Date("2026-01-11T00:00:00.000Z");
const NOW = new Date("2026-01-12T00:00:00.000Z");
const dated = (iso: string) => ({ GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });

let work = "";
beforeAll(async () => {
  // origin: trunk with one PR merge; work: a clone, so origin/HEAD → origin/trunk.
  const origin = tmp("origin");
  await git(["init", "-q", "-b", "trunk"], origin);
  await git(["config", "user.name", "Test"], origin);
  await git(["config", "user.email", "test@example.com"], origin);
  writeFileSync(join(origin, "a.txt"), "a\n");
  await git(["add", "."], origin);
  await git(["commit", "-q", "-m", "add a"], origin, dated("2026-01-11T10:00:00Z"));
  await git(["checkout", "-q", "-b", "feat"], origin);
  writeFileSync(join(origin, "b.txt"), "b\n");
  await git(["add", "."], origin);
  await git(["commit", "-q", "-m", "add b"], origin, dated("2026-01-11T10:10:00Z"));
  await git(["checkout", "-q", "trunk"], origin);
  await git(["merge", "-q", "--no-ff", "-m", "Merge pull request #5 from me/feat", "feat"], origin, dated("2026-01-11T10:20:00Z"));
  work = tmp("work");
  await git(["clone", "-q", origin, work], process.cwd());
});

/** A budget that hands out the given per-call timeouts in order (then `undefined`). */
function seqBudget(vals: number[]): GitBudget {
  let i = 0;
  return { remainingMs: () => 60_000, callTimeoutMs: () => vals[i++] };
}

type Spawn = { argv: string[]; timeout: number | undefined };
/** A pass-through spy recording every git spawn's argv (40-hex object names normalised) and timeout. */
function recordSpawns() {
  const calls: Spawn[] = [];
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: SpawnArgs[0], opts: SpawnArgs[1]) => {
    const argv = cmd as string[];
    if (argv[0] === "git") {
      calls.push({ argv: argv.map((a) => a.replace(/[0-9a-f]{40}/g, "<sha>")), timeout: (opts as { timeout?: number } | undefined)?.timeout });
    }
    return realSpawn(cmd as any, opts as any);
  }) as typeof Bun.spawn);
  return { calls, spy };
}

/** The `trace: built-in:` lines GIT_TRACE wrote while a CHILD process made the morning's calls
 *  (test/fixtures/lead-args-child.ts says why a child), object names normalised. */
async function tracedChild(): Promise<{ result: { prs: (number | null)[]; read: number }; trace: string[] }> {
  const file = join(tmp("trace"), "trace.txt");
  const child = realSpawn([process.execPath, join(import.meta.dir, "fixtures", "lead-args-child.ts"), work, WINDOW_START.toISOString(), NOW.toISOString()], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, GIT_TRACE: file }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  if (child.exitCode !== 0) throw new Error(`lead-args-child failed: ${err}`);
  const trace = readFileSync(file, "utf8").split("\n").map((l) => /trace: built-in: (.*)$/.exec(l)?.[1])
    .filter((l): l is string => l !== undefined).map((l) => l.replace(/[0-9a-f]{40}/g, "<sha>"));
  return { result: JSON.parse(out), trace };
}

/** The morning's calls, exactly as recapCampaignsPhase makes them: no `opts`. */
async function morning() {
  const r = await G.listDefaultRefMerges(work, WINDOW_START, NOW, seqBudget([7001, 7002, 7003]));
  const m = await G.mergeMembers(work, r.merges, seqBudget([7004]));
  return { r, m };
}

// ── captured on the base (8ed74e9ea) — see the header ───────────────────────────────────────────────
const MORNING_SPAWNS: Spawn[] = [
  { argv: ["git", "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], timeout: 7001 },
  {
    argv: ["git", "for-each-ref", "--format=%(refname)", "refs/heads/main", "refs/remotes/origin/main", "refs/heads/master",
      "refs/remotes/origin/master", "refs/heads/trunk", "refs/remotes/origin/trunk"],
    timeout: 7002,
  },
  { argv: ["git", "--version"], timeout: 30000 },
  {
    argv: ["git", "log", "--no-show-signature", "--first-parent", "--merges", "--since-as-filter=2026-01-09T00:00:00.000Z",
      "--format=%H%x1f%P%x1f%cI%x1f%s", "refs/heads/trunk", "refs/remotes/origin/trunk"],
    timeout: 7003,
  },
  { argv: ["git", "rev-list", "<sha>..<sha>"], timeout: 7004 },
];
const MORNING_TRACE: string[] = [
  "git symbolic-ref -q --short refs/remotes/origin/HEAD",
  "git for-each-ref '--format=%(refname)' refs/heads/main refs/remotes/origin/main refs/heads/master refs/remotes/origin/master refs/heads/trunk refs/remotes/origin/trunk",
  "git version",
  "git log --no-show-signature --first-parent --merges --since-as-filter=2026-01-09T00:00:00.000Z '--format=%H%x1f%P%x1f%cI%x1f%s' refs/heads/trunk refs/remotes/origin/trunk",
  "git rev-list <sha>..<sha>",
];

describe("the morning's argv is unchanged (no opts)", () => {
  test("listDefaultRefMerges, its windowArgs probe and mergeMembers spawn exactly the base's argv and timeouts", async () => {
    // Uncached, so the probe is part of the record (on the base, where the reset does not exist, this file
    // ran alone in a fresh process and this is the first git.ts call, so the probe was recorded there too).
    (G as { resetWindowArgsCacheForTests?: () => void }).resetWindowArgsCacheForTests?.();
    const { calls, spy } = recordSpawns();
    let out: Awaited<ReturnType<typeof morning>>;
    try { out = await morning(); } finally { spy.mockRestore(); }
    expect(out!.r.merges.map((x) => x.pr?.number)).toEqual([5]);   // PREMISE: the fixture's merge was read
    expect(out!.m.read).toBe(1);
    expect(calls).toEqual(MORNING_SPAWNS);
  });

  test("git's own GIT_TRACE of the same calls is the base's, line for line", async () => {
    const { result, trace } = await tracedChild();
    expect(result).toEqual({ prs: [5], read: 1 });                  // PREMISE: the child read the fixture
    expect(trace).toEqual(MORNING_TRACE);
  });
});

describe("opts.lead", () => {
  test("every call of the two carries the lead first; the probe gets none; the answers are the morning's", async () => {
    const base = await morning();
    const lead = ["--no-optional-locks"];
    const { calls, spy } = recordSpawns();
    let r: Awaited<ReturnType<typeof G.listDefaultRefMerges>>, m: Awaited<ReturnType<typeof G.mergeMembers>>;
    try {
      r = await (G.listDefaultRefMerges as any)(work, WINDOW_START, NOW, seqBudget([7001, 7002, 7003, 7004, 7005]), { lead });
      m = await (G.mergeMembers as any)(work, r.merges, seqBudget([7006]), { lead });
    } finally { spy.mockRestore(); }
    const repoCalls = calls.filter((c) => !(c.argv.length === 2 && c.argv[1] === "--version"));
    expect(repoCalls.length).toBe(4);                                // symbolic-ref, for-each-ref, log, rev-list
    for (const c of repoCalls) expect(c.argv.slice(0, 2)).toEqual(["git", "--no-optional-locks"]);
    // with the lead stripped, the argv is the morning's
    expect(repoCalls.map((c) => [c.argv[0], ...c.argv.slice(2)])).toEqual(
      MORNING_SPAWNS.filter((c) => c.argv[1] !== "--version").map((c) => c.argv));
    expect(r!).toEqual(base.r);
    expect(m!).toEqual(base.m);
  });

  test("with opts, the merge walk's timeout (t3) is taken AFTER the awaited probe, which gets the budget's timeout", async () => {
    G.resetWindowArgsCacheForTests();
    const { calls, spy } = recordSpawns();
    try {
      await G.listDefaultRefMerges(work, WINDOW_START, NOW, seqBudget([8001, 8002, 8003, 8004, 8005]), { lead: [] });
    } finally { spy.mockRestore(); }
    expect(calls.map((c) => [c.argv[1], c.timeout])).toEqual([
      ["symbolic-ref", 8001], ["for-each-ref", 8002], ["--version", 8004], ["log", 8005],
    ]);
  });

  test("with opts and the budget spent at the probe, the probe is skipped and the walk does not start", async () => {
    G.resetWindowArgsCacheForTests();
    const { calls, spy } = recordSpawns();
    let r: Awaited<ReturnType<typeof G.listDefaultRefMerges>>;
    try {
      // t1, t2, the first t3 check — then nothing left for the probe nor the recomputed t3
      r = await G.listDefaultRefMerges(work, WINDOW_START, NOW, seqBudget([8001, 8002, 8003]), { lead: [] });
    } finally { spy.mockRestore(); }
    expect(r!).toEqual({ merges: [], unread: true });
    expect(calls.map((c) => c.argv[1])).toEqual(["symbolic-ref", "for-each-ref"]);
  });
});

describe("windowArgs' probe (uncached)", () => {
  const T = WINDOW_START.getTime();
  test("probe.timeoutMs is the --version spawn's timeout; with no probe it is today's 30 s; undefined skips it and caches nothing", async () => {
    G.resetWindowArgsCacheForTests();
    let rec = recordSpawns();
    try { await G.windowArgs(T, { timeoutMs: 300 }); } finally { rec.spy.mockRestore(); }
    expect(rec.calls).toEqual([{ argv: ["git", "--version"], timeout: 300 }]);

    G.resetWindowArgsCacheForTests();
    rec = recordSpawns();
    try { await G.windowArgs(T); } finally { rec.spy.mockRestore(); }
    expect(rec.calls).toEqual([{ argv: ["git", "--version"], timeout: G.GIT_TIMEOUT_MS }]);
    expect(G.GIT_TIMEOUT_MS).toBe(30_000);

    G.resetWindowArgsCacheForTests();
    rec = recordSpawns();
    let skipped: string[] = ["x"];
    try {
      skipped = await G.windowArgs(T, { timeoutMs: undefined });
      expect(rec.calls).toEqual([]);                                 // no --version spawn
      expect(skipped).toEqual([]);                                   // no window filter: the JS filter is authoritative
      await G.windowArgs(T, { timeoutMs: 300 });                     // the cache stayed unset: this one probes
    } finally { rec.spy.mockRestore(); }
    expect(rec.calls.map((c) => c.timeout)).toEqual([300]);
  });

  test("a probe that outlives its timeout returns [] quickly and caches 'unsupported', so the next call spawns nothing", async () => {
    // A `git` that sleeps 10 s on `--version`: substituted through the spy, because a `PATH` edit made
    // after start-up never reaches a spawned child (Bun spawns with its start-up environment, measured
    // on bun 1.3.14). `exec`, so the timeout's SIGKILL takes the sleeper itself and no grandchild holds
    // the pipes.
    G.resetWindowArgsCacheForTests();
    const calls: string[][] = [];
    const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: SpawnArgs[0], opts: SpawnArgs[1]) => {
      const argv = cmd as string[];
      calls.push(argv);
      const slow = argv[0] === "git" && argv[1] === "--version" ? ["sh", "-c", "exec sleep 10"] : argv;
      return realSpawn(slow as any, opts as any);
    }) as typeof Bun.spawn);
    try {
      const t0 = performance.now();
      expect(await G.windowArgs(WINDOW_START.getTime(), { timeoutMs: 300 })).toEqual([]);
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(calls.length).toBe(1);                                  // PREMISE: the probe ran (and was the slow one)
      expect(await G.windowArgs(WINDOW_START.getTime(), { timeoutMs: 300 })).toEqual([]);
      expect(calls.length).toBe(1);                                  // cached "unsupported": nothing spawned
    } finally {
      spy.mockRestore();
      G.resetWindowArgsCacheForTests();
    }
  });
});

describe("partialCloneFrom: isPartialClone's decision, moved out", () => {
  test("the raw outputs decide as isPartialClone decides", () => {
    const f = G.partialCloneFrom;
    expect(f("", "", "")).toBe(false);
    expect(f("extensions.partialclone origin\n", "", "")).toBe(true);
    expect(f("extensions.partialclone origin\nextensions.partialclone \n", "", "")).toBe(false);   // last value empty
    expect(f("extensions.partialclone \nextensions.partialclone origin\n", "", "")).toBe(true);
    expect(f("", "remote.origin.promisor true\n", "")).toBe(true);
    expect(f("", "remote.origin.promisor false\n", "")).toBe(false);
    expect(f("", "remote.origin.promisor true\nremote.origin.promisor false\n", "")).toBe(true);      // ANY true
    expect(f("", "", "remote.origin.partialclonefilter blob:none\n")).toBe(true);
    expect(f("", "", "remote.origin.partialclonefilter\n")).toBe(true);                               // ANY entry, empty included
  });

  test("on real repos, isPartialClone equals partialCloneFrom over the same three reads", async () => {
    const mk = async () => {
      const d = tmp("pc");
      await git(["init", "-q", "-b", "main"], d);
      return d;
    };
    const [plain, promisor, ext, falsy, filter] = await Promise.all([0, 1, 2, 3, 4].map(mk));
    await git(["config", "remote.origin.promisor", "true"], promisor!);
    await git(["config", "extensions.partialClone", "origin"], ext!);
    await git(["config", "remote.origin.promisor", "false"], falsy!);
    await git(["config", "remote.origin.partialclonefilter", "blob:none"], filter!);
    const read = (repo: string, args: string[]) => G.runGit(args, repo, 2000).catch(() => "");
    for (const [repo, want] of [[plain, false], [promisor, true], [ext, true], [falsy, false], [filter, true]] as const) {
      const ext3 = await read(repo!, ["config", "--local", "--get-regexp", "^extensions\\.partialclone$"]);
      const pro3 = await read(repo!, ["config", "--type=bool", "--get-regexp", "^remote\\..+\\.promisor$"]);
      const fil3 = await read(repo!, ["config", "--get-regexp", "^remote\\..+\\.partialclonefilter$"]);
      expect({ repo, from: G.partialCloneFrom(ext3, pro3, fil3) }).toEqual({ repo, from: want });
      expect({ repo, is: await G.isPartialClone(repo!) }).toEqual({ repo, is: want });
    }
  });
});

describe("shownBranch: moved beside branchWords, exported, unchanged", () => {
  test("verbatim unless branchWords redacts it, then all of it", () => {
    expect(RC.shownBranch("feat/x")).toBe("feat/x");
    expect(RC.shownBranch("-n")).toBe("-n");
    const cred = "ghp_" + "a".repeat(36);
    expect(RC.branchWords(`feat/${cred}`)).toBe(REDACTION);           // PREMISE: branchWords redacts it
    expect(RC.shownBranch(`feat/${cred}`)).toBe(REDACTION);
  });
});
