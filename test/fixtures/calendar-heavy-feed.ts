// test/fixtures/calendar-heavy-feed.ts — a deterministic synthetic iCalendar feed of any size (calendar v0.3.0,
// plan M2b, gate G5: "parse time and memory for a heavy multi-year feed (synthetic is fine)").
//
// Shaped like a real exported calendar: a VTIMEZONE with DST rules, X-WR-TIMEZONE, and per event UID, DTSTAMP,
// SEQUENCE, LAST-MODIFIED, DTSTART/DTEND in that zone, SUMMARY, LOCATION, a DESCRIPTION, an ORGANIZER and
// ATTENDEEs, a STATUS, and every `recurringEvery`-th event a weekly RRULE — all folded at 75 octets with CRLF, as
// RFC 5545 and Google's exporter do. Events are spread evenly over `years` years ending on `end`. ASCII only, so
// characters are octets. No randomness: the same options give the same bytes, so M2c's re-measurement of G5 runs
// on exactly the feeds M2b measured (the options used are recorded in src/calendar/parse-runner.ts).

export type HeavyFeedOpts = {
  events: number;
  years: number;
  /** Characters of DESCRIPTION per event (default 120; 0 = no DESCRIPTION line). */
  descriptionChars?: number;
  /** ATTENDEE lines per event (default 3). */
  attendees?: number;
  /** Every n-th event carries `RRULE:FREQ=WEEKLY;COUNT=52` (default 25; 0 = none). */
  recurringEvery?: number;
  /** The last day the feed covers (default 2026-10-09, UTC midnight). */
  end?: Date;
};

const VTIMEZONE = [
  "BEGIN:VTIMEZONE", "TZID:America/New_York", "X-LIC-LOCATION:America/New_York",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "TZNAME:EDT", "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "TZNAME:EST", "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
  "END:VTIMEZONE",
];

const WORDS = ["quarterly", "review", "sync", "planning", "roadmap", "budget", "design", "standup", "retro", "hiring",
  "customer", "launch", "metrics", "incident", "offsite", "onboarding", "architecture", "compliance", "release", "demo"];

/** RFC 5545 §3.1 folding: at most 75 octets per physical line, continuation lines start with one space. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(` ${line.slice(i, i + 74)}`);
  return parts.join("\r\n");
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** A floating local date-time `YYYYMMDDTHHMMSS` from a Date's UTC fields (the zone comes from TZID). */
const local = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
const utc = (d: Date) => `${local(d)}Z`;

/** Words, deterministically, to exactly `chars` characters. */
function text(seed: number, chars: number): string {
  let s = "";
  for (let i = 0; s.length < chars; i++) s += `${WORDS[(seed * 7 + i * 13) % WORDS.length]} `;
  return s.slice(0, chars);
}

/** The feed. See the header. */
export function heavyFeed(o: HeavyFeedOpts): string {
  const descChars = o.descriptionChars ?? 120;
  const attendees = o.attendees ?? 3;
  const every = o.recurringEvery ?? 25;
  const end = (o.end ?? new Date(Date.UTC(2026, 9, 9))).getTime();
  const span = o.years * 365.25 * 86_400_000;
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//daily-briefing//G5 synthetic feed//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:G5 heavy", "X-WR-TIMEZONE:America/New_York", ...VTIMEZONE];
  for (let i = 0; i < o.events; i++) {
    // Evenly spread, snapped to a quarter hour between 08:00 and 18:45 local.
    const day = new Date(end - span + Math.floor((span * i) / Math.max(1, o.events)));
    const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 8 + (i % 11), (i % 4) * 15));
    const stop = new Date(start.getTime() + (30 + (i % 4) * 15) * 60_000);
    const ev = [
      "BEGIN:VEVENT",
      `DTSTART;TZID=America/New_York:${local(start)}`,
      `DTEND;TZID=America/New_York:${local(stop)}`,
      `DTSTAMP:${utc(new Date(end))}`,
      `UID:g5-${i}-${(i * 2654435761) % 4294967296}@synthetic.example.com`,
      `SEQUENCE:${i % 5}`,
      `LAST-MODIFIED:${utc(new Date(start.getTime() - 86_400_000))}`,
      `CREATED:${utc(new Date(start.getTime() - 7 * 86_400_000))}`,
      `SUMMARY:${text(i, 24 + (i % 20))}`,
      `LOCATION:Room ${100 + (i % 400)}\\, Building ${String.fromCharCode(65 + (i % 26))}`,
      `ORGANIZER;CN=Organizer ${i % 50}:mailto:organizer${i % 50}@example.com`,
    ];
    if (descChars > 0) ev.push(`DESCRIPTION:${text(i + 1, descChars)}`);
    for (let a = 0; a < attendees; a++) {
      ev.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${["ACCEPTED", "TENTATIVE", "NEEDS-ACTION", "DECLINED"][(i + a) % 4]};CN=Person ${(i + a) % 300};X-NUM-GUESTS=0:mailto:person${(i + a) % 300}@example.com`);
    }
    if (every > 0 && i % every === 0) ev.push("RRULE:FREQ=WEEKLY;COUNT=52");
    ev.push(`STATUS:${i % 40 === 0 ? "CANCELLED" : "CONFIRMED"}`, "TRANSP:OPAQUE", "END:VEVENT");
    lines.push(...ev);
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
