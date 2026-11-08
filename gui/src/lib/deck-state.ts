/**
 * The deck's module-level state (the briefing redesign's A; the `keepSettings` pattern of
 * `settings-model.ts`): Today unmounts on every route change, so the slide the deck was on, and whether the
 * classic view ("Full briefing") was showing, live here, keyed by the briefing's identity.
 *
 * The identity is a hash of the briefing's TEXT, not its date or path: a same-day rewrite keeps both, and
 * must still bring the deck back to Good morning (A spec, "The deck"). Kept for one briefing at a time; a
 * different text starts fresh, on the slides.
 *
 * PB-M1 (wave-2 polish spec §3, "Slide identity"): the kept slide is held by its `SlideId` as well as its index, so a
 * new slide list for the SAME briefing (the calendar slide added or removed) finds that slide again (`placeOnList`,
 * `remapOnList`); the index stays, as the fallback when the id is gone. A different briefing never looks the id up.
 */
import type { DeckView, SlideId } from "./deck";

/** A briefing's identity: FNV-1a over its UTF-16 code units, with its length. */
export function briefingHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length}:${h.toString(16)}`;
}

export interface DeckState {
  /** The slide the deck was on, by its id; null for a fresh briefing (Good morning, no slide kept yet). */
  slide: SlideId | null;
  /** The slide the deck was on, by its place (the fallback when the id is no longer in the list). */
  index: number;
  /** The classic view ("Full briefing") was showing. */
  classic: boolean;
}

let kept: ({ hash: string } & DeckState) | null = null;

/** The kept state for this briefing, or Good morning on the slides for any other (and that one is kept from now). */
export function deckStateFor(hash: string): DeckState {
  if (kept !== null && kept.hash === hash) return { slide: kept.slide, index: kept.index, classic: kept.classic };
  kept = { hash, slide: null, index: 0, classic: false };
  return { slide: null, index: 0, classic: false };
}

/** Keep the deck's state for this briefing, for the next mount. */
export function keepDeckState(hash: string, slide: SlideId | null, index: number, classic: boolean): void {
  kept = { hash, slide, index, classic };
}

/**
 * Where a kept slide is on a slide list (PB-M1): the kept id's index when it is in the list, else the kept index
 * clamped into it (today's rule) — zero for an empty list (the classic view), never -1.
 */
export function placeOnList(s: { slide: SlideId | null; index: number }, slides: readonly SlideId[]): number {
  if (s.slide !== null) {
    const at = slides.indexOf(s.slide);
    if (at >= 0) return at;
  }
  return Math.max(0, Math.min(s.index, slides.length - 1));
}

/**
 * The slide list changed under the same briefing (PB-M1): where the current slide (`prev[index]`) is now.
 * - "same": it is at the same index (or both lists are empty: the classic view stays classic);
 * - "remap": it is in the new list at a different index (the calendar slide added or removed elsewhere);
 * - "removed": it is gone, so the slide at its old position, clamped — its neighbour (zero for an empty list).
 */
export function remapOnList(
  prev: readonly SlideId[],
  index: number,
  next: readonly SlideId[],
): { index: number; kind: "same" | "remap" | "removed" } {
  const id = prev[index];
  if (id !== undefined) {
    const at = next.indexOf(id);
    if (at >= 0) return { index: at, kind: at === index ? "same" : "remap" };
  } else if (next.length === 0) {
    return { index: 0, kind: "same" };
  }
  return { index: Math.max(0, Math.min(index, next.length - 1)), kind: "removed" };
}

/**
 * PB-M1-T3: what the deck does when its slide list changes under the same briefing key (`remapOnList`, plus the decisions
 * `DeckOrClassic` applies). The user did not move, so none of them is a move (no `onmove`).
 * - same: nothing changes (the caller still updates the count and the shown list);
 * - remap (the same slide at a new index): `quiet` = the new index, so the track does not glide to it; the glide flag is
 *   kept; L6 does not scroll it (the same id, `scrollResets`);
 * - removed (the current slide gone; its neighbour): no quiet, the glide off (the track jumps), and L6 resets the
 *   neighbour (a new id).
 * For both remap and removal the caller runs `afterChange(from, wasInside, false)`, so focus lands only if lost.
 * Only a remap gets `quiet` (B-F4); the next user move clears it and turns the glide on.
 */
export interface ListChange {
  index: number;
  kind: "same" | "remap" | "removed";
  quiet: number | null;
  glide: boolean;
}

export function listChange(s: {
  prev: readonly SlideId[];
  index: number;
  next: readonly SlideId[];
  quiet: number | null;
  glide: boolean;
}): ListChange {
  const r = remapOnList(s.prev, s.index, s.next);
  if (r.kind === "same") return { ...r, quiet: s.quiet, glide: s.glide };
  if (r.kind === "remap") return { ...r, quiet: r.index, glide: s.glide };
  return { ...r, quiet: null, glide: false };
}

/**
 * L6's decision (`Deck`): the slide now current is scrolled to its top when it is a DIFFERENT slide from the one shown —
 * a move, or a removal that put its neighbour at the same index. The same id at a new index is a remap (the list changed
 * around it; the user did not move): no reset. With no id (an index outside the list), the index decides, as before.
 */
export function scrollResets(
  shown: { index: number; id: SlideId | undefined },
  now: { index: number; id: SlideId | undefined },
): boolean {
  if (now.id === undefined && shown.id === undefined) return now.index !== shown.index;
  return now.id !== shown.id;
}

/**
 * "More below" (`Deck`): true while the current slide hides more than its empty bottom padding (`emptyFoot`, in px). A
 * slide that only hides that has nothing below it, and the pill, drawn over the foot, would cover the last thing that
 * does show (Good morning's Start; user decision 2026-11-05). Margins and padding deeper in are not counted, so a list
 * slide can still show the pill with only such empty space below it (up to about 29 px, measured).
 */
export function moreBelow(s: { scrollTop: number; clientHeight: number; scrollHeight: number; emptyFoot: number }): boolean {
  return s.scrollHeight - s.scrollTop - s.clientHeight > s.emptyFoot;
}

/**
 * The deck's state for its briefing key `next` (A-M5; `null` = no page: loading, a read error, the first
 * run). Today mounts while its page loads, so the key starts `null`:
 * - no page: Good morning, and the kept state is left alone (so it is still there when the page arrives);
 * - a page: the kept state if it is this briefing's, else Good morning, kept from now (`deckStateFor`).
 *   A DIFFERENT page while open (a run finished, a same-day rewrite) is the second case: the kept state
 *   is the page that was showing, since `deckStateFor` kept it when it arrived.
 */
export function deckStateOnKey(next: string | null): DeckState {
  return next === null ? { slide: null, index: 0, classic: false } : deckStateFor(next);
}

/**
 * Round-4 M1, THE RUN RULE, in one place (`DeckOrClassic` applies it): ONE jump to Good morning per run, as soon as a run
 * is going AND the deck has a page — when the run starts, or, Today mounting mid-run, when its page arrives — so the
 * run's progress and result are on screen (A spec: run progress is on Good morning). Every move after that is the
 * user's own; nothing holds the deck. A pure STEP (post-cap L1): it takes the memory (`jumpedFor`, the number of the
 * run that has had its jump) and returns it, so the memory is tested with the rule; `run` is the current run's number,
 * and a new run is a new number, so it jumps again.
 */
export function runRule(i: { running: boolean; hasPage: boolean; run: number; jumpedFor: number }): { jump: boolean; jumpedFor: number } {
  if (!i.running || !i.hasPage || i.jumpedFor === i.run) return { jump: false, jumpedFor: i.jumpedFor };
  return { jump: true, jumpedFor: i.run };
}

/**
 * The run rule's memory (post-cap L1, L2), here beside `kept` so it outlives Today's remounts: which run has had its
 * jump. Keyed PER RUN — App numbers each run as it starts (`noteRunStart`) — so going to History and back mid-run does
 * not jump a second time (and overwrite the kept slide), and the next run, a new number, jumps again.
 */
let runNumber = 0;
let jumpedFor = -1;

/** App, as a run starts (Run now, or the tray's Run Now). */
export function noteRunStart(): void {
  runNumber++;
}

/** `runRule` over the module's memory: true when the deck must jump to Good morning now (the memory is updated). */
export function runJumpNow(running: boolean, hasPage: boolean): boolean {
  const step = runRule({ running, hasPage, run: runNumber, jumpedFor });
  jumpedFor = step.jumpedFor;
  return step.jump;
}

/**
 * Focus that a change left nowhere (post-cap L6, the predicate `DeckOrClassic`'s `focusLost` applies to
 * `document.activeElement`): none, the page's body, an element no longer in the document, a control that is now
 * disabled (WebKit drops focus from it, round-4 L2), or one inside an inert slide.
 */
export function focusIsLost(
  active: { isConnected: boolean; matches(selector: string): boolean; closest(selector: string): unknown } | null,
  body: unknown,
): boolean {
  return active === null || active === body || !active.isConnected || active.matches(":disabled") || active.closest("[inert]") !== null;
}

/**
 * Where focus goes, and the ONE focus state of `DeckOrClassic` (round-4 M4): the current slide's heading
 * ("slideHeading": every move sets it, and Back to slides), the classic view's heading or note ("classicView": Full
 * briefing sets it), or nowhere (null: a change resets it, and `focusLanding` decides once the change is drawn). Each
 * target's `use:focusHeading` reads it and fires when it TURNS true for that target.
 */
export type FocusLanding = "slideHeading" | "classicView" | null;

/**
 * Round-3 M3 (and round-1 M2, round-2 L2, round-3 L1 and M2): focus LANDS only when it must.
 * - The deck is drawn after the change: the current slide's heading, if the change left focus nowhere (`lost`: on the
 *   body, out of the document, or in an inert slide), or — `onIndexChange`, a changed briefing — the slide index moved
 *   (`from` → `to`). Focus on a control still on screen (Details on Good morning) is left there.
 * - The classic view is drawn: its heading or note, only if focus was left nowhere.
 * `null`: leave focus alone.
 */
export function focusLanding(i: { deckDrawn: boolean; from: number; to: number; lost: boolean; onIndexChange: boolean }): FocusLanding {
  if (i.deckDrawn) return i.lost || (i.onIndexChange && i.to !== i.from) ? "slideHeading" : null;
  return i.lost ? "classicView" : null;
}

/** Where Today's land request puts the focus (PB-M6-T3, spec §4 "Focus"): the current slide's heading on the deck; the
 *  classic view's target — the cannot-map note, the Full briefing heading, or TodayView's "Today" heading with the slides
 *  switch off — otherwise. The one-slide view (`single`: loading, an error, the first run) is the deck's. */
export function landTarget(i: { slides: boolean; kind: DeckView["kind"]; classic: boolean }): "slideHeading" | "classicView" {
  return !i.slides || i.kind === "classic" || i.classic ? "classicView" : "slideHeading";
}

/**
 * PB-M6-T3: Today's land request (a counter it bumps after Close or "Not now"). A NEW request number gives the ordered
 * edges `null` → target, even when `landing` already holds the target (after a move it usually does): `focusHeading`
 * fires only when its argument TURNS true, so the null edge comes first, committed before a tick. The same number again
 * (a re-render) gives none. `seen` is the memory the caller keeps.
 */
export function landRequestStep(
  seen: number,
  request: number,
  target: "slideHeading" | "classicView",
): { seen: number; edges: [] | [null, "slideHeading" | "classicView"] } {
  if (request === seen) return { seen, edges: [] };
  return { seen: request, edges: [null, target] };
}
