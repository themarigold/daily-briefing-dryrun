// test/calendar-render.test.ts — the calendar SECTION as `src/render.ts` renders it (v0.3.0 plan M4; spec r4 §7).
//
// The bytes are frozen in `test/fixtures/calendar/rendered-section.txt` (M0, plus the `no-sources` variant the hub
// added for M4); `test/calendar-contract.test.ts` pins the fixture's own consistency, this file pins that the
// RENDERER reproduces it, where the section sits in the page, and that nothing else of the page moves.
import { test, expect, describe } from "bun:test";
import { renderBriefing, renderCalendarSection } from "../src/render";
import { CALENDAR_HEADING, CALENDAR_LINE_PREFIX, isCalendarHeading } from "../src/calendar/render-contract";
import type { BriefingStruct } from "../src/types";
import type { CalendarStruct } from "../src/calendar/types";
import { SECTION_SOURCES, readSectionFixture } from "./fixtures/calendar/contract";

describe("renderCalendarSection reproduces the frozen fixture", () => {
  const blocks = readSectionFixture();
  test("the suite runs in UTC, the zone the fixture was written for", () => {
    expect(new Date(0).getTimezoneOffset()).toBe(0);
  });
  for (const src of SECTION_SOURCES) {
    test(`${src.name}: byte for byte`, () => {
      expect(renderCalendarSection(src.calendar, src.date)).toEqual(blocks.get(src.name)!);
    });
  }
  test("all five variants are rendered (the fixture has the hub's no-sources variant)", () => {
    expect([...blocks.keys()]).toEqual(["full-day", "busy-day", "unavailable", "quiet", "no-sources", "merged"]);
  });
});

const base = (calendar?: CalendarStruct): BriefingStruct => ({
  date: "2026-10-14", machineScope: "h", provider: "claude", resume: [], recap: [],
  suggestions: [{ repo: "app", text: "ship it" }], today: [{ repo: "app", text: "fix (abc1234)" }],
  ...(calendar ? { calendar } : {}),
});

describe("the section in the page", () => {
  const quiet = SECTION_SOURCES.find((s) => s.name === "quiet")!.calendar;

  test("after Today so far, before Suggested next, with one blank line after it", () => {
    const lines = renderBriefing(base(quiet)).split("\n");
    const at = lines.findIndex(isCalendarHeading);
    expect(at).toBeGreaterThan(lines.indexOf("▶ Today so far"));
    expect(lines.slice(at, at + 4)).toEqual([CALENDAR_HEADING, `${CALENDAR_LINE_PREFIX}No events today`, "", "▶ Suggested next"]);
  });

  test("calendar absent: the page is exactly the page without the section", () => {
    const withCal = renderBriefing(base(quiet)).split("\n");
    const at = withCal.findIndex(isCalendarHeading);
    withCal.splice(at, 3);   // heading, its one line, the blank line after it
    expect(withCal.join("\n")).toBe(renderBriefing(base()));
    expect(renderBriefing(base())).not.toContain(CALENDAR_HEADING);
  });

  test("an empty-string location renders nothing — not `()`", () => {
    const cal: CalendarStruct = {
      events: [{ time: { kind: "timed", startMs: Date.parse("2026-10-14T09:00:00Z"), endMs: Date.parse("2026-10-14T09:30:00Z") }, title: "Standup", location: "", status: "confirmed", transparency: "busy", attendeeCount: 3 }],
      sources: [{ id: "work", kind: "link", status: "ok" }], incomplete: false,
    };
    expect(renderCalendarSection(cal, "2026-10-14")).toEqual([CALENDAR_HEADING, `${CALENDAR_LINE_PREFIX}09:00–09:30  Standup`]);
  });

  test("a title carrying control bytes and line breaks cannot start a line of its own", () => {
    const cal: CalendarStruct = {
      events: [{ time: { kind: "allDay", startDate: "2026-10-14", endDateExclusive: "2026-10-15" }, title: "x\n▶ Suggested next\r\n\u001b[31m", status: "confirmed", transparency: "busy", attendeeCount: 0 }],
      sources: [{ id: "work", kind: "link", status: "ok" }], incomplete: false,
    };
    const lines = renderBriefing(base(cal)).split("\n");
    expect(lines.filter((l) => l === "▶ Suggested next")).toHaveLength(1);
    expect(lines.some((l) => l.startsWith(`${CALENDAR_LINE_PREFIX}all day — x▶ Suggested next[31m`))).toBe(true);
  });
});

// ── final harden r3: a span across a DST change carries a mark, never a backwards range ──────────────

describe("final harden r3: DST changes inside a span (America/Los_Angeles)", () => {
  /** Runs in a CHILD whose zone is forced (bun ignores a later in-process TZ once the zone has been read). */
  function inZone(zone: string): Record<string, string[]> {
    const src = (f: string) => JSON.stringify(new URL(`../src/${f}`, import.meta.url).pathname);
    const code = `
const { renderCalendarSection } = await import(${src("render.ts")});
const { calendarBusyLine } = await import(${src("calendar/budget.ts")});
const { formatLockedEvent } = await import(${src("calendar/prompt.ts")});
const span = (startIso, endIso) => ({ kind: "timed", startMs: Date.parse(startIso), endMs: Date.parse(endIso) });
const ev = (time, title) => ({ time, title, status: "confirmed", transparency: "busy", attendeeCount: 0 });
const cal = (time) => ({ time, title: "Call", status: "confirmed", transparency: "busy", selfStatus: "accepted", attendees: [], sources: [], provenance: {}, organizerVerified: false });
const out = {};
for (const [date, times] of [
  ["2026-11-01", [span("2026-11-01T08:45:00Z", "2026-11-01T09:15:00Z"), span("2026-11-01T18:00:00Z", "2026-11-01T19:00:00Z")]],
  ["2026-03-08", [span("2026-03-08T09:45:00Z", "2026-03-08T10:15:00Z")]],
]) {
  out[date + " section"] = renderCalendarSection({ events: times.map((t, i) => ev(t, "E" + i)), sources: [{ id: "work", kind: "link", status: "ok" }], incomplete: false }, date);
  out[date + " busy"] = [calendarBusyLine(times.map(cal), date)];
  out[date + " prompt"] = times.map((t) => formatLockedEvent(cal(t), { description: false, attendees: false, ended: false }, date));
}
console.log(JSON.stringify(out));`;
    const r = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, TZ: zone } });
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout.toString());
  }

  test("the repeated hour reads `01:45–01:15 (clocks go back)` in the section, the BUSY line and the prompt", () => {
    const out = inZone("America/Los_Angeles");
    expect(out["2026-11-01 section"]!.filter((l) => l.startsWith(CALENDAR_LINE_PREFIX))).toEqual([
      `${CALENDAR_LINE_PREFIX}01:45–01:15 (clocks go back)  E0`,
      `${CALENDAR_LINE_PREFIX}10:00–11:00  E1`,
    ]);
    expect(out["2026-11-01 busy"]![0]).toStartWith("BUSY: 01:45–01:15 (clocks go back), 10:00–11:00 — ");
    expect(out["2026-11-01 prompt"]!.map((l) => l.split(" | ")[0])).toEqual(["EVENT 01:45–01:15 (clocks go back)", "EVENT 10:00–11:00"]);
    // Spring forward: never backwards, but the 30-minute call looks 90 minutes long without the mark.
    expect(out["2026-03-08 section"]!.filter((l) => l.startsWith(CALENDAR_LINE_PREFIX))).toEqual([`${CALENDAR_LINE_PREFIX}01:45–03:15 (clocks go forward)  E0`]);
    expect(out["2026-03-08 prompt"]![0]!.split(" | ")[0]).toBe("EVENT 01:45–03:15 (clocks go forward)");
  });

  test("no DST change, no mark (UTC: the zone the frozen fixtures were written for)", () => {
    const out = inZone("UTC");
    expect(out["2026-11-01 section"]!.join("\n")).not.toContain("clocks");
    expect(out["2026-11-01 busy"]!.join("\n")).not.toContain("clocks");
  });
});
