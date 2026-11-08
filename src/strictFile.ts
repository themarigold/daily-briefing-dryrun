// src/strictFile.ts — the strict reader for an app-managed secret file, and `canonicalPath`.
//
// Extracted from the calendar-link reader (`src/calendar/link-url.ts` `fromFile`, provider-fallback plan
// P1-M1-T1) so PR 2's `<state>/keys/` files are read with exactly the same checks; the calendar reader now
// calls this with its own parameters and maps the outcomes to its reasons one for one.
//
// The checks, in order:
//   • win32 (or a platform without O_NOFOLLOW) is refused outright: there are no POSIX modes or owners to check;
//   • the FOLDER, by lstat (never followed): not a symlink, a directory, the user's own, no group/other bit;
//   • the path must be EXACTLY `join(folder, <basename>)` with a basename that matches `idPattern` — a file
//     one level down would sit in a folder nobody checked, and an unnormalized `sub/..` would be resolved
//     through `sub` by the kernel;
//   • the FILE, by lstat: not a symlink, a regular file (so a FIFO or socket is never opened at all);
//   • the open that decides, `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, then on the OPEN descriptor: regular, the
//     user's own, no group/other bit, `nlink === 1` — so what is read is exactly what was checked;
//   • at most `maxBytes` (one more is read, to tell "exactly at the cap" from "over it").
// "0600 file / 0700 folder" is a `& 0o077` mask: stricter modes (0400, 0500) are fine.
//
// ⚠ A KNOWN WINDOW, inherited from the calendar reader and unchanged by the extraction: the folder is checked
// by lstat and the file is then opened BY PATH, so a folder swapped for a symlink between the two is not seen
// by the folder checks. What is read is still bounded by the checks on the open DESCRIPTOR (O_NOFOLLOW on the
// last component, regular, the user's own, no group/other bit, one link); only the folder's own owner and
// mode are not re-proved at open time. Closing it needs an openat-style walk from a folder descriptor.
//
// NEVER THROWS, and no outcome other than `ok` carries a byte of the file or a word of an error (an error's
// message could carry a path, or worse). `text` is returned verbatim; trimming is the caller's.
import { constants, lstatSync, readdirSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

// ── PATH STEPS: one decision procedure, two I/O shells (PR 2 final harden round 3, M1) ──────────────────────────────
// The path predicates (`canonicalPath` here, src/keyFile.ts's key-file relation) are written ONCE, as generators that
// YIELD each filesystem question (`FsStep`) and receive its answer (`FsAnswer`), so the rules cannot fork. Two shells
// run them: `runFsSync` (the sync `node:fs` calls, byte for byte what the predicates made before — for callers that
// are themselves synchronous) and `runFsAsync` (`node:fs/promises`, for the morning `apiKeyFile` rung: a stat stalled
// on a dead mount then waits on the thread pool, not the event loop, so the walk's attempt deadline and `provider
// test`'s can still fire). Every answer is caught: `ok: false` carries only the error's `code`, never its message.
// MEASURED 2026-10-18, bun 1.3.14 on APFS: `realpathSync`, `realpathSync.native` and `fs/promises` `realpath` give the
// same answers (on-disk case restored, `..` folded lexically, ENOENT alike), so the async shell maps both realpath
// steps to the one async call.

/** The part of a `Stats` the path predicates read. */
export type FsStats = Pick<Stats, "dev" | "ino" | "nlink" | "isFile" | "isDirectory" | "isSymbolicLink">;
/** One filesystem question. `realpath` is `realpathSync` (what `canonicalPath` always used), `realpathNative` is
 *  `realpathSync.native` (the key-file relation's); `stat` follows symlinks, `lstat` does not. */
export type FsStep = { op: "realpath" | "realpathNative" | "stat" | "lstat" | "readdir" | "readlink"; p: string };
/** A step's answer: the value, or the caught error's `code` (undefined when it had none). */
export type FsAnswer<T> = { ok: true; v: T } | { ok: false; code: string | undefined };
/** A path predicate written as steps. */
export type FsSteps<T> = Generator<FsStep, T, unknown>;
/** The async shell's filesystem, injectable by tests (a stalled mount). Each call rejects as `fs/promises` does. */
export type AsyncFsOps = { [K in FsStep["op"]]: (p: string) => Promise<K extends "readdir" ? string[] : K extends "realpath" | "realpathNative" | "readlink" ? string : FsStats> };

/** The production async filesystem: `node:fs/promises`. */
export const ASYNC_FS: AsyncFsOps = {
  realpath: (p) => realpath(p),
  realpathNative: (p) => realpath(p),
  stat: (p) => stat(p),
  lstat: (p) => lstat(p),
  readdir: (p) => readdir(p),
  readlink: (p) => readlink(p),
};
const SYNC_FS: { [K in FsStep["op"]]: (p: string) => unknown } = {
  realpath: (p) => realpathSync(p),
  realpathNative: (p) => realpathSync.native(p),
  stat: (p) => statSync(p),
  lstat: (p) => lstatSync(p),
  readdir: (p) => readdirSync(p),
  readlink: (p) => readlinkSync(p),
};
const errorCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

/** Ask one question (inside a `FsSteps` generator: `const r = yield* ask<FsStats>("stat", p)`). */
export function* ask<T>(op: FsStep["op"], p: string): FsSteps<FsAnswer<T>> {
  return (yield { op, p }) as FsAnswer<T>;
}
/** Run steps on the sync `node:fs` calls. */
export function runFsSync<T>(steps: FsSteps<T>): T {
  let n = steps.next();
  while (!n.done) {
    let a: FsAnswer<unknown>;
    try { a = { ok: true, v: SYNC_FS[n.value.op](n.value.p) }; } catch (e) { a = { ok: false, code: errorCode(e) }; }
    n = steps.next(a);
  }
  return n.value;
}
/** Run steps on an async filesystem (`ASYNC_FS` unless a test injects one). */
export async function runFsAsync<T>(steps: FsSteps<T>, fs: AsyncFsOps = ASYNC_FS): Promise<T> {
  let n = steps.next();
  while (!n.done) {
    let a: FsAnswer<unknown>;
    try { a = { ok: true, v: await fs[n.value.op](n.value.p) }; } catch (e) { a = { ok: false, code: errorCode(e) }; }
    n = steps.next(a);
  }
  return n.value;
}

/** `p` as the filesystem will find it, for COMPARISON only (final harden r2): `path.resolve` (so `<state>//calendar`
 *  and `<state>/./calendar` collapse), every symlink in the longest EXISTING prefix resolved (realpath — a dangling
 *  symlink is followed by hand, since a write through it creates its target), and on darwin and Windows case-folded
 *  and NFC-normalised (APFS and NTFS are case-insensitive by default, and APFS normalisation-insensitive), so
 *  `<state>/Calendar/…` is `<state>/calendar/…`. Folding a case-sensitive volume only refuses MORE. Never throws. */
export function canonicalPath(p: string): string {
  return runFsSync(canonicalPathSteps(p));
}

/** `canonicalPath` as steps (see PATH STEPS above), for a shell of the caller's choosing. */
export function* canonicalPathSteps(p: string): FsSteps<string> {
  let head = resolve(p);
  const tail: string[] = [];
  for (let hops = 0; ; ) {
    const real = yield* ask<string>("realpath", head);
    if (real.ok) { head = real.v; break; }                         // else missing or dangling: look closer
    if (hops < 40) {
      const l = yield* ask<FsStats>("lstat", head);
      if (l.ok && l.v.isSymbolicLink()) {
        hops++;
        const target = yield* ask<string>("readlink", head);
        if (target.ok) { head = resolve(dirname(head), target.v); continue; }
      }
    }                                                                // else not there at all
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  const full = tail.length > 0 ? join(head, ...tail) : head;
  return foldPath(full);
}

/** Case-fold a path where the default volume does (darwin, win32): NFC, then lower case; elsewhere unchanged. The one
 *  copy (`canonicalPath` above and `isAppOwnedKey`'s realpath comparison share it — L8). */
export function foldPath(p: string): string {
  return process.platform === "darwin" || process.platform === "win32" ? p.normalize("NFC").toLowerCase() : p;
}

/** Something was there and was refused, unread. */
export type StrictRefusedReason =
  | "unsupported-platform"   // needs O_NOFOLLOW and POSIX ownership and modes (not Windows)
  | "dir-symlink"
  | "dir-not-directory"
  | "dir-owner"
  | "dir-permissions"        // any group or other bit on the folder
  | "name-invalid"           // not a direct child of the folder, or a basename outside `idPattern`
  | "file-symlink"
  | "file-not-regular"
  | "file-owner"
  | "file-permissions"       // any group or other bit on the file
  | "file-hardlinked"
  | "too-long";              // over `maxBytes`

export type StrictReadOutcome =
  | { status: "ok"; text: string }
  | { status: "missing"; reason: "file-missing" }   // the folder or the file does not exist
  | { status: "refused"; reason: StrictRefusedReason }
  | { status: "failed"; reason: "read-error" };     // an unexpected error from lstat, open or read

export type StrictReadOpts = {
  /** The folder the file must sit directly in; checked by lstat. */
  folder: string;
  /** The file's basename must pass this (a `RegExp`, or any `{ test }` — the calendar reader's grammar is on
   *  the id, not the name). */
  idPattern: { test(basename: string): boolean };
  /** The most bytes accepted; one more is `too-long`. */
  maxBytes: number;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Opens the file; defaults to `fs/promises`' `open`. Injected so its FLAGS are pinned: the race O_NOFOLLOW
   *  and O_NONBLOCK guard (a symlink or a FIFO swapped in between the lstat and the open) cannot be staged. */
  open?: (path: string, flags: number) => ReturnType<typeof open>;
  /** Is this folder or file the user's own? Defaults to "its uid is this process's uid". Injected because a
   *  test cannot chown a file to another user without root. */
  ownerCheck?: (st: { uid: number }, which: "dir" | "file") => boolean;
};

const errCode = (e: unknown): unknown => (e as { code?: unknown } | null)?.code;

/** Read `path` under the checks in the header. Never throws. */
export async function readStrictFile(path: string, opts: StrictReadOpts): Promise<StrictReadOutcome> {
  try {
    return await readChecked(path, opts);
  } catch {
    return { status: "failed", reason: "read-error" };
  }
}

async function readChecked(path: string, opts: StrictReadOpts): Promise<StrictReadOutcome> {
  const refused = (reason: StrictRefusedReason): StrictReadOutcome => ({ status: "refused", reason });
  const missing: StrictReadOutcome = { status: "missing", reason: "file-missing" };
  const failed: StrictReadOutcome = { status: "failed", reason: "read-error" };
  const NOFOLLOW = constants.O_NOFOLLOW;
  if ((opts.platform ?? process.platform) === "win32" || NOFOLLOW === undefined) return refused("unsupported-platform");
  const uid = process.getuid?.();
  const isOwn = opts.ownerCheck ?? ((st: { uid: number }) => uid !== undefined && st.uid === uid);
  const grantsOthers = (st: Stats): boolean => (st.mode & 0o077) !== 0;

  // The folder, by lstat: never followed.
  let d: Stats;
  try { d = await lstat(opts.folder); } catch (e) { return errCode(e) === "ENOENT" ? missing : failed; }
  if (d.isSymbolicLink()) return refused("dir-symlink");
  if (!d.isDirectory()) return refused("dir-not-directory");
  if (!isOwn(d, "dir")) return refused("dir-owner");
  if (grantsOthers(d)) return refused("dir-permissions");

  // The name: EXACTLY `join(folder, <basename>)`, string for string, under the caller's grammar. Not a lexical
  // dirname comparison: `<folder>/sub/../<name>` normalizes to a direct child, but the kernel resolves it
  // THROUGH `sub`, which may be a symlink out of the folder (P1-M1 checkpoint MED). So `.`, `..` and doubled
  // separators are refused, not folded.
  if (path !== join(opts.folder, basename(path)) || !opts.idPattern.test(basename(path))) return refused("name-invalid");

  // The file: lstat first, for a precise reason and so a FIFO or socket is never opened at all…
  let l: Stats;
  try { l = await lstat(path); } catch (e) { return errCode(e) === "ENOENT" ? missing : failed; }
  if (l.isSymbolicLink()) return refused("file-symlink");
  if (!l.isFile()) return refused("file-not-regular");

  // …then the open that actually decides: O_NOFOLLOW refuses a symlink swapped in since the lstat (ELOOP),
  // O_NONBLOCK keeps a FIFO swapped in from blocking the open, and every check is repeated on the OPEN
  // descriptor.
  let fh: Awaited<ReturnType<typeof open>>;
  try { fh = await (opts.open ?? open)(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) {
    const c = errCode(e);
    return c === "ELOOP" ? refused("file-symlink") : c === "ENOENT" ? missing : failed;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return refused("file-not-regular");
    if (!isOwn(st, "file")) return refused("file-owner");
    if (grantsOthers(st)) return refused("file-permissions");
    if (st.nlink !== 1) return refused("file-hardlinked");
    const buf = Buffer.alloc(opts.maxBytes + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, null);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n > opts.maxBytes) return refused("too-long");
    return { status: "ok", text: buf.subarray(0, n).toString("utf8") };
  } finally {
    await fh.close().catch(() => undefined);
  }
}


/** Write `text` to `path` atomically and PRIVATELY (PR 1 final review round 1, M9): a unique exclusive temp file
 *  beside it, created 0600 whatever the umask (`wx`, so a planted file or symlink at the temp name is never followed),
 *  then renamed over `path` — the rename carries the 0600 mode, and a reader sees the old record or the new one,
 *  never half of one. The temp file is removed on any failure after it was created (never one this call did not create),
 *  and the failure is THROWN (callers decide whether a lost write matters); a success sweeps stale crash leftovers. The one writer of `account-state.json`, `provider-status.json` and `last-failure.json`. */
export async function writePrivateAtomic(path: string, text: string): Promise<void> {
  // Unique PER CALL, not per process: two concurrent writers sharing one temp name would race the rename.
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  // The parent folder is created when missing, as `Bun.write` did (round 2 L6); an existing folder is left as it is.
  await mkdir(dirname(path), { recursive: true });
  // Only a temp file THIS call created is ever removed (round 3 L4): an `EEXIST` from the exclusive open means the
  // name is someone else's, and unlinking it would destroy their write.
  let created = false;
  try {
    const fh = await open(tmp, "wx", 0o600);
    created = true;
    try { await fh.writeFile(text); } finally { await fh.close(); }
    await rename(tmp, path);
  } catch (e) {
    if (created) { try { await unlink(tmp); } catch { /* already gone */ } }
    throw e;
  }
  await sweepStaleTemps(path);
}

/** A crash leftover: a `<basename>.tmp-*` sibling this old is no live writer's (a write takes milliseconds). */
export const STALE_TEMP_MS = 10 * 60 * 1000;

/** Best effort, after a successful write (round 3 L4): remove `<basename>.tmp-*` regular files beside `path` older than
 *  `STALE_TEMP_MS` — what a writer killed between its open and its rename leaves behind. Never throws. */
async function sweepStaleTemps(path: string): Promise<void> {
  const prefix = `${basename(path)}.tmp-`;
  try {
    const dir = dirname(path);
    const cutoff = Date.now() - STALE_TEMP_MS;
    for (const name of await readdir(dir)) {
      if (!name.startsWith(prefix)) continue;
      try {
        const st = await lstat(join(dir, name));
        if (st.isFile() && st.mtimeMs < cutoff) await unlink(join(dir, name));
      } catch { /* raced or unremovable: a stale file is only clutter */ }
    }
  } catch { /* an unlistable folder: nothing to sweep */ }
}
