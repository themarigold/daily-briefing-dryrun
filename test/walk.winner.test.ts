// test/walk.winner.test.ts — winner semantics (provider-fallback plan P1-M6-T2; spec r9 §5 step 6): the footer,
// the provenance keying, the grouper's instance, the runtime warnings, the transcript evidence and the
// not-a-Claude-CLI warning all follow the entry that WON. Single-entry behaviour: test/legacy-identity.test.ts.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, afterEach, beforeAll, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { runCore, type RunDeps } from "../src/core";
import * as factory from "../src/providerFactory";
import * as recapPhase from "../src/recapCampaignsPhase";
import { accountStatePath, PROBE_MS } from "../src/account";
import { emptyEvidence, type ScanOutcome } from "../src/transcripts/scan";
import { renderBriefing } from "../src/render";
import { envelopeFrom } from "../src/json";
import type { Config } from "../src/types";
import type { RecapRecordV2 } from "../src/recapCampaigns";
import { buildRepo } from "./fixtures/build-repo";
import { busyRepo, busyReply, busyCfg, type BusyRepo } from "./fixtures/recap-busy";
import { startFakeApi, okJson, type FakeApi } from "./helpers/fakeApi";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { BRIEFING, fakeCli, freshStateDir, spawnsIn, tempDir, walkDeps } from "./helpers/walk";

guardNetworkForThisFile();

let repo = "";
let busy: BusyRepo;
const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
beforeAll(async () => {
  repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
  busy = await busyRepo(40);
}, 60_000);
afterAll(() => { process.env.DAILY_BRIEFING_STATE_DIR = prevState; });
const servers: FakeApi[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });

const chat = (content: string) => okJson({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
const loopbackApi = (origin: string) => ({ kind: "openai-compatible", model: "llama3", baseUrl: `${origin}/v1` });

/** Bench item 1 (`label`) with a usage mark, so the walk's first eligible entry is the fallback. */
function benchItem1(d: string, label: string): void {
  mkdirSync(d, { recursive: true });
  writeFileSync(accountStatePath(d), JSON.stringify({ accounts: { [label]: { limitedUntil: new Date(Date.now() + PROBE_MS).toISOString(), isProbe: false, reason: "usage" } } }));
}

describe("a fallback that wins", () => {
  test("the footer is the WINNER's provider label, its runtime warnings reach the struct, and the provenance names it", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-winner-");
    const s = await startFakeApi(chat(BRIEFING)); servers.push(s);
    benchItem1(d, "default");
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" }, fallbacks: [{ label: "Local", api: loopbackApi(s.origin) }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps());
    expect(r.struct.provider).toBe("openai-compatible (llama3)");
    expect(r.struct.warnings?.some((w) => w.includes("the openai-compatible API provider spawns nothing"))).toBe(true);
    // Provenance: the list has two entries, so the winner is named even without `accounts`.
    expect(r.account).toBe("Local");
    expect(envelopeFrom(r, renderBriefing(r.struct), 0).account).toBe("Local");
    expect(spawnsIn(dir)).toEqual([]);
  });

  test("item 1 winning a two-entry list is named too; a single entry without accounts is not", async () => {
    freshStateDir();
    const dir = tempDir("dba-winner-");
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" }, fallbacks: [{ label: "Local", api: loopbackApi("http://127.0.0.1:9") }] } as unknown as Config;
    expect((await runCore(cfg, walkDeps())).account).toBe("default");
    expect((await runCore({ repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" } } as Config, walkDeps())).account).toBeUndefined();
  });

  test("the grouper reuses the WINNER's instance: one construction, B's request goes to the winner's endpoint", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-winner-");
    const main = busyReply(busy, 16);
    const s = await startFakeApi((req) => chat(req.bodyText.includes("This is the recap-grouping step") ? JSON.stringify({ campaigns: [] }) : main)(req));
    servers.push(s);
    benchItem1(d, "default");
    const cfg = busyCfg(busy, { recapCampaigns: { mode: "trial" }, provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" }, fallbacks: [{ label: "Local", timeoutMs: 7_000, api: loopbackApi(s.origin) }] });
    const records: RecapRecordV2[] = [];
    const deps: RunDeps = { ...walkDeps(), persistHealth: async () => {}, persistRecapRecord: async (line) => { records.push(JSON.parse(line)); } };
    const built = spyOn(factory, "buildProvider");
    const oErr = console.error;
    console.error = () => {};
    let constructions = -1;
    try { await runCore(cfg, deps, true); constructions = built.mock.calls.length; }
    finally { console.error = oErr; built.mockRestore(); }   // (read the count first: mockRestore clears it)
    expect(constructions).toBe(1);
    expect(s.requests).toHaveLength(2);
    expect(s.requests[1]!.bodyText).toContain("This is the recap-grouping step");
    expect(records.map((r) => r.outcome)).toEqual(["none"]);
    expect(spawnsIn(dir)).toEqual([]);
  }, 60_000);

  test("the grouper gets the WINNER's timeout, not item 1's (P1-M6 checkpoint LOW)", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-winner-");
    const main = busyReply(busy, 16);
    const s = await startFakeApi((req) => chat(req.bodyText.includes("This is the recap-grouping step") ? JSON.stringify({ campaigns: [] }) : main)(req));
    servers.push(s);
    benchItem1(d, "default");
    const cfg = busyCfg(busy, { recapCampaigns: { mode: "trial" }, provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin", timeoutMs: 120_000 }, fallbacks: [{ label: "Local", timeoutMs: 7_000, api: loopbackApi(s.origin) }] });
    const phase = spyOn(recapPhase, "runRecapCampaignsPhase");
    const oErr = console.error;
    console.error = () => {};
    let seen: number | undefined;
    try {
      await runCore(cfg, { ...walkDeps(), persistHealth: async () => {}, persistRecapRecord: async () => {} } as RunDeps, true);
      seen = (phase.mock.calls[0]?.[0] as { timeoutMs?: number } | undefined)?.timeoutMs;
    } finally { console.error = oErr; phase.mockRestore(); }
    expect(seen).toBe(7_000);
  }, 60_000);
});

describe("transcripts follow the winner", () => {
  const scanned: string[] = [];
  const scan = (async (o: { window: { startUtc: string; endUtc: string } }): Promise<ScanOutcome> => { scanned.push("ran"); return { evidence: emptyEvidence(o.window), degraded: [] }; }) as unknown as RunDeps["scan"];

  test("the scan starts if ANY entry is claude-shaped; its evidence is kept only when the winner is", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-winner-");
    const s = await startFakeApi(chat(BRIEFING)); servers.push(s);
    // Item 1 is a claude-named CLI, benched: the API fallback wins.
    benchItem1(d, "default");
    const cfg = { repos: [repo], transcripts: { enabled: true }, provider: { cli: fakeCli(dir, "claude"), argv: [], promptVia: "stdin" }, fallbacks: [{ label: "Local", api: loopbackApi(s.origin) }] } as unknown as Config;
    scanned.length = 0;
    const r = await runCore(cfg, walkDeps({ scan, persistHealth: async () => {} }));
    expect(scanned).toEqual(["ran"]);
    expect(r.transcripts).toBeUndefined();
    // The same list with the claude CLI winning keeps it.
    freshStateDir();
    scanned.length = 0;
    const r2 = await runCore(cfg, walkDeps({ scan, persistHealth: async () => {} }));
    expect(scanned).toEqual(["ran"]);
    expect(r2.transcripts).toBeDefined();
  });

  test("the not-a-Claude-CLI warning applies only to a non-Claude CLI WINNER", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-winner-");
    const s = await startFakeApi(chat(BRIEFING)); servers.push(s);
    const nonClaude = fakeCli(dir, "codexish");
    const warned = (r: { warnings: string[] }) => r.warnings.some((w) => w.includes("is not a Claude Code CLI"));
    // A non-Claude CLI item 1 that WINS a two-entry list: warned.
    const cliFirst = { repos: [repo], transcripts: { enabled: true }, provider: { cli: nonClaude, argv: [], promptVia: "stdin" }, fallbacks: [{ label: "Local", api: loopbackApi(s.origin) }] } as unknown as Config;
    expect(warned(await runCore(cliFirst, walkDeps({ scan, persistHealth: async () => {} })))).toBe(true);
    // The API fallback wins (item 1 benched): no CLI won, so no warning.
    benchItem1(d, "default");
    expect(warned(await runCore(cliFirst, walkDeps({ scan, persistHealth: async () => {} })))).toBe(false);
  });
});
