/**
 * Briefing redesign C, wave-2 plan C-M4-T10 — `src/lib/calendar-detail.ts`, the calendar slide's live detail as pure
 * models: the timeline's geometry, the subtitle and its countdown, the row match, the post-read and partial-read
 * models, the failure lines, the people line, the Join labels and the ask-first question, and the data life.
 *
 * ⚠ THE PAGES ARE THE ENGINE'S. Each page is rendered by the engine's own `renderBriefing` from a calendar struct, and
 * each live event's `rowText` by the engine's own `calEventLine` (imported READ-ONLY, as `deck.check.ts` does), so the
 * row match is tested against the bytes the two sides really produce.
 *
 * ⚠ PLAIN TEXT ONLY: every string these models return is drawn as a text node; none is a link or a URL (the replies
 * carry no URL at all, only a Join host).
 */
import { describe, expect, test } from "bun:test";

import { calEventLine, renderBriefing } from "../../src/render";
import type { BriefingStruct as EngineStruct } from "../../src/types";

import { renderMarkdown } from "../src/lib/briefing-md";
import { CALENDAR_STATUS_TEXT, type CalendarStruct, type CalendarStructEvent, type CalendarStructSource } from "../src/lib/calendar-contract";
import {
  askQuestion,
  assignRows,
  cardDetailsReply,
  expireCardDetails,
  resetCardDetails,
  shownCardDetails,
  idleJoin,
  joinClick,
  joinHandle,
  joinReply,
  dismissJoin,
  JOIN_OPENER_LINE,
  JOIN_INVALID_LINE,
  type CardDetails,
  calendarDetailView,
  CARD_JOIN_LABEL,
  cardFacts,
  cardView,
  carryOpenKey,
  CHANGED_LINE,
  countdown,
  dayBounds,
  DENIED_LINE,
  detailsStep,
  eventEndMs,
  hourMarks,
  joinStep,
  keepDetails,
  liveEvent,
  liveOf,
  LOADING_LINE,
  marksOf,
  markWords,
  NO_DETAIL,
  notesText,
  OFF_LINE,
  OFFLINE_LINE,
  openInCalendar,
  peopleLine,
  READER_OUTDATED_LINE,
  rowMatch,
  sameOpenCard,
  SEVERAL_LINKS_LINE,
  subtitle,
  tileEvents,
  tileJoinLabel,
  timelineLayout,
  TIMEOUT_LINE,
  timelineSpan,
  TIMELINE_MIN_BLOCK_MS,
  timeOf,
  toggleOpenCard,
  type CalendarDetail,
  type CardKey,
  type CalendarDetailView,
} from "../src/lib/calendar-detail";
import { ANNOUNCE_START, announceCompletion, announceStep, liveDayLine, READ_FAILED_LINE, readStatusLine, type AnnounceState } from "../src/lib/calendar-detail";
import { CALENDAR_LINE_PREFIX, CALENDAR_NO_EVENTS_TEXT, CALENDAR_NOT_CONNECTED_TEXT, CALENDAR_UNAVAILABLE_TEXT } from "../src/lib/calendar-contract";
import { calendarSectionLines } from "../src/lib/briefing-struct";
import { deckView, mapPage, meetingTile, nextMeeting, type DeckPage } from "../src/lib/deck";
import type { CalendarDetailsEvent, CalendarDetailsSource } from "../src/lib/engine";
import { todayModel } from "../src/lib/today";

const TODAY = "2026-10-16";
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A local wall time on `date` (the renderer's zone). */
const at = (date: string, hh: number, mm = 0, plusDays = 0): number => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d + plusDays, hh, mm).getTime();
};

const timed = (start: [number, number], end: [number, number], title: string, extra: Partial<CalendarStructEvent> = {}, date = TODAY): CalendarStructEvent => ({
  time: { kind: "timed", startMs: at(date, start[0], start[1]), endMs: at(date, end[0], end[1]) },
  title,
  status: "confirmed",
  transparency: "busy",
  attendeeCount: 2,
  ...extra,
});
const allDay = (title: string): CalendarStructEvent => ({
  time: { kind: "allDay", startDate: TODAY, endDateExclusive: "2026-10-17" },
  title,
  status: "confirmed",
  transparency: "free",
  attendeeCount: 0,
});

const MAC: CalendarStructSource = { id: "macos", kind: "macos", status: "ok" };
const cal = (events: CalendarStructEvent[], sources: CalendarStructSource[] = [MAC]): CalendarStruct => ({ events, sources, incomplete: false });

function pageOf(events: CalendarStructEvent[], date = TODAY, today = TODAY): DeckPage {
  const text = renderBriefing({ date, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [], calendar: cal(events) } as EngineStruct);
  const r = mapPage(renderMarkdown(text), today);
  if (!r.ok) throw new Error(`expected the page to map, got ${r.reason}`);
  return r.page;
}

/** A live event as Rust's reply carries it, its `rowText` from the engine's own renderer. */
let seq = 0;
function live(e: CalendarStructEvent, extra: Partial<CalendarDetailsEvent> = {}): CalendarDetailsEvent {
  seq += 1;
  return {
    handle: `g.${seq}.h`,
    title: e.title,
    location: e.location ?? null,
    rowText: calEventLine(e as Parameters<typeof calEventLine>[0], TODAY),
    time: e.time,
    status: e.status,
    ended: e.ended === true,
    linkState: "none",
    joinHost: null,
    needsConfirm: false,
    fromMac: true,
    ...extra,
  };
}
const ok = (id = "macos", kind = "macos"): CalendarDetailsSource => ({ id, kind, status: "ok", skipped: false, last: null });
const failedSrc = (id: string, status: string, reason?: string): CalendarDetailsSource => ({
  id, kind: id === "macos" ? "macos" : "link", status, ...(reason !== undefined ? { reason } : {}), skipped: false, last: null,
});
const skippedSrc = (id: string, last: CalendarDetailsSource["last"]): CalendarDetailsSource => ({ id, kind: id === "macos" ? "macos" : "link", skipped: true, last });

const READ_AT = new Date(at(TODAY, 9, 35)).toISOString();
const detail = (events: CalendarDetailsEvent[], sources: CalendarDetailsSource[] = [ok()], more: Partial<CalendarDetail> = {}): CalendarDetail => ({
  ...NO_DETAIL,
  list: { readAt: READ_AT, readerOutdated: false, events, sources },
  ...more,
});
function viewOf(page: DeckPage, d: CalendarDetail): CalendarDetailView {
  const v = calendarDetailView(page, d);
  if (v === null) throw new Error("expected a live view");
  return v;
}

const STANDUP = timed([9, 0], [9, 30], "Standup", { location: "Room 4" });
const REVIEW = timed([11, 0], [12, 0], "Design review", { status: "tentative" });
const LUNCH = timed([13, 0], [14, 0], "Lunch");

/* ── the clock off UTC (deck.check.ts's `inZone`) ─────────────────────────────────────────────── */

function inZone(tz: string, offsetAtNoon: number, body: () => void): void {
  const saved = process.env.TZ;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const before = new Date(2026, 9, 16, 9, 0).getTime();
  process.env.TZ = tz;
  try {
    expect(new Date(Date.UTC(2026, 9, 16, 12)).getTimezoneOffset()).toBe(offsetAtNoon);   // PREMISE: the zone took effect
    body();
  } finally {
    process.env.TZ = zone;
    process.env.TZ = saved;
  }
  expect(new Date(2026, 9, 16, 9, 0).getTime()).toBe(before);   // restored
}

/* ── the view's existence ─────────────────────────────────────────────────────────────────────── */

describe("the live view exists only for today's page with a calendar slide (a section, or a live calendar day)", () => {
  test("a stale page and a page with no calendar section have no live view (PB-M4: unless it is a live calendar day — today's page, liveDay true)", () => {
    expect(calendarDetailView(pageOf([STANDUP], "2026-10-15", TODAY), detail([live(STANDUP)]))).toBeNull();
    const text = renderBriefing({ date: TODAY, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [] } as EngineStruct);
    const r = mapPage(renderMarkdown(text), TODAY);
    expect(r.ok && r.page.calendar).toBeNull();   // PREMISE
    if (r.ok) expect(calendarDetailView(r.page, detail([]))).toBeNull();
    // PB-M4: a live calendar day (today's page, no section, "on") has the no-section view.
    if (r.ok) expect(calendarDetailView(r.page, detail([]), true)?.readState).toBe("answered");
    // A stale page with no section is never a live calendar day.
    const stale = mapPage(renderMarkdown(renderBriefing({ date: "2026-10-15", machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [] } as EngineStruct)), TODAY);
    expect(stale.ok && stale.page.calendar === null && stale.page.stale).toBe(true);   // PREMISE
    if (stale.ok) expect(calendarDetailView(stale.page, detail([]), true)).toBeNull();
  });

  test("before the first read: the page's rows, no line; while an ask is outstanding, loading", () => {
    const page = pageOf([STANDUP, LUNCH]);
    const before = viewOf(page, NO_DETAIL);
    expect(before.phase).toBe("before");
    expect(before.loading).toBe(false);
    expect(before.events.map((e) => [e.title, e.live])).toEqual([["Standup (Room 4)", null], ["Lunch", null]]);
    expect(before.lines).toEqual([]);
    const loading = viewOf(page, { ...NO_DETAIL, pending: true });
    expect(loading.loading).toBe(true);
    expect(cardView(loading, { rowText: page.calendar!.rows[0]!.text, handle: null, row: 0 })).toEqual({
      kind: "page", text: "09:00–09:30  Standup (Room 4)", loading: true, lines: [],
    });
    expect(LOADING_LINE).toBe("Reading your calendar…");
    // A held list being refreshed is not "loading": the list stays drawn.
    expect(viewOf(page, { ...detail([live(STANDUP)]), pending: true }).loading).toBe(false);
  });

  test("a malformed live time is dropped (the reply's `time` is checked, never trusted)", () => {
    expect(liveEvent({ ...live(STANDUP), time: { kind: "timed", startMs: "9" } })).toBeNull();
    expect(liveEvent({ ...live(STANDUP), time: null })).toBeNull();
    expect(liveEvent({ ...live(STANDUP), time: { kind: "timed", startMs: 10, endMs: 5 } })).toBeNull();
    expect(liveEvent(live(STANDUP))?.time).toEqual(STANDUP.time);
    const page = pageOf([STANDUP]);
    expect(viewOf(page, detail([{ ...live(LUNCH), time: "13:00" }, live(STANDUP)])).events.map((e) => e.title)).toEqual(["Standup (Room 4)"]);
  });
});

/* ── the timeline's geometry ──────────────────────────────────────────────────────────────────── */

describe("timeline positions come from the local midnights", () => {
  test("an ordinary day: 24 hour marks, an event's span from local midnight, clipped to the day", () => {
    const day = dayBounds(TODAY);
    expect(day).toEqual({ start: at(TODAY, 0), end: at(TODAY, 0, 0, 1) });
    const marks = hourMarks(TODAY);
    expect(marks.length).toBe(24);
    expect(marks[9]).toEqual({ label: "09:00", at: 9 * HOUR });
    expect(timelineSpan(at(TODAY, 9), at(TODAY, 9, 30), TODAY)).toEqual({ from: 9 * HOUR, to: 9.5 * HOUR, day: 24 * HOUR });
    // An overnight event starting yesterday is drawn from midnight; one ending tomorrow up to the next midnight.
    expect(timelineSpan(at(TODAY, 22, 0, -1), at(TODAY, 2), TODAY)).toEqual({ from: 0, to: 2 * HOUR, day: 24 * HOUR });
    expect(timelineSpan(at(TODAY, 23), at(TODAY, 1, 0, 1), TODAY)).toEqual({ from: 23 * HOUR, to: 24 * HOUR, day: 24 * HOUR });
    expect(timelineSpan(at(TODAY, 9, 0, 1), at(TODAY, 10, 0, 1), TODAY)).toBeNull();
  });

  test("a clocks-back day is 25 hours, a clocks-forward day 23: never 24 equal hours [America/Los_Angeles]", () => {
    inZone("America/Los_Angeles", 420, () => {
      const back = "2026-11-01";
      const fwd = "2026-03-08";
      expect(dayBounds(back).end - dayBounds(back).start).toBe(25 * HOUR);
      expect(dayBounds(fwd).end - dayBounds(fwd).start).toBe(23 * HOUR);
      const backMarks = hourMarks(back);
      expect(backMarks.length).toBe(24);
      expect(backMarks.find((m) => m.label === "09:00")!.at).toBe(10 * HOUR);   // after the repeated hour
      expect(timelineSpan(at(back, 9), at(back, 10), back)).toEqual({ from: 10 * HOUR, to: 11 * HOUR, day: 25 * HOUR });
      const fwdMarks = hourMarks(fwd);
      expect(fwdMarks.map((m) => m.label)).not.toContain("02:00");   // the hour that does not exist
      expect(fwdMarks.length).toBe(23);
      expect(fwdMarks.find((m) => m.label === "03:00")!.at).toBe(2 * HOUR);
    });
  });
});

/* ── the subtitle and the countdown ───────────────────────────────────────────────────────────── */

describe("the subtitle: N events · Xh Ym in meetings · next in N minutes", () => {
  test("the union counts an overlap once; tentative events count; the countdown's three words", () => {
    const a = timed([9, 0], [10, 0], "A");
    const b = timed([9, 30], [10, 30], "B", { status: "tentative" });
    const c = timed([13, 0], [13, 45], "C");
    const v = viewOf(pageOf([a, b, c]), NO_DETAIL);
    expect(subtitle(v, at(TODAY, 8, 35))).toBe("3 events · 2h 15m in meetings · next in 25 minutes");
    expect(subtitle(v, at(TODAY, 9, 59))).toBe("3 events · 2h 15m in meetings · now");
    expect(subtitle(v, at(TODAY, 12, 59))).toBe("3 events · 2h 15m in meetings · next in 1 minute");
    expect(subtitle(v, at(TODAY, 14, 0))).toBe("3 events · 2h 15m in meetings · no more meetings today");
    expect(countdown(v, at(TODAY, 8, 35))).toEqual({ kind: "next", minutes: 25 });
    expect(countdown(v, at(TODAY, 9, 59))).toEqual({ kind: "now" });
    expect(countdown(v, at(TODAY, 14, 0))).toEqual({ kind: "none" });
    expect(subtitle(viewOf(pageOf([timed([9, 0], [9, 45], "Only")]), NO_DETAIL), at(TODAY, 8))).toBe("1 event · 45m in meetings · next in 60 minutes");
    expect(subtitle(viewOf(pageOf([timed([9, 0], [11, 0], "Long")]), NO_DETAIL), at(TODAY, 8))).toBe("1 event · 2h in meetings · next in 60 minutes");
  });

  test("an all-day event is left out of the count and the union; a day with none says so", () => {
    const v = viewOf(pageOf([allDay("Offsite"), STANDUP]), NO_DETAIL);
    expect(subtitle(v, at(TODAY, 8))).toBe("1 event · 30m in meetings · next in 60 minutes");
    const after = viewOf(pageOf([STANDUP]), detail([live(allDay("Offsite")), live(STANDUP)]));
    expect(after.strip.map((s) => s.title)).toEqual(["Offsite"]);
    expect(subtitle(after, at(TODAY, 8))).toBe("1 event · 30m in meetings · next in 60 minutes");
    expect(subtitle(viewOf(pageOf([]), NO_DETAIL), at(TODAY, 8))).toBe("No events today");
  });

  test("once a read has answered, N and the union count the live events, not the page's rows", () => {
    const page = pageOf([STANDUP, LUNCH]);
    expect(subtitle(viewOf(page, NO_DETAIL), at(TODAY, 8))).toBe("2 events · 1h 30m in meetings · next in 60 minutes");
    // Lunch was cancelled, a review added: the live list wins.
    const v = viewOf(page, detail([live(STANDUP), live(REVIEW), live(timed([15, 0], [15, 30], "Sync"))]));
    expect(subtitle(v, at(TODAY, 8))).toBe("3 events · 2h in meetings · next in 60 minutes");
  });
});

/* ── the row match ────────────────────────────────────────────────────────────────────────────── */

describe("the row match: rowText against the row's text, marks removed, a unique match only", () => {
  test("the page's own line matches its live event, whatever the tentative and ended marks say", () => {
    const page = pageOf([timed([7, 0], [7, 30], "Gym", { ended: true }), REVIEW]);
    const rows = page.calendar!.rows.map((r) => r.text);
    expect(rows).toEqual(["07:00–07:30  Gym · ended", "11:00–12:00  Design review · tentative"]);   // PREMISE: the page's marks
    const gym = liveEvent(live(timed([7, 0], [7, 30], "Gym")))!;   // read live before it ended
    const review = liveEvent(live({ ...REVIEW, status: "confirmed" }))!;   // accepted since
    expect(rowMatch(rows[0]!, [gym, review])).toBe(gym);
    expect(rowMatch(rows[1]!, [gym, review])).toBe(review);
    expect(rowMatch("11:00–12:00  Design review (Room 9)", [gym, review])).toBeNull();
    // Only the trailing marks are marks: a title that holds the words elsewhere keeps them.
    const odd = liveEvent(live(timed([8, 0], [8, 30], "Retro · ended early")))!;
    expect(rowMatch("08:00–08:30  Retro", [odd])).toBeNull();
  });

  test("two live events with the same text: several, never a pick by position", () => {
    const a = liveEvent(live(STANDUP))!;
    const b = liveEvent(live(STANDUP))!;
    expect(rowMatch("09:00–09:30  Standup (Room 4)", [a, b])).toBe("several");
  });
});

/* ── after a read ─────────────────────────────────────────────────────────────────────────────── */

describe("the post-read model", () => {
  const page = pageOf([STANDUP, LUNCH]);
  const standupRow = { rowText: "09:00–09:30  Standup (Room 4)", handle: null, row: 0 };
  const lunchRow = { rowText: "13:00–14:00  Lunch", handle: null, row: 1 };

  test("a card opened on a page row moves to its live event; a row with no live match after a full read has changed", () => {
    const s = live(STANDUP, { linkState: "one", joinHost: "zoom.us" });
    const v = viewOf(page, detail([s]));
    expect(v.phase).toBe("read");
    const card = cardView(v, standupRow);
    expect(card.kind === "live" && card.event.handle).toBe(s.handle);
    expect(card.kind === "live" && card.footnote).toBe("Read live at 09:35 · not saved");
    expect(cardView(v, lunchRow)).toEqual({ kind: "changed", text: "13:00–14:00  Lunch" });
    expect(CHANGED_LINE).toBe("This event changed since your briefing");
    // A refresh with the card open: re-keyed by its text to the new read's handle.
    const s2 = live(STANDUP);
    const v2 = viewOf(page, detail([s2]));
    const reopened = cardView(v2, { rowText: s.rowText, handle: s.handle, row: null });
    expect(reopened.kind === "live" && reopened.event.handle).toBe(s2.handle);
  });

  test("a card re-keys by handle when two live events have the same rowText", () => {
    const a = live(STANDUP);
    const b = live(STANDUP);
    const v = viewOf(page, detail([a, b]));
    const card = cardView(v, { rowText: a.rowText, handle: a.handle, row: null });
    expect(card.kind === "live" && card.event.handle).toBe(a.handle);
  });

  test("a live event with no row is an ordinary event, and the timeline is the live list", () => {
    const extra = live(timed([16, 0], [16, 45], "Late add"));
    const v = viewOf(page, detail([live(STANDUP), extra]));
    expect(v.events.map((e) => [e.title, e.live !== null, e.fallback])).toEqual([["Standup (Room 4)", true, false], ["Late add", true, false]]);
    const card = cardView(v, { rowText: extra.rowText, handle: extra.handle, row: null });
    expect(card.kind).toBe("live");
  });

  test("the launchpad tile and Good morning's next meeting follow the live events", () => {
    // Before the read, A's tile from the page's rows: Lunch, from 12:40.
    const before = viewOf(page, NO_DETAIL);
    expect(meetingTile(TODAY, before.events, at(TODAY, 12, 40))?.event.title).toBe("Lunch");
    // Lunch cancelled, a 12:50 call added: the tile and the glance move with the live list.
    const call = live(timed([12, 50], [13, 20], "Call"), { linkState: "one", joinHost: "meet.google.com" });
    const v = viewOf(page, detail([live(STANDUP), call]));
    const tile = meetingTile(TODAY, v.events, at(TODAY, 12, 40));
    expect(tile?.event.title).toBe("Call");
    expect((tile?.event as (typeof v.events)[number]).live?.handle).toBe(call.handle);
    expect(nextMeeting(TODAY, v.events, at(TODAY, 10))?.title).toBe("Call");
    expect(meetingTile(TODAY, v.events, at(TODAY, 13, 30))).toBeNull();
  });

  test("the live event keeps its exact instants, and a start before today keeps the page's own words", () => {
    const overnight = timed([22, 0], [2, 0], "Deploy watch");
    overnight.time = { kind: "timed", startMs: at(TODAY, 22, 15, -1), endMs: at(TODAY, 2, 0) };
    const v = viewOf(pageOf([overnight]), detail([live(overnight)]));
    expect(v.events[0]).toMatchObject({ startMs: at(TODAY, 22, 15, -1), endMs: at(TODAY, 2, 0), since: "since yesterday", title: "Deploy watch" });
  });
});

/* ── a partial read, a skipped source and the failure lines ───────────────────────────────────── */

describe("the partial-read model and the failure lines", () => {
  const page = pageOf([STANDUP, LUNCH]);

  test("a source that failed: the answered events live, unmatched rows stay unconfirmed fallback rows, no source named", () => {
    const v = viewOf(page, detail([live(STANDUP)], [ok(), failedSrc("work", "link-refused")]));
    expect(v.phase).toBe("partial");
    expect(v.events.map((e) => [e.title, e.live !== null, e.fallback])).toEqual([["Standup (Room 4)", true, false], ["Lunch", false, true]]);
    expect(v.lines).toEqual([`work: ${CALENDAR_STATUS_TEXT["link-refused"]}`]);
    // The fallback row's card: the page's facts and the failed source's line, never "changed".
    expect(cardView(v, { rowText: "13:00–14:00  Lunch", handle: null, row: 1 })).toEqual({ kind: "fallback", text: "13:00–14:00  Lunch", lines: v.lines });
  });

  test("a skipped source counts as not answered: a partial read, its last status shown, \"not read yet\" with none", () => {
    const withLast = viewOf(page, detail([live(STANDUP)], [ok(), skippedSrc("work", { status: "malformed", at: READ_AT })]));
    expect(withLast.phase).toBe("partial");
    expect(cardView(withLast, { rowText: "13:00–14:00  Lunch", handle: null, row: 1 }).kind).toBe("fallback");
    expect(withLast.lines).toEqual([`work: ${CALENDAR_STATUS_TEXT.malformed}`]);
    const never = viewOf(page, detail([live(STANDUP)], [ok(), skippedSrc("work", null)]));
    expect(never.phase).toBe("partial");
    expect(never.lines).toEqual(["work: not read yet"]);
    // A skipped source whose last read was fine says nothing, and the read is still partial.
    const fine = viewOf(page, detail([live(STANDUP)], [ok(), skippedSrc("work", { status: "ok", at: READ_AT })]));
    expect([fine.phase, fine.lines]).toEqual(["partial", []]);
  });

  test("the fixed lines: offline from `unreachable`, the timeout, denied; every other status names its source", () => {
    const line = (src: CalendarDetailsSource): string[] => viewOf(page, detail([live(STANDUP)], [ok("w2", "link"), src])).lines;
    expect(line(failedSrc("work", "incomplete", "unreachable"))).toEqual([OFFLINE_LINE]);
    expect(line(failedSrc("work", "offline"))).toEqual([OFFLINE_LINE]);
    expect(line(failedSrc("macos", "timeout"))).toEqual([TIMEOUT_LINE]);
    expect(line(failedSrc("macos", "denied"))).toEqual([DENIED_LINE]);
    expect([OFFLINE_LINE, TIMEOUT_LINE, DENIED_LINE]).toEqual([
      "Couldn't read your calendar (offline)",
      "Calendar took too long",
      "Calendar access was turned off: allow it in System Settings",
    ]);
    const named = ["not-granted", "write-only", "restricted", "unsupported-os", "helper-missing", "link-refused", "link-redirected", "malformed", "too-large", "incomplete"] as const;
    for (const status of named) {
      expect({ status, lines: line(failedSrc("macos", status)) }).toEqual({ status, lines: [`Mac Calendar: ${CALENDAR_STATUS_TEXT[status]}`] });
      expect({ status, lines: line(failedSrc("work", status)) }).toEqual({ status, lines: [`work: ${CALENDAR_STATUS_TEXT[status]}`] });
    }
  });

  test("a whole-read failure: the page's rows and counts, the failure's line, no Join anywhere", () => {
    const v = viewOf(page, detail([], [failedSrc("macos", "denied")]));
    expect(v.phase).toBe("failed");
    expect(v.events.map((e) => [e.title, e.live])).toEqual([["Standup (Room 4)", null], ["Lunch", null]]);
    expect(v.lines).toEqual([DENIED_LINE]);
    expect(subtitle(v, at(TODAY, 8))).toBe("2 events · 1h 30m in meetings · next in 60 minutes");
    expect(cardView(v, { rowText: "13:00–14:00  Lunch", handle: null, row: 1 })).toEqual({ kind: "page", text: "13:00–14:00  Lunch", loading: false, lines: [DENIED_LINE] });
  });

  test("the calendar turned off since the page: the page's rows and the off line", () => {
    const v = viewOf(page, { ...NO_DETAIL, off: true });
    expect(v.phase).toBe("off");
    expect(v.lines).toEqual([OFF_LINE]);
    expect(OFF_LINE).toBe("Calendar is off: turn it on in Settings → Calendar");
    expect(v.events.every((e) => e.live === null)).toBe(true);
  });

  test("an outdated reader copy still reads: its card carries the update line", () => {
    const d = detail([live(STANDUP)]);
    const v = viewOf(page, { ...d, list: { ...d.list!, readerOutdated: true } });
    const card = cardView(v, { rowText: "09:00–09:30  Standup (Room 4)", handle: null, row: 0 });
    expect(card.kind === "live" && card.lines).toEqual([READER_OUTDATED_LINE]);
    expect(READER_OUTDATED_LINE).toBe("Update the calendar reader to show every meeting link");
  });

  test("Open in Calendar: live events need a Mac copy; otherwise hidden only when no Mac source is configured", () => {
    const mac = live(STANDUP, { fromMac: true });
    const link = live(LUNCH, { fromMac: false });
    const v = viewOf(page, detail([mac, link], [ok()], { macConfigured: true }));
    expect(openInCalendar(v, cardView(v, { rowText: mac.rowText, handle: mac.handle, row: null }), "macos")).toBe(true);
    expect(openInCalendar(v, cardView(v, { rowText: link.rowText, handle: link.handle, row: null }), "macos")).toBe(false);
    for (const configured of [null, false, true]) {
      const loading = viewOf(page, { ...NO_DETAIL, pending: true, macConfigured: configured });
      expect({ configured, shown: openInCalendar(loading, cardView(loading, { rowText: link.rowText, handle: null, row: 1 }), "macos") }).toEqual({ configured, shown: configured !== false });
      const failed = viewOf(page, detail([], [failedSrc("macos", "timeout")], { macConfigured: configured }));
      expect({ configured, failed: openInCalendar(failed, cardView(failed, { rowText: link.rowText, handle: null, row: 1 }), "macos") }).toEqual({ configured, failed: configured !== false });
    }
  });
});

/* ── the people line ──────────────────────────────────────────────────────────────────────────── */

describe("the people line: initials with each name, the organiser first and marked, the cut at 5", () => {
  const p = (name: string | null, organiser = false) => ({ name, organiser });

  test("up to 4 people: every name, shortened, the organiser first with \" (organiser)\"", () => {
    const line = peopleLine([p("Sam Lee"), p("Priya Sharma", true), p("Lee Evans"), p("Ana Novak")]);
    expect(line.text).toBe("Priya S. (organiser), Sam L., Lee E., Ana N.");
    expect(line.chips).toEqual([
      { initials: "PS", name: "Priya S." },
      { initials: "SL", name: "Sam L." },
      { initials: "LE", name: "Lee E." },
      { initials: "AN", name: "Ana N." },
    ]);
  });

  test("5 or more: the first 3 names and \"and N more\"; the chips follow the shown names only", () => {
    const line = peopleLine([p("Priya Sharma", true), p("Sam Lee"), p("Ana Novak"), p("Jo Ma"), p("Kai Ro"), p("Lu Xi")]);
    expect(line.text).toBe("Priya S. (organiser), Sam L., Ana N. and 3 more");
    expect(line.chips.map((c) => c.initials)).toEqual(["PS", "SL", "AN"]);
  });

  test("a nameless person always counts in \"and N more\"; a one-word name shows whole; just you", () => {
    expect(peopleLine([p("Priya Sharma", true), p(null), p("Sam Lee"), p("Cher")]).text).toBe("Priya S. (organiser), Sam L., Cher and 1 more");
    expect(peopleLine([p("Cher")]).chips).toEqual([{ initials: "C", name: "Cher" }]);
    expect(peopleLine([p("Mary Ann van Dyke")]).text).toBe("Mary D.");
    expect(peopleLine([p("élodie durand")]).chips).toEqual([{ initials: "ÉD", name: "élodie d." }]);
    expect(peopleLine([])).toEqual({ text: "Just you", chips: [] });
    expect(peopleLine([p(null, true), p(null)])).toEqual({ text: "2 people", chips: [] });
  });
});

/* ── Join ─────────────────────────────────────────────────────────────────────────────────────── */

describe("the Join labels and the ask-first question", () => {
  const ev = (extra: Partial<CalendarDetailsEvent>) => liveEvent(live(STANDUP, { linkState: "one", ...extra }))!;

  test("the card's Join is always \"Join ↗\"; the tile's is \"Join ↗\" before and \"Join now on {name} ↗\" while on", () => {
    expect(CARD_JOIN_LABEL).toBe("Join ↗");
    const zoom = ev({ joinHost: "acme.zoom.us" });
    expect(tileJoinLabel(zoom, false)).toBe("Join ↗");
    expect(tileJoinLabel(zoom, true)).toBe("Join now on Zoom ↗");
    expect(tileJoinLabel(ev({ joinHost: "zoomgov.com" }), true)).toBe("Join now on Zoom ↗");
    expect(tileJoinLabel(ev({ joinHost: "meet.google.com" }), true)).toBe("Join now on Google Meet ↗");
    expect(tileJoinLabel(ev({ joinHost: "teams.microsoft.com" }), true)).toBe("Join now on Teams ↗");
    expect(tileJoinLabel(ev({ joinHost: "teams.live.com" }), true)).toBe("Join now on Teams ↗");
    expect(tileJoinLabel(ev({ joinHost: "acme.webex.com" }), true)).toBe("Join now on Webex ↗");
    expect(tileJoinLabel(ev({ joinHost: "whereby.com", serviceName: "Whereby", needsConfirm: true }), true)).toBe("Join now on Whereby ↗");
    expect(tileJoinLabel(ev({ joinHost: "meet.example.org", needsConfirm: true }), true)).toBe("Join now on meet.example.org ↗");
    // A look-alike that asks first is named by its bare host, never as the service it imitates.
    expect(tileJoinLabel(ev({ joinHost: "zoom.us.evil.com", needsConfirm: true }), true)).toBe("Join now on zoom.us.evil.com ↗");
    // No usable link: no Join.
    expect(tileJoinLabel(ev({ linkState: "several", joinHost: null }), true)).toBeNull();
    expect(tileJoinLabel(ev({ linkState: "none", joinHost: null }), false)).toBeNull();
  });

  test("the ask-first question, with and without a named service", () => {
    expect(askQuestion({ ask: "meet.example.org" })).toBe("Open this link on meet.example.org?");
    expect(askQuestion({ ask: "whereby.com", serviceName: "Whereby" })).toBe("Open this Whereby link on whereby.com?");
  });
});

/* ── C-M4-T12: the page's all-day and unclear rows, and deckView's `live` ─────────────────────────── */

describe("the all-day strip and deckView's live field (C-M4-T12)", () => {
  const unclear: CalendarStructEvent = {
    time: { kind: "unclear", startDate: TODAY, endDate: TODAY, wallStart: "08:00", wallEnd: "09:00", tzid: "Mars/Base" },
    title: "Vendor",
    status: "confirmed",
    transparency: "busy",
    attendeeCount: 1,
  };
  const page = pageOf([allDay("Offsite"), unclear, STANDUP]);

  test("before the first read the strip shows the page's all-day and unclear rows; the subtitle and the tiles never see them", () => {
    const v = viewOf(page, NO_DETAIL);
    expect(v.strip).toEqual([
      { text: "all day — Offsite", title: "Offsite", live: null, fallback: false, row: 0 },
      { text: "time unclear (08:00–09:00 Mars/Base)  Vendor", title: "Vendor", live: null, fallback: false, row: 1 },
    ]);
    expect(v.events.map((e) => e.title)).toEqual(["Standup (Room 4)"]);
    expect(subtitle(v, at(TODAY, 8, 30))).toBe("1 event · 30m in meetings · next in 30 minutes");
    expect(meetingTile(TODAY, v.events, at(TODAY, 8, 30))?.event.title).toBe("Standup (Room 4)");
    expect(nextMeeting(TODAY, v.events, at(TODAY, 8, 30))?.title).toBe("Standup (Room 4)");
  });

  test("after a full read the strip is the live one; after a partial read an unmatched page row stays as a fallback", () => {
    const full = viewOf(page, detail([live(allDay("Offsite")), live(STANDUP)]));
    expect(full.strip.map((s) => [s.title, s.live !== null, s.fallback])).toEqual([["Offsite", true, false]]);
    const partial = viewOf(page, detail([live(allDay("Offsite")), live(STANDUP)], [ok(), failedSrc("work", "timeout")]));
    expect(partial.strip.map((s) => [s.title, s.live !== null, s.fallback])).toEqual([["Offsite", true, false], ["Vendor", false, true]]);
    // The fallback strip row's card: the page's facts and the failed source's line.
    expect(cardView(partial, { rowText: "time unclear (08:00–09:00 Mars/Base)  Vendor", handle: null, row: 1 }).kind).toBe("fallback");
  });

  test("deckView's slides carry `live`: null without a calendar detail, a view with one, null on a stale page", () => {
    const text = renderBriefing({ date: TODAY, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [], calendar: cal([STANDUP]) } as EngineStruct);
    const model = (today: string) => todayModel({ snapshot: null, latest: { state: "loaded", file: { path: "/s/briefing-latest.md", text, bytes: text.length } }, lastRun: null, today });
    const without = deckView({ model: model(TODAY), today: TODAY, firstName: null });
    expect(without.kind === "slides" && without.live).toBeNull();
    const withDetail = deckView({ model: model(TODAY), today: TODAY, firstName: null, calendarDetail: detail([live(STANDUP)]) });
    expect(withDetail.kind === "slides" && withDetail.live?.phase).toBe("read");
    const stale = deckView({ model: model("2026-10-17"), today: "2026-10-17", firstName: null, calendarDetail: detail([live(STANDUP)]) });
    expect(stale.kind === "slides" && stale.page.stale).toBe(true);   // PREMISE
    expect(stale.kind === "slides" && stale.live).toBeNull();
  });
});

/* ── the data life ────────────────────────────────────────────────────────────────────────────── */

describe("the data life: people and notes are dropped at the event's end and at the day change", () => {
  test("kept while the event runs on its day; dropped at its end and after midnight", () => {
    const info = { endMs: at(TODAY, 9, 30), day: TODAY };
    expect(keepDetails(info, at(TODAY, 9, 29))).toBe(true);
    expect(keepDetails(info, at(TODAY, 9, 30))).toBe(false);
    expect(keepDetails({ endMs: at(TODAY, 2, 0, 1), day: TODAY }, at(TODAY, 0, 1, 1))).toBe(false);
    expect(keepDetails({ endMs: at(TODAY, 2, 0, 1), day: TODAY }, at(TODAY, 23, 59))).toBe(true);
  });

  test("an event's end: a timed one's own, an all-day one's next local midnight, an unclear one's at the day's end", () => {
    expect(eventEndMs(liveEvent(live(STANDUP))!, TODAY)).toBe(at(TODAY, 9, 30));
    expect(eventEndMs(liveEvent(live(allDay("Offsite")))!, TODAY)).toBe(at(TODAY, 0, 0, 1));
    const unclear = liveEvent(live({ ...STANDUP, time: { kind: "unclear", startDate: TODAY, endDate: TODAY, wallStart: "08:00", wallEnd: "09:00", tzid: "Mars/Base" } }))!;
    expect(eventEndMs(unclear, TODAY)).toBe(at(TODAY, 0, 0, 1));
  });
});

describe("the several-links line", () => {
  test("the card's words when the winning field holds two different meeting links (no Join)", () => {
    expect(SEVERAL_LINKS_LINE).toBe("Several meeting links");
    const several = liveEvent(live(STANDUP, { linkState: "several", joinHost: "zoom.us" }))!;
    expect([several.linkState, several.joinHost, tileJoinLabel(several, true)]).toEqual(["several", null, null]);
  });
});

/* ── C-M5-T13: what the calendar slide and the card draw (the screens' own pure pieces) ────────── */

describe("C-M5-T13: a row's time and marks, as the page writes them", () => {
  test("the time part of each of the page's row forms; the marks in words", () => {
    const line = (e: CalendarStructEvent): string => calEventLine(e as Parameters<typeof calEventLine>[0], TODAY);
    expect(timeOf(line(STANDUP))).toBe("09:00–09:30");
    expect(timeOf(line(timed([22, 0], [2, 0], "Night", {}, TODAY)))).toBe("22:00–02:00");
    expect(timeOf(line({ ...STANDUP, time: { kind: "timed", startMs: at(TODAY, 22, 0, -1), endMs: at(TODAY, 2) } }))).toBe("since yesterday → 02:00");
    expect(timeOf(line({ ...STANDUP, time: { kind: "timed", startMs: at(TODAY, 9), endMs: at(TODAY, 9) } }))).toBe("09:00");
    expect(timeOf(line(allDay("Offsite")))).toBe("all day");
    const unclear = line({ ...STANDUP, time: { kind: "unclear", startDate: TODAY, endDate: TODAY, wallStart: "08:00", wallEnd: "09:00", tzid: "Mars/Base" } });
    expect(timeOf(unclear)).toBe("time unclear (08:00–09:00 Mars/Base)");
    expect(timeOf("no time here")).toBe("");
    expect(marksOf(line({ ...REVIEW, ended: true }))).toEqual(["tentative", "ended"]);
    expect(marksOf(line(REVIEW))).toEqual(["tentative"]);
    expect(marksOf(line(STANDUP))).toEqual([]);
  });
});

describe("near-duplicates (spec §6): the merge mark in a row's time, marks, row match and card facts", () => {
  const line = (e: CalendarStructEvent): string => calEventLine(e as Parameters<typeof calEventLine>[0], TODAY);
  const merged = (mark: "calendars" | "copies", count: number) => ({ merged: { mark, count } }) as Partial<CalendarStructEvent>;
  const UNCLEAR = { kind: "unclear", startDate: TODAY, endDate: TODAY, wallStart: "08:00", wallEnd: "09:00", tzid: "Mars/Base" } as const;
  const rows = {
    timed: line({ ...STANDUP, ...merged("calendars", 3) }),
    every: line({ ...REVIEW, ended: true, ...merged("copies", 2) }),
    allDay: line({ ...allDay("Offsite"), ...merged("copies", 10) }),
    unclear: line({ ...STANDUP, status: "tentative", time: UNCLEAR, ...merged("calendars", 12) }),
  };

  test("R03: timeOf reads past the mark; marksOf gives the merge mark object first, then tentative and ended, on every row kind", () => {
    expect(rows).toEqual({
      timed: "09:00–09:30  Standup (Room 4) · on 3 calendars",
      every: "11:00–12:00  Design review · 2 copies · tentative · ended",
      allDay: "all day — Offsite · 10 copies",
      unclear: "time unclear (08:00–09:00 Mars/Base)  Standup (Room 4) · on 12 calendars · tentative",
    });   // PREMISE: the engine's own lines
    expect([rows.timed, rows.every, rows.allDay, rows.unclear].map(timeOf)).toEqual([
      "09:00–09:30", "11:00–12:00", "all day", "time unclear (08:00–09:00 Mars/Base)",
    ]);
    expect(marksOf(rows.timed)).toEqual([{ kind: "calendars", count: 3 }]);
    expect(marksOf(rows.every)).toEqual([{ kind: "copies", count: 2 }, "tentative", "ended"]);
    expect(marksOf(rows.allDay)).toEqual([{ kind: "copies", count: 10 }]);
    expect(marksOf(rows.unclear)).toEqual([{ kind: "calendars", count: 12 }, "tentative"]);
    // What the grammar refuses gives no merge mark, and the other marks are still read.
    expect(marksOf("09:00–09:30  Standup · on 1 calendars")).toEqual([]);
    expect(marksOf("09:00–09:30  Standup · 0 copies · ended")).toEqual(["ended"]);
    expect(marksOf("09:00–09:30  Standup · on 02 calendars · tentative")).toEqual(["tentative"]);
    // The words each mark is drawn in, after " · ", as the engine writes them.
    expect([{ kind: "calendars", count: 3 } as const, { kind: "copies", count: 12 } as const, "tentative" as const, "ended" as const].map(markWords)).toEqual([
      "on 3 calendars", "12 copies", "tentative", "ended",
    ]);
  });

  test("R03: rowMatch: the merge mark is stripped on both sides, so a changed count or kind, or a merge gone live, still matches", () => {
    const sameN = liveEvent(live({ ...STANDUP, ...merged("calendars", 3) }))!;
    const otherN = liveEvent(live({ ...STANDUP, ...merged("copies", 4) }))!;
    const plain = liveEvent(live(STANDUP))!;
    expect(rowMatch(rows.timed, [sameN])).toBe(sameN);
    expect(rowMatch(rows.timed, [otherN])).toBe(otherN);
    expect(rowMatch(rows.timed, [plain])).toBe(plain);   // a source skipped: the merge is gone from the live read
    expect(rowMatch(line(STANDUP), [otherN])).toBe(otherN);
    expect(rowMatch(rows.timed, [sameN, otherN])).toBe("several");   // unchanged: the comparator ignores the mark
    const unclearLive = liveEvent(live({ ...STANDUP, status: "tentative", time: UNCLEAR }))!;
    expect(rowMatch(rows.unclear, [unclearLive])).toBe(unclearLive);
    const allDayLive = liveEvent(live({ ...allDay("Offsite"), ...merged("calendars", 2) }))!;
    expect(rowMatch(rows.allDay, [allDayLive])).toBe(allDayLive);
    // The mark is not the title: a different title with the same mark does not match.
    expect(rowMatch(rows.timed, [liveEvent(live({ ...STANDUP, title: "Retro", ...merged("calendars", 3) }))!])).toBeNull();
  });

  test("R03: cardFacts: the merge mark object first in marks, never in the title or the place; a live card shows the live count", () => {
    const M = { ...STANDUP, ...merged("calendars", 3) };
    const R = { ...REVIEW, ...merged("copies", 2) };
    const page = pageOf([M, R]);
    const texts = page.calendar!.rows.map((r) => r.text);
    expect(texts).toEqual(["09:00–09:30  Standup (Room 4) · on 3 calendars", "11:00–12:00  Design review · 2 copies · tentative"]);   // PREMISE
    const read = viewOf(page, detail([live(M), live({ ...R, ...merged("copies", 4) })]));
    expect(cardFacts(cardView(read, { rowText: texts[0]!, handle: null, row: 0 }))).toEqual({
      title: "Standup", when: "09:00–09:30", place: "Room 4", marks: [{ kind: "calendars", count: 3 }],
    });
    expect(cardFacts(cardView(read, { rowText: texts[1]!, handle: null, row: 1 }))).toEqual({
      title: "Design review", when: "11:00–12:00", place: null, marks: [{ kind: "copies", count: 4 }, "tentative"],
    });
    const before = viewOf(page, NO_DETAIL);
    expect(cardFacts(cardView(before, { rowText: texts[0]!, handle: null, row: 0 }))).toEqual({
      title: "Standup (Room 4)", when: "09:00–09:30", place: null, marks: [{ kind: "calendars", count: 3 }],
    });
    expect(cardFacts(cardView(before, { rowText: texts[1]!, handle: null, row: 1 }))).toEqual({
      title: "Design review", when: "11:00–12:00", place: null, marks: [{ kind: "copies", count: 2 }, "tentative"],
    });
  });

  test("accepted limitation (plan §1.1, M6-GUI checkpoint): an UNMERGED event titled \"Print · 2 copies\" reads as merged — pinned as is, not fixed", () => {
    // The live reply carries the mark only inside `rowText`, so a title that itself ends in mark text is read as a mark
    // (the same class as a confirmed event titled "… · tentative"). This pins today's behaviour; a change here is a
    // decision, not a test fix.
    const PRINT = timed([10, 0], [10, 30], "Print · 2 copies");
    expect(PRINT.merged).toBeUndefined();   // PREMISE: unmerged
    const page = pageOf([PRINT]);
    const row = page.calendar!.rows[0]!;
    expect(row.text).toBe("10:00–10:30  Print · 2 copies");   // PREMISE: the engine writes the title as is, no mark of its own
    expect(row.kind === "event" && row.event?.title).toBe("Print");   // the page's title loses the "mark"
    expect(marksOf(row.text)).toEqual([{ kind: "copies", count: 2 }]);
    expect(cardFacts(cardView(viewOf(page, NO_DETAIL), { rowText: row.text, handle: null, row: 0 }))).toEqual({
      title: "Print", when: "10:00–10:30", place: null, marks: [{ kind: "copies", count: 2 }],
    });
    const p = live(PRINT);
    const card = cardView(viewOf(page, detail([p])), { rowText: p.rowText, handle: p.handle, row: null });
    expect(card.kind).toBe("live");
    // The live card shows the copies mark, and its title is the event's own (the mark text included).
    expect(cardFacts(card)).toEqual({ title: "Print · 2 copies", when: "10:00–10:30", place: null, marks: [{ kind: "copies", count: 2 }] });
  });
});

describe("near-duplicates (spec §5): one-to-one row assignment, row identity and the live-event card re-key", () => {
  const merged = (mark: "calendars" | "copies", count: number) => ({ merged: { mark, count } }) as Partial<CalendarStructEvent>;
  const M2 = { ...STANDUP, ...merged("calendars", 2) };
  /** A partial read: the work source skipped (a skipped source is not answered). */
  const SKIPPED = [ok(), skippedSrc("work", null)];
  const textsOf = (page: DeckPage): string[] => page.calendar!.rows.map((r) => r.text);
  /** Each drawn timeline item: its text, its page-row identity, its live handle and whether it is a fallback. */
  const drawn = (v: CalendarDetailView): [string, number | null, string | null, boolean][] =>
    v.events.map((e) => [e.rowText, e.row, e.live?.handle ?? null, e.fallback]);
  const byHandle = (v: CalendarDetailView, h: string) => v.live.find((e) => e.handle === h);
  function pageWith(events: CalendarStructEvent[], sources: CalendarStructSource[]): DeckPage {
    const text = renderBriefing({ date: TODAY, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [], calendar: cal(events, sources) } as EngineStruct);
    const r = mapPage(renderMarkdown(text), TODAY);
    if (!r.ok) throw new Error(`expected the page to map, got ${r.reason}`);
    return r.page;
  }

  test("P12: a partial read — a changed N still matches after stripping marks; a changed core title leaves the row as the partial fallback", () => {
    const page = pageOf([M2, LUNCH]);
    const texts = textsOf(page);
    expect(texts).toEqual(["09:00–09:30  Standup (Room 4) · on 2 calendars", "13:00–14:00  Lunch"]);   // PREMISE
    // The merge gone from the live read (a source skipped), or its N changed: the row still takes its live event.
    for (const e of [STANDUP, { ...STANDUP, ...merged("copies", 3) }]) {
      const s = live(e);
      const lunch = live(LUNCH);
      const v = viewOf(page, detail([s, lunch], SKIPPED));
      expect(v.phase).toBe("partial");
      expect(v.rowLive.get(0)).toBe(byHandle(v, s.handle));
      expect(drawn(v)).toEqual([[s.rowText, 0, s.handle, false], [texts[1]!, 1, lunch.handle, false]]);
      const card = cardView(v, { rowText: texts[0]!, handle: null, row: 0 });
      expect(card.kind === "live" && card.event.handle).toBe(s.handle);
    }
    // A changed core title: no candidate at either step, so the row stays the partial fallback.
    const retitled = live({ ...STANDUP, title: "Standup moved" });
    const lunch = live(LUNCH);
    const v = viewOf(page, detail([retitled, lunch], SKIPPED));
    expect(v.rowLive.has(0)).toBe(false);
    expect(drawn(v)).toEqual([[retitled.rowText, null, retitled.handle, false], [texts[0]!, 0, null, true], [texts[1]!, 1, lunch.handle, false]]);
    expect(cardView(v, { rowText: texts[0]!, handle: null, row: 0 })).toEqual({ kind: "fallback", text: texts[0]!, lines: v.lines });
  });

  test("P13: a merged row and a separate row with the same unmarked text, the second meeting's source skipped — only one row takes the live event", () => {
    const page = pageOf([M2, STANDUP]);
    const texts = textsOf(page);
    expect(texts).toEqual(["09:00–09:30  Standup (Room 4) · on 2 calendars", "09:00–09:30  Standup (Room 4)"]);   // PREMISE
    const m = live(M2);
    const partial = viewOf(page, detail([m], SKIPPED));
    // PREMISE: matched alone, each row would take the same live event (a unique unmarked match): one-to-one removes that.
    expect([rowMatch(texts[0]!, partial.live), rowMatch(texts[1]!, partial.live)]).toEqual([partial.live[0]!, partial.live[0]!]);
    expect([...partial.rowLive]).toEqual([[0, partial.live[0]!]]);
    expect(assignRows(page.calendar!.rows, partial.live)).toEqual(partial.rowLive);
    expect(drawn(partial)).toEqual([[m.rowText, 0, m.handle, false], [texts[1]!, 1, null, true]]);
    expect(cardView(partial, { rowText: texts[1]!, handle: null, row: 1 })).toEqual({ kind: "fallback", text: texts[1]!, lines: partial.lines });
    // After a full read the second row is not drawn, and its card has changed: the live event is used once.
    const read = viewOf(page, detail([m]));
    expect(drawn(read)).toEqual([[m.rowText, 0, m.handle, false]]);
    expect(cardView(read, { rowText: texts[1]!, handle: null, row: 1 })).toEqual({ kind: "changed", text: texts[1]! });
  });

  test("P13: an exact full-text match beats an unmarked match (never a tie), in either input order", () => {
    const page = pageOf([M2]);
    const plain = live(STANDUP);
    const m = live(M2);
    for (const order of [[plain, m], [m, plain]]) {
      const v = viewOf(page, detail(order));
      expect(v.rowLive.get(0)).toBe(byHandle(v, m.handle));
      // The other is drawn as a live event of its own, with no page row.
      expect(v.events.find((e) => e.live?.handle === plain.handle)?.row).toBeNull();
    }
  });

  test("P13 (ended): the exact step compares with ` · ended`/` · tentative` removed from both sides and the merge mark kept — each row takes its own event, in either input order", () => {
    const page = pageOf([M2, STANDUP]);
    const texts = textsOf(page);
    expect(texts).toEqual(["09:00–09:30  Standup (Room 4) · on 2 calendars", "09:00–09:30  Standup (Room 4)"]);   // PREMISE
    const m = live({ ...M2, ended: true });
    const plain = live({ ...STANDUP, ended: true });
    // PREMISE: the live rows gained ` · ended` (the morning page's did not), so a literal full-text compare never fires.
    expect([m.rowText, plain.rowText]).toEqual([`${texts[0]} · ended`, `${texts[1]} · ended`]);
    for (const order of [[m, plain], [plain, m]]) {
      const v = viewOf(page, detail(order));
      expect([v.rowLive.get(0), v.rowLive.get(1)]).toEqual([byHandle(v, m.handle)!, byHandle(v, plain.handle)!]);
      // Equal starts draw in input order; by row, each row is drawn once, through its own event.
      expect(drawn(v).sort((x, y) => (x[1] ?? -1) - (y[1] ?? -1))).toEqual([[m.rowText, 0, m.handle, false], [plain.rowText, 1, plain.handle, false]]);
    }
    // Tentative changed after the morning read: the same.
    const mt = live({ ...M2, status: "tentative", ended: true });
    const pt = live({ ...STANDUP, status: "tentative" });
    const vt = viewOf(page, detail([pt, mt]));
    expect([vt.rowLive.get(0), vt.rowLive.get(1)]).toEqual([byHandle(vt, mt.handle)!, byHandle(vt, pt.handle)!]);
  });

  test("P13 (tentative on the page): the exact step strips ` · tentative` from the PAGE row too — each row takes its own event, in either input order", () => {
    const page = pageOf([{ ...M2, status: "tentative" }, { ...STANDUP, status: "tentative" }]);
    const texts = textsOf(page);
    // PREMISE: the page's rows carry ` · tentative` (after the merge mark); the live events are no longer tentative.
    expect(texts).toEqual(["09:00–09:30  Standup (Room 4) · on 2 calendars · tentative", "09:00–09:30  Standup (Room 4) · tentative"]);
    const m = live(M2);
    const plain = live(STANDUP);
    expect([m.rowText, plain.rowText]).toEqual(["09:00–09:30  Standup (Room 4) · on 2 calendars", "09:00–09:30  Standup (Room 4)"]);   // PREMISE
    for (const order of [[m, plain], [plain, m]]) {
      const v = viewOf(page, detail(order));
      // Without the page-side strip, row 0 finds no exact match and ties over both at the unmarked step ("several").
      expect([v.rowLive.get(0), v.rowLive.get(1)]).toEqual([byHandle(v, m.handle)!, byHandle(v, plain.handle)!]);
      expect(assignRows(page.calendar!.rows, v.live)).toEqual(v.rowLive);
    }
  });

  test("P15 (§1.1 interpretation 2): an earlier tied row keeps \"several\" when a later row takes one of its candidates at the exact step", () => {
    const page = pageOf([STANDUP, M2, STANDUP]);
    const texts = textsOf(page);
    expect(texts).toEqual(["09:00–09:30  Standup (Room 4)", "09:00–09:30  Standup (Room 4) · on 2 calendars", "09:00–09:30  Standup (Room 4)"]);   // PREMISE
    const m = live(M2);
    const c3 = live({ ...STANDUP, ...merged("copies", 3) });
    const v = viewOf(page, detail([m, c3]));
    // Row 0 ties over both at the unmarked step; row 1 then takes the merged one exactly; row 2 the one left.
    expect([v.rowLive.get(0), v.rowLive.get(1), v.rowLive.get(2)]).toEqual(["several", byHandle(v, m.handle)!, byHandle(v, c3.handle)!]);
    expect(v.rowLive.size).toBe(3);
    // Row 0 is drawn neither as a fallback nor through a live event of its own; its card is the page card.
    expect(drawn(v)).toEqual([[m.rowText, 1, m.handle, false], [c3.rowText, 2, c3.handle, false]]);
    expect(cardView(v, { rowText: texts[0]!, handle: null, row: 0 })).toEqual({ kind: "page", text: texts[0]!, loading: false, lines: [] });
  });

  test("P14: rows go in page order — a row takes the single untaken candidate at the exact step, else at the unmarked step; one with none is missing", () => {
    // Page order [plain, merged] over one merged live event: the first row takes it at the unmarked step, so the second
    // row's exact candidate is already taken and it has none (order matters only through events earlier rows took).
    const page = pageOf([STANDUP, M2]);
    const texts = textsOf(page);
    expect(texts).toEqual(["09:00–09:30  Standup (Room 4)", "09:00–09:30  Standup (Room 4) · on 2 calendars"]);   // PREMISE
    const m = live(M2);
    const v = viewOf(page, detail([m], SKIPPED));
    expect([...v.rowLive]).toEqual([[0, v.live[0]!]]);
    expect(drawn(v)).toEqual([[m.rowText, 0, m.handle, false], [texts[1]!, 1, null, true]]);
    // Both at the exact step: each row takes its own full-text match.
    const page2 = pageOf([M2, STANDUP]);
    const p = live(STANDUP);
    const mm = live(M2);
    const v2 = viewOf(page2, detail([p, mm]));
    expect([...v2.rowLive]).toEqual([[0, byHandle(v2, mm.handle)!], [1, byHandle(v2, p.handle)!]]);
  });

  test("P15 k ≤ m: two identical rows over two identical live events take none — no fallback, both cards the page card, every live event drawn", () => {
    const page = pageOf([STANDUP, STANDUP]);
    const texts = textsOf(page);
    expect(texts).toEqual(["09:00–09:30  Standup (Room 4)", "09:00–09:30  Standup (Room 4)"]);   // PREMISE
    for (const sources of [[ok()], SKIPPED]) {
      const a = live(STANDUP);
      const b = live(STANDUP);
      const v = viewOf(page, detail([a, b], sources));
      expect([...v.rowLive]).toEqual([[0, "several"], [1, "several"]]);
      expect(drawn(v)).toEqual([[a.rowText, null, a.handle, false], [b.rowText, null, b.handle, false]]);
      for (const i of [0, 1]) {
        expect(cardView(v, { rowText: texts[i]!, handle: null, row: i })).toEqual({ kind: "page", text: texts[i]!, loading: false, lines: [] });
      }
    }
  });

  test("P15 k > m: three identical rows over two — the same map in both phases, the last row missing; a fallback in partial, not drawn in read", () => {
    const page = pageOf([STANDUP, STANDUP, STANDUP]);
    const texts = textsOf(page);
    const a = live(STANDUP);
    const b = live(STANDUP);
    const read = viewOf(page, detail([a, b]));
    const partial = viewOf(page, detail([a, b], SKIPPED));
    expect([read.phase, partial.phase]).toEqual(["read", "partial"]);   // PREMISE
    for (const v of [read, partial]) expect([...v.rowLive]).toEqual([[0, "several"], [1, "several"]]);
    expect(assignRows(page.calendar!.rows, read.live)).toEqual(read.rowLive);
    expect(drawn(read)).toEqual([[a.rowText, null, a.handle, false], [b.rowText, null, b.handle, false]]);
    expect(drawn(partial)).toEqual([[a.rowText, null, a.handle, false], [b.rowText, null, b.handle, false], [texts[2]!, 2, null, true]]);
    expect(cardView(read, { rowText: texts[2]!, handle: null, row: 2 })).toEqual({ kind: "changed", text: texts[2]! });
    expect(cardView(partial, { rowText: texts[2]!, handle: null, row: 2 })).toEqual({ kind: "fallback", text: texts[2]!, lines: partial.lines });
    for (const v of [read, partial]) expect(cardView(v, { rowText: texts[0]!, handle: null, row: 0 }).kind).toBe("page");
  });

  test("P16: row identity is the index among ALL the page's rows (status and \"+N more\" counted) through pageEvents/pageStrip and CardKey", () => {
    const fillers = Array.from({ length: 57 }, (_, i) => timed([17, 0], [17, 30], `Filler ${i}`));
    const page = pageWith([allDay("Offsite"), allDay("Offsite"), STANDUP, STANDUP, ...fillers], [MAC, { id: "work", kind: "link", status: "link-refused" }]);
    const rows = page.calendar!.rows;
    // PREMISE: a status row first, then the events, then "+1 more" (61 events, 60 lines).
    expect(rows.map((r) => r.kind).slice(0, 5)).toEqual(["status", "allDay", "allDay", "event", "event"]);
    expect([rows.length, rows[61]!.kind, rows[61]!.text]).toEqual([62, "more", "+1 more"]);
    const texts = textsOf(page);
    // Before a read: every page row carries its own index.
    const before = viewOf(page, NO_DETAIL);
    expect(before.strip.map((s) => s.row)).toEqual([1, 2]);
    expect(before.events.map((e) => e.row)).toEqual([3, 4, ...Array.from({ length: 56 }, (_, i) => 5 + i)]);
    // A partial read with one Offsite and one Standup live: the first of each pair takes it, the second is a fallback.
    const off = live(allDay("Offsite"));
    const s = live(STANDUP);
    const v = viewOf(page, detail([off, s], SKIPPED));
    expect([...v.rowLive]).toEqual([[1, byHandle(v, off.handle)!], [3, byHandle(v, s.handle)!]]);
    expect(v.strip.map((i) => [i.text, i.row, i.live?.handle ?? null, i.fallback])).toEqual([[off.rowText, 1, off.handle, false], [texts[2]!, 2, null, true]]);
    expect(drawn(v).slice(0, 2)).toEqual([[s.rowText, 3, s.handle, false], [texts[4]!, 4, null, true]]);
    expect(v.events.filter((e) => e.fallback && e.title.startsWith("Filler")).map((e) => e.row)).toEqual(Array.from({ length: 56 }, (_, i) => 5 + i));
    // The second Standup's card is its fallback, never the live event the first row took — though its text matches it.
    expect(cardView(v, { rowText: texts[4]!, handle: null, row: 4 })).toEqual({ kind: "fallback", text: texts[4]!, lines: v.lines });
    expect(cardView(v, { rowText: texts[2]!, handle: null, row: 2 }).kind).toBe("fallback");
    const first = cardView(v, { rowText: texts[3]!, handle: null, row: 3 });
    expect(first.kind === "live" && first.event.handle).toBe(s.handle);
    // The same text with no page row (a handle-only key) is today's text re-key: the live event.
    const handleOnly = cardView(v, { rowText: texts[4]!, handle: null, row: null });
    expect(handleOnly.kind === "live" && handleOnly.event.handle).toBe(s.handle);
  });

  test("P18: a card opened on a live event (row null) keeps today's re-key — by handle, else one text match; two → the page card in both phases; none → changed / fallback", () => {
    const page = pageOf([LUNCH]);
    const s = live(STANDUP);   // no page row
    const v = viewOf(page, detail([s, live(LUNCH)]));
    expect(v.events.find((e) => e.live?.handle === s.handle)?.row).toBeNull();
    const key = { rowText: s.rowText, handle: s.handle, row: null };
    const byHandleCard = cardView(v, key);
    expect(byHandleCard.kind === "live" && byHandleCard.event.handle).toBe(s.handle);
    // A later read with new handles: the one text match.
    const s2 = live(STANDUP);
    const again = cardView(viewOf(page, detail([s2, live(LUNCH)])), key);
    expect(again.kind === "live" && again.event.handle).toBe(s2.handle);
    for (const sources of [[ok()], SKIPPED]) {
      const two = viewOf(page, detail([live(STANDUP), live(STANDUP), live(LUNCH)], sources));
      expect(cardView(two, key)).toEqual({ kind: "page", text: s.rowText, loading: false, lines: [] });
    }
    expect(cardView(viewOf(page, detail([live(LUNCH)])), key)).toEqual({ kind: "changed", text: s.rowText });
    const partial = viewOf(page, detail([live(LUNCH)], SKIPPED));
    expect(cardView(partial, key)).toEqual({ kind: "fallback", text: s.rowText, lines: partial.lines });
  });
});

describe("near-duplicates (spec §5): the slide's open state, by page-row index or live handle (P17)", () => {
  type Item = { rowText?: string; text?: string; live: { handle: string } | null; row: number | null };
  /** The key a drawn item opens its card with (the slide's call sites pass its text, live event and row). */
  const keyOf = (i: Item): CardKey => ({ rowText: i.rowText ?? i.text ?? "", handle: i.live?.handle ?? null, row: i.row });

  test("two identical-text page rows open and close separately", () => {
    const page = pageOf([STANDUP, STANDUP]);
    const v = viewOf(page, NO_DETAIL);
    const [k0, k1] = v.events.map(keyOf) as [CardKey, CardKey];
    expect([k0.rowText === k1.rowText, k0.row, k1.row]).toEqual([true, 0, 1]);   // PREMISE: same text, two rows
    const open = toggleOpenCard(null, k0, v);
    expect(open).toBe(k0);
    expect([sameOpenCard(open, k0, v), sameOpenCard(open, k1, v)]).toEqual([true, false]);
    expect(toggleOpenCard(open, k1, v)).toBe(k1);
    expect(toggleOpenCard(open, k0, v)).toBeNull();
    expect(sameOpenCard(null, k0, v)).toBe(false);
  });

  test("two identical-text live blocks with different handles open and highlight separately", () => {
    const page = pageOf([LUNCH]);
    const a = live(STANDUP);
    const b = live(STANDUP);
    const v = viewOf(page, detail([a, b, live(LUNCH)]));
    const ka = keyOf(v.events.find((e) => e.live?.handle === a.handle)!);
    const kb = keyOf(v.events.find((e) => e.live?.handle === b.handle)!);
    expect([ka.rowText === kb.rowText, ka.row, kb.row]).toEqual([true, null, null]);   // PREMISE: handle-only, same text
    expect([sameOpenCard(ka, ka, v), sameOpenCard(ka, kb, v), sameOpenCard(kb, ka, v)]).toEqual([true, false, false]);
    expect(toggleOpenCard(ka, kb, v)).toBe(kb);
    expect(toggleOpenCard(ka, ka, v)).toBeNull();
  });

  test("a card opened on page row i before the read stays open after it: the item rowLive assigned to row i is the same identity", () => {
    const page = pageOf([STANDUP, LUNCH]);
    const before = viewOf(page, NO_DETAIL);
    const open = toggleOpenCard(null, keyOf(before.events[1]!), before)!;
    expect(open).toEqual({ rowText: "13:00–14:00  Lunch", handle: null, row: 1 });
    const lunch = live(LUNCH);
    const v = viewOf(page, detail([live(STANDUP), lunch]));
    const item = v.events.find((e) => e.live?.handle === lunch.handle)!;
    expect(item.row).toBe(1);
    expect(sameOpenCard(open, keyOf(item), v)).toBe(true);   // what that block's aria-expanded binds to
    expect(sameOpenCard(open, keyOf(v.events[0]!), v)).toBe(false);
    expect(toggleOpenCard(open, keyOf(item), v)).toBeNull();
  });

  test("Draft 7 re-read: a handle-only open block follows its card's own re-key to the next read's new handle; several or none: nothing open", () => {
    const page = pageOf([LUNCH]);
    const v1 = viewOf(page, detail([live(STANDUP, { handle: "A" }), live(LUNCH)]));
    const open = toggleOpenCard(null, keyOf(v1.events.find((e) => e.live?.handle === "A")!), v1)!;
    expect(open).toMatchObject({ handle: "A", row: null });
    const v2 = viewOf(page, detail([live(STANDUP, { handle: "B" }), live(LUNCH)]));
    const kB = keyOf(v2.events.find((e) => e.live?.handle === "B")!);
    expect(v2.live.some((e) => e.handle === "A")).toBe(false);   // PREMISE: every read issues new handles
    expect(sameOpenCard(open, kB, v2)).toBe(true);
    expect(toggleOpenCard(open, kB, v2)).toBeNull();
    expect(sameOpenCard(open, keyOf(v2.events.find((e) => e.title === "Lunch")!), v2)).toBe(false);
    // Two identical-text events in the next read (the page card): neither block is open.
    const v3 = viewOf(page, detail([live(STANDUP, { handle: "B" }), live(STANDUP, { handle: "C" }), live(LUNCH)]));
    for (const h of ["B", "C"]) expect({ h, open: sameOpenCard(open, keyOf(v3.events.find((e) => e.live?.handle === h)!), v3) }).toEqual({ h, open: false });
    // The event gone (changed): nothing open.
    const v4 = viewOf(page, detail([live(LUNCH)]));
    expect(v4.events.some((e) => sameOpenCard(open, keyOf(e), v4))).toBe(false);
  });

  test("M7: a handle-only block opened over a page-row tie follows its re-key when the next read gives that row one match (the new block carries the row)", () => {
    const page = pageOf([STANDUP]);
    const v1 = viewOf(page, detail([live(STANDUP, { handle: "A" }), live(STANDUP, { handle: "Z" })]));
    expect(v1.rowLive.get(0)).toBe("several");   // PREMISE: the row ties, so both blocks are handle-only
    const open = toggleOpenCard(null, keyOf(v1.events.find((e) => e.live?.handle === "A")!), v1)!;
    expect(open).toMatchObject({ handle: "A", row: null });
    // Read 2: Z gone, row 0 takes the new event B, whose block carries row 0.
    const v2 = viewOf(page, detail([live(STANDUP, { handle: "B" })]));
    const kB = keyOf(v2.events.find((e) => e.live?.handle === "B")!);
    expect(kB.row).toBe(0);   // PREMISE
    const card = cardView(v2, open);
    expect(card.kind === "live" && card.event.handle).toBe("B");   // PREMISE: the open card re-keys to B
    expect(sameOpenCard(open, kB, v2)).toBe(true);
    expect(toggleOpenCard(open, kB, v2)).toBeNull();
  });
});

describe("page replacement: carry the open card by statusless row occurrence", () => {
  const meeting = "09:00–09:30  Standup · on 2 calendars · tentative";
  const lunch = "12:00–13:00  Lunch";
  const before = [meeting, lunch];
  const key: CardKey = { row: 0, rowText: meeting, handle: "old-handle" };

  test("null stays closed", () => {
    expect(carryOpenKey(null, before, [lunch])).toBeNull();
  });

  test("unchanged text at the same index closes when its occurrence count changes", () => {
    expect(carryOpenKey(key, before, [meeting, meeting, lunch])).toBeNull();
  });

  test("a row inserted above moves the key to the unique matching row", () => {
    expect(carryOpenKey(key, before, ["08:00–08:30  Planning", ...before])).toEqual({ ...key, row: 1 });
  });

  test("text gone closes the card; a merge-mark change still closes it", () => {
    expect(carryOpenKey(key, before, [lunch])).toBeNull();
    expect(carryOpenKey(key, before, ["09:00–09:30  Standup · tentative"])).toBeNull();
    expect(carryOpenKey(key, before, [meeting.replace("on 2 calendars", "on 3 calendars")])).toBeNull();
  });

  test("an ended-only change keeps the exact key and its stored text", () => {
    expect(carryOpenKey(key, before, [`${meeting} · ended`, lunch])).toBe(key);
    expect(carryOpenKey(key, [`${meeting} · ended`, lunch], before)).toBe(key);
  });

  test("a tentative change keeps the exact key, including when the row moves", () => {
    const confirmed = meeting.replace(" · tentative", "");
    expect(carryOpenKey(key, before, [confirmed, lunch])).toBe(key);
    expect(carryOpenKey(key, [confirmed, lunch], before)).toBe(key);
    expect(carryOpenKey(key, before, [lunch, `${confirmed} · ended`])).toEqual({ ...key, row: 1 });
  });

  test("duplicates carry by statusless occurrence rank when a status row is inserted above", () => {
    const second: CardKey = { ...key, row: 1 };
    const confirmed = meeting.replace(" · tentative", "");
    const oldRows = [meeting, confirmed, lunch];
    const newRows = ["Reading your calendar…", confirmed, `${meeting} · ended`, lunch];
    expect(carryOpenKey(second, oldRows, newRows)).toEqual({ ...second, row: 2 });
    expect(carryOpenKey(key, oldRows, newRows)).toEqual({ ...key, row: 1 });
    expect(carryOpenKey({ ...second, row: 2 }, newRows, oldRows)).toEqual(second);
  });

  test("a duplicate count change closes even when the old index still matches", () => {
    const second: CardKey = { ...key, row: 1 };
    expect(carryOpenKey(second, [meeting, meeting, lunch], [lunch, meeting])).toBeNull();
    expect(carryOpenKey(second, [meeting, meeting, lunch], [meeting, meeting, meeting, lunch])).toBeNull();
  });

  test("rows → [] with the handle still live downgrades to a handle-only key and follows later reads", () => {
    const page = { ...pageOf([STANDUP]), calendar: null };
    const current = calendarDetailView(page, detail([live(STANDUP, { handle: key.handle! })]), true)!;
    const carried = carryOpenKey(key, before, [], current);
    expect(carried).toEqual({ ...key, row: null });
    expect(cardView(current, carried!)).toMatchObject({ kind: "live", event: { handle: key.handle } });
    const reread = calendarDetailView(page, detail([live(STANDUP, { handle: "new-handle", rowText: key.rowText })]), true)!;
    expect(cardView(reread, carried!)).toMatchObject({ kind: "live", event: { handle: "new-handle" } });
    expect(carried).toEqual({ ...key, row: null }); // T7.2: live re-reads never rewrite the stored key.
  });

  test("a page row removed after a live re-read carries the card's current handle", () => {
    const page = pageOf([STANDUP]);
    const rows = page.calendar!.rows.map((r) => r.text);
    const opened: CardKey = { row: 0, rowText: rows[0]!, handle: "h1" };
    const initial = viewOf(page, detail([live(STANDUP, { handle: "h1" })]));
    expect(cardView(initial, opened)).toMatchObject({ kind: "live", event: { handle: "h1" } });

    const rereadDetail = detail([live(STANDUP, { handle: "h2" })]);
    const reread = viewOf(page, rereadDetail);
    expect(reread.live.some((e) => e.handle === "h1")).toBe(false);
    expect(cardView(reread, opened)).toMatchObject({ kind: "live", event: { handle: "h2" } });

    const carried = carryOpenKey(opened, rows, [], reread);
    expect(carried).toEqual({ ...opened, handle: "h2", row: null });
    const replaced = calendarDetailView({ ...page, calendar: null }, rereadDetail, true)!;
    expect(cardView(replaced, carried!)).toMatchObject({ kind: "live", event: { handle: "h2" } });
    expect(opened).toEqual({ row: 0, rowText: rows[0]!, handle: "h1" });
  });

  test("a vanished row never resolves through its old index on the new page (that index may name another meeting)", () => {
    const A = { ...STANDUP, title: "Alpha" }, B = { ...STANDUP, title: "Bravo" }, C = { ...STANDUP, title: "Charlie" };
    const oldPage = pageOf([A, B]), newPage = pageOf([A, C]);
    const oldRows = oldPage.calendar!.rows.map((r) => r.text), newRows = newPage.calendar!.rows.map((r) => r.text);
    const open: CardKey = { row: 1, rowText: oldRows[1]!, handle: "hB" };
    const current = viewOf(newPage, detail([live(A, { handle: "hA" }), live(C, { handle: "hC" })]));
    // Premise: on the new page, row 1 is Charlie's and resolves to Charlie's live event.
    expect(cardView(current, { ...open, rowText: newRows[1]! })).toMatchObject({ kind: "live", event: { handle: "hC" } });
    expect(carryOpenKey(open, oldRows, newRows, current)).toBeNull();
  });

  test("rows → [] re-keys like origin/main: a stale handle follows the one live event with the same text, else closes", () => {
    // Handles change on every read, so the one same-text live event is the inherited unique-text re-key target
    // (spec §5 "Live-event cards"), exactly as origin/main would pick it.
    const current = viewOf(pageOf([STANDUP]), detail([live(STANDUP, { handle: "another-handle", rowText: meeting })]));
    expect(carryOpenKey(key, before, [], current)).toEqual({ ...key, handle: "another-handle", row: null });
    const twice = viewOf(pageOf([STANDUP]), detail([
      live(STANDUP, { handle: "a1", rowText: meeting }), live(STANDUP, { handle: "a2", rowText: meeting }),
    ]));
    expect(carryOpenKey(key, before, [], twice)).toBeNull(); // two text matches: no single live event to follow
    expect(carryOpenKey(key, before, [])).toBeNull();
  });

  test("any missing row can downgrade by a still-live handle, preserving the stored text", () => {
    const current = viewOf(pageOf([STANDUP]), detail([live(STANDUP, { handle: key.handle! })]));
    expect(carryOpenKey(key, before, [lunch], current)).toEqual({ ...key, row: null });
    expect(carryOpenKey({ ...key, row: 9 }, before, [lunch], current)).toEqual({ ...key, row: null });
    expect(carryOpenKey({ ...key, handle: null }, before, [], current)).toBeNull();
  });

  test("two matching rows at other indices close the card rather than guessing", () => {
    expect(carryOpenKey(key, before, [lunch, meeting, meeting])).toBeNull();
  });

  test("a handle-only key is untouched", () => {
    const liveKey: CardKey = { ...key, row: null };
    expect(carryOpenKey(liveKey, before, [])).toBe(liveKey);
  });

  test("an identical-content page keeps the exact key", () => {
    expect(carryOpenKey(key, before, [...before])).toBe(key);
  });

  test("matches the old page row even when the key was opened on different live text", () => {
    const liveTextKey = { ...key, rowText: "09:00–09:30  Standup" };
    expect(carryOpenKey(liveTextKey, before, [lunch, meeting])).toEqual({ ...liveTextKey, row: 1 });
  });
});

describe("C-M5-T13: the timeline's layout (the window, the lanes, the now line)", () => {
  test("the default window is 08:00 to 18:00, an event outside it widens it to whole hours", () => {
    const v = viewOf(pageOf([STANDUP, LUNCH]), NO_DETAIL);
    const lay = timelineLayout(v, at(TODAY, 8, 30));
    expect([lay.from, lay.len]).toEqual([8 * HOUR, 10 * HOUR]);
    expect(lay.marks.map((m) => m.label)).toEqual(["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"]);
    expect(lay.blocks.map((b) => [b.e.title, b.from, b.to])).toEqual([["Standup (Room 4)", 9 * HOUR, 9.5 * HOUR], ["Lunch", 13 * HOUR, 14 * HOUR]]);
    const wide = timelineLayout(viewOf(pageOf([timed([6, 30], [7, 0], "Early"), timed([19, 15], [20, 0], "Late")]), NO_DETAIL), at(TODAY, 8));
    expect([wide.from, wide.from + wide.len]).toEqual([6 * HOUR, 20 * HOUR]);
    expect(wide.marks[0]).toEqual({ label: "06:00", at: 6 * HOUR });
    expect(wide.marks.at(-1)).toEqual({ label: "20:00", at: 20 * HOUR });
  });

  test("overlapping events take lanes side by side; a lone one takes the whole width", () => {
    const v = viewOf(pageOf([STANDUP, timed([9, 15], [10, 0], "Overlap"), LUNCH]), NO_DETAIL);
    const lay = timelineLayout(v, at(TODAY, 8));
    expect(lay.blocks.map((b) => [b.e.title, b.lane, b.lanes])).toEqual([
      ["Standup (Room 4)", 0, 2],
      ["Overlap", 1, 2],
      ["Lunch", 0, 1],
    ]);
  });

  test("back-to-back 15-minute meetings take different lanes for their drawn minimum height", () => {
    const v = viewOf(pageOf([timed([10, 0], [10, 15], "First"), timed([10, 15], [10, 30], "Second")]), NO_DETAIL);
    const lay = timelineLayout(v, at(TODAY, 8));
    expect(lay.blocks.map((b) => [b.lane, b.lanes])).toEqual([[0, 2], [1, 2]]);
  });

  test("15-minute meetings starting 40 minutes apart reuse the lane after the drawn minimum height", () => {
    const v = viewOf(pageOf([timed([10, 0], [10, 15], "First"), timed([10, 40], [10, 55], "Second")]), NO_DETAIL);
    const lay = timelineLayout(v, at(TODAY, 8));
    expect(lay.blocks.map((b) => [b.lane, b.lanes])).toEqual([[0, 1], [0, 1]]);
  });

  test("round 5 L1: the window holds each event's drawn minimum height (a 17:45–18:00 meeting does not draw past 18:00)", () => {
    const lay = timelineLayout(viewOf(pageOf([timed([17, 45], [18, 0], "Late short")]), NO_DETAIL), at(TODAY, 8));
    const b = lay.blocks[0]!;
    expect([b.from, b.to]).toEqual([17.75 * HOUR, 18 * HOUR]);   // PREMISE: the real span ends at 18:00
    expect(b.from + TIMELINE_MIN_BLOCK_MS).toBeLessThanOrEqual(lay.from + lay.len);
    expect([lay.from, lay.from + lay.len]).toEqual([8 * HOUR, 19 * HOUR]);
    // A meeting whose drawn height already ends inside the default window leaves it as it is.
    const inside = timelineLayout(viewOf(pageOf([timed([17, 0], [17, 15], "Short")]), NO_DETAIL), at(TODAY, 8));
    expect([inside.from, inside.from + inside.len]).toEqual([8 * HOUR, 18 * HOUR]);
  });

  test("the now line: on the page's day inside the window only", () => {
    const v = viewOf(pageOf([STANDUP]), NO_DETAIL);
    expect(timelineLayout(v, at(TODAY, 8, 30)).nowAt).toBe(8.5 * HOUR);
    expect(timelineLayout(v, at(TODAY, 7)).nowAt).toBeNull();
    expect(timelineLayout(v, at(TODAY, 8, 30, 1)).nowAt).toBeNull();
  });

  test("a clocks-change day measures the window from the local midnights (America/Los_Angeles, 2026-11-01: 25 hours)", () => {
    inZone("America/Los_Angeles", 420, () => {
      const back = "2026-11-01";
      const v = viewOf(pageOf([timed([0, 30], [3, 0], "Night", {}, back)], back, back), NO_DETAIL);
      const lay = timelineLayout(v, at(back, 1, 30));
      // 00:00 to 18:00 local is 19 real hours on the day the clocks go back.
      expect([lay.from, lay.len]).toEqual([0, 19 * HOUR]);
      expect(lay.marks.find((m) => m.label === "03:00")!.at).toBe(4 * HOUR);
      expect(lay.blocks.map((b) => [b.from, b.to])).toEqual([[0.5 * HOUR, 4 * HOUR]]);
    });
  });
});

describe("C-M5-T13: the card's replies, as steps (Join and the details by handle)", () => {
  test("Join: opened, the ask-first question, a stale handle, and the refusals that show nothing", () => {
    expect(joinStep({ opened: true })).toEqual({ kind: "opened" });
    expect(joinStep({ ask: "whereby.com", serviceName: "Whereby" })).toEqual({ kind: "ask", question: "Open this Whereby link on whereby.com?" });
    expect(joinStep({ ask: "example.org" })).toEqual({ kind: "ask", question: "Open this link on example.org?" });
    expect(joinStep({ refused: "stale" })).toEqual({ kind: "stale" });
    for (const r of [{ refused: "several" }, { refused: "no-link" }] as const) {
      expect(joinStep(r)).toEqual({ kind: "none" });
    }
  });

  test("the details: the people line and the full notes, as one core box; a stale handle", () => {
    const people = [{ name: "Priya Sharma", organiser: true }, { name: "Sam Lee", organiser: false }];
    expect(detailsStep({ people, notes: "Agenda\nItem" })).toEqual({
      kind: "details", people: peopleLine(people), notes: [{ kind: "core", title: null, notes: "Agenda\nItem", label: "Notes" }],
    });
    expect(detailsStep({ people: [], notes: null })).toEqual({ kind: "details", people: { text: "Just you", chips: [] }, notes: [] });
    expect(detailsStep({ refused: "stale" })).toEqual({ kind: "stale" });
  });

  test("M2: unavailable details have a plain line, distinct from a real empty attendee list (\"Just you\", above)", () => {
    expect(detailsStep({ people: null, notes: null })).toEqual({ kind: "details", people: { text: "Details not available", chips: [] }, notes: [] });
  });

  /** The box list `detailsStep` builds for a reply's `notes` and `otherNotes` (people irrelevant here). */
  const boxes = (notes: string | null, otherNotes?: { title: string | null; notes: string }[]): unknown => {
    const step = detailsStep({ people: [], notes, ...(otherNotes !== undefined ? { otherNotes } : {}) });
    if (step.kind !== "details") throw new Error("expected details");
    return step.notes;
  };
  const core = (notes: string) => ({ kind: "core", title: null, notes, label: "Notes" });
  const other = (title: string | null, notes: string | null) =>
    ({ kind: "other", title, notes, label: title === null ? "Notes from other copy" : `Notes from other copy: ${title}` });

  test("C04 (GUI half): one box per view, core first, then the others in order; null core notes draw no core box; an old payload draws the core box only", () => {
    expect(boxes("Core agenda", [{ title: "Ticket: Dentist", notes: "Bring card" }, { title: null, notes: "Parking B" }]))
      .toEqual([core("Core agenda"), other("Ticket: Dentist", "Bring card"), other(null, "Parking B")]);
    expect(boxes(null, [{ title: "Ticket: Dentist", notes: "Bring card" }])).toEqual([other("Ticket: Dentist", "Bring card")]);
    expect(boxes(null, [{ title: null, notes: "Bring card" }])).toEqual([other(null, "Bring card")]);
    expect(boxes("Core agenda")).toEqual([core("Core agenda")]);   // no otherNotes: unmerged or an older engine
    expect(boxes(null)).toEqual([]);
    expect(boxes(null, [])).toEqual([]);
  });

  test("C05: an other box's label — \"Notes from other copy\", plus its title when shown; an entry with empty notes and a null title is not drawn", () => {
    expect(boxes("A", [{ title: null, notes: "B" }])).toEqual([core("A"), { kind: "other", title: null, notes: "B", label: "Notes from other copy" }]);
    expect(boxes("A", [{ title: "Ticket: X", notes: "B" }])).toEqual([core("A"), { kind: "other", title: "Ticket: X", notes: "B", label: "Notes from other copy: Ticket: X" }]);
    expect(boxes("A", [{ title: null, notes: "" }])).toEqual([core("A")]);
    expect(boxes("A", [{ title: null, notes: " \n " }])).toEqual([core("A")]);   // blank is empty, as the core's
    // Empty notes with a shown title: a title-only box.
    expect(boxes("A", [{ title: "Ticket: X", notes: "" }])).toEqual([core("A"), other("Ticket: X", null)]);
  });

  test("C06: identical notes show their body once — an untitled repeat is not drawn, a titled one keeps only its title line; different notes keep separate boxes", () => {
    expect(boxes("Same", [{ title: null, notes: "Same" }])).toEqual([core("Same")]);
    expect(boxes("Same", [{ title: "Ticket: X", notes: "Same" }])).toEqual([core("Same"), other("Ticket: X", null)]);
    // A repeat of an earlier OTHER box, too (not only of the core's).
    expect(boxes(null, [{ title: null, notes: "Gate 3" }, { title: null, notes: "Gate 3" }, { title: "Reservation – X", notes: "Gate 3" }]))
      .toEqual([other(null, "Gate 3"), other("Reservation – X", null)]);
    // Trailing whitespace is not a difference.
    expect(boxes("Same", [{ title: null, notes: "Same\n\n" }])).toEqual([core("Same")]);
    expect(boxes("One", [{ title: null, notes: "Two" }, { title: null, notes: "Three" }])).toEqual([core("One"), other(null, "Two"), other(null, "Three")]);
  });

  test("C07: the box model never truncates — long notes are kept whole, past four lines and past 600 characters (the engine's cap is not a UI cut)", () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
    expect(long.length).toBeGreaterThan(600);   // PREMISE
    expect(boxes(long, [{ title: null, notes: `${long}!` }])).toEqual([core(long), other(null, `${long}!`)]);
  });

  test("the card's facts: a live event's own title, time and place; a page row's text split into what and when", () => {
    const page = pageOf([STANDUP, REVIEW]);
    const read = viewOf(page, detail([live(STANDUP), live({ ...REVIEW, title: "" })]));
    expect(cardFacts(cardView(read, { rowText: page.calendar!.rows[0]!.text, handle: null, row: 0 }))).toEqual({
      title: "Standup", when: "09:00–09:30", place: "Room 4", marks: [],
    });
    const untitled = read.live.find((e) => e.title === "")!;
    expect(cardFacts(cardView(read, { rowText: untitled.rowText, handle: untitled.handle, row: null }))).toEqual({
      title: "(no title)", when: "11:00–12:00", place: null, marks: ["tentative"],
    });
    const before = viewOf(page, NO_DETAIL);
    expect(cardFacts(cardView(before, { rowText: page.calendar!.rows[1]!.text, handle: null, row: 1 }))).toEqual({
      title: "Design review", when: "11:00–12:00", place: null, marks: ["tentative"],
    });
    const changed = viewOf(page, detail([live(STANDUP)]));
    expect(cardFacts(cardView(changed, { rowText: page.calendar!.rows[1]!.text, handle: null, row: 1 }))).toEqual({
      title: "Design review", when: "11:00–12:00", place: null, marks: ["tentative"],
    });
  });

  test("C-M5-T14: the tiles' events: the page's before a read and after a whole-read failure, the live ones after a read", () => {
    const page = pageOf([STANDUP, LUNCH]);
    expect(tileEvents(page, null)).toBe(page.calendar!.events);
    expect(tileEvents(page, viewOf(page, NO_DETAIL))).toBe(page.calendar!.events);
    expect(tileEvents(page, viewOf(page, detail([], [failedSrc("macos", "timeout")])))).toBe(page.calendar!.events);
    // Standup cancelled since the page: it leaves the tiles; the live Lunch carries its live event (its Join).
    const read = viewOf(page, detail([live(LUNCH, { linkState: "one", joinHost: "zoom.us" })]));
    const events = tileEvents(page, read);
    expect(events.map((e) => e.title)).toEqual(["Lunch"]);
    expect(meetingTile(TODAY, events, at(TODAY, 12, 50))?.event.title).toBe("Lunch");
    expect(meetingTile(TODAY, events, at(TODAY, 8, 50))).toBeNull();
    expect(liveOf(read, events[0]!)?.joinHost).toBe("zoom.us");
    expect(liveOf(viewOf(page, NO_DETAIL), page.calendar!.events[0]!)).toBeNull();
    expect(liveOf(null, page.calendar!.events[0]!)).toBeNull();
    // After a partial read the fallback rows stay too (no Join on them).
    const partial = viewOf(page, detail([live(LUNCH)], [ok(), failedSrc("work", "timeout")]));
    expect(tileEvents(page, partial).map((e) => [e.title, liveOf(partial, e) !== null])).toEqual([["Standup (Room 4)", false], ["Lunch", true]]);
  });

  test("the notes' full text (no four-line cut: the box scrolls), as plain text; blank notes are none", () => {
    expect(notesText("one\ntwo\nthree\nfour\nfive\nsix")).toBe("one\ntwo\nthree\nfour\nfive\nsix");
    expect(notesText("one\n\n\ntwo\n")).toBe("one\n\n\ntwo");
    expect(notesText("  \n \n")).toBeNull();
    expect(notesText(null)).toBeNull();
    // A link-shaped note is only text: nothing here parses it.
    expect(notesText("javascript:alert(1)\nmsteams:/l/x")).toBe("javascript:alert(1)\nmsteams:/l/x");
  });
});


describe("final-round Join model: handle-bound confirmation and plain reply words", () => {
  const asked = () => {
    const first = joinClick(idleJoin("A"));
    expect(first.call).toEqual({ handle: "A", confirmed: false, revision: 1 });
    const reply = joinReply(first.model, first.call!, { ask: "example.org" });
    expect(reply.model.state).toEqual({ kind: "asking", handle: "A", question: "Open this link on example.org?" });
    expect(reply.model.busy).toBe(false);
    return reply.model;
  };
  test("H1/W09: first click is unconfirmed; an ask sets the question; Yes confirms the stored A", () => {
    const yes = joinClick(asked(), true);
    expect(yes.call).toEqual({ handle: "A", confirmed: true, revision: 2 });
    expect(yes.model.state).toEqual({ kind: "idle" });
    expect(joinClick(yes.model).call).toBeNull();
    expect(joinReply(yes.model, yes.call!, { opened: true }).model.state).toEqual({ kind: "done" });
  });
  test("H1: A question followed by B clears it; Yes sends nothing for B", () => {
    const b = joinHandle(asked(), "B");
    expect(b.state).toEqual({ kind: "idle" });
    expect(b.busy).toBe(false);
    expect(joinClick(b, true).call).toBeNull();
    expect(joinClick(b).call?.confirmed).toBe(false);
  });
  test("H1: old replies are dropped, even after A to B to A", () => {
    const first = joinClick(idleJoin("A"));
    const b = joinHandle(first.model, "B");
    expect(b.busy).toBe(false);
    for (const m of [b, joinHandle(b, "A")]) {
      for (const reply of [{ ask: "old.example" }, { refused: "stale" }, { failed: "opener" }] as const) {
        expect(joinReply(m, first.call!, reply)).toEqual({ model: m, stale: false });
      }
    }
  });
  test("H2: fixed errors are plain words, several/no-link silent, stale refreshes once; click/handle/No clear", () => {
    expect(JOIN_OPENER_LINE).toBe("Couldn't open the meeting link");
    expect(JOIN_INVALID_LINE).toBe("This meeting link can't be opened from here");
    for (const [r, line] of [[{ failed: "opener" }, JOIN_OPENER_LINE], [{ refused: "invalid-link" }, JOIN_INVALID_LINE]] as const) {
      expect(joinStep(r)).toEqual({ kind: "failed", line });
      const first = joinClick(idleJoin("A"));
      const m = joinReply(first.model, first.call!, r).model;
      expect(m.state).toEqual({ kind: "failed", line });
      expect(joinClick(m).model.state).toEqual({ kind: "idle" });
      expect(joinHandle(m, "B").state).toEqual({ kind: "idle" });
    }
    for (const r of [{ refused: "several" }, { refused: "no-link" }, null] as const) {
      const first = joinClick(idleJoin("A"));
      expect(joinReply(first.model, first.call!, r)).toMatchObject({ model: { busy: false, state: { kind: "done" } }, stale: false });
    }
    const first = joinClick(idleJoin("A"));
    expect(joinReply(first.model, first.call!, { refused: "stale" }).stale).toBe(true);
    expect(joinClick(dismissJoin(asked()), true).call).toBeNull();
  });
});

describe("final-round calendar model guards", () => {
  test("M1: a list from another local day is dropped before building the view", () => {
    const d = detail([live(LUNCH)]);
    d.list!.readAt = new Date(at("2026-10-15", 23, 59)).toISOString();
    const v = viewOf(pageOf([STANDUP]), d);
    expect(v.phase).toBe("before");
    expect(v.live).toEqual([]);
    expect(v.readAt).toBeNull();
    expect(v.events.map((e) => e.title)).toEqual(["Standup (Room 4)"]);
  });
  test("round 5 M1: a read with no source (nothing connected, or Mac-only off a Mac) is not an empty day", () => {
    const text = renderBriefing({ date: TODAY, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [], calendar: cal([], []) } as EngineStruct);
    const r = mapPage(renderMarkdown(text), TODAY);
    if (!r.ok) throw new Error(`expected the page to map, got ${r.reason}`);
    expect(r.page.calendar!.rows.map((row) => row.text)).toEqual(["No calendar is connected"]);   // PREMISE: the page's own line
    const v = viewOf(r.page, detail([], []));
    // A page phase: the slide keeps the page's status line, and nothing says "No events today".
    expect(v.phase).toBe("failed");
    expect([v.events, v.strip, v.live, v.lines]).toEqual([[], [], [], []]);
    expect(tileEvents(r.page, v)).toEqual(r.page.calendar!.events);
    // With the morning's events still on the page, they stay drawn as the page has them (never "changed").
    const page = pageOf([STANDUP]);
    const kept = viewOf(page, detail([], []));
    expect(kept.phase).toBe("failed");
    expect(kept.events.map((e) => [e.title, e.live])).toEqual([["Standup (Room 4)", null]]);
    expect(cardView(kept, { rowText: page.calendar!.rows[0]!.text, handle: null, row: 0 }).kind).toBe("page");
  });
  test("M4: an all-day or unclear-only strip has no subtitle", () => {
    const unclear = { ...STANDUP, time: { kind: "unclear", startDate: TODAY, endDate: TODAY, wallStart: "08:00", wallEnd: "09:00", tzid: "Mars/Base" } } as CalendarStructEvent;
    for (const e of [allDay("Offsite"), unclear]) {
      for (const d of [NO_DETAIL, detail([live(e)])]) {
        const v = viewOf(pageOf([e]), d);
        expect(v.events).toEqual([]);
        expect(v.strip).toHaveLength(1);
        expect(subtitle(v, at(TODAY, 8))).toBeNull();
      }
    }
  });
  test("L3: Open in Calendar requires macOS, retaining null/false configuration rule", () => {
    const v = viewOf(pageOf([STANDUP]), NO_DETAIL);
    const c = cardView(v, { rowText: STANDUP.title, handle: null, row: 0 });
    expect(openInCalendar(v, c, "macos")).toBe(true);
    expect(openInCalendar({ ...v, macConfigured: false }, c, "macos")).toBe(false);
    expect(openInCalendar(v, c, "linux")).toBe(false);
    const liveView = viewOf(pageOf([STANDUP]), detail([live(STANDUP)]));
    const liveCard = cardView(liveView, { rowText: liveView.live[0]!.rowText, handle: null, row: null });
    expect(openInCalendar(liveView, liveCard, "linux")).toBe(false);
    expect(openInCalendar({ ...liveView, macConfigured: false }, liveCard, "macos")).toBe(false);
  });
  test("L5/W15: a known product host that needs confirmation is still named as a host", () => {
    const e = liveEvent(live(STANDUP, { linkState: "one", joinHost: "acme.zoom.us", needsConfirm: true }))!;
    expect(tileJoinLabel(e, true)).toBe("Join now on acme.zoom.us ↗");
  });
});

describe("L5: each of the card's safety layers in isolation", () => {
  const event = liveEvent(live(STANDUP, { handle: "A" }))!;
  const card = { kind: "live" as const, event, footnote: "", lines: [] };
  const data = (): CardDetails => ({ handle: "A", day: TODAY, endMs: at(TODAY, 9, 30), people: peopleLine([]), notes: [{ kind: "core", title: null, notes: "private", label: "Notes" }] });
  const reply = { people: [], notes: "private" };
  test("W01: reply guard rejects a different handle, including a stale reply", () => {
    for (const r of [reply, { refused: "stale" } as const]) {
      expect(cardDetailsReply("B", card, TODAY, r, at(TODAY, 9))).toEqual({ kind: "drop" });
    }
    expect(cardDetailsReply("A", card, TODAY, reply, at(TODAY, 9)).kind).toBe("details");
  });
  test("W02: handle reset drops old details from memory before a new reply", () => {
    const d = data();
    expect(resetCardDetails(d, "B")).toBeNull();
    expect(resetCardDetails(d, null)).toBeNull();
    expect(resetCardDetails(d, "A")).toBe(d);
  });
  test("W03: clock expiry drops held details even without a display evaluation", () => {
    const d = data();
    expect(expireCardDetails(d, at(TODAY, 9))).toBe(d);
    expect(expireCardDetails(d, at(TODAY, 9, 30))).toBeNull();
  });
  test("W05: reply storage refuses details arriving at or after the event's end", () => {
    expect(cardDetailsReply("A", card, TODAY, reply, at(TODAY, 9, 30))).toEqual({ kind: "drop" });
    expect(cardDetailsReply("A", card, TODAY, reply, at(TODAY, 9, 29)).kind).toBe("details");
  });
  test("C04/C09 (webview half): a reply's otherNotes reach the stored card details as boxes, under the same guards", () => {
    const merged = { ...reply, otherNotes: [{ title: "Ticket: Standup", notes: "other" }] };
    const r = cardDetailsReply("A", card, TODAY, merged, at(TODAY, 9));
    expect(r.kind === "details" && r.details.notes).toEqual([
      { kind: "core", title: null, notes: "private", label: "Notes" },
      { kind: "other", title: "Ticket: Standup", notes: "other", label: "Notes from other copy: Ticket: Standup" },
    ]);
    expect(cardDetailsReply("B", card, TODAY, merged, at(TODAY, 9))).toEqual({ kind: "drop" });
    expect(cardDetailsReply("A", card, TODAY, merged, at(TODAY, 9, 30))).toEqual({ kind: "drop" });
  });
  test("W04: shown guard hides old/expired details even if reset and expiry never ran", () => {
    const d = data();
    expect(shownCardDetails(d, "B", at(TODAY, 9))).toBeNull();
    expect(shownCardDetails(d, "A", at(TODAY, 9, 30))).toBeNull();
    expect(shownCardDetails(d, "A", at(TODAY, 9))).toBe(d);
  });
});

/* ── PB-M4-T1: a live calendar day's no-section view (wave-2 polish spec §5) ──────────────────────── */

describe("PB-M4-T1: the no-section view on a live calendar day", () => {
  /** Today's page with no calendar section. */
  const NO_SECTION = (() => {
    const r = mapPage(renderMarkdown(renderBriefing({ date: TODAY, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [] } as EngineStruct)), TODAY);
    if (!r.ok || r.page.calendar !== null || r.page.stale) throw new Error("expected today's page with no section");
    return r.page;
  })();
  const view = (d: CalendarDetail): CalendarDetailView => {
    const v = calendarDetailView(NO_SECTION, d, true);
    if (v === null) throw new Error("expected the no-section view");
    return v;
  };
  const NOON = at(TODAY, 12);
  const noEventsAnywhere = (v: CalendarDetailView): boolean => !v.lines.includes(CALENDAR_NO_EVENTS_TEXT) && subtitle(v, NOON) !== CALENDAR_NO_EVENTS_TEXT;

  test("the six line precedences: failed, sources: [], every source failed, an answer, no answer yet (\"on\" false is the deck's: no slide)", () => {
    // 2. A read that did not answer: READ_FAILED_LINE, whatever list is (not) held.
    const failed = view({ ...NO_DETAIL, failed: true });
    expect([failed.readState, failed.lines]).toEqual(["failed", [READ_FAILED_LINE]]);
    // 3. sources: [] — checked before phaseOf, which calls it `failed`.
    const none = view(detail([], []));
    expect([none.readState, none.lines]).toEqual(["noneConnected", [CALENDAR_NOT_CONNECTED_TEXT]]);
    // 4. Every source failed (at least one): CALENDAR_UNAVAILABLE_TEXT and each source's own line.
    const all = view(detail([], [failedSrc("macos", "timeout"), failedSrc("work", "offline")]));
    expect([all.readState, all.lines]).toEqual(["allFailed", [CALENDAR_UNAVAILABLE_TEXT, TIMEOUT_LINE, OFFLINE_LINE]]);
    // 5. An answer (read, partial): the live events, and the failed sources' lines (partial).
    const read = view(detail([live(STANDUP)]));
    expect([read.readState, read.phase, read.lines, read.events.map((e) => e.title)]).toEqual(["answered", "read", [], ["Standup (Room 4)"]]);
    const partial = view(detail([live(LUNCH)], [ok(), failedSrc("work", "timeout")]));
    expect([partial.readState, partial.phase, partial.lines, partial.events.map((e) => e.title)]).toEqual(["answered", "partial", [TIMEOUT_LINE], ["Lunch"]]);
    // 6. No answer yet: LOADING_LINE (with an ask outstanding, or not).
    for (const d of [NO_DETAIL, { ...NO_DETAIL, pending: true }]) {
      const waiting = view(d);
      expect([waiting.readState, waiting.lines, waiting.events, waiting.strip]).toEqual(["waiting", [LOADING_LINE], [], []]);
    }
    // Never "No events today" for a read that did not establish a free day.
    for (const v of [failed, none, all, view(NO_DETAIL)]) expect({ s: v.readState, ok: noEventsAnywhere(v) }).toEqual({ s: v.readState, ok: true });
  });

  test("the defensive branch: `off` with liveDay true reads allFailed (unavailable, never waiting or a free day) and draws only OFF_LINE", () => {
    // Unreachable through Today (a true calendar-off verdict patches the stored status off first, so liveDay is false
    // before the driver's `off` is drawn); pinned so a caller passing both still never reads as loading.
    const off = view({ ...NO_DETAIL, off: true });
    expect([off.readState, off.phase, off.lines, off.loading, off.events, off.strip]).toEqual(["allFailed", "off", [OFF_LINE], false, [], []]);
    expect(noEventsAnywhere(off)).toBe(true);
  });

  test("the view follows the driver's `failed` flag: `failed` set reads failed, an answered list reads answered (the driver's clearing is calendar-live.check.ts's)", () => {
    expect(view({ ...NO_DETAIL, failed: true }).readState).toBe("failed");
    expect(view(detail([live(STANDUP)])).readState).toBe("answered");
  });

  test("no page rows: an answer shows only the live events; before one, nothing", () => {
    expect(view(NO_DETAIL).events).toEqual([]);
    const allDay = view(detail([live({ title: "Offsite", time: { kind: "allDay", startDate: TODAY, endDateExclusive: "2026-10-17" }, status: "confirmed" } as CalendarStructEvent)]));
    expect(allDay.events).toEqual([]);
    expect(allDay.strip.map((s) => s.title)).toEqual(["Offsite"]);
  });

  test("subtitle: null for waiting, failed, noneConnected and allFailed; an answered-empty view says \"No events today\" once, as its subtitle only", () => {
    for (const d of [NO_DETAIL, { ...NO_DETAIL, failed: true }, detail([], []), detail([], [failedSrc("macos", "denied")])]) {
      const v = view(d);
      expect({ s: v.readState, sub: subtitle(v, NOON) }).toEqual({ s: v.readState, sub: null });
    }
    const empty = view(detail([]));
    expect(empty.readState).toBe("answered");
    expect(subtitle(empty, NOON)).toBe(CALENDAR_NO_EVENTS_TEXT);
    expect(empty.lines).toEqual([]);
    // A page with a section is unchanged: readState null, and its own subtitle rule.
    const section = viewOf(pageOf([]), detail([]));
    expect(section.readState).toBeNull();
    expect(subtitle(section, NOON)).toBe(CALENDAR_NO_EVENTS_TEXT);
  });

  test("tileEvents with the no-section view: none before a good read; exactly the live events after read and partial; none for answered-empty (no page-row fallback)", () => {
    for (const d of [NO_DETAIL, { ...NO_DETAIL, failed: true }, detail([], []), detail([], [failedSrc("macos", "timeout")])]) {
      const v = view(d);
      expect({ s: v.readState, n: tileEvents(NO_SECTION, v).length }).toEqual({ s: v.readState, n: 0 });
    }
    const read = view(detail([live(STANDUP), live(LUNCH)]));
    expect(tileEvents(NO_SECTION, read)).toBe(read.events);
    expect(tileEvents(NO_SECTION, read).map((e) => e.title)).toEqual(["Standup (Room 4)", "Lunch"]);
    const partial = view(detail([live(LUNCH)], [ok(), failedSrc("work", "timeout")]));
    expect(tileEvents(NO_SECTION, partial).map((e) => e.title)).toEqual(["Lunch"]);
    expect(tileEvents(NO_SECTION, view(detail([])))).toEqual([]);
  });

  test("P20 (near-duplicates spec §5, model half): no page rows — rowLive is empty, every drawn item is handle-only (row null, never a fallback), and today's re-key is the only path", () => {
    expect(NO_SECTION.calendar).toBeNull();   // PREMISE: no rows to assign
    const OFFSITE = { title: "Offsite", time: { kind: "allDay", startDate: TODAY, endDateExclusive: "2026-10-17" }, status: "confirmed" } as CalendarStructEvent;
    expect(assignRows([], [liveEvent(live(STANDUP))!]).size).toBe(0);
    for (const sources of [[ok()], [ok(), failedSrc("work", "timeout")]]) {
      const v = view(detail([live(STANDUP), live(LUNCH), live(OFFSITE)], sources));
      expect(v.phase).toBe(sources.length === 1 ? "read" : "partial");   // PREMISE
      expect(v.rowLive.size).toBe(0);
      const items = [...v.events, ...v.strip];
      expect(items.map((i) => [i.row, i.fallback, i.live !== null])).toEqual([[null, false, true], [null, false, true], [null, false, true]]);
    }
    // Waiting, failed, noneConnected and allFailed draw no items.
    for (const d of [NO_DETAIL, { ...NO_DETAIL, failed: true }, detail([], []), detail([], [failedSrc("macos", "timeout")])]) {
      const v = view(d);
      expect({ s: v.readState, drawn: [v.events, v.strip, v.rowLive.size] }).toEqual({ s: v.readState, drawn: [[], [], 0] });
    }
    // A drawn item's key is the live card; after a second read (new handles) today's re-key decides.
    const first = view(detail([live(STANDUP)]));
    const item = first.events[0]!;
    const key = { rowText: item.rowText, handle: item.live!.handle, row: item.row };
    expect(key.row).toBeNull();
    const opened = cardView(first, key);
    expect(opened.kind === "live" && opened.event.handle).toBe(item.live!.handle);
    const s2 = live(STANDUP);
    const again = cardView(view(detail([s2])), key);
    expect(again.kind === "live" && again.event.handle).toBe(s2.handle);
    for (const sources of [[ok()], [ok(), failedSrc("work", "timeout")]]) {
      expect(cardView(view(detail([live(STANDUP), live(STANDUP)], sources)), key)).toEqual({ kind: "page", text: item.rowText, loading: false, lines: [] });
    }
    expect(cardView(view(detail([live(LUNCH)])), key)).toEqual({ kind: "changed", text: item.rowText });
    const partial = view(detail([live(LUNCH)], [ok(), failedSrc("work", "timeout")]));
    expect(cardView(partial, key)).toEqual({ kind: "fallback", text: item.rowText, lines: partial.lines });
  });

  test("P20 (slide half): on a live calendar day two identical-text live blocks open and highlight separately, and an open block survives a re-read", () => {
    const keyOf = (e: CalendarDetailView["events"][number]): CardKey => ({ rowText: e.rowText, handle: e.live?.handle ?? null, row: e.row });
    const v = view(detail([live(STANDUP, { handle: "A" }), live(STANDUP, { handle: "Z" })]));
    const [ka, kz] = v.events.map(keyOf) as [CardKey, CardKey];
    expect([ka.rowText === kz.rowText, ka.row, kz.row, ka.handle, kz.handle]).toEqual([true, null, null, "A", "Z"]);   // PREMISE
    expect([sameOpenCard(ka, ka, v), sameOpenCard(ka, kz, v)]).toEqual([true, false]);
    expect(toggleOpenCard(ka, kz, v)).toBe(kz);
    expect(toggleOpenCard(ka, ka, v)).toBeNull();
    // The focus read: the same event with a new handle stays open, and clicking it closes it.
    const open: CardKey = { rowText: ka.rowText, handle: "A", row: null };
    const v2 = view(detail([live(STANDUP, { handle: "B" })]));
    const kB = keyOf(v2.events[0]!);
    expect(sameOpenCard(open, kB, v2)).toBe(true);
    expect(toggleOpenCard(open, kB, v2)).toBeNull();
    const v3 = view(detail([live(STANDUP, { handle: "B" }), live(STANDUP, { handle: "C" })]));
    expect(v3.events.some((e) => sameOpenCard(open, keyOf(e), v3))).toBe(false);
  });

  test("liveDayLine: waiting, failed, noneConnected, allFailed each give the slide's own words; answered and null give none", () => {
    expect(liveDayLine("waiting")).toBe(LOADING_LINE);
    expect(liveDayLine("failed")).toBe(READ_FAILED_LINE);
    expect(liveDayLine("noneConnected")).toBe(CALENDAR_NOT_CONNECTED_TEXT);
    expect(liveDayLine("allFailed")).toBe(CALENDAR_UNAVAILABLE_TEXT);
    expect(liveDayLine("answered")).toBeNull();
    expect(liveDayLine(null)).toBeNull();
    expect(READ_FAILED_LINE).toBe("Couldn't read your calendar just now");
  });

  test("a page with a section is unchanged: no READ_FAILED_LINE (even with `failed`), no OFF_LINE unless refused, readState null", () => {
    const page = pageOf([STANDUP]);
    const failedRead = viewOf(page, { ...NO_DETAIL, failed: true });
    expect([failedRead.readState, failedRead.phase, failedRead.lines]).toEqual([null, "before", []]);
    expect(failedRead.events.map((e) => [e.title, e.live])).toEqual([["Standup (Room 4)", null]]);
    // liveDay true changes nothing on a page with a section.
    expect(calendarDetailView(page, { ...NO_DETAIL, failed: true }, true)).toEqual(failedRead);
    expect(viewOf(page, NO_DETAIL).lines).not.toContain(OFF_LINE);
    expect(viewOf(page, { ...NO_DETAIL, off: true }).lines).toEqual([OFF_LINE]);
  });
});

/* ── PB-M4-T3: the polite announcement of a completed read (pure; Today supplies containment) ──────── */

describe("PB-M4-T3: announceCompletion — once per completed read, only with focus inside the calendar slide", () => {
  test("a new completion with containsFocus true announces once; the same completion again (a rerender) never repeats it", () => {
    const first = announceCompletion({ completion: 1, consumed: 0, containsFocus: true });
    expect(first).toEqual({ consumed: 1, announce: true });
    expect(announceCompletion({ completion: 1, consumed: first.consumed, containsFocus: true })).toEqual({ consumed: 1, announce: false });
  });
  test("containsFocus false (focus on the question card or the navigation, even with the calendar slide current) consumes it without announcing; a later containment never announces it", () => {
    const missed = announceCompletion({ completion: 2, consumed: 1, containsFocus: false });
    expect(missed).toEqual({ consumed: 2, announce: false });
    expect(announceCompletion({ completion: 2, consumed: missed.consumed, containsFocus: true })).toEqual({ consumed: 2, announce: false });
  });
  test("no new completion (a read pending, or none yet): nothing", () => {
    expect(announceCompletion({ completion: 0, consumed: 0, containsFocus: true })).toEqual({ consumed: 0, announce: false });
  });
  test("readStatusLine: a live day's line before an answer, else the first failure line, else the subtitle", () => {
    const NO_SECTION = (() => {
      const r = mapPage(renderMarkdown(renderBriefing({ date: TODAY, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [] } as EngineStruct)), TODAY);
      if (!r.ok) throw new Error("expected a page");
      return r.page;
    })();
    const NOON = at(TODAY, 12);
    expect(readStatusLine(calendarDetailView(NO_SECTION, { ...NO_DETAIL, failed: true }, true)!, NOON)).toBe(READ_FAILED_LINE);
    expect(readStatusLine(calendarDetailView(NO_SECTION, detail([]), true)!, NOON)).toBe("No events today");
    expect(readStatusLine(viewOf(pageOf([STANDUP]), detail([], [failedSrc("macos", "timeout")])), NOON)).toBe(TIMEOUT_LINE);
    expect(readStatusLine(viewOf(pageOf([LUNCH]), detail([live(LUNCH)])), at(TODAY, 12, 30))).toBe("1 event · 1h in meetings · next in 30 minutes");
  });
});

/* ── PB-M4 checkpoint MED: Today's announcement step, as a pure model ─────────────────────────────── */

describe("PB-M4 checkpoint MED: announceStep — a completed read is `pending` turning false; announced once, only with focus inside", () => {
  const run = (steps: [boolean, boolean][], line: string | null = "Reading done"): (string | null)[] => {
    let s: AnnounceState = ANNOUNCE_START;
    return steps.map(([pending, focus]) => {
      const r = announceStep(s, pending, focus, line);
      s = r.next;
      return r.text;
    });
  };
  test("a read sent then answered, focus inside: announced once; later runs (a rerender, the clock) never repeat it", () => {
    expect(run([[true, true], [false, true], [false, true], [false, true]])).toEqual([null, "Reading done", null, null]);
  });
  test("pending turning TRUE is not a completion (nothing is announced while a read is out)", () => {
    expect(run([[false, true], [true, true], [true, true]])).toEqual([null, null, null]);
  });
  test("no read at all: runs with pending false never count", () => {
    expect(run([[false, true], [false, true]])).toEqual([null, null]);
  });
  test("focus outside at completion consumes it: a later focus inside never announces that read; the next read does", () => {
    expect(run([[true, false], [false, false], [false, true], [true, true], [false, true]])).toEqual([null, null, null, null, "Reading done"]);
  });
  test("each completed read is its own announcement (two reads, focus inside both times)", () => {
    expect(run([[true, true], [false, true], [true, true], [false, true]])).toEqual([null, "Reading done", null, "Reading done"]);
  });
  test("no line to say (no live view): nothing announced, the completion still consumed", () => {
    let s: AnnounceState = ANNOUNCE_START;
    s = announceStep(s, true, true, null).next;
    const done = announceStep(s, false, true, null);
    expect(done.text).toBeNull();
    expect(announceStep(done.next, false, true, "late line").text).toBeNull();
  });
  test("the state it carries", () => {
    expect(ANNOUNCE_START).toEqual({ wasPending: false, completions: 0, consumed: 0 });
    const a = announceStep(ANNOUNCE_START, true, false, "x").next;
    expect(a).toEqual({ wasPending: true, completions: 0, consumed: 0 });
    expect(announceStep(a, false, false, "x").next).toEqual({ wasPending: false, completions: 1, consumed: 1 });
  });
});

describe("near-duplicates T6.3 (spec §6): the GUI mirror renders the decided merge mark exactly as the engine's calEventLine", () => {
  const merged = (mark: "calendars" | "copies", count: number): Partial<CalendarStructEvent> => ({ merged: { mark, count } });
  const UNCLEAR = { kind: "unclear", startDate: TODAY, endDate: TODAY, wallStart: "08:00", wallEnd: "09:00", tzid: "Mars/Base" } as const;
  // Both mark kinds on every line kind, with and without tentative/ended after the mark, counts 2–9 and 10+.
  const EVENTS: CalendarStructEvent[] = [
    { ...allDay("Offsite"), ...merged("calendars", 2) },
    { ...allDay("Retreat"), status: "tentative", ...merged("copies", 10) },
    { ...STANDUP, ...merged("calendars", 3) },
    { ...REVIEW, ended: true, ...merged("copies", 2) },
    timed([13, 0], [14, 0], "Ticket: X", { location: "Polk St", status: "tentative", ...merged("calendars", 12) }),
    timed([15, 0], [15, 30], "", merged("copies", 4)),
    { ...STANDUP, time: UNCLEAR, ...merged("calendars", 2) },
    { ...STANDUP, time: UNCLEAR, status: "tentative", ...merged("copies", 3) },
    // An unmerged event beside them renders as before, on both sides.
    { ...REVIEW },
  ];

  test("calendarSectionLines equals calEventLine line for line, for both marks across all-day, timed and unclear lines", () => {
    const [heading, ...body] = calendarSectionLines(TODAY, cal(EVENTS));
    expect(heading).toBe("▶ Today's calendar");
    expect(body.every((l) => l.startsWith(CALENDAR_LINE_PREFIX))).toBe(true);
    const gui = body.map((l) => l.slice(CALENDAR_LINE_PREFIX.length));
    const engine = EVENTS.map((e) => calEventLine(e as Parameters<typeof calEventLine>[0], TODAY));
    expect(gui).toEqual(engine);
    // PREMISE: the marks are really there, before tentative and ended, so the equality above compares them.
    expect(engine).toEqual([
      "all day — Offsite · on 2 calendars",
      "all day — Retreat · 10 copies · tentative",
      "09:00–09:30  Standup (Room 4) · on 3 calendars",
      "11:00–12:00  Design review · 2 copies · tentative · ended",
      "13:00–14:00  Ticket: X (Polk St) · on 12 calendars · tentative",
      "15:00–15:30  (no title) · 4 copies",
      "time unclear (08:00–09:00 Mars/Base)  Standup (Room 4) · on 2 calendars",
      "time unclear (08:00–09:00 Mars/Base)  Standup (Room 4) · 3 copies · tentative",
      "11:00–12:00  Design review · tentative",
    ]);
  });
});
