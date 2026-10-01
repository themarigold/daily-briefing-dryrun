// test/recap-campaigns.prfacts.test.ts — tier B, T3.2: `readPrFacts` (`src/recapCampaignsPhase.ts`), the PR
// facts of one morning read from git under ONE budget (spec §4.3 "How PR facts are derived" items 1–6; D6,
// D9 and its `reposUnread` addendum). Cases P24 and P28 of spec §5.4 (plan §7), plus the plan-added order,
// unread-count and kill pins.
//
// Fixture, spy and kill idioms are T3.1's (`test/git.default-ref-merges.test.ts`): real git repos in temp
// dirs under a NEUTRAL git config, every in-window commit on ONE earlier local day (`yesterdayNoon`, plan
// §1), and a PASS-THROUGH `spyOn(Bun, "spawn")` that substitutes the instant self-kill `sh -c 'kill -KILL
// $$'` for EXACTLY ONE of B's argvs — Bun reports it exactly as a timeout kill (`exitCode: null`,
// `signalCode: "SIGKILL"`), it spends ~0 ms of budget, and it needs no timing. This spy also records each
// spawn's `cwd`, which is what tells one repo's calls from another's.
import { test, expect, describe, beforeAll, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { listPrMerges, listDefaultRefMerges, mergeMembers, startGitBudget } from "../src/git";
import { readPrFacts } from "../src/recapCampaignsPhase";
import { attachPrFacts, NO_PR_FACT, type CampaignItem } from "../src/recapCampaigns";
import type { Activity } from "../src/types";

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────

/** The REAL spawn, captured before any spy so the fixture helpers and the pass-through both use it. */
const realSpawn = Bun.spawn;
type SpawnArgs = Parameters<typeof Bun.spawn>;

/** Fixture commands run under a NEUTRAL git config (T3.1's reason: the developer's gitconfig must not
 *  shape what the fixtures contain); the code under test still runs under the real environment. */
const NEUTRAL_GIT = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
async function sh(args: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const p = realSpawn(args, { cwd, env: { ...process.env, ...NEUTRAL_GIT, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`${args.join(" ")} in ${cwd}: ${err}`);
  return out;
}
const git = (args: string[], cwd: string, env: Record<string, string> = {}) => sh(["git", ...args], cwd, env);
const tmp = (label: string) => removeAtRunEnd(mkdtempSync(join(tmpdir(), `dba-prf-${label}-`)));

/** ISO dates on ONE earlier local day (`yesterdayNoon`, plan §1), spaced by minutes. */
const day = new Date(); day.setHours(12, 0, 0, 0); day.setDate(day.getDate() - 1);
const at = (minutes: number): string => new Date(day.getTime() + minutes * 60_000).toISOString();
const WINDOW_START = new Date(day.getTime() - 6 * 3600_000);
const NOW = new Date(day.getTime() + 6 * 3600_000);
const dated = (iso: string) => ({ GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
const GENEROUS = 60_000;

async function initRepoAt(dir: string, branch = "main"): Promise<string> {
  await git(["init", "-q", "-b", branch], dir);
  await git(["config", "user.name", "Test"], dir);
  await git(["config", "user.email", "test@example.com"], dir);
  return dir;
}
const initRepo = (branch = "main") => initRepoAt(tmp("repo"), branch);
async function commit(repo: string, file: string, iso: string): Promise<string> {
  await Bun.write(join(repo, file), `${file} ${iso}\n`);
  await git(["add", "."], repo);
  await git(["commit", "-q", "-m", `add ${file}`], repo, dated(iso));
  return (await git(["rev-parse", "HEAD"], repo)).trim();
}
/** A topic branch from HEAD with one commit, merged back with the GitHub subject for PR `n`. Returns the
 *  topic commit — the ONE member of that merge. */
async function pr(repo: string, n: number, branch: string, minute: number): Promise<string> {
  const base = (await git(["rev-parse", "HEAD"], repo)).trim();
  await git(["checkout", "-q", "-b", branch, base], repo);
  const tip = await commit(repo, `${branch.replace(/\W/g, "_")}.txt`, at(minute));
  await git(["checkout", "-q", "-"], repo);
  await git(["merge", "-q", "--no-ff", "-m", `Merge pull request #${n} from owner/${branch}`, branch], repo, dated(at(minute + 1)));
  return tip;
}

/** An offered item over `commits` (the other fields are irrelevant to PR facts). */
let nextId = 0;
const item = (commits: string[]): CampaignItem =>
  ({ id: `G${++nextId}`, kind: "single", labelKey: "app", entries: [nextId], commits, texts: ["text"], fact: NO_PR_FACT });
/** `commitsById` as `runCore` builds it: each ctx commit's activity, whose `repo` is the repo PATH. */
const byId = (pairs: [string, string][]): Map<string, Activity> =>
  new Map(pairs.map(([sha, repo]) => [sha, { source: "git", kind: "commit", event_id: sha, repo }]));
const facts = (items: CampaignItem[], r: Awaited<ReturnType<typeof readPrFacts>>) => attachPrFacts(items, r.membership).map((i) => i.fact);

/** The pass-through spy: `substitute(argv, cwd)` returns a replacement argv for the call to hijack, or
 *  undefined to let it through. Records every spawn's argv and cwd. Restored by the caller's `finally`. */
function spawnSpy(substitute: (argv: string[], cwd: string | undefined) => string[] | undefined) {
  const calls: { argv: string[]; cwd: string | undefined }[] = [];
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: SpawnArgs[0], opts: SpawnArgs[1]) => {
    const argv = cmd as string[];
    const cwd = (opts as { cwd?: string } | undefined)?.cwd;
    calls.push({ argv, cwd });
    return realSpawn(substitute(argv, cwd) ?? argv, opts as any);
  }) as typeof Bun.spawn);
  return { spy, calls };
}
const KILL = ["sh", "-c", "kill -KILL $$"];
const isRevListRange = (argv: string[]) => argv[0] === "git" && argv[1] === "rev-list" && /^[0-9a-f]+\.\.[0-9a-f]+$/.test(argv[2] ?? "");
const isMergeLog = (argv: string[]) => argv[0] === "git" && argv[1] === "log" && argv.includes("--first-parent") && argv.includes("--merges");
const isListing = (argv: string[]) =>
  argv[0] === "git" && (isMergeLog(argv) || argv[1] === "for-each-ref" || (argv[1] === "symbolic-ref" && argv.includes("refs/remotes/origin/HEAD")));

beforeAll(async () => {
  // Warm the process-wide `_supportsSinceAsFilter` cache (git.ts) with one REAL call, before any spy:
  // `windowArgs` probes `git --version` once per process, and a probe under a spy would be order-dependent.
  const warm = await initRepo();
  await commit(warm, "w.txt", at(0));
  await listPrMerges(warm, WINDOW_START, NOW);
});

// ── readPrFacts ──────────────────────────────────────────────────────────────────────────────────────

describe("readPrFacts: the morning's PR facts from git, under one budget", () => {
  test("[TB-P28] the five fact shapes through real git: one PR; none; two PRs; one PR plus commits in no PR; four PRs ascending", async () => {
    const repo = await initRepo();
    await commit(repo, "base.txt", at(0));
    const none = await commit(repo, "direct0.txt", at(1));                  // on main, in no PR
    const one = await pr(repo, 1, "feat/one.two_three", 2);
    const two = await pr(repo, 2, "feat/two", 4);
    const three = await pr(repo, 3, "feat/three", 6);
    const four = await pr(repo, 4, "feat/four", 8);
    const k1 = await commit(repo, "direct1.txt", at(10));
    const k2 = await commit(repo, "direct2.txt", at(11));
    // created out of numeric order, so "ascending" is by NUMBER, not by merge order or by string
    const p12 = await pr(repo, 12, "fix/twelve", 12);
    const p10 = await pr(repo, 10, "fix/ten", 14);
    const p9 = await pr(repo, 9, "fix/nine", 16);
    const p11 = await pr(repo, 11, "fix/eleven", 18);
    const items = [item([one]), item([none]), item([three, two]), item([k1, four, k2]), item([p12, p9, p11, p10])];
    const all = [none, one, two, three, four, k1, k2, p12, p10, p9, p11];
    const r = await readPrFacts(items, byId(all.map((s) => [s, repo])), WINDOW_START, NOW, GENEROUS);
    expect(facts(items, r)).toEqual([
      "merged in PR #1 (feat one two three)",
      "no PR fact",
      "merged across PRs #2 (feat two), #3 (feat three)",
      "merged across PRs #4 (feat four); 2 commits in no PR",
      "merged across PRs #9 (fix nine), #10 (fix ten), #11 (fix eleven), #12 (fix twelve)",
    ]);
    expect(r.prFacts).toEqual({ merges: 8, read: 8, timedOut: 0, marked: 3, reposUnread: 0 });
    // the marked n = 1 form carries its per-commit tags (a commit absent from the map is in no PR)
    expect(attachPrFacts(items, r.membership)[3]!.prByCommit).toEqual({ [four]: 4 });
    expect(Number.isInteger(r.gitMs) && r.gitMs >= 0).toBe(true);
  }, 20_000);

  test("[TB-P24] innermost among PR merges (D6): a commit in two PR merges belongs to the smaller; a non-PR merge is dropped before the rule", async () => {
    // Two first-parent chains, `main` and `master` (both walked — the UNION), listed newest first:
    //   main:   #1 {c1, c2} @10 → #3 {c3, c4} @35 → #6 {c5, c6} @45
    //   master: #5 {c5}     @15 → #2 {c1}     @20 → a NON-PR merge {c3} @40
    // c1 is in #1 and #2 — the SMALLER is the NEWER (#2); c5 is in #6 and #5 — the smaller is the OLDER
    // (#5). So the innermost rule is told apart from "first listed wins" AND from "last listed wins". c3 is
    // in #3 and in a smaller non-PR merge — dropped first (D6), so c3 stays #3's.
    const repo = await initRepo();
    const a = await commit(repo, "a.txt", at(0));
    await git(["checkout", "-q", "-b", "feat/big", a], repo);
    const c1 = await commit(repo, "c1.txt", at(5));
    const c2 = await commit(repo, "c2.txt", at(6));
    await git(["checkout", "-q", "-b", "feat/e", a], repo);
    const c5 = await commit(repo, "c5.txt", at(7));
    const c6 = await commit(repo, "c6.txt", at(8));
    await git(["checkout", "-q", "-b", "feat/d", a], repo);
    const c3 = await commit(repo, "c3.txt", at(30));
    const c4 = await commit(repo, "c4.txt", at(31));
    await git(["checkout", "-q", "main"], repo);
    await git(["merge", "-q", "--no-ff", "-m", "Merge pull request #1 from owner/feat/big", "feat/big"], repo, dated(at(10)));
    await git(["merge", "-q", "--no-ff", "-m", "Merge pull request #3 from owner/feat/d", "feat/d"], repo, dated(at(35)));
    await git(["merge", "-q", "--no-ff", "-m", "Merge pull request #6 from owner/feat/e", "feat/e"], repo, dated(at(45)));
    await git(["checkout", "-q", "-b", "master", a], repo);
    await git(["merge", "-q", "--no-ff", "-m", "Merge pull request #5 from owner/feat/e-part", c5], repo, dated(at(15)));
    await git(["merge", "-q", "--no-ff", "-m", "Merge pull request #2 from owner/feat/small", c1], repo, dated(at(20)));
    await git(["merge", "-q", "--no-ff", "-m", "Merge branch 'feat/d-part'", c3], repo, dated(at(40)));
    // the fixture really nests, in the listing order claimed above
    const listed = await listDefaultRefMerges(repo, WINDOW_START, NOW, startGitBudget(GENEROUS));
    expect(listed.merges.map((m) => m.pr?.number ?? null)).toEqual([6, null, 3, 2, 5, 1]);
    const members = (await mergeMembers(repo, listed.merges, startGitBudget(GENEROUS))).members;
    const of = (subject: string) => [...members.get(listed.merges.find((m) => m.subject.startsWith(subject))!.sha)!].sort();
    expect(of("Merge pull request #1 ")).toEqual([c1, c2].sort());
    expect(of("Merge pull request #2 ")).toEqual([c1]);
    expect(of("Merge pull request #3 ")).toEqual([c3, c4].sort());
    expect(of("Merge branch 'feat/d-part'")).toEqual([c3]);
    expect(of("Merge pull request #5 ")).toEqual([c5]);
    expect(of("Merge pull request #6 ")).toEqual([c5, c6].sort());

    const items = [item([c1]), item([c2]), item([c1, c2]), item([c3]), item([c4]), item([c5]), item([c6])];
    const r = await readPrFacts(items, byId([c1, c2, c3, c4, c5, c6].map((s) => [s, repo])), WINDOW_START, NOW, GENEROUS);
    expect(r.membership.get(c1)).toEqual({ number: 2, branch: "feat/small" });   // innermost of #1 and #2 (the newer)
    expect(r.membership.get(c5)).toEqual({ number: 5, branch: "feat/e-part" });  // innermost of #6 and #5 (the older)
    expect(r.membership.get(c3)).toEqual({ number: 3, branch: "feat/d" });       // the non-PR {c3} was dropped first
    expect(facts(items, r)).toEqual([
      "merged in PR #2 (feat small)",
      "merged in PR #1 (feat big)",
      "merged across PRs #1 (feat big), #2 (feat small)",
      "merged in PR #3 (feat d)",
      "merged in PR #3 (feat d)",
      "merged in PR #5 (feat e part)",
      "merged in PR #6 (feat e)",
    ]);
    // `merges` counts every in-window merge listed, the non-PR one included; all six rev-lists completed
    expect(r.prFacts).toEqual({ merges: 6, read: 6, timedOut: 0, marked: 1, reposUnread: 0 });
  }, 20_000);

  test("the innermost rule's tie-break: two PR merges of the SAME one-commit set → the lower PR number, whatever the listing order", async () => {
    // One topic commit t, merged by #12 on `main` (newer) and by #9 on `master` (older): both member sets
    // are {t}, so the size comparison ties. The listing is newest first, so #12 claims t FIRST — a "first
    // listed wins" rule, or an inverted number tie-break, would keep #12.
    const repo = await initRepo();
    const a = await commit(repo, "a.txt", at(0));
    await git(["checkout", "-q", "-b", "feat/t", a], repo);
    const t = await commit(repo, "t.txt", at(5));
    await git(["checkout", "-q", "main"], repo);
    await git(["merge", "-q", "--no-ff", "-m", "Merge pull request #12 from owner/feat/t", "feat/t"], repo, dated(at(20)));
    await git(["checkout", "-q", "-b", "master", a], repo);
    await git(["merge", "-q", "--no-ff", "-m", "Merge pull request #9 from owner/feat/t-again", "feat/t"], repo, dated(at(10)));
    // the fixture: #12 listed before #9, each with exactly the one member t
    const listed = await listDefaultRefMerges(repo, WINDOW_START, NOW, startGitBudget(GENEROUS));
    expect(listed.merges.map((m) => m.pr?.number ?? null)).toEqual([12, 9]);
    const members = (await mergeMembers(repo, listed.merges, startGitBudget(GENEROUS))).members;
    expect([...members.values()]).toEqual([[t], [t]]);
    const items = [item([t])];
    const r = await readPrFacts(items, byId([[t, repo]]), WINDOW_START, NOW, GENEROUS);
    expect(r.membership.get(t)).toEqual({ number: 9, branch: "feat/t-again" });
    expect(facts(items, r)).toEqual(["merged in PR #9 (feat t again)"]);
  }, 20_000);

  test("every repo is listed before any rev-list runs", async () => {
    // Fixed names under one parent, so the sorted order is known: repo-a, then repo-b. The items name
    // repo-b's commit FIRST, so insertion order is b, a — the listing must still go a, b. repo-c's commit
    // is in `commitsById` but in no offered item, so repo-c is never read.
    const parent = tmp("order");
    const [ra, rb, rc] = ["repo-a", "repo-b", "repo-c"].map((n) => join(parent, n));
    for (const d of [ra, rb, rc]) { mkdirSync(d!); await initRepoAt(d!); await commit(d!, "base.txt", at(0)); }
    const ca = await pr(ra!, 1, "feat/a", 10);
    const cb = await pr(rb!, 2, "feat/b", 10);
    const cc = await pr(rc!, 3, "feat/c", 10);
    const items = [item([cb]), item([ca])];
    const { spy, calls } = spawnSpy(() => undefined);
    let r: Awaited<ReturnType<typeof readPrFacts>>;
    try {
      r = await readPrFacts(items, byId([[ca, ra!], [cb, rb!], [cc, rc!]]), WINDOW_START, NOW, GENEROUS);
    } finally { spy.mockRestore(); }
    const b = calls.filter((c) => isListing(c.argv) || isRevListRange(c.argv));
    const kind = b.map((c) => `${isRevListRange(c.argv) ? "rev-list" : "list"}@${c.cwd === ra ? "a" : c.cwd === rb ? "b" : "?"}`);
    expect(kind).toEqual(["list@a", "list@a", "list@a", "list@b", "list@b", "list@b", "rev-list@a", "rev-list@b"]);
    expect(calls.some((c) => c.cwd === rc)).toBe(false);                                        // only repos that own an offered item
    expect(facts(items, r!)).toEqual(["merged in PR #2 (feat b)", "merged in PR #1 (feat a)"]);
    expect(r!.prFacts).toEqual({ merges: 2, read: 2, timedOut: 0, marked: 0, reposUnread: 0 });
  }, 20_000);

  test("readPrFacts counts an unread repo in reposUnread and in no merge counter", async () => {
    const [r1, r2] = [await initRepo(), await initRepo()];
    for (const d of [r1, r2]) await commit(d, "base.txt", at(0));
    const c1 = await pr(r1, 1, "feat/one", 10);
    const c2 = await pr(r2, 2, "feat/two", 10);
    const items = [item([c1]), item([c2])];
    const commitsById = byId([[c1, r1], [c2, r2]]);
    // control: with budget, both repos yield a fact — so the "no PR fact"s below are the budget's doing
    expect(facts(items, await readPrFacts(items, commitsById, WINDOW_START, NOW, GENEROUS))).toEqual(["merged in PR #1 (feat one)", "merged in PR #2 (feat two)"]);
    const { spy, calls } = spawnSpy(() => undefined);
    let r: Awaited<ReturnType<typeof readPrFacts>>;
    try {
      r = await readPrFacts(items, commitsById, WINDOW_START, NOW, 0);
    } finally { spy.mockRestore(); }
    expect(r!.prFacts).toEqual({ merges: 0, read: 0, timedOut: 0, marked: 0, reposUnread: 2 });
    expect(facts(items, r!)).toEqual([NO_PR_FACT, NO_PR_FACT]);
    expect(r!.membership.size).toBe(0);
    expect(calls).toHaveLength(0);                                                              // budget 0: no git call starts
  }, 20_000);

  test("readPrFacts leaves the other repo's facts intact when one listing is killed", async () => {
    const parent = tmp("kill");
    const [ra, rb] = ["repo-a", "repo-b"].map((n) => join(parent, n));
    for (const d of [ra, rb]) { mkdirSync(d!); await initRepoAt(d!); await commit(d!, "base.txt", at(0)); }
    const ca = await pr(ra!, 1, "feat/a", 10);
    const cb = await pr(rb!, 2, "feat/b", 10);
    const items = [item([ca]), item([cb])];
    const commitsById = byId([[ca, ra!], [cb, rb!]]);
    // Both orders: the instant kill spends no budget, so killing the FIRST-listed repo leaves the second
    // exactly as intact as killing the second leaves the first.
    for (const [victim, want] of [
      [rb!, ["merged in PR #1 (feat a)", NO_PR_FACT]],
      [ra!, [NO_PR_FACT, "merged in PR #2 (feat b)"]],
    ] as const) {
      const { spy, calls } = spawnSpy((argv, cwd) => (isMergeLog(argv) && cwd === victim ? KILL : undefined));
      let r: Awaited<ReturnType<typeof readPrFacts>>;
      try {
        r = await readPrFacts(items, commitsById, WINDOW_START, NOW, GENEROUS);
      } finally { spy.mockRestore(); }
      expect(calls.filter((c) => isMergeLog(c.argv) && c.cwd === victim)).toHaveLength(1);     // the ONE hijacked call
      expect(facts(items, r!)).toEqual([...want]);
      expect(r!.prFacts).toEqual({ merges: 1, read: 1, timedOut: 0, marked: 0, reposUnread: 1 });
    }
  }, 20_000);
});
