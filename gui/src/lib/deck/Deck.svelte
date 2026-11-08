<script lang="ts">
  /**
   * The deck (A spec, "The deck"): the slides side by side on one track that glides (`--glide-ms`, 0
   * under reduced motion), the round arrows, the dots, and ← → on the keyboard. Navigation is the pure
   * reducer in `deck.ts`; this component draws it and sends it actions.
   *
   * ⚠ EVERY SLIDE STAYS MOUNTED. Off-screen slides are `inert` (out of the tab order and the
   * accessibility tree), never unmounted, so Good morning's `RunControls` — and the user's own Details
   * toggle in it — survives a slide change (A-M5's decision on the carried `open` toggle). Only "Full
   * briefing" swaps the deck for the classic view, whose own `RunControls` starts from the prop.
   *
   * ⚠ A SLIDE CHANGE IS ANNOUNCED BY FOCUS, NOT BY A LIVE REGION (hub, Accessibility): each slide's
   * heading has `tabindex="-1"` and `use:focusHeading`, armed on the current slide only while DeckOrClassic's ONE
   * focus state says so (`landing === "slideHeading"`: a move, Back to slides, or a change that must land focus), so
   * opening Today does not pull focus. Nothing here writes to a `LiveRegion` or an `aria-live` element.
   *
   * Round-4 L5: the track glides only once `glide` is true (the user has moved in this mount); before that a slide
   * restored on return appears at once. Round-4 L6: on every slide change the new current slide is scrolled to its
   * top, so the heading that takes focus is on screen.
   *
   * PB-M1: a REMAP (the slide list changed around the current slide, which keeps its id at a new index) is not a slide
   * change: the track does not glide to `quiet` (DeckOrClassic's remapped index), and L6, which tracks the shown
   * slide's id as well as its index, does not scroll it. A removal (a new slide at the same index) still resets.
   *
   * The track's offset is a clamped number (`clampInt`, `lib/ui/geometry.ts`) in a custom property;
   * no style is built from text.
   *
   * Round 1 (the approved mockup, deck.html `.chev`/`.dot`, settled 2026-10-24): the ‹ › arrows sit at the
   * slide's left and right edges, vertically centred, 36 px round, and are HIDDEN (not just dimmed) at the
   * first and last slide; each slide has a gutter of the arrow's width as its margin, outside its scroller, so
   * an arrow never covers its text or its scrollbar (round-2 L1). The dots stay in a row below, the current
   * one a 22 px accent lozenge, each with a 24 px hit area (L10). A dot is named by its slide's own heading
   * (`slideHeadings`, L3). The current slide is focusable (`tabindex="0"`, a region named by its place,
   * "Slide 2 of 5"; its heading, read next, says what it is), so ↓ and PageDown scroll it at the 560×420
   * minimum (L9); nothing focuses it on the first render. ← → do nothing while a modal dialog is open (the
   * Quit dialog, L1).
   */
  import { untrack } from "svelte";
  import { tileEvents } from "../calendar-detail";
  import { glanceMeeting, slideHeadings, type DeckAction, type DeckNav, type DeckView } from "../deck";
  import { moreBelow, scrollResets, type FocusLanding } from "../deck-state";
  import type { TodayModel } from "../today";
  import { clampInt } from "../ui/geometry";
  import CalendarSlide from "./CalendarSlide.svelte";
  import GoodMorning from "./GoodMorning.svelte";
  import Launchpad from "./Launchpad.svelte";
  import LeftOff from "./LeftOff.svelte";
  import Suggested from "./Suggested.svelte";
  import WhatYouDid from "./WhatYouDid.svelte";

  interface Props {
    view: Exclude<DeckView, { kind: "classic" }>;
    model: TodayModel;
    nav: DeckNav;
    /** DeckOrClassic's ONE focus state: "slideHeading" arms the current slide's heading. */
    landing: FocusLanding;
    /** The user has moved in this mount: only then does the track glide (L5). */
    glide: boolean;
    /** PB-M1: the index a remap landed on; the track does not glide to it (null: none). */
    quiet: number | null;
    now: number;
    ondispatch: (a: DeckAction) => void;
    onfull: () => void;
    onhistory: () => void;
    running: boolean;
    progress: string[];
    runResult: string;
    detailsOpen: boolean;
    onrun: () => void;
  }
  let { view, model, nav, landing, glide, quiet, now, ondispatch, onfull, onhistory, running, progress, runResult, detailsOpen, onrun }: Props = $props();
  /** The current slide's heading is the focus target (the slides' `active`). */
  const armed = $derived(landing === "slideHeading");

  /** Each slide's name: its own heading's text (L3). */
  const names = $derived(slideHeadings(view));
  const page = $derived(view.kind === "slides" ? view.page : null);
  /** B1: the live git check's view (`git-detail.ts`), for the five slides that draw it; null before a page. */
  const git = $derived(view.kind === "slides" ? view.git : null);
  /** B2: the buttons from current held handles (`actions.ts`); null without Today's input. */
  const actions = $derived(view.kind === "slides" ? view.actions : null);
  /** C: today's calendar details read live (`deckView`'s `live`), for the calendar slide and the launchpad. */
  const live = $derived(view.kind === "slides" ? view.live : null);
  // C-M5-T14: Good morning's "Next meeting" follows the live events once a read has answered (`tileEvents`).
  /** PB-M4: the deck has the calendar slide (a section, or a live calendar day): the tiles and the live read count. */
  const calendarDay = $derived(view.kind === "slides" && view.slides.includes("calendar"));
  const meeting = $derived(page !== null && !page.stale && calendarDay ? glanceMeeting(page.pageDate, tileEvents(page, live), now) : null);
  const count = $derived(view.slides.length);

  /** ← and → move between slides, unless a modifier is held, the key is for a text field, or a modal dialog is open. */
  function onkeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    // L1: the Quit dialog (`aria-modal="true"`) is over the deck: its keys are its own, wherever focus is.
    if (document.querySelector('[aria-modal="true"]') !== null) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      ondispatch({ type: "previous" });
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      ondispatch({ type: "next" });
    }
  }

  /**
   * "More below": the current slide scrolls on its own, and on a small window a slide can be taller than
   * the viewport with nothing to say so (A-M6 review, MED-2). Measured on the slide's scroll, and on any
   * resize of the slide or its content (a window resize, Open all, a Details disclosure). The slide's and its
   * last child's bottom padding do not count as more: only empty space is there (`moreBelow`).
   */
  let slideEls = $state<HTMLElement[]>([]);
  let more = $state(false);
  function bottomPadding(el: Element | null): number {
    return el === null ? 0 : parseFloat(getComputedStyle(el).paddingBottom) || 0;
  }
  function measure(): void {
    const el = slideEls[nav.index];
    more =
      el !== undefined &&
      moreBelow({ scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, emptyFoot: bottomPadding(el) + bottomPadding(el.lastElementChild) });
  }
  $effect(() => {
    const el = slideEls[nav.index];
    if (el === undefined) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  });

  // L6: a slide that becomes current starts at its top (it may have been left scrolled), before its heading takes
  // focus (`focusHeading` focuses in a microtask, after this flush) — never on the first render. PB-M1: decided from the
  // OLD place and id (`scrollResets`), the pair updated before any return; a same-id remap is not a new slide.
  let shownIndex = untrack(() => nav.index);
  let shownId = untrack(() => view.slides[nav.index]);
  $effect(() => {
    const i = nav.index;
    const id = view.slides[i];
    const reset = scrollResets({ index: shownIndex, id: shownId }, { index: i, id });
    shownIndex = i;
    shownId = id;
    if (!reset) return;
    const el = untrack(() => slideEls[i]);
    if (el !== undefined) el.scrollTop = 0;
  });
</script>

<svelte:window {onkeydown} />

<section class="deck" aria-label="Briefing slides">
  <div class="viewport">
    <div class="track" class:glide={glide && quiet !== nav.index} style:--i={clampInt(nav.index, 12)}>
      {#each view.slides as id, i (id)}
        <!-- L9: a scrollable region the keyboard can reach (only the current slide: the others are inert), so ↓ and
             PageDown scroll it. Named by its place ("Slide 2 of 5"); its heading, read next, says what it is, so the
             name does not repeat it. Svelte counts a region as non-interactive; a focusable scroll container is the
             one case where that is wanted (axe's scrollable-region-focusable). -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="slide" inert={i !== nav.index} bind:this={slideEls[i]} onscroll={measure} tabindex="0" role="region" aria-label={`Slide ${i + 1} of ${count}`} data-slide={id}>
          {#if id === "goodMorning"}
            <GoodMorning
              gm={view.goodMorning}
              {model}
              {meeting}
              active={armed && i === nav.index}
              current={i === nav.index}
              onstart={count > 1 ? () => ondispatch({ type: "next" }) : null}
              {running}
              {progress}
              {runResult}
              {detailsOpen}
              {onrun}
              {git}
            />
          {:else if page !== null && id === "whatYouDid"}
            <WhatYouDid {page} open={nav.open} active={armed && i === nav.index} {ondispatch} {git} {actions} />
          {:else if page !== null && id === "leftOff"}
            <LeftOff leftOff={page.leftOff} active={armed && i === nav.index} {git} {actions} />
          {:else if page !== null && id === "suggested"}
            <Suggested suggested={page.suggested} active={armed && i === nav.index} {git} {actions} />
          {:else if page !== null && id === "calendar"}
            <CalendarSlide calendar={page.calendar} {live} {now} active={armed && i === nav.index} />
          {:else if page !== null && id === "launchpad"}
            <Launchpad {page} {now} {git} {actions} {live} {calendarDay} active={armed && i === nav.index} {onfull} {onhistory} />
          {/if}
        </div>
      {/each}
    </div>
    {#if more}<p class="more-hint" aria-hidden="true">More below ↓</p>{/if}
    {#if count > 1}
      <!-- The mockup's .chev: over the slide's edges, vertically centred; hidden at the ends (disabled, and drawn transparent). -->
      <button type="button" class="ctl arrow prev" aria-label="Previous slide" disabled={nav.index === 0} onclick={() => ondispatch({ type: "previous" })}>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 3 5 8l5 5" /></svg>
      </button>
      <button type="button" class="ctl arrow next" aria-label="Next slide" disabled={nav.index === count - 1} onclick={() => ondispatch({ type: "next" })}>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" /></svg>
      </button>
    {/if}
  </div>

  {#if count > 1}
    <nav class="controls" aria-label="Slides">
      {#each view.slides as id, i (id)}
        <button
          type="button"
          class="ctl dot"
          aria-label={`Slide ${i + 1} of ${count}: ${names[id]}`}
          aria-current={i === nav.index ? "step" : undefined}
          onclick={() => ondispatch({ type: "jump", index: i })}
        ></button>
      {/each}
    </nav>
  {/if}
</section>

<style>
  /* The deck is bounded to the window (the mockup's `.win`/`.viewport`, deck.html:14-17): each slide is the
     viewport's height and scrolls on its own, and the controls (the dots below the viewport, the arrows over
     its edges) stay at the same place whatever the slide's length. Without a bound, the slides — a flex row — are all as tall as
     the tallest, and the controls fall far below a short slide (A-M5 review, MED-1). Round-3 L4: the bound is the
     space LEFT in the window, not `100vh` less a guess at App's chrome — App makes its main a full-height flex
     column while the deck is drawn (`main:has(.deck)`), and the deck grows into what the header, a notice or the
     snapshot error line leave. The min-height keeps the controls on screen at the window's minimum, 560×420
     (tauri.conf.json; A-M6 review, MED-2); below it the page scrolls. */
  .deck {
    display: flex;
    flex-direction: column;
    /* Round-4 L3: the fallback where `:has()` is not supported (App's column is then not built): the window less
       App's chrome above and below the screen (main's padding, the header, the screen's margin). */
    height: calc(100vh - 10rem);
    min-height: 14rem;
  }
  @supports selector(:has(*)) {
    .deck {
      flex: 1 1 0;
      height: auto;
    }
  }
  /* Clip where the engine has it, so this is no scroller: a chooser opening mid-glide scrolls into view, which would otherwise
     leave the whole track offset here for good. */
  .viewport {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    overflow: clip;
  }
  /* The slide offset is a whole number from clampInt; the unit is added here (geometry.ts's note). */
  .track {
    display: flex;
    height: 100%;
    transform: translateX(calc(var(--i) * -100%));
  }
  /* Only once the user has moved (L5): a restored slide appears at once. */
  .track.glide {
    transition: transform var(--glide-ms) ease;
  }
  /* Each side has a GUTTER of an arrow's width and its inset (36px + 0.3rem, plus a little air), and the arrows
     sit in it, at 900×640 and at the 560×420 minimum. The gutter is the slide's MARGIN, outside the scroller
     (round-2 L1): with padding, the scrollbar ran under the next arrow, and a click on it went to the arrow.
     Each slide still takes 100% of the track (its width plus both margins), so the track's offset is unchanged. */
  .slide {
    flex: 0 0 calc(100% - 2 * (36px + 0.6rem));
    min-width: 0;
    height: 100%;
    margin: 0 calc(36px + 0.6rem);
    overflow-y: auto;
    padding: 0.25rem;
  }
  /* The focused slide (L9): the ring inside its edge, so the viewport's clip never cuts it. */
  .slide:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .controls {
    flex: none;
    display: flex;
    justify-content: center;
    align-items: center;
    margin-top: 0.3rem;
  }
  /* Over the viewport's foot, on the tile surface, so it never shifts the layout; it says it in words. */
  .more-hint {
    position: absolute;
    bottom: 0.4rem;
    left: 50%;
    transform: translateX(-50%);
    margin: 0;
    padding: 0.1rem 0.7rem;
    border: 1px solid var(--tile-border);
    border-radius: 0.65rem;
    background: var(--tile);
    box-shadow: var(--tile-shadow);
    color: var(--muted);
    font-size: 0.78rem;
    pointer-events: none;
  }
  /* The mockup's .chev: 36px round, over the viewport (in the gutter, the slide's margin), vertically centred.
     Its edge is --control (≥ 3:1 on --tile, look.check.ts), on the --tile surface. */
  .arrow {
    position: absolute;
    top: 50%;
    z-index: 1;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 1px solid var(--control);
    border-radius: 50%;
    background: var(--tile);
    box-shadow: var(--tile-shadow);
    color: var(--fg);
    cursor: pointer;
  }
  .prev {
    left: 0.3rem;
  }
  .next {
    right: 0.3rem;
  }
  /* HIDDEN at the first and last slide (the mockup's `.chev[disabled]`), not just dimmed: disabled (so out of
     the tab order) and transparent, with no pointer. */
  .arrow:disabled {
    opacity: 0;
    pointer-events: none;
  }
  .arrow svg {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* The mockup's .dot (8px) and .dot.on (a 22px lozenge in the accent), drawn by ::before inside a 24×24 hit
     area (L10); the buttons touch, so their centres are 24px apart and the drawn gap stays small. */
  .dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    cursor: pointer;
  }
  .dot::before {
    content: "";
    width: 8px;
    height: 8px;
    border-radius: 4px;
    background: var(--control);
    transition:
      width var(--glide-ms) ease,
      background-color var(--glide-ms) ease;
  }
  .dot[aria-current="step"]::before {
    width: 22px;
    background: var(--accent);
  }
  /* Every animation off under reduce motion (--glide-ms is already 0 there; this is the explicit rule). */
  @media (prefers-reduced-motion: reduce) {
    .track,
    .track.glide {
      transition: none;
    }
    .dot::before {
      transition: none;
    }
  }
</style>
