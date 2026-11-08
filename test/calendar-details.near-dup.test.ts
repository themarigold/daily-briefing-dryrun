import "./fixtures/isolate-state";   // armed before this file's first save, from any cwd (see test/fixtures/isolate-state.ts)
// test/calendar-details.near-dup.test.ts — the meeting card's details for a key-c merged event (calendar near-duplicates,
// spec 2026-10-31 §5; plan T4.2/T4.3): the people union, one notes entry per view (`notes` = the core's, `otherNotes` =
// the others'), the Join across views, and the C09 engine-shaped literal that the Rust test reads from
// gui/src-tauri/tests/fixtures/calendar-details-merged-event.json. Most tests feed completed `CalEvent`/`viewDetails`
// fixtures straight to the pure projection `detailsEventOf`; the verb and reconcile passes are integration coverage.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { calendarMain } from "../src/calendar/cli";
import { detailsEventOf, type CalendarDetailsJson } from "../src/calendar/details";
import { CAL_NOTES_MAX } from "../src/calendar/notes";
import { producerKeys } from "../src/calendar/join";
import { reconcileCalendar } from "../src/calendar/reconcile";
import type { CalEvent, CalRawDetails, CalSourceRef, CalViewDetails } from "../src/calendar/types";

guardNetworkForThisFile();

const RUN = "2026-10-09";
/** Midnight UTC on the run date: before the all-day event's end in every zone (UTC−12 … UTC+14), so `ended` is false
 *  and the projection does not depend on the zone the suite runs in. */
const NOW = Date.UTC(2026, 9, 9, 0, 0);
const ALL_DAY = { kind: "allDay" as const, startDate: RUN, endDateExclusive: "2026-10-10" };
const MAC_A: CalSourceRef = { kind: "macos", id: "macos", calendarId: "cal-a" };
const HOME: CalSourceRef = { kind: "link", id: "home", calendarId: "home" };

/** A completed key-c result as reconcile hands it to the details read: the core's fields, `viewDetails` as given. */
function merged(viewDetails: CalViewDetails[], over: Partial<CalEvent> = {}): CalEvent {
  return {
    sources: [MAC_A, HOME], time: ALL_DAY, title: viewDetails[0]!.title, location: "Clinic North", attendees: [],
    selfStatus: "accepted", organizerVerified: false, transparency: "busy", status: "confirmed", provenance: {},
    ...(viewDetails[0]!.details !== undefined ? { details: viewDetails[0]!.details } : {}),
    viewDetails, nearDuplicate: { mark: "calendars", count: 2 }, ...over,
  };
}
const vd = (title: string, tier: 1 | 2 | 3, details: CalRawDetails | undefined): CalViewDetails => ({ title, tier, details });
const people = (...ps: [string | null, boolean][]): CalRawDetails["people"] => ps.map(([name, organiser]) => ({ name, organiser }));
const project = (ev: CalEvent) => detailsEventOf(ev, NOW, RUN);

describe("people: the union by shown name (T4.2: C01, C02)", () => {
  test("C01 named people dedupe after shownName by NFKC, case and collapsed whitespace; first spelling in core-first order; organiser if ANY entry says so; organisers first", () => {
    const e = merged([
      vd("Dentist", 1, { people: people(["Sam  Patel", false], ["Dr Lee", true], [null, false], ["bob@example.com", false]) }),
      vd("Ticket: Dentist", 2, { people: people(["ｓam patel", true], ["Ana", false], [null, false]) }),
      vd("Dentist", 3, { people: people(["ANA", true], ["Dr  LEE", false], ["carol@example.com", false], ["Raj", false]) }),
    ]);
    // Sam Patel keeps the core's spelling and gains the organiser flag from the second entry; Ana is first spelled
    // "Ana" and is an organiser through the third entry; the core's two nameless people (null and an address-only name)
    // stay, the others' are dropped; organisers move first, order otherwise kept.
    expect(project(e).people).toEqual([
      { name: "Sam Patel", organiser: true }, { name: "Dr Lee", organiser: true }, { name: "Ana", organiser: true },
      { name: null, organiser: false }, { name: null, organiser: false }, { name: "Raj", organiser: false },
    ]);
  });

  test("C01 the dedupe key is the SHOWN name, not the raw one: raw names that differ but show alike are one person, organiser OR-ed", () => {
    const e = merged([
      vd("Dentist", 1, { people: people(["Ana &amp; Bo", false], ["Raj https://zoom.us/j/1", false]) }),
      vd("Ticket: Dentist", 2, { people: people(["Ana & Bo", true], ["Raj https://zoom.us/j/2", true]) }),
    ]);
    // PREMISE: the raw names differ even after NFKC, case and whitespace folding; their shown names are equal.
    expect(project(merged([vd("Dentist", 1, { people: people(["Ana &amp; Bo", false], ["Raj https://zoom.us/j/1", false]) })])).people)
      .toEqual([{ name: "Ana & Bo", organiser: false }, { name: "Raj zoom.us link", organiser: false }]);
    expect(project(e).people).toEqual([{ name: "Ana & Bo", organiser: true }, { name: "Raj zoom.us link", organiser: true }]);
  });

  test("C02 people is null only when every view's details are undefined; a core without details still takes the others' named people", () => {
    expect(project(merged([vd("Dentist", 1, undefined), vd("Ticket: Dentist", 2, undefined)])).people).toBeNull();
    expect(project(merged([vd("Dentist", 1, undefined), vd("Ticket: Dentist", 2, { people: people(["Ana", false], [null, false]) })])).people)
      .toEqual([{ name: "Ana", organiser: false }]);
    expect(project(merged([vd("Dentist", 1, { people: [] }), vd("Ticket: Dentist", 2, undefined)])).people).toEqual([]);
  });

  test("an unmerged event's people are as before: every raw person through shownName, in order, nothing deduped", () => {
    const ev = merged([vd("Dentist", 1, { people: people(["Sam", false], ["sam", true], [null, false]) })]);
    delete ev.viewDetails; delete ev.nearDuplicate;
    expect(project(ev).people).toEqual([{ name: "Sam", organiser: false }, { name: "sam", organiser: true }, { name: null, organiser: false }]);
  });
});

describe("notes: one entry per view (T4.2: C04, C05, C06)", () => {
  test("C04 notes is the core's cleaned notes; otherNotes holds the other views in viewDetails order, each cleaned on its own, titled by viewDetails[].title", () => {
    const e = project(merged([
      vd("Dentist", 1, { notes: "Core <b>agenda</b>", people: [] }),
      vd("Ticket: Dentist", 2, { notes: "Booking ref 4471", people: [] }),
      vd("Dentist (Clinic)", 3, { people: [] }),
    ]));
    expect(e.notes).toBe("Core agenda");
    expect(e.otherNotes).toEqual([{ title: "Ticket: Dentist", notes: "Booking ref 4471" }, { title: "Dentist (Clinic)", notes: "" }]);
  });

  test("C04 a core without notes gives notes null while the others keep theirs; a view without details gives an empty entry", () => {
    const e = project(merged([vd("Dentist", 1, { people: [] }), vd("Ticket: Dentist", 2, undefined), vd("Ticket: Dentist", 3, { notes: "Bring ID", people: [] })]));
    expect(e.notes).toBeNull();
    expect(e.otherNotes).toEqual([{ title: "Ticket: Dentist", notes: "" }, { title: "Ticket: Dentist", notes: "Bring ID" }]);
  });

  test("C04 an entry with no notes AND a null title (its title equals the shown one) is kept in the JSON as {title: null, notes: \"\"}; only the card skips drawing it", () => {
    const e = project(merged([vd("Dentist", 1, { notes: "core", people: [] }), vd("dentist", 2, { people: [] }), vd("Dentist", 3, undefined)]));
    expect(e.otherNotes).toEqual([{ title: null, notes: "" }, { title: null, notes: "" }]);
    expect(JSON.stringify(e)).toContain(`"otherNotes":[{"title":null,"notes":""},{"title":null,"notes":""}]`);
  });

  test("C05 an entry's title is null when it equals the shown title after key-c title normalisation; otherwise kept as written", () => {
    const e = project(merged([
      vd("Dentist", 1, { people: [] }),
      vd("DENTIST!", 2, { notes: "a", people: [] }), vd("  dentist  ★", 3, { notes: "b", people: [] }), vd("Ticket: Dentist", 3, { notes: "c", people: [] }),
    ]));
    expect(e.otherNotes).toEqual([{ title: null, notes: "a" }, { title: null, notes: "b" }, { title: "Ticket: Dentist", notes: "c" }]);
  });

  test("C06 identical notes are KEPT per entry (the card suppresses the repeated body); each view's notes are capped on their own; one view's boilerplate cut never reaches another's", () => {
    const long = (word: string): string => `${word} `.repeat(400).trim();
    const e = project(merged([
      vd("Dentist", 1, { notes: `${long("core")}`, people: [] }),
      vd("Ticket: Dentist", 2, { notes: "Same text", people: [] }),
      vd("Dentist (Clinic)", 3, { notes: "Same text", people: [] }),
      vd("Reservation Dentist", 3, { notes: `Room 4\nJoin Webex meeting\nhttps://acme.webex.com/meet/x`, people: [] }),
      vd("Dentist visit", 3, { notes: long("other"), people: [] }),
    ]));
    expect(e.notes!.length).toBeLessThanOrEqual(CAL_NOTES_MAX);
    expect(e.notes!.startsWith("core core")).toBe(true);
    expect(e.otherNotes!.map((o) => o.notes.slice(0, 20))).toEqual(["Same text", "Same text", "Room 4", "other other other ot"]);
    // The fifth view's notes are capped on their own: as long as the core's, not cut short by the core's length.
    expect(e.otherNotes![3]!.notes.length).toBeLessThanOrEqual(CAL_NOTES_MAX);
    expect(e.otherNotes![3]!.notes.length).toBeGreaterThan(CAL_NOTES_MAX - 10);
  });
});

describe("the details JSON contract (T4.2: C09 engine half, X15)", () => {
  test("C09 an unmerged event carries no otherNotes key; its notes, people and join are as before", () => {
    const raw: CalRawDetails = { url: "https://zoom.us/j/81234567890", notes: "Agenda", people: people(["Ana", true]) };
    const ev: CalEvent = { ...merged([vd("Dentist", 1, raw)]), sources: [MAC_A] };
    delete ev.viewDetails; delete ev.nearDuplicate;
    const d = project(ev);
    expect("otherNotes" in d).toBe(false);
    expect([d.notes, d.people, d.join]).toEqual(["Agenda", [{ name: "Ana", organiser: true }], { kind: "known", url: "https://zoom.us/j/81234567890", host: "zoom.us" }]);
  });

  test("C09 engine-shaped literal: one merged event's detailsEventOf JSON equals the Rust test's fixture byte for byte", () => {
    const text = readFileSync(new URL("../gui/src-tauri/tests/fixtures/calendar-details-merged-event.json", import.meta.url), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    const ev = merged([
      vd("Dentist", 1, { url: "https://zoom.us/j/81234567890", notes: "Bring the referral letter.", people: people(["Dr Lee", true], ["Sam", false]) }),
      vd("Ticket: Dentist", 2, { notes: "Booking ref 4471.", people: people(["sam", false], ["Front Desk", false]) }),
      vd("Dentist!", 3, { notes: "Parking at the rear.", people: people([null, false], ["Ana", false]) }),
    ], {
      // Three calendars, matching the claimed count; sources surface in this JSON only as `fromMac`.
      sources: [MAC_A, HOME, { kind: "macos", id: "macos", calendarId: "cal-b" }],
      nearDuplicate: { mark: "calendars", count: 3 },
    });
    expect(new Set(ev.sources.map((s) => `${s.id}/${s.calendarId}`)).size).toBe(ev.nearDuplicate!.count);
    const json = JSON.stringify(detailsEventOf(ev, NOW, RUN));
    expect(json).toBe(text.slice(0, -1));
    // What the Rust C09 test needs from this literal: three non-cancelled views, so otherNotes has an entry with a
    // title and notes and one with a null title.
    const doc = JSON.parse(json) as { rowText: string; otherNotes: { title: string | null; notes: string }[] };
    // T6.1: toStructEvent projects the decided mark, so the merged row's rowText carries it.
    expect(doc.rowText).toBe("all day — Dentist (Clinic North) · on 3 calendars");
    expect(doc.otherNotes.some((o) => o.title !== null && o.notes !== "")).toBe(true);
    expect(doc.otherNotes.some((o) => o.title === null)).toBe(true);
  });

  test("X15 (otherNotes and people halves) through reconcile in details mode: a cancelled view adds no notes entry and no people", () => {
    let n = 0;
    const view = (calendarId: string, title: string, over: Partial<CalEvent>, details: CalRawDetails): CalEvent => ({
      sources: [{ kind: "macos", id: "macos", calendarId }], uid: `x15-${++n}`, time: ALL_DAY, title, location: "Clinic North", attendees: [],
      selfStatus: "accepted", organizerVerified: false, transparency: "busy", status: "confirmed", provenance: {},
      ...producerKeys({ location: "Clinic North" }), details, ...over,
    });
    const live = view("cal-a", "Dentist", {}, { notes: "live notes", people: people(["Ana", false]) });
    const live2 = view("cal-b", "Ticket: Dentist", {}, { notes: "live 2 notes", people: people(["Raj", false]) });
    const dead = view("cal-c", "Dentist", { status: "cancelled", lastModified: 9 }, { notes: "SNTL-DEAD notes", people: people(["SNTL Dead", true]) });
    for (const copies of [[live, live2, dead], [dead, live2, live], [live2, dead, live]]) {
      const out = reconcileCalendar({ runDate: RUN, copies, details: true });
      expect(out).toHaveLength(1);
      expect(out[0]!.sources.map((s) => s.calendarId)).toEqual(["cal-a", "cal-b", "cal-c"]);   // PREMISE: all three merged
      const d = project(out[0]!);
      expect([d.notes, d.otherNotes, d.people]).toEqual(["live notes", [{ title: "Ticket: Dentist", notes: "live 2 notes" }], [{ name: "Ana", organiser: false }, { name: "Raj", organiser: false }]]);
      expect(JSON.stringify(d)).not.toContain("SNTL");
    }
  });

  test("the verb emits schemaVersion 1 with otherNotes on a key-c merge read from two links, and none on an unmerged event", async () => {
    const PARSE_JOB = resolve(import.meta.dir, "../src/calendar/parse-job.ts");
    const JOB_CHILD = [process.execPath, "-e", `import { calendarParseMain } from ${JSON.stringify(PARSE_JOB)}; process.exit(await calendarParseMain());`];
    // Local wall times today as iCalendar UTC date-times (as test/calendar-details.verb.test.ts's `at()`), so the
    // events fall on the run date in every zone (M4a checkpoint LOW: fixed Z hours left the run date in UTC−10/+11).
    const at = (h: number, m = 0): string => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); };
    const vevent = (uid: string, title: string, hour: number, ...extra: string[]): string[] => [
      "BEGIN:VEVENT", `UID:${uid}`, `DTSTART:${at(hour)}`, `DTEND:${at(hour, 30)}`, `SUMMARY:${title}`, ...extra, "END:VEVENT",
    ];
    const feed = (...events: string[][]): string => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flat(), "END:VCALENDAR", ""].join("\r\n");
    const HOME_URL = "https://home.example/s3cr3tNd/home.ics", TEAM_URL = "https://team.example/s3cr3tNd/team.ics";
    const routes: Record<string, string> = {
      [HOME_URL]: feed(vevent("nd-h@x", "Dentist", 9, "LOCATION:Clinic A", "DESCRIPTION:home notes"), vevent("solo@x", "Solo", 14, "DESCRIPTION:solo notes")),
      [TEAM_URL]: feed(vevent("nd-t@x", "Ticket: Dentist", 9, "LOCATION:Clinic A", "DESCRIPTION:team notes")),
    };
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-caldet-nd-")));
    const state = join(dir, "state");
    mkdirSync(state, { recursive: true });
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ calendar: { enabled: true, emails: [], links: [{ id: "home", urlEnv: "HOME_URL" }, { id: "team", urlEnv: "TEAM_URL" }] } }));
    const out: string[] = [];
    const code = await calendarMain(["details", "--json"], {
      stateDir: state, configFile, platform: "linux", parseCommand: JOB_CHILD, isTTY: false, readStdin: async () => "", env: { HOME_URL, TEAM_URL },
      fetch: async (url: string) => { const body = routes[url]; if (body === undefined) throw new Error("x"); return new Response(body, { status: 200, headers: { "content-type": "text/calendar" } }); },
      out: (s) => out.push(s), err: () => {},
    });
    expect(code).toBe(0);
    const doc = JSON.parse(out[0]!) as CalendarDetailsJson;
    expect(doc.schemaVersion).toBe(1);
    expect(doc.events.map((e) => [e.title, e.notes, e.otherNotes ?? "none"])).toEqual([
      ["Dentist", "home notes", [{ title: "Ticket: Dentist", notes: "team notes" }]], ["Solo", "solo notes", "none"],
    ]);
    expect("otherNotes" in doc.events[1]!).toBe(false);
  }, 30_000);
});

// ── Join across views (T4.3: C10–C15, X15; spec §5 "Join") ─────────────────────────────────────────────────────────

describe("Join across views (T4.3: C10, C11, C12, C13, C14, C15, X15)", () => {
  const ZOOM_A = "https://us02web.zoom.us/j/81234567890?pwd=a", ZOOM_B = "https://zoom.us/j/81234567890", ZOOM_C = "https://zoom.us/j/81234567890?pwd=c";
  const join = (...views: CalViewDetails[]) => project(merged(views)).join;
  const f = (url?: string, location?: string, notes?: string): CalRawDetails =>
    ({ ...(url !== undefined ? { url } : {}), ...(location !== undefined ? { location } : {}), ...(notes !== undefined ? { notes } : {}), people: [] });

  test("C10 three views whose Zoom links name one meeting by different hosts and queries agree: one Join, the core's URL", () => {
    expect(join(vd("Dentist", 1, f(ZOOM_A)), vd("Dentist", 1, f(ZOOM_B)), vd("Ticket: Dentist", 2, f(undefined, ZOOM_C)))).toEqual({ kind: "known", url: ZOOM_A, host: "us02web.zoom.us" });
    // A different meeting in any one of them → several.
    expect(join(vd("Dentist", 1, f(ZOOM_A)), vd("Dentist", 1, f(ZOOM_B)), vd("Ticket: Dentist", 2, f("https://zoom.us/j/81234567891")))).toEqual({ kind: "several" });
    // Views without details, or without a candidate, take no part.
    expect(join(vd("Dentist", 1, undefined), vd("Dentist", 2, f(undefined, "Clinic North")), vd("Ticket: Dentist", 3, f(ZOOM_B)))).toEqual({ kind: "known", url: ZOOM_B, host: "zoom.us" });
  });

  test("C11 a keyed and a keyless known-host candidate on one host and path are different: several", () => {
    expect(join(vd("Dentist", 1, f("https://acme.webex.com/acme/j.php?MTID=m1")), vd("Dentist", 1, f("https://acme.webex.com/acme/j.php")))).toEqual({ kind: "several" });
    // Two Webex j.php links with different MTIDs differ; two with the same MTID agree.
    expect(join(vd("Dentist", 1, f("https://acme.webex.com/acme/j.php?MTID=m1")), vd("Dentist", 1, f("https://acme.webex.com/acme/j.php?MTID=m2")))).toEqual({ kind: "several" });
    expect(join(vd("Dentist", 1, f("https://acme.webex.com/acme/j.php?MTID=m1")), vd("Dentist", 1, f("https://acme.webex.com/acme/j.php?MTID=m1&x=1"))))
      .toEqual({ kind: "known", url: "https://acme.webex.com/acme/j.php?MTID=m1", host: "acme.webex.com" });
  });

  test("C12 each view's candidate is its own (URL field first) and keyed by its own URL, never the event-level matching key", () => {
    // View 1 matched view 2 through /j/222 in its location, but its Join candidate is /j/111 from its URL field.
    expect(join(vd("Dentist", 1, f("https://zoom.us/j/111", "https://zoom.us/j/222")), vd("Dentist", 1, f(undefined, "https://zoom.us/j/222")))).toEqual({ kind: "several" });
    // And a view whose own candidate is "several" makes the merge several.
    expect(join(vd("Dentist", 1, f(undefined, "https://zoom.us/j/111 https://zoom.us/j/222")), vd("Dentist", 1, f("https://zoom.us/j/111")))).toEqual({ kind: "several" });
  });

  test("C13 a known-host candidate overrides another view's other/service candidate only from the same or a better tier", () => {
    const WHEREBY = "https://whereby.com/acme-hr";
    // Same tier, and better tier: the known-host candidate wins.
    expect(join(vd("Dentist", 2, f(WHEREBY)), vd("Dentist", 2, f(ZOOM_B)))).toEqual({ kind: "known", url: ZOOM_B, host: "zoom.us" });
    expect(join(vd("Dentist", 1, f(ZOOM_B)), vd("Dentist", 2, f(WHEREBY)))).toEqual({ kind: "known", url: ZOOM_B, host: "zoom.us" });
    expect(join(vd("Dentist", 1, f(ZOOM_B)), vd("Dentist", 3, f(undefined, undefined, "Dial in via https://meet.jit.si/acme")))).toEqual({ kind: "known", url: ZOOM_B, host: "zoom.us" });
    // PREMISE: that notes link is a "service" candidate on its own, so the line above exercises the override.
    expect(join(vd("Dentist", 3, f(undefined, undefined, "Dial in via https://meet.jit.si/acme")))).toEqual({ kind: "service", url: "https://meet.jit.si/acme", host: "meet.jit.si", serviceName: "Jitsi" });
    // A tier-3 known-host candidate does not override a tier-1 service candidate.
    expect(join(vd("Dentist", 1, f(undefined, undefined, "Dial in via https://meet.jit.si/acme")), vd("Dentist", 3, f(ZOOM_B)))).toEqual({ kind: "several" });
    // The spec's fixture: an own entry (tier 2) with a Whereby link and an invitation (tier 3) with Zoom → several.
    expect(join(vd("Dentist", 2, f(WHEREBY)), vd("Ticket: Dentist", 3, f(ZOOM_B)))).toEqual({ kind: "several" });
    // Two "other" candidates compare by host and path.
    expect(join(vd("Dentist", 2, f(WHEREBY)), vd("Dentist", 2, f(`${WHEREBY}?lang=en`)))).toEqual({ kind: "other", url: WHEREBY, host: "whereby.com" });
    expect(join(vd("Dentist", 2, f(WHEREBY)), vd("Dentist", 2, f("https://whereby.com/other-room")))).toEqual({ kind: "several" });
  });

  test("C14 the URL comes from the first view by (tier, core first, merge order); a forged tier-3 invite can supply Join when no better view has one (accepted risk)", () => {
    // The core (tier 1) has no candidate; a tier-3 view earlier in merge order loses to a later tier-2 view.
    expect(join(vd("Dentist", 1, f()), vd("Dentist", 3, f(ZOOM_A)), vd("Dentist", 2, f(ZOOM_C)), vd("Dentist", 2, f(ZOOM_B))))
      .toEqual({ kind: "known", url: ZOOM_C, host: "zoom.us" });
    // Spec §5 accepted risk: the real view has no Join; the forged invite's link is shown.
    expect(join(vd("Dentist", 2, f(undefined, "Clinic North")), vd("Dentist", 3, f(ZOOM_B)))).toEqual({ kind: "known", url: ZOOM_B, host: "zoom.us" });
  });

  test("C15 an unmerged event's Join is joinCandidate's, unchanged: URL field first, the within-field host+path collapse", () => {
    const ev = (details: CalRawDetails): CalEvent => { const e = merged([vd("Dentist", 1, details)]); delete e.viewDetails; delete e.nearDuplicate; return e; };
    expect(project(ev(f("https://zoom.us/j/111", "https://zoom.us/j/222"))).join).toEqual({ kind: "known", url: "https://zoom.us/j/111", host: "zoom.us" });
    // Host variants in one field are two known links for the single-event rule (no meeting-key identity) → several;
    // the same host+path twice collapses to one.
    expect(project(ev(f(undefined, `${ZOOM_A} ${ZOOM_B}`))).join).toEqual({ kind: "several" });
    expect(project(ev(f(undefined, `${ZOOM_B} ${ZOOM_C}`))).join).toEqual({ kind: "known", url: ZOOM_B, host: "zoom.us" });
    expect(project(ev(f(undefined, "Clinic North"))).join).toBeNull();
  });

  test("X15 (Join half) through reconcile in details mode: a cancelled view's different link never makes Join several", () => {
    let n = 0;
    const view = (calendarId: string, title: string, over: Partial<CalEvent>, details: CalRawDetails): CalEvent => ({
      sources: [{ kind: "macos", id: "macos", calendarId }], uid: `x15j-${++n}`, time: ALL_DAY, title, location: "Clinic North", attendees: [],
      selfStatus: "accepted", organizerVerified: false, transparency: "busy", status: "confirmed", provenance: {},
      ...producerKeys({ location: "Clinic North" }), details, ...over,
    });
    const live = view("cal-a", "Dentist", {}, f(ZOOM_B)), live2 = view("cal-b", "Ticket: Dentist", {}, f(ZOOM_A));
    const dead = view("cal-c", "Dentist", { status: "cancelled", lastModified: 9 }, f("https://zoom.us/j/999"));
    for (const copies of [[live, live2, dead], [dead, live, live2]]) {
      const out = reconcileCalendar({ runDate: RUN, copies, details: true });
      expect(out).toHaveLength(1);
      expect(out[0]!.sources.map((s) => s.calendarId)).toEqual(["cal-a", "cal-b", "cal-c"]);   // PREMISE: all three merged
      expect(project(out[0]!).join).toEqual({ kind: "known", url: ZOOM_B, host: "zoom.us" });
    }
  });
});

// ── X16 details-mode integration (post-T4.3): reconcile supplies the stable carrier and order the projection reads ──

describe("key c is input-order-independent through details and Join (T4.3: X16 integration)", () => {
  const allOrders = <T,>(xs: readonly T[]): T[][] =>
    xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => allOrders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
  const cal = (calendarId: string): CalSourceRef => ({ kind: "macos", id: "macos", calendarId });
  /** One step-3 view, one copy: Mac calendar `calendarId`, one clinic, equal (absent) revision data; uid only when given. */
  const view = (calendarId: string, title: string, over: Partial<CalEvent>, details: CalRawDetails): CalEvent => ({
    sources: [cal(calendarId)], time: ALL_DAY, title, location: "Clinic North", attendees: [],
    selfStatus: "accepted", organizerVerified: false, transparency: "busy", status: "confirmed", provenance: {},
    ...producerKeys({ location: "Clinic North" }), details, ...over,
  });
  /** Every permutation gives deep-equal reconciled events and projected details; returns the first order's pair. */
  function invariant(views: CalEvent[]) {
    const perms = allOrders(views);
    expect(perms.length).toBe(24);
    const run = (copies: CalEvent[]) => {
      const events = reconcileCalendar({ runDate: RUN, copies, details: true });
      return { events, details: events.map((e) => detailsEventOf(e, NOW, RUN)) };
    };
    const first = run(perms[0]!);
    for (const p of perms.slice(1)) expect(run(p)).toStrictEqual(first);
    expect(first.events).toHaveLength(1);
    return { event: first.events[0]!, details: first.details[0]! };
  }

  test("X16 agreeing Join candidates with different URLs for one meeting; uid present and absent; a text-hash tie; distinct notes and people", () => {
    const v1 = view("cal-a", "Dentist", { uid: "u-1", description: "d1" }, { notes: "n1", people: people(["Dr Lee", true]) });           // tier 1, the core
    const v2 = view("cal-b", "Dentist", { description: "d2" }, { url: "https://zoom.us/j/81234567890", notes: "n2", people: people(["Sam", false]) });
    // v3 and v4 share a calendar with equal titles, no uid and equal revisions: the text hash orders d4 (b19f…) before d3 (b601…).
    const v3 = view("cal-c", "Ticket: Dentist", { selfStatus: "unknown", description: "d3" }, { url: "https://us02web.zoom.us/j/81234567890?pwd=3", notes: "n3", people: people(["Ana", false]) });
    const v4 = view("cal-c", "Ticket: Dentist", { selfStatus: "unknown", description: "d4" }, { url: "https://zoom.us/j/81234567890?pwd=4", notes: "n4", people: people(["Raj", false], ["sam", true]) });
    const { event, details } = invariant([v1, v2, v3, v4]);
    expect(event.viewDetails!.map((d) => [d.title, d.tier, d.details?.notes])).toEqual([
      ["Dentist", 1, "n1"], ["Dentist", 1, "n2"], ["Ticket: Dentist", 2, "n4"], ["Ticket: Dentist", 2, "n3"],
    ]);
    expect(event.nearDuplicate).toEqual({ mark: "copies", count: 4 });
    expect(details.notes).toBe("n1");
    expect(details.otherNotes).toEqual([{ title: null, notes: "n2" }, { title: "Ticket: Dentist", notes: "n4" }, { title: "Ticket: Dentist", notes: "n3" }]);
    expect(details.people).toEqual([{ name: "Dr Lee", organiser: true }, { name: "Sam", organiser: true }, { name: "Raj", organiser: false }, { name: "Ana", organiser: false }]);
    // The core has no candidate; v2 (tier 1) is first by (tier, core first, merge order), ahead of the tier-2 links.
    expect(details.join).toEqual({ kind: "known", url: "https://zoom.us/j/81234567890", host: "zoom.us" });
  });

  test("X16 a tier-sensitive several and a canonical-hash tie: own entry Whereby (tier 2) vs invitation Zoom (tier 3)", () => {
    const w1 = view("cal-a", "Dentist", { selfStatus: "unknown" }, { url: "https://whereby.com/acme-hr", notes: "w1", people: [] });   // tier 2, the core
    const w2 = view("cal-b", "Ticket: Dentist", { selfStatus: "needs-action", organizer: { email: "host@example.com" }, attendees: [{ email: "host@example.com" }] },
      { url: "https://zoom.us/j/555", notes: "w2", people: people(["Host", true]) });                                                     // tier 3
    // w3 and w4: one calendar, identical text, no uid, equal revisions, so only the canonical hash orders them.
    const w3 = view("cal-c", "Dentist", { selfStatus: "unknown", transparency: "free" }, { notes: "w3", people: people(["Ana", false]) });
    const w4 = view("cal-c", "Dentist", { selfStatus: "unknown" }, { notes: "w4", people: people(["Raj", false]) });
    const { event, details } = invariant([w1, w2, w3, w4]);
    // Measured canonical-hash order of w3/w4 for these fixed fixtures, pinned so a change to the serialisation shows.
    expect(event.viewDetails!.map((d) => [d.title, d.tier, d.details?.notes])).toEqual([
      ["Dentist", 2, "w1"], ["Ticket: Dentist", 3, "w2"], ["Dentist", 2, "w3"], ["Dentist", 2, "w4"],
    ]);
    expect([event.title, event.transparency, event.nearDuplicate]).toEqual(["Dentist", "busy", { mark: "copies", count: 4 }]);
    expect(details.otherNotes).toEqual([{ title: "Ticket: Dentist", notes: "w2" }, { title: null, notes: "w3" }, { title: null, notes: "w4" }]);
    expect(details.people).toEqual([{ name: "Host", organiser: true }, { name: "Ana", organiser: false }, { name: "Raj", organiser: false }]);
    expect(details.join).toEqual({ kind: "several" });
  });
});
