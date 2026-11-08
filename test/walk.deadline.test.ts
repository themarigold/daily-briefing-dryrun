// test/walk.deadline.test.ts — the per-attempt deadline, key scoping and `insecure-endpoint` (provider-fallback plan
// P1-M6-T3; spec r9 §5 step 4).
//
// ⚠ THIS FILE HOLDS NO LITERAL NAMING THE KEYCHAIN TOOL: app-owned key commands are built from SECURITY_BIN and
// APP_KEY_SERVICE (src/appKeyNames.ts, which the scanner never reads), and every one is served by an injected
// `keyExec`, so nothing here can reach the real Keychain. The cases that need the walk to MOVE ON (a refused entry
// followed by one that wins, the `[api key (fails), claude]` sentinel) are in test/walk.failover.test.ts (P1-M7-T1).
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, afterEach, beforeAll, spyOn } from "bun:test";
import * as fsp from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCore, attemptDeadlineMs, costLine, insecureEndpoint } from "../src/core";
import * as factory from "../src/providerFactory";
import { emptyEvidence } from "../src/transcripts/scan";
import { PROBE_MS as CAPABILITY_PROBE_MS, PROBE_FLUSH_MS } from "../src/probe";
import { recapCallDeadlineMs } from "../src/recapBudget";
import { API_TRANSPORT_MARGIN_MS } from "../src/attemptBounds";
import { accountStatePath, PROBE_MS } from "../src/account";
import { APP_KEY_SERVICE, SECURITY_BIN, resolveProviderList, type ListEntry } from "../src/providerList";
import { KEY_COMMAND_TIMEOUT_MS } from "../src/apiKey";
import { KILL_GRACE_MS, API_TIMEOUT_MS, flushWindowMs } from "../src/provider";
import { validateConfig } from "../src/config";
import { ProviderError, type Config, type GenerateOpts, type Provider } from "../src/types";
import { ASYNC_FS, type AsyncFsOps } from "../src/strictFile";
import type { RunOpts, RunResult } from "../src/proc";
import { buildRepo } from "./fixtures/build-repo";
import { startFakeApi, okJson, type FakeApi } from "./helpers/fakeApi";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { BRIEFING, fakeCli, freshStateDir, spawnsIn, tempDir, walkDeps } from "./helpers/walk";

guardNetworkForThisFile();

let repo = "";
const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
beforeAll(async () => {
  repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
});
afterAll(() => { process.env.DAILY_BRIEFING_STATE_DIR = prevState; });
const servers: FakeApi[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });

const KEY = "sk-ant-api03-ZZdeadlineSENTINEL-0000";
const anthropicOk = () => okJson({ content: [{ type: "text", text: BRIEFING }], stop_reason: "end_turn" });
const apiCfg = (api: Record<string, unknown>, extra: Record<string, unknown> = {}): Config =>
  ({ repos: [repo], provider: { cli: "anthropic-api", argv: [], promptVia: "stdin", timeoutMs: 3_000, api: { kind: "anthropic", model: "claude-sonnet-5", ...api } }, ...extra } as unknown as Config);
const okExec = (calls: string[][]) => async (argv: string[], _o?: RunOpts): Promise<RunResult> => {
  calls.push(argv);
  return { out: `${KEY}\n`, err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false };
};
const appArgv = [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-a", "k-0123456789ab", "-w", "/nonexistent/scratch.keychain-db"];
const fail = (p: Promise<unknown>) => p.then(() => undefined as unknown as ProviderError, (x) => x as ProviderError);

/** Make `cfg` a TWO-entry list whose second entry is benched by a usage mark, so the race applies (Q24: two or more,
 *  owned) while the walk can only try item 1. Writes the mark into `stateDir`. */
function withBenchedFallback(cfg: Config, stateDir: string): Config {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(accountStatePath(stateDir), JSON.stringify({ accounts: { Benched: { limitedUntil: new Date(Date.now() + PROBE_MS).toISOString(), isProbe: false, reason: "usage" } } }));
  return { ...cfg, fallbacks: [{ label: "Benched", cli: "/nonexistent/never-spawned", argv: [], promptVia: "stdin" }] } as unknown as Config;
}

describe("the deadline (hub Q24)", () => {
  test("a CLI attempt's deadline mirrors recapCallDeadlineMs (probe + two spawns); an API one is key + timeout + the measured margin", () => {
    const cfg = validateConfig({ repos: ["/x"], provider: { cli: "claude", argv: [], promptVia: "stdin", timeoutMs: 1_000 },
      fallbacks: [{ label: "K", api: { kind: "anthropic", model: "m" } }] }, "/home/u");
    const [cli, api] = resolveProviderList(cfg, "/home/u", {}, () => true).entries as [ListEntry, ListEntry];
    expect(attemptDeadlineMs(cli)).toBe(KEY_COMMAND_TIMEOUT_MS + CAPABILITY_PROBE_MS + PROBE_FLUSH_MS + 2 * (1_000 + KILL_GRACE_MS + flushWindowMs(false, {})));
    expect(attemptDeadlineMs(cli)).toBe(KEY_COMMAND_TIMEOUT_MS + CAPABILITY_PROBE_MS + PROBE_FLUSH_MS + recapCallDeadlineMs(1_000));
    // An API entry with no timeoutMs of its own waits the HTTP default (5 min), so its deadline must not be shorter.
    expect(attemptDeadlineMs(api)).toBe(KEY_COMMAND_TIMEOUT_MS + API_TIMEOUT_MS + API_TRANSPORT_MARGIN_MS);
  });

  test("the reviewer's repro: a SINGLE-entry CLI attempt with an 8 s --help probe and a pipe held through the flush delivers", async () => {
    // Measured at the P1-M6 checkpoint: this delivered before the walk and threw at b79343079, because the deadline
    // (key + t + grace = 11 s) was cut short of an 8 s probe plus the 10 s post-exit flush. Q24: a single entry is
    // never raced at all.
    freshStateDir();
    const dir = tempDir("dba-deadline-");
    const cli = join(dir, "claude");
    writeFileSync(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then sleep 8; echo '--tools --setting-sources --strict-mcp-config'; exit 0; fi
( sleep 12 ) &
printf '${BRIEFING.replace(/\n/g, "\\n")}'
`, { mode: 0o755 });
    const cfg = { repos: [repo], provider: { cli, argv: [], promptVia: "stdin", timeoutMs: 1_000 } } as Config;
    const r = await runCore(cfg, walkDeps());
    expect(r.rawText).toBe(BRIEFING);
  }, 60_000);

  test("the deadline cuts a STALLED key-file read, and the abandoned work never starts a late request", async () => {
    const d = freshStateDir();
    const s = await startFakeApi(anthropicOk()); servers.push(s);
    const dir = tempDir("dba-deadline-");
    const keyFile = join(dir, "k.key");
    writeFileSync(keyFile, KEY, { mode: 0o600 });
    // The key file's stat never returns until the test lets it: a read stalled on a dead network mount.
    const realStat = fsp.stat;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const spy = spyOn(fsp, "stat").mockImplementation((async (...a: Parameters<typeof fsp.stat>) => {
      if (String(a[0]) === keyFile) await gate;
      return realStat(...a);
    }) as typeof fsp.stat);
    try {
      const started = Date.now();
      const e = await fail(runCore(withBenchedFallback(apiCfg({ baseUrl: s.origin, apiKeyFile: keyFile }), d), walkDeps({ attemptDeadlineMs: 300 })));
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.code).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(s.requests).toHaveLength(0);
      release();                                         // the stalled read now returns a perfectly good key…
      await Bun.sleep(300);
      expect(s.requests).toHaveLength(0);                // …and the abandoned attempt still sends nothing
    } finally { release(); spy.mockRestore(); }
  });

  // P3-M1-T0 (PR 2 final r3 carried LOW, coverage): the morning `apiKeyFile` rung's KEY-FOLDER test (is this path an
  // app key file?) runs on an async fs so a dead mount cannot block the event loop (final harden r3, M1). `provider
  // test` pinned that; this pins it for the RUN's per-attempt race, through `RunDeps.keyFileFs`: every op of the
  // key-folder test held until released, on a two-entry list, is cut at the deadline and the abandoned work sends nothing.
  test("the deadline cuts a STALLED key-folder test (RunDeps.keyFileFs), and the abandoned work never starts a late request", async () => {
    const d = freshStateDir();
    const s = await startFakeApi(anthropicOk()); servers.push(s);
    const keyFile = join(tempDir("dba-deadline-kf-"), "user.key");
    writeFileSync(keyFile, KEY, { mode: 0o600 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let asked = 0;
    const keyFileFs = Object.fromEntries(Object.entries(ASYNC_FS).map(([op, f]) =>
      [op, async (p: string) => { asked++; await gate; return (f as (p: string) => Promise<unknown>)(p); }])) as AsyncFsOps;
    try {
      const started = Date.now();
      const e = await fail(runCore(withBenchedFallback(apiCfg({ baseUrl: s.origin, apiKeyFile: keyFile }), d), walkDeps({ attemptDeadlineMs: 300, keyFileFs })));
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.code).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(asked).toBeGreaterThan(0);                  // the premise: it was the key-folder test's fs that stalled
      expect(s.requests).toHaveLength(0);
      release();                                         // the stalled test now answers "a user's own file"…
      await Bun.sleep(300);
      expect(s.requests).toHaveLength(0);                // …and the abandoned attempt still sends nothing
    } finally { release(); }
  });

  test("the 5 s command bound still kills a stalled key command, inside the deadline", async () => {
    const d = freshStateDir();
    const s = await startFakeApi(anthropicOk()); servers.push(s);
    const started = Date.now();
    const e = await fail(runCore(withBenchedFallback(apiCfg({ baseUrl: s.origin, apiKeyCommand: ["sleep", "30"] }), d), walkDeps()));
    const took = Date.now() - started;
    // The command bound fired, not the deadline. A two-entry list's error is the aggregate (P1-M7-T2): the last attempt's
    // code, and the entry's own reason in `attempts`.
    expect([e.code, e.attempts?.[0]?.reason]).toEqual(["missing-binary", "key-unavailable"]);
    expect(took).toBeGreaterThanOrEqual(KEY_COMMAND_TIMEOUT_MS - 200);
    expect(took).toBeLessThan(KEY_COMMAND_TIMEOUT_MS + 3_000);
    expect(s.requests).toHaveLength(0);
  }, 20_000);

  test("ONE controller per attempt: a retry after a deadline abort gets a fresh deadline and a fresh signal", async () => {
    // Owned, two entries: a real transport, so the signal is real. Attempt 1 stalls in the POST past its deadline and is
    // aborted; withRetry then retries the timeout, and attempt 2 must start with its own un-aborted controller — a
    // shared one would make it fail before sending (the transport checks the signal before the request).
    const d = freshStateDir();
    let n = 0;
    const s = await startFakeApi(async () => {
      n++;
      if (n === 1) await Bun.sleep(1_000);
      return new Response(JSON.stringify({ content: [{ type: "text", text: BRIEFING }], stop_reason: "end_turn" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    servers.push(s);
    const r = await runCore(withBenchedFallback(apiCfg({ baseUrl: s.origin, apiKey: KEY }), d), walkDeps({ attemptDeadlineMs: 300, retryDelaysMs: [0] }));
    expect(r.rawText).toBe(BRIEFING);
    expect(n).toBe(2);
  });

  test("an injected provider is NEVER raced: no signal, today's one-argument call, today's rawText", async () => {
    const d = freshStateDir();
    const argCounts: number[] = [];
    const injected: Provider = {
      generate: async (...args: [string, GenerateOpts?]) => { argCounts.push(args.length); await Bun.sleep(300); return BRIEFING; },
    };
    const cfg = withBenchedFallback({ repos: [repo], provider: { cli: fakeCli(tempDir("dba-deadline-")), argv: [], promptVia: "stdin" } } as Config, d);
    const r = await runCore(cfg, walkDeps({ provider: injected, attemptDeadlineMs: 50, retryDelaysMs: [0] }));
    expect(r.rawText).toBe(BRIEFING);
    expect(argCounts).toEqual([1]);                      // called once, never cut, no second (billed) call
  });

  test("an abandoned attempt that resolves LATE never overwrites rawText or promptText", async () => {
    // The owned provider here ignores its signal (a stand-in for work a transport cannot stop). Attempt 1 loses the
    // race and resolves at ~400 ms with another answer; attempt 2 wins at once; the injected scan holds runCore open
    // until ~700 ms, past the late resolution, so a shared capture would be overwritten before the result is built.
    const d = freshStateDir();
    const LATE = BRIEFING.replace("resume here", "LATE answer");
    let calls = 0;
    const slowThenFast = {
      runtimeWarnings: [] as string[],
      generate: async (_p: string) => {
        calls++;
        if (calls === 1) { await Bun.sleep(400); return LATE; }
        return BRIEFING;
      },
    };
    const built = spyOn(factory, "buildProvider").mockImplementation(() => ({ provider: slowThenFast }) as never);
    const scan = (async (o: { window: { startUtc: string; endUtc: string } }) => { await Bun.sleep(700); return { evidence: emptyEvidence(o.window), degraded: [] }; }) as never;
    try {
      const cfg = withBenchedFallback({ repos: [repo], transcripts: { enabled: true }, provider: { cli: "claude", argv: [], promptVia: "stdin" } } as unknown as Config, d);
      const r = await runCore(cfg, walkDeps({ attemptDeadlineMs: 100, retryDelaysMs: [0], scan, persistHealth: async () => {} }));
      expect(calls).toBe(2);
      expect(r.rawText).toBe(BRIEFING);
      expect(r.rawText).not.toContain("LATE");
    } finally { built.mockRestore(); }
  });
});

describe("key scoping", () => {
  test("a resolved key never reaches process.env", async () => {
    freshStateDir();
    const s = await startFakeApi(anthropicOk()); servers.push(s);
    const calls: string[][] = [];
    const r = await runCore(apiCfg({ baseUrl: s.origin, apiKeyCommand: ["my-helper", "get"] }), walkDeps({ keyExec: okExec(calls) }));
    expect(r.rawText).toBe(BRIEFING);
    expect(s.requests[0]!.headers["x-api-key"]).toBe(KEY);
    expect(Object.values(process.env).some((v) => v === KEY)).toBe(false);
  });
});

describe("insecure-endpoint", () => {
  test("item 1: an app-owned key over non-loopback http is refused BEFORE the key is read; nothing is sent", async () => {
    freshStateDir();
    const calls: string[][] = [];
    const e = await fail(runCore(apiCfg({ baseUrl: "http://llm.example/v1", apiKeyCommand: appArgv }), walkDeps({ keyExec: okExec(calls) })));
    expect([e.code, e.failCause]).toEqual(["missing-binary", "insecure-endpoint"]);
    expect(calls).toEqual([]);                                  // the Keychain was never asked
  });

  test("a later entry, after an item 1 benched by a USAGE mark, is refused the same way", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-deadline-");
    mkdirSync(d, { recursive: true });
    writeFileSync(accountStatePath(d), JSON.stringify({ accounts: { default: { limitedUntil: new Date(Date.now() + PROBE_MS).toISOString(), isProbe: false, reason: "usage" } } }));
    const calls: string[][] = [];
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Key", api: { kind: "anthropic", model: "m", baseUrl: "http://llm.example/v1", apiKeyCommand: appArgv } }] } as unknown as Config;
    const e = await fail(runCore(cfg, walkDeps({ keyExec: okExec(calls) })));
    // The aggregate error (P1-M7-T2): the last attempt's code, the refusal as the entry's reason in `attempts`.
    expect([e.code, e.attempts?.find((a) => a.label === "Key")?.reason]).toEqual(["missing-binary", "insecure-endpoint"]);
    expect(calls).toEqual([]);
    expect(spawnsIn(dir)).toEqual([]);
  });

  test("https, loopback http, and a key that is not app-owned are not refused by this rule", async () => {
    freshStateDir();
    const s = await startFakeApi(anthropicOk()); servers.push(s);
    const calls: string[][] = [];
    // Loopback http with an app-owned key: allowed (a local proxy).
    expect((await runCore(apiCfg({ baseUrl: s.origin, apiKeyCommand: appArgv }), walkDeps({ keyExec: okExec(calls) }))).rawText).toBe(BRIEFING);
    expect(calls.length).toBe(1);
    // The rule itself, without the network (netGuard forbids a remote request): https with an app-owned key, and
    // non-loopback http with a key that is not app-owned, are not refused; the refused shape is.
    const entryFor = (api: Record<string, unknown>) => resolveProviderList(validateConfig({ repos: ["/x"], provider: { api: { kind: "anthropic", model: "m", ...api } } }, "/home/u"), "/home/u", {}, () => true).entries[0]!;
    expect(insecureEndpoint(entryFor({ baseUrl: "https://llm.example/v1", apiKeyCommand: appArgv }))).toBeUndefined();
    expect(insecureEndpoint(entryFor({ baseUrl: "http://llm.example/v1", apiKeyEnv: "K" }))).toBeUndefined();
    expect(insecureEndpoint(entryFor({ baseUrl: "http://llm.example/v1", apiKeyCommand: appArgv }))?.failCause).toBe("insecure-endpoint");
  });
});

describe("the cost line (chosen here; rendered in P1-M9-T3)", () => {
  const entries = () => resolveProviderList(validateConfig({ repos: ["/x"],
    provider: { cli: "claude", argv: [], promptVia: "stdin", credential: "env-api-key" },
    fallbacks: [
      { label: "Key", api: { kind: "anthropic", model: "m" } },
      { label: "Local", api: { kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:1/v1" } },
      { label: "Sub", cli: "claude", argv: [], promptVia: "stdin", configDir: "/x/sub" },
    ] }, "/home/u"), "/home/u", {}, () => true).entries;

  test("an API winner and a CLI winner given the env key get one; a local model and a subscription login do not", () => {
    const [envKey, key, local, sub] = entries() as [ListEntry, ListEntry, ListEntry, ListEntry];
    // The spec's notice wording (r9 §5 "Line wording", P1-M7-T2), the same for both cases.
    expect(costLine(key)).toBe('Generated using "Key" — API charges may apply.');
    expect(costLine(envKey)).toBe(`Generated using "${envKey.label}" — API charges may apply.`);
    expect(costLine(local)).toBeUndefined();
    expect(costLine(sub)).toBeUndefined();
  });
});

describe("PR 1 final review round 1", () => {
  test("M6: an OWNED single-entry walk is never raced — one-argument generate, and a 1 ms deadline does not cut it", async () => {
    freshStateDir();
    const argCounts: number[] = [];
    const owned = {
      runtimeWarnings: [] as string[],
      generate: async (...args: [string, GenerateOpts?]) => { argCounts.push(args.length); await Bun.sleep(100); return BRIEFING; },
    };
    const built = spyOn(factory, "buildProvider").mockImplementation(() => ({ provider: owned }) as never);
    try {
      const r = await runCore({ repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" } } as unknown as Config,
        walkDeps({ attemptDeadlineMs: 1 }));
      expect(r.rawText).toBe(BRIEFING);
      expect(argCounts).toEqual([1]);
    } finally { built.mockRestore(); }
  });

  test("L1: a huge entry timeout cannot overflow the deadline timer (clamped to 2^31 - 1 ms)", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-deadline-");
    const entries = resolveProviderList({ repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin", timeoutMs: 1.5e9 } } as unknown as Config, "/home/u", {}, () => true).entries;
    expect(attemptDeadlineMs(entries[0]!)).toBeLessThanOrEqual(2 ** 31 - 1);
    // Through the walk: an overflowed timer fires at once and would cut a healthy attempt with a "timeout".
    const cfg = withBenchedFallback({ repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin", timeoutMs: 1.5e9 } } as Config, d);
    const r = await runCore(cfg, walkDeps());
    expect(r.rawText).toBe(BRIEFING);
  });
});
