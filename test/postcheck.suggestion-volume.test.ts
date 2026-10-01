// test/postcheck.suggestion-volume.test.ts — S3, the FORWARD-SUGGESTION FLOOR measurement.
//
// Measured 3 mornings (judge days 41, 43, 44): the highest-volume unit repeatedly received ZERO
// suggestions — day 44, 13 commits and not one forward step named for it. The prompt now carries the
// rule; this diagnostic is the OUTPUT-SIDE measurement of it, INFO-only, gating nothing.
//
// Day 46 (2026-08-31) added the SHARE FLOOR leg: argmax-only was blind to a unit that is a third of
// the day and not the top one. See the "S3 SHARE FLOOR" block below for the measurement and for why
// the argmax leg is kept rather than replaced.
import { test, expect } from "bun:test";
import { checkSuggestionVolume, VOLUME_SHARE_FLOOR, VOLUME_FINDING_CAP, type PostFinding } from "../src/postcheck";
import { CHECKS } from "../src/eval/checks";
import { readFileSync } from "node:fs";

const S = (...texts: string[]) => texts.map((text) => ({ text }));

test("fires when the highest-volume unit has zero suggestions mentioning it", () => {
  const out = checkSuggestionVolume(
    S("open the PR for ai_news", "tidy the ai_news changelog"),
    [{ label: "accountant_ai", commits: 13 }, { label: "ai_news", commits: 2 }],
  );
  expect(out).toHaveLength(1);
  expect(out[0]!.rule).toBe("suggestion-volume-miss");
  expect(out[0]!.detail).toContain("[accountant_ai]");
  expect(out[0]!.detail).toContain("13 window commits");
});

test("does NOT fire when the highest-volume unit has a suggestion", () => {
  expect(checkSuggestionVolume(
    S("finish the accountant_ai reconciliation pass", "open the PR for ai_news"),
    [{ label: "accountant_ai", commits: 13 }, { label: "ai_news", commits: 2 }],
  )).toEqual([]);
});

test("mentions are matched through `norm` — markdown, case and trailing punctuation all count", () => {
  const units = [{ label: "accountant_ai", commits: 13 }];
  for (const s of ["Ship **accountant_ai** next", "Ship `accountant_ai`", "Ship Accountant_AI.", "[accountant_ai] ship it"]) {
    expect(checkSuggestionVolume(S(s), units)).toEqual([]);
  }
});

// ── M1: the match is WORD-BOUNDED. A bare substring silences the diagnostic on unrelated prose. ──
// Direction of the defect is a FALSE NEGATIVE — the counter reads clean when it is not — which is
// the invisible-decay class this module exists to catch. All four MEASURED against the bare
// `includes` implementation: each returned zero findings.
test("a short label inside an unrelated word does NOT count as a mention (M1)", () => {
  const cases: [string, string][] = [
    ["api", "do a rapid cleanup"],      // api  ⊂ r-API-d
    ["app", "apply the migration"],     // app  ⊂ APP-ly
    ["ai", "explain the failure"],      // ai   ⊂ expl-AI-n
    ["core", "improve the score"],      // core ⊂ s-CORE
  ];
  for (const [label, text] of cases) {
    const out = checkSuggestionVolume(S(text), [{ label, commits: 7 }]);
    expect(out).toHaveLength(1);                       // the miss is REPORTED, not swallowed
    expect(out[0]!.detail).toContain(`[${label}]`);
  }
});

test("the same short labels DO match when they appear as whole words (M1 — no over-correction)", () => {
  const cases: [string, string][] = [
    ["api", "document the api surface"],
    ["app", "ship the **app** rewrite"],
    ["ai", "revisit `ai` prompt tuning."],
    ["core", "[core] extract the metric"],
  ];
  for (const [label, text] of cases) {
    expect(checkSuggestionVolume(S(text), [{ label, commits: 7 }])).toEqual([]);
  }
});

test("regex metacharacters in a label are escaped, not interpreted (M1)", () => {
  // Labels are folder basenames; `.` and `+` are legal in one. Unescaped, `v1.2` would match `v1x2`.
  expect(checkSuggestionVolume(S("bump v1x2 deps"), [{ label: "v1.2", commits: 4 }])).toHaveLength(1);
  expect(checkSuggestionVolume(S("bump v1.2 deps"), [{ label: "v1.2", commits: 4 }])).toEqual([]);
});

test("a PUNCTUATION-EDGED label still matches — why boundaries are lookarounds, not `\\b` (M1)", () => {
  // ⚠ THIS TEST FAILED against the first `\b`-bounded implementation, which is why the boundaries
  // are explicit lookarounds. `\b` is a word/non-word TRANSITION, so at an edge where the LABEL's own
  // character is already non-word it does not relax — it INVERTS, demanding a word character across
  // that edge. `/\bc\+\+\b/` therefore misses "touch c++ bindings" AND falsely matches "c++abc":
  // two failure directions, not one. (An earlier version of this comment called it "unsatisfiable",
  // which is measurably false — see test/label-boundary.test.ts for both directions pinned.)
  expect(checkSuggestionVolume(S("touch c++ bindings"), [{ label: "c++", commits: 4 }])).toEqual([]);
  expect(checkSuggestionVolume(S("touch the rust bindings"), [{ label: "c++", commits: 4 }])).toHaveLength(1);
  // ...and the boundary still bites on the left: `c++` must not match inside `abc++x`.
  expect(checkSuggestionVolume(S("rename abc++ helper"), [{ label: "c++", commits: 4 }])).toHaveLength(1);
});

test("boundaries use Unicode classes — note they deliberately DIFFER from contentTokens on `_` (M1)", () => {
  // A non-Latin adjacent character must count as a word character, or a repo with non-Latin folder
  // names behaves differently here than everywhere else in this module.
  expect(checkSuggestionVolume(S("обapiсь cleanup"), [{ label: "api", commits: 4 }])).toHaveLength(1);
  expect(checkSuggestionVolume(S("почини api сегодня"), [{ label: "api", commits: 4 }])).toEqual([]);
});

test("a PROMOTED (code-built) suggestion counts as a mention — the reader still sees it", () => {
  // Contrast `checkSuggestionRestatement`, which SKIPS the promoted channel. Different question:
  // that rule grades model padding; this one asks whether the unit got a forward step at all.
  expect(checkSuggestionVolume(
    [{ text: "audit the accountant_ai day-42 briefing next", promoted: true as const }],
    [{ label: "accountant_ai", commits: 13 }],
  )).toEqual([]);
});

test("does NOT fire with no units, no commits, or only non-positive/non-finite counts", () => {
  expect(checkSuggestionVolume(S("do a thing"), [])).toEqual([]);
  expect(checkSuggestionVolume(S("do a thing"), [{ label: "app", commits: 0 }])).toEqual([]);
  expect(checkSuggestionVolume(S("do a thing"), [{ label: "app", commits: -1 }])).toEqual([]);
  expect(checkSuggestionVolume(S("do a thing"), [{ label: "app", commits: NaN }])).toEqual([]);
});

test("fires with an EMPTY suggestion list — zero suggestions is the day-44 shape exactly", () => {
  const out = checkSuggestionVolume([], [{ label: "accountant_ai", commits: 13 }]);
  expect(out).toHaveLength(1);
  expect(out[0]!.detail).toContain("0 suggestion(s) checked");
});

test("a label that normalises to empty is skipped rather than matching everything", () => {
  // `norm("***")` is "" and `"anything".includes("")` is TRUE — a silent never-fires. Guarded.
  expect(checkSuggestionVolume([], [{ label: "***", commits: 9 }])).toEqual([]);
});

// ── TIEBREAK — pinned, because `units` arrives in git-activity order, which is not stable ────────
test("TIEBREAK: on an exact commit-count tie the lexicographically smallest normalised label wins", () => {
  // ⚠ FILLERS ARE LOAD-BEARING, AND THE ORIGINAL TWO-UNIT FIXTURE IS WHY. It was `[zeta 5, alpha 5]`,
  // where each tied unit holds 5/10 = share 0.50 — so under the SHARE leg added on day 46 the loser
  // of the tiebreak qualifies on its own and "mentioning alpha silences the check" stopped being
  // true. That is the new leg working, not a tiebreak regression, and it is pinned in its own test
  // below. To keep THIS test about the ARGMAX tiebreak alone, the fillers push both tied units under
  // the floor: total = 5+5+3+3 = 16, so each tied unit is 5/16 = share 0.31 … which is ABOVE 0.30.
  // Hence 4 and 4: total = 5+5+4+4 = 18, tied share = 5/18 = 0.28 < 0.30, fillers 4/18 = 0.22.
  // Only the argmax leg can fire here, which is exactly what is under test.
  const tied = [{ label: "zeta", commits: 5 }, { label: "alpha", commits: 5 },
                { label: "mu", commits: 4 }, { label: "nu", commits: 4 }];
  const forward = checkSuggestionVolume(S("no unit named here"), tied);
  const reversed = checkSuggestionVolume(S("no unit named here"), [...tied].reverse());
  expect(forward).toHaveLength(1);                   // the argmax alone — nothing clears the floor
  expect(forward[0]!.detail).toContain("[alpha]");
  expect(forward[0]!.detail).not.toContain("share>=");
  expect(reversed).toEqual(forward);                 // input order must not change the verdict
  // And the tiebreak selects a REAL winner: mentioning `alpha` silences it, mentioning `zeta` does not.
  expect(checkSuggestionVolume(S("ship alpha"), tied)).toEqual([]);
  const missed = checkSuggestionVolume(S("ship zeta"), tied);
  expect(missed).toHaveLength(1);
  expect(missed[0]!.detail).toContain("[alpha]");    // zeta is named, so the reported miss is alpha's
});

test("UNION: the tiebreak LOSER is still reported when it clears the share floor on its own", () => {
  // The original two-unit tiebreak fixture, kept for the fact it now measures. `zeta` loses the
  // argmax tiebreak to `alpha`, but holds 5/10 = share 0.50 — half the window's commits with no
  // forward step named for it. Under the argmax-only rule this returned [] and the miss was invisible.
  const tied = [{ label: "zeta", commits: 5 }, { label: "alpha", commits: 5 }];
  const out = checkSuggestionVolume(S("ship alpha"), tied);
  expect(out).toHaveLength(1);
  expect(out[0]!.detail).toContain("[zeta]");
  expect(out[0]!.detail).toContain("share 0.500");   // exact, like its neighbours: 2dp accepts 0.500-0.509
  expect(out[0]!.detail).toContain("criterion: share>=0.30");   // NOT the argmax — alpha won that
  expect(out[0]!.detail).toContain("high-share unit");
});

// `Infinity` is the value the eligibility filter's `Number.isFinite` uniquely exists to catch, and
// it was the one ineligible value with no fixture: mapping over `units` instead of `eligible`
// survived the full suite until this case existed (it emits "Infinity/6 = share Infinity").
test("an Infinity commit count is excluded from BOTH the numerator and the denominator", () => {
  const out = checkSuggestionVolume(S("nothing named"), [{ label: "big", commits: 6 }, { label: "inf", commits: Infinity }]);
  expect(out).toHaveLength(1);
  expect(out[0]!.detail).toContain("[big]");
  expect(out[0]!.detail).toContain("6/6 = share 1.00");        // denominator is 6, not 6+Infinity
  expect(out.some((f) => f.detail.includes("[inf]"))).toBe(false);
});

test("a strictly higher count beats the lexicographic tiebreak", () => {
  const out = checkSuggestionVolume(S("nothing named"), [{ label: "zeta", commits: 9 }, { label: "alpha", commits: 5 }]);
  expect(out[0]!.detail).toContain("[zeta]");                  // 9/14 = 0.64, the argmax, emitted FIRST
  // ⚠ THE ASSERTION THAT ACTUALLY DISCRIMINATES. Both units now qualify via the share leg, and
  // emission is commits-descending, so `[zeta]` lands at out[0] whichever unit is the ARGMAX —
  // this test stopped pinning its own name until the criterion was asserted too. MEASURED: with
  // only the `[zeta]` check, argmax→min, reversed-tiebreak and `>`→`>=` mutants ALL pass this test.
  expect(out[0]!.detail).toContain("criterion: argmax");
  // ⚠ `alpha` is 5/14 = 0.36, above the floor and unsuggested, so the union reports it too — a second
  // row, not a changed first one. Ordering (commits descending) is what keeps the argmax at [0].
  expect(out).toHaveLength(2);
  expect(out[1]!.detail).toContain("[alpha]");
});

// ── S3 SHARE FLOOR (day 46) — the UNION leg ──────────────────────────────────────────────────────
//
// ⚠ THE DEFECT — day 46 (2026-08-31). OBSERVED: the counter said nothing while the audit judge
// called "no accountant_ai item in Suggested next at all" the day's biggest gap. INFERRED (the
// exact `windowCommits` were never replayed — EVAL.md day 46 carries this as `UNVERIFIED:`): the
// argmax went to a unit that WAS named in a suggestion, leaving the runner-up invisible. Under the
// one commit measurement actually taken that day (8/8/6 across all local refs) the OLD rule would
// have fired via the lexicographic tiebreak, so the silence would have had some other cause; under
// the briefing's own attributed-bullet counts (10/6/1/1) the inferred story holds. Either way the
// STRUCTURAL point stands and is what this leg fixes: an argmax is a RANK, not a MAGNITUDE.
//
// ⚠ THE FLOOR WAS CALIBRATED ON RECAP-BULLET SHARE, THE CODE SCORES COMMIT SHARE. 16 archived
// briefings replayed offline (`scripts/probe-volume-share.ts` — a rendered `.md` carries bullets,
// not `windowCommits`). REPRODUCED before this change:
//     argmax only    → 3 flagged unit-days across 3 of 16 days
//     share >= 0.30  → 4 across 4 days   (the +1 IS day 46's accountant_ai at 0.33)
//     share >= 0.25  → 6 across 5 days   (2 weaker extras; one is the `personal_code` catch-all)
//     24 of 50 unit-days are unsuggested overall, so a low floor drowns the signal, it does not
//     sharpen it — which is why 0.25 was rejected rather than merely not chosen.
// The fixtures below therefore state their MEASURED SHARES, and are chosen so that moving
// VOLUME_SHARE_FLOOR to 0.25 or to 0.40 fails a test rather than passing quietly.
test("UNION: a NON-argmax unit at the day-46 share is flagged; the argmax, being suggested, is not", () => {
  // Day 46's shape. quant_stocks 8/18 = 0.44 (argmax, SUGGESTED); accountant_ai 6/18 = 0.33 (the real
  // miss); daily_briefing_application 4/18 = 0.22 (below the floor, correctly silent).
  // ⚠ 0.33 is the KILLER for a 0.40 floor: it is above 0.30 and below 0.40, so raising the constant
  //   loses this finding and reinstates the day-46 defect verbatim.
  const units = [
    { label: "quant_stocks", commits: 8 },
    { label: "accountant_ai", commits: 6 },
    { label: "daily_briefing_application", commits: 4 },
  ];
  const out = checkSuggestionVolume(S("open the quant_stocks PR", "rerun the quant_stocks backtest"), units);
  expect(out).toHaveLength(1);
  expect(out[0]!.detail).toContain("[accountant_ai]");
  expect(out[0]!.detail).toContain("6/18 = share 0.333");
  expect(out[0]!.detail).toContain("criterion: share>=0.30");
  expect(out[0]!.detail).not.toContain("[quant_stocks]");            // suggested ⇒ never reported
  expect(out[0]!.detail).not.toContain("[daily_briefing_application]"); // 0.22 ⇒ below the floor
});

test("UNION: the ARGMAX is still flagged when its share is BELOW the floor — a FRAGMENTED day", () => {
  // ⚠ THIS IS THE CASE THE UNION EXISTS TO PRESERVE, and the one a floor-ONLY rule would lose.
  // alpha 4/16 = 0.25, four others at 3/16 = 0.19. NOTHING clears 0.30, so only the argmax leg can
  // fire — and it must, exactly as it did before day 46.
  const units = [
    { label: "alpha", commits: 4 }, { label: "bravo", commits: 3 }, { label: "charlie", commits: 3 },
    { label: "delta", commits: 3 }, { label: "echo", commits: 3 },
  ];
  const out = checkSuggestionVolume(S("unrelated work"), units);
  expect(out).toHaveLength(1);
  expect(out[0]!.detail).toContain("[alpha]");
  expect(out[0]!.detail).toContain("4/16 = share 0.250");
  expect(out[0]!.detail).toContain("highest-volume unit");
  // ⚠ KILLER for a 0.25 floor: at 0.25 the argmax ALSO clears the share leg, so the criterion string
  //   gains `+share>=0.25`. Asserting the criterion is argmax-ONLY pins the constant from below here
  //   as well as through the fixture below.
  expect(out[0]!.detail).toContain("criterion: argmax");
  expect(out[0]!.detail).not.toContain("share>=");
});

test("UNION: a non-argmax unit JUST BELOW the floor is NOT flagged (0.25 exactly)", () => {
  // ⚠ THE PRIMARY KILLER for lowering the floor to 0.25. big 15/20 = 0.75 (argmax, SUGGESTED);
  // mid 5/20 = share 0.25 EXACTLY — one hundredth under the floor's neighbourhood and deliberately
  // ON the rejected threshold, so a 0.30 → 0.25 edit turns this from [] into a finding.
  const units = [{ label: "big", commits: 15 }, { label: "mid", commits: 5 }];
  expect(checkSuggestionVolume(S("finish the big migration"), units)).toEqual([]);
  // ...and the same fixture with the argmax UNsuggested reports the argmax only, never `mid`.
  const out = checkSuggestionVolume(S("unrelated"), units);
  expect(out).toHaveLength(1);
  expect(out[0]!.detail).toContain("[big]");
});

test("UNION: the floor is inclusive — share EXACTLY 0.30 is flagged (>=, not >)", () => {
  // big 7/10 = 0.70 (argmax, SUGGESTED); mid 3/10 = 0.30 exactly. Pins the comparison direction; a
  // `>` would silently drop the boundary case the calibration table is stated at.
  const units = [{ label: "big", commits: 7 }, { label: "mid", commits: 3 }];
  const out = checkSuggestionVolume(S("finish the big migration"), units);
  expect(out).toHaveLength(1);
  expect(out[0]!.detail).toContain("[mid]");
  // ⚠ THREE decimals, deliberately. At two, an argmax-only row could print "share 0.30" while its
  // criterion said `argmax` alone — a line whose whole job is explaining why it fired, appearing to
  // contradict itself (reproduced: 299/299/201/201 → "299/1000 = share 0.30 … criterion: argmax").
  expect(out[0]!.detail).toContain("3/10 = share 0.300");
});

test("UNION: several qualifying units → ONE finding EACH, argmax first, deterministic order", () => {
  // Three units at 10/31 = 0.323 each (the quiet unit stays in the denominator, so this is NOT 1/3)
  // plus that quiet one. All three clear the floor; the largest is also
  // the argmax, so its criterion carries BOTH legs while the other two carry the share leg only.
  const units = [
    { label: "zulu", commits: 10 }, { label: "yankee", commits: 10 },
    { label: "xray", commits: 10 }, { label: "quiet", commits: 1 },
  ];
  const out = checkSuggestionVolume(S("nothing named here"), units);
  expect(out).toHaveLength(3);                                   // one per unit, not one merged row
  expect(out.map((f) => f.detail.match(/\[([^\]]+)\]/)![1])).toEqual(["xray", "yankee", "zulu"]);
  expect(out[0]!.detail).toContain("criterion: argmax+share>=0.30");   // tied 10s ⇒ lexicographic argmax
  expect(out[1]!.detail).toContain("criterion: share>=0.30");
  expect(out[2]!.detail).toContain("criterion: share>=0.30");
  expect(out.every((f) => !f.detail.includes("[quiet]"))).toBe(true);   // 1/31 = 0.03
  // Input order must not move the verdict — the same stability the tiebreak test asserts.
  expect(checkSuggestionVolume(S("nothing named here"), [...units].reverse())).toEqual(out);
});

test("UNION: a qualifying unit whose suggestion exists is dropped INDIVIDUALLY, not for the day", () => {
  const units = [{ label: "zulu", commits: 10 }, { label: "yankee", commits: 10 }, { label: "xray", commits: 10 }];
  const out = checkSuggestionVolume(S("ship yankee today"), units);
  expect(out.map((f) => f.detail.match(/\[([^\]]+)\]/)![1])).toEqual(["xray", "zulu"]);
});

test("CAP: bounded at VOLUME_FINDING_CAP, and at the current floor it is arithmetically UNREACHABLE", () => {
  // ⚠ READ THIS BEFORE "FIXING" THE CAP AS DEAD CODE. Shares sum to exactly 1, so at most
  // ⌊1 / VOLUME_SHARE_FLOOR⌋ units can clear the floor, and the argmax is never an EXTRA qualifier
  // because it holds the largest share — when three others clear the floor, it has too. At 0.30 that
  // ceiling is 3, which equals the cap, so `slice` can never truncate and NO behavioural test can
  // distinguish the cap from its absence (a `drop the cap` mutant SURVIVES by construction — stated
  // rather than hidden). The cap is the guard for the edit that WOULD make it live: a floor below
  // 0.25 admits four qualifiers. This assertion is what makes that edit loud.
  expect(VOLUME_FINDING_CAP).toBe(3);
  expect(Math.floor(1 / VOLUME_SHARE_FLOOR)).toBeLessThanOrEqual(VOLUME_FINDING_CAP);
  // The reachable ceiling, exercised: three qualifiers is the most the floor admits, and all three
  // are emitted. There is no "capped" note to look for — it was deleted precisely because the same
  // arithmetic makes it unreachable, and an unreachable string is an untested one.
  const three = checkSuggestionVolume(S("x"), [
    { label: "aa", commits: 1 }, { label: "bb", commits: 1 }, { label: "cc", commits: 1 },
  ]);
  expect(three).toHaveLength(3);
});

test("UNION: share is over WINDOW COMMITS, and only ELIGIBLE units are in the denominator", () => {
  // ⚠ A unit with 0 / negative / non-finite commits is excluded from the numerator AND the
  // denominator. If quiet repos joined the denominator, every real unit's share would shrink with
  // the number of repos configured and the floor would mean something different on each machine.
  // big 6, mid 4 ⇒ total 10, mid = 0.40 ⇒ flagged. The three junk units must not change that.
  const units = [
    { label: "big", commits: 6 }, { label: "mid", commits: 4 },
    { label: "zero", commits: 0 }, { label: "neg", commits: -5 }, { label: "nan", commits: NaN },
  ];
  const out = checkSuggestionVolume(S("finish the big migration"), units);
  expect(out).toHaveLength(1);
  expect(out[0]!.detail).toContain("[mid]");
  expect(out[0]!.detail).toContain("4/10 = share 0.400");   // denominator is 10, NOT 15 and NOT NaN
});

test("UNION: a single eligible unit is its own argmax at share 1.00 — both legs, one finding", () => {
  const out = checkSuggestionVolume(S("unrelated"), [{ label: "solo", commits: 3 }, { label: "quiet", commits: 0 }]);
  expect(out).toHaveLength(1);
  expect(out[0]!.detail).toContain("3/3 = share 1.00");
  expect(out[0]!.detail).toContain("criterion: argmax+share>=0.30");
});

test("UNION: a label that normalises to empty is declined PER UNIT, not for the whole day", () => {
  // The argmax-only rule returned [] for the whole check when the TOP label normalised away. Per unit
  // now: `***` is declined (it cannot be matched either way), while a real qualifying unit still
  // reports. `***` is 9/13 = 0.69 and would otherwise be the argmax.
  const out = checkSuggestionVolume(S("unrelated"), [{ label: "***", commits: 9 }, { label: "real", commits: 4 }]);
  expect(out).toHaveLength(1);
  expect(out[0]!.detail).toContain("[real]");
  expect(out[0]!.detail).toContain("4/13 = share 0.308");   // denominator still counts the declined unit
});

// ── INFO-ONLY, AND IT MUST STAY THAT WAY ─────────────────────────────────────────────────────────
test("every finding this rule can produce is info:true — it can NEVER be a counted defect", () => {
  const cases: PostFinding[][] = [
    checkSuggestionVolume([], [{ label: "a", commits: 1 }]),
    checkSuggestionVolume(S("unrelated"), [{ label: "a", commits: 13 }, { label: "b", commits: 1 }]),
    checkSuggestionVolume(S("x"), [{ label: "zeta", commits: 5 }, { label: "alpha", commits: 5 }]),
    // ⚠ THE SHARE LEG'S ROWS TOO — the union added a SECOND way to produce a finding, and a rule that
    // is info-only on one leg and countable on the other would move an EVAL flag count silently.
    checkSuggestionVolume(S("ship alpha"), [{ label: "zeta", commits: 5 }, { label: "alpha", commits: 5 }]),
    checkSuggestionVolume(S("nothing"), [{ label: "aa", commits: 1 }, { label: "bb", commits: 1 }, { label: "cc", commits: 1 }]),
    checkSuggestionVolume(S("open the quant_stocks PR"),
      [{ label: "quant_stocks", commits: 8 }, { label: "accountant_ai", commits: 6 }, { label: "dba", commits: 4 }]),
  ];
  const all = cases.flat();
  expect(all.length).toBeGreaterThan(0);
  // A non-info row is not merely absent from these samples — it is unconstructible: `info: true` is a
  // literal on the ONE object this function returns, with no branch that can omit or falsify it.
  expect(all.filter((f) => f.info !== true)).toEqual([]);
  for (const f of all) {
    expect(f.info).toBe(true);
    expect(f.rule).toBe("suggestion-volume-miss");
  }
  // The EVAL flag-count convention greps `postcheck [`; core.ts prefixes an info row `postcheck-info [`.
  expect(`${all[0]!.info ? "postcheck-info" : "postcheck"} [${all[0]!.rule}]`).toBe("postcheck-info [suggestion-volume-miss]");
});

test("…on EVERY input the sweep varies: window volume, 0-5 model-written and 0-2 code-built suggestions, 51-char labels", () => {
  // ⚠ WHAT THIS PROVES, AND WHAT IT DOES NOT (IN-4 review rounds 1-3). `PostFinding` makes this rule's
  // `info` the required literal `true`, so a non-literal is a `tsc` error UNLESS it is escaped: a CAST
  // (`info: (total <= 10) as true`), a NON-NULL ASSERTION (`info: (total <= 10 || undefined)!`) and an
  // `any`-typed value all compile. This sweep catches any of them ONLY if it is keyed on an input it VARIES — window volume (unit size and total, far past any
  // sample above: real windows run to 36 of 40 in one unit, day 48), the number of suggestions (0-5
  // model-written plus 0-2 code-built) and the label length (1 and 51 characters) — and NOTHING MORE: not
  // the number of units (at most 2 here), not labels with spaces or parentheses. Round 2's
  // `suggestions.length < 2` survived the whole suite before the suggestion-count axis was swept (4 of
  // the 7 archive-proxy window rows would have printed COUNTED).
  const LONG = "a_sub_project_label_well_past_forty_characters_long";                  // 51 chars
  const model = (k: number) => Array.from({ length: k }, (_, i) => ({ text: `unrelated step ${i}` }));
  const built = (j: number) => [
    { text: "carry on with the checkpoint", repo: "elsewhere", promoted: true as const },
    { text: "Pop or drop stash@{0}", repo: "elsewhere_too", stash: { branch: "main", ageDays: 3 } },
  ].slice(0, j);
  const rows: PostFinding[] = [];
  const reached = new Set<string>();                                          // (label length, k, j) combos that produced rows
  for (const n of [1, 2, 3, 5, 8, 10, 11, 13, 20, 36, 60, 120]) {
    for (const label of ["a", LONG]) {
      for (const w of [[{ label, commits: n }], [{ label, commits: n }, { label: "b", commits: 1 }],
                       [{ label, commits: n }, { label: "b", commits: n }]]) {
        for (let k = 0; k <= 5; k++) for (let j = 0; j <= 2; j++) {
          const s = [...model(k), ...built(j)];
          const two = checkSuggestionVolume(s, w);
          const three = checkSuggestionVolume(s, w, [{ label: "a", commits: 1 }]).filter((f) => f.rule === "suggestion-volume-miss");
          if (two.length && three.length) reached.add(`${label.length}:${k}+${j}`);
          rows.push(...two, ...three);
        }
      }
    }
  }
  const totals = rows.map((f) => Number(/\/(\d+) = share/.exec(f.detail)![1]));
  expect(Math.max(...totals)).toBeGreaterThanOrEqual(200);                        // not vacuous: heavy windows reached
  expect(reached.size).toBe(2 * 6 * 3);                                          // …every label × k × j, both call shapes
  expect(rows.filter((f) => f.detail.includes(`[${LONG}]`)).length).toBeGreaterThan(100);   // …long labels
  expect(rows.some((f) => f.detail.includes("criterion: share>="))).toBe(true);    // …on the share-only leg too
  expect(rows.filter((f) => f.info !== true || f.rule !== "suggestion-volume-miss").map((f) => f.detail)).toEqual([]);
});

test("NOT an eval check: no G-check reports this rule id, and CHECKS did not change scope", () => {
  // `src/eval/checks.ts` imports postcheck detectors BY NAME (g6/g7) and `CHECKS` is an explicit
  // array — a new export here joins nothing on its own. Pinned so the g6-style reuse cannot happen
  // silently: promoting this to a gate is an eval-integrity decision for the operator.
  expect(CHECKS.length).toBe(7);
  // ⚠ IF YOU ARE HERE BECAUSE THIS COUNT FAILED: this assertion guards SCOPE, not the number. It
  // exists so that adding the S3 diagnostic to the eval harness cannot happen as a side effect. If
  // you have DELIBERATELY added a legitimate 8th G-check, bump this to 8 — but first confirm the new
  // check is not `checkSuggestionVolume` reaching the harness by another route (the two `not`
  // assertions below are the real guard; this one just makes an accidental addition loud).
  const src = readFileSync(`${import.meta.dir}/../src/eval/checks.ts`, "utf8");
  expect(src).not.toContain("checkSuggestionVolume");
  expect(src).not.toContain("suggestion-volume-miss");
});

test("wiring: the S3 diagnostic is still CALLED from runCore's postcheck block (M2)", async () => {
  // MEASURED as surviving: deleting the `checkSuggestionVolume(...)` line from core.ts left the whole
  // suite green — every other test in this file exercises the detector directly, so nothing observed
  // the call site. This is the repo's wiring-pin idiom (test/audit.test.ts's "wiring:" tests).
  const src = await Bun.file(new URL("../src/core.ts", import.meta.url)).text();
  expect(src).toMatch(/\.\.\.checkSuggestionVolume\(struct\.suggestions, units\.map\(/);
  expect(src).toMatch(/import \{[^}]*checkSuggestionVolume[^}]*\} from "\.\/postcheck"/);
  // ...and it must sit INSIDE the postcheck block, i.e. above the health-JSON write — the same
  // downstream anchor test/core.drift-propagation.test.ts uses for this file's ordering constraints.
  const call = src.indexOf("checkSuggestionVolume(struct.suggestions");
  const downstream = src.indexOf("T4.9: the health-JSON WRITE call site");
  expect(call).toBeGreaterThan(-1);
  expect(downstream).toBeGreaterThan(call);
});
