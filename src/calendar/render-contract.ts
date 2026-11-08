// src/calendar/render-contract.ts — the bytes the calendar section is made of, in ONE place (plan M0).
//
// Three readers must agree on these, and each would otherwise carry its own copy: the engine's renderer
// (`src/render.ts`, M4), the audit's section-bounded exclusion (`src/audit.ts`, M6a: `coverageGaps`,
// `extractCitedShas` and `missingSameDay` skip lines inside the section only), and the desktop app's
// mirror (`gui/src/lib/briefing-struct.ts` and the history view, M9). Spec r4 §7 and §10.
//
// ⚠ DATA, ONE PREDICATE, AND (final harden r3) ONE SPAN MARK (`calendarClockChangeMark`). Wired into the renderer at M4 (`renderCalendarSection`, src/render.ts), which emits
// the section only when `BriefingStruct.calendar` is present — so with calendar off the briefing, the audit and the
// GUI are byte-identical to before; the calendar-off goldens (`test/calendar-off.golden.test.ts`) hold that. The frozen rendered form these constants build is
// `test/fixtures/calendar/rendered-section.txt` — that file, not this comment, is the contract for layout.
//
// ⚠ CHANGING ANY STRING HERE IS A PARSER CHANGE: archived briefings carry the old bytes, and the audit
// and the app's history view read archives. Treat these like `BRIEFING_HEADER_RE` in `src/audit.ts`.
import type { CalendarReadStatus } from "./types";

/** The section heading. The GUI's history view recognises headings by their `▶ ` lead
 *  (`gui/src/lib/briefing-md.ts`), so this keeps it. */
export const CALENDAR_HEADING = "▶ Today's calendar";

/** Appended to the heading when any source failed or was only partly read (`CalendarStruct.incomplete`). */
export const CALENDAR_INCOMPLETE_SUFFIX = " (incomplete)";

/** EVERY line inside the section starts with this, and no other line of the briefing does: three spaces,
 *  U+25E6, one space. Recap's nested lines are `"      ◦ "` (six spaces), so the two never collide. */
export const CALENDAR_LINE_PREFIX = "   ◦ ";

/** At most this many EVENT lines; the rest are counted on one `+N more` line (status lines are not
 *  counted). Spec §7. */
export const CALENDAR_MAX_EVENT_LINES = 60;

/** The id of the one `macos` source in `CalendarStruct.sources`. A link's id is its configured id, and a
 *  link may not take this one: `resolveCalendar` (src/calendar/config.ts, M1) refuses it like an id outside
 *  the grammar, so a source named by id alone is never ambiguous. */
export const CALENDAR_MACOS_SOURCE_ID = "macos";

/** How a status line names the `macos` source (a link is named by its id). */
export const CALENDAR_MACOS_LABEL = "Mac Calendar";

/** The section's only line when EVERY source failed (spec §7). */
export const CALENDAR_UNAVAILABLE_TEXT = "Calendar unavailable today";

/** The section's only event line when the sources were read and today has no events. */
export const CALENDAR_NO_EVENTS_TEXT = "No events today";

/** The section's only line when calendar is on but no source is configured on this machine — no link, and no Mac
 *  source here (spec §7, build decision 2026-10-09: the M9 checkpoint found the case reachable from Settings). The
 *  heading carries no suffix, and the prompt carries no calendar block. Frozen as the `no-sources` variant. */
export const CALENDAR_NOT_CONNECTED_TEXT = "No calendar is connected";

/** Shown in place of an empty title (cleaning can leave a title with nothing in it). */
export const CALENDAR_UNTITLED_TEXT = "(no title)";

/** One fixed sentence per read status that gets a line in the section, naming no URL and quoting nothing
 *  from the feed. A status line is `CALENDAR_LINE_PREFIX + <label> + ": " + <this>`, where the label is
 *  `CALENDAR_MACOS_LABEL` or the link's id.
 *
 *  ⚠ These lines live INSIDE the section and never in `struct.warnings`: the eval's posture line is found
 *  by substring over warnings (`src/eval/posture.ts`), and none of these may contain one of its phrases —
 *  `test/calendar-contract.test.ts` checks every sentence against `isPostureWarning`.
 *
 *  Notices (`helper-outdated`, `identity-unknown`) get no line in the briefing: the read happened, and the
 *  app's Settings screen is where they are acted on. */
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
 *  it an event across the repeated fall-back hour renders backwards (`01:45–01:15`). Both readers use
 *  `calendarClockChangeMark`; the BUSY line and the prompt's spans carry the same mark. */
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

/** Is this line the calendar section's heading, with or without the `(incomplete)` suffix? The ONE
 *  predicate the renderer, the audit and the GUI mirror share (spec §7): the audit's exclusion runs from a
 *  line matching it to the next `▶ ` heading. A prefix test, as spec §7 words it — so a trailing `\r` from
 *  a hand-edited archive still matches. No rendered field can start a line with it: every field has its
 *  control bytes, newlines included, stripped (`src/render.ts`, `stripControl`). */
export function isCalendarHeading(line: string): boolean {
  return line.startsWith(CALENDAR_HEADING);
}
