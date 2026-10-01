import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// Slice 4 T6 — `schedule status` and THE GUI'S SCHEDULING CONTRACT.
//
// ⚠ THE GOLDEN SHAPE BELOW IS THE FREEZE. `ScheduleStatusReport` is Slice 5's entire API for
// scheduling; only NEW OPTIONAL fields may be appended. This test fails on a REMOVED or RENAMED key,
// which is the direction that breaks a shipped GUI — and it deliberately does not fail on an added
// one, because additive is the whole point.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scheduleStatusReport, renderScheduleStatus, expectedTicks, type ScheduleStatusReport,
} from "../src/schedule/status";
import { writeScheduleRecord } from "../src/schedule/install";
import { SCHEDULE_LABEL } from "../src/schedule/units";
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
  if (prevUnitDir === undefined) delete process.env.DBA_TEST_UNIT_DIR; else process.env.DBA_TEST_UNIT_DIR = prevUnitDir;
  if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
  if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevCfg;
});

const okExec: Exec = async () => ({ code: 0, out: "", err: "" });
const NOW = () => new Date(2026, 6, 16, 9, 0);   // 09:00 local, past a 07:20 floor

function deps(extra: Record<string, unknown> = {}) {
  return {
    exec: okExec, platform: "darwin" as NodeJS.Platform, home: HOME,
    env: { ...process.env, DBA_TEST_UNIT_DIR: UNITS, DAILY_BRIEFING_STATE_DIR: STATE, USER: "tester" },
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

    // A failing probe means NOT registered even with both files present.
    const dead = await scheduleStatusReport(deps({ exec: (async () => ({ code: 1, out: "", err: "" })) as Exec }));
    expect([dead.recordPresent, dead.unitPresent, dead.registered]).toEqual([true, true, false]);
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
