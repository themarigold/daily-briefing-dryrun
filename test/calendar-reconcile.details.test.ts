import { describe, expect, test } from "bun:test";
import { CAL_DETAILS_BUDGET_BYTES, parseIcsDetails } from "../src/calendar/ics";
import { producerKeys } from "../src/calendar/join";
import { reconcileCalendar } from "../src/calendar/reconcile";
import ICAL from "../src/calendar/vendor/ical.js";
import type { CalEvent, CalRawDetails } from "../src/calendar/types";

const RUN = "2026-10-09";
const at = (hour: number): number => new Date(2026, 9, 9, hour).getTime();

for (const newestHasLink of [true, false]) {
  for (const newestFirst of [true, false]) {
    test(`Mac details follow the newest title/time: newest ${newestFirst ? "first" : "last"}, ${newestHasLink ? "with" : "without"} a Join link`, () => {
      const older: CalEvent = {
        sources: [{ kind: "macos", id: "macos", calendarId: "old-calendar" }],
        uid: "same-event",
        time: { kind: "timed", startMs: at(9), endMs: at(10) },
        title: "Old meeting",
        attendees: [], selfStatus: "accepted", organizerVerified: false,
        transparency: "busy", status: "confirmed", provenance: {}, lastModified: 100,
        details: {
          url: "https://zoom.us/j/111", location: "Old room", notes: "Old notes",
          people: [{ name: "Old person", organiser: false }],
        },
      };
      const newest: CalEvent = {
        ...older,
        sources: [{ kind: "macos", id: "macos", calendarId: "new-calendar" }],
        time: { kind: "timed", startMs: at(10), endMs: at(11) },
        title: "New meeting", lastModified: 200,
        details: {
          // The design specifies Mac-over-link preference, not fallback to an older Mac link.
          // A missing URL belongs to the newest revision too; do not resurrect the old link.
          ...(newestHasLink ? { url: "https://zoom.us/j/222" } : {}),
          location: "New room", notes: "New notes",
          people: [{ name: "New person", organiser: true }],
        },
      };
      const copies = newestFirst ? [newest, older] : [older, newest];
      const expected = [[newest.title, newest.time, newest.details]];
      const macOnly = reconcileCalendar({ runDate: RUN, copies });
      expect(macOnly.map((e) => [e.title, e.time, e.details])).toEqual(expected);

      // A link copy exercises the outer, cross-source assemble as well as the Mac-source merge.
      const link: CalEvent = {
        ...newest,
        sources: [{ kind: "link", id: "work", calendarId: "work" }],
        title: "Link meeting", lastModified: 50,
        details: { url: "https://zoom.us/j/333", notes: "Link notes", people: [] },
      };
      const withLink = reconcileCalendar({ runDate: RUN, copies: [link, ...copies] });
      expect(withLink.map((e) => [e.title, e.time, e.details])).toEqual(expected);
      expect(withLink[0]!.sources.map((s) => s.calendarId).sort()).toEqual(["new-calendar", "old-calendar", "work"]);
    });
  }
}

// Final round 5 (M2): the same rule inside the Mac source. When the Mac copy whose title and time are kept carries no
// details (none were read for it), the Mac view has none: an older Mac copy's are never taken instead. Across sources
// the link's OWN view (its kept copy, at the same time) may still supply them, as calendar-details.pipeline.test.ts
// pins ("a Mac copy with none yields the ICS's").
for (const newestFirst of [true, false]) {
  test(`the kept Mac copy without details gives the event none, never an older copy's (newest ${newestFirst ? "first" : "last"})`, () => {
    const older: CalEvent = {
      sources: [{ kind: "macos", id: "macos", calendarId: "old-calendar" }],
      uid: "same-event",
      time: { kind: "timed", startMs: at(9), endMs: at(10) },
      title: "Old meeting",
      attendees: [], selfStatus: "accepted", organizerVerified: false,
      transparency: "busy", status: "confirmed", provenance: {}, lastModified: 100,
      details: { url: "https://zoom.us/j/111", notes: "Old notes", people: [{ name: "Old person", organiser: false }] },
    };
    const { details: _none, ...bare } = older;
    const newest: CalEvent = {
      ...bare,
      sources: [{ kind: "macos", id: "macos", calendarId: "new-calendar" }],
      time: { kind: "timed", startMs: at(10), endMs: at(11) },
      title: "New meeting", lastModified: 200,
    };
    const copies = newestFirst ? [newest, older] : [older, newest];
    const macOnly = reconcileCalendar({ runDate: RUN, copies });
    expect(macOnly.map((e) => [e.title, "details" in e])).toEqual([["New meeting", false]]);
    const link: CalEvent = {
      ...newest,
      sources: [{ kind: "link", id: "work", calendarId: "work" }],
      title: "Link meeting", lastModified: 50,
      details: { url: "https://zoom.us/j/333", notes: "Link notes", people: [] },
    };
    const withLink = reconcileCalendar({ runDate: RUN, copies: [link, ...copies] });
    expect(withLink.map((e) => [e.title, e.details])).toEqual([["New meeting", link.details]]);
  });
}

// Final round 5 (M2): a link feed carries two revisions of one meeting (one UID, SEQUENCE 1 then 2, both today), and
// the details budget (`CAL_DETAILS_BUDGET_BYTES`, filled in start order) runs out between them, so the OLDER revision
// keeps its details and the NEWER one, whose title and time the merge keeps, has none. The meeting must then show
// "Details not available": never the older revision's people, notes and Join link beside the newer title.
test("a newer revision past the details budget gets no details, never the older revision's (one link, one UID)", () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const people = Array.from({ length: 150 }, (_, i) => `ATTENDEE;CN=Attendee Number ${i} With A Long Name:mailto:a${i}@example.com`);
  const notes = `DESCRIPTION:${"Agenda words. ".repeat(400)}`;
  const vevent = (...lines: string[]): string[] => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];
  const filler = (i: number): string[] => vevent(
    `UID:filler-${i}@test`, `SUMMARY:Filler ${i}`,
    `DTSTART:20261009T${String(Math.floor(i / 60)).padStart(2, "0")}${String(i % 60).padStart(2, "0")}00`, "DURATION:PT1M", notes, ...people,
  );
  const older = vevent("UID:dup@test", "SEQUENCE:1", "SUMMARY:Old revision", "DTSTART:20261009T090000", "DTEND:20261009T093000", "URL:https://zoom.us/j/111");
  const newer = vevent("UID:dup@test", "SEQUENCE:2", "SUMMARY:New revision", "DTSTART:20261009T100000", "DTEND:20261009T103000",
    "URL:https://zoom.us/j/222", notes, ...people);
  const feed = (fillers: number): string =>
    ["BEGIN:VCALENDAR", "VERSION:2.0", ...Array.from({ length: fillers }, (_, i) => filler(i)).flat(), ...older, ...newer, "END:VCALENDAR", ""].join("\r\n");
  const parse = (fillers: number) => {
    const r = parseIcsDetails(ICAL, { ics: feed(fillers), sourceId: "work", runDate: RUN, zone, identity: { self: [] }, maxEvents: 5_000 });
    if (!r.ok) throw new Error("parse-error");
    return r;
  };
  const bytes = (d: unknown): number => Buffer.byteLength(JSON.stringify(d)) + 11;   // ics.ts's DETAILS_KEY_BYTES
  // Measure each occurrence's charge, then put just enough fillers first that the older revision fits and the newer
  // one does not.
  const probe = parse(1);
  const charge = (title: string): number => bytes(probe.events.find((e) => e.title === title)!.details);
  const room = CAL_DETAILS_BUDGET_BYTES - charge("Old revision");
  const fillers = Math.floor(room / charge("Filler 0"));
  expect(room - fillers * charge("Filler 0")).toBeLessThan(charge("New revision"));   // PREMISE: the newer one cannot fit
  const r = parse(fillers);
  expect(r.detailsCapped).toBe(true);
  const byTitle = (t: string) => r.events.find((e) => e.title === t);
  expect(byTitle("Old revision")?.details?.url).toBe("https://zoom.us/j/111");   // PREMISE: the older one kept its details
  expect(byTitle("New revision")).toBeDefined();
  expect(byTitle("New revision")!.details).toBeUndefined();                       // PREMISE: the newer one has none
  const source = { kind: "link" as const, id: "work", calendarId: "work" };
  const merged = reconcileCalendar({
    runDate: RUN,
    copies: r.events.map((e) => ({ ...e, sources: [source], provenance: {} })),
    indexes: [{ sourceId: "work", entries: r.index }],
  }).filter((e) => e.uid === "dup@test");
  expect(merged.map((e) => e.title)).toEqual(["New revision"]);
  expect(merged[0]!.details).toBeUndefined();
}, 60_000);

// ── key c's per-view carrier, `viewDetails` (T4.1: C03, C08, X15; spec §5 "Per-view carrier", "No older revisions") ──

describe("key c: viewDetails in details mode only (T4.1: C03, C08, X15)", () => {
  const cal = (calendarId: string) => ({ kind: "macos" as const, id: "macos", calendarId });
  let n = 0;
  /** One key-c view: its own UID and Mac calendar, the producer keys of its raw location, optional raw details. */
  const view = (calendarId: string, title: string, over: Partial<CalEvent> = {}, details?: CalRawDetails): CalEvent => ({
    sources: [cal(calendarId)], uid: `vd-${++n}`, time: { kind: "timed", startMs: at(9), endMs: at(10) }, title, location: "Clinic North",
    attendees: [], selfStatus: "accepted", organizerVerified: false, transparency: "busy", status: "confirmed", provenance: {},
    ...producerKeys({ location: "Clinic North" }), ...(details !== undefined ? { details } : {}), ...over,
  });
  const D = (notes: string): CalRawDetails => ({ notes, people: [{ name: notes, organiser: false }] });
  const orders = <T,>(xs: readonly T[]): T[][] =>
    xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
  const one = (copies: CalEvent[], details: boolean): CalEvent => {
    const out = reconcileCalendar({ runDate: RUN, copies, ...(details ? { details: true as const } : {}) });
    expect(out).toHaveLength(1);
    return out[0]!;
  };

  test("C03 details mode: the core's details on the event; viewDetails = core first, then merge order, each with its cleaned title, tier and own details; no keys", () => {
    // Tiers 1, 2, 3: the answered view is the core whatever its title length; the others follow in merge order (here by
    // minimum source, both views having absent revision data).
    const answered = view("cal-c", "Ticket: X", { selfStatus: "accepted" }, D("answered"));
    const own = view("cal-a", "X", { selfStatus: "unknown" }, D("own"));
    const invite = view("cal-b", "X", { selfStatus: "needs-action", organizer: { email: "h@example.com" }, attendees: [{ email: "h@example.com" }] }, D("invite"));
    for (const copies of orders([answered, own, invite])) {
      const e = one(copies, true);
      expect(e.details).toEqual(D("answered"));
      expect(e.viewDetails).toEqual([
        { title: "Ticket: X", tier: 1, details: D("answered") },
        { title: "X", tier: 2, details: D("own") },
        { title: "X", tier: 3, details: D("invite") },
      ]);
      // Each entry carries exactly title, tier and details: no meeting, place or link keys.
      for (const entry of e.viewDetails!) expect(Object.keys(entry).sort()).toEqual(["details", "tier", "title"]);
    }
  });

  test("C08 the morning path (details mode not passed) carries no viewDetails, even when the views hold details: the mode is explicit, never inferred", () => {
    const a = view("cal-a", "X", {}, D("a")), b = view("cal-b", "Ticket: X", {}, D("b"));
    for (const copies of orders([a, b])) {
      const e = one(copies, false);
      expect("viewDetails" in e).toBe(false);
      expect(e.nearDuplicate).toEqual({ mark: "calendars", count: 2 });
    }
    // And details mode with no view holding details still builds the carrier (entries without details are kept).
    const bare = [view("cal-a", "X"), view("cal-b", "Ticket: X")];
    for (const copies of orders(bare)) {
      const e = one(copies, true);
      expect("details" in e).toBe(false);
      expect(e.viewDetails).toStrictEqual([{ title: "X", tier: 1, details: undefined }, { title: "Ticket: X", tier: 1, details: undefined }]);
    }
  });

  test("C08 an entry lacking details is kept in its place; the event's own details are the core's, absent when the core has none", () => {
    const core = view("cal-a", "X");                                     // shortest title: the core, no details
    const other = view("cal-b", "Ticket: X", {}, D("other"));
    for (const copies of orders([core, other])) {
      const e = one(copies, true);
      expect("details" in e).toBe(false);
      expect(e.viewDetails).toStrictEqual([{ title: "X", tier: 1, details: undefined }, { title: "Ticket: X", tier: 1, details: D("other") }]);
    }
  });

  test("C08 the core has details and another view has none: that entry is details undefined, never the core's", () => {
    const core = view("cal-a", "X", {}, D("core"));                       // shortest title: the core, with details
    const other = view("cal-b", "Ticket: X");                              // no details of its own
    for (const copies of orders([core, other])) {
      const e = one(copies, true);
      expect(e.details).toEqual(D("core"));
      expect(e.viewDetails).toStrictEqual([{ title: "X", tier: 1, details: D("core") }, { title: "Ticket: X", tier: 1, details: undefined }]);
    }
  });

  test("C08 no older revision's details: a view whose kept copy has none carries none, though an older copy of it had some", () => {
    // View 1 is a key-a group in ONE Mac calendar: the newer revision (kept) has no details, the older one does.
    const older = view("cal-a", "X", { uid: "kept", lastModified: 100 }, D("older revision"));
    const { details: _gone, ...newer } = { ...older, lastModified: 200 };
    const other = view("cal-b", "Ticket: X", {}, D("other"));
    for (const copies of orders([older, newer as CalEvent, other])) {
      const e = one(copies, true);
      expect(e.viewDetails).toStrictEqual([{ title: "X", tier: 1, details: undefined }, { title: "Ticket: X", tier: 1, details: D("other") }]);
      expect(JSON.stringify(e)).not.toContain("older revision");
    }
  });

  test("C08/X15 (viewDetails half) a cancelled view is never an entry; one non-cancelled view left → no viewDetails", () => {
    const live = view("cal-a", "X", {}, D("live"));
    const dead = view("cal-b", "Ticket: X", { status: "cancelled", lastModified: 9 }, D("dead"));
    for (const copies of orders([live, dead])) {
      const e = one(copies, true);
      expect(e.sources.map((s) => s.calendarId)).toEqual(["cal-a", "cal-b"]);   // PREMISE: the two merged
      expect("viewDetails" in e).toBe(false);
      expect(e.details).toEqual(D("live"));
    }
    const live2 = view("cal-c", "X", {}, D("live 2"));
    for (const copies of orders([live, dead, live2])) {
      const e = one(copies, true);
      expect(e.viewDetails!.map((d) => d.details?.notes)).toEqual(["live", "live 2"]);
    }
  });
});
