// test/day50-truncation-warning.test.ts — EVAL day 50: truncation must reach the READER.
//
// reduce() attaches ctx.note when it shrank the context; until this change the note reached only the
// PROMPT ("NOTE:" line in buildPrompt), so the reader learned of truncation only if the model chose
// to mention it — the model-drops-a-claim class branchState/today/labelLegend/recapCoverage exist
// for. Worse, a stage>=2 truncation empties every repo's activities, recapCoverage returns undefined,
// and the recap header renders with no reconciliation — a truncated morning indistinguishable from a
// complete one. Disclosed in #424's own docblock as the known gap; closed here via the existing
// sanitized warnings channel (render.ts:222 joins + escapes — Tier-5 tested there, not re-tested here).
//
// Haystack safety, by construction rather than by exclusion: the reduce.ts note texts carry no repo
// names, and neither does the coverage-off clause, so — unlike the NOT_SHOWN_PREFIX lines, which
// needed an audit-side exclusion — this warning cannot clear a coverageGaps entry. Pinned below.
import { test, expect } from "bun:test";
import { generateBriefing } from "../src/generator";
import { coverageGaps } from "../src/audit";
import { renderBriefing } from "../src/render";
import type { ReducedContext, Provider } from "../src/types";

const stub: Provider = {
  generate: async () => ["## RESUME", "- [/r1] resume", "## RECAP", "## SUGGESTIONS", "- do the thing"].join("\n"),
};
const META = { date: "2026-09-04", machineScope: "host", provider: "claude" };

test("a stage-2 truncation reaches the reader, and says coverage is off", async () => {
  const ctx: ReducedContext = {
    repos: [{ repo: "/r1", summary: "3 commit(s)", activities: [] }, { repo: "/r2", summary: "1 commit(s)", activities: [] }],
    note: "context reduced to per-repo summaries to fit 60000 chars",
  };
  const b = await generateBriefing(ctx, stub, META, []);
  const w = (b.warnings ?? []).filter((x) => x.includes("context reduced"));
  expect(w).toHaveLength(1);
  expect(w[0]!).toContain("recap coverage is unavailable this morning");
  // And it actually renders — the reader-facing property, not just the struct field.
  expect(renderBriefing(b)).toContain("context reduced to per-repo summaries");
});

test("a stage-1 trim is reported WITHOUT the coverage-off clause — coverage still works there", async () => {
  const ctx: ReducedContext = {
    repos: [{ repo: "/r1", summary: "s", activities: [{ source: "git", kind: "commit", event_id: "aaa1111", repo: "/r1", text: "one" }] }],
    note: "context trimmed to fit 60000 chars (heavy map-reduce is Slice 1.5)",
  };
  const b = await generateBriefing(ctx, stub, META, []);
  const w = (b.warnings ?? []).filter((x) => x.includes("context trimmed"));
  expect(w).toHaveLength(1);
  expect(w[0]!).not.toContain("recap coverage is unavailable");
});

test("no note, no truncation warning — a normal morning adds NOTHING to warnings", async () => {
  // Review LOW-1: the substring check alone left the no-note guard unpinned in this file — an
  // `if (true)` mutant rendered "⚠ undefined" every morning and passed all six tests here (it was
  // caught only by harden.warnings.test.ts's no-phantom-warnings pin, one file away). Assert the
  // exact count so THIS file kills it too.
  const b = await generateBriefing({ repos: [] }, stub, META, []);
  expect(b.warnings ?? []).toHaveLength(0);
});

test("HAYSTACK SAFETY: the truncation warning cannot clear a coverage gap", async () => {
  // The real rendered output through the real coverageGaps — the conformance idiom, not a
  // constant-reference pin. A repo with working state that the briefing never names must STILL gap
  // on a truncated morning, warning line and all.
  const ctx: ReducedContext = {
    repos: [{ repo: "/uncovered-repo", summary: "s", activities: [] }],
    note: "context reduced to per-repo summaries to fit 60000 chars",
  };
  const b = await generateBriefing(ctx, stub, META, []);
  const out = renderBriefing(b);
  expect(out).toContain("context reduced");                       // the warning is really in the text
  const gaps = coverageGaps([{ repo: "/uncovered-repo", labels: ["uncovered-repo"] }], out);
  expect(gaps.map((g) => g.repo)).toEqual(["/uncovered-repo"]);   // and it cleared nothing
});

test("an empty-repos stage-3 context does not claim coverage is off (there is nothing to cover)", async () => {
  // ctx.repos.length === 0 → the coverageOff clause must not fire; the bare note still renders.
  const b = await generateBriefing({ repos: [], note: "context truncated: dropped 3 repo(s) to fit 60000 chars" }, stub, META, []);
  const w = (b.warnings ?? []).filter((x) => x.includes("context truncated"));
  expect(w).toHaveLength(1);
  expect(w[0]!).not.toContain("recap coverage is unavailable");
});

test("a MIXED morning (one repo empty, one with activity) keeps coverage on — every(), not some()", async () => {
  // Mutation survivor M4: every→some passed all prior tests. A working-state-only repo has zero
  // activities NATURALLY; under some(), any such repo plus a stage-1 note would falsely announce
  // coverage off while recapCoverage is running fine on the other repo's commits.
  const ctx: ReducedContext = {
    repos: [
      { repo: "/r1", summary: "s", activities: [{ source: "git", kind: "commit", event_id: "aaa1111", repo: "/r1", text: "one" }] },
      { repo: "/r2", summary: "uncommitted only", activities: [] },
    ],
    note: "context trimmed to fit 60000 chars (heavy map-reduce is Slice 1.5)",
  };
  const b = await generateBriefing(ctx, stub, META, []);
  const w = (b.warnings ?? []).filter((x) => x.includes("context trimmed"));
  expect(w).toHaveLength(1);
  expect(w[0]!).not.toContain("recap coverage is unavailable");
});
