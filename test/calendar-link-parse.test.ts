// test/calendar-link-parse.test.ts — the PARENT's half of a link parse (calendar v0.3.0 plan M2c; spec r4 §4.2
// "Identity"): who "you" are for a link, and the run through the real parse child.
//
// The child here is the real job module run as `bun -e` (the way test/calendar-parse.test.ts's JOB_CHILD is) — never
// the engine binary, never the network. A second fixture child records its stdin, so "the URL never reaches the
// child" is read from what the child actually received.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { googleUrlPathOwner, linkIdentity, localZoneName, parseCalendarLink } from "../src/calendar/link-parse";
import { CALENDAR_PARSE_PROTOCOL } from "../src/calendar/parse-job";

const PARSE_JOB = resolve(import.meta.dir, "../src/calendar/parse-job.ts");
const child = (code: string) => [process.execPath, "-e", code];
const JOB_CHILD = child(`import { calendarParseMain } from ${JSON.stringify(PARSE_JOB)}; process.exit(await calendarParseMain());`);

const SECRET = "c0ffee5ecret7oken";
const google = (id: string) => `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/private-${SECRET}/basic.ics`;
const ICS = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:a@x", "DTSTART:20261009T100000Z", "DTEND:20261009T110000Z", "SUMMARY:Planning",
  "ORGANIZER:mailto:me@personal.example", "ATTENDEE;CN=Me;PARTSTAT=ACCEPTED:mailto:me@personal.example", "END:VEVENT",
  "BEGIN:VEVENT", "UID:old@x", "DTSTART:20200101T100000Z", "SUMMARY:Old", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");

describe("googleUrlPathOwner (spec §4.2, G4)", () => {
  test("a Google secret link's PERSONAL address, lower-cased", () => {
    expect(googleUrlPathOwner(google("Me@Personal.example"))).toBe("me@personal.example");
    expect(googleUrlPathOwner(google("someone@workspace.example"))).toBe("someone@workspace.example");
    expect(googleUrlPathOwner(`https://www.google.com/calendar/ical/me%40personal.example/private-${SECRET}/basic.ics`)).toBe("me@personal.example");
  });
  test("a calendar id is never an owner: group, import, resource and holiday calendars", () => {
    for (const id of ["abc123@group.calendar.google.com", "x@import.calendar.google.com", "room-1@resource.calendar.google.com",
      "en.usa#holiday@group.v.calendar.google.com", "x@calendar.google.com"]) expect(googleUrlPathOwner(google(id)), id).toBeUndefined();
  });
  test("any other host, any other path, or no address: none — and nothing else of the URL ever comes back", () => {
    expect(googleUrlPathOwner(`https://calendar.google.com.evil.example/calendar/ical/me%40personal.example/private-${SECRET}/basic.ics`)).toBeUndefined();
    expect(googleUrlPathOwner(`https://outlook.office365.com/owa/calendar/me%40work.example/${SECRET}/calendar.ics`)).toBeUndefined();
    expect(googleUrlPathOwner(`https://calendar.google.com/other/ical/me%40personal.example/private-${SECRET}/basic.ics`)).toBeUndefined();
    expect(googleUrlPathOwner(`https://calendar.google.com/calendar/ical/not-an-address/private-${SECRET}/basic.ics`)).toBeUndefined();
    expect(googleUrlPathOwner(`https://calendar.google.com/calendar/ical/%E0%A4%A/private/basic.ics`)).toBeUndefined();
    expect(googleUrlPathOwner("not a url")).toBeUndefined();
  });
});

describe("linkIdentity (spec §4.2)", () => {
  test("each owner source recognises your answers: the URL-path owner, the configured owner, calendar.emails", () => {
    expect(linkIdentity(google("me@personal.example"), {}, [])).toEqual({ identity: { self: ["me@personal.example"] }, notices: [] });
    expect(linkIdentity("https://cal.example/feed.ics", { owner: "me@work.example" }, [])).toEqual({ identity: { self: ["me@work.example"] }, notices: [] });
    expect(linkIdentity("https://cal.example/feed.ics", {}, ["a@x.example", "B@Y.example"])).toEqual({ identity: { self: ["a@x.example", "b@y.example"] }, notices: [] });
    expect(linkIdentity(google("me@personal.example"), { owner: "me@personal.example" }, ["me@personal.example"]).identity.self).toEqual(["me@personal.example"]);
  });
  test("only a CONFIRMED URL-path owner on a Google link may verify the organizer — a mismatch, or any other host, never", () => {
    expect(linkIdentity(google("me@personal.example"), { confirmedOwner: "me@personal.example" }, []).identity).toEqual({ self: ["me@personal.example"], verifiedOrganizer: "me@personal.example" });
    // The link was replaced with someone else's calendar: the old confirmation counts for nothing.
    expect(linkIdentity(google("boss@personal.example"), { confirmedOwner: "me@personal.example" }, []).identity).toEqual({ self: ["boss@personal.example"] });
    expect(linkIdentity("https://cal.example/feed.ics", { owner: "me@x.example", confirmedOwner: "me@x.example" }, []).identity).toEqual({ self: ["me@x.example"] });
    // A group calendar's id is not you, and cannot be confirmed into being you.
    expect(linkIdentity(google("t@group.calendar.google.com"), { confirmedOwner: "t@group.calendar.google.com", owner: "me@x.example" }, []).identity).toEqual({ self: ["me@x.example"] });
  });
  test("fix-round 1: a configured owner that differs from an UNCONFIRMED URL-path address drops that address from \"you\"", () => {
    expect(linkIdentity(google("boss@personal.example"), { owner: "me@personal.example" }, ["alt@x.example"]).identity).toEqual({ self: ["me@personal.example", "alt@x.example"] });
    // Confirmed, or the same as the owner, or no owner configured: the path address is you, as before.
    expect(linkIdentity(google("boss@personal.example"), { owner: "me@personal.example", confirmedOwner: "boss@personal.example" }, []).identity)
      .toEqual({ self: ["boss@personal.example", "me@personal.example"], verifiedOrganizer: "boss@personal.example" });
    expect(linkIdentity(google("me@personal.example"), { owner: "ME@personal.example" }, []).identity).toEqual({ self: ["me@personal.example"] });
    expect(linkIdentity(google("boss@personal.example"), {}, []).identity).toEqual({ self: ["boss@personal.example"] });
  });
  test("fix-round 1: boss@ in the URL, owner me@, boss declined, me accepted → the meeting stays (real parse child + reconcile)", async () => {
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:m@x", "DTSTART:20261009T100000Z", "DTEND:20261009T110000Z", "SUMMARY:Sync",
      "ATTENDEE;PARTSTAT=DECLINED:mailto:boss@personal.example", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@personal.example",
      "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    const r = await parseCalendarLink({ link: { id: "shared", owner: "me@personal.example" }, url: google("boss@personal.example"), emails: [], ics,
      runDate: "2026-10-09", timeoutMs: 20_000, zone: "UTC", command: JOB_CHILD });
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.events.map((e) => [e.title, e.selfStatus])).toEqual([["Sync", "accepted"]]);
    const { reconcileCalendar } = await import("../src/calendar/reconcile");
    expect(reconcileCalendar({ runDate: "2026-10-09", copies: r.events, indexes: [r.index] }).map((e) => e.title)).toEqual(["Sync"]);
  });
  test("with no address at all: identity-unknown", () => {
    expect(linkIdentity(google("t@group.calendar.google.com"), {}, [])).toEqual({ identity: { self: [] }, notices: ["identity-unknown"] });
    expect(linkIdentity("https://cal.example/feed.ics", {}, [])).toEqual({ identity: { self: [] }, notices: ["identity-unknown"] });
  });
  test("the process zone name is an IANA zone the parse child accepts", () => {
    const z = localZoneName();
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: z })).not.toThrow();
  });
});

describe("parseCalendarLink through the real parse child", () => {
  const base = { link: { id: "personal", confirmedOwner: "me@personal.example" }, url: google("me@personal.example"), emails: [], ics: ICS, runDate: "2026-10-09", timeoutMs: 20_000, zone: "UTC" };
  test("today's events, carrying this link as their source; the index of every block; notices", async () => {
    const r = await parseCalendarLink({ ...base, command: JOB_CHILD });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.events.map((e) => [e.title, e.selfStatus, e.organizerVerified, e.sources])).toEqual([
      ["Planning", "accepted", true, [{ kind: "link", id: "personal", calendarId: "personal" }]],
    ]);
    expect(r.events[0]!.provenance).toEqual({});
    expect(r.index).toEqual({ sourceId: "personal", entries: [
      { uid: "a@x", startMs: Date.parse("2026-10-09T10:00:00Z") }, { uid: "old@x", startMs: Date.parse("2020-01-01T10:00:00Z") }] });
    expect(r.incomplete).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
  test("identity-unknown rides out as a notice, and every event is unknown", async () => {
    const r = await parseCalendarLink({ ...base, link: { id: "team" }, url: google("t@group.calendar.google.com"), command: JOB_CHILD });
    expect(r.status === "ok" && [r.notices, r.events.map((e) => e.selfStatus)]).toEqual([["identity-unknown"], ["unknown"]]);
  });
  test("⚠ the URL never reaches the child: only the addresses derived from it", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-calparse-link-")));
    const stdinFile = join(dir, "stdin.json");
    const spy = child(`require("node:fs").writeFileSync(${JSON.stringify(stdinFile)}, await Bun.stdin.text()); process.stdout.write('{"v":${CALENDAR_PARSE_PROTOCOL},"ok":true,"events":[],"index":[],"incomplete":[]}');`);
    const r = await parseCalendarLink({ ...base, command: spy });
    expect(r.status).toBe("ok");
    const sent = readFileSync(stdinFile, "utf8");
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain("calendar.google.com");
    const req = JSON.parse(sent) as Record<string, unknown>;
    expect(Object.keys(req).sort()).toEqual(["ics", "identity", "maxEvents", "runDate", "sourceId", "v", "zone"]);
    expect(req.identity).toEqual({ self: ["me@personal.example"], verifiedOrganizer: "me@personal.example" });
    expect(req.maxEvents).toBe(5_000);
  });
  test("not a feed → parse-error; a child past its deadline → timeout; no runner → failed", async () => {
    expect((await parseCalendarLink({ ...base, ics: "<html>nope</html>", command: JOB_CHILD })).status).toBe("parse-error");
    expect(await parseCalendarLink({ ...base, timeoutMs: 300, command: child("setInterval(() => {}, 1000);") })).toMatchObject({ status: "timeout" });
    expect(await parseCalendarLink({ ...base })).toMatchObject({ status: "failed", reason: "no-runner" });   // bun test is not the engine
  });
});

describe("M2c review HIGH: a hostile DURATION does not drop the link (through the real parse child)", () => {
  test("an all-day `DURATION:P999999W` beside a real meeting: the answer is accepted and the meeting survives", async () => {
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:forever@x", "DTSTART;VALUE=DATE:20261009", "DURATION:P999999W", "SUMMARY:Forever", "END:VEVENT",
      "BEGIN:VEVENT", "UID:real@x", "DTSTART:20261009T150000Z", "DTEND:20261009T160000Z", "SUMMARY:Real meeting", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    const r = await parseCalendarLink({ link: { id: "work" }, url: "https://cal.example/feed.ics", emails: [], ics, runDate: "2026-10-09", timeoutMs: 20_000, zone: "UTC", command: JOB_CHILD });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.events.map((e) => e.title).sort()).toEqual(["Forever", "Real meeting"]);
    expect(r.events.find((e) => e.title === "Forever")!.time).toEqual({ kind: "allDay", startDate: "2026-10-09", endDateExclusive: "9999-12-31" });
  });
});
