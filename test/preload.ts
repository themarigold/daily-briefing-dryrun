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
import { afterAll, afterEach } from "bun:test";
// Evaluated here, before any test file, so DAILY_BRIEFING_STATE_DIR and XDG_CONFIG_HOME are isolated from
// the first test on and are tripwires that cannot be cleared — see the file for the 2026-09-15 live-state
// write this closes.
import { takeIsolationViolations } from "./fixtures/isolate-state";
import { removeRegisteredTempDirs } from "./fixtures/temp-dirs";
import { setGitFlushMsForTests } from "../src/git";

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
  const report = isolationReport("during this test");
  if (report) throw new Error(report);
});

// After the last test file: delete every temp directory registered with `removeAtRunEnd`
// (fixtures/temp-dirs.ts owns what may be registered and how it is removed). Deliberately NOT the two
// `dba-isolated-*` baseline directories from fixtures/isolate-state.ts: they are never registered — the
// decision recorded there to keep them was not revisited by this hook.
//
// An unremovable directory FAILS THE RUN, exit 1, by design: bun reports the throwing afterAll as
// `(fail) (unnamed)` with a stack naming this file. On a shared sticky /tmp another uid could squat the
// provider's fixed fallback name — the one registered path the suite does not mkdtemp itself, registered
// by harden.activation's B3 test; the product refuses such a directory, and this hook reports it rather
// than hiding it. The hook has bun's 5000 ms timeout; draining a full run's 827 directories measured
// 0.9 s in-hook (bun 1.3.14). A synchronous hook that overruns still runs to completion — the directories
// ARE removed — and is then reported `(fail) (unnamed) [<elapsed>ms]` under the LAST test file's header,
// with no mention of preload.ts.
//
// The isolation check runs here too, for a clear that lands after the last test's `afterEach` — an
// orphaned continuation from a timed-out test is exactly that shape. Both failures are reported together;
// neither hides the other.
afterAll(() => {
  let drainError: unknown;
  try { removeRegisteredTempDirs(); } catch (e) { drainError = e; }
  const report = isolationReport("after the last test");
  if (drainError !== undefined && report) {
    const drain = drainError instanceof Error ? drainError.stack ?? drainError.message : String(drainError);
    throw new Error(`${drain}\n\nand, separately, ${report}`);
  }
  if (drainError !== undefined) throw drainError;
  if (report) throw new Error(report);
});
