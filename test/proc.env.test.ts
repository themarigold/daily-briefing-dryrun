// test/proc.env.test.ts
//
// `run()` hands its child the CURRENT environment, not bun's startup one. A `Bun.spawn` with no `env`
// option gives the child the STARTUP environment, so a variable set on process.env at runtime never
// reaches it (measured, bun 1.3.14). The isolation fixture is exactly such a runtime edit, so before
// this `run()` let a child escape it: scripts/audit.ts regenerates a briefing with `bun run
// src/main.ts run --force` through `run()`, and that child resolved the REAL state and config dirs.
// isolation.meta.test.ts's scanner 6 judges `run(` calls on the strength of this file.
import "./fixtures/isolate-state";   // arms the two variables at runtime, from any cwd
import { test, expect } from "bun:test";
import { run } from "../src/proc";

const SHOW = 'printf "%s|%s|%s" "${DBA_PROC_ENV_PROBE-UNSET}" "${DAILY_BRIEFING_STATE_DIR-UNSET}" "${XDG_CONFIG_HOME-UNSET}"';

test("a child started by run() sees a variable set on process.env at RUNTIME", async () => {
  const prev = process.env.DBA_PROC_ENV_PROBE;
  const value = `set-at-runtime-${process.pid}-${Date.now()}`;
  process.env.DBA_PROC_ENV_PROBE = value;
  try {
    const r = await run(["sh", "-c", SHOW]);
    expect(r.code).toBe(0);
    expect(r.out.split("|")[0]).toBe(value);
  } finally {
    if (prev === undefined) delete process.env.DBA_PROC_ENV_PROBE; else process.env.DBA_PROC_ENV_PROBE = prev;
  }
});

test("a child started by run() gets the isolation fixture's ARMED state and config dirs", async () => {
  // Both hold a temp dir set at RUNTIME: the fixture's mkdtemp baseline, or an earlier file's own dir
  // while it has them swapped. Neither can be the startup value, so a child that got the startup
  // environment prints something else here: UNSET, or whatever the developer's shell exports.
  const state = process.env.DAILY_BRIEFING_STATE_DIR!;
  const config = process.env.XDG_CONFIG_HOME!;
  expect(state).toBeTruthy();
  expect(config).toBeTruthy();
  const r = await run(["sh", "-c", SHOW]);
  expect(r.code).toBe(0);
  expect(r.out.split("|").slice(1)).toEqual([state, config]);
});
