/**
 * Step 0 — geometry from numbers only (hub spec "The look": "Timeline positions, commit-bar widths
 * and the like come from clamped numbers"; "Constraints": the only allowed style attribute is a
 * numeric custom property, `style:--x={helper(…)}`, where the helper is a named function returning a
 * clamped number, or an SVG geometry attribute from such a helper).
 *
 * ⚠ EVERY EXPORT HERE IS A GEOMETRY HELPER, AND ONLY THESE ARE. `tests-web/static.check.ts` reads
 * this file's exports at test time and accepts a `style:--x={…}` value or an SVG geometry expression
 * only when it is a call to one of them; each must clamp (`Math.min(` and `Math.max(`). `lib/ui` is
 * frozen during wave 1, so a helper D or A needs is added here first.
 *
 * ⚠ The helpers return UNITLESS numbers, so `style:--w={clampPct(n, max)}` sets `--w: 40`. CSS must
 * add the unit itself, `width: calc(var(--w) * 1%)` (or `* 1px`, `* 1rem`…). `width: var(--w)`
 * with a bare number is invalid at computed-value time, so `width` falls back to its initial value
 * (`auto`), and that overrides any earlier `width` rule.
 *
 * Wave-1 users: A's commit bars (`clampPct(count, max)`), A's slide track offset
 * (`clampPct(index, slideCount)`), and A's track size, a slide COUNT or index as a plain number
 * (`clampInt(count, 12)`). D needs none.
 */

/** `100 · n / max`, clamped to 0-100. 0 when `max` is not above 0, or when the ratio is `NaN`. */
export function clampPct(n: number, max: number): number {
  if (!(max > 0)) return 0;
  const pct = (100 * n) / max;
  if (Number.isNaN(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/**
 * `n` as a whole number in 0..max, for a count or an index (`style:--n={clampInt(count, 12)}`).
 * It TRUNCATES toward zero (2.9 → 2; a fractional `max` is truncated too), so an index never rounds
 * up past the last slide. 0 when `n` or `max` is `NaN` or ±Infinity, or when `max` is not above 0;
 * never `-0`.
 */
export function clampInt(n: number, max: number): number {
  if (!Number.isFinite(n) || !Number.isFinite(max) || !(max > 0)) return 0;
  return Math.min(Math.trunc(max), Math.max(0, Math.trunc(n)));
}
