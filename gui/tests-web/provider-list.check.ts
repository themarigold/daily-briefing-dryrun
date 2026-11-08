/**
 * P3-M3-T1 — "Providers, in order": the list reader and writer in `lib/provider-list.ts` (spec r9 §4 "Storing the
 * list", §6 "The settings guard" and "Settings → Providers, in order").
 *
 * ⚠ THE AUTHORITY IS THE ENGINE, RUN HERE. What a written config MEANS is decided by the engine's own code, imported
 * READ-ONLY (the `settings.check.ts` / `wizard.check.ts` precedent): `validateConfig` + `resolveProviderList` (the
 * combined list a run walks) and `validateConfig` + `resolveAccounts` (what an OLDER engine, and the audit judge,
 * read: `provider` and its `accounts`, nothing else — `scripts/audit.ts` builds the judge from `cfg.provider` and
 * `resolveAccounts(cfg.provider.accounts)`). Every "reads the same" assertion below runs those functions on the
 * written config; none re-derives the answer from the module under test. The expected `accounts` / `fallbacks`
 * split of each edit is written out by hand per case, never computed.
 *
 * Every engine call gets a fake home, an empty env (or, for the CLAUDE_CONFIG_DIR fixtures, a fake value of it) and
 * an `exists` that answers true, so nothing reads the real home, the real `CLAUDE_CONFIG_DIR` or the disk. The module itself is pure (no IPC, no fs): this file scans its source
 * for `invoke(` and `node:` to keep it that way.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";

// READ-ONLY imports of the engine (no top-level side effects).
import { expandTilde, normalizeProviderBlock, resolveAccounts, validateConfig } from "../../src/config";
import { APP_KEY_SERVICE, PROVIDER_LABEL_INVALID, resolveProviderList, SECURITY_BIN } from "../../src/providerList";
import { DEFAULT_LABEL as ENGINE_DEFAULT_LABEL } from "../../src/account";
import { API_TIMEOUT_MS, TIMEOUT_MS } from "../../src/provider";
import { claudeShaped } from "../../src/harden";
import * as list from "../src/lib/provider-list";
import {
  DEFAULT_LABEL,
  insertEntry,
  isClaudeCli,
  moveEntry,
  readProviderList,
  removeEntry,
  setEntrySettings,
  writeProviderList,
  type Blocked,
  type ProviderEntry,
  type ReadRefusal,
} from "../src/lib/provider-list";
import { REDACTED_API_KEY } from "../src/lib/files";

type Json = Record<string, unknown>;

const HOME = "/nonexistent-home-for-provider-list-check";
const ENV: Record<string, string | undefined> = {};
const EXISTS = (): boolean => true;

/** PR 2's scrub sentinel, read from the engine↔app contract (`docs/gui-seam.md` §1d). Not from the engine module
 *  that defines it: that module reaches the scheduler installer, which `coexistence.check.ts`'s import pin forbids
 *  every file here to name. The engine pins its own constant (`test/provider.scrub.test.ts`). */
const KEY_MOVED_ENV = (() => {
  const src = readFileSync(new URL("../../docs/gui-seam.md", import.meta.url), "utf8");
  const m = /`apiKeyEnv: "([A-Z_]+)"`, a variable nothing sets/.exec(src);
  if (m === null) throw new Error("the scrub sentinel is not named in docs/gui-seam.md");
  return m[1]!;
})();

const KEYCHAIN = `${HOME}/Library/Keychains/login.keychain-db`;
const appKeyCommand = (id: string): string[] => [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-a", id, "-w", KEYCHAIN];

const CLAUDE = { cli: "claude", argv: ["-p", "--model", "claude-sonnet-5"], promptVia: "stdin" };

// ── fixtures: configs as `config_read` hands them to the webview (a literal key is the placeholder) ──

/** The spec §4 example: two leading logins, an app-owned key, a local model. */
const SPEC_EXAMPLE = (): Json => ({
  repos: ["~/code"],
  provider: {
    ...CLAUDE,
    timeoutMs: 180000,
    accounts: [{ label: "Claude login 1" }, { label: "Claude login 2", configDir: "~/.claude-briefing" }],
  },
  fallbacks: [
    { label: "Anthropic key", api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyCommand: appKeyCommand("k-3f9a1c2e8b7d") } },
    { label: "Local model", timeoutMs: 600000, api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1" } },
  ],
  networkProbeHosts: [],
});

const SINGLE_CLI = (): Json => ({ provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });

/** An API item 1 holding a literal key (redacted), named by `provider.label`. */
const API_LITERAL_FIRST = (): Json => ({
  provider: { label: "Key A", api: { kind: "anthropic", model: "claude-sonnet-5", apiKey: REDACTED_API_KEY } },
  fallbacks: [
    { label: "Local", api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1" } },
    { label: "Key C", api: { kind: "anthropic", model: "claude-haiku-5", apiKey: REDACTED_API_KEY } },
    { label: "Codex", cli: "codex", argv: ["exec"], promptVia: "stdin" },
  ],
});

/** PR 2's shapes: the scrub sentinel, an app-owned key file and an app-owned key command. */
const PR2_SHAPES = (): Json => ({
  provider: { label: "Moved", api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyEnv: KEY_MOVED_ENV } },
  fallbacks: [
    { label: "App file key", api: { kind: "anthropic", model: "claude-haiku-5", apiKeyFile: "~/.local/state/daily-briefing/keys/k-0123456789ab.key" } },
    { label: "App keychain key", api: { kind: "openai-compatible", model: "gpt-x", baseUrl: "https://example.invalid/v1", apiKeyCommand: appKeyCommand("k-ba9876543210") } },
    { label: "Also moved", api: { kind: "openai-compatible", model: "m", baseUrl: "https://example.invalid/v1", apiKeyEnv: KEY_MOVED_ENV } },
  ],
});

/** Shapes the engine ignores at item 1, which a no-op save must keep byte for byte. */
const IGNORED_FIELDS: Record<string, () => Json> = {
  "accounts beside an API item 1 (ignored, today's warning)": () => ({
    provider: { api: { kind: "anthropic", model: "m", apiKeyEnv: "MY_KEY" }, accounts: [{ label: "stale" }] },
  }),
  "an empty accounts list beside provider.label": () => ({ provider: { ...CLAUDE, accounts: [], label: "Mine" } }),
  "provider.label beside a resolving accounts list (ignored, warning)": () => ({
    provider: { ...CLAUDE, label: "ignored", accounts: [{ label: "L1" }, { label: "L2", configDir: "~/.c2" }] },
  }),
  "a login carrying a field the engine does not read": () => ({
    provider: { ...CLAUDE, accounts: [{ label: "L1", note: "work" }, { label: "L2", configDir: "~/.c2", note: "home" }] },
  }),
  "a fallback written with its label last": () => ({
    provider: { ...CLAUDE },
    fallbacks: [{ api: { kind: "anthropic", model: "m", apiKeyEnv: "K" }, timeoutMs: 5000, label: "Late label" }],
  }),
  "an empty fallbacks list": () => ({ provider: { ...CLAUDE }, fallbacks: [] }),
  "a null fallbacks list": () => ({ provider: { ...CLAUDE }, fallbacks: null }),
};

const FIXTURES: Record<string, () => Json> = {
  "the spec §4 example": SPEC_EXAMPLE,
  "a single CLI entry (no label)": SINGLE_CLI,
  "an API item 1 with a literal key": API_LITERAL_FIRST,
  "PR 2's sentinel and app-owned references": PR2_SHAPES,
  ...IGNORED_FIELDS,
};

// ── helpers ──

function entriesOf(cfg: Json): readonly ProviderEntry[] {
  const r = readProviderList(cfg);
  if (!r.ok) throw new Error(`read refused: ${r.reason}`);
  return r.entries;
}

function written(cfg: Json, entries: readonly ProviderEntry[]): { config: Json; judgeChanged: boolean } {
  const r = writeProviderList(cfg, entries);
  if (!r.ok) throw new Error(`write blocked: ${JSON.stringify(r.blocked)}`);
  return r;
}

function blockedBy(cfg: Json, entries: readonly ProviderEntry[]): Blocked[] {
  const r = writeProviderList(cfg, entries);
  if (r.ok) throw new Error("write was not blocked");
  return r.blocked;
}

/** Sorted-key JSON: the same value whatever order its keys were written in. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => (v as Json)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon((v as Json)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The combined list the CURRENT engine walks for `cfg`, as plain comparable rows. */
function engineRows(cfg: Json): { label: string; provider: string; configDir: string | null; timeoutMs: number }[] {
  const resolved = resolveProviderList(validateConfig(structuredClone(cfg), HOME), HOME, ENV, EXISTS);
  expect(resolved.dropped).toEqual([]);
  expect(resolved.accountsBroken).toBe(false);
  return resolved.entries.map((e) => ({ label: e.label, provider: canon(e.provider), configDir: e.configDir ?? null, timeoutMs: e.timeoutMs }));
}

/** What the engine makes of each entry of an EDITOR list on its own — its block through the engine's own
 *  `normalizeProviderBlock`, its directory through `expandTilde`, its timeout as a fallback's (own, else its kind's
 *  default: API_TIMEOUT_MS for an `api` block, TIMEOUT_MS for a CLI). A login's block is item 1's, so its timeout is
 *  item 1's too. */
function intendedRows(entries: readonly ProviderEntry[]): ReturnType<typeof engineRows> {
  return entries.map((e) => ({
    label: e.label,
    provider: canon(normalizeProviderBlock(structuredClone(e.block), HOME)),
    configDir: e.configDir !== undefined ? expandTilde(e.configDir, HOME) : null,
    timeoutMs: typeof e.block["timeoutMs"] === "number" ? (e.block["timeoutMs"] as number) : e.block["api"] !== undefined ? API_TIMEOUT_MS : TIMEOUT_MS,
  }));
}

/** What an OLDER engine runs (and the audit judge selects from): `provider`'s logins as `resolveAccounts` reads them,
 *  `fallbacks` and `provider.label` unknown to it. */
function olderEngineLogins(cfg: Json): string[] {
  const c = validateConfig(structuredClone(cfg), HOME);
  if (c.provider.api !== undefined) return [ENGINE_DEFAULT_LABEL];
  const acc = resolveAccounts(c.provider.accounts, HOME, ENV, EXISTS);
  expect(acc.warnings.filter((w) => w.endsWith("— account failover disabled"))).toEqual([]);
  return acc.accounts !== undefined && acc.accounts.length > 0 ? acc.accounts.map((a) => a.label) : [ENGINE_DEFAULT_LABEL];
}

const labelsOf = (entries: readonly ProviderEntry[]): string[] => entries.map((e) => e.label);
const at = (entries: readonly ProviderEntry[], label: string): number => entries.findIndex((e) => e.label === label);
const accountLabels = (cfg: Json): string[] | undefined =>
  ((cfg["provider"] as Json)["accounts"] as Json[] | undefined)?.map((a) => a["label"] as string);
const fallbackLabels = (cfg: Json): string[] => ((cfg["fallbacks"] as Json[] | undefined) ?? []).map((f) => f["label"] as string);

// ── the reader agrees with the engine ──

describe("reading: the combined list is the engine's", () => {
  test("the default label is the engine's", () => {
    expect(DEFAULT_LABEL).toBe(ENGINE_DEFAULT_LABEL);
  });

  for (const [name, make] of Object.entries(FIXTURES)) {
    test(`${name}: labels, blocks, login directories and timeouts match resolveProviderList`, () => {
      const cfg = make();
      expect(intendedRows(entriesOf(cfg))).toEqual(engineRows(cfg));
    });
  }

  test("a broken fallback with a label is read (the engine drops it; the editor shows it as invalid) and round-trips", () => {
    const cfg: Json = { provider: { ...CLAUDE }, fallbacks: [{ label: "Half done", cli: "claude" }] };
    const resolved = resolveProviderList(validateConfig(structuredClone(cfg), HOME), HOME, ENV, EXISTS);
    expect(resolved.dropped.map((d) => d.label)).toEqual(["Half done"]);
    expect(labelsOf(entriesOf(cfg))).toEqual([DEFAULT_LABEL, "Half done"]);
    const out = written(cfg, entriesOf(cfg));
    expect(out.config).toEqual(cfg);
    expect(out.judgeChanged).toBe(false);
  });

  // Each shape the reader refuses is one the engine ALSO refuses (a broken `accounts` list, an invalid
  // `provider.label`, an unidentifiable or duplicate fallback, a broken `provider`), so the editor never edits a
  // list the engine reads differently. Asserted against the engine, case by case.
  const REFUSED: Record<string, { cfg: () => Json; reason: ReadRefusal; engine: (cfg: Json) => boolean }> = {
    "accounts that is not a list": {
      cfg: () => ({ provider: { ...CLAUDE, accounts: "Claude login 1" } }),
      reason: "accounts-unreadable",
      engine: (c) => resolveProviderList(validateConfig(c, HOME), HOME, ENV, EXISTS).accountsBroken,
    },
    "a login with an empty label": {
      cfg: () => ({ provider: { ...CLAUDE, accounts: [{ label: " " }] } }),
      reason: "accounts-unreadable",
      engine: (c) => resolveProviderList(validateConfig(c, HOME), HOME, ENV, EXISTS).accountsBroken,
    },
    "a login whose configDir is not a string": {
      cfg: () => ({ provider: { ...CLAUDE, accounts: [{ label: "a", configDir: 3 }] } }),
      reason: "accounts-unreadable",
      engine: (c) => resolveProviderList(validateConfig(c, HOME), HOME, ENV, EXISTS).accountsBroken,
    },
    "a login that is not an object": {
      cfg: () => ({ provider: { ...CLAUDE, accounts: [1] } }),
      reason: "accounts-unreadable",
      engine: (c) => resolveProviderList(validateConfig(c, HOME), HOME, ENV, EXISTS).accountsBroken,
    },
    "two logins with one label": {
      cfg: () => ({ provider: { ...CLAUDE, accounts: [{ label: "a" }, { label: "a", configDir: "~/.b" }] } }),
      reason: "duplicate-label",
      engine: (c) => resolveProviderList(validateConfig(c, HOME), HOME, ENV, EXISTS).accountsBroken,
    },
    "a provider.label that is not a non-empty string": {
      cfg: () => ({ provider: { ...CLAUDE, label: 5 } }),
      reason: "provider-label-invalid",
      engine: (c) => resolveProviderList(validateConfig(c, HOME), HOME, ENV, EXISTS).warnings.includes(PROVIDER_LABEL_INVALID),
    },
    "fallbacks that is not a list": {
      cfg: () => ({ provider: { ...CLAUDE }, fallbacks: { label: "x" } }),
      reason: "fallbacks-unreadable",
      engine: (c) => resolveProviderList(validateConfig(c, HOME), HOME, ENV, EXISTS).dropped.length === 1,
    },
    "a fallback with no label": {
      cfg: () => ({ provider: { ...CLAUDE }, fallbacks: [{ api: { kind: "anthropic", model: "m" } }] }),
      reason: "fallbacks-unreadable",
      engine: (c) => resolveProviderList(validateConfig(c, HOME), HOME, ENV, EXISTS).dropped.length === 1,
    },
    "a fallback whose configDir is not a string": {
      cfg: () => ({ provider: { ...CLAUDE }, fallbacks: [{ label: "b", ...CLAUDE, configDir: 1 }] }),
      reason: "fallbacks-unreadable",
      engine: (c) => resolveProviderList(validateConfig(c, HOME), HOME, ENV, EXISTS).dropped.length === 1,
    },
    "a fallback reusing a login's label": {
      cfg: () => ({ provider: { ...CLAUDE, accounts: [{ label: "a" }] }, fallbacks: [{ label: "a", api: { kind: "anthropic", model: "m" } }] }),
      reason: "duplicate-label",
      engine: (c) => resolveProviderList(validateConfig(c, HOME), HOME, ENV, EXISTS).dropped.some((d) => d.reason === "duplicate-label"),
    },
    "a provider that is not an object": {
      cfg: () => ({ provider: "claude" }),
      reason: "provider-not-object",
      engine: (c) => { try { validateConfig(c, HOME); return false; } catch { return true; } },
    },
  };
  for (const [name, { cfg, reason, engine }] of Object.entries(REFUSED)) {
    test(`refused: ${name} (${reason}) — and the engine refuses it too`, () => {
      const c = cfg();
      expect(readProviderList(c)).toEqual({ ok: false, reason });
      expect(engine(structuredClone(c))).toBe(true);
    });
  }

  test("accounts beside an API item 1 are ignored, as the engine ignores them — never refused", () => {
    const cfg: Json = { provider: { api: { kind: "anthropic", model: "m" }, accounts: "not even a list" } };
    expect(labelsOf(entriesOf(cfg))).toEqual([DEFAULT_LABEL]);
    expect(intendedRows(entriesOf(cfg))).toEqual(engineRows(cfg));
  });

  test("named boundary: two logins on one directory are read as written — the engine's save gate refuses them (P3-M4-T1)", () => {
    const cfg: Json = { provider: { ...CLAUDE, accounts: [{ label: "a" }, { label: "b", configDir: "~/.claude" }] } };
    expect(labelsOf(entriesOf(cfg))).toEqual(["a", "b"]);
    expect(resolveProviderList(validateConfig(structuredClone(cfg), HOME), HOME, ENV, EXISTS).accountsBroken).toBe(true);
  });
});

// ── a save with no edit changes nothing ──

describe("writing an unedited list", () => {
  for (const [name, make] of Object.entries(FIXTURES)) {
    test(`${name}: the config comes back unchanged and the judge is unchanged`, () => {
      const cfg = make();
      const out = written(cfg, entriesOf(cfg));
      expect(out.config).toEqual(cfg);
      expect(JSON.stringify(out.config)).toBe(JSON.stringify(cfg));   // key order too
      expect(out.judgeChanged).toBe(false);
    });
  }

  test("the writer does not mutate its inputs", () => {
    const cfg = SPEC_EXAMPLE();
    const before = JSON.stringify(cfg);
    const entries = entriesOf(cfg);
    const out = written(cfg, moveEntry(entries, 3, 0));
    expect(JSON.stringify(cfg)).toBe(before);
    (out.config["provider"] as Json)["cli"] = "changed";
    expect(JSON.stringify(cfg)).toBe(before);
    expect(entriesOf(cfg)[0]!.block["cli"]).toBe("claude");
  });
});

// ── compaction, and written configs read the same ──

type Edit = {
  base: () => Json;
  edit: (e: readonly ProviderEntry[]) => readonly ProviderEntry[];
  /** `provider.accounts` labels as written, or undefined for no list. */
  accounts: string[] | undefined;
  fallbacks: string[];
  judgeChanged: boolean;
};

const L2_BLOCK_EDIT = { ...CLAUDE, argv: ["-p", "--model", "claude-opus-5"], timeoutMs: 180000 };

const EDITS: Record<string, Edit> = {
  "moving the local model to the top: item 1 becomes an API entry, both logins become fallback blocks": {
    base: SPEC_EXAMPLE, edit: (e) => moveEntry(e, 3, 0),
    accounts: undefined, fallbacks: ["Claude login 1", "Claude login 2", "Anthropic key"], judgeChanged: true,
  },
  "moving the key between the logins: the second login moves out of accounts": {
    base: SPEC_EXAMPLE, edit: (e) => moveEntry(e, 2, 1),
    accounts: ["Claude login 1"], fallbacks: ["Anthropic key", "Claude login 2", "Local model"], judgeChanged: true,
  },
  "moving the second login to the end": {
    base: SPEC_EXAMPLE, edit: (e) => moveEntry(e, 1, 3),
    accounts: ["Claude login 1"], fallbacks: ["Anthropic key", "Local model", "Claude login 2"], judgeChanged: true,
  },
  "reordering the fallbacks only": {
    base: SPEC_EXAMPLE, edit: (e) => moveEntry(e, 3, 2),
    accounts: ["Claude login 1", "Claude login 2"], fallbacks: ["Local model", "Anthropic key"], judgeChanged: false,
  },
  // Checkpoint P3-M3 (HIGH): compaction KEEPS, it never PULLS IN — a NEW entry is always a `fallbacks` block, even a
  // same-settings login right below the logins (hub entry 2026-10-18; spec §4 "Storing the list" 115-119).
  "adding a same-settings login right after the logins: a new entry is a fallback block, never pulled into accounts": {
    base: SPEC_EXAMPLE,
    edit: (e) => insertEntry(e, 2, { label: "Claude login 3", block: structuredClone(e[0]!.block) as Json, configDir: "~/.claude-third" }),
    accounts: ["Claude login 1", "Claude login 2"], fallbacks: ["Claude login 3", "Anthropic key", "Local model"], judgeChanged: false,
  },
  "adding a same-settings login at the end: it is a fallback block": {
    base: SPEC_EXAMPLE,
    edit: (e) => insertEntry(e, 4, { label: "Claude login 3", block: structuredClone(e[0]!.block) as Json, configDir: "~/.claude-third" }),
    accounts: ["Claude login 1", "Claude login 2"], fallbacks: ["Anthropic key", "Local model", "Claude login 3"], judgeChanged: false,
  },
  "changing item 1's model: the other login no longer matches and becomes a fallback block": {
    base: SPEC_EXAMPLE, edit: (e) => setEntrySettings(e, "Claude login 1", { block: L2_BLOCK_EDIT }),
    accounts: ["Claude login 1"], fallbacks: ["Claude login 2", "Anthropic key", "Local model"], judgeChanged: true,
  },
  "a login differing only in timeoutMs is not the same settings": {
    base: SPEC_EXAMPLE,
    edit: (e) => setEntrySettings(e, "Claude login 2", { block: { ...(e[1]!.block as Json), timeoutMs: 999 }, configDir: "~/.claude-briefing" }),
    accounts: ["Claude login 1"], fallbacks: ["Claude login 2", "Anthropic key", "Local model"], judgeChanged: true,
  },
  "removing item 1: the second login becomes item 1, keeping its directory in accounts": {
    base: SPEC_EXAMPLE, edit: (e) => removeEntry(e, "Claude login 1"),
    accounts: ["Claude login 2"], fallbacks: ["Anthropic key", "Local model"], judgeChanged: true,
  },
  "a second login added to a single-entry config: a fallback block, and item 1 is left as written": {
    base: SINGLE_CLI,
    edit: (e) => insertEntry(e, 1, { label: "Claude login 2", block: structuredClone(e[0]!.block) as Json, configDir: "~/.claude-two" }),
    accounts: undefined, fallbacks: ["Claude login 2"], judgeChanged: false,
  },
  "a fallback added below an API item 1": {
    base: API_LITERAL_FIRST,
    edit: (e) => insertEntry(e, 4, { label: "Another", block: { api: { kind: "anthropic", model: "x", apiKeyEnv: "OTHER" } } }),
    accounts: undefined, fallbacks: ["Local", "Key C", "Codex", "Another"], judgeChanged: false,
  },
  "a hand-written same-settings fallback right below item 1 stays a fallback block": {
    base: () => ({ provider: { ...CLAUDE }, fallbacks: [{ label: "Second", ...CLAUDE, configDir: "~/.second" }] }),
    edit: (e) => e,
    accounts: undefined, fallbacks: ["Second"], judgeChanged: false,
  },
  "a login whose directory is edited leaves accounts (only a login read with that directory stays)": {
    base: SPEC_EXAMPLE,
    edit: (e) => setEntrySettings(e, "Claude login 2", { block: structuredClone(e[1]!.block) as Json, configDir: "~/.claude-elsewhere" }),
    accounts: ["Claude login 1"], fallbacks: ["Claude login 2", "Anthropic key", "Local model"], judgeChanged: true,
  },
  "a same-settings fallback moved above the logins becomes item 1 alone; the logins are pushed out": {
    base: () => ({
      provider: { ...CLAUDE, accounts: [{ label: "L1" }, { label: "L2", configDir: "~/.l2" }] },
      fallbacks: [{ label: "F", ...CLAUDE, configDir: "~/.f" }],
    }),
    edit: (e) => moveEntry(e, 2, 0),
    accounts: ["F"], fallbacks: ["L1", "L2"], judgeChanged: true,
  },
  "a CLI fallback moved to the top keeps its label in accounts (an older engine reads it there)": {
    base: () => ({ provider: { api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }, fallbacks: [{ label: "Claude", ...CLAUDE }] }),
    edit: (e) => moveEntry(e, 1, 0),
    accounts: ["Claude"], fallbacks: [DEFAULT_LABEL], judgeChanged: true,
  },
};

describe("compaction: logins stay in accounts only while contiguous at the top with item 1's settings", () => {
  for (const [name, c] of Object.entries(EDITS)) {
    test(name, () => {
      const cfg = c.base();
      const edited = c.edit(entriesOf(cfg));
      const out = written(cfg, edited);
      expect(accountLabels(out.config)).toEqual(c.accounts);
      expect(fallbackLabels(out.config)).toEqual(c.fallbacks);
      expect(out.judgeChanged).toBe(c.judgeChanged);

      // Written configs read the same under the CURRENT engine: the walk is the edited list, entry for entry.
      expect(engineRows(out.config)).toEqual(intendedRows(edited));
      // …and the editor reads back exactly what it wrote, labels never changed.
      expect(entriesOf(out.config)).toEqual(edited);
      // …and under an OLDER engine (and the judge's resolveAccounts): item 1 and the logins left in accounts.
      expect(olderEngineLogins(out.config)).toEqual(
        c.accounts ?? [(out.config["provider"] as Json)["api"] !== undefined ? ENGINE_DEFAULT_LABEL : edited[0]!.label],
      );
      // A second write is a no-op: what was written is read back with the same origins.
      const again = written(out.config, entriesOf(out.config));
      expect(again.config).toEqual(out.config);
      expect(again.judgeChanged).toBe(false);
    });
  }

  test("every other entry is a FULL block: a login moved out carries item 1's whole block and its directory", () => {
    const cfg = SPEC_EXAMPLE();
    const out = written(cfg, moveEntry(entriesOf(cfg), 1, 3));
    const moved = (out.config["fallbacks"] as Json[])[2]!;
    expect(moved).toEqual({ label: "Claude login 2", configDir: "~/.claude-briefing", ...CLAUDE, timeoutMs: 180000 });
  });

  test("moving an entry moves its block unchanged", () => {
    const cfg = SPEC_EXAMPLE();
    const out = written(cfg, moveEntry(entriesOf(cfg), 3, 2));
    expect((out.config["fallbacks"] as Json[])[0]).toEqual((cfg["fallbacks"] as Json[])[1]!);
    expect((out.config["fallbacks"] as Json[])[1]).toEqual((cfg["fallbacks"] as Json[])[0]!);
  });

  test("an API item 1 never keeps logins: item 1 changed from CLI to API moves the other login out", () => {
    const cfg = SPEC_EXAMPLE();
    const api = { api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyEnv: "ANTHROPIC_API_KEY" } };
    const out = written(cfg, setEntrySettings(entriesOf(cfg), "Claude login 1", { block: api }));
    expect((out.config["provider"] as Json)["accounts"]).toBeUndefined();
    expect((out.config["provider"] as Json)["label"]).toBe("Claude login 1");
    expect(fallbackLabels(out.config)).toEqual(["Claude login 2", "Anthropic key", "Local model"]);
    expect(out.judgeChanged).toBe(true);
    expect(engineRows(out.config).map((r) => r.label)).toEqual(["Claude login 1", "Claude login 2", "Anthropic key", "Local model"]);
  });

  test("an API item 1 cannot carry a login directory: blocked, never silently dropped", () => {
    const cfg = SPEC_EXAMPLE();
    const api = { api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } };
    const edited = setEntrySettings(entriesOf(cfg), "Claude login 2", { block: api, configDir: "~/.claude-briefing" });
    expect(blockedBy(cfg, moveEntry(edited, 1, 0))).toEqual([{ kind: "config-dir-on-api", label: "Claude login 2" }]);
  });
});

// ── a non-Claude CLI entry with a login directory never becomes a NEW item 1 (plan hub "(BUILD, P3-M4-T1,
// 2026-10-18) Decided" (2)) ── As a fallback the engine drops it (`config-dir`); as item 1 `config validate` reports it
// only as advisory (it runs, with a meaningless CLAUDE_CONFIG_DIR). The engine cannot call that structural without
// changing today's codex configs with `accounts` (requirement 9), so the WRITER refuses to make one item 1 — by move,
// insert or removal — exactly as it refuses `config-dir-on-api`. An existing such item 1 round-trips unchanged.
describe("a non-Claude CLI entry with a login directory cannot become item 1 (config-dir-on-non-claude)", () => {
  // Functions, not values: `CODEX` is declared further down this file, after this describe body runs.
  const CODEX_DIR = (): Json => ({ label: "Codex dir", ...CODEX, configDir: "~/.codex-2" });
  const API_FB = { label: "Api", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } };

  test("moved to item 1: blocked with the named reason, never written", () => {
    const cfg: Json = { provider: { ...CLAUDE }, fallbacks: [API_FB, CODEX_DIR()] };
    expect(engineView(cfg, ENV).dropped).toEqual([["Codex dir", "config-dir"]]);
    expect(blockedBy(cfg, moveEntry(entriesOf(cfg), 2, 0))).toEqual([{ kind: "config-dir-on-non-claude", label: "Codex dir" }]);
    // Anywhere below item 1 it still moves (it stays a dropped fallbacks block — the save path refuses that itself).
    expect(fallbackLabels(written(cfg, moveEntry(entriesOf(cfg), 2, 1)).config)).toEqual(["Codex dir", "Api"]);
  });

  test("inserted at item 1: blocked; inserted below, written", () => {
    const cfg: Json = { provider: { ...CLAUDE }, fallbacks: [API_FB] };
    const block: Json = { ...CODEX };
    expect(blockedBy(cfg, insertEntry(entriesOf(cfg), 0, { label: "New codex", block, configDir: "~/.codex-n" }))).toEqual([
      { kind: "config-dir-on-non-claude", label: "New codex" },
    ]);
    expect(fallbackLabels(written(cfg, insertEntry(entriesOf(cfg), 1, { label: "New codex", block, configDir: "~/.codex-n" })).config)).toEqual([
      "New codex", "Api",
    ]);
    // Without a login directory a codex entry becomes item 1 freely.
    const out = written(cfg, insertEntry(entriesOf(cfg), 0, { label: "Plain codex", block }));
    expect((out.config["provider"] as Json)["cli"]).toBe("codex");
  });

  test("a removal that leaves it first: blocked", () => {
    const cfg: Json = { provider: { ...CLAUDE }, fallbacks: [CODEX_DIR(), API_FB] };
    expect(blockedBy(cfg, removeEntry(entriesOf(cfg), DEFAULT_LABEL))).toEqual([{ kind: "config-dir-on-non-claude", label: "Codex dir" }]);
    expect(fallbackLabels(written(cfg, removeEntry(entriesOf(cfg), "Api")).config)).toEqual(["Codex dir"]);
  });

  // "Claude CLI" is the engine's `claudeShaped` (src/harden.ts: the basename, case-insensitive, `.exe`/`.cmd`/`.bat`/
  // `.ps1` stripped, is `claude`) — the rule its `config-dir` drop applies. provider-list.ts is pure and cannot import
  // it, so it carries the same rule and this table pins the two together through the writer's verdict.
  test("which CLI counts as Claude is the engine's own `claudeShaped`, spelling by spelling", () => {
    const spellings = [
      "claude", "CLAUDE", "/usr/local/bin/claude", "~/bin/claude", "./claude", "claude.exe", "Claude.CMD", "claude.bat",
      "claude.ps1", "claude/", "codex", "/opt/claude/codex", "claude-code", "claude.sh", "claudex", "my-claude", "exe.claude",
    ];
    const claudeCount = spellings.filter((s) => claudeShaped(s)).length;
    expect(claudeCount).toBeGreaterThanOrEqual(8);
    expect(claudeCount).toBeLessThan(spellings.length);
    for (const cli of spellings) {
      const cfg: Json = { provider: { api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }, fallbacks: [{ label: "X", cli, argv: ["-p"], promptVia: "stdin", configDir: "~/.x" }] };
      const r = writeProviderList(cfg, moveEntry(entriesOf(cfg), 1, 0));
      const verdict = r.ok ? "written" : r.blocked.map((b) => b.kind).join(",");
      expect({ cli, verdict }).toEqual({ cli, verdict: claudeShaped(cli) ? "written" : "config-dir-on-non-claude" });
    }
  });

  // On Windows the engine's `basename` is `path.win32.basename`, which reads `\` as a separator too (checkpoint P3-M4-T2,
  // finding 4): `claudeShaped`'s own expression with that basename is the engine-on-Windows stand-in, pinned to the
  // engine's source so the two cannot drift. Every forward-slash spelling above reads the same under both.
  test("backslash paths count as Claude as the engine on Windows reads them", () => {
    const harden = readFileSync(new URL("../../src/harden.ts", import.meta.url), "utf8");
    expect(harden).toMatch(/import \{[^}]*\bbasename\b[^}]*\} from "node:path";/);
    expect(harden).toContain('const b = basename(cli).toLowerCase().replace(/\\.(exe|cmd|bat|ps1)$/, "");');
    const onWindows = (cli: string): boolean => win32.basename(cli).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "") === "claude";
    const backslashed = [
      "C:\\Program Files\\Claude\\claude.exe", "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", ".\\claude", "claude\\",
      "C:\\tools\\claude\\\\", "C:\\x/claude.PS1", "C:\\claude\\codex.exe", "C:\\bin\\claude-code.cmd", "\\\\server\\share\\claude.bat",
      "C:claude.exe", "D:", "c:/claude",
    ];
    const posixSpellings = ["claude", "/usr/local/bin/claude", "claude/", "codex", "/opt/claude/codex", "my-claude"];
    for (const cli of posixSpellings) expect({ cli, same: onWindows(cli) === claudeShaped(cli) }).toEqual({ cli, same: true });
    const claudeCount = backslashed.filter(onWindows).length;
    expect(claudeCount).toBeGreaterThanOrEqual(6);
    expect(claudeCount).toBeLessThan(backslashed.length);
    for (const cli of [...backslashed, ...posixSpellings]) {
      const block = { cli, argv: ["-p"], promptVia: "stdin" };
      expect({ cli, claude: isClaudeCli(block) }).toEqual({ cli, claude: onWindows(cli) });
      const cfg: Json = { provider: { api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }, fallbacks: [{ label: "X", ...block, configDir: "~/.x" }] };
      const r = writeProviderList(cfg, moveEntry(entriesOf(cfg), 1, 0));
      const verdict = r.ok ? "written" : r.blocked.map((b) => b.kind).join(",");
      expect({ cli, verdict }).toEqual({ cli, verdict: onWindows(cli) ? "written" : "config-dir-on-non-claude" });
    }
    // An API block is never a Claude CLI, nor a block whose `cli` is not a string.
    expect(isClaudeCli({ api: { kind: "anthropic", model: "m" } })).toBe(false);
    expect(isClaudeCli({ cli: 7 })).toBe(false);
  });

  test("an existing config whose item 1 already is one round-trips unchanged, and its other entries still edit (req. 9)", () => {
    const cfg: Json = { provider: { ...CODEX, accounts: [{ label: "Codex", configDir: "~/.codex-b" }] }, fallbacks: [API_FB, { label: "Api 2", api: { kind: "anthropic", model: "n", apiKeyEnv: "K2" } }] };
    const before = engineView(cfg, ENV);
    expect(before.entries[0]).toEqual(["Codex", `${HOME}/.codex-b`]);
    const same = written(cfg, entriesOf(cfg));
    expect(JSON.stringify(same.config)).toBe(JSON.stringify(cfg));
    expect(same.judgeChanged).toBe(false);
    const reordered = written(cfg, moveEntry(entriesOf(cfg), 2, 1));
    expect(fallbackLabels(reordered.config)).toEqual(["Api 2", "Api"]);
    expect(reordered.config["provider"]).toEqual(cfg["provider"]);
    // Its own settings still edit while it keeps the login directory it was read with…
    const edited = written(cfg, setEntrySettings(entriesOf(cfg), "Codex", { block: { ...CODEX, argv: ["exec", "--full-auto"] }, configDir: "~/.codex-b" }));
    expect(engineView(edited.config, ENV).entries[0]).toEqual(["Codex", `${HOME}/.codex-b`]);
    // …and clearing it is allowed; giving it a DIFFERENT one is not (that is a new login directory on item 1).
    expect(written(cfg, setEntrySettings(entriesOf(cfg), "Codex", { block: { ...CODEX } })).config["provider"]).toEqual({ ...CODEX, accounts: [{ label: "Codex" }] });
    expect(blockedBy(cfg, setEntrySettings(entriesOf(cfg), "Codex", { block: { ...CODEX }, configDir: "~/.codex-c" }))).toEqual([
      { kind: "config-dir-on-non-claude", label: "Codex" },
    ]);
  });
});

// ── compaction never pulls in (checkpoint P3-M3 HIGH, hub entry 2026-10-18) ──

/** The combined list the CURRENT engine walks for `cfg` under `env`, including what it drops and whether it read
 *  `accounts` as broken — the engine's own `validateConfig` + `resolveProviderList`, nothing re-derived. */
function engineView(cfg: Json, env: Record<string, string | undefined>): {
  entries: [string, string | null][]; dropped: [string | undefined, string][]; accountsBroken: boolean;
} {
  const r = resolveProviderList(validateConfig(structuredClone(cfg), HOME), HOME, env, EXISTS);
  return {
    entries: r.entries.map((e) => [e.label, e.configDir ?? null]),
    dropped: r.dropped.map((d) => [d.label, d.reason]),
    accountsBroken: r.accountsBroken,
  };
}

const CODEX = { cli: "codex", argv: ["exec"], promptVia: "stdin" };
const ELSEWHERE_ENV = { CLAUDE_CONFIG_DIR: "/exported-claude-config-dir" };

/** The reviewer's no-edit reproductions, plus the fixture classes the T1 sweep lacked. Each is saved with no edit;
 *  before this fix compaction rewrote each one (pulling a `fallbacks` entry into `accounts`) and the engine then
 *  read `accounts` as broken or ran a dropped entry. `engine` is what the engine reads, written out by hand. */
const HAZARDS: Record<string, { cfg: () => Json; env: Record<string, string | undefined>; engine: ReturnType<typeof engineView> }> = {
  "(a) CLI item 1 + a same-block fallback with no configDir (one login as item 1) + another on ~/.z": {
    cfg: () => ({ provider: { ...CLAUDE }, fallbacks: [{ label: "Same", ...CLAUDE }, { label: "Z", ...CLAUDE, configDir: "~/.z" }] }),
    env: ENV,
    engine: { entries: [[DEFAULT_LABEL, null], ["Z", `${HOME}/.z`]], dropped: [["Same", "duplicate-login"]], accountsBroken: false },
  },
  "(b) accounts [A on ~/.a] + a same-block fallback B on ~/.a (a colliding configDir)": {
    cfg: () => ({ provider: { ...CLAUDE, accounts: [{ label: "A", configDir: "~/.a" }] }, fallbacks: [{ label: "B", ...CLAUDE, configDir: "~/.a" }] }),
    env: ENV,
    engine: { entries: [["A", `${HOME}/.a`]], dropped: [["B", "duplicate-login"]], accountsBroken: false },
  },
  "(c) CLAUDE_CONFIG_DIR exported, and a same-block fallback on ~/.claude": {
    cfg: () => ({ provider: { ...CLAUDE }, fallbacks: [{ label: "Home dir", ...CLAUDE, configDir: "~/.claude" }] }),
    env: ELSEWHERE_ENV,
    engine: { entries: [[DEFAULT_LABEL, null], ["Home dir", `${HOME}/.claude`]], dropped: [], accountsBroken: false },
  },
  "(d) codex item 1 + a same-block codex fallback": {
    cfg: () => ({ provider: { ...CODEX }, fallbacks: [{ label: "Codex 2", ...CODEX }] }),
    env: ENV,
    engine: { entries: [[DEFAULT_LABEL, null], ["Codex 2", null]], dropped: [], accountsBroken: false },
  },
  "(MED 2) a same-block codex fallback with a configDir stays a dropped fallbacks block": {
    cfg: () => ({ provider: { ...CODEX }, fallbacks: [{ label: "Codex dir", ...CODEX, configDir: "~/.codex-2" }] }),
    env: ENV,
    engine: { entries: [[DEFAULT_LABEL, null]], dropped: [["Codex dir", "config-dir"]], accountsBroken: false },
  },
  "differing credentials: one directory, subscription then env-api-key": {
    cfg: () => ({
      provider: { ...CLAUDE, credential: "subscription", accounts: [{ label: "Sub" }] },
      fallbacks: [{ label: "Key", ...CLAUDE, credential: "env-api-key" }, { label: "Sub again", ...CLAUDE, credential: "subscription", configDir: "~/.claude" }],
    }),
    env: ENV,
    engine: { entries: [["Sub", null], ["Key", null]], dropped: [["Sub again", "duplicate-login"]], accountsBroken: false },
  },
  "accounts [L1, L2] + same-block fallbacks colliding with each login, under an exported CLAUDE_CONFIG_DIR": {
    cfg: () => ({
      provider: { ...CLAUDE, accounts: [{ label: "L1" }, { label: "L2", configDir: "~/.l2" }] },
      fallbacks: [{ label: "F on l2", ...CLAUDE, configDir: "~/.l2" }, { label: "F home", ...CLAUDE, configDir: "~/.claude" }],
    }),
    env: ELSEWHERE_ENV,
    engine: { entries: [["L1", null], ["L2", `${HOME}/.l2`], ["F home", `${HOME}/.claude`]], dropped: [["F on l2", "duplicate-login"]], accountsBroken: false },
  },
};

describe("compaction keeps, it never pulls in: a `fallbacks` entry is never written into `accounts`", () => {
  for (const [name, h] of Object.entries(HAZARDS)) {
    test(`${name}: a save with no edit is byte-identical, and the engine reads what it read before`, () => {
      const cfg = h.cfg();
      expect(engineView(cfg, h.env)).toEqual(h.engine);
      const out = written(cfg, entriesOf(cfg));
      expect(JSON.stringify(out.config)).toBe(JSON.stringify(cfg));
      expect(out.judgeChanged).toBe(false);
      expect(engineView(out.config, h.env)).toEqual(h.engine);
    });
  }

  test("(MED 2) moving a codex fallback with a configDir within `fallbacks` keeps it a dropped block", () => {
    const cfg: Json = { provider: { ...CODEX }, fallbacks: [{ label: "Api", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }, { label: "Codex dir", ...CODEX, configDir: "~/.codex-2" }] };
    const out = written(cfg, moveEntry(entriesOf(cfg), 2, 1));
    expect(accountLabels(out.config)).toBeUndefined();
    expect(fallbackLabels(out.config)).toEqual(["Codex dir", "Api"]);
    expect(engineView(out.config, ENV).dropped).toEqual([["Codex dir", "config-dir"]]);
  });

  // The guarantee, exhaustively: every ordering of every non-empty subset of a list whose `accounts` is valid, with
  // same-block fallbacks that collide with each login (no configDir = ~/.claude; one on L2's directory; one on
  // ~/.claude under an exported CLAUDE_CONFIG_DIR). Whatever the edit, the written `accounts` is never broken: it is
  // item 1 plus logins READ from `accounts` with the directory they were read with — a reordered subset of a valid
  // list — and every other entry runs or is dropped as a duplicate login, never lost with the rest.
  const BASE = (): Json => ({
    provider: { ...CLAUDE, accounts: [{ label: "L1" }, { label: "L2", configDir: "~/.l2" }] },
    fallbacks: [
      { label: "F default", ...CLAUDE },
      { label: "F on l2", ...CLAUDE, configDir: "~/.l2" },
      { label: "F claude", ...CLAUDE, configDir: "~/.claude" },
      { label: "Api", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } },
    ],
  });
  function* orderings<T>(xs: readonly T[]): Generator<T[]> {
    for (let i = 0; i < xs.length; i++) {
      yield [xs[i]!];
      const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
      for (const tail of orderings(rest)) yield [xs[i]!, ...tail];
    }
  }
  for (const [envName, env] of [["an empty env", ENV], ["an exported CLAUDE_CONFIG_DIR", ELSEWHERE_ENV]] as const) {
    test(`every ordering of every subset (${envName}): accounts is never read as broken, and no entry is lost`, () => {
      const cfg = BASE();
      const read = entriesOf(cfg);
      expect(engineView(cfg, env).accountsBroken).toBe(false);
      const readLogins = new Map([["L1", undefined], ["L2", "~/.l2"]] as [string, string | undefined][]);
      let n = 0;
      for (const edited of orderings(read)) {
        n++;
        const out = written(cfg, edited).config;
        const view = engineView(out, env);
        const where = labelsOf(edited).join(" > ");
        expect({ where, broken: view.accountsBroken }).toEqual({ where, broken: false });
        expect(view.entries[0]![0]).toBe(edited[0]!.label);
        // `accounts` beyond item 1: only logins read from `accounts`, on the directory they were read with.
        for (const a of (((out["provider"] as Json)["accounts"] as Json[] | undefined) ?? []).slice(1)) {
          expect(readLogins.has(a["label"] as string)).toBe(true);
          expect(a["configDir"]).toBe(readLogins.get(a["label"] as string));
        }
        // Every entry runs on its own directory, or is dropped as a duplicate login — nothing else.
        const ran = new Map(view.entries);
        const dropped = new Map(view.dropped);
        for (const e of edited) {
          if (ran.has(e.label)) expect(ran.get(e.label)).toBe(e.configDir !== undefined ? expandTilde(e.configDir, HOME) : null);
          else expect({ where, label: e.label, reason: dropped.get(e.label) }).toEqual({ where, label: e.label, reason: "duplicate-login" });
        }
        // An older engine (and the judge's resolveAccounts) reads the written `accounts` as a list too.
        const acc = resolveAccounts((validateConfig(structuredClone(out), HOME).provider).accounts, HOME, env, EXISTS);
        expect(acc.warnings.filter((w) => w.endsWith("— account failover disabled"))).toEqual([]);
      }
      expect(n).toBe(1956);   // Σ P(6,k), k = 1..6
    });
  }
});

// ── a fallback the engine drops as bad-shape never becomes item 1 (checkpoint P3-M3 LOW 5) ──

describe("an entry carrying nested `accounts` / `fallbacks` stays where it is", () => {
  const NESTED = (field: "accounts" | "fallbacks"): Json => ({
    provider: { ...CLAUDE },
    fallbacks: [
      { label: "Api", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } },
      { label: "Nested", api: { kind: "anthropic", model: "m2", apiKeyEnv: "K2" }, [field]: [{ label: "inner" }] },
    ],
  });
  for (const field of ["accounts", "fallbacks"] as const) {
    test(`nested ${field}: the engine drops it as bad-shape; an unedited save and a move within fallbacks round-trip it`, () => {
      const cfg = NESTED(field);
      expect(engineView(cfg, ENV).dropped).toEqual([["Nested", "bad-shape"]]);
      expect(JSON.stringify(written(cfg, entriesOf(cfg)).config)).toBe(JSON.stringify(cfg));
      const moved = written(cfg, moveEntry(entriesOf(cfg), 2, 1)).config;
      expect((moved["fallbacks"] as Json[])[0]).toEqual((cfg["fallbacks"] as Json[])[1]!);
      expect(engineView(moved, ENV).dropped).toEqual([["Nested", "bad-shape"]]);
    });

    test(`nested ${field}: a move, or a removal, that would make it item 1 is blocked with a named reason`, () => {
      const cfg = NESTED(field);
      expect(blockedBy(cfg, moveEntry(entriesOf(cfg), 2, 0))).toEqual([{ kind: "nested-list", label: "Nested", field }]);
      const without = removeEntry(removeEntry(entriesOf(cfg), DEFAULT_LABEL), "Api");
      expect(blockedBy(cfg, without)).toEqual([{ kind: "nested-list", label: "Nested", field }]);
    });
  }

  test("a stray `provider.fallbacks` round-trips while item 1 is unchanged (the engine ignores it there)", () => {
    const cfg: Json = { provider: { ...CLAUDE, fallbacks: [{ label: "inner" }] }, fallbacks: [{ label: "Api", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }] };
    expect(JSON.stringify(written(cfg, entriesOf(cfg)).config)).toBe(JSON.stringify(cfg));
    expect(JSON.stringify(written(cfg, removeEntry(entriesOf(cfg), "Api")).config)).toBe(JSON.stringify({ provider: cfg["provider"] }));
  });
});

// ── a login pushed out of `accounts` keeps its own fields (checkpoint P3-M3 LOW 6) ──

describe("a login pushed out of accounts keeps the fields the engine did not read", () => {
  /** The engine's provider-block fields, read from its own type (`src/types.ts`, `Config["provider"]`), minus the
   *  list's: a login carrying one of these must NOT carry it into its fallback block, where the engine would read
   *  it and the entry would run differently. */
  const ENGINE_BLOCK_FIELDS = (() => {
    const src = readFileSync(new URL("../../src/types.ts", import.meta.url), "utf8");
    const m = /^\s*provider: \{ (.*) \};$/m.exec(src);
    if (m === null) throw new Error("Config[\"provider\"] not found in src/types.ts");
    const keys = [...m[1]!.matchAll(/(?:^|; )(\w+)\??:/g)].map((x) => x[1]!);
    return keys.filter((k) => !["accounts", "label", "configDir", "fallbacks"].includes(k));
  })();

  test("the engine's block fields are what this file expects (the pin reads the engine's type)", () => {
    expect(ENGINE_BLOCK_FIELDS.sort()).toEqual(["api", "argv", "cli", "credential", "harden", "promptVia", "timeoutMs"]);
  });

  test("a `note` rides into the login's fallback block; a block field the login carried does not", () => {
    const cfg: Json = {
      provider: { ...CLAUDE, timeoutMs: 180000, accounts: [{ label: "L1" }, { label: "L2", note: "home", configDir: "~/.l2", ...Object.fromEntries(ENGINE_BLOCK_FIELDS.map((k) => [k, "ignored-in-a-login"])) }] },
    };
    expect(engineRows(cfg).map((r) => r.label)).toEqual(["L1", "L2"]);
    const out = written(cfg, moveEntry(entriesOf(cfg), 1, 0)).config;
    expect(accountLabels(out)).toEqual(["L2", "L1"]);
    // Still a login: its login object is kept whole (the engine reads only label and configDir there).
    expect(((out["provider"] as Json)["accounts"] as Json[])[0]).toEqual(((cfg["provider"] as Json)["accounts"] as Json[])[1]!);
    const api = { label: "Api", block: { api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } } };
    const pushed = written(cfg, insertEntry(entriesOf(cfg), 1, api)).config;
    // L2 is pushed out below the new entry — carrying `note`, and item 1's block, never the login's ignored copies.
    expect(accountLabels(pushed)).toEqual(["L1"]);
    expect((pushed["fallbacks"] as Json[])[1]).toEqual({ label: "L2", configDir: "~/.l2", ...CLAUDE, timeoutMs: 180000, note: "home" });
    expect(engineRows(pushed)).toEqual(intendedRows(entriesOf(pushed)));
    expect(entriesOf(pushed)[2]!.block).toEqual({ ...CLAUDE, timeoutMs: 180000, note: "home" });
  });
});

// ── the judge flag ──

describe("the judge flag: any change to `provider` as written", () => {
  test("a compaction that moves a login out of accounts changes the judge", () => {
    const cfg = SPEC_EXAMPLE();
    expect(written(cfg, moveEntry(entriesOf(cfg), 2, 1)).judgeChanged).toBe(true);
  });

  test("an edit to a fallback's settings leaves the judge alone", () => {
    const cfg = SPEC_EXAMPLE();
    const e = entriesOf(cfg);
    const lm = e[3]!;
    const out = written(cfg, setEntrySettings(e, "Local model", { block: { ...(lm.block as Json), timeoutMs: 700000 } }));
    expect(out.judgeChanged).toBe(false);
  });

  test("removing a fallback leaves the judge alone; removing a login changes it", () => {
    const cfg = SPEC_EXAMPLE();
    expect(written(cfg, removeEntry(entriesOf(cfg), "Local model")).judgeChanged).toBe(false);
    expect(written(cfg, removeEntry(entriesOf(cfg), "Claude login 2")).judgeChanged).toBe(true);
  });

  test("the judge's reading of the written config is what the flag says (resolveAccounts, the judge's own function)", () => {
    const cfg = SPEC_EXAMPLE();
    for (const [edit, judgeChanged] of [[(e: readonly ProviderEntry[]) => moveEntry(e, 3, 2), false], [(e: readonly ProviderEntry[]) => moveEntry(e, 2, 1), true]] as const) {
      const out = written(cfg, edit(entriesOf(cfg)));
      const sameJudge = canon((validateConfig(structuredClone(out.config), HOME)).provider) === canon(validateConfig(structuredClone(cfg), HOME).provider);
      expect(out.judgeChanged).toBe(judgeChanged);
      expect(sameJudge).toBe(!judgeChanged);
    }
  });
});

// ── a literal key's pointer never moves ──

const ptr = (s: string): string => s;

describe("a literal key's JSON pointer, and which entry sits there, never change (spec §6)", () => {
  test("a reorder that moves item 1's literal out of `provider` is blocked", () => {
    const cfg = API_LITERAL_FIRST();
    expect(blockedBy(cfg, moveEntry(entriesOf(cfg), 1, 0))).toEqual([
      { kind: "literal-moved", label: "Key A", from: ptr("/provider/api/apiKey"), to: ptr("/fallbacks/0/api/apiKey") },
    ]);
  });

  test("a reorder of a literal fallback is blocked", () => {
    const cfg = API_LITERAL_FIRST();
    expect(blockedBy(cfg, moveEntry(entriesOf(cfg), 2, 3))).toEqual([
      { kind: "literal-moved", label: "Key C", from: ptr("/fallbacks/1/api/apiKey"), to: ptr("/fallbacks/2/api/apiKey") },
    ]);
  });

  test("a swap of two literal-key entries is blocked for both", () => {
    const cfg = API_LITERAL_FIRST();
    const e = moveEntry(moveEntry(entriesOf(cfg), 2, 0), 1, 2);   // Key C first, Key A where Key C was
    expect(labelsOf(e)).toEqual(["Key C", "Local", "Key A", "Codex"]);
    expect(blockedBy(cfg, e)).toEqual([
      { kind: "literal-moved", label: "Key C", from: ptr("/fallbacks/1/api/apiKey"), to: ptr("/provider/api/apiKey") },
      { kind: "literal-moved", label: "Key A", from: ptr("/provider/api/apiKey"), to: ptr("/fallbacks/1/api/apiKey") },
    ]);
  });

  test("an insert above a literal is blocked; an insert below it is not", () => {
    const cfg = API_LITERAL_FIRST();
    const extra = { label: "New", block: { api: { kind: "anthropic", model: "x", apiKeyEnv: "NEW_KEY" } } };
    expect(blockedBy(cfg, insertEntry(entriesOf(cfg), 2, extra))).toEqual([
      { kind: "literal-moved", label: "Key C", from: ptr("/fallbacks/1/api/apiKey"), to: ptr("/fallbacks/2/api/apiKey") },
    ]);
    expect(writeProviderList(cfg, insertEntry(entriesOf(cfg), 3, extra)).ok).toBe(true);
  });

  test("a removal above a literal is blocked; removing the literal's own entry is not", () => {
    const cfg = API_LITERAL_FIRST();
    expect(blockedBy(cfg, removeEntry(entriesOf(cfg), "Local"))).toEqual([
      { kind: "literal-moved", label: "Key C", from: ptr("/fallbacks/1/api/apiKey"), to: ptr("/fallbacks/0/api/apiKey") },
    ]);
    expect(writeProviderList(cfg, removeEntry(entriesOf(cfg), "Key C")).ok).toBe(true);
  });

  test("an edit to a literal entry's other settings, in place, is not blocked", () => {
    const cfg = API_LITERAL_FIRST();
    const e = entriesOf(cfg);
    const kc = e[at(e, "Key C")]!;
    const api = { ...(kc.block["api"] as Json), model: "claude-sonnet-5" };
    const out = written(cfg, setEntrySettings(e, "Key C", { block: { ...(kc.block as Json), api } }));
    expect(((out.config["fallbacks"] as Json[])[1]!["api"] as Json)["apiKey"]).toBe(REDACTED_API_KEY);
  });

  test("a different entry carrying a placeholder at a literal's pointer is blocked (which entry sits there)", () => {
    const cfg = API_LITERAL_FIRST();
    const without = removeEntry(entriesOf(cfg), "Key C");
    const impostor = { label: "Impostor", block: { api: { kind: "anthropic", model: "m", apiKey: REDACTED_API_KEY } } };
    expect(blockedBy(cfg, insertEntry(without, 2, impostor))).toEqual([
      { kind: "literal-moved", label: "Impostor", to: ptr("/fallbacks/1/api/apiKey") },
    ]);
  });

  test("a same-settings fallback above a literal is never pulled into accounts, so the literal stays put (was: blocked)", () => {
    const cfg: Json = {
      provider: { ...CLAUDE },
      fallbacks: [{ label: "Second", ...CLAUDE, configDir: "~/.second" }, { label: "Lit", api: { kind: "anthropic", model: "m", apiKey: REDACTED_API_KEY } }],
    };
    const out = written(cfg, entriesOf(cfg));
    expect(JSON.stringify(out.config)).toBe(JSON.stringify(cfg));
    expect(out.judgeChanged).toBe(false);
  });

  test("a compaction that would move a literal's pointer is blocked (a login pushed out of accounts)", () => {
    const cfg: Json = {
      provider: { ...CLAUDE, accounts: [{ label: "L1" }, { label: "L2", configDir: "~/.l2" }] },
      fallbacks: [{ label: "Lit", api: { kind: "anthropic", model: "m", apiKey: REDACTED_API_KEY } }],
    };
    expect(blockedBy(cfg, setEntrySettings(entriesOf(cfg), "L1", { block: { ...CLAUDE, harden: false } }))).toEqual([
      { kind: "literal-moved", label: "Lit", from: ptr("/fallbacks/0/api/apiKey"), to: ptr("/fallbacks/1/api/apiKey") },
    ]);
  });
});

// ── PR 2's shapes round-trip unchanged ──

describe("PR 2's scrub sentinel and app-owned references", () => {
  test(`the sentinel is the engine's (${KEY_MOVED_ENV}) and an entry carrying it is not a literal: it may move`, () => {
    expect(KEY_MOVED_ENV).toBe("DAILY_BRIEFING_KEY_MOVED");
    const cfg = PR2_SHAPES();
    const out = written(cfg, moveEntry(entriesOf(cfg), 0, 3));
    expect(labelsOf(entriesOf(out.config))).toEqual(["App file key", "App keychain key", "Also moved", "Moved"]);
    expect(out.judgeChanged).toBe(true);
  });

  test("every block — the sentinel, the app key file, the app key command — survives a reorder byte for byte", () => {
    const cfg = PR2_SHAPES();
    const before = new Map(entriesOf(cfg).map((e) => [e.label, JSON.stringify(e.block)]));
    const out = written(cfg, moveEntry(moveEntry(entriesOf(cfg), 3, 0), 2, 1));
    for (const e of entriesOf(out.config)) expect(JSON.stringify(e.block)).toBe(before.get(e.label)!);
    const fb = out.config["fallbacks"] as Json[];
    expect((fb.find((f) => f["label"] === "Moved")!["api"] as Json)["apiKeyEnv"]).toBe(KEY_MOVED_ENV);
    expect((fb.find((f) => f["label"] === "App keychain key")!["api"] as Json)["apiKeyCommand"]).toEqual(appKeyCommand("k-ba9876543210"));
    expect(labelsOf(entriesOf(out.config))).toEqual(["Also moved", "App file key", "Moved", "App keychain key"]);
    expect(engineRows(out.config)).toEqual(intendedRows(entriesOf(out.config)));
  });
});

// ── labels never change ──

describe("labels are identity: the module offers no rename", () => {
  test("the module's surface is exactly read, write, four list edits, the Claude-CLI rule and three value helpers — none renames", () => {
    // PR 3 final r1 (C6): the screen's one `isObject`, `plain` and `KEY_SOURCES` live here, the leaf of its imports.
    // None takes or returns an entry, so none can rename one.
    expect(Object.keys(list).sort()).toEqual(
      // User-directed 2026-10-22 (P2): `cliName` is the Claude-CLI rule's reading of a command's name, exported for
      // Settings' tool choice; it takes a string, never an entry.
      ["DEFAULT_LABEL", "insertEntry", "isClaudeCli", "cliName", "moveEntry", "readProviderList", "removeEntry", "setEntrySettings", "writeProviderList", "isObject", "plain", "KEY_SOURCES"].sort(),
    );
    expect(list.KEY_SOURCES).toEqual(["apiKeyEnv", "apiKeyFile", "apiKeyCommand", "apiKey"]);
    expect(Object.keys(list).filter((k) => /rename|label/i.test(k) && k !== "DEFAULT_LABEL")).toEqual([]);
  });

  test("entries are frozen: a label cannot be reassigned", () => {
    const e = entriesOf(SPEC_EXAMPLE());
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e[0])).toBe(true);
    expect(Object.isFrozen(e[0]!.block)).toBe(true);
    expect(() => { (e[0] as { label: string }).label = "renamed"; }).toThrow(TypeError);
    expect(() => { ((e[0]!.block as Json)["argv"] as string[]).push("x"); }).toThrow(TypeError);
  });

  test("setting an entry's settings cannot change its label, and refuses a block carrying the list's own fields", () => {
    const e = entriesOf(SPEC_EXAMPLE());
    for (const k of ["label", "accounts", "configDir", "fallbacks"]) {
      expect(() => setEntrySettings(e, "Claude login 1", { block: { ...CLAUDE, [k]: k === "accounts" || k === "fallbacks" ? [] : "x" } })).toThrow();
    }
    const edited = setEntrySettings(e, "Claude login 1", { block: { ...CLAUDE } });
    expect(labelsOf(edited)).toEqual(labelsOf(e));
    expect(() => setEntrySettings(e, "nobody", { block: { ...CLAUDE } })).toThrow();
  });

  test("an insert refuses an empty or already-used label and a block carrying a list field", () => {
    const e = entriesOf(SPEC_EXAMPLE());
    expect(() => insertEntry(e, 1, { label: "Local model", block: { ...CLAUDE } })).toThrow();
    expect(() => insertEntry(e, 1, { label: "  ", block: { ...CLAUDE } })).toThrow();
    expect(() => insertEntry(e, 1, { label: "ok", block: { ...CLAUDE, label: "x" } })).toThrow();
  });

  test("the writer refuses a list whose labels collide, and an empty list (`provider` is required)", () => {
    const cfg = SPEC_EXAMPLE();
    const e = entriesOf(cfg);
    const dup = [...e, { ...e[3]! }];
    expect(blockedBy(cfg, dup)).toEqual([{ kind: "duplicate-label", label: "Local model" }]);
    expect(blockedBy(cfg, [])).toEqual([{ kind: "empty" }]);
  });

  test("a write never changes a label: every written config's labels are the list's, in order", () => {
    for (const c of Object.values(EDITS)) {
      const cfg = c.base();
      const edited = c.edit(entriesOf(cfg));
      expect(engineRows(written(cfg, edited).config).map((r) => r.label)).toEqual(labelsOf(edited));
    }
  });
});

describe("the module stays pure", () => {
  test("no IPC and no node built-ins in lib/provider-list.ts", () => {
    const src = readFileSync(new URL("../src/lib/provider-list.ts", import.meta.url), "utf8");
    expect(src.includes("invoke(")).toBe(false);
    expect(/from\s+["']node:/.test(src)).toBe(false);
  });
});
