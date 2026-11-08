// test/fixtures/calendar/contract.ts — the CALENDAR CONTRACT FIXTURES (plan M0). ⚠ FROZEN: this is the
// contract M4's renderer must reproduce and W2's desktop mirror consumes. Change it only by a decision
// recorded with the hub, never to make a renderer pass.
//
// What lives here, and the files it pairs with:
//   • SECTION_SOURCES — the typed source of every variant in `rendered-section.txt`, which holds the exact
//     bytes each variant renders to (spec r4 §7). `readSectionFixture()` parses that file.
//   • LIST_EXAMPLE / TEST_EXAMPLE / STATUS_EXAMPLE — one example of each `calendar … --json` shape; the
//     `.json` files beside this one are these objects serialised (`JSON.stringify(x, null, 2) + "\n"`), for
//     consumers that do not read TypeScript. `test/calendar-contract.test.ts` holds the two in step.
//
// A plain module, not a `.test.ts` file — importing a test file re-registers its tests.
//
// ── THE LAYOUT RULES the text file follows (M4 implements them; the text file wins on any doubt) ─────────
//  1. Heading: `CALENDAR_HEADING`, plus `CALENDAR_INCOMPLETE_SUFFIX` when `calendar.incomplete`.
//  2. Every other line starts with `CALENDAR_LINE_PREFIX`. No blank line inside the section; the briefing's
//     usual blank line follows it. Placement in the page (after "Today so far", before "Suggested next")
//     is M4's, not this file's.
//  2a. With NO sources at all (calendar on, nothing configured on this machine): the heading, unsuffixed, and
//     `CALENDAR_NOT_CONNECTED_TEXT` — nothing else (the `no-sources` variant; hub decision 2026-10-09).
//  3. When EVERY source failed (no source is `ok` or `incomplete`): `CALENDAR_UNAVAILABLE_TEXT`, first.
//  4. Then one status line per source whose `status` is not `ok`, in `sources` order:
//     `<label>: <CALENDAR_STATUS_TEXT[status]>`, label = `CALENDAR_MACOS_LABEL` for the `macos` source, else
//     the link id. Notices (`helper-outdated`, `identity-unknown`) render nothing.
//  5. Then the events, in STRUCT order (the engine orders them: all-day first, then by start), at most
//     `CALENDAR_MAX_EVENT_LINES`, then `+N more` for the rest. With no events and not every source failed:
//     `CALENDAR_NO_EVENTS_TEXT`.
//  6. An event line is `<when><sep><what><marks>`:
//       what  = the title (`CALENDAR_UNTITLED_TEXT` when it is empty or blank), then ` (<location>)` if any.
//       marks = the key-c merge mark, as the struct's decided `merged` gives it (` · on <count> calendars` when its
//               mark is `calendars`, ` · <count> copies` when `copies`; none without `merged`), then ` · tentative`
//               when `status` is tentative, then ` · ended` when `ended` — in that order (calendar near-duplicates,
//               hub decision 2026-10-31: the merge mark goes before tentative and ended).
//       all-day: when = `all day`, sep = ` — ` (a multi-day all-day event reads the same).
//       unclear: when = `time unclear (<wallStart>–<wallEnd> <tzid>)`, sep = two spaces.
//       timed:   when = the span below, sep = two spaces. Times are HH:MM in the renderer's LOCAL zone;
//                "today" is the BriefingStruct's `date`.
//                start: today → `HH:MM`; yesterday → `since yesterday`; earlier → `since <Mon> <D>`.
//                end:   today → `HH:MM`; exactly the next midnight → `24:00`; tomorrow → `HH:MM tomorrow`;
//                       later → `<Mon> <D> HH:MM`.
//                joined by an en dash with no spaces (`09:00–09:30`) when the start is today and the end is
//                today or `24:00`, by ` → ` otherwise; a zero-length event (end = start) shows its start only.
//                Final harden r3: when the zone's UTC offset at the end differs from the start (a DST change
//                inside the span), the span is followed by ` (clocks go back)` or ` (clocks go forward)`
//                (`calendarClockChangeMark`) — so the repeated fall-back hour never reads backwards.
//     `<Mon>` is the English three-letter month and `<D>` the day without a leading zero (`Oct 12`).
//  Every line is control-stripped like every other rendered line (`stripControl`, src/render.ts).
//
// Every variant below was written for a renderer running in UTC — `bun test`'s default zone, which the
// suite runs under — and `generatedAt` is the instant the `ended` flags were decided against.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CalendarListJson, CalendarStatusJson, CalendarStruct, CalendarStructEvent, CalendarTestJson, CalDate,
} from "../../../src/calendar/types";

const HERE = import.meta.dir;

export const SECTION_FIXTURE_PATH = join(HERE, "rendered-section.txt");
export const LIST_JSON_PATH = join(HERE, "calendar-list.json");
export const TEST_JSON_PATH = join(HERE, "calendar-test.json");
export const STATUS_JSON_PATH = join(HERE, "calendar-status.json");

/** One variant: the inputs a renderer needs (the BriefingStruct's `date` and its `calendar`). */
export type CalendarSectionSource = {
  name: string;
  /** `BriefingStruct.date` — "today" for the span rules. */
  date: CalDate;
  /** The instant the engine decided `ended` against (documentation: the renderer never reads it). */
  generatedAt: string;
  calendar: CalendarStruct;
};

/** Epoch ms of a UTC wall time written `YYYY-MM-DDTHH:MM`. */
const utc = (isoMinute: string): number => Date.parse(`${isoMinute}:00Z`);

/** A timed event, defaults filled; only what a case varies is spelled out. */
const timed = (start: string, end: string, title: string, rest: Partial<CalendarStructEvent> = {}): CalendarStructEvent => ({
  time: { kind: "timed", startMs: utc(start), endMs: utc(end) },
  title, status: "confirmed", transparency: "busy", attendeeCount: 1, ...rest,
});

/** Every line kind but the overflow and the two whole-section states, on one incomplete day. */
const FULL_DAY: CalendarSectionSource = {
  name: "full-day",
  date: "2026-10-14",
  generatedAt: "2026-10-14T08:45:00.000Z",
  calendar: {
    events: [
      { time: { kind: "allDay", startDate: "2026-10-14", endDateExclusive: "2026-10-15" }, title: "Company offsite", location: "Lisbon", status: "confirmed", transparency: "busy", attendeeCount: 40 },
      { time: { kind: "allDay", startDate: "2026-10-12", endDateExclusive: "2026-10-17" }, title: "Conference week", status: "tentative", transparency: "free", attendeeCount: 0 },
      timed("2026-10-12T20:00", "2026-10-14T12:00", "On-call rotation", { attendeeCount: 2 }),
      timed("2026-10-13T22:00", "2026-10-14T02:00", "Overnight deploy watch", { attendeeCount: 3, ended: true }),
      timed("2026-10-14T07:30", "2026-10-14T07:45", "Gym check-in", { status: "tentative", ended: true }),
      timed("2026-10-14T08:00", "2026-10-14T08:30", "Breakfast with Sam", { location: "Café Nero", attendeeCount: 2, ended: true }),
      timed("2026-10-14T09:00", "2026-10-14T09:30", "Standup", { location: "Room 4", attendeeCount: 8 }),
      // A location that was a URL, after cleaning (spec §6: every URL becomes `<host> link`).
      timed("2026-10-14T11:00", "2026-10-14T12:00", "Design review", { location: "zoom.us link", status: "tentative", attendeeCount: 5 }),
      // Zero length: a date-time DTSTART with neither DTEND nor DURATION (spec §4.2).
      timed("2026-10-14T12:00", "2026-10-14T12:00", "Submit timesheet", { transparency: "free", attendeeCount: 0 }),
      // Its zone could not be resolved, so only the wall times are known; it marks `team` incomplete.
      { time: { kind: "unclear", startDate: "2026-10-14", endDate: "2026-10-14", wallStart: "14:00", wallEnd: "15:00", tzid: "Custom/Lunar Base" }, title: "Vendor sync", status: "confirmed", transparency: "busy", attendeeCount: 4 },
      timed("2026-10-14T15:00", "2026-10-14T15:30", "", { transparency: "free", attendeeCount: 0 }),
      timed("2026-10-14T22:00", "2026-10-16T18:00", "Hackathon", { attendeeCount: 30 }),
      timed("2026-10-14T23:00", "2026-10-15T01:00", "Release night", { attendeeCount: 6 }),
      timed("2026-10-14T23:30", "2026-10-15T00:00", "Late call with APAC", { attendeeCount: 3 }),
    ],
    sources: [
      { id: "macos", kind: "macos", status: "ok", notices: ["helper-outdated"] },
      { id: "home", kind: "link", status: "ok" },
      { id: "work", kind: "link", status: "link-refused" },
      { id: "team", kind: "link", status: "incomplete", notices: ["identity-unknown"] },
    ],
    incomplete: true,
  },
};

/** The overflow: 63 ten-minute slots, so 60 lines and `+3 more`. */
const BUSY_DAY: CalendarSectionSource = {
  name: "busy-day",
  date: "2026-10-14",
  generatedAt: "2026-10-14T07:00:00.000Z",
  calendar: {
    events: Array.from({ length: 63 }, (_, i): CalendarStructEvent => ({
      time: { kind: "timed", startMs: utc("2026-10-14T08:00") + i * 600_000, endMs: utc("2026-10-14T08:10") + i * 600_000 },
      title: `Interview slot ${String(i + 1).padStart(2, "0")}`, status: "confirmed", transparency: "busy", attendeeCount: 2,
    })),
    sources: [{ id: "work", kind: "link", status: "ok" }],
    incomplete: false,
  },
};

/** Every source failed. */
const UNAVAILABLE: CalendarSectionSource = {
  name: "unavailable",
  date: "2026-10-14",
  generatedAt: "2026-10-14T08:45:00.000Z",
  calendar: {
    events: [],
    sources: [
      { id: "macos", kind: "macos", status: "not-granted" },
      { id: "work", kind: "link", status: "timeout" },
    ],
    incomplete: true,
  },
};

/** Read in full; nothing today. */
const QUIET: CalendarSectionSource = {
  name: "quiet",
  date: "2026-10-14",
  generatedAt: "2026-10-14T08:45:00.000Z",
  calendar: { events: [], sources: [{ id: "home", kind: "link", status: "ok" }], incomplete: false },
};

/** Calendar on, but no source configured on this machine (spec §7; hub decision 2026-10-09, the M4 brief): the
 *  heading with no suffix and one line. The prompt carries no calendar block in this case (M4's step). */
const NO_SOURCES: CalendarSectionSource = {
  name: "no-sources",
  date: "2026-10-14",
  generatedAt: "2026-10-14T08:45:00.000Z",
  calendar: { events: [], sources: [], incomplete: false },
};

/** A key-c near-duplicate merge (calendar near-duplicates, hub decision 2026-10-31): one timed line whose merge mark
 *  sits before ` · tentative`, so rule 6's mark order is frozen. */
const MERGED: CalendarSectionSource = {
  name: "merged",
  date: "2026-10-14",
  generatedAt: "2026-10-14T08:45:00.000Z",
  calendar: {
    events: [
      timed("2026-10-14T14:00", "2026-10-14T22:00", "Ticket: X", { location: "Polk St", status: "tentative", attendeeCount: 2, merged: { mark: "calendars", count: 2 } }),
    ],
    sources: [
      { id: "macos", kind: "macos", status: "ok" },
      { id: "home", kind: "link", status: "ok" },
    ],
    incomplete: false,
  },
};

export const SECTION_SOURCES: readonly CalendarSectionSource[] = [FULL_DAY, BUSY_DAY, UNAVAILABLE, QUIET, NO_SOURCES, MERGED];

/** `rendered-section.txt`, parsed: variant name → its lines (heading first). The format: `#` comment lines
 *  before the first variant; each variant opens with `@@ <name>` and runs to the next blank line. */
export function readSectionFixture(text: string = readFileSync(SECTION_FIXTURE_PATH, "utf8")): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@ ")) {
      const name = line.slice(3);
      if (out.has(name)) throw new Error(`rendered-section.txt: variant "${name}" appears twice`);
      current = [];
      out.set(name, current);
    } else if (line === "") {
      current = null;
    } else if (current) {
      current.push(line);
    } else if (!line.startsWith("#")) {
      throw new Error(`rendered-section.txt: a line outside any variant: ${JSON.stringify(line)}`);
    }
  }
  return out;
}

// ── the `calendar … --json` examples ──────────────────────────────────────────────────────────────

export const LIST_EXAMPLE: CalendarListJson = {
  schemaVersion: 1,
  macos: {
    status: "ok",
    notices: ["helper-outdated"],
    calendars: [
      { id: "3F2504E0-4F89-41D3-9A0C-0305E82C3301", title: "Home", account: "iCloud", editable: true, type: "standard", selected: true },
      { id: "6BA7B810-9DAD-41D1-80B4-00C04FD430C8", title: "Work", account: "me@work.example", editable: true, type: "standard", selected: true },
      { id: "9C4F1D2A-7E3B-4A5C-8D6E-1F2A3B4C5D6E", title: "US Holidays", account: "Subscribed Calendars", editable: false, type: "subscribed", selected: false },
      { id: "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D", title: "Birthdays", account: "Other", editable: false, type: "birthdays", selected: false },
    ],
  },
  links: [
    { id: "home", name: "Home (Google)", urlPathOwner: "me@example.com", confirmedOwner: "me@example.com", urlFrom: "file", fileStatus: "ok" },
    { id: "work", name: "Work (Outlook)", configuredOwner: "me@work.example", confirmedOwner: null, urlFrom: "command" },
    { id: "team", confirmedOwner: null, urlFrom: "env" },
    { id: "trip", name: "Trip", confirmedOwner: null, urlFrom: "file", fileStatus: "refused", fileReason: "file-permissions" },
    { id: "lost", confirmedOwner: null, urlFrom: "file", fileStatus: "failed", fileReason: "read-error" },
  ],
};

export const TEST_EXAMPLE: CalendarTestJson = {
  schemaVersion: 1,
  ranAt: "2026-10-14T08:45:03.120Z",
  sources: [
    { id: "macos", kind: "macos", status: "ok", notices: ["helper-outdated"], eventsToday: 6, durationMs: 1840 },
    { id: "home", kind: "link", status: "ok", eventsToday: 3, durationMs: 412 },
    { id: "work", kind: "link", status: "link-refused", eventsToday: null, durationMs: 230, reason: "http-refused" },
    { id: "team", kind: "link", status: "incomplete", notices: ["identity-unknown"], eventsToday: 2, durationMs: 9_870, reason: "unclear-time" },
  ],
  incomplete: true,
};

export const STATUS_EXAMPLE: CalendarStatusJson = {
  schemaVersion: 1,
  enabled: true,
  enabledSet: true,
  macSupported: true,
  configWarnings: [],
  sources: [
    { id: "macos", kind: "macos", lastScheduledRead: { at: "2026-10-14T07:21:09.000Z", status: "ok", notices: ["helper-outdated"] } },
    { id: "home", kind: "link", name: "Home (Google)", lastScheduledRead: { at: "2026-10-14T07:21:09.000Z", status: "ok" } },
    { id: "work", kind: "link", name: "Work (Outlook)", lastScheduledRead: { at: "2026-10-14T07:21:09.000Z", status: "link-refused", reason: "http-refused" } },
    { id: "team", kind: "link", lastScheduledRead: null },
  ],
};
