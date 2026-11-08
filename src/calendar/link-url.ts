// src/calendar/link-url.ts — the link-URL credential ladder (v0.3.0, plan M1; spec r4 §2).
//
// A private calendar link's URL is a SECRET: whoever holds it reads the calendar. It comes from exactly one
// configured source per link (`ResolvedCalendarLink.urlFrom`, decided by the config alone):
//   • `file`    — the MANAGED FILE `<state>/calendar/links/<id>.url`, written by the desktop app's Rust side
//                 (W2) or `calendar add-link` (M5), never by hand-editing config.json;
//   • `env`     — the environment variable named by `urlEnv`;
//   • `command` — the stdout of `urlCommand` (an argv, never a shell string), 5 s limit.
// No OS keychain here. The old standing ruling against one is replaced for API keys alone (`src/apiKey.ts`'s
// header: the app-owned Keychain store, provider fallback PR 2); a calendar link still has no keychain rung — the
// managed file above is the app's store for it.
//
// MIRRORS `src/apiKey.ts`'s ladder, but STRICTER, on purpose:
//   • the managed file is read through `src/strictFile.ts`: opened with O_NOFOLLOW (as `gui/src-tauri/src/briefing_files.rs` does) and
//     refused when it or its folder is a symlink, carries ANY group or other permission bit (folder 0700,
//     file 0600 — group-WRITABLE is refused too: whoever can rewrite the URL chooses what text reaches the
//     prompt), belongs to another user, is not a regular file, or has a second hard link. `apiKeyFile`
//     follows symlinks and checks only the mode;
//   • ONLY the configured source is tried — there is no fallback between rungs at all;
//   • results are TYPED OUTCOMES carrying a reason code, and no text. Nothing here builds a message, so
//     nothing here can interpolate a URL, part of one, an environment value or a command's output into one.
//     `url` on an `ok` outcome is the only field that ever holds the secret. A command's stderr is never
//     read (`proc.run` pipes it, so it is never shown either).
//
// NEVER THROWS: every path returns an outcome. Takes `stateDir` explicitly and has no default, so nothing in
// this module can reach the real state directory unless its caller hands it over (test/isolation.meta.test.ts).
import type { open } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../proc";
import { readStrictFile } from "../strictFile";
import { CALENDAR_LINK_ID_RE, type CalendarLinkSource } from "./config";

/** `urlCommand`'s ceiling — `KEY_COMMAND_TIMEOUT_MS`'s value and reasoning (src/apiKey.ts): a helper that
 *  needs longer at 07:20 is waiting for a human, and the morning must not wait with it. */
export const LINK_URL_COMMAND_TIMEOUT_MS = 5_000;

/** The longest URL accepted from any rung, in UTF-8 bytes. Real secret links are a few hundred bytes; the
 *  bound only stops a wrong file or a chatty command from being read whole. */
export const LINK_URL_MAX_BYTES = 8_192;

/** The most of a `urlCommand`'s stdout that is ever buffered (fix-round 1): a helper that prints without end
 *  (`["yes"]`) is killed the moment it passes this, rather than growing memory until the 5 s kill. Well above
 *  any secret plus a password manager's trailing metadata. */
export const LINK_URL_COMMAND_MAX_OUT_BYTES = 64 * 1024;

/** The most of a `urlCommand`'s STDERR that is ever buffered (final harden r2): stderr is never read, but it
 *  was collected without bound, so a helper writing gigabytes there grew memory until the 5 s kill. Over it, the
 *  child is killed and the link reads `too-long`, as for stdout. */
export const LINK_URL_COMMAND_MAX_ERR_BYTES = 64 * 1024;

export type LinkUrlFrom = CalendarLinkSource["urlFrom"];

/** Nothing there to read. */
export type LinkUrlMissingReason =
  | "file-missing"     // the managed folder or file does not exist
  | "file-empty"       // the file holds only whitespace
  | "env-unset"        // the variable is unset, empty or whitespace
  | "command-empty";   // the command exited 0 and printed nothing

/** Something was there and was refused, unread. */
export type LinkUrlRefusedReason =
  | "unsupported-platform"   // the managed file needs O_NOFOLLOW and POSIX ownership and modes (not Windows)
  | "dir-symlink"
  | "dir-not-directory"
  | "dir-owner"
  | "dir-permissions"        // any group or other bit on the folder
  | "file-symlink"
  | "file-not-regular"
  | "file-owner"
  | "file-permissions"       // any group or other bit on the file
  | "file-hardlinked"
  | "too-long";              // over LINK_URL_MAX_BYTES, from any rung

/** The read itself went wrong. */
export type LinkUrlFailedReason =
  | "read-error"        // an unexpected error reading the file, or from the command runner
  | "command-not-run"   // the command could not be started
  | "command-timeout"
  | "command-exit";     // non-zero exit, a signal, or stdout that never finished

export type LinkUrlOutcome =
  | { status: "ok"; from: LinkUrlFrom; url: string }
  | { status: "missing"; from: LinkUrlFrom; reason: LinkUrlMissingReason }
  | { status: "refused"; from: LinkUrlFrom; reason: LinkUrlRefusedReason }
  | { status: "failed"; from: LinkUrlFrom; reason: LinkUrlFailedReason };

export type LinkUrlOpts = {
  /** The engine state folder (`supportDir()` in production). REQUIRED — see the header. */
  stateDir: string;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Injected so the command rung is testable without spawning. */
  exec?: typeof run;
  /** Overrides LINK_URL_COMMAND_TIMEOUT_MS. Tests only, for the real-child kill path. */
  commandTimeoutMs?: number;
  /** Is this folder or file the user's own? Defaults to "its uid is this process's uid". Injected because a
   *  test cannot chown a file to another user without root. */
  ownerCheck?: (st: { uid: number }, which: "dir" | "file") => boolean;
  /** Opens the managed file; defaults to `fs/promises`' `open`. Injected so its FLAGS are pinned: the race
   *  O_NOFOLLOW and O_NONBLOCK guard (a symlink or a FIFO swapped in between the lstat and the open) cannot be
   *  staged in a test, so without this nothing failed when a flag was dropped (M1 checkpoint LOW). */
  open?: (path: string, flags: number) => ReturnType<typeof open>;
};

/** `<state>/calendar/links`, the managed files' folder (0700). */
export function calendarLinksDir(stateDir: string): string {
  return join(stateDir, "calendar", "links");
}

/** `<state>/calendar/links/<id>.url`. Throws on an id outside the grammar — a programming error, since only
 *  resolved ids (`resolveCalendar`) may reach a file name. */
export function calendarLinkFilePath(stateDir: string, id: string): string {
  if (!CALENDAR_LINK_ID_RE.test(id)) throw new Error("calendar link id outside the grammar");
  return join(calendarLinksDir(stateDir), `${id}.url`);
}

/** An accepted value, or `too-long` when it exceeds the bound. */
function accept(from: LinkUrlFrom, url: string): LinkUrlOutcome {
  return Buffer.byteLength(url, "utf8") > LINK_URL_MAX_BYTES ? { status: "refused", from, reason: "too-long" } : { status: "ok", from, url };
}

/** The managed file, through the shared strict reader (`src/strictFile.ts`, which owns the checks and their
 *  order); its outcomes map to this module's reasons one for one. */
async function fromFile(stateDir: string, id: string, opts: LinkUrlOpts): Promise<LinkUrlOutcome> {
  const from = "file";
  // Not `calendarLinkFilePath`, which throws on an id outside the grammar before anything is checked. The
  // RAW id is tested here instead, inside the name check, so the folder checks still come first: `join`
  // folds `x/../work` into a valid `work.url`, so the file name alone cannot prove the id was in the grammar
  // (P1-M1 checkpoint MED). An id outside it is `name-invalid`, mapped to `read-error` below, as the throw was.
  const idOk = CALENDAR_LINK_ID_RE.test(id);
  const r = await readStrictFile(join(calendarLinksDir(stateDir), `${id}.url`), {
    folder: calendarLinksDir(stateDir), idPattern: { test: (name: string) => idOk && name === `${id}.url` }, maxBytes: LINK_URL_MAX_BYTES,
    platform: opts.platform, open: opts.open, ownerCheck: opts.ownerCheck,
  });
  switch (r.status) {
    case "ok": {
      const url = r.text.trim();
      return url === "" ? { status: "missing", from, reason: "file-empty" } : accept(from, url);
    }
    case "missing": return { status: "missing", from, reason: "file-missing" };
    case "failed": return { status: "failed", from, reason: "read-error" };
    case "refused":
      // An id outside the grammar was a programming error caught as `read-error`; it stays one.
      return r.reason === "name-invalid" ? { status: "failed", from, reason: "read-error" } : { status: "refused", from, reason: r.reason };
  }
}

function fromEnv(name: string, opts: LinkUrlOpts): LinkUrlOutcome {
  const url = ((opts.env ?? process.env)[name] ?? "").trim();
  return url === "" ? { status: "missing", from: "env", reason: "env-unset" } : accept("env", url);
}

async function fromCommand(argv: string[], opts: LinkUrlOpts): Promise<LinkUrlOutcome> {
  const from = "command";
  // Bounded by `proc.run` exactly as `apiKeyCommand` is: SIGKILL at the ceiling, plus a raced post-exit
  // flush, so neither a hung helper nor one whose child holds stdout can hold the morning.
  const r = await (opts.exec ?? run)(argv, {
    timeoutMs: opts.commandTimeoutMs ?? LINK_URL_COMMAND_TIMEOUT_MS, flushMs: 500,
    maxOutBytes: LINK_URL_COMMAND_MAX_OUT_BYTES, maxErrBytes: LINK_URL_COMMAND_MAX_ERR_BYTES,
  });
  // ⚠ `r.err` is never read, and `r.out` only on success: stdout IS the secret, and a password manager's
  // stderr routinely names the entry it was asked for.
  if (!r.spawned) return { status: "failed", from, reason: "command-not-run" };
  // Over the stdout (or stderr) cap: the child was killed and the partial read is dropped unread.
  if (r.outTruncated || r.errTruncated) return { status: "refused", from, reason: "too-long" };
  if (r.timedOut) return { status: "failed", from, reason: "command-timeout" };
  if (r.code !== 0) return { status: "failed", from, reason: "command-exit" };
  // The FIRST line: password managers print the secret first and metadata after it (`pass show`, the
  // spec's own example, does exactly that).
  const url = (r.out.trim().split(/\r?\n/)[0] ?? "").trim();
  return url === "" ? { status: "missing", from, reason: "command-empty" } : accept(from, url);
}

/** Read one link's URL from its configured source. Never throws; see the header for the guarantees. */
export async function resolveLinkUrl(
  link: { id: string } & CalendarLinkSource, opts: LinkUrlOpts,
): Promise<LinkUrlOutcome> {
  try {
    switch (link.urlFrom) {
      case "file": return await fromFile(opts.stateDir, link.id, opts);
      case "env": return fromEnv(link.urlEnv, opts);
      case "command": return await fromCommand(link.urlCommand, opts);
    }
  } catch {
    // A read that fails part-way through the file, an injected runner that throws, an id outside the grammar
    // (`calendarLinkFilePath`). Nothing from the error is kept: its message could carry a path, or worse.
  }
  return { status: "failed", from: link.urlFrom, reason: "read-error" };
}
