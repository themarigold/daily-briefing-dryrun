// test/walk.core.test.ts — the walk skeleton: step 0, per-entry builds, marks follow labels (provider-fallback plan
// P1-M6-T2; spec r9 §4–§5). Single-entry behaviour is pinned in test/legacy-identity.test.ts.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, afterEach, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { runCore } from "../src/core";
import { accountStatePath, loadAccountState, PROBE_MS } from "../src/account";
import type { Config } from "../src/types";
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
const inAnHour = () => new Date(Date.now() + PROBE_MS).toISOString();

/** Write marks into the current state folder. */
function marks(d: string, accounts: Record<string, { reason: string; isProbe?: boolean }>): void {
  mkdirSync(d, { recursive: true });
  const out: Record<string, unknown> = {};
  for (const [label, m] of Object.entries(accounts)) out[label] = { limitedUntil: inAnHour(), isProbe: m.isProbe ?? m.reason !== "usage", reason: m.reason };
  writeFileSync(accountStatePath(d), JSON.stringify({ accounts: out }));
}

function morning(mins: number): Date {
  const d = new Date();
  d.setHours(7, 20, 0, 0);
  return new Date(d.getTime() + mins * 60_000);
}

describe("step 0: the marks, before any gate", () => {
  test("every entry benched ends the run before any network wait", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-walkcore-");
    marks(d, { "Claude login 1": { reason: "usage" }, Local: { reason: "not-found" } });
    let probes = 0;
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin", accounts: [{ label: "Claude login 1" }] }, fallbacks: [{ label: "Local", api: loopbackApi("http://127.0.0.1:9") }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: async () => { probes++; return true; } }));
    // Usage plus an hour mark is step 7 row 3 "paused" since P1-M7-T2 (spec r9 §5 "A deliberate change"; it was
    // today's quiet `limited` skip). Still decided before any gate.
    expect(r.paused?.until).toBeDefined();
    expect(r.limited).toBeUndefined();
    expect(probes).toBe(0);
    expect(r.net).toBeNull();
    expect(spawnsIn(dir)).toEqual([]);
  });

  test("offline, a loopback entry after mark-benched entries is the leading eligible entry and runs", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-walkcore-");
    const s = await startFakeApi(chatOk()); servers.push(s);
    marks(d, { "Claude login 1": { reason: "usage" } });
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin", accounts: [{ label: "Claude login 1" }] }, fallbacks: [{ label: "Local", api: loopbackApi(s.origin) }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: async () => false, netGraceMs: 30, netPollMs: 10, now: () => morning(61) }));
    expect(r.rawText).toBe(BRIEFING);
    expect(s.requests).toHaveLength(1);
    expect(spawnsIn(dir)).toEqual([]);
  });

  test("a forced run skips a mark-benched entry to reach the first eligible one, with that login's own config dir", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-walkcore-");
    const cli = fakeCli(dir);
    marks(d, { A: { reason: "usage" } });
    const cfg = { repos: [repo], provider: { cli, argv: [], promptVia: "stdin", accounts: [{ label: "A", configDir: `${dir}/a` }, { label: "B", configDir: `${dir}/b` }] } } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: async () => false, netGraceMs: 30, netPollMs: 10 }), true);
    expect(r.rawText).toBe(BRIEFING);
    expect(spawnsIn(dir)).toEqual([`${dir}/b`]);
    expect(r.account).toBe("B");
  });
});

describe("marks follow labels", () => {
  test("a reorder never moves a mark onto another entry, and an hour mark on the NEW item 1 is ignored", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-walkcore-");
    const cli = fakeCli(dir);
    marks(d, { B: { reason: "auth" } });
    const order = (first: string, second: string) => ({ repos: [repo], provider: { cli, argv: [], promptVia: "stdin", accounts: [
      { label: first, configDir: `${dir}/${first.toLowerCase()}` }, { label: second, configDir: `${dir}/${second.toLowerCase()}` }] } } as unknown as Config);
    // A first: B's hour mark benches nothing that runs; A delivers.
    expect((await runCore(order("A", "B"), walkDeps())).account).toBe("A");
    let st = await loadAccountState(d);
    expect([st.accounts.A, st.accounts.B?.reason]).toEqual([undefined, "auth"]);   // still B's, and only B's
    // B moved to the top: its hour mark is ignored at read, so B runs (and its success clears it).
    expect((await runCore(order("B", "A"), walkDeps())).account).toBe("B");
    expect(spawnsIn(dir)).toEqual([`${dir}/a`, `${dir}/b`]);
    st = await loadAccountState(d);
    expect([st.accounts.A, st.accounts.B]).toEqual([undefined, undefined]);
  });

  test("a broken accounts list warns, item 1 runs as its implicit entry, and the walk reaches the fallbacks", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-walkcore-");
    const s = await startFakeApi(chatOk()); servers.push(s);
    marks(d, { default: { reason: "usage" } });              // item 1's implicit label is benched
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin", accounts: [{ label: "x" }, { label: "x" }] }, fallbacks: [{ label: "Local", api: loopbackApi(s.origin) }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps());
    expect(r.warnings.some((w) => w.endsWith("— account failover disabled"))).toBe(true);
    expect(r.rawText).toBe(BRIEFING);
    expect(s.requests).toHaveLength(1);
    expect(spawnsIn(dir)).toEqual([]);
  });
});
