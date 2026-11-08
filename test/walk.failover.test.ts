// test/walk.failover.test.ts — failure handling in the walk: classify, mark, re-check, retry, ladder, move on
// (provider-fallback plan P1-M7-T1; spec r9 §5 steps 4–5).
//
// Real provider stack against fake CLIs on disk and a fake HTTP server on 127.0.0.1. Every app-owned key command is
// built from SECURITY_BIN / APP_KEY_SERVICE and, except in the guard case (which uses the /nonexistent/bin
// look-alike), served by an injected keyExec — this file holds no literal naming the Keychain tool.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, afterEach, beforeAll, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { runCore } from "../src/core";
import * as factory from "../src/providerFactory";
import { accountStatePath, loadAccountState, PROBE_MS } from "../src/account";
import { APP_KEY_SERVICE, SECURITY_BIN } from "../src/providerList";
import { ProviderError, type Config } from "../src/types";
import { readProviderStatus } from "../src/providerStatus";
import type { RunOpts, RunResult } from "../src/proc";
import { takeGuardViolations } from "./fixtures/spawn-guard";
import { buildRepo } from "./fixtures/build-repo";
import { startFakeApi, okJson, status, type FakeApi } from "./helpers/fakeApi";
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

const chatOk = () => okJson({ choices: [{ index: 0, message: { role: "assistant", content: BRIEFING }, finish_reason: "stop" }] });
const local = (label: string, origin: string, extra: Record<string, unknown> = {}) => ({ label, api: { kind: "openai-compatible", model: "llama3", baseUrl: `${origin}/v1` }, ...extra });
const LIMIT = "You've hit your weekly limit · resets Aug 26 at 10pm (America/Los_Angeles)";
/** A claude-named fake that behaves per CLAUDE_CONFIG_DIR: `okDir` delivers, anything else runs `fail`. Tests that are
 *  not about the ladder set `harden: false`, so a fast failure never reaches the ladder's rungs. */
function perDirClaude(dir: string, okDir: string, fail = "echo 'boom' 1>&2; exit 1"): string {
  return fakeCli(dir, "claude", `if [ "$CLAUDE_CONFIG_DIR" = "${okDir}" ]; then printf '${BRIEFING.replace(/\n/g, "\\n")}'; exit 0; fi\n${fail}`);
}
/** A probe that answers from a script: walk start first, then each re-check. */
function scriptedProbe(...answers: boolean[]) {
  const calls: number[] = [];
  return { calls, probe: async () => { calls.push(Date.now()); return answers[Math.min(calls.length - 1, answers.length - 1)]!; } };
}
const marks = async (d: string) => (await loadAccountState(d)).accounts;
const benchUsage = (d: string, label: string) => {
  mkdirSync(d, { recursive: true });
  writeFileSync(accountStatePath(d), JSON.stringify({ accounts: { [label]: { limitedUntil: new Date(Date.now() + PROBE_MS).toISOString(), isProbe: false, reason: "usage" } } }));
};

describe("classify, mark, re-check, move on", () => {
  test("a usage wall is marked at once, before any re-check probe, and the walk moves on in the same tick", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-fo-");
    const cli = perDirClaude(dir, `${dir}/b`, `echo "${LIMIT}"; exit 1`);
    const p = scriptedProbe(true);
    const cfg = { repos: [repo], provider: { cli, argv: [], promptVia: "stdin", harden: false, accounts: [{ label: "A", configDir: `${dir}/a` }, { label: "B", configDir: `${dir}/b` }] } } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: p.probe }));
    expect(r.rawText).toBe(BRIEFING);
    expect(r.account).toBe("B");
    expect((await marks(d)).A?.reason).toBe("usage");
    expect(p.calls.length).toBe(1);                       // the walk-start probe only: usage is never re-checked
  });

  test("offline at the re-check: no mark is written (read back from disk), and the quiet offline skip follows", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-fo-");
    const cli = perDirClaude(dir, "/nowhere");               // every login fails (cli-failure)
    const p = scriptedProbe(true, true, false);              // start online; re-check after A online; after B offline
    const cfg = { repos: [repo], provider: { cli, argv: [], promptVia: "stdin", harden: false, accounts: [{ label: "A", configDir: `${dir}/a` }, { label: "B", configDir: `${dir}/b` }, { label: "C", configDir: `${dir}/c` }] } } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: p.probe, netGraceMs: 60_000 }));
    expect([r.offlineSkipped, r.skipReason]).toEqual([true, "offline"]);
    // A and B each get withEntryRetry's one retry (cli-failure is retryable and fast); C never runs.
    expect(spawnsIn(dir)).toEqual([`${dir}/a`, `${dir}/a`, `${dir}/b`, `${dir}/b`]);
    const m = await marks(d);
    expect(m.B).toBeUndefined();                             // offline at B's re-check: no mark
    expect(m.A).toBeUndefined();                             // A is item 1
    expect(p.calls.length).toBe(3);                          // one call per re-check, never the grace wait
  });

  test("online at the re-check: a non-first Claude login's cli-failure is hour-marked; a timeout on it is not (the narrower rule)", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-fo-");
    const cli = perDirClaude(dir, `${dir}/c`);
    const cfg = { repos: [repo], provider: { cli, argv: [], promptVia: "stdin", harden: false, accounts: [{ label: "A", configDir: `${dir}/a` }, { label: "B", configDir: `${dir}/b` }, { label: "C", configDir: `${dir}/c` }] } } as unknown as Config;
    const r = await runCore(cfg, walkDeps());
    expect(r.account).toBe("C");
    const m = await marks(d);
    expect([m.A, m.B?.reason]).toEqual([undefined, "cli-failure"]);
    // A timeout on login 2 writes no mark.
    const d2 = freshStateDir();
    const cli2 = perDirClaude(dir, `${dir}/c`, "exec sleep 5");
    const cfg2 = { repos: [repo], provider: { cli: cli2, argv: [], promptVia: "stdin", harden: false, timeoutMs: 300, accounts: [{ label: "A", configDir: `${dir}/a` }, { label: "B", configDir: `${dir}/b` }, { label: "C", configDir: `${dir}/c` }] } } as unknown as Config;
    const r2 = await runCore(cfg2, walkDeps());
    expect(r2.account).toBe("C");
    expect(await marks(d2)).toEqual({});
  }, 30_000);

  test("every ProviderError moves on; an unusable answer moves on with no retry and an hour mark when non-first", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-fo-");
    const s404 = await serve(status(404, { error: { message: "no such model" } }));
    const ok = await serve(chatOk());
    const prose = fakeCli(dir, "prose-cli", "echo 'I cannot write a briefing today.'");
    benchUsage(d, "default");
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" },
      fallbacks: [local("Missing", s404.origin), { label: "Prose", cli: prose, argv: [], promptVia: "stdin" }, local("Ok", ok.origin)] } as unknown as Config;
    const r = await runCore(cfg, walkDeps());
    expect(r.account).toBe("Ok");
    expect(spawnsIn(dir)).toEqual([""]);                     // the prose CLI ran ONCE: no retry for an unusable answer
    const m = await marks(d);
    expect([m.Missing?.reason, m.Prose?.reason]).toEqual(["not-found", "unusable-answer"]);
    expect(s404.requests).toHaveLength(1);                   // not-found is not retried
  });

  test("which reasons mark: `cli-failure` only on a Claude CLI, the `none` rows never, `auth` for an hour", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-fo-");
    const s500 = await serve(status(500, {})), s401 = await serve(status(401, { error: { message: "bad key" } }));
    const ok = await serve(chatOk());
    benchUsage(d, "default");
    const cfg = { repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" }, fallbacks: [
      { label: "Other", cli: fakeCli(dir, "other-cli", "echo 'down' 1>&2; exit 1"), argv: [], promptVia: "stdin", harden: false },
      local("Down", s500.origin), local("Auth", s401.origin), local("Ok", ok.origin)] } as unknown as Config;
    const r = await runCore(cfg, walkDeps());
    expect(r.account).toBe("Ok");
    const m = await marks(d);
    expect([m.Other, m.Down, m.Auth?.reason, m.Auth?.isProbe]).toEqual([undefined, undefined, "auth", true]);
  });

  test("the LAST entry's unusable answer: today's parse-empty path with its rawText, and an hour mark when not item 1", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-fo-");
    benchUsage(d, "default");
    const cfg = { repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Prose", cli: fakeCli(dir, "prose-cli", "echo 'No briefing today.'"), argv: [], promptVia: "stdin" }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps());
    expect(r.skipReason).toBeUndefined();
    expect(r.rawText).toContain("No briefing today.");      // main.ts's parse-empty gate reads this
    expect(spawnsIn(dir)).toEqual([""]);
    expect((await marks(d)).Prose?.reason).toBe("unusable-answer");
  });

  test("a non-ProviderError stops the run: the next entry is never tried", async () => {
    freshStateDir();
    const ok = await serve(chatOk());
    let calls = 0;
    const real = factory.buildProvider;
    const spy = spyOn(factory, "buildProvider").mockImplementation(((block: Config["provider"], opts: unknown) => {
      if (block.api === undefined) return { provider: { runtimeWarnings: [], generate: async () => { calls++; throw new TypeError("a bug"); } } };
      return real(block, opts as never);
    }) as never);
    try {
      const cfg = { repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" }, fallbacks: [local("Ok", ok.origin)] } as unknown as Config;
      await expect(runCore(cfg, walkDeps())).rejects.toBeInstanceOf(TypeError);
    } finally { spy.mockRestore(); }
    expect(calls).toBe(1);
    expect(ok.requests).toHaveLength(0);
  });

  test("a LOOPBACK earlier entry that fails is marked per the table and the walk moves on with NO probe call", async () => {
    const d = freshStateDir();
    const s401 = await serve(status(401, { error: { message: "bad key" } }));
    const ok = await serve(chatOk());
    benchUsage(d, "default");
    const p = scriptedProbe(true);
    const cfg = { repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" }, fallbacks: [local("Local", s401.origin), local("Ok", ok.origin)] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: p.probe }));
    expect(r.account).toBe("Ok");
    expect((await marks(d)).Local?.reason).toBe("auth");
    expect(p.calls.length).toBe(1);                          // walk start only
  });
});

describe("retries and the ladder", () => {
  test("the last entry keeps today's [45 000, 90 000]; an earlier entry gets one ~5 s retry", async () => {
    freshStateDir();
    const dir = tempDir("dba-fo-");
    const failing = fakeCli(dir, "fail-cli", "echo 'down' 1>&2; exit 1");
    const sleeps: number[] = [];
    const cfg = { repos: [repo], provider: { cli: failing, argv: [], promptVia: "stdin" }, fallbacks: [{ label: "Last", cli: failing, argv: [], promptVia: "stdin" }] } as unknown as Config;
    const { retryDelaysMs: _d, ...deps } = walkDeps({ sleep: async (ms: number) => { sleeps.push(ms); } });
    await expect(runCore(cfg, deps)).rejects.toBeInstanceOf(ProviderError);
    expect(sleeps).toEqual([5_000, 45_000, 90_000]);
  });

  test("a fallback's ladder gates on ITS timeout's failFastMs, never item 1's", async () => {
    // The last entry fails in ~300 ms. With its own 1 s timeout, failFastMs is 100 ms: too slow for the ladder (no
    // rungs). Item 1's 120 s timeout would give 5 s, and two more spawns.
    const d = freshStateDir();
    const dir = tempDir("dba-fo-");
    const slowFail = fakeCli(dir, "claude", "sleep 0.3; echo 'nope' 1>&2; exit 1");
    benchUsage(d, "default");
    const cfg = { repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin", timeoutMs: 120_000 },
      fallbacks: [{ label: "Last", cli: slowFail, argv: [], promptVia: "stdin", timeoutMs: 1_000 }] } as unknown as Config;
    await expect(runCore(cfg, walkDeps())).rejects.toBeInstanceOf(ProviderError);
    expect(spawnsIn(dir).length).toBe(1);
  });

  test("an earlier entry's ladder runs only after an online re-check (beforeRungs); offline skips both rungs", async () => {
    for (const [answer, expected] of [[false, 2], [true, 4]] as const) {
      freshStateDir();
      const dir = tempDir("dba-fo-");
      const ok = await serve(chatOk());
      const fastFail = fakeCli(dir, "claude", "echo 'unknown option' 1>&2; exit 2");
      const p = scriptedProbe(true, answer);                 // walk start, then the re-check (beforeRungs)
      const cfg = { repos: [repo], provider: { cli: fastFail, argv: [], promptVia: "stdin" }, fallbacks: [local("Ok", ok.origin)] } as unknown as Config;
      // Noon: past the morning time + 60 min, so an offline re-check still permits every loopback entry (M5).
      const r = await runCore(cfg, walkDeps({ netProbe: p.probe, now: () => { const x = new Date(); x.setHours(12, 0, 0, 0); return x; } }));
      expect(r.account).toBe("Ok");                          // offline: Ok is a loopback entry, so it still runs
      expect(`${answer}: ${spawnsIn(dir).length}`).toBe(`${answer}: ${expected}`);   // try + retry (+ the two rungs)
      // Offline before the rungs: walk start + that one re-check, reused for the move-on. Online: the rungs RAN, so the
      // move-on takes a FRESH probe (P1-M7 checkpoint) — at most two per entry.
      expect(p.calls.length).toBe(answer ? 3 : 2);
    }
  });

  test("the power probe runs once, at walk start — never mid-walk", async () => {
    freshStateDir();
    const dir = tempDir("dba-fo-");
    const ok = await serve(chatOk());
    let power = 0;
    const powerProbe = async () => { power++; return { code: 0, out: "Current System Capabilities are: CPU Graphics Audio Network" }; };
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "fail-cli", "exit 1"), argv: [], promptVia: "stdin", harden: false }, fallbacks: [local("Ok", ok.origin)] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ powerPlatform: "darwin", powerProbe }));
    expect(r.account).toBe("Ok");
    expect(power).toBe(1);
  });
});

describe("moved here from P1-M6: the cases that need move-on", () => {
  test("offline with several loopback entries: each is tried in turn, then the quiet skip", async () => {
    freshStateDir();
    const dir = tempDir("dba-fo-");
    const a = await serve(status(500, {})), b = await serve(status(500, {}));
    const cfg = { repos: [repo], provider: { api: { kind: "openai-compatible", model: "m", baseUrl: `${a.origin}/v1` }, cli: "openai-compatible", argv: [], promptVia: "stdin" },
      fallbacks: [local("B", b.origin), { label: "CLI", cli: fakeCli(dir), argv: [], promptVia: "stdin" }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: async () => false, netGraceMs: 30, netPollMs: 10 }));
    expect([r.offlineSkipped, r.skipReason]).toEqual([true, "offline"]);
    // Both are EARLIER entries (the CLI is the eligible list's last member): a 500 is retryable, so one retry each.
    expect([a.requests.length, b.requests.length]).toEqual([2, 2]);
    expect(spawnsIn(dir)).toEqual([]);
  });

  test("after floor + 60 min, offline: every loopback entry is tried in order, then the quiet skip", async () => {
    freshStateDir();
    const dir = tempDir("dba-fo-");
    const a = await serve(status(500, {})), b = await serve(status(500, {}));
    const morning = () => { const x = new Date(); x.setHours(8, 30, 0, 0); return x; };
    const cfg = { repos: [repo], morningTime: "07:20", provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" }, fallbacks: [local("A", a.origin), local("B", b.origin)] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: async () => false, netGraceMs: 30, netPollMs: 10, now: morning }));
    expect(r.skipReason).toBe("offline");
    // A is earlier (one retry); B is the eligible list's last member, so withRetry with no delays: one try.
    expect([a.requests.length, b.requests.length]).toEqual([2, 1]);
    expect(spawnsIn(dir)).toEqual([]);
  });

  test("a forced run walks past a failing entry to every eligible one", async () => {
    freshStateDir();
    const dir = tempDir("dba-fo-");
    const ok = await serve(chatOk());
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "fail-cli", "exit 1"), argv: [], promptVia: "stdin", harden: false }, fallbacks: [local("Ok", ok.origin)] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: async () => false, netGraceMs: 30, netPollMs: 10 }), true);
    expect(r.account).toBe("Ok");
    expect(spawnsIn(dir)).toEqual(["", ""]);                 // item 1 tried (and retried once), then the fallback
  });

  test("an app-owned key over non-loopback http on a later entry is refused, and the walk moves on", async () => {
    const d = freshStateDir();
    const ok = await serve(chatOk());
    benchUsage(d, "default");
    const calls: string[][] = [];
    const keyExec = async (argv: string[], _o?: RunOpts): Promise<RunResult> => { calls.push(argv); return { out: "k\n", err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false }; };
    const cfg = { repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Key", api: { kind: "anthropic", model: "m", baseUrl: "http://llm.example/v1", apiKeyCommand: [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-w"] } }, local("Ok", ok.origin)] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ keyExec }));
    expect(r.account).toBe("Ok");
    expect(calls).toEqual([]);
    expect((await marks(d)).Key).toBeUndefined();            // insecure-endpoint writes nothing
  });

  test("the sentinel: with [api key (fails), claude], the claude spawn's env has no ANTHROPIC_API_KEY and no key bytes", async () => {
    freshStateDir();
    const dir = tempDir("dba-fo-");
    const KEY = "sk-ant-api03-ZZwalkSENTINEL-0000";
    const s401 = await serve(status(401, { error: { message: "bad key" } }));
    const envDump = join(dir, "env.txt");
    const claude = fakeCli(dir, "claude", `env > '${envDump}'; printf '${BRIEFING.replace(/\n/g, "\\n")}'`);
    const keyExec = async (): Promise<RunResult> => ({ out: `${KEY}\n`, err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false });
    const cfg = { repos: [repo], provider: { api: { kind: "openai-compatible", model: "m", baseUrl: `${s401.origin}/v1`, apiKeyCommand: ["my-helper"] }, cli: "openai-compatible", argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Claude", cli: claude, argv: [], promptVia: "stdin" }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ keyExec }));
    expect(r.account).toBe("Claude");
    expect(s401.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);   // the premise: the key WAS resolved and sent
    const env = readFileSync(envDump, "utf8");
    expect(env).not.toContain("ANTHROPIC_API_KEY=");
    expect(env).not.toContain(KEY);
  });

  test("the guard case with a fallback: an unguarded app-owned key command is refused and recorded, and the fallback then succeeds", async () => {
    freshStateDir();
    const ok = await serve(chatOk());
    const LOOK = "/nonexistent/bin/" + basename(SECURITY_BIN);
    const cfg = { repos: [repo], provider: { api: { kind: "anthropic", model: "m", baseUrl: `${ok.origin}`, apiKeyCommand: [LOOK, "find-generic-password", "-s", APP_KEY_SERVICE, "-w"] }, cli: "anthropic-api", argv: [], promptVia: "stdin" },
      fallbacks: [local("Ok", ok.origin)] } as unknown as Config;
    const r = await runCore(cfg, walkDeps());                // NO keyExec
    expect(r.account).toBe("Ok");
    const seen = takeGuardViolations();
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain(JSON.stringify(LOOK));
    expect(existsSync(LOOK)).toBe(false);
  });
});

describe("P1-M7 checkpoint: re-check freshness, offline answers, the last entry", () => {
  test("a probe online BEFORE the rungs and offline AFTER them: no mark, no latch, no status record — the quiet skip", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-fo-");
    benchUsage(d, "default");
    const mid = fakeCli(dir, "claude", "echo 'down' 1>&2; exit 1");
    const p = scriptedProbe(true, true, false);                    // walk start, beforeRungs, the fresh post-rung probe
    const cfg = { repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Mid", cli: mid, argv: [], promptVia: "stdin" }, { label: "Remote", cli: fakeCli(dir, "remote-cli"), argv: [], promptVia: "stdin" }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: p.probe }));
    expect([r.offlineSkipped, r.skipReason]).toEqual([true, "offline"]);
    expect(spawnsIn(dir).length).toBe(4);                          // try + retry + both rungs; Remote never ran
    expect(p.calls.length).toBe(3);                                // at most two probe calls for the entry
    expect((await marks(d)).Mid).toBeUndefined();
    expect((await readProviderStatus())?.labels.Mid).toBeUndefined();
  });

  test("an earlier entry's UNUSABLE answer followed by an offline re-check: no mark and no status record", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-fo-");
    benchUsage(d, "default");
    const cfg = { repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Prose", cli: fakeCli(dir, "prose-cli", "echo 'No briefing today.'"), argv: [], promptVia: "stdin" },
        { label: "Remote", cli: fakeCli(dir, "remote-cli"), argv: [], promptVia: "stdin" }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ netProbe: scriptedProbe(true, false).probe }));
    expect(r.skipReason).toBe("offline");
    expect((await marks(d)).Prose).toBeUndefined();
    expect((await readProviderStatus())?.labels.Prose).toBeUndefined();
    // The offline result keeps `attempts` (P1-M7 checkpoint LOW 9).
    expect(r.attempts?.map((a) => [a.label, a.outcome])).toEqual([["default", "skipped-by-mark"], ["Prose", "failed"], ["Remote", "not-reached"]]);
  });

  test("the LAST entry's non-retryable failure runs no probe (deviation 4)", async () => {
    const d = freshStateDir();
    benchUsage(d, "default");
    const p = scriptedProbe(true);
    const cfg = { repos: [repo], provider: { cli: fakeCli(tempDir("dba-fo-")), argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Gone", cli: "/nonexistent/gone-cli", argv: [], promptVia: "stdin" }] } as unknown as Config;
    await expect(runCore(cfg, walkDeps({ netProbe: p.probe }))).rejects.toBeInstanceOf(ProviderError);
    expect(p.calls.length).toBe(1);
    expect((await marks(d)).Gone?.reason).toBe("not-installed");
  });

  // PR 1 final review round 3 pins (P1): hub Q2's other half, through runCore — a SINGLE entry keeps today's in-rung
  // swallow, so a bug in a rung ends the run with the original ProviderError (main.ts's provider-fail), never a crash.
  test("a non-ProviderError inside a SINGLE entry's rung is swallowed: the run ends with the original ProviderError", async () => {
    freshStateDir();
    let calls = 0;
    const original = new ProviderError("nonzero-exit", "fast failure"); original.durationMs = 1;
    const fake = {
      runtimeWarnings: [] as string[], hardeningActive: () => true, disableHardening: () => {},
      probeWithoutHardening: <T,>(fn: () => Promise<T>) => fn(),
      generate: async () => { calls++; if (calls === 1) throw original; throw new TypeError("a bug in a rung"); },
    };
    const real = factory.buildProvider;
    const spy = spyOn(factory, "buildProvider").mockImplementation(((block: Config["provider"], opts: unknown) =>
      block.cli === "/nonexistent/solo" ? { provider: fake, laddered: fake } : real(block, opts as never)) as never);
    try {
      const cfg = { repos: [repo], provider: { cli: "/nonexistent/solo", argv: [], promptVia: "stdin" } } as unknown as Config;
      const e = await runCore(cfg, walkDeps()).then(() => undefined, (x) => x);
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).message).toContain("fast failure");
    } finally { spy.mockRestore(); }
    expect(calls).toBe(3);                                         // the try, then both rungs (each threw the bug)
  });

  test("a non-ProviderError inside the LAST entry's rung stops the run, for a list of two or more", async () => {
    const d = freshStateDir();
    benchUsage(d, "default");
    let calls = 0;
    const fake = {
      runtimeWarnings: [] as string[], hardeningActive: () => true, disableHardening: () => {},
      probeWithoutHardening: <T,>(fn: () => Promise<T>) => fn(),
      generate: async () => {
        calls++;
        if (calls === 1) { const e = new ProviderError("nonzero-exit", "fast failure"); e.durationMs = 1; throw e; }
        throw new TypeError("a bug in a rung");
      },
    };
    const real = factory.buildProvider;
    const spy = spyOn(factory, "buildProvider").mockImplementation(((block: Config["provider"], opts: unknown) =>
      block.cli === "/nonexistent/last" ? { provider: fake, laddered: fake } : real(block, opts as never)) as never);
    try {
      const cfg = { repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" },
        fallbacks: [{ label: "Last", cli: "/nonexistent/last", argv: [], promptVia: "stdin" }] } as unknown as Config;
      await expect(runCore(cfg, walkDeps())).rejects.toBeInstanceOf(TypeError);
    } finally { spy.mockRestore(); }
    expect(calls).toBe(2);                                         // the try, then rung 1 — rung 2 never ran
  });
});

describe("P1-M7 checkpoint: the calendar-safe rewrite on the walk's error path", () => {
  const CAL_SNTL = "SNTLATTENDEE-Walk-agenda-0002";
  const calendar = async () => ({
    struct: { events: [], sources: [{ id: "work", kind: "link" as const, status: "ok" as const }], incomplete: false },
    promptBlocks: { locked: `TODAY'S CALENDAR\n- 10:00 Planning with ${CAL_SNTL}`, unlocked: `TODAY'S CALENDAR\n- 10:00 Planning with ${CAL_SNTL}` },
    skipOffline: false,
  });
  const echoing = () => (req: { bodyText: string }) => {
    const at = req.bodyText.indexOf(CAL_SNTL);
    const echo = at >= 0 ? req.bodyText.slice(at, at + 80) : `ECHO-MARKER ${req.bodyText.slice(0, 40)}`;
    return new Response(JSON.stringify({ error: { message: `rejected prompt near: ${echo}` } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  const calCfg = { enabled: true, links: [{ id: "work", urlEnv: "UNUSED_CAL_URL" }] };

  test("single entry (owned): the thrown message names the kind and status, never the echoed attendee", async () => {
    freshStateDir();
    const s = await serve(echoing());
    const cfg = { repos: [repo], calendar: calCfg, provider: { api: { kind: "openai-compatible", model: "m", baseUrl: `${s.origin}/v1` }, cli: "openai-compatible", argv: [], promptVia: "stdin" } } as unknown as Config;
    const e = await runCore(cfg, walkDeps({ calendar })).then(() => undefined, (x) => x as ProviderError);
    expect(s.requests[0]!.bodyText).toContain(CAL_SNTL);            // the premise: the request carried the block
    expect(e).toBeInstanceOf(ProviderError);
    expect(e!.message).not.toContain(CAL_SNTL);
    expect(e!.message).toContain("HTTP 400");
  });

  test("the walk: neither the aggregate message nor any entry's diagnostic carries the echoed attendee", async () => {
    freshStateDir();
    const a = await serve(echoing()), b = await serve(echoing());
    const cfg = { repos: [repo], calendar: calCfg, provider: { api: { kind: "openai-compatible", model: "m", baseUrl: `${a.origin}/v1` }, cli: "openai-compatible", argv: [], promptVia: "stdin" },
      fallbacks: [local("B", b.origin)] } as unknown as Config;
    const e = await runCore(cfg, walkDeps({ calendar })).then(() => undefined, (x) => x as ProviderError);
    expect(a.requests[0]!.bodyText).toContain(CAL_SNTL);
    expect(e?.attempts?.length).toBe(2);
    expect(e!.message).not.toContain(CAL_SNTL);
    expect(e!.diagnostics?.length).toBe(2);
    expect(JSON.stringify(e!.diagnostics)).not.toContain(CAL_SNTL);
    expect(JSON.stringify(e!.diagnostics)).toContain("HTTP 400");
  });
});

describe("PR 1 final review round 1 M5: after a mid-walk offline re-check, only PERMITTED loopback entries run", () => {
  test("before the morning time + 60 min a later loopback entry is not permitted (not leading); after it, it runs", async () => {
    for (const [hour, expectRun] of [[7, false], [12, true]] as const) {
      freshStateDir();
      const dir = tempDir("dba-fo-");
      const ok = await serve(chatOk());
      const at = () => { const x = new Date(); x.setHours(hour, 40, 0, 0); return x; };
      const cfg = { repos: [repo], morningTime: "07:20", provider: { cli: fakeCli(dir, "fail-cli", "exit 1"), argv: [], promptVia: "stdin", harden: false },
        fallbacks: [local("Local", ok.origin)] } as unknown as Config;
      const r = await runCore(cfg, walkDeps({ netProbe: scriptedProbe(true, false).probe, now: at }));
      expect(`${hour}: ${ok.requests.length}`).toBe(`${hour}: ${expectRun ? 1 : 0}`);
      expect(`${hour}: ${r.skipReason ?? r.account}`).toBe(`${hour}: ${expectRun ? "Local" : "offline"}`);
    }
  });
});

describe("PR 1 final review round 3: the unusable-answer branches and the offline rule's boundary", () => {
  test("L10: the last entry's unusable answer builds NO notices (nor a cost line) — nothing was delivered", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-fo-");
    benchUsage(d, "default");
    const remote = await serve(okJson({ choices: [{ index: 0, message: { role: "assistant", content: "No briefing today." }, finish_reason: "stop" }] }));
    for (const last of [
      { label: "Prose", cli: fakeCli(dir, "prose-cli", "echo 'No briefing today.'"), argv: [], promptVia: "stdin", credential: "env-api-key" },
      { label: "Remote", api: { kind: "openai-compatible", model: "m", baseUrl: `${remote.origin}/v1` } },
    ]) {
      const cfg = { repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" }, fallbacks: [last] } as unknown as Config;
      const r = await runCore(cfg, walkDeps());
      expect(r.rawText).toContain("No briefing today.");                       // the premise: row 2, the parse-empty path
      expect(`${last.label}: ${"notices" in r.struct}`).toBe(`${last.label}: false`);
    }
  });

  test("L11: an EARLIER entry's unusable answer then an offline re-check — the later loopback entry runs from the morning time + 60 min", async () => {
    for (const [hour, expectRun] of [[7, false], [12, true]] as const) {
      freshStateDir();
      const dir = tempDir("dba-fo-");
      const ok = await serve(chatOk());
      const at = () => { const x = new Date(); x.setHours(hour, 40, 0, 0); return x; };
      const cfg = { repos: [repo], morningTime: "07:20", provider: { cli: fakeCli(dir, "prose-cli", "echo 'No briefing today.'"), argv: [], promptVia: "stdin", harden: false },
        fallbacks: [local("Local", ok.origin)] } as unknown as Config;
      const r = await runCore(cfg, walkDeps({ netProbe: scriptedProbe(true, false).probe, now: at }));
      expect(`${hour}: ${ok.requests.length}`).toBe(`${hour}: ${expectRun ? 1 : 0}`);
      expect(`${hour}: ${r.skipReason ?? r.account}`).toBe(`${hour}: ${expectRun ? "Local" : "offline"}`);
    }
  });

  test("L13: permittedEntries — at the morning time + 60 min every loopback entry runs; at + 59 only the leading ones", async () => {
    const { permittedEntries } = await import("../src/core");
    const list = [{ id: "L1", isLoopback: true }, { id: "R", isLoopback: false }, { id: "L2", isLoopback: true }];
    const floor = 7 * 60 + 20;
    expect(permittedEntries(list, false, false, floor + 60, floor).map((e) => e.id)).toEqual(["L1", "L2"]);
    expect(permittedEntries(list, false, false, floor + 59, floor).map((e) => e.id)).toEqual(["L1"]);
  });
});
