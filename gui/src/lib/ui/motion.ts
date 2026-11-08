/**
 * Step 0 — motion (hub spec "The look", "Motion"): slides glide in about 0.38 s, a detail opens with
 * a short height animation, and EVERY animation is off under the system's "reduce motion" setting.
 *
 * This module is for motion driven from JavaScript (a Svelte transition's `duration`, a scripted
 * scroll): take durations from `durations(prefersReducedMotion())`, never a literal. CSS motion uses
 * the `--glide-ms` / `--open-ms` tokens in `app.css` instead, which are the same values and drop to 0
 * under a `prefers-reduced-motion: reduce` media block, so they follow the setting LIVE.
 * `prefersReducedMotion()` is a one-shot read with no change listener: call it when the motion starts.
 */

/** A slide's glide. */
export const GLIDE_MS = 380;
/** A detail's open (height) animation: shorter than the glide. */
export const OPEN_MS = 220;
/**
 * How long a project you jump to keeps its brief highlight (hub "Motion": "a project you jump to
 * gets a brief highlight"), e.g. `Card`'s `highlighted` ring. HIGHLIGHT_MS is a hold time, not an
 * animation, so it is not shortened under reduced motion: the highlight still shows for as long,
 * only its ring appears and goes without fading (`Card` drops its transition). `durations` does
 * not carry it.
 */
export const HIGHLIGHT_MS = 1200;

/** The system setting, as a media query. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type MatchMedia = (query: string) => { matches: boolean };

/**
 * Whether the system asks for reduced motion. `match` defaults to the webview's `matchMedia`; with
 * none (the server render the tests use) motion stays on.
 */
export function prefersReducedMotion(
  match: MatchMedia | undefined = typeof globalThis.matchMedia === "function" ? (q) => globalThis.matchMedia(q) : undefined,
): boolean {
  return match ? match(REDUCED_MOTION_QUERY).matches : false;
}

/** The durations to animate with: all 0 under reduced motion. */
export function durations(reduced: boolean): { glideMs: number; openMs: number } {
  return reduced ? { glideMs: 0, openMs: 0 } : { glideMs: GLIDE_MS, openMs: OPEN_MS };
}
