import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// test/repos.hidden.test.ts — B1-M3-T8 (wave-2 plan): the commits behind "(+N more)".
//
// The morning's own list, never a re-query (disagreement 9): a label's hidden commits are the run record's
// `missing` SHAs (recapCoverage's own uncovered list) whose recorded label is that label, minus every commit
// the card tokens resolved to (by full SHA, in the repo it resolved in). Their subjects come from ONE
// hardened `log --no-walk=unsorted --ignore-missing` per repo, redacted, then clipped to 72. Scratch repos
// only, built per test under a per-test global config. The reply-level scans (no other subject anywhere in
// the reply, and the hostile-marker scan) live in test/repos.status.test.ts, where the reply is built.
import { test, expect, describe } from "bun:test";
import { startGitBudget } from "../src/git";
import { hardenArgs } from "../src/repos/harden";
import type { RepoGit } from "../src/repos/hgit";
import { buildRunRecord, recordCommitsFor, type RunRecord } from "../src/runRecord";
import { planHidden, hiddenSubjects, hiddenSubject, HIDDEN_SUBJECT_MAX } from "../src/repos/hidden";
import type { Activity, ReducedContext } from "../src/types";
import type { Unit } from "../src/subprojects";
import { isolatedGit, newRepo, withGit, commitAt } from "./fixtures/repos-fixtures";

const LAZY = { lazyFetch: true };
async function rgFor(repo: string): Promise<RepoGit> {
  const budget = startGitBudget(60_000);
  const h = await hardenArgs(repo, budget, LAZY);
  if ("unknown" in h) throw new Error(`unknown: ${h.unknown}`);
  return { repo, lead: h.lead, budget };
}
const hex = (c: string, n = 40) => c.repeat(n).slice(0, n);
const CRED = "ghp_AbCdEfGhIjKlMnOpQrStUv123456";

const commit = (sha: string, repo: string, file: string): Activity => ({
  source: "git", kind: "commit", event_id: sha, repo, text: "s", timestamp: "2026-01-11T10:00:00Z",
  meta: { diffstat: [{ file, added: 1, removed: 0 }] },
});
const unit = (repo: string, root: string | null, label: string): Unit => ({
  repo, root, label, hasResumptionState: false, hasWindowContent: true, resumptionNote: "", dirtyFiles: [], latestCommitTime: null,
});
/** A record built the way the morning builds it: `recordCommitsFor` over a context, then `buildRunRecord`. */
function recordOf(acts: Activity[], units: Unit[], roots: Map<string, string[]>, recap: { repo: string; text: string; evidence: string }[]): RunRecord {
  const repos = [...new Set(acts.map((a) => a.repo!))];
  const ctx: ReducedContext = { repos: repos.map((repo) => ({ repo, summary: "s", activities: acts.filter((a) => a.repo === repo) })) };
  return buildRunRecord({ runDate: "2026-01-12", repos, units, windowStartUtc: "2026-01-11T00:00:00.000Z",
    recordCommits: recordCommitsFor(ctx, units, roots, recap) })!;
}

describe("which commits are hidden (planHidden: the record's lists, minus what the tokens resolved to)", () => {
  const R = "/r";
  const A1 = hex("a1"), A2 = hex("a2"), B1 = hex("b1"), N1 = hex("c1");

  test("each label's uncited recorded commits are listed; a cited commit is not; a nested sub-project root's commit lands on its label", () => {
    const units = [unit(R, null, "r"), unit(R, "app", "app"), unit(R, "app/core", "core")];
    const roots = new Map([[R, ["app", "app/core"]]]);
    const rec = recordOf([commit(A1, R, "app/a.ts"), commit(A2, R, "app/b.ts"), commit(N1, R, "app/core/x.ts")], units, roots, []);
    expect(rec.missing).toEqual([A1, A2, N1]);                         // the page covered none of them
    const plan = planHidden(rec, ["app", "core"], [{ sha: A1, repo: R }]);   // A1 was cited on the card
    expect(plan.byRepo.get(R)).toEqual([{ sha: A2, key: "app" }, { sha: N1, key: "core" }]);
    expect(plan.strays).toBe(0);
  });

  test("a commit recorded once (the record holds shared commits and patch twins once) is listed once", () => {
    const rec = recordOf([commit(A1, R, "a"), commit(A2, R, "b")], [unit(R, null, "r")], new Map(), []);
    const doubled: RunRecord = { ...rec, missing: [...rec.missing, A1] };   // a duplicate in `missing` changes nothing
    expect(planHidden(doubled, ["r"], []).byRepo.get(R)).toEqual([{ sha: A1, key: "r" }, { sha: A2, key: "r" }]);
  });

  test("a commit cited on the page by a 5-character token is not listed (it is not in `missing`); an ambiguous 7-character token subtracts nothing", () => {
    const T1 = "aaaaaaa" + hex("3", 33), T2 = "aaaaaaa" + hex("4", 33);
    const rec = recordOf([commit(A1, R, "a"), commit(T1, R, "b"), commit(T2, R, "c")], [unit(R, null, "r")], new Map(),
      [{ repo: "r", text: "x", evidence: A1.slice(0, 5) }, { repo: "r", text: "y", evidence: "aaaaaaa" }]);
    expect(rec.missing).toEqual([T1, T2]);
    // the 7-character token resolves to NO commit (ambiguous), so the resolved list is empty: both are listed
    expect(planHidden(rec, ["r"], []).byRepo.get(R)).toEqual([{ sha: T1, key: "r" }, { sha: T2, key: "r" }]);
  });

  test("a recorded commit attributed to a label with no card is a stray (it makes `complete` false); so is a `missing` SHA the commits lack", () => {
    const rec = recordOf([commit(A1, R, "app/a"), commit(B1, R, "docs/b")], [unit(R, "app", "app"), unit(R, "docs", "docs")],
      new Map([[R, ["app", "docs"]]]), []);
    const plan = planHidden(rec, ["app"], []);
    expect(plan.byRepo.get(R)).toEqual([{ sha: A1, key: "app" }]);
    expect(plan.strays).toBe(1);
    expect(planHidden({ ...rec, missing: [...rec.missing, hex("9")] }, ["app", "docs"], []).strays).toBe(1);
  });

  test("labels match on norm keys; an Other-card token subtracts only in the repo it resolved in", () => {
    const R2 = "/r2";
    const rec = recordOf([commit(A1, R, "a"), commit(A1, R2, "a")], [unit(R, null, "Repo One"), unit(R2, null, "two")], new Map(), []);
    // the same SHA in two repos (a fork): the Other card's token resolved it in R2 only
    const plan = planHidden(rec, ["repo one", "two"], [{ sha: A1, repo: R2 }]);
    expect(plan.byRepo.get(R)).toEqual([{ sha: A1, key: "repo one" }]);
    expect(plan.byRepo.get(R2) ?? []).toEqual([]);
  });

  test("a 7-character token that prefixes commits in two repos: with the record it resolves in the label's repo alone, so that one commit is subtracted", () => {
    // recapCoverage treats the token as ambiguous across ALL repos and covers neither (both in `missing`);
    // the live check, with the record, resolves it in the label's repo only (B1-M2-T4), so the hidden list
    // is one short of the page's "(+N more)" count. Accepted and safe: the webview's count check (B1-M5-T14)
    // then keeps A's "(+N more)" line.
    const R2 = "/r2";
    const C1 = "1234567" + hex("5", 33), C2 = "1234567" + hex("6", 33);
    const rec = recordOf([commit(C1, R, "a"), commit(A2, R, "b"), commit(C2, R2, "c")], [unit(R, null, "one"), unit(R2, null, "two")], new Map(),
      [{ repo: "one", text: "x", evidence: "1234567" }]);
    expect(rec.missing).toEqual([C1, A2, C2]);                        // the page: ambiguous, covers neither
    const plan = planHidden(rec, ["one", "two"], [{ sha: C1, repo: R }]);
    expect(plan.byRepo.get(R)).toEqual([{ sha: A2, key: "one" }]);   // the page's "(+2 more)" for "one"; listed: 1
    expect(plan.byRepo.get(R2)).toEqual([{ sha: C2, key: "two" }]);
  });
});

describe("the subjects (hiddenSubjects: one hardened log per repo; hiddenSubject: redact, then clip)", () => {
  test("present commits are listed with their subjects; a recorded SHA the repo no longer has is left out (--ignore-missing)", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const a = await commitAt(repo, env, { "a.txt": "1\n" }, "first subject", "2026-01-12T10:00:00Z");
    const b = await commitAt(repo, env, { "b.txt": "1\n" }, `uses ${CRED} here`, "2026-01-12T11:00:00Z");
    const gone = hex("0");
    const { result, calls } = await withGit(env, async () => hiddenSubjects(await rgFor(repo), [a, gone, b]));
    expect([...result]).toEqual([[a, "first subject"], [b, "uses [redacted] here"]]);
    const log = calls.find((c) => c.includes("log"))!;
    expect(log.slice(log.indexOf("log"))).toEqual(["log", "--no-walk=unsorted", "--ignore-missing", "--no-show-signature", "--format=%H%x1f%s", "--end-of-options", a, gone, b]);
  });

  test("only validated 40-hex SHAs are asked; none asked spawns nothing", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const rg = await withGit(env, () => rgFor(repo));
    const { result, calls } = await withGit(env, () => hiddenSubjects(rg.result, ["-n", "abc1234", "HEAD"]));
    expect(result.size).toBe(0);
    expect(calls).toEqual([]);
  });

  test("a 300-character subject is clipped to 72 with …; a credential across the 72nd character is redacted BEFORE the clip", async () => {
    expect(HIDDEN_SUBJECT_MAX).toBe(72);
    const long = "s".repeat(300);
    const clipped = hiddenSubject(long);
    expect(clipped).toHaveLength(72);
    expect(clipped).toBe(`${"s".repeat(71)}…`);
    const across = `${"w".repeat(60)} ${CRED} tail`;                 // the credential spans characters 62-92
    const out = hiddenSubject(across);
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain(CRED.slice(0, 11));                     // no prefix the cut would have left
    expect(out).toBe(`${"w".repeat(60)} [redacted]…`);                // redacted (76 characters), THEN cut to 71 + "…"
    // and through a real repo, so the clip is the one the reply gets
    const { env } = isolatedGit();
    const repo = await newRepo();
    const sha = await commitAt(repo, env, { "a.txt": "1\n" }, `${"w".repeat(66)} ${CRED} ${"x".repeat(200)}`, "2026-01-12T10:00:00Z");
    const { result } = await withGit(env, async () => hiddenSubjects(await rgFor(repo), [sha]));
    const s = result.get(sha)!;
    expect(s).toHaveLength(72);
    expect(s.endsWith("…")).toBe(true);
    expect(s).toBe(`${"w".repeat(66)} [red…`);
    expect(s).not.toContain("ghp_");
  });
});
