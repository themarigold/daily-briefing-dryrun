import "./fixtures/isolate-state";   // armed before this file's first save, from any cwd (see test/fixtures/isolate-state.ts)
// test/calendar-step.test.ts — THE CALENDAR STEP and its wiring (v0.3.0 plan M4; spec r4 §3, §4.2, §5, §7).
//
// Three layers: the production step (`createCalendarStep`, src/calendar/pipeline.ts) with an injected fetch and the
// REAL parse job run as a `bun -e` child (never the engine binary, never the network — netGuard is installed); `runCore`
// with the `RunDeps.calendar` seam (data, throw, never resolves, the empty-day gates); and `run()`, the shell, for what
// only it decides — whether the day is stamped — plus the sentinel sweep over every file and stream a run writes.
import { test, expect, describe, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { resolveCalendar } from "../src/calendar/config";
import { calendarLinkShare, createCalendarStep, readCalendar, type CalendarStepDeps } from "../src/calendar/pipeline";
import { producerKeys } from "../src/calendar/join";
import { calendarHealthPath, readCalendarHealth } from "../src/calendar/health";
import type { CalendarStepContext } from "../src/calendar/step";
import { runCore, type RunDeps } from "../src/core";
import { run } from "../src/main";
import { lockStaleMs } from "../src/runlock";
import { CALENDAR_STEP_WORST_MS } from "../src/calendar/bounds";
import { latestBriefingPath, archivedBriefingPath, markerPath, localDateStr } from "../src/marker";
import type { Config, Provider } from "../src/types";

guardNetworkForThisFile();

const PARSE_JOB = resolve(import.meta.dir, "../src/calendar/parse-job.ts");
const JOB_CHILD = [process.execPath, "-e", `import { calendarParseMain } from ${JSON.stringify(PARSE_JOB)}; process.exit(await calendarParseMain());`];
const SPIN_CHILD = [process.execPath, "-e", "for (;;) {}"];

const SECRET = "s3cr3tLinkT0ken";
const WORK_URL = `https://cal.example/feeds/${SECRET}/work.ics`;
const HOME_URL = `https://other.example/${SECRET}/home.ics`;
const ENV = { WORK_URL, HOME_URL };

/** Every string that must never leave the process except in the LOCKED prompt variant. */
const SENTINELS = ["SNTLNAME", "sntl-mail", "SNTLDESC", "SNTLORG", SECRET];
const noSentinel = (where: string, text: string): void => {
  for (const s of SENTINELS) expect(`${where} contains ${s}: ${text.includes(s)}`).toBe(`${where} contains ${s}: false`);
};

const compact = (d: string): string => d.replace(/-/g, "");
/** A feed for `day`: one accepted meeting rich in attendee-written text, one all-day event. */
function sentinelFeed(day: string): string {
  const c = compact(day);
  return ["BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:plan@x", `DTSTART:${c}T100000Z`, `DTEND:${c}T110000Z`, "SUMMARY:Planning", "LOCATION:Room 9",
    "ORGANIZER;CN=SNTLORG Boss:mailto:boss@x.example",
    "ATTENDEE;CN=Me;PARTSTAT=ACCEPTED:mailto:me@x.example",
    "ATTENDEE;CN=SNTLNAME Zed;PARTSTAT=ACCEPTED:mailto:sntl-mail@x.example",
    "DESCRIPTION:SNTLDESC the secret agenda", "END:VEVENT",
    "BEGIN:VEVENT", "UID:offsite@x", `DTSTART;VALUE=DATE:${c}`, "SUMMARY:Offsite", "END:VEVENT",
    "END:VCALENDAR", ""].join("\r\n");
}
/** A feed whose one event recurs every second — the CPU-heavy RRULE: the child caps it at 1,000 steps. */
function heavyFeed(day: string): string {
  const c = compact(day);
  return ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:heavy@x", "DTSTART:20180101T000000Z", "RRULE:FREQ=SECONDLY", "SUMMARY:Tick", "END:VEVENT",
    "BEGIN:VEVENT", "UID:real@x", `DTSTART:${c}T150000Z`, `DTEND:${c}T153000Z`, "SUMMARY:Real", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}

type Route = Response | (() => Promise<Response>) | "reject" | "hang";
function fakeFetch(routes: Record<string, Route>): { fetch: CalendarStepDeps["fetch"]; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    fetch: async (url: string) => {
      seen.push(url);
      const r = routes[url];
      if (r === undefined || r === "reject") throw new Error(`connect failed ${url}`);
      if (r === "hang") return new Promise<Response>(() => {});
      return typeof r === "function" ? r() : r.clone();
    },
  };
}
const ics = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/calendar" } });

const RUN = "2026-10-09";
const ctx = (over: Partial<CalendarStepContext> = {}): CalendarStepContext => ({
  runDate: RUN, startedAt: Date.now(), offline: false, force: false, owned: false, trigger: "manual", ...over,
});
const linksCfg = (...links: object[]) => resolveCalendar({ enabled: true, emails: ["me@x.example"], links }, { platform: "linux" });
const WORK = { id: "work", urlEnv: "WORK_URL" };
const HOME = { id: "home", urlEnv: "HOME_URL" };

let stateDir = "";
beforeAll(async () => { stateDir = removeAtRunEnd(await mkdtemp(join(tmpdir(), "dba-calstep-"))); });

function stepDeps(over: Partial<CalendarStepDeps> = {}): CalendarStepDeps {
  return { stateDir, env: ENV, platform: "linux", parseCommand: JOB_CHILD, zone: "UTC", maxChars: 200_000, ...over };
}

// ── the production step ──────────────────────────────────────────────────────────────────────────────

describe("createCalendarStep", () => {
  test("a link read in full: the RESTRICTED struct, field by field — no attendee, organizer, description or URL", async () => {
    const f = fakeFetch({ [WORK_URL]: ics(sentinelFeed(RUN)) });
    const r = (await createCalendarStep(linksCfg(WORK), stepDeps({ fetch: f.fetch }))(ctx()))!;
    expect(r.skipOffline).toBe(false);
    expect(r.struct.sources).toEqual([{ id: "work", kind: "link", status: "ok" }]);
    expect(r.struct.incomplete).toBe(false);
    expect(r.struct.events.map((e) => [e.title, e.location, e.attendeeCount, e.status])).toEqual([
      ["Offsite", undefined, 0, "confirmed"], ["Planning", "Room 9", 2, "confirmed"]]);
    for (const e of r.struct.events) {
      expect(Object.keys(e).every((k) => ["time", "title", "location", "status", "transparency", "attendeeCount", "ended"].includes(k))).toBe(true);
    }
    noSentinel("struct", JSON.stringify(r.struct));
    // The prompt: the LOCKED variant is the one place attendee text may go; the unlocked one never carries it.
    expect(r.promptBlocks!.locked).toContain("SNTLNAME");
    noSentinel("unlocked block", r.promptBlocks!.unlocked);
    expect(r.promptBlocks!.locked).not.toContain(SECRET);
  });

  test("health: written only by an OWNED run, per trigger, statuses and codes only", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-calhealth-")));
    const f = fakeFetch({ [WORK_URL]: ics(sentinelFeed(RUN)), [HOME_URL]: new Response("SNTLDESC nope", { status: 404 }) });
    const step = createCalendarStep(linksCfg(WORK, HOME), stepDeps({ stateDir: dir, fetch: f.fetch }));
    await step(ctx({ owned: false }));
    expect(existsSync(calendarHealthPath(dir))).toBe(false);
    await step(ctx({ owned: true, trigger: "scheduled" }));
    await step(ctx({ owned: true, trigger: "manual" }));
    const h = await readCalendarHealth(dir);
    expect(h.scheduled!.sources).toEqual([{ id: "work", kind: "link", status: "ok" }, { id: "home", kind: "link", status: "link-refused", reason: "http-refused" }]);
    expect(h.manual!.trigger).toBe("manual");
    const raw = readFileSync(calendarHealthPath(dir), "utf8");
    noSentinel("health file", raw);
    expect(raw).not.toContain("Planning");
    expect(raw).not.toContain("Room 9");
  });

  test("one dead host is not 'offline': that link is incomplete, the other is read", async () => {
    const f = fakeFetch({ [WORK_URL]: ics(sentinelFeed(RUN)), [HOME_URL]: "reject" });
    const r = (await createCalendarStep(linksCfg(WORK, HOME), stepDeps({ fetch: f.fetch }))(ctx()))!;
    expect(r.struct.sources.map((s) => `${s.id}:${s.status}`)).toEqual(["work:ok", "home:incomplete"]);
    expect(r.struct.incomplete).toBe(true);
    expect(r.struct.events.length).toBe(2);
    expect(r.promptBlocks!.unlocked).toContain("home could not be read fully");
  });

  test("offline with links and not forced: skip without reading; forced: read, and a connection failure is `offline`", async () => {
    const f = fakeFetch({ [WORK_URL]: "reject" });
    const step = createCalendarStep(linksCfg(WORK), stepDeps({ fetch: f.fetch }));
    const skip = (await step(ctx({ offline: true })))!;
    expect(skip.skipOffline).toBe(true);
    expect(f.seen).toEqual([]);
    const forced = (await step(ctx({ offline: true, force: true })))!;
    expect(forced.skipOffline).toBe(false);
    expect(forced.struct.sources).toEqual([{ id: "work", kind: "link", status: "offline" }]);
  });

  test("calendar on, no source: the not-connected struct and NO prompt block; calendar off: undefined", async () => {
    const none = (await createCalendarStep(linksCfg(), stepDeps())(ctx({ offline: true })))!;
    expect(none).toEqual({ struct: { events: [], sources: [], incomplete: false }, promptBlocks: null, skipOffline: false });
    expect(await createCalendarStep(resolveCalendar(undefined), stepDeps())(ctx())).toBeUndefined();
  });

  test("the Mac source reports helper-missing on macOS with no reader copy; resolveCalendar drops it elsewhere", async () => {
    const mac = resolveCalendar({ enabled: true, macos: {} }, { platform: "darwin" });
    const r = (await createCalendarStep(mac, stepDeps({ platform: "darwin", osRelease: "24.0.0" }))(ctx()))!;
    expect(r.struct.sources).toEqual([{ id: "macos", kind: "macos", status: "helper-missing" }]);
    const linux = resolveCalendar({ enabled: true, macos: {} }, { platform: "linux" });
    expect((await createCalendarStep(linux, stepDeps())(ctx()))!.struct.sources).toEqual([]);
  });

  test("a credential failure is `malformed` + M1's reason code, and names nothing", async () => {
    const r = (await createCalendarStep(linksCfg(WORK), stepDeps({ env: {} }))(ctx()))!;
    expect(r.struct.sources).toEqual([{ id: "work", kind: "link", status: "malformed" }]);
  });

  test("the overall bound holds: a spinning parse child and a hanging fetch both end as `timeout` at the bound", async () => {
    const f = fakeFetch({ [WORK_URL]: ics(sentinelFeed(RUN)), [HOME_URL]: "hang" });
    const t0 = Date.now();
    const r = (await createCalendarStep(linksCfg(WORK, HOME), stepDeps({ fetch: f.fetch, parseCommand: SPIN_CHILD, boundMs: 1_500 }))(ctx({ startedAt: t0 })))!;
    const took = Date.now() - t0;
    expect(r.struct.sources.map((s) => `${s.id}:${s.status}`)).toEqual(["work:timeout", "home:timeout"]);
    expect(took).toBeLessThan(4_000);
  }, 15_000);

  test("final harden r3: the TIME is shared fairly too — a slow hostile first feed cannot starve a later one", async () => {
    // A parse child that spins forever on the hostile feed and parses anything else for real.
    const HOSTILE = "HOSTILESPINMARK";
    const picky = [process.execPath, "-e", `import { calendarParseMain } from ${JSON.stringify(PARSE_JOB)};
const t = await Bun.stdin.text();
if (t.includes(${JSON.stringify(HOSTILE)})) for (;;) {}
process.exit(await calendarParseMain({ readStdin: async () => t, writeStdout: async (s) => { await Bun.write(Bun.stdout, s); } }));`];
    const c = compact(RUN);
    const hostile = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:h@x", `DTSTART:${c}T090000Z`, `SUMMARY:${HOSTILE}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    // WORK (hostile) lands at once and its parse starts first; HOME (real) lands while WORK's parse spins.
    const f = fakeFetch({ [WORK_URL]: ics(hostile), [HOME_URL]: async () => { await new Promise((r) => setTimeout(r, 300)); return ics(sentinelFeed(RUN)); } });
    const t0 = Date.now();
    const read = await readCalendar(linksCfg(WORK, HOME), { runDate: RUN, startedAt: t0, offline: false },
      { stateDir, env: ENV, platform: "linux", parseCommand: picky, zone: "UTC", fetch: f.fetch, boundMs: 6_000 });
    const by = Object.fromEntries(read.sources.map((x) => [x.id, x]));
    expect(by.work!.status).toBe("timeout");
    expect(by.home!.status).toBe("ok");
    expect(by.home!.eventsToday).toBe(2);
    expect(Date.now() - t0).toBeLessThan(9_000);
  }, 20_000);

  test("fix-round 1: the 5,000-event total is shared fairly — a flooding link that lands first cannot zero a later one", async () => {
    const c = compact(RUN);
    const pad = (n: number) => String(n).padStart(2, "0");
    const floodEvents = Array.from({ length: 5_200 }, (_, i) => ["BEGIN:VEVENT", `UID:f${i}@x`, `DTSTART:${c}T${pad(Math.floor(i / 360) % 24)}${pad(Math.floor(i / 6) % 60)}${pad((i % 6) * 10)}Z`, `SUMMARY:F${i}`, "END:VEVENT"]).flat();
    const flood = ["BEGIN:VCALENDAR", "VERSION:2.0", ...floodEvents, "END:VCALENDAR", ""].join("\r\n");
    const small = ["BEGIN:VCALENDAR", "VERSION:2.0",
      ...[1, 2, 3].flatMap((h) => ["BEGIN:VEVENT", `UID:h${h}@x`, `DTSTART:${c}T1${h}0000Z`, `DTEND:${c}T1${h}3000Z`, `SUMMARY:Home ${h}`, "END:VEVENT"]),
      "END:VCALENDAR", ""].join("\r\n");
    // WORK lands at once and parses first; HOME lands while that parse is still queued or running.
    const f = fakeFetch({ [WORK_URL]: ics(flood), [HOME_URL]: async () => { await new Promise((r) => setTimeout(r, 200)); return ics(small); } });
    const read = await readCalendar(linksCfg(WORK, HOME), { runDate: RUN, startedAt: Date.now(), offline: false },
      { stateDir, env: ENV, platform: "linux", parseCommand: JOB_CHILD, zone: "UTC", fetch: f.fetch });
    const by = Object.fromEntries(read.sources.map((x) => [x.id, x]));
    expect(by.home!.eventsToday).toBe(3);
    expect(by.home!.status).toBe("ok");
    expect(by.work!.status).toBe("incomplete");
    expect(by.work!.eventsToday).toBe(2_500);   // its fair share of 5,000 between two links
    expect(calendarLinkShare(5_000, 2)).toBe(2_500);
    expect(calendarLinkShare(2_497, 1)).toBe(2_497);   // an unused share passes on
    expect(calendarLinkShare(7, 3)).toBe(3);
    expect(calendarLinkShare(0, 2)).toBe(0);
  }, 30_000);

  test("a CPU-heavy RRULE (every second since 2018) is capped in the child: the day's real event still arrives", async () => {
    const f = fakeFetch({ [WORK_URL]: ics(heavyFeed(RUN)) });
    const r = (await createCalendarStep(linksCfg(WORK), stepDeps({ fetch: f.fetch }))(ctx()))!;
    expect(r.struct.events.map((e) => e.title)).toContain("Real");
    expect(["ok", "incomplete"]).toContain(r.struct.sources[0]!.status);
  }, 20_000);

  test("final harden r2: over the section's line cap, a 48-occurrence series cannot push the day's one real meeting out of the section", async () => {
    const { CALENDAR_MAX_EVENT_LINES } = await import("../src/calendar/render-contract");
    const { renderCalendarSection } = await import("../src/render");
    const c = compact(RUN);
    const pad = (n: number) => String(n).padStart(2, "0");
    // A half-hourly series — 48 occurrences today, the per-day cap exactly — and 12 one-off meetings in the morning:
    // 60 events before 23:45, so the real meeting at 23:45 is LAST in display order and the 61st event.
    const oneOffs = Array.from({ length: 12 }, (_, i) => ["BEGIN:VEVENT", `UID:o${i}@x`, `DTSTART:${c}T${pad(8 + Math.floor(i / 2))}${i % 2 ? "15" : "05"}00Z`,
      `DTEND:${c}T${pad(8 + Math.floor(i / 2))}${i % 2 ? "25" : "10"}00Z`, `SUMMARY:One-off ${i}`, "END:VEVENT"]).flat();
    const feed = ["BEGIN:VCALENDAR", "VERSION:2.0",
      "BEGIN:VEVENT", "UID:standup@x", `DTSTART:${c}T000000Z`, `DTEND:${c}T001000Z`, "RRULE:FREQ=MINUTELY;INTERVAL=30", "SUMMARY:Ping", "END:VEVENT",
      ...oneOffs,
      "BEGIN:VEVENT", "UID:real@x", `DTSTART:${c}T234500Z`, `DTEND:${c}T235500Z`, "SUMMARY:Real meeting", "END:VEVENT",
      "END:VCALENDAR", ""].join("\r\n");
    const f = fakeFetch({ [WORK_URL]: ics(feed) });
    const r = (await createCalendarStep(linksCfg(WORK), stepDeps({ fetch: f.fetch }))(ctx()))!;
    const titles = r.struct.events.map((e) => e.title);
    expect(titles.filter((t) => t === "Ping")).toHaveLength(48);
    expect(titles.length).toBe(CALENDAR_MAX_EVENT_LINES + 1);
    // The shown part of the struct — and the rendered section itself — carries the real meeting.
    expect(titles.slice(0, CALENDAR_MAX_EVENT_LINES)).toContain("Real meeting");
    const section = renderCalendarSection(r.struct, RUN).join("\n");
    expect(section).toContain("Real meeting");
    expect(section).toContain("+1 more");
  }, 20_000);

  test("lockStaleMs widens by the step's worst case only when calendar is on", () => {
    expect(lockStaleMs(120_000, { calendar: true }) - lockStaleMs(120_000)).toBe(CALENDAR_STEP_WORST_MS);
    expect(lockStaleMs(120_000, { calendar: false })).toBe(lockStaleMs(120_000));
  });
});

// ── the decided merge mark in the struct (calendar near-duplicates, plan T6.1: R01 struct half, P03 struct half) ──

describe("createCalendarStep: toStructEvent projects the decided mark (T6.1: R01, P03 struct halves)", () => {
  const TEAM_URL = `https://team.example/${SECRET}/team.ics`;
  const TEAM = { id: "team", urlEnv: "TEAM_URL" };
  // A Zoom link and a map link in the location give all three producer keys (meeting, place, link).
  const PLACE = "Clinic North https://zoom.us/j/81234567890 https://maps.example/?q=clinic+north";
  /** One VEVENT on the run date; 09:00Z–13:00Z overlaps 2026-10-09 in every zone from UTC−12 to UTC+14. */
  const vevent = (uid: string, title: string): string[] =>
    ["BEGIN:VEVENT", `UID:${uid}`, "DTSTART:20261009T090000Z", "DTEND:20261009T130000Z", `SUMMARY:${title}`, `LOCATION:${PLACE}`, "END:VEVENT"];
  const feedOf = (...events: string[][]): string => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flat(), "END:VCALENDAR", ""].join("\r\n");
  const structOf = async (work: string[][], home: string[][], team: string[][]) => {
    const f = fakeFetch({ [WORK_URL]: ics(feedOf(...work)), [HOME_URL]: ics(feedOf(...home)), [TEAM_URL]: ics(feedOf(...team)) });
    const r = (await createCalendarStep(linksCfg(WORK, HOME, TEAM), stepDeps({ fetch: f.fetch, env: { ...ENV, TEAM_URL } }))(ctx()))!;
    expect(r.struct.sources.map((x) => `${x.id}:${x.status}`)).toEqual(["work:ok", "home:ok", "team:ok"]);   // PREMISE: all read
    return r;
  };
  const STRUCT_KEYS = ["time", "title", "location", "status", "transparency", "attendeeCount", "ended", "merged"];

  test("R01 M18 through the pipeline: a key-a view {work, home} plus a key-c view {team} → merged {calendars, 3}", async () => {
    const r = await structOf([vevent("m18@x", "Dentist")], [vevent("m18@x", "Dentist")], [vevent("m18-t@x", "Ticket: Dentist")]);
    expect(r.struct.events.map((e) => [e.title, e.merged])).toEqual([["Dentist", { mark: "calendars", count: 3 }]]);
    for (const e of r.struct.events) expect(Object.keys(e).filter((k) => !STRUCT_KEYS.includes(k))).toEqual([]);
  });

  test("R01 M19 through the pipeline: key-a views {work, home} + {home, team}, equal titles → merged {copies, 2}", async () => {
    const r = await structOf([vevent("m19-1@x", "Dentist")], [vevent("m19-1@x", "Dentist"), vevent("m19-2@x", "Dentist")], [vevent("m19-2@x", "Dentist")]);
    expect(r.struct.events.map((e) => [e.title, e.merged])).toEqual([["Dentist", { mark: "copies", count: 2 }]]);
  });

  test("R01 key-a and key-b merges and a lone event carry no merged key in the struct", async () => {
    // work and home share a UID (key a, two sources); team's "Planning" has its own UID and an equal title in a Mac-less
    // pair of links (key b); "Solo" is alone.
    // Each span overlaps 2026-10-09 in every zone from UTC−12 to UTC+14 (starts before 10:00Z, ends after 12:00Z).
    const at = (uid: string, title: string, start: string, end: string): string[] =>
      ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART:20261009T${start}00Z`, `DTEND:20261009T${end}00Z`, `SUMMARY:${title}`, "END:VEVENT"];
    const r = await structOf([vevent("ka@x", "Dentist"), at("kb-w@x", "Planning", "0900", "1230")], [vevent("ka@x", "Dentist")],
      [at("kb-t@x", "Planning", "0900", "1230"), at("solo@x", "Solo", "0930", "1300")]);
    // PREMISE: one row per title, so the key-a pair and the key-b pair each merged.
    expect(r.struct.events.map((e) => e.title).sort()).toEqual(["Dentist", "Planning", "Solo"]);
    for (const e of r.struct.events) expect("merged" in e).toBe(false);
  });

  test("P03 (struct half) the struct of a key-c merge carries no producer key, carrier or internal mark, by name or by value", async () => {
    const r = await structOf([vevent("p03-w@x", "Dentist")], [vevent("p03-h@x", "Ticket: Dentist")], [vevent("p03-t@x", "Dentist")]);
    expect(r.struct.events.map((e) => e.merged)).toEqual([{ mark: "calendars", count: 3 }]);   // PREMISE: a key-c merge
    const keys = producerKeys({ location: PLACE });
    const values = [keys.meetingKey, keys.placeKey, ...(keys.linkKeys ?? [])];
    expect(values.every((v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v))).toBe(true);   // PREMISE: all three present
    expect(keys.linkKeys!.length).toBe(2);
    const text = JSON.stringify(r.struct);
    for (const name of ["meetingKey", "placeKey", "linkKeys", "viewDetails", "nearDuplicate"]) expect(`${name}: ${text.includes(name)}`).toBe(`${name}: false`);
    for (const v of values) expect(text).not.toContain(v!);
  });
});

// ── runCore with the seam ────────────────────────────────────────────────────────────────────────────

const MODEL_OUT = "## RESUME\n- [r] resume here\n## RECAP\n- [r] did x\n## SUGGESTIONS\n- do y";
const okProvider = (): Provider & { prompts: string[] } => {
  const prompts: string[] = [];
  return { prompts, generate: async (p: string) => { prompts.push(p); return MODEL_OUT; } };
};
const DARKWAKE = async () => ({ code: 0, out: "Current System Capabilities are: CPU Disk Network\n" });
const TODAY = localDateStr(new Date());
const emptyCfg = (calendar?: unknown): Config =>
  ({ repos: [], provider: { cli: "claude", argv: [], promptVia: "stdin" }, ...(calendar !== undefined ? { calendar } : {}) } as Config);
const baseDeps = (over: Partial<RunDeps> = {}): RunDeps => ({
  netProbe: async () => true, powerPlatform: "linux", sleep: async () => {}, retryDelaysMs: [], netGraceMs: 30, netPollMs: 10, ...over,
});

describe("runCore and the calendar seam", () => {
  let repo = "";
  beforeAll(async () => {
    const { buildRepo } = await import("./fixtures/build-repo");
    repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
  });
  const busyCfg = (calendar?: unknown): Config => ({ ...emptyCfg(calendar), repos: [repo] } as Config);
  const CAL_ON = { enabled: true, links: [WORK] };

  test("seam data: the struct is the step's, the prompt carries its block", async () => {
    const struct = { events: [], sources: [{ id: "work", kind: "link" as const, status: "ok" as const }], incomplete: false };
    const p = okProvider();
    const r = await runCore(busyCfg(CAL_ON), baseDeps({ provider: p, calendar: async () => ({ struct, promptBlocks: { locked: "L-BLOCK", unlocked: "U-BLOCK" }, skipOffline: false }) }));
    expect(r.struct.calendar).toEqual(struct);
    expect(p.prompts[0]).toContain("U-BLOCK");
  });

  test("seam THROWS: the briefing is delivered, every configured source `malformed`", async () => {
    const r = await runCore(busyCfg(CAL_ON), baseDeps({ provider: okProvider(), calendar: () => { throw new Error("SNTLDESC boom"); } }));
    expect(r.offlineSkipped).toBe(false);
    expect(r.struct.calendar).toEqual({ events: [], sources: [{ id: "work", kind: "link", status: "malformed" }], incomplete: true });
    noSentinel("struct", JSON.stringify(r.struct));
  });

  test("seam NEVER RESOLVES: bounded, delivered, every source `timeout`", async () => {
    const t0 = Date.now();
    const r = await runCore(busyCfg(CAL_ON), baseDeps({ provider: okProvider(), calendar: () => new Promise(() => {}), calendarBoundMs: 300 }));
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.struct.calendar!.sources).toEqual([{ id: "work", kind: "link", status: "timeout" }]);
    expect(r.rawText).toBe(MODEL_OUT);
  });

  test("calendar off: no step runs, no struct field, the one-argument prompt", async () => {
    const r = await runCore(busyCfg(), baseDeps({ provider: okProvider() }));
    expect("calendar" in r.struct).toBe(false);
    expect(r.calendarWarnings).toBeUndefined();
  });

  test("fix-round 1: on a provider FAILURE the calendar config warnings (fixed text) ride the ProviderError's warnings", async () => {
    const { ProviderError } = await import("../src/types");
    const { CALENDAR_CONFIG_WARNINGS } = await import("../src/calendar/config");
    const failing: Provider = { generate: async () => { throw new ProviderError("nonzero-exit", "boom"); } };
    const calendar: RunDeps["calendar"] = async () => ({ struct: { events: [], sources: [], incomplete: false }, promptBlocks: null, skipOffline: false });
    let caught: unknown;
    try { await runCore(busyCfg({ enabled: true, links: [{ id: "x", url: WORK_URL }, WORK] }), baseDeps({ provider: failing, calendar })); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProviderError);
    const w = (caught as InstanceType<typeof ProviderError>).warnings ?? [];
    expect(w).toContain(CALENDAR_CONFIG_WARNINGS.literalUrl);
    expect(w.join("\n")).not.toContain(SECRET);
  });

  test("fix-round 1: a BLOCKED run with calendar on never calls the step and carries no calendar", async () => {
    let stepped = 0;
    const calendar: RunDeps["calendar"] = async () => { stepped++; return { struct: { events: [], sources: [], incomplete: false }, promptBlocks: null, skipOffline: false }; };
    const missing = join(removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-calblk-"))), "no-such-folder");
    const r = await runCore({ ...emptyCfg(CAL_ON), discoverRoots: [missing] } as Config, baseDeps({ calendar, provider: { generate: async () => { throw new Error("must not be called"); } } }));
    expect([r.blocked, r.discoveryBlocked]).toEqual([true, true]);
    expect(stepped).toBe(0);
    expect("calendar" in r.struct).toBe(false);
    // The same day unblocked (an empty window) does call it — the spy is live.
    await runCore(emptyCfg(CAL_ON), baseDeps({ calendar }));
    expect(stepped).toBe(1);
  });

  test("calendar config warnings stay OUT of struct.warnings (the audited ⚠ line) and ride calendarWarnings", async () => {
    const r = await runCore(busyCfg({ enabled: "yes" }), baseDeps({ provider: okProvider() }));
    expect(r.calendarWarnings).toEqual(['config: "calendar.enabled" must be true or false — calendar off']);
    expect((r.struct.warnings ?? []).join(" ")).not.toContain("calendar");
    expect(r.warnings.join(" ")).not.toContain("calendar");
  });

  test("EMPTY DAY with calendar: the section is there, no provider call, the network gate was taken", async () => {
    const p: Provider = { generate: async () => { throw new Error("must not be called"); } };
    const struct = { events: [], sources: [{ id: "work", kind: "link" as const, status: "ok" as const }], incomplete: false };
    const r = await runCore(emptyCfg(CAL_ON), baseDeps({ provider: p, calendar: async () => ({ struct, promptBlocks: null, skipOffline: false }) }));
    expect(r.emptyWindow).toBe(true);
    expect(r.offlineSkipped).toBe(false);
    expect(r.struct.calendar).toEqual(struct);
    expect(r.net).not.toBeNull();
  });

  test("EMPTY DAY, darkwake: skipped without the step; --force is exempt; calendar off never probes", async () => {
    let stepped = 0, probed = 0;
    const calendar: RunDeps["calendar"] = async () => { stepped++; return { struct: { events: [], sources: [], incomplete: false }, promptBlocks: null, skipOffline: false }; };
    const powerProbe = async (a: string[]) => { probed++; return DARKWAKE(); void a; };
    const r = await runCore(emptyCfg(CAL_ON), baseDeps({ calendar, powerPlatform: "darwin", powerProbe }));
    expect([r.offlineSkipped, r.skipReason, stepped]).toEqual([true, "darkwake", 0]);
    const f = await runCore(emptyCfg(CAL_ON), baseDeps({ calendar, powerPlatform: "darwin", powerProbe }), true);
    expect([f.offlineSkipped, stepped]).toEqual([false, 1]);
    probed = 0;
    const off = await runCore(emptyCfg(), baseDeps({ powerPlatform: "darwin", powerProbe }));
    expect([off.emptyWindow, off.offlineSkipped, probed, off.net]).toEqual([true, false, 0, null]);
  });

  test("EMPTY DAY, offline with links (the real step): skip without stamping; --force renders the link as offline", async () => {
    const f = fakeFetch({ [WORK_URL]: "reject" });
    const resolved = linksCfg(WORK);
    const calendar = createCalendarStep(resolved, stepDeps({ fetch: f.fetch }));
    const r = await runCore(emptyCfg(CAL_ON), baseDeps({ calendar, netProbe: async () => false }));
    expect([r.offlineSkipped, r.skipReason]).toEqual([true, "offline"]);
    expect(f.seen).toEqual([]);
    const forced = await runCore(emptyCfg(CAL_ON), baseDeps({ calendar, netProbe: async () => false }), true);
    expect(forced.offlineSkipped).toBe(false);
    expect(forced.struct.calendar!.sources).toEqual([{ id: "work", kind: "link", status: "offline" }]);
  });
});

// ── run(): what the shell stamps, and what every file and stream carries ─────────────────────────────

function withEnv(cfgObj: unknown): { stateDir: string; cleanup: () => void } {
  const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-calcfg-")));
  const sd = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-calrun-")));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify(cfgObj));
  const prevXdg = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.DAILY_BRIEFING_STATE_DIR = sd;
  return {
    stateDir: sd,
    cleanup: () => {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
    },
  };
}
function captureConsole() {
  const out: string[] = [], err: string[] = [];
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  return { out, err, restore: () => { console.log = oLog; console.error = oErr; } };
}

describe("run(): stamping and the sentinel sweep", () => {
  let repo = "";
  beforeAll(async () => {
    const { buildRepo } = await import("./fixtures/build-repo");
    repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
  });
  const cfg = (repos: string[]) => ({ repos, provider: { cli: "claude", argv: [], promptVia: "stdin" }, calendar: { enabled: true, links: [WORK, HOME] } });
  const runDeps = (calendar: RunDeps["calendar"], provider: Provider) =>
    ({ provider, calendar, netProbe: async () => true, netGraceMs: 30, netPollMs: 10, retryDelaysMs: [], sleep: async () => {}, powerPlatform: "linux" as const });

  test("one dead host → that link incomplete, the briefing delivered and STAMPED; nothing attendee-written anywhere", async () => {
    const env = withEnv(cfg([repo]));
    const cap = captureConsole();
    try {
      const f = fakeFetch({ [WORK_URL]: ics(sentinelFeed(TODAY)), [HOME_URL]: "reject" });
      const calendar = createCalendarStep(resolveCalendar(cfg([repo]).calendar, { platform: "linux" }), stepDeps({ stateDir: env.stateDir, fetch: f.fetch }));
      const outPath = join(env.stateDir, "env.json");
      const code = await run(true, runDeps(calendar, okProvider()), { json: true, jsonOut: outPath });
      cap.restore();
      expect(code).toBe(0);
      expect(readFileSync(markerPath(), "utf8")).toBe(TODAY);
      const latest = readFileSync(latestBriefingPath(), "utf8");
      expect(latest).toContain("▶ Today's calendar (incomplete)");
      expect(latest).toContain("home: only partly read");
      expect(latest).toContain("Planning (Room 9)");
      for (const [where, text] of [["briefing", latest], ["archive", readFileSync(archivedBriefingPath(TODAY), "utf8")],
        ["envelope file", readFileSync(outPath, "utf8")], ["stdout", cap.out.join("\n")], ["stderr", cap.err.join("\n")]] as const) {
        noSentinel(where, text);
      }
      const envl = JSON.parse(readFileSync(outPath, "utf8"));
      expect(envl.delivered).toBe(true);
      expect(envl.struct.calendar.sources.map((s: { status: string }) => s.status)).toEqual(["ok", "incomplete"]);
    } finally { cap.restore(); env.cleanup(); }
  }, 30_000);

  test("failure path: the provider fails — the envelope still carries nothing attendee-written", async () => {
    const env = withEnv(cfg([repo]));
    const cap = captureConsole();
    try {
      const f = fakeFetch({ [WORK_URL]: ics(sentinelFeed(TODAY)), [HOME_URL]: new Response("SNTLDESC body", { status: 410 }) });
      const calendar = createCalendarStep(resolveCalendar(cfg([repo]).calendar, { platform: "linux" }), stepDeps({ stateDir: env.stateDir, fetch: f.fetch }));
      const failing: Provider = { generate: async () => { const { ProviderError } = await import("../src/types"); throw new ProviderError("nonzero-exit", "SNTL-free failure"); } };
      const outPath = join(env.stateDir, "env.json");
      const code = await run(true, runDeps(calendar, failing), { json: true, jsonOut: outPath });
      cap.restore();
      expect(code).toBe(1);
      expect(existsSync(markerPath())).toBe(false);
      for (const [where, text] of [["envelope file", readFileSync(outPath, "utf8")], ["stdout", cap.out.join("\n")], ["stderr", cap.err.join("\n")]] as const) {
        noSentinel(where, text);
      }
    } finally { cap.restore(); env.cleanup(); }
  }, 30_000);

  test("a CPU-heavy RRULE through the real child: delivered, exit 0, stamped", async () => {
    const env = withEnv(cfg([repo]));
    const cap = captureConsole();
    try {
      const f = fakeFetch({ [WORK_URL]: ics(heavyFeed(TODAY)), [HOME_URL]: ics(heavyFeed(TODAY)) });
      const calendar = createCalendarStep(resolveCalendar(cfg([repo]).calendar, { platform: "linux" }), stepDeps({ stateDir: env.stateDir, fetch: f.fetch }));
      const code = await run(true, runDeps(calendar, okProvider()));
      cap.restore();
      expect(code).toBe(0);
      expect(readFileSync(markerPath(), "utf8")).toBe(TODAY);
      expect(readFileSync(latestBriefingPath(), "utf8")).toContain("Real");
    } finally { cap.restore(); env.cleanup(); }
  }, 30_000);

  test("fix-round 1: calendarTrigger — only the unattended tick is `scheduled`; a terminal, --json or --force run is `manual`", async () => {
    const cases: [string, boolean, { interactive: boolean; runNow?: boolean }, { json?: boolean }, "scheduled" | "manual"][] = [
      ["unattended tick", false, { interactive: false }, {}, "scheduled"],
      ["terminal", false, { interactive: true }, {}, "manual"],
      ["--json (the app's Run now)", false, { interactive: false }, { json: true }, "manual"],
      ["--force", true, { interactive: false }, {}, "manual"],
      // `--now` lifts the floor and nothing else: it never changes the trigger the run's other inputs decide.
      ["--now --json (the app's Run now)", false, { interactive: false, runNow: true }, { json: true }, "manual"],
      ["--now without a TTY or --json", false, { interactive: false, runNow: true }, {}, "scheduled"],
    ];
    for (const [name, force, inter, out, want] of cases) {
      const env = withEnv({ ...cfg([]), morningTime: "00:00" });   // a scheduled tick is past the floor at any hour
      const cap = captureConsole();
      try {
        const triggers: string[] = [];
        const calendar: RunDeps["calendar"] = async (c) => { triggers.push(c.trigger); return { struct: { events: [], sources: [], incomplete: false }, promptBlocks: null, skipOffline: false }; };
        await run(force, { ...runDeps(calendar, okProvider()), ...inter }, out);
        cap.restore();
        expect(`${name}: ${triggers.join(",")}`).toBe(`${name}: ${want}`);
      } finally { cap.restore(); env.cleanup(); }
    }
  }, 30_000);

  test("fix-round 1: the run lock widens by the calendar step's worst case only when calendar is on (main.ts wiring)", async () => {
    const { runLockPath } = await import("../src/runlock");
    const { utimesSync } = await import("node:fs");
    for (const [on, wantSkip] of [[true, true], [false, false]] as const) {
      const env = withEnv({ ...cfg([]), morningTime: "00:00", ...(on ? {} : { calendar: undefined }) });
      const cap = captureConsole();
      try {
        // A live holder (this process) whose lock is older than the plain bound but inside the widened one.
        const path = runLockPath();
        writeFileSync(path, JSON.stringify({ pid: process.pid, startedIso: new Date().toISOString(), invoker: "scheduled", nonce: "x" }));
        const age = (lockStaleMs() + CALENDAR_STEP_WORST_MS / 2) / 1000;
        const t = Date.now() / 1000 - age;
        utimesSync(path, t, t);
        const calendar: RunDeps["calendar"] = async () => ({ struct: { events: [], sources: [], incomplete: false }, promptBlocks: null, skipOffline: false });
        await run(false, { ...runDeps(calendar, okProvider()), interactive: false });
        cap.restore();
        expect(`calendar ${on}: skipped=${cap.err.join("\n").includes("already in progress")}`).toBe(`calendar ${on}: skipped=${wantSkip}`);
      } finally { cap.restore(); env.cleanup(); }
    }
  }, 30_000);

  test("empty day, offline, links configured, scheduled: exit 0 and NOT stamped (a later tick retries)", async () => {
    const env = withEnv(cfg([]));
    const cap = captureConsole();
    try {
      const f = fakeFetch({});
      const calendar = createCalendarStep(resolveCalendar(cfg([]).calendar, { platform: "linux" }), stepDeps({ stateDir: env.stateDir, fetch: f.fetch }));
      const code = await run(false, { ...runDeps(calendar, okProvider()), netProbe: async () => false, interactive: true });
      cap.restore();
      expect(code).toBe(0);
      expect(existsSync(markerPath())).toBe(false);
      expect(cap.err.join("\n")).toContain("skipped: no network");
    } finally { cap.restore(); env.cleanup(); }
  }, 30_000);
});
