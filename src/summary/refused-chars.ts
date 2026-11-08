// Engine copy of engine.rs's refused-format table and git-detail.ts's predicate.
// Shared repos-request-limits.json vectors pin all endpoints and neighbours.
const REFUSED_FORMAT_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], [0x061c, 0x061c], [0x180e, 0x180e], [0x200b, 0x200f],
  [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
  [0xfff9, 0xfffb], [0xe0001, 0xe0001], [0xe0020, 0xe007f],
];

export function isRefusedCharacter(c: string): boolean {
  const cp = c.codePointAt(0);
  if (cp === undefined) return false;
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  return REFUSED_FORMAT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}
