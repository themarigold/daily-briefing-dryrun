// src/providerList.ts — the combined provider list (provider-fallback plan P1-M2; spec r9 §4).
//
// The combined list is item 1's logins, then `fallbacks` in order:
//   • item 1's logins are `provider.accounts` as `resolveAccounts` reads them — unchanged, and as the audit
//     judge reads them (scripts/audit.ts) — when item 1 is a CLI provider and the list resolves; otherwise
//     item 1 is its implicit single entry. For an API item 1 `accounts` is ignored, as core.ts does (the key
//     ladder raises that warning, src/apiKey.ts). A BROKEN `accounts` list keeps today's warning and item 1
//     runs as its implicit entry; the list still continues into `fallbacks`.
//   • each `fallbacks` entry is validated and normalized exactly as `provider` is (`normalizeProviderBlock`),
//     and a broken one is DROPPED with a warning naming it (`fallbacks[2] "Local model": …`) and a reason.
//
// Identity is the label, never the position. Labels are unique across the combined list. The duplicate-login
// key (resolved directory, credential) across Claude CLI entries lives HERE only: `resolveAccounts`' own
// directory-only check stays as it is, because the judge reads it.
//
// Reads one thing from disk: `resolveAccounts`' `.claude.json` existence heuristic, through `exists` (default
// `existsSync`; tests inject it). Writes nothing, and never throws for a broken fallback. A broken `provider` block is still a config error — `validateConfig`
// threw on it before a Config reached here.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Config } from "./types";
import { DEFAULT_NETWORK_PROBE_HOSTS, expandTilde, normalizeProviderBlock, resolveAccounts } from "./config";
import { defaultTimeoutMs } from "./provider";
import { cleartextRemote, deriveProbeHosts, endpointUrl, isLoopbackHost } from "./providers/endpoint";
import { resolveProbeHosts, type ProbeHost } from "./net";
import { claudeShaped } from "./harden";
import { appKeyFileOwnershipSteps, KEY_ID_ANYCASE_RE, KEY_ID_SOURCE } from "./keyFile";
import { runFsAsync, runFsSync, type AsyncFsOps, type FsSteps } from "./strictFile";
import { scrubCalendarLinks } from "./calendar/link-scrub";
import { keysDir } from "./marker";
import { APP_KEY_SERVICE, SECURITY_BIN } from "./appKeyNames";
import { DEFAULT_LABEL } from "./account";
import { safeLabel } from "./failover";
import { shellWords } from "./shellWords";

// The Keychain names as DATA, from the one file R2 lets name the binary (test/isolation.meta.test.ts).
export { APP_KEY_SERVICE, SECURITY_BIN };

/** The run's warning for a `provider.label` that is not a non-empty string. `config validate` reports this
 *  one as an ERROR (src/json.ts), so the app never saves a label the run would read as "default". */
export const PROVIDER_LABEL_INVALID = 'config: "provider.label" must be a non-empty string — item 1 is labelled "default"';

/** One entry of the combined list, resolved. */
export type ListEntry = {
  label: string;
  /** "provider": one of item 1's logins (or its implicit entry); "fallback": a `fallbacks` entry. */
  source: "provider" | "fallback";
  /** The entry's index in `fallbacks` as written, for a fallback. */
  fallbackIndex?: number;
  /** The resolved per-entry provider block — what `buildProvider` receives. Never carries `accounts`,
   *  `label` or `configDir`: those are the list's, not the block's. */
  provider: Config["provider"];
  /** The login directory (CLAUDE_CONFIG_DIR) for a Claude CLI entry, `~` expanded. */
  configDir?: string;
  /** The effective per-attempt timeout: item 1's `provider.timeoutMs`, a fallback's own, else the entry's
   *  transport default (`defaultTimeoutMs`: TIMEOUT_MS for a CLI, API_TIMEOUT_MS for an API). */
  timeoutMs: number;
  /** An API entry whose endpoint is a loopback host (a local model). CLI entries are remote. */
  isLoopback: boolean;
};

export type DropReason = "bad-shape" | "duplicate-label" | "config-dir" | "duplicate-login";

/** A `fallbacks` entry the resolver refused. `index` is undefined when `fallbacks` itself is not a list. */
export type DroppedEntry = { index?: number; label?: string; reason: DropReason; warning: string };

/** `accountsBroken` (PR 2 final harden round 1, B7): item 1 is a CLI whose `provider.accounts` is set but did not
 *  resolve (`resolveAccounts` refused it — the "— account failover disabled" warning), so item 1 runs as ONE implicit
 *  entry while the written list holds its N logins. The structural signal `--index` refuses on (src/providerCli.ts
 *  `resolveIndex`), never a match on the warning's wording. False for an API item 1 (`accounts` is ignored there). */
export type ProviderList = { entries: ListEntry[]; dropped: DroppedEntry[]; warnings: string[]; accountsBroken: boolean };

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** The provider block without the list's own fields. */
function blockOf(p: Record<string, unknown>): Config["provider"] {
  const { accounts: _a, label: _l, configDir: _c, ...rest } = p;
  return rest as unknown as Config["provider"];
}

function loopback(p: Config["provider"]): boolean {
  if (p.api === undefined) return false;
  const u = endpointUrl(p.api);
  return u !== undefined && isLoopbackHost(u.hostname);
}

/** The duplicate-login key of a Claude CLI entry, or undefined for any other entry. An entry with no `configDir` runs
 *  with the CLAUDE_CONFIG_DIR the process inherits (no per-spawn override), so that is its login when set (PR 1 final
 *  review round 4, L9); else `<home>/.claude`. ⚠ `resolveAccounts` (config.ts, unchanged — requirement 9) still reads
 *  an absent `configDir` as `~/.claude` for its own same-login check, so under an exported CLAUDE_CONFIG_DIR the two
 *  checks disagree about item 1's logins (round 5 L5). */
function loginKey(p: Config["provider"], configDir: string | undefined, home: string, env: Record<string, string | undefined>): string | undefined {
  if (p.api !== undefined || !claudeShaped(p.cli)) return undefined;
  return JSON.stringify([configDir ?? (env.CLAUDE_CONFIG_DIR || join(home, ".claude")), p.credential ?? "subscription"]);
}

/** A `provider`-worded error from `normalizeProviderBlock`, reworded for the entry at `path`. The block-shape
 *  error says what an ENTRY needs and drops its "(run `daily-briefing init`)" hint, which only fits `provider`. */
function reword(message: string, path: string): string {
  if (message.startsWith('config error: "provider" must be {')) return `"${path}" must be { cli, argv, promptVia } or an "api" block`;
  return message.replace(/^config error: /, "").replaceAll('"provider.', `"${path}.`).replaceAll('"provider"', `"${path}"`);
}

/** The combined list for a validated config. See the header. */
export function resolveProviderList(
  cfg: Config, home: string, env: Record<string, string | undefined> = process.env,
  exists?: (p: string) => boolean,
): ProviderList {
  const warnings: string[] = [];
  const dropped: DroppedEntry[] = [];
  const entries: ListEntry[] = [];
  const prov = cfg.provider as Config["provider"] & Record<string, unknown>;

  // ── item 1 ──
  const isApi = prov.api !== undefined;
  const acc = resolveAccounts(isApi ? undefined : prov.accounts, home, env, exists);
  warnings.push(...acc.warnings);
  // `resolveAccounts` answers no list for an unset `accounts` too; only a SET one it refused is broken.
  const accountsBroken = !isApi && prov.accounts !== undefined && prov.accounts !== null && acc.accounts === undefined;
  const logins = acc.accounts !== undefined && acc.accounts.length > 0 ? acc.accounts : undefined;
  // Item 1's label when nothing names it: `account.ts`'s `DEFAULT_LABEL`, the label a machine with no `accounts` marks
  // against (what older engines use), so the two can never differ.
  let item1Label = DEFAULT_LABEL;
  if (prov.label !== undefined && !nonEmpty(prov.label)) {
    warnings.push(PROVIDER_LABEL_INVALID);
  } else if (prov.label !== undefined && logins) {
    warnings.push(`config: "provider.label" is ignored beside "provider.accounts" — item 1 is labelled by its first login, ${JSON.stringify(safeLabel(logins[0]!.label))}`);
  } else if (prov.label !== undefined) {
    item1Label = prov.label as string;
  }
  const block = blockOf(prov);
  const item1Timeout = prov.timeoutMs ?? defaultTimeoutMs(block);
  for (const login of logins ?? [{ label: item1Label }] as { label: string; configDir?: string }[]) {
    entries.push({
      label: login.label, source: "provider", provider: block,
      ...(login.configDir !== undefined ? { configDir: login.configDir } : {}),
      timeoutMs: item1Timeout, isLoopback: loopback(block),
    });
  }

  // ── fallbacks ──
  const raw = (cfg as Config & { fallbacks?: unknown }).fallbacks;
  if (raw === undefined || raw === null) return { entries, dropped, warnings, accountsBroken };
  const drop = (d: Omit<DroppedEntry, "warning">, detail: string): void => {
    // The label through `safeLabel` (PR 1 final review round 1, M2): this warning reaches stderr every tick, config
    // validate's errors, doctor and status, so a key or a calendar link used as a label must never ride in it.
    const name = d.index === undefined ? '"fallbacks"' : `fallbacks[${d.index}]${d.label !== undefined ? ` ${JSON.stringify(safeLabel(d.label))}` : ""}`;
    // The detail through `scrubCalendarLinks` (PR 1 final review round 4, L1): a reworded validator error can quote a
    // config value — a `baseUrl` that is a scheme-less calendar link is "not a valid URL: <it>" — and this warning
    // reaches the briefing's ⚠ line, stderr and `run --json`.
    const warning = `config: ${name}: ${scrubCalendarLinks(detail)} — ${d.index === undefined ? "no fallback runs" : "this fallback is skipped"}`;
    dropped.push({ ...d, warning });
    warnings.push(warning);
  };
  if (!Array.isArray(raw)) {
    drop({ reason: "bad-shape" }, "must be an array of provider blocks");
    return { entries, dropped, warnings, accountsBroken };
  }
  const labels = new Set(entries.map((e) => e.label));
  const logins2 = new Set(entries.map((e) => loginKey(e.provider, e.configDir, home, env)).filter((k) => k !== undefined));
  raw.forEach((item: unknown, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return drop({ index, reason: "bad-shape" }, "must be an object (a provider block plus a label)");
    const e = item as Record<string, unknown>;
    if (!nonEmpty(e.label)) return drop({ index, reason: "bad-shape" }, 'needs a non-empty string "label"');
    const label = e.label;
    const path = `fallbacks[${index}]`;
    for (const k of ["fallbacks", "accounts"]) {
      if (e[k] !== undefined) return drop({ index, label, reason: "bad-shape" }, `cannot nest "${k}" — each login is its own entry`);
    }
    if (e.configDir !== undefined && typeof e.configDir !== "string") return drop({ index, label, reason: "bad-shape" }, `"${path}.configDir" must be a string when present`);
    let p: Config["provider"];
    try { p = normalizeProviderBlock(blockOf(e), home); }
    catch (err) { return drop({ index, label, reason: "bad-shape" }, reword(err instanceof Error ? err.message : String(err), path)); }
    if (labels.has(label)) return drop({ index, label, reason: "duplicate-label" }, "uses a label an earlier entry already has, and marks are keyed by label");
    const configDir = e.configDir !== undefined ? expandTilde(e.configDir as string, home) : undefined;
    if (configDir !== undefined && (p.api !== undefined || !claudeShaped(p.cli))) {
      return drop({ index, label, reason: "config-dir" }, '"configDir" applies to a Claude CLI entry only');
    }
    const key = loginKey(p, configDir, home, env);
    if (key !== undefined && logins2.has(key)) {
      return drop({ index, label, reason: "duplicate-login" }, "is the same Claude login (directory and credential) as an earlier entry, so it cannot fail over");
    }
    labels.add(label);
    if (key !== undefined) logins2.add(key);
    entries.push({
      label, source: "fallback", fallbackIndex: index, provider: p,
      ...(configDir !== undefined ? { configDir } : {}),
      timeoutMs: p.timeoutMs ?? defaultTimeoutMs(p), isLoopback: loopback(p),
    });
  });
  return { entries, dropped, warnings, accountsBroken };
}

// ── the entry revision ──────────────────────────────────────────────────────────────────────────────

/** JSON with every object's keys sorted, so the written order of a block is not an input. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * An OPAQUE revision of what an entry runs (spec r9 §4): a hash over the resolved provider block, the
 * resolved login directory, the effective timeout and the key reference — `apiKeyEnv`'s name,
 * `apiKeyFile`'s path, `apiKeyCommand`'s argv, all of which sit in the block — excluding position and
 * label. It keys provider status, so an edit to an entry starts its status afresh.
 *
 * A literal `apiKey` enters ONLY through the hash of the whole block, never on its own and unsalted
 * (plan Q7): for a high-entropy key a stored digest can only confirm a guess that is already right. The
 * output is hex, 128 bits of SHA-256, and carries no byte of any input.
 */
export function entryRevision(entry: ListEntry): string {
  const input = canonicalJson({ provider: entry.provider, configDir: entry.configDir ?? null, timeoutMs: entry.timeoutMs });
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}

// ── the app-owned-key predicate ─────────────────────────────────────────────────────────────────────

/** `s` as a literal inside a RegExp source. The one copy (C3): `key scrub-backup`'s staged-copy pattern uses it too. */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The service as a whole token, or joined behind ANY short-flag cluster (`-s<svc>`, `-ws<svc>`, and `-l<svc>`: an
 *  item's label defaults to its service name — PR 1 final review round 4, L2). */
const SERVICE_TOKEN = APP_KEY_SERVICE.toLowerCase();
const JOINED_SERVICE_RE = new RegExp(`^-[A-Za-z]+${escapeRe(APP_KEY_SERVICE)}$`, "i");
/** A shell word naming an app key FILE (round 4 L3): its basename is `k-<12 hex>.key`, the name the app writes. It
 *  serves OWNERSHIP only: a key file word inside a command names no id (`commandKeyIds`). */
const KEY_FILE_WORD_RE = new RegExp(`(?:^|[\\\\/])${KEY_ID_SOURCE}\\.key$`, "i");

/** Does this key command name the app's service anywhere? Every argv element is split into shell words by the one
 *  shared tokenizer (`shellWords`: backslashes stripped, split on whitespace, quotes, `=`, shell punctuation and `$`),
 *  so a shell wrapper (`sh -c "security … -s <svc>; true"`), a variable suffix (`<svc>$1`), a word naming an app key
 *  file (`k-<12 hex>.key`, round 4 L3),
 *  `--service=<svc>` and a command substitution are all seen. A longer word that merely starts with the service
 *  (`<svc>-backup`, `<svc>/k1`) is another item.
 *  ⚠ UNDECIDABLE, stated rather than guessed: a service reached only through indirection — a shell variable
 *  (`-s "$SVC"`), a helper script that names it inside, an alias — cannot be seen in the argv, so such a command
 *  is not recognised as app-owned. ⚠ Nor is a command that names NO item at all: a selector-less
 *  `find-generic-password -w` (the first generic password the search order finds, which may be an app key) or a
 *  `dump-keychain -d` (every item). Neither names the service or an app key id, so the predicate cannot tell. */
function namesAppService(argv: readonly string[]): boolean {
  const words = argv.flatMap(shellWords);   // the one shared tokenizer (L5), the spawn guard's too
  if (words.some((t) => t.toLowerCase() === SERVICE_TOKEN || JOINED_SERVICE_RE.test(t))) return true;
  // Round 4 L3: a command that READS an app key file (`cat <keys>/k-….key`, or the same in a shell string).
  if (words.some((t) => KEY_FILE_WORD_RE.test(t))) return true;
  // L6: a `find-generic-password` that selects an app key by its ACCOUNT (`-a k-<12 hex>`, the id the app writes)
  // reads an app-owned key too, whatever service it names.
  if (!words.some((t) => t.toLowerCase() === "find-generic-password")) return false;
  return words.some((t, i) => (KEY_ID_ANYCASE_RE.test(t) && ACCOUNT_FLAG_RE.test(words[i - 1] ?? "")) || JOINED_ACCOUNT_RE.test(t));
}
/** An app key id (src/keyFile.ts `KEY_ID_SOURCE`) joined behind a short-flag cluster ending in `a` (`-ak-…`, `-wak-…`);
 *  alone it is `KEY_ID_ANYCASE_RE`. Both CASE-INSENSITIVE on purpose (B11): ownership detection fails closed. These two
 *  serve OWNERSHIP only (`namesAppService`); which id a command names is `commandKeyIds`' own, far narrower rule. */
const JOINED_ACCOUNT_RE = new RegExp(`^-[A-Za-z]*a(${KEY_ID_SOURCE})$`, "i");
/** A short-flag cluster ending in `a` (`-a`, `-wa`): the next word is its account operand. */
const ACCOUNT_FLAG_RE = /^-[A-Za-z]*a$/;

/** The app key id an app-owned key command NAMES (P3-M1-T0), lowercase — or `[]`. PR 3 final, the second post-cap fix
 *  (N1, the third recurrence of r4 A1 and r5 A1): an id is named ONLY by a command whose argv is exactly the shape
 *  `appKeyCommand` writes (src/keyStore.ts) — `<bin> find-generic-password -s <service> -a <id> -w <keychain>`, eight
 *  elements, the id at [5] — whatever the binary's spelling, with an absolute keychain path (`isCanonicalKeyCommand`). That argv
 *  goes to the tool as a vector (`Bun.spawn`, src/proc.ts); no shell reads any element of it, so its id is the item
 *  read. ANY other command names no id: no shell text, wrapper, joined flag, other flag order, extra or missing element,
 *  or key file word inside a command is read for one. Three readers of shell text leaked in turn (a blacklist of
 *  separators, an allowlist with a getopt table, then text re-read by a nested `eval` or `sh -c`): a reader that must
 *  equal a shell is the bug, so there is none. `[]` reports `appOwnedKey` without `appKeyId`, which the app treats as
 *  "may reference ANY app key" — the safe direction for the matcher that decides whether a key is unreferenced
 *  (P3-M4-T3). ⚠ THE COST, accepted: a command the user wrapped by hand (`sh -c '…'`, `… | tr -d '\n'`,
 *  `env security …`) or joined (`-a<id>`) names no id, so while such an entry exists every delete that asks whether a
 *  key is unreferenced (Remove's above all) keeps every app key; an Uninstall removes them. The app writes only the canonical argv on macOS (and an
 *  `apiKeyFile` elsewhere, read by the file rule, not here). Ownership itself (`namesAppService`) is unchanged. */
function commandKeyIds(argv: readonly string[]): string[] {
  return isCanonicalKeyCommand(argv) ? [argv[5]!.toLowerCase()] : [];
}

/** Is this argv exactly the shape `appKeyCommand` writes (src/keyStore.ts): eight elements, [1]–[4] and [6] those
 *  words exactly, an app key id (any case) at [5], and an ABSOLUTE keychain path at [7] (`resolveKeychain` only ever
 *  names one, src/keyStore.ts); the binary [0] any spelling. The keychain must start with `/` because `security`'s
 *  getopt reads on past `-w`: a dash-led [7] (`-ak-…`, `-wak-…`) is a second account selector, and the item read is
 *  then not [5]'s (scoped review 2, F1). `validateConfig` already refuses an empty element (src/config.ts). */
function isCanonicalKeyCommand(argv: readonly string[]): boolean {
  return argv.length === 8 && argv[1] === "find-generic-password" && argv[2] === "-s" && argv[3] === APP_KEY_SERVICE
    && argv[4] === "-a" && KEY_ID_ANYCASE_RE.test(argv[5]!) && argv[6] === "-w" && argv[7]!.startsWith("/");
}

/**
 * Is this entry's key one the desktop app stores (spec r9 §6)? The ONE predicate for the runtime rule
 * (P1-M6-T3), `provider test` and `config validate` (PR 2). An app-owned key must never travel in cleartext, and a
 * key the app does NOT own must not be refused for it either: a false positive refuses an existing config on every
 * tick (hub Q26 corrects Q19's "it only costs an https requirement", which was false — a LAN model over `http:`
 * with `apiKeyFile: "ollama.key"` was refused).
 *   • A key command is app-owned by its SERVICE, whatever the binary: after splitting each argv element on
 *     whitespace, quotes and `=`, a token equal to `APP_KEY_SERVICE` (case-insensitively — whether the
 *     Keychain matches service names that way is unverified, so the ambiguous case goes strict), or a
 *     short-flag cluster of any letters joined to it (`-s<svc>`, `-ws<svc>`, `-l<svc>`); or a word naming an app key
 *     file (`k-<12 hex>.key`); or a `find-generic-password` that
 *     selects an app key id as its account (`-a k-<12 hex>`, L6). The binary is not judged —
 *     `security` through PATH, `/usr/bin/Security` (the same file on APFS), `/usr/bin/../bin/security` and a
 *     `sh -c` wrapper all reach the real tool.
 *   • A key FILE (hub Q26): a relative path is resolved against the process cwd, exactly as the reader opens it;
 *     then (1) without a `..` segment, its canonical form strictly inside the canonical `<state>/keys/`, or (for an
 *     existing file) its realpath inside the folder's, is app-owned; (2) otherwise — a `..` segment, or a path the
 *     lexical tests call outside — it is app-owned iff `stat` (following symlinks, as the kernel opens it) gives the
 *     same (dev, ino) as a regular file anywhere under `<state>/keys/` (walked without following symlinks). That
 *     catches the `..` symlink alias (codex HIGH) and a hard link. `keys/` missing, or the file missing or
 *     unstattable → not app-owned (the read then fails exactly as it does today); a walk of `keys/` that cannot
 *     complete → app-owned (fail closed). The file rule is `appKeyFileRelation` (src/keyFile.ts), which the morning
 *     `apiKeyFile` rung shares (P2-M5-T1).
 * Any reader opens the ORIGINAL path, never a resolved one. `keys` defaults to `keysDir()`.
 * ⚠ SYNCHRONOUS — a NAMED RESIDUAL (PR 2 final harden round 3, M1). The file rule runs on the sync shell (src/keyFile.ts
 * "Two shells") because every caller is synchronous: the run's `insecureEndpoint` (src/core.ts), `provider test`'s
 * step 1 (before its deadline is armed) and `config validate`'s plain-`http:` error (src/json.ts). A stat or `keys/`
 * walk stalled on a dead mount therefore blocks the event loop here, and no deadline can cut it. Bounded by
 * `appKeyOverCleartext`'s order on all three: only a plain-`http:` NON-loopback entry with an `apiKeyFile` reaches it —
 * an https or loopback entry never does. `config validate`'s `appOwnedKey` / `appKeyId` rows (P3-M1-T0), which judge
 * EVERY `apiKeyFile` entry, do NOT run it: they run the same steps on the async shell under a 2 s total deadline
 * (`appKeyOwnershipBounded`, P3-M1-T1 checkpoint MED), and `doctor` reports no rows, so it judges none. Who bounds the
 * residual from outside, stated rather than assumed: every `config validate` the app runs goes through
 * gui/src-tauri/src/config_save.rs — the settings save, the saved-settings report the pending resets and Uninstall
 * read (`read_saved_with_report`), and the webview's candidate check (`provider_candidate_check`) — and each is
 * bounded there at 30 s (`ENGINE_READ_TIMEOUT`); the webview has had no `config validate` command of its own since
 * PR 3 final r1. `engine_doctor` still runs with NO bound (gui/src-tauri/src/engine.rs `Operation::timeout` → `None`),
 * so a stall reached there is waited out. The morning `apiKeyFile` rung, which every `apiKeyFile` reaches, runs the same rule on the
 * async shell.
 */
export function isAppOwnedKey(entry: ListEntry, keys: string = keysDir()): boolean {
  return keyOwnership(entry, keys, false).owned;
}

/**
 * `isAppOwnedKey`'s ONE decision, with the app key id it found (P3-M1-T0: `config validate`'s `appKeyId` /
 * `appOwnedKey`, which the app's `entries_referencing_key` and its uninstall refusal read instead of matching the two
 * canonical reference shapes themselves — plan hub "PR 3 start"). `owned` IS the predicate above (`keyOwnership`, the
 * one body both read). `id`, only when `owned`: the one app key id the entry's references name, LOWERCASE (the store's
 * own form — detection is case-insensitive, B11). EVERY reference counts here — an app-owned `apiKeyCommand` AND an
 * app-owned `apiKeyFile` beside it — because the app asks "does ANY reference name this key?", not which one the
 * ladder reads. Absent when no single id can be named: a command naming the service but no id (`pass show <svc>`, a
 * selector-less `find-generic-password -s <svc>`), or two different ids anywhere in the entry; a key file under `keys/`
 * not named `<id>.key`; a walk of `keys/` that could not complete (`unknown`, owned by fail-closed).
 * A key command names an id ONLY when its argv is exactly the shape the app writes (`commandKeyIds`:
 * `<bin> find-generic-password -s <service> -a <id> -w <keychain>`); any other app-owned command — a shell wrapper,
 * a joined flag, another order, a `cat <keys>/<id>.key` — names none.
 * ⚠ SYNCHRONOUS, as `isAppOwnedKey` (above) — `config validate` does not call this one: it runs the same steps on the
 * async shell under a deadline (`appKeyOwnershipBounded`); this sync form serves in-process callers (`validateCandidate`).
 */
export function appKeyOwnership(entry: ListEntry, keys: string = keysDir()): KeyOwnership {
  return keyOwnership(entry, keys, true);
}

/** An ownership answer: `owned` is the predicate, `id` the one app key id named (only when `owned`). */
export type KeyOwnership = { owned: boolean; id?: string };

/** The ownership rule's one body, on the sync shell. */
function keyOwnership(entry: ListEntry, keys: string, everyReference: boolean): KeyOwnership {
  return runFsSync(keyOwnershipSteps(entry, keys, everyReference));
}

/** The ownership rule's one body, as steps (src/strictFile.ts "PATH STEPS": one table, two runners — the sync
 *  `keyOwnership` above and `appKeyOwnershipBounded` below). `everyReference` false (`isAppOwnedKey`): stop at the first
 *  app-owned reference — the predicate's steps exactly as before P3-M1-T0, an app-owned key command never stats the
 *  `apiKeyFile` beside it. True (`appKeyOwnership`): also judge that `apiKeyFile`, so its id is counted; `owned` is the
 *  same either way. */
function* keyOwnershipSteps(entry: ListEntry, keys: string, everyReference: boolean): FsSteps<KeyOwnership> {
  const api = entry.provider.api;
  if (api === undefined) return { owned: false };
  const ids = new Set<string>();
  let owned = false;
  let unnamed = false;                                        // an app-owned reference that names no id
  const argv = api.apiKeyCommand;
  if (argv !== undefined && namesAppService(argv)) {
    if (!everyReference) return { owned: true };
    owned = true;
    const found = commandKeyIds(argv);
    if (found.length === 0) unnamed = true;
    for (const id of found) ids.add(id);
  }
  const given = api.apiKeyFile;
  if (given !== undefined) {
    // The file rule lives in src/keyFile.ts, shared with the morning `apiKeyFile` rung (P2-M5-T1). A walk of keys/ that
    // cannot complete (`unknown`) FAILS CLOSED here (PR 1 final review round 2, L2): app-owned.
    const f = yield* appKeyFileOwnershipSteps(given, keys);
    if (f.relation !== "not-app-key") {
      owned = true;
      if (f.id === undefined) unnamed = true; else ids.add(f.id);
    }
  }
  if (!owned) return { owned: false };
  return !unnamed && ids.size === 1 ? { owned: true, id: [...ids][0]! } : { owned: true };
}

/** The total time `config validate` gives its ownership rows (P3-M1-T1 checkpoint MED): 2 s, well inside the app's
 *  30 s bound on the save path's `config validate` (`ENGINE_READ_TIMEOUT`, gui/src-tauri/src/shell.rs). */
export const KEY_OWNERSHIP_REPORT_DEADLINE_MS = 2_000;

/**
 * `appKeyOwnership` for every entry, on the ASYNC shell under ONE total deadline (P3-M1-T1 checkpoint MED) — what
 * `config validate --json`'s `providers` rows report. The same steps as the sync predicate (`keyOwnershipSteps`), so the
 * rules cannot fork; only the runner differs. A stat or `keys/` walk stalled on a dead mount then waits on the thread
 * pool, not the event loop, and an entry not decided by the deadline FAILS CLOSED: `{ owned: true }` with no id (the
 * app treats it as possibly referencing ANY app key). An entry that needs no filesystem answer (no `apiKeyFile`) is
 * decided at once. The abandoned steps finish into nothing; the command exits through `process.exit`. Never throws;
 * `fs` and `deadlineMs` are injected only by tests.
 */
export async function appKeyOwnershipBounded(
  entries: readonly ListEntry[],
  opts: { keys?: string; fs?: AsyncFsOps; deadlineMs?: number } = {},
): Promise<KeyOwnership[]> {
  const keys = opts.keys ?? keysDir();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), opts.deadlineMs ?? KEY_OWNERSHIP_REPORT_DEADLINE_MS); });
  try {
    return await Promise.all(entries.map(async (e): Promise<KeyOwnership> => {
      const r = await Promise.race([runFsAsync(keyOwnershipSteps(e, keys, true), opts.fs), deadline]);
      return r === "timeout" ? { owned: true } : r;
    }));
  } finally { clearTimeout(timer); }
}

/** The endpoint an APP-OWNED key would travel over in cleartext — plain `http:` to a non-loopback host
 *  (`cleartextRemote`) for an entry whose key `isAppOwnedKey` — else undefined (B5). The ONE composition of the two
 *  predicates, for the run's refusal (src/core.ts `insecureEndpoint`) and `config validate`'s error (src/json.ts). The
 *  endpoint FIRST (PR 1 final review round 2, L3): ownership is a synchronous stat and a `keys/` walk, so only a
 *  non-loopback `http:` entry pays it. */
export function appKeyOverCleartext(entry: ListEntry, keys?: string): URL | undefined {
  const api = entry.provider.api;
  if (api === undefined) return undefined;
  const u = cleartextRemote(api);
  if (u === undefined) return undefined;
  return isAppOwnedKey(entry, keys) ? u : undefined;
}

/**
 * The walk's network probe set (provider fallback, P1-M6-T1; spec r9 §5). A SINGLE-entry list keeps today's
 * derivation exactly: `networkProbeHosts`, else the API endpoint's own host (`[]` for a loopback one, disabling the
 * gate), else the anycast defaults. For TWO OR MORE: `networkProbeHosts` (or the anycast defaults) PLUS each remote
 * API entry's endpoint host, so a reachable provider counts as online even where anycast is blocked; CLI and
 * loopback entries add none, and a loopback entry never disables the gate. A list of ONLY loopback entries with no
 * configured hosts disables it, as a single loopback item 1 does; an explicit `[]` disables it.
 */
export function walkProbeHosts(cfg: Config, list: ProviderList): { hosts: ProbeHost[]; warning?: string } {
  if (list.entries.length < 2) {
    return resolveProbeHosts(
      cfg.networkProbeHosts,
      (cfg.provider.api !== undefined ? deriveProbeHosts(cfg.provider.api) : undefined) ?? DEFAULT_NETWORK_PROBE_HOSTS,
    );
  }
  const allLoopback = list.entries.every((e) => e.isLoopback);
  const base = resolveProbeHosts(cfg.networkProbeHosts, allLoopback ? [] : DEFAULT_NETWORK_PROBE_HOSTS);
  if (Array.isArray(cfg.networkProbeHosts) && cfg.networkProbeHosts.length === 0) return base;   // the explicit off switch
  const remote = list.entries.flatMap((e) => (e.provider.api !== undefined && !e.isLoopback ? deriveProbeHosts(e.provider.api) ?? [] : []));
  const hosts: ProbeHost[] = [];
  for (const h of [...base.hosts, ...remote]) if (!hosts.some((x) => x.host === h.host && x.port === h.port)) hosts.push(h);
  return base.warning !== undefined ? { hosts, warning: base.warning } : { hosts };
}

/** The combined list in list order, each dropped entry in its `fallbacks` position (a whole-list drop last) — the one
 *  ordering `CoreResult.attempts` and the status and doctor provider rows share (L8). PURE; stable, so item 1's logins
 *  keep their order. */
export function listOrder(list: ProviderList): ({ entry: ListEntry } | { dropped: DroppedEntry })[] {
  const rows: { order: number; item: { entry: ListEntry } | { dropped: DroppedEntry } }[] = [];
  for (const e of list.entries) rows.push({ order: e.source === "provider" ? -1 : e.fallbackIndex!, item: { entry: e } });
  for (const d of list.dropped) rows.push({ order: d.index ?? Number.MAX_SAFE_INTEGER, item: { dropped: d } });
  return rows.sort((a, b) => a.order - b.order).map((r) => r.item);
}

/** A dropped entry's name for a row: its label, or its `fallbacks` position. */
export const droppedLabel = (d: DroppedEntry): string => d.label ?? (d.index !== undefined ? `fallbacks[${d.index}]` : "fallbacks");
