// test/walk.invariants.test.ts — CHARACTERIZATION PINS that every walk task keeps green (provider-fallback plan
// P1-M6-T0; plan risk 1).
//
//   • With an INJECTED provider (`deps.provider` — the eval harness, src/eval/run-case.ts) the walk is a single
//     entry, writes NO marks and NO provider status, and returns no `attempts` — on success and on failure.
//   • A hand-written compacted config reads the same item 1 and logins through `resolveAccounts` (the judge's
//     reader) and through the combined-list resolver.
//   • The audit judge: `resolveForScript` still benches an hour-marked item 1, and `withRetry`'s judge schedule.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runCore } from "../src/core";
import { withRetry } from "../src/provider";
import { accountStatePath, resolveForScript, PROBE_MS } from "../src/account";
import { validateConfig, resolveAccounts } from "../src/config";
import { resolveProviderList } from "../src/providerList";
import { ProviderError, type Config, type Provider } from "../src/types";
import { buildRepo } from "./fixtures/build-repo";
import { BRIEFING, freshStateDir, walkDeps } from "./helpers/walk";

let repo = "";
const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
beforeAll(async () => {
  repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
});
afterAll(() => { process.env.DAILY_BRIEFING_STATE_DIR = prevState; });

/** A two-login config with a fallback: the shape that will walk. With an injected provider it must not. */
const walkingCfg = (): Config => ({
  repos: [repo],
  provider: { cli: "/nonexistent/never-spawned", argv: [], promptVia: "stdin", accounts: [{ label: "A" }, { label: "B", configDir: "/nonexistent/b" }] },
  fallbacks: [{ label: "Local model", api: { kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9/v1" } }],
} as unknown as Config);

const stateFiles = (d: string) => ["account-state.json", "provider-status.json"].filter((f) => existsSync(join(d, f)));

describe("an injected provider", () => {
  test("delivers as a single entry, writes no marks or status, and returns no attempts", async () => {
    const d = freshStateDir();
    let calls = 0;
    const injected: Provider = { generate: async () => { calls++; return BRIEFING; } };
    const r = await runCore(walkingCfg(), walkDeps({ provider: injected }));
    expect(calls).toBe(1);
    expect(r.rawText).toBe(BRIEFING);
    expect(!("attempts" in r)).toBe(true);
    expect(stateFiles(d)).toEqual([]);
  });

  test("a usage wall from it writes nothing either, and the error carries no attempts", async () => {
    const d = freshStateDir();
    let calls = 0;
    const injected: Provider = { generate: async () => { calls++; throw new ProviderError("usage-limit", "You've hit your weekly limit · resets Aug 26 at 10pm (America/Los_Angeles)"); } };
    const e = await runCore(walkingCfg(), walkDeps({ provider: injected })).then(() => undefined, (x) => x as ProviderError);
    expect(e).toBeInstanceOf(ProviderError);
    expect(calls).toBe(1);                                   // a single entry: nothing else was tried
    expect(e!.attempts).toBeUndefined();
    expect(stateFiles(d)).toEqual([]);
  });

  // PR 1 final review round 3 pins (P3): the injected provider's walk is ONE entry (`eligible.slice(0, 1)`), so a
  // transient failure gets item 1's `withRetry` schedule as the LAST entry — never `withEntryRetry`, never a move-on.
  test("a transient failure from it: withRetry's schedule on item 1 only, no second entry, no attempts", async () => {
    const d = freshStateDir();
    let calls = 0;
    const slept: number[] = [];
    const injected: Provider = { generate: async () => { calls++; const e = new ProviderError("nonzero-exit", "transient"); e.durationMs = 1; throw e; } };
    const e = await runCore(walkingCfg(), walkDeps({ provider: injected, retryDelaysMs: [11, 22], sleep: async (ms: number) => { slept.push(ms); } }))
      .then(() => undefined, (x) => x as ProviderError);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e!.code).toBe("nonzero-exit");
    expect([calls, slept]).toEqual([3, [11, 22]]);          // the try plus the schedule's two retries, and nothing else
    expect(e!.attempts).toBeUndefined();
    expect(stateFiles(d)).toEqual([]);
  });

  test("a plain failure from it writes nothing, on any entry, and is rethrown", async () => {
    const d = freshStateDir();
    const injected: Provider = { generate: async () => { throw new ProviderError("nonzero-exit", "boom"); } };
    await expect(runCore(walkingCfg(), walkDeps({ provider: injected }))).rejects.toMatchObject({ code: "nonzero-exit" });
    expect(stateFiles(d)).toEqual([]);
  });
});

describe("a compacted config", () => {
  test("reads the same item 1 and logins through resolveAccounts and through the combined-list resolver", () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "compacted-config.json"), "utf8"));
    const cfg = validateConfig(raw, homedir());
    const judge = resolveAccounts(cfg.provider.accounts, homedir(), {}, () => true);
    const list = resolveProviderList(cfg, homedir(), {}, () => true);
    const logins = list.entries.filter((e) => e.source === "provider").map((e) => ({ label: e.label, ...(e.configDir ? { configDir: e.configDir } : {}) }));
    expect(logins).toEqual(judge.accounts!);
    expect(list.entries.map((e) => e.label)).toEqual(["Claude login 1", "Claude login 2", "Anthropic key", "Local model"]);
    expect(list.dropped).toEqual([]);
  });
});

describe("the audit judge", () => {
  test("resolveForScript still benches an hour-marked item 1 (the item-1 rule is the walk's, not the judge's)", async () => {
    const d = freshStateDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(accountStatePath(d), JSON.stringify({ accounts: { A: { limitedUntil: new Date(Date.now() + PROBE_MS).toISOString(), isProbe: true, reason: "auth" } } }));
    expect((await resolveForScript([{ label: "A" }, { label: "B", configDir: "/x" }], new Date(), d)).account).toEqual({ label: "B", configDir: "/x" });
  });

  test("withRetry's judge schedule is unchanged", async () => {
    const sleeps: number[] = [];
    let n = 0;
    await expect(withRetry(async () => { n++; throw new ProviderError("timeout", "x"); }, [5_000, 15_000], async (ms) => void sleeps.push(ms))).rejects.toBeInstanceOf(ProviderError);
    expect([n, sleeps]).toEqual([3, [5_000, 15_000]]);
  });
});
