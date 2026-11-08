// test/providerList.test.ts — the combined provider list (`src/providerList.ts`, provider-fallback plan P1-M2).
//
// The combined list is item 1's logins, then `fallbacks` in order (spec r9 §4). Every config here goes
// through `validateConfig` first, as `loadConfig` does, so the resolver is tested against what it really
// receives. Pure: nothing here reads or writes the state directory, the config folder or the Keychain.
import "./fixtures/isolate-state";
import { test, expect, describe, spyOn } from "bun:test";
import * as fsModule from "node:fs";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { validateConfig, resolveAccounts, apiTransportLabel, normalizeProviderBlock } from "../src/config";
import {
  APP_KEY_SERVICE, SECURITY_BIN, appKeyOwnership, entryRevision, isAppOwnedKey, resolveProviderList, type DropReason, type ListEntry, type ProviderList,
} from "../src/providerList";
import * as names from "../src/appKeyNames";
import { keysDir, supportDir } from "../src/marker";
import { TIMEOUT_MS, API_TIMEOUT_MS } from "../src/provider";
import { runLockInputs } from "../src/runlock";

const HOME = "/home/u";
const noEnv = {} as Record<string, string | undefined>;
const allExist = () => true;

const CLI = { cli: "claude", argv: ["-p"], promptVia: "stdin" } as const;
const ANTHROPIC_FB = { label: "Anthropic key", api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyEnv: "MY_KEY" } };
const LOCAL_FB = { label: "Local model", timeoutMs: 600_000, api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1" } };

function list(raw: Record<string, unknown>, env = noEnv): ProviderList {
  return resolveProviderList(validateConfig(raw, HOME), HOME, env, allExist);
}
const labels = (l: ProviderList) => l.entries.map((e) => e.label);

describe("item 1's label", () => {
  test("a CLI item 1 with resolving accounts: accounts[0].label, and every login in order", () => {
    const l = list({ provider: { ...CLI, accounts: [{ label: "Claude login 1" }, { label: "Claude login 2", configDir: "~/.claude-briefing" }] } });
    expect(labels(l)).toEqual(["Claude login 1", "Claude login 2"]);
    expect(l.entries.map((e) => e.configDir)).toEqual([undefined, "/home/u/.claude-briefing"]);
    expect(l.entries.map((e) => e.source)).toEqual(["provider", "provider"]);
    expect(l.warnings).toEqual([]);
    // The per-entry block is item 1's settings, without the list itself.
    expect(l.entries[1]!.provider).toEqual({ ...CLI, argv: ["-p"] });
  });

  test("a CLI item 1 without accounts: provider.label, else \"default\"; an empty accounts list is the same", () => {
    expect(labels(list({ provider: { ...CLI, label: "Mine" } }))).toEqual(["Mine"]);
    expect(labels(list({ provider: { ...CLI } }))).toEqual(["default"]);
    expect(labels(list({ provider: { ...CLI, accounts: [], label: "Mine" } }))).toEqual(["Mine"]);
  });

  test("an API item 1: provider.label, else \"default\"", () => {
    expect(labels(list({ provider: { api: ANTHROPIC_FB.api, label: "Key" } }))).toEqual(["Key"]);
    expect(labels(list({ provider: { api: ANTHROPIC_FB.api } }))).toEqual(["default"]);
  });

  test("provider.label beside resolving accounts is a warning and is ignored", () => {
    const l = list({ provider: { ...CLI, label: "Ignored", accounts: [{ label: "A" }, { label: "B", configDir: "/x" }] } });
    expect(labels(l)).toEqual(["A", "B"]);
    expect(l.warnings.length).toBe(1);
    expect(l.warnings[0]).toContain('"provider.label"');
  });

  test("a provider.label that is not a non-empty string warns and falls back to \"default\"", () => {
    for (const bad of ["", "  ", 5]) {
      const l = list({ provider: { ...CLI, label: bad } });
      expect(labels(l)).toEqual(["default"]);
      expect(l.warnings.some((w) => w.includes('"provider.label"'))).toBe(true);
    }
  });
});

describe("item 1's logins", () => {
  test("a broken accounts list keeps today's warning, runs item 1 as its implicit entry, and the list continues", () => {
    const l = list({ provider: { ...CLI, label: "Mine", accounts: [{ label: "a" }, { label: "a" }] }, fallbacks: [ANTHROPIC_FB] });
    expect(labels(l)).toEqual(["Mine", "Anthropic key"]);
    expect(l.warnings.filter((w) => w.endsWith("— account failover disabled")).length).toBe(1);
    expect(l.dropped).toEqual([]);
  });

  test("accounts beside an API item 1 are ignored: one entry, no login directory", () => {
    const l = list({ provider: { api: ANTHROPIC_FB.api, accounts: [{ label: "a" }, { label: "b", configDir: "/x" }] } });
    expect(labels(l)).toEqual(["default"]);
    expect(l.entries[0]!.configDir).toBeUndefined();
  });

  test("today's resolveAccounts output is byte-identical for an existing two-login fixture", () => {
    const raw = [{ label: "primary" }, { label: "fallback", configDir: "~/.claude-briefing" }];
    expect(JSON.stringify(resolveAccounts(raw, HOME, noEnv, allExist)))
      .toBe('{"accounts":[{"label":"primary"},{"label":"fallback","configDir":"/home/u/.claude-briefing"}],"warnings":[]}');
  });

  test("item 1's effective timeout is provider.timeoutMs, else TIMEOUT_MS for a CLI and API_TIMEOUT_MS for an API", () => {
    expect(list({ provider: { ...CLI, timeoutMs: 5_000 } }).entries[0]!.timeoutMs).toBe(5_000);
    expect(list({ provider: { ...CLI } }).entries[0]!.timeoutMs).toBe(TIMEOUT_MS);
    expect(list({ provider: { api: ANTHROPIC_FB.api } }).entries[0]!.timeoutMs).toBe(API_TIMEOUT_MS);
    expect(list({ provider: { api: ANTHROPIC_FB.api, timeoutMs: 5_000 } }).entries[0]!.timeoutMs).toBe(5_000);
    expect([TIMEOUT_MS, API_TIMEOUT_MS]).toEqual([120_000, 300_000]);
  });

  test("the run lock's staleness input follows the same default: 120 s for a CLI item 1, 5 min for an API one", () => {
    expect(runLockInputs(validateConfig({ provider: { ...CLI } }, HOME)).timeoutMs).toBe(TIMEOUT_MS);
    expect(runLockInputs(validateConfig({ provider: { api: ANTHROPIC_FB.api } }, HOME)).timeoutMs).toBe(API_TIMEOUT_MS);
    expect(runLockInputs(validateConfig({ provider: { api: ANTHROPIC_FB.api, timeoutMs: 5_000 } }, HOME)).timeoutMs).toBe(5_000);
  });
});

describe("fallbacks", () => {
  test("the spec's API-only shape resolves with the synthesized triple; isLoopback per endpoint; CLI is remote", () => {
    const l = list({ provider: { ...CLI }, fallbacks: [ANTHROPIC_FB, LOCAL_FB] });
    expect(labels(l)).toEqual(["default", "Anthropic key", "Local model"]);
    const [cli, key, local] = l.entries;
    expect(key!.provider).toMatchObject({ cli: apiTransportLabel("anthropic"), argv: [], promptVia: "stdin", api: ANTHROPIC_FB.api });
    expect(local!.provider).toMatchObject({ cli: apiTransportLabel("openai-compatible"), argv: [], promptVia: "stdin" });
    expect([cli!.isLoopback, key!.isLoopback, local!.isLoopback]).toEqual([false, false, true]);
    expect(l.entries.map((e) => e.source)).toEqual(["provider", "fallback", "fallback"]);
    expect(l.entries.map((e) => e.fallbackIndex)).toEqual([undefined, 0, 1]);
    expect(key!.provider).not.toHaveProperty("label");
  });

  test("a fallback without timeoutMs gets its kind's default (API_TIMEOUT_MS for an API, TIMEOUT_MS for a CLI), not provider.timeoutMs", () => {
    const l = list({ provider: { ...CLI, timeoutMs: 5_000 }, fallbacks: [ANTHROPIC_FB, LOCAL_FB, { ...CLI, label: "Second CLI", cli: "codex" }] });
    expect(l.entries.map((e) => e.timeoutMs)).toEqual([5_000, API_TIMEOUT_MS, 600_000, TIMEOUT_MS]);
  });

  test("a fallback's apiKeyFile `~/k` is expanded, as provider's is", () => {
    const l = list({ provider: { ...CLI }, fallbacks: [{ label: "F", api: { kind: "anthropic", model: "m", apiKeyFile: "~/k" } }] });
    expect(l.entries[1]!.provider.api!.apiKeyFile).toBe("/home/u/k");
  });

  test("a fallback CLI login's configDir `~/x` is expanded", () => {
    const l = list({ provider: { ...CLI }, fallbacks: [{ label: "F", ...CLI, configDir: "~/.claude-2" }] });
    expect(l.entries[1]!.configDir).toBe("/home/u/.claude-2");
  });

  test("one login directory is allowed once with subscription and once with env-api-key", () => {
    const l = list({ provider: { ...CLI }, fallbacks: [{ label: "Same dir, key", ...CLI, credential: "env-api-key" }] });
    expect(labels(l)).toEqual(["default", "Same dir, key"]);
    expect(l.dropped).toEqual([]);
  });

  test("a non-array fallbacks is dropped whole with a warning; item 1 still runs", () => {
    const l = list({ provider: { ...CLI }, fallbacks: { label: "x" } });
    expect(labels(l)).toEqual(["default"]);
    expect(l.dropped.map((d) => [d.index, d.reason])).toEqual([[undefined, "bad-shape"]]);
  });
});

describe("a broken fallback is dropped with a warning naming it, and the rest runs", () => {
  const cases: [string, unknown, DropReason][] = [
    ["not an object", "Local model", "bad-shape"],
    ["an array", [LOCAL_FB], "bad-shape"],
    ["no label", { api: LOCAL_FB.api }, "bad-shape"],
    ["an empty label", { label: " ", api: LOCAL_FB.api }, "bad-shape"],
    ["a nested fallbacks", { ...LOCAL_FB, fallbacks: [] }, "bad-shape"],
    ["a nested accounts", { label: "Nested", ...CLI, accounts: [{ label: "n" }] }, "bad-shape"],
    ["a bad block (kind)", { label: "Bad kind", api: { kind: "gemini", model: "x" } }, "bad-shape"],
    ["a bad block (no cli)", { label: "No cli", argv: [], promptVia: "stdin" }, "bad-shape"],
    ["a bad timeout", { ...LOCAL_FB, timeoutMs: -1 }, "bad-shape"],
    ["a non-string configDir", { label: "Dir", ...CLI, configDir: 7 }, "bad-shape"],
    ["a label used by item 1", { ...LOCAL_FB, label: "default" }, "duplicate-label"],
    ["configDir on a non-Claude CLI", { label: "Codex", cli: "codex", argv: ["exec"], promptVia: "arg", configDir: "/x" }, "config-dir"],
    ["configDir on an API entry", { ...ANTHROPIC_FB, label: "Key with dir", configDir: "/x" }, "config-dir"],
    ["item 1's login again", { label: "Again", ...CLI, configDir: "~/.claude" }, "duplicate-login"],
  ];
  for (const [name, entry, reason] of cases) {
    test(`${name} → ${reason}`, () => {
      const l = list({ provider: { ...CLI }, fallbacks: [ANTHROPIC_FB, entry, LOCAL_FB] });
      expect(labels(l)).toEqual(["default", "Anthropic key", "Local model"]);
      expect(l.dropped.length).toBe(1);
      const d = l.dropped[0]!;
      expect([d.index, d.reason]).toEqual([1, reason]);
      expect(d.warning).toStartWith("config: fallbacks[1]");
      const label = (entry as { label?: unknown } | null)?.label;
      if (typeof label === "string" && label.trim() !== "") expect(d.warning).toContain(`fallbacks[1] ${JSON.stringify(label)}:`);
      expect(l.warnings).toContain(d.warning);
    });
  }

  test("a fallback with neither a CLI triple nor an api block says what an entry needs, without the init hint", () => {
    const l = list({ provider: { ...CLI }, fallbacks: [{ label: "Half", argv: [], promptVia: "stdin" }] });
    const w = l.dropped[0]!.warning;
    expect(w).toContain('"fallbacks[0]" must be { cli, argv, promptVia } or an "api" block');
    expect(w).not.toContain("daily-briefing init");
  });

  test("a block error names the entry's own path, not provider's", () => {
    const l = list({ provider: { ...CLI }, fallbacks: [{ label: "No model", api: { kind: "anthropic" } }] });
    expect(l.dropped[0]!.warning).toContain('"fallbacks[0].api.model"');
    expect(l.dropped[0]!.warning).not.toContain('"provider.');
  });

  test("a duplicate between two fallbacks drops the second", () => {
    const l = list({ provider: { ...CLI }, fallbacks: [ANTHROPIC_FB, { ...ANTHROPIC_FB }] });
    expect(labels(l)).toEqual(["default", "Anthropic key"]);
    expect(l.dropped.map((d) => [d.index, d.reason])).toEqual([[1, "duplicate-label"]]);
  });

  test("a fallback cannot reuse one of item 1's logins under another label", () => {
    const l = list({ provider: { ...CLI, accounts: [{ label: "A" }, { label: "B", configDir: "/logins/b" }] }, fallbacks: [{ label: "C", ...CLI, configDir: "/logins/b" }] });
    expect(l.dropped.map((d) => d.reason)).toEqual(["duplicate-login"]);
  });
});

describe("normalizeProviderBlock", () => {
  test("is what validateConfig's provider path runs: same object for a CLI block, the synthesized one for an API block", () => {
    const cli = { ...CLI, argv: ["-p"] };
    expect(normalizeProviderBlock(cli, HOME)).toBe(cli);
    expect(validateConfig({ provider: cli }, HOME).provider).toBe(cli);
    const api = normalizeProviderBlock({ api: { kind: "anthropic", model: "m", apiKeyFile: "~/k" } }, HOME);
    expect(api).toEqual({ cli: apiTransportLabel("anthropic"), argv: [], promptVia: "stdin", api: { kind: "anthropic", model: "m", apiKeyFile: "/home/u/k" } });
    expect(() => normalizeProviderBlock(undefined, HOME)).toThrow(/"provider" must be/);
  });
});

// ── P1-M2-T2: the entry revision and the app-owned-key predicate ─────────────────────────────────────────

const entryOf = (raw: Record<string, unknown>, i = 1): ListEntry => list({ provider: { ...CLI }, fallbacks: [ANTHROPIC_FB, raw] }).entries.find((e) => e.fallbackIndex === i)!;
/** A literal key made of letters a hex digest can never contain, so any window of it is a real leak. */
const LITERAL = "sk-ZZQQ-literal-key-XYZW-mnop";

describe("entryRevision", () => {
  const base = { label: "F", api: { kind: "openai-compatible", model: "m", baseUrl: "https://llm.example/v1", apiKeyEnv: "K" } };
  const rev = (raw: Record<string, unknown>) => entryRevision(entryOf(raw));

  test("is stable, opaque, and blind to the label and the position", () => {
    expect(rev(base)).toBe(rev(base));
    expect(rev(base)).toMatch(/^[0-9a-f]{32}$/);
    expect(rev({ ...base, label: "Renamed" })).toBe(rev(base));
    const moved = list({ provider: { ...CLI }, fallbacks: [{ ...base, label: "First" }, ANTHROPIC_FB] }).entries.find((e) => e.label === "First")!;
    expect(entryRevision(moved)).toBe(rev(base));
    // Key order in the written block is not an input either.
    expect(rev({ label: "F", api: { apiKeyEnv: "K", baseUrl: "https://llm.example/v1", model: "m", kind: "openai-compatible" } })).toBe(rev(base));
  });

  test("changes with each listed input: the block, the login directory, the effective timeout, each key reference", () => {
    const variants: [string, Record<string, unknown>][] = [
      ["model", { ...base, api: { ...base.api, model: "m2" } }],
      ["baseUrl", { ...base, api: { ...base.api, baseUrl: "https://llm2.example/v1" } }],
      ["kind", { label: "F", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }],
      ["timeoutMs", { ...base, timeoutMs: 1_000 }],
      ["apiKeyEnv", { ...base, api: { ...base.api, apiKeyEnv: "K2" } }],
      ["apiKeyFile", { ...base, api: { kind: "openai-compatible", model: "m", baseUrl: "https://llm.example/v1", apiKeyFile: "/k/1" } }],
      ["apiKeyFile path", { ...base, api: { kind: "openai-compatible", model: "m", baseUrl: "https://llm.example/v1", apiKeyFile: "/k/2" } }],
      ["apiKeyCommand", { ...base, api: { kind: "openai-compatible", model: "m", baseUrl: "https://llm.example/v1", apiKeyCommand: ["pass", "a"] } }],
      ["apiKeyCommand argv", { ...base, api: { kind: "openai-compatible", model: "m", baseUrl: "https://llm.example/v1", apiKeyCommand: ["pass", "b"] } }],
      ["literal key", { ...base, api: { kind: "openai-compatible", model: "m", baseUrl: "https://llm.example/v1", apiKey: LITERAL } }],
      // Two variants that differ ONLY in the literal key (checkpoint LOW): the key enters the hash.
      ["another literal key", { ...base, api: { kind: "openai-compatible", model: "m", baseUrl: "https://llm.example/v1", apiKey: LITERAL + "2" } }],
    ];
    const seen = new Map<string, string>([[rev(base), "base"]]);
    for (const [name, raw] of variants) {
      const r = rev(raw);
      expect(`${name}: collides with ${seen.get(r) ?? "nothing"}`).toBe(`${name}: collides with nothing`);
      seen.set(r, name);
    }
    // CLI entries: the argv, and the login directory.
    const cliA = list({ provider: { ...CLI, accounts: [{ label: "A" }, { label: "B", configDir: "/logins/b" }] } }).entries;
    expect(entryRevision(cliA[0]!)).not.toBe(entryRevision(cliA[1]!));
    const cliArgv = list({ provider: { ...CLI, argv: ["-p", "--model", "x"] } }).entries[0]!;
    expect(entryRevision(cliArgv)).not.toBe(entryRevision(list({ provider: { ...CLI } }).entries[0]!));
  });

  test("is a 32-hex digest, not an encoding of a literal key", () => {
    // Checkpoint LOW: a byte-run test against a hex digest cannot fail for a key with non-hex letters. What
    // can go wrong is the revision BEING the key, encoded — so it is compared with the key's hex encoding.
    const r = rev({ ...base, api: { kind: "openai-compatible", model: "m", baseUrl: "https://llm.example/v1", apiKey: LITERAL } });
    expect(r).toMatch(/^[0-9a-f]{32}$/);
    const hex = Buffer.from(LITERAL, "utf8").toString("hex");
    expect(hex.includes(r) || r.includes(hex.slice(0, 32)) || hex.slice(0, 32) === r).toBe(false);
  });
});

describe("isAppOwnedKey", () => {
  test("the names are re-exported from src/appKeyNames.ts, unchanged", () => {
    expect(APP_KEY_SERVICE).toBe(names.APP_KEY_SERVICE);
    expect(SECURITY_BIN).toBe(names.SECURITY_BIN);
  });

  test("keysDir() is <state>/keys", () => {
    expect(keysDir()).toBe(join(supportDir(), "keys"));
  });

  const cmd = (argv: string[]) => entryOf({ label: "F", api: { kind: "anthropic", model: "m", apiKeyCommand: argv } });
  const file = (p: string) => entryOf({ label: "F", api: { kind: "anthropic", model: "m", apiKeyFile: p } });
  const appArgv = (service = APP_KEY_SERVICE, bin = SECURITY_BIN) => [bin, "find-generic-password", "-s", service, "-a", "k-3f9a1c2e8b7d", "-w", "/tmp/x.keychain-db"];

  test("a key command is app-owned by its SERVICE, whatever the binary (hub Q19)", () => {
    // Supersedes the plan's "refuses a different binary" case: spec §6 defines app-owned by the service and
    // forbids cleartext for it. (A false positive refuses the entry on every tick — hub Q26 — so a key COMMAND is
    // judged by what it names, the service or an app key id, never by its binary.) Each binary below is a
    // literal (this file's REACH_CONDITIONAL entry in isolation.meta covers them); none is ever run.
    expect(isAppOwnedKey(cmd(appArgv()))).toBe(true);
    for (const bin of ["security", "/usr/bin/Security", "/usr/bin/../bin/security", "/usr/local/bin/security", "my-keychain-helper"]) {
      expect(`${bin} → ${isAppOwnedKey(cmd(appArgv(APP_KEY_SERVICE, bin)))}`).toBe(`${bin} → true`);
    }
    // The service joined to its flag, and the service as any element.
    expect(isAppOwnedKey(cmd([SECURITY_BIN, "find-generic-password", `-s${APP_KEY_SERVICE}`, "-w"]))).toBe(true);
    expect(isAppOwnedKey(cmd([SECURITY_BIN, "find-generic-password", "-a", APP_KEY_SERVICE, "-w"]))).toBe(true);
    expect(isAppOwnedKey(cmd(["pass", "show", APP_KEY_SERVICE]))).toBe(true);
  });

  test("the service inside a shell string, joined behind a value-less flag, after `=`, and in another case (P1-M3 checkpoint)", () => {
    // Every argv element is split on whitespace, quotes and `=` before it is judged.
    expect(isAppOwnedKey(cmd(["/bin/sh", "-c", `security find-generic-password -s ${APP_KEY_SERVICE} -w`]))).toBe(true);
    expect(isAppOwnedKey(cmd(["/bin/sh", "-c", `security find-generic-password -s '${APP_KEY_SERVICE}' -w`]))).toBe(true);
    expect(isAppOwnedKey(cmd([SECURITY_BIN, "find-generic-password", `-ws${APP_KEY_SERVICE}`]))).toBe(true);
    expect(isAppOwnedKey(cmd(["my-helper", `--service=${APP_KEY_SERVICE}`]))).toBe(true);
    // Case-insensitive: whether the Keychain matches service names that way is unverified, so it goes strict.
    expect(isAppOwnedKey(cmd([SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE.toUpperCase()]))).toBe(true);
    expect(isAppOwnedKey(cmd([SECURITY_BIN, "find-generic-password", `-s${APP_KEY_SERVICE.toUpperCase()}`]))).toBe(true);
    // …and the near misses stay out.
    expect(isAppOwnedKey(cmd(["/bin/sh", "-c", `security find-generic-password -s x${APP_KEY_SERVICE} -w`]))).toBe(false);
    expect(isAppOwnedKey(cmd(["/bin/sh", "-c", `security find-generic-password -s ${APP_KEY_SERVICE}2 -w`]))).toBe(false);
    expect(isAppOwnedKey(cmd(["my-helper", "--service=other.service"]))).toBe(false);
  });

  test("shell punctuation and backslash escapes around the service are seen through (P1-M4 checkpoint)", () => {
    for (const script of [
      `security find-generic-password -s ${APP_KEY_SERVICE}; true`,
      `security find-generic-password -s ${APP_KEY_SERVICE}|tr -d x`,
      `(security find-generic-password -s ${APP_KEY_SERVICE})`,
      `security find-generic-password -s ${APP_KEY_SERVICE.replace("-", "\\-")} -w`,
      `k=\`security find-generic-password -s ${APP_KEY_SERVICE} -w\` && echo $k`,
      `{ security find-generic-password -s ${APP_KEY_SERVICE} -w; } 2>/dev/null`,
    ]) {
      expect(`${script} → ${isAppOwnedKey(cmd(["/bin/sh", "-c", script]))}`).toBe(`${script} → true`);
    }
    // A longer name that merely starts with the service is another item.
    expect(isAppOwnedKey(cmd(["pass", "show", `${APP_KEY_SERVICE}-backup`]))).toBe(false);
    expect(isAppOwnedKey(cmd(["pass", "show", `${APP_KEY_SERVICE}/k1`]))).toBe(false);
  });

  test("a key command that names another service is not app-owned", () => {
    // Without an app key id as the account (L6 makes `-a k-<12 hex>` app-owned whatever the service).
    const noId = (svc: string) => appArgv(svc).map((t) => (t === "k-3f9a1c2e8b7d" ? "someone@example.org" : t));
    expect(isAppOwnedKey(cmd(noId("other.service")))).toBe(false);
    expect(isAppOwnedKey(cmd(noId(APP_KEY_SERVICE + "2")))).toBe(false);
    expect(isAppOwnedKey(cmd(noId("x" + APP_KEY_SERVICE)))).toBe(false);
    expect(isAppOwnedKey(cmd(appArgv("other.service")))).toBe(true);   // L6: the account is an app key id
    expect(isAppOwnedKey(cmd([SECURITY_BIN, "find-generic-password", "-sother.service", "-w"]))).toBe(false);
    expect(isAppOwnedKey(cmd(["pass", "show", "cal/work"]))).toBe(false);
  });

  test("a key file: under the canonical <state>/keys/, and nowhere else", () => {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-appkey-")));
    const keys = join(state, "keys");
    mkdirSync(keys, { mode: 0o700 });
    writeFileSync(join(keys, "k-0123456789ab.key"), "x", { mode: 0o600 });
    mkdirSync(join(state, "outside"));
    writeFileSync(join(state, "outside", "k-0123456789ab.key"), "x", { mode: 0o600 });
    symlinkSync(join(state, "outside", "k-0123456789ab.key"), join(keys, "k-aaaaaaaaaaaa.key"));
    expect(isAppOwnedKey(file(join(keys, "k-0123456789ab.key")), keys)).toBe(true);
    expect(isAppOwnedKey(file(join(keys, "not-yet-written.key")), keys)).toBe(true);
    expect(isAppOwnedKey(file(join(state, "outside", "k-0123456789ab.key")), keys)).toBe(false);
    // Built as a RAW string: `join` would fold the `..` away before the predicate ever saw it. Hub Q26: a `..` path is
    // app-owned only when the file the kernel opens IS a key file under keys/ (same dev/ino) — this one is not.
    expect(isAppOwnedKey(file(`${keys}/../outside/k-0123456789ab.key`), keys)).toBe(false);
    expect(isAppOwnedKey(file(keys), keys)).toBe(false);
    expect(isAppOwnedKey(file(join(state, "keysX", "k.key")), keys)).toBe(false);
    // A symlink inside keys/ that resolves outside it is outside.
    expect(isAppOwnedKey(file(join(keys, "k-aaaaaaaaaaaa.key")), keys)).toBe(false);
    if (process.platform === "darwin") {
      expect(isAppOwnedKey(file(join(state, "KEYS", "k-0123456789ab.key")), keys)).toBe(true);
      expect(isAppOwnedKey(file(join(keys.toUpperCase(), "k-0123456789ab.key")), keys)).toBe(true);
    }
    // The default folder is keysDir().
    expect(isAppOwnedKey(file(join(keysDir(), "k-0123456789ab.key")))).toBe(true);
  });

  test("an existing key file reached through a symlinked parent is still inside (canonicalPath realpaths an existing path)", () => {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-appkey-")));
    const keys = join(state, "keys");
    mkdirSync(keys, { mode: 0o700 });
    writeFileSync(join(keys, "k-0123456789ab.key"), "x", { mode: 0o600 });
    // Reached through a symlinked parent outside keys/, the file is still the app's.
    symlinkSync(keys, join(state, "alias"));
    expect(isAppOwnedKey(file(`${state}/alias/k-0123456789ab.key`), keys)).toBe(true);
    // And the keys folder named through a symlinked parent still owns its real files.
    const other = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-appkey-link-")));
    symlinkSync(state, join(other, "state"));
    const keysViaLink = `${other}/state/keys`;
    expect(isAppOwnedKey(file(join(keys, "k-0123456789ab.key")), keysViaLink)).toBe(true);
  });

  test("an alias OUTSIDE keys/ whose `..` the kernel resolves INTO keys/ is app-owned (codex HIGH)", () => {
    // `<state>/outside/link` → `<keys>/sub`, so `<state>/outside/link/../k.key` IS `<keys>/k.key` to the kernel, while
    // a lexical `..` fold reads it as `<state>/outside/k.key`. Built as raw strings: `join` would fold the `..`.
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-appkey-")));
    const keys = join(state, "keys");
    mkdirSync(join(keys, "sub"), { recursive: true, mode: 0o700 });
    writeFileSync(join(keys, "k-0123456789ab.key"), "x", { mode: 0o600 });
    mkdirSync(join(state, "outside"));
    symlinkSync(join(keys, "sub"), join(state, "outside", "link"));
    expect(isAppOwnedKey(file(`${state}/outside/link/../k-0123456789ab.key`), keys)).toBe(true);
    // …also when a DECOY sits at the lexical answer (`<state>/outside/k.key`): a resolver that folds `..` first (both
    // `canonicalPath` and, measured, bun's realpath) would judge the decoy, not the file the kernel opens.
    writeFileSync(join(state, "outside", "k-0123456789ab.key"), "decoy", { mode: 0o600 });
    expect(isAppOwnedKey(file(`${state}/outside/link/../k-0123456789ab.key`), keys)).toBe(true);
    // A path with `..` that does not exist is NOT app-owned (hub Q26 (4)): the read fails the same way it does today.
    expect(isAppOwnedKey(file(`${state}/nowhere/../also-missing/k.key`), keys)).toBe(false);
    // A missing path WITHOUT `..`, outside keys/, stays outside.
    expect(isAppOwnedKey(file(`${state}/outside/missing.key`), keys)).toBe(false);
  });

  test("hub Q26: a relative key file is resolved against the cwd, as the reader opens it, then judged by the same rules", () => {
    // The cwd is the project, nowhere near the state folder's keys/, so none of these is app-owned any more.
    expect(isAppOwnedKey(file("k-0123456789ab.key"))).toBe(false);
    expect(isAppOwnedKey(file("./keys/k.key"))).toBe(false);
    expect(isAppOwnedKey(file("../x.key"))).toBe(false);
    // …and one that names a real key file through the cwd IS app-owned.
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-appkey-rel-")));
    const keys = join(state, "keys");
    mkdirSync(keys, { mode: 0o700 });
    writeFileSync(join(keys, "k-0123456789ab.key"), "x", { mode: 0o600 });
    expect(isAppOwnedKey(file(relative(process.cwd(), join(keys, "k-0123456789ab.key"))), keys)).toBe(true);
  });

  test("hub Q26: the reviewer's LAN model with a relative key file is NOT refused; a hard link to a keys/ file IS app-owned; no keys/ → not", () => {
    const lan = entryOf({ label: "LAN", api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://192.168.1.10:11434/v1", apiKeyFile: "ollama.key" } });
    expect(isAppOwnedKey(lan)).toBe(false);
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-appkey-hl-")));
    const keys = join(state, "keys");
    mkdirSync(keys, { mode: 0o700 });
    writeFileSync(join(keys, "k-0123456789ab.key"), "x", { mode: 0o600 });
    mkdirSync(join(state, "outside"));
    linkSync(join(keys, "k-0123456789ab.key"), join(state, "outside", "hard.key"));
    expect(isAppOwnedKey(file(join(state, "outside", "hard.key")), keys)).toBe(true);
    expect(isAppOwnedKey(file(join(state, "outside", "hard.key")), join(state, "no-keys-here"))).toBe(false);
  });

  test("round 2 H1: a RELATIVE `..` alias is judged as the reader opens it — not lexically folded — even with a decoy there", () => {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-appkey-relalias-")));
    const keys = join(state, "keys");
    mkdirSync(join(keys, "sub"), { recursive: true, mode: 0o700 });
    writeFileSync(join(keys, "k-0123456789ab.key"), "managed", { mode: 0o600 });
    mkdirSync(join(state, "outside"));
    symlinkSync(join(keys, "sub"), join(state, "outside", "link"));
    writeFileSync(join(state, "outside", "k-0123456789ab.key"), "decoy", { mode: 0o600 });   // the lexical fold's answer
    const cwd = process.cwd();
    process.chdir(join(state, "outside"));
    try {
      expect(readFileSync("link/../k-0123456789ab.key", "utf8")).toBe("managed");          // the premise: what a reader opens
      expect(isAppOwnedKey(file("link/../k-0123456789ab.key"), keys)).toBe(true);
    } finally { process.chdir(cwd); }
  });

  test("round 2 L2: a keys/ walk that cannot complete fails CLOSED (app-owned); keys/ missing stays not app-owned", () => {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-appkey-closed-")));
    const keys = join(state, "keys");
    mkdirSync(join(keys, "locked"), { recursive: true, mode: 0o700 });
    writeFileSync(join(keys, "locked", "k-0123456789ab.key"), "x", { mode: 0o600 });
    mkdirSync(join(state, "outside"));
    linkSync(join(keys, "locked", "k-0123456789ab.key"), join(state, "outside", "hard.key"));
    chmodSync(join(keys, "locked"), 0o300);                                   // stat and open work, readdir does not
    try {
      expect(isAppOwnedKey(file(join(state, "outside", "hard.key")), keys)).toBe(true);
    } finally { chmodSync(join(keys, "locked"), 0o700); }
    expect(isAppOwnedKey(file(join(state, "outside", "hard.key")), join(state, "no-such-keys"))).toBe(false);
  });

  test("round 2 M2: the provider.label-ignored warning never carries a key-shaped login label", () => {
    const KEY = "sk-ant-api03-Zq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-AbCdEfGhAA";
    const l = list({ provider: { ...CLI, label: "Main", accounts: [{ label: `Login ${KEY}` }] } });
    const w = l.warnings.find((x) => x.includes('"provider.label" is ignored'));
    expect(w).toBeDefined();
    expect(w).not.toContain("Zq9xR2bT7mVw");
  });

  test("L5: one tokenizer with the spawn guard — a service followed by a shell variable (`<svc>$1`) is app-owned", () => {
    expect(isAppOwnedKey(cmd(["/bin/sh", "-c", `security find-generic-password -s ${APP_KEY_SERVICE}$1 -w`]))).toBe(true);
  });

  test("L6: a find-generic-password ACCOUNT selector naming an app key id is app-owned too", () => {
    expect(isAppOwnedKey(cmd([SECURITY_BIN, "find-generic-password", "-a", "k-3f9a1c2e8b7d", "-w"]))).toBe(true);
    expect(isAppOwnedKey(cmd([SECURITY_BIN, "find-generic-password", "-ak-3f9a1c2e8b7d", "-w"]))).toBe(true);
    expect(isAppOwnedKey(cmd(["/bin/sh", "-c", "security find-generic-password -a k-3f9a1c2e8b7d -w"]))).toBe(true);
    expect(isAppOwnedKey(cmd([SECURITY_BIN, "find-generic-password", "-a", "someone@example.org", "-w"]))).toBe(false);
    expect(isAppOwnedKey(cmd(["my-helper", "k-3f9a1c2e8b7d"]))).toBe(false);
  });

  test("M2: a dropped fallback's warning never carries a key- or link-shaped label", () => {
    const KEY = "sk-ant-api03-Zq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-AbCdEfGhAA";
    const l = list({ provider: { ...CLI }, fallbacks: [{ label: `Bad ${KEY}` }, { label: "Cal https://calendar.google.com/calendar/ical/x/private-abc/basic.ics" }] });
    expect(l.dropped.length).toBe(2);
    const text = JSON.stringify([l.dropped.map((d) => d.warning), l.warnings]);
    expect(text).not.toContain("Zq9xR2bT7mVw");
    expect(text).not.toContain("calendar.google");
    expect(list({ provider: { ...CLI }, fallbacks: [{ label: "Plain" }] }).warnings[0]).toContain('fallbacks[0] "Plain"');
  });

  test("CLI entries, env keys and literal keys are not app-owned", () => {
    expect(isAppOwnedKey(list({ provider: { ...CLI } }).entries[0]!)).toBe(false);
    expect(isAppOwnedKey(entryOf({ label: "F", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }))).toBe(false);
    expect(isAppOwnedKey(entryOf({ label: "F", api: { kind: "anthropic", model: "m", apiKey: LITERAL } }))).toBe(false);
  });
});

describe("PR 1 final review round 3: isAppOwnedKey and entryRevision", () => {
  const file = (p: string) => entryOf({ label: "F", api: { kind: "anthropic", model: "m", apiKeyFile: p } });
  const cmd = (argv: string[]) => entryOf({ label: "F", api: { kind: "anthropic", model: "m", apiKeyCommand: argv } });
  const tmp = (tag: string) => removeAtRunEnd(mkdtempSync(join(tmpdir(), `dba-appkey-r3-${tag}-`)));

  test("M5: an OUTWARD `..` alias — <keys>/sub/../k.key with sub a symlink out of keys/ — is the outside file: not app-owned", () => {
    const state = tmp("outward");
    const keys = join(state, "keys");
    mkdirSync(keys, { recursive: true, mode: 0o700 });
    writeFileSync(join(keys, "k.key"), "managed", { mode: 0o600 });              // what the lexical fold names
    mkdirSync(join(state, "out", "dir"), { recursive: true });
    writeFileSync(join(state, "out", "k.key"), "outside", { mode: 0o600 });
    symlinkSync(join(state, "out", "dir"), join(keys, "sub"));
    const path = `${keys}/sub/../k.key`;
    expect(readFileSync(path, "utf8")).toBe("outside");                          // the premise: what the kernel opens
    expect(isAppOwnedKey(file(path), keys)).toBe(false);
  });

  test("L1: a <state>/keys that is itself a symlink to the folder still finds a hard link to a managed key", () => {
    const state = tmp("rootlink");
    const real = join(state, "real-keys");
    mkdirSync(real, { recursive: true, mode: 0o700 });
    writeFileSync(join(real, "k-0123456789ab.key"), "managed", { mode: 0o600 });
    symlinkSync(real, join(state, "keys"));
    mkdirSync(join(state, "outside"));
    linkSync(join(real, "k-0123456789ab.key"), join(state, "outside", "hard.key"));
    expect(isAppOwnedKey(file(join(state, "outside", "hard.key")), join(state, "keys"))).toBe(true);
    // …and a dangling root link is a missing keys/: not app-owned.
    const dangling = tmp("dangling");
    symlinkSync(join(dangling, "nowhere"), join(dangling, "keys"));
    expect(isAppOwnedKey(file(join(state, "outside", "hard.key")), join(dangling, "keys"))).toBe(false);
  });

  test("L2: a backslash-newline is a shell line continuation — the service split across it is one word", () => {
    const split = `${APP_KEY_SERVICE.slice(0, -3)}\\\n${APP_KEY_SERVICE.slice(-3)}`;
    expect(isAppOwnedKey(cmd(["/bin/sh", "-c", `${SECURITY_BIN} find-generic-password -s ${split} -w`]))).toBe(true);
    // A backslash-newline elsewhere still separates nothing that was not separate.
    expect(isAppOwnedKey(cmd(["/bin/sh", "-c", `my-helper \\\nget other.service`]))).toBe(false);
  });

  test("L12: keys/ present but its lstat fails with a code other than ENOENT/ENOTDIR fails CLOSED (real fs: an unsearchable parent)", () => {
    const state = tmp("eacces");
    const parent = join(state, "locked");
    mkdirSync(join(parent, "keys"), { recursive: true, mode: 0o700 });
    writeFileSync(join(state, "elsewhere.key"), "x", { mode: 0o600 });
    chmodSync(parent, 0o000);
    try {
      expect(isAppOwnedKey(file(join(state, "elsewhere.key")), join(parent, "keys"))).toBe(true);
    } finally { chmodSync(parent, 0o700); }
    expect(isAppOwnedKey(file(join(state, "elsewhere.key")), join(parent, "keys"))).toBe(false);   // the same, readable: not owned
  });

  test("L12: the walk's depth bound fails CLOSED (real fs: a folder nested past it); within the bound, not owned", () => {
    for (const [depth, owned] of [[8, false], [10, true]] as const) {
      const state = tmp(`depth${depth}`);
      const keys = join(state, "keys");
      mkdirSync(join(keys, ...Array.from({ length: depth }, (_, i) => `d${i}`)), { recursive: true, mode: 0o700 });
      writeFileSync(join(state, "elsewhere.key"), "x", { mode: 0o600 });
      expect(`${depth}: ${isAppOwnedKey(file(join(state, "elsewhere.key")), keys)}`).toBe(`${depth}: ${owned}`);
    }
  });

  test("L13: entryRevision includes the effective timeout on its own (the same block, another timeoutMs)", () => {
    const e = entryOf({ label: "F", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } });
    expect(entryRevision({ ...e, timeoutMs: e.timeoutMs + 1 })).not.toBe(entryRevision(e));
  });
});

describe("PR 1 final review round 4: key commands that reach an app key", () => {
  const cmd = (argv: string[]) => entryOf({ label: "F", api: { kind: "anthropic", model: "m", apiKeyCommand: argv } });
  test("L2: the service joined behind ANY short-flag cluster (`-l<svc>`, the label flag) is app-owned", () => {
    expect(isAppOwnedKey(cmd([SECURITY_BIN, "find-generic-password", `-l${APP_KEY_SERVICE}`, "-w"]))).toBe(true);
    expect(isAppOwnedKey(cmd([SECURITY_BIN, "find-generic-password", `-wl${APP_KEY_SERVICE}`]))).toBe(true);
    expect(isAppOwnedKey(cmd([SECURITY_BIN, "find-generic-password", `-l${APP_KEY_SERVICE}-backup`, "-w"]))).toBe(false);
  });

  test("L3: a command that reads an app key FILE by name (`k-<12 hex>.key`) is app-owned, directly or in a shell string", () => {
    expect(isAppOwnedKey(cmd(["cat", "/somewhere/keys/k-0123456789ab.key"]))).toBe(true);
    expect(isAppOwnedKey(cmd(["/bin/sh", "-c", "cat '/somewhere/keys/k-0123456789ab.key' | tr -d '\\n'"]))).toBe(true);
    expect(isAppOwnedKey(cmd(["cat", "k-0123456789ab.key"]))).toBe(true);
    for (const other of [["cat", "/x/k-0123456789ab.key.bak"], ["cat", "/x/notes.key"], ["cat", "/x/k-0123.key"]]) {
      expect(`${other.join(" ")}: ${isAppOwnedKey(cmd(other))}`).toBe(`${other.join(" ")}: false`);
    }
  });
});

test("round 4 L9: item 1's implicit login is the CLAUDE_CONFIG_DIR the CLI inherits — a fallback naming that folder is a duplicate login", () => {
  const raw = { provider: { ...CLI }, fallbacks: [{ label: "Same folder", ...CLI, configDir: "/logins/x" }] };
  const withEnv = list(raw, { CLAUDE_CONFIG_DIR: "/logins/x" });
  expect(withEnv.dropped.map((d) => [d.index, d.reason])).toEqual([[0, "duplicate-login"]]);
  expect(list(raw).dropped).toEqual([]);                                          // no env: <home>/.claude, a different login
  expect(list(raw, { CLAUDE_CONFIG_DIR: "/logins/y" }).dropped).toEqual([]);      // another folder: a different login
});

// B11 (PR 2 final harden round 1): ONE source for the key-id pattern (src/keyFile.ts), in two deliberate cases. The
// store writes lowercase hex, and validation (`--id`, the store's own ids) accepts only that; app-OWNERSHIP detection
// is case-insensitive, so an upper-case `-a K-…` still counts as app-owned — the fail-closed side of the https rule.
test("B11: one key-id source — validation is lowercase-only, ownership detection case-insensitive", async () => {
  const cmd = (argv: string[]) => entryOf({ label: "F", api: { kind: "anthropic", model: "m", apiKeyCommand: argv } });
  const kf = await import("../src/keyFile");
  const ks = await import("../src/keyStore");
  expect(ks.KEY_ID_RE).toBe(kf.KEY_ID_RE);                                      // the store's IS keyFile's, not a copy
  for (const [id, strict, any] of [["k-3f9a1c2e8b7d", true, true], ["K-3F9A1C2E8B7D", false, true], ["k-3F9a1c2e8b7d", false, true],
    ["k-3f9a1c2e8b7", false, false], ["k-3f9a1c2e8b7dd", false, false], ["x-3f9a1c2e8b7d", false, false]] as const) {
    expect(`${id} → ${kf.KEY_ID_RE.test(id)} ${kf.KEY_ID_ANYCASE_RE.test(id)}`).toBe(`${id} → ${strict} ${any}`);
  }
  expect(kf.KEY_FILE_RE.test("k-3f9a1c2e8b7d.key")).toBe(true);
  expect(kf.KEY_FILE_RE.test("K-3F9A1C2E8B7D.key")).toBe(false);
  expect(isAppOwnedKey(cmd([SECURITY_BIN, "find-generic-password", "-a", "K-3F9A1C2E8B7D", "-w"]))).toBe(true);
  expect(isAppOwnedKey(cmd([SECURITY_BIN, "find-generic-password", "-aK-3F9A1C2E8B7D", "-w"]))).toBe(true);
});

// B7: a broken `provider.accounts` is a STRUCTURAL flag on the list, so nothing keys on a warning's wording.
test("B7: accountsBroken is true exactly when a CLI item 1's accounts list collapsed to its implicit entry", () => {
  const broken = (accounts: unknown, provider: Record<string, unknown> = CLI) =>
    resolveProviderList(validateConfig({ repos: [], provider: { ...provider, accounts } }, HOME), HOME, noEnv, allExist).accountsBroken;
  for (const bad of ["nope", [1], [{ label: "" }], [{ label: "A", configDir: 3 }], [{ label: "A" }, { label: "A", configDir: "/x" }], [{ label: "A" }, { label: "B" }]]) {
    expect(`${JSON.stringify(bad)} → ${broken(bad)}`).toBe(`${JSON.stringify(bad)} → true`);
  }
  for (const fine of [undefined, null, [], [{ label: "A" }], [{ label: "A" }, { label: "B", configDir: "/logins/b" }]]) {
    expect(`${JSON.stringify(fine)} → ${broken(fine)}`).toBe(`${JSON.stringify(fine)} → false`);
  }
  // Beside an API item 1 `accounts` is ignored, not broken: both sides leave those logins out.
  expect(broken("nope", { api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } })).toBe(false);
});

test("round 5 L3: an app key file named in upper case (`K-0123456789AB.KEY`) still makes a key command app-owned", () => {
  const e = entryOf({ label: "F", api: { kind: "anthropic", model: "m", apiKeyCommand: ["cat", "/somewhere/keys/K-0123456789AB.KEY"] } });
  expect(isAppOwnedKey(e)).toBe(true);
});

// P3-M1-T0 (plan hub "PR 3 start" — closes the PR 2 final r3 B7 OPEN item): `config validate`'s rows name the app key id
// an entry's reference names, so the app's matcher and uninstall refusal never re-implement the ownership rule. ONE
// decision with `isAppOwnedKey`: `appKeyOwnership(e).owned` IS the predicate (agreement asserted on every case), and
// `id` is the one id it found, lowercase, in the store's own form — absent when the key is not app-owned, or is but no
// single id can be named (`owned: true` alone — the app fails closed on it).
describe("appKeyOwnership: the app key id an entry's reference names (P3-M1-T0)", () => {
  const ID = "k-3f9a1c2e8b7d";
  const OTHER = "k-0123456789ab";
  const cmd = (argv: string[]) => entryOf({ label: "F", api: { kind: "anthropic", model: "m", apiKeyCommand: argv } });
  const file = (p: string) => entryOf({ label: "F", api: { kind: "anthropic", model: "m", apiKeyFile: p } });
  /** The ownership answer, checked against the boolean predicate on the way (one decision, two shapes). */
  const own = (e: ListEntry, keys?: string): string => {
    const o = appKeyOwnership(e, keys);
    expect(o.owned).toBe(isAppOwnedKey(e, keys));
    return o.owned ? `owned ${o.id ?? "(no id)"}` : "not owned";
  };
  const canonical = (bin = SECURITY_BIN) => [bin, "find-generic-password", "-s", APP_KEY_SERVICE, "-a", ID, "-w", "/tmp/x.keychain-db"];

  // PR 3 final, the second post-cap fix (N1, the third recurrence of r4 A1 / r5 A1): the engine no longer reads shell
  // text for an id. A key command names an app key id ONLY when its argv is exactly what `appKeyCommand` writes
  // (src/keyStore.ts) — `<bin> find-generic-password -s <service> -a <id> -w <keychain>`, eight elements, whatever the
  // binary's spelling and the (absolute) keychain path. Every other command naming the service is app-owned with NO id, which keeps
  // every app key (the app reads that row as "may read ANY app key").
  test("the canonical argv names its id: the binary by any spelling, any absolute keychain path, an upper-case id lowercased", () => {
    expect(own(cmd(canonical()))).toBe(`owned ${ID}`);
    // Each binary below is a literal (this file's REACH_CONDITIONAL entry in isolation.meta covers them); none is run.
    for (const bin of ["security", "/usr/bin/../bin/security", "/usr/bin/Security"]) expect(`${bin}: ${own(cmd(canonical(bin)))}`).toBe(`${bin}: owned ${ID}`);
    const at = (keychain: string, id = ID) => cmd([SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-a", id, "-w", keychain]);
    // The keychain is the tool's own operand (no shell reads it): spaces, brackets, a dollar sign, a hash, even an id-shaped run.
    for (const keychain of [
      "/Users/J Smith/Library/Keychains/login.keychain-db",
      "/Users/J Smith (old)/Library/Keychains/login.keychain-db",
      "/Users/$J #1/Library/Keychains/login.keychain-db",
      `/Users/${OTHER}/Library/Keychains/login.keychain-db`,
    ]) expect(`${keychain}: ${own(at(keychain))}`).toBe(`${keychain}: owned ${ID}`);
    expect(own(at("/tmp/x.keychain-db", ID.toUpperCase()))).toBe(`owned ${ID}`);
  });

  test("any other command naming the service is owned with NO id — every form the shell reader used to name, and every leak probe", () => {
    const sh = (script: string, ...rest: string[]) => ["/bin/sh", "-c", script, ...rest];
    const KC = "/tmp/x.keychain-db";
    const LOOKUP = `security find-generic-password -s ${APP_KEY_SERVICE} -w`;
    const SELECTED = `security find-generic-password -s ${APP_KEY_SERVICE} -a ${ID} -w`;
    const fgp = (...tail: string[]) => [SECURITY_BIN, "find-generic-password", ...tail];
    const noId: [string, string[]][] = [
      // N1's two proofs (the compiled engine named the decoy's id): a nested shell re-reads quoted text.
      ["N1 eval", sh(`eval '${LOOKUP}' || ${SELECTED}`)],
      ["N1 split id", sh(`sh -c 'security find-generic-password -s ${APP_KEY_SERVICE} -a k-012345\\6789ab -w' || ${SELECTED}`)],
      // The canonical lookup itself, but wrapped or re-shaped: these named the id before, and now name none.
      ["sh -c canonical", sh(`security find-generic-password -s ${APP_KEY_SERVICE} -a ${ID} -w ${KC}`)],
      ["sh -c, no keychain", sh(SELECTED)],
      ["sh -c, quoted id and keychain", sh(`security find-generic-password -s ${APP_KEY_SERVICE} -a "${ID}" -w '/Users/J Smith/Library/Keychains/login.keychain-db'`)],
      ["sh -c, then true", sh(`${SELECTED}; true`)],
      ["sh -c, | tr", sh(`true; security find-generic-password -a ${ID} -w | tr -d '\\n'`)],
      ["sh -c, continuation", sh(`security find-generic-password -s ${APP_KEY_SERVICE} \\\n -a ${ID} -w`)],
      ["sh -c, the same id twice", sh(`security find-generic-password -a ${ID} -w || security find-generic-password -a ${ID} -w`)],
      ["sh -c, if", sh(`if security find-generic-password -a ${ID} -w; then true; fi`)],
      ["sh -c, quote-split id", sh(`security find-generic-password -s ${APP_KEY_SERVICE} -a k-3f9a"1c2e8b7d" -w`)],
      ["sh -c, env LC_ALL", sh(`env LC_ALL=C security find-generic-password -wa ${ID} | tr -d '\\n'`)],
      ["sh -c, or a key file", sh(`${SELECTED} || cat /k/${ID}.key`)],
      ["env security", ["env", "security", "find-generic-password", "-s", APP_KEY_SERVICE, "-a", ID, "-w"]],
      ["env security, with keychain", ["env", "security", "find-generic-password", "-s", APP_KEY_SERVICE, "-a", ID, "-w", KC]],
      // A key file read by a command (the app never writes that as a command; an `apiKeyFile` is unaffected).
      ["cat <id>.key", ["cat", `/somewhere/keys/${ID}.key`]],
      ["cat <ID>.KEY", ["cat", `/somewhere/keys/${ID.toUpperCase()}.KEY`]],
      // The length: seven elements (no keychain) and nine.
      ["7 words", fgp("-s", APP_KEY_SERVICE, "-a", ID, "-w")],
      ["9 words", fgp("-s", APP_KEY_SERVICE, "-a", ID, "-w", KC, "x")],
      ["9 words, a path with brackets", fgp("-s", APP_KEY_SERVICE, "-a", ID, "-w", "/Users/J (old)/kc", "x")],
      // Eight elements, but not the shape: the flag order, a duplicate `-a`, another flag, another verb, another service.
      ["-a before -s", fgp("-a", ID, "-s", APP_KEY_SERVICE, "-w", KC)],
      ["-w first", fgp("-w", "-s", APP_KEY_SERVICE, "-a", ID, KC)],
      ["keychain before -w", fgp("-s", APP_KEY_SERVICE, "-a", ID, KC, "-w")],
      ["duplicate -a", fgp("-a", ID, "-a", ID, "-w", KC)],
      ["duplicate -a, two ids", fgp("-a", OTHER, "-a", ID, "-w", KC)],
      ["-g for -w", fgp("-s", APP_KEY_SERVICE, "-a", ID, "-g", KC)],
      ["-l for -s", fgp("-l", APP_KEY_SERVICE, "-a", ID, "-w", KC)],
      ["-j for -a", fgp("-s", APP_KEY_SERVICE, "-j", ID, "-w", KC)],
      ["-l for -a", fgp("-s", APP_KEY_SERVICE, "-l", ID, "-w", KC)],
      ["--account", fgp("-s", APP_KEY_SERVICE, "--account", ID, "-w", KC)],
      ["the service upper-cased", fgp("-s", APP_KEY_SERVICE.toUpperCase(), "-a", ID, "-w", KC)],
      ["another service", fgp("-s", "other.service", "-a", ID, "-w", KC)],
      ["the service with a suffix", fgp("-s", `${APP_KEY_SERVICE}x`, "-a", ID, "-w", KC)],
      ["another verb", [SECURITY_BIN, "find-internet-password", "-s", APP_KEY_SERVICE, "-a", ID, "-w", KC]],
      ["the verb upper-cased", [SECURITY_BIN, "FIND-GENERIC-PASSWORD", "-s", APP_KEY_SERVICE, "-a", ID, "-w", KC]],
      ["not an id at [5]", fgp("-s", APP_KEY_SERVICE, "-a", "someone", "-w", KC)],
      ["an id with a suffix at [5]", fgp("-s", APP_KEY_SERVICE, "-a", `${ID}x`, "-w", KC)],
      ["the id at [7]", fgp("-s", APP_KEY_SERVICE, "-a", "someone", "-w", ID)],
      // Joined flags (the tool would read them; the app never writes them).
      ["joined -s", fgp(`-s${APP_KEY_SERVICE}`, "-a", ID, "-w")],
      ["joined -a", fgp("-s", APP_KEY_SERVICE, `-a${ID}`, "-w")],
      ["by account only", fgp(`-a${ID}`, "-w")],
      ["-wa <id>", fgp("-s", APP_KEY_SERVICE, "-wa", ID)],
      ["-wa<id>", fgp("-s", APP_KEY_SERVICE, `-wa${ID}`)],
      // No selector, or a stray id beside one (the P3-M1-T1 checkpoint's probes).
      ["pass show", ["pass", "show", APP_KEY_SERVICE]],
      ["selector-less lookup", fgp("-s", APP_KEY_SERVICE, "-w")],
      ["selector-less, with keychain", fgp("-s", APP_KEY_SERVICE, "-w", KC)],
      ["two lookups, two ids", sh(`security find-generic-password -s ${APP_KEY_SERVICE} -a ${ID} -w || security find-generic-password -s ${APP_KEY_SERVICE} -a ${OTHER} -w`)],
      ["echo beside a lookup", sh(`echo ${ID}; ${LOOKUP}`)],
      ["echo beside pass", sh(`echo ${ID}; pass show ${APP_KEY_SERVICE}`)],
      ["my-reader", ["my-reader", "--service", APP_KEY_SERVICE, "--item", ID]],
      ["a stray -j", fgp("-s", APP_KEY_SERVICE, "-a", ID, "-j", OTHER, "-w")],
      ["a selector-less second lookup", sh(`${SELECTED} || ${LOOKUP}`)],
      ["cat with a stray", sh(`cat /k/${ID}.key ${OTHER}.bak; echo ${APP_KEY_SERVICE}`)],
      // PR 3 final r4's probes: a selector in another command.
      ["; true -a", sh(`${LOOKUP}; true -a ${ID}`)],
      ["| tee -a", sh(`${LOOKUP} | tee -a ${ID}`)],
      ["|| a selector-only lookup", sh(`${LOOKUP} || security find-generic-password -a ${ID} -w`)],
      ["true -a before", sh(`true -a ${ID}; ${LOOKUP}`)],
      ["$( ) -a", sh(`echo $(${LOOKUP}) -a ${ID}`)],
      ["backtick -a", sh(`echo \`${LOOKUP}\` -a ${ID}`)],
      ["$1 -a", sh(LOOKUP, "-a", ID)],
      // PR 3 final r5's probes: a comment, here-strings, `$IFS`, a quoted separator, more than one selector, options.
      ["# -a", sh(`${LOOKUP} # -a ${ID}`)],
      ["<<< \"-a\"", sh(`${LOOKUP} <<< "-a ${ID}"`)],
      ["<<< '-a'", sh(`${LOOKUP} <<< '-a ${ID}'`)],
      ["$IFS", sh(`security$IFS"find-generic-password"$IFS-s$IFS"${APP_KEY_SERVICE}"$IFS-w<<<"-a""${ID}"`)],
      ["eval '&&'", sh(`eval ${LOOKUP} '&&' true -a ${ID}`)],
      ["eval \";\"", sh(`eval ${LOOKUP} ";" true -a ${ID}`)],
      ["2>/dev/null", sh(`${SELECTED} 2>/dev/null`)],
      ["two -a in a shell string", sh(`security find-generic-password -a ${ID} -s ${APP_KEY_SERVICE} -a ${ID} -w`)],
      ["-l swallows -a", fgp("-l", "-a", ID, "-w")],
      ["-la", fgp("-la", ID, "-w")],
      ["-A", fgp("-s", APP_KEY_SERVICE, "-A", ID, "-w")],
      ["-xa", fgp("-s", APP_KEY_SERVICE, "-xa", ID, "-w")],
      ["after the keychain", fgp("-w", KC, "-a", ID)],
      ["after --", fgp("--", "-a", ID)],
      ["a second lookup word", fgp("-s", APP_KEY_SERVICE, "-w", "find-generic-password", "-a", ID)],
      ["pass show -a", ["pass", "show", APP_KEY_SERVICE, "-a", ID]],
      ["an open lookup at the end", ["cat", `/k/${ID}.key`, "find-generic-password"]],
      // Scoped review 2, F1: a dash-led eighth element is read by `security`'s getopt as a further option (a second
      // account selector), so the keychain must be absolute; and F3: the flags are those words exactly, in their case.
      ["-a<id> in the keychain's place", fgp("-s", APP_KEY_SERVICE, "-a", ID, "-w", `-a${OTHER}`)],
      ["-wa<id> in the keychain's place", fgp("-s", APP_KEY_SERVICE, "-a", ID, "-w", `-wa${OTHER}`)],
      ["-s<x> in the keychain's place", fgp("-s", APP_KEY_SERVICE, "-a", ID, "-w", "-sother")],
      ["a relative keychain", fgp("-s", APP_KEY_SERVICE, "-a", ID, "-w", "login.keychain-db")],
      ["-S for -s", fgp("-S", APP_KEY_SERVICE, "-a", ID, "-w", KC)],
      ["-A for -a", fgp("-s", APP_KEY_SERVICE, "-A", ID, "-w", KC)],
      ["-W for -w", fgp("-s", APP_KEY_SERVICE, "-a", ID, "-W", KC)],
    ];
    for (const [name, argv] of noId) expect(`${name}: ${own(cmd(argv))}`).toBe(`${name}: owned (no id)`);
  });

  test("a user's own key command or file, a key in env, and a CLI entry name nothing", () => {
    expect(own(cmd(["pass", "show", "lan-model"]))).toBe("not owned");
    expect(own(cmd(["my-helper", ID]))).toBe("not owned");                                // an id-shaped word alone is not ownership
    expect(own(file("/home/u/ollama.key"))).toBe("not owned");
    expect(own(entryOf({ label: "F", api: { kind: "anthropic", model: "m", apiKeyEnv: "MY_KEY" } }))).toBe("not owned");
    const cliEntry = list({ provider: { ...CLI } }).entries[0]!;
    expect(own(cliEntry)).toBe("not owned");
  });

  test("a key file: the canonical <keys>/<id>.key (written or not), a `..` alias and a hard link name the id of the file under keys/", () => {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-appkey-id-")));
    const keys = join(state, "keys");
    mkdirSync(join(keys, "sub"), { recursive: true, mode: 0o700 });
    writeFileSync(join(keys, `${ID}.key`), "x", { mode: 0o600 });
    mkdirSync(join(state, "outside"));
    symlinkSync(join(keys, "sub"), join(state, "outside", "link"));
    linkSync(join(keys, `${ID}.key`), join(state, "outside", "hard.key"));
    expect(own(file(join(keys, `${ID}.key`)), keys)).toBe(`owned ${ID}`);
    expect(own(file(join(keys, `${OTHER}.key`)), keys)).toBe(`owned ${OTHER}`);                // not written yet: by its name
    expect(own(file(`${state}/outside/link/../${ID}.key`), keys)).toBe(`owned ${ID}`);          // raw: `join` would fold `..`
    expect(own(file(join(state, "outside", "hard.key")), keys)).toBe(`owned ${ID}`);            // by the walk's (dev, ino)
    // App-owned with no id-shaped name: owned, no id.
    expect(own(file(join(keys, "not-a-key-id.key")), keys)).toBe("owned (no id)");
    // A user's own file elsewhere names nothing.
    writeFileSync(join(state, "outside", `${ID}.key`), "user's own", { mode: 0o600 });
    expect(own(file(join(state, "outside", `${ID}.key`)), keys)).toBe("not owned");
    // The default folder is keysDir().
    expect(own(file(join(keysDir(), `${ID}.key`)))).toBe(`owned ${ID}`);
  });

  test("an entry with BOTH an app-owned key command and an app key file reports one id only when both name the same one", () => {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-appkey-id-both-")));
    const keys = join(state, "keys");
    mkdirSync(keys, { mode: 0o700 });
    const both = (argv: string[], p: string) => entryOf({ label: "F", api: { kind: "anthropic", model: "m", apiKeyCommand: argv, apiKeyFile: p } });
    // Every reference counts (the matcher asks "does ANY reference name this key?"), not only the one the ladder reads.
    expect(own(both(canonical(), join(keys, `${ID}.key`)), keys)).toBe(`owned ${ID}`);
    expect(own(both(canonical(), join(keys, `${OTHER}.key`)), keys)).toBe("owned (no id)");
    expect(own(both(["pass", "show", APP_KEY_SERVICE], join(keys, `${ID}.key`)), keys)).toBe("owned (no id)");
    // A user's own command beside an app key file: the file's id.
    expect(own(both(["pass", "show", "lan-model"], join(keys, `${ID}.key`)), keys)).toBe(`owned ${ID}`);
    // An app-owned command beside a user's own file: the command's id.
    expect(own(both(canonical(), join(state, "mine.key")), keys)).toBe(`owned ${ID}`);
  });

  test.skipIf(process.getuid?.() === 0)("a keys/ walk that cannot complete: owned (fail closed), and no id can be named", () => {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-appkey-id-closed-")));
    const keys = join(state, "keys");
    mkdirSync(join(keys, "locked"), { recursive: true, mode: 0o700 });
    writeFileSync(join(keys, "locked", `${ID}.key`), "x", { mode: 0o600 });
    mkdirSync(join(state, "outside"));
    linkSync(join(keys, "locked", `${ID}.key`), join(state, "outside", "hard.key"));
    // Only the walk may decide here, so realpath is held to the name it was asked about. On macOS either realpath can
    // answer with ANOTHER link to the same file (measured: 5 of 15000 under load, realpathSync and its .native alike).
    // That answer is `<keys>/locked/<id>.key`, inside keys/, and it names the id before the walk runs.
    const hard = join(state, "outside", "hard.key");
    const real = realpathSync.native;
    const asked = join(real(join(state, "outside")), "hard.key");
    const answer = ((p: string) => (p === hard ? asked : real(p))) as typeof realpathSync;
    chmodSync(join(keys, "locked"), 0o300);
    const spy = spyOn(fsModule, "realpathSync").mockImplementation(answer);
    (fsModule.realpathSync as typeof realpathSync).native = answer;
    try {
      expect(own(file(hard), keys)).toBe("owned (no id)");
    } finally { spy.mockRestore(); chmodSync(join(keys, "locked"), 0o700); }
  });
});
