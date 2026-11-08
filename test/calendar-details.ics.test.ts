// test/calendar-details.ics.test.ts — the ICS DETAILS request kind (redesign C, wave-2 plan C-M1-T2): a second request
// kind of the `calendar-parse` child, `kind: "details"`, that returns, per occurrence ON THE RUN DATE only, the raw
// (pre-clean) URL tier (`URL`, then `X-GOOGLE-CONFERENCE`, then `X-MICROSOFT-SKYPETEAMSMEETINGURL`), the raw location,
// the raw description and the people (names with the organiser flag, you left out), each capped at the reader's
// figures and all of them within a running byte budget. The morning's request, protocol, answer check and cap are
// unchanged (the existing calendar parse tests run unmodified beside this file).
//
// UNVERIFIED: the two vendor property names on real feeds (source: C spec). Every feed here is synthetic; the real
// feeds are the author gate.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ICAL from "../src/calendar/vendor/ical.js";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import {
  CAL_ATTENDEES_MAX, CAL_DETAILS_BUDGET_BYTES, parseIcsDetails, parseIcsFeed, type CalDetailsWireEvent, type IcsParseInput,
} from "../src/calendar/ics";
import { CALENDAR_PARSE_PROTOCOL, calendarParseJob, type CalendarDetailsRequest, type CalendarParseRequest } from "../src/calendar/parse-job";
import {
  CALENDAR_DETAILS_MAX_OUTPUT_BYTES, CALENDAR_PARSE_MAX_OUTPUT_BYTES, runCalendarDetailsParse, runCalendarParse,
} from "../src/calendar/parse-runner";
import { parseCalendarLink } from "../src/calendar/link-parse";

const RUN = "2026-10-09";
const PARSE_JOB = resolve(import.meta.dir, "../src/calendar/parse-job.ts");
const child = (code: string) => [process.execPath, "-e", code];
const JOB_CHILD = child(`import { calendarParseMain } from ${JSON.stringify(PARSE_JOB)}; process.exit(await calendarParseMain());`);

let uidN = 0;
const ev = (...lines: string[]): string[] => ["BEGIN:VEVENT", ...(lines.some((l) => l.startsWith("UID")) ? [] : [`UID:d${++uidN}@test`]), ...lines, "END:VEVENT"];
const feed = (...events: string[][]): string => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flat(), "END:VCALENDAR", ""].join("\r\n");
const input = (ics: string, over: Partial<IcsParseInput> = {}): IcsParseInput => ({
  ics, sourceId: "work", runDate: RUN, zone: "UTC", identity: { self: [] }, maxEvents: 5_000, ...over,
});
function details(ics: string, over: Partial<IcsParseInput> = {}) {
  const r = parseIcsDetails(ICAL, input(ics, over));
  if (!r.ok) throw new Error("parse-error");
  return r;
}
const scalars = (s: string): number => [...s].length;
const byTitle = (es: readonly CalDetailsWireEvent[], t: string): CalDetailsWireEvent => {
  const hit = es.filter((e) => e.title === t);
  if (hit.length !== 1) throw new Error(`${t}: ${hit.length}`);
  return hit[0]!;
};
/** A long HTML invite, as Google's feeds write them (escaped for a TEXT value). */
const htmlInvite = (bytes: number): string => {
  const unit = "<p>Agenda item with <b>bold</b>\\, a <a href=\"https://docs.example/x\">link</a> and more words.</p><br>";
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
};

describe("the details path's fields (in process)", () => {
  test("the URL tier: URL, then X-GOOGLE-CONFERENCE, then X-MICROSOFT-SKYPETEAMSMEETINGURL; raw location and description", () => {
    const r = details(feed(
      ev("SUMMARY:All three", "DTSTART:20261009T090000Z", "DTEND:20261009T093000Z", "URL:https://zoom.us/j/111",
        "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij", "X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/x",
        "LOCATION:Room 4\\, https://zoom.us/j/999", "DESCRIPTION:Line one\\nPasscode: 4242\\nhttps://zoom.us/j/111"),
      ev("SUMMARY:Google only", "DTSTART:20261009T100000Z", "DTEND:20261009T103000Z", "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
        "X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/y"),
      ev("SUMMARY:Teams only", "DTSTART:20261009T110000Z", "DTEND:20261009T113000Z", "X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/z"),
      ev("SUMMARY:None", "DTSTART:20261009T120000Z", "DTEND:20261009T123000Z"),
    ));
    const all = byTitle(r.events, "All three").details!;
    expect(all.url).toBe("https://zoom.us/j/111");
    // Raw: the location and the notes are not cleaned (no "zoom.us link", no redaction, newlines kept).
    expect(all.location).toBe("Room 4, https://zoom.us/j/999");
    expect(all.notes).toBe("Line one\nPasscode: 4242\nhttps://zoom.us/j/111");
    expect(byTitle(r.events, "Google only").details!.url).toBe("https://meet.google.com/abc-defg-hij");
    expect(byTitle(r.events, "Teams only").details!.url).toBe("https://teams.microsoft.com/l/meetup-join/z");
    expect(byTitle(r.events, "None").details).toEqual({ people: [] });
    // The cleaned fields beside them are the morning's own.
    expect(byTitle(r.events, "All three").location).not.toContain("https://");
  });

  test("people: names with the organiser flag, the organiser first and once, you left out, a nameless person as null", () => {
    const r = details(feed(ev("SUMMARY:Sync", "DTSTART:20261009T090000Z", "DTEND:20261009T100000Z",
      "ORGANIZER;CN=Priya Sharma:mailto:priya@example.com",
      "ATTENDEE;CN=Priya Sharma;PARTSTAT=ACCEPTED:mailto:priya@example.com",
      "ATTENDEE;CN=Me Myself;PARTSTAT=ACCEPTED:mailto:me@example.com",
      "ATTENDEE;CN=\"Sam Lee\";PARTSTAT=TENTATIVE:mailto:sam@example.com",
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:nameless@example.com")),
      { identity: { self: ["me@example.com"] } });
    expect(r.events[0]!.details!.people).toEqual([
      { name: "Priya Sharma", organiser: true }, { name: "Sam Lee", organiser: false }, { name: null, organiser: false },
    ]);
    // You as the organiser: left out too.
    const mine = details(feed(ev("SUMMARY:Mine", "DTSTART:20261009T090000Z", "ORGANIZER;CN=Me:mailto:me@example.com",
      "ATTENDEE;CN=Ana N:mailto:ana@example.com")), { identity: { self: ["me@example.com"] } });
    expect(mine.events[0]!.details!.people).toEqual([{ name: "Ana N", organiser: false }]);
  });

  test("only occurrences on the run date carry details; the day before and after, and other days of a series, carry none", () => {
    const r = details(feed(
      ev("SUMMARY:Yesterday", "DTSTART:20261008T090000Z", "DTEND:20261008T100000Z", "URL:https://zoom.us/j/1"),
      ev("SUMMARY:Today", "DTSTART:20261009T090000Z", "DTEND:20261009T100000Z", "URL:https://zoom.us/j/2"),
      ev("SUMMARY:Tomorrow", "DTSTART:20261010T090000Z", "DTEND:20261010T100000Z", "URL:https://zoom.us/j/3"),
      ev("SUMMARY:Overnight", "DTSTART:20261008T230000Z", "DTEND:20261009T010000Z", "URL:https://zoom.us/j/4"),
      ev("SUMMARY:All day today", "DTSTART;VALUE=DATE:20261009", "URL:https://zoom.us/j/5"),
      ev("SUMMARY:Daily", "DTSTART:20261001T080000Z", "DTEND:20261001T081500Z", "RRULE:FREQ=DAILY", "URL:https://zoom.us/j/6"),
    ));
    expect(byTitle(r.events, "Yesterday").details).toBeUndefined();
    expect(byTitle(r.events, "Tomorrow").details).toBeUndefined();
    expect(byTitle(r.events, "Today").details!.url).toBe("https://zoom.us/j/2");
    expect(byTitle(r.events, "Overnight").details!.url).toBe("https://zoom.us/j/4");   // overlaps the run date
    expect(byTitle(r.events, "All day today").details!.url).toBe("https://zoom.us/j/5");
    const daily = r.events.filter((e) => e.title === "Daily");
    expect(daily.length).toBe(5);   // the reconcile window, today ± 2 days
    const withDetails = daily.filter((e) => e.details !== undefined);
    expect(withDetails.map((e) => (e.time.kind === "timed" ? new Date(e.time.startMs).toISOString() : "?"))).toEqual(["2026-10-09T08:00:00.000Z"]);
    expect(r.detailsCapped).toBeUndefined();
  });

  test("the run date is the parent's local date (zone input), not UTC's", () => {
    // 2026-10-09 23:30 in New York is 2026-10-10 03:30 UTC: on the run date there, not in UTC.
    const ics = feed(ev("SUMMARY:Late", "DTSTART:20261010T033000Z", "DTEND:20261010T040000Z", "URL:https://zoom.us/j/7"));
    expect(details(ics, { zone: "America/New_York" }).events[0]!.details!.url).toBe("https://zoom.us/j/7");
    expect(details(ics, { zone: "UTC" }).events[0]!.details).toBeUndefined();
  });

  test("each raw field is capped at the reader's figures, in Unicode scalars, before any cleaning", () => {
    const people = Array.from({ length: 300 }, (_, i) => `ATTENDEE;CN=Person ${i}:mailto:p${i}@example.com`);
    const r = details(feed(ev("SUMMARY:Big", "DTSTART:20261009T090000Z", "DTEND:20261009T100000Z",
      `URL:https://zoom.us/j/${"1".repeat(5_000)}`, `LOCATION:${"😀".repeat(5_000)}`, `DESCRIPTION:${htmlInvite(50_000)}`,
      `ORGANIZER;CN=${"N".repeat(500)}:mailto:org@example.com`, ...people)));
    const d = r.events[0]!.details!;
    expect(scalars(d.url!)).toBe(1_000);
    expect(scalars(d.location!)).toBe(1_000);   // 1 000 scalars, 2 000 UTF-16 units
    expect(d.location!.length).toBe(2_000);
    expect(scalars(d.notes!)).toBe(4_000);
    expect(d.notes!.startsWith("<p>Agenda item with <b>bold</b>, a ")).toBe(true);   // raw HTML, unescaped TEXT
    expect(d.people.length).toBe(CAL_ATTENDEES_MAX);
    expect(d.people[0]).toEqual({ name: "N".repeat(200), organiser: true });
  });

  test("the morning parse of the same feed is unchanged: no details anywhere, the same cleaned events", () => {
    const ics = feed(
      ev("SUMMARY:Sync https://zoom.us/j/9", "DTSTART:20261009T090000Z", "DTEND:20261009T100000Z", "URL:https://zoom.us/j/9",
        "LOCATION:https://zoom.us/j/9", "DESCRIPTION:Passcode: 1234", "ATTENDEE;CN=Ana:mailto:ana@example.com"),
      ev("SUMMARY:Tomorrow", "DTSTART:20261010T090000Z", "DTEND:20261010T100000Z"),
    );
    const morning = parseIcsFeed(ICAL, input(ics));
    const live = details(ics);
    if (!morning.ok) throw new Error("parse-error");
    expect(JSON.stringify(morning)).not.toContain("details");
    expect(Object.keys(morning).sort()).toEqual(["events", "incomplete", "index", "ok"]);
    expect(live.events.map(({ details: _d, ...rest }) => rest)).toEqual(morning.events);
    expect([live.index, live.incomplete]).toEqual([morning.index, morning.incomplete]);
  });

  test("a big shared calendar: under the parent's cap, flagged details-capped, the earliest occurrences keep their details", () => {
    const attendees = Array.from({ length: 300 }, (_, i) => `ATTENDEE;CN=Attendee Number ${i} With A Long Name:mailto:a${i}@example.com`);
    const desc = `DESCRIPTION:${htmlInvite(50_000)}`;
    const loc = `LOCATION:${"Conference room, building ".repeat(60)}`;
    // Written LATEST FIRST, so feed order is the reverse of start order: the budget must follow the start order.
    const events = Array.from({ length: 400 }, (_, i) => {
      const n = 399 - i;
      const start = new Date(Date.UTC(2026, 9, 9, 0, 0) + n * 3 * 60_000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      return ev(`SUMMARY:Meeting ${String(n).padStart(3, "0")}`, `DTSTART:${start}`, "DURATION:PT2M", `URL:https://zoom.us/j/${n}`, loc, desc, ...attendees);
    });
    const r = details(feed(...events));
    expect(r.events.length).toBe(400);
    expect(r.detailsCapped).toBe(true);
    const answer = JSON.stringify({ v: CALENDAR_PARSE_PROTOCOL, kind: "details", ...r });
    expect(Buffer.byteLength(answer)).toBeLessThan(CALENDAR_DETAILS_MAX_OUTPUT_BYTES);
    const byStart = [...r.events].sort((a, b) => (a.time.kind === "timed" && b.time.kind === "timed" ? a.time.startMs - b.time.startMs : 0));
    const kept = byStart.map((e) => e.details !== undefined);
    const firstMissing = kept.indexOf(false);
    expect(firstMissing).toBeGreaterThan(0);
    expect(kept.slice(0, firstMissing).every(Boolean)).toBe(true);
    expect(kept.slice(firstMissing).some(Boolean)).toBe(false);   // none after the budget
    const detailsBytes = r.events.reduce((n, e) => n + (e.details ? Buffer.byteLength(JSON.stringify(e.details)) : 0), 0);
    expect(detailsBytes).toBeLessThanOrEqual(CAL_DETAILS_BUDGET_BYTES);
    expect(byStart[0]!.title).toBe("Meeting 000");
  }, 60_000);
});

describe("producer keys: read parity between the morning and details answers (near-duplicates P06)", () => {
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  test("P06 the morning and details answers give identical keys, a conflicting URL-field link included", () => {
    const ics = feed(
      ev("SUMMARY:Conflict", "DTSTART:20261009T090000Z", "DTEND:20261009T100000Z", "URL:https://zoom.us/j/111", "LOCATION:Clinic North https://zoom.us/j/222",
        "DESCRIPTION:https://zoom.us/j/333"),
      ev("SUMMARY:Notes", "DTSTART:20261009T110000Z", "DTEND:20261009T120000Z", "LOCATION:Room 4", "DESCRIPTION:Join https://meet.google.com/abc-defg-hij"),
      ev("SUMMARY:Url only", "DTSTART:20261009T130000Z", "DTEND:20261009T140000Z", "URL:https://zoom.us/j/444"),
    );
    const morning = parseIcsFeed(ICAL, input(ics)), live = details(ics);
    if (!morning.ok) throw new Error("parse-error");
    const keys = (es: readonly CalDetailsWireEvent[]) => es.map((e) => [e.title, e.meetingKey, e.placeKey, e.linkKeys]);
    expect(keys(live.events)).toEqual(keys(morning.events));
    expect(keys(morning.events)).toEqual([
      ["Conflict", sha("zoom\u0000222"), sha("clinic north"), [sha("zoom.us/j/222")]],
      ["Notes", sha("meet\u0000abc-defg-hij"), sha("room 4"), undefined],
      ["Url only", undefined, undefined, undefined],
    ]);
    expect(byTitle(live.events, "Conflict").details?.url).toBe("https://zoom.us/j/111");
  });
});

describe("the child's request kinds", () => {
  const req = (ics: string, extra: Record<string, unknown> = {}): CalendarParseRequest & Record<string, unknown> => ({
    v: CALENDAR_PARSE_PROTOCOL, ics, sourceId: "work", runDate: RUN, zone: "UTC", identity: { self: [] }, maxEvents: 5_000, ...extra,
  });
  const ICS = feed(ev("SUMMARY:One", "DTSTART:20261009T090000Z", "URL:https://zoom.us/j/1"));
  test("kind: details answers with kind details and each run-date event's details; no kind is the morning answer", async () => {
    const d = await calendarParseJob(req(ICS, { kind: "details" }));
    expect(d.ok && "kind" in d && d.kind).toBe("details");
    expect(d.ok && d.events[0] && "details" in d.events[0] ? d.events[0].details : null).toEqual({ url: "https://zoom.us/j/1", people: [] });
    const m = await calendarParseJob(req(ICS));
    expect(m.ok && Object.keys(m).sort()).toEqual(["events", "incomplete", "index", "ok", "v"]);
    expect(JSON.stringify(m)).not.toContain("details");
  });
  test("any other kind is a bad request", async () => {
    expect(await calendarParseJob(req(ICS, { kind: "morning" }))).toEqual({ v: CALENDAR_PARSE_PROTOCOL, ok: false, error: "bad-request" });
    expect(await calendarParseJob(req(ICS, { kind: 1 }))).toEqual({ v: CALENDAR_PARSE_PROTOCOL, ok: false, error: "bad-request" });
  });
});

describe("the parent's details check and cap", () => {
  const request: CalendarDetailsRequest = { v: CALENDAR_PARSE_PROTOCOL, ics: "", sourceId: "work", runDate: RUN, zone: "UTC", identity: { self: [] }, maxEvents: 5_000, kind: "details" };
  const wire = { time: { kind: "timed", startMs: 1, endMs: 2 }, title: "t", attendees: [], selfStatus: "unknown", organizerVerified: false, transparency: "busy", status: "confirmed" };
  const writes = (doc: unknown) => child(`process.stdout.write(${JSON.stringify(JSON.stringify(doc))});`);
  const ok = (events: unknown[], extra: Record<string, unknown> = {}) => ({ v: CALENDAR_PARSE_PROTOCOL, ok: true, kind: "details", events, index: [], incomplete: [], ...extra });

  test("the cap is the morning's plus the details budget", () => {
    expect(CAL_DETAILS_BUDGET_BYTES).toBe(2 * 1024 * 1024);
    expect(CALENDAR_DETAILS_MAX_OUTPUT_BYTES).toBe(CALENDAR_PARSE_MAX_OUTPUT_BYTES + CAL_DETAILS_BUDGET_BYTES);
  });
  test("a well-formed details answer is accepted, raw text included", async () => {
    const d = { url: "https://zoom.us/j/1", location: "Room\n4", notes: "<b>raw</b>\u0007", people: [{ name: null, organiser: false }, { name: "Ana", organiser: true }] };
    const r = await runCalendarDetailsParse(request, { timeoutMs: 10_000, command: writes(ok([{ ...wire, details: d }, wire], { detailsCapped: true })) });
    expect(r.status).toBe("ok");
    if (r.status !== "ok" || !r.result.ok) throw new Error("not ok");
    expect(r.result.events.map((e) => e.details)).toEqual([d, undefined]);
    expect(r.result.detailsCapped).toBe(true);
  });
  test("a details answer with a present but wrong kind is refused", async () => {
    const r = await runCalendarDetailsParse(request, { timeoutMs: 10_000,
      command: writes(ok([{ ...wire, details: { people: [] } }], { kind: "morning" })) });
    expect(r).toMatchObject({ status: "failed", reason: "bad-output" });
  });
  test("an answer over CALENDAR_DETAILS_MAX_OUTPUT_BYTES is refused, and the child killed", async () => {
    const big = child(`const s = " ".repeat(1024 * 1024); for (let i = 0; i < 13; i++) await Bun.write(Bun.stdout, s);`);
    expect(await runCalendarDetailsParse(request, { timeoutMs: 20_000, command: big })).toMatchObject({ status: "failed", reason: "output-too-large" });
  });
  test("refused: a morning-shaped answer (a child that ignored the kind), an over-cap field, a bad person, a bad flag", async () => {
    const bad = async (doc: unknown) => (await runCalendarDetailsParse(request, { timeoutMs: 10_000, command: writes(doc) })).status === "failed";
    expect(await bad({ v: CALENDAR_PARSE_PROTOCOL, ok: true, events: [wire], index: [], incomplete: [] })).toBe(true);
    expect(await bad(ok([{ ...wire, details: { people: [], notes: "x".repeat(4_001) } }]))).toBe(true);
    expect(await bad(ok([{ ...wire, details: { people: [], url: "😀".repeat(1_001) } }]))).toBe(true);
    expect(await bad(ok([{ ...wire, details: { people: [], location: "x".repeat(1_001) } }]))).toBe(true);
    expect(await bad(ok([{ ...wire, details: { people: [{ name: "x".repeat(201), organiser: false }] } }]))).toBe(true);
    expect(await bad(ok([{ ...wire, details: { people: [{ name: "x", organiser: "yes" }] } }]))).toBe(true);
    expect(await bad(ok([{ ...wire, details: { people: [{ name: "x", organiser: false, email: "x@y" }] } }]))).toBe(true);
    expect(await bad(ok([{ ...wire, details: { people: Array.from({ length: 201 }, () => ({ name: null, organiser: false })) } }]))).toBe(true);
    expect(await bad(ok([{ ...wire, details: { url: "https://x" } }]))).toBe(true);   // people is required
    expect(await bad(ok([wire], { detailsCapped: false }))).toBe(true);
    // The cleaned fields still get the morning's check: an unclean title is refused here too.
    expect(await bad(ok([{ ...wire, title: "line\nbreak", details: { people: [] } }]))).toBe(true);
    // And an accepted baseline, so the refusals above are not a check that refuses everything.
    expect(await bad(ok([{ ...wire, details: { people: [] } }]))).toBe(false);
  });
  test("the morning check is unchanged: it still refuses a details key or a kind", async () => {
    const { kind: _k, ...morning } = request;
    const r1 = await runCalendarParse(morning, { timeoutMs: 10_000, command: writes({ v: CALENDAR_PARSE_PROTOCOL, ok: true, events: [{ ...wire, details: { people: [] } }], index: [], incomplete: [] }) });
    expect(r1).toMatchObject({ status: "failed", reason: "bad-output" });
    const r2 = await runCalendarParse(morning, { timeoutMs: 10_000, command: writes(ok([wire])) });
    expect(r2).toMatchObject({ status: "failed", reason: "bad-output" });
  });
});

describe("producer keys on the details wire, protocol 3 (near-duplicates P01, P02)", () => {
  const request: CalendarDetailsRequest = { v: CALENDAR_PARSE_PROTOCOL, ics: "", sourceId: "work", runDate: RUN, zone: "UTC", identity: { self: [] }, maxEvents: 5_000, kind: "details" };
  const wire = { time: { kind: "timed", startMs: 1, endMs: 2 }, title: "t", attendees: [], selfStatus: "unknown", organizerVerified: false, transparency: "busy", status: "confirmed" };
  const writes = (doc: unknown) => child(`process.stdout.write(${JSON.stringify(JSON.stringify(doc))});`);
  const ok = (events: unknown[], extra: Record<string, unknown> = {}) => ({ v: CALENDAR_PARSE_PROTOCOL, ok: true, kind: "details", events, index: [], incomplete: [], ...extra });
  const hex = (n: number) => createHash("sha256").update(`k${n}`).digest("hex");
  const H = hex(0), LINKS = Array.from({ length: 9 }, (_, i) => hex(i + 1)).sort();
  const status = async (doc: unknown) => {
    const r = await runCalendarDetailsParse(request, { timeoutMs: 10_000, command: writes(doc) });
    return r.status === "ok" ? "ok" : `${r.status}/${r.status === "failed" ? r.reason : "-"}`;
  };

  test("P01 accepted on a details answer, with and without details: each field alone and all three together", async () => {
    for (const keys of [{ meetingKey: H }, { placeKey: H }, { linkKeys: LINKS.slice(0, 8) }, { meetingKey: H, placeKey: hex(42), linkKeys: [LINKS[3]] }]) {
      const r = await runCalendarDetailsParse(request, { timeoutMs: 10_000, command: writes(ok([{ ...wire, ...keys, details: { people: [] } }, { ...wire, ...keys }])) });
      expect(`${JSON.stringify(keys)}: ${r.status}`).toBe(`${JSON.stringify(keys)}: ok`);
      if (r.status === "ok" && r.result.ok) expect(r.result.events).toEqual([{ ...wire, ...keys, details: { people: [] } }, { ...wire, ...keys }] as never);
    }
  }, 60_000);
  test("P01 refused on a details answer: malformed scalar keys and linkKeys, beside valid details", async () => {
    const bads: Record<string, unknown>[] = [
      ...["meetingKey", "placeKey"].flatMap((f) => [H.slice(1), H.toUpperCase(), `z${H.slice(1)}`, 7].map((bad) => ({ [f]: bad }))),
      ...[LINKS[0], [], [LINKS[1], LINKS[0]], [LINKS[0], LINKS[0]], LINKS].map((bad) => ({ linkKeys: bad })),
    ];
    for (const over of bads) {
      expect(`${JSON.stringify(over)}: ${await status(ok([{ ...wire, ...over, details: { people: [] } }]))}`).toBe(`${JSON.stringify(over)}: failed/bad-output`);
    }
  }, 60_000);
  test("P01 protocol skew: a protocol-2 details answer is refused", async () => {
    expect(await status(ok([{ ...wire, meetingKey: H, details: { people: [] } }], { v: 2 }))).toBe("failed/bad-output");
    expect(await status(ok([], { v: 2 }))).toBe("failed/bad-output");
    expect(await status(ok([]))).toBe("ok");
    expect(await calendarParseJob({ ...request, v: 2 })).toEqual({ v: CALENDAR_PARSE_PROTOCOL, ok: false, error: "bad-request" });
  }, 60_000);
  test("P02 refused on a details answer: a wire event carrying viewDetails or nearDuplicate", async () => {
    for (const over of [{ viewDetails: [{ title: "t", tier: 1, details: { people: [] } }] }, { nearDuplicate: { mark: "copies", count: 2 } }]) {
      expect(`${JSON.stringify(over)}: ${await status(ok([{ ...wire, ...over, details: { people: [] } }]))}`).toBe(`${JSON.stringify(over)}: failed/bad-output`);
      expect(`${JSON.stringify(over)}: ${await status(ok([{ ...wire, ...over }]))}`).toBe(`${JSON.stringify(over)}: failed/bad-output`);
    }
  }, 60_000);
});

describe("parseCalendarLink({ details: true }) through the real parse child", () => {
  const base = { link: { id: "work" }, url: "https://cal.example/feed.ics", emails: [], runDate: RUN, timeoutMs: 20_000, zone: "UTC" };
  const ICS = feed(
    ev("SUMMARY:Planning", "DTSTART:20261009T090000Z", "DTEND:20261009T100000Z", "URL:https://zoom.us/j/111", "LOCATION:Room A", "DESCRIPTION:Plan notes",
      "ATTENDEE;CN=Ana N:mailto:ana@example.com"),
    ev("SUMMARY:Review", "DTSTART:20261009T140000Z", "DTEND:20261009T150000Z", "URL:https://meet.google.com/abc-defg-hij", "LOCATION:Room B",
      "DESCRIPTION:Review notes", "ORGANIZER;CN=Sam L:mailto:sam@example.com"),
  );
  test("two events from one link each keep their own raw details, beside the cleaned fields and the link source", async () => {
    const r = await parseCalendarLink({ ...base, ics: ICS, details: true, command: JOB_CHILD });
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.events.map((e) => [e.title, e.details])).toEqual([
      ["Planning", { url: "https://zoom.us/j/111", location: "Room A", notes: "Plan notes", people: [{ name: "Ana N", organiser: false }] }],
      ["Review", { url: "https://meet.google.com/abc-defg-hij", location: "Room B", notes: "Review notes", people: [{ name: "Sam L", organiser: true }] }],
    ]);
    expect(r.events.map((e) => e.sources)).toEqual([[{ kind: "link", id: "work", calendarId: "work" }], [{ kind: "link", id: "work", calendarId: "work" }]]);
    expect(r.detailsCapped).toBeUndefined();
  });
  test("without details: the morning request (no kind key), and no event carries details", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-caldetails-")));
    const stdinFile = join(dir, "stdin.json");
    const spy = (answer: string) => child(`require("node:fs").writeFileSync(${JSON.stringify(stdinFile)}, await Bun.stdin.text()); process.stdout.write(${JSON.stringify(answer)});`);
    const morning = await parseCalendarLink({ ...base, ics: ICS, command: spy(`{"v":${CALENDAR_PARSE_PROTOCOL},"ok":true,"events":[],"index":[],"incomplete":[]}`) });
    expect(morning.status).toBe("ok");
    expect(Object.keys(JSON.parse(readFileSync(stdinFile, "utf8"))).sort()).toEqual(["ics", "identity", "maxEvents", "runDate", "sourceId", "v", "zone"]);
    const live = await parseCalendarLink({ ...base, ics: ICS, details: true, command: spy(`{"v":${CALENDAR_PARSE_PROTOCOL},"ok":true,"kind":"details","events":[],"index":[],"incomplete":[]}`) });
    expect(live.status).toBe("ok");
    expect(JSON.parse(readFileSync(stdinFile, "utf8")).kind).toBe("details");
    const real = await parseCalendarLink({ ...base, ics: ICS, command: JOB_CHILD });
    if (real.status !== "ok") throw new Error(real.status);
    expect(real.events.every((e) => !("details" in e))).toBe(true);
    expect("detailsCapped" in real).toBe(false);
  });
});
