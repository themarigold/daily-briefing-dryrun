// src/sha.ts — the ONE commit-SHA shape test, shared by the generator's grounding guard
// (verifyEvidence), the audit's citation miner (extractCitedShas), and — since 2026-08-03 — the
// eval's FABRICATION decision in `eval/checks.ts`. Kept here, not duplicated, so they can NEVER
// disagree: the generator KEEPS a token in rendered evidence iff the audit treats it as a citation.
// When they diverged, the generator's Tier-A fix (correctly keeping prose like "added"/"cafe")
// re-surfaced a stale audit false-positive that flagged the same word as a `fabricated SHA`
// (final-review Tier-D). One function, one truth.
//
// ⚠ THAT HEADER WAS FALSE FOR ~A MONTH, and the correction is the reason this note exists.
// `eval/checks.ts` carried a THIRD copy that never imported this file and applied no `[a-f]`
// requirement at all, so an all-digit token — a date, a timestamp, a PR number — in an evidence
// field became a `fail`-severity G2 fabrication verdict while the generator and the audit both
// correctly ignored it. Converged 2026-08-03. The one thing still NOT shared is the minimum LENGTH:
// the eval's evidence miner keeps a 7-char floor where this file allows 4, deliberately and with the
// measurement recorded at its definition. So: one shape test, one truth — and one documented,
// measured exception rather than a silent fourth divergence.

// 4–40 hex chars — a full or abbreviated git object name (git's default abbrev is 7).
export const SHA_RE = /^[0-9a-f]{4,40}$/i;

// Is `tok` plausibly an (abbreviated) commit SHA, vs. an innocent hex-ish English word or bare number?
// SHA_RE alone matches "2024" (a year), "20260716" (a date), and "added"/"cafe"/"dead"/"decade" (all-[a-f]
// words), which produced FALSE "fabricated SHA" warnings and destructive rewrites. Require at least one
// a–f LETTER (rules out pure numbers like dates/PR#s) AND either a digit or length ≥ 7 (rules out short
// hex-only words like "cafe"/"added", while still catching a mixed abbrev or an all-letter placeholder
// like "deadbeef"). Residual false-positives are only 7+-char all-[a-f] English words (e.g. "defaced"),
// which are vanishingly rare in commit evidence. Prose and file paths pass through.
// Residual false-NEGATIVE (accepted tradeoff): a pure-digit or short all-letter garble is indistinguishable
// from a PR#/date/word and is treated as non-SHA — so it isn't grounding-checked. Symmetric on both sides.
export function isShaShaped(tok: string): boolean {
  if (!SHA_RE.test(tok)) return false;
  if (!/[a-f]/i.test(tok)) return false; // pure numbers (years, dates, PR numbers) are not SHAs
  return /[0-9]/.test(tok) || tok.length >= 7;
}

// ── The EXTRACTION shape test, extracted 2026-09-19 (IN-3 Stage 1b, review round 3) ───────────────
// `isShaShaped` answers "could this be a FABRICATED SHA?", so it rejects every all-digit token: a
// year or a PR number must not cost a false fabrication verdict. EXTRACTION asks the opposite —
// "could this token NAME a real commit?" — and git abbreviates to all digits ~4% of the time
// (`4760499`, `3316617`). #514 answered that for `clusterRecap`'s resolver with `SHA_RE` plus a 7-char
// floor on exactly the tokens `isShaShaped` rejects; the call site's comment records why each half is
// load-bearing. IN-3's tier-3 campaign phrase needs the SAME answer for the opposite reason: a token
// that could name a commit must not be PRINTED in a header, because `audit.missingSameDay` reads any
// left-bounded 7-char prefix in the rendered text as that commit reflected. Two callers, both feeding
// a counted outcome, so ONE definition — extracted at two copies, as the plumbing below was.
// NOT the rule everywhere, deliberately: `recapCoverage` gates on bare `SHA_RE` with no floor (its
// comment argues why), and the eval's `evidenceCandidates` uses a blanket `[0-9a-f]{7,40}`.
/** Could `tok` name a real commit? `SHA_RE`, plus a 7-char floor applied ONLY to the tokens
 *  `isShaShaped` rejects (all-digit, short all-`[a-f]`). Net over `isShaShaped`: admits exactly the
 *  all-digit 7–40 class; every `isShaShaped` token — including a 4–6-char `2026a` — passes as before. */
export function isExtractableSha(tok: string): boolean {
  return SHA_RE.test(tok) && (isShaShaped(tok) || tok.length >= 7);
}

// ── Evidence-token plumbing, extracted 2026-09-03 (day 49) ───────────────────────────────────────
// These three were duplicated VERBATIM at two sites in generator.ts — `verifyEvidence`'s tokenizer
// plus `shaResolves`, and `clusterRecap`'s `resolveOne` — and day 49 needed a third caller
// (`recapCoverage`). Extracted at two copies rather than three, deliberately: this file's own header
// records what a hidden third copy cost last time — `eval/checks.ts` carried one for ~a month with a
// different shape test, and an all-digit token became a `fail`-severity fabrication verdict. The two
// copies were checked identical before extraction (same split, same `[()]` strip, same adornment
// strip, same either-direction prefix test), so nothing had drifted and no behaviour is chosen here.
//
// Why a coverage count is decision-feeding: `recapCoverage` reports a commit as NOT SHOWN when no
// recap bullet resolves to it. A resolver that is one character stricter than the one which built
// the bullets would report phantom drops in a line whose entire purpose is to be trusted.

/** Split a model-authored `evidence` field into candidate tokens. Parens are stripped rather than
 *  split on, so `2ee0ae5 (src/main.ts)` yields both halves. */
export function evidenceTokens(evidence: string): string[] {
  return evidence.split(/[,\s]+/).map((t) => t.replace(/[()]/g, "")).filter(Boolean);
}

/** Strip the adornments models habitually wrap identifiers in — backticks, quotes, brackets, and
 *  trailing sentence punctuation — WITHOUT lowercasing. Callers that compare keep the original
 *  token for display; `verifyEvidence` depends on that to echo real evidence verbatim. */
export function bareToken(tok: string): string {
  return tok.replace(/^[`'"[{*_]+/, "").replace(/[`'"\]}*_.,;:!?]+$/, "");
}

/** Prefix-compatible in EITHER direction, case-insensitively: the model may cite a 7-char prefix of
 *  a full SHA, and ground truth may hold a prefix of what was cited. Not a similarity measure — one
 *  must be a literal prefix of the other. */
export function shaPrefixMatch(a: string, b: string): boolean {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}
