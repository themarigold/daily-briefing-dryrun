import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// test/run-record.test.ts — B1-M1-T3 (wave-2 plan): the morning run's record for the live git check,
// `<state>/run-record.json` (disagreement 1: an engine-owned path, NOT a `StatePaths` field).
//
// It holds the page's OWN commit population and attribution (disagreement 9): every window commit with its
// label and repo, and `recapCoverage`'s own `missing` list, from the code that builds the page's coverage
// line — never a re-query. Real runs here drive `run()` with an injected provider against scratch repos
// (test/latest-write-fail.test.ts's harness), in a per-test state dir.
import { test, expect, describe, beforeEach, afterEach, setSystemTime } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepo, branchCommit } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { run } from "../src/main";
import { latestBriefingPath, localDateStr, readLastRunDate, runRecordPath } from "../src/marker";
import { buildRunRecord, readRunRecord, recordCommitsFor, writeRunRecord, RUN_RECORD_MAX_BYTES, type RunRecord } from "../src/runRecord";
import type { Activity, Provider, ReducedContext } from "../src/types";
import type { Unit } from "../src/subprojects";

// A fixed noon, because the fixtures below date commits from the clock. `bun test` runs in UTC, so with the real clock
// `yesterdayISO(10)` crossed midnight for ten minutes a day, 23:50 to 24:00 UTC (15:50 to 16:00 PST): c2 and its twin then
// fell on "today", the window held c1 alone, and the delivered-run test read one commit where it expects two.
const CLOCK = new Date(2026, 6, 16, 12, 0);
beforeEach(() => { setSystemTime(CLOCK); });
afterEach(() => { setSystemTime(); });

const yesterdayISO = (min = 0) => new Date(Date.now() - 864e5 + min * 60_000).toISOString();
const NEUTRAL = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
async function git(repo: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(["git", "-C", repo, ...args], { env: { ...process.env, ...NEUTRAL, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out;
}

function withEnv(cfgObj: unknown): { stateDir: string; cleanup: () => void } {
  const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-rr-cfg-")));
  const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-rr-state-")));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify(cfgObj));
  const prevXdg = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  return {
    stateDir,
    cleanup: () => {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
    },
  };
}
function captureConsole() {
  const out: string[] = [], err: string[] = [];
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  return { out, err, restore: () => { console.log = oLog; console.error = oErr; } };
}
const PROV = { cli: "claude", argv: ["-p"], promptVia: "stdin" as const };
const FIRE = () => new Date(2026, 6, 16, 7, 20);
/** A provider whose one recap bullet cites `cited` (a SHA prefix), so the page covers that commit only. */
const citing = (cited: string): Provider => ({
  async generate() { return `## RESUME\n- [r] resume here\n## RECAP\n- [r] did x | evidence: ${cited}\n## SUGGESTIONS\n- do y`; },
});
const depsFor = (provider: Provider) => ({ provider, now: FIRE, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 });

/** main: c1 (a.txt); feat: c2 (b.txt); main: c2 cherry-picked as c2' — a PATCH TWIN, which the extractor
 *  dedupes at its return, and c1 is SHARED by both branches. Three commits in git, two in the window list. */
async function twinRepo(): Promise<{ repo: string; c1: string; c2: string; c2twin: string }> {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO(0) }]);
  const c1 = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await branchCommit(repo, "feat", "b.txt", yesterdayISO(10));
  const c2 = (await git(repo, ["rev-parse", "feat"])).trim();
  const d = yesterdayISO(20);
  await git(repo, ["cherry-pick", c2], { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
  const c2twin = (await git(repo, ["rev-parse", "HEAD"])).trim();
  return { repo, c1, c2, c2twin };
}

describe("the run writes the record after the page", () => {
  test("a delivered run writes run-record.json with the run's date, repos, window start, labels and each label's commits", async () => {
    const { repo, c1, c2, c2twin } = await twinRepo();
    const env = withEnv({ repos: [repo], provider: PROV, morningTime: "07:20" });
    const cap = captureConsole();
    try {
      expect(await run(false, depsFor(citing(c1.slice(0, 7))))).toBe(0);
      expect(existsSync(latestBriefingPath())).toBe(true);
      const day = localDateStr(new Date());
      const got = await readRunRecord(day);
      expect(got.accepted).toBe(true);
      const rec = (got as { record: RunRecord }).record;
      expect(rec.schemaVersion).toBe(1);
      expect(rec.date).toBe(day);
      expect(rec.repos).toEqual([repo]);
      expect(Number.isNaN(Date.parse(rec.windowStartUtc))).toBe(false);
      expect(Date.parse(rec.windowStartUtc)).toBeLessThanOrEqual(Date.parse(yesterdayISO(0)));
      // ONE population: the shared commit once, the twin pair once (three commits in git, two here)
      expect((await git(repo, ["rev-list", "--all"])).trim().split("\n")).toHaveLength(3);
      const shas = rec.commits.map((c) => c.sha);
      expect(shas).toHaveLength(2);
      expect(shas).toContain(c1);
      expect(shas.filter((s) => s === c2 || s === c2twin)).toHaveLength(1);
      const label = rec.commits[0]!.label;
      expect(rec.commits.every((c) => c.label === label && c.repo === repo)).toBe(true);
      expect(rec.labels[label]).toEqual({ repo, root: null });
      // `missing` is the page's own: the commit the recap did not cite
      expect(rec.missing).toEqual(shas.filter((s) => s !== c1));
      // 0600, and nothing printed about it
      expect(statSync(runRecordPath()).mode & 0o777).toBe(0o600);
      expect([...cap.out, ...cap.err].join("\n")).not.toMatch(/run-record|run record/);
    } finally { cap.restore(); env.cleanup(); }
  }, 30_000);

  test("a failed delivery write (write-fail) writes no record", async () => {
    const { repo, c1 } = await twinRepo();
    const env = withEnv({ repos: [repo], provider: PROV, morningTime: "07:20" });
    const cap = captureConsole();
    try {
      mkdirSync(latestBriefingPath(), { recursive: true });
      expect(await run(false, depsFor(citing(c1.slice(0, 7))))).toBe(1);
      expect(existsSync(runRecordPath())).toBe(false);
    } finally { cap.restore(); env.cleanup(); }
  }, 30_000);

  test("a failing record write leaves the run's exit, its output and the day's stamp as a run whose write succeeds", async () => {
    const { repo, c1 } = await twinRepo();
    const outcome = async (block: boolean) => {
      const env = withEnv({ repos: [repo], provider: PROV, morningTime: "07:20" });
      const cap = captureConsole();
      try {
        if (block) { mkdirSync(join(runRecordPath(), "occupied"), { recursive: true }); }   // a non-empty directory: the rename fails
        const code = await run(false, depsFor(citing(c1.slice(0, 7))), { json: true });
        const envelope = JSON.parse(cap.out.join("\n")) as Record<string, unknown>;
        return {
          code, stamped: await readLastRunDate(), err: cap.err.map((l) => l.split(env.stateDir).join("<state>")),
          delivered: envelope.delivered, skipReason: envelope.skipReason ?? null, exitCode: envelope.exitCode ?? null,
          markdown: typeof envelope.markdown === "string" ? (envelope.markdown as string).length : null,
          recordExists: existsSync(join(runRecordPath(), "occupied")) ? "blocked" : existsSync(runRecordPath()),
        };
      } finally { cap.restore(); env.cleanup(); }
    };
    const ok = await outcome(false), blocked = await outcome(true);
    expect(ok.recordExists).toBe(true);                               // PREMISE: the control wrote one
    expect(blocked.recordExists).toBe("blocked");                     // …and the blocked run could not
    const { recordExists: _a, ...okRest } = ok;
    const { recordExists: _b, ...blockedRest } = blocked;
    expect(blockedRest).toEqual(okRest);
    expect(ok.code).toBe(0);
  }, 60_000);
});

// ── the write itself ──────────────────────────────────────────────────────────────────────────────────

const REC: RunRecord = {
  schemaVersion: 1, date: "2026-01-12", repos: ["/r"], windowStartUtc: "2026-01-11T00:00:00.000Z",
  labels: { r: { repo: "/r", root: null } }, commits: [{ sha: "a".repeat(40), label: "r", repo: "/r" }], missing: [],
};

describe("writeRunRecord: atomic, 0600, no temp file left", () => {
  test("the temp file is 0600 before the rename, the record 0600 after, and no temp file is left", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-rr-w-")));
    const path = join(dir, "run-record.json");
    const seen: { tmpMode: number; existed: boolean }[] = [];
    await writeRunRecord(REC, path, {
      rename: async (from, to) => { seen.push({ existed: existsSync(from), tmpMode: statSync(from).mode & 0o777 }); return rename(from, to); },
    });
    expect(seen).toEqual([{ existed: true, tmpMode: 0o600 }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(REC);
    expect(readdirSync(dir)).toEqual(["run-record.json"]);
  });

  test("when ONLY the rename fails (the target is a non-empty directory), it rejects and leaves no temp file", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-rr-w-")));
    const path = join(dir, "run-record.json");
    mkdirSync(join(path, "occupied"), { recursive: true });
    const seen: boolean[] = [];
    const err = await writeRunRecord(REC, path, {
      rename: async (from, to) => { seen.push(existsSync(from)); return rename(from, to); },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(seen).toEqual([true]);                                     // the temp file WAS written: the check is not vacuous
    expect(readdirSync(dir).sort()).toEqual(["run-record.json"]);     // only the blocking directory
  });
});

describe("readRunRecord: accepted only for its own date", () => {
  const dirWith = (text: string | Uint8Array) => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-rr-r-")));
    const path = join(dir, "run-record.json");
    writeFileSync(path, text);
    return path;
  };
  test("accepted for its date; rejected for another date, missing, malformed and oversized", async () => {
    const good = dirWith(JSON.stringify(REC));
    expect(await readRunRecord("2026-01-12", good)).toEqual({ accepted: true, record: REC });
    expect(await readRunRecord("2026-01-13", good)).toEqual({ accepted: false });
    expect(await readRunRecord("2026-01-12", join(tmpdir(), "dba-no-such-dir", "run-record.json"))).toEqual({ accepted: false });
    expect(await readRunRecord("2026-01-12", dirWith("{not json"))).toEqual({ accepted: false });
    for (const bad of [
      { ...REC, schemaVersion: 2 }, { ...REC, repos: "/r" }, { ...REC, commits: [{ sha: 1, label: "r", repo: "/r" }] },
      { ...REC, labels: { r: { repo: "/r" } } }, { ...REC, missing: [7] }, { ...REC, windowStartUtc: 5 }, [REC],
    ]) expect(await readRunRecord("2026-01-12", dirWith(JSON.stringify(bad)))).toEqual({ accepted: false });
    const pad = " ".repeat(RUN_RECORD_MAX_BYTES);                     // valid JSON, one byte past the cap with the body
    expect(await readRunRecord("2026-01-12", dirWith(JSON.stringify(REC) + pad))).toEqual({ accepted: false });
    expect(RUN_RECORD_MAX_BYTES).toBe(1024 * 1024);
  });
});

// ── the two lists, from recapCoverage's own pieces ─────────────────────────────────────────────────────

const commit = (sha: string, file: string, subject = "s"): Activity => ({
  source: "git", kind: "commit", event_id: sha, repo: "/r", text: subject, timestamp: "2026-01-11T10:00:00Z",
  meta: { diffstat: [{ file, added: 1, removed: 0 }] },
});
const unit = (root: string | null, label: string, repo = "/r"): Unit => ({
  repo, root, label, hasResumptionState: false, hasWindowContent: true, resumptionNote: "", dirtyFiles: [], latestCommitTime: null,
});
const ctxOf = (...acts: Activity[]): ReducedContext => ({ repos: [{ repo: "/r", summary: "s", activities: acts }] });

describe("recordCommitsFor and buildRunRecord", () => {
  const A = "abcde12" + "0".repeat(33), B = "b0b0b0b" + "1".repeat(33), N = "c0ffee1" + "2".repeat(33);
  const T1 = "aaaaaaa" + "3".repeat(33), T2 = "aaaaaaa" + "4".repeat(33);
  test("a nested sub-project root's commit carries that sub-project's label (the full root set), and the labels map gives its root", () => {
    const units = [unit("app", "app"), unit("app/core", "core")];
    const roots = new Map([["/r", ["app", "app/core"]]]);
    const rc = recordCommitsFor(ctxOf(commit(N, "app/core/x.ts"), commit(A, "app/y.ts")), units, roots, []);
    expect(rc.commits).toEqual([{ sha: N, label: "core", repo: "/r" }, { sha: A, label: "app", repo: "/r" }]);
    const rec = buildRunRecord({ runDate: "2026-01-12", repos: ["/r"], units, windowStartUtc: "2026-01-11T00:00:00.000Z", recordCommits: rc })!;
    expect(rec.labels).toEqual({ core: { repo: "/r", root: "app/core" }, app: { repo: "/r", root: "app" } });
  });

  test("a commit whose label is labelOf's fallback (no Unit) gets root null and its own repo; every Unit label is added too", () => {
    const units = [unit("docs", "docs")];
    const rc = recordCommitsFor(ctxOf(commit(B, "src/z.ts")), units, new Map([["/r", ["docs"]]]), []);
    expect(rc.commits).toHaveLength(1);
    const fallback = rc.commits[0]!.label;
    expect(fallback).not.toBe("docs");
    const rec = buildRunRecord({ runDate: "2026-01-12", repos: ["/r"], units, windowStartUtc: "2026-01-11T00:00:00.000Z", recordCommits: rc })!;
    expect(rec.labels[fallback]).toEqual({ repo: "/r", root: null });
    expect(rec.labels.docs).toEqual({ repo: "/r", root: "docs" });
  });

  test("missing: a 5-character citation covers its commit; an ambiguous 7-character one covers neither", () => {
    const units = [unit(null, "r")];
    const recap = [{ repo: "r", text: "x", evidence: "abcde" }, { repo: "r", text: "y", evidence: "aaaaaaa" }];
    const rc = recordCommitsFor(ctxOf(commit(A, "a"), commit(T1, "b"), commit(T2, "c")), units, new Map(), recap);
    expect(rc.missing).toEqual([T1, T2]);
    expect(rc.commits.map((c) => c.sha)).toEqual([A, T1, T2]);
  });

  test("no record without the run's commit lists (every return but the generated one)", () => {
    expect(buildRunRecord({ runDate: "2026-01-12", repos: ["/r"], units: [], windowStartUtc: "2026-01-11T00:00:00.000Z" })).toBeUndefined();
  });

  test("__proto__, constructor and prototype labels round-trip with no inherited prototype", async () => {
    const labels = ["__proto__", "constructor", "prototype"];
    const rec = buildRunRecord({
      runDate: REC.date, repos: ["/r"], windowStartUtc: REC.windowStartUtc,
      units: labels.map((label) => unit(label, label)),
      recordCommits: { commits: [{ sha: A, label: "__proto__", repo: "/r" }], missing: [] },
    })!;
    expect(Object.getPrototypeOf(rec.labels)).toBeNull();
    for (const label of labels) {
      expect(Object.hasOwn(rec.labels, label)).toBe(true);
      expect(rec.labels[label]).toEqual({ repo: "/r", root: label });
    }
    const path = join(removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-rr-proto-"))), "record.json");
    await writeRunRecord(rec, path);
    const back = await readRunRecord(REC.date, path);
    expect(back.accepted).toBe(true);
    if (!back.accepted) throw new Error("record refused");
    expect(Object.keys(back.record.labels)).toEqual(labels);
    expect(Object.getPrototypeOf(back.record.labels)).toBeNull();
    expect(back.record.labels).toEqual(rec.labels);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "repo")).toBe(false);
  });
});
