// The isolation tripwire (test/fixtures/isolate-state.ts, armed from test/preload.ts), proven end to end in
// a child `bun test` process, because what it guards is process-wide: the child runs
// test/fixtures/state-tripwire.probe.ts with HOME pointed into a registered sandbox, so the locations a
// fallback would write are observable and are never the developer's real state dir or config.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stateDirFor } from "../src/marker";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const ROOT = resolve(import.meta.dir, "..");
const PROBE = join(import.meta.dir, "fixtures", "state-tripwire.probe.ts");

/** Run the probe with test/preload.ts (cwd = the package root, where bunfig.toml lives) or bare (cwd = the
 *  sandbox, which has none). Returns the child's output and where each fallback would resolve. */
async function runProbe(preload: boolean): Promise<{ output: string; state: string; config: string }> {
  const sandbox = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tripwire-")));
  const home = join(sandbox, "home");
  const tmp = join(sandbox, "tmp");
  for (const d of [home, tmp]) mkdirSync(d);
  // Drop both overrides and every variable the two resolvers consult besides HOME, so each fallback
  // resolves under the sandbox's HOME on every platform. GITHUB_ACTIONS goes too: with it set, bun on Linux
  // adds a `::error … title=<message>` annotation per failure, which doubles every message this test counts
  // (reproduced in oven/bun:1.3.14 — the CI job's image family — by a cold verifier).
  const { DAILY_BRIEFING_STATE_DIR: _s, XDG_CONFIG_HOME: _c, XDG_STATE_HOME: _x, LOCALAPPDATA: _l, GITHUB_ACTIONS: _gha, ...inherited } = process.env;
  const env = { ...inherited, HOME: home, TMPDIR: tmp, DBA_TRIPWIRE_SANDBOX: sandbox };
  const p = Bun.spawn(["bun", "test", PROBE], { cwd: preload ? ROOT : sandbox, env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return { output: out + err, state: stateDirFor(process.platform, env, home), config: join(home, ".config") };
}

test("control: WITHOUT the preload, every one of the probe's writes reaches HOME", async () => {
  // If this stops holding, the probe no longer reproduces the leaks and the armed test below proves nothing.
  const { output, state, config } = await runProbe(false);
  expect(output).toMatch(/\(fail\) incident A: .*\n.*timed out after 50ms/);
  expect(output).toMatch(/^\s*4 pass$/m);                                     // B and the three direct scenarios ran through
  expect(existsSync(join(state, "briefings"))).toBe(true);                     // incident: the 2026-09-15 shape
  expect(existsSync(join(state, "last-run"))).toBe(true);                      // clear
  expect(existsSync(join(state, "briefing-latest.md"))).toBe(true);            // delete
  expect(existsSync(join(config, "daily-briefing", "config.json"))).toBe(true); // config delete
});

test("armed: nothing reaches HOME, and each direct clear or delete fails the test that made it", async () => {
  const { output, state, config } = await runProbe(true);
  expect(existsSync(state)).toBe(false);
  expect(existsSync(config)).toBe(false);
  expect(output).toMatch(/\(fail\) incident A: .*\n.*timed out after 50ms/);
  expect(output).toMatch(/^\s*1 pass$/m);                                     // B: A restored a real value
  expect(output).not.toContain("(fail) incident B");
  expect(output).toMatch(/\(fail\) clear: /);
  // 2, not 3: the clear, then the FIRST read (stateDirFor reads the variable twice) — which re-arms it, so
  // the second read is clean and one clear cannot go on failing every later test.
  expect(output).toContain("an isolation variable was cleared during this test (2 record(s))");
  expect(output).toContain('DAILY_BRIEFING_STATE_DIR cleared (assigned "")');
  expect(output).toContain("DAILY_BRIEFING_STATE_DIR read while cleared");
  expect(output).toMatch(/\(fail\) delete: /);
  expect(output).toMatch(/\(fail\) config: /);
  expect(output.match(/TypeError: Unable to delete property/g)?.length).toBe(2); // delete + config
  expect(output).toMatch(/^\s*4 fail$/m);                                     // A, clear, delete, config — nothing else
});
