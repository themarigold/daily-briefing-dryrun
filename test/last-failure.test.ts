// test/last-failure.test.ts — `<state>/last-failure.json` (provider-fallback plan P1-M9-T1; spec r9 §5 Reporting
// "Unresolved failure"): written on every failure-class skip, `crashed` included, redacted at the file; it survives
// later quiet skips and is cleared only on delivery; a lost lock writes none.
//
// Through `run()`: a real config (XDG_CONFIG_HOME), fake CLIs or an injected provider, and the files the shell writes.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/main";
import { accountStatePath } from "../src/account";
import { lastFailurePath, latestBriefingPath, markerPath, readLastFailure, readLastSkip, supportDir } from "../src/marker";
import { ProviderError } from "../src/types";
import { buildRepo } from "./fixtures/build-repo";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { fakeCli, freshStateDir, tempDir, walkDeps } from "./helpers/walk";

guardNetworkForThisFile();

let repo = "";
const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
const prevCfg = process.env.XDG_CONFIG_HOME;
beforeAll(async () => {
  repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
});
afterAll(() => {
  process.env.DAILY_BRIEFING_STATE_DIR = prevState;
  if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevCfg;
});

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const e = console.error, l = console.log;
  console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.error = e; console.log = l; }
}
function config(cfg: Record<string, unknown>): void {
  const home = tempDir("dba-lf-cfg-");
  mkdirSync(join(home, "daily-briefing"), { recursive: true });
  writeFileSync(join(home, "daily-briefing", "config.json"), JSON.stringify({ repos: [repo], ...cfg }));
  process.env.XDG_CONFIG_HOME = home;
}
const failingCli = (dir: string, stderr = "down") => ({ provider: { cli: fakeCli(dir, "fail-cli", `echo "${stderr}" 1>&2; exit 1`), argv: [], promptVia: "stdin", harden: false } });
const okCli = (dir: string) => ({ provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" } });

describe("written on every failure-class skip", () => {
  test("provider-fail", async () => {
    freshStateDir();
    config(failingCli(tempDir("dba-lf-")));
    expect(await quiet(() => run(true, walkDeps()))).toBe(1);
    const f = await readLastFailure();
    expect([f?.reason, f?.detail.startsWith("nonzero-exit: ")]).toEqual(["provider-fail", true]);
  });

  test("parse-empty", async () => {
    freshStateDir();
    config({ provider: { cli: fakeCli(tempDir("dba-lf-"), "prose-cli", "echo 'No briefing today.'"), argv: [], promptVia: "stdin" } });
    expect(await quiet(() => run(true, walkDeps()))).toBe(1);
    expect((await readLastFailure())?.reason).toBe("parse-empty");
  });

  test("write-fail and marker-fail", async () => {
    for (const [reason, block] of [["write-fail", latestBriefingPath], ["marker-fail", markerPath]] as const) {
      freshStateDir();
      config(okCli(tempDir("dba-lf-")));
      mkdirSync(block(), { recursive: true });                    // a directory where the file goes
      expect(await quiet(() => run(true, walkDeps()))).toBe(1);
      expect(`${reason}: ${(await readLastFailure())?.reason}`).toBe(`${reason}: ${reason}`);
    }
  });

  test("crashed — written before the rethrow", async () => {
    freshStateDir();
    config(okCli(tempDir("dba-lf-")));
    const provider = { generate: async () => { throw new TypeError("a bug in the pipeline"); } };
    await expect(quiet(() => run(true, walkDeps({ provider })))).rejects.toBeInstanceOf(TypeError);
    const f = await readLastFailure();
    expect([f?.reason, f?.detail]).toEqual(["crashed", "TypeError: a bug in the pipeline"]);
  });

  test("a paused result (P1-M7-T3)", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-lf-");
    mkdirSync(d, { recursive: true });
    writeFileSync(accountStatePath(d), JSON.stringify({ accounts: {
      A: { limitedUntil: new Date(Date.now() + 5 * 3600e3).toISOString(), isProbe: false, reason: "usage" },
      B: { limitedUntil: new Date(Date.now() + 1800e3).toISOString(), isProbe: true, reason: "auth" },
    } }));
    config({ provider: { cli: fakeCli(dir, "claude"), argv: [], promptVia: "stdin", accounts: [{ label: "A", configDir: `${dir}/a` }, { label: "B", configDir: `${dir}/b` }] } });
    expect(await quiet(() => run(true, walkDeps()))).toBe(1);
    const f = await readLastFailure();
    expect(f?.reason).toBe("provider-fail");
    expect(f?.detail).toStartWith("paused after failures until ");
  });

  test("a detail holding a key-shaped string is stored redacted", async () => {
    freshStateDir();
    const KEY = "sk-ant-api03-Zq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-AbCdEfGhAA";
    config(okCli(tempDir("dba-lf-")));
    const provider = { generate: async () => { throw new ProviderError("nonzero-exit", `rejected ${KEY}`); } };
    expect(await quiet(() => run(true, walkDeps({ provider })))).toBe(1);
    const raw = await Bun.file(lastFailurePath()).text();
    expect(raw).not.toContain(KEY);
    expect((await readLastFailure())?.reason).toBe("provider-fail");
  });
});

describe("its lifetime", () => {
  test("survives later offline, concurrent and limited skips; cleared on delivery", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-lf-");
    config(failingCli(dir));
    expect(await quiet(() => run(true, walkDeps()))).toBe(1);
    const failed = await readLastFailure();
    expect(failed?.reason).toBe("provider-fail");
    // offline (a scheduled tick), concurrent (a live holder), limited (a usage wall) — none clears it
    config(okCli(dir));
    expect(await quiet(() => run(false, walkDeps({ interactive: true, netProbe: async () => false, netGraceMs: 20, netPollMs: 5 })))).toBe(0);
    expect((await readLastSkip())?.reason).toBe("offline");
    writeFileSync(join(supportDir(), "run.lock"), JSON.stringify({ pid: process.pid, startedIso: new Date().toISOString(), invoker: "cli", nonce: "x" }));
    expect(await quiet(() => run(true, walkDeps()))).toBe(0);
    expect((await readLastSkip())?.reason).toBe("concurrent");
    await Bun.file(join(supportDir(), "run.lock")).delete();
    writeFileSync(accountStatePath(d), JSON.stringify({ accounts: { default: { limitedUntil: new Date(Date.now() + 3600e3).toISOString(), isProbe: false, reason: "usage" } } }));
    expect(await quiet(() => run(true, walkDeps()))).toBe(0);
    expect((await readLastSkip())?.reason).toBe("limited");
    expect(await readLastFailure()).toEqual(failed);
    // a delivery clears it
    writeFileSync(accountStatePath(d), JSON.stringify({ accounts: {} }));
    expect(await quiet(() => run(true, walkDeps()))).toBe(0);
    expect(existsSync(latestBriefingPath())).toBe(true);
    expect(existsSync(lastFailurePath())).toBe(false);
  });

  test("a TypeError after a takeover: exit 0, no last-failure.json, never crashed (Opus LOW 8)", async () => {
    freshStateDir();
    const SUCCESSOR = JSON.stringify({ pid: process.pid, startedIso: new Date().toISOString(), invoker: "cli", nonce: "the-successor" });
    config(okCli(tempDir("dba-lf-")));
    const provider = { generate: async () => { writeFileSync(join(supportDir(), "run.lock"), SUCCESSOR); throw new TypeError("a bug, after the takeover"); } };
    expect(await quiet(() => run(true, walkDeps({ provider })))).toBe(0);
    expect(existsSync(lastFailurePath())).toBe(false);
    expect((await readLastSkip())).toBeUndefined();
  });

  test("a lost lock at the re-check points writes NO last-failure.json", async () => {
    freshStateDir();
    const SUCCESSOR = JSON.stringify({ pid: process.pid, startedIso: new Date().toISOString(), invoker: "cli", nonce: "the-successor" });
    config(okCli(tempDir("dba-lf-")));
    // The provider fails after the takeover: the catch-path re-check stops before skip("provider-fail").
    const provider = { generate: async () => { writeFileSync(join(supportDir(), "run.lock"), SUCCESSOR); throw new ProviderError("nonzero-exit", "x"); } };
    expect(await quiet(() => run(true, walkDeps({ provider })))).toBe(0);
    expect(existsSync(lastFailurePath())).toBe(false);
  });
});

// PR 1 final review round 3 L14: the engine's FAILED class and the desktop app's FAILED notification arms are one list.
// Read as TEXT (this file imports no Rust), in the style of the uninstall parity pins: the app's `skip_notify_class`
// arms that answer `Some(NotifyClass::Failed)`, mapped to the engine's spelling through the app's own `from_str` table.
test("round 3 L14: FAILURE_SKIP_REASONS is exactly the reasons the app notifies as FAILED", async () => {
  const { FAILURE_SKIP_REASONS } = await import("../src/marker");
  const { readFileSync } = await import("node:fs");
  const root = join(import.meta.dir, "..", "gui", "src-tauri", "src");
  const notifications = readFileSync(join(root, "notifications.rs"), "utf8").replace(/\/\/[^\n]*/g, "");
  const fn = notifications.slice(notifications.indexOf("pub fn skip_notify_class"));
  expect(fn.length).toBeGreaterThan(0);
  const failedArm = /match reason \{\s*([^{}]*?)=>\s*Some\(NotifyClass::Failed\)/.exec(fn)?.[1];
  expect(failedArm).toBeDefined();
  const variants = [...failedArm!.matchAll(/SkipReason::(\w+)/g)].map((m) => m[1]!);
  expect(variants.length).toBe(failedArm!.split("SkipReason::").length - 1);          // every arm read
  const schedule = readFileSync(join(root, "schedule_state.rs"), "utf8");
  const spelling = new Map([...schedule.matchAll(/"([a-z-]+)" => SkipReason::(\w+),/g)].map((m) => [m[2]!, m[1]!]));
  const appFailed = variants.map((v) => spelling.get(v) ?? `<unmapped ${v}>`).sort();
  expect(appFailed).toEqual([...FAILURE_SKIP_REASONS].sort());
});
