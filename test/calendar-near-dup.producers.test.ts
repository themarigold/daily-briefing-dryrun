// test/calendar-near-dup.producers.test.ts — key c (calendar near-duplicates, spec 2026-10-31 §3/§4/§7) end to end
// from the two PRODUCERS into reconcile: the Mac reader's `macEventFrom` (through `macEventsFrom`) and the link
// parser's `baseEvent` (through `parseIcsFeed` in morning mode and `parseIcsDetails` in details mode), each in both
// modes, so the producer keys reconcile matches on are the ones the producers really compute from raw fields.
//
// Link fixtures with EQUAL titles put both VEVENTs in ONE feed (one calendar, so key b cannot pre-merge them); link
// fixtures with related UNEQUAL titles use two link sources (a shared calendar would need equal titles, and key b
// never merges unequal titles). Mac fixtures use distinct calendars.
import { test, expect, describe } from "bun:test";
import { createHash } from "node:crypto";
import { producerKeys } from "../src/calendar/join";
import ICAL from "../src/calendar/vendor/ical.js";
import { parseIcsDetails, parseIcsFeed, type CalWireEvent } from "../src/calendar/ics";
import { macEventsFrom } from "../src/calendar/mac-events";
import { localZoneName } from "../src/calendar/link-parse";
import { reconcileCalendar } from "../src/calendar/reconcile";
import type { CalEvent } from "../src/calendar/types";

const RUN = "2026-10-09";
// LOCAL noon on the run date (local constructors, like calendar-reconcile.test.ts's `at()`), so the today filter keeps
// it in every zone; a fixed UTC instant falls on another local day east of UTC+11 or west of UTC−11.
const START = new Date(2026, 9, 9, 12).getTime(), END = new Date(2026, 9, 9, 13).getTime();
/** The process's zone, passed to the link parser as the parent's, as the pipeline does (`localZoneName`): its
 *  details-mode run-date test is in this zone. */
const LOCAL_ZONE = localZoneName();
/** An instant as an iCalendar UTC DATE-TIME (`20261009T120000Z`). */
const icsUtc = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const MODES = ["morning", "details"] as const;
type Mode = (typeof MODES)[number];
type Raw = { title: string; location?: string; notes?: string };

let n = 0;
/** Mac views: each raw in its own calendar with its own UID, read in `mode`. */
function macViews(raws: readonly Raw[], mode: Mode): CalEvent[] {
  const records = raws.map((r, i) => ({
    calendarId: `cal-${i}`, uid: `mac-${++n}`, startMs: START, endMs: END, title: r.title,
    ...(r.location !== undefined ? { location: r.location } : {}), ...(r.notes !== undefined ? { notes: r.notes } : {}),
  }));
  const out = macEventsFrom(records, [], mode === "details" ? { detailsFor: RUN } : {}).events;
  expect(out).toHaveLength(raws.length);
  return out;
}

const icsText = (s: string): string => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
/** One link feed holding every raw as a VEVENT, parsed in `mode`, as the pipeline attaches its source. */
function linkFeed(raws: readonly Raw[], mode: Mode, sourceId = "work"): CalEvent[] {
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", ...raws.flatMap((r) => [
    "BEGIN:VEVENT", `UID:link-${++n}@test`, `SUMMARY:${icsText(r.title)}`, `DTSTART:${icsUtc(START)}`, `DTEND:${icsUtc(END)}`,
    ...(r.location !== undefined ? [`LOCATION:${icsText(r.location)}`] : []), ...(r.notes !== undefined ? [`DESCRIPTION:${icsText(r.notes)}`] : []),
    "END:VEVENT",
  ]), "END:VCALENDAR", ""].join("\r\n");
  const input = { ics, sourceId, runDate: RUN, zone: LOCAL_ZONE, identity: { self: [] }, maxEvents: 5_000 };
  const r = mode === "details" ? parseIcsDetails(ICAL, input) : parseIcsFeed(ICAL, input);
  if (!r.ok) throw new Error("parse-error");
  expect(r.events).toHaveLength(raws.length);
  const source = { kind: "link" as const, id: sourceId, calendarId: sourceId };
  return r.events.map((e: CalWireEvent) => ({ ...e, sources: [source], provenance: {} }));
}
/** Two link sources, one raw each. */
const linkPair = (a: Raw, b: Raw, mode: Mode): CalEvent[] => [...linkFeed([a], mode, "work"), ...linkFeed([b], mode, "home")];

/** Reconciled counts for both input orders. */
const counts = (views: readonly CalEvent[]): number[] =>
  [reconcileCalendar({ runDate: RUN, copies: views }).length, reconcileCalendar({ runDate: RUN, copies: [...views].reverse() }).length];

/** Each producer's views of a related-title pair in both modes: Mac (two calendars) and link (two sources). */
function relatedPair(a: Raw, b: Raw): { label: string; views: CalEvent[] }[] {
  return MODES.flatMap((mode) => [
    { label: `mac/${mode}`, views: macViews([a, b], mode) },
    { label: `link/${mode}`, views: linkPair(a, b, mode) },
  ]);
}
/** Each producer's views of an equal-title pair in both modes: Mac (two calendars) and link (ONE feed), both feed orders. */
function equalPair(a: Raw, b: Raw): { label: string; views: CalEvent[] }[] {
  return MODES.flatMap((mode) => [
    { label: `mac/${mode}`, views: macViews([a, b], mode) },
    { label: `link/${mode}`, views: linkFeed([a, b], mode) },
    { label: `link-reversed/${mode}`, views: linkFeed([b, a], mode) },
  ]);
}
const expectCounts = (cases: { label: string; views: CalEvent[] }[], want: number): void => {
  for (const { label, views } of cases) expect(`${label}: ${counts(views)}`).toBe(`${label}: ${want},${want}`);
};

describe("producer → reconcile: P08 IP-host URLs", () => {
  test("P08 X / Ticket: X at https://127.0.0.1/room-a vs https://192.168.1.2/room-b: no place or meeting key, two events", () => {
    const cases = relatedPair({ title: "X", location: "https://127.0.0.1/room-a" }, { title: "Ticket: X", location: "https://192.168.1.2/room-b" });
    for (const { label, views } of cases) {
      expect(`${label}: ${views.map((v) => `${v.placeKey}/${v.meetingKey}`)}`).toBe(`${label}: undefined/undefined,undefined/undefined`);
    }
    expectCounts(cases, 2);
  });
});

describe("producer → reconcile: P09 long raw URL locations", () => {
  const longHost = `https://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.example.com/room`;
  test("P09 a URL-only location with a long host gives no placeKey: the same URL on both sides cannot merge related unequal titles", () => {
    const cases = relatedPair({ title: "X", location: longHost }, { title: "Ticket: X", location: longHost });
    for (const { label, views } of cases) expect(`${label}: ${views.map((v) => v.placeKey)}`).toBe(`${label}: ,`);
    expectCounts(cases, 2);
  });
  test("P09 a URL followed by a physical place matches the plain place (Mac within the reader's 1,000-scalar cap)", () => {
    const location = `https://maps.example.com/${"x".repeat(600)} Clinic North`;
    expect([...location].length).toBeLessThan(1_000);
    for (const mode of MODES) {
      const views = macViews([{ title: "X", location }, { title: "Ticket: X", location: "Clinic North" }], mode);
      expect(views[0]!.placeKey).toBe(views[1]!.placeKey!);
      expect(`mac/${mode}: ${counts(views)}`).toBe(`mac/${mode}: 1,1`);
    }
  });
  test("P09 a URL followed by a physical place past the details-only 1,000-scalar cap matches the plain place (link)", () => {
    const location = `https://maps.example.com/${"x".repeat(1_100)} Clinic North`;
    for (const mode of MODES) {
      const views = linkPair({ title: "X", location }, { title: "Ticket: X", location: "Clinic North" }, mode);
      expect(views[0]!.placeKey).toBe(views[1]!.placeKey!);
      if (mode === "details") expect([...(views[0]!.details?.location ?? "")].length).toBe(1_000);
      expect(`link/${mode}: ${counts(views)}`).toBe(`link/${mode}: 1,1`);
    }
  });
});

describe("producer → reconcile: equal-title link variants in one feed (M07, S18, S23)", () => {
  test("M07 equal titles, the same Whereby link, no physical place → one event", () => {
    expectCounts(equalPair({ title: "Interview", location: "https://whereby.com/acme-hr" }, { title: "Interview", location: "https://whereby.com/acme-hr" }), 1);
  });
  test("S18 equal titles, different link services (GoTo vs Whereby) → two events", () => {
    expectCounts(equalPair({ title: "Interview", location: "https://meet.goto.com/111" }, { title: "Interview", location: "https://whereby.com/acme-hr" }), 2);
  });
  test("S23 equal titles, the same map link at two clinics → two events", () => {
    expectCounts(equalPair(
      { title: "Dentist", location: "Clinic A, 1 Main St https://maps.google.com/?q=clinic+a" },
      { title: "Dentist", location: "Clinic B, 9 Oak Ave https://maps.google.com/?q=clinic+b" },
    ), 2);
  });
});

describe("producer → reconcile: the shared meeting-key shape and placeKey URL removal (M11, M12, M23)", () => {
  test("M11 Teams: an encoded and a decoded spelling of one thread, related titles, no physical place → one event", () => {
    expectCounts(relatedPair(
      { title: "X", location: "https://teams.microsoft.com/l/meetup-join/19%3Ameeting_x%40thread.v2/0?context=%7b%7d" },
      { title: "Ticket: X", location: "https://teams.live.com/l/meetup-join/19:meeting_x@thread.v2" },
    ), 1);
  });
  test("M12 zoomgov: two host variants of one /j/<digits> → one event", () => {
    expectCounts(relatedPair({ title: "X", location: "https://zoomgov.com/j/1612345678" }, { title: "Ticket: X", location: "https://agency.zoomgov.com/j/1612345678?pwd=x" }), 1);
  });
  test("M23 a full-width or entity-escaped URL followed by a place matches the plain place → one event", () => {
    for (const location of ["ＨＴＴＰＳ://maps.example.com/x Clinic North", "&#x68;ttps://maps.example.com/x Clinic North"]) {
      expectCounts(relatedPair({ title: "X", location }, { title: "Ticket: X", location: "Clinic North" }), 1);
    }
  });
});


describe("producerKeys: linear URL punctuation trimming on uncapped raw fields", () => {
  const url = "https://zoom.us/j/1";
  // Key-preservation check: the old quadratic regex also trims trailing-only runs quickly.
  test("100,000 trailing punctuation characters preserve the ordinary URL keys in under 500 ms", () => {
    const punctuation = ".,;:!?)]}".repeat(12_500);
    expect(punctuation.length).toBeGreaterThanOrEqual(100_000);
    for (const field of ["location", "notes"] as const) {
      const expected = producerKeys({ [field]: url });
      const input = { [field]: url + punctuation };
      const start = performance.now();
      const keys = producerKeys(input);
      const elapsed = performance.now() - start;
      expect(keys).toEqual(expected);
      expect(elapsed).toBeLessThan(500);
    }
  });
  // Quadratic-regression guard: an internal run forces the old trailing-punctuation regex to retry each position.
  test("100,000 internal punctuation characters remain part of the URL in under 500 ms", () => {
    const suffix = ".".repeat(100_000) + "x";
    const input = url + suffix;
    const linkKey = createHash("sha256").update("zoom.us/j/1" + suffix).digest("hex");
    for (const field of ["location", "notes"] as const) {
      const start = performance.now();
      const keys = producerKeys({ [field]: input });
      const elapsed = performance.now() - start;
      expect(keys).toEqual(field === "location" ? { linkKeys: [linkKey] } : {});
      expect(elapsed).toBeLessThan(500);
    }
  });
  test("ordinary sentence punctuation is trimmed and internal punctuation and HTML query escapes are preserved", () => {
    for (const field of ["location", "notes"] as const) {
      for (const punctuation of [".", ",", ";", ":", "!", "?", ")", "]", "}", ".,;:!?)]}"]) {
        expect(producerKeys({ [field]: url + punctuation })).toEqual(producerKeys({ [field]: url }));
      }
      expect(producerKeys({ [field]: url + "?pwd=a.b&amp;foo=x" })).toEqual(producerKeys({ [field]: url + "?pwd=a.b&foo=x" }));
    }
  });
});
