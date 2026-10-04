import "./fixtures/isolate-state";   // armed before this file's first save, from any cwd (see test/fixtures/isolate-state.ts)
// test/core.discovery-blocked.test.ts — v0.2.1 §2.4.2 / §2.4.5 (plan T1.3), through the REAL runCore and
// the REAL discovery walk: the discovery summary on the empty-window path and (r7) on the provider path when
// the window has no commits, and the discovery-blocked rule.
// The shell half (exit code, stamp, last-skip detail, notifier, stderr order) is in test/main.test.ts.
//
// Unreadable folders are made with chmod 000 (the idiom test/main.test.ts already uses), which yields
// EACCES → `unreadable` on every platform; `tcc-denied` needs macOS TCC and is covered by the pure tests in
// test/discoverySummary.test.ts. Every chmod is undone in afterEach so the temp dirs can be removed.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, chmodSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCore, type RunDeps } from "../src/core";
import { discoverRepos, validateConfig } from "../src/config";
import { renderBriefing } from "../src/render";
import { warnFor } from "../src/protectedPath";
import { ProviderError, type Config, type Provider } from "../src/types";
import { buildRepo, branchCommit, mergeBranchWith } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const PROV = { cli: "echo", argv: [], promptVia: "stdin" as const };
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString();

const locked: string[] = [];
afterEach(() => { while (locked.length) chmodSync(locked.pop()!, 0o755); });

const tmp = (prefix: string) => removeAtRunEnd(mkdtempSync(join(tmpdir(), prefix)));
/** A directory this process cannot list. PREMISE-checked: a runner where chmod 000 does not deny (root)
 *  fails here, loudly, instead of every assertion below failing for an unrelated-looking reason. */
function lockedDir(path: string): string {
  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o000);
  locked.push(path);
  expect(() => readdirSync(path)).toThrow();
  return path;
}

let calls = 0;
const provider: Provider = { async generate() { calls++; return "## RESUME\n- [r] resume\n## RECAP\n- [r] did x | evidence: HEAD\n## SUGGESTIONS\n- next"; } };
const deps: RunDeps = { provider, netProbe: async () => true, powerPlatform: "linux", persistHealth: async () => {}, retryDelaysMs: [], sleep: async () => {} };
const cfg = (over: Partial<Config>): Config => ({ excludeCommitPatterns: [], lookbackCapDays: 3, provider: PROV, ...over } as Config);

/** A folder discovery FINDS (it has a `.git` entry) but extraction reads as `not-a-repo` — neither
 *  inaccessible nor counted. It is the reachable way to get "repos found, empty window": a readable real
 *  repo always yields a branch resumption signal ("On branch main (…)", even in sync with an upstream —
 *  measured), so its window is never empty. */
function quietRepo(): string {
  const p = join(tmp("dba-db-quiet-"), "proj");
  mkdirSync(join(p, ".git"), { recursive: true });
  return p;
}
/** A repo with a commit inside the window. */
const busyRepo = () => buildRepo([{ file: "new.txt", content: "n", isoDate: daysAgo(1) }]);

describe("discovery-blocked: zero repos AND a configured search folder itself is unreadable or missing", () => {
  test("a configured search folder that cannot be read → blocked; the summary is in warnings and on the result", async () => {
    const root = lockedDir(join(tmp("dba-db-"), "Documents"));
    const r = await runCore(cfg({ discoverRoots: [root] }), deps);
    expect([r.blocked, r.discoveryBlocked, r.emptyWindow, r.repos.length]).toEqual([true, true, true, 0]);
    expect(r.discIssues).toEqual([{ path: root, kind: "unreadable" }]);   // PREMISE: the walk classified it
    expect(r.discoverySummary).toBe(`No repositories were found in Folders to search. Couldn't read 1 folder (${root}) — check its permissions — so repos in it may be missing.`);
    // One copy, LAST in the shared pipeline list (so stderr prints it after the per-folder lines).
    expect(r.warnings.at(-1)).toBe(r.discoverySummary!);
    expect(r.warnings.filter((w) => w === r.discoverySummary)).toHaveLength(1);
    expect(r.struct.warnings).toBe(r.warnings);
  });

  test("a MISSING configured search folder (a typo) with zero repos → blocked", async () => {
    const root = join(tmp("dba-db-miss-"), "Projcts");
    const r = await runCore(cfg({ discoverRoots: [root] }), deps);
    expect([r.blocked, r.discoveryBlocked]).toEqual([true, true]);
    expect(r.discoverySummary).toBe(`No repositories were found in Folders to search. Couldn't find 1 folder listed in Folders to search (${root}).`);
  });

  test("zero repos is measured AFTER excludeRepos: the only repo excluded + a denied search folder → blocked", async () => {
    const repo = quietRepo();
    const denied = lockedDir(join(tmp("dba-db-ex-"), "Docs"));
    const r = await runCore(cfg({ discoverRoots: [repo, denied], excludeRepos: [repo] }), deps);
    expect([r.repos.length, r.blocked, r.discoveryBlocked]).toEqual([0, true, true]);
  });

  test("search folders [home, home/Desktop] with Desktop denied: two raw issues, ONE label, and blocked (Desktop is listed)", async () => {
    const home = tmp("dba-db-home-");
    const desktop = lockedDir(join(home, "Desktop"));
    const r = await runCore(cfg({ discoverRoots: [home, desktop] }), deps);
    expect(r.discIssues.filter((i) => i.path === desktop)).toHaveLength(2);   // PREMISE: not deduped upstream
    expect(r.discoverySummary).toContain(`Couldn't read 1 folder (${desktop})`);
    expect([r.blocked, r.discoveryBlocked]).toEqual([true, true]);
  });
});

describe("NOT discovery-blocked — the no-stamp-loop invariant (core.ts, above blockedDelivery)", () => {
  test("zero repos in a three-level layout under a search folder, plus an INCIDENTAL denied Desktop → a quiet day that names it", async () => {
    const home = tmp("dba-db-inc-");
    mkdirSync(join(home, "code", "team", "proj", ".git"), { recursive: true });   // three levels down: past discovery's reach
    const desktop = lockedDir(join(home, "Desktop"));
    const r = await runCore(cfg({ discoverRoots: [home] }), deps);
    expect([r.repos.length, r.blocked, r.discoveryBlocked, r.emptyWindow]).toEqual([0, false, false, true]);
    expect(r.discoverySummary!.startsWith("No repositories were found in Folders to search.")).toBe(true);
    expect(r.discoverySummary).toContain(`(${desktop})`);
    // Delivered as a quiet day: "(no commits in the window)" plus the ⚠ line.
    const md = renderBriefing(r.struct);
    expect(md).toContain("(no commits in the window)");
    expect(md).toContain(`⚠ ${r.discoverySummary}`);
  });

  test("a denied search folder beside a FOUND repo, empty window → not blocked; the summary (no 'No repositories' prefix) is in the struct", async () => {
    const repo = quietRepo();
    const denied = lockedDir(join(tmp("dba-db-q-"), "Docs"));
    const r = await runCore(cfg({ discoverRoots: [repo, denied] }), deps);
    expect([r.repos.length, r.blocked, r.discoveryBlocked, r.emptyWindow]).toEqual([1, false, false, true]);
    expect(r.discoverySummary).toBe(`Couldn't read 1 folder (${denied}) — check its permissions — so repos in it may be missing.`);
    expect(r.struct.warnings).toContain(r.discoverySummary!);
  });

  test("a window WITH activity → no summary anywhere; the folder stays a discovery issue (stderr/briefing.log only)", async () => {
    const repo = await busyRepo();
    const denied = lockedDir(join(tmp("dba-db-busy-"), "Docs"));
    calls = 0;
    const r = await runCore(cfg({ discoverRoots: [repo, denied] }), deps);
    expect([r.emptyWindow, r.blocked, r.discoveryBlocked, calls]).toEqual([false, false, false, 1]);   // PREMISE: the provider ran
    expect(r.discoverySummary).toBeUndefined();
    expect((r.struct.warnings ?? []).some((w) => w.includes("Couldn't read"))).toBe(false);
    expect(r.discIssues.map((i) => i.path)).toEqual([denied]);
  });

  test("an excludeRepos-excluded unreadable folder is not counted: no summary, not blocked", async () => {
    const denied = lockedDir(join(tmp("dba-db-exd-"), "private"));
    const r = await runCore(cfg({ discoverRoots: [denied], excludeRepos: ["private"] }), deps);
    expect([r.blocked, r.discoveryBlocked, r.emptyWindow]).toEqual([false, false, true]);
    expect(r.discoverySummary).toBeUndefined();
  });

  test("an explicit `repos` config skips discovery: no discovery issues, no summary, never discovery-blocked", async () => {
    const repo = quietRepo();
    const denied = lockedDir(join(tmp("dba-db-explicit-"), "Docs"));
    const r = await runCore(cfg({ repos: [repo], discoverRoots: [denied] }), deps);
    expect(r.discIssues).toEqual([]);
    expect([r.blocked, r.discoveryBlocked, r.emptyWindow]).toEqual([false, false, true]);
    expect(r.discoverySummary).toBeUndefined();
  });
});

describe("extraction-blocked runs (blockedDelivery) and the summary", () => {
  test("extraction-blocked with no counted discovery issue → blocked as before, no summary", async () => {
    const repo = await busyRepo();
    const r = await runCore(cfg({ repos: [repo] }), { ...deps, probe: async () => ({ code: "EACCES" } as NodeJS.ErrnoException) });
    expect([r.blocked, r.discoveryBlocked]).toEqual([true, false]);
    expect(r.discoverySummary).toBeUndefined();
  });

  test("extraction-blocked BESIDE a denied search folder → blocked by the old rule, and the summary names the folder", async () => {
    const repo = await busyRepo();
    const denied = lockedDir(join(tmp("dba-db-both-"), "Docs"));
    const r = await runCore(cfg({ discoverRoots: [repo, denied] }), {
      ...deps, probe: async (p: string) => (p === repo ? ({ code: "EACCES" } as NodeJS.ErrnoException) : null),
    });
    expect([r.repos.length, r.blocked, r.discoveryBlocked]).toEqual([1, true, false]);
    expect(r.extrIssues.map((i) => i.path)).toEqual([repo]);   // PREMISE: blocked by extraction, not discovery
    expect(r.discoverySummary).toBe(`Couldn't read 1 folder (${denied}) — check its permissions — so repos in it may be missing.`);
  });
});

test("configuredRoots are the roots as EXPANDED at load, and discovery classifies a root under that exact string", async () => {
  // The predicate compares an issue's path with `cfg.discoverRoots`; both must be the same expanded string
  // (config.ts expands `~`, and discoverRepos classifies `root` itself). Pinned with a fake home.
  const home = tmp("dba-db-tilde-");
  const raw = { provider: PROV, discoverRoots: ["~/Missing", "~/Gone/"] };
  const c = validateConfig(raw, home);
  expect(c.discoverRoots).toEqual([join(home, "Missing"), `${join(home, "Gone")}/`]);
  const { issues } = await discoverRepos(c);
  expect(issues.map((i) => i.path)).toEqual(c.discoverRoots!);
  expect(issues.map((i) => i.kind)).toEqual(["not-found", "not-found"]);
  const r = await runCore({ ...c, excludeCommitPatterns: [], lookbackCapDays: 3 }, deps);
  expect([r.blocked, r.discoveryBlocked]).toEqual([true, true]);
  expect(r.discoverySummary).toContain("Couldn't find 2 folders listed in Folders to search");
});

describe("r7: the PROVIDER path with no commits in the window (a found repo always briefs — it has a branch)", () => {
  /** A search folder holding a REAL repo (`proj`, one commit dated `commitIso`) and an INCIDENTAL denied
   *  `Desktop` — the folder is reached by walking the root, never listed, so it can never block. */
  async function homeWithRepo(commitIso: string): Promise<{ home: string; repo: string; desktop: string }> {
    const home = tmp("dba-db-pp-");
    const repo = join(home, "proj");
    renameSync(await buildRepo([{ file: "old.txt", content: "o", isoDate: commitIso }]), repo);
    return { home, repo, desktop: lockedDir(join(home, "Desktop")) };
  }
  /** A model reply with NO recap — what a no-commit window yields — so the render takes its "(no commits
   *  in the window)" branch. The RECAP header is OMITTED, not left empty: `section()` reads an empty
   *  "## RECAP" followed directly by "## SUGGESTIONS" as two recap bullets (measured). */
  const quiet: Provider = { async generate() { calls++; return "## RESUME\n- [proj] resume\n## SUGGESTIONS\n- next"; } };
  const expected = (desktop: string) => `Couldn't read 1 folder (${desktop}) — check its permissions — so repos in it may be missing.`;

  test("repo found, no commits in the window, incidental denied folder → the provider runs, the summary is in struct.warnings ONCE, on the ⚠ line and (r8) at the end of the pipeline warnings; not blocked", async () => {
    const { home, repo, desktop } = await homeWithRepo(daysAgo(10));   // outside lookbackCapDays: 3
    calls = 0;
    const r = await runCore(cfg({ discoverRoots: [home] }), { ...deps, provider: quiet });
    // PREMISES: the repo was found and briefed (branch activity, no commit), so the early return never ran.
    expect([r.repos, r.emptyWindow, r.blocked, r.discoveryBlocked, calls]).toEqual([[repo], false, false, false, 1]);
    expect(r.activities.some((a) => a.kind === "branch")).toBe(true);
    expect(r.activities.some((a) => a.kind === "commit")).toBe(false);
    expect(r.discIssues).toEqual([{ path: desktop, kind: "unreadable" }]);
    expect(r.discoverySummary).toBe(expected(desktop));   // no "No repositories" prefix: a repo was found
    expect((r.struct.warnings ?? []).filter((w) => w === r.discoverySummary)).toHaveLength(1);
    // r8 (M1 checkpoint) INVERTS r7's assertion here, which was `expect(r.warnings).not.toContain(…)`: the
    // summary is now ALSO on the pipeline list — last, once — so stderr (after the per-folder warnFor
    // lines), briefing.log and the `run --json` envelope carry it, as on the early-return path. The push
    // happens after the late fold, so it never adds a second copy to the struct (asserted just above).
    expect(r.warnings.at(-1)).toBe(r.discoverySummary!);
    expect(r.warnings.filter((w) => w === r.discoverySummary)).toHaveLength(1);
    const md = renderBriefing(r.struct);
    expect(md).toContain("(no commits in the window)");
    expect(md.split("\n").find((l) => l.startsWith("⚠ "))).toContain(r.discoverySummary!);
  });

  test("r8 ORDER (M2 checkpoint): with a provider runtimeWarning in the late fold, the summary is still LAST in struct.warnings, once, and on r.warnings", async () => {
    // Pins the "push AFTER the fold" comment in core.ts. The test above cannot: with no runtimeWarnings
    // and no drift, `late` is the summary alone, so a push moved ABOVE the fold leaves the same struct.
    // Here the provider cites no SHA and names no PR, so the generator never reassigns `struct.warnings`:
    // it still ALIASES the pipeline list at the fold, and an early push would land the summary in the
    // struct BEFORE the runtime warning (appendUnique then skips the summary's own copy in `late`).
    const { home, desktop } = await homeWithRepo(daysAgo(10));
    const RUNTIME = "provider test double: a runtime warning raised during generate()";
    const withRuntime: Provider & { runtimeWarnings: string[] } = {
      runtimeWarnings: [RUNTIME],
      async generate() { calls++; return "## RESUME\n- [proj] resume\n## SUGGESTIONS\n- next"; },
    };
    calls = 0;
    const r = await runCore(cfg({ discoverRoots: [home] }), { ...deps, provider: withRuntime });
    // PREMISES: the provider path ran (not the early return), the window has no commits, and the
    // provider's warning reached the struct through the late fold.
    expect([r.emptyWindow, r.blocked, calls]).toEqual([false, false, 1]);
    expect(r.activities.some((a) => a.kind === "commit")).toBe(false);
    expect(r.discoverySummary).toBe(expected(desktop));
    const sw = r.struct.warnings ?? [];
    expect(sw).toContain(RUNTIME);
    // The pin: last, once, after the runtime warning — and on the pipeline list too, last and once.
    expect(sw.at(-1)).toBe(r.discoverySummary!);
    expect(sw.filter((w) => w === r.discoverySummary)).toHaveLength(1);
    expect(sw.indexOf(RUNTIME)).toBeLessThan(sw.indexOf(r.discoverySummary!));
    expect(r.warnings.at(-1)).toBe(r.discoverySummary!);
    expect(r.warnings.filter((w) => w === r.discoverySummary)).toHaveLength(1);
  });

  test("same, but with a commit in the window → no summary anywhere (§2.4.4: busy days unchanged)", async () => {
    const { home, desktop } = await homeWithRepo(daysAgo(1));
    calls = 0;
    const r = await runCore(cfg({ discoverRoots: [home] }), { ...deps, provider: quiet });
    expect([r.emptyWindow, r.blocked, calls]).toEqual([false, false, 1]);
    expect(r.activities.some((a) => a.kind === "commit")).toBe(true);    // PREMISE: the window has a commit
    expect(r.discIssues.map((i) => i.path)).toEqual([desktop]);           // PREMISE: the folder was still counted-eligible
    expect(r.discoverySummary).toBeUndefined();
    expect((r.struct.warnings ?? []).some((w) => w.includes("Couldn't read"))).toBe(false);
    expect(r.warnings.some((w) => w.includes("Couldn't read"))).toBe(false);
  });

  test("a MERGE-ONLY window counts as no commits: the summary sits under '(no commits in the window)' and the 🔀 line", async () => {
    const { home, repo, desktop } = await homeWithRepo(daysAgo(10));
    await branchCommit(repo, "feat/x", "x.txt", daysAgo(10));
    await mergeBranchWith(repo, "feat/x", "Merge pull request #7 from acme/feat/x", daysAgo(1));
    const r = await runCore(cfg({ discoverRoots: [home] }), { ...deps, provider: quiet });
    expect(r.struct.windowMerges?.map((m) => m.text)).toEqual([expect.stringContaining("Merged #7 (feat/x)")]);   // PREMISE
    expect(r.activities.some((a) => a.kind === "commit")).toBe(false);   // PREMISE: merges are never activities
    expect(r.discoverySummary).toBe(expected(desktop));
    expect(r.warnings.at(-1)).toBe(r.discoverySummary!);   // r8: on the pipeline list too
    const md = renderBriefing(r.struct);
    expect(md).toContain("(no commits in the window)");
    expect(md).toContain("PR merged (#7)");   // the render collapses the struct's 🔀 lines to one per label
    expect(md.split("\n").find((l) => l.startsWith("⚠ "))).toContain(r.discoverySummary!);
  });

  test("the provider-failure path is unaffected: err.warnings carries the warnFor line, never the summary", async () => {
    const { home, desktop } = await homeWithRepo(daysAgo(10));
    const failing: Provider = { async generate() { throw new ProviderError("timeout", "boom"); } };
    let err: ProviderError | undefined;
    try { await runCore(cfg({ discoverRoots: [home] }), { ...deps, provider: failing }); }
    catch (e) { err = e as ProviderError; }
    expect(err?.code).toBe("timeout");
    expect(err!.warnings).toContain(warnFor({ path: desktop, kind: "unreadable" }));
    expect(err!.warnings!.some((w) => w.includes(expected(desktop)))).toBe(false);
  });
});
