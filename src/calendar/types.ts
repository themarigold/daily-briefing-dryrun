// src/calendar/types.ts — the CALENDAR CONTRACT (v0.3.0, plan M0). TYPES ONLY: nothing in this file runs,
// and it imports nothing, so any module may depend on it without pulling code into the binary.
//
// Source: the calendar-connection design (spec r4) — §5 the event model, §7 the struct, §8 the source
// statuses — and plan p4 §2 M0. Two audiences, frozen at different strengths:
//
//   • `CalEvent` / `CalTime` / provenance — the ENGINE-INTERNAL model (§5). It never leaves the process:
//     attendee names and emails and descriptions exist only here (§7: "Never stored by the app").
//   • `CalendarStruct` and the three `calendar … --json` shapes — the W1/W2 CONTRACT (§12: "The W1/W2
//     contract is `struct.calendar` plus the `calendar … --json` outputs, fixed first"). They leave the
//     process (`run --json`, the CLI's JSON) and the desktop app mirrors them, so they follow the
//     `src/types.ts` rule: ADDITIVE, OPTIONAL fields only — never rename, remove or retype a field, and
//     never widen a union a consumer may switch on without bumping `schemaVersion`.
//
// The rendered form of `CalendarStruct` is frozen separately, as bytes: `test/fixtures/calendar/
// rendered-section.txt` (source structs in `test/fixtures/calendar/contract.ts`). The constants that
// rendering shares with the audit and the GUI live in `./render-contract.ts`.

// ── time ─────────────────────────────────────────────────────────────────────────────────────────

/** A calendar date, `YYYY-MM-DD`, with no zone. */
export type CalDate = string;

/** A 24-hour wall-clock time, `HH:MM`, with no zone. */
export type CalWallTime = string;

/** A timed event: two absolute instants in epoch milliseconds. `endMs === startMs` is a zero-length event
 *  (a date-time DTSTART with neither DTEND nor DURATION, spec §4.2). Displayed in the LOCAL zone of the
 *  process that renders it. */
export type CalTimed = { kind: "timed"; startMs: number; endMs: number };

/** An all-day event. `endDateExclusive` is the day AFTER the last day, iCalendar's convention; EventKit's
 *  inclusive end is normalised to it at read time (spec §5), so both sources compare equal. A one-day event
 *  on 2026-10-14 is `{ startDate: "2026-10-14", endDateExclusive: "2026-10-15" }`. */
export type CalAllDay = { kind: "allDay"; startDate: CalDate; endDateExclusive: CalDate };

/** A timed event whose TZID could not be resolved (no VTIMEZONE, not an IANA name, not in the Windows
 *  table — spec §4.2). Only its WALL times are known: `wallStart` on `startDate` to `wallEnd` on `endDate`
 *  (both inclusive dates), in the zone the feed named, `tzid` (feed text, cleaned like any other field).
 *  Included when its wall-date range overlaps today; never counts as free time; marks its source
 *  `incomplete` (spec §5). */
export type CalUnclear = {
  kind: "unclear"; startDate: CalDate; endDate: CalDate; wallStart: CalWallTime; wallEnd: CalWallTime; tzid: string;
};

/** When an event happens. `kind` is the discriminant (spec §5 writes the three shapes as `{ timed: … }`,
 *  `{ allDay: … }`, `{ unclear: … }`; a `kind` tag is that same choice in a JSON- and serde-friendly form). */
export type CalTime = CalTimed | CalAllDay | CalUnclear;

// ── sources ──────────────────────────────────────────────────────────────────────────────────────

/** Where events come from: the macOS Calendar app through the signed reader helper (spec §4.1), or a
 *  private `https` calendar link (§4.2). Google sign-in, later, is a third kind behind the same seam. */
export type CalendarSourceKind = "macos" | "link";

/** Every source status, spec §8 — fixed text, naming the id, never the URL.
 *
 *  ⚠ Three different families share this one vocabulary, because the CLI's JSON and the health file report
 *  any of them:
 *   • `ok` — read in full;
 *   • NOTICES (`CalendarSourceNotice`) — the read still happened: `helper-outdated` ("a notice shown beside
 *     `ok`, never a failure or an incomplete source", §4.1) and `identity-unknown` (events are read and every
 *     one is treated as not accepted, §4.2);
 *   • everything else — the source contributed nothing (`not-granted` … `too-large`), or only part of
 *     what it holds (`incomplete`).
 *  A notice is never a source's `status` in the struct — it rides in `notices` beside the read status. */
export type CalendarSourceStatus =
  | "ok"
  | "not-granted"
  | "write-only"
  | "denied"
  | "restricted"
  | "unsupported-os"
  | "helper-missing"
  | "helper-outdated"
  | "identity-unknown"
  | "timeout"
  | "offline"
  | "link-refused"      // HTTP 401/403/404/410
  | "link-redirected"
  | "malformed"
  | "too-large"
  | "incomplete";

/** The statuses that leave the read intact. Shown beside the read status, never instead of it. */
export type CalendarSourceNotice = "helper-outdated" | "identity-unknown";

/** The outcome of reading one source: `ok`, `incomplete` (part of it), or one of the eleven failures. */
export type CalendarReadStatus = Exclude<CalendarSourceStatus, CalendarSourceNotice>;

// ── the engine-internal event model (spec §5) — never serialised out of the process ───────────────

/** How the user answered, on the merged event. `declined` wins over every other copy (§5 step 3);
 *  `unknown` is treated as not accepted for everything after the merge (§5 step 5). */
export type CalSelfStatus = "organizer" | "accepted" | "tentative" | "needs-action" | "declined" | "unknown";

/** One attendee's answer. Absent = not stated, or a value outside this list (iCalendar `DELEGATED`,
 *  EventKit `completed`/`inProcess`) — read as unknown. */
export type CalAttendeeStatus = "accepted" | "tentative" | "needs-action" | "declined";

/** The event's own STATUS (iCalendar `STATUS`; absent reads as `confirmed`). `cancelled` copies are kept as
 *  tombstones through the merge and dropped by the filter (§5 steps 1 and 4). */
export type CalEventStatus = "confirmed" | "tentative" | "cancelled";

/** iCalendar `TRANSP` / EventKit availability: does the event block the time? */
export type CalTransparency = "busy" | "free";

/** One copy's origin. `calendarId` is the EventKit calendar identifier, or the link's own id for a link
 *  (a link is one calendar). */
export type CalSourceRef = { kind: CalendarSourceKind; id: string; calendarId: string };

/** Where a text field's value came from (§5: "`provenance` records, per text field, which copy it came
 *  from"). `organizerVerified` is THAT COPY's flag, which the unlocked prompt variant needs: it keeps a
 *  field only when its provenance is a copy where you are the verified organizer (§6). */
export type CalProvenance = CalSourceRef & { organizerVerified: boolean };

/** The text fields whose provenance is kept: the three the merge takes from the most recently modified copy. */
export type CalTextField = "title" | "location" | "description";

/** An occurrence, after expansion and (once merged) after reconcile. Spec §5's model, field for field.
 *  Text fields are already cleaned (§6 "Cleaning, once, at read time"). */
export type CalEvent = {
  /** Every copy merged into this event; one entry before the merge. */
  sources: CalSourceRef[];
  uid?: string;
  /** The original occurrence start, for recurrence merging (§5 key a); EventKit:
   *  `calendarItemExternalIdentifier` + `occurrenceDate`. ABSENT for an event that does not recur.
   *  Compared as an exact string, so every source must spell it the same way (plan M3a): a date-time
   *  occurrence is its original start in epoch milliseconds as a decimal string (`"1791565200000"`), a
   *  date-only one is its original `YYYY-MM-DD`. `CalUidIndexEntry.recurrenceId` uses the same spelling.
   *  ⚠ LOAD-BEARING, BOTH ITS PRESENCE AND ITS SPELLING — for every occurrence of a recurring series, a detached
   *  occurrence (a RECURRENCE-ID override) included: key a matches on (uid, recurrenceKey), and the UID index
   *  supersedes on (uid, recurrenceId). An occurrence that arrives WITHOUT it is keyed like a single event, so it
   *  can merge with the wrong copy, or be superseded by an entry meant for another occurrence (M3a checkpoint). */
  recurrenceKey?: string;
  time: CalTime;
  title: string;
  location?: string;
  organizer?: { name?: string; email?: string };
  /** Unioned by email across copies (§5 step 3). Names are attendee-written and never leave the process. */
  attendees: { name?: string; email?: string; status?: CalAttendeeStatus }[];
  selfStatus: CalSelfStatus;
  /** True only through a trusted signal AND a passed gate G6 for that source kind (§5). Ships false for both kinds (G6 failed for both, 2026-10-12).
   *  A PRODUCER sets the raw trusted signal (the link parser: ORGANIZER equals the confirmed Google URL-path owner,
   *  `src/calendar/ics.ts`); the G6 gate is applied by `reconcileCalendar` step 0 and again at the prompt boundary,
   *  so after reconcile — the only path to the struct and the prompt — it is false while G6 is off for its kind. */
  organizerVerified: boolean;
  transparency: CalTransparency;
  status: CalEventStatus;
  /** Never stored by the app (§7). */
  description?: string;
  /** Epoch ms (iCalendar `LAST-MODIFIED` / EventKit `lastModifiedDate`) — the merge's tie-breaker. */
  lastModified?: number;
  /** iCalendar `SEQUENCE` (plan M3a; links only — EventKit has none). Compared before `lastModified` when
   *  both copies carry one; see `newerThan` in `src/calendar/reconcile.ts`. */
  sequence?: number;
  provenance: Partial<Record<CalTextField, CalProvenance>>;
  /** ENGINE-INTERNAL, the live details read only (redesign C): this copy's RAW details, set by a producer in details
   *  mode for an occurrence on the run date and never on the morning path. Never in the struct, the archive, the
   *  envelope or a prompt: `toCalendarStruct` copies field by field. */
  details?: CalRawDetails;
  /** ENGINE-INTERNAL producer keys (calendar near-duplicates, spec 2026-10-31 §4), each a lower-case SHA-256 hex
   *  digest, set by a producer (`producerKeys`, ./join.ts) from this copy's RAW location and notes before cleaning,
   *  in both modes. They cross the parse pipe (protocol 3) and reach reconcile's key c, and never the struct, page,
   *  prompt, details JSON, Rust, webview, diagnostics, health or any file: `toStructEvent` copies field by field.
   *  `meetingKey`: the meeting identity from the first raw field (location, then notes) holding a known-host link. */
  meetingKey?: string;
  /** `placeKey`: the normalised raw location text with every URL removed, hashed; absent when nothing is left. */
  placeKey?: string;
  /** `linkKeys`: one key per valid https link in the raw location, sorted, unique, at most 8; absent, never []. */
  linkKeys?: string[];
  /** ENGINE-INTERNAL, set only by a key-c merge in details mode when two or more non-cancelled views remain (spec §5
   *  "Per-view carrier"): each such view's cleaned title, trust tier and own raw details, the core first, then merge
   *  order. Never on the wire (`CalWireEvent` omits it), the struct, the details JSON or a prompt. */
  viewDetails?: CalViewDetails[];
  /** ENGINE-INTERNAL, set only on a key-c merge result with two or more counted views (spec §6): the decided merge
   *  mark and its count (an integer ≥ 2). Projected into the struct's `merged`; never on the wire or in a prompt. */
  nearDuplicate?: CalMergeMark;
};

/** The decided key-c merge mark (spec §6): ` · on N calendars` or ` · N copies`, `count` an integer ≥ 2. */
export type CalMergeMark = { mark: "calendars" | "copies"; count: number };

/** One non-cancelled view of a key-c merge, for the live details read (spec §5 "Per-view carrier"). */
export type CalViewDetails = { title: string; tier: 1 | 2 | 3; details: CalRawDetails | undefined };

/** One occurrence's raw details for the live read (redesign C, wave-2 plan C-M1-T2): taken BEFORE any cleaning, each
 *  field capped at the Mac reader's figures in Unicode scalars (the URL tier and the location 1 000, the notes 4 000,
 *  at most 200 people, each name 200). `url` is the event's own link field (ICS `URL`, else `X-GOOGLE-CONFERENCE`,
 *  else `X-MICROSOFT-SKYPETEAMSMEETINGURL`; the Mac's `url`). `people` leaves you out; a person with no name is
 *  `null`, never their address. Read by the live details command only; raw notes never leave the engine. */
export type CalRawDetails = {
  url?: string;
  location?: string;
  notes?: string;
  people: { name: string | null; organiser: boolean }[];
};

/** One VEVENT block as a link parser's cheap TEXT pass saw it (spec §4.2: "a small index of every block's
 *  UID, RECURRENCE-ID, start, SEQUENCE and LAST-MODIFIED") — EVERY block in the feed, including the ones the
 *  overlap pre-filter dropped, which are exactly the ones this exists for: a copy moved far out of the
 *  reconcile window is never parsed into a `CalEvent`, yet it must still supersede a stale copy of the same
 *  occurrence that the SAME source (the same feed) still has inside the window (§5 step 1). ONLY within its own
 *  source (decision 19, `src/calendar/reconcile.ts`): another source's copy is never hidden by this index.
 *  Filled by the M2c parser; read by `reconcileCalendar` (M3a). */
export type CalUidIndexEntry = {
  uid: string;
  /** RECURRENCE-ID in `CalEvent.recurrenceKey`'s spelling; absent for a single event or a series master. */
  recurrenceId?: string;
  /** DTSTART as epoch ms, resolved the way the parser resolves the event's own start (a date-only start is
   *  its local midnight); `null` when the text pass cannot read it cheaply. A `null` start never
   *  supersedes anything: the entry cannot show that the copy moved OUT of the window. */
  startMs: number | null;
  sequence?: number;
  /** Epoch ms of LAST-MODIFIED. */
  lastModified?: number;
  /** The block carries `RRULE:` or `RDATE:` — it is a recurring series' MASTER (M2c's text pass sets it). Such an
   *  entry never supersedes anything: its `startMs` is the series' FIRST start (often years outside the window)
   *  and its LAST-MODIFIED moves with any edit to the series, so without this flag it would hide today's
   *  occurrence of that very series whenever that occurrence carries no `recurrenceKey` (M3a checkpoint MEDIUM). */
  recurs?: true;
};

/** One link's index (spec §4.2: built per feed by the same text pass). `sourceId` is the link id, and it SCOPES the
 *  index: an entry supersedes only a copy carried by that same source (decision 19, `src/calendar/reconcile.ts`). */
export type CalUidIndex = { sourceId: string; entries: readonly CalUidIndexEntry[] };

// ── the struct: `BriefingStruct.calendar` (spec §7) — W1/W2 contract ───────────────────────────────

/** The status the rendered section marks: `tentative` when the event's own STATUS is tentative OR your
 *  answer is tentative; `confirmed` otherwise. Cancelled and declined events never reach the struct. */
export type CalendarDisplayStatus = Exclude<CalEventStatus, "cancelled">;

/** One of today's events as the briefing STORES it: only titles, times, locations and attendee counts —
 *  never attendee names or emails, never descriptions (spec §7). Built from `CalEvent`, never by
 *  serialising one. */
export type CalendarStructEvent = {
  time: CalTime;
  title: string;
  location?: string;
  status: CalendarDisplayStatus;
  transparency: CalTransparency;
  /** Attendees on the merged event (you included); 0 when it lists none. */
  attendeeCount: number;
  /** PRESENT when the event had already ended at generation time (spec §6 "(ended)"). Stored, not derived
   *  at render, so a page re-rendered later from the same struct (the desktop app) says what the morning's
   *  page said. Literal `true`, like `promoted`: absent means "not ended". */
  ended?: true;
  /** PRESENT only on a key-c near-duplicate merge (calendar near-duplicates, spec 2026-10-31 §6): the mark and count
   *  reconcile decided (`CalEvent.nearDuplicate`, projected field by field), `count` an integer ≥ 2. The renderer
   *  writes it as given (` · on N calendars` / ` · N copies`); absent on every older or unmerged struct. */
  merged?: CalMergeMark;
};

/** One configured source and how its read went. `status` is the read outcome; `notices` carries the
 *  statuses that do not stop a read (`helper-outdated`, `identity-unknown`), absent when there are none. */
export type CalendarStructSource = {
  id: string;
  kind: CalendarSourceKind;
  status: CalendarReadStatus;
  notices?: CalendarSourceNotice[];
};

/** `BriefingStruct.calendar` — PRESENT only when calendar is on (absent with calendar off, so every
 *  existing struct, envelope and render is byte-identical). `events` holds every event that overlaps today,
 *  already ordered (all-day first, then by start, spec §5 step 6) and NOT capped (the rendered section caps
 *  at `CALENDAR_MAX_EVENT_LINES` and says `+N more`). Over that cap, the first N are the shown selection —
 *  distinct events before further repeats of one series — and the rest follow, each part in that order
 *  (fix-round 1, `sectionOrder` in `./pipeline.ts`). `incomplete` is true exactly when some source's
 *  `status` is not `ok`. */
export type CalendarStruct = {
  events: CalendarStructEvent[];
  sources: CalendarStructSource[];
  incomplete: boolean;
};

// ── the `calendar … --json` shapes (spec §8 CLI) — W1/W2 contract ────────────────────────────────
//
// Each carries `schemaVersion: 1`, the `src/json.ts` rule: additive fields leave it at 1; anything else
// bumps it. None of them ever carries a link URL, an attendee or a description. Example fixtures:
// `test/fixtures/calendar/calendar-{list,test,status}.json`.

/** One Mac calendar, for Settings' checklist (spec §8). `editable` is EventKit's
 *  `allowsContentModifications`; `type` separates the two kinds that start unticked under the default
 *  `"editable"` selection; `selected` is whether the current config reads it. */
export type CalendarMacosCalendar = {
  id: string;
  title: string;
  /** The account (EventKit source) title, e.g. "iCloud" or a Google address — shown so the user can untick
   *  an editable calendar someone else shared (§2). */
  account: string;
  editable: boolean;
  type: "standard" | "subscribed" | "birthdays";
  selected: boolean;
};

/** One configured link, as `list` reports it. NEVER its URL.
 *  (JSON contract amendment, hub decision 2026-10-09 for M5, already used by the desktop app: the three owner
 *  facts are reported separately rather than folded into one `owner` + `ownerFrom` + `ownerConfirmed`.) */
export type CalendarLinkInfo = {
  id: string;
  /** The free-text display label from config, passed through the calendar link scrub (`scrubCalendarLinks`). */
  name?: string;
  /** The configured `owner` — recognises your accept or decline only, never makes you the organizer (§4.2). */
  configuredOwner?: string;
  /** The personal address in a Google secret link's URL path (§4.2, G4), read from the link's URL locally — no
   *  network. Absent when the URL holds none, or is not read for `list` (a `urlCommand` link: running a password
   *  manager to draw a list would prompt). */
  urlPathOwner?: string;
  /** The URL-path address the user confirmed is theirs (§4.2), or `null`. Reported only while it still equals the
   *  URL's current path owner (a replaced link never inherits a confirmation); for a `urlCommand` link, whose URL
   *  `list` does not read, the configured value as written. */
  confirmedOwner: string | null;
  /** Which rung of the credential ladder holds the URL (§2): the managed file, `urlEnv` or `urlCommand`. */
  urlFrom: "file" | "env" | "command";
  /** For a `file` link only: whether the managed file reads — `ok`, `missing`, `refused` or `failed` — and, when
   *  not `ok`, M1's reason code (`file-missing`, `file-permissions`, …). */
  fileStatus?: "ok" | "missing" | "refused" | "failed";
  fileReason?: string;
};

/** `daily-briefing calendar list --json`. */
export type CalendarListJson = {
  schemaVersion: 1;
  /** The Mac Calendar app: its read status (e.g. `not-granted` before access, `helper-missing`,
   *  `unsupported-os`) and its calendars (empty unless readable). `null` off macOS. */
  macos: { status: CalendarReadStatus; notices?: CalendarSourceNotice[]; calendars: CalendarMacosCalendar[] } | null;
  links: CalendarLinkInfo[];
};

/** `daily-briefing calendar test --json`: a read now, per configured source. Counts only — no titles. */
export type CalendarTestJson = {
  schemaVersion: 1;
  /** ISO-8601 instant the test read started. */
  ranAt: string;
  sources: {
    id: string;
    kind: CalendarSourceKind;
    status: CalendarReadStatus;
    notices?: CalendarSourceNotice[];
    /** Events overlapping today that this source contributed; `null` when nothing was read. */
    eventsToday: number | null;
    durationMs: number;
    /** A machine reason code when the status is not `ok` (`http-refused`, `env-unset`, `parse-error`, …): a
     *  credential failure is `malformed` with M1's code here. Additive (hub decision, M5). */
    reason?: string;
  }[];
  incomplete: boolean;
};

/** The last read a source had, from `<state>/calendar/health.json` (spec §3 "Health"). */
export type CalendarLastRead = {
  /** ISO-8601 instant of the read. */
  at: string;
  status: CalendarReadStatus;
  notices?: CalendarSourceNotice[];
  /** The machine reason code recorded with a status that is not `ok`. Additive (hub decision, M5). */
  reason?: string;
};

/** `daily-briefing calendar status --json`: configuration plus each source's LAST SCHEDULED read — the
 *  evidence the unattended path works ("not yet", "ok at 07:21", or the failure; spec §8). Makes no
 *  network call and never prompts. */
export type CalendarStatusJson = {
  schemaVersion: 1;
  /** `calendar.enabled` as resolved (a malformed block resolves to false). */
  enabled: boolean;
  /** True when the block carries an own, non-null `enabled` (config.ts's `own()` rule): the user has answered on or
   *  off. False with no block, no `enabled`, or `"enabled": null` — which `enabled` alone cannot tell from "off". */
  enabledSet: boolean;
  /** `platform === "darwin" && macOsSupported()` (macOS 14+), the pairing `calendar connect mac` uses: whether a Mac
   *  Calendar source can be connected on this machine. A `macos` source is listed on any darwin, even where false. */
  macSupported: boolean;
  /** The resolver's fixed-text warnings; never quote a configured value or a URL (spec §2). */
  configWarnings: string[];
  sources: {
    id: string;
    kind: CalendarSourceKind;
    name?: string;
    /** `null` until a scheduled run has read this source ("not yet"). */
    lastScheduledRead: CalendarLastRead | null;
  }[];
};
