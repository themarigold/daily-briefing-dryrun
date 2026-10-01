// test/day49-recap-coverage.test.ts — EVAL day 49: the recap count could not report what it dropped.
//
// The briefing rendered "▶ What you did — 44 commits" over a 45-commit window. That number was
// `recap.length`, the count of bullets the model wrote, so it agreed with the render and not with
// the world — and structurally always would: a total derived from what was shown cannot report what
// was not. The dropped commit added `.github/workflows/quant-stocks-ci.yml`, and a same-day commit
// then said that suite was not portable off the operator's machine.
//
// `recapCoverage` does NOT try to stop the model dropping bullets (a prompt instruction cannot fix a
// claim that gets dropped — the day-21 `branchState` reasoning). It makes the drop visible.
import { test, expect } from "bun:test";
import { recapCoverage, NOT_SHOWN_CAP } from "../src/generator";
import { renderBriefing } from "../src/render";
import { evidenceTokens, bareToken, shaPrefixMatch } from "../src/sha";
import type { ReducedContext, BriefingStruct, Activity } from "../src/types";
import { coverageGaps } from "../src/audit";
import { NOT_SHOWN_PREFIX, type Unit } from "../src/subprojects";

const commit = (sha: string, file: string, subject: string): Activity => ({
  source: "git", kind: "commit", event_id: sha, repo: "/r", text: subject,
  meta: { diffstat: [{ file, added: 1, removed: 0 }] },
});
const ctxOf = (...acts: Activity[]): ReducedContext => ({ repos: [{ repo: "/r", summary: "s", activities: acts }] });
const unit = (root: string | null, label: string): Unit => ({
  repo: "/r", root, label, hasResumptionState: false, hasWindowContent: true,
  resumptionNote: "", dirtyFiles: [], latestCommitTime: null,
});
const UNITS = [unit("quant_stocks", "quant_stocks"), unit("accountant_ai", "accountant_ai"), unit(null, "personal_code")];
const bullet = (text: string, evidence?: string) => ({ repo: "personal_code", text, evidence });

// ── The property that keeps a complete morning unchanged ─────────────────────────────────────────
test("coverage is ABSENT when every in-window commit is accounted for", () => {
  const ctx = ctxOf(commit("aaa1111", "accountant_ai/a.py", "one"), commit("bbb2222", "accountant_ai/b.py", "two"));
  const recap = [bullet("did one", "aaa1111"), bullet("did two", "bbb2222")];
  // Absent, not a zero record: the renderer's whole block is inert and the header is byte-identical
  // to the pre-day-49 output. This is the branchState/labelLegend contract.
  expect(recapCoverage(recap, ctx, UNITS)).toBeUndefined();
});

test("an empty window yields no coverage record at all", () => {
  expect(recapCoverage([], { repos: [] }, UNITS)).toBeUndefined();
});

// ── The day-49 shape ─────────────────────────────────────────────────────────────────────────────
test("the day-49 shape: the dropped minority-lane commit is reported, by UNIT label", () => {
  const ctx = ctxOf(
    commit("aaa1111", "accountant_ai/agent/loop.py", "M8 checkpoint"),
    commit("45acfe1", ".github/workflows/quant-stocks-ci.yml", "correct three stale STATE.md claims + add the missing CI"),
  );
  const cov = recapCoverage([bullet("M8 checkpoint", "aaa1111")], ctx, UNITS)!;
  expect(cov.shown).toBe(1);   // in-window commits COVERED, not bullets
  expect(cov.total).toBe(2);   // in-window commits TOTAL
  expect(cov.notShown).toHaveLength(1);
  expect(cov.notShown[0]!.sha).toBe("45acfe1");
  expect(cov.notShown[0]!.subject).toContain("add the missing CI");
});

test("both numbers are COMMIT counts, so bullets that cite two commits cannot skew them", () => {
  // The first draft used `shown: recap.length` and `total: recap.length + missing.length` — a bullet
  // count and a mixed sum. On this exact input it rendered "1 of 2" against a THREE-commit window.
  // Cold review MEDIUM-2, and this file had already ruled the same way once for clusterRecap's
  // `nCommits`: a code-built line must never make a wrong numeric claim from bullet counts.
  const ctx = ctxOf(
    commit("aaa1111", "accountant_ai/a.py", "one"),
    commit("bbb2222", "accountant_ai/b.py", "two"),
    commit("ccc3333", "quant_stocks/c.py", "three"),
  );
  const cov = recapCoverage([bullet("did both", "aaa1111, bbb2222")], ctx, UNITS)!;
  expect(cov.shown).toBe(2);              // two commits covered by one bullet
  expect(cov.total).toBe(3);              // the real window
  expect(cov.notShown.map((n) => n.sha)).toEqual(["ccc3333"]);
});

test("two bullets citing the SAME commit do not inflate the count", () => {
  const ctx = ctxOf(commit("aaa1111", "accountant_ai/a.py", "one"), commit("bbb2222", "quant_stocks/b.py", "two"));
  const cov = recapCoverage([bullet("said it", "aaa1111"), bullet("said it again", "aaa1111")], ctx, UNITS)!;
  expect(cov.shown).toBe(1);              // one distinct commit, not two bullets
  expect(cov.total).toBe(2);
});

test("a 7-char prefix citation counts as covered — the shared resolver, not a stricter copy", () => {
  // recapCoverage reports a commit as NOT SHOWN when nothing resolves to it. A resolver one
  // character stricter than the one that built the bullets would invent drops in a line whose only
  // job is to be trusted. Pinned as behaviour, not as "it calls the helper".
  const full = "45acfe1f2b3c4d5e6f70819a2b3c4d5e6f708190";
  const ctx = ctxOf(commit(full, "quant_stocks/x.py", "long sha"));
  expect(recapCoverage([bullet("did it", "45acfe1")], ctx, UNITS)).toBeUndefined();
});

test("adorned and parenthesised citations still resolve", () => {
  const ctx = ctxOf(commit("aaa1111", "accountant_ai/a.py", "one"));
  expect(recapCoverage([bullet("did it", "`aaa1111` (src/main.ts)")], ctx, UNITS)).toBeUndefined();
});

test("STATED RESIDUAL, pinned: an un-evidenced bullet covers nothing and reads as a drop", () => {
  // A model that drops the SHA rather than the commit produces a FALSE drop here. That is the
  // deliberate direction — it fails loud with an extra line rather than silently under-reporting,
  // which is the failure this whole change exists to move away from. Documented, not a bug.
  const ctx = ctxOf(commit("aaa1111", "accountant_ai/a.py", "one"));
  const cov = recapCoverage([bullet("did it with no evidence at all")], ctx, UNITS)!;
  expect(cov.notShown.map((n) => n.sha)).toEqual(["aaa1111"]);
});

test("notShown is capped and the remainder is still counted in total", () => {
  const acts = Array.from({ length: NOT_SHOWN_CAP + 3 }, (_, i) =>
    commit(`abc${i}def`, "quant_stocks/x.py", `dropped ${i}`));
  const cov = recapCoverage([], ctx0(acts), UNITS)!;
  expect(cov.notShown).toHaveLength(NOT_SHOWN_CAP);
  expect(cov.total - cov.shown).toBe(NOT_SHOWN_CAP + 3);   // the cap hides lines, never the count
});
function ctx0(acts: Activity[]): ReducedContext { return { repos: [{ repo: "/r", summary: "s", activities: acts }] }; }

// ── Render ───────────────────────────────────────────────────────────────────────────────────────
const struct = (recap: BriefingStruct["recap"], cov?: BriefingStruct["recapCoverage"]): BriefingStruct => ({
  date: "2026-09-03", machineScope: "host", provider: "claude", resume: [], recap, suggestions: [], recapCoverage: cov,
});

test("render: a complete morning keeps the old header verbatim", () => {
  const out = renderBriefing(struct([bullet("a", "aaa1111"), bullet("b", "bbb2222")]));
  expect(out).toContain("▶ What you did — 2 commits");
  expect(out).not.toContain("NOT shown above");
});

test("render: a lossy morning says so in the header AND names what was lost", () => {
  const out = renderBriefing(struct([bullet("a", "aaa1111")], {
    shown: 1, total: 2,
    notShown: [{ label: "quant_stocks", sha: "45acfe1", subject: "add the missing CI" }],
  }));
  expect(out).toContain("▶ What you did — 1 of 2 commits");
  expect(out).toContain("1 in-window commit(s) NOT shown above:");
  expect(out).toContain("[quant_stocks] 45acfe1 add the missing CI");
});

test("render: the cap's remainder is rendered as (+N more)", () => {
  const out = renderBriefing(struct([bullet("a", "aaa1111")], {
    shown: 1, total: 9,
    notShown: [{ label: "quant_stocks", sha: "abc0def", subject: "one" }],
  }));
  expect(out).toContain("8 in-window commit(s) NOT shown above:");
  expect(out).toContain("(+7 more)");
});

// ── Conformance corpus for the day-49 extraction ─────────────────────────────────────────────────
// The 2026-08-30 ruling: a pin asserting "this file CALLS that helper" is unenforceable — a comment
// satisfies the grep, and a hand-rolled copy that AGREES is harmless anyway. Drift is the bug, and
// drift is behaviour. So this runs discriminating inputs through the extracted helpers and through a
// verbatim transcription of the pre-extraction inline logic, and requires them to agree. An inlined
// copy passes only by being correct.
test("extracted evidence helpers conform to the pre-extraction inline logic", () => {
  const inlineTokens = (ev: string) => ev.split(/[,\s]+/).map((t) => t.replace(/[()]/g, "")).filter(Boolean);
  const inlineBare = (t: string) => t.replace(/^[`'"[{*_]+/, "").replace(/[`'"\]}*_.,;:!?]+$/, "");
  const inlineMatch = (a: string, b: string) => {
    const x = a.toLowerCase(), y = b.toLowerCase();
    return x.startsWith(y) || y.startsWith(x);
  };
  const cases = [
    "aaa1111", "`aaa1111`", "aaa1111.", "(aaa1111)", "aaa1111, bbb2222", "[aaa1111]",
    "*aaa1111*", "_aaa1111_", "{aaa1111}", "\"aaa1111\";", "2ee0ae5 (src/main.ts)",
    "added", "cafe", "2026", "AAA1111", "`45ACFE1`.", "CaFe", "5400288", "#418", "abcd", "45acfe1f2b3c4d5e6f70819a2b3c4d5e6f708190", "",
  ];
  for (const ev of cases) {
    expect(evidenceTokens(ev)).toEqual(inlineTokens(ev));
    for (const t of evidenceTokens(ev)) {
      expect(bareToken(t)).toEqual(inlineBare(t));
      // No shape gate here (cold review LOW-6). Gating on isShaShaped skipped every input that could
      // discriminate — `2026`, `cafe`, `added` — leaving four SHA-shaped strings and proving nothing.
      // shaPrefixMatch is called on ALL tokens, and the corpus carries mixed case, which is the one
      // real behavioural difference between the two old sites: `resolveOne` lowercased before
      // comparing and `verifyEvidence` did not.
      const bare = bareToken(t);
      for (const other of ["aaa1111", "AAA1111", "45acfe1", "45ACFE1",
                           "45acfe1f2b3c4d5e6f70819a2b3c4d5e6f708190", "bbb2222", "2026", "cafe"]) {
        expect(shaPrefixMatch(other, bare)).toBe(inlineMatch(other, bare));
        expect(shaPrefixMatch(other, bare.toLowerCase())).toBe(inlineMatch(other, bare.toLowerCase()));
      }
    }
  }
});

test("an ALL-DIGIT sha prefix still counts as covered — the fabrication gate is the wrong gate here", () => {
  // Found by replaying day 49's own briefing, not reasoned about in advance. `5400288` and `3316617`
  // are both genuinely cited in that recap, and both are all-digit prefixes, which `isShaShaped`
  // rejects on purpose (its question is "could this be a fabricated SHA?" — a year or PR number
  // must not be treated as a citation there). Coverage asks the opposite question and answers it
  // against ground truth, so the gate is SHA_RE plus a real prefix match. With the strict gate these
  // two became phantom "not shown" lines: ~(10/16)^7 of commits by shape, 1-2 per morning, in a line
  // whose only value is being trusted.
  const ctx = ctxOf(commit("5400288", "quant_stocks/x.py", "chore: ignore phase-loop run-state files"));
  expect(recapCoverage([bullet("ignored the run-state files", "(5400288)")], ctx, UNITS)).toBeUndefined();
});

test("a non-SHA token can only cover a commit by literally prefixing a real one", () => {
  // The safety argument for dropping the all-digit gate: a stray number cannot mark anything covered
  // unless a real in-window commit id starts with it.
  const ctx = ctxOf(commit("aaa1111", "accountant_ai/a.py", "one"));
  const cov = recapCoverage([bullet("shipped in 2026 after 12 rounds", "2026, 12")], ctx, UNITS)!;
  expect(cov.notShown.map((n) => n.sha)).toEqual(["aaa1111"]);   // still an uncovered commit
});

// ── The empty-RECAP case: the one this feature exists for, and the one it got wrong ──────────────
test("render: an empty RECAP over a non-empty window states the count and does NOT deny it", () => {
  // Cold review HIGH-1, reproduced before fixing: the header count was gated on `b.recap.length`, so
  // a briefing whose RECAP came back empty printed no count at all, then the drop list, then
  // "(no commits in the window)" directly underneath the commits it had just named. `main.ts` only
  // aborts when ALL sections are empty, so such a briefing is rendered, written and stamped.
  const out = renderBriefing(struct([], {
    shown: 0, total: 3,
    notShown: [{ label: "quant_stocks", sha: "45acfe1", subject: "add the missing CI" }],
  }));
  expect(out).toContain("▶ What you did — 0 of 3 commits");
  expect(out).toContain("3 in-window commit(s) NOT shown above:");
  expect(out).not.toContain("(no commits in the window)");
});

test("render: a genuinely empty window still says so", () => {
  // The fallback must survive — it is suppressed only when coverage has named commits.
  const out = renderBriefing(struct([]));
  expect(out).toContain("(no commits in the window)");
  expect(out).not.toContain("NOT shown above");
});

test("render: singular window reads 'commit', not 'commits'", () => {
  const out = renderBriefing(struct([], { shown: 0, total: 1,
    notShown: [{ label: "quant_stocks", sha: "45acfe1", subject: "only one" }] }));
  expect(out).toContain("▶ What you did — 0 of 1 commit\n");
});

test("an unlabelled commit never renders an empty []", () => {
  // LOW-5: `a.repo` undefined fell through repoLabelFor("") to "" and rendered "· [] sha subject".
  const orphan: Activity = { source: "git", kind: "commit", event_id: "ddd4444", text: "orphan",
    meta: { diffstat: [{ file: "x.py", added: 1, removed: 0 }] } };
  const cov = recapCoverage([], { repos: [{ repo: "/r", summary: "s", activities: [orphan] }] }, UNITS)!;
  expect(cov.notShown[0]!.label).not.toBe("");
});

test("an AMBIGUOUS prefix covers nothing — it must not absorb real drops silently", () => {
  // Verify round 2a. A short prefix matching several commits previously marked ALL of them covered,
  // so one `aaa1` citation hid three real drops. clusterRecap already required a unique hit for the
  // same reason; recapCoverage did not. Ambiguity means "cannot tell", and this is the one direction
  // that fails silent — the failure mode the whole feature exists to remove.
  const ctx = ctxOf(
    commit("aaa1111", "accountant_ai/a.py", "one"),
    commit("aaa1222", "accountant_ai/b.py", "two"),
    commit("aaa1333", "quant_stocks/c.py", "three"),
  );
  const cov = recapCoverage([bullet("did something", "aaa1")], ctx, UNITS)!;
  expect(cov.shown).toBe(0);
  expect(cov.notShown.map((n) => n.sha).sort()).toEqual(["aaa1111", "aaa1222", "aaa1333"]);
});

test("an UNambiguous prefix still covers its one commit", () => {
  // The guard must not overshoot: uniqueness is the test, not length.
  const ctx = ctxOf(commit("aaa1111", "accountant_ai/a.py", "one"), commit("bbb2222", "quant_stocks/b.py", "two"));
  const cov = recapCoverage([bullet("did one", "aaa1")], ctx, UNITS)!;
  expect(cov.shown).toBe(1);
  expect(cov.notShown.map((n) => n.sha)).toEqual(["bbb2222"]);
});

test("a clipped subject is marked as clipped", () => {
  // Verify round NEW-4: these lines are the only record of a commit the briefing never mentions, so
  // a truncated one must not read as a whole one.
  const long = "x".repeat(200);
  const ctx = ctxOf(commit("aaa1111", "quant_stocks/a.py", long));
  const cov = recapCoverage([], ctx, UNITS)!;
  expect(cov.notShown[0]!.subject.endsWith("…")).toBe(true);
  expect(cov.notShown[0]!.subject.length).toBe(72);
});

test("a short subject is left exactly alone", () => {
  const ctx = ctxOf(commit("aaa1111", "quant_stocks/a.py", "short one"));
  expect(recapCoverage([], ctx, UNITS)!.notShown[0]!.subject).toBe("short one");
});

// ── The eval-flag guard (user-directed 2026-09-03) ───────────────────────────────────────────────
// Verify round NEW-2: the drop lines carry `[label]`, and a commit subject usually carries its own
// lane name too (measured 271 of 2323 subjects; command on NOT_SHOWN_PREFIX's header), so left in
// coverageGaps' haystack
// they make the briefing "name" a repo purely by reporting that one of its commits was OMITTED —
// suppressing UNCOMMITTED NOT SURFACED, which is a COUNTED flag, with a line that says nothing about
// uncommitted work.
//
// These assert CONFORMANCE, not that render.ts mentions a constant — the 2026-08-30 ruling: a pin
// that says "this file CALLS that helper" is satisfied by a comment, and drift is the actual bug. So
// the REAL renderer's output goes through the REAL excluder. An inlined literal on either side that
// disagrees fails here.
test("EVAL GUARD: a drop line naming a lane does NOT clear that lane's coverage gap", () => {
  const out = renderBriefing(struct([bullet("a", "aaa1111")], {
    shown: 1, total: 2,
    notShown: [{ label: "quant_stocks", sha: "45acfe1", subject: "docs(quant_stocks): add the missing CI" }],
  }));
  // Belt and braces: the label appears twice in that line — once bracketed, once inside the subject's
  // own scope — which is exactly why dropping the bracket was not a viable alternative.
  expect(out).toContain("[quant_stocks]");
  const gaps = coverageGaps([{ repo: "/r", labels: ["quant_stocks"] }], out);
  expect(gaps.map((g) => g.repo)).toEqual(["/r"]);
});

test("EVAL GUARD: the exclusion does not over-exclude — a real mention still clears the gap", () => {
  // The guard must remove ONLY the drop lines. A briefing that genuinely surfaces the lane elsewhere
  // must still count as naming it.
  //
  // ⚠ CORRECTED: an earlier version of this comment called over-exclusion the SILENT direction. It is
  // the opposite, and the verify round measured it — a smaller haystack leaves more repos unmatched,
  // so over-exclusion drives gaps UP (0 gaps shipped, 1 under an over-broad filter) and announces
  // itself. UNDER-exclusion is the silent one: it makes a gap DISAPPEAR, which is the original NEW-2
  // defect this guard exists for. Both break flag-count comparability; only one hides.
  const out = renderBriefing(struct([{ repo: "quant_stocks", text: "did real work there", evidence: "aaa1111" }]));
  expect(coverageGaps([{ repo: "/r", labels: ["quant_stocks"] }], out)).toEqual([]);
});

test("EVAL GUARD: the writer's prefix and the excluder's prefix are the same string", () => {
  // Not a "calls the constant" pin — this compares the RENDERED bytes against what the excluder
  // filters on, so two literals that drift fail even though both files still compile.
  const out = renderBriefing(struct([], { shown: 0, total: 1,
    notShown: [{ label: "quant_stocks", sha: "45acfe1", subject: "only one" }] }));
  const dropLines = out.split("\n").filter((l) => l.includes("45acfe1"));
  expect(dropLines).toHaveLength(1);
  expect(dropLines[0]!.startsWith(NOT_SHOWN_PREFIX)).toBe(true);
});
