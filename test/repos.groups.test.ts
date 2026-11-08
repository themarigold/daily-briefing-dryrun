// test/repos.groups.test.ts — B1-M2-T5 (wave-2 plan): the groups for a project, and the order rows are
// drawn in. Scratch repos built per test under a per-test global config (fixtures/repos-fixtures.ts).
import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { startGitBudget, resetWindowArgsCacheForTests } from "../src/git";
import { hardenArgs } from "../src/repos/harden";
import type { RepoGit } from "../src/repos/hgit";
import { openScan, groupLabel, orderRows, prTitle, PR_TITLE_MAX, refsContaining, type Row, type LabelCommit } from "../src/repos/groups";
import { g, isolatedGit, newRepo, withGit, commitAt, armHostile, signCommits, runControls, scratch } from "./fixtures/repos-fixtures";

const LAZY = { lazyFetch: true };
const WINDOW = new Date("2026-01-01T00:00:00Z");
async function rgFor(repo: string): Promise<RepoGit> {
  const budget = startGitBudget(60_000);
  const h = await hardenArgs(repo, budget, LAZY);
  if ("unknown" in h) throw new Error(`unknown: ${h.unknown}`);
  return { repo, lead: h.lead, budget };
}
const page = (...shas: string[]): LabelCommit[] => shas.map((sha) => ({ sha, token: sha.slice(0, 7) }));
const day = (d: number, h = 10) => `2026-01-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`;
/** The rows as comparable values: kind, the shown name or PR, and the SHAs in row order. */
function shape(rows: Row[]): unknown[] {
  return rows.map((r) => {
    const shas = r.commits.map((c) => c.sha);
    switch (r.kind) {
      case "pr": return ["pr", r.number, r.title, shas];
      case "branch": case "remoteBranch": return [r.kind, r.name, shas];
      case "default": case "tag": return [r.kind, r.name, shas];
      default: return [r.kind, shas];
    }
  });
}
async function groups(env: Record<string, string>, repo: string, commits: LabelCommit[], opts: { now?: Date; squashed?: Parameters<typeof groupLabel>[2] } = {}) {
  return withGit(env, async () => groupLabel(openScan(await rgFor(repo), WINDOW, opts.now ?? new Date()), commits, opts.squashed));
}

describe("merged PRs", () => {
  test("a merge-commit PR: its members group under PR #N, the title from the merge's body, newest first", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    await g(repo, ["checkout", "-q", "-b", "feat"], env);
    const f1 = await commitAt(repo, env, { "a.txt": "1\n" }, "f1", day(5));
    const f2 = await commitAt(repo, env, { "a.txt": "2\n" }, "f2", day(6));
    await g(repo, ["checkout", "-q", "main"], env);
    await g(repo, ["merge", "-q", "--no-ff", "-m", "Merge pull request #12 from me/feat", "-m", "\nAdd the feature\n\nmore words", "feat"], env, { GIT_COMMITTER_DATE: day(7), GIT_AUTHOR_DATE: day(7) });
    await g(repo, ["branch", "-D", "feat"], env);
    const { result } = await groups(env, repo, page(f1, f2));
    expect(shape(result)).toEqual([["pr", 12, "Add the feature", [f2, f1]]]);
  });

  test("a PR merged after the window still groups (the merge scan runs to now); one merged before the window does not", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    await g(repo, ["checkout", "-q", "-b", "late"], env);
    const l1 = await commitAt(repo, env, { "l.txt": "1\n" }, "l1", day(5));
    await g(repo, ["checkout", "-q", "-b", "early", "main"], env);
    const e1 = await commitAt(repo, env, { "e.txt": "1\n" }, "e1", day(2));
    await g(repo, ["checkout", "-q", "main"], env);
    await g(repo, ["merge", "-q", "--no-ff", "-m", "Merge pull request #2 from me/early", "early"], env, { GIT_COMMITTER_DATE: "2025-12-21T10:00:00Z" });
    const later = new Date(Date.now() - 3_600_000).toISOString();
    await g(repo, ["merge", "-q", "--no-ff", "-m", "Merge pull request #3 from me/late", "late"], env, { GIT_COMMITTER_DATE: later });
    await g(repo, ["branch", "-D", "late", "early"], env);
    const { result } = await groups(env, repo, page(l1, e1));
    expect(shape(result)).toEqual([["pr", 3, "", [l1]], ["default", "main", [e1]]]);
  });

  test("a squash PR with its branch deleted and pruned: the (#N) commit is the PR row, the originals no longer on a branch", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    await g(repo, ["checkout", "-q", "-b", "sq"], env);
    const o1 = await commitAt(repo, env, { "s.txt": "1\n" }, "o1", day(5));
    await g(repo, ["checkout", "-q", "main"], env);
    const s = await commitAt(repo, env, { "s.txt": "1\n" }, "Add the thing (#7)", day(6));
    await g(repo, ["branch", "-D", "sq"], env);
    const { result } = await groups(env, repo, page(s, o1));
    expect(shape(result)).toEqual([["pr", 7, "Add the thing", [s]], ["orphan", [o1]]]);
  });

  test("a squash commit that is itself a page commit, with the kept branch's originals: one PR row, each commit once", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    await g(repo, ["checkout", "-q", "-b", "kept"], env);
    const o1 = await commitAt(repo, env, { "k.txt": "1\n" }, "o1", day(5));
    const o2 = await commitAt(repo, env, { "k.txt": "2\n" }, "o2", day(6));
    await g(repo, ["checkout", "-q", "main"], env);
    const s = await commitAt(repo, env, { "k.txt": "2\n" }, "Kept work (#9)", day(7));
    const squashed = new Map([["refs/heads/kept", { number: 9, sha: s, title: "Kept work" }]]);
    const { result } = await groups(env, repo, page(o1, s, o2), { squashed });
    expect(shape(result)).toEqual([["pr", 9, "Kept work", [s, o2, o1]]]);
  });

  test("the (#N) window: a (#N) commit a day before the window start is not a candidate, with and without --since-as-filter", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const s = await commitAt(repo, env, { "w.txt": "1\n" }, "Before the window (#4)", "2025-12-31T00:00:00Z");
    expect(shape((await groups(env, repo, page(s))).result)).toEqual([["default", "main", [s]]]);
    // an old git: no pre-filter at all, so the JS window decides alone
    resetWindowArgsCacheForTests();
    const oldGit = (argv: string[]) => (argv.length === 2 && argv[1] === "--version" ? ["sh", "-c", "echo 'git version 2.36.0'"] : undefined);
    const { result, calls } = await withGit(env, async () => groupLabel(openScan(await rgFor(repo), WINDOW, new Date()), page(s)), oldGit);
    expect(shape(result)).toEqual([["default", "main", [s]]]);
    expect(calls.flat().some((a) => a.startsWith("--since-as-filter"))).toBe(false);
    resetWindowArgsCacheForTests();
  });
});

describe("branches, main, tags, detached HEAD, no ref", () => {
  test("stacked branches (the nearest tip wins), commits on main, an unmerged branch, a tag-only commit, a detached HEAD and an orphan: each once", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const m1 = await commitAt(repo, env, { "m.txt": "1\n" }, "m1", day(4));
    await g(repo, ["checkout", "-q", "-b", "a"], env);
    const a1 = await commitAt(repo, env, { "a.txt": "1\n" }, "a1", day(5));
    await g(repo, ["checkout", "-q", "-b", "b"], env);
    const b1 = await commitAt(repo, env, { "b.txt": "1\n" }, "b1", day(6));
    // a tag-only commit, two tags (the first by name in byte order wins)
    await g(repo, ["checkout", "-q", "--detach", "main"], env);
    const t1 = await commitAt(repo, env, { "t.txt": "1\n" }, "t1", day(7));
    await g(repo, ["tag", "v2", t1], env);
    await g(repo, ["tag", "v10", t1], env);
    // an orphan
    const o1 = await commitAt(repo, env, { "o.txt": "1\n" }, "o1", day(8));
    // a detached HEAD holding d1
    await g(repo, ["checkout", "-q", "--detach", "main"], env);
    const d1 = await commitAt(repo, env, { "d.txt": "1\n" }, "d1", day(9));
    void o1;
    const { result } = await groups(env, repo, page(m1, a1, b1, t1, d1, o1));
    expect(shape(result)).toEqual([
      ["branch", "a", [a1]], ["branch", "b", [b1]], ["default", "main", [m1]],
      ["tag", "v10", [t1]], ["detached", [d1]], ["orphan", [o1]],
    ]);
  });

  test("two branches at one tip: the tie goes to the name first in byte order", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    await g(repo, ["checkout", "-q", "-b", "abc"], env);
    const z = await commitAt(repo, env, { "z.txt": "1\n" }, "z", day(5));
    await g(repo, ["branch", "Zed", z], env);           // "Z" (0x5A) sorts before "a" (0x61) in byte order
    const { result } = await groups(env, repo, page(z));
    expect(shape(result)).toEqual([["branch", "Zed", [z]]]);
  });

  test("a branch deleted locally with its remote-tracking ref left: a blue branch origin/{name} row", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const bare = join(scratch("remote"), "o.git");
    await g(scratch("cwd"), ["init", "-q", "--bare", bare], env);
    await g(repo, ["remote", "add", "origin", bare], env);
    await g(repo, ["push", "-q", "origin", "main"], env);
    await g(repo, ["checkout", "-q", "-b", "gone-local"], env);
    const r1 = await commitAt(repo, env, { "r.txt": "1\n" }, "r1", day(5));
    await g(repo, ["push", "-q", "origin", "gone-local"], env);
    await g(repo, ["checkout", "-q", "main"], env);
    await g(repo, ["branch", "-D", "gone-local"], env);
    const { result } = await groups(env, repo, page(r1));
    expect(shape(result)).toEqual([["remoteBranch", "origin/gone-local", [r1]]]);
  });

  test("two labels in one repo get their own groups; a sub-project label's commits group like any other", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const top = await commitAt(repo, env, { "top.txt": "1\n" }, "top", day(4));
    await g(repo, ["checkout", "-q", "-b", "sub-work"], env);
    const sub = await commitAt(repo, env, { "pkg/sub/x.txt": "1\n" }, "sub", day(5));
    const { result } = await withGit(env, async () => {
      const scan = openScan(await rgFor(repo), WINDOW, new Date());
      return [await groupLabel(scan, page(top)), await groupLabel(scan, page(sub))];
    });
    expect(shape(result[0]!)).toEqual([["default", "main", [top]]]);
    expect(shape(result[1]!)).toEqual([["branch", "sub-work", [sub]]]);
  });

  test("a hidden commit ({ sha, token: null, subject }) groups with the page's", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const a = await commitAt(repo, env, { "a.txt": "1\n" }, "a", day(4));
    const b = await commitAt(repo, env, { "b.txt": "1\n" }, "b", day(5));
    const { result } = await groups(env, repo, [{ sha: a, token: a.slice(0, 7) }, { sha: b, token: null, subject: "b" }]);
    expect(result).toEqual([{ kind: "default", name: "main", commits: [{ sha: b, token: null, subject: "b" }, { sha: a, token: a.slice(0, 7) }] }]);
  });
});

describe("names and titles are redacted, titles clipped after", () => {
  const CRED = "ghp_AbCdEfGhIjKlMnOpQrStUv123456";
  test("a credential-shaped branch, tag and PR title read [redacted]", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    await g(repo, ["checkout", "-q", "-b", CRED], env);
    const b1 = await commitAt(repo, env, { "b.txt": "1\n" }, "b1", day(5));
    await g(repo, ["checkout", "-q", "--detach", "main"], env);
    const t1 = await commitAt(repo, env, { "t.txt": "1\n" }, "t1", day(6));
    await g(repo, ["tag", CRED, t1], env);
    await g(repo, ["checkout", "-q", "main"], env);
    const s = await commitAt(repo, env, { "s.txt": "1\n" }, `Rotate ${CRED} (#5)`, day(7));
    const { result } = await groups(env, repo, page(b1, t1, s));
    expect(shape(result)).toEqual([["pr", 5, "Rotate [redacted]", [s]], ["branch", "[redacted]", [b1]], ["tag", "[redacted]", [t1]]]);
    // every SHOWN field is redacted (a branch row's `ref` is internal, for the push state, never sent)
    expect(JSON.stringify(result.map((r) => ({ ...r, ref: undefined })))).not.toContain("ghp_");
  });

  test("a 5 000-character PR title with a credential across its cut: redacted, then clipped to 200 with …", async () => {
    const raw = `${"x".repeat(190)} ${CRED} ${"y".repeat(4800)}`;
    const t = prTitle(raw);
    expect(PR_TITLE_MAX).toBe(200);
    expect(t.length).toBe(200);
    expect(t.endsWith("…")).toBe(true);
    expect(t).toBe(`${"x".repeat(190)} [redacted]`.slice(0, 199) + "…");
    expect(t).not.toContain("ghp_");
    // and through git: a squash subject of 5 000 characters
    const { env } = isolatedGit();
    const repo = await newRepo();
    const s = await commitAt(repo, env, { "s.txt": "1\n" }, `${raw} (#6)`, day(5));
    const { result } = await groups(env, repo, page(s));
    expect(result[0]).toMatchObject({ kind: "pr", number: 6, title: t });
  });
});

describe("argv safety: a branch named refs/heads/-n", () => {
  test("it groups, its row shows -n as text, and every revision in every argv is a full ref or a SHA after --end-of-options", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    await g(repo, ["checkout", "-q", "-b", "work"], env);
    const n1 = await commitAt(repo, env, { "n.txt": "1\n" }, "n1", day(5));
    await g(repo, ["update-ref", "refs/heads/-n", n1], env);
    await g(repo, ["checkout", "-q", "main"], env);
    await g(repo, ["branch", "-D", "work"], env);
    const { result, calls } = await groups(env, repo, page(n1));
    expect(shape(result)).toEqual([["branch", "-n", [n1]]]);
    expect(calls.flat()).not.toContain("-n");
    // every argv naming the ref names it in full, after --end-of-options
    for (const argv of calls.filter((a) => a.includes("refs/heads/-n"))) {
      expect(argv.indexOf("--end-of-options")).toBeGreaterThan(0);
      expect(argv.indexOf("refs/heads/-n")).toBeGreaterThan(argv.indexOf("--end-of-options"));
    }
    // and every one of B1's own listings (those with --end-of-options) carries only full refs and SHAs after it
    for (const argv of calls.filter((a) => a.includes("--end-of-options") && (a.includes("rev-list") || a.includes("log") || a.includes("for-each-ref")))) {
      const eoo = argv.indexOf("--end-of-options");
      expect(argv.slice(eoo + 1).every((a) => /^\^?refs\//.test(a) || /^[0-9a-f]{40}$/.test(a))).toBe(true);
    }
    expect(calls.some((a) => a.includes("rev-list") && a.includes("refs/heads/-n"))).toBe(true);
  });
});

describe("the row order (pure)", () => {
  const c = (sha: string) => ({ sha, token: sha.slice(0, 7) });
  test("PRs by number; branches pushed, then partly, then never pushed, each by name in byte order (remote-only counts as pushed); main; tags by name; detached; no longer on a branch", () => {
    const rows: Row[] = [
      { kind: "orphan", commits: [c("1".repeat(40))] },
      { kind: "detached", commits: [c("2".repeat(40))] },
      { kind: "tag", name: "v2", commits: [c("3".repeat(40))] },
      { kind: "tag", name: "V9", commits: [c("4".repeat(40))] },
      { kind: "default", name: "main", commits: [c("5".repeat(40))] },
      { kind: "branch", ref: "refs/heads/never", name: "never", commits: [c("6".repeat(40))] },
      { kind: "branch", ref: "refs/heads/partly", name: "partly", commits: [c("7".repeat(40))] },
      { kind: "branch", ref: "refs/heads/b-pushed", name: "b-pushed", commits: [c("8".repeat(40))] },
      { kind: "remoteBranch", ref: "refs/remotes/origin/a-remote", name: "origin/a-remote", commits: [c("9".repeat(40))] },
      { kind: "pr", number: 12, title: "", commits: [c("a".repeat(40))] },
      { kind: "pr", number: 3, title: "", commits: [c("b".repeat(40))] },
    ];
    const rank = (r: Row) => (r.kind === "branch" ? ({ never: 2, partly: 1 } as Record<string, number>)[r.name] ?? 0 : 0);
    expect(orderRows(rows, rank).map((r) => ("number" in r ? `#${r.number}` : "name" in r ? r.name : r.kind))).toEqual([
      "#3", "#12", "b-pushed", "origin/a-remote", "partly", "never", "main", "V9", "v2", "detached", "orphan",
    ]);
  });
});

describe("hostile repo: no repo-scoped program runs through T5's calls", () => {
  test("merges, members, the PR body, the (#N) and main listings, branch and tag lookups and the detached check run none of the armed programs; the controls run them", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo({ "f.txt": "base\n" });
    const base = (await g(repo, ["rev-parse", "HEAD"], env)).trim();
    const dir = scratch("hostile");
    await signCommits(repo, env, dir);
    await g(repo, ["checkout", "-q", "-b", "feat"], env);
    const f1 = await commitAt(repo, env, { "f.txt": "feat\n" }, "f1", day(5));
    await g(repo, ["checkout", "-q", "main"], env);
    await g(repo, ["merge", "-q", "--no-ff", "-m", "Merge pull request #1 from me/feat", "-m", "Body title", "feat"], env, { GIT_COMMITTER_DATE: day(6) });
    const s = await commitAt(repo, env, { "g.txt": "1\n" }, "Squashed (#2)", day(7));
    await g(repo, ["checkout", "-q", "-b", "side", "main~1"], env);
    const b1 = await commitAt(repo, env, { "f.txt": "side\n" }, "b1", day(8));
    await g(repo, ["checkout", "-q", "--detach", "main"], env);
    const t1 = await commitAt(repo, env, { "t.txt": "1\n" }, "t1", day(9));
    await g(repo, ["tag", "v1", t1], env);
    await g(repo, ["checkout", "-q", "--detach", "main"], env);
    const d1 = await commitAt(repo, env, { "d.txt": "1\n" }, "d1", day(10));
    await g(repo, ["checkout", "-q", "-b", "x", base], env);       // a sibling of f1 changing f.txt: the merge control's pair
    const x1 = await commitAt(repo, env, { "f.txt": "x\n" }, "x1", day(11));
    await g(repo, ["checkout", "-q", "--detach", d1], env);
    const hostile = await armHostile(repo, env, dir);
    const { result } = await groups(env, repo, page(f1, s, b1, t1, d1));
    expect(shape(result)).toEqual([
      ["pr", 1, "Body title", [f1]], ["pr", 2, "Squashed", [s]], ["branch", "side", [b1]], ["tag", "v1", [t1]], ["detached", [d1]],
    ]);
    expect(hostile.ran()).toEqual([]);
    await runControls(repo, env, { diff: [f1, b1], signed: s, merge: [f1, x1] });
    expect(hostile.ran()).toEqual(expect.arrayContaining(["gpg", "diff-command", "merge-driver"]));
  });
});


describe("B1-M2 checkpoint regressions", () => {
  test("a cited commit older than the listing slack still groups on main", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const old = await commitAt(repo, env, { "old.txt": "old\n" }, "old", "2025-12-01T10:00:00Z");
    const later = await commitAt(repo, env, { "later.txt": "later\n" }, "later", day(12));
    const { result, calls } = await groups(env, repo, page(old, later));
    expect(shape(result)).toEqual([["default", "main", [later, old]]]);
    expect(calls.some((a) => a.includes("--is-ancestor") && a.slice(-2).join(" ") === `${old} refs/heads/main`)).toBe(true);
  });

  test("a local fix/HEAD branch is a holder; a remote symbolic HEAD is skipped", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    await g(repo, ["checkout", "-q", "-b", "fix/HEAD"], env);
    const c = await commitAt(repo, env, { "fix.txt": "fix\n" }, "fix", day(12));
    await g(repo, ["update-ref", "refs/remotes/other/work", c], env);
    await g(repo, ["symbolic-ref", "refs/remotes/other/HEAD", "refs/remotes/other/work"], env);
    await g(repo, ["checkout", "-q", "main"], env);
    expect(shape((await groups(env, repo, page(c))).result)).toEqual([["branch", "fix/HEAD", [c]]]);
    await g(repo, ["branch", "-D", "fix/HEAD"], env);
    expect(shape((await groups(env, repo, page(c))).result)).toEqual([["remoteBranch", "other/work", [c]]]);
  });

  test("the PR title clip backs off a high surrogate at the cut", () => {
    expect(prTitle("x".repeat(198) + "😀tail")).toBe("x".repeat(198) + "…");
    expect(prTitle("x".repeat(197) + "😀tail")).toBe("x".repeat(197) + "😀…");
    expect(prTitle("x".repeat(198) + "😀")).toBe("x".repeat(198) + "😀");
  });

  test("chunked contains is the same sorted union as an unchunked query", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const shas: string[] = [];
    for (const name of ["z", "a", "m"]) {
      await g(repo, ["checkout", "-q", "-b", name, "main"], env);
      shas.push(await commitAt(repo, env, { [`${name}.txt`]: name }, name, day(12)));
    }
    const { result, calls } = await withGit(env, async () => {
      const rg = await rgFor(repo);
      const full = await refsContaining(rg, shas, ["refs/heads/"]);
      const chunked = await refsContaining(rg, [...shas, shas[0]!], ["refs/heads/"], 2);
      return { full, chunked };
    });
    expect(result.chunked).toEqual(result.full);
    expect(result.full).toEqual(["refs/heads/a", "refs/heads/m", "refs/heads/z"]);
    const queries = calls.filter((a) => a.includes("--contains"));
    expect(queries.map((a) => a.filter((x) => x === "--contains").length)).toEqual([3, 2, 2]);
  });

  test("tag holders are prefetched once for all leftovers, then checked without a window", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    await g(repo, ["checkout", "-q", "--detach", "main"], env);
    const a = await commitAt(repo, env, { "a.txt": "a" }, "a", day(12));
    await g(repo, ["tag", "v2", a], env);
    const b = await commitAt(repo, env, { "b.txt": "b" }, "b", day(13));
    await g(repo, ["tag", "v3", b], env);
    const orphan = await commitAt(repo, env, { "o.txt": "o" }, "o", day(14));
    await g(repo, ["checkout", "-q", "main"], env);
    const { result, calls } = await groups(env, repo, page(a, b, orphan));
    expect(shape(result)).toEqual([["tag", "v2", [a]], ["tag", "v3", [b]], ["orphan", [orphan]]]);
    const queries = calls.filter((a) => a.includes("for-each-ref") && a.includes("refs/tags/"));
    expect(queries).toHaveLength(1);
    expect(queries[0]!.filter((x) => x === "--contains")).toHaveLength(3);
  });
});
