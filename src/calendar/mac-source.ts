// src/calendar/mac-source.ts — the Mac Calendar app source: TRIGGER THE READER, THEN READ ITS PIPE (v0.3.0 plan
// M10c; spec r4 §4.1, gate G1).
//
// Per invocation:
//   1. the copy must exist (`<state>/calendar/reader/<READER>.app`; else `helper-missing` — a scheduled run never
//      installs one, `./reader-install.ts`); `run/` beside it is created 0700 and checked; FIFOs older than five
//      minutes are swept from it (a crashed engine's leftovers);
//   2. a FIFO `run/<id>.fifo` is made (`mkfifo -m 600`) with a fresh 32-hex invocation id; the engine opens the
//      READ end without blocking and ALSO holds its own WRITE end, so the read never sees end-of-file before the
//      helper connects (and the helper's open never fails for want of a reader);
//   3. the helper is started through LaunchServices — `open -g -j -n -W <copy> --args <mode> --fifo … --id …` (G1's
//      trigger (a): the helper, not the engine, is then the permission holder);
//   4. the read end is polled until ONE newline-terminated JSON document carrying this invocation's id parses, or
//      the abandonment deadline (15 s; `request` 128 s, past the helper's own 120 s dialog limit). A document with
//      another id is discarded. The trigger's EXIT STATUS is never trusted (`open` reports LaunchServices, not the
//      helper); its exit only means "no more data is coming", after a short drain;
//   5. always: both ends closed and the FIFO removed — so no reader is ever left blocked and no event data rests
//      on disk.
//
// ⚠ THE ONLY WAY OUT IS THE INJECTED EXEC (`deps.exec ?? run`): `mkfifo` and `open` are argv to it, so no test can
// launch the helper or Calendar (test/isolation.meta.test.ts scanners 2b and R5/R6). Nothing here prompts: only
// `request` mode can raise the dialog, and only `calendar connect mac` (attended) asks for it.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { run } from "../proc";
import { ensurePrivateDir, ensureReaderDir } from "./reader-install";
import { calendarReaderCopy, calendarReaderRunDir, macOsSupported, readerBundlePresent, readerCopyOutdated } from "./reader";
import { macEventsFrom } from "./mac-events";
import { cleanCalendarText } from "./clean";
import type { CalendarMacosSelection } from "./config";
import type { CalDate, CalEvent, CalendarMacosCalendar, CalendarReadStatus, CalendarSourceNotice } from "./types";

export type ReaderMode = "request" | "read" | "list" | "status";
export type ReaderExec = typeof run;

/** Spec §4.1: "The engine abandons the helper at 15 s". */
export const READER_ABANDON_MS = 15_000;
/** `request` waits for a person: the helper's own 120 s limit, plus room for its start and answer. */
export const READER_REQUEST_ABANDON_MS = 128_000;
/** The helper caps its document at 4 MB; a little slack for the framing. More than this is refused. */
export const READER_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024 + 64 * 1024;
/** FIFOs older than this in `run/` are leftovers (longer than any invocation, `request` included). */
export const READER_STALE_MS = 5 * 60_000;
/** After the trigger exits with no document, how long the pipe is still drained. */
const EXIT_DRAIN_MS = 1_000;
const POLL_MS = 25;

export type ReaderDeps = {
  /** The engine state folder. REQUIRED: nothing here defaults to the real one. */
  stateDir: string;
  /** Runs `mkfifo` and `open`. Defaults to `proc.run`; every test injects one. */
  exec?: ReaderExec;
  /** Wall clock — only for the stale sweep (file times are wall-clock). */
  now?: () => number;
  /** MONOTONIC clock for the deadline and the exit drain (a wall-clock step must not end a read early).
   *  Defaults to `performance.now`. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** TEST seam: the invocation id. */
  newId?: () => string;
  /** TEST seam: the abandonment deadline. */
  abandonMs?: number;
  /** TEST seam: the document size limit. Production: READER_DOCUMENT_MAX_BYTES. */
  maxDocumentBytes?: number;
};

export type ReaderOutcome =
  | { ok: true; doc: Record<string, unknown> }
  | { ok: false; status: "helper-missing" | "timeout" | "malformed"; reason: string };

const isEagain = (e: unknown): boolean => {
  const code = (e as { code?: string }).code;
  return code === "EAGAIN" || code === "EWOULDBLOCK";
};

/** Remove leftover FIFOs (and anything else named `*.fifo`) older than READER_STALE_MS. `unlink` never follows. */
export async function sweepStaleFifos(runDir: string, nowMs: number): Promise<number> {
  let n = 0;
  for (const name of await readdir(runDir).catch(() => [] as string[])) {
    if (!name.endsWith(".fifo")) continue;
    const p = join(runDir, name);
    const st = await lstat(p).catch(() => undefined);
    if (st === undefined || st.isDirectory() || nowMs - st.mtimeMs < READER_STALE_MS) continue;
    if (await unlink(p).then(() => true, () => false)) n++;
  }
  return n;
}

/** One invocation of the reader. Never throws. */
export async function runReader(mode: ReaderMode, args: readonly string[], deps: ReaderDeps): Promise<ReaderOutcome> {
  const exec = deps.exec ?? run;
  const now = deps.now ?? Date.now;
  const clock = deps.clock ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const abandonMs = deps.abandonMs ?? (mode === "request" ? READER_REQUEST_ABANDON_MS : READER_ABANDON_MS);
  const t0 = clock();
  // ABSOLUTE paths: the helper starts with cwd `/`, so a relative state dir would hand it a path it refuses.
  const copy = resolve(calendarReaderCopy(deps.stateDir));
  if (!(await readerBundlePresent(copy))) return { ok: false, status: "helper-missing", reason: "no-copy" };
  const runDir = resolve(calendarReaderRunDir(deps.stateDir));
  const bad = (await ensureReaderDir(deps.stateDir)) ?? (await ensurePrivateDir(runDir));
  if (bad) return { ok: false, status: "malformed", reason: bad };
  await sweepStaleFifos(runDir, now());

  const id = deps.newId?.() ?? randomBytes(16).toString("hex");
  if (!/^[0-9a-f]{32}$/.test(id)) return { ok: false, status: "malformed", reason: "bad-id" };
  const fifo = join(runDir, `${id}.fifo`);
  let rfd: number | undefined, wfd: number | undefined;
  try {
    const made = await exec(["mkfifo", "-m", "600", fifo], { timeoutMs: 5_000 }).catch(() => undefined);
    if (made === undefined || !made.spawned || made.code !== 0) return { ok: false, status: "malformed", reason: "mkfifo-failed" };
    const st = await lstat(fifo).catch(() => undefined);
    if (st === undefined || !st.isFIFO()) return { ok: false, status: "malformed", reason: "not-a-fifo" };
    rfd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    if (!fstatSync(rfd).isFIFO()) return { ok: false, status: "malformed", reason: "not-a-fifo" };
    wfd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);

    let exitedAt: number | undefined;
    const argv = ["open", "-g", "-j", "-n", "-W", copy, "--args", mode, "--fifo", fifo, "--id", id, ...args];
    // Not awaited for its result: only its exit matters, as "nothing more is coming".
    void exec(argv, { timeoutMs: abandonMs + 5_000, maxOutBytes: 64 * 1024, maxErrBytes: 64 * 1024 })
      .catch(() => undefined).then(() => { exitedAt = clock(); });

    // ⚠ BOUNDED WHATEVER ARRIVES (M10c checkpoint): the deadline is checked on every pass, data or not; the loop
    // yields to the event loop on every pass (so the step's own bound can always fire); the total read is capped,
    // so a writer streaming newline-terminated junk cannot keep it busy. A line that is not this invocation's
    // document — another id, or not JSON at all — is ignored, as the spec says of other ids. Only the newest
    // chunk is scanned for a newline: no quadratic rescans of a large document.
    const maxDoc = deps.maxDocumentBytes ?? READER_DOCUMENT_MAX_BYTES;
    const deadline = t0 + abandonMs;
    const chunk = Buffer.alloc(64 * 1024);
    let parts: Buffer[] = [];
    let partBytes = 0, total = 0;
    for (;;) {
      const t = clock();
      if (t >= deadline) return { ok: false, status: "timeout", reason: "helper-abandoned" };
      let got = 0;
      try { got = readSync(rfd, chunk, 0, chunk.length, null); }
      catch (e) { if (!isEagain(e)) return { ok: false, status: "malformed", reason: "pipe-read-failed" }; }
      if (got > 0) {
        total += got;
        if (total > 4 * maxDoc) return { ok: false, status: "malformed", reason: "too-much-data" };
        let fresh = Buffer.from(chunk.subarray(0, got));
        let nl: number;
        while ((nl = fresh.indexOf(0x0a)) >= 0) {
          const line = Buffer.concat([...parts, fresh.subarray(0, nl)]).toString("utf8");
          parts = []; partBytes = 0;
          fresh = fresh.subarray(nl + 1);
          let doc: unknown;
          try { doc = JSON.parse(line); } catch { continue; }
          if (typeof doc === "object" && doc !== null && !Array.isArray(doc) && (doc as Record<string, unknown>).id === id
            && (doc as Record<string, unknown>).v === 1) {
            return { ok: true, doc: doc as Record<string, unknown> };
          }
        }
        if (fresh.length) { parts.push(fresh); partBytes += fresh.length; }
        if (partBytes > maxDoc) return { ok: false, status: "malformed", reason: "document-too-large" };
        await sleep(0);
        continue;
      }
      if (exitedAt !== undefined && t - exitedAt >= EXIT_DRAIN_MS) return { ok: false, status: "malformed", reason: "helper-exited" };
      await sleep(POLL_MS);
    }
  } catch {
    return { ok: false, status: "malformed", reason: "pipe-failed" };
  } finally {
    for (const fd of [wfd, rfd]) if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    await unlink(fifo).catch(() => undefined);
  }
}

// ── the three uses: a scheduled/attended read, Settings' calendar list, and the attended access request ──────────

/** Statuses the helper itself may report (reader/Sources/Store.swift `authorizationText`, ModeRequest's timeout). */
const HELPER_STATUSES: ReadonlySet<string> = new Set(["ok", "not-granted", "write-only", "denied", "restricted", "unsupported-os", "timeout"]);

export type MacSourceDeps = ReaderDeps & {
  platform?: NodeJS.Platform;
  /** `os.release()`. TEST seam. */
  osRelease?: string;
};

/** The helper's arguments for a selection: `--select editable|all`, or one `--calendar <id>` per chosen calendar. */
export function selectionArgs(sel: CalendarMacosSelection): string[] {
  return sel === "editable" || sel === "all" ? ["--select", sel] : sel.flatMap((c) => ["--calendar", c.id]);
}

/** A failed outcome or a helper status → the source's read status (`ok` handled by the caller). */
function failedStatus(o: ReaderOutcome): { status: CalendarReadStatus; reason: string } | undefined {
  if (!o.ok) return { status: o.status, reason: o.reason };
  const s = o.doc.status;
  if (typeof s !== "string" || !HELPER_STATUSES.has(s)) return { status: "malformed", reason: "helper-status" };
  if (s === "ok") return undefined;
  return { status: s as CalendarReadStatus, reason: `helper-${s}` };
}

/** OS gate shared by every use: macOS 14 or later, else `unsupported-os` (no launch). */
function osUnsupported(d: MacSourceDeps): boolean {
  return (d.platform ?? process.platform) !== "darwin" || !macOsSupported(d.osRelease);
}

export type MacRead = { status: CalendarReadStatus; reason?: string; notices?: CalendarSourceNotice[]; events: CalEvent[] };

/** The live details read only (redesign C, wave-2 plan C-M2-T5); the morning passes none. `details`: each event on
 *  `details.runDate` carries its raw details (`macEventsFrom`'s `detailsFor`). `refreshWait`: the reader's
 *  `--refresh-wait <n>` (0 to 2 s), sent only in details mode and only to a copy that is NOT outdated — a version-1
 *  copy refuses an argument it does not know (reader/Sources/main.swift's `default: return nil`), so it is read
 *  without one and keeps its 2 s wait. */
export type MacReadOpts = { details?: { runDate: CalDate }; refreshWait?: number };

/** Read today ± 1 day from the Mac Calendar app through the installed copy. Never throws; never prompts. */
export async function readMacCalendar(sel: CalendarMacosSelection, emails: readonly string[], d: MacSourceDeps, opts: MacReadOpts = {}): Promise<MacRead> {
  try {
    if (osUnsupported(d)) return { status: "unsupported-os", events: [] };
    const copy = calendarReaderCopy(d.stateDir);
    if (!(await readerBundlePresent(copy))) return { status: "helper-missing", reason: "no-copy", events: [] };
    const outdated = await readerCopyOutdated(copy);
    const notices: CalendarSourceNotice[] = outdated ? ["helper-outdated"] : [];
    const withNotices = notices.length ? { notices } : {};
    // An explicit empty choice reads nothing: the helper must never be asked with no selection (its default is
    // "editable", which is not what the user chose).
    if (Array.isArray(sel) && sel.length === 0) return { status: "ok", ...withNotices, events: [] };
    const wait = opts.details !== undefined && !outdated && typeof opts.refreshWait === "number"
      && Number.isInteger(opts.refreshWait) && opts.refreshWait >= 0 && opts.refreshWait <= 2 ? ["--refresh-wait", String(opts.refreshWait)] : [];
    const url = opts.details !== undefined && !outdated ? ["--with-url"] : [];
    const o = await runReader("read", [...selectionArgs(sel), ...url, ...wait], d);
    const failed = failedStatus(o);
    if (failed) return { ...failed, ...withNotices, events: [] };
    const doc = (o as { doc: Record<string, unknown> }).doc;
    // An `ok` read must carry its events array: without one, "nothing" is not evidence of a free day.
    if (!Array.isArray(doc.events)) return { status: "malformed", reason: "no-events", ...withNotices, events: [] };
    const { events, dropped } = macEventsFrom(doc.events, emails, opts.details !== undefined ? { detailsFor: opts.details.runDate } : {});
    const incomplete = doc.truncated === true ? "truncated"
      : typeof doc.missingCalendars === "number" && doc.missingCalendars > 0 ? "calendar-missing"
      : dropped > 0 ? "malformed-event" : undefined;
    return incomplete
      ? { status: "incomplete", reason: incomplete, ...withNotices, events }
      : { status: "ok", ...withNotices, events };
  } catch {
    return { status: "incomplete", reason: "internal", events: [] };
  }
}

export type MacList = { status: CalendarReadStatus; reason?: string; notices?: CalendarSourceNotice[]; calendars: CalendarMacosCalendar[] };

const CAL_TYPES: ReadonlySet<string> = new Set(["standard", "subscribed", "birthdays"]);

/** Is this calendar read under the selection? The helper's own rule for `editable` (ModeRead/Store.swift). */
export function macCalendarSelected(c: Pick<CalendarMacosCalendar, "id" | "editable" | "type">, sel: CalendarMacosSelection): boolean {
  if (sel === "all") return true;
  if (sel === "editable") return c.editable && c.type !== "birthdays";
  return sel.some((s) => s.id === c.id);
}

/** The Mac's calendars for Settings' checklist (`calendar list`). Never prompts (the helper's `list` is gated). */
export async function listMacCalendars(sel: CalendarMacosSelection, d: MacSourceDeps): Promise<MacList> {
  try {
    if (osUnsupported(d)) return { status: "unsupported-os", calendars: [] };
    const copy = calendarReaderCopy(d.stateDir);
    if (!(await readerBundlePresent(copy))) return { status: "helper-missing", reason: "no-copy", calendars: [] };
    const notices: CalendarSourceNotice[] = (await readerCopyOutdated(copy)) ? ["helper-outdated"] : [];
    const withNotices = notices.length ? { notices } : {};
    const o = await runReader("list", [], d);
    const failed = failedStatus(o);
    if (failed) return { ...failed, ...withNotices, calendars: [] };
    const raw = (o as { doc: Record<string, unknown> }).doc.calendars;
    if (!Array.isArray(raw)) return { status: "malformed", reason: "no-calendars", ...withNotices, calendars: [] };
    const calendars: CalendarMacosCalendar[] = [];
    for (const c of raw.slice(0, 500)) {
      if (typeof c !== "object" || c === null) continue;
      const r = c as Record<string, unknown>;
      if (typeof r.id !== "string" || r.id === "" || typeof r.title !== "string" || typeof r.account !== "string"
        || typeof r.editable !== "boolean" || typeof r.type !== "string" || !CAL_TYPES.has(r.type)) continue;
      const cal = { id: r.id, title: cleanCalendarText(r.title, "title"), account: cleanCalendarText(r.account, "title"), editable: r.editable, type: r.type as CalendarMacosCalendar["type"] };
      calendars.push({ ...cal, selected: macCalendarSelected(cal, sel) });
    }
    return { status: "ok", ...withNotices, calendars };
  } catch {
    return { status: "incomplete", reason: "internal", calendars: [] };
  }
}

/** Ask for full Calendar access — ATTENDED ONLY (`calendar connect mac`). The helper shows the dialog itself and
 *  waits up to 120 s for the person. */
export async function requestMacAccess(d: MacSourceDeps): Promise<{ status: CalendarReadStatus; reason?: string }> {
  try {
    if (osUnsupported(d)) return { status: "unsupported-os" };
    // The helper waits for the person a little LESS than this engine waits for it (`--wait`), so its own
    // `timeout` answer arrives inside the engine's deadline (final review r1).
    const abandonMs = d.abandonMs ?? READER_REQUEST_ABANDON_MS;
    const wait = Math.max(10, Math.min(120, Math.floor(abandonMs / 1000) - 6));
    const o = await runReader("request", ["--wait", String(wait)], d);
    const failed = failedStatus(o);
    if (failed?.status !== "timeout") return failed ?? { status: "ok" };
    // A grant given in the last moments still counts: ask the (non-prompting) status mode once.
    const again = await runReader("status", [], { ...d, abandonMs: 10_000 });
    return failedStatus(again) === undefined ? { status: "ok" } : failed;
  } catch {
    return { status: "incomplete", reason: "internal" };
  }
}
