// test/day54-bare-demonstrative.test.ts — the day-54 leak in S1's anaphoric decline.
//
// #444 (day 51) declined promotions whose action carries an anaphor, because the promotion renders
// in SUGGESTIONS where the antecedent is not present. Day 54 was that path's first live exercise
// and it leaked: the briefing promoted "reviewing/committing those" — a demonstrative standing
// alone, its referent one section up — and the judge called the suggestion vacuous.
//
// The pattern declined `them`/`it` as BARE pronouns but `that/this/these/those` only as
// DETERMINERS — followed by any letter, `\s+\p{L}`. A trailing demonstrative is always pronominal,
// and was invisible.
//
// The fix is a SUBTRACTION: one alternative — every pronoun, bare — replacing two. It subsumes the
// old determiner branch, because a determiner use has whitespace after the demonstrative and
// whitespace is not a word character. An intermediate version kept both branches and added a third
// that EXCLUDED `that`, which codified the same leak one word over: "finish reviewing that" is
// ordinary grammatical English and anaphoric. `that` is in.
//
// A draft also added `./\-` to the lookarounds as an identifier/path guard. It was removed: it
// promoted "the audit--that check is still red" and "land it--the release ships Friday", both
// declined by day 51, and ZERO of the 24 archive actions have a pronoun adjacent to those
// characters — speculative machinery whose only measured effect was to reopen this very hole.
import { test, expect, describe } from "bun:test";
import { promoteResumeActions } from "../src/generator";
import type { BriefingStruct } from "../src/types";

const R = (text: string, repo = "/r1"): BriefingStruct["resume"][number] => ({ repo, text });
const S = (text: string) => ({ text });

// ⚠ The parameter order is (suggestions, resume) — a test in this area once passed with the two
// reversed, because both are arrays of {text} and both positive and negative cases then returned
// []. `promotedTexts` returns ONLY the promoted entries; every test BLOCK below that asserts a
// decline also makes at least one `allTexts` call naming the surviving model suggestion, so a
// reversed call — which yields [] for promotions and drops the model suggestion — cannot render a
// passing block. (Per block, not per assertion: an earlier draft claimed the stronger property and
// a reviewer showed 6 of 13 decline assertions lacked their own companion.)
const promotedTexts = (resumeText: string): string[] =>
  promoteResumeActions([S("add tests for reduce.ts")], [R(resumeText)])
    .filter((s) => s.promoted).map((s) => s.text);

const allTexts = (resumeText: string): string[] =>
  promoteResumeActions([S("add tests for reduce.ts")], [R(resumeText)]).map((s) => s.text);

describe("promoteResumeActions — a bare demonstrative is an anaphor too", () => {
  test("the day-54 leak: a trailing 'those' is declined", () => {
    // Verbatim shape from the 2026-09-08 briefing's vault bullet.
    const text = "Day53 project note update done (8f97eb2), but uncommitted sit in `.obsidian/workspace.json`, "
      + "`accountant_ai.md`, `ai_news.md` — resume by reviewing/committing those";
    expect(promotedTexts(text)).toEqual([]);
    // …and the model's own suggestion survives untouched, so this is a decline, not an empty run.
    expect(allTexts(text)).toEqual(["add tests for reduce.ts"]);
  });

  test("bare 'this' and 'these' are declined the same way", () => {
    expect(promotedTexts("Work paused mid-refactor. Resume: finish reviewing this")).toEqual([]);
    expect(promotedTexts("Three findings remain open. Resume: work through these")).toEqual([]);
    expect(allTexts("Work paused mid-refactor. Resume: finish reviewing this")).toEqual(["add tests for reduce.ts"]);
  });

  test("a TERMINAL bare 'that' is declined — the leak an earlier draft codified as intended", () => {
    // A draft of this change excluded `that` from the bare branch, reasoning that `that` is also a
    // relative pronoun. But the day-51 branch already declined `that` + any letter, so the only
    // strings the exclusion could reach were pronominal ones like this — and its test asserted
    // this very action SHOULD promote.
    expect(promotedTexts("Resume: finish the migration and then that")).toEqual([]);
    expect(allTexts("Resume: finish the migration and then that")).toEqual(["add tests for reduce.ts"]);
  });

  test("PRE-EXISTING and unchanged: a RELATIVE 'that' is declined", () => {
    // "that stalled" was already matched by day 51's `that\s+\p{L}`, so a self-contained action
    // carrying an ordinary relative clause is declined. Recorded so it is not rediscovered as new
    // damage from this change. The channel's asymmetry makes over-declining the tolerable
    // direction: a bad suggestion discredits the block, silence merely restores the status quo
    // with the source visible one section up.
    expect(promotedTexts("Resume: rerun the migration that stalled overnight")).toEqual([]);
    expect(allTexts("Resume: rerun the migration that stalled overnight")).toEqual(["add tests for reduce.ts"]);
  });

  test("an ASCII dash beside the anaphor does not rescue it — neither lookaround is widened", () => {
    // A draft guarded IDENTIFIER context on both sides. Each side silently promoted forms day 51
    // declined; "--" and " -" are ordinary plain-text dashes and the model writes this prose.
    // Under-declining is the direction this channel cannot afford.
    // Lookbehind side:
    expect(promotedTexts("Resume: finish the audit--that check is still red on main")).toEqual([]);
    expect(promotedTexts("Resume: triage the backlog -those two are the blockers")).toEqual([]);
    // Lookahead side — the same defect one pronoun over, a dangling `it`/`them` in SUGGESTIONS:
    expect(promotedTexts("Resume: rebase the branch and land it--the release ships Friday")).toEqual([]);
    expect(promotedTexts("Resume: finish the sweep and commit them--they are all one-liners")).toEqual([]);
    expect(allTexts("Resume: finish the audit--that check is still red on main"))
      .toEqual(["add tests for reduce.ts"]);
  });

  test("OVER-DECLINE 2 of 2: a pronoun glued to punctuation — the guard for it was removed", () => {
    // Day 51 promoted both of these. The guard that would have kept them cost two under-decline
    // classes and was exercised by zero archive actions, so it lost on its own terms. This is the
    // second of the two over-decline classes this change adds; whitespace is what separates it
    // from the WIDENING block below, where a spaced determiner before a backticked head is an
    // ordinary anaphor rather than a symbol.
    expect(promotedTexts("Resume: fix this.state mutation in the auth modal")).toEqual([]);
    expect(promotedTexts("Resume: rerun scripts/those/seed.sh against the scratch DB")).toEqual([]);
    expect(allTexts("Resume: fix this.state mutation in the auth modal"))
      .toEqual(["add tests for reduce.ts"]);
  });

  test("OVER-DECLINE 1 of 2: a complementiser `that` before a non-letter", () => {
    // Day 51 required a following LETTER, so it promoted these; dropping that requirement declines
    // them. Backticked identifiers after "that" are this codebase's house style, so the class is
    // real — accepted, not denied. It joins day 51's own documented complementiser over-decline
    // rather than being new in kind.
    expect(promotedTexts("Resume: confirming that `load_checkpoint` still writes before the cut")).toEqual([]);
    expect(promotedTexts("Resume: asserting that 3 of the 24 findings are closed upstream")).toEqual([]);
    expect(allTexts("Resume: asserting that 3 of the 24 findings are closed upstream"))
      .toEqual(["add tests for reduce.ts"]);
    // NOT in this class, though a draft claimed it was: day 51 already declined a hyphenated
    // identifier, via "this fixtures" on its own determiner branch. Pinned so the attribution is
    // not rediscovered as new damage.
    expect(promotedTexts("Resume: prune the test-this fixtures from the corpus")).toEqual([]);
  });

  test("a WIDENING, not an over-decline: determiner anaphors before a non-letter head", () => {
    // The same dropped letter-requirement catches ordinary determiner anaphors that day 51's
    // `\s+\p{L}` could not see, because the head noun is backticked or numeric. Day 51 promoted
    // all of these. Catching them is the fix working.
    expect(promotedTexts("Resume: commit those `.md` files in the vault")).toEqual([]);
    expect(promotedTexts("Resume: land those 3 fixes on the release branch")).toEqual([]);
    expect(promotedTexts("Resume: rerun these (the two failing ones) before the cut")).toEqual([]);
    expect(allTexts("Resume: commit those `.md` files in the vault"))
      .toEqual(["add tests for reduce.ts"]);
  });

  test("determiner anaphors still decline — the branch #444 shipped is untouched", () => {
    expect(promotedTexts("Resume: audit that check before shipping")).toEqual([]);
    expect(promotedTexts("Resume: land those fixes on the release branch")).toEqual([]);
    expect(promotedTexts("Resume: rerun them against the frozen corpus")).toEqual([]);
    // Named so a reversed-argument call, which returns [] for every case, cannot pass this.
    expect(allTexts("Resume: audit that check before shipping")).toEqual(["add tests for reduce.ts"]);
  });

  test("a self-contained action with no anaphor is still promoted", () => {
    const out = promotedTexts("Stopped after the schema change. Resume: rebuild the seed fixtures");
    expect(out).toEqual(["rebuild the seed fixtures"]);
  });

  test("a demonstrative inside a WORD does not trigger the decline", () => {
    // Word-internal only — identifier and path context has its own test above.
    expect(promotedTexts("Resume: prune the thistle fixtures from the corpus"))
      .toEqual(["prune the thistle fixtures from the corpus"]);
    expect(promotedTexts("Resume: rewrite the itemiser so the totals reconcile"))
      .toEqual(["rewrite the itemiser so the totals reconcile"]);
  });
});
