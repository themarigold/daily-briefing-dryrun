// src/keyFile.ts — what an app key FILE is (provider-fallback spec r9 §6 "Linux" and "Strict reader"; hub Q26): its
// name, its size cap, the strict reader's parameters for it, and whether a configured `apiKeyFile` path names one.
//
// ONE module for the two decisions a key file feeds, so they cannot drift (P2-M5-T1):
//   • `isAppOwnedKey` (src/providerList.ts) — may this key travel only over https? (the insecure-endpoint rule,
//     `provider test`, `config validate`);
//   • the morning `apiKeyFile` rung (src/apiKey.ts) — must this path be read by the strict reader?
// Both start from the one relation (`appKeyFileRelation`, its steps shared by both shells — "Two shells" below). They
// differ in two places, each the safe direction for its own question:
//   1. a walk of `keys/` that cannot complete ("unknown") is app-owned for the https rule (fail closed: it only ever
//      costs a plain-http entry, PR 1 final review round 2 L2) but NOT strict for the morning rung — there, failing
//      closed would refuse EVERY user's own `apiKeyFile` whenever one corner of `keys/` is unreadable (a root-owned
//      `keys/` from one sudo run is enough), which breaks requirement 9 ("existing configs are unaffected") — UNLESS
//      the file has more than one hard link (P2-M5-T1 checkpoint LOW 1): only a multi-link file can share an inode
//      with a key the walk could not reach, so an ordinary single-link user file keeps today's lax read;
//   2. the morning rung is ALSO strict for any path whose directory entry sits in `keys/` even when the file it names
//      is not an app key (a symlink in `keys/` pointing out): the strict reader then refuses it as a symlink, where
//      the lax check would have read the file it points at. For the https rule that path is not app-owned (Q26: the
//      key it names is not the app's), and nothing is sent anyway — the strict read refuses it first.
// So every file the https rule calls app-owned for certain is read strictly (the agreement test in
// test/apiKey.test.ts). And no path the morning rung reads laxly opens a key the app wrote — the app writes only
// single-link files directly in `keys/`, so a path reaching one is caught as: its canonical or realpath form inside
// `keys/`, a symlink alias included (`app-key`); a `..` alias, by its directory entry in `keys/` (`entryInKeys`); a
// hard link, by the walk (`app-key`) or, when the walk is incomplete, by its second link (`unknown` + nlink > 1).
//
// TWO SHELLS, ONE TABLE (PR 2 final harden round 3, M1). Every rule below is written once, as steps (src/strictFile.ts
// "PATH STEPS"), and run by one of two shells: the morning rung's `readsAsAppKeyFile`, `isAppKeyFileName` and
// `strictReadFolder` are ASYNC (`fs/promises`), so a stat or walk stalled on a dead mount cannot block the event loop
// and the walk's per-attempt deadline (src/core.ts `attemptDeadlineMs`) and `provider test`'s (`probeDeadlineMs`) still
// fire; `appKeyFileRelation` is SYNC, for `isAppOwnedKey`, whose callers are synchronous — see the residual there.
// `appKeyFileOwnershipSteps` hands the same steps to `config validate`'s ownership rows, which run them on the async
// shell under a deadline (P3-M1-T1 checkpoint MED).
//
// No proc import, deliberately: src/apiKey.ts imports proc's `run` and therefore may not import the key store
// (isolation.meta's "no src/ file that uses the key store can hand it proc's run").
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import {
  ask, canonicalPathSteps, foldPath, runFsAsync, runFsSync,
  type AsyncFsOps, type FsStats, type FsSteps, type StrictReadOpts,
} from "./strictFile";

/** The most bytes a key file may hold on read (a key is at most 512 characters; written with no newline). */
export const KEY_FILE_MAX_BYTES = 1024;
/** THE ONE spelling of an app key id, `k-` + 12 lowercase hex (PR 2 final harden round 1, B11): every key-id pattern
 *  in the engine is built from this source — the two below, the key file's and the store's temp file's names
 *  (src/keyStore.ts), and the ownership predicate's command-word patterns (src/providerList.ts). */
export const KEY_ID_SOURCE = "k-[0-9a-f]{12}";
/** VALIDATION: an id the store writes (`newKeyId` is lowercase hex) and `key delete --id` accepts. Lowercase only. */
export const KEY_ID_RE = new RegExp(`^${KEY_ID_SOURCE}$`);
/** OWNERSHIP DETECTION (`isAppOwnedKey`'s account selector): the same id, case-insensitive. Deliberately wider — a
 *  hand-written `-a K-…` may still reach an app item, and for the https rule the ambiguous case must go strict. */
export const KEY_ID_ANYCASE_RE = new RegExp(`^${KEY_ID_SOURCE}$`, "i");
/** A key file's basename. */
export const KEY_FILE_RE = new RegExp(`^${KEY_ID_SOURCE}\\.key$`);

/** The strict reader's parameters for a key file in `dir`: the store's read-back, and the morning `apiKeyFile` rung's
 *  (P2-M5-T1). */
export function keyFileReadOpts(dir: string): StrictReadOpts {
  return { folder: dir, idPattern: KEY_FILE_RE, maxBytes: KEY_FILE_MAX_BYTES };
}

/** `app-key`: the path names an app key file; `not-app-key`: it does not; `unknown`: the inode walk of `keys/` could
 *  not complete, so a hard link into an unread corner cannot be ruled out. */
export type KeyFileRelation = "app-key" | "not-app-key" | "unknown";

/** `given` as the reader opens it: a relative path against the process cwd by plain CONCATENATION, never `resolve`
 *  (PR 1 final review round 2, H1: `resolve`/`join` fold `..` lexically, which is exactly the answer the kernel does
 *  NOT give through a symlink). */
const asOpened = (given: string): string => (isAbsolute(given) ? given : `${process.cwd()}${sep}${given}`);
const hasDotDot = (given: string): boolean => given.split(/[\\/]/).includes("..");

/** Is `file` strictly inside `dir`? Both already in one comparable form. */
const strictlyInside = (file: string, dir: string): boolean =>
  file.startsWith(dir.endsWith(sep) ? dir : dir + sep) && file.length > dir.length + 1;

/**
 * Does the configured `apiKeyFile` `given` name an app key file under `keys` (hub Q26)? (1) Without a `..` segment,
 * its canonical form strictly inside the canonical `keys/`, or (for an existing file) its realpath inside the
 * folder's, is `app-key`; (2) otherwise — a `..` segment, or a path the lexical tests call outside — it is `app-key`
 * iff `stat` (following symlinks, as the kernel opens it) gives the same (dev, ino) as a regular file anywhere under
 * `keys/` (walked without following symlinks): that catches the `..` symlink alias (codex HIGH) and a hard link.
 * `keys/` missing, or the file missing or unstattable → `not-app-key`; a walk that cannot complete → `unknown`.
 */
export function appKeyFileRelation(given: string, keys: string): KeyFileRelation {
  return runFsSync(relationSteps(given, keys)).relation;
}

/**
 * `appKeyFileRelation`, plus the app key id the file it names is stored under (P3-M1-T0: `config validate`'s
 * `appKeyId`, through `appKeyOwnership` in src/providerList.ts) — as STEPS, for a shell of the caller's choosing: the
 * sync predicate runs them on `runFsSync`, `config validate`'s rows on the async shell under a deadline
 * (`appKeyOwnershipBounded`, P3-M1-T1 checkpoint MED). The SAME steps, in the same order — the id is read off names the
 * relation already computed, never by another fs call: the canonical (or real) path's basename when the lexical test
 * decided, the matching entry's name when the inode walk did. `id` only for `app-key`, and only when that basename is
 * `<id>.key` (case-insensitively, reported lowercase — the store's own form); `unknown` never has one.
 */
export function* appKeyFileOwnershipSteps(given: string, keys: string): FsSteps<{ relation: KeyFileRelation; id?: string }> {
  const r = yield* relationSteps(given, keys);
  const id = r.relation === "app-key" && r.name !== undefined ? KEY_FILE_ANYCASE_RE.exec(r.name)?.[1]?.toLowerCase() : undefined;
  return id !== undefined ? { relation: r.relation, id } : { relation: r.relation };
}
/** A key file's basename, case-insensitively, capturing the id — OWNERSHIP DETECTION's width (as `KEY_ID_ANYCASE_RE`). */
const KEY_FILE_ANYCASE_RE = new RegExp(`^(${KEY_ID_SOURCE})\\.key$`, "i");

/** The relation, and the basename of the file it was decided on (`app-key` only; see `appKeyFileOwnershipSteps`). */
type Relation = { relation: KeyFileRelation; name?: string };

function* relationSteps(given: string, keys: string): FsSteps<Relation> {
  const path = asOpened(given);
  // ⚠ A `..` segment skips the lexical tests (codex HIGH): `canonicalPath` folds `..` BEFORE resolving symlinks, so
  // `<outside>/link/../k.key` with `link → <keys>/sub` reads as outside while the kernel opens `<keys>/k.key` — and
  // bun 1.3.14's `realpathSync.native` folds it the same way (MEASURED 2026-10-16). Only the inode test sees it.
  if (!hasDotDot(given)) {
    const canonical = yield* canonicalPathSteps(path);
    if (strictlyInside(canonical, yield* canonicalPathSteps(keys))) return { relation: "app-key", name: basename(canonical) };
    const real = yield* realpathOf(path);
    if (real !== undefined && strictlyInside(foldPath(real), foldPath((yield* realpathOf(keys)) ?? (yield* canonicalPathSteps(keys))))) return { relation: "app-key", name: basename(real) };
  }
  return yield* sameFileUnderKeys(path, keys);
}

/**
 * The morning `apiKeyFile` rung's question (P2-M5-T1): must `given` be read by the strict reader? Yes when it names an
 * app key file for certain (`appKeyFileRelation` → `app-key`), when the relation is `unknown` and the file has more
 * than one hard link (it may be a second name for a key the walk could not reach — checkpoint LOW 1), or when the
 * directory entry the kernel opens — the final component NOT followed — sits in `keys/` (a symlink there pointing
 * out, or a missing name there). An `unknown` relation on a single-link file does not make a path strict (header,
 * difference 1). ASYNC (header, "Two shells"); `fs` is injected only by tests.
 */
export function readsAsAppKeyFile(given: string, keys: string, fs?: AsyncFsOps): Promise<boolean> {
  return runFsAsync(readsSteps(given, keys), fs);
}

function* readsSteps(given: string, keys: string): FsSteps<boolean> {
  const path = asOpened(given);
  const { relation } = yield* relationSteps(given, keys);
  return relation === "app-key" || (relation === "unknown" && (yield* linkCount(path)) > 1) || (yield* entryInKeys(path, keys));
}

/**
 * The folder to hand the strict reader for the morning rung's `given` (checkpoint LOW 2). The strict reader demands
 * `path === join(folder, basename(path))`, so a genuine key whose configured path reaches `keys/` through a
 * DIFFERENT symlinked ancestor than `keys` itself spells it would be refused `name-invalid`. When `given` has no `..`
 * segment and its parent (a relative one against the cwd, as the kernel opens it) is canonically `keys`, the parent AS
 * CONFIGURED is the folder — the reader's lstat still refuses it if that final folder is itself a symlink. Otherwise
 * `keys`, which refuses every other spelling. (The `..` test is belt and braces: `join` folds `..`, so the reader's
 * exact-name test would refuse such a path anyway — and `canonicalPath` folds it lexically, which is not the kernel's
 * answer through a symlink, so it must never decide the folder.)
 * ⚠ `canonicalPath` also CASE-FOLDS on darwin, so on a case-sensitive volume a sibling `…/Keys/` compares equal to
 * `…/keys/` (P2-M5-T4 checkpoint LOW 5). So the parent is trusted only when its realpath is ALSO byte-equal to the
 * folder's, compared WITHOUT folding: the kernel's own answer, which on a case-insensitive volume restores the on-disk
 * case (measured, bun 1.3.14 `realpathSync.native`), so a genuine alias still matches. Either missing ⇒ `keys`.
 * Residual, accepted: the check is made BEFORE the reader opens anything, so a folder renamed or an ancestor swapped
 * for a symlink between this check and the reader's own `lstat`/`open` is not seen here. The reader still applies its
 * checks to whatever folder and file it is handed (folder not a symlink, the user's, 0700; file O_NOFOLLOW, the
 * user's, 0600, one link), so the swap can only point it at another folder that passes all of them.
 * ASYNC (header, "Two shells"); `fs` is injected only by tests.
 */
export function strictReadFolder(given: string, keys: string, fs?: AsyncFsOps): Promise<string> {
  return runFsAsync(strictReadFolderSteps(given, keys), fs);
}

function* strictReadFolderSteps(given: string, keys: string): FsSteps<string> {
  if (hasDotDot(given)) return keys;
  const parent = dirname(given);
  if ((yield* canonicalPathSteps(parent)) !== (yield* canonicalPathSteps(keys))) return keys;
  const real = yield* realpathOf(parent);
  return real !== undefined && real === (yield* realpathOf(keys)) ? parent : keys;
}

/** `stat` (followed, as the kernel opens it) link count; 0 when unstattable. Never throws. */
function* linkCount(path: string): FsSteps<number> {
  const st = yield* ask<FsStats>("stat", path);
  return st.ok ? st.v.nlink : 0;
}

/** The morning rung's name test, judged on the CANONICAL path (spec §6) — so a symlinked alias cannot borrow a good
 *  name from its own spelling — and on the name as configured, since the canonical form is case-folded on darwin
 *  (`K-…AB.key` folds to a good name; the strict reader would refuse it anyway, but by a vaguer reason). ASYNC
 *  (header, "Two shells"); `fs` is injected only by tests. */
export async function isAppKeyFileName(given: string, fs?: AsyncFsOps): Promise<boolean> {
  return KEY_FILE_RE.test(basename(await runFsAsync(canonicalPathSteps(asOpened(given)), fs))) && KEY_FILE_RE.test(basename(given));
}

/** Does `path`'s directory entry sit in `keys` or a folder under it? `path.dirname` does not fold `..`, so the parent
 *  is the one the kernel looks the last component up in. Without `..`, by canonical form; with it, only `keys/` itself
 *  is recognised, by the parent's (dev, ino) — the store writes no subfolders. Never throws. */
function* entryInKeys(path: string, keys: string): FsSteps<boolean> {
  const parent = dirname(path);
  if (!hasDotDot(path)) {
    const p = yield* canonicalPathSteps(parent);
    const k = yield* canonicalPathSteps(keys);
    if (p === k || strictlyInside(p, k)) return true;
  }
  const a = yield* ask<FsStats>("stat", parent);
  if (!a.ok) return false;
  const b = yield* ask<FsStats>("stat", keys);
  if (!b.ok) return false;
  return a.v.isDirectory() && a.v.dev === b.v.dev && a.v.ino === b.v.ino;
}

/** Does `path`, as the kernel opens it (`stat` follows symlinks), name the same (dev, ino) as a regular file anywhere
 *  under `keys` (walked WITHOUT following symlinks)? The file missing or unstattable ⇒ `not-app-key`, and `keys/`
 *  itself missing ⇒ `not-app-key` (the read then fails as it does today). ⚠ A walk that cannot COMPLETE — a folder
 *  under `keys/` that cannot be listed (a 0300 folder still opens files by name), an entry that cannot be `lstat`ed,
 *  the depth bound — is `unknown` (PR 1 final review round 2, L2), so an unreadable corner can never hide a managed
 *  key from a caller that fails closed. */
function* sameFileUnderKeys(path: string, keys: string): FsSteps<Relation> {
  const NOT: Relation = { relation: "not-app-key" };
  const st = yield* ask<FsStats>("stat", path);
  if (!st.ok || !st.v.isFile()) return NOT;
  const target = { dev: st.v.dev, ino: st.v.ino };
  // The ROOT is `stat`ed (round 3 L1): `<state>/keys` may itself be a symlink to the folder, which the `readdir` below
  // follows anyway; only the walk inside it refuses to follow links (`lstat`). A dangling root link reads as ENOENT.
  const root = yield* ask<FsStats>("stat", keys);
  if (!root.ok) return root.code === "ENOENT" || root.code === "ENOTDIR" ? NOT : { relation: "unknown" };   // else keys/ there but unreadable
  if (!root.v.isDirectory()) return NOT;
  const INCOMPLETE = Symbol("incomplete");
  // The FIRST matching entry's name (P3-M1-T0's id); the walk stops there, as it always has.
  function* walk(dir: string, depth: number): FsSteps<string | false | typeof INCOMPLETE> {
    if (depth > 8) return INCOMPLETE;                                // the folder is small and flat; a bound anyway
    const names = yield* ask<string[]>("readdir", dir);
    if (!names.ok) return INCOMPLETE;
    let incomplete = false;
    for (const n of names.v) {
      const p = join(dir, n);
      const e = yield* ask<FsStats>("lstat", p);
      if (!e.ok) { incomplete = true; continue; }
      if (e.v.isFile() && e.v.dev === target.dev && e.v.ino === target.ino) return n;
      if (e.v.isDirectory()) {
        const r = yield* walk(p, depth + 1);
        if (typeof r === "string") return r;
        if (r === INCOMPLETE) incomplete = true;
      }
    }
    return incomplete ? INCOMPLETE : false;
  }
  const r = yield* walk(keys, 0);
  return typeof r === "string" ? { relation: "app-key", name: r } : r === INCOMPLETE ? { relation: "unknown" } : NOT;
}

/** A path's realpath as the kernel resolves it, or undefined when it does not exist. */
function* realpathOf(p: string): FsSteps<string | undefined> {
  const r = yield* ask<string>("realpathNative", p);
  return r.ok ? r.v : undefined;
}
