// test/config.api.test.ts — A3/T2. `validateConfig`'s api branch, and the legacy path's byte-identity.
//
// ⚠ `validateConfig` THROWS ON EVERY 600s TICK WHEN IT THROWS AT ALL (main.ts surfaces it as exit 2),
// so a false rejection is TOTAL NON-DELIVERY. The first block below is the mitigation: a table of
// real-shaped legacy configs whose output must be deep-equal to what the pre-change function produced.
// The new branch is unreachable for every config that exists today — it is entered only when
// `provider.api` is present — and this table is what turns that from an argument into a measurement.
import { test, expect } from "bun:test";
import { validateConfig, validateProviderApi, apiTransportLabel } from "../src/config";
import { API_LABEL_ANTHROPIC, API_LABEL_OPENAI } from "../src/types";
import { claudeShaped } from "../src/harden";

const HOME = "/home/someone";

// ── legacy identity ───────────────────────────────────────────────────────────────────────────────

/** Real-shaped configs, snapshotted as the EXPECTED OUTPUT of the pre-A3 function. Each expectation was
 *  produced by running the shipped `validateConfig` before the api branch was inserted and pasting the
 *  result — not by re-deriving it from the new code, which would prove nothing. */
const LEGACY: { name: string; input: Record<string, unknown>; expect: Record<string, unknown> }[] = [
  {
    name: "the init template",
    input: {
      discoverRoots: ["~/dev"],
      provider: { cli: "claude", argv: ["-p"], promptVia: "stdin", harden: true, credential: "subscription" },
      tokenBudget: { maxChars: 200000 },
      lookbackCapDays: 4,
      networkProbeHosts: [{ host: "1.1.1.1", port: 443 }, { host: "8.8.8.8", port: 443 }],
    },
    expect: {
      discoverRoots: [`${HOME}/dev`],
      provider: { cli: "claude", argv: ["-p"], promptVia: "stdin", harden: true, credential: "subscription" },
      tokenBudget: { maxChars: 200000 },
      lookbackCapDays: 4,
      networkProbeHosts: [{ host: "1.1.1.1", port: 443 }, { host: "8.8.8.8", port: 443 }],
      repos: undefined, excludeRepos: undefined,
    },
  },
  {
    name: "a codex user with accounts and transcripts",
    input: {
      repos: ["~/a", "/abs/b"],
      excludeRepos: ["~/work"],
      provider: {
        cli: "codex", argv: ["exec"], promptVia: "arg", timeoutMs: 300000,
        accounts: [{ label: "primary" }, { label: "alt", configDir: "~/.claude-alt" }],
      },
      transcripts: { enabled: true },
      auditJudgeArgv: ["--model", "opus"],
      morningTime: "06:45",
    },
    expect: {
      repos: [`${HOME}/a`, "/abs/b"],
      excludeRepos: [`${HOME}/work`],
      provider: {
        cli: "codex", argv: ["exec"], promptVia: "arg", timeoutMs: 300000,
        accounts: [{ label: "primary" }, { label: "alt", configDir: "~/.claude-alt" }],
      },
      transcripts: { enabled: true },
      auditJudgeArgv: ["--model", "opus"],
      morningTime: "06:45",
      discoverRoots: undefined,
    },
  },
  {
    name: "the minimum a config can be",
    input: { provider: { cli: "/opt/homebrew/bin/claude", argv: [], promptVia: "stdin" } },
    expect: {
      provider: { cli: "/opt/homebrew/bin/claude", argv: [], promptVia: "stdin" },
      repos: undefined, discoverRoots: undefined, excludeRepos: undefined,
    },
  },
];

test("A3: the legacy path is BYTE-IDENTICAL — the api branch is unreachable for every existing config", () => {
  for (const c of LEGACY) {
    const out = validateConfig(structuredClone(c.input), HOME);
    expect(`${c.name}: ${JSON.stringify(out)}`).toBe(`${c.name}: ${JSON.stringify(c.expect)}`);
    // …and nothing synthesized a stray `api` key onto a config that never had one.
    expect(out.provider.api).toBeUndefined();
  }
});

// ── synthesis ─────────────────────────────────────────────────────────────────────────────────────

test("A3: an api config SYNTHESIZES the frozen triple so no consumer ever sees undefined", () => {
  const out = validateConfig({ provider: { api: { kind: "anthropic", model: "claude-sonnet-5" } } }, HOME);
  expect(out.provider.cli).toBe(API_LABEL_ANTHROPIC);
  expect(out.provider.argv).toEqual([]);
  expect(out.provider.promptVia).toBe("stdin");
  expect(out.provider.api).toEqual({ kind: "anthropic", model: "claude-sonnet-5" });

  const oai = validateConfig({ provider: { api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1" } } }, HOME);
  expect(oai.provider.cli).toBe(API_LABEL_OPENAI);
  expect(oai.provider.argv).toEqual([]);
  expect(oai.provider.promptVia).toBe("stdin");
});

test("A3: the synthesized cli is never claude-shaped, for EVERY kind (property, not a spot check)", () => {
  for (const kind of ["anthropic", "openai-compatible"] as const) {
    const v = validateConfig({ provider: { api: { kind, model: "m", ...(kind === "openai-compatible" ? { baseUrl: "https://x.test" } : {}) } } }, HOME);
    expect(`${kind}: ${claudeShaped(v.provider.cli)}`).toBe(`${kind}: false`);
    expect(apiTransportLabel(kind)).toBe(v.provider.cli);
  }
});

test("A3: `argv` is a FRESH array per call — a shared one would be mutable across 85 importers", () => {
  const a = validateConfig({ provider: { api: { kind: "anthropic", model: "m" } } }, HOME);
  const b = validateConfig({ provider: { api: { kind: "anthropic", model: "m" } } }, HOME);
  expect(a.provider.argv).not.toBe(b.provider.argv);
});

// ── mutual exclusion ──────────────────────────────────────────────────────────────────────────────

test("⚠ A3: `api` alongside cli/argv/promptVia THROWS and names EVERY offending key", () => {
  // A throw, not a warning, and not "api wins": silently preferring one transport over the other makes
  // WHICH CREDENTIAL WAS SPENT into invisible state — the failure class that already cost this project
  // weeks of mis-billed API credits. The message has to be actionable, so it names all three.
  const both = () => validateConfig({
    provider: { cli: "claude", argv: ["-p"], promptVia: "stdin", api: { kind: "anthropic", model: "m" } },
  }, HOME);
  expect(both).toThrow(/config error/);
  let msg = "";
  try { both(); } catch (e) { msg = (e as Error).message; }
  for (const k of ["cli", "argv", "promptVia"]) expect(msg).toContain(k);
  expect(msg).toMatch(/[Dd]elete/);

  // ONE offending key is named alone — not all three — or the advice tells the user to delete lines
  // that are not there.
  let one = "";
  try { validateConfig({ provider: { promptVia: "arg", api: { kind: "anthropic", model: "m" } } }, HOME); }
  catch (e) { one = (e as Error).message; }
  expect(one).toContain("promptVia");
  expect(one).not.toContain('"provider.cli"');
});

test("A3: `credential` alongside `api` does NOT throw — it cannot change which transport runs", () => {
  // The asymmetry is the decision: cli/argv/promptVia DECIDE the transport, so ambiguity there is
  // unresolvable; `credential` merely has no effect, which is a warning's job (raised by the key ladder).
  const out = validateConfig({ provider: { credential: "env-api-key", harden: false, api: { kind: "anthropic", model: "m" } } }, HOME);
  expect(out.provider.api?.kind).toBe("anthropic");
  expect(out.provider.credential).toBe("env-api-key");
});

// ── field validation ──────────────────────────────────────────────────────────────────────────────

const bad = (api: unknown, extra: Record<string, unknown> = {}) =>
  () => validateConfig({ provider: { ...extra, api } }, HOME);

test("A3: each malformed api shape throws with a message naming the field", () => {
  const cases: [string, unknown, RegExp][] = [
    ["api is a string", "anthropic", /provider\.api/],
    ["api is an array", [], /provider\.api/],
    ["unknown kind", { kind: "gemini", model: "m" }, /provider\.api\.kind/],
    ["missing kind", { model: "m" }, /provider\.api\.kind/],
    ["missing model", { kind: "anthropic" }, /provider\.api\.model/],
    ["blank model", { kind: "anthropic", model: "   " }, /provider\.api\.model/],
    ["numeric model", { kind: "anthropic", model: 7 }, /provider\.api\.model/],
    ["baseUrl not a string", { kind: "anthropic", model: "m", baseUrl: 1 }, /provider\.api\.baseUrl/],
    ["baseUrl unparseable", { kind: "anthropic", model: "m", baseUrl: "not a url" }, /provider\.api\.baseUrl/],
    ["maxTokens zero", { kind: "anthropic", model: "m", maxTokens: 0 }, /provider\.api\.maxTokens/],
    ["maxTokens fractional", { kind: "anthropic", model: "m", maxTokens: 1.5 }, /provider\.api\.maxTokens/],
    ["maxTokens a string", { kind: "anthropic", model: "m", maxTokens: "4096" }, /provider\.api\.maxTokens/],
    ["apiKeyEnv blank", { kind: "anthropic", model: "m", apiKeyEnv: "" }, /apiKeyEnv/],
    ["apiKeyFile numeric", { kind: "anthropic", model: "m", apiKeyFile: 3 }, /apiKeyFile/],
    ["apiKeyCommand a string", { kind: "anthropic", model: "m", apiKeyCommand: "pass show x" }, /apiKeyCommand/],
    ["apiKeyCommand empty", { kind: "anthropic", model: "m", apiKeyCommand: [] }, /apiKeyCommand/],
    ["apiKeyCommand non-strings", { kind: "anthropic", model: "m", apiKeyCommand: ["ok", 2] }, /apiKeyCommand/],
  ];
  for (const [name, api, re] of cases) {
    let msg = "";
    try { bad(api)(); msg = "(did not throw)"; } catch (e) { msg = (e as Error).message; }
    expect(`${name}: ${re.test(msg)}`).toBe(`${name}: true`);
  }
});

test("⚠ A3: a baseUrl with a non-http scheme, or with EMBEDDED CREDENTIALS, is refused", () => {
  // `file:///etc/passwd` would make the "endpoint" a path the probe-host derivation then treats as a
  // network origin. Userinfo is refused rather than stripped: a key in a URL is a key that lands in
  // every log line and every rendered endpoint, and the key has four supported sources, none of them
  // the address bar.
  expect(bad({ kind: "anthropic", model: "m", baseUrl: "file:///etc/passwd" })).toThrow(/http/);
  expect(bad({ kind: "anthropic", model: "m", baseUrl: "https://user:pw@h.test/" })).toThrow(/username or password/);
  expect(bad({ kind: "anthropic", model: "m", baseUrl: "https://user@h.test/" })).toThrow(/username or password/);
  // …and the legitimate shapes still pass.
  for (const u of ["https://api.anthropic.com", "http://127.0.0.1:11434/v1", "https://gw.corp.test:8443/anthropic/"]) {
    expect(() => validateProviderApi({ api: { kind: "anthropic", model: "m", baseUrl: u } })).not.toThrow();
  }
});

test("A3: `timeoutMs`/`harden`/`credential` are validated on the API branch too", () => {
  // Validating them only on the CLI branch would let a typo in a shared field go unnoticed on exactly
  // the configs that are newest and least proof-read.
  expect(bad({ kind: "anthropic", model: "m" }, { timeoutMs: -1 })).toThrow(/timeoutMs/);
  expect(bad({ kind: "anthropic", model: "m" }, { harden: "yes" })).toThrow(/harden/);
  expect(bad({ kind: "anthropic", model: "m" }, { credential: "nope" })).toThrow(/credential/);
});
