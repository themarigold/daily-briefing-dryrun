// test/main.paused.test.ts — the shell's half of the list exhausted (provider-fallback plan P1-M7-T3; spec r9 §5 step 7):
// a `paused` result is a `provider-fail` skip with no delivery, the aggregate error's skip detail opens with the count
// line (no `code: ` prefix), and a single entry's failure keeps today's `code: message` detail.
//
// Through `run()`: real config load (XDG_CONFIG_HOME), real provider stack against fake CLIs and loopback servers, and
// the state files the shell actually writes.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, afterEach, beforeAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/main";
import { accountStatePath } from "../src/account";
import { formatResetTime } from "../src/failover";
import { latestBriefingPath, markerPath, readLastSkip } from "../src/marker";
import { buildRepo } from "./fixtures/build-repo";
import { startFakeApi, status, type FakeApi } from "./helpers/fakeApi";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { fakeCli, freshStateDir, spawnsIn, tempDir, walkDeps } from "./helpers/walk";

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
const servers: FakeApi[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });
const serve = async (h: Parameters<typeof startFakeApi>[0]) => { const s = await startFakeApi(h); servers.push(s); return s; };

/** Write the config `run()` loads, and capture stderr while `fn` runs. */
async function withConfig(cfg: Record<string, unknown>, fn: (err: string[]) => Promise<void>): Promise<void> {
  const home = tempDir("dba-paused-cfg-");
  mkdirSync(join(home, "daily-briefing"), { recursive: true });
  writeFileSync(join(home, "daily-briefing", "config.json"), JSON.stringify({ repos: [repo], ...cfg }));
  process.env.XDG_CONFIG_HOME = home;
  const err: string[] = [];
  const realErr = console.error, realLog = console.log;
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  try { await fn(err); } finally { console.error = realErr; console.log = realLog; }
}
const local = (label: string, origin: string) => ({ label, api: { kind: "openai-compatible", model: "llama3", baseUrl: `${origin}/v1` } });

describe("run() and the exhaustion table", () => {
  test("a paused result exits 1 as provider-fail, says until when, and writes no briefing and no stamp", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-paused-");
    const now = new Date();
    const hourEnd = new Date(now.getTime() + 30 * 60e3).toISOString();
    mkdirSync(d, { recursive: true });
    writeFileSync(accountStatePath(d), JSON.stringify({ accounts: {
      A: { limitedUntil: new Date(now.getTime() + 5 * 3600e3).toISOString(), isProbe: false, reason: "usage" },
      B: { limitedUntil: hourEnd, isProbe: true, reason: "auth" },
    } }));
    await withConfig({ provider: { cli: fakeCli(dir, "claude"), argv: [], promptVia: "stdin", accounts: [{ label: "A", configDir: `${dir}/a` }, { label: "B", configDir: `${dir}/b` }] } }, async (err) => {
      const code = await run(true, walkDeps());
      expect(code).toBe(1);
      const expected = `paused after failures until ${formatResetTime(hourEnd, new Date())} — open Settings → Providers`;
      const skip = await readLastSkip();
      expect([skip?.reason, skip?.detail]).toEqual(["provider-fail", expected]);
      expect(err.some((l) => l.includes(expected))).toBe(true);
    });
    expect(existsSync(latestBriefingPath())).toBe(false);
    expect(existsSync(markerPath())).toBe(false);
    expect(spawnsIn(dir)).toEqual([]);
  });

  test("the aggregate error's skip detail has no code prefix: its first line is the count line", async () => {
    freshStateDir();
    const dir = tempDir("dba-paused-");
    const s401 = await serve(status(401, { error: { message: "no" } }));
    await withConfig({ provider: { cli: fakeCli(dir, "fail-cli", "exit 1"), argv: [], promptVia: "stdin", harden: false }, fallbacks: [local("Local", s401.origin)] }, async () => {
      const code = await run(true, walkDeps());
      expect(code).toBe(1);
      const skip = await readLastSkip();
      expect(skip?.reason).toBe("provider-fail");
      const lines = (skip?.detail ?? "").split("\n");
      expect(lines[0]).toBe("2 providers failed — open Settings → Providers");
      expect(lines.slice(1)).toEqual(['Failed "default": unrecognised CLI failure', 'Failed "Local": key or login rejected']);
    });
  });

  test("a multi-entry failure prints each tried entry's diagnostic to stderr, redacted — and never into last-skip", async () => {
    freshStateDir();
    const dir = tempDir("dba-paused-");
    const KEY = "sk-ant-api03-Zq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-AbCdEfGhAA";
    // Both transports' diagnostics carry the key: the CLI's stderr, and an HTTP body that echoes it back.
    const s401 = await serve(status(401, { error: { message: `bad key ${KEY}` } }));
    await withConfig({ provider: { cli: fakeCli(dir, "fail-cli", `echo "auth failed for ${KEY}" 1>&2; exit 1`), argv: [], promptVia: "stdin", harden: false },
      fallbacks: [local("Local", s401.origin)] }, async (err) => {
      expect(await run(true, walkDeps())).toBe(1);
      const i = err.findIndex((l) => l.includes("Briefing provider failed") && l.includes("2 providers failed"));
      expect(i).toBeGreaterThanOrEqual(0);
      const below = err.slice(i + 1, i + 3);
      expect(below[0]).toStartWith('  "default": nonzero-exit: ');
      expect(below[1]).toStartWith('  "Local": missing-binary: ');
      expect(err.join("\n")).not.toContain(KEY);                     // redacted at print
      const skip = await readLastSkip();
      expect(skip?.detail).not.toContain("auth failed for");          // the diagnostics stay out of the record
    });
  });

  test("a single-entry provider-fail detail keeps today's `code: message`", async () => {
    freshStateDir();
    const dir = tempDir("dba-paused-");
    await withConfig({ provider: { cli: fakeCli(dir, "fail-cli", "echo down 1>&2; exit 1"), argv: [], promptVia: "stdin", harden: false } }, async () => {
      expect(await run(true, walkDeps())).toBe(1);
      const skip = await readLastSkip();
      expect(skip?.reason).toBe("provider-fail");
      expect(skip?.detail).toStartWith("nonzero-exit: ");
    });
  });

  test("row 2: the last entry's unusable answer is parse-empty, and its detail lists the earlier entries", async () => {
    freshStateDir();
    const dir = tempDir("dba-paused-");
    const s500 = await serve(status(500, {}));
    await withConfig({ provider: { api: { kind: "openai-compatible", model: "m", baseUrl: `${s500.origin}/v1` } },
      fallbacks: [{ label: "Prose", cli: fakeCli(dir, "prose-cli", "echo 'No briefing today.'"), argv: [], promptVia: "stdin" }] }, async () => {
      expect(await run(true, walkDeps())).toBe(1);
      const skip = await readLastSkip();
      // P1-M7 checkpoint MED 3: an engine-worded first line naming the entry that returned the unusable answer (the
      // FAILED body), then the earlier entries' lines from `attempts` — never "used Prose" for the entry that failed.
      expect([skip?.reason, skip?.detail]).toEqual(["parse-empty", '"Prose" returned no usable briefing — open Settings → Providers\nFailed "default": unreachable']);
    });
    expect(existsSync(markerPath())).toBe(false);
  });
});

test("M3: the provenance line carries a safe label (a key-shaped login label is masked)", async () => {
  freshStateDir();
  const dir = tempDir("dba-paused-");
  const KEY = "sk-ant-api03-Zq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-AbCdEfGhAA";
  await withConfig({ provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin", accounts: [{ label: `Cal https://calendar.google.com/calendar/ical/x/private-abc/basic.ics ${KEY}` }] } }, async (err) => {
    expect(await run(true, walkDeps())).toBe(0);
    const line = err.find((l) => l.startsWith("briefing generated by account"));
    expect(line).toBeDefined();
    expect(line).not.toContain("calendar.google");
    expect(line).not.toContain("Zq9xR2bT7mVw");
  });
});

// PR 1 final review round 3 M4: the parse-empty detail is for a list of TWO OR MORE tried entries. A single-entry
// config with one configured login sets `r.account`, so only the count separates it from row 2.
test("round 3 M4: one entry with ONE configured `accounts` login, parse-empty — no detail", async () => {
  freshStateDir();
  const dir = tempDir("dba-paused-");
  const login = tempDir("dba-paused-login-");
  writeFileSync(join(login, ".claude.json"), "{}");
  await withConfig({ provider: { cli: fakeCli(dir, "prose-cli", "echo 'No briefing today.'"), argv: [], promptVia: "stdin", harden: false,
    accounts: [{ label: "Solo", configDir: login }] } }, async () => {
    expect(await run(true, walkDeps())).toBe(1);
    const skip = await readLastSkip();
    expect(skip?.reason).toBe("parse-empty");
    expect(skip && "detail" in skip ? skip.detail : undefined).toBeUndefined();
  });
});

// PR 1 final review round 4 L5: the provenance line names the entry that DELIVERED. An unusable last answer delivers
// nothing (the parse-empty path), so no "briefing generated by account" line precedes "did not parse".
test("round 4 L5: no provenance line for an unusable last answer (two entries; and one configured login)", async () => {
  for (const multi of [true, false]) {
    freshStateDir();
    const dir = tempDir("dba-paused-");
    const login = tempDir("dba-paused-login-");
    writeFileSync(join(login, ".claude.json"), "{}");
    const prose = { cli: fakeCli(dir, "prose-cli", "echo 'No briefing today.'"), argv: [], promptVia: "stdin", harden: false };
    const cfg = multi
      ? { provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" }, fallbacks: [{ label: "Prose", ...prose }] }
      : { provider: { ...prose, accounts: [{ label: "Solo", configDir: login }] } };
    await withConfig(cfg, async (err) => {
      expect(await run(true, walkDeps())).toBe(1);
      expect(err.some((l) => l.includes("did not parse into any section"))).toBe(true);       // the premise
      expect(`${multi}: ${err.filter((l) => l.startsWith("briefing generated by account")).length}`).toBe(`${multi}: 0`);
    });
  }
});
