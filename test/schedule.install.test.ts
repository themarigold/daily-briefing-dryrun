import { takeIsolationViolations } from "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// Slice 4 T3/T8/T9 — the effectful half, driven entirely through the INJECTED exec and
// DBA_TEST_UNIT_DIR.
//
// ⚠ NOT ONE REAL SCHEDULER COMMAND RUNS IN THIS FILE. Every invocation is recorded by `fakeExec` and
// asserted as ARGV; nothing is spawned. That is not politeness — the suite runs on the author's live
// machine, where a real `launchctl unload` takes down the LIVE briefing agent and costs a morning.
// `test/isolation.meta.test.ts` scanner 4 is what makes the property checkable rather than habitual.
// ONE deliberate exception, in the "isolation guard" block at the end (Batch 2, spec 3.1.3): one test
// calls the real default exec, and one reaches it through `resolveScheduleDeps`, both with a probe whose
// scheduler tool is ABSENT from this host, asserted absent first. The refusal answers before any spawn;
// without it, the exec could only fail to find the tool.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, readdirSync, statSync, symlinkSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import {
  installSchedule, uninstallSchedule, verifySchedule, readScheduleRecord, writeScheduleRecord,
  schedulePath, managedBinPath, unitDir, unitPaths, primaryUnitPath, ownsLabel, kindFor,
  resolveIdentity, lingerCommand, verdictLine, verifyExitCode,
  EXIT_OK, EXIT_NONE, EXIT_FOREIGN, EXIT_ERROR, DEFAULT_SIGN_IDENTITY, SCHEDULE_EXEC_TIMEOUT_MS,
  isRegistrationChange, defaultExec, resolveScheduleDeps, SCHEDULER_CHANGE_REFUSED, pathPresent,
  probeRegistration, lingerState, manualRemoveSteps, MANUAL_STEPS_CLI_CLOSING,
  type Exec, type ScheduleDeps, type RegistrationCheck, type RegistrationReason,
} from "../src/schedule/install";
import { SCHEDULE_LABEL, SYSTEMD_SERVICE_NAME, SYSTEMD_TIMER_NAME, WINDOWS_TASK_NAME } from "../src/schedule/units";
import { markerPath, lastSkipPath, localDateStr } from "../src/marker";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

/** One scripted answer. `latencyMs` advances the injected clock by that much before answering; `hang`
 *  models a command that never returns, so the exec's own timeout fires: the clock advances by the
 *  caller's WHOLE `timeoutMs` and the answer is -1, as `execResultOf` maps a timed-out run (spec 3.7
 *  "Test clock and exec"). */
type Scripted = { code?: number; out?: string; err?: string; latencyMs?: number; hang?: boolean };

/** A recording exec whose answer is a FUNCTION of the call (and so of the clock, or of what ran before) —
 *  the one place the fake answer rules live: `latencyMs` advances the clock, a `hang` costs the caller's
 *  whole `timeoutMs` and answers -1, and no answer is success. `fakeExec` is this with a fixed script. */
function fnExec(answer: (cmd: string[]) => Scripted | undefined) {
  const calls: string[][] = [];
  /** Each call's `timeoutMs`, index-aligned with `calls` (`undefined` where the caller passed none). */
  const timeouts: Array<number | undefined> = [];
  /** The test clock when each call STARTED, index-aligned with `calls`, so a test can check each
   *  `timeoutMs` against the time that was left (spec 3.1.4). */
  const at: number[] = [];
  const exec: Exec = async (cmd, opts) => {
    calls.push(cmd);
    timeouts.push(opts?.timeoutMs);
    at.push(CLOCK);
    const v = answer(cmd) ?? {};
    if (v.hang) {
      CLOCK += opts?.timeoutMs ?? SCHEDULE_EXEC_TIMEOUT_MS;
      return { code: -1, out: v.out ?? "", err: v.err ?? "" };
    }
    CLOCK += v.latencyMs ?? 0;
    return { code: v.code ?? 0, out: v.out ?? "", err: v.err ?? "" };
  };
  return { exec, calls, timeouts, at };
}

/** Records every command and answers each with a scripted result: the first `script` key the command
 *  line contains. The DEFAULT is success, because the interesting assertions are about WHAT was invoked;
 *  failures are scripted per-test. */
function fakeExec(script: Record<string, Scripted> = {}) {
  /** ⚠ SIDE EFFECTS OF A KICK, keyed by command substring. This is what lets a verification test
   *  assert "the kick CAUSED the evidence" rather than "the evidence was already there": the fixture
   *  writes the marker or the last-skip file from INSIDE the fake `launchctl start`, exactly where the
   *  real scheduler would have reached the engine. Tests that seeded the evidence before the call
   *  passed against a kick that did nothing at all. Effects run before the script is read, so one can
   *  change the answer to the call that fired it. */
  const effects: Array<{ match: string; fn: () => void }> = [];
  const f = fnExec((cmd) => {
    const line = cmd.join(" ");
    for (const e of effects) if (line.includes(e.match)) e.fn();
    for (const [k, v] of Object.entries(script)) if (line.includes(k)) return v;
    return undefined;
  });
  return {
    ...f,
    ran: (bin: string) => f.calls.filter((c) => c[0] === bin || c[0]?.endsWith(`/${bin}`)),
    onCall: (match: string, fn: () => void) => { effects.push({ match, fn }); },
  };
}

/** launchd's answer for a label it does not hold (spec 3.1.5: exit 113 and this text). */
const SERVICE_NOT_FOUND = `Could not find service "${SCHEDULE_LABEL}" in domain for port`;

/** How a scheduler model writes its answers into a `fakeExec` script: never over a key the test scripted
 *  itself, so a test's override always wins, whatever state the model moves to. */
function modelInto(script: Record<string, Scripted>, overrides: Record<string, Scripted> = {}) {
  return (key: string, v: Scripted) => { if (!(key in overrides)) script[key] = v; };
}

/**
 * A launchd that holds our job by label, or not — `fakeExec` underneath, so every call is still recorded
 * and every other command answers as it does. `print` and `list` find the job while it is loaded and
 * report service-not-found once it is not; a `bootout` unloads it (unless `stuck`), and an install's
 * `load` loads it. `set` flips it by hand, for a job that goes away on its own schedule. `script` entries
 * come first and the model never overwrites one, so a test can override any command.
 */
function launchdJob(loaded: boolean, o: { stuck?: boolean; script?: Record<string, Scripted> } = {}) {
  const script: Record<string, Scripted> = { ...o.script };
  const f = fakeExec(script);
  const put = modelInto(script, o.script);
  const set = (on: boolean) => {
    put("print ", on ? { code: 0 } : { code: 113, err: SERVICE_NOT_FOUND });
    put("list ", on ? { code: 0 } : { code: 113, err: SERVICE_NOT_FOUND });
  };
  set(loaded);
  if (!o.stuck) f.onCall("bootout", () => set(false));
  f.onCall("launchctl load", () => set(true));
  return { ...f, set };
}

/**
 * The same for systemd: `is-active` prints one word per unit (timer, service) and `is-enabled` one for the
 * timer. `stop` makes both inactive and `disable` makes the timer disabled (unless `stuck`); an install's
 * `enable --now` turns both on.
 */
function systemdJob(active: boolean, enabled: boolean, o: { stuck?: boolean; script?: Record<string, Scripted> } = {}) {
  const script: Record<string, Scripted> = { ...o.script };
  const f = fakeExec(script);
  const put = modelInto(script, o.script);
  const state = { active, enabled };
  const sync = () => {
    put("is-active", state.active ? { code: 0, out: "active\nactive\n" } : { code: 3, out: "inactive\ninactive\n" });
    put("is-enabled", state.enabled ? { code: 0, out: "enabled\n" } : { code: 1, out: "disabled\n" });
  };
  sync();
  if (!o.stuck) {
    f.onCall("--user stop", () => { state.active = false; sync(); });
    f.onCall("--user disable", () => { state.enabled = false; sync(); });
  }
  f.onCall("enable --now", () => { state.active = true; state.enabled = true; sync(); });
  return { ...f, set: (a: boolean, e: boolean) => { state.active = a; state.enabled = e; sync(); } };
}

/**
 * ⚠ THE TEST CLOCK (spec 3.7 "Test clock and exec"). `deps()` injects a MONOTONIC clock that only the
 * fake `sleep` and the fake exec's latency advance, so no test ever waits in real time. It starts well
 * away from zero, so a deadline measured from 0 rather than from the routine's entry shows. The frozen
 * wall-clock `now` stays: it stamps records, it never measures time.
 *
 * The fake `sleep` enforces the iteration cap, deadline ÷ 500 ms + 4 (spec 3.1.4): a polling loop that
 * does not end throws here instead of hanging the suite. Production code carries no such cap; it relies
 * on the monotonic clock.
 */
const CLOCK_START = 100_000;
const SLEEP_CAP = 45_000 / 500 + 4;
let CLOCK = CLOCK_START, SLEEPS = 0;
/** Every duration the fake `sleep` was asked for, in order. */
const NAPS: number[] = [];
const testClock = (): number => CLOCK;
const testSleep = async (ms: number): Promise<void> => {
  if (++SLEEPS > SLEEP_CAP) throw new Error(`fake sleep: call ${SLEEPS} passes the iteration cap of ${SLEEP_CAP} — a polling loop is not ending (spec 3.1.4)`);
  NAPS.push(ms);
  CLOCK += ms;
};

let HOME = "", UNITS = "", STATE = "", SRC_BIN = "";
const said: string[] = [], warned: string[] = [];
let prevUnitDir: string | undefined, prevState: string | undefined;

/**
 * ⚠ A FRESH STATE DIR PER TEST, not just per FILE. `schedulePath()` resolves through `supportDir()`
 * like every other state helper (ambient, by design — `markerPath`, `tickPath` and the rest all do),
 * so the shared `isolate-state` scratch directory is one directory for the whole PROCESS. Written
 * that way, `schedule.json` from one test was still there for the next, and a `--take-over` case left
 * a foreign owner that made three later installs exit 2. Measured, then fixed here rather than worked
 * around with ordering.
 *
 * Save-and-restore rather than `delete`: `bun test` runs the whole suite in ONE process, so clearing
 * the variable would un-isolate every file scheduled after this one — the exact ordering leak
 * `isolation.meta.test.ts`'s disarm scanner exists to catch.
 */
beforeEach(() => {
  HOME = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-sched-home-")));
  UNITS = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-sched-units-")));
  STATE = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-sched-state-")));
  // A stand-in for the engine binary the user downloaded. Content is asserted after the copy.
  SRC_BIN = join(removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-sched-src-"))), "daily-briefing");
  writeFileSync(SRC_BIN, "#!/bin/sh\nexit 0\n");
  chmodSync(SRC_BIN, 0o755);
  said.length = 0; warned.length = 0;
  CLOCK = CLOCK_START; SLEEPS = 0; NAPS.length = 0;
  prevUnitDir = process.env.DBA_TEST_UNIT_DIR;
  prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.DAILY_BRIEFING_STATE_DIR = STATE;
});

afterEach(() => {
  // Assigned back, never deleted: the preload arms DBA_TEST_UNIT_DIR as a tripwire, so the saved value is
  // never undefined, and a `delete` would throw on its non-configurable accessor.
  process.env.DBA_TEST_UNIT_DIR = prevUnitDir;
  if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
});

/** The env the installer sees. Identical to the ambient one for the two variables that matter, so
 *  `deps.env`-derived paths and `supportDir()`-derived paths cannot disagree — which they did, and
 *  the disagreement is what the per-test dirs above remove.
 *
 *  ⚠ `XDG_DATA_HOME` TOO, under the scratch HOME, because this spreads `process.env`: the preload arms
 *  the state dir, the config dir and the unit dir, not the data dir, and `managedBinPath` reads
 *  `env.XDG_DATA_HOME` first on Linux — so a developer shell exporting it would point every Linux install
 *  (and, from Batch 2 M4, every rollback that unlinks the managed binary) at the REAL data folder. The
 *  value is the path the default gives, so no expectation changes. */
function env(): NodeJS.ProcessEnv {
  return {
    ...process.env, DBA_TEST_UNIT_DIR: UNITS, DAILY_BRIEFING_STATE_DIR: STATE, USER: "tester",
    XDG_DATA_HOME: join(HOME, ".local", "share"),
  };
}

/** Where the managed copy lands for this test. Derived, never spelled out twice. */
function managed(platform: NodeJS.Platform = "darwin"): string {
  return managedBinPath(platform, env(), HOME);
}

/** A record as `installSchedule` writes it, owned by `owner`, for this test's paths. */
function writeRecord(owner: "cli" | "app", platform: NodeJS.Platform = "darwin"): Promise<void> {
  return writeScheduleRecord({
    owner, invoker: owner, kind: kindFor(platform)!, unitPath: primaryUnitPath(platform, env(), HOME)!,
    binPath: managed(platform), installedAt: "2026-09-01T00:00:00.000Z", engineVersion: "0.2.1",
  });
}

/** Our unit files on disk, as an install leaves them: the plist on macOS, the service and timer on Linux. */
function writeUnits(platform: NodeJS.Platform = "darwin"): string[] {
  const paths = unitPaths(platform, env(), HOME);
  for (const p of paths) writeFileSync(p, "unit\n");
  return paths;
}

/** ⚠ `uid: 4242`, FIXED, so every `gui/<uid>/…` argv a test asserts is the same on any machine — and is
 *  never the author's real uid (501), whose `gui/501/local.daily-briefing` names the LIVE domain. */
function deps(platform: NodeJS.Platform, exec: Exec, extra: Partial<ScheduleDeps> = {}): ScheduleDeps {
  return {
    exec, platform, home: HOME, execPath: SRC_BIN,
    env: env(),
    now: () => new Date("2026-09-14T12:00:00.000Z"),
    say: (l) => said.push(l), warn: (l) => warned.push(l),
    uid: 4242, clock: testClock, sleep: testSleep,
    ...extra,
  };
}

describe("the test clock and the fake exec (spec 3.7 'Test clock and exec')", () => {
  test("sleep advances the clock, and the iteration cap stops a runaway poll instead of hanging the suite", async () => {
    const d = deps("darwin", fakeExec().exec);
    expect(d.clock!()).toBe(CLOCK_START);
    await d.sleep!(500);
    expect(d.clock!()).toBe(CLOCK_START + 500);
    for (let i = 1; i < SLEEP_CAP; i++) await d.sleep!(500);   // up to the cap: fine
    await expect(d.sleep!(500)).rejects.toThrow("iteration cap");
    expect(SLEEP_CAP).toBe(94);   // 45 s ÷ 500 ms + 4
  });

  test("the fake exec records each call's timeoutMs, advances the clock by its latency, and a hang costs the whole timeout as -1", async () => {
    const f = fakeExec({ slow: { latencyMs: 250, out: "x" }, stuck: { hang: true } });
    expect(await f.exec(["slow"], { timeoutMs: 1_000 })).toEqual({ code: 0, out: "x", err: "" });
    expect(CLOCK).toBe(CLOCK_START + 250);
    expect(await f.exec(["stuck"], { timeoutMs: 3_000 })).toEqual({ code: -1, out: "", err: "" });
    expect(CLOCK).toBe(CLOCK_START + 3_250);
    await f.exec(["other"]);
    expect(f.timeouts).toEqual([1_000, 3_000, undefined]);
  });
});

// ── the bounded record read (spec 3.1.2). `readScheduleRecord` reads ONLY a regular file of at most
// 64 KiB, by `lstat`; anything else at the path is PRESENT BUT UNREADABLE — its owner unknown — so
// status, install and uninstall share one rule and no blocking read can escape a time budget. Presence
// is `pathPresent`, the same `lstat` look, under which a dangling symlink counts. The FIFO case runs in
// a child process in test/schedule.record-fifo.test.ts, so a regression fails instead of hanging here.
describe("the bounded record read (spec 3.1.2)", () => {
  const RECORD = {
    owner: "app", invoker: "app", kind: "launchd", unitPath: "/u", binPath: "/b",
    installedAt: "2026-09-14T12:00:00.000Z", engineVersion: "0.2.1",
  };
  const LIMIT = 64 * 1024;

  test("nothing there: not present, and no record", async () => {
    expect(await pathPresent(schedulePath())).toBe(false);
    expect(await readScheduleRecord()).toBeNull();
    // A path under a regular FILE (ENOTDIR) is absent too, as Rust's look reads it.
    writeFileSync(join(STATE, "plain"), "x");
    expect(await pathPresent(join(STATE, "plain", "schedule.json"))).toBe(false);
  });

  test("a regular record of exactly 64 KiB is read; one byte more is present but never read", async () => {
    const body = JSON.stringify(RECORD);
    writeFileSync(schedulePath(), body + " ".repeat(LIMIT - body.length));
    expect(statSync(schedulePath()).size).toBe(LIMIT);
    expect(await readScheduleRecord()).toMatchObject({ owner: "app", unitPath: "/u" });

    // Still valid JSON, so only the size rule can refuse it.
    writeFileSync(schedulePath(), body + " ".repeat(LIMIT + 1 - body.length));
    expect(await pathPresent(schedulePath())).toBe(true);
    expect(await readScheduleRecord()).toBeNull();
  });

  test("a malformed record is present but unreadable", async () => {
    writeFileSync(schedulePath(), '{"owner":"app","unitPa');
    expect(await pathPresent(schedulePath())).toBe(true);
    expect(await readScheduleRecord()).toBeNull();
  });

  test("a DANGLING symlink is present (lstat sees the link) but unreadable", async () => {
    symlinkSync(join(STATE, "nowhere.json"), schedulePath());
    expect(existsSync(schedulePath())).toBe(false);   // what a following look says — the trap
    expect(await pathPresent(schedulePath())).toBe(true);
    expect(await readScheduleRecord()).toBeNull();
  });

  test("a symlink to a VALID record is present, and is never read through the link", async () => {
    const target = join(STATE, "elsewhere.json");
    writeFileSync(target, JSON.stringify(RECORD));
    expect(await readScheduleRecord(target)).toMatchObject({ owner: "app" });   // the target itself reads
    symlinkSync(target, schedulePath());
    expect(await pathPresent(schedulePath())).toBe(true);
    expect(await readScheduleRecord()).toBeNull();
  });

  test("a directory at the record path is present but unreadable", async () => {
    mkdirSync(schedulePath());
    expect(await pathPresent(schedulePath())).toBe(true);
    expect(await readScheduleRecord()).toBeNull();
  });
});

describe("paths and the managed-copy rule", () => {
  test("DBA_TEST_UNIT_DIR overrides the real unit directory on every platform", () => {
    const env = { DBA_TEST_UNIT_DIR: UNITS } as NodeJS.ProcessEnv;
    for (const p of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
      expect(unitDir(p, env, HOME)).toBe(UNITS);
    }
    // …and without it, the REAL locations — which is exactly why the override must exist.
    expect(unitDir("darwin", {} as NodeJS.ProcessEnv, HOME)).toBe(join(HOME, "Library", "LaunchAgents"));
    expect(unitDir("linux", {} as NodeJS.ProcessEnv, HOME)).toBe(join(HOME, ".config", "systemd", "user"));
  });

  test("the managed copy lives under the app's own data dir, per platform", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(managedBinPath("darwin", env, HOME)).toBe(join(HOME, "Library", "Application Support", "daily-briefing", "daily-briefing"));
    expect(managedBinPath("linux", env, HOME)).toBe(join(HOME, ".local", "share", "daily-briefing", "bin", "daily-briefing"));
    // …and DAILY_BRIEFING_STATE_DIR relocates the darwin copy, because that is where install.sh
    // already puts it — one rule, not two.
    expect(managedBinPath("darwin", { DAILY_BRIEFING_STATE_DIR: "/s" } as NodeJS.ProcessEnv, HOME)).toBe(join("/s", "daily-briefing"));
  });

  test("kindFor maps the three supported platforms and refuses the rest", () => {
    expect([kindFor("darwin"), kindFor("linux"), kindFor("win32"), kindFor("freebsd")])
      .toEqual(["launchd", "systemd", "schtasks", null]);
  });
});

// ── ⚠ SIBLING SAFETY. The author's machine runs UNRELATED personal-pipeline agents whose labels
// differ from ours by one character class. A prefix, substring or glob match would select them, and
// `uninstall` / `--take-over` would then unload somebody else's agent.
describe("sibling safety — the label match is EXACT", () => {
  test("ownsLabel accepts ONLY local.daily-briefing", () => {
    expect(ownsLabel(SCHEDULE_LABEL)).toBe(true);
    // The negatives, written out rather than described:
    for (const sibling of [
      "local.daily_briefing",            // the personal pipeline's wake agent — underscores
      "local.daily_briefing_timer",      // its 07:20/13:00 calendar agent
      "local.daily-briefing.timer",      // a plausible future sibling of OURS
      "local.daily-briefing2",
      "com.local.daily-briefing",        // a suffix match would take this
      "local.daily-briefing ",           // trailing space
      "LOCAL.DAILY-BRIEFING",            // case
      "",
    ]) {
      expect(`${sibling} → ${ownsLabel(sibling)}`).toBe(`${sibling} → false`);
    }
  });

  test("every path the installer touches is built from the exact label — no sibling is addressable", () => {
    const env = { DBA_TEST_UNIT_DIR: UNITS } as NodeJS.ProcessEnv;
    expect(unitPaths("darwin", env, HOME)).toEqual([join(UNITS, "local.daily-briefing.plist")]);
    expect(primaryUnitPath("linux", env, HOME)).toBe(join(UNITS, SYSTEMD_TIMER_NAME));
    expect(primaryUnitPath("win32", env, HOME)).toBe(join(UNITS, `${WINDOWS_TASK_NAME}.xml`));
  });

  test("uninstall boots out OUR label in both domains and unlinks only our plist, even with sibling files present", async () => {
    // Put the siblings in the very directory uninstall operates on. A glob would sweep them.
    writeFileSync(join(UNITS, "local.daily_briefing.plist"), "<plist/>");
    writeFileSync(join(UNITS, "local.daily_briefing_timer.plist"), "<plist/>");
    writeFileSync(join(UNITS, `${SCHEDULE_LABEL}.plist`), "<plist/>");
    const f = launchdJob(true);
    expect(await uninstallSchedule({}, deps("darwin", f.exec))).toBe(EXIT_OK);
    // By the exact label, in both domains (spec 3.1.3) — never `unload <plist>`, which acts on whatever job
    // the file at that path names — then the read-only check, by the same label.
    expect(f.ran("launchctl").map((c) => c.join(" "))).toEqual([
      `launchctl bootout gui/4242/${SCHEDULE_LABEL}`,
      `launchctl bootout user/4242/${SCHEDULE_LABEL}`,
      `launchctl print gui/4242/${SCHEDULE_LABEL}`,
      `launchctl print user/4242/${SCHEDULE_LABEL}`,
      `launchctl list ${SCHEDULE_LABEL}`,
    ]);
    expect(f.calls.some((c) => c.join(" ").includes("daily_briefing"))).toBe(false);
    expect(existsSync(join(UNITS, `${SCHEDULE_LABEL}.plist`))).toBe(false);
    // ⚠ THE POINT: both siblings survive untouched.
    expect(existsSync(join(UNITS, "local.daily_briefing.plist"))).toBe(true);
    expect(existsSync(join(UNITS, "local.daily_briefing_timer.plist"))).toBe(true);
  });
});

describe("install (darwin)", () => {
  test("copies from process.execPath — NOT argv[0], which is the literal string \"bun\"", async () => {
    // ⚠ MEASURED, not assumed: inside a bun-compiled binary `process.argv[0]` is "bun" and a unit
    // built from it points at nothing. `execPath` is the binary's own absolute path.
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_OK);
    const dest = managed();
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe(readFileSync(SRC_BIN, "utf8"));
    const plist = readFileSync(join(UNITS, `${SCHEDULE_LABEL}.plist`), "utf8");
    expect(plist).toContain(`<string>${dest}</string>`);
    expect(plist).not.toContain("<string>bun</string>");
  });

  test("strips quarantine and signs THE COPY with --identifier local.daily-briefing", async () => {
    const f = fakeExec({ "find-identity": { out: `1) ABC "${DEFAULT_SIGN_IDENTITY}"` } });
    await installSchedule({ noVerify: true }, deps("darwin", f.exec));
    const dest = managed();
    expect(f.calls.map((c) => c.join(" "))).toContain(`xattr -d com.apple.quarantine ${dest}`);
    expect(f.calls.map((c) => c.join(" ")))
      .toContain(`codesign --force --sign ${DEFAULT_SIGN_IDENTITY} --timestamp=none --identifier ${SCHEDULE_LABEL} ${dest}`);
    // ⚠ THE SOURCE is never signed — you cannot cleanly re-sign the binary that is executing.
    expect(f.calls.some((c) => c[0] === "codesign" && c.includes(SRC_BIN))).toBe(false);
  });

  test("⚠ WHEN THE SOURCE IS ALREADY THE MANAGED COPY, NOTHING SIGNS THE EXECUTING BINARY", async () => {
    // This is the REAL `scripts/install.sh` path, not a curiosity: the script builds straight to the
    // managed location and then runs `"$BIN" schedule install --invoker cli`, so `execPath ===
    // managedBinPath`. The code skipped the COPY for that case and then signed anyway — `codesign
    // --force` (or the `-s - -f` ad-hoc fallback) on the binary that is executing, which is exactly
    // what install.ts's own header forbids, and install.sh:66 had signed that same file moments
    // earlier. Asserted as "no codesign call NAMES this path", not as "codesign was not called with
    // --force": the ad-hoc fallback spells it `-f` and would have slipped through the narrower check.
    const dest = managed();
    writeFileSync(dest, "#!/bin/sh\nexit 0\n");
    const f = fakeExec({ "find-identity": { out: `1) ABC "${DEFAULT_SIGN_IDENTITY}"` } });
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec, { execPath: dest }))).toBe(EXIT_OK);
    expect(f.calls.filter((c) => c[0] === "codesign" && c.includes(dest)).map((c) => c.join(" "))).toEqual([]);
    expect(f.ran("codesign")).toEqual([]);
    expect(f.ran("xattr")).toEqual([]);          // …and no quarantine call on it either
    expect(said.join("\n")).toContain("re-signing a running image");
    // The install still completes: the unit is written and loaded.
    expect(f.ran("launchctl").map((c) => c.join(" ")))
      .toContain(`launchctl load ${join(UNITS, `${SCHEDULE_LABEL}.plist`)}`);
  });

  test("a signing failure DEGRADES to ad-hoc with a warning — it never aborts the install", async () => {
    // install.sh:69-77's behaviour exactly: an unloaded agent costs a morning, a missing grant costs a
    // re-prompt. The trade is not close.
    const f = fakeExec({ "find-identity": { code: 1 }, "openssl": { code: 1 }, "version": { code: 1 } });
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_OK);
    expect(warned.join("\n")).toContain("falling back to an ad-hoc signature");
    expect(f.calls.map((c) => c.join(" ")).some((c) => c.startsWith("codesign -s - -f"))).toBe(true);
    // Phase E M5b checkpoint: NEITHER signature may ask a timestamp server — codesign's default for
    // that is per-identity and unspecified, and the README promises nothing else is contacted. (The
    // source install's own codesign lines are pinned in test/isolation.meta.test.ts, the one test file
    // allowed to name that script.)
    const signs = f.ran("codesign").map((c) => c.join(" "));
    expect(signs.length).toBeGreaterThan(0);
    expect(signs.filter((c) => !c.split(" ").includes("--timestamp=none"))).toEqual([]);
    expect(f.ran("launchctl").map((c) => c.join(" "))).toContain(`launchctl load ${join(UNITS, `${SCHEDULE_LABEL}.plist`)}`);
  });

  test("the identity is parameterized — --identity beats DBA_SIGN_IDENTITY beats the default", () => {
    expect(resolveIdentity({ identity: "Developer ID Application: X" }, { DBA_SIGN_IDENTITY: "env" } as NodeJS.ProcessEnv))
      .toBe("Developer ID Application: X");
    expect(resolveIdentity({}, { DBA_SIGN_IDENTITY: "env" } as NodeJS.ProcessEnv)).toBe("env");
    expect(resolveIdentity({}, {} as NodeJS.ProcessEnv)).toBe(DEFAULT_SIGN_IDENTITY);
  });

  test("registers via launchctl unload-then-load, and records the owner in schedule.json", async () => {
    const f = fakeExec();
    expect(await installSchedule({ invoker: "app", noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_OK);
    const unit = join(UNITS, `${SCHEDULE_LABEL}.plist`);
    expect(f.ran("launchctl").map((c) => c.join(" "))).toEqual([`launchctl unload ${unit}`, `launchctl load ${unit}`]);
    const rec = await readScheduleRecord();
    expect(rec).toMatchObject({ owner: "app", invoker: "app", kind: "launchd", unitPath: unit });
    expect(rec!.installedAt).toBe("2026-09-14T12:00:00.000Z");
    expect(rec!.engineVersion).toBeTruthy();
  });

  test("a failing launchctl load is exit 3 — a unit nobody loaded is not an install — and the first install ROLLS BACK", async () => {
    // The load never took, so once the rollback has booted the label out the check finds nothing: launchd
    // holds no such service. (Spec 3.2; every other rollback branch is in the "install rollback" block.)
    const f = fakeExec({
      "launchctl load": { code: 1, err: "Load failed: 5: Input/output error" },
      "print ": { code: 113, err: SERVICE_NOT_FOUND }, "list ": { code: 113, err: SERVICE_NOT_FOUND },
    });
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_ERROR);
    const text = warned.join("\n");
    expect(text).toContain("launchctl load failed");
    // ⚠ And NO record is written: schedule.json claiming ownership of a trigger that is not running
    // would make `status` lie and would make a later `uninstall` think it had something to remove.
    expect(await readScheduleRecord()).toBeNull();
    expect(await pathPresent(schedulePath())).toBe(false);
    // …and nothing this attempt made is left: the plist it wrote and the engine copy it created both go.
    const plist = join(UNITS, `${SCHEDULE_LABEL}.plist`);
    expect([existsSync(plist), existsSync(managed())]).toEqual([false, false]);
    expect(text).toContain(`This rollback removed: ${plist}, ${managed()}.`);
    expect(text.endsWith("Rolled back: nothing was left behind.")).toBe(true);
  });
});

describe("single-owner coexistence", () => {
  test("a FOREIGN owner is refused with exit 2, and NOTHING is written", async () => {
    await writeScheduleRecord({
      owner: "app", invoker: "app", kind: "launchd", unitPath: "/somewhere/app.plist",
      binPath: "/somewhere/bin", installedAt: "2026-09-01T00:00:00.000Z", engineVersion: "0.1.9",
    });
    const f = fakeExec();
    expect(await installSchedule({ invoker: "cli", noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_FOREIGN);
    expect(f.calls).toEqual([]);                                   // no exec at all
    expect(existsSync(join(UNITS, `${SCHEDULE_LABEL}.plist`))).toBe(false);  // no unit
    expect((await readScheduleRecord())!.owner).toBe("app");       // record untouched
    expect(warned.join("\n")).toContain("--take-over");
  });

  test("--take-over claims it, and the record flips owner", async () => {
    await writeScheduleRecord({
      owner: "app", invoker: "app", kind: "launchd", unitPath: "/somewhere/app.plist",
      binPath: "/somewhere/bin", installedAt: "2026-09-01T00:00:00.000Z", engineVersion: "0.1.9",
    });
    const f = fakeExec();
    expect(await installSchedule({ invoker: "cli", takeOver: true, noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_OK);
    expect((await readScheduleRecord())!.owner).toBe("cli");
  });

  test("re-installing under the SAME owner is a refresh, not a refusal", async () => {
    const f = fakeExec();
    await installSchedule({ invoker: "cli", noVerify: true }, deps("darwin", f.exec));
    expect(await installSchedule({ invoker: "cli", noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_OK);
  });

  test("uninstall refuses a foreign owner (exit 2) and removes nothing", async () => {
    writeFileSync(join(UNITS, `${SCHEDULE_LABEL}.plist`), "<plist/>");
    await writeScheduleRecord({
      owner: "app", invoker: "app", kind: "launchd", unitPath: join(UNITS, `${SCHEDULE_LABEL}.plist`),
      binPath: "/b", installedAt: "2026-09-01T00:00:00.000Z", engineVersion: "0.1.9",
    });
    const f = fakeExec();
    expect(await uninstallSchedule({ invoker: "cli" }, deps("darwin", f.exec))).toBe(EXIT_FOREIGN);
    expect(f.calls).toEqual([]);
    expect(existsSync(join(UNITS, `${SCHEDULE_LABEL}.plist`))).toBe(true);
  });

  test("uninstall with nothing installed is exit 1 — 'none', not an error and not a success — with its line on stdout", async () => {
    // Nothing on disk, so the check decides (spec 3.1.2): here launchd holds no such label.
    const f = launchdJob(false);
    expect(await uninstallSchedule({}, deps("darwin", f.exec))).toBe(EXIT_NONE);
    expect(said).toEqual(["Nothing installed by daily-briefing was found."]);
    expect(warned).toEqual([]);
  });

  test("uninstall leaves the engine BINARY alone — removing a schedule is not removing the tool", async () => {
    const f = launchdJob(false);   // the install's `load` loads it, and the uninstall's bootout unloads it
    await installSchedule({ noVerify: true }, deps("darwin", f.exec));
    const dest = managed();
    expect(await uninstallSchedule({}, deps("darwin", f.exec))).toBe(EXIT_OK);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(schedulePath())).toBe(false);
  });
});

describe("linux (T8)", () => {
  test("writes both units, daemon-reloads and enables --now, through the injected exec", async () => {
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec))).toBe(EXIT_OK);
    expect(existsSync(join(UNITS, "daily-briefing.service"))).toBe(true);
    expect(existsSync(join(UNITS, SYSTEMD_TIMER_NAME))).toBe(true);
    const cmds = f.ran("systemctl").map((c) => c.join(" "));
    expect(cmds).toContain("systemctl --user daemon-reload");
    expect(cmds).toContain(`systemctl --user enable --now ${SYSTEMD_TIMER_NAME}`);
    // No signing on linux — that whole branch is a macOS TCC problem.
    expect(f.ran("codesign")).toEqual([]);
    expect(f.ran("security")).toEqual([]);
  });

  test("the unit points at the managed copy under ~/.local/share — never at the source artifact", async () => {
    const f = fakeExec();
    await installSchedule({ noVerify: true }, deps("linux", f.exec));
    const service = readFileSync(join(UNITS, "daily-briefing.service"), "utf8");
    expect(service).toContain(`ExecStart="${join(HOME, ".local", "share", "daily-briefing", "bin", "daily-briefing")}" run`);
    expect(service).not.toContain(SRC_BIN);
  });

  test("⚠ THE APPIMAGE RULE: an execPath inside a mount is COPIED OUT, and no unit references the mount", async () => {
    // An AppImage's interior path is recreated on every launch, so a unit pointing inside it works
    // exactly once. The managed copy is what makes the rule hold; `assertNoMountPath` is the belt.
    const mountBin = join(removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-mountish-"))), ".mount_dbaXYZ");
    writeFileSync(mountBin, "#!/bin/sh\nexit 0\n");
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec, { execPath: mountBin }))).toBe(EXIT_OK);
    const service = readFileSync(join(UNITS, "daily-briefing.service"), "utf8");
    expect(service).not.toContain(".mount_");
    expect(service).toContain(join(HOME, ".local", "share", "daily-briefing", "bin", "daily-briefing"));
  });

  test("linger: disabled is reported LOUDLY with the exact command, and the install still succeeds", async () => {
    const f = fakeExec({ "show-user": { out: "Linger=no\n" } });
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec))).toBe(EXIT_OK);
    expect(warned.join("\n")).toContain("LINGERING IS DISABLED");
    expect(warned.join("\n")).toContain("loginctl enable-linger tester");
    expect(f.ran("loginctl").some((c) => c.includes("enable-linger"))).toBe(false);   // not without the flag
    expect(lingerCommand({ USER: "tester" } as NodeJS.ProcessEnv)).toBe("loginctl enable-linger tester");
  });

  test("linger: --enable-linger runs the command; enabled needs neither", async () => {
    const off = fakeExec({ "show-user": { out: "Linger=no\n" } });
    await installSchedule({ noVerify: true, enableLinger: true }, deps("linux", off.exec));
    expect(off.ran("loginctl").map((c) => c.join(" "))).toContain("loginctl enable-linger tester");

    said.length = 0; warned.length = 0;
    const on = fakeExec({ "show-user": { out: "Linger=yes\n" } });
    await installSchedule({ noVerify: true }, deps("linux", on.exec));
    expect(said.join("\n")).toContain("Lingering is enabled");
    expect(on.ran("loginctl").some((c) => c.includes("enable-linger"))).toBe(false);
  });
});

describe("windows (T9) — gated and labelled", () => {
  test("WITHOUT --confirm-experimental: XML written, command PRINTED, schtasks NOT run — and EXIT 2, no record", async () => {
    const f = fakeExec();
    // ⚠ EXIT 2, NOT 0. This returned EXIT_OK and wrote `schedule.json` while registering NOTHING —
    // so a GUI switching on the documented codes (which is the reason they are documented) was told
    // "installed, and ours" about a task that does not exist, `status` would have reported
    // `recordPresent: true`, and `uninstall` would have thought it had something to remove. 2 is the
    // contract's own code for "the caller refused a required confirmation" (install.ts's exit-code
    // contract). The XML stays the deliverable: it is written either way.
    expect(await installSchedule({ noVerify: true }, deps("win32", f.exec))).toBe(EXIT_FOREIGN);
    const xml = join(UNITS, `${WINDOWS_TASK_NAME}.xml`);
    expect(existsSync(xml)).toBe(true);
    // ⚠ UTF-16LE with a BOM on disk — schtasks /XML rejects UTF-8.
    const bytes = new Uint8Array(readFileSync(xml));
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(f.ran("schtasks")).toEqual([]);                       // ⚠ the gate
    expect(await readScheduleRecord()).toBeNull();               // ⚠ and nothing claims ownership
    expect(existsSync(schedulePath())).toBe(false);
    expect(said.join("\n")).toContain("schtasks /Create /XML");  // …but the exact command is printed
    expect(said.join("\n")).toContain("EXPERIMENTAL");
    expect(said.join("\n")).toContain("--confirm-experimental");
  });

  test("WITH --confirm-experimental: schtasks IS invoked, a record IS written, still labelled experimental", async () => {
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true, confirmExperimental: true }, deps("win32", f.exec))).toBe(EXIT_OK);
    expect(f.ran("schtasks").map((c) => c.join(" ")))
      .toContain(`schtasks /Create /XML ${join(UNITS, `${WINDOWS_TASK_NAME}.xml`)} /TN ${WINDOWS_TASK_NAME} /F`);
    // The other half of the pair above: ownership IS recorded once something was actually registered.
    expect(await readScheduleRecord()).toMatchObject({ owner: "cli", kind: "schtasks" });
    expect(said.join("\n")).toContain("EXPERIMENTAL");
  });

  test("a FAILING schtasks is exit 3 and writes no record either", async () => {
    const f = fakeExec({ "schtasks /Create": { code: 1, err: "ERROR: Access is denied." } });
    expect(await installSchedule({ noVerify: true, confirmExperimental: true }, deps("win32", f.exec))).toBe(EXIT_ERROR);
    expect(await readScheduleRecord()).toBeNull();
  });
});

describe("verify — the engine-side kickstart (plan R1)", () => {
  const V = { pollMs: 1, deadlineMs: 40 };
  /** ⚠ The evidence date must come from the INJECTED clock, not from `new Date()`. `deps()` pins
   *  `now` at 2026-09-14T12:00Z, and a test written against the wall clock passes or fails depending
   *  on what day the suite happens to run — measured here, where the runner's local date was already
   *  the 15th and every evidence file was silently keyed to a day `verifySchedule` was not looking at. */
  const EVIDENCE_DATE = localDateStr(new Date("2026-09-14T12:00:00.000Z"));

  test("kicks through the SCHEDULER, by exact label — not by calling run() directly", async () => {
    // The fact under test is "does the trigger reach the engine". A direct run would answer a
    // different question and pass while the schedule was dead.
    const f = fakeExec();
    await verifySchedule({ kind: "launchd", ...V }, deps("darwin", f.exec));
    expect(f.ran("launchctl").map((c) => c.join(" "))).toContain(`launchctl start ${SCHEDULE_LABEL}`);
  });

  test("linux: the kick is `systemctl --user start --no-block <service>` — queued, never waited on (P9)", async () => {
    const f = fakeExec();
    await verifySchedule({ kind: "systemd", ...V }, deps("linux", f.exec));
    const starts = f.ran("systemctl").filter((c) => c.includes("start")).map((c) => c.join(" "));
    expect(starts[0]).toBe(`systemctl --user start --no-block ${SYSTEMD_SERVICE_NAME}`);
    expect(starts.every((s) => s.includes("--no-block"))).toBe(true);
  });

  test("linux: a run longer than the exec ceiling is observed, not reported as a kick that could not start (P9)", async () => {
    // A model of SYSTEMD's semantics, not of the code under test: `start` on a `Type=oneshot` unit
    // returns only when the run exits, unless `--no-block` queues the job and returns at once. The run
    // modelled here outlasts SCHEDULE_EXEC_TIMEOUT_MS, so a blocking `start` comes back as the exec's
    // timeout failure (the systemctl client killed) while the run itself goes on to deliver.
    const marker = markerPath();   // resolved now: the per-test state dir, even if a timer fires late
    const exec: Exec = async (cmd) => {
      if (cmd[0] === "systemctl" && cmd.includes("start")) {
        setTimeout(() => writeFileSync(marker, EVIDENCE_DATE), 5);   // the run delivers a moment later
        if (!cmd.includes("--no-block")) return { code: 1, out: "", err: `timed out after ${SCHEDULE_EXEC_TIMEOUT_MS}ms` };
      }
      return { code: 0, out: "", err: "" };
    };
    const v = await verifySchedule({ kind: "systemd", pollMs: 1, deadlineMs: 2_000 }, deps("linux", exec));
    expect(v).toMatchObject({ kickstarted: true, outcome: "delivered" });
    expect(verdictLine(v)).not.toContain("could not be started");
  });

  test("a DELIVERY ends the loop immediately — it does not retry for a fatter briefing", async () => {
    // Plan R1: if the first iteration delivers (possibly thin), fall through to the steady-state
    // next-tick watch and let doctor's "repos need access" carry the thin-ness.
    //
    // ⚠ THE EVIDENCE IS WRITTEN BY THE KICK, not before the call. Written the other way — marker
    // seeded, then verify — this test passed against a `kick` THAT DID NOTHING AT ALL, because the
    // poll merely asked "does the marker say today". Writing it from inside the fake exec is what
    // makes the assertion "the kick caused this" instead of "this was already true".
    const f = fakeExec();
    f.onCall("launchctl start", () => writeFileSync(markerPath(), EVIDENCE_DATE));
    const v = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", f.exec));
    expect(v).toMatchObject({ kickstarted: true, outcome: "delivered", iterations: 1 });
    expect(f.ran("launchctl").filter((c) => c[1] === "start").length).toBe(1);
  });

  test("a SETTLED skip (already-ran / below-floor) proves the trigger works and does not loop", async () => {
    const f = fakeExec();
    f.onCall("launchctl start", () => writeFileSync(lastSkipPath(), JSON.stringify({
      iso: "2026-09-14T12:00:00.000Z", localDate: EVIDENCE_DATE, reason: "already-ran",
    })));
    const v = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", f.exec));
    expect(v).toMatchObject({ outcome: "skipped", skipReason: "already-ran", iterations: 1 });
  });

  // ── ⚠⚠ THE BASELINE. Only a CHANGE from the pre-kick state is evidence. ────────────────────────
  //
  // Measured against the pre-fix code: with the marker already carrying today — the ORDINARY state,
  // since the morning briefing is delivered long before anyone runs `schedule verify` — a fake exec
  // that ran nothing at all was reported as "the kickstarted run DELIVERED a briefing", in 13ms. The
  // three tests below are the ones that fail against that code.
  test("⚠ A DEAD TRIGGER IS NOT A DELIVERY: pre-existing evidence does not satisfy the poll", async () => {
    writeFileSync(markerPath(), EVIDENCE_DATE);      // today's briefing, delivered BEFORE this call
    const f = fakeExec();                            // …and a kick that changes nothing
    const v = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", f.exec));
    expect(v).toMatchObject({ kickstarted: true, outcome: "already-delivered-before-kick" });
    // The verdict must never claim the kicked run delivered.
    const line = verdictLine(v);
    expect(line).toContain("NOT VERIFIED");
    expect(line.toLowerCase()).not.toContain("delivered a briefing");
    // …and the exit code is not a pass.
    expect(verifyExitCode(v)).toBe(EXIT_NONE);
  });

  test("a pre-existing SKIP carrying today is not evidence either — it is no-evidence, not 'skipped'", async () => {
    writeFileSync(lastSkipPath(), JSON.stringify({
      iso: "2026-09-14T11:00:00.000Z", localDate: EVIDENCE_DATE, reason: "already-ran",
    }));
    const f = fakeExec();
    const v = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", f.exec));
    // No marker, so not "already-delivered-before-kick" either: nothing was learned at all.
    expect(v).toMatchObject({ kickstarted: true, outcome: "no-evidence", skipReason: null });
  });

  test("a NEW skip written after the kick IS evidence, even when a skip for today was already on disk", async () => {
    // The distinguishing fact is the timestamp: the engine writes a fresh `iso` on every decline, so
    // the second decline is visibly not the first. Without this, the baseline would have blinded the
    // verifier to the most common true positive on a machine that has already run today.
    writeFileSync(lastSkipPath(), JSON.stringify({
      iso: "2026-09-14T11:00:00.000Z", localDate: EVIDENCE_DATE, reason: "already-ran",
    }));
    const f = fakeExec();
    f.onCall("launchctl start", () => writeFileSync(lastSkipPath(), JSON.stringify({
      iso: "2026-09-14T12:00:05.000Z", localDate: EVIDENCE_DATE, reason: "already-ran", detail: "second tick",
    })));
    const v = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", f.exec));
    expect(v).toMatchObject({ outcome: "skipped", skipReason: "already-ran", detail: "second tick" });
    expect(verifyExitCode(v)).toBe(EXIT_OK);
  });

  test("the exit-code mapping is the documented one — and `no-evidence` is NOT a pass", async () => {
    const refused = fakeExec({ "launchctl start": { code: 1 } });
    const r = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", refused.exec));
    expect(`kick refused → ${verifyExitCode(r)}`).toBe(`kick refused → ${EXIT_ERROR}`);

    const silent = fakeExec();
    const s = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", silent.exec));
    expect(`accepted, nothing appeared → ${s.outcome}/${verifyExitCode(s)}`).toBe(`accepted, nothing appeared → no-evidence/${EXIT_NONE}`);

    const good = fakeExec();
    good.onCall("launchctl start", () => writeFileSync(markerPath(), EVIDENCE_DATE));
    const g = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", good.exec));
    expect(`delivered → ${verifyExitCode(g)}`).toBe(`delivered → ${EXIT_OK}`);
  });

  test("a kickstart the scheduler refuses is reported honestly, never as success", async () => {
    const f = fakeExec({ "launchctl start": { code: 1 } });
    const v = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", f.exec));
    expect(v).toMatchObject({ kickstarted: false, outcome: "no-evidence" });
  });

  test("install runs verify as its LAST step, and --no-verify skips exactly that", async () => {
    const withVerify = fakeExec();
    // Evidence from the kick, not seeded — same reason as the delivery test above.
    withVerify.onCall("launchctl start", () => writeFileSync(markerPath(), EVIDENCE_DATE));
    await installSchedule({ verify: V }, deps("darwin", withVerify.exec));
    const order = withVerify.ran("launchctl").map((c) => c[1]);
    expect(order).toEqual(["unload", "load", "start"]);   // ⚠ start is LAST

    said.length = 0;
    const without = fakeExec();
    await installSchedule({ noVerify: true, verify: V }, deps("darwin", without.exec));
    expect(without.ran("launchctl").map((c) => c[1])).toEqual(["unload", "load"]);
    expect(said.join("\n")).toContain("Skipped the verification kickstart");
  });
});

// ── ⚠ THE REGISTRATION CHECK (spec 3.1.5), through a fake exec only (spec 3.7 "The check, through a fake
// `exec`"). Three answers, never a boolean: `present`, `gone`, or `unknown` with a reason — because a
// check that could not run is not a "no", and reading it as one is how a live job gets reported gone.
// Every exec it makes is read-only, and every one here is the fake's.
describe("probeRegistration — the one registration check (spec 3.1.5)", () => {
  const T = 1_234;   // the caller's per-exec timeout, passed through to every exec unchanged
  const probe = (f: ReturnType<typeof fakeExec>, platform: NodeJS.Platform = "darwin") =>
    probeRegistration(deps(platform, f.exec), { timeoutMs: T });
  const present: RegistrationCheck = { state: "present" };
  const gone: RegistrationCheck = { state: "gone" };
  const unknown = (reason: RegistrationReason): RegistrationCheck => ({ state: "unknown", reason });

  describe("macOS: launchctl print gui/…, print user/… and list, by label", () => {
    const SERVICE_TEXT = `Could not find service "${SCHEDULE_LABEL}" in domain for port`;
    const DOMAIN_TEXT = "Could not find domain for port identifier: 4242";
    const mac = (g: Scripted, u: Scripted, l: Scripted) => fakeExec({ "print gui/": g, "print user/": u, "list ": l });

    test("three commands, by the exact label and deps' uid, each with the caller's timeout", async () => {
      const f = fakeExec();
      expect(await probe(f)).toEqual(present);
      expect(f.calls.map((c) => c.join(" "))).toEqual([
        `launchctl print gui/4242/${SCHEDULE_LABEL}`,
        `launchctl print user/4242/${SCHEDULE_LABEL}`,
        `launchctl list ${SCHEDULE_LABEL}`,
      ]);
      expect(f.timeouts).toEqual([T, T, T]);
    });

    // The answers each command can give (spec 3.7): `print gui` 0 / 113 / domain-missing / -1, `print user`
    // 0 / 113 / domain-missing, `list` 0 / 113 / another non-zero / -1 / -2. Domain-missing carries exit
    // 113 on purpose: the domain TEXT must decide, never the code.
    const G: Record<string, Scripted> = { zero: { code: 0 }, nf: { code: 113 }, domain: { code: 113, err: DOMAIN_TEXT }, hang: { hang: true } };
    const U: Record<string, Scripted> = { zero: { code: 0 }, nf: { code: 113 }, domain: { code: 113, err: DOMAIN_TEXT } };
    const L: Record<string, Scripted> = { zero: { code: 0 }, nf: { code: 113 }, other: { code: 1 }, hang: { hang: true }, nospawn: { code: -2 } };
    /** PAIRWISE, not the full product (spec 3.7): every pair of answers across any two commands appears
     *  at least once — asserted below, so the table cannot quietly lose coverage. Expectations are worked
     *  by hand from spec 3.1.5's four steps, never computed. */
    const MATRIX: Array<[string, string, string, RegistrationCheck]> = [
      ["zero", "zero", "zero", present],
      ["zero", "nf", "nf", present],
      ["zero", "domain", "other", present],
      ["zero", "zero", "hang", present],
      ["zero", "nf", "nospawn", present],
      ["nf", "nf", "zero", present],
      ["nf", "domain", "nf", gone],                            // print user's missing domain still counts toward gone
      ["nf", "zero", "other", present],
      ["nf", "nf", "hang", unknown("timeout")],                 // spec 3.7's `print 113/113, list -1`
      ["nf", "domain", "nospawn", unknown("spawn")],
      ["domain", "domain", "zero", present],
      ["domain", "zero", "nf", present],
      ["domain", "nf", "other", unknown("no-gui-session")],
      ["domain", "domain", "hang", unknown("no-gui-session")],
      ["domain", "zero", "nospawn", present],
      ["hang", "zero", "zero", present],
      ["hang", "nf", "nf", unknown("timeout")],
      ["hang", "domain", "other", unknown("timeout")],
      ["hang", "zero", "hang", present],
      ["hang", "nf", "nospawn", unknown("timeout")],          // a -1 anywhere is `timeout`, ahead of -2's `spawn`
    ];

    test("the matrix is pairwise-complete", () => {
      const seen = new Set(MATRIX.flatMap(([g, u, l]) => [`g:${g}|u:${u}`, `g:${g}|l:${l}`, `u:${u}|l:${l}`]));
      const want: string[] = [];
      for (const g of Object.keys(G)) for (const u of Object.keys(U)) want.push(`g:${g}|u:${u}`);
      for (const g of Object.keys(G)) for (const l of Object.keys(L)) want.push(`g:${g}|l:${l}`);
      for (const u of Object.keys(U)) for (const l of Object.keys(L)) want.push(`u:${u}|l:${l}`);
      expect(want.filter((p) => !seen.has(p))).toEqual([]);
    });

    for (const [g, u, l, expected] of MATRIX) {
      test(`print gui ${g}, print user ${u}, list ${l} → ${JSON.stringify(expected)}`, async () => {
        expect(await probe(mac(G[g]!, U[u]!, L[l]!))).toEqual(expected);
      });
    }

    test("print 113/113 with list exiting 1 and an EMPTY stderr is unknown(unexpected) — a killed command can surface as an ordinary code", async () => {
      expect(await probe(mac({ code: 113 }, { code: 113 }, { code: 1 }))).toEqual(unknown("unexpected"));
    });

    test("list exiting 1 with stderr 'Could not find service … in domain for port' is not-found, so both prints not found → gone", async () => {
      expect(await probe(mac({ code: 113 }, { code: 113 }, { code: 1, err: SERVICE_TEXT }))).toEqual(gone);
    });

    // Each half of the not-found rule on its own, for each command: exit 113 with an EMPTY stderr, and a
    // code other than 113 with "Could not find service". The other two commands answer with both halves at
    // once, so only the half under test can decide — dropping either half turns its `gone` into `unknown`.
    const BOTH: Scripted = { code: 113, err: SERVICE_TEXT };
    for (const [name, at] of [["print gui", 0], ["print user", 1], ["list", 2]] as const) {
      test(`${name}: exit 113 with an empty stderr is not-found`, async () => {
        const answers: Scripted[] = [BOTH, BOTH, BOTH];
        answers[at] = { code: 113 };
        expect(await probe(mac(answers[0]!, answers[1]!, answers[2]!))).toEqual(gone);
      });
      test(`${name}: another non-zero code with "Could not find service" is not-found`, async () => {
        const answers: Scripted[] = [BOTH, BOTH, BOTH];
        answers[at] = { code: 3, err: SERVICE_TEXT };
        expect(await probe(mac(answers[0]!, answers[1]!, answers[2]!))).toEqual(gone);
      });
    }

    test("the domain text is never a service not-found, even with exit 113 — on print gui it is no-gui-session, on list it is no answer", async () => {
      expect(await probe(mac({ code: 113, err: DOMAIN_TEXT }, BOTH, BOTH))).toEqual(unknown("no-gui-session"));
      expect(await probe(mac(BOTH, BOTH, { code: 113, err: DOMAIN_TEXT }))).toEqual(unknown("unexpected"));
    });

    test("a -1 or -2 is no answer BEFORE any absence rule — its not-found or domain text is never read", async () => {
      expect(await probe(mac(BOTH, BOTH, { hang: true, err: SERVICE_TEXT }))).toEqual(unknown("timeout"));
      expect(await probe(mac(BOTH, BOTH, { code: -2, err: SERVICE_TEXT }))).toEqual(unknown("spawn"));
      expect(await probe(mac({ hang: true, err: DOMAIN_TEXT }, BOTH, BOTH))).toEqual(unknown("timeout"));
      expect(await probe(mac({ code: -1, err: SERVICE_TEXT }, BOTH, BOTH))).toEqual(unknown("timeout"));
    });

    test("a THROWN exec counts as -2: unknown(spawn), never a crash and never gone", async () => {
      const boom: Exec = async () => { throw new Error("no such binary"); };
      expect(await probeRegistration(deps("darwin", boom), { timeoutMs: T })).toEqual(unknown("spawn"));
      // One throw among not-found answers still blocks `gone`.
      const listThrows: Exec = async (cmd) => {
        if (cmd.includes("list")) throw new Error("killed");
        return { code: 113, out: "", err: SERVICE_TEXT };
      };
      expect(await probeRegistration(deps("darwin", listThrows), { timeoutMs: T })).toEqual(unknown("spawn"));
    });
  });

  describe("Linux: systemctl --user is-active and is-enabled, read by their words", () => {
    const BUS_256 = "Failed to connect to bus: No medium found";
    const BUS_256_ENV = "Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined (consider using --machine=<user>@.host --user to connect to bus of other user)";
    const BUS_257 = "Failed to connect to user scope bus via local transport: No such file or directory";
    const OLD_NOT_FOUND = `Failed to get unit file state for ${SYSTEMD_TIMER_NAME}: No such file or directory`;
    const linux = (a: Scripted, e: Scripted) => fakeExec({ "is-active": a, "is-enabled": e });
    /** is-active prints one word per unit, timer first; its exit code is NOT what decides. */
    const active = (timer: string, service: string, code = 3): Scripted => ({ code, out: `${timer}\n${service}\n` });
    const enabledWord = (w: string, code = 1): Scripted => ({ code, out: `${w}\n` });
    const RUNNING = ["active", "reloading", "refreshing", "activating", "deactivating"];
    const NOT_RUNNING = ["inactive", "failed", "unknown"];
    const ENABLED = ["enabled", "enabled-runtime", "alias", "indirect", "generated", "transient"];
    const NOT_ENABLED = ["static", "disabled", "linked", "linked-runtime", "masked", "masked-runtime", "bad", "not-found"];

    test("two commands, by the exact unit names, each with the caller's timeout", async () => {
      const f = linux(active("inactive", "inactive"), enabledWord("disabled"));
      expect(await probe(f, "linux")).toEqual(gone);
      expect(f.calls.map((c) => c.join(" "))).toEqual([
        `systemctl --user is-active ${SYSTEMD_TIMER_NAME} ${SYSTEMD_SERVICE_NAME}`,
        `systemctl --user is-enabled ${SYSTEMD_TIMER_NAME}`,
      ]);
      expect(f.timeouts).toEqual([T, T]);
    });

    test("every running word, on either unit, is present", async () => {
      for (const w of RUNNING) {
        expect(`timer ${w} → ${JSON.stringify(await probe(linux(active(w, "inactive"), enabledWord("disabled")), "linux"))}`)
          .toBe(`timer ${w} → ${JSON.stringify(present)}`);
        expect(`service ${w} → ${JSON.stringify(await probe(linux(active("inactive", w), enabledWord("disabled")), "linux"))}`)
          .toBe(`service ${w} → ${JSON.stringify(present)}`);
      }
    });

    test("every not-running word, on both units, with the timer not enabled, is gone", async () => {
      for (const w of NOT_RUNNING) {
        expect(`${w} → ${JSON.stringify(await probe(linux(active(w, w), enabledWord("disabled")), "linux"))}`)
          .toBe(`${w} → ${JSON.stringify(gone)}`);
      }
    });

    test("an unlisted word, or a missing line, is no answer", async () => {
      for (const a of [active("maintenance", "inactive"), active("inactive", "maintenance"), { code: 3, out: "inactive\n" }, { code: 3, out: "" }]) {
        expect(await probe(linux(a, enabledWord("disabled")), "linux")).toEqual(unknown("unexpected"));
      }
    });

    test("every enabled word is present; every not-enabled word, with both units not running, is gone", async () => {
      for (const w of ENABLED) {
        expect(`${w} → ${JSON.stringify(await probe(linux(active("inactive", "inactive"), enabledWord(w, 0)), "linux"))}`)
          .toBe(`${w} → ${JSON.stringify(present)}`);
      }
      for (const w of NOT_ENABLED) {
        expect(`${w} → ${JSON.stringify(await probe(linux(active("inactive", "inactive"), enabledWord(w)), "linux"))}`)
          .toBe(`${w} → ${JSON.stringify(gone)}`);
      }
      expect(await probe(linux(active("inactive", "inactive"), enabledWord("enabled-someday")), "linux")).toEqual(unknown("unexpected"));
    });

    test("older systemd's not-found — empty stdout and 'Failed to get unit file state … No such file or directory' — is not enabled", async () => {
      expect(await probe(linux(active("inactive", "inactive"), { code: 1, out: "", err: OLD_NOT_FOUND }), "linux")).toEqual(gone);
      // Only that text: another failure with empty stdout is no answer.
      expect(await probe(linux(active("inactive", "inactive"), { code: 1, out: "", err: `Failed to get unit file state for ${SYSTEMD_TIMER_NAME}: Permission denied` }), "linux"))
        .toEqual(unknown("unexpected"));
    });

    test("the words decide, never the exit code alone", async () => {
      expect(await probe(linux(active("inactive", "inactive", 0), enabledWord("disabled", 0)), "linux")).toEqual(gone);
      expect(await probe(linux(active("active", "inactive", 3), enabledWord("disabled", 1)), "linux")).toEqual(present);
    });

    test("manager errors come FIRST: both bus wordings and XDG_RUNTIME_DIR are no-user-manager, from either command", async () => {
      const down = unknown("no-user-manager");
      expect(await probe(linux({ code: 1, err: BUS_256 }, { code: 1, err: BUS_256 }), "linux")).toEqual(down);
      expect(await probe(linux({ code: 1, err: BUS_256_ENV }, enabledWord("disabled")), "linux")).toEqual(down);
      // The 257 wording ENDS like older systemd's not-found ("No such file or directory"), and must not
      // read as "not enabled" — which would make a machine whose manager is down look clean.
      expect(await probe(linux(active("inactive", "inactive"), { code: 1, out: "", err: BUS_257 }), "linux")).toEqual(down);
      expect(await probe(linux({ code: 1, err: BUS_257 }, { code: 1, err: BUS_257 }), "linux")).toEqual(down);
      expect(await probe(linux({ code: 1, err: "XDG_RUNTIME_DIR is not set" }, enabledWord("disabled")), "linux")).toEqual(down);
      // First means first: a manager error beats a running word on the other command.
      expect(await probe(linux(active("active", "active", 0), { code: 1, err: BUS_257 }), "linux")).toEqual(down);
      // "followed later on the SAME line by bus": across a line break it is not a bus error.
      expect(await probe(linux(active("inactive", "inactive"), { code: 1, out: "", err: "Failed to connect to the thing\nbus is fine" }), "linux"))
        .toEqual(unknown("unexpected"));
    });

    test("-1 and -2 are no answer before any rule; a thrown exec counts as -2", async () => {
      expect(await probe(linux({ hang: true }, { hang: true }), "linux")).toEqual(unknown("timeout"));
      expect(await probe(linux({ code: -2 }, enabledWord("disabled")), "linux")).toEqual(unknown("spawn"));
      // A -1 that happens to carry older systemd's not-found text is still no answer, never "not enabled".
      expect(await probe(linux(active("inactive", "inactive"), { code: -1, out: "", err: OLD_NOT_FOUND }), "linux")).toEqual(unknown("timeout"));
      // …but a real answer from the other command still counts: an enabled timer is present.
      expect(await probe(linux({ hang: true }, enabledWord("enabled", 0)), "linux")).toEqual(present);
      const boom: Exec = async () => { throw new Error("no such binary"); };
      expect(await probeRegistration(deps("linux", boom), { timeoutMs: T })).toEqual(unknown("spawn"));
    });
  });

  test("Windows (status only, spec 3.1.10): /Query exit 0 present, a real non-zero gone, -1 or -2 unknown", async () => {
    const q = (a: Scripted) => fakeExec({ "/Query": a });
    const f = q({ code: 0 });
    expect(await probe(f, "win32")).toEqual(present);
    expect(f.calls.map((c) => c.join(" "))).toEqual([`schtasks /Query /TN ${WINDOWS_TASK_NAME}`]);
    expect(f.timeouts).toEqual([T]);
    expect(await probe(q({ code: 1, err: "ERROR: The system cannot find the file specified." }), "win32")).toEqual(gone);
    expect(await probe(q({ hang: true }), "win32")).toEqual(unknown("timeout"));
    expect(await probe(q({ code: -2 }), "win32")).toEqual(unknown("spawn"));
  });

  test("an exec that throws SYNCHRONOUSLY — before it returns a promise — counts as -2 too, on every platform: unknown(spawn), never a throw", async () => {
    // A `.catch` chained onto the exec's result never sees this throw, so the CALL itself must sit inside the
    // try (spec 3.1.4: a thrown exec counts as -2).
    const syncBoom: Exec = () => { throw new Error("threw before it returned"); };
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(await probeRegistration(deps(platform, syncBoom), { timeoutMs: T })).toEqual(unknown("spawn"));
    }
  });

  test("an unsupported platform is unknown(unexpected), and nothing runs", async () => {
    const f = fakeExec();
    expect(await probe(f, "freebsd")).toEqual(unknown("unexpected"));
    expect(f.calls).toEqual([]);
  });
});

describe("lingerState's timeout (status caps it at 5 s, spec 3.1.5)", () => {
  test("a caller's timeout reaches its one exec, and without one none is passed", async () => {
    const f = fakeExec({ "show-user": { out: "Linger=yes\n" } });
    const d = resolveScheduleDeps(deps("linux", f.exec));
    expect(await lingerState(d, { timeoutMs: 5_000 })).toBe("enabled");
    expect(await lingerState(d)).toBe("enabled");
    expect(f.timeouts).toEqual([5_000, undefined]);
  });

  test("a hung loginctl is 'unknown', never a guess", async () => {
    const f = fakeExec({ "show-user": { hang: true } });
    expect(await lingerState(resolveScheduleDeps(deps("linux", f.exec)), { timeoutMs: 5_000 })).toBe("unknown");
    expect(CLOCK).toBe(CLOCK_START + 5_000);
  });

  test("an exec that throws SYNCHRONOUSLY is 'unknown' too, with or without a timeout — never a throw out of lingerState", async () => {
    const syncBoom: Exec = () => { throw new Error("threw before it returned"); };
    const d = resolveScheduleDeps(deps("linux", syncBoom));
    expect(await lingerState(d, { timeoutMs: 5_000 })).toBe("unknown");
    expect(await lingerState(d)).toBe("unknown");
  });
});

// ── ⚠ THE MANUAL STEPS (spec 3.1.8). One pure function builds them for this machine's paths; stderr and
// `schedule status`'s `removeSteps` both carry its text, and a user pastes it into a shell — so every
// path argument is quoted to survive any POSIX shell (`"$HOME"/'…'` under home, `'…'` otherwise, `'` as
// `'\''`), and the text never depends on the home path itself. No closing line: each surface adds its own.
// A pure helper, given paths as plain parameters: no exec, no file is touched.
describe("manualRemoveSteps — the steps a user runs by hand (spec 3.1.8)", () => {
  const FRAMING = "Run these in a terminal (bash or zsh) inside your desktop session.";
  const HOME_FORM = '"$HOME"/';
  const unquote = (q: string) => q.slice(1, -1).replaceAll("'\\''", "'");
  /** A quoted argument back to the path it names, as a shell would read it. */
  const decode = (arg: string, home: string) =>
    arg.startsWith(HOME_FORM) ? `${home}/${unquote(arg.slice(HOME_FORM.length))}` : unquote(arg);

  /** The path arguments of the text's ONE `rm -f --` command, as written. Each must be exactly
   *  `"$HOME"/'…'` or `'…'` (with `'\''` inside), and after the last one only `;` or the end may follow —
   *  so any other spelling of an argument fails the parse rather than being skipped. */
  function rmArgs(text: string): { args: string[]; tail: string } {
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("rm "));
    expect(lines.length).toBe(1);
    expect(lines[0]!.startsWith("rm -f -- ")).toBe(true);
    const rest = lines[0]!.slice("rm -f -- ".length);
    const word = /\s*((?:"\$HOME"\/)?'(?:[^']|'\\'')*')/y;
    const args: string[] = [];
    let at = 0;
    for (let m = word.exec(rest); m; m = word.exec(rest)) { args.push(m[1]!); at = word.lastIndex; }
    const tail = rest.slice(at);
    expect(`tail after the paths: ${JSON.stringify(tail)}`).toMatch(/^tail after the paths: "(?:;.*)?"$/);
    return { args, tail };
  }

  const MAC_HOME = "/Users/a";
  const PLIST = join(MAC_HOME, "Library", "LaunchAgents", `${SCHEDULE_LABEL}.plist`);
  const MAC_RECORD = join(MAC_HOME, "Library", "Application Support", "daily-briefing", "schedule.json");
  const mac = (units = [PLIST], record = MAC_RECORD, home = MAC_HOME) => manualRemoveSteps("launchd", { units, record, home });

  const LINUX_HOME = "/home/u";
  const LINUX_UNITS = unitPaths("linux", {} as NodeJS.ProcessEnv, LINUX_HOME);   // [service, timer], the engine's order
  const LINUX_RECORD = join(LINUX_HOME, ".local", "state", "daily-briefing", "schedule.json");
  const linux = () => manualRemoveSteps("systemd", { units: LINUX_UNITS, record: LINUX_RECORD, home: LINUX_HOME });

  test("macOS: framed, unregister by label in both domains, wait, confirm, then delete", () => {
    const text = mac();
    const lines = text.split("\n").map((l) => l.trim());
    expect(lines[0]).toBe(FRAMING);
    expect(lines).toContain(`launchctl bootout gui/$(id -u)/${SCHEDULE_LABEL}; launchctl bootout user/$(id -u)/${SCHEDULE_LABEL}`);
    // Confirm: each command followed by `; echo "exit $?"`, so a silent exit 113 also shows.
    const confirm = [
      `launchctl print gui/$(id -u)/${SCHEDULE_LABEL}; echo "exit $?"`,
      `launchctl print user/$(id -u)/${SCHEDULE_LABEL}; echo "exit $?"`,
      `launchctl list ${SCHEDULE_LABEL}; echo "exit $?"`,
    ];
    for (const c of confirm) expect(lines).toContain(c);
    expect(text).toContain("Could not find service");
    expect(text).toContain("exit 113");
    expect(text).toContain("Could not find domain");
    // A job `list` still finds in some other session context: removed by label, from the same terminal.
    expect(lines).toContain(`launchctl remove ${SCHEDULE_LABEL}`);
    // The order the spec gives: unregister, wait, confirm, delete.
    const at = (s: string) => lines.findIndex((l) => l.includes(s));
    expect(at("bootout gui/")).toBeLessThan(at("Wait a few seconds"));
    expect(at("Wait a few seconds")).toBeLessThan(at("print gui/"));
    expect(at("print gui/")).toBeLessThan(at("rm -f --"));
    // Never the legacy unload, which acts on whatever job the file at the path names.
    expect(text).not.toContain("unload");
  });

  test("macOS: the default paths come out as \"$HOME\"/'…', and decode back to the paths given", () => {
    const { args, tail } = rmArgs(mac());
    expect(tail).toBe("");
    expect(args).toEqual([
      HOME_FORM + "'" + join("Library", "LaunchAgents", `${SCHEDULE_LABEL}.plist`) + "'",
      HOME_FORM + "'" + join("Library", "Application Support", "daily-briefing", "schedule.json") + "'",
    ]);
    expect(args.map((a) => decode(a, MAC_HOME))).toEqual([PLIST, MAC_RECORD]);
    expect(mac()).not.toContain("~");   // never a quoted, unexpanded ~
  });

  test("Linux: framed, stop then disable, confirm by words with NO echo suffix, then delete, reload and reset-failed", () => {
    const text = linux();
    const lines = text.split("\n").map((l) => l.trim());
    expect(lines[0]).toBe(FRAMING);
    expect(lines).toContain(`systemctl --user stop ${SYSTEMD_TIMER_NAME} ${SYSTEMD_SERVICE_NAME}; systemctl --user disable ${SYSTEMD_TIMER_NAME}`);
    expect(lines).toContain(`systemctl --user is-active ${SYSTEMD_TIMER_NAME} ${SYSTEMD_SERVICE_NAME}`);
    expect(lines).toContain(`systemctl --user is-enabled ${SYSTEMD_TIMER_NAME}`);
    for (const w of ["inactive", "failed", "unknown", "static", "disabled", "linked", "linked-runtime", "masked", "masked-runtime", "bad", "not-found"]) {
      expect(text).toContain(w);
    }
    // The Linux confirm commands print their words; the `echo "exit $?"` suffix is macOS-only.
    expect(text).not.toContain("echo");
    const { args, tail } = rmArgs(text);
    // The timer first, as spec 3.1.8 writes it, though `unitPaths` lists the service first.
    expect(args.map((a) => decode(a, LINUX_HOME))).toEqual([LINUX_UNITS[1]!, LINUX_UNITS[0]!, LINUX_RECORD]);
    for (const a of args) expect(a.startsWith(HOME_FORM)).toBe(true);
    expect(tail).toBe(`; systemctl --user daemon-reload; systemctl --user reset-failed ${SYSTEMD_TIMER_NAME} ${SYSTEMD_SERVICE_NAME}`);
    expect(text).not.toContain("~");
  });

  test("the echo suffix sits on exactly the three macOS confirm commands", () => {
    const suffixed = mac().split("\n").map((l) => l.trim()).filter((l) => l.includes('echo "exit $?"'));
    expect(suffixed.length).toBe(3);
    for (const l of suffixed) expect(l).toMatch(/^launchctl (?:print (?:gui|user)\/\$\(id -u\)\/|list )/);
  });

  test("an apostrophe in a path is escaped as '\\'', inside and outside home, and round-trips", () => {
    const unit = join(MAC_HOME, "Library", "O'Brien Agents", `${SCHEDULE_LABEL}.plist`);
    const record = join("/Volumes", "it's here", "schedule.json");
    const { args } = rmArgs(mac([unit], record));
    expect(args).toEqual([
      HOME_FORM + "'" + "Library/O'\\''Brien Agents/" + SCHEDULE_LABEL + ".plist'",
      "'/Volumes/it'\\''s here/schedule.json'",
    ]);
    expect(args.map((a) => decode(a, MAC_HOME))).toEqual([unit, record]);
  });

  test("home is claimed by PATH BOUNDARY: /Users/a never claims /Users/ab/…, nor the home itself", () => {
    const { args } = rmArgs(mac([join("/Users/ab", "LaunchAgents", "x.plist")], "/Users/a"));
    expect(args).toEqual(["'/Users/ab/LaunchAgents/x.plist'", "'/Users/a'"]);
    // A home written with a trailing slash still claims what is under it.
    const trailing = rmArgs(mac([PLIST], MAC_RECORD, `${MAC_HOME}/`)).args;
    expect(trailing.map((a) => decode(a, MAC_HOME))).toEqual([PLIST, MAC_RECORD]);
    for (const a of trailing) expect(a.startsWith(HOME_FORM)).toBe(true);
  });

  test("no closing line: the steps end at the delete step, and the CLI closing line is a separate constant", () => {
    for (const text of [mac(), linux()]) {
      expect(text.endsWith("\n")).toBe(false);
      expect(text.split("\n").at(-1)!.trim().startsWith("rm -f -- ")).toBe(true);
      expect(text).not.toContain("Then run");
      expect(text).not.toContain("Then press");
    }
    expect(MANUAL_STEPS_CLI_CLOSING).toBe("Then run `daily-briefing schedule uninstall` again.");
  });
});

// ── ⚠ UNINSTALL (Batch 2, spec 3.1). Success is a check AFTER the fact that finds the job gone, never a
// command that returned 0, and no file is deleted before that check says `gone`. Every test here calls
// `uninstallSchedule` through `deps()` — the fake exec (via `launchdJob` / `systemdJob` or `fakeExec`), the
// scratch HOME, the helper env, uid 4242, and the test clock and sleep — so nothing real is reached and no
// test waits in real time.

/** Spec 3.1.4, checked call by call: each exec's `timeoutMs` is EXACTLY the time left before its limit,
 *  capped — 5 s against the polling end (entry + 30 s) for the first check, the unregister commands and the
 *  polled checks; 3 s against the deadline (entry + 45 s) for deletion, which starts at call `deleteFrom` —
 *  and none started with under 250 ms left. */
function expectTimeoutsFit(f: { calls: string[][]; timeouts: Array<number | undefined>; at: number[] }, entry: number, deleteFrom = Infinity) {
  expect(f.calls.length).toBeGreaterThan(0);
  f.calls.forEach((c, i) => {
    const deleting = i >= deleteFrom;
    const left = entry + (deleting ? 45_000 : 30_000) - f.at[i]!;
    const want = Math.min(deleting ? 3_000 : 5_000, left);
    expect(`#${i} ${c.join(" ")} @+${f.at[i]! - entry}: timeout ${f.timeouts[i]}, ≥250 left ${left >= 250}`)
      .toBe(`#${i} ${c.join(" ")} @+${f.at[i]! - entry}: timeout ${want}, ≥250 left true`);
  });
}

const STEPS_FRAMING = "Run these in a terminal (bash or zsh) inside your desktop session.";
const APP_REFUSAL = /^This background scheduler wasn't set up by this app \((.+)\)\. Removing it needs your go-ahead\.$/;
/** The manual steps for this test's paths, exactly as `uninstallSchedule` must print them. */
const stepsFor = (platform: "darwin" | "linux") =>
  manualRemoveSteps(platform === "darwin" ? "launchd" : "systemd", { units: unitPaths(platform, env(), HOME), record: schedulePath(), home: HOME });
const BUS_ERROR = "Failed to connect to bus: No medium found";

describe("uninstall — the gate and what counts as installed (spec 3.1.1, 3.1.2)", () => {
  for (const platform of ["darwin", "linux"] as const) {
    test(`${platform}: nothing on disk and the check says gone → exit 1 with its stdout line, and only the read-only check ran`, async () => {
      const f = platform === "darwin" ? launchdJob(false) : systemdJob(false, false);
      expect(await uninstallSchedule({}, deps(platform, f.exec))).toBe(EXIT_NONE);
      expect(said).toEqual(["Nothing installed by daily-briefing was found."]);
      expect(warned).toEqual([]);
      expect(f.calls.length).toBe(platform === "darwin" ? 3 : 2);
      expect(f.calls.filter((c) => isRegistrationChange(c))).toEqual([]);
    });

    test(`${platform}: a registered job with NO files is installed — the check finds it, it is unregistered, and the run exits 0`, async () => {
      const f = platform === "darwin" ? launchdJob(true) : systemdJob(true, true);
      expect(await uninstallSchedule({}, deps(platform, f.exec))).toBe(EXIT_OK);
      // The terminal's exit 0: spec 3.1.6's line, then the terminal-only note about the engine copy. (Only
      // its start is asserted: isolation.meta.test.ts reads a test naming that script as one spawning it.)
      expect(said.length).toBe(2);
      expect(said[0]).toBe("Removed the background scheduler.");
      expect(said[1]).toStartWith("The engine binary itself was left in place");
      // The first check ran BEFORE anything changed: a registration with no files is only seen that way.
      expect(isRegistrationChange(f.calls[0]!)).toBe(false);
      expect(f.calls.filter((c) => isRegistrationChange(c)).length).toBeGreaterThan(0);
    });
  }

  test("a record but no unit file: there is NO first check — unregister runs at once", async () => {
    await writeRecord("cli");
    const f = launchdJob(true);
    expect(await uninstallSchedule({}, deps("darwin", f.exec))).toBe(EXIT_OK);
    expect(f.calls[0]!.join(" ")).toBe(`launchctl bootout gui/4242/${SCHEDULE_LABEL}`);
    expect(await pathPresent(schedulePath())).toBe(false);
  });

  test("a unit file but no record: no first check either, and the unit is removed", async () => {
    const [timer, service] = [join(UNITS, SYSTEMD_TIMER_NAME), join(UNITS, SYSTEMD_SERVICE_NAME)];
    writeUnits("linux");
    const f = systemdJob(true, true);
    expect(await uninstallSchedule({}, deps("linux", f.exec))).toBe(EXIT_OK);
    expect(f.calls[0]!.join(" ")).toBe(`systemctl --user stop ${SYSTEMD_TIMER_NAME} ${SYSTEMD_SERVICE_NAME}`);
    expect([existsSync(timer), existsSync(service)]).toEqual([false, false]);
  });

  // An UNREADABLE record still counts as installed (spec 3.1.2): present by `lstat`, its owner unknown,
  // never read. From the terminal the gate is unchanged, so it is removed like any other.
  const UNREADABLE: Array<[string, () => void]> = [
    ["malformed", () => writeFileSync(schedulePath(), '{"owner":"cli","unitPa')],
    ["a dangling symlink", () => symlinkSync(join(STATE, "nowhere.json"), schedulePath())],
    ["oversized (valid JSON, over 64 KiB)", () => writeFileSync(schedulePath(), JSON.stringify({ owner: "cli", unitPath: "/u" }) + " ".repeat(64 * 1024))],
    ["an empty directory", () => mkdirSync(schedulePath())],
  ];
  for (const [what, make] of UNREADABLE) {
    test(`terminal: an unreadable record (${what}) counts as installed, is removed, and the run exits 0`, async () => {
      make();
      const f = launchdJob(true);
      expect(await uninstallSchedule({ invoker: "cli" }, deps("darwin", f.exec))).toBe(EXIT_OK);
      expect(f.calls[0]![1]).toBe("bootout");   // a file on disk: no first check
      expect(await pathPresent(schedulePath())).toBe(false);
    });
  }

  test("a symlink at the record path is unlinked, never followed: its target survives", async () => {
    const target = join(STATE, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ owner: "cli", invoker: "cli", kind: "launchd", unitPath: "/u" }));
    symlinkSync(target, schedulePath());
    const f = launchdJob(true);
    expect(await uninstallSchedule({}, deps("darwin", f.exec))).toBe(EXIT_OK);
    expect(await pathPresent(schedulePath())).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  test("terminal gate UNCHANGED: an app record is refused without --take-over (exit 2, no exec), and removed with it", async () => {
    await writeRecord("app");
    const plist = writeUnits("darwin")[0]!;
    const f = launchdJob(true);
    expect(await uninstallSchedule({ invoker: "cli" }, deps("darwin", f.exec))).toBe(EXIT_FOREIGN);
    expect(f.calls).toEqual([]);
    expect(warned).toEqual([`schedule uninstall: the trigger is owned by "app", not "cli" — removing only what we own. Re-run with --take-over to remove it anyway.`]);
    warned.length = 0;
    expect(await uninstallSchedule({ invoker: "cli", takeOver: true }, deps("darwin", f.exec))).toBe(EXIT_OK);
    expect([existsSync(plist), await pathPresent(schedulePath())]).toEqual([false, false]);
  });

  // ── `--invoker app` without `--take-over` (spec 3.1.1): exit 2 whenever something is installed and the
  // record is not readable as owned by `app`, with the fixed text naming what was found — the unit paths,
  // or, with no file at all, the loaded job. The app's foreign-owner dialog shows this text verbatim
  // (spec 3.4.3). With a file on disk the gate decides before ANY exec.
  describe("--invoker app without --take-over: exit 2 for anything the app did not set up", () => {
    test("a terminal (cli) record, with its plist", async () => {
      await writeRecord("cli");
      const plist = writeUnits("darwin")[0]!;
      const f = launchdJob(true);
      expect(await uninstallSchedule({ invoker: "app" }, deps("darwin", f.exec))).toBe(EXIT_FOREIGN);
      expect(f.calls).toEqual([]);
      expect(warned.length).toBe(1);
      const found = APP_REFUSAL.exec(warned[0]!)?.[1];
      expect(found).toBe(`a schedule record set up from the terminal at ${schedulePath()}, and the unit file ${plist}`);
      expect([existsSync(plist), await pathPresent(schedulePath())]).toEqual([true, true]);
    });

    for (const [what, make] of UNREADABLE) {
      test(`an unreadable record (${what}), with no unit file`, async () => {
        make();
        const f = launchdJob(true);
        expect(await uninstallSchedule({ invoker: "app" }, deps("darwin", f.exec))).toBe(EXIT_FOREIGN);
        expect(f.calls).toEqual([]);
        expect(APP_REFUSAL.exec(warned[0]!)?.[1]).toBe(`a schedule record that can't be read at ${schedulePath()}, with no unit file`);
        expect(await pathPresent(schedulePath())).toBe(true);
      });
    }

    test("a unit with no record names the unit files (Linux: both)", async () => {
      const [service, timer] = writeUnits("linux");
      const f = systemdJob(true, true);
      expect(await uninstallSchedule({ invoker: "app" }, deps("linux", f.exec))).toBe(EXIT_FOREIGN);
      expect(f.calls).toEqual([]);
      expect(APP_REFUSAL.exec(warned[0]!)?.[1]).toBe(`the unit files ${service} and ${timer}, with no schedule record`);
      expect([existsSync(service!), existsSync(timer!)]).toEqual([true, true]);
    });

    for (const [platform, found] of [["darwin", "a loaded job with no files"], ["linux", "a timer and service with no files"]] as const) {
      test(`${platform}: a registration with no files — "${found}" — after only the read-only check`, async () => {
        const f = platform === "darwin" ? launchdJob(true) : systemdJob(true, false);
        expect(await uninstallSchedule({ invoker: "app" }, deps(platform, f.exec))).toBe(EXIT_FOREIGN);
        expect(f.calls.length).toBe(platform === "darwin" ? 3 : 2);
        expect(f.calls.filter((c) => isRegistrationChange(c))).toEqual([]);
        expect(APP_REFUSAL.exec(warned[0]!)?.[1]).toBe(found);
      });
    }

    test("the app's OWN record is removed, and --take-over removes a terminal one", async () => {
      await writeRecord("app");
      writeUnits("darwin");
      expect(await uninstallSchedule({ invoker: "app" }, deps("darwin", launchdJob(true).exec))).toBe(EXIT_OK);
      expect(await pathPresent(schedulePath())).toBe(false);
      // The app shows exit-0 stdout verbatim: exactly spec 3.1.6's one line, never the terminal's note
      // telling the user to run a shell script.
      expect(said).toEqual(["Removed the background scheduler."]);

      said.length = 0;
      await writeRecord("cli");
      writeUnits("darwin");
      expect(await uninstallSchedule({ invoker: "app", takeOver: true }, deps("darwin", launchdJob(true).exec))).toBe(EXIT_OK);
      expect(await pathPresent(schedulePath())).toBe(false);
      expect(said).toEqual(["Removed the background scheduler."]);
    });

    test("nothing on disk and the check says gone is still exit 1, not a refusal", async () => {
      expect(await uninstallSchedule({ invoker: "app" }, deps("darwin", launchdJob(false).exec))).toBe(EXIT_NONE);
      expect(said).toEqual(["Nothing installed by daily-briefing was found."]);
    });
  });

  // ── nothing on disk and the check stays `unknown` (spec 3.1.2): exit 3 with the manual steps, never 1.
  test("nothing on disk, unknown(unexpected): exit 3, the reason first, then the steps and the terminal's closing line", async () => {
    const f = launchdJob(false, { script: { "list ": { code: 1 } } });   // list exits 1 with an empty stderr: no answer
    expect(await uninstallSchedule({}, deps("darwin", f.exec))).toBe(EXIT_ERROR);
    expect(said).toEqual([]);
    const text = warned.join("\n");
    expect(text.split("\n")[0]).toBe("Couldn't check whether a background scheduler is registered (unexpected). Nothing was removed.");
    expect(text.endsWith(`${stepsFor("darwin")}\n${MANUAL_STEPS_CLI_CLOSING}`)).toBe(true);
    expect(f.calls.filter((c) => isRegistrationChange(c))).toEqual([]);
  });

  for (const [platform, reason] of [["linux", "no-user-manager"], ["darwin", "no-gui-session"]] as const) {
    test(`nothing on disk, a STABLE reason (${reason}): stderr begins "Run these in a terminal", after one check and no polling`, async () => {
      const f = platform === "linux"
        ? systemdJob(false, false, { script: { "is-active": { code: 1, err: BUS_ERROR } } })
        : launchdJob(false, { script: { "print gui/": { code: 113, err: "Could not find domain for port identifier: 4242" } } });
      expect(await uninstallSchedule({}, deps(platform, f.exec))).toBe(EXIT_ERROR);
      const text = warned.join("\n");
      expect(text.startsWith(`${STEPS_FRAMING}\n`)).toBe(true);
      expect(text.startsWith(`${stepsFor(platform)}\n${MANUAL_STEPS_CLI_CLOSING}\n`)).toBe(true);
      expect(text.endsWith(`Couldn't check whether a background scheduler is registered (${reason}). Nothing was removed.`)).toBe(true);
      expect(SLEEPS).toBe(0);
      expect(f.calls.length).toBe(platform === "darwin" ? 3 : 2);
    });
  }

  test("--invoker app gets the steps with NO closing line: the app adds its own", async () => {
    const f = systemdJob(false, false, { script: { "is-active": { code: 1, err: BUS_ERROR } } });
    expect(await uninstallSchedule({ invoker: "app" }, deps("linux", f.exec))).toBe(EXIT_ERROR);
    const text = warned.join("\n");
    expect(text.startsWith(`${stepsFor("linux")}\n`)).toBe(true);
    expect(text).not.toContain("Then run");
  });

  test("a throw inside the routine exits 3, never escapes it", async () => {
    const f = launchdJob(false, { script: { "list ": { code: 1 } } });   // unknown(unexpected): it will sleep
    const boom = async () => { throw new Error("the clock broke"); };
    expect(await uninstallSchedule({}, deps("darwin", f.exec, { sleep: boom }))).toBe(EXIT_ERROR);
    expect(warned.join("\n")).toContain("schedule uninstall failed: the clock broke");
  });
});

describe("uninstall — unregister, the deadline and polling (spec 3.1.3, 3.1.4)", () => {
  test("Linux: stop both units, then disable the timer — disable's not-found ignored — then the check, the reload and the scoped reset-failed", async () => {
    await writeRecord("cli", "linux");
    writeUnits("linux");
    const f = systemdJob(true, true, { script: { "--user disable": { code: 1, err: `Failed to disable unit: Unit file ${SYSTEMD_TIMER_NAME} does not exist.` } } });
    expect(await uninstallSchedule({}, deps("linux", f.exec))).toBe(EXIT_OK);
    const both = `${SYSTEMD_TIMER_NAME} ${SYSTEMD_SERVICE_NAME}`;
    expect(f.calls.map((c) => c.join(" "))).toEqual([
      `systemctl --user stop ${both}`,
      `systemctl --user disable ${SYSTEMD_TIMER_NAME}`,
      `systemctl --user is-active ${both}`,
      `systemctl --user is-enabled ${SYSTEMD_TIMER_NAME}`,
      "systemctl --user daemon-reload",
      `systemctl --user reset-failed ${both}`,
      `systemctl --user is-active ${both}`,
      `systemctl --user is-enabled ${SYSTEMD_TIMER_NAME}`,
    ]);
    expect(said[0]).toBe("Removed the background scheduler.");
  });

  test("every unregister command's own failure is ignored — a code, a refusal, a throw — and the check decides", async () => {
    await writeRecord("cli");
    const plist = writeUnits("darwin")[0]!;
    const f = launchdJob(true, { script: { "bootout gui/": { code: 5, err: "Boot-out failed: 5: Input/output error" } } });
    const exec: Exec = async (cmd, o) => {
      const r = await f.exec(cmd, o);
      if (cmd[1] === "bootout" && cmd[2]!.startsWith("user/")) throw new Error("bootout was killed");
      return r;
    };
    expect(await uninstallSchedule({}, deps("darwin", exec))).toBe(EXIT_OK);
    expect([existsSync(plist), await pathPresent(schedulePath())]).toEqual([false, false]);
  });

  // ⚠ A SYNCHRONOUS throw — the exec throws before it has returned a promise, so no `.catch` on its result can
  // see it — is still a thrown exec, and so -2 (spec 3.1.4): an ignored unregister failure, never the routine's
  // catch-all. Non-async fakes, on purpose.
  for (const platform of ["darwin", "linux"] as const) {
    test(`${platform}: an unregister exec that throws SYNCHRONOUSLY is ignored like any other failure — the routine goes on to its check`, async () => {
      await writeRecord("cli", platform);
      const units = writeUnits(platform);
      const f = platform === "darwin" ? launchdJob(false) : systemdJob(false, false);
      const unregisterVerbs = ["bootout", "stop", "disable"];
      const thrown: string[] = [];
      const exec: Exec = (cmd, o) => {
        if (unregisterVerbs.includes(cmd[1]!) || unregisterVerbs.includes(cmd[2]!)) {
          thrown.push(cmd.join(" "));
          throw new Error("threw before it returned");
        }
        return f.exec(cmd, o);
      };
      expect(await uninstallSchedule({}, deps(platform, exec))).toBe(EXIT_OK);
      expect(thrown.length).toBe(2);   // both unregister commands were tried, and each threw
      expect(isRegistrationChange(f.calls[0]!)).toBe(false);   // …and the next thing that ran was the check
      for (const p of [...units, schedulePath()]) expect(`${p}: ${await pathPresent(p)}`).toBe(`${p}: false`);
      expect(warned.join("\n")).not.toContain("schedule uninstall failed");
    });
  }

  test("Linux: a daemon-reload that throws SYNCHRONOUSLY after the units went ends in 3.1.7's text — what this attempt removed, the record kept — never the catch-all", async () => {
    await writeRecord("cli", "linux");
    const [service, timer] = writeUnits("linux");
    const f = systemdJob(true, true);
    const exec: Exec = (cmd, o) => {
      if (cmd[2] === "daemon-reload") throw new Error("the reload threw before it returned");
      return f.exec(cmd, o);
    };
    expect(await uninstallSchedule({}, deps("linux", exec))).toBe(EXIT_ERROR);
    expect(await pathPresent(schedulePath())).toBe(true);
    const text = warned.join("\n");
    expect(text).toContain("Couldn't finish removing the background scheduler: systemctl --user daemon-reload failed (-2): Error: the reload threw before it returned.");
    expect(text).toContain(`This attempt removed: ${service}, ${timer}.`);
    expect(text).toContain("The schedule record was kept, so running the removal again starts over by name.");
    expect(text).not.toContain("schedule uninstall failed");
  });

  test("it polls every 500 ms while the job is still present, and deletes only once the check says gone", async () => {
    await writeRecord("cli");
    const plist = writeUnits("darwin")[0]!;
    const f = launchdJob(true, { stuck: true });
    let checks = 0;
    f.onCall("print gui/", () => {
      checks++;
      // Nothing may be deleted while the check still says present.
      expect([existsSync(plist), existsSync(schedulePath())]).toEqual([true, true]);
      if (checks === 3) f.set(false);   // launchd lets go of it on its own, a moment later
    });
    expect(await uninstallSchedule({}, deps("darwin", f.exec))).toBe(EXIT_OK);
    expect(NAPS).toEqual([500, 500]);
    expect([existsSync(plist), existsSync(schedulePath())]).toEqual([false, false]);
  });

  test("still present at the polling end: exit 3, NOTHING deleted, the record kept, stderr says what remains", async () => {
    await writeRecord("cli");
    const plist = writeUnits("darwin")[0]!;
    const f = launchdJob(true, { stuck: true });
    const entry = CLOCK;
    expect(await uninstallSchedule({}, deps("darwin", f.exec))).toBe(EXIT_ERROR);
    expect([existsSync(plist), existsSync(schedulePath())]).toEqual([true, true]);
    expect(SLEEPS).toBeGreaterThan(50);
    expect(NAPS.every((n) => n === 500)).toBe(true);
    expect(CLOCK - entry).toBeLessThanOrEqual(30_000);
    const text = warned.join("\n");
    const lines = text.split("\n");
    expect(lines[0]).toStartWith("Couldn't finish removing the background scheduler:");
    expect(text).toContain(`Still present: ${plist}; ${schedulePath()}; the registered job ${SCHEDULE_LABEL}.`);
    expect(text).toContain("This attempt removed no files.");
    expect(text).toContain("Registration check: still registered.");
    // Not a stable reason, so the details lead and the steps end it, then the terminal's closing line.
    expect(text.endsWith(`${stepsFor("darwin")}\n${MANUAL_STEPS_CLI_CLOSING}`)).toBe(true);
    expectTimeoutsFit(f, entry);
  });

  for (const platform of ["linux", "darwin"] as const) {
    test(`${platform}: a STABLE reason after unregister stops polling at once, keeps the files, and leads with the steps`, async () => {
      await writeRecord("cli", platform);
      const units = writeUnits(platform);
      const f = platform === "linux"
        ? systemdJob(true, true, { script: { "is-enabled": { code: 1, err: BUS_ERROR } } })
        : launchdJob(true, { script: { "print gui/": { code: 113, err: "Could not find domain for port identifier: 4242" } } });
      expect(await uninstallSchedule({}, deps(platform, f.exec))).toBe(EXIT_ERROR);
      expect(SLEEPS).toBe(0);
      for (const p of [...units, schedulePath()]) expect(`${p} kept: ${existsSync(p)}`).toBe(`${p} kept: true`);
      const text = warned.join("\n");
      expect(text.startsWith(`${stepsFor(platform)}\n${MANUAL_STEPS_CLI_CLOSING}\n`)).toBe(true);
      const reason = platform === "linux" ? "no-user-manager" : "no-gui-session";
      expect(text.endsWith(`Registration check: couldn't tell (${reason}).\nThe schedule record was kept, so running the removal again starts over by name.`)).toBe(true);
    });
  }

  test("nothing on disk and unknown(timeout): it polls to the polling end, then exits 3 — never past it", async () => {
    const f = launchdJob(false, { script: { "list ": { hang: true } } });
    const entry = CLOCK;
    expect(await uninstallSchedule({}, deps("darwin", f.exec))).toBe(EXIT_ERROR);
    expect(SLEEPS).toBe(5);   // rounds at +0, +5.5, +11, +16.5, +22, +27.5 s; the last list is cut to 2.5 s
    expect(CLOCK - entry).toBe(30_000);
    expect(warned.join("\n").split("\n")[0]).toBe("Couldn't check whether a background scheduler is registered (timeout). Nothing was removed.");
    expect(f.calls.filter((c) => isRegistrationChange(c))).toEqual([]);
    expectTimeoutsFit(f, entry);
  });

  for (const platform of ["darwin", "linux"] as const) {
    test(`${platform}: simulated time never passes 45 s, even when EVERY command hangs`, async () => {
      await writeRecord("cli", platform);
      writeUnits(platform);
      const f = fakeExec({ "": { hang: true } });
      const entry = CLOCK;
      expect(await uninstallSchedule({}, deps(platform, f.exec))).toBe(EXIT_ERROR);
      expect(CLOCK - entry).toBeLessThanOrEqual(45_000);
      expect(CLOCK - entry).toBe(30_000);   // nothing was ever gone, so nothing ran past the polling end
      expectTimeoutsFit(f, entry);
      expect(warned.join("\n")).toContain("Registration check: couldn't tell (timeout).");
    });
  }

  test("a deletion that starts just before the polling end still gets 3 s execs, against the deadline — and fits it", async () => {
    await writeRecord("cli", "linux");
    const [service, timer] = writeUnits("linux");
    const entry = CLOCK;
    // stop and disable hang (5 s each); the job lets go only from +29.4 s, so the check at +29.5 s — the
    // last that fits before the polling end — is the first to say gone. Deletion then starts 500 ms before
    // the polling end: the reload takes its full 3 s and succeeds, and reset-failed and the final check hang.
    let reloaded = false;
    const f = fnExec((cmd) => {
      if (cmd.includes("stop") || cmd.includes("disable") || cmd.includes("reset-failed")) return { hang: true };
      if (cmd.includes("daemon-reload")) { reloaded = true; return { latencyMs: 3_000 }; }
      if (reloaded) return { hang: true };
      const gone = CLOCK - entry >= 29_400;
      if (cmd.includes("is-active")) return gone ? { code: 3, out: "inactive\ninactive\n" } : { out: "active\nactive\n" };
      return gone ? { code: 1, out: "disabled\n" } : { out: "enabled\n" };
    });
    expect(await uninstallSchedule({}, deps("linux", f.exec))).toBe(EXIT_ERROR);
    const del = f.calls.findIndex((c) => c.includes("daemon-reload"));
    expect(f.at[del]! - entry).toBe(29_500);
    expect(f.calls.slice(del).map((c) => c[2])).toEqual(["daemon-reload", "reset-failed", "is-active", "is-enabled"]);
    expect(f.timeouts.slice(del)).toEqual([3_000, 3_000, 3_000, 3_000]);
    expect(CLOCK - entry).toBe(41_500);
    expectTimeoutsFit(f, entry, del);
    // The final check never said gone, so the record stays; the units went before the reload.
    expect([existsSync(service!), existsSync(timer!), await pathPresent(schedulePath())]).toEqual([false, false, true]);
    expect(warned.join("\n")).toContain(`This attempt removed: ${service}, ${timer}.`);
  });

  test("a skipped exec reads as -1 (no answer), never as not-found: under 250 ms left, nothing runs and nothing is deleted", async () => {
    await writeRecord("cli");
    const plist = writeUnits("darwin")[0]!;
    const entry = CLOCK;
    // The two bootouts and the first check's three commands all hang: +25 s. The second check starts at
    // +25.5 s and its `print gui` answers not-found after 4.3 s, at +29.8 s — leaving 200 ms, so `print
    // user` and `list` are skipped. Read as not-found they would make the check `gone` and delete the files.
    const f = fnExec((cmd) => {
      if (cmd[1] === "bootout" || CLOCK - entry < 25_000) return { hang: true };
      return { code: 113, err: SERVICE_NOT_FOUND, latencyMs: 4_300 };
    });
    expect(await uninstallSchedule({}, deps("darwin", f.exec))).toBe(EXIT_ERROR);
    expect(f.calls.map((c) => `${c[1]} ${c[2]}`)).toEqual([
      `bootout gui/4242/${SCHEDULE_LABEL}`, `bootout user/4242/${SCHEDULE_LABEL}`,
      `print gui/4242/${SCHEDULE_LABEL}`, `print user/4242/${SCHEDULE_LABEL}`, `list ${SCHEDULE_LABEL}`,
      `print gui/4242/${SCHEDULE_LABEL}`,
    ]);
    expect(CLOCK - entry).toBe(29_800);
    expect([existsSync(plist), await pathPresent(schedulePath())]).toEqual([true, true]);
    expect(warned.join("\n")).toContain("Registration check: couldn't tell (timeout).");
    expectTimeoutsFit(f, entry);
  });
});

describe("uninstall — delete only once gone, and what a failure says (spec 3.1.6–3.1.10)", () => {
  test("Linux: the units go first, the reload and the final check run with the record still there, and the record goes LAST", async () => {
    await writeRecord("cli", "linux");
    const [service, timer] = writeUnits("linux");
    const f = systemdJob(true, true);
    const seen: string[] = [];
    const look = (when: string) => () => seen.push(`${when}: units ${[service!, timer!].map((p) => existsSync(p))}, record ${existsSync(schedulePath())}`);
    f.onCall("daemon-reload", look("reload"));
    f.onCall("reset-failed", look("reset-failed"));
    f.onCall("is-enabled", look("is-enabled"));
    expect(await uninstallSchedule({}, deps("linux", f.exec))).toBe(EXIT_OK);
    expect(seen).toEqual([
      "is-enabled: units true,true, record true",            // the check after unregister: nothing deleted yet
      "reload: units false,false, record true",
      "reset-failed: units false,false, record true",
      "is-enabled: units false,false, record true",           // the final check: the record still there
    ]);
    expect(await pathPresent(schedulePath())).toBe(false);
    expect(said[0]).toBe("Removed the background scheduler.");
  });

  test("macOS: the plist goes before the record — a record that will not go is kept, after the plist went", async () => {
    const plist = writeUnits("darwin")[0]!;
    // A NON-EMPTY directory at the record path: present (installed), but it cannot be removed.
    mkdirSync(schedulePath());
    writeFileSync(join(schedulePath(), "keep.txt"), "x");
    expect(await uninstallSchedule({}, deps("darwin", launchdJob(true).exec))).toBe(EXIT_ERROR);
    expect([existsSync(plist), existsSync(join(schedulePath(), "keep.txt"))]).toEqual([false, true]);
    const text = warned.join("\n");
    expect(text).toContain(`couldn't remove ${schedulePath()} (it is a folder with files in it) — move it out of the way`);
    expect(text).toContain(`This attempt removed: ${plist}.`);
    expect(text).toContain(`Still present: ${schedulePath()}.`);
    expect(text).toContain("Registration check: gone.");
  });

  test("an EMPTY directory at the unit path and at the record path is removed (non-recursive rmdir)", async () => {
    const plist = unitPaths("darwin", env(), HOME)[0]!;
    mkdirSync(plist);
    mkdirSync(schedulePath());
    expect(await uninstallSchedule({}, deps("darwin", launchdJob(true).exec))).toBe(EXIT_OK);
    expect([await pathPresent(plist), await pathPresent(schedulePath())]).toEqual([false, false]);
  });

  test("a NON-EMPTY directory at a unit path stops it: exit 3 naming it, the record kept, and what this attempt removed", async () => {
    await writeRecord("cli", "linux");
    const [service, timer] = unitPaths("linux", env(), HOME);
    writeFileSync(service!, "unit\n");
    mkdirSync(timer!);
    writeFileSync(join(timer!, "inside"), "x");
    const f = systemdJob(true, true);
    expect(await uninstallSchedule({}, deps("linux", f.exec))).toBe(EXIT_ERROR);
    // `unitPaths` lists the service first: it went, then the timer folder stopped the run — no reload.
    expect([existsSync(service!), existsSync(join(timer!, "inside")), await pathPresent(schedulePath())]).toEqual([false, true, true]);
    expect(f.calls.some((c) => c.includes("daemon-reload"))).toBe(false);
    const text = warned.join("\n");
    expect(text).toContain(`couldn't remove ${timer} (it is a folder with files in it) — move it out of the way`);
    expect(text).toContain(`This attempt removed: ${service}.`);
    expect(text).toContain(`Still present: ${timer}; ${schedulePath()}.`);
  });

  test("any other error removing a path stops it the same way, naming the path", async () => {
    // A unit folder that is a symlink loop: `lstat` of the unit fails ELOOP. That counts as present (a gate
    // must not wave through what it cannot rule out), and removing it fails, naming the path.
    const loop = join(HOME, "loop");
    symlinkSync(loop, loop);
    const plist = join(loop, `${SCHEDULE_LABEL}.plist`);
    await writeRecord("cli");
    const loopy = { ...env(), DBA_TEST_UNIT_DIR: loop };
    expect(await uninstallSchedule({}, deps("darwin", launchdJob(true).exec, { env: loopy }))).toBe(EXIT_ERROR);
    const text = warned.join("\n");
    expect(text).toContain(`couldn't remove ${plist} (ELOOP) — move it out of the way`);
    expect(text).toContain("This attempt removed no files.");
    expect(await pathPresent(schedulePath())).toBe(true);
  });

  test("a symlinked unit is unlinked, never followed: its target survives", async () => {
    const target = join(HOME, "real.plist");
    writeFileSync(target, "<plist/>");
    const plist = unitPaths("darwin", env(), HOME)[0]!;
    symlinkSync(target, plist);
    expect(await uninstallSchedule({}, deps("darwin", launchdJob(true).exec))).toBe(EXIT_OK);
    expect([await pathPresent(plist), existsSync(target)]).toEqual([false, true]);
  });

  test("a failed daemon-reload stops it: exit 3, the record kept, no reset-failed and no final check", async () => {
    await writeRecord("cli", "linux");
    const [service, timer] = writeUnits("linux");
    const f = systemdJob(true, true, { script: { "daemon-reload": { code: 1, err: "Failed to reload daemon: Access denied" } } });
    expect(await uninstallSchedule({}, deps("linux", f.exec))).toBe(EXIT_ERROR);
    expect(f.calls.at(-1)!.join(" ")).toBe("systemctl --user daemon-reload");
    expect(await pathPresent(schedulePath())).toBe(true);
    const text = warned.join("\n");
    expect(text).toContain("systemctl --user daemon-reload failed (1): Failed to reload daemon: Access denied");
    expect(text).toContain(`This attempt removed: ${service}, ${timer}.`);
    expect(text).toContain("The schedule record was kept, so running the removal again starts over by name.");
  });

  test("a final check that is not gone stops it: exit 3, the record kept", async () => {
    await writeRecord("cli", "linux");
    const [service, timer] = writeUnits("linux");
    const f = systemdJob(true, true);
    f.onCall("daemon-reload", () => f.set(true, false));   // something started the timer again
    expect(await uninstallSchedule({}, deps("linux", f.exec))).toBe(EXIT_ERROR);
    expect(await pathPresent(schedulePath())).toBe(true);
    const text = warned.join("\n");
    expect(text).toContain("Registration check: still registered.");
    // What this attempt removed (spec 3.7, every 3.1.6 failure): the units went before the reload.
    expect(text).toContain(`This attempt removed: ${service}, ${timer}.`);
    // Linux's `present` is EITHER unit running OR the timer enabled — here only a unit runs — so the
    // entry claims one of them, never both.
    expect(text).toContain(`Still present: ${schedulePath()}; a registered ${SYSTEMD_TIMER_NAME} or ${SYSTEMD_SERVICE_NAME}.`);
  });

  test("reset-failed's failure is ignored", async () => {
    await writeRecord("cli", "linux");
    writeUnits("linux");
    const f = systemdJob(true, true, { script: { "reset-failed": { code: 1, err: `Unit ${SYSTEMD_TIMER_NAME} not loaded.` } } });
    expect(await uninstallSchedule({}, deps("linux", f.exec))).toBe(EXIT_OK);
  });

  test("--invoker app: the details, then the steps, and NO closing line — the app adds its own", async () => {
    await writeRecord("app");
    writeUnits("darwin");
    expect(await uninstallSchedule({ invoker: "app" }, deps("darwin", launchdJob(true, { stuck: true }).exec))).toBe(EXIT_ERROR);
    const text = warned.join("\n");
    expect(text.split("\n")[0]).toStartWith("Couldn't finish removing the background scheduler:");
    expect(text.endsWith(stepsFor("darwin"))).toBe(true);
    expect(text).not.toContain("Then run");
  });

  test("under the default exec's refusal (spec 3.1.3): macOS removes only the redirected files and exits 0; Linux stops at the refused reload", async () => {
    // A model of the refusal itself: every registration change comes back -2 with the fixed text, as the
    // default exec answers under DBA_TEST_UNIT_DIR; the read-only check is the fake's.
    const refusing = (f: { exec: Exec }): Exec => async (cmd, o) =>
      (isRegistrationChange(cmd) ? { code: -2, out: "", err: SCHEDULER_CHANGE_REFUSED } : f.exec(cmd, o));

    await writeRecord("cli");
    const plist = writeUnits("darwin")[0]!;
    expect(await uninstallSchedule({}, deps("darwin", refusing(launchdJob(false))))).toBe(EXIT_OK);
    expect([existsSync(plist), await pathPresent(schedulePath())]).toEqual([false, false]);

    await writeRecord("cli", "linux");
    writeUnits("linux");
    expect(await uninstallSchedule({}, deps("linux", refusing(systemdJob(false, false))))).toBe(EXIT_ERROR);
    expect(await pathPresent(schedulePath())).toBe(true);
    expect(warned.join("\n")).toContain(`systemctl --user daemon-reload failed (-2): ${SCHEDULER_CHANGE_REFUSED}`);
  });

  describe("Windows keeps today's path (spec 3.1.10)", () => {
    test("an unchecked schtasks /Delete, the unlinks, exit 0", async () => {
      await writeRecord("cli", "win32");
      const xml = writeUnits("win32")[0]!;
      const f = fakeExec({ "/Delete": { code: 1, err: "ERROR: The system cannot find the file specified." } });
      expect(await uninstallSchedule({}, deps("win32", f.exec))).toBe(EXIT_OK);
      expect(f.calls.map((c) => c.join(" "))).toEqual([`schtasks /Delete /TN ${WINDOWS_TASK_NAME} /F`]);
      expect([existsSync(xml), existsSync(schedulePath())]).toEqual([false, false]);
      // (The line goes on to name the script that removes the binary; isolation.meta.test.ts reads any test
      // naming that script as one that spawns it, so only the start is asserted here.)
      expect(said.length).toBe(1);
      expect(said[0]).toStartWith(`Removed the trigger (${xml}). The engine binary itself was left in place`);
    });

    test("nothing there is exit 1 with no exec, and a foreign owner exit 2", async () => {
      const f = fakeExec();
      expect(await uninstallSchedule({}, deps("win32", f.exec))).toBe(EXIT_NONE);
      expect(f.calls).toEqual([]);
      await writeRecord("app", "win32");
      expect(await uninstallSchedule({ invoker: "cli" }, deps("win32", f.exec))).toBe(EXIT_FOREIGN);
      expect(f.calls).toEqual([]);
    });
  });
});

// ── ⚠ A FAILED FIRST INSTALL ROLLS BACK (spec 3.2, item 28), and removes ONLY what this attempt made. Every
// case drives `installSchedule` through `deps()` — the fake exec, the scratch HOME, `env()` (whose
// XDG_DATA_HOME is under that HOME, so a Linux rollback that unlinks the managed binary can only reach the
// scratch copy), uid 4242 and the simulated clock — and every command the rollback runs is the fake's.
describe("install rollback — a failed first install undoes only what it made (spec 3.2)", () => {
  const LOAD_FAILS: Scripted = { code: 5, err: "Load failed: 5: Input/output error" };
  const ENABLE_FAILS: Scripted = { code: 1, err: "Failed to enable unit: Access denied" };
  const BUS_256 = BUS_ERROR;
  const BUS_257 = "Failed to connect to user scope bus via local transport: No such file or directory";
  const DOMAIN_TEXT = "Could not find domain for port identifier: 4242";
  const NOT_FOUND: Scripted = { code: 113, err: SERVICE_NOT_FOUND };
  /** launchd's check, by its three read-only commands. */
  const macCheck = (g: Scripted, u: Scripted, l: Scripted): Record<string, Scripted> => ({ "print gui/": g, "print user/": u, "list ": l });
  const MAC_GONE = macCheck(NOT_FOUND, NOT_FOUND, NOT_FOUND);
  /** systemd's check, by its two read-only commands. */
  const linuxCheck = (active: Scripted, enabled: Scripted): Record<string, Scripted> => ({ "is-active": active, "is-enabled": enabled });
  const LINUX_GONE = linuxCheck({ code: 3, out: "inactive\ninactive\n" }, { code: 1, out: "disabled\n" });
  /** The failing register command per platform: `load`, or Linux's `enable --now` after a good daemon-reload. */
  const FAILING = { darwin: "launchctl load", linux: "enable --now" } as const;

  /** The calls from index `k` on, with their timeouts and start times, for `expectTimeoutsFit`. */
  const from = (f: { calls: string[][]; timeouts: Array<number | undefined>; at: number[] }, k: number) =>
    ({ calls: f.calls.slice(k), timeouts: f.timeouts.slice(k), at: f.at.slice(k) });
  /** Index of the first call whose command line contains `match`. */
  const indexOf = (f: { calls: string[][] }, match: string) => f.calls.findIndex((c) => c.join(" ").includes(match));
  /** Every command line after the register step's failing command: what the rollback ran. */
  const rollbackCalls = (f: { calls: string[][] }, failing: string) => f.calls.slice(indexOf(f, failing) + 1).map((c) => c.join(" "));
  const lastLine = () => warned.join("\n").split("\n").at(-1);

  // ── every rollback command goes through the injected exec, in order, each under its cap (spec 3.1.4).
  test("macOS: bootout by label in both domains, then the check — every command through the injected exec, each under its cap", async () => {
    const f = fakeExec({ [FAILING.darwin]: LOAD_FAILS, ...MAC_GONE });
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_ERROR);
    const i = indexOf(f, FAILING.darwin);
    expect(rollbackCalls(f, FAILING.darwin)).toEqual([
      `launchctl bootout gui/4242/${SCHEDULE_LABEL}`, `launchctl bootout user/4242/${SCHEDULE_LABEL}`,
      `launchctl print gui/4242/${SCHEDULE_LABEL}`, `launchctl print user/4242/${SCHEDULE_LABEL}`, `launchctl list ${SCHEDULE_LABEL}`,
    ]);
    expectTimeoutsFit(from(f, i + 1), f.at[i + 1]!);
    const plist = unitPaths("darwin", env(), HOME)[0]!;
    expect([existsSync(plist), existsSync(managed())]).toEqual([false, false]);
    const text = warned.join("\n");
    expect(text).toContain("Registration check: gone.");
    expect(text).toContain(`This rollback removed: ${plist}, ${managed()}.`);
    expect(lastLine()).toBe("Rolled back: nothing was left behind.");
  });

  test("Linux: stop and disable by name, the check, then ONE daemon-reload after the unlink (3 s cap) — the units and the binary go", async () => {
    const f = fakeExec({ [FAILING.linux]: ENABLE_FAILS, ...LINUX_GONE });
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec))).toBe(EXIT_ERROR);
    const both = `${SYSTEMD_TIMER_NAME} ${SYSTEMD_SERVICE_NAME}`;
    const i = indexOf(f, FAILING.linux);
    expect(rollbackCalls(f, FAILING.linux)).toEqual([
      `systemctl --user stop ${both}`, `systemctl --user disable ${SYSTEMD_TIMER_NAME}`,
      `systemctl --user is-active ${both}`, `systemctl --user is-enabled ${SYSTEMD_TIMER_NAME}`,
      "systemctl --user daemon-reload",
    ]);
    expectTimeoutsFit(from(f, i + 1), f.at[i + 1]!, 4);
    const [service, timer] = unitPaths("linux", env(), HOME);
    expect([existsSync(service!), existsSync(timer!), existsSync(managed("linux"))]).toEqual([false, false, false]);
    expect(await pathPresent(schedulePath())).toBe(false);
    expect(warned.join("\n")).toContain(`This rollback removed: ${service}, ${timer}, ${managed("linux")}.`);
    expect(lastLine()).toBe("Rolled back: nothing was left behind.");
  });

  // ── a returned failure and a throw before the record write both reach the rollback (spec 3.2.1).
  test("a THROW before the record write reaches it too: registered, then the record could not be written — booted out, checked gone, removed", async () => {
    const f = launchdJob(false);   // the install's load loads it; the rollback's bootout unloads it
    const noClock = () => { throw new Error("no clock to stamp the record"); };
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec, { now: noClock }))).toBe(EXIT_ERROR);
    expect(rollbackCalls(f, FAILING.darwin)).toEqual([
      `launchctl bootout gui/4242/${SCHEDULE_LABEL}`, `launchctl bootout user/4242/${SCHEDULE_LABEL}`,
      `launchctl print gui/4242/${SCHEDULE_LABEL}`, `launchctl print user/4242/${SCHEDULE_LABEL}`, `launchctl list ${SCHEDULE_LABEL}`,
    ]);
    expect(warned.join("\n")).toContain("schedule install failed: no clock to stamp the record");
    expect([existsSync(unitPaths("darwin", env(), HOME)[0]!), existsSync(managed()), await pathPresent(schedulePath())]).toEqual([false, false, false]);
    expect(lastLine()).toBe("Rolled back: nothing was left behind.");
  });

  // ── no prior record vs a prior record (spec 3.2.1, 3.2.4): presence by `lstat`, readable or not.
  const PRIOR: Array<[string, () => Promise<void>]> = [
    ["a readable record (a refresh)", () => writeRecord("cli")],
    ["an unreadable record (malformed)", async () => { writeFileSync(schedulePath(), '{"owner":"cli","unitPa'); }],
    // M9 round 1 (GPT): a following look (`existsSync`, `stat`) finds NOTHING here, so a `recordBefore` taken
    // that way would roll a refresh back; only `lstat` sees the link.
    ["a DANGLING symlink (lstat sees it, a following look would not)", async () => {
      symlinkSync(join(STATE, "nowhere.json"), schedulePath());
      expect([existsSync(schedulePath()), await pathPresent(schedulePath())]).toEqual([false, true]);
    }],
  ];
  /** What is at the record path, never read through a link: a link's target, or a file's text. */
  const recordAsIs = () =>
    lstatSync(schedulePath()).isSymbolicLink() ? `link -> ${readlinkSync(schedulePath())}` : `file: ${readFileSync(schedulePath(), "utf8")}`;
  for (const [what, make] of PRIOR) {
    test(`a record that existed before — ${what} — means NO rollback: exit 3 as today, and everything stays`, async () => {
      await make();
      const before = recordAsIs();
      const f = fakeExec({ [FAILING.darwin]: LOAD_FAILS, ...MAC_GONE });
      expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_ERROR);
      expect(rollbackCalls(f, FAILING.darwin)).toEqual([]);
      expect(recordAsIs()).toBe(before);
      expect([existsSync(unitPaths("darwin", env(), HOME)[0]!), existsSync(managed())]).toEqual([true, true]);
      expect(warned.join("\n")).toContain("launchctl load failed");
      expect(warned.join("\n")).not.toContain("ollback");
      expect(warned.join("\n")).not.toContain("Left behind");
    });
  }

  // ── binary pre-existing vs created (spec 3.2.3.4). Created is every case above that removes it.
  test("a managed copy that was already there is never unlinked: only the plist this attempt created goes", async () => {
    const dest = managed();
    writeFileSync(dest, "#!/bin/sh\necho OLD\n");
    const f = fakeExec({ [FAILING.darwin]: LOAD_FAILS, ...MAC_GONE });
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_ERROR);
    const plist = unitPaths("darwin", env(), HOME)[0]!;
    expect([existsSync(plist), existsSync(dest)]).toEqual([false, true]);
    expect(warned.join("\n")).toContain(`This rollback removed: ${plist}.`);
    expect(lastLine()).toBe("Rolled back: nothing was left behind.");
  });

  // ── a unit pre-existing vs created (spec 3.2.3.1): a unit at our path that this attempt did not create may
  // belong to a record-less job it was taking over, so nothing runs by name and no unit is unlinked — the
  // read-only check included — whatever that check would have said. The binary the units name stays too.
  for (const [what, check] of [["gone", MAC_GONE], ["present", {}]] as const) {
    test(`macOS: a plist that was there before — nothing by name, nothing unlinked, whatever the check would say (${what})`, async () => {
      const plist = writeUnits("darwin")[0]!;
      const f = fakeExec({ [FAILING.darwin]: LOAD_FAILS, ...check });
      expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_ERROR);
      expect(rollbackCalls(f, FAILING.darwin)).toEqual([]);
      expect([existsSync(plist), existsSync(managed())]).toEqual([true, true]);
      const text = warned.join("\n");
      expect(text).toContain("This rollback removed no files.");
      expect(text).not.toContain(STEPS_FRAMING);   // it only reports; the Schedule screen and Uninstall offer removal
      expect(lastLine()).toBe(
        `Left behind: ${plist} (it was there before this install, which overwrote it: its earlier content can't be restored); `
        + `possibly the registered job ${SCHEDULE_LABEL} (not checked: a unit file was there before this install, so nothing was run by name); `
        + `the engine copy at ${managed()}.`,
      );
    });
  }

  test("Linux: only the service was there before — the timer this attempt created is kept with it, and nothing runs by name", async () => {
    const [service, timer] = unitPaths("linux", env(), HOME);
    writeFileSync(service!, "unit\n");
    const f = fakeExec({ [FAILING.linux]: ENABLE_FAILS, ...LINUX_GONE });
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec))).toBe(EXIT_ERROR);
    expect(rollbackCalls(f, FAILING.linux)).toEqual([]);
    expect([existsSync(service!), existsSync(timer!), existsSync(managed("linux"))]).toEqual([true, true, true]);
    expect(lastLine()).toStartWith(`Left behind: ${service} (it was there before this install, which overwrote it: its earlier content can't be restored); ${timer}; `);
  });

  // ── a pre-existing unit when registration was NEVER attempted (spec 3.2.3.1-2): a unit write fails before the
  // register step, so there is no check at all — and a unit that was there before is still never unlinked.
  // These pin the rollback's step 2 on `ownUnits`: "registration never attempted" on its own must not reach a
  // unit this attempt did not create (Checkpoint M4: with `ownUnits &&` dropped, every other test stayed green).
  test("macOS: a plist that was there before and a plist write that fails — the plist is untouched, and no launchctl runs", async () => {
    const plist = unitPaths("darwin", env(), HOME)[0]!;
    writeFileSync(plist, "<plist>EARLIER</plist>\n");
    const writeFile = async () => { throw new Error("EACCES: permission denied"); };
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec, { writeFile }))).toBe(EXIT_ERROR);
    expect(existsSync(plist) && readFileSync(plist, "utf8")).toBe("<plist>EARLIER</plist>\n");
    expect(f.ran("launchctl")).toEqual([]);
    expect(warned.join("\n")).toContain("schedule install failed: EACCES: permission denied");
  });

  test("Linux: the service was there before and the timer write fails — the service stays, and no systemctl runs at all", async () => {
    const [service, timer] = unitPaths("linux", env(), HOME);
    writeFileSync(service!, "[Unit]\nDescription=EARLIER\n");
    const writeFile = async (p: string, data: string | Uint8Array) => {
      if (basename(p) === SYSTEMD_TIMER_NAME) throw new Error("ENOSPC: no space left on device");
      writeFileSync(p, data);
    };
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec, { writeFile }))).toBe(EXIT_ERROR);
    expect([existsSync(service!), existsSync(timer!)]).toEqual([true, false]);
    // Nothing by name (never registered), nothing unlinked (a unit was there before) — so no reload either.
    expect(f.calls).toEqual([]);
  });

  // ── what is left is found by LOOKING at every unit path the attempt found there OR started writing (spec
  // 3.2.3.5): a unit that was there before and that this attempt never touched is named — only reported, with no
  // steps (3.2.3.1) — and "nothing was left behind" is said only when nothing at our paths remains.
  test("Linux: the timer was there before and the service write fails first — the untouched timer is named, never 'nothing was left behind'", async () => {
    const [service, timer] = unitPaths("linux", env(), HOME);
    writeFileSync(timer!, "[Timer]\nOnCalendar=EARLIER\n");
    const writeFile = async () => { throw new Error("ENOSPC: no space left on device"); };   // the service is written first
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec, { writeFile }))).toBe(EXIT_ERROR);
    expect([existsSync(service!), existsSync(timer!) && readFileSync(timer!, "utf8")]).toEqual([false, "[Timer]\nOnCalendar=EARLIER\n"]);
    expect(f.calls).toEqual([]);
    const text = warned.join("\n");
    expect(text).toContain(`This rollback removed: ${managed("linux")}.`);   // no unit this attempt started is left
    expect(text).not.toContain("nothing was left behind");
    expect(text).not.toContain(STEPS_FRAMING);
    expect(lastLine()).toBe(`Left behind: ${timer} (it was there before this install and was not changed).`);
  });

  test("macOS: the plist was there before and the engine copy fails before any unit is written — the untouched plist is named", async () => {
    const plist = unitPaths("darwin", env(), HOME)[0]!;
    writeFileSync(plist, "<plist>EARLIER</plist>\n");
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec, { execPath: join(HOME, "no-such-engine") }))).toBe(EXIT_ERROR);
    expect([existsSync(plist) && readFileSync(plist, "utf8"), existsSync(managed())]).toEqual(["<plist>EARLIER</plist>\n", false]);
    expect(f.calls).toEqual([]);
    const text = warned.join("\n");
    expect(text).toContain("This rollback removed no files.");
    expect(text).not.toContain("nothing was left behind");
    expect(lastLine()).toBe(`Left behind: ${plist} (it was there before this install and was not changed).`);
  });

  // ── the manual steps remove only what THIS attempt made (spec 3.2.3.1): beside a unit that was there before,
  // the `rm` names the attempt's own unit and never the pre-existing one, which is only reported.
  test("Linux, mixed: the service was there before and the timer is this attempt's — the steps' rm names the timer, never the service", async () => {
    const [service, timer] = unitPaths("linux", env(), HOME);
    writeFileSync(service!, "unit\n");
    const f = fakeExec({ [FAILING.linux]: ENABLE_FAILS, ...LINUX_GONE });
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec))).toBe(EXIT_ERROR);
    const text = warned.join("\n");
    const rm = text.split("\n").filter((l) => l.trimStart().startsWith("rm -f -- "));
    expect(rm.length).toBe(1);
    expect(rm[0]).toContain(`'${timer}'`);
    expect(rm[0]).not.toContain(`'${service}'`);
    // The one generator's text, for the attempt's own unit and the record path.
    expect(text).toContain(manualRemoveSteps("systemd", { units: [timer!], record: schedulePath(), home: HOME }));
    expect(lastLine()).toStartWith(`Left behind: ${service} (it was there before this install, which overwrote it: its earlier content can't be restored); ${timer}; `);
  });

  // ── a pre-existing unit's line says what this attempt did to it: overwrote it (its earlier content is gone),
  // or tried and failed — `writeFileAtomic` is temp-then-rename, so a failed write leaves the earlier file — or
  // never touched it (above).
  const OVERWROTE = "it was there before this install, which overwrote it: its earlier content can't be restored";
  const WRITE_FAILED = "it was there before this install; this install's write to it failed, so its earlier content should be intact";
  for (const [what, writeFails, phrase] of [["written", false, OVERWROTE], ["whose write failed", true, WRITE_FAILED]] as const) {
    test(`macOS: a plist that was there before, ${what} — its line says which`, async () => {
      const plist = unitPaths("darwin", env(), HOME)[0]!;
      writeFileSync(plist, "<plist>EARLIER</plist>\n");
      const extra: Partial<ScheduleDeps> = writeFails ? { writeFile: async () => { throw new Error("EACCES: permission denied"); } } : {};
      const f = fakeExec({ [FAILING.darwin]: LOAD_FAILS, ...MAC_GONE });
      expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec, extra))).toBe(EXIT_ERROR);
      expect(lastLine()).toStartWith(`Left behind: ${plist} (${phrase}); `);
      expect(warned.join("\n")).not.toContain(writeFails ? OVERWROTE : WRITE_FAILED);
    });
  }

  // ── registration never attempted (spec 3.2.3.1-2): nothing by name, and the created files go.
  test("Linux, through the writeFile seam: the service is written and the timer write fails — the service and the created binary go, the never-created timer counts as gone", async () => {
    const tried: string[] = [];
    const writeFile = async (p: string, data: string | Uint8Array) => {
      tried.push(p);
      if (basename(p) === SYSTEMD_TIMER_NAME) throw new Error("ENOSPC: no space left on device");
      writeFileSync(p, data);
    };
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec, { writeFile }))).toBe(EXIT_ERROR);
    const [service, timer] = unitPaths("linux", env(), HOME);
    expect(tried).toEqual([service!, timer!]);   // the unit writes go through the seam, service then timer
    expect([existsSync(service!), existsSync(timer!), existsSync(managed("linux"))]).toEqual([false, false, false]);
    // Registration was never attempted, so nothing ran by name: the one command is the reload after the unlink.
    expect(f.calls.map((c) => c.join(" "))).toEqual(["systemctl --user daemon-reload"]);
    const text = warned.join("\n");
    expect(text).toContain("schedule install failed: ENOSPC: no space left on device");
    expect(text).toContain(`This rollback removed: ${service}, ${managed("linux")}.`);
    expect(text.endsWith("Rolled back: nothing was left behind.")).toBe(true);
    expect(await pathPresent(schedulePath())).toBe(false);
  });

  test("macOS, through the writeFile seam: the plist write fails — registration never attempted, so no launchctl at all, and the created binary goes", async () => {
    const writeFile = async () => { throw new Error("EACCES: permission denied"); };
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec, { writeFile }))).toBe(EXIT_ERROR);
    expect(f.ran("launchctl")).toEqual([]);
    expect([existsSync(unitPaths("darwin", env(), HOME)[0]!), existsSync(managed())]).toEqual([false, false]);
    expect(warned.join("\n")).toContain(`This rollback removed: ${managed()}.`);
    expect(lastLine()).toBe("Rolled back: nothing was left behind.");
  });

  // ── the check's answer, with each reason (spec 3.2.3.2): only `gone` unlinks — and on macOS an `unknown`
  // always keeps the files, since it is not known whether a failed load reached some domain. Kept files are
  // named with the manual steps, the registration and the binary they name with them.
  const KEPT: Array<["darwin" | "linux", string, Record<string, Scripted>, RegistrationCheck, boolean]> = [
    ["darwin", "present", {}, { state: "present" }, true],
    ["darwin", "unknown(timeout)", macCheck(NOT_FOUND, NOT_FOUND, { hang: true }), { state: "unknown", reason: "timeout" }, true],
    ["darwin", "unknown(unexpected)", macCheck(NOT_FOUND, NOT_FOUND, { code: 1 }), { state: "unknown", reason: "unexpected" }, true],
    ["darwin", "unknown(spawn)", macCheck(NOT_FOUND, NOT_FOUND, { code: -2 }), { state: "unknown", reason: "spawn" }, false],
    // spec 3.7: no-gui-session with the user domain absent, after a failed load — the files are kept.
    ["darwin", "unknown(no-gui-session)", macCheck({ code: 113, err: DOMAIN_TEXT }, { code: 113, err: DOMAIN_TEXT }, NOT_FOUND), { state: "unknown", reason: "no-gui-session" }, false],
    ["linux", "present", linuxCheck({ out: "active\nactive\n" }, { out: "enabled\n" }), { state: "present" }, true],
    ["linux", "unknown(timeout)", linuxCheck({ hang: true }, { code: 1, out: "disabled\n" }), { state: "unknown", reason: "timeout" }, true],
    ["linux", "unknown(unexpected)", linuxCheck({ code: 3, out: "weird\nweird\n" }, { code: 1, out: "disabled\n" }), { state: "unknown", reason: "unexpected" }, true],
    ["linux", "unknown(spawn)", linuxCheck({ code: -2 }, { code: 1, out: "disabled\n" }), { state: "unknown", reason: "spawn" }, false],
    // A manager error once the failure was NOT at daemon-reload: enable may have run (spec 3.2.3.2).
    ["linux", "unknown(no-user-manager)", linuxCheck({ code: 1, err: BUS_256 }, { code: 1, err: BUS_256 }), { state: "unknown", reason: "no-user-manager" }, false],
  ];
  for (const [platform, what, check, expected, polls] of KEPT) {
    test(`${platform}: check ${what} after a failed register → the units and the binary are KEPT, named with the manual steps`, async () => {
      const f = fakeExec({ [FAILING[platform]]: platform === "darwin" ? LOAD_FAILS : ENABLE_FAILS, ...check });
      expect(await installSchedule({ noVerify: true }, deps(platform, f.exec))).toBe(EXIT_ERROR);
      const units = unitPaths(platform, env(), HOME);
      const bin = managed(platform);
      for (const p of [...units, bin]) expect(`${p} kept: ${existsSync(p)}`).toBe(`${p} kept: true`);
      expect(await pathPresent(schedulePath())).toBe(false);
      // Polling only on a retryable answer or `present`; a stable reason stops at once (spec 3.1.4).
      expect(SLEEPS > 0).toBe(polls);
      expect(rollbackCalls(f, FAILING[platform]).some((c) => c.includes("daemon-reload"))).toBe(false);   // nothing was unlinked
      const reg = platform === "darwin" ? `the registered job ${SCHEDULE_LABEL}` : `a registered ${SYSTEMD_TIMER_NAME} or ${SYSTEMD_SERVICE_NAME}`;
      const regLeft = expected.state === "present" ? reg : `possibly ${reg} (couldn't tell: ${(expected as { reason: string }).reason})`;
      const text = warned.join("\n");
      expect(text).toContain(`Registration check: ${expected.state === "present" ? "still registered" : `couldn't tell (${(expected as { reason: string }).reason})`}.`);
      expect(text).toContain("This rollback removed no files.");
      expect(text.endsWith(`${stepsFor(platform)}\nLeft behind: ${[...units, regLeft, `the engine copy at ${bin}`].join("; ")}.`)).toBe(true);
    });
  }

  // ── Linux `no-user-manager` (item 28): unlinked when the register step failed AT daemon-reload for that same
  // reason — `enable` never ran, so nothing can have been registered — and kept when it failed later. Both bus
  // wordings (systemd ≤ 256 and ≥ 257).
  for (const bus of [BUS_256, BUS_257]) {
    test(`item 28 — a bus error on EVERY systemctl call ("${bus}"): the created units and binary go, with NO reload after the unlink`, async () => {
      const f = fakeExec({ systemctl: { code: 1, err: bus } });
      expect(await installSchedule({ noVerify: true }, deps("linux", f.exec))).toBe(EXIT_ERROR);
      const [service, timer] = unitPaths("linux", env(), HOME);
      expect([existsSync(service!), existsSync(timer!), existsSync(managed("linux"))]).toEqual([false, false, false]);
      // daemon-reload ran ONCE — the register step's first command — and never after the unlink, where it can
      // only fail (spec 3.2.3.3).
      expect(f.calls.map((c) => c[2])).toEqual(["daemon-reload", "stop", "disable", "is-active", "is-enabled"]);
      expect(SLEEPS).toBe(0);
      const text = warned.join("\n");
      expect(text).toContain(`systemctl --user daemon-reload failed (1): ${bus}`);
      expect(text).toContain("Registration check: couldn't tell (no-user-manager), and the install failed at daemon-reload for the same reason, so nothing was registered.");
      expect(text).toContain(`This rollback removed: ${service}, ${timer}, ${managed("linux")}.`);
      expect(lastLine()).toBe("Rolled back: nothing was left behind.");
    });

    test(`the same bus error first at enable ("${bus}"): enable may have run, so the units and the binary they name are KEPT`, async () => {
      const f = fakeExec({ "enable --now": { code: 1, err: bus }, ...linuxCheck({ code: 1, err: bus }, { code: 1, err: bus }) });
      expect(await installSchedule({ noVerify: true }, deps("linux", f.exec))).toBe(EXIT_ERROR);
      const [service, timer] = unitPaths("linux", env(), HOME);
      expect([existsSync(service!), existsSync(timer!), existsSync(managed("linux"))]).toEqual([true, true, true]);
      expect(rollbackCalls(f, FAILING.linux).map((c) => c.split(" ")[2])).toEqual(["stop", "disable", "is-active", "is-enabled"]);
      expect(lastLine()).toContain(`possibly a registered ${SYSTEMD_TIMER_NAME} or ${SYSTEMD_SERVICE_NAME} (couldn't tell: no-user-manager)`);
    });
  }

  test("a later failure with the manager gone — registered, then the record could not be written — keeps the units: the exception is only for a failure AT daemon-reload", async () => {
    const f = fakeExec(linuxCheck({ code: 1, err: BUS_256 }, { code: 1, err: BUS_256 }));
    const noClock = () => { throw new Error("no clock to stamp the record"); };
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec, { now: noClock }))).toBe(EXIT_ERROR);
    const [service, timer] = unitPaths("linux", env(), HOME);
    expect([existsSync(service!), existsSync(timer!), existsSync(managed("linux"))]).toEqual([true, true, true]);
    expect(warned.join("\n")).toContain("Registration check: couldn't tell (no-user-manager).");
    expect(lastLine()).toStartWith(`Left behind: ${service}; ${timer}; possibly a registered `);
  });

  // ── the rollback's own deadline (spec 3.1.4): 45 s and a 30 s polling end, from the ROLLBACK's start.
  // ⚠ The install itself takes time first (M9 round 1, GPT): the failing register step costs a whole 45 s
  // budget, so a rollback budget measured from the INSTALL's entry would have nothing left — every rollback
  // exec skipped as -1, never reaching the fake. Without that latency the two starts coincide and either
  // measurement passes.
  const INSTALL_LATENCY_MS = 45_000;
  for (const platform of ["darwin", "linux"] as const) {
    test(`${platform}: the rollback's own deadline — every rollback command hangs, and simulated time from its start never passes 45 s`, async () => {
      let failed = false;
      const f = fnExec((cmd) => {
        if (cmd.join(" ").includes(FAILING[platform])) { failed = true; return { code: 1, err: "failed", latencyMs: INSTALL_LATENCY_MS }; }
        return failed ? { hang: true } : undefined;
      });
      expect(await installSchedule({ noVerify: true }, deps(platform, f.exec))).toBe(EXIT_ERROR);
      const i = indexOf(f, FAILING[platform]);
      const start = f.at[i + 1]!;   // nothing advances the clock between the failure and the rollback's first exec
      expect(start - f.at[i]!).toBe(INSTALL_LATENCY_MS);   // the install's own time, already spent
      // The rollback's first exec RAN, with its whole 5 s cap: the budget is the rollback's own.
      expect(f.timeouts[i + 1]).toBe(5_000);
      expect(CLOCK - start).toBeLessThanOrEqual(45_000);
      expect(CLOCK - start).toBe(30_000);   // never gone, so nothing ran past the polling end
      expectTimeoutsFit(from(f, i + 1), start);
      for (const p of unitPaths(platform, env(), HOME)) expect(existsSync(p)).toBe(true);
      expect(warned.join("\n")).toContain("Registration check: couldn't tell (timeout).");
    });
  }

  test("Linux: a check that says gone only near the polling end still gets the unlink and a 3 s reload, inside the rollback's deadline", async () => {
    // `start` is the ROLLBACK's start: the failing enable returns once the install's own 45 s are spent.
    let start = -1;
    const f = fnExec((cmd) => {
      if (cmd.includes("enable")) { start = CLOCK + INSTALL_LATENCY_MS; return { ...ENABLE_FAILS, latencyMs: INSTALL_LATENCY_MS }; }
      if (start < 0) return undefined;   // the install's own commands before the failure
      if (cmd.includes("stop") || cmd.includes("disable") || cmd.includes("daemon-reload")) return { hang: true };
      const gone = CLOCK - start >= 29_400;
      if (cmd.includes("is-active")) return gone ? { code: 3, out: "inactive\ninactive\n" } : { out: "active\nactive\n" };
      return gone ? { code: 1, out: "disabled\n" } : { out: "enabled\n" };
    });
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec))).toBe(EXIT_ERROR);
    const i = indexOf(f, FAILING.linux);
    expect([f.at[i + 1], f.timeouts[i + 1]]).toEqual([start, 5_000]);   // the rollback's first exec ran, at its start, uncut
    const reload = f.calls.findIndex((c, k) => k > i && c.includes("daemon-reload"));
    expect(f.at[reload]! - start).toBe(29_500);
    expect(f.timeouts[reload]).toBe(3_000);
    expect(CLOCK - start).toBe(32_500);
    expectTimeoutsFit(from(f, i + 1), start, reload - i - 1);
    const [service, timer] = unitPaths("linux", env(), HOME);
    expect([existsSync(service!), existsSync(timer!), existsSync(managed("linux"))]).toEqual([false, false, false]);
    // The reload's failure is reported, and changes nothing that was removed (spec 3.2.3.3).
    const text = warned.join("\n");
    expect(text).toContain("systemctl --user daemon-reload after removing the unit files failed (-1)");
    expect(lastLine()).toBe("Rolled back: nothing was left behind.");
  });

  // ── a failure after the record write (spec 3.2.1, 3.2.4): the install is complete and owned.
  test("a failure AFTER the record is written is reported as before and undoes nothing", async () => {
    const f = fakeExec({ "show-user": { out: "Linger=no\n" } });
    const exec: Exec = async (cmd, o) => {
      if (cmd[1] === "enable-linger") throw new Error("loginctl was killed");
      return f.exec(cmd, o);
    };
    expect(await installSchedule({ noVerify: true, enableLinger: true }, deps("linux", exec))).toBe(EXIT_ERROR);
    expect(warned.join("\n")).toContain("schedule install failed: loginctl was killed");
    expect(await readScheduleRecord()).toMatchObject({ owner: "cli", kind: "systemd" });
    const [service, timer] = unitPaths("linux", env(), HOME);
    expect([existsSync(service!), existsSync(timer!), existsSync(managed("linux"))]).toEqual([true, true, true]);
    expect(f.calls.filter((c) => ["stop", "disable", "is-active", "is-enabled"].includes(c[2]!))).toEqual([]);
    expect(warned.join("\n")).not.toContain("ollback");
  });

  // ── rollback failing.
  test("rollback failing — a path it cannot remove is named and kept, the binary with it, and stderr ends with what is left", async () => {
    const writeFile = async (p: string, data: string | Uint8Array) => {
      if (basename(p) === SYSTEMD_TIMER_NAME) {
        mkdirSync(p);
        writeFileSync(join(p, "inside"), "x");
        throw new Error("EISDIR: illegal operation on a directory");
      }
      writeFileSync(p, data);
    };
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec, { writeFile }))).toBe(EXIT_ERROR);
    const [service, timer] = unitPaths("linux", env(), HOME);
    const bin = managed("linux");
    expect([existsSync(service!), existsSync(join(timer!, "inside")), existsSync(bin)]).toEqual([false, true, true]);
    const text = warned.join("\n");
    expect(text).toContain(`The rollback couldn't remove ${timer} (it is a folder with files in it) — move it out of the way.`);
    expect(text).toContain(`This rollback removed: ${service}.`);
    expect(text.endsWith(`${stepsFor("linux")}\nLeft behind: ${timer}; the engine copy at ${bin}.`)).toBe(true);
  });

  test("rollback failing — the routine itself throws: exit 3, it says so, and lists what is left by looking", async () => {
    const f = fakeExec({ [FAILING.darwin]: LOAD_FAILS, ...macCheck(NOT_FOUND, NOT_FOUND, { code: 1 }) });   // unknown(unexpected): it will sleep
    const boom = async () => { throw new Error("the clock broke"); };
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec, { sleep: boom }))).toBe(EXIT_ERROR);
    const plist = unitPaths("darwin", env(), HOME)[0]!;
    expect([existsSync(plist), existsSync(managed())]).toEqual([true, true]);
    const text = warned.join("\n");
    expect(text).toContain("The rollback stopped: the clock broke.");
    expect(text.endsWith(`${stepsFor("darwin")}\nLeft behind: ${plist}; possibly the registered job ${SCHEDULE_LABEL} (the rollback stopped before its check finished); the engine copy at ${managed()}.`)).toBe(true);
  });

  test("an exec that throws SYNCHRONOUSLY in the rollback is a failed command (-2), not a stopped rollback: the unregister ignored, the reload's failure reported", async () => {
    const f = fakeExec({ [FAILING.linux]: ENABLE_FAILS, ...LINUX_GONE });
    let registerFailed = false;
    const exec: Exec = (cmd, o) => {
      if (cmd.join(" ").includes(FAILING.linux)) registerFailed = true;
      else if (registerFailed && ["stop", "disable", "daemon-reload"].includes(cmd[2]!)) throw new Error(`${cmd[2]} threw before it returned`);
      return f.exec(cmd, o);
    };
    expect(await installSchedule({ noVerify: true }, deps("linux", exec))).toBe(EXIT_ERROR);
    const [service, timer] = unitPaths("linux", env(), HOME);
    expect([existsSync(service!), existsSync(timer!), existsSync(managed("linux"))]).toEqual([false, false, false]);
    const text = warned.join("\n");
    expect(text).not.toContain("The rollback stopped");
    expect(text).toContain("Registration check: gone.");
    expect(text).toContain("systemctl --user daemon-reload after removing the unit files failed (-2): Error: daemon-reload threw before it returned.");
    expect(lastLine()).toBe("Rolled back: nothing was left behind.");
  });
});

describe("atomic writes — no reader ever sees half a file", () => {
  /** A file is written atomically iff, at the moment it appears (or changes), it is COMPLETE. The
   *  observable proxy for that in a single-process test is the one that actually catches the bug:
   *  the final file must have arrived by RENAME, so the directory must hold no leftover temp and the
   *  content must be whole. The negative — a truncating write — is what leaves a readable partial. */
  const isJsonWhole = (p: string) => { try { JSON.parse(readFileSync(p, "utf8")); return true; } catch { return false; } };

  test("schedule.json is written temp-then-rename, and a torn read is what that prevents", async () => {
    const f = fakeExec();
    await installSchedule({ noVerify: true }, deps("darwin", f.exec));
    expect(isJsonWhole(schedulePath())).toBe(true);
    // No temp survives a successful write, in the record's directory or the unit's.
    const strays = readdirSync(STATE).filter((n) => n.includes(".tmp-"));
    expect(strays).toEqual([]);
    expect(readdirSync(UNITS).filter((n) => n.includes(".tmp-"))).toEqual([]);
    // ⚠ WHY THIS MATTERS AND WHERE IT BITES: a torn record does not fail loudly. `readScheduleRecord`
    // is TOTAL, so a partial file parses as `null` — and `null` means "nobody owns this", which OPENS
    // the single-owner gate. Pinned here so the consequence is on the record next to the mechanism.
    writeFileSync(schedulePath(), '{"owner":"app","unitPa');   // a plausible truncation point
    expect(await readScheduleRecord()).toBeNull();
    const g = fakeExec();
    expect(await installSchedule({ invoker: "cli", noVerify: true }, deps("darwin", g.exec))).toBe(EXIT_OK);
  });

  test("the managed binary is replaced by rename, not copied over in place", async () => {
    // A refresh copies a NEW binary over the path the OS trigger points at — and, on the install.sh
    // path, over a file that may be executing in a concurrent scheduled tick. In place, that truncates
    // before it fills.
    const dest = managed();
    writeFileSync(dest, "#!/bin/sh\necho OLD\n");
    writeFileSync(SRC_BIN, "#!/bin/sh\necho NEW-AND-LONGER-THAN-THE-OLD-ONE\n");
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_OK);
    expect(readFileSync(dest, "utf8")).toBe("#!/bin/sh\necho NEW-AND-LONGER-THAN-THE-OLD-ONE\n");
    expect(statSync(dest).mode & 0o777).toBe(0o755);
    expect(readdirSync(dirname(dest)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  test("every unit file lands whole, on every platform", async () => {
    for (const [platform, names] of [
      ["darwin", [`${SCHEDULE_LABEL}.plist`]],
      ["linux", ["daily-briefing.service", SYSTEMD_TIMER_NAME]],
      ["win32", [`${WINDOWS_TASK_NAME}.xml`]],
    ] as const) {
      const f = fakeExec();
      await installSchedule({ noVerify: true, confirmExperimental: true }, deps(platform, f.exec));
      for (const n of names) expect(`${platform}/${n} exists: ${existsSync(join(UNITS, n))}`).toBe(`${platform}/${n} exists: true`);
      expect(`${platform} strays: ${readdirSync(UNITS).filter((x) => x.includes(".tmp-")).join(",")}`).toBe(`${platform} strays: `);
    }
  });
});

test("an unsupported platform is refused rather than half-installed", async () => {
  const f = fakeExec();
  expect(await installSchedule({}, deps("freebsd", f.exec))).toBe(EXIT_ERROR);
  expect(await uninstallSchedule({}, deps("freebsd", f.exec))).toBe(EXIT_ERROR);
  expect(f.calls).toEqual([]);
});

// ── ⚠ THE ISOLATION GUARD (Batch 2, spec 3.1.3). Every test in this block is selected by
// `-t "isolation guard"` for the mutation check of the refusal, the predicate, the exec-code mapping
// and the preload arming, so nothing in it may reach a real scheduler tool: the predicate is pure, and
// the only exec any of these tests reaches is the host-absent probe below.
describe("isolation guard", () => {
  // ── the predicate, over argv only. Never an exec: these are the argvs the engine BUILDS, written out
  // the way install.ts writes them (`register` for install, `kick` for the kickstart, uninstall's verbs
  // from spec 3.1.3), and asked one question each. The uid is `deps()`'s fixed 4242, never the author's
  // real uid, whose `gui/<uid>/local.daily-briefing` would name the live domain.
  const UID = 4242;
  const PLIST = join("/scratch-units", `${SCHEDULE_LABEL}.plist`);
  const REGISTRATION_CHANGES: string[][] = [
    // uninstall (spec 3.1.3): bootout in both domains, stop, disable, daemon-reload, reset-failed
    ["launchctl", "bootout", `gui/${UID}/${SCHEDULE_LABEL}`],
    ["launchctl", "bootout", `user/${UID}/${SCHEDULE_LABEL}`],
    ["systemctl", "--user", "stop", SYSTEMD_TIMER_NAME, SYSTEMD_SERVICE_NAME],
    ["systemctl", "--user", "disable", SYSTEMD_TIMER_NAME],
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "reset-failed", SYSTEMD_TIMER_NAME, SYSTEMD_SERVICE_NAME],
    // install (`register`)
    ["launchctl", "unload", PLIST],
    ["launchctl", "load", PLIST],
    ["systemctl", "--user", "enable", "--now", SYSTEMD_TIMER_NAME],
    // the kickstart `schedule verify` and install's last step run (`kick`)
    ["launchctl", "start", SCHEDULE_LABEL],
    ["systemctl", "--user", "start", "--no-block", SYSTEMD_SERVICE_NAME],
    // linger (`reportLinger`)
    ["loginctl", "enable-linger", "tester"],
    // deny by default: a verb nobody listed is a change
    ["launchctl", "kickstart", "-k", `gui/${UID}/${SCHEDULE_LABEL}`],
    ["launchctl", "frobnicate", SCHEDULE_LABEL],
    ["systemctl", "--user", "mask", SYSTEMD_TIMER_NAME],
    // the base name decides, so a path prefix or another spelling of the case cannot bypass it
    // (APFS is case-insensitive: `/bin/LaunchCtl` runs `/bin/launchctl`)
    ["/bin/launchctl", "bootout", `gui/${UID}/${SCHEDULE_LABEL}`],
    ["/bin/LaunchCtl", "bootout", `gui/${UID}/${SCHEDULE_LABEL}`],
    ["/usr/bin/SYSTEMCTL", "--user", "stop", SYSTEMD_TIMER_NAME],
    // a dash argument other than exactly `--user` before the command word: an option's VALUE must never
    // pass for a read-only command word
    ["systemctl", "-H", "is-active", "stop", SYSTEMD_TIMER_NAME],
    ["systemctl", "--global", "is-enabled", SYSTEMD_TIMER_NAME],
    ["systemctl", "--user=x", "is-active", SYSTEMD_TIMER_NAME],
    ["launchctl", "-x", "print", `gui/${UID}/${SCHEDULE_LABEL}`],
    ["loginctl", "-H", "show-user", "tester"],
    // no command word at all
    ["launchctl"],
    ["systemctl", "--user"],
    ["loginctl"],
  ];
  const READ_ONLY_OR_NOT_A_SCHEDULER: string[][] = [
    ["launchctl", "print", `gui/${UID}/${SCHEDULE_LABEL}`],
    ["launchctl", "print", `user/${UID}/${SCHEDULE_LABEL}`],
    ["launchctl", "list", SCHEDULE_LABEL],
    ["systemctl", "--user", "is-active", SYSTEMD_TIMER_NAME],
    ["systemctl", "--user", "is-enabled", SYSTEMD_TIMER_NAME],
    ["systemctl", "is-active", SYSTEMD_TIMER_NAME],
    ["/bin/launchctl", "list", SCHEDULE_LABEL],
    ["loginctl", "show-user", "tester", "--property=Linger"],
    ["security", "find-identity", "-p", "codesigning"],
    ["security", "import", "/scratch-sign/id.p12", "-P", "pw", "-A"],
    ["openssl", "version"],
    ["/opt/homebrew/bin/openssl", "req", "-x509", "-newkey", "rsa:2048"],
    ["schtasks", "/Delete", "/TN", WINDOWS_TASK_NAME, "/F"],
    ["schtasks", "/Create", "/XML", "/scratch-units/task.xml", "/TN", WINDOWS_TASK_NAME, "/F"],
    // the dash-argument rule never reaches another tool: these are built exactly as `signManagedCopy`
    // builds them, dash arguments first
    ["xattr", "-d", "com.apple.quarantine", "/scratch-bin/daily-briefing"],
    ["codesign", "--force", "--sign", DEFAULT_SIGN_IDENTITY, "--timestamp=none", "--identifier", SCHEDULE_LABEL, "/scratch-bin/daily-briefing"],
    ["codesign", "-s", "-", "-f", "--timestamp=none", "/scratch-bin/daily-briefing"],
  ];

  for (const argv of REGISTRATION_CHANGES) {
    test(`the predicate calls \`${argv.join(" ")}\` a registration change`, () => {
      expect(isRegistrationChange(argv)).toBe(true);
    });
  }
  for (const argv of READ_ONLY_OR_NOT_A_SCHEDULER) {
    test(`the predicate leaves \`${argv.join(" ")}\` alone`, () => {
      expect(isRegistrationChange(argv)).toBe(false);
    });
  }

  test("the predicate calls an empty argv a change, and never throws whatever it is given", () => {
    expect(isRegistrationChange([])).toBe(true);
    // Untyped callers: the answer is a boolean either way, never an exception that could escape the
    // refusal and land in the caller's error handling.
    for (const weird of [null, undefined, "launchctl bootout x", [undefined], [null, "stop"], [42, "stop"], ["launchctl", null], ["systemctl", { toString: null }]]) {
      let answer: unknown;
      expect(() => { answer = isRegistrationChange(weird as never); }).not.toThrow();
      expect(typeof answer).toBe("boolean");
    }
  });

  // ── the preload arms DBA_TEST_UNIT_DIR for every engine test process (spec 3.1.3, "Every engine test
  // process carries it"), so a test that passes neither `exec` nor `env` is refused rather than reaching
  // the author's live job by label.
  test("DBA_TEST_UNIT_DIR is set under bun test, to the preload's per-process scratch baseline", () => {
    const v = process.env.DBA_TEST_UNIT_DIR;
    expect(v).toBeTruthy();
    expect(basename(v!)).toStartWith("dba-isolated-units-");
    expect(existsSync(v!)).toBe(true);
  });

  test("the DBA_TEST_UNIT_DIR tripwire is armed, not just the value: a clear is recorded and re-armed, and delete throws", () => {
    // Without this test, dropping the `armTripwire` call while keeping the plain assignment would leave
    // the test above green. The two older variables are proven end to end in a child process by
    // test/state-tripwire.test.ts; this one stays in-process, because the read below re-arms the
    // baseline before anything can resolve the cleared value.
    const saved = process.env.DBA_TEST_UNIT_DIR as string;   // asserted on the next line
    expect(saved).toBeTruthy();
    try {
      process.env.DBA_TEST_UNIT_DIR = "";
      const readBack = process.env.DBA_TEST_UNIT_DIR;
      // Drained HERE, so the preload's afterEach (test/preload.ts) does not fail this test for the clear
      // it made on purpose.
      const records = takeIsolationViolations();
      expect(readBack).toBe(saved);
      expect(records.filter((r) => r.startsWith("DBA_TEST_UNIT_DIR cleared")).length).toBe(1);
      expect(records.filter((r) => r.startsWith("DBA_TEST_UNIT_DIR read while cleared")).length).toBe(1);
      expect(() => { delete process.env.DBA_TEST_UNIT_DIR; }).toThrow(TypeError);
      expect(process.env.DBA_TEST_UNIT_DIR).toBe(saved);
    } finally {
      // A no-op when armed; the repair when not, so a broken tripwire fails this test and only this one.
      process.env.DBA_TEST_UNIT_DIR = saved;
    }
  });

  // ── the source pins (spec 3.1.3), read with comments stripped, so prose about the refusal can neither
  // satisfy a pin nor trip one.
  const ROOT = join(import.meta.dir, "..");
  const INSTALL_SRC = join(ROOT, "src", "schedule", "install.ts");

  /** The default exec's definition, from its name up to (not including) its one `run(` call, comments
   *  stripped. R3 (test/isolation.meta.test.ts) already pins that exactly one `run(` exists and that it
   *  sits inside this definition. */
  function defaultExecUpToRun(): string {
    const src = codeOnly(readFileSync(INSTALL_SRC, "utf8"));
    const at = src.indexOf("const defaultExec");
    expect(at).toBeGreaterThanOrEqual(0);
    const runAt = src.slice(at).search(/(?<![\w.$])run\s*\(/);
    expect(runAt).toBeGreaterThan(0);
    return src.slice(at, at + runAt);
  }

  test("pin: the default exec consults isRegistrationChange, and returns the fixed refusal, before its run(", () => {
    const body = defaultExecUpToRun();
    expect(body).toMatch(/\bisRegistrationChange\s*\(/);
    expect(body).toMatch(/\bSCHEDULER_CHANGE_REFUSED\b/);
  });

  test("pin: the refusal's condition reads BOTH the injected env and process.env for DBA_TEST_UNIT_DIR", () => {
    // Without the first half pinned, deleting it survives every behavioural test: the preload always arms
    // process.env, so the second half alone refuses the probe. `env.` is matched only where no `.`
    // precedes it, since `process.env.DBA_TEST_UNIT_DIR` contains it.
    const body = defaultExecUpToRun();
    expect(body).toMatch(/(?<![\w$.])env\.DBA_TEST_UNIT_DIR\b/);
    expect(body).toMatch(/\bprocess\.env\.DBA_TEST_UNIT_DIR\b/);
  });

  test("pin: resolveDeps builds its default exec from the env it resolved FIRST, never from process.env directly", () => {
    // Spec 3.1.3, "Whose environment": the refusal must see the same environment every path and unit
    // decision does. Behaviourally a mutation to building it from process.env survives every test (the
    // preload arms process.env, so the refusal still fires), so the intent is pinned on the source. The
    // needles are built from pieces so the one-call pin below does not count this test's own text.
    const src = codeOnly(readFileSync(INSTALL_SRC, "utf8"));
    const from = src.indexOf("function resolveDeps");
    const to = src.indexOf("export function kindFor");
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    const body = src.slice(from, to);
    const envFirst = body.search(/\bconst\s+env\s*=\s*d\.env\s*\?\?\s*process\.env\b/);
    const execFromEnv = body.search(new RegExp("\\bexec\\s*:\\s*d\\.exec\\s*\\?\\?\\s*default" + "Exec\\s*\\(\\s*env\\s*\\)"));
    expect(envFirst).toBeGreaterThanOrEqual(0);
    expect(execFromEnv).toBeGreaterThan(envFirst);
  });

  test("pin: across test/ and gui/tests-web/, the exported default exec is called exactly once — here, with the probe constant", () => {
    // gui/tests-web is scanned too: that runner has no engine preload, but since M9 round 3 its own preload
    // (gui/tests-web/svelte-loader.ts) arms the same refusal, and this pin stays as the static guard beside it
    // (spec 3.1.3, "The GUI test runner"). Files are enumerated with Bun.Glob, never git: a spawn in this
    // file would void its never-reach exemption (isolation.meta.test.ts), and a disposable copy of the tree
    // has no .git. The needles are built from pieces so this pin does not count its own text.
    const call = new RegExp("\\bdefault" + "Exec\\s*(?:\\?\\.)?\\(", "g");
    const files: string[] = [];
    for (const f of new Bun.Glob("**/*.ts").scanSync({ cwd: join(ROOT, "test") })) files.push(join("test", f));
    const testCount = files.length;
    for (const f of new Bun.Glob("**/*.ts").scanSync({ cwd: join(ROOT, "gui", "tests-web") })) files.push(join("gui", "tests-web", f));
    // Floors, so a broken glob fails loudly instead of passing over nothing (197 and 14 at this commit).
    expect(testCount).toBeGreaterThanOrEqual(190);
    expect(files.length - testCount).toBeGreaterThanOrEqual(12);
    const calls: string[] = [];
    for (const rel of files) {
      for (const _ of codeOnly(readFileSync(join(ROOT, rel), "utf8")).matchAll(call)) calls.push(rel);
    }
    expect(calls).toEqual([join("test", "schedule.install.test.ts")]);
    // …and that one call expression itself carries the probe: `<the exec>({ …env… })(ISOLATION_PROBE)`.
    const own = codeOnly(readFileSync(import.meta.path, "utf8"));
    expect(own).toMatch(new RegExp("\\bdefault" + "Exec\\s*\\(\\s*\\{[^{}()]*\\}\\s*\\)\\s*\\(\\s*ISOLATION_PROBE\\s*\\)"));
  });

  // ── the one direct call (spec 3.1.3), and the hand-built environment. ⚠ EVERY TEST OF THE REFUSAL USES
  // ONLY THIS PROBE: a fixed argv whose scheduler tool is ABSENT from the host (`systemctl` on macOS,
  // `launchctl` on Linux), asserted absent first, so even with the refusal missing the exec can only fail
  // to spawn, with a different text, and nothing real runs. Its label is no live label. Module-local and
  // not exported: importing a test file re-registers its tests. The Linux uid is a fixed literal because
  // `launchctl` does not exist there and the predicate ignores it.
  const ISOLATION_PROBE: string[] = process.platform === "linux"
    ? ["launchctl", "bootout", "gui/0/local.daily-briefing.isolation-probe"]
    : ["systemctl", "--user", "stop", "dba-isolation-probe.timer"];

  test("the one direct call: the host-absent probe under DBA_TEST_UNIT_DIR is refused with the fixed text", async () => {
    // Fails, never skips, if the tool is on this host: then the call below could reach a real scheduler.
    expect(Bun.which(ISOLATION_PROBE[0]!)).toBeNull();
    expect(isRegistrationChange(ISOLATION_PROBE)).toBe(true);
    const scratch = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-iso-probe-")));
    const r = await defaultExec({ ...process.env, DBA_TEST_UNIT_DIR: scratch })(ISOLATION_PROBE);
    // The fixed text, not only -2: a spawn failure is also -2, with a different `err`.
    expect(r).toEqual({ code: -2, out: "", err: SCHEDULER_CHANGE_REFUSED });
  });

  test("a hand-built env without the variable, and no exec, is still refused: the refusal reads process.env too", async () => {
    // Spec 3.1.3, "Hand-built environments". The env object goes in the deps' `env`, with no `exec`, so
    // `resolveScheduleDeps` builds the default exec FROM it, the way production code does — and since
    // that env lacks DBA_TEST_UNIT_DIR, only the preload-armed process.env can refuse. Passing
    // `{ HOME }` as the deps object itself would leave `env` undefined, fall back to process.env, and let
    // a refusal that never reads process.env survive. Same host-absent probe as above, so even then the
    // exec could only fail to spawn, with a different text.
    expect(Bun.which(ISOLATION_PROBE[0]!)).toBeNull();
    const scratch = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-iso-hand-")));
    const d = resolveScheduleDeps({ env: { HOME: scratch } });
    expect(d.env.DBA_TEST_UNIT_DIR).toBeUndefined();   // the hand-built env really lacks it
    const r = await d.exec(ISOLATION_PROBE);
    expect(r).toEqual({ code: -2, out: "", err: SCHEDULER_CHANGE_REFUSED });
  });
});

/**
 * Comments out, code and string/template literals kept verbatim — the minimal local helper the Batch 2
 * source pins use, because isolation.meta.test.ts's `stripComments` lives in a test file and is not
 * importable. A backslash outside a literal skips the next character, so an escaped slash in a regex
 * literal (`/https?:\/\//`) is not read as a comment opener. Known limits, stated: regex literals are not
 * recognised as such, so a quote or backtick inside one can desynchronise the literal tracking, and an
 * unescaped `//` or `/*` inside a regex character class reads as a comment. Both mostly KEEP text (a
 * desynchronised literal is copied verbatim); the drop case is a comment opener read inside what is really
 * a string, which loses the rest of that line or block.
 */
function codeOnly(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      out += " ";
      continue;
    }
    if (c === "\\") {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const start = i++;
      while (i < src.length && src[i] !== c && (c === "`" || src[i] !== "\n")) i += src[i] === "\\" ? 2 : 1;
      i++;
      out += src.slice(start, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
