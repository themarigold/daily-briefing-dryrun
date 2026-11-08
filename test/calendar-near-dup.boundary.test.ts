import "./fixtures/isolate-state";   // armed before this file's first save, from any cwd (see test/fixtures/isolate-state.ts)
// test/calendar-near-dup.boundary.test.ts — the producer keys' output boundary (calendar near-duplicates, spec
// 2026-10-31 §4 "Boundary"; plan T6.4: P03). `meetingKey`, `placeKey` and `linkKeys` cross the transient parse pipe and
// reach reconcile; they, the details carrier `viewDetails` and the internal mark `nearDuplicate` never reach the struct,
// the rendered page, the prompt, the details JSON, health, diagnostics (stdout/stderr) or any file. A morning run and a
// details read, each over link feeds whose events carry all three keys and merge by key c, are scanned for every key
// NAME and every 64-hex key VALUE the fixture produces.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRepo } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { calendarMain } from "../src/calendar/cli";
import { resolveCalendar } from "../src/calendar/config";
import { calendarHealthPath } from "../src/calendar/health";
import { producerKeys } from "../src/calendar/join";
import { createCalendarStep, readCalendar, type CalendarStepDeps } from "../src/calendar/pipeline";
import type { CalendarDetailsJson } from "../src/calendar/details";
import { archivedBriefingPath, latestBriefingPath, localDateStr } from "../src/marker";
import { run } from "../src/main";
import type { RunDeps } from "../src/core";
import type { GenerateOpts, Provider } from "../src/types";

guardNetworkForThisFile();

const PARSE_JOB = resolve(import.meta.dir, "../src/calendar/parse-job.ts");
const JOB_CHILD = [process.execPath, "-e", `import { calendarParseMain } from ${JSON.stringify(PARSE_JOB)}; process.exit(await calendarParseMain());`];
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TODAY = localDateStr(new Date());

const WORK_URL = "https://work.example/s3cr3tBnd/work.ics", HOME_URL = "https://home.example/s3cr3tBnd/home.ics", TEAM_URL = "https://team.example/s3cr3tBnd/team.ics";
const ENV = { WORK_URL, HOME_URL, TEAM_URL };
const LINKS = [{ id: "work", urlEnv: "WORK_URL" }, { id: "home", urlEnv: "HOME_URL" }, { id: "team", urlEnv: "TEAM_URL" }];

// A Zoom link and a map link in the raw location: a meeting key, a place key and two link keys. The notes carry the
// same Zoom meeting (read only when the location has no known-host link, so the location decides).
const RAW_LOC = "Clinic North https://zoom.us/j/81234567890 https://maps.example/?q=clinic+north";
const KEYS = producerKeys({ location: RAW_LOC });
const KEY_VALUES = [KEYS.meetingKey, KEYS.placeKey, ...(KEYS.linkKeys ?? [])].filter((v): v is string => typeof v === "string");
const KEY_NAMES = ["meetingKey", "placeKey", "linkKeys", "viewDetails", "nearDuplicate"];

/** A local wall time today as an iCalendar UTC date-time. */
const at = (h: number, m = 0): string => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); };
const vevent = (uid: string, title: string, notes: string): string[] => [
  "BEGIN:VEVENT", `UID:${uid}`, `DTSTART:${at(9)}`, `DTEND:${at(9, 30)}`, `SUMMARY:${title}`, `LOCATION:${RAW_LOC}`,
  `DESCRIPTION:${notes} https://zoom.us/j/81234567890`, "END:VEVENT",
];
const feed = (...events: string[][]): string => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flat(), "END:VCALENDAR", ""].join("\r\n");
const ROUTES: Record<string, string> = {
  [WORK_URL]: feed(vevent("bnd-w@x", "Dentist", "work notes")),
  [HOME_URL]: feed(vevent("bnd-h@x", "Ticket: Dentist", "home notes")),
  [TEAM_URL]: feed(vevent("bnd-t@x", "Dentist", "team notes")),
};
const fetchRoutes = async (url: string): Promise<Response> => {
  const body = ROUTES[url];
  if (body === undefined) throw new Error("connect failed");
  return new Response(body, { status: 200, headers: { "content-type": "text/calendar" } });
};

/** Every regular file under `dir`, recursively, with its text. */
function filesUnder(dir: string): [string, string][] {
  const out: [string, string][] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...filesUnder(p));
    else if (st.isFile()) out.push([p, readFileSync(p, "utf8")]);
  }
  return out;
}
/** No key name and no key value in `text`, labelled by `where` so a failure names the surface. */
function clean(where: string, text: string): void {
  for (const n of KEY_NAMES) expect(`${where} names ${n}: ${text.includes(n)}`).toBe(`${where} names ${n}: false`);
  for (const v of KEY_VALUES) expect(`${where} holds ${v.slice(0, 8)}…: ${text.includes(v)}`).toBe(`${where} holds ${v.slice(0, 8)}…: false`);
}

describe("P03 the producer keys never cross the output boundary (T6.4)", () => {
  let repo = "";
  beforeAll(async () => {
    repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
    // PREMISE: the fixture yields all three keys — one meeting key, one place key, two link keys.
    expect(KEY_VALUES.length).toBe(4);
    for (const v of KEY_VALUES) expect(v).toMatch(/^[0-9a-f]{64}$/);
  });

  test("P03 PREMISE: the read itself carries the keys and the carrier, so the scans below are not vacuous", async () => {
    const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-ndbnd-read-")));
    const r = resolveCalendar({ enabled: true, emails: [], links: LINKS }, { platform: "linux" });
    const read = await readCalendar(r, { runDate: TODAY, startedAt: Date.now(), offline: false },
      { stateDir, env: ENV, platform: "linux", parseCommand: JOB_CHILD, zone: ZONE, fetch: fetchRoutes, details: true });
    expect(read.events).toHaveLength(1);
    const e = read.events[0]!;
    // work and team share the title "Dentist": key b joins them into one step-3 view, which key c then merges with
    // home's "Ticket: Dentist" — two views over three calendars.
    expect([e.sources.length, e.nearDuplicate, e.viewDetails?.map((v) => v.title)]).toEqual([3, { mark: "calendars", count: 3 }, ["Dentist", "Ticket: Dentist"]]);
    expect([e.meetingKey, e.placeKey, e.linkKeys]).toEqual([KEYS.meetingKey, KEYS.placeKey, KEYS.linkKeys]);
  });

  test("P03 a morning run: struct, page, archive, envelope, both prompt variants, stdout, stderr, health and every state file", async () => {
    const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-ndbnd-cfg-")));
    const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-ndbnd-run-")));
    const cfg = { repos: [repo], provider: { cli: "claude", argv: [], promptVia: "stdin" }, calendar: { enabled: true, links: LINKS } };
    mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
    writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify(cfg));
    const prevXdg = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
    process.env.XDG_CONFIG_HOME = cfgHome;
    process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
    const out: string[] = [], err: string[] = [];
    const oLog = console.log, oErr = console.error;
    console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
    console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
    const sent: { prompt: string; opts?: GenerateOpts | undefined }[] = [];
    const provider: Provider = {
      generate: async (prompt, opts) => { sent.push({ prompt, opts }); return "## RESUME\n- [r] resume here\n## RECAP\n- [r] did x\n## SUGGESTIONS\n- do y"; },
    };
    try {
      const stepDeps: CalendarStepDeps = { stateDir, env: ENV, platform: "linux", parseCommand: JOB_CHILD, zone: ZONE, maxChars: 200_000, fetch: fetchRoutes };
      const calendar = createCalendarStep(resolveCalendar(cfg.calendar, { platform: "linux" }), stepDeps);
      const deps = { provider, calendar, netProbe: async () => true, netGraceMs: 30, netPollMs: 10, retryDelaysMs: [], sleep: async () => {}, powerPlatform: "linux" as const } satisfies RunDeps;
      const envPath = join(stateDir, "env.json");
      const code = await run(true, deps, { json: true, jsonOut: envPath });
      console.log = oLog; console.error = oErr;
      expect(code).toBe(0);
      const latest = readFileSync(latestBriefingPath(), "utf8");
      // PREMISE: the run rendered ONE key-c merged row, with its decided mark, and sent the calendar to the model.
      expect(latest.split("\n").filter((l) => l.includes("Dentist"))).toEqual([expect.stringMatching(/Dentist .* · on 3 calendars( · ended)?$/)]);
      const envelope = readFileSync(envPath, "utf8");
      expect(JSON.parse(envelope).struct.calendar.events.map((e: { merged?: unknown }) => e.merged)).toEqual([{ mark: "calendars", count: 3 }]);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((s) => s.opts?.calendarVariants !== undefined)).toBe(true);
      expect(sent[0]!.prompt).toContain("TODAY'S CALENDAR");
      clean("page", latest);
      clean("archive", readFileSync(archivedBriefingPath(TODAY), "utf8"));
      clean("envelope", envelope);
      for (const [i, s] of sent.entries()) {
        clean(`prompt ${i}`, s.prompt);
        clean(`locked variant ${i}`, s.opts!.calendarVariants!.locked);
        clean(`unlocked variant ${i}`, s.opts!.calendarVariants!.unlocked);
      }
      clean("stdout", out.join("\n"));
      clean("stderr", err.join("\n"));
      // A run with an injected provider is not an owned run, so it writes no health record (src/core.ts `owned`); one
      // owned step over the same state dir writes it. PREMISE: it exists; it is then scanned with every other state file.
      await calendar({ runDate: TODAY, startedAt: Date.now(), offline: false, force: false, owned: true, trigger: "scheduled" });
      expect(readFileSync(calendarHealthPath(stateDir), "utf8")).toContain("\"work\"");
      const files = filesUnder(stateDir);
      expect(files.length).toBeGreaterThan(2);
      for (const [path, text] of files) clean(`state file ${path.slice(stateDir.length)}`, text);
      for (const [path, text] of filesUnder(cfgHome)) clean(`config file ${path.slice(cfgHome.length)}`, text);
    } finally {
      console.log = oLog; console.error = oErr;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
    }
  }, 30_000);

  test("P03 a details read: the details JSON, stderr and every state file", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-ndbnd-det-")));
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ calendar: { enabled: true, emails: [], links: LINKS } }));
    const out: string[] = [], err: string[] = [];
    const code = await calendarMain(["details", "--json"], {
      stateDir, configFile, platform: "linux", parseCommand: JOB_CHILD, isTTY: false, readStdin: async () => "", env: ENV,
      fetch: fetchRoutes, out: (s) => out.push(s), err: (s) => err.push(s),
    });
    expect(code).toBe(0);
    const doc = JSON.parse(out.join("\n")) as CalendarDetailsJson;
    // PREMISE: one key-c merged event whose card carries the other views' notes and its mark in rowText.
    expect(doc.events.map((e) => [e.title, e.otherNotes?.map((o) => o.title), / · on 3 calendars( · ended)?$/.test(e.rowText)])).toEqual([["Dentist", ["Ticket: Dentist"], true]]);
    clean("details JSON", out.join("\n"));
    clean("details stderr", err.join("\n"));
    for (const [path, text] of filesUnder(stateDir)) clean(`details state file ${path.slice(stateDir.length)}`, text);
  }, 30_000);
});
