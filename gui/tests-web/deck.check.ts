/**
 * The briefing redesign's A-M3/A-M4 — the deck's pure model (`src/lib/deck.ts`): the page split into its
 * sections, the line kinds routed to slides and cards, labels, "cannot map", counting and point picking.
 *
 * ⚠ THE PAGES ARE THE ENGINE'S SHAPES. Most are rendered here by the engine's own `renderBriefing` from a
 * struct (imported READ-ONLY, as `today.check.ts` does); the rest are hand-written in those shapes and
 * committed under `__fixtures__/deck/` (no real page is ever committed). Every page goes through the same
 * `renderMarkdown` the app uses, so the deck sees exactly the `Block[]` Today has.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatReport, prefixClass, probeArchive } from "./probes/deck-probe";

import { renderBriefing, renderCalendarSection } from "../../src/render";
import { bareToken, evidenceTokens } from "../../src/sha";
import { norm as engineNorm, VERDICT_MARKER_PREFIX as ENGINE_VERDICT_MARKER_PREFIX } from "../../src/subprojects";
import type { BriefingStruct as EngineStruct } from "../../src/types";

import { blockText, renderMarkdown, type Block, type BlockKind } from "../src/lib/briefing-md";
import type { Phase, ScheduleState, Snapshot } from "../src/lib/state";
import { FAILURE_BANNER_LEAD, todayModel, type LatestLoad } from "../src/lib/today";
import { readSectionFixture } from "../../test/fixtures/calendar/contract";
import { RENDER_CORPUS } from "../../test/fixtures/render-corpus";
import type { CalendarStruct, CalendarStructEvent } from "../src/lib/calendar-contract";
import { briefingHash, deckStateFor, deckStateOnKey, focusIsLost, focusLanding, keepDeckState, noteRunStart, runJumpNow, runRule } from "../src/lib/deck-state";
import { listChange, moreBelow, placeOnList, remapOnList, scrollResets } from "../src/lib/deck-state";
import * as deckState from "../src/lib/deck-state";
import { focusHeading } from "../src/lib/ui/a11y";
import type { SlideId } from "../src/lib/deck";
import {
  CALENDAR_STALE_TEXT,
  branchCounts,
  cardCountLabel,
  clockTime,
  deckReducer,
  meetingTileText,
  deckView,
  meetingTile,
  moodLine,
  nextMeeting,
  glanceMeeting,
  parseCalendarLine,
  unmarked,
  type CalendarEvent,
  goodMorning,
  isCountedToken,
  longDate,
  QUIET_DAY_LINE,
  QUIET_WITH_WARNING_LINE,
  isCalendarDate,
  mapPage,
  startLabel,
  pageLabels,
  parseBranch,
  parseLabel,
  routeBlock,
  splitTokens,
  VERDICT_MARKER_PREFIX,
  WORK_LABEL,
  type Destination,
  type DeckPage,
  type Where,
} from "../src/lib/deck";

const TODAY = "2026-10-16";

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/deck/${name}`, import.meta.url), "utf8");

/** A struct with the required fields filled, rendered by the engine. */
const page = (s: Partial<EngineStruct> = {}): string =>
  renderBriefing({ date: TODAY, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [], ...s });

function mapped(text: string, today = TODAY): DeckPage {
  const r = mapPage(renderMarkdown(text), today);
  if (!r.ok) throw new Error(`expected the page to map, got ${r.reason}: ${r.line}`);
  return r.page;
}

function refused(text: string, today = TODAY): { reason: string; line: string } {
  const r = mapPage(renderMarkdown(text), today);
  if (r.ok) throw new Error("expected the page NOT to map");
  return { reason: r.reason, line: r.line };
}

const block = (kind: BlockKind, text: string): Block => ({ kind, spans: [{ kind: "text", text }] });

/* ── the clock off UTC (CI runs only in UTC, where a UTC reading and a local one agree) ────────── */

/** Each zone's offset (`getTimezoneOffset`, minutes) at noon UTC on 2026-10-16: the premise that a change
 *  of zone took effect, without which every zoned check passes vacuously, as in UTC. */
const ZONE_OFFSETS: Record<string, number> = { "America/Los_Angeles": 420, "Pacific/Auckland": -780 };
const ZONES = Object.keys(ZONE_OFFSETS);

/**
 * Runs `body` with the process's zone set to `tz`, then restores it. Bun applies a runtime
 * `process.env.TZ` change to every later `new Date(…)` (measured, in `bun test` too). The restore assigns
 * the zone that was in effect, THEN the saved value: assigning a saved `undefined` alone leaves the last
 * zone in effect, and `delete process.env.TZ` stops Bun applying any later change (both measured).
 */
function inZone(tz: string, body: () => void): void {
  const saved = process.env.TZ;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const before = new Date(2026, 9, 16, 9, 0).getTime();
  process.env.TZ = tz;
  try {
    expect(new Date(Date.UTC(2026, 9, 16, 12)).getTimezoneOffset()).toBe(ZONE_OFFSETS[tz]!);   // PREMISE
    body();
  } finally {
    process.env.TZ = zone;
    process.env.TZ = saved;
  }
  expect(new Date(2026, 9, 16, 9, 0).getTime()).toBe(before);   // restored
}

/** A test, then the same test under each of `ZONES`. */
function zonedTest(name: string, body: () => void): void {
  test(name, body);
  for (const tz of ZONES) test(`${name} [${tz}]`, () => inZone(tz, body));
}

/* ── A-M3-T5: where each line kind goes ───────────────────────────────────────────────────────── */

describe("the BlockKind → destination table (A spec, \"Where each line kind goes\")", () => {
  /** Every member of the reader's union, read from its SOURCE, so a kind added there fails here. */
  const unionKinds = (): string[] => {
    const src = readFileSync(new URL("../src/lib/briefing-md.ts", import.meta.url), "utf8");
    const lines = src.split("\n");
    const at = lines.findIndex((l) => l.startsWith("export type BlockKind ="));
    expect(at).toBeGreaterThan(-1);
    const kinds: string[] = [];
    // Member lines up to the one whose CODE (before a `//` comment) ends the type with `;` — a comment may
    // itself hold a semicolon ("⚠ a; b").
    for (const line of lines.slice(at + 1)) {
      const code = line.split("//")[0]!;
      const m = /^\s*\|\s*"(\w+)"/.exec(code);
      if (m !== null) kinds.push(m[1]!);
      if (code.trimEnd().endsWith(";")) break;
    }
    return kinds;
  };

  /** [kind, where, the line's text, where it goes]. Each table row has at least one case. */
  const CASES: [BlockKind, Where, string, Destination][] = [
    ["notice", "outside", 'ℹ︎ Skipped "work": out of usage — used "home"', "needsALook"],
    ["title", "outside", "☀️  Daily briefing — 2026-10-16  (this machine: mac)", "pageDate"],
    ["outage", "outside", '⚠️  No briefing for 2 days — account "backup" was at its usage limit.', "needsALook"],
    ["legend", "outside", "(labels: a, b are areas of repo r)", "fullOnly"],
    ["heading", "outside", "What you did — 3 commits", "split"],
    ["bullet", "leftOff", "[app] On branch main (ahead 2, behind 0)", "branchTag"],
    ["bullet", "leftOff", "[app] Detached HEAD at abc1234", "branchTag"],
    ["bullet", "leftOff", "[app] resume the parser work", "resumeItem"],
    ["bullet", "whatYouDid", "[app] shipped the thing  (abc1234)", "projectCard"],
    ["bullet", "whatYouDid", "[app] 🔀 2 PRs merged (#12, #13) (Sep 14)  (a1b2c3d, c9d8e7f)", "mergedRow"],
    ["bullet", "todaySoFar", "[app] wip: audit notes", "todaySoFar"],
    ["bullet", "suggested", "[app] run the audit", "suggestion"],
    ["bullet", "unknown", "[app] a line under a heading the deck does not know", "fullOnly"],
    ["bullet", "outside", "[app] a bullet before any heading", "cannotMap"],
    ["nested", "whatYouDid", "[app] reworked the header  (0a1b2c3)", "projectCard"],
    ["nested", "leftOff", "[app] a member where none belongs", "cannotMap"],
    ["nested2", "whatYouDid", "[app] tuned the grid  (1f2e3d4)", "projectCard"],
    ["notShown", "whatYouDid", "[app] abc1234 fix the render", "projectCard"],
    ["notShown", "whatYouDid", "(+3 more)", "subtitleDisclosure"],
    ["coverage", "whatYouDid", "⚠ 4 in-window commit(s) NOT shown above:", "subtitleDisclosure"],
    ["coverage", "suggested", "⚠ 4 in-window commit(s) NOT shown above:", "cannotMap"],
    ["why", "whatYouDid", '— you wrote: "ship it"', "whyNext"],
    ["why", "leftOff", '— you wrote: "finish the audit"', "whyNext"],
    // The engine writes why lines only in those two sections (`render.ts`'s `whyFor`); anywhere else the
    // page is not one it wrote.
    ["why", "todaySoFar", '— you wrote: "a why the engine never writes here"', "cannotMap"],
    ["why", "suggested", '— you wrote: "a why the engine never writes here"', "cannotMap"],
    ["why", "calendar", '— you wrote: "a why the engine never writes here"', "cannotMap"],
    ["placeholder", "leftOff", "(nothing in progress)", "emptyState"],
    ["placeholder", "whatYouDid", "(no commits in the window)", "quietDay"],
    ["placeholder", "suggested", "(none)", "emptyState"],
    ["placeholder", "suggested", "(no commits in the window)", "cannotMap"],
    ["warnings", "suggested", "⚠ invalid morning time", "needsALook"],
    ["calendar", "calendar", "09:00–09:30 Standup", "calendar"],
    ["footer", "suggested", "— generated via claude", "fullOnly"],
    ["text", "suggested", `${VERDICT_MARKER_PREFIX}human gate: cites a commit on a configured verdict path`, "verdictMarker"],
    ["text", "whatYouDid", `${VERDICT_MARKER_PREFIX}human gate: cites a commit on a configured verdict path`, "cannotMap"],
    ["text", "whatYouDid", "   a line in no known shape", "cannotMap"],
    ["text", "outside", "a line before any heading", "fullOnly"],
    ["text", "unknown", "a line under an unknown heading", "fullOnly"],
  ];

  test("the cases cover every member of the reader's union", () => {
    const kinds = unionKinds();
    expect(kinds.length).toBeGreaterThanOrEqual(16);   // PREMISE: the parse found the union
    expect([...new Set(CASES.map(([k]) => k))].sort()).toEqual([...kinds].sort());
  });

  for (const [kind, where, text, want] of CASES) {
    test(`${kind} in ${where}: ${text.slice(0, 40)} → ${want}`, () => {
      expect(routeBlock(block(kind, text), where)).toBe(want);
    });
  }
});

/* ── A-M3-T5: sections, labels, the page date ─────────────────────────────────────────────────── */

describe("sections and labels", () => {
  test("the page splits at its headings; an unknown ▶ heading is Full briefing only, and the page still maps", () => {
    const text = page({ recap: [{ repo: "app", text: "shipped", evidence: "abc1234" }] }).replace(
      "▶ Suggested next",
      "▶ A section from the future\n   • [app] something new\n\n▶ Suggested next",
    );
    const p = mapped(text);
    expect(p.sections.map((s) => s.key)).toEqual(["leftOff", "whatYouDid", null, "suggested"]);
    expect(p.sections[2]!.heading).toBe("A section from the future");
    expect(p.whatYouDid.cards.map((c) => c.key)).toEqual(["app"]);
  });

  test("Mono, mono, Mono. and **mono** are one card and one colour (the engine's norm); the first-seen spelling is its label", () => {
    const p = mapped(fixture("labels-15.md"));
    const mono = p.whatYouDid.cards.filter((c) => c.key === "mono");
    expect(mono.length).toBe(1);
    expect(mono[0]!.label).toBe("Mono");
    expect(mono[0]!.lines.map((l) => l.text)).toEqual([
      "reworked the header  (a8b2c3d)",
      "fixed the footer  (a9b2c3e)",
      "tuned the grid  (aab2c3f)",
      "moved the nav  (abb2c40)",
    ]);
    expect(p.whatYouDid.cards.filter((c) => c.key.includes("mono")).length).toBe(1);
    expect(p.slots["mono"]).toBe(mono[0]!.slot);
  });

  test("about 15 labels: one card each, the first 12 never share a colour, and Other is neutral and last", () => {
    const p = mapped(fixture("labels-15.md"));
    const projects = p.whatYouDid.cards.filter((c) => c.key !== "");
    expect(projects.length).toBe(15);
    const first12 = projects.slice(0, 12).map((c) => c.slot);
    expect(new Set(first12).size).toBe(12);
    expect(projects.every((c) => typeof c.slot === "number")).toBe(true);
    const other = p.whatYouDid.cards[p.whatYouDid.cards.length - 1]!;
    expect(other.key).toBe("");
    expect(other.label).toBe("Other");
    expect(other.slot).toBeNull();
    expect(other.lines.map((l) => l.text)).toEqual(["a line with an empty label  (b2b2c41)"]);
  });

  test("the hand-written 15-label page is one the engine could write: its bare header counts its bullets", () => {
    const text = fixture("labels-15.md");
    const bullets = text.split("▶ What you did")[1]!.split("▶ ")[0]!.split("\n").filter((l) => l.startsWith("   • ["));
    expect(text).toContain(`▶ What you did — ${bullets.length} commits`);
  });

  test("a 100-character label is kept whole (the pill ellipsizes it, not the model)", () => {
    const p = mapped(fixture("labels-15.md"));
    const long = p.whatYouDid.cards.find((c) => c.label.length === 100);
    expect(long).toBeDefined();
    expect(long!.key).toBe(long!.label);
  });

  test("labels are one colour across the page's slides: a suggestion's pill uses its project's slot", () => {
    const p = mapped(fixture("labels-15.md"));
    expect(Object.keys(p.slots)).toContain("beta");
    expect(p.slots["beta"]).toBe(p.whatYouDid.cards.find((c) => c.key === "beta")!.slot);
  });

  test("today's page: today's labels, no older-briefing title", () => {
    const p = mapped(page());
    expect(p.pageDate).toBe(TODAY);
    expect(p.stale).toBe(false);
    expect(p.labels).toEqual({ title: null, suggested: "Suggested for today", todaySoFar: "Today so far" });
  });

  test("a stale page: every label is relative to the page's date, never to now", () => {
    const p = mapped(page({ date: "2025-10-16" }), "2025-10-20");
    expect(p.stale).toBe(true);
    expect(p.labels).toEqual({
      title: "Your last briefing, from Thursday 16 October",
      suggested: "Suggested then",
      todaySoFar: "Later that day",
    });
    expect(pageLabels("2026-10-16", "2026-10-21").title).toBe("Your last briefing, from Friday 16 October");
  });

  zonedTest("the page's long date is calendar arithmetic, not a clock reading (no time zone can move the weekday)", () => {
    const VECTORS: [string, string][] = [
      ["2025-10-16", "Thursday 16 October"],
      ["2026-10-16", "Friday 16 October"],
      ["2026-10-21", "Wednesday 21 October"],
      ["2024-02-29", "Thursday 29 February"],
      ["2000-03-01", "Wednesday 1 March"],
      ["1900-03-01", "Thursday 1 March"],
      ["2026-01-01", "Thursday 1 January"],
      ["2026-12-31", "Thursday 31 December"],
      ["2027-01-03", "Sunday 3 January"],
      ["2023-07-15", "Saturday 15 July"],
    ];
    for (const [date, want] of VECTORS) expect({ date, got: longDate(date) }).toEqual({ date, got: want });
  });

  test("the long date reads no Date at all: no string-parsed `new Date(\"YYYY-MM-DD\")` (UTC midnight), no clock weekday", () => {
    // The zoned runs above catch both off UTC; this keeps the arithmetic's shape, which needs no zone.
    const src = readFileSync(new URL("../src/lib/deck.ts", import.meta.url), "utf8");
    const at = src.indexOf("export function longDate(");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}", at));
    expect(body).toContain("WEEKDAY_OFFSETS");   // PREMISE: the body is the function's
    expect(body).not.toMatch(/\bDate\b/);
  });

  test("notices, the outage line and every ⚠ warnings block go to Good morning's needs-a-look, in page order", () => {
    const p = mapped(
      page({
        notices: ['ℹ︎ Skipped "work": out of usage', 'ℹ︎ used "home"'],
        outage: { missedDays: 2, label: "backup" },
        warnings: ["invalid morning time", "transcripts unreadable"],
      }),
    );
    expect(p.needsALook).toEqual([
      'ℹ︎ Skipped "work": out of usage',
      'ℹ︎ used "home"',
      '⚠️  No briefing for 2 days — account "backup" was at its usage limit.',
      "⚠ invalid morning time; transcripts unreadable",
    ]);
  });
});

/* ── A-M3-T5: "cannot map" ────────────────────────────────────────────────────────────────────── */

describe("cannot map → the classic view", () => {
  test("no title line", () => {
    expect(refused(fixture("cannot-map-no-title.md")).reason).toBe("no-title");
  });

  test("a known section's content with its heading missing", () => {
    const r = refused(fixture("cannot-map-heading-missing.md"));
    expect(r.reason).toBe("content-without-heading");
    expect(r.line).toBe("[app] shipped the thing  (abc1234)");
  });

  test("a text block inside a mapped section", () => {
    const r = refused(fixture("cannot-map-text-in-section.md"));
    expect(r.reason).toBe("text-in-section");
    expect(r.line).toBe("   a line in no shape the engine writes");
  });

  test("a page with a bullet shape the reader does not know falls back (the older-engine case)", () => {
    expect(refused(fixture("unknown-bullet-shape.md")).reason).toBe("text-in-section");
  });

  test("a why line under Today so far, Suggested next or the calendar is not a page the engine wrote", () => {
    const text = page({ suggestions: [{ repo: "app", text: "next" }] }).replace(
      "▶ Suggested next\n",
      '▶ Suggested next\n   — you wrote: "a why the engine never writes here"\n',
    );
    expect(refused(text).reason).toBe("content-without-heading");
  });

  test("a verdict-marked suggestion maps; the same ⚑ line inside What you did does not", () => {
    const marked = page({
      recap: [{ repo: "app", text: "shipped", evidence: "abc1234" }],
      suggestions: [{ repo: "app", text: "check the verdict file", verdictPath: true }],
    });
    expect(marked).toContain(VERDICT_MARKER_PREFIX);   // PREMISE: the engine wrote the marker
    expect(mapPage(renderMarkdown(marked), TODAY).ok).toBe(true);
    const markerLine = marked.split("\n").find((l) => l.startsWith(VERDICT_MARKER_PREFIX))!;
    const misplaced = marked.replace("   • [app] shipped  (abc1234)", `   • [app] shipped  (abc1234)\n${markerLine}`);
    expect(misplaced).not.toBe(marked);
    expect(refused(misplaced).reason).toBe("text-in-section");
  });

  test("the GUI's verdict-marker prefix is the engine's", () => {
    expect(VERDICT_MARKER_PREFIX).toBe(ENGINE_VERDICT_MARKER_PREFIX);
  });
});

/* ── A-M3-T6: counting (A spec, "Counting") ───────────────────────────────────────────────────── */

describe("counting", () => {
  const card = (p: DeckPage, key: string) => {
    const c = p.whatYouDid.cards.find((x) => x.key === key);
    if (c === undefined) throw new Error(`no card ${key}`);
    return c;
  };

  test("the SHA-token rule: 4-40 hex, all-digit included, under 7 characters only with a digit", () => {
    for (const t of ["abc1234", "1234567", "deadbeef", "a1b2", "0123", "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4"]) {
      expect({ t, counted: isCountedToken(t) }).toEqual({ t, counted: true });
    }
    for (const t of ["added", "faded", "facade", "decade", "abc", "abcdefg1234567890abcdefg1234567890abcdefg1", "zz12345", "", "beef"]) {
      expect({ t, counted: isCountedToken(t) }).toEqual({ t, counted: false });
    }
  });

  test("the token split is the engine's evidenceTokens then bareToken, input for input", () => {
    for (const evidence of [
      "2ee0ae5 (src/main.ts)",
      "`abc1234`,",
      "[abc1234]",
      "a1b2c3d, b2c3d4e",
      "abc1234.",
      "'abc1234'",
      "**abc1234**",
      "{abc1234}",
      "(abc1234)",
      "abc1234; def5678!",
      "  spaced   out  ",
      "_abc1234_",
    ]) {
      expect({ evidence, gui: splitTokens(evidence) }).toEqual({ evidence, gui: evidenceTokens(evidence).map(bareToken) });
    }
  });

  test("a sentence holding two spaces and `(` itself: only the LAST such parenthetical is evidence, and the sentence keeps the rest", () => {
    const p = mapped(page({ recap: [{ repo: "app", text: "split the job  (see 2ee0ae6 for the first half)", evidence: "a1b2c3d" }] }));
    expect(card(p, "app").commits).toBe(1);
    expect(card(p, "app").points.map((x) => x.text)).toEqual(["split the job  (see 2ee0ae6 for the first half)"]);
  });

  test("`X of Y`, no SHA under two labels: the cards plus the (+N more) remainder equal Y; the total shown is Y", () => {
    const text = page({
      recap: [
        { repo: "app", text: "shipped the importer", evidence: "a1b2c3d" },
        { repo: "lib", text: "fixed two parser bugs", evidence: "b2c3d4e, c3d4e5f" },
      ],
      recapCoverage: { shown: 3, total: 6, notShown: [{ label: "app", sha: "d4e5f6a", subject: "tidy" }] },
    });
    expect(text).toContain("— 3 of 6 commits");   // PREMISE: the coverage form
    expect(text).toContain("(+2 more)");
    const p = mapped(text);
    expect(card(p, "app").commits).toBe(2);
    expect(card(p, "lib").commits).toBe(2);
    const cards = p.whatYouDid.cards.reduce((n, c) => n + c.commits, 0);
    expect(cards + p.whatYouDid.remainder.moreCount).toBe(6);
    expect(p.whatYouDid.commits).toBe(6);
    expect(p.whatYouDid.remainder.header).toBe("⚠ 3 in-window commit(s) NOT shown above:");
    expect(p.whatYouDid.remainder.more).toBe("(+2 more)");
  });

  test("the bare header: the total is the distinct SHA tokens across the section, 🔀 lines excluded, never the bullet count", () => {
    const text = page({
      recap: [
        { repo: "app", text: "shipped the importer", evidence: "a1b2c3d, b2c3d4e" },
        { repo: "lib", text: "the same commit seen from the library", evidence: "a1b2c3d" },
        { repo: "lib", text: "a bullet whose evidence was stripped" },
      ],
      windowMerges: [{ repo: "app", text: "🔀 Merged #12 (feat/x) (Oct 14)  (9f8e7d6)" }],
    });
    expect(text).toContain("▶ What you did — 3 commits");   // PREMISE: the bare form counts bullets
    expect(text).toContain("🔀 1 PR merged (#12)");
    const p = mapped(text);
    expect(p.whatYouDid.commits).toBe(2);   // a1b2c3d once, b2c3d4e; the merge's 9f8e7d6 is not a commit
    expect(card(p, "app").commits).toBe(2);
    expect(card(p, "lib").commits).toBe(1);   // a SHA cited under two labels counts in both cards
    expect(p.whatYouDid.prs).toBe(1);
    expect(card(p, "app").merged).toEqual([12]);
  });

  test("a bullet with no evidence counts nothing (the card reads \"Details ›\")", () => {
    const p = mapped(page({ recap: [{ repo: "app", text: "a bullet whose evidence was stripped" }] }));
    expect(card(p, "app").commits).toBe(0);
    expect(card(p, "app").lines.length).toBe(1);
  });

  test("an all-digit SHA counts; evidence with a nested parenthesis counts its SHA once; a sentence's own parentheses are never read", () => {
    const p = mapped(
      page({
        recap: [
          { repo: "app", text: "landed the numeric one", evidence: "1234567" },
          { repo: "app", text: "edited main (and its 2ee0ae6 test file)", evidence: "2ee0ae5 (src/main.ts)" },
        ],
      }),
    );
    expect(card(p, "app").commits).toBe(2);
    expect(p.whatYouDid.commits).toBe(2);
  });

  test("PRs: distinct numbers in every 🔀 form — plural, singular and the older `🔀 Merged #N`", () => {
    const text = [
      "☀️  Daily briefing — 2026-10-16  (this machine: mac)",
      "",
      "▶ What you did — 1 commit",
      "   • [app] shipped  (a1b2c3d)",
      "   • [app] 🔀 2 PRs merged (#12, #13) (Oct 14)  (a1b2c3e, c9d8e7f)",
      "   • [lib] 🔀 1 PR merged (#9) (Oct 13)  (e5f6a7b)",
      "   • [old] 🔀 Merged #11 (feat/old) (Oct 12)  (f6a7b8c)",
      "   • [zeta] Merged #40 (feat/x) on 10-12",
      "",
      "▶ Suggested next",
      "   (none)",
      "",
      "— generated via claude",
    ].join("\n");
    const p = mapped(text);
    expect(p.whatYouDid.prs).toBe(4);
    expect(card(p, "app").merged).toEqual([12, 13]);
    expect(card(p, "lib").merged).toEqual([9]);
    expect(card(p, "old").merged).toEqual([11]);
    // A line that is not a 🔀 line is an ordinary bullet: no PR, and no SHA in it.
    expect(card(p, "zeta").merged).toEqual([]);
    expect(card(p, "zeta").lines.length).toBe(1);
    expect(p.whatYouDid.commits).toBe(1);   // the 🔀 lines' SHAs are merge commits, never counted
  });

  test("PRs are distinct per project: the same number under two labels is two repos' PRs", () => {
    const p = mapped(
      page({
        windowMerges: [
          { repo: "app", text: "🔀 Merged #12 (feat/x) (Oct 14)  (a1b2c3d)" },
          { repo: "lib", text: "🔀 Merged #12 (feat/y) (Oct 14)  (b2c3d4e)" },
        ],
      }),
    );
    expect(p.whatYouDid.prs).toBe(2);
  });

  test("the engine's golden \"merges, quiet recap\": a quiet window with merges — 2 projects (merge-only cards count), 0 commits (not said, round-1 L2), 3 PRs", () => {
    const snap = readFileSync(new URL("../../test/__snapshots__/render.golden.test.ts.snap", import.meta.url), "utf8");
    const key = "every render corpus struct renders its frozen bytes: merges, quiet recap 1`] = `\n\"";
    const at = snap.indexOf(key);
    expect(at).toBeGreaterThan(-1);   // PREMISE: the golden is there
    const body = snap.slice(at + key.length);
    const text = body.slice(0, body.indexOf('"\n`;'));
    expect(text).toContain("(no commits in the window)");
    const p = mapped(text, "2026-09-15");
    expect(p.whatYouDid.quiet).toBe(true);
    expect(p.whatYouDid.projects).toBe(2);
    expect(p.whatYouDid.commits).toBe(0);
    expect(p.whatYouDid.prs).toBe(3);
    // …and Good morning says so: merges alone are work to count, though no commit is.
    const model = todayModel({ snapshot: null, latest: { state: "loaded", file: { path: "/state/briefing-latest.md", text, bytes: text.length } }, lastRun: null, today: "2026-09-15" });
    expect(goodMorning({ model, page: p, firstName: null, today: "2026-09-15" }).workLine).toBe("Your recent work: 2 projects · 3 PRs merged");
  });

  test("a single-PR day", () => {
    const p = mapped(
      page({
        recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }],
        windowMerges: [{ repo: "app", text: "🔀 Merged #644 (feat/deck) (Oct 15)  (abcdef1)" }],
      }),
    );
    expect(p.whatYouDid.prs).toBe(1);
  });

  test("\"Today so far\", with and without 🔀 lines, is never counted, and a project with only those lines is not one of \"N projects\"", () => {
    const p = mapped(
      page({
        recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }],
        today: [
          { repo: "app", text: "wip: notes  (b2c3d4e)" },
          { repo: "later", text: "started the thing  (c3d4e5f)" },
          { repo: "later", text: "🔀 Merged #50 (feat/y) (Oct 16)  (d4e5f6a)" },
        ],
      }),
    );
    expect(p.whatYouDid.projects).toBe(1);
    expect(p.whatYouDid.commits).toBe(1);
    expect(p.whatYouDid.prs).toBe(0);
    expect(card(p, "app").commits).toBe(1);
    expect(card(p, "app").todaySoFar).toEqual(["wip: notes  (b2c3d4e)"]);
    const later = card(p, "later");
    expect(later.commits).toBe(0);
    expect(later.merged).toEqual([]);
    expect(later.lines).toEqual([]);
    expect(later.todaySoFar).toEqual(["started the thing  (c3d4e5f)", "🔀 Merged #50 (feat/y) (Oct 16)  (d4e5f6a)"]);
  });

  test("a quiet day with only \"Today so far\" lines: no commits, no projects, and the today-only card kept", () => {
    const p = mapped(page({ today: [{ repo: "later", text: "started the thing  (c3d4e5f)" }] }));
    expect(p.whatYouDid.quiet).toBe(true);
    expect(p.whatYouDid.projects).toBe(0);
    expect(p.whatYouDid.commits).toBe(0);
    expect(p.whatYouDid.cards.map((c) => c.key)).toEqual(["later"]);
  });

  test("one day and several days: commits from several dates count the same as from one", () => {
    const recap = (dates: string) => [
      { repo: "mono", text: "reworked the header", evidence: "0a1b2c3", group: `web/app.ts — 3 commits (${dates})` },
      { repo: "mono", text: "fixed the footer", evidence: "1b2c3d4", group: `web/app.ts — 3 commits (${dates})` },
      { repo: "mono", text: "tuned the grid", evidence: "2c3d4e5", group: `web/app.ts — 3 commits (${dates})` },
      { repo: "api", text: "added the route", evidence: "3d4e5f6" },
    ];
    const one = mapped(page({ recap: recap("10-15") }));
    const several = mapped(page({ recap: recap("10-09..10-15") }));
    expect(several.whatYouDid.commits).toBe(4);
    expect(several.whatYouDid.projects).toBe(2);
    for (const k of ["commits", "projects", "prs"] as const) expect(several.whatYouDid[k]).toBe(one.whatYouDid[k]);
    expect(several.whatYouDid.cards.map((c) => [c.key, c.commits])).toEqual(one.whatYouDid.cards.map((c) => [c.key, c.commits]));
  });
});

/* ── A-M3-T7: points, why lines and the card's disclosure ─────────────────────────────────────── */

describe("points, why lines and the disclosure", () => {
  const card = (p: DeckPage, key: string) => {
    const c = p.whatYouDid.cards.find((x) => x.key === key);
    if (c === undefined) throw new Error(`no card ${key}`);
    return c;
  };
  const points = (p: DeckPage, key: string) => card(p, key).points.map((x) => x.text);
  type Recap = NonNullable<EngineStruct["recap"]>[number];
  const r = (text: string, evidence: string, extra: Partial<Recap> = {}): Recap => ({ repo: "app", text, evidence, ...extra });

  test("a flat bullet is a group of one; the 3 largest groups give one point each, ties by page order", () => {
    const p = mapped(
      page({
        recap: [
          r("one", "a000001"),
          r("story member a", "a000002", { group: "the importer story" }),
          r("story member b", "a000003", { group: "the importer story" }),
          r("two", "a000004"),
          r("three", "a000005"),
        ],
      }),
    );
    // The story is the largest (2 members); then "one" and "two" tie at 1 and page order breaks it.
    expect(points(p, "app")).toEqual(["story member a", "one", "two"]);
  });

  test("a header's stated count is its size: `X — N commits (dates)` beats a larger group with no count", () => {
    const p = mapped(
      page({
        recap: [
          r("big a", "b000001", { group: "the parser cleanup" }),
          r("big b", "b000002", { group: "the parser cleanup" }),
          r("big c", "b000003", { group: "the parser cleanup" }),
          r("counted a", "b000004", { group: "web/app.ts — 5 commits (10-14..10-15)" }),
          r("counted b", "b000005", { group: "web/app.ts — 5 commits (10-14..10-15)" }),
        ],
      }),
    );
    expect(points(p, "app")).toEqual(["counted a", "big a"]);
  });

  test("the engine's own `N of M` header forms give N: `X — 4 of 9 commits touching it` beats an uncounted 3-member story", () => {
    const g = "dup.py — 4 of 9 commits touching it (grouped: Oct 14)";
    const text = page({
      recap: [
        r("uncounted a", "b000001", { group: "the parser cleanup" }),
        r("uncounted b", "b000002", { group: "the parser cleanup" }),
        r("uncounted c", "b000003", { group: "the parser cleanup" }),
        r("stated a", "b000004, b000006", { group: g }),
        r("stated b", "b000005, b000007", { group: g }),
      ],
    });
    expect(text).toContain(`   • [app] ${g}`);   // PREMISE: the engine's header line (src/generator.ts:1308)
    expect(points(mapped(text), "app")).toEqual(["stated a", "uncounted a"]);
  });

  test("a campaign header `<campaign> — 5 of 7 commits naming it` over lone members beats a 3-commit story", () => {
    const camp = "M8 — 5 of 7 commits naming it (grouped: Oct 14)";
    const text = page({
      recap: [
        r("story a", "c000001", { group: "a — 3 commits (Oct 11)" }),
        r("story b", "c000002", { group: "a — 3 commits (Oct 11)" }),
        r("camp a", "c000003, c000005", { campaign: camp }),
        r("camp b", "c000004, c000006", { campaign: camp }),
      ],
    });
    expect(text).toContain(`   • [app] ${camp}`);   // PREMISE: the engine's header line (src/generator.ts:1321)
    expect(points(mapped(text), "app")).toEqual(["camp a", "story a"]);
  });

  test("a three-level campaign: each Stage-1 group (◦ header, ▪ members) is a group; a single ◦ member is a group of one", () => {
    const camp = "the billing rewrite";
    const p = mapped(
      page({
        recap: [
          r("g1 first", "c000001", { campaign: camp, group: "invoices — 3 commits (10-12..10-14)" }),
          r("g1 second", "c000002", { campaign: camp, group: "invoices — 3 commits (10-12..10-14)" }),
          r("g1 third", "c000003", { campaign: camp, group: "invoices — 3 commits (10-12..10-14)" }),
          r("single member", "c000004", { campaign: camp }),
          r("g2 first", "c000005", { campaign: camp, group: "receipts" }),
          r("g2 second", "c000006", { campaign: camp, group: "receipts" }),
        ],
      }),
    );
    expect(p.sections.find((s) => s.key === "whatYouDid")!.blocks.some((b) => b.kind === "nested2")).toBe(true);   // PREMISE
    expect(points(p, "app")).toEqual(["g1 first", "g2 first", "single member"]);
    expect(card(p, "app").commits).toBe(6);
  });

  test("a campaign whose members carry no Stage-1 group: the header and its lone members are one group", () => {
    const camp = "the deck";
    const p = mapped(
      page({
        recap: [
          r("deck one", "d000001", { campaign: camp }),
          r("deck two", "d000002", { campaign: camp }),
          r("deck three", "d000003", { campaign: camp }),
          r("flat a", "d000004"),
          r("flat b", "d000005"),
        ],
      }),
    );
    expect(points(p, "app")).toEqual(["deck one", "flat a", "flat b"]);
  });

  test("a mixed campaign: with a ◦ group header beside them, each lone ◦ member is a group of one", () => {
    const camp = "the mix";
    const p = mapped(
      page({
        recap: [
          r("lone one", "e000001", { campaign: camp }),
          r("grouped a", "e000002", { campaign: camp, group: "the group" }),
          r("grouped b", "e000003", { campaign: camp, group: "the group" }),
          r("lone two", "e000004", { campaign: camp }),
        ],
      }),
    );
    expect(points(p, "app")).toEqual(["grouped a", "lone one", "lone two"]);
  });

  test("header lines and 🔀 lines are never points", () => {
    const p = mapped(
      page({
        recap: [r("member", "f000001", { group: "a story header" })],
        windowMerges: [{ repo: "app", text: "🔀 Merged #3 (feat/x) (Oct 15)  (f000002)" }],
      }),
    );
    expect(points(p, "app")).toEqual(["member"]);
  });

  test("points are deterministic, and each is a verbatim sentence from the page (the evidence parenthetical is not part of it)", () => {
    const text = fixture("labels-15.md");
    const a = mapped(text);
    const b = mapped(text);
    expect(a.whatYouDid.cards.map((c) => c.points)).toEqual(b.whatYouDid.cards.map((c) => c.points));
    const pageLines = text.split("\n");
    for (const c of a.whatYouDid.cards) {
      for (const pt of c.points) {
        expect(pageLines.some((l) => l.includes(`${pt.text}  (`) || l.endsWith(pt.text))).toBe(true);
      }
    }
    expect(points(a, "alpha")).toEqual(["added the import step"]);
  });

  test("A-M5's decision: a point is the line's TEXT as the reader shows it — inline formatting (code, bold) is dropped, never its words", () => {
    const md = page({ recap: [r("fixed `parseX` so **bold** words stay", "a1b2c3d")] });
    expect(md).toContain("[app] fixed `parseX` so **bold** words stay  (a1b2c3d)");   // PREMISE: the page carries the markers
    const blocks = renderMarkdown(md);
    const line = blocks.find((b) => b.kind === "bullet" && blockText(b).startsWith("[app] fixed"))!;
    expect(line.spans.map((s) => s.kind)).toContain("code");   // PREMISE: the reader parsed them as spans
    const want = blockText(line).slice("[app] ".length, blockText(line).lastIndexOf("  ("));
    expect(want).toBe("fixed parseX so bold words stay");
    expect(points(mapped(md), "app")).toEqual([want]);
    // Every point is exactly one line's shown text, minus its label and evidence: not a paraphrase or a join.
    const text = fixture("labels-15.md");
    const shown = renderMarkdown(text).map((b) => blockText(b)).map((t) => parseLabel(t).rest).map((t) => t.slice(0, t.lastIndexOf("  (") === -1 ? t.length : t.lastIndexOf("  (")));
    for (const c of mapped(text).whatYouDid.cards) for (const pt of c.points) expect({ pt: pt.text, onPage: shown.includes(pt.text) }).toEqual({ pt: pt.text, onPage: true });
  });

  test("a point is the whole sentence (polish §1: the 110-character cut is gone, and `Point` keeps `text` only)", () => {
    const long = "a recap sentence that goes on and on ".repeat(9).slice(0, 300);
    expect([...long].length).toBe(300);   // PREMISE: well past the old 110-character cut
    expect(long.endsWith(" ")).toBe(false);
    const p = mapped(page({ recap: [r(long, "a1b2c3d")] }));
    // `toEqual` on the whole object: no `short` key (or any other) beside the text.
    expect(card(p, "app").points[0]).toEqual({ text: long });
    const shortOne = mapped(page({ recap: [r("short", "a1b2c3d")] }));
    expect(card(shortOne, "app").points[0]).toEqual({ text: "short" });
  });

  test("every bullet, nested, nested2 and not-shown line lands in exactly one card; the (+N more) line in the subtitle disclosure", () => {
    const camp = "the billing rewrite";
    const text = page({
      recap: [
        r("g1 first", "c000001", { campaign: camp, group: "invoices" }),
        r("g1 second", "c000002", { campaign: camp, group: "invoices" }),
        r("single", "c000004", { campaign: camp }),
        { repo: "Mono", text: "reworked the header", evidence: "0a1b2c3", group: "web/app.ts — 2 commits (10-14)" },
        { repo: "mono.", text: "fixed the footer", evidence: "1b2c3d4", group: "web/app.ts — 2 commits (10-14)" },
        { repo: "", text: "an unlabelled one", evidence: "2c3d4e5" },
      ],
      recapCoverage: { shown: 6, total: 10, notShown: [{ label: "app", sha: "3d4e5f6", subject: "tidy" }] },
      windowMerges: [{ repo: "app", text: "🔀 Merged #3 (feat/x) (Oct 15)  (4e5f6a7)" }],
    });
    const p = mapped(text);
    const w = p.sections.find((s) => s.key === "whatYouDid")!;
    const lineBlocks = w.blocks.filter((b) => ["bullet", "nested", "nested2", "notShown"].includes(b.kind));
    const more = lineBlocks.filter((b) => /^\(\+\d+ more\)$/.test(b.spans.map((s) => s.text).join("")));
    expect(more.length).toBe(1);
    const placed = p.whatYouDid.cards.flatMap((c) => [...c.lines.map((l) => l.text), ...c.mergedLines]);
    expect(placed.length).toBe(lineBlocks.length - more.length);
    expect(new Set(placed).size).toBe(placed.length);
    expect(p.whatYouDid.remainder.more).toBe("(+3 more)");
    // …and the card each line lands in is its label as the ENGINE normalises it.
    for (const b of lineBlocks.filter((x) => !more.includes(x))) {
      const { label, rest } = parseLabel(blockText(b));
      const holder = p.whatYouDid.cards.filter((c) => c.lines.some((l) => l.text === rest) || c.mergedLines.includes(rest));
      expect({ rest, keys: holder.map((c) => c.key) }).toEqual({ rest, keys: [engineNorm(label ?? "")] });
    }
  });

  test("a why line goes on the card of the labelled line AFTER it — after a (+N more) line, the next label's card", () => {
    const text = page({
      recap: [
        { repo: "accountant_ai", text: "added the review queue", evidence: "d4e5f60" },
        { repo: "mono", text: "reworked the header", evidence: "0a1b2c3" },
      ],
      recapCoverage: { shown: 2, total: 6, notShown: [{ label: "dba", sha: "abc1234", subject: "fix the render" }] },
      whys: { accountant_ai: 'ship the "HITL" view' },
    });
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.includes("(+3 more)"));
    expect(lines[at + 1]).toContain("— you wrote:");   // PREMISE: the golden's shape (calendar-off :283-284)
    expect(lines[at + 2]).toContain("[accountant_ai]");
    const p = mapped(text);
    expect(card(p, "accountant_ai").why).toEqual(['— you wrote: "ship the "HITL" view"']);
    expect(card(p, "dba").why).toEqual([]);
    expect(card(p, "mono").why).toEqual([]);
  });

  test("the disclosure: every commit line of the project as on the page, its cluster headers marked, its not-shown lines, and a Merged row", () => {
    const p = mapped(
      page({
        recap: [
          r("member a", "a000001", { group: "the story — 2 commits (10-15)" }),
          r("member b", "a000002", { group: "the story — 2 commits (10-15)" }),
          r("flat", "a000003"),
        ],
        recapCoverage: { shown: 3, total: 4, notShown: [{ label: "app", sha: "a000004", subject: "a dropped one" }] },
        windowMerges: [
          { repo: "app", text: "🔀 Merged #644 (feat/deck) (Oct 15)  (b000001)" },
          { repo: "app", text: "🔀 Merged #638 (feat/x) (Oct 14)  (b000002)" },
        ],
      }),
    );
    const c = card(p, "app");
    expect(c.lines.map((l) => [l.kind, l.header, l.text])).toEqual([
      ["notShown", false, "a000004 a dropped one"],
      ["bullet", true, "the story — 2 commits (10-15)"],
      ["nested", false, "member a  (a000001)"],
      ["nested", false, "member b  (a000002)"],
      ["bullet", false, "flat  (a000003)"],
    ]);
    expect(c.mergedRow).toBe("Merged: #644, #638");
    expect(c.commits).toBe(4);
  });
});

/* ── A-M4-T8: Good morning, Where you left off, Suggested for today ───────────────────────────── */

describe("Good morning, Where you left off and Suggested for today", () => {
  /** A `ScheduleState` of the shape Rust's `derive` emits (as `today.check.ts` builds them). */
  const state = (phase: Phase, statusLine: string): ScheduleState => ({
    phase,
    statusLine,
    floor: "07:20",
    floorWarning: null,
    firstWake: "",
    ticksToday: 11,
    ticksExpectedSinceFloor: 11,
    lastTick: null,
    owner: "app",
    invoker: "app",
    unitPath: null,
    registered: true,
    recordPresent: true,
    unitPresent: true,
    engineVersion: "0.1.1",
    installedEngineVersion: "0.1.1",
    engineUpdateAvailable: false,
    intervalSec: 600,
    experimental: false,
    lingerState: null,
    recordFilePresent: true,
    registeredReason: null,
    removeSteps: "Run these in a terminal (bash or zsh) inside your desktop session.",
  });
  const snapshot = (s: ScheduleState | null, extra: Partial<Snapshot> = {}): Snapshot => ({
    status: { latestBriefingMtime: "2026-10-16T07:24:00.000Z", archivedDates: [] },
    lastSkip: null,
    schedule: null,
    scheduleStale: false,
    scheduleState: s,
    error: null,
    updatesStopped: false,
    ...extra,
  });
  const loaded = (text: string): LatestLoad => ({ state: "loaded", file: { path: "/state/briefing-latest.md", text, bytes: text.length } });
  const delivered = state({ phase: "delivered", at: "2026-10-16T07:24:00.000Z" }, "Delivered 07:24");
  /** Today's model and the deck's page, from the same inputs Today has. */
  function both(text: string, snap: Snapshot | null = snapshot(delivered), firstName: string | null = null) {
    const model = todayModel({ snapshot: snap, latest: loaded(text), lastRun: null, today: TODAY });
    const deckPage = mapped(text);
    return { model, deckPage, gm: goodMorning({ model, page: deckPage, firstName, today: TODAY }) };
  }

  test("the greeting: with a first name, without one, and the page's date; a stale page says whose briefing it is", () => {
    expect(both(page(), undefined, "Sam").gm.greeting).toBe("Good morning, Sam");
    expect(both(page()).gm.greeting).toBe("Good morning");
    expect(both(page(), undefined, "").gm.greeting).toBe("Good morning");   // an empty name is no name
    expect(both(page()).gm.date).toBe("Friday 16 October");
    const old = page({ date: "2026-10-14" });
    const model = todayModel({ snapshot: snapshot(delivered), latest: loaded(old), lastRun: null, today: TODAY });
    const gm = goodMorning({ model, page: mapped(old), firstName: "Sam", today: TODAY });
    expect(gm.greeting).toBe("Your last briefing, from Wednesday 14 October");
    expect(gm.date).toBe("Wednesday 14 October");
  });

  test("the status line and EVERY banner reach Good morning verbatim: a failed run's lastFailure, a skip, a config error, a read error", () => {
    const detail = 'skipped: account "primary" is unavailable — will retry next interval';
    const failure = { localDate: TODAY, reason: "provider-error", detail: "the provider exited 1: rate limited" };
    const cases: { snap: Snapshot | null; latest: LatestLoad; want: string }[] = [
      {
        snap: snapshot(state({ phase: "waiting-for-wake" }, "Waiting"), {
          status: { latestBriefingMtime: null, archivedDates: [], lastFailure: failure },
        }),
        latest: loaded(page()),
        want: `${FAILURE_BANNER_LEAD}\n${failure.detail}`,
      },
      {
        snap: snapshot(state({ phase: "skipped", reason: "limited", detail, iso: null }, "Usage limit — skipped"), {
          error: "schedule status timed out after 10 s",
        }),
        latest: loaded(page()),
        want: detail,
      },
      {
        snap: snapshot(
          state({ phase: "config-error", detail: "config.json: provider.api.model is missing", deliveredToday: false, deliveredAt: null }, "Config error"),
        ),
        latest: loaded(page()),
        want: "config.json: provider.api.model is missing",
      },
      { snap: snapshot(delivered), latest: { state: "error", message: "/p is a symbolic link" }, want: "/p is a symbolic link" },
    ];
    for (const { snap, latest, want } of cases) {
      const model = todayModel({ snapshot: snap, latest, lastRun: null, today: TODAY });
      const deckPage = latest.state === "loaded" ? mapped(latest.file.text) : null;
      const gm = goodMorning({ model, page: deckPage, firstName: null, today: TODAY });
      expect(gm.banners).toEqual(model.banners);
      expect(gm.banners.map((b) => b.text)).toContain(want);
      expect(gm.status).toEqual(model.status);
    }
    // PREMISE for "every": the skip case carries two banners, and both are there.
    const two = todayModel({ snapshot: cases[1]!.snap, latest: cases[1]!.latest, lastRun: null, today: TODAY });
    expect(goodMorning({ model: two, page: mapped(page()), firstName: null, today: TODAY }).banners.map((b) => b.text)).toEqual([
      "schedule status timed out after 10 s",
      detail,
    ]);
  });

  test("Your recent work and the commit bars come from What you did's counts; the first suggestion is the glance tile", () => {
    const { gm } = both(
      page({
        recap: [
          { repo: "app", text: "shipped", evidence: "a1b2c3d, b2c3d4e, c3d4e5f" },
          { repo: "lib", text: "fixed", evidence: "d4e5f6a" },
          { repo: "", text: "an unlabelled one", evidence: "e5f6a7b" },
        ],
        windowMerges: [{ repo: "app", text: "🔀 Merged #12 (feat/x) (Oct 15)  (f6a7b8c)" }],
        suggestions: [{ repo: "lib", text: "review the fix" }, { text: "write the note" }],
      }),
    );
    // User-directed 2026-10-22 (Good morning option 2): "Your recent work", the label bold on the slide.
    expect(gm.workLine).toBe("Your recent work: 2 projects · 5 commits · 1 PR merged");
    expect(gm.workLine!.startsWith(`${WORK_LABEL} `)).toBe(true);
    expect(gm.bars.map((b) => [b.label, b.commits])).toEqual([["app", 3], ["lib", 1]]);
    expect(gm.firstSuggestion?.text).toBe("review the fix");
    expect(gm.quietLine).toBeNull();
  });

  test("A-M6 reading: a project with activity but no counted commit never says \"0 commits\" — its card names its PRs or no count, and it has no commit bar", () => {
    const { gm, deckPage } = both(
      page({
        recap: [
          { repo: "app", text: "shipped", evidence: "a1b2c3d" },
          { repo: "nosha", text: "a commit whose evidence was stripped" },
        ],
        windowMerges: [
          { repo: "merges", text: "🔀 Merged #12 (feat/x) (Oct 15)  (f6a7b8c)" },
          { repo: "merges", text: "🔀 Merged #13 (feat/y) (Oct 15)  (a7b8c9d)" },
          { repo: "onepr", text: "🔀 Merged #20 (feat/z) (Oct 15)  (b8c9d0e)" },
        ],
      }),
    );
    const label = (key: string) => cardCountLabel(deckPage.whatYouDid.cards.find((c) => c.key === key)!);
    expect(label("app")).toBe("1 commit");
    expect(label("merges")).toBe("2 PRs merged");
    expect(label("onepr")).toBe("1 PR merged");
    expect(label("nosha")).toBeNull();
    // The bars are COMMIT bars: a zero-length bar says nothing, and the PRs are in the Your-recent-work line.
    expect(gm.bars.map((b) => [b.label, b.commits])).toEqual([["app", 1]]);
    expect(gm.workLine).toBe("Your recent work: 4 projects · 1 commit · 3 PRs merged");
    // …and a card with commits keeps its count, plural or not.
    expect(cardCountLabel({ ...deckPage.whatYouDid.cards[0]!, commits: 3 })).toBe("3 commits");
  });

  test("a quiet day without a warning: the quiet line, no Your-recent-work line, and What you did's \"No commits in this window\"", () => {
    const { gm, deckPage } = both(page());
    expect(gm.quietLine).toBe(QUIET_DAY_LINE);
    expect(gm.workLine).toBeNull();
    expect(deckPage.whatYouDid.emptyText).toBe("No commits in this window");
  });

  test("a quiet day with a warning: the quiet-with-warning line, and the warning in needs-a-look", () => {
    const { gm, deckPage } = both(page({ warnings: ["invalid morning time"] }));
    expect(gm.quietLine).toBe(QUIET_WITH_WARNING_LINE);
    expect(gm.needsALook).toEqual(["⚠ invalid morning time"]);
    expect(deckPage.whatYouDid.emptyText).toBe("No commits in this window");
  });

  test("the quiet lines are TodayView's, word for word", () => {
    const view = readFileSync(new URL("../src/routes/TodayView.svelte", import.meta.url), "utf8");
    // The WHOLE text of each quiet element, not a substring (round 1): a shortened copy here would fail.
    const lines = [...view.matchAll(/<p class="state quiet">([^<]*)<\/p>/g)].map((m) => m[1]);
    expect(lines).toEqual([QUIET_WITH_WARNING_LINE, QUIET_DAY_LINE]);
  });

  test("on a quiet day, a card holding only \"Today so far\" lines follows the quiet-day line", () => {
    const { deckPage } = both(page({ today: [{ repo: "later", text: "started the thing  (c3d4e5f)" }] }));
    expect(deckPage.whatYouDid.emptyText).toBe("No commits in this window");
    expect(deckPage.whatYouDid.cards.map((c) => [c.key, c.todaySoFar])).toEqual([["later", ["started the thing  (c3d4e5f)"]]]);
  });

  test("resume cards: each branch shape becomes a tag, its ahead and behind counts kept; an unparseable branch line stays a line, never a tag", () => {
    const p = mapped(
      page({
        branchState: [
          { repo: "app", text: "On branch feat/deck (ahead 2, behind 1)" },
          { repo: "lib", text: "On branch main (no upstream)" },
          { repo: "tool", text: "Detached HEAD at abc1234" },
          { repo: "odd", text: "On branch main (something the code never writes)" },
        ],
        resume: [
          { repo: "app", text: "finish the deck" },
          { repo: "lib", text: "tag the release" },
        ],
      }),
    );
    const byKey = Object.fromEntries(p.leftOff.cards.map((c) => [c.key, c]));
    expect(byKey["app"]!.branch).toEqual({ kind: "branch", name: "feat/deck", ahead: 2, behind: 1 });
    expect(byKey["app"]!.items).toEqual(["finish the deck"]);
    expect(byKey["lib"]!.branch).toEqual({ kind: "branch", name: "main", ahead: null, behind: null });
    expect(byKey["tool"]!.branch).toEqual({ kind: "detached", sha: "abc1234" });
    expect(byKey["odd"]!.branch).toBeNull();
    expect(byKey["odd"]!.items).toEqual(["On branch main (something the code never writes)"]);
    expect(p.leftOff.empty).toBe(false);
    expect(p.leftOff.cards.map((c) => c.key)).toEqual(["app", "lib", "tool", "odd"]);
  });

  test("a card's second branch line (two repos under one label) stays a line: the first is the tag, nothing is lost", () => {
    const text = page({
      branchState: [
        { repo: "app", text: "On branch main (ahead 1, behind 0)" },
        { repo: "app", text: "Detached HEAD at abc1234" },
      ],
    });
    expect(text).toContain("   • [app] Detached HEAD at abc1234");   // PREMISE: the engine writes both
    const card = mapped(text).leftOff.cards.find((c) => c.key === "app")!;
    expect(card.branch).toEqual({ kind: "branch", name: "main", ahead: 1, behind: 0 });
    expect(card.items).toEqual(["Detached HEAD at abc1234"]);
  });

  test("the branch shapes are git.ts's own: its template, evaluated, gives lines parseBranch reads (red when either side drifts)", () => {
    const src = readFileSync(new URL("../../src/git.ts", import.meta.url), "utf8");
    const at = src.indexOf("const text = branch === \"HEAD\" && tip");
    expect(at).toBeGreaterThan(-1);   // PREMISE: the template is where the engine builds the line
    const expr = src.slice(at + "const text = ".length, src.indexOf(";\n", at));
    expect(expr).toContain("Detached HEAD at");
    expect(expr).toContain("On branch");
    const line = new Function("branch", "tip", "hasUpstream", "ahead", "behind", `return (${expr});`) as (
      branch: string,
      tip: string,
      hasUpstream: boolean,
      ahead: number,
      behind: number,
    ) => string;
    const cases: [string, ReturnType<typeof parseBranch>][] = [
      [line("feat/deck", "0123456789abcdef", true, 3, 1), { kind: "branch", name: "feat/deck", ahead: 3, behind: 1 }],
      [line("main", "0123456789abcdef", true, 0, 0), { kind: "branch", name: "main", ahead: 0, behind: 0 }],
      [line("main", "0123456789abcdef", true, 0, 7), { kind: "branch", name: "main", ahead: 0, behind: 7 }],
      [line("main", "0123456789abcdef", false, 0, 0), { kind: "branch", name: "main", ahead: null, behind: null }],
      [line("HEAD", "0123456789abcdef", false, 0, 0), { kind: "detached", sha: "0123456" }],
    ];
    for (const [text, want] of cases) expect({ text, got: parseBranch(text) }).toEqual({ text, got: want });
  });

  test("user-directed 2026-10-21: the tag's counts — \"ahead N\" and \"behind N\" only when N > 0, ahead first (git's own order); no upstream shows neither", () => {
    const words = (text: string) => branchCounts(parseBranch(text)!);
    expect(words("On branch main (ahead 0, behind 0)")).toEqual([]);
    expect(words("On branch main (ahead 3, behind 0)")).toEqual(["ahead 3"]);
    expect(words("On branch main (ahead 0, behind 2)")).toEqual(["behind 2"]);
    expect(words("On branch main (ahead 3, behind 2)")).toEqual(["ahead 3", "behind 2"]);
    expect(words("On branch main (no upstream)")).toEqual([]);
    expect(words("Detached HEAD at abc1234")).toEqual([]);
  });

  test("Where you left off's why line goes on the resume card of the labelled line after it", () => {
    const text = page({
      resume: [
        { repo: "app", text: "resume the audit" },
        { repo: "lib", text: "wire the queue" },
      ],
      whys: { lib: "finish the queue" },
    });
    expect(text).toContain('   — you wrote: "finish the queue"\n   • [lib] wire the queue');   // PREMISE: the engine's shape
    const p = mapped(text);
    const byKey = Object.fromEntries(p.leftOff.cards.map((c) => [c.key, c]));
    expect(byKey["lib"]!.why).toEqual(['— you wrote: "finish the queue"']);
    expect(byKey["app"]!.why).toEqual([]);
  });

  test("no why line is silently dropped: one with no line after it is not a page the engine wrote", () => {
    const resumeWhy = page({ resume: [{ repo: "app", text: "resume" }] }).replace(
      "   • [app] resume\n",
      '   • [app] resume\n   — you wrote: "a why with nothing after it"\n',
    );
    expect(refused(resumeWhy)).toEqual({ reason: "unattached-line", line: '— you wrote: "a why with nothing after it"' });
    const recapWhy = page({ recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }] }).replace(
      "   • [app] shipped  (a1b2c3d)\n",
      '   • [app] shipped  (a1b2c3d)\n   — you wrote: "a why with nothing after it"\n',
    );
    expect(refused(recapWhy).reason).toBe("unattached-line");
    // At the END of the page (no heading after it): a page cut short after What you did's last why.
    const full = page({ recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }], whys: { app: "ship it" } });
    expect(full).toContain('   — you wrote: "ship it"\n   • [app] shipped  (a1b2c3d)');   // PREMISE: the engine's shape
    const cut = full.slice(0, full.indexOf("   • [app] shipped  (a1b2c3d)"));
    expect(cut.split("\n").filter((l) => l.startsWith("▶ ")).at(-1)).toMatch(/^▶ What you did/);   // PREMISE: no heading after the why
    expect(refused(cut)).toEqual({ reason: "unattached-line", line: '— you wrote: "ship it"' });
  });

  test("empty Where you left off and Suggested: the slides' empty states", () => {
    const p = mapped(page());
    expect(p.leftOff).toEqual({ cards: [], empty: true });
    expect(p.suggested.cards).toEqual([]);
    expect(p.suggested.empty).toBe(true);
    expect(p.suggested.title).toBe("Suggested for today");
  });

  test("suggestions: numbered, a pill only with a label, the verdict marker on the suggestion above it, provenance kept", () => {
    const p = mapped(
      page({
        recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }],
        suggestions: [
          { repo: "app", text: "check the verdict file", verdictPath: true },
          { text: "write the release note" },
          { repo: "app", text: "run the audit", promoted: true },
        ],
      }),
    );
    expect(p.suggested.cards).toEqual([
      {
        n: 1,
        key: "app",
        label: "app",
        slot: p.slots["app"]!,
        text: "check the verdict file",
        marker: "⚑ human gate: cites a commit on a configured verdict path",
      },
      { n: 2, key: null, label: null, slot: null, text: "write the release note", marker: null },
      { n: 3, key: "app", label: "app", slot: p.slots["app"]!, text: "run the audit  (from resume)", marker: null },
    ]);
    expect(p.suggested.title).toBe("Suggested for today");
  });

  test("a verdict marker with no suggestion above it is not a page the engine wrote", () => {
    const marked = page({ suggestions: [{ repo: "app", text: "x", verdictPath: true }] });
    const markerLine = marked.split("\n").find((l) => l.startsWith(VERDICT_MARKER_PREFIX))!;
    const orphan = marked.replace("▶ Suggested next\n", `▶ Suggested next\n${markerLine}\n`);
    expect(refused(orphan)).toEqual({ reason: "unattached-line", line: markerLine });
    // …nor is a second marker under one suggestion (the engine writes at most one: `render.ts:527`).
    const second = marked.replace(`${markerLine}\n`, `${markerLine}\n${markerLine}\n`);
    expect(second).not.toBe(marked);
    expect(refused(second)).toEqual({ reason: "unattached-line", line: markerLine });
  });

  test("A-M6 (for the archive probe): a refusal names the deciding block's INDEX — the second of two identical lines, the first waiting why; -1 for no title", () => {
    const at = (text: string): number => {
      const r = mapPage(renderMarkdown(text), TODAY);
      if (r.ok) throw new Error("expected the page NOT to map");
      return r.index;
    };
    const idx = (text: string, line: string, nth = 0): number => {
      const hits = renderMarkdown(text).flatMap((b, i) => (blockText(b) === line ? [i] : []));
      return hits[nth] ?? -2;
    };
    expect(at(fixture("cannot-map-no-title.md"))).toBe(-1);
    for (const f of ["cannot-map-heading-missing.md", "cannot-map-text-in-section.md", "unknown-bullet-shape.md"]) {
      const text = fixture(f);
      expect({ f, at: at(text) }).toEqual({ f, at: idx(text, refused(text).line) });
    }
    const marked = page({ suggestions: [{ repo: "app", text: "x", verdictPath: true }] });
    const markerLine = marked.split("\n").find((l) => l.startsWith(VERDICT_MARKER_PREFIX))!;
    const second = marked.replace(`${markerLine}\n`, `${markerLine}\n${markerLine}\n`);
    const markerText = refused(second).line;
    expect(idx(second, markerText, 1)).toBeGreaterThan(idx(second, markerText, 0));   // PREMISE: two identical blocks
    expect(at(second)).toBe(idx(second, markerText, 1));
    // Two why lines waiting at a heading: the FIRST one decides (it is the line `refused` names).
    const twoWhys = page({ resume: [{ repo: "app", text: "resume" }] }).replace(
      "   • [app] resume\n",
      '   • [app] resume\n   — you wrote: "one"\n   — you wrote: "two"\n',
    );
    expect(refused(twoWhys).line).toBe('— you wrote: "one"');
    expect(at(twoWhys)).toBe(idx(twoWhys, '— you wrote: "one"'));
  });

  test("a label that normalises to nothing (`[**]`, `[ ]`) is no pill: no key, no label, no colour", () => {
    const text = page({ suggestions: [{ repo: "**", text: "starred" }, { repo: " ", text: "blank" }] });
    expect(text).toContain("   • [**] starred");   // PREMISE: the engine writes the brackets
    expect(text).toContain("   • [ ] blank");
    expect(mapped(text).suggested.cards).toEqual([
      { n: 1, key: null, label: null, slot: null, text: "starred", marker: null },
      { n: 2, key: null, label: null, slot: null, text: "blank", marker: null },
    ]);
  });
});

/* ── A-M4-T9: the calendar slide, the meeting tile and the clock ──────────────────────────────── */

describe("the calendar slide, the meeting tile and the clock", () => {
  test("unmarked removes only trailing calendar marks in renderer order", () => {
    expect([
      "Standup",
      "Standup · ended",
      "Standup · tentative",
      "Standup · tentative · ended",
      "Standup · ended · tentative",
      "Standup · tentative agenda",
      "Standup · ended ",
    ].map(unmarked)).toEqual([
      "Standup", "Standup", "Standup", "Standup", "Standup · ended", "Standup · tentative agenda", "Standup · ended ",
    ]);
  });

  test("near-duplicates (spec §6): unmarked strips ended, then tentative, then a merge mark that matches the grammar", () => {
    const stripped = [
      "Standup · on 2 calendars",
      "Standup · on 9 calendars",
      "Standup · on 10 calendars",
      "Standup · on 123 calendars",
      "Standup · 2 copies",
      "Standup · 9 copies",
      "Standup · 10 copies",
      "Standup · 40 copies",
      "Standup · on 3 calendars · tentative",
      "Standup · on 3 calendars · ended",
      "Standup · on 3 calendars · tentative · ended",
      "Standup · 2 copies · tentative",
      "Standup · 4 copies · tentative · ended",
    ];
    expect(stripped.map(unmarked)).toEqual(stripped.map(() => "Standup"));
    // The grammar refuses one calendar, one or zero copies, a leading zero, a singular noun, trailing words and a
    // missing separator: those stay text.
    for (const kept of [
      "Standup · on 1 calendars",
      "Standup · on 0 calendars",
      "Standup · 1 copies",
      "Standup · 0 copies",
      "Standup · on 02 calendars",
      "Standup · 02 copies",
      "Standup · on 2 calendar",
      "Standup · 2 copy",
      "Standup · on 2 calendars agenda",
      "Standup · 2 copies ",
      "Standup on 2 calendars",
      "Standup · on two calendars",
    ]) expect(unmarked(kept)).toBe(kept);
    expect(unmarked("Standup · on 1 calendars · tentative")).toBe("Standup · on 1 calendars");
    // The order is ended, tentative, then the merge mark: a merge mark AFTER tentative leaves tentative in the text,
    // and only one merge mark comes off.
    expect(unmarked("Standup · tentative · on 2 calendars")).toBe("Standup · tentative");
    expect(unmarked("Standup · 2 copies · on 3 calendars")).toBe("Standup · 2 copies");
  });

  /** A local wall time on a date, as the engine's renderer reads instants (its LOCAL zone). */
  const at = (date: string, hh: number, mm: number, plusDays = 0): number => {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    return new Date(y, m - 1, d + plusDays, hh, mm).getTime();
  };
  const MIN = 60_000;
  const timed = (date: string, start: [number, number, number?], end: [number, number, number?], title: string, extra: Partial<CalendarStructEvent> = {}): CalendarStructEvent => ({
    time: { kind: "timed", startMs: at(date, start[0], start[1], start[2] ?? 0), endMs: at(date, end[0], end[1], end[2] ?? 0) },
    title,
    status: "confirmed",
    transparency: "busy",
    attendeeCount: 2,
    ...extra,
  });
  const cal = (events: CalendarStructEvent[]): CalendarStruct => ({ events, sources: [{ id: "macos", kind: "macos", status: "ok" }], incomplete: false });
  const calPage = (events: CalendarStructEvent[], date = TODAY) => mapped(page({ date, calendar: cal(events) } as Partial<EngineStruct>), date);

  /** The parsed span of a fixture line, as local wall times on the fixture's page date (2026-10-14). */
  const FIX = "2026-10-14";
  type Want =
    | { kind: "status" | "more" }
    | { kind: "allDay" | "unclear"; title: string }
    | { kind: "event"; span: null }
    | { kind: "event"; span: [number, number]; title: string; tentative?: true; ended?: true };
  const span = (s: number, e: number, title: string, flags: { tentative?: true; ended?: true } = {}): Want => ({ kind: "event", span: [s, e], title, ...flags });

  zonedTest("every line of the frozen calendar fixture: status lines stay status lines, every timed shape parses, all-day and unclear are not tiles", () => {
    const variants = readSectionFixture();
    expect([...variants.keys()]).toEqual(["full-day", "busy-day", "unavailable", "quiet", "no-sources", "merged"]);   // PREMISE
    const WANT: Record<string, Want> = {
      "work: the link was refused — it may have been reset; add it again": { kind: "status" },
      "team: only partly read — some events may be missing": { kind: "status" },
      // C's pins (wave-2 plan C-M4-T12): the all-day and "time unclear" rows are their own kinds, for the strip, never a span.
      "all day — Company offsite (Lisbon)": { kind: "allDay", title: "Company offsite (Lisbon)" },
      "all day — Conference week · tentative": { kind: "allDay", title: "Conference week" },
      "since Oct 12 → 12:00  On-call rotation": span(at(FIX, 0, 0, -2), at(FIX, 12, 0), "On-call rotation"),
      "since yesterday → 02:00  Overnight deploy watch · ended": span(at(FIX, 0, 0, -1), at(FIX, 2, 0), "Overnight deploy watch", { ended: true }),
      "07:30–07:45  Gym check-in · tentative · ended": span(at(FIX, 7, 30), at(FIX, 7, 45), "Gym check-in", { tentative: true, ended: true }),
      "08:00–08:30  Breakfast with Sam (Café Nero) · ended": span(at(FIX, 8, 0), at(FIX, 8, 30), "Breakfast with Sam (Café Nero)", { ended: true }),
      "09:00–09:30  Standup (Room 4)": span(at(FIX, 9, 0), at(FIX, 9, 30), "Standup (Room 4)"),
      "11:00–12:00  Design review (zoom.us link) · tentative": span(at(FIX, 11, 0), at(FIX, 12, 0), "Design review (zoom.us link)", { tentative: true }),
      "12:00  Submit timesheet": span(at(FIX, 12, 0), at(FIX, 12, 0), "Submit timesheet"),
      "time unclear (14:00–15:00 Custom/Lunar Base)  Vendor sync": { kind: "unclear", title: "Vendor sync" },
      "15:00–15:30  (no title)": span(at(FIX, 15, 0), at(FIX, 15, 30), "(no title)"),
      "22:00 → Oct 16 18:00  Hackathon": span(at(FIX, 22, 0), at(FIX, 18, 0, 2), "Hackathon"),
      "23:00 → 01:00 tomorrow  Release night": span(at(FIX, 23, 0), at(FIX, 1, 0, 1), "Release night"),
      "23:30–24:00  Late call with APAC": span(at(FIX, 23, 30), at(FIX, 0, 0, 1), "Late call with APAC"),
      "+3 more": { kind: "more" },
      "Calendar unavailable today": { kind: "status" },
      "Mac Calendar: calendar access has not been granted yet — allow it in Settings → Calendar": { kind: "status" },
      "work: did not answer in time": { kind: "status" },
      "No events today": { kind: "status" },
      "No calendar is connected": { kind: "status" },
      "14:00–22:00  Ticket: X (Polk St) · on 2 calendars · tentative": span(at(FIX, 14, 0), at(FIX, 22, 0), "Ticket: X (Polk St)", { tentative: true }),
    };
    let checked = 0;
    for (const lines of variants.values()) {
      for (const raw of lines.slice(1)) {
        expect(raw.startsWith("   ◦ ")).toBe(true);
        const line = raw.slice("   ◦ ".length);
        const row = parseCalendarLine(line, FIX);
        expect(row.text).toBe(line);
        const slot = /^(\d\d):(\d\d)–(\d\d):(\d\d)  Interview slot \d\d$/.exec(line);
        const want: Want = slot
          ? span(at(FIX, Number(slot[1]), Number(slot[2])), at(FIX, Number(slot[3]), Number(slot[4])), line.split("  ")[1]!)
          : WANT[line]!;
        expect({ line, want: want !== undefined }).toEqual({ line, want: true });
        if (want.kind === "allDay" || want.kind === "unclear") {
          expect({ line, kind: row.kind, title: row.kind === "allDay" || row.kind === "unclear" ? row.title : "?" }).toEqual({ line, kind: want.kind, title: want.title });
        } else if (want.kind !== "event") {
          expect({ line, kind: row.kind }).toEqual({ line, kind: want.kind });
        } else if (want.span === null) {
          expect({ line, kind: row.kind, event: row.kind === "event" ? row.event : "?" }).toEqual({ line, kind: "event", event: null });
        } else {
          const e = row.kind === "event" ? row.event : null;
          expect({ line, got: e && [e.startMs, e.endMs, e.title, e.tentative, e.ended] }).toEqual({
            line,
            got: [want.span[0], want.span[1], want.title, want.tentative === true, want.ended === true],
          });
        }
        checked++;
      }
    }
    expect(checked).toBe(83);   // every variant line but the six headings: 16 + 61 + 3 + 1 + 1 + 1
  });

  zonedTest("synthesised lines for the forms the fixture lacks (checked absent first): a DST mark, `since yesterday → 24:00`, `since <Mon D> → <Mon D> HH:MM`", () => {
    const fixtureText = readFileSync(new URL("../../test/fixtures/calendar/rendered-section.txt", import.meta.url), "utf8");
    expect(fixtureText).not.toContain("(clocks go");
    expect(fixtureText).not.toContain("since yesterday → 24:00");
    expect(fixtureText).not.toMatch(/since [A-Z][a-z]{2} \d+ → [A-Z][a-z]{2} \d+ \d\d:\d\d/);
    const ev = (line: string) => {
      const row = parseCalendarLine(line, FIX);
      return row.kind === "event" && row.event !== null ? [row.event.startMs, row.event.endMs, row.event.title] : null;
    };
    expect(ev("01:00–03:00 (clocks go back)  Night shift")).toEqual([at(FIX, 1, 0), at(FIX, 3, 0), "Night shift"]);
    expect(ev("01:00 → 01:00 tomorrow (clocks go forward)  Long run")).toEqual([at(FIX, 1, 0), at(FIX, 1, 0, 1), "Long run"]);
    expect(ev("since yesterday → 24:00  All-nighter")).toEqual([at(FIX, 0, 0, -1), at(FIX, 0, 0, 1), "All-nighter"]);
    expect(ev("since Oct 12 → Oct 16 18:00  Conference")).toEqual([at(FIX, 0, 0, -2), at(FIX, 18, 0, 2), "Conference"]);
    // A line the grammar does not recognise is skipped, never guessed: a `→` where the engine writes `–`.
    expect(ev("09:00 → 09:30  Wrong separator")).toBeNull();
    expect(ev("9:00–9:30  No leading zero")).toBeNull();
    // …and a `–` pair whose end (or start) is not today's: the engine writes ` → ` there.
    expect(ev("09:00–10:00 tomorrow  Wrong separator")).toBeNull();
    expect(ev("09:00–Oct 16 18:00  Wrong separator")).toBeNull();
    expect(ev("since yesterday–10:00  Wrong separator")).toBeNull();
    expect(ev("09:00 → 10:00 tomorrow  Right separator")).toEqual([at(FIX, 9, 0), at(FIX, 10, 0, 1), "Right separator"]);   // PREMISE: the arrow form parses
  });

  zonedTest("C's all-day and unclear rows stay out of `events`: never a tile, a next meeting or a span (A's \"all-day and unclear are not tiles\" holds)", () => {
    const p = calPage([
      { time: { kind: "allDay", startDate: TODAY, endDateExclusive: "2026-10-17" }, title: "Offsite", status: "confirmed", transparency: "free", attendeeCount: 0 },
      { time: { kind: "unclear", startDate: TODAY, endDate: TODAY, wallStart: "08:00", wallEnd: "09:00", tzid: "Mars/Base" }, title: "Vendor", status: "confirmed", transparency: "busy", attendeeCount: 1 },
      timed(TODAY, [9, 0], [9, 30], "Standup"),
    ]);
    expect(p.calendar!.rows.map((r) => r.kind)).toEqual(["allDay", "unclear", "event"]);
    expect(p.calendar!.events.map((e) => e.title)).toEqual(["Standup"]);
    // An all-day event spans the whole day and the unclear one 08:00-09:00: had either been an event, it would be the
    // tile and the next meeting at 08:30.
    expect(meetingTile(TODAY, p.calendar!.events, at(TODAY, 8, 30))?.event.title).toBe("Standup");
    expect(nextMeeting(TODAY, p.calendar!.events, at(TODAY, 8, 30))?.title).toBe("Standup");
  });

  zonedTest("near-duplicates (spec §6): the engine's merged rows parse with the merge mark off the title and tentative/ended kept, on every row kind", () => {
    const merged = (mark: "calendars" | "copies", count: number) => ({ merged: { mark, count } }) as Partial<CalendarStructEvent>;
    const p = calPage([
      { time: { kind: "allDay", startDate: TODAY, endDateExclusive: "2026-10-17" }, title: "Offsite", status: "confirmed", transparency: "free", attendeeCount: 0, ...merged("calendars", 2) },
      { time: { kind: "unclear", startDate: TODAY, endDate: TODAY, wallStart: "08:00", wallEnd: "09:00", tzid: "Mars/Base" }, title: "Vendor", status: "tentative", transparency: "busy", attendeeCount: 1, ...merged("copies", 12) },
      timed(TODAY, [9, 0], [9, 30], "Standup", { location: "Room 4", ...merged("calendars", 3) }),
      timed(TODAY, [10, 0], [10, 30], "Review", { status: "tentative", ended: true, ...merged("copies", 2) }),
      timed(TODAY, [11, 0], [11, 30], "Retro", { ended: true, ...merged("calendars", 10) }),
    ]);
    // PREMISE: the engine's own lines, the merge mark before tentative and ended.
    expect(p.calendar!.rows.map((r) => r.text)).toEqual([
      "all day — Offsite · on 2 calendars",
      "time unclear (08:00–09:00 Mars/Base)  Vendor · 12 copies · tentative",
      "09:00–09:30  Standup (Room 4) · on 3 calendars",
      "10:00–10:30  Review · 2 copies · tentative · ended",
      "11:00–11:30  Retro · on 10 calendars · ended",
    ]);
    expect(p.calendar!.rows.map((r) =>
      r.kind === "allDay" || r.kind === "unclear" ? [r.kind, r.title]
        : r.kind === "event" && r.event !== null ? [r.kind, r.event.title, r.event.tentative, r.event.ended]
          : [r.kind],
    )).toEqual([
      ["allDay", "Offsite"],
      ["unclear", "Vendor"],
      ["event", "Standup (Room 4)", false, false],
      ["event", "Review", true, true],
      ["event", "Retro", false, true],
    ]);
    expect(p.calendar!.events.map((e) => [e.startMs, e.endMs])).toEqual([
      [at(TODAY, 9, 0), at(TODAY, 9, 30)], [at(TODAY, 10, 0), at(TODAY, 10, 30)], [at(TODAY, 11, 0), at(TODAY, 11, 30)],
    ]);
  });

  /** One timed event rendered by the ENGINE's own `renderCalendarSection` on `date`, and parsed back. */
  const roundTrip = (date: string, startMs: number, endMs: number) => {
    const lines = renderCalendarSection(cal([{ time: { kind: "timed", startMs, endMs }, title: "T", status: "confirmed", transparency: "busy", attendeeCount: 1 }]), date);
    const line = lines[1]!.slice("   ◦ ".length);
    const row = parseCalendarLine(line, date);
    return { line, event: row.kind === "event" ? row.event : null };
  };

  zonedTest("`<Mon D>` across a year end, both ways: a start or end resolves to the right year (the engine's own lines)", () => {
    // A start before the page in the old year; a start and an end after it in the new one.
    const sinceDec = roundTrip("2027-01-01", at("2026-12-30", 10, 0), at("2027-01-01", 20, 0));
    expect(sinceDec.line).toBe("since Dec 30 → 20:00  T");   // PREMISE
    expect(sinceDec.event).toMatchObject({ startMs: at("2026-12-30", 0, 0), endMs: at("2027-01-01", 20, 0) });
    const toJan = roundTrip("2026-12-31", at("2026-12-31", 20, 0), at("2027-01-02", 20, 0));
    expect(toJan.line).toBe("20:00 → Jan 2 20:00  T");
    expect(toJan.event).toMatchObject({ startMs: at("2026-12-31", 20, 0), endMs: at("2027-01-02", 20, 0) });
    const startJan = roundTrip("2026-12-31", at("2027-01-02", 9, 0), at("2027-01-02", 10, 0));
    expect(startJan.line).toBe("Jan 2 09:00 → Jan 2 10:00  T");
    expect(startJan.event).toMatchObject({ startMs: at("2027-01-02", 9, 0), endMs: at("2027-01-02", 10, 0) });
    // An END before the page, in the old year (an event that ended before today, as the engine renders it):
    // the first such day on or after the START, never next December.
    const endDec = roundTrip("2027-01-01", at("2026-12-28", 10, 0), at("2026-12-31", 10, 0));
    expect(endDec.line).toBe("since Dec 28 → Dec 31 10:00  T");
    expect(endDec.event).toMatchObject({ startMs: at("2026-12-28", 0, 0), endMs: at("2026-12-31", 10, 0) });
    // …and on an ordinary page: an end after the start in the same year stays in it.
    const endLater = roundTrip("2026-10-16", at("2026-10-12", 10, 0), at("2026-10-14", 10, 0));
    expect(endLater.line).toBe("since Oct 12 → Oct 14 10:00  T");
    expect(endLater.event).toMatchObject({ endMs: at("2026-10-14", 10, 0) });
  });

  test("the autumn clock change (America/Los_Angeles): an end marked \"clocks go back\" is the LATER of its wall time's two instants", () => {
    inZone("America/Los_Angeles", () => {
      const day = "2026-11-01";   // 02:00 PDT → 01:00 PST: 01:00–01:59 happens twice
      const straddle = roundTrip(day, Date.parse("2026-11-01T08:45:00Z"), Date.parse("2026-11-01T09:15:00Z"));
      expect(straddle.line).toBe("01:45–01:15 (clocks go back)  T");   // PREMISE: the engine's line
      expect(straddle.event).toMatchObject({ startMs: Date.parse("2026-11-01T08:45:00Z"), endMs: Date.parse("2026-11-01T09:15:00Z") });
      expect(straddle.event!.endMs).toBeGreaterThan(straddle.event!.startMs);
      const twoHours = roundTrip(day, Date.parse("2026-11-01T07:30:00Z"), Date.parse("2026-11-01T09:30:00Z"));
      expect(twoHours.line).toBe("00:30–01:30 (clocks go back)  T");
      expect(twoHours.event).toMatchObject({ startMs: Date.parse("2026-11-01T07:30:00Z"), endMs: Date.parse("2026-11-01T09:30:00Z") });
      // The meeting is still on at 01:20 PST, the second 01:20.
      expect(meetingTile(day, [twoHours.event!], Date.parse("2026-11-01T09:20:00Z"))).toMatchObject({ state: "now" });
      // An end in the repeated hour reached by the arrow form, from the day before.
      const overnight = roundTrip("2026-10-31", Date.parse("2026-11-01T05:00:00Z"), Date.parse("2026-11-01T09:15:00Z"));
      expect(overnight.line).toBe("22:00 → 01:15 tomorrow (clocks go back)  T");
      expect(overnight.event).toMatchObject({ endMs: Date.parse("2026-11-01T09:15:00Z") });
      // An end that is not in the repeated hour is unchanged by the mark.
      const later = roundTrip(day, Date.parse("2026-11-01T08:45:00Z"), Date.parse("2026-11-01T11:00:00Z"));
      expect(later.line).toBe("01:45–03:00 (clocks go back)  T");
      expect(later.event).toMatchObject({ endMs: Date.parse("2026-11-01T11:00:00Z") });
    });
  });

  zonedTest("the engine's own lines round-trip: a grid of events rendered by `renderCalendarSection` parses back to its instants, clock changes and year ends included", () => {
    const sameWall = (a: number, b: number): boolean => {
      const x = new Date(a), y = new Date(b);
      return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate() && x.getHours() === y.getHours() && x.getMinutes() === y.getMinutes();
    };
    /** The instant is the SECOND reading of a wall time the clocks repeated (a fall-back hour). */
    const secondReading = (ms: number): boolean => {
      const shift = Math.abs(new Date(ms + 3 * 3_600_000).getTimezoneOffset() - new Date(ms - 3 * 3_600_000).getTimezoneOffset()) * MIN;
      return shift > 0 && sameWall(ms, ms - shift);
    };
    const midnightOf = (ms: number): number => {
      const d = new Date(ms);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    };
    // Both zones' clock changes in 2026 (LA: Mar 8, Nov 1; Auckland: Apr 5, Sep 27), an ordinary day, a year end.
    const DATES = ["2026-03-08", "2026-04-05", "2026-09-27", "2026-11-01", "2026-10-16", "2026-12-31", "2027-01-01"];
    const DURATIONS = [0, 15, 45, 60, 90, 150, 24 * 60 + 30, 3 * 24 * 60].map((m) => m * MIN);
    let parsed = 0;
    let ambiguous = 0;
    for (const date of DATES) {
      const midnight = at(date, 0, 0);
      for (let off = -50 * 60; off <= 50 * 60; off += 35) {
        const s = midnight + off * MIN;
        for (const dur of DURATIONS) {
          const e = s + dur;
          const { line, event } = roundTrip(date, s, e);
          expect({ line, parsed: event !== null }).toEqual({ line, parsed: true });
          const since = line.startsWith("since ");
          // The line cannot say WHICH reading of a repeated wall time it means when no mark tells: a start
          // in the second reading, or an end in it with no "clocks go back" (the whole span after the change).
          if ((!since && secondReading(s)) || (dur > 0 && secondReading(e) && !line.includes("(clocks go back)"))) {
            ambiguous++;
            continue;
          }
          const wantStart = since ? midnightOf(s) : s;
          expect({ line, got: [event!.startMs, event!.endMs] }).toEqual({ line, got: [wantStart, dur === 0 ? wantStart : e] });
          parsed++;
        }
      }
    }
    expect(parsed).toBeGreaterThan(9000);
    expect(ambiguous).toBeLessThan(100);
  });

  zonedTest("the meeting tile: nothing at T-31, from T-30, orange at T-5 or less, \"now\" at T-0 and during, gone after", () => {
    const p = calPage([timed(TODAY, [9, 0], [9, 30], "Standup")]);
    const events = p.calendar!.events;
    const start = at(TODAY, 9, 0);
    const tile = (now: number) => meetingTile(TODAY, events, now);
    expect(tile(start - 31 * MIN)).toBeNull();
    expect(tile(start - 30 * MIN)).toMatchObject({ state: "soon", minutes: 30 });
    expect(tile(start - 6 * MIN)).toMatchObject({ state: "soon", minutes: 6 });
    expect(tile(start - 5 * MIN)).toMatchObject({ state: "imminent", minutes: 5 });
    // Part minutes round UP: 5 min 1 s is still 6 minutes away (not yet orange), 4 min 59 s is 5.
    const SEC = 1000;
    expect(tile(start - 5 * MIN - SEC)).toMatchObject({ state: "soon", minutes: 6 });
    expect(tile(start - 4 * MIN - 59 * SEC)).toMatchObject({ state: "imminent", minutes: 5 });
    expect(tile(start - 30 * MIN - SEC)).toBeNull();
    expect(tile(start)).toMatchObject({ state: "now", minutes: 0 });
    expect(tile(start + 29 * MIN)).toMatchObject({ state: "now" });
    expect(tile(start + 30 * MIN)).toBeNull();
    expect(tile(start)!.event.title).toBe("Standup");
  });

  zonedTest("a running span (`since …`) is \"now\" until its end; an `· ended` event is never a tile", () => {
    const p = calPage([
      timed(TODAY, [22, 0, -1], [10, 0], "On-call"),
      timed(TODAY, [9, 0], [9, 30], "Ended early", { ended: true }),
    ]);
    const events = p.calendar!.events;
    expect(events[0]!.title).toBe("On-call");
    expect(meetingTile(TODAY, events, at(TODAY, 8, 0))).toMatchObject({ state: "now" });
    expect(meetingTile(TODAY, events, at(TODAY, 9, 10))!.event.title).toBe("On-call");
    expect(meetingTile(TODAY, events, at(TODAY, 10, 1))).toBeNull();
    // On its own, inside its own span and in its 30 minutes before, the ended event is no tile.
    const ended = events.filter((e) => e.ended);
    expect(ended.map((e) => e.title)).toEqual(["Ended early"]);
    expect(meetingTile(TODAY, ended, at(TODAY, 9, 10))).toBeNull();
    expect(meetingTile(TODAY, ended, at(TODAY, 8, 45))).toBeNull();
  });

  zonedTest("across midnight: a meeting ending at 24:00 is \"now\" at 23:45, and after midnight the page is yesterday's — no tile", () => {
    const p = calPage([timed(TODAY, [23, 30], [0, 0, 1], "Late call"), timed(TODAY, [23, 0], [1, 0, 1], "Release night")]);
    const events = p.calendar!.events;
    expect(meetingTile(TODAY, events, at(TODAY, 23, 45))).toMatchObject({ state: "now" });
    expect(meetingTile(TODAY, events, at(TODAY, 0, 10, 1))).toBeNull();   // Release night still runs, but the page is not today's
    expect(nextMeeting(TODAY, events, at(TODAY, 0, 10, 1))).toBeNull();
  });

  zonedTest("only events whose span covers some of today become tiles", () => {
    const p = calPage([timed(TODAY, [0, 10, 1], [1, 0, 1], "Tomorrow, just after midnight")]);
    const events = p.calendar!.events;
    expect(events.length).toBe(1);   // PREMISE: the line parsed (`<Mon D> HH:MM → …`)
    expect(meetingTile(TODAY, events, at(TODAY, 23, 50))).toBeNull();
    expect(nextMeeting(TODAY, events, at(TODAY, 23, 50))).toBeNull();
  });

  zonedTest("the tiles' words: a local HH:MM, and the meeting tile says its state in words (colour is never the only signal)", () => {
    expect(clockTime(at(TODAY, 9, 5))).toBe("09:05");
    expect(clockTime(at(TODAY, 23, 59))).toBe("23:59");
    const p = calPage([timed(TODAY, [9, 0], [9, 30], "Standup")]);
    const events = p.calendar!.events;
    const start = at(TODAY, 9, 0);
    expect(meetingTileText(meetingTile(TODAY, events, start - 30 * MIN)!)).toBe("In 30 minutes");
    expect(meetingTileText(meetingTile(TODAY, events, start - 1 * MIN)!)).toBe("In 1 minute");
    expect(meetingTileText(meetingTile(TODAY, events, start)!)).toBe("Now");
  });

  zonedTest("the next-meeting glance tile: the running meeting, else the soonest one still to come today", () => {
    const p = calPage([timed(TODAY, [9, 0], [9, 30], "Standup"), timed(TODAY, [14, 0], [15, 0], "Review"), timed(TODAY, [8, 0], [8, 30], "Gym", { ended: true })]);
    const events = p.calendar!.events;
    expect(nextMeeting(TODAY, events, at(TODAY, 7, 0))!.title).toBe("Standup");
    expect(nextMeeting(TODAY, events, at(TODAY, 9, 15))!.title).toBe("Standup");
    expect(nextMeeting(TODAY, events, at(TODAY, 10, 0))!.title).toBe("Review");
    expect(nextMeeting(TODAY, events, at(TODAY, 16, 0))).toBeNull();
    // Round-2 M1: the glance tile keeps that event, and heads a RUNNING one "Now" (the launchpad's word), never
    // "Next meeting" with a start already past.
    const glance = (h: number, m: number) => {
      const g = glanceMeeting(TODAY, events, at(TODAY, h, m));
      return g === null ? null : [g.heading, g.event.title];
    };
    expect(glance(7, 0)).toEqual(["Next meeting", "Standup"]);
    expect(glance(9, 0)).toEqual(["Now", "Standup"]);   // at its start: running
    expect(glance(9, 15)).toEqual(["Now", "Standup"]);
    expect(glance(9, 30)).toEqual(["Next meeting", "Review"]);   // its end: over
    expect(glance(10, 0)).toEqual(["Next meeting", "Review"]);
    expect(glance(16, 0)).toBeNull();
  });

  test("the mood line: \"A meeting is coming up.\" before a meeting (soon and imminent), \"A meeting is in progress.\" during it, \"Nothing needs you right now.\" without a tile", () => {
    const events: CalendarEvent[] = calPage([timed(TODAY, [9, 0], [9, 30], "Standup")]).calendar!.events;
    expect(moodLine(meetingTile(TODAY, events, at(TODAY, 8, 45)))).toBe("A meeting is coming up.");
    expect(moodLine(meetingTile(TODAY, events, at(TODAY, 8, 57)))).toBe("A meeting is coming up.");   // imminent
    expect(moodLine(meetingTile(TODAY, events, at(TODAY, 12, 0)))).toBe("Nothing needs you right now.");
    // The user's wording, 2026-10-21 (a deviation from the A spec, which names only two texts): while the
    // meeting runs, "A meeting is in progress." — it having started does not mean the user joined it.
    const running = meetingTile(TODAY, events, at(TODAY, 9, 10));
    expect(running).toMatchObject({ state: "now" });
    expect(moodLine(running)).toBe("A meeting is in progress.");
  });

  test("today's page holds the section as the page has it; a stale page shows only \"Calendar shows on today's briefing\" and no tile", () => {
    const events = [timed("2026-10-14", [9, 0], [9, 30], "Standup")];
    const today = calPage(events, "2026-10-14");
    expect(today.calendar!.stale).toBe(false);
    expect(today.calendar!.rows.map((r) => r.text)).toEqual(["09:00–09:30  Standup"]);
    expect(today.calendar!.staleText).toBeNull();
    const stale = mapped(page({ date: "2026-10-14", calendar: cal(events) } as Partial<EngineStruct>), "2026-10-15");
    expect(stale.calendar).toEqual({ stale: true, rows: [], events: [], staleText: CALENDAR_STALE_TEXT });
    expect(CALENDAR_STALE_TEXT).toBe("Calendar shows on today's briefing");
    expect(meetingTile("2026-10-14", today.calendar!.events, at("2026-10-15", 9, 0))).toBeNull();
  });

  test("a page with no calendar section has no calendar slide", () => {
    expect(mapped(page()).calendar).toBeNull();
  });

  test("status lines are shown as the page has them and never parsed as events: not connected, unavailable, a failed source", () => {
    const none = mapped(page({ calendar: { events: [], sources: [], incomplete: false } } as Partial<EngineStruct>));
    expect(none.calendar!.rows).toEqual([{ kind: "status", text: "No calendar is connected" }]);
    expect(none.calendar!.events).toEqual([]);
    const failed = mapped(
      page({
        calendar: {
          events: [],
          sources: [
            { id: "macos", kind: "macos", status: "not-granted" },
            { id: "work", kind: "link", status: "timeout" },
          ],
          incomplete: true,
        },
      } as Partial<EngineStruct>),
    );
    expect(failed.calendar!.rows.map((r) => [r.kind, r.text])).toEqual([
      ["status", "Calendar unavailable today"],
      ["status", "Mac Calendar: calendar access has not been granted yet — allow it in Settings → Calendar"],
      ["status", "work: did not answer in time"],
    ]);
    expect(failed.calendar!.events).toEqual([]);
  });
});

/* ── A-M4-T10: the reducer, the slide list and the reserved inputs ────────────────────────────── */

describe("the reducer, the slide list and the reserved inputs", () => {
  const nav = (index: number, count = 6, open: string[] = []) => ({ index, count, open });

  test("navigation stays inside the slide list: next at the last and previous at the first change nothing; a jump out of range is ignored", () => {
    expect(deckReducer(nav(0), { type: "next" })).toEqual(nav(1));
    expect(deckReducer(nav(5), { type: "next" })).toEqual(nav(5));
    expect(deckReducer(nav(3), { type: "previous" })).toEqual(nav(2));
    expect(deckReducer(nav(0), { type: "previous" })).toEqual(nav(0));
    expect(deckReducer(nav(0), { type: "jump", index: 4 })).toEqual(nav(4));
    expect(deckReducer(nav(2), { type: "jump", index: 6 })).toEqual(nav(2));
    expect(deckReducer(nav(2), { type: "jump", index: -1 })).toEqual(nav(2));
    expect(deckReducer(nav(2), { type: "jump", index: 1.5 })).toEqual(nav(2));
    // One slide (loading, a read error, the first run): nowhere to go.
    expect(deckReducer(nav(0, 1), { type: "next" })).toEqual(nav(0, 1));
  });

  test("Open all opens every card; Close all closes them", () => {
    const opened = deckReducer(nav(1), { type: "openAll", keys: ["app", "lib", ""] });
    expect(opened).toEqual(nav(1, 6, ["app", "lib", ""]));
    expect(deckReducer(opened, { type: "closeAll" })).toEqual(nav(1));
  });

  test("one card's disclosure toggles alone: open adds its key once, close removes only it (A-M5's card button)", () => {
    const one = deckReducer(nav(1, 6, ["lib"]), { type: "toggle", key: "app" });
    expect(one).toEqual(nav(1, 6, ["lib", "app"]));
    expect(deckReducer(one, { type: "toggle", key: "app" })).toEqual(nav(1, 6, ["lib"]));
    // The "Other" card's key is "": a key like any other.
    expect(deckReducer(nav(1), { type: "toggle", key: "" })).toEqual(nav(1, 6, [""]));
    expect(deckReducer(nav(1, 6, [""]), { type: "toggle", key: "" })).toEqual(nav(1));
  });

  test("a changed briefing returns to Good morning, cards closed, with the new slide count", () => {
    expect(deckReducer(nav(4, 6, ["app"]), { type: "briefingChanged", count: 5 })).toEqual(nav(0, 5));
  });

  test("A-M5: Today reopens loading (no key), then the page: the kept slide comes back for the SAME briefing, never for another", () => {
    const h = briefingHash("briefing one");
    const h2 = briefingHash("briefing two");
    keepDeckState(h, "leftOff", 3, true);
    // Today mounts while the page loads: Good morning, and the kept state is not touched.
    expect(deckStateOnKey(null)).toEqual({ slide: null, index: 0, classic: false });
    // The page arrives and it is the same briefing: where the user left it, by its slide id and its index.
    expect(deckStateOnKey(h)).toEqual({ slide: "leftOff", index: 3, classic: true });
    // It changes while the deck is open (a run finished, a same-day rewrite): Good morning, on the slides…
    expect(deckStateOnKey(h2)).toEqual({ slide: null, index: 0, classic: false });
    // …and that is what is kept now: reopening on the first briefing starts it fresh too (PB-M1: a different key
    // resets, and the kept slide id is never looked up).
    keepDeckState(h2, "whatYouDid", 2, false);
    expect(deckStateOnKey(h)).toEqual({ slide: null, index: 0, classic: false });
    // The same key again (a re-render) keeps the state.
    keepDeckState(h, "whatYouDid", 1, false);
    expect(deckStateOnKey(h)).toEqual({ slide: "whatYouDid", index: 1, classic: false });
    // A read error or a first run after a page: Good morning, and the page's kept state survives it.
    expect(deckStateOnKey(null)).toEqual({ slide: null, index: 0, classic: false });
    expect(deckStateOnKey(h)).toEqual({ slide: "whatYouDid", index: 1, classic: false });
  });

  test("deck state is kept per briefing: the same text keeps its slide and view; a changed text returns to Good morning and the slides", () => {
    const a = renderBriefing({ date: TODAY, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [] });
    const b = `${a}\n`;
    expect(briefingHash(a)).toBe(briefingHash(a));
    expect(briefingHash(a)).not.toBe(briefingHash(b));
    keepDeckState(briefingHash(a), "leftOff", 3, true);
    expect(deckStateFor(briefingHash(a))).toEqual({ slide: "leftOff", index: 3, classic: true });
    expect(deckStateFor(briefingHash(b))).toEqual({ slide: null, index: 0, classic: false });
    // …and a return to the first text, after the change, starts it fresh too.
    expect(deckStateFor(briefingHash(a))).toEqual({ slide: null, index: 0, classic: false });
    // A same-day rewrite of the SAME length (one word changed) is a different briefing too.
    const c = a.replace("generated via claude", "generated via clause");
    expect(c.length).toBe(a.length);   // PREMISE
    expect(c).not.toBe(a);
    expect(briefingHash(c)).not.toBe(briefingHash(a));
    keepDeckState(briefingHash(a), "whatYouDid", 2, false);
    expect(deckStateFor(briefingHash(c))).toEqual({ slide: null, index: 0, classic: false });
  });

  test("PB-M1: placeOnList finds the kept slide id at its new index, else the kept index clamped (zero for an empty or classic list)", () => {
    const five: SlideId[] = ["goodMorning", "whatYouDid", "leftOff", "suggested", "launchpad"];
    const six: SlideId[] = ["goodMorning", "whatYouDid", "leftOff", "suggested", "calendar", "launchpad"];
    // The launchpad was kept at index 4 of five; the calendar slide arrived before it: index 5 of six.
    expect(placeOnList({ slide: "launchpad", index: 4 }, six)).toBe(5);
    // …and the other way: kept at 5 of six, the calendar slide gone: 4 of five.
    expect(placeOnList({ slide: "launchpad", index: 5 }, five)).toBe(4);
    // The kept id is absent: the kept index, clamped into the list.
    expect(placeOnList({ slide: "calendar", index: 4 }, five)).toBe(4);
    expect(placeOnList({ slide: "calendar", index: 9 }, five)).toBe(4);
    expect(placeOnList({ slide: "calendar", index: 2 }, ["goodMorning"])).toBe(0);
    // No kept id (a fresh briefing): the index, clamped.
    expect(placeOnList({ slide: null, index: 0 }, six)).toBe(0);
    expect(placeOnList({ slide: null, index: 7 }, six)).toBe(5);
    // An empty list (the classic view): zero, never -1.
    expect(placeOnList({ slide: "launchpad", index: 4 }, [])).toBe(0);
    expect(placeOnList({ slide: null, index: 0 }, [])).toBe(0);
  });

  test("PB-M1: remapOnList keeps the current slide by its id when the list changes (remap), lands on its neighbour when it is removed, and says same for an unchanged position", () => {
    const five: SlideId[] = ["goodMorning", "whatYouDid", "leftOff", "suggested", "launchpad"];
    const six: SlideId[] = ["goodMorning", "whatYouDid", "leftOff", "suggested", "calendar", "launchpad"];
    // The calendar slide added before the launchpad, while on the launchpad: the launchpad, at its new index.
    expect(remapOnList(five, 4, six)).toEqual({ index: 5, kind: "remap" });
    // …removed while on the launchpad: the launchpad again.
    expect(remapOnList(six, 5, five)).toEqual({ index: 4, kind: "remap" });
    // The calendar slide removed while it is current: its neighbour at the same position (the launchpad).
    expect(remapOnList(six, 4, five)).toEqual({ index: 4, kind: "removed" });
    // A removed last slide clamps to the new last.
    expect(remapOnList(["goodMorning", "calendar"], 1, ["goodMorning"])).toEqual({ index: 0, kind: "removed" });
    // An unchanged position: Good morning, or a slide before the change.
    expect(remapOnList(five, 0, six)).toEqual({ index: 0, kind: "same" });
    expect(remapOnList(five, 3, six)).toEqual({ index: 3, kind: "same" });
    expect(remapOnList(six, 2, five)).toEqual({ index: 2, kind: "same" });
    // An empty list on both sides (the classic view stays classic): nothing moves.
    expect(remapOnList([], 0, [])).toEqual({ index: 0, kind: "same" });
    // To an empty list: zero, never -1.
    expect(remapOnList(five, 4, [])).toEqual({ index: 0, kind: "removed" });
  });

  test("PB-M1-T3: listChange — a remap (the calendar slide added before the launchpad, after an earlier user move) keeps the slide, sets quiet, keeps the glide, lands focus only if lost, and skips the scroll reset", () => {
    const five: SlideId[] = ["goodMorning", "whatYouDid", "leftOff", "suggested", "launchpad"];
    const six: SlideId[] = ["goodMorning", "whatYouDid", "leftOff", "suggested", "calendar", "launchpad"];
    // The user moved earlier (glide on), and is on the launchpad.
    const r = listChange({ prev: five, index: 4, next: six, quiet: null, glide: true });
    expect(r).toEqual({ index: 5, kind: "remap", quiet: 5, glide: true });
    // L6: the same slide at a new index is not scrolled to its top.
    expect(scrollResets({ index: 4, id: "launchpad" }, { index: r.index, id: six[r.index] })).toBe(false);
    // Focus: afterChange(from, wasInside, false) — focus still on the launchpad (connected): no landing.
    expect(focusLanding({ deckDrawn: true, from: 4, to: r.index, lost: false, onIndexChange: false })).toBeNull();
  });

  test("PB-M1-T3: listChange — the current slide removed lands on its neighbour with no quiet and no glide; L6 resets it; focus lands only if lost — at the same index and at a clamped index", () => {
    const five: SlideId[] = ["goodMorning", "whatYouDid", "leftOff", "suggested", "launchpad"];
    const six: SlideId[] = ["goodMorning", "whatYouDid", "leftOff", "suggested", "calendar", "launchpad"];
    // The same index: the calendar slide (4 of six) goes; the launchpad takes its place.
    const same = listChange({ prev: six, index: 4, next: five, quiet: 3, glide: true });
    expect(same).toEqual({ index: 4, kind: "removed", quiet: null, glide: false });
    // L6 resets the neighbour even though its index matches the old one (and the prior quiet index is no reason to skip).
    expect(scrollResets({ index: 4, id: "calendar" }, { index: same.index, id: five[same.index] })).toBe(true);
    // A clamped index: the last slide goes.
    const clamped = listChange({ prev: ["goodMorning", "calendar"], index: 1, next: ["goodMorning"], quiet: 1, glide: true });
    expect(clamped).toEqual({ index: 0, kind: "removed", quiet: null, glide: false });
    expect(scrollResets({ index: 1, id: "calendar" }, { index: 0, id: "goodMorning" })).toBe(true);
    // Focus lost inside the removed slide: the new slide's heading; focus outside it or still connected: left alone.
    expect(focusLanding({ deckDrawn: true, from: 4, to: 4, lost: true, onIndexChange: false })).toBe("slideHeading");
    expect(focusLanding({ deckDrawn: true, from: 4, to: 4, lost: false, onIndexChange: false })).toBeNull();
    expect(focusLanding({ deckDrawn: true, from: 1, to: 0, lost: false, onIndexChange: false })).toBeNull();
  });

  test("moreBelow (user decision 2026-11-05, option A): true only while content sits below the slide's fold, never for its empty bottom padding alone", () => {
    // A slide 640 tall, its bottom padding 10.4 (Good morning: the slide's 4 + the card's 6.4).
    const slide = (scrollHeight: number, scrollTop = 0) => ({ scrollTop, clientHeight: 640, scrollHeight, emptyFoot: 10.4 });
    // It fits: nothing is hidden.
    expect(moreBelow(slide(640))).toBe(false);
    // The two measured cases: 9 px (4 projects, 2 tiles, a one-line sentence) and 4 px (5 projects, no sentence) of padding.
    expect(moreBelow(slide(649))).toBe(false);
    expect(moreBelow(slide(644))).toBe(false);
    // The boundary: exactly the padding is hidden, then the first pixel past it.
    expect(moreBelow({ scrollTop: 0, clientHeight: 640, scrollHeight: 650, emptyFoot: 10 })).toBe(false);
    expect(moreBelow({ scrollTop: 0, clientHeight: 640, scrollHeight: 651, emptyFoot: 10 })).toBe(true);
    // Real content below: the pill shows, until the scroll reaches it.
    expect(moreBelow(slide(700))).toBe(true);
    expect(moreBelow(slide(700, 49))).toBe(true);
    expect(moreBelow(slide(700, 50))).toBe(false);
    expect(moreBelow(slide(700, 60))).toBe(false);
    // A list slide has only the slide's own 4: 5 px hidden is 1 px past the padding, and the pill shows. (That pixel can
    // be a card's padding or a margin, which are not counted: the pill can show with only empty space below, as it always has.)
    expect(moreBelow({ scrollTop: 0, clientHeight: 640, scrollHeight: 645, emptyFoot: 4 })).toBe(true);
    expect(moreBelow({ scrollTop: 0, clientHeight: 640, scrollHeight: 644, emptyFoot: 4 })).toBe(false);
  });

  test("PB-M1-T3: listChange — same changes no focus, quiet or glide", () => {
    const five: SlideId[] = ["goodMorning", "whatYouDid", "leftOff", "suggested", "launchpad"];
    const six: SlideId[] = ["goodMorning", "whatYouDid", "leftOff", "suggested", "calendar", "launchpad"];
    expect(listChange({ prev: five, index: 2, next: six, quiet: 7, glide: true })).toEqual({ index: 2, kind: "same", quiet: 7, glide: true });
    expect(listChange({ prev: six, index: 0, next: five, quiet: null, glide: false })).toEqual({ index: 0, kind: "same", quiet: null, glide: false });
    expect(scrollResets({ index: 2, id: "leftOff" }, { index: 2, id: "leftOff" })).toBe(false);
  });

  test("PB-M1-T3 (R2-03): on Good morning, an insertion and a removal each keep index 0; with the count and list updated, next and jump reach the new last slide and stop there", () => {
    const five: SlideId[] = ["goodMorning", "whatYouDid", "leftOff", "suggested", "launchpad"];
    const six: SlideId[] = ["goodMorning", "whatYouDid", "leftOff", "suggested", "calendar", "launchpad"];
    for (const [prev, next] of [[five, six], [six, five]] as const) {
      const r = listChange({ prev, index: 0, next, quiet: null, glide: false });
      expect({ n: next.length, kind: r.kind, index: r.index }).toEqual({ n: next.length, kind: "same", index: 0 });
      // DeckOrClassic: nav.count = countOf(deck) on every list change, including same.
      let n = { index: r.index, count: next.length, open: [] as string[] };
      for (let k = 0; k < next.length + 2; k++) n = deckReducer(n, { type: "next" });
      expect({ n: next.length, index: n.index, id: next[n.index] }).toEqual({ n: next.length, index: next.length - 1, id: "launchpad" });
      expect(deckReducer({ index: 0, count: next.length, open: [] }, { type: "jump", index: next.length - 1 }).index).toBe(next.length - 1);
      // Out of bounds: nothing.
      expect(deckReducer({ index: 0, count: next.length, open: [] }, { type: "jump", index: next.length }).index).toBe(0);
    }
  });

  test("PB-M1-T3: scrollResets — a user move (a new slide at a new index) resets; with no id the index decides", () => {
    expect(scrollResets({ index: 1, id: "whatYouDid" }, { index: 2, id: "leftOff" })).toBe(true);
    expect(scrollResets({ index: 1, id: undefined }, { index: 2, id: undefined })).toBe(true);
    expect(scrollResets({ index: 1, id: undefined }, { index: 1, id: undefined })).toBe(false);
  });

  test("PB-M4-T1: DeckInput.calendarOn — absent reads false; true adds the slide on today's page with no section (a live calendar day), never on a stale one; a stale page with a section keeps its slide", () => {
    const file = (text: string): LatestLoad => ({ state: "loaded", file: { path: "/state/briefing-latest.md", text, bytes: text.length } });
    const slidesOf = (text: string, calendarOn?: boolean) => {
      const model = todayModel({ snapshot: null, latest: file(text), lastRun: null, today: TODAY });
      const v = calendarOn === undefined ? deckView({ model, today: TODAY, firstName: null }) : deckView({ model, today: TODAY, firstName: null, calendarOn });
      return v.kind === "slides" ? v.slides : v.kind;
    };
    const SIX = ["goodMorning", "whatYouDid", "leftOff", "suggested", "calendar", "launchpad"];
    const FIVE = ["goodMorning", "whatYouDid", "leftOff", "suggested", "launchpad"];
    expect(slidesOf(page())).toEqual(FIVE);
    expect(slidesOf(page(), false)).toEqual(FIVE);
    expect(slidesOf(page(), true)).toEqual(SIX);
    expect(slidesOf(page({ date: "2026-10-14" }), true)).toEqual(FIVE);
    const cal = { calendar: { events: [], sources: [], incomplete: false } } as Partial<EngineStruct>;
    expect(slidesOf(page({ ...cal, date: "2026-10-14" }), false)).toEqual(SIX);
    expect(slidesOf(page(cal), false)).toEqual(SIX);
    // The live view follows: the no-section view on a live calendar day, given the driver's detail.
    const model = todayModel({ snapshot: null, latest: file(page()), lastRun: null, today: TODAY });
    const live = deckView({ model, today: TODAY, firstName: null, calendarOn: true, calendarDetail: { list: null, pending: false, off: false, failed: false, macConfigured: null } });
    expect(live.kind === "slides" && live.live?.readState).toBe("waiting");
    const off = deckView({ model, today: TODAY, firstName: null, calendarOn: false, calendarDetail: { list: null, pending: false, off: false, failed: false, macConfigured: null } });
    expect(off.kind === "slides" && off.live).toBeNull();
  });

  test("the slide list: six slides with a calendar section, five without; one while loading, on a read error and before the first briefing; the classic view when the page cannot be mapped", () => {
    const view = (latest: LatestLoad) => {
      const model = todayModel({ snapshot: null, latest, lastRun: null, today: TODAY });
      return deckView({ model, today: TODAY, firstName: null });
    };
    const file = (text: string): LatestLoad => ({ state: "loaded", file: { path: "/state/briefing-latest.md", text, bytes: text.length } });
    const withCal = view(file(page({ calendar: { events: [], sources: [], incomplete: false } } as Partial<EngineStruct>)));
    expect(withCal.kind === "slides" && withCal.slides).toEqual(["goodMorning", "whatYouDid", "leftOff", "suggested", "calendar", "launchpad"]);
    const without = view(file(page()));
    expect(without.kind === "slides" && without.slides).toEqual(["goodMorning", "whatYouDid", "leftOff", "suggested", "launchpad"]);
    for (const [latest, reason] of [
      [{ state: "loading" }, "loading"],
      [{ state: "error", message: "/p is a symbolic link" }, "error"],
      [{ state: "none" }, "empty"],
    ] as [LatestLoad, string][]) {
      const v = view(latest);
      expect({ reason, v: v.kind === "single" ? [v.slides, v.reason] : v.kind }).toEqual({ reason, v: [["goodMorning"], reason] });
    }
    const classic = view(file(fixture("cannot-map-no-title.md")));
    expect(classic).toEqual({ kind: "classic", reason: "no-title", line: "" });
    // An older page that maps is the slides, relative to its own date, never the classic view.
    const stale = view(file(page({ date: "2026-10-14" })));
    expect(stale.kind === "slides" && [stale.slides.length, stale.page.stale, stale.goodMorning.greeting]).toEqual([
      5,
      true,
      "Your last briefing, from Wednesday 14 October",
    ]);
    // Good morning is there in every deck state, with the read error's banner verbatim.
    const err = view({ state: "error", message: "/p is a symbolic link" });
    expect(err.kind === "single" && err.goodMorning.banners.map((b) => b.text)).toEqual(["/p is a symbolic link"]);
  });

  test("the four reserved inputs exist and are optional: named in the input type, and an exported value without them type-checks", () => {
    const src = readFileSync(new URL("../src/lib/deck.ts", import.meta.url), "utf8");
    const at = src.indexOf("export interface DeckInput {");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}", at));
    for (const name of ["gitDetail", "calendarDetail", "actions", "summary"]) {
      expect({ name, optional: new RegExp(`\\n  ${name}\\?: `).test(body) }).toEqual({ name, optional: true });
    }
    // The type-level check is this value, compiled by `bun run check` and `bun run typecheck` (tests-web is
    // not type-checked): it sets none of the four, so a name made required fails the build.
    expect(src).toMatch(/export const DECK_INPUT_WITHOUT_RESERVED = \{[\s\S]*?\} satisfies DeckInput;/);
    const value = src.slice(src.indexOf("export const DECK_INPUT_WITHOUT_RESERVED"));
    const literal = value.slice(0, value.indexOf("satisfies DeckInput"));
    for (const name of ["gitDetail", "calendarDetail", "actions", "summary"]) expect(literal).not.toContain(name);
  });

  test("round-1 L4: the deck's input has no clock — the page is mapped from the model, today's date and the name only, so the minute tick never re-maps it", () => {
    const src = readFileSync(new URL("../src/lib/deck.ts", import.meta.url), "utf8");
    const at = src.indexOf("export interface DeckInput {");
    const body = src.slice(at, src.indexOf("\n}", at));
    expect([...body.matchAll(/^  (\w+)\??:/gm)].map((m) => m[1])).toEqual(["model", "today", "firstName", "gitDetail", "calendarDetail", "calendarOn", "actions", "summary"]);
    const fn = src.slice(src.indexOf("export function deckView(input: DeckInput): DeckView {"), src.indexOf("/** Where the deck is:"));
    expect(fn).not.toMatch(/\bnow\b/);
  });
});

/* ── A-M6-T13: the archive probe (`tests-web/probes/deck-probe.ts`) ───────────────────────────── */

describe("the archive probe: read-only, counts and structure only, never a line's text", () => {
  /** A scratch archive in the OS temp folder (never the real state directory), removed after. */
  function withArchive(pages: Record<string, string | null>, body: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "deck-probe-"));
    try {
      // null: a FOLDER under a page's name (an unreadable page).
      for (const [name, text] of Object.entries(pages)) text === null ? mkdirSync(join(dir, name)) : writeFileSync(join(dir, name), text);
      body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("it says plainly when it skipped: no argument, no such folder, no pages (the path itself is never printed)", () => {
    expect(probeArchive(undefined)).toEqual({ kind: "skipped", why: "no archive folder was given (pass status --json's paths.briefingsDir)" });
    const missing = join(tmpdir(), "deck-probe-no-such-folder-zz9");
    expect(probeArchive(missing)).toEqual({ kind: "skipped", why: "there is no folder at the path given" });
    withArchive({}, (dir) => expect(probeArchive(dir)).toEqual({ kind: "skipped", why: "the folder holds no briefing pages (YYYY-MM-DD.md)" }));
    withArchive({ "notes.txt": "x", "2026-10-1.md": "x", "audit-2026-10-14.md": "x" }, (dir) =>
      expect(probeArchive(dir)).toEqual({ kind: "skipped", why: "the folder holds no briefing pages (YYYY-MM-DD.md)" }),
    );
    for (const r of [probeArchive(undefined), probeArchive(missing)]) {
      expect(formatReport(r)).toStartWith("deck-probe: skipped — ");
      expect(formatReport(r)).not.toContain(missing);
    }
  });

  test("each failure is named by date, section, block index, kind and prefix class; each card count difference by date, section and card index", () => {
    const good = page({ date: "2026-10-14", recap: [{ repo: "zqlabel", text: "shipped the importer", evidence: "a1b2c3d" }] });
    const marked = page({ date: "2026-10-16", suggestions: [{ repo: "zqlabel", text: "check the gate", verdictPath: true }] });
    const markerLine = marked.split("\n").find((l) => l.startsWith(VERDICT_MARKER_PREFIX))!;
    const twoMarkers = marked.replace(`${markerLine}\n`, `${markerLine}\n${markerLine}\n`);
    // An all-letter 6-character SHA: the engine's 4-40 hex shape reads it, the deck's display rule does not.
    const letters = page({ date: "2026-10-17", recap: [{ repo: "zqlabel", text: "renamed the module", evidence: "abcdef" }] });
    const coverage = page({
      date: "2026-10-18",
      recap: [{ repo: "zqlabel", text: "shipped the importer", evidence: "a1b2c3d" }],
      recapCoverage: { shown: 1, total: 3, notShown: [{ label: "zqlabel", sha: "d4e5f6a", subject: "tidy" }] },
    });
    expect(coverage).toContain("— 1 of 3 commits");   // PREMISE: the coverage form
    const clustered = page({
      date: "2026-10-21",
      recap: [
        { repo: "zqlabel", text: "reworked the header", evidence: "0a1b2c3", group: "web/app.ts — 2 commits (Oct 20)" },
        { repo: "zqlabel", text: "fixed the footer", evidence: "1b2c3d4", group: "web/app.ts — 2 commits (Oct 20)" },
      ],
      recapCoverage: { shown: 3, total: 5, notShown: [{ label: "zqlabel", sha: "d4e5f6a", subject: "tidy" }] },
    });
    expect(clustered).toContain("   • [zqlabel] web/app.ts — 2 commits (Oct 20)");   // PREMISE: a header line, no evidence
    expect(clustered).toContain("— 3 of 5 commits");
    const offByOne = coverage.replace("— 1 of 3 commits", "— 1 of 4 commits");
    const heading = fixture("cannot-map-heading-missing.md").replace(/\d{4}-\d{2}-\d{2}/, "2026-10-15");
    withArchive(
      {
        "2026-10-14.md": good,
        "2026-10-15.md": heading,
        "2026-10-16.md": twoMarkers,
        "2026-10-17.md": letters,
        "2026-10-18.md": offByOne,
        // The same coverage page as the engine wrote it: its cards (2) plus "(+1 more)" ARE its Y (3), so no report.
        "2026-10-19.md": coverage.replace("2026-10-18", "2026-10-19"),
        // A shown commit whose bullet carries no evidence (the deck's "Details ›" card): the header's Y counts
        // it and the deck cannot, so the difference is reported WITH its explanation (one evidence-less line).
        "2026-10-20.md": page({
          date: "2026-10-20",
          recap: [
            { repo: "zqlabel", text: "shipped the importer", evidence: "a1b2c3d" },
            { repo: "zqlabel", text: "renamed the module" },
          ],
          recapCoverage: { shown: 2, total: 4, notShown: [{ label: "zqlabel", sha: "d4e5f6a", subject: "tidy" }] },
        }),
        // A cluster's HEADER line carries no evidence and is not a commit: it never explains a gap.
        "2026-10-21.md": clustered,
        // A header whose Y is BELOW the cards plus the remainder: a gap of -1, never explained.
        "2026-10-22.md": coverage.replace("2026-10-18", "2026-10-22").replace("— 1 of 3 commits", "— 1 of 2 commits"),
        // An unreadable page (a folder with a page's name): counted, by date only, and the run goes on.
        "2026-10-23.md": null,
      },
      (dir) => {
        const r = probeArchive(dir);
        if (r.kind !== "ran") throw new Error("expected a run");
        expect([r.pages, r.mapped, r.unreadable]).toEqual([10, 7, ["2026-10-23"]]);
        const blocksOf = (t: string) => renderMarkdown(t);
        const headingFail = mapPage(blocksOf(heading), "2026-10-15");
        const markerFail = mapPage(blocksOf(twoMarkers), "2026-10-16");
        if (headingFail.ok || markerFail.ok) throw new Error("PREMISE: both refuse");
        expect(r.failures).toEqual([
          {
            date: "2026-10-15",
            section: "outside",
            block: headingFail.index,
            kind: blocksOf(heading)[headingFail.index]!.kind,
            prefix: prefixClass(headingFail.line),
            reason: "content-without-heading",
          },
          { date: "2026-10-16", section: "suggested", block: markerFail.index, kind: "text", prefix: prefixClass(markerFail.line), reason: "unattached-line" },
        ]);
        expect(r.byReason).toEqual({ "content-without-heading": 1, "unattached-line": 1 });
        expect(r.countDiffs).toEqual([{ date: "2026-10-17", section: "whatYouDid", card: 0, deck: 0, hexShape: 1 }]);
        // gap = stated − shown − more; explained only when 0 < gap ≤ the evidence-less commit lines.
        expect(r.totalDiffs).toEqual([
          { date: "2026-10-18", section: "whatYouDid", shown: 2, more: 1, stated: 4, gap: 1, noEvidence: 0, unexplained: true },
          { date: "2026-10-20", section: "whatYouDid", shown: 2, more: 1, stated: 4, gap: 1, noEvidence: 1, unexplained: false },
          { date: "2026-10-21", section: "whatYouDid", shown: 3, more: 1, stated: 5, gap: 1, noEvidence: 0, unexplained: true },
          { date: "2026-10-22", section: "whatYouDid", shown: 2, more: 1, stated: 2, gap: -1, noEvidence: 0, unexplained: true },
        ]);
        const out0 = formatReport(r);
        expect(out0).toContain("gap=1  lines-without-evidence=1  explained");
        expect(out0).toContain("gap=-1  lines-without-evidence=0  UNEXPLAINED");
        expect(out0).toContain("unreadable pages: 1\n  2026-10-23");
        // The printed report carries none of the pages' text: no label, sentence, SHA or marker words.
        const out = formatReport(r);
        for (const word of ["zqlabel", "shipped", "importer", "renamed", "abcdef", "a1b2c3d", "abc1234", "human gate", "check the gate", "tidy"]) {
          expect({ word, inReport: out.includes(word) }).toEqual({ word, inReport: false });
        }
        expect(out).toContain("2026-10-16  section=suggested  block=");
      },
    );
  });

  test("the prefix class is the line's leading SHAPE only: spaces and the first character's class, never its words", () => {
    expect(prefixClass("[app] shipped the thing")).toBe("0sp [label]");
    expect(prefixClass("     ⚑ human gate: cites a commit")).toBe("5sp ⚑");
    expect(prefixClass("   a line in no shape the engine writes")).toBe("3sp letter");
    expect(prefixClass("— you wrote: \"x\"")).toBe("0sp —");
    expect(prefixClass("42 things")).toBe("0sp digit");
    expect(prefixClass("")).toBe("0sp empty");
    expect(prefixClass("[unclosed")).toBe("0sp [");
  });

  test("it only READS the archive: every page is byte-identical and keeps its modification time", () => {
    const text = page({ date: "2026-10-14", recap: [{ repo: "zqlabel", text: "x", evidence: "a1b2c3d" }] });
    withArchive({ "2026-10-14.md": text, "2026-10-15.md": fixture("cannot-map-no-title.md") }, (dir) => {
      const before = ["2026-10-14.md", "2026-10-15.md"].map((f) => [readFileSync(join(dir, f), "utf8"), statSync(join(dir, f)).mtimeMs]);
      probeArchive(dir);
      const after = ["2026-10-14.md", "2026-10-15.md"].map((f) => [readFileSync(join(dir, f), "utf8"), statSync(join(dir, f)).mtimeMs]);
      expect(after).toEqual(before);
    });
  });

  test("where it lives and what it may call: outside the test glob and gui/scripts, not a *.test.ts, no write API, no require or computed import", () => {
    const at = new URL("./probes/deck-probe.ts", import.meta.url);
    const src = readFileSync(at, "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[ \t])\/\/[^\n]*/gm, "$1");
    // `bun run test` globs ./tests-web/*.check.ts, one level; this is tests-web/probes/deck-probe.ts.
    expect(at.pathname).toEndWith("/gui/tests-web/probes/deck-probe.ts");
    expect(code).not.toMatch(/\b(writeFile|appendFile|mkdir|rmSync|rm\(|unlink|rename|copyFile|truncate|chmod|open\()\w*/);
    expect(code).not.toMatch(/\brequire\b|createRequire|import\(|Worker\b/);
    expect(code).toContain('from "node:fs"');
    expect(code).toMatch(/import \{ readdirSync, readFileSync, statSync \} from "node:fs";/);
  });
});

/* ── final review round 1 (PR A): the model's fixes ───────────────────────────────────────────── */

describe("final review round 1: the deck's model", () => {
  const at = (date: string, hh: number, mm: number, plusDays = 0): number => {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    return new Date(y, m - 1, d + plusDays, hh, mm).getTime();
  };
  const ev = (startMs: number, endMs: number, title: string): CalendarStructEvent => ({ time: { kind: "timed", startMs, endMs }, title, status: "confirmed", transparency: "busy", attendeeCount: 1 });
  const cal = (events: CalendarStructEvent[]): CalendarStruct => ({ events, sources: [{ id: "macos", kind: "macos", status: "ok" }], incomplete: false });
  /** One event rendered by the ENGINE's `renderCalendarSection` on TODAY, and parsed back. */
  const engineEvent = (startMs: number, endMs: number) => {
    const line = renderCalendarSection(cal([ev(startMs, endMs, "T")]), TODAY)[1]!.slice("   ◦ ".length);
    const row = parseCalendarLine(line, TODAY);
    return { line, event: row.kind === "event" ? row.event : null };
  };

  zonedTest("M3: a start before today keeps its instant for the maths and the page's OWN words for the tiles — never a drawn \"00:00\"", () => {
    const y = engineEvent(at(TODAY, 22, 0, -1), at(TODAY, 10, 0));
    expect(y.line).toBe("since yesterday → 10:00  T");   // PREMISE: the engine's words, in this zone
    expect(y.event).toMatchObject({ startMs: at(TODAY, 0, 0, -1), since: "since yesterday" });
    expect(startLabel(y.event!)).toBe("since yesterday");
    // It is running at 08:00 today, so it IS the next-meeting and the meeting tile (the instant kept).
    expect(nextMeeting(TODAY, [y.event!], at(TODAY, 8, 0))?.title).toBe("T");
    expect(meetingTile(TODAY, [y.event!], at(TODAY, 8, 0))).toMatchObject({ state: "now" });
    const older = engineEvent(at(TODAY, 9, 0, -3), at(TODAY, 10, 0));
    expect(older.line).toBe("since Oct 13 → 10:00  T");
    expect(startLabel(older.event!)).toBe("since Oct 13");
    // A start after today (`Oct 17 09:00`): its words too; and today's start is its HH:MM, with no words.
    const later = engineEvent(at(TODAY, 9, 0, 1), at(TODAY, 10, 0, 1));
    expect(later.event?.since).toBe("Oct 17 09:00");
    const today = engineEvent(at(TODAY, 9, 5), at(TODAY, 9, 30));
    expect(today.event?.since).toBeNull();
    expect(startLabel(today.event!)).toBe("09:05");
    const bare = engineEvent(at(TODAY, 9, 5), at(TODAY, 9, 5));
    expect([bare.line, bare.event?.since, startLabel(bare.event!)]).toEqual(["09:05  T", null, "09:05"]);
    for (const e of [y, older, later]) expect(startLabel(e.event!)).not.toMatch(/^\d\d:\d\d$/);
  });

  test("M7: a `[Mono]` branch line and a `[mono]` resume bullet are ONE Where-you-left-off card, with the project's colour", () => {
    const text = page({
      recap: [{ repo: "Mono", text: "shipped", evidence: "a1b2c3d" }],
      branchState: [{ repo: "Mono", text: "On branch main (no upstream)" }],
      resume: [{ repo: "mono", text: "finish the header" }],
    });
    expect(text).toContain("[Mono] On branch main (no upstream)");   // PREMISE: both spellings on the page
    expect(text).toContain("[mono] finish the header");
    const p = mapped(text);
    expect(p.leftOff.cards.length).toBe(1);
    const c = p.leftOff.cards[0]!;
    expect(c.key).toBe("mono");
    expect(c.branch).toEqual({ kind: "branch", name: "main", ahead: null, behind: null });
    expect(c.items).toEqual(["finish the header"]);
    expect(typeof c.slot).toBe("number");
    expect(c.slot).toBe(p.slots["mono"]!);
    expect(c.slot).toBe(p.whatYouDid.cards.find((w) => w.key === "mono")!.slot);
  });

  test("L2: projects with no counted commit never read \"0 commits\" (the engine's \"one commit, a why with no recap home\" page); a quiet day still says its zeros", () => {
    const one = RENDER_CORPUS.find((c) => c.name === "one commit, a why with no recap home, legend at the cap")!;
    const text = renderBriefing(one.struct);
    const p = mapped(text, one.struct.date);
    expect([p.whatYouDid.projects, p.whatYouDid.commits]).toEqual([1, 0]);   // PREMISE: one project, no SHA
    expect(p.whatYouDid.subtitle).toBe("1 project · 0 PRs merged");
    const model = todayModel({ snapshot: null, latest: { state: "loaded", file: { path: "/p", text, bytes: text.length } }, lastRun: null, today: one.struct.date });
    expect(goodMorning({ model, page: p, firstName: null, today: one.struct.date }).workLine).toBe("Your recent work: 1 project · 0 PRs merged");
    expect(mapped(page()).whatYouDid.subtitle).toBe("0 projects · 0 commits · 0 PRs merged");
    expect(mapped(page({ recap: [{ repo: "app", text: "x", evidence: "a1b2c3d" }] })).whatYouDid.subtitle).toBe("1 project · 1 commit · 0 PRs merged");
  });

  test("L6: a title date that is not a real day is no title (the classic view), and a real one — 29 February in a leap year — maps", () => {
    for (const bad of ["2026-13-05", "2026-00-10", "2026-10-00", "2026-10-32", "2026-02-29", "2026-04-31"]) {
      const text = page().replace("briefing — 2026-10-16", `briefing — ${bad}`);
      expect({ bad, r: refused(text) }).toEqual({ bad, r: { reason: "no-title", line: "" } });
      expect(isCalendarDate(bad)).toBe(false);
    }
    for (const good of ["2028-02-29", "2000-02-29", "2026-12-31", "2026-01-01"]) expect({ good, ok: isCalendarDate(good) }).toEqual({ good, ok: true });
    expect(isCalendarDate("1900-02-29")).toBe(false);
    expect(mapped(page({ date: "2028-02-29" }), "2028-02-29").pageDate).toBe("2028-02-29");
    const model = todayModel({ snapshot: null, latest: { state: "loaded", file: { path: "/p", text: page().replace("2026-10-16", "2026-13-05"), bytes: 1 } }, lastRun: null, today: TODAY });
    expect(deckView({ model, today: TODAY, firstName: null })).toEqual({ kind: "classic", reason: "no-title", line: "" });
  });

  test("L8: the labels `constructor` and `__proto__` are ordinary projects: each its own colour slot (a number), on every slide, never an inherited property", () => {
    // The engine writes a why line for these two from an inherited property of its own `whys` lookup (an ENGINE
    // finding, reported; `src/` is frozen here): they are dropped, so this page is only about the deck's slots.
    const text = page({
      recap: [
        { repo: "constructor", text: "x", evidence: "a1b2c3d" },
        { repo: "__proto__", text: "y", evidence: "b1b2c3d" },
      ],
      suggestions: [{ repo: "constructor", text: "s" }, { repo: "__proto__", text: "t" }],
    })
      .split("\n")
      .filter((l) => !l.startsWith("   — you wrote: "))
      .join("\n");
    const p = mapped(text);
    const slotOf = (key: string) => p.whatYouDid.cards.find((c) => c.key === key)!.slot;
    for (const key of ["constructor", "__proto__"]) {
      expect({ key, slot: typeof slotOf(key) }).toEqual({ key, slot: "number" });
      expect({ key, own: Object.hasOwn(p.slots, key), slot: p.slots[key] }).toEqual({ key, own: true, slot: slotOf(key) });
    }
    expect(slotOf("constructor")).not.toBe(slotOf("__proto__"));
    expect(p.suggested.cards.map((c) => c.slot)).toEqual([slotOf("constructor"), slotOf("__proto__")]);
    // No prototype at all on the page's map: an unknown label reads as absent, not as Object's methods.
    expect(Object.getPrototypeOf(p.slots)).toBeNull();
    expect(p.slots["toString"]).toBeUndefined();
  });
});

/* ── final review round 3 (PR A): where focus lands after a change ─────────────────────────────── */

describe("final review round 3: focusLanding (M3, L1, L2, M2)", () => {
  const land = (deckDrawn: boolean, from: number, to: number, lost: boolean, onIndexChange: boolean) => focusLanding({ deckDrawn, from, to, lost, onIndexChange });

  test("M3: a changed briefing leaves focus on a control still on screen — Good morning stays current and Details keeps focus", () => {
    expect(land(true, 0, 0, false, true)).toBeNull();
    // …the slide index changed: the new current slide's heading, as a move does.
    expect(land(true, 2, 0, false, true)).toBe("slideHeading");
    // …focus left nowhere (on the body, or in a slide that turned inert): the heading.
    expect(land(true, 0, 0, true, true)).toBe("slideHeading");
  });

  test("L1: from the classic view back to the deck, focus left nowhere lands on the current slide's heading", () => {
    expect(land(true, 0, 0, true, true)).toBe("slideHeading");
    expect(land(true, 4, 0, true, true)).toBe("slideHeading");
  });

  test("round-2 L2: into the classic view, only focus left nowhere lands (on its heading or note); focus still on a control there stays", () => {
    expect(land(false, 2, 0, true, true)).toBe("classicView");
    expect(land(false, 0, 0, false, true)).toBeNull();
  });

  test("M2 (a run): only focus left nowhere lands — the index changing alone (focus on a dot, outside the slides) does not move it", () => {
    expect(land(true, 3, 0, false, false)).toBeNull();
    expect(land(true, 3, 0, true, false)).toBe("slideHeading");
  });
});

/* ── final review round 4 (PR A): the run rule, the one spelling, the one stale source ────────────── */

describe("final review round 4: the run rule (M1), one spelling per project (L7), one stale source (L9)", () => {
  test("M1 / post-cap L1: runRule is a STEP over its memory — ONE jump per run (when it starts with a page, or when the page arrives); the memory is returned", () => {
    // A run (number 7) with a page, not yet jumped: jump, and the memory now says run 7 had its jump.
    expect(runRule({ running: true, hasPage: true, run: 7, jumpedFor: 6 })).toEqual({ jump: true, jumpedFor: 7 });
    // The same run again: nothing (every move after it is the user's — no hold), the memory unchanged.
    expect(runRule({ running: true, hasPage: true, run: 7, jumpedFor: 7 })).toEqual({ jump: false, jumpedFor: 7 });
    // Mounted mid-run with the page still loading: wait, nothing remembered; the page arrives: jump.
    expect(runRule({ running: true, hasPage: false, run: 8, jumpedFor: 7 })).toEqual({ jump: false, jumpedFor: 7 });
    expect(runRule({ running: true, hasPage: true, run: 8, jumpedFor: 7 })).toEqual({ jump: true, jumpedFor: 8 });
    // No run going: nothing, the memory kept (the next run is a new number, so it jumps).
    expect(runRule({ running: false, hasPage: true, run: 8, jumpedFor: 8 })).toEqual({ jump: false, jumpedFor: 8 });
  });

  test("post-cap L2: the memory is per run and outlives Today — a return mid-run does NOT jump again; the next run does", () => {
    noteRunStart();
    expect(runJumpNow(true, true)).toBe(true);   // the run starts on Today: the jump
    expect(runJumpNow(true, true)).toBe(false);   // still the same run
    // History and back mid-run: Today remounts (its page loading, then arriving): no second jump.
    expect(runJumpNow(true, false)).toBe(false);
    expect(runJumpNow(true, true)).toBe(false);
    expect(runJumpNow(false, true)).toBe(false);   // the run ends
    noteRunStart();   // the next run, started from the tray while Today is not shown
    expect(runJumpNow(true, false)).toBe(false);   // Today mounting mid-run, loading
    expect(runJumpNow(true, true)).toBe(true);   // its page arrives: the one jump
    expect(runJumpNow(true, true)).toBe(false);
  });

  test("L7: one project written three ways across the page is ONE spelling — the first the page writes — on every slide", () => {
    const text = page({
      recap: [{ repo: "Mono", text: "shipped", evidence: "a1b2c3d" }],
      resume: [{ repo: "mono", text: "finish the header" }],
      suggestions: [{ repo: "MONO", text: "review it" }],
    });
    const first = /\[(mono|Mono|MONO)\]/.exec(text)![1]!;   // PREMISE: whichever the engine writes first
    expect(new Set([...text.matchAll(/\[(mono|Mono|MONO)\]/g)].map((m) => m[1])).size).toBe(3);   // PREMISE: three spellings
    const p = mapped(text);
    expect(p.whatYouDid.cards.find((c) => c.key === "mono")!.label).toBe(first);
    expect(p.leftOff.cards.find((c) => c.key === "mono")!.label).toBe(first);
    expect(p.suggested.cards[0]!.label).toBe(first);
    const model = todayModel({ snapshot: null, latest: { state: "loaded", file: { path: "/p", text, bytes: text.length } }, lastRun: null, today: TODAY });
    expect(goodMorning({ model, page: p, firstName: null, today: TODAY }).bars.map((b) => b.label)).toEqual([first]);
  });

  test("L9: Good morning's stale state is the page's own (`page.stale`), the one source for the greeting and the date line", () => {
    const model = (text: string) => todayModel({ snapshot: null, latest: { state: "loaded", file: { path: "/p", text, bytes: text.length } }, lastRun: null, today: TODAY });
    const old = page({ date: "2026-10-14" });
    expect(goodMorning({ model: model(old), page: mapped(old), firstName: null, today: TODAY }).stale).toBe(true);
    const now = page();
    expect(goodMorning({ model: model(now), page: mapped(now), firstName: null, today: TODAY }).stale).toBe(false);
    expect(goodMorning({ model: model(now), page: null, firstName: null, today: TODAY }).stale).toBe(false);
    const gm = readFileSync(new URL("../src/lib/deck/GoodMorning.svelte", import.meta.url), "utf8");
    expect(gm).toContain('{#if !gm.stale}<p class="date">{gm.date}</p>{/if}');
    expect(gm).not.toContain("staleDate");
  });
});

/* ── post-cap (PR A): the "focus left nowhere" predicate, pure ─────────────────────────────────── */

describe("post-cap L6: focusIsLost — what DeckOrClassic counts as focus left nowhere", () => {
  const el = (o: { connected?: boolean; disabled?: boolean; inert?: boolean } = {}) => ({
    isConnected: o.connected ?? true,
    matches: (sel: string) => sel === ":disabled" && o.disabled === true,
    closest: (sel: string) => (sel === "[inert]" && o.inert === true ? {} : null),
  });
  // Scoped-review L1: the body is a connected, enabled, not-inert element, so only the `active === body` check can call
  // it lost.
  const body = el();
  test("lost: none, the body, out of the document, a DISABLED control (round-4 L2), inside an inert slide", () => {
    expect(focusIsLost(null, body)).toBe(true);
    expect(focusIsLost(body, body)).toBe(true);
    expect(focusIsLost(el({ connected: false }), body)).toBe(true);
    expect(focusIsLost(el({ disabled: true }), body)).toBe(true);
    expect(focusIsLost(el({ inert: true }), body)).toBe(true);
  });
  test("not lost: a connected, enabled control outside any inert slide", () => {
    expect(focusIsLost(el(), body)).toBe(false);
  });
});

/* ── PB-M6-T3: the land request (after Close or "Not now", spec §4 "Focus") ─────────────────────────── */

describe("PB-M6-T3: the land request is a pure step over a counter (deck-state.ts)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ds = deckState as typeof deckState & Record<string, any>;

  test("the target: the slide heading on the deck; the classic view's target with the switch off, the cannot-map view or Full briefing", () => {
    expect(ds.landTarget({ slides: true, kind: "slides", classic: false })).toBe("slideHeading");
    expect(ds.landTarget({ slides: true, kind: "slides", classic: true })).toBe("classicView");   // Full briefing
    expect(ds.landTarget({ slides: true, kind: "classic", classic: false })).toBe("classicView"); // cannot map
    expect(ds.landTarget({ slides: false, kind: "slides", classic: false })).toBe("classicView"); // slides off
    expect(ds.landTarget({ slides: false, kind: "classic", classic: true })).toBe("classicView");
    expect(ds.landTarget({ slides: true, kind: "single", classic: false })).toBe("slideHeading");   // the one-slide deck
  });

  test("a repeated request number does nothing; each NEW number gives null → target, even when the landing already holds the target", () => {
    for (const target of ["slideHeading", "classicView"] as const) {
      expect(ds.landRequestStep(0, 0, target)).toEqual({ seen: 0, edges: [] });
      const first = ds.landRequestStep(0, 1, target);
      expect(first).toEqual({ seen: 1, edges: [null, target] });
      // Re-run with the same counter (a re-render): nothing.
      expect(ds.landRequestStep(first.seen, 1, target)).toEqual({ seen: 1, edges: [] });
      // Two successive new counters from an already-matching landing: each gives both edges again.
      const second = ds.landRequestStep(first.seen, 2, target);
      expect(second).toEqual({ seen: 2, edges: [null, target] });
      expect(ds.landRequestStep(second.seen, 3, target)).toEqual({ seen: 3, edges: [null, target] });
    }
  });

  test("focusHeading over fake nodes: TodayView's heading (landHere false at mount) focuses only when landHere TURNS true — a null → target edge each time", async () => {
    const focused: string[] = [];
    const node = { isConnected: true, focus: () => focused.push("h2") } as unknown as HTMLElement;
    const flush = () => new Promise<void>((r) => queueMicrotask(r));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const action = (focusHeading as any)(node, false) as { update(v: boolean | undefined): void; destroy(): void };
    await flush();
    expect(focused).toEqual([]);            // mounted with landHere false: no focus (every existing render)
    action.update(true);
    await flush();
    expect(focused).toEqual(["h2"]);        // classicView landed: focus
    action.update(true);
    await flush();
    expect(focused).toEqual(["h2"]);        // the same value again: nothing — hence the null edge first
    action.update(false);
    action.update(true);
    await flush();
    expect(focused).toEqual(["h2", "h2"]);  // null → classicView again (a second request): focus again
    action.destroy();
  });
});
