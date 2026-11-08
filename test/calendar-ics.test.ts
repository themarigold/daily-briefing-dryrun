// test/calendar-ics.test.ts — the link feed PARSER (calendar v0.3.0 plan M2c; spec r4 §4.2 "Parse", "Time zones",
// "Expansion", "Identity", §5, §3 limits). Untrusted input: every rule here is a rule a hostile or merely odd feed
// will test.
//
// In process, against the vendored ical.js imported directly (the engine itself only ever loads it inside the
// `calendar-parse` child — test/calendar-parse.test.ts and test/calendar-link-parse.test.ts drive that path). The
// parser takes the parent's zone as an INPUT, so DST cases run here in any zone without forcing the process's TZ;
// the one property that needs the process zone — the child's window equals `reconcileWindow` in the parent — runs in
// child processes with TZ forced (bun cannot restore an unset TZ in-process; test/in10-stash-suggestions.test.ts).
import { test, expect, describe } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import ICAL from "../src/calendar/vendor/ical.js";
import {
  CAL_ATTENDEES_MAX, CAL_EVENTS_BUDGET_BYTES, CAL_EXPANSION_STEP_CAP, CAL_INDEX_BUDGET_BYTES, CAL_OCCURRENCES_PER_DAY_CAP, CAL_PARSE_MAX_EVENTS,
  parseIcsDetails, parseIcsFeed, prefilterKeeps, WINDOWS_ZONES, type CalWireEvent, type IcsParseInput, type IcsParseKnobs,
} from "../src/calendar/ics";
import { isCleanCalendarText } from "../src/calendar/clean";
import { REDACTION as REDACTION_FOR_TESTS } from "../src/transcripts/credentials";
import { reconcileCalendar } from "../src/calendar/reconcile";
import type { CalEvent, CalUidIndexEntry } from "../src/calendar/types";
import { USER_FEED_COUNTS, USER_FEED_RUN_DATE, USER_FEED_SELF, userFeedUid, userShapedFeed } from "./fixtures/calendar-user-feed";
import { heavyFeed } from "./fixtures/calendar-heavy-feed";

const RUN = "2026-10-09";   // a Friday
const H = 3600_000;
const utc = (s: string): number => Date.parse(s);
const iso = (ms: number): string => new Date(ms).toISOString();

const NY_VTZ = [
  "BEGIN:VTIMEZONE", "TZID:America/New_York",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
  "END:VTIMEZONE",
];

let uidN = 0;
/** A VEVENT; a UID is added unless the lines carry one. */
const ev = (...lines: string[]): string[] => ["BEGIN:VEVENT", ...(lines.some((l) => l.startsWith("UID")) ? [] : [`UID:e${++uidN}@test`]), ...lines, "END:VEVENT"];
/** A feed: calendar-level lines (X-WR-TIMEZONE, VTIMEZONEs) then the events. */
const feed = (head: string[], ...events: string[][]): string => ["BEGIN:VCALENDAR", "VERSION:2.0", ...head, ...events.flat(), "END:VCALENDAR", ""].join("\r\n");

function parse(ics: string, over: Partial<IcsParseInput> = {}, knobs?: IcsParseKnobs) {
  const r = parseIcsFeed(ICAL, { ics, sourceId: "work", runDate: RUN, zone: "UTC", identity: { self: [] }, maxEvents: 5_000, ...over }, knobs);
  if (!r.ok) throw new Error("parse-error");
  return r;
}
const timedIso = (e: CalWireEvent): string => (e.time.kind === "timed" ? `${iso(e.time.startMs)}/${iso(e.time.endMs)}` : JSON.stringify(e.time));
const byTitle = (es: CalWireEvent[], t: string) => es.filter((e) => e.title === t);
const asCal = (es: CalWireEvent[]): CalEvent[] => es.map((e) => ({ ...e, sources: [{ kind: "link", id: "work", calendarId: "work" }], provenance: {} }));

// ── the pre-filter ───────────────────────────────────────────────────────────────────────────────────

describe("pre-filter (spec §4.2: possible overlap with today ± 2 days, read cheaply)", () => {
  const keeps = (...lines: string[]) => prefilterKeeps(lines, RUN, "UTC");
  test("a one-off that started a week ago and ends tomorrow is KEPT (long overlap) — and emitted", () => {
    expect(keeps("DTSTART;VALUE=DATE:20261002", "DTEND;VALUE=DATE:20261011")).toBe(true);
    expect(keeps("DTSTART:20261001T090000Z", "DTEND:20261010T090000Z")).toBe(true);
    expect(keeps("DTSTART:20261001T090000Z", "DURATION:P9D")).toBe(true);
    const r = parse(feed([], ev("SUMMARY:Trip", "DTSTART;VALUE=DATE:20261002", "DTEND;VALUE=DATE:20261011")));
    expect(r.events.map((e) => e.time)).toEqual([{ kind: "allDay", startDate: "2026-10-02", endDateExclusive: "2026-10-11" }]);
  });
  test("blocks wholly outside the window are DROPPED — and still indexed", () => {
    expect(keeps("DTSTART;VALUE=DATE:20261001", "DTEND;VALUE=DATE:20261002")).toBe(false);
    expect(keeps("DTSTART:20261006T100000Z", "DTEND:20261006T110000Z")).toBe(false);   // both UTC: read exactly
    expect(keeps("DTSTART:20261013T000000Z")).toBe(false);                             // the window's end is exclusive
    expect(keeps("DTSTART:20200101T100000Z")).toBe(false);
    const r = parse(feed([], ev("UID:old@x", "SUMMARY:Old", "DTSTART:20200101T100000Z", "SEQUENCE:4")));
    expect(r.events).toEqual([]);
    expect(r.index).toEqual([{ uid: "old@x", startMs: utc("2020-01-01T10:00:00Z"), sequence: 4 }]);
  });
  test("a wall time with a zone is widened so no offset can drop an overlapping block", () => {
    // 22:00 on Oct 6 in Los Angeles is 05:00Z on Oct 7 — inside the window, though its wall date is not.
    expect(keeps("DTSTART;TZID=America/Los_Angeles:20261006T220000", "DTEND;TZID=America/Los_Angeles:20261006T230000")).toBe(true);
    expect(keeps("DTSTART:20261006T220000", "DTEND:20261006T230000")).toBe(true);   // floating
    const r = parse(feed([], ev("SUMMARY:Late", "DTSTART;TZID=America/Los_Angeles:20261006T220000", "DTEND;TZID=America/Los_Angeles:20261006T230000")));
    expect(r.events.map(timedIso)).toEqual(["2026-10-07T05:00:00.000Z/2026-10-07T06:00:00.000Z"]);
  });
  test("any block whose dates cannot be read cheaply is KEPT; a series or an override always is", () => {
    expect(keeps("DTSTART:garbage")).toBe(true);
    expect(keeps("SUMMARY:no start at all")).toBe(true);
    expect(keeps("DTSTART:20200101T100000Z", "DTEND:not-a-date")).toBe(true);
    expect(keeps("DTSTART:20200101T100000Z", "DURATION:PXYZ")).toBe(true);
    expect(keeps("DTSTART:20200101T100000Z", "RRULE:FREQ=YEARLY")).toBe(true);
    expect(keeps("DTSTART:20200101T100000Z", "RDATE:20200102T100000Z")).toBe(true);
    expect(keeps("DTSTART:20270101T100000Z", "RECURRENCE-ID:20261009T100000Z")).toBe(true);
    // Kept, then refused by the full read: flagged, never thrown.
    const r = parse(feed([], ev("SUMMARY:Broken", "DTSTART:garbage")));
    expect(r.events).toEqual([]);
    expect(r.incomplete).toEqual(["malformed-event"]);
  });
});

// ── time zones ───────────────────────────────────────────────────────────────────────────────────────

describe("time zones (spec §4.2): VTIMEZONE, then IANA via Intl, then the Windows table, else unclear", () => {
  const at = (head: string[], dtstart: string, over: Partial<IcsParseInput> = {}) => parse(feed(head, ev("SUMMARY:x", dtstart)), over).events;
  test("a VTIMEZONE in the feed is registered and WINS, even over an IANA name Intl knows", () => {
    const custom = ["BEGIN:VTIMEZONE", "TZID:Custom/Plus0530", "BEGIN:STANDARD", "TZOFFSETFROM:+0530", "TZOFFSETTO:+0530", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE"];
    expect(at(custom, "DTSTART;TZID=Custom/Plus0530:20261009T100000").map(timedIso)).toEqual(["2026-10-09T04:30:00.000Z/2026-10-09T04:30:00.000Z"]);
    // A feed whose own America/New_York says -03:00 is believed (Intl would say -04:00, 14:00Z).
    const odd = ["BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:STANDARD", "TZOFFSETFROM:-0300", "TZOFFSETTO:-0300", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE"];
    expect(at(odd, "DTSTART;TZID=America/New_York:20261009T100000").map(timedIso)).toEqual(["2026-10-09T13:00:00.000Z/2026-10-09T13:00:00.000Z"]);
    // The VTIMEZONE may come after the events that use it: zones are registered before anything is resolved.
    const late = parse(["BEGIN:VCALENDAR", ...ev("SUMMARY:x", "DTSTART;TZID=Custom/Plus0530:20261009T100000"), ...custom, "END:VCALENDAR"].join("\r\n")).events;
    expect(late.map(timedIso)).toEqual(["2026-10-09T04:30:00.000Z/2026-10-09T04:30:00.000Z"]);
  });
  test("a TZID with no VTIMEZONE that is an IANA name resolves through Intl", () => {
    expect(at([], "DTSTART;TZID=Europe/Berlin:20261009T100000").map(timedIso)).toEqual(["2026-10-09T08:00:00.000Z/2026-10-09T08:00:00.000Z"]);
    expect(at([], "DTSTART;TZID=Asia/Kolkata:20261009T100000").map(timedIso)).toEqual(["2026-10-09T04:30:00.000Z/2026-10-09T04:30:00.000Z"]);
  });
  test("a common Windows zone name maps to IANA through the fixed table", () => {
    expect(at([], "DTSTART;TZID=W. Europe Standard Time:20261009T100000").map(timedIso)).toEqual(["2026-10-09T08:00:00.000Z/2026-10-09T08:00:00.000Z"]);
    expect(at([], "DTSTART;TZID=\"Pacific Standard Time\":20261009T100000").map(timedIso)).toEqual(["2026-10-09T17:00:00.000Z/2026-10-09T17:00:00.000Z"]);
    // Every table entry names a zone this runtime's Intl knows (an entry Intl lacked would silently mean unclear).
    for (const [win, iana] of Object.entries(WINDOWS_ZONES)) {
      expect(`${win}: ${(() => { try { new Intl.DateTimeFormat("en-US", { timeZone: iana }); return "ok"; } catch { return "unknown"; } })()}`).toBe(`${win}: ok`);
    }
  });
  test("anything else is an UNCLEAR-time event, and the source is flagged incomplete", () => {
    const r = parse(feed([], ev("SUMMARY:x", "DTSTART;TZID=Mars/Olympus:20261009T100000", "DTEND;TZID=Mars/Olympus:20261009T113000")));
    expect(r.events.map((e) => e.time)).toEqual([{ kind: "unclear", startDate: "2026-10-09", endDate: "2026-10-09", wallStart: "10:00", wallEnd: "11:30", tzid: "Mars/Olympus" }]);
    expect(r.incomplete).toEqual(["unclear-time"]);
    // …its tzid is feed text, so it is cleaned like any other field.
    const hostile = parse(feed([], ev("SUMMARY:x", "DTSTART;TZID=\"Evil‮Zone\":20261009T100000"))).events[0]!;
    expect(hostile.time.kind === "unclear" && hostile.time.tzid).toBe("EvilZone");
  });
  test("floating times use X-WR-TIMEZONE; without it, the parent's zone", () => {
    expect(at(["X-WR-TIMEZONE:Asia/Tokyo"], "DTSTART:20261009T100000").map(timedIso)).toEqual(["2026-10-09T01:00:00.000Z/2026-10-09T01:00:00.000Z"]);
    expect(at([], "DTSTART:20261009T100000", { zone: "America/Chicago" }).map(timedIso)).toEqual(["2026-10-09T15:00:00.000Z/2026-10-09T15:00:00.000Z"]);
    expect(at(["X-WR-TIMEZONE:Not/AZone"], "DTSTART:20261009T100000", { zone: "America/Chicago" }).map(timedIso)).toEqual(["2026-10-09T15:00:00.000Z/2026-10-09T15:00:00.000Z"]);
    // A `Z` time is UTC whatever else the feed says.
    expect(at(["X-WR-TIMEZONE:Asia/Tokyo"], "DTSTART;TZID=Asia/Tokyo:20261009T100000Z").map(timedIso)).toEqual(["2026-10-09T10:00:00.000Z/2026-10-09T10:00:00.000Z"]);
  });
  test("an unusable VTIMEZONE (a SECONDLY rule that would spin) falls back to Intl for an IANA name, else unclear — and ends fast", () => {
    const spin = (tzid: string) => ["BEGIN:VTIMEZONE", `TZID:${tzid}`, "BEGIN:STANDARD", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0100", "DTSTART:19700101T000000", "RRULE:FREQ=SECONDLY", "END:STANDARD", "END:VTIMEZONE"];
    const t0 = performance.now();
    expect(at(spin("Europe/Berlin"), "DTSTART;TZID=Europe/Berlin:20261009T100000").map(timedIso)).toEqual(["2026-10-09T08:00:00.000Z/2026-10-09T08:00:00.000Z"]);
    expect(at(spin("Custom/Spin"), "DTSTART;TZID=Custom/Spin:20261009T100000")[0]!.time.kind).toBe("unclear");
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
  test("a wall time in a DST gap reads with the offset before it; an ambiguous one is its FIRST instant (RFC 5545 §3.3.5)", () => {
    for (const head of [[], NY_VTZ]) {
      const gap = parse(feed(head, ev("SUMMARY:gap", "DTSTART;TZID=America/New_York:20260308T023000")), { runDate: "2026-03-08", zone: "America/New_York" }).events;
      expect(gap.map(timedIso)).toEqual(["2026-03-08T07:30:00.000Z/2026-03-08T07:30:00.000Z"]);   // 03:30 EDT
      const amb = parse(feed(head, ev("SUMMARY:amb", "DTSTART;TZID=America/New_York:20261101T013000")), { runDate: "2026-11-01", zone: "America/New_York" }).events;
      expect(amb.map(timedIso)).toEqual(["2026-11-01T05:30:00.000Z/2026-11-01T05:30:00.000Z"]);    // 01:30 EDT, not EST
    }
  });
});

// ── expansion ────────────────────────────────────────────────────────────────────────────────────────

describe("expansion (spec §4.2) — RRULE in wall time, across DST", () => {
  test("a daily 09:00 New York meeting stays 09:00 local across the DST change (VTIMEZONE and Intl alike)", () => {
    for (const head of [NY_VTZ, []]) {
      const r = parse(feed(head, ev("UID:d@x", "SUMMARY:Standup", "DTSTART;TZID=America/New_York:20261001T090000", "DTEND;TZID=America/New_York:20261001T091500", "RRULE:FREQ=DAILY")),
        { runDate: "2026-11-01", zone: "America/New_York" });
      expect(r.events.map(timedIso)).toEqual([
        "2026-10-30T13:00:00.000Z/2026-10-30T13:15:00.000Z", "2026-10-31T13:00:00.000Z/2026-10-31T13:15:00.000Z",
        "2026-11-01T14:00:00.000Z/2026-11-01T14:15:00.000Z", "2026-11-02T14:00:00.000Z/2026-11-02T14:15:00.000Z",
        "2026-11-03T14:00:00.000Z/2026-11-03T14:15:00.000Z",
      ]);
      // recurrenceKey: the ORIGINAL start, epoch-ms decimal (types.ts) — load-bearing for key a and the index.
      expect(r.events.map((e) => e.recurrenceKey)).toEqual(r.events.map((e) => String(e.time.kind === "timed" ? e.time.startMs : -1)));
      expect(r.incomplete).toEqual([]);
    }
  });
  test("DTSTART is always the first instance — an RDATE-only series, and a DTSTART the RRULE itself would not produce", () => {
    const r = parse(feed([], ev("SUMMARY:rd", "DTSTART:20261009T100000Z", "RDATE:20261010T100000Z"),
      ev("SUMMARY:mon", "DTSTART:20261009T120000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3")));
    expect(r.events.map((e) => `${e.title} ${timedIso(e).slice(0, 16)}`)).toEqual(["rd 2026-10-09T10:00", "rd 2026-10-10T10:00", "mon 2026-10-09T12:00"]);
  });
  test("recurrenceKey spelling: epoch-ms decimal for date-time, YYYY-MM-DD for a date, ABSENT for a one-off", () => {
    const r = parse(feed([],
      ev("SUMMARY:dt", "DTSTART:20261008T100000Z", "RRULE:FREQ=DAILY;COUNT=2"),
      ev("SUMMARY:d", "DTSTART;VALUE=DATE:20261008", "RRULE:FREQ=DAILY;COUNT=2"),
      ev("SUMMARY:one", "DTSTART:20261009T100000Z")));
    expect(r.events.map((e) => [e.title, e.recurrenceKey ?? "absent"])).toEqual([
      ["dt", String(utc("2026-10-08T10:00:00Z"))], ["dt", String(utc("2026-10-09T10:00:00Z"))],
      ["d", "2026-10-08"], ["d", "2026-10-09"], ["one", "absent"]]);
    expect("recurrenceKey" in r.events[4]!).toBe(false);
  });
  test("RDATE adds occurrences (DATE-TIME and PERIOD); EXDATE removes them (UTC, TZID, and a DATE on a timed series)", () => {
    const r = parse(feed([],
      ev("SUMMARY:s", "DTSTART:20261001T100000Z", "DURATION:PT45M", "RRULE:FREQ=DAILY", "EXDATE:20261009T100000Z", "RDATE:20261009T150000Z",
        "RDATE;VALUE=PERIOD:20261010T120000Z/20261010T123000Z,20261011T060000Z/PT2H", "EXDATE;VALUE=DATE:20261008")));
    expect(r.events.map(timedIso).sort()).toEqual([
      "2026-10-07T10:00:00.000Z/2026-10-07T10:45:00.000Z",
      "2026-10-09T15:00:00.000Z/2026-10-09T15:45:00.000Z",
      "2026-10-10T10:00:00.000Z/2026-10-10T10:45:00.000Z", "2026-10-10T12:00:00.000Z/2026-10-10T12:30:00.000Z",
      "2026-10-11T06:00:00.000Z/2026-10-11T08:00:00.000Z", "2026-10-11T10:00:00.000Z/2026-10-11T10:45:00.000Z",
    ]);
    const tz = parse(feed([], ev("SUMMARY:b", "DTSTART;TZID=Europe/Berlin:20261007T100000", "RRULE:FREQ=DAILY;COUNT=5", "EXDATE;TZID=Europe/Berlin:20261009T100000")));
    expect(tz.events.map((e) => iso((e.time as { startMs: number }).startMs).slice(0, 10))).toEqual(["2026-10-07", "2026-10-08", "2026-10-10", "2026-10-11"]);
  });
  test("DURATION, a missing DTEND (date: one day; date-time: zero length), a DTEND before DTSTART", () => {
    const r = parse(feed([],
      ev("SUMMARY:dur", "DTSTART:20261009T100000Z", "DURATION:PT1H30M"),
      ev("SUMMARY:nodate", "DTSTART;VALUE=DATE:20261009"),
      ev("SUMMARY:notime", "DTSTART:20261009T100000Z"),
      ev("SUMMARY:back", "DTSTART:20261009T100000Z", "DTEND:20261009T090000Z"),
      ev("SUMMARY:days", "DTSTART;VALUE=DATE:20261009", "DURATION:P3D")));
    expect(Object.fromEntries(r.events.map((e) => [e.title, e.time.kind === "timed" ? (e.time.endMs - e.time.startMs) / 60_000 : e.time]))).toEqual({
      dur: 90, nodate: { kind: "allDay", startDate: "2026-10-09", endDateExclusive: "2026-10-10" }, notime: 0, back: 0,
      days: { kind: "allDay", startDate: "2026-10-09", endDateExclusive: "2026-10-12" },
    });
    // A nominal day (P1D) across DST is a calendar day, 25 hours here; PT24H is exact.
    const dst = parse(feed([], ev("SUMMARY:p1d", "DTSTART;TZID=America/New_York:20261031T120000", "DURATION:P1D"),
      ev("SUMMARY:pt24", "DTSTART;TZID=America/New_York:20261031T120000", "DURATION:PT24H")), { runDate: "2026-11-01", zone: "America/New_York" });
    expect(dst.events.map(timedIso)).toEqual(["2026-10-31T16:00:00.000Z/2026-11-01T17:00:00.000Z", "2026-10-31T16:00:00.000Z/2026-11-01T16:00:00.000Z"]);
  });
});

describe("RECURRENCE-ID overrides: moved into, out of, and far from today; CANCELLED tombstones", () => {
  const master = ev("UID:w@x", "SUMMARY:Weekly", "DTSTART:20260904T100000Z", "DTEND:20260904T110000Z", "RRULE:FREQ=WEEKLY;BYDAY=FR", "SEQUENCE:0");
  const key = (s: string) => String(utc(s));
  test("moved INTO today: the override is an event of its own, keyed by its ORIGINAL start", () => {
    const r = parse(feed([], master, ev("UID:w@x", "RECURRENCE-ID:20261002T100000Z", "SUMMARY:Moved in", "DTSTART:20261009T140000Z", "DTEND:20261009T150000Z", "SEQUENCE:1")));
    expect(r.events.map((e) => [e.title, e.recurrenceKey, timedIso(e)])).toEqual([
      ["Weekly", key("2026-10-09T10:00:00Z"), "2026-10-09T10:00:00.000Z/2026-10-09T11:00:00.000Z"],
      ["Moved in", key("2026-10-02T10:00:00Z"), "2026-10-09T14:00:00.000Z/2026-10-09T15:00:00.000Z"],
    ]);
    expect(r.events[1]!.sequence).toBe(1);
  });
  test("moved OUT of today — near or FAR: today's occurrence is gone, and the index carries where it went", () => {
    for (const [to, label] of [["20261020T100000Z", "near"], ["20270115T100000Z", "far"]] as const) {
      const r = parse(feed([], master, ev("UID:w@x", "RECURRENCE-ID:20261009T100000Z", `SUMMARY:Moved ${label}`, `DTSTART:${to}`, "SEQUENCE:1")));
      expect(r.events, label).toEqual([]);
      const entry = r.index.find((e) => e.recurrenceId !== undefined)!;
      expect(entry).toEqual({ uid: "w@x", recurrenceId: key("2026-10-09T10:00:00Z"), startMs: utc(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}T10:00:00Z`), sequence: 1 });
      expect(r.index.find((e) => e.recurrenceId === undefined)).toEqual({ uid: "w@x", startMs: utc("2026-09-04T10:00:00Z"), sequence: 0, recurs: true });
    }
  });
  test("the override suppresses its occurrence whatever the order of the blocks", () => {
    const over = ev("UID:w@x", "RECURRENCE-ID:20261009T100000Z", "SUMMARY:Later", "DTSTART:20261009T160000Z", "SEQUENCE:1");
    for (const ics of [feed([], master, over), feed([], over, master)]) {
      expect(parse(ics).events.map((e) => e.title)).toEqual(expect.arrayContaining(["Later"]));
      expect(parse(ics).events.filter((e) => e.title === "Weekly")).toEqual([]);
    }
  });
  test("an override in a zone matches the master's occurrence in the same zone", () => {
    const r = parse(feed([], ev("UID:z@x", "SUMMARY:Z", "DTSTART;TZID=Europe/Berlin:20261005T100000", "RRULE:FREQ=DAILY"),
      ev("UID:z@x", "RECURRENCE-ID;TZID=Europe/Berlin:20261009T100000", "SUMMARY:Z moved", "DTSTART;TZID=Europe/Berlin:20261009T120000")));
    expect(byTitle(r.events, "Z").map((e) => e.recurrenceKey)).not.toContain(key("2026-10-09T08:00:00Z"));
    expect(byTitle(r.events, "Z moved").map((e) => [e.recurrenceKey, timedIso(e)])).toEqual([[key("2026-10-09T08:00:00Z"), "2026-10-09T10:00:00.000Z/2026-10-09T10:00:00.000Z"]]);
  });
  test("RANGE=THISANDFUTURE is unsupported: flagged, the override still read as one occurrence", () => {
    const r = parse(feed([], master, ev("UID:w@x", "RECURRENCE-ID;RANGE=THISANDFUTURE:20261009T100000Z", "SUMMARY:Range", "DTSTART:20261009T120000Z")));
    expect(r.incomplete).toEqual(["unsupported"]);
    expect(r.events.map((e) => e.title)).toEqual(["Range"]);
  });
  test("final harden r2: an override whose own DTSTART is unreadable does NOT hide the master's occurrence", () => {
    for (const bad of ["DTSTART:not-a-date", "DTSTART;TZID=Europe/Berlin:20261309T990000", null] as const) {
      const lines = ["UID:w@x", "RECURRENCE-ID:20261009T100000Z", "SUMMARY:Broken", ...(bad ? [bad] : []), "SEQUENCE:1"];
      for (const extra of [[], ["STATUS:CANCELLED"]]) {
        const r = parse(feed([], master, ev(...lines, ...extra)));
        // Today's meeting is still there, keyed by its original start, and the read says something was dropped.
        expect(r.events.map((e) => [e.title, e.recurrenceKey]), String(bad)).toEqual([["Weekly", key("2026-10-09T10:00:00Z")]]);
        expect(r.incomplete).toContain("malformed-event");
      }
    }
    // A VALID replacement still overrides (moved out of the window: today's occurrence is gone, nothing flagged).
    const moved = parse(feed([], master, ev("UID:w@x", "RECURRENCE-ID:20261009T100000Z", "SUMMARY:Moved", "DTSTART:20261020T100000Z", "SEQUENCE:1")));
    expect(moved.events).toEqual([]);
    expect(moved.incomplete).toEqual([]);
  });
  test("STATUS:CANCELLED is kept as a tombstone — a one-off, an override, a whole series — and reconcile drops it", () => {
    const r = parse(feed([],
      ev("SUMMARY:Off", "DTSTART:20261009T080000Z", "STATUS:CANCELLED"),
      master, ev("UID:w@x", "RECURRENCE-ID:20261009T100000Z", "SUMMARY:Weekly", "DTSTART:20261009T100000Z", "STATUS:CANCELLED", "SEQUENCE:2"),
      ev("UID:gone@x", "SUMMARY:Gone", "DTSTART:20261007T090000Z", "RRULE:FREQ=DAILY", "STATUS:CANCELLED")));
    expect(r.events.map((e) => [e.title, e.status])).toEqual([
      ["Off", "cancelled"], ["Weekly", "cancelled"],
      ["Gone", "cancelled"], ["Gone", "cancelled"], ["Gone", "cancelled"], ["Gone", "cancelled"], ["Gone", "cancelled"]]);
    expect(reconcileCalendar({ runDate: RUN, copies: asCal(r.events), indexes: [{ sourceId: "work", entries: r.index }] })).toEqual([]);
  });
});

describe("limits: 1,000 expansion steps per event, 5,000 events, the answer's byte budgets", () => {
  test("a COUNT series whose window lies past 1,000 steps is capped and flagged (COUNT is never re-anchored)", () => {
    const r = parse(feed([], ev("SUMMARY:Counted", "DTSTART:20200101T100000Z", "RRULE:FREQ=DAILY;COUNT=5000")));
    expect(r.incomplete).toEqual(["expansion-capped"]);
    expect(r.events).toEqual([]);
    // ~1,530 steps from its start to the window: past the cap (and inside the iterator loop's 2× safety net, so it is
    // the step count that stops it) …
    expect(parse(feed([], ev("SUMMARY:C2", "DTSTART:20220801T100000Z", "RRULE:FREQ=DAILY;COUNT=5000")))).toMatchObject({ events: [], incomplete: ["expansion-capped"] });
    // … while ~900 steps fits.
    expect(parse(feed([], ev("SUMMARY:C3", "DTSTART:20240424T100000Z", "RRULE:FREQ=DAILY;COUNT=5000"))).events.map((e) => e.title)).toEqual(["C3", "C3", "C3", "C3", "C3"]);
  });
  test("a rule whose candidates never match (ical.js would loop inside one next()) stops at the cap — fast", () => {
    for (const rule of ["FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30", "FREQ=SECONDLY", "FREQ=MINUTELY;BYHOUR=25", "FREQ=HOURLY;INTERVAL=1;BYMONTH=2;BYMONTHDAY=31"]) {
      const t0 = performance.now();
      const r = parse(feed([], ev("SUMMARY:Spin", "DTSTART:20261001T100000Z", `RRULE:${rule}`)));
      expect(`${rule}: ${r.incomplete.join(",")}`).toMatch(/: (expansion-capped|unsupported)$/);
      expect(performance.now() - t0).toBeLessThan(2_000);
    }
  });
  test("the cap counts each candidate and each RDATE value (CAL_EXPANSION_STEP_CAP = 1,000)", () => {
    expect(CAL_EXPANSION_STEP_CAP).toBe(1_000);
    const daily = feed([], ev("SUMMARY:D", "DTSTART:20261001T100000Z", "RRULE:FREQ=DAILY"));
    expect(parse(daily, {}, { stepCap: 3, reanchor: false }).incomplete).toEqual(["expansion-capped"]);
    expect(parse(daily, {}, { stepCap: 30, reanchor: false }).incomplete).toEqual([]);
    const rdates = Array.from({ length: 1_001 }, (_, i) => `RDATE:${new Date(utc("2026-01-01T10:00:00Z") + i * H).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`);
    expect(parse(feed([], ev("SUMMARY:R", "DTSTART:20250101T100000Z", ...rdates))).incomplete).toEqual(["expansion-capped"]);
  });
  test("fix-round 1: one series puts at most CAL_OCCURRENCES_PER_DAY_CAP (48) occurrences on any day, flagged when capped", () => {
    expect(CAL_OCCURRENCES_PER_DAY_CAP).toBe(48);
    // Every 15 minutes from today 00:00: 96 a day, ~290 steps (inside the 1,000-step cap — only the day cap acts).
    const r = parse(feed([], ev("UID:flood@x", "SUMMARY:Flood", "DTSTART:20261009T000000Z", "DTEND:20261009T001000Z", "RRULE:FREQ=MINUTELY;INTERVAL=15")));
    const perDay = new Map<string, number>();
    for (const e of r.events) if (e.time.kind === "timed") { const d = iso(e.time.startMs).slice(0, 10); perDay.set(d, (perDay.get(d) ?? 0) + 1); }
    expect([...perDay.values()].every((n) => n === 48)).toBe(true);
    expect(perDay.get(RUN)).toBe(48);
    expect(r.incomplete).toEqual(["expansion-capped"]);
    // Hourly is 24 a day: under the cap, unflagged; a single event is never counted against it.
    const hourly = parse(feed([], ev("SUMMARY:Hourly", "DTSTART:20261009T000000Z", "RRULE:FREQ=HOURLY;COUNT=30"), ev("SUMMARY:One", "DTSTART:20261009T100000Z")));
    expect(byTitle(hourly.events, "Hourly").length).toBe(30);
    expect(hourly.incomplete).toEqual([]);
  });
  test("an open-ended daily series since 2018 is RE-ANCHORED: within the cap, unflagged, every occurrence right", () => {
    const r = parse(feed([], ev("SUMMARY:Since 2018", "DTSTART:20180102T090000Z", "DTEND:20180102T091500Z", "RRULE:FREQ=DAILY")));
    expect(r.incomplete).toEqual([]);
    expect(r.events.map((e) => iso((e.time as { startMs: number }).startMs))).toEqual(
      ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"].map((d) => `${d}T09:00:00.000Z`));
  });
  test("re-anchoring never changes an occurrence: anchored and un-anchored expansions agree, rule by rule", () => {
    const rules: [string, string][] = [
      ["DTSTART:20190131T090000Z", "FREQ=DAILY"], ["DTSTART:20190131T090000Z", "FREQ=DAILY;INTERVAL=3"],
      ["DTSTART:20190131T090000Z", "FREQ=WEEKLY;BYDAY=MO,WE,FR"], ["DTSTART:20190129T090000Z", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU"],
      ["DTSTART:20190131T090000Z", "FREQ=MONTHLY"], ["DTSTART:20190131T090000Z", "FREQ=MONTHLY;BYDAY=-1FR"],
      ["DTSTART:20190115T090000Z", "FREQ=MONTHLY;BYMONTHDAY=8,9,10,30"], ["DTSTART:20190105T090000Z", "FREQ=MONTHLY;INTERVAL=5"],
      ["DTSTART;VALUE=DATE:20160229", "FREQ=YEARLY"], ["DTSTART:20191010T090000Z", "FREQ=YEARLY;BYMONTH=10;BYDAY=2FR"],
      ["DTSTART:20191009T090000Z", "FREQ=YEARLY;INTERVAL=7"], ["DTSTART;VALUE=DATE:20191009", "FREQ=YEARLY;BYMONTH=10"],
      ["DTSTART:20190101T090000Z", "FREQ=DAILY;UNTIL=20261010T090000Z"], ["DTSTART;TZID=America/New_York:20190101T233000", "FREQ=DAILY;BYDAY=FR,SA"],
      ["DTSTART:20190101T090000Z", "FREQ=WEEKLY;BYDAY=FR;BYSETPOS=1"],
      // M2c review MEDIUM: a clamped anchor day (29 Feb → 28 Feb) made the anchored run emit a phantom 1 March.
      ["DTSTART;VALUE=DATE:20240229", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29"], ["DTSTART:20240229T090000Z", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29"],
      ["DTSTART:20190131T090000Z", "FREQ=MONTHLY;BYMONTHDAY=31"],
    ];
    const runs = ["2026-10-09", "2026-10-31", "2027-02-28", "2028-02-29", "2026-03-31"];
    for (const [dtstart, rule] of rules) {
      for (const runDate of runs) {
        const ics = feed([], ev("UID:r@x", "SUMMARY:R", dtstart, `RRULE:${rule}`));
        const a = parse(ics, { runDate }, { reanchor: true });
        const b = parse(ics, { runDate }, { reanchor: false, stepCap: 1_000_000 });
        expect(`${rule} @ ${runDate}: ${a.events.map(timedIso).join(" ")}`).toBe(`${rule} @ ${runDate}: ${b.events.map(timedIso).join(" ")}`);
        expect(`${rule} @ ${runDate}: ${a.incomplete}`).toBe(`${rule} @ ${runDate}: `);
      }
    }
  }, 30_000);
  test("at most maxEvents events (≤ 5,000): the rest are cut and the source flagged", () => {
    expect(CAL_PARSE_MAX_EVENTS).toBe(5_000);
    const many = feed([], ...Array.from({ length: 5_001 }, (_, i) => ev(`SUMMARY:E${i}`, "DTSTART:20261009T100000Z")));
    const r = parse(many);
    expect(r.events).toHaveLength(5_000);
    expect(r.incomplete).toEqual(["event-cap"]);
    expect(r.index).toHaveLength(5_001);   // the index is every block's, not capped by the event count
    const few = parse(many, { maxEvents: 3 });
    expect(few.events.map((e) => e.title)).toEqual(["E0", "E1", "E2"]);
  }, 30_000);
  test("the events' byte budget and the index's byte budget are kept, each flagged when hit", () => {
    const att = Array.from({ length: 300 }, (_, i) => `ATTENDEE;CN=${"Long Name ".repeat(11)}${i}:mailto:person${i}@example.org`);
    const heavy = parse(feed([], ...Array.from({ length: 300 }, (_, i) => ev(`SUMMARY:H${i}`, "DTSTART:20261009T100000Z", ...att))));
    expect(heavy.incomplete).toEqual(["output-cap"]);
    expect(heavy.events.every((e) => e.attendees.length === CAL_ATTENDEES_MAX)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(heavy.events))).toBeLessThanOrEqual(CAL_EVENTS_BUDGET_BYTES);
    const longUid = (i: number) => `UID:${String(i).padStart(6, "0")}${"u".repeat(500)}`;
    const idx = parse(feed([], ...Array.from({ length: 9_000 }, (_, i) => ev(longUid(i), "DTSTART:20200101T100000Z"))));
    expect(idx.incomplete).toEqual(["index-capped"]);
    expect(Buffer.byteLength(JSON.stringify(idx.index))).toBeLessThanOrEqual(CAL_INDEX_BUDGET_BYTES);
  }, 30_000);
  test("a UID past 512 characters becomes `sha256:<hex>` — the same in the index and the events", () => {
    const long = `UID:${"x".repeat(600)}`;
    const r = parse(feed([], ev(long, "SUMMARY:L", "DTSTART:20261009T100000Z")));
    expect(r.events[0]!.uid).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.index[0]!.uid).toBe(r.events[0]!.uid!);
  });
});

// ── identity ─────────────────────────────────────────────────────────────────────────────────────────

describe("producer keys in baseEvent (near-duplicates T1.2: P07, P09, P11)", () => {
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  const one = (...lines: string[]): CalWireEvent => {
    const r = parse(feed([], ev("SUMMARY:X", "DTSTART:20261009T100000Z", "DTEND:20261009T110000Z", ...lines)));
    expect(r.events).toHaveLength(1);
    return r.events[0]!;
  };
  const keys = (e: CalWireEvent) => ({ meetingKey: e.meetingKey, placeKey: e.placeKey, linkKeys: e.linkKeys });

  test("P07 the meeting key reads the raw LOCATION, then the raw DESCRIPTION; placeKey and linkKeys read only the LOCATION", () => {
    const a = one("LOCATION:Clinic North\\, https://zoom.us/j/111", "DESCRIPTION:Join https://zoom.us/j/222");
    expect(keys(a)).toEqual({ meetingKey: sha("zoom\u0000111"), placeKey: sha("clinic north"), linkKeys: [sha("zoom.us/j/111")] });
    expect(a.location).not.toContain("https://");
    const b = one("LOCATION:Room 4", "DESCRIPTION:Line one\\nhttps://us02web.zoom.us/j/222?pwd=x");
    expect(keys(b)).toEqual({ meetingKey: sha("zoom\u0000222"), placeKey: sha("room 4"), linkKeys: undefined });
    expect("linkKeys" in b).toBe(false);
    expect(Object.keys(one("DESCRIPTION:Clinic North")).filter((k) => ["meetingKey", "placeKey", "linkKeys"].includes(k))).toEqual([]);
  });
  test("P07 a meeting only in the URL (or conference) property gives no key", () => {
    const e = one("URL:https://zoom.us/j/333", "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij", "LOCATION:Room 4");
    expect(e.meetingKey).toBeUndefined();
    expect(e.placeKey).toBe(sha("room 4"));
  });
  test("P09 link half: a URL-only location with a long host gives no placeKey; a place after a long URL is hashed whole, past 1,000 scalars", () => {
    const longHost = `https://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.example.com/room`;
    const urlOnly = one(`LOCATION:${longHost}`);
    expect(urlOnly.placeKey).toBeUndefined();
    expect(urlOnly.linkKeys).toHaveLength(1);
    const far = one(`LOCATION:https://maps.example.com/${"x".repeat(1_100)} Clinic North`);
    expect(far.placeKey).toBe(sha("clinic north"));
    expect(far.placeKey).toBe(one("LOCATION:Clinic North").placeKey!);
    // The details path hashes the same full raw LOCATION, although its own raw location is capped at 1,000 scalars.
    const d = parseIcsDetails(ICAL, { ics: feed([], ev("SUMMARY:X", "DTSTART:20261009T100000Z", `LOCATION:https://maps.example.com/${"x".repeat(1_100)} Clinic North`)),
      sourceId: "work", runDate: RUN, zone: "UTC", identity: { self: [] }, maxEvents: 5_000 });
    if (!d.ok) throw new Error("parse-error");
    expect(d.events[0]!.placeKey).toBe(sha("clinic north"));
    expect([...(d.events[0]!.details?.location ?? "")].length).toBe(1_000);
  });
  test("P11 the three fields, the full linkKeys array included, count against CAL_EVENTS_BUDGET_BYTES", () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://h${i}.example/p`).join(" ");
    const att = Array.from({ length: 40 }, (_, i) => `ATTENDEE;CN=${"Name ".repeat(4)}${i}:mailto:person${i}@example.org`);
    const n = 2_000;
    const r = parse(feed([], ...Array.from({ length: n }, (_, i) =>
      ev(`SUMMARY:P${String(i).padStart(5, "0")}`, "DTSTART:20261009T100000Z", `LOCATION:Room ${i % 10} ${urls}`, "DESCRIPTION:https://zoom.us/j/9", ...att))));
    expect(r.incomplete).toEqual(["output-cap"]);
    expect(r.events.length).toBeLessThan(n);
    expect(r.events.every((e) => e.linkKeys?.length === 8 && e.meetingKey !== undefined && e.placeKey !== undefined)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(r.events))).toBeLessThanOrEqual(CAL_EVENTS_BUDGET_BYTES);
    // Without the three fields every one of the n events would have fitted, so it is their bytes that hit the cap.
    const stripped = (e: CalWireEvent) => { const { meetingKey: _m, placeKey: _p, linkKeys: _l, ...rest } = e; return Buffer.byteLength(JSON.stringify(rest)) + 1; };
    const widest = Math.max(...r.events.map(stripped));
    expect(2 + widest * n).toBeLessThanOrEqual(CAL_EVENTS_BUDGET_BYTES);
  }, 60_000);
});

describe("identity (spec §4.2): selfStatus from PARTSTAT / ORGANIZER; organizerVerified raw, gated by G6 downstream", () => {
  const ME = "me@example.com", ALSO = "me@work.example";
  const att = (email: string, partstat: string) => `ATTENDEE;CN=Someone;PARTSTAT=${partstat}:mailto:${email}`;
  const one = (identity: IcsParseInput["identity"], ...lines: string[]) => parse(feed([], ev("SUMMARY:x", "DTSTART:20261009T100000Z", ...lines)), { identity }).events[0]!;
  test("your PARTSTAT, by any of your addresses; a decline anywhere wins", () => {
    const id = { self: [ME, ALSO] };
    expect(one(id, att(ME, "ACCEPTED")).selfStatus).toBe("accepted");
    expect(one(id, att(ALSO.toUpperCase(), "TENTATIVE")).selfStatus).toBe("tentative");
    expect(one(id, att(ME, "NEEDS-ACTION")).selfStatus).toBe("needs-action");
    expect(one(id, att(ME, "ACCEPTED"), att(ALSO, "DECLINED")).selfStatus).toBe("declined");
    expect(one(id, att("other@example.org", "DECLINED")).selfStatus).toBe("unknown");
    expect(one(id, att(ME, "DELEGATED")).selfStatus).toBe("unknown");
  });
  test("ORGANIZER makes you the organizer only when it is the CONFIRMED URL-path owner — and an explicit PARTSTAT comes first", () => {
    const verified = { self: [ME], verifiedOrganizer: ME };
    const o = one(verified, `ORGANIZER;CN=Me:mailto:${ME}`);
    expect([o.selfStatus, o.organizerVerified]).toEqual(["organizer", true]);
    const unverified = one({ self: [ME] }, `ORGANIZER;CN=Me:mailto:${ME}`);   // a configured owner / unconfirmed path owner
    expect([unverified.selfStatus, unverified.organizerVerified]).toEqual(["unknown", false]);
    const spoof = one(verified, `ORGANIZER:mailto:${ME}`, att(ME, "NEEDS-ACTION"));   // claims you organised it, asks you to answer
    expect([spoof.selfStatus, spoof.organizerVerified]).toEqual(["needs-action", true]);
    expect(one(verified, "ORGANIZER:mailto:boss@example.org").organizerVerified).toBe(false);
  });
  test("no self address (identity-unknown): every event is unknown — not accepted — and never organizer-verified", () => {
    const e = one({ self: [] }, att(ME, "ACCEPTED"), `ORGANIZER:mailto:${ME}`);
    expect([e.selfStatus, e.organizerVerified]).toEqual(["unknown", false]);
  });
  test("organizerVerified reaches the merged event ONLY with gate G6 overridden in a test (shipped off)", () => {
    const r = parse(feed([], ev("UID:v@x", "SUMMARY:Mine", "DTSTART:20261009T100000Z", `ORGANIZER:mailto:${ME}`)), { identity: { self: [ME], verifiedOrganizer: ME } });
    expect(r.events[0]!.organizerVerified).toBe(true);   // the raw trusted signal
    expect(reconcileCalendar({ runDate: RUN, copies: asCal(r.events) })[0]!.organizerVerified).toBe(false);
    expect(reconcileCalendar({ runDate: RUN, copies: asCal(r.events), g6: { eventkit: false, googleLink: true } })[0]!.organizerVerified).toBe(true);
  });
  test("TRANSP and STATUS map to transparency and status", () => {
    const id = { self: [] };
    expect(one(id, "TRANSP:TRANSPARENT").transparency).toBe("free");
    expect(one(id, "TRANSP:OPAQUE").transparency).toBe("busy");
    expect(one(id).transparency).toBe("busy");
    expect(one(id, "STATUS:TENTATIVE").status).toBe("tentative");
    expect(one(id, "STATUS:CONFIRMED").status).toBe("confirmed");
  });
});

// ── the index ────────────────────────────────────────────────────────────────────────────────────────

describe("the UID index (CalUidIndex, spec §4.2)", () => {
  test("every block with a UID, dropped or not; recurs on RRULE/RDATE masters; a date start is LOCAL midnight; unclear → null", () => {
    const r = parse(feed([],
      ev("UID:a@x", "DTSTART;VALUE=DATE:20261009", "LAST-MODIFIED:20261001T120000Z", "SEQUENCE:2"),
      ev("UID:b@x", "DTSTART:20200101T100000Z", "RRULE:FREQ=YEARLY"),
      ev("UID:c@x", "DTSTART:20200101T100000Z", "RDATE:20200301T100000Z"),
      ev("UID:d@x", "DTSTART;TZID=Mars/Olympus:20200101T100000"),
      ev("UID:e@x", "DTSTART:garbage"),
      ["BEGIN:VEVENT", "DTSTART:20261009T100000Z", "SUMMARY:no uid", "END:VEVENT"]), { zone: "America/New_York" });
    expect(r.index).toEqual([
      { uid: "a@x", startMs: utc("2026-10-09T04:00:00Z"), sequence: 2, lastModified: utc("2026-10-01T12:00:00Z") },
      { uid: "b@x", startMs: utc("2020-01-01T10:00:00Z"), recurs: true },
      { uid: "c@x", startMs: utc("2020-01-01T10:00:00Z"), recurs: true },
      { uid: "d@x", startMs: null },
      { uid: "e@x", startMs: null },
    ] satisfies CalUidIndexEntry[]);
  });
  test("final harden r3: duplicate UIDs are folded IN THE CHILD — one entry per (UID, recurrence id), the newest revision", () => {
    const dups = Array.from({ length: 20_000 }, (_, i) => ev("UID:dup@x", `SUMMARY:D${i}`, "DTSTART:20200101T100000Z", `SEQUENCE:${i % 5}`));
    const r = parse(feed([], ...dups,
      ev("UID:dup@x", "SUMMARY:newest", "DTSTART:20270115T100000Z", "SEQUENCE:9"),
      ev("UID:dup@x", "DTSTART:20260601T100000Z", "RRULE:FREQ=YEARLY", "SEQUENCE:1"),
      ev("UID:other@x", "DTSTART:20261009T100000Z")));
    expect(r.index).toEqual([
      { uid: "dup@x", startMs: utc("2027-01-15T10:00:00Z"), sequence: 9, recurs: true },
      { uid: "other@x", startMs: utc("2026-10-09T10:00:00Z") },
    ] satisfies CalUidIndexEntry[]);
  }, 30_000);

  test("final harden r3: a replacement whose RECURRENCE-ID cannot be read is NOT indexed — it cannot supersede today's master", () => {
    // Same link, higher SEQUENCE, a far DTSTART: indexed as if it had no RECURRENCE-ID, it hid today's real meeting.
    const r = parse(feed([],
      ev("UID:s@x", "SUMMARY:Standup", "DTSTART:20261009T100000Z", "SEQUENCE:1"),
      ev("UID:s@x", "SUMMARY:Standup", "RECURRENCE-ID:not-a-date", "DTSTART:20270301T100000Z", "SEQUENCE:7"),
      ev("UID:s@x", "SUMMARY:Standup", "RECURRENCE-ID:20261008T100000Z", "DTSTART:garbage", "SEQUENCE:8")));
    expect(r.index).toEqual([{ uid: "s@x", startMs: utc("2026-10-09T10:00:00Z"), sequence: 1 }] satisfies CalUidIndexEntry[]);
    expect(r.incomplete).toContain("malformed-event");
    expect(reconcileCalendar({ runDate: RUN, copies: asCal(r.events), indexes: [{ sourceId: "work", entries: r.index }] }).map((e) => e.title)).toEqual(["Standup"]);
  });

  test("a far-moved copy in the index supersedes a stale copy of THE SAME link — never another source's (reconcile, end to end)", () => {
    const r = parse(feed([], ev("UID:m@x", "SUMMARY:Moved", "DTSTART:20270115T100000Z", "SEQUENCE:5")));
    const stale: CalEvent = asCal(parse(feed([], ev("UID:m@x", "SUMMARY:Moved", "DTSTART:20261009T100000Z", "SEQUENCE:4"))).events)[0]!;
    expect(reconcileCalendar({ runDate: RUN, copies: [stale] })).toHaveLength(1);
    expect(reconcileCalendar({ runDate: RUN, copies: [stale], indexes: [{ sourceId: "work", entries: r.index }] })).toEqual([]);
    // Decision 19: another source's copy (here the Mac source's) is never superseded by this link's index.
    const macCopy: CalEvent = { ...stale, sources: [{ kind: "macos", id: "macos", calendarId: "c" }] };
    expect(reconcileCalendar({ runDate: RUN, copies: [macCopy], indexes: [{ sourceId: "work", entries: r.index }] })).toHaveLength(1);
  });
});

// ── text: unescaping, folding, cleaning ──────────────────────────────────────────────────────────────

describe("content lines and cleaning", () => {
  test("folding, TEXT escapes, quoted parameters and RFC 6868 carets are read; every field comes out CLEANED", () => {
    const r = parse(feed([], ev("UID:t@x", "DTSTART:20261009T100000Z", "SUMMARY:Plan\\, review\\; ship",
      "DESCRIPTION:<p>Line one\\nLine two</p> https://zoom.us/j/123?pwd=sekret Passcode: 991122",
      " -::~:~::~ Join with Google Meet: https://meet.google.com/abc",
      "LOCATION:Room 4\\, Floor 2", "ATTENDEE;CN=\"Doe, Jane: PM\";PARTSTAT=ACCEPTED:mailto:Jane.Doe@Example.ORG",
      "ORGANIZER;CN=Ann ^'Boss^' ^^:mailto:ann@example.org")));
    const e = r.events[0]!;
    expect(e.title).toBe("Plan, review; ship");
    expect(e.location).toBe("Room 4, Floor 2");
    expect(e.description).toBe(`Line one Line two zoom.us link Passcode: ${REDACTION_FOR_TESTS}`);
    expect(e.attendees).toEqual([{ name: "Doe, Jane: PM", email: "jane.doe@example.org", status: "accepted" }]);
    expect(e.organizer).toEqual({ name: "Ann \"Boss\" ^", email: "ann@example.org" });
  });
  test("sub-components (VALARM) are ignored: their properties never become the event's", () => {
    const r = parse(feed([], ev("UID:al@x", "DTSTART:20261009T100000Z", "SUMMARY:Real", "BEGIN:VALARM", "SUMMARY:Alarm text", "DESCRIPTION:Reminder", "TRIGGER:-PT10M", "END:VALARM")));
    expect(r.events.map((e) => [e.title, e.description ?? "-"])).toEqual([["Real", "-"]]);
  });
});

// ── a feed shaped like the user's ────────────────────────────────────────────────────────────────────

describe("a synthetic feed shaped like the user's (spec §1.1)", () => {
  const text = userShapedFeed();
  test("its shape is what spec §1.1 measured — re-counted from the text", () => {
    const blocks = text.replace(/\r\n[ \t]/g, "").split("BEGIN:VEVENT").slice(1).map((b) => b.split("END:VEVENT")[0]!);
    const count = (re: RegExp) => blocks.filter((b) => re.test(b)).length;
    expect({
      events: blocks.length, attendeeEvents: count(/\r\nATTENDEE[^\r]*CN=[^\r]*PARTSTAT=|\r\nATTENDEE[^\r]*PARTSTAT=[^\r]*CN=/),
      organizer: count(/\r\nORGANIZER/), description: count(/\r\nDESCRIPTION:./), location: count(/\r\nLOCATION:./), rrule: count(/\r\nRRULE:/),
      recurrenceId: count(/\r\nRECURRENCE-ID/), exdate: count(/\r\nEXDATE/), vtimezone: text.split("BEGIN:VTIMEZONE").length - 1,
      transp: count(/\r\nTRANSP:/), utcStarts: count(/\r\nDTSTART:\d{8}T\d{6}Z/), dateStarts: count(/\r\nDTSTART;VALUE=DATE:/),
    }).toEqual({ ...USER_FEED_COUNTS });
    expect(text.split("X-WR-TIMEZONE").length - 1).toBe(1);
  });
  test("parses in full: no flags, all 152 blocks indexed, today's events right, every field clean", () => {
    const r = parse(text, { runDate: USER_FEED_RUN_DATE, zone: "America/Los_Angeles", identity: { self: [USER_FEED_SELF] } });
    expect(r.incomplete).toEqual([]);
    expect(r.index).toHaveLength(152);
    expect(r.index.filter((e) => e.recurs)).toHaveLength(8);
    expect(r.index.filter((e) => e.recurrenceId !== undefined).map((e) => e.uid)).toEqual([userFeedUid(141), userFeedUid(142)]);
    expect(r.events.length).toBeGreaterThan(10);
    for (const e of r.events) {
      for (const f of [e.title, e.location, e.organizer?.name, ...e.attendees.map((a) => a.name)]) if (f !== undefined) expect(isCleanCalendarText(f, "title")).toBe(true);
      if (e.description !== undefined) {
        expect(isCleanCalendarText(e.description, "description")).toBe(true);
        expect(e.description).not.toMatch(/4815|meet\.google|<b>|&amp;|-::~/);
        expect(e.description).toContain("docs.example.com link");
      }
    }
    // The two overrides replaced the occurrences they name, and arrived as events of their own.
    const overrides = r.events.filter((e) => e.uid === userFeedUid(141) || e.uid === userFeedUid(142));
    const keys = overrides.map((e) => e.recurrenceKey);
    expect(new Set(keys).size).toBe(keys.length);   // no occurrence twice (the master's copy is gone)
    expect(r.events.filter((e) => e.title === "Item 150 planning" || e.title === "Item 151 1:1")).toHaveLength(2);
    // Your answer is read from your ATTENDEE line (event i answered STATUSES[i % 4]); no line of yours: unknown.
    const statusOf = (i: number) => [...new Set(r.events.filter((e) => e.uid === userFeedUid(i)).map((e) => e.selfStatus))];
    expect(statusOf(16)).toEqual(["accepted"]);       // weekly since 2018 (re-anchored), still in the window
    expect(statusOf(18)).toEqual(["needs-action"]);
    expect(statusOf(146)).toEqual(["unknown"]);
    // Series 141 (daily 03:00 Asia/Kolkata from Oct 8): Oct 9 is replaced by override 150 (now Oct 10 09:00Z), Oct 10
    // is an EXDATE; what is left in the window, keyed by each ORIGINAL start.
    const k = (s: string) => String(utc(s));
    expect(r.events.filter((e) => e.uid === userFeedUid(141)).map((e) => [e.title, e.recurrenceKey, timedIso(e).slice(0, 24)])).toEqual([
      ["Item 141 review", k("2026-10-07T21:30:00Z"), "2026-10-07T21:30:00.000Z"],
      ["Item 141 review", k("2026-10-10T21:30:00Z"), "2026-10-10T21:30:00.000Z"],
      ["Item 141 review", k("2026-10-11T21:30:00Z"), "2026-10-11T21:30:00.000Z"],
      ["Item 150 planning", k("2026-10-08T21:30:00Z"), "2026-10-10T09:00:00.000Z"],
    ]);
  });
});

// ── hostile input ────────────────────────────────────────────────────────────────────────────────────

describe("hostile input ends — fast, flagged where it must be, never a throw", () => {
  const timed = <T,>(f: () => T): [T, number] => { const t0 = performance.now(); const r = f(); return [r, performance.now() - t0]; };
  test("deeply nested components, inside an event and at the top, unclosed", () => {
    const deep = (n: number) => Array.from({ length: n }, (_, i) => `BEGIN:X${i % 7}`).join("\r\n");
    // 200,000 unclosed components inside an event that IS closed: its END:VEVENT closes them all, and none of their
    // properties is the event's.
    const [inside, t1] = timed(() => parse(feed([], ev("UID:n@x", "SUMMARY:Nested", "DTSTART:20261009T100000Z", deep(200_000), "SUMMARY:inner"))));
    expect(inside.events.map((e) => e.title)).toEqual(["Nested"]);
    expect(inside.incomplete).toEqual([]);
    // An event whose own END never comes (the calendar closes around it) is dropped and flagged.
    const [open, t3] = timed(() => parse(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:o@x\r\nDTSTART:20261009T100000Z\r\n${deep(200_000)}\r\nEND:VCALENDAR\r\n`));
    expect(open.events).toEqual([]);
    expect(open.incomplete).toEqual(["malformed-event"]);
    const [top, t2] = timed(() => parse(`BEGIN:VCALENDAR\r\n${deep(200_000)}\r\n`));
    expect(top.incomplete).toEqual(["truncated"]);
    expect(t1 + t2 + t3).toBeLessThan(5_000);
    // …and closed properly, the event survives its nesting.
    const closed = parse(feed([], ev("UID:c@x", "SUMMARY:Closed", "DTSTART:20261009T100000Z", "BEGIN:VALARM", "BEGIN:X", "BEGIN:Y", "END:Y", "END:X", "END:VALARM")));
    expect(closed.events.map((e) => e.title)).toEqual(["Closed"]);
  }, 20_000);
  test("huge lines: a 15 MB description, a 1 MB folded title, 100,000 parameters on one line", () => {
    const [r, t] = timed(() => parse(feed([],
      ev("UID:h@x", "SUMMARY:Huge", "DTSTART:20261009T100000Z", `DESCRIPTION:${"word ".repeat(3_000_000)}`),
      ev("UID:f@x", `SUMMARY:${"t".repeat(100)}`, ...Array.from({ length: 10_000 }, () => ` ${"y".repeat(100)}`), "DTSTART:20261009T100000Z"),
      ev("UID:p@x", "SUMMARY:Params", "DTSTART:20261009T100000Z", `ATTENDEE${";X-A=1".repeat(100_000)};PARTSTAT=ACCEPTED:mailto:a@example.org`))));
    expect(r.events.map((e) => e.title.length <= 120)).toEqual([true, true, true]);
    expect(r.events[0]!.description!.length).toBeLessThanOrEqual(400);
    expect(t).toBeLessThan(10_000);
  }, 30_000);
  test("malformed dates and values are flagged or ignored, never thrown", () => {
    const r = parse(feed([],
      ev("SUMMARY:a", "DTSTART:20261345T250000Z"), ev("SUMMARY:b", "DTSTART:99999999T999999"), ev("SUMMARY:c", "DTSTART;TZID=:20261009T100000"),
      ev("SUMMARY:d", "DTSTART;VALUE=DATE:2026-10-09"), ev("SUMMARY:e", "DTSTART:20261009T100000Z", "DTEND:20261009T1"),
      ev("SUMMARY:f", "DTSTART:20261009T100000Z", "RRULE:FREQ=DAILY;UNTIL=garbage"), ev("SUMMARY:g", "DTSTART:20261009T100000Z", "RRULE:FREQ=WEEKLY;BYMONTHDAY=3"),
      ev("SUMMARY:h", "DTSTART:20261009T100000Z", "RRULE:RSCALE=GREGORIAN;FREQ=DAILY"), ev("SUMMARY:i", "DTSTART:20261009T100000Z", "SEQUENCE:-1", "LAST-MODIFIED:x"),
      ev("SUMMARY:j", "DTSTART:20261009T100000Z", "RDATE:nonsense,20261010T100000Z", "EXDATE:alsononsense"),
      ["NOT A CONTENT LINE", ":", ";;;", "X-;=:"]));
    expect(r.incomplete).toEqual(["unsupported", "malformed-event"]);
    // The readable starts still produce events (an unreadable DTEND falls back to zero length).
    expect(r.events.map((e) => e.title)).toEqual(expect.arrayContaining(["c", "e", "i", "j"]));
  });
  test("not iCalendar at all, or a zone the runtime does not know: parse-error", () => {
    expect(parseIcsFeed(ICAL, { ics: "<html>404</html>", sourceId: "w", runDate: RUN, zone: "UTC", identity: { self: [] }, maxEvents: 1 })).toEqual({ ok: false, error: "parse-error" });
    expect(parseIcsFeed(ICAL, { ics: feed([]), sourceId: "w", runDate: RUN, zone: "Mars/Olympus", identity: { self: [] }, maxEvents: 1 })).toEqual({ ok: false, error: "parse-error" });
  });
  test("the G5 heavy feed (2,000 events here) parses in well under the step's budget", () => {
    const [r, t] = timed(() => parse(heavyFeed({ events: 2_000, years: 10 }), { zone: "America/New_York" }));
    expect(r.incomplete).toEqual([]);
    expect(r.index).toHaveLength(2_000);
    expect(t).toBeLessThan(5_000);
  }, 20_000);
});

// ── the window the child uses is the parent's reconcile window ───────────────────────────────────────

describe("the child's window = reconcileWindow(runDate, \"link\") in the parent's zone", () => {
  test("in forced zones, across DST: events at the window's edges are in or out exactly as reconcile's window says", async () => {
    const code = `
const { reconcileWindow } = await import(${JSON.stringify(join(import.meta.dir, "../src/calendar/reconcile.ts"))});
const { parseIcsFeed } = await import(${JSON.stringify(join(import.meta.dir, "../src/calendar/ics.ts"))});
const { default: ICAL } = await import(${JSON.stringify(join(import.meta.dir, "../src/calendar/vendor/ical.js"))});
const out = {};
for (const runDate of ["2026-03-08", "2026-11-01", "2026-10-09"]) {
  const w = reconcileWindow(runDate, "link");
  const z = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const ev = (t, s, e) => ["BEGIN:VEVENT", "UID:" + t, "SUMMARY:" + t, "DTSTART:" + z(s), "DTEND:" + z(e), "END:VEVENT"];
  const ics = ["BEGIN:VCALENDAR", ...ev("before", w.startMs - 3600000, w.startMs), ...ev("first", w.startMs - 60000, w.startMs + 60000),
    ...ev("last", w.endMs - 60000, w.endMs), ...ev("after", w.endMs, w.endMs + 3600000), "END:VCALENDAR"].join("\\r\\n");
  const r = parseIcsFeed(ICAL, { ics, sourceId: "w", runDate, zone: Intl.DateTimeFormat().resolvedOptions().timeZone, identity: { self: [] }, maxEvents: 10 });
  out[runDate] = r.ok ? r.events.map((e) => e.title) : "parse-error";
}
console.log(JSON.stringify(out));`;
    for (const zone of ["America/New_York", "Europe/London", "America/Santiago", "Asia/Kolkata"]) {
      const p = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, TZ: zone }, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited;
      if (p.exitCode !== 0) throw new Error(`window child (${zone}) exited ${p.exitCode}: ${err}`);
      const got = JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, string[]>;
      for (const [d, titles] of Object.entries(got)) expect(`${zone} ${d}: ${titles.join(",")}`).toBe(`${zone} ${d}: first,last`);
    }
  }, 60_000);
});


// ── M2c review fixes (hub, 2026-10-09) ─────────────────────────────────────────────────────────────────

describe("M2c review: hostile values never break the answer", () => {
  test("a leap-day yearly rule at a non-leap run date emits nothing, anchored or not (no phantom 1 March)", () => {
    for (const dt of ["DTSTART;VALUE=DATE:20240229", "DTSTART:20240229T090000Z"]) {
      const ics = feed([], ev("UID:leap@x", "SUMMARY:Leap", dt, "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29"));
      for (const runDate of ["2027-02-28", "2027-03-01"]) {
        expect(`${dt} @ ${runDate}: ${parse(ics, { runDate }, { reanchor: true }).events.map(timedIso)}`).toBe(`${dt} @ ${runDate}: `);
      }
      expect(parse(ics, { runDate: "2028-02-29" }, { reanchor: true }).events).toHaveLength(1);
    }
  });
  test("a huge DURATION on an all-day or unclear event ends at 9999-12-31 at the latest — never a five-digit year", () => {
    const r = parse(feed([],
      ev("SUMMARY:Forever", "DTSTART;VALUE=DATE:20261009", "DURATION:P999999W"),
      ev("SUMMARY:Unclear forever", "DTSTART;TZID=Custom/Nowhere:20261009T100000", "DURATION:P999999W"),
      ev("SUMMARY:Timed forever", "DTSTART:20261009T100000Z", "DURATION:P999999W"),
    ));
    const t = (title: string) => byTitle(r.events, title)[0]!.time;
    expect(t("Forever")).toEqual({ kind: "allDay", startDate: "2026-10-09", endDateExclusive: "9999-12-31" });
    const u = t("Unclear forever");
    expect(u.kind === "unclear" && u.endDate).toBe("9999-12-31");
    const tf = t("Timed forever");
    expect(tf.kind === "timed" && Number.isFinite(tf.endMs) && tf.endMs > tf.startMs).toBe(true);
  });
  test("a UID carrying a line break or a control character is hashed, the same way in every feed", () => {
    const r = parse(feed([], ev("UID:a\\nEVENT x", "SUMMARY:A", "DTSTART:20261009T100000Z"), ev("UID:b\u0007c", "SUMMARY:B", "DTSTART:20261009T110000Z")));
    for (const e of r.events) expect(e.uid).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const x of r.index) expect(x.uid).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.index.map((x) => x.uid)).toEqual(r.events.map((e) => e.uid!));
  });
});
