// src/calendar/mac-events.ts — the Mac Calendar Reader's `read` document → `CalEvent`s (v0.3.0 plan M10c; spec
// r4 §4.1 "Identity", §5). PURE: no I/O, so every rule is tested on Linux with canned documents.
//
// The helper sends raw EventKit facts (reader/Sources/ModeRead.swift `eventRecord`); this module validates every
// field it uses (the document is untrusted input: anything run as the user could write to an open FIFO), cleans
// every text field (`cleanCalEvent`, spec §6) and decides who "you" are:
//   • an attendee is you when EventKit says `isCurrentUser`, or their address is in `calendar.emails`;
//   • your answer: a DECLINE by you wins, else your strongest answer (accepted > tentative > needs-action) —
//     the link parser's rule (`src/calendar/ics.ts` `selfStatusOf`), so the two sources agree;
//   • with no answer of yours, `isCurrentUser` on the ORGANIZER of an event in an EDITABLE calendar makes you the
//     organizer, and is the raw trusted signal for `organizerVerified` — gated by G6's EventKit switch downstream
//     (reconcile step 0 and the prompt boundary), which ships OFF. A configured address never sets it.
// All-day events: EventKit's end is the last moment of the last day (or the next midnight); both are normalised to
// iCalendar's exclusive end date via the last day the event touches. The day strings come from the HELPER
// (`startDay`, `lastDay`, `occurrenceDay`, in its zone — the one Calendar shows; LaunchServices passes it no
// environment, so a `TZ` override on the engine must not shift them); this process's zone is only the fallback
// for a document without them.
import { createHash } from "node:crypto";
import { localDateStr } from "../marker";
import { CAL_UID_MAX } from "./ics";
import { cleanCalEvent } from "./clean";
import { producerKeys } from "./join";
import { allDayFromInclusiveEnd, overlapsToday } from "./reconcile";
import { CALENDAR_MACOS_SOURCE_ID } from "./render-contract";
import { capScalars, CAL_ATTENDEES_MAX, CAL_DETAILS_LOCATION_MAX, CAL_DETAILS_NAME_MAX, CAL_DETAILS_NOTES_MAX, CAL_DETAILS_URL_MAX } from "./ics";
import type { CalAttendeeStatus, CalDate, CalEvent, CalEventStatus, CalRawDetails, CalSelfStatus } from "./types";

/** At most this many events are taken from one document (the helper stops at 500). */
export const MAC_MAX_EVENTS = 500;
const MAX_ATTENDEES = 200;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
/** The link parser's UID rule (`src/calendar/ics.ts` `uidOf`), so the same event's UID is spelled the same from
 *  both sources (key a): kept when at most CAL_UID_MAX characters with no control character, else hashed. */
function uidOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const u = v.trim();
  if (u === "") return undefined;
  return u.length <= CAL_UID_MAX && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(u) ? u : `sha256:${createHash("sha256").update(u).digest("hex")}`;
}

/** A real `YYYY-MM-DD` date string, or undefined. */
const day = (v: unknown): string | undefined => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : undefined;
};
const ms = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 8.64e15 ? Math.trunc(v) : undefined);

const ANSWERS: Readonly<Record<string, CalAttendeeStatus>> = { accepted: "accepted", tentative: "tentative", "needs-action": "needs-action", declined: "declined" };
const RANK: Readonly<Record<CalAttendeeStatus, number>> = { declined: 9, accepted: 3, tentative: 2, "needs-action": 1 };
const STATUSES: Readonly<Record<string, CalEventStatus>> = { confirmed: "confirmed", tentative: "tentative", cancelled: "cancelled" };

type Person = { name?: string; email?: string; status?: CalAttendeeStatus; isCurrentUser: boolean };

function person(v: unknown): Person | undefined {
  if (!isRec(v)) return undefined;
  const name = str(v.name), email = str(v.email)?.trim().toLowerCase();
  const status = typeof v.status === "string" ? ANSWERS[v.status] : undefined;
  return { ...(name ? { name } : {}), ...(email ? { email } : {}), ...(status ? { status } : {}), isCurrentUser: v.isCurrentUser === true };
}

function selfStatus(attendees: Person[], organizer: Person | undefined, editable: boolean, emails: ReadonlySet<string>): CalSelfStatus {
  const you = (p: Person): boolean => p.isCurrentUser || (p.email !== undefined && emails.has(p.email));
  let best: CalAttendeeStatus | undefined;
  for (const a of attendees) {
    if (!you(a) || a.status === undefined) continue;
    if (best === undefined || RANK[a.status] > RANK[best]) best = a.status;
  }
  if (best !== undefined) return best;
  if (organizer?.isCurrentUser === true && editable) return "organizer";
  return "unknown";
}

/** One record → a cleaned `CalEvent`, or `undefined` when a field the model needs is missing or malformed. */
export function macEventFrom(v: unknown, emails: ReadonlySet<string>): CalEvent | undefined {
  if (!isRec(v)) return undefined;
  const calendarId = str(v.calendarId), title = str(v.title);
  const startMs = ms(v.startMs), endRaw = ms(v.endMs);
  if (calendarId === undefined || title === undefined || startMs === undefined || endRaw === undefined) return undefined;
  const endMs = Math.max(startMs, endRaw);
  const allDay = v.allDay === true;
  const time: CalEvent["time"] = allDay
    ? allDayFromInclusiveEnd(day(v.startDay) ?? localDateStr(new Date(startMs)), day(v.lastDay) ?? localDateStr(new Date(Math.max(startMs, endMs - 1))))
    : { kind: "timed", startMs, endMs };
  const editable = v.editable === true;
  const organizer = person(v.organizer);
  const attendees = (Array.isArray(v.attendees) ? v.attendees : []).slice(0, MAX_ATTENDEES).map(person).filter((p): p is Person => p !== undefined);
  const occurrence = ms(v.occurrenceMs);
  const uid = uidOf(v.uid);
  const description = str(v.notes), location = str(v.location);
  const lastModified = ms(v.lastModifiedMs);
  // The near-duplicate producer keys (spec 2026-10-31 §4), from the RAW location and notes, before cleaning, the same
  // in both modes. Never from the url field (`v.url`), which the details read alone carries.
  const keys = producerKeys({ location, notes: description });
  const raw: CalEvent = {
    sources: [{ kind: "macos", id: CALENDAR_MACOS_SOURCE_ID, calendarId }],
    ...(uid ? { uid } : {}),
    // Key a's spelling (types.ts `recurrenceKey`): epoch ms for a timed occurrence, the local date for an all-day one.
    ...(uid && occurrence !== undefined ? { recurrenceKey: allDay ? day(v.occurrenceDay) ?? localDateStr(new Date(occurrence)) : String(occurrence) } : {}),
    time,
    title,
    ...(location !== undefined ? { location } : {}),
    ...(organizer && (organizer.name || organizer.email) ? { organizer: { ...(organizer.name ? { name: organizer.name } : {}), ...(organizer.email ? { email: organizer.email } : {}) } } : {}),
    attendees: attendees.map((a) => ({ ...(a.name ? { name: a.name } : {}), ...(a.email ? { email: a.email } : {}), ...(a.status ? { status: a.status } : {}) })),
    selfStatus: selfStatus(attendees, organizer, editable, emails),
    // RAW trusted signal; G6's EventKit switch (shipped off) gates it in reconcile step 0 and at the prompt.
    organizerVerified: organizer?.isCurrentUser === true && editable,
    transparency: v.availability === "free" ? "free" : "busy",
    status: (typeof v.status === "string" ? STATUSES[v.status] : undefined) ?? "confirmed",
    ...(description !== undefined ? { description } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
    ...keys,
    provenance: {},
  };
  return cleanCalEvent(raw);
}

/** One record's RAW details for the live read (redesign C, wave-2 plan C-M2-T5): the event's own `url` field
 *  (reader version 2), the raw location and notes, and the people — the organiser first, then the attendees, each
 *  once by address, you (`isCurrentUser`, or an address in `calendar.emails`) left out, a nameless person as `null`.
 *  Capped like the link parser's (./ics.ts), in Unicode scalars; the reader caps them already. Never cleaned. */
export function macRawDetailsFrom(v: Rec, emails: ReadonlySet<string>): CalRawDetails {
  const people: CalRawDetails["people"] = [];
  const seen = new Set<string>();
  const add = (raw: unknown, organiser: boolean): void => {
    const p = person(raw);
    if (p === undefined || people.length >= CAL_ATTENDEES_MAX) return;
    if (p.isCurrentUser || (p.email !== undefined && emails.has(p.email))) return;
    if (p.email !== undefined) { if (seen.has(p.email)) return; seen.add(p.email); }
    people.push({ name: p.name !== undefined && p.name !== "" ? capScalars(p.name, CAL_DETAILS_NAME_MAX) : null, organiser });
  };
  add(v.organizer, true);
  for (const a of (Array.isArray(v.attendees) ? v.attendees : []).slice(0, MAX_ATTENDEES)) add(a, false);
  const url = str(v.url)?.trim(), location = str(v.location), notes = str(v.notes);
  return {
    ...(url ? { url: capScalars(url, CAL_DETAILS_URL_MAX) } : {}),
    ...(location ? { location: capScalars(location, CAL_DETAILS_LOCATION_MAX) } : {}),
    ...(notes ? { notes: capScalars(notes, CAL_DETAILS_NOTES_MAX) } : {}),
    people,
  };
}

/** Every usable record of a `read` document's `events`, and how many were dropped as malformed. `detailsFor` (the
 *  live details read only): each event overlapping that local date carries its raw details (`macRawDetailsFrom`). */
export function macEventsFrom(events: unknown, emails: readonly string[], opts: { detailsFor?: CalDate } = {}): { events: CalEvent[]; dropped: number } {
  const list = Array.isArray(events) ? events.slice(0, MAC_MAX_EVENTS) : [];
  const set = new Set(emails.map((e) => e.toLowerCase()));
  const out: CalEvent[] = [];
  let dropped = Array.isArray(events) ? Math.max(0, events.length - MAC_MAX_EVENTS) : events === undefined ? 0 : 1;
  for (const v of list) {
    const ev = macEventFrom(v, set);
    if (!ev) { dropped++; continue; }
    out.push(opts.detailsFor !== undefined && isRec(v) && overlapsToday(ev.time, opts.detailsFor) ? { ...ev, details: macRawDetailsFrom(v, set) } : ev);
  }
  return { events: out, dropped };
}
