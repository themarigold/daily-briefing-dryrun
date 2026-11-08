/**
 * "Providers, in order" — the app's ONE list reader and writer (provider fallback, plan P3-M3-T1; spec r9 §4
 * "Storing the list", §6 "The settings guard").
 *
 * The engine reads one combined list: item 1's logins (`provider.accounts`, when item 1 is a CLI and the list
 * is set), then `fallbacks` in order (`src/providerList.ts` `resolveProviderList`). The editor shows that list
 * flat; this module turns a config value into it and back.
 *
 *  • READ is structural, never a verdict. Each entry is its label, its provider block AS WRITTEN (a login's block
 *    is item 1's) and its login directory as written. Whether an entry is valid, a duplicate login or unlogged
 *    is the engine's to say (`config validate`, the save gate in P3-M4-T1). The reader REFUSES only a list it
 *    cannot represent faithfully — a broken `provider.accounts`, an invalid `provider.label`, a `fallbacks` entry
 *    with no label, a label used twice — each of which the engine also refuses (tests-web/provider-list.check.ts
 *    pins every refusal against the engine). Named boundary: two logins on one directory are read as written; the
 *    engine reads them as a broken list, and the save gate refuses them.
 *  • WRITE compacts, and compaction KEEPS — it never PULLS IN (checkpoint P3-M3, hub entry 2026-10-18). A CLI login
 *    STAYS in `provider.accounts` only while it was READ from `accounts`, on the directory it was read with, and is
 *    still contiguous at the top with exactly item 1's block (`cli`, `argv`, `promptVia`, `harden`, `credential`,
 *    `timeoutMs` — the whole block as written, so an unknown field differing keeps it a fallback, which reads the
 *    same), item 1 itself read from `accounts`. Every other entry — anything read from `fallbacks`, any new entry —
 *    is a full `fallbacks` block, so moving an entry moves its block. So the written `accounts` is item 1 plus a
 *    reordered subset of the logins it was read with: a valid list can never be written broken. (Pulling a
 *    same-settings fallback in could: `resolveAccounts` refuses the WHOLE list when two logins share a resolved
 *    directory — an absent `configDir` is `~/.claude` there, whatever `CLAUDE_CONFIG_DIR` says — and the engine then
 *    ran item 1 alone as "default", where the walk had dropped only the duplicate.) Item 1 itself goes into
 *    `accounts[0]` when it needs a login directory, or when it is a login, a fallback moved up or a new entry (an
 *    older engine reads its label there); alone, it cannot collide. A login pushed out keeps its own
 *    unread fields (a `note`), never one a block would read. The stored form is therefore a function of the list
 *    AND of where each entry was read from: written back, it reads back the same. What the engine ignores at item 1
 *    (`accounts` beside an API item 1, `provider.label` beside a resolving `accounts`, a login's unread fields,
 *    a stray `provider.fallbacks`) is kept while item 1 is the same entry with the same block, so a save with no
 *    edit returns the config unchanged, key order included. An entry whose block carries a nested `accounts` /
 *    `fallbacks` (the engine drops such a fallback as bad-shape) round-trips where it is, but never becomes a
 *    changed item 1: that write is BLOCKED (`nested-list`), since `provider` would carry it live.
 *  • LABELS NEVER CHANGE. A label is the entry's identity (marks, status and the settings guard's literal-key
 *    restore follow it). Nothing here renames: entries are frozen, and `setEntrySettings` replaces an entry's
 *    block and directory, never its label.
 *  • THE JUDGE. The audit judge is built from `provider` and `resolveAccounts(provider.accounts)`
 *    (`scripts/audit.ts`), so `judgeChanged` is any change to `provider` as written, including a compaction that
 *    moves a login out of `accounts` (spec §6, requirement 10).
 *  • A LITERAL KEY'S POINTER IS FIXED. The settings guard restores a redacted literal by JSON pointer and owner
 *    label (`config_save.rs`), so a write that would move a literal's pointer, or put a different entry at it —
 *    a reorder, an insert or removal above it, a compaction across `provider` / `fallbacks` — is BLOCKED; the user
 *    migrates the key first (spec §6). A reference (`apiKeyEnv`, PR 2's scrub sentinel `apiKeyEnv` (gui-seam §1d),
 *    `apiKeyFile`, `apiKeyCommand`) is not a literal and moves freely, byte for byte.
 *
 * Pure: no IPC, no filesystem, no engine import (a webview module cannot load the engine's `node:` code; the
 * check file runs the engine against what this writes).
 */

type Json = Record<string, unknown>;

/** Item 1's label when nothing names it — the engine's `DEFAULT_LABEL` (src/account.ts), pinned by the check. */
export const DEFAULT_LABEL = "default";

/** One entry of the combined list. `block` is the provider block as written — never `label`, `accounts`,
 *  `configDir` or `fallbacks`, which are the list's. A login's block is item 1's. */
export interface ProviderEntry {
  readonly label: string;
  readonly block: Readonly<Json>;
  readonly configDir?: string;
}

export type ReadRefusal =
  | "provider-not-object"
  | "accounts-unreadable"
  | "provider-label-invalid"
  | "fallbacks-unreadable"
  | "duplicate-label";

export type ReadResult = { ok: true; entries: readonly ProviderEntry[] } | { ok: false; reason: ReadRefusal };

/** Why a write was refused. `literal-moved`: a literal key would land at `to`; `from` is where that entry's literal
 *  sits on disk, absent when the entry has none there (a different entry would sit at a literal's pointer). */
export type Blocked =
  | { kind: "unreadable"; reason: ReadRefusal }
  | { kind: "empty" }
  | { kind: "duplicate-label"; label: string }
  | { kind: "config-dir-on-api"; label: string }
  | { kind: "config-dir-on-non-claude"; label: string }
  | { kind: "nested-list"; label: string; field: string }
  | { kind: "literal-moved"; label: string; from?: string; to: string };

export type WriteResult = { ok: true; config: Json; judgeChanged: boolean } | { ok: false; blocked: Blocked[] };

/** The fields that belong to the list, never to a block. */
const LIST_FIELDS = ["label", "accounts", "configDir", "fallbacks"] as const;
/** The provider-block fields the engine reads (`Config["provider"]` in src/types.ts, minus the list's; the check pins
 *  this against that type). A login that carries one does not carry it into a `fallbacks` block, where it would run. */
const BLOCK_FIELDS = ["cli", "argv", "promptVia", "api", "harden", "credential", "timeoutMs"] as const;

/** How an entry was written, found by label in the config being replaced. */
type Origin =
  | { where: "accounts"; raw: Json }
  | { where: "label" }
  | { where: "implicit" }
  | { where: "fallback"; raw: Json };

type Read = { entry: ProviderEntry; origin: Origin; literal?: string };

/** A JSON object (not `null`, not an array). The app's one copy: every module of the providers screen imports it
 *  from here, the leaf of their imports (PR 3 final r1, C6). */
export const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
/** A plain copy through JSON: a Svelte `$state` proxy cannot be `structuredClone`d, which this module does. */
export const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** Every way an `api` block names its key, in the order they outrank (spec §6; `src/apiKey.ts`). Defined once, here:
 *  Settings' migrate rule (`migrateBlockedBy`), Add's switch to a pasted key and the wizard's merge read it. */
export const KEY_SOURCES = ["apiKeyEnv", "apiKeyFile", "apiKeyCommand", "apiKey"] as const;
export type KeySource = (typeof KEY_SOURCES)[number];
/** The engine's label rule (`nonEmpty`, src/providerList.ts; `resolveAccounts`, src/config.ts). */
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const clone = <T>(v: T): T => structuredClone(v);

/** Sorted-key JSON: equal values compare equal whatever order their keys were written in. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (isObject(v)) {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const x of Object.values(v as object)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

function without(o: Json, keys: readonly string[]): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
  return out;
}

const isCli = (block: Readonly<Json>): boolean => block["api"] === undefined;
/** A CLI block whose tool is Claude — the engine's `claudeShaped` (src/harden.ts), the rule its `config-dir` drop
 *  applies: the last path segment, case-insensitively, with `.exe` / `.cmd` / `.bat` / `.ps1` stripped, is `claude`.
 *  The segment is read as the engine on WINDOWS reads it (`path.win32.basename`: `/` and `\` both separate; a drive
 *  letter and trailing separators are ignored), so `C:\Program Files\Claude\claude.exe` counts; a `/`-only spelling
 *  reads the same as on POSIX. Restated, not imported: this module is pure and cannot load the engine's `node:` code;
 *  tests-web/provider-list.check.ts pins it spelling by spelling against the engine's (and its Windows stand-in). Also
 *  what decides whether the add form offers another login (`provider-flows.ts` `loginSource`). */
export function isClaudeCli(block: Readonly<Json>): boolean {
  const cli = block["cli"];
  if (!isCli(block) || typeof cli !== "string") return false;
  return cliName(cli) === "claude";
}

/** A command's name as `isClaudeCli` reads it: the last path segment (Windows or POSIX separators), lower-cased, with
 *  `.exe` / `.cmd` / `.bat` / `.ps1` stripped. Also how Settings names the first provider's tool (`settings-model.ts`
 *  `toolChoiceOf`, user-directed 2026-10-22): Claude by this rule, the engine's, and Codex by the same reading, which is
 *  display only — the engine has no Codex rule. */
export function cliName(cli: string): string {
  const base = cli.replace(/^[A-Za-z]:/, "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}
const holdsLiteral = (block: Readonly<Json>): boolean => isObject(block["api"]) && block["api"]["apiKey"] !== undefined;
const ITEM1_LITERAL = "/provider/api/apiKey";
const fallbackLiteral = (i: number): string => `/fallbacks/${i}/api/apiKey`;

function entry(label: string, block: Json, configDir: unknown): ProviderEntry {
  return typeof configDir === "string" ? { label, block, configDir } : { label, block };
}

function readAll(config: Json): { ok: true; read: Read[] } | { ok: false; reason: ReadRefusal } {
  const provider = config["provider"];
  if (!isObject(provider)) return { ok: false, reason: "provider-not-object" };
  const block = without(provider, ["label", "accounts", "configDir"]);
  const read: Read[] = [];
  // ── item 1 ── `accounts` is read only for a CLI item 1, as the engine reads it (ignored beside an API item 1).
  const accounts = provider["accounts"];
  let logins: Json[] | undefined;
  if (isCli(block) && accounts !== undefined && accounts !== null) {
    if (!Array.isArray(accounts)) return { ok: false, reason: "accounts-unreadable" };
    for (const a of accounts) {
      if (!isObject(a) || !nonEmpty(a["label"]) || (a["configDir"] !== undefined && typeof a["configDir"] !== "string")) {
        return { ok: false, reason: "accounts-unreadable" };
      }
    }
    if (accounts.length > 0) logins = accounts as Json[];
  }
  if (provider["label"] !== undefined && !nonEmpty(provider["label"])) return { ok: false, reason: "provider-label-invalid" };
  if (logins !== undefined) {
    for (const l of logins) read.push({ entry: entry(l["label"] as string, block, l["configDir"]), origin: { where: "accounts", raw: l } });
  } else {
    const named = provider["label"] !== undefined;
    const r: Read = { entry: entry(named ? (provider["label"] as string) : DEFAULT_LABEL, block, undefined), origin: { where: named ? "label" : "implicit" } };
    if (holdsLiteral(block)) r.literal = ITEM1_LITERAL;
    read.push(r);
  }
  // ── fallbacks ──
  const fallbacks = config["fallbacks"];
  if (fallbacks !== undefined && fallbacks !== null) {
    if (!Array.isArray(fallbacks)) return { ok: false, reason: "fallbacks-unreadable" };
    for (const [i, f] of fallbacks.entries()) {
      if (!isObject(f) || !nonEmpty(f["label"]) || (f["configDir"] !== undefined && typeof f["configDir"] !== "string")) {
        return { ok: false, reason: "fallbacks-unreadable" };
      }
      const b = without(f, ["label", "configDir"]);
      const r: Read = { entry: entry(f["label"] as string, b, f["configDir"]), origin: { where: "fallback", raw: f } };
      if (holdsLiteral(b)) r.literal = fallbackLiteral(i);
      read.push(r);
    }
  }
  const labels = read.map((r) => r.entry.label);
  if (new Set(labels).size !== labels.length) return { ok: false, reason: "duplicate-label" };
  return { ok: true, read };
}

/** The combined list as written in `config` (see the header). Entries are frozen copies. */
export function readProviderList(config: Json): ReadResult {
  const r = readAll(config);
  if (!r.ok) return r;
  return { ok: true, entries: deepFreeze(clone(r.read.map((x) => x.entry))) };
}

/** The login object for `e` in `accounts`: its old object (unread fields kept) when it was a login, else new. */
function loginObject(e: ProviderEntry, origin: Origin | undefined): Json {
  const out: Json = origin?.where === "accounts" ? clone(origin.raw) : { label: e.label };
  if (e.configDir !== undefined) out["configDir"] = e.configDir;
  else delete out["configDir"];
  return out;
}

/** The full `fallbacks` block for `e`: its old object when it was this fallback, unchanged; else built — a login
 *  pushed out of `accounts` keeping its own fields the engine did not read there (never one a block reads). */
function fallbackObject(e: ProviderEntry, origin: Origin | undefined): Json {
  if (origin?.where === "fallback" && same(without(origin.raw, ["label", "configDir"]), e.block) && origin.raw["configDir"] === e.configDir) {
    return clone(origin.raw);
  }
  const out: Json = { label: e.label, ...(e.configDir !== undefined ? { configDir: e.configDir } : {}), ...clone(e.block as Json) };
  if (origin?.where === "accounts") {
    for (const [k, v] of Object.entries(origin.raw)) {
      if (!(k in out) && !(LIST_FIELDS as readonly string[]).includes(k) && !(BLOCK_FIELDS as readonly string[]).includes(k)) out[k] = clone(v);
    }
  }
  return out;
}

/**
 * `config` with `provider` and `fallbacks` rewritten from `entries` (see the header). `config` is the value the
 * list was read from — the on-disk shape the literal-key and judge checks compare against. Neither input is
 * mutated. Blocked when the list is empty or repeats a label, when an API item 1 would need a login directory
 * (which only `accounts` can carry), when a non-Claude CLI entry with a login directory would become a new item 1
 * (`config-dir-on-non-claude`), when a changed item 1's block carries the list's own fields (`nested-list`), or when
 * a literal key's pointer would move.
 */
export function writeProviderList(config: Json, entries: readonly ProviderEntry[]): WriteResult {
  const before = readAll(config);
  if (!before.ok) return { ok: false, blocked: [{ kind: "unreadable", reason: before.reason }] };
  const first = entries[0];
  if (first === undefined) return { ok: false, blocked: [{ kind: "empty" }] };
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.label)) return { ok: false, blocked: [{ kind: "duplicate-label", label: e.label }] };
    seen.add(e.label);
  }
  const origins = new Map(before.read.map((r) => [r.entry.label, r.origin]));
  const literalAt = new Map(before.read.filter((r) => r.literal !== undefined).map((r) => [r.literal!, r.entry.label]));
  const literalOf = new Map(before.read.filter((r) => r.literal !== undefined).map((r) => [r.entry.label, r.literal!]));
  const blocked: Blocked[] = [];

  // ── compaction KEEPS, never pulls in: item 1, then the leading run of logins READ from `accounts` (on the
  // directory they were read with) with exactly item 1's block — only when item 1 is itself such a login ──
  const readAsLogin = (e: ProviderEntry): boolean => {
    const o = origins.get(e.label);
    return o?.where === "accounts" && o.raw["configDir"] === e.configDir;
  };
  let k = 1;
  if (isCli(first.block) && readAsLogin(first)) {
    while (k < entries.length && readAsLogin(entries[k]!) && same(entries[k]!.block, first.block)) k++;
  }

  // ── `provider` ──
  const was = before.read[0]!;
  const firstOrigin = origins.get(first.label);
  // Item 1 unchanged: start from the old `provider`, so what the engine ignores there (and key order) is kept.
  const reuse = was.entry.label === first.label && same(was.entry.block, first.block);
  // A changed item 1 starts from its block alone, so `accounts` the engine ignored beside an old API item 1 is NOT
  // carried: beside a CLI item 1 it would go live (checkpoint P3-M3 LOW 7).
  const provider: Json = reuse ? clone(config["provider"] as Json) : clone(first.block as Json);
  // A block carrying the list's own fields (a fallback the engine drops as bad-shape) never becomes a changed item 1.
  if (!reuse) {
    for (const f of LIST_FIELDS) if (f in first.block) blocked.push({ kind: "nested-list", label: first.label, field: f });
  }
  // A non-Claude CLI with a login directory never becomes a NEW item 1 (plan hub "(BUILD, P3-M4-T1, 2026-10-18)
  // Decided" (2)): there `config validate` calls it only advisory (it runs, with a meaningless CLAUDE_CONFIG_DIR), as a
  // fallback the engine drops it. An item 1 that already was this entry, on this directory, is left alone (req. 9).
  if (isCli(first.block) && !isClaudeCli(first.block) && first.configDir !== undefined) {
    const already = was.entry.label === first.label && was.entry.configDir === first.configDir && isCli(was.entry.block) && !isClaudeCli(was.entry.block);
    if (!already) blocked.push({ kind: "config-dir-on-non-claude", label: first.label });
  }
  let form: "accounts" | "label" | "implicit";
  if (!isCli(first.block)) {
    if (first.configDir !== undefined) blocked.push({ kind: "config-dir-on-api", label: first.label });
    form = firstOrigin?.where === "label" || first.label !== DEFAULT_LABEL ? "label" : "implicit";
  } else if (k > 1 || first.configDir !== undefined) {
    form = "accounts";
  } else if (firstOrigin?.where === "label") {
    form = "label";
  } else if (firstOrigin?.where === "implicit" && first.label === DEFAULT_LABEL) {
    form = "implicit";
  } else {
    // A login, a fallback moved to the top or a new entry: its label goes where an older engine reads it too.
    form = "accounts";
  }
  if (form === "accounts") {
    provider["accounts"] = entries.slice(0, k).map((e) => loginObject(e, origins.get(e.label)));
    // A `provider.label` that was already ignored beside the logins stays as written; one that named item 1 goes,
    // since `accounts[0]` names it now.
    if (!(reuse && firstOrigin?.where === "accounts")) delete provider["label"];
  } else {
    // `accounts`, if the reused `provider` holds one, is one the engine ignored (API item 1, or empty): kept as is.
    if (form === "label") provider["label"] = first.label;
    else delete provider["label"];
  }

  // ── `fallbacks` ──
  const fallbacks = entries.slice(k).map((e) => fallbackObject(e, origins.get(e.label)));

  // ── a literal key's pointer, and its owner, never change ──
  const placed: [ProviderEntry, string][] = [[first, ITEM1_LITERAL], ...entries.slice(k).map((e, i): [ProviderEntry, string] => [e, fallbackLiteral(i)])];
  for (const [e, to] of placed) {
    if (!holdsLiteral(e.block) || literalAt.get(to) === e.label) continue;
    const from = literalOf.get(e.label);
    blocked.push(from !== undefined ? { kind: "literal-moved", label: e.label, from, to } : { kind: "literal-moved", label: e.label, to });
  }
  if (blocked.length > 0) return { ok: false, blocked };

  const out: Json = clone(config);
  out["provider"] = provider;
  const old = config["fallbacks"];
  if (fallbacks.length > 0) out["fallbacks"] = fallbacks;
  else if (!(old === null || (Array.isArray(old) && old.length === 0))) delete out["fallbacks"];
  return { ok: true, config: out, judgeChanged: !same(config["provider"], provider) };
}

// ── list edits: none of them renames ──

function checkBlock(block: Json): void {
  for (const k of LIST_FIELDS) {
    if (k in block) throw new Error(`a provider block cannot carry "${k}" — it belongs to the list`);
  }
}

function freezeEntry(label: string, block: Json, configDir: string | undefined): ProviderEntry {
  checkBlock(block);
  return deepFreeze(clone(entry(label, block, configDir)));
}

function indexOf(entries: readonly ProviderEntry[], label: string): number {
  const i = entries.findIndex((e) => e.label === label);
  if (i < 0) throw new Error("no entry has that label");
  return i;
}

/** `entries` with the entry at `from` moved to `to` (both positions in the list as it is). */
export function moveEntry(entries: readonly ProviderEntry[], from: number, to: number): ProviderEntry[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= entries.length || to >= entries.length) {
    throw new Error("moveEntry: position out of range");
  }
  const out = [...entries];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved!);
  return out;
}

/** `entries` with a new entry at `at`. Its label must be non-empty and unused: it is fixed from here on. */
export function insertEntry(entries: readonly ProviderEntry[], at: number, e: { label: string; block: Json; configDir?: string }): ProviderEntry[] {
  if (!Number.isInteger(at) || at < 0 || at > entries.length) throw new Error("insertEntry: position out of range");
  if (!nonEmpty(e.label)) throw new Error("a provider needs a non-empty label");
  if (entries.some((x) => x.label === e.label)) throw new Error("that label is already used — labels are unique across the list");
  const out = [...entries];
  out.splice(at, 0, freezeEntry(e.label, e.block, e.configDir));
  return out;
}

/** `entries` without the entry labelled `label`. */
export function removeEntry(entries: readonly ProviderEntry[], label: string): ProviderEntry[] {
  const i = indexOf(entries, label);
  return [...entries.slice(0, i), ...entries.slice(i + 1)];
}

/** `entries` with the entry labelled `label` given a new block and login directory (absent: none). Its label is
 *  not a setting: it never changes. */
export function setEntrySettings(entries: readonly ProviderEntry[], label: string, settings: { block: Json; configDir?: string }): ProviderEntry[] {
  const i = indexOf(entries, label);
  const out = [...entries];
  out[i] = freezeEntry(label, settings.block, settings.configDir);
  return out;
}
