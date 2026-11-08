// src/calendar/link-parse.ts — ONE link's fetched feed → today's-window events, in the PARENT (v0.3.0 plan M2c; spec r4
// §4.2 "Identity", §3 "Hard bound on work").
//
// The parent's half of a link parse: derive who "you" are for this link (it alone sees the URL, which never goes to
// the child), build the request, run it through the hard-bounded `calendar-parse` child (`./parse-runner.ts`), and
// turn the child's checked, already-CLEANED answer into `CalEvent`s carrying this link as their source. Called by
// the calendar step (`readCalendar`, src/calendar/pipeline.ts), which `runCore` and `calendar test` run.
//
// IDENTITY (spec §4.2). "You" for a link is:
//   • the address in a Google secret link's URL path (`/calendar/ical/<id>/private-…/basic.ics`) when it is a
//     PERSONAL address — a calendar id under `calendar.google.com` (`…@group.calendar.google.com`,
//     `…@import.calendar.google.com`, `…@resource.calendar.google.com`, and `…@group.v.calendar.google.com` holiday
//     calendars) is a calendar, not a person, and never an owner;
//   • the configured `owner`;
//   • every `calendar.emails` address.
// Those recognise your accept or decline — except that a URL-path address is dropped when the link has a configured
// `owner` that differs from it and the path address is not confirmed (fix-round 1). Only the URL-path owner, on a Google link, AND confirmed by the user
// (`confirmedOwner` equal to it — a confirmation of some other address counts for nothing) can mark you as the
// organizer (`verifiedOrganizer`, and through it `organizerVerified` — still behind gate G6, off). With no address
// at all the source carries the `identity-unknown` notice and every event from it is unknown — not accepted.
//
// THE DETAILS KIND (redesign C, wave-2 plan C-M1-T2): with `details: true` the request carries `kind: "details"`,
// the parent checks the answer with the details check (`runCalendarDetailsParse`), and each run-date event carries
// its raw details as the engine-internal `details` field beside its cleaned fields. Without it the request and the
// result are byte-identical to the morning's.
import { calendarEmail, type ResolvedCalendarLink } from "./config";
import { CAL_PARSE_MAX_EVENTS, type CalLinkIdentity, type CalParseIncomplete } from "./ics";
import { CALENDAR_PARSE_PROTOCOL, CALENDAR_PARSE_SELF_MAX } from "./parse-job";
import { runCalendarDetailsParse, runCalendarParse, type CalendarParseFailure } from "./parse-runner";
import type { CalDate, CalEvent, CalUidIndex, CalendarSourceNotice } from "./types";

/** The personal address in a Google secret link's URL path, lower-cased, or undefined: not Google
 *  (`calendar.google.com`, or the older `www.google.com/calendar/ical/…`), not that path, not an address, or a
 *  calendar id rather than a person. Never throws; never returns any other part of the URL. */
export function googleUrlPathOwner(url: string): string | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  const host = u.hostname.toLowerCase();
  if (host !== "calendar.google.com" && host !== "www.google.com") return undefined;
  const m = /^\/calendar\/ical\/([^/]+)\//.exec(u.pathname);
  if (!m) return undefined;
  let id: string;
  try { id = decodeURIComponent(m[1]!); } catch { return undefined; }
  const addr = calendarEmail(id);
  if (addr === undefined) return undefined;
  id = addr;
  const domain = id.slice(id.lastIndexOf("@") + 1);
  if (domain === "calendar.google.com" || domain.endsWith(".calendar.google.com")) return undefined;
  return id;
}

/** The identity the child matches against, plus the notice when there is none (spec §4.2). */
export function linkIdentity(url: string, link: Pick<ResolvedCalendarLink, "owner" | "confirmedOwner">, emails: readonly string[]): { identity: CalLinkIdentity; notices: CalendarSourceNotice[] } {
  const pathOwner = googleUrlPathOwner(url);
  // Fix-round 1: when the link has a configured `owner` that DIFFERS from the URL-path address and that address is
  // not confirmed, the URL-path address is not "you" at all — a shared calendar (boss@ in the path, you as owner)
  // would otherwise read the boss's decline as yours and hide a meeting you accepted. Only the configured owner
  // and `calendar.emails` are then you.
  const owner = link.owner?.toLowerCase();
  const pathOwnerConfirmed = pathOwner !== undefined && link.confirmedOwner?.toLowerCase() === pathOwner;
  const pathIsSelf = pathOwner !== undefined && (owner === undefined || owner === pathOwner || pathOwnerConfirmed);
  const self = [...new Set([pathIsSelf ? pathOwner : undefined, owner, ...emails.map((e) => e.toLowerCase())].filter((e): e is string => typeof e === "string" && e !== ""))]
    .slice(0, CALENDAR_PARSE_SELF_MAX);
  const verified = pathOwnerConfirmed ? pathOwner : undefined;
  return {
    identity: { self, ...(verified !== undefined && self.includes(verified) ? { verifiedOrganizer: verified } : {}) },
    notices: self.length === 0 ? ["identity-unknown"] : [],
  };
}

/** The process's IANA zone, as the child must use it for "local" (dates, floating times, the window). */
export function localZoneName(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof z === "string" && z !== "") return z;
  } catch { /* fall through */ }
  return "UTC";
}

export type LinkParseInput = {
  /** The link's resolved config (its id, `owner`, `confirmedOwner`). */
  link: Pick<ResolvedCalendarLink, "id" | "owner" | "confirmedOwner">;
  /** The link's URL — used here for the identity only; it never leaves this function. */
  url: string;
  /** `calendar.emails`. */
  emails: readonly string[];
  /** The fetched feed. */
  ics: string;
  /** The run's local date, captured once at run start. */
  runDate: CalDate;
  /** What is left of the step's 30 s bound. */
  timeoutMs: number;
  /** What is left of spec §3's 5,000 parsed events (default all of it). */
  maxEvents?: number;
  /** The live details read only (redesign C): ask for the details kind. Absent on the morning path. */
  details?: true;
  /** TEST seams, passed through to `runCalendarParse`. */
  command?: string[];
  zone?: string;
};

export type LinkParseOutcome =
  /** `detailsCapped` (the details kind only): the child's details budget left later occurrences without details. */
  | { status: "ok"; events: CalEvent[]; index: CalUidIndex; incomplete: CalParseIncomplete[]; notices: CalendarSourceNotice[]; elapsedMs: number; maxRss?: number; detailsCapped?: true }
  /** The text is not an iCalendar feed (M4 reports the source `malformed`). */
  | { status: "parse-error"; elapsedMs: number }
  | { status: "timeout"; elapsedMs: number }
  | { status: "failed"; reason: CalendarParseFailure | "bad-request"; elapsedMs: number };

/** Parse one link's feed in the hard-bounded child. Never throws; carries no feed text and never the URL. */
export async function parseCalendarLink(input: LinkParseInput): Promise<LinkParseOutcome> {
  const { identity, notices } = linkIdentity(input.url, input.link, input.emails);
  const maxEvents = Math.max(0, Math.min(CAL_PARSE_MAX_EVENTS, Math.floor(input.maxEvents ?? CAL_PARSE_MAX_EVENTS)));
  const request = { v: CALENDAR_PARSE_PROTOCOL, ics: input.ics, sourceId: input.link.id, runDate: input.runDate, zone: input.zone ?? localZoneName(), identity, maxEvents } as const;
  const opts = { timeoutMs: input.timeoutMs, ...(input.command ? { command: input.command } : {}) };
  const out = input.details === true ? await runCalendarDetailsParse({ ...request, kind: "details" }, opts) : await runCalendarParse(request, opts);
  if (out.status !== "ok") return out;
  const r = out.result;
  if (!r.ok) return r.error === "parse-error" ? { status: "parse-error", elapsedMs: out.elapsedMs } : { status: "failed", reason: "bad-request", elapsedMs: out.elapsedMs };
  const source = { kind: "link" as const, id: input.link.id, calendarId: input.link.id };
  return {
    status: "ok",
    events: r.events.map((e) => ({ ...e, sources: [source], provenance: {} })),
    index: { sourceId: input.link.id, entries: r.index },
    incomplete: r.incomplete,
    notices,
    elapsedMs: out.elapsedMs,
    ...(out.maxRss !== undefined ? { maxRss: out.maxRss } : {}),
    ...("detailsCapped" in r && r.detailsCapped === true ? { detailsCapped: true as const } : {}),
  };
}
