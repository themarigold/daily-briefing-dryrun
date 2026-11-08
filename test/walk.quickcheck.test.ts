// test/walk.quickcheck.test.ts — quick-check mode after a failed day, and the walk's `provider-status.json` writes
// (provider-fallback plan P1-M7-T4; spec r9 §5 step 4 "Quick check after a failed day", Reporting; hub Q14, Q15, Q22).
//
// Real provider stack against fake CLIs (`claude`-named ones get the hardened provider and its ladder) and loopback
// servers. The status file is read back from the state folder; seeded records carry the entry's real revision.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, afterEach, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { runCore } from "../src/core";
import { accountStatePath, loadAccountState, PROBE_MS } from "../src/account";
import { localDateStr, providerStatusPath } from "../src/marker";
import { entryRevision, resolveProviderList } from "../src/providerList";
import { readProviderStatus, rowStatus, writeProviderStatus, type LabelRecord } from "../src/providerStatus";
import { ProviderError, type Config } from "../src/types";
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
const serve = async (h: Parameters<typeof startFakeApi>[0]) => { const s = await startFakeApi(h); servers.push(s); return s; };

const NOW = new Date();
const TODAY = localDateStr(NOW);
// Local-date arithmetic, not NOW − 24 h: on the autumn DST day that lands on the same local date (checkpoint LOW 11).
const YESTERDAY = localDateStr(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, 12));
const chatOk = () => okJson({ choices: [{ index: 0, message: { role: "assistant", content: BRIEFING }, finish_reason: "stop" }] });
const local = (label: string, origin: string) => ({ label, api: { kind: "openai-compatible", model: "llama3", baseUrl: `${origin}/v1` } });
/** A claude-named fake that fails FAST with no flag complaint: the hardened provider's ladder applies to it. */
const fastFail = (dir: string, name = "claude") => fakeCli(dir, name, "echo 'down' 1>&2; exit 1");
/** A claude-named fake that rejects an injected flag (so the hardened provider respawns it bare), then fails. */
const flagRejecting = (dir: string) => fakeCli(dir, "claude", `case " $* " in *" --strict-mcp-config "*) echo "error: unknown option '--strict-mcp-config'" 1>&2; exit 1;; esac
echo 'down' 1>&2; exit 1`);
const benchItem1 = (d: string) => {
  mkdirSync(d, { recursive: true });
  writeFileSync(accountStatePath(d), JSON.stringify({ accounts: { default: { limitedUntil: new Date(NOW.getTime() + PROBE_MS).toISOString(), isProbe: false, reason: "usage" } } }));
};
const revOf = (cfg: Config, label: string): string => entryRevision(resolveProviderList(cfg, homedir()).entries.find((e) => e.label === label)!);
const seedLatch = async (cfg: Config, label: string, over: Partial<{ localDate: string; revision: string }> = {}) => {
  const revision = revOf(cfg, label);
  const rec: LabelRecord = { revision, lastRun: { at: new Date(NOW.getTime() - 3600e3).toISOString(), revision, ok: false, reason: "cli-failure" },
    quickCheck: { localDate: TODAY, revision, ...over } };
  expect(await writeProviderStatus({ labels: { [label]: rec } })).toBe(true);
};
const statusOf = async (label: string) => (await readProviderStatus())?.labels[label];
function scriptedProbe(...answers: boolean[]) {
  const calls: number[] = [];
  return { calls, probe: async () => { calls.push(performance.now()); return answers[Math.min(calls.length - 1, answers.length - 1)]!; } };
}
const deps = (extra: Record<string, unknown> = {}) => walkDeps({ now: () => NOW, ...extra });
const sleepsOf = () => { const sleeps: number[] = []; return { sleeps, sleep: async (ms: number) => { sleeps.push(ms); } }; };

describe("the latch is set", () => {
  test("the last entry's retryable failure, then an ONLINE probe: latch set, lastRun failed, and step 7 decides (the aggregate)", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-qc-");
    benchItem1(d);
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Last", cli: fakeCli(dir, "fail-cli", "exit 1"), argv: [], promptVia: "stdin", harden: false }] } as unknown as Config;
    const p = scriptedProbe(true, true);
    const e = await runCore(cfg, deps({ netProbe: p.probe })).then(() => undefined, (x) => x as ProviderError);
    expect(e?.message.split("\n")[0]).toBe("1 provider failed — open Settings → Providers");
    expect(p.calls.length).toBe(2);                                   // walk start + the last entry's one probe round
    const rec = await statusOf("Last");
    expect(rec?.quickCheck).toEqual({ localDate: TODAY, revision: revOf(cfg, "Last") });
    expect([rec?.lastRun?.ok, rec?.lastRun?.reason]).toEqual([false, "cli-failure"]);
    expect(rec?.failingSince).toBeDefined();
  });

  test("…then an OFFLINE probe: no latch, no mark, no failed lastRun, and the quiet offline skip", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-qc-");
    benchItem1(d);
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Last", cli: fastFail(dir), argv: [], promptVia: "stdin", harden: false }] } as unknown as Config;
    const r = await runCore(cfg, deps({ netProbe: scriptedProbe(true, false).probe }));
    expect([r.offlineSkipped, r.skipReason]).toEqual([true, "offline"]);
    expect(await statusOf("Last")).toBeUndefined();
    expect((await loadAccountState(d)).accounts.Last).toBeUndefined();   // a Claude CLI's cli-failure would mark online
  });

  test("a forced run runs no such probe and sets no latch (its lastRun is still written)", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-qc-");
    benchItem1(d);
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Last", cli: fakeCli(dir, "fail-cli", "exit 1"), argv: [], promptVia: "stdin", harden: false }] } as unknown as Config;
    const p = scriptedProbe(true);
    await runCore(cfg, deps({ netProbe: p.probe }), true).catch(() => undefined);
    expect(p.calls.length).toBe(1);
    const rec = await statusOf("Last");
    expect(rec?.quickCheck).toBeUndefined();
    expect(rec?.lastRun?.ok).toBe(false);
  });

  test("a LOOPBACK last entry failing while offline: no probe, a failed lastRun, the latch (it counts as online), and provider-fail — never a quiet skip", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-qc-");
    benchItem1(d);
    let hitAt = Number.POSITIVE_INFINITY;
    const s = await serve(() => { hitAt = performance.now(); return new Response("{}", { status: 500, headers: { "content-type": "application/json" } }); });
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" }, fallbacks: [local("Local", s.origin)] } as unknown as Config;
    const p = scriptedProbe(false);
    const e = await runCore(cfg, deps({ netProbe: p.probe, netGraceMs: 20, netPollMs: 5 })).then(() => undefined, (x) => x as ProviderError);
    expect(e).toBeInstanceOf(ProviderError);                           // provider-fail, not an offline skip
    expect(s.requests.length).toBe(1);
    expect(p.calls.every((t) => t < hitAt)).toBe(true);                // every probe call was the walk-start gate's
    const rec = await statusOf("Local");
    expect([rec?.lastRun?.ok, rec?.lastRun?.reason]).toEqual([false, "unreachable"]);
    expect(rec?.quickCheck?.localDate).toBe(TODAY);
  });

  test("a single-entry config failing the same way: no probe, no latch, but its lastRun and failingSince are written (Q15)", async () => {
    freshStateDir();
    const dir = tempDir("dba-qc-");
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "fail-cli", "exit 1"), argv: [], promptVia: "stdin", harden: false } } as unknown as Config;
    const p = scriptedProbe(true);
    const e = await runCore(cfg, deps({ netProbe: p.probe })).then(() => undefined, (x) => x as ProviderError);
    expect(e?.code).toBe("nonzero-exit");
    expect(e?.attempts).toBeUndefined();                               // a single entry's own error, as today
    expect(p.calls.length).toBe(1);
    const rec = await statusOf("default");
    expect(rec?.quickCheck).toBeUndefined();
    expect(rec?.lastRun?.ok).toBe(false);
    expect(rec?.failingSince?.revision).toBe(revOf(cfg, "default"));
  });

  test("an earlier entry's offline re-check sets nothing and writes no failed lastRun", async () => {
    freshStateDir();
    const dir = tempDir("dba-qc-");
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "fail-cli", "exit 1"), argv: [], promptVia: "stdin", harden: false },
      fallbacks: [{ label: "Remote", cli: fakeCli(dir), argv: [], promptVia: "stdin" }] } as unknown as Config;
    const r = await runCore(cfg, deps({ netProbe: scriptedProbe(true, false).probe }));
    expect(r.skipReason).toBe("offline");
    expect(await statusOf("default")).toBeUndefined();
  });

  test("lastRun.at is the entry's own failure or success time (Q22), and a win clears failingSince", async () => {
    freshStateDir();
    const dir = tempDir("dba-qc-");
    const ok = await serve(chatOk());
    let t = NOW.getTime();
    const clock = () => new Date((t += 1000));
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "fail-cli", "exit 1"), argv: [], promptVia: "stdin", harden: false }, fallbacks: [local("Ok", ok.origin)] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ now: clock }));
    expect(r.account).toBe("Ok");
    const [a, b] = [await statusOf("default"), await statusOf("Ok")];
    expect(a?.lastRun?.ok).toBe(false);
    expect(b?.lastRun?.ok).toBe(true);
    expect(Date.parse(a!.lastRun!.at)).toBeLessThan(Date.parse(b!.lastRun!.at));
    expect(b?.failingSince).toBeUndefined();
  });
});

describe("in quick-check mode", () => {
  test("an earlier non-first entry: ONE try — no withEntryRetry wait, no ladder (control: the same entry without the latch)", async () => {
    for (const latched of [false, true]) {
      const d = freshStateDir();
      const dir = tempDir("dba-qc-");
      benchItem1(d);
      const ok = await serve(chatOk());
      const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "item1"), argv: [], promptVia: "stdin" },
        fallbacks: [{ label: "Mid", cli: fastFail(dir), argv: [], promptVia: "stdin" }, local("Ok", ok.origin)] } as unknown as Config;
      if (latched) await seedLatch(cfg, "Mid");
      const s = sleepsOf();
      const r = await runCore(cfg, deps({ sleep: s.sleep }));
      expect(r.account).toBe("Ok");
      // Unlatched: try + one retry + the two ladder rungs; latched: one try.
      expect(`${latched}: ${spawnsIn(dir).length} spawns, sleeps ${JSON.stringify(s.sleeps)}`).toBe(latched ? "true: 1 spawns, sleeps []" : "false: 4 spawns, sleeps [5000]");
    }
  });

  test("the LAST entry: one try, no withRetry schedule (control: today's [45 000, 90 000] and the rungs)", async () => {
    for (const latched of [false, true]) {
      const d = freshStateDir();
      const dir = tempDir("dba-qc-");
      benchItem1(d);
      const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "item1"), argv: [], promptVia: "stdin" },
        fallbacks: [{ label: "Last", cli: fastFail(dir), argv: [], promptVia: "stdin" }] } as unknown as Config;
      if (latched) await seedLatch(cfg, "Last");
      const s = sleepsOf();
      const { retryDelaysMs: _d, ...noSchedule } = deps({ sleep: s.sleep });
      await runCore(cfg, noSchedule).catch(() => undefined);
      expect(`${latched}: ${spawnsIn(dir).length} spawns, sleeps ${JSON.stringify(s.sleeps)}`).toBe(latched ? "true: 1 spawns, sleeps []" : "false: 5 spawns, sleeps [45000,90000]");
    }
  });

  test("the hardened provider's internal respawn still fires in the mode", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-qc-");
    benchItem1(d);
    const ok = await serve(chatOk());
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "item1"), argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Mid", cli: flagRejecting(dir), argv: [], promptVia: "stdin" }, local("Ok", ok.origin)] } as unknown as Config;
    await seedLatch(cfg, "Mid");
    const r = await runCore(cfg, deps());
    expect(r.account).toBe("Ok");
    expect(spawnsIn(dir).length).toBe(2);                               // the flagged spawn, then its bare respawn
  });

  test("a later auth failure KEEPS the mode", async () => {
    freshStateDir();
    const s401 = await serve(() => new Response(JSON.stringify({ error: { message: "no" } }), { status: 401, headers: { "content-type": "application/json" } }));
    const ok = await serve(chatOk());
    const cfg = { repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" }, fallbacks: [local("Key", s401.origin), local("Ok", ok.origin)] } as unknown as Config;
    await seedLatch(cfg, "Key");
    await runCore(cfg, deps());
    const rec = await statusOf("Key");
    expect(rec?.quickCheck).toEqual({ localDate: TODAY, revision: revOf(cfg, "Key") });
    expect(rec?.lastRun?.reason).toBe("auth");
  });

  test("cleared by an ok run, by a revision change, and by a new local date", async () => {
    // An ok run clears it.
    freshStateDir();
    const ok = await serve(chatOk());
    const cfgOk = { repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" }, fallbacks: [local("Ok", ok.origin)] } as unknown as Config;
    await seedLatch(cfgOk, "Ok");
    expect((await runCore(cfgOk, deps())).account).toBe("Ok");
    expect((await statusOf("Ok"))?.quickCheck).toBeUndefined();
    // A revision change, and a new local date: full retries again (the unlatched control's 4 spawns).
    for (const over of [{ revision: "an-older-revision" }, { localDate: YESTERDAY }]) {
      const d = freshStateDir();
      const dir = tempDir("dba-qc-");
      benchItem1(d);
      const ok2 = await serve(chatOk());
      const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "item1"), argv: [], promptVia: "stdin" },
        fallbacks: [{ label: "Mid", cli: fastFail(dir), argv: [], promptVia: "stdin" }, local("Ok", ok2.origin)] } as unknown as Config;
      await seedLatch(cfg, "Mid", over);
      await runCore(cfg, deps());
      expect(`${JSON.stringify(over)}: ${spawnsIn(dir).length}`).toBe(`${JSON.stringify(over)}: 4`);
    }
  });

  test("an unreadable status file means full retries", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-qc-");
    benchItem1(d);
    const ok = await serve(chatOk());
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "item1"), argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Mid", cli: fastFail(dir), argv: [], promptVia: "stdin" }, local("Ok", ok.origin)] } as unknown as Config;
    writeFileSync(providerStatusPath(), "{ not json");
    await runCore(cfg, deps());
    expect(spawnsIn(dir).length).toBe(4);
  });

  test("item 1 is never in the mode", async () => {
    freshStateDir();
    const dir = tempDir("dba-qc-");
    const ok = await serve(chatOk());
    const cfg = { repos: [repo], provider: { cli: fastFail(dir), argv: [], promptVia: "stdin" }, fallbacks: [local("Ok", ok.origin)] } as unknown as Config;
    await seedLatch(cfg, "default");
    const s = sleepsOf();
    await runCore(cfg, deps({ sleep: s.sleep }));
    expect([spawnsIn(dir).length, s.sleeps]).toEqual([4, [5000]]);
  });
});

describe("P1-M7 checkpoint: what sets no latch, and the single entry's unusable answer", () => {
  test("a NON-retryable failure (auth) followed by an online re-check sets no latch", async () => {
    const d = freshStateDir();
    benchItem1(d);
    const s401 = await serve(() => new Response(JSON.stringify({ error: { message: "no" } }), { status: 401, headers: { "content-type": "application/json" } }));
    const ok = await serve(chatOk());
    const cfg = { repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" }, fallbacks: [local("Key", s401.origin), local("Ok", ok.origin)] } as unknown as Config;
    expect((await runCore(cfg, deps())).account).toBe("Ok");
    const rec = await statusOf("Key");
    expect(rec?.lastRun?.reason).toBe("auth");
    expect(rec?.quickCheck).toBeUndefined();
  });

  test("item 1's retryable failure followed by an online re-check sets no latch", async () => {
    freshStateDir();
    const dir = tempDir("dba-qc-");
    const ok = await serve(chatOk());
    const cfg = { repos: [repo], provider: { cli: fastFail(dir), argv: [], promptVia: "stdin", harden: false }, fallbacks: [local("Ok", ok.origin)] } as unknown as Config;
    expect((await runCore(cfg, deps())).account).toBe("Ok");
    const rec = await statusOf("default");
    expect([rec?.lastRun?.ok, rec?.lastRun?.reason]).toEqual([false, "cli-failure"]);
    expect(rec?.quickCheck).toBeUndefined();
  });

  test("a single entry's headingless answer: attempts and status record unusable-answer, and the row reads not-working", async () => {
    freshStateDir();
    const dir = tempDir("dba-qc-");
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "prose-cli", "echo 'No briefing today.'"), argv: [], promptVia: "stdin" } } as unknown as Config;
    const r = await runCore(cfg, deps());
    expect(r.rawText).toContain("No briefing today.");               // main's parse-empty path, as today
    expect(r.attempts).toEqual([{ label: "default", kind: "cli", outcome: "failed", reason: "unusable-answer" }]);
    const rec = await statusOf("default");
    expect([rec?.lastRun?.ok, rec?.lastRun?.reason]).toEqual([false, "unusable-answer"]);
    expect(rowStatus({ label: "default", revision: revOf(cfg, "default") }, rec, [], NOW).kind).toBe("not-working");
    expect(spawnsIn(dir)).toEqual([""]);                             // no retry, no move-on
  });
});
