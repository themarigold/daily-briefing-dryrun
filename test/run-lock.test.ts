import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// Backlog IN-5 — the advisory cross-process run lock, plus `<state>/last-skip.json`.
//
// TWO properties, and the second is the one that can cost a morning:
//   1. MUTUAL EXCLUSION — two racing runs produce exactly ONE provider call and ONE delivery. The
//      headline test proves it with two REAL processes, because an in-process race shares a pid and
//      an event loop and can therefore pass while the file lock does nothing.
//   2. FAIL-OPEN — a stale, unparseable, dead-held or unwritable lock must PROCEED. A new gate that
//      can fail closed is a mechanism for silently losing a briefing, which is strictly worse than
//      the duplicate run it prevents, so every fail-open branch is exercised rather than asserted.
import { test, expect, describe, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, chmodSync, rmSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRepo } from "./fixtures/build-repo";
import { run } from "../src/main";
import { acquireRunLock, runLockPath, LOCK_STALE_GRACE_MS, lockStaleMs, MAX_PROVIDER_ATTEMPTS, type LockInfo } from "../src/runlock";
import { readLastSkip, lastSkipPath, localDateStr } from "../src/marker";
import { TIMEOUT_MS, KILL_GRACE_MS, flushWindowMs } from "../src/provider";
import { PROVIDER_RETRY_DELAYS_MS } from "../src/core";
import { NET_DEFAULT_GRACE_MS } from "../src/net";
import { RECAP_GIT_BUDGET_MS, recapCallDeadlineMs, recapPhaseBoundMs } from "../src/recapBudget";
import { ProviderError, type Provider } from "../src/types";

/** The staleness window at the default timeout, as every ageing test below spells it. Derived, never
 *  a literal: the whole point of the fix these tests pin is that the bound is computed from the
 *  holder's own constants, so a test carrying its own number could agree with a wrong bound. */
const STALE_MS = lockStaleMs(TIMEOUT_MS);

const yesterdayISO = () => new Date(Date.now() - 864e5).toISOString();
const PROV = { cli: "claude", argv: ["-p"], promptVia: "stdin" as const };
const MODEL_OUT = "## RESUME\n- [r] resume here\n## RECAP\n- [r] did x | evidence: abc123\n## SUGGESTIONS\n- do y";
const AFTER_FLOOR = () => new Date(2026, 6, 16, 9, 0);
const BEFORE_FLOOR = () => new Date(2026, 6, 16, 7, 19);

function withEnv(cfgObj?: unknown): { stateDir: string; cfgHome: string; cleanup: () => void } {
  const cfgHome = mkdtempSync(join(tmpdir(), "dba-cfg-"));
  const stateDir = mkdtempSync(join(tmpdir(), "dba-state-"));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  if (cfgObj !== undefined) {
    writeFileSync(join(cfgHome, "daily-briefing", "config.json"),
      typeof cfgObj === "string" ? cfgObj : JSON.stringify(cfgObj));
  }
  const prevXdg = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  return {
    stateDir, cfgHome,
    cleanup: () => {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
      // Both mkdtemps are removed, not just unpointed. Measured before this: one run of this file
      // left 26 `dba-cfg-*` and 26 `dba-state-*` directories behind in the OS temp dir.
      rmSync(cfgHome, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
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

function fakeProvider() {
  let calls = 0;
  const provider: Provider = { async generate() { calls++; return MODEL_OUT; } };
  return { provider, calls: () => calls };
}

const runDeps = { now: AFTER_FLOOR, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 };

/** A pid that certainly no longer exists: spawn something trivial and wait for it to die. Preferred
 *  over a large made-up number, which on a busy machine can belong to a real process. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["/bin/sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
  return p.pid;
}

// ── the lock primitive ───────────────────────────────────────────────────────────────────────────

describe("acquireRunLock", () => {
  test("the first caller wins and the file carries pid / startedIso / invoker", async () => {
    const env = withEnv();
    try {
      const got = await acquireRunLock({ invoker: "scheduled", timeoutMs: TIMEOUT_MS });
      expect(got.acquired).toBe(true);
      const info = JSON.parse(readFileSync(runLockPath(), "utf8")) as LockInfo;
      expect(info.pid).toBe(process.pid);
      expect(info.invoker).toBe("scheduled");
      expect(Number.isNaN(Date.parse(info.startedIso))).toBe(false);
      if (got.acquired) await got.release();
      expect(existsSync(runLockPath())).toBe(false);
    } finally { env.cleanup(); }
  });

  test("a second caller is REFUSED while the first holds it, and is told who holds it", async () => {
    const env = withEnv();
    try {
      const a = await acquireRunLock({ invoker: "scheduled", timeoutMs: TIMEOUT_MS });
      const b = await acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS });
      expect(b.acquired).toBe(false);
      if (!b.acquired) expect(b.holder.invoker).toBe("scheduled");
      if (a.acquired) await a.release();
      // …and once released, the next caller gets it.
      const c = await acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS });
      expect(c.acquired).toBe(true);
      if (c.acquired) await c.release();
    } finally { env.cleanup(); }
  });

  test("FAIL-OPEN: a lock older than timeoutMs + grace is reclaimed", async () => {
    const env = withEnv();
    try {
      const a = await acquireRunLock({ invoker: "scheduled", timeoutMs: TIMEOUT_MS });
      expect(a.acquired).toBe(true);
      const old = new Date(Date.now() - (STALE_MS + 5_000));
      utimesSync(runLockPath(), old, old);
      const b = await acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS });
      expect(b.acquired).toBe(true);
      expect((JSON.parse(readFileSync(runLockPath(), "utf8")) as LockInfo).invoker).toBe("cli");
    } finally { env.cleanup(); }
  });

  test("a lock JUST INSIDE the staleness window still blocks — the bound is a bound, not a shrug", async () => {
    const env = withEnv();
    try {
      await acquireRunLock({ invoker: "scheduled", timeoutMs: TIMEOUT_MS });
      const recent = new Date(Date.now() - (STALE_MS - 10_000));
      utimesSync(runLockPath(), recent, recent);
      expect((await acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS })).acquired).toBe(false);
    } finally { env.cleanup(); }
  });

  // ── the staleness BOUND itself (review HIGH-1/#9) ─────────────────────────────────────────────
  //
  // The bound used to be `timeoutMs + LOCK_STALE_GRACE_MS` = 180 s, which is 2.9x SHORTER than the
  // holder's own worst case. Everything below is inside the lock: the net gate's grace, up to
  // MAX_PROVIDER_ATTEMPTS provider attempts each bounded by timeoutMs + KILL_GRACE_MS, and the
  // retry SLEEPS. One timed-out attempt plus the FIRST retry sleep is already 25 + 125 + 45 = 195 s,
  // so a perfectly healthy slow run had its lock reclaimed while it was still generating — two
  // provider calls and two deliveries for one day, the exact IN-5 failure the module exists to close.
  test("a LIVE holder past the OLD 180 s bound is STILL BLOCKED — 185 s is a healthy slow run, not an abandoned one", async () => {
    const env = withEnv();
    try {
      const a = await acquireRunLock({ invoker: "scheduled", timeoutMs: TIMEOUT_MS });
      expect(a.acquired).toBe(true);                       // holder = THIS pid, certainly alive
      // The review's measured repro verbatim: 175 s blocked, 185/200/500 s acquired. All four must block.
      for (const ageMs of [175_000, 185_000, 200_000, 500_000]) {
        const t = new Date(Date.now() - ageMs);
        utimesSync(runLockPath(), t, t);
        const b = await acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS });
        expect(`alive holder, lock age ${ageMs} ms → acquired ${b.acquired}`)
          .toBe(`alive holder, lock age ${ageMs} ms → acquired false`);
      }
    } finally { env.cleanup(); }
  });

  test("the bound is DERIVED from the holder's own constants, not from a literal", () => {
    // Assembled here from the SAME imports runlock.ts uses, so a change to any of them that outgrows
    // the window fails HERE rather than silently re-opening the race.
    const worstCase =
      NET_DEFAULT_GRACE_MS
      + MAX_PROVIDER_ATTEMPTS * (TIMEOUT_MS + KILL_GRACE_MS)
      + PROVIDER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(lockStaleMs(TIMEOUT_MS)).toBe(worstCase + LOCK_STALE_GRACE_MS);
    expect(lockStaleMs(TIMEOUT_MS)).toBeGreaterThan(TIMEOUT_MS + LOCK_STALE_GRACE_MS); // strictly wider than the old one
    // `provider.timeoutMs` is user-configurable and SHRINKS the window. A configured 30 s gave 90 s
    // under the old rule — below the 135 s of retry sleeps alone, i.e. a guaranteed self-collision on
    // any retry. The derived bound cannot go under the sleeps, whatever the timeout is set to.
    for (const t of [1_000, 30_000, TIMEOUT_MS, 600_000]) {
      expect(`timeout ${t} covers the sleeps: ${lockStaleMs(t) > PROVIDER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + NET_DEFAULT_GRACE_MS}`)
        .toBe(`timeout ${t} covers the sleeps: true`);
    }
    // A nonsense configured timeout must not collapse the window to nothing.
    for (const junk of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(`${junk} → ${lockStaleMs(junk)}`).toBe(`${junk} → ${lockStaleMs(TIMEOUT_MS)}`);
    }
  });

  test("MAX_PROVIDER_ATTEMPTS matches the schedule core.ts actually composes", () => {
    // withRetry: 1 + PROVIDER_RETRY_DELAYS_MS.length attempts; the C1/B6 hardening ladder adds two
    // more SINGLE attempts (rung 1 with flags, rung 2 without) once that schedule is exhausted —
    // core.ts:628-641 calls it "the intended worst case of 5 calls".
    expect(MAX_PROVIDER_ATTEMPTS).toBe(1 + PROVIDER_RETRY_DELAYS_MS.length + 2);
  });

  test("FAIL-OPEN: an UNPARSEABLE lock is reclaimed rather than believed", async () => {
    // A half-written or hand-edited lock must not become a permanent gate. It cannot be attributed to
    // a live holder, so believing it would trade a crash for an outage.
    const env = withEnv();
    try {
      mkdirSync(env.stateDir, { recursive: true });
      writeFileSync(runLockPath(), "{not json");
      const b = await acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS });
      expect(b.acquired).toBe(true);
      if (b.acquired) await b.release();
    } finally { env.cleanup(); }
  });

  test("FAIL-OPEN: a CRASHED holder (SIGKILL — fresh mtime, dead pid) does not block the next run", async () => {
    // The staleness window alone would make the next tick wait out timeoutMs + 60s. A dead pid is
    // proof the holder is gone, so the lock is reclaimed immediately.
    const env = withEnv();
    try {
      mkdirSync(env.stateDir, { recursive: true });
      writeFileSync(runLockPath(), JSON.stringify({ pid: await deadPid(), startedIso: new Date().toISOString(), invoker: "scheduled" }));
      const b = await acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS });
      expect(b.acquired).toBe(true);
      if (b.acquired) await b.release();
    } finally { env.cleanup(); }
  });

  test("FAIL-OPEN: an unwritable state directory proceeds rather than refusing to brief", async () => {
    const env = withEnv();
    const locked = join(env.stateDir, "ro");
    try {
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o500);                      // readable, not writable
      const b = await acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS, path: join(locked, "run.lock") });
      expect(b.acquired).toBe(true);                 // could not lock ⇒ proceeds UNLOCKED, never blocks
      if (b.acquired) await b.release();
    } finally { chmodSync(locked, 0o700); env.cleanup(); }
  });

  test("release is a NO-OP once the lock has been legitimately reclaimed by a successor", async () => {
    // Otherwise an overrunning run would delete its SUCCESSOR's lock on the way out and re-open the
    // exact race this module closes.
    const env = withEnv();
    try {
      const a = await acquireRunLock({ invoker: "first", timeoutMs: TIMEOUT_MS });
      const old = new Date(Date.now() - (STALE_MS + 5_000));
      utimesSync(runLockPath(), old, old);
      const b = await acquireRunLock({ invoker: "second", timeoutMs: TIMEOUT_MS });
      expect(b.acquired).toBe(true);
      if (a.acquired) await a.release();             // the overrunner tidies up
      expect(existsSync(runLockPath())).toBe(true);  // …and the successor's lock survives
      expect((JSON.parse(readFileSync(runLockPath(), "utf8")) as LockInfo).invoker).toBe("second");
      if (b.acquired) await b.release();
    } finally { env.cleanup(); }
  });

  test("release is a NO-OP when the successor's lock REUSES the inode and collides on pid + startedIso", async () => {
    // The test above reclaims through the normal path, where unlink+create moves the inode and the
    // inode fast path alone carries the refusal. On CI ubuntu it does not: ext4 hands a freed inode
    // straight back to the next create, so the successor's unlink+create can land on the SAME inode.
    // Both holders in one process share a pid, and two acquires in one ISO millisecond share
    // startedIso — so EVERY identity but the per-acquire nonce collides, and a nonce-less release
    // deletes its successor's lock. (That is the read-from-code explanation of an intermittent CI
    // failure in the test above; not reproduced locally, where APFS does not reuse inode numbers.)
    //
    // Deterministic simulation of all three collisions at once: overwrite the lock IN PLACE — same
    // path, no unlink, so the inode is unchanged — with a body that copies the holder's pid and
    // startedIso and differs only in invoker and nonce.
    const env = withEnv();
    try {
      const a = await acquireRunLock({ invoker: "first", timeoutMs: TIMEOUT_MS });
      expect(a.acquired).toBe(true);
      const held = JSON.parse(readFileSync(runLockPath(), "utf8")) as LockInfo;
      expect(typeof held.nonce).toBe("string");        // the discriminator actually reaches disk
      writeFileSync(runLockPath(), JSON.stringify({ ...held, invoker: "second", nonce: "successor-nonce" }));
      if (a.acquired) await a.release();               // the overrunner tidies up
      expect(existsSync(runLockPath())).toBe(true);    // …and the successor's lock survives
      expect((JSON.parse(readFileSync(runLockPath(), "utf8")) as LockInfo).invoker).toBe("second");
    } finally { env.cleanup(); }
  });

  // ── the ownership check's OTHER two contents conjuncts, pinned one at a time ────────────────────
  //
  // `release` unlinks only when inode, pid, startedIso AND nonce all say "mine". The test above pins
  // the nonce. These pin pid and startedIso SEPARATELY, because a nonce-only comparison — dropping
  // the `pid`/`startedIso` conjuncts — left this whole file green when measured by mutation on a
  // parallel fix for the same defect. Same in-place overwrite as above, so the inode still matches
  // and the nonce is copied verbatim: the refusal has to come from the ONE field that differs.
  const FOREIGN_BY_ONE_FIELD: [string, (h: LockInfo) => Partial<LockInfo>][] = [
    ["pid",        (h) => ({ pid: h.pid + 1 })],                                                 // any pid that is not ours
    ["startedIso", (h) => ({ startedIso: new Date(Date.parse(h.startedIso) + 1).toISOString() })], // one ms later
  ];
  for (const [field, patch] of FOREIGN_BY_ONE_FIELD) {
    test(`release REFUSES when inode and nonce match but ${field} differs`, async () => {
      const env = withEnv();
      try {
        const a = await acquireRunLock({ invoker: "first", timeoutMs: TIMEOUT_MS });
        expect(a.acquired).toBe(true);
        const held = JSON.parse(readFileSync(runLockPath(), "utf8")) as LockInfo;
        const foreign = { ...held, ...patch(held) };
        expect(foreign.nonce).toBe(held.nonce);                 // the discriminator is deliberately NOT what differs
        writeFileSync(runLockPath(), JSON.stringify(foreign)); // in place: same inode
        if (a.acquired) await a.release();
        expect(`${field} differs → lock survives ${existsSync(runLockPath())}`)
          .toBe(`${field} differs → lock survives true`);
        expect(readFileSync(runLockPath(), "utf8")).toBe(JSON.stringify(foreign));
      } finally { env.cleanup(); }
    });
  }

  // ── the UNKNOWN-inode branch: `remember()` failed, `ino` is undefined ───────────────────────────
  //
  // `remember()` swallows a failed stat, so a holder can hold a lock whose inode it never learned.
  // `release` then SKIPS the inode check rather than failing it, and contents alone decide — which
  // must cut both ways. Refusing a stranger is the safe half; the half that matters for the product
  // is that the holder's OWN nonce still releases: a holder that cannot release leaves its lock
  // behind, and inside a long-lived process (the desktop app embedding `run()`) that pid stays alive,
  // so the next run is blocked for the whole `lockStaleMs` window rather than reclaiming at once.
  //
  // The seam is `stat` itself, failed for the duration of the acquire only. `spyOn` on the
  // `node:fs/promises` namespace reaches runlock.ts's live import binding (measured on bun 1.3.14),
  // and the call count proves the injected failure was the one `remember()` swallowed.
  async function acquireWithUnknownInode(invoker: string) {
    const spy = spyOn(fsp, "stat").mockImplementation(async () => {
      throw Object.assign(new Error("injected: stat failed between create and remember"), { code: "EIO" });
    });
    try {
      const got = await acquireRunLock({ invoker, timeoutMs: TIMEOUT_MS });
      expect(`stat calls during acquire: ${spy.mock.calls.length}`).toBe("stat calls during acquire: 1");
      return got;
    } finally { spy.mockRestore(); }
  }

  test("UNKNOWN inode: a stranger's nonce is still refused — contents alone carry the refusal", async () => {
    const env = withEnv();
    try {
      const a = await acquireWithUnknownInode("first");
      expect(a.acquired).toBe(true);
      const held = JSON.parse(readFileSync(runLockPath(), "utf8")) as LockInfo;
      writeFileSync(runLockPath(), JSON.stringify({ ...held, invoker: "second", nonce: "successor-nonce" }));
      if (a.acquired) await a.release();
      expect(existsSync(runLockPath())).toBe(true);
      expect((JSON.parse(readFileSync(runLockPath(), "utf8")) as LockInfo).invoker).toBe("second");
    } finally { env.cleanup(); }
  });

  test("UNKNOWN inode: the holder's OWN nonce still releases — an unlearned inode is not a refusal", async () => {
    const env = withEnv();
    try {
      const a = await acquireWithUnknownInode("first");
      expect(a.acquired).toBe(true);
      expect(existsSync(runLockPath())).toBe(true);
      if (a.acquired) await a.release();
      expect(existsSync(runLockPath())).toBe(false);
    } finally { env.cleanup(); }
  });

  test("it creates the state directory on a machine that has never run", async () => {
    const env = withEnv();
    const fresh = join(env.stateDir, "never-used");
    try {
      const a = await acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS, path: join(fresh, "run.lock") });
      expect(a.acquired).toBe(true);
      expect(existsSync(join(fresh, "run.lock"))).toBe(true);
      if (a.acquired) await a.release();
    } finally { env.cleanup(); }
  });
});

// ── the lock inside run() ────────────────────────────────────────────────────────────────────────

describe("run() under the lock", () => {
  test("a live holder makes the tick skip with NO provider call, exit 0, and reason 'concurrent'", async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    const env = withEnv({ repos: [repo], provider: PROV });
    const cap = captureConsole();
    const fp = fakeProvider();
    try {
      mkdirSync(env.stateDir, { recursive: true });
      writeFileSync(runLockPath(), JSON.stringify({ pid: process.pid, startedIso: new Date().toISOString(), invoker: "scheduled" }));
      const code = await run(true, { ...runDeps, provider: fp.provider });
      expect(code).toBe(0);                                   // a legitimate skip, never an error
      expect(fp.calls()).toBe(0);                             // ⚠ the point: no allowance is burned
      expect(cap.err.join("\n")).toContain("another daily-briefing run is already in progress");
      expect(existsSync(join(env.stateDir, "last-run"))).toBe(false);
      expect((await readLastSkip())!.reason).toBe("concurrent");
      expect(existsSync(runLockPath())).toBe(true);           // the HOLDER's lock is left alone
    } finally { cap.restore(); env.cleanup(); }
  });

  test("a stale lock is reclaimed and the briefing is delivered — fail-open end to end", async () => {
    const repo = await buildRepo([{ file: "b.txt", content: "b", isoDate: yesterdayISO() }]);
    const env = withEnv({ repos: [repo], provider: PROV });
    const cap = captureConsole();
    const fp = fakeProvider();
    try {
      mkdirSync(env.stateDir, { recursive: true });
      writeFileSync(runLockPath(), JSON.stringify({ pid: process.pid, startedIso: "old", invoker: "scheduled" }));
      const old = new Date(Date.now() - (STALE_MS + 5_000));
      utimesSync(runLockPath(), old, old);
      expect(await run(true, { ...runDeps, provider: fp.provider })).toBe(0);
      expect(fp.calls()).toBe(1);
      expect(existsSync(join(env.stateDir, "last-run"))).toBe(true);
      expect(existsSync(runLockPath())).toBe(false);          // released on the way out
    } finally { cap.restore(); env.cleanup(); }
  });

  test("the lock is released on EVERY exit path — delivery, a provider failure, and a thrown crash", async () => {
    const repo = await buildRepo([{ file: "c.txt", content: "c", isoDate: yesterdayISO() }]);

    const ok = withEnv({ repos: [repo], provider: PROV });
    let cap = captureConsole();
    try {
      await run(true, { ...runDeps, provider: fakeProvider().provider });
      expect(existsSync(runLockPath())).toBe(false);
    } finally { cap.restore(); ok.cleanup(); }

    const failed = withEnv({ repos: [repo], provider: PROV });
    cap = captureConsole();
    try {
      // `retryDelaysMs: []` — a nonzero-exit is TRANSIENT, so the real schedule sleeps 45 s then 90 s.
      const code = await run(true, { ...runDeps, retryDelaysMs: [], sleep: async () => {}, provider: { async generate() { throw new ProviderError("nonzero-exit", "boom"); } } });
      expect(code).toBe(1);
      expect(existsSync(runLockPath())).toBe(false);
      expect((await readLastSkip())!.reason).toBe("provider-fail");
    } finally { cap.restore(); failed.cleanup(); }

    // The case `finally` exists for: an error that is NOT a ProviderError is rethrown, so the
    // function never reaches any of its returns.
    const crashed = withEnv({ repos: [repo], provider: PROV });
    cap = captureConsole();
    try {
      await expect(run(true, { ...runDeps, retryDelaysMs: [], sleep: async () => {}, provider: { async generate() { throw new TypeError("crash"); } } })).rejects.toThrow("crash");
      expect(existsSync(runLockPath())).toBe(false);
    } finally { cap.restore(); crashed.cleanup(); }
  }, 20_000);

  test("TWO REAL PROCESSES racing: exactly one provider call, one delivery, one archived briefing", async () => {
    // ⚠ TWO PROCESSES, deliberately. An in-process race shares a pid and an event loop, so it can
    // pass while the file lock does nothing at all — the very thing under test. Each process runs
    // `bun src/main.ts run --force`: with --force BOTH would generate today (the marker gate is
    // skipped), so anything other than one provider call means the lock did not hold.
    const repo = await buildRepo([{ file: "race.txt", content: "r", isoDate: yesterdayISO() }]);
    const env = withEnv();
    try {
      const counter = join(env.stateDir, "provider-calls");
      const script = join(env.stateDir, "fake-provider.sh");
      // A slow provider so the second process certainly arrives while the first holds the lock. The
      // model output goes through a QUOTED heredoc: an escaped `\n` inside a shell string stays two
      // literal characters, which parses into no section at all and exits 1 (measured before this).
      writeFileSync(script, [
        "#!/bin/sh",
        "cat > /dev/null",
        `echo x >> ${JSON.stringify(counter)}`,
        "sleep 2",
        "cat <<'DBAEOF'",
        MODEL_OUT,
        "DBAEOF",
        "",
      ].join("\n"));
      chmodSync(script, 0o755);
      writeFileSync(join(env.cfgHome, "daily-briefing", "config.json"), JSON.stringify({
        repos: [repo],
        // `harden: false` skips the capability probe (a second spawn of the fake CLI with --help);
        // `networkProbeHosts: []` is the documented switch that disables the net gate.
        provider: { cli: script, argv: [], promptVia: "stdin", harden: false },
        networkProbeHosts: [],
      }));

      const entry = resolve(new URL("../src/main.ts", import.meta.url).pathname);
      const spawnRun = () => Bun.spawn(["bun", entry, "run", "--force"], {
        env: { ...process.env, XDG_CONFIG_HOME: env.cfgHome, DAILY_BRIEFING_STATE_DIR: env.stateDir },
        stdout: "pipe", stderr: "pipe",
      });
      const a = spawnRun();
      await Bun.sleep(300);
      const b = spawnRun();
      const [aOut, bOut, aErr, bErr] = await Promise.all([
        new Response(a.stdout).text(), new Response(b.stdout).text(),
        new Response(a.stderr).text(), new Response(b.stderr).text(),
      ]);
      await Promise.all([a.exited, b.exited]);

      const calls = existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length : 0;
      expect(`provider calls=${calls}`).toBe("provider calls=1");
      // Exit codes carried WITH the stderr, so a failure here diagnoses itself instead of printing
      // `expected 0, got 1` about a subprocess whose output the runner never shows.
      expect(`exit=${a.exitCode},${b.exitCode} stderr=${aErr}${bErr}`)
        .toBe(`exit=0,0 stderr=${aErr}${bErr}`);                 // a skip is a legitimate 0
      // Exactly one process printed a briefing — the other printed nothing to stdout at all, which
      // is what keeps briefing.log free of a second, duplicate entry for the same morning.
      const briefed = [aOut, bOut].filter((o) => /^☀️.*[Bb]riefing —/m.test(o));
      expect(`stdout briefings=${briefed.length}`).toBe("stdout briefings=1");
      expect(`${aErr}${bErr}`).toContain("another daily-briefing run is already in progress");
      // ⚠ The marker is compared against the ARCHIVE, not against this process's idea of today.
      // `bun test` pins its own process to UTC while a spawned `bun` uses the system zone, so a
      // literal date comparison across that boundary fails for six hours a day on a UTC-7 machine
      // (measured: marker 2026-09-14 vs an in-test 2026-09-15). What the test actually means — ONE
      // delivery, marker and archive agreeing — is expressible without either process's zone.
      const marker = readFileSync(join(env.stateDir, "last-run"), "utf8").trim();
      expect(marker).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(readdirSync(join(env.stateDir, "briefings"))).toEqual([`${marker}.md`]);
      expect(existsSync(runLockPath())).toBe(false);             // both processes cleaned up
      // ⚠ AND NO SKIP RECORD SURVIVES. The refused process wrote `concurrent` at ~300 ms; the
      // delivering one finished ~2 s later and REMOVED it. That ordering is the whole point of
      // clearing on delivery rather than overwriting: the morning WAS delivered, so a reader must
      // not find a skip sitting beside it. Observed across two real processes, not argued.
      expect(await readLastSkip()).toBeUndefined();
      expect(existsSync(lastSkipPath())).toBe(false);
    } finally { env.cleanup(); }
  }, 30_000);
});

// ── last-skip.json ───────────────────────────────────────────────────────────────────────────────

describe("last-skip.json", () => {
  test("every non-delivering gate records its own reason", async () => {
    const repo = await buildRepo([{ file: "s.txt", content: "s", isoDate: yesterdayISO() }]);
    const today = localDateStr(AFTER_FLOOR());

    // below-floor: a scheduled, non-interactive tick before the configured morning time.
    let env = withEnv({ repos: [repo], provider: PROV, morningTime: "07:20" });
    let cap = captureConsole();
    try {
      expect(await run(false, { now: BEFORE_FLOOR })).toBe(0);
      const s = (await readLastSkip())!;
      expect(s.reason).toBe("below-floor");
      expect(s.localDate).toBe(localDateStr(BEFORE_FLOOR()));
      expect(Number.isNaN(Date.parse(s.iso))).toBe(false);
    } finally { cap.restore(); env.cleanup(); }

    // no-config: a fresh machine. Silent on stderr, but no longer silent on disk.
    env = withEnv();
    cap = captureConsole();
    try {
      expect(await run(false, { now: AFTER_FLOOR })).toBe(0);
      expect((await readLastSkip())!.reason).toBe("no-config");
    } finally { cap.restore(); env.cleanup(); }

    // config-error: a malformed config, which exits 2 — a skip record is written there too, because
    // "why is there no briefing" is the same question whatever the exit code.
    env = withEnv({ morningTime: "07:20" });     // no `provider` ⇒ validateConfig throws
    cap = captureConsole();
    try {
      expect(await run(false, { now: AFTER_FLOOR })).toBe(2);
      const s = (await readLastSkip())!;
      expect(s.reason).toBe("config-error");
      expect(s.detail).toContain("provider");
    } finally { cap.restore(); env.cleanup(); }

    // already-ran: the once-per-day marker.
    env = withEnv({ repos: [repo], provider: PROV });
    cap = captureConsole();
    try {
      mkdirSync(env.stateDir, { recursive: true });
      writeFileSync(join(env.stateDir, "last-run"), localDateStr(new Date()));
      expect(await run(false, { now: AFTER_FLOOR })).toBe(0);
      expect((await readLastSkip())!.reason).toBe("already-ran");
    } finally { cap.restore(); env.cleanup(); }

    expect(today).toBe("2026-07-16");   // the pinned clock is what these localDate assertions rest on
  });

  test("an offline scheduled tick records 'offline'; a blocked one records 'blocked'", async () => {
    const repo = await buildRepo([{ file: "o.txt", content: "o", isoDate: yesterdayISO() }]);
    let env = withEnv({ repos: [repo], provider: PROV });
    let cap = captureConsole();
    const fp = fakeProvider();
    try {
      expect(await run(false, { now: AFTER_FLOOR, netProbe: async () => false, netGraceMs: 20, netPollMs: 5, sleep: async () => {}, provider: fp.provider })).toBe(0);
      expect(fp.calls()).toBe(0);
      expect((await readLastSkip())!.reason).toBe("offline");
    } finally { cap.restore(); env.cleanup(); }

    // blocked = zero activity AND a repo we tried to read was inaccessible.
    env = withEnv({ repos: ["/Users/me/Desktop/repo"], provider: PROV });
    cap = captureConsole();
    try {
      const code = await run(true, {
        ...runDeps,
        provider: fakeProvider().provider,
        guard: { platform: "darwin", protectedRoots: ["/Users/me/Desktop"] },
        probe: async () => ({ code: "EPERM" } as NodeJS.ErrnoException),
      });
      expect(code).toBe(1);
      expect((await readLastSkip())!.reason).toBe("blocked");
    } finally { cap.restore(); env.cleanup(); }
  });

  test("a DELIVERED run removes a stale record, so yesterday's skip cannot mask today's briefing", async () => {
    // The contract stated in marker.ts: present ⇒ the last thing that happened was a skip. An
    // overwrite-with-"delivered" would have made every reader parse the reason to learn the same fact.
    const repo = await buildRepo([{ file: "d.txt", content: "d", isoDate: yesterdayISO() }]);
    const env = withEnv({ repos: [repo], provider: PROV });
    const cap = captureConsole();
    try {
      mkdirSync(env.stateDir, { recursive: true });
      writeFileSync(lastSkipPath(), JSON.stringify({ iso: "2026-09-13T15:00:00.000Z", localDate: "2026-09-13", reason: "offline" }));
      expect(await readLastSkip()).not.toBeUndefined();
      expect(await run(true, { ...runDeps, provider: fakeProvider().provider })).toBe(0);
      expect(existsSync(lastSkipPath())).toBe(false);
      expect(await readLastSkip()).toBeUndefined();
    } finally { cap.restore(); env.cleanup(); }
  });

  test("a CORRUPT record reads as 'no record' rather than throwing in a polled surface", async () => {
    const env = withEnv();
    try {
      mkdirSync(env.stateDir, { recursive: true });
      for (const bad of ["{oops", "{}", '{"reason":"offline"}', "null", "[]"]) {
        writeFileSync(lastSkipPath(), bad);
        expect(await readLastSkip()).toBeUndefined();
      }
    } finally { env.cleanup(); }
  });

  test("a record that CANNOT be written never changes the exit code", async () => {
    // The whole file is a diagnostic. `writeLastSkip` swallows internally AND the call sites wrap it,
    // because the failure being defended against is losing a briefing over a note about losing one.
    const repo = await buildRepo([{ file: "w.txt", content: "w", isoDate: yesterdayISO() }]);
    const env = withEnv({ repos: [repo], provider: PROV });
    const cap = captureConsole();
    try {
      mkdirSync(env.stateDir, { recursive: true });
      mkdirSync(lastSkipPath(), { recursive: true });   // a DIRECTORY where the file must go ⇒ EISDIR
      const code = await run(true, { ...runDeps, provider: fakeProvider().provider });
      expect(code).toBe(0);                             // delivered anyway
      expect(existsSync(join(env.stateDir, "last-run"))).toBe(true);
    } finally { cap.restore(); env.cleanup(); }
  });
});

// ── Tier B (T4.2): the lock term for recap campaigns — spec §4.4 (`D_call`), §4.9, §4.8's main.ts site ──
//
// The formula pins are LITERALS on purpose, the plan's (tierb-plan §4 T4.2): the tests above derive the
// bound from the holder's own constants, which catches a wrong composition but not a wrong constant, and
// these catch the latter. The 845 s / 1 135 s pair is what P11b's 900 s age sits between.
test("recapCallDeadlineMs(120000) is 270000", () => { expect(recapCallDeadlineMs(120_000)).toBe(270_000); });
test("recapPhaseBoundMs(120000) is 290000", () => { expect(recapPhaseBoundMs(120_000)).toBe(290_000); });
test("lockStaleMs(120000, {recapCampaigns: true}) is 1135000", () => { expect(lockStaleMs(120_000, { recapCampaigns: true })).toBe(1_135_000); });
test("lockStaleMs(120000) is 845000", () => { expect(lockStaleMs(120_000)).toBe(845_000); });
test("recapCallDeadlineMs(200000) is 430000", () => { expect(recapCallDeadlineMs(200_000)).toBe(430_000); });

describe("tier B's lock term", () => {
  test("[TB-P7] lockStaleMs gains exactly D_B with recapCampaigns, and lockStaleMs(t) is unchanged without it", () => {
    // Spelled from the spec's own terms (§5.4 "Lock"), NOT through recapPhaseBoundMs, so a wrong
    // recapBudget.ts fails here rather than agreeing with itself.
    const backoff = PROVIDER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    for (const t of [1_000, 30_000, TIMEOUT_MS, 200_000, 600_000]) {
      const base = NET_DEFAULT_GRACE_MS + MAX_PROVIDER_ATTEMPTS * (t + KILL_GRACE_MS) + backoff + LOCK_STALE_GRACE_MS;
      const dB = RECAP_GIT_BUDGET_MS + 2 * (t + KILL_GRACE_MS + flushWindowMs(false, {}));
      // unchanged without the flag — omitted, empty, or false — which is mode off / absent / malformed
      expect(`t=${t}: ${lockStaleMs(t)} ${lockStaleMs(t, {})} ${lockStaleMs(t, { recapCampaigns: false })}`)
        .toBe(`t=${t}: ${base} ${base} ${base}`);
      // …and exactly D_B wider with it
      expect(`t=${t}: +${lockStaleMs(t, { recapCampaigns: true }) - lockStaleMs(t)}`).toBe(`t=${t}: +${dB}`);
    }
    // Both terms sanitise a junk configured timeout the same way (the one shared sanitiser).
    for (const junk of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(`${junk} → ${lockStaleMs(junk, { recapCampaigns: true })}`).toBe(`${junk} → ${lockStaleMs(TIMEOUT_MS, { recapCampaigns: true })}`);
      expect(`${junk} → ${recapCallDeadlineMs(junk)}`).toBe(`${junk} → ${recapCallDeadlineMs(TIMEOUT_MS)}`);
    }
  });

  test("[TB-P7] acquireRunLock forwards recapCampaigns: a live holder's lock aged 900 s is respected with it, reclaimed without it", async () => {
    const env = withEnv();
    try {
      expect(lockStaleMs(TIMEOUT_MS) < 900_000 && 900_000 < lockStaleMs(TIMEOUT_MS, { recapCampaigns: true })).toBe(true);
      const age = () => { const t = new Date(Date.now() - 900_000); utimesSync(runLockPath(), t, t); };
      const a = await acquireRunLock({ invoker: "scheduled", timeoutMs: TIMEOUT_MS, recapCampaigns: true });
      expect(a.acquired).toBe(true);                       // holder = THIS pid, certainly alive
      age();
      expect((await acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS, recapCampaigns: true })).acquired).toBe(false);
      expect((JSON.parse(readFileSync(runLockPath(), "utf8")) as LockInfo).invoker).toBe("scheduled");
      expect((await acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS })).acquired).toBe(true);           // flag omitted
      age();
      expect((await acquireRunLock({ invoker: "cli", timeoutMs: TIMEOUT_MS, recapCampaigns: false })).acquired).toBe(true);
    } finally { env.cleanup(); }
  });
});

// P11b — through run(), the harness this file and test/main.test.ts share: `run(true, deps)` with the
// config written into the redirected XDG_CONFIG_HOME, a redirected state dir, an injected provider and
// `netProbe`. The holder is a LIVE `sleep 30` child — a dead pid is reclaimed at once by `holderAlive`
// whatever its age, so only a live holder lets the mtime bound decide — killed in `finally`.
const yesterdayNoon = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d; };
const P11B_AGE_MS = 900_000;   // between lockStaleMs(t) = 845 s and lockStaleMs(t, {recapCampaigns: true}) = 1 135 s

async function runAgainstAgedLiveHolder(extra: Record<string, unknown>) {
  const repo = await buildRepo([{ file: "p11b.txt", content: "p", isoDate: yesterdayNoon().toISOString() }]);
  const env = withEnv({ repos: [repo], provider: PROV, ...extra });
  const cap = captureConsole();
  const fp = fakeProvider();
  // spawned INSIDE the try: a throwing spawn must still reach `finally`, or the console stays captured and
  // the env redirected for every later test in this file
  let holder: ReturnType<typeof Bun.spawn> | undefined;
  try {
    holder = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    mkdirSync(env.stateDir, { recursive: true });
    writeFileSync(runLockPath(), JSON.stringify({ pid: holder.pid, startedIso: new Date(Date.now() - P11B_AGE_MS).toISOString(), invoker: "scheduled" }));
    const aged = new Date(Date.now() - P11B_AGE_MS);
    utimesSync(runLockPath(), aged, aged);
    expect(holder.exitCode).toBeNull();                   // the holder is alive when the run looks
    const code = await run(true, { ...runDeps, provider: fp.provider });
    return {
      code, calls: fp.calls(), concurrent: cap.err.join("\n").includes("another daily-briefing run is already in progress"),
      skip: (await readLastSkip())?.reason ?? null, delivered: existsSync(join(env.stateDir, "last-run")),
    };
  } finally { holder?.kill(); await holder?.exited; cap.restore(); env.cleanup(); }
}

describe("run() under the lock: tier B widens the bound only when enabled", () => {
  const RECLAIMED = { code: 0, calls: 1, concurrent: false, skip: null, delivered: true };
  test("[TB-P11b] key absent: a live holder's lock aged 900 s is reclaimed (bound 845 s) and the briefing is delivered", async () => {
    expect(await runAgainstAgedLiveHolder({})).toEqual(RECLAIMED);
  });

  test("[TB-P11b] malformed key: the same lock is reclaimed (bound 845 s) — a typo never widens the lock", async () => {
    for (const recapCampaigns of [{ mode: "on", extra: true }, "trial"]) {
      expect({ recapCampaigns, r: await runAgainstAgedLiveHolder({ recapCampaigns }) }).toEqual({ recapCampaigns, r: RECLAIMED });
    }
  });

  test("[TB-P11b] mode trial: the same lock is respected (bound 1 135 s) — skip 'concurrent', no provider call", async () => {
    expect(await runAgainstAgedLiveHolder({ recapCampaigns: { mode: "trial" } }))
      .toEqual({ code: 0, calls: 0, concurrent: true, skip: "concurrent", delivered: false });
  });
});
