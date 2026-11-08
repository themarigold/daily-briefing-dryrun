/**
 * v0.3.0 (calendar connection, plan M9) — the desktop app's MIRROR of the engine's calendar contract:
 * the bytes the briefing's calendar section is made of (`src/calendar/render-contract.ts`) and the
 * shapes the app reads (`src/calendar/types.ts`: `BriefingStruct.calendar` and the three
 * `calendar … --json` payloads).
 *
 * ⚠ A MIRROR, NOT AN IMPORT — the `briefing-struct.ts` rule: the webview bundle never imports engine
 * source (docs/gui-seam.md §1). `tests-web/calendar.check.ts` deep-equals every constant below
 * against the engine's own exports, and renders the engine's FROZEN fixture
 * (`test/fixtures/calendar/rendered-section.txt`) through `briefing-struct.ts` byte for byte, so a
 * drift on either side fails there.
 *
 * ⚠ CHANGING ANY STRING HERE IS A PARSER CHANGE, as it is in the engine: archived briefings carry
 * these bytes and the History view reads archives (`briefing-md.ts`).
 *
 * ⚠ THE `--json` SHAPES CARRY THE HUB'S CONTRACT AMENDMENT (2026-10-09, plan M9): `CalendarLinkInfo`
 * is `configuredOwner` / `urlPathOwner` / `confirmedOwner` / `fileStatus` / `fileReason` — not M0's
 * `owner` / `ownerFrom` / `ownerConfirmed` — and the test and status source entries carry an optional
 * `reason` (a credential-ladder code beside `malformed`). W1 lands the same amendment in
 * `src/calendar/types.ts` (M5); the app is coded against it now. None of these shapes ever carries a
 * link URL, an attendee or a description.
 */

/* ── the rendered section (`src/calendar/render-contract.ts`) ─────────────────────────────────── */

/** The section heading. History recognises headings by their `▶ ` lead (`briefing-md.ts`). */
export const CALENDAR_HEADING = "▶ Today's calendar";

/** Appended to the heading when any source failed or was only partly read. */
export const CALENDAR_INCOMPLETE_SUFFIX = " (incomplete)";

/** EVERY line inside the section starts with this: three spaces, U+25E6, one space. Recap's nested
 *  lines are `"      ◦ "` (six spaces), so the two never collide. */
export const CALENDAR_LINE_PREFIX = "   ◦ ";

/** At most this many EVENT lines; the rest are counted on one `+N more` line. */
export const CALENDAR_MAX_EVENT_LINES = 60;

/** The id of the one `macos` source. */
export const CALENDAR_MACOS_SOURCE_ID = "macos";

/** How a status line names the `macos` source (a link is named by its id). */
export const CALENDAR_MACOS_LABEL = "Mac Calendar";

/** The section's only line when EVERY source failed. */
export const CALENDAR_UNAVAILABLE_TEXT = "Calendar unavailable today";

/** The section's only event line when the sources were read and today has no events. */
export const CALENDAR_NO_EVENTS_TEXT = "No events today";

/** The section's only line when calendar is on but no source is configured on this machine (the
 *  engine's frozen `no-sources` variant): the heading carries no suffix and nothing else follows. */
export const CALENDAR_NOT_CONNECTED_TEXT = "No calendar is connected";

/** Shown in place of an empty title. */
export const CALENDAR_UNTITLED_TEXT = "(no title)";

/** One fixed sentence per read status that gets a line in the section — naming no URL, quoting
 *  nothing from the feed. Settings → Calendar shows the same sentences for a source's last read. */
export const CALENDAR_STATUS_TEXT: Readonly<Record<Exclude<CalendarReadStatus, "ok">, string>> = Object.freeze({
  "not-granted": "calendar access has not been granted yet — allow it in Settings → Calendar",
  "write-only": "calendar access is add-only — choose Full Access in System Settings → Privacy & Security → Calendars",
  "denied": "calendar access was denied — allow it in System Settings → Privacy & Security → Calendars",
  "restricted": "calendar access is restricted on this Mac",
  "unsupported-os": "needs macOS 14 or later",
  "helper-missing": "the calendar reader is not installed",
  "timeout": "did not answer in time",
  "offline": "could not be reached — no network",
  "link-refused": "the link was refused — it may have been reset; add it again",
  "link-redirected": "the link redirected somewhere it may not go",
  "malformed": "the calendar could not be read",
  "too-large": "the calendar is too large to read",
  "incomplete": "only partly read — some events may be missing",
});

/** Final harden r3: the mark after a timed span whose zone's UTC offset CHANGES inside it — a DST change. Without
 *  it an event across the repeated fall-back hour renders backwards (`01:45–01:15`). The engine's
 *  mirror is `src/calendar/render-contract.ts`; `tests-web/calendar.check.ts` holds the two equal. */
export const CALENDAR_CLOCKS_BACK_TEXT = " (clocks go back)";
export const CALENDAR_CLOCKS_FORWARD_TEXT = " (clocks go forward)";

/** The mark for a span from `startMs` to `endMs` in the renderer's LOCAL zone: `CALENDAR_CLOCKS_BACK_TEXT` when
 *  the clocks went back inside it, `CALENDAR_CLOCKS_FORWARD_TEXT` when they went forward, `""` otherwise (and for a
 *  non-finite instant). */
export function calendarClockChangeMark(startMs: number, endMs: number): string {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "";
  const a = new Date(startMs).getTimezoneOffset(), b = new Date(endMs).getTimezoneOffset();
  return b > a ? CALENDAR_CLOCKS_BACK_TEXT : b < a ? CALENDAR_CLOCKS_FORWARD_TEXT : "";
}

/** Is this line the calendar section's heading, with or without `(incomplete)`? The ONE predicate the
 *  engine's renderer, its audit and this app share (spec r4 §7): a prefix test, so a trailing `\r`
 *  from a hand-edited archive still matches. */
export function isCalendarHeading(line: string): boolean {
  return line.startsWith(CALENDAR_HEADING);
}

/* ── the struct (`BriefingStruct.calendar`) ───────────────────────────────────────────────────── */

export type CalDate = string;
export type CalTime =
  | { kind: "timed"; startMs: number; endMs: number }
  | { kind: "allDay"; startDate: CalDate; endDateExclusive: CalDate }
  | { kind: "unclear"; startDate: CalDate; endDate: CalDate; wallStart: string; wallEnd: string; tzid: string };

export type CalendarSourceKind = "macos" | "link";

export type CalendarSourceStatus =
  | "ok"
  | "not-granted"
  | "write-only"
  | "denied"
  | "restricted"
  | "unsupported-os"
  | "helper-missing"
  | "helper-outdated"
  | "identity-unknown"
  | "timeout"
  | "offline"
  | "link-refused"
  | "link-redirected"
  | "malformed"
  | "too-large"
  | "incomplete";

/** The statuses that leave the read intact — shown beside the read status, never instead of it. */
export type CalendarSourceNotice = "helper-outdated" | "identity-unknown";

/** A read outcome: `ok`, `incomplete`, or one of the eleven failures. */
export type CalendarReadStatus = Exclude<CalendarSourceStatus, CalendarSourceNotice>;

export interface CalendarStructEvent {
  time: CalTime;
  title: string;
  location?: string;
  status: "confirmed" | "tentative";
  transparency: "busy" | "free";
  attendeeCount: number;
  /** Present (literal `true`) when the event had ended at generation time. */
  ended?: true;
  /** The decided key-c merge mark (calendar near-duplicates, spec 2026-10-31 §6), `count` an integer ≥ 2: rendered
   *  as given (` · on N calendars` / ` · N copies`), never inferred; absent on every older or unmerged struct. */
  merged?: { mark: "calendars" | "copies"; count: number };
}

export interface CalendarStructSource {
  id: string;
  kind: CalendarSourceKind;
  status: CalendarReadStatus;
  notices?: CalendarSourceNotice[];
}

export interface CalendarStruct {
  events: CalendarStructEvent[];
  sources: CalendarStructSource[];
  incomplete: boolean;
}

/* ── the `calendar … --json` payloads (hub amendment, plan M9) ────────────────────────────────── */

export interface CalendarMacosCalendar {
  id: string;
  title: string;
  /** The account (EventKit source) title — shown so the user can untick a calendar someone else shared. */
  account: string;
  editable: boolean;
  type: "standard" | "subscribed" | "birthdays";
  selected: boolean;
}

/** One configured link, as `calendar list --json` reports it. NEVER its URL. */
export interface CalendarLinkInfo {
  id: string;
  name?: string;
  /** The config's `owner`: recognises your accepts and declines only. */
  configuredOwner?: string;
  /** The personal address in a Google link's URL path; absent for group/import/resource calendar ids
   *  and for every other host. */
  urlPathOwner?: string;
  /** The config's `confirmedOwner`. It counts as confirmed only when it EQUALS `urlPathOwner`. */
  confirmedOwner: string | null;
  urlFrom: "file" | "env" | "command";
  /** Only for `urlFrom: "file"`: whether the managed link file could be read (`failed`: an unexpected read
   *  error, `fileReason: "read-error"` — the engine's `CalendarLinkInfo`, final harden r2). */
  fileStatus?: "ok" | "missing" | "refused" | "failed";
  /** Only for `urlFrom: "file"`: the credential ladder's reason code. */
  fileReason?: string;
}

export interface CalendarListJson {
  schemaVersion: 1;
  macos: { status: CalendarReadStatus; notices?: CalendarSourceNotice[]; calendars: CalendarMacosCalendar[] } | null;
  links: CalendarLinkInfo[];
}

export interface CalendarTestSource {
  id: string;
  kind: CalendarSourceKind;
  status: CalendarReadStatus;
  notices?: CalendarSourceNotice[];
  eventsToday: number | null;
  durationMs: number;
  /** Not rendered by the engine: a credential failure's reason code beside `malformed`. */
  reason?: string;
}

export interface CalendarTestJson {
  schemaVersion: 1;
  ranAt: string;
  sources: CalendarTestSource[];
  incomplete: boolean;
}

export interface CalendarLastRead {
  at: string;
  status: CalendarReadStatus;
  notices?: CalendarSourceNotice[];
  reason?: string;
}

export interface CalendarStatusSource {
  id: string;
  kind: CalendarSourceKind;
  name?: string;
  /** `null` until a scheduled run has read this source ("not yet"). */
  lastScheduledRead: CalendarLastRead | null;
  reason?: string;
}

export interface CalendarStatusJson {
  schemaVersion: 1;
  enabled: boolean;
  /** True when the block carries an own, non-null `enabled` (the user answered on or off); false with no block, no
   *  `enabled`, or `"enabled": null` — "never asked", which `enabled` alone cannot tell from "off". */
  enabledSet: boolean;
  /** Mac Calendar can be connected here: darwin and macOS 14+, the engine's `calendar connect mac` check. */
  macSupported: boolean;
  /** The resolver's fixed-text warnings; never a configured value or a URL. */
  configWarnings: string[];
  sources: CalendarStatusSource[];
}
