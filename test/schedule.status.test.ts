import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// Slice 4 T6 — `schedule status` and THE GUI'S SCHEDULING CONTRACT.
//
// ⚠ THE GOLDEN SHAPE BELOW IS THE FREEZE. `ScheduleStatusReport` is Slice 5's entire API for
// scheduling; only NEW OPTIONAL fields may be appended. This test fails on a REMOVED or RENAMED key,
// which is the direction that breaks a shipped GUI — and it deliberately does not fail on an added
// one, because additive is the whole point.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scheduleStatusReport, renderScheduleStatus, expectedTicks, type ScheduleStatusReport,
} from "../src/schedule/status";
import { writeScheduleRecord, manualRemoveSteps, execResultOf } from "../src/schedule/install";
import { SCHEDULE_LABEL, SYSTEMD_TIMER_NAME, LOGIN_ITEMS_OFF_HINT } from "../src/schedule/units";
import { tickPath, markerPath, localDateStr } from "../src/marker";
import type { Exec } from "../src/schedule/install";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

let HOME = "", UNITS = "", STATE = "", CFG = "";
let prevUnitDir: string | undefined, prevState: string | undefined, prevCfg: string | undefined;

beforeEach(() => {
  HOME = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-st-home-")));
  UNITS = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-st-units-")));
  STATE = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-st-state-")));
  CFG = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-st-cfg-")));
  prevUnitDir = process.env.DBA_TEST_UNIT_DIR;
  prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  prevCfg = process.env.XDG_CONFIG_HOME;
  process.env.DAILY_BRIEFING_STATE_DIR = STATE;
  // ⚠ XDG_CONFIG_HOME TOO, and not as boilerplate: `scheduleStatusReport` calls `loadConfig()` for
  // `morningTime`, so without this the report's floor — and therefore every ticks-vs-expected
  // assertion below — would be shaped by whatever the DEVELOPER happens to have configured. Scanner 3
  // of isolation.meta.test.ts is what makes forgetting this loud.
  process.env.XDG_CONFIG_HOME = CFG;
});
afterEach(() => {
  // Assigned back, never deleted: the preload arms DBA_TEST_UNIT_DIR as a tripwire, so the saved value is
  // never undefined, and a `delete` would throw on its non-configurable accessor.
  process.env.DBA_TEST_UNIT_DIR = prevUnitDir;
  if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
  if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevCfg;
});

const okExec: Exec = async () => ({ code: 0, out: "", err: "" });
const NOW = () => new Date(2026, 6, 16, 9, 0);   // 09:00 local, past a 07:20 floor

/** `uid: 4242`, fixed, so a probe argv never names the author's real uid's domain; `XDG_DATA_HOME` under
 *  the scratch HOME, because the env spreads `process.env` (see test/schedule.install.test.ts's `env()`). */
function deps(extra: Record<string, unknown> = {}) {
  return {
    exec: okExec, platform: "darwin" as NodeJS.Platform, home: HOME, uid: 4242,
    env: {
      ...process.env, DBA_TEST_UNIT_DIR: UNITS, DAILY_BRIEFING_STATE_DIR: STATE, USER: "tester",
      XDG_DATA_HOME: join(HOME, ".local", "share"),
    },
    now: NOW, say: () => {}, warn: () => {},
    ...extra,
  };
}

describe("⚠ the frozen JSON contract", () => {
  test("the report carries EXACTLY the documented keys — a removal or rename is breaking", async () => {
    const r = await scheduleStatusReport(deps());
    // Written out rather than snapshotted, so a diff on this list is a deliberate contract change a
    // reviewer has to read — which is what "frozen additive-only" means in practice.
    const EXPECTED = [
      "schemaVersion", "engineVersion", "platform",
      "registered", "recordPresent", "unitPresent",
      "owner", "invoker", "kind", "unitPath", "binPath", "installedAt", "installedEngineVersion",
      "lingerState",
      "lastTickState", "lastTick", "ticksToday", "ticksExpectedSinceFloor",
      "lastDelivery", "lastSkip",
      "morningTime", "isPastFloor", "intervalSec",
      "experimental", "paths",
      // Batch 2 (spec 3.1.5): appended, each always present; no existing key changed name or type.
      "registeredReason", "recordFilePresent", "removeSteps",
      // spec 2026-10-11 (login-items-off): appended, always present.
      "registeredHint",
      // provider-fallback P2-M5-T3: appended, always present.
      "scheduledEngineVersion",
    ].sort();
    const missing = EXPECTED.filter((k) => !(k in r));
    expect(`missing = ${JSON.stringify(missing)}`).toBe("missing = []");
    // The version field a GUI checks is the SAME one the A1 surfaces carry — one number, not two.
    expect(r.schemaVersion).toBe(1);
    // It must round-trip as JSON: a GUI receives this over a pipe.
    expect(JSON.parse(JSON.stringify(r)).schemaVersion).toBe(1);
  });

  test("a NEW optional field does not break a consumer — the additive direction is the supported one", async () => {
    const r = await scheduleStatusReport(deps()) as ScheduleStatusReport & { futureField?: string };
    const widened = { ...r, futureField: "x" };
    expect(widened.registered).toBe(r.registered);
    expect(JSON.parse(JSON.stringify(widened)).futureField).toBe("x");
  });
});

describe("the three-legged registration triangle", () => {
  test("record, unit file and live registration are reported SEPARATELY", async () => {
    // A record without a unit is "somebody deleted my plist"; a unit without a registration is "it is
    // on disk but not loaded". Collapsing them into one boolean would make both invisible.
    const bare = await scheduleStatusReport(deps());
    expect([bare.recordPresent, bare.unitPresent]).toEqual([false, false]);

    writeFileSync(join(UNITS, `${SCHEDULE_LABEL}.plist`), "<plist/>");
    await writeScheduleRecord({
      owner: "cli", invoker: "cli", kind: "launchd", unitPath: join(UNITS, `${SCHEDULE_LABEL}.plist`),
      binPath: "/managed/daily-briefing", installedAt: "2026-09-14T00:00:00.000Z", engineVersion: "0.1.0",
    });
    const full = await scheduleStatusReport(deps());
    expect([full.recordPresent, full.unitPresent, full.registered]).toEqual([true, true, true]);
    expect(full.owner).toBe("cli");
    expect(full.binPath).toBe("/managed/daily-briefing");
    expect(full.installedEngineVersion).toBe("0.1.0");

    // Exit 1 from every probe command with nothing on stderr is NOT "not registered" (Batch 2, spec 3.1.5):
    // a killed command can surface as an ordinary code, so the check cannot say — `null`, with the reason.
    const dead = await scheduleStatusReport(deps({ exec: (async () => ({ code: 1, out: "", err: "" })) as Exec }));
    expect([dead.recordPresent, dead.unitPresent, dead.registered]).toEqual([true, true, null]);
    expect(dead.registeredReason).toBe("unexpected");
  });

  test("engine SKEW is visible — the Schedule panel's 'update background engine' prompt keys on it", async () => {
    await writeScheduleRecord({
      owner: "app", invoker: "app", kind: "launchd", unitPath: "/u", binPath: "/b",
      installedAt: "2026-01-01T00:00:00.000Z", engineVersion: "0.0.1-ancient",
    });
    const r = await scheduleStatusReport(deps());
    expect(r.installedEngineVersion).toBe("0.0.1-ancient");
    expect(r.engineVersion).not.toBe("0.0.1-ancient");
    expect(renderScheduleStatus(r)).toContain("engine skew");
    // An app-owned schedule refuses a terminal `schedule install`, so the remedy names the app's button.
    expect(renderScheduleStatus(r)).toContain("click Update background engine on the app's Schedule screen");
    expect(renderScheduleStatus(r)).not.toContain("re-run `schedule install`");
  });

  test("engine SKEW on a CLI-owned schedule keeps the terminal remedy", async () => {
    await writeScheduleRecord({
      owner: "cli", invoker: "cli", kind: "launchd", unitPath: "/u", binPath: "/b",
      installedAt: "2026-01-01T00:00:00.000Z", engineVersion: "0.0.1-ancient",
    });
    const out = renderScheduleStatus(await scheduleStatusReport(deps()));
    expect(out).toContain("re-run `schedule install` to refresh it");
    expect(out).not.toContain("Update background engine");
  });
});

describe("⚠ the last-tick parse — a pre-fix line is UNTRUSTWORTHY, never zero", () => {
  test("no heartbeat file at all reads as 'absent' with a null count", async () => {
    const r = await scheduleStatusReport(deps());
    expect([r.lastTickState, r.ticksToday, r.lastTick]).toEqual(["absent", null, null]);
  });

  test("a PRE-FIX line (`<iso> today=<n>`, no local=) is 'legacy' and ticksToday is NULL", async () => {
    // ⚠ THE DAY-35 TRAP. `stampTick` wrote `<iso> today=<n>` before 2026-08-20. Reporting that as
    // ticksToday: 0 would be exactly the value STATE.md's watch 1 reads as "launchd never fired" — so
    // a machine ticking happily all morning would be reported as a dead scheduler. Untrustworthy is a
    // DIFFERENT fact from zero, and from "no heartbeat at all".
    writeFileSync(tickPath(), "2026-08-19T14:00:00.000Z today=37\n");
    const r = await scheduleStatusReport(deps());
    expect(r.lastTickState).toBe("legacy");
    expect(r.ticksToday).toBeNull();
    expect(r.lastTick).toBeNull();
    const human = renderScheduleStatus(r);
    expect(human).toContain("UNKNOWN");
    expect(human).toContain("not the same as zero");
    expect(human).not.toContain("ticks today:     0");
  });

  test("garbage is 'legacy' too, and an EMPTY file is 'absent'", async () => {
    writeFileSync(tickPath(), "not a heartbeat line at all\n");
    expect((await scheduleStatusReport(deps())).lastTickState).toBe("legacy");
    writeFileSync(tickPath(), "   \n");
    expect((await scheduleStatusReport(deps())).lastTickState).toBe("absent");
  });

  test("a CURRENT line parses, and a YESTERDAY line counts as 0 for TODAY rather than overstating", async () => {
    const today = localDateStr(NOW());
    writeFileSync(tickPath(), `2026-07-16T16:00:00.000Z local=${today} today=11\n`);
    const r = await scheduleStatusReport(deps());
    expect(r.lastTickState).toBe("ok");
    expect(r.ticksToday).toBe(11);
    expect(r.lastTick).toEqual({ iso: "2026-07-16T16:00:00.000Z", localDate: today, count: 11 });

    // A parsed line from a DIFFERENT day is not today's count. Reporting 11 here would claim a
    // scheduler that has not fired since yesterday is healthy.
    writeFileSync(tickPath(), "2026-07-15T16:00:00.000Z local=2026-07-15 today=11\n");
    const stale = await scheduleStatusReport(deps());
    expect([stale.lastTickState, stale.ticksToday]).toEqual(["ok", 0]);
  });
});

describe("ticks today vs expected — the day-34 diagnostic", () => {
  test("expectedTicks counts from the floor, inclusive, and is null below it", () => {
    const at = (h: number, m: number) => new Date(2026, 6, 16, h, m);
    const floor = 7 * 60 + 20;
    expect(expectedTicks(at(7, 19), floor, 600)).toBeNull();   // below the floor: "expected" is meaningless
    expect(expectedTicks(at(7, 20), floor, 600)).toBe(1);      // the floor tick itself
    expect(expectedTicks(at(7, 30), floor, 600)).toBe(2);
    expect(expectedTicks(at(9, 0), floor, 600)).toBe(11);      // 100 min / 10 + 1
    expect(expectedTicks(at(23, 59), floor, 600)).toBe(100);
  });

  test("the pair is what discriminates 'the gate is broken' from 'launchd never fired'", async () => {
    const today = localDateStr(NOW());
    writeFileSync(tickPath(), `2026-07-16T16:00:00.000Z local=${today} today=11\n`);
    const healthy = await scheduleStatusReport(deps());
    // 11 ticks against ~11 expected: ticks WERE firing, so a late briefing is a GATE defect.
    expect(`${healthy.ticksToday}/${healthy.ticksExpectedSinceFloor}`).toBe("11/11");
    writeFileSync(tickPath(), `2026-07-16T16:00:00.000Z local=${today} today=1\n`);
    const starved = await scheduleStatusReport(deps());
    expect(`${starved.ticksToday}/${starved.ticksExpectedSinceFloor}`).toBe("1/11");
  });
});

describe("linger and the experimental label", () => {
  test("darwin reports not-applicable; linux reports what loginctl says", async () => {
    expect((await scheduleStatusReport(deps())).lingerState).toBe("not-applicable");
    const yes = await scheduleStatusReport(deps({
      platform: "linux", exec: (async () => ({ code: 0, out: "Linger=yes\n", err: "" })) as Exec,
    }));
    expect(yes.lingerState).toBe("enabled");
    const no = await scheduleStatusReport(deps({
      platform: "linux", exec: (async () => ({ code: 0, out: "Linger=no\n", err: "" })) as Exec,
    }));
    expect(no.lingerState).toBe("disabled");
    // A probe that cannot answer is "unknown", never a guess — a headless box is exactly where a
    // wrong answer costs every future briefing.
    const dunno = await scheduleStatusReport(deps({
      platform: "linux", exec: (async () => ({ code: 1, out: "", err: "" })) as Exec,
    }));
    expect(dunno.lingerState).toBe("unknown");
  });

  test("win32 is flagged experimental on the surface a GUI reads AND in the human text", async () => {
    const r = await scheduleStatusReport(deps({ platform: "win32" }));
    expect(r.experimental).toBe(true);
    expect(renderScheduleStatus(r)).toContain("EXPERIMENTAL");
    expect((await scheduleStatusReport(deps())).experimental).toBe(false);
  });
});

test("it reads the delivery marker WITHOUT repairing it — a polled repair is a write loop", async () => {
  writeFileSync(markerPath(), localDateStr(NOW()));
  const r = await scheduleStatusReport(deps());
  expect(r.lastDelivery).toBe(localDateStr(NOW()));
  // `readLastRunDate` is the total, non-repairing read; `checkRanToday` (which UNLINKS and REWRITES an
  // unreadable marker) must never be reachable from a surface something polls every few seconds.
  const src = await Bun.file(new URL("../src/schedule/status.ts", import.meta.url).pathname).text();
  expect(src).not.toContain("checkRanToday");
});

test("the human rendering is a pure function of the report, so text and JSON cannot disagree", async () => {
  const r = await scheduleStatusReport(deps());
  expect(renderScheduleStatus(r)).toBe(renderScheduleStatus(r));
  expect(renderScheduleStatus({ ...r, owner: "app" })).toContain("app");
});

// v0.2.1 §3.1: one name, "Morning time", on every surface a user reads. The two lines below are the CLI's
// `schedule status` text, and docs/TROUBLESHOOTING.md documents the label as a lookup key — so the exact
// text is pinned here (no test pinned it before), and the doc changes in the same commit.
describe("the human text says 'morning time', never 'floor' (v0.2.1 §3.1)", () => {
  test("past the morning time, with a current heartbeat", async () => {
    writeFileSync(tickPath(), `2026-07-16T16:00:00.000Z local=${localDateStr(NOW())} today=11\n`);
    const text = renderScheduleStatus(await scheduleStatusReport(deps()));
    expect(text).toContain("morning time:    07:20 (past)");
    expect(text).toContain("ticks today:     11 of ~11 expected since the morning time");
    expect(text).not.toMatch(/floor/i);
  });

  test("before the morning time", async () => {
    const text = renderScheduleStatus(await scheduleStatusReport(deps({ now: () => new Date(2026, 6, 16, 7, 0) })));
    expect(text).toContain("morning time:    07:20 (not yet reached)");
    expect(text).not.toMatch(/floor/i);
  });
});

// ── Batch 2 (spec 3.1.5 "Status reuses it"): `registered` comes from the ONE registration check,
// `probeRegistration`, so status and uninstall can never disagree about it; `unitPresent` and the new
// `recordFilePresent` are the `lstat` look; `removeSteps` carries the manual steps.
//
// ⚠ THESE FAKES ANSWER BY VERB OR DOMAIN, NEVER BY `cmd[0]`, and no literal here names a scheduler tool:
// isolation.meta.test.ts's scanner 2 exempts only test/schedule.install.test.ts.
describe("Batch 2: the five changed fields (spec 3.1.5)", () => {
  type Answer = { code: number; out?: string; err?: string };
  /** A fake exec answering by verb or domain, recording each call and its timeoutMs. */
  function byVerb(answer: (cmd: string[]) => Answer) {
    const calls: string[][] = [];
    const timeouts: Array<number | undefined> = [];
    const exec: Exec = async (cmd, opts) => {
      calls.push(cmd);
      timeouts.push(opts?.timeoutMs);
      const a = answer(cmd);
      return { code: a.code, out: a.out ?? "", err: a.err ?? "" };
    };
    return { exec, calls, timeouts };
  }
  const NOT_FOUND: Answer = { code: 113, err: `Could not find service "${SCHEDULE_LABEL}" in domain for port` };
  /** macOS, nothing registered: both prints and the list report service-not-found. */
  const macGone = (cmd: string[]): Answer => (cmd[1] === "print" || cmd[1] === "list" ? NOT_FOUND : { code: 0 });

  test("registered is the check mapped to true / false / null, and registeredReason is set exactly when it is null", async () => {
    const present = await scheduleStatusReport(deps({ exec: byVerb(() => ({ code: 0 })).exec }));
    expect([present.registered, present.registeredReason]).toEqual([true, null]);
    const gone = await scheduleStatusReport(deps({ exec: byVerb(macGone).exec }));
    expect([gone.registered, gone.registeredReason]).toEqual([false, null]);
    // A missing desktop domain (an SSH session) is never "not registered".
    const noSession = await scheduleStatusReport(deps({
      exec: byVerb((c) => (c[2]?.startsWith("gui/") ? { code: 113, err: "Could not find domain for port identifier" } : NOT_FOUND)).exec,
    }));
    expect([noSession.registered, noSession.registeredReason]).toEqual([null, "no-gui-session"]);
    expect(renderScheduleStatus(noSession)).toContain("registered:      unknown");
  });

  // spec 2026-10-11 (login-items-off): the plist on disk and launchd finding no job is what an item
  // switched off in Login Items looks like (measured on macOS 26.6.2). Only that combination sets the hint.
  test("registeredHint: login-items-off exactly when darwin, a unit file on disk and the check says gone", async () => {
    const plist = join(UNITS, `${SCHEDULE_LABEL}.plist`);
    const noUnit = await scheduleStatusReport(deps({ exec: byVerb(macGone).exec }));
    expect([noUnit.registered, noUnit.registeredHint]).toEqual([false, null]);
    expect(renderScheduleStatus(noUnit)).not.toContain(LOGIN_ITEMS_OFF_HINT);

    writeFileSync(plist, "<plist/>");
    const off = await scheduleStatusReport(deps({ exec: byVerb(macGone).exec }));
    expect([off.registered, off.unitPresent, off.registeredHint]).toEqual([false, true, "login-items-off"]);
    expect(JSON.parse(JSON.stringify(off)).registeredHint).toBe("login-items-off");
    const text = renderScheduleStatus(off).split("\n");
    expect(text[text.findIndex((l) => l.startsWith("registered:")) + 1]).toBe(`  ⚠ ${LOGIN_ITEMS_OFF_HINT}`);

    const present = await scheduleStatusReport(deps({ exec: byVerb(() => ({ code: 0 })).exec }));
    expect([present.registered, present.registeredHint]).toEqual([true, null]);
    const unknown = await scheduleStatusReport(deps({
      exec: byVerb((c) => (c[2]?.startsWith("gui/") ? { code: 113, err: "Could not find domain for port identifier" } : NOT_FOUND)).exec,
    }));
    expect([unknown.registered, unknown.registeredHint]).toEqual([null, null]);
    expect(renderScheduleStatus(unknown)).not.toContain(LOGIN_ITEMS_OFF_HINT);

    // Linux, with its units on disk and the check saying gone: never the hint, which names a macOS setting.
    const lin = byVerb((c) => (c[2] === "is-active" ? { code: 3, out: "inactive\ninactive\n" } : c[2] === "is-enabled" ? { code: 1, out: "disabled\n" } : { code: 0 }));
    for (const p of (await scheduleStatusReport(deps({ platform: "linux", exec: lin.exec }))).paths.unitPaths) writeFileSync(p, "unit\n");
    const linux = await scheduleStatusReport(deps({ platform: "linux", exec: lin.exec }));
    expect([linux.registered, linux.unitPresent, linux.registeredHint]).toEqual([false, true, null]);
  });

  test("both prints not found but list gives NO answer → registered: null, never false", async () => {
    // A not-found from the two prints is not enough on its own: `list` must report not-found too (spec
    // 3.1.5 step 3). Exit 1 with an empty stderr is no answer (a killed command can surface as an ordinary
    // code), and a thrown exec counts as -2.
    const printsNotFound = (list: (cmd: string[]) => Answer) => (cmd: string[]): Answer =>
      (cmd[1] === "print" ? NOT_FOUND : cmd[1] === "list" ? list(cmd) : { code: 0 });
    const exitOne = await scheduleStatusReport(deps({ exec: byVerb(printsNotFound(() => ({ code: 1 }))).exec }));
    expect([exitOne.registered, exitOne.registeredReason]).toEqual([null, "unexpected"]);
    const thrown = await scheduleStatusReport(deps({
      exec: byVerb(printsNotFound(() => { throw new Error("list was killed"); })).exec,
    }));
    expect([thrown.registered, thrown.registeredReason]).toEqual([null, "spawn"]);
  });

  test("the probe asks by the exact label with deps' uid", async () => {
    const f = byVerb(macGone);
    await scheduleStatusReport(deps({ exec: f.exec }));
    expect(f.calls.map((c) => c.slice(1).join(" "))).toEqual([
      `print gui/4242/${SCHEDULE_LABEL}`, `print user/4242/${SCHEDULE_LABEL}`, `list ${SCHEDULE_LABEL}`,
    ]);
  });

  test("every probe exec, and the Linux linger exec, is capped at 5 s", async () => {
    const mac = byVerb(macGone);
    await scheduleStatusReport(deps({ exec: mac.exec }));
    expect(mac.timeouts).toEqual([5_000, 5_000, 5_000]);

    const lin = byVerb((c) =>
      c.includes("show-user") ? { code: 0, out: "Linger=yes\n" }
        : c.includes("is-active") ? { code: 3, out: "inactive\ninactive\n" }
          : { code: 1, out: "disabled\n" });
    const r = await scheduleStatusReport(deps({ platform: "linux", exec: lin.exec }));
    expect([r.registered, r.lingerState]).toEqual([false, "enabled"]);
    expect(lin.calls.filter((c) => c.includes("show-user")).length).toBe(1);
    expect(lin.timeouts).toEqual([5_000, 5_000, 5_000]);
  });

  test("a THROWN exec gives registered: null with reason spawn — never a crash, on any platform", async () => {
    const boom: Exec = async () => { throw new Error("no such binary"); };
    for (const platform of ["darwin", "linux", "win32"]) {
      const r = await scheduleStatusReport(deps({ platform, exec: boom }));
      expect(`${platform}: ${r.registered}/${r.registeredReason}`).toBe(`${platform}: null/spawn`);
    }
  });

  test("an exec that throws SYNCHRONOUSLY — before it returns a promise — is the same: registered null/spawn, linger unknown, never a crash", async () => {
    // Non-async on purpose: a `.catch` chained onto the exec's result never sees this throw, so the call itself
    // must sit inside the try (spec 3.1.4: a thrown exec counts as -2; 3.1.5: it gives null, never a crash).
    const syncBoom: Exec = () => { throw new Error("boom"); };
    for (const [platform, linger] of [["darwin", "not-applicable"], ["linux", "unknown"], ["win32", "not-applicable"]]) {
      const r = await scheduleStatusReport(deps({ platform, exec: syncBoom }));
      expect(`${platform}: ${r.registered}/${r.registeredReason}/${r.lingerState}`).toBe(`${platform}: null/spawn/${linger}`);
    }
  });

  test("registered: null WITH a record — a Linux user manager out of reach is unknown, not 'not registered'", async () => {
    // This used to read `false`, which the app derives as scheduler-broken and offers Repair for. Unknown
    // is not broken (spec 3.1.5): the record is still reported, so Remove still shows.
    await writeScheduleRecord({
      owner: "app", invoker: "app", kind: "systemd", unitPath: join(UNITS, SYSTEMD_TIMER_NAME),
      binPath: "/managed/daily-briefing", installedAt: "2026-09-14T00:00:00.000Z", engineVersion: "0.2.1",
    });
    const bus = byVerb((c) => (c.includes("show-user") ? { code: 1 } : { code: 1, err: "Failed to connect to bus: No medium found" }));
    const r = await scheduleStatusReport(deps({ platform: "linux", exec: bus.exec }));
    expect([r.recordPresent, r.recordFilePresent, r.registered, r.registeredReason]).toEqual([true, true, null, "no-user-manager"]);
  });

  test("unitPresent is the lstat look: a DANGLING symlink at the unit path counts", async () => {
    expect((await scheduleStatusReport(deps())).unitPresent).toBe(false);
    symlinkSync(join(UNITS, "gone-target.plist"), join(UNITS, `${SCHEDULE_LABEL}.plist`));
    const r = await scheduleStatusReport(deps());
    expect(r.unitPresent).toBe(true);
    expect(renderScheduleStatus(r)).not.toContain("no unit file on disk");
  });

  test("recordFilePresent is the lstat look; recordPresent stays 'a readable record' under the shared bounded read", async () => {
    const rp = join(STATE, "schedule.json");
    const look = async () => { const r = await scheduleStatusReport(deps()); return [r.recordPresent, r.recordFilePresent]; };
    expect(await look()).toEqual([false, false]);
    writeFileSync(rp, '{"owner":"app","unitPa');                           // malformed
    expect(await look()).toEqual([false, true]);
    rmSync(rp);
    symlinkSync(join(STATE, "nowhere.json"), rp);                         // dangling symlink
    expect(await look()).toEqual([false, true]);
    rmSync(rp);
    const valid = {
      owner: "app", invoker: "app", kind: "launchd", unitPath: "/u", binPath: "/b",
      installedAt: "2026-09-14T00:00:00.000Z", engineVersion: "0.2.1",
    };
    writeFileSync(join(STATE, "elsewhere.json"), JSON.stringify(valid));
    symlinkSync(join(STATE, "elsewhere.json"), rp);                       // a symlink, even to a valid record
    expect(await look()).toEqual([false, true]);
    rmSync(rp);
    writeFileSync(rp, JSON.stringify(valid) + " ".repeat(64 * 1024));     // valid JSON, but over 64 KiB
    expect(await look()).toEqual([false, true]);
    rmSync(rp);
    writeFileSync(rp, JSON.stringify(valid));
    expect(await look()).toEqual([true, true]);
  });

  test("removeSteps: this machine's manual steps, with no closing line — and null off launchd and systemd", async () => {
    const mac = await scheduleStatusReport(deps());
    expect(mac.removeSteps).toBe(manualRemoveSteps("launchd", { units: mac.paths.unitPaths, record: mac.paths.schedulePath, home: HOME }));
    expect(mac.removeSteps!.split("\n")[0]).toBe("Run these in a terminal (bash or zsh) inside your desktop session.");
    // These scratch paths lie outside HOME, so each is one single-quoted word.
    expect(mac.removeSteps).toContain(`'${mac.paths.unitPaths[0]}'`);
    expect(mac.removeSteps).toContain(`'${mac.paths.schedulePath}'`);
    expect(mac.removeSteps).not.toContain("Then run");
    expect(mac.removeSteps).not.toContain("Then press");

    const lin = await scheduleStatusReport(deps({ platform: "linux" }));
    expect(lin.removeSteps).toBe(manualRemoveSteps("systemd", { units: lin.paths.unitPaths, record: lin.paths.schedulePath, home: HOME }));

    for (const platform of ["win32", "freebsd"]) {
      const r = await scheduleStatusReport(deps({ platform }));
      expect(`${platform}: ${JSON.stringify(r.removeSteps)}`).toBe(`${platform}: null`);
    }
    // It survives the JSON pipe the app reads it through, null included.
    expect(JSON.parse(JSON.stringify(mac)).removeSteps).toBe(mac.removeSteps);
  });
});

// provider-fallback P2-M5-T3 (spec r9 §6): the scheduled engine's version MEASURED from `<binPath> --version`, because
// the install-time record (`installedEngineVersion`) can be stale — a binary replaced in place keeps its record. Through
// the injected exec like every other status exec, capped at the same 5 s; absent or failing reads null, never a crash.
describe("scheduledEngineVersion (P2-M5-T3)", () => {
  const BIN = "/managed/daily-briefing";
  const record = (engineVersion = "0.1.0") => writeScheduleRecord({
    owner: "cli", invoker: "cli", kind: "launchd", unitPath: join(UNITS, `${SCHEDULE_LABEL}.plist`),
    binPath: BIN, installedAt: "2026-09-14T00:00:00.000Z", engineVersion,
  });
  /** Answers `<BIN> --version` with `version`, every probe with 0; records each call and its timeout. */
  function versionExec(version: (opts?: { timeoutMs?: number }) => Promise<{ code: number; out: string; err: string }>) {
    const calls: { cmd: string[]; timeoutMs?: number }[] = [];
    const exec: Exec = async (cmd, opts) => {
      calls.push({ cmd, timeoutMs: opts?.timeoutMs });
      return cmd[0] === BIN ? version(opts) : { code: 0, out: "", err: "" };
    };
    return { exec, calls };
  }
  const ok = (out: string) => async () => ({ code: 0, out, err: "" });

  test("the version from `<binPath> --version`, through the injected exec, capped at 5 s — measured, not the record", async () => {
    await record("0.1.0");
    const f = versionExec(ok("0.2.1\n"));
    const r = await scheduleStatusReport(deps({ exec: f.exec }));
    expect(r.scheduledEngineVersion).toBe("0.2.1");
    expect(r.installedEngineVersion).toBe("0.1.0");          // the record stays what it says
    expect(f.calls.filter((c) => c.cmd[0] === BIN)).toEqual([{ cmd: [BIN, "--version"], timeoutMs: 5_000 }]);
    expect(JSON.parse(JSON.stringify(r)).scheduledEngineVersion).toBe("0.2.1");
    // A pre-release spelling, and CRLF output, read as written.
    expect((await scheduleStatusReport(deps({ exec: versionExec(ok("0.3.0-rc.1\r\n")).exec }))).scheduledEngineVersion).toBe("0.3.0-rc.1");
  });

  test("no record, or a record with no binPath: null, and nothing is run", async () => {
    const none = versionExec(ok("0.2.1\n"));
    expect((await scheduleStatusReport(deps({ exec: none.exec }))).scheduledEngineVersion).toBeNull();
    expect(none.calls.filter((c) => c.cmd.includes("--version"))).toEqual([]);
    writeFileSync(join(STATE, "schedule.json"), JSON.stringify({
      owner: "cli", invoker: "cli", kind: "launchd", unitPath: "/u", binPath: "", installedAt: "2026-09-14T00:00:00.000Z", engineVersion: "0.1.0",
    }));
    const empty = versionExec(ok("0.2.1\n"));
    const r = await scheduleStatusReport(deps({ exec: empty.exec }));
    expect([r.recordPresent, r.scheduledEngineVersion]).toEqual([true, null]);
    expect(empty.calls.filter((c) => c.cmd.includes("--version"))).toEqual([]);
  });

  test("a failing read is null, never a crash: non-zero exit, could not run, thrown (async or sync), not a version", async () => {
    await record();
    const cases: [string, Exec][] = [
      ["exit 1", versionExec(async () => ({ code: 1, out: "0.2.1\n", err: "" })).exec],
      ["could not run (-2)", versionExec(async () => ({ code: -2, out: "", err: "ENOENT" })).exec],
      ["thrown", versionExec(async () => { throw new Error("no such binary"); }).exec],
      ["thrown synchronously", ((cmd: string[]) => { if (cmd[0] === BIN) throw new Error("boom"); return Promise.resolve({ code: 0, out: "", err: "" }); }) as Exec],
      ["empty output", versionExec(ok("")).exec],
      ["not a version", versionExec(ok("Usage: daily-briefing [options]\n")).exec],
      ["a version with trailing words", versionExec(ok("0.2.1 (built today)\n")).exec],
      ["an escape sequence", versionExec(ok("\u001b[2J0.2.1\n")).exec],
    ];
    for (const [name, exec] of cases) {
      const r = await scheduleStatusReport(deps({ exec }));
      expect(`${name}: ${JSON.stringify(r.scheduledEngineVersion)}`).toBe(`${name}: null`);
      expect(`${name}: ${r.recordPresent}`).toBe(`${name}: true`);
    }
  });

  test("a HUNG binary is cut at the bound and reads null: proc.run's timed-out result, through the production mapping", async () => {
    // The default exec hands `timeoutMs` to proc.run, whose SIGKILL ceiling ends a hung child and reports
    // `timedOut` — which `execResultOf` maps to -1. Even output the child printed before it hung is not read.
    // P2-M5-T4 checkpoint LOW 4: the fake is otherwise a COMPLETE, exit-0 read of a good version, so `timedOut` ALONE
    // must make it null — and it is set only when the call carried the 5 s bound, so a call without it reads "0.2.1".
    await record();
    const f = versionExec((opts) => execResultOf(Promise.resolve({
      out: "0.2.1\n", err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: opts?.timeoutMs === 5_000,
    } as never)));
    const r = await scheduleStatusReport(deps({ exec: f.exec }));
    expect(f.calls.filter((c) => c.cmd[0] === BIN).map((c) => c.timeoutMs)).toEqual([5_000]);
    expect(r.scheduledEngineVersion).toBeNull();
  });

  // P2-M5-T4 checkpoint LOW 3: only an ABSOLUTE binPath is run. A relative or bare one would resolve against the
  // status caller's cwd or PATH — a binary nobody scheduled — so it reads null and nothing is executed.
  test("a relative or bare binPath: null, and nothing is run", async () => {
    for (const binPath of ["daily-briefing", "./daily-briefing", "bin/daily-briefing", "../managed/daily-briefing"]) {
      writeFileSync(join(STATE, "schedule.json"), JSON.stringify({
        owner: "cli", invoker: "cli", kind: "launchd", unitPath: "/u", binPath, installedAt: "2026-09-14T00:00:00.000Z", engineVersion: "0.1.0",
      }));
      const calls: string[][] = [];
      const exec: Exec = async (cmd) => { calls.push(cmd); return cmd.includes("--version") ? { code: 0, out: "0.2.1\n", err: "" } : { code: 0, out: "", err: "" }; };
      const r = await scheduleStatusReport(deps({ exec }));
      expect(`${binPath}: ${r.binPath} ${JSON.stringify(r.scheduledEngineVersion)}`).toBe(`${binPath}: ${binPath} null`);
      expect(`${binPath}: ${JSON.stringify(calls.filter((c) => c.includes("--version") || c[0] === binPath))}`).toBe(`${binPath}: []`);
    }
  });
});
