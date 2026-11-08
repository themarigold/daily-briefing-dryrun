// test/fixtures/dead-pid.ts — a pid that is dead, for tests that plant a dead run's root (fixtures/run-tmp.ts).
// Its own module, NOT in run-tmp.ts: isolation.meta's never-reach scanner reads every test file together with
// the helpers it imports, and run-tmp.ts reaches nearly every file through isolate-state.ts, so a spawn there
// would revoke the REACH_CONDITIONAL exemptions of files that must spawn nothing.

/** A pid that WAS a process and is not one now — a child that has exited and been reaped — checked to be
 *  ESRCH before it is returned. */
export function deadPid(): number {
  const r = Bun.spawnSync(["true"]);
  try { process.kill(r.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return r.pid; }
  throw new Error(`deadPid: pid ${r.pid} is not reported dead (ESRCH)`);
}
