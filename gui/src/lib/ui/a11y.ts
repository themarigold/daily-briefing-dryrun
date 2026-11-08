/**
 * Step 0 — accessibility helpers (hub spec "The look", "Accessibility").
 *
 * - A slide change moves focus to the new slide's heading, and the focused heading is what a screen
 *   reader announces: `focusHeading`. There is no separate aria-live announcement of a slide change,
 *   which would be heard twice.
 * - aria-live is only for updates that are NOT focused, such as a run's progress: the caller keeps
 *   the text in its own state, sets it with `nextLiveText`, and draws it in `LiveRegion.svelte`.
 *   Countdowns are not fed to it on every tick.
 *
 * ⚠ NO DOM BUILDING. `tests-web/static.check.ts` refuses every element-creating or attribute-writing
 * name anywhere in `gui/src`; the only DOM call here is `node.focus()`, and the live region is markup.
 */
import type { Action } from "svelte/action";

/**
 * `use:focusHeading={active}` on a heading with `tabindex="-1"` (the caller's markup): focus it when
 * it mounts, UNLESS passed `false` (no argument counts as active), and again whenever `active` turns
 * true. It does not scroll: the slide's own glide brings it into view.
 *
 * ⚠ The hub's rule is that a slide CHANGE moves focus, not the first render: a deck passes `false`
 * while the page first appears (so opening the app does not pull focus into it) and `true` once the
 * user has moved to a slide.
 *
 * ⚠ It fires only when its argument TURNS true, from anything but `true`. Svelte calls `update` on
 * the argument's first re-run even when the value has not changed (`prev` starts as `{}`, svelte
 * 5.57.0, `src/internal/client/dom/elements/actions.js:20-36`), so the action remembers the last
 * value and an update that repeats `true` (or passes `undefined`) focuses nothing. A mount with
 * `undefined` focuses (no argument means active) and records `last = undefined`, so a following
 * `update(true)` focuses again. A second jump to
 * the same target, with the argument still `true`, therefore focuses nothing either: the caller sets
 * it back to `false` between jumps, or re-keys the element (`{#key}`), so the action mounts again.
 *
 * ⚠ The focus is DEFERRED to a microtask, never done in the action's mount or update. Svelte runs an
 * action before the parent's template effects in the same flush (svelte 5.57.0,
 * `src/internal/client/dom/elements/actions.js`), so a deck that marks off-screen slides `inert`
 * still has `inert` on the new slide when the action runs, and a focus then lands on `<body>`
 * (round-3 review, measured in the webview). `queueMicrotask` and not `tick()`: Svelte's flush is
 * synchronous, so a microtask already runs after it, measured to focus the heading, with no import
 * from `svelte` and nothing else waited for. By then the node may be gone, so the focus is skipped
 * when the action was destroyed or the node is no longer in the document.
 */
export const focusHeading: Action<HTMLElement, boolean | undefined> = (node, active) => {
  let destroyed = false;
  let last = active;
  const focusSoon = () =>
    queueMicrotask(() => {
      if (!destroyed && node.isConnected) node.focus({ preventScroll: true });
    });
  if (active !== false) focusSoon();
  return {
    update(next: boolean | undefined) {
      if (next === true && last !== true) focusSoon();
      last = next;
    },
    destroy() {
      destroyed = true;
    },
  };
};

/** Appended to repeat a message, so a screen reader hears an unchanged message again. */
const REPEAT = "\u00a0";

/**
 * The text to put in the live region for `message`, given what it holds now. A new message is set
 * as is; the SAME message again toggles a trailing no-break space, because a live region announces
 * only a change; an empty message clears it.
 */
export function nextLiveText(current: string, message: string): string {
  if (message === "") return "";
  return current === message ? message + REPEAT : message;
}
