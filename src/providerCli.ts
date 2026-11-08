// src/providerCli.ts — `daily-briefing provider …` (provider-fallback plan P2-M1; spec r9 §4 "Indexes", §5 "One writer
// at a time", §6 "Engine operations"). Loaded by `dispatch` with a dynamic import, as `calendar` is, so no other
// command pays for it.
//
//   provider key set | key migrate --index <n> | key delete --id <keyId> | key delete-all | key scrub-backup
//   provider reset (--index <n> | --label-stdin)
//   provider test --file <candidate.json> --index <n>
// each with `--json`, which is REQUIRED: there is no human-readable form (the `status`/`doctor` rule).
//
// ⚠ A LABEL NEVER TRAVELS IN ARGV (hub Q20; spec §4 "never used as … an argv operand"). `reset --label-stdin` reads
// `{"label": "…"}` from stdin, modelled on `config validate --stdin`: a label is any non-empty string, and `dispatch`
// reads `-h`/`--help`/`-v`/`--version` ANYWHERE in argv as help or version, so a label spelled like one could never
// reach this file as an operand. Stdin is read before anything else is touched, and a TTY stdin is refused.
//
// ⚠ NO OUTPUT ECHOES A LABEL, A FLAG VALUE OR A CONFIG VALUE. A label is user text that may itself be a key or a
// private link (hub Q25), and the validator's own messages can quote config values; every refusal below is fixed text
// plus flag names and counts — and one path: a missing saved config is "no config at <config path>" (`listAt`,
// `readForScrub`), the config file's own location, never a value inside it.
//
// Answers (stdout, one JSON line): `{schemaVersion: 1, ok: true, …}` on success, else
// `{schemaVersion: 1, ok: false, code, error}` with the same text on stderr. `code` is what the app switches on:
//   usage      the argv or the stdin payload is malformed (a key outside the key rule, or a bad `--id`, also carries
//              `reason: "invalid-key"` / `"invalid-id"`, as the store's own refusal would — A2)    exit 2
//   config     the saved config is missing or invalid, or the target does not resolve in it       exit 2
//              (or, for `key migrate`, the entry holds nothing it can migrate — see `keyMigrate`, its literal
//              outside the key rule carrying `reason: "invalid-key"` — as does `test`'s tested entry whose literal,
//              trimmed, holds whitespace or a control character, refused before the probe (P3-M4-T4); for `key
//              scrub-backup`, the settings backup
//              cannot be read as one, or changed meanwhile — see `keyScrubBackup`; a read timing out — `key
//              scrub-backup`'s, `key migrate`'s and `reset`'s config read, `test`'s candidate read — is `config` with
//              `reason: "timeout"` — retry)
//   lock-held  a briefing holds the run lock — retry later (`reset` only; `test` answers ok with `recorded: false`
//              and `notRecorded: "lock-held" | "write-failed"` — see `applyTestOutcome`)              exit 3
//   write-failed  the state file, the key store, or (`key scrub-backup`) the settings backup could not be written  exit 1
// A key verb's `write-failed` also carries `reason` (the store's own `KeyFailReason`; `timeout` is the same on both
// platforms, and the app words it per platform — macOS "unlock your keychain, then retry", elsewhere "the key folder
// did not answer in time — retry"), `cleanup` when a failed `key set` had something to remove, `keyId` when what it
// stored is unconfirmed (`unconfirmed`: a `failed` / `timeout` cleanup, or any cleanup after a `timeout` — the app
// retries `key delete --id` with it; never a secret — absent when the store gave none: a file-store name found taken,
// r2 M1, src/keyStore.ts `fileSetAttempt`), and `deleted` for `delete-all` — on a timeout, a LOWER BOUND
// (src/keyStore.ts `fileKeyDeleteAll` / `keychainDeleteAll`). No answer at all on stdout is a crash, never a refusal.
//
// ⚠ THE KEY VERBS (P2-M2-T3; spec r9 §4, §6). `key set` reads the key on STDIN — never argv, which every process on the
// machine can read; a TTY stdin is refused — bounded in bytes (`KEY_STDIN_MAX_BYTES`) and, with the dead-pid sweep, in
// time (`KEY_PRE_STORE_MS`), so the pre-store work plus the store's own worst case (src/keyStore.ts: 10 s deadline + 3 s
// cleanup) is 14 s — the app's 19 s `key set` timeout less its 5 s margin (spec r9 §6). The store builds the
// reference (`apiKeyCommand` | `apiKeyFile`), so this file never names the Keychain tool, and it NEVER hands the
// store an exec: production leaves `KeyStoreDeps.exec` undefined, so every Keychain call goes through the store's
// backstopped default (checked by isolation.meta: no src/ file using the store imports proc's `run`). The secret is
// never printed: every message is the store's fixed text or this file's. `key migrate` (P2-M3-T1) takes the key from the SAVED config's literal `apiKey`
// instead of stdin and then makes the very same store call (`storeKey`); its config read and the sweep share the same
// `KEY_PRE_STORE_MS`, so its worst case is `key set`'s — except that `within` bounds only the async read: the
// synchronous `existsSync` that list resolution makes on each login's `configDir` (src/config.ts `resolveAccounts`)
// would block on a hung mount, and nothing here can cut it. It never writes the config. `key scrub-backup` (P2-M3-T2)
// is the one verb that writes beside the config: it removes from `<config>.bak` the literal keys the saved config no
// longer holds (`keyScrubBackup`), and reaches no key store.
//
// ⚠ ONE WRITER AT A TIME (spec r9 §5; hub Q16). `reset` and `test` write `account-state.json` and
// `provider-status.json`, as the walk does, so each writes only while holding the run lock (invoker `cli`): `reset` for
// its whole read-modify-write, refusing while a briefing holds it; `test` only to re-read, apply and write — its probe
// runs UNLOCKED, because a loopback Test can last 30 minutes and a lock held that long would make every scheduled tick
// skip as `concurrent`. `test` retries the lock for `TEST_LOCK_RETRY_MS`, then returns its outcome unrecorded. A
// scheduled tick that meets either lock skips as `concurrent`, as it does for a manual run. Each heartbeats while it
// holds the lock (`acquireRunLock`'s), capped at its own bound — with today's 30 s interval and these bounds the cap
// comes first, so in practice no touch happens and the lock is simply never held long enough to go stale.
import { homedir } from "node:os";
import { constants as fsc } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { configPath, validateConfig } from "./config";
import { markReason, PROBE_MS, removeMark } from "./account";
import { entryRevision, escapeRe, resolveProviderList, type ListEntry, type ProviderList } from "./providerList";
import { observeTest, readProviderStatus, writeProviderStatus, type Observation } from "./providerStatus";
import { acquireRunLock, runLockInputs, runLockPath, type LockHeld } from "./runlock";
import { API_TIMEOUT_MS, defaultTimeoutMs } from "./provider";
import { stripControl } from "./render";
import { cleartextRemote } from "./providers/endpoint";
import { ProviderError, type Config } from "./types";
import { failoverReason, type EntryKind, type FailoverReason } from "./failover";
import { insecureEndpoint } from "./core";
import { buildProvider } from "./providerFactory";
import { ApiTransport } from "./providers/base";
import { apiAttemptBoundMs, PROBE_LOOPBACK_MAX_TIMEOUT_MS, PROBE_REMOTE_TIMEOUT_MS, probeTimeoutMs } from "./attemptBounds";
import { KILL_GRACE_MS } from "./provider";
import type { run } from "./proc";
import type { AsyncFsOps } from "./strictFile";
import {
  appKeyDelete, appKeyDeleteAll, appKeySet, INVALID_KEY_MESSAGE, KEY_ID_RE, normalizeKey, sweepDeadPidFiles, sweepDeadTemps, TIMED_OUT, within,
  type AppKeyDeps, type Cleanup, type KeyFailReason,
} from "./keyStore";

export type ProviderCliDeps = {
  /** Defaults to `configPath()`. */
  configFile?: string;
  /** Defaults to `homedir()`. */
  home?: string;
  /** The environment the combined list is resolved under. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Stdin, read to its end or to just past `maxBytes` (the caller refuses anything longer). Defaults to
   *  `readStdinBounded(maxBytes)`. */
  readStdin?: (maxBytes: number) => Promise<string>;
  /** Is stdin a terminal? Defaults to `process.stdin.isTTY`. A TTY stdin is refused for `--label-stdin` and `key set`. */
  isTTY?: boolean;
  /** TEST seam: the key store's (src/keyStore.ts `AppKeyDeps`: platform, a fake exec, the key folder, the bounds…).
   *  ⚠ PRODUCTION LEAVES IT UNDEFINED: an `exec` here replaces the store's backstopped default (P2-M2-T2 carried 4). */
  keyStore?: AppKeyDeps;
  /** TEST seam over `KEY_PRE_STORE_MS`. */
  preStoreMs?: number;
  /** TEST seam: the saved config's text, or undefined when there is none. Default `readConfigText` (a stalled read
   *  is how `key migrate`'s pre-store bound over the config load is observed). */
  readConfig?: (file: string) => Promise<string | undefined>;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** TEST seams for the run lock's heartbeat (`acquireRunLock`'s own). */
  heartbeatTimers?: LockOpts["heartbeatTimers"];
  heartbeatNow?: () => number;
  /** TEST seam: runs inside the critical section, right after the run lock is taken and before the read-modify-write. */
  underLock?: () => Promise<void>;
  /** TEST seam over `SCRUB_READ_MS`. */
  scrubReadMs?: number;
  /** TEST seam over `PROVIDER_RESET_READ_MS`. */
  resetReadMs?: number;
  /** TEST seam over `TEST_CONFIG_READS_MS` (the candidate read and the saved-config read share it). */
  configReadsMs?: number;
  /** TEST seam: runs inside `key scrub-backup`'s write, after the scrubbed copy is staged and durable and before the
   *  identity re-check and the rename over `.bak` (config_save.rs's `before_rename`, the same shape). */
  beforeBackupRename?: () => Promise<void>;
  /** TEST seam: runs inside `test`'s apply, after its status write and before its mark clear. */
  afterStatusWrite?: () => Promise<void>;
  /** `provider test`'s probe of one entry: the key read and the one request. It runs UNLOCKED and must write nothing.
   *  Defaults to `probeEntry` (P2-M4-T1); tests of the lock and the apply inject their own. */
  probe?: (entry: ListEntry, cfg: Config) => Promise<ProbeOutcome>;
  /** TEST seam: the exec the key ladder's command rung uses (`RunDeps.keyExec`'s twin), so a test whose candidate holds
   *  an app-owned key command never reaches the real Keychain. Production leaves it unset: the configured command runs,
   *  exactly as a morning run runs it. */
  keyExec?: typeof run;
  /** TEST seam: the filesystem the key ladder's key-folder test runs on (`resolveApiKey`'s `keyFileFs` — a stalled mount,
   *  final harden round 3 M1). Production leaves it unset: `fs/promises`, exactly as a morning run. */
  keyFileFs?: AsyncFsOps;
  /** TEST seam: the API transports' fetch. Production leaves it unset (the global `fetch`). */
  fetchImpl?: typeof fetch;
  /** TEST seam over the probe's whole-Test deadline (`probeDeadlineMs`). */
  testDeadlineMs?: number;
  /** The instant a Test's outcome is stamped at, read when the probe finishes (hub Q22). Defaults to the real clock. */
  now?: () => Date;
  /** The clock and sleep `test`'s lock retry runs on. Default `Date.now` and `Bun.sleep`. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type LockOpts = Parameters<typeof acquireRunLock>[0];

/** `reset`'s engine bound — the app's 15 s operation timeout less its 5 s margin (spec r9 §6) — and so its heartbeat
 *  cap. WHAT IS RACED (C2 / A5, B10): the label's stdin read (`KEY_PRE_STORE_MS`, 1 s) and the saved config's read
 *  (`PROVIDER_RESET_READ_MS`, 5 s, the stdin read included). The locked read-modify-write after them — the lock's own
 *  create, the marks file's read and rewrite — is plain local-file I/O and is NOT raced: a raced write would go on
 *  after the answer and could be cut by the process exit with the run lock held (`key scrub-backup`'s rule). */
export const PROVIDER_RESET_BOUND_MS = 10_000;
/** The bound on `reset`'s READS — stdin, then the saved config — inside `PROVIDER_RESET_BOUND_MS`. Past it: `config`,
 *  `reason: "timeout"` (retry), and nothing is locked or written. */
export const PROVIDER_RESET_READ_MS = 5_000;
/** The bound of `test`'s locked read-modify-write — never the Test's own (spec r9h) — and so its heartbeat cap. */
export const PROVIDER_TEST_WRITE_BOUND_MS = 5_000;
/** How long `test` keeps retrying a held run lock before returning its outcome with `recorded: false` (spec r9h). */
export const TEST_LOCK_RETRY_MS = 5_000;
/** The retry's poll interval. */
export const TEST_LOCK_POLL_MS = 250;

type Ctx = Required<Pick<ProviderCliDeps, "configFile" | "home" | "env" | "out" | "err">> & ProviderCliDeps;

export type FailCode = "usage" | "config" | "lock-held" | "write-failed";
const EXIT: Record<FailCode, number> = { usage: 2, config: 2, "lock-held": 3, "write-failed": 1 };

const USAGE = "usage: daily-briefing provider key set | key migrate --index <n> | key delete --id <keyId> | key delete-all | key scrub-backup | reset (--index <n> | --label-stdin) | test --file <candidate.json> --index <n>  (each with --json)";

/** The largest stdin payload `--label-stdin` reads: `{"label": …}` is tiny, and anything this size is not one. */
export const LABEL_STDIN_MAX_BYTES = 64 * 1024;

function fail(c: Ctx, verb: string, code: FailCode, msg: string, extra: Record<string, unknown> = {}): number {
  c.out(JSON.stringify({ schemaVersion: 1, ok: false, code, error: `${verb}: ${msg}`, ...extra }));
  c.err(stripControl(`provider ${verb}: ${msg}`));
  return EXIT[code];
}

// ── the grammar ──────────────────────────────────────────────────────────────────────────────────────

type Flags = { values: Map<string, string>; bools: Set<string> };
type Verb = { valued: readonly string[]; bools: readonly string[]; run: (f: Flags, c: Ctx) => Promise<number> };

/** A flag-shaped name, the only argv token ever echoed (A4): lowercase letters and dashes behind one or two dashes. */
const ECHOABLE_FLAG_RE = /^--?[a-z][a-z-]*$/;

/** A flag's value or argv operand is never echoed: only an unknown token's NAME (before any `=`), and only when it is
 *  plainly flag-shaped (`ECHOABLE_FLAG_RE`) — anything else, a key-shaped `-sk-ant-…` included, is "(an argument)". */
function parseFlags(args: readonly string[], v: Verb): Flags | { error: string } {
  const out: Flags = { values: new Map(), bools: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (v.valued.includes(a)) {
      const val = args[i + 1];
      if (val === undefined || val.startsWith("--")) return { error: `${a} needs a value` };
      if (out.values.has(a)) return { error: `${a} given twice` };
      out.values.set(a, val); i++;
    } else if (v.bools.includes(a)) {
      if (out.bools.has(a)) return { error: `${a} given twice` };
      out.bools.add(a);
    } else {
      const name = a.split("=", 1)[0]!;
      return { error: `unexpected argument ${ECHOABLE_FLAG_RE.test(name) ? name : "(an argument)"}` };
    }
  }
  return out;
}

const VERBS: Readonly<Record<string, Verb>> = {
  "key set": { valued: [], bools: [], run: (_f, c) => keySet(c) },
  "key migrate": { valued: ["--index"], bools: [], run: (f, c) => keyMigrate(f, c) },
  "key delete": { valued: ["--id"], bools: [], run: (f, c) => keyDelete(f, c) },
  "key delete-all": { valued: [], bools: [], run: (_f, c) => keyDeleteAll(c) },
  "key scrub-backup": { valued: [], bools: [], run: (_f, c) => keyScrubBackup(c) },
  "reset": { valued: ["--index"], bools: ["--label-stdin"], run: (f, c) => reset(f, c) },
  "test": { valued: ["--file", "--index"], bools: [], run: (f, c) => testVerb(f, c) },
};

export async function providerMain(args: string[], deps: ProviderCliDeps = {}): Promise<number> {
  const c: Ctx = {
    ...deps,
    configFile: deps.configFile ?? configPath(), home: deps.home ?? homedir(), env: deps.env ?? process.env,
    out: deps.out ?? ((s) => console.log(s)), err: deps.err ?? ((s) => console.error(s)),
  };
  const jsonCount = args.filter((a) => a === "--json").length;
  const rest = args.filter((a) => a !== "--json");
  const name = rest[0] === "key" && rest[1] !== undefined && !rest[1].startsWith("-") ? `key ${rest[1]}` : rest[0];
  // OWN keys only: a plain object's prototype answers `constructor`, `__proto__`, `toString`… (P2-M1 checkpoint LOW).
  const verb = name !== undefined && Object.hasOwn(VERBS, name) ? VERBS[name] : undefined;
  if (verb === undefined) {
    // A SENTINEL in the verb's place (final harden round 3, L5), so the lines read `provider (no verb): …` — never
    // `provider provider: …` — and the token itself is never echoed (it could be a key typed in the wrong place).
    return name === undefined
      ? fail(c, "(no verb)", "usage", `a verb is required — ${USAGE}`)
      : fail(c, "(unknown verb)", "usage", `not a provider verb — ${USAGE}`);
  }
  if (jsonCount !== 1) return fail(c, name!, "usage", jsonCount === 0 ? "--json is required (there is no human-readable form of this command)" : "--json given twice");
  const parsed = parseFlags(rest.slice(name!.split(" ").length), verb);
  if ("error" in parsed) return fail(c, name!, "usage", parsed.error);
  return verb.run(parsed, c);
}

// ── the saved config's combined list ─────────────────────────────────────────────────────────────────

/** The combined list of the config at `file`, or a refusal. Read raw and validated with `validateConfig`, the
 *  function `loadConfig` calls, so the list is the one a run would walk. The validator's message is NOT echoed: it can
 *  quote a config value (a key, a private link). */
async function listAt(c: Ctx, file: string, what: "saved config" | "candidate"): Promise<{ cfg: Config; list: ProviderList } | { error: string }> {
  let text: string | undefined;
  try { text = await (c.readConfig ?? readConfigText)(file); } catch { text = ""; }   // unreadable: refused as not JSON
  if (text === undefined) return { error: what === "saved config" ? `no config at ${file} — run \`daily-briefing init\`` : "the candidate file does not exist" };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { error: `the ${what} could not be read as JSON` }; }
  try { const cfg = validateConfig(raw, c.home); return { cfg, list: resolveProviderList(cfg, c.home, c.env) }; }
  catch { return { error: `the ${what} is not valid — run \`daily-briefing config validate --json --file <it>\` for the reason` }; }
}

/** A config file's text, or undefined when it does not exist. Read-only: nothing here ever writes a config. */
async function readConfigText(file: string): Promise<string | undefined> {
  const f = Bun.file(file);
  if (!(await f.exists().catch(() => false))) return undefined;
  return f.text();
}

/** The run lock's staleness inputs (src/runlock.ts `lockStaleMs`): from a config, `runLockInputs` — the very
 *  derivation a briefing's `run()` uses (B6), so this holder never reads a live briefing's lock as stale sooner than
 *  another briefing would. */
type LockInputs = Pick<LockOpts, "timeoutMs" | "recapCampaigns" | "calendar">;

/** The run lock, judged by `inputs`. */
function lockFor(inputs: LockInputs, capMs: number, c: Ctx): LockOpts {
  return {
    invoker: "cli", ...inputs,
    path: runLockPath(), heartbeatCapMs: capMs,
    ...(c.heartbeatTimers !== undefined ? { heartbeatTimers: c.heartbeatTimers } : {}),
    ...(c.heartbeatNow !== undefined ? { heartbeatNow: c.heartbeatNow } : {}),
  };
}

/** Is a held lock still ours, right before a write? A fail-open acquisition has nothing to lose (spec r9 §5). */
const stillOurs = async (lock: LockHeld): Promise<boolean> => lock.owned === "fail-open" || (await lock.stillOwns());

const DROPPED_REFUSAL = (n: number): string =>
  `the provider list has ${n} entr${n === 1 ? "y" : "ies"} that would be skipped at run time (see \`config validate\`) — fix ${n === 1 ? "it" : "them"} first`;

/**
 * Resolve a 0-based `--index` in the combined list AS WRITTEN (spec r9 §4 "Indexes"). PURE. Refused — so the engine and
 * the app can never count differently — when any entry would be dropped at run time, and when `provider.accounts` is
 * structurally broken (hub Q3: a broken list collapses item 1's logins to one entry, so the written list holds more
 * than the engine counts). `accounts` ignored beside an API item 1 does not refuse: both sides leave those logins out.
 * With nothing dropped, `entries` IS the written order: item 1's logins, then `fallbacks` in order.
 */
export function resolveIndex(list: ProviderList, n: number): { entry: ListEntry } | { error: string } {
  // STRUCTURAL (B7): the list's own flag (src/providerList.ts `accountsBroken`), never a match on a warning's wording.
  if (list.accountsBroken) return { error: '"provider.accounts" is broken (see `config validate`), so item 1\'s logins cannot be counted — fix it first' };
  if (list.dropped.length > 0) return { error: DROPPED_REFUSAL(list.dropped.length) };
  if (!Number.isSafeInteger(n) || n < 0 || n >= list.entries.length) {
    return { error: `--index is out of range — the list has ${list.entries.length} entr${list.entries.length === 1 ? "y" : "ies"} (0 to ${list.entries.length - 1})` };
  }
  return { entry: list.entries[n]! };
}

/** Resolve a label against the combined list. PURE. A dropped entry's label is refused as dropped; another label as
 *  unknown. Nothing is counted, so a dropped entry elsewhere does not refuse. The label is never echoed. */
export function resolveLabel(list: ProviderList, label: string): { entry: ListEntry } | { error: string } {
  const entry = list.entries.find((e) => e.label === label);
  if (entry !== undefined) return { entry };
  if (list.dropped.some((d) => d.label === label)) return { error: "that entry would be skipped at run time (see `config validate`) — fix it first" };
  return { error: "no entry in the saved provider list has that label" };
}

/** `--index <n>`: decimal digits only, so `-1`, `1.5` and `1e1` never parse as a position. */
function parseIndex(v: string): number | undefined {
  return /^\d{1,6}$/.test(v) ? Number(v) : undefined;
}

/** Stdin to its end, or — once past `maxBytes` — the bytes read so far: the reader is cancelled rather than drained, so
 *  an endless stdin cannot be read into memory (P2-M1 checkpoint LOW: bounded BEFORE the cap is checked). */
export async function readStdinBounded(maxBytes: number, stream: ReadableStream<Uint8Array> = Bun.stdin.stream()): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n <= maxBytes) {
      const r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      n += r.value.byteLength;
    }
    if (n > maxBytes) await reader.cancel().catch(() => undefined);
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Stdin as text, or a refusal: a terminal (`tty`), a failed read, or more than `maxBytes` (`tooLarge`). */
async function readStdinText(c: Ctx, maxBytes: number, tty: string, tooLarge: string): Promise<{ text: string } | { error: string }> {
  if (c.isTTY ?? Boolean(process.stdin.isTTY)) return { error: tty };
  let text: string;
  try { text = await (c.readStdin ?? readStdinBounded)(maxBytes); } catch { return { error: "could not read stdin" }; }
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { error: tooLarge };
  return { text };
}

/** `{"label": <non-empty string>}` from stdin, or a refusal. Read BEFORE anything else (hub Q20). */
async function readLabel(c: Ctx): Promise<{ label: string } | { error: string }> {
  const got = await readStdinText(c, LABEL_STDIN_MAX_BYTES, '--label-stdin reads {"label": …} from stdin, which is a terminal here', "stdin is too large to be a label");
  if ("error" in got) return got;
  const text = got.text;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { error: 'stdin must be JSON: {"label": "<label>"}' }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: 'stdin must be a JSON object: {"label": "<label>"}' };
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "label")) return { error: 'stdin may hold only "label"' };
  if (typeof o.label !== "string" || o.label === "") return { error: '"label" must be a non-empty string' };
  return { label: o.label };
}

// ── provider reset ───────────────────────────────────────────────────────────────────────────────────

/** `provider reset (--index <n> | --label-stdin) --json`: clears that entry's marks (spec r9 §6). */
async function reset(f: Flags, c: Ctx): Promise<number> {
  const index = f.values.get("--index");
  const byLabel = f.bools.has("--label-stdin");
  if ((index !== undefined) === byLabel) return fail(c, "reset", "usage", "pass exactly one of --index <n> or --label-stdin");
  const start = performance.now();
  let target: { index: number } | { label: string };
  if (byLabel) {
    // Bounded as `key set`'s stdin is (C2): a stdin that never closes cannot hold the verb.
    const got = await within(readLabel(c), c.preStoreMs ?? KEY_PRE_STORE_MS);
    if (got === TIMED_OUT) return fail(c, "reset", "usage", 'stdin did not end in time — write {"label": …}, then close stdin');
    if ("error" in got) return fail(c, "reset", "usage", got.error);
    target = got;
  } else {
    const n = parseIndex(index!);
    if (n === undefined) return fail(c, "reset", "usage", "--index must be a 0-based position (decimal digits)");
    target = { index: n };
  }
  // The saved config's read inside what is left of `PROVIDER_RESET_READ_MS` (A5), as `key migrate` races its own.
  const saved = await within(listAt(c, c.configFile, "saved config"), (c.resetReadMs ?? PROVIDER_RESET_READ_MS) - (performance.now() - start));
  if (saved === TIMED_OUT) return fail(c, "reset", "config", "the saved config could not be read in time — retry", { reason: "timeout" });
  if ("error" in saved) return fail(c, "reset", "config", saved.error);
  const resolved = "index" in target ? resolveIndex(saved.list, target.index) : resolveLabel(saved.list, target.label);
  if ("error" in resolved) return fail(c, "reset", "config", resolved.error);
  // The whole read-modify-write under the run lock, so a run that read the marks before it can never undo it.
  const lock = await acquireRunLock(lockFor(runLockInputs(saved.cfg), PROVIDER_RESET_BOUND_MS, c));
  if (!lock.acquired) return fail(c, "reset", "lock-held", "a briefing is running — try again in a minute");
  let cleared: boolean;
  try {
    await c.underLock?.();
    if (!(await stillOurs(lock))) return fail(c, "reset", "lock-held", "a briefing is running — try again in a minute");
    try { cleared = await removeMark(resolved.entry.label); }
    catch { return fail(c, "reset", "write-failed", "the marks file in the state folder could not be written"); }
  } finally { await lock.release(); }
  c.out(JSON.stringify({ schemaVersion: 1, ok: true, cleared }));
  return 0;
}

// ── provider key set | key delete | key delete-all ───────────────────────────────────────────────────

/** The most bytes `key set` reads from stdin: a key is at most 512 characters, plus whatever whitespace surrounds it. */
export const KEY_STDIN_MAX_BYTES = 4 * 1024;
/** The bound on what `key set` and `key delete-all` do BEFORE the store call — the stdin read and the dead-pid sweep
 *  share it (`key migrate`: its config read and the sweep) — so it plus the store's worst case stays inside the app's
 *  timeout less its 5 s margin (spec r9 §6; P2-M2-T2 checkpoint, carried item 5): `key set` / `key migrate` 1 + 10 + 3
 *  = 14 s (`KEY_OP_DEADLINE_MS` + `KEY_CLEANUP_MS`) of the app's 19 s; `key delete-all` 1 + 10 = 11 s of its 16 s. */
export const KEY_PRE_STORE_MS = 1_000;

/** The largest `config.json.bak` `key scrub-backup` reads: `.bak` holds a previous config's bytes, and the app never
 *  saves a config over `MAX_CONFIG_BYTES` (gui/src-tauri/src/config_save.rs:72, 1 MiB). */
export const BACKUP_MAX_BYTES = 1024 * 1024;

/** A cleanup whose answer leaves something of the failed set possibly on disk or in the Keychain. */
const unsure = (x: Cleanup | undefined): boolean => x === "failed" || x === "timeout";
/** …and a failed set whose `keyId` the app must retry `key delete --id` with: an unsure cleanup, or ANY cleanup after a
 *  `timeout` (A1) — a store call that timed out may still land after its cleanup looked (a Keychain add killed while
 *  the item was being written), so a `not-found` then is not proof. One rule for both platforms. */
const unconfirmed = (reason: KeyFailReason, x: Cleanup | undefined): boolean => unsure(x) || (reason === "timeout" && x !== undefined);

/** A key store refusal. The id and key rules are usage errors (this file checks both first); anything else the store
 *  says is `write-failed`, with its reason. Every message is the store's fixed text (src/keyStore.ts MESSAGES) —
 *  per platform, so a file-store timeout never tells the user to unlock a keychain. */
function storeFail(c: Ctx, verb: string, r: { reason: KeyFailReason; message: string; cleanup?: Cleanup; keyId?: string; deleted?: number }): number {
  const code: FailCode = r.reason === "invalid-key" || r.reason === "invalid-id" ? "usage" : "write-failed";
  const sure = !unconfirmed(r.reason, r.cleanup);
  const msg = sure ? r.message : `${r.message} — and what it stored could not be confirmed removed`;
  return fail(c, verb, code, msg, {
    reason: r.reason, ...(r.cleanup !== undefined ? { cleanup: r.cleanup } : {}),
    // Only when unconfirmed: the id the app retries `key delete --id` with (plan hub "Into P3" (3)). Not a secret.
    ...(!sure && r.keyId !== undefined ? { keyId: r.keyId } : {}),
    ...(r.deleted !== undefined ? { deleted: r.deleted } : {}),
  });
}

/** The dead-pid temp sweep, inside what is left of the pre-store budget. Best effort: one that runs over is left to
 *  finish beside the store call (it only removes dead writers' temp files, never a live pid's — this one's included). */
async function sweep(c: Ctx, left: number): Promise<void> {
  if (left > 0) await within(sweepDeadTemps(c.keyStore ?? {}), left);
}

/** `provider key set --json`: the key on stdin, stored under a fresh id, read back, answered by reference. */
async function keySet(c: Ctx): Promise<number> {
  const start = performance.now();
  const budget = c.preStoreMs ?? KEY_PRE_STORE_MS;
  const got = await within(readStdinText(c, KEY_STDIN_MAX_BYTES, "key set reads the key from stdin, which is a terminal here", "stdin is too large to be a key"), budget);
  if (got === TIMED_OUT) return fail(c, "key set", "usage", "stdin did not end in time — write the key, then close stdin");
  if ("error" in got) return fail(c, "key set", "usage", got.error);
  // `reason` as the store's own refusal would carry it (A2), so the app words every key-rule refusal one way.
  if (normalizeKey(got.text) === undefined) return fail(c, "key set", "usage", INVALID_KEY_MESSAGE, { reason: "invalid-key" });
  await sweep(c, budget - (performance.now() - start));
  return storeKey(c, "key set", got.text);
}

/** `provider key migrate --index <n> --json` (spec r9 §6): entry n's legacy literal `apiKey`, read from the SAVED config
 *  and stored exactly as `key set` stores a pasted key (`storeKey`), answered by the same reference. It WRITES NOTHING
 *  to the config — the app saves the new reference itself, then runs `key scrub-backup` — and holds no run lock (it
 *  writes no state file but the key store's own).
 *    • A LEGACY LITERAL is the entry's `api.apiKey` (item 1's `provider.api.apiKey`, a fallback's
 *      `fallbacks[i].api.apiKey`; types.ts `ProviderApi`), whatever else the entry names: beside an `apiKeyEnv`,
 *      `apiKeyFile` or `apiKeyCommand` it is still the rung-4 fallback the run reads when those come up empty
 *      (src/apiKey.ts), and it is still a key in plaintext in the file — the app's banner offers migrate for exactly
 *      that. An entry with no `apiKey` (its key is a reference, or it has none) and a CLI entry (any of item 1's
 *      `accounts` logins included) hold no literal: refused, `config`.
 *    • `--index` resolves as `reset`'s does (`resolveIndex`: a dropped entry, a broken `accounts`, out of range).
 *    • An entry whose endpoint is plain `http:` on a non-loopback host is refused, `config` (P2-M3-T1 checkpoint): a
 *      key the app stores is refused there at run time (`insecureEndpoint`) and by `config validate` (P2-M5-T2), so
 *      storing one would leave an orphan key or an entry that fails every tick. The same predicate decides all three
 *      (`cleartextRemote`, src/providers/endpoint.ts). Fixed text: neither the host nor the label is echoed.
 *    • A literal outside the store's charset is refused, `config` (a saved-config defect: `usage` is for malformed
 *      argv or stdin), and never echoed.
 *    Each refusal comes before any store call or sweep.
 *  On success the answer also carries the entry's `revision` (`entryRevision`, non-secret — the same value as the entry's
 *  `status --json` row `revision`, src/json.ts `ProviderRow`), so the app can confirm the entry it migrated is the one it shows before saving the reference.
 *  Neither the literal nor the entry's label is ever printed, nor passed in argv: the store sends the key on stdin
 *  (Keychain) or writes it to a 0600 file, and names the item by its fresh `keyId`. The config read and the dead-pid
 *  sweep share `KEY_PRE_STORE_MS`, but `within` bounds only the ASYNC read: the validation and list resolution after it
 *  are synchronous, and `resolveProviderList` → `resolveAccounts` makes an `existsSync` on each login's `configDir`
 *  (src/config.ts `resolveAccounts`), which a hung mount would block past the budget. That residual aside, migrate's
 *  worst case is `key set`'s. */
async function keyMigrate(f: Flags, c: Ctx): Promise<number> {
  const start = performance.now();
  const budget = c.preStoreMs ?? KEY_PRE_STORE_MS;
  const index = f.values.get("--index");
  if (index === undefined) return fail(c, "key migrate", "usage", "pass --index <n>");
  const n = parseIndex(index);
  if (n === undefined) return fail(c, "key migrate", "usage", "--index must be a 0-based position (decimal digits)");
  const saved = await within(listAt(c, c.configFile, "saved config"), budget);
  if (saved === TIMED_OUT) return fail(c, "key migrate", "config", "the saved config could not be read in time — retry", { reason: "timeout" });
  if ("error" in saved) return fail(c, "key migrate", "config", saved.error);
  const resolved = resolveIndex(saved.list, n);
  if ("error" in resolved) return fail(c, "key migrate", "config", resolved.error);
  const api = resolved.entry.provider.api;
  if (api === undefined) return fail(c, "key migrate", "config", "that entry runs a CLI (a login, not a key), so it holds no key to move");
  if (api.apiKey === undefined) return fail(c, "key migrate", "config", "that entry holds no literal apiKey to move — its key is already a reference (apiKeyEnv, apiKeyFile or apiKeyCommand), or it has none");
  if (cleartextRemote(api) !== undefined) return fail(c, "key migrate", "config", "that entry's endpoint is plain http on a non-loopback host, where a key the app stores is refused — switch its baseUrl to https first");
  if (normalizeKey(api.apiKey) === undefined) return fail(c, "key migrate", "config", `that entry's literal apiKey cannot be stored as it is: ${INVALID_KEY_MESSAGE}`, { reason: "invalid-key" });
  await sweep(c, budget - (performance.now() - start));
  return storeKey(c, "key migrate", api.apiKey, { revision: entryRevision(resolved.entry) });
}

/** The one store call `key set` and `key migrate` share: store `raw` (the store trims it) under a fresh id, read it
 *  back, and answer `{schemaVersion, ok, keyId, apiKeyCommand | apiKeyFile}` plus the caller's non-secret `extra`
 *  (migrate's `revision`) — or the store's failure, with the file store's abandoned attempt waited out first. */
async function storeKey(c: Ctx, verb: string, raw: string, extra: { revision?: string } = {}): Promise<number> {
  const r = await appKeySet(raw, c.keyStore ?? {});
  if (r.ok) {
    const ref = "apiKeyFile" in r ? { apiKeyFile: r.apiKeyFile } : { apiKeyCommand: r.apiKeyCommand };
    c.out(JSON.stringify({ schemaVersion: 1, ok: true, keyId: r.keyId, ...ref, ...extra }));
    return 0;
  }
  // The file store's timed-out attempt, waited out before the process exits (carried item 1): it removes what it
  // still holds — within what the store's cleanup left of the shared KEY_CLEANUP_MS.
  let cleanup = r.cleanup;
  if ("abandoned" in r && r.abandoned !== undefined) {
    const late = await r.abandoned.settle();
    if (!unsure(cleanup) && unsure(late)) cleanup = late;
  }
  return storeFail(c, verb, {
    reason: r.reason, message: r.message, ...(cleanup !== undefined ? { cleanup } : {}), ...(r.keyId !== undefined ? { keyId: r.keyId } : {}),
  });
}

/** `provider key delete --id <keyId> --json`: remove that one key — off darwin with that id's dead-pid temp files (r2
 *  L1, src/keyStore.ts `fileKeyDelete`). `deleted: false` when it removed nothing (a live — or reused — pid's temp stays,
 *  uncounted); an unlistable `keys/` is `failed` even after the key file went (docs/gui-seam.md, r3 L2). */
async function keyDelete(f: Flags, c: Ctx): Promise<number> {
  const id = f.values.get("--id");
  if (id === undefined) return fail(c, "key delete", "usage", "pass --id <keyId>");
  if (!KEY_ID_RE.test(id)) return fail(c, "key delete", "usage", "--id must be k- followed by 12 lowercase hex digits", { reason: "invalid-id" });
  const r = await appKeyDelete(id, c.keyStore ?? {});
  if (!r.ok) return storeFail(c, "key delete", r);
  c.out(JSON.stringify({ schemaVersion: 1, ok: true, deleted: r.deleted }));
  return 0;
}

/** `provider key delete-all --json`: every app-owned key (the app's uninstall leg), after the dead-pid sweep — a
 *  leftover temp file holds a secret too (carried item 2). Off darwin the store then removes every app temp whatever
 *  its pid, and the emptied `keys/` folder itself (C1, src/keyStore.ts `fileKeyDeleteAll`). */
async function keyDeleteAll(c: Ctx): Promise<number> {
  await sweep(c, c.preStoreMs ?? KEY_PRE_STORE_MS);
  const r = await appKeyDeleteAll(c.keyStore ?? {});
  if (!r.ok) return storeFail(c, "key delete-all", r);
  // `kept` (the file store, C1): files in keys/ that are not the app's, left with the folder.
  c.out(JSON.stringify({ schemaVersion: 1, ok: true, deleted: r.deleted, ...(r.kept !== undefined ? { kept: r.kept } : {}) }));
  return 0;
}

// ── provider key scrub-backup ────────────────────────────────────────────────────────────────────────

/** The bound on `key scrub-backup`'s READS — the dead-pid sweep, `.bak`'s check and read, the current config's read —
 *  inside the app's 15 s operation timeout (spec r9 §6: the engine's worst case + 5 s). The write after them (a temp
 *  file of at most `BACKUP_MAX_BYTES`, `fsync`, one rename) is not raced: a raced write would go on after the answer,
 *  and could be cut by the process exit with a staged copy of the literals left behind (the sweep's job, below). */
export const SCRUB_READ_MS = 5_000;

/** The named, UNSET environment variable a scrubbed literal becomes when it was its entry's ONLY key source (spec r9
 *  §6: "a manually restored `.bak` may find a deleted key. That is a named `key-unavailable` skip, never a silent
 *  one"). Merely deleting such a literal would leave the entry with no configured source at all, and an unconfigured
 *  entry reads its kind's DEFAULT key variable (src/apiKey.ts rung 1, `DEFAULT_KEY_ENV`) — a key the user never meant
 *  for that entry, possibly sent to a third-party `baseUrl`. Naming this variable instead makes the entry configured:
 *  the default is never consulted, the key read warns naming this variable, and the walk records the
 *  entry as `key-unavailable` (src/providers/base.ts `missingKey` → src/failover.ts). Nothing in the engine, the app
 *  or the tests ever sets it (test/provider.scrub.test.ts scans for the name); a user who does gets exactly that key. */
export const KEY_MOVED_ENV = "DAILY_BRIEFING_KEY_MOVED";

/** `.<config>.bak.scrub-<pid>-<random>`: the scrub's staged copy, beside `.bak`. Never `config_save.rs`'s own
 *  `.<config>.save-…` prefix (`staged_prefix`), so neither side's sweep can take the other's file. */
const scrubTempRe = (bakName: string): RegExp => new RegExp(`^\\.${escapeRe(bakName)}\\.scrub-(\\d+)-[a-z0-9]+$`);

/** Every string VALUE anywhere in `v`, TRIMMED (the run reads `apiKey.trim()`, src/apiKey.ts, so a literal that differs
 *  only by surrounding whitespace is the same key). Member names are not collected: no config field holds a key as a
 *  member name, so a name spelled like a key keeps nothing in the backup. Iterative: a deep document cannot overflow. */
function stringsIn(v: unknown): Set<string> {
  const out = new Set<string>();
  const stack: unknown[] = [v];
  while (stack.length > 0) {
    const x = stack.pop();
    if (typeof x === "string") out.add(x.trim());
    else if (Array.isArray(x)) for (const y of x) stack.push(y);   // not `push(...x)`: a huge array would overflow it
    else if (x !== null && typeof x === "object") for (const y of Object.values(x)) stack.push(y);
  }
  return out;
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

/** The literal-key holders of a config document as written: item 1's `provider.api` and each `fallbacks[i].api` —
 *  the only places a literal `apiKey` exists (types.ts `ProviderApi`; `accounts` logins carry none). Shapes that are
 *  not these (an `api` that is not an object, `fallbacks` that is not a list) hold no literal and are left alone. */
function apiBlocks(doc: unknown): Record<string, unknown>[] {
  if (!isObj(doc)) return [];
  const out: Record<string, unknown>[] = [];
  if (isObj(doc.provider) && isObj(doc.provider.api)) out.push(doc.provider.api);
  if (Array.isArray(doc.fallbacks)) for (const f of doc.fallbacks) if (isObj(f) && isObj(f.api)) out.push(f.api);
  return out;
}

type ScrubRead =
  | { absent: true }
  | { error: string; changed?: true }
  | { doc: unknown; held: Set<string>; mode: number; dev: number; ino: number; trailingNewline: boolean };

/** Everything the scrub reads, refusing on anything it cannot be sure of. Never echoes a byte of either file. */
async function readForScrub(c: Ctx, bak: string): Promise<ScrubRead> {
  // A dead scrub's staged copy holds the very literals this exists to remove: swept first, on every call — by the
  // store's one dead-pid sweep (C3, src/keyStore.ts `sweepDeadPidFiles`: regular files only, ESRCH pids only). An
  // unlistable folder sweeps nothing, and `.bak`'s own checks below decide.
  await sweepDeadPidFiles(dirname(bak), scrubTempRe(basename(bak)));

  let st;
  try { st = await lstat(bak); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { absent: true };
    return { error: "the settings backup could not be read — nothing was changed" };
  }
  if (!st.isFile()) return { error: "the settings backup is not a regular file (a symlink, a folder…) — nothing was changed" };

  // The current config first: when it cannot say what it still holds, nothing is scrubbed (never "scrub everything").
  let text: string | undefined;
  try { text = await (c.readConfig ?? readConfigText)(c.configFile); } catch { return { error: "the saved config could not be read — nothing was changed" }; }
  if (text === undefined) return { error: `no config at ${c.configFile} — nothing was changed` };
  let current: unknown;
  try { current = JSON.parse(text); } catch { return { error: "the saved config could not be read as JSON — nothing was changed" }; }
  try { validateConfig(current, c.home); }
  catch { return { error: "the saved config is not valid — run `daily-briefing config validate --json` for the reason; nothing was changed" }; }

  // `.bak` by its OPEN descriptor: O_NOFOLLOW (a symlink swapped in after the lstat is never followed), O_NONBLOCK (a
  // FIFO is never waited on), then regular and the very inode the lstat saw, at most BACKUP_MAX_BYTES (+1 read to tell).
  let raw: Buffer, mode: number, dev: number, ino: number;
  try {
    const fh = await open(bak, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0));
    try {
      const fst = await fh.stat();
      if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) return { error: "the settings backup changed while it was read — retry", changed: true };
      const buf = Buffer.alloc(BACKUP_MAX_BYTES + 1);
      let n = 0;
      for (;;) {
        const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
        if (bytesRead === 0) break;
        n += bytesRead;
        if (n > BACKUP_MAX_BYTES) return { error: "the settings backup is larger than any settings file the app saves — nothing was changed" };
      }
      raw = buf.subarray(0, n); mode = fst.mode & 0o7777; dev = fst.dev; ino = fst.ino;
    } finally { await fh.close().catch(() => undefined); }
  } catch { return { error: "the settings backup could not be read — nothing was changed" }; }
  // Decoded strictly: a non-UTF-8 `.bak` is refused rather than re-encoded with U+FFFD in place of its bytes (a lossy
  // rewrite of the user's restore point). `ignoreBOM` keeps a BOM as U+FEFF, as `Buffer.toString` did, so JSON.parse
  // still refuses it.
  let bakText: string;
  try { bakText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { return { error: "the settings backup is not UTF-8 text — nothing was changed" }; }
  let doc: unknown;
  try { doc = JSON.parse(bakText); } catch { return { error: "the settings backup could not be read as JSON — nothing was changed" }; }
  return { doc, held: stringsIn(current), mode, dev, ino, trailingNewline: bakText.endsWith("\n") };
}

/**
 * `provider key scrub-backup --json` (spec r9 §6 "Finalization is retryable"; plan P2-M3-T2): remove from
 * `<config>.bak` — the backup the app's save keeps beside the config (gui/src-tauri/src/config_save.rs:705) — every
 * LITERAL key the current saved config no longer holds. Answers `{schemaVersion: 1, ok: true, removed: <count>}`
 * (no value, no label, no position), plus `otherCopies: true` when the scrubbed `.bak` had another hard link (below);
 * a no-op answers `removed: 0` and writes nothing.
 *   • A LITERAL is a non-blank string `apiKey` of item 1's `provider.api` or of a `fallbacks[i].api` (types.ts
 *     `ProviderApi`: no other literal-key field exists). The current config still HOLDS it when the same trimmed
 *     string appears as a VALUE anywhere in it — any entry's `apiKey`, an `apiKeyCommand` element, any value at all
 *     (never a member name: no field holds a key as one) — because a key the config already carries in plaintext
 *     gains nothing by leaving the backup, and the backup stays a faithful restore point for it.
 *   • Removing a literal DELETES the `apiKey` member — never blanks it: the validator refuses `apiKey: ""`
 *     (src/config.ts), so a restored `.bak` stays loadable. When the entry has NO other key source (`apiKeyEnv`,
 *     `apiKeyFile`, `apiKeyCommand` all absent) the literal is REPLACED by `apiKeyEnv: KEY_MOVED_ENV`, a named
 *     variable nothing sets: deleted alone, a restored `.bak` would leave the entry unconfigured, and an unconfigured
 *     entry silently reads its kind's default key variable (src/apiKey.ts rung 1) — possibly a key meant for another
 *     provider, sent to this entry's `baseUrl`. With the sentinel the run records a named `key-unavailable` skip and
 *     warns naming the variable (spec r9 §6).
 *   • No `.bak` ⇒ `removed: 0`, and none is created. The current config missing, unreadable, not JSON or not valid ⇒
 *     refused (`config`): it cannot say what it still holds, and scrubbing everything would be a guess. A `.bak` that
 *     is not a regular file (a symlink is never followed), unreadable, larger than `BACKUP_MAX_BYTES` or not JSON ⇒
 *     refused (`config`), nothing written. `.bak` shapes that are not a config's (no `provider.api`, `fallbacks` not a
 *     list) hold no literal: `removed: 0`. No message quotes either file.
 *   • The write is atomic: the scrubbed document (2-space JSON, `.bak`'s trailing newline kept) is staged as an
 *     exclusive 0600 temp file beside `.bak`, given `.bak`'s own mode, `fsync`ed, and renamed over it only if `.bak`
 *     is still the inode that was read — a `.bak` replaced or removed meanwhile is refused (`config`, `reason:
 *     "changed"` — retry), never overwritten or re-created. Any failure after the temp exists removes it (`write-failed`). Staged copies of a
 *     dead pid are swept on every call: a crash between the create and the rename leaves the literals in one.
 *     Re-serializing drops what JSON.parse drops — a duplicate member's earlier value, and formatting. `.bak` is the
 *     previous config's RAW bytes (config_save.rs `replace_config_file` stages `expected_current` as the backup), not
 *     something the app re-serializes, so a config.json the user hand-edited becomes `.bak` at the next save and loses
 *     its formatting here. `.bak` is decoded strictly: one that is not UTF-8 is refused (`config`), never rewritten
 *     with replacement characters.
 *   • Other hard links: a crashed save can leave `.bak`'s inode under a second name (`.<config>.save-<pid>-<seq>.prev`,
 *     config_save.rs `keep_previous_backup`), and a rename only moves the `.bak` NAME, so that copy keeps the
 *     literals. The scrub never searches for, names or removes it (it is the save's file); when the inode it replaces
 *     has more than one link it answers `otherCopies: true`. The app's scrub command first sweeps its own crashed saves'
 *     staged files under the save lock (engine.rs `engine_provider_key_scrub_backup`, config_save.rs `sweep_stale` over
 *     `STAGED_SUFFIXES`), so a link left after that is one the app did not make or could not remove.
 *   • No run lock: no run, and no other engine command, reads or writes `.bak`. The app's scrub command holds
 *     `ConfigSaver.lock` across this call (P3-M1-T1, engine.rs `engine_provider_key_scrub_backup`), so no app save
 *     rewrites `.bak` meanwhile; only a scrub run by hand is the case below. The inode
 *     re-check narrows what is left to the instant between the check and the rename. What is left, accepted: a hand
 *     edit of `.bak` in that instant, and a scrub run BY HAND (from a shell, outside the app's lock) during an app
 *     save — it can rename its scrubbed copy over the `.bak` the save has just renamed in (config_save.rs, the staged
 *     backup's rename), losing that newer backup, or the save's failure path (`restore_backup`) can rename the
 *     unscrubbed `.prev` back over the scrubbed `.bak`. Either way a later scrub (the app runs one on open while `.bak`
 *     holds such a literal — P3) finds the literal that is left.
 *   • Bounded: the reads share `SCRUB_READ_MS`; the write is not raced (see the constant).
 */
async function keyScrubBackup(c: Ctx): Promise<number> {
  const verb = "key scrub-backup";
  const bak = `${c.configFile}.bak`;
  const read = await within(readForScrub(c, bak), c.scrubReadMs ?? SCRUB_READ_MS);
  if (read === TIMED_OUT) return fail(c, verb, "config", "the saved config or its backup could not be read in time — retry", { reason: "timeout" });
  // `reason: "changed"` (P3-M4 checkpoint): `.bak` changed under the read or the write — retry; the app retries it by
  // this field, never by the message.
  if ("error" in read) return fail(c, verb, "config", read.error, read.changed === true ? { reason: "changed" } : {});
  const answer = (removed: number, otherCopies = false): number => {
    c.out(JSON.stringify({ schemaVersion: 1, ok: true, removed, ...(otherCopies ? { otherCopies: true } : {}) }));
    return 0;
  };
  if ("absent" in read) return answer(0);

  let removed = 0;
  for (const api of apiBlocks(read.doc)) {
    const k = api.apiKey;
    if (typeof k === "string" && k.trim() !== "" && !read.held.has(k.trim())) {
      delete api.apiKey;
      // The resolver's own `configured` test (src/apiKey.ts): any of the three present keeps the entry configured, so
      // the default variable is never read; with none, the entry would become unconfigured — hence the sentinel.
      if (api.apiKeyEnv === undefined && api.apiKeyFile === undefined && api.apiKeyCommand === undefined) api.apiKeyEnv = KEY_MOVED_ENV;
      removed++;
    }
  }
  if (removed === 0) return answer(0);

  const tmp = join(dirname(bak), `.${basename(bak)}.scrub-${process.pid}-${Math.random().toString(36).slice(2, 10) || "0"}`);
  let created = false, otherCopies = false;
  try {
    const fh = await open(tmp, "wx", 0o600);
    created = true;
    try {
      await fh.writeFile(`${JSON.stringify(read.doc, null, 2)}${read.trailingNewline ? "\n" : ""}`);
      await fh.chmod(read.mode);
      await fh.sync();
    } finally { await fh.close(); }
    await c.beforeBackupRename?.();
    let now;
    try { now = await lstat(bak); } catch { now = undefined; }
    if (now === undefined || !now.isFile() || now.ino !== read.ino || now.dev !== read.dev) {
      await unlink(tmp).catch(() => undefined);
      return fail(c, verb, "config", "the settings backup changed while it was scrubbed — retry", { reason: "changed" });
    }
    // Another name for the very inode being replaced (a crashed save's `.prev` hard link, config_save.rs
    // `keep_previous_backup`) keeps the literals after the rename: reported, never searched for or named.
    otherCopies = now.nlink > 1;
    await rename(tmp, bak);
  } catch {
    if (created) await unlink(tmp).catch(() => undefined);
    return fail(c, verb, "write-failed", "the settings backup could not be rewritten — nothing was changed");
  }
  // The rename made durable. Best effort, as config_save.rs does: the rename has happened either way.
  try { const d = await open(dirname(bak), "r"); try { await d.sync(); } finally { await d.close(); } } catch { /* not every platform syncs a folder */ }
  return answer(removed, otherCopies);
}

// ── provider test: the probe unlocked, the apply locked ──────────────────────────────────────────────

/** `provider test --file <candidate.json> --index <n> --json` (spec r9 §6): builds entry n of a CANDIDATE config and
 *  probes it UNLOCKED (`probeEntry`), then applies the outcome under the run lock. Answers
 *  `{schemaVersion: 1, ok: true, passed, reason?, at, recorded, notRecorded?}` — `reason` a classifier reason
 *  (src/failover.ts), never provider text, a key byte or the entry's label; `notRecorded` (`"lock-held"` |
 *  `"write-failed"`) exactly when `recorded` is false (`applyTestOutcome`). */
async function testVerb(f: Flags, c: Ctx): Promise<number> {
  const file = f.values.get("--file"), index = f.values.get("--index");
  if (file === undefined || index === undefined) return fail(c, "test", "usage", "pass --file <candidate.json> and --index <n>");
  const n = parseIndex(index);
  if (n === undefined) return fail(c, "test", "usage", "--index must be a 0-based position (decimal digits)");
  // Bounded (C2): the app stages the candidate itself, but a stalled read must still not hold the Test. It and the
  // saved-config read below SHARE `TEST_CONFIG_READS_MS` (r2 L5), so the two add 0.5 s to the worst case, not 1 s.
  const readsMs = c.configReadsMs ?? TEST_CONFIG_READS_MS;
  const readsStart = performance.now();
  const cand = await within(listAt(c, file, "candidate"), readsMs);
  const readsLeft = readsMs - (performance.now() - readsStart);   // the saved read's share — the probe is not counted
  if (cand === TIMED_OUT) return fail(c, "test", "config", "the candidate could not be read in time — retry", { reason: "timeout" });
  if ("error" in cand) return fail(c, "test", "config", cand.error);
  const resolved = resolveIndex(cand.list, n);
  if ("error" in resolved) return fail(c, "test", "config", resolved.error);
  // P3-M4-T4 (hub 2026-10-18, revised at PR 3 final r1): a literal `apiKey` whose TRIMMED value still holds whitespace
  // or a control character is one the app could only have staged as its redaction placeholder (the app never holds a
  // literal; the placeholder always has spaces, a real key never does), so probing it would record a failure the
  // stored key may not deserve. Refused before the probe, whatever source outranks it: nothing is probed, recorded or
  // echoed. Defence in depth (the app disables Test on such an entry); the rule is a SHAPE, so the engine never names
  // the placeholder. Deliberately NOT the key store's `normalizeKey` rule: its 8-512 charset bound also refused short
  // dummy literals the run accepts, such as Ollama's `"ollama"` (H1).
  const literal = resolved.entry.provider.api?.apiKey;
  if (literal !== undefined && PLACEHOLDER_SHAPED_RE.test(literal.trim())) {
    return fail(c, "test", "config", "that entry's literal apiKey contains spaces or control characters, so it is not a key the app can test", { reason: "invalid-key" });
  }
  const outcome = await (c.probe ?? ((e, cfg) => probeEntry(e, cfg, c)))(resolved.entry, cand.cfg);
  // Stamped when the probe FINISHES, before any lock wait (hub Q22): the outcome is ordered by when it was observed.
  const obs: Observation = {
    at: (c.now ?? (() => new Date()))().toISOString(), revision: entryRevision(resolved.entry), ok: outcome.ok,
    ...(!outcome.ok && outcome.reason !== undefined ? { reason: outcome.reason } : {}),
  };
  // The run lock is judged by the SAVED config (P2-M1 checkpoint LOW, routed): a briefing that may hold it runs under
  // the saved config, so its staleness inputs are the saved one's — a candidate with a short timeout must never read a
  // live briefing's lock as stale and reclaim it. With no saved config readable in time — missing, unreadable, not JSON,
  // not valid, or its read past what the candidate's read left of `TEST_CONFIG_READS_MS` (none left: not read at all) —
  // the inputs are the most CONSERVATIVE a briefing could be running under (P2-M4 checkpoint LOW 3, 4): a config
  // missing or unreadable NOW may have been readable when a live briefing loaded it (deleted since, mid-rewrite, a
  // stalled mount), so the longer of the candidate's timeout and the longer default (an API provider's, API_TIMEOUT_MS),
  // with recap campaigns and calendar both on — the widest bound either input can produce. `within` bounds only the
  // ASYNC read: list resolution after it makes a synchronous `existsSync` on each login's `configDir` (src/config.ts
  // `resolveAccounts`), which a hung mount would block past the bound — the residual `key migrate` names too.
  const saved = readsLeft > 0 ? await within(listAt(c, c.configFile, "saved config"), readsLeft) : TIMED_OUT;
  const lockIn: LockInputs = saved === TIMED_OUT || "error" in saved
    ? { timeoutMs: Math.max(cand.cfg.provider.timeoutMs ?? defaultTimeoutMs(cand.cfg.provider), API_TIMEOUT_MS), recapCampaigns: true, calendar: true }
    : runLockInputs(saved.cfg);
  const applied = await applyTestOutcome(resolved.entry.label, obs, lockFor(lockIn, PROVIDER_TEST_WRITE_BOUND_MS, c), c);
  c.out(JSON.stringify({
    schemaVersion: 1, ok: true, passed: obs.ok, ...(obs.reason !== undefined ? { reason: obs.reason } : {}), at: obs.at,
    recorded: applied === true, ...(applied !== true ? { notRecorded: applied } : {}),
  }));
  return 0;
}

// ── provider test: the probe ─────────────────────────────────────────────────────────────────────────

/** One probe's outcome: passed, or failed with the classifier's reason (src/failover.ts `failoverReason`). */
export type ProbeOutcome = { ok: boolean; reason?: FailoverReason };

/** The tiny prompt a Test sends in place of the briefing prompt (spec r9 §6). Its answer is discarded. */
export const TEST_PROMPT = "Reply with the single word OK.";
// The Test's timeouts and the app's bound for it live in src/attemptBounds.ts, beside the other attempt bounds, so
// `config validate` (src/json.ts, on the run path, which must not import this lazily loaded file) can report each
// entry's app-side bound (`appTestTimeoutMs`, B1) from the same constants. Re-exported for this file's callers — only
// the three a caller imports from here (final harden round 3, L3: the app-side bounds' one caller, src/json.ts, imports them from attemptBounds).
export { PROBE_LOOPBACK_MAX_TIMEOUT_MS, PROBE_REMOTE_TIMEOUT_MS, probeTimeoutMs };
/** ONE bound over `test`'s two config reads (PR 2 final r2 L5), counted once in `probeDeadlineMs`'s arithmetic: the
 *  CANDIDATE's before the probe (C2 — past the bound: `config`, `reason: "timeout"` (retry), nothing probed or
 *  written), then the SAVED config's after it (it judges the run lock), which gets only what the first left — past
 *  that, or with nothing left, the lock is judged conservatively, as for an unreadable config. Shared so the loopback
 *  worst case stays `t` + 12 s, the app's `t` + 17 s less spec §6's 5 s margin. */
export const TEST_CONFIG_READS_MS = 500;
/** `test`'s refusal of a literal the app could only have staged as its redaction placeholder (P3-M4-T4, revised at
 *  PR 3 final r1 H1): any whitespace or control character left after trimming. Never part of a real key; always part
 *  of the placeholder, which this module never names. */
const PLACEHOLDER_SHAPED_RE = /[\s\p{Cc}]/u;
/** What is left on top of the deadline for a CLI Test: the abandoned child's SIGTERM → SIGKILL grace, its post-kill
 *  flush (src/provider.ts `FLUSH_KILLED_MS`, 1 s) and a margin — awaited before the answer, so the DIRECT child is
 *  never left running (and billing) after the engine exits. A descendant it backgrounded is not reached: the accepted
 *  descendant-kill residual (src/provider.ts:373, measured — a CLI's backgrounded grandchild survives the answer). */
export const CLI_PROBE_SETTLE_MS = KILL_GRACE_MS + 1_500;

/**
 * The whole probe's deadline (P2-M4). An API entry: `apiAttemptBoundMs` — the 5 s key bound, the timeout, the measured
 * 1 s transport margin: 66 s remote, `t` + 6 s loopback. A CLI entry: the 60 s alone, the `--help` probe included, so
 * the hardened provider's internal respawn cannot double it; on expiry the direct child is killed and waited out
 * (`CLI_PROBE_SETTLE_MS`, 6.5 s). PURE. No timer clamp is needed: the loopback cap keeps every deadline far below
 * the 2**31 − 1 ms a timer accepts.
 * The engine's worst case for the whole `provider test` (spec §6, amended at the P2-M4 checkpoint) adds what runs
 * around the probe: the candidate's read before it and the saved-config read after it, which SHARE one 0.5 s bound
 * (`TEST_CONFIG_READS_MS` — C2, r2 L5), the lock retry (`TEST_LOCK_RETRY_MS`, 5 s) and the locked re-read, status
 * write and mark clear (~0.5 s, plain local-file I/O, not raced):
 *   • remote API  0.5 + 66 s + 5 + ~0.5 ≈ 72 s          the app allows 80 s (`APP_REMOTE_TEST_TIMEOUT_MS`)
 *   • CLI         0.5 + 60 + 6.5 + 5 + ~0.5 ≈ 72.5 s    the app allows 80 s
 *   • loopback    0.5 + `t` + 6 + 5 + ~0.5 ≈ `t` + 12 s  the app allows `t` + 17 s — spec §6's 5 s margin exactly —
 *                 and with `t` ≤ `PROBE_LOOPBACK_MAX_TIMEOUT_MS` that stays under the app's 30-minute cap (Q12).
 * `config validate` reports each entry's app-side bound (`providers[].testTimeoutMs`, `appTestTimeoutMs` — B1).
 * Not counted: the synchronous `existsSync` residual of each config read's list resolution (see `testVerb`).
 */
export function probeDeadlineMs(entry: ListEntry): number {
  return entry.provider.api === undefined ? probeTimeoutMs(entry) : apiAttemptBoundMs(probeTimeoutMs(entry));
}

/**
 * `provider test`'s default probe (spec r9 §6; plan P2-M4-T1, T2). UNLOCKED, and it writes nothing.
 *   1. The `insecure-endpoint` rule FIRST (`insecureEndpoint`, the run's own predicate): an app-owned key over plain
 *      `http:` to a non-loopback host fails the Test with that reason before the key is read or anything is sent.
 *   2. The entry is built exactly as the walk builds it (src/core.ts `buildFor`: item 1's logins from `cfg.provider`,
 *      a fallback from its own block) with the Test's timeout (`probeTimeoutMs`). An API entry's key is read through the
 *      same ladder a morning run uses (`resolveApiKey`, inside the transport). A CLI entry is its own production
 *      invocation — `cli`, `argv`, `promptVia`, `harden`, `credential` (the hardened provider, as at 07:20) and, for a
 *      Claude login, its `configDir` as a per-spawn `CLAUDE_CONFIG_DIR` — with only the prompt replaced by
 *      `TEST_PROMPT`, so a Codex `["exec"]` entry is tested as `exec`.
 *   3. ONE request in the production dialect (`ApiTransport.probe`): any parsed 2xx is "key accepted", before content
 *      extraction. A CLI entry passes on any answer (`generate` refuses an empty one: `empty-answer`). No retry, no
 *      ladder. A `ProviderError` is classified by `failoverReason`; anything else is a bug and propagates, as it does in
 *      the walk.
 * The whole probe is raced against `probeDeadlineMs`, so a key read stalled on a dead mount or a CLI that never
 * answers cannot hold the Test past it; the abort then stops an abandoned request from being sent (P1-M3-T5's checks)
 * and kills an abandoned CLI's direct child, which is waited out before the answer (a descendant it backgrounded is
 * the accepted residual — `CLI_PROBE_SETTLE_MS`).
 */
export async function probeEntry(
  entry: ListEntry, cfg: Config, deps: Pick<ProviderCliDeps, "env" | "keyExec" | "keyFileFs" | "fetchImpl" | "testDeadlineMs"> = {},
): Promise<ProbeOutcome> {
  const kind: EntryKind = entry.provider.api?.kind ?? "cli";
  const refused = insecureEndpoint(entry);
  if (refused !== undefined) return { ok: false, reason: failoverReason(refused, kind) };
  const deadline = deps.testDeadlineMs ?? probeDeadlineMs(entry);
  const block = entry.source === "provider" ? cfg.provider : entry.provider;
  if (entry.provider.api === undefined) {
    // The walk's own construction (src/core.ts `buildFor`), the Test's timeout in place of the entry's.
    const cli = buildProvider(block, {
      timeoutMs: probeTimeoutMs(entry),
      ...(entry.configDir !== undefined ? { env: { CLAUDE_CONFIG_DIR: entry.configDir } } : {}),
    }).provider;
    try {
      await raceDeadline((signal) => cli.generate(TEST_PROMPT, { signal }), deadline, CLI_PROBE_SETTLE_MS);
      return { ok: true };
    } catch (e) {
      if (e instanceof ProviderError) return { ok: false, reason: failoverReason(e, kind) };
      throw e;
    }
  }
  const built = buildProvider(block, {
    timeoutMs: probeTimeoutMs(entry),
    api: {
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.keyExec !== undefined ? { keyExec: deps.keyExec } : {}),
      ...(deps.keyFileFs !== undefined ? { keyFileFs: deps.keyFileFs } : {}),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    },
  });
  if (!(built.provider instanceof ApiTransport)) throw new Error("provider test: an API entry did not build an API transport");
  const transport = built.provider;
  try {
    await raceDeadline((signal) => transport.probe(TEST_PROMPT, signal), deadline);
    return { ok: true };
  } catch (e) {
    if (e instanceof ProviderError) return { ok: false, reason: failoverReason(e, kind) };
    throw e;
  }
}

/** `work` raced against a deadline of `ms`: on expiry its signal is aborted and this rejects with `ProviderError
 *  ("timeout")` (the walk's per-attempt race, src/core.ts) — at once, or once the abandoned work has settled, for at
 *  most `settleMs` (a killed CLI's direct child is waited out rather than orphaned; its descendants are not — see
 *  `CLI_PROBE_SETTLE_MS`). The loser's rejection is swallowed. */
async function raceDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, settleMs = 0): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const p = work(ctl.signal);
  p.catch(() => { /* the loser of the race */ });
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      const gone = new ProviderError("timeout", `the Test's deadline (${ms} ms) passed`);
      if (settleMs <= 0) { reject(gone); return; }
      let wait: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([p.then(() => undefined, () => undefined), new Promise<void>((r) => { wait = setTimeout(r, settleMs); })])
        .then(() => { clearTimeout(wait); reject(gone); });
    }, ms);
  });
  try { return await Promise.race([p, expired]); }
  finally { clearTimeout(timer); }
}

/** Take the run lock, retrying a held one for `TEST_LOCK_RETRY_MS`; undefined when it is still held. */
async function lockWithRetry(opts: LockOpts, c: Ctx): Promise<LockHeld | undefined> {
  const clock = c.clock ?? Date.now, sleep = c.sleep ?? ((ms: number) => Bun.sleep(ms));
  const start = clock();
  for (;;) {
    const got = await acquireRunLock(opts);
    if (got.acquired) return got;
    const left = TEST_LOCK_RETRY_MS - (clock() - start);
    if (left <= 0) return undefined;
    await sleep(Math.min(TEST_LOCK_POLL_MS, left));
  }
}

/** Why a Test's outcome was not recorded (`notRecorded` in the answer; see `applyTestOutcome`). */
export type NotRecorded = "lock-held" | "write-failed";

/** When an hour-class mark was written: `recordHourMark` sets `limitedUntil` to the failure's instant plus `PROBE_MS`
 *  (a legacy probe mark too), and `clampUntil` never shortens an hour. */
const markWrittenAt = (mark: { limitedUntil: string }): number => Date.parse(mark.limitedUntil) - PROBE_MS;

/**
 * Apply a Test's observation under the run lock (spec r9 §5 "One writer at a time", §6 "On a pass"; hub Q16, Q22), and
 * say whether it was recorded. RE-READS the state under the lock, so a walk that wrote while the probe ran keeps its
 * write; the observation itself goes through `observeTest`'s timeline ordering. On a PASS:
 *   • the label's HOUR-class mark clears only if no failed observation for the label, at ANY revision, is newer than
 *     the Test's `at` — in the status timeline, or the mark itself (written after `at`); a usage mark never clears;
 *   • the quick-check latch clears only if the Test's revision is the latch's and no failure at that revision is newer.
 * A failure is recorded (and so `failingSince`) and writes no mark. Still locked after the retry ⇒ nothing is written.
 * Answers `true` when the outcome was recorded, else WHY not (P2-M1 checkpoint LOW, routed — so the app can word it):
 * `lock-held` — a briefing held the run lock past the retry, or took it over before the status write ("not saved — a
 * briefing was running"); `write-failed` — the status file could not be written.
 */
async function applyTestOutcome(label: string, obs: Observation, opts: LockOpts, c: Ctx): Promise<true | NotRecorded> {
  const lock = await lockWithRetry(opts, c);
  if (lock === undefined) return "lock-held";
  try {
    await c.underLock?.();
    if (!(await stillOurs(lock))) return "lock-held";
    const status = (await readProviderStatus()) ?? { labels: Object.create(null) as Record<string, never> };
    const prev = status.labels[label];
    const t = Date.parse(obs.at);
    const seen = [...(prev?.history ?? []), ...(prev?.lastRun ? [prev.lastRun] : []), ...(prev?.lastTest ? [prev.lastTest] : [])];
    const newerFailure = (revision?: string): boolean =>
      seen.some((h) => !h.ok && Date.parse(h.at) > t && (revision === undefined || h.revision === revision));
    const rec = observeTest(prev, obs);
    if (obs.ok && rec.quickCheck?.revision === obs.revision && !newerFailure(obs.revision)) delete rec.quickCheck;
    status.labels[label] = rec;
    if (!(await writeProviderStatus(status))) return "write-failed";
    await c.afterStatusWrite?.();
    // Ownership re-checked before EACH write, as the walk does: a lock taken over after the status write must not let
    // this holder clear a mark the successor may have written. The status already landed, so the outcome IS recorded.
    if (!(await stillOurs(lock))) return true;
    if (obs.ok && !newerFailure()) {
      // Non-fatal, like every mark write of the walk: the status is recorded, and a mark left behind expires in an hour.
      await removeMark(label, { only: (m) => markReason(m) !== "usage" && markWrittenAt(m) <= t }).catch(() => false);
    }
    return true;
  } finally { await lock.release(); }
}
