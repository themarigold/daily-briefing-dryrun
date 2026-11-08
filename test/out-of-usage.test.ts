// test/out-of-usage.test.ts — the out-of-usage `last-skip.json` record (provider-fallback plan P1-M9-T2; spec r9 §5
// Reporting "Out-of-usage notification"): a step-7 row-1 skip writes `limited` plus `allOutOfUsage: true`, its detail's
// first line is the notification body (a time only for a parsed reset), the second line is `limitedSkipMessage` —
// which stays the only `briefing.log` line — and `status --json`'s `lastSkip` carries the flag.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, limitedSkipMessage } from "../src/main";
import { accountStatePath } from "../src/account";
import { outOfUsageLine } from "../src/failover";
import { readLastSkip } from "../src/marker";
import { statusReport } from "../src/json";
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

const NOW = new Date(2026, 9, 16, 8, 0);                     // Fri 16 Oct 2026, local
async function runCapturing(cfg: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<{ code: number; err: string[] }> {
  const home = tempDir("dba-oou-cfg-");
  mkdirSync(join(home, "daily-briefing"), { recursive: true });
  writeFileSync(join(home, "daily-briefing", "config.json"), JSON.stringify({ repos: [repo], ...cfg }));
  process.env.XDG_CONFIG_HOME = home;
  const err: string[] = [];
  const e = console.error, l = console.log;
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  try { return { code: await run(true, walkDeps({ now: () => NOW, ...extra })), err }; } finally { console.error = e; console.log = l; }
}
const usageMark = (until: Date, isProbe: boolean) => ({ limitedUntil: until.toISOString(), isProbe, reason: "usage" });

describe("the out-of-usage line (pure)", () => {
  test("names the earliest reset only when it was parsed; today as HH:MM, a later day as Ddd HH:MM", () => {
    const base = { label: "x", exhausted: true as const, allOutOfUsage: true as const };
    expect(outOfUsageLine({ ...base, until: new Date(2026, 9, 16, 9, 0).toISOString(), isProbe: false }, NOW))
      .toBe("No briefing yet today — every provider is out of usage until 09:00. It will arrive once one resets, if your Mac is awake.");
    expect(outOfUsageLine({ ...base, until: new Date(2026, 9, 20, 9, 0).toISOString(), isProbe: false }, NOW))
      .toBe("No briefing yet today — every provider is out of usage until Tue 09:00. It will arrive once one resets, if your Mac is awake.");
    for (const l of [{ ...base, until: new Date(2026, 9, 16, 9, 0).toISOString(), isProbe: true }, { ...base, until: "", isProbe: false }]) {
      expect(outOfUsageLine(l, NOW)).toBe("No briefing yet today — every provider is out of usage. It will arrive once one resets, if your Mac is awake.");
    }
  });
});

describe("through run()", () => {
  test("a row-1 skip writes limited + allOutOfUsage; line 1 the body, line 2 limitedSkipMessage; briefing.log gets only line 2", async () => {
    const d = freshStateDir();
    mkdirSync(d, { recursive: true });
    const reset = new Date(2026, 9, 16, 9, 30);
    writeFileSync(accountStatePath(d), JSON.stringify({ accounts: { default: usageMark(reset, false) } }));
    const { code, err } = await runCapturing({ provider: { cli: fakeCli(tempDir("dba-oou-")), argv: [], promptVia: "stdin" } });
    expect(code).toBe(0);
    const skip = await readLastSkip();
    expect([skip?.reason, skip?.allOutOfUsage]).toEqual(["limited", true]);
    const lines = skip!.detail!.split("\n");
    expect(lines[0]).toBe("No briefing yet today — every provider is out of usage until 09:30. It will arrive once one resets, if your Mac is awake.");
    const second = limitedSkipMessage({ label: "default", until: reset.toISOString(), isProbe: false, exhausted: true, allOutOfUsage: true });
    expect(lines.slice(1)).toEqual([second]);
    expect(err).toContain(second);
    expect(err.some((l) => l.includes("No briefing yet today"))).toBe(false);
    // status --json carries the flag through readLastSkip's allow-list
    expect((await statusReport()).lastSkip?.allOutOfUsage).toBe(true);
  });

  test("an unparsed wall: no time in line 1", async () => {
    const d = freshStateDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(accountStatePath(d), JSON.stringify({ accounts: { default: usageMark(new Date(NOW.getTime() + 3600e3), true) } }));
    await runCapturing({ provider: { cli: fakeCli(tempDir("dba-oou-")), argv: [], promptVia: "stdin" } });
    expect((await readLastSkip())?.detail?.split("\n")[0]).toBe("No briefing yet today — every provider is out of usage. It will arrive once one resets, if your Mac is awake.");
  });

  test("an offline skip has no allOutOfUsage", async () => {
    // A forced run proceeds offline, so the skip needs an unforced (interactive, floor-exempt) run.
    freshStateDir();
    const home = tempDir("dba-oou-cfg-");
    mkdirSync(join(home, "daily-briefing"), { recursive: true });
    writeFileSync(join(home, "daily-briefing", "config.json"), JSON.stringify({ repos: [repo], provider: { cli: fakeCli(tempDir("dba-oou-")), argv: [], promptVia: "stdin" } }));
    process.env.XDG_CONFIG_HOME = home;
    const e = console.error; console.error = () => {};
    try { expect(await run(false, walkDeps({ now: () => NOW, interactive: true, netProbe: async () => false, netGraceMs: 20, netPollMs: 5 }))).toBe(0); }
    finally { console.error = e; }
    const skip = await readLastSkip();
    expect(skip?.reason).toBe("offline");
    expect("allOutOfUsage" in (skip ?? {})).toBe(false);
    expect((await statusReport()).lastSkip?.allOutOfUsage).toBeUndefined();
  });
});
