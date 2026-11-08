// test/keyStore.child-bound.test.ts — no Keychain child outlives its call (PR 2 final harden round 1, A1).
//
// Each Keychain call is raced against its bound (`within`) AND its child is SIGKILLed by proc's `run` at its own
// `timeoutMs`. Were the two equal, the race's timer — armed first — would win: the call would return, `main` would
// `process.exit`, and the child's kill timer would never fire, so a `security` blocked on an unlock dialog would be
// left running (and could still complete a delete or an add later). So the child's own bound is SHORTER than the race
// (src/keyStore.ts `CHILD_KILL_MARGIN_MS`): proc's kill lands, and is reaped, while the call is still waiting.
//
// Proved with a REAL child: the injected exec ignores the Keychain argv it is handed and runs a harmless
// `/bin/sh -c 'echo $$ >> <file>; exec /bin/sleep 30'` through proc's `run`, with exactly the options the store passes
// (so its `timeoutMs`). Never the Keychain tool (hub Q27: Keychain tests are fake-only). The pid file names every child
// the call started; each must be gone (ESRCH — killed AND reaped) the moment the call resolves, with no extra turn of
// the event loop. This file deliberately names none of the app's key-name constants (isolation.meta's "a test file
// that imports SECURITY_BIN or APP_KEY_SERVICE spawns nothing").
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/proc";
import { CHILD_KILL_MARGIN_MS, KEY_CALL_MIN_MS, keychainDelete, keychainDeleteAll, keychainSet, type KeyExec } from "../src/keyStore";
import { tempDir } from "./helpers/walk";

const HOME = "/Users/fake person";
const KEY = "sk-ant-api03_AbC.def~ghi+jkl/mno=pqr-STU";

/** An exec that starts one long-lived harmless child per call, recording its pid, under the store's own options. */
function sleeper() {
  const pidFile = join(tempDir("dba-kc-child-"), "pids");
  const exec: KeyExec = (_cmd, opts) => run(["/bin/sh", "-c", `echo $$ >> '${pidFile}'; exec /bin/sleep 30`], opts);
  const pids = (): number[] => (existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);
  return { exec, pids };
}
/** ESRCH only: a zombie (killed, not yet reaped) still answers `kill(pid, 0)`. */
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("a timed-out Keychain call kills its child before it returns (A1)", () => {
  test("the child's own bound is shorter than the race, by the margin proc's run needs to kill and report it", () => {
    expect(CHILD_KILL_MARGIN_MS).toBeGreaterThanOrEqual(250 + 250);   // FLUSH_MS + a kill-and-reap grace
  });

  test("key delete: the timed-out child is gone the moment the call resolves", async () => {
    const s = sleeper();
    const r = await keychainDelete("k-0123456789ab", { exec: s.exec, home: HOME, env: {}, deadlineMs: 1_500 });
    const live = s.pids().filter(alive);                    // synchronously, right after the await
    expect(r.ok ? "ok" : r.reason).toBe("timeout");
    expect(s.pids().length).toBe(1);
    expect(live).toEqual([]);
  });

  test("key delete-all: the same", async () => {
    const s = sleeper();
    const r = await keychainDeleteAll({ exec: s.exec, home: HOME, env: {}, deadlineMs: 1_500 });
    const live = s.pids().filter(alive);
    expect(r.ok ? "ok" : r.reason).toBe("timeout");
    expect(s.pids().length).toBe(1);
    expect(live).toEqual([]);
  });

  test("key set: the timed-out add AND its timed-out cleanup delete are both gone when the set resolves", async () => {
    const s = sleeper();
    const r = await keychainSet(KEY, { exec: s.exec, home: HOME, env: {}, deadlineMs: 1_500, cleanupMs: 1_500 });
    const live = s.pids().filter(alive);
    expect(r.ok ? "ok" : `${r.reason}/${r.cleanup}`).toBe("timeout/timeout");
    expect(s.pids().length).toBe(2);
    expect(live).toEqual([]);
  });
});

// PR 2 final r2 L2: under a few ms the child's own bound (half the call's) can no longer beat the race — measured, a 1–2
// ms call left its child alive after the call returned. So a call with less than `KEY_CALL_MIN_MS` left spawns NOTHING
// and answers timed out; at the floor the child is still killed and reaped before the call returns.
describe("a call below the floor spawns nothing (L2)", () => {
  test("the floor is a named bound, and below it the exec is never reached: timeout, no child", async () => {
    expect(KEY_CALL_MIN_MS).toBeGreaterThanOrEqual(50);
    for (const deadlineMs of [1, 2, KEY_CALL_MIN_MS - 1]) {
      const s = sleeper();
      let calls = 0;
      const exec: KeyExec = (cmd, opts) => { calls++; return s.exec(cmd, opts); };
      const del = await keychainDelete("k-0123456789ab", { exec, home: HOME, env: {}, deadlineMs });
      const all = await keychainDeleteAll({ exec, home: HOME, env: {}, deadlineMs });
      const set = await keychainSet(KEY, { exec, home: HOME, env: {}, deadlineMs, cleanupMs: deadlineMs });
      await Bun.sleep(50);                                   // a child spawned anyway would have written its pid by now
      expect([deadlineMs, del.ok ? "ok" : del.reason, all.ok ? "ok" : all.reason, set.ok ? "ok" : `${set.reason}/${set.cleanup}`, calls, s.pids().length])
        .toEqual([deadlineMs, "timeout", "timeout", "timeout/timeout", 0, 0]);
    }
  });

  test("AT the floor the call runs, and its timed-out child is gone the moment the call resolves", async () => {
    let seen = 0;
    for (let i = 0; i < 10; i++) {
      const s = sleeper();
      const r = await keychainDelete("k-0123456789ab", { exec: s.exec, home: HOME, env: {}, deadlineMs: KEY_CALL_MIN_MS });
      const live = s.pids().filter(alive);                  // synchronously, right after the await
      expect([r.ok ? "ok" : r.reason, live]).toEqual(["timeout", []]);
      seen += s.pids().length;
    }
    expect(seen).toBeGreaterThan(0);                         // not vacuous: children did start
  });
});
