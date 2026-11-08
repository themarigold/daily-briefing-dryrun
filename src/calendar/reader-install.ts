// src/calendar/reader-install.ts — the ATTENDED install/update of the Mac Calendar Reader's copy (v0.3.0 plan
// M10b; spec r4 §4.1 "Installed copy, attended only").
//
// `calendar connect mac` (and Settings' "Allow access", which runs it) copies the SHIPPED reader to
// `<state>/calendar/reader/Daily Briefing Calendar Reader.app`, strips quarantine and re-signs the copy with the
// existing stable local identity under `local.daily-briefing.calendar` — the managed-copy signing exported from
// `src/schedule/install.ts` (`signManagedCopy`), whose every OS command leaves through the injected `exec`.
//
// ⚠ ONLY AN ATTENDED FLOW CALLS THIS. Signing touches the login keychain (and may raise a keychain prompt), so a
// scheduled run never copies or signs: it reads with the existing copy and, when that copy is older than this
// engine's reader (`CALENDAR_READER_VERSION`), reports the `helper-outdated` NOTICE beside its read status.
//
// The copy is assembled under a temporary name in the same folder, signed there, and swapped into place (the old copy
// moved aside first, restored if the swap fails), so a failure part-way leaves the old copy (or nothing), never half a
// bundle under the real name. An interruption mid-swap can leave the old copy under its aside name; the next attended
// install puts it back first. The executable's mode is set explicitly (0755): a packager that dropped the exec bit
// must not leave a reader that cannot start.
import { chmod, cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { signManagedCopy, type Exec } from "../schedule/install";
import { calendarStateDir } from "./health";
import {
  CALENDAR_READER_IDENTIFIER, calendarReaderCopy, calendarReaderDir, findShippedReader, readerBundlePresent,
  readerBundleVersion, readerExecutable,
} from "./reader";

/** Ensure a folder is a real directory owned by this user with mode 0700, creating it when absent. Returns a
 *  reason code when it cannot be trusted (a symlink, not a directory, another user's) or created. */
export async function ensurePrivateDir(path: string): Promise<string | undefined> {
  try { await mkdir(path, { mode: 0o700 }); } catch (e) { if ((e as { code?: string }).code !== "EEXIST") return "dir-create-failed"; }
  const st = await lstat(path).catch(() => undefined);
  if (st === undefined) return "dir-create-failed";
  if (st.isSymbolicLink()) return "dir-symlink";
  if (!st.isDirectory()) return "dir-not-directory";
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return "dir-owner";
  if ((st.mode & 0o077) !== 0) await chmod(path, 0o700).catch(() => undefined);
  return undefined;
}

/** `<state>/calendar` and `<state>/calendar/reader`, each checked by `ensurePrivateDir`. */
export async function ensureReaderDir(stateDir: string): Promise<string | undefined> {
  try { await mkdir(stateDir, { recursive: true, mode: 0o700 }); } catch { return "dir-create-failed"; }
  for (const dir of [calendarStateDir(stateDir), calendarReaderDir(stateDir)]) {
    const bad = await ensurePrivateDir(dir);
    if (bad) return bad;
  }
  return undefined;
}

export type ReaderInstallDeps = {
  stateDir: string;
  /** The exec `signManagedCopy` drives `xattr`, `security` and `codesign` through. */
  exec: Exec;
  home: string;
  identity: string;
  say: (line: string) => void;
  warn: (line: string) => void;
  /** Where the shipped reader is; defaults to `findShippedReader()`. TEST seam. */
  findShipped?: () => Promise<string | null>;
};

export type ReaderInstallResult =
  | { status: "ok"; action: "copied" | "up-to-date"; signature?: "stable" | "adhoc" | "unsigned" }
  | { status: "helper-missing" }
  | { status: "malformed"; reason: string };

const TMP_PREFIX = ".copy-";
/** The previous copy during a swap. Its own prefix: the temp-copy sweep must never delete a working copy. */
const ASIDE_PREFIX = ".old-";
/** A temp copy older than this is an interrupted install's leftover; a younger one may be a concurrent install's. */
const TMP_STALE_MS = 10 * 60_000;

/** Install or update the copy. Never throws. `up-to-date` (no copy, no signing, no keychain) when the copy is a
 *  usable bundle at least as new as the shipped one. */
export async function installReaderCopy(d: ReaderInstallDeps): Promise<ReaderInstallResult> {
  try {
    const shipped = await (d.findShipped ?? (() => findShippedReader()))();
    if (shipped === null) return { status: "helper-missing" };
    const shippedVersion = (await readerBundleVersion(shipped)) ?? 0;
    const copy = calendarReaderCopy(d.stateDir);
    const dir = calendarReaderDir(d.stateDir);
    // An interrupted swap (below) can leave the working, granted copy under an aside name with nothing at the real
    // name: put it back before anything else, so it is never swept or traded for a fresh copy. With a copy in place,
    // an aside is a finished swap's leftover. (W3 checkpoint: a rename keeps the old mtime, so an age test could not
    // tell the two apart.)
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.startsWith(ASIDE_PREFIX)) continue;
      const aside = join(dir, name);
      if (await readerBundlePresent(copy)) await rm(aside, { recursive: true, force: true }).catch(() => undefined);
      else if (await readerBundlePresent(aside)) await rename(aside, copy).catch(() => undefined);
    }
    if (await readerBundlePresent(copy)) {
      const copyVersion = await readerBundleVersion(copy);
      if (copyVersion !== null && copyVersion >= shippedVersion) return { status: "ok", action: "up-to-date" };
    }
    const bad = await ensureReaderDir(d.stateDir);
    if (bad) return { status: "malformed", reason: bad };
    // A temp copy an earlier, interrupted install left behind — not one a concurrent install is assembling.
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.startsWith(TMP_PREFIX)) continue;
      const st = await lstat(join(dir, name)).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > TMP_STALE_MS) await rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined);
    }
    const tmp = join(dir, `${TMP_PREFIX}${randomBytes(6).toString("hex")}.app`);
    try {
      await cp(shipped, tmp, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      await chmod(readerExecutable(tmp), 0o755);
      const signature = await signManagedCopy(d, tmp, d.identity, {
        identifier: CALENDAR_READER_IDENTIFIER, grant: "the macOS Calendars permission", recursive: true,
      });
      // ⚠ NEVER TRADE A WORKING COPY FOR A WORSE ONE (M10b checkpoint). The Calendars grant is tied to the stable
      // signature; a copy that could only be signed ad hoc would lose it, and an unsigned one cannot run at all.
      // So: unsigned is never installed; ad hoc replaces nothing (it may be a first install only). The old copy
      // keeps reading and reports `helper-outdated` until a signing succeeds. Checked AFTER signing (codex W3
      // review): signing can wait on a keychain prompt, and a concurrent install may have put a copy in place.
      if (signature === "unsigned" || (signature === "adhoc" && await readerBundlePresent(copy))) {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
        return { status: "malformed", reason: "sign-failed" };
      }
      if (signature === "adhoc") {
        // "First install only", made atomic (W3 checkpoint): no aside step, and a rename onto anything already at
        // the real name fails, so a copy a concurrent install landed after the check above is never replaced.
        const landed = await rename(tmp, copy).then(() => true, (e: { code?: string }) => {
          if (e.code === "ENOTEMPTY" || e.code === "EEXIST" || e.code === "ENOTDIR" || e.code === "EISDIR") return false;
          throw e;
        });
        if (landed) return { status: "ok", action: "copied", signature };
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
        return { status: "malformed", reason: "sign-failed" };
      }
      // Swap with no moment where a failure loses the working copy (codex W3 review): the old copy moves aside
      // under its own prefix (never swept as a temp copy; restored at the next install if an interruption strands
      // it), the new one takes its place, and a failed rename puts the old one back. A rename moves a planted
      // symlink itself, never its target.
      const aside = join(dir, `${ASIDE_PREFIX}${randomBytes(6).toString("hex")}.app`);
      const moved = await rename(copy, aside).then(() => true, (e: { code?: string }) => {
        if (e.code === "ENOENT") return false;
        throw e;
      });
      try {
        await rename(tmp, copy);
      } catch (e) {
        if (moved) await rename(aside, copy).catch(() => undefined);
        throw e;
      }
      if (moved) await rm(aside, { recursive: true, force: true }).catch(() => undefined);
      return { status: "ok", action: "copied", signature };
    } catch {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      return { status: "malformed", reason: "copy-failed" };
    }
  } catch {
    return { status: "malformed", reason: "copy-failed" };
  }
}
