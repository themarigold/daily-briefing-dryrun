// test/day53-cluster-churn.test.ts — the day-53 grouping-header defect. `clusterRecap` stamps a
// cluster with the file it grouped on and a count of the commits IN THAT CLUSTER, but a commit
// joins only when the file is its DOMINANT one. On day 53 the header read
// "accountant_ai/core/duplicates.py — 2 commits" while FIVE in-window commits touched that file.
// The three it hid were 80f0803 — identity made required to auto-book, a gate behaviour change —
// and the two review rounds on the same file, 30a1b36 and 9b14ef4. (The drifted-third-copy commit
// ff2cc61 was NOT among them: it was a cluster MEMBER, rendered on the line below the header. An
// earlier draft of this file, of the code comment, and of the commit message all named it as
// hidden — on a change whose whole subject is a line claiming more than it counted.)
//
// The count was never wrong for what it counted. The LABEL was: "<file> — N commits" reads as that
// file's churn. Same ruling the file already made twice — `nCommits` over member bullets, and
// `recapCoverage`'s shown/total over a bullet count against a commit total.
import { test, expect, describe } from "bun:test";
import { clusterRecap } from "../src/generator";
import type { ReducedContext, Activity } from "../src/types";

const commit = (sha: string, repo: string, diffstat: { file: string; added: number; removed: number }[], iso: string): Activity =>
  ({ source: "git", kind: "commit", event_id: sha, repo, timestamp: iso, text: `c-${sha}`, meta: { diffstat } });

const ctxOf = (acts: Activity[], repo = "/r"): ReducedContext => ({ repos: [{ repo, summary: "", activities: acts }] });

const d6 = "2026-09-06T10:00:00-07:00";

describe("clusterRecap — the header counts what its label claims", () => {
  test("non-dominant commits touching the file widen the denominator", () => {
    // Two commits led by dup.py (the cluster), three more that touch it while leading elsewhere.
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "dup.py", added: 30, removed: 2 }], d6),
      commit("bbbb222", "/r", [{ file: "dup.py", added: 20, removed: 1 }], d6),
      commit("cccc333", "/r", [{ file: "router.py", added: 90, removed: 0 }, { file: "dup.py", added: 3, removed: 0 }], d6),
      commit("dddd444", "/r", [{ file: "ledger.py", added: 80, removed: 0 }, { file: "dup.py", added: 2, removed: 0 }], d6),
      commit("eeee555", "/r", [{ file: "match.py", added: 70, removed: 0 }, { file: "dup.py", added: 1, removed: 0 }], d6),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
      { repo: "app", text: "three", evidence: "cccc333" },
      { repo: "app", text: "four", evidence: "dddd444" },
      { repo: "app", text: "five", evidence: "eeee555" },
    ], ctx);
    expect(out[0]!.group).toBe("dup.py — 2 of 5 commits touching it (grouped: Sep 6)");
    expect(out[1]!.group).toBe(out[0]!.group);
    // The three non-dominant commits are NOT members — each led a different file, so none clusters.
    expect(out[2]!.group).toBeUndefined();
    expect(out[3]!.group).toBeUndefined();
    expect(out[4]!.group).toBeUndefined();
    // Still presentation-only.
    expect(out.map((e) => e.text)).toEqual(["one", "two", "three", "four", "five"]);
    expect(out.map((e) => e.evidence)).toEqual(["aaaa111", "bbbb222", "cccc333", "dddd444", "eeee555"]);
  });

  test("a same-path file in a DIFFERENT repo does not inflate the denominator", () => {
    // Repo-relative paths collide constantly across a multi-repo window ("src/index.ts").
    const ctx: ReducedContext = {
      repos: [
        { repo: "/r", summary: "", activities: [
          commit("aaaa111", "/r", [{ file: "dup.py", added: 10, removed: 0 }], d6),
          commit("bbbb222", "/r", [{ file: "dup.py", added: 10, removed: 0 }], d6),
        ] },
        { repo: "/other", summary: "", activities: [
          commit("cccc333", "/other", [{ file: "x.py", added: 90, removed: 0 }, { file: "dup.py", added: 1, removed: 0 }], d6),
          commit("dddd444", "/other", [{ file: "y.py", added: 90, removed: 0 }, { file: "dup.py", added: 1, removed: 0 }], d6),
        ] },
      ],
    };
    ctx.repos[0]!.activities.push(
      commit("eeee555", "/r", [{ file: "z.py", added: 90, removed: 0 }, { file: "dup.py", added: 1, removed: 0 }], d6),
    );
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ], ctx);
    // 3 = the two members plus eeee555, all in /r. The two /other commits touch a path spelled the
    // same way and must not appear — a dead denominator would render the bare count here, and a
    // repo-blind one "2 of 5", so this discriminates in both directions.
    expect(out[0]!.group).toBe("dup.py — 2 of 3 commits touching it (grouped: Sep 6)");
  });

  test("a repeated event_id is counted ONCE in the denominator", () => {
    // Defensive, and known to be: `dedupeSharedRefs` (extractor.ts) keys on `event_id` across every
    // repo before `reduce`, so production `commits` cannot hold a SHA twice today. This pins the
    // guard against a future producer that skips that path. (An earlier version of this comment
    // justified it with a commit falling under two configured roots, citing `recapCoverage` — wrong
    // on both legs: `listCommits` runs once per REPO, not per root, and that residual describes a
    // second clone or worktree and marks itself UNVERIFIED. The code comment retracts it; this one
    // did not, until the final verify round caught the two sites disagreeing.)
    // Here dddd444 appears twice: two members + one twice-listed non-member must read "2 of 3".
    const dup = { file: "dup.py", added: 5, removed: 0 };
    const twice = (sha: string) => commit(sha, "/r", [{ file: "big.py", added: 90, removed: 0 }, dup], d6);
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "dup.py", added: 30, removed: 0 }], d6),
      commit("bbbb222", "/r", [{ file: "dup.py", added: 20, removed: 0 }], d6),
      twice("dddd444"), twice("dddd444"),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toBe("dup.py — 2 of 3 commits touching it (grouped: Sep 6)");
  });

  test("the numerator counts distinct COMMITS on the widened branch too, not bullets", () => {
    // `nCommits` exists because the model can cite one commit in two bullets. Day 36 pins that on
    // the bare branch, where its fixture necessarily has denominator === numerator; nothing pinned
    // it on the widened branch, where using members.length would render "3 of 3" for 2 commits.
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "dup.py", added: 30, removed: 0 }], d6),
      commit("bbbb222", "/r", [{ file: "dup.py", added: 20, removed: 0 }], d6),
      commit("cccc333", "/r", [{ file: "big.py", added: 90, removed: 0 }, { file: "dup.py", added: 1, removed: 0 }], d6),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
      { repo: "app", text: "two again", evidence: "bbbb222" },   // same commit, second bullet
    ], ctx);
    expect(out[0]!.group).toBe("dup.py — 2 of 3 commits touching it (grouped: Sep 6)");
    expect(out[2]!.group).toBe(out[0]!.group);
  });

  test("repo-less members never widen — `undefined === undefined` would match every repo-less commit", () => {
    // Activity.repo is optional. Without the real-string guard, `sameRepo` passes on undefined and
    // the filter matches every repo-less commit in the window, collapsing repos that share a path.
    const noRepo = (sha: string, diffstat: { file: string; added: number; removed: number }[]): Activity =>
      ({ source: "git", kind: "commit", event_id: sha, timestamp: d6, text: `c-${sha}`, meta: { diffstat } });
    const ctx: ReducedContext = {
      repos: [{ repo: "(unknown)", summary: "", activities: [
        noRepo("aaaa111", [{ file: "src/index.ts", added: 30, removed: 0 }]),
        noRepo("bbbb222", [{ file: "src/index.ts", added: 20, removed: 0 }]),
        noRepo("cccc333", [{ file: "big.ts", added: 90, removed: 0 }, { file: "src/index.ts", added: 1, removed: 0 }]),
        noRepo("dddd444", [{ file: "huge.ts", added: 90, removed: 0 }, { file: "src/index.ts", added: 1, removed: 0 }]),
      ] }],
    };
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toBe("src/index.ts — 2 commits (Sep 6)");
  });

  test("members spanning two repos fall back to the bare count", () => {
    // The cluster key is the bullet's LABEL, and one label can carry commits from two repos, so a
    // cluster's members are not guaranteed to share a repo. The denominator has no repo to scope
    // by then, and the advertised fallback is the branch that says so.
    const ctx: ReducedContext = {
      repos: [
        { repo: "/r", summary: "", activities: [
          commit("aaaa111", "/r", [{ file: "src/index.ts", added: 30, removed: 0 }], d6),
          commit("cccc333", "/r", [{ file: "big.ts", added: 90, removed: 0 }, { file: "src/index.ts", added: 1, removed: 0 }], d6),
          commit("dddd444", "/r", [{ file: "huge.ts", added: 90, removed: 0 }, { file: "src/index.ts", added: 1, removed: 0 }], d6),
        ] },
        { repo: "/other", summary: "", activities: [
          commit("bbbb222", "/other", [{ file: "src/index.ts", added: 20, removed: 0 }], d6),
        ] },
      ],
    };
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toBe("src/index.ts — 2 commits (Sep 6)");
  });

  test("two clusters on one repo+file never both quote the shared denominator", () => {
    // One repo hosts several labels (this deployment renders accountant_ai and
    // daily_briefing_application as areas of repo personal_code), and the cluster key is the label
    // while the denominator is scoped by the repo. Two headers quoting "of 5" over the same file
    // are each true alone and double-count when a reader sums them.
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "dup.py", added: 30, removed: 0 }], d6),
      commit("bbbb222", "/r", [{ file: "dup.py", added: 29, removed: 0 }], d6),
      commit("cccc333", "/r", [{ file: "dup.py", added: 28, removed: 0 }], d6),
      commit("dddd444", "/r", [{ file: "dup.py", added: 27, removed: 0 }], d6),
      commit("eeee555", "/r", [{ file: "big.py", added: 90, removed: 0 }, { file: "dup.py", added: 1, removed: 0 }], d6),
    ]);
    const out = clusterRecap([
      { repo: "lane-a", text: "one", evidence: "aaaa111" },
      { repo: "lane-a", text: "two", evidence: "bbbb222" },
      { repo: "lane-b", text: "three", evidence: "cccc333" },
      { repo: "lane-b", text: "four", evidence: "dddd444" },
    ], ctx);
    // Both clusters are real and both still group; neither claims the 5.
    expect(out[0]!.group).toBe("dup.py — 2 commits (Sep 6)");
    expect(out[2]!.group).toBe("dup.py — 2 commits (Sep 6)");
  });

  test("a CROSS-repo cluster does not suppress a legitimate sibling on the same path", () => {
    // Only same-repo clusters can collide over a denominator — a cross-repo one can never widen.
    // Tallying it under its first member's repo cost lane-a its true "2 of 4" (verify round).
    const ctx: ReducedContext = {
      repos: [
        { repo: "/r", summary: "", activities: [
          commit("aaaa111", "/r", [{ file: "dup.py", added: 30, removed: 0 }], d6),
          commit("bbbb222", "/r", [{ file: "dup.py", added: 29, removed: 0 }], d6),
          commit("cccc333", "/r", [{ file: "big.py", added: 90, removed: 0 }, { file: "dup.py", added: 1, removed: 0 }], d6),
          commit("dddd444", "/r", [{ file: "huge.py", added: 90, removed: 0 }, { file: "dup.py", added: 1, removed: 0 }], d6),
          commit("eeee555", "/r", [{ file: "dup.py", added: 28, removed: 0 }], d6),
        ] },
        { repo: "/o", summary: "", activities: [
          commit("ffff666", "/o", [{ file: "dup.py", added: 27, removed: 0 }], d6),
        ] },
      ],
    };
    const out = clusterRecap([
      { repo: "lane-a", text: "one", evidence: "aaaa111" },
      { repo: "lane-a", text: "two", evidence: "bbbb222" },
      { repo: "lane-x", text: "three", evidence: "eeee555" },   // /r
      { repo: "lane-x", text: "four", evidence: "ffff666" },    // /o — spans repos
    ], ctx);
    expect(out[0]!.group).toBe("dup.py — 2 of 5 commits touching it (grouped: Sep 6)");
    expect(out[2]!.group).toBe("dup.py — 2 commits (Sep 6)");   // cross-repo: bare, as advertised
  });

  test("a commit with no diffstat cannot enter the denominator", () => {
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "dup.py", added: 10, removed: 0 }], d6),
      commit("bbbb222", "/r", [{ file: "dup.py", added: 10, removed: 0 }], d6),
      { source: "git", kind: "commit", event_id: "cccc333", repo: "/r", timestamp: d6, text: "c-cccc333" },
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toBe("dup.py — 2 commits (Sep 6)");
  });
});
