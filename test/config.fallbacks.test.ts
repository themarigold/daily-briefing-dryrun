// test/config.fallbacks.test.ts — `config validate` and the combined list (provider-fallback plan P1-M2-T3).
//
// A broken `fallbacks` entry is dropped at RUNTIME with a warning (src/providerList.ts), but `config validate`
// — the app's save path — returns it as an ERROR naming the entry, so the app never saves a list the engine
// would run shorter. A broken `provider` block stays a config error, at load and in validate, as today.
// This file also pins the `resolveAccounts` warning suffix the app's save gate keys on (P3-M4-T1).
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { validateConfig, resolveAccounts } from "../src/config";
import { validateCandidate, validateCandidateBounded } from "../src/json";
import { APP_KEY_SERVICE, KEY_OWNERSHIP_REPORT_DEADLINE_MS, SECURITY_BIN } from "../src/providerList";
import { KEY_MOVED_ENV } from "../src/providerCli";
import type { AsyncFsOps } from "../src/strictFile";
import { keysDir } from "../src/marker";
import { safeLabel } from "../src/failover";
import { basename, join } from "node:path";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const HOME = "/home/u";
const noEnv = {} as Record<string, string | undefined>;
const CLI = { cli: "claude", argv: ["-p"], promptVia: "stdin" };
const KEY_FB = { label: "Anthropic key", api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyEnv: "MY_KEY" } };
const LOCAL_FB = { label: "Local model", timeoutMs: 600_000, api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1" } };
const SUFFIX = "— account failover disabled";

describe("broken fallbacks are errors in config validate", () => {
  const cases: [string, unknown, string][] = [
    ["bad-shape", { label: "Bad kind", api: { kind: "gemini", model: "x" } }, '"Bad kind"'],
    ["duplicate-label", { ...LOCAL_FB, label: "Anthropic key" }, '"Anthropic key"'],
    ["config-dir", { label: "Codex", cli: "codex", argv: ["exec"], promptVia: "arg", configDir: "/x" }, '"Codex"'],
    ["duplicate-login", { label: "Again", ...CLI, configDir: "~/.claude" }, '"Again"'],
    ["bad-shape, no label", { api: LOCAL_FB.api }, ""],
  ];
  for (const [name, entry, label] of cases) {
    test(`${name}: an error with the entry's index${label ? " and label" : ""}`, () => {
      const r = validateCandidate({ provider: CLI, fallbacks: [KEY_FB, entry, LOCAL_FB] }, HOME, noEnv);
      expect(r.valid).toBe(false);
      expect(r.normalized).toBeNull();
      expect(r.errors.length).toBe(1);
      expect(r.errors[0]!.field).toBe("fallbacks[1]");
      expect(r.errors[0]!.message).toContain(`fallbacks[1]${label ? ` ${label}` : ""}:`);
      // An error, not also a warning.
      expect(r.warnings.filter((w) => w.message.includes("fallbacks["))).toEqual([]);
    });
  }

  test("a non-array fallbacks is an error on the whole key", () => {
    const r = validateCandidate({ provider: CLI, fallbacks: "Local model" }, HOME, noEnv);
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.field)).toEqual(["fallbacks"]);
  });

  test("every dropped entry is reported, not just the first", () => {
    const r = validateCandidate({ provider: CLI, fallbacks: [{ label: "" }, KEY_FB, { ...KEY_FB }] }, HOME, noEnv);
    expect(r.errors.map((e) => e.field)).toEqual(["fallbacks[0]", "fallbacks[2]"]);
  });
});

describe("the rest of the provider rules", () => {
  test("a broken provider block is still a config error, at load and in validate", () => {
    const raw = { provider: { cli: "claude", argv: "-p", promptVia: "stdin" }, fallbacks: [KEY_FB] };
    expect(() => validateConfig(raw, HOME)).toThrow(/config error: "provider" must be/);
    const r = validateCandidate(raw, HOME, noEnv);
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.field)).toEqual(["provider"]);
  });

  test("a valid two-entry config validates clean", () => {
    const r = validateCandidate({ provider: CLI, fallbacks: [LOCAL_FB] }, HOME, noEnv);
    expect(r).toMatchObject({ valid: true, errors: [], warnings: [] });
    expect(r.normalized).not.toBeNull();
  });

  test("a provider.label that is not a non-empty string is an error in validate (the run warns and uses \"default\")", () => {
    for (const bad of ["", "  ", 5, null]) {
      const r = validateCandidate({ provider: { ...CLI, label: bad } }, HOME, noEnv);
      expect(r.valid).toBe(false);
      expect(r.normalized).toBeNull();
      expect(r.errors.map((e) => e.field)).toEqual(["provider.label"]);
      expect(r.warnings.filter((w) => w.field === "provider.label")).toEqual([]);
    }
  });

  test("provider.label beside a resolving accounts list is a warning, and the config stays valid", () => {
    const r = validateCandidate({ provider: { ...CLI, label: "Ignored", accounts: [{ label: "A" }, { label: "B", configDir: "/x" }] } }, HOME, noEnv);
    expect(r.valid).toBe(true);
    expect(r.warnings.filter((w) => w.field === "provider.label").length).toBe(1);
  });
});

// P2-M5-T2 (spec r9 §6): an app-owned key must never travel in cleartext, so `config validate` — the app's save path —
// refuses a non-loopback `http:` endpoint for one, across the combined list. VALIDATE-ONLY: the runtime `validateConfig`
// still loads it (the run refuses that one entry as `insecure-endpoint`; a hand edit never becomes a whole-config error).
// The app-owned command is built from the exported constants, so this file holds no literal naming the binary.
describe("config validate requires https for an app-owned key (P2-M5-T2)", () => {
  const APP_CMD = [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-a", "k-0123456789ab", "-w"];
  /** Under the isolated state dir's keys/ — app-owned by its canonical path; the file need not exist. */
  const appFile = (): string => join(keysDir(), "k-0123456789ab.key");
  const api = (baseUrl: string, key: Record<string, unknown>) => ({ kind: "openai-compatible", model: "m", baseUrl, ...key });
  const keys: [string, () => Record<string, unknown>][] = [
    ["an app-owned key command", () => ({ apiKeyCommand: APP_CMD })],
    ["an app-owned key file", () => ({ apiKeyFile: appFile() })],
  ];

  for (const [name, key] of keys) {
    test(`${name} over plain http to a remote host: an error on item 1 and on a fallback, by position, no host`, () => {
      const item1 = { provider: { api: api("http://gpu-box.lan:8080/v1", key()) } };
      const r1 = validateCandidate(item1, HOME, noEnv);
      expect(r1.valid).toBe(false);
      expect(r1.normalized).toBeNull();
      expect(r1.errors.map((e) => e.field)).toEqual(["provider.api.baseUrl"]);
      expect(r1.errors[0]!.message).toMatch(/plain http .* https/);
      expect(r1.errors[0]!.message).not.toContain("gpu-box");
      const fb = { provider: CLI, fallbacks: [KEY_FB, { label: "LAN model", api: api("http://gpu-box.lan:8080/v1", key()) }] };
      const r2 = validateCandidate(fb, HOME, noEnv);
      expect(r2.valid).toBe(false);
      expect(r2.errors.map((e) => e.field)).toEqual(["fallbacks[1].api.baseUrl"]);
      expect(r2.errors[0]!.message).toContain('"LAN model"');
      expect(r2.errors[0]!.message).not.toContain("gpu-box");
      // An error, not also a warning.
      expect(r2.warnings.filter((w) => /plain http/.test(w.message))).toEqual([]);
      // VALIDATE-ONLY: the runtime validator still loads both.
      expect(() => validateConfig(item1, HOME)).not.toThrow();
      expect(() => validateConfig(fb, HOME)).not.toThrow();
    });

    test(`${name} over https, or over loopback http: no error`, () => {
      for (const url of ["https://gpu-box.lan:8080/v1", "http://127.0.0.1:11434/v1", "http://localhost:11434/v1", "http://[::1]:8080/v1"]) {
        const r = validateCandidate({ provider: CLI, fallbacks: [{ label: "M", api: api(url, key()) }] }, HOME, noEnv);
        expect(`${url}: ${JSON.stringify(r.errors)}`).toBe(`${url}: []`);
        expect(r.valid).toBe(true);
      }
    });
  }

  // T4 checkpoint LOW 2: `isAppOwnedKey` FAILS CLOSED on a walk of keys/ that cannot complete, so a user's own file
  // outside keys/ is then treated as app-owned — and the error must not claim it IS one. keys/ at 0300 (no read bit)
  // cannot be listed; a root runner can list it anyway, so the case is skipped by name there.
  test.skipIf(process.getuid?.() === 0)("an incomplete keys/ walk: a user's own key file reads as app-owned (fail closed), and the error says it MAY be one", () => {
    const keys = keysDir();
    const existed = existsSync(keys);
    mkdirSync(keys, { recursive: true });
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-validate-own-key-")));
    const own = join(dir, "lan.key");
    writeFileSync(own, "user-own-key-0000");
    chmodSync(own, 0o600);
    chmodSync(keys, 0o300);
    try {
      const r = validateCandidate({ provider: CLI, fallbacks: [{ label: "M", api: api("http://gpu-box.lan:8080/v1", { apiKeyFile: own }) }] }, HOME, noEnv);
      expect(r.errors.map((e) => e.field)).toEqual(["fallbacks[0].api.baseUrl"]);
      expect(r.errors[0]!.message).toContain("its key is, or may be, one the app stores");
      expect(r.errors[0]!.message).not.toContain("its key is one the app stores");
    } finally {
      chmodSync(keys, 0o700);
      if (!existed) rmSync(keys, { recursive: true, force: true });
    }
  });

  test("a key the app does NOT own over plain http stays valid, as today (requirement 9)", () => {
    for (const key of [{ apiKeyFile: "/home/u/ollama.key" }, { apiKeyCommand: ["pass", "show", "lan-model"] }, { apiKeyEnv: "LAN_KEY" }]) {
      const r = validateCandidate({ provider: CLI, fallbacks: [{ label: "M", api: api("http://gpu-box.lan:8080/v1", key) }] }, HOME, noEnv);
      expect(`${JSON.stringify(key)}: ${JSON.stringify(r.errors)}`).toBe(`${JSON.stringify(key)}: []`);
    }
  });

  test("the entry is named by its MASKED label (safeLabel): a key, or a label with a bidi control, is never echoed", () => {
    // The bidi-override label is one the report's boundary redaction (`redactCredentials`) does NOT catch — only
    // `safeLabel` masks it — so this pins that the message itself goes through `safeLabel`.
    for (const label of ["sk-ant-api03-ZZTOPSECRETlabelVALUE-0000", "LAN \u202Edlrow model"]) {
      const r = validateCandidate({ provider: CLI, fallbacks: [{ label, api: api("http://gpu-box.lan/v1", { apiKeyCommand: APP_CMD }) }] }, HOME, noEnv);
      expect(r.errors.map((e) => e.field)).toEqual(["fallbacks[0].api.baseUrl"]);
      expect(r.errors[0]!.message).toContain(JSON.stringify(safeLabel(label)));
      expect(JSON.stringify(r)).not.toContain(JSON.stringify(label).slice(1, -1));
    }
  });
});

// B1 (PR 2 final harden round 1): the app never re-implements "loopback" — the report gives each entry the bound the
// app's Test must allow (`testTimeoutMs`: the engine's worst case + 5 s). Remote or CLI: 80 s. Loopback (localhost,
// `*.localhost`, 127.0.0.0/8, ::1 — src/providers/endpoint.ts `isLoopbackHost`): the EFFECTIVE timeoutMs, capped at
// 30 min − 17 s, + 17 s. No `baseUrl` is the provider's own remote endpoint.
describe("config validate reports each entry's app-side Test bound (B1)", () => {
  const api = (baseUrl?: string, timeoutMs?: number) =>
    ({ ...(timeoutMs !== undefined ? { timeoutMs } : {}), api: { kind: "openai-compatible", model: "m", ...(baseUrl !== undefined ? { baseUrl } : {}) } });
  test("remote and CLI 80 000; loopback the effective timeout + 17 000, capped; indexes as status rows count them", () => {
    const r = validateCandidate({
      provider: { ...CLI, timeoutMs: 999_000 },                                   // item 1: a CLI is remote whatever its timeout
      fallbacks: [
        { label: "Anthropic", api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyEnv: "K" } },   // no baseUrl: remote
        { label: "Debian loopback", ...api("http://127.0.1.1:11434/v1", 250_000) },
        { label: "Localhost default", ...api("http://localhost:11434/v1") },          // no timeoutMs: 300 s, not item 1's
        { label: "Sub localhost", ...api("http://models.localhost:8080/v1", 60_000) },
        { label: "IPv6", ...api("http://[::1]:8080/v1", 1_000) },
        { label: "Huge", ...api("http://127.0.0.1:9/v1", 3_600_000) },               // capped at 30 min − 17 s
        { label: "LAN", ...api("http://192.168.1.5:11434/v1", 300_000) },            // not loopback: remote
        { label: "Bind address", ...api("http://0.0.0.0:11434/v1", 300_000) },       // 0.0.0.0 is not loopback
      ],
    }, HOME, noEnv);
    expect(r.valid).toBe(true);
    expect(r.providers).toEqual([
      { index: 0, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false }, { index: 1, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false },
      { index: 2, testTimeoutMs: 267_000, loopback: true, keyOptional: true, keyMoved: false }, { index: 3, testTimeoutMs: 317_000, loopback: true, keyOptional: true, keyMoved: false },
      { index: 4, testTimeoutMs: 77_000, loopback: true, keyOptional: true, keyMoved: false }, { index: 5, testTimeoutMs: 18_000, loopback: true, keyOptional: true, keyMoved: false },
      { index: 6, testTimeoutMs: 1_800_000, loopback: true, keyOptional: true, keyMoved: false }, { index: 7, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false },
      { index: 8, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false },
    ]);
  });

  // P3-M4-T1 follow-up (plan hub "(BUILD, P3-M4-T1, 2026-10-18) Decided" (1)): each row also says whether its entry is
  // loopback — `ListEntry.isLoopback`, the SAME decision its `testTimeoutMs` was computed from — so the app's
  // network-check prompt asks only for a remote entry without re-implementing `isLoopbackHost`.
  test("`loopback` is the engine's own decision: true for 127.0.0.0/8, ::1, localhost and *.localhost only", () => {
    const cases: [string, Record<string, unknown>, boolean][] = [
      ["127.0.0.1", api("http://127.0.0.1:11434/v1", 1_000), true],
      ["127.0.1.1", api("http://127.0.1.1:11434/v1", 1_000), true],
      ["::1", api("http://[::1]:8080/v1", 1_000), true],
      ["localhost", api("http://localhost:11434/v1", 1_000), true],
      ["LOCALHOST over https", api("https://LOCALHOST:8443/v1", 1_000), true],
      ["*.localhost", api("http://models.localhost:8080/v1", 1_000), true],
      ["a LAN IP", api("http://192.168.1.5:11434/v1", 1_000), false],
      ["a public host", api("https://api.example.com/v1", 1_000), false],
      ["0.0.0.0", api("http://0.0.0.0:11434/v1", 1_000), false],
      ["a name merely containing localhost", api("http://localhost.example.com/v1", 1_000), false],
      ["openai-compatible, no baseUrl", api(undefined, 1_000), false],
      ["anthropic, no baseUrl", { timeoutMs: 1_000, api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyEnv: "K" } }, false],
      ["a CLI", { cli: "codex", argv: ["exec"], promptVia: "arg", timeoutMs: 1_000 }, false],
    ];
    const r = validateCandidate({ provider: CLI, fallbacks: cases.map(([label, e]) => ({ label, ...e })) }, HOME, noEnv);
    expect(r.errors).toEqual([]);
    expect(r.providers.map((p) => [p.index, p.loopback])).toEqual([[0, false], ...cases.map(([, , l], i) => [i + 1, l])]);
    // Consistent with `testTimeoutMs` on every row: every entry here has `timeoutMs` 1 000, so a loopback row's bound is
    // 1 000 + 17 000 and a remote or CLI row's the fixed 80 000 — never one decision for one field and another for the other.
    for (const row of r.providers) expect(row.testTimeoutMs).toBe(row.loopback ? 18_000 : 80_000);
  });

  // Follow-up 4 (2026-10-19): each row also says whether its entry needs NO key — `keyOptional`, the engine's one
  // no-key rule (src/providers/endpoint.ts `keyOptional`: openai-compatible at a loopback host) — so the app's Add takes
  // a keyless local model without re-implementing the kind check or the host check.
  test("`keyOptional` is the engine's no-key rule: an openai-compatible entry at a loopback host, and nothing else", () => {
    const cases: [string, Record<string, unknown>, boolean, boolean][] = [
      ["openai-compatible at loopback", api("http://127.0.0.1:11434/v1", 1_000), true, true],
      ["openai-compatible at localhost", api("http://localhost:11434/v1", 1_000), true, true],
      ["openai-compatible remote", api("https://api.example.com/v1", 1_000), false, false],
      ["openai-compatible on the LAN", api("http://192.168.1.5:11434/v1", 1_000), false, false],
      ["anthropic at loopback", { timeoutMs: 1_000, api: { kind: "anthropic", model: "m", baseUrl: "http://127.0.0.1:8080", apiKeyEnv: "K" } }, true, false],
      ["openai-compatible, no baseUrl", api(undefined, 1_000), false, false],
      ["anthropic, no baseUrl", { timeoutMs: 1_000, api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyEnv: "K" } }, false, false],
      ["a CLI", { cli: "codex", argv: ["exec"], promptVia: "arg", timeoutMs: 1_000 }, false, false],
    ];
    const r = validateCandidate({ provider: CLI, fallbacks: cases.map(([label, e]) => ({ label, ...e })) }, HOME, noEnv);
    expect(r.errors).toEqual([]);
    expect(r.providers.map((p) => [p.index, p.loopback, p.keyOptional])).toEqual([[0, false, false], ...cases.map(([, , l, k], i) => [i + 1, l, k])]);
  });

  test("`loopback` for an API item 1 and for item 1's logins; still no rows under a broken accounts", () => {
    const local = validateCandidate({ provider: { timeoutMs: 1_000, api: { kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9/v1" } } }, HOME, noEnv);
    expect(local.providers).toEqual([{ index: 0, testTimeoutMs: 18_000, loopback: true, keyOptional: true, keyMoved: false }]);
    const remote = validateCandidate({ provider: { api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyEnv: "K" } } }, HOME, noEnv);
    expect(remote.providers).toEqual([{ index: 0, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false }]);
    const logins = validateCandidate({ provider: { ...CLI, accounts: [{ label: "A" }, { label: "B", configDir: "/x" }] } }, HOME, noEnv);
    expect(logins.providers).toEqual([{ index: 0, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false }, { index: 1, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false }]);
    const broken = { ...CLI, accounts: [{ label: "Same" }, { label: "Same", configDir: "/x" }] };
    expect(validateCandidate({ provider: broken, fallbacks: [{ label: "L", ...api("http://127.0.0.1:9/v1", 1_000) }] }, HOME, noEnv).providers).toEqual([]);
  });

  // P3-M4-T2 checkpoint: each row also says whether its entry's key was moved out by PR 2's scrub — its api block's
  // `apiKeyEnv` is the sentinel `KEY_MOVED_ENV` (src/providerCli.ts, the one place that names it) — so the app shows
  // "key moved — add a key" from the engine's answer and never spells the sentinel itself.
  test("`keyMoved` is true only for an api block whose apiKeyEnv is the scrub sentinel, at item 1 and at a fallback", () => {
    const remote = (key: Record<string, unknown>) => ({ api: { kind: "anthropic", model: "claude-sonnet-5", ...key } });
    const own = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-validate-keymoved-")));
    writeFileSync(join(own, "my.key"), "users-own-key-0000");
    const cases: [string, Record<string, unknown>, boolean][] = [
      ["Moved", remote({ apiKeyEnv: KEY_MOVED_ENV }), true],
      ["Moved local", { api: { kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: KEY_MOVED_ENV } }, true],
      ["Env", remote({ apiKeyEnv: "MY_KEY" }), false],
      ["Env, a name merely containing the sentinel", remote({ apiKeyEnv: `${KEY_MOVED_ENV}_2` }), false],
      ["File", remote({ apiKeyFile: join(own, "my.key") }), false],
      ["Literal", remote({ apiKey: "sk-ant-api03-LiteralKeyBytesP3M4T2" }), false],
      ["Codex", { cli: "codex", argv: ["exec"], promptVia: "arg" }, false],
    ];
    const fallbacks = cases.map(([label, e]) => ({ label, ...e }));
    // Item 1 an API entry carrying the sentinel (a restored `.bak` whose item 1 held the literal).
    const r = validateCandidate({ provider: remote({ apiKeyEnv: KEY_MOVED_ENV }), fallbacks }, HOME, noEnv);
    expect(r.errors).toEqual([]);
    expect(r.providers.map((p) => [p.index, p.keyMoved])).toEqual([[0, true], ...cases.map(([, , m], i) => [i + 1, m])]);
    // Item 1 a CLI (and its logins) never is; the same fallbacks answer the same.
    const cli = validateCandidate({ provider: { ...CLI, accounts: [{ label: "A" }, { label: "B", configDir: "/x" }] }, fallbacks }, HOME, noEnv);
    expect(cli.providers.map((p) => [p.index, p.keyMoved])).toEqual([[0, false], [1, false], ...cases.map(([, , m], i) => [i + 2, m])]);
    // The rows still carry no endpoint and no key bytes; the sentinel itself is not echoed in a row either.
    expect(JSON.stringify(r.providers)).not.toContain(KEY_MOVED_ENV);
    expect(JSON.stringify(r.providers)).not.toContain("LiteralKeyBytes");
  });

  test("`keyMoved` is the same on the bounded path `config validate` runs", async () => {
    const raw = { provider: CLI, fallbacks: [
      { label: "Moved", api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyEnv: KEY_MOVED_ENV } },
      { label: "Env", api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyEnv: "MY_KEY" } },
    ] };
    const bounded = await validateCandidateBounded(raw, HOME, noEnv);
    expect(bounded).toEqual(validateCandidate(raw, HOME, noEnv));
    expect(bounded.providers).toEqual([
      { index: 0, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false },
      { index: 1, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: true },
      { index: 2, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false },
    ]);
  });

  test("a dropped entry keeps its position (no row of its own); an invalid config reports none", () => {
    const r = validateCandidate({ provider: CLI, fallbacks: [{ label: "" }, { label: "L", ...api("http://127.0.0.1:9/v1", 1_000) }] }, HOME, noEnv);
    expect(r.valid).toBe(false);
    expect(r.providers).toEqual([{ index: 0, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false }, { index: 2, testTimeoutMs: 18_000, loopback: true, keyOptional: true, keyMoved: false }]);
    expect(validateCandidate({ provider: "nope" }, HOME, noEnv).providers).toEqual([]);
  });

  // PR 2 final r2 L3: validate accepts a fractional `timeoutMs`; the app's bound is reported in integer milliseconds
  // (rounded UP, so it never undercuts the engine's worst case).
  test("a fractional timeoutMs is reported as integer milliseconds, rounded up", () => {
    const r = validateCandidate({ provider: CLI, fallbacks: [{ label: "L", ...api("http://127.0.0.1:9/v1", 1_500.5) }] }, HOME, noEnv);
    expect(r.valid).toBe(true);
    expect(r.providers).toEqual([{ index: 0, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false }, { index: 1, testTimeoutMs: 18_501, loopback: true, keyOptional: true, keyMoved: false }]);
    for (const row of r.providers) expect(Number.isInteger(row.testTimeoutMs)).toBe(true);
  });

  // PR 2 final r2 L4: under a structurally broken `provider.accounts` (the "— account failover disabled" warning) the
  // engine runs item 1 as ONE implicit entry, so its indexes are shifted from the written list's — the very numbering
  // these rows promise. No rows then (`--index` refuses such a config too), so the app cannot join a wrong one.
  test("a broken provider.accounts reports NO rows (its indexes would not be the written list's)", () => {
    const broken = { ...CLI, accounts: [{ label: "Same" }, { label: "Same", configDir: "/x" }] };
    const r = validateCandidate({ provider: broken, fallbacks: [{ label: "L", ...api("http://127.0.0.1:9/v1", 1_000) }] }, HOME, noEnv);
    expect(r.warnings.some((w) => w.field === "provider.accounts" && w.message.endsWith(SUFFIX))).toBe(true);
    expect(r.valid).toBe(true);
    expect(r.providers).toEqual([]);
    // The same list with the logins resolving reports one row per login, then the fallback.
    const ok = validateCandidate({ provider: { ...CLI, accounts: [{ label: "A" }, { label: "B", configDir: "/x" }] }, fallbacks: [{ label: "L", ...api("http://127.0.0.1:9/v1", 1_000) }] }, HOME, noEnv);
    expect(ok.providers).toEqual([
      { index: 0, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false }, { index: 1, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false }, { index: 2, testTimeoutMs: 18_000, loopback: true, keyOptional: true, keyMoved: false },
    ]);
  });

  test("the rows carry no label and no endpoint", () => {
    const r = validateCandidate({ provider: CLI, fallbacks: [{ label: "sk-ant-api03-LABELsecret", ...api("http://127.0.0.1:9/v1") }] }, HOME, noEnv);
    expect(JSON.stringify(r.providers)).not.toContain("LABELsecret");
    expect(JSON.stringify(r.providers)).not.toContain("127.0.0.1");
    for (const row of r.providers) expect(Object.keys(row).sort()).toEqual(["index", "keyMoved", "keyOptional", "loopback", "testTimeoutMs"]);
  });
});

// P3-M1-T0 (plan hub "PR 3 start"): each row names the app-owned key id the entry's key reference names (`appKeyId`,
// lowercase) and says the key is app-owned (`appOwnedKey: true`) — decided by the engine's own rule (`isAppOwnedKey`,
// through `appKeyOwnership`), so the app's `entries_referencing_key` and its uninstall refusal never re-implement it.
// Both fields are absent for a key the app does not own; `appOwnedKey` alone when no single id can be named.
describe("config validate names each entry's app-owned key id (P3-M1-T0)", () => {
  const ID = "k-0123456789ab";
  const remote = (key: Record<string, unknown>) => ({ api: { kind: "anthropic", model: "claude-sonnet-5", ...key } });
  const rowsOf = (...fbs: Record<string, unknown>[]) => {
    const r = validateCandidate({ provider: CLI, fallbacks: fbs.map((f, i) => ({ label: `F${i}`, ...f })) }, HOME, noEnv);
    expect(r.errors).toEqual([]);
    return r.providers;
  };
  const appCmd = (bin: string, ...tail: string[]) => [bin, "find-generic-password", ...tail];
  /** The Keychain binary by PATH, by its basename — built, never a literal (this file holds no binary-name literal). */
  const viaPath = basename(SECURITY_BIN);

  test("the canonical Keychain argv and the canonical <state>/keys/<id>.key name the id", () => {
    const rows = rowsOf(
      remote({ apiKeyCommand: appCmd(SECURITY_BIN, "-s", APP_KEY_SERVICE, "-a", ID, "-w", "/Users/u/Library/Keychains/login.keychain-db") }),
      remote({ apiKeyFile: join(keysDir(), `${ID}.key`) }),
    );
    expect(rows).toEqual([
      { index: 0, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false },
      { index: 1, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true, appKeyId: ID },
      { index: 2, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true, appKeyId: ID },
    ]);
  });

  // PR 3 final, the second post-cap fix (N1): ownership is the WIDE rule, but an id is named only by the exact argv the
  // app writes (src/providerList.ts `commandKeyIds`) — any spelling of the binary, any case of the id. A joined `-s`, the
  // argv without its keychain, and a service with no id are app-owned with NO id.
  test("the wide rule owns; only the exact app-written argv names the id: PATH binary and upper-case id do, a joined -s, no keychain, no id do not", () => {
    const KC = "/Users/u/Library/Keychains/login.keychain-db";
    const rows = rowsOf(
      remote({ apiKeyCommand: appCmd(viaPath, "-s", APP_KEY_SERVICE, "-a", ID, "-w", KC) }),
      remote({ apiKeyCommand: appCmd(SECURITY_BIN, `-s${APP_KEY_SERVICE}`, "-a", ID, "-w") }),
      remote({ apiKeyCommand: appCmd(SECURITY_BIN, "-s", APP_KEY_SERVICE, "-a", ID.toUpperCase(), "-w", KC) }),
      remote({ apiKeyCommand: appCmd(SECURITY_BIN, "-s", APP_KEY_SERVICE, "-w") }),
      remote({ apiKeyCommand: appCmd(SECURITY_BIN, "-s", APP_KEY_SERVICE, "-a", ID, "-w") }),
    );
    expect(rows.slice(1)).toEqual([
      { index: 1, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true, appKeyId: ID },
      { index: 2, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true },
      { index: 3, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true, appKeyId: ID },
      { index: 4, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true },
      { index: 5, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true },
    ]);
  });

  test("a `..` alias and a hard link to a key under <state>/keys/ name that key's id; the key's bytes appear nowhere", () => {
    const keys = keysDir();
    const existed = existsSync(keys);
    mkdirSync(join(keys, "sub"), { recursive: true });
    const SECRET = "sk-ant-api03-P3M1T0secretBytes";
    writeFileSync(join(keys, `${ID}.key`), SECRET);
    chmodSync(join(keys, `${ID}.key`), 0o600);
    const out = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-validate-keyid-")));
    symlinkSync(join(keys, "sub"), join(out, "link"));
    linkSync(join(keys, `${ID}.key`), join(out, "hard.key"));
    try {
      const r = validateCandidate({ provider: CLI, fallbacks: [
        { label: "Alias", ...remote({ apiKeyFile: `${out}/link/../${ID}.key` }) },     // raw: `join` would fold the `..`
        { label: "Hard link", ...remote({ apiKeyFile: join(out, "hard.key") }) },
      ] }, HOME, noEnv);
      expect(r.providers).toEqual([
        { index: 0, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false },
        { index: 1, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true, appKeyId: ID },
        { index: 2, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true, appKeyId: ID },
      ]);
      expect(JSON.stringify(r)).not.toContain("P3M1T0secret");
    } finally {
      if (!existed) rmSync(keys, { recursive: true, force: true });
      else { rmSync(join(keys, `${ID}.key`), { force: true }); rmSync(join(keys, "sub"), { recursive: true, force: true }); }
    }
  });

  test("a user's own key command, key file or env var, a literal key, and a CLI entry report neither field", () => {
    const own = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-validate-ownkey-")));
    writeFileSync(join(own, `${ID}.key`), "users-own-key-0000");                       // an id-shaped name outside keys/
    const LITERAL = "sk-ant-api03-LiteralKeyBytesP3M1T0";
    const r = validateCandidate({ provider: CLI, fallbacks: [
      { label: "Pass", ...remote({ apiKeyCommand: ["pass", "show", "lan-model"] }) },
      { label: "Own file", ...remote({ apiKeyFile: join(own, `${ID}.key`) }) },
      { label: "Env", ...remote({ apiKeyEnv: "MY_KEY" }) },
      { label: "Literal", ...remote({ apiKey: LITERAL }) },
      { label: "Codex", cli: "codex", argv: ["exec"], promptVia: "arg" },
    ] }, HOME, noEnv);
    expect(r.providers.length).toBe(6);
    for (const row of r.providers) expect(Object.keys(row).sort()).toEqual(["index", "keyMoved", "keyOptional", "loopback", "testTimeoutMs"]);
    expect(JSON.stringify(r.providers)).not.toContain("LiteralKeyBytes");
  });

  test("a broken provider.accounts still reports NO rows, an app-owned key among them included", () => {
    const broken = { ...CLI, accounts: [{ label: "Same" }, { label: "Same", configDir: "/x" }] };
    const r = validateCandidate({ provider: broken, fallbacks: [{ label: "K", ...remote({ apiKeyFile: join(keysDir(), `${ID}.key`) }) }] }, HOME, noEnv);
    expect(r.warnings.some((w) => w.field === "provider.accounts" && w.message.endsWith(SUFFIX))).toBe(true);
    expect(r.providers).toEqual([]);
  });
});

describe("the resolveAccounts warning suffix (pinned for the app's save gate)", () => {
  const disabling: [string, unknown, Record<string, string | undefined>?][] = [
    ["not an array", "a,b"],
    ["an entry not an object", ["a"]],
    ["an empty label", [{ label: "" }]],
    ["a non-string configDir", [{ label: "a", configDir: 5 }]],
    ["duplicate labels", [{ label: "a" }, { label: "a", configDir: "/x" }]],
    ["one login twice", [{ label: "a" }, { label: "b", configDir: "~/.claude" }]],
  ];
  for (const [name, raw] of disabling) {
    test(`${name}: the warning that disables the list ends with the suffix`, () => {
      const r = resolveAccounts(raw, HOME, noEnv, () => true);
      expect(r.accounts).toBeUndefined();
      expect(r.warnings.length).toBe(1);
      expect(r.warnings[0]!.endsWith(SUFFIX)).toBe(true);
    });
  }

  test("the two advisory warnings keep the list and do NOT end with the suffix", () => {
    const ambient = resolveAccounts(undefined, HOME, { CLAUDE_CONFIG_DIR: "/somewhere" }, () => true);
    expect(ambient.warnings.length).toBe(1);
    expect(ambient.warnings[0]!.endsWith(SUFFIX)).toBe(false);
    const unlogged = resolveAccounts([{ label: "a" }, { label: "b", configDir: "/never" }], HOME, noEnv, () => false);
    expect(unlogged.accounts?.length).toBe(2);
    expect(unlogged.warnings.length).toBe(1);
    expect(unlogged.warnings[0]!.endsWith(SUFFIX)).toBe(false);
  });
});

// P3-M1-T1 checkpoint MED: `config validate` (the app's save path, bounded there at 30 s) judges key ownership for EVERY
// `apiKeyFile` entry. On the sync shell a user's own key file on a stalled mount would block the command outright, so
// the CLI runs `validateCandidateBounded`: the same steps on the async shell under one total deadline, a row not decided
// in time failing CLOSED (`appOwnedKey: true`, no `appKeyId`), and every other part of the report unchanged.
describe("config validate's ownership rows are bounded (P3-M1-T1 checkpoint MED)", () => {
  const ID = "k-0123456789ab";
  const remote = (key: Record<string, unknown>) => ({ api: { kind: "anthropic", model: "claude-sonnet-5", ...key } });
  /** A filesystem every call of which never answers — a dead network mount. */
  const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);
  const STALLED: AsyncFsOps = { realpath: never, realpathNative: never, stat: never, lstat: never, readdir: never, readlink: never };
  const withoutOwnership = (r: ReturnType<typeof validateCandidate>) =>
    ({ ...r, providers: r.providers.map(({ index, testTimeoutMs, loopback, keyOptional, keyMoved }) => ({ index, testTimeoutMs, loopback, keyOptional, keyMoved })) });
  const candidate = () => {
    const own = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-validate-stall-")));
    writeFileSync(join(own, "lan.key"), "users-own-key-0000");
    return { provider: CLI, fallbacks: [
      { label: "Own file", ...remote({ apiKeyFile: join(own, "lan.key") }) },
      { label: "Keychain", ...remote({ apiKeyCommand: [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-a", ID, "-w", "/Users/u/Library/Keychains/login.keychain-db"] }) },
      { label: "Env", ...remote({ apiKeyEnv: "MY_KEY" }) },
      { label: "App file", ...remote({ apiKeyFile: join(keysDir(), `${ID}.key`) }) },
    ] };
  };

  test("the deadline is short and well inside the app's 30 s bound on this command", () => {
    expect(KEY_OWNERSHIP_REPORT_DEADLINE_MS).toBe(2_000);
    expect(KEY_OWNERSHIP_REPORT_DEADLINE_MS * 10).toBeLessThanOrEqual(30_000);
  });

  test("an unstalled filesystem gives exactly the sync report", async () => {
    const raw = candidate();
    const bounded = await validateCandidateBounded(raw, HOME, noEnv);
    expect(bounded).toEqual(validateCandidate(raw, HOME, noEnv));
    expect(bounded.providers.slice(1)).toEqual([
      { index: 1, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false },
      { index: 2, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true, appKeyId: ID },
      { index: 3, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false },
      { index: 4, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true, appKeyId: ID },
    ]);
  });

  test("a stalled filesystem: answered within the deadline, each file row fails closed, the rest of the report unchanged", async () => {
    const raw = candidate();
    const t0 = performance.now();
    const bounded = await validateCandidateBounded(raw, HOME, noEnv, { fs: STALLED, deadlineMs: 100 });
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(bounded.providers).toEqual([
      { index: 0, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false },
      { index: 1, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true },                 // the user's own file: not decided → closed
      { index: 2, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true, appKeyId: ID },   // a key command needs no filesystem answer
      { index: 3, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false },
      { index: 4, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true },                 // closed, and no id even for the canonical name
    ]);
    expect(withoutOwnership(bounded)).toEqual(withoutOwnership(validateCandidate(raw, HOME, noEnv)));
    expect(bounded.valid).toBe(true);
  });

  test("the default deadline is the one that fires", async () => {
    const t0 = performance.now();
    const bounded = await validateCandidateBounded(candidate(), HOME, noEnv, { fs: STALLED });
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(KEY_OWNERSHIP_REPORT_DEADLINE_MS - 50);
    expect(took).toBeLessThan(KEY_OWNERSHIP_REPORT_DEADLINE_MS + 3_000);
    expect(bounded.providers[1]).toEqual({ index: 1, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true });
  });
});
