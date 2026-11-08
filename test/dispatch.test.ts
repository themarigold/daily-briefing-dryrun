import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
import { test, expect } from "bun:test";
import { dispatch } from "../src/main";

test("dispatch: unknown subcommand → exit 2, prints usage, and does NOT invoke run()", async () => {
  const oErr = console.error, oLog = console.log; const lines: string[] = [];
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    let ran = false;
    const code = await dispatch(["bun", "bin", "schedul-wake"], { run: (async () => { ran = true; return 0; }) as any });
    expect(code).toBe(2);
    expect(ran).toBe(false);
    expect(lines.join("\n")).toContain("Usage"); // the default: branch now prints usage (would fail if printUsage() were dropped)
  } finally { console.error = oErr; console.log = oLog; }
});
test("dispatch: 'run' routes to run() and returns its code", async () => {
  let ran = false;
  const code = await dispatch(["bun", "bin", "run"], { run: (async () => { ran = true; return 7; }) as any });
  expect(ran).toBe(true);
  expect(code).toBe(7);
});
test("dispatch: 'init' routes to init() and PROPAGATES its exit code, without invoking run()", async () => {
  // init used to always yield 0; it now returns 2 when C1/B7 refuses a provider.argv that defeats
  // hardening, so dispatch must pass the code through rather than hard-coding success.
  let inited = false, ran = false;
  const code = await dispatch(["bun", "bin", "init"], {
    init: (async () => { inited = true; return 0; }) as any,
    run: (async () => { ran = true; return 9; }) as any,
  });
  expect(inited).toBe(true);
  expect(ran).toBe(false);
  expect(code).toBe(0);
});
test("dispatch: a non-zero init code reaches the caller", async () => {
  const code = await dispatch(["bun", "bin", "init"], { init: (async () => 2) as any, run: (async () => 9) as any });
  expect(code).toBe(2);
});
test("dispatch: bare invocation (no subcommand — argv[2] undefined) routes to run()", async () => {
  let ran = false;
  const code = await dispatch(["bun", "bin"], { run: (async () => { ran = true; return 0; }) as any });
  expect(ran).toBe(true);       // `first` undefined → the ternary's else → "run"
  expect(code).toBe(0);
});
test("dispatch: a leading flag (bare --force) routes to run(), not exit-2", async () => {
  let forced: boolean | undefined;
  const code = await dispatch(["bun", "bin", "--force"], { run: (async (f: boolean) => { forced = f; return 0; }) as any });
  expect(code).toBe(0);
  expect(forced).toBe(true);
});
test("dispatch: the '-f' force alias routes to run() with force=true (non-vacuous against dropping `|| argv.includes(\"-f\")`)", async () => {
  let seen: boolean | undefined;
  const code = await dispatch(["bun", "bin", "-f"], { run: (async (f: boolean) => { seen = f; return 0; }) as any });
  expect(code).toBe(0);
  expect(seen).toBe(true);
  let seenPlain: boolean | undefined;
  await dispatch(["bun", "bin", "run"], { run: (async (f: boolean) => { seenPlain = f; return 0; }) as any });
  expect(seenPlain).toBe(false); // plain `run` (no flag) is NOT force — contrast case
});

test("dispatch: --now (the app's Run now) routes to run() with runNow=true and force=false, never interactive-by-flag", async () => {
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  try {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    const seen: { force: boolean; runNow: unknown }[] = [];
    const interactive: (boolean | undefined)[] = [];
    const runStub = (async (f: boolean, d: { runNow?: boolean; interactive?: boolean }) => { seen.push({ force: f, runNow: d.runNow }); interactive.push(d.interactive); return 0; }) as any;
    expect(await dispatch(["bun", "bin", "--now"], { run: runStub })).toBe(0);          // a LEADING run-flag
    expect(await dispatch(["bun", "bin", "run", "--json", "--now"], { run: runStub })).toBe(0);
    expect(await dispatch(["bun", "bin", "run", "--json"], { run: runStub })).toBe(0);  // contrast: no flag, no runNow
    expect(seen).toEqual([{ force: false, runNow: true }, { force: false, runNow: true }, { force: false, runNow: false }]);
    expect(interactive[0]).toBe(false);
    expect(interactive[1]).toBe(false);
    expect(interactive[2]).toBe(false);
    expect(interactive[0]).toBe(interactive[2]); // compare with no flag: the TTY decides, not --now
    expect(interactive[1]).toBe(interactive[2]);
  } finally {
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY); else Reflect.deleteProperty(process.stdin, "isTTY");
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY); else Reflect.deleteProperty(process.stdout, "isTTY");
  }
});

test("dispatch: --help / -h / help print usage and NEVER invoke run() (the old catch-all ran a full briefing)", async () => {
  const oLog = console.log; const lines: string[] = []; console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    let ran = false;
    const code = await dispatch(["bun", "bin", "--help"], { run: (async () => { ran = true; return 0; }) as any });
    expect(code).toBe(0);
    expect(ran).toBe(false);
    expect(lines.join("\n")).toContain("Usage");
    for (const arg of ["-h", "help"]) {
      const c = await dispatch(["bun", "bin", arg], { run: (async () => { ran = true; return 0; }) as any });
      expect(c).toBe(0);
    }
    expect(ran).toBe(false);
  } finally { console.log = oLog; }
});

test("dispatch: --version / -v print a version and do NOT invoke run()", async () => {
  const oLog = console.log; const lines: string[] = []; console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    let ran = false;
    const code = await dispatch(["bun", "bin", "--version"], { run: (async () => { ran = true; return 0; }) as any });
    expect(code).toBe(0);
    expect(ran).toBe(false);
    expect(lines.join("\n")).toMatch(/\d+\.\d+\.\d+/);
    await dispatch(["bun", "bin", "-v"], { run: (async () => { ran = true; return 0; }) as any });
    expect(ran).toBe(false);
  } finally { console.log = oLog; }
});

test("dispatch: an unknown leading flag → exit 2, prints usage, and does NOT invoke run() (a typo can't trigger a briefing)", async () => {
  const oErr = console.error, oLog = console.log; const lines: string[] = [];
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    let ran = false;
    const code = await dispatch(["bun", "bin", "--frce"], { run: (async () => { ran = true; return 0; }) as any });
    expect(code).toBe(2);
    expect(ran).toBe(false);
    expect(lines.join("\n")).toContain("unknown flag: --frce");
    expect(lines.join("\n")).toContain("Usage");
  } finally { console.error = oErr; console.log = oLog; }
});

// ── provider fallback P2-M1-T1: `provider …` (spec r9 §6) ─────────────────────────────────────────────────────────
test("dispatch: 'provider' routes everything after the command to the provider CLI, touching no state", async () => {
  const { readdirSync } = await import("node:fs");
  const { supportDir } = await import("../src/marker");
  const before = (() => { try { return readdirSync(supportDir()).sort(); } catch { return []; } })();
  const seen: string[][] = [];
  let ran = false;
  const code = await dispatch(["bun", "bin", "provider", "reset", "--index", "0", "--json"], {
    providerCli: async (args: string[]) => { seen.push(args); return 5; },
    run: (async () => { ran = true; return 0; }) as any,
  });
  expect(code).toBe(5);
  expect(ran).toBe(false);
  expect(seen).toEqual([["reset", "--index", "0", "--json"]]);
  expect((() => { try { return readdirSync(supportDir()).sort(); } catch { return []; } })()).toEqual(before);
});
test("dispatch: 'provider' is a KNOWN command — after a leading run-flag it is refused, never a briefing run", async () => {
  const oErr = console.error, oLog = console.log; const lines: string[] = [];
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    let ran = false, routed = false;
    for (const argv of [["--json", "provider", "reset"], ["run", "provider"], ["--force", "provider", "test"]]) {
      const code = await dispatch(["bun", "bin", ...argv], { run: (async () => { ran = true; return 0; }) as any, providerCli: async () => { routed = true; return 0; } });
      expect(`${argv.join(" ")} → ${code}`).toBe(`${argv.join(" ")} → 2`);
    }
    expect([ran, routed]).toEqual([false, false]);
    expect(lines.join("\n")).toContain("must come FIRST");
  } finally { console.error = oErr; console.log = oLog; }
});
// ── B1-M3-T9 (wave 2): `repos status --json`, the desktop app's live git check ─────────────────────────────────────
test("dispatch: 'repos' routes everything after the command to the repos CLI, touching no state", async () => {
  const { readdirSync } = await import("node:fs");
  const { supportDir } = await import("../src/marker");
  const before = (() => { try { return readdirSync(supportDir()).sort(); } catch { return []; } })();
  const seen: string[][] = [];
  let ran = false;
  const code = await dispatch(["bun", "bin", "repos", "status", "--json"], {
    reposCli: async (args: string[]) => { seen.push(args); return 6; },
    run: (async () => { ran = true; return 0; }) as any,
  });
  expect([code, ran, seen]).toEqual([6, false, [["status", "--json"]]]);
  expect((() => { try { return readdirSync(supportDir()).sort(); } catch { return []; } })()).toEqual(before);
});
test("dispatch: 'repos' is a KNOWN command — after a leading run-flag it is refused, never a briefing run", async () => {
  const oErr = console.error, oLog = console.log; const lines: string[] = [];
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    let ran = false, routed = false;
    for (const argv of [["--json", "repos", "status"], ["run", "repos"], ["--force", "repos", "status", "--json"]]) {
      const code = await dispatch(["bun", "bin", ...argv], { run: (async () => { ran = true; return 0; }) as any, reposCli: async () => { routed = true; return 0; } });
      expect(`${argv.join(" ")} → ${code}`).toBe(`${argv.join(" ")} → 2`);
    }
    expect([ran, routed]).toEqual([false, false]);
    expect(lines.join("\n")).toContain("must come FIRST");
  } finally { console.error = oErr; console.log = oLog; }
});
test("dispatch: --help documents the repos command, its request on STDIN, and that push state is as of the last fetch or push", async () => {
  const oLog = console.log; const lines: string[] = []; console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    expect(await dispatch(["bun", "bin", "--help"], {})).toBe(0);
    const help = lines.join("\n");
    for (const needle of [
      "daily-briefing repos status --json",
      "The desktop app's live git check (the request on STDIN).",
      "Push state is as of your last fetch or push; nothing is fetched.",
    ]) expect(`help mentions ${needle}: ${help.includes(needle)}`).toBe(`help mentions ${needle}: true`);
  } finally { console.log = oLog; }
});
test("dispatch: --help documents the provider command and the label-on-stdin form", async () => {
  const oLog = console.log; const lines: string[] = []; console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    expect(await dispatch(["bun", "bin", "--help"], {})).toBe(0);
    const help = lines.join("\n");
    for (const needle of ["provider reset", "--label-stdin", "provider test", "provider key"]) {
      expect(`help mentions ${needle}: ${help.includes(needle)}`).toBe(`help mentions ${needle}: true`);
    }
  } finally { console.log = oLog; }
});
