import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// `--help` / `-h` / `--version` / `-v` ANYWHERE in argv print and exit 0 having run NOTHING.
//
// The bug this pins (known item 3, Phase E final harden loop): `dispatch` honoured `--help` only as
// argv[2], so `run --help` ran a full briefing, `init --help` rewrote the config, and
// `schedule install --help` would have installed the OS trigger. A reviewer's `run --help` stamped a
// real tick. Two layers, because they fail differently:
//   1. IN-PROCESS, every surface injected as a spy — the routing half. Covers the dangerous verbs
//      (`schedule install` reaches launchctl/systemctl), which must never be exercised for real.
//   2. THE REAL CLI in a child process, HOME / XDG_CONFIG_HOME / DAILY_BRIEFING_STATE_DIR all in temp
//      dirs and a shell-script "provider" that leaves a sentinel when invoked — the side-effect half.
//      On the pre-fix tree `run --help` here writes the tick, the lock and the dated briefing and
//      invokes the provider; `init --help` rewrites config.json.
import { test, expect, describe } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../src/main";
import { buildRepo } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import pkg from "../package.json";

/** Every injectable surface of `dispatch` as a counting spy. Nothing here can reach a provider, a
 *  probe, the network or the scheduler: a call is only counted. */
function spies() {
  const calls: string[] = [];
  const out: string[] = [], err: string[] = [];
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  const hit = (name: string) => () => { calls.push(name); };
  const deps = {
    run: (async () => { hit("run")(); return 0; }) as never,
    init: (async () => { hit("init")(); return 0; }) as never,
    status: (async () => { hit("status")(); return {} as never; }) as never,
    doctor: (async () => { hit("doctor")(); return {} as never; }) as never,
    configValidate: (() => { hit("configValidate")(); return {} as never; }) as never,
    updateCheck: (async () => { hit("updateCheck")(); return {} as never; }) as never,
    schedule: new Proxy({}, { get: (_t, p) => (..._a: unknown[]) => { calls.push(`schedule.${String(p)}`); return 0; } }) as never,
    scheduleStatus: new Proxy({}, { get: (_t, p) => (..._a: unknown[]) => { calls.push(`scheduleStatus.${String(p)}`); return {}; } }) as never,
  };
  return { calls, out, err, deps, restore: () => { console.log = oLog; console.error = oErr; } };
}

const HELP_SHAPES: string[][] = [
  ["run", "--help"],
  ["run", "-h"],
  ["run", "--force", "--help"],
  ["init", "--help"],
  ["init", "--provider", "anthropic-api", "--model", "m", "-h"],
  ["--json", "run", "--help"],          // would otherwise be the swallowed-command refusal (exit 2)
  ["--json", "--help"],
  ["--force", "-h"],
  ["run", "--json", "--json-out", "env.json", "--help"],
  ["status", "--json", "--help"],
  ["doctor", "--json", "-h"],
  ["config", "validate", "--json", "--stdin", "--help"],
  ["schedule", "install", "--help"],
  ["schedule", "install", "--invoker", "app", "--take-over", "-h"],
  ["schedule", "uninstall", "--help"],
  ["schedule", "verify", "--help"],
  ["schedule", "--help"],               // no verb: was exit 2 "a verb is required"
  ["update", "--check", "--help"],      // was exit 2 "unexpected argument(s)"
  ["run", "--help", "--version"],       // help wins over version
];

const VERSION_SHAPES: string[][] = [
  ["run", "--version"],
  ["run", "-v"],
  ["init", "--version"],
  ["schedule", "install", "--version"],
  ["--json", "run", "-v"],
  ["update", "--check", "-v"],
];

describe("help/version anywhere in argv run nothing", () => {
  for (const shape of HELP_SHAPES) {
    test(`\`${shape.join(" ")}\` prints usage, exits 0, calls no surface`, async () => {
      const s = spies();
      let code: number;
      try { code = await dispatch(["bun", "bin", ...shape], s.deps); } finally { s.restore(); }
      expect(s.calls).toEqual([]);
      expect(code!).toBe(0);
      expect(s.out.join("\n")).toContain("Usage:");
      expect(s.err).toEqual([]);
    });
  }
  for (const shape of VERSION_SHAPES) {
    test(`\`${shape.join(" ")}\` prints the version, exits 0, calls no surface`, async () => {
      const s = spies();
      let code: number;
      try { code = await dispatch(["bun", "bin", ...shape], s.deps); } finally { s.restore(); }
      expect(s.calls).toEqual([]);
      expect(code!).toBe(0);
      expect(s.out).toEqual([pkg.version]);
    });
  }

  test("CONTRAST: the same argv without the help flag DOES reach the surface (the spies can see a call)", async () => {
    // Without this, a spy wiring that could never record a call would pass every test above.
    for (const [shape, expected] of [
      [["run"], "run"],
      [["init"], "init"],
      [["--json", "--force"], "run"],
      [["schedule", "install"], "schedule.installSchedule"],
      [["schedule", "uninstall"], "schedule.uninstallSchedule"],
      [["update", "--check"], "updateCheck"],
      [["status", "--json"], "status"],
      [["doctor", "--json"], "doctor"],
    ] as const) {
      const s = spies();
      try { await dispatch(["bun", "bin", ...shape], s.deps); } finally { s.restore(); }
      expect(s.calls).toContain(expected);
    }
  });

  test("a token that merely CONTAINS help/version is not the flag (`--json-out` operand, `--model` value)", async () => {
    const s = spies();
    try {
      expect(await dispatch(["bun", "bin", "run", "--json-out", "help-me.json"], s.deps)).toBe(0);
      expect(await dispatch(["bun", "bin", "run", "--json-out", "--helpful"], s.deps)).toBe(2);   // still the missing-path refusal
    } finally { s.restore(); }
    expect(s.calls).toEqual(["run"]);
  });
});

// ── THE REAL CLI: nothing reaches the state dir, the config or the provider ────────────────────────
describe("the real CLI, sandboxed", () => {
  /** Every file under `dir`, relative, with its bytes — a snapshot two states can be compared by. */
  function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!existsSync(dir)) return out;
    for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const p = join(e.parentPath, e.name);
      out[p.slice(dir.length + 1)] = readFileSync(p, "latin1");
    }
    return out;
  }

  async function sandbox() {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date(Date.now() - 864e5).toISOString() }]);
    const home = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-help-home-")));
    const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-help-cfg-")));
    const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-help-state-")));
    mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
    const sentinel = join(home, "provider-was-invoked");
    // The "provider": a shell script that records being run — `--help` probe or generation alike.
    const cli = join(home, "fake-provider.sh");
    writeFileSync(cli, `#!/bin/sh\necho "$*" >> "${sentinel}"\ncat > /dev/null\nprintf '## RESUME\\n- [r] x\\n## RECAP\\n- [r] y | evidence: abc\\n## SUGGESTIONS\\n- z\\n'\n`, { mode: 0o755 });
    writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify({
      repos: [repo], excludeCommitPatterns: [], lookbackCapDays: 30,
      networkProbeHosts: [],                       // the explicit skip switch — no socket is opened
      provider: { cli, argv: [], promptVia: "stdin" },
    }));
    return { home, cfgHome, stateDir, sentinel };
  }

  for (const shape of [["run", "--help"], ["run", "--force", "-h"], ["init", "--help"], ["--json", "run", "--help"], ["run", "--force", "--version"]]) {
    test(`\`daily-briefing ${shape.join(" ")}\` writes no state, no config, and never spawns the provider`, async () => {
      const sb = await sandbox();
      const cfgBefore = snapshot(sb.cfgHome);
      const proc = Bun.spawn(["bun", "run", "src/main.ts", ...shape], {
        cwd: import.meta.dir.replace(/\/test$/, ""),
        env: { PATH: process.env.PATH ?? "", HOME: sb.home, XDG_CONFIG_HOME: sb.cfgHome, DAILY_BRIEFING_STATE_DIR: sb.stateDir },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;

      expect(stderr).toBe("");
      expect(code).toBe(0);
      if (shape.includes("--version")) expect(stdout.trim()).toBe(pkg.version);
      else expect(stdout).toContain("Usage:");
      expect(readdirSync(sb.stateDir)).toEqual([]);          // no tick, no run.lock, no last-run/last-skip, no briefing
      expect(snapshot(sb.cfgHome)).toEqual(cfgBefore);        // init did not rewrite the config
      expect(existsSync(sb.sentinel)).toBe(false);            // no provider spawn, not even the --help probe
    }, 30000);
  }

  test("CONTRAST: the same sandbox without --help DOES write state and spawn the provider", async () => {
    // Without this the assertions above could pass on a sandbox in which a real run writes nothing.
    const sb = await sandbox();
    const proc = Bun.spawn(["bun", "run", "src/main.ts", "run", "--force"], {
      cwd: import.meta.dir.replace(/\/test$/, ""),
      env: { PATH: process.env.PATH ?? "", HOME: sb.home, XDG_CONFIG_HOME: sb.cfgHome, DAILY_BRIEFING_STATE_DIR: sb.stateDir },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    expect(readdirSync(sb.stateDir).length).toBeGreaterThan(0);
    expect(existsSync(sb.sentinel)).toBe(true);
  }, 30000);
});
