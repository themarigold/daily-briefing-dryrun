// test/generator.suggestion-filter.test.ts — Task 8's post-parse infra-path suggestion filter:
// generateBriefing must strip any SUGGESTIONS bullet referencing .claude/worktrees/ (Claude Code's
// own agent scratch dir) while leaving normal suggestions untouched.
import { test, expect } from "bun:test";
import { generateBriefing } from "../src/generator";
import type { ReducedContext, Provider } from "../src/types";

const ctx: ReducedContext = { repos: [] };

test("generateBriefing strips a SUGGESTIONS bullet that references .claude/worktrees/", async () => {
  const stub: Provider = {
    generate: async () =>
      [
        "## RESUME",
        "- [/r1] resume",
        "## RECAP",
        "- [/r1] did work | evidence: a1b2c3",
        "## SUGGESTIONS",
        "- review uncommitted .claude/worktrees/x",
        "- open the PR for feature/auth",
      ].join("\n"),
  };
  const b = await generateBriefing(ctx, stub, { date: "2026-07-13", machineScope: "host", provider: "claude" }, []);
  expect(b.suggestions.some((s) => s.text.includes(".claude/worktrees/"))).toBe(false);
  expect(b.suggestions.some((s) => s.text.includes("open the PR for feature/auth"))).toBe(true);
  expect(b.suggestions.length).toBe(1);
});

test("generateBriefing leaves suggestions untouched when none reference an infra path", async () => {
  const stub: Provider = {
    generate: async () =>
      [
        "## RESUME",
        "- [/r1] resume",
        "## RECAP",
        "- [/r1] did work | evidence: a1b2c3",
        "## SUGGESTIONS",
        "- open the PR for feature/auth",
        "- add tests for the new module",
      ].join("\n"),
  };
  const b = await generateBriefing(ctx, stub, { date: "2026-07-13", machineScope: "host", provider: "claude" }, []);
  expect(b.suggestions.length).toBe(2);
  expect(b.suggestions[0]!.text).toContain("open the PR for feature/auth");
  expect(b.suggestions[1]!.text).toContain("add tests for the new module");
});

// ── Already-merged-PR guard (EVAL day 36) ─────────────────────────────────────────────────────────
// The merge channel and the suggestion generator do not read each other, so the model can recommend
// acting on #N while the same document renders "🔀 Merged #N". Both the pure predicate AND the
// generateBriefing call site are pinned — the account-failover review proved an extracted function's
// tests alone let the call site regress invisibly (restoring the original bug kept the suite green).
import { dropMergedPrSuggestions, buildPrompt } from "../src/generator";
import type { Unit } from "../src/subprojects";

test("dropMergedPrSuggestions drops a suggestion citing a merged PR and reports the number", () => {
  const r = dropMergedPrSuggestions(
    [{ text: "merge #297 once CI is green" }, { text: "add tests for reduce.ts" }],
    [{ text: "🔀 Merged #297 (feat/x) (abc1234)" }],
  );
  expect(r.kept.map((s) => s.text)).toEqual(["add tests for reduce.ts"]);
  expect(r.droppedPrs).toEqual(["297"]);
});

test("dropMergedPrSuggestions keeps everything when no merge lines exist", () => {
  const suggestions = [{ text: "merge #297 once CI is green" }];
  const r = dropMergedPrSuggestions(suggestions, []);
  expect(r.kept).toEqual(suggestions);
  expect(r.droppedPrs).toEqual([]);
});

test("dropMergedPrSuggestions keeps a suggestion citing a NON-merged number", () => {
  const r = dropMergedPrSuggestions(
    [{ text: "follow up on #123" }],
    [{ text: "🔀 Merged #297 (feat/x) (abc1234)" }],
  );
  expect(r.kept.length).toBe(1);
  expect(r.droppedPrs).toEqual([]);
});

test("dropMergedPrSuggestions does not treat a bare '#297' in a non-merge line as merged", () => {
  const r = dropMergedPrSuggestions(
    [{ text: "merge #297 once CI is green" }],
    [{ text: "worked on #297 review comments" }],   // no 🔀 Merged marker → not a merge line
  );
  expect(r.kept.length).toBe(1);
});

const mergedPrStub = (suggestions: string[]): Provider => ({
  generate: async () =>
    [
      "## RESUME",
      "- [/r1] resume",
      "## RECAP",
      "- [/r1] did work | evidence: a1b2c3",
      "## SUGGESTIONS",
      ...suggestions.map((s) => `- ${s}`),
    ].join("\n"),
});

test("generateBriefing drops a suggestion naming a PR merged in the same-day `today` channel, and WARNS", async () => {
  const b = await generateBriefing(ctx, mergedPrStub(["merge #297 once CI is green", "add tests for reduce.ts"]), {
    date: "2026-08-25", machineScope: "host", provider: "claude",
    today: [{ repo: "r1", text: "🔀 Merged #297 (feat/x) (abc1234)" }],
  }, []);
  expect(b.suggestions.map((s) => s.text)).toEqual(["add tests for reduce.ts"]);
  expect((b.warnings ?? []).some((w) => w.includes("already-merged PR") && w.includes("#297"))).toBe(true);
});

test("generateBriefing also reads the window-foot `windowMerges` channel", async () => {
  const b = await generateBriefing(ctx, mergedPrStub(["review and merge #310"]), {
    date: "2026-08-25", machineScope: "host", provider: "claude",
    windowMerges: [{ repo: "r1", text: "🔀 Merged #310 (fix/y) (Aug 24)  (def5678)" }],
  }, []);
  expect(b.suggestions.length).toBe(0);
  expect((b.warnings ?? []).some((w) => w.includes("#310"))).toBe(true);
});

test("generateBriefing adds NO warning and drops nothing when no suggestion names a merged PR", async () => {
  const b = await generateBriefing(ctx, mergedPrStub(["add tests for reduce.ts"]), {
    date: "2026-08-25", machineScope: "host", provider: "claude",
    today: [{ repo: "r1", text: "🔀 Merged #297 (feat/x) (abc1234)" }],
  }, []);
  expect(b.suggestions.length).toBe(1);
  expect((b.warnings ?? []).some((w) => w.includes("already-merged"))).toBe(false);
});

// ── Negative-claim scoping (EVAL day 36) — prompt-side rule ──────────────────────────────────────
// "nothing pending here" was verified over one thread and generalised to a whole repo. The rule is
// prompt text, so the pin is presence + the load-bearing phrases (the exact prose may be tuned).
test("buildPrompt carries the negative-claim scoping rule", () => {
  const p = buildPrompt({ repos: [] }, []);
  expect(p).toContain("NEGATIVE claim");
  expect(p).toContain("never generalise from one thread or file to the whole repo");
});

// ── Status markers (EVAL day 48) — prompt-side rule ──────────────────────────────────────────────
// Two failures in the 2026-09-02 briefing, argued here to be one defect:
//   • a stash whose text read "autolog STATE.md — not mine, parked for relay start" was rendered
//     into RESUME as "sits parked … — no action needed there";
//   • a commit whose subject read "mechanically shut until campaign 2 opens" produced the morning's
//     only suggestion: "that's the concrete blocker to lift" — against a deliberate quant seal whose
//     opening condition is an operator ruling plus a 2026-10-01 expiry, not a code fix.
// Both are the model overriding an explicit status marker in its own input. (EVAL.md's day-48 row
// files them as two separate items; "one defect, two faces" is this change's synthesis, not that
// row's finding.)
//
// Neither existing prompt rule reaches them, and both claims were checked rather than assumed:
//   • the negative-claim rule (pinned directly above) bans unscoped negatives "about a whole repo or
//     unit"; day 48's "no action needed there" was item-scoped, and that rule in fact BLESSES the
//     string "no action needed from this window's commits";
//   • the self-contradiction rule ("Do not contradict yourself between sections") needs RESUME and
//     SUGGESTIONS to disagree about the SAME item; day 48's two faces were different items. That
//     rule is from EVAL day 15 — `git log -S` → 4575577630, 2026-07-25. (An earlier draft of this
//     comment called it day 25 by reading the calendar date as a day number; EVAL day 25 is
//     2026-08-10 and unrelated.)
//
// WHAT THESE TESTS ARE WORTH. They assert presence plus load-bearing phrases, so they detect EDITS
// to the rule, not behaviour regressions. Nothing in this suite can execute the model, so a genuine
// behavioural test would be an LLM eval under src/eval/, which is guardrailed. These pin wiring; the
// behaviour is unverified by construction, and no test here should be read as proving the model
// obeys. The change also ships with no deterministic backstop on the RENDERED briefing — the
// postcheck.ts pattern this file uses for the day-36 defect — because a new counted postcheck rule
// moves the EVAL flag-count metric and needs explicit direction. That is a known gap, not an
// oversight.
//
// ⚠ MEASURED INTERACTION, accepted rather than fixed. A suggestion ABOUT a marker item — today the
// imperative arm's output, historically the statement mandate — can trip postcheck's COUNTED `suggestion-restates` rule
// (RESTATEMENT_THRESHOLD 0.45, MIN_SHARED_TOKENS 4). Measured with the repo's own contentTokens /
// containment over these two exact strings:
//   RESUME "[quant_stocks] run_phase_b.py's N7 driver (fc0b775) stays mechanically shut until campaign 2 opens"
//   SUGG   "campaign 2 opening is what unblocks the N7 driver in run_phase_b.py"
//   → containment 0.667, shared 4 — both gates cleared, so it FIRES.
// The score is wording-dependent — an independent check of five natural satisfier phrasings spanned
// 0.400/2 to 0.700/7, though against the day-48 STASH bullet rather than the seal bullet quoted
// above, so treat that spread as corroboration of the range and not as a second measurement of this
// pair. Read the whole thing as "the collision is real and reachable", not as a fixed number.
// LIVE CONFIRMATION, days 49-50: the flag fired both gated mornings (0.71/10, 0.75/9) on the
// satisfier suggestion. (The statement-form example pair above is HISTORICAL — the current rule
// forbids that output on every branch — but the mechanism it demonstrates is unchanged.)
// The day-50 imperative refinement was measured against the flag before shipping and does NOT clear
// it — the cost is entity-token overlap, not sentence form, so it is permanent for actionable-marker
// mornings and priced in. Default-silence mornings avoid it too — with one caveat: a morning where
// silence leaves SUGGESTIONS empty writes the S9 escape line, which is statement-shaped; its overlap
// with any single RESUME bullet sits under MIN_SHARED_TOKENS for the cases measured, but it is a
// possible firing surface, not a guaranteed-quiet one (final verify NEW-3).
// Measured over these exact strings, against this RESUME bullet:
//   RESUME "[personal_code] STATE.md synced across accountant_ai/daily_briefing_application/quant_stocks in 5bb1f0d; today's autolog refreshed two STATE blocks — that part done. Separate stash on branch refactor/one-tenant-definition (\"autolog STATE.md\") — not mine, parked for relay start, still blocked till relay starts."
//   "[personal_code] Start the relay to unpark the stash on refactor/one-tenant-definition."     → 0.889 / 8  FIRES
//   "[personal_code] Start the relay run; the parked autolog stash clears with it."              → 0.778 / 7  FIRES
//   "[personal_code] Relay start is what unblocks the parked stash on refactor/one-tenant-definition." → 0.900 / 9  FIRES (the day-50 statement form)
// (thresholds 0.45 / 4) A gated morning can therefore carry one extra counted flag. Exempting
// satisfier-shaped suggestions in postcheck would be an eval-metric change and is NOT made here.
//
// ⚠ KNOWN LIMITS OF THE DISCRIMINATOR, disclosed rather than papered over. Keying on a NAMED
// satisfier misfires in both directions on this repo's own subjects:
//   • missed marker — 94add5b9e3 "PHASE B LOCK RATIFIED — cell-collapse binding, C3 selected,
//     delta_econ frozen" is the same quant seal as the motivating case but names no satisfier, so it
//     reads as ordinary work and an "unfreeze delta_econ" suggestion stays licensed;
//   • false catch — f8bdc68116 "chore(b2a): frozen verify script for the relay run" matches the
//     shape while describing an immutable artifact, not a gate.
// (All three SHAs checked to exist with those subjects; the counts above are this session's own
// measurement, not a figure carried over from review.)
// This is inherent to a prompt-side discriminator; it is still strictly better than the five-phrase
// keyword list it replaced, which matched three phrases that have never occurred in 2205 subjects.
//
// Clause-to-test mapping, MEASURED by deleting each of the rule's TEN sentences in turn (each
// deletion diff-confirmed applied; no survivors) — re-measured 2026-09-04 for the third time, after
// the review-driven rewrite that made silence the default. T1-T6 are the six tests below in file
// order:
//   S1 marker + satisfier + examples    → T1, T5, T6
//   S2 illustrative + non-markers       → T5
//   S3 clearing line + date-not-order   → T2
//   S4 RESUME prohibition               → T3
//   S5 ban + doing-the-satisfier clause → T4
//   S6 imperative arm (narrow)          → T4
//   S7 both precedence clauses          → T4
//   S8 default silence + true rationale → T4
//   S9 empty-SUGGESTIONS escape line    → T4
//   S10 gate, not defect                → T4
// So this is NOT one-clause-per-test: six clauses land on T4, two on T5, and S1 trips three tests
// because each quotes some part of it. The two PLACEMENT mutants were run separately and are
// described on T6 — fallback arm kills T6 alone, Tier-1 arm kills all six.

test("buildPrompt carries the status-marker rule", () => {
  const p = buildPrompt({ repos: [] }, []);
  expect(p).toContain("STATUS MARKER");
  expect(p).toContain("TOGETHER WITH what would satisfy it");
});

test("the status-marker rule yields to a clearing line, and reads order by DATE not position", () => {
  const p = buildPrompt({ repos: [] }, []);
  // Two separate defects live here. Without the exception at all, the rule asserts the clearing
  // event is never in the data — false, and it collides with the prompt's own "the NEWEST is the
  // current state of that file" rule (cold review's HIGH 1). With the exception but phrased as "a
  // LATER line", it points the wrong way: git.ts collects commits with --date-order and nothing
  // re-sorts them, so the clearing commit renders ABOVE the marker and a literal reading finds no
  // later line — the original failure, restored (verify round's NEW-1). Both halves are pinned.
  expect(p).toContain("Treat the condition as still holding unless ANOTHER line shows it met");
  expect(p).toContain("judge that by the DATE on each line, never by position");
  expect(p).toContain("commits are listed NEWEST FIRST");
  // Known limit, fails safe: only COMMIT lines carry a date — activityLine renders stash, branch and
  // uncommitted entries as "- (kind) text" with none, and day 48's own marker was a dateless stash.
  // With no date the model cannot find a clearing line and defaults to "still holding", which is the
  // conservative side; the scenario this clause exists for (HIGH 1) is commit-vs-commit.
});

test("the status-marker rule forbids RESUME asserting a state the marker contradicts", () => {
  const p = buildPrompt({ repos: [] }, []);
  expect(p).toContain("RESUME must not assert a state the marker contradicts");
  expect(p).toContain("name the trigger instead");
});

test("the status-marker rule: silence is the DEFAULT, the imperative is the narrow exception", () => {
  const p = buildPrompt({ repos: [] }, []);
  // EVAL day 50 (two-sighted, user-approved): the first shipped form mandated the satisfier as a
  // STATEMENT. Two judge passes called it a non-action and the counted suggestion-restates flag fired
  // both gated mornings (0.71/10, 0.75/9). The first REWRITE of this rule then keyed its silence
  // branch on nouns (DATE/RULING/REVIEW) that the day-48 seal's RENDERED text never contains —
  // "mechanically shut until campaign 2 opens" is an event; the ruling and expiry live in a commit
  // body the model never sees — and its branch order made the imperative arm reachable first, so the
  // rule could MANDATE "Open campaign 2": day 48's defect with rule backing (cold review HIGH-1).
  // The fix inverts the design: classify from the marker's VISIBLE text only, default to silence.
  //
  // The ban now names the disguise explicitly — doing the satisfier of a hold IS lifting the gate:
  expect(p).toContain("unblocking THE CONDITION ITSELF");
  expect(p).toContain("DOING the satisfier is that same proposal in different words");
  expect(p).toContain(`"Open campaign 2" lifts the gate as surely as "remove the gate" does`);
  // The imperative arm is scoped to what the model can actually test — the marker's own words:
  expect(p).toContain("ONLY when the marker's own text names a step the operator could take right now");
  expect(p).toContain("nothing in it defers that step to a date, event, ruling, or review");
  // Tie-break (final verify NEW-1): "shut until the relay starts" fits the hold list AND the arm;
  // undeclared precedence was MEDIUM-4's class in a narrower slot. The ban wins, fail-safe.
  expect(p).toContain("if a marker seems to fit BOTH this arm and the hold list above, the ban wins");
  expect(p).toContain(`never the statement form "relay start is what unblocks it"`);
  expect(p).toContain(`not the repetition forbidden by "A suggestion must NOT restate a RESUME bullet" BELOW`);
  expect(p).toContain(`it outranks "Prefer fewer, real suggestions"`);
  // Silence is the default and covers the middle cases the first rewrite left undefined (third-party
  // waits, ambiguity) — cold review MEDIUM-4:
  expect(p).toContain("In EVERY other case");
  expect(p).toContain("or you cannot tell which");
  expect(p).toContain("write NO suggestion for the marker");
  // The safety rationale is now a TRUE claim. The first rewrite said "the RESUME line above already
  // names the gate", but S4 is a conditional prohibition, not a mandate — a commit-borne marker in a
  // clean repo produces NO resume line at all (the unit fails hasResumptionState, and the backfill
  // keys on the same flag). What IS guaranteed is the marker's own line: RECAP mandates one bullet
  // per commit, and stash/branch state renders deterministically (cold review MEDIUM-3).
  expect(p).toContain("the briefing already carries the gate on the marker's own line");
  expect(p).toContain("(its RECAP bullet, or the stash/branch line in RESUME)");
  // And the collision with "Write at least one." on a deferred-gate-only morning is resolved inside
  // the rule rather than left for the model to arbitrate (cold review MEDIUM-5):
  expect(p).toContain(`"Nothing actionable now — <X> is the next unblock"`);
  expect(p).toContain("names the wait without proposing to end it");
  expect(p).toContain("a gate someone set deliberately, not a defect to clear");
});

test("the status-marker rule keys on a named satisfier, not on a closed keyword list", () => {
  const p = buildPrompt({ repos: [] }, []);
  // The first draft enumerated five phrases and said nothing about openness. Measured against this
  // repo's own history — `git log --all --format=%s`, 2259 subjects — "blocked on" and "waiting on"
  // had NEVER occurred, and "parked for" occurs exactly once as the day-48 STASH's own message
  // (8733a94c4f), never as a commit subject; meanwhile "frozen" (7), "deferred" (5) and "WIP" (9)
  // did occur and were absent from the list. So it was reverse-engineered from one incident. Worse,
  // bare
  // "pending" matched real non-marker subjects (8530b7da69, "refuse a foreign pending backlog"),
  // which would have suppressed genuine next steps (cold review's MEDIUM 3 and 4). The fix is the
  // discriminator, not a longer list, so the discriminator and the two counterexamples carry the
  // weight here; the examples are pinned only as examples.
  expect(p).toContain("Those are examples, not the whole list");
  expect(p).toContain("what makes a marker is the NAMED satisfier");
  expect(p).toContain(`"drain the pending backlog" or "unblock the parser" is ordinary work and not a marker`);
  for (const m of ["shut until <X> opens", "blocked on <X>", "frozen until <X>", "deferred to <X>", "parked for <X>"]) {
    expect(p).toContain(`"${m}"`);
  }
});

test("the status-marker rule survives BOTH RESUME-section shapes", () => {
  // PLACEMENT is a failure mode no phrase pin above can see, but only in ONE direction, and an
  // earlier version of this comment described the other one and was wrong about it. Precisely:
  // buildPrompt builds resumeSection from two arms (src/generator.ts) — a Tier-1 arm and a fallback.
  // Every pin above calls buildPrompt({repos:[]},[]), which takes the FALLBACK arm. So a rule
  // misplaced into the TIER-1 arm would already fail T1–T5 loudly; the silent failure is the
  // opposite one — a rule misplaced into the FALLBACK arm keeps every empty-context pin green and
  // vanishes on any morning that HAS a Tier-1 unit, which is most mornings. That is the mutant this
  // test exists for, and running it kills this test alone.
  const empty = buildPrompt({ repos: [] }, []);
  // NOTE: `resumptionNote` never reaches buildPrompt (orderResumeByRank reads it). It is required by
  // the Unit type, set to a realistic value for readability, and NOT exercised here.
  const units: Unit[] = [{
    repo: "/r", root: null, label: "myrepo", hasResumptionState: true, hasWindowContent: true,
    resumptionNote: "stash: parked for relay start", dirtyFiles: [], latestCommitTime: null,
  }];
  const withResume = buildPrompt(
    { repos: [{ repo: "/r", summary: "s", activities: [{ source: "git", kind: "commit", event_id: "e1", repo: "/r", text: "did a thing" }] }] },
    units,
  );
  // Guard the guard: assert the two prompts really took different arms, so this test cannot pass by
  // building the same string twice.
  expect(withResume).toContain("Write one RESUME bullet per unit");
  expect(empty).not.toContain("Write one RESUME bullet per unit");
  for (const p of [empty, withResume]) expect(p).toContain("STATUS MARKER");
});
