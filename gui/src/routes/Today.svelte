<script lang="ts">
  /**
   * T12 — the Today screen: the latest briefing, its freshness, and Run Now.
   *
   * This file only GATHERS: it reads `briefing-latest.md` through `read_latest_briefing` and hands
   * everything to `lib/today.ts`'s `todayModel`, which decides what is shown, and to
   * `lib/deck/DeckOrClassic.svelte`, which draws it (the deck, or `TodayView.svelte`).
   *
   * ⚠ ONE FILE READ PER CHANGE, NOT PER EVENT. Every `state:changed` re-renders this screen, but the
   * file is re-read only when `status --json`'s `latestBriefingMtime` or the app's own last run
   * changed (each read is one `status --json` spawn in Rust). A slow answer that arrives after a
   * newer one is dropped.
   *
   * The briefing redesign's A-M5: the screen draws `DeckOrClassic` (the deck, or `TodayView` when the
   * slides switch is off or the page cannot be mapped). It FOLLOWS the app-prefs store (round-1 M1): the
   * values at mount (App mounts Today only once the store has settled), then every value the store
   * settles on while Today is shown, so a name or slides set still in flight when Today mounted changes
   * the greeting and the mode when it lands. And it holds the deck's CLOCK: one read, `now`, gives both
   * `today` (the stale check) and the meeting tile's time, re-read every minute and when the window
   * regains focus, so both roll over at midnight together. The clock reaches the deck's components, not
   * `deckView`, which does not read it (round-1 L4: a tick does not re-map the page).
   *
   * Wave 2, W2-S: Today is where the live checks are DRIVEN (B1's git detail, C's calendar details; plan §1.2). Four
   * driver points, each the one place its event arrives: `onCurrent` (what slide is current, from DeckOrClassic's
   * `oncurrent`), `onMove` (the user moved, from `onmove`), `onMinute` (the tick) and `onFocus` (the window regained
   * focus). Only C may add lines in `onMove`; B1 uses the page key and the other three driver points,
   * passing Today's live `deck` to every driver call.
   *
   * PB-M6-T3 (wave-2 polish spec §4): THE CALENDAR CARD (`CalendarQuestion`) is drawn above `DeckOrClassic`, in normal
   * flow, when `todayCard` says (every input explicit, the card's own link session among them). Close hides it for this
   * visit and sends a land request (`land`, which DeckOrClassic turns into focus on the current view's target); "Not now"
   * is heard by Today's OWN store subscription (`notNowEvent`), which announces it in the one LiveRegion and lands — the
   * card may already be gone. A Today result is marked drawn once (its line announced) when the card draws it, and
   * `leaveToday` runs on unmount. Every new mount sits after the existing ones.
   */
  import { onMount, setContext, untrack } from "svelte";
  import { appPrefs, onAppPrefsChange } from "../lib/app-prefs-store";
  import { actionsPageKey, type ActionsInput } from "../lib/actions";
  import { ACTIONS_ANNOUNCE, ACTIONS_PAGE, ACTIONS_SAVED, actionsLive, type ActionsLiveState } from "../lib/actions-live";
  import { NO_DETAIL, type CalendarDetail } from "../lib/calendar-detail";
  import { ANNOUNCE_START, announceStep, readStatusLine, type AnnounceState } from "../lib/calendar-detail";
  import { CALENDAR_STALE, calendarLive, staleContext } from "../lib/calendar-live";
  import { deckView, type SlideId } from "../lib/deck";
  import type { SummaryInput } from "../lib/deck";
  import DeckOrClassic from "../lib/deck/DeckOrClassic.svelte";
  import { briefingHash } from "../lib/deck-state";
  import { calendarDetailsOpen, calendarStatus, editorList, reposStatus, readLatestSummary } from "../lib/engine";
  import { describeFailure, readLatestBriefing } from "../lib/files";
  import type { GitDetailInput, ReposIpcReply } from "../lib/git-detail";
  import { gitLive, liveActionCards, type GitLiveState } from "../lib/git-live";
  import { osFromUserAgent } from "../lib/platform";
  import { summaryReader } from "../lib/summary-reader";
  import type { SummaryKept } from "../lib/summary-status";
  import type { SummaryStatus, SummaryRevision } from "../lib/today";
  import type { Snapshot } from "../lib/state";
  import {
    latestMtime,
    localDate,
    todayModel,
    type LatestLoad,
    type RunEnvelope,
  } from "../lib/today";
  import { applyCalendarOff, briefingReads, calendarOn as storeCalendarOn, liveReadSent, onTodayStore, readStatusThroughStore, startingLatest, todayStore } from "../lib/today-store";
  // PB-M6-T3: the calendar card.
  import { leaveToday, malformed, markDrawn, neverAsked } from "../lib/today-store";
  import CalendarQuestion from "../lib/CalendarQuestion.svelte";
  import { NOT_NOW_ANNOUNCEMENT, notNowEvent, todayCard } from "../lib/calendar-question";
  import LiveRegion from "../lib/ui/LiveRegion.svelte";
  import { nextLiveText } from "../lib/ui/a11y";

  interface Props {
    snapshot: Snapshot | null;
    summaryStatusKnown: boolean;
    aiSummaryStatus: SummaryStatus;
    latestSummaryRevision: SummaryRevision | null;
    onstatusrefresh: () => Promise<boolean>;
    /** App's holder of the last accepted summary payload: this screen's reader goes with each unmount, it stays. */
    summaryKept: SummaryKept;
    /** The envelope of the last run THIS app started, if any (App.svelte keeps it). */
    lastRun: RunEnvelope | null;
    running: boolean;
    progress: string[];
    runResult: string;
    /** Whether the run's Details start open — `detailsOpen` in `lib/engine.ts`, decided in App.svelte.
     *  REQUIRED, no default: a missing pass-through fails `bun run check` (no test renders this file). */
    detailsOpen: boolean;
    onrun: () => void;
    /** "Past briefings" on the launchpad: App's route to History. */
    onhistory: () => void;
  }
  let { snapshot, summaryStatusKnown, aiSummaryStatus, latestSummaryRevision, onstatusrefresh, summaryKept, lastRun, running, progress, runResult, detailsOpen, onrun, onhistory }: Props = $props();

  /** The first name and the slides switch: the store's values, followed while Today is mounted (M1). Only ever
   *  replaced whole, by the store's own copy: never written field by field. */
  let prefs = $state(appPrefs());
  onMount(() => {
    // Re-read, then follow: nothing can settle between the two (one synchronous block), so no value is missed.
    prefs = appPrefs();
    return onAppPrefsChange((next) => (prefs = next));
  });
  /** The deck's clock: ONE read for `today` and `now`. */
  let now = $state(Date.now());
  const today = $derived(localDate(new Date(now)));

  // PB-M1 (wave-2 polish spec §3): start from the briefing the store kept when the snapshot still names that file (the
  // same latestMtime), so a remount draws the kept slide at once, with no Good-morning frame; else `loading`, as before.
  let latest = $state<LatestLoad>(untrack(() => startingLatest(todayStore().briefing, latestMtime(snapshot))));
  /** This mount's briefing reads: each keeps what it read in the store, unless overtaken by a fresher read or by this
   *  mount's unmount (`dispose`, below). */
  const reads = briefingReads(readLatestBriefing, describeFailure, briefingHash);
  // What the current read was for. Plain variables, not state: they gate reads, they are not shown.
  let mounted = false;
  let readForMtime: string | null = null;
  let readForRun: RunEnvelope | null = null;

  async function load(): Promise<void> {
    // Read for the latestMtime current now, kept with the file it returns (the store's key for the next mount); an
    // overtaken read answers null and changes nothing.
    const next = await reads.load(readForMtime);
    if (next !== null) latest = next;
  }

  onMount(() => {
    mounted = true;
    readForMtime = latestMtime(snapshot);
    readForRun = lastRun;
    void load();
    const tick = setInterval(onMinute, 60_000);
    return () => clearInterval(tick);
  });

  let summary = $state.raw<SummaryInput | null>(null);
  const summaryLive = summaryReader({ readLatestSummary, refreshStatus: () => onstatusrefresh(), kept: untrack(() => summaryKept), publish: (next) => (summary = next) });
  $effect(() => {
    const page = latest.state === "loaded" ? latest.file : null;
    untrack(() => summaryLive.onPage(page));
  });
  $effect(() => {
    const publication = { known: summaryStatusKnown, status: aiSummaryStatus, revision: latestSummaryRevision };
    untrack(() => summaryLive.onSnapshot(publication));
  });

  /** The deck's current slide, as DeckOrClassic reports it (`currentSlide`): what is current, never "the user moved". */
  let current = $state<SlideId | null>(null);

  /** B1: the live git check's driver (`lib/git-live.ts`; Rust gates every ask) and what it holds, replaced whole on
   *  each change. The OS is read once, for "on this Mac" / "on this computer" (D6). */
  const os = osFromUserAgent(navigator.userAgent);
  let gitState = $state.raw<GitLiveState>({ reply: null, fresh: true, uncommittedFresh: true, greenSince: {}, noResult: false });
  const git = gitLive({ invoke: (request) => reposStatus<ReposIpcReply>(request), clock: () => Date.now(), onchange: (s) => (gitState = s) });
  onMount(() => () => git.dispose());
  const gitDetail = $derived<GitDetailInput>({ ...gitState, os });

  /** B2: one inventory driver for this Today visit. A changed handle never delays replacing the card carrier;
   * only a changed editor-project set asks inventory. Settings saves are picked up by the next Today mount. */
  let actionState = $state.raw<ActionsLiveState>({ choices: new Map(), error: null });
  const actionLive = actionsLive({ os, editorList, publish: (s) => (actionState = s) });
  $effect(() => { actionLive.mount(); return () => actionLive.dispose(); });
  setContext(ACTIONS_SAVED, actionLive.applySaved);
  setContext(ACTIONS_ANNOUNCE, (line: string) => { liveText = nextLiveText(liveText, line); });
  setContext(ACTIONS_PAGE, () => actionsPageKey(briefingKey, deck.kind === "slides" && deck.page.stale));
  const actionCards = $derived(liveActionCards(gitState));
  $effect(() => { const cards = actionCards; untrack(() => actionLive.onActions(cards)); });
  const actions = $derived<ActionsInput>({ cards: actionCards, githubLinks: prefs.githubLinks, os, choices: actionState.choices, error: actionState.error });

  /** C (plan C-M4-T11): today's calendar details, read live in Rust, as the calendar driver holds them; one driver
   *  per mount (`lib/calendar-live.ts`: `became-current` only for a move, focus and the 5-minute timer). */
  let calendarDetail = $state<CalendarDetail>(NO_DETAIL);
  // PB-M3: its status read goes through the store; a thrown read still rejects into the driver's ignored branch.
  // PB-M4: a calendar-off refusal is applied only on the store's ordering verdict, for the generation it was sent under.
  const cal = calendarLive({ open: calendarDetailsOpen, status: () => readStatusThroughStore(() => calendarStatus()).then((r) => { if (r.outcome === null) throw r.error; return r.outcome; }), now: () => Date.now(), publish: (d) => (calendarDetail = d), oncalendaroff: applyCalendarOff, sentGen: liveReadSent });
  // C: dispose on unmount so queued moves and late replies cannot read from Settings or History.
  onMount(() => () => cal.dispose());
  // Checkpoint MED: a read still pending when Today unmounts must not keep its (older) answer over a newer mount's.
  onMount(() => () => reads.dispose());
  /** PB-M4 (spec §5): the Today store, followed while Today is mounted (each change is a fresh snapshot); "on" is the
   *  engine's own reading from its `calendar status` reply (null counts as off until the first answer). */
  let store = $state.raw(todayStore());
  onMount(() => onTodayStore((s) => (store = s)));
  const calendarOn = $derived(storeCalendarOn(store.status));
  // C-M5: a card's stale refusal (`calendar_details_get`, `calendar_join`) reaches the driver through this context.
  setContext(CALENDAR_STALE, staleContext(cal, () => deck));

  function onCurrent(slide: SlideId | null): void {
    if (slide === current) return;
    current = slide;
    git.onCurrent(slide, deck);
    cal.onCurrent(slide, deck);
  }

  /** The user moved onto `slide` (an arrow, a dot, ← or →, Start ›, Back to slides) or opened Today onto it. */
  function onMove(slide: SlideId, from: SlideId | null): void {
    cal.onMove(slide, from, deck);
  }

  /** The tick: the clock re-read every minute. */
  function onMinute(): void {
    now = Date.now();
    git.onMinute(deck);
    cal.onMinute(deck);
  }

  /** The window regained focus: the clock re-read. */
  function onFocus(): void {
    now = Date.now();
    git.onFocus(deck);
    cal.onFocus(deck);
    summaryLive.onFocus();
  }

  $effect(() => {
    const mtime = latestMtime(snapshot);
    const run = lastRun;
    if (!mounted || (mtime === readForMtime && run === readForRun)) return;
    readForMtime = mtime;
    readForRun = run;
    void load();
  });

  const model = $derived(todayModel({ snapshot, latest, lastRun, today }));
  const deck = $derived(deckView({ model, today, firstName: prefs.firstName, gitDetail, calendarDetail, calendarOn, actions, summary }));
  /** The briefing's identity for the deck's kept state: a hash of its text (a same-day rewrite is a new one). */
  const briefingKey = $derived(latest.state === "loaded" ? briefingHash(latest.file.text) : null);

  // B1: a new page key asks the live git check's `first` (plan §1.2, M16): one keyed effect, the driver untracked.
  $effect(() => {
    const key = briefingKey;
    untrack(() => git.onPageKey(key, deck));
  });

  // C: the page key, with the live deck (plan §1.2). Untracked: only a key change re-runs it, never a deck change.
  $effect(() => {
    const key = briefingKey;
    untrack(() => cal.onPageKey(key, deck));
  });

  // PB-M4: "on" turning true within this mount (the app-start read answering after the first draw, or a Yes): the
  // driver reads once, by focus, on a live calendar day (it decides; a page with a section reads by C's rules).
  let shownOn = untrack(() => calendarOn);
  $effect(() => {
    const on = calendarOn;
    untrack(() => {
      if (on && !shownOn) cal.onCalendarOn(deck);
      shownOn = on;
    });
  });

  // PB-M4 (spec §5, Screen readers): Today's one live region. A completed read (an ask's `pending` turning false) is
  // announced once, politely, only if focus is inside the calendar slide when it completes (`announceStep`).
  let liveText = $state("");
  let announcer: AnnounceState = ANNOUNCE_START;
  const calendarSlideEl = (): Element | null => document.querySelector('[data-slide="calendar"]');
  $effect(() => {
    const pending = calendarDetail.pending;
    untrack(() => {
      const line = deck.kind === "slides" && deck.live !== null ? readStatusLine(deck.live, now) : null;
      const r = announceStep(announcer, pending, calendarSlideEl()?.contains(document.activeElement) === true, line);
      announcer = r.next;
      if (r.text !== null) liveText = nextLiveText(liveText, r.text);
    });
  });

  // PB-M6-T3: the calendar card (the header's last paragraph). Per mount: Close, the card's link session, the land
  // request; and the "Not now" events already settled when Today mounted, so a remount never replays one.
  let closed = $state(false);
  let linkSession = $state(false);
  let land = $state(0);
  let notNowSeen = todayStore().notNowSettled;
  const card = $derived(todayCard({ hasPage: briefingKey !== null, scheduleState: snapshot?.scheduleState, neverAsked: neverAsked(store.status), malformed: store.status !== null && malformed(store.status), os, closed, running: store.flow.running, result: store.flow.result, linkSession }));

  /** The card's Close (after it cleared the result): hidden for this visit; the focus lands on the current view. */
  function closeCard(): void {
    closed = true;
    land++;
  }

  // "Not now" settled (from this card or a retry): announced once, politely, and the focus lands — from Today's own
  // subscription, never the card's callback (the card leaves in the same publish).
  onMount(() =>
    onTodayStore((s) => {
      const step = notNowEvent(notNowSeen, s);
      notNowSeen = step.seen;
      if (!step.fire) return;
      liveText = nextLiveText(liveText, NOT_NOW_ANNOUNCEMENT);
      land++;
    }),
  );
  // A Today result the card draws: marked drawn once, its line announced (also one settled while Today was away).
  $effect(() => {
    const r = store.flow.result;
    if (!card.shown || r === null || r.origin !== "today" || r.drawn) return;
    untrack(() => {
      const line = markDrawn();
      if (line !== null) liveText = nextLiveText(liveText, line);
    });
  });
  onMount(() => () => leaveToday());
  onMount(() => { summaryLive.onMount(); return () => summaryLive.dispose(); });
</script>

<svelte:window onfocus={onFocus} />

{#if card.shown}
  <CalendarQuestion origin="today" {os} status={store.status} ask={card.question} onsession={(open) => (linkSession = open)} onclose={closeCard} />
{/if}
<DeckOrClassic {model} {deck} {now} {briefingKey} slides={prefs.slides} {running} {progress} {runResult} {detailsOpen} {onrun} {onhistory} {land} oncurrent={onCurrent} onmove={onMove} />
<LiveRegion text={liveText} />
