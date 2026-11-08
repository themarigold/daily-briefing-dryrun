<script lang="ts">
  /**
   * The choice between the deck and the classic Today view (A spec, "How it is built"):
   * - the slides switch off: `TodayView` alone, exactly as before the redesign;
   * - a loaded page the deck cannot map: one fixed line, then `TodayView` for the same model (A spec
   *   "A loaded page the deck cannot map"). Loading, a read error and the first run are Good morning
   *   states and never show the line;
   * - "Full briefing" (from the launchpad): `TodayView` with "Back to slides" above it;
   * - otherwise the deck.
   *
   * Which slide shows and whether "Full briefing" is open are kept per briefing in `deck-state.ts`
   * (Today unmounts on every route change), keyed by `briefingKey`, the hash of the briefing's text, and
   * `deckStateOnKey` decides on each key change: Today reopening on the same briefing (after its load,
   * `null` → the key) comes back where it was; a different briefing (a run finished, or a same-day
   * rewrite) returns to Good morning, on the slides.
   *
   * FOCUS: ONE state, `landing` (round-4 M4; `FocusLanding` in deck-state.ts). Every focus target reads it through
   * `use:focusHeading`: each slide's heading (`landing === "slideHeading"` on the current slide), the Full briefing
   * heading and the cannot-map note (`landing === "classicView"`). A move or Back to slides sets "slideHeading", Full
   * briefing sets "classicView". A CHANGE (a new briefing, or the run rule's jump) resets it to null and, if focus was
   * inside these views (`rootEl`, a `display: contents` wrapper), sets it once the change is drawn to what the pure
   * `focusLanding` says: only where focus must go (the slide index changed on a new briefing, or the change left focus
   * nowhere — on the body, disconnected, disabled, or in an inert slide). Focus anywhere else is left alone.
   *
   * THE RUN RULE (round-4 M1; `runRule` in deck-state.ts): ONE jump to Good morning per run, when it starts or, Today
   * mounting mid-run, when its page arrives, so the run's progress and result are on screen. Nothing holds the deck:
   * every move during the run is the user's own. Its memory is per run and module-level (post-cap L2), so leaving
   * Today and coming back mid-run does not jump again.
   *
   * The track glides only after the user's own first move in this mount (round-4 L5): a slide restored on return, or
   * reached by the run rule before any move, appears at once.
   *
   * THE SLIDE BY ITS ID (PB-M1, wave-2 polish spec §3): the kept slide is restored by its `SlideId` (`placeOnList`),
   * and when the slide list changes under the same key (the calendar slide added or removed) `listChange` keeps the
   * current slide where it went: a REMAP sets `quiet` (no glide to that index, no L6 scroll, focus left alone unless
   * lost); a REMOVAL lands on its neighbour with the glide off, L6's reset kept and focus landing only if lost. Neither
   * is a move: no `onmove`. The next user move clears `quiet` and turns the glide on.
   *
   * THE CURRENT SLIDE AND THE USER'S MOVES (wave 2, W2-S; `live-current.ts`, for the live checks Today drives):
   * - `oncurrent` reports WHAT is current (`currentSlide`) on every change. It is never read as "the user moved".
   * - `onmove` is emitted only at three sites, through ONE `moveRules()` for this mount (so one transition emits once):
   *   `dispatch` when the index changed (an arrow, a dot, ← or →, Start ›), `showClassic` closing (Back to slides),
   *   and the first-draw effect (the deck's first draw in this mount, unless a site above already emitted). Never the
   *   key change, a slide-list remap or removal, the run rule's jump, or a read error and its recovery once drawn.
   *
   * THE LAND REQUEST (PB-M6-T3, wave-2 polish spec §4 "Focus"): Today bumps `land` after the calendar card's Close or
   * "Not now". Each new request sets `landing` to null, then — after `tick()` — to the current view's target
   * (`landTarget`), unconditionally (`landRequestStep`): `focusHeading` fires only when its argument turns true, and
   * `landing` usually already holds the target, while `afterChange` returns when focus was not inside these views. With
   * the slides switch off the target is TodayView's "Today" heading (`landHere`), and a later change leaves `landing` as
   * it is (`afterChange` returns first), so the focused heading keeps its tabindex. Not a move: no `onmove`.
   */
  import { tick, untrack } from "svelte";
  import TodayView from "../../routes/TodayView.svelte";
  import { deckReducer, type DeckAction, type DeckNav, type DeckView, type SlideId } from "../deck";
  import { deckStateOnKey, focusIsLost, focusLanding, keepDeckState, listChange, placeOnList, runJumpNow, type FocusLanding } from "../deck-state";
  import { landRequestStep, landTarget } from "../deck-state";
  import { currentSlide, moveRules } from "../live-current";
  import type { TodayModel } from "../today";
  import ActionButton from "../ui/ActionButton.svelte";
  import { focusHeading } from "../ui/a11y";
  import Deck from "./Deck.svelte";

  interface Props {
    model: TodayModel;
    /** `deckView(…)` for the same model (Today computes it). */
    deck: DeckView;
    /** The deck's clock, from the same read as the model's `today` (Today). */
    now: number;
    /** The briefing's identity: `briefingHash` of its text; null with no page (loading, a read error, the first run). */
    briefingKey: string | null;
    /** The slides switch (the app-prefs store). */
    slides: boolean;
    running: boolean;
    progress: string[];
    runResult: string;
    detailsOpen: boolean;
    onrun: () => void;
    onhistory: () => void;
    /** PB-M6-T3: Today's land request, a counter; each new value lands the focus on the current view's target. */
    land?: number;
    /** What is current (`currentSlide`), on every change; never "the user moved" (W2-S). */
    oncurrent?: ((slide: SlideId | null) => void) | undefined;
    /** The user moved onto `slide` (or opened Today onto it); `from` is the slide current just before, or null (W2-S). */
    onmove?: ((slide: SlideId, from: SlideId | null) => void) | undefined;
  }
  let { model, deck, now, briefingKey, slides, running, progress, runResult, detailsOpen, onrun, onhistory, land = 0, oncurrent, onmove }: Props = $props();

  /** The note above the classic view when the page cannot be mapped (A spec: "a one-line note"). */
  const CANNOT_MAP_NOTE = "This briefing could not be shown as slides.";

  const countOf = (v: DeckView): number => (v.kind === "classic" ? 1 : v.slides.length);
  /** The slide list `placeOnList` and `listChange` read: empty for the classic view (and for the one-slide view, which
   *  only ever has no key). `countOf` stays the navigation count (1 for classic). */
  const slidesOf = (v: DeckView): readonly SlideId[] => v.kind === "slides" ? v.slides : [];

  const kept = untrack(() => deckStateOnKey(briefingKey));
  let shownKey = untrack(() => briefingKey);
  /** The slide list `nav.index` is on (PB-M1): a list change under the same key is measured against it. Not drawn. */
  let shownSlides = untrack(() => slidesOf(deck));
  let nav = $state<DeckNav>(untrack(() => ({ index: placeOnList(kept, shownSlides), count: countOf(deck), open: [] })));
  let classic = $state(kept.classic);
  /** Where focus lands next (the header's FOCUS). */
  let landing = $state<FocusLanding>(null);
  /** The user has moved in this mount: from then on the track glides (L5). */
  let glide = $state(false);
  /** PB-M1: the index a remap landed on (the same slide at a new place): the track does not glide to it. */
  let quiet = $state<number | null>(null);
  /** The wrapper around the slides-on views (`display: contents`), to ask whether focus is inside them. */
  let rootEl = $state<HTMLElement | null | undefined>(undefined);
  /** Counts changes, so a landing decided for an older one is dropped. Not drawn. */
  let change = 0;
  /** `onmove`'s rules for this mount: one object, one "drawn" flag, used at the three sites (W2-S). */
  const moves = moveRules();

  /** Focus is inside this component's own views. */
  const focusInside = (): boolean => rootEl?.contains(document.activeElement) === true;

  /** The change left focus nowhere: on the body, out of the document, on a control that is now disabled (WebKit drops
   *  focus from it, round-4 L2), or inside an inert slide (a browser may not have moved it off yet when this runs). */
  function focusLost(): boolean {
    return focusIsLost(document.activeElement, document.body);
  }

  /** A change is being drawn: focus lands nowhere for now, and — if it was inside — where `focusLanding` says once the
   *  change is drawn. */
  function afterChange(from: number, wasInside: boolean, onIndexChange: boolean): void {
    // PB final R1: with the slides off `landing` is only TodayView's landHere — a land request's target, holding the
    // "Today" heading's tabindex while it has focus. The views' wrapper is not drawn, so a change could never set a
    // target again; resetting it would strip the focused heading's tabindex and drop its focus to the body.
    if (!slides) return;
    landing = null;
    const mine = ++change;
    if (!wasInside) return;
    void tick().then(() => {
      if (mine !== change || !slides) return;
      landing = focusLanding({ deckDrawn: deck.kind !== "classic" && !classic, from, to: nav.index, lost: focusLost(), onIndexChange });
    });
  }

  // The page arrived, or changed while mounted (`deckStateOnKey` decides which): cards closed, and the slide and view it
  // gives, the slide found by its id (`placeOnList`). Otherwise a new slide list under the same key: `listChange` keeps
  // the current slide by its id (PB-M1). A pre-effect, so focus is read before the old slide turns inert.
  $effect.pre(() => {
    const key = briefingKey;
    const count = countOf(deck);
    const list = slidesOf(deck);
    untrack(() => {
      if (key !== shownKey) {
        const s = deckStateOnKey(key);
        const from = nav.index;
        const wasInside = focusInside();
        shownKey = key;
        shownSlides = list;
        quiet = null;
        nav = { ...deckReducer(nav, { type: "briefingChanged", count }), index: placeOnList(s, list) };
        classic = s.classic;
        afterChange(from, wasInside, true);
      } else {
        const r = listChange({ prev: shownSlides, index: nav.index, next: list, quiet, glide });
        shownSlides = list;
        if (r.kind === "same") {
          if (count !== nav.count) nav = { ...nav, count };
        } else {
          const from = nav.index;
          const wasInside = focusInside();
          nav = { ...nav, count, index: r.index };
          quiet = r.quiet;
          glide = r.glide;
          keep();
          afterChange(from, wasInside, false);
        }
      }
    });
  });

  // THE RUN RULE (runRule, its memory in deck-state.ts): after the key effect, so a page arriving mid-run is taken to
  // Good morning in the same flush. ALWAYS through afterChange (post-cap L3), Good morning already current too: Run now
  // turns disabled as the run starts, and focus left there lands on Good morning's heading.
  $effect.pre(() => {
    const jump = runJumpNow(running, briefingKey !== null);
    if (!jump) return;
    untrack(() => {
      const from = nav.index;
      const wasInside = focusInside();
      nav = { ...nav, index: 0 };
      keep();
      afterChange(from, wasInside, false);
    });
  });

  /** Keep the slide and view for this briefing (none is kept without a page). */
  function keep(): void {
    if (briefingKey !== null) keepDeckState(briefingKey, shownSlides[nav.index] ?? null, nav.index, classic);
  }

  function dispatch(a: DeckAction): void {
    const next = deckReducer(nav, a);
    if (next.index !== nav.index) {
      landing = "slideHeading";
      glide = true;
      quiet = null;
    }
    const m = moves.dispatched(nav.index, next.index, deck.kind === "slides" ? deck.slides : []);
    nav = next;
    keep();
    if (m !== null) onmove?.(m.slide, m.from);
  }

  /** "Full briefing" (on) and "Back to slides" (off). Focus follows (A-M5 review, LOW-1): into the classic view's
   *  heading on the way in, and to the current slide's heading on the way out. Back to slides is a move (W2-S). */
  function showClassic(on: boolean): void {
    classic = on;
    landing = on ? "classicView" : "slideHeading";
    keep();
    if (!on) {
      const m = moves.backToSlides(currentSlide({ slides, deck, classic, index: nav.index }));
      if (m !== null) onmove?.(m.slide, m.from);
    }
  }

  // What is current, on every change (W2-S): never read as "the user moved"; callback reads must not become effect dependencies.
  $effect(() => {
    const slide = currentSlide({ slides, deck, classic, index: nav.index });
    untrack(() => oncurrent?.(slide));
  });

  // The deck's first draw in this mount (W2-S): the user opened Today onto that slide. `moves.drawn` gives it only while
  // nothing has been emitted in this mount, so a later read error and its recovery, or the slides drawing after Back to
  // slides, emit nothing; callback reads must not become effect dependencies.
  $effect(() => {
    const m = moves.drawn(currentSlide({ slides, deck, classic, index: nav.index }));
    if (m !== null) untrack(() => onmove?.(m.slide, m.from));
  });

  // PB-M6-T3, the land request (the header's LAND REQUEST): null now, the target after the tick.
  let landSeen = untrack(() => land);
  $effect(() => {
    const request = land;
    untrack(() => {
      const step = landRequestStep(landSeen, request, landTarget({ slides, kind: deck.kind, classic }));
      landSeen = step.seen;
      if (step.edges.length === 0) return;
      const target = step.edges[1];
      landing = step.edges[0];
      void tick().then(() => (landing = target));
    });
  });
</script>

{#if !slides}
  <TodayView {model} {running} {progress} {runResult} {detailsOpen} {onrun} landHere={landing === "classicView"} />
{:else}
  <!-- Round-3 L1: one element around every slides-on view, so focus "inside" covers the classic views too. It draws
       nothing of its own (`display: contents`). -->
  <div class="views" bind:this={rootEl}>
  {#if deck.kind === "classic"}
  <p class="note" tabindex="-1" use:focusHeading={landing === "classicView"}>{CANNOT_MAP_NOTE}</p>
  <TodayView {model} {running} {progress} {runResult} {detailsOpen} {onrun} />
  {:else if classic}
  <div class="back">
    <h2 class="sr-only" tabindex="-1" use:focusHeading={landing === "classicView"}>Full briefing</h2>
    <ActionButton onclick={() => showClassic(false)}>Back to slides</ActionButton>
  </div>
  <TodayView {model} {running} {progress} {runResult} {detailsOpen} {onrun} />
  {:else}
  <Deck
    view={deck}
    {model}
    {nav}
    {landing}
    {glide}
    {quiet}
    {now}
    ondispatch={dispatch}
    onfull={() => showClassic(true)}
    {onhistory}
    {running}
    {progress}
    {runResult}
    {detailsOpen}
    {onrun}
  />
  {/if}
  </div>
{/if}

<style>
  .views {
    display: contents;
  }
  .note {
    margin: 0 0 0.6rem;
    color: var(--muted);
    font-size: 0.85rem;
  }
  /* A focus target by script only (round-2 L2), as the slides' headings are: no ring. */
  .note:focus {
    outline: none;
  }
  .back {
    margin-bottom: 0.6rem;
  }
</style>
