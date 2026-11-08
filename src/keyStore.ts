// src/keyStore.ts — the app-owned key store (spec r9 §6 `provider key set` / `key delete` / `key delete-all`): on
// macOS the login Keychain (provider-fallback plan P2-M2-T1; §9 the day-0 Keychain spike), everywhere else files under
// `<state>/keys/` (P2-M2-T2, "the file store" section at the end), and `appKeySet` / `appKeyDelete` / `appKeyDeleteAll`
// picking between them by platform. This module is the only writer of `<state>/keys/` (src/marker.ts `keysDir`).
//
// R2's OWNER for the Keychain tool (test/isolation.meta.test.ts): every call is built from SECURITY_BIN and
// APP_KEY_SERVICE (src/appKeyNames.ts) and leaves through an injected exec. Its default is the ONE reference to
// proc's `run` in this file (`defaultKeyExec`), wrapped in the test backstop below; nothing here spawns directly.
//
//   • An id is `k-<12 hex>`, fresh for every key, and the add never passes the update flag, so nothing is overwritten.
//   • The key is trimmed, then accepted only if it matches `[A-Za-z0-9._~+/=-]{8,512}` — BEFORE any exec. The charset
//     is load-bearing (spec §9): the tool's `-i` reader splits words on whitespace and quotes, and a malformed line
//     still exits 0 while storing the WRONG value, so a key holding a quote, a space or a backslash could not be
//     written faithfully. It also never carries a newline, so it can never start a second command on stdin.
//   • The add runs `-i` with `add-generic-password -s <service> -a <id> -w "<key>" "<keychain>"` on STDIN, never in
//     argv (argv is visible to every process on the machine), never `-A` (any app could read the item), and ALL of its
//     output is discarded. The read-back then runs exactly the reference the morning run will (`appKeyCommand`) and
//     compares; a mismatch is how the malformed line is caught.
//   • The keychain is EXPLICIT and ABSOLUTE on every call: `<home>/Library/Keychains/login.keychain-db`, from the home
//     seam, never a literal `~` (the tool does no tilde expansion), and never omitted (a call with no keychain operand
//     searches the default list). A test keychain is named only through the DBA_ENGINE_TEST_KEYCHAIN interlock — not
//     the uninstall script's DBA_TEST_KEYCHAIN — and must itself be a scratch keychain (`isScratchKeychain`).
//   • One deadline (`KEY_OP_DEADLINE_MS`) covers the add and the read-back together. On that deadline, a failed
//     read-back or a mismatch, the id is deleted (best effort, under `KEY_CLEANUP_MS`), so no item holding a wrong or
//     unconfirmed value is left behind — 13 s, 14 s with `key set`'s 1 s pre-store work: the app's 19 s `key set`
//     timeout less its 5 s margin (spec r9 §6).
//   • RESIDUAL, NAMED (PR 2 final harden round 3, L1; narrowed P3-M1-T0): the file store names no id whose `<id>.key`
//     was found to be another writer's (`failedId`) — by link(2)'s or the fallback create's EEXIST, by the cleanup's
//     inode check, or by the look at the name taken the moment the id is issued (`lookAtName`, which the timeout answer
//     awaits within the cleanup budget). What it cannot rule out, stated: a look that has not answered by then (a
//     stalled key folder; the id is then named, as before — no evidence of another key, and the retry is what removes
//     this call's own), and another writer creating the same random 48-bit id's file AFTER the look. And one the
//     other way (P3-M1-T1 checkpoint LOW, accepted): on the no-hard-link fallback, a look delayed until after
//     `writeExclusive(final)` creates the key but before its stat records it in `owned.published` sees this call's
//     OWN inode as another's, so `taken` drops the id — the key is left unnamed (orphaned), never another's deleted. The Keychain
//     cannot apply that rule to a TIMED-OUT add at all. The add never answered,
//     so whether its fresh id already named an item (the tool's duplicate-item refusal) is unknowable: the cleanup
//     deletes `-a <id>` and the answer names the id for a retry, either of which would remove another item of the same
//     id. The same holds for every other cleaned-up failure (`failClean`): whether the `-i` reader exits non-zero on a
//     duplicate item is UNVERIFIED (it exits 0 on a malformed line), and if it does not, the read-back then sees the
//     OTHER item's value, a `readback-mismatch` whose cleanup deletes that id. Collision-only — a fresh 48-bit random id
//     equal to an existing app item's — and accepted.
//   • NO CHILD OUTLIVES ITS CALL (PR 2 final harden round 1, A1): each child's own SIGKILL bound is its call's race
//     less `CHILD_KILL_MARGIN_MS` (`call`), so proc's `run` kills and reaps it while the engine still waits. The races
//     are unchanged, so the figures above are too (re-derived: delete 10 s; delete-all 10 s, 11 s with the 1 s sweep;
//     set / migrate 10 + 3 s, 14 s with the pre-store work) — each child just ends up to 0.5 s sooner.
//
// ⚠ NOTHING THE TOOL PRINTS IS EVER RETURNED. The add's output is discarded; the read-back's stdout IS the key and is
// only compared; every message below is fixed text.
//
// ⚠ VERIFIED ONLY AGAINST A FAKE (hub Q27: no automated test runs the real tool). The day-0 spike measured the `-i`
// add with no terminal (spec §9). UNVERIFIED here, for the real-Mac sitting: that the `-i` reader honours a
// double-quoted keychain operand (one containing a space), and that "not found" exits `KEY_NOT_FOUND_EXIT` (44,
// errSecItemNotFound — the widely documented value; not measured in this build).
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link as fsLink, lstat, mkdir, open as fsOpen, readdir, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { run } from "./proc";
import type { RunOpts, RunResult } from "./proc";
import { APP_KEY_SERVICE, SECURITY_BIN } from "./appKeyNames";
import { keysDir } from "./marker";
import { readStrictFile, type StrictReadOpts } from "./strictFile";
// What a key file IS (name, size cap, strict-read parameters) lives in src/keyFile.ts, shared with the morning
// `apiKeyFile` rung and `isAppOwnedKey` (P2-M5-T1); re-exported so the store's callers keep one import.
import { KEY_FILE_MAX_BYTES, KEY_FILE_RE, KEY_ID_RE, KEY_ID_SOURCE, keyFileReadOpts } from "./keyFile";
export { KEY_FILE_MAX_BYTES, KEY_ID_RE, keyFileReadOpts };

/** The exec every Keychain call leaves through: `proc.run`'s shape (so `RunDeps.keyExec` fits), and a test injects a
 *  recorder. */
export type KeyExec = (cmd: string[], opts?: RunOpts) => Promise<RunResult>;
type RunOut = RunResult;
type Env = Record<string, string | undefined>;

export type KeyStoreDeps = {
  /** TEST seam. Default `defaultKeyExec(env)`: proc's `run`, behind the backstop.
   *  ⚠ PRODUCTION CALLERS MUST LEAVE IT UNDEFINED: an injected exec REPLACES the default, backstop included, so a
   *  real `run` passed here would reach the Keychain tool even under DBA_TEST_UNIT_DIR (P2-M2-T1 checkpoint LOW 5a). */
  exec?: KeyExec;
  /** The home folder the login keychain lives under. Default `homedir()`. */
  home?: string;
  /** Where DBA_ENGINE_TEST_KEYCHAIN (and the backstop's DBA_TEST_UNIT_DIR) are read. Default `process.env`. */
  env?: Env;
  /** TEST seams: override `KEY_OP_DEADLINE_MS` and `KEY_CLEANUP_MS`, so a stall is observed without a 10 s wait. */
  deadlineMs?: number;
  cleanupMs?: number;
};

/** What a key may be, after trimming (spec r9 §6). */
const KEY_CHARSET_RE = /^[A-Za-z0-9._~+/=-]{8,512}$/;
/** One deadline over an operation's calls: `key set`'s add and read-back together, a delete, a delete-all's loop. The
 *  app's timeout for the verb less its 5 s margin and the work around the store call (spec r9 §6): `key delete`
 *  15 − 5; `key delete-all` 16 − 5 − 1 s sweep; `key set` / `key migrate` 19 − 5 − 1 s pre-store − 3 s cleanup. */
export const KEY_OP_DEADLINE_MS = 10_000;
/** The best-effort delete of a failed `key set`'s id, on its own bound, after the deadline (1 + 10 + 3 = 14 s: the
 *  app's 19 s `key set` timeout less its 5 s margin). */
export const KEY_CLEANUP_MS = 3_000;
/** At most this many deletes in one `deleteAll`: a tool that never reports not-found cannot loop it forever. */
export const KEY_DELETE_ALL_MAX_ITERATIONS = 256;
/** The tool's exit for "the specified item could not be found" (errSecItemNotFound). UNVERIFIED here — see header. */
export const KEY_NOT_FOUND_EXIT = 44;
/** Output caps per call: a read-back prints one key, and nothing the tool says is shown. */
const MAX_OUTPUT_BYTES = 8 * 1024;
/** The post-exit pipe flush per call (`proc.run`'s `flushMs`). */
const FLUSH_MS = 250;
/** How much SOONER than its race a Keychain child is SIGKILLed (PR 2 final harden round 1, A1): proc's `run` kills it
 *  at its own `timeoutMs`, then reaps it and flushes its pipes for up to `FLUSH_MS`, so the child's bound is the race's
 *  less that flush and a kill-and-reap grace. With the two equal the race — whose timer is armed first — won: the call
 *  returned, `main` exited, and the child's kill never fired (a `security` waiting on an unlock dialog outlived the
 *  engine, and could still complete later). A bound under twice the margin gives the child half of it. */
export const CHILD_KILL_MARGIN_MS = FLUSH_MS + 250;
/** The least time a Keychain call is started with (PR 2 final r2, L2). Below a few ms the child's own bound — half the
 *  call's — cannot beat the race: measured 2026-10-18 (an injected exec running `/bin/sleep` through proc's `run`, 20
 *  calls each), a 10 ms call left 1 child of 20 alive after it returned, while 20, 30, 50 and 100 ms left none (and 50
 *  ms none of 100 more). With less than this left, `call` answers timed out WITHOUT spawning, so no Keychain child
 *  outlives its call. */
export const KEY_CALL_MIN_MS = 50;

/** The backstop's refusal, as the default exec's `err` (src/schedule/install.ts's `SCHEDULER_CHANGE_REFUSED` twin). */
export const KEYCHAIN_CALL_REFUSED = "refused: a Keychain call without a scratch-keychain operand under DBA_TEST_UNIT_DIR";

export type KeyFailReason =
  | "invalid-key" | "invalid-id" | "keychain-refused" | "refused" | "timeout"
  | "add-failed" | "readback-failed" | "readback-mismatch" | "failed" | "cap"
  // the file store's own (P2-M2-T2)
  | "unsupported-platform" | "keys-folder" | "write-failed" | "collision";
/** What the best-effort delete of a failed `key set`'s id did. */
export type Cleanup = "deleted" | "not-found" | "failed" | "timeout";

/** A failed set's `keyId` is the id its `cleanup` was about (not a secret), present whenever `cleanup` is and an id had
 *  been issued: when that cleanup is unconfirmed, the app retries `key delete --id` with it (P2-M2 milestone checkpoint
 *  LOW 5). One exception, the file store's (PR 2 final r2 M1): a name found TAKEN whose temp then could not be removed
 *  fails with cleanup `failed` and NO id — that id's `<id>.key` is another writer's key, which the retry would delete. */
export type SetKeyOutcome =
  | { ok: true; keyId: string; apiKeyCommand: string[] }
  | { ok: false; reason: KeyFailReason; message: string; cleanup?: Cleanup; keyId?: string };
export type DeleteKeyOutcome = { ok: true; deleted: boolean } | { ok: false; reason: KeyFailReason; message: string };
/** `kept` (the file store only, and only when non-zero): files in `keys/` that are not the app's, left in place — with
 *  the folder, which is removed only when nothing else is left in it (C1). */
export type DeleteAllOutcome = { ok: true; deleted: number; kept?: number } | { ok: false; reason: KeyFailReason; message: string; deleted: number };

const UNLOCK = "unlock your keychain, then retry";
/** The key rule in words: `invalid-key`'s message, and `key set`'s refusal of a stdin key (src/providerCli.ts). */
export const INVALID_KEY_MESSAGE = "the key must be 8 to 512 characters of A-Z a-z 0-9 . _ ~ + / = - (surrounding whitespace is removed)";
const MESSAGES: Record<KeyFailReason, string> = {
  "invalid-key": INVALID_KEY_MESSAGE,
  "invalid-id": "the key id must be k- followed by 12 lowercase hex digits",
  "keychain-refused": "the keychain to use could not be named safely (an absolute home folder, or a scratch DBA_ENGINE_TEST_KEYCHAIN, is required)",
  "refused": KEYCHAIN_CALL_REFUSED,
  "timeout": `the Keychain did not answer in time — ${UNLOCK}`,
  "add-failed": "the Keychain refused to store the key",
  "readback-failed": "the stored key could not be read back, so it was removed",
  "readback-mismatch": "the stored key did not read back as given, so it was removed",
  "failed": "the Keychain refused the operation",
  "cap": `stopped after ${KEY_DELETE_ALL_MAX_ITERATIONS} deletions without the Keychain reporting none left`,
  "unsupported-platform": "app-owned key files need POSIX owners and modes, which this platform does not have",
  "keys-folder": "the key folder could not be prepared safely (it must be a folder of your own, not a link)",
  "write-failed": "the key could not be written to the key folder",
  "collision": "no unused key id was found; nothing was written",
};
/** The file store's wording where the Keychain's would mislead (no keychain is involved). */
const FILE_MESSAGES: Record<KeyFailReason, string> = {
  ...MESSAGES,
  "timeout": "the key folder did not answer in time — retry",
  "failed": "the key folder refused the operation",
};

// ── the key, the id, the keychain ───────────────────────────────────────────────────────────────────

/** A fresh `k-<12 hex>` (48 random bits). */
export function newKeyId(): string {
  return `k-${randomBytes(6).toString("hex")}`;
}

/** The key as it will be stored — trimmed — or undefined when it is outside the charset or length. */
export function normalizeKey(raw: string): string | undefined {
  const key = raw.trim();
  return KEY_CHARSET_RE.test(key) ? key : undefined;
}

/** The reference a config holds for a stored key, and the read-back `key set` runs: what the morning run will run. */
export function appKeyCommand(keyId: string, keychain: string): string[] {
  return [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-a", keyId, "-w", keychain];
}

/** The login keychain under `home`. */
export function loginKeychainPath(home: string): string {
  return join(home, "Library", "Keychains", "login.keychain-db");
}

/** Characters no keychain operand may hold: a quote or backslash would break the `-i` line, a single quote's meaning
 *  to the tool's reader is not pinned (it may group words — the backstop's `lineWords` refuses one too, P2-M2-T2
 *  checkpoint carried item 6), a `~` is never expanded, and a control byte (a newline above all) could start a second
 *  command. */
const UNSAFE_PATH_RE = /[~"'\\\u0000-\u001f\u007f]/;

/** Is `p` a SCRATCH keychain — one a test may name? Absolute, a `.keychain` / `.keychain-db` file, no `..` segment, no
 *  unsafe character, never login-named and never under any `Library/Keychains` folder (case-folded: the default APFS
 *  volume is case-insensitive). The interlock and the backstop both judge by it. */
export function isScratchKeychain(p: string): boolean {
  // Only a path already in normal form (P2-M2-T1 checkpoint LOW 3): the kernel folds `//` and `/./`, the
  // `Library/Keychains` test below does not, so `/Library//Keychains/System.keychain` would otherwise pass.
  return p.startsWith("/") && p === posix.normalize(p) && !UNSAFE_PATH_RE.test(p) && /\.keychain(?:-db)?$/i.test(p) &&
    !/^login\./i.test(basename(p)) && !p.split("/").includes("..") && !/\/library\/keychains\//i.test(p);
}

/** The keychain every call of one operation names: the DBA_ENGINE_TEST_KEYCHAIN interlock's scratch keychain when it is
 *  set (and refused when it is not a scratch keychain), else the login keychain under an absolute, safe home. */
function resolveKeychain(deps: KeyStoreDeps): string | undefined {
  const env = deps.env ?? process.env;
  const test = env.DBA_ENGINE_TEST_KEYCHAIN;
  if (test !== undefined && test !== "") return isScratchKeychain(test) ? test : undefined;
  const home = deps.home ?? homedir();
  if (!home.startsWith("/") || UNSAFE_PATH_RE.test(home) || home.split("/").includes("..")) return undefined;
  return loginKeychainPath(home);
}

// ── the backstop and the default exec ───────────────────────────────────────────────────────────────

/** The words of one `-i` stdin line — whitespace-separated, a double-quoted run (no quote inside) one word — or
 *  undefined when the line is not plainly that: an unbalanced quote, a quote joined to other text, a backslash or a
 *  single quote (whose meanings to the tool's reader are not pinned: a `'` may group words, so a scratch-looking last
 *  word could be the tail of an option's value — P2-M2-T2 checkpoint LOW 3). The store's own lines never hold any of
 *  these (the key charset has neither, and the keychain path is refused one with a backslash). */
function lineWords(line: string): string[] | undefined {
  if (line.includes("\\") || line.includes("'")) return undefined;
  const words: string[] = [];
  const re = /\s*(?:"([^"]*)"|([^\s"]+))(?=\s|$)/y;
  const t = line.trim();
  let at = 0;
  while (at < t.length) {
    re.lastIndex = at;
    const m = re.exec(t);
    if (m === null) return undefined;
    words.push(m[1] ?? m[2]!);
    at = re.lastIndex;
  }
  return words;
}

/** The value-taking options of each verb the store sends (`-w` is the password VALUE for an add, but a no-value
 *  "print only the password" flag for a find). Any other verb, or any other option, is not the store's. */
const STORE_VERBS: Record<string, { valued: readonly string[]; flags: readonly string[] }> = {
  "add-generic-password": { valued: ["-s", "-a", "-w"], flags: [] },
  "find-generic-password": { valued: ["-s", "-a"], flags: ["-w"] },
  "delete-generic-password": { valued: ["-s", "-a"], flags: [] },
};

/** Is `words` one of the store's own calls — a store verb, its options each consumed WITH its value, then EXACTLY one
 *  trailing operand, a scratch keychain? (P2-M2-T1 checkpoint LOW 2: "the last word" alone let through a call whose
 *  scratch-looking last word was an option's value, so the call named no keychain and searched the default list.) */
function isScratchStoreCall(words: readonly string[]): boolean {
  const verb = STORE_VERBS[words[0] ?? ""];
  if (verb === undefined) return false;
  let i = 1;
  while (i < words.length - 1) {
    const w = words[i]!;
    if (verb.valued.includes(w)) i += 2;
    else if (verb.flags.includes(w)) i += 1;
    else return false;
  }
  return i === words.length - 1 && isScratchKeychain(words[i]!);
}

/** Is this call one of the store's own, against an explicit scratch keychain: `SECURITY_BIN -i` with every stdin line
 *  such a call, or `SECURITY_BIN <verb> …` itself such a call? Anything else — another binary, another verb, a call
 *  with NO keychain operand (which searches the default list, the login keychain included) — is not. */
function hasScratchOperand(cmd: string[], input: string | undefined): boolean {
  if (cmd[0] !== SECURITY_BIN) return false;
  if (cmd.length === 2 && cmd[1] === "-i") {
    const lines = (input ?? "").split("\n").filter((l) => l.trim() !== "");
    return lines.length > 0 && lines.every((l) => { const w = lineWords(l); return w !== undefined && isScratchStoreCall(w); });
  }
  return isScratchStoreCall(cmd.slice(1));
}

/**
 * ⚠ THE PRODUCTION BACKSTOP (plan Build conventions, part 4). When DBA_TEST_UNIT_DIR is set — in `env` OR in
 * `processEnv` (default `process.env`; `backstopArmed`); test/fixtures/isolate-state.ts arms it in every engine test
 * process, and a child engine inherits it — every call that is not one of the store's own shapes against an explicit scratch keychain (`hasScratchOperand`: the
 * store's binary, one of its three verbs with its options and their values, then exactly one scratch-keychain operand)
 * comes back refused (`spawned: false`, `err` = KEYCHAIN_CALL_REFUSED) and `inner` is never reached: the same pattern
 * as `defaultExec` in src/schedule/install.ts. In production neither carries
 * the variable. A backstop for a test that forgot to inject the exec, never a way to write one.
 */
export function backstopped(inner: KeyExec, env: Env = process.env, processEnv: Env = process.env): KeyExec {
  return async (cmd, opts) => {
    if (backstopArmed(env, processEnv) && !hasScratchOperand(cmd, opts?.input)) {
      return { out: "", err: KEYCHAIN_CALL_REFUSED, code: -1, complete: false, spawned: false, signal: null, timedOut: false };
    }
    return inner(cmd, opts);
  };
}

/** Is the backstop armed: DBA_TEST_UNIT_DIR set (non-empty) in `env` or in `processEnv` (default `process.env`)? A
 *  pure predicate, so a test can show an UNARMED pair passes through (P2-M2 milestone checkpoint LOW 2). */
export function backstopArmed(env: Env, processEnv: Env = process.env): boolean {
  return Boolean(env.DBA_TEST_UNIT_DIR || processEnv.DBA_TEST_UNIT_DIR);
}

/** The default exec, and the ONLY reference to proc's `run` in this module (isolation.meta's "R1/R3 for keyStore.ts"). */
const defaultKeyExec = (env: Env): KeyExec => backstopped(run, env);

// ── one bounded call ────────────────────────────────────────────────────────────────────────────────

export const TIMED_OUT = Symbol("timed-out");

/** One call, raced against `ms` (an exec that never settles cannot hold the operation) and bounded by the child's own
 *  SIGKILL `CHILD_KILL_MARGIN_MS` sooner (half of `ms` when `ms` is under twice that), so with proc's `run` the child is
 *  killed and reaped BEFORE the race can fire and the call returns — no child outlives its call (A1). With less than
 *  `KEY_CALL_MIN_MS` left nothing is spawned: timed out (r2 L2 — below it the half-bound measurably lost the race). The
 *  race still catches an exec that never settles. A throwing exec — synchronously or not — is a call that did not run. */
async function call(exec: KeyExec, cmd: string[], input: string | undefined, ms: number): Promise<RunOut | typeof TIMED_OUT> {
  if (!(ms >= KEY_CALL_MIN_MS)) return TIMED_OUT;
  const childMs = Math.max(1, Math.floor(ms - Math.min(CHILD_KILL_MARGIN_MS, ms / 2)));
  const attempt = Promise.resolve()
    .then(() => exec(cmd, {
      timeoutMs: childMs, flushMs: FLUSH_MS, maxOutBytes: MAX_OUTPUT_BYTES, maxErrBytes: MAX_OUTPUT_BYTES,
      ...(input !== undefined ? { input } : {}),
    }))
    .catch((): RunOut => ({ out: "", err: "", code: -1, complete: false, spawned: false, signal: null, timedOut: false }));
  const r = await within(attempt, ms);
  return r !== TIMED_OUT && r.timedOut ? TIMED_OUT : r;
}

/** `p` raced against `ms` (an operation that never settles cannot hold its caller). The one copy: a Keychain call's
 *  bound above, the file store's deadline and cleanup bound below, and `provider key …`'s pre-store bound
 *  (src/providerCli.ts). */
export async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (!(ms > 0)) return TIMED_OUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((r) => { timer = setTimeout(() => r(TIMED_OUT), ms); });
  try { return await Promise.race([p, deadline]); } finally { clearTimeout(timer); }
}

const refusedBy = (r: RunOut): boolean => !r.spawned && r.err === KEYCHAIN_CALL_REFUSED;
/** A clean exit with this code: the tool ran to the end and said so. */
const exited = (r: RunOut, code: number): boolean => r.spawned && r.complete && r.signal === null && r.code === code;
const now = (): number => performance.now();

const failSet = (reason: KeyFailReason, cleanup?: Cleanup, keyId?: string): SetKeyOutcome =>
  ({ ok: false, reason, message: MESSAGES[reason], ...(cleanup !== undefined ? { cleanup, ...(keyId !== undefined ? { keyId } : {}) } : {}) });

// ── the operations ──────────────────────────────────────────────────────────────────────────────────

/**
 * `key set` on macOS: store `raw` (trimmed) under a fresh id in the login keychain, read it back, and return the id and
 * the reference a config holds for it. On the deadline, a failed read-back or a mismatch the id is deleted first. An add
 * that exits non-zero CLEANLY, or never ran, deletes nothing: it created nothing, and the id could only name an item
 * that is not this call's.
 */
export async function keychainSet(raw: string, deps: KeyStoreDeps = {}): Promise<SetKeyOutcome> {
  const key = normalizeKey(raw);
  if (key === undefined) return failSet("invalid-key");
  const keychain = resolveKeychain(deps);
  if (keychain === undefined) return failSet("keychain-refused");
  const exec = deps.exec ?? defaultKeyExec(deps.env ?? process.env);
  const deadlineMs = deps.deadlineMs ?? KEY_OP_DEADLINE_MS;
  const start = now();
  const left = () => deadlineMs - (now() - start);
  const keyId = newKeyId();
  const cleanup = async (): Promise<Cleanup> => {
    const r = await call(exec, deleteArgv(keychain, keyId), undefined, deps.cleanupMs ?? KEY_CLEANUP_MS);
    if (r === TIMED_OUT) return "timeout";
    return exited(r, 0) ? "deleted" : exited(r, KEY_NOT_FOUND_EXIT) ? "not-found" : "failed";
  };
  /** A failure after the id was deleted (best effort): its cleanup's answer, and the id it was about. */
  const failClean = async (reason: KeyFailReason): Promise<SetKeyOutcome> => failSet(reason, await cleanup(), keyId);

  const line = `add-generic-password -s ${APP_KEY_SERVICE} -a ${keyId} -w "${key}" "${keychain}"\n`;
  const add = await call(exec, [SECURITY_BIN, "-i"], line, left());
  if (add === TIMED_OUT) return failClean("timeout");
  if (refusedBy(add)) return failSet("refused");
  if (!add.spawned) return failSet("add-failed");
  if (!exited(add, 0)) {
    // A clean non-zero exit created nothing; an exit we cannot read (killed, cut short) may have, so it is cleaned up.
    return add.complete && add.signal === null && add.code > 0 ? failSet("add-failed") : failClean("add-failed");
  }

  const reference = appKeyCommand(keyId, keychain);
  const back = await call(exec, reference, undefined, left());
  if (back === TIMED_OUT) return failClean("timeout");
  if (refusedBy(back)) return failClean("refused");
  if (!exited(back, 0) || back.outTruncated) return failClean("readback-failed");
  const stored = back.out.endsWith("\n") ? back.out.slice(0, -1) : back.out;
  if (stored !== key) return failClean("readback-mismatch");
  return { ok: true, keyId, apiKeyCommand: reference };
}

function deleteArgv(keychain: string, keyId?: string): string[] {
  return [SECURITY_BIN, "delete-generic-password", "-s", APP_KEY_SERVICE, ...(keyId !== undefined ? ["-a", keyId] : []), keychain];
}

/** `key delete --id` on macOS: remove that one item. A missing id is `deleted: false`, not a failure. */
export async function keychainDelete(keyId: string, deps: KeyStoreDeps = {}): Promise<DeleteKeyOutcome> {
  const fail = (reason: KeyFailReason): DeleteKeyOutcome => ({ ok: false, reason, message: MESSAGES[reason] });
  if (!KEY_ID_RE.test(keyId)) return fail("invalid-id");
  const keychain = resolveKeychain(deps);
  if (keychain === undefined) return fail("keychain-refused");
  const exec = deps.exec ?? defaultKeyExec(deps.env ?? process.env);
  const r = await call(exec, deleteArgv(keychain, keyId), undefined, deps.deadlineMs ?? KEY_OP_DEADLINE_MS);
  if (r === TIMED_OUT) return fail("timeout");
  if (refusedBy(r)) return fail("refused");
  if (exited(r, 0)) return { ok: true, deleted: true };
  if (exited(r, KEY_NOT_FOUND_EXIT)) return { ok: true, deleted: false };
  return fail("failed");
}

/** `key delete-all` on macOS: delete the service's items one at a time until the tool reports none left, under one
 *  deadline and at most `KEY_DELETE_ALL_MAX_ITERATIONS` deletions. On the deadline `deleted` is a lower bound: the call
 *  that timed out may have deleted one more. */
export async function keychainDeleteAll(deps: KeyStoreDeps = {}): Promise<DeleteAllOutcome> {
  let deleted = 0;
  const fail = (reason: KeyFailReason): DeleteAllOutcome => ({ ok: false, reason, message: MESSAGES[reason], deleted });
  const keychain = resolveKeychain(deps);
  if (keychain === undefined) return fail("keychain-refused");
  const exec = deps.exec ?? defaultKeyExec(deps.env ?? process.env);
  const deadlineMs = deps.deadlineMs ?? KEY_OP_DEADLINE_MS;
  const start = now();
  for (let i = 0; i < KEY_DELETE_ALL_MAX_ITERATIONS; i++) {
    const r = await call(exec, deleteArgv(keychain), undefined, deadlineMs - (now() - start));
    if (r === TIMED_OUT) return fail("timeout");
    if (refusedBy(r)) return fail("refused");
    if (exited(r, KEY_NOT_FOUND_EXIT)) return { ok: true, deleted };
    if (!exited(r, 0)) return fail("failed");
    deleted++;
  }
  return fail("cap");
}

// ── the file store: `<state>/keys/` (P2-M2-T2) ──────────────────────────────────────────────────────
//
// Every platform but darwin (and win32, refused: the strict reader needs POSIX owners and modes). The steps of a set:
//   1. `keys/` is created if missing (mode 0700), then opened O_NOFOLLOW|O_DIRECTORY and fchmod'ed 0700 — a 022 umask
//      softens mkdir's mode, and a symlink or a folder that is not the user's own is refused before anything is
//      written through it.
//   2. The key goes to an O_EXCL temp file `.<keyId>.<pid>.<seq>.tmp` (the pid is what `key set`'s dead-pid sweep
//      reads, P2-M2-T3) at 0600, and is fsynced.
//   3. It is PUBLISHED EXCLUSIVELY as `<keyId>.key` by link(2), then the temp name is unlinked — the
//      `gui/src-tauri/src/config_save.rs` `create_config_file_with_link` pattern: EEXIST means the name is taken, so
//      publication can never replace an existing key. A link failure that means "no hard links on this filesystem"
//      (`NO_HARD_LINKS`) falls back to an exclusive create of the final name (exclusive still, no longer atomic — the
//      same accepted residual as config_save.rs); any other failure — ENOENT above all, the temp already removed by a
//      caller that gave up — fails without creating it (P2-M2-T2 checkpoint LOW 1; config_save.rs falls back on any
//      non-EEXIST error, and has no abandoned caller to outlive). A taken name issues a fresh id, at most
//      `KEY_ID_ATTEMPTS` ids in all.
//   4. The read-back runs after the temp name is gone (so the strict reader's `nlink === 1` holds), through
//      `readStrictFile` with the `keys/` parameters (`keyFileReadOpts`), and compares.
// One deadline (`KEY_OP_DEADLINE_MS`) covers all four. CLEANUP ONLY EVER REMOVES THIS CALL'S OWN FILES: its temp file,
// and the final name ONLY while it holds the inode this call created — re-checked by lstat (dev, ino) before the unlink —
// never a key it found. The final name and the temp's (dev, ino) are recorded BEFORE link(2) is called (link keeps the
// inode), so a link that has landed but not yet returned is covered too (P2-M2-T2 checkpoint MED).
//
// WHAT THE DEADLINE GUARANTEES. When it fires the attempt is abandoned and the caller, before it returns, runs the
// cleanup (bounded by `KEY_CLEANUP_MS`): it unlinks the temp name FIRST — after which no link(2) of it can land — and
// then the final name if it holds this call's inode. So when `fileKeySet` returns `timeout` with cleanup `deleted` or
// `not-found`, NO key this call published is on disk, even if the process exits at once (`main.ts` ends in
// `process.exit(await main(argv))`, so the abandoned attempt never runs again). (The CLI is deliberately stricter than
// this guarantee: it attaches `keyId` after ANY timeout, on both platforms — src/providerCli.ts `unconfirmed`, one rule
// for the Keychain, whose timed-out add may still land after its cleanup looked, and this store alike.) The abandoned
// attempt, if it does run again, starts nothing new — no fresh id, no link(2), no fallback create — and removes what it
// holds before it ends; it can never end in success. An O_EXCL open (the temp's, or the fallback's of the final name) is re-checked against
// the abandon flag the moment it returns, so a file whose open was still in flight at the deadline — not yet recorded,
// so the caller's cleanup could not see it — is removed by the attempt's very next step, never linked or read back
// (P2-M2 milestone checkpoint MED). What is NOT covered, stated: a cleanup that answers `failed` or `timeout` (the
// caller says so); and that same in-flight file when the process exits BEFORE the open returns or before the attempt
// gets that next turn — a temp (the dead-pid sweep's, P2-M2-T3), or, on a filesystem without hard links only, the
// fallback's final name: that key can outlive an immediate exit, unreferenced by any config (delete-all removes it).
//
// ⚠ HANDED BACK (P2-M2-T3): because the CLI exits as soon as `main` returns, a `timeout` outcome carries the abandoned
// attempt (`abandoned.settle()`), and `key set` awaits it before it returns, so the residuals above get their turn to
// clean up — bounded so the whole stays inside the app's 19 s `key set` timeout less its 5 s margin: the caller's
// cleanup and that wait SHARE `KEY_CLEANUP_MS` (1 + 10 + 3 = 14 s), the wait getting only what the cleanup left of it.
//
// ⚠ Not closed, stated: the `keys/` checks are on the folder at step 1 (and at the start of a delete or delete-all); a
// folder swapped for a symlink after that is seen, in a set, only by the read-back's own folder lstat (strictFile.ts
// header, "A KNOWN WINDOW"), and in a delete not at all — its unlinks would resolve through the swapped-in link.

/** At most this many ids per set: a taken name issues a fresh one. 48 random bits make a real collision vanishingly
 *  rare; the bound is for an id source that repeats. */
export const KEY_ID_ATTEMPTS = 4;
/** The link(2) failures that mean "this filesystem cannot make a hard link here", the only ones that fall back to an
 *  exclusive create: EPERM (Linux, e.g. vfat: "the filesystem does not support hard links"), ENOTSUP / EOPNOTSUPP
 *  (macOS msdosfs, and network filesystems), EMLINK (no second link allowed), ENOSYS (a FUSE filesystem that does not
 *  implement `link`). Not EXDEV: both names are in one folder, so it cannot mean a cross-device link. */
const NO_HARD_LINKS: readonly unknown[] = ["EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS"];

export type FileKeyStoreDeps = {
  /** The key folder. Default `keysDir()` (`<state>/keys`). */
  dir?: string;
  /** Default `process.platform`; win32 is refused. */
  platform?: NodeJS.Platform;
  /** TEST seams. */
  newId?: () => string;
  /** The one link(2) call (config_save.rs's `create_config_file_with_link` twin): a test fails it as FAT32 would. */
  link?: (from: string, to: string) => Promise<void>;
  /** The O_EXCL open of a new file — the temp, or the fallback's final name (`writeExclusive`): a test holds it in
   *  flight past the deadline (P2-M2 checkpoint MED). Default node's `open`. */
  createFile?: (path: string, flags: number, mode: number) => ReturnType<typeof fsOpen>;
  /** The look at a fresh id's final name (`lookAtName`, P3-M1-T0): a test holds it past the deadline. Default node's
   *  `lstat`. */
  nameLstat?: (path: string) => Promise<{ dev: number; ino: number }>;
  /** Forwarded to the read-back's strict reader (`StrictReadOpts.ownerCheck` / `.open`). */
  ownerCheck?: StrictReadOpts["ownerCheck"];
  open?: StrictReadOpts["open"];
  deadlineMs?: number;
  cleanupMs?: number;
  /** The dead-pid sweep's liveness test (`sweepDeadTemps`). Default `pidAlive`. */
  isAlive?: (pid: number) => boolean | Promise<boolean>;
};

/** A timed-out set's abandoned attempt, handed back (P2-M2-T3). `settle()` waits for it to end, for at most what is
 *  left of the `KEY_CLEANUP_MS` budget the caller's cleanup started, and says what of the attempt's own may remain:
 *  its cleanup's answer when it ended, `timeout` when it did not end in time. */
export type Abandoned = { settle: () => Promise<Cleanup> };

export type FileSetKeyOutcome =
  | { ok: true; keyId: string; apiKeyFile: string }
  | { ok: false; reason: KeyFailReason; message: string; cleanup?: Cleanup; keyId?: string; abandoned?: Abandoned };

/** `<dir>/<keyId>.key`: the `apiKeyFile` a config holds for a stored key. */
export function keyFilePath(dir: string, keyId: string): string {
  return join(dir, `${keyId}.key`);
}

const errCode = (e: unknown): unknown => (e as { code?: unknown } | null)?.code;
const failFile = (reason: KeyFailReason, cleanup?: Cleanup, keyId?: string): Extract<FileSetKeyOutcome, { ok: false }> =>
  ({ ok: false, reason, message: FILE_MESSAGES[reason], ...(cleanup !== undefined ? { cleanup, ...(keyId !== undefined ? { keyId } : {}) } : {}) });

/** Per-process temp sequence: with the pid, a temp name no other writer uses. */
let tempSeq = 0;

/** What one set has created so far — all its cleanup may ever touch. `published` is the final name and the inode this
 *  call put (or is putting) there: recorded before link(2) is called, so it may name a key not yet published — or a
 *  name another writer holds, whose inode never matches. `id` is the id in flight, the failure's `keyId` (LOW 5) — except
 *  on a taken name, whose failure carries no id (r2 M1: `<id>.key` is then another writer's). `taken` records that, for
 *  the id in flight (final harden round 3, L1 — the TIMEOUT answer too): set when link(2) or the fallback's exclusive
 *  create answers EEXIST, when a cleanup finds the final name holding an inode this call did not create (the
 *  deadline fired while link(2) was still in flight, so its EEXIST had not been seen yet), and when the look at the name
 *  taken as the id is issued finds anything there but this call's own inode (`lookAtName`, P3-M1-T0 — the cases where
 *  neither of the others had looked yet: the temp's open in flight, or the cleanup cut short); cleared when a fresh id
 *  is assigned. Read only through `failedId`. */
type Owned = {
  abandoned: boolean; id?: string; taken?: boolean; temp?: string; published?: { path: string; dev: number; ino: number };
  /** The look at the id's final name, started UNAWAITED the moment the id is issued (P3-M1-T0, `lookAtName`); the
   *  timeout path awaits it within what is left of the cleanup budget. */
  nameSeen?: Promise<void>;
};

/** The `keyId` a failure may name: the id in flight, unless its final name is another writer's (`taken`). */
const failedId = (owned: Owned): string | undefined => (owned.taken === true ? undefined : owned.id);

/** P3-M1-T0 (PR 2 final r3 scoped review, probes P2 and P3): look at `<id>.key` the moment `id` is issued, UNAWAITED —
 *  the attempt's steps and their order are unchanged — and mark the id `taken` when anything is there that is not the
 *  inode this call published (a lookup error other than ENOENT counts as taken too: fail closed). Without it, a
 *  timeout answer built before link(2)'s EEXIST, or before the cleanup's inode check, named the id although its name was
 *  another writer's key from the start: the temp's O_EXCL open in flight at the deadline (nothing published, so the
 *  cleanup never looks — P2), or the cleanup itself cut short with link(2) in flight (P3). A result for an id no longer
 *  in flight is dropped. Never rejects. */
function lookAtName(owned: Owned, id: string, final: string, look: FileKeyStoreDeps["nameLstat"] = lstat): Promise<void> {
  const ours = (st: { dev: number; ino: number }): boolean => {
    const pub = owned.published;
    return pub !== undefined && pub.path === final && pub.dev === st.dev && pub.ino === st.ino;
  };
  return look(final).then(
    (st) => { if (owned.id === id && !ours(st)) owned.taken = true; },
    (e: unknown) => { if (owned.id === id && errCode(e) !== "ENOENT") owned.taken = true; },
  );
}

/** Remove this call's own files: the temp name first (so no link of it can land afterwards), then the final name ONLY
 *  if it still holds the inode this call created. Never throws; idempotent (the abandoned attempt and the caller may
 *  both run it, concurrently), and a field is cleared only if it still names what this run removed (LOW 4). */
async function removeOwned(owned: Owned): Promise<Cleanup> {
  const temp = owned.temp;
  // A temp file holds the KEY: one that could not be unlinked (anything but ENOENT, "gone already") makes the whole
  // cleanup `failed`, never a confirmed `not-found` (A3), and stays recorded so a later run of this retries it.
  let tempLeft = false;
  if (temp !== undefined) {
    try { await unlink(temp); } catch (e) { tempLeft = errCode(e) !== "ENOENT"; }
    if (owned.temp === temp && !tempLeft) owned.temp = undefined;
  }
  const pub = owned.published;
  const published = await (async (): Promise<Cleanup> => {
    if (pub === undefined) return "not-found";
    const forget = (): void => { if (owned.published === pub) owned.published = undefined; };
    try {
      const st = await lstat(pub.path);
      // Another inode under the final name: another writer's key — the id must never be named for a retry (L1).
      if (st.dev !== pub.dev || st.ino !== pub.ino) { if (owned.published === pub) owned.taken = true; forget(); return "not-found"; }
      await unlink(pub.path);
      forget();
      return "deleted";
    } catch (e) {
      if (errCode(e) === "ENOENT") { forget(); return "not-found"; }
      return "failed";
    }
  })();
  return tempLeft ? "failed" : published;
}

/** Step 1: `keys/` exists, is a real folder of this user's own, and is 0700. False when it cannot be made so. */
async function prepareKeysDir(dir: string): Promise<boolean> {
  await mkdir(dirname(dir), { recursive: true });
  try { await mkdir(dir, { mode: 0o700 }); } catch (e) { if (errCode(e) !== "EEXIST") throw e; }
  let fh: Awaited<ReturnType<typeof fsOpen>>;
  try { fh = await fsOpen(dir, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY); }
  catch { return false; }                                           // a symlink (ELOOP), not a folder (ENOTDIR), …
  try {
    const st = await fh.stat();
    const uid = process.getuid?.();
    if (!st.isDirectory() || uid === undefined || st.uid !== uid) return false;
    await fh.chmod(0o700);
    return true;
  } finally { await fh.close().catch(() => undefined); }
}

/** Write `key` to a new file at `path` (O_EXCL, 0600, fsynced), recording it in `owned` the moment it exists (`as`:
 *  the temp file, or the published key for the fallback). The open's EEXIST is thrown to the caller. */
async function writeExclusive(
  path: string, key: string, owned: Owned, as: "temp" | "published", create: FileKeyStoreDeps["createFile"] = fsOpen,
): Promise<{ dev: number; ino: number }> {
  const fh = await create(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const st = await fh.stat();
    const ident = { dev: st.dev, ino: st.ino };
    if (as === "temp") owned.temp = path; else owned.published = { path, ...ident };
    await fh.writeFile(key);
    await fh.sync();
    return ident;
  } finally { await fh.close().catch(() => undefined); }
}

/** Steps 1–4 for one set. Every way out either removes this call's own files (a failure) or passes the abandon check
 *  before success, so an attempt the caller gave up on removes what it holds before it ends, whichever step it was in.
 *  More abandon checks sit where the attempt would otherwise CREATE or PUBLISH a name after the caller returned — before
 *  a fresh id's temp file, and before the fallback's create (P2-M2-T2 checkpoint MED and LOW 1) — and right after each
 *  O_EXCL open returns, so an open in flight at the deadline is removed before link(2) or a read-back (P2-M2 milestone
 *  checkpoint MED). (Checks at the other steps were measured redundant: mutant M9, 2026-10-17.) */
async function fileSetAttempt(key: string, dir: string, deps: FileKeyStoreDeps, owned: Owned): Promise<FileSetKeyOutcome> {
  const failOwn = async (reason: KeyFailReason): Promise<FileSetKeyOutcome> => failFile(reason, await removeOwned(owned), failedId(owned));
  if (!(await prepareKeysDir(dir).catch(() => false))) return failFile("keys-folder");

  let keyId: string | undefined;
  for (let n = 0; n < KEY_ID_ATTEMPTS && keyId === undefined; n++) {
    if (owned.abandoned) return failOwn("timeout");                        // no fresh id after the caller gave up
    const id = (deps.newId ?? newKeyId)();
    if (!KEY_ID_RE.test(id)) return failFile("write-failed");
    owned.id = id;
    owned.taken = false;                                                   // a fresh id: its final name is not known taken
    const final = keyFilePath(dir, id);
    owned.nameSeen = lookAtName(owned, id, final, deps.nameLstat);                         // …until this look says otherwise (P3-M1-T0)
    const temp = join(dir, `.${id}.${process.pid}.${++tempSeq}.tmp`);
    let ident: { dev: number; ino: number };
    try { ident = await writeExclusive(temp, key, owned, "temp", deps.createFile); }
    catch (e) { if (errCode(e) === "EEXIST") continue; return failOwn("write-failed"); }
    // An open still in flight at the deadline was not yet recorded, so the caller's cleanup found nothing: the temp it
    // just made (holding the secret) is removed here, and nothing is linked (P2-M2 milestone checkpoint MED).
    if (owned.abandoned) return failOwn("timeout");
    owned.published = { path: final, ...ident };                           // before link: it keeps the inode (MED)
    try {
      await (deps.link ?? fsLink)(temp, final);
    } catch (e) {
      if (errCode(e) === "EEXIST") {                                       // taken: a fresh id — unless the temp stuck (A3)
        // WITHOUT the id (r2 M1): `<id>.key` is ANOTHER writer's key, so the retry `key delete --id` would remove it.
        // The stuck temp is named by no id; the dead-pid sweep removes it once this process is gone. `taken` carries the
        // same rule to a timeout answer built meanwhile, or before the next id is assigned (L1).
        owned.taken = true;
        if ((await removeOwned(owned)) === "failed") return failFile("write-failed", "failed");
        continue;
      }
      if (!NO_HARD_LINKS.includes(errCode(e))) return failOwn("write-failed"); // ENOENT: the temp is gone — never re-publish
      if (owned.abandoned) return failOwn("timeout");                      // never a create after the caller gave up
      // No hard links here: an exclusive create of the final name instead.
      try { await writeExclusive(final, key, owned, "published", deps.createFile); }
      catch (e2) {
        if (errCode(e2) === "EEXIST") {
          owned.taken = true;
          if ((await removeOwned(owned)) === "failed") return failFile("write-failed", "failed");   // no id: as above (M1)
          continue;
        }
        return failOwn("write-failed");
      }
      if (owned.abandoned) return failOwn("timeout");                      // the same in-flight open, for the final name
    }
    try { await unlink(temp); owned.temp = undefined; } catch { /* left: the read-back's nlink check refuses a key still linked twice */ }
    keyId = id;
  }
  if (keyId === undefined) return failFile("collision");                   // each taken id's temp file is already gone
  // The rename-free publish is durable once the folder is: best effort, as config_save.rs.
  try { const d = await fsOpen(dir, constants.O_RDONLY); try { await d.sync(); } finally { await d.close(); } } catch { /* best effort */ }

  const path = keyFilePath(dir, keyId);
  const back = await readStrictFile(path, {
    ...keyFileReadOpts(dir),
    ...(deps.ownerCheck !== undefined ? { ownerCheck: deps.ownerCheck } : {}),
    ...(deps.open !== undefined ? { open: deps.open } : {}),
  });
  if (owned.abandoned) return failOwn("timeout");                          // the caller gave up: nobody will use this key
  if (back.status !== "ok") return failOwn("readback-failed");
  if (back.text !== key) return failOwn("readback-mismatch");
  return { ok: true, keyId, apiKeyFile: path };
}

/**
 * `key set` off darwin: store `raw` (trimmed) as `<dir>/<keyId>.key` under a fresh id, read it back, and return the id
 * and the `apiKeyFile` a config holds for it. Refused before anything is written: a key outside the charset, win32.
 */
export async function fileKeySet(raw: string, deps: FileKeyStoreDeps = {}): Promise<FileSetKeyOutcome> {
  const key = normalizeKey(raw);
  if (key === undefined) return failFile("invalid-key");
  if ((deps.platform ?? process.platform) === "win32") return failFile("unsupported-platform");
  const dir = deps.dir ?? keysDir();
  const owned: Owned = { abandoned: false };
  const attempt = fileSetAttempt(key, dir, deps, owned).catch(async (): Promise<FileSetKeyOutcome> =>
    failFile("write-failed", await removeOwned(owned), failedId(owned)));
  const r = await within(attempt, deps.deadlineMs ?? KEY_OP_DEADLINE_MS);
  if (r === TIMED_OUT) {
    owned.abandoned = true;
    const cleanupMs = deps.cleanupMs ?? KEY_CLEANUP_MS;
    const budgetEnds = now() + cleanupMs;
    const c = await within(removeOwned(owned), cleanupMs);
    // P3-M1-T0: the look at the id's final name, started when the id was issued, gets what is left of the budget. One
    // that has not answered by then keeps today's answer (the id is named: a stalled key folder is no evidence of
    // another key there, and the retry is what removes this call's own key should it land).
    if (owned.nameSeen !== undefined) await within(owned.nameSeen, budgetEnds - now());
    // An abandoned attempt never ends in success (header); were it ever to, the key it holds is unreferenced: say so.
    const settle = async (): Promise<Cleanup> => {
      const end = await within(attempt, budgetEnds - now());
      return end === TIMED_OUT ? "timeout" : end.ok ? "failed" : (end.cleanup ?? "not-found");
    };
    // No id when the final name is another writer's (`failedId`, L1): a retry `key delete --id` would remove that key.
    return { ...failFile("timeout", c === TIMED_OUT ? "timeout" : c, failedId(owned)), abandoned: { settle } };
  }
  return r;
}

/** `keys/` as delete and delete-all may use it (LOW 5): "missing" (nothing to delete), "ok" (a real folder, not a link,
 *  of this user's own), or "bad". An lstat, so a symlinked `keys/` is never unlinked through. */
async function checkKeysDir(dir: string): Promise<"ok" | "missing" | "bad"> {
  try {
    const st = await lstat(dir);
    const uid = process.getuid?.();
    return st.isDirectory() && uid !== undefined && st.uid === uid ? "ok" : "bad";
  } catch (e) { return errCode(e) === "ENOENT" ? "missing" : "bad"; }
}

/** `key delete --id` off darwin: remove `<dir>/<keyId>.key` AND that id's temp files whose writer is gone (r2 L1: a
 *  set whose temp stuck answers cleanup `failed` with this id, and the temp holds the key; a LIVE pid's temp — a set
 *  still in flight, or a reused pid that reads as alive — is never touched, nor another id's). `deleted: true` when
 *  either went; nothing removed (or a missing folder) is `deleted: false`, not a failure; a dead writer's temp that
 *  could not be removed is `failed`, and so is a folder that cannot be listed (r3 L2: fail closed — the key file is
 *  unlinked by name first, so it may be gone though the answer is `failed`). Refused,
 *  before anything is touched: an invalid id, win32, a `keys/` that is a link or not a folder of the user's own. Under
 *  the one deadline. */
export async function fileKeyDelete(keyId: string, deps: FileKeyStoreDeps = {}): Promise<DeleteKeyOutcome> {
  const fail = (reason: KeyFailReason): DeleteKeyOutcome => ({ ok: false, reason, message: FILE_MESSAGES[reason] });
  if (!KEY_ID_RE.test(keyId)) return fail("invalid-id");
  if ((deps.platform ?? process.platform) === "win32") return fail("unsupported-platform");
  const dir = deps.dir ?? keysDir();
  const op = async (): Promise<DeleteKeyOutcome> => {
    const folder = await checkKeysDir(dir);
    if (folder === "missing") return { ok: true, deleted: false };
    if (folder === "bad") return fail("keys-folder");
    let key: boolean;
    try { await unlink(keyFilePath(dir, keyId)); key = true; }
    catch (e) { if (errCode(e) !== "ENOENT") return fail("failed"); key = false; }
    const temps = await sweepDeadPidFiles(dir, tempFileRe(keyId), deps.isAlive);
    if (temps.stuck) return fail("failed");
    return { ok: true, deleted: key || temps.swept > 0 };
  };
  const r = await within(op(), deps.deadlineMs ?? KEY_OP_DEADLINE_MS);
  return r === TIMED_OUT ? fail("timeout") : r;
}

/** `key delete-all` off darwin — the app's uninstall leg (spec r9 §6: it removes `<state>/keys/`). Removes every
 *  APP-SHAPED file in `<dir>`: each published `k-<12 hex>.key` (counted in `deleted`) and each temp file
 *  `.<keyId>.<pid>.<seq>.tmp` WHATEVER ITS PID (C1: a temp holds the key too, and a reused or foreign live pid must not
 *  keep one past an uninstall; a set in flight then fails safely, as the sweep's header says). Then the folder itself
 *  is removed when nothing else is in it. A name that is not the app's is never touched: it stays, with the folder,
 *  and is counted in `kept`. A missing folder is zero deleted. Refused as `fileKeyDelete` is (a symlinked `keys/` is
 *  never unlinked through, nor removed); under the one deadline. On that deadline, `deleted` is a LOWER BOUND: `within`
 *  returns while the loop runs on, and the unlinks it still makes are not counted (P2-M2 milestone checkpoint LOW 6). */
export async function fileKeyDeleteAll(deps: FileKeyStoreDeps = {}): Promise<DeleteAllOutcome> {
  let deleted = 0;
  const fail = (reason: KeyFailReason): DeleteAllOutcome => ({ ok: false, reason, message: FILE_MESSAGES[reason], deleted });
  if ((deps.platform ?? process.platform) === "win32") return fail("unsupported-platform");
  const dir = deps.dir ?? keysDir();
  const op = async (): Promise<DeleteAllOutcome> => {
    const folder = await checkKeysDir(dir);
    if (folder === "missing") return { ok: true, deleted: 0 };
    if (folder === "bad") return fail("keys-folder");
    let names: string[];
    try { names = await readdir(dir); } catch (e) { return errCode(e) === "ENOENT" ? { ok: true, deleted: 0 } : fail("failed"); }
    let kept = 0;
    for (const name of names) {
      const key = KEY_FILE_RE.test(name);
      if (!key && !TEMP_FILE_RE.test(name)) { kept++; continue; }
      try { await unlink(join(dir, name)); if (key) deleted++; } catch (e) { if (errCode(e) !== "ENOENT") return fail("failed"); }
    }
    if (kept > 0) return { ok: true, deleted, kept };
    // Best effort: a name that appeared meanwhile (ENOTEMPTY) keeps the folder; the keys are gone either way.
    try { await rmdir(dir); } catch { /* raced, or already gone */ }
    return { ok: true, deleted };
  };
  const r = await within(op(), deps.deadlineMs ?? KEY_OP_DEADLINE_MS);
  return r === TIMED_OUT ? fail("timeout") : r;
}

// ── the dead-pid temp sweep (P2-M2-T3: `key set` and `key delete-all` run it first) ────────────────────
//
// A set interrupted between its O_EXCL temp write and its own cleanup (a crash, a SIGKILL, the in-flight residual in
// "WHAT THE DEADLINE GUARANTEES") leaves `.<keyId>.<pid>.<seq>.tmp` in `keys/` — and a temp file holds the SECRET. The
// sweep removes exactly those whose writer is gone: the name must be that shape (never a published `<keyId>.key`, never
// a look-alike), and its pid must be one `kill(pid, 0)` answers ESRCH for — this process's own, a live one (EPERM: alive,
// not ours) and any other answer are kept. A reused pid only keeps a dead writer's temp a while longer. The folder is
// checked as delete's is (`checkKeysDir`: a real folder of the user's own, never a link), so nothing is unlinked through
// a swapped-in symlink at the start. Runs on every platform: on darwin `keys/` is normally absent, a no-op.
// A LIVE writer in another pid namespace (a container sharing the state folder) answers ESRCH too, so its temp is
// unlinked mid-write. Before its link(2), that set then fails safely — the link finds no temp (ENOENT → `write-failed`,
// no fallback create) and nothing of the secret is left behind; after it, the set publishes as normal (P2-M2 milestone
// checkpoint LOW 6).

/** A temp file's name: `.<keyId>.<pid>.<seq>.tmp`, the pid captured (1 or more, no leading zero) — for any id
 *  (`idSource` a pattern), or one id's own (`fileKeyDelete`: a validated id, `k-` and hex, so no escape is needed). */
const tempFileRe = (idSource: string): RegExp => new RegExp(`^\\.${idSource}\\.([1-9][0-9]{0,9})\\.[0-9]{1,15}\\.tmp$`);
const TEMP_FILE_RE = tempFileRe(KEY_ID_SOURCE);

/** Is `pid` a process that exists? Only ESRCH means no: EPERM (it exists, it is not ours) and anything else keep it. */
export function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return errCode(e) !== "ESRCH"; }
}

/** Remove every dead-pid temp file in `keys/` (default `keysDir()`). Never throws; `swept` is how many were removed.
 *  The caller bounds it (src/providerCli.ts `KEY_PRE_STORE_MS`). */
export async function sweepDeadTemps(deps: FileKeyStoreDeps = {}): Promise<{ swept: number }> {
  const dir = deps.dir ?? keysDir();
  try { if ((await checkKeysDir(dir)) !== "ok") return { swept: 0 }; } catch { return { swept: 0 }; }
  return { swept: (await sweepDeadPidFiles(dir, TEMP_FILE_RE, deps.isAlive)).swept };
}

/** THE dead-pid sweep (C3), shared with `key scrub-backup`'s staged copies (src/providerCli.ts) and `fileKeyDelete`'s
 *  own temps (r2 L1): unlink every REGULAR FILE in `dir` whose name matches `re` and whose pid — `re`'s first capture —
 *  `isAlive` calls dead (ESRCH only: `pidAlive`). A pid that is not a safe integer, this process's own, a live one and
 *  anything not a regular file (a folder, a symlink) are kept. The caller checks `dir` itself. Never throws; answers
 *  how many were removed (`swept`) and whether any dead writer's file STAYED for a reason other than "gone already" —
 *  an unremovable one, or an unlistable folder (`stuck`). */
export async function sweepDeadPidFiles(
  dir: string, re: RegExp, isAlive: (pid: number) => boolean | Promise<boolean> = pidAlive,
): Promise<{ swept: number; stuck: boolean }> {
  let swept = 0, stuck = false;
  try {
    for (const name of await readdir(dir)) {
      const m = re.exec(name);
      if (m === null) continue;
      const pid = Number(m[1]);
      if (!Number.isSafeInteger(pid) || (await isAlive(pid))) continue;
      const path = join(dir, name);
      try { if ((await lstat(path)).isFile()) { await unlink(path); swept++; } }
      catch (e) { if (errCode(e) !== "ENOENT") stuck = true; /* raced (gone) or unremovable — the next sweep's */ }
    }
  } catch (e) { if (errCode(e) !== "ENOENT") stuck = true; /* an unlistable folder sweeps nothing */ }
  return { swept, stuck };
}

// ── the platform dispatch (for P2-M2-T3's `key set` / `delete` / `delete-all`) ─────────────────────────

/** Both stores' seams; `platform` picks the store (darwin → the Keychain, any other → the file store). */
export type AppKeyDeps = KeyStoreDeps & FileKeyStoreDeps;

export function appKeySet(raw: string, deps: AppKeyDeps = {}): Promise<SetKeyOutcome | FileSetKeyOutcome> {
  return (deps.platform ?? process.platform) === "darwin" ? keychainSet(raw, deps) : fileKeySet(raw, deps);
}
export function appKeyDelete(keyId: string, deps: AppKeyDeps = {}): Promise<DeleteKeyOutcome> {
  return (deps.platform ?? process.platform) === "darwin" ? keychainDelete(keyId, deps) : fileKeyDelete(keyId, deps);
}
export function appKeyDeleteAll(deps: AppKeyDeps = {}): Promise<DeleteAllOutcome> {
  return (deps.platform ?? process.platform) === "darwin" ? keychainDeleteAll(deps) : fileKeyDeleteAll(deps);
}
