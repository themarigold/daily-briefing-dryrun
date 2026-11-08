// src/calendar/budget.ts — the calendar block's CAPS and BUDGET, and the BUSY line (v0.3.0, plan M3a; spec r4
// §6 "Prompt block").
//
// Pure. It decides WHAT the prompt's calendar block keeps; it does not decide what an event line SAYS — that
// is M3b's, in two variants (locked and unlocked), passed in as `formatEvent`. So the one budget engine
// serves both variants, and M3b can measure each candidate line exactly as it will be sent.
//
// The rules (spec §6):
//   • the block is at most 10% of `tokenBudget.maxChars` and never more than 12,000 characters;
//   • an allowance under 400 characters gets the single line `CALENDAR_OMITTED_LINE`; under that line's own
//     length, no block at all (the rendered section still shows the day — M4);
//   • the fixed lines (the header and the source notices, and any "No events today" statement) and a possible
//     `BUSY:` line are reserved first, at most 3,000 characters together; event lines get the rest;
//   • at most 40 events, chosen in CAP ORDER — upcoming events first, then ended ones, each in display order, and
//     every distinct event before a further repeat of one series (fix-round 1, `calSeriesRepeats`);
//   • over the cap: drop every description, then every attendee list, then events from the end of the cap
//     order;
//   • when any event is dropped (by the 40 cap or by the budget), a `BUSY:` line carries today's merged busy
//     intervals — coarsened to 30-minute slots if the line would exceed 1,200 characters — and the fixed
//     sentence "the list is incomplete; do not call any time free outside the BUSY line". If the reserved
//     lines cannot fit, the block is the omitted line: a truncated list without its BUSY line could get a
//     busy hour called free.
// The per-field caps (title/location 120, description 400) were applied once at read time (`./clean.ts`);
// `capAttendees` is the "10 attendees then +N" rule for M3b's formatter.
import { calendarToday, localMidnight, overlapsToday } from "./reconcile";
import { calendarClockChangeMark } from "./render-contract";
import type { CalDate, CalEvent } from "./types";

/** At most this share of `tokenBudget.maxChars` … */
export const CALENDAR_BUDGET_SHARE = 0.1;
/** … and never more than this many characters. */
export const CALENDAR_BLOCK_MAX = 12_000;
/** Below this allowance the block is `CALENDAR_OMITTED_LINE` alone. */
export const CALENDAR_BLOCK_MIN = 400;
/** The fixed lines and a possible BUSY line, together, at most. */
export const CALENDAR_RESERVE_MAX = 3_000;
/** Events in the block, at most. */
export const CALENDAR_MAX_EVENTS = 40;
/** Attendees named on an event line before "+N". */
export const CALENDAR_MAX_ATTENDEES = 10;
/** A BUSY line longer than this is coarsened to 30-minute slots. */
export const CALENDAR_BUSY_MAX = 1_200;

/** The whole block when the allowance is under `CALENDAR_BLOCK_MIN` (spec §6, verbatim). */
export const CALENDAR_OMITTED_LINE = "TODAY'S CALENDAR omitted: prompt budget too small";
/** Ends every BUSY line (spec §6, verbatim). */
export const CALENDAR_BUSY_TAIL = "the list is incomplete; do not call any time free outside the BUSY line";

/** The calendar's share of the prompt budget, in characters (spec §6). A non-finite or negative budget
 *  allows nothing. */
export function calendarAllowance(maxChars: number): number {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return 0;
  return Math.min(Math.floor(maxChars * CALENDAR_BUDGET_SHARE), CALENDAR_BLOCK_MAX);
}

/** "10 attendees then +N": the first `max` items and how many more there were. */
export function capAttendees<T>(items: readonly T[], max: number = CALENDAR_MAX_ATTENDEES): { shown: T[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}

/** Had the event already ended at `nowMs`? A timed event when its end is not after now (a zero-length one
 *  once its moment has come); an all-day one once its last day is over; an unclear-time one never (its
 *  zone is unknown — it must not be written off). The same rule decides `CalendarStructEvent.ended` (M4). */
export function calEventEnded(ev: Pick<CalEvent, "time">, nowMs: number): boolean {
  switch (ev.time.kind) {
    case "timed": return ev.time.endMs <= nowMs;
    case "allDay": try { return localMidnight(ev.time.endDateExclusive) <= nowMs; } catch { return false; }   // malformed: not ended
    case "unclear": return false;
  }
}

// ── the BUSY line ────────────────────────────────────────────────────────────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, "0");
const HALF_HOUR_MS = 30 * 60_000;

/** `HH:MM` in the local zone; the end of the day is `24:00`. */
function hhmm(ms: number, dayEndMs: number): string {
  if (ms >= dayEndMs) return "24:00";
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** The local half-hour slot boundary at or before `ms` (local wall clock, so a :45-offset zone still gets
 *  :00 and :30 slots). */
function floorHalfHour(ms: number): number {
  const d = new Date(ms);
  return ms - ((d.getMinutes() % 30) * 60_000 + d.getSeconds() * 1000 + d.getMilliseconds());
}
function ceilHalfHour(ms: number): number {
  const f = floorHalfHour(ms);
  return f === ms ? ms : f + HALF_HOUR_MS;
}

type Interval = [number, number];

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** The `BUSY:` line for today (spec §6): every event that blocks time — anything not marked free, whatever
 *  your answer (an invitation you have not answered is not free time) — merged into intervals clipped to
 *  today. An all-day busy event makes the whole day busy. An unclear-time event is counted, never placed:
 *  its zone is unknown, and it never counts as free time. Coarsened to 30-minute slots when the line would
 *  exceed `CALENDAR_BUSY_MAX`; coarsened, a day has at most 25 intervals (a 25-hour DST day), so the line is
 *  bounded far below the cap whatever the input. `events` are today's reconciled events. */
export function calendarBusyLine(events: readonly CalEvent[], runDate: CalDate): string {
  const day = calendarToday(runDate);
  const intervals: Interval[] = [];
  let allDay = false, unclear = 0;
  for (const ev of events) {
    if (ev.transparency === "free" || ev.status === "cancelled" || ev.selfStatus === "declined") continue;
    if (!overlapsToday(ev.time, runDate)) continue;
    if (ev.time.kind === "allDay") allDay = true;
    else if (ev.time.kind === "unclear") unclear++;
    else {
      const s = Math.max(ev.time.startMs, day.startMs), e = Math.min(ev.time.endMs, day.endMs);
      if (e > s) intervals.push([s, e]);
    }
  }
  const tail = (body: string): string => {
    const more = unclear === 0 || allDay ? "" : `, plus ${unclear} event${unclear === 1 ? "" : "s"} at an unclear time`;
    return `BUSY: ${body}${more} — ${CALENDAR_BUSY_TAIL}`;
  };
  const render = (list: Interval[]): string =>
    // Final harden r3: an interval across a DST change carries the mark — the fall-back hour never reads backwards.
    list.length === 0 ? "none listed" : list.map(([s, e]) => `${hhmm(s, day.endMs)}–${hhmm(e, day.endMs)}${calendarClockChangeMark(s, e)}`).join(", ");
  if (allDay) return tail("all day");
  const exact = mergeIntervals(intervals);
  const line = tail(render(exact));
  if (line.length <= CALENDAR_BUSY_MAX) return line;
  const coarse = mergeIntervals(exact.map(([s, e]) => [Math.max(floorHalfHour(s), day.startMs), Math.min(ceilHalfHour(e), day.endMs)]));
  return tail(render(coarse));
}

// ── the block ────────────────────────────────────────────────────────────────────────────────────────

/** How much of an event the line may carry. Degradation turns `description`, then `attendees`, off. */
export type CalLineDetail = { description: boolean; attendees: boolean };

/** M3b's line formatter: one event, at a detail level, ended or not → one line (no newline in it). */
export type CalEventLineFormatter = (ev: CalEvent, detail: CalLineDetail & { ended: boolean }) => string;

export type CalendarBlockInput = {
  /** Today's events from `reconcileCalendar`: merged, filtered, in display order. */
  events: readonly CalEvent[];
  runDate: CalDate;
  /** Generation time, for "(ended)" and the cap order. */
  nowMs: number;
  /** `tokenBudget.maxChars`. */
  maxChars: number;
  /** Always kept, first, in this order: the header, the source notices, and M3b's "No events today" line
   *  when there are no events. */
  fixedLines: readonly string[];
  formatEvent: CalEventLineFormatter;
};

export type CalendarBlockPlan =
  /** The allowance is smaller than the omitted line: no block at all. */
  | { kind: "none"; text: "" }
  /** The block is `CALENDAR_OMITTED_LINE` alone. */
  | { kind: "omitted"; text: string }
  | {
      kind: "block";
      /** `lines.join("\n")` — what goes into the prompt. */
      text: string;
      lines: string[];
      /** The events kept, in block order (cap order), and the detail they were formatted at. */
      shown: CalEvent[];
      detail: CalLineDetail;
      /** Events left out (by the 40 cap or the budget); a BUSY line is present exactly when this is > 0. */
      dropped: number;
      busyLine?: string;
    };

const LEVELS: readonly CalLineDetail[] = [
  { description: true, attendees: true },
  { description: false, attendees: true },
  { description: false, attendees: false },
];

/** Characters `lines` take joined by newlines. */
const joinedLength = (lines: readonly string[]): number =>
  lines.length === 0 ? 0 : lines.reduce((n, l) => n + l.length, 0) + lines.length - 1;

/** Fix-round 1: is each event a FURTHER occurrence of a series already met earlier in `events` (the same `uid`)?
 *  An event with no uid is never a repeat. Used to rank distinct events before further repeats of one series, in
 *  the prompt block (`capOrder`) and the rendered section (`toCalendarStruct`), so one many-times-a-day invite
 *  cannot push real meetings out of either. */
export function calSeriesRepeats(events: readonly Pick<CalEvent, "uid">[]): boolean[] {
  const seen = new Set<string>();
  return events.map((ev) => {
    if (ev.uid === undefined) return false;
    if (seen.has(ev.uid)) return true;
    seen.add(ev.uid);
    return false;
  });
}

/** The events in CAP ORDER (spec §6): upcoming first, then ended, each keeping display order — and (fix-round 1)
 *  every DISTINCT event ahead of any further repeat of a series (`calSeriesRepeats` over that order, so a series is
 *  represented by its first upcoming occurrence when it has one). */
export function capOrder(events: readonly CalEvent[], nowMs: number): { ev: CalEvent; ended: boolean }[] {
  const tagged = events.map((ev) => ({ ev, ended: calEventEnded(ev, nowMs) }));
  const order = [...tagged.filter((x) => !x.ended), ...tagged.filter((x) => x.ended)];
  const repeat = calSeriesRepeats(order.map((x) => x.ev));
  return [...order.filter((_, i) => !repeat[i]), ...order.filter((_, i) => repeat[i])];
}

/** Plan the prompt's calendar block (spec §6 caps): which events it keeps, at what detail, and whether a
 *  BUSY line stands in for the ones it drops. See the header for the rules. */
export function planCalendarBlock(input: CalendarBlockInput): CalendarBlockPlan {
  const allowance = calendarAllowance(input.maxChars);
  if (allowance < CALENDAR_OMITTED_LINE.length) return { kind: "none", text: "" };
  const omitted = { kind: "omitted", text: CALENDAR_OMITTED_LINE } as const;
  if (allowance < CALENDAR_BLOCK_MIN) return omitted;

  const fixed = [...input.fixedLines];
  const reserveLimit = Math.min(CALENDAR_RESERVE_MAX, allowance);
  const ordered = capOrder(input.events, input.nowMs);
  const base = ordered.slice(0, CALENDAR_MAX_EVENTS);
  const fmt = (detail: CalLineDetail) => base.map((x) => input.formatEvent(x.ev, { ...detail, ended: x.ended }));
  const block = (lines: string[], shown: number, detail: CalLineDetail, busyLine?: string): CalendarBlockPlan => ({
    kind: "block", text: lines.join("\n"), lines, shown: base.slice(0, shown).map((x) => x.ev), detail,
    dropped: ordered.length - shown, ...(busyLine !== undefined ? { busyLine } : {}),
  });

  // Over 40 events, some are dropped whatever the budget, so the BUSY line is reserved from the start.
  let busy = ordered.length > base.length ? calendarBusyLine(input.events, input.runDate) : undefined;
  const reserved = (): string[] => (busy === undefined ? fixed : [...fixed, busy]);
  if (joinedLength(reserved()) > reserveLimit) return omitted;

  for (const detail of LEVELS) {
    const lines = [...reserved(), ...fmt(detail)];
    if (joinedLength(lines) <= allowance) return block(lines, base.length, detail, busy);
  }

  // Still over: drop events from the end of the cap order, at the lowest detail, behind a BUSY line.
  busy ??= calendarBusyLine(input.events, input.runDate);
  const head = reserved();
  if (joinedLength(head) > reserveLimit) return omitted;
  const detail = LEVELS[LEVELS.length - 1]!;
  const lines = [...head];
  let used = joinedLength(head), kept = 0;
  for (const line of fmt(detail)) {
    if (used + 1 + line.length > allowance) break;
    lines.push(line); used += 1 + line.length; kept++;
  }
  return block(lines, kept, detail, busy);
}
