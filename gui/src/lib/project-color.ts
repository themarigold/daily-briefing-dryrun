/**
 * Project colours (Step 0, the shared look; hub spec "The look, for every screen", "Project pills").
 *
 * A project label maps to one of a FIXED palette of 12 slots, drawn by the `.pc-0` … `.pc-11` class
 * pairs in `app.css`. A fixed palette, not a continuous hue, so every pair can be contrast-tested and
 * no style value is ever built from engine text (the CSP rule, `app.css`'s header). This module
 * picks slot NUMBERS; `paletteClass` turns a number into one of those fixed class names (for `Pill`
 * and for A's bars, which read the class's `--pc-fg`), and nothing else does.
 *
 * The rule:
 *  - the label is normalised as the engine does, through the GUI's one port of `norm`
 *    (`./briefing-struct`, mirrored from `src/subprojects.ts`), so `Mono` and `**mono**` are one
 *    project;
 *  - its preferred slot is djb2 over the normalised label's Unicode code points, wrapped to 32 bits,
 *    modulo 12 — the old local app's hash (`daily_briefing/BriefingSlides/SlideContent.swift`,
 *    `pillHue`), which took it modulo 360 for a hue;
 *  - on one page, labels are placed in order of first appearance, and a label whose preferred slot
 *    is taken gets the next free slot (wrapping). So up to 12 projects on a page never share a
 *    colour; beyond 12, a label reuses its preferred slot;
 *  - a label that normalises to nothing is not a project: it gets `null` and takes no slot.
 *
 * The test vectors in `gui/tests-web/look.check.ts` come from an independent Swift program
 * (`gui/tests-web/probes/project-color-vectors.swift`), not from this file.
 */
import { norm } from "./briefing-struct";

/** How many colour slots the palette has (`.pc-0` … `.pc-11`). */
export const PALETTE_SLOTS = 12;

/**
 * The slot a label takes when nothing else on its page has it.
 *
 * Every label gets a real slot here, including one that normalises to nothing (`""`, `"**"`). Such a
 * label is not a project: `assignSlots` gives it `null` (the neutral "Other" pill, `pc-other`), and
 * callers never pass it to this function.
 */
export function preferredSlot(label: string): number {
  let h = 5381;
  for (const ch of norm(label)) h = (Math.imul(h, 33) + ch.codePointAt(0)!) >>> 0;
  return h % PALETTE_SLOTS;
}

/**
 * The class for a slot: `pc-0` … `pc-11`, or the neutral `pc-other` for `null` (the deck's "Other"
 * card, and a label with `norm(label) === ""`). A slot outside 0-11 is clamped (a fraction is
 * truncated toward zero, ±Infinity goes to the nearer end) and `NaN` is neutral, so no class outside
 * the palette is ever drawn.
 */
export function paletteClass(slot: number | null): string {
  if (slot === null || Number.isNaN(slot)) return "pc-other";
  return `pc-${Math.min(PALETTE_SLOTS - 1, Math.max(0, Math.trunc(slot)))}`;
}

/**
 * One slot per label, in the order given (the page's order of first appearance). Labels that
 * normalise alike share a slot and take no second one. A label that normalises to nothing (`""`,
 * `"**"`) is not a project: it gets `null` (the neutral pill) and takes no slot, so it never pushes
 * a project off its colour.
 */
export function assignSlots(labelsInPageOrder: readonly string[]): (number | null)[] {
  const byKey = new Map<string, number>();
  const taken = new Set<number>();
  return labelsInPageOrder.map((label) => {
    const key = norm(label);
    if (key === "") return null;
    const known = byKey.get(key);
    if (known !== undefined) return known;
    let slot = preferredSlot(label);
    // Bounded: at most one pass round the palette, so a broken guard cannot loop forever.
    if (taken.size < PALETTE_SLOTS) {
      for (let k = 0; k < PALETTE_SLOTS && taken.has(slot); k++) slot = (slot + 1) % PALETTE_SLOTS;
    }
    taken.add(slot);
    byKey.set(key, slot);
    return slot;
  });
}
