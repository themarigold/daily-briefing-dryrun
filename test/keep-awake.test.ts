import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// The scheduled run's idle-sleep guard: dispatch's gate (darwin + DAILY_BRIEFING_KEEP_AWAKE=1, `run` only)
// and startKeepAwake's own argv and fallbacks. ⚠ NO TEST HERE STARTS A REAL caffeinate: every dispatch call
// injects `keepAwake`, the default-path tests replace `Bun.spawn` with a spy that never spawns, and
// startKeepAwake's tests inject `spawn`/`exists`.
import { test, expect, describe, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { dispatch } from "../src/main";
import { startKeepAwake, CAFFEINATE } from "../src/keep-awake";
import { KEEP_AWAKE_ENV } from "../src/schedule/units";

const VAR = KEEP_AWAKE_ENV.name;

/** Runs `fn` with the variable set (or not) and console.error captured; always leaves the variable unset. */
async function withVar<T>(set: boolean, fn: (errs: string[]) => Promise<T>): Promise<T> {
  const oErr = console.error; const errs: string[] = [];
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  if (set) process.env[VAR] = KEEP_AWAKE_ENV.value; else delete process.env[VAR];
  try { return await fn(errs); } finally { console.error = oErr; delete process.env[VAR]; }
}

/** A recording run() and keepAwake(), sharing one event log so ORDER is observable. */
function fakes(code = 0) {
  const events: string[] = [];
  const pids: number[] = [];
  let varAtRun: string | undefined = "never ran";
  return {
    events, pids, varAtRun: () => varAtRun,
    deps: {
      run: (async () => { events.push("run"); varAtRun = process.env[VAR]; return code; }) as any,
      keepAwake: (pid: number) => { events.push("keepAwake"); pids.push(pid); },
    },
  };
}

describe("dispatch run: the keep-awake gate", () => {
  test("darwin + the variable: keepAwake is called ONCE with process.pid, BEFORE run(), and run's code is returned", async () => {
    await withVar(true, async () => {
      const f = fakes(7);
      expect(await dispatch(["bun", "bin", "run"], { ...f.deps, platform: "darwin" })).toBe(7);
      expect(f.events).toEqual(["keepAwake", "run"]);
      expect(f.pids).toEqual([process.pid]);
    });
  });

  test("the variable is GONE from process.env when run() is called — children must not inherit it", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      await withVar(true, async () => {
        const f = fakes();
        await dispatch(["bun", "bin", "run"], { ...f.deps, platform });
        expect({ platform, varAtRun: f.varAtRun() }).toEqual({ platform, varAtRun: undefined });
      });
    }
  });

  test("not called without the variable, or with any value other than exactly \"1\"", async () => {
    await withVar(false, async () => {
      const f = fakes();
      await dispatch(["bun", "bin", "run"], { ...f.deps, platform: "darwin" });
      expect(f.events).toEqual(["run"]);
    });
    for (const v of ["0", "true", "", " 1"]) {
      await withVar(false, async () => {
        process.env[VAR] = v;
        const f = fakes();
        await dispatch(["bun", "bin", "run"], { ...f.deps, platform: "darwin" });
        expect({ v, events: f.events }).toEqual({ v, events: ["run"] });
      });
    }
  });

  test("not called on linux or win32, even with the variable set", async () => {
    for (const platform of ["linux", "win32"] as const) {
      await withVar(true, async () => {
        const f = fakes();
        await dispatch(["bun", "bin", "run"], { ...f.deps, platform });
        expect({ platform, events: f.events }).toEqual({ platform, events: ["run"] });
      });
    }
  });

  test("not called for status, init, help, or an unknown command — only `run` holds the machine awake", async () => {
    await withVar(true, async () => {
      const oLog = console.log; console.log = () => {};
      try {
        const f = fakes();
        const deps = { ...f.deps, platform: "darwin" as const, status: (async () => ({})) as any, init: (async () => 0) as any };
        expect(await dispatch(["bun", "bin", "status", "--json"], deps)).toBe(0);
        expect(await dispatch(["bun", "bin", "init"], deps)).toBe(0);
        expect(await dispatch(["bun", "bin", "help"], deps)).toBe(0);
        expect(await dispatch(["bun", "bin", "no-such-command"], deps)).toBe(2);
        expect(f.events).toEqual([]);
      } finally { console.log = oLog; }
    });
  });

  test("not called when the --json-out shape guard exits 2 before run()", async () => {
    await withVar(true, async () => {
      const f = fakes();
      expect(await dispatch(["bun", "bin", "run", "--json-out", "../../etc/x"], { ...f.deps, platform: "darwin" })).toBe(2);
      expect(f.events).toEqual([]);
    });
  });

  test("a THROWING keepAwake is one warning line and the run still happens, with its exit code", async () => {
    await withVar(true, async (errs) => {
      const f = fakes(3);
      const code = await dispatch(["bun", "bin", "run"], {
        ...f.deps, platform: "darwin", keepAwake: () => { throw new Error("boom"); },
      });
      expect(code).toBe(3);
      expect(f.events).toEqual(["run"]);
      expect(errs.length).toBe(1);
      expect(errs[0]).toContain("keep-awake failed (boom)");
    });
  });

  test("the DEFAULT keepAwake (nothing injected) does nothing when the variable is absent", async () => {
    // Bun.spawn is replaced, so even a broken gate could not start a real caffeinate — it would throw here
    // and be counted instead. The positive control below proves this spy sees the default path at all.
    const spy = spyOn(Bun, "spawn").mockImplementation((() => { throw new Error("spawn reached"); }) as any);
    try {
      await withVar(false, async (errs) => {
        let ran = false;
        const code = await dispatch(["bun", "bin", "run"], { run: (async () => { ran = true; return 0; }) as any, platform: "darwin" });
        expect(code).toBe(0);
        expect(ran).toBe(true);
        expect(spy).not.toHaveBeenCalled();
        expect(errs).toEqual([]);
      });
    } finally { spy.mockRestore(); }
  });

  // Non-vacuity for the test above: with the variable set, the same default path DOES reach Bun.spawn with
  // caffeinate's argv. Only where the binary exists — startKeepAwake checks for it before spawning.
  test.if(existsSync(CAFFEINATE))("positive control: with the variable, the default path reaches the (spied) Bun.spawn", async () => {
    let unrefs = 0;
    const spy = spyOn(Bun, "spawn").mockImplementation((() => ({ unref: () => { unrefs++; } })) as any);
    try {
      await withVar(true, async () => {
        await dispatch(["bun", "bin", "run"], { run: (async () => 0) as any, platform: "darwin" });
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toEqual([CAFFEINATE, "-i", "-w", String(process.pid)]);
      expect(unrefs).toBe(1);
    } finally { spy.mockRestore(); }
  });
});

describe("startKeepAwake", () => {
  test("spawns EXACTLY /usr/bin/caffeinate -i -w <pid> and unrefs it, with no warning", () => {
    const argvs: string[][] = []; let unrefs = 0; const warns: string[] = [];
    startKeepAwake(4242, {
      exists: (p) => p === "/usr/bin/caffeinate",
      spawn: (argv) => { argvs.push(argv); return { unref: () => { unrefs++; } }; },
      warn: (l) => warns.push(l),
    });
    expect(argvs).toEqual([["/usr/bin/caffeinate", "-i", "-w", "4242"]]);
    expect(unrefs).toBe(1);
    expect(warns).toEqual([]);
  });

  test("a missing binary is one warning and no spawn", () => {
    let spawned = 0; const warns: string[] = [];
    startKeepAwake(1, { exists: () => false, spawn: () => { spawned++; return { unref() {} }; }, warn: (l) => warns.push(l) });
    expect(spawned).toBe(0);
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("/usr/bin/caffeinate is missing");
  });

  test("a spawn that throws is one warning, never a throw", () => {
    const warns: string[] = [];
    expect(() => startKeepAwake(1, {
      exists: () => true, spawn: () => { throw new Error("EACCES"); }, warn: (l) => warns.push(l),
    })).not.toThrow();
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("could not start /usr/bin/caffeinate (EACCES)");
  });
});
