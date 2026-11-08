/**
 * v0.3.0 (calendar connection, plan M9) — the desktop app's calendar half: the GUI mirror of the
 * briefing's calendar section, the History view's section-bounded recognition, Settings → Calendar's
 * model and flows, the optional wizard step, and the wording.
 *
 * ⚠ THE GOLDEN FOR THE SECTION IS M0'S FROZEN FIXTURE, READ FROM THE ENGINE'S OWN TEST FOLDER —
 * `test/fixtures/calendar/rendered-section.txt` with its typed sources (`contract.ts`). Nothing is
 * copied: if the fixture changes (a decision recorded with the hub), this file reads the new bytes.
 * The engine's `renderBriefing` gains the section in W1's M4; both must reproduce these bytes.
 *
 * ⚠ TIMES RENDER IN THE LOCAL ZONE, as the engine's do, so these tests need UTC — `bun test`'s default
 * zone, which the fixture was written for. The first test refuses to run the rest in any other zone.
 *
 * ⚠ THE URL SENTINEL. A calendar link's URL is a secret (spec r4 §2): [`SENTINEL_URL`] is driven
 * through the add flow, and [`SENTINEL`] must reach `writeLink` and nothing else — no saved block, no
 * result, no other call, no message. Assertions never print a value that may hold it.
 */
import { describe, expect, test } from "bun:test";
import { afterEach, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "svelte/server";

import * as engineContract from "../../src/calendar/render-contract";
import { CALENDAR_CONFIG_WARNINGS, CALENDAR_LITERAL_URL_ERROR, calendarBlockHasLiteralUrl, resolveCalendar } from "../../src/calendar/config";
import { renderBriefing, renderCalendarSection } from "../../src/render";
import type { BriefingStruct as EngineStruct } from "../../src/types";
import {
  LIST_JSON_PATH,
  readSectionFixture,
  SECTION_FIXTURE_PATH,
  SECTION_SOURCES,
  STATUS_JSON_PATH,
  TEST_JSON_PATH,
} from "../../test/fixtures/calendar/contract";

import BriefingView from "../src/lib/BriefingView.svelte";
import CalendarSettings from "../src/lib/CalendarSettings.svelte";
import { blockText, classifyLine, renderMarkdown, type Block } from "../src/lib/briefing-md";
import { calendarSectionLines, renderStruct, type BriefingStruct } from "../src/lib/briefing-struct";
import * as guiContract from "../src/lib/calendar-contract";
import type { CalendarListJson, CalendarReadStatus, CalendarStatusJson, CalendarStatusSource, CalendarStruct } from "../src/lib/calendar-contract";
import { CALENDAR_STATUS_TEXT } from "../src/lib/calendar-contract";
import {
  addLink,
  calendarBlockOf,
  calendarStatusOk,
  CONFIG_OFF_SUFFIX,
  configWarningLines,
  confirmOwner,
  editBlock,
  fileProblem,
  lastReadLine,
  LINK_SECRET_NOTE,
  linkSourceTag,
  MAC_CALENDAR_AVAILABLE,
  connectMacMessage,
  macSectionShown,
  macSourceTag,
  needsAddress,
  nextOpenRows,
  noAnswer,
  overlapHints,
  ownerPrompt,
  parseList,
  parseStatus,
  parseTest,
  PROVIDERS,
  REASON_TEXT,
  reasonText,
  redactLinks,
  statusSentence,
  suggestId,
  testLine,
  withConfirmedOwner,
  withEnabled,
  withLinkEntry,
  withMacCalendars,
  withMacos,
  withOwner,
  type CalendarBlock,
  type CalendarDeps,
} from "../src/lib/calendar-settings";
import * as calModel from "../src/lib/calendar-settings";
import type { LinkWritten } from "../src/lib/calendar";
import type { EngineOutcome } from "../src/lib/engine";
import { describeFailure, type ConfigDocument, type SaveOutcome } from "../src/lib/files";
import { CALENDAR_LINKS_CLAUSE, consentLabel, type UninstallPreview } from "../src/lib/app-uninstall";
import { cancelWritesNothing, nextStep, previousStep, stepHeading, STEP_ORDER } from "../src/lib/wizard";
import { engineNotifyLine } from "../src/lib/notify";
import { calendarConfigSave } from "../src/lib/calendar";
import { calendarStatus } from "../src/lib/engine";
import { configRead } from "../src/lib/files";
import { readStatusThroughStore, resetTodayStoreForTests, storeSaveBlock, todayStore } from "../src/lib/today-store";

// PB-M3-T2 / plan §0.6: this file drives a Settings write through mocked invoke, so every test starts from a fresh
// store and ends with no write in flight and no flow running.
beforeEach(() => {
  resetTodayStoreForTests();
});
afterEach(() => {
  expect(todayStore().writesInFlight).toBe(0);
  expect(todayStore().flow.running).toBeNull();
});

const SRC = new URL("../src/", import.meta.url).pathname;
const src = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");

/** A private link that must never be echoed. `.invalid` (RFC 2606): nothing here fetches it. */
const SENTINEL_URL = "https://calendar.example.invalid/ical/me%40example.com/private-SENTINEL-c4l-m9/basic.ics";
const SENTINEL = "SENTINEL-c4l-m9";
/** Fails WITHOUT printing `text`, which may hold the sentinel. */
function assertClean(text: string, what: string): void {
  expect({ what, leaked: text.includes(SENTINEL) }).toEqual({ what, leaked: false });
}

/* ── 0. the zone ──────────────────────────────────────────────────────────────────────────────── */

test("these tests run in UTC (bun test's default) — the fixture's times are UTC wall times", () => {
  expect(new Date(Date.UTC(2026, 9, 14, 7, 21)).getHours()).toBe(7);
  expect(new Date(Date.UTC(2026, 0, 14, 7, 21)).getHours()).toBe(7);
});

/* ── final harden r3: a span across a DST change renders as the engine's does — never backwards ── */

describe("final harden r3: the GUI's DST span is the engine's (America/Los_Angeles)", () => {
  test("01:45 PDT → 01:15 PST reads `01:45–01:15 (clocks go back)`, byte-equal to the engine's section", () => {
    const at = (f: string) => JSON.stringify(new URL(f, import.meta.url).pathname);
    const code = `
const { calendarSectionLines } = await import(${at("../src/lib/briefing-struct.ts")});
const { renderCalendarSection } = await import(${at("../../src/render.ts")});
const ev = (s, e, title) => ({ time: { kind: "timed", startMs: Date.parse(s), endMs: Date.parse(e) }, title, status: "confirmed", transparency: "busy", attendeeCount: 0 });
const cal = { events: [ev("2026-11-01T08:45:00Z", "2026-11-01T09:15:00Z", "Repeat"), ev("2026-11-01T18:00:00Z", "2026-11-01T19:00:00Z", "Plain"),
  ev("2026-10-31T23:00:00Z", "2026-11-02T10:00:00Z", "Trip")], sources: [{ id: "work", kind: "link", status: "ok" }], incomplete: false };
console.log(JSON.stringify({ gui: calendarSectionLines("2026-11-01", cal), engine: renderCalendarSection(cal, "2026-11-01") }));`;
    const r = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, TZ: "America/Los_Angeles" } });
    expect(r.exitCode).toBe(0);
    const { gui, engine } = JSON.parse(r.stdout.toString()) as { gui: string[]; engine: string[] };
    expect(gui).toEqual(engine);
    expect(gui).toContain("   ◦ 01:45–01:15 (clocks go back)  Repeat");
    expect(gui).toContain("   ◦ 10:00–11:00  Plain");
    expect(gui.join("\n")).not.toMatch(/01:45–01:15(?! \(clocks go back\))/);
  });
});

/* ── 1. the mirror is the engine's contract ───────────────────────────────────────────────────── */

describe("the GUI's calendar contract is the engine's render contract", () => {
  test("every constant and every status sentence, deep-equal", () => {
    expect(guiContract.CALENDAR_HEADING).toBe(engineContract.CALENDAR_HEADING);
    expect(guiContract.CALENDAR_INCOMPLETE_SUFFIX).toBe(engineContract.CALENDAR_INCOMPLETE_SUFFIX);
    expect(guiContract.CALENDAR_LINE_PREFIX).toBe(engineContract.CALENDAR_LINE_PREFIX);
    expect(guiContract.CALENDAR_MAX_EVENT_LINES).toBe(engineContract.CALENDAR_MAX_EVENT_LINES);
    expect(guiContract.CALENDAR_MACOS_SOURCE_ID).toBe(engineContract.CALENDAR_MACOS_SOURCE_ID);
    expect(guiContract.CALENDAR_MACOS_LABEL).toBe(engineContract.CALENDAR_MACOS_LABEL);
    expect(guiContract.CALENDAR_UNAVAILABLE_TEXT).toBe(engineContract.CALENDAR_UNAVAILABLE_TEXT);
    expect(guiContract.CALENDAR_NO_EVENTS_TEXT).toBe(engineContract.CALENDAR_NO_EVENTS_TEXT);
    expect(guiContract.CALENDAR_NOT_CONNECTED_TEXT).toBe(engineContract.CALENDAR_NOT_CONNECTED_TEXT);
    expect(guiContract.CALENDAR_UNTITLED_TEXT).toBe(engineContract.CALENDAR_UNTITLED_TEXT);
    expect(guiContract.CALENDAR_STATUS_TEXT).toEqual(engineContract.CALENDAR_STATUS_TEXT);
    expect(guiContract.CALENDAR_CLOCKS_BACK_TEXT).toBe(engineContract.CALENDAR_CLOCKS_BACK_TEXT);
    expect(guiContract.CALENDAR_CLOCKS_FORWARD_TEXT).toBe(engineContract.CALENDAR_CLOCKS_FORWARD_TEXT);
    // Every export of the engine's module is mirrored (a new one fails here until it is).
    for (const name of Object.keys(engineContract)) {
      expect({ name, mirrored: name in guiContract }).toEqual({ name, mirrored: true });
    }
  });

  test("isCalendarHeading is the engine's predicate, on both headings and the near misses", () => {
    for (const line of [
      "▶ Today's calendar",
      "▶ Today's calendar (incomplete)",
      "▶ Today's calendar\r",
      "▶ Today so far",
      "▶ Suggested next",
      "  ▶ Today's calendar",
      "Today's calendar",
      "   ◦ Today's calendar",
      "",
    ]) {
      expect({ line, gui: guiContract.isCalendarHeading(line) }).toEqual({ line, gui: engineContract.isCalendarHeading(line) });
    }
    expect(guiContract.isCalendarHeading("▶ Today's calendar (incomplete)")).toBe(true);
  });
});

/* ── 2. the section renders M0's frozen bytes ─────────────────────────────────────────────────── */

describe("the section mirror reproduces the frozen fixture byte for byte", () => {
  const fixture = readSectionFixture();

  test("the fixture is the engine's file, with its five variants", () => {
    // The engine's own file, located from this test rather than by the monorepo folder name: the public
    // repo has no `daily_briefing_application/` level, and the old suffix check failed there (v0.3.0 dry run).
    expect(SECTION_FIXTURE_PATH).toBe(join(import.meta.dir, "..", "..", "test", "fixtures", "calendar", "rendered-section.txt"));
    expect([...fixture.keys()]).toEqual(["full-day", "busy-day", "unavailable", "quiet", "no-sources", "merged"]);
    expect(SECTION_SOURCES.map((s) => s.name)).toEqual(["full-day", "busy-day", "unavailable", "quiet", "no-sources", "merged"]);
  });

  for (const source of SECTION_SOURCES) {
    test(`calendarSectionLines: ${source.name}`, () => {
      const expected = fixture.get(source.name);
      expect(expected).toBeDefined();
      expect(calendarSectionLines(source.date, source.calendar as CalendarStruct)).toEqual(expected!);
      // …and as bytes: joined, the variant is exactly its text in the file.
      const text = readFileSync(SECTION_FIXTURE_PATH, "utf8");
      expect(text).toContain(`@@ ${source.name}\n${calendarSectionLines(source.date, source.calendar as CalendarStruct).join("\n")}\n`);
    });
  }

  test("the engine's renderCalendarSection and the mirror agree on every variant", () => {
    for (const source of SECTION_SOURCES) {
      expect({ name: source.name, lines: calendarSectionLines(source.date, source.calendar as CalendarStruct) })
        .toEqual({ name: source.name, lines: renderCalendarSection(source.calendar, source.date) });
    }
  });

  test("every line kind of the full day is exercised (not vacuous)", () => {
    const lines = fixture.get("full-day")!.join("\n");
    for (const kind of ["(incomplete)", "all day — ", "since Oct 12 → ", "since yesterday → ", " · tentative", " · ended", "time unclear (", "(no title)", "–24:00", " tomorrow  ", "22:00 → Oct 16 18:00", "12:00  Submit timesheet"]) {
      expect({ kind, present: lines.includes(kind) }).toEqual({ kind, present: true });
    }
    expect(fixture.get("busy-day")!.at(-1)).toBe("   ◦ +3 more");
  });

  test("control bytes in a title are stripped, like every other rendered line", () => {
    const cal: CalendarStruct = {
      events: [{ time: { kind: "allDay", startDate: "2026-10-14", endDateExclusive: "2026-10-15" }, title: `Off\u001b[31msite\u0007`, status: "confirmed", transparency: "busy", attendeeCount: 1 }],
      sources: [{ id: "home", kind: "link", status: "ok" }],
      incomplete: false,
    };
    expect(calendarSectionLines("2026-10-14", cal)).toEqual(["▶ Today's calendar", "   ◦ all day — Off[31msite"]);
  });

  test("renderStruct places the section after Today so far and before Suggested next, as heading + calendar blocks", () => {
    const full = SECTION_SOURCES.find((s) => s.name === "full-day")!;
    const struct: BriefingStruct = {
      date: full.date,
      machineScope: "mac",
      provider: "claude",
      resume: [],
      recap: [],
      today: [{ repo: "app", text: "wip" }],
      suggestions: [{ text: "pick a small task before lunch" }],
      calendar: full.calendar as CalendarStruct,
    };
    const blocks = renderStruct(struct);
    const headings = blocks.filter((b) => b.kind === "heading").map(blockText);
    expect(headings).toEqual(["Where you left off", "What you did", "Today so far", "Today's calendar (incomplete)", "Suggested next"]);
    const section = fixture.get("full-day")!;
    expect(blocks.filter((b) => b.kind === "calendar").map(blockText)).toEqual(section.slice(1).map((l) => l.slice("   ◦ ".length)));
    // Without `calendar`, nothing changes: no heading, no calendar block.
    const { calendar: _gone, ...off } = struct;
    void _gone;
    expect(renderStruct(off).some((b) => b.kind === "calendar" || blockText(b).startsWith("Today's calendar"))).toBe(false);
  });
});

/* ── 2b. the app's block check never saves a block the engine switches off ────────────────────── */

// M8 note: `check_calendar_block` (gui/src-tauri/src/calendar.rs) is a transcription of the engine's
// all-or-nothing resolver. The Rust suite replays the SAME fixture through the check; here every case
// goes through the real `resolveCalendar`, so a block the app saves is never one the engine turns off.
describe("the Rust block check's fixture, through the engine's resolveCalendar", () => {
  type Refusal = { block: unknown; kind: string; engine: "off" | "skip" };
  const fixture = JSON.parse(readFileSync(new URL("../src-tauri/tests/fixtures/calendar_block_cases.json", import.meta.url), "utf8")) as
    { accept: Record<string, unknown>[]; refuse: Refusal[] };
  const malformations = new Set<string>(Object.entries(CALENDAR_CONFIG_WARNINGS)
    .filter(([k]) => k !== "literalUrl" && k !== "macosNotHere").map(([, w]) => w));

  test("every block the app admits resolves with no malformation and every link kept", () => {
    expect(fixture.accept.length).toBeGreaterThanOrEqual(9);
    for (const block of fixture.accept) {
      const r = resolveCalendar(block, { platform: "darwin" });
      const links = Array.isArray(block.links) ? block.links.length : 0;
      expect({ block, warnings: r.warnings, enabled: r.enabled, links: r.links.length })
        .toEqual({ block, warnings: [], enabled: block.enabled === true, links });
    }
  });

  test("every block the app refuses is one the engine switches off, or (the url guard) skips the link of", () => {
    expect(fixture.refuse.length).toBeGreaterThanOrEqual(59);
    for (const { block, kind, engine } of fixture.refuse) {
      const r = resolveCalendar(block, { platform: "darwin" });
      const got = r.warnings.length === 1 && malformations.has(r.warnings[0]!) && !r.enabled && r.links.length === 0 ? "off"
        : r.warnings.includes(CALENDAR_CONFIG_WARNINGS.literalUrl) ? "skip" : "admitted";
      expect({ kind, block, engine: got }).toEqual({ kind, block, engine });
    }
  });
});

/* ── 2c. final harden r2: the desktop's pre-staging refusal is the engine's own ERROR ──────────── */

describe("the generic save's calendar-secret refusal agrees with `config validate`", () => {
  test("CALENDAR_SECRET_ERROR (config_save.rs) is CALENDAR_LITERAL_URL_ERROR, verbatim", () => {
    const rust = readFileSync(new URL("../src-tauri/src/config_save.rs", import.meta.url), "utf8");
    expect(rust).toContain(`pub const CALENDAR_SECRET_ERROR: &str = ${JSON.stringify(CALENDAR_LITERAL_URL_ERROR)};`);
  });

  test("every fixture row the app refuses as urlInConfig is one `config validate` makes an ERROR; no accepted row is", () => {
    const fixture = JSON.parse(readFileSync(new URL("../src-tauri/tests/fixtures/calendar_block_cases.json", import.meta.url), "utf8")) as
      { accept: unknown[]; refuse: { block: unknown; kind: string }[] };
    for (const block of fixture.accept) expect({ block, secret: calendarBlockHasLiteralUrl(block) }).toEqual({ block, secret: false });
    // Final harden r3: EVERY urlInConfig row, `name`/`owner`/`emails` carrying an address included — those used to be
    // refused only by the app's field rule, AFTER the generic save had staged the candidate file.
    const urlRows = fixture.refuse.filter((r) => r.kind === "urlInConfig");
    expect(urlRows.length).toBeGreaterThanOrEqual(20);
    for (const { block, kind } of urlRows) {
      expect({ block, kind, secret: calendarBlockHasLiteralUrl(block) }).toEqual({ block, kind, secret: true });
    }
  });
});

/* ── 3. History: the file view recognises the section ─────────────────────────────────────────── */

/** A page as M4 will write it: the engine's own page for `struct`, with the frozen section inserted
 *  where spec §7 puts it (after "Today so far", before "Suggested next"). */
function pageWith(struct: BriefingStruct, section: string[]): string {
  const page = renderBriefing(struct as EngineStruct);
  const at = page.indexOf("▶ Suggested next");
  expect(at).toBeGreaterThan(0);
  return `${page.slice(0, at)}${section.join("\n")}\n\n${page.slice(at)}`;
}

describe("the History view recognises the calendar section through the mirrored predicate", () => {
  const base: BriefingStruct = {
    date: "2026-10-14",
    machineScope: "mac",
    provider: "claude",
    resume: [],
    recap: [],
    today: [{ repo: "app", text: "wip" }],
    suggestions: [{ text: "pick a small task before lunch" }],
  };

  for (const source of SECTION_SOURCES) {
    test(`a page carrying the ${source.name} section reads back as the struct view draws it`, () => {
      const struct = { ...base, date: source.date, calendar: source.calendar as CalendarStruct };
      const fromFile = renderMarkdown(pageWith(base, readSectionFixture().get(source.name)!));
      const fromStruct = renderStruct(struct);
      expect(fromFile.map((b) => b.kind)).toEqual(fromStruct.map((b) => b.kind));
      expect(fromFile.map(blockText)).toEqual(fromStruct.map(blockText));
      expect(fromFile.filter((b) => b.kind === "calendar").length).toBeGreaterThan(0);
    });
  }

  test("the (incomplete) heading opens the section too, and CRLF is tolerated", () => {
    const blocks = renderMarkdown(["▶ Today's calendar (incomplete)\r", "   ◦ work: did not answer in time\r", "", "▶ Suggested next"].join("\n"));
    expect(blocks.map((b) => [b.kind, blockText(b)])).toEqual([
      ["heading", "Today's calendar (incomplete)"],
      ["calendar", "work: did not answer in time"],
      ["heading", "Suggested next"],
    ]);
  });

  test("the section ends at the next ▶ heading; the same prefix outside it is plain text, as before", () => {
    const page = [
      "▶ Where you left off",
      "   ◦ not a calendar line",
      "▶ Today's calendar",
      "   ◦ 09:00–09:30  Standup",
      "▶ Suggested next",
      "   ◦ not a calendar line either",
    ].join("\n");
    expect(renderMarkdown(page).map((b) => b.kind)).toEqual(["heading", "text", "heading", "calendar", "heading", "text"]);
    // A page with no calendar section classifies exactly as before (the stateless classifier).
    expect(classifyLine("   ◦ not a calendar line")).toEqual({ kind: "text", text: "   ◦ not a calendar line" });
  });

  test("a calendar line is plain text: no inline forms in words other people wrote", () => {
    const blocks = renderMarkdown(["▶ Today's calendar", "   ◦ 09:00–09:30  **Sync** [join](https://evil.example) `x`"].join("\n"));
    const line = blocks[1]!;
    expect(line.kind).toBe("calendar");
    expect(line.spans).toEqual([{ kind: "text", text: "09:00–09:30  **Sync** [join](https://evil.example) `x`" }]);
  });

  test("BriefingView draws calendar lines with their own class, as text", () => {
    const blocks: Block[] = renderMarkdown(pageWith(base, readSectionFixture().get("unavailable")!));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const html = render(BriefingView as any, { props: { blocks } }).body.replace(/<!--[\s\S]*?-->/g, "");
    const drawn = [...html.matchAll(/<p class="b calendar[^"]*" data-block[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
    expect(drawn).toEqual(["Calendar unavailable today", "Mac Calendar: calendar access has not been granted yet — allow it in Settings → Calendar", "work: did not answer in time"]);
    const view = src("lib/BriefingView.svelte");
    expect(view).toContain(".calendar::before");
  });

  test("History renders archives through renderMarkdown, so it inherits the recognition", () => {
    expect(src("routes/History.svelte")).toContain("renderMarkdown(file.text)");
    expect(src("lib/briefing-md.ts")).toContain("inCalendar = isCalendarHeading(line)");
  });
});

/* ── 4. the --json payloads (the hub's contract amendment) ────────────────────────────────────── */

const LIST: CalendarListJson = {
  schemaVersion: 1,
  macos: {
    status: "ok",
    notices: ["helper-outdated"],
    calendars: [
      { id: "A", title: "Home", account: "iCloud", editable: true, type: "standard", selected: true },
      { id: "B", title: "Work", account: "me@personal.example", editable: true, type: "standard", selected: true },
      { id: "C", title: "US Holidays", account: "Subscribed Calendars", editable: false, type: "subscribed", selected: false },
    ],
  },
  links: [
    { id: "home", name: "Home (Google)", urlPathOwner: "me@personal.example", confirmedOwner: null, urlFrom: "file", fileStatus: "ok" },
    { id: "work", name: "Work (Outlook)", configuredOwner: "me@work.example", confirmedOwner: null, urlFrom: "command" },
    { id: "team", confirmedOwner: null, urlFrom: "file", fileStatus: "missing", fileReason: "file-missing" },
    { id: "mine", urlPathOwner: "me@personal.example", confirmedOwner: "me@personal.example", urlFrom: "file", fileStatus: "ok" },
  ],
};

/** Today and yesterday as the component sees them (it formats against the real clock, in UTC here). */
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const STATUS: CalendarStatusJson = {
  schemaVersion: 1,
  enabled: true,
  enabledSet: true,
  macSupported: false,
  configWarnings: [],
  sources: [
    { id: "home", kind: "link", name: "Home (Google)", lastScheduledRead: { at: `${TODAY}T07:21:09.000Z`, status: "ok" } },
    { id: "work", kind: "link", lastScheduledRead: { at: `${YESTERDAY}T07:21:09.000Z`, status: "malformed", reason: "command-exit" } },
    { id: "team", kind: "link", lastScheduledRead: null },
  ],
};
/** `Oct 13`, for `YESTERDAY`. */
const yesterdayLabel = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(YESTERDAY.slice(5, 7)) - 1]} ${Number(YESTERDAY.slice(8, 10))}`;

describe("the payloads are read defensively", () => {
  test("list, status and test round-trip; a non-payload is null", () => {
    expect(parseList(JSON.parse(JSON.stringify(LIST)))).toEqual(LIST);
    expect(parseStatus(JSON.parse(JSON.stringify(STATUS)))).toEqual(STATUS);
    const t = { schemaVersion: 1, ranAt: "2026-10-14T08:45:03.120Z", incomplete: true, sources: [
      { id: "home", kind: "link", status: "ok", eventsToday: 3, durationMs: 412 },
      { id: "team", kind: "link", status: "malformed", eventsToday: null, durationMs: 2, reason: "file-missing" },
    ] };
    expect(parseTest(t)).toEqual(t as never);
    for (const bad of [null, "x", {}, { schemaVersion: 2, links: [] }, { schemaVersion: 1 }]) {
      expect(parseList(bad)).toBeNull();
      expect(parseStatus(bad)).toBeNull();
      expect(parseTest(bad)).toBeNull();
    }
  });

  // M9 checkpoint MED-2: the SEAM itself — the engine's own `calendar … --json` fixtures (the amended shape,
  // `test/fixtures/calendar/*.json`, held in step with `contract.ts` by test/calendar-contract.test.ts) read
  // through the app's parsers. A key the engine emits that a parser drops, renames or misreads fails here.
  test("the engine's list / test / status fixtures parse whole, amended keys included", () => {
    const raw = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
    const list = parseList(raw(LIST_JSON_PATH));
    expect(list).toEqual(raw(LIST_JSON_PATH) as never);
    const byId = new Map(list!.links.map((l) => [l.id, l]));
    expect(byId.get("home")).toMatchObject({ urlPathOwner: "me@example.com", confirmedOwner: "me@example.com", fileStatus: "ok" });
    expect(byId.get("work")).toMatchObject({ configuredOwner: "me@work.example", confirmedOwner: null });
    expect(byId.get("trip")).toMatchObject({ fileStatus: "refused", fileReason: "file-permissions" });
    // Final harden r2: an unexpected read error is `failed`, and the app keeps it (it used to drop the status).
    expect(byId.get("lost")).toMatchObject({ fileStatus: "failed", fileReason: "read-error" });

    const tested = parseTest(raw(TEST_JSON_PATH));
    expect(tested).toEqual(raw(TEST_JSON_PATH) as never);
    expect(tested!.sources.map((x) => [x.id, x.reason ?? null])).toEqual([
      ["macos", null], ["home", null], ["work", "http-refused"], ["team", "unclear-time"],
    ]);

    const status = parseStatus(raw(STATUS_JSON_PATH));
    expect(status).toEqual(raw(STATUS_JSON_PATH) as never);
    expect(status!.sources.map((x) => [x.id, x.lastScheduledRead === null ? null : x.lastScheduledRead.reason ?? "-"])).toEqual([
      ["macos", "-"], ["home", "-"], ["work", "http-refused"], ["team", null],
    ]);
  });

  // Wave-2 polish §4 "The engine change": status gains `macSupported` and `enabledSet`, and parseStatus keeps them.
  // An older engine's reply (neither field) reads as the safe answer: `enabledSet` true, so no question is asked, and
  // `macSupported` false. Only a literal `false` is "never asked"; only a literal `true` is a supported Mac.
  test("status: macSupported and enabledSet are kept; an older reply without them parses safe", () => {
    const base = { schemaVersion: 1, enabled: false, configWarnings: [], sources: [] };
    const both = (p: Record<string, unknown>): [boolean, boolean] | null => {
      const s = parseStatus({ ...base, ...p });
      return s === null ? null : [s.enabledSet, s.macSupported];
    };
    expect(both({ enabledSet: false, macSupported: true })).toEqual([false, true]);
    expect(both({ enabledSet: true, macSupported: false })).toEqual([true, false]);
    expect(both({})).toEqual([true, false]);   // an older engine: never asked about, never offered Mac
    expect(both({ enabledSet: "yes", macSupported: "yes" })).toEqual([true, false]);
    expect(both({ enabledSet: null, macSupported: 1 })).toEqual([true, false]);
    expect(both({ enabledSet: 0 })).toEqual([true, false]);
  });

  test("an entry it cannot read is dropped; unknown statuses and notices are not invented", () => {
    const parsed = parseList({ schemaVersion: 1, macos: { status: "weird", calendars: [] }, links: [
      { id: "ok", urlFrom: "file", confirmedOwner: null, fileStatus: "odd" },
      { id: 7, urlFrom: "file" },
      { id: "x", urlFrom: "carrier-pigeon" },
    ] });
    expect(parsed).toEqual({ schemaVersion: 1, macos: null, links: [{ id: "ok", confirmedOwner: null, urlFrom: "file" }] });
  });
});

/* ── 5. wording ───────────────────────────────────────────────────────────────────────────────── */

describe("the wording", () => {
  test("last scheduled read: not yet / ok at HH:MM / the failure's fixed sentence (local time)", () => {
    expect(lastReadLine(null, "2026-10-14")).toBe("not yet");
    expect(lastReadLine({ at: "2026-10-14T07:21:09.000Z", status: "ok" }, "2026-10-14")).toBe("ok at 07:21");
    expect(lastReadLine({ at: "2026-10-12T07:21:09.000Z", status: "ok" }, "2026-10-14")).toBe("ok on Oct 12 at 07:21");
    expect(lastReadLine({ at: "2026-10-14T07:21:09.000Z", status: "timeout" }, "2026-10-14")).toBe("did not answer in time (07:21)");
    expect(lastReadLine({ at: "2026-10-13T07:21:09.000Z", status: "malformed", reason: "file-missing" }, "2026-10-14"))
      .toBe("the calendar could not be read — its saved address is missing; add the link again (Oct 13, 07:21)");
    // The reason may come on the status entry instead of the read; either is used.
    expect(lastReadLine({ at: "2026-10-14T07:21:09.000Z", status: "malformed" }, "2026-10-14", "env-unset"))
      .toBe("the calendar could not be read — its environment variable is not set (07:21)");
  });

  test("reason codes: every credential-ladder code has words; an unknown code shows as a code; free text never", () => {
    for (const code of ["file-missing", "file-empty", "env-unset", "command-empty", "unsupported-platform", "dir-symlink",
      "dir-not-directory", "dir-owner", "dir-permissions", "file-symlink", "file-not-regular", "file-owner",
      "file-permissions", "file-hardlinked", "too-long", "read-error", "command-not-run", "command-timeout", "command-exit"]) {
      expect({ code, worded: typeof REASON_TEXT[code] === "string" }).toEqual({ code, worded: true });
    }
    expect(reasonText("new-code")).toBe("reason: new-code");
    expect(reasonText(undefined)).toBeNull();
    expect(reasonText(SENTINEL_URL)).toBeNull();
    expect(reasonText("has spaces in it")).toBeNull();
    assertClean(statusSentence("malformed", SENTINEL_URL), "status sentence");
  });

  test("engine stderr is echoed with every URL-shaped run redacted to [link] — before the 600-character cut", () => {
    const answer = (stderr: string): string =>
      noAnswer("calendar list", { operation: "calendar-list", outcome: { kind: "delivered" }, exitCode: 1, payload: null, stdout: "", stderr });
    const shapes = [
      SENTINEL_URL,
      `HTTPS://calendar.example.invalid/${SENTINEL}.ics`,
      `webcal://calendar.example.invalid/${SENTINEL}/basic.ics`,
      `webcals://calendar.example.invalid/${SENTINEL}`,
      `calendar.google.com/calendar/ical/me%40gmail.com/private-${SENTINEL}/basic.ics`,
      `outlook.office365.com/owa/calendar/abc%40contoso.com/${SENTINEL}/calendar.ics`,
      `p12-caldav.icloud.com/published/2/${SENTINEL}`,
      // Final harden r3: the backslash, JSON-escaped and percent-encoded separator spellings.
      `https:\\\\calendar.example.invalid\\${SENTINEL}`,
      `webcal:/\\calendar.example.invalid/${SENTINEL}`,
      `https:\\/\\/calendar.example.invalid\\/${SENTINEL}`,
      `HTTPS%3A%2F%2Fcalendar.example.invalid%2F${SENTINEL}`,
      `https%3A%5C%5Ccalendar.example.invalid%5C${SENTINEL}`,
      // Post-convergence LOW: the MIXED percent-encoded separators every other site already catches.
      `https%3A%2F%5Ccalendar.example.invalid%5C${SENTINEL}`,
      `webcal%3a%5c%2fcalendar.example.invalid%2f${SENTINEL}`,
    ];
    for (const [i, shape] of shapes.entries()) {
      // The whole whitespace-free run goes, the "(" glued to the link with it.
      const text = answer(`error: link "home" could not be read (${shape})\n    at read (cli.ts:1)\n`);
      assertClean(text, `shape ${i}`);
      expect({ i, text: text.includes(SENTINEL) ? "(withheld)" : text }).toEqual({
        i,
        text: 'The engine did not answer calendar list (exit 1).\nerror: link "home" could not be read [link]\n    at read (cli.ts:1)',
      });
    }
    // A URL the cut would split: without redaction the last 600 characters begin past its host and its
    // `calendar/ical/`, so nothing marks the secret tail as a link — it must be redacted FIRST.
    const url = `calendar.google.com/calendar/ical/me%40gmail.com/private-${SENTINEL}/basic.ics`;
    const tail = url.slice(url.indexOf("al/me%40"));
    const long = `error: ${url}\n${"z".repeat(600 - tail.length - 1)}`;
    expect(long.slice(-600).startsWith(tail)).toBe(true);
    assertClean(answer(long), "a URL the 600-character cut splits");
    // Text that is not a link stays: an id, a reason code, the link file's path.
    const plain = 'link "home": file-missing — /home/me/.local/state/daily-briefing/calendar/links/home.url';
    expect(redactLinks(plain)).toBe(plain);
    expect(answer(plain)).toBe(`The engine did not answer calendar list (exit 1).\n${plain}`);
    // Linear time: one 50,000-character run, then a link. (A backtracking regex took 7.3 s here.)
    const started = performance.now();
    assertClean(answer(`${"a".repeat(50_000)} ${SENTINEL_URL}`), "a link after a long run");
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("the reason codes are W1's credential ladder's (read from its commit, not from W1's tree)", () => {
    // `src/calendar/link-url.ts` is W1's (M1); this branch does not carry it, so the table is pinned by
    // the union members its `LinkUrl*Reason` types list, spelled out here.
    expect(Object.keys(REASON_TEXT).sort()).toEqual([
      "command-empty", "command-exit", "command-not-run", "command-timeout", "dir-not-directory", "dir-owner",
      "dir-permissions", "dir-symlink", "env-unset", "file-empty", "file-hardlinked", "file-missing", "file-not-regular",
      "file-owner", "file-permissions", "file-symlink", "read-error", "too-long", "unsupported-platform",
    ]);
  });

  test("Test now's lines and a managed file's problem", () => {
    expect(testLine({ id: "h", kind: "link", status: "ok", eventsToday: 3, durationMs: 1 })).toBe("ok — 3 events today");
    expect(testLine({ id: "h", kind: "link", status: "ok", eventsToday: 1, durationMs: 1 })).toBe("ok — 1 event today");
    expect(testLine({ id: "h", kind: "link", status: "link-refused", eventsToday: null, durationMs: 1 }))
      .toBe("the link was refused — it may have been reset; add it again");
    expect(testLine({ id: "h", kind: "link", status: "incomplete", eventsToday: 2, durationMs: 1 }))
      .toBe("only partly read — some events may be missing (2 events today)");
    expect(fileProblem(LIST.links[2]!)).toBe("its saved address is missing; add the link again");
    expect(fileProblem(LIST.links[0]!)).toBeNull();
    expect(fileProblem({ id: "r", confirmedOwner: null, urlFrom: "file", fileStatus: "refused", fileReason: "file-permissions" }))
      .toBe("its saved address was refused — its saved address can be read by other users");
    expect(fileProblem({ id: "f", confirmedOwner: null, urlFrom: "file", fileStatus: "failed", fileReason: "read-error" }))
      .toBe("the link could not be read");
    expect(fileProblem({ id: "f", confirmedOwner: null, urlFrom: "file", fileStatus: "failed" })).toBe("its saved address could not be read");
  });

  test("every CalendarError variant in calendar.rs has words, and none of them echoes a value it was not given", () => {
    const rust = readFileSync(new URL("../src-tauri/src/calendar.rs", import.meta.url), "utf8");
    const body = /pub enum CalendarError \{([\s\S]*?)\n\}/.exec(rust)?.[1] ?? "";
    const variants = [...body.matchAll(/^    ([A-Z]\w*)\b/gm)].map((m) => m[1] ?? "");
    expect(variants.length).toBe(13);
    for (const v of variants) {
      const kind = v.charAt(0).toLowerCase() + v.slice(1);
      expect({ kind, worded: describeFailure({ kind }) !== JSON.stringify({ kind }) }).toEqual({ kind, worded: true });
    }
    expect(describeFailure({ kind: "invalidUrl", reason: "must start with https:// or webcal://" }))
      .toBe("Not saved: the calendar link must start with https:// or webcal://. Nothing was written.");
    expect(describeFailure({ kind: "invalidId", reason: "is empty" })).toBe("Not saved: the link's short name is empty.");
    expect(describeFailure({ kind: "invalidId", reason: "calendar.links[2].id is missing or not text" }))
      .toBe("Not saved: calendar.links[2].id is missing or not text.");
    expect(describeFailure({ kind: "urlInConfig", field: "links[0].name" })).toContain("links[0].name looks like a calendar link");
    expect(describeFailure({ kind: "config", error: { kind: "conflict", path: "/c/config.json" } }))
      .toBe(describeFailure({ kind: "conflict", path: "/c/config.json" }));
    expect(describeFailure({ kind: "configAfterRemoval", removed: "removed", error: { kind: "noConfig", path: "/c" } }))
      .toContain("The link file was removed, but its entry is still in the config");
    expect(describeFailure({ kind: "configInvalid", errors: [{ field: "calendar", message: "bad" }], warnings: [] }))
      .toContain("(calendar: bad)");
    expect(describeFailure({ kind: "tooManyLinks", limit: 10 })).toBe("Not saved: at most 10 calendar links can be connected.");
  });

  test("the per-provider steps name what spec §8 names, and the paste field says the link is a secret", () => {
    const all = PROVIDERS.map((p) => p.steps.join(" ")).join(" ");
    expect(PROVIDERS.map((p) => p.id)).toEqual(["google", "outlook", "icloud", "other"]);
    expect(all).toContain("Secret address in iCal format");
    expect(all).toContain("ICS link");
    expect(all).toContain("Public Calendar");
    expect(LINK_SECRET_NOTE).toContain("never shows it again");
    expect(LINK_SECRET_NOTE).toContain("reset it");
  });
});

/* ── 6. the owner (spec r4 §4.2) ──────────────────────────────────────────────────────────────── */

describe("the owner confirmation", () => {
  test("a URL-path address unconfirmed → confirm; confirmed only when EQUAL; a configured owner → known; none → ask", () => {
    expect(ownerPrompt(LIST.links[0]!)).toEqual({ kind: "confirm", address: "me@personal.example", yours: null });
    expect(ownerPrompt(LIST.links[3]!)).toEqual({ kind: "known", address: "me@personal.example", confirmed: true });
    expect(ownerPrompt({ ...LIST.links[3]!, confirmedOwner: "someone@else.example" }))
      .toEqual({ kind: "confirm", address: "me@personal.example", yours: null });
    expect(ownerPrompt(LIST.links[1]!)).toEqual({ kind: "known", address: "me@work.example", confirmed: false });
    expect(ownerPrompt(LIST.links[2]!)).toEqual({ kind: "ask" });
    // A configured owner that IS the URL's address (compared without case or spaces) answers nothing.
    expect(ownerPrompt({ id: "x", urlPathOwner: "a@b.example", configuredOwner: " A@B.example ", confirmedOwner: null, urlFrom: "file" }))
      .toEqual({ kind: "confirm", address: "a@b.example", yours: " A@B.example " });
  });

  test("\"No, it belongs to someone else\" sticks: a configured owner OTHER than the URL's address is that answer — the question stops", () => {
    const declined = { id: "x", urlPathOwner: "boss@personal.example", configuredOwner: "me@b.example", confirmedOwner: null, urlFrom: "file" as const };
    expect(ownerPrompt(declined)).toEqual({ kind: "known", address: "me@b.example", confirmed: false });
    expect(needsAddress(ownerPrompt(declined), [])).toBe(false);
    // …and a stale confirmedOwner of some other address does not bring the question back.
    expect(ownerPrompt({ ...declined, confirmedOwner: "old@personal.example" })).toEqual({ kind: "known", address: "me@b.example", confirmed: false });
    // A confirmation of the URL's own address still wins.
    expect(ownerPrompt({ ...declined, confirmedOwner: "boss@personal.example" })).toEqual({ kind: "known", address: "boss@personal.example", confirmed: true });
  });

  test("identity-unknown asks for the address — unless a confirmation is the question; \"No\" on a confirmation asks too", () => {
    expect(needsAddress({ kind: "ask" }, [])).toBe(true);
    expect(needsAddress({ kind: "known", address: "a@b.c", confirmed: false }, ["identity-unknown"])).toBe(true);
    expect(needsAddress({ kind: "known", address: "a@b.c", confirmed: false }, [])).toBe(false);
    expect(needsAddress({ kind: "confirm", address: "a@b.c", yours: null }, ["identity-unknown"])).toBe(false);
    expect(needsAddress({ kind: "confirm", address: "a@b.c", yours: null }, [], true)).toBe(true);
    expect(needsAddress({ kind: "confirm", address: "a@b.c", yours: null }, [], false)).toBe(false);
    // `declined` is about a pending confirmation only.
    expect(needsAddress({ kind: "known", address: "a@b.c", confirmed: true }, [], true)).toBe(false);
  });
});

/* ── 7. the block is edited, never rebuilt ────────────────────────────────────────────────────── */

describe("the calendar block edits", () => {
  const block: CalendarBlock = {
    emails: ["me@example.com"],
    macos: { calendars: "all" },
    links: [
      { id: "home", name: "Home", confirmedOwner: "me@personal.example", owner: "me@personal.example" },
      { id: "cmd", urlCommand: ["pass", "show", "cal"] },
    ],
  };

  test("adding a new link turns the calendar on and appends { id, name? }; every other key stays", () => {
    const next = withLinkEntry(block, "work", " Work (Outlook) ");
    expect(next).toEqual({ enabled: true, ...block, links: [...(block["links"] as unknown[]), { id: "work", name: "Work (Outlook)" }] });
    expect(withLinkEntry({}, "a", "")).toEqual({ enabled: true, links: [{ id: "a" }] });
    expect(Object.keys(withLinkEntry({ enabled: false, x: 1 }, "a", ""))).toEqual(["enabled", "x", "links"]);
  });

  test("REPLACING a link drops its confirmedOwner (the new URL is confirmed again) and keeps the rest", () => {
    const next = withLinkEntry(block, "home", "");
    expect((next["links"] as unknown[])[0]).toEqual({ id: "home", name: "Home", owner: "me@personal.example" });
    expect((withLinkEntry(block, "home", "Renamed")["links"] as unknown[])[0]).toEqual({ id: "home", name: "Renamed", owner: "me@personal.example" });
    expect((next["links"] as unknown[])[1]).toEqual({ id: "cmd", urlCommand: ["pass", "show", "cal"] });
    expect(block["links"]).toEqual([
      { id: "home", name: "Home", confirmedOwner: "me@personal.example", owner: "me@personal.example" },
      { id: "cmd", urlCommand: ["pass", "show", "cal"] },
    ]); // the input is not mutated
  });

  test("confirmedOwner, owner, enabled and the Mac choices each change one thing", () => {
    expect((withConfirmedOwner(block, "cmd", "me@x.example")!["links"] as unknown[])[1])
      .toEqual({ id: "cmd", urlCommand: ["pass", "show", "cal"], confirmedOwner: "me@x.example" });
    expect(withConfirmedOwner(block, "gone", "a@b.c")).toBeNull();
    expect((withOwner(block, "cmd", " me@x.example ")!["links"] as unknown[])[1]).toEqual({ id: "cmd", urlCommand: ["pass", "show", "cal"], owner: "me@x.example" });
    expect((withOwner(block, "home", "")!["links"] as unknown[])[0]).toEqual({ id: "home", name: "Home", confirmedOwner: "me@personal.example" });
    expect(withOwner(block, "gone", "a@b.c")).toBeNull();
    expect(withEnabled(block, false)).toEqual({ ...block, enabled: false });
    expect(withMacos({ links: [] }, true)).toEqual({ enabled: true, links: [], macos: { calendars: "editable" } });
    expect(withMacos(block, true)["macos"]).toEqual({ calendars: "all" });
    expect("macos" in withMacos(block, false)).toBe(false);
    expect(withMacCalendars(block, [LIST.macos!.calendars[1]!])["macos"]).toEqual({ calendars: [{ id: "B", title: "Work", account: "me@personal.example" }] });
  });

  test("the block is read from the config text: {} when absent, null when unreadable", () => {
    expect(calendarBlockOf('{"a":1}')).toEqual({});
    expect(calendarBlockOf('{"calendar":{"enabled":true}}')).toEqual({ enabled: true });
    expect(calendarBlockOf('{"calendar":[]}')).toBeNull();
    expect(calendarBlockOf("not json")).toBeNull();
    expect(calendarBlockOf(null)).toBeNull();
  });

  test("an id is suggested from the name in the Rust grammar, never reserved, never taken", () => {
    const grammar = /^[a-z0-9][a-z0-9-]{0,31}$/;
    expect(suggestId("Work (Outlook)", [])).toBe("work-outlook");
    expect(suggestId("Café Équipe", [])).toBe("cafe-equipe");
    expect(suggestId("", [])).toBe("calendar");
    expect(suggestId("!!!", [])).toBe("calendar");
    expect(suggestId("macOS", [])).toBe("macos-calendar");
    expect(suggestId("Home", ["home", "home-2"])).toBe("home-3");
    const long = suggestId("x".repeat(40), ["x".repeat(32)]);
    expect(long).toBe(`${"x".repeat(30)}-2`);
    for (const name of ["Work (Outlook)", "  -lead", "Ünïcödé", "a".repeat(50), "--", "Team calendar 2026!"]) {
      expect({ name, ok: grammar.test(suggestId(name, [])) }).toEqual({ name, ok: true });
    }
  });
});

/* ── 8. the flows, with the IPC faked ─────────────────────────────────────────────────────────── */

const outcome = (payload: unknown, exitCode: number | null = 0): EngineOutcome => ({
  operation: "calendar-list",
  outcome: { kind: "delivered" },
  exitCode,
  payload,
  stdout: "",
  stderr: "",
});

interface Recorder {
  calls: string[];
  /** Everything every call received EXCEPT `writeLink`'s URL argument, serialised. */
  seen: string[];
  saved: CalendarBlock[];
  urlsWritten: number;
}

function fakes(opts: {
  config?: unknown;
  list?: CalendarListJson | null;
  write?: (id: string) => LinkWritten | Error | Record<string, unknown>;
  save?: SaveOutcome;
  /** Swap the config the next read returns, after the write (as Rust's clear does). */
  afterWrite?: unknown;
}): { deps: CalendarDeps; rec: Recorder } {
  const rec: Recorder = { calls: [], seen: [], saved: [], urlsWritten: 0 };
  let config = opts.config ?? { calendar: { enabled: true, links: [] } };
  const deps: CalendarDeps = {
    writeLink: async (id, url) => {
      rec.calls.push("writeLink");
      rec.seen.push(id);
      if (url === SENTINEL_URL) rec.urlsWritten += 1;
      const w = opts.write?.(id) ?? { id, path: `/s/calendar/links/${id}.url`, replaced: false, confirmationCleared: false };
      if (opts.afterWrite !== undefined) config = opts.afterWrite;
      if (w instanceof Error || !("path" in w)) throw w;
      return w as LinkWritten;
    },
    readConfig: async (): Promise<ConfigDocument> => {
      rec.calls.push("readConfig");
      return { path: "/c/config.json", exists: true, text: JSON.stringify(config), base: "b", parseError: null, apiKeyRedacted: false };
    },
    saveBlock: async (block) => {
      rec.calls.push("saveBlock");
      rec.seen.push(JSON.stringify(block));
      rec.saved.push(block);
      return opts.save ?? { kind: "saved", path: "/c/config.json", backupPath: "/c/config.json.bak", warnings: [] };
    },
    list: async () => {
      rec.calls.push("list");
      return outcome(opts.list === undefined ? LIST : opts.list);
    },
  };
  return { deps, rec };
}

/** A `takeUrl` that hands over the sentinel once, the way the component reads and clears its field. */
function field(): { takeUrl: () => string; taken: () => number } {
  let value = SENTINEL_URL;
  let taken = 0;
  return {
    takeUrl: () => {
      taken += 1;
      const v = value;
      value = "";
      return v;
    },
    taken: () => taken,
  };
}

describe("adding a link (spec §8): write, then the entry, then the address shown for confirmation", () => {
  test("the order is write → read config → save block → list, and the URL reaches writeLink only", async () => {
    const f = field();
    const { deps, rec } = fakes({});
    const result = await addLink({ id: "home", name: "Home (Google)", takeUrl: f.takeUrl }, deps, describeFailure);
    expect(rec.calls).toEqual(["writeLink", "readConfig", "saveBlock", "list"]);
    expect(f.taken()).toBe(1);
    expect(rec.urlsWritten).toBe(1);
    for (const s of rec.seen) assertClean(s, "an IPC argument other than the write's URL");
    assertClean(JSON.stringify(result), "the add result");
    expect(result).toEqual({
      kind: "added",
      id: "home",
      replaced: false,
      link: LIST.links[0]!,
      prompt: { kind: "confirm", address: "me@personal.example", yours: null },
      warnings: [],
      note: null,
    });
  });

  test("adding NEVER confirms the owner by itself: the saved entry carries no confirmedOwner", async () => {
    const { deps, rec } = fakes({});
    await addLink({ id: "home", name: "", takeUrl: field().takeUrl }, deps, describeFailure);
    expect(rec.saved).toHaveLength(1);
    expect(rec.saved[0]).toEqual({ enabled: true, links: [{ id: "home" }] });
    expect(JSON.stringify(rec.saved)).not.toContain("confirmedOwner");
  });

  test("the block is read AFTER the write: a confirmation Rust cleared for a replaced URL is not written back", async () => {
    const before = { calendar: { enabled: true, links: [{ id: "home", confirmedOwner: "me@personal.example" }] } };
    const after = { calendar: { enabled: true, links: [{ id: "home" }] } };
    const { deps, rec } = fakes({
      config: before,
      afterWrite: after,
      write: (id) => ({ id, path: "/p", replaced: true, confirmationCleared: true }),
    });
    const result = await addLink({ id: "home", name: "", takeUrl: field().takeUrl }, deps, describeFailure);
    expect(result.kind).toBe("added");
    expect(rec.saved[0]).toEqual({ enabled: true, links: [{ id: "home" }] });
  });

  test("…and even if the config still held one, replacing drops it", async () => {
    const stale = { calendar: { enabled: true, links: [{ id: "home", confirmedOwner: "me@personal.example" }] } };
    const { deps, rec } = fakes({ config: stale, write: (id) => ({ id, path: "/p", replaced: true, confirmationCleared: false }) });
    await addLink({ id: "home", name: "", takeUrl: field().takeUrl }, deps, describeFailure);
    expect(rec.saved[0]).toEqual({ enabled: true, links: [{ id: "home" }] });
  });

  test("a refused write stops everything, and its words carry no URL", async () => {
    const { deps, rec } = fakes({ write: () => ({ kind: "invalidUrl", reason: "contains whitespace" }) });
    const result = await addLink({ id: "home", name: "", takeUrl: field().takeUrl }, deps, describeFailure);
    expect(rec.calls).toEqual(["writeLink"]);
    expect(result).toEqual({
      kind: "failed",
      message: "Not saved: the calendar link contains whitespace. Nothing was written.",
      linkWritten: false,
      confirmationCleared: false,
    });
  });

  test("an engine-refused block after the write says the file is on disk (the component offers to remove it)", async () => {
    const { deps } = fakes({ save: { kind: "invalid", errors: [{ field: "calendar.links[0]", message: "bad" }], warnings: [] } });
    const result = await addLink({ id: "home", name: "", takeUrl: field().takeUrl }, deps, describeFailure);
    expect(result).toEqual({
      kind: "failed",
      message: "The link was saved to its private file, but the calendar settings were not: Not saved: calendar.links[0]: bad",
      linkWritten: true,
      confirmationCleared: false,
    });
  });

  test("…and when that write had cleared the replaced link's confirmation, the failure says the config changed", async () => {
    const { deps } = fakes({
      write: (id) => ({ id, path: "/p", replaced: true, confirmationCleared: true }),
      save: { kind: "invalid", errors: [{ field: "calendar.links[0]", message: "bad" }], warnings: [] },
    });
    const result = await addLink({ id: "home", name: "", takeUrl: field().takeUrl }, deps, describeFailure);
    expect(result.kind === "failed" && { linkWritten: result.linkWritten, confirmationCleared: result.confirmationCleared })
      .toEqual({ linkWritten: true, confirmationCleared: true });
    assertClean(JSON.stringify(result), "the failed add result");
  });

  test("a replacing write that failed AFTER Rust cleared the confirmation says the config changed (W2 fixer LOW)", async () => {
    const { deps, rec } = fakes({
      write: () => ({ kind: "writeAfterConfirmationCleared", confirmationCleared: true, error: { kind: "tooManyLinks", limit: 10 } }),
    });
    const result = await addLink({ id: "home", name: "", takeUrl: field().takeUrl }, deps, describeFailure);
    expect(result).toEqual({
      kind: "failed",
      message: "The link was not replaced: Not saved: at most 10 calendar links can be connected. Its confirmed address was already removed from the settings, so confirm it again after the link is saved.",
      linkWritten: false,
      confirmationCleared: true,
    });
    expect(rec.calls).toEqual(["writeLink"]);
    // Any other refusal of the write leaves the config untouched.
    const plain = fakes({ write: () => ({ kind: "tooManyLinks", limit: 10 }) });
    const other = await addLink({ id: "home", name: "", takeUrl: field().takeUrl }, plain.deps, describeFailure);
    expect(other.kind === "failed" && other.confirmationCleared).toBe(false);
  });

  test("an engine that cannot list yet: added, with why the address could not be checked", async () => {
    const { deps } = fakes({ list: null });
    const result = await addLink({ id: "home", name: "", takeUrl: field().takeUrl }, deps, describeFailure);
    expect(result.kind).toBe("added");
    if (result.kind !== "added") return;
    expect(result.link).toBeNull();
    expect(result.prompt).toBeNull();
    expect(result.note).toBe("The engine did not answer calendar list (exit 0).");
  });
});

describe("confirming the owner stores exactly the address the CURRENT link names", () => {
  const withHome = { calendar: { enabled: true, links: [{ id: "home", name: "Home (Google)" }] } };

  test("yes → confirmedOwner = the URL-path address, after re-reading the list", async () => {
    const { deps, rec } = fakes({ config: withHome });
    const r = await confirmOwner("home", "me@personal.example", deps, describeFailure);
    expect(r).toEqual({ ok: true, warnings: [] });
    expect(rec.calls).toEqual(["list", "readConfig", "saveBlock"]);
    expect(rec.saved[0]).toEqual({ enabled: true, links: [{ id: "home", name: "Home (Google)", confirmedOwner: "me@personal.example" }] });
  });

  test("a link whose address changed since it was shown (replaced meanwhile) is not confirmed", async () => {
    const replaced: CalendarListJson = { ...LIST, links: [{ ...LIST.links[0]!, urlPathOwner: "someone@personal.example" }] };
    const { deps, rec } = fakes({ config: withHome, list: replaced });
    const r = await confirmOwner("home", "me@personal.example", deps, describeFailure);
    expect(r.ok).toBe(false);
    expect(rec.saved).toEqual([]);
  });

  test("a link with no URL-path address, or one gone from the list, is never confirmed", async () => {
    for (const links of [[{ id: "home", confirmedOwner: null, urlFrom: "file" as const }], []]) {
      const { deps, rec } = fakes({ config: withHome, list: { ...LIST, links } });
      expect((await confirmOwner("home", "me@personal.example", deps, describeFailure)).ok).toBe(false);
      expect(rec.saved).toEqual([]);
    }
  });

  test("an address for a link whose URL names none goes to `owner`, through the same read-edit-save", async () => {
    const { deps, rec } = fakes({ config: { calendar: { links: [{ id: "team" }] } } });
    const r = await editBlock((b) => withOwner(b, "team", "me@team.example"), deps, describeFailure);
    expect(r.ok).toBe(true);
    expect(rec.saved[0]).toEqual({ links: [{ id: "team", owner: "me@team.example" }] });
  });

  test("\"No\" then the address field: its save sets `owner`, and the link the engine lists back is no longer asked about", async () => {
    // The address field the No button opens saves through `withOwner` (the component's `saveAddress`).
    const { deps, rec } = fakes({ config: withHome });
    const r = await editBlock((b) => withOwner(b, "home", "me@b.example"), deps, describeFailure);
    expect(r.ok).toBe(true);
    expect(rec.saved[0]).toEqual({ enabled: true, links: [{ id: "home", name: "Home (Google)", owner: "me@b.example" }] });
    // `calendar list` reports that `owner` as `configuredOwner` beside the URL's own address.
    const listed = { ...LIST.links[0]!, configuredOwner: "me@b.example" };
    expect(ownerPrompt(LIST.links[0]!).kind).toBe("confirm");
    expect(ownerPrompt(listed)).toEqual({ kind: "known", address: "me@b.example", confirmed: false });
  });
});

/* ── 9. the component ─────────────────────────────────────────────────────────────────────────── */

const CONFIG_WITH_LINKS = JSON.stringify({
  calendar: { enabled: true, links: [{ id: "home", name: "Home (Google)" }, { id: "work" }, { id: "team" }, { id: "mine" }] },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const panel = (props: Record<string, unknown>): string => render(CalendarSettings as any, { props }).body.replace(/<!--[\s\S]*?-->/g, "");

describe("Settings → Calendar, rendered", () => {
  test("the link rows: last scheduled read, the confirmation for a URL address, the address field for none", () => {
    const html = panel({ os: "linux", initial: { configText: CONFIG_WITH_LINKS, list: LIST, status: STATUS } });
    // User-directed 2026-10-22: the master switch's own box says "your briefing" (the mockup's words).
    expect(html).toContain("Show today's calendar in your briefing");
    expect(html).toContain("Last scheduled read: ok at 07:21");
    expect(html).toContain(`Last scheduled read: the calendar could not be read — its command failed (${yesterdayLabel}, 07:21)`);
    expect(html).toContain("Last scheduled read: not yet");
    expect(html).toContain("This link belongs to me@personal.example. Is this calendar yours?");
    expect(html).toContain("It's mine</button>");
    expect(html).toContain("<strong>Home (Google)</strong><span class=\"muted svelte-");
    expect(html).toContain("\"> (home)</span>");
    expect(html).toContain("Your address on this calendar: me@personal.example (confirmed)");
    expect(html).toContain("Your email address on this calendar");
    expect(html).toContain("Its address comes from a command");
    expect(html).toContain("This link cannot be read: its saved address is missing; add the link again.");
    // C-A: Settings' one "Add a connection…" (on Linux, the link flow at once); the wizard keeps "Add a calendar link…".
    expect(html).toContain("Add a connection…");
    expect(html).toContain("Test now");
  });

  test("config warnings: a malformation with calendar disabled says the settings could not be read; others shown as they are (integration LOW)", () => {
    // The suffix is the engine's: every malformation carries it, the two non-malformations do not.
    for (const [key, w] of Object.entries(CALENDAR_CONFIG_WARNINGS)) {
      expect({ key, off: w.endsWith(CONFIG_OFF_SUFFIX) }).toEqual({ key, off: key !== "literalUrl" && key !== "macosNotHere" });
    }
    const bad = resolveCalendar({ enabled: true, links: [{ id: "work", someFutureField: true }] });
    const off: CalendarStatusJson = { schemaVersion: 1, enabled: bad.enabled, enabledSet: true, macSupported: false, configWarnings: [...bad.warnings], sources: [] };
    expect(configWarningLines(off)).toEqual([{ off: true, text: `Your calendar settings could not be read: ${CALENDAR_CONFIG_WARNINGS.linkShape}` }]);
    const html = panel({ os: "linux", initial: { configText: JSON.stringify({ calendar: { enabled: true, links: [{ id: "work", someFutureField: true }] } }), list: LIST, status: off } });
    expect(html).toContain(`<p class="bad svelte-`);
    expect(html).toContain(`Your calendar settings could not be read: ${CALENDAR_CONFIG_WARNINGS.linkShape}`);
    // A non-malformation (a skipped `url` link) is shown as it is, as a warning.
    const skipped: CalendarStatusJson = { ...STATUS, configWarnings: [CALENDAR_CONFIG_WARNINGS.literalUrl] };
    expect(configWarningLines(skipped)).toEqual([{ off: false, text: CALENDAR_CONFIG_WARNINGS.literalUrl }]);
    expect(configWarningLines(null)).toEqual([]);
  });

  test("MAC_CALENDAR_AVAILABLE is true since W3 (PR 2): the Mac section on macOS by default, never elsewhere", () => {
    expect(MAC_CALENDAR_AVAILABLE).toBe(true);
    for (const os of ["macos", "linux", "windows", "other"] as const) {
      expect({ os, shown: macSectionShown(os) }).toEqual({ os, shown: os === "macos" });
      const html = panel({ os, initial: { configText: CONFIG_WITH_LINKS, list: LIST, status: STATUS } });
      expect({ os, mac: html.includes("Mac Calendar app") }).toEqual({ os, mac: os === "macos" });
    }
    // The switch off (as in PR 1) still draws links only, on macOS too.
    const off = panel({ os: "macos", macAvailable: false, initial: { configText: CONFIG_WITH_LINKS, list: LIST, status: STATUS } });
    expect(off.includes("Mac Calendar app")).toBe(false);
    expect(off.includes("Allow access")).toBe(false);
    // The component defaults its prop to the constant — no other switch exists.
    expect(src("lib/CalendarSettings.svelte")).toContain("macAvailable = MAC_CALENDAR_AVAILABLE,");
  });

  test("with the switch on (W3): macOS draws the toggle, the checklist with accounts, the outdated notice and the overlap hint; Linux still does not", () => {
    expect(macSectionShown("macos", true)).toBe(true);
    expect(macSectionShown("linux", true)).toBe(false);
    const config = JSON.stringify({ calendar: { enabled: true, macos: { calendars: "editable" }, links: [{ id: "home" }] } });
    const html = panel({ os: "macos", macAvailable: true, initial: { configText: config, list: LIST, status: STATUS } });
    expect(html).toContain("Mac Calendar app");
    expect(html).toContain("Calendars to read");
    expect(html).toContain("Home <span class=\"muted");
    expect(html).toContain("— me@personal.example");
    expect(html).toContain("· subscribed");
    expect(html).toContain("A newer calendar reader is available.");
    expect(html).toContain("Update the calendar reader");
    expect(html).toContain('me@personal.example is connected twice — through the Mac Calendar app and through the link "home"');
    // Not granted yet: "Allow access", with the dialog's name.
    const ungranted = panel({
      os: "macos",
      macAvailable: true,
      initial: { configText: config, list: { ...LIST, macos: { status: "not-granted", calendars: [] } }, status: STATUS },
    });
    expect(ungranted).toContain("Allow access");
    expect(ungranted).toContain("Daily Briefing Calendar Reader");
    // Add Events Only access is NOT upgraded by asking again — measured on the W3 VM (macOS 26.6.2, 2026-10-12): no
    // dialog, the answer is write-only at once. So no "Allow access" button for it; the status line says where to fix it.
    const writeOnly = panel({ os: "macos", macAvailable: true, initial: { configText: config, list: { ...LIST, macos: { status: "write-only", calendars: [] } }, status: STATUS } });
    expect(writeOnly).not.toContain("Allow access");
    expect(writeOnly).toContain("choose Full Access in System Settings → Privacy &amp; Security → Calendars");
    const linux = panel({ os: "linux", macAvailable: true, initial: { configText: config, list: LIST, status: STATUS } });
    expect(linux.includes("Mac Calendar app")).toBe(false);
    expect(overlapHints({ ...LIST, macos: null })).toEqual([]);
  });

  test("connect mac's answer is shown: null on a grant, the status and advice otherwise, never payload text", () => {
    const { CALENDAR_STATUS_TEXT } = guiContract;
    const out = (payload: unknown, exitCode = 1) => ({ operation: "calendar-connect-mac", outcome: "failed", exitCode, payload, stdout: "", stderr: "" }) as never;
    expect(connectMacMessage(out({ schemaVersion: 1, status: "ok", install: "copied" }, 0))).toBeNull();
    expect(connectMacMessage(out({ schemaVersion: 1, status: "denied", reason: "helper-denied" }))).toBe(`Mac Calendar: ${CALENDAR_STATUS_TEXT.denied}.`);
    expect(connectMacMessage(out({ schemaVersion: 1, status: "malformed", reason: "sign-failed" }))).toContain("could not be signed");
    expect(connectMacMessage(out({ schemaVersion: 1, status: "timeout", reason: "connect-deadline" }))).toContain("took too long");
    expect(connectMacMessage(out({ schemaVersion: 1, status: "helper-missing" }))).toBe(`Mac Calendar: ${CALENDAR_STATUS_TEXT["helper-missing"]}.`);
    // An unknown status or reason is never echoed.
    expect(connectMacMessage(out({ schemaVersion: 1, status: "https://x.example/secret" }))).toContain("did not answer");
    expect(connectMacMessage(out({ schemaVersion: 1, status: "denied", reason: "https://x.example/secret" }))).not.toContain("x.example");
    expect(connectMacMessage(out(null))).toContain("did not answer");
    // Prototype keys are not statuses or reasons.
    expect(connectMacMessage(out({ schemaVersion: 1, status: "constructor" }))).toContain("did not answer");
    expect(connectMacMessage(out({ schemaVersion: 1, status: "denied", reason: "constructor" }))).toBe(`Mac Calendar: ${CALENDAR_STATUS_TEXT.denied}.`);
  });

  test("no config yet: the panel says the wizard creates one and offers no Add", () => {
    const html = panel({ os: "macos", initial: { configText: null, list: null, status: null } });
    expect(html).toContain("which does not exist yet");
    expect(html.includes("Add a calendar link")).toBe(false);
  });

  test("a row asks \"Is this calendar yours?\" with a No — and stops asking once an owner other than the URL's address is saved", () => {
    const asking = panel({ os: "linux", initial: { configText: CONFIG_WITH_LINKS, list: LIST, status: STATUS } });
    expect(asking).toContain("This link belongs to me@personal.example. Is this calendar yours?");
    expect(asking).toContain("No, it belongs to someone else</button>");
    const answered: CalendarListJson = { ...LIST, links: [{ ...LIST.links[0]!, configuredOwner: "me@b.example" }, ...LIST.links.slice(1)] };
    const html = panel({ os: "linux", initial: { configText: CONFIG_WITH_LINKS, list: answered, status: STATUS } });
    expect(html.includes("Is this calendar yours?")).toBe(false);
    expect(html.includes("No, it belongs to someone else")).toBe(false);
    expect(html).toContain("Your address on this calendar: me@b.example</p>");
  });
});

describe("the M9 checkpoint's component wiring (source pins: a server render clicks nothing and runs no onMount)", () => {
  const component = src("lib/CalendarSettings.svelte");
  const between = (from: string, to: string): string => {
    const at = component.indexOf(from);
    return at === -1 ? "" : component.slice(at, component.indexOf(to, at));
  };

  test("both No buttons lead to \"Your email address on this calendar\", whose save sets `owner`", () => {
    // The row: No marks the row declined, and the address field is drawn for a declined row.
    expect(component).toContain('onclick={() => (declined[link.id] = true)}>No, it belongs to someone else</button>');
    expect(component).toContain('{#if needsAddress(prompt, noticesFor("link", link.id), declined[link.id] === true)}');
    // The add panel: No moves to the address stage, whose button saves through `saveAddress`.
    expect(component).toContain('onclick={() => (addStage = "ask")}>No, it belongs to someone else</button>');
    expect(between('addStage === "ask"}', "Skip for now")).toContain("onclick={() => void saveAddress(id, addOwner)}");
    expect(between("async function saveAddress(", "async function remove(")).toContain("editBlock((b) => withOwner(b, id, address), deps, describeFailure)");
  });

  test("a failed add whose write cleared a confirmation tells Settings the config changed", () => {
    const failed = between('if (result.kind === "failed") {', "return;\n");
    expect(failed).toMatch(/if \(result\.confirmationCleared\) \{\n\s*onconfigchanged\(\);/);
  });

  test("`today` is state, set again on every refresh and on a minute tick (a $derived of Date.now() never changes)", () => {
    expect(component).toContain("let today = $state(localDateOf(Date.now()));");
    expect(component).not.toContain("$derived(localDateOf(Date.now()))");
    expect(between("async function refresh(", "onMount(")).toContain("today = localDateOf(Date.now());");
    const mount = between("onMount(() => {", "});");
    expect(mount).toContain("setInterval(() => (today = localDateOf(Date.now())), 60_000);");
    expect(mount).toContain("return () => clearInterval(tick);");
  });
});

describe("the URL is never shown back, logged, kept in state or snapshotted (source pins)", () => {
  const component = src("lib/CalendarSettings.svelte");
  const model = src("lib/calendar-settings.ts");

  test("the paste field is a password input held by reference only — never bound to a value", () => {
    const input = /<input id="cal-link-url"[^>]*\/>/.exec(component)?.[0] ?? "";
    expect(input).toContain('type="password"');
    expect(input).toContain('autocomplete="off"');
    expect(input).toContain("bind:this={urlField}");
    expect(input).not.toContain("value");
    expect(component).not.toContain("bind:value");
    // `takeUrl` reads and CLEARS the field in one step, before handing the value over.
    expect(component).toMatch(/const value = field\.value;\n\s*field\.value = "";\n\s*return value;/);
    // Closing the add panel clears the field too, so a pasted link never waits there unused.
    expect(component).toMatch(/function closeAdd\(\): void \{\n\s*takeUrl\(\);/);
  });

  test("tiny fix T3 (pre-existing on main): takeUrl stops on a paste field that is gone — Svelte 5 sets a `bind:this` to null, not undefined, when the input unmounts", () => {
    // The add flow's answer stage draws no paste field, so its "Done" (closeAdd → takeUrl) read `.value` of null and
    // threw: the panel stayed open, in the wizard and in Settings (visual MED 2, `rev-cal-final/done.cjs`).
    expect(component).toMatch(/function takeUrl\(\): string \{\n\s*const field = urlField;\n\s*if \(field == null\) return "";\n\s*const value = field\.value;/);
    expect(component).not.toContain("field === undefined");
  });

  test("the URL goes to writeLink and nowhere else; nothing in the calendar code logs", () => {
    expect(model.match(/takeUrl\(\)/g)).toEqual(["takeUrl()"]);
    expect(model).toContain("written = await deps.writeLink(input.id, input.takeUrl());");
    for (const [name, text] of [["CalendarSettings.svelte", component], ["calendar-settings.ts", model], ["calendar.ts", src("lib/calendar.ts")]] as const) {
      expect({ name, logs: /console\.|localStorage|sessionStorage/.test(text) }).toEqual({ name, logs: false });
    }
  });

  test("no snapshot file in this suite holds a link (the sentinel's spelling is nowhere on disk but here)", () => {
    const snaps = new URL("./__snapshots__/", import.meta.url).pathname;
    for (const name of readdirSync(snaps)) {
      const text = readFileSync(`${snaps}${name}`, "utf8");
      expect({ name, link: /https?:\/\/[^\s"]*\.ics|webcal:\/\//.test(text) }).toEqual({ name, link: false });
    }
  });
});

/* ── 10. the wizard's optional step ───────────────────────────────────────────────────────────── */

describe("the wizard's optional calendar step", () => {
  test("after the save gate, before delivery; Back and Set up later are gone once the config is written", () => {
    expect(STEP_ORDER.indexOf("calendar")).toBe(STEP_ORDER.indexOf("floor") + 1);
    expect(STEP_ORDER.indexOf("calendar")).toBe(STEP_ORDER.indexOf("delivery") - 1);
    expect(nextStep("floor", false)).toBe("calendar");
    expect(nextStep("calendar", true)).toBe("delivery");
    expect(previousStep("delivery", false)).toBe("calendar");
    expect(cancelWritesNothing("floor")).toBe(true);
    expect(cancelWritesNothing("calendar")).toBe(false);
    expect(cancelWritesNothing("delivery")).toBe(false);
  });

  test("by OS (PB-M7-T1): macOS and Linux ask the calendar question; Windows keeps the box, off by default, its controls only once \"Add a calendar now\" is ticked; the one config write is still the save gate's", () => {
    const wizard = src("routes/Wizard.svelte");
    expect(wizard).toContain("let calendarOpen = $state(false);");
    // Design 2026-10-31 M3: every anchor asserted, and ordered, so a missing one can never make a slice pass vacuously.
    const stepFrom = wizard.indexOf('{:else if step === "calendar"}');
    const stepTo = wizard.indexOf("{:else}\n    <div class=\"body\">\n      {#if saved !== null}", stepFrom);
    expect(stepFrom).toBeGreaterThan(-1);
    expect(stepFrom).toBeLessThan(stepTo);
    const step = wizard.slice(stepFrom, stepTo);
    // The OS decision is the pure step view's (`wizardCalendarStep`: Windows and an unknown OS → the box).
    const boxFrom = step.indexOf("{#if calendarView.box}");
    expect(boxFrom).toBeGreaterThan(-1);
    expect(boxFrom).toBeLessThan(step.indexOf("{:else if calendarView.checking}"));
    const box = step.slice(boxFrom, step.indexOf("{:else if calendarView.checking}"));
    expect(box).toContain("Add a calendar now");
    expect(box).toContain("This is optional and off unless you add a calendar");
    expect(box).toMatch(/\{#if calendarOpen\}\s*<CalendarSettings \{os\} mode="wizard" \/>\s*\{\/if\}/);
    // macOS and Linux: the same CalendarQuestion as Today's card, origin "wizard"; none of the box's words.
    const asked = step.slice(step.indexOf("{:else if calendarView.checking}"));
    expect(asked).toContain('<CalendarQuestion origin="wizard" {os}');
    expect(asked).not.toContain("Add a calendar now");
    expect(asked).not.toContain("calendarOpen");
    expect(step.match(/<CalendarQuestion /g)).toHaveLength(1);
    expect(wizard).toContain('step = nextStep("floor", accessInScope) ?? "delivery";');
    expect(wizard.match(/configSave\(/g)).toHaveLength(1);
    // Design 2026-10-31 D1: the step is numbered, its title from `stepHeading` (the header renders exactly that).
    expect(stepHeading("calendar", { os: "macos", accessKnown: false, accessInScope: false })).toBe("Step 7 of 8 — your calendar (optional)");
    expect(stepHeading("calendar", { os: "macos", accessKnown: true, accessInScope: false })).toBe("Step 6 of 7 — your calendar (optional)");
    expect(stepHeading("calendar", { os: "linux", accessKnown: true, accessInScope: true })).toBe("Step 6 of 7 — your calendar (optional)");
    const head = wizard.slice(wizard.indexOf('<header class="head">'), wizard.indexOf("</header>"));
    expect(wizard.indexOf('<header class="head">')).toBeGreaterThan(-1);
    expect(wizard.indexOf('<header class="head">')).toBeLessThan(wizard.indexOf("</header>"));
    expect(head).toContain("{stepHeading(step, stepCtx)}");
    expect(wizard).not.toContain("Optional step");
  });
});

/* ── 11. Settings and uninstall ───────────────────────────────────────────────────────────────── */

describe("Settings mounts the panel; uninstall names the calendar links", () => {
  test("Settings draws the Calendar panel and reloads the form after its writes, or owes the reload while an edit is on screen", () => {
    const settings = src("routes/Settings.svelte");
    // Redesign D: on Settings → Calendar. The shell hands its reload and the status summary down: Settings →
    // SettingsPages → CalendarPage → CalendarSettings, which gains `onstatus` there (D-M3-T5).
    const tag = (text: string, open: string): string => text.slice(text.indexOf(open), text.indexOf("/>", text.indexOf(open)));
    const shell = tag(settings, "<SettingsPages");
    expect(shell).toContain("onconfigchanged={calendarChangedConfig}");
    expect(shell).toContain("onstatus={(ok) => (calendarOk = ok)}");
    expect(src("lib/settings/SettingsPages.svelte")).toContain("<CalendarPage {os} {onconfigchanged} {onstatus} />");
    // PB-M6-T1: the page binds the panel (its exported refresh, after a flow) and passes the store's lock.
    expect(src("lib/settings/CalendarPage.svelte")).toContain("<CalendarSettings bind:this={panel} {os} {onconfigchanged} {onstatus} locked={running !== null} />");
    expect(settings).not.toContain("<CalendarSettings");
    const fn = settings.slice(settings.indexOf("function calendarChangedConfig"), settings.indexOf("function onfield"));
    // Post-cap (R5-H1): the reload runs at once on a clean draft (a field showing a refused value keeps its mark and
    // its error), and is owed — run as soon as the draft is clean again — while an edit is on screen or a save runs.
    expect(fn).toContain("function calendarChangedConfig(): void {\n    void backgroundReload();\n  }");
    expect(fn).toContain("reloadOwed = !backgroundReloadApplies(asked, asked);");
    expect(fn).toContain("if (!backgroundReloadApplies(asked, screenStamp())) {");
  });

  test("the engine-data box names the calendar links and says to reset one that may have leaked, on every OS, in two sentences", () => {
    const preview = { engineStateDir: "/x/state", engineError: null, settingsFolder: "/x/c", os: "macos" } as unknown as UninstallPreview;
    for (const os of ["macos", "linux", "windows"]) {
      const label = consentLabel({ ...preview, os });
      expect(label).toContain(CALENDAR_LINKS_CLAUSE);
      expect((label.match(/[.?!](?=\s|$)/g) ?? []).length).toBe(2);
    }
    expect(CALENDAR_LINKS_CLAUSE).toBe("your calendar links (reset any that may have leaked)");
  });
});

/* ── Redesign D (D-M3-T5): the panel reports its status outward, for Settings' attention dot ───── */

describe("D-M3-T5: CalendarSettings' onstatus", () => {
  type Read = Parameters<typeof calendarStatusOk>[0];
  const source = (id: string, status: CalendarReadStatus | null): CalendarStatusSource => ({
    id,
    kind: "link",
    lastScheduledRead: status === null ? null : { at: "2026-10-21T07:00:00Z", status },
  });
  const read = (sources: CalendarStatusSource[], enabled = true, configWarnings: string[] = []): Read => ({
    status: { schemaVersion: 1, enabled, enabledSet: true, macSupported: false, configWarnings, sources },
    error: null,
  });
  /** Every read outcome but `ok`: the keys of the panel's own status wording. */
  const NOT_OK = Object.keys(CALENDAR_STATUS_TEXT) as (keyof typeof CALENDAR_STATUS_TEXT)[];

  test("ok when every source's last scheduled read was ok or has not happened yet", () => {
    expect(calendarStatusOk(read([]))).toBe(true);
    expect(calendarStatusOk(read([source("a", "ok"), source("b", null)]))).toBe(true);
    // A warning that does not switch the calendar off (a skipped link) is not the summary's to judge.
    expect(calendarStatusOk(read([source("a", "ok")], true, [CALENDAR_CONFIG_WARNINGS.literalUrl]))).toBe(true);
  });

  test("not ok when any source's last read was anything but ok, wherever it sits, or when the status could not be read", () => {
    expect(NOT_OK).toContain("incomplete");
    expect(NOT_OK.length).toBeGreaterThan(5);
    for (const bad of NOT_OK) {
      expect({ bad, ok: calendarStatusOk(read([source("a", "ok"), source("b", bad)])) }).toEqual({ bad, ok: false });
      expect({ bad, first: calendarStatusOk(read([source("a", bad), source("b", "ok")])) }).toEqual({ bad, first: false });
    }
    // The panel shows the read's failure as its own bad line, so it needs a look too.
    expect(calendarStatusOk({ status: null, error: "calendar status did not answer" })).toBe(false);
  });

  test("switched off by the user: no look needed, even over an old failed read; switched off by the ENGINE (a malformed block): needs a look", () => {
    // The user's switch: `enabled: false`, no warning. Nothing is read, so an old failure is not today's problem.
    expect(calendarStatusOk(read([source("a", "timeout")], false))).toBe(true);
    // …also when the resolver still warns about something that does not switch the calendar off (a skipped link,
    // `src/calendar/config.ts`: those warnings are pushed whatever `enabled` says).
    expect(calendarStatusOk(read([], false, [CALENDAR_CONFIG_WARNINGS.literalUrl]))).toBe(true);
    // A malformed block: the engine reports `enabled: false` with a " — calendar off" warning and no sources, and the
    // panel draws "Your calendar settings could not be read" as a bad line (`configWarningLines`, `off: true`).
    const malformed = read([], false, [CALENDAR_CONFIG_WARNINGS.shape]);
    expect(configWarningLines(malformed.status)).toEqual([{ off: true, text: `Your calendar settings could not be read: ${CALENDAR_CONFIG_WARNINGS.shape}` }]);
    expect(calendarStatusOk(malformed)).toBe(false);
  });

  test("source pin: onstatus is optional, and refresh calls it once, right after the status read lands, with that summary", () => {
    const component = src("lib/CalendarSettings.svelte");
    // Optional, beside `onconfigchanged`, and not defaulted, so the wizard's mount needs nothing new.
    expect(component).toContain("    onstatus?: ((ok: boolean) => void) | undefined;\n");
    const end = component.indexOf("$props()");
    const destructure = component.slice(component.lastIndexOf("let {", end), end);
    expect(destructure).toMatch(/\n    onstatus,\n/);
    // Called exactly once in the file, inside `refresh`, unconditionally, on the line right after `statusError` is set
    // from the read (a guard such as `if (read.status !== null)` would never report a failed read).
    expect(component.match(/onstatus\?\.\(/g)).toEqual(["onstatus?.("]);
    const refresh = component.slice(component.indexOf("async function refresh("), component.indexOf("onMount("));
    expect(refresh).toContain("    status = read.status;\n    statusError = read.error;\n    onstatus?.(calendarStatusOk(read));\n");
    // `refresh` is what onMount runs, so the summary reaches Settings on every mount.
    expect(component.slice(component.indexOf("onMount("))).toMatch(/^onMount\(\(\) => \{\s*void refresh\(\);/);
  });

  test("the wizard's mount passes no onstatus (Settings' mount passes it since D-M4-T8, pinned above)", () => {
    expect(src("routes/Wizard.svelte")).toMatch(/<CalendarSettings \{os\} mode="wizard" \/>/);
    expect(src("routes/Wizard.svelte")).not.toContain("onstatus");
  });
});

/* ── Redesign D, option A (user-directed 2026-10-22): Settings › Calendar as the S-A mockup's "Sources" rows ─────── */

describe("Redesign D, option A: Settings › Calendar as flat Sources rows, each source expandable in place", () => {
  /** Fixed PAST dates (never today, whatever the clock says), so the renders below never change with the calendar. */
  const WIZ_LIST: CalendarListJson = {
    schemaVersion: 1,
    macos: {
      status: "ok",
      notices: ["helper-outdated"],
      calendars: [
        { id: "A", title: "Home", account: "iCloud", editable: true, type: "standard", selected: true },
        { id: "B", title: "Work", account: "me@personal.example", editable: true, type: "standard", selected: true },
        { id: "C", title: "US Holidays", account: "Subscribed Calendars", editable: false, type: "subscribed", selected: false },
        { id: "D", title: "Birthdays", account: "iCloud", editable: false, type: "birthdays", selected: false },
        { id: "E", title: "Shared", account: "pat@other.example", editable: false, type: "standard", selected: false },
      ],
    },
    links: [
      { id: "home", name: "Home (Google)", urlPathOwner: "me@personal.example", confirmedOwner: null, urlFrom: "file", fileStatus: "ok" },
      { id: "work", name: "Work (Outlook)", configuredOwner: "me@work.example", confirmedOwner: null, urlFrom: "command" },
      { id: "team", confirmedOwner: null, urlFrom: "file", fileStatus: "missing", fileReason: "file-missing" },
      { id: "mine", urlPathOwner: "me@personal.example", confirmedOwner: "me@personal.example", urlFrom: "file", fileStatus: "ok" },
      { id: "envy", urlFrom: "env", confirmedOwner: null },
    ],
  };
  const WIZ_STATUS: CalendarStatusJson = {
    schemaVersion: 1,
    enabled: true,
    enabledSet: true,
    macSupported: true,
    configWarnings: [],
    sources: [
      { id: "macos", kind: "macos", lastScheduledRead: { at: "2026-01-05T07:21:09.000Z", status: "ok" } },
      { id: "home", kind: "link", lastScheduledRead: { at: "2026-01-05T07:21:09.000Z", status: "ok" } },
      { id: "work", kind: "link", lastScheduledRead: { at: "2026-01-04T07:21:09.000Z", status: "malformed", reason: "command-exit" } },
      { id: "team", kind: "link", lastScheduledRead: null },
      { id: "envy", kind: "link", lastScheduledRead: { at: "2026-01-05T07:21:09.000Z", status: "ok", notices: ["identity-unknown"] } },
    ],
  };
  const WIZ_CONFIG = JSON.stringify({
    calendar: { enabled: true, macos: { calendars: "editable" }, links: [{ id: "home", name: "Home (Google)" }, { id: "work" }, { id: "team" }, { id: "mine" }, { id: "envy" }] },
  });
  const CONFIG_NO_MAC = JSON.stringify({ calendar: { enabled: true, links: [{ id: "home" }] } });
  const ACCESS = ["not-granted", "helper-missing", "write-only", "denied", "restricted"] as const;
  /** The classes only the Settings branch draws: a style rule naming one of them (or `.panel`) cannot reach the wizard. */
  // User-directed 2026-10-22: the master switch's box, the Connections box and the C-A rows add theirs (box … picker).
  const SETTINGS_ONLY = [
    "panel", "help", "sources", "item", "src", "line", "head", "tag", "chev", "tone-ok", "tone-warn", "tone-muted", "details", "foot",
    "box", "master", "mrow", "mwords", "mtitle", "mline", "chead", "badge", "badge-on", "badge-off", "offhelp", "needs", "ico", "words", "srcname", "sub", "act", "picker",
  ];
  const NOT_OK = Object.keys(CALENDAR_STATUS_TEXT) as (keyof typeof CALENDAR_STATUS_TEXT)[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const draw = (props: Record<string, unknown>): string => render(CalendarSettings as any, { props }).body.replace(/<!--[\s\S]*?-->/g, "");
  /** The text a reader gets from a piece of markup: tags dropped, whitespace runs as one space. */
  const words = (html: string): string => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  /** The `<li>` row whose header button controls `id`. */
  const rowOf = (html: string, id: string): string => {
    const at = html.indexOf(`aria-controls="${id}"`);
    return at === -1 ? "" : html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at) + "</li>".length);
  };
  const headOf = (row: string): string => row.slice(row.indexOf("<button"), row.indexOf("</button>") + "</button>".length);

  test("the Mac source's status tag: off, needs access, couldn't read, partly read, reader needs an update, or allowed · N calendars", () => {
    const cal = (id: string, selected: boolean) => ({ id, title: id, account: "iCloud", editable: true, type: "standard" as const, selected });
    const mac = (status: CalendarReadStatus, notices?: ("helper-outdated" | "identity-unknown")[]) => ({
      status,
      ...(notices === undefined ? {} : { notices }),
      calendars: [cal("a", true), cal("b", true), cal("c", false)],
    });
    const okRead = { at: "2026-01-05T07:21:09.000Z", status: "ok" as const };
    // Off: muted, whatever the engine says; on but not reported yet: no tag (the row's details say so).
    expect(macSourceTag(false, mac("ok"), okRead, undefined)).toEqual({ text: "off", tone: "muted" });
    expect(macSourceTag(false, null, undefined, undefined)).toEqual({ text: "off", tone: "muted" });
    expect(macSourceTag(true, null, undefined, undefined)).toBeNull();
    // Access the user must give: not granted, the reader missing, and the three System Settings answers.
    for (const s of ACCESS) {
      expect({ s, tag: macSourceTag(true, mac(s), okRead, undefined) }).toEqual({ s, tag: { text: "needs access", tone: "warn" } });
      expect({ s, tag: macSourceTag(true, mac(s, ["helper-outdated"]), okRead, undefined) }).toEqual({ s, tag: { text: "needs access", tone: "warn" } });
    }
    // Every other failure the engine reports for the source; a partial read in the engine's words (tiny fix, the LOWs).
    for (const s of NOT_OK.filter((x) => !(ACCESS as readonly string[]).includes(x))) {
      const text = s === "incomplete" ? "partly read" : "couldn't read";
      expect({ s, tag: macSourceTag(true, mac(s), okRead, undefined) }).toEqual({ s, tag: { text, tone: "warn" } });
    }
    // Granted, but a newer reader waits (a notice beside ok, spec §4.1).
    expect(macSourceTag(true, mac("ok", ["helper-outdated"]), okRead, undefined)).toEqual({ text: "reader needs an update", tone: "warn" });
    // Granted, and the last scheduled read failed.
    expect(macSourceTag(true, mac("ok"), { at: okRead.at, status: "timeout" }, undefined)).toEqual({ text: "couldn't read", tone: "warn" });
    expect(macSourceTag(true, mac("ok"), { at: okRead.at, status: "incomplete" }, undefined)).toEqual({ text: "partly read", tone: "warn" });
    // Tiny fix (the LOWs): the last "Test now" counts as a read, as a link's does — failed, the tag is amber (so the
    // row opens); partial, "partly read"; a partial read beside a failed one is the failure.
    const test1 = (status: CalendarReadStatus) => ({ id: "macos", kind: "macos" as const, status, eventsToday: 2, durationMs: 5 });
    expect(macSourceTag(true, mac("ok"), okRead, test1("timeout"))).toEqual({ text: "couldn't read", tone: "warn" });
    expect(macSourceTag(true, mac("ok"), null, test1("malformed"))).toEqual({ text: "couldn't read", tone: "warn" });
    expect(macSourceTag(true, mac("ok"), undefined, test1("timeout"))).toEqual({ text: "couldn't read", tone: "warn" });
    expect(macSourceTag(true, mac("ok"), okRead, test1("incomplete"))).toEqual({ text: "partly read", tone: "warn" });
    expect(macSourceTag(true, mac("ok"), { at: okRead.at, status: "incomplete" }, test1("timeout"))).toEqual({ text: "couldn't read", tone: "warn" });
    expect(macSourceTag(true, mac("ok"), { at: okRead.at, status: "timeout" }, test1("incomplete"))).toEqual({ text: "couldn't read", tone: "warn" });
    expect(macSourceTag(true, mac("ok"), okRead, test1("ok"))).toEqual({ text: "allowed · 2 calendars", tone: "ok" });
    // Off, access and the outdated reader still come first.
    expect(macSourceTag(false, mac("ok"), okRead, test1("timeout"))).toEqual({ text: "off", tone: "muted" });
    expect(macSourceTag(true, mac("not-granted"), okRead, test1("timeout"))).toEqual({ text: "needs access", tone: "warn" });
    expect(macSourceTag(true, mac("ok", ["helper-outdated"]), okRead, test1("timeout"))).toEqual({ text: "reader needs an update", tone: "warn" });
    // Granted: the calendars being read (the engine's `selected`), counted.
    expect(macSourceTag(true, mac("ok"), okRead, undefined)).toEqual({ text: "allowed · 2 calendars", tone: "ok" });
    expect(macSourceTag(true, mac("ok"), null, undefined)).toEqual({ text: "allowed · 2 calendars", tone: "ok" });
    expect(macSourceTag(true, { ...mac("ok"), calendars: [cal("a", true), cal("b", false)] }, undefined, undefined)).toEqual({ text: "allowed · 1 calendar", tone: "ok" });
    expect(macSourceTag(true, { ...mac("ok"), calendars: [] }, undefined, undefined)).toEqual({ text: "allowed · 0 calendars", tone: "ok" });
  });

  test("a link's status tag: couldn't read, is this yours?, add your email, read <when>, or not read yet", () => {
    const today = "2026-01-05";
    const okRead = { at: "2026-01-05T07:21:09.000Z", status: "ok" as const };
    const known = { id: "x", configuredOwner: "me@x.example", confirmedOwner: null, urlFrom: "file" as const, fileStatus: "ok" as const };
    const seen = (over: Record<string, unknown> = {}) => ({ read: okRead, test: undefined, notices: [], declined: false, today, ...over }) as Parameters<typeof linkSourceTag>[1];
    const test1 = (status: CalendarReadStatus) => ({ id: "x", kind: "link" as const, status, eventsToday: 2, durationMs: 5 });
    // An ok scheduled read: green, worded with the briefing's own date helpers (local time; this suite runs in UTC).
    expect(linkSourceTag(known, seen())).toEqual({ text: "read today 07:21", tone: "ok" });
    expect(linkSourceTag(known, seen({ read: { at: "2026-01-04T07:21:09.000Z", status: "ok" } }))).toEqual({ text: "read Jan 4, 07:21", tone: "ok" });
    expect(linkSourceTag(known, seen({ test: test1("ok") }))).toEqual({ text: "read today 07:21", tone: "ok" });
    // Not read yet (the status says so); unknown (no status at all): no tag.
    expect(linkSourceTag(known, seen({ read: null }))).toEqual({ text: "not read yet", tone: "muted" });
    expect(linkSourceTag(known, seen({ read: undefined }))).toBeNull();
    // A problem: the managed file, the last scheduled read, or the last test — and it outranks the owner questions.
    const missing = { ...known, fileStatus: "missing" as const, fileReason: "file-missing" };
    expect(linkSourceTag(missing, seen())).toEqual({ text: "couldn't read", tone: "warn" });
    for (const s of NOT_OK) {
      expect({ s, tag: linkSourceTag(known, seen({ read: { at: okRead.at, status: s } })) }).toEqual({ s, tag: { text: "couldn't read", tone: "warn" } });
      expect({ s, tag: linkSourceTag(known, seen({ test: test1(s) })) }).toEqual({ s, tag: { text: "couldn't read", tone: "warn" } });
    }
    expect(linkSourceTag(known, seen({ read: { at: okRead.at, status: "timeout" }, test: test1("ok") }))).toEqual({ text: "couldn't read", tone: "warn" });
    const confirm = { id: "x", urlPathOwner: "a@b.example", confirmedOwner: null, urlFrom: "file" as const, fileStatus: "ok" as const };
    expect(linkSourceTag({ ...confirm, fileStatus: "missing" as const }, seen())).toEqual({ text: "couldn't read", tone: "warn" });
    // The confirmation waiting; once answered "No", the address field instead.
    expect(linkSourceTag(confirm, seen())).toEqual({ text: "is this yours?", tone: "warn" });
    expect(linkSourceTag(confirm, seen({ declined: true }))).toEqual({ text: "add your email", tone: "warn" });
    expect(linkSourceTag({ ...confirm, confirmedOwner: "a@b.example" }, seen())).toEqual({ text: "read today 07:21", tone: "ok" });
    // No owner known (`ask`), or the engine could not tell whose calendar it is (`identity-unknown`).
    const nobody = { id: "x", confirmedOwner: null, urlFrom: "env" as const };
    expect(linkSourceTag(nobody, seen())).toEqual({ text: "add your email", tone: "warn" });
    expect(linkSourceTag(known, seen({ notices: ["identity-unknown"] }))).toEqual({ text: "add your email", tone: "warn" });
    expect(linkSourceTag(nobody, seen({ read: null }))).toEqual({ text: "add your email", tone: "warn" });
  });

  test("which rows are open: a row that needs the user opens; the user's own choice is kept across refreshes; a row that NEWLY needs the user opens", () => {
    const none = { open: {}, needed: {} };
    // First sight: open exactly the rows that need the user.
    const first = nextOpenRows(none, { mac: true, a: false, b: true });
    expect(first.open).toEqual({ mac: true, a: false, b: true });
    // The user closes "mac" and opens "a"; a refresh with the same needs changes nothing.
    const chosen = { open: { ...first.open, mac: false, a: true }, needed: first.needed };
    expect(nextOpenRows(chosen, { mac: true, a: false, b: true }).open).toEqual({ mac: false, a: true, b: true });
    // A row that stops needing the user never snaps shut by itself (the user may be typing in it).
    expect(nextOpenRows(chosen, { mac: true, a: false, b: false }).open).toEqual({ mac: false, a: true, b: true });
    // A row that newly needs the user opens, even one the user had closed.
    const closedA = { open: { mac: false, a: false, b: true }, needed: { mac: true, a: false, b: true } };
    expect(nextOpenRows(closedA, { mac: true, a: true, b: true }).open).toEqual({ mac: false, a: true, b: true });
    // …but a closed row that STILL needs the user (no transition) stays closed.
    const again = nextOpenRows(closedA, { mac: true, a: true, b: true });
    expect(nextOpenRows({ ...again, open: { ...again.open, a: false } }, { mac: true, a: true, b: true }).open.a).toBe(false);
    // …and one that stopped needing it and needs it again opens again.
    const stopped = nextOpenRows({ ...again, open: { ...again.open, a: false } }, { mac: true, a: false, b: true });
    expect(nextOpenRows(stopped, { mac: true, a: true, b: true }).open.a).toBe(true);
    // A row that went away is forgotten: back again, it is seen for the first time.
    const gone = nextOpenRows({ open: { mac: true, a: true }, needed: { mac: false, a: false } }, { mac: false });
    expect(gone).toEqual({ open: { mac: true }, needed: { mac: false } });
    expect(nextOpenRows(gone, { mac: false, a: false }).open).toEqual({ mac: true, a: false });
    // The input is never changed in place.
    expect(chosen.open).toEqual({ mac: false, a: true, b: true });
  });

  test("the wizard's calendar step is unchanged: state by state, its render is the one at 5b6fa8cc2 (scope hash and whitespace runs normalised)", () => {
    // Recorded from `CalendarSettings.svelte` at 5b6fa8cc2 (before this restyle) with exactly these fixtures and this
    // normalisation; the renders are kept in the PR's build notes. Any change to the wizard's markup — an element, a
    // class, an attribute, a text, their order — changes a hash.
    // ⚠ Round 10 (L3): THE BASELINE IS 5b6fa8cc2, NOT MAIN. Round 11 (L7): against main (5e53f4301) the wizard has TWO
    // wording changes, both made earlier in this PR. (1) In this calendar step (f71284ef3, D-M5-T9): the unreadable-block
    // line ("bad-block" below) says "Fix them with Edit settings as JSON on Settings → Advanced." where main said "Fix
    // them in Settings, on the Raw JSON tab." (2) Outside it (0c2dcebd0, D-M3-T4): the engine-notify line the wizard draws
    // for a command-line install (`routes/Wizard.svelte`, `engineNotifyLine`) says, for an invalid setting, "Fix it in
    // Settings → Advanced, under Notifications from the engine." where main said "The Settings form below can fix the
    // value." The next two tests pin exactly those lines against main's text.
    const normalise = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, "").replace(/svelte-[a-z0-9]+/g, "svelte-H").replace(/\s+/g, " ");
    const states: [string, Record<string, unknown>, number, string][] = [
      ["mac-full", { os: "macos", initial: { configText: WIZ_CONFIG, list: WIZ_LIST, status: WIZ_STATUS } }, 5520, "a81e74ad2eb68b02699cca326e7eea1fe42f81d830db02cfecda381c67af6c33"],
      ["linux-full", { os: "linux", initial: { configText: WIZ_CONFIG, list: WIZ_LIST, status: WIZ_STATUS } }, 3393, "ecbc1c872c2af12d3f06a259d66a341db793d9b16fd02213b28f7b34c9d0d07f"],
      ["mac-not-granted", { os: "macos", initial: { configText: WIZ_CONFIG, list: { ...WIZ_LIST, macos: { status: "not-granted", calendars: [] } }, status: WIZ_STATUS } }, 4060, "1691e3bcc02071cda8d7fcf15f2366ede36a8e78068f63fef2786425fb709564"],
      ["mac-write-only", { os: "macos", initial: { configText: WIZ_CONFIG, list: { ...WIZ_LIST, macos: { status: "write-only", calendars: [] } }, status: WIZ_STATUS } }, 3864, "ddc0cd25fb37ba5dd1fa1c4d0eaf9618ab19b7c99869832fa53f036e35c46503"],
      ["mac-unreported", { os: "macos", initial: { configText: WIZ_CONFIG, list: { ...WIZ_LIST, macos: null }, status: null } }, 3646, "34de5297e5a905f1d98bb9621f6005b538a0aa212b11b1062471c1084ef6e524"],
      ["mac-off-no-links", { os: "macos", initial: { configText: JSON.stringify({ calendar: { enabled: false } }), list: { schemaVersion: 1, macos: null, links: [] }, status: { ...WIZ_STATUS, enabled: false, sources: [] } } }, 446, "2b8e4e14513b169e8a01abad16bdfd4f90b29522b2f990343b1c179f1ce3fcc8"],
      ["no-config", { os: "macos", initial: { configText: null, list: null, status: null } }, 178, "0d1520c069f7ab26910fd5065da55c0936f45114cdc3926c1cf9d8fa3630e798"],
      ["empty-config", { os: "linux", initial: { configText: "{}", list: null, status: null } }, 155, "8c63afb7fca37be06387638fa4c3f3ec7f5877896bdf3259fc20dbe8d6460597"],
      ["bad-block", { os: "linux", initial: { configText: JSON.stringify({ calendar: 5 }), list: WIZ_LIST, status: WIZ_STATUS } }, 3543, "8b09ce2eb4caeb8f8f7fcbe9853dddfc5d5b8797459c08f7dc77c1a07269eba5"],
      ["warnings", { os: "linux", initial: { configText: CONFIG_NO_MAC, list: WIZ_LIST, status: { ...WIZ_STATUS, enabled: false, configWarnings: ["calendar.links[0]: an unknown key — calendar off", "a skipped link"] } } }, 3555, "2a15df71cccb74be43c87fbaad8bc84922d2463ea3809a71c1f79625816d2505"],
    ];
    for (const [name, props, length, sha] of states) {
      const html = normalise(draw({ ...props, mode: "wizard" }));
      expect({ name, length: html.length, sha: createHash("sha256").update(html).digest("hex") }).toEqual({ name, length, sha });
      const settingsOnly = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(" ")).filter((c) => SETTINGS_ONLY.includes(c));
      expect({ name, settingsOnly }).toEqual({ name, settingsOnly: [] });
    }
    // The fixtures are not vacuous: the full state draws every part of the step.
    const full = normalise(draw({ os: "macos", mode: "wizard", initial: { configText: WIZ_CONFIG, list: WIZ_LIST, status: WIZ_STATUS } }));
    for (const part of ["Mac Calendar app</strong>", "Calendars to read", "Update the calendar reader", "It's mine", "Save address", "Remove…", "Test now", "Add a calendar link…", "is connected twice"]) {
      expect({ part, drawn: full.includes(part) }).toEqual({ part, drawn: true });
    }
  });

  test("round 10 (L3): the wizard's calendar step's one wording change against main — the unreadable-block line names Edit settings as JSON, where main named the Raw JSON tab", () => {
    // Main's line (5e53f4301, `CalendarSettings.svelte:409`), as text: the only words of the wizard's step that differ.
    const MAIN = "The config's calendar settings could not be read. Fix them in Settings, on the Raw JSON tab.";
    const html = draw({ os: "linux", mode: "wizard", initial: { configText: JSON.stringify({ calendar: 5 }), list: WIZ_LIST, status: WIZ_STATUS } });
    const line = /<p class="bad[^"]*">(The config's calendar settings could not be read\.[^<]*)<\/p>/.exec(html)?.[1];
    expect(line).toBe("The config's calendar settings could not be read. Fix them with Edit settings as JSON on Settings → Advanced.");
    expect(line!.replace("with Edit settings as JSON on Settings → Advanced", "in Settings, on the Raw JSON tab")).toBe(MAIN);
    expect(html).not.toContain("Raw JSON");
  });

  test("round 11 (L7): the wizard's second wording change against main — the engine-notify line for an invalid setting names where to fix it, where main pointed at a form below", () => {
    // Main's line (5e53f4301, `lib/notify.ts:128-130`), as text. The wizard draws it (`routes/Wizard.svelte`, under a
    // command-line install's schedule note) through `engineNotifyLine`, the function pinned here.
    const MAIN = "The engine's configured notification setting is not one it accepts (it posts nothing) — this app is the notifier. The Settings form below can fix the value.";
    const line = engineNotifyLine({ value: "invalid", willNotify: false });
    expect(line).toBe("The engine's configured notification setting is not one it accepts (it posts nothing) — this app is the notifier. Fix it in Settings → Advanced, under Notifications from the engine.");
    expect(line.replace("Fix it in Settings → Advanced, under Notifications from the engine.", "The Settings form below can fix the value.")).toBe(MAIN);
  });

  test("Settings draws the master switch's box, then Connections (its label, its help) with the rows in the brief's order: the config's warnings and the read errors (as at 5b6fa8cc2), the Mac Calendar app, one row per link, then Test now and Add a connection…", () => {
    const html = draw({ os: "macos", initial: { configText: WIZ_CONFIG, list: WIZ_LIST, status: { ...WIZ_STATUS, configWarnings: ["a skipped link"] } } });
    // User-directed 2026-10-22: the master switch in its own box (a Tile) — the bold title naming the switch, its line,
    // and a native checkbox drawn as a switch (`role="switch"`), described by the line.
    const tiles = [...html.matchAll(/<section class="tile\b/g)].map((m) => m.index!);
    expect(tiles).toHaveLength(2);
    const master = html.slice(tiles[0]!, tiles[1]!);
    // C-M5-T15 moves this pin: the box's words are the title, MASTER_LINE, then C's LIVE_READ_LINE.
    expect(words(master)).toBe(
      "Show today's calendar in your briefing The AI then fits its suggestions around your meetings. Meeting links, people and notes are read live and never saved.",
    );
    expect(master).toMatch(/<label class="mtitle[^"]*" for="cal-master">Show today's calendar in your briefing<\/label>/);
    expect(master).toMatch(/<input id="cal-master" type="checkbox" role="switch" class="switch[^"]*" aria-describedby="cal-master-line" checked=""[^>]*\/>/);
    expect(master).toMatch(/<p class="mline[^"]*" id="cal-master-line">The AI then fits its suggestions around your meetings\.<\/p>/);
    // C-M5-T15: the live-read line, a second line under MASTER_LINE, NOT in the switch's description (which stays
    // `cal-master-line` alone): it explains the slide's live read, not what the switch does.
    expect(calModel.LIVE_READ_LINE).toBe("Meeting links, people and notes are read live and never saved.");
    expect(master).toMatch(/<p class="mline[^"]*" id="cal-master-line">[^<]*<\/p> <p class="mline[^"]*">Meeting links, people and notes are read live and never saved\.<\/p>/);
    expect(master.match(/aria-describedby="[^"]*"/g)).toEqual(['aria-describedby="cal-master-line"']);
    // The Connections box: its small-caps name with the ENABLED label at its right, then its help.
    const conn = html.slice(tiles[1]!);
    expect(conn).toMatch(/<div class="chead[^"]*"><h4[^>]*>Connections<\/h4> <span class="badge badge-on[^"]*">Enabled<\/span><\/div> <p class="help[^"]*" id="cal-conn-help">Your Mac's Calendar app, and private calendar links from Google, Outlook, iCloud or another calendar\.<\/p>/);
    const list = html.slice(html.indexOf('<ul class="sources'), html.indexOf("</ul>", html.indexOf('<ul class="sources')) + 5);
    const items = [...list.matchAll(/<li class="item\b[^"]*"/g)].map((m) => m.index!);
    const text = items.map((at, i) => words(list.slice(at, items[i + 1] ?? list.length)));
    expect(text[0]).toBe("a skipped link");
    expect(text[1]!.startsWith("Mac Calendar app Reads 2 calendars on this Mac · ● reader needs an update Update the calendar reader")).toBe(true);
    expect(text.slice(2, 7).map((t) => t.slice(0, t.indexOf(" ●")))).toEqual([
      "Home (Google) Google calendar link ·",
      "Work (Outlook) Calendar link ·",
      "team Calendar link ·",
      "mine Google calendar link ·",
      "envy Calendar link ·",
    ]);
    expect(text).toHaveLength(7);
    // The footer row after the list: Test now, then the primary Add a connection…, in one row.
    const foot = html.slice(html.indexOf('<div class="foot'));
    expect(html.indexOf('<div class="foot')).toBeGreaterThan(html.indexOf("</ul>", html.indexOf('<ul class="sources')));
    expect(foot).toMatch(/^<div class="foot[^"]*"><button type="button"[^>]*>Test now<\/button> <button type="button" class="primary[^"]*">Add a connection…<\/button><\/div>/);
    // Each source row: a header button naming the source with its status, controlling the details below it.
    const mac = rowOf(html, "cal-src-macos");
    expect(mac).toMatch(/<input type="checkbox" role="switch" class="switch[^"]*" aria-label="Read the Mac Calendar app" checked=""[^>]*\/>/);
    expect(headOf(mac)).toMatch(/^<button type="button" class="head ctl[^"]*" aria-expanded="true" aria-controls="cal-src-macos">/);
    expect(headOf(mac)).toMatch(/<span class="tag tone-warn[^"]*"><span aria-hidden="true">●<\/span> reader needs an update<\/span>/);
    // C-A: the icon (inline SVG, hidden from assistive technology), and the row's one action beside it.
    expect(headOf(mac)).toMatch(/<span class="ico[^"]*" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"[^>]*><rect x="3" y="4" width="18" height="12" rx="2"><\/rect><path d="M2 20h20"><\/path><\/svg><\/span>/);
    expect(mac).toMatch(/<\/button> <button type="button" class="act[^"]*">Update the calendar reader<\/button> <input type="checkbox" role="switch"/);
    expect(mac).toMatch(/<li class="item src[^"]*needs[^"]*">/);
    expect(headOf(mac)).toMatch(/<svg class="chev[^"]*"[^>]*aria-hidden="true"/);
    expect(mac).toMatch(/<div class="details[^"]*" id="cal-src-macos">/);
    expect(words(mac)).toContain("Every account you added on this Mac (iCloud, Google, Exchange and others).");
    for (const [id, tag, tone, open] of [
      ["home", "is this yours?", "warn", true],
      ["work", "couldn't read", "warn", true],
      ["team", "couldn't read", "warn", true],
      ["mine", "not read yet", "muted", false],
      ["envy", "add your email", "warn", true],
    ] as const) {
      const row = rowOf(html, `cal-src-link-${id}`);
      const head = headOf(row);
      expect({ id, expanded: /aria-expanded="(true|false)"/.exec(head)?.[1] }).toEqual({ id, expanded: String(open) });
      expect({ id, tag: new RegExp(`<span class="tag tone-${tone}[^"]*"><span aria-hidden="true">●</span> ${tag.replace("?", "\\?")}</span>`).test(head) }).toEqual({ id, tag: true });
      const details = new RegExp(`<div class="details[^"]*" id="cal-src-link-${id}"( hidden="")?>`).exec(row);
      expect({ id, hidden: details?.[1] === ' hidden=""' }).toEqual({ id, hidden: !open });
    }
    // A link's details hold everything its card held: name and id, last read, the prompt, the address, Remove.
    const home = rowOf(html, "cal-src-link-home");
    expect(home).toContain("<strong>Home (Google)</strong><span class=\"muted svelte-");
    for (const part of ["Last scheduled read: ok on Jan 5 at 07:21", "This link belongs to me@personal.example. Is this calendar yours?", "It's mine</button>", "No, it belongs to someone else</button>", "Remove…</button>"]) {
      expect({ part, inRow: home.includes(part) }).toEqual({ part, inRow: true });
    }
    expect(rowOf(html, "cal-src-link-team")).toContain("This link cannot be read: its saved address is missing; add the link again.");
    expect(rowOf(html, "cal-src-link-envy")).toContain('<label for="cal-owner-envy"');
    expect(rowOf(html, "cal-src-link-work")).toContain("Its address comes from a command");
    // No nested boxes: no row draws the old card classes.
    expect(list).not.toMatch(/class="(mac|links)\b/);
  });

  test("Settings: every other state the page has — granted, not granted, off, no links, the calendar off, unreadable settings, no config", () => {
    const granted = draw({ os: "macos", initial: { configText: WIZ_CONFIG, list: { ...WIZ_LIST, macos: { ...WIZ_LIST.macos!, notices: [] } }, status: WIZ_STATUS } });
    expect(headOf(rowOf(granted, "cal-src-macos"))).toMatch(/aria-expanded="false"/);
    // C-A: the count in the plain line, "allowed" in the tag.
    expect(headOf(rowOf(granted, "cal-src-macos"))).toMatch(/Reads 2 calendars on this Mac · <span class="tag tone-ok[^"]*"><span aria-hidden="true">●<\/span> allowed<\/span>/);
    expect(rowOf(granted, "cal-src-macos")).toMatch(/<div class="details[^"]*" id="cal-src-macos" hidden="">/);
    expect(rowOf(granted, "cal-src-macos")).toContain("Calendars to read");
    const ungranted = draw({ os: "macos", initial: { configText: WIZ_CONFIG, list: { ...WIZ_LIST, macos: { status: "not-granted", calendars: [] } }, status: WIZ_STATUS } });
    const asks = rowOf(ungranted, "cal-src-macos");
    expect(headOf(asks)).toMatch(/aria-expanded="true"/);
    expect(headOf(asks)).toContain("needs access");
    expect(asks).toContain("Allow access</button>");
    expect(asks).toContain("Daily Briefing Calendar Reader");
    const macOff = draw({ os: "macos", initial: { configText: CONFIG_NO_MAC, list: WIZ_LIST, status: WIZ_STATUS } });
    expect(headOf(rowOf(macOff, "cal-src-macos"))).toMatch(/<span class="tag tone-muted[^"]*"><span aria-hidden="true">●<\/span> off<\/span>/);
    expect(rowOf(macOff, "cal-src-macos")).toMatch(/<input type="checkbox" role="switch" class="switch[^"]*" aria-label="Read the Mac Calendar app"(?! checked)[^>]*\/>/);
    const linux = draw({ os: "linux", initial: { configText: WIZ_CONFIG, list: WIZ_LIST, status: WIZ_STATUS } });
    expect(linux).not.toContain("cal-src-macos");
    expect(linux).not.toContain("Mac Calendar app");
    // Linux has no Mac source: the help names links only.
    expect(linux).toContain("Private calendar links from Google, Outlook, iCloud or another calendar.");
    const empty = draw({ os: "linux", initial: { configText: CONFIG_NO_MAC, list: { schemaVersion: 1, macos: null, links: [] }, status: WIZ_STATUS } });
    expect(empty).toMatch(/<li class="item[^"]*"><p class="muted[^"]*">No calendar links yet\.<\/p><\/li>/);
    // No source to test: the footer holds Add alone.
    expect(empty).toMatch(/<div class="foot[^"]*">\s*<button type="button" class="primary[^"]*">Add a connection…<\/button><\/div>/);
    // The calendar off: the master switch off, the label DISABLED, the help in --danger saying why nothing is read.
    const calOff = draw({ os: "linux", initial: { configText: JSON.stringify({ calendar: { enabled: false, links: [{ id: "home" }] } }), list: WIZ_LIST, status: { ...WIZ_STATUS, enabled: false } } });
    expect(calOff).toMatch(/<input id="cal-master" type="checkbox" role="switch" class="switch[^"]*" aria-describedby="cal-master-line"(?! checked)[^>]*\/>/);
    expect(calOff).toMatch(/<span class="badge badge-off[^"]*">Disabled<\/span>/);
    expect(calOff).toMatch(/<p class="help[^"]* offhelp" id="cal-conn-help">The calendar is off, so these aren't read\. Turn it on above\.<\/p>/);
    // The rows stay usable: they are drawn (C1's "off" tags), with their details.
    expect(rowOf(calOff, "cal-src-link-home")).toContain("Remove…</button>");
    const bad = draw({ os: "linux", initial: { configText: JSON.stringify({ calendar: 5 }), list: WIZ_LIST, status: WIZ_STATUS } });
    expect(bad).toMatch(/<p class="bad[^"]*">The config's calendar settings could not be read\. Fix them with/);
    expect(bad).toMatch(/<input id="cal-master" type="checkbox" role="switch"[^>]*disabled=""[^>]*\/>/);
    expect(bad).toMatch(/<button type="button" class="primary[^"]*" disabled="">Add a connection…<\/button>/);
    const none = draw({ os: "macos", initial: { configText: null, list: null, status: null } });
    expect(none).toContain("which does not exist yet");
    expect(none).not.toContain("Add a connection");
    expect(none).not.toContain('class="sources');
    expect(none).not.toContain('role="switch"');
  });

  /* The style block, as rules (a server render has no layout: the rules are pinned by their exact selectors). */
  const styleOf = (s: string): string => s.slice(s.indexOf("<style>") + "<style>".length, s.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");
  /** Every rule, flat (a rule inside an `@media` block reads as its own selector), in order. */
  const ruleList = (css: string): [string, string][] =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.replace(/\s+/g, " ").trim(), m[2]!.replace(/\s+/g, " ").trim()]);
  /** The inside of the first `@media <query> {` block, and the style without it. */
  const media = (css: string, query: string): { rest: string; inside: string } => {
    const at = css.indexOf(`@media ${query} {`);
    if (at < 0) return { rest: css, inside: "" };
    let depth = 0;
    for (let i = css.indexOf("{", at); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) return { rest: css.slice(0, at) + css.slice(i + 1), inside: css.slice(css.indexOf("{", at) + 1, i) };
    }
    return { rest: css, inside: "" };
  };

  test("the wizard's styles are untouched: the rules its markup can match are 5b6fa8cc2's, verbatim; every other rule names .panel or a Settings-only class", () => {
    // `CalendarSettings.svelte`'s style block at 5b6fa8cc2, less its two `.panel` rules (Settings only).
    const BASE: [string, string][] = [
      [".calendar", "display: flex; flex-direction: column; gap: 0.5rem;"],
      ["p", "margin: 0;"],
      [".links", "list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem;"],
      [".links li, .add, .mac", "border: 1px solid var(--line); border-radius: 0.45rem; padding: 0.6rem 0.8rem; display: flex; flex-direction: column; gap: 0.4rem;"],
      [".name", "overflow-wrap: anywhere;"],
      [".row", "display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap;"],
      [".choice", "display: flex; gap: 0.5rem; align-items: flex-start;"],
      [".choice input", "margin-top: 0.25rem;"],
      [".field", "display: flex; flex-direction: column; gap: 0.25rem;"],
      [".field label", "font-size: 0.85rem; color: var(--muted);"],
      [".field input", "font: inherit; padding: 0.4rem 0.6rem; border-radius: 0.4rem; border: 1px solid var(--line); background: transparent; color: inherit;"],
      ["fieldset", "border: 1px solid var(--line); border-radius: 0.45rem; padding: 0.4rem 0.8rem 0.6rem; margin: 0; display: flex; flex-direction: column; gap: 0.3rem;"],
      ["legend", "padding: 0 0.3rem; font-size: 0.85rem;"],
      [".steps", "margin: 0; padding-left: 1.3rem; font-size: 0.9rem; display: flex; flex-direction: column; gap: 0.2rem;"],
      [".muted", "color: var(--muted);"],
      [".small", "font-size: 0.85rem;"],
      [".bad, .warn", "color: var(--danger); white-space: pre-wrap; overflow-wrap: anywhere;"],
      [".ok, .notice", "color: var(--muted);"],
      ["button", "font: inherit; padding: 0.4rem 0.9rem; border-radius: 0.45rem; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer;"],
      ["button:disabled", "opacity: 0.5; cursor: default;"],
      ["button.primary", "background: var(--accent); color: var(--on-accent); border-color: transparent;"],
      ["button.danger", "border-color: var(--danger); color: var(--danger);"],
    ];
    const all = ruleList(styleOf(src("lib/CalendarSettings.svelte")));
    const settingsScoped = (selector: string): boolean =>
      selector.split(",").every((part) => [...part.matchAll(/\.([\w-]+)/g)].some((m) => SETTINGS_ONLY.includes(m[1]!)));
    expect(all.filter(([sel]) => !settingsScoped(sel))).toEqual(BASE);
    // …and the scoped ones are not vacuous: the Settings look is there.
    expect(all.filter(([sel]) => settingsScoped(sel)).length).toBeGreaterThan(30);
  });

  test("the look: the S-A mockup's flat rows, status tag, footer row and buttons; the tones ≥ 4.5:1 on the tile in both themes", () => {
    const css = styleOf(src("lib/CalendarSettings.svelte"));
    const { rest, inside } = media(css, "(prefers-color-scheme: dark)");
    const top = new Map(ruleList(media(rest, "(prefers-reduced-motion: reduce)").rest));
    // The group's rows: edge to edge across the Tile (whose padding and the panel's make 14px), a hairline above each.
    expect(top.get(".sources")).toBe("list-style: none; margin: 8px -14px 0; padding: 0;");
    expect(top.get(".item")).toBe("padding: 9px 14px; border-top: 1px solid var(--tile-border); overflow-wrap: anywhere;");
    expect(top.get(".item.src")).toBe("padding: 0;");
    // C-A: the header button takes the row's room (the chevron, the icon, the name over its plain line); the row's own
    // action and the Mac switch at its right, in the line.
    expect(top.get(".panel button.head")).toBe(
      "display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; margin: 0; padding: 9px 4px 9px 14px; border: 0; border-radius: 0; background: transparent; color: inherit; font: inherit; text-align: left; outline-offset: -2px;",
    );
    expect(top.get(".line")).toBe("display: flex; align-items: center; gap: 10px; padding-right: 14px;");
    expect(top.get(".ico")).toBe("flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 7px; background: var(--panel); border: 1px solid var(--tile-border); color: var(--fg);");
    expect(top.get(".words")).toBe("flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px;");
    expect(top.get(".srcname")).toBe("font-weight: 600;");
    expect(top.get(".sub")).toBe("font-size: 12px; color: var(--muted);");
    expect(top.get(".item.src.needs")).toBe("background: var(--tint-needs);");
    expect(top.get(".tag")).toBe("font-size: 12px;");
    expect(top.get(".head[aria-expanded=\"true\"] .chev")).toBe("transform: rotate(90deg);");
    // The details: in place, flat, under the name (the head's 14px, the chevron's 10px and gap, the icon's 28px and gap);
    // a closed row's are not drawn.
    expect(top.get(".details")).toBe("display: flex; flex-direction: column; gap: 6px; padding: 0 14px 11px calc(14px + 10px + 10px + 28px + 10px);");
    expect(top.get(".details[hidden]")).toBe("display: none;");
    // The footer row (the mockup's `.row`): 11px 14px, a hairline above, the buttons on the right.
    expect(top.get(".foot")).toBe("display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 12px; margin: 0 -14px; padding: 11px 14px; border-top: 1px solid var(--tile-border);");
    expect(top.get(".box > .sources:last-child, .box > .foot:last-child, .box > .add:last-child")).toBe("margin-bottom: -11px;");
    expect(top.get(".panel .add")).toBe("margin: 0 -14px; padding: 11px 14px; border: 0; border-top: 1px solid var(--tile-border); border-radius: 0; gap: 8px;");
    expect(top.get(".panel fieldset")).toBe("border: 0; border-radius: 0; padding: 0; min-width: 0; gap: 4px;");
    // D's local button look (V10), the primary on the accent, the danger one V14's.
    expect(top.get(".panel button")).toBe("font-size: 12.5px; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--tile-border); background: var(--tile); color: var(--fg);");
    expect(top.get(".panel button.primary")).toBe("background: var(--accent); color: var(--on-accent); border-color: var(--accent);");
    expect(top.get(".panel button.danger")).toBe("color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--tile));");
    // Help at 12px in --muted; the inputs as the rows' (V10's folder input).
    expect(top.get(".panel .help")).toBe("font-size: 12px; color: var(--muted);");
    expect(top.get(".panel .small, .panel .steps")).toBe("font-size: 12px;");
    expect(top.get(".panel .field input")).toBe("font-size: 13px; padding: 5px 9px; border: 1px solid var(--tile-border); border-radius: 6px; background: var(--surface, var(--bg));");
    // The tones (V18's, as ProvidersList's): the mockup's green, Step 0's amber, the muted grey.
    expect(top.get(".tone-ok")).toBe("color: var(--tone-ok);");
    expect(top.get(".tone-warn")).toBe("color: var(--tag-local);");
    expect(top.get(".tone-muted")).toBe("color: var(--muted);");
    const okLight = /--tone-ok:\s*(#[0-9a-f]{6})/.exec(top.get(".panel") ?? "")?.[1] ?? "";
    const okDark = /--tone-ok:\s*(#[0-9a-f]{6})/.exec(new Map(ruleList(inside)).get(".panel") ?? "")?.[1] ?? "";
    expect([okLight, okDark]).toEqual(["#15803d", "#4ade80"]);
    const app = src("app.css");
    const appDark = app.slice(app.indexOf("@media (prefers-color-scheme: dark)"));
    const token = (sheet: string, name: string): string => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(sheet)?.[1] ?? "";
    const lum = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string): number => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    for (const [theme, sheet, ok] of [["light", app, okLight], ["dark", appDark, okDark]] as const) {
      const tile = token(sheet, "--tile");
      expect(tile).toMatch(/^#[0-9a-f]{6}$/);
      for (const [tone, value] of [["ok", ok], ["warn", token(sheet, "--tag-local")], ["muted", token(sheet, "--muted")]] as const) {
        expect({ theme, tone, ok: ratio(value, tile) >= 4.5 }).toEqual({ theme, tone, ok: true });
      }
    }
  });

  test("C-A (replaces tiny fix T2, whose checkbox slot is gone): every source row has the same leading slots — the head's padding, the chevron, the icon — so every name starts at one x, and the details start under it", () => {
    // T2 (visual MED 1) lined up a checkbox slot and a chevron slot. The master switch now has its own box and the Mac
    // switch sits at the row's right, so no row has a leading checkbox: each row's head is the same three slots.
    const css = styleOf(src("lib/CalendarSettings.svelte"));
    const top = new Map(ruleList(media(media(css, "(prefers-color-scheme: dark)").rest, "(prefers-reduced-motion: reduce)").rest));
    const n = (rule: string | undefined, prop: string): number => Number(new RegExp(`(?:^|; )${prop}: (-?[\\d.]+)px`).exec(rule ?? "")?.[1] ?? NaN);
    const head = top.get(".panel button.head");
    const headLeft = Number(/padding: [\d.]+px [\d.]+px [\d.]+px ([\d.]+)px;/.exec(head ?? "")?.[1] ?? NaN);
    const nameAt = headLeft + n(top.get(".chev"), "width") + n(head, "gap") + n(top.get(".ico"), "width") + n(head, "gap");
    expect(nameAt).toBe(72);
    const details = /padding: 0 14px 11px calc\(([\d.]+)px \+ ([\d.]+)px \+ ([\d.]+)px \+ ([\d.]+)px \+ ([\d.]+)px\);/.exec(top.get(".details") ?? "");
    expect(details?.slice(1).reduce((s, v) => s + Number(v), 0)).toBe(nameAt);
    // No rule left for a leading checkbox.
    for (const gone of [".panel .item > .choice input", ".line input", ".item > .choice", ".item.src > button.head"]) expect({ gone, rule: top.get(gone) }).toEqual({ gone, rule: undefined });
  });

  test("tiny fix, the LOWs: the Mac switch has its own name, and the Mac tag reads the last test as well", () => {
    // The checkbox's name was its row button's ("Mac Calendar app"), so a screen reader heard two controls by one name.
    // User-directed 2026-10-22: it is the switch now (`Switch`), with the same name.
    const html = draw({ os: "macos", initial: { configText: WIZ_CONFIG, list: WIZ_LIST, status: WIZ_STATUS } });
    const mac = rowOf(html, "cal-src-macos");
    expect(/role="switch" class="switch[^"]*" aria-label="([^"]*)"/.exec(mac)?.[1]).toBe("Read the Mac Calendar app");
    expect(words(headOf(mac)).startsWith("Mac Calendar app Reads 2 calendars on this Mac · ●")).toBe(true);
    const text = src("lib/CalendarSettings.svelte");
    // User-directed 2026-10-22 (C1): the Mac source's own tag, shown through the calendar's switch. Round 10 (M3): its
    // test answer only while the Mac source is on (`macTest`).
    expect(text).toContain('macSourceTag(macOn, list?.macos ?? null, readOf("macos", "macos"), macTest)');
    expect(text).toContain("const macTest = $derived(macOn ? tests[MAC_KEY] : undefined);");
  });

  test("tiny fix, the pin gaps (rev-d7's eight surviving mutants): each Settings behaviour below is held by a render or by its source", () => {
    const granted = { ...WIZ_LIST, macos: { ...WIZ_LIST.macos!, notices: [] } };
    // K1: "Test now" needs a link, or the Mac source on AND shown (macOS): on Linux a config with the Mac source on and
    // no link offers no test.
    const macOnly = JSON.stringify({ calendar: { enabled: true, macos: { calendars: "editable" }, links: [] } });
    const noLinks = { ...granted, links: [] };
    expect(draw({ os: "linux", initial: { configText: macOnly, list: noLinks, status: WIZ_STATUS } })).not.toContain("Test now");
    expect(draw({ os: "macos", initial: { configText: macOnly, list: noLinks, status: WIZ_STATUS } })).toContain("Test now");
    // K19: the Mac source's state is inside its collapsible details, not after them.
    const elementAt = (html: string, at: number): string => {
      const re = /<(\/?)div\b[^>]*>/g;
      re.lastIndex = at;
      let depth = 0;
      for (let m = re.exec(html); m !== null; m = re.exec(html)) {
        depth += m[1] === "" ? 1 : -1;
        if (depth === 0) return html.slice(at, re.lastIndex);
      }
      return "";
    };
    const page = draw({ os: "macos", initial: { configText: WIZ_CONFIG, list: granted, status: WIZ_STATUS } });
    const details = elementAt(page, page.indexOf('<div class="details', page.indexOf('aria-controls="cal-src-macos"')));
    expect(details).toMatch(/^<div class="details[^"]*" id="cal-src-macos" hidden="">/);
    expect(details).toContain("Calendars to read");
    expect(rowOf(page, "cal-src-macos").endsWith(`${details}</li>`)).toBe(true);
    // K22: a switched-off Mac source (its tag muted) needs nothing: its row stays closed.
    const macOff = draw({ os: "macos", initial: { configText: CONFIG_NO_MAC, list: WIZ_LIST, status: WIZ_STATUS } });
    expect(headOf(rowOf(macOff, "cal-src-macos"))).toMatch(/aria-expanded="false"/);
    expect(rowOf(macOff, "cal-src-macos")).toMatch(/<div class="details[^"]*" id="cal-src-macos" hidden="">/);
    // K8b: a read's day is its LOCAL day, not the date its timestamp is written with: one instant, two spellings (one
    // with a non-UTC offset), one tag — in any time zone the suite runs in.
    const known = { id: "x", configuredOwner: "me@x.example", confirmedOwner: null, urlFrom: "file" as const, fileStatus: "ok" as const };
    const seenAt = (at: string) => ({ read: { at, status: "ok" as const }, test: undefined, notices: [], declined: false, today: "2026-01-06" });
    const offset = linkSourceTag(known, seenAt("2026-01-05T23:30:00-08:00"));
    expect(offset).toEqual(linkSourceTag(known, seenAt("2026-01-06T07:30:00.000Z")));
    expect(offset?.tone).toBe("ok");
    // Source pins for what a server render cannot reach (it clicks nothing; `busy` and `adding` start false).
    const text = src("lib/CalendarSettings.svelte");
    // User-directed 2026-10-22: Settings' whole page is the first `{#if mode === "settings"}` block (the slice moved with it).
    const settings = text.slice(text.indexOf('<section class="calendar"'), text.indexOf('  {#if mode === "settings"}\n    <!-- Settings draws all'));
    // K11: the Mac switch is disabled while a write runs.
    // Round 9 (L13): and while the calendar is off it is described by the line saying so.
    expect(settings).toContain('<Switch label="Read the Mac Calendar app" describedby={calOn ? undefined : "cal-conn-help"} checked={macOn} disabled={busy || block === null} onchange={(on) => setMac(on)} />');
    // K13: the footer (Test now) stays while the add flow (or the Add a connection choice) is open; only Add goes.
    expect(settings).toContain('{#if testable || (!adding && !choosing)}\n            <div class="foot">');
    // K15: the status's error only when the list's is not shown.
    expect(settings).toContain('{#if statusError !== null && listError === null}\n              <li class="item"><p class="bad">{statusError}</p></li>');
    // K27: a row's details are hidden exactly when the row is closed — a row that needs the user can be closed.
    expect(settings).toContain('<div class="details" id="cal-src-macos" hidden={!isOpen(MAC_KEY)}>');
    expect(settings).toContain('<div class="details" id="cal-src-link-{link.id}" hidden={!isOpen(key)}>');
    // The LOWs: the config's warnings and the read errors before the source rows, as at 5b6fa8cc2; the test's error after.
    // The master switch is in its own box before them all.
    const order = [
      '<label class="mtitle" for="cal-master">{MASTER_TITLE}</label>',
      "{#each configWarningLines(status) as warning, i (i)}",
      '{#if listError !== null}\n              <li class="item"><p class="bad">{listError}</p></li>',
      "{#if statusError !== null && listError === null}",
      "{#if showMac}",
      "{#each list.links as link (link.id)}",
      "{#if testable && testError !== null}",
    ].map((part) => ({ part: part.slice(0, 40), count: settings.split(part).length - 1, at: settings.indexOf(part) }));
    expect(order.map(({ part, count }) => ({ part, count }))).toEqual(order.map(({ part }) => ({ part, count: 1 })));
    expect(order.map((x) => x.at)).toEqual([...order.map((x) => x.at)].sort((a, b) => a - b));
  });

  test("the wizard's template is 5b6fa8cc2's, as source — also in the states a server render cannot reach (the add flow's stages, Remove's confirmation, a \"No\", a test's answer, the leftover, a message)", () => {
    // The wizard's branch with the four snippets it shares with Settings (`unreadable`, `macState`, `linkBody`, `addPanel`) expanded
    // where it renders them, comments dropped and whitespace runs as one space, against 5b6fa8cc2's `{:else}` branch of
    // the loaded panel normalised the same way. Exactly two differences are normalised, both drawing nothing in the
    // wizard: (1) 5b6fa8cc2 drew the switch under `{#if mode === "settings" && block !== null}` before its
    // `{:else if block === null}` line, and the wizard branch keeps only `{#if block === null}`; (2) a snippet's
    // `{@const}`s sit inside it, so inside the `<li>` that renders it, where 5b6fa8cc2 had them just before the `<li>`.
    // ⚠ So a change inside a shared snippet changes the wizard: keep Settings-only markup out of them.
    // ⚠ Round 10 (L3): the baseline is 5b6fa8cc2's source, not main's: against main this step's one change is the
    // `unreadable` line's wording (f71284ef3: Edit settings as JSON for the Raw JSON tab), pinned in "the wizard's calendar
    // step's one wording change". (Round 11, L7: the wizard's other one, the engine-notify line, is outside this step.)
    const text = src("lib/CalendarSettings.svelte");
    const ws = (s: string): string => s.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
    const snippet = (name: string): string => {
      const at = text.indexOf(`{#snippet ${name}(`);
      return text.slice(text.indexOf("}", at) + 1, text.indexOf("{/snippet}", at));
    };
    let wizard = text.slice(text.indexOf('  {:else}\n    {#if block === null}'), text.lastIndexOf("  {/if}\n</section>"));
    for (const [tag, name] of [["{@render unreadable()}", "unreadable"], ["{@render macState()}", "macState"], ["{@render linkBody(link)}", "linkBody"], ["{@render addPanel()}", "addPanel"]] as const) {
      expect({ tag, once: wizard.split(tag).length === 2 }).toEqual({ tag, once: true });
      wizard = wizard.replace(tag, snippet(name));
    }
    const consts = '{@const prompt = ownerPrompt(link)} {@const problem = fileProblem(link)} {@const from = urlFromLine(link)} {@const tested = testedLine(tests[sourceKey("link", link.id)])}';
    const expanded = ws(wizard).replace(`<li> ${consts}`, `${consts} <li>`);
    expect({ length: expanded.length, sha: createHash("sha256").update(expanded).digest("hex") }).toEqual({
      length: 9472,
      sha: "ab4dcd07fe693b6f564337240f7170c6910951e3003a1d36c70fa2ec54f3984c",
    });
  });

  test("source pins: Settings' lines a server render cannot reach are drawn, in the brief's places: the test's error and the leftover as rows, then the footer, the summary, the add flow, the message", () => {
    const text = src("lib/CalendarSettings.svelte");
    const settings = text.slice(text.indexOf('<section class="calendar"'), text.indexOf('  {#if mode === "settings"}\n    <!-- Settings draws all'));
    const parts = [
      '{#if testable && testError !== null}\n              <li class="item"><p class="bad">{testError}</p></li>',
      '{#if leftover !== null}\n              <li class="item">',
      'onclick={() => leftover !== null && void remove(leftover)}>Remove that saved link</button>',
      "</ul>",
      '<div class="foot">',
      '{#if testable && testedAt !== null && testError === null}\n            <p class="muted small">Tested just now: each source read once, the way the morning run reads it.</p>',
      // C-A: the Add a connection choice, then the link flow (unchanged).
      '{#if choosing && !adding}',
      '{#if adding}\n            <div class="add">\n              {@render addPanel()}',
      '{#if message !== null}\n            <p class={message.bad ? "bad" : "ok"} role="status">{message.text}</p>',
      "{#each warnings as w, i (i)}",
    ];
    const at = parts.map((p) => ({ p: p.slice(0, 40), count: settings.split(p).length - 1, index: settings.indexOf(p) }));
    expect(at.map(({ p, count }) => ({ p, count }))).toEqual(parts.map((p) => ({ p: p.slice(0, 40), count: 1 })));
    expect(at.map((x) => x.index)).toEqual([...at.map((x) => x.index)].sort((a, b) => a - b));
  });

  test("source pins: the open rows are state, seeded from the first snapshot and moved on by nextOpenRows after every change; a click only flips its own row; nothing takes focus", () => {
    const component = src("lib/CalendarSettings.svelte");
    expect(component).toContain("let rows = $state.raw<OpenRows>(nextOpenRows({ open: {}, needed: {} }, untrack(() => needs)));");
    expect(component).toMatch(/\$effect\(\(\) => \{\n\s*const now = needs;\n\s*untrack\(\(\) => \(rows = nextOpenRows\(rows, now\)\)\);\n\s*\}\);/);
    expect(component).toContain("rows = withRowOpen(rows, key, !isOpen(key));");
    expect(component).toContain("const isOpen = (key: string): boolean => isSet(rows.open, key);");
    // The needs come from the tags, so a row opens exactly when its tag asks for the user.
    expect(component).toMatch(/const needs = \$derived\.by\(\(\): Record<string, boolean> => \{[\s\S]*?tone === "warn"[\s\S]*?\}\);/);
    // An auto-opened row never steals focus, and a toggle leaves it on its button. User-directed 2026-10-22 (C-A): the
    // one focus move is a row's own action button's (`act`), on its click — never on a refresh or an auto-open. Round 9
    // (L8): and Settings' Add a connection… and its picker's choices (`focusFirst`, Settings only), on their click. Round
    // 10 (M4): and after the user's own Allow access / Update the calendar reader (`refocus`, Settings only), only when
    // the focus fell to the page.
    expect(component).not.toMatch(/autofocus|focusHeading/);
    // PB-M6-T1: and the fourth — startAdding's chosen provider control, once, within this panel (`beginAdding`).
    expect(component.match(/\.focus\(/g)).toHaveLength(4);
    expect(component).toMatch(/async function focusFirst\(selectors: readonly string\[\]\): Promise<void> \{\s*if \(mode !== "settings"\) return;\s*await tick\(\);\s*for \(const s of selectors\) \{\s*const el = document\.querySelector<HTMLElement>\(s\);\s*if \(el !== null\) return el\.focus\(\);\s*\}\s*\}/);
    expect(component).toMatch(/async function refocus\(from: Element \| null, head: string\): Promise<void> \{\s*if \(mode !== "settings"\) return;\s*await tick\(\);\s*const now = document\.activeElement;\s*if \(now !== null && now !== document\.body\) return;/);
    expect(component.match(/refocus\(/g)).toHaveLength(2);
    expect(component.match(/focusFirst\(/g)).toHaveLength(5);
    const act = component.slice(component.indexOf("async function act("), component.indexOf("\n  }\n", component.indexOf("async function act(")));
    expect(act).toContain("target?.focus();");
    // The open rows are `$state.raw` (round 12): `act` replaces them whole, and no in-place write can come back.
    expect(act).toContain("rows = withRowOpen(rows, key, true);");
    expect(component).not.toMatch(/rows\.open\[[^\]]+\]\s*=/);
    expect(component.match(/void act\(/g)).toHaveLength(2);
    expect(component).toMatch(/<button type="button" class="act" onclick=\{\(\) => void act\(MAC_KEY, "cal-src-macos", a\)\}>\{a\.label\}<\/button>/);
  });

  /* ── user-directed 2026-10-22 (C1): while the calendar is off, every source says "off" ── */

  const cm = calModel as unknown as Record<string, unknown>;
  const shown = (on: boolean, tag: unknown): unknown => (cm["shownSourceTag"] as (on: boolean, t: unknown) => unknown)(on, tag);
  const calendarOn = (block: CalendarBlock | null): unknown => (cm["calendarOn"] as (b: CalendarBlock | null) => unknown)(block);
  const OFF_CONFIG = JSON.stringify({ calendar: { ...JSON.parse(WIZ_CONFIG).calendar, enabled: false } });

  test("C1: the decision, by value — off (muted) for every source while the switch is off; the source's own tag while it is on", () => {
    const tags = [
      null,
      { text: "allowed · 2 calendars", tone: "ok" },
      { text: "needs access", tone: "warn" },
      { text: "read today 07:24", tone: "ok" },
      { text: "is this yours?", tone: "warn" },
      { text: "not read yet", tone: "muted" },
    ];
    for (const tag of tags) {
      expect({ tag, off: shown(false, tag) }).toEqual({ tag, off: { text: "off", tone: "muted" } });
      expect({ tag, on: shown(true, tag) }).toEqual({ tag, on: tag });
    }
    // The switch is the engine's `calendar.enabled === true` (src/calendar/config.ts): absent, false or unreadable is off.
    expect([calendarOn({ enabled: true }), calendarOn({ enabled: false }), calendarOn({}), calendarOn(null)]).toEqual([true, false, false, false]);
  });

  test("C1: drawn — with the switch off, the Mac row and every link row say off, and nothing opens by itself; their details are all there", () => {
    const off = draw({ os: "macos", initial: { configText: OFF_CONFIG, list: WIZ_LIST, status: { ...WIZ_STATUS, enabled: false } } });
    for (const id of ["cal-src-macos", "cal-src-link-home", "cal-src-link-work", "cal-src-link-team", "cal-src-link-mine", "cal-src-link-envy"]) {
      const row = rowOf(off, id);
      // Round 9 (L13): the Mac row, whose own switch is on, says whose switch is off.
      const offTag = id === "cal-src-macos" ? "off \\(calendar off\\)" : "off";
      expect({ id, tag: new RegExp(`<span class="tag tone-muted[^"]*"><span aria-hidden="true">●</span> ${offTag}</span>`).test(headOf(row)) }).toEqual({ id, tag: true });
      expect({ id, expanded: /aria-expanded="false"/.test(headOf(row)) }).toEqual({ id, expanded: true });
      // Closed, not gone: the details are drawn (hidden), so opening the row shows them and they work.
      expect({ id, details: new RegExp(`<div class="details[^"]*" id="${id}" hidden="">`).test(row) }).toEqual({ id, details: true });
    }
    expect(rowOf(off, "cal-src-link-home")).toContain("It's mine</button>");
    expect(rowOf(off, "cal-src-macos")).toContain("Calendars to read");
    // On again: each row's own tag, as before.
    const on = draw({ os: "macos", initial: { configText: WIZ_CONFIG, list: WIZ_LIST, status: WIZ_STATUS } });
    expect(headOf(rowOf(on, "cal-src-macos"))).toContain("reader needs an update");
    expect(headOf(rowOf(on, "cal-src-link-home"))).toContain("is this yours?");
    // The component reads the decision; it does not restate it.
    const component = src("lib/CalendarSettings.svelte");
    // Round 9 (M2, M3): with the engine's own on/off (`calendarReadOn`), and this mount's test answer for the source.
    expect(component).toContain("const calOn = $derived(calendarReadOn(block, status));");
    // Round 10 (M3): the Mac source's answer only while it is itself on.
    expect(component).toContain("const macTag = $derived(shownSourceTag(calOn, macSourceTag(macOn, list?.macos ?? null, readOf(\"macos\", \"macos\"), macTest), macTest));");
    expect(component).toMatch(/const linkTag = \(link: CalendarLinkInfo\): SourceTag \| null =>\s*shownSourceTag\(\s*calOn,[\s\S]*?\}\),\s*tests\[sourceKey\("link", link\.id\)\],\s*\);/);
  });
});

/* ── user-directed 2026-10-22 (C2): in Settings a source no longer turns the calendar back on ─────── */

describe("C2: in Settings, turning a source on or adding a link leaves the calendar's switch as it is; the wizard still turns it on", () => {
  const cm = calModel as unknown as Record<string, unknown>;
  const macos = (b: CalendarBlock, on: boolean, turnOn?: boolean) => (withMacos as (b: CalendarBlock, on: boolean, t?: boolean) => CalendarBlock)(b, on, turnOn);
  const entry = (b: CalendarBlock, id: string, name: string, turnOn?: boolean) =>
    (withLinkEntry as (b: CalendarBlock, id: string, name: string, t?: boolean) => CalendarBlock)(b, id, name, turnOn);
  const LINE = "The calendar is off, so this source is not read until you turn it on above.";

  test("the edits: with turnOn false, `enabled` stays as written — false, or absent; the default (the wizard's) still turns it on", () => {
    expect(macos({ links: [] }, true, false)).toEqual({ links: [], macos: { calendars: "editable" } });
    expect(macos({ enabled: false, links: [] }, true, false)).toEqual({ enabled: false, links: [], macos: { calendars: "editable" } });
    expect(entry({}, "a", "", false)).toEqual({ links: [{ id: "a" }] });
    expect(entry({ enabled: false, x: 1 }, "a", "A", false)).toEqual({ enabled: false, x: 1, links: [{ id: "a", name: "A" }] });
    // Unchanged where nothing says otherwise (the wizard's path, byte for byte).
    expect(macos({ links: [] }, true)).toEqual({ enabled: true, links: [], macos: { calendars: "editable" } });
    expect(entry({}, "a", "")).toEqual({ enabled: true, links: [{ id: "a" }] });
    expect(Object.keys(entry({ enabled: false, x: 1 }, "a", ""))).toEqual(["enabled", "x", "links"]);
  });

  test("addLink with turnOn false saves the link and leaves `enabled` alone; without the option it turns the calendar on", async () => {
    const off = { calendar: { enabled: false, links: [] } };
    const settings = fakes({ config: off });
    const r = await (addLink as (...a: unknown[]) => Promise<{ kind: string }>)({ id: "home", name: "", takeUrl: field().takeUrl }, settings.deps, describeFailure, { turnOn: false });
    expect(r.kind).toBe("added");
    expect(settings.rec.saved).toEqual([{ enabled: false, links: [{ id: "home" }] }]);
    const wizard = fakes({ config: off });
    await addLink({ id: "home", name: "", takeUrl: field().takeUrl }, wizard.deps, describeFailure);
    expect(wizard.rec.saved).toEqual([{ enabled: true, links: [{ id: "home" }] }]);
  });

  test("the one line that explains C1's \"off\": only while the calendar is off", () => {
    const note = cm["offSourceNote"] as (b: CalendarBlock | null) => string | null;
    expect(note({ enabled: false })).toBe(LINE);
    expect(note({})).toBe(LINE);
    expect(note({ enabled: true })).toBeNull();
    // An unreadable block says nothing (its own row says it cannot be read).
    expect(note(null)).toBeNull();
  });

  test("the component: Settings passes turnOn false and says the line; the wizard passes what it always did", () => {
    const component = src("lib/CalendarSettings.svelte");
    // Round 10: the write's promise is answered (H1, the switch), and the Mac source's test answer goes with it (M3).
    expect(component).toContain("return write(() => editBlock((b) => withMacos(b, on, mode === \"wizard\"), deps, describeFailure), macSaved(on), [MAC_KEY]);");
    expect(component).toContain("const result = await addLink({ id, name: linkName, takeUrl }, deps, describeFailure, { turnOn: mode === \"wizard\" });");
    // The line is Settings' only: the wizard's mode never sets it.
    expect(component).toMatch(/const macSaved = \(on: boolean\): string => \{\s*const off = mode === "settings" && on \? offSourceNote\(block\) : null;\s*return off === null \? "Calendar setting saved\." : `Calendar setting saved\. \$\{off\}`;\s*\};/);
    expect(component).toMatch(/if \(mode === "settings"\) \{\s*const off = offSourceNote\(block\);\s*if \(off !== null\) message = \{ bad: false, text: off \};\s*\}/);
  });
});

/* ── PB-M3-T2: every status read and calendar write through the store (wave-2 polish spec §5) ──────── */

describe("PB-M3-T2: CalendarSettings reads and writes through the Today store (script only)", () => {
  const raw = src("lib/CalendarSettings.svelte");
  const script = raw.slice(0, raw.indexOf("</script>"))
    .replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1")
    .replace(/(^|[ \t])\/\/[^\n]*/gm, "$1")
    .replace(/\s+/g, " ");
  const fn = (head: string): string => {
    const at = script.indexOf(head);
    expect({ head, found: at > -1 }).toEqual({ head, found: true });
    const next = script.slice(at + head.length).search(/ (async function |function )/);
    return script.slice(at, next === -1 ? undefined : at + head.length + next);
  };

  test("the store's functions are imported; every save goes through storeSaveBlock, every link write through storeWrite", () => {
    expect(script).toContain('import { connectWrote, readStatusThroughStore, storeLinkRemove, storeSaveBlock, storeWrite } from "./today-store";');
    expect(script).toContain(
      "const deps: CalendarDeps = { writeLink: (id, url) => storeWrite(() => calendarLinkWrite(id, url), () => true), readConfig: configRead, saveBlock: storeSaveBlock(calendarConfigSave), list: () => calendarList(), };",
    );
  });

  test("refresh() reads status through the store with the plan's exact composition, and still shows its own reply and error", () => {
    expect(fn("async function refresh(")).toContain(
      "readStatus(() => readStatusThroughStore(() => calendarStatus()).then((r) => { if (r.outcome === null) throw r.error; return r.outcome; }), describeFailure),",
    );
    expect(script).not.toContain("readStatus(() => calendarStatus(), describeFailure)");
    expect(fn("async function refresh(")).toContain("status = read.status; statusError = read.error; onstatus?.(calendarStatusOk(read));");
  });

  test("remove() and allowAccess() write through storeWrite; Allow access is calendarConnectMac only, accepted by connectWrote", () => {
    // Checkpoint MED: a resolved removal wrote (Rust deletes the link file before its config step), so it goes
    // through storeLinkRemove, whose acceptance is "it resolved" (today-store.check.ts).
    expect(script).toContain("const removeLink = storeLinkRemove(calendarLinkRemove);");
    expect(fn("async function remove(")).toContain("const removed = await removeLink(id);");
    const allow = fn("async function allowAccess(");
    expect(allow).toContain("const said = connectMacMessage(await storeWrite(() => calendarConnectMac(), connectWrote));");
    expect(allow).not.toContain("storeSaveBlock");
    expect(allow).not.toContain("saveBlock");
    // No inline copy of the connect rule anywhere in the component.
    expect(raw).not.toContain("configUpdated");
    // Each raw wrapper is named once, inside its store bracket.
    expect(script.split("calendarLinkRemove").length - 1).toBe(2);   // the import, and storeLinkRemove(calendarLinkRemove)
    for (const call of ["calendarConnectMac(", "calendarLinkWrite(", "calendarStatus("]) {
      expect({ call, n: script.split(call).length - 1 }).toEqual({ call, n: 1 });
    }
  });

  describe("behaviour (mocked invoke): a Settings write in flight makes a concurrent Today driver read `dropped`", () => {
    type Json = Record<string, unknown>;
    const g = globalThis as { window?: unknown };
    let hadWindow = false;
    let windowBefore: unknown;
    let handler: (command: string, args: Json | undefined) => unknown;
    beforeEach(() => {
      hadWindow = "window" in g;
      windowBefore = g.window;
      g.window = { __TAURI_INTERNALS__: { invoke: (command: string, args: Json | undefined) => Promise.resolve().then(() => handler(command, args)) } };
    });
    afterEach(() => {
      if (hadWindow) g.window = windowBefore;
      else delete g.window;
    });

    test("Settings' save (editBlock over storeSaveBlock(calendarConfigSave)) in flight: Today's read through the store is dropped; once it settles a read applies", async () => {
      let release!: (o: SaveOutcome) => void;
      const saved = new Promise<SaveOutcome>((resolve) => (release = resolve));
      const statusOutcome = { operation: "calendar-status", outcome: { kind: "delivered" }, exitCode: 0, payload: { schemaVersion: 1, enabled: true, enabledSet: true, macSupported: false, configWarnings: [], sources: [] }, stdout: "", stderr: "" };
      const seen: string[] = [];
      handler = (command) => {
        seen.push(command);
        if (command === "config_read") return { path: "/c.json", exists: true, text: JSON.stringify({ calendar: { enabled: false } }), base: "b", parseError: null, apiKeyRedacted: false };
        if (command === "calendar_config_save") return saved;
        if (command === "engine_calendar_status") return statusOutcome;
        throw new Error(`unexpected ${command}`);
      };
      // Settings' deps, as CalendarSettings builds them (pinned above).
      const deps = { readConfig: configRead, saveBlock: storeSaveBlock(calendarConfigSave) };
      const writing = calModel.editBlock((b) => calModel.withEnabled(b, true), deps, describeFailure);
      for (let i = 0; i < 20 && todayStore().writesInFlight === 0; i++) await Promise.resolve();
      expect(todayStore().writesInFlight).toBe(1);   // PREMISE: the save is in flight
      // Today's driver read (its composition: readStatusThroughStore(() => calendarStatus())).
      const during = await readStatusThroughStore(() => calendarStatus());
      expect(during.verdict).toBe("dropped");
      expect(during.outcome).toEqual(statusOutcome as unknown as EngineOutcome);
      expect(todayStore().status).toBeNull();
      release({ kind: "saved", path: "/c.json", backupPath: "/c.json.bak", warnings: [] });
      expect(await writing).toEqual({ ok: true, warnings: [] });
      expect(todayStore().writesInFlight).toBe(0);
      expect(seen).toEqual(["config_read", "calendar_config_save", "engine_calendar_status"]);
      // After it settled, a read applies.
      expect((await readStatusThroughStore(() => calendarStatus())).verdict).toBe("applied");
      expect(todayStore().status?.enabled).toBe(true);
    });
  });
});

/* ── PB-M6-T1: CalendarSettings' five props, the Settings lock and its busy line (wave-2 polish spec §4) ─────── */

describe("PB-M6-T1: the startAdding step and its focus target are pure (calendar-settings.ts)", () => {
  type Step = { open: boolean; done: boolean };
  const step = (requested: boolean, loaded: boolean, done: boolean): Step =>
    (calModel as unknown as { startAddingStep: (r: boolean, l: boolean, d: boolean) => Step }).startAddingStep(requested, loaded, done);

  test("startAdding requested before load does nothing; the first loaded state opens once; later loads and refreshes never reopen", () => {
    // Not requested: never, loaded or not.
    expect([step(false, false, false), step(false, true, false)]).toEqual([{ open: false, done: false }, { open: false, done: false }]);
    // Requested, not loaded yet: nothing, and the latch stays open for the load.
    expect(step(true, false, false)).toEqual({ open: false, done: false });
    // The first loaded state: open, and latch.
    expect(step(true, true, false)).toEqual({ open: true, done: true });
    // Every later run (a refresh sets `loaded` again; a re-render) keeps the latch and opens nothing.
    expect([step(true, true, true), step(true, false, true), step(false, true, true)])
      .toEqual([{ open: false, done: true }, { open: false, done: true }, { open: false, done: true }]);
    // The sequence a mount goes through: before load, the load, two refreshes.
    let done = false;
    const opened: boolean[] = [];
    for (const loaded of [false, true, true, true]) {
      const s = step(true, loaded, done);
      done = s.done;
      opened.push(s.open);
    }
    expect(opened).toEqual([false, true, false, false]);
  });

  test("the focus target: the checked provider radio first, else the first provider control — chosen within the given section; the helper never focuses", () => {
    const target = (calModel as unknown as { startAddingFocusTarget: <T>(s: { querySelector(sel: string): T | null } | null | undefined) => T | null }).startAddingFocusTarget;
    const focused: string[] = [];
    const node = (name: string) => ({ name, focus: () => focused.push(name) });
    const asked: string[] = [];
    const section = (found: Record<string, { name: string }>) => ({
      querySelector: (sel: string) => {
        asked.push(sel);
        return found[sel] ?? null;
      },
    });
    const SELECTORS = (calModel as unknown as { START_ADDING_FOCUS: readonly string[] }).START_ADDING_FOCUS;
    expect(SELECTORS).toEqual(['.add:not(.picker) input[name="cal-provider"]:checked', '.add:not(.picker) input[name="cal-provider"]']);
    const checked = node("checked");
    const first = node("first");
    // Both match: the checked radio wins.
    expect(target(section({ [SELECTORS[0]!]: checked, [SELECTORS[1]!]: first }))).toBe(checked);
    // No radio checked: the first provider control.
    asked.length = 0;
    expect(target(section({ [SELECTORS[1]!]: first }))).toBe(first);
    expect(asked).toEqual([...SELECTORS]);
    // Nothing drawn yet, or no section bound: nothing.
    expect(target(section({}))).toBeNull();
    expect(target(null)).toBeNull();
    expect(target(undefined)).toBeNull();
    // A choice only: the component calls focus, never the helper.
    expect(focused).toEqual([]);
  });
});

describe("PB-M6-T1: linkOnly, and the five props in the script (server renders and source pins)", () => {
  const draw = (props: Record<string, unknown>): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(CalendarSettings as any, { props }).body.replace(/<!--[\s\S]*?-->/g, "");
  const config = JSON.stringify({ calendar: { enabled: true, macos: { calendars: "editable" }, links: [{ id: "home" }] } });
  const initial = { configText: config, list: LIST, status: STATUS };

  test("linkOnly hides the Mac section on a Mac, in the wizard's mode and in Settings'; without it the Mac section shows", () => {
    for (const mode of ["wizard", "settings"] as const) {
      const shown = draw({ os: "macos", mode, macAvailable: true, initial });
      const hidden = draw({ os: "macos", mode, macAvailable: true, linkOnly: true, initial });
      expect({ mode, shown: shown.includes("Mac Calendar app") }).toEqual({ mode, shown: true });
      expect({ mode, hidden: hidden.includes("Mac Calendar app") }).toEqual({ mode, hidden: false });
      expect({ mode, hidden: hidden.includes("Calendars to read") }).toEqual({ mode, hidden: false });
      // The links still show.
      expect({ mode, links: hidden.includes("Home (Google)") }).toEqual({ mode, links: true });
    }
  });

  const component = src("lib/CalendarSettings.svelte");
  const script = component.slice(0, component.indexOf("</script>"));
  const fnBody = (head: string): string => {
    const at = script.indexOf(head);
    expect({ head, found: at > -1 }).toEqual({ head, found: true });
    return script.slice(at, script.indexOf("\n  }\n", at) + 4);
  };

  test("the five props are optional, declared and destructured with their defaults; showMac follows linkOnly", () => {
    for (const decl of [
      "    linkOnly?: boolean;\n",
      "    startAdding?: boolean;\n",
      "    onaddclosed?: ((closed: { leftover: boolean }) => void) | undefined;\n",
      "    onleftovercleared?: (() => void) | undefined;\n",
      "    locked?: boolean;\n",
    ]) expect({ decl, declared: script.includes(decl) }).toEqual({ decl, declared: true });
    const end = script.indexOf("$props()");
    const destructure = script.slice(script.lastIndexOf("let {", end), end);
    for (const d of ["linkOnly = false,", "startAdding = false,", "onaddclosed,", "onleftovercleared,", "locked = false,"]) {
      expect({ d, destructured: destructure.includes(`\n    ${d}\n`) }).toEqual({ d, destructured: true });
    }
    expect(script).toContain("const showMac = $derived(!linkOnly && macSectionShown(os, macAvailable));");
  });

  test("closeAdd (Done and Cancel) reports whether a link file is left over; remove reports clearing it, beside the clear", () => {
    expect(fnBody("function closeAdd(")).toMatch(/function closeAdd\(\): void \{\n\s*takeUrl\(\);\n\s*adding = false;\n\s*added = null;\n\s*onaddclosed\?\.\(\{ leftover: leftover !== null \}\);\n\s*\}/);
    // Done and Cancel both reach it (the add panel's two buttons), unchanged.
    expect(component).toContain('<button type="button" onclick={closeAdd}>Done</button>');
    expect(component).toContain('<button type="button" disabled={busy} onclick={closeAdd}>Cancel</button>');
    expect(fnBody("async function remove(")).toMatch(/if \(leftover === id\) \{\n\s*leftover = null;\n\s*onleftovercleared\?\.\(\);\n\s*\}/);
    expect(component.match(/onaddclosed\?\.\(/g)).toHaveLength(1);
    expect(component.match(/onleftovercleared\?\.\(/g)).toHaveLength(1);
  });

  test("startAdding: after the first onMount, a once-only step opens the add flow, then — after tick — focuses this instance's chosen provider control", () => {
    const first = script.indexOf("onMount(");
    const effect = script.indexOf("const step = startAddingStep(startAdding, loaded, startedAdding);");
    expect(effect).toBeGreaterThan(first);
    expect(script).toMatch(/\$effect\(\(\) => \{\n\s*const step = startAddingStep\(startAdding, loaded, startedAdding\);\n\s*startedAdding = step\.done;\n\s*if \(step\.open\) untrack\(\(\) => void beginAdding\(\)\);\n\s*\}\);/);
    expect(script).toContain("let startedAdding = false;");
    expect(fnBody("async function beginAdding(")).toMatch(/openAdd\(\);\n\s*await tick\(\);\n\s*startAddingFocusTarget<HTMLElement>\(calendarEl\)\?\.focus\(\);/);
    // The query is scoped to THIS panel's section (bound on the outer section, no wrapper), never the document.
    expect(script).toContain("let calendarEl = $state<HTMLElement | undefined>(undefined);");
    expect(component).toContain('<section class="calendar" class:panel={mode === "settings"} bind:this={calendarEl}>');
    expect(component.match(/bind:this=\{calendarEl\}/g)).toHaveLength(1);
    // A server render emits no binding: the section's tag is unchanged on the page.
    const html = draw({ os: "linux", mode: "wizard", initial });
    expect(html).toMatch(/<section class="calendar svelte-\w+">/);
  });
});

describe("PB-M6-T1: the Settings lock is folded in the script (source pins: a server render clicks nothing and runs no onMount)", () => {
  const component = src("lib/CalendarSettings.svelte");
  const script = component.slice(0, component.indexOf("</script>"));
  const settings = component.slice(component.indexOf('<section class="calendar"'), component.indexOf('  {#if mode === "settings"}\n    <!-- Settings draws all'));
  const wizard = component.slice(component.indexOf('  {:else}\n    {#if block === null}'), component.lastIndexOf("  {/if}\n</section>"));

  test("the panel's own write state is `working`; `busy` is derived from it and `locked`; every write guard reads busy", () => {
    expect(script).toContain("let working = $state(false);");
    expect(script).toContain("const busy = $derived(working || locked);");
    expect(script).not.toMatch(/let busy\b/);
    expect(script).not.toMatch(/\bbusy = (true|false)/);
    // The four writers (write, submitAdd, remove, allowAccess): each guards on busy, sets working, and clears it after.
    expect(script.match(/\bworking = true;/g)).toHaveLength(4);
    expect(script.match(/\bworking = false;/g)).toHaveLength(4);
    expect(script.match(/if \(busy\) return( false)?;/g)).toHaveLength(4);
  });

  test("every control that writes reads busy (both owner Saves, add / remove / confirm); Test now, the owner drafts and Done / Add another stay live", () => {
    for (const writes of [
      '<Switch id="cal-master" describedby="cal-master-line" checked={calendarOn(block)} disabled={busy || block === null}',
      'checked={macOn} disabled={busy || block === null} onchange={(on) => setMac(on)} />',
      '<input type="checkbox" checked={macOn} disabled={busy}',
      '<button type="button" disabled={busy} onclick={() => void allowAccess()}>Allow access</button>',
      '<button type="button" disabled={busy} onclick={() => void allowAccess()}>Update the calendar reader</button>',
      '<fieldset class="checklist" disabled={busy}>',
      '<button type="button" disabled={busy} onclick={() => void confirmMine(link.id, prompt.address)}>It\'s mine</button>',
      '<button type="button" disabled={busy || (ownerDrafts[link.id] ?? "").trim() === ""}',
      '<button type="button" class="danger" disabled={busy} onclick={() => void remove(link.id)}>Remove</button>',
      '<button type="button" disabled={busy} onclick={() => (confirmRemove = link.id)}>Remove…</button>',
      '<button type="button" class="primary" disabled={busy} onclick={() => void confirmMine(added?.kind === "added" ? added.id : "", address)}>Yes, it\'s mine</button>',
      '<button type="button" class="primary" disabled={busy || addOwner.trim() === ""} onclick={() => void saveAddress(id, addOwner)}>Save address</button>',
      '<fieldset class="providers" disabled={busy}>',
      '<button type="button" class="primary" disabled={busy || (existing !== null && existing.urlFrom !== "file")}',
      '<button type="button" class="primary" disabled={busy || block === null} onclick={addConnection}>Add a connection…</button>',
      '<button type="button" disabled={busy} onclick={chooseMac}>Mac Calendar app</button>',
      '<button type="button" disabled={busy} onclick={chooseLink}>Calendar link</button>',
    ]) expect({ writes, busy: component.includes(writes) }).toEqual({ writes, busy: true });
    // "Remove that saved link", in both modes.
    expect(component.match(/<button type="button" disabled=\{busy\} onclick=\{\(\) => leftover !== null && void remove\(leftover\)\}>Remove that saved link<\/button>/g)).toHaveLength(2);
    // Accepted live (disagreement 6): they write nothing, so no later choice can be overwritten.
    expect(component.match(/<button type="button" disabled=\{testing\} onclick=\{\(\) => void runTest\(\)\}>/g)).toHaveLength(2);
    expect(component).toContain('<input id="cal-owner-{link.id}" type="email" autocomplete="off" value={ownerDrafts[link.id] ?? ""}\n');
    expect(component).toContain('<input id="cal-add-owner" type="email" autocomplete="off" value={addOwner}\n');
    expect(component).toContain('<button type="button" onclick={closeAdd}>Done</button>\n            <button type="button" onclick={openAdd}>Add another</button>');
  });

  test("the busy line: the running flow's phase, read at init and followed by a subscription placed after the first onMount; drawn only under `locked`, in Settings, before the first Tile", () => {
    expect(script).toContain('import { calendarBusyLine } from "./calendar-question";');
    expect(script).toContain("let flowPhase = $state(todayStore().flow.running?.phase);");
    expect(script).toContain("const busyLine = $derived(calendarBusyLine(flowPhase));");
    const first = script.indexOf("onMount(");
    const sub = script.indexOf("onMount(() => onTodayStore((s) => (flowPhase = s.flow.running?.phase)));");
    expect(sub).toBeGreaterThan(first);
    // Settings' branch: the line, then the master switch's Tile — no wrapper, no new class.
    expect(settings).toMatch(/\{#if mode === "settings"\}\n(?:\s*<!--[\s\S]*?-->\n)*\s*\{#if locked && busyLine !== null\}\n(?:\s*<!--[\s\S]*?-->\n)*\s*<p class="mline" tabindex="-1">\{busyLine\}<\/p>\n\s*\{\/if\}\n\s*<Tile>\n\s*<div class="box master">/);
    expect(component.match(/\{busyLine\}/g)).toHaveLength(1);
    expect(wizard).not.toContain("busyLine");
    expect(wizard).not.toContain("locked");
  });

  test("CalendarPage passes `locked` from the store's running flow and reloads the panel (its exported refresh) when the flow clears", () => {
    const page = src("lib/settings/CalendarPage.svelte");
    expect(page).toContain('import { refreshAfterFlow } from "../calendar-question";');
    expect(page).toContain('import { onTodayStore, todayStore } from "../today-store";');
    expect(page).toContain("let running = $state(todayStore().flow.running);");
    expect(page).toMatch(/onMount\(\(\) =>\n\s*onTodayStore\(\(s\) => \{\n\s*const was = running;\n\s*running = s\.flow\.running;\n\s*if \(refreshAfterFlow\(was, running\)\) void panel\?\.refresh\(\);\n\s*\}\),\n\s*\);/);
    // No `writing` variable: a Settings write of its own never locks the panel (only a running flow does).
    expect(page).not.toMatch(/\b(let|const) writing\b/);
    expect(page.match(/locked=/g)).toEqual(["locked="]);
    expect(component).toContain("  export async function refresh(): Promise<void> {");
  });
});

/* ── PB final review R1 (Y6): refresh() writes only its newest call's results ─────────────────────── */

describe("PB final R1 Y6: CalendarSettings' refresh writes only the newest call's results (an older reply never overtakes)", () => {
  type Json = Record<string, unknown>;
  const g = globalThis as { window?: unknown };
  let hadWindow = false;
  let windowBefore: unknown;
  /** Each invoke, in call order, with its own deferred answer. */
  let pending: { command: string; resolve: (v: unknown) => void }[] = [];
  beforeEach(() => {
    hadWindow = "window" in g;
    windowBefore = g.window;
    pending = [];
    g.window = { __TAURI_INTERNALS__: { invoke: (command: string, _args: Json | undefined) => new Promise((resolve) => pending.push({ command, resolve })) } };
  });
  afterEach(() => {
    if (hadWindow) g.window = windowBefore;
    else delete g.window;
  });

  const doc = (enabled: boolean): ConfigDocument => ({ path: "/c.json", exists: true, text: JSON.stringify({ calendar: { enabled } }), base: "b", parseError: null, apiKeyRedacted: false } as ConfigDocument);
  const out = (operation: string, payload: unknown) => ({ operation, outcome: { kind: "delivered" }, exitCode: 0, payload, stdout: "", stderr: "" });
  const NOT_OK = (Object.keys(CALENDAR_STATUS_TEXT) as CalendarReadStatus[])[0]!;
  /** Pre-flow (the older Settings mount's read): a failed last read, so not ok. Post-flow (the newer call): ok. */
  const PRE: CalendarStatusJson = { schemaVersion: 1, enabled: true, enabledSet: true, macSupported: false, configWarnings: [], sources: [{ id: "a", kind: "link", lastScheduledRead: { at: "2026-10-21T07:00:00Z", status: NOT_OK } }] };
  const POST: CalendarStatusJson = { schemaVersion: 1, enabled: true, enabledSet: true, macSupported: false, configWarnings: [], sources: [] };
  const LISTED = { schemaVersion: 1, macos: null, links: [] };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  test("two refreshes answered out of order: only the newer call's status is written (onstatus once, with its summary)", async () => {
    expect([calendarStatusOk({ status: PRE, error: null }), calendarStatusOk({ status: POST, error: null })]).toEqual([false, true]);   // PREMISE
    const seen: boolean[] = [];
    let refresh: (() => Promise<void>) | undefined;
    // A server render runs no onMount; its exported `refresh` reaches a settable prop (Svelte's bind_props).
    const props = {
      os: "linux",
      onstatus: (ok: boolean) => seen.push(ok),
      get refresh() { return undefined; },
      set refresh(f: (() => Promise<void>) | undefined) { refresh = f; },
    };
    void render(CalendarSettings as any, { props }).body;
    expect(typeof refresh).toBe("function");   // PREMISE: the real component's refresh
    const older = refresh!();   // Settings → Calendar mounting while a flow runs: reads the pre-flow config
    const newer = refresh!();   // CalendarPage's post-flow panel.refresh()
    await flush();
    expect(pending.map((p) => p.command)).toEqual(["config_read", "engine_calendar_list", "engine_calendar_status", "config_read", "engine_calendar_list", "engine_calendar_status"]);
    const [o1, o2, o3, n1, n2, n3] = pending;
    // The newer call answers first, then the older one.
    n1!.resolve(doc(true)); n2!.resolve(out("calendar-list", LISTED)); n3!.resolve(out("calendar-status", POST));
    await newer;
    expect(seen).toEqual([true]);
    o1!.resolve(doc(false)); o2!.resolve(out("calendar-list", LISTED)); o3!.resolve(out("calendar-status", PRE));
    await older;
    await flush();
    expect(seen).toEqual([true]);
  });

  test("source pin: refresh takes a call number before its reads and writes nothing once a newer call has started", () => {
    const component = src("lib/CalendarSettings.svelte");
    const script = component.slice(0, component.indexOf("</script>"));
    expect(script).toContain("  let refreshCalls = 0;\n");
    const body = script.slice(script.indexOf("export async function refresh("), script.indexOf("onMount("));
    expect(body).toMatch(/^export async function refresh\(\): Promise<void> \{\n\s*const call = \+\+refreshCalls;\n\s*const \[doc, listed, read\] = await Promise\.all\(\[/);
    // The guard sits between the reads and the first write.
    const guard = body.indexOf("    if (call !== refreshCalls) return;\n");
    expect(guard).toBeGreaterThan(body.indexOf("]);"));
    expect(guard).toBeLessThan(body.indexOf("configExists = "));
  });
});
