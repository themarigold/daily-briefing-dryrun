// test/day51-anaphoric-promotions.test.ts — EVAL day 51: S1's first live fire in 51 days shipped two
// broken suggestions. This pins the two defects it exposed.
//
// The fire: `promoteResumeActions` promoted "wiring that input into rule 2" from the bullet
// "[quant_stocks] P6's graduation gate refuses while rule 2 has no deflated-edge input. Resume by
// wiring that input into rule 2." — and rendered it with NO lane, while the model-authored
// suggestions beside it carried theirs. The capture is sentence-bounded (end-of-bullet slicing once
// promoted 2051 chars), so the referent of "that input" was left behind on the far side of the
// boundary. The audit judge independently called both promotions "verbatim resume text … zero added".
import { test, expect } from "bun:test";
import { promoteResumeActions } from "../src/generator";
import { checkSuggestionVolume } from "../src/postcheck";
import { renderBriefing } from "../src/render";
import type { BriefingStruct } from "../src/types";

const R = (text: string, repo = "/r1"): BriefingStruct["resume"][number] => ({ repo, text });

// ── Defect 1: anaphoric actions are declined ─────────────────────────────────────────────────────
test("the day-51 promotion is declined: its referent is on the far side of the sentence boundary", () => {
  expect(promoteResumeActions([], [
    R("[quant_stocks] Newest signed state: P6's graduation gate refuses while rule 2 has no deflated-edge input. Resume by wiring that input into rule 2.", "quant_stocks"),
  ])).toEqual([]);
});

test("every anaphor form measured in the archive is declined", () => {
  // VERBATIM archive actions — the cold review caught 4 of these paraphrased in the first draft, in
  // a project that cites its fixtures as measurements. Each is reproduced exactly as the extractor
  // yields it, so a narrowed detector fails here rather than silently shipping one again.
  const real: [string, string][] = [
    ["that + noun (the day-51 fire)", "wiring that input into rule 2"],
    ["that + noun (a check)", "watching the next publish run exercise that check"],
    ["that + noun (a stack)", "running the full suite over that stack and pushing `claude/account-failover`, which has no upstream tracking yet"],
    ["this + noun", "checking that this repair path interacts correctly with the failover/outage-reporting logic added in `4a5e18e` and `388a612`"],
    ["bare them", "updating/committing them to reflect the connect-bounds work that just closed"],
    ["bare them (S1's own motivating case)", "committing them or confirming they're meant to stay local"],
    // Verify round NEW-2: the bare-pronoun `that` form was pinned only by a synthetic complementiser,
    // so a narrowing that dropped it would have passed. These two are the real archive instances.
    ["bare that as pronoun (08-21)", "confirming that behaves correctly in the live routine"],
    ["bare that as pronoun (08-24)", "confirming that hardening plays well with quant_stocks' `eaa865c`, which touches the same `ai_news/curate.py` / `quant_stocks/live/run.py` files"],
    ["that + noun, head self-contained", "working the 24 findings down — that list is the open item, and the QBO write path it touches falls under the external-system-of-record guardrail (`sparse=true`, `SyncToken`, `RequestId` replay safety), so treat any outbound-write decision as a gate, not an autonomous call"],
  ];
  for (const [why, action] of real) {
    expect(promoteResumeActions([], [R(`Resume by ${action}.`)]), why).toEqual([]);
  }
});

test("self-contained actions still promote — the detector must not swallow the channel", () => {
  // The other side of the same replay, also verbatim. If these stopped promoting, S1 would be dead
  // rather than corrected.
  const real = [
    "writing the day 36 audit entry",
    "audit day-42 briefing next",
    "push enumeration pull toward full 10,047 series, then checkpoint",
    "checking STATE.md's three watches",
  ];
  for (const action of real) {
    expect(promoteResumeActions([], [R(`Resume by ${action}.`)]).length, action).toBe(1);
  }
});

test("anaphors this detector cannot see — one gap CLOSED on day 54, two still open", () => {
  // Cold review MEDIUM-4. The replay's promote side is NOT "the clean half" — it is "what this
  // detector promotes". These carry referents that resolve only in the preceding sentence and are
  // the SAME defect class as the day-51 fire, reached through a definite noun phrase or a bare
  // trailing pronoun rather than a demonstrative determiner. The first TWO still promote,
  // deliberately: widening to definite NPs ("the three", "the batch") would decline most
  // legitimate actions, and the archive gives no basis for a safe rule. Recorded as open gaps, not
  // as covered. The THIRD was closed on day 54 and is kept here inverted — see its own note below.
  // ⚠ The second case is the archive's ONE instance of locative `there`, which day 54's comment
  // lists as a known-unhandled surface WITH evidence: it now stands where `those` stood on day 53,
  // one day before that gap fired live.
  //
  // "deciding which of the three is canonical" — archive 2026-08-18, where "the three" is a third
  // reason_codes vocabulary named only in the prior sentence.
  expect(promoteResumeActions([], [R("A third `reason_codes` vocabulary appeared. Resume by deciding which of the three is canonical.")]).length).toBe(1);
  // ", then continue from there" — a trailing anaphor riding a self-contained head.
  expect(promoteResumeActions([], [R("Resume by confirming no remaining caller still expects `load_checkpoint` to write, then continue from there.")]).length).toBe(1);
  // CLOSED ON DAY 54 — this line used to assert `.length).toBe(1)`, i.e. that the case escaped.
  // The day-51 verify round called it LOW-1: the `that|this|these|those` clause requires a
  // FOLLOWING letter, so a sentence-final pronoun escapes. It was synthetic then, with no archive
  // instance. On day 54 the real thing arrived — the briefing promoted "reviewing/committing
  // those" — and the pattern became one bare-pronoun alternative, which declines this too. Kept
  // here, inverted, because a gap that took three days to fire is worth showing as closed rather
  // than deleting; the day-54 file pins the behaviour itself.
  expect(promoteResumeActions([], [R("Resume by fixing that.")]).length).toBe(0);
});

test("ACCEPTED OVER-DECLINE, pinned as documented behaviour", () => {
  // Measured: 3 of 23 archive actions are declined although their action HEAD is self-contained and
  // only a trailing clause carries the anaphor. Testing just the head (to the first comma or dash)
  // scores 8/8 with zero over-declines on that corpus — reproduced independently by the cold review
  // — and was REJECTED, for two reasons: head-only-but-ship-whole lets the dangling trailing clause
  // ship anyway, and head-only-plus-truncate violates this file's own no-truncation precedent. A
  // third option, widening the capture BACKWARDS to the preceding sentence, was weighed and dropped:
  // it is still verbatim, but it re-imports RESUME narration into the suggestion, and sentence
  // bounding exists precisely because slicing wider once promoted 2051 characters.
  expect(promoteResumeActions([], [
    R("Resume by confirming the interpreter setup still works, since the multi-root workspace file it shipped alongside was subsequently dropped."),
  ])).toEqual([]);
});

test("the detector does not distinguish a complementiser from a demonstrative — over-declines both", () => {
  // Cold review LOW-2: an earlier fixture label here implied discrimination the regex does not have.
  // "confirming that the suite passes" is a complementiser, not an anaphor, and is declined anyway.
  // Zero pure complementisers appear in the archive's 23 actions, but the "confirming/checking that"
  // idiom does (3 of 23, all independently anaphoric), so the base rate is real and this is a known
  // cost of the conservative rule rather than an unseen edge.
  expect(promoteResumeActions([], [R("Resume by confirming that the suite passes on main.")])).toEqual([]);
});

// ── Defect 2: the lane rides along ───────────────────────────────────────────────────────────────
test("a promotion carries its source unit, and renders bracketed like a recap bullet", () => {
  const out = promoteResumeActions([], [R("Resume by writing the day 36 audit entry.", "daily_briefing_application")]);
  expect(out[0]!.repo).toBe("daily_briefing_application");
  const rendered = renderBriefing({
    date: "2026-09-05", machineScope: "host", provider: "claude",
    resume: [], recap: [], suggestions: out,
  });
  expect(rendered).toContain("• [daily_briefing_application] writing the day 36 audit entry  (from resume)");
});

test("a model-authored suggestion is NOT bracketed by the renderer — it writes its own label", () => {
  // The day-51 block mixed both kinds. Model suggestions already contain "[lane] " inside their text;
  // bracketing them again would double it.
  const rendered = renderBriefing({
    date: "2026-09-05", machineScope: "host", provider: "claude",
    resume: [], recap: [], suggestions: [{ text: "[quant_stocks] Roll the ledger enforcement out" }],
  });
  expect(rendered).toContain("• [quant_stocks] Roll the ledger enforcement out");
  expect(rendered).not.toContain("[[");
  expect(rendered).not.toContain("(from resume)");
});

// ── Delivered text must equal graded text (cold review MEDIUM-3) ─────────────────────────────────
test("the volume counter sees the lane the reader sees on a promoted suggestion", () => {
  // Adding `repo` made render.ts print "[quant_stocks] …" on a line whose `text` never contains
  // those characters, while checkSuggestionVolume matched on `text` alone — so the diagnostic would
  // report "highest-volume unit [quant_stocks] got no suggestion mentioning it" about a suggestion
  // visibly naming quant_stocks. Delivered diverging from graded is this codebase's most-repeated
  // defect class, and it was introduced by this change, not inherited.
  const promoted = promoteResumeActions([], [R("Resume by writing the day 36 audit entry.", "quant_stocks")]);
  expect(promoted[0]!.repo).toBe("quant_stocks");
  // ⚠ ARGUMENT ORDER IS (suggestions, units). The first draft of this test had them reversed, which
  // made BOTH the positive and negative case return [] — a green that proved nothing. Guarded below
  // by asserting the pre-fix behaviour actually differs.
  expect(checkSuggestionVolume(promoted, [{ label: "quant_stocks", commits: 9 }])).toEqual([]);
  // And the guard: strip `repo` — the pre-day-51 shape — and the SAME input now reports a miss
  // against a suggestion the reader plainly sees labelled quant_stocks. Without this line the
  // assertion above could pass for a reason unrelated to the fold-in.
  const preFix = promoted.map(({ repo, ...rest }) => rest);
  expect(checkSuggestionVolume(preFix, [{ label: "quant_stocks", commits: 9 }]).length).toBe(1);
  // ⚠ EQUIVALENT MUTANT, recorded rather than papered over: folding the label in UNCONDITIONALLY
  // (dropping the `s.repo ?` guard) passes every test here. A model-authored suggestion would then
  // carry a literal "undefined" token into the normalised haystack, which cannot change a
  // word-bounded unit-label match for any realistic label — strictly, a unit whose label normalised
  // to "undefined" would be falsely matched, which is why this is "equivalent on realistic inputs"
  // rather than provably equivalent. No behavioural test catches it. The guard stays because the
  // haystack should not contain text no reader ever sees — same standard as the rest of this change.
});

test("a genuinely unmentioned unit is still reported — the fold-in must not blanket-silence", () => {
  const promoted = promoteResumeActions([], [R("Resume by writing the day 36 audit entry.", "quant_stocks")]);
  expect(checkSuggestionVolume(promoted, [{ label: "accountant_ai", commits: 9 }]).length).toBe(1);
});
