// src/calendar/parse-job.ts — the job the `calendar-parse` CHILD runs (v0.3.0 plan M2b/M2c; spec r4 §3 "Hard bound on
// work", §4.2 "Parse").
//
// The engine never parses a calendar feed in its own process. `./parse-runner.ts` re-invokes the engine binary
// with the hidden `calendar-parse` subcommand, hands it ONE request on stdin, reads ONE JSON answer from stdout,
// and kills it at the deadline. `src/main.ts` routes that subcommand here BEFORE anything reads a config, a
// state file, the environment's credentials or the network — this module and what it imports (`./ics.ts`,
// `./clean.ts`, `./reconcile.ts`, `../transcripts/credentials.ts`, `./config.ts` for the id grammar) are pure, and it
// reads only stdin and writes only stdout (pinned by `test/calendar-parse.test.ts`, which runs the real
// `src/main.ts calendar-parse` with HOME, XDG_CONFIG_HOME and DAILY_BRIEFING_STATE_DIR in empty temp dirs and
// asserts they are still empty afterwards).
//
// The job (M2c): load the vendored `ical.js` by DYNAMIC import (spec §4.2: only when calendar is on — and only ever
// inside this child) and run `parseIcsFeed` (`./ics.ts`): the pre-filter, the UID index, time zones, expansion,
// identity — and CLEANING.
//
// ── WHY CLEANING HAPPENS HERE, IN THE CHILD ───────────────────────────────────────────────────────────────────
// `cleanCalEvent` runs on every event before it is written to stdout, so nothing the parent's callers receive — or
// anything that is ever persisted — is uncleaned (spec §6 "Cleaning, once, at read time"):
//   • it is CPU-bound work over untrusted, unbounded text (a description can be megabytes), so it belongs under the
//     hard deadline that SIGKILLs runaway work, not in the engine's own process;
//   • it is what makes the answer SMALL: the caps (title 120, description 400 characters) bound each event, so the
//     parent's stdout cap (`CALENDAR_PARSE_MAX_OUTPUT_BYTES`) can be sized to the result instead of to the feed;
//   • the parent still trusts nothing: `./parse-runner.ts` refuses an answer whose text is not already clean (a line
//     break, a control or invisible character, an over-cap field — `isCleanCalendarText`), so a version-skewed or
//     broken child cannot hand uncleaned text through. Re-cleaning in the parent was rejected: cleaning is not
//     idempotent (entity decoding runs again: `&amp;lt;` → `&lt;` → `<`), so a second pass would change the text.
//
// NOTHING FROM THE FEED LEAVES IN AN ERROR: a failure is a fixed code, never a message, so a parser error that
// quotes the offending line (it can hold a description, an attendee, a link) never reaches the parent.
//
// TWO REQUEST KINDS (redesign C, wave-2 plan C-M1-T2). The morning's request carries no `kind` and is answered exactly
// as before. A request with `kind: "details"` (the live details read only) is answered by `parseIcsDetails`: the same
// cleaned events, index and flags, plus each run-date occurrence's RAW details, and the answer echoes `kind:
// "details"` so the parent can tell it from a morning answer (an older child, at the same protocol, ignores the kind
// and answers morning-shaped, which the parent's details check refuses). Any other `kind` is a bad request. The
// protocol stays 2: the morning's request, answer, check and cap are unchanged.

import { CALENDAR_LINK_ID_RE } from "./config";
import {
  CAL_PARSE_MAX_EVENTS, parseIcsDetails, parseIcsFeed, type CalDetailsWireEvent, type CalLinkIdentity, type CalParseIncomplete, type CalWireEvent,
} from "./ics";
import { cleanEmail } from "./clean";
import type { CalDate, CalUidIndexEntry } from "./types";

/** The request/response protocol version. The parent refuses an answer with any other `v`. 2 since M2c (the
 *  request carries the run date, the zone and the identity; the answer the events and the index); 3 since the
 *  calendar near-duplicates work (spec 2026-10-31 §4: a wire event may carry the producer keys `meetingKey`,
 *  `placeKey` and `linkKeys`, all three under this one bump). */
export const CALENDAR_PARSE_PROTOCOL = 3;

/** What the parent sends: one feed's text and what the child needs to place and attribute it — never the link's
 *  URL (the identity is derived from it by the parent, `./link-parse.ts`). */
export type CalendarParseRequest = {
  v: typeof CALENDAR_PARSE_PROTOCOL;
  ics: string;
  /** The link id (grammar `CALENDAR_LINK_ID_RE`). */
  sourceId: string;
  /** The run's local date, `YYYY-MM-DD`. */
  runDate: CalDate;
  /** The parent's IANA zone. */
  zone: string;
  identity: CalLinkIdentity;
  /** ≤ CAL_PARSE_MAX_EVENTS (spec §3's 5,000 is an aggregate; the parent passes what is left). */
  maxEvents: number;
};

/** What the child answers. `bad-request`: stdin was not a request this child understands (a version skew, or not
 *  JSON at all). `parse-error`: the text is not an iCalendar feed (no VCALENDAR). */
export type CalendarParseResult =
  | { v: typeof CALENDAR_PARSE_PROTOCOL; ok: true; events: CalWireEvent[]; index: CalUidIndexEntry[]; incomplete: CalParseIncomplete[] }
  | CalendarParseError;
export type CalendarParseError = { v: typeof CALENDAR_PARSE_PROTOCOL; ok: false; error: "bad-request" | "parse-error" };

/** The details request (redesign C): the morning's request plus `kind: "details"`. */
export type CalendarDetailsRequest = CalendarParseRequest & { kind: "details" };
/** The details answer: `kind: "details"` echoed; `detailsCapped` when the details budget cut later occurrences. */
export type CalendarDetailsResult =
  | { v: typeof CALENDAR_PARSE_PROTOCOL; ok: true; kind: "details"; events: CalDetailsWireEvent[]; index: CalUidIndexEntry[]; incomplete: CalParseIncomplete[]; detailsCapped?: true }
  | CalendarParseError;

/** At most this many identity addresses (the configured owner, the URL-path owner, `calendar.emails`). */
export const CALENDAR_PARSE_SELF_MAX = 64;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date (`2026-02-30` is not). */
function isDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return t.getUTCFullYear() === Number(m[1]) && t.getUTCMonth() === Number(m[2]) - 1 && t.getUTCDate() === Number(m[3]);
}

/** The request, field by field, or undefined. `details` when it is the details kind. */
function readRequest(request: unknown): (CalendarParseRequest & { details: boolean }) | undefined {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return undefined;
  const r = request as Record<string, unknown>;
  if (r.v !== CALENDAR_PARSE_PROTOCOL || typeof r.ics !== "string") return undefined;
  if (r.kind !== undefined && r.kind !== "details") return undefined;
  if (typeof r.sourceId !== "string" || !CALENDAR_LINK_ID_RE.test(r.sourceId)) return undefined;
  if (typeof r.runDate !== "string" || !isDate(r.runDate)) return undefined;
  if (typeof r.zone !== "string" || r.zone === "" || r.zone.length > 64) return undefined;
  try { new Intl.DateTimeFormat("en-US", { timeZone: r.zone }); } catch { return undefined; }
  if (!Number.isSafeInteger(r.maxEvents) || (r.maxEvents as number) < 0 || (r.maxEvents as number) > CAL_PARSE_MAX_EVENTS) return undefined;
  const id = r.identity as Record<string, unknown> | null;
  if (typeof id !== "object" || id === null || !Array.isArray(id.self) || id.self.length > CALENDAR_PARSE_SELF_MAX) return undefined;
  const self = id.self as unknown[];
  if (!self.every((e) => typeof e === "string" && cleanEmail(e) === e)) return undefined;
  const vo = id.verifiedOrganizer;
  if (vo !== undefined && (typeof vo !== "string" || !self.includes(vo))) return undefined;
  return {
    v: CALENDAR_PARSE_PROTOCOL, ics: r.ics, sourceId: r.sourceId, runDate: r.runDate, zone: r.zone, maxEvents: r.maxEvents as number,
    identity: { self: self as string[], ...(vo !== undefined ? { verifiedOrganizer: vo as string } : {}) }, details: r.kind === "details",
  };
}

/** Run one parse job. Never throws. */
export async function calendarParseJob(request: unknown): Promise<CalendarParseResult | CalendarDetailsResult> {
  const v = CALENDAR_PARSE_PROTOCOL;
  const r = readRequest(request);
  if (r === undefined) return { v, ok: false, error: "bad-request" };
  try {
    // DYNAMIC, so `bun build --compile` bundles the vendored file into the binary (a static string specifier)
    // while nothing evaluates it until a parse job runs. Measured on the compiled binary from a source-free
    // directory (M2b, and again for M2c's G5): it loads.
    const { default: ICAL } = await import("./vendor/ical.js");
    if (r.details) {
      const d = parseIcsDetails(ICAL, r);
      return d.ok
        ? { v, ok: true, kind: "details", events: d.events, index: d.index, incomplete: d.incomplete, ...(d.detailsCapped ? { detailsCapped: true as const } : {}) }
        : { v, ok: false, error: "parse-error" };
    }
    const res = parseIcsFeed(ICAL, r);
    return res.ok ? { v, ok: true, events: res.events, index: res.index, incomplete: res.incomplete } : { v, ok: false, error: "parse-error" };
  } catch {
    return { v, ok: false, error: "parse-error" };
  }
}

/** The child's streams. Injected so the in-process tests need no subprocess; the defaults are the real ones.
 *  `writeStdout` may be async, and is AWAITED: the real one resolves only once the runtime has written every byte
 *  to the pipe (M2b checkpoint MEDIUM — `process.stdout.write` followed at once by `process.exit` delivered only
 *  512–786 KiB of 1–32 MiB answers, at random, with exit code 0). */
export type CalendarParseIo = { readStdin: () => Promise<string>; writeStdout: (s: string) => void | Promise<void> };

const REAL_IO: CalendarParseIo = {
  readStdin: () => Bun.stdin.text(),
  writeStdout: async (s) => { await Bun.write(Bun.stdout, s); },
};

/** The `calendar-parse` subcommand: read ONE request from stdin (to EOF), write ONE JSON line to stdout, return
 *  the exit code — 0 for any answer, ok or not, so the parent tells "the child answered" from "the child died"
 *  by the exit code and the shape of stdout alone. stderr is never written. Returns only after the answer has been
 *  written in full (`src/main.ts` exits the process next). */
export async function calendarParseMain(io: CalendarParseIo = REAL_IO): Promise<number> {
  let request: unknown;
  try { request = JSON.parse(await io.readStdin()); } catch { request = undefined; }
  await io.writeStdout(`${JSON.stringify(await calendarParseJob(request))}\n`);
  return 0;
}
