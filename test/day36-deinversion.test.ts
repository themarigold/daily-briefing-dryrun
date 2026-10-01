// test/day36-deinversion.test.ts — T1.3, the day-36 inversion batch: display clustering
// (clusterRecap + render nesting), merge attribution by first-parent file plurality (mergeLabel via
// unitForFiles), the recap count header, and the audit-invariance pin (constraint 2 of the design:
// the deterministic audit layer must return IDENTICAL results on clustered and flat renders).
import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
import { test, expect, describe } from "bun:test";
import { clusterRecap, generateBriefing } from "../src/generator";
import { renderBriefing } from "../src/render";
import { unitForFiles, unitForCommit } from "../src/subprojects";
import { extractCitedShas, missingSameDay, coverageGaps } from "../src/audit";
import { listPrMerges } from "../src/git";
import { runCore } from "../src/core";
import { localMidnight } from "../src/time";
import { buildRepo, branchCommit, mergeBranchWith } from "./fixtures/build-repo";
import type { ReducedContext, Activity, BriefingStruct, Config, Provider } from "../src/types";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const commit = (sha: string, repo: string, diffstat: { file: string; added: number; removed: number }[], iso: string): Activity =>
  ({ source: "git", kind: "commit", event_id: sha, repo, timestamp: iso, text: `c-${sha}`, meta: { diffstat } });

const ctxOf = (acts: Activity[]): ReducedContext => ({ repos: [{ repo: "/r", summary: "", activities: acts }] });

const d18 = "2026-08-18T10:00:00-07:00", d19 = "2026-08-19T10:00:00-07:00";

describe("clusterRecap — pure", () => {
  test("two entries whose commits share a dominant file are stamped with one group; a third on another file is not", () => {
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "core/ledger.py", added: 10, removed: 2 }], d18),
      // notes.md is source-class on purpose: it participates in the churn contest and LOSES on
      // churn, which is what this fixture has always demonstrated. (It was tests/t.py until the
      // source-preferred keying change, after which the predicate dropped it before churn was
      // consulted and the row demonstrated nothing.)
      commit("bbbb222", "/r", [{ file: "core/ledger.py", added: 7, removed: 1 }, { file: "notes.md", added: 1, removed: 0 }], d19),
      commit("cccc333", "/r", [{ file: "other.py", added: 3, removed: 0 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
      { repo: "app", text: "three", evidence: "cccc333" },
    ], ctx);
    expect(out[0]!.group).toBe("core/ledger.py — 2 commits (Aug 18–19)");
    expect(out[1]!.group).toBe(out[0]!.group);
    expect(out[2]!.group).toBeUndefined();
    // presentation-only: text/evidence/order untouched
    expect(out.map((e) => e.text)).toEqual(["one", "two", "three"]);
    expect(out.map((e) => e.evidence)).toEqual(["aaaa111", "bbbb222", "cccc333"]);
  });

  test("same-day cluster renders a single date, not a range", () => {
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
      commit("bbbb222", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toBe("f.ts — 2 commits (Aug 18)");
  });

  test("unresolved, absent, or ambiguous-prefix evidence leaves the entry ungrouped", () => {
    const ctx = ctxOf([
      // two commits sharing a prefix make a short citation ambiguous
      commit("abc1234deadbeef00", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
      commit("abc1234feedface11", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "no evidence" },
      // ⚠ NOT gate coverage, though it reads like it. `9999999` is all-digit: it used to be rejected
      // by `resolveOne`'s shape test before reaching the hits filter, and since the gate became
      // SHA_RE + a 7-char floor it clears the gate, scores zero hits, and the scan runs off the end
      // of a single-token field. Same outcome by a different path — so this entry no longer covers
      // "an all-digit token is skipped". That is pinned in `cluster-resolver-alldigit.test.ts`.
      { repo: "app", text: "unknown sha", evidence: "9999999" },
      { repo: "app", text: "ambiguous", evidence: "abc1234" },
      { repo: "app", text: "ambiguous too", evidence: "abc1234" },
    ], ctx);
    expect(out.every((e) => e.group === undefined)).toBe(true);
  });

  test("dominant file is max added+removed churn; a tie takes the FIRST diffstat row", () => {
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "first.ts", added: 2, removed: 0 }, { file: "second.ts", added: 1, removed: 1 }], d18),
      commit("bbbb222", "/r", [{ file: "first.ts", added: 5, removed: 0 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "tie goes first", evidence: "aaaa111" },
      { repo: "app", text: "plain", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toContain("first.ts");
    expect(out[1]!.group).toBe(out[0]!.group);
  });

  // ── SOURCE-preferred keying (days 45 + 47, both judged) ───────────────────────────────────────
  test("a churn-heavy shared TEST file does not own the key: the cluster keys on the dominant SOURCE file", () => {
    // Day-45 shape verbatim: every commit's biggest churn is the shared test file; the story the
    // reader needs is the source it guards. Raw max-churn keyed this on test_m7_agent.py.
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "tests/test_m7_agent.py", added: 40, removed: 10 }, { file: "agent/loop.py", added: 12, removed: 3 }], d18),
      commit("bbbb222", "/r", [{ file: "tests/test_m7_agent.py", added: 25, removed: 5 }, { file: "agent/loop.py", added: 8, removed: 1 }], d19),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toBe("agent/loop.py — 2 commits (Aug 18–19)");
    expect(out[1]!.group).toBe(out[0]!.group);
  });

  test("a commit touching ONLY test-like paths falls back to raw churn: a pure test lane still clusters", () => {
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "tests/test_m3.py", added: 9, removed: 0 }, { file: "tests/helpers.py", added: 2, removed: 0 }], d18),
      commit("bbbb222", "/r", [{ file: "tests/test_m3.py", added: 4, removed: 1 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toBe("tests/test_m3.py — 2 commits (Aug 18)");
    expect(out[1]!.group).toBe(out[0]!.group);
  });

  test("MIXED-lane residual, pinned as documented: a test-only member splits from its source-keyed siblings", () => {
    // The docblock's stated residual — failure mode is the flat shape, never a wrong claim. The
    // test-only commit keys on the test file (singleton → no stamp); the two source-touching
    // commits key on the source and still cluster.
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "tests/test_x.py", added: 30, removed: 0 }, { file: "x.py", added: 5, removed: 0 }], d18),
      commit("bbbb222", "/r", [{ file: "x.py", added: 3, removed: 1 }], d18),
      commit("cccc333", "/r", [{ file: "tests/test_x.py", added: 6, removed: 2 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
      { repo: "app", text: "test-only", evidence: "cccc333" },
    ], ctx);
    expect(out[0]!.group).toBe("x.py — 2 commits (Aug 18)");
    expect(out[1]!.group).toBe(out[0]!.group);
    expect(out[2]!.group).toBeUndefined();   // split, not misfiled — the documented safe failure
  });

  test("a tie among SOURCE rows takes the first such diffstat row, even behind a test row", () => {
    // first.ts and second.ts tie at churn 2; the test row leads the diffstat with more churn than
    // both. Pool order must preserve the original row order of the SOURCE rows.
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "test/big.test.ts", added: 50, removed: 0 }, { file: "first.ts", added: 2, removed: 0 }, { file: "second.ts", added: 1, removed: 1 }], d18),
      commit("bbbb222", "/r", [{ file: "first.ts", added: 5, removed: 0 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "tie goes first source row", evidence: "aaaa111" },
      { repo: "app", text: "plain", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toContain("first.ts");
    expect(out[1]!.group).toBe(out[0]!.group);
  });

  test("MAX-CHURN selection is load-bearing: a later, bigger source row beats pool[0]", () => {
    // ⚠ Review found deleting the churn loop (best stays pool[0]) survived the ENTIRE 1468-test
    // suite — a pre-existing gap: the old test at "a tie takes the FIRST diffstat row" pins only
    // the tie half of its own name. Here the max sits LAST in the diffstat, behind two smaller
    // source rows, so first-wins and max-wins disagree.
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "small.ts", added: 1, removed: 0 }, { file: "mid.ts", added: 3, removed: 0 }, { file: "big.ts", added: 9, removed: 2 }], d18),
      commit("bbbb222", "/r", [{ file: "big.ts", added: 4, removed: 0 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toBe("big.ts — 2 commits (Aug 18)");
    expect(out[1]!.group).toBe(out[0]!.group);
  });

  test("INCIDENTAL-TOUCH residual, pinned as documented: a tiny source row names a test-heavy cluster", () => {
    // The docblock's third residual — the price of source-preference, stated not implied. Both
    // commits are overwhelmingly a test rewrite; the 2-line VERSION touch wins the key and the
    // story line carries its name. Factually true (VERSION is in both diffstats), editorially the
    // fixed defect's mirror image, accepted as the tail case. If a churn threshold ever changes
    // this, this test is the loud tripwire that the residual moved.
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "tests/test_engine.py", added: 520, removed: 390 }, { file: "VERSION", added: 2, removed: 2 }], d18),
      commit("bbbb222", "/r", [{ file: "tests/test_engine.py", added: 100, removed: 40 }, { file: "VERSION", added: 1, removed: 1 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toBe("VERSION — 2 commits (Aug 18)");
    expect(out[1]!.group).toBe(out[0]!.group);
  });

  test("test-path predicate: real test shapes excluded, lookalike words are SOURCE", () => {
    // Every fixture pairs one test-shaped row (bigger churn) with one lookalike row; the lookalike
    // must win the key. If the predicate over-matches (e.g. bare substring "test"), the pair keys
    // on nothing sensible and the group strings below fail.
    const shapes: [string, string][] = [
      ["tests/test_rev12b_runtime_role.py", "contest.py"],       // day-47's file; "contest" is source
      ["__tests__/widget.ts", "latest.ts"],                      // __tests__ segment; "latest" is source
      ["src/foo.spec.ts", "protest/march.ts"],                   // .spec. basename; "protest/" is not a test segment
      ["test_root.py", "attestation.py"],                        // test_ prefix at repo root, no segment
      ["pkg/util_test.go", "src/spectrum.ts"],                   // _test before extension; "spectrum" is source
      // ⚠ The next four exist because the verify round killed nothing by reverting them: each pins
      // one behaviour that previously survived the whole suite when mutated (case-insensitivity,
      // the specs plural, the hyphen suffix, basename extraction).
      ["SPECS/a.rb", "specification.rb"],                        // /i + specs? on the segment; no separator after "spec" = source
      ["Tests/A.cs", "TestyMcTest.cs"],                          // /i on tests?; framework-style basename stays source (documented)
      ["foo-test.go", "footest.go"],                             // -test hyphen suffix; glued "footest" is source
      ["src/test_helpers.py", "src/latest_helpers.py"],          // test_ prefix on the BASENAME under a source dir; "latest_" is source
    ];
    for (const [testFile, sourceFile] of shapes) {
      const ctx = ctxOf([
        commit("aaaa111", "/r", [{ file: testFile, added: 20, removed: 0 }, { file: sourceFile, added: 2, removed: 0 }], d18),
        commit("bbbb222", "/r", [{ file: sourceFile, added: 1, removed: 0 }], d18),
      ]);
      const out = clusterRecap([
        { repo: "app", text: "a", evidence: "aaaa111" },
        { repo: "app", text: "b", evidence: "bbbb222" },
      ], ctx);
      expect(out[0]!.group).toBe(`${sourceFile} — 2 commits (Aug 18)`);
      expect(out[1]!.group).toBe(out[0]!.group);
    }
  });

  test("different labels never share a cluster; decorated labels cluster with their bare form (norm)", () => {
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
      commit("bbbb222", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
      commit("cccc333", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "plain", evidence: "aaaa111" },
      { repo: "**app**", text: "decorated", evidence: "bbbb222" },
      { repo: "elsewhere", text: "other label", evidence: "cccc333" },
    ], ctx);
    expect(out[0]!.group).toBeDefined();
    expect(out[1]!.group).toBe(out[0]!.group);   // norm("**app**") === norm("app")
    expect(out[2]!.group).toBeUndefined();       // different label — own (singleton) key
  });
});

describe("clusterRecap — call site (generateBriefing wires it)", () => {
  test("bullets citing same-dominant-file commits come back stamped from generateBriefing itself", async () => {
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "core/ledger.py", added: 4, removed: 1 }], d18),
      commit("bbbb222", "/r", [{ file: "core/ledger.py", added: 2, removed: 2 }], d19),
    ]);
    const stub: Provider = {
      generate: async () => [
        "## RESUME", "- [app] resume",
        "## RECAP",
        "- [app] first | evidence: aaaa111",
        "- [app] second | evidence: bbbb222",
        "## SUGGESTIONS", "- next",
      ].join("\n"),
    };
    const b = await generateBriefing(ctx, stub, { date: "2026-08-25", machineScope: "h", provider: "claude" }, []);
    expect(b.recap.length).toBe(2);
    expect(b.recap[0]!.group).toContain("core/ledger.py — 2 commits");
    expect(b.recap[1]!.group).toBe(b.recap[0]!.group);
  });
});

const struct = (over: Partial<BriefingStruct>): BriefingStruct => ({
  date: "2026-08-25", machineScope: "t", provider: "claude",
  resume: [], recap: [], suggestions: [], ...over,
} as BriefingStruct);

describe("render — group-aware nesting", () => {
  test("first group entry emits a story line, members nest with ◦; ungrouped entries stay flat; every entry renders exactly once", () => {
    const g = "core/ledger.py — 2 commits (Aug 18–19)";
    const text = renderBriefing(struct({
      recap: [
        { repo: "app", text: "one", evidence: "aaaa111", group: g },
        { repo: "app", text: "flat", evidence: "cccc333" },
        { repo: "app", text: "two", evidence: "bbbb222", group: g },   // non-adjacent member
      ],
    }));
    const lines = text.split("\n");
    const story = lines.findIndex((l) => l.includes(g) && l.includes("•"));
    expect(story).toBeGreaterThan(-1);
    // both members nested DIRECTLY under the story line, hoisted above the flat entry
    expect(lines[story + 1]).toBe("      ◦ [app] one  (aaaa111)");
    expect(lines[story + 2]).toBe("      ◦ [app] two  (bbbb222)");
    expect(lines[story + 3]).toBe("   • [app] flat  (cccc333)");
    // exactly once each
    for (const sha of ["aaaa111", "bbbb222", "cccc333"]) {
      expect(lines.filter((l) => l.includes(sha)).length).toBe(1);
    }
  });

  test("an ungrouped struct renders the exact flat bullet shape (pre-T1.3), plus the count header", () => {
    const text = renderBriefing(struct({
      recap: [
        { repo: "app", text: "one", evidence: "aaaa111" },
        { repo: "app", text: "two", evidence: "bbbb222" },
      ],
    }));
    const lines = text.split("\n");
    expect(lines).toContain("▶ What you did — 2 commits");
    expect(lines).toContain("   • [app] one  (aaaa111)");
    expect(lines).toContain("   • [app] two  (bbbb222)");
    expect(text).not.toContain("◦");
  });

  test("singular count header; empty recap keeps the plain header and placeholder", () => {
    expect(renderBriefing(struct({ recap: [{ repo: "a", text: "x" }] }))).toContain("▶ What you did — 1 commit\n");
    const empty = renderBriefing(struct({}));
    expect(empty).toContain("▶ What you did\n");
    expect(empty).toContain("(no commits in the window)");
  });

  test("windowMerges foot is label-grouped (stable sort), preserving in-label order", () => {
    const text = renderBriefing(struct({
      windowMerges: [
        { repo: "zeta", text: "🔀 Merged #2 (b) (Aug 19)  (bbbb222)" },
        { repo: "alpha", text: "🔀 Merged #1 (a) (Aug 18)  (aaaa111)" },
        { repo: "zeta", text: "🔀 Merged #3 (c) (Aug 20)  (cccc333)" },
      ],
    }));
    const idx = (n: string) => text.indexOf(n);
    expect(idx("#1")).toBeLessThan(idx("#2"));
    expect(idx("#2")).toBeLessThan(idx("#3"));   // stable within zeta
    // Since 2026-09-24 (S3b) each label is ONE collapsed line, PRs and SHAs in the struct's order,
    // dates as a chronological range — see test/merge-foot-collapse.test.ts.
    const lines = text.split("\n");
    const alpha = lines.indexOf("   • [alpha] 🔀 1 PR merged (#1) (Aug 18)  (aaaa111)");
    expect(alpha).toBeGreaterThan(-1);
    expect(lines[alpha + 1]).toBe("   • [zeta] 🔀 2 PRs merged (#2, #3) (Aug 19–Aug 20)  (bbbb222, cccc333)");
    expect(text).not.toContain("🔀 Merged #");
  });
});

describe("audit invariance — the constraint-2 pin", () => {
  const g = "f.ts — 2 commits (Aug 18)";
  const flat = struct({
    recap: [
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
      { repo: "other", text: "three", evidence: "cccc333" },
    ],
  });
  const clustered = struct({
    recap: [
      { repo: "app", text: "one", evidence: "aaaa111", group: g },
      { repo: "app", text: "two", evidence: "bbbb222", group: g },
      { repo: "other", text: "three", evidence: "cccc333" },
    ],
  });

  test("extractCitedShas, missingSameDay and coverageGaps are identical on clustered vs flat renders", () => {
    const a = renderBriefing(flat), b = renderBriefing(clustered);
    expect(new Set(extractCitedShas(b))).toEqual(new Set(extractCitedShas(a)));
    const day = ["aaaa111", "bbbb222", "cccc333", "dddd444"];
    expect(missingSameDay(day, b)).toEqual(missingSameDay(day, a));
    const repos = [{ repo: "/r", labels: ["app", "other"], commits: 3 }];
    expect(coverageGaps(repos as never, b)).toEqual(coverageGaps(repos as never, a));
  });
});

describe("unitForFiles — the extracted plurality vote", () => {
  test("unique plurality wins; even tie returns null (catch-all); empty returns null", () => {
    expect(unitForFiles(["sub/a.ts", "sub/b.ts", "other/c.ts"], ["sub", "other"])).toBe("sub");
    expect(unitForFiles(["sub/a.ts", "other/c.ts"], ["sub", "other"])).toBe(null);
    expect(unitForFiles([], ["sub"])).toBe(null);
  });

  test("unitForCommit still delegates (behaviour-preserving extraction)", () => {
    const a = commit("aaaa111", "/r", [{ file: "sub/a.ts", added: 1, removed: 0 }, { file: "sub/b.ts", added: 1, removed: 0 }, { file: "x.ts", added: 1, removed: 0 }], d18);
    expect(unitForCommit(a, ["sub"])).toBe("sub");
  });
});

describe("listPrMerges — first-parent files", () => {
  test("a PR merge carries the branch's files (first-parent numstat)", async () => {
    const day = (h: number) => new Date(2026, 6, 6, h, 0).toISOString();
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: day(9) }]);
    await branchCommit(repo, "feat-cool", "sub/f.txt", day(10));
    await mergeBranchWith(repo, "feat-cool", "Merge pull request #42 from acme/feat/cool-thing", day(11));
    const merges = await listPrMerges(repo, localMidnight(new Date(2026, 6, 6)), localMidnight(new Date(2026, 6, 7)), { emails: ["test@example.com"] });
    expect(merges.length).toBe(1);
    expect(merges[0]!.files).toEqual(["sub/f.txt"]);
  });
});

describe("merge attribution — runCore integration", () => {
  test("a PR merge whose files sit under a configured sub-project root carries that unit's label in Today-so-far AND the window foot", async () => {
    const yesterday = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };
    const today = () => { const d = new Date(); d.setHours(8, 0, 0, 0); return d.toISOString(); };
    const dir = await buildRepo([{ file: "sub/w.ts", content: "x", isoDate: yesterday() }]);
    // yesterday's in-window PR merge → windowMerges; today's → Today-so-far. Both under sub/.
    await branchCommit(dir, "feat-a", "sub/a.txt", yesterday());
    await mergeBranchWith(dir, "feat-a", "Merge pull request #7 from o/feat/a", new Date(Date.parse(yesterday()) + 3600e3).toISOString());
    await branchCommit(dir, "feat-b", "sub/b.txt", today());
    await mergeBranchWith(dir, "feat-b", "Merge pull request #8 from o/feat/b", new Date(Date.parse(today()) + 3600e3).toISOString());
    const cfg: Config = {
      repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
      provider: { cli: "echo", argv: [], promptVia: "stdin" },
      subprojects: [{ repo: dir, roots: ["sub"] }],
    };
    const stub: Provider = { generate: async () => "## RESUME\n- [x] r\n## RECAP\n- [x] c | evidence: HEAD\n## SUGGESTIONS\n- n" };
    const r = await runCore(cfg, { provider: stub, netProbe: async () => true });
    const subUnit = r.units.find((u) => u.root === "sub");
    expect(subUnit).toBeDefined();
    const todayMerge = (r.struct.today ?? []).find((t) => t.text.includes("Merged #8"));
    expect(todayMerge).toBeDefined();
    expect(todayMerge!.repo).toBe(subUnit!.label);           // NOT the bare repo label
    const windowMerge = (r.struct.windowMerges ?? []).find((m) => m.text.includes("Merged #7"));
    expect(windowMerge).toBeDefined();
    expect(windowMerge!.repo).toBe(subUnit!.label);
  });
});

// ── Fix-round pins (review MED-2 / MED-3 / M5 / MED-1) ───────────────────────────────────────────
describe("fix-round pins", () => {
  // MED-2: a decorated member inside a cluster must still render (the nest predicate is norm-based;
  // mutant `m.repo === r.repo` silently LOST the decorated bullet — worst failure class).
  test("render: a cluster mixing decorated and bare labels emits every member exactly once", () => {
    const g = "f.ts — 2 commits (Aug 18)";
    const text = renderBriefing(struct({
      recap: [
        { repo: "app", text: "bare", evidence: "aaaa111", group: g },
        { repo: "**app**", text: "decorated", evidence: "bbbb222", group: g },
      ],
    }));
    const lines = text.split("\n");
    expect(lines.filter((l) => l.includes("aaaa111")).length).toBe(1);
    expect(lines.filter((l) => l.includes("bbbb222")).length).toBe(1);   // the mutant drops this one
    expect(lines.filter((l) => l.includes(g)).length).toBe(1);           // one story line, not two
  });

  // MED-3: the todaySuppress mergeLabel site — reverting it to repoLabelFor survived the suite.
  // Pinned through runCore's returned todaySuppress (the DONE-block/freshness join keys on label).
  test("runCore: todaySuppress labels a today PR merge by unit, not bare repo", async () => {
    const today = () => { const d = new Date(); d.setHours(8, 0, 0, 0); return d.toISOString(); };
    const yesterday = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };
    const dir = await buildRepo([{ file: "sub/w.ts", content: "x", isoDate: yesterday() }]);
    await branchCommit(dir, "feat-c", "sub/c.txt", today());
    await mergeBranchWith(dir, "feat-c", "Merge pull request #9 from o/feat/c", new Date(Date.parse(today()) + 3600e3).toISOString());
    const cfg: Config = {
      repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
      provider: { cli: "echo", argv: [], promptVia: "stdin" },
      subprojects: [{ repo: dir, roots: ["sub"] }],
    };
    const stub: Provider = { generate: async () => "## RESUME\n- [x] r\n## RECAP\n- [x] c | evidence: HEAD\n## SUGGESTIONS\n- n" };
    const r = await runCore(cfg, { provider: stub, netProbe: async () => true });
    const subUnit = r.units.find((u) => u.root === "sub");
    expect(subUnit).toBeDefined();
    const suppress = (r.todaySuppress ?? []).find((d) => d.subject.includes("Merged #9"));
    expect(suppress).toBeDefined();
    expect(suppress!.label).toBe(subUnit!.label);
  });

  // M5: the --diff-merges fallback path had zero coverage. A shimmed git that rejects the flag must
  // yield file-less merges (fail open), not a thrown briefing. Bun.spawn does NOT re-resolve
  // executables from a mutated process.env.PATH (probed), so the shim must apply at CHILD-process
  // level: run listPrMerges in a `bun -e` child whose PATH leads with the shim dir.
  test("listPrMerges falls open to file-less merges when git rejects --diff-merges", async () => {
    const day = (h: number) => new Date(2026, 6, 6, h, 0).toISOString();
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: day(9) }]);
    await branchCommit(repo, "feat-old", "f.txt", day(10));
    await mergeBranchWith(repo, "feat-old", "Merge pull request #5 from o/feat/old", day(11));
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const shimDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "git-shim-")));
    const realGit = (await Bun.$`which git`.text()).trim();
    writeFileSync(join(shimDir, "git"), `#!/bin/sh
for a in "$@"; do case "$a" in --diff-merges=*) echo "error: unknown option" >&2; exit 129;; esac; done
exec "${realGit}" "$@"
`);
    chmodSync(join(shimDir, "git"), 0o755);
    const gitTs = resolve(import.meta.dir, "../src/git.ts");
    const script = `
      const { listPrMerges } = await import(${JSON.stringify(gitTs)});
      const { localMidnight } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/time.ts"))});
      const merges = await listPrMerges(${JSON.stringify(repo)}, localMidnight(new Date(2026, 6, 6)), localMidnight(new Date(2026, 6, 7)), { emails: ["test@example.com"] });
      console.log(JSON.stringify(merges.map((m) => ({ prNum: m.prNum, files: m.files }))));
    `;
    const p = Bun.spawn(["bun", "-e", script], {
      cwd: import.meta.dir,
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
      stdout: "pipe", stderr: "pipe",
    });
    await p.exited;
    const out = (await new Response(p.stdout).text()).trim();
    expect(p.exitCode).toBe(0);
    expect(JSON.parse(out)).toEqual([{ prNum: "5", files: [] }]);
  });

  // MED-1: non-ASCII path survives listPrMerges' numstat (quotePath parity with listCommits).
  test("listPrMerges returns non-ASCII merge files raw, not octal-escaped", async () => {
    const day = (h: number) => new Date(2026, 6, 6, h, 0).toISOString();
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: day(9) }]);
    await branchCommit(repo, "feat-uni", "café/f.txt", day(10));
    await mergeBranchWith(repo, "feat-uni", "Merge pull request #6 from o/feat/uni", day(11));
    const merges = await listPrMerges(repo, localMidnight(new Date(2026, 6, 6)), localMidnight(new Date(2026, 6, 7)), { emails: ["test@example.com"] });
    expect(merges[0]!.files).toEqual(["café/f.txt"]);
  });

  // LOW-2: duplicate citations of one commit must not inflate the story count.
  test("clusterRecap counts distinct commits, not member bullets", () => {
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
      commit("bbbb222", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "one again", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toBe("f.ts — 2 commits (Aug 18)");   // 3 bullets, 2 commits
  });
});
