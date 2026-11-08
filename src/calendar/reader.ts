// src/calendar/reader.ts — WHERE the Mac Calendar Reader lives and WHICH one it is (v0.3.0 plan M10a/M10b; spec r4
// §4.1). Names, paths, the version handshake and the OS check. Nothing here spawns or writes.
//
//   shipped   inside the desktop app, `Daily Briefing.app/Contents/Resources/<READER>.app` (the engine runs as the
//             app's sidecar from `Contents/MacOS/`), or beside a CLI binary from the release asset / Homebrew
//             (`<bin dir>/<READER>.app`, `<bin dir>/../share/daily-briefing/<READER>.app`);
//   copy      `<state>/calendar/reader/<READER>.app`, installed and re-signed ONLY by an attended
//             `calendar connect mac` (`./reader-install.ts`); every read uses it, a scheduled run never copies;
//   run/      `<state>/calendar/reader/run/` (0700) — the FIFOs, BESIDE the bundle, never inside it (writing inside a
//             signed bundle breaks its seal); the helper derives it from its own bundle location.
//
// ⚠ THE FILE NAME IS THE USER-FACING NAME (gate G1): the Calendars dialog and Privacy & Security show the bundle's
// FILE name, not CFBundleName; the executable carries the same name because Background Activity lists a launchd job
// by its executable. Pinned against reader/Info.plist by test/calendar-reader-source.test.ts.
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { release } from "node:os";
import { calendarStateDir } from "./health";

export const CALENDAR_READER_NAME = "Daily Briefing Calendar Reader";
export const CALENDAR_READER_APP = `${CALENDAR_READER_NAME}.app`;
/** The code-signing identifier the copy is re-signed under (spec §4.1); also the bundle's CFBundleIdentifier. */
export const CALENDAR_READER_IDENTIFIER = "local.daily-briefing.calendar";
/** The reader this engine was built with: reader/Info.plist's CFBundleVersion (an integer). A copy older than this
 *  reports the `helper-outdated` notice and keeps reading; `calendar connect mac` (or Settings) updates it. Bump both
 *  together whenever reader/Sources changes. Version 2 (redesign C): the read's `url` field and its
 *  `--refresh-wait <0…2>` argument, which a version-1 copy refuses. */
export const CALENDAR_READER_VERSION = 2;

export function calendarReaderDir(stateDir: string): string {
  return join(calendarStateDir(stateDir), "reader");
}
export function calendarReaderCopy(stateDir: string): string {
  return join(calendarReaderDir(stateDir), CALENDAR_READER_APP);
}
export function calendarReaderRunDir(stateDir: string): string {
  return join(calendarReaderDir(stateDir), "run");
}
export function readerExecutable(app: string): string {
  return join(app, "Contents", "MacOS", CALENDAR_READER_NAME);
}

/** macOS 14 (Darwin 23) or later — the helper's floor (`LSMinimumSystemVersion`, EventKit's full-access API).
 *  `osRelease` is `os.release()`, e.g. "23.6.0". Anything unreadable is "not supported". */
export function macOsSupported(osRelease: string = release()): boolean {
  const major = Number.parseInt(osRelease.split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major >= 23;
}

/** A bundle's CFBundleVersion as an integer, read from its XML Info.plist; `null` when absent or unreadable. The
 *  helper's own plist is XML (reader/build.sh copies it verbatim; codesign does not rewrite it). */
export async function readerBundleVersion(app: string): Promise<number | null> {
  try {
    const plist = join(app, "Contents", "Info.plist");
    const st = await lstat(plist);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const m = /<key>CFBundleVersion<\/key>\s*<string>\s*(\d{1,9})\s*<\/string>/.exec(await readFile(plist, "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Is this a usable reader bundle: a real directory (not a symlink) holding its executable as a regular file? */
export async function readerBundlePresent(app: string): Promise<boolean> {
  try {
    const dir = await lstat(app);
    if (!dir.isDirectory()) return false;
    const exe = await lstat(readerExecutable(app));
    return exe.isFile();
  } catch {
    return false;
  }
}

/** Where a shipped reader may be, nearest first, for the engine binary at `execPath`. */
export function shippedReaderCandidates(execPath: string = process.execPath): string[] {
  const bin = dirname(execPath);
  return [
    join(bin, "..", "Resources", CALENDAR_READER_APP),             // the desktop app's sidecar (Contents/MacOS)
    join(bin, CALENDAR_READER_APP),                                 // the release asset, unpacked beside the CLI
    join(bin, "..", "share", "daily-briefing", CALENDAR_READER_APP), // a Homebrew-style prefix
  ];
}

/** The nearest shipped reader at least as new as this engine's (`CALENDAR_READER_VERSION`), else the nearest one
 *  present, else `null` (→ `helper-missing`). A stale copy further along the list (an old Homebrew `share` folder)
 *  must not shadow the current one, or `connect` would install a reader that reads report `helper-outdated`
 *  about forever (M10b checkpoint). */
export async function findShippedReader(candidates: readonly string[] = shippedReaderCandidates()): Promise<string | null> {
  let first: string | null = null;
  for (const c of candidates) {
    if (!(await readerBundlePresent(c))) continue;
    first ??= c;
    if (((await readerBundleVersion(c)) ?? 0) >= CALENDAR_READER_VERSION) return c;
  }
  return first;
}

/** The installed copy is older than the reader this engine shipped with: the `helper-outdated` notice (spec §4.1 —
 *  shown beside the read status; the old copy keeps reading). An unreadable version counts as outdated. */
export async function readerCopyOutdated(copy: string): Promise<boolean> {
  const v = await readerBundleVersion(copy);
  return v === null || v < CALENDAR_READER_VERSION;
}
