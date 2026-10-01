// src/extractor.ts
import { readdir } from "node:fs/promises";
import type { Activity, Config } from "./types";
import { DEFAULT_LOOKBACK_CAP_DAYS, DEFAULT_EXCLUDE_COMMIT_PATTERNS, compileExcludePatterns } from "./config";
import { windowStart, localMidnight } from "./time";
import { ancestryRelated, committerDaysWithCommits, listCommits, listPrMerges, patchIds, resumptionSignals, resolveAuthor, gitDirExists, runGit, IncompleteReadError } from "./git";
import { classify, warnFor, type PathIssue, type GuardOpts } from "./protectedPath";
import { homedir } from "node:os";

// A repo-readability probe: returns an errno-ish error if the repo dir can't be
// enumerated, else null. Injectable so the tcc-denied path is testable without real
// TCC state. Default enumerates with readdir — a bare `stat` often succeeds under a
// TCC-gated folder, so we must actually read the directory to trip the denial (§5.11).
export type RepoProbe = (repo: string) => Promise<NodeJS.ErrnoException | null>;
export const fsProbe: RepoProbe = async (repo) => {
  try { await readdir(repo); return null; }
  catch (e) { return e as NodeJS.ErrnoException; }
};

export type ProbeOpts = GuardOpts & {
  probe?: RepoProbe; gitCheck?: () => Promise<boolean>;
  /** Test seams for `dedupeTwins` (IN-1). `patchIds` is the content fingerprint, `ancestryRelated`
   *  the do-revert-redo discriminator that gates every drop. Both spawn real git, so the window-list
   *  tests inject counting / empty / throwing stand-ins to pin the cost bound, the call shape and
   *  BOTH fail-open paths at the `gitActivity` boundary — without a git shim on PATH. Same shape and
   *  same reason as `gitCheck` above; production never sets either. */
  patchIds?: typeof patchIds;
  ancestryRelated?: typeof ancestryRelated;
};

// Is the `git` binary usable at all? A missing git is systemic (not "no repos") — detect it ONCE.
// Three outcomes, not two: an IncompleteReadError means git RAN FINE but its output could not be read
// to completion, so reporting "not on PATH" would send the user to reinstall a working git. Same
// blocking outcome, honest diagnosis. `unread` carries the error's own `reason`, so the warning names
// the ACTUAL cause (held pipe vs failed read) rather than asserting the more common one.
type GitProbe = { kind: "ok" } | { kind: "missing" } | { kind: "unread"; reason: string };
async function gitAvailable(opts?: ProbeOpts): Promise<GitProbe> {
  // The injected hook is a boolean by contract, so it can only express ok/missing — tests that need
  // the `unread` outcome mock Bun.spawn instead.
  if (opts?.gitCheck) return (await opts.gitCheck()) ? { kind: "ok" } : { kind: "missing" };
  // Probe from homedir() (always present), NOT process.cwd() — a deleted/inaccessible cwd would make
  // Bun.spawn throw and falsely report git missing, blocking a real user every run.
  return runGit(["--version"], homedir()).then((): GitProbe => ({ kind: "ok" }))
    .catch((e): GitProbe =>
      e instanceof IncompleteReadError ? { kind: "unread", reason: e.reason } : { kind: "missing" });
}

// "Probe each repo and classify what we can't read." Used by the init preflight (main.ts); the
// real run (gitActivity, below) does the same probe inline because it interleaves with git reads,
// but both funnel classification through the one `classify()` helper, so they can't diverge on how
// a blocked repo is labeled. Returns one PathIssue per unreadable repo (readable → nothing).
export async function probeRepos(repos: string[], opts?: ProbeOpts): Promise<PathIssue[]> {
  const probe = opts?.probe ?? fsProbe;
  const issues: PathIssue[] = [];
  for (const repo of repos) {
    const err = await probe(repo);
    if (err) issues.push(classify(repo, err, opts));
  }
  return issues;
}

// Repos are independent, so their git scans run concurrently with a small bound — a multi-repo
// morning's wall time becomes ~the slowest repo instead of the sum of all. Bounded to avoid a spawn
// storm (each repo fires several git subprocesses). It also contains blast radius: one repo blocked
// on dead I/O (a hung network mount) no longer serializes the whole run behind it.
// EXPORTED (day-20 bidirectional drift re-check): `core.computeWorkingTreeDrift` now re-reads EVERY
// configured repo at render time, not just the ones already dirty, so it needs the same bound and the
// same order-preserving walk the extraction scan uses. Sharing the one implementation rather than
// growing a second copy — a divergent bound would make the render-time re-check either serial (the
// wall-time regression this file exists to avoid) or unbounded (the spawn storm it exists to avoid).
export const REPO_SCAN_CONCURRENCY = 8;

// Order-preserving bounded-concurrency map: results[i] always corresponds to items[i] regardless of
// completion order, so downstream merging stays deterministic — byte-identical to the old sequential
// walk. Workers pull from a shared cursor until the list is drained. NOTE: phase 1 deliberately
// rethrows a NON-IncompleteReadError (an unexpected bug) rather than classifying it — that aborts
// Promise.all while other workers run on, which is the intended fail-closed outcome: run() exits
// without stamping, so the day retries. Every EXPECTED error is still fully guarded, so this path
// is unreachable in normal operation; it is not the old "fn must not reject" invariant.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]!, i);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type MergedToday = { repo: string; prNum: string; branch: string; sha: string; timestamp: string; files: string[] };

export async function gitActivity(
  cfg: Config,
  repos: string[],
  opts?: ProbeOpts,
): Promise<{ activities: Activity[]; warnings: string[]; issues: PathIssue[]; today: Activity[]; mergedToday: MergedToday[]; windowMerges: MergedToday[]; windowStartUtc: string }> {
  // ⚠ `windowStartUtc` is RETURNED, not re-derived by the caller. §3.1's transcript read window is
  // [gitWindowStart - margin, now], and `windowStart()` is computed INSIDE this function, so without
  // exposing it `runCore` cannot construct that window at all. Deriving it from
  // `min(activity.timestamp)` is wrong by up to a day, because `windowStart` returns a LOCAL MIDNIGHT
  // and the earliest activity is whenever work happened to start.
  const cap = cfg.lookbackCapDays ?? DEFAULT_LOOKBACK_CAP_DAYS;
  const probe = opts?.probe ?? fsProbe;
  const now = new Date();
  const end = localMidnight(now);

  // #12: a missing `git` binary is a SYSTEMIC failure, not "no repos" — detect it ONCE up front, so we
  // don't misclassify every repo as "not a git repo" and then stamp the day done (a silently-wrong
  // first run on a machine without git: a fresh macOS xcode-select stub, a minimal Linux box). Return a
  // blocking (inaccessible) issue so run() does NOT stamp and retries once git is installed.
  const gitProbe: GitProbe = repos.length ? await gitAvailable(opts) : { kind: "ok" };
  if (gitProbe.kind !== "ok") {
    return {
      // No window was ever computed on this path (git is unrunnable), so report "now": the caller
      // constructs an empty read window from it rather than a spuriously wide one.
      windowStartUtc: new Date().toISOString(),
      activities: [], today: [], mergedToday: [], windowMerges: [], issues: [{ path: "git", kind: "unreadable" }],
      warnings: [gitProbe.kind === "missing"
        ? "git isn't runnable (not on PATH, or not installed) — the briefing reads local git history. Install git or fix its PATH. Today NOT marked done; it will retry once git works."
        : `git ran but its output could not be read to completion, so nothing could be read reliably — ${gitProbe.reason}. Today NOT marked done; it will retry.`],
    };
  }

  // 1) union of commit-days across all readable repos → drives the shared window.
  //    Resolve the effective author PER REPO (explicit config, else the repo's git identity).
  const commitDays = new Set<number>();
  const readable: { repo: string; author: { names?: string[]; emails?: string[] } }[] = [];
  const warnings: string[] = [];
  const issues: PathIssue[] = [];
  // Compile bot/auto-commit exclude patterns ONCE; a typo'd regex is warned (not fatal — it would
  // otherwise crash every listCommits and degrade the whole briefing to "partial failure") (#4).
  const { regexes: excludeRe, invalid } = compileExcludePatterns(cfg.excludeCommitPatterns ?? DEFAULT_EXCLUDE_COMMIT_PATTERNS);
  for (const p of invalid) warnings.push(`ignored invalid excludeCommitPatterns entry ${JSON.stringify(p)} (not a valid regex)`);
  type Phase1 = { days: number[]; readable: { repo: string; author: { names?: string[]; emails?: string[] } } | null; issues: PathIssue[]; warnings: string[] };
  const phase1 = await mapLimit(repos, REPO_SCAN_CONCURRENCY, async (repo): Promise<Phase1> => {
    // Protected-path guard (§5.11): probe readability BEFORE touching git, so a macOS TCC
    // denial (EPERM under a protected root) is classified distinctly — not mistaken for a
    // broken/empty repo — and the repo is skipped-and-surfaced, never silently dropped.
    const probeErr = await probe(repo);
    if (probeErr) {
      const issue = classify(repo, probeErr, opts);
      return { days: [], readable: null, issues: [issue], warnings: [warnFor(issue)] };
    }
    // An IncompleteReadError anywhere below means git's output could not be read to completion (a
    // held pipe, or a failed read), so NO read from this repo can be trusted. THIS OUTER CATCH is the
    // protection: it keeps the error away from the two swallow paths beneath — resolveAuthor's own
    // fallbacks in git.ts, which return `{}` = NO author filter (every commit matches, crediting
    // coworkers), and the unborn-HEAD branch below, which returns zero days with no issue at all (a
    // fabricated quiet day that then stamps). Surface an unreadable repo instead.
    try {
      // Deliberately no local `.catch` here: every runGit inside resolveAuthor already routes through
      // `orElse`, so an IncompleteReadError is the only thing it can reject with — and that must
      // reach the outer catch. A handler returning `cfg.author ?? {}` would be dead code that reads
      // as though the no-author-filter degradation were still reachable.
      const author = await resolveAuthor(repo, cfg.author);
      try {
        const days = await committerDaysWithCommits(repo, author, cap + 1, excludeRe);
        return { days: [...days], readable: { repo, author }, issues: [], warnings: [] };
      } catch (e) {
        if (e instanceof IncompleteReadError) throw e;   // NOT an unborn HEAD — don't let it look like one
        // A repo with ZERO commits is not the same as "not a git repo", and must still reach phase 2:
        // a brand-new repo with staged work is exactly the "here's where I left off" state
        // resumptionSignals exists for. NOTE this branch is DEFENSIVE, not the common path — measured
        // on git 2.54, `git log --all` exited 0 with empty output on an unborn HEAD, so
        // committerDaysWithCommits did not throw there. Bare `git log` DOES exit 128, so a narrower
        // ref set still lands here (and possibly an older git — unmeasured).
        // ⚠ LOCAL_WORK_REFS STOPPED ENDING IN `--all` on 2026-08-11 (it is now an allowlist — see
        // git.ts), and this warning is exactly why it carries `--ignore-missing`: the allowlist
        // names `HEAD`, which on an unborn HEAD is an unknown revision that exits 128. Re-measured
        // with the new form: exit 0, empty output, so the clean path is preserved and this branch
        // stays defensive. Drop `--ignore-missing` and every brand-new repo routes through here.
        // Only classify-and-warn when
        // the fs probe passed but git itself says this isn't a valid repo.
        if (await gitDirExists(repo)) {
          return { days: [], readable: { repo, author }, issues: [], warnings: [] };
        }
        // The fs probe passed but git can't read it: fall back to classifying git's own
        // (locale-dependent) error as a complement — catches a TCC denial the probe missed.
        const issue = classify(repo, e, opts);
        return { days: [], readable: null, issues: [issue], warnings: [warnFor(issue)] };
      }
    } catch (e) {
      if (!(e instanceof IncompleteReadError)) throw e;   // genuinely unexpected — don't mask it
      // An `unreadable` ISSUE, not just a warning: `blockedDelivery` (core.ts) keys on
      // isInaccessible issues, so warning-only would leave the run to render an empty briefing and
      // STAMP the day — the fabricated quiet day A1 calls worse than the hang. The issue also gives
      // the right asymmetry for free, since blockedDelivery only fires at activityCount === 0: one
      // held repo among healthy ones still delivers a partial briefing plus this warning.
      return {
        days: [], readable: null, issues: [{ path: repo, kind: "unreadable" }],
        warnings: [`skipped ${repo}: git's output could not be read to completion, so its history is not trustworthy — ${e.reason}`],
      };
    }
  });
  // Merge in repo order (deterministic): commitDays is order-independent; readable/issues/warnings
  // keep input order, identical to the previous sequential walk.
  for (const r of phase1) {
    for (const d of r.days) commitDays.add(d);
    if (r.readable) readable.push(r.readable);
    issues.push(...r.issues);
    warnings.push(...r.warnings);
  }
  const start = windowStart(now, (d) => commitDays.has(d.getTime()), cap);

  // 2) per-repo commits + resumption state, in ONE listCommits pass over [start, tomorrow): commits
  // before today-midnight (`end`) are the window recap; commits on/after are "Today so far" (#1) —
  // the window excludes today, so a briefing (re)generated after a morning of work isn't blind to it.
  // Both are author- and bot-filtered. resumptionSignals runs first (a zero-commit repo MAY make
  // listCommits throw — on modern git its `--all` shape exits 0 with empty output instead — but
  // either way its uncommitted/stash signals still matter). One pass avoids a second
  // full-history `git log` per repo and keeps window/today error handling identical.
  const tomorrow = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  const activities: Activity[] = [];
  const today: Activity[] = [];
  // Today's landed PRs — a separate channel from listCommits (merges are dropped there as recap padding),
  // surfaced in the same-day layer so the briefing isn't blind to "PR merged today" (audit 2026-07-16).
  const mergedToday: MergedToday[] = [];
  type Phase2 = { activities: Activity[]; today: Activity[]; mergedToday: MergedToday[]; warnings: string[]; issues: PathIssue[] };
  const phase2 = await mapLimit(readable, REPO_SCAN_CONCURRENCY, async ({ repo, author }): Promise<Phase2> => {
    const acts: Activity[] = [], td: Activity[] = [], merged: MergedToday[] = [];
    try {
      acts.push(...await resumptionSignals(repo));
      for (const c of await listCommits(repo, start, tomorrow, author, excludeRe)) {
        (new Date(c.timestamp ?? "").getTime() < end.getTime() ? acts : td).push(c);
      }
      // Whole window, not just today (defect D — EVAL day 33, user-directed): an in-window PR
      // landing previously had NO channel at all (listCommits drops merges; this scan started at
      // `end`), so six 08-17 landings were invisible on 08-18. One scan covers both halves; the
      // caller splits on `end` — same-day entries keep their existing "Today so far" rendering,
      // in-window entries render as dated lines at the foot of the recap.
      for (const m of await listPrMerges(repo, start, tomorrow, author, excludeRe)) {
        merged.push({ repo: m.repo, prNum: m.prNum, branch: m.branch, sha: m.sha, timestamp: m.timestamp, files: m.files });
      }
    } catch (e) {
      // A held pipe usually manifests HERE first, not in phase 1: an fsmonitor hook is invoked by
      // `git status`, which is resumptionSignals' first call, while phase 1's `git config`/`git log`
      // never touch the index. A bare catch turned that into a vague "partial failure" with no
      // issue — so the run rendered an empty briefing and stamped. Same treatment as phase 1.
      // Whatever is already in `acts`/`td` is trustworthy and kept: runGit now only returns on a
      // COMPLETE read, so anything it handed back is whole by construction. (`merged` is necessarily
      // empty here — listPrMerges is the LAST call and only populates on success — so it is passed
      // for symmetry, not because partial merges can survive. No test can prove otherwise.)
      if (e instanceof IncompleteReadError) {
        return {
          activities: acts, today: td, mergedToday: merged, issues: [{ path: repo, kind: "unreadable" }],
          warnings: [`partial read of ${repo}: git's output could not be read to completion — ${e.reason}`],
        };
      }
      return { activities: acts, today: td, mergedToday: merged, issues: [], warnings: [`partial failure reading repo: ${repo}`] };
    }
    return { activities: acts, today: td, mergedToday: merged, issues: [], warnings: [] };
  });
  // Merge in readable order (deterministic): same intra-repo order (resumption → window commits) and
  // same cross-repo order as the previous sequential walk.
  for (const r of phase2) {
    activities.push(...r.activities);
    today.push(...r.today);
    mergedToday.push(...r.mergedToday);
    warnings.push(...r.warnings);
    issues.push(...r.issues);
  }

  // Linked worktrees share the object store AND the common refs (`git log --all` sees the same
  // commit set; `refs/stash` is likewise a shared ref — a stash made in one checkout shows in
  // `git stash list` from every worktree). So the same commits and stashes appear in each discovered
  // checkout and would otherwise double-recap under two repo labels (a mainstream workflow for this
  // product's audience: AI coding assistants, including this repo, create worktrees). Dedupe commits
  // (by SHA = event_id) and stashes (by their commit SHA) across repos, keeping the first. Genuinely
  // per-worktree signals — uncommitted changes and the current branch/HEAD — pass through untouched.
  // The window day-set is already a Set (no effect).
  // Split the (now window-wide) merge channel on `end`: same-day → mergedToday (existing "Today so
  // far" rendering), earlier → windowMerges (dated recap-foot lines). Same dedupe for both halves.
  const allMerges = dedupeBySha(mergedToday);
  const sameDayMerges = allMerges.filter((m) => new Date(m.timestamp).getTime() >= end.getTime());
  const windowMerges = allMerges.filter((m) => new Date(m.timestamp).getTime() < end.getTime());

  // IN-1 (Phase C; lands under the stacked comparability boundary the user declared 2026-09-17):
  // `dedupeTwins` ran on the same-day list only since day 33, so a rebase copy's patch-identical
  // twin still double-rendered in the WINDOW recap — day 34 measured five pairs, 22 items for ~17
  // changes. Both lists now get the same treatment, and INDEPENDENTLY: a window commit and its
  // same-day rebase copy stay one-in-each-list exactly as before. Scope extension only — a
  // cross-list collapse would be a new counting rule, and the same-day call is behaviourally the
  // one it was (`pid`/`rel` default to the same real implementations; only tests inject anything
  // else). Round 1 added the ancestry gate, which TIGHTENS both lists equally: a do-revert-redo
  // trio that the same-day path would have collapsed since day 33 now survives intact.
  //
  // WHERE this runs is the load-bearing decision, so it is pinned (test/day33-batch.test.ts): at the
  // RETURN, upstream of every reader of the window list — `resolveUnits` (`windowCommits`, the S3
  // share denominator), `reduce` → the prompt and `recapCoverage` (the `▶ What you did — N commits`
  // header's `total`). Header, coverage drop lines and bullets therefore count ONE population. A
  // dedupe placed downstream of any of those would re-create the day-49 shape (#424) — a header
  // that disagrees with its own bullets — this time by exactly the number of twins.
  const pid = opts?.patchIds ?? patchIds;
  const rel = opts?.ancestryRelated ?? ancestryRelated;
  return {
    activities: await dedupeTwins(dedupeSharedRefs(activities), pid, rel), warnings, issues,
    today: await dedupeTwins(dedupeSharedRefs(today), pid, rel),
    mergedToday: sameDayMerges, windowMerges, windowStartUtc: start.toISOString(),
  };
}

/** Defect E (EVAL day 33, user-directed): a rebase-merge copies branch commits onto main with new
 *  SHAs; with the originals still on a stale local branch, `--all` lists BOTH and "Today so far"
 *  double-counts (measured: five patch-identical pairs, 22 items for ~17 changes). Dedupe commits by
 *  `git patch-id --stable` — the exact CONTENT fingerprint — keeping the NEWEST copy per id.
 *  Cost-bounded: patch-ids are computed only for commits whose SUBJECT collides within their repo (a
 *  rebase copy keeps its subject verbatim), which is empty on a normal morning. Fail open: an
 *  unmapped SHA (a `patchIds` failure, or a throw from the injected seam) is never dropped.
 *
 *  ⚠ THE FINGERPRINT ALONE FALSE-POSITIVES, and IN-1 round 1 measured it: `feat: add b` →
 *  `Revert "feat: add b"` → `feat: add b` (re-land) gives copies 1 and 3 the same subject AND the
 *  same patch-id, because re-landing reproduces the content exactly. Dropping one deletes a commit
 *  that really happened — the recap then shows a revert of something absent from its own population,
 *  and `windowCommits` (the S3 denominator) reads one short. So a patch-id match only makes a pair a
 *  CANDIDATE; `ancestryRelated` then decides. Rebase / cherry-pick / squash copies live on divergent
 *  histories and are never ancestor-related; a revert-and-reland pair always is. Only a
 *  NOT-ancestor-related pair is collapsed, and an unknown answer (git error/timeout) keeps both —
 *  fail open on both legs, since a missed dedupe is cosmetic and a wrong drop is a lost commit.
 *
 *  ⚠ NAMED RESIDUAL — THREE COPIES, SURVIVOR-ONLY COMPARISON (IN-1 round 2, documented not fixed).
 *  The gate is evaluated between each candidate and the CHOSEN SURVIVOR, never pairwise, so a
 *  patch-id group is treated as ONE equivalence class when it may be several. Failure shape, built
 *  with real git and reproduced here: original **A** on main → revert → re-land **C** on main, plus a
 *  stale divergent copy **A2** on a local branch carrying the NEWEST committer date. A2 wins the
 *  survivor rule; A-vs-A2 and C-vs-A2 both answer "unrelated"; **both real commits are dropped and
 *  only the stale duplicate survives** — the recap then shows a revert of something absent from its
 *  own population. Three reasons it is recorded rather than repaired, each checked:
 *    1. NOT introduced by IN-1. Pre-IN-1 `dedupeTwins` had no gate at all and dropped every copy but
 *       the newest unconditionally — measured on this exact construction, it produces the IDENTICAL
 *       outcome (A dropped, C dropped, A2 kept). So this is a pre-existing property of this function
 *       that the window list now INHERITS, not a new one the window extension creates.
 *    2. Every obvious repair is a heuristic, not a rule. Partitioning the group into ancestry-
 *       connected components does not finish the job: in the construction above the components are
 *       {A,C} and {A2}, and something must still choose between two ancestry-disjoint components.
 *       "Contains the newest commit" picks {A2} and reproduces the bug exactly. "Largest component"
 *       happens to pick {A,C} here, but it is a tie-breaker rather than a discriminator — measured,
 *       one real commit plus TWO stale branch copies gives three patch-identical, mutually
 *       ancestry-DISJOINT singletons, where it is a 3-way tie and decides nothing. The one
 *       principled discriminator, default-branch membership, is unavailable for the reason L1
 *       already records below: `isDefaultBranch` is computed for the BRANCH signal (`git.ts`), and
 *       commit activities carry no branch membership at all.
 *    3. Reachability is narrow: it needs THREE patch-identical copies of one change with that
 *       specific date ordering (the stale one newest). IN-3 measured ZERO twins of any kind on days
 *       49-52 (`in3-diagnosis-part1.md`), and the worst real shape on record is day 34's five
 *       patch-identical PAIRS, which this residual does not touch.
 *  Pinned by `test/day33-batch.test.ts` so a future change to the survivor rule cannot silently
 *  alter it — that test asserts the CURRENT (lossy) behaviour, and is the place to change if the
 *  residual is ever repaired.
 *
 *  SURVIVOR = the newest committer date, ties broken by the lexicographically smaller SHA (L2: `git
 *  am -C` and `--committer-date-is-author-date` both make exact ties reachable, and an unstable
 *  survivor would flip the recap's evidence SHA between runs). That is a DETERMINISTIC rule, not a
 *  semantic one: a rebase copy usually gets a fresh committer date at merge time, so newest usually
 *  IS the mainline copy — but a fix cherry-picked FROM `main` ONTO a release branch inverts it and
 *  the BACKPORT survives (L1). Documented rather than fixed: nothing on a commit Activity records
 *  branch membership (`meta.isDefaultBranch` is computed for the BRANCH signal in `git.ts`, not
 *  per commit), so preferring the default-branch copy would cost a `git branch --contains` per
 *  candidate — real cost for a cosmetic pick between two copies of the SAME change.
 *
 *  IN-1 (Phase C, 2026-09-17): applied to the WINDOW list as well as the same-day list — see the
 *  call site in `gitActivity` for the scope and the header/coverage ordering decision. COST, measured
 *  under a wide window on synthetic repos (`gitActivity` wall-clock, median of 5; every git spawn
 *  counted through a PATH shim). `pre` = before IN-1, `r1` = this code:
 *                                          window commits    git spawns        wall ms
 *    300 unique subjects                    300 → 300         11 →  11        191 →  185
 *    300 + five day-34 twin pairs           310 → 305         11 →  31        189 →  432
 *    144 CONSTANT-subject, one day          144 → 144         11 →  13        153 →  206
 *    1 real + 432 excluded, 3 days          433 → 433         11 →  13        210 →  308
 *    30x (add | revert) = 60 commits         60 →  60         11 →  73        147 →  998
 *  There is NO per-SHA constant any more: `patchIds` batches a whole collision group into 2 spawns
 *  (git.ts), so the two auto-committer rows cost 2 extra spawns each rather than 2 per commit — the
 *  round-0 form of this change measured 299 spawns / 3,754 ms and 875 spawns / 11,041 ms on those
 *  same two rows. What is left scales with CANDIDATE PAIRS, not commits: ≤2 `merge-base
 *  --is-ancestor` per pair that collided on both subject and patch-id (~14 ms each). The last row is
 *  that worst case made maximal — every commit in the group patch-identical, 58 ancestry spawns —
 *  and it is also the row that shows WHY the gate exists: round 0 kept 2 of those 60 commits.
 *  Round-2 walls are 3-12% above the round-1 numbers this table replaced (182/386/201/289/925) —
 *  that is the patch-id spool's file create + unlink per collision group, the trade `git.ts` takes
 *  to keep peak RSS flat. SPAWN COUNTS ARE UNCHANGED, and so is every window-commit count.
 *  And the tail is now BOUNDED, which it was not: `ANCESTRY_CHECK_CAP` stops each collision group at
 *  32 checks (≤64 `merge-base` spawns, ~1.0 s) and keeps the whole group, so a revert-cycle repo can
 *  no longer turn one group into the ~10 s this table's shape extrapolates to at ~380-640 copies.
 *  The cap does not bind on ANY row above — row 5 measures identically with it removed.
 *
 *  Paid TWICE a day, not once: `scripts/audit.ts:386` re-derives ground truth through this same
 *  `gitActivity` over the same real repos, so every number above lands in the briefing run and again
 *  in the audit.
 *
 *  `meta.excluded` commits DO enter the collision set. Skipping them was proposed and is NOT applied:
 *  it also touches the same-day path (an excluded same-day pair currently collapses) and so is a user
 *  decision — and batching has made it moot, since it would now save 2 spawns. It would zero ONE of
 *  the two auto-committer rows, not both: row 4's subject is excluded (`vault backup: auto`), row 3's
 *  is `chore: autosave`, which the default `^vault backup:` pattern does not match — a NON-excluded
 *  constant-subject auto-committer is untouched by that proposal. Row 4 is the structurally MAXIMAL
 *  shape rather than an artificial one, because `committerDaysWithCommits` filters excluded subjects
 *  out of the day set: an excluded auto-committer stretches the window to the full `lookbackCapDays`
 *  instead of collapsing it onto its own busy day. The operator's own vault is neither shape — its
 *  subjects carry a timestamp (`vault backup: <date> <time>`), so they never collide at all. */
/** Most `merge-base --is-ancestor` checks `dedupeTwins` will run for ONE collision group before it
 *  gives up and keeps the whole group (IN-1 round 2). The gate is LINEAR, not quadratic — exactly
 *  K−1 checks for K patch-identical copies, measured by construction at K = 10/20/40/80 → 9/19/39/79
 *  — but nothing bounded K, and the wall-clock is real: 290/420/728/1385 ms at those four K, i.e.
 *  **15.6 ms per extra copy** (one spawn; a pair that is genuinely unrelated tries both directions
 *  and costs two). Uncapped, ~380-640 patch-identical copies of one change add ~10 s, and
 *  `scripts/audit.ts:386` re-derives the same ground truth, so it is paid TWICE a day.
 *
 *  32 because it bounds the pathology without touching anything real: the worst shape ever measured
 *  on real history is day 34's five patch-identical PAIRS (one check each), IN-3 measured ZERO twins
 *  on days 49-52, and the deliberately maximal synthetic row in the cost table below — 30 add/revert
 *  cycles, 58 `merge-base` spawns — does NOT reach it: that row is identical with the cap removed
 *  (measured: 60 commits / 73 spawns / 58 is-ancestor either way), as are the other four.
 *  The guarantee it buys: **≤32 checks ⇒ ≤64 `merge-base` spawns ⇒ ~1.0 s added wall-clock per
 *  collision group** (32 × 2 × 15.6 ms), against the ~10 s a single large group could previously
 *  cost. Bounds each GROUP, not the sum over groups — a repo with many distinct colliding subjects
 *  still pays per group, which is bounded only by the commit count; that axis is unchanged by IN-1
 *  and is not what this cap is for.
 *
 *  Exceeding it keeps EVERY commit in the group, including copies already decided droppable before
 *  the budget ran out — the same fail-open direction as an unanswered ancestry question. Pinned by
 *  `test/day33-batch.test.ts`; removing the cap makes that test drop 39 real commits. */
export const ANCESTRY_CHECK_CAP = 32;

export async function dedupeTwins(
  items: Activity[],
  patchIdsFn: typeof patchIds = patchIds,
  relatedFn: typeof ancestryRelated = ancestryRelated,
): Promise<Activity[]> {
  const bySubject = new Map<string, Activity[]>();
  for (const a of items) {
    if (a.kind !== "commit" || !a.event_id) continue;
    const key = `${a.repo ?? ""}\x1f${(a.text ?? "").trim()}`;
    bySubject.set(key, [...(bySubject.get(key) ?? []), a]);
  }
  const drop = new Set<string>();
  for (const group of bySubject.values()) {
    if (group.length < 2) continue;
    const repo = group[0]!.repo ?? "";
    // Per-group ancestry budget (IN-1 round 2). Checks are LINEAR in the group — exactly K−1 for K
    // patch-identical copies, verified by construction at K = 10/20/40/80 — but nothing bounded K,
    // and the work is paid twice a day (this call and `scripts/audit.ts:386`). See the cap's
    // rationale and measured worst case at ANCESTRY_CHECK_CAP.
    let checks = 0;
    let capHit = false;
    const groupDrop = new Set<string>();
    // ONE batched call per collision group (git.ts: 2 spawns, not 2 per SHA). `.catch` because the
    // seam is injectable and the docstring promises fail-open for a FAILURE, not just an absent SHA:
    // a throwing provider must degrade to "fingerprint nothing", never abort the briefing (L4).
    const ids = await patchIdsFn(repo, group.map((a) => a.event_id!)).catch(() => new Map<string, string>());
    const byId = new Map<string, Activity[]>();
    for (const a of group) {
      const id = ids.get(a.event_id!);
      if (!id) continue; // fail open
      byId.set(id, [...(byId.get(id) ?? []), a]);
    }
    for (const twins of byId.values()) {
      if (capHit) break;
      if (twins.length < 2) continue;
      const sorted = [...twins].sort((a, b) => {
        const byDate = new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime();
        return byDate !== 0 ? byDate : (a.event_id! < b.event_id! ? -1 : 1); // deterministic on a tie
      });
      const survivor = sorted[0]!;
      for (const older of sorted.slice(1)) {
        if (checks >= ANCESTRY_CHECK_CAP) { capHit = true; break; }
        checks++;
        // A patch-id match is only a CANDIDATE. Ancestor-related (a revert-and-reland) → both are
        // real commits; unknown (git error) → we do not know, so we keep both. Drop ONLY on a
        // definite `false`. One check per candidate, and only ever for an already-colliding pair.
        const related = await relatedFn(repo, older.event_id!, survivor.event_id!).catch(() => undefined);
        if (related !== false) continue;
        groupDrop.add(older.event_id!);
      }
    }
    // Over budget ⇒ this group contributes NOTHING, including the drops already decided before the
    // cap was reached. Keeping a partially-deduped group would make the output depend on Map
    // iteration order; keeping ALL of it is the same fail-open direction as an unanswered ancestry
    // question — never drop on a question we stopped asking.
    if (!capHit) for (const id of groupDrop) drop.add(id);
  }
  // `drop` is populated from commits only, so the filter states that too: an `event_id` collision
  // with a non-commit activity is unreachable today (their ids are prefixed) but would otherwise
  // silently delete an unrelated row (L3).
  return drop.size === 0 ? items : items.filter((a) => !(a.kind === "commit" && drop.has(a.event_id)));
}

// Keep the first commit (by SHA=event_id) and the first stash (by its commit SHA); pass genuinely
// per-worktree activities (uncommitted, branch) through untouched.
export function dedupeSharedRefs(items: Activity[]): Activity[] {
  const seenCommit = new Set<string>();
  const seenStash = new Set<string>();
  return items.filter((a) => {
    if (a.kind === "commit") return !seenCommit.has(a.event_id) && (seenCommit.add(a.event_id), true);
    if (a.kind === "stash") {
      const sha = (a.meta as { sha?: string } | undefined)?.sha;
      if (!sha) return true; // no SHA to dedupe by → keep (can't safely collapse)
      return !seenStash.has(sha) && (seenStash.add(sha), true);
    }
    return true;
  });
}

function dedupeBySha(merges: MergedToday[]): MergedToday[] {
  const seen = new Set<string>();
  return merges.filter((m) => !seen.has(m.sha) && (seen.add(m.sha), true));
}
