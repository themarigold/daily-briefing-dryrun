import "./fixtures/isolate-state";   // armed before this file's first save, from any cwd (see test/fixtures/isolate-state.ts)
// test/calendar-cli.test.ts — `daily-briefing calendar …` and the calendar fields of the diagnostics (v0.3.0 plan M5;
// spec r4 §4.2, §8). Every test passes its own state dir and config file (or redirects both through the env, for the
// surfaces that read the real paths); the network is guarded and every fetch is injected.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { calendarMain, writeManagedLinkFile, type CalendarCliDeps } from "../src/calendar/cli";
import { calendarLinkFilePath } from "../src/calendar/link-url";
import { readCalendarHealth, writeCalendarHealth } from "../src/calendar/health";
import { CALENDAR_CONFIG_WARNINGS } from "../src/calendar/config";
import { calendarStatus } from "../src/calendar/status";
import { macOsSupported } from "../src/calendar/reader";
import { dispatch } from "../src/main";
import { statusReport, doctorReport, validateCandidate } from "../src/json";
import type { CalendarLinkInfo, CalendarListJson, CalendarStatusJson, CalendarTestJson } from "../src/calendar/types";

guardNetworkForThisFile();

const SECRET = "pr1vateT0kenXyz";
const GOOGLE = `https://calendar.google.com/calendar/ical/me%40personal.example/private-${SECRET}/basic.ics`;
const OTHER = `https://cal.example/${SECRET}/feed.ics`;
const PARSE_JOB = resolve(import.meta.dir, "../src/calendar/parse-job.ts");
const JOB_CHILD = [process.execPath, "-e", `import { calendarParseMain } from ${JSON.stringify(PARSE_JOB)}; process.exit(await calendarParseMain());`];

function setup(config?: unknown) {
  const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-calcli-")));
  const stateDir = join(root, "state"), cfgDir = join(root, "cfg");
  mkdirSync(stateDir, { recursive: true }); mkdirSync(cfgDir, { recursive: true });
  const configFile = join(cfgDir, "config.json");
  if (config !== undefined) writeFileSync(configFile, JSON.stringify(config, null, 2));
  const out: string[] = [], err: string[] = [];
  const lines: string[] = [];
  const deps = (over: Partial<CalendarCliDeps> = {}): CalendarCliDeps => ({
    stateDir, configFile, platform: "linux", isTTY: false, out: (s) => out.push(s), err: (s) => err.push(s),
    readLine: async () => lines.shift() ?? null, ...over,
  });
  const cfg = () => JSON.parse(readFileSync(configFile, "utf8"));
  const all = () => [...out, ...err].join("\n");
  return { root, stateDir, configFile, out, err, lines, deps, cfg, all };
}
const BASE = { repos: ["/tmp/x"], provider: { cli: "claude", argv: [], promptVia: "stdin" } };
/** `macSupported` as `status --json` and `doctor --json` report it: this host's (they pass no platform or release),
 *  so true on a Mac with macOS 14+ and false on CI's Linux (wave-2 polish plan, disagreement 7). */
const HOST_MAC_SUPPORTED = process.platform === "darwin" && macOsSupported();

describe("calendar add-link", () => {
  test("stores the URL in the managed file (0700 folder, 0600 file), the entry in the config — and prints the URL nowhere", async () => {
    const s = setup(BASE);
    s.lines.push(GOOGLE);
    expect(await calendarMain(["add-link", "--id", "home", "--name", "Home (Google)"], s.deps())).toBe(0);
    const file = calendarLinkFilePath(s.stateDir, "home");
    expect(readFileSync(file, "utf8")).toBe(`${GOOGLE}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.stateDir, "calendar", "links")).mode & 0o777).toBe(0o700);
    expect(s.cfg().calendar).toEqual({ enabled: true, links: [{ id: "home", name: "Home (Google)" }] });
    expect(s.cfg().repos).toEqual(["/tmp/x"]);   // every other key kept
    expect(s.all()).toContain("me@personal.example");
    expect(s.all()).not.toContain(SECRET);
    expect(JSON.stringify(s.cfg())).not.toContain(SECRET);
    expect(readdirSync(join(s.stateDir, "calendar", "links"))).toEqual(["home.url"]);   // no temp file left
  });

  test("an entry that cannot be formed stores NO link file (integration LOW: validated before the write)", async () => {
    // A skipped literal-`url` entry ahead of a real one with the same id: the block resolves (the first is skipped),
    // but replacing the first by id would leave two "work" entries — a malformed block.
    const block = { enabled: true, links: [{ id: "work", url: OTHER }, { id: "work" }] };
    const s = setup({ ...BASE, calendar: block });
    s.lines.push(GOOGLE);
    expect(await calendarMain(["add-link", "--id", "work"], s.deps())).toBe(1);
    expect(s.err.join("\n")).toContain("could not be formed");
    expect(existsSync(calendarLinkFilePath(s.stateDir, "work"))).toBe(false);
    expect(existsSync(join(s.stateDir, "calendar", "links")) ? readdirSync(join(s.stateDir, "calendar", "links")) : []).toEqual([]);
    expect(s.cfg().calendar).toEqual(block);
    expect(s.all()).not.toContain(SECRET);
  });

  test("--confirm-owner records the URL-path address; without it nothing is recorded; a replaced link never inherits it", async () => {
    const s = setup(BASE);
    s.lines.push(GOOGLE);
    expect(await calendarMain(["add-link", "--id", "home", "--confirm-owner", "--json"], s.deps())).toBe(0);
    const info = JSON.parse(s.out.at(-1)!).link as CalendarLinkInfo;
    expect(info).toEqual({ id: "home", urlPathOwner: "me@personal.example", confirmedOwner: "me@personal.example", urlFrom: "file", fileStatus: "ok" });
    expect(s.cfg().calendar.links).toEqual([{ id: "home", confirmedOwner: "me@personal.example" }]);
    s.lines.push(GOOGLE.replace("me%40personal.example", "boss%40personal.example"));
    expect(await calendarMain(["add-link", "--id", "home", "--json"], s.deps())).toBe(0);
    expect(s.cfg().calendar.links).toEqual([{ id: "home" }]);
    expect(s.all()).not.toContain(SECRET);
  });

  test("interactive: the person is asked, and only a yes confirms", async () => {
    for (const [answer, confirmed] of [["y", true], ["", false], ["no", false]] as const) {
      const s = setup(BASE);
      s.lines.push(GOOGLE, answer);
      expect(await calendarMain(["add-link", "--id", "home"], s.deps({ isTTY: true }))).toBe(0);
      expect(`${answer}: ${s.cfg().calendar.links[0].confirmedOwner ?? null}`).toBe(`${answer}: ${confirmed ? "me@personal.example" : null}`);
      expect(s.err.join("\n")).toContain("Is me@personal.example your own address?");
      expect(s.all()).not.toContain(SECRET);
    }
  });

  test("final harden r2: the 'accepts and declines' line is printed only when no DIFFERING owner is configured", async () => {
    const plain = setup(BASE);
    plain.lines.push(GOOGLE);
    expect(await calendarMain(["add-link", "--id", "home"], plain.deps())).toBe(0);
    expect(plain.err.join("\n")).toContain("will only recognise your accepts and declines");
    for (const owner of ["boss@work.example", "ME@personal.example"]) {
      const s = setup(BASE);
      s.lines.push(GOOGLE);
      expect(await calendarMain(["add-link", "--id", "home", "--owner", owner], s.deps())).toBe(0);
      const differs = owner.toLowerCase() !== "me@personal.example";
      expect(`${owner}: ${s.err.join("\n").includes("accepts and declines")}`).toBe(`${owner}: ${!differs}`);
      if (differs) expect(s.err.join("\n")).toContain("is not treated as yours");
    }
  });

  test("refusals never echo what was pasted", async () => {
    const bad = [`http://cal.example/${SECRET}.ics`, `https://u:${SECRET}@cal.example/x.ics`, `https://cal.example:8443/${SECRET}.ics`, `not a url ${SECRET}`];
    for (const url of bad) {
      const s = setup(BASE);
      s.lines.push(url);
      expect(await calendarMain(["add-link", "--id", "home"], s.deps())).toBe(2);
      expect(s.all()).not.toContain(SECRET);
      expect(existsSync(calendarLinkFilePath(s.stateDir, "home"))).toBe(false);
      expect(s.cfg().calendar).toBeUndefined();
    }
  });

  test("URL-LEAK SENTINEL (CLI): an unknown flag carrying the URL is echoed only by name, scrubbed, in stderr and --json", async () => {
    const rows: [string, string[], string][] = [
      ["add-link", ["--id", "work", `--url=${GOOGLE}`], "unexpected argument --url"],
      ["add-link", ["--id", "work", `--URL=${OTHER}`], "unexpected argument --URL"],
      ["remove-link", ["--id", "work", `--url=${GOOGLE}`], "unexpected argument --url"],
      ["remove-link", [`--${GOOGLE}`], "unexpected argument --[link removed]"],
      ["add-link", [`--url=webcal://cal.example/${SECRET}/x.ics`, "--id", "work"], "unexpected argument --url"],
    ];
    for (const [verb, args, shown] of rows) {
      for (const json of [false, true]) {
        const s = setup(BASE);
        expect(await calendarMain([verb, ...args, ...(json ? ["--json"] : [])], s.deps())).toBe(2);
        expect(s.err.join("\n")).toContain(shown);
        if (json) expect(JSON.parse(s.out.at(-1)!).error).toContain(shown);
        expect(`${verb} ${json}: ${s.all()}`).not.toContain(SECRET);
        // Final harden r2: the EXACT echo — the flag's name and nothing after it. `toContain(shown)` alone would pass
        // `unexpected argument --url=<anything>`; no `=` (the value's start) may follow, in either stream.
        const line = s.err.find((l) => l.includes(shown))!;
        expect(line.slice(line.indexOf(shown))).toBe(shown);
        expect(s.err.join("\n")).not.toContain("=");
        if (json) expect(JSON.parse(s.out.at(-1)!).error).toBe(`${verb}: ${shown}`);
      }
    }
  });

  test("the writer's rules: id grammar, `macos` reserved, ≤10 links, a urlEnv link, no config, Windows", async () => {
    const s = setup(BASE);
    for (const id of ["macos", "Home", "-x", "a".repeat(33)]) {
      s.lines.push(OTHER);
      expect(`${id}: ${await calendarMain(["add-link", "--id", id], s.deps())}`).toBe(`${id}: 2`);
    }
    const full = setup({ ...BASE, calendar: { enabled: true, links: Array.from({ length: 10 }, (_, i) => ({ id: `l${i}`, urlEnv: "X" })) } });
    full.lines.push(OTHER);
    expect(await calendarMain(["add-link", "--id", "eleven"], full.deps())).toBe(2);
    expect(full.err.join("\n")).toContain("at most 10");
    full.lines.push(OTHER);
    expect(await calendarMain(["add-link", "--id", "l3"], full.deps())).toBe(2);
    expect(full.err.join("\n")).toContain("urlEnv or urlCommand");
    const none = setup();
    none.lines.push(OTHER);
    expect(await calendarMain(["add-link", "--id", "home"], none.deps())).toBe(2);
    expect(none.err.join("\n")).toContain("init");
    const win = setup(BASE);
    win.lines.push(OTHER);
    expect(await calendarMain(["add-link", "--id", "home"], win.deps({ platform: "win32" }))).toBe(2);
    expect(win.err.join("\n")).toContain("urlEnv");
    expect(await writeManagedLinkFile(win.stateDir, "home", OTHER, "win32")).toBe("unsupported-platform");
    expect([s.all(), full.all(), none.all(), win.all()].join("\n")).not.toContain(SECRET);
  });

  test("a symlinked links folder is refused; a too-open one is tightened", async () => {
    const s = setup(BASE);
    const { symlinkSync } = await import("node:fs");
    mkdirSync(join(s.stateDir, "calendar"), { mode: 0o700 });
    const elsewhere = join(s.root, "elsewhere"); mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(s.stateDir, "calendar", "links"));
    expect(await writeManagedLinkFile(s.stateDir, "home", OTHER, "linux")).toBe("dir-symlink");
    expect(readdirSync(elsewhere)).toEqual([]);
    const t = setup(BASE);
    mkdirSync(join(t.stateDir, "calendar", "links"), { recursive: true });
    chmodSync(join(t.stateDir, "calendar", "links"), 0o755);
    expect(await writeManagedLinkFile(t.stateDir, "home", OTHER, "linux")).toBe("ok");
    expect(statSync(join(t.stateDir, "calendar", "links")).mode & 0o777).toBe(0o700);
  });
});

describe("calendar remove-link, list, status, test, connect mac", () => {
  test("remove-link removes the entry and the file; again, it reports nothing to remove", async () => {
    const s = setup(BASE);
    s.lines.push(OTHER);
    await calendarMain(["add-link", "--id", "work"], s.deps());
    expect(await calendarMain(["remove-link", "--id", "work", "--json"], s.deps())).toBe(0);
    expect(JSON.parse(s.out.at(-1)!)).toEqual({ schemaVersion: 1, id: "work", removed: { config: true, file: true } });
    expect(s.cfg().calendar.links).toEqual([]);
    expect(existsSync(calendarLinkFilePath(s.stateDir, "work"))).toBe(false);
    expect(await calendarMain(["remove-link", "--id", "work"], s.deps())).toBe(1);
  });

  test("list --json: the amended CalendarLinkInfo — owners reported apart, a stale confirmation null, names scrubbed, file status", async () => {
    const s = setup({ ...BASE, calendar: { enabled: true, links: [
      { id: "home", name: "calendar.google.com/calendar/ical/x/basic.ics", confirmedOwner: "old@personal.example" },
      { id: "work", owner: "me@work.example", urlCommand: ["pass", "show", "cal"] },
      { id: "team", urlEnv: "TEAM_URL" },
      { id: "trip" },
    ] } });
    expect(await writeManagedLinkFile(s.stateDir, "home", GOOGLE, "linux")).toBe("ok");
    expect(await writeManagedLinkFile(s.stateDir, "trip", OTHER, "linux")).toBe("ok");
    chmodSync(calendarLinkFilePath(s.stateDir, "trip"), 0o644);
    let commandRan = false;
    expect(await calendarMain(["list", "--json"], s.deps({ env: { TEAM_URL: OTHER }, exec: async () => { commandRan = true; throw new Error("no"); } }))).toBe(0);
    const j = JSON.parse(s.out.at(-1)!) as CalendarListJson;
    expect(commandRan).toBe(false);
    expect(j.macos).toBeNull();
    expect(j.links).toEqual([
      { id: "home", name: "[link removed]", urlPathOwner: "me@personal.example", confirmedOwner: null, urlFrom: "file", fileStatus: "ok" },
      { id: "work", configuredOwner: "me@work.example", confirmedOwner: null, urlFrom: "command" },
      { id: "team", confirmedOwner: null, urlFrom: "env" },
      { id: "trip", confirmedOwner: null, urlFrom: "file", fileStatus: "refused", fileReason: "file-permissions" },
    ]);
    expect(s.all()).not.toContain(SECRET);
    expect(await calendarMain(["list"], s.deps({ platform: "darwin", osRelease: "24.0.0" }))).toBe(0);
    expect(s.out.join("\n")).toContain("Mac Calendar: the calendar reader is not installed");
  });

  test("status --json: the last SCHEDULED read with its reason; a manual read does not count; config warnings fixed text", async () => {
    const s = setup({ ...BASE, calendar: { enabled: true, links: [{ id: "work", name: "Work" }, { id: "team", url: OTHER }, { id: "home" }] } });
    await writeCalendarHealth(s.stateDir, { at: "2026-10-14T07:21:09.000Z", trigger: "scheduled", sources: [{ id: "work", kind: "link", status: "link-refused", reason: "http-refused" }] });
    await writeCalendarHealth(s.stateDir, { at: "2026-10-14T09:00:00.000Z", trigger: "manual", sources: [{ id: "work", kind: "link", status: "ok" }, { id: "home", kind: "link", status: "ok" }] });
    expect(await calendarMain(["status", "--json"], s.deps())).toBe(0);
    const j = JSON.parse(s.out.at(-1)!) as CalendarStatusJson;
    // `s.deps()` is linux: no Mac Calendar there (wave-2 polish §4, "The engine change").
    expect(j).toEqual({ schemaVersion: 1, enabled: true, enabledSet: true, macSupported: false, configWarnings: [CALENDAR_CONFIG_WARNINGS.literalUrl], sources: [
      { id: "work", kind: "link", name: "Work", lastScheduledRead: { at: "2026-10-14T07:21:09.000Z", status: "link-refused", reason: "http-refused" } },
      { id: "home", kind: "link", lastScheduledRead: null },
    ] });
    expect(s.all()).not.toContain(SECRET);
  });

  // Wave-2 polish §4 "The engine change": `macSupported` is darwin AND macOS 14+ (Darwin 23), the pairing
  // `calendar connect mac` uses — the platform and the kernel release both reach it from the CLI's deps.
  test("status --json: macSupported is darwin with macOS 14 or later (the connect-mac pairing), from the injected release", async () => {
    const s = setup({ ...BASE, calendar: { enabled: true, links: [] } });
    const cases: [NodeJS.Platform, string, boolean][] = [
      ["darwin", "23.0.0", true], ["darwin", "24.6.0", true], ["darwin", "22.6.0", false], ["darwin", "x", false], ["linux", "23.0.0", false],
    ];
    for (const [platform, osRelease, want] of cases) {
      expect(await calendarMain(["status", "--json"], s.deps({ platform, osRelease }))).toBe(0);
      const j = JSON.parse(s.out.at(-1)!) as CalendarStatusJson;
      expect(`${platform} ${osRelease}: ${j.macSupported}`).toBe(`${platform} ${osRelease}: ${want}`);
    }
  });

  // `enabled` alone cannot tell "never asked" from "off": an absent block, `{}`, `enabled: null` and
  // `enabled: false` all resolve to `enabled: false`. `enabledSet` is true only for an own, non-null `enabled`
  // (config.ts's `own()` rule).
  test("status --json: enabledSet tells a set `enabled` (true or false) from no block, no key, or null", async () => {
    const cases: [string, unknown, boolean, boolean][] = [
      ["no block", undefined, false, false],
      ["{}", {}, false, false],
      ["enabled: null", { enabled: null }, false, false],
      ["enabled: false", { enabled: false }, false, true],
      ["enabled: true", { enabled: true }, true, true],
    ];
    for (const [label, calendar, enabled, enabledSet] of cases) {
      const s = setup(calendar === undefined ? BASE : { ...BASE, calendar });
      expect(await calendarMain(["status", "--json"], s.deps())).toBe(0);
      const j = JSON.parse(s.out.at(-1)!) as CalendarStatusJson;
      expect(`${label}: ${j.enabled} ${j.enabledSet}`).toBe(`${label}: ${enabled} ${enabledSet}`);
    }
  });

  test("calendarStatus: enabledSet reads `enabled` by descriptor — an accessor is never invoked and is not a set value", async () => {
    const s = setup(BASE);
    let invoked = 0;
    const accessor = Object.defineProperty({}, "enabled", { enumerable: true, get: () => { invoked++; return true; } });
    for (const [label, raw, want] of [
      ["accessor", accessor, false], ["array", [], false], ["string", "yes", false], ["null", null, false],
      ["a non-boolean value is still set (own()'s rule)", { enabled: "yes" }, true],
    ] as const) {
      const j = await calendarStatus(raw, s.stateDir, { platform: "linux" });
      expect(`${label}: ${j.enabledSet}`).toBe(`${label}: ${want}`);
    }
    expect(invoked).toBe(0);
  });

  // "Never throws" holds for a hostile value too: resolveCalendar already degrades a throwing Proxy to off
  // (config.ts's catch), so enabledIsSet's inspection must not reject the whole status on the same input.
  test("calendarStatus: a value whose inspection throws resolves (enabledSet false), never rejects", async () => {
    const s = setup(BASE);
    const boom = (): never => { throw new Error("trap"); };
    const trapping = new Proxy({}, { getOwnPropertyDescriptor: boom, ownKeys: boom, get: boom, has: boom });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const [label, raw] of [["throwing descriptor trap", trapping], ["revoked proxy", revocable.proxy]] as const) {
      const j = await calendarStatus(raw, s.stateDir, { platform: "linux" });
      expect(`${label}: ${j.enabled} ${j.enabledSet}`).toBe(`${label}: false false`);
    }
  });

  test("health write: an off-vocabulary reason is dropped, the source and its status are kept (integration LOW)", async () => {
    const s = setup({ ...BASE, calendar: { enabled: true, links: [{ id: "work" }] } });
    await writeCalendarHealth(s.stateDir, { at: "2026-10-14T07:21:09.000Z", trigger: "scheduled", sources: [
      { id: "work", kind: "link", status: "link-refused", reason: "Not A Code/../x" },
      { id: "home", kind: "link", status: "timeout", reason: "http-timeout" },
    ] });
    const h = await readCalendarHealth(s.stateDir);
    expect(h.scheduled?.sources).toEqual([
      { id: "work", kind: "link", status: "link-refused" },
      { id: "home", kind: "link", status: "timeout", reason: "http-timeout" },
    ]);
    expect(readFileSync(join(s.stateDir, "calendar", "health.json"), "utf8")).not.toContain("Not A Code");
  });

  test("test --json: a read now, per source, with reason codes; no health record; never the URL", async () => {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const feed = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:a@x", `DTSTART:${day}T100000Z`, `DTEND:${day}T110000Z`, "SUMMARY:Standup", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    const s = setup({ ...BASE, calendar: { enabled: true, links: [{ id: "work", urlEnv: "W" }, { id: "gone", urlEnv: "G" }, { id: "unset", urlEnv: "U" }] } });
    const fetch = async (url: string) => (url === OTHER ? new Response(feed) : new Response("x", { status: 404 }));
    expect(await calendarMain(["test", "--json"], s.deps({ env: { W: OTHER, G: `${OTHER}?gone` }, fetch, parseCommand: JOB_CHILD }))).toBe(0);
    const j = JSON.parse(s.out.at(-1)!) as CalendarTestJson;
    expect(j.sources.map((x) => [x.id, x.status, x.eventsToday, x.reason])).toEqual([
      ["work", "ok", 1, undefined], ["gone", "link-refused", null, "http-refused"], ["unset", "malformed", null, "env-unset"]]);
    expect(j.incomplete).toBe(true);
    expect(existsSync(join(s.stateDir, "calendar", "health.json"))).toBe(false);
    expect(s.all()).not.toContain(SECRET);
  }, 20_000);

  // W3 (M10b) replaced M5's stub; the install and the access request are covered in calendar-mac-source.test.ts.
  test("connect mac with no shipped reader: helper-missing on macOS, unsupported elsewhere, exit 1, nothing installed", async () => {
    const s = setup(BASE);
    expect(await calendarMain(["connect", "mac", "--json"], s.deps({ platform: "darwin", osRelease: "24.0.0", findShippedReader: async () => null }))).toBe(1);
    expect(JSON.parse(s.out.at(-1)!)).toEqual({ schemaVersion: 1, status: "helper-missing" });
    expect(await calendarMain(["connect", "mac", "--json"], s.deps())).toBe(1);
    expect(JSON.parse(s.out.at(-1)!)).toEqual({ schemaVersion: 1, status: "unsupported-os" });
    expect(readdirSync(s.stateDir)).toEqual([]);
  });

  test("usage errors exit 2: no verb, an unknown verb, --json-out, a stray argument", async () => {
    const s = setup(BASE);
    for (const args of [[], ["sync"], ["list", "--json-out", "x"], ["status", "extra"], ["connect", "google"], ["add-link"]]) {
      expect(`${args.join(" ")} → ${await calendarMain(args, s.deps())}`).toBe(`${args.join(" ")} → 2`);
    }
  });
});

describe("dispatch, status --json, doctor --json, config validate", () => {
  test("`calendar` routes to the CLI, is a KNOWN command (never swallowed into a run), and is in --help", async () => {
    let routed: string[] | undefined, ran = 0;
    const deps = { calendarCli: async (a: string[]) => { routed = a; return 0; }, run: async () => { ran++; return 0; } };
    const out: string[] = [], err: string[] = [];
    const oLog = console.log, oErr = console.error;
    console.log = (...a: unknown[]) => { out.push(a.join(" ")); }; console.error = (...a: unknown[]) => { err.push(a.join(" ")); };
    try {
      expect(await dispatch(["bun", "bin", "calendar", "status", "--json"], deps)).toBe(0);
      expect(routed).toEqual(["status", "--json"]);
      for (const argv of [["--json", "calendar", "status"], ["run", "calendar"]]) expect(await dispatch(["bun", "bin", ...argv], deps)).toBe(2);
      expect(ran).toBe(0);
      expect(await dispatch(["bun", "bin", "--help"], deps)).toBe(0);
      expect(out.join("\n")).toContain("daily-briefing calendar connect mac | add-link");
    } finally { console.log = oLog; console.error = oErr; }
  });

  function withEnv(cfg: string) {
    const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-calcli-env-")));
    mkdirSync(join(root, "cfg", "daily-briefing"), { recursive: true });
    writeFileSync(join(root, "cfg", "daily-briefing", "config.json"), cfg);
    const prev = [process.env.XDG_CONFIG_HOME, process.env.DAILY_BRIEFING_STATE_DIR];
    process.env.XDG_CONFIG_HOME = join(root, "cfg");
    process.env.DAILY_BRIEFING_STATE_DIR = join(root, "state");
    mkdirSync(join(root, "state"));
    return { state: join(root, "state"), restore: () => {
      if (prev[0] === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev[0];
      if (prev[1] === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prev[1];
    } };
  }

  test("status --json: configError passes the calendar link scrub; the calendar block only when a block exists", async () => {
    // A validation error that QUOTES the offending value (config.ts's `lookbackCapDays` message) — the shape that
    // would carry a pasted link into `configError` without the scrub.
    const broken = withEnv(JSON.stringify({ ...BASE, lookbackCapDays: OTHER }));
    try {
      const r = await statusReport();
      expect(r.configError).toContain("lookbackCapDays");
      expect(r.configError).toContain("[link removed]");
      expect(r.configError!).not.toContain(SECRET);
    } finally { broken.restore(); }
    const plain = withEnv(JSON.stringify(BASE));
    try { expect("calendar" in (await statusReport())).toBe(false); } finally { plain.restore(); }
    const on = withEnv(JSON.stringify({ ...BASE, calendar: { enabled: true, links: [{ id: "work", name: "Work" }] } }));
    try {
      await writeCalendarHealth(on.state, { at: "2026-10-14T07:21:09.000Z", trigger: "scheduled", sources: [{ id: "work", kind: "link", status: "ok" }] });
      // `status --json` reports THIS machine (it passes no platform or release), so `macSupported` is the host's.
      expect((await statusReport()).calendar).toEqual({ enabled: true, enabledSet: true, macSupported: HOST_MAC_SUPPORTED, configWarnings: [], sources: [
        { id: "work", kind: "link", name: "Work", lastScheduledRead: { at: "2026-10-14T07:21:09.000Z", status: "ok" } }] });
    } finally { on.restore(); }
  });

  test("config validate and doctor report the calendar config warnings; doctor carries the block and makes no calendar call", async () => {
    const v = validateCandidate({ ...BASE, calendar: { enabled: "yes" } });
    expect(v.warnings).toContainEqual({ field: "calendar", message: CALENDAR_CONFIG_WARNINGS.enabled });
    expect(validateCandidate(BASE).warnings.some((w) => w.field === "calendar")).toBe(false);
    const env = withEnv(JSON.stringify({ ...BASE, calendar: { enabled: true, links: [{ id: "work", url: OTHER }] } }));
    try {
      const d = await doctorReport({
        preflight: async () => [], discover: async () => ({ repos: [], issues: [] }), which: async () => "/bin/claude",
        capabilities: async () => ({ hardeningAvailable: true, flags: [], anomalies: [] }) as never,
        netProbe: async () => true, powerPlatform: "linux", partialClone: async () => false,
      });
      expect(d.config.warnings).toContainEqual({ field: "calendar", message: CALENDAR_CONFIG_WARNINGS.literalUrl });
      expect(d.calendar).toEqual({ enabled: true, enabledSet: true, macSupported: HOST_MAC_SUPPORTED, configWarnings: [CALENDAR_CONFIG_WARNINGS.literalUrl], sources: [] });
      expect(JSON.stringify(d)).not.toContain(SECRET);
    } finally { env.restore(); }
  });

  test("config validate: a literal calendar url — any case, anywhere in the block — is an ERROR and is in no output", () => {
    const blocks: unknown[] = [
      { enabled: true, links: [{ id: "work", url: GOOGLE }] },
      { enabled: true, links: [{ id: "work", URL: GOOGLE }] },
      { enabled: true, links: [{ id: "work", Url: OTHER, name: "Work" }] },
      { enabled: true, url: GOOGLE },
      { enabled: true, macos: { calendars: [{ id: "a", title: "t", account: "x", url: OTHER }] } },
      { enabled: true, links: [{ id: "work" }, { id: "x", nested: { deeper: [{ uRl: GOOGLE }] } }] },
      // Final harden r2: a URL-shaped urlCommand argument is the same secret in another field…
      { enabled: true, links: [{ id: "work", urlCommand: ["echo", GOOGLE] }] },
      { enabled: true, links: [{ id: "work", urlCommand: ["printf", "%s", GOOGLE.replace(/\//g, "\\/")] }] },
      // …and a `url` nested past the old 16-level walk (which answered "no" below it) is still found.
      { enabled: true, macos: Array.from({ length: 40 }).reduce<unknown>((inner) => [inner], { url: GOOGLE }) },
    ];
    for (const calendar of blocks) {
      const v = validateCandidate({ ...BASE, calendar }, "/home/me", {});
      expect(v.valid).toBe(false);
      expect(v.errors.map((e) => e.field)).toContain("calendar");
      expect(v.normalized).toBeNull();
      expect(JSON.stringify(v)).not.toContain(SECRET);
    }
    // Final harden r2: a note that would QUOTE the address is scrubbed — the regex warning echoes its pattern, and
    // the pattern here is the link (redactCredentials alone does not know calendar links).
    const echoing = validateCandidate({ ...BASE, excludeCommitPatterns: [`(${GOOGLE}`], calendar: { links: [{ id: "w", url: GOOGLE }] } }, "/home/me", {});
    expect(echoing.valid).toBe(false);
    expect(echoing.warnings.some((w) => w.field === "excludeCommitPatterns" && w.message.includes("[link removed]"))).toBe(true);
    expect(JSON.stringify(echoing)).not.toContain(SECRET);
    expect(JSON.stringify(echoing)).not.toContain("calendar.google.com/calendar");
    // Not a url field: urlEnv / urlCommand stay valid.
    const ok = validateCandidate({ ...BASE, calendar: { enabled: true, links: [{ id: "work", urlEnv: "W" }, { id: "t", urlCommand: ["pass", "cal"] }, { id: "op", urlCommand: ["op", "read", "op://Private/cal/url"] }] } }, "/home/me", {});
    expect(ok.valid).toBe(true);
    expect(ok.normalized).not.toBeNull();
  });
});
