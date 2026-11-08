// test/legacy-identity.test.ts — CHARACTERIZATION PINS for a single-entry config (provider-fallback plan
// P1-M6-T0). Written GREEN against the code before the walk existed, and kept green by every walk task
// (P1-M6-T1 to P1-M8-T1): a combined list of exactly one must keep today's behaviour (spec requirement 9).
//
// What is pinned: the network gate and its endpoint derivation, the retry schedule, the provenance line (only with
// `accounts`), nothing new above the briefing title, the CoreResult shape with an injected provider, and the
// envelope's `account`. Real provider stack, against a fake CLI on disk and a fake HTTP server on 127.0.0.1.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, beforeAll, afterEach } from "bun:test";
import { runCore, PROVIDER_RETRY_DELAYS_MS } from "../src/core";
import { renderBriefing } from "../src/render";
import { envelopeFrom } from "../src/json";
import { ProviderError, API_LABEL_OPENAI, type Config, type Provider } from "../src/types";
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

const cliCfg = (cli: string, extra: Record<string, unknown> = {}): Config =>
  ({ repos: [repo], provider: { cli, argv: [], promptVia: "stdin", timeoutMs: 10_000, ...extra } } as Config);

/** The CoreResult keys of a delivered single-entry run, as they were before the walk. */
const DELIVERED_KEYS = [
  "activities", "blocked", "ctx", "discIssues", "discoveryBlocked", "emptyWindow", "extrIssues", "net", "offlineSkipped",
  // recordCommits is internal, absent from run --json (pinned below and by the goldens).
  "promptText", "rawText", "recordCommits", "repos", "runDate", "struct", "today", "todaySuppress", "units", "warnings", "windowStartUtc",
];

describe("a single-entry config keeps today's behaviour", () => {
  test("a delivered CLI run: no account, envelope account null, nothing above the title, the same result keys", async () => {
    freshStateDir();
    const dir = tempDir("dba-legacy-");
    const r = await runCore(cliCfg(fakeCli(dir)), walkDeps());
    expect(r.rawText).toBe(BRIEFING);
    expect(r.account).toBeUndefined();
    expect(envelopeFrom(r, renderBriefing(r.struct), 0).account).toBeNull();
    expect(renderBriefing(r.struct).split("\n")[0]).toStartWith("☀️  Daily briefing — ");
    // + `attempts` (P1-M7-T2, spec r9 §5 Reporting: one element per entry for every owned walk, single-entry included).
    // It is not in the `run --json` envelope, so the envelope stays today's (pinned below and by the goldens).
    // + `summarySeed` (A2-M3-T8), on the same terms: an owned walk only (the injected shape below stays without it).
    expect(Object.keys(r).filter((k) => (r as Record<string, unknown>)[k] !== undefined).sort()).toEqual([...DELIVERED_KEYS, "attempts", "summarySeed"].sort());
    expect(r.attempts).toEqual([{ label: "default", kind: "cli", outcome: "won" }]);
    expect(spawnsIn(dir)).toEqual([""]);                       // one spawn, with no CLAUDE_CONFIG_DIR
  });

  test("the provenance line follows `accounts`: a one-login list names its label, in the result and the envelope", async () => {
    freshStateDir();
    const dir = tempDir("dba-legacy-");
    const r = await runCore(cliCfg(fakeCli(dir), { accounts: [{ label: "solo" }] }), walkDeps());
    expect(r.account).toBe("solo");
    expect(envelopeFrom(r, renderBriefing(r.struct), 0).account).toBe("solo");
  });

  test("the retry schedule: a fast transient failure is retried after 45 s and 90 s, then the two ladder rungs — five spawns", async () => {
    freshStateDir();
    const dir = tempDir("dba-legacy-");
    const cli = fakeCli(dir, "fake-provider", "echo 'transient' 1>&2; exit 1");
    const sleeps: number[] = [];
    const { retryDelaysMs: _drop, ...noSchedule } = walkDeps({ sleep: async (ms: number) => { sleeps.push(ms); } });
    await expect(runCore(cliCfg(cli), noSchedule)).rejects.toMatchObject({ code: "nonzero-exit" });
    expect(sleeps).toEqual(PROVIDER_RETRY_DELAYS_MS);
    expect(PROVIDER_RETRY_DELAYS_MS).toEqual([45_000, 90_000]);
    expect(spawnsIn(dir).length).toBe(5);                       // 1 + 2 retries, then rung 1 and rung 2 (MAX_PROVIDER_ATTEMPTS)
  });

  test("the network gate: a loopback API endpoint disables it (no probe hosts); an explicit [] too", async () => {
    freshStateDir();
    const s = await startFakeApi(okJson({ choices: [{ index: 0, message: { role: "assistant", content: BRIEFING }, finish_reason: "stop" }] }));
    servers.push(s);
    const apiCfg = { repos: [repo], provider: { cli: API_LABEL_OPENAI, argv: [], promptVia: "stdin", timeoutMs: 10_000, api: { kind: "openai-compatible", model: "m", baseUrl: `${s.origin}/v1` } } } as Config;
    const { netProbe: _a, ...noProbe } = walkDeps();
    // No injected probe: the derived host list for a loopback endpoint is [], so the gate passes at once.
    const r = await runCore(apiCfg, { ...noProbe, netGraceMs: 60_000 });
    expect(r.net?.online).toBe(true);
    expect(r.net!.waitedMs).toBeLessThan(5_000);
    // (A CLI config's default anycast hosts would probe the real network, so that half is not run here.)
    const dir = tempDir("dba-legacy-");
    const r3 = await runCore({ ...cliCfg(fakeCli(dir)), networkProbeHosts: [] } as Config, { ...noProbe, netGraceMs: 60_000 });
    expect(r3.net?.online).toBe(true);
  });

  test("a scheduled tick still offline after the grace is a quiet offline skip with no spawn", async () => {
    freshStateDir();
    const dir = tempDir("dba-legacy-");
    const r = await runCore(cliCfg(fakeCli(dir)), walkDeps({ netProbe: async () => false, netGraceMs: 30, netPollMs: 10 }));
    expect([r.offlineSkipped, r.skipReason]).toEqual([true, "offline"]);
    expect(spawnsIn(dir)).toEqual([]);
  });

  // PR 1 final review round 3 pins (P2): the offline loopback rule is for a list of TWO OR MORE. A single loopback item 1
  // whose gate is kept on by an explicit `networkProbeHosts` still skips offline, and never calls its local model.
  test("a single loopback API item 1 with explicit probe hosts, offline and not forced: today's quiet offline skip", async () => {
    freshStateDir();
    const s = await startFakeApi(okJson({ choices: [{ index: 0, message: { role: "assistant", content: BRIEFING }, finish_reason: "stop" }] }));
    servers.push(s);
    const cfg = { repos: [repo], networkProbeHosts: [{ host: "10.0.0.1", port: 53 }],
      provider: { cli: API_LABEL_OPENAI, argv: [], promptVia: "stdin", timeoutMs: 10_000, api: { kind: "openai-compatible", model: "m", baseUrl: `${s.origin}/v1` } } } as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: async () => false, netGraceMs: 30, netPollMs: 10 }));
    expect([r.offlineSkipped, r.skipReason]).toEqual([true, "offline"]);
    expect(s.requests.length).toBe(0);
  });

  test("with an injected provider the result has the same keys and no account", async () => {
    freshStateDir();
    const injected: Provider = { generate: async () => BRIEFING };
    const r = await runCore(cliCfg("/nonexistent/never-spawned", { accounts: [{ label: "solo" }] }), walkDeps({ provider: injected }));
    expect(r.account).toBeUndefined();
    expect(Object.keys(r).filter((k) => (r as Record<string, unknown>)[k] !== undefined).sort()).toEqual(DELIVERED_KEYS);
  });

  test("an injected provider's failure is rethrown as it was", async () => {
    freshStateDir();
    const injected: Provider = { generate: async () => { throw new ProviderError("missing-binary", "injected failure"); } };
    await expect(runCore(cliCfg("/nonexistent/never-spawned"), walkDeps({ provider: injected }))).rejects.toMatchObject({ code: "missing-binary" });
  });
});
