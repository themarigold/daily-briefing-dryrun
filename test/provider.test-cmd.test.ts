// test/provider.test-cmd.test.ts — `provider test --file <candidate.json> --index <n> --json` (provider-fallback plan
// P2-M4-T1 and T2; spec r9 §6 "provider test", §5 step 4 "Insecure endpoint", §5 Reporting "Row status").
//
// The command builds entry n of a CANDIDATE config, applies the `insecure-endpoint` rule BEFORE the key is read, reads
// the key exactly as a morning run would, and sends ONE request in the entry's production dialect — Anthropic with a
// small `max_tokens`, OpenAI-compatible with none unless the entry sets one — accepting ANY parsed 2xx before content
// extraction ("key accepted"). A failure is classified by `failoverReason`. Production `generate` is unchanged.
// A CLI entry runs its own production invocation with only the prompt replaced (a Codex `["exec"]` entry runs `exec`),
// against a FAKE CLI on disk — never the real `claude` or `codex`, never a real login folder. The outcome is applied
// under the run lock: a pass clears hour-class marks only and the quick-check latch; a failure records `lastTest` and
// `failingSince` and writes no mark; an unrecorded outcome says why (`notRecorded`).
//
// ⚠ NOTHING HERE REACHES THE NETWORK OR A KEYCHAIN. Every request goes to a fake server on 127.0.0.1 (netGuard enforces
// it); a "remote" entry is reached through an injected `fetchImpl` that rewrites its origin to the fake's. Every
// app-owned key command is answered by an injected `keyExec`; its argv comes from the exported constants, so this file
// names no forbidden binary and needs no REACH_CONDITIONAL entry.
import "./fixtures/isolate-state";
import { test, expect, describe, afterEach, afterAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_PROBE_SETTLE_MS, providerMain, probeDeadlineMs, probeTimeoutMs, PROBE_LOOPBACK_MAX_TIMEOUT_MS, PROBE_REMOTE_TIMEOUT_MS,
  TEST_CONFIG_READS_MS, TEST_LOCK_RETRY_MS, TEST_PROMPT, type ProviderCliDeps,
} from "../src/providerCli";
import { AnthropicApiProvider, ANTHROPIC_PROBE_MAX_TOKENS } from "../src/providers/anthropic";
import { OpenAiCompatibleProvider } from "../src/providers/openaiCompatible";
import { APP_KEY_SERVICE, SECURITY_BIN, entryRevision, resolveProviderList, type ListEntry } from "../src/providerList";
import { validateConfig } from "../src/config";
import { observeRun, readProviderStatus, rowStatus, writeProviderStatus, type LabelRecord } from "../src/providerStatus";
import { accountStatePath, PROBE_MS } from "../src/account";
import { localDateStr, providerStatusPath } from "../src/marker";
import { acquireRunLock, lockStaleMs, runLockPath, type LockHeld } from "../src/runlock";
import { ProviderError, type ProviderApi } from "../src/types";
import type { RunOpts, RunResult } from "../src/proc";
import { startFakeApi, okJson, status, badJson, slow, type FakeApiHandler } from "./helpers/fakeApi";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { freshStateDir, tempDir } from "./helpers/walk";
import { ASYNC_FS, type AsyncFsOps } from "../src/strictFile";

guardNetworkForThisFile();

const KEY = "sk-ant-api03-PROBEsentinelKEYvalue-do-not-print-0000";
/** A label that is itself key-shaped: it must never reach the output either (hub Q25). */
const LABEL = "sk-proj-LABELsentinelVALUE0123456789abcdef";

const servers: { stop(): Promise<void> }[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });
const serve = async (h: FakeApiHandler) => { const s = await startFakeApi(h); servers.push(s); return s; };

const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
afterAll(() => { if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState; });

/** An app-owned key command, from the exported constants (never a literal binary name). */
const APP_ARGV = [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-a", "k-0123456789ab", "-w", "/nonexistent/scratch.keychain-db"];
/** The key exec a test injects: records every argv, answers `KEY`. */
const okExec = (calls: string[][]) => async (argv: string[], _o?: RunOpts): Promise<RunResult> => {
  calls.push(argv);
  return { out: `${KEY}\n`, err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false };
};

/** Item 1 is a CLI that is never touched; the entry under test is `fallbacks[0]`, index 1. */
const ITEM1 = { cli: "/nonexistent/item-one", argv: [], promptVia: "stdin" };
const candidate = (api: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ repos: [], provider: ITEM1, fallbacks: [{ label: LABEL, api, ...extra }] });

async function testCmd(cand: Record<string, unknown>, deps: ProviderCliDeps = {}, index = 1) {
  const file = join(tempDir("dba-testcmd-"), "candidate.json");
  writeFileSync(file, JSON.stringify(cand));
  const out: string[] = [], err: string[] = [];
  const code = await providerMain(["test", "--file", file, "--index", String(index), "--json"], {
    configFile: join(tempDir("dba-testcmd-saved-"), "config.json"), env: {}, isTTY: false,
    out: (s) => out.push(s), err: (s) => err.push(s), ...deps,
  });
  return { code, out: out.join("\n"), err: err.join("\n"), json: JSON.parse(out.at(-1) ?? "null") as Record<string, unknown> | null };
}
const bodyOf = (s: { requests: { bodyText: string }[] }, i = 0) => JSON.parse(s.requests[i]!.bodyText) as Record<string, unknown>;

// ── the dialects ─────────────────────────────────────────────────────────────────────────────────────

describe("provider test: one request in the entry's production dialect", () => {
  test("Anthropic: the production body with a SMALL max_tokens, the key read as a morning run reads it, and a 2xx with no text content is accepted", async () => {
    freshStateDir();
    const s = await serve(okJson({ content: [], stop_reason: "max_tokens" }));
    const calls: string[][] = [];
    const r = await testCmd(candidate({ kind: "anthropic", model: "claude-x", baseUrl: s.origin, apiKeyCommand: APP_ARGV }), { keyExec: okExec(calls) });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ schemaVersion: 1, ok: true, passed: true, recorded: true });
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.path).toBe("/v1/messages");
    const body = bodyOf(s);
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model"]);
    expect(body.max_tokens).toBe(ANTHROPIC_PROBE_MAX_TOKENS);
    expect(ANTHROPIC_PROBE_MAX_TOKENS).toBeLessThanOrEqual(64);
    expect(body.messages).toEqual([{ role: "user", content: TEST_PROMPT }]);
    expect(s.requests[0]!.headers["x-api-key"]).toBe(KEY);                   // the key the exec answered, trimmed
    expect(calls).toEqual([APP_ARGV]);                                          // read once, through the injected exec
    // Recorded as a passing test, never with a key byte or the label's text in the output.
    expect((await readProviderStatus())?.labels[LABEL]?.lastTest).toMatchObject({ ok: true });
    for (const text of [r.out, r.err]) { expect(text).not.toContain(KEY); expect(text).not.toContain(LABEL); }
  });

  test("OpenAI-compatible: the production body with NO max_tokens, and a 2xx with no message content is accepted", async () => {
    freshStateDir();
    const s = await serve(okJson({ choices: [] }));
    const r = await testCmd(candidate({ kind: "openai-compatible", model: "llama", baseUrl: `${s.origin}/v1`, apiKeyEnv: "K" }), { env: { K: KEY } });
    expect(r.json).toMatchObject({ ok: true, passed: true });
    expect(s.requests[0]!.path).toBe("/v1/chat/completions");
    expect(Object.keys(bodyOf(s)).sort()).toEqual(["messages", "model"]);
    expect(bodyOf(s).messages).toEqual([{ role: "user", content: TEST_PROMPT }]);
    expect(s.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  test("OpenAI-compatible: an entry that sets maxTokens sends it, as production does", async () => {
    freshStateDir();
    const s = await serve(okJson({ choices: [{ message: { content: "" }, finish_reason: "length" }] }));
    const r = await testCmd(candidate({ kind: "openai-compatible", model: "llama", baseUrl: `${s.origin}/v1`, maxTokens: 77 }));
    expect(r.json).toMatchObject({ passed: true });
    expect(bodyOf(s).max_tokens).toBe(77);
  });

  test("a remote entry's dialect too (reached through an injected fetchImpl): openai-compatible with no key fails as key-unavailable, sending nothing", async () => {
    freshStateDir();
    const s = await serve(okJson({ choices: [] }));
    const REMOTE = "https://llm.remote.invalid";
    const fetchImpl = ((u: string | URL | Request, init?: RequestInit) => fetch(String(u).replace(REMOTE, s.origin), init)) as typeof fetch;
    const noKey = await testCmd(candidate({ kind: "openai-compatible", model: "m", baseUrl: `${REMOTE}/v1` }), { fetchImpl });
    expect(noKey.json).toMatchObject({ passed: false, reason: "key-unavailable" });
    expect(s.requests).toHaveLength(0);
    const withKey = await testCmd(candidate({ kind: "openai-compatible", model: "m", baseUrl: `${REMOTE}/v1`, apiKeyEnv: "K" }), { fetchImpl, env: { K: KEY } });
    expect(withKey.json).toMatchObject({ passed: true });
    expect(s.requests).toHaveLength(1);
  });
});

// ── insecure-endpoint, before the key ────────────────────────────────────────────────────────────────

describe("provider test: the insecure-endpoint rule comes first", () => {
  test("an app-owned key over plain http to a non-loopback host fails as insecure-endpoint: the key is never read and no request is made", async () => {
    freshStateDir();
    const calls: string[][] = [];
    let fetched = 0;
    const fetchImpl = (async () => { fetched++; return new Response("{}"); }) as unknown as typeof fetch;
    for (const kind of ["anthropic", "openai-compatible"]) {
      const r = await testCmd(candidate({ kind, model: "m", baseUrl: "http://10.1.2.3:8080/v1", apiKeyCommand: APP_ARGV }), { keyExec: okExec(calls), fetchImpl });
      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ ok: true, passed: false, reason: "insecure-endpoint", recorded: true });
    }
    expect(calls).toEqual([]);
    expect(fetched).toBe(0);
    expect((await readProviderStatus())?.labels[LABEL]?.lastTest).toMatchObject({ ok: false, reason: "insecure-endpoint" });
  });

  test("the same http endpoint with a key that is NOT app-owned is tested (today's cleartext warning case, never refused)", async () => {
    freshStateDir();
    let fetched = 0;
    const fetchImpl = (async () => { fetched++; return new Response(JSON.stringify({ choices: [] }), { status: 200 }); }) as unknown as typeof fetch;
    const r = await testCmd(candidate({ kind: "openai-compatible", model: "m", baseUrl: "http://10.1.2.3:8080/v1", apiKeyEnv: "K" }), { env: { K: KEY }, fetchImpl });
    expect(r.json).toMatchObject({ passed: true });
    expect(fetched).toBe(1);
  });
});

// ── failures, through failoverReason ─────────────────────────────────────────────────────────────────

describe("provider test: each failure is classified by failoverReason", () => {
  const cases: [string, FakeApiHandler, string][] = [
    ["401", status(401, { error: { message: "invalid x-api-key" } }), "auth"],
    ["403", status(403, "forbidden"), "auth"],
    ["404", status(404, "no such model"), "not-found"],
    ["429 with a short retry-after", status(429, "slow down", { "retry-after": "5" }), "rate-limited"],
    ["400", status(400, { error: { message: "bad request" } }), "rejected-request"],
    ["500", status(500, "boom"), "unreachable"],
    ["a non-JSON 200", badJson(), "unreachable"],
  ];
  for (const [what, handler, reason] of cases) {
    test(`${what} → ${reason}`, async () => {
      freshStateDir();
      const s = await serve(handler);
      const r = await testCmd(candidate({ kind: "anthropic", model: "m", baseUrl: s.origin, apiKeyEnv: "K" }), { env: { K: KEY } });
      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ ok: true, passed: false, reason });
      expect(s.requests).toHaveLength(1);                                       // ONE request: a Test never retries
      for (const text of [r.out, r.err]) expect(text).not.toContain(KEY);
    });
  }

  test("a usage wall (429 with a spend-limit body) → usage", async () => {
    freshStateDir();
    const s = await serve(status(429, { error: { type: "rate_limit_error", message: "You have reached your specified API usage limits. You will regain access on 2099-01-01 at 00:00 UTC." } }));
    const r = await testCmd(candidate({ kind: "anthropic", model: "m", baseUrl: s.origin, apiKeyEnv: "K" }), { env: { K: KEY } });
    expect(r.json).toMatchObject({ passed: false, reason: "usage" });
  });

  test("no key at all (an unset variable) → key-unavailable, with no request", async () => {
    freshStateDir();
    const s = await serve(okJson({ content: [] }));
    const r = await testCmd(candidate({ kind: "anthropic", model: "m", baseUrl: s.origin, apiKeyEnv: "UNSET_VAR" }));
    expect(r.json).toMatchObject({ passed: false, reason: "key-unavailable" });
    expect(s.requests).toHaveLength(0);
  });

  test("a loopback entry's timeout is its OWN timeoutMs: a server slower than it → unreachable", async () => {
    freshStateDir();
    const s = await serve(slow(3_000, { content: [] }));
    const t0 = performance.now();
    const r = await testCmd(candidate({ kind: "anthropic", model: "m", baseUrl: s.origin, apiKeyEnv: "K" }, { timeoutMs: 300 }), { env: { K: KEY } });
    expect(r.json).toMatchObject({ passed: false, reason: "unreachable" });
    expect(performance.now() - t0).toBeLessThan(2_500);
  });

  test("a REMOTE entry's own short timeoutMs does not apply: the Test waits its 60 s, so a server slower than timeoutMs still passes", async () => {
    freshStateDir();
    const s = await serve(slow(800, { content: [] }));
    const REMOTE = "https://api.remote.invalid";
    const fetchImpl = ((u: string | URL | Request, init?: RequestInit) => fetch(String(u).replace(REMOTE, s.origin), init)) as typeof fetch;
    const r = await testCmd(candidate({ kind: "anthropic", model: "m", baseUrl: REMOTE, apiKeyEnv: "K" }, { timeoutMs: 100 }), { env: { K: KEY }, fetchImpl });
    expect(r.json).toMatchObject({ passed: true });
  });
});

// ── the timeout rule ─────────────────────────────────────────────────────────────────────────────────

test("timeouts: a remote entry gets 60 s, a loopback entry its own timeoutMs", () => {
  const list = resolveProviderList(validateConfig({
    repos: [], provider: ITEM1,
    fallbacks: [
      { label: "remote", api: { kind: "anthropic", model: "m", baseUrl: "https://api.example.com", apiKeyEnv: "K" }, timeoutMs: 999_000 },
      { label: "local", api: { kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:11434/v1" }, timeoutMs: 1_234_000 },
    ],
  }, "/nonexistent-home"), "/nonexistent-home", {});
  const by = (l: string): ListEntry => list.entries.find((e) => e.label === l)!;
  expect(PROBE_REMOTE_TIMEOUT_MS).toBe(60_000);
  expect(probeTimeoutMs(by("remote"))).toBe(60_000);
  expect(probeTimeoutMs(by("local"))).toBe(1_234_000);
  expect(probeTimeoutMs(by("default"))).toBe(60_000);                         // a CLI entry is remote
});

// The whole Test's deadline, pinned by literal numbers (never recomputed from the constants under test). Every other
// deadline test injects `testDeadlineMs`, so only this one reaches `probeDeadlineMs` (P2-M4 checkpoint LOW 2).
describe("the Test's deadline and the loopback cap (spec §6; plan Q12)", () => {
  const entries = (loopbackTimeoutMs: number) => {
    const list = resolveProviderList(validateConfig({
      repos: [], provider: ITEM1,
      fallbacks: [
        { label: "remote", api: { kind: "anthropic", model: "m", baseUrl: "https://api.example.com", apiKeyEnv: "K" }, timeoutMs: 999_000 },
        { label: "local", api: { kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:11434/v1" }, timeoutMs: loopbackTimeoutMs },
      ],
    }, "/nonexistent-home"), "/nonexistent-home", {});
    return (l: string): ListEntry => list.entries.find((e) => e.label === l)!;
  };

  test("remote API 66 000 (5 s key + 60 s + 1 s transport margin), CLI 60 000, loopback its timeoutMs + 6 000", () => {
    const by = entries(1_234_000);
    expect(probeDeadlineMs(by("remote"))).toBe(66_000);
    expect(probeDeadlineMs(by("default"))).toBe(60_000);                      // a CLI entry: the 60 s alone
    expect(probeDeadlineMs(by("local"))).toBe(1_240_000);
  });

  test("the loopback probe timeout is capped so the app's bound (probe + 17 s) stays under its 30-minute cap", () => {
    expect(PROBE_LOOPBACK_MAX_TIMEOUT_MS).toBe(1_783_000);                    // 30 min − 17 s
    expect(PROBE_LOOPBACK_MAX_TIMEOUT_MS + 17_000).toBeLessThanOrEqual(30 * 60_000);
    expect(probeTimeoutMs(entries(1_783_000)("local"))).toBe(1_783_000);      // at the cap: unchanged
    expect(probeTimeoutMs(entries(1_783_001)("local"))).toBe(1_783_000);      // past it: capped
    expect(probeDeadlineMs(entries(1_783_001)("local"))).toBe(1_789_000);
    expect(probeTimeoutMs(entries(4 * 3_600_000)("local"))).toBe(1_783_000);  // a hand-edited four hours
  });

  test("a timeoutMs past what a timer accepts (2**31 − 1) still yields a deadline a timer honours", () => {
    const by = entries(2 ** 31 + 5);
    expect(probeTimeoutMs(by("local"))).toBe(1_783_000);
    expect(probeDeadlineMs(by("local"))).toBe(1_789_000);
    expect(probeDeadlineMs(by("local"))).toBeLessThan(2 ** 31 - 1);
  });

  test("the candidate read and the post-probe saved-config read share ONE 500 ms budget (the doc's arithmetic counts it once)", () => {
    expect(TEST_CONFIG_READS_MS).toBe(500);
  });
});

// ── production is unchanged ──────────────────────────────────────────────────────────────────────────

describe("the transports' probe() beside production generate()", () => {
  const api = (kind: ProviderApi["kind"], origin: string): ProviderApi =>
    ({ kind, model: "m", baseUrl: kind === "anthropic" ? origin : `${origin}/v1`, apiKeyEnv: "K" });
  const NO_CONTENT: Record<ProviderApi["kind"], unknown> = { anthropic: { content: [], stop_reason: "end_turn" }, "openai-compatible": { choices: [] } };
  const mk = (kind: ProviderApi["kind"], origin: string) => kind === "anthropic"
    ? new AnthropicApiProvider(api(kind, origin), { timeoutMs: 5_000, env: { K: KEY } })
    : new OpenAiCompatibleProvider(api(kind, origin), { timeoutMs: 5_000, env: { K: KEY } });

  for (const kind of ["anthropic", "openai-compatible"] as const) {
    test(`${kind}: generate() against a no-content 2xx still throws empty-output; probe() against the same answer resolves`, async () => {
      const s = await serve(okJson(NO_CONTENT[kind]));
      const e = await mk(kind, s.origin).generate("prompt").then(() => undefined, (x) => x);
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).code).toBe("empty-output");
      await expect(mk(kind, s.origin).probe("prompt")).resolves.toBeUndefined();
    });

    test(`${kind}: probe() rejects with the same ProviderError a production request would`, async () => {
      const s = await serve(status(401, "nope"));
      const e = await mk(kind, s.origin).probe("prompt").then(() => undefined, (x) => x);
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).httpStatus).toBe(401);
      expect((e as ProviderError).durationMs).toBeGreaterThanOrEqual(0);
    });
  }

  test("anthropic: production generate() still sends the entry's own max_tokens (or the default), never the probe's", async () => {
    const s = await serve(okJson({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }));
    await mk("anthropic", s.origin).generate("prompt");
    expect(bodyOf(s).max_tokens).toBe(16_000);
    const p = new AnthropicApiProvider({ ...api("anthropic", s.origin), maxTokens: 900 }, { timeoutMs: 5_000, env: { K: KEY } });
    await p.generate("prompt");
    await p.probe("prompt");
    expect(bodyOf(s, 1).max_tokens).toBe(900);
    expect(bodyOf(s, 2).max_tokens).toBe(ANTHROPIC_PROBE_MAX_TOKENS);
  });

  test("probe() raises no truncation warning (a small max_tokens is the point, not a cut-off briefing)", async () => {
    const s = await serve(okJson({ content: [{ type: "text", text: "O" }], stop_reason: "max_tokens" }));
    const p = mk("anthropic", s.origin);
    await p.probe("prompt");
    expect(p.runtimeWarnings.some((w) => w.includes("output-token limit"))).toBe(false);
  });
});

// ══ P2-M4-T2: CLI entries, outcomes, marks and status ════════════════════════════════════════════════

/** A fake CLI on disk: logs its argv (one per line), its stdin and `$CLAUDE_CONFIG_DIR` beside it, then runs `body`.
 *  A `claude`-named fake answers the hardening `--help` probe (unlogged), as test/helpers/walk.ts's does. */
function fakeCliAt(dir: string, name: string, body = "printf 'OK'"): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh
case " $* " in *" --help "*) echo "--tools --setting-sources --strict-mcp-config"; exit 0;; esac
printf '%s\\n' "$@" > "${join(dir, "args.log")}"
echo "$CLAUDE_CONFIG_DIR" >> "${join(dir, "configdirs.log")}"
cat > "${join(dir, "stdin.log")}"
echo $$ > "${join(dir, "pid")}"
${body}
`, { mode: 0o755 });
  return p;
}
const logOf = (dir: string, f: string): string[] => existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").split("\n").slice(0, -1) : [];

const hourMark = (writtenAgoMs = 1_000) => ({ limitedUntil: new Date(Date.now() - writtenAgoMs + PROBE_MS).toISOString(), isProbe: true, reason: "auth" });
const usageMark = () => ({ limitedUntil: new Date(Date.now() + 3 * 3600e3).toISOString(), isProbe: false, reason: "usage" });
function writeMarks(dir: string, accounts: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(accountStatePath(dir), JSON.stringify({ accounts }));
}
const marksIn = (dir: string): Record<string, unknown> =>
  existsSync(accountStatePath(dir)) ? JSON.parse(readFileSync(accountStatePath(dir), "utf8")).accounts : {};
/** The revision `provider test` stamps for the entry with `label` in `cand`. */
const revisionIn = (cand: Record<string, unknown>, label: string): string =>
  entryRevision(resolveProviderList(validateConfig(cand, "/nonexistent-home"), "/nonexistent-home", {}).entries.find((e) => e.label === label)!);

describe("provider test: a CLI entry runs its own production invocation", () => {
  test("a Codex [\"exec\"] entry is tested AS exec: the fake receives exactly its argv, and the tiny prompt on stdin", async () => {
    freshStateDir();
    const dir = tempDir("dba-testcmd-cli-");
    const cand = { repos: [], provider: ITEM1, fallbacks: [{ label: LABEL, cli: fakeCliAt(dir, "codex"), argv: ["exec"], promptVia: "stdin" }] };
    const r = await testCmd(cand);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, passed: true, recorded: true });
    expect(logOf(dir, "args.log")).toEqual(["exec"]);
    expect(readFileSync(join(dir, "stdin.log"), "utf8")).toBe(TEST_PROMPT);
    for (const text of [r.out, r.err]) expect(text).not.toContain(LABEL);
  });

  test("promptVia arg: the tiny prompt is the last argv element, after the entry's own argv", async () => {
    freshStateDir();
    const dir = tempDir("dba-testcmd-cli-");
    const cand = { repos: [], provider: ITEM1, fallbacks: [{ label: LABEL, cli: fakeCliAt(dir, "codex"), argv: ["exec", "--skip-git-repo-check"], promptVia: "arg" }] };
    expect((await testCmd(cand)).json).toMatchObject({ passed: true });
    expect(logOf(dir, "args.log")).toEqual(["exec", "--skip-git-repo-check", TEST_PROMPT]);
  });

  test("a Claude login runs under ITS configDir (a per-spawn CLAUDE_CONFIG_DIR), as the walk runs it", async () => {
    freshStateDir();
    const dir = tempDir("dba-testcmd-cli-");
    const a = tempDir("dba-testcmd-login-a-"), b = tempDir("dba-testcmd-login-b-");
    const cand = { repos: [], provider: { cli: fakeCliAt(dir, "claude"), argv: ["-p"], promptVia: "stdin", accounts: [{ label: "A", configDir: a }, { label: "B", configDir: b }] } };
    const r = await testCmd(cand, {}, 1);
    expect(r.json).toMatchObject({ passed: true, recorded: true });
    expect(logOf(dir, "configdirs.log")).toEqual([b]);
    expect(logOf(dir, "args.log").at(-1)).toBe("-p");                          // the entry's argv, after any injected flags
    expect((await readProviderStatus())?.labels.B?.lastTest).toMatchObject({ ok: true, revision: revisionIn(cand, "B") });
    expect((await readProviderStatus())?.labels.A).toBeUndefined();
  });

  test("a CLI that is not installed → not-installed; one that answers nothing → empty-answer; one that exits nonzero → cli-failure", async () => {
    freshStateDir();
    const missing = await testCmd({ repos: [], provider: ITEM1, fallbacks: [{ label: LABEL, cli: "/nonexistent/bin/codex", argv: ["exec"], promptVia: "stdin" }] });
    expect(missing.json).toMatchObject({ ok: true, passed: false, reason: "not-installed" });
    const dir = tempDir("dba-testcmd-cli-");
    const empty = await testCmd({ repos: [], provider: ITEM1, fallbacks: [{ label: LABEL, cli: fakeCliAt(dir, "codex", "true"), argv: ["exec"], promptVia: "stdin" }] });
    expect(empty.json).toMatchObject({ passed: false, reason: "empty-answer" });
    const dir2 = tempDir("dba-testcmd-cli-");
    const bad = await testCmd({ repos: [], provider: ITEM1, fallbacks: [{ label: LABEL, cli: fakeCliAt(dir2, "codex", "echo nope >&2; exit 3"), argv: ["exec"], promptVia: "stdin" }] });
    expect(bad.json).toMatchObject({ passed: false, reason: "cli-failure" });
  });

  test("a CLI that never answers is cut at the Test's deadline (unreachable), and its direct child is killed before the answer", async () => {
    freshStateDir();
    const dir = tempDir("dba-testcmd-cli-");
    // It IGNORES SIGTERM (an ignored signal survives exec), so only the SIGKILL after KILL_GRACE_MS ends it: the answer
    // must wait that out rather than leave the direct child running past the engine's exit. (A descendant the CLI
    // backgrounds is NOT reached — the accepted residual, src/provider.ts:373 — so this fake `exec`s, never `&`s.)
    const cand = { repos: [], provider: ITEM1, fallbacks: [{ label: LABEL, cli: fakeCliAt(dir, "codex", "trap '' TERM; exec sleep 30"), argv: ["exec"], promptVia: "stdin" }] };
    const t0 = performance.now();
    const r = await testCmd(cand, { testDeadlineMs: 500 });
    expect(r.json).toMatchObject({ passed: false, reason: "unreachable" });
    expect(performance.now() - t0).toBeLessThan(500 + CLI_PROBE_SETTLE_MS + 1_000);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();                              // gone: no orphan left billing
  }, 20_000);
});

// PR 2 final harden round 3, M1: the morning `apiKeyFile` rung's key-folder test stats and walks on every `apiKeyFile`.
// It was synchronous, so a stat stalled on a dead mount blocked the event loop and the Test's deadline could not fire
// (reviewer A: 1812 ms for a 300 ms deadline). It runs on an async fs now; here that fs is held forever until released.
describe("provider test: a key-folder test stalled on a dead mount is cut at the deadline (final harden r3, M1)", () => {
  test("a user's own apiKeyFile whose stat never answers: unreachable at the deadline, and the abandoned read sends nothing", async () => {
    freshStateDir();
    const s = await serve(okJson({ content: [] }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let asked = 0;
    const keyFileFs = Object.fromEntries(Object.entries(ASYNC_FS).map(([op, f]) =>
      [op, async (p: string) => { asked++; await gate; return (f as (p: string) => Promise<unknown>)(p); }])) as AsyncFsOps;
    const own = join(tempDir("dba-testcmd-key-"), "user.key");
    writeFileSync(own, KEY);
    chmodSync(own, 0o600);
    const t0 = performance.now();
    const r = await testCmd(candidate({ kind: "anthropic", model: "claude-x", baseUrl: s.origin, apiKeyFile: own }), { testDeadlineMs: 300, keyFileFs });
    const elapsed = performance.now() - t0;
    expect(r.json).toMatchObject({ ok: true, passed: false, reason: "unreachable" });
    expect(elapsed).toBeLessThan(2_000);                       // the stall is unbounded: only the deadline ended it
    expect(asked).toBeGreaterThan(0);                          // and it was the injected fs that stalled
    release();
    await Bun.sleep(100);
    expect(s.requests).toHaveLength(0);                        // released after the abort: the request is never sent
    for (const text of [r.out, r.err]) expect(text).not.toContain(KEY);
  }, 10_000);
});

describe("provider test: the outcome, the marks and the row (spec r9 §5, §6)", () => {
  const okCli = (dir: string) => ({ repos: [], provider: ITEM1, fallbacks: [{ label: LABEL, cli: fakeCliAt(dir, "codex"), argv: ["exec"], promptVia: "stdin" }] });
  const badCli = (dir: string) => ({ repos: [], provider: ITEM1, fallbacks: [{ label: LABEL, cli: fakeCliAt(dir, "codex", "exit 3"), argv: ["exec"], promptVia: "stdin" }] });

  test("a pass clears the label's hour mark", async () => {
    const d = freshStateDir();
    writeMarks(d, { [LABEL]: hourMark() });
    const r = await testCmd(okCli(tempDir("dba-testcmd-cli-")));
    expect(r.json).toMatchObject({ passed: true, recorded: true });
    expect(marksIn(d)[LABEL]).toBeUndefined();
  });

  test("a pass never clears a usage mark, and never writes one", async () => {
    const d = freshStateDir();
    writeMarks(d, { [LABEL]: usageMark() });
    const before = readFileSync(accountStatePath(d), "utf8");
    expect((await testCmd(okCli(tempDir("dba-testcmd-cli-")))).json).toMatchObject({ passed: true, recorded: true });
    expect(readFileSync(accountStatePath(d), "utf8")).toBe(before);
  });

  test("a failure records lastTest failed with its reason, sets failingSince, writes NO mark — and the row reads \"not working since\"", async () => {
    const d = freshStateDir();
    const cand = badCli(tempDir("dba-testcmd-cli-"));
    const r = await testCmd(cand);
    expect(r.json).toMatchObject({ passed: false, reason: "cli-failure", recorded: true });
    const rec = (await readProviderStatus())!.labels[LABEL]!;
    expect(rec.lastTest).toMatchObject({ ok: false, reason: "cli-failure", at: r.json!.at, revision: revisionIn(cand, LABEL) });
    expect(rec.failingSince).toEqual({ at: r.json!.at as string, revision: revisionIn(cand, LABEL) });
    expect(existsSync(accountStatePath(d))).toBe(false);                       // no mark, not even an empty file
    expect(rowStatus({ label: LABEL, revision: revisionIn(cand, LABEL) }, rec, [], new Date())).toEqual({ kind: "not-working", since: r.json!.at as string, reason: "cli-failure" });
  });

  test("a failure never clears an hour mark either (only a pass clears one)", async () => {
    const d = freshStateDir();
    writeMarks(d, { [LABEL]: hourMark() });
    const before = readFileSync(accountStatePath(d), "utf8");
    expect((await testCmd(badCli(tempDir("dba-testcmd-cli-")))).json).toMatchObject({ passed: false, recorded: true });
    expect(readFileSync(accountStatePath(d), "utf8")).toBe(before);
  });

  test("the row follows the NEWEST matching-revision observation across a run and a test", async () => {
    freshStateDir();
    const dir = tempDir("dba-testcmd-cli-");
    const cand = okCli(dir);
    const rev = revisionIn(cand, LABEL);
    // An older failed RUN, then a passing Test: the Test is newer, so "key accepted" and no failingSince.
    const failedRun = observeRun(undefined, { at: new Date(Date.now() - 600_000).toISOString(), revision: rev, ok: false, reason: "auth" });
    expect(failedRun.failingSince).toBeDefined();
    await writeProviderStatus({ labels: { [LABEL]: failedRun } });
    const pass = await testCmd(cand);
    let rec = (await readProviderStatus())!.labels[LABEL]!;
    expect(rowStatus({ label: LABEL, revision: rev }, rec, [], new Date())).toEqual({ kind: "key-accepted", at: pass.json!.at as string });
    expect(rec.failingSince).toBeUndefined();
    // A NEWER ok run after it: "working".
    const runAt = new Date(Date.parse(pass.json!.at as string) + 1).toISOString();
    await writeProviderStatus({ labels: { [LABEL]: observeRun(rec, { at: runAt, revision: rev, ok: true }) } });
    rec = (await readProviderStatus())!.labels[LABEL]!;
    expect(rowStatus({ label: LABEL, revision: rev }, rec, [], new Date(Date.parse(runAt) + 1))).toEqual({ kind: "working", at: runAt });
    // Then a failing Test of the same revision, newer still: "not working since" the Test.
    writeFileSync(join(dir, "codex"), readFileSync(join(dir, "codex"), "utf8").replace("printf 'OK'", "exit 3"));
    chmodSync(join(dir, "codex"), 0o755);
    const fail = await testCmd(cand);
    expect(Date.parse(fail.json!.at as string)).toBeGreaterThan(Date.parse(runAt));
    rec = (await readProviderStatus())!.labels[LABEL]!;
    expect(rowStatus({ label: LABEL, revision: rev }, rec, [], new Date())).toEqual({ kind: "not-working", since: fail.json!.at as string, reason: "cli-failure" });
  });

  test("a pass clears the quick-check latch at its revision", async () => {
    freshStateDir();
    const cand = okCli(tempDir("dba-testcmd-cli-"));
    const rev = revisionIn(cand, LABEL);
    const latched: LabelRecord = {
      ...observeRun(undefined, { at: new Date(Date.now() - 60_000).toISOString(), revision: rev, ok: false, reason: "unreachable" }),
      quickCheck: { localDate: localDateStr(new Date()), revision: rev },
    };
    await writeProviderStatus({ labels: { [LABEL]: latched } });
    expect((await testCmd(cand)).json).toMatchObject({ passed: true, recorded: true });
    expect((await readProviderStatus())!.labels[LABEL]!.quickCheck).toBeUndefined();
  });

  test("a failure leaves the quick-check latch on", async () => {
    freshStateDir();
    const cand = badCli(tempDir("dba-testcmd-cli-"));
    const rev = revisionIn(cand, LABEL);
    const qc = { localDate: localDateStr(new Date()), revision: rev };
    await writeProviderStatus({ labels: { [LABEL]: { ...observeRun(undefined, { at: new Date(Date.now() - 60_000).toISOString(), revision: rev, ok: false, reason: "unreachable" }), quickCheck: qc } } });
    await testCmd(cand);
    expect((await readProviderStatus())!.labels[LABEL]!.quickCheck).toEqual(qc);
  });
});

describe("provider test: an unrecorded outcome says why (P2-M1 checkpoint LOW, routed)", () => {
  const PASS: ProviderCliDeps["probe"] = async () => ({ ok: true });
  const cand = () => candidate({ kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9/v1" });

  test("a lock still held past the retry → recorded:false, notRecorded:\"lock-held\"", async () => {
    freshStateDir();
    let clock = 0, holder: LockHeld | undefined;
    try {
      const r = await testCmd(cand(), {
        clock: () => clock, sleep: async (ms) => { clock += ms; },
        probe: async () => { const got = await acquireRunLock({ invoker: "scheduled", timeoutMs: 600_000, path: runLockPath() }); if (got.acquired) holder = got; return { ok: true }; },
      });
      expect(r.json).toMatchObject({ ok: true, passed: true, recorded: false, notRecorded: "lock-held" });
      expect(clock).toBeGreaterThanOrEqual(TEST_LOCK_RETRY_MS);
    } finally { await holder?.release(); }
  });

  test("a status file that cannot be written → recorded:false, notRecorded:\"write-failed\", and no mark is touched", async () => {
    const d = freshStateDir();
    writeMarks(d, { [LABEL]: hourMark() });
    mkdirSync(providerStatusPath(), { recursive: true });                      // a folder where the file goes: the rename fails
    const r = await testCmd(cand(), { probe: PASS });
    expect(r.json).toMatchObject({ ok: true, passed: true, recorded: false, notRecorded: "write-failed" });
    expect(marksIn(d)[LABEL]).toBeDefined();
    expect(existsSync(runLockPath())).toBe(false);                             // released
  });

  test("a recorded outcome carries no notRecorded", async () => {
    freshStateDir();
    const r = await testCmd(cand(), { probe: PASS });
    expect(r.json).toEqual({ schemaVersion: 1, ok: true, passed: true, at: r.json!.at, recorded: true });
  });
});

describe("provider test: the run lock is judged by the SAVED config, never the candidate (P2-M1 checkpoint LOW, routed)", () => {
  /** A live holder's lock whose age is stale for a 1 s timeout but fresh for a 600 s one. */
  async function holdAgedLock(): Promise<LockHeld> {
    const got = await acquireRunLock({ invoker: "scheduled", timeoutMs: 600_000, path: runLockPath() });
    if (!got.acquired) throw new Error("expected the lock");
    const shortStale = lockStaleMs(1_000), longStale = lockStaleMs(600_000);
    expect(shortStale).toBeLessThan(longStale);
    const age = new Date(Date.now() - Math.round((shortStale + longStale) / 2));
    utimesSync(runLockPath(), age, age);
    return got;
  }
  const short = { cli: "/nonexistent/item-one", argv: [], promptVia: "stdin", timeoutMs: 1_000 };
  const long = { ...short, timeoutMs: 600_000 };
  const cand = { repos: [], provider: short, fallbacks: [{ label: LABEL, api: { kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9/v1" } }] };

  test("a briefing under the saved config's long timeout is NOT reclaimed by a candidate with a short one", async () => {
    freshStateDir();
    const saved = join(tempDir("dba-testcmd-saved-"), "config.json");
    writeFileSync(saved, JSON.stringify({ repos: [], provider: long }));
    const holder = await holdAgedLock();
    let clock = 0;
    try {
      const r = await testCmd(cand, { configFile: saved, probe: async () => ({ ok: true }), clock: () => clock, sleep: async (ms) => { clock += ms; } });
      expect(r.json).toMatchObject({ passed: true, recorded: false, notRecorded: "lock-held" });
      expect(JSON.parse(readFileSync(runLockPath(), "utf8")).invoker).toBe("scheduled");   // the holder's, untouched
    } finally { await holder.release(); }
  });

  // With no saved config to judge by, the CONSERVATIVE inputs apply (P2-M4 checkpoint LOW 3): the larger of the
  // candidate's timeout and the LONGER default — an API provider's 300 s (`API_TIMEOUT_MS`; a CLI's is 120 s) — with
  // recap campaigns AND calendar on — a config missing or unreadable now may have been readable when a live briefing
  // loaded it. Bounds (src/runlock.ts `lockStaleMs`), in ms:
  //   t = 1 000: 250 000 (no flags)          t = 120 000: 845 000 (no flags), 880 000 (calendar), 1 135 000 (recap),
  //                                                       1 170 000 (both)
  //   t = 300 000: 1 745 000 (no flags), 1 780 000 (calendar), 2 395 000 (recap), 2 430 000 (both)
  //   t = 600 000, both: 4 530 000
  /** A live holder's lock, aged `ageMs`. */
  async function holdLockAged(ageMs: number): Promise<LockHeld> {
    const got = await acquireRunLock({ invoker: "scheduled", timeoutMs: 600_000, path: runLockPath() });
    if (!got.acquired) throw new Error("expected the lock");
    const at = new Date(Date.now() - ageMs);
    utimesSync(runLockPath(), at, at);
    return got;
  }
  test("the staleness bounds the cases below sit between", () => {
    expect(lockStaleMs(1_000)).toBe(250_000);
    expect(lockStaleMs(120_000)).toBe(845_000);
    expect(lockStaleMs(120_000, { calendar: true })).toBe(880_000);
    expect(lockStaleMs(120_000, { recapCampaigns: true })).toBe(1_135_000);
    expect(lockStaleMs(120_000, { recapCampaigns: true, calendar: true })).toBe(1_170_000);
    expect(lockStaleMs(300_000)).toBe(1_745_000);
    expect(lockStaleMs(300_000, { calendar: true })).toBe(1_780_000);
    expect(lockStaleMs(300_000, { recapCampaigns: true })).toBe(2_395_000);
    expect(lockStaleMs(300_000, { recapCampaigns: true, calendar: true })).toBe(2_430_000);
    expect(lockStaleMs(600_000, { recapCampaigns: true, calendar: true })).toBe(4_530_000);
  });
  const fakeClock = () => { let clock = 0; return { clock: () => clock, sleep: async (ms: number) => { clock += ms; } }; };

  for (const [what, prep] of [
    ["missing", (_f: string) => undefined],
    ["not JSON", (f: string) => writeFileSync(f, "{")],
    ["not valid", (f: string) => writeFileSync(f, JSON.stringify({ repos: "nope" }))],
  ] as const) {
    test(`a saved config that is ${what}: an aged live lock the candidate's 1 s timeout would reclaim is NOT reclaimed`, async () => {
      freshStateDir();
      const saved = join(tempDir("dba-testcmd-saved-"), "config.json");
      prep(saved);
      // 2 410 s: stale for the candidate (250 s), for the CLI default even with both on (1 170 s), and for the API
      // default alone (1 745 s), with recap only (2 395 s) or calendar only (1 780 s) — fresh only for the API default
      // with BOTH on (2 430 s).
      const holder = await holdLockAged(2_410_000);
      try {
        const r = await testCmd(cand, { configFile: saved, probe: async () => ({ ok: true }), ...fakeClock() });
        expect(r.json).toMatchObject({ passed: true, recorded: false, notRecorded: "lock-held" });
        expect(JSON.parse(readFileSync(runLockPath(), "utf8")).invoker).toBe("scheduled");   // the holder's, untouched
      } finally { await holder.release(); }
    });
  }

  test("with no saved config, a candidate timeout LONGER than the default is the one used (the max of the two)", async () => {
    freshStateDir();
    const longCand = { ...cand, provider: long };
    const holder = await holdLockAged(3_000_000);                              // stale at 300 s (2 430 s), fresh at 600 s
    try {
      const r = await testCmd(longCand, { probe: async () => ({ ok: true }), ...fakeClock() });   // default configFile: missing
      expect(r.json).toMatchObject({ passed: true, recorded: false, notRecorded: "lock-held" });
    } finally { await holder.release(); }
  });

  test("with no saved config, a lock past even the conservative bound is still reclaimed (the fallback is a bound, not a refusal)", async () => {
    freshStateDir();
    const holder = await holdLockAged(2_460_000);                              // past 2 430 s, the widest default bound
    try {
      const r = await testCmd(cand, { probe: async () => ({ ok: true }) });
      expect(r.json).toMatchObject({ passed: true, recorded: true });
    } finally { await holder.release(); }
  });

  test("a saved-config read that stalls is cut at its bound and judged conservatively (P2-M4 checkpoint LOW 4)", async () => {
    freshStateDir();
    const saved = join(tempDir("dba-testcmd-saved-"), "config.json");
    writeFileSync(saved, JSON.stringify({ repos: [], provider: short }));      // readable — but its read never answers
    const reads: string[] = [];
    const readConfig = async (f: string): Promise<string | undefined> => {
      reads.push(f);
      if (f === saved) return new Promise<never>(() => { /* a dead mount */ });
      return readFileSync(f, "utf8");
    };
    const holder = await holdLockAged(1_150_000);
    try {
      const t0 = performance.now();
      const r = await testCmd(cand, { configFile: saved, readConfig, configReadsMs: 50, probe: async () => ({ ok: true }), ...fakeClock() });
      expect(performance.now() - t0).toBeLessThan(2_000);
      expect(reads).toContain(saved);
      // Had the stalled config's short timeout been used, the lock would be reclaimed and the outcome recorded.
      expect(r.json).toMatchObject({ passed: true, recorded: false, notRecorded: "lock-held" });
    } finally { await holder.release(); }
  }, 10_000);

  // PR 2 final r2 L5: the two config reads SHARE one budget (spec §6: the app's loopback bound is the engine's worst case
  // + 5 s, so the reads may add 0.5 s, not 1 s): the saved read gets only what the candidate's left. Each read here fits
  // the budget ALONE (400 ms and 300 ms of 600), but not together — so the saved one is cut, and judged conservatively.
  // The PROBE between them (here 700 ms, longer than the whole budget) is not counted against it.
  test("the saved-config read gets only what the candidate read left of the shared budget", async () => {
    const run = async (candidateMs: number) => {
      freshStateDir();
      const saved = join(tempDir("dba-testcmd-saved-"), "config.json");
      writeFileSync(saved, JSON.stringify({ repos: [], provider: short }));      // valid: its 1 s timeout would reclaim
      const readConfig = async (f: string): Promise<string | undefined> => {
        await Bun.sleep(f === saved ? 300 : candidateMs);
        return readFileSync(f, "utf8");
      };
      const holder = await holdLockAged(1_150_000);
      const probe = async () => { await Bun.sleep(700); return { ok: true }; };
      try { return (await testCmd(cand, { configFile: saved, readConfig, configReadsMs: 600, probe, ...fakeClock() })).json; }
      finally { await holder.release(); }
    };
    expect(await run(0)).toMatchObject({ passed: true, recorded: true });                         // the saved read fits
    expect(await run(400)).toMatchObject({ passed: true, recorded: false, notRecorded: "lock-held" });   // it does not
  }, 10_000);

  // C2 / A5: the CANDIDATE's read is bounded too (`TEST_CONFIG_READS_MS`): a stalled read is `config` with
  // `reason: "timeout"` (retry), nothing is probed and nothing is written.
  test("a candidate read that stalls is cut at its bound: config, reason timeout, no probe", async () => {
    freshStateDir();
    let probed = 0;
    const readConfig = async (f: string): Promise<string | undefined> =>
      f.endsWith("candidate.json") ? new Promise<never>(() => { /* a dead mount */ }) : readFileSync(f, "utf8");
    const t0 = performance.now();
    const r = await testCmd(cand, { readConfig, configReadsMs: 50, probe: async () => { probed++; return { ok: true }; } });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect([r.code, r.json?.code, r.json?.reason, probed]).toEqual([2, "config", "timeout", 0]);
  });
});

// ── a literal key the app could only have staged as its placeholder (P3-M4-T4; hub 2026-10-18, revised at PR 3 final r1) ──
//
// The app never holds a literal key: a Test of a literal-key entry would stage the candidate with the settings guard's
// redaction placeholder, probe with it, fail `auth` and record a failure the stored key may not deserve. So `test`
// refuses a tested entry whose literal `apiKey`, trimmed, still contains whitespace or a control character — the
// placeholder always does, a real key never does — as `config` with `reason: "invalid-key"`, before anything is probed
// or recorded. It is NOT the key store's rule (8 to 512 of a fixed charset): that refused short dummy literals the run
// accepts, such as Ollama's documented `apiKey: "ollama"` (PR 3 final r1, H1). The engine never names the placeholder:
// the bad literals here are built from SHAPE alone, and the placeholder itself is read from the Rust source only to
// show it is caught by shape.
describe("provider test: a literal apiKey holding whitespace or a control character is refused before anything runs (P3-M4-T4)", () => {
  const NOT_A_KEY = ["(", "a", "stand-in", "for", "a", "key", ")"].join(" ");
  const placeholder = (): string => {
    const rust = readFileSync(join(import.meta.dir, "..", "gui", "src-tauri", "src", "config_save.rs"), "utf8");
    const m = /pub const REDACTED_API_KEY: &str =\s*"([^"]+)";/.exec(rust);
    expect(m).not.toBeNull();
    return m![1]!;
  };

  test("config, reason invalid-key: nothing probed, no status and no mark written, the literal never echoed — whatever source outranks it", async () => {
    for (const api of [
      { kind: "anthropic", model: "m", baseUrl: "https://api.example.invalid", apiKey: NOT_A_KEY },
      { kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9/v1", apiKey: NOT_A_KEY },
      // A source that outranks the literal does not make the entry testable: the literal is still one the app cannot hold.
      { kind: "anthropic", model: "m", apiKeyEnv: "K", apiKey: NOT_A_KEY },
      { kind: "anthropic", model: "m", apiKey: placeholder() },
      // Whitespace INSIDE the trimmed value, of any kind, and a control character: none is ever part of a real key.
      { kind: "anthropic", model: "m", apiKey: "sk-abc def0123" },
      { kind: "anthropic", model: "m", apiKey: "  sk-abc\tdef0123  " },
      { kind: "anthropic", model: "m", apiKey: "sk-abc\ndef0123" },
      { kind: "anthropic", model: "m", apiKey: "sk-abc\u00a0def0123" },
      { kind: "anthropic", model: "m", apiKey: "sk-abc\u0007def0123" },
      { kind: "anthropic", model: "m", apiKey: "sk-abc\u007fdef0123" },
    ]) {
      const dir = freshStateDir();
      let probed = 0;
      const r = await testCmd(candidate(api), { env: { K: KEY }, probe: async () => { probed++; return { ok: false, reason: "auth" }; } });
      expect([api.apiKey, r.code, r.json?.ok, r.json?.code, r.json?.reason, probed]).toEqual([api.apiKey, 2, false, "config", "invalid-key", 0]);
      expect(await readProviderStatus()).toBeUndefined();
      expect(existsSync(providerStatusPath())).toBe(false);
      expect(existsSync(accountStatePath(dir))).toBe(false);
      for (const text of [r.out, r.err]) { expect(text).not.toContain(api.apiKey); expect(text).not.toContain(LABEL); }
      // The wording never sends the user to `key migrate`, which refuses a key outside the key store's rule.
      expect(String(r.json?.error)).not.toMatch(/move|key store|8 to 512/);
    }
  });

  // H1 (PR 3 final r1): a literal outside the key STORE's rule but with no whitespace or control character is a key the
  // run accepts, so Test probes it — Ollama's documented dummy `"ollama"` (6 characters) above all.
  test("a short or odd-charset literal the run accepts goes on to the probe and is recorded", async () => {
    for (const apiKey of ["ollama", "  ollama  ", "x", "sk!@#$%^&*", "(key)", "ключ-ключ-ключ", "a".repeat(600)]) {
      freshStateDir();
      let probed = 0;
      const r = await testCmd(candidate({ kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9/v1", apiKey }),
        { probe: async () => { probed++; return { ok: true }; } });
      expect([apiKey, r.code, r.json?.ok, r.json?.passed, r.json?.recorded, probed]).toEqual([apiKey, 0, true, true, true, 1]);
      expect((await readProviderStatus())?.labels[LABEL]?.lastTest).toMatchObject({ ok: true });
    }
  });

  test("Ollama's dummy literal reaches the server as the bearer key, as the run sends it", async () => {
    freshStateDir();
    const s = await serve(okJson({ content: [] }));
    const r = await testCmd(candidate({ kind: "anthropic", model: "m", baseUrl: s.origin, apiKey: "ollama" }));
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, passed: true, recorded: true });
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.headers["x-api-key"]).toBe("ollama");
  });

  test("a literal inside the key rule is tested and recorded as before", async () => {
    freshStateDir();
    const s = await serve(okJson({ content: [] }));
    const r = await testCmd(candidate({ kind: "anthropic", model: "m", baseUrl: s.origin, apiKey: `  ${KEY}  ` }));
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, passed: true, recorded: true });
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.headers["x-api-key"]).toBe(KEY);
    expect((await readProviderStatus())?.labels[LABEL]?.lastTest).toMatchObject({ ok: true });
  });

  test("the engine never names the app's placeholder: the rule is a shape (whitespace inside the trimmed value)", () => {
    const text = placeholder();
    expect(text.trim()).toMatch(/\s/);
    for (const f of new Bun.Glob("**/*.ts").scanSync({ cwd: join(import.meta.dir, "..", "src") })) {
      expect([f, readFileSync(join(import.meta.dir, "..", "src", f), "utf8").includes(text)]).toEqual([f, false]);
    }
  });
});
