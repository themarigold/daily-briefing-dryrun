/**
 * A-M7-T15 checkpoint (MED) — the decisions of A's two rows on Settings → General (`PrefsRowsBody.svelte`), pure, so
 * they are tested without a DOM (`tests-web/prefs-rows.check.ts`; `tests-web` renders on the server only and runs
 * no handler). The component keeps the busy flags and the store calls; what it does with each answer is here.
 */
import type { AppPrefsSetOutcome } from "../app-prefs-store";

/** A row's line after a set: "Saved." or the failure's sentence. `null` = nothing to say. */
export type RowLine = { ok: boolean; text: string } | null;

export const SAVED_LINE = "Saved.";

/** Whether a name send goes out: not while one is in flight, and not for the value last sent (Enter then blur sends
 *  one set; a blur with no edit sends none). */
export function sendsName(i: { value: string; lastSent: string; busy: boolean }): boolean {
  return !i.busy && i.value !== i.lastSent;
}

export interface NameAfterSet {
  /** What the input holds now. */
  name: string;
  /** What counts as already sent, for the next `sendsName`. */
  lastSent: string;
  line: RowLine;
  /** The input changed while the set was in flight: send its text once the set has ended (`sendsName` decides). */
  again: boolean;
}

/**
 * What the name row holds after a set of `sent`, given the input's text NOW (`input`, which the user may have edited
 * while the set was in flight) and the store's name after the set (`stored`, "" when unset).
 * - Saved: the input shows what the store kept (Rust trims), unless the user typed meanwhile; then the newer text is
 *   kept and sent once this set ends. The line is "Saved." (the earlier text was saved; the next set replaces it).
 * - Refused (`invalidInput`): the input keeps its text, Rust's sentence is the line, and the refused value counts as
 *   sent, so Enter or blur does not send it again.
 * - The store failed: the same line, but nothing counts as sent beyond what the store holds, so Enter or blur
 *   retries without an edit.
 */
export function nameAfterSet(i: { sent: string; input: string; outcome: AppPrefsSetOutcome; stored: string }): NameAfterSet {
  const typedMeanwhile = i.input !== i.sent;
  if (i.outcome.ok) {
    return { name: typedMeanwhile ? i.input : i.stored, lastSent: i.stored, line: { ok: true, text: SAVED_LINE }, again: typedMeanwhile };
  }
  return {
    name: i.input,
    lastSent: i.outcome.refused ? i.sent : i.stored,
    line: { ok: false, text: i.outcome.message },
    again: typedMeanwhile,
  };
}

/**
 * Scoped-review M1: when the rows unmount (the route changes), the name is FLUSHED — sent at once, so it is in flight
 * before the component is gone and a reopened Settings waits for it — when the input differs from what was last sent
 * and no failure line is on screen (a refused name stays unsent). A name typed and never blurred is covered too.
 */
export function flushesOnUnmount(i: { name: string; lastSent: string; line: RowLine }): boolean {
  return i.name !== i.lastSent && (i.line === null || i.line.ok);
}

/** Whether a slides click goes out: not while a set is in flight. */
export function sendsSlides(busy: boolean): boolean {
  return !busy;
}

/** What the slides row shows after a set of `requested`: ALWAYS the store's value (`stored`), never the requested
 *  one, so a failed set leaves the row on what is saved. */
export function slidesAfterSet(i: { requested: boolean; outcome: AppPrefsSetOutcome; stored: boolean }): { slides: boolean; line: RowLine } {
  return { slides: i.stored, line: i.outcome.ok ? { ok: true, text: SAVED_LINE } : { ok: false, text: i.outcome.message } };
}
