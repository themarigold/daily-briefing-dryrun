// The SHARED label-mention boundary rule (`labelBoundary`) and its two consumers.
//
// This exists because the two consumers had DIVERGED and one was wrong: `coverageGaps` matched with
// `\b` while `checkSuggestionVolume` had been fixed to explicit lookarounds. Both feed
// reader-visible judgements — `coverageGaps` produces the COUNTED `UNCOMMITTED NOT SURFACED` audit
// flag — so the divergence was a correctness bug. These tests pin the rule itself AND that each
// consumer actually uses it, since a consumer silently reverting to a local `\b` is exactly how the
// split happened the first time.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { labelBoundary } from "../src/subprojects";
import { coverageGaps } from "../src/audit";
import { checkSuggestionVolume } from "../src/postcheck";

describe("labelBoundary — the boundary rule itself", () => {
  test("matches a whole-word occurrence and rejects a substring one", () => {
    expect(labelBoundary("api").test("the api layer")).toBe(true);
    expect(labelBoundary("api").test("do a rapid cleanup")).toBe(false);
    expect(labelBoundary("core").test("refactor score computation")).toBe(false);
    expect(labelBoundary("ai").test("explain the failure")).toBe(false);
  });

  // The whole reason `\b` is wrong. Each of these is a legal folder basename whose own FIRST or LAST
  // character is non-word. At such an edge `\b` does not relax — it INVERTS, demanding a word
  // character across the edge, so it misses the ordinary case here AND falsely matches glued text
  // (pinned in the next block). "Unsatisfiable" is the wrong word for it and was struck from this
  // file, `postcheck`'s and `subprojects`' comments after being measured false.
  //
  // ⚠ EDGED, not merely punctuation-CONTAINING: `v1.2` deliberately is NOT in this list. Its edges
  // are `v` and `2`, both word characters, so `\b` matches it perfectly well — escaping is what
  // `v1.2` needs (covered separately below), not boundaries. An earlier draft of this test asserted
  // `\b` failed on it and the assertion itself failed, which is how the distinction got drawn.
  test.each([
    ["c++", "touch c++ bindings"],
    ["f#", "the f# port"],
    [".config", "see .config for details"],
    ["-lib", "a -lib change"],
  ])("matches punctuation-edged label %p, which \\b cannot", (label, text) => {
    expect(labelBoundary(label).test(text)).toBe(true);
    // Demonstrate the defect being fixed, so this test explains itself if it ever fails:
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(new RegExp(`\\b${esc}\\b`).test(text)).toBe(false);
  });

  // ⚠ THE OTHER HALF OF THE \b DEFECT, AND THE MORE DANGEROUS ONE. `\b` at a punctuation edge does
  // not merely fail to match — it INVERTS, requiring a word character across that edge. So the old
  // form ALSO fired on text where the label is glued to a following word. For coverage that is a
  // false POSITIVE: a repo marked "named" by a string that is not the label at all, suppressing the
  // counted UNCOMMITTED NOT SURFACED flag. An earlier version of this file called `\b`
  // "unsatisfiable" at such edges, which is simply wrong, and only the negative half was pinned.
  test.each([
    ["c++", "c++abc"],
    [".config", "x.config"],
    ["-lib", "a x-lib change"],
    ["f#", "f#5 note"],
  ])("rejects glued text for punctuation-edged label %p, where \\b FALSELY matches", (label, text) => {
    expect(labelBoundary(label).test(text)).toBe(false);
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(new RegExp(`\\b${esc}\\b`).test(text)).toBe(true);   // the false positive, pinned
  });

  // ⚠⚠ THE `_` PIN. Dropping `_` from the boundary classes — a plausible "tidy this to match
  // contentTokens" edit — survived the ENTIRE suite before this test existed, and is not a no-op:
  // measured against 11 days of real production briefings it flips the coverage answer on 85 lines
  // across 7 of those 11 days. `daily_briefing` and `daily_briefing_application` are both live
  // labels in the author's own deployment, so a mention of the longer would mark the shorter covered.
  test("underscore is a WORD character: daily_briefing does not match inside daily_briefing_application", () => {
    expect(labelBoundary("daily_briefing").test("• [daily_briefing_application] shipped the legend")).toBe(false);
    expect(labelBoundary("daily_briefing").test("• [daily_briefing] shipped the legend")).toBe(true);
    // and the same at the leading edge
    expect(labelBoundary("briefing").test("the daily_briefing work")).toBe(false);
  });

  test("…and coverageGaps inherits that, so the longer label cannot cover the shorter repo", () => {
    const repos = [{ repo: "/w/daily_briefing", labels: ["daily_briefing"] }];
    const text = "☀️  Daily briefing — 2026-08-30  (this machine: t)\n\n   • [daily_briefing_application] shipped\n";
    expect(coverageGaps(repos, text)).toEqual(repos);   // still a gap — NOT covered
  });

  // A non-ASCII LETTER at the label's edge hits the same inversion as punctuation — `\b` is
  // ASCII-word-based, so `é` reads as a non-word character to it. Undocumented until 2026-08-30.
  test("a label with a non-ASCII letter at its edge matches, where \\b does not", () => {
    expect(labelBoundary("café").test("the café bar")).toBe(true);
    expect(new RegExp("\\bcafé\\b").test("the café bar")).toBe(false);
  });

  // An empty/whitespace label must never match. Without the guard the lookarounds around an empty
  // pattern are satisfiable almost anywhere, which would mark EVERY repo covered.
  test.each(["", "   ", "\t"])("an empty/whitespace label %p never matches", (label) => {
    expect(labelBoundary(label).test("any briefing text at all")).toBe(false);
  });

  // JS `\b` is ASCII-word-based EVEN under /u, so it fires inside non-Latin text. For coverage that
  // is a false POSITIVE (a repo counted as named when it was not).
  test("does not match inside non-Latin text, where \\b does", () => {
    expect(labelBoundary("api").test("обapiсь")).toBe(false);
    expect(new RegExp("\\bapi\\b", "u").test("обapiсь")).toBe(true);
  });

  test("still bites the left edge", () => {
    expect(labelBoundary("c++").test("abc++")).toBe(false);
    expect(labelBoundary("api").test("rapid")).toBe(false);
  });

  test("escapes metacharacters — v1.2 must not match v1x2", () => {
    expect(labelBoundary("v1.2").test("v1x2")).toBe(false);
    expect(labelBoundary("v1.2").test("v1.2")).toBe(true);
  });

  test.each(["***", "(((", "[", "\\", "$^", "(?<!x)"])("does not throw on adversarial label %p", (label) => {
    expect(() => labelBoundary(label).test("some text")).not.toThrow();
  });

  // not.toThrow() is the weaker property: without escaping, `(?<!x)` still compiles — it is
  // semantically hijacked, not a syntax error, so no mutation of the escaping is caught by the throw
  // assertion above. Assert the LITERAL-match property, which the escaping is actually for.
  test("an adversarial label is matched literally, not interpreted as a pattern", () => {
    expect(labelBoundary("(?<!x)").test("y")).toBe(false);
    expect(labelBoundary("(?<!x)").test("a (?<!x) b")).toBe(true);
    expect(labelBoundary("$^").test("anything")).toBe(false);
    expect(labelBoundary("$^").test("a $^ b")).toBe(true);
  });
});

describe("coverageGaps — uses the shared rule", () => {
  const brief = (body: string) => `☀️  Daily briefing — 2026-08-30  (this machine: t)\n\n${body}\n`;

  test("a punctuation-edged label IS found, so no gap is reported (\\b would invent one)", () => {
    const repos = [{ repo: "/w/c++", labels: ["c++"] }];
    expect(coverageGaps(repos, brief("   • [c++] landed the parser work"))).toEqual([]);
  });

  test("a genuinely unmentioned repo still reports a gap", () => {
    const repos = [{ repo: "/w/c++", labels: ["c++"] }];
    expect(coverageGaps(repos, brief("   • [other] unrelated"))).toEqual(repos);
  });

  test("a label appearing only inside a longer word does NOT clear the gap", () => {
    const repos = [{ repo: "/w/api", labels: ["api"] }];
    expect(coverageGaps(repos, brief("   • [other] do a rapid cleanup"))).toEqual(repos);
  });
});

describe("checkSuggestionVolume — uses the same shared rule", () => {
  const units = [{ label: "c++", commits: 9 }];

  test("a punctuation-edged label counts as mentioned", () => {
    expect(checkSuggestionVolume([{ text: "finish the c++ parser" }], units)).toEqual([]);
  });

  test("and is still missed when genuinely absent", () => {
    const out = checkSuggestionVolume([{ text: "unrelated work" }], units);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule).toBe("suggestion-volume-miss");
    expect(out[0]!.info).toBe(true);
  });
});

// Source pins: a consumer silently growing its OWN matcher again is the regression that created
// this file. Behaviour tests above cannot catch a second, redundant local copy that happens to
// agree today, so assert the shared import is what each site uses.
// ⚠⚠ TWO GENERATIONS OF SOURCE-TEXT PIN FAILED HERE BEFORE THIS ONE, AND THE LESSON IS THAT THE
// INVARIANT WAS WRONG, NOT THE REGEX. Both tried to assert "this file CALLS the shared function",
// which is not a property source text can carry:
//
//   gen 1: `toContain("labelBoundary")` — satisfied by the COMMENTS the same commit added, so
//          deleting the call kept it green. Its negative half, `not.toMatch(/\\b\$\{esc\}/)`, was
//          coupled to one variable NAME; renaming `esc` walked past it.
//   gen 2: `/labelBoundary\s*\(/` plus a per-file `new RegExp(` budget. Defeated FOUR ways by the
//          cold verifier: `RegExp(` without `new`; `new  RegExp(` with two spaces; trading an
//          unrelated regex for the budget slot; and — the one that survived the entire suite — a
//          hand-rolled boundary scan using NO regex at all, in a file whose comment mentioning
//          `labelBoundary(key)` satisfied the call-shaped scan.
//
// Duplication was never the actual risk. A local copy that AGREES is harmless; a copy that DRIFTS is
// the bug — and drift is behaviour, which behaviour can test. So the pin is now a CONFORMANCE
// CORPUS: every discriminating case is run through the shared rule AND through each consumer's real
// decision path, and they must agree. An inlined copy passes only by being correct, which is the
// whole requirement. This kills the surviving mutant, whose only sin was dropping `_`.
// ⚠ COMPLETENESS RULE FOR THIS CORPUS — read before adding or removing a row. A conformance corpus
// is only as strong as its discriminators, and the FIRST version of this array was measurably not
// strong enough: the cold verifier drifted two consumers through it undetected. Both gaps were the
// same shape — a boundary component that NO case decided on its own:
//
//   · every negative case was glued on BOTH sides, so the lookahead alone rejected all of them and
//     deleting the entire LOOKBEHIND conformed (mutant N — and on real data that is the mirror
//     image of the 85-line defect this change exists to prevent: `daily_briefing` covering
//     `daily_briefing_application` is the trailing edge, `briefing` covered by `daily_briefing` is
//     the leading one, in the counted-flag consumer);
//   · no text placed a DIGIT next to a label, so `\p{N}` was never a discriminator and dropping it
//     conformed (mutant M).
//
// So the rule is: for each member of the word class (`\p{L}`, `\p{N}`, `_`) × each side (behind,
// ahead), there must be at least one case where THAT is the SOLE reason the answer is what it is —
// glued on the side under test, free on the other. The six matrix rows below are labelled with the
// component they isolate; do not delete one without replacing its coverage.
const CONFORMANCE: { label: string; text: string; mentioned: boolean; why: string }[] = [
  // ── the 3 × 2 discriminator matrix ────────────────────────────────────────────────────────────
  { label: "daily_briefing", text: "shipped the daily_briefing_application legend", mentioned: false,
    why: "SOLE: `_` AHEAD — the longer label must not cover the shorter (85 real lines)" },
  // NB the label here is deliberately NOT `briefing`, which is the natural choice and is wrong: the
  // rendered header ("☀️  Daily briefing — …") contains that word, so the `coverageGaps` lane would
  // report "mentioned" via the header no matter what the matcher did — a case passing for a reason
  // unrelated to the property under test. Caught by this corpus's own coverageGaps lane.
  { label: "core", text: "resumed the daily_core work", mentioned: false,
    why: "SOLE: `_` BEHIND — the leading-edge mirror of the same defect" },
  { label: "c++", text: "the c++abc thing", mentioned: false,
    why: "SOLE: letter AHEAD — punctuation-edged, glued right (\\b falsely matches)" },
  { label: "c++", text: "the abc++ helper", mentioned: false,
    why: "SOLE: letter BEHIND — punctuation-edged, glued left" },
  { label: "api", text: "the api2 rollout", mentioned: false,
    why: "SOLE: digit AHEAD — `\\p{N}` must be in the class" },
  { label: "api", text: "the 2api rollout", mentioned: false,
    why: "SOLE: digit BEHIND — the symmetric half" },
  // ── positives: the rule must still MATCH, or an always-reject copy would conform ───────────────
  { label: "daily_briefing", text: "shipped the daily_briefing legend", mentioned: true,
    why: "the exact label still matches" },
  { label: "c++", text: "touch c++ bindings", mentioned: true, why: "punctuation-edged, free both sides (\\b misses)" },
  { label: "api", text: "the api layer", mentioned: true, why: "plain word match" },
  { label: "café", text: "the café bar", mentioned: true, why: "non-ASCII letter at the label's own edge (\\b misses)" },
  // (The empty-label guard is NOT a corpus row — the two consumers legitimately disagree there.
  //  See the dedicated test below the corpus for why, and where it is pinned instead.)
  // ── retained for their own sake: the original substring and non-Latin-neighbour defects ────────
  { label: "api", text: "do a rapid cleanup", mentioned: false, why: "substring must not count (glued both sides)" },
  { label: "api", text: "обapiсь today", mentioned: false, why: "non-Latin neighbours (\\b falsely matches)" },
];

describe("conformance: both consumers agree with the shared rule", () => {
  test.each(CONFORMANCE)("labelBoundary: $label vs $text → $mentioned ($why)", ({ label, text, mentioned }) => {
    expect(labelBoundary(label).test(text)).toBe(mentioned);
  });

  // checkSuggestionVolume reports a MISS when the top unit is not mentioned, so a finding is the
  // inverse of "mentioned". This is the path mutant J went through undetected.
  test.each(CONFORMANCE)("checkSuggestionVolume: $label vs $text → $mentioned ($why)", ({ label, text, mentioned }) => {
    const findings = checkSuggestionVolume([{ text }], [{ label, commits: 5 }]);
    expect(findings.length === 0).toBe(mentioned);
  });

  // coverageGaps reports a GAP when the repo is not named, so an empty gap list means "mentioned".
  test.each(CONFORMANCE)("coverageGaps: $label vs $text → $mentioned ($why)", ({ label, text, mentioned }) => {
    const repos = [{ repo: `/w/${label}`, labels: [label] }];
    const brief = `☀️  Daily briefing — 2026-08-30  (this machine: t)\n\n   • ${text}\n`;
    expect(coverageGaps(repos, brief).length === 0).toBe(mentioned);
  });
});

// The empty-label guard, pinned through the CONSUMER rather than only at the rule — without this, a
// `coverageGaps` copy correct in every other respect but omitting the guard conforms to the corpus
// (measured: it survived the full suite). It is deliberately NOT a corpus row, because the two
// consumers legitimately DISAGREE on an empty label and a three-lane row would assert they agree:
//   · `checkSuggestionVolume` guards `key === ""` itself and returns NO findings — "declined to
//     judge", which is not the same as "mentioned", though the corpus's lane shape would read it so;
//   · `coverageGaps` has no guard of its own, so the shared rule's guard is the only thing standing
//     between it and an always-matching label that marks EVERY repo covered, suppressing the counted
//     UNCOMMITTED NOT SURFACED flag wholesale.
// Reachable rather than theoretical: `basename("")` and `basename("/")` both yield `""`, and config
// validation accepts `roots: [""]` as a well-typed string.
describe("empty-label guard, through coverageGaps", () => {
  test.each(["", "   ", "\t"])("an empty/whitespace label %p reports a gap, never blanket coverage", (label) => {
    const repos = [{ repo: "/w/x", labels: [label] }];
    const brief = "☀️  Daily briefing — 2026-08-30  (this machine: t)\n\n   • some unrelated work\n";
    expect(coverageGaps(repos, brief)).toEqual(repos);
  });
});

// Retained as a cheap, identifier-agnostic tripwire for the ORIGINAL defect specifically — a `\b`
// interpolated against any variable. It is a supplement to the conformance corpus above, never the
// primary guard; the corpus is what actually holds. (`unresolvedFromBatch`'s /\bmissing\b/ is a
// fixed literal, not an interpolation, so it is correctly not matched.)
describe("tripwire: no \\b-interpolated label matcher in either consumer", () => {
  test.each(["src/audit.ts", "src/postcheck.ts"])("%s", (file) => {
    expect(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")).not.toMatch(/\\\\b\$\{/);
  });
});
