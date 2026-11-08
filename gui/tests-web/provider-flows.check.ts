/**
 * P3-M4-T2 — Add and remove with keys (`src/lib/provider-flows.ts`; spec r9 §6 "Add, replace, remove").
 *
 * What is pinned here:
 *   1. Add = `key set` → candidate → Test (the validate row's `testTimeoutMs`, unchanged) → Save on a pass, or Save
 *      anyway / Discard after a failed Test; Discard deletes the unused id; a `key set` refusal that names a `keyId`
 *      (cleanup unconfirmed) deletes that id;
 *   2. a Test answering `recorded: false` shows its result AND the not-saved wording, and its outcome still decides
 *      between Save and Save anyway;
 *   3. switching an entry to a pasted key removes its other key sources;
 *   4. app-owned keys need `https:` off this machine, on paste (the engine's `config validate` refusal is shown and the
 *      pasted key removed) and on every later save (the engine's own rule flags the edited config);
 *   5. Remove deletes an app key only once no remaining entry references it, decided from `config validate`'s rows
 *      (`appKeyId`), and keeps it while any row is `appOwnedKey` with no `appKeyId`;
 *   6. the pasted key goes to `providerKeySet` only — never into a config text, a log, a thrown error or saved state;
 *   7. (P3-M4-T3) Replace = `key set` (a NEW id) → Test → the pre-save reset (`provider_pending_reset_add`) → the save →
 *      the post-save reset (`provider_pending_reset_flush`); a `retry` answer shows `REPLACE_WAITING_LINE` and tries
 *      again every 15 s (an injected clock), resuming the save when the reset succeeds; Discard and cancel go through
 *      `provider_pending_reset_drop` AFTER awaiting the replacement's own save; the old key id is never deleted.
 *
 * ⚠ THE IPC IS A RECORDER, NOT TAURI (the `provider-ops.check.ts` pattern): `invoke` calls
 * `window.__TAURI_INTERNALS__.invoke(cmd, args)`, installed per test. Nothing here spawns anything or touches a
 * Keychain (Q27). ⚠ THE VALIDATE ANSWERS ARE THE ENGINE'S: `engineCheck` derives each `providers` row (`appOwnedKey` /
 * `appKeyId`, `loopback`) and the plain-http app-key error from the engine's own functions, imported read-only, applied
 * to the exact text the flow sent — so a flow that sent the wrong candidate gets the wrong rows, as it would live.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// READ-ONLY imports of the engine (no top-level side effects; the set `provider-list.check.ts` already imports).
import { validateConfig } from "../../src/config";
import {
  APP_KEY_SERVICE,
  SECURITY_BIN,
  appKeyOverCleartext,
  appKeyOwnership,
  listOrder,
  resolveProviderList,
} from "../../src/providerList";
import { keyOptional } from "../../src/providers/endpoint";
import {
  KEY_SOURCES,
  addRequestFrom,
  addSaveDecision,
  deleteUnreferencedKeys,
  discardAdd,
  keysOfRemoved,
  leaveAdd,
  loginSource,
  networkAskFor,
  orphanAfter,
  retestAdd,
  saveRemovingKeys,
  startAdd,
  withPastedKey,
  REPLACE_RETRY_MS,
  FlowSteps,
  discardReplace,
  dropLine,
  leaveReplace,
  replaceDiscardable,
  replaceOffered,
  replaceOrphanAfter,
  replacePendingNotes,
  retestReplace,
  saveReplace,
  startReplace,
  type AddRunning,
  type AddStep,
  type PendingAdd,
  type PendingReplace,
  type ReplaceRunning,
  type ReplaceSaveDeps,
  type ReplaceSaveResult,
  type ReplaceStep,
} from "../src/lib/provider-flows";
import {
  REPLACE_WAITING_LINE,
  formSubmission,
  keyTimeoutLine,
  liveErrors,
  networkAskNeeded,
  notRecordedLine,
  literalDraftBanner,
  providersView,
  rawFromDraft,
  statusLine,
  type Draft,
} from "../src/lib/settings-model";
import * as flows from "../src/lib/provider-flows";
import * as model from "../src/lib/settings-model";
import * as unusedKey from "../src/lib/unused-key";
import { EDIT_AS_JSON, REDACTED_API_KEY } from "../src/lib/files";
import { PAGES } from "../src/lib/settings/pages";

type Json = Record<string, unknown>;

const HOME = "/nonexistent-home-for-provider-flows-check";
const KEYS = `${HOME}/state/keys`;
const ENV: Record<string, string | undefined> = {};
const EXISTS = (): boolean => true;
const KEYCHAIN = `${HOME}/Library/Keychains/login.keychain-db`;
const keyCommand = (id: string): string[] => [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-a", id, "-w", KEYCHAIN];

/** The pasted key. Key-rule characters only, and distinctive, so any copy of it anywhere is found. */
const KEY = "pasted-KEY-7f3a9c1e5b2d4086-zz";
const ID = "k-0123456789ab";
const ID2 = "k-ba9876543210";

const CLAUDE = { cli: "claude", argv: ["-p"], promptVia: "stdin" };
const cfgText = (c: Json): string => JSON.stringify(c, null, 2);
const parse = (t: string): Draft => JSON.parse(t) as Draft;

/** A source file as CODE: `/* … *\/` blocks, `//` line comments (at a line's start or after a space or tab — so
 *  `https://` inside a string stays) and `<!-- … -->` removed, newlines kept. Every positive source pin here matches
 *  this, so a commented-out copy of the pinned line can never satisfy it (P3-M4 checkpoint, mutant G11c). */
const codeOf = (src: string): string =>
  src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1")
    .replace(/(^|[ \t])\/\/[^\n]*/gm, "$1")
    .replace(/[ \t]+$/gm, "");

/* ── the recorder ─────────────────────────────────────────────────────────────────────────────── */

type Call = [string, Json];
let calls: Call[] = [];
let handler: (command: string, args: Json) => unknown;
const g = globalThis as { window?: unknown };
let hadWindow = false;
let windowBefore: unknown;
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
let logged: unknown[][] = [];
let consoleBefore: Partial<Record<(typeof CONSOLE_METHODS)[number], unknown>> = {};

beforeEach(() => {
  calls = [];
  handler = engine();
  hadWindow = "window" in g;
  windowBefore = g.window;
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: Json) => {
        calls.push([command, structuredClone(args)]);
        try {
          return Promise.resolve(handler(command, args));
        } catch (e) {
          return Promise.reject(e);
        }
      },
    },
  };
  logged = [];
  consoleBefore = {};
  const c = console as unknown as Record<string, unknown>;
  for (const m of CONSOLE_METHODS) {
    consoleBefore[m] = c[m];
    c[m] = (...args: unknown[]) => {
      logged.push(args);
    };
  }
});

afterEach(() => {
  if (hadWindow) g.window = windowBefore;
  else delete g.window;
  const c = console as unknown as Record<string, unknown>;
  for (const m of CONSOLE_METHODS) c[m] = consoleBefore[m];
});

/* ── the engine's answers ─────────────────────────────────────────────────────────────────────── */

const outcome = (payload: unknown, operation: string) => ({
  operation,
  outcome: { kind: "delivered" },
  exitCode: 0,
  payload,
  stdout: payload === null ? "" : JSON.stringify(payload),
  stderr: "",
});

/** A row's Test bound: distinctive per index, so a Test that sent anything but the row's own value is caught. */
const boundOf = (index: number): number => 80_000 + 1_000 * index + 7;

/**
 * `config validate --json`'s report for `text`, from the engine's own functions: the rows (one per entry the combined
 * list resolves, `appOwnedKey` / `appKeyId` by `appKeyOwnership`, `loopback` the entry's own), and the plain-http
 * app-key error (`appKeyOverCleartext`, the composition `validateCandidateFull` reports). Any other engine error
 * (a broken block) is reported as the validator's message.
 */
function engineCheck(text: string): Json {
  let cfg;
  try {
    cfg = validateConfig(JSON.parse(text), HOME);
  } catch (e) {
    return { kind: "validated", report: { schemaVersion: 1, valid: false, errors: [{ field: "", message: (e as Error).message }], warnings: [], normalized: null, providers: [] } };
  }
  const list = resolveProviderList(cfg, HOME, ENV, EXISTS);
  const providers: Json[] = [];
  const errors: Json[] = [];
  if (!list.accountsBroken) {
    for (const [index, item] of listOrder(list).entries()) {
      if (!("entry" in item)) continue;
      const own = appKeyOwnership(item.entry, KEYS);
      providers.push({
        index,
        testTimeoutMs: boundOf(index),
        loopback: item.entry.isLoopback,
        keyOptional: item.entry.provider.api !== undefined && keyOptional(item.entry.provider.api),
        // No fixture in this file carries PR 2's scrub sentinel (and its one definition, src/providerCli.ts, reaches the
        // scheduler installer, which this folder may not import): every row here is `keyMoved: false`, as the engine says.
        keyMoved: false,
        ...(own.owned ? { appOwnedKey: true, ...(own.id !== undefined ? { appKeyId: own.id } : {}) } : {}),
      });
    }
  }
  for (const d of list.dropped) errors.push({ field: `fallbacks[${d.index}]`, message: d.warning });
  for (const e of list.entries) {
    if (appKeyOverCleartext(e, KEYS) === undefined) continue;
    const field = e.source === "fallback" ? `fallbacks[${e.fallbackIndex}].api.baseUrl` : "provider.api.baseUrl";
    errors.push({ field, message: `"${e.label}": its key is, or may be, one the app stores, which is never sent over plain http to another machine — switch this baseUrl to https` });
  }
  return { kind: "validated", report: { schemaVersion: 1, valid: errors.length === 0, errors, warnings: [], normalized: null, providers } };
}

interface Script {
  keySet?: unknown | (() => unknown);
  /** `config_read`'s text (the SAVED config on disk), or a function answering or throwing. Default: `SAVED`. */
  saved?: string | null | (() => string | null);
  test?: Json;
  del?: unknown;
  /** Rewrite a validate report before it is answered. */
  report?: (r: Json, text: string) => Json;
  /** P3-M4-T3: the pending-reset store's answers (default `reset`, `reset`, `deleted`). */
  add?: (args: Json) => unknown;
  flush?: (args: Json) => unknown;
  drop?: (args: Json) => unknown;
  /** P3-M4-T4: `key migrate`'s answer (or a function answering or throwing), and `key scrub-backup`'s — a list is
   *  answered in turn (its last entry from then on); an entry that is a function is called, and may throw. */
  migrate?: unknown | ((args: Json) => unknown);
  scrub?: unknown[];
}

const migrateOk = (over: Json = {}): Json => ({ schemaVersion: 1, ok: true, keyId: ID, apiKeyCommand: keyCommand(ID), revision: "rev-1", ...over });
const keySetOk = (id = ID): Json => ({ schemaVersion: 1, ok: true, keyId: id, apiKeyCommand: keyCommand(id) });
const testAnswer = (over: Json = {}): Json => ({ schemaVersion: 1, ok: true, passed: true, at: "2026-10-18T07:00:00.000Z", recorded: true, ...over });

/** A scripted engine: `key set`, `key delete`, and the candidate check (validate from the engine, Test as scripted). */
function engine(s: Script = {}): (command: string, args: Json) => unknown {
  return (command, args) => {
    switch (command) {
      case "engine_provider_key_set": {
        const p = typeof s.keySet === "function" ? (s.keySet as () => unknown)() : (s.keySet ?? keySetOk());
        return outcome(p, "provider-key-set");
      }
      case "engine_provider_key_delete":
        return outcome(s.del ?? { schemaVersion: 1, ok: true, deleted: true }, "provider-key-delete");
      case "provider_pending_reset_add":
        return s.add ? s.add(args) : { kind: "reset" };
      case "provider_pending_reset_flush":
        return s.flush ? s.flush(args) : { kind: "reset" };
      case "provider_pending_reset_drop":
        return s.drop ? s.drop(args) : { kind: "deleted" };
      case "engine_provider_key_migrate": {
        const p = typeof s.migrate === "function" ? (s.migrate as (a: Json) => unknown)(args) : (s.migrate ?? migrateOk());
        return outcome(p, "provider-key-migrate");
      }
      case "engine_provider_key_scrub_backup": {
        const list = s.scrub ?? [{ schemaVersion: 1, ok: true, removed: 1 }];
        const seen = calls.filter(([c]) => c === "engine_provider_key_scrub_backup").length;
        const next = list[Math.min(seen, list.length) - 1] ?? list[list.length - 1];
        return outcome(typeof next === "function" ? (next as () => unknown)() : next, "provider-key-scrub-backup");
      }
      case "config_read": {
        const text = typeof s.saved === "function" ? s.saved() : s.saved === undefined ? SAVED : s.saved;
        return { path: `${HOME}/config.json`, exists: text !== null, text, base: text === null ? null : "b-1", parseError: null, apiKeyRedacted: false };
      }
      case "provider_candidate_check": {
        const text = args["text"] as string;
        if (args["mode"] === "validate") {
          const r = engineCheck(text);
          return s.report ? { ...r, report: s.report(r["report"] as Json, text) } : r;
        }
        return { kind: "tested", answer: s.test ?? testAnswer(), boundMs: (args["mode"] as { test: { testTimeoutMs: number } }).test.testTimeoutMs };
      }
      default:
        throw new Error(`unexpected command ${command}`);
    }
  };
}

const commands = (): string[] => calls.map(([c, a]) => (c === "provider_candidate_check" ? (a["mode"] === "validate" ? "validate" : "test") : c));
const deletes = (): unknown[] => calls.filter(([c]) => c === "engine_provider_key_delete").map(([, a]) => a["id"]);
const sentTexts = (): string[] => calls.filter(([c]) => c === "provider_candidate_check").map(([, a]) => a["text"] as string);

/** Everything the key could have leaked into, in one string: every IPC argument EXCEPT `key set`'s own, every console
 *  line, and the given results. */
function everywhereBut(...results: unknown[]): string {
  const ipc = calls.filter(([c]) => c !== "engine_provider_key_set").map(([, a]) => JSON.stringify(a));
  return [...ipc, JSON.stringify(logged), JSON.stringify(results)].join("\n");
}

const SAVED = cfgText({ provider: CLAUDE, networkProbeHosts: [] });
const ANTHROPIC = { api: { kind: "anthropic", model: "claude-sonnet-5" } };

function tested(step: AddStep): { pending: PendingAdd; lines: string[] } {
  if (step.kind !== "tested") throw new Error(`expected a tested step, got ${JSON.stringify(step)}`);
  return step;
}

/* ── D-M5-T9: "the Raw JSON tab" is gone ──────────────────────────────────────────────────────── */

describe("D-M5-T9: every sentence that sent the user to the Raw JSON tab names Edit settings as JSON on Advanced", () => {
  const SRC = new URL("../src/", import.meta.url).pathname;
  const files = [...new Bun.Glob("**/*.{ts,svelte}").scanSync({ cwd: SRC })].sort();
  const code = (f: string): string => codeOf(readFileSync(`${SRC}${f}`, "utf8"));
  /** Every sentence that uses the phrase, per file, as its code reads: a `${…}` in a template string, a `{…}` in
   *  markup. Each file's count of the phrase is exactly its list's length, so a sentence dropped, reworded or doubled
   *  fails here; the sentences a function returns are also checked as text below and in `settings.check.ts`. */
  const USES: Record<string, string[]> = {
    "lib/files.ts": ["A key typed in here: remove it with ${EDIT_AS_JSON} (or discard your changes), then give"],
    "lib/settings-model.ts": [
      "Remove it with ${EDIT_AS_JSON} (or discard your changes), then give",
      "remove the key with ${EDIT_AS_JSON}, then either save",
      // Round 9 (L11): the invalid row's remedy, unless its reason is a stray login folder (cleared in the row).
      ': `The briefing skips it. Fix it with ${EDIT_AS_JSON}, or remove it.`',
      "could not be read (${UNREADABLE[read.reason]}). Fix it with ${EDIT_AS_JSON}.` };",
      // User-directed 2026-10-22 (P-A): the note under the list, on where a backup's settings are changed.
      "move it to the top of the list, or use ${EDIT_AS_JSON}.`;",
    ],
    "lib/calendar-settings.ts": [
      "could not be read, so nothing was changed. Fix them with ${EDIT_AS_JSON}.` };",
      // Round 10 (H1): the Connections help while the engine cannot read the block — the switch cannot save either.
      "and until then this page cannot save them, its switch included. Fix them with ${EDIT_AS_JSON}.`;",
    ],
    "lib/CalendarSettings.svelte": ['<p class="bad">The config\'s calendar settings could not be read. Fix them with {EDIT_AS_JSON}.</p>'],
    // User-directed 2026-10-22 (P4): SettingsForm's "Switching between a command-line provider and an API provider is
    // done with … the engine refuses a config that has both" was untrue and is gone (moving a row to the top switches).
    "lib/provider-flows.ts": [
      "Not added: the list of providers in the settings could not be read. Fix it with ${EDIT_AS_JSON}.` };",
      "a command that prints the key (apiKeyCommand) with ${EDIT_AS_JSON} instead.`;",
      "Not replaced: the list of providers in the settings could not be read. Fix it with ${EDIT_AS_JSON}.` };",
      "(a key is 8 to 512 letters, digits and . _ ~ + / = -). Fix or remove it with ${EDIT_AS_JSON}.`;",
    ],
  };

  test("the phrase is set once, in files.ts, and names the page and the button as they are drawn", () => {
    expect(EDIT_AS_JSON).toBe("Edit settings as JSON on Settings → Advanced");
    expect(PAGES.find((p) => p.id === "advanced")?.label).toBe("Advanced");
    // Redesign D final round 1 (M2): Step 0's ActionButton draws it.
    expect(code("lib/settings/AdvancedPage.svelte")).toContain(">Edit settings as JSON</ActionButton>");
    expect(files.length).toBeGreaterThan(50);
    const spelled = files.filter((f) => /Edit settings as JSON on|on Settings → Advanced/.test(code(f)));
    expect(spelled).toEqual(["lib/files.ts"]);
    expect(code("lib/files.ts").split('"Edit settings as JSON on Settings → Advanced"').length - 1).toBe(1);
  });

  test("no code under gui/src says raw JSON, the raw tab or the form tab (comments excluded)", () => {
    const left = files.filter((f) => /raw json|raw tab|form tab/i.test(code(f).replace(/\s+/g, " ")));
    expect(left).toEqual([]);
  });

  test("each sentence that named the tab uses the phrase, and no file uses it anywhere else", () => {
    const using = files.filter((f) => code(f).includes("EDIT_AS_JSON}"));
    expect(using).toEqual(Object.keys(USES).sort());
    for (const [f, sentences] of Object.entries(USES)) {
      const c = code(f).replace(/\s+/g, " ");
      expect({ f, uses: c.split("EDIT_AS_JSON}").length - 1 }).toEqual({ f, uses: sentences.length });
      for (const s of sentences) expect({ f, s, found: c.includes(s) }).toEqual({ f, s, found: true });
    }
  });

  test("the sentences the model returns read whole", () => {
    const unreadable = providersView({ draft: { provider: { cli: "claude" }, fallbacks: "x" } as unknown as Draft, savedText: null, rows: null, now: new Date(0) });
    expect(unreadable.readable === false ? unreadable.message : "").toEndWith(". Fix it with Edit settings as JSON on Settings → Advanced.");
    expect(statusLine({ kind: "invalid", reason: "r" } as Parameters<typeof statusLine>[0], new Date(0)).remedy).toBe(
      "The briefing skips it. Fix it with Edit settings as JSON on Settings → Advanced, or remove it.",
    );
    expect(literalDraftBanner("macos", false)).toContain(
      "The provider is not saved yet, so Replace key is not offered: remove the key with Edit settings as JSON on Settings → Advanced, then either save it without the key",
    );
  });
});

/* ── 3. switching to a pasted key ─────────────────────────────────────────────────────────────── */

describe("switching an entry to a pasted key removes its other key sources", () => {
  test("every other source goes, the new reference is set exactly as answered, the rest of the block stays", () => {
    expect([...KEY_SOURCES].sort()).toEqual(["apiKey", "apiKeyCommand", "apiKeyEnv", "apiKeyFile"]);
    const block = {
      api: { kind: "anthropic", model: "m", baseUrl: "https://gw.example", maxTokens: 900, apiKey: "(placeholder)", apiKeyEnv: "MY_KEY", apiKeyFile: "/k", apiKeyCommand: ["pass", "show", "x"] },
      timeoutMs: 123,
    };
    const before = structuredClone(block);
    const mac = withPastedKey(block, { apiKeyCommand: keyCommand(ID) });
    expect(mac).toEqual({ api: { kind: "anthropic", model: "m", baseUrl: "https://gw.example", maxTokens: 900, apiKeyCommand: keyCommand(ID) }, timeoutMs: 123 });
    const linux = withPastedKey(block, { apiKeyFile: `${KEYS}/${ID}.key` });
    expect(linux).toEqual({ api: { kind: "anthropic", model: "m", baseUrl: "https://gw.example", maxTokens: 900, apiKeyFile: `${KEYS}/${ID}.key` }, timeoutMs: 123 });
    expect(block).toEqual(before);
    // The reference is a copy: editing the result never reaches the engine's answer.
    const ref = { apiKeyCommand: keyCommand(ID) };
    const out = withPastedKey(block, ref) as { api: { apiKeyCommand: string[] } };
    out.api.apiKeyCommand.push("x");
    expect(ref.apiKeyCommand).toEqual(keyCommand(ID));
    // A command-line block has no key to switch.
    expect(() => withPastedKey({ ...CLAUDE }, ref)).toThrow();
  });

  test("an Add whose block names other sources saves only the new reference", async () => {
    const step = tested(await startAdd(parse(SAVED), { label: "API", block: { api: { kind: "anthropic", model: "m", apiKeyEnv: "OLD", apiKeyFile: "/old", apiKeyCommand: ["old"], apiKey: "lit" } } }, KEY, "macos"));
    const fallback = (parse(step.pending.text)["fallbacks"] as Json[])[0]!;
    expect(fallback).toEqual({ label: "API", api: { kind: "anthropic", model: "m", apiKeyCommand: keyCommand(ID) } });
    // Not even the keyless check before `key set` carried another source.
    expect(sentTexts()[0]).not.toMatch(/OLD|"\/old"|"lit"/);
  });
});

/* ── 1. Add ───────────────────────────────────────────────────────────────────────────────────── */

describe("Add: key set → candidate → Test → Save, Save anyway or Discard", () => {
  test("a pass: checked keyless first, then stored, then the candidate validated and tested with its row's bound — ready to Save", async () => {
    const step = tested(await startAdd(parse(SAVED), { label: "Anthropic key", block: ANTHROPIC }, KEY, "macos"));
    expect(commands()).toEqual(["validate", "engine_provider_key_set", "validate", "test"]);
    expect(calls[1]![1]).toEqual({ key: KEY });
    // The Test is of the new entry (index 1), with that row's `testTimeoutMs` and nothing else.
    expect(calls[3]![1]["mode"]).toEqual({ test: { index: 1, testTimeoutMs: boundOf(1) } });
    expect(calls[3]![1]["text"]).toBe(step.pending.text);
    expect(step.pending).toMatchObject({ label: "Anthropic key", keyId: ID, passed: true, ran: true, index: 1 });
    expect(step.lines).toEqual(["Test passed."]);
    // The candidate: the draft plus the entry as a `fallbacks` block (P3-M3: new entries are never pulled into accounts).
    const cand = parse(step.pending.text);
    expect(cand["provider"]).toEqual(CLAUDE);
    expect(cand["fallbacks"]).toEqual([{ label: "Anthropic key", api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyCommand: keyCommand(ID) } }]);
    expect(cand["networkProbeHosts"]).toEqual([]);
    // The engine reads the saved reference as that very app key.
    expect(((engineCheck(step.pending.text)["report"] as Json)["providers"] as Json[])[1]).toMatchObject({ appOwnedKey: true, appKeyId: ID });
    expect(deletes()).toEqual([]);
  });

  test("a failed Test keeps the stored key and offers Save anyway (the Test ran)", async () => {
    handler = engine({ test: testAnswer({ passed: false, reason: "auth" }) });
    const step = tested(await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "linux"));
    expect(step.pending).toMatchObject({ keyId: ID, passed: false, ran: true });
    expect(step.lines[0]).toBe("Test failed: key or login rejected.");
    expect(deletes()).toEqual([]);
  });

  test("a Test that did not run (a second Test is busy, or the engine refused) offers Test again, not Save anyway", async () => {
    handler = engine();
    const inner = handler;
    handler = (c, a) => {
      if (c === "provider_candidate_check" && a["mode"] !== "validate") throw { kind: "busy", running: "provider-test" };
      return inner(c, a);
    };
    const step = tested(await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "macos"));
    expect(step.pending).toMatchObject({ passed: false, ran: false, keyId: ID });
    expect(step.lines[0]).toStartWith("Not tested:");
    // Test again: the same key (no second `key set`), the current draft, the row's bound.
    calls = [];
    handler = engine();
    const again = await retestAdd(parse(SAVED), step.pending);
    expect(commands()).toEqual(["validate", "test"]);
    expect(again.pending).toMatchObject({ passed: true, ran: true, keyId: ID });
    expect(again.pending.text).toBe(step.pending.text);
  });

  test("Discard deletes the unused new id — and only it", async () => {
    handler = engine({ test: testAnswer({ passed: false, reason: "unreachable" }) });
    const step = tested(await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "macos"));
    calls = [];
    const lines = await discardAdd(step.pending, "macos");
    // The CURRENT saved config is re-read and checked first (it references no app key here), then the id deleted.
    expect(commands()).toEqual(["config_read", "validate", "engine_provider_key_delete"]);
    expect(sentTexts()).toEqual([SAVED]);
    expect(deletes()).toEqual([ID]);
    expect(lines.join(" ")).toContain("removed");
    // A delete that fails is said, never swallowed.
    calls = [];
    handler = engine({ del: { schemaVersion: 1, ok: false, code: "write-failed", error: "key delete: x", reason: "timeout" } });
    const failed = await discardAdd(step.pending, "macos");
    expect(failed.join(" ")).toContain("could not be removed");
    expect(failed.join(" ")).toContain(keyTimeoutLine("macos"));
    // A keyless entry (a login) has nothing to delete.
    calls = [];
    expect(await discardAdd({ ...step.pending, keyId: null, ref: null }, "macos")).toEqual(["Discarded."]);
    expect(calls).toEqual([]);
  });

  test("Discard is fail-safe: it never deletes a key the CURRENT saved config may be using, nor one it cannot vouch for", async () => {
    handler = engine({ test: testAnswer({ passed: false, reason: "unreachable" }) });
    const step = tested(await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "macos"));
    // The add's own candidate, as a save that landed would have written it: a saved row carries the id.
    const landed = step.pending.text;
    expect(((engineCheck(landed)["report"] as Json)["providers"] as Json[])[1]).toMatchObject({ appKeyId: ID });
    const anyKey = { label: "D", api: { kind: "anthropic", model: "m", apiKeyCommand: [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-w", KEYCHAIN] } };
    const cases: [string, Script, string][] = [
      ["a saved row carries the id", { saved: landed }, "the saved settings already use"],
      ["no saved config to read", { saved: null }, "could not be read"],
      ["the read fails", { saved: () => { throw { kind: "io", detail: "x" }; } }, "could not be read"],
      ["the check of the saved config fails", { saved: landed, report: () => { throw { kind: "timeout", operation: "config-validate", seconds: 30 }; } }, "could not be checked"],
      ["fewer rows than entries", { saved: landed, report: (r) => ({ ...r, providers: (r["providers"] as Json[]).slice(0, 1) }) }, "not every provider"],
      ["a saved row may read ANY app key", { saved: cfgText({ provider: CLAUDE, fallbacks: [anyKey] }) }, "may read any key"],
    ];
    for (const [name, script, said] of cases) {
      calls = [];
      handler = engine(script);
      const lines = await discardAdd(step.pending, "macos");
      expect({ name, deletes: deletes() }).toEqual({ name, deletes: [] });
      expect({ name, said: lines.join(" ").includes(said) }).toEqual({ name, said: true });
      expect(commands()[0]).toBe("config_read");
    }
    // Non-vacuous: the same pending add, against a saved config that does not use the key, is deleted.
    calls = [];
    handler = engine({ saved: SAVED });
    await discardAdd(step.pending, "macos");
    expect(deletes()).toEqual([ID]);
  });

  test("a key set refusal that names a keyId (cleanup unconfirmed) deletes that id; one without keyId deletes nothing", async () => {
    for (const os of ["macos", "linux"] as const) {
      calls = [];
      handler = engine({ keySet: { schemaVersion: 1, ok: false, code: "write-failed", error: "key set: x", reason: "timeout", cleanup: "timeout", keyId: ID2 } });
      const step = await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, os);
      expect(step.kind).toBe("refused");
      expect(commands()).toEqual(["validate", "engine_provider_key_set", "engine_provider_key_delete"]);
      expect(deletes()).toEqual([ID2]);
      expect(step.lines.join(" ")).toContain(keyTimeoutLine(os));
      expect(everywhereBut(step)).not.toContain(KEY);
    }
    calls = [];
    handler = engine({ keySet: { schemaVersion: 1, ok: false, code: "write-failed", error: "key set: x", reason: "readback-mismatch", cleanup: "deleted" } });
    const clean = await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "macos");
    expect(clean.kind).toBe("refused");
    expect(deletes()).toEqual([]);
    // The engine's key rule, in words.
    calls = [];
    handler = engine({ keySet: { schemaVersion: 1, ok: false, code: "usage", error: "key set: x", reason: "invalid-key" } });
    const bad = await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "macos");
    expect(bad.lines.join(" ")).toContain("8 to 512");
    // A platform that cannot keep a pasted key (the file store's `unsupported-platform`): the shared wording, with
    // Settings' own way out (PR 3 final r1, B5 — before, it read "could not be stored (unsupported-platform)").
    calls = [];
    handler = engine({ keySet: { schemaVersion: 1, ok: false, code: "write-failed", error: "key set: x", reason: "unsupported-platform" } });
    const win = await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "linux");
    expect(win.lines).toEqual(["Not added: this computer cannot keep a pasted key. Give this provider a command that prints the key (apiKeyCommand) with Edit settings as JSON on Settings → Advanced instead."]);
    // The app's own 19 s bound on `key set` is worded per platform too.
    calls = [];
    handler = (c, a) => {
      if (c === "engine_provider_key_set") throw { kind: "timeout", operation: "provider-key-set", seconds: 19 };
      return engine()(c, a);
    };
    const slow = await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "linux");
    expect(slow.lines.join(" ")).toContain(keyTimeoutLine("linux"));
    // No JSON line: a crash, never read as a refusal or a success.
    calls = [];
    handler = engine({ keySet: () => null });
    const crashed = await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "macos");
    expect(crashed.kind).toBe("refused");
    expect(commands()).toEqual(["validate", "engine_provider_key_set"]);
  });

  test("an add the list or the engine refuses before the key is needed stores nothing", async () => {
    // A label already used.
    let step = await startAdd(parse(SAVED), { label: "default", block: ANTHROPIC }, KEY, "macos");
    expect(step.kind).toBe("refused");
    expect(calls).toEqual([]);
    // No key pasted for an API provider.
    step = await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, "   ", "macos");
    expect(step.kind).toBe("refused");
    expect(calls).toEqual([]);
    // The keyless candidate does not validate (here: an api block with no model): no `key set`.
    step = await startAdd(parse(SAVED), { label: "API", block: { api: { kind: "anthropic" } } }, KEY, "macos");
    expect(step.kind).toBe("refused");
    expect(commands()).toEqual(["validate"]);
  });

  test("a command-line login is added with no key: no key set, the Test is of the login", async () => {
    const saved = cfgText({ provider: { ...CLAUDE, accounts: [{ label: "work" }] } });
    const req = addRequestFrom(parse(saved), { kind: "login", label: " personal ", model: "", baseUrl: "", configDir: " ~/.claude-personal " });
    expect(req).toEqual({ label: "personal", block: CLAUDE, configDir: "~/.claude-personal" });
    const step = tested(await startAdd(parse(saved), req as Exclude<typeof req, { error: string }>, null, "macos"));
    expect(commands()).toEqual(["validate", "test"]);
    expect(step.pending).toMatchObject({ keyId: null, ref: null, passed: true });
    expect(parse(step.pending.text)["fallbacks"]).toEqual([{ label: "personal", configDir: "~/.claude-personal", ...CLAUDE }]);
  });

  test("the add form's request: an API provider, or another login of the list's first command-line tool", () => {
    const d = parse(SAVED);
    expect(addRequestFrom(d, { kind: "anthropic", label: "A", model: " m ", baseUrl: "", configDir: "" })).toEqual({ label: "A", block: { api: { kind: "anthropic", model: "m" } } });
    expect(addRequestFrom(d, { kind: "openai-compatible", label: "L", model: "m", baseUrl: " https://h/v1 ", configDir: "" })).toEqual({ label: "L", block: { api: { kind: "openai-compatible", model: "m", baseUrl: "https://h/v1" } } });
    expect(addRequestFrom(d, { kind: "anthropic", label: "  ", model: "m", baseUrl: "", configDir: "" })).toHaveProperty("error");
    expect(addRequestFrom(d, { kind: "anthropic", label: "A", model: "", baseUrl: "", configDir: "" })).toHaveProperty("error");
    expect(addRequestFrom(d, { kind: "login", label: "B", model: "", baseUrl: "", configDir: "" })).toHaveProperty("error");
    const apiOnly = parse(cfgText({ provider: ANTHROPIC }));
    expect(addRequestFrom(apiOnly, { kind: "login", label: "B", model: "", baseUrl: "", configDir: "~/.b" })).toHaveProperty("error");
  });

  test("another login is offered only of a Claude command-line tool: never of a codex one, whose login folder the engine refuses", () => {
    const CODEX = { cli: "codex", argv: ["exec"], promptVia: "stdin" };
    const login = { kind: "login" as const, label: "B", model: "", baseUrl: "", configDir: "~/.b" };
    // Claude first: offered, and the request copies it.
    expect(loginSource(parse(SAVED))?.label).toBe("default");
    expect(addRequestFrom(parse(SAVED), login)).toEqual({ label: "B", block: CLAUDE, configDir: "~/.b" });
    // A Windows spelling of Claude counts too (the engine's basename on Windows).
    const win = { ...CLAUDE, cli: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd" };
    expect(loginSource(parse(cfgText({ provider: win })))?.block).toEqual(win);
    // The first command-line entry is codex: nothing offered, and the request is refused before anything runs.
    for (const cfg of [{ provider: CODEX }, { provider: ANTHROPIC, fallbacks: [{ label: "Codex", ...CODEX }, { label: "Claude", ...CLAUDE }] }]) {
      expect(loginSource(parse(cfgText(cfg)))).toBeNull();
      expect(addRequestFrom(parse(cfgText(cfg)), login)).toHaveProperty("error");
    }
    // Non-vacuous: such a login, were it requested, is one the engine refuses (a login folder on a non-Claude tool).
    const forced = { label: "B", block: CODEX, configDir: "~/.b" };
    calls = [];
    return startAdd(parse(cfgText({ provider: CODEX })), forced, null, "macos").then((step) => {
      expect(step.kind).toBe("refused");
      expect(step.lines.join(" ")).toContain("applies to a Claude CLI entry only");
      expect(commands()).toEqual(["validate"]);
    });
  });
});

/* ── user-directed 2026-10-22 (P1): Add a command-line tool ───────────────────────────────────── */

describe("P1: Add offers a command-line tool — Claude Code, Codex or another command", () => {
  const CODEX = { cli: "codex", argv: ["exec"], promptVia: "stdin" };
  const cliForm = (over: Partial<flows.AddForm> = {}): flows.AddForm => ({ kind: "cli", label: "Tool", model: "", baseUrl: "", configDir: "", ...over });
  const API_ONLY = cfgText({ provider: ANTHROPIC, networkProbeHosts: [] });

  test("the two named tools are the engine's own `init` values: claude -p and codex exec, the prompt on standard input", () => {
    const config = readFileSync(new URL("../../src/config.ts", import.meta.url), "utf8");
    expect(config).toContain('const argv = codexPath && cli === codexPath ? ["exec"] : ["-p"];');
    expect(config).toContain('provider: { cli, argv, promptVia: "stdin" },');
    expect(model.TOOL_PRESETS).toEqual([
      { id: "claude", label: "Claude Code (claude)", cli: "claude", argv: ["-p"], promptVia: "stdin" },
      { id: "codex", label: "Codex (codex)", cli: "codex", argv: ["exec"], promptVia: "stdin" },
    ]);
  });

  test("the request: a named tool's block, or another command with its arguments one per line — never a login folder", () => {
    const d = parse(API_ONLY);
    expect(addRequestFrom(d, cliForm({ label: " Claude ", tool: "claude" }))).toEqual({ label: "Claude", block: CLAUDE });
    expect(addRequestFrom(d, cliForm({ tool: "codex" }))).toEqual({ label: "Tool", block: CODEX });
    // No tool chosen yet reads as the select's first choice, Claude Code.
    expect(addRequestFrom(d, cliForm())).toEqual({ label: "Tool", block: CLAUDE });
    expect(addRequestFrom(d, cliForm({ tool: "other", command: " /opt/bin/gemini ", args: " -p \n\n --yolo \n" }))).toEqual({
      label: "Tool",
      block: { cli: "/opt/bin/gemini", argv: ["-p", "--yolo"], promptVia: "stdin" },
    });
    // An argument with a space in it stays one argument (one per line, never split on spaces).
    expect(addRequestFrom(d, cliForm({ tool: "other", command: "wrap", args: "--name my tool" }))).toEqual({ label: "Tool", block: { cli: "wrap", argv: ["--name my tool"], promptVia: "stdin" } });
    expect(addRequestFrom(d, cliForm({ tool: "other", command: "wrap" }))).toEqual({ label: "Tool", block: { cli: "wrap", argv: [], promptVia: "stdin" } });
    // A login folder typed for another kind is never carried (the engine drops configDir on a non-Claude entry).
    expect(addRequestFrom(d, cliForm({ tool: "codex", configDir: "~/.x" }))).toEqual({ label: "Tool", block: CODEX });
    // Refused before anything runs: no name, no command.
    expect(addRequestFrom(d, cliForm({ label: " " }))).toHaveProperty("error");
    expect(addRequestFrom(d, cliForm({ tool: "other", command: "  " }))).toHaveProperty("error");
  });

  test("a second Claude Code on the tool's own login is refused in the form, in words — the engine would drop it as a duplicate login", async () => {
    // SAVED: item 1 is Claude Code with no login folder.
    const req = addRequestFrom(parse(SAVED), cliForm({ tool: "claude", label: "Again" }));
    expect(req).toHaveProperty("error");
    const why = (req as { error: string }).error;
    expect(why).toBe(
      'This would be the same Claude login as "default" (the same login folder and credential), so the briefing could not fall back from one to the other. To add another Claude login, choose "Another Claude account" and give it a login folder of its own.',
    );
    // A path spelling of Claude counts (the engine's `claudeShaped`), and so does a later Claude entry.
    const later = cfgText({ provider: ANTHROPIC, fallbacks: [{ label: "Mine", ...CLAUDE, cli: "/opt/homebrew/bin/claude" }] });
    const r2 = addRequestFrom(parse(later), cliForm({ tool: "claude" }));
    expect((r2 as { error: string }).error).toContain('the same Claude login as "Mine"');
    // With no Claude tool first among the command-line ones, no "Another login" is offered, so none is named.
    const codexFirst = cfgText({ provider: CODEX, fallbacks: [{ label: "Mine", ...CLAUDE }] });
    const r3 = (addRequestFrom(parse(codexFirst), cliForm({ tool: "claude" })) as { error: string }).error;
    expect(r3).toContain('the same Claude login as "Mine"');
    expect(r3).not.toContain("Another login");
    // Not refused: an entry with its own login folder, or one on the other credential, is a different login.
    for (const cfg of [
      { provider: { ...CLAUDE, accounts: [{ label: "W", configDir: "~/.claude-work" }] } },
      { provider: { ...CLAUDE, credential: "env-api-key" } },
      { provider: ANTHROPIC },
    ]) {
      expect({ cfg, req: addRequestFrom(parse(cfgText(cfg)), cliForm({ tool: "claude" })) }).toEqual({ cfg, req: { label: "Tool", block: CLAUDE } });
    }
    // Codex has no login of this kind: never refused for it.
    expect(addRequestFrom(parse(SAVED), cliForm({ tool: "codex" }))).toEqual({ label: "Tool", block: CODEX });
    // Non-vacuous: the refused request, were it run, is one the engine drops as the same login.
    calls = [];
    const step = await startAdd(parse(SAVED), { label: "Again", block: CLAUDE }, null, "macos");
    expect(step.kind).toBe("refused");
    expect(step.lines.join(" ")).toContain("is the same Claude login (directory and credential) as an earlier entry");
    // ...and the allowed one on the other credential is one the engine keeps.
    const other = cfgText({ provider: { ...CLAUDE, credential: "env-api-key" }, networkProbeHosts: [] });
    calls = [];
    const ok = tested(await startAdd(parse(other), { label: "Tool", block: CLAUDE }, null, "macos"));
    expect(commands()).toEqual(["validate", "test"]);
    expect(ok.pending.keyId).toBeNull();
  });

  test("Codex is added keyless, Tested as its own entry, written as a full fallback block with no login folder", async () => {
    const req = addRequestFrom(parse(SAVED), cliForm({ tool: "codex", label: "Codex" }));
    expect(req).toEqual({ label: "Codex", block: CODEX });
    const step = tested(await startAdd(parse(SAVED), req as flows.AddRequest, null, "macos"));
    expect(commands()).toEqual(["validate", "test"]);
    expect(step.pending).toMatchObject({ keyId: null, ref: null, passed: true, index: 1 });
    expect(parse(step.pending.text)["fallbacks"]).toEqual([{ label: "Codex", ...CODEX }]);
    // The engine resolves it: two entries, nothing dropped.
    const list = resolveProviderList(validateConfig(JSON.parse(step.pending.text), HOME), HOME, ENV, EXISTS);
    expect([list.entries.map((e) => e.label), list.dropped]).toEqual([["default", "Codex"], []]);
  });

  test("Settings hands a command-line add no key, as it does a login", () => {
    const settings = codeOf(readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    expect(settings).toContain('void runProviderAdd(base, req, form.kind === "login" || form.kind === "cli" ? null : key);');
  });
});

/* ── follow-up 4: a keyless local model (user decision 2026-10-19) ────────────────────────────── */

describe("Add with no key pasted: a local model goes on keyless only when the engine's row says keyOptional", () => {
  const LOCAL = { label: "Ollama", block: { api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1" } } };
  const rowsOf = (text: string): Json[] => (engineCheck(text)["report"] as Json)["providers"] as Json[];
  const keySets = (): number => calls.filter(([c]) => c === "engine_provider_key_set").length;

  test("keyless local: validated, its row keyOptional: true, no key set, Tested keyless — a pending add with no key", async () => {
    for (const key of ["", "   "]) {
      calls = [];
      const step = tested(await startAdd(parse(SAVED), LOCAL, key, "macos"));
      // The keyless candidate is validated ONCE and its row read; the Test is of the new entry, with that row's bound.
      expect({ key, commands: commands() }).toEqual({ key, commands: ["validate", "test"] });
      expect(keySets()).toBe(0);
      expect(calls[1]![1]["mode"]).toEqual({ test: { index: 1, testTimeoutMs: boundOf(1) } });
      expect(calls[1]![1]["text"]).toBe(step.pending.text);
      expect(step.pending).toMatchObject({ label: "Ollama", keyId: null, ref: null, index: 1, passed: true, ran: true });
      expect(step.pending.rows[1]).toMatchObject({ index: 1, loopback: true, keyOptional: true });
      expect(step.lines).toEqual(["Test passed."]);
      // The entry carries no key source at all, and the engine sees no app key on it.
      expect(parse(step.pending.text)["fallbacks"]).toEqual([{ label: "Ollama", api: LOCAL.block.api }]);
      expect(rowsOf(step.pending.text)[1]).not.toHaveProperty("appOwnedKey");
    }
  });

  test("keyless local: Save writes the entry with no key source, with no network question; Discard and leaving delete nothing", async () => {
    const step = tested(await startAdd(parse(SAVED), LOCAL, "", "macos"));
    const save = addSaveDecision({ draft: parse(SAVED), testedOn: rawFromDraft(parse(SAVED)), errors: {}, pending: step.pending, askNetwork: false, networkYes: true });
    expect(save).toEqual({ kind: "save", text: step.pending.text, asked: false });
    const api = ((parse(step.pending.text)["fallbacks"] as Json[])[0]!["api"]) as Json;
    for (const k of KEY_SOURCES) expect({ k, has: k in api }).toEqual({ k, has: false });
    // A loopback entry is not remote: the network-check question is not due (the engine's row decides it).
    expect(networkAskNeeded(SAVED, parse(step.pending.text), false, step.pending.rows)).toBe(false);
    expect(await networkAskFor(SAVED, step.pending.text, false)).toBe(false);
    // Discard: nothing stored, so nothing read, checked or deleted.
    calls = [];
    expect(await discardAdd(step.pending, "macos")).toEqual(["Discarded."]);
    expect(calls).toEqual([]);
    // Leaving the screen, or a step ending after it: the orphan is this add, and removing it deletes nothing.
    const left = leaveAdd("none", step.pending);
    const orphan = orphanAfter(true, { step });
    expect(left).toBe(step.pending);
    expect(orphan).toBe(step.pending);
    expect(await discardAdd(orphan!, "macos")).toEqual(["Discarded."]);
    expect(deletes()).toEqual([]);
    expect(keySets()).toBe(0);
  });

  test("keyless local: a failed Test offers Save anyway, and Test again re-tests keyless (no key set)", async () => {
    handler = engine({ test: testAnswer({ passed: false, reason: "unreachable" }) });
    const step = tested(await startAdd(parse(SAVED), LOCAL, "", "linux"));
    expect(step.pending).toMatchObject({ keyId: null, ref: null, passed: false, ran: true });
    calls = [];
    handler = engine();
    const again = await retestAdd(parse(SAVED), step.pending);
    expect(commands()).toEqual(["validate", "test"]);
    expect(again.pending).toMatchObject({ keyId: null, ref: null, passed: true });
    expect(again.pending.text).toBe(step.pending.text);
  });

  test("keyless remote: refused, saying why — no key set, no Test", async () => {
    const remotes = [
      { label: "Gateway", block: { api: { kind: "openai-compatible", model: "m", baseUrl: "https://gw.example/v1" } } },
      { label: "LAN box", block: { api: { kind: "openai-compatible", model: "m", baseUrl: "http://192.168.1.20:8080/v1" } } },
    ];
    for (const req of remotes) {
      calls = [];
      const step = await startAdd(parse(SAVED), req, "", "macos");
      expect({ label: req.label, kind: step.kind, commands: commands() }).toEqual({ label: req.label, kind: "refused", commands: ["validate"] });
      expect(step.lines).toEqual([
        "Not added: paste the provider's API key: its address is not on this computer, and only an OpenAI-compatible model on this computer can be added without one.",
      ]);
    }
    // The NEW entry's row decides — not another entry's: a list whose first entry is local still refuses a remote add.
    const localFirst = cfgText({ provider: LOCAL.block, networkProbeHosts: [] });
    expect(rowsOf(localFirst)[0]).toMatchObject({ index: 0, loopback: true });
    calls = [];
    const step = await startAdd(parse(localFirst), remotes[0]!, "", "macos");
    expect(step.kind).toBe("refused");
    expect(commands()).toEqual(["validate"]);
  });

  test("keyless with no row for the new entry, a row whose keyOptional is not a boolean, or a failed validate: refused", async () => {
    const UNCHECKED = "Not added: paste the provider's API key: the engine did not say whether this provider needs one.";
    const cases: [string, Script, string][] = [
      ["no rows", { report: (r) => ({ ...r, providers: [] }) }, UNCHECKED],
      ["no row for the new entry", { report: (r) => ({ ...r, providers: (r["providers"] as Json[]).slice(0, 1) }) }, UNCHECKED],
      ["a keyOptional that is not a boolean", { report: (r) => ({ ...r, providers: (r["providers"] as Json[]).map((p) => ({ ...p, keyOptional: "true" })) }) }, UNCHECKED],
      ["a row with no keyOptional (an older engine)", { report: (r) => ({ ...r, providers: (r["providers"] as Json[]).map(({ keyOptional: _k, ...p }) => p) }) }, UNCHECKED],
      ["the check fails", { report: () => { throw { kind: "timeout", operation: "config-validate", seconds: 30 }; } }, "could not be checked"],
      ["the candidate is invalid", { report: (r) => ({ ...r, valid: false, errors: [{ field: "fallbacks[0].api.model", message: "bad model" }] }) }, "Not added:"],
    ];
    for (const [name, script, said] of cases) {
      calls = [];
      handler = engine(script);
      const step = await startAdd(parse(SAVED), LOCAL, "", "macos");
      expect({ name, kind: step.kind, commands: commands() }).toEqual({ name, kind: "refused", commands: ["validate"] });
      expect({ name, said: step.lines.join(" ").includes(said) }).toEqual({ name, said: true });
    }
  });

  test("keyless Anthropic at a loopback address: the engine's row says loopback but NOT keyOptional — refused, no key set, no Test", async () => {
    const loopbackAnthropic = { label: "Proxy", block: { api: { kind: "anthropic", model: "m", baseUrl: "http://127.0.0.1:8080" } } };
    // The engine's no-key rule is openai-compatible only: its row says so, and the app reads only that field.
    expect(rowsOf(cfgText({ ...parse(SAVED), fallbacks: [{ label: "Proxy", ...loopbackAnthropic.block }] }))[1]).toMatchObject({ loopback: true, keyOptional: false });
    const step = await startAdd(parse(SAVED), loopbackAnthropic, "", "macos");
    expect(step.kind).toBe("refused");
    expect(commands()).toEqual(["validate"]);
    // On this computer, so it is not told its address is elsewhere.
    expect(step.lines).toEqual(["Not added: paste the provider's API key (only an OpenAI-compatible model on this computer can be added without one)."]);
  });

  test("no key and NO address, before anything runs: OpenAI-compatible is asked for its address, Anthropic (its own endpoint) for its key", async () => {
    const ASK = "Not added: paste the provider's API key, or, for an OpenAI-compatible model on this computer, give the address it runs at (for example http://127.0.0.1:11434/v1).";
    const KEY_ONLY = "Not added: paste the provider's API key (only an OpenAI-compatible model on this computer can be added without one).";
    const cases: [{ label: string; block: Json }, string][] = [
      [{ label: "Local?", block: { api: { kind: "openai-compatible", model: "llama3" } } }, ASK],
      [{ label: "API", block: ANTHROPIC }, KEY_ONLY],
    ];
    for (const [req, line] of cases) {
      calls = [];
      const step = await startAdd(parse(SAVED), req, "  ", "macos");
      expect({ label: req.label, kind: step.kind, lines: step.lines }).toEqual({ label: req.label, kind: "refused", lines: [line] });
      expect(step.lines.join(" ")).not.toContain("not on this computer");
      expect(calls).toEqual([]);
    }
    // Through the form: an empty Address field is no `baseUrl` at all, for either kind.
    expect(addRequestFrom(parse(SAVED), { kind: "openai-compatible", label: "Local?", model: "llama3", baseUrl: "  ", configDir: "" })).toEqual(cases[0]![0]);
    expect(addRequestFrom(parse(SAVED), { kind: "anthropic", label: "API", model: "claude-sonnet-5", baseUrl: "", configDir: "" })).toEqual(cases[1]![0]);
  });

  test("the ROW decides, not the kind or the address: keyOptional: false refuses a local OpenAI-compatible entry; true admits any", async () => {
    const flip = (to: boolean): Script => ({ report: (r) => ({ ...r, providers: (r["providers"] as Json[]).map((p) => (p["index"] === 1 ? { ...p, keyOptional: to } : p)) }) });
    handler = engine(flip(false));
    const local = await startAdd(parse(SAVED), LOCAL, "", "macos");
    expect(local.kind).toBe("refused");
    expect(commands()).toEqual(["validate"]);
    calls = [];
    handler = engine(flip(true));
    const remoteAnthropic = { label: "Gateway", block: { api: { kind: "anthropic", model: "m", baseUrl: "https://gw.example" } } };
    const step = tested(await startAdd(parse(SAVED), remoteAnthropic, "", "macos"));
    expect(commands()).toEqual(["validate", "test"]);
    expect(step.pending).toMatchObject({ keyId: null, ref: null });
  });

  test("a key pasted for a loopback entry is stored exactly as before", async () => {
    const step = tested(await startAdd(parse(SAVED), LOCAL, KEY, "macos"));
    expect(commands()).toEqual(["validate", "engine_provider_key_set", "validate", "test"]);
    expect(calls[1]![1]).toEqual({ key: KEY });
    expect(step.pending).toMatchObject({ keyId: ID, index: 1, passed: true });
    expect(parse(step.pending.text)["fallbacks"]).toEqual([{ label: "Ollama", api: { ...LOCAL.block.api, apiKeyCommand: keyCommand(ID) } }]);
    calls = [];
    await discardAdd(step.pending, "macos");
    expect(deletes()).toEqual([ID]);
  });

  test("the Add form's busy line claims no key was stored (a keyless or login add stores none)", () => {
    const list = codeOf(readFileSync(new URL("../src/lib/ProvidersList.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    expect(list).toContain('{#if adding.busy} <p class="note">Adding and testing the new provider…</p> {/if}');
    expect(list).not.toContain("Storing the key and testing");
  });

  // User-directed 2026-10-22 (P-Add): the note sits next to the key for "Other OpenAI-compatible service" — the one
  // service whose address is typed; the named local services draw no key field (pin moved from `kind`).
  test("the Add form's note: next to the key, for Other OpenAI-compatible only, static text with no address logic", () => {
    const list = codeOf(readFileSync(new URL("../src/lib/ProvidersList.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    expect(list).toContain('<input type="password" autocomplete="off" spellcheck="false" bind:value={key} /> </label> {#if chosen.id === "other"} <p class="note">{ADD_LOCAL_KEY_NOTE}</p> {/if}');
    expect(list).toMatch(/import \{[^}]*\bADD_LOCAL_KEY_NOTE\b[^}]*\} from "\.\/settings-model";/);
    const model = codeOf(readFileSync(new URL("../src/lib/settings-model.ts", import.meta.url), "utf8"));
    expect(model).toContain('export const ADD_LOCAL_KEY_NOTE = "Leave the key empty for a model running on this computer (Ollama, LM Studio, a local vLLM): it needs none.";');
  });
});

/* ── 2. recorded: false ───────────────────────────────────────────────────────────────────────── */

describe("a Test answering recorded: false", () => {
  test("shows its result with the not-saved wording, and its outcome still decides Save vs Save anyway", async () => {
    for (const [notRecorded, passed] of [["lock-held", true], ["lock-held", false], ["write-failed", true], ["write-failed", false]] as const) {
      calls = [];
      handler = engine({ test: testAnswer({ passed, ...(passed ? {} : { reason: "auth" }), recorded: false, notRecorded }) });
      const step = tested(await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "macos"));
      expect(step.pending.passed).toBe(passed);
      expect(step.pending.ran).toBe(true);
      expect(step.lines[0]).toBe(passed ? "Test passed." : "Test failed: key or login rejected.");
      expect(step.lines.join("\n")).toContain(notRecordedLine(notRecorded));
    }
    expect(notRecordedLine("lock-held")).toBe("not saved — a briefing was running");
    expect(notRecordedLine("write-failed")).toBe("not saved — the status file could not be written");
  });
});

/* ── 4. https ─────────────────────────────────────────────────────────────────────────────────── */

describe("app-owned keys require https off this machine", () => {
  test("on paste: the engine refuses the candidate, the refusal is shown, the pasted key is removed, nothing is Tested", async () => {
    const block = { api: { kind: "openai-compatible", model: "m", baseUrl: "http://192.168.1.20:8080/v1" } };
    const step = await startAdd(parse(SAVED), { label: "LAN box", block }, KEY, "macos");
    expect(step.kind).toBe("refused");
    // Keyless, the entry is fine (no app key yet); with the stored reference the engine refuses it.
    expect(commands()).toEqual(["validate", "engine_provider_key_set", "validate", "engine_provider_key_delete"]);
    expect(deletes()).toEqual([ID]);
    expect(step.lines.join(" ")).toContain("switch this baseUrl to https");
    // The same endpoint over https, or plain http to this machine, is accepted.
    for (const baseUrl of ["https://192.168.1.20:8080/v1", "http://127.0.0.1:8080/v1", "http://localhost:11434/v1"]) {
      calls = [];
      const ok = await startAdd(parse(SAVED), { label: "LAN box", block: { api: { ...block.api, baseUrl } } }, KEY, "macos");
      expect({ baseUrl, kind: ok.kind }).toEqual({ baseUrl, kind: "tested" });
      expect(deletes()).toEqual([]);
    }
  });

  test("on every later save: an edit that moves a saved app key to plain http is refused by the engine's own rule", async () => {
    const step = tested(await startAdd(parse(SAVED), { label: "Gateway", block: { api: { kind: "anthropic", model: "m", baseUrl: "https://gw.example" } } }, KEY, "macos"));
    const saved = parse(step.pending.text);
    expect((engineCheck(rawFromDraft(saved))["report"] as Json)["valid"]).toBe(true);
    // A later form edit of the endpoint (the save path validates every save with the engine; errors block).
    ((saved["fallbacks"] as Json[])[0]!["api"] as Json)["baseUrl"] = "http://gw.example";
    const report = engineCheck(rawFromDraft(saved))["report"] as { valid: boolean; errors: { field: string; message: string }[] };
    expect(report.valid).toBe(false);
    expect(report.errors).toEqual([{ field: "fallbacks[0].api.baseUrl", message: expect.stringContaining("switch this baseUrl to https") }]);
    // And a Test of that edit after Discard → Test again is refused before anything is sent.
    calls = [];
    const again = await retestAdd(parse(SAVED), { ...step.pending, block: { api: { kind: "anthropic", model: "m", baseUrl: "http://gw.example" } } });
    expect(again.pending.ran).toBe(false);
    expect(again.lines.join(" ")).toContain("switch this baseUrl to https");
    expect(commands()).toEqual(["validate"]);
    // The refused candidate's text is kept with NO rows: the old rows were for the old text (checkpoint finding 7).
    expect(step.pending.rows.length).toBeGreaterThan(0);
    expect(again.pending.text).not.toBe(step.pending.text);
    expect(again.pending.rows).toEqual([]);
  });
});

/* ── 5. Remove ────────────────────────────────────────────────────────────────────────────────── */

describe("Remove: save without the entry, then key delete only on the last reference", () => {
  const entry = (label: string, id: string, extra: Json = {}): Json => ({ label, api: { kind: "anthropic", model: "m", apiKeyCommand: keyCommand(id), ...extra } });
  const removing = (saved: Json, label: string): string => {
    const c = structuredClone(saved);
    c["fallbacks"] = (c["fallbacks"] as Json[]).filter((f) => f["label"] !== label);
    if ((c["fallbacks"] as Json[]).length === 0) delete c["fallbacks"];
    return cfgText(c);
  };

  test("the removed entry's id comes from the SAVED config's rows; it is deleted once nothing left references it", async () => {
    const saved = { provider: CLAUDE, fallbacks: [entry("A", ID), entry("B", ID), entry("C", ID2)] };
    // Remove A: B still references the id.
    let after = removing(saved, "A");
    const planA = await keysOfRemoved(cfgText(saved), after, ["A"]);
    expect(planA.keys).toEqual([{ label: "A", keyId: ID }]);
    expect(commands()).toEqual(["validate"]);
    expect(sentTexts()).toEqual([cfgText(saved)]);
    calls = [];
    const linesA = await deleteUnreferencedKeys(after, planA.keys, "macos");
    expect(commands()).toEqual(["validate"]);
    expect(sentTexts()).toEqual([after]);
    expect(deletes()).toEqual([]);
    expect(linesA.join(" ")).toContain("another provider uses it");
    // Then remove B: the last reference.
    const saved2 = JSON.parse(after) as Json;
    after = removing(saved2, "B");
    calls = [];
    const planB = await keysOfRemoved(cfgText(saved2), after, ["B"]);
    const linesB = await deleteUnreferencedKeys(after, planB.keys, "macos");
    expect(deletes()).toEqual([ID]);
    expect(linesB.join(" ")).toContain("deleted");
    // C's key was never touched.
    expect(deletes()).not.toContain(ID2);
  });

  test("a key is kept while any remaining row may read ANY app key (appOwnedKey with no appKeyId), and it says so", async () => {
    // D's command names the service but no account: the engine reports it app-owned with no id.
    const anyKey = { label: "D", api: { kind: "anthropic", model: "m", apiKeyCommand: [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-w", KEYCHAIN] } };
    const saved = { provider: CLAUDE, fallbacks: [entry("A", ID), anyKey] };
    const rows = (engineCheck(cfgText(saved))["report"] as { providers: Json[] }).providers;
    expect(rows[2]).toMatchObject({ appOwnedKey: true });
    expect(rows[2]).not.toHaveProperty("appKeyId");
    const after = removing(saved, "A");
    const plan = await keysOfRemoved(cfgText(saved), after, ["A"]);
    expect(plan.keys).toEqual([{ label: "A", keyId: ID }]);
    const lines = await deleteUnreferencedKeys(after, plan.keys, "macos");
    expect(deletes()).toEqual([]);
    expect(lines.join(" ")).toContain("was kept");
    expect(lines.join(" ")).toContain("may read any key");
  });

  test("never a delete when the rows cannot vouch for every entry, nor for a removed entry with no named id", async () => {
    const saved = { provider: CLAUDE, fallbacks: [entry("A", ID), entry("B", ID2)] };
    const after = removing(saved, "A");
    const plan = await keysOfRemoved(cfgText(saved), after, ["A"]);
    // Validate of the saved list answers fewer rows than entries (e.g. a list the engine reads differently).
    handler = engine({ report: (r) => ({ ...r, providers: (r["providers"] as Json[]).slice(0, 1) }) });
    expect((await deleteUnreferencedKeys(after, plan.keys, "macos")).join(" ")).toContain("was kept");
    // The check itself failed.
    handler = () => {
      throw { kind: "timeout", operation: "config-validate", seconds: 30 };
    };
    expect((await deleteUnreferencedKeys(after, plan.keys, "macos")).join(" ")).toContain("was kept");
    expect(deletes()).toEqual([]);
    // A removed entry whose key the engine owns but cannot name: nothing to delete, said once.
    handler = engine();
    const anyKey = { label: "D", api: { kind: "anthropic", model: "m", apiKeyCommand: [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-w", KEYCHAIN] } };
    const s2 = { provider: CLAUDE, fallbacks: [anyKey] };
    const p2 = await keysOfRemoved(cfgText(s2), removing(s2, "D"), ["D"]);
    expect(p2.keys).toEqual([]);
    expect(p2.lines.join(" ")).toContain("was kept");
    // An entry that is still in the list (re-added, or the save sent it after all) is not removed at all.
    const p3 = await keysOfRemoved(cfgText(saved), cfgText(saved), ["A"]);
    expect(p3).toEqual({ keys: [], lines: [] });
    // An env-var key is no app key: nothing to delete, nothing said.
    const s4 = { provider: CLAUDE, fallbacks: [{ label: "E", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }] };
    expect(await keysOfRemoved(cfgText(s4), removing(s4, "E"), ["E"])).toEqual({ keys: [], lines: [] });
  });

  /* PR 3 final, the second post-cap fix (N5): a MALFORMED row for a removed entry (`malformedRow`, unused-key.ts — an
   * `appOwnedKey` present and not a boolean, or an `appKeyId` present and not a string) names no key id, whatever its
   * `appKeyId` holds, and gets the same "could not be told" kept line as an app-owned row with no id. */
  test("N5: a removed entry whose saved row is malformed contributes no key id, and is told its key was kept", async () => {
    const saved = { provider: CLAUDE, fallbacks: [entry("A", ID)] };
    const after = removing(saved, "A");
    const at1 = (over: Json) => (r: Json): Json => ({ ...r, providers: (r["providers"] as Json[]).map((p) => (p["index"] === 1 ? { ...p, ...over } : p)) });
    const cases: [string, Json][] = [
      ["appKeyId a number", { appOwnedKey: true, appKeyId: 7 }],
      ["appKeyId null", { appOwnedKey: true, appKeyId: null }],
      ["appKeyId an array", { appOwnedKey: true, appKeyId: [ID] }],
      ["appOwnedKey a string beside a string id", { appOwnedKey: "yes", appKeyId: ID }],
      ["appOwnedKey null beside a string id", { appOwnedKey: null, appKeyId: ID }],
      ["appOwnedKey a number, no id", { appOwnedKey: 1, appKeyId: undefined }],
    ];
    for (const [name, over] of cases) {
      handler = engine({ report: at1(over) });
      const plan = await keysOfRemoved(cfgText(saved), after, ["A"]);
      expect({ name, plan }).toEqual({ name, plan: { keys: [], lines: ['The stored key of "A" was kept: it could not be told which key it is.'] } });
    }
    // A well-formed row still names its id.
    handler = engine();
    expect(await keysOfRemoved(cfgText(saved), after, ["A"])).toEqual({ keys: [{ label: "A", keyId: ID }], lines: [] });
    expect(deletes()).toEqual([]);
  });

  /* PR 3 final r5 (H1): when the SAVED settings cannot be checked, the "was kept" line is said only of a removed entry
   * whose saved `api` block carries a key REFERENCE the app could own (`apiKeyCommand` or `apiKeyFile`) — a structural
   * presence read, never the engine's ownership rule. A command-line entry or one reading the user's own key: nothing. */
  test("a failed check of the saved settings: the kept line only for a removed entry that names a key command or file", async () => {
    // H's probe: item 1 a CLI, plus a codex fallback with a login folder — the engine drops it, so the saved settings
    // do not validate. Removing it says nothing about a stored key: it has none.
    const codexDir = { label: "B", cli: "codex", argv: ["exec"], promptVia: "stdin", configDir: "~/.codex-2" };
    const s1 = { provider: CLAUDE, fallbacks: [codexDir] };
    expect(((engineCheck(cfgText(s1))["report"] as Json)["valid"])).toBe(false);
    expect(await keysOfRemoved(cfgText(s1), removing(s1, "B"), ["B"])).toEqual({ keys: [], lines: [] });
    // The same failed check, for entries of every key shape removed at once.
    const own = { label: "Own", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } };
    const lit = { label: "Lit", api: { kind: "anthropic", model: "m", apiKey: "(placeholder)" } };
    const file = { label: "File", api: { kind: "anthropic", model: "m", apiKeyFile: `${KEYS}/${ID2}.key` } };
    const s2 = { provider: CLAUDE, fallbacks: [entry("Cmd", ID), own, lit, file, codexDir] };
    const after = cfgText({ provider: CLAUDE });
    const failing = (): void => {
      throw { kind: "timeout", operation: "config-validate", seconds: 30 };
    };
    for (const h of [engine({ report: failing }), engine()]) {
      handler = h;
      const plan = await keysOfRemoved(cfgText(s2), after, ["Cmd", "Own", "Lit", "File", "B"]);
      expect(plan.keys).toEqual([]);
      expect(plan.lines).toEqual([
        `The stored key of "Cmd" was kept: the saved settings could not be checked.`,
        `The stored key of "File" was kept: the saved settings could not be checked.`,
      ]);
    }
  });
});

/* ── 6. the key goes nowhere else ─────────────────────────────────────────────────────────────── */

describe("the pasted key never leaves providerKeySet", () => {
  test("not in a config text, an IPC argument, a log, a result, a thrown error or saved state — on every path", async () => {
    const results: unknown[] = [];
    const scripts: Script[] = [
      {},
      { test: testAnswer({ passed: false, reason: "auth", recorded: false, notRecorded: "lock-held" }) },
      { keySet: { schemaVersion: 1, ok: false, code: "write-failed", error: "key set: x", reason: "timeout", keyId: ID2 } },
      { report: (r, text) => (text.includes(SECURITY_BIN) ? { ...r, valid: false, errors: [{ field: "x", message: "refused" }] } : r) },
    ];
    for (const s of scripts) {
      handler = engine(s);
      const step = await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "macos");
      results.push(step);
      if (step.kind === "tested") {
        results.push(await retestAdd(parse(SAVED), step.pending));
        results.push(await discardAdd(step.pending, "macos"));
      }
    }
    // A key set that THROWS (the IPC rejects) is caught and worded, never rethrown carrying anything.
    handler = (c, a) => {
      if (c === "engine_provider_key_set") throw new Error("ipc failed");
      return engine()(c, a);
    };
    results.push(await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "macos"));
    expect(calls.filter(([c]) => c === "engine_provider_key_set").every(([, a]) => JSON.stringify(a) === JSON.stringify({ key: KEY }))).toBe(true);
    expect(calls.filter(([c]) => c === "engine_provider_key_set").length).toBeGreaterThan(0);
    const all = everywhereBut(...results);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(KEY.slice(4, -4));
    // The module keeps nothing: no state of its own holds it.
    expect(readFileSync(new URL("../src/lib/provider-flows.ts", import.meta.url), "utf8")).not.toMatch(/^(let|var) /m);
  });

  test("the add form clears the key input as it hands the key over (ProvidersList.svelte)", () => {
    const src = codeOf(readFileSync(new URL("../src/lib/ProvidersList.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    expect(src).toContain('type="password"');
    expect(src).toContain('autocomplete="off"');
    // PR 3 final r5 (A3): handed over first, cleared only once the parent took it. User-directed 2026-10-22 (P-Add):
    // a guided choice that takes no key (a subscription, another Claude account, a keyless local model) hands none.
    expect(src).toMatch(/if \(!onadd\(form, guidedTakesKey\(shownChoice, service\) \? key : ""\)\) return; key = ""; closeForm\(\);/);
  });
});

/* ── the network-check question (plan hub P3-M4-T1 Decided (1)) ───────────────────────────────── */

describe("the network-check question is decided from the candidate's own validate rows", () => {
  const REMOTE = { label: "Cloud", block: ANTHROPIC };
  const LOCAL = { label: "Local", block: { api: { kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:11434/v1" } } };

  test("an Add: a remote entry's candidate rows ask, a loopback entry's do not (the rows Settings passes)", async () => {
    const remote = tested(await startAdd(parse(SAVED), REMOTE, KEY, "macos"));
    expect(remote.pending.rows.map((r) => r.loopback)).toEqual([false, false]);
    expect(networkAskNeeded(SAVED, parse(remote.pending.text), false, remote.pending.rows)).toBe(true);
    const local = tested(await startAdd(parse(SAVED), LOCAL, KEY, "macos"));
    expect(local.pending.rows[1]).toMatchObject({ loopback: true });
    expect(networkAskNeeded(SAVED, parse(local.pending.text), false, local.pending.rows)).toBe(false);
    // Without the rows nothing would ever ask: the rows are what decides.
    expect(networkAskNeeded(SAVED, parse(remote.pending.text), false)).toBe(false);
  });

  test("a form save: networkAskFor validates THAT text and asks only for an added remote entry", async () => {
    const withEntry = (e: Json): string => cfgText({ ...parse(SAVED), fallbacks: [e] });
    const remoteText = withEntry({ label: "Cloud", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } });
    const localText = withEntry({ label: "Local", api: { kind: "openai-compatible", model: "m", baseUrl: "http://localhost:11434/v1" } });
    expect(await networkAskFor(SAVED, remoteText, false)).toBe(true);
    expect(sentTexts()).toEqual([remoteText]);
    expect(calls[0]![1]["mode"]).toBe("validate");
    expect(await networkAskFor(SAVED, localText, false)).toBe(false);
    // Already answered, the check on, or nothing added: no question, and no engine call for the first two.
    calls = [];
    expect(await networkAskFor(SAVED, remoteText, true)).toBe(false);
    expect(await networkAskFor(SAVED, cfgText({ ...parse(remoteText), networkProbeHosts: [{ host: "h", port: 1 }] }), false)).toBe(false);
    expect(calls).toEqual([]);
    expect(await networkAskFor(SAVED, SAVED, false)).toBe(false);
    // A check that cannot answer asks nothing.
    handler = () => {
      throw { kind: "timeout", operation: "config-validate", seconds: 30 };
    };
    expect(await networkAskFor(SAVED, remoteText, false)).toBe(false);
  });
});

/* ── the order of a save, an add's Save, and leaving the screen (checkpoint P3-M4-T2 findings 1-3, 5) ─────────────── */

describe("a save that removes entries: the saved rows before it, the save, then a delete only once it landed", () => {
  const entry = (label: string, id: string): Json => ({ label, api: { kind: "anthropic", model: "m", apiKeyCommand: keyCommand(id) } });
  const saved = cfgText({ provider: CLAUDE, fallbacks: [entry("A", ID), entry("B", ID2)] });
  const after = cfgText({ provider: CLAUDE, fallbacks: [entry("B", ID2)] });
  /** A fake `configSave` answering `kind`, recorded in `calls` where it ran. */
  const fakeSave = (kind: string) => async (): Promise<{ kind: string }> => {
    calls.push(["config_save", {}]);
    return { kind };
  };

  test("in order: the SAVED config's rows, the save, the NEW config's rows, the delete", async () => {
    const r = await saveRemovingKeys(saved, after, ["A"], "macos", fakeSave("saved"));
    expect(r.result).toEqual({ kind: "saved" });
    expect(await r.deletes).toEqual(['The stored key of "A" was deleted.']);
    expect(commands()).toEqual(["validate", "config_save", "validate", "engine_provider_key_delete"]);
    expect(sentTexts()).toEqual([saved, after]);
    expect(deletes()).toEqual([ID]);
    expect(r.lines).toEqual([]);
  });

  test("a save that did not land deletes nothing — refused, a conflict, unchanged, or thrown", async () => {
    for (const kind of ["invalid", "unchanged", "conflict"]) {
      calls = [];
      const r = await saveRemovingKeys(saved, after, ["A"], "macos", fakeSave(kind));
      expect({ kind, deletes: deletes(), lines: r.lines, later: await r.deletes }).toEqual({ kind, deletes: [], lines: [], later: [] });
      expect(commands()).toEqual(["validate", "config_save"]);
    }
    calls = [];
    const thrown = saveRemovingKeys(saved, after, ["A"], "macos", async () => {
      calls.push(["config_save", {}]);
      throw { kind: "conflict" };
    });
    await expect(thrown).rejects.toEqual({ kind: "conflict" });
    expect(deletes()).toEqual([]);
  });

  test("nothing removed: no check, just the save", async () => {
    const r = await saveRemovingKeys(saved, after, [], "macos", fakeSave("saved"));
    expect(await r.deletes).toEqual([]);
    expect(commands()).toEqual(["config_save"]);
    expect(r.lines).toEqual([]);
  });

  /* PR 3 final r3 (C1): the "could not be told" line reaches the caller through `saveRemovingKeys` itself — its
     `lines` — for both ways a removed entry's key cannot be named, and neither sends a delete. */
  const COULD_NOT_TELL = (label: string): string => `The stored key of "${label}" was kept: it could not be told which key it is.`;

  test("a removed entry that may read ANY app key: its kept line is the save's `lines`, and no delete is sent", async () => {
    const anyKey = { label: "D", api: { kind: "anthropic", model: "m", apiKeyCommand: [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-w", KEYCHAIN] } };
    const s = cfgText({ provider: CLAUDE, fallbacks: [anyKey, entry("B", ID2)] });
    const rows = (engineCheck(s)["report"] as { providers: Json[] }).providers;
    expect(rows[1]).toMatchObject({ appOwnedKey: true });
    expect(rows[1]).not.toHaveProperty("appKeyId");
    const r = await saveRemovingKeys(s, after, ["D"], "macos", fakeSave("saved"));
    expect(r.result).toEqual({ kind: "saved" });
    expect(r.lines).toEqual([COULD_NOT_TELL("D")]);
    expect(await r.deletes).toEqual([]);
    expect(deletes()).toEqual([]);
    expect(commands()).toEqual(["validate", "config_save"]);
  });

  test("the SAVED config's report has no row for the removed entry: the same line, no delete, no throw", async () => {
    // The engine did not resolve A (its row is missing); B's row is there.
    handler = engine({ report: (rep) => ({ ...rep, providers: (rep["providers"] as Json[]).filter((row) => row["appKeyId"] !== ID) }) });
    const r = await saveRemovingKeys(saved, after, ["A"], "macos", fakeSave("saved"));
    expect(r.result).toEqual({ kind: "saved" });
    expect(r.lines).toEqual([COULD_NOT_TELL("A")]);
    expect(await r.deletes).toEqual([]);
    expect(deletes()).toEqual([]);
    expect(commands()).toEqual(["validate", "config_save"]);
  });

  /* PR 3 final r2 (finding 1): a Save shows its outcome as soon as it lands; the key deletes — which may wait out a
     busy refusal for up to ~90 s — run AFTER it, and their lines arrive in `deletes`. */
  const STILL_WAITING = Symbol("still waiting");
  /** `p`'s value, or `STILL_WAITING` when it has not settled within a few event-loop turns. */
  const settledSoon = <T,>(p: Promise<T>): Promise<T | typeof STILL_WAITING> =>
    Promise.race([p, new Promise<typeof STILL_WAITING>((r) => setTimeout(() => r(STILL_WAITING), 50))]);
  /** A promise and the function that settles it. */
  const deferred = <T,>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  /** An injected clock: records each wait, runs `during` inside it, never waits. */
  const clockWith = (during: () => void = () => {}) => {
    const slept: number[] = [];
    return { slept, retry: { tries: 4, sleep: async (ms: number) => { slept.push(ms); during(); } } };
  };
  /** The engine, with the first `n` key deletes refused busy (a row's Test holds the in-flight guard). */
  const busyDeletes = (n: number, s: Parameters<typeof engine>[0] = {}): ((c: string, a: Json) => unknown) => {
    const base = engine(s);
    let refused = 0;
    return (c, a) => {
      if (c === "engine_provider_key_delete" && refused < n) {
        refused += 1;
        throw { kind: "busy", running: "provider-test" };
      }
      return base(c, a);
    };
  };

  test("the save's answer comes back as soon as it lands, while its key delete is still running", async () => {
    const del = deferred<unknown>();
    const base = engine({ saved: after });
    handler = (c, a) => (c === "engine_provider_key_delete" ? del.promise : base(c, a));
    const r = await settledSoon(saveRemovingKeys(saved, after, ["A"], "macos", fakeSave("saved")));
    if (r === STILL_WAITING) throw new Error("the save's answer waited for the key delete");
    expect(r.result).toEqual({ kind: "saved" });
    // The delete goes out after the save, and has not answered: its line is still to come.
    for (let i = 0; i < 100 && deletes().length === 0; i++) await new Promise((res) => setTimeout(res, 0));
    expect(commands()).toEqual(["validate", "config_save", "validate", "engine_provider_key_delete"]);
    expect(await settledSoon(r.deletes)).toBe(STILL_WAITING);
    del.resolve(outcome({ schemaVersion: 1, ok: true, deleted: true }, "provider-key-delete"));
    expect(await r.deletes).toEqual(['The stored key of "A" was deleted.']);
  });

  test("no key delete is sent before the save has landed", async () => {
    const save = deferred<{ kind: string }>();
    handler = engine({ saved: after });
    const running = saveRemovingKeys(saved, after, ["A"], "macos", () => {
      calls.push(["config_save", {}]);
      return save.promise;
    });
    expect(await settledSoon(running)).toBe(STILL_WAITING);
    expect(commands()).toEqual(["validate", "config_save"]);
    expect(deletes()).toEqual([]);
    save.resolve({ kind: "saved" });
    expect(await (await running).deletes).toEqual(['The stored key of "A" was deleted.']);
    expect(commands()).toEqual(["validate", "config_save", "validate", "engine_provider_key_delete"]);
  });

  test("a newer save that names the key, landing while its delete waits out a busy refusal, keeps the key", async () => {
    // A second Save after the reload (Save is free again once the outcome is shown) puts the key back in use.
    const NEWER = cfgText({ provider: CLAUDE, fallbacks: [entry("B", ID2), entry("A again", ID)] });
    let savedNow = after;
    handler = busyDeletes(1, { saved: () => savedNow });
    const c = clockWith(() => (savedNow = NEWER));
    const r = await saveRemovingKeys(saved, after, ["A"], "macos", fakeSave("saved"), c.retry);
    expect(await r.deletes).toEqual(['The stored key of "A" was kept: another provider uses it.']);
    expect(deletes()).toEqual([ID]); // the first, refused attempt only
    expect(c.slept).toEqual([unusedKey.KEY_DELETE_RETRY_MS]);
    // Control: a newer save that does not name it — the retry deletes it.
    calls = [];
    savedNow = after;
    handler = busyDeletes(1, { saved: () => savedNow });
    const c2 = clockWith(() => (savedNow = cfgText({ provider: CLAUDE, fallbacks: [entry("B", ID2), entry("C", ID2)] })));
    const r2 = await saveRemovingKeys(saved, after, ["A"], "macos", fakeSave("saved"), c2.retry);
    expect(await r2.deletes).toEqual(['The stored key of "A" was deleted.']);
    expect(deletes()).toEqual([ID, ID]);
  });

  test("the deletes run on without the caller: nothing awaits them (the screen was left), and the retry is still sent", async () => {
    handler = busyDeletes(1, { saved: after });
    const c = clockWith();
    const r = await saveRemovingKeys(saved, after, ["A"], "macos", fakeSave("saved"), c.retry);
    // The caller drops `r.deletes` (Settings' `onDestroy` has no hold on it). The retry still goes out.
    void r;
    for (let i = 0; i < 100 && deletes().length < 2; i++) await new Promise((res) => setTimeout(res, 0));
    expect(deletes()).toEqual([ID, ID]);
    expect(c.slept).toEqual([unusedKey.KEY_DELETE_RETRY_MS]);
  });
});

describe("an add's Save: field errors refuse, an edited draft tests again, otherwise the tested candidate is saved", () => {
  const pendingFor = async (): Promise<PendingAdd> => tested(await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "macos")).pending;
  const input = (pending: PendingAdd, over: Partial<Parameters<typeof addSaveDecision>[0]> = {}) => ({
    draft: parse(SAVED),
    testedOn: rawFromDraft(parse(SAVED)),
    errors: {},
    pending,
    askNetwork: false,
    networkYes: true,
    ...over,
  });

  test("unchanged draft, no errors: the tested candidate exactly", async () => {
    const p = await pendingFor();
    expect(addSaveDecision(input(p))).toEqual({ kind: "save", text: p.text, asked: false });
  });

  test("the draft changed after the Test: test again, never save the stale candidate", async () => {
    const p = await pendingFor();
    const edited = parse(SAVED);
    edited["morningTime"] = "06:30";
    expect(addSaveDecision(input(p, { draft: edited }))).toEqual({ kind: "retest" });
    // A reformatted but equal draft is the same draft: `testedOn` is `rawFromDraft`'s spelling.
    expect(addSaveDecision(input(p, { draft: JSON.parse(rawFromDraft(parse(SAVED))) as Draft }))).toEqual({ kind: "save", text: p.text, asked: false });
  });

  test("a live field error refuses with the form's own wording — before any retest", async () => {
    const p = await pendingFor();
    const draft = parse(cfgText({ ...parse(SAVED), morningTime: "07:00" }));
    const errors = { morningTime: "Use HH:MM." };
    // Non-vacuous: the form's own Save is blocked for exactly this draft and these errors.
    expect(Object.keys(liveErrors(draft, errors))).toEqual(["morningTime"]);
    const form = formSubmission(draft, null, errors);
    expect(form.kind).toBe("blocked");
    const message = form.kind === "blocked" ? form.message : "";
    expect(message).toBe("Not saved: fix the marked fields first.");
    expect(addSaveDecision(input(p, { draft, testedOn: rawFromDraft(draft), errors }))).toEqual({ kind: "refuse", message });
    // …and also when the draft changed meanwhile: the refusal comes first.
    expect(addSaveDecision(input(p, { draft, errors }))).toEqual({ kind: "refuse", message });
    // An error on a field no longer live (cleared, hidden) does not block.
    expect(addSaveDecision(input(p, { errors: { morningTime: "" } }))).toEqual({ kind: "save", text: p.text, asked: false });
  });

  test("the network question on screen: its answer is applied to the saved text, and the save says it asked", async () => {
    const p = await pendingFor();
    const yes = addSaveDecision(input(p, { askNetwork: true, networkYes: true }));
    expect(yes.kind).toBe("save");
    const yesText = yes.kind === "save" ? yes.text : "";
    expect(parse(yesText)).not.toHaveProperty("networkProbeHosts");
    expect(yes).toMatchObject({ asked: true });
    const no = addSaveDecision(input(p, { askNetwork: true, networkYes: false }));
    expect(no.kind === "save" ? parse(no.text)["networkProbeHosts"] : null).toEqual([]);
    expect(no).toMatchObject({ asked: true });
    // The candidate itself is unchanged by the decision.
    expect(parse(p.text)["networkProbeHosts"]).toEqual([]);
  });
});

describe("leaving the screen while an add is in progress: its key is removed, unless a running step owns it", () => {
  const p = { keyId: ID } as unknown as PendingAdd;

  test("the decision on leaving, for every step that can be running", () => {
    const table: [AddRunning, PendingAdd | null, PendingAdd | null][] = [
      ["none", p, p], // waiting for Save / Discard: removed now
      ["none", null, null], // nothing waiting
      ["test", p, null], // a Test again holds the engine (a delete now is refused busy): removed when it ends
      ["start", null, null], // `key set` may have answered: the running add decides when it ends
      ["save", p, null], // the save may land: the save decides when it ends
      ["discard", p, null], // already being removed
    ];
    for (const [running, pending, discard] of table) expect({ running, pending, got: leaveAdd(running, pending) }).toEqual({ running, pending, got: discard });
  });

  test("the running step, ended after the screen was left: a key nobody can Discard any more is removed — unless the save landed", () => {
    const refusedStep: AddStep = { kind: "refused", lines: ["x"] };
    const testedStep: AddStep = { kind: "tested", pending: p, lines: [] };
    // Still on the screen: the user decides, nothing is removed.
    expect(orphanAfter(false, { step: testedStep })).toBeNull();
    expect(orphanAfter(false, { pending: p, landed: false })).toBeNull();
    // Left during the add's start: a tested add is removed; a refused one stored nothing that is left.
    expect(orphanAfter(true, { step: testedStep })).toBe(p);
    expect(orphanAfter(true, { step: refusedStep })).toBeNull();
    // Left during the add's Save: kept if it landed (the saved settings use it), removed if not.
    expect(orphanAfter(true, { pending: p, landed: true })).toBeNull();
    expect(orphanAfter(true, { pending: p, landed: false })).toBe(p);
  });

  test("and the removal itself still re-checks the saved settings: a save that landed keeps its key whatever the caller decided", async () => {
    const step = tested(await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "macos"));
    calls = [];
    handler = engine({ saved: step.pending.text });
    await discardAdd(step.pending, "macos");
    expect(deletes()).toEqual([]);
  });
});

/* ── wiring ───────────────────────────────────────────────────────────────────────────────────── */

describe("Settings.svelte wires Add and Remove to these flows", () => {
  const raw = codeOf(readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8"));
  const settings = raw.replace(/\s+/g, " ");
  /** The body of `async function <name>` up to the next top-level function. */
  const fn = (name: string): string => {
    const head = `async function ${name}(`;
    const at = settings.indexOf(head);
    expect(at).toBeGreaterThan(0);
    const next = settings.slice(at + head.length).search(/ (async )?function \w+\(/);
    return next < 0 ? settings.slice(at) : settings.slice(at, at + head.length + next);
  };
  test("both network questions pass the candidate's rows: the form save's through networkAskFor, the add's its own", () => {
    expect(settings).toContain("await networkAskFor(doc.text, decision.text, networkAsked())");
    expect(settings).toContain("networkAskNeeded(doc?.text ?? null, parseDraft(adding.pending.text), networkAsked(), adding.pending.rows)");
    // No call of networkAskNeeded without rows is left.
    expect(settings.split("networkAskNeeded(").length - 1).toBe(1);
    // The question on screen is for the exact text being saved; the next Save of that text applies the answer.
    expect(settings).toContain("if (askNetworkFor === decision.text) {");
  });
  test("Add saves through the one save path, by the add-save decision; Discard changes discards a pending add", () => {
    expect(settings).toContain("await startAdd(");
    const save = fn("onprovideraddsave");
    expect(save).toContain("const next = addSaveDecision({");
    expect(save).toContain("errors: $state.snapshot(errors)");
    expect(save).toContain("testedOn: addBase");
    expect(save).toContain('if (next.kind === "retest") { await onprovideraddretest(); return; }');
    expect(save).toContain("await submit(next.text, next.asked)");
    expect(save.indexOf("addSaveDecision(")).toBeLessThan(save.indexOf("await submit("));
    expect(settings).toContain("await discardAdd(");
  });
  test("submit saves through saveRemovingKeys: configSave only inside it, no delete of its own", () => {
    const submit = fn("submit");
    expect(submit).toContain("await saveRemovingKeys(doc.text, text, removedLabels, os, async () => {");
    expect(submit.indexOf("const gate = await gateCheck(text);")).toBeLessThan(submit.indexOf("await saveRemovingKeys("));
    expect(settings.split("configSave(").length - 1).toBe(1);
    expect(submit.indexOf("configSave(")).toBeGreaterThan(submit.indexOf("await saveRemovingKeys("));
    for (const own of ["keysOfRemoved", "deleteUnreferencedKeys", "providerKeyDelete"]) expect([own, settings.includes(own)]).toEqual([own, false]);
    // PR 3 final r2 (finding 1): the outcome, the lines known at once and the reload come FIRST; the key deletes (a
    // busy one retried for up to ~90 s) are never awaited here — their lines are added when they arrive.
    expect(submit).toContain("outcome = result; if (result.kind === \"saved\") { void onconfigsaved(); judgeLine = judge; keyLines = steps.lines; removedLabels = []; if (askedNetwork) markNetworkAsked(); void steps.deletes.then((lines) => (keyLines = [...keyLines, ...lines])); await load(true, { sent, from, at });");
    expect(submit).not.toContain("await steps.deletes");
    expect(submit.split("steps.deletes").length - 1).toBe(1);
  });
  test("leaving the screen: onDestroy removes only what leaveAdd hands it; the running start and save decide by orphanAfter", () => {
    const destroy = settings.slice(settings.indexOf("onDestroy(() => {"), settings.indexOf("keepSettings({", settings.indexOf("onDestroy(() => {")));
    expect(destroy).toContain("left = true;");
    expect(destroy).toContain("const orphan = leaveAdd(addSteps.running, adding?.pending ?? null);");
    expect(destroy).toContain("if (orphan !== null) void discardAdd(orphan, os);");
    expect(destroy.split("discardAdd(").length - 1).toBe(1);
    // The steps say what is running, and hand their key back when the screen is gone.
    // ... and a step ending after "Discard changes" ended its add (FlowSteps) is handled as if the screen were left,
    // and puts nothing back (P3-M4-T3 checkpoint).
    const add = fn("runProviderAdd");
    expect(add).toMatch(/const ticket = addSteps\.start\("start"\); const step = await startAdd\(/);
    expect(add).toContain("const current = addSteps.ended(ticket); const orphan = orphanAfter(left || !current, { step });");
    expect(add).toContain("if (orphan !== null) { void discardAdd(orphan, os); return; } if (!current) return; adding = {");
    const save = fn("onprovideraddsave");
    expect(save).toMatch(/const ticket = addSteps\.start\("save"\); const landed = await submit\(next\.text, next\.asked\);/);
    expect(save).toContain("const current = addSteps.ended(ticket); const orphan = orphanAfter(left || !current, { pending: p, landed });");
    expect(save).toContain("if (orphan !== null) { void discardAdd(orphan, os); return; } if (!current) return; if (landed)");
    // P3-M4-T4 (the carried LOW): a Test again decides when it ENDS — left, or ended by "Discard changes" — like the
    // start and the Save, because the running Test holds the engine and a delete beside it would be refused busy.
    expect(fn("onprovideraddretest")).toMatch(
      /const ticket = addSteps\.start\("test"\); const r = await retestAdd\(base, p\); const current = addSteps\.ended\(ticket\); const orphan = orphanAfter\(left \|\| !current, \{ pending: r\.pending, landed: false \}\); if \(orphan !== null\) \{ void discardAdd\(orphan, os\); return; \} addBase =/,
    );
    // A Discard that ends after "Discard changes" ended its add (a busy delete retried) puts nothing back: a newer add
    // on screen by then stays (PR 3 final r2).
    expect(fn("onprovideradddiscard")).toMatch(
      /if \(p == null \|\| adding\?\.busy\) return; adding = \{ busy: true, lines: \[\], pending: p \}; addSteps\.discard\(\); const ticket = addSteps\.start\("discard"\); keyLines = await discardAdd\(p, os\); if \(addSteps\.ended\(ticket\)\) adding = null; \}/,
    );
    // PR 3 final r2 (finding 1): "Discard changes" removes a waiting add's key (`leaveAdd` decides which, as leaving
    // the screen does) WITHOUT awaiting it before the reload — a busy delete is retried for up to ~90 s — and adds its
    // lines after the reload, which would otherwise clear them.
    const dc = fn("discardChanges");
    expect(dc).toMatch(
      /const orphan = leaveAdd\(addSteps\.running, adding\?\.pending \?\? null\); const discarded = orphan === null \? null : discardAdd\(orphan, os\); addSteps\.discard\(\); adding = null;/,
    );
    expect(dc).toContain("await load(false); if (replaced.length > 0) keyLines = [...keyLines, ...replaced]; if (discarded !== null) void discarded.then((lines) => (keyLines = [...keyLines, ...lines]));");
    for (const waits of ["await onprovideradddiscard(", "await discarded", "await discardAdd("]) expect([waits, dc.includes(waits)]).toEqual([waits, false]);
    // One FlowSteps per flow, and no other writer of `running`.
    expect(settings).toContain("const addSteps = new FlowSteps<Exclude<AddRunning, \"none\">>();");
    expect(settings).not.toMatch(/\.running = /);
  });
  test("submit answers whether the save landed", () => {
    expect(fn("submit")).toContain("async function submit(text: string, askedNetwork = false, from: Edit = editNow(), at: number = gesture): Promise<boolean> {");
    expect(fn("submit")).toContain('return answered === "saved";');
  });
  test("the form's Save holds `saving` through the network check too, so a second Save cannot start meanwhile", () => {
    const form = fn("saveForm");
    expect(form).toContain("if (draft === null || doc === null || saving) return; saving = true;");
    expect(form.indexOf("saving = true;")).toBeLessThan(form.indexOf("await networkAskFor("));
    expect(form).toMatch(/\} finally \{ saving = false; \}/);
    expect(form.indexOf("finally { saving = false; }")).toBeLessThan(form.indexOf("await submit("));
  });
  test("the add form's login option is loginSource's", () => {
    expect(settings).toContain("loginOf: login === null ? null : stripControl(login.label),");
    expect(settings).toContain("const login = $derived(draft === null ? null : loginSource(draft));");
  });
});

describe("ProvidersList.svelte: the key input never outlives the form", () => {
  const src = codeOf(readFileSync(new URL("../src/lib/ProvidersList.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
  test("closing the form (Cancel, or after Add) clears the key; the login option is the parent's", () => {
    expect(src).toMatch(/function closeForm\(\): void \{ formOpen = false; key = "";/);
    expect(src).toMatch(/if \(!onadd\(form, guidedTakesKey\(shownChoice, service\) \? key : ""\)\) return; key = ""; closeForm\(\);/);
    expect(src).toContain('<button type="button" onclick={closeForm}>Cancel</button>');
    // No login option derived from the rows (they cannot tell a Claude tool from a codex one).
    expect(src).not.toContain("r.isCli");
    expect(src).toContain("loginOf = null,");
  });

  /* PR 3 final r5 (A3): a submit the parent refuses (`addRequestFrom`: no name, no model, no login folder) used to
   * clear the pasted key and the whole form first, so the paste was lost. The parent decides AT ONCE (before any await)
   * and answers whether it took the add; the form clears nothing on a refusal. */
  test("a refused submit keeps the form and the pasted key: the parent answers synchronously, the form clears only on a take", () => {
    // The model: each of these is refused before anything runs, so the parent answers `false` without an await.
    const draft = parse(SAVED);
    const form = { kind: "anthropic" as const, label: "API", model: "m", baseUrl: "", configDir: "" };
    for (const over of [{ label: "  " }, { model: " " }, { kind: "login" as const, configDir: " " }]) {
      expect({ over, error: "error" in addRequestFrom(draft, { ...form, ...over }) }).toEqual({ over, error: true });
    }
    expect("error" in addRequestFrom(draft, form)).toBe(false);
    // The form: nothing is cleared before the parent's answer, and nothing at all on `false`.
    const submit = src.slice(src.indexOf("function submitAdd("), src.indexOf("</script>"));
    expect(submit).toMatch(
      /^function submitAdd\(\): void \{ if \(onadd === undefined \|\| busy\) return; const form: AddForm = guidedForm\(shownChoice, \{ label, tool, command, args, service, model, address: baseUrl, configDir \}\); if \(!onadd\(form, guidedTakesKey\(shownChoice, service\) \? key : ""\)\) return; key = ""; closeForm\(\); \}/,
    );
    // The parent: its answer is the request check's, given before any await; the add itself runs after it.
    const settings = codeOf(readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    const take = settings.slice(settings.indexOf("function onprovideradd("), settings.indexOf("async function runProviderAdd("));
    expect(take).toMatch(
      /^function onprovideradd\(form: AddForm, key: string\): boolean \{ if \(draft === null \|\| adding !== null \|\| replacing !== null\) return false; const base = \$state\.snapshot\(draft\) as Draft; const req = addRequestFrom\(base, form\); if \("error" in req\) \{ adding = \{ busy: false, lines: \[req\.error\], pending: null \}; return false; \}/,
    );
    expect(take).not.toContain("await");
    expect(take).toContain("void runProviderAdd(base, req, form.kind === \"login\" || form.kind === \"cli\" ? null : key); return true; }");
    expect(settings).toContain("onadd: (form, key) => onprovideradd(form, key),");
    const flowsSrc = codeOf(readFileSync(new URL("../src/lib/provider-flows.ts", import.meta.url), "utf8"));
    expect(flowsSrc).toContain("onadd: (form: AddForm, key: string) => boolean;");
  });
});

/* ── 7. Replace (P3-M4-T3) ────────────────────────────────────────────────────────────────────── */

const OLD_ID = "k-00000000000a";
const SAVED_WORK = cfgText({
  provider: CLAUDE,
  fallbacks: [{ label: "Work", api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyEnv: "STALE", apiKeyCommand: keyCommand(OLD_ID) } }],
  networkProbeHosts: [],
});
const pendingOf = (calls_: Call[], name: string): Json[] => calls_.filter(([c]) => c === name).map(([, a]) => a);

function replaced(step: ReplaceStep): { pending: PendingReplace; lines: string[] } {
  if (step.kind !== "tested") throw new Error(`expected a tested step, got ${JSON.stringify(step)}`);
  return step;
}

/** A screen for `saveReplace`: records every save, sleep and waiting change; cancelled / current as set. */
function screen(over: Partial<ReplaceSaveDeps> = {}) {
  const log: string[] = [];
  const saved: string[] = [];
  const deps: ReplaceSaveDeps = {
    save: async (text) => {
      log.push("save");
      saved.push(text);
      return true;
    },
    sleep: async (ms) => {
      log.push(`sleep ${ms}`);
    },
    cancelled: () => false,
    current: () => true,
    saving: () => false,
    waiting: (on) => log.push(`waiting ${on}`),
    ...over,
  };
  return { deps, log, saved };
}

describe("Replace: key set → Test → the pre-save reset → the save → the post-save reset", () => {
  test("Replace key is offered on a saved API row only, and never while something else is in progress", () => {
    expect(replaceOffered({ isCli: false, savedIndex: 1 }, false)).toBe(true);
    expect(replaceOffered({ isCli: true, savedIndex: 0 }, false)).toBe(false);
    expect(replaceOffered({ isCli: false, savedIndex: null }, false)).toBe(false);
    expect(replaceOffered({ isCli: false, savedIndex: 1 }, true)).toBe(false);
  });

  test("start: checked keyless, the saved row's id noted, the NEW key stored, the entry switched to it and tested", async () => {
    const step = replaced(await startReplace(parse(SAVED_WORK), SAVED_WORK, "Work", KEY, "macos"));
    expect(commands()).toEqual(["validate", "validate", "engine_provider_key_set", "validate", "test"]);
    expect(calls[2]![1]).toEqual({ key: KEY });
    expect(sentTexts()[1]).toBe(SAVED_WORK);
    expect(step.pending).toMatchObject({ label: "Work", keyId: ID, index: 1, passed: true, ran: true, previousKeyId: OLD_ID });
    // The entry now names only the new reference — its other sources (an env key here) are gone.
    expect((parse(step.pending.text)["fallbacks"] as Json[])[0]).toEqual({ label: "Work", api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyCommand: keyCommand(ID) } });
    expect(calls[4]![1]["mode"]).toEqual({ test: { index: 1, testTimeoutMs: boundOf(1) } });
    // Nothing is recorded or saved yet, and no key is deleted.
    expect(commands().filter((c) => c.startsWith("provider_pending_reset"))).toEqual([]);
    expect(deletes()).toEqual([]);
  });

  test("start refuses before any key is stored: an unsaved row, a command-line row, an empty key", async () => {
    const draftWithNew = parse(SAVED_WORK);
    (draftWithNew["fallbacks"] as Json[]).push({ label: "Fresh", api: { kind: "anthropic", model: "m" } });
    for (const [label, key, why] of [
      ["Fresh", KEY, "save"],
      ["default", KEY, "command-line"],
      ["Work", "  ", "paste"],
    ] as const) {
      calls = [];
      const step = await startReplace(draftWithNew, SAVED_WORK, label, key, "macos");
      expect(step.kind).toBe("refused");
      expect(step.lines.join(" ")).toContain(why);
      expect(commands()).not.toContain("engine_provider_key_set");
    }
  });

  test("a key the replacement stored and will not use goes to the store's drop — never a direct key delete", async () => {
    // A key set refusal whose cleanup is unconfirmed names its keyId (gui-seam §1d; hub P2-M2 "Into P3" (3)).
    handler = engine({ keySet: { schemaVersion: 1, ok: false, code: "write-failed", reason: "timeout", cleanup: "timeout", keyId: ID2, error: "key set: x" } });
    let step = await startReplace(parse(SAVED_WORK), SAVED_WORK, "Work", KEY, "macos");
    expect(step.kind).toBe("refused");
    expect(step.lines[0]).toStartWith("Not replaced:");
    expect(pendingOf(calls, "provider_pending_reset_drop")).toEqual([{ label: "Work", newKeyId: ID2 }]);
    // The engine refuses the candidate after the key was stored: the new id is dropped too.
    calls = [];
    handler = engine({ report: (r, text) => (text.includes(ID) ? { ...r, valid: false, errors: [{ field: "x", message: "no" }] } : r) });
    step = await startReplace(parse(SAVED_WORK), SAVED_WORK, "Work", KEY, "macos");
    expect(step.kind).toBe("refused");
    expect(pendingOf(calls, "provider_pending_reset_drop")).toEqual([{ label: "Work", newKeyId: ID }]);
    expect(deletes()).toEqual([]);
  });

  test("Test again rebuilds on the current draft with the same stored key", async () => {
    const step = replaced(await startReplace(parse(SAVED_WORK), SAVED_WORK, "Work", KEY, "macos"));
    calls = [];
    const again = await retestReplace(parse(SAVED_WORK), step.pending);
    expect(commands()).toEqual(["validate", "test"]);
    expect(again.pending.text).toBe(step.pending.text);
    expect(again.pending.keyId).toBe(ID);
  });

  test("Save: the pre-save reset, the save of exactly the tested candidate, the post-save reset — in that order", async () => {
    const step = replaced(await startReplace(parse(SAVED_WORK), SAVED_WORK, "Work", KEY, "macos"));
    calls = [];
    const s = screen();
    const out = await saveReplace(step.pending, step.pending.text, s.deps);
    expect(out.kind).toBe("landed");
    expect(commands()).toEqual(["provider_pending_reset_add", "provider_pending_reset_flush"]);
    expect(pendingOf(calls, "provider_pending_reset_add")).toEqual([{ label: "Work", newKeyId: ID }]);
    expect(pendingOf(calls, "provider_pending_reset_flush")).toEqual([{ label: "Work", newKeyId: ID }]);
    expect(s.saved).toEqual([step.pending.text]);
    expect(s.log).toEqual(["waiting false", "save"]);
    expect((out as { lines: string[] }).lines[0]).toStartWith("Replaced:");
    expect((out as { lines: string[] }).lines.join(" ")).toContain("previous key stays stored");
  });

  test("a briefing holding the run lock: the row waits, add is tried again every 15 s, and the save resumes after it", async () => {
    let tries = 0;
    handler = engine({ add: () => (++tries < 3 ? { kind: "retry" } : { kind: "reset" }) });
    const step = replaced(await startReplace(parse(SAVED_WORK), SAVED_WORK, "Work", KEY, "macos"));
    const s = screen();
    const out = await saveReplace(step.pending, step.pending.text, s.deps);
    expect(REPLACE_RETRY_MS).toBe(15_000);
    expect(s.log).toEqual(["waiting true", `sleep ${REPLACE_RETRY_MS}`, "waiting true", `sleep ${REPLACE_RETRY_MS}`, "waiting false", "save"]);
    expect(tries).toBe(3);
    expect(out.kind).toBe("landed");
    // While it waits, the row says so (the line P3-M4-T1 defined, set by the label of the waiting replacement).
    const view = providersView({ draft: parse(SAVED_WORK), savedText: SAVED_WORK, rows: null, now: new Date(0), pending: replacePendingNotes("Work", true) });
    if (!view.readable) throw new Error("unreadable");
    expect(view.rows.find((r) => r.label === "Work")!.notes).toContain(REPLACE_WAITING_LINE);
    expect(replacePendingNotes("Work", false)).toEqual({});
    expect(replacePendingNotes(null, true)).toEqual({});
  });

  test("cancelled while waiting: nothing is saved or flushed; changed meanwhile: not saved, tested again first", async () => {
    handler = engine({ add: () => ({ kind: "retry" }) });
    const step = replaced(await startReplace(parse(SAVED_WORK), SAVED_WORK, "Work", KEY, "macos"));
    let cancel = false;
    const s = screen({ cancelled: () => cancel, sleep: async () => void (cancel = true) });
    expect(await saveReplace(step.pending, step.pending.text, s.deps)).toEqual({ kind: "cancelled" });
    expect(s.saved).toEqual([]);
    expect(s.log.at(-1)).toBe("waiting false");
    calls = [];
    handler = engine();
    const changed = screen({ current: () => false });
    const out = await saveReplace(step.pending, step.pending.text, changed.deps);
    expect(out.kind).toBe("notSaved");
    expect(changed.saved).toEqual([]);
    expect(commands()).toEqual(["provider_pending_reset_add"]);
  });

  /* PR 3 final r5 (H2): the form's own Save started while the replacement waited on a running briefing. When the wait
   * ends, the save path would refuse at once (`submit`: a save is already running) and set no failure, so "see why
   * below" pointed at nothing. That case now says why itself, and sends no save. */
  test("a wait that ends while the form's Save runs: not saved, saying why, with no save sent", async () => {
    let tries = 0;
    handler = engine({ add: () => (++tries === 1 ? { kind: "retry" } : { kind: "reset" }) });
    const step = replaced(await startReplace(parse(SAVED_WORK), SAVED_WORK, "Work", KEY, "macos"));
    calls = [];
    let formSaving = false;
    const s = screen({ saving: () => formSaving, sleep: async () => void (formSaving = true) });
    const out = await saveReplace(step.pending, step.pending.text, s.deps);
    expect(out).toEqual({ kind: "notSaved", lines: [flows.REPLACE_FORM_SAVING_LINE] });
    expect(flows.REPLACE_FORM_SAVING_LINE).not.toContain("see why below");
    expect(s.saved).toEqual([]);
    expect(commands()).toEqual(["provider_pending_reset_add", "provider_pending_reset_add"]);
    // Non-vacuous: the same wait with the form idle saves.
    calls = [];
    tries = 0;
    const idle = screen();
    expect((await saveReplace(step.pending, step.pending.text, idle.deps)).kind).toBe("landed");
    expect(idle.saved).toEqual([step.pending.text]);
  });

  test("cancelled while `add` ran: a retry answer does not wait 15 s first, and a reset answer saves nothing", async () => {
    let cancel = false;
    handler = engine({
      add: () => {
        cancel = true;
        return { kind: "retry" };
      },
    });
    const step = replaced(await startReplace(parse(SAVED_WORK), SAVED_WORK, "Work", KEY, "macos"));
    calls = [];
    const waited = screen({ cancelled: () => cancel });
    expect(await saveReplace(step.pending, step.pending.text, waited.deps)).toEqual({ kind: "cancelled" });
    expect(waited.log).toEqual(["waiting false"]);
    expect(commands()).toEqual(["provider_pending_reset_add"]);
    // The pre-save reset succeeded, but the Discard came while it ran: no save, no post-save reset (drop decides).
    cancel = false;
    handler = engine({
      add: () => {
        cancel = true;
        return { kind: "reset" };
      },
    });
    calls = [];
    const reset = screen({ cancelled: () => cancel });
    expect(await saveReplace(step.pending, step.pending.text, reset.deps)).toEqual({ kind: "cancelled" });
    expect(reset.saved).toEqual([]);
    expect(reset.log).toEqual(["waiting false"]);
    expect(commands()).toEqual(["provider_pending_reset_add"]);
  });

  test("a refused pre-save reset ends the replacement through drop; a save that does not land keeps it pending", async () => {
    handler = engine({ add: () => ({ kind: "refused", code: "config", reason: null, detail: "reset: x" }) });
    const step = replaced(await startReplace(parse(SAVED_WORK), SAVED_WORK, "Work", KEY, "macos"));
    calls = [];
    const s = screen();
    const out = await saveReplace(step.pending, step.pending.text, s.deps);
    expect(out.kind).toBe("ended");
    expect(s.saved).toEqual([]);
    expect(commands()).toEqual(["provider_pending_reset_add", "provider_pending_reset_drop"]);
    calls = [];
    handler = engine();
    const failing = screen({ save: async () => false });
    expect((await saveReplace(step.pending, step.pending.text, failing.deps)).kind).toBe("notSaved");
    expect(commands()).toEqual(["provider_pending_reset_add"]);
  });

  test("the post-save reset waiting on a run, or refused, is said — the save has landed either way", async () => {
    const step = replaced(await startReplace(parse(SAVED_WORK), SAVED_WORK, "Work", KEY, "macos"));
    for (const [answer, words] of [
      [{ kind: "retry" }, "briefing is running"],
      [{ kind: "refused", code: "config", reason: null, detail: "reset: x" }, "Use Reset"],
    ] as const) {
      handler = engine({ flush: () => answer });
      const out = await saveReplace(step.pending, step.pending.text, screen().deps);
      expect(out.kind).toBe("landed");
      expect((out as { lines: string[] }).lines[0]).toContain(words);
    }
  });

  test("Discard awaits the replacement's own save before drop (hub Q21), and drop's answer is worded", async () => {
    const step = replaced(await startReplace(parse(SAVED_WORK), SAVED_WORK, "Work", KEY, "macos"));
    calls = [];
    let settle!: () => void;
    const inFlight = new Promise<void>((r) => (settle = r));
    const discarding = discardReplace(step.pending, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    expect(commands()).toEqual([]);
    settle();
    expect(await discarding).toEqual(["Discarded: the key you pasted was removed."]);
    expect(pendingOf(calls, "provider_pending_reset_drop")).toEqual([{ label: "Work", newKeyId: ID }]);
    // A save that failed still settles the wait; drop decides from the saved settings.
    calls = [];
    await discardReplace(step.pending, Promise.reject(new Error("x")));
    expect(commands()).toEqual(["provider_pending_reset_drop"]);
    expect(dropLine({ kind: "promoted" })).toContain("already use the new key");
    expect(dropLine({ kind: "kept", why: "otherLabel" })).toContain("kept");
    expect(dropLine({ kind: "kept", why: "unverified" })).toContain("kept");
    expect(dropLine({ kind: "deletePending" })).toContain("removed as soon as");
    expect(dropLine({ kind: "deleteFailed", detail: "d" })).toContain("could not be removed (d)");
  });

  test("Discard is offered while a replacement waits on a run, and not while another of its steps runs", () => {
    const pending = { passed: true, ran: true };
    expect(replaceDiscardable({ label: "Work", busy: false, waiting: false, saving: false, lines: [], pending })).toBe(true);
    expect(replaceDiscardable({ label: "Work", busy: true, waiting: true, saving: false, lines: [], pending })).toBe(true);
    expect(replaceDiscardable({ label: "Work", busy: true, waiting: false, saving: false, lines: [], pending })).toBe(false);
    expect(replaceDiscardable({ label: "Work", busy: false, waiting: false, saving: false, lines: [], pending: null })).toBe(false);
  });

  test("leaving the screen: a waiting replacement is discarded now; a running step's ending decides", () => {
    const p = { keyId: ID } as unknown as PendingReplace;
    const table: [ReplaceRunning, PendingReplace | null, PendingReplace | null][] = [
      ["none", p, p],
      ["test", p, p],
      ["start", null, null],
      ["save", p, null],
      ["discard", p, null],
    ];
    for (const [running, pending, now] of table) expect({ running, got: leaveReplace(running, pending) }).toEqual({ running, got: now });
    const tested_: ReplaceStep = { kind: "tested", pending: p, lines: [] };
    const results: [ReplaceSaveResult, PendingReplace | null][] = [
      [{ kind: "landed", lines: [] }, null],
      [{ kind: "ended", lines: [] }, null],
      [{ kind: "notSaved", lines: [] }, p],
      [{ kind: "cancelled" }, p],
    ];
    expect(replaceOrphanAfter(false, { step: tested_ })).toBeNull();
    expect(replaceOrphanAfter(true, { step: tested_ })).toBe(p);
    expect(replaceOrphanAfter(true, { step: { kind: "refused", lines: [] } })).toBeNull();
    for (const [result, orphan] of results) {
      expect(replaceOrphanAfter(false, { pending: p, result })).toBeNull();
      expect({ result: result.kind, got: replaceOrphanAfter(true, { pending: p, result }) }).toEqual({ result: result.kind, got: orphan });
    }
  });

  test("the OLD key id is never deleted, on any path — and the pasted key never leaves providerKeySet", async () => {
    const results: unknown[] = [];
    const step = replaced(await startReplace(parse(SAVED_WORK), SAVED_WORK, "Work", KEY, "macos"));
    results.push(step, await saveReplace(step.pending, step.pending.text, screen().deps));
    handler = engine({ add: () => ({ kind: "refused", code: "config", reason: null, detail: "x" }) });
    results.push(await saveReplace(step.pending, step.pending.text, screen().deps));
    results.push(await discardReplace(step.pending, null));
    results.push(await startReplace(parse(SAVED_WORK), SAVED_WORK, "Work", KEY, "linux"));
    expect(deletes()).toEqual([]);
    const named = calls.filter(([c]) => c.startsWith("provider_pending_reset")).map(([, a]) => a["newKeyId"]);
    expect(named.length).toBeGreaterThan(0);
    expect(named).not.toContain(OLD_ID);
    expect(everywhereBut(...results)).not.toContain(KEY);
  });
});

describe("a step that ends after its add or replacement was discarded changes nothing (P3-M4-T3 checkpoint)", () => {
  type Step = Exclude<ReplaceRunning, "none">;
  test("Test again ending after Discard is not applied, and the Discard stays the running step", () => {
    const steps = new FlowSteps<Step>();
    expect(steps.running).toBe("none");
    const test_ = steps.start("test");
    expect(steps.running).toBe("test");
    steps.discard();
    const discard = steps.start("discard");
    expect(steps.ended(test_)).toBe(false);
    expect(steps.running).toBe("discard");
    expect(steps.ended(discard)).toBe(true);
    expect(steps.running).toBe("none");
  });
  test("a step ended in its own flow is applied; once the Discard ended, the stale step still is not", () => {
    const steps = new FlowSteps<Step>();
    const save = steps.start("save");
    expect(steps.ended(save)).toBe(true);
    expect(steps.running).toBe("none");
    const retest = steps.start("test");
    steps.discard();
    const discard = steps.start("discard");
    expect(steps.ended(discard)).toBe(true);
    // The next replacement's own step is running when the stale one ends: neither is disturbed.
    const next = steps.start("start");
    expect(steps.ended(retest)).toBe(false);
    expect(steps.running).toBe("start");
    expect(steps.ended(next)).toBe(true);
  });
  test("\"Discard changes\" during a step with no Discard of its own: the step ends stale and is no longer running", () => {
    const steps = new FlowSteps<Step>();
    const start = steps.start("start");
    steps.discard();
    expect(steps.ended(start)).toBe(false);
    expect(steps.running).toBe("none");
    // A step of the flow after it is current again.
    const again = steps.start("start");
    expect(steps.ended(again)).toBe(true);
  });
});

describe("Settings.svelte and ProvidersList.svelte wire Replace to these flows", () => {
  const settings = codeOf(readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
  const list = codeOf(readFileSync(new URL("../src/lib/ProvidersList.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
  const fn = (name: string): string => {
    const head = `async function ${name}(`;
    const at = settings.indexOf(head);
    expect(at).toBeGreaterThan(0);
    const next = settings.slice(at + head.length).search(/ (async )?function \w+\(/);
    return next < 0 ? settings.slice(at) : settings.slice(at, at + head.length + next);
  };
  test("start, Test again and Save call the flows; the Save saves through submit and resumes after the wait", () => {
    const start = fn("onproviderreplace");
    expect(start).toMatch(/const ticket = replaceSteps\.start\("start"\); const step = await startReplace\(base, doc\.text, label, key, os\);/);
    expect(start).toContain("const current = replaceSteps.ended(ticket); const orphan = replaceOrphanAfter(left || !current, { step });");
    expect(start).toContain("if (orphan !== null) { void discardReplace(orphan, null); return; } if (!current) return; replacing = {");
    // P3-M4-T3 checkpoint: a Test again ending after Discard puts nothing back — the row stays gone.
    expect(fn("onproviderreplaceretest")).toMatch(
      /const ticket = replaceSteps\.start\("test"\); const out = await retestReplace\(base, r\.pending\); if \(!replaceSteps\.ended\(ticket\)\) return; replaceBase = /,
    );
    const save = fn("onproviderreplacesave");
    expect(save).toContain("const next = addSaveDecision({");
    // Final round 3 (R3-M4): the save also notes that the one save path ran, so only its fresh outcome is revealed.
    expect(save).toContain("const run = saveReplace(p, next.text, { save: (text) => { submitted = true; return submit(text); },");
    // PR 3 final r5 (H2): `saving` is the form's own Save flag, the one `submit` refuses on.
    expect(save).toContain("saving: () => saving,");
    expect(save).toContain("cancelled: () => left || replaceCancelled,");
    expect(save).toContain("const ticket = replaceSteps.start(\"save\"); const run = saveReplace(");
    expect(save).toMatch(
      /replaceSaving = run; const result = await run; if \(replaceSaving === run\) replaceSaving = null; if \(!replaceSteps\.ended\(ticket\)\) return; const orphan = replaceOrphanAfter\(left, \{ pending: p, result \}\);/,
    );
    expect(settings).toContain("pending: replacePendingNotes(replacing?.label ?? null, replacing?.waiting === true),");
  });
  test("Discard, Discard changes and leaving go through discardReplace, which awaits the running save", () => {
    const discard = fn("onproviderreplacediscard");
    expect(discard).toContain("replaceCancelled = true; replaceWake?.();");
    expect(discard).toContain("const lines = await discardReplace(r.pending, replaceSaving); keyLines = lines;");
    expect(discard).toMatch(
      /if \(r\?\.pending == null \|\| replaceSteps\.running === "discard"\) return \[\];.*replaceSteps\.discard\(\); const ticket = replaceSteps\.start\("discard"\); const lines = await discardReplace\(r\.pending, replaceSaving\); keyLines = lines; replaceSteps\.ended\(ticket\); replacing = null; return lines;/,
    );
    // Round 11 (L5): "Discard changes" keeps the lines the replacement's Discard showed, and shows them again after its
    // reload (which clears the report), as it does a pending add's.
    expect(fn("discardChanges")).toContain("const replaced = replacing?.pending != null ? await onproviderreplacediscard() : []; replaceSteps.discard(); replacing = null;");
    expect(settings).toContain("const replaceSteps = new FlowSteps<Exclude<ReplaceRunning, \"none\">>();");
    const destroy = settings.slice(settings.indexOf("onDestroy(() => {"), settings.indexOf("keepSettings({", settings.indexOf("onDestroy(() => {")));
    expect(destroy).toContain("const replaced = leaveReplace(replaceSteps.running, replacing?.pending ?? null);");
    expect(destroy).toContain("if (replaced !== null) void discardReplace(replaced, replaceSaving);");
    // No delete, reset or drop of its own: every pending-reset call is in provider-flows.ts.
    for (const own of ["providerPendingResetAdd", "providerPendingResetFlush", "providerPendingResetDrop", "providerKeyDelete"]) expect([own, settings.includes(own)]).toEqual([own, false]);
  });
  test("the row's Replace key is drawn only where replaceable says, and its key input is cleared as it is handed over", () => {
    expect(list).toContain("{#if onreplace !== undefined && replaceable?.(row) === true && replaceFor !== row.label}");
    // PR 3 final r4 (H1): the busy state is the view's (a save, an add, a replacement or a row op), and an open
    // field's submit asks replaceable again before it touches the key.
    expect(settings).toContain("replaceable: (row) => replaceOffered(row, providersBusy),");
    expect(list).toMatch(/function submitReplace\(row: ProviderRowView\): void \{ if \(onreplace === undefined \|\| replaceable\?\.\(row\) !== true\) return; const pasted = replaceKey; replaceKey = ""; onreplace\(row\.label, pasted\); closeReplace\(\); \}/);
    expect(list).toMatch(/function closeReplace\(\): void \{ replaceFor = null; replaceKey = ""; \}/);
    expect(list).toContain('<input type="password" autocomplete="off" spellcheck="false" bind:value={replaceKey} />');
    expect(list).toContain("disabled={!replaceDiscardable(replacing)}");
    // PR 3 final r5 (H8): the field does not promise the old key "stays stored" — the row may read a key written in the
    // settings, or none (key moved). What became of a previous app key is said after the save (`saveReplace`).
    expect(list).toContain("New API key (the app stores it for you)");
    expect(list).not.toContain("old key stays stored");
  });
});

/* ── the carried LOW (P3-M4-T3 fix pass): leaving while an add's Test again runs ──────────────────── */

describe("leaving the screen while an add's Test again runs: the key is removed once the Test ends, never beside it", () => {
  test("nothing is deleted while the Test holds the engine (a delete then is refused busy); the key goes when it ends", async () => {
    const step = tested(await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "macos"));
    const base = engine();
    let testing = false;
    let release: () => void = () => {};
    handler = (command, args) => {
      if (command === "provider_candidate_check" && args["mode"] !== "validate") {
        testing = true;
        return new Promise((resolve) => {
          release = () => {
            testing = false;
            resolve(base(command, args));
          };
        });
      }
      // The in-flight guard (engine.rs `is_mutating`: KeyDelete and ProviderTest both hold it).
      if (command === "engine_provider_key_delete" && testing) throw { kind: "busy", running: "provider-test" };
      return base(command, args);
    };
    calls = [];
    const running = retestAdd(parse(SAVED), step.pending);
    for (let i = 0; i < 50 && !testing; i++) await new Promise((r) => setTimeout(r, 0));
    expect(testing).toBe(true);
    // The screen is left NOW (Settings' onDestroy): it removes only what leaveAdd hands it.
    const now = leaveAdd("test", step.pending);
    const early = now === null ? [] : await discardAdd(now, "macos");
    expect(deletes()).toEqual([]);
    expect(early).toEqual([]);
    // The Test ends: the step, seeing the screen left, hands its add to the removal — which now succeeds.
    release();
    const r = await running;
    const orphan = orphanAfter(true, { pending: r.pending, landed: false });
    expect(orphan?.keyId).toBe(ID);
    expect(await discardAdd(orphan!, "macos")).toEqual(["Discarded: the key you pasted was removed."]);
    expect(deletes()).toEqual([ID]);
  });
});

/* ── 8. a key written in the settings file: migrate, remove, and the scrub (P3-M4-T4) ─────────────── */

const PH = REDACTED_API_KEY;
const SAVED_LIT = cfgText({
  provider: CLAUDE,
  fallbacks: [
    { label: "Lit", api: { kind: "anthropic", model: "m", apiKey: PH } },
    { label: "Env", api: { kind: "anthropic", model: "m", apiKeyEnv: "MINE", apiKey: PH } },
    { label: "Cmd", api: { kind: "anthropic", model: "m", apiKeyCommand: ["pass", "show", "x"], apiKey: PH } },
    { label: "File", api: { kind: "anthropic", model: "m", apiKeyFile: "/home/me/key", apiKey: PH } },
  ],
  networkProbeHosts: [],
});
const fallbacksOf = (text: string): Json[] => parse(text)["fallbacks"] as Json[];

/** A screen for the literal-key flows: every save is recorded in `calls` too, so its order against the IPC shows. */
function literalScreen(over: Partial<flows.LiteralDeps> = {}, landed = true) {
  const saved: string[] = [];
  const slept: number[] = [];
  const deps: flows.LiteralDeps = {
    save: async (text) => {
      calls.push(["save", {}]);
      saved.push(text);
      return landed;
    },
    current: () => true,
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...over,
  };
  return { deps, saved, slept };
}
const target = (label: string, index: number, over: Partial<flows.LiteralTarget> = {}): flows.LiteralTarget => ({
  savedText: SAVED_LIT,
  label,
  index,
  os: "macos",
  unsaved: false,
  ...over,
});

describe("migrate: key migrate → the revision checked → a save removing ONLY the literal → scrub-backup", () => {
  test("the key moves: the save drops the literal at its pointer and adds the reference, nothing else changes, then the backup is scrubbed", async () => {
    handler = engine({ saved: SAVED_LIT });
    const s = literalScreen();
    const out = await flows.migrateLiteral({ ...target("Lit", 1), shownRevision: "rev-1" }, s.deps);
    expect(commands()).toEqual(["engine_provider_key_migrate", "save", "engine_provider_key_scrub_backup"]);
    // ⚠ THE APP NEVER HOLDS THE LITERAL: migrate is sent the index and nothing else; the engine reads the key itself.
    expect(calls[0]![1]).toEqual({ index: 1 });
    expect(s.saved).toHaveLength(1);
    const after = fallbacksOf(s.saved[0]!);
    expect(after[0]).toEqual({ label: "Lit", api: { kind: "anthropic", model: "m", apiKeyCommand: keyCommand(ID) } });
    // Every other entry as saved — the other literals still the placeholder the settings guard restores by pointer.
    expect(after.slice(1)).toEqual(fallbacksOf(SAVED_LIT).slice(1));
    expect({ ...parse(s.saved[0]!), fallbacks: null }).toEqual({ ...parse(SAVED_LIT), fallbacks: null });
    expect(out.landed).toBe(true);
    expect(out.lines).toEqual([flows.migratedLine("macos"), flows.SCRUB_SAVED_LINE]);
    expect(deletes()).toEqual([]);
    expect(logged).toEqual([]);
  });

  test("a source of the user's own that outranks the literal is KEPT: the reference takes only the empty slot", async () => {
    handler = engine({ saved: SAVED_LIT });
    let s = literalScreen();
    await flows.migrateLiteral({ ...target("Env", 2), shownRevision: "rev-1" }, s.deps);
    expect(fallbacksOf(s.saved[0]!)[1]).toEqual({ label: "Env", api: { kind: "anthropic", model: "m", apiKeyEnv: "MINE", apiKeyCommand: keyCommand(ID) } });
    calls = [];
    s = literalScreen();
    await flows.migrateLiteral({ ...target("File", 4), shownRevision: "rev-1" }, s.deps);
    expect(fallbacksOf(s.saved[0]!)[3]).toEqual({ label: "File", api: { kind: "anthropic", model: "m", apiKeyFile: "/home/me/key", apiKeyCommand: keyCommand(ID) } });
    // Off macOS the reference is a key file.
    calls = [];
    handler = engine({ saved: SAVED_LIT, migrate: migrateOk({ apiKeyCommand: undefined, apiKeyFile: `${KEYS}/${ID}.key` }) });
    s = literalScreen();
    await flows.migrateLiteral({ ...target("Env", 2, { os: "linux" }), shownRevision: "rev-1" }, s.deps);
    expect(fallbacksOf(s.saved[0]!)[1]).toEqual({ label: "Env", api: { kind: "anthropic", model: "m", apiKeyEnv: "MINE", apiKeyFile: `${KEYS}/${ID}.key` } });
  });

  test("a revision that does not match the row shown: the new key id is deleted, nothing is saved, and the reopen wording", async () => {
    for (const [answered, shown] of [["rev-OTHER", "rev-1"], ["rev-1", null], [undefined, "rev-1"]] as const) {
      calls = [];
      handler = engine({ saved: SAVED_LIT, migrate: migrateOk({ revision: answered }) });
      const s = literalScreen();
      const out = await flows.migrateLiteral({ ...target("Lit", 1), shownRevision: shown }, s.deps);
      expect({ answered, shown, saved: s.saved.length, deletes: deletes() }).toEqual({ answered, shown, saved: 0, deletes: [ID] });
      expect(commands()).not.toContain("engine_provider_key_scrub_backup");
      expect(out.landed).toBe(false);
      expect(out.lines[0]).toBe(flows.MIGRATE_CHANGED_LINE);
      expect(flows.MIGRATE_CHANGED_LINE).toContain("the saved settings changed — reopen and retry");
    }
  });

  test("a save that does not land, or a draft changed meanwhile: the new key is deleted, the literal stays, no scrub", async () => {
    handler = engine({ saved: SAVED_LIT });
    let s = literalScreen({}, false);
    let out = await flows.migrateLiteral({ ...target("Lit", 1), shownRevision: "rev-1" }, s.deps);
    expect([out.landed, deletes()]).toEqual([false, [ID]]);
    expect(commands()).not.toContain("engine_provider_key_scrub_backup");
    calls = [];
    s = literalScreen({ current: () => false });
    out = await flows.migrateLiteral({ ...target("Lit", 1), shownRevision: "rev-1" }, s.deps);
    expect([out.landed, s.saved.length, deletes()]).toEqual([false, 0, [ID]]);
    // Unsaved edits elsewhere in the draft: refused before anything runs (the move saves the settings).
    calls = [];
    out = await flows.migrateLiteral({ ...target("Lit", 1, { unsaved: true }), shownRevision: "rev-1" }, literalScreen().deps);
    expect([out.landed, calls.length]).toEqual([false, 0]);
    expect(out.lines[0]).toContain("Save or discard your changes first");
  });

  test("the engine's refusals, worded by code and reason; one naming a keyId deletes it", async () => {
    const refusal = (over: Json): Json => ({ schemaVersion: 1, ok: false, code: "config", error: "key migrate: x", ...over });
    const cases: [unknown, string][] = [
      [refusal({ reason: "invalid-key" }), "not one the app can store"],
      [refusal({ reason: "timeout" }), "could not be read in time — retry"],
      [refusal({ code: "write-failed", reason: "timeout", cleanup: "timeout", keyId: ID2 }), keyTimeoutLine("macos")],
      [() => { throw { kind: "busy", running: "provider-test" }; }, "another provider operation is running"],
      [() => { throw { kind: "timeout", operation: "provider-key-migrate", seconds: 19 }; }, keyTimeoutLine("macos")],
    ];
    for (const [answer, words] of cases) {
      calls = [];
      handler = engine({ saved: SAVED_LIT, migrate: answer });
      const s = literalScreen();
      const out = await flows.migrateLiteral({ ...target("Lit", 1), shownRevision: "rev-1" }, s.deps);
      expect({ words, saved: s.saved.length, hit: out.lines[0]?.includes(words) }).toEqual({ words, saved: 0, hit: true });
    }
    expect(deletes()).toEqual([]);
    calls = [];
    handler = engine({ saved: SAVED_LIT, migrate: refusal({ code: "write-failed", reason: "timeout", cleanup: "timeout", keyId: ID2 }) });
    await flows.migrateLiteral({ ...target("Lit", 1), shownRevision: "rev-1" }, literalScreen().deps);
    expect(deletes()).toEqual([ID2]);
  });
});

describe("an occupied slot: no migrate, and the written key is removed only — behind the screen's confirmation", () => {
  test("migrate refuses before any engine call when the user's own source holds the slot (or ranks below it)", async () => {
    for (const [label, index, os] of [["Cmd", 3, "macos"], ["Cmd", 3, "linux"], ["File", 4, "linux"]] as const) {
      calls = [];
      const s = literalScreen();
      const out = await flows.migrateLiteral({ ...target(label, index, { os }), shownRevision: "rev-1" }, s.deps);
      expect({ label, os, calls: calls.length, saved: s.saved.length, landed: out.landed }).toEqual({ label, os, calls: 0, saved: 0, landed: false });
      expect(out.lines[0]).toContain("Remove the key written in settings");
    }
  });

  test("an answer whose reference would take an occupied slot anyway: the new key is deleted, nothing saved", async () => {
    handler = engine({ saved: SAVED_LIT, migrate: migrateOk({ apiKeyCommand: undefined, apiKeyFile: `${KEYS}/${ID}.key` }) });
    const s = literalScreen();
    const out = await flows.migrateLiteral({ ...target("File", 4), shownRevision: "rev-1" }, s.deps);
    expect([out.landed, s.saved.length, deletes()]).toEqual([false, 0, [ID]]);
  });

  test("remove: the save drops ONLY the literal — the user's source untouched, no key stored or deleted — then the backup is scrubbed", async () => {
    handler = engine({ saved: SAVED_LIT });
    const s = literalScreen();
    const out = await flows.removeWrittenKey(target("Cmd", 3), s.deps);
    expect(commands()).toEqual(["save", "engine_provider_key_scrub_backup"]);
    const after = fallbacksOf(s.saved[0]!);
    expect(after[2]).toEqual({ label: "Cmd", api: { kind: "anthropic", model: "m", apiKeyCommand: ["pass", "show", "x"] } });
    expect([...after.slice(0, 2), after[3]]).toEqual([...fallbacksOf(SAVED_LIT).slice(0, 2), fallbacksOf(SAVED_LIT)[3]]);
    expect(out).toEqual({ landed: true, lines: [flows.WRITTEN_KEY_REMOVED_LINE, flows.SCRUB_SAVED_LINE] });
    // Not landed, edited meanwhile, or unsaved edits: nothing more.
    calls = [];
    expect((await flows.removeWrittenKey(target("Cmd", 3), literalScreen({}, false).deps)).landed).toBe(false);
    expect(commands()).toEqual(["save"]);
    calls = [];
    expect((await flows.removeWrittenKey(target("Cmd", 3, { unsaved: true }), literalScreen().deps)).landed).toBe(false);
    expect((await flows.removeWrittenKey(target("Cmd", 3), literalScreen({ current: () => false }).deps)).landed).toBe(false);
    expect(calls).toEqual([]);
    // A label that is no longer at that index in the saved settings: the reopen wording, nothing saved.
    const moved = await flows.removeWrittenKey(target("Cmd", 2), literalScreen().deps);
    expect([moved.landed, moved.lines[0], calls.length]).toEqual([false, flows.MIGRATE_CHANGED_LINE, 0]);
  });
});

describe("scrub-backup: idempotent, retried on a timeout, worded on open and after a save", () => {
  const ok = (removed: number, over: Json = {}): Json => ({ schemaVersion: 1, ok: true, removed, ...over });
  const timeout: Json = { schemaVersion: 1, ok: false, code: "config", reason: "timeout", error: "key scrub-backup: x" };

  test("on open: the wording when keys were removed, nothing when none were", async () => {
    handler = engine({ scrub: [ok(2)] });
    expect(flows.scrubLines(await flows.scrubBackup(async () => {}), "open")).toEqual([flows.SCRUB_OPEN_LINE]);
    expect(flows.SCRUB_OPEN_LINE).toBe("Keys no longer in your settings were removed from the backup.");
    handler = engine({ scrub: [ok(0)] });
    expect(flows.scrubLines(await flows.scrubBackup(async () => {}), "open")).toEqual([]);
  });

  test("otherCopies: true tells the user what to check — after the command's own sweep, a copy left is not the app's", async () => {
    for (const removed of [0, 1]) {
      handler = engine({ scrub: [ok(removed, { otherCopies: true })] });
      const r = await flows.scrubBackup(async () => {});
      expect(r).toEqual({ kind: "scrubbed", removed, otherCopies: true });
      for (const when of ["open", "save"] as const) expect(flows.scrubLines(r, when)).toContain(flows.SCRUB_OTHER_COPIES_LINE);
    }
    // The scrub command sweeps a crashed save's staged copy first (engine.rs, under the save lock), so asking for a save
    // would remove nothing more: the line says what to look for instead.
    expect(flows.SCRUB_OTHER_COPIES_LINE).not.toMatch(/save your settings/i);
    expect(flows.SCRUB_OTHER_COPIES_LINE).toContain("config.json.bak");
    expect(flows.SCRUB_OTHER_COPIES_LINE).toContain("did not make");
  });

  test("a config refusal with reason timeout is retried (and so are busy and the app's own bound), every SCRUB_RETRY_MS", async () => {
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
    };
    handler = engine({ scrub: [timeout, ok(1)] });
    expect(await flows.scrubBackup(sleep)).toEqual({ kind: "scrubbed", removed: 1, otherCopies: false });
    expect(commands().filter((c) => c === "engine_provider_key_scrub_backup")).toHaveLength(2);
    expect(slept).toEqual([flows.SCRUB_RETRY_MS]);
    expect(flows.SCRUB_RETRY_MS).toBe(15_000);
    for (const thrown of [{ kind: "busy", running: "provider-reset" }, { kind: "timeout", operation: "provider-key-scrub-backup", seconds: 15 }]) {
      calls = [];
      handler = engine({ scrub: [() => { throw thrown; }, ok(1)] });
      expect((await flows.scrubBackup(sleep)).kind).toBe("scrubbed");
      expect(commands().filter((c) => c === "engine_provider_key_scrub_backup")).toHaveLength(2);
    }
    // A timeout that never clears: tried SCRUB_TRIES times, then a line that says it is tried again on the next open.
    calls = [];
    handler = engine({ scrub: [timeout] });
    const r = await flows.scrubBackup(sleep);
    expect(r).toMatchObject({ kind: "failed", cause: "exhausted" });
    expect(commands().filter((c) => c === "engine_provider_key_scrub_backup")).toHaveLength(flows.SCRUB_TRIES);
    expect(flows.scrubLines(r, "open")[0]).toContain("checked again the next time the app opens");
    // Any other refusal is not retried.
    calls = [];
    handler = engine({ scrub: [{ ...timeout, reason: undefined }, ok(1)] });
    expect((await flows.scrubBackup(sleep)).kind).toBe("failed");
    expect(commands().filter((c) => c === "engine_provider_key_scrub_backup")).toHaveLength(1);
  });
});

describe("App.svelte and Settings.svelte wire the literal-key flows", () => {
  const app = codeOf(readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
  const settings = codeOf(readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
  test("the scrub runs on EVERY open, from App (whatever screen is shown), never awaited by start-up, and its lines go to App's notice", () => {
    const mount = app.slice(app.indexOf("onMount(() => {"), app.indexOf("return () => {", app.indexOf("onMount(() => {")));
    expect(mount).toMatch(/ void scrubOnOpen\(\); /);
    // Unconditional: at onMount's own top level (one brace and one parenthesis deep — not inside a callback, a branch
    // or a `.then`), with no `return` before it at that level.
    const before = mount.slice(0, mount.indexOf("void scrubOnOpen();"));
    const depth = (open: string, close: string): number => [...before].reduce((d, ch) => d + (ch === open ? 1 : ch === close ? -1 : 0), 0);
    expect([depth("{", "}"), depth("(", ")")]).toEqual([1, 1]);
    expect(before).not.toMatch(/; return\b|\{ return\b/);
    const fn = app.slice(app.indexOf("async function scrubOnOpen("), app.indexOf("}", app.indexOf("scrubLines(")) + 1);
    expect(fn).toContain("await scrubBackup(");
    expect(fn).toContain('scrubLines(');
    expect(fn).toContain('"open"');
    expect(app).toContain("{#if scrubNotice !== null}");
    expect(app).toMatch(/\{#each scrubNotice as line, n \(n\)\} <p>\{line\}<\/p> \{\/each\}/);
    expect(app).toContain("onclick={() => (scrubNotice = null)}>Dismiss</button>");
  });
  test("Settings runs migrate and remove through the one save path, with the shown row's revision, guarded by literalGuards", () => {
    expect(settings).toContain("await migrateLiteral(");
    expect(settings).toContain("await removeWrittenKey(");
    expect(settings).toContain("shownRevision: row?.revision ?? null");
    // The guards are literalGuards' (behaviour-tested below), handed through unchanged — delimiters included, so no
    // `&& false` and no `() => true` can stand in for them (P3-M4 checkpoint mutants G14, G15).
    const at = settings.indexOf("function literalRun(");
    expect(at).toBeGreaterThan(0);
    const run = settings.slice(at, settings.indexOf(" function ", at + 1));
    expect(run).toContain(
      "const screen = (): LiteralScreen => ({ savedText: doc?.text ?? null, tab, draft: draft === null ? null : ($state.snapshot(draft) as Draft) });",
    );
    expect(run).toContain("const guards = literalGuards(screen(), screen);");
    expect(run).toContain("target: { savedText, label, index: savedIndex, os, unsaved: guards.unsaved },");
    expect(run).toContain("deps: { save: (text) => submit(text), current: guards.current, sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)), },");
    expect([run.split("current:").length - 1, run.split("unsaved:").length - 1, run.split("tab").length - 1]).toEqual([1, 1, 1]);
    expect(settings.split("literalGuards(").length - 1).toBe(1);
    // Both actions take their guards from literalRun, and only from it.
    expect(settings.split("const run = literalRun(label, savedIndex);").length - 1).toBe(2);
    expect(settings).toContain("onprovidermigrate={(label, i) => void onprovidermigrate(label, i)}");
    expect(settings).toContain("onproviderremoveliteral={(label, i) => void onproviderremoveliteral(label, i)}");
    expect(settings.split("configSave(").length - 1).toBe(1);
  });
  test("codeOf strips comments, so a commented-out pin no longer matches (G11c)", () => {
    expect(codeOf("a();\n    // void scrubOnOpen();\nb();")).not.toContain("void scrubOnOpen();");
    expect(codeOf("a(); /* void scrubOnOpen(); */ b();")).not.toContain("void scrubOnOpen();");
    expect(codeOf("<p>x</p><!-- {#if scrubNotice !== null} -->")).not.toContain("{#if scrubNotice");
    // …and keeps code that only looks like a comment opener.
    expect(codeOf('const u = "https://example.com"; // trailing')).toBe('const u = "https://example.com";');
  });
});

/* ── P3-M4 checkpoint: the guards, the remove's source check, the refusal wording, the on-open notice ─────── */

const screenOf = (over: Partial<flows.LiteralScreen> = {}): flows.LiteralScreen => ({ savedText: SAVED_LIT, tab: "form", draft: parse(SAVED_LIT), ...over });

describe("literalGuards: unsaved and current, decided from the screen (findings 1 and 8)", () => {
  test("unsaved: an edited draft, the Raw tab, or no draft — never the untouched saved settings", () => {
    expect(flows.literalGuards(screenOf(), () => screenOf()).unsaved).toBe(false);
    // Reformatted but equal is not an edit.
    expect(flows.literalGuards(screenOf({ savedText: JSON.stringify(parse(SAVED_LIT)) }), () => screenOf()).unsaved).toBe(false);
    const edited = parse(SAVED_LIT);
    edited["morningTime"] = "06:00";
    expect(flows.literalGuards(screenOf({ draft: edited }), () => screenOf()).unsaved).toBe(true);
    expect(flows.literalGuards(screenOf({ tab: "raw" }), () => screenOf()).unsaved).toBe(true);
    expect(flows.literalGuards(screenOf({ draft: null }), () => screenOf()).unsaved).toBe(true);
    expect(flows.literalGuards(screenOf({ savedText: null }), () => screenOf()).unsaved).toBe(true);
  });
  test("current: only while the Form tab is shown, the saved text and the draft are the ones the action started from", () => {
    let now = screenOf();
    const g = flows.literalGuards(screenOf(), () => now);
    expect(g.current()).toBe(true);
    // The Raw tab: its edits live in `raw` and reach the draft only on the way back, so the post-save reload would wipe
    // them — not current, whatever the draft says (finding 8).
    now = screenOf({ tab: "raw" });
    expect(g.current()).toBe(false);
    const edited = parse(SAVED_LIT);
    edited["morningTime"] = "06:00";
    now = screenOf({ draft: edited });
    expect(g.current()).toBe(false);
    now = screenOf({ savedText: SAVED_LIT.replace('"Lit"', '"Lit2"') });
    expect(g.current()).toBe(false);
    now = screenOf({ draft: null });
    expect(g.current()).toBe(false);
    // Read each time it is asked, never once.
    now = screenOf();
    expect(g.current()).toBe(true);
  });
});

describe("remove refuses unless a source of the user's own takes the literal's place (finding 2)", () => {
  test("Lit (no other source) and Env on macOS (migrate is offered there): refused before any save; Cmd and, on Linux, File: allowed", async () => {
    for (const [label, index, os] of [["Lit", 1, "macos"], ["Env", 2, "macos"], ["Lit", 1, "linux"], ["File", 4, "macos"]] as const) {
      calls = [];
      handler = engine({ saved: SAVED_LIT });
      const s = literalScreen();
      const out = await flows.removeWrittenKey(target(label, index, { os }), s.deps);
      expect({ label, os, landed: out.landed, saved: s.saved.length, calls: calls.length }).toEqual({ label, os, landed: false, saved: 0, calls: 0 });
      expect(out.lines[0]).toBe(flows.removeRefusedLine(os));
    }
    expect(flows.removeRefusedLine("macos")).toContain("move it to the Keychain");
    expect(flows.removeRefusedLine("linux")).toContain("move it to the key folder");
    for (const [label, index, os] of [["Cmd", 3, "macos"], ["Cmd", 3, "linux"], ["File", 4, "linux"]] as const) {
      calls = [];
      handler = engine({ saved: SAVED_LIT });
      const out = await flows.removeWrittenKey(target(label, index, { os }), literalScreen().deps);
      expect({ label, os, landed: out.landed }).toEqual({ label, os, landed: true });
    }
    // The probe's shape: an entry with no source at all is never saved as `{kind, model}`.
    calls = [];
    const s = literalScreen();
    await flows.removeWrittenKey(target("Lit", 1), s.deps);
    expect(s.saved).toEqual([]);
  });
});

describe("migrate's reason-less config refusal: https advice only for an http: block (finding 3)", () => {
  const HTTP_LIT = cfgText({
    provider: CLAUDE,
    fallbacks: [{ label: "Lan", api: { kind: "openai-compatible", model: "m", baseUrl: "http://10.0.0.5:8080/v1", apiKey: PH } }, ...(fallbacksOf(SAVED_LIT) as Json[])],
    networkProbeHosts: [],
  });
  const refusal: Json = { schemaVersion: 1, ok: false, code: "config", error: "key migrate: x" };
  test("http: gets the switch-to-https line; https: or no baseUrl gets the generic one", async () => {
    handler = engine({ saved: HTTP_LIT, migrate: refusal });
    const http = await flows.migrateLiteral({ ...target("Lan", 1, { savedText: HTTP_LIT }), shownRevision: "rev-1" }, literalScreen().deps);
    expect(http.lines[0]).toContain("if this provider is on another machine, switch its address to https first");
    expect(http.lines[0]).toBe(flows.MIGRATE_HTTP_LINE);
    // B3 (PR 3 final r1): the line is chosen by the scheme alone, so a LOOPBACK http: address (which the engine allows)
    // gets it too — and it tells that user what to do as well.
    const loop = HTTP_LIT.replace("http://10.0.0.5:8080", "http://127.0.0.1:8080");
    calls = [];
    handler = engine({ saved: loop, migrate: refusal });
    const local = await flows.migrateLiteral({ ...target("Lan", 1, { savedText: loop }), shownRevision: "rev-1" }, literalScreen().deps);
    expect(local.lines[0]).toBe(flows.MIGRATE_HTTP_LINE);
    expect(local.lines[0]).toContain("if it is on this one, check that the settings are valid");
    for (const savedText of [SAVED_LIT, HTTP_LIT.replace("http://10.0.0.5", "https://10.0.0.5")]) {
      calls = [];
      handler = engine({ saved: savedText, migrate: refusal });
      const label = savedText === SAVED_LIT ? "Lit" : "Lan";
      const out = await flows.migrateLiteral({ ...target(label, 1, { savedText }), shownRevision: "rev-1" }, literalScreen().deps);
      expect({ label, line: out.lines[0] }).toEqual({ label, line: flows.MIGRATE_CONFIG_LINE });
      expect(out.lines[0]).not.toContain("https");
    }
  });
});

describe("the key store's name, per platform (finding 5)", () => {
  test("the moved line and the kept-copy lines say Keychain on macOS (unchanged) and key folder elsewhere", async () => {
    expect(flows.migratedLine("macos")).toBe("Moved: the key is in the Keychain now, and the settings file keeps only a reference to it.");
    expect(flows.migratedLine("linux")).toBe("Moved: the key is in the key folder now, and the settings file keeps only a reference to it.");
    // A revision mismatch drops the new id; with the saved settings unreadable the copy is kept, and said so.
    for (const [os, store] of [["macos", "Keychain"], ["linux", "key folder"], ["windows", "key folder"]] as const) {
      calls = [];
      handler = engine({
        saved: () => {
          throw { kind: "configUnreadable", path: "/c", detail: "x" };
        },
        migrate: migrateOk({ revision: "rev-OTHER" }),
      });
      const out = await flows.migrateLiteral({ ...target("Lit", 1, { os }), shownRevision: "rev-1" }, literalScreen().deps);
      expect({ os, kept: out.lines[1] }).toEqual({ os, kept: `The copy stored in the ${store} was kept (the saved settings could not be read); Uninstall can remove it with your settings and API keys.` });
    }
    // A landed move says the platform's store.
    calls = [];
    handler = engine({ saved: SAVED_LIT, migrate: migrateOk({ apiKeyCommand: undefined, apiKeyFile: `${KEYS}/${ID}.key` }) });
    const linux = await flows.migrateLiteral({ ...target("Lit", 1, { os: "linux" }), shownRevision: "rev-1" }, literalScreen().deps);
    expect(linux.lines[0]).toBe(flows.migratedLine("linux"));
  });
});

describe("the scrub on open: quiet for a config refusal, a changed backup retried (finding 7)", () => {
  const ok = (removed: number): Json => ({ schemaVersion: 1, ok: true, removed });
  const config = (over: Json = {}): Json => ({ schemaVersion: 1, ok: false, code: "config", error: "key scrub-backup: x", ...over });
  test("a config refusal says nothing on open (Settings reports an invalid config), and is still worded after a save", async () => {
    handler = engine({ scrub: [config()] });
    const r = await flows.scrubBackup(async () => {});
    expect(r.kind).toBe("failed");
    expect(flows.scrubLines(r, "open")).toEqual([]);
    expect(flows.scrubLines(r, "save")).toHaveLength(1);
  });
  test("write-failed, an engine failure, and retries that ran out are shown on open", async () => {
    const cases: [unknown[], string][] = [
      [[{ schemaVersion: 1, ok: false, code: "write-failed", error: "key scrub-backup: x" }], "could not be rewritten"],
      [[() => { throw { kind: "spawn", detail: "no sidecar" }; }], "checked again"],
      [[null], "stopped before replying"],
      [[config({ reason: "timeout" })], "did not answer in time"],
      [[() => { throw { kind: "busy", running: "provider-test" }; }], "checked again"],
    ];
    for (const [scrub, words] of cases) {
      calls = [];
      handler = engine({ scrub });
      const lines = flows.scrubLines(await flows.scrubBackup(async () => {}), "open");
      expect({ words, n: lines.length, hit: lines[0]?.includes(words) }).toEqual({ words, n: 1, hit: true });
    }
  });
  test('"changed while it was scrubbed — retry" (`reason: "changed"`) is retried like a timeout, and runs out the same way', async () => {
    handler = engine({ scrub: [config({ reason: "changed" }), ok(1)] });
    expect(await flows.scrubBackup(async () => {})).toEqual({ kind: "scrubbed", removed: 1, otherCopies: false });
    expect(commands().filter((c) => c === "engine_provider_key_scrub_backup")).toHaveLength(2);
    calls = [];
    handler = engine({ scrub: [config({ reason: "changed" })] });
    const r = await flows.scrubBackup(async () => {});
    expect(commands().filter((c) => c === "engine_provider_key_scrub_backup")).toHaveLength(flows.SCRUB_TRIES);
    expect(flows.scrubLines(r, "open")).toHaveLength(1);
  });
});

describe("one unused-key rule for Settings and the wizard (checkpoint P3-M6, carried item A)", () => {
  const ANY_KEY = { label: "D", api: { kind: "anthropic", model: "m", apiKeyCommand: [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-w", KEYCHAIN] } };
  const USES_ID = cfgText({ provider: CLAUDE, fallbacks: [{ label: "API", api: { kind: "anthropic", model: "m", apiKeyCommand: keyCommand(ID) } }] });
  /** `config_read` answering a file that exists but whose text could not be read. */
  const unreadable = (): ((c: string, a: Json) => unknown) => {
    const base = engine();
    return (c, a) => (c === "config_read" ? { path: `${HOME}/config.json`, exists: true, text: null, base: null, parseError: "x", apiKeyRedacted: false } : base(c, a));
  };
  test("no config at all: \"keep\" (Settings) keeps the key, \"delete\" (the wizard's first run) deletes it", async () => {
    handler = engine({ saved: null });
    expect(await unusedKey.removeIfUnused(ID, "macos", "keep")).toEqual({ kind: "kept", why: "the saved settings could not be read" });
    expect(deletes()).toEqual([]);
    calls = [];
    expect(await unusedKey.removeIfUnused(ID, "macos", "delete")).toEqual({ kind: "deleted" });
    expect(deletes()).toEqual([ID]);
    expect(commands()).toEqual(["config_read", "engine_provider_key_delete"]);
  });
  test("every other shape is decided the same under both policies", async () => {
    const cases: [string, () => (c: string, a: Json) => unknown, unknown][] = [
      ["the saved config uses the id", () => engine({ saved: USES_ID }), { kind: "inUse" }],
      ["it uses another key", () => engine({ saved: SAVED }), { kind: "deleted" }],
      ["it exists but cannot be read", unreadable, { kind: "kept", why: "the saved settings could not be read" }],
      ["the read fails", () => engine({ saved: () => { throw { kind: "io", detail: "x" }; } }), { kind: "kept", why: "the saved settings could not be read" }],
      ["a row may read ANY app key", () => engine({ saved: cfgText({ provider: CLAUDE, fallbacks: [ANY_KEY] }) }), { kind: "kept", why: "another provider's key command may read any key the app stores" }],
      ["fewer rows than entries", () => engine({ saved: USES_ID, report: (r) => ({ ...r, providers: (r["providers"] as Json[]).slice(0, 1) }) }), { kind: "kept", why: "not every provider in the saved list could be checked" }],
      ["the check fails", () => engine({ saved: USES_ID, report: () => { throw { kind: "timeout", operation: "config-validate", seconds: 30 }; } }), { kind: "kept", why: "the saved settings could not be checked" }],
      ["the delete is refused", () => engine({ saved: SAVED, del: { schemaVersion: 1, ok: false, code: "write-failed", error: "x", reason: "denied" } }), { kind: "notDeleted", why: "the key store refused (denied)" }],
    ];
    for (const [name, make, want] of cases) {
      for (const policy of ["keep", "delete"] as const) {
        calls = [];
        handler = make();
        expect({ name, policy, got: await unusedKey.removeIfUnused(ID, "linux", policy) }).toEqual({ name, policy, got: want });
      }
    }
  });
  test("both callers use it, each with its own policy, and neither keeps a copy of the rule", () => {
    const src = (f: string): string => codeOf(readFileSync(new URL(`../src/lib/${f}`, import.meta.url), "utf8"));
    const pf = src("provider-flows.ts");
    const wk = src("wizard-key.ts");
    expect(pf.match(/removeIfUnused\(([^)]*)\)/g)).toEqual(["removeIfUnused(p.keyId, os, \"keep\", retry)", "removeIfUnused(keyId, os, \"keep\")"]);
    // Remove's delete after the save goes through the same rule's retry (A1), with Settings' policy.
    expect(pf.match(/deleteCleared\(([^)]*)\)/g)).toEqual(["deleteCleared(k.keyId, os, \"keep\", retry)"]);
    expect(wk.match(/removeIfUnused\(([^)]*)\)/g)).toEqual(["removeIfUnused(p.keyId, os, \"delete\")"]);
    for (const [f, code] of [["provider-flows.ts", pf], ["wizard-key.ts", wk]] as const) {
      for (const own of ["function vouchingRows", "function deleteKey", "function deleteOnce", "function deleteCleared", "function heldNow", "function checkRefusal", "function validated", "function referenceIn", "function keySetRefusalLine", "configRead("]) {
        expect([f, own, code.includes(own)]).toEqual([f, own, false]);
      }
    }
  });
});

/* ── PR 3 final r1: a busy key delete is retried, each retry after THE RULE's check again (A1); the pins C2, C3 ── */

describe("a key delete refused busy is retried, bounded, and only after the saved settings are checked again (A1)", () => {
  const USES_ID = cfgText({ provider: CLAUDE, fallbacks: [{ label: "API", api: { kind: "anthropic", model: "m", apiKeyCommand: keyCommand(ID) } }] });
  /** An injected clock: records each wait, never waits. */
  const clock = (tries = 4) => {
    const slept: number[] = [];
    return { slept, retry: { tries, sleep: async (ms: number) => void slept.push(ms) } };
  };
  /** The engine, with the first `n` key deletes refused busy (a row's Test holds the in-flight guard). */
  const busyFor = (n: number, s: Parameters<typeof engine>[0] = {}): ((c: string, a: Json) => unknown) => {
    const base = engine(s);
    let refused = 0;
    return (c, a) => {
      if (c === "engine_provider_key_delete" && refused < n) {
        refused += 1;
        throw { kind: "busy", running: "provider-test" };
      }
      return base(c, a);
    };
  };

  test("busy, then free: deleted, after one wait of KEY_DELETE_RETRY_MS per refusal, the check run again before each try", async () => {
    expect(unusedKey.KEY_DELETE_RETRY_MS).toBe(10_000);
    // The tries outlast the longest Test bound (80 s, `appTestTimeoutMs`): (tries - 1) waits.
    expect((unusedKey.KEY_DELETE_TRIES - 1) * unusedKey.KEY_DELETE_RETRY_MS).toBeGreaterThan(80_000);
    handler = busyFor(2);
    const c = clock();
    expect(await unusedKey.removeIfUnused(ID, "macos", "keep", c.retry)).toEqual({ kind: "deleted" });
    expect(c.slept).toEqual([10_000, 10_000]);
    expect(commands()).toEqual([
      "config_read", "validate", "engine_provider_key_delete",
      "config_read", "validate", "engine_provider_key_delete",
      "config_read", "validate", "engine_provider_key_delete",
    ]);
  });

  test("the saved settings start using the key during the wait: the retry is NOT sent, and the key is kept", async () => {
    let savedNow = SAVED;
    const base = busyFor(1, { saved: () => savedNow });
    handler = base;
    const c = clock();
    const slept = c.retry.sleep;
    c.retry.sleep = async (ms: number) => {
      await slept(ms);
      savedNow = USES_ID; // e.g. the add's save landed after all
    };
    expect(await unusedKey.removeIfUnused(ID, "macos", "keep", c.retry)).toEqual({ kind: "inUse" });
    expect(deletes()).toEqual([ID]); // the first, refused attempt only
    // …and a check that cannot vouch any more keeps it the same way.
    calls = [];
    savedNow = SAVED;
    handler = busyFor(1, { saved: () => savedNow });
    const c2 = clock();
    c2.retry.sleep = async () => {
      savedNow = "{ not json";
    };
    expect((await unusedKey.removeIfUnused(ID, "macos", "keep", c2.retry)).kind).toBe("kept");
    expect(deletes()).toEqual([ID]);
  });

  test("the saved settings disappear during the wait: the retry's check keeps its policy — \"keep\" keeps the key, \"delete\" deletes it", async () => {
    // PR 3 final r2 (finding 2, mutant T8): the re-check before a retry honours `noConfig` as given, never a fixed one.
    for (const [policy, want, sent] of [
      ["keep", { kind: "kept", why: "the saved settings could not be read" }, [ID]],
      ["delete", { kind: "deleted" }, [ID, ID]],
    ] as const) {
      calls = [];
      let savedNow: string | null = SAVED;
      handler = busyFor(1, { saved: () => savedNow });
      const c = clock();
      const slept = c.retry.sleep;
      c.retry.sleep = async (ms: number) => {
        await slept(ms);
        savedNow = null; // the config file is gone by the retry
      };
      expect({ policy, got: await unusedKey.removeIfUnused(ID, "macos", policy, c.retry) }).toEqual({ policy, got: want });
      expect({ policy, sent: deletes() }).toEqual({ policy, sent: [...sent] });
    }
  });

  test("bounded: busy every time ends notDeleted after KEY_DELETE_TRIES attempts; any other refusal is not retried", async () => {
    handler = busyFor(99);
    const c = clock(3);
    const out = await unusedKey.removeIfUnused(ID, "macos", "keep", c.retry);
    expect(out.kind).toBe("notDeleted");
    expect(deletes()).toEqual([ID, ID, ID]);
    expect(c.slept).toHaveLength(2);
    for (const thrown of [{ kind: "spawn", detail: "no sidecar" }, { kind: "timeout", operation: "provider-key-delete", seconds: 15 }]) {
      calls = [];
      const base = engine();
      handler = (cmd, a) => {
        if (cmd === "engine_provider_key_delete") throw thrown;
        return base(cmd, a);
      };
      const c2 = clock();
      expect((await unusedKey.removeIfUnused(ID, "macos", "keep", c2.retry)).kind).toBe("notDeleted");
      expect([thrown.kind, deletes().length, c2.slept.length]).toEqual([thrown.kind, 1, 0]);
    }
  });

  test("Discard and Remove both retry through it", async () => {
    const step = tested(await startAdd(parse(SAVED), { label: "API", block: ANTHROPIC }, KEY, "macos"));
    calls = [];
    handler = busyFor(1);
    const c = clock();
    expect(await discardAdd(step.pending, "macos", c.retry)).toEqual(["Discarded: the key you pasted was removed."]);
    expect([deletes(), c.slept]).toEqual([[ID, ID], [10_000]]);

    // Remove: the delete after the save, refused busy once, retried after re-reading the CURRENT saved settings.
    const after = cfgText({ provider: CLAUDE });
    calls = [];
    handler = busyFor(1, { saved: after });
    const c2 = clock();
    const lines = await deleteUnreferencedKeys(after, [{ label: "A", keyId: ID }], "macos", c2.retry);
    expect(lines).toEqual(['The stored key of "A" was deleted.']);
    expect(commands()).toEqual(["validate", "engine_provider_key_delete", "config_read", "validate", "engine_provider_key_delete"]);
    // …and kept, with no second delete, when the re-read settings use it.
    calls = [];
    handler = busyFor(1, { saved: USES_ID });
    const kept = await deleteUnreferencedKeys(after, [{ label: "A", keyId: ID }], "macos", clock().retry);
    expect(kept).toEqual(['The stored key of "A" was kept: another provider uses it.']);
    expect(deletes()).toEqual([ID]);
  });
});

describe("the pins round 1 found missing (C2, C3)", () => {
  test("C2: rows the saved list does not have (an index past its last entry) do not vouch: the key is kept", async () => {
    const USES_OTHER = cfgText({ provider: CLAUDE, fallbacks: [{ label: "API", api: { kind: "anthropic", model: "m", apiKeyCommand: keyCommand(ID2) } }] });
    const extra = (r: Json): Json => ({ ...r, providers: [...(r["providers"] as Json[]), { index: 2, testTimeoutMs: 1, loopback: false, keyOptional: false, keyMoved: false }] });
    handler = engine({ saved: USES_OTHER, report: extra });
    expect(await unusedKey.vouchingRows(USES_OTHER)).toEqual({ ok: false, why: "not every provider in the saved list could be checked" });
    expect(await unusedKey.removeIfUnused(ID, "macos", "keep")).toEqual({ kind: "kept", why: "not every provider in the saved list could be checked" });
    expect(deletes()).toEqual([]);
    // Without the extra row the same settings vouch, and the key is deleted.
    calls = [];
    handler = engine({ saved: USES_OTHER });
    expect(await unusedKey.removeIfUnused(ID, "macos", "keep")).toEqual({ kind: "deleted" });
  });

  /* PR 3 final r5 (A2): the twin of Rust's `key_refs::row_key` — a row whose `appOwnedKey` is present but not a
   * boolean, or whose `appKeyId` is present but not a string, is malformed, and a malformed row vouches for nothing. */
  test("A2: a malformed row (appOwnedKey not a boolean, appKeyId not a string) does not vouch: the key is kept", async () => {
    const USES_OTHER = cfgText({ provider: CLAUDE, fallbacks: [{ label: "API", api: { kind: "anthropic", model: "m", apiKeyCommand: keyCommand(ID2) } }] });
    const MALFORMED = "the saved settings' check answered a row the app cannot read";
    const at1 = (over: Json) => (r: Json): Json => ({ ...r, providers: (r["providers"] as Json[]).map((p) => (p["index"] === 1 ? { ...p, ...over } : p)) });
    const cases: [string, Json][] = [
      ["appOwnedKey a string", { appOwnedKey: "yes" }],
      ["appOwnedKey a number", { appOwnedKey: 1 }],
      ["appOwnedKey null", { appOwnedKey: null }],
      ["appKeyId a number", { appOwnedKey: true, appKeyId: 7 }],
      ["appKeyId null", { appKeyId: null }],
    ];
    for (const [name, over] of cases) {
      calls = [];
      handler = engine({ saved: USES_OTHER, report: at1(over) });
      expect({ name, v: await unusedKey.vouchingRows(USES_OTHER) }).toEqual({ name, v: { ok: false, why: MALFORMED } });
      expect({ name, out: await unusedKey.removeIfUnused(ID, "macos", "keep") }).toEqual({ name, out: { kind: "kept", why: MALFORMED } });
      expect({ name, deletes: deletes() }).toEqual({ name, deletes: [] });
    }
    // Well-formed shapes still vouch: `appOwnedKey: false` and a string id (the latter keeps its own key in use).
    for (const over of [{ appOwnedKey: false }, { appOwnedKey: true, appKeyId: ID2 }]) {
      handler = engine({ saved: USES_OTHER, report: at1(over) });
      expect((await unusedKey.vouchingRows(USES_OTHER)).ok).toBe(true);
    }
  });

  test("C3: two removed entries on one key: one delete, and each label gets its own line", async () => {
    const after = cfgText({ provider: CLAUDE });
    const lines = await deleteUnreferencedKeys(after, [{ label: "A", keyId: ID }, { label: "B", keyId: ID }, { label: "C", keyId: ID2 }], "macos");
    expect(deletes()).toEqual([ID, ID2]);
    expect(lines).toEqual(['The stored key of "A" was deleted.', 'The stored key of "B" was deleted.', 'The stored key of "C" was deleted.']);
    // A refused delete is reported for both labels, still sent once.
    calls = [];
    handler = engine({ del: { schemaVersion: 1, ok: false, code: "write-failed", error: "x", reason: "denied" } });
    const refused = await deleteUnreferencedKeys(after, [{ label: "A", keyId: ID }, { label: "B", keyId: ID }], "macos");
    expect(deletes()).toEqual([ID]);
    expect(refused.map((l) => l.slice(0, 22))).toEqual(['The stored key of "A" ', 'The stored key of "B" ']);
    expect(refused.every((l) => l.includes("could not be deleted (the key store refused (denied))"))).toBe(true);
  });
});

describe("a key left in the store is not promised to go \"when the app is uninstalled\" (checkpoint P3-M6, carried item B)", () => {
  test("Uninstall removes stored keys only with the settings-and-keys box ticked and the key leg not refused: the lines say \"can\"", () => {
    expect(unusedKey.KEY_LEFT_FOR_UNINSTALL).toBe("Uninstall can remove it with your settings and API keys");
    for (const f of ["provider-flows.ts", "wizard-key.ts", "unused-key.ts", "settings-model.ts", "files.ts"]) {
      const code = codeOf(readFileSync(new URL(`../src/lib/${f}`, import.meta.url), "utf8"));
      expect([f, /when the app is uninstalled|until the app is uninstalled/.test(code)]).toEqual([f, false]);
    }
  });
});
