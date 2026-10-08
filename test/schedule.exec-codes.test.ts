import "./fixtures/isolate-state";   // A0 — arms the isolation variables from any cwd (see test/isolation.meta.test.ts)
// Batch 2 T1.2 step 3 — the exec failure codes (spec 3.1.4), tested through `execResultOf`.
//
// Spec 3.1.3 lets exactly ONE test call the exported default exec (the host-absent probe in
// test/schedule.install.test.ts), so the mapping from `proc.run`'s result to this module's codes is
// tested here, through the helper the default exec applies to `run(…)`:
//   a rejected promise → -2 · `!spawned` → -2 · `timedOut` or `!complete` → -1 · otherwise the real code.
//
// ⚠ This file deliberately names no OS scheduler tool, keychain or signing tool: its real processes are
// a path that does not exist and `/bin/sh`. Everything else is a synthetic `RunResult`, one condition per
// case, each carrying `code: 0` unless stated, so a deleted check shows as a wrong code instead of passing
// through a -1 that `proc.run` would have set anyway. No real timeout is run: the synthetic `timedOut`
// case covers -1 without a timed wait.
import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execResultOf } from "../src/schedule/install";
import { run, type RunResult } from "../src/proc";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

/** A clean result: spawned, read to EOF, not timed out, exit 0. Each case below changes one field. */
const CLEAN: RunResult = { out: "", err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false };

describe("isolation guard", () => {
  describe("exec failure codes (spec 3.1.4), through execResultOf", () => {
    test("a real process that cannot spawn (a non-existent absolute path) → -2", async () => {
      const missing = join(removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-exec-codes-"))), "no-such-binary");
      const pending = run([missing]);
      const r = await execResultOf(pending);
      expect(r.code).toBe(-2);
      // Settles the plan's `UNVERIFIED: Bun.spawn throws for a missing executable`: `proc.run` reports it
      // as `spawned: false` (src/proc.ts's catch), which is the arm that produced the -2 above.
      expect((await pending).spawned).toBe(false);
    });

    test("a real process that exits 3 → 3, its real code", async () => {
      const r = await execResultOf(run(["/bin/sh", "-c", "exit 3"]));
      expect(r.code).toBe(3);
    });

    test("synthetic: spawned: false → -2", async () => {
      const r = await execResultOf(Promise.resolve({ ...CLEAN, spawned: false, complete: false, timedOut: false }));
      expect(r.code).toBe(-2);
    });

    test("synthetic: timedOut alone (spawned, complete) → -1", async () => {
      const r = await execResultOf(Promise.resolve({ ...CLEAN, timedOut: true }));
      expect(r.code).toBe(-1);
    });

    test("synthetic: an incomplete read alone (spawned, not timed out) → -1", async () => {
      const r = await execResultOf(Promise.resolve({ ...CLEAN, complete: false }));
      expect(r.code).toBe(-1);
    });

    test("synthetic: a normal result → its real code, with out and err passed through", async () => {
      const r = await execResultOf(Promise.resolve({ ...CLEAN, code: 3, out: "the out text", err: "the err text" }));
      expect(r).toEqual({ code: 3, out: "the out text", err: "the err text" });
    });

    test("synthetic: a rejected promise → -2", async () => {
      const r = await execResultOf(Promise.reject(new Error("boom")));
      expect(r.code).toBe(-2);
      expect(r.err).toContain("boom");
    });
  });
});
