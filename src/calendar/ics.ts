// src/calendar/ics.ts — ONE private calendar link's feed, parsed (v0.3.0 plan M2c; spec r4 §4.2 "Parse", "Time
// zones", "Expansion", "Identity", §5 the model, §3 the limits).
//
// Runs ONLY inside the `calendar-parse` child (`./parse-job.ts`), under the parent's hard deadline. Pure: no I/O,
// no clock, no environment (the run date, the parent's zone and the identity are inputs), never throws. The
// recurrence engine is the vendored ical.js — `Recur` + its iterator, handed in by the caller, which loads it by
// dynamic import — so this module names no vendored path.
//
// THE PASSES
//   1. TEXT PASS. Unfold the lines, track components with an explicit stack (any nesting depth, linear), and keep:
//      the calendar's own properties (X-WR-TIMEZONE), every VTIMEZONE, and every VEVENT directly inside a
//      VCALENDAR as its raw lines — properties of sub-components (VALARM, or anything hostile nested deeper) are
//      dropped here, so nothing downstream ever sees nesting. One content-line reader serves BOTH the index and the
//      events, so a UID or RECURRENCE-ID is spelled identically in both (load-bearing: key a, and the supersede).
//   2. ZONES. Every VTIMEZONE is registered (by TZID) before anything is resolved. A TZID resolves to: its
//      VTIMEZONE; else an IANA name `Intl` knows; else a common Windows name through `WINDOWS_ZONES`; else nothing
//      — an UNCLEAR-time event (`CalUnclear`, flagged). Floating times use X-WR-TIMEZONE when it resolves, else
//      the parent's zone. A wall time is placed per RFC 5545 §3.3.5: an ambiguous one (DST ends) is its FIRST
//      occurrence; a missing one (DST starts) is read with the offset before the gap.
//   3. INDEX + PRE-FILTER, per block. The UID index (`CalUidIndexEntry`) of EVERY block with a UID — the blocks
//      the pre-filter drops are exactly the ones it exists for (types.ts) — with `recurs: true` for a block that
//      carries RRULE or RDATE (a series master never supersedes, M3a checkpoint). The pre-filter keeps a block
//      that has RRULE, RDATE or RECURRENCE-ID, or whose start is no later than the reconcile window's end and whose
//      end (DTEND, else DTSTART + DURATION, else DTSTART) is no earlier than its start, read CHEAPLY: wall times
//      as if UTC, widened by `PREFILTER_SLACK_MS` on both sides unless both ends are UTC (`Z`) — so no zone offset
//      can drop a block that overlaps. A block whose dates cannot be read cheaply is kept.
//   4. EXPANSION, per kept block, into occurrences overlapping the reconcile window (today ± 2 days in the
//      parent's zone): RRULE (ical.js, iterated in WALL time so a 09:00 meeting stays 09:00 across DST), RDATE
//      (incl. PERIOD), EXDATE, DURATION, a missing DTEND (date: one day; date-time: zero length), RECURRENCE-ID
//      overrides (the master's occurrence is removed whether the override moved into, out of, or far from the
//      window; the override is an event of its own when it overlaps), STATUS:CANCELLED kept as a tombstone.
//      ≤ `CAL_EXPANSION_STEP_CAP` steps per event — a step is one candidate the iterator generates (its
//      `next_<freq>` calls) or one RDATE value — so a rule that never matches cannot spin; a capped or unsupported
//      event is flagged. A long-running open-ended series (no COUNT) is RE-ANCHORED close to the window first, so a
//      daily standup since 2018 costs a handful of steps, not 3,000: the anchor moves by whole periods of its own
//      interval, which keeps every later occurrence (proved against the un-anchored expansion in the tests).
//   5. IDENTITY + CLEANING. `selfStatus` from your ATTENDEE PARTSTAT (a decline anywhere wins), else ORGANIZER equal
//      to the confirmed Google URL-path owner (`identity.verifiedOrganizer`), else unknown; no self address at all
//      (identity-unknown) leaves every event `unknown` — not accepted. `organizerVerified` is that same trusted
//      signal, RAW: gate G6 is applied downstream, in reconcile step 0 and again at the prompt boundary (both read
//      `CALENDAR_G6_PASSED`, shipped off), so nothing here is ever shown as verified while G6 is off. Every event is
//      CLEANED (`cleanCalEvent`) here, before it leaves the child — see `./parse-job.ts` for why the child.
//
// LIMITS (spec §3 and the answer's size): at most `maxEvents` (≤ 5,000) events; their serialised bytes at most
// `CAL_EVENTS_BUDGET_BYTES`, the index's at most `CAL_INDEX_BUDGET_BYTES`; at most `CAL_ATTENDEES_MAX` attendees
// kept per event (your own answer is read from all of them first). Hitting any of them flags the source incomplete.
//
// THE DETAILS PATH (redesign C, wave-2 plan C-M1-T2): `parseIcsDetails` is the same parse, plus each occurrence that
// overlaps the RUN DATE (local, the parent's zone) carries `details` — the RAW, pre-clean URL tier, location,
// description and people (`CalRawDetails`, ./types.ts), each capped in Unicode scalars at the Mac reader's figures,
// and all of them within `CAL_DETAILS_BUDGET_BYTES` in the occurrences' start order (past it, later occurrences carry
// none and the answer says `detailsCapped`). The cleaned fields beside them, the index and the flags are the
// morning's, unchanged; `parseIcsFeed` never sets `details`.
import { createHash } from "node:crypto";
import { cleanCalEvent, cleanCalendarText, cleanEmail } from "./clean";
import { producerKeys } from "./join";
import { addDays, collapseIndexEntry, indexEntryKey } from "./reconcile";
import type { CalAttendeeStatus, CalDate, CalEvent, CalRawDetails, CalSelfStatus, CalTime, CalUidIndexEntry } from "./types";

// ── limits ───────────────────────────────────────────────────────────────────────────────────────────

/** Spec §3: "5,000 parsed events in total" — the most one feed may contribute (the parent may ask for fewer). */
export const CAL_PARSE_MAX_EVENTS = 5_000;
/** Spec §4.2: "At most 1,000 expansion steps per event". */
export const CAL_EXPANSION_STEP_CAP = 1_000;
/** Fix-round 1: at most this many occurrences of ONE series master per day of the reconcile window (the parent's
 *  local date). One `RRULE:FREQ=MINUTELY` invite otherwise put hundreds of occurrences into today, pushed real
 *  meetings out of the section and made the BUSY line all-day. 48 = every half hour; hitting it flags the source
 *  incomplete (`expansion-capped`). */
export const CAL_OCCURRENCES_PER_DAY_CAP = 48;
/** Attendees kept per event in the answer. Only "(N people)" reads the count, which saturates here. */
export const CAL_ATTENDEES_MAX = 200;
/** A longer UID is replaced by `sha256:<hex>` — the same in the index and the events, so keys still match. */
export const CAL_UID_MAX = 512;
/** The answer's two budgets, in serialised UTF-8 bytes. `CALENDAR_PARSE_MAX_OUTPUT_BYTES` is their sum plus room
 *  for the envelope (`./parse-runner.ts`), so a child that keeps to them is never killed for its output. */
export const CAL_EVENTS_BUDGET_BYTES = 6 * 1024 * 1024;
export const CAL_INDEX_BUDGET_BYTES = 4 * 1024 * 1024;
/** The details path's own budget (redesign C): the serialised bytes of every occurrence's `details`, counted in start
 *  order. `CALENDAR_DETAILS_MAX_OUTPUT_BYTES` (./parse-runner.ts) is the morning's cap plus this. */
export const CAL_DETAILS_BUDGET_BYTES = 2 * 1024 * 1024;
/** The raw details' caps, in Unicode scalars: the Mac reader's own (`capped`, reader/Sources/Store.swift; the URL and
 *  the location 1 000 and the notes 4 000, `eventRecord`, ModeRead.swift; a participant's name 200, `participant`). */
export const CAL_DETAILS_URL_MAX = 1_000;
export const CAL_DETAILS_LOCATION_MAX = 1_000;
export const CAL_DETAILS_NOTES_MAX = 4_000;
export const CAL_DETAILS_NAME_MAX = 200;

/** Why a source is only partly read (each a fixed code; the source's status becomes `incomplete`). */
export type CalParseIncomplete =
  | "unclear-time"       // an event in the window whose TZID resolves to no zone (spec §4.2)
  | "expansion-capped"   // an event hit CAL_EXPANSION_STEP_CAP, or CAL_OCCURRENCES_PER_DAY_CAP on some day
  | "unsupported"        // a recurrence construct this parser does not handle (bad RRULE, RSCALE, RANGE=THISANDFUTURE)
  | "malformed-event"    // a VEVENT with no readable DTSTART, or one left unclosed inside its calendar
  | "event-cap"          // more than maxEvents events
  | "output-cap"         // the events' byte budget
  | "index-capped"       // the index's byte budget
  | "truncated";         // the feed ended inside a component

export const CAL_PARSE_INCOMPLETE: readonly CalParseIncomplete[] = [
  "unclear-time", "expansion-capped", "unsupported", "malformed-event", "event-cap", "output-cap", "index-capped", "truncated",
];

/** Who "you" are for this link, decided by the PARENT (`./link-parse.ts`), which alone sees the URL: `self` = the
 *  Google URL-path owner (a personal address), the configured `owner`, and `calendar.emails`, cleaned and
 *  lower-cased; `verifiedOrganizer` = the URL-path owner when the user confirmed it (`confirmedOwner` equal to
 *  it) on a Google link — the only address whose ORGANIZER line counts. */
export type CalLinkIdentity = { self: string[]; verifiedOrganizer?: string };

/** An event as the child sends it: a `CalEvent` without `sources` and `provenance`, which the parent adds (it
 *  knows the link id; reconcile rebuilds provenance anyway), and without the key-c results `viewDetails` and
 *  `nearDuplicate`, which only reconcile sets (near-duplicates spec §4: of the new fields, only the three producer
 *  keys cross the wire). */
export type CalWireEvent = Omit<CalEvent, "sources" | "provenance" | "viewDetails" | "nearDuplicate">;
/** An event of a details answer: the same wire event, `details` set on a run-date occurrence (within the budget). */
export type CalDetailsWireEvent = CalWireEvent & { details?: CalRawDetails };

export type IcsParseInput = {
  ics: string;
  /** The link id (`CalSourceRef.id` and `calendarId`). */
  sourceId: string;
  /** The run's local date in the PARENT's zone. */
  runDate: CalDate;
  /** The parent's IANA zone: "local" for dates, floating times and the reconcile window. */
  zone: string;
  identity: CalLinkIdentity;
  /** ≤ CAL_PARSE_MAX_EVENTS. */
  maxEvents: number;
};

export type IcsParseResult =
  | { ok: true; events: CalWireEvent[]; index: CalUidIndexEntry[]; incomplete: CalParseIncomplete[] }
  | { ok: false; error: "parse-error" };

export type IcsDetailsResult =
  | { ok: true; events: CalDetailsWireEvent[]; index: CalUidIndexEntry[]; incomplete: CalParseIncomplete[]; detailsCapped?: true }
  | { ok: false; error: "parse-error" };

/** TEST-ONLY knobs. Production passes none. */
export type IcsParseKnobs = { stepCap?: number; reanchor?: boolean };

// ── the slice of ical.js this module drives ─────────────────────────────────────────────────────────

/** ical.js 2.2.1's `Recur`/`Time` as used here (structural, so this module needs no type import of the vendored
 *  file; `./vendor/ical.d.ts` declares the same surface for the loader). */
export type IcalRecurLib = {
  Recur: { fromString(rule: string): IcalRecur };
  Time: new (data: { year: number; month: number; day: number; hour: number; minute: number; second: number; isDate: boolean }) => IcalTime;
};
type IcalTime = { year: number; month: number; day: number; hour: number; minute: number; second: number; isDate: boolean };
type IcalRecur = { until: IcalTime | null; iterator(start: IcalTime): { next(): IcalTime | null } };

// ── dates and walls ──────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** The pre-filter's widening for wall times read as if UTC: more than any zone offset (±14 h) plus a DST hour. */
const PREFILTER_SLACK_MS = 2 * DAY_MS;

/** A wall-clock date-time, no zone. `isDate` for a date-only value (time fields 0). */
type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number; isDate: boolean };

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
const dateOf = (w: Pick<Wall, "y" | "mo" | "d">): CalDate => `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}`;
/** The wall time read as if it were UTC — for ordering and arithmetic in wall time, never an instant. */
const wallMs = (w: Wall): number => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
function fromWallMs(ms: number, isDate: boolean): Wall {
  const t = new Date(ms);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: isDate ? 0 : t.getUTCHours(), mi: isDate ? 0 : t.getUTCMinutes(), s: isDate ? 0 : t.getUTCSeconds(), isDate };
}
const hhmm = (w: Wall): string => `${pad(w.h)}:${pad(w.mi)}`;
function validDate(y: number, mo: number, d: number): boolean {
  if (y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
const dateMs = (date: CalDate): number => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));

const DATE_VALUE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATETIME_VALUE_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

/** A DATE or DATE-TIME value, or null. `utc` when it ends in `Z`. A leap second (`60`) reads as `59`. */
function readValue(v: string, wantDate: boolean | undefined): { wall: Wall; utc: boolean } | null {
  const t = v.trim();
  let m = DATE_VALUE_RE.exec(t);
  if (m && wantDate !== false) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    return validDate(y, mo, d) ? { wall: { y, mo, d, h: 0, mi: 0, s: 0, isDate: true }, utc: false } : null;
  }
  m = DATETIME_VALUE_RE.exec(t);
  if (!m || wantDate === true) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(m[4]), mi = Number(m[5]), s = Number(m[6]);
  if (!validDate(y, mo, d) || h > 23 || mi > 59 || s > 60) return null;
  return { wall: { y, mo, d, h, mi, s: Math.min(s, 59), isDate: false }, utc: m[7] === "Z" };
}

/** RFC 5545 DURATION: nominal days (weeks × 7 + days, added in wall time) and exact seconds. */
type Dur = { days: number; secs: number };
const DURATION_RE = /^([+-])?P(?:(\d{1,6})W|(?:(\d{1,6})D)?(?:T(?:(\d{1,7})H)?(?:(\d{1,9})M)?(?:(\d{1,10})S)?)?)$/;
function readDuration(v: string): Dur | null {
  const m = DURATION_RE.exec(v.trim());
  if (!m || (m[2] === undefined && m[3] === undefined && m[4] === undefined && m[5] === undefined && m[6] === undefined)) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const days = (m[2] !== undefined ? Number(m[2]) * 7 : 0) + (m[3] !== undefined ? Number(m[3]) : 0);
  const secs = (m[4] !== undefined ? Number(m[4]) * 3600 : 0) + (m[5] !== undefined ? Number(m[5]) * 60 : 0) + (m[6] !== undefined ? Number(m[6]) : 0);
  // A negative duration is meaningless for an event; it reads as none (zero length / one day).
  return sign < 0 ? { days: 0, secs: 0 } : { days, secs };
}

// ── zones ────────────────────────────────────────────────────────────────────────────────────────────

/** A zone: its UTC offset (ms, east positive) at an instant. */
type Zone = { offsetAt(utcMs: number): number };

const UTC_ZONE: Zone = { offsetAt: () => 0 };

/** Offsets outside these instants are read at the nearest end: 1900 and 2200 bound every rule anyone schedules by. */
const OFFSET_MIN_MS = Date.UTC(1900, 0, 1), OFFSET_MAX_MS = Date.UTC(2200, 0, 1);

const ianaCache = new Map<string, Zone | null>();
/** An IANA zone through `Intl`, or null when this runtime does not know the name. Offsets are cached per UTC day
 *  (a day whose two ends share an offset uses it throughout; a transition day is computed exactly). */
function ianaZone(name: string): Zone | null {
  if (ianaCache.has(name)) return ianaCache.get(name)!;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: name, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
  } catch { ianaCache.set(name, null); return null; }
  const exact = (ms: number): number => {
    const t = Math.min(Math.max(ms, OFFSET_MIN_MS), OFFSET_MAX_MS);
    const whole = Math.floor(t / 1000) * 1000;
    const p: Record<string, number> = {};
    for (const part of fmt.formatToParts(new Date(whole))) if (part.type !== "literal") p[part.type] = Number(part.value);
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!) - whole;
  };
  const days = new Map<number, number | null>();
  const zone: Zone = {
    offsetAt(ms) {
      const day = Math.floor(ms / DAY_MS);
      let o = days.get(day);
      if (o === undefined) {
        const a = exact(day * DAY_MS), b = exact((day + 1) * DAY_MS - 1);
        o = a === b ? a : null;
        if (days.size > 50_000) days.clear();
        days.set(day, o);
      }
      return o ?? exact(ms);
    },
  };
  ianaCache.set(name, zone);
  return zone;
}

/** Common Windows zone names (Outlook, Exchange) → IANA. Small and fixed (spec §4.2); anything else is unclear. */
export const WINDOWS_ZONES: Readonly<Record<string, string>> = Object.freeze({
  "Dateline Standard Time": "Etc/GMT+12",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Alaskan Standard Time": "America/Anchorage",
  "Pacific Standard Time": "America/Los_Angeles",
  "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time": "America/Denver",
  "Central Standard Time": "America/Chicago",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Central America Standard Time": "America/Guatemala",
  "Eastern Standard Time": "America/New_York",
  "SA Pacific Standard Time": "America/Bogota",
  "Atlantic Standard Time": "America/Halifax",
  "Newfoundland Standard Time": "America/St_Johns",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Argentina/Buenos_Aires",
  "Pacific SA Standard Time": "America/Santiago",
  "UTC": "Etc/UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "GTB Standard Time": "Europe/Bucharest",
  "FLE Standard Time": "Europe/Kyiv",
  "E. Europe Standard Time": "Europe/Chisinau",
  "Russian Standard Time": "Europe/Moscow",
  "Turkey Standard Time": "Europe/Istanbul",
  "Israel Standard Time": "Asia/Jerusalem",
  "Egypt Standard Time": "Africa/Cairo",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Arabian Standard Time": "Asia/Dubai",
  "Pakistan Standard Time": "Asia/Karachi",
  "India Standard Time": "Asia/Kolkata",
  "SE Asia Standard Time": "Asia/Bangkok",
  "China Standard Time": "Asia/Shanghai",
  "Singapore Standard Time": "Asia/Singapore",
  "Taipei Standard Time": "Asia/Taipei",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "E. Australia Standard Time": "Australia/Brisbane",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "W. Australia Standard Time": "Australia/Perth",
  "New Zealand Standard Time": "Pacific/Auckland",
});

/** Place a wall time in a zone (RFC 5545 §3.3.5): an ambiguous wall time is its FIRST instant; a missing one
 *  (inside a DST gap) is read with the offset in effect before the gap. */
function wallToUtc(w: Wall, zone: Zone): number {
  const t = wallMs(w);
  let best: number | undefined;
  for (const o of new Set([zone.offsetAt(t - DAY_MS), zone.offsetAt(t), zone.offsetAt(t + DAY_MS)])) {
    const u = t - o;
    if (zone.offsetAt(u) === o && (best === undefined || u < best)) best = u;
  }
  return best ?? t - zone.offsetAt(t - DAY_MS);
}

/** The wall time an instant shows in a zone. */
const utcToWall = (ms: number, zone: Zone): Wall => fromWallMs(ms + zone.offsetAt(ms), false);

// ── content lines ────────────────────────────────────────────────────────────────────────────────────

type Prop = { name: string; params: Record<string, string[]>; value: string };

/** Unfolded logical lines (RFC 5545 §3.1: a line starting with a space or a tab continues the previous one), one at a
 *  time — the text is never split into an array of every physical line (on a 16 MB feed that array alone was ~100 MB
 *  of peak memory, G5). A run of continuations is joined once, so a line folded a million times is still linear. */
function* unfold(text: string): Generator<string> {
  let parts: string[] | null = null;
  let i = 0;
  const n = text.length;
  while (i <= n) {
    let j = i;
    while (j < n) { const c = text.charCodeAt(j); if (c === 10 || c === 13) break; j++; }
    const l = text.slice(i, j);
    i = j + (text.charCodeAt(j) === 13 && text.charCodeAt(j + 1) === 10 ? 2 : 1);
    const c0 = l.charCodeAt(0);
    if ((c0 === 32 || c0 === 9) && parts !== null) { parts.push(l.slice(1)); continue; }
    if (parts !== null) yield parts.length === 1 ? parts[0]! : parts.join("");
    parts = [l];
  }
  if (parts !== null) yield parts.length === 1 ? parts[0]! : parts.join("");
}

const NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

/** A line's property name, upper-cased (`""` when it has none): cheap — it scans at most 65 characters. */
function propName(line: string): string {
  const n = Math.min(line.length, 65);
  for (let i = 0; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c === 59 /* ; */ || c === 58 /* : */) return NAME_RE.test(line.slice(0, i)) ? line.slice(0, i).toUpperCase() : "";
  }
  return "";
}

/** RFC 6868 parameter-value escapes: `^n` newline, `^'` double quote, `^^` caret. */
const caret = (s: string): string => (s.includes("^") ? s.replace(/\^([n'^])/g, (_m, c: string) => (c === "n" ? "\n" : c === "'" ? '"' : "^")) : s);

/** One content line — `NAME;PARAM=a,"b;c":value` — or null when it is not one. Linear: one scan, quotes honoured. */
function parseLine(line: string): Prop | null {
  const name = propName(line);
  if (name === "") return null;
  const params: Record<string, string[]> = Object.create(null);
  let i = name.length;
  while (i < line.length && line.charCodeAt(i) === 59 /* ; */) {
    const eq = line.indexOf("=", i + 1);
    if (eq === -1) return null;
    const pname = line.slice(i + 1, eq).toUpperCase();
    const values: string[] = [];
    i = eq + 1;
    for (;;) {
      let v: string;
      if (line.charCodeAt(i) === 34 /* " */) {
        const close = line.indexOf('"', i + 1);
        if (close === -1) return null;
        v = line.slice(i + 1, close);
        i = close + 1;
      } else {
        let j = i;
        while (j < line.length) { const c = line.charCodeAt(j); if (c === 59 || c === 58 || c === 44) break; j++; }
        v = line.slice(i, j);
        i = j;
      }
      values.push(caret(v));
      if (line.charCodeAt(i) === 44 /* , */) { i++; continue; }
      break;
    }
    if (NAME_RE.test(pname)) params[pname] = values;
  }
  if (line.charCodeAt(i) !== 58 /* : */) return null;
  return { name, params, value: line.slice(i + 1) };
}

/** TEXT unescaping (RFC 5545 §3.3.11). */
const unescapeText = (v: string): string => (v.includes("\\") ? v.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c)) : v);

const param = (p: Prop, name: string): string | undefined => p.params[name]?.[0];

// ── the text pass ────────────────────────────────────────────────────────────────────────────────────

type TzSub = { props: Prop[] };
type TzBlock = { tzid?: string; subs: TzSub[] };
type Block = { lines: string[] };

type Scan = { calendars: number; calProps: Prop[]; tzs: TzBlock[]; blocks: Block[]; truncated: boolean; dropped: number };

/** Components by an explicit stack (no recursion; `open` counts make an `END` lookup O(1), and every pop matches
 *  a push, so the pass is linear at any depth). A component closed by an outer `END` (its own never came) is
 *  dropped and counted; the feed ending inside a component sets `truncated`. */
function scan(text: string): Scan {
  const out: Scan = { calendars: 0, calProps: [], tzs: [], blocks: [], truncated: false, dropped: 0 };
  const stack: string[] = [];
  const open = new Map<string, number>();
  let block: Block | null = null, tz: TzBlock | null = null, sub: TzSub | null = null;
  const pop = (): void => {
    const name = stack.pop()!;
    open.set(name, open.get(name)! - 1);
    const depth = stack.length;   // after the pop
    if (depth === 1 && name === "VEVENT" && block) block = null;
    if (depth === 1 && name === "VTIMEZONE" && tz) tz = null;
    if (depth === 2 && (name === "STANDARD" || name === "DAYLIGHT") && sub) sub = null;
  };
  for (const line of unfold(text)) {
    const name = propName(line);
    if (name === "BEGIN" || name === "END") {
      const comp = line.slice(line.indexOf(":") + 1).trim().toUpperCase();
      if (comp === "") continue;
      if (name === "BEGIN") {
        stack.push(comp);
        open.set(comp, (open.get(comp) ?? 0) + 1);
        const d = stack.length;
        if (d === 1 && comp === "VCALENDAR") out.calendars++;
        if (d === 2 && stack[0] === "VCALENDAR" && comp === "VEVENT") { block = { lines: [] }; }
        if (d === 2 && stack[0] === "VCALENDAR" && comp === "VTIMEZONE") { tz = { subs: [] }; }
        if (d === 3 && tz && (comp === "STANDARD" || comp === "DAYLIGHT")) { sub = { props: [] }; tz.subs.push(sub); }
        continue;
      }
      if (!(open.get(comp)! > 0)) continue;   // a stray END closes nothing
      while (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        if (top === comp) {
          if (stack.length === 2 && comp === "VEVENT" && block) out.blocks.push(block);
          if (stack.length === 2 && comp === "VTIMEZONE" && tz) out.tzs.push(tz);
          pop();
          break;
        }
        // An inner component closed by an outer END: its own END never came.
        if (stack.length === 2 && (top === "VEVENT" || top === "VTIMEZONE")) out.dropped++;
        pop();
      }
      continue;
    }
    const d = stack.length;
    if (d === 2 && block && stack[1] === "VEVENT") block.lines.push(line);
    else if (d === 1 && stack[0] === "VCALENDAR") { const p = parseLine(line); if (p) out.calProps.push(p); }
    else if (d === 2 && tz && stack[1] === "VTIMEZONE" && name === "TZID") { const p = parseLine(line); if (p) tz.tzid = unescapeText(p.value).trim(); }
    else if (d === 3 && sub) { const p = parseLine(line); if (p) sub.props.push(p); }
  }
  if (stack.length > 0) out.truncated = true;
  return out;
}

// ── VTIMEZONE ────────────────────────────────────────────────────────────────────────────────────────

const TZOFFSET_RE = /^([+-])(\d{2})(\d{2})(\d{2})?$/;
function readTzOffset(v: string | undefined): number | null {
  const m = v === undefined ? null : TZOFFSET_RE.exec(v.trim());
  if (!m) return null;
  const ms = ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4] ?? 0)) * 1000;
  return ms > 18 * 3600_000 ? null : (m[1] === "-" ? -ms : ms);
}

const ONSETS_MAX = 50_000;
const TZ_LAST_YEAR = 2100;

/** A VTIMEZONE as a zone, or null when it is unusable: a sub-component without DTSTART or offsets, an RRULE that is
 *  not FREQ=YEARLY (a real zone never needs one, and a SECONDLY rule would make every lookup spin), a rule that hits
 *  the step cap, or more than ONSETS_MAX transitions. Onsets are UTC instants (wall − TZOFFSETFROM), sorted; the
 *  offset at an instant is the last onset's TZOFFSETTO (before the first: its TZOFFSETFROM). */
function vtimezoneZone(lib: IcalRecurLib, tz: TzBlock): Zone | null {
  const onsets: { at: number; to: number; from: number }[] = [];
  for (const s of tz.subs) {
    const get = (n: string) => s.props.find((p) => p.name === n);
    const from = readTzOffset(get("TZOFFSETFROM")?.value), to = readTzOffset(get("TZOFFSETTO")?.value);
    const start = get("DTSTART") ? readValue(get("DTSTART")!.value, false) : null;
    if (from === null || to === null || start === null) return null;
    const push = (w: Wall, utc: boolean): void => { onsets.push({ at: utc ? wallMs(w) : wallMs(w) - from, to, from }); };
    const rrules = s.props.filter((p) => p.name === "RRULE");
    const rdates = s.props.filter((p) => p.name === "RDATE");
    push(start.wall, start.utc);   // the sub-component's first onset (its RRULE's iterator yields it again: harmless)
    for (const r of rdates) for (const v of r.value.split(",")) { const x = readValue(v, false); if (x) push(x.wall, x.utc); }
    for (const r of rrules) {
      const rule = readRule(r.value);
      if (!rule || rule.parts.get("FREQ") !== "YEARLY") return null;
      let until: Wall | undefined;
      const u = rule.until === undefined ? undefined : readValue(rule.until, undefined);
      if (rule.until !== undefined && !u) return null;
      if (u) until = u.utc ? fromWallMs(wallMs(u.wall) + from, false) : u.wall;
      const res = iterate(lib, buildRule(rule.parts), start.wall, until, Date.UTC(TZ_LAST_YEAR, 11, 31), CAL_EXPANSION_STEP_CAP, (w) => push(w, false));
      if (res !== "done") return null;
      if (onsets.length > ONSETS_MAX) return null;
    }
  }
  if (onsets.length === 0) return null;
  onsets.sort((a, b) => a.at - b.at);
  const first = onsets[0]!;
  return {
    offsetAt(ms) {
      let lo = 0, hi = onsets.length - 1, idx = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (onsets[mid]!.at <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
      return idx === -1 ? first.from : onsets[idx]!.to;
    },
  };
}

// ── RRULE ────────────────────────────────────────────────────────────────────────────────────────────

const RULE_PARTS = new Set(["FREQ", "UNTIL", "COUNT", "INTERVAL", "BYSECOND", "BYMINUTE", "BYHOUR", "BYDAY", "BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYMONTH", "BYSETPOS", "WKST"]);
const FREQS = new Set(["SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const PART_VALUE_RE = /^[A-Z0-9,+\-]{1,512}$/;

/** An RRULE's parts (UNTIL kept apart: it is re-read in the event's own zone), or null for anything this parser
 *  does not run — an unknown part (RFC 7529's RSCALE/SKIP included), a repeated part, a bad FREQ. */
function readRule(value: string): { parts: Map<string, string>; until?: string } | null {
  const parts = new Map<string, string>();
  let until: string | undefined;
  for (const raw of value.trim().split(";")) {
    if (raw === "") continue;
    const eq = raw.indexOf("=");
    if (eq <= 0) return null;
    const k = raw.slice(0, eq).toUpperCase(), v = raw.slice(eq + 1).toUpperCase();
    if (!RULE_PARTS.has(k) || parts.has(k) || (k === "UNTIL" && until !== undefined)) return null;
    if (k === "UNTIL") { until = v; continue; }
    if (!PART_VALUE_RE.test(v)) return null;
    parts.set(k, v);
  }
  return FREQS.has(parts.get("FREQ") ?? "") ? { parts, ...(until !== undefined ? { until } : {}) } : null;
}
const buildRule = (parts: Map<string, string>): string => [...parts].map(([k, v]) => `${k}=${v}`).join(";");

const CAPPED = Symbol("capped");
/** The iterator's per-FREQ candidate generator: `next()` calls exactly this one once per candidate it tries (its
 *  inner loop), while the generators of finer units are called from inside it for BY-part expansion — so counting
 *  only this one counts candidates, not internal carries. */
const STEP_METHOD: Readonly<Record<string, string>> = {
  SECONDLY: "next_second", MINUTELY: "next_minute", HOURLY: "next_hour", DAILY: "next_day", WEEKLY: "next_week", MONTHLY: "next_month", YEARLY: "next_year",
};

/** Run one rule from `start` (wall time, floating), calling `on` for each occurrence until it passes `stopWallMs`,
 *  ends, or spends `cap` steps. A STEP is one call of the iterator's `next_<freq>` for the rule's own FREQ — one
 *  candidate generated — counted by wrapping that method on THIS iterator, so a rule whose candidates never match (FREQ=DAILY;
 *  BYMONTH=2;BYMONTHDAY=30, which ical.js would loop on forever inside one `next()`) still stops. */
function iterate(lib: IcalRecurLib, rule: string, start: Wall, until: Wall | undefined, stopWallMs: number, cap: number, on: (w: Wall) => void): "done" | "capped" | "unsupported" {
  let steps = 0;
  try {
    const recur = lib.Recur.fromString(rule);
    const t = (w: Wall) => new lib.Time({ year: w.y, month: w.mo, day: w.d, hour: w.h, minute: w.mi, second: w.s, isDate: w.isDate });
    recur.until = until ? t(until.isDate === start.isDate ? until : start.isDate ? { ...until, h: 0, mi: 0, s: 0, isDate: true } : { ...until, h: 23, mi: 59, s: 59, isDate: false }) : null;
    const it = recur.iterator(t(start)) as unknown as Record<string, unknown> & { next(): IcalTime | null };
    const m = STEP_METHOD[/(?:^|;)FREQ=([A-Z]+)/.exec(rule)?.[1] ?? ""];
    const f = m === undefined ? undefined : it[m];
    if (typeof f !== "function") return "unsupported";   // the wrapper is the bound; never iterate without it
    it[m!] = function (this: unknown, ...a: unknown[]) { if (++steps > cap) throw CAPPED; return (f as (...x: unknown[]) => unknown).apply(this, a); };
    for (let n = 0; n <= 2 * cap; n++) {
      const o = it.next();
      if (!o) return "done";
      const w: Wall = { y: o.year, mo: o.month, d: o.day, h: o.isDate ? 0 : o.hour, mi: o.isDate ? 0 : o.minute, s: o.isDate ? 0 : o.second, isDate: start.isDate };
      if (wallMs(w) > stopWallMs) return "done";
      on(w);
    }
    return "capped";
  } catch (e) {
    return e === CAPPED ? "capped" : "unsupported";
  }
}

const daysIn = (y: number, mo: number): number => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/** RE-ANCHORING an open-ended series near the window (see the header). Only for a rule with no COUNT (a COUNT counts
 *  from the real DTSTART), FREQ DAILY/WEEKLY/MONTHLY/YEARLY, no BYWEEKNO/BYYEARDAY. The anchor moves forward by a
 *  whole number of the rule's own periods (`INTERVAL` × day/week/month/year), so the iteration lattice — and with it
 *  every occurrence after the anchor — is unchanged; a MONTHLY/YEARLY rule that took its day (and month) from
 *  DTSTART gets them spelled out first, so a 31st or a 29 February survives a move to a shorter month. The anchor
 *  lands at least a period, the event's length and `PREFILTER_SLACK_MS` before the window, so the anchor itself —
 *  emitted first by the iterator even when it does not match the rule — can never be an occurrence in the window. */
function reanchor(parts: Map<string, string>, start: Wall, windowStartWallMs: number, lengthMs: number): { parts: Map<string, string>; start: Wall } | null {
  const freq = parts.get("FREQ")!;
  if (parts.has("COUNT") || parts.has("BYWEEKNO") || parts.has("BYYEARDAY") || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;
  const interval = Math.max(1, Number(parts.get("INTERVAL") ?? "1") || 1);
  const periodMs = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 }[freq as "DAILY"]! * DAY_MS * interval;
  const limit = windowStartWallMs - PREFILTER_SLACK_MS - Math.max(0, lengthMs) - periodMs - DAY_MS;
  if (wallMs(start) >= limit) return null;
  const out = new Map(parts);
  const lim = fromWallMs(limit, true);
  let y = start.y, mo = start.mo, d = start.d;
  if (freq === "DAILY" || freq === "WEEKLY") {
    const step = (freq === "DAILY" ? 1 : 7) * interval;
    const k = Math.floor((Date.UTC(lim.y, lim.mo - 1, lim.d) - Date.UTC(y, mo - 1, d)) / DAY_MS / step);
    if (k <= 0) return null;
    const t = new Date(Date.UTC(y, mo - 1, d + k * step));
    y = t.getUTCFullYear(); mo = t.getUTCMonth() + 1; d = t.getUTCDate();
  } else {
    const hasDay = parts.has("BYMONTHDAY") || parts.has("BYDAY");
    // ⚠ THE ANCHOR'S DAY MUST EXIST IN ITS MONTH (M2c review MEDIUM). Clamping it (31 → 30, 29 Feb → 28 Feb) made
    // ical.js iterate from a start the series never had: `FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29` from a leap-day
    // DTSTART then emitted a phantom 1 March in a non-leap year that the un-anchored run never emits. So when the
    // anchor's month lacks DTSTART's day the rule is NOT re-anchored at all — the un-anchored iteration is then used,
    // and anchored ≡ un-anchored holds by construction. (Stepping back to a month that has the day was tried and
    // rejected: for a plain `FREQ=YEARLY` from 29 Feb it disagrees with the un-anchored run, where ical.js rolls a
    // non-leap year's occurrence to 1 March.) Such a rule is a monthly or yearly one, so the un-anchored walk from
    // DTSTART stays far inside the step cap for any realistic start.
    if (freq === "MONTHLY") {
      const months = (lim.y - y) * 12 + (lim.mo - mo) - (lim.d < d ? 1 : 0);
      const k = Math.floor(months / interval) * interval;
      if (k <= 0) return null;
      if (!hasDay) out.set("BYMONTHDAY", String(start.d));
      const m0 = mo - 1 + k;
      y += Math.floor(m0 / 12); mo = (m0 % 12) + 1;
    } else {
      const years = lim.y - y - (lim.mo < mo || (lim.mo === mo && lim.d < d) ? 1 : 0);
      const k = Math.floor(years / interval) * interval;
      if (k <= 0) return null;
      if (!hasDay && !parts.has("BYMONTH")) out.set("BYMONTH", String(start.mo));
      if (!hasDay) out.set("BYMONTHDAY", String(start.d));
      y += k;
    }
    if (d > daysIn(y, mo)) return null;
  }
  return { parts: out, start: { ...start, y, mo, d } };
}

// ── resolving a date or date-time property ───────────────────────────────────────────────────────────

/** Where a DTSTART-like value lands: a DATE; a date-time in a known zone; or an unclear one (its TZID names no
 *  zone this parser can resolve) — wall time only. */
type When =
  | { kind: "date"; wall: Wall }
  | { kind: "time"; wall: Wall; zone: Zone }
  | { kind: "unclear"; wall: Wall; tzid: string };

type Ctx = {
  lib: IcalRecurLib;
  local: Zone;
  floating: Zone;
  tzs: Map<string, TzBlock>;
  zones: Map<string, Zone | null>;
};

function zoneFor(ctx: Ctx, tzid: string): Zone | null {
  if (ctx.zones.has(tzid)) return ctx.zones.get(tzid)!;
  let z: Zone | null = null;
  const block = ctx.tzs.get(tzid);
  if (block) z = vtimezoneZone(ctx.lib, block);
  if (!z) z = ianaZone(tzid);
  if (!z && Object.prototype.hasOwnProperty.call(WINDOWS_ZONES, tzid)) z = ianaZone(WINDOWS_ZONES[tzid]!);
  ctx.zones.set(tzid, z);
  return z;
}

/** A DATE / DATE-TIME property value (one of a list: `value` may be one element of a comma list). */
function resolve(ctx: Ctx, value: string, params: Record<string, string[]>): When | null {
  const vtype = params.VALUE?.[0]?.toUpperCase();
  const r = readValue(value, vtype === "DATE" ? true : vtype === "DATE-TIME" ? false : undefined);
  if (!r) return null;
  if (r.wall.isDate) return { kind: "date", wall: r.wall };
  if (r.utc) return { kind: "time", wall: r.wall, zone: UTC_ZONE };
  const tzid = params.TZID?.[0]?.trim();
  if (tzid === undefined || tzid === "") return { kind: "time", wall: r.wall, zone: ctx.floating };
  const z = zoneFor(ctx, tzid);
  return z ? { kind: "time", wall: r.wall, zone: z } : { kind: "unclear", wall: r.wall, tzid };
}

/** The instant a resolved value starts at (a date: its LOCAL midnight, the parent's zone); null when unclear. */
function instantOf(ctx: Ctx, w: When): number | null {
  return w.kind === "date" ? wallToUtc(w.wall, ctx.local) : w.kind === "time" ? wallToUtc(w.wall, w.zone) : null;
}

/** `CalEvent.recurrenceKey`'s spelling (types.ts): epoch-ms decimal for a date-time, `YYYY-MM-DD` for a date. An
 *  UNCLEAR one has no instant, so it is its wall time read as if UTC — consistent within the feed, which is where
 *  an override of an unclear series lives. */
function keyOf(w: When): string {
  return w.kind === "date" ? dateOf(w.wall) : w.kind === "time" ? String(wallToUtc(w.wall, w.zone)) : String(wallMs(w.wall));
}

// ── per block ────────────────────────────────────────────────────────────────────────────────────────

/** The block's properties, parsed once, by name (first occurrence first). */
function propsOf(block: Block, only?: ReadonlySet<string>): Map<string, Prop[]> {
  const out = new Map<string, Prop[]>();
  for (const line of block.lines) {
    const name = propName(line);
    if (name === "" || (only && !only.has(name))) continue;
    const p = parseLine(line);
    if (!p) continue;
    const list = out.get(p.name);
    if (list) list.push(p); else out.set(p.name, [p]);
  }
  return out;
}
const first = (props: Map<string, Prop[]>, n: string): Prop | undefined => props.get(n)?.[0];

const INDEX_PROPS = new Set(["UID", "RECURRENCE-ID", "DTSTART", "DTEND", "DURATION", "SEQUENCE", "LAST-MODIFIED", "RRULE", "RDATE"]);

function uidOf(props: Map<string, Prop[]>): string | undefined {
  const p = first(props, "UID");
  if (!p) return undefined;
  const u = unescapeText(p.value).trim();
  if (u === "") return undefined;
  // A UID carrying a control character or a line break (an escaped `\n` unescapes to one) is HASHED like an
  // over-long one: identity is kept — the same UID hashes the same in every feed — and the parent's check
  // (`uidOk`, ./parse-runner.ts) never refuses the whole answer over one hostile UID.
  return u.length <= CAL_UID_MAX && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(u) ? u : `sha256:${createHash("sha256").update(u).digest("hex")}`;
}
function sequenceOf(props: Map<string, Prop[]>): number | undefined {
  const v = first(props, "SEQUENCE")?.value.trim();
  return v !== undefined && /^\d{1,9}$/.test(v) ? Number(v) : undefined;
}
function lastModifiedOf(ctx: Ctx, props: Map<string, Prop[]>): number | undefined {
  const p = first(props, "LAST-MODIFIED");
  if (!p) return undefined;
  const w = resolve(ctx, p.value, p.params);
  const ms = w && w.kind !== "date" ? instantOf(ctx, w) : null;
  return ms === null || !Number.isFinite(ms) ? undefined : ms;
}

/** The pre-filter (see the header): may this block overlap the window? Cheap — wall times read as if UTC. */
function mayOverlap(props: Map<string, Prop[]>, windowStartMs: number, windowEndMs: number): boolean {
  if (props.has("RRULE") || props.has("RDATE") || props.has("RECURRENCE-ID")) return true;
  const ds = first(props, "DTSTART");
  const s = ds ? readValue(ds.value, ds.params.VALUE?.[0]?.toUpperCase() === "DATE" ? true : undefined) : null;
  if (!s) return true;   // cannot be read cheaply: kept (the full read flags it if it is really malformed)
  const start = wallMs(s.wall);
  let end = s.wall.isDate ? start + DAY_MS : start;
  let bothUtc = s.utc;
  const de = first(props, "DTEND"), du = first(props, "DURATION");
  if (de) {
    const e = readValue(de.value, s.wall.isDate ? undefined : false);
    if (!e) return true;
    end = Math.max(end, wallMs(e.wall));
    bothUtc = bothUtc && e.utc;
  } else if (du) {
    const d = readDuration(du.value);
    if (!d) return true;
    end = Math.max(end, start + d.days * DAY_MS + d.secs * 1000 + (d.days > 0 ? 3600_000 : 0));   // + a DST hour
  }
  const slack = bothUtc ? 0 : PREFILTER_SLACK_MS;
  return start <= windowEndMs + slack && end >= windowStartMs - slack;
}

// ── identity ─────────────────────────────────────────────────────────────────────────────────────────

const PARTSTAT: Readonly<Record<string, CalAttendeeStatus>> = { ACCEPTED: "accepted", TENTATIVE: "tentative", "NEEDS-ACTION": "needs-action", DECLINED: "declined" };
const ANSWER_RANK: Readonly<Record<CalAttendeeStatus, number>> = { declined: 9, accepted: 3, tentative: 2, "needs-action": 1 };

/** Your answer on this copy: a DECLINE by any of your addresses wins; else your strongest PARTSTAT (accepted >
 *  tentative > needs-action); else, with no attendee entry of yours, ORGANIZER equal to the confirmed URL-path
 *  owner makes you the organizer; else unknown. PARTSTAT comes before ORGANIZER on purpose: an explicit answer
 *  is the stronger signal, and until gate G6 has measured whether ORGANIZER can be forged as yours, an invite that
 *  claims you organised it but lists you as needs-action stays needs-action (its description stays withheld from
 *  the locked prompt, M3b). No self address at all: always unknown (identity-unknown, spec §4.2). */
function selfStatusOf(identity: CalLinkIdentity, attendees: CalEvent["attendees"], organizerEmail: string | undefined): CalSelfStatus {
  if (identity.self.length === 0) return "unknown";
  let best: CalAttendeeStatus | undefined;
  for (const a of attendees) {
    if (a.email === undefined || a.status === undefined || !identity.self.includes(a.email)) continue;
    if (best === undefined || ANSWER_RANK[a.status] > ANSWER_RANK[best]) best = a.status;
  }
  if (best !== undefined) return best;
  if (identity.verifiedOrganizer !== undefined && organizerEmail === identity.verifiedOrganizer) return "organizer";
  return "unknown";
}

// ── the parse ────────────────────────────────────────────────────────────────────────────────────────

/** Parse one feed. Never throws: an unexpected failure is `parse-error` (a fixed code — no feed text leaves). */
export function parseIcsFeed(lib: IcalRecurLib, input: IcsParseInput, knobs: IcsParseKnobs = {}): IcsParseResult {
  try {
    const r = parse(lib, input, knobs, false);
    return r.ok ? { ok: true, events: r.events, index: r.index, incomplete: r.incomplete } : r;
  } catch { return { ok: false, error: "parse-error" }; }
}

/** The details path (see the header): the same parse, plus the run date's raw details. Never throws. */
export function parseIcsDetails(lib: IcalRecurLib, input: IcsParseInput, knobs: IcsParseKnobs = {}): IcsDetailsResult {
  try { return parse(lib, input, knobs, true); } catch { return { ok: false, error: "parse-error" }; }
}

function parse(lib: IcalRecurLib, input: IcsParseInput, knobs: IcsParseKnobs, withDetails: boolean): IcsDetailsResult {
  const stepCap = knobs.stepCap ?? CAL_EXPANSION_STEP_CAP;
  const maxEvents = Math.max(0, Math.min(CAL_PARSE_MAX_EVENTS, Math.floor(input.maxEvents)));
  const local = ianaZone(input.zone);
  if (!local) return { ok: false, error: "parse-error" };
  const sc = scan(input.ics);
  if (sc.calendars === 0) return { ok: false, error: "parse-error" };

  const incomplete = new Set<CalParseIncomplete>();
  if (sc.truncated) incomplete.add("truncated");
  if (sc.dropped > 0) incomplete.add("malformed-event");

  const ctx: Ctx = { lib, local, floating: local, tzs: new Map(), zones: new Map() };
  for (const tz of sc.tzs) if (tz.tzid !== undefined && tz.tzid !== "" && !ctx.tzs.has(tz.tzid)) ctx.tzs.set(tz.tzid, tz);
  const xwr = sc.calProps.find((p) => p.name === "X-WR-TIMEZONE");
  if (xwr) { const z = zoneFor(ctx, unescapeText(xwr.value).trim()); if (z) ctx.floating = z; }

  // The reconcile window: today ± 2 days in the parent's zone (`reconcileWindow(runDate, "link")`).
  const winStartDate = addDays(input.runDate, -2), winEndDate = addDays(input.runDate, 3);   // exclusive end
  const wS = wallToUtc(fromWallMs(dateMs(winStartDate), true), local);
  const wE = wallToUtc(fromWallMs(dateMs(winEndDate), true), local);
  const winStartWall = dateMs(winStartDate), winEndWall = dateMs(winEndDate);

  // 3. index + pre-filter (and the override keys, per UID, which the masters need before they expand).
  // Final harden r3: ONE entry per (UID, recurrence id) — `collapseIndexEntry` folds duplicates as they arrive (the
  // newest revision, `recurs` when any is), so a feed of 300,000 copies of one UID sends one entry, not 300,000, and
  // the parent's reconcile stays linear. The byte budget is applied to the folded entries below.
  const folded = new Map<string, CalUidIndexEntry>();
  const kept: Map<string, Prop[]>[] = [];
  const overridden = new Map<string, Set<string>>();
  for (const block of sc.blocks) {
    const props = propsOf(block, INDEX_PROPS);
    const uid = uidOf(props);
    const ds = first(props, "DTSTART");
    const start = ds ? resolve(ctx, ds.value, ds.params) : null;
    const rid = first(props, "RECURRENCE-ID");
    const ridWhen = rid ? resolve(ctx, rid.value, rid.params) : null;
    if (uid !== undefined) {
      // Final harden r2: the replacement is VALIDATED before it hides the master's occurrence — one whose own
      // DTSTART cannot be read (or yields no time) is discarded below, and marking first made the day's meeting
      // vanish. An invalid one leaves the master occurrence visible and the read incomplete; a valid one
      // (CANCELLED included) overrides exactly as before.
      // Final harden r3: a MALFORMED replacement — a RECURRENCE-ID that cannot be read, or a valid one on a block
      // with no readable time — is kept OUT OF THE INDEX too. Indexed, an unreadable RECURRENCE-ID read as none,
      // so the entry keyed like the master or a single event and (same source, higher SEQUENCE, a far DTSTART)
      // superseded today's real meeting. The event itself was already dropped (step 4).
      const malformedReplacement = rid !== undefined
        && (ridWhen === null || start === null || timeOf(start, lengthOf(ctx, props, start)) === null);
      if (malformedReplacement) incomplete.add("malformed-event");
      else {
        const startMs = start ? instantOf(ctx, start) : null;
        const seq = sequenceOf(props), lm = lastModifiedOf(ctx, props);
        const e: CalUidIndexEntry = {
          uid,
          ...(ridWhen ? { recurrenceId: keyOf(ridWhen) } : {}),
          startMs: startMs !== null && Number.isFinite(startMs) ? startMs : null,
          ...(seq !== undefined ? { sequence: seq } : {}),
          ...(lm !== undefined ? { lastModified: lm } : {}),
          ...(props.has("RRULE") || props.has("RDATE") ? { recurs: true as const } : {}),
        };
        const k = indexEntryKey(e);
        const had = folded.get(k);
        folded.set(k, had ? collapseIndexEntry(had, e) : e);
        if (ridWhen) {
          const set = overridden.get(uid);
          const rk = keyOf(ridWhen);
          if (set) set.add(rk); else overridden.set(uid, new Set([rk]));
        }
      }
    }
    if (mayOverlap(props, wS, wE)) kept.push(propsOf(block));
  }
  const index: CalUidIndexEntry[] = [];
  let indexBytes = 2;
  for (const e of folded.values()) {
    const bytes = Buffer.byteLength(JSON.stringify(e)) + 1;
    if (indexBytes + bytes > CAL_INDEX_BUDGET_BYTES) incomplete.add("index-capped");
    else { indexBytes += bytes; index.push(e); }
  }

  // 4–5. expansion, identity, cleaning, limits.
  const events: CalDetailsWireEvent[] = [];
  let eventBytes = 2;
  let stopped = false;
  // The details path: the run date's local day, and each kept event's raw details (attached after the loop, in
  // start order, within CAL_DETAILS_BUDGET_BYTES). Unused on the morning path.
  const dayS = wallToUtc(fromWallMs(dateMs(input.runDate), true), local);
  const dayE = wallToUtc(fromWallMs(dateMs(addDays(input.runDate, 1)), true), local);
  const pending: { at: number; startMs: number; raw: CalRawDetails }[] = [];
  const emit = (ev: CalWireEvent, raw?: () => CalRawDetails): void => {
    if (stopped) return;
    if (events.length >= maxEvents) { incomplete.add("event-cap"); stopped = true; return; }
    const bytes = Buffer.byteLength(JSON.stringify(ev)) + 1;
    if (eventBytes + bytes > CAL_EVENTS_BUDGET_BYTES) { incomplete.add("output-cap"); stopped = true; return; }
    eventBytes += bytes;
    events.push(ev);
    if (raw !== undefined && onRunDate(ev.time, dayS, dayE, input.runDate)) pending.push({ at: events.length - 1, startMs: startKey(ev.time, local), raw: raw() });
  };

  for (const props of kept) {
    if (stopped) break;
    const ds = first(props, "DTSTART");
    const start = ds ? resolve(ctx, ds.value, ds.params) : null;
    if (!start) { incomplete.add("malformed-event"); continue; }
    const base = baseEvent(ctx, input, props);
    let blockRaw: CalRawDetails | undefined;
    const raw = withDetails ? (): CalRawDetails => (blockRaw ??= rawDetailsOf(props, input.identity)) : undefined;
    const uid = base.uid;
    const length = lengthOf(ctx, props, start);
    const rid = first(props, "RECURRENCE-ID");
    const recurs = props.has("RRULE") || props.has("RDATE");

    // A series master's occurrences per local day of the window (CAL_OCCURRENCES_PER_DAY_CAP); unused otherwise.
    const perDay = new Map<CalDate, number>();
    const underDayCap = (time: CalTime): boolean => {
      if (!recurs || rid) return true;
      const day = time.kind === "timed" ? dateOf(utcToWall(time.startMs, local)) : time.startDate;
      const n = perDay.get(day) ?? 0;
      if (n >= CAL_OCCURRENCES_PER_DAY_CAP) { incomplete.add("expansion-capped"); return false; }
      perDay.set(day, n + 1);
      return true;
    };
    const place = (w: When, key: string | undefined): void => {
      const time = timeOf(w, length);
      if (!time || !overlaps(time, wS, wE, winStartDate, winEndDate)) return;
      if (!underDayCap(time)) return;
      if (time.kind === "unclear") incomplete.add("unclear-time");
      emit({ ...base, ...(key !== undefined ? { recurrenceKey: key } : {}), time }, raw);
    };

    if (rid) {
      const ridWhen = resolve(ctx, rid.value, rid.params);
      if (!ridWhen) { incomplete.add("malformed-event"); continue; }
      if (param(rid, "RANGE")?.toUpperCase() === "THISANDFUTURE") incomplete.add("unsupported");
      place(start, keyOf(ridWhen));
      continue;
    }
    if (!recurs) { place(start, undefined); continue; }

    // A series master: every occurrence, keyed by its original start, minus EXDATE and the overridden ones.
    const skip = new Set(uid !== undefined ? overridden.get(uid) ?? [] : []);
    const skipDates = new Set<string>();
    for (const ex of props.get("EXDATE") ?? []) {
      for (const v of ex.value.split(",")) {
        const w = resolve(ctx, v, ex.params);
        if (!w) continue;
        if (w.kind === "date" && start.kind !== "date") skipDates.add(dateOf(w.wall)); else skip.add(keyOf(w));
      }
    }
    const seen = new Set<string>();
    const occurrence = (w: When): void => {
      const key = keyOf(w);
      if (seen.has(key)) return;
      seen.add(key);
      if (skip.has(key) || (w.kind !== "date" && skipDates.has(dateOf(w.wall)))) return;
      place(w, key);
    };
    const as = (wall: Wall): When => (start.kind === "time" ? { kind: "time", wall, zone: start.zone } : start.kind === "unclear" ? { kind: "unclear", wall, tzid: start.tzid } : { kind: "date", wall });
    let steps = 0, capped = false;

    occurrence(start);   // DTSTART is always the first instance (RFC 5545 §3.8.5.3)
    for (const rd of props.get("RDATE") ?? []) {
      const period = rd.params.VALUE?.[0]?.toUpperCase() === "PERIOD";
      for (const v of rd.value.split(",")) {
        if (++steps > stepCap) { capped = true; break; }
        const [a, b] = period ? v.split("/") : [v, undefined];
        const w = resolve(ctx, a ?? "", period ? { ...rd.params, VALUE: ["DATE-TIME"] } : rd.params);
        if (!w) continue;
        if (b === undefined) { occurrence(w); continue; }
        // A PERIOD carries its own end (an explicit end, or a duration from its start).
        const key = keyOf(w);
        if (seen.has(key) || skip.has(key)) continue;
        seen.add(key);
        const endW = /^[+-]?P/.test(b) ? null : resolve(ctx, b, rd.params);
        const dur = endW ? null : readDuration(b);
        const own: Length = endW && w.kind !== "date" ? { kind: "exact", ms: Math.max(0, (instantOf(ctx, endW) ?? wallMs(endW.wall)) - (instantOf(ctx, w) ?? wallMs(w.wall))) } : dur ? { kind: "duration", ...dur } : length;
        const time = timeOf(w, own);
        if (time && overlaps(time, wS, wE, winStartDate, winEndDate) && underDayCap(time)) {
          if (time.kind === "unclear") incomplete.add("unclear-time");
          emit({ ...base, recurrenceKey: key, time }, raw);
        }
      }
      if (capped) break;
    }
    for (const rr of props.get("RRULE") ?? []) {
      if (capped) break;
      const rule = readRule(rr.value);
      if (!rule) { incomplete.add("unsupported"); continue; }
      let until: Wall | undefined;
      if (rule.until !== undefined) {
        const u = readValue(rule.until, undefined);
        if (!u) { incomplete.add("unsupported"); continue; }
        until = u.utc && start.kind === "time" ? utcToWall(wallMs(u.wall), start.zone) : u.wall;
      }
      const stopWall = start.kind === "date" ? winEndWall + PREFILTER_SLACK_MS : wE + PREFILTER_SLACK_MS;
      let parts = rule.parts, from = start.wall;
      if (knobs.reanchor !== false) {
        const r = reanchor(parts, start.wall, start.kind === "date" ? winStartWall : wS, lengthMs(length));
        if (r) { parts = r.parts; from = r.start; }
      }
      const res = iterate(lib, buildRule(parts), from, until, stopWall, stepCap - steps, (w) => occurrence(as(w)));
      if (res === "capped") capped = true;
      if (res === "unsupported") incomplete.add("unsupported");
    }
    if (capped) incomplete.add("expansion-capped");
  }

  // The details budget, in the occurrences' start order (a stable sort: ties keep feed order). Past it, every later
  // occurrence carries no details and the answer is flagged.
  let detailsCapped = false;
  if (withDetails) {
    let detailsBytes = 0;
    for (const p of [...pending].sort((a, b) => a.startMs - b.startMs)) {
      const bytes = Buffer.byteLength(JSON.stringify(p.raw)) + DETAILS_KEY_BYTES;
      if (detailsBytes + bytes > CAL_DETAILS_BUDGET_BYTES) { detailsCapped = true; break; }
      detailsBytes += bytes;
      events[p.at] = { ...events[p.at]!, details: p.raw };
    }
  }
  return { ok: true, events, index, incomplete: CAL_PARSE_INCOMPLETE.filter((r) => incomplete.has(r)), ...(detailsCapped ? { detailsCapped: true as const } : {}) };
}

// ── the details path's raw fields (redesign C) ───────────────────────────────────────────────────────

/** `,"details":` — counted with each occurrence's details against the budget. */
const DETAILS_KEY_BYTES = 11;
/** The URL tier, in this order: the first of these a block carries (non-empty) is its link field. */
const DETAILS_URL_PROPS = ["URL", "X-GOOGLE-CONFERENCE", "X-MICROSOFT-SKYPETEAMSMEETINGURL"] as const;

/** At most `max` Unicode scalars of `s` (a code point at a time, so an astral character is never split). */
export function capScalars(s: string, max: number): string {
  if (s.length <= max) return s;
  let n = 0, i = 0;
  for (const ch of s) {
    if (n === max) return s.slice(0, i);
    n++;
    i += ch.length;
  }
  return s;
}

/** Does an occurrence overlap the run date's local day `[dayS, dayE)`? (A zero-length one when it starts inside.) */
function onRunDate(t: CalTime, dayS: number, dayE: number, runDate: CalDate): boolean {
  switch (t.kind) {
    case "timed": return t.endMs > t.startMs ? t.startMs < dayE && t.endMs > dayS : t.startMs >= dayS && t.startMs < dayE;
    case "allDay": return t.startDate <= runDate && t.endDateExclusive > runDate;
    case "unclear": return t.startDate <= runDate && t.endDate >= runDate;
  }
}

/** An occurrence's start as epoch ms, for the budget's order: a date or an unclear wall time read in the local zone. */
function startKey(t: CalTime, local: Zone): number {
  switch (t.kind) {
    case "timed": return t.startMs;
    case "allDay": return wallToUtc(fromWallMs(dateMs(t.startDate), true), local);
    case "unclear": return wallToUtc(fromWallMs(dateMs(t.startDate) + (Number(t.wallStart.slice(0, 2)) * 60 + Number(t.wallStart.slice(3, 5))) * 60_000, false), local);
  }
}

/** A block's raw details: the URL tier, the location and the description, TEXT-unescaped and capped, never cleaned;
 *  the organiser first and then the attendees, each once (by address), you (`identity.self`) left out, a nameless
 *  person as `null`, at most CAL_ATTENDEES_MAX in all. */
function rawDetailsOf(props: Map<string, Prop[]>, identity: CalLinkIdentity): CalRawDetails {
  const text = (n: string): string | undefined => { const p = first(props, n); return p ? unescapeText(p.value) : undefined; };
  let url: string | undefined;
  for (const n of DETAILS_URL_PROPS) {
    const v = text(n)?.trim();
    if (v) { url = capScalars(v, CAL_DETAILS_URL_MAX); break; }
  }
  const location = text("LOCATION"), notes = text("DESCRIPTION");
  const self = new Set(identity.self);
  const seen = new Set<string>();
  const people: CalRawDetails["people"] = [];
  const add = (p: Prop, organiser: boolean): void => {
    if (people.length >= CAL_ATTENDEES_MAX) return;
    const email = cleanEmail(p.value);
    if (email !== undefined) {
      if (self.has(email) || seen.has(email)) return;
      seen.add(email);
    }
    const cn = param(p, "CN");
    people.push({ name: cn !== undefined && cn !== "" ? capScalars(cn, CAL_DETAILS_NAME_MAX) : null, organiser });
  };
  const org = first(props, "ORGANIZER");
  if (org) add(org, true);
  for (const a of props.get("ATTENDEE") ?? []) add(a, false);
  return {
    ...(url !== undefined ? { url } : {}),
    ...(location !== undefined && location !== "" ? { location: capScalars(location, CAL_DETAILS_LOCATION_MAX) } : {}),
    ...(notes !== undefined && notes !== "" ? { notes: capScalars(notes, CAL_DETAILS_NOTES_MAX) } : {}),
    people,
  };
}

// ── one event's fields, length and time ──────────────────────────────────────────────────────────────

/** The fields every occurrence of a block shares, CLEANED (`cleanCalEvent`, spec §6 — once per block; the
 *  occurrences differ only in `time` and `recurrenceKey`, and an unclear time's `tzid` is cleaned in `timeOf`). */
function baseEvent(ctx: Ctx, input: IcsParseInput, props: Map<string, Prop[]>): Omit<CalWireEvent, "time" | "recurrenceKey"> {
  const text = (n: string): string | undefined => { const p = first(props, n); return p ? unescapeText(p.value) : undefined; };
  const attendees: CalEvent["attendees"] = [];
  for (const a of props.get("ATTENDEE") ?? []) {
    const email = cleanEmail(a.value), name = param(a, "CN"), status = PARTSTAT[(param(a, "PARTSTAT") ?? "").toUpperCase()];
    attendees.push({ ...(name !== undefined ? { name } : {}), ...(email !== undefined ? { email } : {}), ...(status !== undefined ? { status } : {}) });
  }
  const org = first(props, "ORGANIZER");
  const orgEmail = org ? cleanEmail(org.value) : undefined;
  const orgName = org ? param(org, "CN") : undefined;
  const status = (text("STATUS") ?? "").trim().toUpperCase();
  const seq = sequenceOf(props), lm = lastModifiedOf(ctx, props), uid = uidOf(props);
  // The near-duplicate producer keys (spec 2026-10-31 §4), from the full RAW LOCATION and DESCRIPTION, before cleaning
  // and before any details-only cap, the same on the morning and details paths. Never from URL or a conference property.
  const keys = producerKeys({ location: text("LOCATION"), notes: text("DESCRIPTION") });
  const raw: CalEvent = {
    sources: [{ kind: "link", id: input.sourceId, calendarId: input.sourceId }],
    ...(uid !== undefined ? { uid } : {}),
    time: { kind: "timed", startMs: 0, endMs: 0 },   // placeholder; each occurrence sets its own
    title: text("SUMMARY") ?? "",
    ...(text("LOCATION") !== undefined ? { location: text("LOCATION")! } : {}),
    ...(org && (orgEmail !== undefined || orgName !== undefined) ? { organizer: { ...(orgName !== undefined ? { name: orgName } : {}), ...(orgEmail !== undefined ? { email: orgEmail } : {}) } } : {}),
    attendees,
    selfStatus: selfStatusOf(input.identity, attendees, orgEmail),
    // RAW trusted signal — gated by G6 downstream (see the header).
    organizerVerified: input.identity.verifiedOrganizer !== undefined && orgEmail === input.identity.verifiedOrganizer,
    transparency: (text("TRANSP") ?? "").trim().toUpperCase() === "TRANSPARENT" ? "free" : "busy",
    status: status === "CANCELLED" ? "cancelled" : status === "TENTATIVE" ? "tentative" : "confirmed",
    ...(text("DESCRIPTION") !== undefined ? { description: text("DESCRIPTION")! } : {}),
    ...(lm !== undefined ? { lastModified: lm } : {}),
    ...(seq !== undefined ? { sequence: seq } : {}),
    ...keys,
    provenance: {},
  };
  const { sources: _s, provenance: _p, time: _t, ...clean } = cleanCalEvent(raw);
  if (clean.attendees.length > CAL_ATTENDEES_MAX) clean.attendees = clean.attendees.slice(0, CAL_ATTENDEES_MAX);
  return clean;
}

/** How long each occurrence lasts: EXACT (DTEND − DTSTART as instants; wall difference for an unclear or date
 *  event), or a DURATION (nominal days in wall time, then exact seconds). A missing DTEND/DURATION: a date event
 *  lasts one day, a date-time one zero length. */
type Length = { kind: "exact"; ms: number } | { kind: "duration"; days: number; secs: number };

function lengthOf(ctx: Ctx, props: Map<string, Prop[]>, start: When): Length {
  const de = first(props, "DTEND");
  if (de) {
    const end = resolve(ctx, de.value, de.params);
    if (end && (end.kind === "date") === (start.kind === "date")) {
      const a = instantOf(ctx, start), b = instantOf(ctx, end);
      const ms = a !== null && b !== null && start.kind !== "date" ? b - a : wallMs(end.wall) - wallMs(start.wall);
      return start.kind === "date" ? { kind: "duration", days: Math.max(1, Math.round(ms / DAY_MS)), secs: 0 } : { kind: "exact", ms: Math.max(0, ms) };
    }
  }
  const du = first(props, "DURATION");
  const d = du ? readDuration(du.value) : null;
  if (d) return start.kind === "date" ? { kind: "duration", days: Math.max(1, d.days + (d.secs > 0 ? Math.ceil(d.secs / 86_400) : 0)), secs: 0 } : { kind: "duration", ...d };
  return start.kind === "date" ? { kind: "duration", days: 1, secs: 0 } : { kind: "exact", ms: 0 };
}
const lengthMs = (l: Length): number => (l.kind === "exact" ? l.ms : l.days * DAY_MS + l.secs * 1000 + (l.days > 0 ? 3600_000 : 0));

/** The latest wall instant an occurrence may END at: 9999-12-31 00:00 (M2c review HIGH). A hostile DURATION
 *  (`P999999W`) otherwise put a five-digit year — or, past `Date`'s range, `NaN` — into an all-day or unclear end
 *  date; the parent's strict date check refused the whole answer as `bad-output`, and every event from that link
 *  vanished for the run. Clamped HERE, in the child; the parent's check stays strict. */
const WALL_END_MAX_MS = Date.UTC(9999, 11, 31);
const capEndWall = (ms: number): number => (Number.isFinite(ms) ? Math.min(ms, WALL_END_MAX_MS) : WALL_END_MAX_MS);

function timeOf(w: When, length: Length): CalTime | null {
  if (w.kind === "date") {
    const days = length.kind === "duration" ? Math.max(1, length.days) : 1;
    return { kind: "allDay", startDate: dateOf(w.wall), endDateExclusive: dateOf(fromWallMs(capEndWall(wallMs(w.wall) + days * DAY_MS), true)) };
  }
  if (w.kind === "unclear") {
    const endWall = fromWallMs(capEndWall(length.kind === "exact" ? wallMs(w.wall) + length.ms : wallMs(w.wall) + length.days * DAY_MS + length.secs * 1000), false);
    return { kind: "unclear", startDate: dateOf(w.wall), endDate: dateOf(endWall), wallStart: hhmm(w.wall), wallEnd: hhmm(endWall), tzid: cleanCalendarText(w.tzid, "title") };
  }
  const startMs = wallToUtc(w.wall, w.zone);
  const endMs = length.kind === "exact"
    ? startMs + length.ms
    : wallToUtc(fromWallMs(capEndWall(wallMs(w.wall) + length.days * DAY_MS), false), w.zone) + length.secs * 1000;
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? { kind: "timed", startMs, endMs: Math.max(startMs, endMs) } : null;
}

/** Does an occurrence overlap the reconcile window? Timed: `[wS, wE)` (a zero-length one when it falls inside).
 *  All-day: its dates against the window's dates. Unclear: its wall dates against the window's dates. */
function overlaps(t: CalTime, wS: number, wE: number, winStartDate: CalDate, winEndDateExclusive: CalDate): boolean {
  switch (t.kind) {
    case "timed": return t.endMs > t.startMs ? t.startMs < wE && t.endMs > wS : t.startMs >= wS && t.startMs < wE;
    case "allDay": return t.startDate < winEndDateExclusive && t.endDateExclusive > winStartDate;
    case "unclear": return t.startDate < winEndDateExclusive && t.endDate >= winStartDate;
  }
}

/** TEST-ONLY: the pre-filter's verdict on one VEVENT (its lines, without BEGIN/END), for the window around `runDate`
 *  in `zone`. Production reaches the pre-filter only through `parseIcsFeed`. */
export function prefilterKeeps(veventLines: readonly string[], runDate: CalDate, zone: string): boolean {
  const local = ianaZone(zone);
  if (!local) throw new Error("prefilterKeeps: unknown zone");
  const wS = wallToUtc(fromWallMs(dateMs(addDays(runDate, -2)), true), local);
  const wE = wallToUtc(fromWallMs(dateMs(addDays(runDate, 3)), true), local);
  return mayOverlap(propsOf({ lines: [...veventLines] }, INDEX_PROPS), wS, wE);
}
