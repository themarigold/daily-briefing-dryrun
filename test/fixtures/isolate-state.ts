// Side-effect import: `import "./fixtures/isolate-state";` (path relative to the importing test). Every
// test file that can reach the state dir or the user config imports it — isolation.meta.test.ts enforces
// that — and test/preload.ts imports it too, so it evaluates ONCE, before the first test file, when bun
// runs from the package root (the only place bunfig.toml's preload is read). From any other cwd the
// preload is skipped, and the first importing file arms it instead.
//
// Points DAILY_BRIEFING_STATE_DIR and XDG_CONFIG_HOME at per-process temp directories so that any call
// which FALLS BACK to the real location writes there instead: for the state dir, `supportDir()` —
// `hardenedProvider()` with no `stateDir` (src/harden.ts `cwdOnce`), `runCore()` with no injected
// `persistHealth` (src/core.ts `persistHealth`), the marker helpers, the account store — instead of the
// developer's real `~/Library/Application Support/daily-briefing`, alongside `account-state.json` and
// `last-run`; for the config, `configPath()` (src/config.ts:51) instead of `~/.config/daily-briefing`.
//
// And, since Batch 2 (spec 3.1.3), DBA_TEST_UNIT_DIR, a third per-process temp directory. It is not a
// fallback location like the other two: it is what ARMS the default exec's refusal in
// src/schedule/install.ts, so a scheduler change (`launchctl bootout`, `systemctl --user stop`, …) that
// reaches the default exec in any engine test process spawns nothing and comes back as -2. The refusal
// reads `process.env` as well as the env the exec was built from, so a test that passes neither `exec`
// nor `env`, or an env object of its own without the variable, is still refused. Because the launchd
// and systemd user domains act by uid, not by HOME, no scratch HOME isolates the live job; this does.
// (It also redirects `unitDir`, whose override it is; the schedule tests pass their own unit dir in `env`.)
//
// It OVERRIDES an inherited value, NOT `??=`. The `??=` this started as honoured an INHERITED value, and
// `src/marker.ts:8-10` documents DAILY_BRIEFING_STATE_DIR as a supported power-user override — so a
// developer or CI runner who had exported it ran the ENTIRE suite against their real configured state
// dir with all three scanners green, and a HOME-redirected probe could not see it (redirecting HOME
// changes nothing when the variable is set explicitly). That is the exact hazard this fixture exists to
// remove, so it must win over the ambient environment.
//
// It is deliberately NOT removed afterwards — the point is that the real location is unreachable for the
// whole process, and restoring it mid-run would reopen the hole. "The whole process" is exact: a child
// spawned WITHOUT an `env` option gets the process's STARTUP environment, not these values (measured,
// bun 1.3.14), so it is not covered; pass `env: { ...process.env, … }`. isolation.meta.test.ts's scanner 6
// enforces that for the child `bun` spawns of src/main.ts or a scripts/*.ts entry it can read; its header
// lists the spellings it cannot.
//
// ── WHY THE PRELOAD, AND WHY A TRIPWIRE (2026-09-19) ────────────────────────────────────────────────────
// The live state dir's `briefings/2026-09-15.md` was a 495-byte fixture — json-envelope's MODEL_OUT, repo
// `dba-repo-2mrol1` — written 2026-09-15 14:26 PDT during the flake-chase induction runs
// (docs/flake-chase-2026-09-15.md, which records `dba-repo-2mrol1` in the cross-talk it saw). Mechanism,
// reproduced on the unmodified suite (6 of 27 runs of transcripts-safety + json-envelope at --timeout
// 450-900 ms wrote briefing-latest.md, briefings/<today>.md and last-run into a sandboxed HOME):
//   1. transcripts-safety.test.ts runs FIRST in bun's file order and did not import this module, so its
//      T8.1 CALL SITE test saved `prev = undefined` for the state dir (and for XDG_CONFIG_HOME, which macOS
//      leaves unset) before pointing both at its own dirs.
//   2. That test timed out (bun's 5 s default, under load). bun moved on; its run() kept going.
//   3. Its `finally` then deleted both variables while a LATER test (json-envelope) was mid-run(), and that
//      test's remaining writes resolved supportDir() to the real HOME location. The config dir fell back
//      the same way (reproduced by review in a disposable copy); nothing wrote it that time.
// Every save/restore in the suite is individually correct; what broke was a save that ran before any
// baseline existed. With the baseline armed before the first save, no save can capture `undefined`.
//
// The tripwire makes the invariant hold for whatever the static scanners in isolation.meta.test.ts cannot
// see (computed keys, helpers in src/, an orphaned async continuation): each variable becomes an accessor
// that can be reassigned but never removed. The `delete` operator throws (strict mode — every test file is
// an ES module; `Reflect.deleteProperty` returns false); an assignment of `undefined`/`null`/`""` is
// recorded; a READ while cleared is recorded and RE-ARMS the variable to its baseline, so the fallback is
// never resolved and one clear fails one test rather than every test after it. test/preload.ts fails the
// test (or the run) that saw a record; without the preload, nothing reports, but nothing leaks either.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const violations: string[] = [];

/** The call stack below the accessor frame (which is listed first), deep enough to reach the test. */
const where = (): string => (new Error().stack ?? "").split("\n").slice(2, 14).join("\n");

function armTripwire(name: string, baseline: string): void {
  let current: string | undefined;   // set through the accessor, by the assignments below
  Object.defineProperty(process.env, name, {
    enumerable: true,
    configurable: false,
    get(): string {
      if (current) return current;
      violations.push(`${name} read while cleared — would have resolved the REAL location; re-armed to the baseline:\n${where()}`);
      current = baseline;
      return baseline;
    },
    set(v: unknown) {
      current = v === undefined || v === null ? undefined : String(v);
      if (!current) violations.push(`${name} cleared (assigned ${JSON.stringify(v)}):\n${where()}`);
    },
  });
}

const STATE_BASELINE = mkdtempSync(join(tmpdir(), "dba-isolated-state-"));
const CONFIG_BASELINE = mkdtempSync(join(tmpdir(), "dba-isolated-config-"));
// The third baseline, made the same way and, like the other two, never registered for run-end removal
// (scanner 5 allows this file's unwrapped mkdtemp calls; see its TMP_SELF_CLEANING entry).
const UNITS_BASELINE = mkdtempSync(join(tmpdir(), "dba-isolated-units-"));
armTripwire("DAILY_BRIEFING_STATE_DIR", STATE_BASELINE);
armTripwire("XDG_CONFIG_HOME", CONFIG_BASELINE);
armTripwire("DBA_TEST_UNIT_DIR", UNITS_BASELINE);

// The baselines, assigned through the accessors. Plain assignments on purpose: they are also the shape
// isolation.meta.test.ts's `setsEnv` reads.
process.env.DAILY_BRIEFING_STATE_DIR = STATE_BASELINE;
process.env.XDG_CONFIG_HOME = CONFIG_BASELINE;
process.env.DBA_TEST_UNIT_DIR = UNITS_BASELINE;

/** Every record since the last call, oldest first; the list is emptied. */
export function takeIsolationViolations(): string[] {
  return violations.splice(0);
}
