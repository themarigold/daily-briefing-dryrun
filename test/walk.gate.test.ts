// test/walk.gate.test.ts — the gate at walk start and the offline rules (provider-fallback plan P1-M6-T1; spec r9
// §5 steps 1–3).
//
// For a list of two or more, the probe set is `networkProbeHosts` (or the anycast defaults) plus each REMOTE API
// entry's endpoint host; CLI and loopback entries add none, and a loopback entry never disables the gate. Offline on
// a scheduled tick, only leading loopback entries run (and, from 60 minutes past the morning time, every loopback
// entry); forced runs wait the grace and ignore the verdict. Single-entry configs keep today's derivation
// (test/legacy-identity.test.ts). The cases that need the walk to MOVE ON after a failure are in test/walk.failover.test.ts.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, afterEach, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCore, walkProbeHosts } from "../src/core";
import { defaultNetProbe } from "../src/net";
import { DEFAULT_NETWORK_PROBE_HOSTS, validateConfig } from "../src/config";
import { resolveProviderList } from "../src/providerList";
import type { Config } from "../src/types";
import type { CalendarStep, CalendarStepContext } from "../src/calendar/step";
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

const chatOk = () => okJson({ choices: [{ index: 0, message: { role: "assistant", content: BRIEFING }, finish_reason: "stop" }] });
const loopbackApi = (origin: string) => ({ kind: "openai-compatible", model: "llama3", baseUrl: `${origin}/v1` });
const hostsFor = (raw: Record<string, unknown>) => {
  const cfg = validateConfig({ repos: ["/nonexistent"], ...raw }, "/home/u");
  return walkProbeHosts(cfg, resolveProviderList(cfg, "/home/u", {}, () => true)).hosts;
};
const CLI = { cli: "claude", argv: [], promptVia: "stdin" };

describe("the probe set", () => {
  test("two or more: anycast plus each REMOTE API entry's host; CLI and loopback entries add none", () => {
    expect(hostsFor({ provider: CLI, fallbacks: [{ label: "Key", api: { kind: "anthropic", model: "m", baseUrl: "https://llm.example:8443/v1" } }] }))
      .toEqual([...DEFAULT_NETWORK_PROBE_HOSTS, { host: "llm.example", port: 8443 }]);
    expect(hostsFor({ provider: CLI, fallbacks: [{ label: "Anthropic", api: { kind: "anthropic", model: "m" } }] }))
      .toEqual([...DEFAULT_NETWORK_PROBE_HOSTS, { host: "api.anthropic.com", port: 443 }]);
    expect(hostsFor({ provider: CLI, fallbacks: [{ label: "Local", api: loopbackApi("http://127.0.0.1:11434") }] }))
      .toEqual(DEFAULT_NETWORK_PROBE_HOSTS);   // a loopback entry does not disable the gate
  });

  test("an all-loopback list with unset hosts disables the gate; an explicit [] disables it; explicit hosts keep the remote ones", () => {
    expect(hostsFor({ provider: { api: loopbackApi("http://127.0.0.1:1") }, fallbacks: [{ label: "L2", api: loopbackApi("http://localhost:2") }] })).toEqual([]);
    expect(hostsFor({ provider: CLI, networkProbeHosts: [], fallbacks: [{ label: "K", api: { kind: "anthropic", model: "m" } }] })).toEqual([]);
    expect(hostsFor({ provider: CLI, networkProbeHosts: [{ host: "10.0.0.1", port: 53 }], fallbacks: [{ label: "K", api: { kind: "anthropic", model: "m" } }] }))
      .toEqual([{ host: "10.0.0.1", port: 53 }, { host: "api.anthropic.com", port: 443 }]);
  });

  test("single-entry keeps today's derivation: a remote endpoint's host only; a loopback one disables", () => {
    expect(hostsFor({ provider: { api: { kind: "anthropic", model: "m", baseUrl: "https://llm.example/v1" } } })).toEqual([{ host: "llm.example", port: 443 }]);
    expect(hostsFor({ provider: { api: loopbackApi("http://127.0.0.1:1") } })).toEqual([]);
    expect(hostsFor({ provider: CLI })).toEqual(DEFAULT_NETWORK_PROBE_HOSTS);
  });

  test("the probe reads online when ANY host answers: anycast blocked, the endpoint reachable", async () => {
    const s = await startFakeApi(chatOk()); servers.push(s);
    const port = Number(new URL(s.origin).port);
    expect(await defaultNetProbe([{ host: "127.0.0.1", port: 1 }, { host: "127.0.0.1", port }])()).toBe(true);
    expect(await defaultNetProbe([{ host: "127.0.0.1", port: 1 }])()).toBe(false);
  });
});

describe("the walk-start verdict", () => {
  test("offline on a scheduled tick: a quiet skip with no spawn and no marks", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-gate-");
    const s = await startFakeApi(chatOk()); servers.push(s);
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" }, fallbacks: [{ label: "Local", api: loopbackApi(s.origin) }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: async () => false, netGraceMs: 30, netPollMs: 10, now: () => morning(30) }));
    expect([r.offlineSkipped, r.skipReason]).toEqual([true, "offline"]);
    expect(spawnsIn(dir)).toEqual([]);
    expect(s.requests).toHaveLength(0);                   // a loopback entry LATER in the list does not run before floor + 60
    expect(existsSync(join(d, "account-state.json"))).toBe(false);
  });

  test("a LEADING loopback entry runs offline and delivers; the calendar step reads the walk-start verdict", async () => {
    freshStateDir();
    const dir = tempDir("dba-gate-");
    const s = await startFakeApi(chatOk()); servers.push(s);
    const seen: CalendarStepContext[] = [];
    const calendar: CalendarStep = async (c) => { seen.push(c); return undefined; };
    const cfg = { repos: [repo], provider: { api: loopbackApi(s.origin), cli: "openai-compatible", argv: [], promptVia: "stdin" }, fallbacks: [{ label: "CLI", cli: fakeCli(dir), argv: [], promptVia: "stdin" }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: async () => false, netGraceMs: 30, netPollMs: 10, now: () => morning(30), calendar }));
    expect(r.offlineSkipped).toBe(false);
    expect(r.rawText).toBe(BRIEFING);
    expect(r.net?.online).toBe(false);
    expect(s.requests).toHaveLength(1);
    expect(spawnsIn(dir)).toEqual([]);
    expect(seen.map((c) => c.offline)).toEqual([true]);
  });

  test("a forced run waits the grace, ignores an offline verdict, and walks the eligible entries", async () => {
    freshStateDir();
    const dir = tempDir("dba-gate-");
    const s = await startFakeApi(chatOk()); servers.push(s);
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" }, fallbacks: [{ label: "Local", api: loopbackApi(s.origin) }] } as unknown as Config;
    let probes = 0;
    const r = await runCore(cfg, walkDeps({ netProbe: async () => { probes++; return false; }, netGraceMs: 40, netPollMs: 10 }), true);
    expect(r.net?.online).toBe(false);
    expect(probes).toBeGreaterThan(1);                    // it waited the grace, polling
    expect(r.rawText).toBe(BRIEFING);
    expect(spawnsIn(dir)).toEqual([""]);                  // item 1, the CLI, ran despite the verdict
  });

  test("an all-loopback list with unset hosts does not wait the grace (the real probe, nothing injected)", async () => {
    freshStateDir();
    const s = await startFakeApi(chatOk()); servers.push(s);
    const cfg = { repos: [repo], provider: { api: loopbackApi(s.origin), cli: "openai-compatible", argv: [], promptVia: "stdin" }, fallbacks: [{ label: "L2", api: loopbackApi(s.origin) }] } as unknown as Config;
    const { netProbe: _p, ...noProbe } = walkDeps();
    const started = Date.now();
    const r = await runCore(cfg, { ...noProbe, netGraceMs: 60_000 });
    expect(r.net?.online).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.rawText).toBe(BRIEFING);
  });

  test("from 60 minutes past the morning time, a loopback entry LATER in the list runs offline; the CLI item 1 does not", async () => {
    // The mark-benched variant (an earlier non-loopback entry skipped) needs step 0 and is in walk.core.test.ts.
    freshStateDir();
    const dir = tempDir("dba-gate-");
    const s = await startFakeApi(chatOk()); servers.push(s);
    const cfg = { repos: [repo], morningTime: "07:20", provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" }, fallbacks: [{ label: "Local", api: loopbackApi(s.origin) }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: async () => false, netGraceMs: 30, netPollMs: 10, now: () => morning(61) }));
    expect(r.rawText).toBe(BRIEFING);
    expect(spawnsIn(dir)).toEqual([]);                    // the CLI item 1 is not a loopback entry: it does not run offline
    expect(s.requests).toHaveLength(1);
  });
});

/** Local time `mins` past 07:20 today. */
function morning(mins: number): Date {
  const d = new Date();
  d.setHours(7, 20, 0, 0);
  return new Date(d.getTime() + mins * 60_000);
}

test("round 3 L13: two remote entries on ONE host add one probe host", () => {
  const api = (label: string) => ({ label, api: { kind: "openai-compatible", model: label, baseUrl: "https://llm.example:8443/v1" } });
  expect(hostsFor({ provider: CLI, networkProbeHosts: [{ host: "10.0.0.1", port: 53 }], fallbacks: [api("A"), api("B")] }))
    .toEqual([{ host: "10.0.0.1", port: 53 }, { host: "llm.example", port: 8443 }]);
});
