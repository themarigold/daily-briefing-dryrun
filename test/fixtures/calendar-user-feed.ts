// test/fixtures/calendar-user-feed.ts — a synthetic feed SHAPED LIKE THE USER'S (calendar v0.3.0 plan M2c; spec r4
// §1.1, measured 2026-10-09 by property name only, no content read): 152 events spanning 2018–2026; 134 with ATTENDEE
// lines, all carrying CN= and PARTSTAT=; 82 ORGANIZER; 144 non-empty DESCRIPTION; 109 non-empty LOCATION; 8 RRULE;
// 2 RECURRENCE-ID; 2 EXDATE; 2 VTIMEZONE covering both TZIDs used; TRANSP on all 152; 131 UTC starts; 15 date-only
// (all-day) starts; one X-WR-TIMEZONE. Google's exporter style: CRLF, 75-octet folding, `mailto:` values.
//
// Deterministic and synthetic (no real names). Descriptions carry HTML, an entity, a URL, a passcode and Google
// Meet's boilerplate block, so the feed exercises cleaning too. `USER_FEED_COUNTS` states the shape; the test
// re-counts it from the text rather than trusting this header.

export const USER_FEED_RUN_DATE = "2026-10-09";
export const USER_FEED_SELF = "me@example.com";

export const USER_FEED_COUNTS = {
  events: 152, attendeeEvents: 134, organizer: 82, description: 144, location: 109, rrule: 8, recurrenceId: 2, exdate: 2,
  vtimezone: 2, transp: 152, utcStarts: 131, dateStarts: 15,
} as const;

const VTZ = [
  "BEGIN:VTIMEZONE", "TZID:America/Los_Angeles", "X-LIC-LOCATION:America/Los_Angeles",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0800", "TZOFFSETTO:-0700", "TZNAME:PDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:-0700", "TZOFFSETTO:-0800", "TZNAME:PST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VTIMEZONE", "TZID:Asia/Kolkata", "X-LIC-LOCATION:Asia/Kolkata",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0530", "TZOFFSETTO:+0530", "TZNAME:IST", "DTSTART:19700101T000000", "END:STANDARD",
  "END:VTIMEZONE",
];

function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(` ${line.slice(i, i + 74)}`);
  return parts.join("\r\n");
}
const pad = (n: number) => String(n).padStart(2, "0");
/** `YYYYMMDDTHHMMSS` from a Date's UTC fields (a wall time when a TZID is attached). */
const stamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
const dateOnly = (d: Date) => stamp(d).slice(0, 8);

const STATUSES = ["ACCEPTED", "TENTATIVE", "NEEDS-ACTION", "DECLINED"] as const;
const DAY = 86_400_000;

export const userFeedUid = (i: number): string => `${((i * 2654435761) % 4294967296).toString(16)}x${i}@google.com`;

/** Which events are which — chosen so every count in USER_FEED_COUNTS is exact:
 *   • 0–14 date-only (15); 15–18 TZID America/Los_Angeles; 141–142 TZID Asia/Kolkata (6 zoned) — the rest UTC (131);
 *   • series (RRULE): 16, 18, 30, 45, 60, 100, 141, 142 (8); EXDATE on 16 and 141 (2);
 *   • 150 and 151 are RECURRENCE-ID overrides of series 141 and 142 (their UID), each moved elsewhere (2);
 *   • 140–151 start within the reconcile window around USER_FEED_RUN_DATE; the rest spread over 2018-01-03 … 2026-10-02. */
export function userShapedFeed(): string {
  const lines = ["BEGIN:VCALENDAR", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "VERSION:2.0", "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH", `X-WR-CALNAME:${USER_FEED_SELF}`, "X-WR-TIMEZONE:America/Los_Angeles", ...VTZ];
  const t0 = Date.UTC(2018, 0, 3, 17, 0), t1 = Date.UTC(2026, 9, 2, 17, 0);
  const runDay = Date.UTC(2026, 9, 9);
  const tzidFor = (i: number): string | undefined => (i >= 15 && i <= 18 ? "America/Los_Angeles" : i === 141 || i === 142 ? "Asia/Kolkata" : undefined);
  const series = new Set([16, 18, 30, 45, 60, 100, 141, 142]);
  const exdate = new Set([16, 141]);
  const startOf = (i: number): number => (i >= 140 ? runDay + ((i - 146) * 6 + 9) * 3600_000 : t0 + Math.floor(((t1 - t0) * i) / 140));
  for (let i = 0; i < USER_FEED_COUNTS.events; i++) {
    const start = startOf(i);
    const s = new Date(start), e = new Date(start + (30 + (i % 4) * 15) * 60_000);
    const tz = tzidFor(i);
    const ev = ["BEGIN:VEVENT"];
    if (i < 15) ev.push(`DTSTART;VALUE=DATE:${dateOnly(s)}`, `DTEND;VALUE=DATE:${dateOnly(new Date(start + DAY))}`);
    else if (tz !== undefined) ev.push(`DTSTART;TZID=${tz}:${stamp(s)}`, `DTEND;TZID=${tz}:${stamp(e)}`);
    else ev.push(`DTSTART:${stamp(s)}Z`, `DTEND:${stamp(e)}Z`);
    if (series.has(i)) ev.push(i % 2 === 0 ? "RRULE:FREQ=WEEKLY;BYDAY=FR" : "RRULE:FREQ=DAILY;COUNT=400");
    if (exdate.has(i)) ev.push(tz ? `EXDATE;TZID=${tz}:${stamp(new Date(start + 2 * DAY))}` : `EXDATE:${stamp(new Date(start + 2 * DAY))}Z`);
    ev.push("DTSTAMP:20261009T120000Z");
    if (i < 82) ev.push(`ORGANIZER;CN=Organizer ${i % 9}:mailto:${i % 3 === 0 ? USER_FEED_SELF : `org${i % 9}@example.org`}`);
    // The overrides share their series' UID and name the occurrence they replace (its ORIGINAL start, in the
    // series' zone): 150 replaces 141's second occurrence (daily), 151 replaces 142's first (its DTSTART).
    const uid = i === 150 ? userFeedUid(141) : i === 151 ? userFeedUid(142) : userFeedUid(i);
    ev.push(`UID:${uid}`);
    if (i === 150) ev.push(`RECURRENCE-ID;TZID=Asia/Kolkata:${stamp(new Date(startOf(141) + DAY))}`);
    if (i === 151) ev.push(`RECURRENCE-ID;TZID=Asia/Kolkata:${stamp(new Date(startOf(142)))}`);
    if (i < 134) {
      ev.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${STATUSES[i % 4]};CN=${USER_FEED_SELF};X-NUM-GUESTS=0:mailto:${USER_FEED_SELF}`);
      ev.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Guest ${i % 17};X-NUM-GUESTS=0:mailto:guest${i % 17}@example.org`);
    }
    ev.push(`CREATED:${stamp(new Date(start - 30 * DAY))}Z`);
    if (i < 144) {
      ev.push(`DESCRIPTION:<b>Agenda</b> for item ${i}\\nNotes &amp; links: https://docs.example.com/d/${i}?usp=sharing\\n\\nPasscode: 4815${i}\\n`
        + "-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-\\nJoin with Google Meet: https://meet.google.com/abc-defg-hij");
    }
    ev.push(`LAST-MODIFIED:${stamp(new Date(start - DAY + (i === 150 || i === 151 ? 2 * DAY : 0)))}Z`);
    if (i < 109) ev.push(`LOCATION:Room ${100 + i}\\, Building ${String.fromCharCode(65 + (i % 26))}`);
    ev.push(`SEQUENCE:${i === 150 || i === 151 ? 3 : i % 3}`, "STATUS:CONFIRMED", `SUMMARY:Item ${i} ${["sync", "review", "planning", "1:1"][i % 4]}`,
      `TRANSP:${i % 5 === 0 ? "TRANSPARENT" : "OPAQUE"}`, "END:VEVENT");
    lines.push(...ev);
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
