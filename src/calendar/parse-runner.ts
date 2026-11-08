// src/calendar/parse-runner.ts — run ONE calendar parse job under a HARD deadline (v0.3.0 plan M2b; spec r4 §3
// "Hard bound on work": "iCalendar parsing and recurrence expansion run in a Bun Worker that is terminated at the
// deadline. If the build measures that Workers do not work inside the `bun build --compile` binary, the fallback
// is the engine binary re-invoking itself with a hidden `calendar-parse` subcommand under the same deadline").
//
// ── THE DECISION (M2b, 2026-10-09): the self re-exec, not a Worker ─────────────────────────────────────────
// Measured on `bun build --compile` binaries (bun 1.3.14, macOS arm64) built with the product's OWN flags —
// `bun build <entry> --compile --outfile …` (scripts/install.sh:11) and the same plus `--target bun-darwin-arm64`
// (gui/scripts/build-sidecar.sh:131) — each copied ALONE into a fresh empty temp dir and run there with HOME, XDG_*
// and DAILY_BRIEFING_STATE_DIR inside it, `env -i`, under a sandbox-exec profile denying all networking and every
// file write outside /dev:
//   • A Worker on its own module — `new Worker("./worker.ts")` or `new Worker(new URL("./worker.ts",
//     import.meta.url))` — constructs, then fails to load: `ModuleNotFound resolving "/$bunfs/root/worker.ts"
//     (entry point)`. The unchanged build embeds no worker module.
//   • With the worker passed as an EXTRA ENTRYPOINT (`bun build --compile main.ts worker.ts`) the string form works
//     (the URL form still fails). That is a build-command change — scripts/install.sh, gui/scripts/build-sidecar.sh,
//     scripts/verify-dist-local.sh and the release workflows — so by the hub's rule: the fallback.
//   • Two Worker forms DO run under the unchanged build, and were rejected, stated here so a reviewer can disagree:
//     a same-entry worker, `new Worker(Bun.main)`, re-evaluates the whole engine in the worker AND sees
//     `import.meta.main === true` there (measured), so src/main.ts's entry line would run the CLI inside the
//     worker unless gated; and a Blob-URL worker needs the parser shipped as a string (ical.js imported as text
//     and re-imported from a blob URL), and Bun then wrote a transpiler cache file under $XDG_CACHE_HOME/bun
//     (measured). Both keep the untrusted-input parser inside the engine's own memory and environment.
//   • The self re-exec works under both unchanged commands: `calendarParseCommand()` = [execPath,
//     "calendar-parse"]; the real src/main.ts dispatch answers; the vendored ical.js loads by dynamic import inside
//     the child; a CPU-bound child (`for (;;)`) with an 800 ms deadline resolved the caller at 800–802 ms and the
//     child's pid was gone afterwards; the real job on the 16 MB feed with a 150 ms deadline resolved at 150 ms.
//     Before the run each temp dir held only the binary (and an empty pid/ folder); after, only the spin child's
//     pid file. Spawn + startup + an empty feed: 42–73 ms; the child's baseline peak RSS ≈ 39 MB.
//   Binary size: +165,120 bytes (61,909,090 → 62,074,210) for ical.js and this module.
//
// ── G5, RAW (M2b: no pre-filter yet — M2c's re-measurement on the same feeds follows) ──────────────────────────
// Through `runCalendarParse` with the default command, in the compiled probe above, 5 runs each; the job is
// `ICAL.parse` of the whole feed + a VEVENT count. Feeds from test/fixtures/calendar-heavy-feed.ts:
//   A `heavyFeed({ events: 20_000, years: 10, descriptionChars: 40, attendees: 0 })` — 9,628,667 bytes:
//     294–341 ms end to end; child peak RSS 211–215 MB (`/usr/bin/time -l` on the engine alone: 195 MB).
//   B `heavyFeed({ events: 17_650, years: 10 })` — 16,765,821 bytes, just under the 16 MiB per-link cap:
//     416–903 ms end to end; child peak RSS 315–328 MB (`/usr/bin/time -l` on the engine alone: 281–288 MB).
// Peak memory is the CHILD's and is returned to the OS when it exits. The parent briefly holds the request as a
// string and as bytes (≈ 2 × the feed); M2c may send the fetched bytes without the JSON round trip.
//
// ── G5, M2c (2026-10-09): the REAL job, with the pre-filter, on the same two feeds ──────────────────────────────
// The full M2c job — text pass, UID index of every block, pre-filter, zones, expansion, identity, cleaning — through
// `runCalendarParse` with `[<binary>, "calendar-parse"]`, the binary built with scripts/install.sh's own command
// (`bun build src/main.ts --compile --outfile …`, bun 1.3.14, macOS arm64; 62,123,746 bytes, +49,536 on M2b) and
// copied ALONE into a fresh temp dir (before and after the runs: only the binary there; HOME, XDG_* and the state dir
// pointed into it stayed empty), `env -i`; runDate 2026-10-09, zone America/New_York; 5 runs each:
//   A (9,628,667 bytes): 403–416 ms end to end once warm (the first run after copying the binary: 1.79–1.94 s — the OS
//     paging in a freshly written 62 MB executable); child peak RSS 271–290 MB; 65 events, 20,000 index entries,
//     no incomplete flag; answer 2,387,570 bytes.
//   B (16,765,821 bytes): 463–492 ms; child peak RSS 335–337 MB; 57 events, 17,650 index entries, no flag; answer
//     2,122,705 bytes.
// Against M2b's raw parse (A 294–341 ms / 211–215 MB, B 416–903 ms / 315–328 MB) the time is comparable: ical.js's
// full parse is gone (the parser reads the text itself and hands ical.js only the recurrence rules), and the pre-filter
// leaves ~800 series masters and the window's one-offs to expand. Peak memory is higher on A because every block's
// lines are held for the index pass; a first cut that also split the whole feed into one array of physical lines
// measured 391–422 MB on B, hence the streaming unfold. Both answers sit well inside CALENDAR_PARSE_MAX_OUTPUT_BYTES.
//
// THE CONTRACT. `runCalendarParse(request, { timeoutMs })` spawns the engine binary as `<engine> calendar-parse` (cwd
// `/`, see `calendarParseCwd`),
// writes the request to its stdin, reads one JSON answer from its stdout, and SIGKILLs it when `timeoutMs` passes.
// It NEVER THROWS and ALWAYS RESOLVES — by the deadline at the latest, whatever the child does (spins, sleeps,
// never reads stdin, floods stdout, dies). Nothing the child writes reaches the outcome except a validated
// answer: stderr is not even read, and stdout is parsed into the fixed `CalendarParseResult` shape or refused — every
// field checked, and every text field required to be CLEAN already (the child cleans; `answer` below refuses what it
// did not). No outcome carries text other than that checked, cleaned answer.
//
// THE CHILD'S ENVIRONMENT IS EMPTY. It parses untrusted input and needs nothing from the parent's environment —
// which carries the API key and, through a link's `urlEnv`, the calendar link URLs themselves. (On win32 only
// `SystemRoot` is passed, which Windows processes need to start: UNVERIFIED, no Windows machine here.)
//
// VERSION SKEW. The child is whatever binary is at `process.execPath` NOW — an update may have replaced it since
// this process started. An answer whose `v` is not this build's `CALENDAR_PARSE_PROTOCOL` is `bad-output`.
//
// THE DETAILS KIND (redesign C, wave-2 plan C-M1-T2). `runCalendarDetailsParse` runs the same child, the same way,
// for a `kind: "details"` request, with its OWN answer check (`detailsAnswer`: the morning's `eventOk` on every
// event's cleaned fields, plus the raw `details` shape and caps, and `kind: "details"` echoed) and its OWN cap
// (`CALENDAR_DETAILS_MAX_OUTPUT_BYTES`). Raw details are not clean by design, so they are checked for shape and size
// only; they reach the live details command and nothing else. The morning's `answer`, `eventOk` and
// `CALENDAR_PARSE_MAX_OUTPUT_BYTES` are unchanged, and the morning check still refuses a `details` or `kind` key.
import {
  CALENDAR_PARSE_PROTOCOL, type CalendarDetailsRequest, type CalendarDetailsResult, type CalendarParseRequest, type CalendarParseResult,
} from "./parse-job";
import {
  CAL_ATTENDEES_MAX, CAL_DETAILS_BUDGET_BYTES, CAL_DETAILS_LOCATION_MAX, CAL_DETAILS_NAME_MAX, CAL_DETAILS_NOTES_MAX, CAL_DETAILS_URL_MAX,
  CAL_EVENTS_BUDGET_BYTES, CAL_INDEX_BUDGET_BYTES, CAL_PARSE_INCOMPLETE, CAL_PARSE_MAX_EVENTS, CAL_UID_MAX,
  type CalDetailsWireEvent, type CalParseIncomplete, type CalWireEvent,
} from "./ics";
import { cleanEmail, isCleanCalendarText } from "./clean";
import { LINK_KEYS_MAX } from "./join";
import type { CalTime, CalUidIndexEntry } from "./types";

/** The hidden subcommand `src/main.ts` routes to `calendarParseMain` before any config or state is read. */
export const CALENDAR_PARSE_SUBCOMMAND = "calendar-parse";

/** The most stdout the parent will hold from one child; more is `output-too-large` and the child is killed. Sized to
 *  the M2c result: the child keeps its events within `CAL_EVENTS_BUDGET_BYTES` (6 MiB — at most 5,000 cleaned
 *  events, each field capped) and its index within `CAL_INDEX_BUDGET_BYTES` (4 MiB — ~30,000 blocks; the 17,650-
 *  event G5 feed's whole answer is ~2.0 MiB), counting the serialised bytes as it goes and flagging `output-cap` /
 *  `index-capped` rather than crossing them; 64 KiB covers the envelope. 10 MiB + 64 KiB in all (was 16 MiB). */
export const CALENDAR_PARSE_MAX_OUTPUT_BYTES = CAL_EVENTS_BUDGET_BYTES + CAL_INDEX_BUDGET_BYTES + 64 * 1024;
/** The details kind's cap: the morning-shaped part keeps its own budgets, and the raw details add at most their own
 *  (`CAL_DETAILS_BUDGET_BYTES`, counted by the child). 12 MiB + 64 KiB. */
export const CALENDAR_DETAILS_MAX_OUTPUT_BYTES = CALENDAR_PARSE_MAX_OUTPUT_BYTES + CAL_DETAILS_BUDGET_BYTES;

/** Why a parse produced no answer. `no-runner`: this process cannot re-invoke the engine (it is neither the
 *  compiled binary nor `bun …/src/main.ts` — e.g. a test runner, whose entry must never be re-run).
 *  `spawn-failed`: the spawn itself threw. `exit-nonzero`: the child exited non-zero or died by a signal it was
 *  not sent by the deadline. `bad-output`: stdout was not exactly one answer of this protocol version.
 *  `output-too-large`: stdout passed `maxOutputBytes`. */
export type CalendarParseFailure = "no-runner" | "spawn-failed" | "exit-nonzero" | "bad-output" | "output-too-large";

type ParseOutcome<R> =
  /** `maxRss`: the child's peak resident set from its rusage in bytes (macOS reports bytes, measured
   *  against `/usr/bin/time -l`; Linux reports kilobytes and is scaled). Measurement only — G5 — and absent if unavailable. */
  | { status: "ok"; result: R; elapsedMs: number; maxRss?: number }
  | { status: "timeout"; elapsedMs: number }
  | { status: "failed"; reason: CalendarParseFailure; elapsedMs: number };
export type CalendarParseOutcome = ParseOutcome<CalendarParseResult>;
export type CalendarDetailsOutcome = ParseOutcome<CalendarDetailsResult>;

export type CalendarParseRunOpts = {
  /** The hard deadline, counted from this call (request serialisation included). Required: the caller (M4) passes
   *  what is left of the step's 30 s bound. */
  timeoutMs: number;
  /** The child's argv. Default `calendarParseCommand()`. Tests inject a fixture child. */
  command?: string[];
  /** Default CALENDAR_PARSE_MAX_OUTPUT_BYTES (the details kind: CALENDAR_DETAILS_MAX_OUTPUT_BYTES). */
  maxOutputBytes?: number;
};

/** The argv that re-invokes THIS engine with the hidden subcommand, or `undefined` when this process is not the
 *  engine. In the compiled binary `Bun.main` is the embedded entry's virtual path — `/$bunfs/root/<name>`
 *  (measured on macOS, bun 1.3.14; `B:\~BUN\root\…` on Windows per Bun's docs, UNVERIFIED) — and the binary
 *  takes the subcommand directly. Run from source (`bun src/main.ts`, or the npm-installed `bin`), the runtime
 *  needs the entry named. Anything else — `bun test`, where `Bun.main` is the test file — gets `undefined`, so a
 *  parse can never re-run a test file or a script. */
export function calendarParseCommand(main: string = Bun.main, execPath: string = process.execPath): string[] | undefined {
  if (main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main)) return [execPath, CALENDAR_PARSE_SUBCOMMAND];
  if (/[\\/]src[\\/]main\.ts$/.test(main)) return [execPath, main, CALENDAR_PARSE_SUBCOMMAND];
  return undefined;
}

/** The child's environment: empty (see the header). */
function childEnv(): Record<string, string> {
  const root = process.platform === "win32" ? process.env.SystemRoot : undefined;
  return root === undefined ? {} : { SystemRoot: root };
}

// ── the answer, checked field by field (the child is our own binary, but possibly another version of it, and its
// input was hostile: nothing it says is trusted, and nothing unclean passes) ──────────────────────────────────

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
/** Exactly these keys: every one of `required`, nothing outside `required` ∪ `optional`. */
function keysOk(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  for (const k of required) if (!(k in o)) return false;
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) return false;
  return true;
}
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const WALL_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEY_RE = /^(-?\d{1,16}|\d{4}-\d{2}-\d{2})$/;
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
/** A UID: non-empty, bounded, and — like every other text field of the answer (M2c review LOW) — free of control
 *  characters and line breaks. The child hashes any UID that carries one (`uidOf`, ./ics.ts), so a clean child
 *  never trips this. */
const UID_FORBIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const uidOk = (u: unknown): boolean => typeof u === "string" && u !== "" && u.length <= CAL_UID_MAX + 7 && !UID_FORBIDDEN_RE.test(u);
const emailOk = (e: unknown): boolean => typeof e === "string" && cleanEmail(e) === e;

function timeOk(t: unknown): t is CalTime {
  if (!isObj(t)) return false;
  switch (t.kind) {
    case "timed": return keysOk(t, ["kind", "startMs", "endMs"]) && finite(t.startMs) && finite(t.endMs) && t.endMs >= t.startMs;
    case "allDay": return keysOk(t, ["kind", "startDate", "endDateExclusive"]) && typeof t.startDate === "string" && DATE_RE.test(t.startDate)
      && typeof t.endDateExclusive === "string" && DATE_RE.test(t.endDateExclusive) && t.endDateExclusive > t.startDate;
    case "unclear": return keysOk(t, ["kind", "startDate", "endDate", "wallStart", "wallEnd", "tzid"])
      && typeof t.startDate === "string" && DATE_RE.test(t.startDate) && typeof t.endDate === "string" && DATE_RE.test(t.endDate)
      && typeof t.wallStart === "string" && WALL_RE.test(t.wallStart) && typeof t.wallEnd === "string" && WALL_RE.test(t.wallEnd)
      && isCleanCalendarText(t.tzid, "title");
    default: return false;
  }
}

const EVENT_KEYS = ["time", "title", "attendees", "selfStatus", "organizerVerified", "transparency", "status"] as const;
const EVENT_OPTIONAL = [
  "uid", "recurrenceKey", "location", "organizer", "description", "lastModified", "sequence", "meetingKey", "placeKey", "linkKeys",
] as const;
/** A producer key (near-duplicates spec §4): exactly 64 lower-case hex characters, a SHA-256 digest. */
const PRODUCER_KEY_RE = /^[0-9a-f]{64}$/;
const producerKeyOk = (k: unknown): boolean => typeof k === "string" && PRODUCER_KEY_RE.test(k);
/** `linkKeys`: a non-empty array of at most `LINK_KEYS_MAX` producer keys, strictly ascending (sorted and unique). */
function linkKeysOk(ks: unknown): boolean {
  if (!Array.isArray(ks) || ks.length === 0 || ks.length > LINK_KEYS_MAX) return false;
  return ks.every((k, i) => producerKeyOk(k) && (i === 0 || (ks[i - 1] as string) < (k as string)));
}
const SELF = new Set(["organizer", "accepted", "tentative", "needs-action", "declined", "unknown"]);
const ATTENDEE_STATUS = new Set(["accepted", "tentative", "needs-action", "declined"]);

function personOk(p: unknown): boolean {
  return isObj(p) && keysOk(p, [], ["name", "email"]) && (p.name === undefined || isCleanCalendarText(p.name, "title"))
    && (p.email === undefined || emailOk(p.email));
}

/** One event of the answer: the `CalWireEvent` shape exactly, every text field already clean. */
function eventOk(e: unknown): e is CalWireEvent {
  if (!isObj(e) || !keysOk(e, EVENT_KEYS, EVENT_OPTIONAL) || !timeOk(e.time)) return false;
  if (!isCleanCalendarText(e.title, "title")) return false;
  if (e.location !== undefined && !isCleanCalendarText(e.location, "title")) return false;
  if (e.description !== undefined && !isCleanCalendarText(e.description, "description")) return false;
  if (e.organizer !== undefined && !personOk(e.organizer)) return false;
  if (!Array.isArray(e.attendees) || e.attendees.length > CAL_ATTENDEES_MAX) return false;
  for (const a of e.attendees) {
    if (!isObj(a) || !keysOk(a, [], ["name", "email", "status"]) || !personOk({ ...(a.name !== undefined ? { name: a.name } : {}), ...(a.email !== undefined ? { email: a.email } : {}) })) return false;
    if (a.status !== undefined && !ATTENDEE_STATUS.has(a.status as string)) return false;
  }
  if (typeof e.selfStatus !== "string" || !SELF.has(e.selfStatus) || typeof e.organizerVerified !== "boolean") return false;
  if (e.transparency !== "busy" && e.transparency !== "free") return false;
  if (e.status !== "confirmed" && e.status !== "tentative" && e.status !== "cancelled") return false;
  if (e.uid !== undefined && !uidOk(e.uid)) return false;
  if (e.recurrenceKey !== undefined && (typeof e.recurrenceKey !== "string" || !KEY_RE.test(e.recurrenceKey))) return false;
  if (e.lastModified !== undefined && !finite(e.lastModified)) return false;
  if (e.sequence !== undefined && !(Number.isSafeInteger(e.sequence) && (e.sequence as number) >= 0)) return false;
  if (e.meetingKey !== undefined && !producerKeyOk(e.meetingKey)) return false;
  if (e.placeKey !== undefined && !producerKeyOk(e.placeKey)) return false;
  if (e.linkKeys !== undefined && !linkKeysOk(e.linkKeys)) return false;
  return true;
}

function indexEntryOk(x: unknown): x is CalUidIndexEntry {
  if (!isObj(x) || !keysOk(x, ["uid", "startMs"], ["recurrenceId", "sequence", "lastModified", "recurs"]) || !uidOk(x.uid)) return false;
  if (x.startMs !== null && !finite(x.startMs)) return false;
  if (x.recurrenceId !== undefined && (typeof x.recurrenceId !== "string" || !KEY_RE.test(x.recurrenceId))) return false;
  if (x.sequence !== undefined && !(Number.isSafeInteger(x.sequence) && (x.sequence as number) >= 0)) return false;
  if (x.lastModified !== undefined && !finite(x.lastModified)) return false;
  return x.recurs === undefined || x.recurs === true;
}

/** `text` as exactly one answer of this protocol version, else undefined. Every field checked, every text field
 *  required to be CLEAN already (`isCleanCalendarText`) — the child cleans; the parent refuses what it did not. */
function answer(text: string): CalendarParseResult | undefined {
  let x: unknown;
  try { x = JSON.parse(text); } catch { return undefined; }
  if (!isObj(x) || x.v !== CALENDAR_PARSE_PROTOCOL) return undefined;
  if (x.ok === false) {
    return keysOk(x, ["v", "ok", "error"]) && (x.error === "bad-request" || x.error === "parse-error")
      ? { v: CALENDAR_PARSE_PROTOCOL, ok: false, error: x.error } : undefined;
  }
  if (x.ok !== true || !keysOk(x, ["v", "ok", "events", "index", "incomplete"])) return undefined;
  if (!Array.isArray(x.events) || x.events.length > CAL_PARSE_MAX_EVENTS || !x.events.every(eventOk)) return undefined;
  if (!Array.isArray(x.index) || !x.index.every(indexEntryOk)) return undefined;
  const inc = x.incomplete;
  if (!Array.isArray(inc) || new Set(inc).size !== inc.length || !inc.every((r) => CAL_PARSE_INCOMPLETE.includes(r as CalParseIncomplete))) return undefined;
  return { v: CALENDAR_PARSE_PROTOCOL, ok: true, events: x.events, index: x.index, incomplete: inc as CalParseIncomplete[] };
}

// ── the details kind's answer (redesign C) ──────────────────────────────────────────────────────────

/** Is `s` a string of at most `max` Unicode scalars? */
function scalarsAtMost(s: unknown, max: number): boolean {
  if (typeof s !== "string") return false;
  if (s.length <= max) return true;
  let n = 0;
  for (const _ of s) if (++n > max) return false;
  return true;
}

/** One event's raw details: the `CalRawDetails` shape exactly, each field within its cap. RAW text by design (the
 *  live read shows lightly cleaned notes and takes Join links from the raw fields), so it is checked for shape and
 *  size, never for cleanliness. */
function rawDetailsOk(d: unknown): boolean {
  if (!isObj(d) || !keysOk(d, ["people"], ["url", "location", "notes"])) return false;
  if (d.url !== undefined && !scalarsAtMost(d.url, CAL_DETAILS_URL_MAX)) return false;
  if (d.location !== undefined && !scalarsAtMost(d.location, CAL_DETAILS_LOCATION_MAX)) return false;
  if (d.notes !== undefined && !scalarsAtMost(d.notes, CAL_DETAILS_NOTES_MAX)) return false;
  if (!Array.isArray(d.people) || d.people.length > CAL_ATTENDEES_MAX) return false;
  return d.people.every((p) => isObj(p) && keysOk(p, ["name", "organiser"]) && typeof p.organiser === "boolean"
    && (p.name === null || scalarsAtMost(p.name, CAL_DETAILS_NAME_MAX)));
}

/** One event of a details answer: the morning's `eventOk` on everything but `details`, and `rawDetailsOk` on it. */
function detailsEventOk(e: unknown): e is CalDetailsWireEvent {
  if (!isObj(e)) return false;
  if (!("details" in e)) return eventOk(e);
  const { details, ...rest } = e;
  return rawDetailsOk(details) && eventOk(rest);
}

/** `text` as exactly one details answer of this protocol version, else undefined. */
function detailsAnswer(text: string): CalendarDetailsResult | undefined {
  let x: unknown;
  try { x = JSON.parse(text); } catch { return undefined; }
  if (!isObj(x) || x.v !== CALENDAR_PARSE_PROTOCOL) return undefined;
  if (x.ok === false) {
    return keysOk(x, ["v", "ok", "error"]) && (x.error === "bad-request" || x.error === "parse-error")
      ? { v: CALENDAR_PARSE_PROTOCOL, ok: false, error: x.error } : undefined;
  }
  if (x.ok !== true || x.kind !== "details" || !keysOk(x, ["v", "ok", "kind", "events", "index", "incomplete"], ["detailsCapped"])) return undefined;
  if (x.detailsCapped !== undefined && x.detailsCapped !== true) return undefined;
  if (!Array.isArray(x.events) || x.events.length > CAL_PARSE_MAX_EVENTS || !x.events.every(detailsEventOk)) return undefined;
  if (!Array.isArray(x.index) || !x.index.every(indexEntryOk)) return undefined;
  const inc = x.incomplete;
  if (!Array.isArray(inc) || new Set(inc).size !== inc.length || !inc.every((r) => CAL_PARSE_INCOMPLETE.includes(r as CalParseIncomplete))) return undefined;
  return {
    v: CALENDAR_PARSE_PROTOCOL, ok: true, kind: "details", events: x.events, index: x.index, incomplete: inc as CalParseIncomplete[],
    ...(x.detailsCapped === true ? { detailsCapped: true as const } : {}),
  };
}

/** Run one parse job in a child engine under a hard deadline. See the header. */
export async function runCalendarParse(request: CalendarParseRequest, opts: CalendarParseRunOpts): Promise<CalendarParseOutcome> {
  return runParse(request, opts, answer, CALENDAR_PARSE_MAX_OUTPUT_BYTES);
}

/** The details kind (redesign C): the same child and deadline, its own answer check and cap. See the header. */
export async function runCalendarDetailsParse(request: CalendarDetailsRequest, opts: CalendarParseRunOpts): Promise<CalendarDetailsOutcome> {
  return runParse(request, opts, detailsAnswer, CALENDAR_DETAILS_MAX_OUTPUT_BYTES);
}

/** The one body both kinds run: spawn, read under the cap, the deadline, then the kind's own answer check. */
async function runParse<R>(request: CalendarParseRequest, opts: CalendarParseRunOpts, check: (text: string) => R | undefined, defaultCap: number): Promise<ParseOutcome<R>> {
  const t0 = performance.now();
  const elapsedMs = () => Math.round(performance.now() - t0);
  const failed = (reason: CalendarParseFailure): ParseOutcome<R> => ({ status: "failed", reason, elapsedMs: elapsedMs() });
  const cmd = opts.command ?? calendarParseCommand();
  if (cmd === undefined || cmd.length === 0) return failed("no-runner");
  const cap = opts.maxOutputBytes ?? defaultCap;

  let child: ReturnType<typeof spawnChild>;
  try { child = spawnChild(cmd, request); } catch { return failed("spawn-failed"); }

  let tooLarge = false;
  const read = (async (): Promise<{ text: string; code: number | null }> => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = child.stdout.getReader();
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      bytes += step.value.byteLength;
      if (bytes > cap) {
        tooLarge = true;
        child.kill("SIGKILL");
        reader.cancel().catch(() => {});
        return { text: "", code: null };
      }
      chunks.push(step.value);
    }
    return { text: new TextDecoder().decode(Buffer.concat(chunks, bytes)), code: await child.exited };
  })();
  // After the deadline nobody awaits `read`; a late rejection from it must not surface as unhandled.
  read.catch(() => {});

  // The deadline counts from the CALL, not the spawn: serialising a 16 MB request takes ~0.1 s before the child
  // exists (measured on the compiled probe: a 150 ms deadline counted from the spawn resolved at 246 ms).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const left = Math.max(0, opts.timeoutMs - (performance.now() - t0));
  const deadline = new Promise<"deadline">((resolve) => { timer = setTimeout(() => resolve("deadline"), left); });
  let first: "deadline" | { text: string; code: number | null } | "read-error";
  try { first = await Promise.race([read, deadline]); } catch { first = "read-error"; } finally { clearTimeout(timer); }

  if (first === "deadline") {
    // The hard bound: SIGKILL cannot be caught or ignored, so a CPU-bound parse stops here. Not awaited — the
    // caller resolves now, and the runtime reaps the child.
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    return { status: "timeout", elapsedMs: elapsedMs() };
  }
  if (tooLarge) return failed("output-too-large");
  if (first === "read-error") { try { child.kill("SIGKILL"); } catch { /* already gone */ } return failed("bad-output"); }
  if (first.code !== 0) return failed("exit-nonzero");
  const result = check(first.text);
  if (result === undefined) return failed("bad-output");
  let maxRss: number | undefined;
  try { maxRss = child.resourceUsage()?.maxRSS; } catch { maxRss = undefined; }
  // rusage's ru_maxrss is bytes on macOS but KILOBYTES on Linux (CI on ubuntu read 227468 for a Bun child).
  if (typeof maxRss === "number" && process.platform === "linux") maxRss *= 1024;
  return { status: "ok", result, elapsedMs: elapsedMs(), ...(typeof maxRss === "number" ? { maxRss } : {}) };
}

/** The child's working directory: the filesystem root, never the parent's cwd. Bun — the compiled binary included —
 *  loads `<cwd>/.env` into the environment and runs a `<cwd>/bunfig.toml` preload even with `env: {}` (M2b
 *  checkpoint MEDIUM, measured: a `.env` variable reached the child), so a cwd the parent merely happens to be in
 *  (a repository, a download folder) must not be the child's. */
export function calendarParseCwd(platform: NodeJS.Platform = process.platform, systemRoot: string | undefined = process.env.SystemRoot): string {
  return platform === "win32" ? (systemRoot ?? "C:\\") : "/";
}

/** The one spawn in src/calendar/ (test/isolation.meta.test.ts R5 names this file, with the reason). stdin is the
 *  whole request, written by the runtime; stderr is discarded unread; the cwd is `calendarParseCwd()`. */
function spawnChild(cmd: string[], request: CalendarParseRequest) {
  return Bun.spawn(cmd, {
    stdin: new TextEncoder().encode(JSON.stringify(request)),
    stdout: "pipe",
    stderr: "ignore",
    env: childEnv(),
    cwd: calendarParseCwd(),
  });
}
