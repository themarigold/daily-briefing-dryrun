/**
 * Briefing redesign C, wave-2 plan C-M4-T11 — `src/lib/calendar-live.ts`, Today's calendar driver: when the webview
 * asks Rust for today's live details (`calendar_details_open`), and with which reason.
 *
 * THE RULES UNDER TEST (plan C-M4-T11; the new OD1, orchestrator-settled 2026-10-24):
 * - `became-current` ONLY on W2-S's `onmove` onto the calendar slide or the launchpad from neither of them. Never from a
 *   change of the current slide, a page load, a tick, focus or a refusal.
 * - `focus` and `timer` asks only while either slide is current; the timer at 5 minutes from the last reply's
 *   `readAt`, or from the ask's own send time when its reply never answered or was dropped.
 * - The page gate (today's page whose deck has the calendar slide: a section, or a live calendar day — PB-M4), checked
 *   against the LIVE deck at send time.
 * - One ask outstanding, one queued (the stronger reason kept); a reply for an older page key is dropped.
 * - The one held mount move: a first-draw move that arrives before this mount's first page.
 *
 * ⚠ THE MOVES COME FROM THE REAL EMIT RULES (round 5, P5-H1): the harness drives one W2-S `moveRules()` with the
 * component's three events and feeds each move it gives to `onMove`, in the arrival orders the W2-S checkpoint
 * measured: at the first draw `oncurrent(slide)` THEN `onmove(slide, null)`; on `dispatch` and Back to slides `onmove`
 * THEN `oncurrent`. Mounts start from `onPageKey(null)` (Today mounts with `briefingKey` null). The invoke is a mock
 * with controllable promises; nothing reaches Tauri.
 */
import { describe, expect, test } from "bun:test";
import { afterEach, beforeEach } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { renderBriefing } from "../../src/render";
import type { BriefingStruct as EngineStruct } from "../../src/types";

import { NO_DETAIL, type CalendarDetail } from "../src/lib/calendar-detail";
import { CALENDAR_STALE, calendarLive, macConfiguredFrom, REFRESH_MS, staleContext } from "../src/lib/calendar-live";
import { deckView, type DeckView, type SlideId } from "../src/lib/deck";
import type { CalendarDetailsOpenReply, CalendarDetailsReason } from "../src/lib/engine";
import { moveRules } from "../src/lib/live-current";
import { todayModel, type LatestLoad } from "../src/lib/today";
import { calendarDetailView, OFF_LINE } from "../src/lib/calendar-detail";
import { applyCalendarOff, liveReadSent, readStatusThroughStore, resetTodayStoreForTests, storeWrite, todayStore } from "../src/lib/today-store";

// PB-M4-T2 / plan §0.6: the driver's refusal path writes the Today store, so every test starts from a fresh store and
// ends with no write in flight and no flow running (each test settles its own writes and reads first).
beforeEach(() => {
  resetTodayStoreForTests();
});
afterEach(() => {
  expect(todayStore().writesInFlight).toBe(0);
  expect(todayStore().flow.running).toBeNull();
});

const TODAY = "2026-10-16";
const T0 = new Date(2026, 9, 16, 9, 0).getTime();
const MIN = 60_000;

const pageText = (date: string, calendar: boolean): string =>
  renderBriefing({
    date, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [],
    ...(calendar ? { calendar: { events: [], sources: [{ id: "macos", kind: "macos", status: "ok" }], incomplete: false } } : {}),
  } as EngineStruct);
const loaded = (text: string): LatestLoad => ({ state: "loaded", file: { path: "/s/briefing-latest.md", text, bytes: text.length } });
const deckOf = (latest: LatestLoad, today = TODAY): DeckView =>
  deckView({ model: todayModel({ snapshot: null, latest, lastRun: null, today }), today, firstName: null });
/** PB-M4: the same page with the store's "on" (a live calendar day when the page has no section). */
const deckOn = (latest: LatestLoad, today = TODAY): DeckView =>
  deckView({ model: todayModel({ snapshot: null, latest, lastRun: null, today }), today, firstName: null, calendarOn: true });

/** Today's page with a calendar section (six slides), today's page without one, and decks that are no page. */
const CAL = deckOf(loaded(pageText(TODAY, true)));
const NO_CAL = deckOf(loaded(pageText(TODAY, false)));
const LOADING = deckOf({ state: "loading" });
/** Yesterday's page (stale), and the same text the morning after (the key unchanged, `today` rolled over). */
const STALE = deckOf(loaded(pageText("2026-10-15", true)));
const CAL_TOMORROW = deckOf(loaded(pageText(TODAY, true)), "2026-10-17");
/** PB-M4: a live calendar day (today's page, no section, "on": six slides), and yesterday's page with no section, "on". */
const LIVE = deckOn(loaded(pageText(TODAY, false)));
const STALE_NO_CAL_ON = deckOn(loaded(pageText("2026-10-15", false)));
const SLIDES = CAL.kind === "slides" ? CAL.slides : [];
const ix = (s: SlideId): number => SLIDES.indexOf(s);

type Call = { reason: CalendarDetailsReason; current: SlideId | null; at: number };

/** The driver, a recording invoke with controllable promises, a settable clock and the real `moveRules`. */
function harness(
  status: unknown = { payload: { sources: [{ id: "macos", kind: "macos" }] } },
  store: { oncalendaroff: (sentGen: number) => boolean; sentGen: () => number } | null = null,
) {
  const calls: Call[] = [];
  /** PB-M4-T2: the store's refusal verdict and send generation; by default every refusal is accepted, at a counter. */
  const offCalls: number[] = [];
  let gen = 0;
  const answers: { resolve: (r: CalendarDetailsOpenReply) => void; reject: (e: unknown) => void }[] = [];
  const published: CalendarDetail[] = [];
  let clock = T0;
  const cal = calendarLive({
    open: (reason, current) => {
      calls.push({ reason, current, at: clock });
      return new Promise<CalendarDetailsOpenReply>((resolve, reject) => answers.push({ resolve, reject }));
    },
    status: () => Promise.resolve(status as never),
    now: () => clock,
    publish: (d) => published.push(d),
    oncalendaroff: store?.oncalendaroff ?? ((sentGen) => {
      offCalls.push(sentGen);
      return true;
    }),
    sentGen: store?.sentGen ?? (() => gen),
  });
  const moves = moveRules();
  let deck: DeckView = LOADING;
  let index = 0;
  /** Today's `onCurrent` (it returns at once on an unchanged slide). */
  let current: SlideId | null = null;
  const reportCurrent = (slide: SlideId | null): void => {
    if (slide === current) return;
    current = slide;
    cal.onCurrent(slide, deck);
  };
  const slideAt = (i: number): SlideId | null => (deck.kind === "slides" ? deck.slides[i] ?? null : null);
  const h = {
    cal,
    calls,
    published,
    offCalls,
    set gen(g: number) { gen = g; },
    get last(): CalendarDetail { return published.at(-1) ?? NO_DETAIL; },
    set clock(t: number) { clock = t; },
    get clock(): number { return clock; },
    /** Today's briefingKey effect. */
    key(k: string | null, d: DeckView = deck): void { deck = d; cal.onPageKey(k, d); },
    /** The deck's first draw (or any re-run of DeckOrClassic's effects): `oncurrent` THEN `onmove`. */
    draw(d: DeckView = deck, i = index, classic = false): void {
      deck = d;
      index = i;
      const slide = classic ? null : slideAt(i);
      reportCurrent(slide);
      const m = moves.drawn(slide);
      if (m !== null) cal.onMove(m.slide, m.from, deck);
    },
    /** A user's navigation through `dispatch`: `onmove` THEN `oncurrent`. */
    go(to: SlideId): void {
      const next = ix(to);
      const m = moves.dispatched(index, next, deck.kind === "slides" ? deck.slides : []);
      index = next;
      if (m !== null) cal.onMove(m.slide, m.from, deck);
      reportCurrent(slideAt(index));
    },
    /** Full briefing (no slide current) and Back to slides (`onmove` THEN `oncurrent`). */
    full(): void { reportCurrent(null); },
    back(): void {
      const m = moves.backToSlides(slideAt(index));
      if (m !== null) cal.onMove(m.slide, m.from, deck);
      reportCurrent(slideAt(index));
    },
    /** A move that arrives BEFORE its `oncurrent` (P5-M1). */
    moveOnly(slide: SlideId, from: SlideId | null): void { cal.onMove(slide, from, deck); },
    currentOnly(slide: SlideId | null): void { reportCurrent(slide); },
    tick(d: DeckView = deck): void { deck = d; cal.onMinute(d); },
    focus(d: DeckView = deck): void { deck = d; cal.onFocus(d); },
    stale(): void { cal.onStale(deck); },
    async answer(n: number, r: CalendarDetailsOpenReply): Promise<void> { answers[n]!.resolve(r); await flush(); },
    async fail(n: number): Promise<void> { answers[n]!.reject({ kind: "timeout" }); await flush(); },
  };
  return h;
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const list = (readAt: number, gate: "read" | "held" = "read"): CalendarDetailsOpenReply => ({
  gate, readAt: new Date(readAt).toISOString(), readerOutdated: false, events: [], sources: [{ id: "macos", kind: "macos", status: "ok", skipped: false, last: null }],
});
const reasons = (h: ReturnType<typeof harness>): CalendarDetailsReason[] => h.calls.map((c) => c.reason);

/** A mount whose first page arrives first, then the deck's first draw onto `slide`. */
function mountPageFirst(slide: SlideId, d: DeckView = CAL) {
  const h = harness();
  h.key(null, LOADING);
  h.draw(LOADING, 0);
  h.key("X", d);
  h.draw(d, ix(slide));
  return h;
}
/** A mount whose first draw arrives before the first page (the held mount move). */
function mountDrawFirst(slide: SlideId, d: DeckView = CAL) {
  const h = harness();
  h.key(null, LOADING);
  h.draw(LOADING, 0);
  h.draw(d, ix(slide));
  h.key("X", d);
  return h;
}

describe("became-current: only for a move onto the calendar slide or the launchpad from neither", () => {
  test("PREMISE: the decks the driver is given", () => {
    expect(SLIDES).toEqual(["goodMorning", "whatYouDid", "leftOff", "suggested", "calendar", "launchpad"]);
    expect(STALE.kind === "slides" && STALE.page.stale).toBe(true);
    expect(CAL_TOMORROW.kind === "slides" && CAL_TOMORROW.page.stale).toBe(true);
    expect(NO_CAL.kind === "slides" && NO_CAL.page.calendar).toBeNull();
    expect(LOADING.kind).toBe("single");
  });

  test("every move onto either slide from neither asks; one between the two does not", async () => {
    const h = mountPageFirst("goodMorning");
    expect(h.calls).toEqual([]);
    h.go("calendar");
    expect(h.calls).toEqual([{ reason: "became-current", current: "calendar", at: T0 }]);
    await h.answer(0, list(T0));
    h.go("launchpad");   // calendar → launchpad: reads nothing more (C :69)
    h.go("calendar");
    expect(h.calls.length).toBe(1);
    h.go("suggested");
    h.go("launchpad");   // a dot from Suggested to the launchpad: onto either from neither
    expect(h.calls.map((c) => [c.reason, c.current])).toEqual([["became-current", "calendar"], ["became-current", "launchpad"]]);
  });

  test("both mount orders send exactly one became-current for opening Today onto the calendar slide", () => {
    for (const mount of [mountPageFirst, mountDrawFirst]) {
      const h = mount("calendar");
      expect({ order: mount.name, calls: h.calls.map((c) => [c.reason, c.current]) }).toEqual({ order: mount.name, calls: [["became-current", "calendar"]] });
    }
  });

  test("onMove before onCurrent, in both mount orders and on a navigation: the ask's current is the move's own slide", () => {
    // Held: the move arrives while the stored current is still the slide left, then the page.
    const held = harness();
    held.key(null, LOADING);
    held.currentOnly("goodMorning");
    held.moveOnly("calendar", null);
    held.key("X", CAL);
    expect(held.calls.map((c) => c.current)).toEqual(["calendar"]);
    // Immediate: the page first, the stored current still the slide just left.
    const now = harness();
    now.key(null, LOADING);
    now.key("X", CAL);
    now.currentOnly("goodMorning");
    now.moveOnly("launchpad", "goodMorning");
    expect(now.calls.map((c) => c.current)).toEqual(["launchpad"]);
    // A navigation: dispatch's onmove arrives before its oncurrent.
    const nav = mountPageFirst("suggested");
    nav.go("calendar");
    expect(nav.calls.map((c) => c.current)).toEqual(["calendar"]);
  });

  test("the kept-Full-briefing remount: one Back to slides is one move and one became-current", () => {
    const h = harness();
    h.key(null, LOADING);
    h.draw(LOADING, 0);
    h.key("X", CAL);
    h.draw(CAL, ix("launchpad"), true);   // the kept Full briefing view: nothing current, nothing drawn
    expect(h.calls).toEqual([]);
    h.back();                              // Back to slides…
    h.draw(CAL, ix("launchpad"));          // …and the first-draw effect re-running once the slides draw
    expect(h.calls.map((c) => [c.reason, c.current])).toEqual([["became-current", "launchpad"]]);
  });

  test("the Full briefing round trip within a mount sends one more: two in all, counting the first draw", async () => {
    const h = mountPageFirst("launchpad");
    expect(reasons(h)).toEqual(["became-current"]);
    await h.answer(0, list(T0));
    h.full();
    h.back();
    expect(h.calls.map((c) => [c.reason, c.current])).toEqual([["became-current", "launchpad"], ["became-current", "launchpad"]]);
  });

  test("a read-error bounce after the first draw sends none; a run that jumps the deck sends none", async () => {
    const h = mountPageFirst("calendar");
    await h.answer(0, list(T0));
    h.key(null, LOADING);
    h.draw(LOADING, 0);      // the deck goes single…
    h.key("X", CAL);
    h.draw(CAL, ix("calendar"));   // …and back to the same key
    expect(h.calls.length).toBe(1);
    // A run finishes: a new key, and the deck jumps to Good morning with no move.
    h.key("Y", CAL);
    h.draw(CAL, 0);
    expect(h.calls.length).toBe(1);
  });

  test("a stale page then a new page: the held mount move is dropped, nothing sent", () => {
    const h = harness();
    h.key(null, LOADING);
    h.draw(LOADING, 0);
    h.draw(STALE, ix("calendar"));
    h.key("X", STALE);
    h.key("Y", CAL);
    expect(h.calls).toEqual([]);
  });

  test("a held mount move with the user gone elsewhere is dropped; arrowed to the launchpad in between, it is sent", () => {
    const away = harness();
    away.key(null, LOADING);
    away.draw(CAL, ix("calendar"));
    away.go("goodMorning");
    away.key("X", CAL);
    expect(away.calls).toEqual([]);
    const pad = harness();
    pad.key(null, LOADING);
    pad.draw(CAL, ix("calendar"));
    pad.go("launchpad");
    pad.key("X", CAL);
    expect(pad.calls.map((c) => [c.reason, c.current])).toEqual([["became-current", "launchpad"]]);
  });

  test("no ask but an onMove is ever sent as became-current: ticks, focus, current changes, refusals and page loads", async () => {
    const h = mountPageFirst("calendar");
    const moveSends: number[] = [0];
    await h.answer(0, { refused: "hidden" });
    h.focus();
    await h.answer(1, list(T0));
    h.clock = T0 + 6 * MIN;
    h.tick();
    await h.answer(2, list(h.clock));
    h.currentOnly("launchpad");
    h.currentOnly("calendar");
    h.key("Y", CAL);
    h.key(null, LOADING);
    h.key("Y", CAL);
    h.focus();
    await h.answer(3, { failed: "exit" });
    h.clock += 6 * MIN;
    h.tick();
    await h.fail(4);
    h.stale();
    await h.answer(5, list(h.clock));
    h.go("suggested");
    h.go("calendar");
    moveSends.push(h.calls.length - 1);
    expect(h.calls.flatMap((c, i) => (c.reason === "became-current" ? [i] : []))).toEqual(moveSends);
    expect(reasons(h)).toEqual(["became-current", "focus", "timer", "focus", "timer", "focus", "became-current"]);
  });
});

describe("the page gate, checked against the live deck at send time", () => {
  test("a stale page: no timer, no focus, no move", () => {
    const h = mountPageFirst("calendar", STALE);
    h.clock = T0 + 10 * MIN;
    h.tick(STALE);
    h.focus(STALE);
    h.go("suggested");
    h.go("calendar");
    expect(h.calls).toEqual([]);
  });

  test("a page with no calendar section reads nothing, even on the launchpad — PB-M4: only while \"on\" is false, or on a stale page", () => {
    const h = mountPageFirst("launchpad", NO_CAL);
    h.focus(NO_CAL);
    h.clock = T0 + 10 * MIN;
    h.tick(NO_CAL);
    expect(h.calls).toEqual([]);
    // A stale page with no section is never a live calendar day, "on" or not.
    const stale = harness();
    stale.key("X", STALE_NO_CAL_ON);
    stale.draw(STALE_NO_CAL_ON, 4);
    stale.focus(STALE_NO_CAL_ON);
    stale.clock = T0 + 10 * MIN;
    stale.tick(STALE_NO_CAL_ON);
    expect(STALE_NO_CAL_ON.kind === "slides" && [STALE_NO_CAL_ON.slides.includes("calendar"), STALE_NO_CAL_ON.page.stale]).toEqual([false, true]);   // PREMISE
    expect(stale.calls).toEqual([]);
    // "On": a live calendar day opens the gate (the launchpad, by focus).
    const live = harness();
    live.key("X", LIVE);
    live.draw(LIVE, ix("launchpad"));
    expect(reasons(live)).toEqual(["became-current"]);
  });

  test("the key unchanged and Today's today past midnight: the live deck's page is stale, nothing is sent", async () => {
    const h = mountPageFirst("calendar");
    await h.answer(0, list(T0));
    h.clock = new Date(2026, 9, 17, 0, 5).getTime();
    h.tick(CAL_TOMORROW);
    h.focus(CAL_TOMORROW);
    h.go("suggested");
    h.go("calendar");
    expect(h.calls.length).toBe(1);
  });

  test("a queued became-current with the user gone to another slide by send time is dropped", async () => {
    const h = mountPageFirst("calendar");
    h.go("suggested");
    h.go("launchpad");                // queued behind the first ask
    h.go("goodMorning");              // and the user leaves both slides
    await h.answer(0, list(T0));
    expect(h.calls.length).toBe(1);
  });

  test("a queued became-current is dropped when the page gate closes before send time", async () => {
    const h = mountPageFirst("calendar");
    await h.answer(0, list(T0));
    h.clock = new Date(2026, 9, 16, 23, 59).getTime();
    h.tick();                         // a timer ask stays outstanding
    h.go("suggested");
    h.go("launchpad");                // became-current queues while the page gate is open
    h.clock = new Date(2026, 9, 17, 0, 5).getTime();
    h.tick(CAL_TOMORROW);              // updates the live deck without changing the page key
    await h.answer(1, list(h.clock));
    expect(h.calls.length).toBe(2);
  });
});

describe("focus, the cadence and readAt", () => {
  test("a tick is skipped while an ask is outstanding, with nothing queued after its answer", async () => {
    const h = mountPageFirst("calendar");
    h.clock += 6 * MIN;
    h.tick();
    await h.answer(0, list(h.clock));
    expect(h.calls.length).toBe(1);
  });

  test("focus asks only while either slide is current", async () => {
    const h = mountPageFirst("suggested");
    h.focus();
    expect(h.calls).toEqual([]);
    h.go("launchpad");
    await h.answer(0, list(T0));
    h.focus();
    expect(h.calls.map((c) => [c.reason, c.current])).toEqual([["became-current", "launchpad"], ["focus", "launchpad"]]);
  });

  test("the timer at 4:59 and 5:00 from a held reply's readAt", async () => {
    const h = mountPageFirst("calendar");
    h.clock = T0 + 20_000;
    await h.answer(0, list(T0 - 30_000, "held"));   // a held read from 30 s before the ask
    h.clock = T0 - 30_000 + REFRESH_MS - 1_000;
    h.tick();
    expect(h.calls.length).toBe(1);
    h.clock = T0 - 30_000 + REFRESH_MS;
    h.tick();
    expect(h.calls.map((c) => c.reason)).toEqual(["became-current", "timer"]);
    expect(REFRESH_MS).toBe(5 * MIN);
  });

  test("an ask that never answered counts from its own send time; so does a reply dropped for an older page key", async () => {
    const unanswered = mountPageFirst("calendar");
    unanswered.clock = T0 + 45_000;
    await unanswered.fail(0);
    expect(unanswered.last.list).toBeNull();
    unanswered.clock = T0 + REFRESH_MS - 1_000;
    unanswered.tick();
    expect(unanswered.calls.length).toBe(1);
    unanswered.clock = T0 + REFRESH_MS;
    unanswered.tick();
    expect(unanswered.calls.map((c) => c.reason)).toEqual(["became-current", "timer"]);

    const dropped = mountPageFirst("calendar");
    dropped.key("Y", CAL);                // a page change mid-read
    dropped.clock = T0 + 30_000;
    await dropped.answer(0, list(T0 + 30_000));
    expect(dropped.last.list).toBeNull();  // the old key's reply is not applied
    dropped.clock = T0 + REFRESH_MS - 1_000;
    dropped.tick();
    expect(dropped.calls.length).toBe(1);
    dropped.clock = T0 + REFRESH_MS;
    dropped.tick();
    expect(dropped.calls.map((c) => c.reason)).toEqual(["became-current", "timer"]);
  });

  test("a Held answer whose readAt is already 5 minutes old is followed at once by one timer ask", async () => {
    const h = mountPageFirst("calendar");
    await h.answer(0, list(T0 - 6 * MIN, "held"));
    expect(h.calls.map((c) => [c.reason, c.current])).toEqual([["became-current", "calendar"], ["timer", "calendar"]]);
    await h.answer(1, list(T0));
    expect(h.calls.length).toBe(2);
    // A fresh held read is not followed by one.
    const fresh = mountPageFirst("calendar");
    await fresh.answer(0, list(T0 - 2 * MIN, "held"));
    expect(fresh.calls.length).toBe(1);
  });

  test("the day change drops the held list from webview memory", async () => {
    const h = mountPageFirst("calendar");
    await h.answer(0, list(T0));
    expect(h.last.list).not.toBeNull();
    h.clock = new Date(2026, 9, 17, 0, 1).getTime();
    h.tick(CAL_TOMORROW);
    expect(h.last.list).toBeNull();
  });
});

describe("the new OD1 and the refusals", () => {
  test("a hidden refusal is not owed: the next focus is sent as focus", async () => {
    const h = mountPageFirst("calendar");
    await h.answer(0, { refused: "hidden" });
    expect(h.calls.length).toBe(1);   // nothing re-sent on its own
    h.focus();
    expect(h.calls.map((c) => c.reason)).toEqual(["became-current", "focus"]);
  });

  test("a stale refusal from a card (get or join) is answered by one focus ask", async () => {
    const h = mountPageFirst("calendar");
    await h.answer(0, list(T0));
    h.stale();
    expect(h.calls.map((c) => c.reason)).toEqual(["became-current", "focus"]);
  });

  test("C-M5: a card's stale refusal reaches the driver through Today's context, gated on the LIVE deck at the refusal", async () => {
    expect(typeof CALENDAR_STALE).toBe("symbol");
    const h = mountPageFirst("calendar");
    await h.answer(0, list(T0));
    // Today builds the context once, at init, with a getter: the deck it reads is the one live when a card refuses.
    let live: DeckView = STALE;
    const ctx = staleContext(h.cal, () => live);
    ctx.onStale();
    expect(reasons(h)).toEqual(["became-current"]);   // the live deck's page is stale: the gate stays shut
    live = CAL;
    ctx.onStale();
    expect(reasons(h)).toEqual(["became-current", "focus"]);
    expect(h.calls[1]!.current).toBe("calendar");
  });

  test("calendar-off: the list dropped and the off flag set; a later list clears it", async () => {
    const h = mountPageFirst("calendar");
    await h.answer(0, list(T0));
    h.focus();
    await h.answer(1, { refused: "calendar-off" });
    expect([h.last.list, h.last.off]).toEqual([null, true]);
    h.focus();
    await h.answer(2, list(T0));
    expect(h.last.off).toBe(false);
  });

  test("pending while an ask is outstanding; a failed read drops the list (Rust holds none either)", async () => {
    const h = mountPageFirst("calendar");
    expect(h.last.pending).toBe(true);
    await h.answer(0, list(T0));
    expect([h.last.pending, h.last.list?.readAt]).toEqual([false, new Date(T0).toISOString()]);
    h.focus();
    await h.answer(1, { failed: "exit" });
    expect([h.last.pending, h.last.list]).toEqual([false, null]);
  });
});

test("L1: a non-answer after calendar-off clears off", async () => {
  for (const failure of ["reply", "ipc"]) {
    const h = mountPageFirst("calendar");
    await h.answer(0, { refused: "calendar-off" });
    expect(h.last.off).toBe(true);
    h.focus();
    if (failure === "reply") await h.answer(1, { failed: "exit" }); else await h.fail(1);
    expect([h.last.off, h.last.list, h.last.pending]).toEqual([false, null, false]);
  }
});

test("M1: driver drops a list whose read day differs from pageDate", async () => {
  const h = mountPageFirst("calendar");
  await h.answer(0, list(new Date(2026, 9, 17, 0, 1).getTime()));
  expect([h.last.list, h.last.pending]).toEqual([null, false]);
});

test("L5/W30: a card's stale refusal asks only on calendar or launchpad", async () => {
  const h = mountPageFirst("suggested");
  h.stale();
  expect(h.calls).toEqual([]);
  h.currentOnly("calendar");
  h.stale();
  expect(h.calls.map((c) => [c.reason, c.current])).toEqual([["focus", "calendar"]]);
  await h.answer(0, list(T0));
  h.currentOnly("launchpad");
  h.stale();
  expect(h.calls.map((c) => [c.reason, c.current])).toEqual([["focus", "calendar"], ["focus", "launchpad"]]);
  await h.answer(1, list(T0));
  h.full();
  h.stale();
  expect(h.calls).toHaveLength(2);
});

describe("the queue: one outstanding, one queued, the stronger reason kept", () => {
  test("a became-current queued behind an outstanding timer, then replaced by a focus, keeps became-current", async () => {
    const h = mountPageFirst("calendar");
    await h.answer(0, list(T0));
    h.clock = T0 + REFRESH_MS;
    h.tick();                                    // the timer, outstanding
    h.go("suggested");
    h.go("launchpad");                           // a move: queued as became-current
    h.focus();                                   // a focus: does not downgrade it
    expect(h.calls.length).toBe(2);
    await h.answer(1, list(h.clock));
    expect(h.calls.map((c) => [c.reason, c.current])).toEqual([["became-current", "calendar"], ["timer", "calendar"], ["became-current", "launchpad"]]);
  });

  test("a page change during an outstanding ask: the old reply is dropped, nothing queued for the old page is sent", async () => {
    const h = mountPageFirst("calendar");
    h.focus();                                   // queued behind the first ask
    h.key("Y", CAL);                             // a new page
    await h.answer(0, list(T0));
    expect(h.last.list).toBeNull();
    expect(h.calls.length).toBe(1);
  });
});

describe("disposal: nothing outlives Today's mount", () => {
  test("a queued move and a late read reply cannot ask or publish after unmount", async () => {
    for (const fails of [false, true]) {
      const h = mountPageFirst("goodMorning");
      h.go("calendar");
      h.go("suggested");
      h.go("calendar"); // another became-current queued behind the pending read
      await flush();
      expect(reasons(h)).toEqual(["became-current"]);
      const published = [...h.published];
      h.cal.dispose(); // Today unmounts for Settings, with calendar still the last current slide
      h.cal.dispose();
      if (fails) await h.fail(0);
      else await h.answer(0, list(T0));
      expect(reasons(h)).toEqual(["became-current"]);
      expect(h.published).toEqual(published);
      h.key("Y", CAL);
      h.cal.onCurrent("calendar", CAL);
      h.cal.onMove("calendar", "suggested", CAL);
      h.clock += REFRESH_MS;
      h.tick();
      h.focus();
      h.stale();
      expect(reasons(h)).toEqual(["became-current"]);
      expect(h.published).toEqual(published);
    }
  });

  test("a held mount move and a late status reply are dropped after disposal", async () => {
    let answerStatus!: (o: unknown) => void;
    const h = harness(new Promise((resolve) => { answerStatus = resolve; }));
    h.key(null, LOADING);
    h.draw(CAL, ix("calendar"));
    expect(h.calls).toEqual([]);
    h.cal.dispose();
    h.key("X", CAL);
    answerStatus({ payload: { sources: [{ kind: "macos" }] } });
    await flush();
    expect(h.calls).toEqual([]);
    expect(h.published).toEqual([]);
  });

  test("PB final LOW L6: onCalendarOn after disposal asks nothing and publishes nothing (an earlier refusal's off is not cleared)", async () => {
    const h = harness();
    h.key("X", LIVE);
    h.draw(LIVE, ix("calendar"));
    await h.answer(0, { refused: "calendar-off" });
    expect(h.last.off).toBe(true);   // PREMISE: before disposal, onCalendarOn would clear this and ask once
    const calls = h.calls.length;
    const published = [...h.published];
    h.cal.dispose();
    h.cal.onCalendarOn(LIVE);
    await flush();
    expect(h.calls.length).toBe(calls);
    expect(h.published).toEqual(published);
  });
});

describe("macConfigured: from `calendar status`, once per mount", () => {
  test("a macos source configured, none, and an answer that cannot say", async () => {
    const h = harness();
    await flush();
    expect(h.last.macConfigured).toBe(true);
    const none = harness({ payload: { sources: [{ id: "work", kind: "link" }] } });
    await flush();
    expect(none.last.macConfigured).toBe(false);
    expect(macConfiguredFrom({ payload: null })).toBeNull();
    expect(macConfiguredFrom(null)).toBeNull();
    expect(macConfiguredFrom({ payload: { sources: "x" } })).toBeNull();
  });
});

/* ── Today's C lines (plan §1.2, §1.4: C adds its own state, one deckView input field, one keyed $effect, and one line
 *    inside each of the four driver functions; the W2-S lines stay as they are) ──────────────────────────────────── */

describe("Today drives the calendar driver", () => {
  const codeOf = (src: string): string =>
    src
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1")
      .replace(/(^|[ \t])\/\/[^\n]*/gm, "$1");
  const flat = (s: string): string => s.replace(/\s+/g, " ");
  const TODAY_SRC = flat(codeOf(readFileSync(new URL("../src/routes/Today.svelte", import.meta.url), "utf8")));
  /** One driver function's body: from its head to the next top-level `function`, `$effect` or `const`. */
  const body = (head: string): string => {
    const at = TODAY_SRC.indexOf(head);
    expect({ head, found: at > -1 }).toEqual({ head, found: true });
    const rest = TODAY_SRC.slice(at + head.length);
    const end = rest.search(/ (function |\$effect\(|const |let )/);
    return rest.slice(0, end === -1 ? undefined : end);
  };

  test("one line inside each of the four driver functions, each passing the live deck", () => {
    // The second lander (B1) keeps its own line first in the three it shares (plan §1.4: both kept, B1's first).
    expect(body("function onCurrent(slide: SlideId | null): void {")).toBe(" if (slide === current) return; current = slide; git.onCurrent(slide, deck); cal.onCurrent(slide, deck); }");
    expect(body("function onMove(slide: SlideId, from: SlideId | null): void {")).toContain(" cal.onMove(slide, from, deck); }");
    expect(body("function onMinute(): void {")).toBe(" now = Date.now(); git.onMinute(deck); cal.onMinute(deck); }");
    expect(body("function onFocus(): void {")).toBe(" now = Date.now(); git.onFocus(deck); cal.onFocus(deck); summaryLive.onFocus(); }");
    expect(TODAY_SRC.match(/\bcal\.on[A-Z]\w*\(/g)?.sort()).toEqual(["cal.onCalendarOn(", "cal.onCurrent(", "cal.onFocus(", "cal.onMinute(", "cal.onMove(", "cal.onPageKey("]);
  });

  test("C-M5: the stale context is set once, at init, from the driver and a getter of the live deck", () => {
    expect(TODAY_SRC).toContain("setContext(CALENDAR_STALE, staleContext(cal, () => deck));");
    expect(TODAY_SRC.match(/setContext\(CALENDAR_STALE/g)).toHaveLength(1);
    expect(TODAY_SRC.match(/setContext\(/g)).toHaveLength(4); // C's, and B2's ACTIONS_SAVED, ACTIONS_ANNOUNCE and ACTIONS_PAGE (pinned in actions.check.ts).
    expect(TODAY_SRC).toContain('import { onMount, setContext, untrack } from "svelte";');
    expect(TODAY_SRC).toContain('import { CALENDAR_STALE, calendarLive, staleContext } from "../lib/calendar-live";');
  });

  test("one keyed $effect on briefingKey, the page key sent untracked with the live deck", () => {
    expect(TODAY_SRC).toContain("$effect(() => { const key = briefingKey; untrack(() => cal.onPageKey(key, deck)); });");
    expect(TODAY_SRC.match(/cal\.onPageKey\(/g)).toHaveLength(1);
  });

  test("Today's unmount disposes its calendar driver", () => {
    expect(TODAY_SRC).toContain("onMount(() => () => cal.dispose());");
    expect(TODAY_SRC.match(/cal\.dispose\(/g)).toHaveLength(1);
  });

  test("the driver is built once per mount from the real wrappers; its detail is the deckView input", () => {
    expect(TODAY_SRC).toContain("let calendarDetail = $state<CalendarDetail>(NO_DETAIL);");
    expect(TODAY_SRC).toContain(
      // PB-M3-T2: the driver's per-mount status read goes through the store (applied there when it may be), and a
      // thrown read still rejects into the driver's ignored-rejection branch rather than resolving null.
      // PB-M4-T3: and the store's refusal verdict and send generation.
      "const cal = calendarLive({ open: calendarDetailsOpen, status: () => readStatusThroughStore(() => calendarStatus()).then((r) => { if (r.outcome === null) throw r.error; return r.outcome; }), now: () => Date.now(), publish: (d) => (calendarDetail = d), oncalendaroff: applyCalendarOff, sentGen: liveReadSent });",
    );
    expect(TODAY_SRC.match(/calendarLive\(/g)).toHaveLength(1);
    // The second lander (B1) adds its `gitDetail` before C's input (plan §1.4: both kept, B1's first).
    expect(TODAY_SRC).toContain("deckView({ model, today, firstName: prefs.firstName, gitDetail, calendarDetail, calendarOn, actions, summary })");
  });

  test("calendarDetailsOpen and calendarStatus's live-read use: only Today names the open wrapper (plan §1.2)", () => {
    const root = new URL("../src/", import.meta.url).pathname;
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|svelte)$/.test(n) ? [p] : [];
      });
    const naming = walk(root)
      .filter((p) => /\bcalendarDetailsOpen\b/.test(codeOf(readFileSync(p, "utf8"))))
      .map((p) => p.slice(root.length));
    expect(naming.sort()).toEqual(["lib/engine.ts", "routes/Today.svelte"]);
  });
});

/* ── PB-M4-T2: a live calendar day in the driver (wave-2 polish spec §5) ───────────────────────────── */

describe("PB-M4-T2: the driver on a live calendar day", () => {
  test("PREMISE: the live day's deck has the calendar slide before the launchpad, and no section", () => {
    expect(LIVE.kind === "slides" && [LIVE.slides, LIVE.page.calendar, LIVE.page.stale]).toEqual([SLIDES, null, false]);
  });

  test("onCalendarOn: one `focus` read when the calendar slide or the launchpad is current; none otherwise; never `became-current`", () => {
    for (const slide of ["launchpad", "calendar"] as const) {
      // "On" turned true after the first draw: the deck was a no-section page while off (the launchpad drawn, nothing read).
      const h = harness();
      h.key("X", NO_CAL);
      h.draw(NO_CAL, slide === "launchpad" ? 4 : 0);
      if (slide === "calendar") h.currentOnly("calendar");
      expect(h.calls).toEqual([]);
      h.cal.onCalendarOn(LIVE);
      expect({ slide, calls: h.calls.map((c) => [c.reason, c.current]) }).toEqual({ slide, calls: [["focus", slide]] });
    }
    for (const slide of ["goodMorning", "suggested"] as const) {
      const h = harness();
      h.key("X", NO_CAL);
      h.draw(NO_CAL, ix(slide));
      h.cal.onCalendarOn(LIVE);
      expect({ slide, calls: h.calls }).toEqual({ slide, calls: [] });
    }
  });

  test("onCalendarOn: the app-start status read answering after the first draw sends exactly one focus read; a section page gets no extra read", async () => {
    const h = harness();
    h.key(null, LOADING);
    h.draw(LOADING, 0);
    h.key("X", NO_CAL);
    h.draw(NO_CAL, 4);   // the launchpad, while "on" is still unknown (off)
    expect(h.calls).toEqual([]);
    h.cal.onCalendarOn(LIVE);
    expect(reasons(h)).toEqual(["focus"]);
    await h.answer(0, list(T0));
    // A page with a section: onCalendarOn asks nothing (its reads already follow C's rules).
    const section = mountPageFirst("launchpad");
    const before = section.calls.length;
    await section.answer(0, list(T0));
    section.cal.onCalendarOn(CAL);
    expect(section.calls.length).toBe(before);
  });

  test("commands run only on became-current: a live day's move onto either slide is became-current, its focus and ticks are not", async () => {
    const h = harness();
    h.key("X", LIVE);
    h.draw(LIVE, 0);
    h.go("launchpad");
    expect(reasons(h)).toEqual(["became-current"]);
    await h.answer(0, list(T0));
    h.focus(LIVE);
    await h.answer(1, list(T0));
    h.clock = T0 + 6 * MIN;
    h.tick(LIVE);
    expect(reasons(h)).toEqual(["became-current", "focus", "timer"]);
    await h.answer(2, list(T0 + 6 * MIN));
  });

  test("`failed` is set by a read that did not answer (a reply or the IPC) and cleared by a later answering read", async () => {
    for (const failure of ["reply", "ipc"] as const) {
      const h = harness();
      h.key("X", LIVE);
      h.draw(LIVE, ix("calendar"));
      if (failure === "reply") await h.answer(0, { failed: "exit" }); else await h.fail(0);
      expect({ failure, d: [h.last.failed, h.last.list, h.last.pending] }).toEqual({ failure, d: [true, null, false] });
      const v = LIVE.kind === "slides" ? calendarDetailView(LIVE.page, h.last, true) : null;
      expect(v?.readState).toBe("failed");
      h.focus(LIVE);
      await h.answer(1, list(T0));
      expect({ failure, failed: h.last.failed }).toEqual({ failure, failed: false });
    }
  });

  test("the calendar-off refusal reaches the store with the generation its read was sent under; only a true verdict sets off", async () => {
    const h = harness();
    h.gen = 7;
    h.key("X", CAL);
    h.draw(CAL, ix("calendar"));
    h.gen = 9;   // a write started and settled since the read was sent
    await h.answer(0, { refused: "calendar-off" });
    expect(h.offCalls).toEqual([7]);
    expect(h.last.off).toBe(true);
    // A false verdict: only pending settles; the last accepted list and off stay.
    let verdict = false;
    const no = harness(undefined, { oncalendaroff: () => verdict, sentGen: () => 0 });
    no.key("X", CAL);
    no.draw(CAL, ix("calendar"));
    await no.answer(0, list(T0));
    no.focus(CAL);
    await no.answer(1, { refused: "calendar-off" });
    expect([no.last.off, no.last.list?.readAt, no.last.pending]).toEqual([false, new Date(T0).toISOString(), false]);
    verdict = true;
    no.focus(CAL);
    await no.answer(2, { refused: "calendar-off" });
    expect([no.last.off, no.last.list]).toEqual([true, null]);
  });

  test("a section page with no stored status and a calendar-off refusal draws \"Calendar is off\" (the ordering verdict, no reply needed); before a refusal, no OFF_LINE", async () => {
    const h = harness(undefined, { oncalendaroff: applyCalendarOff, sentGen: liveReadSent });
    h.key("X", CAL);
    h.draw(CAL, ix("calendar"));
    expect(todayStore().status).toBeNull();   // PREMISE: no stored reply
    const before = CAL.kind === "slides" ? calendarDetailView(CAL.page, h.last) : null;
    expect(before?.lines).not.toContain(OFF_LINE);
    await h.answer(0, { refused: "calendar-off" });
    expect(h.last.off).toBe(true);
    expect(todayStore().status).toBeNull();   // nothing fabricated
    const after = CAL.kind === "slides" ? calendarDetailView(CAL.page, h.last) : null;
    expect(after?.lines).toEqual([OFF_LINE]);
  });

  test("the deferred regression: a live read sent, an enabling write accepted, then the old read answers calendar-off — refused by the store; the driver never sets off; the calendar stays on", async () => {
    const statusOn = { operation: "calendar-status", outcome: { kind: "delivered" }, exitCode: 0, payload: { schemaVersion: 1, enabled: true, enabledSet: true, macSupported: true, configWarnings: [], sources: [] }, stdout: "", stderr: "" };
    expect((await readStatusThroughStore(async () => statusOn as never)).verdict).toBe("applied");
    const h = harness(undefined, { oncalendaroff: applyCalendarOff, sentGen: liveReadSent });
    h.key("X", LIVE);
    h.draw(LIVE, ix("calendar"));
    expect(reasons(h)).toEqual(["became-current"]);
    // The enabling write is accepted (settled) while the read is out.
    await storeWrite(async () => ({ kind: "saved" }), () => true);
    expect(todayStore().writesInFlight).toBe(0);
    await h.answer(0, { refused: "calendar-off" });
    expect(h.published.some((d) => d.off)).toBe(false);
    expect([h.last.off, h.last.pending]).toEqual([false, false]);
    expect(todayStore().status?.enabled).toBe(true);
    const v = LIVE.kind === "slides" ? calendarDetailView(LIVE.page, h.last, true) : null;
    expect(v?.lines).not.toContain(OFF_LINE);
    expect(JSON.stringify(v)).not.toContain("Calendar is off");
  });
});

describe("PB-M4 checkpoint LOWs: off and failed on a live calendar day", () => {
  test("LOW 1: a refusal, \"on\" false (the slide leaves), then \"on\" true again in the mount: onCalendarOn clears the stale off — no OFF_LINE while on, even with neither slide current", async () => {
    // The no-section deck while off: index 3 is "suggested", index 4 the launchpad (no calendar slide).
    expect(NO_CAL.kind === "slides" && [NO_CAL.slides[3], NO_CAL.slides[4]]).toEqual(["suggested", "launchpad"]);
    for (const current of ["suggested", "goodMorning", "launchpad"] as const) {
      const h = harness();
      h.key("X", LIVE);
      h.draw(LIVE, ix("calendar"));
      await h.answer(0, { refused: "calendar-off" });
      expect(h.last.off).toBe(true);
      // "On" turned false: the slide left (the deck is the no-section page while off).
      h.draw(NO_CAL, current === "suggested" ? 3 : current === "launchpad" ? 4 : 0);
      if (current === "goodMorning") h.currentOnly("goodMorning");
      const before = h.calls.length;
      // "On" true again.
      h.cal.onCalendarOn(LIVE);
      expect({ current, off: h.last.off }).toEqual({ current, off: false });
      const v = LIVE.kind === "slides" ? calendarDetailView(LIVE.page, h.last, true) : null;
      expect({ current, off: v?.lines.includes(OFF_LINE) }).toEqual({ current, off: false });
      // A read only with the launchpad current: exactly one `focus` ask; none with neither slide current.
      const asks = h.calls.slice(before).map((c) => [c.reason, c.current]);
      expect({ current, asks }).toEqual({ current, asks: current === "launchpad" ? [["focus", "launchpad"]] : [] });
    }
  });

  test("a page WITH a section keeps an accepted refusal's off through onCalendarOn (spec §5: \"Calendar is off\" stays)", async () => {
    const h = harness();
    h.key("X", CAL);
    h.draw(CAL, ix("calendar"));
    await h.answer(0, { refused: "calendar-off" });
    expect(h.last.off).toBe(true);
    const before = h.calls.length;
    h.cal.onCalendarOn(CAL);
    expect([h.last.off, h.calls.length]).toEqual([true, before]);
    const v = CAL.kind === "slides" ? calendarDetailView(CAL.page, h.last, false) : null;
    expect(v?.lines).toContain(OFF_LINE);
  });

  test("LOW 2: an accepted calendar-off refusal clears `failed`", async () => {
    const h = harness();
    h.key("X", LIVE);
    h.draw(LIVE, ix("calendar"));
    await h.answer(0, { failed: "exit" });
    expect(h.last.failed).toBe(true);
    h.focus(LIVE);
    await h.answer(1, { refused: "calendar-off" });
    expect([h.last.off, h.last.failed]).toEqual([true, false]);
  });

  test("LOW 2: a list read for another day (dropped) clears `failed`", async () => {
    const h = harness();
    h.key("X", LIVE);
    h.draw(LIVE, ix("calendar"));
    await h.answer(0, { failed: "exit" });
    expect(h.last.failed).toBe(true);
    h.focus(LIVE);
    await h.answer(1, list(new Date(2026, 9, 17, 0, 1).getTime()));
    expect([h.last.list, h.last.failed, h.last.pending]).toEqual([null, false, false]);
  });
});
