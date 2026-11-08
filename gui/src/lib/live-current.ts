/**
 * Briefing redesign wave 2, W2-S — the deck's current slide and the user's moves, for the live checks Today drives
 * (B1's git detail, C's calendar details). Plan §1.2, "The current slide (webview)". Pure: no Svelte, no IPC.
 *
 * TWO DIFFERENT QUESTIONS, deliberately kept apart:
 * - `currentSlide` answers WHAT is current. `DeckOrClassic` reports it through `oncurrent` on every change. It is never
 *   read as "the user moved": a read error and its recovery, a run's jump to Good morning, a new page or a slide-count
 *   clamp all change it without the user doing anything.
 * - `moveRules` answers WHEN the user moved. `DeckOrClassic` emits `onmove` only for the user's own navigation (an
 *   arrow, a dot, ← or →, Start ›: all through `dispatch`), for Back to slides, and for the deck's first draw in a
 *   Today mount (the user opened Today onto that slide). ONE object per mount holds the one "drawn" flag, so the three
 *   call sites cannot keep separate copies of it and one transition emits once (round 5, P5-H1: a kept Full briefing
 *   restored on a remount, then Back to slides, is one move, not two).
 */
import type { DeckView, SlideId } from "./deck";

/**
 * The slide the user is looking at, or `null` when none is: the slides switched off, the classic view (a page that
 * cannot be mapped), a one-slide state (loading, a read error, no briefing yet) or Full briefing open. `index` is
 * `DeckOrClassic`'s `nav.index`, never a slide's `active` prop (which is armed only after a move, for focus).
 */
export function currentSlide(i: { slides: boolean; deck: DeckView; classic: boolean; index: number }): SlideId | null {
  if (!(i.slides && i.deck.kind === "slides" && !i.classic)) return null;
  return i.deck.slides[i.index] ?? null;
}

/** One `onmove`: the slide moved onto, and the slide current just before (`null` when none was). */
export type Move = { slide: SlideId; from: SlideId | null };

/**
 * `onmove`'s rules for one mount (`DeckOrClassic` creates one, `const moves = moveRules();`):
 * - `dispatched`: a move when the reducer changed the index (`toggle`, `openAll`, `closeAll`, a jump to the same
 *   index and `next` at the last slide change nothing), with the new index's slide and the old one's;
 * - `backToSlides`: a move whenever a slide is current once Full briefing closes, `from: null` (none was current in
 *   the classic view);
 * - `drawn`: the deck's first draw, the first non-null slide, `from: null`, and only while nothing has been emitted
 *   in this mount.
 * Each that gives a move sets the flag; nothing clears it (a remount is a new component, and a new `moveRules()`).
 */
export function moveRules(): {
  dispatched(prevIndex: number, nextIndex: number, slides: readonly SlideId[]): Move | null;
  backToSlides(slide: SlideId | null): Move | null;
  drawn(slide: SlideId | null): Move | null;
} {
  let emitted = false;
  const move = (slide: SlideId, from: SlideId | null): Move => {
    emitted = true;
    return { slide, from };
  };
  return {
    dispatched(prevIndex, nextIndex, slides) {
      if (nextIndex === prevIndex) return null;
      const slide = slides[nextIndex];
      return slide === undefined ? null : move(slide, slides[prevIndex] ?? null);
    },
    backToSlides(slide) {
      return slide === null ? null : move(slide, null);
    },
    drawn(slide) {
      return emitted || slide === null ? null : move(slide, null);
    },
  };
}
