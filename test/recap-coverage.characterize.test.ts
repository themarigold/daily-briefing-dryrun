// test/recap-coverage.characterize.test.ts — B1-M1-T3 (wave-2 plan, round 3 R3-M6 and round 4 LOW):
// CHARACTERIZATION tests of `recapCoverage`, written and seen GREEN ON THE BASE (8ed74e9ea) before
// `windowCommits`, `coverageMissing` and `commitLabeler` were extracted from it, and run unchanged after.
// They pin the two citation rules the run record's `missing` list must inherit: a 4- to 6-character
// citation COVERS a commit (`SHA_RE` admits {4,40}), and an AMBIGUOUS citation covers nothing (exactly
// one hit). This file imports only src/generator.ts — never src/runRecord.ts — so it says nothing about
// the record; it is about the page's own "NOT shown above" lines, which the eval reads.
import { test, expect } from "bun:test";
import { recapCoverage, windowCommits } from "../src/generator";

type Ctx = Parameters<typeof recapCoverage>[1];
type Unit = Parameters<typeof recapCoverage>[2][number];
type Act = Ctx["repos"][number]["activities"][number];

const commit = (sha: string, subject: string): Act => ({
  source: "git", kind: "commit", event_id: sha, repo: "/r", text: subject, timestamp: "2026-01-11T10:00:00Z",
  meta: { diffstat: [{ file: "a.txt", added: 1, removed: 0 }] },
} as Act);
const ctxOf = (...acts: Act[]): Ctx => ({ repos: [{ repo: "/r", summary: "s", activities: acts }] } as Ctx);
const UNITS: Unit[] = [{
  repo: "/r", root: null, label: "r", hasResumptionState: false, hasWindowContent: true,
  resumptionNote: "", dirtyFiles: [], latestCommitTime: null,
} as Unit];
const bullet = (evidence: string) => ({ repo: "r", text: "did it", evidence });

const A = "abcde12" + "0".repeat(33);
const B = "f00ba47" + "1".repeat(33);

test("a commit cited only by a 4- to 6-character token counts as covered: not in notShown, and shown counts it", () => {
  for (const token of ["abcd", "abcde", "abcde1"]) {
    const cov = recapCoverage([bullet(token)], ctxOf(commit(A, "first"), commit(B, "second")), UNITS)!;
    expect({ token, shown: cov.shown, total: cov.total, notShown: cov.notShown.map((n) => n.sha) })
      .toEqual({ token, shown: 1, total: 2, notShown: ["f00ba47"] });
  }
});

test("a 7-character token that prefixes two window commits covers neither", () => {
  const twinA = "aaaaaaa" + "1".repeat(33);
  const twinB = "aaaaaaa" + "2".repeat(33);
  const cov = recapCoverage([bullet("aaaaaaa")], ctxOf(commit(twinA, "one"), commit(twinB, "two")), UNITS)!;
  expect(cov.shown).toBe(0);
  expect(cov.total).toBe(2);
  expect(cov.notShown.map((n) => [n.label, n.sha, n.subject])).toEqual([["r", "aaaaaaa", "one"], ["r", "aaaaaaa", "two"]]);
  // …while the same token naming ONE commit covers it (the rule is "exactly one hit", not "never 7")
  const one = recapCoverage([bullet("aaaaaaa")], ctxOf(commit(twinA, "one"), commit(B, "second")), UNITS)!;
  expect([one.shown, one.notShown.map((n) => n.sha)]).toEqual([1, ["f00ba47"]]);
});

test("a commit activity without a string event_id counts in no window total", () => {
  const { event_id: _id, ...withoutId } = commit(A, "no id");
  const missing = withoutId as Act;
  const numeric = { ...missing, event_id: 7 } as unknown as Act;
  const ctx = ctxOf(missing, numeric, commit(B, "identified"));
  expect(windowCommits(ctx).map((a) => a.event_id)).toEqual([B]);
  const cov = recapCoverage([], ctx, UNITS)!;
  expect([cov.shown, cov.total, cov.notShown.map((n) => n.sha)]).toEqual([0, 1, ["f00ba47"]]);
  expect(recapCoverage([], ctxOf(missing, numeric), UNITS)).toBeUndefined();
});
