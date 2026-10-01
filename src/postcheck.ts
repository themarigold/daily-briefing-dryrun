// src/postcheck.ts — DETERMINISTIC checks on the RENDERED briefing, not on the prompt.
//
// ⚠ WHY THIS MODULE EXISTS, and it is the whole design rationale (EVAL.md day 25).
// Two defects shipped 2026-08-09 as PROMPT CLAUSES, each with a test that asserted the CLAUSE WAS
// PRESENT IN THE PROMPT:
//
//   #157 `7d875dc` — "a suggestion must NOT restate a RESUME bullet"   (generator.ts +1 line)
//   #155 `99eff57` — RESUME must anchor on the NEWEST same-day work    (generator.ts:167)
//
// Both suites were GREEN. On 2026-08-10 the model ignored both: every suggestion restated a RESUME
// bullet, and RESUME anchored on the OLDEST same-day commit for two units out of two (`3fcc1d2`
// 00:09, oldest of 11; `e5f3650` 04:04, superseded 27 minutes later) — even though `buildDoneBlock`
// hands the model those items ALREADY SORTED NEWEST-FIRST under a cap of 30 that truncated nothing.
//
// So the data was right, the ordering was right, the instruction was right, and the output was
// wrong. A prompt-text assertion cannot tell "the model obeyed" from "the model ignored it" — it is
// a test answering a question adjacent to the one asked. These checks read the OUTPUT instead, so
// they are falsifiable by a fixture rather than by waiting for a live morning.
//
// ⚠ TIER: these are DIAGNOSTICS, not a gate. They run ONLY at the foot of `runCore` (core.ts) —
// they were inside `generateBriefing` until 2026-08-11, and that placement graded a struct two
// later writers had not finished building; see the tombstone in generator.ts —
// and print `postcheck [rule]: …` to stderr / briefing.log. They are NOT wired into
// `scripts/audit.ts`, do NOT join the audit's deterministic list, and therefore do NOT move
// `flagCount` — by absence from audit, not by an INFO-prefix mechanism. Promoting either to a
// counted defect (or wiring them into audit) changes what an EVAL row's flag count means and is an
// eval-integrity decision for the operator, not a code change to make quietly.

import { norm, labelBoundary } from "./subprojects";
import { STAGE1_TEXT_CAP } from "./reduce";
import type { BriefingStruct, DoneItem } from "./types";
import { redactCredentials } from "./transcripts/credentials";

// Re-exported so this module's tests and callers keep one import site; the DEFINITION is in
// ./types, because four other places spelled the same shape inline (see the comment there).
export type { DoneItem };
export type ResumeBullet = { repo: string; text: string };
/** `promoted?` mirrors `BriefingStruct.suggestions` (types.ts) — the CODE-BUILT channel added by
 *  `promoteResumeActions` (S1). Carried here because `checkSuggestionRestatement` must be able to
 *  tell the two channels apart; see the skip at its head. */
/** `repo` (EVAL day 51) is set only by the CODE-BUILT channels: `promoteResumeActions`, which also sets
 *  `promoted`, and IN-10's `core.stashSuggestions`, which does NOT (its entries are scored below like
 *  any suggestion — see that function's docblock). It exists for the fold in `checkSuggestionVolume`
 *  below: render.ts brackets it, so it is part of what the reader sees and must be part of what the
 *  counter grades. `checkSuggestionRestatement` skips promoted entries outright, so it needs no fold
 *  for those; a stash entry is scored on its `text` alone, the same input a model suggestion gives it.
 *  `stash?` (IN-10's channel flag, the types.ts shape) is carried so `checkSuggestionVolume`'s SAME-DAY
 *  leg can set BOTH code-built channels aside — see `isCodeBuilt`. */
export type Suggestion = { text: string; repo?: string; promoted?: true; stash?: BriefingStruct["suggestions"][number]["stash"] };

/**
 * THE ONE DEFINITION of how a DONE subject is rendered into the prompt — i.e. exactly what the model
 * is shown. `buildDoneBlock` (generator.ts) renders with it; `checkResumeFreshness` below matches a
 * model's quotation against it. Those were TWO COPIES and they had ALREADY DRIFTED: the renderer
 * collapsed newlines BEFORE slicing, the matcher sliced the raw subject. Since `norm()` does not
 * collapse internal whitespace, any subject containing a newline rendered one way and was compared
 * another, and the freshness check would silently skip that bullet.
 *
 * ⚠ IT IS UNREACHABLE TODAY, AND THAT IS EXACTLY WHY IT IS EXTRACTED RATHER THAN LEFT ALONE.
 * `today` holds only git commits (`extractor.ts:205`) and every commit text is read with `%s`, which
 * git guarantees is a single line — so no subject currently contains a newline. The matcher was
 * therefore correct BY AN INVARIANT RECORDED NOWHERE, two files away from the code that maintains
 * it. The day `today` gains a non-commit activity (a transcript line, a stash body), the check
 * degrades silently and no test fails. One definition removes the coupling instead of documenting it.
 */
export const doneSubjectAsShown = (subject: string): string =>
  subject.replace(/[\r\n]+/g, " ").slice(0, STAGE1_TEXT_CAP);

/** `info` — true = calibration telemetry, not a finding. Printed as `postcheck-info [rule]` (core.ts) so
 *  the EVAL convention `grep -c "postcheck \["` — and everything downstream of it — counts nothing new.
 *
 *  ⚠ A DISCRIMINATED UNION, AND THE SPLIT IS THE POINT (IN-4 review round 1). S3's two rule ids —
 *  `suggestion-volume-miss` (window) and `suggestion-sameday-miss` (same-day) — are info-only BY TYPE:
 *  their `info` is the REQUIRED LITERAL `true`, so omitting it, writing `false`, or writing any
 *  conditional (`info: day.total <= 10`) is a `tsc` error rather than a row that silently turns counted
 *  on the mornings a test never sampled.
 *  ⚠ EXACTLY WHAT IS COVERED, AND NO MORE. The type makes every non-literal `info` a compile error
 *  UNLESS it is escaped, and three escapes still compile: a deliberate cast (`… as true`,
 *  `as unknown as true`, `<PostFinding>{…}`), a non-null assertion (`info: (day.total <= 10 ||
 *  undefined)!` — `undefined` on a heavy morning, so the row prints COUNTED), and an `any`-typed value
 *  (`info: JSON.parse(String(day.total <= 10))`, an untyped import, an `any` local). The sweeps in
 *  `test/postcheck.suggestion-volume-sameday.test.ts` (d) and `test/postcheck.suggestion-volume.test.ts`
 *  catch any of them ONLY if it is keyed on an input they VARY — volume (unit size and total, past the
 *  archive's heaviest morning), suggestion count (0-5 model-written, 0-2 code-built) and label length
 *  (1 and 51 characters) — and nothing more. NOT varied, so NOT covered: the NUMBER OF UNITS (at most 3
 *  same-day, 2 window — `info: (today.length < 5) as true` survives the suite, and 6 of the 11 archived
 *  row mornings show 5 or more units), and labels containing spaces or parentheses (0 of the 11 rows
 *  today, though a two-word label does appear on the author's pages). The other rules keep an
 *  optional boolean — `suggestion-restates` is the one COUNTED rule. */
export type PostFinding =
  | { rule: "resume-stale" | "suggestion-restates" | "suggestion-restates-near"; detail: string; info?: boolean }
  | { rule: "suggestion-volume-miss" | "suggestion-sameday-miss"; detail: string; info: true };

// Words carrying no topical signal. Deliberately SMALL: an over-eager list silently converts a real
// overlap into a miss, and this check's failure mode should be a false positive (visible, INFO-only)
// rather than a false negative (invisible, which is what the prompt clause already gave us).
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "with", "from", "into", "onto", "that", "this",
  "these", "those", "it", "its", "is", "was", "are", "were", "be", "been", "being", "as", "at",
  "by", "in", "of", "on", "to", "up", "off", "out", "so", "if", "then", "than", "not", "no",
  "you", "your", "yet", "still", "now", "today", "yesterday", "left", "resume", "resuming",
  "here", "there", "what", "which", "who", "when", "where", "how", "why", "do", "does", "did",
  "has", "have", "had", "will", "would", "can", "could", "should", "next", "more", "one", "own",
]);

/**
 * Topical tokens: lowercased, markdown stripped, stopwords and 1-2 char noise dropped.
 *
 * ⚠ SPLITS ON UNICODE letters/numbers (`\p{L}\p{N}`), not `a-z0-9`. The ASCII form silently
 * destroyed every non-Latin briefing — MEASURED before the fix:
 *
 *   "café résumé naïve déployé"  ->  { caf, sum, ploy }   (accents split words mid-token)
 *   "исправить ошибку"           ->  { }                  (zero tokens)
 *   "認証リファクタを完了する"       ->  { }                  (zero tokens)
 *
 * Zero tokens means `containment` returns 0 and BOTH checks silently no-op — no crash, no signal,
 * no way to tell from the outside. On a public cross-platform product that is the same
 * fails-invisibly class this whole module exists to catch, one layer out.
 *
 * ⚠ HONEST LIMIT, not fixed here: scripts without word separators (Chinese, Japanese, Thai) now
 * yield ONE long token per run rather than zero. That is strictly better — a run can at least match
 * an identical run — but it is not segmentation, so containment stays coarse there. Real CJK
 * segmentation needs a dictionary or Intl.Segmenter and is out of scope for a diagnostic.
 */
export function contentTokens(s: string): Set<string> {
  const cleaned = s.toLowerCase().replace(/[`*_]/g, " ");
  const raw = cleaned.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return new Set(raw.filter((t) => t.length > 2 && !STOPWORDS.has(t)));
}

/**
 * CONTAINMENT, not Jaccard: |A∩B| / min(|A|,|B|).
 *
 * ⚠ Jaccard is the wrong metric here, and choosing it would have MISSED the worse of the two live
 * defects. A suggestion is typically much shorter than the RESUME bullet it restates, so the union
 * is dominated by the bullet's extra prose. MEASURED on the 2026-08-10 briefing:
 *
 *   pair                          containment   jaccard
 *   quant_stocks  (escalation)        0.667       0.455
 *   vault_autolog (near-verbatim)     0.636       0.350   <- Jaccard sinks the WORSE offender lower
 *
 * Under Jaccard at this module's 0.45 threshold the escalation case clears by 0.005 and the
 * near-verbatim case is MISSED outright. Containment asks the question actually being asked: "is the
 * shorter text essentially a subset of the longer one?"
 */
export function sharedTokens(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  return sharedTokens(a, b) / Math.min(a.size, b.size);
}

/**
 * ⚠ THE ABSOLUTE FLOOR THAT MAKES THE RATIO MEANINGFUL. Containment divides by `min(|A|,|B|)`, so a
 * SHORT suggestion quantizes hard: with k topical tokens the only achievable scores are multiples of
 * 1/k — a 1-token suggestion scores exactly 0 or **1.000**, clearing any threshold on a single
 * coincidental word. MEASURED on this repo's own fixtures:
 *
 *   pair                                          |A|   shared   containment
 *   quant_stocks  (TRUE positive, 2026-08-10)      15      10        0.667
 *   vault_autolog (TRUE positive, 2026-08-10)      11       7        0.636
 *   "open the PR for feature/auth" (FALSE pos)      3       2        0.667   <- same score, no signal
 *
 * The two real restatements share 7 and 10 tokens; the false positive shares 2. A floor of 4 sits in
 * the empty band between them and, by construction, no suggestion with fewer than 4 topical tokens
 * can ever trip the check. ⚠ n is small (2 true, 1 false) — like the threshold itself this is
 * provisional, which is why the whole module ships INFO-only.
 */
export const MIN_SHARED_TOKENS = 4;

/**
 * MEASURED against the 2026-08-10 briefing (2 suggestions x 7 RESUME bullets, all 14 pairs scored):
 *   0.667  quant_stocks   suggestion vs its RESUME bullet  — judge: a genuine escalation, still 1:1 derived
 *   0.636  vault_autolog  suggestion vs its RESUME bullet  — judge: "near-verbatim restatement"
 *   0.143  highest score against any NON-corresponding bullet — the noise floor
 *
 * ⚠ Scored against the bullet text with the `[label]` prefix STRIPPED, as `parseBriefing` stores it.
 * A first pass measured 0.800/0.727 by leaving the label in, which inflated every pair sharing a
 * repo name — the unit test pinning these numbers is what caught it.
 *
 * Both true positives sit above 0.63 and the nearest false positive is 0.143, so the threshold is
 * placed in a ~0.49-wide empty band rather than balanced on an edge. ⚠ n=1 day, 14 pairs. It will
 * need re-checking once several days of INFO output exist — which is why this ships INFO-only.
 */
export const RESTATEMENT_THRESHOLD = 0.45;

/**
 * Calibration floor for NEAR-MISS telemetry (decided 2026-08-18, user-directed — option A of the
 * day-33 threshold decision). The corpus that has to justify moving RESTATEMENT_THRESHOLD grew by
 * five points in 33 days because only tripping pairs were ever logged; day 33's 0.423 arguable case
 * was invisible until measured by hand. Every run now logs each suggestion's BEST pair when it
 * scores >= this floor but is NOT a finding — as `info` telemetry (`postcheck-info` prefix), which
 * the EVAL flag-count convention deliberately does not match. The threshold itself is UNCHANGED;
 * revisit with ~2 weeks of near-miss data. 0.30 sits above the measured noise floor (0.143) with
 * room to see the whole contested region below 0.45.
 *
 * ⚠ CODE-BUILT ROWS IN THIS CORPUS (IN-10). The stash line `Pop or drop stash@{N}` (core.stashSuggestions)
 * is NOT skipped below — unlike S1's promoted lines — so it logs a near-miss row on every morning a
 * RESUME bullet shares one of its three tokens: 8 of the 13 near-miss rows over 09-05..09-18 (61.5%),
 * measured for the shipped wording (09-05 at 1.00/3 tokens and 09-09 at 0.67/2 sit above the
 * threshold). Against a bullet
 * that says "pop" and "drop" it scores 1.00 — above RESTATEMENT_THRESHOLD — and is held back by
 * MIN_SHARED_TOKENS = 4 alone. A calibrator MUST filter suggestions matching
 * `^Pop or drop stash@\{\d+\}$` out of the corpus: they are code, not model behaviour. Excluding them
 * here was ruled out (operator ruling, IN-10 design approval) — see core.ts `stashSuggestions`.
 */
export const NEAR_MISS_FLOOR = 0.30;

/**
 * #157, moved from prompt to output. Flags any suggestion that is substantially a restatement of a
 * RESUME bullet. Reports the single strongest match per suggestion — a suggestion overlapping two
 * bullets is one defect, not two.
 */
export function checkSuggestionRestatement(
  suggestions: readonly Suggestion[],
  resume: readonly ResumeBullet[],
): PostFinding[] {
  const out: PostFinding[] = [];
  const resumeTokens = resume.map((r) => ({ r, tok: contentTokens(r.text) }));
  for (const s of suggestions) {
    // ⚠ SKIP THE CODE-BUILT CHANNEL (S1). A `promoted: true` suggestion is the VERBATIM tail of a
    // RESUME bullet, so it restates one BY CONSTRUCTION and would score at or near 1.000 every single
    // morning. This rule (#157) exists to catch the MODEL padding SUGGESTIONS with RESUME prose; a
    // deterministic promotion is the opposite — a deliberate carry-down the day-43 judge asked for,
    // labelled `(from resume)` in the render so the reader is never misled about where it came from.
    //
    // The skip covers the near-miss telemetry below as well, and that is the load-bearing half: the
    // NEAR_MISS_FLOOR corpus is what a future move of RESTATEMENT_THRESHOLD will rest on, and seeding
    // it with a guaranteed-1.000 pair every run would poison exactly the calibration data
    // NEAR_MISS_FLOOR was added (2026-08-18) to collect. Neither threshold changes here.
    //
    // ⚠ TWO CALL SITES, AND THE SECOND IS AN EVAL CHECK — this skip narrows both. `g6Redundancy`
    // (src/eval/checks.ts) reuses THIS function deliberately, so that "restatement" has one
    // definition on the delivery path and in the harness; the consequence is that a `promoted`
    // suggestion is now invisible to G6 as well as to the morning diagnostic. G6 is severity `warn`
    // and is in SOFT_RULES, so it reports and never gates — nothing that could pass a run starts
    // passing because of this. ⚠ The behaviour is PENDING OPERATOR ACK: narrowing what an eval check
    // observes is an eval-integrity decision, not a refactor, and it is recorded here rather than
    // decided here. No threshold, gold fixture or severity is touched by this change; the pin lives
    // in test/eval/checks.g6.test.ts so the narrowing is visible rather than implicit.
    //
    // ⚠ THIS SKIP DOES NOT KEEP EVERY CODE-BUILT LINE OUT OF THE CORPUS. IN-10's stash line
    // (`Pop or drop stash@{N}`, core.stashSuggestions) carries `stash`, not `promoted`, and is scored
    // here on purpose — so it DOES seed near-miss rows (8 of 13 over 09-05..09-18, measured for the shipped wording).
    // Filter `^Pop or drop stash@\{\d+\}$` before calibrating; see the note on NEAR_MISS_FLOOR.
    if (s.promoted) continue;
    const sTok = contentTokens(s.text);
    let best: { score: number; shared: number; bullet: ResumeBullet } | undefined;
    for (const { r, tok } of resumeTokens) {
      const score = containment(sTok, tok);
      if (!best || score > best.score) best = { score, shared: sharedTokens(sTok, tok), bullet: r };
    }
    // BOTH gates: a high ratio on 2-of-3 tokens is arithmetic, not evidence (see MIN_SHARED_TOKENS).
    if (best && best.score >= RESTATEMENT_THRESHOLD && best.shared >= MIN_SHARED_TOKENS) {
      out.push({
        rule: "suggestion-restates",
        // Both numbers are printed because the promotion decision needs the calibration data, and a
        // ratio without its shared-token count is exactly what made the fixture FP look convincing.
        detail: `suggestion restates a RESUME bullet (${best.score.toFixed(2)} containment, ${best.shared} shared tokens, [${best.bullet.repo}]): "${clip(s.text)}" vs "${clip(best.bullet.text)}"`,
      });
    } else if (best && best.score >= NEAR_MISS_FLOOR) {
      // Near-miss telemetry (info, never a finding): the pair that DIDN'T trip, with the same two
      // numbers, so the threshold decision accumulates a point every morning instead of only on the
      // mornings the bar trips. Includes pairs blocked solely by the token floor — whether
      // MIN_SHARED_TOKENS is ever the binding gate is itself calibration data (days 28-30 vs 27/31).
      out.push({
        rule: "suggestion-restates-near",
        info: true,
        detail: `below threshold (${best.score.toFixed(2)} containment, ${best.shared} shared tokens, [${best.bullet.repo}]): "${clip(s.text)}" vs "${clip(best.bullet.text)}"`,
      });
    }
  }
  return out;
}

/** Backtick-quoted commit subjects a RESUME bullet cites, e.g. ``per today's `docs(state): …` ``. */
export function quotedSubjects(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim()).filter((s) => s.length > 0);
}

/**
 * #155, moved from prompt to output. For each RESUME bullet that cites a same-day commit subject,
 * flags when a NEWER same-day commit exists for the same unit — i.e. the bullet anchored on stale
 * work while fresher work sat in the very block handed to the model.
 *
 * ⚠ Matching is by SUBJECT EQUALITY against the DONE items, not fuzzy. A bullet that paraphrases
 * rather than quotes yields no match and is silently skipped: this check UNDER-reports by design.
 * Over-reporting here would mean accusing well-grounded prose of staleness, which is worse than
 * missing a paraphrase — and the paraphrase case is exactly what the judge is for.
 */
export function checkResumeFreshness(
  resume: readonly ResumeBullet[],
  done: readonly DoneItem[],
): PostFinding[] {
  const out: PostFinding[] = [];
  // Newest same-day item per unit label.
  const newestFor = new Map<string, DoneItem>();
  for (const d of done) {
    // ⚠ A NON-FINITE `whenMs` POISONS THE WHOLE UNIT, so it is skipped rather than compared.
    // `whenMs` is `new Date(a.timestamp ?? 0).getTime()` (core.ts), which is NaN whenever a
    // timestamp is present but unparseable. Every comparison against NaN is false, so a NaN item
    // arriving first would stay "newest" forever AND `cited.whenMs < NaN` would be false — silently
    // suppressing every freshness finding for that unit. A diagnostic that disables itself on bad
    // input is worse than one that skips the bad input, because the silence looks like a pass.
    if (!Number.isFinite(d.whenMs)) continue;
    const k = norm(d.label);
    const cur = newestFor.get(k);
    if (!cur || d.whenMs > cur.whenMs) newestFor.set(k, d);
  }
  for (const r of resume) {
    const newest = newestFor.get(norm(r.repo));
    if (!newest) continue;
    // ⚠ Take the NEWEST item the bullet cited, across ALL its quoted subjects. Two defects both
    // reduce to this, and both were live before:
    //  (a) `done.find(...)` returned the FIRST subject match, so two same-day commits sharing a
    //      subject ("wip", a retry, a recurring bot subject) made the verdict depend on array
    //      order — older-first flagged, newer-first did not. Reproduced.
    //  (b) flagging on the first stale quoted span meant a bullet saying "finished `old`, then
    //      landed `new`" was called stale while explicitly anchoring on the newest. Reproduced.
    // Comparing the bullet's newest citation against the unit's newest commit answers the question
    // actually being asked: did this bullet reach the front of the work, by any of its citations?
    // ⚠ Matches the FULL subject or its prompt-visible RENDERING. `buildDoneBlock` transforms
    // subjects before the model ever sees them (generator.ts), so a model faithfully quoting what it
    // was shown produces the transformed string — which never equals the full subject stored here,
    // and the check silently under-reported. Rare (1 of 1184 subjects in this repo exceeds the cap)
    // but free to close, and the asymmetry itself is the bug.
    const citedBy = (d: DoneItem, q: string) =>
      norm(d.subject) === norm(q) || norm(doneSubjectAsShown(d.subject)) === norm(q);
    // ⚠ THE SAME NON-FINITE GUARD AS `newestFor` ABOVE, and it is needed on BOTH sides. Guarding
    // only the newest-per-unit map left this reduce with the identical defect its own seed makes
    // worse: `!acc` accepts a NaN item unconditionally when it arrives first, every later
    // `d.whenMs > NaN` is false so it is never displaced, and `cited.whenMs < newest.whenMs` is then
    // `NaN < finite` — false. The unit's freshness finding is silently suppressed, which is exactly
    // the self-disabling failure the comment above rejects, and it is array-order-dependent, which
    // is defect (a) directly below returning by another route. Reproduced 2026-08-11.
    const cited = quotedSubjects(r.text)
      .flatMap((q) => done.filter((d) => Number.isFinite(d.whenMs) && norm(d.label) === norm(r.repo) && citedBy(d, q)))
      .reduce<DoneItem | undefined>((acc, d) => (!acc || d.whenMs > acc.whenMs ? d : acc), undefined);
    if (!cited) continue;                       // paraphrase, or quotes nothing we recognise
    if (cited.whenMs < newest.whenMs) {
      out.push({
        rule: "resume-stale",
        // "work", not "commit": todaySuppress also carries same-day MERGES as `Merged #N (branch)`
        // (core.ts), so `newest` is not necessarily a commit and naming it one would be a small
        // instance of the very class this row keeps recording — a field describing something
        // narrower than what it actually holds.
        detail: `[${r.repo}] RESUME anchors on "${clip(cited.subject)}" but NEWER same-day work exists: "${clip(newest.subject)}" (${Math.round((newest.whenMs - cited.whenMs) / 60000)} min later)`,
      });
    }
  }
  return out;
}

/** One unit's volume, as `checkSuggestionVolume` needs it. `commits` is NON-EXCLUDED commits — IN-WINDOW
 *  for the window legs (`Unit.windowCommits`), SAME-DAY for the same-day leg (`Unit.todayCommits`), both
 *  subprojects.ts — bot/auto commits do not count as the user's work on either side. */
export type UnitVolume = { label: string; commits: number };

/**
 * S3's SHARE FLOOR — a unit holding this fraction or more of the window's commits is asked for a
 * suggestion even when it is not the day's argmax. UNION with the argmax rule, never a replacement:
 * the argmax leg is untouched, so this can only ADD unit-days, never remove one.
 *
 * ⚠ WHY THE ARGMAX ALONE WAS NOT ENOUGH — day 46 (2026-08-31). OBSERVED, and not in dispute: the
 * counter emitted nothing while the audit judge called "no accountant_ai item in Suggested next at
 * all" the day's biggest gap. INFERRED, and explicitly NOT measured — EVAL.md's day-46 row carries
 * `UNVERIFIED: the exact windowCommits values the rule saw (not replayed)`: that the argmax went to
 * a unit which WAS named in a suggestion, leaving the runner-up invisible. Two readings of that day
 * disagree, and honesty about which is which matters more here than a tidy story: under the briefing's
 * own attributed recap bullets (10/6/1/1) the inferred mechanism holds and the old rule is silent;
 * under the only commit counts actually measured that day (8/8/6 across all local refs) the OLD rule
 * would have FIRED via the lexicographic tiebreak, so the silence would have had a different cause
 * this change does not address.
 * The STRUCTURAL claim survives either reading and is the one this leg rests on: an argmax is a RANK,
 * not a MAGNITUDE — on a two-horse morning the runner-up can be a third of the day's work and still
 * be invisible to a rule that only ever looks at one unit. The 16-briefing calibration below, not
 * day 46 alone, is what sets the floor.
 *
 * ⚠ THE CALIBRATION USED RECAP BULLETS AS A PROXY; THE CODE USES COMMITS. 16 archived briefings were
 * replayed offline (`scripts/probe-volume-share.ts`, committed so the table is reproducible), counting each unit's share of ATTRIBUTED RECAP BULLETS and
 * whether any suggestion named it — because a rendered `.md` is all an archived briefing has;
 * `windowCommits` is not recorded in it. The rule below scores over `windowCommits` instead, which is
 * the value it actually holds and the same value the argmax leg already ranks on. The two correlate
 * (a bullet is written per in-window commit — see `checks.ts` G1 coverage, which requires exactly
 * that) but they are NOT identical: `reduce` can drop activity detail before the model writes bullets
 * (core.ts's note at the call site), so a trimmed morning's bullet share understates a unit's commit
 * share. Read the table below as evidence that a ~0.30 floor separates real misses from noise, NOT as
 * a promise about how many commit-share unit-days will fire.
 *
 *   rule / threshold        flagged unit-days      note
 *   argmax only (before)    3 across 3 of 16 days  the status quo, preserved verbatim below
 *   share >= 0.30           4 across 4 of 16 days  the +1 is day 46's accountant_ai at 0.33 — the real miss
 *   share >= 0.25           6 across 5 of 16 days  the 2 extra are weaker; one is the `personal_code` catch-all
 *
 * 0.25 IS REJECTED, and the reason is the base rate: 24 of 50 unit-days across that corpus are
 * unsuggested. A low floor does not find more misses, it converts a targeted telemetry row into a
 * near-daily one, and one of its two extra catches is the umbrella `personal_code` unit — a catch-all
 * that legitimately gets no suggestion of its own. 0.34 / 0.40 / 0.50 all collapse back to the argmax
 * rule's 3 and would have missed day 46, which is the whole point of the change.
 */
export const VOLUME_SHARE_FLOOR = 0.30;

/** At most this many findings PER LEG — the window leg and the same-day leg (IN-4) are capped
 *  separately, so one `checkSuggestionVolume` call can return up to TWICE this (measured: 6 rows,
 *  a/b/c on each leg). Several units CAN qualify and each is a distinct fact worth
 *  its own row, but this is a stderr diagnostic on the delivery path, so the output stays bounded.
 *  Excess rows are dropped SILENTLY — there is no "capped" note. An unreachable string is an
 *  untested string on the delivery path, and at the current floor this cap provably never binds
 *  (below), so the note could only ever have been dead prose. The arithmetic test is the guard.
 *
 *  ⚠ IT CANNOT BIND AT THE CURRENT FLOOR, AND THAT IS ARITHMETIC, NOT LUCK — SAY IT RATHER THAN
 *  IMPLY IT. Shares sum to exactly 1, so at most ⌊1 / 0.30⌋ = 3 units can clear the floor, and the
 *  argmax is never a FOURTH qualifier because it holds the LARGEST share — whenever three others
 *  clear the floor it has already cleared it too. So `qualifying.length <= 3` always, the slice below
 *  is a no-op today, and no test can distinguish it from its absence. It is kept as the guard for the
 *  one edit that would make it live: lowering `VOLUME_SHARE_FLOOR` below 0.25 (four units at 0.25
 *  each is reachable). `test/postcheck.suggestion-volume.test.ts` pins that arithmetic explicitly, so
 *  a future floor change trips a loud test instead of silently unbounding a delivery-path log.
 *  The SAME-DAY leg (IN-4) is bounded by this same cap through the same helper, over the same share
 *  floor, so the same arithmetic holds for it — per leg, at most 3 rows; per call, at most 6. */
export const VOLUME_FINDING_CAP = 3;

/**
 * IN-4 — the SAME-DAY leg's MINIMUM-N FLOOR: the leg runs only when the day's eligible same-day commits
 * total at least this many. Below it a share is an artifact of the denominator, not a measurement —
 * one commit is share 1.000 BY CONSTRUCTION, and at 2 or 3 commits a single commit still clears
 * `VOLUME_SHARE_FLOOR` (1/3 = 0.333) and reads as "high-share".
 *
 * ⚠ CALIBRATED ON THE ARCHIVE, NOT PICKED — #406's method (`scripts/probe-volume-sameday.ts`, committed
 * so the table is reproducible). AS OF 2026-09-22 (archive through 2026-09-21, day 67): 35 archived
 * briefings replayed IN PLACE, none skipped by name; 34 reached the postcheck block (09-14 was a "(no
 * window activity)" early return, which runs none); 30 of those carried ≥ 1 same-day commit, 11 of them
 * ≤ 6 and two exactly 1. The calibration was first run as of day 64, when the archive's 2026-09-15 file
 * was a test fixture that had overwritten the real day-61 briefing, and was skipped; the author restored
 * the real briefing on 2026-09-21. It carries no "Today so far" block, and neither it nor days 65 and 67
 * moved a row (no briefing was archived for day 66, 2026-09-20): the 11 rows at the shipped floor and the table below are unchanged. The archive grows every
 * morning, so re-running the probe moves the counts. UNLIKE #406 THIS IS NOT A PROXY: "Today so far" is
 * code-rendered from the very list this leg counts (minus its `🔀 Merged` lines), so the archive carries
 * the rule's real inputs.
 *
 * ⚠ WHAT THE PROBE DOES AND DOES NOT CHECK. It REPRODUCES the table below and checks CONSISTENCY — that
 * the shipped leg emits exactly the sweep's model-only rows at whatever floor is compiled in. It does
 * NOT pin the calibration: it exits 0 at a floor of 3 or 5 as readily as at 4 (each agrees with itself),
 * and it is blind to how code-built lines are counted, to the cap and to the window argument (it passes
 * none). The VALUE 4 is pinned by `test/postcheck.suggestion-volume-sameday.test.ts` (b)/(c); the probe
 * is the evidence for choosing it, not a guard on it.
 *
 *   floor   rows (mornings)   what the step costs
 *     1       12 (12)         includes day 45's `personal_code` 1/1 — one autolog sync commit, share 1.000 by construction
 *    2-4      11 (11)         identical on the archive (its 2- and 3-commit mornings, days 36 and 40, report nothing)
 *    5-6       8  (8)         − days 39, 41, 46 — 41 and 46 are JUDGE-CONFIRMED misses at exactly 4
 *     7        7  (7)         − day 32
 *     8        6  (6)         − day 55 (quant_stocks 5/7; judge: "quant_stocks lane unserved")
 *     9        5  (5)         − day 64 (personal_code 3/8)
 *    10        4  (4)         − day 37 (accountant_ai 9/9)
 *    11        3  (3)         − DAY 48 ITSELF (accountant_ai 9/10) — the sighting this leg exists for
 *
 * Base rate, #406's own yardstick: 28 of 61 same-day unit-days have no model-written suggestion naming
 * the unit; the union at this floor reports 11 of them, on 11 of 34 postcheck mornings (as of 2026-09-22).
 *
 * ⚠ THE 5-6 STEP IS A DELIVERY-TIME EFFECT, disclosed rather than smoothed over: the three rows a floor of
 * 5 loses (days 39, 41, 46) are all LATE first-wake deliveries (10:10, 10:20, 12:38), where "Today so far"
 * holds whatever the morning had committed by then. On the on-schedule (before 08:00) mornings alone,
 * floors 2 through 6 emit the identical 8 rows. So the band's upper edge rests on late mornings — which
 * are real mornings the user reads, but a later delivery time mechanically means a larger same-day total.
 *
 * So the archive fixes a BAND, and both edges are evidence: the lower edge is the 1/1 artifact, the upper
 * edge is two judge-confirmed misses at a same-day total of exactly 4 (EVAL day 41: "zero suggestions
 * touch accountant_ai (20 of 24 in-window commits + all 4 same-day)"; day 46: "No accountant_ai item in
 * Suggested next at all", 3 of that morning's 4 same-day commits). WITHIN the band the archive cannot
 * choose — so 4 is taken for the arithmetic the floor exists for: it is the SMALLEST n at which one
 * commit cannot clear the share floor (1/4 = 0.25 < 0.30 ≤ 1/3). That rules out the 2- and 3-commit
 * shapes the archive happens not to contain, where every lone commit reads as a high-share unit.
 * `test/postcheck.suggestion-volume-sameday.test.ts` couples this to `VOLUME_SHARE_FLOOR` and
 * `VOLUME_FINDING_CAP` arithmetically: the one edit that makes the cap live (a share floor ≤ 0.25) also
 * breaks the lone-commit property at this n, and trips the same test.
 *
 * ⚠ RESIDUAL, stated: the ARGMAX leg can still name a one-commit unit on a FULLY fragmented morning (four
 * or more units at one commit each — the lexicographic tiebreak picks one), exactly as the window leg's
 * argmax does; its detail then says `criterion: argmax` and share 0.250 or less, so the row is honest.
 * The archive holds no such morning.
 *
 * ⚠ KNOWN MISSES — two classes, both measured on the archive, neither fixed here:
 *  (1) NAMED, BUT NOT FROM TODAY'S COMMITS — days 52 and 63. The matcher asks whether a model line NAMES
 *      the unit, not whether it draws on the unit's same-day work. Day 52: `accountant_ai` 4/5 was named
 *      by a line citing a WINDOW commit (5ab248c), none of that morning's four; day 63: `quant_stocks`
 *      6/11 by a line citing round-6 fixes (7154f06, d5723ad), not the rounds 7/8 committed that day.
 *      Both silent.
 *  (2) UNDER THE SHARE FLOOR, NOT THE ARGMAX, WITH A DENOMINATOR INFLATED BY AUTOMATION — day 62
 *      (EVAL.md, 2026-09-16), a JUDGE-FILED miss ("zero accountant_ai suggestions") this leg does NOT
 *      report: `accountant_ai` 7 of 24 same-day commits = 0.292, just under 0.30, with `quant_stocks`
 *      (12, named) the argmax. One of the 24 is the nightly autolog commit (`8b69dca`, "docs: nightly
 *      autolog status sync"); without it, 7/23 = 0.304 and the row fires. "Autolog-type" here means a
 *      subject matching `/autolog|STATE file updates/i` (the nightly status-sync commits). They are
 *      counted as the user's own work because the deployed `excludeCommitPatterns` does not match them
 *      (they render in "Today so far", which shows only non-excluded commits; the code default is
 *      `^vault backup:` alone), and one appears there on 21 of the 34 postcheck mornings as of
 *      2026-09-22 (20 of 34 under `/autolog/i` alone).
 *      Excluding them would flip exactly two decisions: day 62 `accountant_ai` would
 *      APPEAR and day 64 `personal_code` would DISAPPEAR (its 3 are two `ci(accountant_ai)` commits and
 *      an autolog sync) — 11 rows either way. WHETHER AUTOLOG SUBJECTS BELONG IN
 *      `excludeCommitPatterns` IS THE USER'S CONFIG DECISION; this leg deliberately counts exactly the
 *      population "Today so far" shows, and changes no exclusion.
 */
export const SAME_DAY_MIN_COMMITS = 4;

/** IN-4 — a CODE-BUILT suggestion line: S1's `(from resume)` promotion (`promoted`) or IN-10's stash line
 *  (`stash`). The same-day leg does NOT count these as mentions; the window legs still do (unchanged) —
 *  see "WHICH LINES COUNT" in `checkSuggestionVolume`'s docblock for the measurement. */
const isCodeBuilt = (s: Suggestion): boolean => s.promoted === true || s.stash !== undefined;

/**
 * S3 — the FORWARD-SUGGESTION FLOOR, measured. INFO-ONLY TELEMETRY, never a finding, never a gate.
 *
 * ⚠ MEASURED 3 MORNINGS (judge days 41, 43, 44): the highest-volume unit in the window repeatedly
 * received ZERO suggestions — day 44, 13 commits and not one forward step named for it. The prompt
 * now carries a rule saying it must get one (generator.ts, beside the existing suggestion rules), and
 * this is the OUTPUT-SIDE MEASUREMENT of that rule, for exactly the reason the header of this module
 * gives: a prompt-text assertion cannot tell "the model obeyed" from "the model ignored it". Every
 * future audit can now count S3 compliance instead of eyeballing it.
 *
 * ⚠ IT DELIBERATELY CANNOT DISTINGUISH "IGNORED THE RULE" FROM "THE RULE'S ESCAPE HATCH APPLIED".
 * The prompt rule says: write nothing rather than pad when the window supports no real next step. A
 * legitimately silent morning therefore fires this too. That is why it is `info: true` — it is a
 * counter to accumulate, not an accusation, and the same posture as `suggestion-restates-near`.
 *
 * ⚠ TWO LEGS, UNIONED — the ARGMAX (unchanged) and the SHARE FLOOR (`VOLUME_SHARE_FLOOR`, added
 * day 46; its docblock carries the measured table and why 0.25 was rejected). A unit is reported when
 * it is the argmax OR holds >= the floor's share of the window's commits, AND no suggestion names it.
 * The argmax leg is preserved verbatim rather than replaced by the floor, so this change is strictly
 * ADDITIVE and cannot regress: a FRAGMENTED morning — six units at 17% each — still reports its
 * argmax even though nothing clears 0.30, which is exactly the case a floor-only rule would lose.
 *
 * ⚠ SHARE IS OVER `windowCommits`, NOT OVER RECAP BULLETS. Denominator = the sum of the ELIGIBLE
 * units' commits, i.e. the same non-positive/non-finite filter the argmax leg already applies, so
 * both legs rank the same population. The calibration that chose 0.30 measured bullet share offline
 * because that is all an archived `.md` carries; see `VOLUME_SHARE_FLOOR` for that whole caveat.
 *
 * ⚠ ONE FINDING PER UNIT PER LEG, AT MOST `VOLUME_FINDING_CAP` PER LEG. Two units missing a suggestion
 * are two distinct facts, so they get two rows rather than one merged row — but a pathological morning
 * must not flood the log, so each leg's list is capped, silently (see `VOLUME_FINDING_CAP`: the cap
 * cannot bind at the current floor, so an explanatory note would be unreachable and therefore
 * untested). Since IN-4 there are two legs, so ONE UNIT CAN GET TWO ROWS — a window row and a
 * same-day row, under different rule ids — and one call can return up to 2 × the cap. Emission order is
 * deterministic: window rows first, then same-day rows; within a leg, commits descending, then the
 * same normalised-label tiebreak, which puts that leg's argmax first.
 *
 * ⚠ TIEBREAK, PINNED BY TEST: strictly-greater commit count wins; on an exact tie the
 * lexicographically smallest NORMALISED label wins. `units` arrives in `resolveUnits` accumulation
 * order (git activity order), which is not stable between runs, so a first-wins rule would make the
 * diagnostic flap on tied mornings — the same input-order dependence `checkResumeFreshness` had to
 * fix (defect (a) there).
 *
 * ⚠ NOT AN EVAL CHECK, AND IT MUST NOT BECOME ONE BY ACCIDENT. `checkSuggestionRestatement` is
 * imported by `src/eval/checks.ts` (g6Redundancy) BY NAME; `CHECKS` there is an explicit array, so a
 * new export here joins nothing on its own. This is delivery-path telemetry — promoting it would
 * change what an EVAL row's flag count means and is an eval-integrity decision for the operator.
 * Pinned by test: no G-check reports this rule id.
 *
 * ⚠ THE SAME-DAY LEG (IN-4) — `today`, a NEW INPUT, not a threshold tweak. Day 48 (EVAL.md): 9 of 10
 * same-day commits were `accountant_ai` and it got zero suggestions, while BOTH window legs stayed
 * correctly silent by their own definitions — argmax `quant_stocks` 36/40 was named, `accountant_ai` sat
 * at 2/40 = 0.050. The counter only ever saw the window, and no same-day count reached it at all. The
 * same union (argmax ∪ share >= `VOLUME_SHARE_FLOOR`, the same tiebreak, matcher and cap — one helper,
 * `volumeMisses`, never a copy) now also runs over each unit's `todayCommits`, as its own rule id
 * `suggestion-sameday-miss`, and ONLY on a morning whose same-day total reaches `SAME_DAY_MIN_COMMITS`
 * (calibrated there). Same posture: `info: true`, UNCONDITIONALLY — promoting it is the same operator
 * decision as for the window rows. It is the DIAGNOSTIC, not the fix: the model is still fed same-day
 * subjects only as suppress-context (`todaySuppress`), and whether to mine them for suggestions is a
 * separate item. This leg makes that gap countable, before and after.
 * Evidence: ONE clean sighting (day 48) plus one class-adjacent (day 52, "suggestions never mined from
 * same-day commits") — built on a STATED EXCEPTION to the two-sighting gate, not a cleared one.
 *
 * ⚠ WHICH LINES COUNT — MODEL-WRITTEN ONLY, ON THE SAME-DAY LEG (the window legs are unchanged and still
 * count both code-built channels). S3's rule asks for a suggestion drawn from the unit's own commits, and
 * this leg measures the SUGGESTION ENGINE: a code-built line is not the engine's output — IN-10's
 * `Pop or drop stash@{N}` is housekeeping carrying the catch-all label, and an S1 promotion is a RESUME
 * bullet's tail carried down. MEASURED both ways over the archive (`scripts/probe-volume-sameday.ts`;
 * stash lines simulated from real `git stash list` with IN-10's own `stashSuggestions`, since IN-10 is
 * not yet deployed): the 6 mornings carrying promotions move NO row either way; the stash line lands on
 * 9 mornings and, COUNTED, silences exactly one row — day 64's `personal_code` (3/8 = 0.375, argmax),
 * whose same-day commits are two `ci(accountant_ai)` fixes and an autolog sync, none of which the stash
 * line is about. Counted: 10 rows at the shipped floor; model-only: 11. The row says what it graded —
 * "no MODEL-WRITTEN suggestion", with the code-built lines it set aside counted — so it never claims the
 * page has no line naming the unit.
 * ⚠ THE EVIDENCE FOR THIS CHOICE IS THIN, AND THE RULE STANDS ON THE CONCEPT, NOT ON IT. The one row
 * model-only counting preserves — day 64's `personal_code` — is two `ci(accountant_ai)` commits and an
 * autolog sync under the catch-all label: the umbrella-unit class #406's calibration counted against a
 * lower floor ("a catch-all that legitimately gets no suggestion of its own" — `VOLUME_SHARE_FLOOR`),
 * and a row that also disappears if autolog commits are excluded (KNOWN MISSES
 * (2) at `SAME_DAY_MIN_COMMITS`). The archive therefore does not DEMONSTRATE the choice; the argument
 * for it is the one above — a code-built line is not the suggestion engine's output.
 *
 * ⚠ COMPARABILITY: A NEW SERIES, NOT A DISCONTINUITY. The declared Phase-C boundary (EVAL.md, IN-1 +
 * IN-2 + IN-3 + IN-10) discontinues "every S3 share keyed on `windowCommits`"; this leg is keyed on
 * `todayCommits` and is not among the four, so that clause does not cover it — nor does it need to:
 * `suggestion-sameday-miss` starts a series with no earlier baseline, and the window series is
 * unchanged (window rows byte-identical). The ONE existing EVAL reading it moves is the aggregate
 * `grep -c "postcheck-info"` count (row 34's reading, a mix of rules since day 46), which now also
 * counts same-day rows — read that count per rule id across this change.
 */
export function checkSuggestionVolume(
  suggestions: readonly Suggestion[],
  units: readonly UnitVolume[],
  today: readonly UnitVolume[] = [],
): PostFinding[] {
  // Both channels count on the WINDOW legs: a `promoted` suggestion is still a forward step the reader
  // sees under "Suggested next". ⚠ So does IN-10's stash line, whose `repo` is the stash repo's
  // catch-all label: `[personal_code] Pop or drop stash@{0}` counts as a suggestion "mentioning" that
  // unit there, and can silence an info-only `suggestion-volume-miss` row for it though it is
  // housekeeping, not a step drawn from the unit's own commits (review round 1, constructed case; no
  // logged row names a stash repo, so no historical row moves). The SAME-DAY leg below does not count
  // either channel — see "WHICH LINES COUNT" above. The `[repo]` fold is `volumeMisses`' "A PROMOTED
  // suggestion is the exception" note.
  const graded = (list: readonly Suggestion[]) => list.map((s) => norm(s.repo ? `[${s.repo}] ${s.text}` : s.text));
  const criterion = (c: VolumeMiss) =>
    [c.argmax ? "argmax" : null, c.share >= VOLUME_SHARE_FLOOR ? `share>=${VOLUME_SHARE_FLOOR.toFixed(2)}` : null].filter(Boolean).join("+");

  const win = volumeMisses(units, graded(suggestions));
  const out: PostFinding[] = win.misses.map((c) => ({
    rule: "suggestion-volume-miss" as const,
    info: true as const,                    // UNCONDITIONAL — see the docblock; promoting this is the operator's call
    detail: `${c.argmax ? "highest-volume" : "high-share"} unit [${c.unit.label}] (${c.unit.commits} window commit${c.unit.commits === 1 ? "" : "s"}, ${c.unit.commits}/${win.total} = share ${c.share.toFixed(3)}) got no suggestion mentioning it (${suggestions.length} suggestion(s) checked) — criterion: ${criterion(c)}`,
  }));

  // ── IN-4: THE SAME-DAY LEG. Model-written lines only; gated on the day's same-day total.
  const model = suggestions.filter((s) => !isCodeBuilt(s));
  const day = volumeMisses(today, graded(model));
  if (day.total < SAME_DAY_MIN_COMMITS) return out;       // ── THE MINIMUM-N FLOOR ── (0 when no same-day input)
  return [...out, ...day.misses.map((c) => ({
    rule: "suggestion-sameday-miss" as const,
    info: true as const,                    // UNCONDITIONAL — same operator decision as the window rows
    detail: `${c.argmax ? "highest-volume" : "high-share"} unit [${c.unit.label}] (${c.unit.commits} same-day commit${c.unit.commits === 1 ? "" : "s"}, ${c.unit.commits}/${day.total} = share ${c.share.toFixed(3)}) got no model-written suggestion mentioning it (${model.length} checked, ${suggestions.length - model.length} code-built not counted) — criterion: ${criterion(c)}, same-day total>=${SAME_DAY_MIN_COMMITS}`,
  }))];
}

/** One qualifying, unmentioned unit, as `volumeMisses` returns it. */
type VolumeMiss = { unit: UnitVolume; share: number; argmax: boolean };

/** THE UNION, ONE DEFINITION for every leg of S3 (window and same-day): eligible units, the argmax with
 *  its pinned tiebreak, share over the eligible total, the bounded label match against `graded` (already
 *  normalised suggestion strings), deterministic order, the cap. `total` is the eligible sum (0 when
 *  nothing is eligible) — the same-day leg gates on it. */
function volumeMisses(units: readonly UnitVolume[], graded: readonly string[]): { misses: VolumeMiss[]; total: number } {
  // ELIGIBLE = the population both legs rank over. A unit with no commits in this leg's window (the
  // git window, or today) has no floor to miss, and it must also stay OUT OF THE DENOMINATOR —
  // including it would deflate every real unit's share by an arbitrary number of quiet repos and make
  // the floor mean something different on a machine with more repos configured.
  const eligible = units.filter((u) => Number.isFinite(u.commits) && u.commits > 0);
  if (eligible.length === 0) return { misses: [], total: 0 };   // no units at all, or none with commits

  let top: UnitVolume | undefined;
  for (const u of eligible) {
    if (!top || u.commits > top.commits || (u.commits === top.commits && norm(u.label) < norm(top.label))) top = u;
  }
  const total = eligible.reduce((sum, u) => sum + u.commits, 0);   // > 0: every eligible count is > 0

  // "Mentions" is a WORD-BOUNDED match on the NORMALISED text.
  //
  // ⚠ WHY TEXT MATCHING AT ALL, stated honestly: a MODEL-AUTHORED suggestion carries only `text` —
  // it writes its own `[label]` inline and there is no parsed field to compare (contrast RESUME/RECAP
  // bullets, whose prefix `parseBriefing` splits out, letting every other unit-label join in this
  // codebase be an EQUALITY test). Text matching is FORCED there by the shape of the data.
  //
  // ⚠ A PROMOTED suggestion is the exception, since EVAL day 51: it carries `repo` as a real field
  // and render.ts brackets it, so the reader SEES `[quant_stocks] …` on a line whose `text` never
  // contains those characters. Grading the text alone would report "unit got no suggestion
  // mentioning it" about a suggestion visibly naming that unit — delivered text diverging from
  // graded text, which this codebase records as its most-repeated defect class. So the label is
  // folded back in (by the caller, `graded` in `checkSuggestionVolume`) for exactly the entries that
  // carry one.
  //
  // ⚠ AND IT MUST BE BOUNDED, NOT A BARE SUBSTRING. Short labels are common (`api`, `app`, `ai`,
  // `core` are all plausible sub-project basenames) and a bare `includes` silences this diagnostic on
  // unrelated prose — MEASURED: `api` ⊂ "do a rapid cleanup", `app` ⊂ "apply", `ai` ⊂ "explain",
  // `core` ⊂ "score". The failure direction is a FALSE NEGATIVE, i.e. the counter reads clean when it
  // is not, which is the invisible-decay class this whole module exists to avoid.
  //
  // `norm` still does the tolerance work — markdown, case, trailing punctuation — so `**app**`,
  // `` `app` `` and `App.` all still match. Metacharacters are escaped: labels are folder basenames
  // and `.`/`+` are legal in one, and unescaped `v1.2` would match `v1x2`.
  //
  // ⚠ BOUNDARIES ARE EXPLICIT LOOKAROUNDS, NOT `\b`, AND THE DIFFERENCE IS LOAD-BEARING FOR EXACTLY
  // THE LABELS THAT MOTIVATED THE ESCAPING. The boundary rule itself now lives in ONE place —
  // `labelBoundary` in ./subprojects, shared with audit's `coverageGaps`, which had diverged and was
  // still on the broken `\b` form until 2026-08-30. Its docblock carries the full reasoning; the
  // short version is that `\b` is a word/non-word TRANSITION, so at an edge where the label's own
  // character is already non-word it does not relax but INVERTS — `/\bc\+\+\b/` misses
  // "touch c++ bindings" AND matches "c++abc". (Not `v1.2`: its edges are `v` and `2`, both word
  // characters, so `\b` handles it fine — `v1.2` needs escaping, a separate problem this comment
  // previously conflated with boundaries.)
  //
  // ⚠ The classes are `\p{L}\p{N}_` and DO NOT match `contentTokens` above, which strips `_` as a
  // separator before splitting on `\p{L}\p{N}`. That difference is deliberate: `_` must count as a
  // word character here or `daily_briefing` would match inside `daily_briefing_application`. See
  // `labelBoundary`'s docblock for the measurement.
  /** True when SOME suggestion names this label. `key === ""` is DECLINED, not "unmentioned": a label
   *  that normalises away cannot be matched either way, so the unit is dropped rather than reported —
   *  the same posture the argmax-only version took, now applied per unit. (`labelBoundary` also
   *  returns a never-matching regex for an empty label, which would report a MISS here; that is the
   *  opposite answer, and the divergence is deliberate — see test/label-boundary.test.ts.) */
  const mentioned = (label: string): boolean | undefined => {
    const key = norm(label);
    if (key === "") return undefined;
    const bounded = labelBoundary(key);     // ONE definition, shared with audit's `coverageGaps`
    return graded.some((t) => bounded.test(t));
  };

  const cmp = (a: string, z: string) => (a < z ? -1 : a > z ? 1 : 0);
  const qualifying = eligible
    .map((u) => ({ unit: u, share: u.commits / total, argmax: u === top }))
    .filter((c) => c.argmax || c.share >= VOLUME_SHARE_FLOOR)     // ── THE UNION ──
    .filter((c) => mentioned(c.unit.label) === false)             // undefined (declined) is NOT a miss
    .sort((a, z) => z.unit.commits - a.unit.commits || cmp(norm(a.unit.label), norm(z.unit.label)));

  // The cap is a bounded-output guard, provably dead at the current floor: shares sum to 1, so at
  // most floor(1/0.30) = 3 units can clear it, and the argmax is never a FOURTH qualifier because it
  // holds the largest share. Kept anyway as the guard for the one edit that makes it live — a floor
  // at or below 0.25 admits four — and coupled to that floor by an arithmetic test. It carries NO
  // explanatory note: an unreachable string is an untested string on the delivery path, and the
  // arithmetic test is what actually protects the invariant.
  return { misses: qualifying.slice(0, VOLUME_FINDING_CAP), total };
}

/** The one place untrusted text enters a `detail` string — model suggestion/resume prose and git
 *  commit subjects — so it is where redaction has to happen rather than at the stderr sink alone.
 *
 *  ⚠ REDACT BEFORE CLIPPING, AND THE ORDER IS THE POINT. `redactCredentials` matches whole shapes
 *  (`ghp_` + >=20 alnum), so a token the clip cut in half no longer matches and the surviving prefix
 *  ships. Measured: a 90-char clip landing mid-token left `revoke ghp_Ab…` on stderr, which
 *  `matchesCredential` returns false for — a sink-side scan cannot recover what truncation already
 *  destroyed. Redacting first makes the clip operate on `[redacted]` instead. The pinned case in
 *  test/diag.credential-redaction.test.ts is the worse one: 16 characters of the secret survived.
 *
 *  This changes DIAGNOSTIC TEXT only. No rule, threshold, severity or finding COUNT moves, and the
 *  eval cases carry no credential-shaped strings, so every existing G6/G7 `detail` is byte-identical. */
const clip = (s: string, n = 90) => { const r = redactCredentials(s); return r.length <= n ? r : `${r.slice(0, n - 1)}…`; };
