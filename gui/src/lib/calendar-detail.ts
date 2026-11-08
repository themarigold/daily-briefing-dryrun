/**
 * Briefing redesign C, wave-2 plan C-M4-T10 — the calendar slide's LIVE DETAIL, as pure models: what the timeline, the
 * subtitle, the next-meeting bar, the meeting card and the launchpad's tile draw, before and after today's details are
 * read live (`src-tauri/src/calendar_details.rs`, through Today's driver, `lib/calendar-live.ts`). No Svelte, no IPC,
 * no clock of its own: every function that needs the time takes `now`.
 *
 * WHERE THE DATA COMES FROM, BY PHASE (C "Where the timeline's data comes from"):
 * - `before`: no read has answered (or the last did not answer): the page's rows, as A draws them;
 * - `read`: every source answered `ok`: the live events only. A page row with no live match "changed";
 * - `partial`: some source failed or was SKIPPED (a skipped source is not answered, C4): the live events, plus each
 *   page row that matches no live event as an unconfirmed fallback, and each failed source's line. Page rows carry no
 *   source, so nothing here ever says which source a fallback row came from;
 * - `failed`: no source answered (a whole-read failure, or a read with no source configured to answer): the page's
 *   rows and the failure's lines (none when there is no source);
 * - `off`: the calendar was turned off since the page: the page's rows and one line.
 *
 * MATCHING (C "Matching the page's rows"; calendar near-duplicates spec §5, one-to-one): the page's rows are assigned
 * live events in ONE pass, in page order (`assignRows`): a row takes the single untaken live event whose `rowText` (the
 * engine's own page line for it) equals the row's text with trailing ` · ended` and ` · tentative` removed from both
 * sides and the merge mark kept (the exact step), else the single untaken one equal with the merge mark (spec §6)
 * also removed from both. Two or more candidates tie and take none. Each live event is used at most once; rows are
 * never matched by position, and a row's identity is its index among the page's calendar rows, never its text.
 *
 * ⚠ PLAIN TEXT ONLY. Titles, locations, names and notes are calendar text, and notes may still hold `javascript:`,
 * `data:`, `mailto:` or `msteams:` text. Every string here is drawn as a text node; nothing here builds a link, an
 * address or anything clickable from one. Join is by HANDLE, opened by Rust; the reply carries only the Join host.
 *
 * Proposed wordings, checked in the screenshot pass: `OFF_LINE`, `READER_OUTDATED_LINE`, the people line's cut and
 * shortening ("Priya S."), "N people" when no name can be shown, "{name}: not read yet", "No events today" as the
 * subtitle of a day with no events, and the ask-first question.
 *
 * (The deck model, `deck.ts`, builds its `live` field with [`calendarDetailView`], and this module calls deck.ts's
 * `parseCalendarLine`, `nextMeeting` and `clockTime`: an import cycle of FUNCTION DECLARATIONS only, which ES modules
 * initialise before either body runs. Nothing here reads a deck.ts value at module load.)
 */
import {
  CALENDAR_MACOS_LABEL,
  CALENDAR_NO_EVENTS_TEXT,
  CALENDAR_NOT_CONNECTED_TEXT,
  CALENDAR_STATUS_TEXT,
  CALENDAR_UNAVAILABLE_TEXT,
  CALENDAR_UNTITLED_TEXT,
  type CalTime,
} from "./calendar-contract";
import { clockTime, nextMeeting, parseCalendarLine, splitMergeMark, statusless, unmarked, type CalendarEvent, type CalendarRow, type DeckPage, type MergeMark } from "./deck";
import type { CalendarDetailsEvent, CalendarDetailsGetReply, CalendarDetailsSource, CalendarJoinReply } from "./engine";
import { localDate } from "./today";
import type { Os } from "./platform";

const MIN = 60_000;

/* ── the words ────────────────────────────────────────────────────────────────────────────────── */

/** The card while today's details are still loading (C "What the user sees"). */
export const LOADING_LINE = "Reading your calendar…";
/** PB-M4 (wave-2 polish spec §5, proposed): on a live calendar day, the last read did not answer. */
export const READ_FAILED_LINE = "Couldn't read your calendar just now";
/** A page row with no live match after a read in which every source answered. */
export const CHANGED_LINE = "This event changed since your briefing";
/** A link source that could not be reached (`incomplete` with reason `unreachable`, or `offline`). */
export const OFFLINE_LINE = "Couldn't read your calendar (offline)";
/** The reader's own `timeout`. */
export const TIMEOUT_LINE = "Calendar took too long";
/** The Mac source's `denied`. */
export const DENIED_LINE = "Calendar access was turned off: allow it in System Settings";
/** `calendar_details_open` refused: the calendar was turned off since the page (proposed). */
export const OFF_LINE = "Calendar is off: turn it on in Settings → Calendar";
/** An outdated reader copy still reads; a link from the event's own link field waits for the update (proposed). */
export const READER_OUTDATED_LINE = "Update the calendar reader to show every meeting link";
/** A skipped source with no last status (proposed, after the source's name). */
export const NOT_READ_YET = "not read yet";
/** An event whose only attendee is you. */
export const JUST_YOU = "Just you";
/** The live read could not retain this event's details. */
export const DETAILS_UNAVAILABLE_LINE = "Details not available";
/** The card's Join, always (C `:24`: not the mockup's "Join Zoom ↗"). */
export const CARD_JOIN_LABEL = "Join ↗";
/** The card when the winning field holds two different meeting links. */
export const SEVERAL_LINKS_LINE = "Several meeting links";
export const JOIN_OPENER_LINE = "Couldn't open the meeting link";
export const JOIN_INVALID_LINE = "This meeting link can't be opened from here";

/* ── the live list, as the driver publishes it ────────────────────────────────────────────────── */

/** One applied list reply (`gate: "held"` or `"read"`). */
export interface LiveList {
  readAt: string;
  readerOutdated: boolean;
  events: CalendarDetailsEvent[];
  sources: CalendarDetailsSource[];
}

/** `DeckInput.calendarDetail`: what Today's calendar driver holds (`lib/calendar-live.ts`). */
export interface CalendarDetail {
  /** The last list applied, or null: none yet, or the last read did not answer (Rust then holds none either). */
  list: LiveList | null;
  /** An ask is outstanding. */
  pending: boolean;
  /** The last answer was the calendar-off refusal. */
  off: boolean;
  /** A `calendar.macos` source is configured (`calendar status`, once per Today mount); null until it answers. */
  macConfigured: boolean | null;
  /** PB-M4: the last read did not answer (cleared by a later answering read). Drawn only on a live calendar day. */
  failed: boolean;
}

export const NO_DETAIL: CalendarDetail = Object.freeze({ list: null, pending: false, off: false, macConfigured: null, failed: false });

/** One live event, its reply fields checked (the reply's `time` is never trusted as typed). */
export interface LiveEvent {
  handle: string;
  title: string;
  location: string | null;
  rowText: string;
  time: CalTime;
  tentative: boolean;
  ended: boolean;
  linkState: "none" | "one" | "several";
  joinHost: string | null;
  serviceName: string | null;
  needsConfirm: boolean;
  fromMac: boolean;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";

function calTime(t: unknown): CalTime | null {
  if (typeof t !== "object" || t === null) return null;
  const o = t as Record<string, unknown>;
  if (o.kind === "timed" && num(o.startMs) && num(o.endMs) && o.endMs >= o.startMs) {
    return { kind: "timed", startMs: o.startMs, endMs: o.endMs };
  }
  if (o.kind === "allDay" && str(o.startDate) && str(o.endDateExclusive)) {
    return { kind: "allDay", startDate: o.startDate, endDateExclusive: o.endDateExclusive };
  }
  if (o.kind === "unclear" && str(o.startDate) && str(o.endDate) && str(o.wallStart) && str(o.wallEnd) && str(o.tzid)) {
    return { kind: "unclear", startDate: o.startDate, endDate: o.endDate, wallStart: o.wallStart, wallEnd: o.wallEnd, tzid: o.tzid };
  }
  return null;
}

/** A reply event as a [`LiveEvent`], or null when its time is not one of the three shapes. */
export function liveEvent(e: CalendarDetailsEvent): LiveEvent | null {
  const time = calTime(e.time);
  if (time === null) return null;
  const linkState = e.linkState === "one" || e.linkState === "several" ? e.linkState : "none";
  return {
    handle: e.handle,
    title: e.title,
    location: e.location,
    rowText: e.rowText,
    time,
    tentative: e.status === "tentative",
    ended: e.ended,
    linkState,
    joinHost: linkState === "one" ? e.joinHost : null,
    serviceName: linkState === "one" && e.serviceName !== undefined ? e.serviceName : null,
    needsConfirm: e.needsConfirm,
    fromMac: e.fromMac,
  };
}

/* ── the row match ────────────────────────────────────────────────────────────────────────────── */

/** The live events whose text equals the row's once the trailing marks are removed from both (the text comparator). */
function unmarkedHits(rowText: string, events: readonly LiveEvent[]): LiveEvent[] {
  const key = unmarked(rowText);
  return events.filter((e) => unmarked(e.rowText) === key);
}

/** The live event a row is, by text: the one match, `"several"`, or null. Used alone only for a handle-only live card's
 *  re-key (`cardView`); page rows are assigned once, together, by [`assignRows`]. */
export function rowMatch(rowText: string, events: readonly LiveEvent[]): LiveEvent | "several" | null {
  const hits = unmarkedHits(rowText, events);
  return hits.length === 1 ? hits[0]! : hits.length > 1 ? "several" : null;
}

/**
 * Calendar near-duplicates spec §5, "Row matching is one-to-one": the page's rows' live events, keyed by each row's index
 * among ALL of `rows` (status and "+N more" rows count, though only event, all-day and "time unclear" rows are assigned).
 *
 * In page order, a row takes the single untaken live event whose full text equals its own (merge mark included; both
 * without their trailing ` · ended`/` · tentative`, [`statusless`]); with
 * none, the single untaken one whose `unmarked` text equals its `unmarked` text. Two or more untaken candidates at the
 * step that would match it: the row ties and takes nothing. The k rows tying over the same m candidates: the first
 * min(k, m) in page order map to `"several"` (the page card; their candidates are drawn as live events), and the last
 * k − m (k > m) are left out of the map, like a row with no candidate. Missing means no assignment. Phase-free: only
 * drawing depends on the phase.
 */
export function assignRows(rows: readonly CalendarRow[], lives: readonly LiveEvent[]): Map<number, LiveEvent | "several"> {
  const out = new Map<number, LiveEvent | "several">();
  const taken = new Set<LiveEvent>();
  const ties = new Map<string, number[]>();
  rows.forEach((r, i) => {
    if (r.kind !== "event" && r.kind !== "allDay" && r.kind !== "unclear") return;
    const untaken = lives.filter((e) => !taken.has(e));
    const key = statusless(r.text);
    const exact = untaken.filter((e) => statusless(e.rowText) === key);
    const hits = exact.length > 0 ? exact : unmarkedHits(r.text, untaken);
    if (hits.length === 1) {
      out.set(i, hits[0]!);
      taken.add(hits[0]!);
    } else if (hits.length > 1) {
      const same = hits.map((e) => lives.indexOf(e)).join(",");
      ties.set(same, [...(ties.get(same) ?? []), i]);
    }
  });
  for (const [same, tied] of ties) {
    const m = same.split(",").length;
    for (const i of tied.slice(0, m)) out.set(i, "several");
  }
  return out;
}

/** What a row says after its time, marks removed: the title with its place, as the page writes it. */
export function whatOf(rowText: string): string {
  let t = rowText;
  if (t.startsWith("all day — ")) t = t.slice("all day — ".length);
  else if (t.startsWith("time unclear (") && t.includes(")  ")) t = t.slice(t.indexOf(")  ") + 3);
  else if (t.includes("  ")) t = t.slice(t.indexOf("  ") + 2);
  return unmarked(t);
}

/* ── the view ─────────────────────────────────────────────────────────────────────────────────── */

export type DetailPhase = "before" | "read" | "partial" | "failed" | "off";

/** A timed event the timeline, the subtitle, the bar and the tiles use: A's event, plus where it came from. */
export interface TimelineEvent extends CalendarEvent {
  /** The page's line for it (a page row's text, or the live event's `rowText`). */
  rowText: string;
  /** Its live event, or null for a page row. */
  live: LiveEvent | null;
  /** A page row kept after a partial read because no live event matches it (unconfirmed). */
  fallback: boolean;
  /** Its page-row identity (spec §5 "Row identity"): the index among the page's calendar rows of the row drawn (a page
   *  row, or a fallback), or of the row `rowLive` assigned this live event; null for a live event no row took (handle-only). */
  row: number | null;
}

/** An all-day or "time unclear" event, for the strip above the timeline. */
export interface StripItem {
  text: string;
  title: string;
  live: LiveEvent | null;
  fallback: boolean;
  /** As [`TimelineEvent`]'s `row`. */
  row: number | null;
}

/** `deckView`'s `live` field: everything clock-free the calendar surfaces draw. */
export interface CalendarDetailView {
  phase: DetailPhase;
  pageDate: string;
  /** An ask is outstanding and no list is held: "Reading your calendar…". */
  loading: boolean;
  /** The timed events, by start. */
  events: TimelineEvent[];
  strip: StripItem[];
  /** The live events (read and partial phases), for re-keying a card. */
  live: LiveEvent[];
  /** [`assignRows`] over the page's calendar rows and `live` (empty with no live events, or no page rows). */
  rowLive: Map<number, LiveEvent | "several">;
  /** The failure lines, each once (a source's own words, the off line). */
  lines: string[];
  readerOutdated: boolean;
  /** The read's local `HH:MM`, or null before a read. */
  readAt: string | null;
  macConfigured: boolean | null;
  /**
   * PB-M4: what a live calendar day's no-section view can say (spec §5's precedence): the last read did not answer
   * (`failed`), no calendar is connected (`sources: []`), every source failed (`allFailed`), an answer (`answered`), or
   * none yet (`waiting`). Null on a page with a calendar section, whose lines are C's, unchanged.
   */
  readState: "waiting" | "failed" | "noneConnected" | "allFailed" | "answered" | null;
}

function sourceName(s: { id: string; kind: string }): string {
  return s.kind === "macos" ? CALENDAR_MACOS_LABEL : s.id;
}

/** One source status's line, or null for `ok` and for a status this app has no words for. */
function statusLine(name: string, status: string, reason: string | undefined): string | null {
  if (status === "ok") return null;
  if (status === "offline" || reason === "unreachable") return OFFLINE_LINE;
  if (status === "timeout") return TIMEOUT_LINE;
  if (status === "denied") return DENIED_LINE;
  const words = (CALENDAR_STATUS_TEXT as Readonly<Record<string, string>>)[status];
  return words === undefined ? null : `${name}: ${words}`;
}

/** A source's line: its read status, or, skipped, its last status ("not read yet" with none). */
function sourceLine(s: CalendarDetailsSource): string | null {
  const name = sourceName(s);
  if (s.status !== undefined) return statusLine(name, s.status, s.reason);
  return s.last === null ? `${name}: ${NOT_READ_YET}` : statusLine(name, s.last.status, s.last.reason);
}

function phaseOf(d: CalendarDetail): DetailPhase {
  if (d.off) return "off";
  if (d.list === null) return "before";
  const sources = d.list.sources;
  // No source at all (nothing connected, or only the Mac source off a Mac) answers nothing: a page phase, so the
  // page's "No calendar is connected" stays drawn and never becomes "No events today" (`every` of none is true).
  if (!sources.some((s) => s.status === "ok" || s.status === "incomplete")) return "failed";
  return sources.every((s) => s.status === "ok") ? "read" : "partial";
}

/** The page's timed rows as timeline events with no live event, each with its row index: every one (`rowLive` null), or,
 *  after a partial read, as fallbacks, those `rowLive` has no entry for. */
function pageEvents(page: DeckPage, rowLive: ReadonlyMap<number, unknown> | null): TimelineEvent[] {
  return (page.calendar?.rows ?? []).flatMap((r, row): TimelineEvent[] =>
    r.kind === "event" && r.event !== null && rowLive?.has(row) !== true
      ? [{ ...r.event, rowText: r.text, live: null, fallback: rowLive !== null, row }]
      : [],
  );
}

/** The page's all-day and "time unclear" rows for the strip (C-M4-T12's row kinds), as [`pageEvents`] picks them. */
function pageStrip(page: DeckPage, rowLive: ReadonlyMap<number, unknown> | null): StripItem[] {
  return (page.calendar?.rows ?? []).flatMap((r, row): StripItem[] =>
    (r.kind === "allDay" || r.kind === "unclear") && rowLive?.has(row) !== true
      ? [{ text: r.text, title: r.title, live: null, fallback: rowLive !== null, row }]
      : [],
  );
}

function liveTimed(e: LiveEvent, pageDate: string, index: number | null): TimelineEvent | null {
  if (e.time.kind !== "timed") return null;
  const row = parseCalendarLine(e.rowText, pageDate);
  const parsed = row.kind === "event" ? row.event : null;
  return {
    title: parsed?.title ?? (e.title.trim() === "" ? CALENDAR_UNTITLED_TEXT : e.title),
    startMs: e.time.startMs,
    since: parsed?.since ?? null,
    endMs: e.time.endMs,
    tentative: e.tentative,
    ended: e.ended,
    rowText: e.rowText,
    live: e,
    fallback: false,
    row: index,
  };
}

/**
 * The live view for `page`, or null when the page has no calendar slide or is not today's (a stale page triggers no
 * read, C `:13`). Clock-free: the deck maps it once per change, never per tick.
 *
 * PB-M4 (spec §5): `liveDay` — today's page with no section while the calendar is "on" — gives the NO-SECTION view
 * instead of null: no page rows to fall back to, and `readState` says which line the slide, the launchpad's mood line
 * and Good morning draw. A page with a section ignores `liveDay` and is unchanged (`readState: null`).
 */
export function calendarDetailView(page: DeckPage, d: CalendarDetail, liveDay = false): CalendarDetailView | null {
  if (page.stale || (page.calendar === null && !liveDay)) return null;
  if (d.list !== null && !listOnDay(d.list, page.pageDate)) d = { ...d, list: null };
  const phase = phaseOf(d);
  const list = d.list;
  const lives = phase === "read" || phase === "partial" ? (list?.events ?? []).flatMap((e) => liveEvent(e) ?? []) : [];
  // One assignment over every page row (none on a live calendar day: `[]` gives an empty map, so every live item is
  // handle-only). A row with no entry is a fallback after a partial read and not drawn after a full one.
  const rowLive = assignRows(page.calendar?.rows ?? [], lives);
  const rowOf = new Map<LiveEvent, number>();
  for (const [i, m] of rowLive) if (m !== "several") rowOf.set(m, i);
  let events: TimelineEvent[];
  let strip: StripItem[];
  if (phase === "read" || phase === "partial") {
    const timed = lives.flatMap((e) => liveTimed(e, page.pageDate, rowOf.get(e) ?? null) ?? []);
    const fallbacks = phase === "partial" ? pageEvents(page, rowLive) : [];
    events = [...timed, ...fallbacks].sort((a, z) => a.startMs - z.startMs);
    strip = [
      ...lives
        .filter((e) => e.time.kind !== "timed")
        .map((e) => ({ text: e.rowText, title: whatOf(e.rowText), live: e, fallback: false, row: rowOf.get(e) ?? null })),
      ...(phase === "partial" ? pageStrip(page, rowLive) : []),
    ];
  } else {
    events = pageEvents(page, null);
    strip = pageStrip(page, null);
  }
  const readState = page.calendar !== null ? null : noSectionState(d, phase);
  const sourceLines = (): string[] => [...new Set((list?.sources ?? []).flatMap((s) => sourceLine(s) ?? []))];
  const lines =
    phase === "off"
      ? [OFF_LINE]
      : readState === "allFailed"
        ? [CALENDAR_UNAVAILABLE_TEXT, ...sourceLines()]
        : readState !== null && readState !== "answered"
          ? [liveDayLine(readState)!]
          : phase === "failed" || phase === "partial"
            ? sourceLines()
            : [];
  const readAtMs = list === null ? NaN : Date.parse(list.readAt);
  return {
    phase,
    pageDate: page.pageDate,
    loading: d.pending && d.list === null && !d.off,
    events,
    strip,
    live: lives,
    rowLive,
    lines,
    readerOutdated: list?.readerOutdated === true,
    readAt: Number.isFinite(readAtMs) ? clockTime(readAtMs) : null,
    macConfigured: d.macConfigured,
    readState,
  };
}

/**
 * The no-section view's read state, in spec §5's precedence (the first, "on" false, is the deck's: no slide):
 * a read that did not answer; then, with a list, `sources: []` (checked before `phaseOf`, which calls it `failed`);
 * every source failed; an answer. With no list, none yet.
 */
function noSectionState(d: CalendarDetail, phase: DetailPhase): NonNullable<CalendarDetailView["readState"]> {
  if (d.failed) return "failed";
  // Defensive: through Today this is not reached — a true calendar-off verdict (`applyCalendarOff`) patches the stored
  // status off before the driver sets `off`, so liveDay is already false and there is no slide. A caller that passes
  // `off` with liveDay true anyway reads unavailable with C's off line, never "waiting" (an off list is null) or a
  // free day.
  if (phase === "off") return "allFailed";
  if (d.list === null) return "waiting";
  if (d.list.sources.length === 0) return "noneConnected";
  return phase === "failed" ? "allFailed" : "answered";
}

/** The line a live calendar day draws for its read state (the slide's first line, and the launchpad's mood line when no
 *  git tile is waiting); null for an answer, and on a page with a section. */
export function liveDayLine(readState: CalendarDetailView["readState"]): string | null {
  switch (readState) {
    case "waiting":
      return LOADING_LINE;
    case "failed":
      return READ_FAILED_LINE;
    case "noneConnected":
      return CALENDAR_NOT_CONNECTED_TEXT;
    case "allFailed":
      return CALENDAR_UNAVAILABLE_TEXT;
    default:
      return null;
  }
}

/**
 * PB-M4 (spec §5, Screen readers): a read's new status line, for Today's polite announcement — a live calendar day's
 * line before an answer, else the first failure line (a source's own words, the off line), else the subtitle.
 */
export function readStatusLine(v: CalendarDetailView, now: number): string | null {
  return liveDayLine(v.readState) ?? v.lines[0] ?? subtitle(v, now);
}

/**
 * PB-M4: one announcement per completed read, only if focus is INSIDE the calendar slide when it completes. A completion
 * is consumed whether or not it is announced, so a later focus move or rerender never announces it again. `completion`
 * and `consumed` are identities (Today counts completed reads); `containsFocus` is Today's measurement of the
 * `[data-slide="calendar"]` element at completion.
 */
export function announceCompletion(i: { completion: number; consumed: number; containsFocus: boolean }): { consumed: number; announce: boolean } {
  if (i.completion === i.consumed) return { consumed: i.consumed, announce: false };
  return { consumed: i.completion, announce: i.containsFocus };
}

/** What Today's announcement effect carries between runs. */
export interface AnnounceState {
  /** The driver's `pending` on the last run. */
  wasPending: boolean;
  /** Completed reads seen in this mount (`pending` turning false). */
  completions: number;
  /** The last completion consumed (announced or not). */
  consumed: number;
}
export const ANNOUNCE_START: AnnounceState = Object.freeze({ wasPending: false, completions: 0, consumed: 0 });

/**
 * One run of Today's announcement effect (checkpoint MED): a COMPLETED READ is the driver's `pending` turning false;
 * it is announced once (`announceCompletion`) with `line`, the read's new status line, when focus is inside the
 * calendar slide. `text` is what to hand `nextLiveText`, or null.
 */
export function announceStep(prev: AnnounceState, pending: boolean, containsFocus: boolean, line: string | null): { next: AnnounceState; text: string | null } {
  const completions = prev.wasPending && !pending ? prev.completions + 1 : prev.completions;
  const step = announceCompletion({ completion: completions, consumed: prev.consumed, containsFocus });
  return { next: { wasPending: pending, completions, consumed: step.consumed }, text: step.announce ? line : null };
}

/* ── the meeting card ─────────────────────────────────────────────────────────────────────────── */

/** What a card was opened on: a row's text (a page row, or a live event's `rowText`), for a live event its handle, and its
 *  page-row identity (spec §5): the drawn item's `row` — a page row's index, or null for a handle-only live event. */
export interface CardKey {
  rowText: string;
  handle: string | null;
  row: number | null;
}

/** Carry a page card by statusless text (merge mark kept) and occurrence rank, only when its count is unchanged.
 *  A missing row becomes handle-only when the live-read re-key (by handle, else by text — today's rule, resolved
 *  WITHOUT the old row index, which may name another event on the new page) still finds one live event.
 *  The stored text never changes; handle-only cards keep the live-read re-key rules. */
export function carryOpenKey(key: CardKey | null, before: readonly string[], after: readonly string[], live: CalendarDetailView | null = null): CardKey | null {
  if (key === null || key.row === null) return key;
  const rekeyed = live === null ? null : cardView(live, { ...key, row: null });
  const handleOnly = rekeyed?.kind === "live" ? { ...key, handle: rekeyed.event.handle, row: null } : null;
  const oldText = before[key.row];
  if (oldText === undefined) return handleOnly;
  const text = statusless(oldText);
  const oldRows = before.map(statusless);
  const matches = after.flatMap((s, row) => statusless(s) === text ? [row] : []);
  if (matches.length === 0) return handleOnly;
  if (matches.length !== oldRows.filter((s) => s === text).length) return null;
  const rank = oldRows.slice(0, key.row).filter((s) => s === text).length;
  const row = matches[rank];
  if (row === undefined) return handleOnly;
  return row === key.row ? key : { ...key, row };
}

export type CardView =
  /** A live event: its own fields, Join, and (by handle, `calendar_details_get`) its people and notes. */
  | { kind: "live"; event: LiveEvent; footnote: string; lines: string[] }
  /** The page's facts: before a read (with the loading line while one is outstanding), after a whole-read failure or
   *  the off refusal (with their lines), or a row that matches several live events (no Join, no details). */
  | { kind: "page"; text: string; loading: boolean; lines: string[] }
  /** A page row with no live match after a read in which every source answered. */
  | { kind: "changed"; text: string }
  /** A page row kept after a partial read: the page's facts and the failed sources' lines. */
  | { kind: "fallback"; text: string; lines: string[] };

/** The card for `key` in `v`. After a read, a page row's card is its row's assignment (`rowLive`; never re-matched by
 *  text), and a handle-only live card keeps today's re-key: by handle, else by its text against the live events. */
export function cardView(v: CalendarDetailView, key: CardKey): CardView {
  if (v.phase === "read" || v.phase === "partial") {
    let m: LiveEvent | "several" | null;
    if (key.row !== null) m = v.rowLive.get(key.row) ?? null;
    else {
      const byHandle = key.handle === null ? undefined : v.live.find((e) => e.handle === key.handle);
      m = byHandle ?? rowMatch(key.rowText, v.live);
    }
    if (m !== null && m !== "several") {
      return {
        kind: "live",
        event: m,
        footnote: v.readAt === null ? "Read live · not saved" : `Read live at ${v.readAt} · not saved`,
        lines: v.readerOutdated ? [READER_OUTDATED_LINE] : [],
      };
    }
    if (m === "several") return { kind: "page", text: key.rowText, loading: false, lines: [] };
    return v.phase === "read" ? { kind: "changed", text: key.rowText } : { kind: "fallback", text: key.rowText, lines: v.lines };
  }
  return { kind: "page", text: key.rowText, loading: v.loading, lines: v.lines };
}

/**
 * Calendar near-duplicates spec §5, "Slide state": whether `b` (a drawn item's key) is the card `a` opened. An `a` with
 * a page row (non-null `row`) compares by row; a handle-only `a` by handle, whatever `b`'s row. Every read issues new handles, so a handle-only
 * `a` whose handle is not in `v.live` is the same card as `b` exactly when its own re-key (`cardView`, spec §5
 * "Live-event cards") is a live card on `b`'s handle; the page card, "changed" or "fallback" leaves nothing open.
 */
export function sameOpenCard(a: CardKey | null, b: CardKey, v: CalendarDetailView): boolean {
  if (a === null) return false;
  // Branch on `a` alone: a handle-only `a` may re-key to an item a row now carries (a tie last read, one match now).
  if (a.row !== null) return a.row === b.row;
  if (a.handle !== null && v.live.some((e) => e.handle === a.handle)) return a.handle === b.handle;
  const card = cardView(v, a);
  return card.kind === "live" && b.handle !== null && card.event.handle === b.handle;
}

/** The slide's open card after a click on `clicked`: closed (null) when it is the open card, else `clicked`. The stored
 *  key is never rewritten to follow a live-read re-key, so the card is not remounted (`MeetingCard` follows the new handle itself). */
export function toggleOpenCard(open: CardKey | null, clicked: CardKey, v: CalendarDetailView): CardKey | null {
  return sameOpenCard(open, clicked, v) ? null : clicked;
}

/** Open in Calendar (macOS only): after a read, for an event with a Mac copy; otherwise (loading, a failed read, a row
 *  the read did not confirm) hidden only when no `calendar.macos` source is configured (C "Open in Calendar"). */
export function openInCalendar(v: CalendarDetailView, card: CardView, os: Os): boolean {
  return os === "macos" && v.macConfigured !== false && (card.kind === "live" ? card.event.fromMac : true);
}

/** A list belongs to its read's local day, never to another page's day. */
export function listOnDay(list: Pick<LiveList, "readAt">, day: string): boolean {
  const at = Date.parse(list.readAt);
  return Number.isFinite(at) && localDate(new Date(at)) === day;
}

/** The instant a live event ends, for the data life: a timed end, an all-day event's next local midnight, and the end
 *  of the page's day for a "time unclear" one (its wall times are in another zone). */
export function eventEndMs(e: LiveEvent, pageDate: string): number {
  if (e.time.kind === "timed") return e.time.endMs;
  if (e.time.kind === "allDay") return dayBounds(e.time.endDateExclusive).start;
  return dayBounds(pageDate).end;
}

/** People and notes stay only while the event has not ended and the day has not changed (C "What the webview gets";
 *  closing the card drops them too, in the card itself). */
export function keepDetails(info: { endMs: number; day: string }, now: number): boolean {
  return now < info.endMs && localDate(new Date(now)) === info.day;
}

/**
 * One notes box on the meeting card (calendar near-duplicates spec §5, D1): `"core"` from the reply's `notes`, `"other"`
 * from an `otherNotes` entry. The card draws the **Other copy** heading from `kind` (never from `label`), then `title`
 * when non-null, then `notes` when non-null (a title-only box has none). `label` is the region's accessible name.
 */
export type NotesBox = { kind: "core" | "other"; title: string | null; notes: string | null; label: string };
/** The card's notes boxes, core first, then the others in merge order; empty means no boxes. */
export type NotesBoxList = NotesBox[];

export interface CardDetails {
  handle: string;
  people: PeopleLine;
  notes: NotesBoxList;
  endMs: number;
  day: string;
}

/** Reply guard and storage lifetime are independent of the reset and display guards below. */
export function cardDetailsReply(h: string, card: CardView, day: string, reply: CalendarDetailsGetReply, now: number):
  { kind: "drop" } | { kind: "stale" } | { kind: "details"; details: CardDetails } {
  if (card.kind !== "live" || h !== card.event.handle) return { kind: "drop" };
  const step = detailsStep(reply);
  if (step.kind === "stale") return step;
  const life = { endMs: eventEndMs(card.event, day), day };
  if (!keepDetails(life, now)) return { kind: "drop" };
  return { kind: "details", details: { handle: h, people: step.people, notes: step.notes, ...life } };
}

export function resetCardDetails(details: CardDetails | null, handle: string | null): CardDetails | null {
  return details?.handle === handle ? details : null;
}

export function expireCardDetails(details: CardDetails | null, now: number): CardDetails | null {
  return details !== null && keepDetails(details, now) ? details : null;
}

export function shownCardDetails(details: CardDetails | null, handle: string | null, now: number): CardDetails | null {
  return details !== null && details.handle === handle && keepDetails(details, now) ? details : null;
}

/* ── the people line ──────────────────────────────────────────────────────────────────────────── */

export interface PeopleLine {
  text: string;
  /** One chip per SHOWN name (none for the people folded into "and N more"). */
  chips: { initials: string; name: string }[];
}

const firstLetter = (w: string): string => (Array.from(w)[0] ?? "").toUpperCase();

/** "Priya Sharma" → "Priya S."; a one-word name whole. */
function shortName(words: string[]): string {
  if (words.length === 1) return words[0]!;
  return `${words[0]} ${Array.from(words[words.length - 1]!)[0] ?? ""}.`;
}

/**
 * The people line (C "People"; proposed cut and shortening): up to 4 people, every name; 5 or more, the first 3 names
 * and "and N more". The organiser first, marked " (organiser)". A person with no name always counts in "and N more".
 * You are left out by the engine, so an empty list is "Just you".
 */
export function peopleLine(people: readonly { name: string | null; organiser: boolean }[]): PeopleLine {
  if (people.length === 0) return { text: JUST_YOU, chips: [] };
  const limit = people.length <= 4 ? 4 : 3;
  const named = people
    .map((p) => ({ words: (p.name ?? "").trim().split(/\s+/).filter((w) => w !== ""), organiser: p.organiser }))
    .filter((p) => p.words.length > 0);
  const ordered = [...named.filter((p) => p.organiser), ...named.filter((p) => !p.organiser)].slice(0, limit);
  const chips = ordered.map((p) => ({
    initials: firstLetter(p.words[0]!) + (p.words.length > 1 ? firstLetter(p.words[p.words.length - 1]!) : ""),
    name: shortName(p.words),
  }));
  const more = people.length - ordered.length;
  if (ordered.length === 0) return { text: `${more} ${more === 1 ? "person" : "people"}`, chips: [] };
  const names = ordered.map((p, i) => `${chips[i]!.name}${p.organiser ? " (organiser)" : ""}`).join(", ");
  return { text: more > 0 ? `${names} and ${more} more` : names, chips };
}

/* ── Join ─────────────────────────────────────────────────────────────────────────────────────── */

/** The four known services' product names, by host (the engine's `KNOWN`, `src/calendar/join.ts`, names them; a
 *  known host is one Rust marks as needing no question). */
const PRODUCTS: readonly { name: string; host: (h: string) => boolean }[] = [
  { name: "Zoom", host: (h) => h === "zoom.us" || h.endsWith(".zoom.us") || h === "zoomgov.com" || h.endsWith(".zoomgov.com") },
  { name: "Google Meet", host: (h) => h === "meet.google.com" },
  { name: "Teams", host: (h) => h === "teams.microsoft.com" || h === "teams.live.com" },
  { name: "Webex", host: (h) => h.endsWith(".webex.com") },
];

/** The name a Join names: the product for a known host, the service for a notes-list one, else the bare host; null
 *  when the event has no usable link. */
export function joinName(e: LiveEvent): string | null {
  if (e.linkState !== "one" || e.joinHost === null) return null;
  if (e.serviceName !== null) return e.serviceName;
  const host = e.joinHost;
  return (!e.needsConfirm ? PRODUCTS.find((p) => p.host(host))?.name : undefined) ?? host;
}

/** The launchpad tile's Join: "Join ↗" before the meeting, "Join now on {name} ↗" while it is on; null with no link. */
export function tileJoinLabel(e: LiveEvent, on: boolean): string | null {
  const name = joinName(e);
  if (name === null) return null;
  return on ? `Join now on ${name} ↗` : CARD_JOIN_LABEL;
}

/** The ask-first question for `calendarJoin`'s `{ ask, serviceName? }` (hub item 3; proposed wording). */
export function askQuestion(r: { ask: string; serviceName?: string }): string {
  return r.serviceName !== undefined ? `Open this ${r.serviceName} link on ${r.ask}?` : `Open this link on ${r.ask}?`;
}

/* ── the timeline's geometry ──────────────────────────────────────────────────────────────────── */

/** The page's day, between its two LOCAL midnights (23 or 25 hours on a clocks-change day). */
export function dayBounds(pageDate: string): { start: number; end: number } {
  const [y, m, d] = pageDate.split("-").map(Number) as [number, number, number];
  return { start: new Date(y, m - 1, d).getTime(), end: new Date(y, m - 1, d + 1).getTime() };
}

/** One mark per wall hour the day has (none for an hour the clocks skip), at its real distance from midnight. */
export function hourMarks(pageDate: string): { label: string; at: number }[] {
  const [y, m, d] = pageDate.split("-").map(Number) as [number, number, number];
  const { start } = dayBounds(pageDate);
  const out: { label: string; at: number }[] = [];
  for (let h = 0; h < 24; h += 1) {
    const t = new Date(y, m - 1, d, h).getTime();
    if (new Date(t).getHours() !== h) continue;
    out.push({ label: `${String(h).padStart(2, "0")}:00`, at: t - start });
  }
  return out;
}

/** An event's span on the day's timeline, clipped to the day, in ms from local midnight, with the day's length; null
 *  when none of it falls on the day. The component turns these into positions with a geometry helper. */
export function timelineSpan(startMs: number, endMs: number, pageDate: string): { from: number; to: number; day: number } | null {
  const { start, end } = dayBounds(pageDate);
  const onDay = startMs === endMs ? startMs >= start && startMs < end : startMs < end && endMs > start;
  if (!onDay) return null;
  return { from: Math.max(startMs, start) - start, to: Math.min(endMs, end) - start, day: end - start };
}

/* ── the subtitle and the countdown ───────────────────────────────────────────────────────────── */

export type Countdown = { kind: "now" } | { kind: "next"; minutes: number } | { kind: "none" };

/** "now" while a meeting runs, the minutes to the next one today, or none after the last. */
export function countdown(v: CalendarDetailView, now: number): Countdown {
  const next = nextMeeting(v.pageDate, v.events, now);
  if (next === null) return { kind: "none" };
  const minutes = Math.ceil((next.startMs - now) / MIN);
  return next.startMs <= now || minutes <= 0 ? { kind: "now" } : { kind: "next", minutes };
}

/** The union of the timed events' spans on the day (an overlap counts once), in ms. */
function busyMs(v: CalendarDetailView): number {
  const spans = v.events
    .flatMap((e) => timelineSpan(e.startMs, e.endMs, v.pageDate) ?? [])
    .sort((a, z) => a.from - z.from);
  let total = 0;
  let edge = -Infinity;
  for (const s of spans) {
    const from = Math.max(s.from, edge);
    if (s.to > from) total += s.to - from;
    edge = Math.max(edge, s.to);
  }
  return total;
}

function duration(ms: number): string {
  const total = Math.round(ms / MIN);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "N events · Xh Ym in meetings · next in N minutes" (C `:14`): the timed events only; all-day ones are left out.
 *  "No events today" for a day with no event at all; null (no subtitle) when the only events are all-day or "time
 *  unclear" ones, which the strip shows (the slide also hides it over the page's status rows). */
export function subtitle(v: CalendarDetailView, now: number): string | null {
  // PB-M4: a live calendar day's view before an answer has no subtitle (its line says why); never "No events today".
  if (v.readState !== null && v.readState !== "answered") return null;
  const n = v.events.length;
  if (n === 0) return v.strip.length > 0 ? null : CALENDAR_NO_EVENTS_TEXT;
  const c = countdown(v, now);
  const when =
    c.kind === "now" ? "now" : c.kind === "next" ? `next in ${c.minutes} ${c.minutes === 1 ? "minute" : "minutes"}` : "no more meetings today";
  return `${n} ${n === 1 ? "event" : "events"} · ${duration(busyMs(v))} in meetings · ${when}`;
}

/* ── C-M5-T13: what the screens draw, as pure pieces ──────────────────────────────────────────── */

/** A row's time, as the page writes it ("09:00–09:30", "since yesterday → 02:00", "all day", "time unclear (…)"); "" for
 *  a line with no time. Every surface draws an event's time from its row text, so a live event and a page row read alike. */
export function timeOf(rowText: string): string {
  if (rowText.startsWith("all day — ")) return "all day";
  const unclear = /^(time unclear \(.*?\)) {2}/.exec(rowText);
  if (unclear !== null) return unclear[1]!;
  const cut = rowText.indexOf("  ");
  return cut === -1 ? "" : rowText.slice(0, cut);
}

/** One of a row's trailing marks: a key-c merge's mark (calendar near-duplicates, spec §6), tentative or ended. */
export type RowMark = MergeMark | "tentative" | "ended";

/** The row's trailing marks, in page order: the merge mark first, then tentative, then ended (C: tentative and ended
 *  events say so, as the page's lines do; spec §6: so does a merged event). */
export function marksOf(rowText: string): RowMark[] {
  const ended = rowText.endsWith(" · ended");
  const tentative = rowText.endsWith(ended ? " · tentative · ended" : " · tentative");
  const merge = splitMergeMark(statusless(rowText)).mark;
  return [...(merge !== null ? [merge] : []), ...(tentative ? (["tentative"] as const) : []), ...(ended ? (["ended"] as const) : [])];
}

/** A mark in the page's words, as drawn after ` · `: "on N calendars", "N copies", "tentative" or "ended". */
export function markWords(mark: RowMark): string {
  if (typeof mark === "string") return mark;
  return mark.kind === "calendars" ? `on ${mark.count} calendars` : `${mark.count} copies`;
}

/** One event block on the timeline: its span in ms from local midnight, and its lane among the events it overlaps. */
export interface TimelineBlock {
  e: TimelineEvent;
  from: number;
  to: number;
  lane: number;
  lanes: number;
}

export interface TimelineLayout {
  /** The window drawn, in ms from local midnight: from a whole hour to a whole hour. */
  from: number;
  len: number;
  /** The hour marks inside the window, at their real distance from midnight (a clocks-change day included). */
  marks: { label: string; at: number }[];
  blocks: TimelineBlock[];
  /** The "now" line, in ms from local midnight; null off the page's day or outside the window. */
  nowAt: number | null;
}

/** Side-by-side lanes: at most this many (a ninth overlapping event shares the last). */
const MAX_LANES = 8;
/** The minimum duration reserved by lanes AND drawn by CalendarSlide (37.5 minutes is 1.5rem at 2.4rem/hour). */
export const TIMELINE_MIN_BLOCK_MS = 37.5 * MIN;
/** Where a block's drawn height ends: its real end, or its start plus the minimum (the lanes and the window use it). */
const drawnEnd = (s: { from: number; to: number }): number => Math.max(s.to, s.from + TIMELINE_MIN_BLOCK_MS);

/**
 * The timeline's layout (C "Day timeline"): the window is 08:00 to 18:00, widened to whole hours to hold every event
 * as drawn, its minimum height included (proposed, checked in the screenshot pass; the day's end still bounds it);
 * positions are ms from the local midnight, so the component turns them into clamped percentages (`ui/geometry.ts`). Events that overlap are drawn side by side, one lane each.
 */
export function timelineLayout(v: CalendarDetailView, now: number): TimelineLayout {
  const { start, end } = dayBounds(v.pageDate);
  const [y, m, d] = v.pageDate.split("-").map(Number) as [number, number, number];
  const spans = v.events.flatMap((e) => {
    const s = timelineSpan(e.startMs, e.endMs, v.pageDate);
    return s === null ? [] : [{ e, from: s.from, to: s.to }];
  });
  const lo = Math.min(new Date(y, m - 1, d, 8).getTime() - start, ...spans.map((s) => s.from));
  const hi = Math.max(new Date(y, m - 1, d, 18).getTime() - start, ...spans.map(drawnEnd));
  const all = hourMarks(v.pageDate);
  const from = [...all].reverse().find((h) => h.at <= lo)?.at ?? 0;
  const to = all.find((h) => h.at >= hi)?.at ?? end - start;
  const marks = all.filter((h) => h.at >= from && h.at <= to);
  if (to === end - start && marks.at(-1)?.at !== to) marks.push({ label: "24:00", at: to });
  // Lanes: in start order, each event takes the lowest lane free at its start; a cluster of overlapping events shares
  // its lane count.
  const blocks: TimelineBlock[] = [];
  let cluster: TimelineBlock[] = [];
  let clusterEnd = -Infinity;
  const laneEnds: number[] = [];
  const close = (): void => {
    const lanes = Math.min(MAX_LANES, Math.max(1, ...cluster.map((b) => b.lane + 1)));
    for (const b of cluster) b.lanes = lanes;
    cluster = [];
    laneEnds.length = 0;
  };
  for (const s of [...spans].sort((a, z) => a.from - z.from || a.to - z.to)) {
    const busyTo = drawnEnd(s);
    if (s.from >= clusterEnd) {
      close();
      clusterEnd = -Infinity;
    }
    let lane = laneEnds.findIndex((t) => t <= s.from);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = busyTo;
    const b: TimelineBlock = { e: s.e, from: s.from, to: s.to, lane: Math.min(lane, MAX_LANES - 1), lanes: 1 };
    blocks.push(b);
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, busyTo);
  }
  close();
  const nowAt = now >= start + from && now <= start + to && now < end ? now - start : null;
  return { from, len: to - from, marks, blocks, nowAt };
}

/** C-M5-T14: the events the launchpad's meeting tile and Good morning's "Next meeting" tile are built from (round-5
 *  item C8): the page's rows before a read and after a whole-read failure (A's tiles), the live events once a read has
 *  answered (a cancelled meeting leaves, a new one appears; after a partial read the fallback rows stay too). */
export function tileEvents(page: DeckPage, live: CalendarDetailView | null): CalendarEvent[] {
  if (live !== null && (live.phase === "read" || live.phase === "partial")) return live.events;
  return page.calendar?.events ?? [];
}

/** The live event behind a tile's event (its Join), or null for a page row. */
export function liveOf(live: CalendarDetailView | null, e: CalendarEvent): LiveEvent | null {
  return live?.events.find((t) => t === e)?.live ?? null;
}

/** The card's title, time, place and marks: a live event's own fields (its time from its row text), or a page row's text
 *  split into what and when (the page writes the place inside the title, "Standup (Room 4)"). */
export function cardFacts(card: CardView): { title: string; when: string; place: string | null; marks: RowMark[] } {
  if (card.kind === "live") {
    const e = card.event;
    return { title: e.title.trim() === "" ? CALENDAR_UNTITLED_TEXT : e.title, when: timeOf(e.rowText), place: e.location, marks: marksOf(e.rowText) };
  }
  return { title: whatOf(card.text), when: timeOf(card.text), place: null, marks: marksOf(card.text) };
}

/** What a Join answer means for the button: the ask-first question, a stale handle (one `focus` refreshes the list), or
 *  a fixed failure line, or nothing to show (opened, several links or no link). */
export type JoinStep = { kind: "opened" } | { kind: "ask"; question: string } | { kind: "stale" } | { kind: "none" } | { kind: "failed"; line: string };

export function joinStep(r: CalendarJoinReply): JoinStep {
  if ("opened" in r) return { kind: "opened" };
  if ("ask" in r) return { kind: "ask", question: askQuestion(r) };
  if ("refused" in r && r.refused === "stale") return { kind: "stale" };
  if ("failed" in r && r.failed === "opener") return { kind: "failed", line: JOIN_OPENER_LINE };
  if ("refused" in r && r.refused === "invalid-link") return { kind: "failed", line: JOIN_INVALID_LINE };
  return { kind: "none" };
}

/** Simple: one pure Join flow, used by the card, bar and tile through JoinButton. No IPC or DOM here. */
export interface JoinModel {
  handle: string;
  revision: number;
  busy: boolean;
  state: { kind: "idle" } | { kind: "asking"; handle: string; question: string } | { kind: "done" } | { kind: "failed"; line: string };
}
export interface JoinCall { handle: string; confirmed: boolean; revision: number }
export const idleJoin = (handle: string): JoinModel => ({ handle, revision: 0, busy: false, state: { kind: "idle" } });

export function joinHandle(m: JoinModel, handle: string): JoinModel {
  return m.handle === handle ? m : { ...idleJoin(handle), revision: m.revision + 1 };
}

export function joinClick(m: JoinModel, yes = false): { model: JoinModel; call: JoinCall | null } {
  if (m.busy || (yes && (m.state.kind !== "asking" || m.state.handle !== m.handle))) return { model: m, call: null };
  const handle = yes && m.state.kind === "asking" ? m.state.handle : m.handle;
  const revision = m.revision + 1;
  return { model: { ...m, revision, busy: true, state: { kind: "idle" } }, call: { handle, confirmed: yes, revision } };
}

export function dismissJoin(m: JoinModel): JoinModel {
  return { ...m, state: { kind: "idle" } };
}

export function joinReply(m: JoinModel, call: JoinCall, reply: CalendarJoinReply | null): { model: JoinModel; stale: boolean } {
  if (m.handle !== call.handle || m.revision !== call.revision) return { model: m, stale: false };
  const step = reply === null ? { kind: "none" as const } : joinStep(reply);
  const state: JoinModel["state"] = step.kind === "ask" ? { kind: "asking", handle: call.handle, question: step.question }
    : step.kind === "failed" ? step : { kind: "done" };
  return { model: { ...m, busy: false, state }, stale: step.kind === "stale" };
}

/** A card's people and notes boxes by handle (`calendar_details_get`), or a stale handle. */
export type DetailsStep = { kind: "details"; people: PeopleLine; notes: NotesBoxList } | { kind: "stale" };

export function detailsStep(r: CalendarDetailsGetReply): DetailsStep {
  if ("refused" in r) return { kind: "stale" };
  return {
    kind: "details",
    people: r.people === null ? { text: DETAILS_UNAVAILABLE_LINE, chips: [] } : peopleLine(r.people),
    notes: notesBoxes(r.notes, r.otherNotes ?? []),
  };
}

/**
 * Spec §5's notes boxes: the core box when the core's notes are not blank; then each other entry, its body dropped when
 * blank or a repeat of a box already shown, and the entry not drawn at all when that leaves no body and no title.
 */
function notesBoxes(coreNotes: string | null, others: readonly { title: string | null; notes: string }[]): NotesBoxList {
  const out: NotesBoxList = [];
  const shown = new Set<string>();
  const body = notesText(coreNotes);
  if (body !== null) {
    out.push({ kind: "core", title: null, notes: body, label: "Notes" });
    shown.add(body);
  }
  for (const o of others) {
    const text = notesText(o.notes);
    const notes = text === null || shown.has(text) ? null : text;
    if (notes === null && o.title === null) continue;
    if (notes !== null) shown.add(notes);
    out.push({ kind: "other", title: o.title, notes, label: o.title === null ? "Notes from other copy" : `Notes from other copy: ${o.title}` });
  }
  return out;
}

/** A box's text: the notes in full without trailing whitespace (the box scrolls; no cut), or null when blank. */
export function notesText(notes: string | null): string | null {
  if (notes === null) return null;
  const text = notes.replace(/\s+$/, "");
  return text.trim() === "" ? null : text;
}
