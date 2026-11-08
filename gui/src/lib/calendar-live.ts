/**
 * Briefing redesign C, wave-2 plan C-M4-T11 — Today's CALENDAR DRIVER: when the webview asks Rust for today's live
 * details (`calendar_details_open`, `src-tauri/src/calendar_details.rs`), with which reason, and what it holds of the
 * answers for the deck (`CalendarDetail`, drawn through `calendar-detail.ts`). Pure apart from the injected wrappers
 * and clock; one driver per Today mount (Today builds it once, at the top of its script).
 *
 * THE WEBVIEW DRIVES, RUST GATES (plan §1.2). Today calls the five entry points, each with its LIVE deck:
 * `onPageKey` (its keyed effect on `briefingKey`), `onCurrent` and `onMove` (DeckOrClassic's `oncurrent` and `onmove`),
 * `onMinute` (the tick) and `onFocus` (the window regained focus). A card's stale refusal reaches `onStale`.
 *
 * ⚠ `became-current` ONLY FOR A MOVE (the new OD1, orchestrator-settled 2026-10-24): `onMove` onto the calendar slide or
 * the launchpad FROM NEITHER (moving between the two reads nothing more, C `:69`) is its only source. A command link's
 * command runs only on such a read; `focus` and `timer` never run one, so nothing else is ever sent as
 * `became-current`: not a change of the current slide, a page load, a tick, focus, a refusal (a `hidden` refusal is
 * not owed) or a stale handle (answered by one `focus`). An immediate ask's `current` is the move's own slide, since
 * `onmove` can arrive before its `oncurrent` (P5-M1).
 *
 * THE PAGE GATE, AT SEND TIME: every ask needs today's page (`!page.stale`) whose deck has the calendar slide (a calendar
 * section, or — PB-M4 — a live calendar day: no section, the calendar "on"), judged on the live deck when it is sent:
 * `briefingKey` is a hash of the page's text and does not change at midnight, while the deck's page goes stale when
 * Today's `today` rolls over (C `:13`, `:63`).
 *
 * PB-M4 (spec §5): a read that did not answer sets `failed` (cleared by a later answering read). A `calendar-off`
 * refusal asks the Today store (`oncalendaroff`, with the write generation the read was sent under, `sentGen`) and sets
 * `off` only on its true verdict, so a refusal overtaken by an enabling write never draws "Calendar is off".
 * `onCalendarOn`: the calendar turned on within the mount on a live calendar day — it clears an earlier refusal's `off`
 * (that refusal belonged to the calendar being off), and sends one `focus` read (never a command) when the calendar
 * slide or the launchpad is current. A page with a calendar section keeps its `off` (spec §5).
 *
 * ONE HELD MOUNT MOVE: on a mount the deck's first draw can reach the driver before the mount's first page (the
 * effects run in either order). Such a move is held (one; a later one replaces it) and, when the first page arrives,
 * sent only if the latest `onCurrent` (or, with none since, the move's own slide) is still either slide and the gate
 * passes. A key change drops it. `null` is not a page: Today mounts with `briefingKey` null, and a later null (a read
 * error) neither drops a held move nor counts as one.
 *
 * ONE ASK OUTSTANDING, ONE QUEUED: a queued ask keeps the stronger reason (`became-current` over `focus` over
 * `timer`); at send time it takes the latest `onCurrent` and is dropped when neither slide is current. A reply for an
 * older page key is dropped.
 *
 * THE CADENCE: at a minute tick while either slide is current, a `timer` ask once `now − readAt ≥ 5 min`, `readAt`
 * being the last reply's read time (a held reply's included), or the ask's own send time when its reply never
 * answered (Rust's bound, a crash) or was dropped. A `became-current` answered `held` whose `readAt` is already 5
 * minutes old is followed at once by one `timer` ask. Rust floors the timer itself (295 s), as the second line.
 */
import { listOnDay, NO_DETAIL, type CalendarDetail } from "./calendar-detail";
import type { DeckView, SlideId } from "./deck";
import type { CalendarDetailsOpenReply, CalendarDetailsReason } from "./engine";
import { localDate } from "./today";

/** The webview's refresh: 5 minutes from the last read (Rust's backstop is 300 s less 5 s). */
export const REFRESH_MS = 5 * 60_000;

export interface CalendarLiveDeps {
  /** `calendarDetailsOpen` (lib/engine.ts). */
  open: (reason: CalendarDetailsReason, current: SlideId | null) => Promise<CalendarDetailsOpenReply>;
  /** `calendar status --json` (`calendarStatus`), read once per mount: `macConfigured`'s only source. */
  status: () => Promise<unknown>;
  now: () => number;
  /** Called with the new detail whenever it changes (Today's `calendarDetail` state). */
  publish: (d: CalendarDetail) => void;
  /** PB-M4: a `calendar-off` refusal of a read sent at write generation `sentGen` — the Today store's ordering verdict
   *  (`applyCalendarOff`); only true lets the driver set `off`. */
  oncalendaroff: (sentGen: number) => boolean;
  /** PB-M4: the store's write generation when a read is sent (`liveReadSent`). */
  sentGen: () => number;
}

export interface CalendarLive {
  /** Today unmounted: discard held work and ignore every later callback or reply. */
  dispose(): void;
  onPageKey(key: string | null, deck: DeckView): void;
  onMove(slide: SlideId, from: SlideId | null, deck: DeckView): void;
  onCurrent(slide: SlideId | null, deck: DeckView): void;
  onMinute(deck: DeckView): void;
  onFocus(deck: DeckView): void;
  /** `calendar_details_get` or `calendar_join` answered `{ refused: "stale" }`: one `focus` ask refreshes the list. */
  onStale(deck: DeckView): void;
  /** PB-M4: "on" turned true within the mount on a live calendar day: clears an earlier refusal's `off`, then one
   *  `focus` ask if either slide is current. A page with a section is left as it is. */
  onCalendarOn(deck: DeckView): void;
}

/**
 * C-M5 (orchestrator-settled): a meeting card's or Join's `{ refused: "stale" }` reaches the driver through a Svelte
 * CONTEXT, not a prop through DeckOrClassic. Today sets it once, at init (`setContext(CALENDAR_STALE, staleContext(cal,
 * () => deck))`); `MeetingCard.svelte` and `JoinButton.svelte` read it with `getContext` and call `onStale()` on a stale
 * refusal. With no context (a test render) they do nothing.
 */
export const CALENDAR_STALE: unique symbol = Symbol("calendar-stale");

export interface CalendarStale {
  onStale(): void;
}

/** The context Today sets: a stale refusal refreshes with the deck that is LIVE when the card refuses (a getter, never
 *  the deck at Today's init). */
export function staleContext(cal: Pick<CalendarLive, "onStale">, deck: () => DeckView): CalendarStale {
  return { onStale: () => cal.onStale(deck()) };
}

/** Whether `calendar status --json`'s answer lists a `macos` source; null when it cannot say. */
export function macConfiguredFrom(outcome: unknown): boolean | null {
  const payload = typeof outcome === "object" && outcome !== null ? (outcome as { payload?: unknown }).payload : undefined;
  const sources = typeof payload === "object" && payload !== null ? (payload as { sources?: unknown }).sources : undefined;
  if (!Array.isArray(sources)) return null;
  return sources.some((s) => typeof s === "object" && s !== null && (s as { kind?: unknown }).kind === "macos");
}

const RANK: Readonly<Record<CalendarDetailsReason, number>> = { "became-current": 3, focus: 2, timer: 1 };
const stronger = (a: CalendarDetailsReason | null, b: CalendarDetailsReason): CalendarDetailsReason =>
  a !== null && RANK[a] >= RANK[b] ? a : b;
const eitherSlide = (s: SlideId | null | undefined): boolean => s === "calendar" || s === "launchpad";
/** The page gate: today's page, and its deck has the calendar slide (a section, or a live calendar day). */
const gateOpen = (deck: DeckView | null): boolean => deck !== null && deck.kind === "slides" && deck.slides.includes("calendar") && !deck.page.stale;

interface Ask {
  key: string | null;
  reason: CalendarDetailsReason;
  sentAt: number;
  /** The store's write generation when it was sent (PB-M4). */
  gen: number;
}

export function calendarLive(deps: CalendarLiveDeps): CalendarLive {
  let disposed = false;
  /** The latest live deck any entry point was given (a queued ask is gated on it when it is sent). */
  let deck: DeckView | null = null;
  /** The latest non-null page key, and whether this mount's first page (a non-null key with a slides deck) came. */
  let pageKey: string | null = null;
  let pageSeen = false;
  /** The one held mount move, and the latest `onCurrent` since it (undefined: none yet). */
  let held: SlideId | null = null;
  let sinceHeld: SlideId | null | undefined;
  let current: SlideId | null = null;
  let readAt: number | null = null;
  let outstanding: Ask | null = null;
  let queued: CalendarDetailsReason | null = null;
  let detail: CalendarDetail = { ...NO_DETAIL };

  const set = (patch: Partial<CalendarDetail>): void => {
    if (disposed) return;
    detail = { ...detail, ...patch };
    deps.publish(detail);
  };

  void deps.status().then(
    (o) => set({ macConfigured: macConfiguredFrom(o) }),
    () => undefined,
  );

  function send(reason: CalendarDetailsReason, cur: SlideId | null): void {
    const mine: Ask = { key: pageKey, reason, sentAt: deps.now(), gen: deps.sentGen() };
    outstanding = mine;
    set({ pending: true });
    let reply: Promise<CalendarDetailsOpenReply>;
    try {
      reply = deps.open(reason, cur);
    } catch (e) {
      reply = Promise.reject(e);
    }
    reply.then(
      (r) => settle(mine, r),
      () => settle(mine, null),
    );
  }

  /** Send now, or queue behind the outstanding ask; nothing when the gate is shut on the live deck. */
  function ask(reason: CalendarDetailsReason, cur: SlideId | null): void {
    if (disposed || !gateOpen(deck)) return;
    if (outstanding !== null) {
      queued = stronger(queued, reason);
      return;
    }
    send(reason, cur);
  }

  function settle(mine: Ask, r: CalendarDetailsOpenReply | null): void {
    if (disposed || outstanding !== mine) return;
    outstanding = null;
    if (mine.key !== pageKey) {
      // A reply for an older page key: dropped, and the refresh counts from the ask's own send time.
      readAt = mine.sentAt;
      set({ pending: false });
    } else {
      apply(mine, r);
    }
    drain();
  }

  function apply(mine: Ask, r: CalendarDetailsOpenReply | null): void {
    if (r === null || "failed" in r) {
      // The read did not answer: Rust holds no valid read now, so neither does the deck (PB-M4: `failed`).
      readAt = mine.sentAt;
      set({ pending: false, list: null, off: false, failed: true });
      return;
    }
    if ("refused" in r) {
      if (r.refused === "calendar-off") {
        // PB-M4: only the store's ordering verdict draws "off": a write since the read was sent overtakes it.
        if (deps.oncalendaroff(mine.gen)) {
          readAt = mine.sentAt;
          set({ pending: false, list: null, off: true, failed: false });
        } else {
          set({ pending: false });
        }
      } else {
        // Hidden: nothing is owed; the next focus or tick asks with its own reason.
        set({ pending: false });
      }
      return;
    }
    if (r.gate === "none") {
      set({ pending: false });
      return;
    }
    if (deck?.kind !== "slides" || !listOnDay(r, deck.page.pageDate)) {
      readAt = mine.sentAt;
      set({ pending: false, list: null, off: false, failed: false });
      return;
    }
    const at = Date.parse(r.readAt);
    readAt = Number.isFinite(at) ? at : mine.sentAt;
    set({ pending: false, off: false, failed: false, list: { readAt: r.readAt, readerOutdated: r.readerOutdated, events: r.events, sources: r.sources } });
    if (r.gate === "held" && mine.reason === "became-current" && deps.now() - readAt >= REFRESH_MS) queued = stronger(queued, "timer");
  }

  function drain(): void {
    if (queued === null || outstanding !== null) return;
    const reason = queued;
    queued = null;
    if (!eitherSlide(current)) return;
    ask(reason, current);
  }

  /** The day changed since the held list was read: it leaves webview memory (C "What the webview gets"). */
  function dropAtDayChange(): void {
    if (detail.list === null) return;
    const at = Date.parse(detail.list.readAt);
    if (Number.isFinite(at) && localDate(new Date(at)) !== localDate(new Date(deps.now()))) set({ list: null });
  }

  return {
    dispose() {
      disposed = true;
      outstanding = null;
      queued = null;
      held = null;
      sinceHeld = undefined;
      current = null;
      deck = null;
      detail = { ...NO_DETAIL };
    },
    onPageKey(key, d) {
      if (disposed) return;
      deck = d;
      if (key === null) return;
      if (pageKey !== null && key !== pageKey) {
        held = null;
        queued = null;
      }
      pageKey = key;
      if (pageSeen || d.kind !== "slides") return;
      pageSeen = true;
      if (held === null) return;
      const slide = sinceHeld === undefined ? held : sinceHeld;
      held = null;
      if (eitherSlide(slide)) ask("became-current", slide);
    },
    onMove(slide, from, d) {
      if (disposed) return;
      deck = d;
      if (!eitherSlide(slide) || eitherSlide(from)) return;
      if (!pageSeen) {
        held = slide;
        sinceHeld = undefined;
        return;
      }
      ask("became-current", slide);
    },
    onCurrent(slide, d) {
      if (disposed) return;
      deck = d;
      current = slide;
      if (held !== null) sinceHeld = slide;
    },
    onMinute(d) {
      if (disposed) return;
      deck = d;
      dropAtDayChange();
      if (!eitherSlide(current) || outstanding !== null) return;
      if (readAt === null || deps.now() - readAt >= REFRESH_MS) ask("timer", current);
    },
    onFocus(d) {
      if (disposed) return;
      deck = d;
      dropAtDayChange();
      if (eitherSlide(current)) ask("focus", current);
    },
    onStale(d) {
      if (disposed) return;
      deck = d;
      if (eitherSlide(current)) ask("focus", current);
    },
    onCalendarOn(d) {
      if (disposed) return;
      deck = d;
      // A live calendar day only (no section): a page with a section already reads by C's rules.
      if (d.kind !== "slides" || d.page.calendar !== null) return;
      // Checkpoint LOW 1: an earlier refusal's off belonged to the calendar being off; it is on again now.
      if (detail.off) set({ off: false });
      if (eitherSlide(current)) ask("focus", current);
    },
  };
}
