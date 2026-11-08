import "./fixtures/isolate-state";   // armed before this file's first save, from any cwd (see test/fixtures/isolate-state.ts)
// test/calendar-details.pipeline.test.ts — the calendar read in DETAILS mode (redesign C, wave-2 plan C-M2-T5): handed
// command-link URLs, `skipCommands` and `skipMac`, the dead-link rule, the link report, raw details on each copy and
// the merge's choice of them. The morning path is unchanged: `run` and `calendar test` hand none of the new fields,
// and its events are the same with and without the details path. Every read here uses an injected runner (counting
// its calls), an injected fetch (netGuard installed) and the real parse job as a `bun -e` child.
import { test, expect, describe, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { resolveCalendar, type ResolvedCalendarLink } from "../src/calendar/config";
import { createCalendarStep, linkEntryHash, readCalendar, toCalendarStruct, type CalendarReadDeps } from "../src/calendar/pipeline";
import { reconcileCalendar } from "../src/calendar/reconcile";
import { CALENDAR_STATUS_TEXT } from "../src/calendar/render-contract";
import { LINK_URL_MAX_BYTES } from "../src/calendar/link-url";
import { calendarReaderCopy, readerExecutable } from "../src/calendar/reader";
import { localDateStr } from "../src/marker";
import type { RunResult } from "../src/proc";
import type { CalEvent, CalendarReadStatus } from "../src/calendar/types";
import type { ReaderExec } from "../src/calendar/mac-source";

guardNetworkForThisFile();

const PARSE_JOB = resolve(import.meta.dir, "../src/calendar/parse-job.ts");
const JOB_CHILD = [process.execPath, "-e", `import { calendarParseMain } from ${JSON.stringify(PARSE_JOB)}; process.exit(await calendarParseMain());`];
const RUN = localDateStr(new Date());
const compact = RUN.replace(/-/g, "");

const SECRET = "s3cr3tCmdT0ken";
const WORK_URL = `https://cal.example/feeds/${SECRET}/work.ics`;
const TEAM_URL = `https://team.example/${SECRET}/team.ics`;
const HOME_URL = `https://home.example/${SECRET}/home.ics`;
const OTHER_URL = `https://elsewhere.example/${SECRET}/other.ics`;

const feed = (...events: string[][]): string => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flat(), "END:VCALENDAR", ""].join("\r\n");
const ev = (uid: string, title: string, hour: number, ...extra: string[]): string[] => [
  "BEGIN:VEVENT", `UID:${uid}`, `DTSTART:${compact}T${String(hour).padStart(2, "0")}0000Z`, `DTEND:${compact}T${String(hour).padStart(2, "0")}3000Z`,
  `SUMMARY:${title}`, ...extra, "END:VEVENT",
];
const ics = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/calendar" } });
const WORK_FEED = feed(ev("plan@x", "Planning", 9, "URL:https://zoom.us/j/111", "LOCATION:Room A", "DESCRIPTION:Plan notes"),
  ev("rev@x", "Review", 14, "URL:https://meet.google.com/abc-defg-hij", "LOCATION:Room B", "DESCRIPTION:Review notes"));

type Route = Response | "reject" | "hang" | (() => Response);
function fakeFetch(routes: Record<string, Route>) {
  const seen: string[] = [];
  return {
    seen,
    fetch: async (url: string): Promise<Response> => {
      seen.push(url);
      const r = routes[url];
      if (r === undefined || r === "reject") throw new Error("connect failed");
      if (r === "hang") return new Promise<Response>(() => {});
      return typeof r === "function" ? r() : r.clone();
    },
  };
}
const OK: RunResult = { out: "", err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false };
/** The `urlCommand` runner: prints the URL named by the command's last argument, and counts its calls. */
function runner(urls: Record<string, string | { code: number }>) {
  const calls: string[][] = [];
  const exec = (async (argv: string[]) => {
    calls.push([...argv]);
    const u = urls[argv[argv.length - 1]!];
    return u === undefined ? { ...OK, code: 1 } : typeof u === "string" ? { ...OK, out: `${u}\n` } : { ...OK, code: u.code };
  }) as unknown as NonNullable<CalendarReadDeps["exec"]>;
  return { exec, calls };
}

const WORK = { id: "work", name: "Work", urlCommand: ["pw", "show", "work"] };
const TEAM = { id: "team", urlCommand: ["pw", "show", "team"] };
const HOME = { id: "home", urlEnv: "HOME_URL" };
const cfg = (...links: object[]) => resolveCalendar({ enabled: true, emails: [], links }, { platform: "linux" });
const link = (r: ReturnType<typeof cfg>, id: string): ResolvedCalendarLink => r.links.find((l) => l.id === id)!;
const ctx = (over: Partial<{ startedAt: number }> = {}) => ({ runDate: RUN, startedAt: Date.now(), offline: false, ...over });

let stateDir = "";
beforeAll(() => { stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-caldet-pipe-"))); });
const deps = (over: Partial<CalendarReadDeps> = {}): CalendarReadDeps => ({
  stateDir, env: { HOME_URL }, platform: "linux", parseCommand: JOB_CHILD, zone: "UTC", ...over,
});

describe("the entry hash", () => {
  test("SHA-256 of the entry's own keys in the fixed order, absent keys omitted, from the parsed config", () => {
    const r = cfg(WORK, TEAM);
    const want = createHash("sha256").update(JSON.stringify({ id: "work", name: "Work", urlCommand: ["pw", "show", "work"] })).digest("hex");
    expect(linkEntryHash(link(r, "work"))).toBe(want);
    expect(linkEntryHash(link(r, "work"))).toMatch(/^[0-9a-f]{64}$/);
    // Another field of that entry changes it; another entry's change does not.
    expect(linkEntryHash(link(cfg({ ...WORK, urlCommand: ["pw", "show", "work2"] }), "work"))).not.toBe(want);
    expect(linkEntryHash(link(cfg({ ...WORK, name: "Job" }), "work"))).not.toBe(want);
    expect(linkEntryHash(link(cfg(WORK, { ...TEAM, name: "Team" }), "work"))).toBe(want);
    const owned = cfg({ ...WORK, owner: "me@x.example", confirmedOwner: "me@x.example" });
    expect(linkEntryHash(link(owned, "work"))).toBe(createHash("sha256")
      .update(JSON.stringify({ id: "work", name: "Work", owner: "me@x.example", confirmedOwner: "me@x.example", urlCommand: ["pw", "show", "work"] })).digest("hex"));
  });
});

describe("handed URLs and the command", () => {
  test("a handed URL for a command link is used: the command is not run; it comes back in the report", async () => {
    const r = cfg(WORK);
    const run = runner({ work: OTHER_URL });
    const f = fakeFetch({ [WORK_URL]: ics(WORK_FEED) });
    const read = await readCalendar(r, ctx(), deps({ exec: run.exec, fetch: f.fetch, details: true,
      handed: new Map([["work", { entryHash: linkEntryHash(link(r, "work")), url: WORK_URL }]]) }));
    expect(run.calls).toEqual([]);
    expect(f.seen).toEqual([WORK_URL]);
    expect(read.sources.map((s) => [s.id, s.status])).toEqual([["work", "ok"]]);
    expect(read.links).toEqual([{ id: "work", entryHash: linkEntryHash(link(r, "work")), url: WORK_URL }]);
  });
  test("no handed URL: the command runs once, and its URL comes back only in the report", async () => {
    const r = cfg(WORK);
    const run = runner({ work: WORK_URL });
    const read = await readCalendar(r, ctx(), deps({ exec: run.exec, fetch: fakeFetch({ [WORK_URL]: ics(WORK_FEED) }).fetch, details: true }));
    expect(run.calls).toEqual([["pw", "show", "work"]]);
    expect(read.links).toEqual([{ id: "work", entryHash: linkEntryHash(link(r, "work")), url: WORK_URL }]);
    const { links: _l, ...rest } = read;
    expect(JSON.stringify(rest)).not.toContain(SECRET);
  });
  test("ignored and never returned: a handed URL for an env link, an unknown id, a mismatched or malformed hash", async () => {
    const r = cfg(WORK, HOME);
    const good = linkEntryHash(link(r, "work"));
    for (const handed of [
      new Map([["home", { entryHash: good, url: OTHER_URL }], ["nope", { entryHash: good, url: OTHER_URL }]]),
      new Map([["work", { entryHash: "0".repeat(64), url: OTHER_URL }]]),
      new Map([["work", { entryHash: good.toUpperCase(), url: OTHER_URL }]]),
      new Map([["work", { entryHash: good.slice(1), url: OTHER_URL }]]),
      new Map([["work", { entryHash: `${good.slice(0, 63)}"`, url: OTHER_URL }]]),
    ]) {
      const run = runner({ work: WORK_URL });
      const f = fakeFetch({ [WORK_URL]: ics(WORK_FEED), [HOME_URL]: ics(feed()) });
      const read = await readCalendar(r, ctx(), deps({ exec: run.exec, fetch: f.fetch, details: true, handed }));
      expect(run.calls.length).toBe(1);
      expect(f.seen.sort()).toEqual([HOME_URL, WORK_URL].sort());
      expect(read.links).toEqual([{ id: "work", entryHash: good, url: WORK_URL }]);   // env links are not reported
      expect(JSON.stringify(read)).not.toContain(OTHER_URL);
    }
  });
  test("an env link ignores a handed URL even with its own matching entry hash", async () => {
    const r = cfg(HOME);
    const run = runner({});
    const f = fakeFetch({ [HOME_URL]: ics(feed()), [OTHER_URL]: ics(feed()) });
    const read = await readCalendar(r, ctx(), deps({ details: true, exec: run.exec, fetch: f.fetch,
      handed: new Map([["home", { entryHash: linkEntryHash(link(r, "home")), url: OTHER_URL }]]) }));
    expect([f.seen, run.calls, read.links]).toEqual([[HOME_URL], [], []]);
  });
  test("a command link ignores a handed URL with a well-formed but mismatched entry hash", async () => {
    const r = cfg(WORK);
    const hash = linkEntryHash(link(r, "work"));
    const wrongHash = `${hash[0] === "0" ? "1" : "0"}${hash.slice(1)}`;
    const run = runner({ work: WORK_URL });
    const f = fakeFetch({ [WORK_URL]: ics(feed()), [OTHER_URL]: ics(feed()) });
    const read = await readCalendar(r, ctx(), deps({ details: true, exec: run.exec, fetch: f.fetch,
      handed: new Map([["work", { entryHash: wrongHash, url: OTHER_URL }]]) }));
    expect([f.seen, run.calls, read.links]).toEqual([[WORK_URL], [["pw", "show", "work"]], [{ id: "work", entryHash: hash, url: WORK_URL }]]);
  });
  test("a handed URL over LINK_URL_MAX_BYTES is refused like a command's output: the command runs", async () => {
    const r = cfg(WORK);
    const run = runner({ work: WORK_URL });
    const long = `https://cal.example/${"x".repeat(LINK_URL_MAX_BYTES)}`;
    const read = await readCalendar(r, ctx(), deps({ exec: run.exec, fetch: fakeFetch({ [WORK_URL]: ics(WORK_FEED) }).fetch, details: true,
      handed: new Map([["work", { entryHash: linkEntryHash(link(r, "work")), url: long }]]) }));
    expect(run.calls.length).toBe(1);
    expect(read.links?.[0]?.url).toBe(WORK_URL);
  });
  test("a failed command gives no URL, and a credential failure is not a dead transfer", async () => {
    const r = cfg(WORK);
    const read = await readCalendar(r, ctx(), deps({ exec: runner({ work: { code: 1 } }).exec, fetch: fakeFetch({}).fetch, details: true }));
    expect(read.sources.map((s) => [s.status, s.reason])).toEqual([["malformed", "command-exit"]]);
    expect(read.links).toEqual([{ id: "work", entryHash: linkEntryHash(link(r, "work")) }]);
  });
});

describe("the dead-link rule", () => {
  const readWith = async (route: Route, over: { startedAt?: number; boundMs?: number } = {}) => {
    const r = cfg(WORK);
    return readCalendar(r, ctx(over.startedAt !== undefined ? { startedAt: over.startedAt } : {}), deps({
      exec: runner({}).exec, fetch: fakeFetch({ [WORK_URL]: route }).fetch, details: true,
      handed: new Map([["work", { entryHash: linkEntryHash(link(r, "work")), url: WORK_URL }]]),
      ...(over.boundMs !== undefined ? { boundMs: over.boundMs } : {}),
    }));
  };
  test("dead, not returned: link-refused, link-redirected, the transfer's malformed", async () => {
    for (const [route, status] of [
      [new Response("no", { status: 404 }), "link-refused"],
      [new Response("", { status: 302, headers: { location: "https://evil.example.net/x" } }), "link-redirected"],
      [new Response("no", { status: 400 }), "malformed"],
    ] as const) {
      const read = await readWith(route);
      expect(read.sources[0]!.status).toBe(status);
      expect(read.links).toEqual([{ id: "work", entryHash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    }
  });
  test("kept: unreachable (offline), a timeout, a server error, too large, a parse failure, a read that never reached it", async () => {
    const cases: [Route, CalendarReadStatus, { startedAt?: number; boundMs?: number }][] = [
      ["reject", "incomplete", {}],
      [new Response("busy", { status: 503 }), "incomplete", {}],
      ["hang", "timeout", { startedAt: Date.now() - 9_700 }],
      [new Response("<html>not a feed</html>", { status: 200 }), "malformed", {}],
      ["hang", "timeout", { boundMs: 300 }],
    ];
    for (const [route, status, over] of cases) {
      const read = await readWith(route, over);
      expect(read.sources[0]!.status).toBe(status);
      expect(read.links?.[0]?.url).toBe(WORK_URL);
    }
    const read = await readWith(new Response("<html>not a feed</html>", { status: 200 }));
    expect(read.sources[0]!.reason).toBe("parse-error");
  });
});

describe("the two skip flags", () => {
  test("skipCommands skips exactly the command links with no usable handed URL, and runs no command", async () => {
    const r = cfg(WORK, TEAM, HOME);
    const run = runner({ work: WORK_URL, team: TEAM_URL });
    const f = fakeFetch({ [WORK_URL]: ics(WORK_FEED), [HOME_URL]: ics(feed()) });
    const read = await readCalendar(r, ctx(), deps({ exec: run.exec, fetch: f.fetch, details: true, skipCommands: true,
      handed: new Map([["work", { entryHash: linkEntryHash(link(r, "work")), url: WORK_URL }]]) }));
    expect(run.calls).toEqual([]);
    expect(f.seen.sort()).toEqual([HOME_URL, WORK_URL].sort());
    expect(read.sources.map((s) => s.id)).toEqual(["work", "home"]);
    expect(read.skipped).toEqual([{ id: "team", kind: "link" }]);
    expect(read.links).toEqual([
      { id: "work", entryHash: linkEntryHash(link(r, "work")), url: WORK_URL },
      { id: "team", entryHash: linkEntryHash(link(r, "team")) },
    ]);
  });
  test("skipMac skips exactly the Mac source", async () => {
    const r = resolveCalendar({ enabled: true, emails: [], macos: {}, links: [HOME] }, { platform: "darwin" });
    let macReads = 0;
    const read = await readCalendar(r, ctx(), deps({ platform: "darwin", details: true, skipMac: true, fetch: fakeFetch({ [HOME_URL]: ics(feed()) }).fetch,
      readMac: async () => { macReads++; return { status: "ok", events: [] }; } }));
    expect(macReads).toBe(0);
    expect(read.sources.map((s) => s.id)).toEqual(["home"]);
    expect(read.skipped).toEqual([{ id: "macos", kind: "macos" }]);
    const both = await readCalendar(r, ctx(), deps({ platform: "darwin", details: true, fetch: fakeFetch({ [HOME_URL]: ics(feed()) }).fetch,
      readMac: async () => { macReads++; return { status: "ok", events: [] }; } }));
    expect(macReads).toBe(1);
    expect(both.sources.map((s) => s.id)).toEqual(["macos", "home"]);
    expect(both.skipped).toEqual([]);
  });
  test("CalendarReadStatus and CALENDAR_STATUS_TEXT are unchanged: skipped is a flag, never a status", () => {
    const all: Record<CalendarReadStatus, true> = {
      ok: true, "not-granted": true, "write-only": true, denied: true, restricted: true, "unsupported-os": true, "helper-missing": true,
      timeout: true, offline: true, "link-refused": true, "link-redirected": true, malformed: true, "too-large": true, incomplete: true,
    };
    expect(Object.keys(all).length).toBe(14);
    expect(Object.keys(CALENDAR_STATUS_TEXT).sort()).toEqual(Object.keys(all).filter((k) => k !== "ok").sort());
    expect(Object.keys(CALENDAR_STATUS_TEXT)).not.toContain("skipped");
  });
});

describe("the morning path hands nothing new", () => {
  test("run and calendar test pass none of the details fields to readCalendar (source pins)", () => {
    const src = (p: string) => readFileSync(resolve(import.meta.dir, "..", p), "utf8");
    const FIELDS = /\b(handed|skipCommands|skipMac|details|refreshWait)\b/;
    const cli = src("src/calendar/cli.ts");
    const call = cli.slice(cli.indexOf("const read = await readCalendar("), cli.indexOf("const out: CalendarTestJson"));
    expect(call.length).toBeGreaterThan(50);
    expect(FIELDS.test(call)).toBe(false);
    const pipeline = src("src/calendar/pipeline.ts");
    expect(pipeline).toContain('export type CalendarStepDeps = Omit<CalendarReadDeps, CalendarDetailsField> & {');
    expect(pipeline).toContain('type CalendarDetailsField = "handed" | "skipCommands" | "skipMac" | "details" | "refreshWait";');
    expect(pipeline).toContain("const read = await readCalendar(resolved, ctx, morningDeps(deps));");
    const core = src("src/core.ts");
    expect(core).toContain("createCalendarStep(calCfg, { stateDir: supportDir(), maxChars: calMaxChars })");
  });
  test("the morning read carries no report, no skip list and no raw details; its events are the details read's", async () => {
    const r = cfg(WORK, HOME);
    const routes = { [WORK_URL]: ics(WORK_FEED), [HOME_URL]: ics(feed(ev("h@x", "Home thing", 18, "LOCATION:Kitchen"))) };
    const morning = await readCalendar(r, ctx(), deps({ exec: runner({ work: WORK_URL }).exec, fetch: fakeFetch(routes).fetch }));
    expect("links" in morning || "skipped" in morning).toBe(false);
    expect(JSON.stringify(morning.events)).not.toContain("details");
    const live = await readCalendar(r, ctx(), deps({ exec: runner({ work: WORK_URL }).exec, fetch: fakeFetch(routes).fetch, details: true }));
    expect(live.events.map(({ details: _d, ...rest }) => rest)).toEqual(morning.events);
    expect(live.sources.map((s) => [s.id, s.status])).toEqual(morning.sources.map((s) => [s.id, s.status]));
  });
});

describe("key c: morning and details reads agree (T4.1: P06 reconcile half, C08)", () => {
  test("P06 a key-c pair from two links, with CONFLICTING URL-field links: the morning and full-source details reads give identical merged rows; only details mode carries viewDetails", async () => {
    // Two links, one time, "Dentist" / "Ticket: Dentist" at one clinic: key b refuses (titles differ), key c merges. The
    // URL fields name different Zoom meetings, which matching never reads (spec §4), so both modes merge alike.
    // Local 09:00–09:30 today as UTC date-times, with the parse child in the suite's own zone, so the pair is on the run
    // date for both the child's run-date details and reconcile's local-day filter in every zone (M4a checkpoint LOW:
    // the file's `ev` helper writes fixed Z hours for a UTC child, which reconcile drops in e.g. Pacific/Honolulu).
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const at = (h: number, m = 0): string => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); };
    const local = (uid: string, title: string, ...extra: string[]): string[] =>
      ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART:${at(9)}`, `DTEND:${at(9, 30)}`, `SUMMARY:${title}`, ...extra, "END:VEVENT"];
    const r = cfg(WORK, HOME);
    const routes = {
      [WORK_URL]: ics(feed(local("p06-w@x", "Dentist", "URL:https://zoom.us/j/111", "LOCATION:Clinic A", "DESCRIPTION:work notes"))),
      [HOME_URL]: ics(feed(local("p06-h@x", "Ticket: Dentist", "URL:https://zoom.us/j/222", "LOCATION:Clinic A", "DESCRIPTION:home notes"))),
    };
    const morning = await readCalendar(r, ctx(), deps({ exec: runner({ work: WORK_URL }).exec, fetch: fakeFetch(routes).fetch, zone }));
    const live = await readCalendar(r, ctx(), deps({ exec: runner({ work: WORK_URL }).exec, fetch: fakeFetch(routes).fetch, details: true, zone }));
    expect(morning.events.map((e) => [e.title, e.sources.map((s) => s.id).sort(), e.nearDuplicate])).toEqual([["Dentist", ["home", "work"], { mark: "calendars", count: 2 }]]);
    expect(morning.events.some((e) => "viewDetails" in e || "details" in e)).toBe(false);
    expect(live.events.map(({ details: _d, viewDetails: _v, ...rest }) => rest)).toEqual(morning.events);
    expect(live.events[0]!.details?.url).toBe("https://zoom.us/j/111");
    expect(live.events[0]!.viewDetails?.map((d) => [d.title, d.details?.url, d.details?.notes])).toEqual([
      ["Dentist", "https://zoom.us/j/111", "work notes"], ["Ticket: Dentist", "https://zoom.us/j/222", "home notes"],
    ]);
  });
});

describe("raw details belong to the occurrence", () => {
  test("two events from one ICS link keep their own details through the read", async () => {
    const r = cfg(HOME);
    const read = await readCalendar(r, ctx(), deps({ details: true, fetch: fakeFetch({ [HOME_URL]: ics(WORK_FEED) }).fetch }));
    expect(read.events.map((e) => [e.title, e.details?.url, e.details?.location, e.details?.notes])).toEqual([
      ["Planning", "https://zoom.us/j/111", "Room A", "Plan notes"], ["Review", "https://meet.google.com/abc-defg-hij", "Room B", "Review notes"],
    ]);
  });
  test("a reconciled Mac + ICS pair keeps the Mac copy's details; an ICS-only event its own; a Mac copy with none yields the ICS's", () => {
    const start = Date.parse(`${RUN}T09:00:00Z`);
    const copy = (kind: "macos" | "link", uid: string, title: string, details?: CalEvent["details"]): CalEvent => ({
      sources: [{ kind, id: kind === "macos" ? "macos" : "home", calendarId: kind === "macos" ? "c1" : "home" }], uid,
      time: { kind: "timed", startMs: start, endMs: start + 1_800_000 }, title, attendees: [], selfStatus: "accepted", organizerVerified: false,
      transparency: "busy", status: "confirmed", provenance: {}, ...(details ? { details } : {}),
    });
    const mac = { url: "https://zoom.us/j/1", people: [] }, link1 = { url: "https://zoom.us/j/2", people: [] }, solo = { notes: "solo", people: [] };
    const out = reconcileCalendar({ runDate: RUN, copies: [copy("link", "a@x", "Sync", link1), copy("macos", "a@x", "Sync", mac), copy("link", "b@x", "Solo", solo)] });
    expect(Object.fromEntries(out.map((e) => [e.title, e.details]))).toEqual({ Sync: mac, Solo: solo });
    const noMacDetails = reconcileCalendar({ runDate: RUN, copies: [copy("macos", "a@x", "Sync"), copy("link", "a@x", "Sync", link1)] });
    expect(noMacDetails.map((e) => e.details)).toEqual([link1]);
    const none = reconcileCalendar({ runDate: RUN, copies: [copy("macos", "a@x", "Sync"), copy("link", "a@x", "Sync")] });
    expect(none.map((e) => "details" in e)).toEqual([false]);
  });
  test("toCalendarStruct of a details-mode read holds no details key anywhere", async () => {
    const r = cfg(HOME);
    const read = await readCalendar(r, ctx(), deps({ details: true, fetch: fakeFetch({ [HOME_URL]: ics(WORK_FEED) }).fetch }));
    expect(read.events.every((e) => e.details !== undefined)).toBe(true);
    const keys = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(keys) : typeof v === "object" && v !== null
      ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
    const struct = toCalendarStruct(read.events, read.sources, read.nowMs);
    expect(keys(struct)).not.toContain("details");
    expect(JSON.stringify(struct)).not.toContain("zoom.us/j");
  });
});

describe("the Mac source in details mode", () => {
  function stateWithCopy(version: number): string {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-caldet-mac-")));
    const app = calendarReaderCopy(state);
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(readerExecutable(app), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(app, "Contents", "Info.plist"), `<plist><dict><key>CFBundleVersion</key><string>${version}</string></dict></plist>\n`);
    return state;
  }
  /** Plays the helper: a real FIFO for `mkfifo`; for the trigger, one `read` document with `events`. Records argv. */
  function macFake(events: unknown[]) {
    const calls: string[][] = [];
    const exec = (async (cmd: string[]) => {
      calls.push([...cmd]);
      if (cmd[0] === "mkfifo") return { ...OK, code: Bun.spawnSync(["mkfifo", ...cmd.slice(1)]).exitCode ?? 1 };
      const fifo = cmd[cmd.indexOf("--fifo") + 1]!, id = cmd[cmd.indexOf("--id") + 1]!;
      const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      try { writeSync(fd, `${JSON.stringify({ v: 1, id, status: "ok", helperVersion: "2", events })}\n`); } finally { closeSync(fd); }
      return OK;
    }) as unknown as ReaderExec;
    return { exec, calls };
  }
  const at = (h: number, dayOffset = 0): number => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime() + dayOffset * 86_400_000; };
  const rec = (title: string, startMs: number, extra: Record<string, unknown> = {}) => ({ calendarId: "c1", title, startMs, endMs: startMs + 1_800_000, ...extra });
  const macCfg = () => resolveCalendar({ enabled: true, emails: ["alt@x.example"], macos: {} }, { platform: "darwin" });
  const macDeps = (state: string, exec: ReaderExec, over: Partial<CalendarReadDeps> = {}) =>
    deps({ stateDir: state, platform: "darwin", osRelease: "23.6.0", macExec: exec, ...over });

  test("L5/E11: morningDeps strips details fields from the actual runtime object", async () => {
    const f = macFake([]);
    const contaminated = { ...macDeps(stateWithCopy(2), f.exec), details: true as const, refreshWait: 0, maxChars: 2000 };
    const run = createCalendarStep(macCfg(), contaminated);
    const result = await run({ ...ctx(), force: false, owned: false, trigger: "manual" });
    expect(result?.struct.sources[0]?.status).toBe("ok");
    const argv = f.calls.find((c) => c[0] === "open")!;
    expect(argv).toBeDefined();
    expect(argv.slice(argv.indexOf("--select"))).toEqual(["--select", "editable"]);
  });

  test("raw details for run-date occurrences only; you (isCurrentUser or a configured address) left out", async () => {
    const f = macFake([
      rec("Today", at(10), { url: "https://zoom.us/j/9", location: "Room 1", notes: "<b>raw</b> notes",
        organizer: { name: "Priya Sharma", email: "priya@x.example", isCurrentUser: false },
        attendees: [{ name: "Priya Sharma", email: "priya@x.example", isCurrentUser: false }, { name: "Me", isCurrentUser: true },
          { name: "Alt Me", email: "ALT@x.example", isCurrentUser: false }, { email: "nameless@x.example", isCurrentUser: false }] }),
      rec("Tomorrow", at(10, 1), { url: "https://zoom.us/j/8" }),
    ]);
    const read = await readCalendar(macCfg(), ctx(), macDeps(stateWithCopy(2), f.exec, { details: true }));
    const today = read.events.find((e) => e.title === "Today")!;
    expect(today.details).toEqual({ url: "https://zoom.us/j/9", location: "Room 1", notes: "<b>raw</b> notes",
      people: [{ name: "Priya Sharma", organiser: true }, { name: null, organiser: false }] });
    expect(read.events.find((e) => e.title === "Tomorrow")).toBeUndefined();   // reconcile keeps today only
  });
  test("the morning's Mac read passes no --refresh-wait and builds no details", async () => {
    const f = macFake([rec("Today", at(10), { url: "https://zoom.us/j/9" })]);
    const read = await readCalendar(macCfg(), ctx(), macDeps(stateWithCopy(2), f.exec));
    const trigger = f.calls.find((c) => c[0] === "open")!;
    expect(trigger).not.toContain("--refresh-wait");
    expect(read.events.map((e) => "details" in e)).toEqual([false]);
  });
  test("refreshWait goes only to a copy at version 2, and only in details mode", async () => {
    const v2 = macFake([]), v1 = macFake([]), morning = macFake([]);
    await readCalendar(macCfg(), ctx(), macDeps(stateWithCopy(2), v2.exec, { details: true, refreshWait: 0 }));
    await readCalendar(macCfg(), ctx(), macDeps(stateWithCopy(1), v1.exec, { details: true, refreshWait: 0 }));
    const trigger = (calls: string[][]) => calls.find((c) => c[0] === "open")!;
    expect(trigger(v2.calls).slice(-2)).toEqual(["--refresh-wait", "0"]);
    expect(trigger(v1.calls)).not.toContain("--refresh-wait");
    // refreshWait without details mode is ignored.
    await readCalendar(macCfg(), ctx(), macDeps(stateWithCopy(2), morning.exec, { refreshWait: 0 }));
    expect(trigger(morning.calls)).not.toContain("--refresh-wait");
  });
});
