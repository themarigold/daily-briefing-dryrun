// test/helpers/unstamp.ts — the ONE normaliser for cross-run page comparisons. A helper module, not a
// test file (a `.test.ts` import would re-register its tests). Moved here from test/json-envelope.test.ts
// (tier B, T4.3) so the tier-B pins that compare two delivered pages share it instead of copying the regex.

/** `stateAsOf` is `new Date().toTimeString().slice(0, 5)` (core.ts:809) — a REAL-clock HH:MM that no
 *  injected clock reaches. Two runs seconds apart are identical unless they straddle a minute
 *  boundary, so any comparison ACROSS runs normalises that one stamp and says so.
 *  ⚠ It works on PAGE TEXT (`state as of HH:MM`). A struct comparison overwrites `stateAsOf` on both
 *  sides instead; this does not reach a struct.
 *  ⚠ json-envelope's byte-identical proof does not rely on this: it is the SINGLE-run `--json-out`
 *  test there, where the envelope's `markdown` and stdout are the same string from the same render. */
export const unstamp = (s: string): string => s.replace(/state as of \d{2}:\d{2}/g, "state as of HH:MM");
