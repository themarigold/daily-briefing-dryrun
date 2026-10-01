import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// Tier B (Stage-2 recap campaigns), T4.6 — the WIRING pins, spec §5.4 (plan §7): P3 and P4.
//   P3: with no `deps.provider` and no `grouper`, the run OWNS an API provider pointed at the loopback
//       fake (`test/helpers/fakeApi.ts`, the `core.api-provider.test.ts` pattern) over a busy fixture:
//       mode `trial` → the fake receives exactly 2 requests, the second beginning with `PROMPT_HEADER`
//       and carrying B's bridging paragraph, from ONE `buildProvider` construction; mode `off` → exactly 1.
//   P4: `deps.provider` injected, no `grouper` → outcome `skipped`, reason `no-grouper`, 1 provider call.
//
// ⚠ NOTHING IN THIS FILE MAY LEAVE THE MACHINE (plan K20): `guardNetworkForThisFile()` fails the file on
// any non-loopback `fetch`/`Bun.connect`; the API config's `baseUrl` is the fake's loopback origin and its
// key comes from the TEST variable `DBA_TEST_API_KEY` (set here, restored after); every run of this file
// goes through `env -u ANTHROPIC_API_KEY` (plan §1).
import { test, expect, describe, beforeAll, afterAll, afterEach, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCore, type RunDeps } from "../src/core";
import * as factory from "../src/providerFactory";
import { PROMPT_HEADER } from "../src/generator";
import { API_LABEL_ANTHROPIC, type Config } from "../src/types";
import type { RecapRecordV2 } from "../src/recapCampaigns";
import { startFakeApi, okJson, type FakeApi } from "./helpers/fakeApi";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { busyRepo, busyReply, busyCfg, type BusyRepo } from "./fixtures/recap-busy";

guardNetworkForThisFile();

const LONG = 60_000;
const B_PROMPT_MARK = "This is the recap-grouping step";
const KEY_VAR = "DBA_TEST_API_KEY";
const SENTINEL = "sk-ant-api03-TB46wiringSENTINEL-do-not-log-0000";

let busy: BusyRepo;
let stateDir = "";
let prevStateDir: string | undefined;
let prevKey: string | undefined;
const servers: FakeApi[] = [];

beforeAll(async () => {
  prevStateDir = process.env.DAILY_BRIEFING_STATE_DIR;
  stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tb46-wiring-state-")));
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;   // the OWNED path reaches account state
  prevKey = process.env[KEY_VAR];
  process.env[KEY_VAR] = SENTINEL;
  busy = await busyRepo(40);
}, LONG);

afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });

afterAll(() => {
  if (prevStateDir === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR;
  else process.env.DAILY_BRIEFING_STATE_DIR = prevStateDir;
  if (prevKey === undefined) delete process.env[KEY_VAR];
  else process.env[KEY_VAR] = prevKey;
});

/** The first message's content of a captured Anthropic request (`core.api-provider.test.ts:368`). */
const promptOf = (bodyText: string): string => {
  const body = JSON.parse(bodyText) as { messages: { content: string | { type: string; text: string }[] }[] };
  const c = body.messages[0]!.content;
  return typeof c === "string" ? c : c.map((p) => p.text).join("");
};

/** One owned-API run: the fake answers the MAIN prompt with the busy briefing and B's prompt with an
 *  empty campaign list. Returns the fake's requests, the record lines and the construction count. */
async function ownedRun(mode: "off" | "trial") {
  const main = busyReply(busy, 16);
  const s = await startFakeApi((req) => okJson({
    content: [{ type: "text", text: promptOf(req.bodyText).includes(B_PROMPT_MARK) ? JSON.stringify({ campaigns: [] }) : main }],
    stop_reason: "end_turn",
  })(req));
  servers.push(s);
  const cfg: Config = busyCfg(busy, {
    recapCampaigns: { mode },
    provider: {
      cli: API_LABEL_ANTHROPIC, argv: [], promptVia: "stdin", timeoutMs: 10_000,
      api: { kind: "anthropic", model: "claude-sonnet-5", baseUrl: s.origin, apiKeyEnv: KEY_VAR },
    },
  });
  const records: RecapRecordV2[] = [];
  const deps: RunDeps = {
    netProbe: async () => true, powerPlatform: "linux", sleep: async () => {}, retryDelaysMs: [],
    persistHealth: async () => {}, persistRecapRecord: async (line) => { records.push(JSON.parse(line)); },
  };
  const built = spyOn(factory, "buildProvider");
  const oErr = console.error;
  console.error = () => {};
  try {
    const r = await runCore(cfg, deps, true);
    return { r, main, requests: [...s.requests], records, constructions: built.mock.calls.length };
  } finally { console.error = oErr; built.mockRestore(); }
}

describe("[TB-P3] an OWNED API provider against the loopback fake", () => {
  test("[TB-P3] mode trial → exactly 2 requests (the second is B's, starting with PROMPT_HEADER) from ONE buildProvider construction", async () => {
    const x = await ownedRun("trial");
    expect(x.constructions).toBe(1);
    expect(x.requests).toHaveLength(2);
    for (const q of x.requests) expect(new URL(q.url).hostname).toBe("127.0.0.1");
    const [mainPrompt, bPrompt] = x.requests.map((q) => promptOf(q.bodyText));
    expect(mainPrompt!.startsWith(PROMPT_HEADER)).toBe(true);    // the main prompt starts with it too …
    expect(mainPrompt!).not.toContain(B_PROMPT_MARK);
    expect(bPrompt!.startsWith(PROMPT_HEADER)).toBe(true);       // … so B's is told apart by its bridge
    expect(bPrompt!).toContain(B_PROMPT_MARK);
    expect(x.records.map((r) => [r.outcome, r.reason, r.hardening])).toEqual([["none", null, "n/a"]]);
    // core.ts's slot: B's call goes through the run's provider, NEVER through `capturing` — so the
    // result's promptText/rawText are the MAIN call's (spec §4.2), and B's prompt/reply never reach them.
    expect(x.r.promptText).toBe(mainPrompt!);
    expect(x.r.rawText).toBe(x.main);
    expect(x.r.promptText).not.toContain(B_PROMPT_MARK);
  }, LONG);

  test("[TB-P3] mode off → exactly 1 request, no record", async () => {
    const x = await ownedRun("off");
    expect(x.constructions).toBe(1);
    expect(x.requests).toHaveLength(1);
    expect(promptOf(x.requests[0]!.bodyText)).not.toContain(B_PROMPT_MARK);
    expect(x.records).toEqual([]);
  }, LONG);
});

test("[TB-P4] deps.provider injected, no grouper → skipped, no-grouper, and the provider is called once", async () => {
  let calls = 0;
  const records: RecapRecordV2[] = [];
  const oErr = console.error;
  console.error = () => {};
  try {
    const r = await runCore(busyCfg(busy, { recapCampaigns: { mode: "trial" } }), {
      provider: { generate: async () => { calls++; return busyReply(busy, 16); } },
      netProbe: async () => true, persistHealth: async () => {},
      persistRecapRecord: async (line) => { records.push(JSON.parse(line)); },
    }, true);
    expect(r.emptyWindow).toBe(false);
  } finally { console.error = oErr; }
  expect(calls).toBe(1);
  expect(records.map((r) => [r.outcome, r.reason, r.gate])).toEqual([["skipped", "no-grouper", null]]);
}, LONG);
