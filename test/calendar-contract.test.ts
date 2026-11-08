// test/calendar-contract.test.ts — the calendar CONTRACT pins (v0.3.0 plan M0): the types W1 and W2 build
// against, the constants and predicate the renderer, the audit and the app share, and the integrity of the
// frozen fixtures (`test/fixtures/calendar/`). Nothing here renders a calendar — M4 does — so what is pinned
// is that the fixtures are internally consistent and that the contract cannot drift silently.
//
// ⚠ Like test/types.test.ts, the TYPE pins are the type annotations: each `Record<Union, true>` is a fresh
// object literal, so a union that gains a member fails `bunx tsc --noEmit` (missing property) and one that
// loses a member fails it too (excess property). The `expect`s beside them are the weaker runtime half.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import type { BriefingStruct } from "../src/types";
import type {
  CalendarDisplayStatus, CalendarReadStatus, CalendarSourceKind, CalendarSourceNotice, CalendarSourceStatus,
  CalendarStruct, CalTime, CalSelfStatus,
} from "../src/calendar/types";
import {
  CALENDAR_HEADING, CALENDAR_INCOMPLETE_SUFFIX, CALENDAR_LINE_PREFIX, CALENDAR_MACOS_LABEL, CALENDAR_MACOS_SOURCE_ID,
  CALENDAR_MAX_EVENT_LINES, CALENDAR_NO_EVENTS_TEXT, CALENDAR_NOT_CONNECTED_TEXT, CALENDAR_STATUS_TEXT, CALENDAR_UNAVAILABLE_TEXT, CALENDAR_UNTITLED_TEXT,
  isCalendarHeading,
} from "../src/calendar/render-contract";
import { isPostureWarning } from "../src/eval/posture";
import { extractCitedShas } from "../src/audit";
import { renderBriefing } from "../src/render";
import { RENDER_CORPUS } from "./fixtures/render-corpus";
import {
  LIST_EXAMPLE, LIST_JSON_PATH, SECTION_FIXTURE_PATH, SECTION_SOURCES, STATUS_EXAMPLE, STATUS_JSON_PATH, TEST_EXAMPLE,
  TEST_JSON_PATH, readSectionFixture,
} from "./fixtures/calendar/contract";

// ── the type pins ──────────────────────────────────────────────────────────────────────────────────

/** Spec r4 §8's sixteen statuses, exactly. */
const STATUSES: Record<CalendarSourceStatus, true> = {
  "ok": true, "not-granted": true, "write-only": true, "denied": true, "restricted": true, "unsupported-os": true,
  "helper-missing": true, "helper-outdated": true, "identity-unknown": true, "timeout": true, "offline": true,
  "link-refused": true, "link-redirected": true, "malformed": true, "too-large": true, "incomplete": true,
};
const NOTICES: Record<CalendarSourceNotice, true> = { "helper-outdated": true, "identity-unknown": true };
const READ_STATUSES: Record<CalendarReadStatus, true> = {
  "ok": true, "not-granted": true, "write-only": true, "denied": true, "restricted": true, "unsupported-os": true,
  "helper-missing": true, "timeout": true, "offline": true, "link-refused": true, "link-redirected": true,
  "malformed": true, "too-large": true, "incomplete": true,
};
const KINDS: Record<CalendarSourceKind, true> = { macos: true, link: true };
const TIME_KINDS: Record<CalTime["kind"], true> = { timed: true, allDay: true, unclear: true };
const DISPLAY: Record<CalendarDisplayStatus, true> = { confirmed: true, tentative: true };
const SELF: Record<CalSelfStatus, true> = { organizer: true, accepted: true, tentative: true, "needs-action": true, declined: true, unknown: true };

describe("the contract types", () => {
  test("the source statuses are spec §8's sixteen; the two notices are among them and are never a read status", () => {
    expect(Object.keys(STATUSES)).toHaveLength(16);
    expect(Object.keys(NOTICES).every((n) => n in STATUSES)).toBe(true);
    expect(Object.keys(NOTICES).some((n) => n in READ_STATUSES)).toBe(false);
    expect(Object.keys(READ_STATUSES).sort()).toEqual(Object.keys(STATUSES).filter((s) => !(s in NOTICES)).sort());
    expect(Object.keys(KINDS).sort()).toEqual(["link", "macos"]);
    expect(Object.keys(TIME_KINDS).sort()).toEqual(["allDay", "timed", "unclear"]);
    expect(Object.keys(DISPLAY).sort()).toEqual(["confirmed", "tentative"]);
    expect(Object.keys(SELF)).toHaveLength(6);
  });

  test("BriefingStruct.calendar is additive and optional — a struct without it is unchanged", () => {
    const cal: CalendarStruct = { events: [], sources: [{ id: CALENDAR_MACOS_SOURCE_ID, kind: "macos", status: "ok" }], incomplete: false };
    const withCal: BriefingStruct = { date: "2026-10-14", machineScope: "h", provider: "claude", resume: [], recap: [], suggestions: [], calendar: cal };
    const without: BriefingStruct = { date: "2026-10-14", machineScope: "h", provider: "claude", resume: [], recap: [], suggestions: [] };
    expect(withCal.calendar).toBe(cal);
    expect("calendar" in without).toBe(false);
  });
});

// ── the shared constants and the predicate ─────────────────────────────────────────────────────────

describe("render-contract", () => {
  test("the bytes are exactly what spec r4 §7 names", () => {
    expect(CALENDAR_HEADING).toBe("▶ Today's calendar");
    expect(CALENDAR_INCOMPLETE_SUFFIX).toBe(" (incomplete)");
    expect(CALENDAR_LINE_PREFIX).toBe("   \u25e6 ");
    expect(CALENDAR_MAX_EVENT_LINES).toBe(60);
    expect(CALENDAR_UNAVAILABLE_TEXT).toBe("Calendar unavailable today");
    // The GUI's history view finds headings by their `▶ ` lead (gui/src/lib/briefing-md.ts).
    expect(CALENDAR_HEADING.startsWith("▶ ")).toBe(true);
    // Recap's nested lines are six spaces then `◦`; the calendar prefix must not be a prefix of them.
    expect("      \u25e6 [x] y".startsWith(CALENDAR_LINE_PREFIX)).toBe(false);
  });

  test("isCalendarHeading: the heading with or without (incomplete), and nothing else", () => {
    for (const yes of [CALENDAR_HEADING, CALENDAR_HEADING + CALENDAR_INCOMPLETE_SUFFIX, `${CALENDAR_HEADING}\r`]) {
      expect(`${JSON.stringify(yes)} → ${isCalendarHeading(yes)}`).toBe(`${JSON.stringify(yes)} → true`);
    }
    for (const no of [
      "▶ Today so far", "▶ Suggested next", "▶ Where you left off", "", "Today's calendar", `   ${CALENDAR_HEADING}`,
      `${CALENDAR_LINE_PREFIX}${CALENDAR_HEADING}`, "▶ today's calendar", "• ▶ Today's calendar",
    ]) {
      expect(`${JSON.stringify(no)} → ${isCalendarHeading(no)}`).toBe(`${JSON.stringify(no)} → false`);
    }
  });

  test("no briefing rendered today can produce a calendar heading or a calendar line", () => {
    // Spec r4 §10's premise for the audit's section-bounded skip: archived briefings never carry the
    // heading, so a briefing with no calendar is scored exactly as before. Measured over the render corpus.
    expect(RENDER_CORPUS.length).toBeGreaterThan(0);
    for (const { name, struct } of RENDER_CORPUS) {
      const hits = renderBriefing(struct).split("\n").filter((l) => isCalendarHeading(l) || l.startsWith(CALENDAR_LINE_PREFIX));
      expect(`${name}: ${JSON.stringify(hits)}`).toBe(`${name}: []`);
    }
  });

  test("every status sentence is fixed, URL-free, SHA-free and not a posture phrase", () => {
    const keys = Object.keys(CALENDAR_STATUS_TEXT).sort();
    expect(keys).toEqual(Object.keys(READ_STATUSES).filter((s) => s !== "ok").sort());
    for (const [status, text] of Object.entries(CALENDAR_STATUS_TEXT)) {
      expect(text.trim().length).toBeGreaterThan(0);
      expect(`${status}: posture=${isPostureWarning(text)}`).toBe(`${status}: posture=false`);
      expect(text).not.toMatch(/:\/\/|https?|webcal/i);
      expect(text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
      // A status line must never read as a cited SHA, with or without M6a's section skip.
      expect(extractCitedShas(`${CALENDAR_LINE_PREFIX}work: ${text}`)).toEqual([]);
    }
    for (const t of [CALENDAR_UNAVAILABLE_TEXT, CALENDAR_NO_EVENTS_TEXT, CALENDAR_NOT_CONNECTED_TEXT, CALENDAR_UNTITLED_TEXT, CALENDAR_MACOS_LABEL]) {
      expect(isPostureWarning(t)).toBe(false);
    }
  });
});

// ── the frozen rendered-section fixture ────────────────────────────────────────────────────────────

describe("the rendered-section fixture (the contract M4 reproduces)", () => {
  const raw = readFileSync(SECTION_FIXTURE_PATH, "utf8");
  const blocks = readSectionFixture(raw);

  test("one variant per typed source, same names, same order", () => {
    expect([...blocks.keys()]).toEqual(SECTION_SOURCES.map((s) => s.name));
    expect(raw.endsWith("\n")).toBe(true);
    for (const line of raw.split("\n")) expect(`${JSON.stringify(line)} ${/\s$/.test(line)}`).toBe(`${JSON.stringify(line)} false`);
  });

  test("the parser refuses a stray line and a repeated variant", () => {
    expect(() => readSectionFixture("@@ a\nx\n\nstray\n")).toThrow(/outside any variant/);
    expect(() => readSectionFixture("@@ a\nx\n\n@@ a\ny\n")).toThrow(/appears twice/);
  });

  for (const src of SECTION_SOURCES) {
    test(`${src.name}: heading, prefix, status lines and the cap agree with its source`, () => {
      const lines = blocks.get(src.name)!;
      const cal = src.calendar;
      // The source is a well-formed struct by the contract's own rules.
      expect(cal.incomplete).toBe(cal.sources.some((s) => s.status !== "ok"));
      const allDayIdx = cal.events.map((e, i) => (e.time.kind === "allDay" ? i : -1)).filter((i) => i >= 0);
      expect(allDayIdx).toEqual(allDayIdx.map((_, i) => i));        // all-day first
      if (cal.events.some((e) => e.time.kind === "unclear")) expect(cal.sources.some((s) => s.status === "incomplete")).toBe(true);

      // Heading: exactly one, first, suffixed iff incomplete.
      expect(lines[0]).toBe(CALENDAR_HEADING + (cal.incomplete ? CALENDAR_INCOMPLETE_SUFFIX : ""));
      const body = lines.slice(1);
      for (const l of body) {
        expect(l.startsWith(CALENDAR_LINE_PREFIX)).toBe(true);
        expect(isCalendarHeading(l)).toBe(false);
        expect(l).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
      }

      // No sources at all (the `no-sources` variant): the unsuffixed heading and the one not-connected line.
      if (cal.sources.length === 0) {
        expect(cal.incomplete).toBe(false);
        expect(body).toEqual([CALENDAR_LINE_PREFIX + CALENDAR_NOT_CONNECTED_TEXT]);
        return;
      }
      // Unavailable first when every source failed; then one status line per non-ok source, in order.
      const allFailed = cal.sources.every((s) => s.status !== "ok" && s.status !== "incomplete");
      const head = allFailed ? [CALENDAR_LINE_PREFIX + CALENDAR_UNAVAILABLE_TEXT] : [];
      const statusLines = cal.sources.filter((s) => s.status !== "ok").map((s) =>
        `${CALENDAR_LINE_PREFIX}${s.kind === "macos" ? CALENDAR_MACOS_LABEL : s.id}: ${CALENDAR_STATUS_TEXT[s.status as Exclude<CalendarReadStatus, "ok">]}`);
      expect(body.slice(0, head.length + statusLines.length)).toEqual([...head, ...statusLines]);

      // Then the events: at most the cap, then `+N more`; or the no-events line; or nothing when unavailable.
      const eventLines = body.slice(head.length + statusLines.length);
      if (allFailed) expect(eventLines).toEqual([]);
      else if (cal.events.length === 0) expect(eventLines).toEqual([CALENDAR_LINE_PREFIX + CALENDAR_NO_EVENTS_TEXT]);
      else if (cal.events.length > CALENDAR_MAX_EVENT_LINES) {
        expect(eventLines).toHaveLength(CALENDAR_MAX_EVENT_LINES + 1);
        expect(eventLines.at(-1)).toBe(`${CALENDAR_LINE_PREFIX}+${cal.events.length - CALENDAR_MAX_EVENT_LINES} more`);
      } else expect(eventLines).toHaveLength(cal.events.length);
      // Every shown event's title (or the untitled text) is on its own line, in struct order.
      cal.events.slice(0, CALENDAR_MAX_EVENT_LINES).forEach((e, i) => {
        expect(eventLines[i]).toContain(e.title.trim() === "" ? CALENDAR_UNTITLED_TEXT : e.title);
        if (e.location) expect(eventLines[i]).toContain(`(${e.location})`);
        expect(eventLines[i]!.includes(" · tentative")).toBe(e.status === "tentative");
        expect(eventLines[i]!.endsWith(" · ended")).toBe(e.ended === true);
      });
    });
  }

  test("across the variants, every line kind spec r4 §7 names appears at least once", () => {
    const all = [...blocks.values()].flat();
    const KINDS_SEEN: [string, (l: string) => boolean][] = [
      ["(incomplete) heading", (l) => l === CALENDAR_HEADING + CALENDAR_INCOMPLETE_SUFFIX],
      ["complete heading", (l) => l === CALENDAR_HEADING],
      ["all-day", (l) => l.startsWith(`${CALENDAR_LINE_PREFIX}all day — `)],
      ["timed", (l) => /^ {3}◦ \d\d:\d\d–\d\d:\d\d {2}\S/.test(l)],
      ["tentative", (l) => l.includes(" · tentative")],
      ["ended", (l) => l.endsWith(" · ended")],
      ["unclear time", (l) => l.startsWith(`${CALENDAR_LINE_PREFIX}time unclear (`)],
      ["crosses into tomorrow", (l) => / → \d\d:\d\d tomorrow {2}/.test(l)],
      ["runs past tomorrow", (l) => / → [A-Z][a-z]{2} \d{1,2} \d\d:\d\d {2}/.test(l)],
      ["since yesterday", (l) => l.includes("since yesterday → ")],
      ["since an earlier day", (l) => /since [A-Z][a-z]{2} \d{1,2} → /.test(l)],
      ["ends at midnight", (l) => l.includes("–24:00  ")],
      ["zero length", (l) => /^ {3}◦ \d\d:\d\d {2}\S/.test(l)],
      ["untitled", (l) => l.includes(CALENDAR_UNTITLED_TEXT)],
      ["+N more", (l) => /^ {3}◦ \+\d+ more$/.test(l)],
      ["failed-source status line", (l) => l.endsWith(CALENDAR_STATUS_TEXT["link-refused"])],
      ["incomplete-source status line", (l) => l.endsWith(CALENDAR_STATUS_TEXT.incomplete)],
      ["Mac source status line", (l) => l.startsWith(`${CALENDAR_LINE_PREFIX}${CALENDAR_MACOS_LABEL}: `)],
      ["calendar unavailable", (l) => l === CALENDAR_LINE_PREFIX + CALENDAR_UNAVAILABLE_TEXT],
      ["no events", (l) => l === CALENDAR_LINE_PREFIX + CALENDAR_NO_EVENTS_TEXT],
      ["not connected", (l) => l === CALENDAR_LINE_PREFIX + CALENDAR_NOT_CONNECTED_TEXT],
    ];
    const missing = KINDS_SEEN.filter(([, seen]) => !all.some(seen)).map(([k]) => k);
    expect(missing).toEqual([]);
  });

  test("notices render nothing: a source that is ok with a notice gets no line", () => {
    const full = SECTION_SOURCES.find((s) => s.name === "full-day")!;
    const noticed = full.calendar.sources.filter((s) => (s.notices?.length ?? 0) > 0);
    expect(noticed.length).toBeGreaterThan(0);              // non-vacuous: the fixture carries notices
    const text = blocks.get("full-day")!.join("\n");
    expect(text).not.toContain("outdated");
    expect(text).not.toContain("identity");
    expect(text).not.toContain(`${CALENDAR_MACOS_LABEL}:`); // the macos source is ok here, notice and all
  });
});

// ── the `calendar … --json` examples ───────────────────────────────────────────────────────────────

describe("the calendar --json example fixtures", () => {
  const cases = [["list", LIST_JSON_PATH, LIST_EXAMPLE], ["test", TEST_JSON_PATH, TEST_EXAMPLE], ["status", STATUS_JSON_PATH, STATUS_EXAMPLE]] as const;

  for (const [name, path, example] of cases) {
    test(`calendar ${name} --json: the .json file is the typed example, serialised`, () => {
      const file = readFileSync(path, "utf8");
      expect(file).toBe(`${JSON.stringify(example, null, 2)}\n`);
      expect(JSON.parse(file).schemaVersion).toBe(1);
      // Never a URL, an attendee or a description (spec r4 §4.2 "Never leaks", §7).
      expect(file).not.toMatch(/:\/\/|webcal|https?:/i);
      expect(file).not.toMatch(/"(?:url|attendees?|description)"\s*:/i);
    });
  }

  test("the read statuses in the examples are read statuses; notices ride beside them", () => {
    const reads = [
      ...(LIST_EXAMPLE.macos ? [LIST_EXAMPLE.macos.status] : []),
      ...TEST_EXAMPLE.sources.map((s) => s.status),
      ...STATUS_EXAMPLE.sources.flatMap((s) => (s.lastScheduledRead ? [s.lastScheduledRead.status] : [])),
    ];
    expect(reads.every((s) => s in READ_STATUSES)).toBe(true);
    expect(TEST_EXAMPLE.incomplete).toBe(TEST_EXAMPLE.sources.some((s) => s.status !== "ok"));
  });
});
