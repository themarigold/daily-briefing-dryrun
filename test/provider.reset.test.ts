// test/provider.reset.test.ts — `provider reset` and the run lock for `provider reset` / `provider test`
// (provider-fallback plan P2-M1-T2; spec r9 §5 "One writer at a time", "Run lock"; hub Q16, Q22).
//
// `reset` holds the run lock (invoker `cli`) for its whole read-modify-write and refuses while a briefing holds it.
// `test` probes UNLOCKED, then takes the lock only to re-read the state, apply its outcome and write, retrying the lock
// for up to 5 s; still held, it returns the outcome with `recorded: false` and writes nothing. Each heartbeats while it
// holds the lock, capped at its own bound. The probe here is injected (the real probes are P2-M4's); the lock, the
// state files and `run()` are real, in a fresh state folder per test.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerMain, PROVIDER_RESET_BOUND_MS, PROVIDER_TEST_WRITE_BOUND_MS, TEST_LOCK_RETRY_MS, type ProviderCliDeps } from "../src/providerCli";
import { accountStatePath, PROBE_MS } from "../src/account";
import { acquireRunLock, runLockPath, lockStaleMs, HEARTBEAT_INTERVAL_MS, type LockHeld } from "../src/runlock";
import { TIMEOUT_MS } from "../src/provider";
import { lastSkipPath, latestBriefingPath, localDateStr, providerStatusPath, readLastSkip } from "../src/marker";
import { observeRun, readProviderStatus, writeProviderStatus } from "../src/providerStatus";
import { entryRevision, resolveProviderList } from "../src/providerList";
import { validateConfig } from "../src/config";
import { runCore } from "../src/core";
import { run } from "../src/main";
import { LostLockError, type Config } from "../src/types";
import { buildRepo } from "./fixtures/build-repo";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { BRIEFING, fakeCli, freshStateDir, spawnsIn, tempDir, walkDeps } from "./helpers/walk";

guardNetworkForThisFile();

let repo = "";
const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
const prevCfg = process.env.XDG_CONFIG_HOME;
beforeAll(async () => {
  repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
});
afterAll(() => {
  process.env.DAILY_BRIEFING_STATE_DIR = prevState;
  if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevCfg;
});

const LOCAL = { api: { kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9/v1" } };
const CLI = { cli: "/nonexistent/claude", argv: [], promptVia: "stdin" };
const CFG = { provider: CLI, fallbacks: [{ label: "F", ...LOCAL }], morningTime: "00:00" };

/** The config as both the saved file (`configPath()`, for `run()`) and a path to hand `providerMain`. */
function savedConfig(cfg: Record<string, unknown> = CFG): string {
  const home = tempDir("dba-reset-cfg-");
  mkdirSync(join(home, "daily-briefing"), { recursive: true });
  const p = join(home, "daily-briefing", "config.json");
  writeFileSync(p, JSON.stringify({ repos: [repo], ...cfg }));
  process.env.XDG_CONFIG_HOME = home;
  return p;
}
const revisionOf = (cfg: Record<string, unknown>, label: string): string =>
  entryRevision(resolveProviderList(validateConfig({ repos: [], ...cfg }, "/nonexistent-home"), "/nonexistent-home", {}).entries.find((e) => e.label === label)!);

const hourMark = (until = Date.now() + PROBE_MS) => ({ limitedUntil: new Date(until).toISOString(), isProbe: true, reason: "auth" });
const usageMark = () => ({ limitedUntil: new Date(Date.now() + 3 * 3600e3).toISOString(), isProbe: false, reason: "usage" });
function writeMarks(dir: string, accounts: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(accountStatePath(dir), JSON.stringify({ accounts }));
}
const marks = (dir: string): Record<string, { reason?: string }> => JSON.parse(readFileSync(accountStatePath(dir), "utf8")).accounts;

/** Fake interval timers and a hand-advanced clock, as test/run-lock.heartbeat.test.ts builds them. */
function fakeTimers(start = Date.parse("2026-10-16T07:20:00Z")) {
  let t = start;
  const live = new Map<number, { fn: () => void | Promise<void>; ms: number }>();
  let next = 1;
  return {
    timers: {
      setInterval: (fn: () => void | Promise<void>, ms: number) => {
        const id = next++;
        live.set(id, { fn, ms });
        return { id, unref() { return this; } } as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: (h: ReturnType<typeof setInterval>) => { live.delete((h as unknown as { id: number }).id); },
    },
    now: () => t,
    advance: (ms: number) => { t += ms; },
    live,
    async tick() { for (const r of [...live.values()]) await r.fn(); },
  };
}

async function cli(args: string[], deps: ProviderCliDeps = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await providerMain(args, { out: (s) => out.push(s), err: (s) => err.push(s), isTTY: false, ...deps });
  return { code, err, json: JSON.parse(out.at(-1) ?? "null") as Record<string, unknown> | null };
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const e = console.error, l = console.log;
  console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.error = e; console.log = l; }
};
/** A briefing run holding the lock right now: this process's live pid, a fresh file. */
async function holdAsRun(): Promise<LockHeld> {
  const got = await acquireRunLock({ invoker: "scheduled", timeoutMs: TIMEOUT_MS, path: runLockPath() });
  if (!got.acquired) throw new Error("expected the lock");
  return got;
}
const injectedProvider = { generate: async () => BRIEFING };

// ── provider reset ───────────────────────────────────────────────────────────────────────────────────

describe("provider reset", () => {
  test("clears the entry's marks — hour and usage alike — and only that entry's; a second reset clears nothing", async () => {
    const d = freshStateDir();
    const file = savedConfig();
    writeMarks(d, { F: usageMark(), default: hourMark() });
    const r = await cli(["reset", "--index", "1", "--json"], { configFile: file });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ schemaVersion: 1, ok: true, cleared: true });
    expect(Object.keys(marks(d))).toEqual(["default"]);
    expect((await cli(["reset", "--index", "1", "--json"], { configFile: file })).json).toEqual({ schemaVersion: 1, ok: true, cleared: false });
    expect(existsSync(runLockPath())).toBe(false);                                     // released
  });

  // A read-only folder does not stop root, so the write would succeed and the test would read a false failure.
  test.skipIf(process.getuid?.() === 0)("a marks write that fails is reported (write-failed, exit 1), never answered ok", async () => {
    const d = freshStateDir();
    const file = savedConfig();
    writeMarks(d, { F: hourMark() });
    const before = readFileSync(accountStatePath(d), "utf8");
    // A read-only state folder: the marks still READ, but the atomic write's temp file cannot be created. (The run lock
    // cannot be created either, so it is taken fail-open — the lock's own documented behaviour.)
    const { chmodSync } = await import("node:fs");
    chmodSync(d, 0o500);
    try {
      const r = await cli(["reset", "--index", "1", "--json"], { configFile: file });
      expect(r.code).toBe(1);
      expect(r.json).toMatchObject({ ok: false, code: "write-failed" });
    } finally { chmodSync(d, 0o700); }
    expect(readFileSync(accountStatePath(d), "utf8")).toBe(before);
  });

  test("refuses while a briefing holds the run lock, and leaves the marks and the holder's lock alone", async () => {
    const d = freshStateDir();
    const file = savedConfig();
    writeMarks(d, { F: hourMark() });
    const holder = await holdAsRun();
    try {
      const before = readFileSync(runLockPath(), "utf8");
      const r = await cli(["reset", "--label-stdin", "--json"], { configFile: file, readStdin: async () => JSON.stringify({ label: "F" }) });
      expect(r.code).toBe(3);
      expect(r.json).toMatchObject({ ok: false, code: "lock-held" });
      expect(String(r.json?.error)).toContain("a briefing is running — try again in a minute");
      expect(Object.keys(marks(d))).toEqual(["F"]);
      expect(readFileSync(runLockPath(), "utf8")).toBe(before);
    } finally { await holder.release(); }
  });

  test("reads stdin BEFORE taking the run lock (hub Q20)", async () => {
    freshStateDir();
    const file = savedConfig();
    let lockAtRead: boolean | undefined;
    const r = await cli(["reset", "--label-stdin", "--json"], {
      configFile: file, readStdin: async () => { lockAtRead = existsSync(runLockPath()); return JSON.stringify({ label: "F" }); },
      underLock: async () => { expect(lockAtRead).toBe(false); },
    });
    expect(r.code).toBe(0);
    expect(lockAtRead).toBe(false);
  });

  test("heartbeats while it holds the lock (invoker cli), capped at reset's own bound, and stops at release", async () => {
    freshStateDir();
    const file = savedConfig();
    const ft = fakeTimers();
    let seen = false;
    const r = await cli(["reset", "--index", "0", "--json"], {
      configFile: file, heartbeatTimers: ft.timers, heartbeatNow: ft.now,
      underLock: async () => {
        expect(JSON.parse(readFileSync(runLockPath(), "utf8")).invoker).toBe("cli");
        expect([...ft.live.values()].map((x) => x.ms)).toEqual([HEARTBEAT_INTERVAL_MS]);
        const old = new Date(Date.now() - 600_000);
        utimesSync(runLockPath(), old, old);
        await ft.tick();                                                                // within the cap: touches
        expect(Date.now() - statSync(runLockPath()).mtimeMs).toBeLessThan(60_000);
        ft.advance(PROVIDER_RESET_BOUND_MS);                                            // at the cap: stops
        utimesSync(runLockPath(), old, old);
        await ft.tick();
        expect(ft.live.size).toBe(0);
        expect(Date.now() - statSync(runLockPath()).mtimeMs).toBeGreaterThan(500_000);
        seen = true;
      },
    });
    expect(r.code).toBe(0);
    expect(seen).toBe(true);
    expect(ft.live.size).toBe(0);
  });

  test("a scheduled tick that meets reset's lock skips as `concurrent`", async () => {
    const d = freshStateDir();
    const file = savedConfig();
    writeMarks(d, { F: hourMark() });
    let tick: number | undefined;
    const r = await cli(["reset", "--index", "1", "--json"], {
      configFile: file,
      underLock: async () => { tick = await quiet(() => run(false, walkDeps({ provider: injectedProvider }))); },
    });
    expect(r.code).toBe(0);
    expect(tick).toBe(0);
    expect((await readLastSkip())?.reason).toBe("concurrent");
    expect(existsSync(latestBriefingPath())).toBe(false);
  });

  test("a takeover, a real `provider reset`, then the old holder's failing attempt: no mark is written", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-reset-walk-");
    const cfg = { provider: CLI, fallbacks: [{ label: "Last", cli: fakeCli(dir, "fail-cli", "exit 1"), argv: [], promptVia: "stdin" }] };
    const file = savedConfig(cfg);
    writeMarks(d, { default: usageMark() });                                           // item 1 benched: the walk tries Last
    const walkLock = await holdAsRun();                                                // the walk's own lock, no heartbeat
    let resetCode: number | undefined;
    // Between the walk's first attempt and its retry: the walk's lock goes stale, `provider reset` reclaims it, clears
    // item 1's usage mark and releases. The walk then fails its ownership check before anything else.
    const sleep = async () => {
      const old = new Date(Date.now() - lockStaleMs(TIMEOUT_MS) - 60_000);
      utimesSync(runLockPath(), old, old);
      resetCode = (await cli(["reset", "--index", "0", "--json"], { configFile: file })).code;
    };
    try {
      await expect(runCore(validateConfig({ repos: [repo], ...cfg }, "/nonexistent-home") as Config,
        walkDeps({ lockStillHeld: () => walkLock.stillOwns(), sleep, retryDelaysMs: [1] }))).rejects.toBeInstanceOf(LostLockError);
    } finally { await walkLock.release(); }
    expect(resetCode).toBe(0);
    expect(spawnsIn(dir).length).toBe(1);                                              // the one attempt in flight, no more
    expect(marks(d)).toEqual({});                                                      // reset's write stands; Last unmarked
    expect(existsSync(providerStatusPath())).toBe(false);
  });
});

// ── provider test: the probe unlocked, the apply locked ──────────────────────────────────────────────

/** `provider test` against a candidate file, with an injected probe and a fake clock/sleep for the lock retry. */
function testCmd(candidate: Record<string, unknown>, deps: ProviderCliDeps & { index?: number } = {}) {
  const file = join(tempDir("dba-test-cand-"), "candidate.json");
  writeFileSync(file, JSON.stringify({ repos: [repo], ...candidate }));
  return cli(["test", "--file", file, "--index", String(deps.index ?? 1), "--json"], deps);
}
const AT = "2026-10-16T08:00:00.000Z";
const at = (iso: string) => () => new Date(iso);

describe("provider test and the run lock (hub Q16)", () => {
  test("probes UNLOCKED: a scheduled briefing can start and deliver while the probe runs", async () => {
    freshStateDir();
    savedConfig();
    let tick: number | undefined, lockDuringProbe: boolean | undefined;
    const r = await testCmd(CFG, {
      probe: async () => {
        lockDuringProbe = existsSync(runLockPath());
        tick = await quiet(() => run(false, walkDeps({ provider: injectedProvider })));
        return { ok: true };
      },
    });
    expect(r.code).toBe(0);
    expect(lockDuringProbe).toBe(false);
    expect(tick).toBe(0);
    expect(existsSync(latestBriefingPath())).toBe(true);
    expect(existsSync(lastSkipPath())).toBe(false);
    expect(r.json).toMatchObject({ ok: true, passed: true, recorded: true });
  });

  test("a lock held for 2 s after the probe finishes is waited out, and the outcome is recorded", async () => {
    freshStateDir();
    let clock = 0, holder: LockHeld | undefined;
    // The clock runs through the probe (100 ms) and the lock wait; `at` must be the probe's END, before the wait (Q22).
    const AT_END = new Date(Date.parse(AT) + 100).toISOString();
    const r = await testCmd(CFG, {
      now: () => new Date(Date.parse(AT) + clock), clock: () => clock,
      probe: async () => { holder = await holdAsRun(); clock += 100; return { ok: false, reason: "auth" }; },
      sleep: async (ms) => { clock += ms; if (clock >= 2000 && holder) { await holder.release(); holder = undefined; } },
    });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, passed: false, reason: "auth", at: AT_END, recorded: true });
    expect(clock).toBeGreaterThanOrEqual(2000);
    expect(clock).toBeLessThan(TEST_LOCK_RETRY_MS);
    const rec = (await readProviderStatus())?.labels.F;
    expect(rec?.lastTest).toMatchObject({ at: AT_END, ok: false, reason: "auth", revision: revisionOf(CFG, "F") });
    expect(rec?.failingSince?.at).toBe(AT_END);
  });

  test("a lock still held past 5 s: the outcome is returned intact with recorded:false, and nothing is written", async () => {
    const d = freshStateDir();
    writeMarks(d, { F: hourMark() });
    const marksBefore = readFileSync(accountStatePath(d), "utf8");
    let clock = 0, holder: LockHeld | undefined;
    try {
      const r = await testCmd(CFG, {
        now: at(AT), clock: () => clock,
        probe: async () => { holder = await holdAsRun(); return { ok: true }; },
        sleep: async (ms) => { clock += ms; },
      });
      expect(r.code).toBe(0);
      expect(r.json).toEqual({ schemaVersion: 1, ok: true, passed: true, at: AT, recorded: false, notRecorded: "lock-held" });   // the cause: P2-M4-T2
      expect(clock).toBeGreaterThanOrEqual(TEST_LOCK_RETRY_MS);
      expect(existsSync(providerStatusPath())).toBe(false);
      expect(readFileSync(accountStatePath(d), "utf8")).toBe(marksBefore);
      expect(JSON.parse(readFileSync(runLockPath(), "utf8")).invoker).toBe("scheduled");    // the holder's, untouched
    } finally { await holder?.release(); }
  });

  test("heartbeats while it holds the lock for the apply, capped at the write's bound", async () => {
    freshStateDir();
    const ft = fakeTimers();
    let seen = false;
    const r = await testCmd(CFG, {
      heartbeatTimers: ft.timers, heartbeatNow: ft.now,
      probe: async () => { expect(ft.live.size).toBe(0); return { ok: true }; },     // nothing beats during the probe
      underLock: async () => {
        expect(JSON.parse(readFileSync(runLockPath(), "utf8")).invoker).toBe("cli");
        expect([...ft.live.values()].map((x) => x.ms)).toEqual([HEARTBEAT_INTERVAL_MS]);
        const old = new Date(Date.now() - 600_000);
        utimesSync(runLockPath(), old, old);
        await ft.tick();
        expect(Date.now() - statSync(runLockPath()).mtimeMs).toBeLessThan(60_000);
        ft.advance(PROVIDER_TEST_WRITE_BOUND_MS);
        await ft.tick();
        expect(ft.live.size).toBe(0);
        seen = true;
      },
    });
    expect(r.code).toBe(0);
    expect(seen).toBe(true);
    expect(existsSync(runLockPath())).toBe(false);
  });

  test("a lock lost between taking it and writing: reset refuses and test records nothing (ownership re-checked)", async () => {
    const d = freshStateDir();
    const file = savedConfig();
    writeMarks(d, { F: hourMark() });
    const marksBefore = readFileSync(accountStatePath(d), "utf8");
    const successor = JSON.stringify({ pid: process.pid, startedIso: new Date().toISOString(), invoker: "scheduled", nonce: "the-successor" });
    const takeover = async () => { writeFileSync(runLockPath(), successor); };
    const r = await cli(["reset", "--index", "1", "--json"], { configFile: file, underLock: takeover });
    expect(r.json).toMatchObject({ ok: false, code: "lock-held" });
    expect(readFileSync(accountStatePath(d), "utf8")).toBe(marksBefore);
    expect(readFileSync(runLockPath(), "utf8")).toBe(successor);                         // the successor's lock kept
    unlinkSync(runLockPath());                                                         // the successor finished
    const t = await testCmd(CFG, { probe: async () => ({ ok: true }), underLock: takeover });
    expect(t.json).toMatchObject({ passed: true, recorded: false, notRecorded: "lock-held" });
    expect(existsSync(providerStatusPath())).toBe(false);
    expect(readFileSync(accountStatePath(d), "utf8")).toBe(marksBefore);
  });

  test("a lock lost BETWEEN the apply's two writes: the status stays written, the mark is left (ownership re-checked per write)", async () => {
    const d = freshStateDir();
    writeMarks(d, { F: hourMark(Date.now() - 60_000 + PROBE_MS) });
    const marksBefore = readFileSync(accountStatePath(d), "utf8");
    const successor = JSON.stringify({ pid: process.pid, startedIso: new Date().toISOString(), invoker: "scheduled", nonce: "the-successor" });
    let tookOver = false;
    const t = await testCmd(CFG, {
      probe: async () => ({ ok: true }),
      afterStatusWrite: async () => { writeFileSync(runLockPath(), successor); tookOver = true; },
    });
    expect(tookOver).toBe(true);
    expect(t.json).toMatchObject({ passed: true, recorded: true });
    expect((await readProviderStatus())!.labels.F!.lastTest).toMatchObject({ ok: true });  // the first write landed
    expect(readFileSync(accountStatePath(d), "utf8")).toBe(marksBefore);                 // the second never ran
    expect(readFileSync(runLockPath(), "utf8")).toBe(successor);                         // the successor's lock kept
    unlinkSync(runLockPath());
  });

  test("control: with the lock kept between the two writes, the same pass clears the mark", async () => {
    const d = freshStateDir();
    writeMarks(d, { F: hourMark(Date.now() - 60_000 + PROBE_MS) });
    let hooked = false;
    const t = await testCmd(CFG, { probe: async () => ({ ok: true }), afterStatusWrite: async () => { hooked = true; } });
    expect(hooked).toBe(true);
    expect(t.json).toMatchObject({ passed: true, recorded: true });
    expect(marks(d)).toEqual({});
  });

  test("a scheduled tick that meets the apply's lock skips as `concurrent`", async () => {
    freshStateDir();
    savedConfig();
    let tick: number | undefined;
    const r = await testCmd(CFG, {
      probe: async () => ({ ok: true }),
      underLock: async () => { tick = await quiet(() => run(false, walkDeps({ provider: injectedProvider }))); },
    });
    expect(r.json).toMatchObject({ recorded: true });
    expect(tick).toBe(0);
    expect((await readLastSkip())?.reason).toBe("concurrent");
  });
});

describe("applying a Test outcome after a concurrent walk (re-read, then apply; hub Q22)", () => {
  const T_TEST = "2026-10-16T08:00:00.000Z";       // the Test's probe finished here
  const T_WALK = "2026-10-16T08:00:05.000Z";       // a walk recorded a failure afterwards
  const today = localDateStr(new Date(T_TEST));
  /** The walk's footprint, written while the Test waited for the lock: a failed lastRun, the latch, an hour mark. */
  async function walkWrites(d: string, revision: string, extra: Record<string, unknown> = {}): Promise<void> {
    const rec = observeRun(undefined, { at: T_WALK, revision, ok: false, reason: "auth" });
    rec.quickCheck = { localDate: today, revision };
    await writeProviderStatus({ labels: { F: rec } });
    writeMarks(d, { F: hourMark(Date.parse(T_WALK) + PROBE_MS), ...extra });
  }
  /** The probe takes the lock as the walk would; the walk writes and releases during the Test's lock retry. */
  function concurrentWalk(d: string, revision: string, extra?: Record<string, unknown>) {
    let holder: LockHeld | undefined, clock = 0;
    return {
      now: at(T_TEST), clock: () => clock,
      probe: async () => { holder = await holdAsRun(); return { ok: true }; },
      sleep: async (ms: number) => {
        clock += ms;
        if (holder) { await walkWrites(d, revision, extra); await holder.release(); holder = undefined; }
      },
    } satisfies ProviderCliDeps;
  }

  test("a pass applied after a newer walk failure keeps the walk's write: mark, latch, lastRun, failingSince at the walk's failure", async () => {
    const d = freshStateDir();
    const rev = revisionOf(CFG, "F");
    const r = await testCmd(CFG, concurrentWalk(d, rev));
    expect(r.json).toMatchObject({ passed: true, recorded: true });
    const rec = (await readProviderStatus())!.labels.F!;
    expect(rec.lastRun).toMatchObject({ at: T_WALK, ok: false });
    expect(rec.lastTest).toMatchObject({ at: T_TEST, ok: true });
    expect(rec.quickCheck).toEqual({ localDate: today, revision: rev });
    expect(rec.failingSince).toEqual({ at: T_WALK, revision: rev });
    expect(Object.keys(marks(d))).toEqual(["F"]);
  });

  test("control: a pass with no newer failure clears the hour mark and the latch, and never a usage mark", async () => {
    const d = freshStateDir();
    const rev = revisionOf(CFG, "F");
    const before = observeRun(undefined, { at: "2026-10-16T07:00:00.000Z", revision: rev, ok: false, reason: "auth" });
    before.quickCheck = { localDate: today, revision: rev };
    await writeProviderStatus({ labels: { F: before } });
    writeMarks(d, { F: hourMark(Date.parse("2026-10-16T07:00:00.000Z") + PROBE_MS), default: usageMark() });
    const r = await testCmd(CFG, { now: at(T_TEST), probe: async () => ({ ok: true }) });
    expect(r.json).toMatchObject({ passed: true, recorded: true });
    const rec = (await readProviderStatus())!.labels.F!;
    expect(rec.quickCheck).toBeUndefined();
    expect(rec.failingSince).toBeUndefined();
    expect(Object.keys(marks(d))).toEqual(["default"]);
    // a usage mark on the tested label itself is never cleared by a pass — even one written before the Test's `at`
    writeMarks(d, { F: { limitedUntil: "2026-10-16T08:20:00.000Z", isProbe: false, reason: "usage" } });
    await testCmd(CFG, { now: at("2026-10-16T08:10:00.000Z"), probe: async () => ({ ok: true }) });
    expect(marks(d).F?.reason).toBe("usage");
  });

  test("a pass never clears an older hour mark when the status holds a failure newer than the Test's `at`", async () => {
    const d = freshStateDir();
    // The mark is from 07:00; a walk failure at T_WALK (a reason that writes no mark) is newer than the Test.
    await writeProviderStatus({ labels: { F: observeRun(undefined, { at: T_WALK, revision: "any-older-revision", ok: false, reason: "auth" }) } });
    writeMarks(d, { F: hourMark(Date.parse("2026-10-16T07:00:00.000Z") + PROBE_MS) });
    const r = await testCmd(CFG, { now: at(T_TEST), probe: async () => ({ ok: true }) });
    expect(r.json).toMatchObject({ passed: true, recorded: true });
    expect(Object.keys(marks(d))).toEqual(["F"]);
  });

  test("a pass never clears an hour mark written after the Test's `at`, even with no newer failure in the status", async () => {
    const d = freshStateDir();
    writeMarks(d, { F: hourMark(Date.parse(T_WALK) + PROBE_MS) });            // the mark is itself a newer failure
    const r = await testCmd(CFG, { now: at(T_TEST), probe: async () => ({ ok: true }) });
    expect(r.json).toMatchObject({ passed: true, recorded: true });
    expect(Object.keys(marks(d))).toEqual(["F"]);
  });

  test("a candidate-revision pass clears neither a saved-revision latch nor a mark under a newer saved-revision failure", async () => {
    const d = freshStateDir();
    const saved = revisionOf(CFG, "F");
    const candidate = { ...CFG, fallbacks: [{ label: "F", ...LOCAL, timeoutMs: 45_000 }] };
    expect(revisionOf(candidate, "F")).not.toBe(saved);
    const r = await testCmd(candidate, concurrentWalk(d, saved));
    expect(r.json).toMatchObject({ passed: true, recorded: true });
    const rec = (await readProviderStatus())!.labels.F!;
    expect(rec.quickCheck).toEqual({ localDate: today, revision: saved });
    expect(Object.keys(marks(d))).toEqual(["F"]);
  });

  test("a candidate-revision pass with no newer failure: the mark clears (any revision), the saved-revision latch does not", async () => {
    const d = freshStateDir();
    const saved = revisionOf(CFG, "F");
    const before = observeRun(undefined, { at: "2026-10-16T07:00:00.000Z", revision: saved, ok: false, reason: "auth" });
    before.quickCheck = { localDate: today, revision: saved };
    await writeProviderStatus({ labels: { F: before } });
    writeMarks(d, { F: hourMark(Date.parse("2026-10-16T07:00:00.000Z") + PROBE_MS) });
    const candidate = { ...CFG, fallbacks: [{ label: "F", ...LOCAL, timeoutMs: 45_000 }] };
    await testCmd(candidate, { now: at(T_TEST), probe: async () => ({ ok: true }) });
    expect((await readProviderStatus())!.labels.F!.quickCheck).toEqual({ localDate: today, revision: saved });
    expect(marks(d)).toEqual({});
  });
});
