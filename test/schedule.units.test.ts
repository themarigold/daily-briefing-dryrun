// Slice 4 T1 — golden tests for the PURE per-OS unit generators.
//
// No state-dir isolation fixture is needed here and none is imported: every function under test is
// pure, takes its paths as arguments, and touches no filesystem. The two lint helpers below write to
// a fresh tmpdir and read it back — never to the state dir, never to a unit directory.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchdPlist, systemdUnits, windowsTaskXml, windowsTaskXmlBytes, floorClock, assertNoMountPath,
  SCHEDULE_LABEL, WINDOWS_XML_BOM, WINDOWS_XML_ENCODING, DEFAULT_INTERVAL_SEC,
  type ScheduleOpts,
} from "../src/schedule/units";
import { parseFloor } from "../src/schedule";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const OPTS: ScheduleOpts = {
  binPath: "/home/x/.local/share/daily-briefing/bin/daily-briefing",
  label: SCHEDULE_LABEL,
  logPath: "/home/x/.local/state/daily-briefing/briefing.log",
  floorMinutes: parseFloor("07:20").minutes,
  intervalSec: DEFAULT_INTERVAL_SEC,
  pathEnv: "/home/x/.local/bin:/usr/bin:/bin",
};

describe("floorClock", () => {
  test("derives Hour/Minute from minutes-since-midnight, and clamps rather than throwing", () => {
    expect(floorClock(7 * 60 + 20)).toEqual({ hour: 7, minute: 20 });
    expect(floorClock(0)).toEqual({ hour: 0, minute: 0 });
    expect(floorClock(23 * 60 + 59)).toEqual({ hour: 23, minute: 59 });
    // Total over any finite input: the only producer is parseFloor, which already degrades a bad
    // morningTime — a throw here would turn a config typo into a FAILED install.
    expect(floorClock(-5)).toEqual({ hour: 0, minute: 0 });
    expect(floorClock(99_999)).toEqual({ hour: 23, minute: 59 });
    expect(floorClock(Number.NaN)).toEqual({ hour: 0, minute: 0 });
  });
});

describe("launchdPlist", () => {
  test("the calendar trigger derives from floorMinutes — NOT a literal 7/20 (T5)", () => {
    // The whole point: a user who moves their floor moves the second trigger with it. A hardcoded
    // 7/20 would leave the calendar fire behind at the old hour, silently.
    const xml = launchdPlist({ ...OPTS, floorMinutes: parseFloor("05:45").minutes });
    expect(xml).toContain("<key>Hour</key><integer>5</integer><key>Minute</key><integer>45</integer>");
    expect(xml).not.toContain("<integer>7</integer><key>Minute</key><integer>20</integer>");
    const other = launchdPlist({ ...OPTS, floorMinutes: parseFloor("13:05").minutes });
    expect(other).toContain("<key>Hour</key><integer>13</integer><key>Minute</key><integer>5</integer>");
  });

  // THE AMENDED PIN, AND WHY (moved here from test/plist.test.ts in the 2026-09-24 trim; this is now the
  // only test asserting the StartInterval + RunAtLoad + StartCalendarInterval trio). plist.test.ts once
  // read `expect(xml).not.toContain("StartCalendarInterval")` from the StartCalendarInterval→StartInterval
  // migration onward. That pin recorded a real decision: a calendar-only agent fires ONCE at a fixed hour
  // and misses a machine that was asleep at that instant, so the migration replaced it with a 10-minute
  // interval plus RunAtLoad, and the pin stopped anyone quietly migrating back.
  //
  // Slice 4 did NOT migrate back, and that distinction is the whole justification for the amended pin.
  // `StartInterval` and `RunAtLoad` are both still asserted below, unchanged; the calendar entry is ADDED
  // ALONGSIDE them as a SECOND, independent trigger. The interval agent remains the primary mechanism.
  //
  // What the addition buys, and the evidence for it: EVAL.md records day 34 delivering ~110 minutes past
  // the floor on a machine that never slept, with a healthy agent (runs = 260) and no provider failure.
  // Two candidate mechanisms (launchd withholding/coalescing an interval tick on an idle-but-awake
  // system; a non-active Aqua session) and — measured again in Slice 4 — still no observation that
  // discriminates them. So this is MITIGATION, not diagnosis: with two independent triggers a withheld
  // interval tick is no longer a single point of failure, and launchd runs a missed calendar fire at
  // wake. The once-per-day marker dedupes the extra fire, so the cost is one no-op run per day (pinned by
  // the two-ticks-one-day test in test/schedule.second-trigger.test.ts).
  //
  // The personal pipeline has run exactly this two-trigger pattern in production for months
  // (local.daily_briefing_timer.plist, whose inline comment gives the same reason).
  //
  // ⚠ If you are here because you want to REMOVE StartInterval and keep only the calendar entry: do
  // not. That is the migration the original pin forbade, and nothing in Slice 4 revisited it.
  test("keeps both original triggers alongside the new one, and the exact log/PATH keys", () => {
    const xml = launchdPlist(OPTS);
    expect(xml).toContain(`<key>Label</key><string>${SCHEDULE_LABEL}</string>`);
    expect(xml).toContain("<key>StartInterval</key><integer>600</integer>");
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>StartCalendarInterval</key>");
    expect(xml).toContain(`<key>StandardOutPath</key><string>${OPTS.logPath}</string>`);
    expect(xml).toContain(`<key>StandardErrorPath</key><string>${OPTS.logPath}</string>`);
    expect(xml).toContain(`<key>PATH</key><string>${OPTS.pathEnv}</string>`);
  });

  test("XML-escapes interpolated paths — the `sed` it replaces did not", () => {
    // A home directory containing `&` produced a malformed plist that launchctl silently refused.
    // No path on the author's machine contains one, which is exactly why it never bit.
    const xml = launchdPlist({ ...OPTS, binPath: "/Users/a&b/bin/daily-briefing" });
    expect(xml).toContain("/Users/a&amp;b/bin/daily-briefing");
    expect(xml).not.toContain("/Users/a&b/bin");
  });

  // ⚠ `plutil -lint` is a READ-ONLY syntax check of a file in a fresh tmpdir. It is not a scheduler
  // binary, mutates nothing, and reaches no LaunchAgents directory — which is why it is not in
  // `isolation.meta.test.ts`'s FORBIDDEN_BINARIES and needs no allowlist entry there.
  test.if(process.platform === "darwin")("the generated plist passes plutil -lint", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-plist-lint-")));
    const p = join(dir, "probe.plist");
    writeFileSync(p, launchdPlist(OPTS));
    const proc = Bun.spawn(["plutil", "-lint", p], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    expect(`exit=${proc.exitCode} ${out}${err}`).toContain("exit=0");
  });
});

describe("systemdUnits", () => {
  test("ExecStart is ABSOLUTE, QUOTED, and points at the managed copy", () => {
    const { service } = systemdUnits(OPTS);
    expect(service).toContain(`ExecStart="${OPTS.binPath}" run`);
    // systemd rejects a relative ExecStart outright; assert the property, not just the string.
    expect(/^ExecStart="\//m.test(service)).toBe(true);
    expect(service).toContain("Type=oneshot");
  });

  test("⚠ A SPACE IN THE PATH DOES NOT WORD-SPLIT: ExecStart and Environment are both quoted", () => {
    // `/home/john smith/…` is an ordinary home directory and a legal XDG dir. Unquoted, systemd splits
    // `ExecStart=/home/john smith/…/daily-briefing run` into the binary `/home/john` with the
    // arguments `smith/…/daily-briefing run`, and the unit fails at EVERY fire — silently, since a
    // user timer's failure is a journal line nobody reads. Same for `Environment=PATH=…`.
    const spaced = systemdUnits({
      ...OPTS,
      binPath: "/home/john smith/.local/share/daily-briefing/bin/daily-briefing",
      pathEnv: "/home/john smith/.local/bin:/usr/bin:/bin",
    });
    expect(spaced.service).toContain(`ExecStart="/home/john smith/.local/share/daily-briefing/bin/daily-briefing" run`);
    expect(spaced.service).toContain(`Environment="PATH=/home/john smith/.local/bin:/usr/bin:/bin"`);
    // …and no line survives in the split-able form.
    expect(/^ExecStart=\/home\/john smith/m.test(spaced.service)).toBe(false);
    expect(/^Environment=PATH=/m.test(spaced.service)).toBe(false);
    // A quote or a backslash in the path escapes rather than terminating the quoted value early.
    const nasty = systemdUnits({ ...OPTS, binPath: `/home/a"b\\c/daily-briefing` });
    expect(nasty.service).toContain(`ExecStart="/home/a\\"b\\\\c/daily-briefing" run`);
  });

  test("the timer carries BOTH arms, and Persistent=true is paired with the OnCalendar that gives it effect", () => {
    const { timer } = systemdUnits(OPTS);
    expect(timer).toContain("OnBootSec=2min");
    expect(timer).toContain("OnUnitActiveSec=10min");
    expect(timer).toContain("Persistent=true");
    // ⚠ THE PAIRING IS THE POINT. systemd scopes Persistent= to calendar timers ("only has an effect
    // on timers configured with OnCalendar="), so on a monotonic-only timer the flag is inert and the
    // catch-up behaviour it exists for would not happen. Asserting them together is what stops a
    // future edit from deleting the OnCalendar and leaving a flag that looks like coverage.
    expect(timer).toContain("OnCalendar=*-*-* 07:20:00");
    expect(timer).toContain("Unit=daily-briefing.service");
    expect(timer).toContain("WantedBy=timers.target");
  });

  test("the calendar arm derives from floorMinutes too", () => {
    const { timer } = systemdUnits({ ...OPTS, floorMinutes: parseFloor("06:05").minutes });
    expect(timer).toContain("OnCalendar=*-*-* 06:05:00");
  });

  test("no unit ever references an AppImage mount path", () => {
    const { service, timer } = systemdUnits(OPTS);
    for (const u of [service, timer]) expect(u).not.toContain("/tmp/.mount");
    // …and the assertion helper the installer uses actually fires, so the guard is not vacuous.
    expect(() => assertNoMountPath("ExecStart=/tmp/.mount_dailyXYZ/usr/bin/daily-briefing run", "x")).toThrow(/AppImage mount/);
    expect(() => assertNoMountPath(service, "x")).not.toThrow();
  });

  test.if(Bun.which("systemd-analyze") !== null)("the generated units pass systemd-analyze verify", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-systemd-")));
    const { service, timer } = systemdUnits(OPTS);
    writeFileSync(join(dir, "daily-briefing.service"), service);
    writeFileSync(join(dir, "daily-briefing.timer"), timer);
    const proc = Bun.spawn(["systemd-analyze", "verify", join(dir, "daily-briefing.timer")], { stdout: "pipe", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    expect(`exit=${proc.exitCode} ${err}`).toContain("exit=0");
  });
});

describe("windowsTaskXml", () => {
  test("carries the four behavioural pins plus LeastPrivilege", () => {
    const xml = windowsTaskXml(OPTS);
    expect(xml).toContain("<Interval>PT10M</Interval>");
    expect(xml).toContain("<StateChange>SessionUnlock</StateChange>");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain(`<Command>${OPTS.binPath}</Command>`);
    expect(xml).toContain("<Arguments>run</Arguments>");
  });

  test("the daily schedule anchors at the floor, from floorMinutes", () => {
    const xml = windowsTaskXml({ ...OPTS, floorMinutes: parseFloor("08:30").minutes });
    expect(xml).toContain("<StartBoundary>2026-01-01T08:30:00</StartBoundary>");
    expect(xml).toContain("<DaysInterval>1</DaysInterval>");
    // ⚠ A NAMED DEVIATION from the task text ("a daily TimeTrigger"): Task Scheduler's TimeTrigger is
    // ONE-SHOT — with <Duration>P1D</Duration> it repeats for one day and then never fires again,
    // which is a definitively broken daily schedule. The UI's "daily" trigger is CalendarTrigger +
    // ScheduleByDay, which is what is emitted; the PT10M repetition the task actually pins is inside
    // it, unchanged. There is zero Windows runtime evidence either way, so the schema-correct shape is
    // the only defensible one.
    expect(xml).toContain("<CalendarTrigger>");
    expect(xml).not.toContain("<TimeTrigger>");
  });

  test("⚠ THE CalendarTrigger CHILD ORDER IS THE XSD SEQUENCE — asserted as an ORDER, not as presence", () => {
    // `triggerBaseType` sequences Enabled → StartBoundary → EndBoundary → Repetition →
    // ExecutionTimeLimit, and `calendarTriggerType` extends it with RandomDelay → the ScheduleByX
    // choice. So the schema-valid order for what we emit is Enabled, StartBoundary, Repetition,
    // ScheduleByDay — this generator previously emitted StartBoundary, Enabled, ScheduleByDay,
    // Repetition. Checked against the published schema (learn.microsoft.com …
    // taskschedulerschema-triggerbasetype-complextype and …-calendartriggertype-complextype); there is
    // zero Windows runtime evidence either way and real-world Task Scheduler is lenient, which is
    // exactly why a presence-only assertion would not have caught the original order and does not
    // protect the new one.
    const xml = windowsTaskXml(OPTS);
    const block = xml.slice(xml.indexOf("<CalendarTrigger>"), xml.indexOf("</CalendarTrigger>"));
    const order = [...block.matchAll(/<(Enabled|StartBoundary|Repetition|ScheduleByDay)>/g)].map((m) => m[1]);
    expect(order).toEqual(["Enabled", "StartBoundary", "Repetition", "ScheduleByDay"]);
    // The sibling trigger follows the same base-first rule: Enabled (base) before StateChange (extension).
    const sess = xml.slice(xml.indexOf("<SessionStateChangeTrigger>"), xml.indexOf("</SessionStateChangeTrigger>"));
    expect([...sess.matchAll(/<(Enabled|StateChange)>/g)].map((m) => m[1])).toEqual(["Enabled", "StateChange"]);
  });

  test("xmlEscape covers all five predefined entities, apostrophe included", () => {
    // `'` is inert in element text and in the double-quoted attributes emitted today; it is escaped so
    // that a future single-quoted attribute is not a silent injection point, and because an escaper
    // that covers four of five is a trap for whoever adds the fifth context.
    const xml = windowsTaskXml({ ...OPTS, binPath: `/Users/o'brien/a&b/"c"/<d>/daily-briefing` });
    expect(xml).toContain("<Command>/Users/o&apos;brien/a&amp;b/&quot;c&quot;/&lt;d&gt;/daily-briefing</Command>");
    const plist = launchdPlist({ ...OPTS, binPath: "/Users/o'brien/bin/daily-briefing" });
    expect(plist).toContain("<string>/Users/o&apos;brien/bin/daily-briefing</string>");
  });

  test("every surface is labelled experimental", () => {
    expect(windowsTaskXml(OPTS)).toContain("EXPERIMENTAL");
  });

  test("the XML PARSES — a generator that emits invalid XML is not testable any other way off-Windows", () => {
    // Bun ships no XML parser; DOMParser is unavailable. Structural well-formedness is asserted by
    // tag-balance instead, which catches the realistic regressions (an unclosed element from a bad
    // template edit) without pretending to be a schema validator.
    const xml = windowsTaskXml(OPTS);
    const opens = [...xml.matchAll(/<([A-Za-z][\w.-]*)(\s[^>]*?)?>/g)].filter((m) => !m[0].endsWith("/>") && !m[0].startsWith("<?"));
    const closes = [...xml.matchAll(/<\/([A-Za-z][\w.-]*)>/g)];
    const stack: string[] = [];
    let balanced = true;
    const tokens = [...xml.matchAll(/<\/?([A-Za-z][\w.-]*)(\s[^>]*?)?(\/)?>/g)];
    for (const t of tokens) {
      if (t[0].startsWith("</")) { if (stack.pop() !== t[1]) balanced = false; }
      else if (!t[3]) stack.push(t[1]!);
    }
    expect(`balanced=${balanced} depth=${stack.length}`).toBe("balanced=true depth=0");
    expect(opens.length).toBe(closes.length);
  });

  test("⚠ THE ENCODING TRAP: the WRITER emits UTF-16LE with a BOM — schtasks /XML rejects UTF-8", () => {
    const bytes = windowsTaskXmlBytes(windowsTaskXml(OPTS));
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(WINDOWS_XML_ENCODING).toBe("utf-16le");
    expect([...WINDOWS_XML_BOM]).toEqual([0xff, 0xfe]);
    // Round-trips: the bytes after the BOM decode back to exactly the string we generated.
    const decoded = new TextDecoder("utf-16le").decode(bytes.slice(2));
    expect(decoded).toBe(windowsTaskXml(OPTS));
    // …and the declaration inside says UTF-16 too, so the file does not contradict its own bytes.
    expect(decoded.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
  });
});
