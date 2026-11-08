// test/preload.ts — run-wide test hooks. Loaded ONCE per `bun test` process, before any test file,
// via bunfig.toml (`[test] preload`), so a hook registered here scopes to the WHOLE run — the only
// scope bun offers that outlives a single file. Measured on bun 1.3.14, the alternatives do not:
//   - a hook at the top level of a fixture module binds only to the file that imported it FIRST
//     (ESM caching evaluates the module once per process, so later importers register nothing);
//   - a hook registered while a test or beforeAll is running fires as soon as THAT unit ends
//     (a repo built in beforeAll would be deleted before the first test used it);
//   - process "exit" / "beforeExit" handlers never fire under `bun test`.
// An `afterEach` registered here fires after every test in every file, including tests inside `describe`
// blocks (measured, bun 1.3.14), and a throw from it fails the test it follows.
// ⚠ bun reads bunfig.toml only from the directory it runs in, so NONE of this loads when `bun test` runs
// from anywhere but the package root.
import { afterAll, afterEach, beforeEach } from "bun:test";
import { basename } from "node:path";
// Evaluated here, before any test file, so DAILY_BRIEFING_STATE_DIR and XDG_CONFIG_HOME are isolated from
// the first test on and are tripwires that cannot be cleared — see the file for the 2026-09-15 live-state
// write this closes. DBA_TEST_UNIT_DIR is armed the same way (Batch 2), which arms the default exec's
// refusal of scheduler changes in src/schedule/install.ts for every test process.
import { takeIsolationViolations } from "./fixtures/isolate-state";
// Already evaluated by the import above (isolate-state imports it first): TMPDIR is this run's own root.
import { OUTER_TMP, RUN_TMP, sweepDeadRunRoots } from "./fixtures/run-tmp";
import { removeRegisteredTempDirs, removeTree } from "./fixtures/temp-dirs";
import { setGitFlushMsForTests } from "../src/git";
import {
  installSpawnGuard, recordGuardViolation, reinstallSpawnGuard, resetSpawnOptIn, spawnGuardInstalled, spawnOptInSet, takeGuardViolations,
} from "./fixtures/spawn-guard";

// ── The spawn guard (provider-fallback plan P1-M1-T2) ─────────────────────────────────────────────────
// No test may reach the real Keychain tool. Installed here, before any test file, over `Bun.spawn` and
// `Bun.spawnSync`; the state and the opt-in live in fixtures/spawn-guard.ts. ⚠ THE MATCH LITERALS LIVE
// HERE AND NOWHERE ELSE IN test/: this file is not a `*.test.ts` file and nothing imports it, so the
// never-reach scanner (isolation.meta.test.ts) never reads it, and it exports nothing. A helper holding
// them would hand them to every test that imports it. Matched by BASENAME, case-folded: that covers the
// absolute path, a bare name resolved through PATH and a look-alike path alike, and on the case-insensitive
// default volume `/usr/bin/Security` is the same inode as the real tool (P1-M1 checkpoint MED).
// It is applied to every argv element and every shell word of each (fixtures/spawn-guard.ts), whose header states
// what still gets through: a name built inside the child, and anything spawned outside this process.
// NFKC first (PR 1 final review round 1, L4): `/usr/bin/ſecurity` (U+017F) folds to the same name, and on APFS's
// default volume it is the same file as the real tool.
installSpawnGuard((program) => basename(program).normalize("NFKC").toLowerCase() === "security");

// ── Dead earlier runs' roots (user decision 2026-10-19) ──────────────────────────────────────────────
// A run that never reached the afterAll below (interrupted, or run without this preload) left its ONE
// `dba-run-*` root in the outer TMPDIR. Removed here only once its owner pid is dead; fixtures/run-tmp.ts's
// `sweepDeadRunRoots` lists every condition, and nothing without its marker is touched. Best effort: a root
// that will not go is reported on stderr and costs this run nothing.
{
  const { failed } = sweepDeadRunRoots(OUTER_TMP);
  if (failed.length > 0) console.warn(`test/preload.ts: could not sweep ${failed.length} dead run root(s):\n  ${failed.join("\n  ")}`);
}

/** The failure message for every spawn-guard record since the last call, or undefined when there are none. */
function guardReport(when: string): string | undefined {
  const seen = takeGuardViolations();
  if (seen.length === 0) return undefined;
  return `the spawn guard (test/fixtures/spawn-guard.ts) refused ${seen.length} spawn(s) ${when}. No test may reach ` +
    `the Keychain tool: inject the exec, or opt in from an OPT_IN_FILES file's beforeEach. A record left by a ` +
    `file's afterAll is reported against the NEXT file's first test, so read the stacks, not just the test ` +
    `name:\n\n${seen.join("\n\n")}`;
}

/** The guard's own after-test checks, as messages: the guard still installed (put back if not), and the
 *  record drained. Clears the opt-in first, so nothing below can leave it set. */
function guardProblems(when: string): string[] {
  resetSpawnOptIn();
  const out: string[] = [];
  if (!spawnGuardInstalled()) {
    reinstallSpawnGuard();
    out.push(`Bun.spawn / Bun.spawnSync were no longer the spawn guard's ${when} — something replaced them and did not ` +
      `restore them (a spyOn restores itself; an assignment does not). The guard has been put back.`);
  }
  const report = guardReport(when);
  if (report) out.push(report);
  return out;
}

// An opt-in is per test, set in the test file's own beforeEach, which runs AFTER this one. So one already set
// here was set outside any test — a file's beforeAll, or an earlier file's afterAll — and would otherwise
// carry into this test. Cleared, and recorded so this test's afterEach fails.
beforeEach(() => {
  if (!spawnOptInSet()) return;
  resetSpawnOptIn();
  recordGuardViolation("a spawn-guard opt-in was set outside a test (a file's beforeAll or afterAll) and has been " +
    "cleared — opt in from the opting-in file's beforeEach only");
});

// The scheduled run's keep-awake switch (src/schedule/units.ts `KEEP_AWAKE_ENV`). With it set, a test that
// reaches `dispatch run` without injecting `keepAwake` would start a REAL `/usr/bin/caffeinate`. Only the
// LaunchAgent sets it, but a developer's shell or a scheduled parent could export it, so it is cleared for
// the whole run. (A child spawned with no `env` would still see the startup value; scanner 6 requires every
// child bun that runs an entry point to get an explicit one.)
delete process.env.DAILY_BRIEFING_KEEP_AWAKE;

/** The failure message for every tripwire record since the last call, or undefined when there are none. */
function isolationReport(when: string): string | undefined {
  const seen = takeIsolationViolations();
  if (seen.length === 0) return undefined;
  return `an isolation variable was cleared ${when} (${seen.length} record(s)). Without the tripwire in ` +
    `test/fixtures/isolate-state.ts the writes that followed would have gone to the REAL state dir or user ` +
    `config. The clear may come from EARLIER code whose async work outlived it — a timed-out test keeps ` +
    `running, and a clear in a hook is reported against the next test — so read the stacks, not just the ` +
    `test name:\n\n${seen.join("\n\n")}`;
}

afterEach(() => {
  // Backstop for fastGitFlush() (fixtures/git-flush.ts): the override is module state, so a shortened
  // flush window that a test failed to restore — a timeout that skipped its `finally`, a forgotten
  // restore — would otherwise reach the real-git tests after it. First, so a throw below cannot skip it.
  setGitFlushMsForTests(undefined);
  // Second, for the same reason: the opt-in is cleared before anything here can throw. Every failure is
  // reported together; none hides another.
  const problems = guardProblems("after this test");
  const report = isolationReport("during this test");
  if (report) problems.unshift(report);
  if (problems.length > 0) throw new Error(problems.join("\n\nand, separately, "));
});

// After the last test file: delete every temp directory registered with `removeAtRunEnd`
// (fixtures/temp-dirs.ts owns what may be registered and how it is removed), and LAST of all — after the
// drain and every isolation and spawn-guard check — the run root itself (fixtures/run-tmp.ts), which holds
// everything this process made under TMPDIR, the three `dba-isolated-*` baselines from
// fixtures/isolate-state.ts included. Those are never registered: draining them would delete the
// process-wide state, config and unit dirs before the checks below have run. A root that will not go fails
// the run like an unremovable registered dir.
//
// An unremovable directory FAILS THE RUN, exit 1, by design: bun reports the throwing afterAll as
// `(fail) (unnamed)` with a stack naming this file. On a shared sticky /tmp another uid could squat the
// provider's fixed fallback name — the one registered path the suite does not mkdtemp itself, registered
// by harden.activation's B3 test; the product refuses such a directory, and this hook reports it rather
// than hiding it.
//
// ⚠ ITS TIMEOUT IS 30 s, NOT bun's 5000 ms default — raised 2026-10-03 on measurement, not to hide a hang.
// The drain is synchronous, so bun's timeout can never stop it: a hook that overruns still runs to
// completion — the directories ARE removed — and is only then reported `(fail) (unnamed) [<elapsed>ms]`
// under the LAST test file's header, with no mention of preload.ts (reproduced with a 6 s synchronous
// preload afterAll, bun 1.3.14). The default bought no protection, only a false failure once the run grew.
// At #488 a full run's 827 directories drained in 0.9 s. On 2026-10-03 it was 1,540 directories holding
// 36,343 entries (425 of them `.git` dirs): 2.3 s in-hook on an Apple-silicon Mac; on the GitHub
// macos-latest runner ~2.4 s in run 36946149314 (log timestamps around the hook) and 5.8 s in run
// 37112733418, which failed the job as `(fail) (unnamed) [5825.15ms]` after test/eval/checks.g6.test.ts.
// The cost is unlinking those entries (~80–85% of it; the chmod walk is the rest): legitimate work that
// grows with what the suite creates, not a stall — and not git's detached auto-maintenance, which was not
// running at drain time and leaves nothing behind in these repos (both measured). 30 s is 5x the worst
// observed drain.
//
// The isolation check runs here too, for a clear that lands after the last test's `afterEach` — an
// orphaned continuation from a timed-out test is exactly that shape. Both failures are reported together;
// neither hides the other.
//
// The spawn guard is checked here too, for the same reason: a file's afterAll runs after the last preload
// afterEach of that file, so the LAST file's afterAll is seen only here — an opt-in it left set, or a
// refusal it recorded (an earlier file's is reported against the next file's first test).
afterAll(() => {
  let drainError: unknown;
  try { removeRegisteredTempDirs(); } catch (e) { drainError = e; }
  const reports: string[] = [];
  const report = isolationReport("after the last test");
  if (report) reports.push(report);
  if (spawnOptInSet()) {
    reports.push("a spawn-guard opt-in was left set after the last test (a file's afterAll) — opt in from the " +
      "opting-in file's beforeEach only");
  }
  reports.push(...guardProblems("after the last test"));
  // LAST, after every check above has read what it needs. The variables keep pointing into the root, never at
  // the real locations. So a straggler that writes after this cannot reach real state, but one that
  // `mkdir -p`s its baseline recreates RUN_TMP itself in the outer TMPDIR, WITHOUT an owner marker, and the
  // sweep at the next run's start never removes a root without one: that root stays until someone deletes it.
  try { removeTree(RUN_TMP); } catch (e) { reports.push(`the run root (test/fixtures/run-tmp.ts) was not removed: ${e instanceof Error ? e.message : String(e)}`); }
  if (drainError !== undefined && reports.length > 0) {
    const drain = drainError instanceof Error ? drainError.stack ?? drainError.message : String(drainError);
    throw new Error(`${drain}\n\nand, separately, ${reports.join("\n\nand, separately, ")}`);
  }
  if (drainError !== undefined) throw drainError;
  if (reports.length > 0) throw new Error(reports.join("\n\nand, separately, "));
}, { timeout: 30_000 });
