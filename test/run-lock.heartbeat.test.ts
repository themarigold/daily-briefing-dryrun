// test/run-lock.heartbeat.test.ts — the capped `utimes` heartbeat on the run lock (provider-fallback plan
// P1-M4-T2; spec r9 §5 Run lock).
//
// A walk over several entries can outlast `lockStaleMs`, so a holder that still owns its lock touches it every
// 30 s, up to a cap derived from the list. Driven through the interval and clock seams: no test here waits 30 s,
// and every timer is either fake or real-but-unref'd and cleared before the test ends (plan risk 4).
import "./fixtures/isolate-state";
import { test, expect, describe, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import {
  acquireRunLock, lockStaleMs, heartbeatCapMs, earlierEntryTermMs, lastEntryTermMs,
  HEARTBEAT_INTERVAL_MS, HEARTBEAT_MARGIN_MS, MAX_PROVIDER_ATTEMPTS, type LockHeld, type LockInfo,
} from "../src/runlock";
import { TIMEOUT_MS, KILL_GRACE_MS } from "../src/provider";
import { PROVIDER_RETRY_DELAYS_MS } from "../src/core";
import { NET_DEFAULT_GRACE_MS, NET_PER_PROBE_MS } from "../src/net";
import { KEY_COMMAND_TIMEOUT_MS } from "../src/apiKey";
import { CALENDAR_STEP_WORST_MS } from "../src/calendar/bounds";
import { recapPhaseBoundMs } from "../src/recapBudget";
import { attemptBoundMs, cliAttemptBoundMs, apiAttemptBoundMs } from "../src/attemptBounds";

/** Fake interval timers and a clock the test advances by hand. `tick()` runs every live interval once and
 *  awaits it (the heartbeat's touch is async). */
function fakeTimers(start = Date.parse("2026-10-16T07:20:00Z")) {
  let t = start;
  const live = new Map<number, { fn: () => void | Promise<void>; ms: number; unrefd: boolean }>();
  let next = 1;
  const timers = {
    setInterval: (fn: () => void | Promise<void>, ms: number) => {
      const id = next++;
      const rec = { fn, ms, unrefd: false };
      live.set(id, rec);
      return { id, unref() { rec.unrefd = true; return this; } } as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: (h: ReturnType<typeof setInterval>) => { live.delete((h as unknown as { id: number }).id); },
  };
  return {
    timers,
    now: () => t,
    advance: (ms: number) => { t += ms; },
    live,
    async tick() { for (const r of [...live.values()]) await r.fn(); },
  };
}

function lockDir(): string { return removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-hb-"))); }

async function take(path: string, ft: ReturnType<typeof fakeTimers> | undefined, capMs?: number): Promise<LockHeld> {
  const got = await acquireRunLock({
    invoker: "scheduled", timeoutMs: TIMEOUT_MS, path,
    ...(capMs !== undefined ? { heartbeatCapMs: capMs } : {}),
    ...(ft ? { heartbeatTimers: ft.timers, heartbeatNow: ft.now } : {}),
  });
  if (!got.acquired) throw new Error("expected the lock");
  return got;
}

const age = (path: string, ms: number) => { const old = new Date(Date.now() - ms); utimesSync(path, old, old); };

describe("the heartbeat", () => {
  test("ticks every 30 s, unref'd; a touch changes ONLY the mtime — contents and inode identical", async () => {
    const ft = fakeTimers();
    const path = join(lockDir(), "run.lock");
    const held = await take(path, ft, 10 * 60_000);
    expect([...ft.live.values()].map((r) => [r.ms, r.unrefd])).toEqual([[HEARTBEAT_INTERVAL_MS, true]]);
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
    const before = statSync(path), body = readFileSync(path, "utf8");
    age(path, 400_000);
    const aged = statSync(path);
    // READ-ONLY for the tick (P1-M4 checkpoint MED): a `utimes` with explicit times succeeds on an owned 0400 file,
    // while ANY rewrite — same bytes, or truncate-and-write — fails EACCES, so only a metadata-only touch passes.
    chmodSync(path, 0o400);
    ft.advance(HEARTBEAT_INTERVAL_MS);
    try { await ft.tick(); } finally { chmodSync(path, 0o600); }
    const after = statSync(path);
    expect(after.mtimeMs).toBeGreaterThan(aged.mtimeMs + 300_000);   // refreshed to "now"
    expect(after.ino).toBe(before.ino);
    expect(readFileSync(path, "utf8")).toBe(body);
    await held.release();
  });

  test("a contender reading around a touch never reclaims the live holder's lock", async () => {
    const ft = fakeTimers();
    const path = join(lockDir(), "run.lock");
    const held = await take(path, ft, 10 * 60_000);
    // Past the staleness bound — a contender would reclaim it — until the heartbeat touches it.
    age(path, lockStaleMs(TIMEOUT_MS) + 5_000);
    const [contender] = await Promise.all([
      (async () => { await ft.tick(); return acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS, path }); })(),
    ]);
    expect(contender.acquired).toBe(false);
    // And a contender racing the touch itself never sees a partial file: the contents are never rewritten.
    const racing = await Promise.all([ft.tick(), acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS, path }), ft.tick()]);
    expect(racing[1].acquired).toBe(false);
    expect((JSON.parse(readFileSync(path, "utf8")) as LockInfo).invoker).toBe("scheduled");
    await held.release();
  });

  test("a stuck holder past its cap stops touching and becomes evictable", async () => {
    const ft = fakeTimers();
    const path = join(lockDir(), "run.lock");
    const cap = 5 * 60_000;
    const held = await take(path, ft, cap);
    ft.advance(cap + 1);
    age(path, lockStaleMs(TIMEOUT_MS) + 5_000);
    const aged = statSync(path).mtimeMs;
    await ft.tick();
    expect(statSync(path).mtimeMs).toBe(aged);      // no touch past the cap…
    expect(ft.live.size).toBe(0);                   // …and the interval is gone
    const contender = await acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS, path });
    expect(contender.acquired).toBe(true);          // the live-but-stuck holder is evicted by staleness
    if (contender.acquired) { expect(contender.owned).toBe("reclaimed"); await contender.release(); }
    await held.release();
  });

  test("no touch once stillOwns is false: a successor's lock is never refreshed", async () => {
    const ft = fakeTimers();
    const path = join(lockDir(), "run.lock");
    const held = await take(path, ft, 10 * 60_000);
    const mine = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    rmSync(path);
    writeFileSync(path, JSON.stringify({ ...mine, invoker: "successor", nonce: "successor-nonce" }));
    age(path, 400_000);
    const aged = statSync(path).mtimeMs;
    await ft.tick();
    expect(statSync(path).mtimeMs).toBe(aged);
    await held.release();
    expect((JSON.parse(readFileSync(path, "utf8")) as LockInfo).invoker).toBe("successor");
  });

  test("a fail-open holder has no heartbeat", async () => {
    const ft = fakeTimers();
    const dir = lockDir();
    const path = join(dir, "run.lock");
    writeFileSync(path, JSON.stringify({ pid: 1 << 30, startedIso: new Date().toISOString(), invoker: "dead" }));
    const { chmodSync } = await import("node:fs");
    chmodSync(dir, 0o500);
    try {
      const held = await take(path, ft, 10 * 60_000);
      expect(held.owned).toBe("fail-open");
      expect(ft.live.size).toBe(0);
      await held.release();
    } finally { chmodSync(dir, 0o700); }
  });

  test("no timer survives release, and a tick after release touches nothing", async () => {
    const ft = fakeTimers();
    const path = join(lockDir(), "run.lock");
    const held = await take(path, ft, 10 * 60_000);
    expect(ft.live.size).toBe(1);
    const interval = [...ft.live.values()][0]!;
    await held.release();
    expect(ft.live.size).toBe(0);
    writeFileSync(path, "{}");                       // something else's file at the path now
    age(path, 400_000);
    const aged = statSync(path).mtimeMs;
    await interval.fn();                             // a straggling callback, run by hand
    expect(statSync(path).mtimeMs).toBe(aged);
  });

  test("a release while a tick's ownership check is still pending: that tick, and any later one, touches nothing", async () => {
    // The two `beat === undefined` guards (P1-M4 checkpoint LOW): the tick's stat is held open across `release`.
    // `release`'s OWN check is failed (EIO), so it leaves the file in place and the file is still ours — only the
    // guard can stop the touch.
    const ft = fakeTimers();
    const path = join(lockDir(), "run.lock");
    const held = await take(path, ft, 10 * 60_000);
    const beat = [...ft.live.values()][0]!;
    const realStat = fsp.stat;
    let gate!: () => void;
    const opened = new Promise<void>((r) => { gate = r; });
    let n = 0;
    const spy = spyOn(fsp, "stat").mockImplementation((async (...a: Parameters<typeof fsp.stat>) => {
      n++;
      if (n === 1) { await opened; return realStat(...a); }       // the tick's ownership check, held open
      if (n === 2) throw Object.assign(new Error("injected"), { code: "EIO" });   // release's own check
      return realStat(...a);
    }) as typeof fsp.stat);
    try {
      age(path, 400_000);
      const aged = statSync(path).mtimeMs;
      const pending = beat.fn();                    // the tick starts and stalls in its stat
      await Bun.sleep(10);
      await held.release();                         // clears the interval; its own check fails, so no unlink
      expect(ft.live.size).toBe(0);
      gate();
      await pending;
      expect(statSync(path).mtimeMs).toBe(aged);    // the pending tick saw `beat === undefined` after its check
      expect(n).toBe(2);                            // the premise: both injected stats were reached
      await beat.fn();                              // a straggler after release…
      expect(statSync(path).mtimeMs).toBe(aged);
      expect(n).toBe(2);                            // …returns before it even checks ownership
    } finally { spy.mockRestore(); }
  });

  test("with heartbeatCapMs absent, nothing is scheduled (every existing caller is unchanged)", async () => {
    const ft = fakeTimers();
    const path = join(lockDir(), "run.lock");
    const held = await take(path, ft);
    expect(ft.live.size).toBe(0);
    await held.release();
  });

  test("with the REAL timers: the handle is unref'd, it touches, and release clears it", async () => {
    const handles: ReturnType<typeof setInterval>[] = [];
    const timers = {
      setInterval: (fn: () => void, ms: number) => { const h = setInterval(fn, ms); handles.push(h); return h; },
      clearInterval: (h: ReturnType<typeof setInterval>) => clearInterval(h),
    };
    const path = join(lockDir(), "run.lock");
    const got = await acquireRunLock({ invoker: "scheduled", timeoutMs: TIMEOUT_MS, path, heartbeatCapMs: 60_000, heartbeatTimers: timers, heartbeatIntervalMs: 20 });
    if (!got.acquired) throw new Error("expected the lock");
    try {
      expect(handles.length).toBe(1);
      expect((handles[0] as unknown as { hasRef(): boolean }).hasRef()).toBe(false);
      age(path, 400_000);
      const aged = statSync(path).mtimeMs;
      await Bun.sleep(120);
      expect(statSync(path).mtimeMs).toBeGreaterThan(aged);
    } finally { await got.release(); }   // a real interval must never outlive a failed assertion
    // Cleared: a later aging stays put.
    writeFileSync(path, "{}");
    age(path, 400_000);
    const after = statSync(path).mtimeMs;
    await Bun.sleep(80);
    expect(statSync(path).mtimeMs).toBe(after);
  });
});

describe("heartbeatCapMs", () => {
  test("the two per-entry terms use the per-attempt bound the walk's deadline uses (hub Q24)", () => {
    const t = 120_000;
    expect(earlierEntryTermMs(t)).toBe(4 * attemptBoundMs(t) + 30_000 + 2 * NET_PER_PROBE_MS);
    const backoff = PROVIDER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(lastEntryTermMs(t)).toBe(MAX_PROVIDER_ATTEMPTS * attemptBoundMs(t) + backoff + NET_PER_PROBE_MS);   // + the last entry's probe
    // The bound is at least the walk's own deadline for either kind of entry, so the lock is never kept fresh for
    // less than an attempt may legitimately take.
    expect(attemptBoundMs(t)).toBeGreaterThanOrEqual(cliAttemptBoundMs(t));
    expect(attemptBoundMs(t)).toBeGreaterThanOrEqual(apiAttemptBoundMs(t));
    void KEY_COMMAND_TIMEOUT_MS; void KILL_GRACE_MS;
  });

  test("sums the larger term per entry, plus the net grace and the margin; the calendar and recap terms only when on", () => {
    const entries = [{ timeoutMs: 120_000 }, { timeoutMs: 600_000 }, { timeoutMs: 30_000 }];
    const sum = entries.reduce((a, e) => a + Math.max(earlierEntryTermMs(e.timeoutMs), lastEntryTermMs(e.timeoutMs)), 0);
    expect(heartbeatCapMs(entries)).toBe(NET_DEFAULT_GRACE_MS + sum + HEARTBEAT_MARGIN_MS);
    expect(heartbeatCapMs(entries, { calendar: true }) - heartbeatCapMs(entries)).toBe(CALENDAR_STEP_WORST_MS);
    // Tier B's term at the LONGEST entry timeout (P1-M4 checkpoint MED): the grouper reuses the WINNER's instance
    // and timeout (spec r9 §5 step 6), and any entry can win. Entry 2's 600 s is longer than item 1's 120 s.
    expect(heartbeatCapMs(entries, { recapCampaigns: true }) - heartbeatCapMs(entries)).toBe(recapPhaseBoundMs(600_000));
    expect(heartbeatCapMs([{ timeoutMs: 120_000 }], { recapCampaigns: true }) - heartbeatCapMs([{ timeoutMs: 120_000 }])).toBe(recapPhaseBoundMs(120_000));
    expect(heartbeatCapMs(entries, { calendar: false, recapCampaigns: false })).toBe(heartbeatCapMs(entries));
  });

  test("with today's constants the LAST term is always the larger: last − earlier = bound + 102 000 (the max is future-proofing)", () => {
    for (const t of [1, 1_000, 30_000, 120_000, 600_000, 3_600_000]) {
      expect(`${t}: ${lastEntryTermMs(t) - earlierEntryTermMs(t)}`).toBe(`${t}: ${attemptBoundMs(t) + 102_000}`);
    }
  });

  test("the cap is at least each entry's term (hub Q24 (4))", () => {
    const entries = [{ timeoutMs: 120_000 }, { timeoutMs: 600_000 }];
    for (const e of entries) {
      expect(heartbeatCapMs(entries)).toBeGreaterThanOrEqual(earlierEntryTermMs(e.timeoutMs));
      expect(heartbeatCapMs(entries)).toBeGreaterThanOrEqual(lastEntryTermMs(e.timeoutMs));
    }
  });

  test("a single entry's cap is at least today's staleness bound, and lockStaleMs itself is unchanged", () => {
    expect(heartbeatCapMs([{ timeoutMs: TIMEOUT_MS }])).toBeGreaterThanOrEqual(lockStaleMs(TIMEOUT_MS));
    expect(lockStaleMs(120_000)).toBe(845_000);
  });
});

test("L9: a tick that finds the lock is no longer ours STOPS the heartbeat, rather than polling until the cap", async () => {
  const ft = fakeTimers();
  const path = join(lockDir(), "run.lock");
  const held = await take(path, ft, 10 * 60_000);
  expect(ft.live.size).toBe(1);
  const beat = [...ft.live.values()][0]!;
  writeFileSync(path, JSON.stringify({ pid: process.pid, startedIso: new Date().toISOString(), invoker: "cli", nonce: "the-successor" }));
  await beat.fn();
  expect(ft.live.size).toBe(0);
  await held.release();
});

test("round 4 L8: a read blip (stat EIO once) mid-beat skips ONE beat; the heartbeat keeps running and the next beat touches", async () => {
  const ft = fakeTimers();
  const path = join(lockDir(), "run.lock");
  const held = await take(path, ft, 10 * 60_000);
  const beat = [...ft.live.values()][0]!;
  const real = fsp.stat;
  let failed = 0;
  const spy = spyOn(fsp, "stat").mockImplementation((async (...a: Parameters<typeof real>) => {
    if (failed === 0) { failed++; throw Object.assign(new Error("EIO: i/o error, stat"), { code: "EIO" }); }
    return real(...a);
  }) as typeof real);
  try {
    age(path, 400_000);
    const aged = statSync(path).mtimeMs;
    await beat.fn();
    expect(failed).toBe(1);                                         // the premise: the blip happened
    expect(statSync(path).mtimeMs).toBe(aged);                      // this beat skipped its touch
    expect(ft.live.size).toBe(1);                                   // …and did not stop the heartbeat
  } finally { spy.mockRestore(); }
  const aged2 = statSync(path).mtimeMs;
  ft.advance(HEARTBEAT_INTERVAL_MS);
  await ft.tick();
  expect(statSync(path).mtimeMs).toBeGreaterThan(aged2 + 300_000);  // the next beat touched
  await held.release();
});
