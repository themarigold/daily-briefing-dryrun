/**
 * The briefing redesign's A-M5 — the deck on screen: `lib/deck/DeckOrClassic.svelte`, the deck and its six
 * slides, rendered on the SERVER by the real compiler (`svelte-loader.ts`), as `today.check.ts` renders
 * `TodayView`. A server render runs no effects and no events, so what a click or a key does is pinned in
 * the reducer (`deck.check.ts`) and here by source and compiled-shape pins; the rest is the manual
 * screenshot pass.
 *
 * ⚠ THE PAGES ARE THE ENGINE'S. Each is rendered by the engine's own `renderBriefing` (read-only import),
 * except the three committed cannot-map fixtures (`__fixtures__/deck/`, A-M3).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { render } from "svelte/server";

import { calEventLine, renderBriefing } from "../../src/render";
import type { BriefingStruct as EngineStruct } from "../../src/types";

import { CALENDAR_STATUS_TEXT, type CalendarStructEvent } from "../src/lib/calendar-contract";
import {
  CHANGED_LINE,
  DENIED_LINE,
  LOADING_LINE,
  NO_DETAIL,
  OFF_LINE,
  OFFLINE_LINE,
  peopleLine,
  READER_OUTDATED_LINE,
  SEVERAL_LINKS_LINE,
  TIMEOUT_LINE,
  type CalendarDetail,
  type CalendarDetailView,
  type CardKey,
} from "../src/lib/calendar-detail";
import { READ_FAILED_LINE, type NotesBox, type NotesBoxList } from "../src/lib/calendar-detail";
import { CALENDAR_NOT_CONNECTED_TEXT, CALENDAR_UNAVAILABLE_TEXT } from "../src/lib/calendar-contract";
import { remapOnList } from "../src/lib/deck-state";
import type { CalendarDetailsEvent, CalendarDetailsSource } from "../src/lib/engine";
import AskFirst from "../src/lib/deck/AskFirst.svelte";
import MeetingCard from "../src/lib/deck/MeetingCard.svelte";
import MeetingDetails from "../src/lib/deck/MeetingDetails.svelte";
import { briefingHash, keepDeckState } from "../src/lib/deck-state";
import { deckReducer, deckView, type DeckAction } from "../src/lib/deck";
import { RENDER_CORPUS } from "../../test/fixtures/render-corpus";
import type { Phase, ScheduleState, Snapshot } from "../src/lib/state";
import { todayModel, type LatestLoad, type TodayModel } from "../src/lib/today";
import DeckOrClassic from "../src/lib/deck/DeckOrClassic.svelte";
import TodayView from "../src/routes/TodayView.svelte";
import { gitDetailView, type ActionCard, type GitDetailInput, type ReplyRow, type ReposAllReply } from "../src/lib/git-detail";
import type { ActionsInput } from "../src/lib/actions";
import EditorChooser from "../src/lib/deck/EditorChooser.svelte";
import WhatYouDid from "../src/lib/deck/WhatYouDid.svelte";
import { all, at, B1_NOW, B1_PAGE, b1States, cited, held, input as gitInput, label as gitLabel, repo as gitRepo, richReply, sha } from "./probes/b1-states";

const TODAY = "2026-10-16";
/** 08:30 local on TODAY: the deck's clock in these renders. */
const NOW = new Date(2026, 9, 16, 8, 30).getTime();
const HOSTILE = '<img src=x onerror="alert(1)">';
const NOTE = "This briefing could not be shown as slides.";

const page = (s: Partial<EngineStruct> = {}): string =>
  renderBriefing({ date: TODAY, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [], ...s });
const fixture = (name: string): string => readFileSync(new URL(`./__fixtures__/deck/${name}`, import.meta.url), "utf8");
const loaded = (text: string): LatestLoad => ({ state: "loaded", file: { path: "/state/briefing-latest.md", text, bytes: text.length } });

function state(phase: Phase, statusLine: string): ScheduleState {
  return {
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
  };
}
const snapshot = (extra: Partial<Snapshot> = {}): Snapshot => ({
  status: { latestBriefingMtime: "2026-10-16T07:24:00.000Z", archivedDates: [] },
  lastSkip: null,
  schedule: null,
  scheduleStale: false,
  scheduleState: state({ phase: "delivered", at: "2026-10-16T07:24:00.000Z" }, "Delivered 07:24"),
  error: null,
  updatesStopped: false,
  ...extra,
});

/** `today.check.ts`'s `view()` normalisation (`:104-111`): comments removed, whitespace collapsed. */
const normalise = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
/** Round-3 L1: the slides-on views sit in one `display: contents` wrapper (focus "inside" covers them); a check that
 *  compares a classic view with TodayView's own output takes the wrapper off first, and asserts it was there. */
const unwrapViews = (html: string): string => {
  const m = /^\s*<div class="views[^"]*">([\s\S]*)<\/div>\s*$/.exec(html);
  expect(m).not.toBeNull();
  return m![1]!;
};

interface Opts {
  latest: LatestLoad;
  snap?: Snapshot | null;
  firstName?: string | null;
  slides?: boolean;
  today?: string;
  now?: number;
  run?: { running?: boolean; progress?: string[]; runResult?: string; detailsOpen?: boolean };
  key?: string | null;
}
const RUN = { running: false, progress: [] as string[], runResult: "", detailsOpen: false, onrun: () => {} };

function modelOf(o: Opts): TodayModel {
  return todayModel({ snapshot: o.snap === undefined ? snapshot() : o.snap, latest: o.latest, lastRun: null, today: o.today ?? TODAY });
}
const keyOf = (o: Opts): string | null => (o.key !== undefined ? o.key : o.latest.state === "loaded" ? briefingHash(o.latest.file.text) : null);

function deckHtml(o: Opts): string {
  const model = modelOf(o);
  const now = o.now ?? NOW;
  const deck = deckView({ model, today: o.today ?? TODAY, firstName: o.firstName ?? null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(DeckOrClassic as any, {
    props: { model, deck, now, briefingKey: keyOf(o), slides: o.slides ?? true, ...RUN, ...o.run, onhistory: () => {} },
  }).body;
}
function classicHtml(o: Opts): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(TodayView as any, { props: { model: modelOf(o), ...RUN, ...o.run } }).body;
}

/** The text of every `<h2>` in the output, in order (the slides' headings). */
const headings = (html: string): string[] => [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => m[1]!.replace(/<!--[\s\S]*?-->/g, "").trim());
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
const RUN_NOW = "Generates today's briefing now, if it has not been generated yet.";

const RICH = page({
  recap: [
    { repo: "app", text: "shipped the deck", evidence: "a1b2c3d, b2c3d4e" },
    { repo: "lib", text: "fixed the parser", evidence: "c3d4e5f" },
  ],
  windowMerges: [{ repo: "app", text: "🔀 Merged #12 (feat/deck) (Oct 15)  (d4e5f6a)" }],
  branchState: [
    { repo: "app", text: "On branch feat/deck (ahead 2, behind 1)" },
    { repo: "lib", text: "On branch main (ahead 0, behind 0)" },
  ],
  resume: [{ repo: "app", text: "finish the deck" }],
  suggestions: [{ repo: "lib", text: "review the parser fix" }, { text: "write the note" }],
  notices: ['ℹ︎ Skipped "work": out of usage'],
});

/* ── the switch, cannot map, and the Good-morning states ──────────────────────────────────────── */

describe("DeckOrClassic: the switch, the cannot-map note, and the one-slide states", () => {
  const STATES: [string, Opts][] = [
    ["loaded", { latest: loaded(RICH) }],
    ["quiet", { latest: loaded(page()) }],
    ["stale", { latest: loaded(page({ date: "2026-10-14" })) }],
    ["loading", { latest: { state: "loading" } }],
    ["first run", { latest: { state: "none" } }],
    ["read error", { latest: { state: "error", message: "/p is a symbolic link" } }],
    ["cannot map", { latest: loaded(fixture("cannot-map-no-title.md")) }],
  ];

  test("the switch off: the output IS TodayView's for the same model, in every state (after today.check's normalisation)", () => {
    for (const [name, o] of STATES) {
      const off = normalise(deckHtml({ ...o, slides: false }));
      expect({ name, same: off === normalise(classicHtml(o)) }).toEqual({ name, same: true });
      expect(off).not.toContain(NOTE);
    }
  });

  test("one render per cannot-map rule: the note once, and with its element removed the rest IS TodayView's", () => {
    const cases: [string, string][] = [
      ["no title", fixture("cannot-map-no-title.md")],
      ["a known section's content with its heading missing", fixture("cannot-map-heading-missing.md")],
      ["a text block inside a mapped section", fixture("cannot-map-text-in-section.md")],
    ];
    for (const [rule, text] of cases) {
      const html = normalise(deckHtml({ latest: loaded(text) }));
      expect({ rule, notes: count(html, NOTE) }).toEqual({ rule, notes: 1 });
      const without = unwrapViews(html).replace(/<p class="note[^"]*" tabindex="-1">This briefing could not be shown as slides\.<\/p>/, "");
      expect({ rule, same: without.trim() === normalise(classicHtml({ latest: loaded(text) })).trim() }).toEqual({ rule, same: true });
    }
  });

  test("loading, a read error and the first run never show the note: they are Good morning, alone, with RunControls", () => {
    for (const [name, o] of STATES.filter(([n]) => ["loading", "first run", "read error"].includes(n))) {
      const html = deckHtml(o);
      expect({ name, note: html.includes(NOTE) }).toEqual({ name, note: false });
      expect({ name, h: headings(html) }).toEqual({ name, h: ["Good morning"] });
      expect({ name, run: html.includes(RUN_NOW) && html.includes(">Run now</button>") }).toEqual({ name, run: true });
      expect({ name, nav: html.includes('aria-label="Next slide"') }).toEqual({ name, nav: false });   // one slide: no arrows
      expect({ name, start: html.includes("Start ›") }).toEqual({ name, start: false });
    }
  });

  test("RunControls is on Good morning in EVERY state: loading, read error, first run, loaded, stale (with its result line and Details)", () => {
    const run = { progress: ["engine: started"], runResult: "Delivered.", detailsOpen: true };
    for (const [name, o] of STATES.filter(([n]) => n !== "cannot map")) {
      const html = deckHtml({ ...o, run });
      const gm = html.slice(0, html.indexOf("</div>", html.indexOf(RUN_NOW)) + 1);
      expect({ name, run: gm.includes(RUN_NOW), result: html.includes("Delivered."), details: html.includes("<details") }).toEqual({
        name,
        run: true,
        result: true,
        details: true,
      });
    }
  });

  test("the loading and first-run texts are TodayView's, word for word (TodayView.svelte:46, :48-55)", () => {
    const view = readFileSync(new URL("../src/routes/TodayView.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    const loadingText = "Loading the latest briefing…";
    const empty = /<h3>No briefing yet<\/h3> <p> ([^<]+) <\/p>/.exec(view);
    expect(view).toContain(`<p class="muted">${loadingText}</p>`);   // PREMISE: TodayView's own markup
    expect(empty).not.toBeNull();
    expect(normalise(deckHtml({ latest: { state: "loading" } }))).toContain(`${loadingText}</p>`);
    const first = normalise(deckHtml({ latest: { state: "none" } }));
    expect(first).toContain("No briefing yet</h3>");
    expect(first).toContain(empty![1]!.trim());
  });

  test("a read error's banner is on Good morning verbatim, and a hostile one stays text", () => {
    const html = deckHtml({ latest: { state: "error", message: HOSTILE } });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x");
  });
});

/* ── the slides ───────────────────────────────────────────────────────────────────────────────── */

describe("the slides in each fixture state", () => {
  test("a loaded page: six slides with a calendar section, five without — every slide mounted at once, the others inert", () => {
    const withCal = deckHtml({ latest: loaded(page({ calendar: { events: [], sources: [], incomplete: false } } as Partial<EngineStruct>)) });
    expect(headings(withCal)).toEqual(["Good morning", "What you did", "Where you left off", "Suggested for today", "Today's calendar", "You're all set"]);
    const without = deckHtml({ latest: loaded(RICH) });
    expect(headings(without)).toEqual(["Good morning", "What you did", "Where you left off", "Suggested for today", "You're all set"]);
    // Good morning is the current slide; the other four are inert (out of the tab order), not unmounted.
    expect(count(without, 'class="slide')).toBe(5);
    expect(count(without, "inert")).toBe(4);
    expect(without).toContain('aria-label="Slide 1 of 5: Good morning" aria-current="step"');
  });

  test("Good morning: the greeting with and without a first name, the date, Start ›, Your recent work, bars and the glance tiles", () => {
    expect(headings(deckHtml({ latest: loaded(RICH), firstName: "Sam" }))[0]).toBe("Good morning, Sam");
    const html = deckHtml({ latest: loaded(RICH) });
    expect(headings(html)[0]).toBe("Good morning");
    expect(html).toContain("Friday 16 October");
    expect(html).toContain("Start ›");
    // User-directed 2026-10-22 (option 2): renamed, and its label is bold (the mockup's `.k`).
    expect(normalise(html)).toMatch(/<p class="work[^"]*"><strong[^>]*>Your recent work:<\/strong> 2 projects · 3 commits · 1 PR merged<\/p>/);
    expect(html).not.toContain("Your work:");
    expect(html).toContain('aria-label="Commits per project"');
    expect(html).toMatch(/style="--w: 100;?"/);   // app: 2 of 2 → 100
    expect(html).toMatch(/style="--w: 50;?"/);   // lib: 1 of 2 → 50
    expect(html).toContain("First suggestion");
    expect(html).toContain("review the parser fix");
  });

  test("A-M6 review: an older page says its date ONCE (the title is the sentence: \"Your last briefing, from …\")", () => {
    const stale = normalise(deckHtml({ latest: loaded(page({ date: "2026-10-14" })) }));
    expect(headings(stale)[0]).toBe("Your last briefing, from Wednesday 14 October");
    // Once in what is DRAWN (the text, attributes left out): the slide's dot names its heading (round-1 L3), which
    // is an accessible name, not a second date line.
    expect(count(stale.replace(/<[^>]*>/g, " "), "Wednesday 14 October")).toBe(1);
    expect(stale).toContain('aria-label="Slide 1 of 5: Your last briefing, from Wednesday 14 October"');
    expect(stale).not.toMatch(/<p class="date/);
    // Today's page keeps its date line under the greeting.
    expect(normalise(deckHtml({ latest: loaded(RICH) }))).toMatch(/<p class="date[^"]*">Friday 16 October<\/p>/);
  });

  test("A-M6 reading: no card or bar says \"0 commits\" — a merge-only card names its PRs, an evidence-less one shows no count, and neither has a bar", () => {
    const text = page({
      recap: [
        { repo: "app", text: "shipped", evidence: "a1b2c3d" },
        { repo: "nosha", text: "a commit whose evidence was stripped" },
      ],
      windowMerges: [{ repo: "merges", text: "🔀 Merged #12 (feat/x) (Oct 15)  (f6a7b8c)" }],
    });
    const html = normalise(deckHtml({ latest: loaded(text) }));
    expect(html).not.toContain("0 commits");
    expect(html).toMatch(/title="merges">merges<\/span> <span class="caps[^"]*">1 PR merged<\/span>/);
    expect(html).toMatch(/title="nosha">nosha<\/span> <\/div>/);   // the pill, then no count
    const bars = html.slice(html.indexOf('aria-label="Commits per project"'), html.indexOf("</ul>", html.indexOf('aria-label="Commits per project"')));
    expect(count(bars, "<li")).toBe(1);
    expect(bars).toContain('title="app"');
  });

  test("Good morning: \"needs a look\" is drawn BELOW the status line and the banners (the quiet-with-warning text stays true)", () => {
    const html = deckHtml({ latest: loaded(page({ warnings: ["invalid morning time"] })), snap: snapshot({ error: "schedule status timed out" }) });
    const status = html.indexOf("Delivered 07:24");
    const banner = html.indexOf("schedule status timed out");
    const look = html.indexOf("Needs a look");
    expect([status > -1, banner > -1, look > -1]).toEqual([true, true, true]);
    expect(status).toBeLessThan(look);
    expect(banner).toBeLessThan(look);
    expect(html).toContain("A quiet day: no commits in the window. See the warning below.");
    expect(html).toContain("⚠ invalid morning time");
  });

  test("a quiet day without a warning: the quiet line, no Your-recent-work line, and \"No commits in this window\"", () => {
    const html = deckHtml({ latest: loaded(page()) });
    expect(html).toContain("A quiet day: there were no commits in the briefing's window.");
    expect(html).not.toContain("Your recent work:");
    expect(html).not.toContain("Your work:");
    expect(html).toContain("No commits in this window");
  });

  test("one day and several days draw the same cards and counts", () => {
    const recap = (dates: string) => [
      { repo: "mono", text: "reworked the header", evidence: "0a1b2c3", group: `web/app.ts — 3 commits (${dates})` },
      { repo: "mono", text: "fixed the footer", evidence: "1b2c3d4", group: `web/app.ts — 3 commits (${dates})` },
      { repo: "mono", text: "tuned the grid", evidence: "2c3d4e5", group: `web/app.ts — 3 commits (${dates})` },
      { repo: "api", text: "added the route", evidence: "3d4e5f6" },
    ];
    const one = deckHtml({ latest: loaded(page({ recap: recap("10-15") })) });
    const several = deckHtml({ latest: loaded(page({ recap: recap("10-09..10-15") })) });
    for (const html of [one, several]) {
      expect(html).toContain("2 projects · 4 commits · 0 PRs merged");
      expect(html).toContain("3 commits ›");
      expect(html).toContain("1 commit ›");
    }
  });

  test("What you did: the pill row, Open all / Close all, a card per project with its count, its points and its closed disclosure", () => {
    const html = normalise(deckHtml({ latest: loaded(RICH) }));
    expect(html).toContain('aria-label="Jump to a project"');
    expect(html).toContain(">Open all</button>");
    expect(html).toContain(">Close all</button>");
    expect(html).toContain("shipped the deck");
    expect(html).toContain("2 commits ›");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Merged: #12");   // closed: the detail is not drawn
  });

  test("every why line is DRAWN on its card — What you did's and Where you left off's (A-M6 sweep: What you did dropped them)", () => {
    const text = page({
      recap: [
        { repo: "app", text: "shipped the deck", evidence: "a1b2c3d" },
        { repo: "lib", text: "fixed the parser", evidence: "c3d4e5f" },
      ],
      resume: [{ repo: "tool", text: "finish the probe" }],
      whys: { app: "the deck ships first", tool: "the probe needs the archive" },
    });
    expect(text).toContain('   — you wrote: "the deck ships first"\n   • [app] shipped the deck');   // PREMISE: the engine's shape
    expect(text).toContain('   — you wrote: "the probe needs the archive"\n   • [tool] finish the probe');
    const html = normalise(deckHtml({ latest: loaded(text) }));
    expect(count(html, "— you wrote: &quot;the deck ships first&quot;") + count(html, '— you wrote: "the deck ships first"')).toBe(1);
    expect(count(html, "— you wrote: &quot;the probe needs the archive&quot;") + count(html, '— you wrote: "the probe needs the archive"')).toBe(1);
    // On its own card: after the card's pill, before its first point.
    const app = html.indexOf("— you wrote: ", html.indexOf('title="app">app</span> <span class="caps'));
    expect(app).toBeGreaterThan(-1);
    expect(app).toBeLessThan(html.indexOf("shipped the deck</li>"));
  });

  test("What you did: every card, open or closed, draws its points whole; an open card (the reducer's open set, by source) adds every line and its Merged row", () => {
    // Which cards are open is the deck's reducer state (`nav.open`, DeckOrClassic's own; it is not kept across
    // mounts), and a server render shows the closed default, so the open card is pinned on the source: a point is
    // drawn whole whatever the card's state (polish §1), and the detail lists `card.lines` and `card.mergedRow`.
    const src = readFileSync(new URL("../src/lib/deck/WhatYouDid.svelte", import.meta.url), "utf8");
    expect(src).toContain("{@const isOpen = open.includes(card.key)}");
    expect(src).toContain("<li>{point.text}</li>");
    expect(src).toMatch(/\{#if isOpen\}\s*<div class="detail" transition:slide=\{\{ duration: openMs\(\) \}\}>/);
    expect(src).toContain("{#each card.lines as line, j (j)}");
    expect(src).toContain("{card.mergedRow}");
    // …and closed, the drawn point IS the whole sentence: nothing cut, no "…".
    const long = "a recap sentence that goes on and on ".repeat(5).trim();
    const html = normalise(deckHtml({ latest: loaded(page({ recap: [{ repo: "app", text: long, evidence: "a1b2c3d" }] })) }));
    const drawn = /<ul class="points[^"]*">\s*<li[^>]*>([^<]*)<\/li>/.exec(html)?.[1];
    expect(drawn).toBe(long);
    expect(drawn).not.toContain("…");
  });

  test("polish §1: a closed card draws a 300-character point whole, and the points wrap (`overflow-wrap: anywhere`)", () => {
    const long = "a recap sentence that goes on and on ".repeat(9).slice(0, 300);
    expect([...long].length).toBe(300);   // PREMISE
    const html = normalise(deckHtml({ latest: loaded(page({ recap: [{ repo: "app", text: long, evidence: "a1b2c3d" }] })) }));
    expect(html).toMatch(/<button type="button" class="ctl more[^"]*" aria-expanded="false">/);   // PREMISE: the card's own disclosure is closed (the server render's default)
    expect(html).not.toMatch(/class="ctl more[^"]*" aria-expanded="true"/);
    const points = /<ul class="points[^"]*">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
    expect(points).toMatch(new RegExp(`<li[^>]*>${long}</li>`));
    expect(points).not.toContain("…");
    const style = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(new URL("../src/lib/deck/WhatYouDid.svelte", import.meta.url), "utf8"))![1]!;
    const rule = /\n {2}\.points \{([^}]*)\}/.exec(style)?.[1] ?? "";
    expect(rule).toContain("overflow-wrap: anywhere;");
  });

  test("Where you left off: a branch tag with its counts beside it (user-directed 2026-10-21: \"ahead N · behind N\", each only when N > 0), the resume items, and a branch-only card on an empty section", () => {
    const html = normalise(deckHtml({ latest: loaded(RICH) }));
    expect(html).toMatch(/On branch <\/span><span class="tag branch[^"]*" title="feat\/deck">feat\/deck<\/span> <span class="counts caps[^"]*">ahead 2 · behind 1<\/span>/);
    // (ahead 0, behind 0): the tag alone, no count text.
    expect(html).toMatch(/title="main">main<\/span> <\/div>/);
    expect(html).not.toContain("ahead 0");
    expect(html).not.toContain("behind 0");
    const counts = (line: string) => normalise(deckHtml({ latest: loaded(page({ branchState: [{ repo: "app", text: line }] })) }));
    expect(counts("On branch main (ahead 3, behind 0)")).toMatch(/title="main">main<\/span> <span class="counts caps[^"]*">ahead 3<\/span>/);
    expect(counts("On branch main (ahead 0, behind 2)")).toMatch(/title="main">main<\/span> <span class="counts caps[^"]*">behind 2<\/span>/);
    expect(counts("On branch main (no upstream)")).not.toMatch(/class="counts/);
    expect(html).toContain("finish the deck");
    const branchOnly = page({ branchState: [{ repo: "app", text: "On branch main (no upstream)" }] });
    expect(branchOnly).toContain("(nothing in progress)");   // PREMISE: the engine writes both
    const b = normalise(deckHtml({ latest: loaded(branchOnly) }));
    expect(b).toMatch(/title="main">main<\/span>/);
    expect(b).toContain("Nothing in progress.");
    expect(b.indexOf('title="main"')).toBeLessThan(b.indexOf("Nothing in progress."));
  });

  test("Suggested for today: numbered, a pill only with a label, the verdict marker; an older page says \"Suggested then\"", () => {
    const html = normalise(
      deckHtml({
        latest: loaded(page({ suggestions: [{ repo: "app", text: "check the verdict file", verdictPath: true }, { text: "write the note" }] })),
      }),
    );
    expect(html).toContain("check the verdict file");
    expect(html).toContain("⚑ human gate: cites a commit on a configured verdict path");
    expect(count(html, 'class="pill pc-')).toBeGreaterThan(0);
    const stale = deckHtml({ latest: loaded(page({ date: "2026-10-14", suggestions: [{ text: "x" }] })) });
    expect(headings(stale)).toContain("Suggested then");
    expect(headings(stale)[0]).toBe("Your last briefing, from Wednesday 14 October");
  });

  test("the calendar slide: \"No calendar is connected\" and a failed source's line as the page has them; an older page says only \"Calendar shows on today's briefing\"", () => {
    const none = deckHtml({ latest: loaded(page({ calendar: { events: [], sources: [], incomplete: false } } as Partial<EngineStruct>)) });
    expect(none).toContain("No calendar is connected");
    const failed = deckHtml({
      latest: loaded(
        page({
          calendar: { events: [], sources: [{ id: "macos", kind: "macos", status: "not-granted" }, { id: "work", kind: "link", status: "timeout" }], incomplete: true },
        } as Partial<EngineStruct>),
      ),
    });
    expect(failed).toContain("Calendar unavailable today");
    expect(failed).toContain("work: did not answer in time");
    const stale = deckHtml({ latest: loaded(page({ date: "2026-10-14", calendar: { events: [], sources: [], incomplete: false } } as Partial<EngineStruct>)) });
    expect(headings(stale)).toContain("Calendar");
    expect(headings(stale)).not.toContain("Today's calendar");
    expect(stale).toContain("Calendar shows on today's briefing");
    expect(stale).not.toContain("No calendar is connected");
  });

  test("the launchpad: the mood line, the meeting tile in each state, and the two buttons", () => {
    const at = (h: number, m: number) => new Date(2026, 9, 16, h, m).getTime();
    const ev = { time: { kind: "timed", startMs: at(9, 0), endMs: at(9, 30) }, title: "Standup", status: "confirmed", transparency: "busy", attendeeCount: 2 };
    const text = page({ calendar: { events: [ev], sources: [{ id: "macos", kind: "macos", status: "ok" }], incomplete: false } } as Partial<EngineStruct>);
    const at8 = normalise(deckHtml({ latest: loaded(text), now: at(8, 0) }));
    expect(at8).toContain("Nothing needs you right now.");
    expect(at8).not.toContain("In 60 minutes");
    expect(at8).toContain("Next meeting");   // the Good-morning glance tile
    expect(at8).toContain("09:00 · Standup");
    const soon = normalise(deckHtml({ latest: loaded(text), now: at(8, 50) }));
    expect(soon).toContain("A meeting is coming up.");
    expect(soon).toMatch(/<p class="label[^"]*">\s*In 10 minutes\s*<\/p>/);
    expect(soon).not.toMatch(/class="label[^"]*close/);
    const imminent = normalise(deckHtml({ latest: loaded(text), now: at(8, 56) }));
    expect(imminent).toMatch(/<p class="label[^"]* close">\s*In 4 minutes/);
    const live = normalise(deckHtml({ latest: loaded(text), now: at(9, 10) }));
    expect(live).toMatch(/<section class="tile[^"]* live[^"]*">/);
    expect(imminent).not.toMatch(/<section class="tile[^"]* live/);   // 5 minutes away: the label only, no outline
    expect(live).toMatch(/<span class="pulse[^"]*"><\/span>Now/);
    expect(live).toContain("A meeting is in progress.");   // the user's wording, 2026-10-21 (the spec named only two texts)
    expect(live).not.toContain("A meeting is coming up.");
    expect(imminent).toContain("A meeting is coming up.");
    expect(at8).toContain(">Full briefing</button>");
    expect(at8).toContain(">Past briefings</button>");
  });

  test("a hostile label, line and suggestion stay text on every slide", () => {
    const html = deckHtml({
      latest: loaded(
        page({
          recap: [{ repo: HOSTILE, text: `shipped ${HOSTILE}`, evidence: "a1b2c3d" }],
          resume: [{ repo: HOSTILE, text: HOSTILE }],
          suggestions: [{ repo: HOSTILE, text: HOSTILE }],
        }),
      ),
      firstName: HOSTILE,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x");
  });
});

/* ── Good morning, option 2 (user-directed 2026-10-22) ────────────────────────────────────────── */

describe("Good morning, option 2 with the COMMITS header (user-directed 2026-10-22)", () => {
  /** The Good-morning slide's own markup: from the first slide to the second (or to the end with one slide). */
  const gmSlide = (html: string): string => {
    const a = html.indexOf('<div class="slide');
    const b = html.indexOf('<div class="slide', a + 1);
    return normalise(b < 0 ? html.slice(a) : html.slice(a, b));
  };
  const REFUSED = "Your settings file has a problem, so nothing ran. See Details.";   // run-result.ts's configError sentence (polish §6)
  const RAN = { progress: ["engine: started"], runResult: REFUSED, detailsOpen: true };
  /** Every focusable control in a fragment, by its accessible name (aria-label, else its text), in document (= tab) order. */
  const controls = (html: string): string[] =>
    [...html.matchAll(/<(button|summary)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => (/aria-label="([^"]*)"/.exec(m[2]!)?.[1] ?? m[3]!.replace(/<[^>]+>/g, "")).trim());
  const RC_SRC = (): string => readFileSync(new URL("../src/lib/RunControls.svelte", import.meta.url), "utf8");
  /** A rule's declarations in a component's <style>, whitespace collapsed ("" when there is no such rule). */
  const ruleOf = (src: string, selector: string): string => {
    const style = src.slice(src.indexOf("<style>"));
    const m = new RegExp(`\\n\\s*${selector.replace(/[.[\]"~=]/g, "\\$&")} \\{([^}]*)\\}`).exec(style);
    return (m?.[1] ?? "").replace(/\s+/g, " ").trim();
  };

  test("one centred row: the status badge, Run now and an \"i\" button; the hint is in the i's note, not drawn inline", () => {
    const gm = gmSlide(deckHtml({ latest: loaded(RICH) }));
    // Checkpoint L6: the "i" is an icon (inline SVG, aria-hidden), not the text "i", so its accessible name is the
    // whole label (WCAG 2.5.3). Checkpoint M1: the note is AFTER the row, in the flow, not floating over what follows.
    const row = new RegExp(
      '<div class="actions row[^"]*">\\s?<div class="badge info[^"]*">Delivered 07:24</div>\\s?' +
        '<button type="button" class="ctl run[^"]*">Run now</button>\\s?' +
        '<button type="button" class="ctl info[^"]*" aria-label="What Run now does" aria-expanded="false" aria-controls="([^"]+)">\\s?<svg [^>]*aria-hidden="true"[^>]*>(?:(?!</svg>)[\\s\\S])*</svg>\\s?</button>\\s?</div>\\s?' +
        `<p id="\\1" class="note[^"]*" hidden(="")?>${RUN_NOW}</p>`,
    );
    expect(gm).toMatch(row);
    // The hint is behind the i only: once, in the note, and never the inline `.hint`.
    expect(count(gm, RUN_NOW)).toBe(1);
    expect(gm).not.toContain('class="hint');
    // Run now is not filled here: Start is the slide's only primary-looking button (the CSS, look.check.ts).
    expect(gm).not.toMatch(/<button class="svelte-[^"]*">Run now<\/button>/);
  });

  test("the classic TodayView keeps its inline hint beside a plain Run now, and has no i button or note", () => {
    const classic = normalise(classicHtml({ latest: loaded(RICH) }));
    expect(classic).toMatch(new RegExp(`<div class="actions svelte-[^"]*"><button class="svelte-[^"]*">Run now</button> <span class="hint svelte-[^"]*">${RUN_NOW}</span></div>`));
    expect(classic).not.toContain("What Run now does");
    expect(classic).not.toContain('class="note');
    expect(classic).not.toContain("actions row");
  });

  test("banners, the result line and Details sit UNDER the row in today's order; the quiet, loading and first-run texts after them", () => {
    const quiet = gmSlide(
      deckHtml({ latest: loaded(page({ warnings: ["invalid morning time"] })), snap: snapshot({ error: "schedule status timed out" }), run: RAN }),
    );
    const at = (needle: string) => quiet.indexOf(needle);
    const order = [at('class="actions row'), at("schedule status timed out"), at(`<p class="result`), at("<details"), at("A quiet day"), at("Start ›")];
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(quiet).toContain(REFUSED);   // the refused run's "See Details." stays true: the result is above Details
    for (const [state, text] of [[{ state: "none" }, "No briefing yet</h3>"], [{ state: "loading" }, "Loading the latest briefing…"]] as const) {
      const one = gmSlide(deckHtml({ latest: state as LatestLoad, run: RAN }));
      expect({ state: state.state, after: one.indexOf("<details") > -1 && one.indexOf("<details") < one.indexOf(text) }).toEqual({ state: state.state, after: true });
    }
  });

  test("tab order follows the visual order: Run now, i, Details, then Start (and nothing else on the slide takes focus)", () => {
    expect(controls(gmSlide(deckHtml({ latest: loaded(RICH), run: RAN })))).toEqual(["Run now", "What Run now does", "Details", "Start ›"]);
    expect(controls(gmSlide(deckHtml({ latest: loaded(RICH) })))).toEqual(["Run now", "What Run now does", "Start ›"]);
  });

  test("checkpoint M1: the open note covers nothing — it is in the flow under the row, pushing what follows down — and the open i does not wear the focus ring", () => {
    const rc = RC_SRC();
    const note = ruleOf(rc, ".note");
    expect(note.length).toBeGreaterThan(0);   // PREMISE: the rule is read
    expect(note).not.toMatch(/position:|transform:|z-index:/);
    // The note's element is a sibling AFTER the row (the server render above pins the order), never inside it.
    const row = rc.slice(rc.indexOf('<div class="actions row">'), rc.indexOf("</div>", rc.indexOf('<div class="actions row">')));
    expect(row).not.toContain('class="note"');
    // The open state is its own look (an inset ring and the panel fill), not app.css's focus outline.
    const open = ruleOf(rc, '.info[aria-expanded="true"]');
    expect(open).not.toContain("outline");
    expect(open).toContain("background: var(--panel);");
    expect(open).toContain("box-shadow: inset 0 0 0 1px var(--fg);");
    expect(open).toContain("border-color: var(--fg);");
  });

  test("checkpoint M2: after a run the result line and Details sit tight under the row on Good morning only — TodayView's spacing is unchanged", () => {
    const rc = RC_SRC();
    // The classic rules, as before (TodayView draws these).
    expect(ruleOf(rc, ".result")).toBe("margin: 0.6rem 0 0;");
    expect(ruleOf(rc, ".details")).toBe("margin-top: 0.8rem;");
    // Good morning's: reached only through `.row`, which exists only with hint="info".
    expect(ruleOf(rc, ".row ~ .result")).toContain("margin-top: 0.3rem;");
    expect(ruleOf(rc, ".row ~ .details")).toContain("margin-top: 0.15rem;");
    expect(normalise(classicHtml({ latest: loaded(RICH), run: RAN }))).not.toContain(" row");
  });

  test("the COMMITS header: over the count column only when bars are drawn, and hidden from screen readers (the list keeps its name and each row's \" commit(s)\")", () => {
    const rich = gmSlide(deckHtml({ latest: loaded(RICH) }));
    expect(rich).toMatch(/<div class="chart[^"]*"><p class="caps head[^"]*" aria-hidden="true">Commits<\/p> <ul class="bars[^"]*" aria-label="Commits per project">/);
    expect(count(rich, ">Commits</p>")).toBe(1);
    expect(rich).toMatch(/>2<span class="sr-only[^"]*"> commits<\/span>/);   // app
    expect(rich).toMatch(/>1<span class="sr-only[^"]*"> commit<\/span>/);   // lib
    // No bars, no header: a quiet day, and a day with PRs merged but no counted commit (the work line, no bars).
    const mergesOnly = page({ windowMerges: [{ repo: "app", text: "🔀 Merged #12 (feat/x) (Oct 15)  (f6a7b8c)" }] });
    for (const [name, text] of [["quiet", page()], ["merges only", mergesOnly]] as const) {
      const gm = gmSlide(deckHtml({ latest: loaded(text) }));
      expect({ name, header: gm.includes(">Commits</p>"), list: gm.includes('aria-label="Commits per project"') }).toEqual({ name, header: false, list: false });
    }
    expect(gmSlide(deckHtml({ latest: loaded(mergesOnly) }))).toContain("Your recent work:</strong> 1 project · 1 PR merged");
  });

  test("Start ›: drawn after the glance tiles, and absent when Good morning is the only slide", () => {
    const gm = gmSlide(deckHtml({ latest: loaded(RICH) }));
    expect(gm.indexOf("Start ›")).toBeGreaterThan(gm.indexOf("review the parser fix"));
    expect(gm.indexOf("Start ›")).toBeGreaterThan(gm.lastIndexOf('<section class="tile'));
    expect(gm).toMatch(/<div class="go[^"]*"><button type="button" class="ctl start[^"]*">Start ›<\/button><\/div>/);
    for (const latest of [{ state: "loading" }, { state: "none" }, { state: "error", message: "unreadable" }] as LatestLoad[]) {
      const html = deckHtml({ latest });
      expect({ s: latest.state, start: html.includes("Start ›"), go: html.includes('class="go') }).toEqual({ s: latest.state, start: false, go: false });
    }
  });

  test("the i: a second click, Esc (focus left on the button), a click outside, focus moving elsewhere and the slide going off-screen close the note, and it never moves focus — by source (a server render runs no events; no DOM is installed here, so the browser pass in the builder's report runs them)", () => {
    const rc = RC_SRC();
    expect(rc).toContain("onclick={() => (infoOpen = !infoOpen)}");
    expect(rc).toContain("<svelte:window onkeydown={onwindowkey} onclick={onwindowclick} onfocusin={onwindowfocus} />");
    expect(rc).toMatch(/function onwindowkey\(e: KeyboardEvent\): void \{\s*if \(infoOpen && e\.key === "Escape"\) infoOpen = false;\s*\}/);
    // A click or a focus that lands outside the button and its note closes it (checkpoint M1: Tab away closes it).
    expect(rc).toMatch(
      /function inside\(t: EventTarget \| null\): boolean \{\s*return t instanceof Node && \(infoButton\?\.contains\(t\) === true \|\| note\?\.contains\(t\) === true\);\s*\}/,
    );
    expect(rc).toMatch(/function onwindowclick\(e: MouseEvent\): void \{\s*if \(infoOpen && !inside\(e\.target\)\) infoOpen = false;\s*\}/);
    expect(rc).toMatch(/function onwindowfocus\(e: FocusEvent\): void \{\s*if \(infoOpen && !inside\(e\.target\)\) infoOpen = false;\s*\}/);
    // Checkpoint L3: `inside` reads the two elements through these bindings. Without the button's, the click that
    // OPENS the note reaches the window as "outside" and closes it again at once.
    expect(rc).toMatch(/<button\s+type="button"\s+class="ctl info"(?:(?!<\/button)[\s\S])*?\sbind:this=\{infoButton\}\s*>/);
    expect(rc).toMatch(/<p id=\{noteId\} class="note" hidden=\{!infoOpen\} bind:this=\{note\}>/);
    // The slide going off-screen (any slide change, by key, arrow or dot) closes it (checkpoint L5).
    expect(rc).toMatch(/\$effect\(\(\) => \{\s*if \(!shown\) infoOpen = false;\s*\}\);/);
    expect(rc).toMatch(/shown = true/);
    const deck = readFileSync(new URL("../src/lib/deck/Deck.svelte", import.meta.url), "utf8");
    expect(deck).toContain("current={i === nav.index}");
    expect(readFileSync(new URL("../src/lib/deck/GoodMorning.svelte", import.meta.url), "utf8")).toContain('<RunControls hint="info" shown={current} ');
    expect(rc).toContain("hidden={!infoOpen}");
    // Nothing in RunControls or Good morning moves focus (the heading's focusHeading action is a11y.ts's).
    const gm = readFileSync(new URL("../src/lib/deck/GoodMorning.svelte", import.meta.url), "utf8");
    for (const [f, s] of [["RunControls", rc], ["GoodMorning", gm]]) expect({ f, focus: /\.focus\(/.test(s) }).toEqual({ f, focus: false });
  });
});

/* ── deck state, Full briefing ────────────────────────────────────────────────────────────────── */

describe("the deck's kept state and Full briefing", () => {
  test("a briefing's kept slide is where the deck reopens: the track offset and the current dot", () => {
    const text = page({ recap: [{ repo: "app", text: "kept-slide page", evidence: "a1b2c3d" }] });
    keepDeckState(briefingHash(text), "leftOff", 2, false);
    const html = deckHtml({ latest: loaded(text) });
    expect(html).toMatch(/class="track[^"]*" style="--i: 2;?"/);
    expect(html).toContain('aria-label="Slide 3 of 5: Where you left off" aria-current="step"');
  });

  test("with no page yet (Today mounting while it loads) the deck is Good morning and the kept state is left for the page", () => {
    const text = page({ recap: [{ repo: "app", text: "reopened page", evidence: "a1b2c3d" }] });
    keepDeckState(briefingHash(text), "suggested", 3, false);
    expect(headings(deckHtml({ latest: { state: "loading" } }))).toEqual(["Good morning"]);
    expect(deckHtml({ latest: loaded(text) })).toContain('aria-label="Slide 4 of 5: Suggested for today" aria-current="step"');
    // The key change itself runs in an effect (no server render runs one): pinned on the source.
    const shell = readFileSync(new URL("../src/lib/deck/DeckOrClassic.svelte", import.meta.url), "utf8");
    expect(shell).toContain("const kept = untrack(() => deckStateOnKey(briefingKey));");
    expect(shell).toContain("const s = deckStateOnKey(key);");
    expect(shell).toContain("if (briefingKey !== null) keepDeckState(briefingKey, shownSlides[nav.index] ?? null, nav.index, classic);");
  });

  test("Full briefing kept for this briefing: TodayView for the same model, with \"Back to slides\" above it", () => {
    const text = page({ recap: [{ repo: "app", text: "full-briefing page", evidence: "a1b2c3d" }] });
    keepDeckState(briefingHash(text), "launchpad", 4, true);
    const html = unwrapViews(normalise(deckHtml({ latest: loaded(text) })));
    const back = html.indexOf(">Back to slides</button>");
    expect(back).toBeGreaterThan(-1);
    expect(html.slice(html.indexOf("</div>", back) + "</div>".length).trim()).toBe(normalise(classicHtml({ latest: loaded(text) })).trim());
    // An sr-only heading names the view and is where focus goes on the way in (LOW-1); then TodayView's own.
    expect(headings(html)).toEqual(["Full briefing", "Today"]);
    expect(html).toMatch(/<h2 class="sr-only[^"]*" tabindex="-1">Full briefing<\/h2>/);
  });

  test("the arrows' disabled state and the one current dot: Previous at the first slide, Next on a kept last slide", () => {
    const first = deckHtml({ latest: loaded(RICH) });
    expect(first).toMatch(/aria-label="Previous slide" disabled/);
    expect(first).not.toMatch(/aria-label="Next slide" disabled/);
    expect(count(first, 'aria-current="step"')).toBe(1);
    const text = page({ recap: [{ repo: "app", text: "last-slide page", evidence: "a1b2c3d" }] });
    keepDeckState(briefingHash(text), "launchpad", 4, false);
    const last = deckHtml({ latest: loaded(text) });
    expect(last).toMatch(/aria-label="Next slide" disabled/);
    expect(last).not.toMatch(/aria-label="Previous slide" disabled/);
    expect(count(last, 'aria-current="step"')).toBe(1);
    expect(last).toContain('aria-label="Slide 5 of 5: You\'re all set" aria-current="step"');
  });

});

/* ── PB-M1-T3: the deck keeps your slide by its id (wave-2 polish spec §3, "Slide identity") ───────── */

describe("PB-M1-T3: the deck restores by slide id and remaps without a glide", () => {
  const CAL = { calendar: { events: [], sources: [], incomplete: false } } as Partial<EngineStruct>;
  const SHELL = readFileSync(new URL("../src/lib/deck/DeckOrClassic.svelte", import.meta.url), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");
  const DECK_SRC = readFileSync(new URL("../src/lib/deck/Deck.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");

  test("render: the kept SlideId restored at a new index (the launchpad kept at 4 of five, drawn at 6 of six)", () => {
    const text = page({ recap: [{ repo: "app", text: "kept-id page", evidence: "a1b2c3d" }], ...CAL });
    keepDeckState(briefingHash(text), "launchpad", 4, false);
    const html = deckHtml({ latest: loaded(text) });
    expect(html).toMatch(/class="track[^"]*" style="--i: 5;?"/);
    expect(html).toContain('aria-label="Slide 6 of 6: You\'re all set" aria-current="step"');
    expect(count(html, 'aria-current="step"')).toBe(1);
  });

  test("render: an absent kept SlideId falls back to its kept index, clamped", () => {
    const text = page({ recap: [{ repo: "app", text: "absent-id page", evidence: "a1b2c3d" }] });
    keepDeckState(briefingHash(text), "calendar", 3, false);
    expect(deckHtml({ latest: loaded(text) })).toContain('aria-label="Slide 4 of 5: Suggested for today" aria-current="step"');
    keepDeckState(briefingHash(text), "calendar", 9, false);
    const clamped = deckHtml({ latest: loaded(text) });
    expect(clamped).toMatch(/class="track[^"]*" style="--i: 4;?"/);
    expect(clamped).toContain('aria-label="Slide 5 of 5: You\'re all set" aria-current="step"');
  });

  test("render: a different briefing key resets to Good morning and never looks the kept SlideId up", () => {
    const other = page({ recap: [{ repo: "app", text: "the other page", evidence: "a1b2c3d" }], ...CAL });
    const text = page({ recap: [{ repo: "app", text: "this page", evidence: "a1b2c3d" }], ...CAL });
    keepDeckState(briefingHash(other), "launchpad", 5, false);
    const html = deckHtml({ latest: loaded(text) });
    expect(html).toMatch(/class="track[^"]*" style="--i: 0;?"/);
    expect(html).toContain('aria-label="Slide 1 of 6: Good morning" aria-current="step"');
  });

  test("render: a classic deck (an empty slide list) restores index 0 / count 1, never -1 — drawn as the note and the classic view", () => {
    const text = fixture("cannot-map-no-title.md");
    keepDeckState(briefingHash(text), "launchpad", 4, false);
    const html = normalise(deckHtml({ latest: loaded(text) }));
    expect(count(html, NOTE)).toBe(1);
    expect(html).not.toContain('class="deck');
    // The nav it starts from (no server render shows it): placeOnList over slidesOf(deck), [] for classic, and countOf.
    expect(SHELL).toContain('const slidesOf = (v: DeckView): readonly SlideId[] => v.kind === "slides" ? v.slides : [];');
    expect(SHELL).toContain("const countOf = (v: DeckView): number => (v.kind === \"classic\" ? 1 : v.slides.length);");
    expect(SHELL).toContain("let shownSlides = untrack(() => slidesOf(deck));");
    expect(SHELL).toContain("let nav = $state<DeckNav>(untrack(() => ({ index: placeOnList(kept, shownSlides), count: countOf(deck), open: [] })));");
  });

  test("source: slidesOf is an arrow const beside countOf, before `const moves = moveRules();` and before any function", () => {
    const at = SHELL.indexOf("const slidesOf = ");
    expect(at).toBeGreaterThan(SHELL.indexOf("const countOf = "));
    expect(at).toBeLessThan(SHELL.indexOf("const moves = moveRules();"));
    expect(SHELL).not.toContain("function slidesOf(");
  });

  test("source: the key change initialises the shown list, clears quiet and restores placeOnList; the pre-effect tracks the list", () => {
    expect(SHELL).toContain("const key = briefingKey; const count = countOf(deck); const list = slidesOf(deck);");
    expect(SHELL).toContain(
      "shownKey = key; shownSlides = list; quiet = null; nav = { ...deckReducer(nav, { type: \"briefingChanged\", count }), index: placeOnList(s, list) }; classic = s.classic; afterChange(from, wasInside, true);",
    );
  });

  test("source: every list change updates the shown list and the count; same changes nothing else; remap and removal take listChange's quiet and glide, keep(), and afterChange(from, wasInside, false) with focus read first", () => {
    expect(SHELL).toContain(
      "} else { const r = listChange({ prev: shownSlides, index: nav.index, next: list, quiet, glide }); shownSlides = list; if (r.kind === \"same\") { if (count !== nav.count) nav = { ...nav, count }; } else { const from = nav.index; const wasInside = focusInside(); nav = { ...nav, count, index: r.index }; quiet = r.quiet; glide = r.glide; keep(); afterChange(from, wasInside, false); } }",
    );
    // The count-only clamp is gone: a list change is never just a clamp.
    expect(SHELL).not.toContain("index: Math.min(nav.index, count - 1)");
    expect(SHELL).toContain("let quiet = $state<number | null>(null);");
  });

  test("source: remap and removal emit no move — no onmove and no moveRules call in the key/list pre-effect", () => {
    expect(SHELL.indexOf("const jump = runJumpNow(")).toBeGreaterThan(SHELL.indexOf("const r = listChange("));
    expect(SHELL.indexOf("const r = listChange(")).toBeGreaterThan(-1);
    const branch = SHELL.slice(SHELL.indexOf("const r = listChange("), SHELL.indexOf("const jump = runJumpNow("));
    expect(branch).not.toContain("onmove");
    expect(branch).not.toContain("moves.");
  });

  test("source: the deck gets quiet, and the next user move clears it", () => {
    expect(SHELL).toContain("{landing} {glide} {quiet} {now}");
    expect(SHELL).toContain('if (next.index !== nav.index) { landing = "slideHeading"; glide = true; quiet = null; }');
    expect(DECK_SRC).toContain("quiet: number | null;");
    expect(DECK_SRC).toMatch(/let \{ view, model, nav, landing, glide, quiet, now, [^}]*\}: Props = \$props\(\);/);
    expect(DECK_SRC).toContain("class:glide={glide && quiet !== nav.index}");
  });
});

/* ── source and compiled-shape pins (hub, Motion and Accessibility, :46-53) ───────────────────── */

describe("the deck's motion and accessibility, by source", () => {
  const DIR = new URL("../src/lib/deck/", import.meta.url);
  const src = (name: string): string => readFileSync(new URL(name, DIR), "utf8");
  const SLIDES = ["GoodMorning.svelte", "WhatYouDid.svelte", "LeftOff.svelte", "Suggested.svelte", "CalendarSlide.svelte", "Launchpad.svelte"];

  test("each slide's heading is the focus target: one <h2 tabindex=\"-1\" use:focusHeading={active}>, its action imported from lib/ui/a11y", () => {
    for (const f of SLIDES) {
      const s = src(f);
      expect({ f, h2: count(s, "<h2 ") }).toEqual({ f, h2: 1 });
      expect({ f, target: /<h2 tabindex="-1" use:focusHeading=\{active\}(?: bind:this=\{heading\})?>/.test(s) }).toEqual({ f, target: true });
      expect({ f, imp: s.includes('import { focusHeading } from "../ui/a11y";') }).toEqual({ f, imp: true });
    }
  });

  test("the deck has the reduced-motion block, and the track glides on --glide-ms", () => {
    const deck = src("Deck.svelte");
    expect(deck).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.track,\s*\.track\.glide \{\s*transition: none;/);
    // Round-4 L5: the glide only once the user has moved in this mount (`class:glide`).
    expect(deck).toMatch(/\.track\.glide \{\s*transition: transform var\(--glide-ms\) ease;\s*\}/);
    // Post-cap L7: the plain track has NO transition of its own (only `.glide` adds one).
    const trackRule = /\n  \.track \{([^}]*)\}/.exec(deck)![1]!;
    expect(trackRule).not.toContain("transition");
    // Scoped-review L3: NO rule outside the reduced-motion block whose selector reaches the plain track (any selector
    // ending `.track` without `.glide`) sets a transition.
    const style = deck.slice(deck.indexOf("<style>")).replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n  \}\n/, "");
    for (const [, sel, decls] of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const plain = sel!.split(",").some((one) => /\.track(?![\w.-])/.test(one.replace(/\/\*[\s\S]*?\*\//g, "").trim()) && !/\.track\.glide/.test(one));
      if (plain) expect({ sel: sel!.trim(), transition: /transition/.test(decls!) }).toEqual({ sel: sel!.trim(), transition: false });
    }
    // PB-M1-T3: a remap's index (`quiet`) does not glide; the next user move clears it.
    expect(deck).toContain('<div class="track" class:glide={glide && quiet !== nav.index} style:--i={clampInt(nav.index, 12)}>');
    expect(src("MeetingTile.svelte")).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.pulse \{\s*animation: none;/);
  });

  test("navigation controls are real buttons: the arrows and the dots are <button type=\"button\" class=\"ctl …\">", () => {
    const deck = src("Deck.svelte");
    expect(count(deck, '<button type="button" class="ctl arrow ')).toBe(2);
    expect(deck).toMatch(/<button\s+type="button"\s+class="ctl dot"/);
    expect(deck).not.toMatch(/<(div|span)[^>]*onclick/);
  });

  test("← and → are handled by the deck and call the reducer's previous and next", () => {
    const deck = src("Deck.svelte");
    expect(deck).toContain("<svelte:window {onkeydown} />");
    // Each branch's condition is the bare key test, and its body is exactly preventDefault then the action.
    expect(deck).toMatch(/\n {4}if \(e\.key === "ArrowLeft"\) \{\n {6}e\.preventDefault\(\);\n {6}ondispatch\(\{ type: "previous" \}\);\n {4}\}/);
    expect(deck).toMatch(/ else if \(e\.key === "ArrowRight"\) \{\n {6}e\.preventDefault\(\);\n {6}ondispatch\(\{ type: "next" \}\);\n {4}\}/);
  });

  test("a pill or tag OUTSIDE a control passes `wrap` (Pill's and StatusTag's contract: no keyboard way to an ellipsized label otherwise)", () => {
    expect(src("LeftOff.svelte")).toContain("<Pill palette={card.slot} label={card.label} wrap />");
    expect(src("GoodMorning.svelte")).toContain("<Pill palette={bar.slot} label={bar.label} wrap />");
    expect(src("Suggested.svelte")).toContain("<Pill palette={s.slot} label={s.label} wrap />");
    // A-M6 sweep: What you did's card head too (outside any control).
    expect(src("WhatYouDid.svelte")).toContain('<div class="head">\n        <Pill palette={card.slot} label={card.label} wrap />');
    expect(count(src("LeftOff.svelte"), "<StatusTag ")).toBe(count(src("LeftOff.svelte"), " wrap />") - 1);
    // Inside a button (the pill row) the ellipsis lifts on focus, so no wrap there.
    expect(src("WhatYouDid.svelte")).toContain('<button type="button" class="ctl jump" onclick={() => jump(card.key, i)}><Pill palette={card.slot} label={card.label} /></button>');
    const html = normalise(deckHtml({ latest: loaded(RICH) }));
    expect(html).toMatch(/<span class="pill pc-\d+[^"]* wrap" title="app">app<\/span>/);
  });

  test("← → are left alone with a modifier held, and in a text field (the two guards come first in the handler)", () => {
    const deck = src("Deck.svelte");
    const fn = deck.slice(deck.indexOf("function onkeydown(e: KeyboardEvent): void {"), deck.indexOf('if (e.key === "ArrowLeft")'));
    expect(fn).toContain("    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;\n");
    expect(fn).toContain(
      '    if (t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;\n',
    );
  });

  test("a slide that must scroll SAYS so (A-M6 review, MED-2): \"More below\" over the viewport's foot while the current slide has more below, measured on scroll and resize", () => {
    const deck = src("Deck.svelte");
    // The measurement: the current slide's element, its scroll position against its height, less its empty bottom
    // padding (the slide's and its last child's: user decision 2026-11-05, option A; `moreBelow` in deck.check.ts).
    expect(deck).toContain("more =\n      el !== undefined &&\n      moreBelow({ scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, emptyFoot: bottomPadding(el) + bottomPadding(el.lastElementChild) });");
    // `measure` never runs here (a server render), so the padding it reads is pinned as text; a `return 0` would bring the pill back over Start.
    expect(deck).toContain("return el === null ? 0 : parseFloat(getComputedStyle(el).paddingBottom) || 0;");
    expect(deck).toMatch(/<div class="slide" inert=\{i !== nav\.index\} bind:this=\{slideEls\[i\]\} onscroll=\{measure\} /);
    expect(deck).toMatch(/const ro = new ResizeObserver\(measure\);\s*ro\.observe\(el\);\s*for \(const child of el\.children\) ro\.observe\(child\);\s*return \(\) => ro\.disconnect\(\);/);
    // The hint: text, over the viewport's foot (no layout shift), not announced (the content itself is read).
    expect(deck).toContain('{#if more}<p class="more-hint" aria-hidden="true">More below ↓</p>{/if}');
    expect(deck).toMatch(/\.more-hint \{\s*position: absolute;\s*bottom: 0\.4rem;/);
    // In the markup it sits in the viewport, after the track.
    expect(deck.indexOf("{#if more}")).toBeGreaterThan(deck.indexOf('<div class="track"'));
    expect(deck.indexOf("{#if more}")).toBeLessThan(deck.indexOf('<nav class="controls"'));
    // A server render measures nothing: no hint.
    expect(deckHtml({ latest: loaded(RICH) })).not.toContain("More below");
  });

  test("Good morning (option 2 + spacing option A, user-directed 2026-10-22): ONE sunrise card the slide's height, its content centred, Start alone last", () => {
    // The fit itself (900×640 with no scroll, 560×420 with no horizontal overflow) is measured in a browser
    // (the builder's report); this pins the layout that gives it.
    const gm = src("GoodMorning.svelte");
    const markup = gm.replace(/<script[\s\S]*?<\/script>/, "").replace(/<style>[\s\S]*<\/style>/, "").replace(/<!--[\s\S]*?-->/g, "");
    // The whole slide is the card: it opens the markup and closes it.
    expect(markup.trim().startsWith('<div class="sunrise">')).toBe(true);
    expect(markup.trim().endsWith("</div>")).toBe(true);
    expect(gm).toMatch(
      /\.sunrise \{\s*display: flex;\s*flex-direction: column;\s*align-items: center;\s*justify-content: center;\s*text-align: center;\s*min-height: 100%;[^}]*border-radius: 14px;\s*background: linear-gradient\(140deg, var\(--sunrise-1\), var\(--sunrise-2\) 55%, var\(--sunrise-3\)\);/,
    );
    // Start: the last thing in the card, alone in its own block, centred with the rest (not pushed to the foot);
    // its gap is none at the default 640px-tall window, so the fit after a run holds there.
    expect(markup).toMatch(/\{#if onstart !== null\}\s*<div class="go"><button type="button" class="ctl start" onclick=\{onstart\}>Start ›<\/button><\/div>\s*\{\/if\}\s*<\/div>\s*$/);
    expect(gm).toMatch(/\.go \{\s*margin-top: clamp\(0px, calc\(100vh - 640px\), 1rem\);/);
    expect(gm).not.toMatch(/margin-top: auto/);
    // The greeting 36px and the date 20px, with half a rem before the status row (user-directed 2026-10-22).
    expect(gm).toMatch(/\n  h2 \{\s*margin: 0;\s*font-size: 36px;/);
    expect(gm).toMatch(/\.date \{\s*margin: 0 0 0\.5rem;\s*font-size: 20px;/);
    // Start is drawn once (the markup, not the comments).
    expect(count(markup, "Start ›")).toBe(1);
    // A small CSS sun, never an image, out of the accessibility tree.
    expect(markup).toContain('<span class="sun" aria-hidden="true"></span>');
  });

  test("the deck's height is bounded (MED-1): a viewport sized to the window, each slide scrolls on its own, the controls outside the viewport", () => {
    const deck = src("Deck.svelte");
    // Without these, every slide is as tall as the tallest (a flex row) and the controls fall far below a short slide.
    // min-height 14rem: at the window's minimum, 560×420, the controls stay on screen (A-M6 review, MED-2).
    // Round-3 L4: sized by the space LEFT (a flex item of App's full-height column), not 100vh less a guess.
    // Round-4 L3: 100vh less App's chrome is the fallback where `:has()` is unsupported; with it, the space left.
    expect(deck).toMatch(/\.deck \{\s*display: flex;\s*flex-direction: column;\s*(?:\/\*[\s\S]*?\*\/\s*)?height: calc\(100vh - 10rem\);\s*min-height: 14rem;\s*\}/);
    expect(deck).toMatch(/@supports selector\(:has\(\*\)\) \{\s*\.deck \{\s*flex: 1 1 0;\s*height: auto;\s*\}\s*\}/);
    expect(deck).toMatch(/\.viewport \{\s*position: relative;\s*flex: 1 1 auto;\s*min-height: 0;\s*overflow: hidden;\s*overflow: clip;\s*\}/);
    expect(deck).toMatch(/\.track \{\s*display: flex;\s*height: 100%;/);
    expect(deck).toMatch(/\.slide \{\s*flex: 0 0 calc\(100% - 2 \* \(36px \+ 0\.6rem\)\);\s*min-width: 0;\s*height: 100%;\s*margin: 0 calc\(36px \+ 0\.6rem\);\s*overflow-y: auto;/);
    expect(deck).toMatch(/\.controls \{\s*flex: none;/);
    // The controls are the viewport's sibling, not inside it: in the rendered deck, every <div> opened from the
    // viewport on is closed before the controls start.
    const html = deckHtml({ latest: loaded(RICH) });
    const between = html.slice(html.indexOf('<div class="viewport'), html.indexOf('<nav class="controls'));
    expect(between.length).toBeGreaterThan(0);
    expect(count(between, "<div")).toBe(count(between, "</div>"));
  });

  test("a jump from the pill row sets Card's brief highlight on the target, and the class has a rule (held for HIGHLIGHT_MS)", () => {
    const w = src("WhatYouDid.svelte");
    expect(w).toContain("highlighted={highlighted === card.key}");
    expect(w).toMatch(/function jump\(key: string, i: number\): void \{\s*highlighted = key;[\s\S]*?setTimeout\(\(\) => \(highlighted = null\), HIGHLIGHT_MS\)/);
    const card = readFileSync(new URL("../src/lib/ui/Card.svelte", import.meta.url), "utf8");
    expect(card).toContain("class:highlighted");
    expect(card).toMatch(/\.highlighted \{\s*box-shadow:/);
  });

  test("a card's detail opens with a short height transition (slide, OPEN_MS), 0 under reduced motion", () => {
    const w = src("WhatYouDid.svelte");
    expect(w).toContain('import { slide } from "svelte/transition";');
    expect(w).toContain("transition:slide={{ duration: openMs() }}");
    expect(w).toContain("const openMs = (): number => durations(prefersReducedMotion()).openMs;");
  });

  test("no countdown or slide change is announced: no aria-live and no LiveRegion anywhere in the deck", () => {
    for (const f of readdirSync(DIR)) {
      // The code and markup, not the comments (which say why there is none).
      const s = src(f).replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect({ f, live: /aria-live|LiveRegion|nextLiveText/.test(s) }).toEqual({ f, live: false });
    }
  });

  test("Good morning never unmounts on a slide change: slides are drawn in one {#each} with `inert`, never gated on the index", () => {
    const deck = src("Deck.svelte");
    expect(deck).toMatch(/\{#each view\.slides as id, i \(id\)\}\n(?: {8}<!--[\s\S]*?-->\n)* {8}<div class="slide" inert=\{i !== nav\.index\} bind:this=\{slideEls\[i\]\} onscroll=\{measure\} /);
    expect(deck).not.toMatch(/\{#if [^}]*nav\.index/);
  });

  test("the slide components draw text nodes only: no {@html}, no href (static.check.ts also covers them)", () => {
    for (const f of readdirSync(DIR)) {
      const s = src(f);
      expect({ f, bad: /\{@html|href/.test(s) }).toEqual({ f, bad: false });
    }
  });
});

/* ── A-M5-T12: Today.svelte and App.svelte (source pins) ──────────────────────────────────────── */

describe("Today holds the clock and the deck; App waits for the app-prefs store on the Today branch only", () => {
  /** A source as code: comments removed (as provider-flows.check.ts's `codeOf`), so a commented-out copy never satisfies a pin. */
  const codeOf = (s: string): string =>
    s
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1")
      .replace(/(^|[ \t])\/\/[^\n]*/gm, "$1")
      .replace(/[ \t]+$/gm, "");
  const APP = codeOf(readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8"));
  const TODAY_SRC = codeOf(readFileSync(new URL("../src/routes/Today.svelte", import.meta.url), "utf8"));
  const flat = (s: string): string => s.replace(/\s+/g, " ");

  test("App's Today branch waits ONLY on the settled flag (not on a value of the store), with a plain Loading… line", () => {
    expect(flat(APP)).toMatch(/\{#if route === "today"\} \{#if snapshot === null && snapshotError !== null\} <pre class="failed">\{snapshotError\}<\/pre> \{\/if\} \{#if prefsSettled\} <Today [^/]*(?:\/(?!>)[^/]*)*\/> \{:else\} <p class="muted">Loading…<\/p> \{\/if\} \{:else if route === "history"\}/);
    expect(APP).toContain("let prefsSettled = $state(false);");
    // The flag is set in one place, when the load SETTLES (it never rejects; `.finally` covers both ends).
    expect(APP.match(/\(prefsSettled = /g)).toHaveLength(1);
    expect(APP.match(/prefsSettled = /g)).toHaveLength(2);   // the declaration, and that one assignment
    expect(APP).toContain("void loadAppPrefs().finally(() => (prefsSettled = true));");
    // No other route waits: one `{#if prefsSettled}` in the file.
    expect(APP.match(/\{#if prefsSettled\}/g)).toHaveLength(1);
  });

  test("the store load is AFTER the backup scrub, at onMount's own top level (provider-flows.check.ts's scrub pin stays true)", () => {
    const app = flat(APP);
    const mount = app.slice(app.indexOf("onMount(() => {"), app.indexOf("return () => {", app.indexOf("onMount(() => {")));
    const scrub = mount.indexOf("void scrubOnOpen();");
    const load = mount.indexOf("void loadAppPrefs()");
    expect([scrub > -1, load > scrub]).toEqual([true, true]);
    const before = mount.slice(0, load);
    const depth = (open: string, close: string): number => [...before].reduce((d, ch) => d + (ch === open ? 1 : ch === close ? -1 : 0), 0);
    expect([depth("{", "}"), depth("(", ")")]).toEqual([1, 1]);
    expect(before).not.toMatch(/; return\b|\{ return\b/);
  });

  test("round-1 L7: the Loading… line's `.muted` has a rule in App's own scope, in the --muted colour", () => {
    const style = APP.slice(APP.indexOf("<style>"));
    expect(style).toMatch(/\n {2}\.muted \{\s*margin: 0;\s*color: var\(--muted\);\s*font-size: 0\.85rem;\s*\}/);
    expect(APP.match(/class="muted"/g)).toHaveLength(1);
  });

  test("App routes \"Past briefings\" to History through Today's callback", () => {
    expect(flat(APP)).toMatch(/<Today [^>]*onhistory=\{\(\) => \(route = "history"\)\}[^>]*\/>/);
  });

  test("Today: ONE clock read gives both `today` and `now`, re-read every minute and when the window regains focus", () => {
    expect(TODAY_SRC).toContain("let now = $state(Date.now());");
    expect(TODAY_SRC).toContain("const today = $derived(localDate(new Date(now)));");
    expect(flat(TODAY_SRC)).toContain("todayModel({ snapshot, latest, lastRun, today })");
    // Round-1 L4: the clock is NOT an input of deckView (the page is not re-mapped on every tick or focus); it
    // reaches the components through DeckOrClassic's `now`.
    // B1-M5-T16 and C-M4-T11: two more inputs, B1's `gitDetail` (what `git-live.ts` holds, with the OS) first,
    // then C's calendar detail (the live read's state); still no clock.
    // PB-M4-T3: and the store's "on" (the local `calendarOn`, derived from the aliased store derivation).
    expect(flat(TODAY_SRC)).toContain("deckView({ model, today, firstName: prefs.firstName, gitDetail, calendarDetail, calendarOn, actions, summary })");
    expect(flat(TODAY_SRC)).toContain("const gitDetail = $derived<GitDetailInput>({ ...gitState, os });");
    expect(TODAY_SRC.match(/deckView\(/g)).toHaveLength(1);
    expect(TODAY_SRC).not.toContain("localDate(new Date())");
    // Wave 2, W2-S-T1: the tick and the focus are Today's two clock driver points, `onMinute` and `onFocus` (B1 and C
    // add their live checks inside them); each re-reads the clock first.
    expect(flat(TODAY_SRC)).toMatch(/setInterval\(onMinute, 60_000\)/);
    // …and the tick is cleared when Today unmounts (every route change), or one would pile up per visit.
    expect(TODAY_SRC).toMatch(/const tick = setInterval\(onMinute, 60_000\);\n {4}return \(\) => clearInterval\(tick\);\n {2}\}\);/);
    expect(flat(TODAY_SRC)).toContain("function onMinute(): void { now = Date.now();");
    expect(flat(TODAY_SRC)).toContain("function onFocus(): void { now = Date.now();");
    expect(TODAY_SRC).toContain("<svelte:window onfocus={onFocus} />");
  });

  test("B1-M5-T16: Today drives the live git check — one keyed effect on `briefingKey`, B1's line in onCurrent, onMinute and onFocus, none in onMove, the OS read once", () => {
    const f = flat(TODAY_SRC);
    // The page key: ONE keyed effect, the driver called untracked with the live deck (plan §1.2, M16).
    expect(f).toContain("$effect(() => { const key = briefingKey; untrack(() => git.onPageKey(key, deck)); });");
    expect(TODAY_SRC.match(/git\.onPageKey\(/g)).toHaveLength(1);
    // The driver points, each passing the live deck; B1's line first, then C's (plan §1.4, the second lander).
    expect(f).toContain("function onCurrent(slide: SlideId | null): void { if (slide === current) return; current = slide; git.onCurrent(slide, deck); cal.onCurrent(slide, deck); }");
    expect(f).toContain("function onMinute(): void { now = Date.now(); git.onMinute(deck); cal.onMinute(deck); }");
    expect(f).toContain("function onFocus(): void { now = Date.now(); git.onFocus(deck); cal.onFocus(deck); summaryLive.onFocus(); }");
    expect(f).toMatch(/function onMove\(slide: SlideId, from: SlideId \| null\): void \{[^}]*\}/);
    expect(f.match(/function onMove\(slide: SlideId, from: SlideId \| null\): void \{[^}]*\}/)![0]).not.toContain("git.");
    // The driver: the real wrapper and the real clock, its state a raw (replaced-whole) value.
    expect(f).toContain("const git = gitLive({ invoke: (request) => reposStatus<ReposIpcReply>(request), clock: () => Date.now(), onchange: (s) => (gitState = s) });");
    expect(f).toContain("let gitState = $state.raw<GitLiveState>(");
    expect(TODAY_SRC.match(/osFromUserAgent\(navigator\.userAgent\)/g)).toHaveLength(1);
    expect(TODAY_SRC.match(/\bgitLive\(/g)).toHaveLength(1);
    expect(f).toContain("onMount(() => () => git.dispose());");
  });

  test("Today reads the store when it mounts, keys the deck by the briefing's text, and renders DeckOrClassic with the run props and the callback", () => {
    expect(TODAY_SRC).toContain("let prefs = $state(appPrefs());");
    expect(flat(TODAY_SRC)).toContain('const briefingKey = $derived(latest.state === "loaded" ? briefingHash(latest.file.text) : null);');
    expect(flat(TODAY_SRC)).toMatch(
      // PB-M6-T3: the land request, BEFORE oncurrent / onmove (live-current.check.ts pins those two last).
      /<DeckOrClassic \{model\} \{deck\} \{now\} \{briefingKey\} slides=\{prefs\.slides\} \{running\} \{progress\} \{runResult\} \{detailsOpen\} \{onrun\} \{onhistory\} \{land\} oncurrent=\{onCurrent\} onmove=\{onMove\} \/>/,
    );
    // `detailsOpen` stays REQUIRED (no default, no `?`): a missing pass-through fails `bun run check`.
    expect(TODAY_SRC).toMatch(/\n {4}detailsOpen: boolean;/);
    expect(TODAY_SRC).toMatch(/\n {4}onhistory: \(\) => void;/);
  });

  test("round-1 M1: Today FOLLOWS the store (a set that lands after it mounted changes the greeting and the mode), and `prefs` is only ever replaced whole by the store's own copy", () => {
    // The subscription, in its own onMount: re-read, then follow; the unsubscribe is the cleanup.
    expect(flat(TODAY_SRC)).toContain(
      "onMount(() => { prefs = appPrefs(); return onAppPrefsChange((next) => (prefs = next)); });",
    );
    expect(TODAY_SRC).toContain('  import { appPrefs, onAppPrefsChange } from "../lib/app-prefs-store";\n');
    // T01: `prefs` is written in exactly three places — its declaration, the re-read and the listener — and never
    // field by field (`prefs.slides = …`), which would put a value on screen that the store does not hold.
    const writes = [...TODAY_SRC.matchAll(/\bprefs(\.\w+)?\s*=(?!=)/g)].map((m) => m[0].replace(/\s+/g, " "));
    expect(writes).toEqual(["prefs =", "prefs =", "prefs ="]);
    expect(TODAY_SRC).not.toMatch(/\bprefs\.\w+\s*(=(?!=)|\+\+|--)/);
    expect(TODAY_SRC.match(/prefs = \$state\(appPrefs\(\)\)/g)).toHaveLength(1);
    expect(TODAY_SRC.match(/\(prefs = next\)/g)).toHaveLength(1);
  });
});

/* ── PB-M1-T4: Today starts from the kept briefing (wave-2 polish spec §3, "How Today uses it") ──────── */

describe("PB-M1-T4: Today starts from the kept briefing, so a remount on the same file draws no Good-morning frame", () => {
  const codeOf = (s: string): string =>
    s
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1")
      .replace(/(^|[ \t])\/\/[^\n]*/gm, "$1")
      .replace(/\s+/g, " ");
  const TODAY_SRC = codeOf(readFileSync(new URL("../src/routes/Today.svelte", import.meta.url), "utf8"));

  test("render: a first render with the page's key (Today started `loaded` from the store) and a kept { slide: \"launchpad\" } draws the launchpad on that render", () => {
    const text = page({ recap: [{ repo: "app", text: "kept-briefing page", evidence: "a1b2c3d" }] });
    keepDeckState(briefingHash(text), "launchpad", 4, false);
    // What startingLatest gives on a matching latestMtime (today-store.check.ts): `loaded` with the kept file, so
    // briefingKey is non-null on the very first render — no `loading` frame, so no index-0 frame.
    const html = deckHtml({ latest: { state: "loaded", file: { path: "/state/briefing-latest.md", text, bytes: text.length } } });
    expect(html).toMatch(/class="track[^"]*" style="--i: 4;?"/);
    expect(html).toContain('aria-label="Slide 5 of 5: You\'re all set" aria-current="step"');
    expect(count(html, 'aria-current="step"')).toBe(1);
  });

  test("source: `latest` starts from startingLatest over the store's briefing and the snapshot's latestMtime, untracked", () => {
    expect(TODAY_SRC).toContain("let latest = $state<LatestLoad>(untrack(() => startingLatest(todayStore().briefing, latestMtime(snapshot))));");
    expect(TODAY_SRC).not.toContain('let latest = $state<LatestLoad>({ state: "loading" });');
    expect(TODAY_SRC).toContain('import { applyCalendarOff, briefingReads, calendarOn as storeCalendarOn, liveReadSent, onTodayStore, readStatusThroughStore, startingLatest, todayStore } from "../lib/today-store";');
  });

  test("source: load() reads through the mount's briefingReads (which keeps what it read, null for no file, and drops it on an error — today-store.check.ts), for the mtime current at the call", () => {
    expect(TODAY_SRC).toContain("const reads = briefingReads(readLatestBriefing, describeFailure, briefingHash);");
    expect(TODAY_SRC).toContain("async function load(): Promise<void> { const next = await reads.load(readForMtime); if (next !== null) latest = next; }");
    expect(TODAY_SRC.match(/briefingReads\(/g)).toHaveLength(1);
    expect(TODAY_SRC).not.toMatch(/\bseq\b/);
    expect(TODAY_SRC).not.toContain("keepBriefing(");
  });

  test("source (checkpoint MED): a read still pending when Today unmounts is invalidated — its own onMount, after every existing one", () => {
    expect(TODAY_SRC).toContain("onMount(() => () => reads.dispose());");
    expect(TODAY_SRC.match(/reads\.dispose\(\)/g)).toHaveLength(1);
    const cleanup = TODAY_SRC.indexOf("onMount(() => () => reads.dispose());");
    for (const earlier of [
      "onMount(() => { prefs = appPrefs();",
      "onMount(() => { mounted = true;",
      "onMount(() => () => git.dispose());",
      "onMount(() => () => cal.dispose());",
    ]) {
      expect({ earlier, found: TODAY_SRC.indexOf(earlier) > -1 }).toEqual({ earlier, found: true });
      expect({ earlier, after: cleanup > TODAY_SRC.indexOf(earlier) }).toEqual({ earlier, after: true });
    }
    // The key the store keeps is the deck's own key for that text.
    expect(TODAY_SRC).toContain('const briefingKey = $derived(latest.state === "loaded" ? briefingHash(latest.file.text) : null);');
  });
});

/* ── final review round 1 (PR A): the fixes' renders and pins ─────────────────────────────────── */

/**
 * Runs `body` with the process's zone set to `tz`, then restores it (`deck.check.ts`'s `inZone`, the same
 * restore: the zone in effect, THEN the saved value).
 */
function inZone(tz: string, offsetAtNoon: number, body: () => void): void {
  const saved = process.env.TZ;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = tz;
  try {
    expect(new Date(Date.UTC(2026, 9, 16, 12)).getTimezoneOffset()).toBe(offsetAtNoon);   // PREMISE: the zone took effect
    body();
  } finally {
    process.env.TZ = zone;
    process.env.TZ = saved;
  }
}

/** A Svelte attribute's `{…}` expression starting at `at` (the `{`), braces matched. */
function braced(src: string, at: number): string {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at + 1, i);
  }
  throw new Error("unbalanced braces");
}
/** The `onclick` (or another attribute's) expression of the ONE tag in `src` that `marker` identifies, evaluated
 *  with `scope` as its free names: the handler the control really has, as written. */
function handlerOf(src: string, marker: string, scope: Record<string, unknown>, attr = "onclick"): unknown {
  expect({ marker, n: count(src, marker) }).toEqual({ marker, n: 1 });
  const at = src.indexOf(marker);
  const open = src.lastIndexOf("<", at);
  const close = src.indexOf(">", at) + 1;
  const tagStart = src.slice(open, close).includes(`${attr}={`) ? open : at;
  const a = src.indexOf(`${attr}={`, tagStart);
  expect(a).toBeGreaterThan(-1);
  const expr = braced(src, a + attr.length + 1);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...Object.keys(scope), `return (${expr});`)(...Object.values(scope));
}

describe("final review round 1: what each deck control SENDS (M4), the slide kept (M5), focus on a changed briefing (M2)", () => {
  const DIR = new URL("../src/lib/deck/", import.meta.url);
  const src = (name: string): string => readFileSync(new URL(name, DIR), "utf8");
  const flat = (s: string): string => s.replace(/\s+/g, " ");

  test("M4: the arrows and the dots send previous, next and a jump to THEIR slide; each action, through the reducer, lands where the control says", () => {
    const deck = src("Deck.svelte");
    const sent: DeckAction[] = [];
    const scope = { ondispatch: (a: DeckAction) => sent.push(a) };
    (handlerOf(deck, 'aria-label="Previous slide"', scope) as () => void)();
    (handlerOf(deck, 'aria-label="Next slide"', scope) as () => void)();
    // A dot: its handler sees its own `i` (the `{#each … i}` it is drawn in): try every slide of a five-slide deck.
    const dotTag = deck.slice(deck.lastIndexOf("<button", deck.indexOf('class="ctl dot"')), deck.indexOf("></button>", deck.indexOf('class="ctl dot"')));
    expect(deck.slice(deck.lastIndexOf("{#each", deck.indexOf('class="ctl dot"')), deck.indexOf('class="ctl dot"'))).toMatch(/^\{#each view\.slides as id, i \(id\)\}/);
    for (const i of [0, 1, 2, 3, 4]) (handlerOf(dotTag, "onclick={", { ...scope, i, id: "x" }) as () => void)();
    expect(sent).toEqual([
      { type: "previous" },
      { type: "next" },
      { type: "jump", index: 0 },
      { type: "jump", index: 1 },
      { type: "jump", index: 2 },
      { type: "jump", index: 3 },
      { type: "jump", index: 4 },
    ]);
    const at2 = { index: 2, count: 5, open: [] };
    expect(sent.map((a) => deckReducer(at2, a).index)).toEqual([1, 3, 0, 1, 2, 3, 4]);
    // The disabled ends are the reducer's own bounds.
    expect(flat(deck)).toContain('aria-label="Previous slide" disabled={nav.index === 0}');
    expect(flat(deck)).toContain('aria-label="Next slide" disabled={nav.index === count - 1}');
  });

  test("M4: Full briefing opens the classic view and Back to slides closes it; Past briefings is History's route, never Full briefing's", () => {
    const shell = src("DeckOrClassic.svelte");
    const shown: boolean[] = [];
    const showClassic = (on: boolean) => shown.push(on);
    (handlerOf(shell, ">Back to slides</ActionButton>", { showClassic }) as () => void)();
    (handlerOf(shell, "onfull={", { showClassic }, "onfull") as () => void)();
    expect(shown).toEqual([false, true]);
    expect(count(shell, "showClassic(")).toBe(3);   // the function, and the two controls
    const pad = src("Launchpad.svelte");
    const onfull = () => "full";
    const onhistory = () => "history";
    expect((handlerOf(pad, ">Full briefing</ActionButton>", { onfull, onhistory }) as () => string)()).toBe("full");
    expect((handlerOf(pad, ">Past briefings</ActionButton>", { onfull, onhistory }) as () => string)()).toBe("history");
    // …and Deck hands the launchpad the props it was given, by name.
    // B1-M6-T18 and C-M5-T14 add the git view and C's live view, B1's prop first on the shared line (plan §1.4).
    expect(src("Deck.svelte")).toContain("<Launchpad {page} {now} {git} {actions} {live} {calendarDay} active={armed && i === nav.index} {onfull} {onhistory} />");
    expect(shell).toMatch(/\n {4}ondispatch=\{dispatch\}\n {4}onfull=\{\(\) => showClassic\(true\)\}\n {4}\{onhistory\}\n/);
  });

  test("M4: Open all opens EVERY card, Close all closes them, and a card's button toggles THAT card (a second press closes it)", () => {
    const w = src("WhatYouDid.svelte");
    const sent: DeckAction[] = [];
    const ondispatch = (a: DeckAction) => sent.push(a);
    const cards = { cards: [{ key: "app" }, { key: "lib" }, { key: "" }] };
    (handlerOf(w, ">Open all</ActionButton>", { ondispatch, w: cards }) as () => void)();
    (handlerOf(w, ">Close all</ActionButton>", { ondispatch, w: cards }) as () => void)();
    (handlerOf(w, 'class="ctl more"', { ondispatch, card: { key: "lib" } }) as () => void)();
    expect(sent).toEqual([{ type: "openAll", keys: ["app", "lib", ""] }, { type: "closeAll" }, { type: "toggle", key: "lib" }]);
    const closed = { index: 1, count: 5, open: [] as string[] };
    expect(deckReducer(closed, sent[0]!).open).toEqual(["app", "lib", ""]);
    expect(deckReducer(deckReducer(closed, sent[0]!), sent[1]!).open).toEqual([]);
    const once = deckReducer(closed, sent[2]!);
    expect(once.open).toEqual(["lib"]);
    expect(deckReducer(once, sent[2]!).open).toEqual([]);
  });

  test("L1: ← → do nothing while a modal dialog is open (the Quit dialog is aria-modal), wherever focus is; the guard comes before either key's action", () => {
    const deck = src("Deck.svelte");
    const fn = deck.slice(deck.indexOf("function onkeydown(e: KeyboardEvent): void {"), deck.indexOf('if (e.key === "ArrowLeft")'));
    expect(fn).toContain(`    if (document.querySelector('[aria-modal="true"]') !== null) return;\n`);
    // PREMISE: the Quit dialog is the modal it means.
    const quit = readFileSync(new URL("../src/lib/QuitDialog.svelte", import.meta.url), "utf8");
    expect(quit).toContain('role="dialog" aria-modal="true"');
  });
});

describe("final review round 1: the deck's controls on the approved mockup (M9, L10), the dots' names (L3), the focusable slide (L9)", () => {
  const DECK = readFileSync(new URL("../src/lib/deck/Deck.svelte", import.meta.url), "utf8");
  const STYLE = DECK.slice(DECK.indexOf("<style>"));
  const rule = (selector: string): string => {
    const m = new RegExp(`\\n  ${selector.replace(/[.[\]"():=]/g, "\\$&")} \\{([^}]*)\\}`).exec(STYLE);
    return (m?.[1] ?? "").replace(/\s+/g, " ").trim();
  };

  test("M9: the arrows are at the slide's left and right edges, vertically centred, 36px round, and HIDDEN (not just dimmed) at the first and last slide", () => {
    const html = deckHtml({ latest: loaded(RICH) });
    // In the viewport (over the slides), not in the dots' row.
    const viewport = html.slice(html.indexOf('<div class="viewport'), html.indexOf('<nav class="controls'));
    expect(viewport).toMatch(/<button type="button" class="ctl arrow prev[^"]*" aria-label="Previous slide" disabled/);
    expect(viewport).toMatch(/<button type="button" class="ctl arrow next[^"]*" aria-label="Next slide">/);
    const nav = html.slice(html.indexOf('<nav class="controls'), html.indexOf("</nav>"));
    expect(nav).not.toContain("arrow");
    expect(count(nav, 'class="ctl dot')).toBe(5);
    expect(rule(".arrow")).toMatch(/^position: absolute; top: 50%; z-index: 1; transform: translateY\(-50%\);[^]*width: 36px; height: 36px;[^]*border-radius: 50%;/);
    expect(rule(".prev")).toBe("left: 0.3rem;");
    expect(rule(".next")).toBe("right: 0.3rem;");
    expect(rule(".arrow:disabled")).toBe("opacity: 0; pointer-events: none;");
    // Each slide's side padding holds an arrow and its inset, so an arrow never covers the slide's text.
    // Each slide's side gutter holds an arrow and its inset, so an arrow never covers the slide's text. Round-2 L1: the
    // gutter is the scroller's MARGIN (outside it), so the scrollbar is never under the next arrow; each slide still
    // spans 100% of the track (width + both margins).
    expect(rule(".slide")).toContain("flex: 0 0 calc(100% - 2 * (36px + 0.6rem));");
    expect(rule(".slide")).toContain("margin: 0 calc(36px + 0.6rem);");
    expect(rule(".slide")).toContain("padding: 0.25rem;");
    expect(rule(".slide")).not.toMatch(/padding: [^;]*36px/);
    // The viewport is the arrows' positioned box.
    expect(rule(".viewport")).toContain("position: relative;");
  });

  test("M9 + L10: the dots stay in a row below, 8px with the current a 22px accent lozenge, each in a 24×24 hit area; tokens only, no raw colour", () => {
    expect(rule(".dot")).toMatch(/width: 24px; height: 24px;[^]*background: transparent;/);
    expect(rule(".dot::before")).toMatch(/^content: ""; width: 8px; height: 8px; border-radius: 4px; background: var\(--control\);/);
    expect(rule('.dot[aria-current="step"]::before')).toBe("width: 22px; background: var(--accent);");
    expect(STYLE).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.dot::before \{\s*transition: none;/);
    expect(STYLE).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    // Every control keeps its accessible name and the current dot its aria-current.
    const html = deckHtml({ latest: loaded(RICH) });
    expect(count(html, 'aria-current="step"')).toBe(1);
    expect([...html.matchAll(/class="ctl dot[^"]*" aria-label="([^"]*)"/g)].map((m) => m[1])).toEqual([
      "Slide 1 of 5: Good morning",
      "Slide 2 of 5: What you did",
      "Slide 3 of 5: Where you left off",
      "Slide 4 of 5: Suggested for today",
      "Slide 5 of 5: You&#39;re all set",
    ].map((n) => n.replace("&#39;", "'")));
  });

  test("L3: every dot is named by the heading its slide DRAWS — with a name, on an older page, with a calendar, today's and an older one", () => {
    const cal = { events: [], sources: [], incomplete: false };
    const cases: Opts[] = [
      { latest: loaded(RICH), firstName: "Sam" },
      { latest: loaded(page({ date: "2026-10-14", suggestions: [{ text: "x" }] })) },
      { latest: loaded(page({ calendar: cal } as Partial<EngineStruct>)) },
      { latest: loaded(page({ date: "2026-10-14", calendar: cal } as Partial<EngineStruct>)) },
    ];
    for (const o of cases) {
      const html = deckHtml(o);
      const drawn = headings(html);
      const dots = [...html.matchAll(/class="ctl dot[^"]*" aria-label="([^"]*)"/g)].map((m) => m[1]!.replace(/&#39;/g, "'"));
      expect(dots).toEqual(drawn.map((h, i) => `Slide ${i + 1} of ${drawn.length}: ${h.replace(/&#39;/g, "'")}`));
    }
    expect(headings(deckHtml(cases[1]!))).toContain("Suggested then");
    expect(headings(deckHtml(cases[3]!))).toContain("Calendar");
  });

  test("L9: the current slide is focusable — a named scrollable region, tabindex 0 — so ↓ and PageDown scroll it; nothing takes focus on the first render", () => {
    const html = deckHtml({ latest: loaded(RICH) });
    const slides = [...html.matchAll(/<div class="slide[^"]*"([^>]*)>/g)].map((m) => m[1]!);
    expect(slides.length).toBe(5);
    slides.forEach((attrs, i) => {
      expect({ i, attrs: /tabindex="0" role="region" aria-label="([^"]*)"/.exec(attrs)?.[1] }).toEqual({ i, attrs: `Slide ${i + 1} of 5` });
    });
    // Only the current one is reachable: the others are inert.
    expect(slides.filter((a) => a.includes("inert")).length).toBe(4);
    expect(html).not.toMatch(/autofocus/);
    expect(DECK).toMatch(/\.slide:focus-visible \{\s*outline: 2px solid var\(--accent\);\s*outline-offset: -2px;/);
  });
});

describe("final review round 1: the rows and texts a test never drew (M3, M6, L2, L6, W03, W04, G01, G04)", () => {
  const gmOf = (html: string): string => {
    const a = html.indexOf('<div class="slide');
    return html.slice(a, html.indexOf('<div class="slide', a + 1));
  };

  test("M3: a meeting that began BEFORE today draws the page's own words, never \"00:00\" — Good morning's glance tile and the launchpad's tile (America/Los_Angeles)", () => {
    inZone("America/Los_Angeles", 420, () => {
      const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
      const ev = (startMs: number, endMs: number, title: string) => ({ time: { kind: "timed", startMs, endMs }, title, status: "confirmed", transparency: "busy", attendeeCount: 1 });
      for (const [start, words] of [
        [at(15, 22, 0), "since yesterday"],
        [at(13, 9, 0), "since Oct 13"],
      ] as const) {
        const text = page({ calendar: { events: [ev(start, at(16, 10, 0), "Night shift")], sources: [{ id: "macos", kind: "macos", status: "ok" }], incomplete: false } } as Partial<EngineStruct>);
        expect(text).toContain(`   ◦ ${words} → 10:00  Night shift`);   // PREMISE: the engine's own words
        const html = normalise(deckHtml({ latest: loaded(text), now: at(16, 8, 30) }));
        expect(html).toMatch(new RegExp(`<p class="tile-text[^"]*">${words} · Night shift</p>`));
        expect(html).toMatch(new RegExp(`<p class="time caps[^"]*">${words}</p>`));
        expect(html).toMatch(/<p class="label[^"]*">\s*<span class="pulse[^"]*"><\/span>Now/);   // it IS running (the instant kept)
        expect(html).not.toContain("00:00");
      }
      // Today's start keeps its HH:MM.
      const today = page({ calendar: { events: [ev(at(16, 9, 0), at(16, 9, 30), "Standup")], sources: [{ id: "macos", kind: "macos", status: "ok" }], incomplete: false } } as Partial<EngineStruct>);
      expect(normalise(deckHtml({ latest: loaded(today), now: at(16, 8, 50) }))).toMatch(/<p class="time caps[^"]*">09:00<\/p>/);
    });
  });

  test("M6: the calendar slide DRAWS every row as the page has it — a timed event, an all-day one, a \"time unclear\" one and the \"+N more\" line (engine-rendered)", () => {
    const at = (h: number, m: number) => new Date(2026, 9, 16, h, m).getTime();
    const base = { status: "confirmed", transparency: "busy", attendeeCount: 1 };
    const events = [
      { ...base, time: { kind: "timed", startMs: at(9, 0), endMs: at(9, 30) }, title: "Standup" },
      { ...base, time: { kind: "allDay", startDate: "2026-10-16", endDateExclusive: "2026-10-17" }, title: "Company offsite" },
      { ...base, time: { kind: "unclear", startDate: "2026-10-16", endDate: "2026-10-16", wallStart: "11:00", wallEnd: "12:00", tzid: "Mars/Base" }, title: "Vendor call" },
      ...Array.from({ length: 58 }, (_, n) => ({ ...base, time: { kind: "timed", startMs: at(13, n % 60), endMs: at(13, n % 60) }, title: `Filler ${n + 1}` })),
    ];
    const text = page({ calendar: { events, sources: [{ id: "macos", kind: "macos", status: "ok" }], incomplete: false } } as Partial<EngineStruct>);
    const pageRows = text.split("\n").filter((l) => l.startsWith("   ◦ ")).map((l) => l.slice("   ◦ ".length));
    expect(pageRows.slice(0, 3)).toEqual(["09:00–09:30  Standup", "all day — Company offsite", "time unclear (11:00–12:00 Mars/Base)  Vendor call"]);   // PREMISE
    expect(pageRows.at(-1)).toBe("+1 more");
    const html = deckHtml({ latest: loaded(text) });
    const slide = html.slice(html.indexOf("Today&#39;s calendar") > -1 ? html.indexOf("Today&#39;s calendar") : html.indexOf("Today's calendar"));
    const drawn = [...slide.slice(0, slide.indexOf("</ul>")).matchAll(/<li class="(event|status|more)[^"]*">([^<]*)<\/li>/g)].map((m) => [m[1], m[2]]);
    expect(drawn).toEqual(pageRows.map((r) => [r === "+1 more" ? "more" : "event", r]));
    expect(drawn.length).toBe(61);
  });

  test("L2: projects whose lines carry no SHA never read \"0 commits\" — the subtitle and Your recent work leave the commits out (the engine's \"one commit, a why with no recap home\" page)", () => {
    const one = RENDER_CORPUS.find((c) => c.name === "one commit, a why with no recap home, legend at the cap")!;
    const text = renderBriefing(one.struct);
    expect(text).toContain("[other] one thing");   // PREMISE: one bullet, no evidence
    const html = normalise(deckHtml({ latest: loaded(text), today: one.struct.date }));
    expect(html).not.toContain("0 commits");
    expect(html).toContain("Your recent work:</strong> 1 project · 0 PRs merged");
    expect(html).toContain('<p class="subtitle');
    expect(html).toMatch(/class="subtitle[^"]*">1 project · 0 PRs merged</);
  });

  test("L6: a title whose date is not a real day (month 13, day 00) is the classic view with the note — never \"from undefined 5 undefined\"", () => {
    for (const bad of ["2026-13-05", "2026-10-00", "2026-02-30"]) {
      const text = page({ date: "2026-10-14" }).replace("briefing — 2026-10-14", `briefing — ${bad}`);
      expect(text).toContain(`briefing — ${bad}`);   // PREMISE
      const html = deckHtml({ latest: loaded(text) });
      expect({ bad, note: html.includes(NOTE), undef: html.includes("undefined") }).toEqual({ bad, note: true, undef: false });
    }
  });

  test("W03: an older page's Today-so-far lines are drawn under \"Later that day\", never \"Today so far\"", () => {
    const text = page({ date: "2026-10-14", recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }], today: [{ repo: "app", text: "wip: notes  (b2c3d4e)" }] });
    expect(text).toContain("▶ Today so far");   // PREMISE: the page's own heading
    const html = normalise(deckHtml({ latest: loaded(text) }));
    expect(html).toMatch(/<p class="caps later[^"]*">Later that day<\/p>/);
    expect(html).not.toContain(">Today so far<");
    expect(html).toContain("wip: notes");
    // Today's page says "Today so far".
    expect(normalise(deckHtml({ latest: loaded(page({ recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }], today: [{ repo: "app", text: "wip  (b2c3d4e)" }] })) }))).toMatch(
      /<p class="caps later[^"]*">Today so far<\/p>/,
    );
  });

  test("W04: an `X of Y` page draws its \"(+N more)\" remainder in the subtitle's disclosure", () => {
    const text = page({
      recap: [{ repo: "app", text: "shipped the importer", evidence: "a1b2c3d" }],
      recapCoverage: { shown: 1, total: 4, notShown: [{ label: "app", sha: "d4e5f6a", subject: "tidy" }] },
    } as Partial<EngineStruct>);
    expect(text).toContain("(+2 more)");   // PREMISE
    const html = normalise(deckHtml({ latest: loaded(text) }));
    const sub = html.slice(html.indexOf('<details class="subtitle'), html.indexOf("</details>"));
    expect(sub).toMatch(/<summary[^>]*>1 project · 4 commits · 0 PRs merged<\/summary>/);
    expect(sub).toMatch(/<p[^>]*>⚠ 3 in-window commit\(s\) NOT shown above:<\/p>/);
    expect(sub).toMatch(/<p[^>]*>\(\+2 more\)<\/p>/);
  });

  test("G01/G04: a long banner and a long first suggestion are drawn WHOLE on Good morning", () => {
    const banner = `schedule status timed out ${"and then some more words ".repeat(12)}end-of-banner`;
    const suggestion = `review the parser fix ${"carefully and then again ".repeat(8)}end-of-suggestion`;
    const gm = normalise(gmOf(deckHtml({ latest: loaded(page({ suggestions: [{ text: suggestion }] })), snap: snapshot({ error: banner }) })));
    expect(gm).toContain(`>${banner.replace(/\s+/g, " ")}</p>`);
    expect(gm).toMatch(new RegExp(`<p class="tile-text[^"]*">${suggestion.replace(/\s+/g, " ")}</p>`));
  });
});

/* ── final review round 2 (PR A) ──────────────────────────────────────────────────────────────── */

describe("final review round 2: the glance tile's heading (M1), focus into the classic view (L2), the stale launchpad (L5), the gutter (L1)", () => {
  const DIR = new URL("../src/lib/deck/", import.meta.url);
  const src = (name: string): string => readFileSync(new URL(name, DIR), "utf8");
  const at = (h: number, m: number) => new Date(2026, 9, 16, h, m).getTime();
  const standup = { time: { kind: "timed", startMs: at(9, 0), endMs: at(9, 30) }, title: "Standup", status: "confirmed", transparency: "busy", attendeeCount: 2 };
  const withCal = page({ calendar: { events: [standup], sources: [{ id: "macos", kind: "macos", status: "ok" }], incomplete: false } } as Partial<EngineStruct>);
  const gmTile = (html: string): string => {
    const a = html.indexOf('<div class="slide');
    const gm = html.slice(a, html.indexOf('<div class="slide', a + 1));
    return /<p class="caps[^"]*">(Now|Next meeting)<\/p> <p class="tile-text[^"]*">([^<]*)<\/p>/.exec(normalise(gm))?.slice(1).join(" | ") ?? "";
  };

  test("M1: Good morning's glance tile is headed \"Next meeting\" before the meeting and \"Now\" while it runs — the same event, its own start", () => {
    expect(gmTile(deckHtml({ latest: loaded(withCal), now: at(8, 30) }))).toBe("Next meeting | 09:00 · Standup");
    expect(gmTile(deckHtml({ latest: loaded(withCal), now: at(9, 10) }))).toBe("Now | 09:00 · Standup");
    expect(gmTile(deckHtml({ latest: loaded(withCal), now: at(9, 30) }))).toBe("");   // over: no tile
    expect(src("GoodMorning.svelte")).toContain('<p class="caps">{meeting.heading}</p>');
    expect(src("GoodMorning.svelte")).not.toContain(">Next meeting<");
  });

  test("L5: an OLDER page's launchpad draws no mood line (a claim about now); today's page draws it, with the calendar off too", () => {
    const stale = normalise(deckHtml({ latest: loaded(page({ date: "2026-10-14" })) }));
    const pad = stale.slice(stale.indexOf("You're all set"));
    expect(stale.indexOf("You're all set")).toBeGreaterThanOrEqual(0);   // round-3 L8: the launchpad IS drawn
    expect(pad).not.toContain('class="mood');
    expect(stale).not.toContain("Nothing needs you right now.");
    const staleCal = normalise(deckHtml({ latest: loaded(page({ date: "2026-10-14", calendar: { events: [], sources: [], incomplete: false } } as Partial<EngineStruct>)) }));
    expect(staleCal).not.toContain('class="mood');
    expect(normalise(deckHtml({ latest: loaded(page()) }))).toMatch(/<p class="mood[^"]*">Nothing needs you right now\.<\/p>/);
  });

  test("L1 + L4: the gutter is the scroller's margin (its scrollbar is never under an arrow); the header names the slide region by its place", () => {
    const deck = src("Deck.svelte");
    const header = deck.slice(0, deck.indexOf("import "));
    expect(header).not.toContain("named by its heading),");
    expect(header).toContain('a region named by its place,\n   * "Slide 2 of 5"');
  });
});

/* ── final review round 3 (PR A) ──────────────────────────────────────────────────────────────── */

describe("final review round 3: a run stays on Good morning (M2), the deck fits what is left (L4)", () => {
  const DIR = new URL("../src/lib/deck/", import.meta.url);
  const src = (name: string): string => readFileSync(new URL(name, DIR), "utf8");

  test("L4: while the deck is drawn, App's main is a full-height flex column and the screen takes what is left; other screens flow as before", () => {
    const app = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8");
    const style = app.slice(app.indexOf("<style>"));
    expect(style).toMatch(/\n  main:has\(:global\(\.deck\)\) \{\s*height: 100vh;\s*display: flex;\s*flex-direction: column;\s*\}/);
    expect(style).toMatch(/\n  main:has\(:global\(\.deck\)\) > \.screen \{\s*flex: 1 1 auto;\s*min-height: 0;\s*display: flex;\s*flex-direction: column;\s*\}/);
    // The plain rules are untouched: no screen is a flex column unless the deck is in it.
    expect(style).toMatch(/\n  main \{\s*max-width: 48rem;\s*margin: 0 auto;\s*padding: 2rem 1\.5rem 3rem;\s*\}/);
    expect(style).toMatch(/\n  \.screen \{\s*margin-top: 1\.75rem;\s*\}/);
    // Round-3 L7: the arrows' comment says where the gutter is now (the slide's margin, round-2 L1).
    expect(src("Deck.svelte")).toContain("/* The mockup's .chev: 36px round, over the viewport (in the gutter, the slide's margin), vertically centred.");
    expect(src("Deck.svelte")).not.toContain("the slide's padding is its gutter");
    // …and the deck is a DIRECT flex item of the screen: Today and DeckOrClassic add no box around it.
    expect(src("DeckOrClassic.svelte")).toMatch(/\.views \{\s*display: contents;\s*\}/);
    const today = readFileSync(new URL("../src/routes/Today.svelte", import.meta.url), "utf8");
    expect(today.slice(today.indexOf("</script>") + "</script>".length).replace(/<!--[\s\S]*?-->/g, "").trim().split("\n").filter((l) => l.trim().startsWith("<")).map((l) => l.trim().split(" ")[0])).toEqual(["<svelte:window", "<CalendarQuestion", "<DeckOrClassic", "<LiveRegion"]);
  });
});

/* ── final review round 4 (PR A): ONE focus state, ONE run rule — short pins, one per path ────────── */

describe("final review round 4: the focus state and the run rule, by path (M1, M4, L2, L5, L6)", () => {
  const DIR = new URL("../src/lib/deck/", import.meta.url);
  const code = (name: string): string =>
    readFileSync(new URL(name, DIR), "utf8")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s+/g, " ");
  const SHELL = code("DeckOrClassic.svelte");
  const DECK = code("Deck.svelte");

  test("M4: ONE focus state — `landing` — read by every target; no other focus flag is left", () => {
    expect(SHELL).toContain("let landing = $state<FocusLanding>(null);");
    for (const gone of ["moved", "enteredFull", "landOnClassic"]) expect({ gone, left: new RegExp(`\\b${gone}\\b`).test(SHELL) }).toEqual({ gone, left: false });
    // The targets: the current slide's heading, and the classic view's heading and note.
    expect(DECK).toContain('const armed = $derived(landing === "slideHeading");');
    expect(DECK.match(/active=\{armed && i === nav\.index\}/g)).toHaveLength(6);
    expect(SHELL.match(/use:focusHeading=\{landing === "classicView"\}/g)).toHaveLength(2);
  });

  test("path — a move: landing on the slide heading, and the glide turned on (L5); a card's toggle changes neither", () => {
    // Wave 2, W2-S-T1: `onmove`'s rule reads the OLD index, so it sits between the block and `nav = next;`; the
    // emit follows `keep();` (live-current.check.ts pins the whole body).
    expect(SHELL).toContain(
      'if (next.index !== nav.index) { landing = "slideHeading"; glide = true; quiet = null; } const m = moves.dispatched(nav.index, next.index, deck.kind === "slides" ? deck.slides : []); nav = next; keep(); if (m !== null) onmove?.(m.slide, m.from);',
    );
  });

  test("path — Full briefing and Back to slides: the classic heading on the way in, the slide heading on the way out", () => {
    // Wave 2, W2-S-T1: Back to slides (`!on`) is one of `onmove`'s three sites, after `keep();`.
    expect(SHELL).toContain(
      'function showClassic(on: boolean): void { classic = on; landing = on ? "classicView" : "slideHeading"; keep(); if (!on) { const m = moves.backToSlides(currentSlide({ slides, deck, classic, index: nav.index })); if (m !== null) onmove?.(m.slide, m.from); } }',
    );
  });

  test("path — a key change: focus read BEFORE (a pre-effect), then afterChange(from, wasInside, onIndexChange: true)", () => {
    expect(SHELL.indexOf("const r = listChange(")).toBeGreaterThan(SHELL.indexOf("if (key !== shownKey) {"));
    const effect = SHELL.slice(SHELL.indexOf("if (key !== shownKey) {"), SHELL.indexOf("const r = listChange("));
    expect(effect.indexOf("const wasInside = focusInside();")).toBeLessThan(effect.indexOf("nav = "));
    expect(effect).toContain("afterChange(from, wasInside, true);");
    // afterChange: nowhere first; then, only if focus was inside, focusLanding decides once the change is drawn.
    expect(SHELL).toContain("landing = null; const mine = ++change; if (!wasInside) return;");
    expect(SHELL).toContain("landing = focusLanding({ deckDrawn: deck.kind !== \"classic\" && !classic, from, to: nav.index, lost: focusLost(), onIndexChange });");
  });

  test("path — the run rule (M1, post-cap L3): runJumpNow decides; then ALWAYS Good morning, kept, and afterChange (no early return)", () => {
    const rule = SHELL.slice(SHELL.indexOf("const jump = runJumpNow("), SHELL.indexOf("function keep(): void"));
    expect(rule).toContain("const jump = runJumpNow(running, briefingKey !== null); if (!jump) return;");
    expect(rule).toContain("const from = nav.index; const wasInside = focusInside(); nav = { ...nav, index: 0 }; keep(); afterChange(from, wasInside, false);");
    // Post-cap L3: Good morning already current still goes through afterChange (Run now turns disabled; focus lands).
    expect(rule).not.toMatch(/nav\.index === 0\) return/);
    // M1: no hold — dispatch never looks at `running`, and the nav never starts from it.
    const dispatchFn = SHELL.slice(SHELL.indexOf("function dispatch("), SHELL.indexOf("function showClassic("));
    expect(dispatchFn).not.toContain("running");
    expect(SHELL).not.toContain("running ? 0");
    const script = SHELL.slice(SHELL.indexOf("}: Props = $props();"), SHELL.indexOf("</script>"));
    expect(script.match(/\brunning\b/g)).toHaveLength(1);
    expect(SHELL.indexOf("const jump = runJumpNow(")).toBeGreaterThan(SHELL.indexOf("if (key !== shownKey) {"));
    // Post-cap L2: each run is numbered by App as it starts.
    const app = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(app).toMatch(/running = true; (?:\/\/[^;]*?)?noteRunStart\(\);/);
    expect(app.match(/noteRunStart\(\)/g)).toHaveLength(1);
  });

  test("L2 / post-cap L6: focusLost IS the pure focusIsLost (deck-state.ts, tested there) over the page's active element", () => {
    expect(SHELL).toContain("function focusLost(): boolean { return focusIsLost(document.activeElement, document.body); }");
  });

  test("L6: a slide that becomes current is scrolled to its top (never on the first render)", () => {
    expect(DECK).toContain("let shownIndex = untrack(() => nav.index);");
    // PB-M1-T3: L6 also tracks the shown slide's id. The decision is taken from the OLD pair, the pair is updated
    // before any return, and only a same-id remap skips the reset (a removal at the same index still resets).
    expect(DECK).toContain("let shownId = untrack(() => view.slides[nav.index]);");
    expect(DECK).toContain(
      "const i = nav.index; const id = view.slides[i]; const reset = scrollResets({ index: shownIndex, id: shownId }, { index: i, id }); shownIndex = i; shownId = id; if (!reset) return; const el = untrack(() => slideEls[i]); if (el !== undefined) el.scrollTop = 0;",
    );
    expect(DECK).toContain('import { moreBelow, scrollResets, type FocusLanding } from "../deck-state";');
  });

  test("L8: a card's disclosure says its count through cardCountLabel (deck.ts), the one plural rule, not a copy of it", () => {
    const w = code("WhatYouDid.svelte");
    expect(w).toContain('{card.commits > 0 ? `${cardCountLabel(card)} ›` : "Details ›"}');
    expect(w).not.toMatch(/"1 commit"|commits`/);
    const html = normalise(deckHtml({ latest: loaded(RICH) }));
    expect(html).toContain("2 commits ›");
    expect(html).toContain("1 commit ›");
  });

  test("L5: rendered, the track has NO glide before a move (a restored slide appears at once)", () => {
    const text = page({ recap: [{ repo: "app", text: "glide page", evidence: "a1b2c3d" }] });
    keepDeckState(briefingHash(text), "leftOff", 2, false);
    const html = deckHtml({ latest: loaded(text) });
    expect(html).toMatch(/<div class="track[^"]*" style="--i: 2;?"/);
    expect(html).not.toMatch(/class="track[^"]*\bglide\b/);
  });
});

/* ── B1-M6: the live git detail on screen (plan B1-M6-T17, T18), rendered from b1-states.ts's seeded states ── */

/** The deck for `text` with Today's live git input, as Today builds it (`deckView({ …, gitDetail })`). */
function gitDeck(text: string, gitDetail: GitDetailInput) {
  const model = modelOf({ latest: loaded(text) });
  const deck = deckView({ model, today: TODAY, firstName: null, gitDetail });
  if (deck.kind !== "slides") throw new Error(`expected slides, got ${deck.kind}`);
  return { model, deck };
}
/** DeckOrClassic for `text` and `gitDetail`, at `now` (the launchpad's clock). */
function gitHtml(text: string, gitDetail: GitDetailInput, now = B1_NOW): string {
  const { model, deck } = gitDeck(text, gitDetail);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return normalise(render(DeckOrClassic as any, { props: { model, deck, now, briefingKey: briefingHash(text), slides: true, ...RUN, onhistory: () => {} } }).body);
}
/** What you did alone, with `open` cards (a server render runs no click, so an open card is a prop here). */
function whatHtml(text: string, gitDetail: GitDetailInput | null, open: string[] = []): string {
  const { deck } = gitDeck(text, gitDetail ?? gitInput(null));
  const git = gitDetail === null ? null : deck.git;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return normalise(render(WhatYouDid as any, { props: { page: deck.page, open, active: false, ondispatch: () => {}, git } }).body);
}
/** The text between a marker and the end of its card (the next `</article>`). */
const cardOf = (html: string, name: string): string => {
  // The card head's pill (it passes `wrap`; the pill row's jump buttons do not).
  const at0 = html.indexOf(`wrap" title="${name}">${name}</span>`);
  expect(at0).toBeGreaterThan(-1);
  return html.slice(at0, html.indexOf("</article>", at0));
};
const B1 = b1States();
const B1_WIN = b1States("windows");
const rowsOf = (html: string): string[] => [...html.matchAll(/<details class="row[^"]*">([\s\S]*?)<\/details>/g)].map((m) => m[1]!);

describe("B1-M6-T17: What you did — the heading, the subtitle and the rows", () => {
  test("a Today-so-far-only card discloses hidden live rows with a nonblank label", () => {
    const text = page({ today: [{ repo: "app", text: "today work (b2c3d4e)" }], recapCoverage: { shown: 0, total: 2, notShown: [] } });
    const rows = [{ kind: "orphan" as const, commits: [
      { sha: "e".repeat(40), token: null, subject: "hidden first" },
      { sha: "f".repeat(40), token: null, subject: "hidden second" },
    ] }];
    const detail = gitInput(held(all({ labels: [gitLabel("app", "app", rows)], hidden: { complete: true, perLabel: { app: 2 } } })));
    const { deck } = gitDeck(text, detail);
    expect(deck.page.whatYouDid.cards[0]!.lines).toEqual([]);
    expect(deck.page.whatYouDid.cards[0]!.mergedRow).toBeNull();
    expect(deck.git!.remainder.more).toBeNull();
    const html = whatHtml(text, detail, ["app"]);
    expect(cardOf(html, "app")).toMatch(/aria-expanded="true"[^>]*>Details ›<\/button>/);
    expect(rowsOf(html)).toHaveLength(1);
    expect(html).toContain("hidden first");
    expect(html).toContain("hidden second");
    expect(html).not.toContain("(+2 more)");
  });
  test("the heading is the window title: Yesterday, Since {weekday}, Since {weekday} {day} {month}, and the year when it is not this one", () => {
    const titled = (start: string): string => {
      const r = all({ ...(richReply() as ReposAllReply), record: { accepted: true, windowStartUtc: start }, windowStartUtc: start });
      return headings(gitHtml(B1_PAGE, gitInput(held(r))))[1]!;
    };
    expect(titled(at(0, 0, 15))).toBe("Yesterday");
    expect(titled(at(0, 0, 14))).toBe("Since Wednesday");
    expect(titled(at(0, 0, 8))).toBe("Since Thursday 8 October");
    expect(titled(new Date(2025, 9, 8).toISOString())).toBe("Since Wednesday 8 October 2025");
  });

  test("\"What you did\" with no record, a record not accepted, before the detail, and on a quiet page", () => {
    expect(headings(gitHtml(B1_PAGE, B1.beforeTheDetail!.gitDetail))[1]).toBe("What you did");
    const notAccepted = all({ ...(richReply() as ReposAllReply), record: { accepted: false, windowStartUtc: null } });
    expect(headings(gitHtml(B1_PAGE, gitInput(held(notAccepted))))[1]).toBe("What you did");
    const quiet = page({ recap: [] });
    const q = gitDeck(quiet, gitInput(held(richReply())));
    expect(q.deck.page.whatYouDid.quiet).toBe(true);   // PREMISE: the engine's quiet page
    expect(headings(gitHtml(quiet, gitInput(held(richReply()))))[1]).toBe("What you did");
  });

  test("the heading keeps its focus target, and the dot names the heading the slide draws (round-1 L3)", () => {
    const src = readFileSync(new URL("../src/lib/deck/WhatYouDid.svelte", import.meta.url), "utf8");
    expect(src).toContain('<h2 tabindex="-1" use:focusHeading={active}>{git?.title ?? "What you did"}</h2>');
    const html = gitHtml(B1_PAGE, B1.live!.gitDetail);
    const drawn = headings(html);
    const dots = [...html.matchAll(/class="ctl dot[^"]*" aria-label="([^"]*)"/g)].map((m) => m[1]!.replace(/&#39;/g, "'"));
    expect(drawn[1]).toBe("Yesterday");
    expect(dots).toEqual(drawn.map((h, i) => `Slide ${i + 1} of ${drawn.length}: ${h.replace(/&#39;/g, "'")}`));
  });

  test("the subtitle carries the LIVE PR count once the detail arrives, the page's before — in the plain <p> and in the <summary>", () => {
    // A PR row the page's 🔀 lines do not name (#13) counts once the detail arrives (the section rule).
    const withPr = (r: ReposAllReply): ReposAllReply => ({ ...r, labels: [{ ...r.labels[0]!, rows: [...r.labels[0]!.rows, { kind: "pr", number: 13, title: "Later PR", commits: [cited("c3d4e5f")] }] }, r.labels[1]!] });
    const live = gitInput(held(all(withPr(richReply() as ReposAllReply))));
    const before = whatHtml(B1_PAGE, gitInput(null));
    expect(before).toMatch(/<p class="subtitle[^"]*">2 projects · 5 commits · 1 PR merged<\/p>/);
    expect(whatHtml(B1_PAGE, live)).toMatch(/<p class="subtitle[^"]*">2 projects · 5 commits · 2 PRs merged<\/p>/);
    // With a remainder, the subtitle is the disclosure's <summary>: the live count there too.
    const covered = page({
      recap: [{ repo: "app", text: "merged the importer", evidence: "a1b2c3d" }],
      windowMerges: [{ repo: "app", text: "🔀 Merged #12 (feat/importer) (Oct 15)  (a1b2c3d)" }],
      recapCoverage: { shown: 1, total: 4, notShown: [{ label: "app", sha: "d4e5f6a", subject: "tidy" }] },
    } as Partial<EngineStruct>);
    expect(covered).toContain("(+2 more)");   // PREMISE
    const prRow = (n: number) => gitInput(held(all({ labels: [gitLabel("app", "app", [{ kind: "pr", number: n, title: "t", commits: [cited("a1b2c3d")] }])], repoViews: [gitRepo("app")] })));
    expect(whatHtml(covered, gitInput(null))).toMatch(/<summary[^>]*>1 project · 4 commits · 1 PR merged<\/summary>/);
    expect(whatHtml(covered, prRow(13))).toMatch(/<summary[^>]*>1 project · 4 commits · 2 PRs merged<\/summary>/);
    expect(whatHtml(covered, prRow(12))).toMatch(/<summary[^>]*>1 project · 4 commits · 1 PR merged<\/summary>/);
  });

  test("the remainder: \"(+N more)\" dropped when the hidden commits are complete and equal, kept otherwise; never an empty <details>", () => {
    const covered = page({
      recap: [{ repo: "app", text: "merged the importer", evidence: "a1b2c3d" }],
      recapCoverage: { shown: 1, total: 4, notShown: [{ label: "app", sha: "d4e5f6a", subject: "tidy" }] },
    } as Partial<EngineStruct>);
    const reply = (complete: boolean, n: number) => gitInput(held(all({ labels: [gitLabel("app", "app", [{ kind: "orphan", commits: [
      { sha: "e".repeat(40), token: null, subject: "hidden one" }, { sha: "f".repeat(40), token: null, subject: "hidden two" },
    ] }])], repoViews: [gitRepo("app")], hidden: { complete, perLabel: { app: n } } })));
    const kept = whatHtml(covered, reply(false, 2));
    const dropped = whatHtml(covered, reply(true, 2));
    expect(kept).toMatch(/<p[^>]*>\(\+2 more\)<\/p>/);
    expect(dropped).not.toContain("(+2 more)");
    expect(dropped).toMatch(/<details class="subtitle[^"]*"><summary[^>]*>[^<]*<\/summary> <p[^>]*>⚠ 3 in-window commit\(s\) NOT shown above:<\/p> ?<\/details>/);
    expect(whatHtml(covered, reply(true, 3))).toContain("(+2 more)");   // a count mismatch keeps it
    // The "(+N more)" line as the remainder's ONLY content: dropped, the slide falls back to the plain <p>.
    const { deck } = gitDeck(covered, reply(true, 2));
    const onlyMore = { ...deck.page, whatYouDid: { ...deck.page.whatYouDid, remainder: { ...deck.page.whatYouDid.remainder, header: null } } };
    const git = gitDetailView(onlyMore, reply(true, 2), TODAY);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const html = normalise(render(WhatYouDid as any, { props: { page: onlyMore, open: [], active: false, ondispatch: () => {}, git } }).body);
    expect(html).not.toContain("<details");
    expect(html).toMatch(/<p class="subtitle[^"]*">1 project · 4 commits · 0 PRs merged<\/p>/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const without = normalise(render(WhatYouDid as any, { props: { page: onlyMore, open: [], active: false, ondispatch: () => {}, git: null } }).body);
    expect(without).toMatch(/<details class="subtitle[^"]*"><summary[^>]*>1 project · 4 commits · 0 PRs merged<\/summary> <p[^>]*>\(\+2 more\)<\/p> ?<\/details>/);
  });

  test("the summary line REPLACES A's \"N commits ›\" as the card's disclosure and drives the reducer's open, as A's button does", () => {
    const html = whatHtml(B1_PAGE, B1.live!.gitDetail);
    const app = cardOf(html, "app");
    expect(app).toMatch(/<button type="button" class="ctl more[^"]*" aria-expanded="false">(<span[^>]*>[^<]*<\/span>)+ ›<\/button>/);
    const button = /<button type="button" class="ctl more[^>]*>([\s\S]*?)<\/button>/.exec(app)![1]!.replace(/<[^>]+>/g, "");
    expect(button).toBe("1 PR merged · 2 branches in progress · 1 on main · 4 only on this Mac ›");
    expect(app).not.toContain("4 commits ›");
    expect(app).toContain('<span class="caps');   // the count beside the pill stays
    const src = readFileSync(new URL("../src/lib/deck/WhatYouDid.svelte", import.meta.url), "utf8");
    expect(count(src, 'onclick={() => ondispatch({ type: "toggle", key: card.key })}')).toBe(1);
    expect(count(src, 'class="ctl more"')).toBe(1);
  });

  test("the summary's tails: \"no remote\" in grey, \"N not matched\" muted, and \"as of HH:MM\" when the answer is not current", () => {
    const nr = cardOf(whatHtml(B1_PAGE, B1.noRemote!.gitDetail), "app");
    expect(nr).toMatch(/<span class="part grey[^"]*">no remote<\/span>/);
    const nm = all({ ...(richReply() as ReposAllReply), labels: [gitLabel("app", "app", [], { notMatched: 2 }), (richReply() as ReposAllReply).labels[1]!] });
    expect(cardOf(whatHtml(B1_PAGE, gitInput(held(nm))), "app")).toMatch(/<span class="part muted[^"]*">2 not matched<\/span>/);
    const stale = whatHtml(B1_PAGE, B1.notCurrent!.gitDetail);
    expect(cardOf(stale, "app")).toMatch(/<span class="part muted[^"]*">as of 09:10<\/span> ›<\/button>/);
    expect(whatHtml(B1_PAGE, B1.live!.gitDetail)).not.toContain("as of");
  });

  test("a card whose summary has no parts (only tag, detached or \"no longer on a branch\" rows) uses A's \"N commits ›\" (orchestrator ruling 3)", () => {
    // A page with no 🔀 line, so the card rule counts no PR either.
    const text = page({ recap: [{ repo: "app", text: "tagged the release", evidence: "a1b2c3d" }, { repo: "app", text: "cut the notes", evidence: "b2c3d4e" }] });
    const r = all({ labels: [gitLabel("app", "app", [{ kind: "tag", name: "v1.0", commits: [cited("a1b2c3d"), cited("b2c3d4e")] }])], repoViews: [gitRepo("app")] });
    const app = cardOf(whatHtml(text, gitInput(held(r)), ["app"]), "app");
    expect(app).toMatch(/aria-expanded="true">2 commits ›<\/button>/);
    expect(rowsOf(app)).toHaveLength(1);   // the rows still replace the flat list
  });

  test("each row kind, in scheme 1's shapes: PR, branch, partly pushed, never pushed, the default row pushed and not, remote-only, tag, detached, orphan", () => {
    const rows = [
      { kind: "pr", number: 12, title: "Importer for the bank exports", commits: [cited("a1b2c3d")] },
      { kind: "branch", name: "research/m1-a", push: { state: "pushed", notPushed: 0 }, commits: [cited("b2c3d4e")] },
      { kind: "branch", name: "fix/parser", push: { state: "partly", notPushed: 3 }, commits: [cited("e5f6a7b")] },
      { kind: "branch", name: "spike/kelly", push: { state: "never", notPushed: 1 }, commits: [cited("b2c3d4e")] },
      { kind: "default", name: "main", push: { state: "partly", notPushed: 1 }, commits: [cited("c3d4e5f")] },
      { kind: "default", name: "trunk", push: { state: "never", notPushed: 2 }, commits: [cited("c3d4e5f"), cited("a1b2c3d")] },
      { kind: "remoteBranch", name: "origin/feat/gone", commits: [cited("e5f6a7b")] },
      { kind: "tag", name: "v1.0", commits: [cited("a1b2c3d")] },
      { kind: "detached", commits: [cited("a1b2c3d")] },
      { kind: "orphan", commits: [cited("a1b2c3d")] },
    ] as const;
    const r = all({ ...(richReply() as ReposAllReply), labels: [gitLabel("app", "app", rows as unknown as ReposAllReply["labels"][0]["rows"]), (richReply() as ReposAllReply).labels[1]!] });
    const shown = rowsOf(whatHtml(B1_PAGE, gitInput(held(r)), ["app"])).map((x) => /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(x)![1]!);
    const text = (h: string): string => h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const tag = (h: string): string => /<span class="tag (\w+)/.exec(h)![1]!;
    expect(shown.map((h) => [tag(h), text(h)])).toEqual([
      ["merged", "› PR #12 Importer for the bank exports · 1 commit"],
      ["branch", "› branch research/m1-a · 1 commit"],
      ["branch", "› branch fix/parser · 1 commit · 3 not pushed"],
      ["local", "› branch spike/kelly · 1 commit · never pushed only on this Mac"],
      ["main", "› main 1 commit · 1 not pushed"],
      ["local", "› trunk 2 commits · not pushed only on this Mac"],
      ["branch", "› branch origin/feat/gone · 1 commit"],
      ["main", "› tag v1.0 1 commit"],
      ["main", "› detached HEAD 1 commit"],
      ["main", "› no longer on a branch 1 commit"],
    ]);
    // The amber words are their own span; "only on this Mac" sits at the row's right, after the words.
    expect(shown[3]).toMatch(/<span class="amber[^"]*">never pushed<\/span><\/span> <span class="here[^"]*">only on this Mac<\/span>/);
    expect(shown[5]).toMatch(/<span class="tag local[^"]*" title="trunk">trunk<\/span> <span class="what[^"]*"><span class="count[^"]*">2 commits<\/span><span class="sep[^"]*"> · <\/span><span class="amber[^"]*">not pushed<\/span><\/span>/);
    // The name is drawn whole and wraps (polish §1): no hover `title`, the whole text in the span.
    expect(shown[0]).toMatch(/<span class="name[^"]*">Importer for the bank exports<\/span>/);
    expect(shown.join("")).not.toMatch(/<span class="name[^"]*" title=/);
  });

  test("polish §1: a 200-character PR title and a 120-character branch name with no spaces are drawn whole in their rows", () => {
    const title = "Importer for the bank exports and the ledger reconciliation ".repeat(4).slice(0, 200);
    const branch = "feat/" + "x".repeat(115);
    expect([[...title].length, [...branch].length, /\s/.test(branch)]).toEqual([200, 120, false]);   // PREMISE
    const rows = [
      { kind: "pr", number: 12, title, commits: [cited("a1b2c3d")] },
      { kind: "branch", name: branch, push: { state: "never", notPushed: 1 }, commits: [cited("b2c3d4e")] },
    ] as const;
    const r = all({ ...(richReply() as ReposAllReply), labels: [gitLabel("app", "app", rows as unknown as ReposAllReply["labels"][0]["rows"]), (richReply() as ReposAllReply).labels[1]!] });
    const shown = rowsOf(whatHtml(B1_PAGE, gitInput(held(r)), ["app"])).map((x) => /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(x)![1]!);
    expect(shown).toHaveLength(2);
    expect(shown[0]).toContain(`<span class="name svelte-`);
    expect(shown[0]).toMatch(new RegExp(`<span class="name[^"]*">${title}</span>`));
    expect(shown[1]).toMatch(new RegExp(`<span class="name[^"]*">${branch}</span>`));
    // The count and the push words follow the name, whole.
    expect(shown[1]).toMatch(new RegExp(`${branch}</span><span class="sep[^"]*"> · </span><span class="count[^"]*">1 commit</span>`));
    expect(shown[1]).toMatch(/<span class="amber[^"]*">never pushed<\/span>/);
  });

  test("polish §1 (CSS): a row's name wraps and breaks anywhere at all times; the tag, the count and the push words keep their width", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(new URL("../src/lib/deck/GitRows.svelte", import.meta.url), "utf8"))![1]!;
    const rule = (sel: string): string => {
      const m = new RegExp(`\\n {2}${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(style);
      expect({ sel, found: m !== null }).toEqual({ sel, found: true });
      return m![1]!;
    };
    const name = rule(".name");
    expect(name).toContain("overflow-wrap: anywhere;");
    expect(name).not.toMatch(/text-overflow|white-space|overflow:|max-width|display:/);
    // No other rule reaches the name (the old focus-only lift is gone: it wraps at all times).
    expect(style.match(/\.name\b/g)).toHaveLength(1);
    expect(style).not.toContain("text-overflow");
    expect(rule(".count,\n  .amber")).toContain("white-space: nowrap;");
    expect(rule("summary > :global(.tag)")).toContain("flex: none;");
    // B2: under a row with a button a commit's arrow is placed from the row, not from its disclosure, whose right edge ends
    // where that row's button starts. So every arrow in the list ends at the edge the row buttons share.
    expect(rule(".acted")).toContain("position: relative;");
    expect(rule(".acted .arrow")).toContain("position: absolute;");
    expect(rule(".acted .arrow")).toContain("right: 0;");
    expect(rule(".acted .commit")).toContain("padding-block: 1px;");
    // The name's holders never stop it wrapping: no nowrap and no clipping on the summary row or the `.what` text.
    for (const sel of ["summary", ".what"]) {
      const r = rule(sel);
      expect({ sel, nowrap: /white-space:\s*nowrap/.test(r), clipped: /overflow:\s*hidden/.test(r) }).toEqual({ sel, nowrap: false, clipped: false });
    }
  });

  test("polish §1: the three fixed-height elements still ellipsize — StatusTag's tag, the jump-row pill (no `wrap`), the calendar slide's one-line block", () => {
    const styleOf = (url: URL): string => /<style>([\s\S]*?)<\/style>/.exec(readFileSync(url, "utf8"))![1]!;
    const tag = styleOf(new URL("../src/lib/ui/StatusTag.svelte", import.meta.url));
    expect(/\n {2}\.tag \{([^}]*)\}/.exec(tag)?.[1] ?? "").toContain("text-overflow: ellipsis;");
    const pill = styleOf(new URL("../src/lib/ui/Pill.svelte", import.meta.url));
    expect(/\n {2}\.pill \{([^}]*)\}/.exec(pill)?.[1] ?? "").toContain("text-overflow: ellipsis;");
    // The jump row's pill is a Pill without `wrap`, so the ellipsis is its own.
    const what = readFileSync(new URL("../src/lib/deck/WhatYouDid.svelte", import.meta.url), "utf8");
    expect(what).toContain('<button type="button" class="ctl jump" onclick={() => jump(card.key, i)}><Pill palette={card.slot} label={card.label} /></button>');
    const calSrc = readFileSync(new URL("../src/lib/deck/CalendarSlide.svelte", import.meta.url), "utf8");
    const cal = styleOf(new URL("../src/lib/deck/CalendarSlide.svelte", import.meta.url));
    const one = /\n {2}\.block\.one \{([^}]*)\}/.exec(cal)?.[1] ?? "";
    expect(one).toContain("text-overflow: ellipsis;");
    expect(one).toContain("white-space: nowrap;");
    expect(/\n {2}\.block \{([^}]*)\}/.exec(cal)?.[1] ?? "").toContain("overflow: hidden;");
    expect(calSrc.slice(0, calSrc.indexOf("<style>"))).toContain("class:one=");
  });

  test("off macOS the right-hand words read \"only on this computer\"", () => {
    const html = whatHtml(B1_PAGE, B1_WIN.live!.gitDetail, ["app"]);
    expect(html).toContain('<span class="here svelte-');
    expect(html).toContain(">only on this computer</span>");
    expect(html).not.toContain("only on this Mac");
  });

  test("each row opens to its commits: the short SHA and the page's sentence; a NOT-shown or hidden subject muted", () => {
    const r = all({
      ...(richReply() as ReposAllReply),
      labels: [gitLabel("app", "app", [{ kind: "branch", name: "spike/kelly", push: { state: "never", notPushed: 2 }, commits: [cited("b2c3d4e"), { sha: "f".repeat(40), token: null, subject: "wip: sizing" }] }]), (richReply() as ReposAllReply).labels[1]!],
    });
    const [row] = rowsOf(whatHtml(B1_PAGE, gitInput(held(r)), ["app"]));
    expect(row).toMatch(/<li class="commit[^"]*"><span class="sha[^"]*">b2c3d4e<\/span> <span class="said[^"]*"><span class="line[^"]*">started the kelly sizing spike<\/span><\/span><\/li>/);
    expect(row).toMatch(/<span class="sha[^"]*">fffffff<\/span> <span class="said[^"]*"><span class="line[^"]*\bmuted\b[^"]*">wip: sizing<\/span>/);
  });

  test("lines no row holds, and 🔀 PRs no PR row holds, are drawn after the rows as A draws them", () => {
    // Only PR #12's commit and the spike are rows: the docs and parser lines, and no 🔀 PR row for #12.
    const r = all({ ...(richReply() as ReposAllReply), labels: [gitLabel("app", "app", [{ kind: "branch", name: "spike/kelly", push: null, commits: [cited("b2c3d4e")] }]), (richReply() as ReposAllReply).labels[1]!] });
    const app = cardOf(whatHtml(B1_PAGE, gitInput(held(r)), ["app"]), "app");
    const afterRows = app.slice(app.indexOf("</ul>", app.indexOf('<ul class="rows')));
    expect(afterRows).toContain("tidied the docs");
    expect(afterRows).toContain("merged the importer");
    expect(afterRows).toContain("Merged: #12");
    expect(app.indexOf("started the kelly sizing spike")).toBeLessThan(app.indexOf('<ul class="lines'));
    const detail = app.slice(app.indexOf('<div class="detail'));
    expect(count(detail, "started the kelly sizing spike")).toBe(1);   // the rows replace the flat list
  });

  test("A's disclosure is the fallback: before the detail, for a repo `unknown`, and for a card with no SHA", () => {
    for (const s of [B1.beforeTheDetail!, B1.noResult!]) {
      const app = cardOf(whatHtml(B1_PAGE, s.gitDetail, ["app"]), "app");
      expect(app).toContain(">4 commits ›</button>");
      expect(app).not.toContain('<ul class="rows');
      expect(app).toContain("tidied the docs</li>");
    }
    const unknown = whatHtml(B1_PAGE, B1.unknownRepo!.gitDetail, ["app", "lib"]);
    expect(cardOf(unknown, "app")).toContain(">4 commits ›</button>");
    expect(cardOf(unknown, "lib")).toContain('<ul class="rows');
    const noSha = page({ recap: [{ repo: "app", text: "a line with no evidence" }], windowMerges: [{ repo: "app", text: "🔀 Merged #12 (feat/importer) (Oct 15)  (a1b2c3d)" }] });
    expect(whatHtml(noSha, B1.live!.gitDetail)).toContain(">Details ›</button>");
  });

  test("(pins) each row's disclosure is a native <details>, closed, out of Open all's reach; text nodes only", () => {
    const rows = readFileSync(new URL("../src/lib/deck/GitRows.svelte", import.meta.url), "utf8");
    expect(count(rows, "<details ")).toBe(1);
    expect(rows).not.toMatch(/\bopen=|bind:open|ondispatch|\{@html|href/);
    const w = readFileSync(new URL("../src/lib/deck/WhatYouDid.svelte", import.meta.url), "utf8");
    expect(w).toContain('ondispatch({ type: "openAll", keys: w.cards.map((c) => c.key) })');
    expect(w).toContain("<GitRows rows={detail.rows} actions={actions?.did.find((d) => d.key === card.key)?.rows} />");
    const html = whatHtml(B1_PAGE, B1.live!.gitDetail, ["app"]);
    expect(rowsOf(html).length).toBeGreaterThan(0);
    expect(html).not.toMatch(/<details class="row[^"]*" open/);
  });

  test("the deck passes the git view to What you did (B1's prop, plan §1.2)", () => {
    const deck = readFileSync(new URL("../src/lib/deck/Deck.svelte", import.meta.url), "utf8");
    expect(deck).toContain('const git = $derived(view.kind === "slides" ? view.git : null);');
    expect(deck).toContain("<WhatYouDid {page} open={nav.open} active={armed && i === nav.index} {ondispatch} {git} {actions} />");
  });
});

/* ── polish §2: pile headings in an opened card; the page's words everywhere else ───────────────── */

describe("polish §2: an opened card's pile headings with the live detail; the page's words everywhere else", () => {
  const WIDE = "src/a.ts — 2 of 5 commits touching it (grouped: Oct 14–15)";
  const GONE = "src/old.ts — 2 commits (Oct 13)";
  const text = page({
    recap: [
      { repo: "app", text: "pile one", evidence: "a1b2c3d", group: WIDE },
      { repo: "app", text: "pile two", evidence: "b2c3d4e", group: WIDE },
      { repo: "app", text: "old one", evidence: "c3d4e5f", group: GONE },
      { repo: "app", text: "old two", evidence: "d4e5f6a", group: GONE },
    ],
  });
  // The rows hold a1b2c3d (WIDE keeps b2c3d4e) and both of GONE's commits (GONE is left empty).
  const r = all({ labels: [gitLabel("app", "app", [{ kind: "branch", name: "feat/pile", push: { state: "pushed", notPushed: 0 }, commits: ["a1b2c3d", "c3d4e5f", "d4e5f6a"].map(cited) }])], repoViews: [gitRepo("app")] });
  const restOf = (html: string): string => /<\/details><\/li><\/ul> <ul class="lines[^"]*">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  test("PREMISE: the page writes both headings as headers over their lines", () => {
    expect(text).toContain(`   • [app] ${WIDE}\n      ◦ [app] pile one  (a1b2c3d)`);
    expect(text).toContain(`   • [app] ${GONE}\n      ◦ [app] old one  (c3d4e5f)`);
  });

  test("with no git detail, an opened card's flat list draws the headings verbatim", () => {
    const app = cardOf(whatHtml(text, null, ["app"]), "app");
    expect(app).toMatch(new RegExp(`<li class="bullet[^"]*\\bheader\\b[^"]*">${esc(WIDE)}</li>`));
    expect(app).toMatch(new RegExp(`<li class="bullet[^"]*\\bheader\\b[^"]*">${esc(GONE)}</li>`));
    expect(app).not.toContain("src/a.ts · ");
  });

  test("with the detail, the opened card draws the shortened heading, bold (`header`), and no dropped heading", () => {
    const app = cardOf(whatHtml(text, gitInput(held(r)), ["app"]), "app");
    expect(rowsOf(app)).toHaveLength(1);   // PREMISE: the detail is drawn
    const rest = restOf(app);
    expect(rest).toMatch(/<li class="bullet[^"]*\bheader\b[^"]*">src\/a\.ts · 1 commit<\/li>/);
    expect(rest).toMatch(/<li class="nested[^"]*">pile two \(b2c3d4e\)<\/li>/);   // `normalise` folds the page's two spaces
    expect(app).not.toContain(WIDE);
    expect(app).not.toContain("src/old.ts");
    const style = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(new URL("../src/lib/deck/WhatYouDid.svelte", import.meta.url), "utf8"))![1]!;
    expect(/\n {2}\.lines \.header \{([^}]*)\}/.exec(style)?.[1] ?? "").toContain("font-weight: 600;");
  });

  test("(source pin) What you did draws `detail.rest` as A draws its lines: the kind's class and `header`", () => {
    const w = readFileSync(new URL("../src/lib/deck/WhatYouDid.svelte", import.meta.url), "utf8");
    expect(w).toMatch(/\{#each detail\.rest as line, j \(j\)\}\s*<li class=\{line\.kind\} class:header=\{line\.header\}>\{line\.text\}<\/li>\s*\{\/each\}/);
  });

  test("the Full briefing view, with the detail held, and the classic view keep the page's words", () => {
    keepDeckState(briefingHash(text), "launchpad", 4, true);
    const { model, deck } = gitDeck(text, gitInput(held(r)));
    expect(deck.git?.cards.find((c) => c.key === "app")?.mode).toBe("detail");   // PREMISE: the detail is there
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const full = normalise(render(DeckOrClassic as any, { props: { model, deck, now: B1_NOW, briefingKey: briefingHash(text), slides: true, ...RUN, onhistory: () => {} } }).body);
    expect(headings(full)).toEqual(["Full briefing", "Today"]);
    for (const h of [WIDE, GONE]) expect({ h, full: full.includes(h) }).toEqual({ h, full: true });
    expect(full).not.toContain("src/a.ts · ");
    const classic = normalise(classicHtml({ latest: loaded(text) }));
    for (const h of [WIDE, GONE]) expect({ h, classic: classic.includes(h) }).toEqual({ h, classic: true });
    // The "could not be shown as slides" view of the same page (its title line removed): the note, and the words.
    const noTitle = text.slice(text.indexOf("\n") + 1);
    const cannot = normalise(deckHtml({ latest: loaded(noTitle) }));
    expect(count(cannot, NOTE)).toBe(1);
    for (const h of [WIDE, GONE]) expect({ h, cannot: cannot.includes(h) }).toEqual({ h, cannot: true });
    expect(cannot).not.toContain("src/a.ts · ");
  });
});

/** One slide's HTML in a deck render: from its heading to the next slide (or the deck's end). */
function slideOf(html: string, heading: RegExp): string {
  const m = heading.exec(html);
  expect(m).not.toBeNull();
  const from = m!.index;
  const next = html.indexOf('<div class="slide', from);
  return html.slice(from, next === -1 ? undefined : next);
}
const GOOD_MORNING = /<h2[^>]*>Good morning<\/h2>/;
const LEFT_OFF = /<h2[^>]*>Where you left off<\/h2>/;
const SUGGESTED = /<h2[^>]*>Suggested (for today|then)<\/h2>/;
/** The launchpad's heading, either form (polish §6: "Before you start" while an amber tile waits). */
const LAUNCHPAD = /<h2[^>]*>(You(&#39;|')re all set|Before you start)<\/h2>/;
/** A tile's drawn text, tags removed. */
const words = (h: string): string => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("B1-M6-T18: Where you left off, Suggested, the launchpad, Good morning", () => {
  test("overflow after a repo check fails is dimmed and shows the retained count's time", () => {
    const views = [1, 2, 3, 4].map((n) => gitRepo(`r${n}`, { count: n }));
    const previous = held(all({ repoViews: views }, { uncommittedAt: at(9, 10) }));
    const next = held(all({ repoViews: views.map((v, i) => i === 3 ? { ...v, uncommitted: { unknown: true } } : v) }), previous);
    const html = slideOf(gitHtml(B1_PAGE, gitInput(next)), LAUNCHPAD);
    expect(html).toContain("+1 more repo not committed");
    expect(html).toMatch(/<p class="value[^\"]*\bdim\b[^\"]*">\+1 more repo not committed<\/p>/);
    expect(html).toContain("as of 09:10");
  });
  test("Good morning draws the live line's held time in muted as-of text after IPC and partial failures", () => {
    const fresh = B1.live!.gitDetail;
    const gm = (detail: GitDetailInput) => slideOf(gitHtml(B1_PAGE, detail), GOOD_MORNING);
    expect(gm(fresh)).not.toContain("as of");
    const failed = gm({ ...fresh, fresh: false });
    expect(failed).toMatch(/<li[^>]*class="[^"]*\bdim\b[^"]*">4 commits exist only on this Mac\. See Suggested\. <span class="as-of[^"]*">as of 09:10<\/span><\/li>/);
    const partial = held(all({ ...(richReply() as ReposAllReply), checkedAt: new Date(2026, 9, 16, 9, 30).toISOString() }, { unknownRepos: ["app"] }), fresh.reply);
    expect(gm({ ...fresh, reply: partial })).toContain(">as of 09:10</span>");
    const src = readFileSync(new URL("../src/lib/deck/GoodMorning.svelte", import.meta.url), "utf8");
    expect(src).toMatch(/\.as-of \{\s*color: var\(--muted\);\s*font-size: 0\.8rem;/);
    expect(src).toMatch(/\.dim \{\s*color: var\(--muted\);/);
  });

  test("the deck passes the git view to the five slides that draw it (B1's props, plan §1.2)", () => {
    const deck = readFileSync(new URL("../src/lib/deck/Deck.svelte", import.meta.url), "utf8");
    for (const c of ["GoodMorning", "WhatYouDid", "LeftOff", "Suggested", "Launchpad"]) {
      const at0 = deck.indexOf(`<${c}`);
      const line = deck.slice(at0, deck.indexOf("/>", at0));
      expect({ c, git: /\{git\}/.test(line) }).toEqual({ c, git: true });
    }
    expect(count(deck, "{git}")).toBe(5);
    expect(deck).toContain("<Launchpad {page} {now} {git} {actions} {live} {calendarDay} active={armed && i === nav.index} {onfull} {onhistory} />");
  });

  test("Suggested: the push card is unnumbered, FIRST and outside the <ol>, with its pill, its text and its why line", () => {
    const sg = slideOf(gitHtml(B1_PAGE, B1.live!.gitDetail), SUGGESTED);
    const card = sg.slice(0, sg.indexOf("<ol"));
    // The branches in the engine's order (`src/repos/push.ts`, sorted by name with `byteCmp`), then the default branch.
    expect(card).toContain("Push your work: 2 commits on fix/parser, 1 on spike/kelly and 1 on main exist only on this Mac");
    expect(card).toMatch(/<p class="why[^"]*">Not backed up anywhere yet<\/p>/);
    expect(card).toMatch(/<span class="pill pc-\d+[^"]* wrap" title="app">app<\/span>/);
    expect(card).not.toMatch(/class="n caps/);
    // The page's own suggestion keeps its number 1, inside the list.
    expect(sg.slice(sg.indexOf("<ol"))).toMatch(/<span class="n caps[^"]*">1<\/span>/);
    expect(sg.slice(sg.indexOf("<ol"))).toContain("review the loader fix");
    const src = readFileSync(new URL("../src/lib/deck/Suggested.svelte", import.meta.url), "utf8");
    expect(src).toContain("{#each pushCards as p (p.key)}");
    expect(src.indexOf("{#each pushCards as p (p.key)}")).toBeLessThan(src.indexOf('<ol class="list">'));
    expect(src).toContain("{#each suggested.cards as s (s.n)}");
    // A repo with no page card: its name in place of a pill.
    const named = all({ ...(richReply() as ReposAllReply), pushCards: [{ repoKey: "tool", storeKey: "s-tool", firstLabel: null, repoName: "tool", branches: [], onDefault: { name: "main", commits: 1 } }], repoViews: [...(richReply() as ReposAllReply).repoViews, gitRepo("tool")] });
    const n = slideOf(gitHtml(B1_PAGE, gitInput(held(named))), SUGGESTED);
    expect(n).toContain("Push your work: 1 commit on main exists only on this Mac");
    expect(n).toMatch(/<span class="repo[^"]*">tool<\/span>/);
  });

  test("Suggested: no \"No suggestions\" line beside a push card; the line with neither; no push card on an older page or before the detail", () => {
    const none = page({ recap: [{ repo: "app", text: "started the kelly sizing spike", evidence: "b2c3d4e" }] });
    expect(slideOf(gitHtml(none, B1.live!.gitDetail), SUGGESTED)).not.toContain("No suggestions in this briefing.");
    expect(slideOf(gitHtml(none, B1.live!.gitDetail), SUGGESTED)).toContain("Push your work:");
    expect(slideOf(gitHtml(none, B1.pushedAndClean!.gitDetail), SUGGESTED)).toContain("No suggestions in this briefing.");
    expect(slideOf(gitHtml(B1_PAGE, B1.beforeTheDetail!.gitDetail), SUGGESTED)).not.toContain("Push your work:");
    const older = page({ date: "2026-10-14", recap: [{ repo: "app", text: "x", evidence: "b2c3d4e" }], suggestions: [{ text: "old" }] });
    const sg = slideOf(gitHtml(older, B1.live!.gitDetail), SUGGESTED);
    expect(sg).toContain("Suggested then");
    expect(sg).not.toContain("Push your work:");
    expect(slideOf(gitHtml(B1_PAGE, B1.notCurrent!.gitDetail), SUGGESTED)).toMatch(/<p class="as-of[^"]*">as of 09:10<\/p>/);
  });

  test("the launchpad: the git tiles after the meeting tile, in S1's order, each saying its state in words; the mood line counts the amber ones", () => {
    const lp = slideOf(gitHtml(B1_PAGE, B1.live!.gitDetail), LAUNCHPAD);
    expect(lp).toContain("A couple of things are waiting.");
    const tiles = [...lp.matchAll(/<section class="tile[^"]*"[^>]*>([\s\S]*?)<\/section>/g)].map((m) => [m[0]!.slice(0, m[0]!.indexOf(">")), words(m[1]!)]);
    expect(tiles.map((t) => t[1])).toEqual(["Only on this Mac 4 commits on 3 branches", "Not committed 2 files in app"]);
    expect(lp).toMatch(/<p class="label caps[^"]*\bwait\b[^"]*">Only on this Mac<\/p>/);
    expect(tiles.every((t) => !/\bdone\b/.test(t[0]!))).toBe(true);
    // One amber tile: "One thing is waiting."
    const one = all({ ...(richReply() as ReposAllReply), pushCards: [], tile: { commits: 0, branches: 0 } });
    expect(slideOf(gitHtml(B1_PAGE, gitInput(held(one))), LAUNCHPAD)).toContain("One thing is waiting.");
    // A meeting line wins over the tiles.
    const ev = { time: { kind: "timed", startMs: new Date(2026, 9, 16, 10, 10).getTime(), endMs: new Date(2026, 9, 16, 10, 30).getTime() }, title: "Standup", status: "confirmed", transparency: "busy", attendeeCount: 2 };
    const withCal = page({ recap: [{ repo: "app", text: "started the kelly sizing spike", evidence: "b2c3d4e" }], calendar: { events: [ev], sources: [{ id: "macos", kind: "macos", status: "ok" }], incomplete: false } } as Partial<EngineStruct>);
    const cal = slideOf(gitHtml(withCal, B1.live!.gitDetail), LAUNCHPAD);
    expect(cal).toContain("A meeting is coming up.");
    expect(cal.indexOf("Standup")).toBeLessThan(cal.indexOf("Only on this Mac"));
    // Off macOS.
    expect(slideOf(gitHtml(B1_PAGE, B1_WIN.live!.gitDetail), LAUNCHPAD)).toContain(">Only on this computer</p>");
  });

  test("the launchpad: a green tile (\"✓ Pushed\", \"✓ Committed\") has the done outline and leaves at the first draw 5 minutes after it turned green; green never counts in the mood", () => {
    const s = B1.pushedAndClean!;
    const lp = slideOf(gitHtml(B1_PAGE, s.gitDetail, s.now), LAUNCHPAD);
    expect(lp).toContain("Nothing needs you right now.");
    expect(lp).toMatch(/<section class="tile[^"]* done[^"]*"[^>]*>\s*<p class="label caps[^"]*">✓ Pushed<\/p>\s*<p class="value[^"]*">All your work is pushed<\/p>/);
    expect(lp).toContain("✓ Committed");
    expect(lp).toContain("app is clean");
    const greenAt = s.gitDetail.greenSince["onlyHere"]!;
    expect(slideOf(gitHtml(B1_PAGE, s.gitDetail, greenAt + 5 * 60_000 - 1), LAUNCHPAD)).toContain("✓ Pushed");
    expect(slideOf(gitHtml(B1_PAGE, s.gitDetail, greenAt + 5 * 60_000), LAUNCHPAD)).not.toContain("✓ Pushed");
  });

  test("the launchpad: at most 3 Not-committed tiles, then \"+N more repos not committed\"; a check not current dims its tile and says \"as of HH:MM\"", () => {
    const lp = slideOf(gitHtml(B1_PAGE, B1.manyDirty!.gitDetail), LAUNCHPAD);
    expect(count(lp, ">Not committed</p>")).toBe(3);
    expect(lp).toMatch(/<p class="value[^"]*">\+2 more repos not committed<\/p>/);
    const stale = slideOf(gitHtml(B1_PAGE, B1.notCurrent!.gitDetail), LAUNCHPAD);
    expect(stale).toMatch(/<section class="tile[^"]*"[^>]*>\s*<p class="label caps[^"]*\bdim\b[^"]*">Only on this Mac<\/p>\s*<p class="value[^"]*\bdim\b[^"]*">4 commits on 3 branches<\/p>\s*<p class="as-of[^"]*">as of 09:10<\/p>/);
    expect(stale).toContain(">as of 09:14</p>");
    expect(slideOf(gitHtml(B1_PAGE, B1.live!.gitDetail), LAUNCHPAD)).not.toContain("as of");
  });

  test("the launchpad on an older page: no mood line (a claim about now), the live tiles still shown", () => {
    const older = page({ date: "2026-10-14", recap: [{ repo: "app", text: "x", evidence: "b2c3d4e" }] });
    const lp = slideOf(gitHtml(older, B1.live!.gitDetail), LAUNCHPAD);
    expect(lp).not.toContain("waiting.");
    expect(lp).not.toContain('class="mood');
    expect(lp).toContain("Only on this Mac");
  });

  test("polish §6: the launchpad's heading flips with an amber tile, and its dot names the drawn heading, on today's page and an older one", () => {
    const older = page({ date: "2026-10-14", recap: [{ repo: "app", text: "x", evidence: "b2c3d4e" }] });
    const s = B1.pushedAndClean!;
    const cases: [string, string, GitDetailInput, number, string][] = [
      ["amber, today", B1_PAGE, B1.live!.gitDetail, B1_NOW, "Before you start"],
      ["amber, more than 3 dirty", B1_PAGE, B1.manyDirty!.gitDetail, B1_NOW, "Before you start"],
      ["amber, not current", B1_PAGE, B1.notCurrent!.gitDetail, B1_NOW, "Before you start"],
      ["amber, older page", older, B1.live!.gitDetail, B1_NOW, "Before you start"],
      ["green only", B1_PAGE, s.gitDetail, s.now, "You're all set"],
      ["before the detail", B1_PAGE, B1.beforeTheDetail!.gitDetail, B1_NOW, "You're all set"],
    ];
    for (const [name, text, gd, now, want] of cases) {
      const html = gitHtml(text, gd, now);
      const drawn = headings(html).map((h) => h.replace(/&#39;/g, "'"));
      expect({ name, last: drawn[drawn.length - 1] }).toEqual({ name, last: want });
      const dots = [...html.matchAll(/class="ctl dot[^"]*" aria-label="([^"]*)"/g)].map((m) => m[1]!.replace(/&#39;/g, "'"));
      expect({ name, dots }).toEqual({ name, dots: drawn.map((h, i) => `Slide ${i + 1} of ${drawn.length}: ${h}`) });
    }
    // The amber launchpad still holds its tiles (the helper found the right slide).
    expect(slideOf(gitHtml(B1_PAGE, B1.live!.gitDetail), LAUNCHPAD)).toMatch(/^<h2[^>]*>Before you start<\/h2>[\s\S]*Only on this Mac/);
    expect(slideOf(gitHtml(older, B1.live!.gitDetail), LAUNCHPAD)).toMatch(/^<h2[^>]*>Before you start<\/h2>[\s\S]*Only on this Mac/);
    expect(slideOf(gitHtml(B1_PAGE, s.gitDetail, s.now), LAUNCHPAD)).toMatch(/^<h2[^>]*>You(&#39;|')re all set<\/h2>[\s\S]*✓ Pushed/);
  });

  test("(source pin) one rule for the launchpad's heading: Launchpad draws `launchpadHeading`, and the dots read it through `slideHeadings`", () => {
    const lp = readFileSync(new URL("../src/lib/deck/Launchpad.svelte", import.meta.url), "utf8");
    expect(lp).toContain("<h2 tabindex=\"-1\" use:focusHeading={active}>{launchpadHeading(git ?? null)}</h2>");
    const deck = readFileSync(new URL("../src/lib/deck.ts", import.meta.url), "utf8");
    expect(deck).toContain('launchpad: view.kind === "slides" ? launchpadHeading(view.git) : "You\'re all set",');
  });

  test("(pins) the launchpad reads its tiles and its mood line from the model, at the deck's clock (orchestrator ruling 1); GitTile says its state in words", () => {
    const lp = readFileSync(new URL("../src/lib/deck/Launchpad.svelte", import.meta.url), "utf8");
    expect(lp).toContain("const gitTiles = $derived(launchpadTiles(git ?? null, now));");
    // PB-M4-T3: on a live calendar day the calendar's chosen line is the third argument (null on a section page).
    expect(lp).toContain("{liveMoodLine(tile, gitTiles, liveDayLine(live?.readState ?? null))}");
    expect(lp).not.toMatch(/\{moodLine\(/);
    const gt = readFileSync(new URL("../src/lib/deck/GitTile.svelte", import.meta.url), "utf8");
    expect(gt).toContain('<Tile state={tile.state === "done" ? "done" : undefined}>');
    expect(gt).toMatch(/\.wait \{\s*color: var\(--state-wait\);/);
    expect(gt).not.toMatch(/#[0-9a-fA-F]{3,8}\b|opacity/);
  });

  test("Good morning: the live line is APPENDED after the page's Needs-a-look lines; the tile shows with only the live line; none on an older page", () => {
    const withLines = page({ recap: [{ repo: "app", text: "started the kelly sizing spike", evidence: "b2c3d4e" }], notices: ['ℹ︎ Skipped "work": out of usage'] } as Partial<EngineStruct>);
    const gm = slideOf(gitHtml(withLines, B1.live!.gitDetail), GOOD_MORNING);
    const look = /<ul class="look[^"]*">([\s\S]*?)<\/ul>/.exec(gm)![1]!;
    expect([...look.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map((m) => m[1])).toEqual(['ℹ︎ Skipped "work": out of usage', "4 commits exist only on this Mac. See Suggested."]);
    const alone = slideOf(gitHtml(B1_PAGE, B1.live!.gitDetail), GOOD_MORNING);
    expect(alone).toContain(">Needs a look</p>");
    expect(alone).toContain("4 commits exist only on this Mac. See Suggested.");
    expect(slideOf(gitHtml(B1_PAGE, B1.beforeTheDetail!.gitDetail), GOOD_MORNING)).not.toContain("Needs a look");
    const older = page({ date: "2026-10-14", recap: [{ repo: "app", text: "x", evidence: "b2c3d4e" }] });
    expect(gitHtml(older, B1.live!.gitDetail)).not.toContain("exist only on this Mac. See Suggested.");
    // The first-suggestion tile stays the page's first card, never a push card.
    expect(alone).toMatch(/First suggestion<\/p> <p class="tile-text[^"]*">review the loader fix<\/p>/);
    expect(slideOf(gitHtml(B1_PAGE, B1_WIN.live!.gitDetail), GOOD_MORNING)).toContain("4 commits exist only on this computer. See Suggested.");
  });

  test("Good morning: \"Your recent work\" carries the live PR count once the detail arrives, the page's before", () => {
    const withPr = all({ ...(richReply() as ReposAllReply), labels: [{ ...(richReply() as ReposAllReply).labels[0]!, rows: [...(richReply() as ReposAllReply).labels[0]!.rows, { kind: "pr", number: 13, title: "Later PR", commits: [cited("c3d4e5f")] }] }, (richReply() as ReposAllReply).labels[1]!] });
    const work = (h: string): string => words(/<p class="work[^"]*">([\s\S]*?)<\/p>/.exec(slideOf(h, GOOD_MORNING))![1]!);
    expect(work(gitHtml(B1_PAGE, B1.beforeTheDetail!.gitDetail))).toBe("Your recent work: 2 projects · 5 commits · 1 PR merged");
    expect(work(gitHtml(B1_PAGE, gitInput(held(withPr))))).toBe("Your recent work: 2 projects · 5 commits · 2 PRs merged");
    const src = readFileSync(new URL("../src/lib/deck/GoodMorning.svelte", import.meta.url), "utf8");
    expect(src).toContain("{#if (git?.workLine ?? gm.workLine) !== null}");
  });

  test("Where you left off: the live words replace A's counts — \"behind N\" muted, \"never pushed\" / \"N not pushed\" the dashed amber tag — and \"N files not committed\"", () => {
    const lo = slideOf(gitHtml(B1_PAGE, B1.live!.gitDetail), LEFT_OFF);
    expect(lo).toMatch(
      /On branch <\/span><span class="tag branch[^"]*" title="spike\/kelly">spike\/kelly<\/span> <span class="tag local[^"]* wrap" title="never pushed">never pushed<\/span> <span class="counts caps[^"]*">behind 1<\/span>/,
    );
    expect(lo).not.toContain("ahead 2");
    expect(lo).toMatch(/<span class="tag local[^"]* wrap" title="2 files not committed">2 files not committed<\/span>/);
    const partly = all({ ...(richReply() as ReposAllReply), branchLines: [{ key: "app", name: "spike/kelly", state: "live", notPushed: 3, neverPushed: false, behind: 0 }] });
    const p = slideOf(gitHtml(B1_PAGE, gitInput(held(partly))), LEFT_OFF);
    expect(p).toMatch(/title="spike\/kelly">spike\/kelly<\/span> <span class="tag local[^"]* wrap" title="3 not pushed">3 not pushed<\/span>/);
    expect(p).not.toContain('class="counts');
  });

  test("Where you left off: A's words are kept before the detail, for a branch no longer there, and for a repo with no remote; \"as of HH:MM\" when not current", () => {
    const before = slideOf(gitHtml(B1_PAGE, B1.beforeTheDetail!.gitDetail), LEFT_OFF);
    expect(before).toMatch(/title="spike\/kelly">spike\/kelly<\/span> <span class="counts caps[^"]*">ahead 2 · behind 1<\/span>/);
    // The seed: "Uncommitted changes: a.ts, b.ts" → 2 files, until the live count lands.
    expect(before).toContain(">2 files not committed</span>");
    for (const state of ["missing", "noRemote"] as const) {
      const r = all({ ...(richReply() as ReposAllReply), branchLines: [{ key: "app", name: "spike/kelly", state }] });
      const lo = slideOf(gitHtml(B1_PAGE, gitInput(held(r))), LEFT_OFF);
      expect({ state, kept: /title="spike\/kelly">spike\/kelly<\/span> <span class="counts caps[^"]*">ahead 2 · behind 1<\/span>/.test(lo) }).toEqual({ state, kept: true });
      expect(lo).not.toContain("not pushed");
    }
    const stale = slideOf(gitHtml(B1_PAGE, B1.notCurrent!.gitDetail), LEFT_OFF);
    expect(stale).toMatch(/<span class="as-of[^"]*">as of 09:10<\/span>/);
    expect(stale).toMatch(/2 files not committed<\/span> <span class="as-of[^"]*">as of 09:14<\/span>/);
    // A live count of 0 removes the tag.
    expect(slideOf(gitHtml(B1_PAGE, B1.pushedAndClean!.gitDetail), LEFT_OFF)).not.toContain("not committed");
  });

  test("Where you left off: every tag passes `wrap` (it is outside any control)", () => {
    const src = readFileSync(new URL("../src/lib/deck/LeftOff.svelte", import.meta.url), "utf8");
    expect(count(src, "<StatusTag ")).toBe(count(src, " wrap />") - 1);
    expect(count(src, "<StatusTag ")).toBe(4);
  });
});

/* ── briefing redesign C, wave-2 plan C-M5-T13: the calendar slide with today's details read live ─────────────────────
 * Server renders of the slide (through the real deck, with a `calendarDetail` input), of the meeting card per state and
 * of the card's two presentational pieces (the ask-first question, the people and notes): a server render runs no
 * effect and no click, so what a click and a reply do is pinned by source below, and the replies' meaning is the pure
 * `joinStep` / `detailsStep` (calendar-detail.check.ts). ⚠ Every calendar string stays a text node. */

describe("C-M5-T13: the calendar slide read live — the subtitle, the status rows, the timeline, the bar", () => {
  const at = (h: number, m = 0): number => new Date(2026, 9, 16, h, m).getTime();
  const base = { status: "confirmed", transparency: "busy", attendeeCount: 2 };
  const STANDUP = { ...base, time: { kind: "timed", startMs: at(9), endMs: at(9, 30) }, title: "Standup", location: "Room 4" } as CalendarStructEvent;
  const REVIEW = { ...base, status: "tentative", time: { kind: "timed", startMs: at(11), endMs: at(12) }, title: "Design review" } as CalendarStructEvent;
  const LUNCH = { ...base, time: { kind: "timed", startMs: at(13), endMs: at(14) }, title: "Lunch" } as CalendarStructEvent;
  const OFFSITE = { ...base, time: { kind: "allDay", startDate: TODAY, endDateExclusive: "2026-10-17" }, title: "Offsite" } as CalendarStructEvent;
  const MAC = { id: "macos", kind: "macos", status: "ok" };
  const textOf = (events: CalendarStructEvent[], sources: unknown[] = [MAC]): string =>
    page({ calendar: { events, sources, incomplete: false } } as Partial<EngineStruct>);
  const OK: CalendarDetailsSource = { id: "macos", kind: "macos", status: "ok", skipped: false, last: null };
  const source = (id: string, status: string, reason?: string): CalendarDetailsSource => ({
    id, kind: id === "macos" ? "macos" : "link", status, ...(reason !== undefined ? { reason } : {}), skipped: false, last: null,
  });
  let seq = 0;
  /** A live event as Rust's reply carries it, its `rowText` from the engine's own renderer. */
  const live = (e: CalendarStructEvent, extra: Partial<CalendarDetailsEvent> = {}): CalendarDetailsEvent => {
    seq += 1;
    return {
      handle: `g.${seq}.h`,
      title: e.title,
      location: e.location ?? null,
      rowText: calEventLine(e as Parameters<typeof calEventLine>[0], TODAY),
      time: e.time,
      status: e.status,
      ended: false,
      linkState: "none",
      joinHost: null,
      needsConfirm: false,
      fromMac: true,
      ...extra,
    };
  };
  const detailOf = (events: CalendarDetailsEvent[], sources: CalendarDetailsSource[] = [OK], more: Partial<CalendarDetail> = {}): CalendarDetail => ({
    ...NO_DETAIL,
    list: { readAt: new Date(at(9, 35)).toISOString(), readerOutdated: false, events, sources },
    ...more,
  });

  /** The whole deck with a calendar detail; the calendar slide's markup, from its heading to the next slide. */
  function slideOf(text: string, d: CalendarDetail, now = NOW): string {
    const model = modelOf({ latest: loaded(text) });
    const deck = deckView({ model, today: TODAY, firstName: null, calendarDetail: d });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const html = render(DeckOrClassic as any, { props: { model, deck, now, briefingKey: briefingHash(text), slides: true, ...RUN, onhistory: () => {} } }).body;
    const from = html.search(/Today(&#39;|')s calendar/);
    expect(from).toBeGreaterThan(-1);
    const rest = html.slice(from);
    const end = rest.indexOf('<div class="slide');
    return normalise(end === -1 ? rest : rest.slice(0, end));
  }
  const sub = (slide: string): string | null => /<p class="sub[^"]*">([^<]*)<\/p>/.exec(slide)?.[1] ?? null;

  test("the subtitle: the page's counts before a read, the live counts after one, the page's counts and the line after a whole-read failure", () => {
    const text = textOf([STANDUP, LUNCH]);
    expect(sub(slideOf(text, NO_DETAIL, at(8, 30)))).toBe("2 events · 1h 30m in meetings · next in 30 minutes");
    // Lunch cancelled since the page: the live events count.
    expect(sub(slideOf(text, detailOf([live(STANDUP)]), at(8, 30)))).toBe("1 event · 30m in meetings · next in 30 minutes");
    const failed = slideOf(text, detailOf([], [source("macos", "timeout")]), at(8, 30));
    expect(sub(failed)).toBe("2 events · 1h 30m in meetings · next in 30 minutes");
    expect(failed).toMatch(new RegExp(`<p class="sub[^"]*">[^<]*</p> <p class="line[^"]*">${TIMEOUT_LINE}</p>`));
  });

  test("the page's status rows stay drawn before a read and after a whole-read failure; a full read replaces them", () => {
    const text = textOf([], [{ id: "macos", kind: "macos", status: "not-granted" }, { id: "work", kind: "link", status: "timeout" }]);
    const before = slideOf(text, NO_DETAIL);
    expect(before).toMatch(/<li class="status[^"]*">work: did not answer in time<\/li>/);
    expect(before).toContain("Calendar unavailable today");
    expect(sub(before)).toBeNull();   // the status rows say what the day is; "No events today" would be wrong
    const failed = slideOf(text, detailOf([], [source("macos", "denied"), source("work", "timeout")]));
    expect(failed).toMatch(/<li class="status[^"]*">work: did not answer in time<\/li>/);
    expect(failed).toContain(DENIED_LINE);
    const read = slideOf(text, detailOf([], [OK, { ...OK, id: "work", kind: "link" }]));
    expect(read).not.toContain("did not answer in time");
    expect(sub(read)).toBe("No events today");
    // Round 5 M1: a read with no source at all (nothing connected) keeps the page's "No calendar is connected".
    const none = slideOf(textOf([], []), detailOf([], []));
    expect(none).toMatch(/<li class="status[^"]*">No calendar is connected<\/li>/);
    expect(none).not.toContain("No events today");
  });

  test("the page's \"+N more\" row is a line under the timeline", () => {
    const fillers = Array.from({ length: 60 }, (_, n) => ({ ...base, time: { kind: "timed", startMs: at(13, n % 60), endMs: at(13, n % 60) }, title: `Filler ${n + 1}` }) as CalendarStructEvent);
    const slide = slideOf(textOf([STANDUP, ...fillers]), NO_DETAIL);
    expect(slide).toMatch(/<p class="more[^"]*">\+1 more<\/p>/);
    expect(slide.indexOf("+1 more")).toBeGreaterThan(slide.indexOf('class="timeline'));
  });

  test("the timeline: hour marks, each event a button with its time, title and marks in words, the now line, the all-day strip", () => {
    const slide = slideOf(textOf([STANDUP, REVIEW, OFFSITE]), NO_DETAIL, at(8, 30));
    expect(count(slide, '<button type="button" class="block event')).toBe(2);
    expect(slide).toMatch(/<button type="button" class="block event[^"]*"[^>]*><span class="when[^"]*">09:00–09:30<\/span> <span class="what[^"]*">Standup \(Room 4\)<\/span><\/button>/);
    expect(slide).toMatch(/<span class="what[^"]*">Design review · tentative<\/span>/);
    // 08:30 is 5% into 08:00-18:00; 09:00 is 10%, for 30 minutes (5%).
    expect(slide).toMatch(/<div class="now[^"]*" aria-hidden="true" style="--top: 5;?"><\/div>/);
    // --lines: the whole lines the block has room for (a 30-minute block is drawn 37.5 minutes high: one line).
    expect(slide).toMatch(/style="--top: 10; --h: 5; --lane: 0; --lanes: 1; --lines: 1;?"/);
    expect(slide).toMatch(/style="--top: 30; --h: 10; --lane: 0; --lanes: 1; --lines: 2;?"/);
    for (const h of ["08:00", "12:00", "18:00"]) expect(slide).toContain(`>${h}</span>`);
    expect(slide).toMatch(/<button type="button" class="strip-item[^"]*"[^>]*>all day — Offsite<\/button>/);
  });

  test("the timeline minimum height uses the lane duration and the shared hour scale", () => {
    const slide = slideOf(textOf([STANDUP]), NO_DETAIL);
    expect(slide).toMatch(/class="timeline[^"]*" style="--hours: 10; --min-block-h: 6\.25;?"/);
    const s = code("CalendarSlide.svelte");
    expect(s).toContain("style:--min-block-h={clampPct(TIMELINE_MIN_BLOCK_MS, lay.len)}");
    expect(/\.timeline \{([^}]+)\}/.exec(s)?.[1]).toContain("height: calc(var(--hours) * 2.4rem);");
    expect(/\.block \{([^}]+)\}/.exec(s)?.[1]).toContain("height: max(calc(var(--h) * 1%), calc(var(--min-block-h) * 1%));");
  });

  test("the next-meeting bar: the countdown, the title and time; Join only on a live event with a link", () => {
    const text = textOf([STANDUP, LUNCH]);
    const before = slideOf(text, NO_DETAIL, at(8, 30));
    expect(before).toMatch(/<div class="next[^"]*"><span class="in[^"]*">In 30 minutes<\/span>/);
    expect(before).toContain("Standup (Room 4)");
    expect(before).not.toContain("Join ↗");
    const read = slideOf(text, detailOf([live(STANDUP, { linkState: "one", joinHost: "zoom.us" }), live(LUNCH)]), at(9, 10));
    expect(read).toMatch(/<span class="in[^"]*">Now<\/span>/);
    expect(read).toContain(">Join ↗</button>");
    expect(read).not.toContain("Join now on");
  });

  test("a hostile title and place from a live read stay text on the slide", () => {
    const text = textOf([STANDUP]);
    const slide = slideOf(text, detailOf([live({ ...STANDUP, title: HOSTILE, location: HOSTILE })]), at(8, 30));
    expect(slide).not.toContain("<img");
    expect(slide).toContain("&lt;img");
  });

  /* the card, per state (rendered directly: opening it is a click) */

  function cardHtml(text: string, d: CalendarDetail, pick: (v: CalendarDetailView) => CardKey, now = at(8, 30)): string {
    const model = modelOf({ latest: loaded(text) });
    const deck = deckView({ model, today: TODAY, firstName: null, calendarDetail: d });
    const v = deck.kind === "slides" ? deck.live : null;
    expect(v).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return normalise(render(MeetingCard as any, { props: { view: v, key: pick(v!), os: "macos", now, onclose: () => {} } }).body);
  }
  /** The key of the n-th drawn timeline item: its text, handle and its own page-row identity (null for a live-only item),
   *  never its timeline position (spec §5 "Row identity"). */
  const row = (n: number) => (v: CalendarDetailView): CardKey => ({ rowText: v.events[n]!.rowText, handle: v.events[n]!.live?.handle ?? null, row: v.events[n]!.row });
  /** A page row's key by its ORIGINAL index among the page's calendar rows. */
  const pageRow = (text: string, index: number) => (): CardKey => ({ rowText: text, handle: null, row: index });

  test("loading: the page's facts and \"Reading your calendar…\"; Open in Calendar shown with a Mac source configured, hidden with none", () => {
    const text = textOf([STANDUP]);
    const loading = cardHtml(text, { ...NO_DETAIL, pending: true, macConfigured: true }, row(0));
    expect(loading).toMatch(/<section class="card[^"]*" aria-label="Standup \(Room 4\)">/);
    expect(loading).toContain(LOADING_LINE);
    expect(loading).toContain("09:00–09:30");
    expect(loading).toContain(">Open in Calendar</button>");
    expect(cardHtml(text, { ...NO_DETAIL, pending: true, macConfigured: false }, row(0))).not.toContain("Open in Calendar");
    // Before `calendar status` answers (null), it is not hidden: only a known "no Mac source" hides it.
    expect(cardHtml(text, { ...NO_DETAIL, pending: true }, row(0))).toContain("Open in Calendar");
  });

  test("each failure line in the card, with Open in Calendar after a failed read when a Mac source is configured", () => {
    const text = textOf([STANDUP]);
    const cases: [CalendarDetailsSource, string][] = [
      [source("macos", "timeout"), TIMEOUT_LINE],
      [source("macos", "denied"), DENIED_LINE],
      [source("work", "offline"), OFFLINE_LINE],
      [source("work", "incomplete", "unreachable"), OFFLINE_LINE],
      [source("work", "link-refused"), `work: ${CALENDAR_STATUS_TEXT["link-refused"]}`],
    ];
    for (const [src, line] of cases) {
      const html = cardHtml(text, detailOf([], [src], { macConfigured: true }), row(0));
      expect({ line, drawn: html.includes(line) }).toEqual({ line, drawn: true });
      expect({ line, open: html.includes("Open in Calendar") }).toEqual({ line, open: true });
    }
    expect(cardHtml(text, { ...NO_DETAIL, off: true }, row(0))).toContain(OFF_LINE);
  });

  test("\"several links\" (no Join), \"changed\" after a full read, and a fallback row after a partial read", () => {
    const text = textOf([STANDUP, LUNCH]);
    const several = cardHtml(text, detailOf([live(STANDUP, { linkState: "several" }), live(LUNCH)]), row(0));
    expect(several).toContain(SEVERAL_LINKS_LINE);
    expect(several).not.toContain("Join ↗");
    const standupRow = textOf([STANDUP]).split("\n").find((l) => l.includes("Standup"))!.replace(/^\s*◦ /, "");
    const changed = cardHtml(text, detailOf([live(LUNCH)]), pageRow(standupRow, 0));
    expect(changed).toContain(CHANGED_LINE);
    const partial = cardHtml(text, detailOf([live(LUNCH)], [OK, source("work", "timeout")]), pageRow(standupRow, 0));
    expect(partial).not.toContain(CHANGED_LINE);
    expect(partial).toContain(TIMEOUT_LINE);
    expect(partial).toContain("Standup (Room 4)");
    expect(partial).not.toContain("Join ↗");
  });

  test("a live event: its own title, time and place, \"Join ↗\" during the meeting, the footnote, the reader-update line", () => {
    const text = textOf([STANDUP]);
    const during = cardHtml(text, detailOf([live(STANDUP, { linkState: "one", joinHost: "zoom.us" })]), row(0), at(9, 10));
    expect(during).toMatch(/aria-label="Standup">/);
    expect(during).toContain("Room 4");
    expect(during).toContain(">Join ↗</button>");
    expect(during).not.toContain("Join now on");
    expect(during).toContain("Read live at 09:35 · not saved");
    const outdated = cardHtml(text, { ...detailOf([live(STANDUP)]), list: { ...detailOf([live(STANDUP)]).list!, readerOutdated: true } }, row(0));
    expect(outdated).toContain(READER_OUTDATED_LINE);
  });

  test("Open in Calendar after a read: shown for an event with a Mac copy, hidden for a link-only one", () => {
    const text = textOf([STANDUP]);
    expect(cardHtml(text, detailOf([live(STANDUP, { fromMac: true })], [OK], { macConfigured: true }), row(0))).toContain("Open in Calendar");
    expect(cardHtml(text, detailOf([live(STANDUP, { fromMac: false })], [OK], { macConfigured: true }), row(0))).not.toContain("Open in Calendar");
  });

  test("the ask-first question is text, with two buttons, Yes and No", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const html = normalise(render(AskFirst as any, { props: { question: "Open this Whereby link on whereby.com?", onyes: () => {}, onno: () => {} } }).body);
    expect(html).toMatch(/<p class="question[^"]*" tabindex="-1">Open this Whereby link on whereby\.com\?<\/p>/);
    expect(count(html, '<button type="button" class="action')).toBe(2);
    expect(html).toMatch(/>Yes<\/button>.*>No<\/button>/);
  });

  test("the people (initials chips with the shown names) and the notes, as plain text: a link-shaped note stays inert text", () => {
    const people = peopleLine([{ name: "Priya Sharma", organiser: true }, { name: "Sam Lee", organiser: false }]);
    const text = 'javascript:alert(1)\n<a href="msteams:/l/x">join</a>';
    const notes: NotesBoxList = [{ kind: "core", title: null, notes: text, label: "Notes" }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const html = normalise(render(MeetingDetails as any, { props: { people, notes } }).body);
    expect(count(html, 'class="av')).toBe(2);
    expect(html).toContain(">PS</li>");
    expect(html).toContain("Priya S. (organiser), Sam L.");
    expect(html).toContain("javascript:alert(1)");
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).toContain("&lt;a href=");   // the note's own text, escaped
    expect(html.replaceAll("&lt;a href=", "")).not.toContain("href=");
  });

  /* near-duplicates (spec §5, D1): one focusable, labelled region per box; only bodies scroll */

  const detailsHtml = (notes: NotesBoxList): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    normalise(render(MeetingDetails as any, { props: { people: peopleLine([]), notes } }).body);
  /** Each notes region's opening tag, in order. */
  const regions = (html: string): string[] => html.match(/<div [^>]*role="region"[^>]*>/g) ?? [];
  /** Regions contain paragraphs only, so their first closing div ends their content. */
  const regionContents = (html: string): string[] =>
    [...html.matchAll(/<div [^>]*role="region"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]!.trim());
  const label = (tag: string): string | null => /aria-label="([^"]*)"/.exec(tag)?.[1] ?? null;
  const CORE: NotesBox = { kind: "core", title: null, notes: "Core agenda", label: "Notes" };
  const TITLED: NotesBox = { kind: "other", title: "Ticket: Dentist", notes: "Bring card", label: "Notes from other copy: Ticket: Dentist" };
  const UNTITLED: NotesBox = { kind: "other", title: null, notes: "Parking B", label: "Notes from other copy" };
  const TITLE_ONLY: NotesBox = { kind: "other", title: "Reservation – Dentist", notes: null, label: "Notes from other copy: Reservation – Dentist" };

  test("C07/C05: every notes box has a nonempty focusable region with its label; only body regions carry the scrolling class", () => {
    const mergedHtml = detailsHtml([CORE, TITLED, UNTITLED, TITLE_ONLY]);
    const unmergedHtml = detailsHtml([CORE]);   // an old payload, or an unmerged event: the core box only
    const merged = regions(mergedHtml);
    const unmerged = regions(unmergedHtml);
    expect(merged.map(label)).toEqual(["Notes", "Notes from other copy: Ticket: Dentist", "Notes from other copy", "Notes from other copy: Reservation – Dentist"]);
    expect(unmerged.map(label)).toEqual(["Notes"]);
    const contents = [...regionContents(mergedHtml), ...regionContents(unmergedHtml)];
    expect(contents).toHaveLength(5);
    for (const content of contents) expect(content.replace(/<[^>]*>/g, "").trim()).not.toBe("");
    for (const tag of [...merged, ...unmerged]) {
      expect(tag).toContain('tabindex="0"');
    }
    expect(merged.map((tag) => /class="notes[\s"]/.test(tag))).toEqual([true, true, true, false]);
    expect(unmerged[0]).toMatch(/class="notes[\s"]/);
    expect(regions(detailsHtml([]))).toEqual([]);
    expect(detailsHtml([])).not.toContain(">Notes<");
  });

  test("C04: an other box is headed \"Other copy\", then its title when shown, then its body; the core box has no heading", () => {
    const html = detailsHtml([CORE, TITLED, UNTITLED, TITLE_ONLY]);
    // Keep each box through its region's closing tag, including a title-only region's heading and title.
    const boxes = html.split(/<div class="box[\s"][^>]*>/).slice(1).map((b) => b.slice(0, b.indexOf("</div>") + "</div>".length));
    expect(boxes).toHaveLength(4);
    expect(boxes[0]).not.toContain("Other copy");
    expect(boxes[0]).toContain("Core agenda");
    expect(boxes[1]).toMatch(/>Other copy<\/p>.*>Ticket: Dentist<\/p>.*>Bring card<\/p>/);
    expect(boxes[2]).toMatch(/>Other copy<\/p>\s*<div [^>]*role="region"[^>]*>\s*<p class="body[^"]*">Parking B<\/p>/);   // no title line
    expect(boxes[3]).toMatch(/>Other copy<\/p>.*>Reservation – Dentist<\/p>/);
    expect(boxes[3]).not.toContain('class="body');   // title only: no body
    expect(count(html, ">Other copy</p>")).toBe(3);
    const contents = regionContents(html);
    expect(contents).toHaveLength(4);
    expect(contents[3]).toMatch(/^<p class="copy[^"]*">Other copy<\/p>\s*<p class="title[^"]*">Reservation – Dentist<\/p>$/);
    const bodies = contents.slice(0, 3);
    expect(bodies.map((body) => body.replace(/<[^>]*>/g, "").trim())).toEqual([CORE.notes!, TITLED.notes!, UNTITLED.notes!]);
    for (const body of bodies) {
      expect(body).not.toContain('class="copy');
      expect(body).not.toContain('class="title');
    }
  });

  test("C07 (source): only the body scrolls, both region kinds have a focus ring, and each has an adjacent a11y ignore", () => {
    const src = readFileSync(new URL("../src/lib/deck/MeetingDetails.svelte", import.meta.url), "utf8");
    const lines = src.split("\n");
    const sites = lines.flatMap((line, i) => /<div\b[^>]*\brole="region"/.test(line) ? [i] : []);
    expect(sites).toHaveLength(2);
    for (const idx of sites) {
      expect(lines[idx - 1]!.trim()).toBe("<!-- svelte-ignore a11y_no_noninteractive_tabindex -->");
      expect(lines[idx]).toContain('tabindex="0"');
      expect(lines[idx]).toContain('aria-label={box.label}');
    }
    expect(sites.filter((idx) => lines[idx]!.includes('class="notes"'))).toHaveLength(1);
    const style = /<style>([\s\S]*?)<\/style>/.exec(src)![1]!.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /(?:^|\})\s*\.notes\s*\{([^}]*)\}/.exec(style)?.[1] ?? "";
    expect(rule).toMatch(/max-height:\s*calc\(4 \* 1\.4em\);/);
    expect(rule).toMatch(/line-height:\s*1\.4;/);
    expect(rule).not.toMatch(/(?:padding|border):/);
    expect(rule).toMatch(/overflow-y:\s*auto;/);
    const focusRule = /(?:^|\})\s*\[role="region"\]:focus-visible\s*\{([^}]*)\}/.exec(style)?.[1] ?? "";
    expect(focusRule).toMatch(/outline:\s*2px solid var\(--accent\);/);
    expect(focusRule).toMatch(/outline-offset:\s*2px;/);
    expect(src).not.toMatch(/\sstyle[=:]/);
  });

  /* by source: what a click and a reply do */

  const DIR = new URL("../src/lib/deck/", import.meta.url);
  const code = (name: string): string =>
    readFileSync(new URL(name, DIR), "utf8")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1")
      .replace(/(^|[ \t])\/\/[^\n]*/gm, "$1")
      .replace(/\s+/g, " ");

  test("H1/H2: JoinButton wires the pure handle-bound flow, renders reply text and disposes it on close", () => {
    const j = code("JoinButton.svelte");
    expect(j).toContain("const current = $derived(joinHandle(model, handle));");
    expect(j).toContain("$effect(() => { const h = handle; untrack(() => (model = joinHandle(model, h))); });");
    expect(j).toContain("const result = joinClick(joinHandle(model, handle), yes);");
    expect(j).toContain("if (result.call !== null) void send(result.call);");
    expect(j).toContain("onclick={() => join()}");
    expect(j).toContain("<AskFirst question={current.state.question} onyes={() => join(true)} onno={dismiss} />");
    expect(j.match(/calendarJoin\(/g)).toHaveLength(1);
    expect(j).toContain("reply = await calendarJoin(call.handle, call.confirmed);");
    expect(j).toContain("const result = joinReply(joinHandle(model, handle), call, reply);");
    expect(j).toContain("const result = joinReply(joinHandle(model, handle), call, reply); model = result.model;");
    expect(j).toContain("if (result.stale) stale?.onStale();");
    expect(j).toContain('if (closed) return;');
    expect(j).toContain('onDestroy(() => { closed = true; model = idleJoin(handle); });');
    expect(j).toContain('function dismiss(): void { model = dismissJoin(current); focusJoin(); }');
    expect(j).toContain('{:else if current.state.kind === "failed"} <p class="reply">{current.state.line}</p>');
    expect(j).not.toContain("aria-live");
  });

  test("L5: MeetingCard wires each independent safety guard and drops details on close", () => {
    const c = code("MeetingCard.svelte");
    expect(c.match(/calendarDetailsGet\(/g)).toHaveLength(1);
    expect(c).toContain('const step = cardDetailsReply(h, card, view.pageDate, reply, Date.now());');
    expect(c).toContain('if (step.kind === "stale") { stale?.onStale(); return; }');
    expect(c).toContain('if (step.kind === "details") details = step.details;');
    expect(c).toContain('details = resetCardDetails(details, h);');
    expect(c).toContain('$effect(() => { details = expireCardDetails(details, now); });');
    expect(c).toContain('const shown = $derived(shownCardDetails(details, handle, now));');
    expect(c).toContain('function close(): void { closed = true; details = null; onclose(); }');
    expect(c).toContain('onDestroy(() => { closed = true; details = null; });');
    expect(c).toContain('if (closed) return;');
    const s = code("CalendarSlide.svelte");
    expect(s).toContain('{#key openGeneration} <MeetingCard id={cardId} view={v} key={openKey} {now} onclose={closeCard} /> {/key}');
    expect(code("Deck.svelte")).toContain('const live = $derived(view.kind === "slides" ? view.live : null);');
    expect(code("Deck.svelte")).toContain("<CalendarSlide calendar={page.calendar} {live} {now} active={armed && i === nav.index} />");
  });

  test("page replacement: carries only on row content changes, with the current live view and no remount", () => {
    const s = code("CalendarSlide.svelte");
    expect(s).toMatch(/import \{[^}]*\bcarryOpenKey\b[^}]*\} from "\.\.\/calendar-detail";/);
    expect(s).toContain('const rowTexts = $derived(rows.map((r) => r.text));');
    expect(s).toContain('let previousRows = untrack(() => rowTexts);');
    expect(s).toContain('$effect.pre(() => { const after = rowTexts; untrack(() => { if (previousRows.length === after.length && previousRows.every((text, i) => text === after[i])) return; const next = carryOpenKey(openKey, previousRows, after, v); if (openKey !== null && next === null && cardSlot?.contains(document.activeElement)) restoreFocus(); openKey = next; previousRows = after; }); });');
    // Only the declaration, page replacement, explicit close and click write the stored key. Live re-reads do not.
    expect(s.match(/\bopenKey = /g)).toHaveLength(4);
    expect(s).toContain('let openGeneration = $state(0);');
    expect(s).toContain('{#key openGeneration} <MeetingCard id={cardId} view={v} key={openKey} {now} onclose={closeCard} /> {/key}');
    expect(s).not.toContain('{#key openKey}');
    // Only user close/toggle changes the mount generation; carries leave details, Join confirmation and focus intact.
    expect(s.match(/openGeneration\+\+/g)).toHaveLength(2);
    expect(s).toContain('function closeCard(): void { openKey = null; openGeneration++; restoreFocus(); }');
    expect(s).toContain('opener = button; openKey = next; openGeneration++;');
  });

  test("page replacement: restore focus only when a carry closes a card containing focus, with a heading fallback", () => {
    const s = code("CalendarSlide.svelte");
    expect(s).toContain('let heading = $state<HTMLHeadingElement | null>(null);');
    expect(s).toContain('let cardSlot = $state<HTMLDivElement | null>(null);');
    expect(s).toContain('<h2 tabindex="-1" use:focusHeading={active} bind:this={heading}>');
    expect(s).toContain('<div class="card-slot" bind:this={cardSlot}>');
    expect(s).toContain('if (openKey !== null && next === null && cardSlot?.contains(document.activeElement)) restoreFocus();');
    expect(s).toContain('function restoreFocus(): void { const target = opener; queueMicrotask(() => { if (target?.isConnected) target.focus({ preventScroll: true }); else if (heading?.isConnected) heading.focus({ preventScroll: true }); }); }');
  });

  test("M5: Close/Escape return focus to the opener; Yes/No/Escape to Join; toggles control the card", () => {
    const s = code("CalendarSlide.svelte"), c = code("MeetingCard.svelte"), j = code("JoinButton.svelte");
    expect(s).toContain('opener = button;');
    expect(s).toContain('const target = opener; queueMicrotask(() => { if (target?.isConnected) target.focus({ preventScroll: true }); else if (heading?.isConnected) heading.focus({ preventScroll: true }); });');
    expect(s.match(/aria-controls=\{cardId\}/g)).toHaveLength(3);
    // Near-duplicates (spec §5 "Slide state"): each toggle and each aria-expanded carries the item's row identity, and
    // both delegate to the pure open-state helpers, passing the view (none open with no view).
    expect(s).toContain('toggle(item.text, item.live, item.row, e.currentTarget)');
    expect(s).toContain('toggle(next.rowText, next.live, next.row, e.currentTarget)');
    expect(s).toContain('toggle(b.e.rowText, b.e.live, b.e.row, e.currentTarget)');
    expect(s).toContain('aria-expanded={isOpen(item.text, item.live, item.row)}');
    expect(s).toContain('aria-expanded={isOpen(next.rowText, next.live, next.row)}');
    expect(s).toContain('aria-expanded={isOpen(b.e.rowText, b.e.live, b.e.row)}');
    expect(s).toContain('const clicked: CardKey = { rowText, handle: e?.handle ?? null, row };');
    expect(s).toContain('const next = v === null ? clicked : toggleOpenCard(openKey, clicked, v);');
    expect(s).toContain('if (next === null) { closeCard(); return; }');
    expect(s).toContain('v !== null && sameOpenCard(openKey, { rowText, handle: e?.handle ?? null, row }, v);');
    expect(s).not.toMatch(/openKey\.rowText|openKey = \{ rowText/);
    expect(c).toContain('<section {id} class="card" aria-label={facts.title}>');
    expect(c).toContain('<ActionButton onclick={close}>Close</ActionButton>');
    expect(c).toContain('<svelte:window {onkeydown} />');
    expect(c).toContain('if (!e.defaultPrevented && e.key === "Escape") { e.preventDefault(); close(); }');
    expect(j).toContain('if (yes) focusJoin();');
    expect(j).toContain('queueMicrotask(() => { if (button?.isConnected) button.focus({ preventScroll: true }); });');
    expect(j).toContain('aria-disabled={current.busy} bind:this={button}');
    expect(j).toContain('onkeydown={onkeydown}');
    expect(j).toContain('if (e.key === "Escape" && current.state.kind === "asking") { e.preventDefault(); e.stopPropagation(); dismiss(); }');
    expect(j).not.toContain(' disabled={current.busy}');
  });

  test("L3: the card passes the webview OS into the pure Open in Calendar rule", () => {
    const c = code("MeetingCard.svelte");
    expect(c).toContain('osFromUserAgent(navigator.userAgent)');
    expect(c).toContain('openInCalendar(view, card, os)');
  });

  test("M4: strip-only days show no subtitle; the render respects the model's null", () => {
    for (const d of [NO_DETAIL, detailOf([live(OFFSITE)])]) {
      const html = slideOf(textOf([OFFSITE]), d, at(8));
      expect(html).toContain("Offsite");
      expect(sub(html)).toBeNull();
      expect(html).not.toContain("No events today");
    }
    expect(code("CalendarSlide.svelte")).toContain('const showSub = $derived(sub !== null && v !== null');
    expect(code("CalendarSlide.svelte")).toContain('{#if showSub}<p class="sub">{sub}</p>{/if}');
  });

  test("L5/W16: the next-meeting bar never draws Join for a live event without a usable link", () => {
    const html = slideOf(textOf([STANDUP]), detailOf([live(STANDUP)]), at(9, 10));
    expect(html).toContain('class="next');
    expect(html).toContain('Standup');
    expect(html).not.toContain('Join ↗');
  });

  /* C-M5-T14: Join on the launchpad's meeting tile; the tiles follow the live events */

  function deckWith(text: string, d: CalendarDetail, now: number): string {
    const model = modelOf({ latest: loaded(text) });
    const deck = deckView({ model, today: TODAY, firstName: null, calendarDetail: d });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return normalise(render(DeckOrClassic as any, { props: { model, deck, now, briefingKey: briefingHash(text), slides: true, ...RUN, onhistory: () => {} } }).body);
  }
  const launchpadOf = (html: string): string => {
    const from = html.search(/You(&#39;|')re all set/);
    expect(from).toBeGreaterThan(-1);
    return html.slice(from);
  };
  const glance = (html: string): string =>
    /<p class="caps[^"]*">(Now|Next meeting)<\/p> <p class="tile-text[^"]*">([^<]*)<\/p>/.exec(html)?.slice(1).join(" | ") ?? "";

  test("C-M5-T14: the tile's Join: \"Join ↗\" before the meeting, \"Join now on {name} ↗\" with the outline and the dot while it is on", () => {
    const text = textOf([STANDUP]);
    const zoom = detailOf([live(STANDUP, { linkState: "one", joinHost: "zoom.us" })]);
    const soon = launchpadOf(deckWith(text, zoom, at(8, 50)));
    expect(soon).toMatch(/<p class="label[^"]*">\s*In 10 minutes\s*<\/p>/);
    expect(soon).toContain(">Join ↗</button>");
    expect(soon).not.toContain("Join now on");
    const on = launchpadOf(deckWith(text, zoom, at(9, 10)));
    expect(on).toMatch(/<section class="tile[^"]* live[^"]*">/);
    expect(on).toMatch(/<span class="pulse[^"]*"><\/span>Now/);
    expect(on).toContain(">Join now on Zoom ↗</button>");
    const whereby = detailOf([live(STANDUP, { linkState: "one", joinHost: "whereby.com", serviceName: "Whereby", needsConfirm: true })]);
    expect(launchpadOf(deckWith(text, whereby, at(9, 10)))).toContain(">Join now on Whereby ↗</button>");
    const other = detailOf([live(STANDUP, { linkState: "one", joinHost: "meet.example.org", needsConfirm: true })]);
    expect(launchpadOf(deckWith(text, other, at(9, 10)))).toContain(">Join now on meet.example.org ↗</button>");
    // No usable link (none, or several): A's tile, no Join.
    expect(launchpadOf(deckWith(text, detailOf([live(STANDUP, { linkState: "several" })]), at(9, 10)))).not.toContain("Join");
  });

  test("C-M5-T14: before the first read the tile is A's, with no Join; after a whole-read failure too", () => {
    const text = textOf([STANDUP]);
    const before = launchpadOf(deckWith(text, NO_DETAIL, at(8, 50)));
    expect(before).toMatch(/<p class="label[^"]*">\s*In 10 minutes\s*<\/p>/);
    expect(before).not.toContain("Join");
    const failed = launchpadOf(deckWith(text, detailOf([], [source("macos", "timeout")]), at(8, 50)));
    expect(failed).toMatch(/In 10 minutes/);
    expect(failed).not.toContain("Join");
  });

  test("C-M5-T14: a meeting cancelled since the page leaves the tile, and Good morning's tile follows the live events", () => {
    const text = textOf([STANDUP, LUNCH]);
    const before = deckWith(text, NO_DETAIL, at(8, 50));
    expect(glance(before)).toBe("Next meeting | 09:00 · Standup (Room 4)");
    expect(launchpadOf(before)).toContain("A meeting is coming up.");
    const read = deckWith(text, detailOf([live(LUNCH)]), at(8, 50));
    expect(glance(read)).toBe("Next meeting | 13:00 · Lunch");
    const pad = launchpadOf(read);
    expect(pad).not.toContain('class="tile');
    expect(pad).toContain("Nothing needs you right now.");
    // A meeting that is new since the page appears.
    const added = { ...base, time: { kind: "timed", startMs: at(9, 0), endMs: at(9, 45) }, title: "New sync" } as CalendarStructEvent;
    expect(launchpadOf(deckWith(text, detailOf([live(added), live(LUNCH)]), at(8, 50)))).toContain("New sync");
  });

  test("C-M5-T14 by source: the tile's Join through JoinButton; the launchpad's and Good morning's tiles from tileEvents", () => {
    const t = code("MeetingTile.svelte");
    expect(t).toContain('const joinLabel = $derived(live === null || live === undefined ? null : tileJoinLabel(live, tile.state === "now"));');
    expect(t).toContain("{#if live !== null && live !== undefined && joinLabel !== null} <div class=\"join\"><JoinButton handle={live.handle} label={joinLabel} /></div> {/if}");
    const l = code("Launchpad.svelte");
    expect(l).toContain("meetingTile(page.pageDate, tileEvents(page, live ?? null), now)");
    expect(l).toContain("<MeetingTile {tile} live={liveOf(live ?? null, tile.event)} />");
    const d = code("Deck.svelte");
    expect(d).toContain("glanceMeeting(page.pageDate, tileEvents(page, live), now)");
    expect(d).toContain("<Launchpad {page} {now} {git} {actions} {live} {calendarDay} active={armed && i === nav.index} {onfull} {onhistory} />");
  });

  test("only the card and Join name the card's wrappers; nothing in them builds a link", () => {
    const root = new URL("../src/", import.meta.url).pathname;
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(`${dir}${d.name}/`) : /\.(ts|svelte)$/.test(d.name) ? [`${dir}${d.name}`] : []));
    const naming = (re: RegExp): string[] => walk(root).filter((p) => re.test(readFileSync(p, "utf8"))).map((p) => p.slice(root.length)).sort();
    expect(naming(/\bcalendarJoin\(/)).toEqual(["lib/deck/JoinButton.svelte", "lib/engine.ts"]);
    expect(naming(/\bcalendarDetailsGet\(/)).toEqual(["lib/deck/MeetingCard.svelte", "lib/engine.ts"]);
    expect(naming(/\bcalendarAppOpen\(/)).toEqual(["lib/deck/MeetingCard.svelte", "lib/engine.ts"]);
    for (const f of ["CalendarSlide.svelte", "MeetingCard.svelte", "JoinButton.svelte", "AskFirst.svelte", "MeetingDetails.svelte"]) {
      expect({ f, sinks: /\{@html|<a[\s>]|href|innerHTML|window\.open/.test(code(f)) }).toEqual({ f, sinks: false });
    }
  });

  /* near-duplicates (spec §6): the merge mark, drawn in words at both sites */

  const CALS = { ...STANDUP, merged: { mark: "calendars", count: 3 } } as CalendarStructEvent;
  const COPIES = { ...REVIEW, merged: { mark: "copies", count: 2 } } as CalendarStructEvent;

  test("R05: near-duplicates: the slide's .what span says \" · on N calendars\" and \" · N copies\" (before tentative), never an object", () => {
    const text = textOf([CALS, COPIES]);
    const before = slideOf(text, NO_DETAIL, at(8, 30));
    expect(before).toMatch(/<span class="what[^"]*">Standup \(Room 4\) · on 3 calendars<\/span>/);
    expect(before).toMatch(/<span class="what[^"]*">Design review · 2 copies · tentative<\/span>/);
    // Read live: the live event's own rowText gives the marks, so a changed count shows the live one.
    const read = slideOf(text, detailOf([live(CALS), live({ ...COPIES, merged: { mark: "copies", count: 12 } } as CalendarStructEvent)]), at(8, 30));
    expect(read).toMatch(/<span class="what[^"]*">Standup \(Room 4\) · on 3 calendars<\/span>/);
    expect(read).toMatch(/<span class="what[^"]*">Design review · 12 copies · tentative<\/span>/);
    for (const html of [before, read]) {
      expect(html).not.toContain("[object Object]");
      expect(html).not.toMatch(/calendars · on|copies · \d+ copies|copies · on|calendars · \d+ copies/);   // drawn once, never twice
    }
  });

  test("R05: near-duplicates: the card's .when line says \" · on N calendars\" and \" · N copies\" (before tentative), never an object", () => {
    const text = textOf([CALS, COPIES]);
    const d = detailOf([live(CALS), live(COPIES)]);
    const cals = cardHtml(text, d, row(0));
    const copies = cardHtml(text, d, row(1));
    const loading = cardHtml(text, { ...NO_DETAIL, pending: true }, row(1));
    expect(cals).toMatch(/<p class="when[^"]*">09:00–09:30 · on 3 calendars<\/p>/);
    expect(copies).toMatch(/<p class="when[^"]*">11:00–12:00 · 2 copies · tentative<\/p>/);
    expect(loading).toMatch(/<p class="when[^"]*">11:00–12:00 · 2 copies · tentative<\/p>/);
    // The mark stays out of the card's title (its aria-label and heading).
    expect(cals).toMatch(/<section class="card[^"]*" aria-label="Standup">/);
    // A page card (loading, and before any read) takes its aria-label from the row's text, the merge mark stripped.
    expect(loading).toMatch(/<section class="card[^"]*" aria-label="Design review">/);
    expect(cardHtml(text, NO_DETAIL, row(0))).toMatch(/<section class="card[^"]*" aria-label="Standup \(Room 4\)">/);
    for (const html of [cals, copies, loading]) expect(html).not.toContain("[object Object]");
  });

  test("R08: a key-c merged event is ONE block with \" · on N calendars\", full width, and counts once in the subtitle", () => {
    const text = textOf([CALS]);
    for (const [d, label] of [[NO_DETAIL, "before"], [detailOf([live(CALS)]), "read"]] as const) {
      const slide = slideOf(text, d, at(8, 30));
      expect({ label, blocks: count(slide, '<button type="button" class="block event') }).toEqual({ label, blocks: 1 });
      expect(slide).toMatch(/<span class="what[^"]*">Standup \(Room 4\) · on 3 calendars<\/span>/);
      expect(slide).toMatch(/style="--top: 10; --h: 5; --lane: 0; --lanes: 1; --lines: 1;?"/);
      expect(sub(slide)).toBe("1 event · 30m in meetings · next in 30 minutes");
    }
  });

  test("near-duplicates (plan risk 9) by source: both mark loops key on a string, never on the mark object", () => {
    const slide = code("CalendarSlide.svelte");
    const card = code("MeetingCard.svelte");
    expect(slide).toContain('{#each marksOf(b.e.rowText) as mark (typeof mark === "string" ? mark : mark.kind)}{` · ${markWords(mark)}`}{/each}');
    expect(card).toContain('{#each facts.marks as mark (typeof mark === "string" ? mark : mark.kind)}{` · ${markWords(mark)}`}{/each}');
    for (const s of [slide, card]) expect(s).not.toMatch(/as mark \(mark\)/);
  });
});

/* ── PB-M4-T3: a live calendar day on screen, and Today's wiring (wave-2 polish spec §5) ───────────── */

describe("PB-M4-T3: a live calendar day on screen", () => {
  const DIR = new URL("../src/lib/deck/", import.meta.url);
  /** A source as code: comments removed, whitespace runs as one space. */
  const code = (name: string): string =>
    readFileSync(new URL(name, DIR), "utf8")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1")
      .replace(/(^|[ \t])\/\/[^\n]*/gm, "$1")
      .replace(/\s+/g, " ");
  const at = (h: number, m = 0): number => new Date(2026, 9, 16, h, m).getTime();
  const NO_SECTION = page({ recap: [{ repo: "app", text: "live day", evidence: "a1b2c3d" }] });
  const OK: CalendarDetailsSource = { id: "macos", kind: "macos", status: "ok", skipped: false, last: null };
  const failedSource = (id: string, status: string): CalendarDetailsSource => ({ id, kind: id === "macos" ? "macos" : "link", status, skipped: false, last: null });
  const standup: CalendarDetailsEvent = {
    handle: "g.1.h", title: "Standup", location: null, rowText: "09:00–09:30  Standup",
    time: { kind: "timed", startMs: at(9), endMs: at(9, 30) }, status: "confirmed", ended: false,
    linkState: "none", joinHost: null, needsConfirm: false, fromMac: true,
  };
  const listOf = (events: CalendarDetailsEvent[], sources: CalendarDetailsSource[] = [OK]): CalendarDetail => ({
    ...NO_DETAIL, list: { readAt: new Date(at(8, 20)).toISOString(), readerOutdated: false, events, sources },
  });
  /** The whole Today deck, as Today builds it, on `text` with the store's "on" and a calendar detail. */
  function liveDeck(text: string, d: CalendarDetail, calendarOn: boolean, now = at(8, 30)): string {
    const model = modelOf({ latest: loaded(text) });
    const deck = deckView({ model, today: TODAY, firstName: null, calendarDetail: d, calendarOn });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return normalise(render(DeckOrClassic as any, { props: { model, deck, now, briefingKey: briefingHash(text), slides: true, ...RUN, onhistory: () => {} } }).body);
  }
  /** The calendar slide's markup, found by its `data-slide` (the selector Today uses), up to the next slide. */
  function calendarSlide(html: string): string {
    const from = html.indexOf('data-slide="calendar"');
    expect(from).toBeGreaterThan(-1);
    const next = html.indexOf('<div class="slide', from);
    return html.slice(from, next === -1 ? undefined : next);
  }

  test("server render: every slide div exposes its SlideId (appended after its existing attributes), and the calendar selector finds the calendar slide", () => {
    const html = liveDeck(NO_SECTION, NO_DETAIL, true);
    for (const id of ["goodMorning", "whatYouDid", "leftOff", "suggested", "calendar", "launchpad"]) {
      expect({ id, n: count(html, `data-slide="${id}"`) }).toEqual({ id, n: 1 });
    }
    expect(html).toMatch(/aria-label="Slide 5 of 6" data-slide="calendar"/);
    expect(calendarSlide(html)).toMatch(/<h2[^>]*>Today(&#39;|')s calendar<\/h2>/);
  });

  test("render: a null section draws \"Today's calendar\" and the no-section line; waiting, failed, noneConnected and allFailed each show their line and NO \"No events today\" anywhere", () => {
    const cases: [string, CalendarDetail, string][] = [
      ["waiting", NO_DETAIL, LOADING_LINE],
      ["failed", { ...NO_DETAIL, failed: true }, READ_FAILED_LINE],
      ["noneConnected", listOf([], []), CALENDAR_NOT_CONNECTED_TEXT],
      ["allFailed", listOf([], [failedSource("macos", "timeout")]), CALENDAR_UNAVAILABLE_TEXT],
    ];
    for (const [state, d, line] of cases) {
      const html = liveDeck(NO_SECTION, d, true);
      const slide = calendarSlide(html);
      expect({ state, heading: /Today(&#39;|')s calendar/.test(slide) }).toEqual({ state, heading: true });
      expect({ state, line: slide.includes(`<p class="line`) && slide.includes(line) }).toEqual({ state, line: true });
      expect({ state, none: html.includes("No events today") }).toEqual({ state, none: false });
    }
  });

  test("render: an answered empty day says \"No events today\" exactly once (subtitle and lines together)", () => {
    const html = liveDeck(NO_SECTION, listOf([]), true);
    expect(count(calendarSlide(html), "No events today")).toBe(1);
    expect(count(html, "No events today")).toBe(1);
  });

  test("the launchpad's tile, its mood line and Good morning's next meeting follow the live read on a live day; before a good read, the calendar's line, never \"Nothing needs you right now.\"", () => {
    const read = liveDeck(NO_SECTION, listOf([standup]), true);
    const pad = slideOf(read, LAUNCHPAD);
    expect(pad).toContain("Standup");
    expect(slideOf(read, GOOD_MORNING)).toContain("Next meeting");
    for (const [d, line] of [[NO_DETAIL, LOADING_LINE], [{ ...NO_DETAIL, failed: true }, READ_FAILED_LINE], [listOf([], []), CALENDAR_NOT_CONNECTED_TEXT], [listOf([], [failedSource("macos", "denied")]), CALENDAR_UNAVAILABLE_TEXT]] as const) {
      const html = liveDeck(NO_SECTION, d, true);
      const lp = slideOf(html, LAUNCHPAD);
      expect({ line, mood: lp.includes(`<p class="mood`) && /<p class="mood[^"]*">([^<]*)<\/p>/.exec(lp)?.[1] }).toEqual({ line, mood: line });
      expect({ line, quiet: lp.includes("Nothing needs you right now.") }).toEqual({ line, quiet: false });
      expect({ line, gm: slideOf(html, GOOD_MORNING).includes("Next meeting") }).toEqual({ line, gm: false });
    }
  });

  test("\"on\" false (and off at app start, until status answers): no live-day slide, no live read surfaces; a section slide keeps \"Calendar is off\" after a refusal", () => {
    const off = liveDeck(NO_SECTION, NO_DETAIL, false);
    expect(off).not.toContain('data-slide="calendar"');
    expect(off).not.toContain(LOADING_LINE);
    // The slide leaving lands on a neighbour (§3: remapOnList — the launchpad takes the calendar slide's place).
    const six = ["goodMorning", "whatYouDid", "leftOff", "suggested", "calendar", "launchpad"] as const;
    const five = ["goodMorning", "whatYouDid", "leftOff", "suggested", "launchpad"] as const;
    expect(remapOnList(six, 4, five)).toEqual({ index: 4, kind: "removed" });
    // A page with a section: the slide stays, with C's off line after a calendar-off refusal.
    const section = page({ calendar: { events: [], sources: [{ id: "macos", kind: "macos", status: "ok" }], incomplete: false } } as Partial<EngineStruct>);
    const refused = liveDeck(section, { ...NO_DETAIL, off: true }, false);
    expect(calendarSlide(refused)).toContain(OFF_LINE);
    // …and never OFF_LINE before a refusal, "on" unknown or not.
    expect(liveDeck(section, NO_DETAIL, false)).not.toContain(OFF_LINE);
  });

  test("source: Deck gates the next meeting on today's page with the calendar slide; draws CalendarSlide whenever the slide is in the list; Launchpad gates its tile on calendarDay", () => {
    const d = code("Deck.svelte");
    expect(d).toContain('const calendarDay = $derived(view.kind === "slides" && view.slides.includes("calendar"));');
    expect(d).toContain("const meeting = $derived(page !== null && !page.stale && calendarDay ? glanceMeeting(page.pageDate, tileEvents(page, live), now) : null);");
    expect(d).toContain('{:else if page !== null && id === "calendar"} <CalendarSlide calendar={page.calendar} {live} {now} active={armed && i === nav.index} />');
    expect(d).toContain('aria-label={`Slide ${i + 1} of ${count}`} data-slide={id}>');
    const l = code("Launchpad.svelte");
    expect(l).toContain("const tile = $derived(calendarDay && !page.stale ? meetingTile(page.pageDate, tileEvents(page, live ?? null), now) : null);");
    expect(l).toContain('import { liveDayLine, liveOf, tileEvents, type CalendarDetailView } from "../calendar-detail";');
    const c = code("CalendarSlide.svelte");
    expect(c).toContain("calendar: CalendarSlide | null;");
    expect(c).toContain(`{calendar !== null && calendar.stale ? "Calendar" : "Today's calendar"}`);
  });

  test("source: Today follows the store in a new onMount after the existing ones; the store derivation is aliased so `calendarOn` is the local boolean; one effect calls onCalendarOn when \"on\" turns true", () => {
    const t = code("../../routes/Today.svelte");
    expect(t).toContain("let store = $state.raw(todayStore());");
    expect(t).toContain("const calendarOn = $derived(storeCalendarOn(store.status));");
    expect(t).not.toMatch(/import \{[^}]*\bcalendarOn\b(?! as)[^}]*\} from "\.\.\/lib\/today-store"/);
    const sub = t.indexOf("onMount(() => onTodayStore((s) => (store = s)));");
    expect(sub).toBeGreaterThan(-1);
    for (const earlier of ["onMount(() => { prefs = appPrefs();", "onMount(() => { mounted = true;", "onMount(() => () => git.dispose());", "onMount(() => () => cal.dispose());", "onMount(() => () => reads.dispose());"]) {
      expect({ earlier, after: t.indexOf(earlier) > -1 && sub > t.indexOf(earlier) }).toEqual({ earlier, after: true });
    }
    expect(t).toContain("$effect(() => { const on = calendarOn; untrack(() => { if (on && !shownOn) cal.onCalendarOn(deck); shownOn = on; }); });");
    expect(t).toContain("oncalendaroff: applyCalendarOff, sentGen: liveReadSent");
  });

  test("source: Today's one LiveRegion sits outside DeckOrClassic, fed through nextLiveText once per completed read, only when focus is inside [data-slide=\"calendar\"]", () => {
    const raw = readFileSync(new URL("../src/routes/Today.svelte", import.meta.url), "utf8");
    const markup = raw.slice(raw.indexOf("</script>"));
    expect(markup).toMatch(/<DeckOrClassic [^\n]*\/>\n<LiveRegion text=\{liveText\} \/>/);
    const t = code("../../routes/Today.svelte");
    expect(count(t, "<LiveRegion")).toBe(1);
    expect(t).toContain('import LiveRegion from "../lib/ui/LiveRegion.svelte";');
    expect(t).toContain(`document.querySelector('[data-slide="calendar"]')`);
    // PB-M4 checkpoint MED: the effect is one call of the pure step (calendar-detail.check.ts models it), verbatim.
    expect(t).toContain("let announcer: AnnounceState = ANNOUNCE_START;");
    expect(t).toContain(
      "$effect(() => { const pending = calendarDetail.pending; untrack(() => { const line = deck.kind === \"slides\" && deck.live !== null ? readStatusLine(deck.live, now) : null; const r = announceStep(announcer, pending, calendarSlideEl()?.contains(document.activeElement) === true, line); announcer = r.next; if (r.text !== null) liveText = nextLiveText(liveText, r.text); }); });",
    );
    expect(count(t, "announceStep(")).toBe(1);
    expect(t).not.toMatch(/\b(completions|wasPending)\b/);
  });
});

/* ── PB-M6-T3: the card on Today, Close, the land request (source pins and reachable renders; Today is not rendered) ── */

describe("PB-M6-T3: Today draws the card above the deck and lands the focus after Close or Not now", () => {
  const strip = (s: string): string =>
    s.replace(/<!--[\s\S]*?-->/g, "").replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1").replace(/(^|[ \t])\/\/[^\n]*/gm, "$1").replace(/\s+/g, " ");
  const RAW_TODAY = readFileSync(new URL("../src/routes/Today.svelte", import.meta.url), "utf8");
  const T = strip(RAW_TODAY);
  const RAW_SHELL = readFileSync(new URL("../src/lib/deck/DeckOrClassic.svelte", import.meta.url), "utf8");
  const S = strip(RAW_SHELL);
  const RAW_VIEW = readFileSync(new URL("../src/routes/TodayView.svelte", import.meta.url), "utf8");

  test("the card: drawn above DeckOrClassic in normal flow (no wrapper, no key), from the production visibility helper with the link session as an input", () => {
    const markup = RAW_TODAY.slice(RAW_TODAY.indexOf("</script>")).replace(/<!--[\s\S]*?-->/g, "");
    expect(markup).toMatch(/\{#if card\.shown\}\n\s*<CalendarQuestion origin="today" \{os\} status=\{store\.status\} ask=\{card\.question\} onsession=\{\(open\) => \(linkSession = open\)\} onclose=\{closeCard\} \/>\n\{\/if\}\n<DeckOrClassic /);
    expect(markup).not.toContain("{#key");
    expect(T).toContain('import CalendarQuestion from "../lib/CalendarQuestion.svelte";');
    expect(T).toContain("const card = $derived(todayCard({ hasPage: briefingKey !== null, scheduleState: snapshot?.scheduleState, neverAsked: neverAsked(store.status), malformed: store.status !== null && malformed(store.status), os, closed, running: store.flow.running, result: store.flow.result, linkSession }));");
    expect(T).toContain("let linkSession = $state(false);");
    expect(T).toContain("let closed = $state(false);");
    expect(T).toContain("let land = $state(0);");
    // Close: hidden for this visit, and a land request.
    expect(T).toContain("function closeCard(): void { closed = true; land++; }");
  });

  test("Not now: Today's OWN subscription runs the production notNowEvent, seeded at script init, announcing through the one LiveRegion and landing once", () => {
    expect(T).toContain("let notNowSeen = todayStore().notNowSettled;");
    expect(T).toContain("onMount(() => onTodayStore((s) => { const step = notNowEvent(notNowSeen, s); notNowSeen = step.seen; if (!step.fire) return; liveText = nextLiveText(liveText, NOT_NOW_ANNOUNCEMENT); land++; }), );");
    expect(count(T, "notNowEvent(")).toBe(1);
    expect(T).not.toMatch(/answered/);                 // never inferred from flow.result.answered
    expect(count(T, "<LiveRegion")).toBe(1);
  });

  test("a Today result: marked drawn once when the card draws it, its line fed to the same LiveRegion; leaveToday on unmount", () => {
    expect(T).toContain('$effect(() => { const r = store.flow.result; if (!card.shown || r === null || r.origin !== "today" || r.drawn) return; untrack(() => { const line = markDrawn(); if (line !== null) liveText = nextLiveText(liveText, line); }); });');
    expect(T).toContain("onMount(() => () => leaveToday());");
  });

  test("lifecycle placement (§0.7): every new onMount after the existing ones; the svelte import, the tick and the prefs mounts unchanged", () => {
    expect(RAW_TODAY).toContain('  import { onMount, setContext, untrack } from "svelte";\n');
    const last = T.indexOf("onMount(() => onTodayStore((s) => (store = s)));");
    expect(last).toBeGreaterThan(-1);
    for (const added of ["onMount(() => onTodayStore((s) => { const step = notNowEvent(", "onMount(() => () => leaveToday());", "onMount(() => { summaryLive.onMount(); return () => summaryLive.dispose(); });"]) {
      expect({ added, after: T.indexOf(added) > last }).toEqual({ added, after: true });
    }
    expect(count(T, "onMount(")).toBe(10);
  });

  test("DeckOrClassic: the land prop before oncurrent; one effect commits null, awaits tick, then sets the target; the slides-off TodayView gets landHere", () => {
    expect(RAW_SHELL).toContain("    land?: number;\n");
    expect(S).toMatch(/let \{[^}]* onhistory, land = 0, oncurrent, onmove \}: Props = \$props\(\);/);
    expect(S).toContain("let landSeen = untrack(() => land);");
    expect(S).toContain("$effect(() => { const request = land; untrack(() => { const step = landRequestStep(landSeen, request, landTarget({ slides, kind: deck.kind, classic })); landSeen = step.seen; if (step.edges.length === 0) return; const target = step.edges[1]; landing = step.edges[0]; void tick().then(() => (landing = target)); }); });");
    expect(S).toContain('{#if !slides} <TodayView {model} {running} {progress} {runResult} {detailsOpen} {onrun} landHere={landing === "classicView"} />');
    // The other classic paths keep their own targets (the note, the Full briefing heading): no landHere there.
    expect(count(S, "landHere=")).toBe(1);
  });

  test("PB final R1 Y7: with the slides off a change leaves `landing` alone, so a landed \"Today\" heading keeps its tabindex (and focus) after a new briefing or a list change", () => {
    // With the slides off `landing` is only TodayView's landHere: afterChange returns before its null reset (the views'
    // wrapper is not drawn, so it could never set a target again). Real focus is the §0.8 click-through.
    expect(S).toContain("function afterChange(from: number, wasInside: boolean, onIndexChange: boolean): void { if (!slides) return; landing = null; const mine = ++change; if (!wasInside) return;");
    // No other writer: the declaration, afterChange's two, dispatch's and showClassic's (slides-on controls), and the land
    // request's two edges.
    expect(count(S, "landing = ")).toBe(7);
  });

  test("TodayView: the heading takes tabindex and focusHeading only when landHere (default false); the svelte-ignore comment right above; its style unchanged", () => {
    expect(RAW_VIEW).toContain('  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->\n  <h2 tabindex={landHere ? -1 : undefined} use:focusHeading={landHere}>Today</h2>\n');
    expect(RAW_VIEW).toContain("    landHere?: boolean;\n");
    expect(RAW_VIEW).toMatch(/let \{ model, running, progress, runResult, detailsOpen, onrun, landHere = false \}: Props = \$props\(\);/);
    expect(RAW_VIEW).toContain('import { focusHeading } from "../lib/ui/a11y";');
    // Reachable renders: landHere false is today's heading exactly; true adds tabindex only.
    const model = modelOf({ latest: loaded(RICH) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const off = render(TodayView as any, { props: { model, ...RUN } }).body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const on = render(TodayView as any, { props: { model, ...RUN, landHere: true } }).body;
    expect(off).toMatch(/<h2 class="svelte-1wrd726">Today<\/h2>/);
    expect(on).toMatch(/<h2 tabindex="-1" class="svelte-1wrd726">Today<\/h2>/);
    expect(on.replace(' tabindex="-1"', "")).toBe(off);
  });

  test("a late status answer (markup): DeckOrClassic sits outside the card's {#if}, unkeyed, so the card appearing above it never remounts it", () => {
    // The card takes no part in the deck's inputs (deckView reads no card state), so its arrival is no slide-list change;
    // keeping the slide and the focus is the §0.8 click-through ("Late card / minimum window").
    const markup = RAW_TODAY.slice(RAW_TODAY.indexOf("</script>"));
    expect(markup.indexOf("{/if}")).toBeLessThan(markup.indexOf("<DeckOrClassic"));
    expect(markup).not.toContain("{#key");
  });

  test("560×420: the card sits above the deck and never grows (flex: none in its own style); Deck's min-height is untouched", () => {
    const card = readFileSync(new URL("../src/lib/CalendarQuestion.svelte", import.meta.url), "utf8");
    expect(card.slice(card.indexOf("<style>"))).toMatch(/\.card \{[^}]*\bflex: none;/);
    expect(readFileSync(new URL("../src/lib/deck/Deck.svelte", import.meta.url), "utf8")).toMatch(/min-height: 14rem;/);
    expect(RAW_TODAY).not.toContain("<style>");
  });
});

/* ── B2-M6-T15: the buttons on screen. A server render runs no click, so each click's model is in actions.check.ts and
      its call site is pinned here by source. ── */
describe("B2-M6-T15: the opening controls", () => {
  type Handle = ActionCard["handles"][number];
  const h = (target: Handle["target"], handle: string, extra: Partial<Handle> = {}): Handle => ({ handle, target, row: null, sha: null, project: null, label: null, ...extra });
  const c = (cardKind: ActionCard["cardKind"], cardId: string, handles: Handle[], repoKey = "app"): ActionCard => ({ repoKey, cardKind, cardId, handles });
  const CARDS: ActionCard[] = [
    c("did", "app", [
      h("pr", "h-pr", { row: 0 }), h("commit", "h-commit", { row: 0, sha: sha("a1b2c3d") }), h("branch", "h-never-drawn", { row: 0 }),
      h("branch", "h-parser", { row: 2 }), h("commit", "h-parser-commit", { row: 2, sha: sha("e5f6a7b") }), h("branch", "h-main", { row: 3 }),
    ]),
    c("leftOff", "app", [h("branch", "h-left-branch"), h("compare", "h-compare", { label: "main" }), h("copy", "h-left-copy"), h("editor", "h-editor", { project: "p-app" })]),
    c("push", "push:app", [h("copy", "h-push-1"), h("copy", "h-push-2"), h("copy", "h-push-3")]),
    c("tile", "onlyHere", [h("copy", "h-tile-1"), h("copy", "h-tile-2"), h("copy", "h-tile-3")]),
  ];
  const input0 = (patch: Partial<ActionsInput> = {}): ActionsInput => ({ cards: CARDS, githubLinks: true, os: "macos", choices: new Map(), error: null, ...patch });
  const live = (o: Partial<GitDetailInput> = {}): GitDetailInput => gitInput(held(richReply()), o);
  function view(text: string, gitDetail: GitDetailInput, actions: ActionsInput) {
    const deck = deckView({ model: modelOf({ latest: loaded(text) }), today: TODAY, firstName: null, gitDetail, actions });
    if (deck.kind !== "slides") throw new Error(`expected slides, got ${deck.kind}`);
    return deck;
  }
  function html(text = B1_PAGE, gitDetail = live(), actions = input0(), now = B1_NOW): string {
    const model = modelOf({ latest: loaded(text) });
    const deck = deckView({ model, today: TODAY, firstName: null, gitDetail, actions });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return normalise(render(DeckOrClassic as any, { props: { model, deck, now, briefingKey: briefingHash(text), slides: true, ...RUN, onhistory: () => {} } }).body);
  }
  function what(text = B1_PAGE, gitDetail = live(), actions = input0(), open: string[] = ["app"]): string {
    const deck = view(text, gitDetail, actions);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return normalise(render(WhatYouDid as any, { props: { page: deck.page, open, active: false, ondispatch: () => {}, git: deck.git, actions: deck.actions } }).body);
  }
  const buttonsIn = (s: string): string[] => [...s.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => words(m[1]!));
  const ACTION_WORDS = /Open PR|Open branch|Open on GitHub|Compare with|Copy push command|Open in |Resume ·/;
  const SOURCE = (name: string): string => readFileSync(new URL(`../src/lib/deck/${name}`, import.meta.url), "utf8");

  describe("What you did", () => {
    test("each row kind's control sits outside <summary>; a row with no handle has none, and What you did never draws Copy", () => {
      const out = what();
      for (const summary of out.matchAll(/<summary>([\s\S]*?)<\/summary>/g)) expect(summary[1]).not.toContain("<button");
      expect(buttonsIn(out).filter((b) => b.startsWith("Open PR"))).toEqual(["Open PR ↗"]);
      expect(buttonsIn(out).filter((b) => b.startsWith("Open branch"))).toEqual(["Open branch ↗", "Open branch ↗"]); // fix/parser and main; the never-pushed spike has none.
      expect(out).not.toContain("Copy push command");
      expect(out).not.toContain("h-never-drawn");
    });
    test("a commit's arrow is named Open on GitHub and sits on its own commit, inside the disclosure", () => {
      const out = what();
      expect(count(out, 'aria-label="Open on GitHub"')).toBe(2);
      const rows = rowsOf(out);
      expect(rows[0]).toContain('aria-label="Open on GitHub"');
      expect(rows[1]).not.toContain('aria-label="Open on GitHub"');
      expect(rows[2]).toContain('aria-label="Open on GitHub"');
      expect(rows[3]).not.toContain('aria-label="Open on GitHub"');
    });
    test.each(["tag", "detached", "orphan"] as const)("a %s row has no row control", (kind) => {
      const row: ReplyRow = kind === "tag" ? { kind, name: "v1", commits: [cited("a1b2c3d")] } : { kind, commits: [cited("a1b2c3d")] };
      const reply = richReply() as ReposAllReply;
      const gitDetail = gitInput(held({ ...reply, labels: [gitLabel("app", "app", [row])] }));
      const out = what(B1_PAGE, gitDetail, input0({ cards: [c("did", "app", [h("branch", "h-b", { row: 0 }), h("pr", "h-p", { row: 0 })])] }));
      expect(buttonsIn(out).filter((b) => ACTION_WORDS.test(b))).toEqual([]);
    });
    test("links off draws no GitHub button", () => {
      expect(buttonsIn(what(B1_PAGE, live(), input0({ githubLinks: false }))).filter((b) => ACTION_WORDS.test(b))).toEqual([]);
      expect(what(B1_PAGE, live(), input0({ githubLinks: false }))).not.toContain("Open on GitHub");
    });
    test("with no actions the rows draw exactly as B1 drew them", () => {
      const deck = view(B1_PAGE, live(), input0());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bare = normalise(render(WhatYouDid as any, { props: { page: deck.page, open: ["app"], active: false, ondispatch: () => {}, git: deck.git } }).body);
      expect(rowsOf(bare).join()).not.toContain("<button");
    });
  });

  describe("Where you left off", () => {
    const left = (actions = input0(), gitDetail = live(), text = B1_PAGE) => slideOf(html(text, gitDetail, actions), LEFT_OFF);
    test("Open branch, Compare with {label}, Copy, then the editor control", () => {
      expect(buttonsIn(left()).filter((b) => ACTION_WORDS.test(b))).toEqual(["Open branch ↗", "Compare with main", "Copy push command", "Open in editor…"]);
    });
    test("a stored editor is named; off macOS there is no editor control; Windows adds for Git Bash", () => {
      const named = buttonsIn(left(input0({ choices: new Map([["p-app", "cursor"]]) })));
      expect(named).toContain("Open in Cursor");
      expect(buttonsIn(left(input0({ os: "linux" }))).filter((b) => ACTION_WORDS.test(b))).toEqual(["Open branch ↗", "Compare with main", "Copy push command"]);
      expect(buttonsIn(left(input0({ os: "windows" })))).toContain("Copy push command for Git Bash");
    });
    test("links off keeps only copy and the editor; a remote-less repo keeps only the editor", () => {
      expect(buttonsIn(left(input0({ githubLinks: false }))).filter((b) => ACTION_WORDS.test(b))).toEqual(["Copy push command", "Open in editor…"]);
      const reply = richReply() as ReposAllReply;
      const noRemote = gitInput(held({ ...reply, repoViews: [gitRepo("app", { count: 2, noRemote: true }), gitRepo("lib")], branchLines: [{ key: "app", name: "spike/kelly", state: "noRemote" }] }));
      expect(buttonsIn(left(input0(), noRemote)).filter((b) => ACTION_WORDS.test(b))).toEqual(["Open in editor…"]);
    });
    test("the inventory's failure draws its fixed line; no raw text can come this way", () => {
      expect(left(input0({ error: "Could not list installed editors" }))).toContain(">Could not list installed editors</p>");
      expect(left()).not.toContain("Could not list");
    });
    test("the chooser is drawn inside the control's own component, with the flow's lines beside it", () => {
      const src = SOURCE("LeftOff.svelte");
      expect(src).toContain('import EditorChooser from "./EditorChooser.svelte";');
      expect(src).toContain("<EditorChooser ");
      expect(src).toContain("editors.click(");
      expect(src).toContain("e.altKey");
    });
  });

  describe("Suggested for today", () => {
    const withRef = (text: string) => page({ recap: [{ repo: "app", text: "merged", evidence: "a1b2c3d" }], branchState: [{ repo: "app", text: "On branch spike/kelly (ahead 2, behind 1)" }], resume: [{ repo: "app", text: "x" }], suggestions: [{ repo: "app", text }] });
    const sugg = (text: string, actions = input0()) => slideOf(html(withRef(text), live(), actions), SUGGESTED);
    test("the push card carries its Copy; at most one inline GitHub button on a suggestion", () => {
      const s = sugg("Review #12");
      expect(buttonsIn(s).filter((b) => ACTION_WORDS.test(b))).toEqual(["Copy push command", "Open PR ↗"]);
      expect(s.indexOf("Copy push command")).toBeLessThan(s.indexOf("<ol"));
      expect(s.indexOf("Open PR ↗")).toBeGreaterThan(s.indexOf("<ol"));
    });
    test("a push card with no copy handles keeps its card and text and draws no button", () => {
      const drawn = sugg("Review #12");
      const hidden = sugg("Review #12", input0({ cards: CARDS.filter((x) => x.cardKind !== "push") }));
      expect(buttonsIn(hidden).filter((b) => b === "Copy push command")).toEqual([]);
      expect(buttonsIn(hidden)).toContain("Open PR ↗"); // the control: only the copy goes
      const text = /<p class="text[^"]*">([\s\S]*?)<\/p>/.exec(drawn)![1]!;
      expect(text.length).toBeGreaterThan(0);
      expect(hidden).toContain(text);
      expect(count(hidden, 'class="push')).toBe(count(drawn, 'class="push'));
    });
    test("two targets, joined or not, give none; links off leaves the copy", () => {
      for (const text of ["Review #12/#13", "Review #12 and e5f6a7b"]) expect(buttonsIn(sugg(text)).filter((b) => b === "Open PR ↗")).toEqual([]);
      expect(buttonsIn(sugg("Review #12", input0({ githubLinks: false }))).filter((b) => ACTION_WORDS.test(b))).toEqual(["Copy push command"]);
    });
  });

  describe("the launchpad", () => {
    const pad = (actions = input0(), gitDetail = live(), text = B1_PAGE) => slideOf(html(text, gitDetail, actions), LAUNCHPAD);
    test("the order: B1's tiles, the overflow line, then Resume; Resume stays neutral and moves no B1 tile", () => {
      const reply = richReply() as ReposAllReply;
      const dirty = ["c", "d", "e", "f"].map((k) => gitRepo(k, { count: 2 }));
      const many = gitInput(held({ ...reply, repoViews: [gitRepo("app", { count: 2 }), gitRepo("lib"), ...dirty] }));
      const lp = pad(input0(), many);
      const at0 = (needle: string) => { const i = lp.indexOf(needle); expect(i).toBeGreaterThan(-1); return i; };
      expect(at0("Only on this Mac")).toBeLessThan(at0("Not committed"));
      expect(at0("Not committed")).toBeLessThan(at0("more repos not committed"));
      expect(at0("more repos not committed")).toBeLessThan(at0("Resume · app · Open in editor…"));
      expect(at0("Resume · app · Open in editor…")).toBeLessThan(at0("Full briefing"));
      expect(count(lp, ">Not committed</p>")).toBe(3);
      const tile = /<section class="tile[^"]*"[^>]*>(?:(?!<\/section>)[\s\S])*Resume ·(?:(?!<\/section>)[\s\S])*<\/section>/.exec(lp)![0];
      expect(tile.slice(0, tile.indexOf(">"))).not.toMatch(/\b(done|live)\b/);
    });
    test("the meeting tile comes first, and the heading is B1's with Resume showing", () => {
      const ev = { time: { kind: "timed", startMs: new Date(2026, 9, 16, 10, 10).getTime(), endMs: new Date(2026, 9, 16, 10, 30).getTime() }, title: "Standup", status: "confirmed", transparency: "busy", attendeeCount: 2 };
      const withCal = page({ recap: [{ repo: "app", text: "x", evidence: "a1b2c3d" }], branchState: [{ repo: "app", text: "On branch spike/kelly (ahead 2, behind 1)" }], resume: [{ repo: "app", text: "x" }], calendar: { events: [ev], sources: [{ id: "macos", kind: "macos", status: "ok" }], incomplete: false } } as Partial<EngineStruct>);
      const lp = pad(input0(), live(), withCal);
      expect(lp.indexOf("Standup")).toBeLessThan(lp.indexOf("Only on this Mac"));
      expect(lp.indexOf("Only on this Mac")).toBeLessThan(lp.indexOf("Resume · app"));
      const clean = gitInput(held({ ...(richReply() as ReposAllReply), repoViews: [gitRepo("app"), gitRepo("lib")], pushCards: [], tile: { commits: 0, branches: 0 } }));
      const allSet = pad(input0(), clean);
      expect(allSet).toMatch(/You(&#39;|')re all set/);
      expect(allSet).toContain("Resume · app · Open in editor…");
    });
    test("the tile's Copy is inside its own tile, on every platform; a stored editor names itself in Resume", () => {
      for (const [os, suffix, words0] of [["macos", "", "Only on this Mac"], ["linux", "", "Only on this computer"], ["windows", " for Git Bash", "Only on this computer"]] as const) {
        const lp = pad(input0({ os }), live({ os }));
        const tile = /<section class="tile[^"]*"[^>]*>(?:(?!<\/section>)[\s\S])*<\/section>/.exec(lp)![0];
        expect(tile).toContain(words0);
        expect(buttonsIn(tile)).toEqual([`Copy push command${suffix}`]);
        expect(lp.includes("Resume ·")).toBe(os === "macos");
      }
      expect(pad(input0({ choices: new Map([["p-app", "zed"]]) }))).toContain("Resume · app · Open in Zed");
    });
    test("the inventory's failure draws its fixed line under the Resume tiles", () => {
      expect(pad(input0({ error: "Could not list installed editors" }))).toMatch(/<p class="reply wide[^"]*">Could not list installed editors<\/p>/);
      expect(pad()).not.toContain("Could not list");
      expect(pad(input0({ os: "linux", error: "Could not list installed editors" }), live({ os: "linux" }))).not.toContain("Could not list");
    });
    test("no copy when the tile's list is not complete", () => {
      const cards = CARDS.map((x) => (x.cardKind === "tile" ? { ...x, handles: x.handles.slice(0, 1) } : x));
      expect(pad(input0({ cards }))).not.toContain("Copy push command");
    });
    test("a tile with no copy handles is its words and count, unchanged but for the button, and the push card keeps its own", () => {
      const tileOf = (s: string) => /<section class="tile[^"]*"[^>]*>(?:(?!<\/section>)[\s\S])*<\/section>/.exec(s)![0];
      const drawn = tileOf(pad());
      const hidden = tileOf(pad(input0({ cards: CARDS.filter((x) => x.cardKind !== "tile") })));
      expect(buttonsIn(drawn)).toEqual(["Copy push command"]);
      expect(buttonsIn(hidden)).toEqual([]);
      expect(hidden).toContain("Only on this Mac");
      expect(hidden).toContain("4 commits on 3 branches");
      expect(hidden.replace(/\s+/g, " ")).toBe(drawn.replace(/<button[\s\S]*?<\/button>/, "").replace(/\s+/g, " "));
      expect(buttonsIn(slideOf(html(B1_PAGE, live(), input0({ cards: CARDS.filter((x) => x.cardKind !== "tile") })), SUGGESTED))).toContain("Copy push command");
    });
    test("source: Resume after the overflow Tile, the chooser and the tile's copy in Launchpad, B1's order intact", () => {
      const src = SOURCE("Launchpad.svelte");
      const more = src.indexOf("{#if gitTiles.more !== null}");
      expect(more).toBeGreaterThan(src.indexOf("{#each gitTiles.tiles as t (t.key)}"));
      expect(src.indexOf("{#each resume as r (r.key)}")).toBeGreaterThan(more);
      expect(src).toContain("<EditorChooser ");
      expect(src).toContain("editors.click(r.key, r.button, e.altKey)");
    });
  });

  describe("older pages and no answer", () => {
    const older = page({ date: "2026-10-14", recap: [{ repo: "app", text: "merged", evidence: "a1b2c3d" }], branchState: [{ repo: "app", text: "On branch spike/kelly (ahead 2, behind 1)" }], resume: [{ repo: "app", text: "x" }], suggestions: [{ repo: "app", text: "Review #12" }] });
    test("an older page draws no action button on any slide", () => {
      const out = html(older);
      expect(buttonsIn(out).filter((b) => ACTION_WORDS.test(b))).toEqual([]);
      expect(out).not.toContain('aria-label="Open on GitHub"');
    });
    test("before B1 answers there is no action button", () => {
      expect(buttonsIn(html(B1_PAGE, gitInput(null))).filter((b) => ACTION_WORDS.test(b))).toEqual([]);
    });
  });

  describe("EditorChooser", () => {
    const chooser = (remember: boolean, selected: "vs-code" | "zed" = "zed") => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return normalise(render(EditorChooser as any, { props: { view: { state: "choose", editors: [{ editor: "vs-code", label: "VS Code" }, { editor: "zed", label: "Zed" }], selected, remember }, onopen: () => {}, oncancel: () => {} } }).body);
    };
    test("a native dialog with §0's words, and every action a real button", () => {
      const out = chooser(true);
      expect(out).toMatch(/^<dialog\b[^>]*\bopen\b/);
      expect(out).toContain(">Choose an editor</h3>");
      expect(words(out)).toContain("Editor");
      expect(words(out)).toContain("Always use this for this project");
      expect(buttonsIn(out)).toEqual(["Open", "Cancel"]);
      expect(out).not.toContain("<form");
    });
    test("the box starts as the model says, checked or unchecked", () => {
      expect(chooser(true)).toMatch(/<input type="checkbox"[^>]*\bchecked\b/);
      expect(chooser(false)).not.toMatch(/<input type="checkbox"[^>]*\bchecked\b/);
    });
    test("the preselected editor is the selected option, and only the reply's editors are listed", () => {
      expect(chooser(true, "zed")).toMatch(/<option[^>]*value="zed"[^>]*selected|<option[^>]*selected[^>]*value="zed"/);
      expect(chooser(true, "vs-code")).toMatch(/<option[^>]*value="vs-code"[^>]*selected|<option[^>]*selected[^>]*value="vs-code"/);
      expect(count(chooser(true), "<option")).toBe(2);
    });
    test("source: it only reports the answer; the IPC stays with the components that own the control", () => {
      const src = SOURCE("EditorChooser.svelte");
      expect(src).not.toMatch(/from "\.\.\/engine"|editorOpen|editorChoiceSet|editorList/);
      expect(src).toContain("onopen(editor, remember)");
    });
    test("source: Escape is heard on the window while it is mounted, wherever focus is, and yields to anything that took it first", () => {
      const src = SOURCE("EditorChooser.svelte");
      expect(src).toContain("<svelte:window {onkeydown} />");
      expect(src).toContain('if (e.defaultPrevented || e.key !== "Escape") return;');
      expect(src).toContain("e.preventDefault(); oncancel();");
      expect(src).toMatch(/<dialog bind:this=\{dialog\} open class="chooser" aria-label="Choose an editor">/);
      expect(src).not.toContain("stopPropagation");
    });
    test("source: on an inert slide, or under a modal, the press is not its own: every slide stays mounted, so a visible card must still hear it", () => {
      const src = SOURCE("EditorChooser.svelte");
      const at = src.indexOf('if (e.defaultPrevented || e.key !== "Escape") return;');
      const guard = src.indexOf('if (dialog === undefined || dialog.closest("[inert]") !== null || document.querySelector(\'[aria-modal="true"]\') !== null) return;');
      const cancel = src.indexOf("e.preventDefault(); oncancel();");
      expect(at).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(at);
      expect(cancel).toBeGreaterThan(guard);
      // The test the deck's own keys use for a modal.
      expect(SOURCE("Deck.svelte")).toContain("if (document.querySelector('[aria-modal=\"true\"]') !== null) return;");
      // The inert attribute it looks for is the one the deck writes on each slide.
      expect(SOURCE("Deck.svelte")).toContain('<div class="slide" inert={i !== nav.index}');
    });
    test("source: focus moves in on opening and returns on closing to what had it, when that is still there", () => {
      const src = SOURCE("EditorChooser.svelte");
      expect(src).toContain("const from = document.activeElement;");
      expect(src).toContain("control?.focus({ preventScroll: true });");
      // Measured at 900×640: it opens below the fold, so bring Open and Cancel into view first. Never on an inert slide.
      const reveal = 'if (dialog !== undefined && dialog.closest("[inert]") === null) dialog.scrollIntoView({ block: "nearest" });';
      expect(src).toContain(reveal);
      expect(src.indexOf(reveal)).toBeLessThan(src.indexOf("control?.focus({ preventScroll: true });"));
      expect(src.indexOf("const from = document.activeElement;")).toBeLessThan(src.indexOf(reveal));
      expect(src).toContain("if (lost && from instanceof HTMLElement && from.isConnected) from.focus({ preventScroll: true });");
    });
    test("source: closing returns focus only when focus was lost or is still inside: focus that moved on, to another card's control, stays there", () => {
      const src = SOURCE("EditorChooser.svelte");
      const close = src.slice(src.indexOf("return () => {"), src.indexOf("function onkeydown"));
      expect(close).toContain("const now = document.activeElement;");
      expect(close).toContain("const lost = now === null || now === document.body || own?.contains(now) === true;");
      expect(close.indexOf("const lost = ")).toBeLessThan(close.indexOf("if (lost && "));
      // Taken while it is open: a closing dialog's own binding is not what this should lean on.
      expect(src.indexOf("const own = dialog;")).toBeLessThan(src.indexOf("return () => {"));
      expect(src.indexOf("const own = dialog;")).toBeGreaterThan(src.indexOf("onMount(() => {"));
    });
    test("CSS: the Editor select has the Settings selects' look and the ctl focus ring, and the checkbox lines up with the labels", () => {
      const block = (src: string, sel: string): string => {
        const css = src.slice(src.indexOf("<style>"));
        const m = new RegExp(`\\n {2}${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css);
        expect({ sel, found: m !== null }).toEqual({ sel, found: true });
        return m![1]!;
      };
      const src = SOURCE("EditorChooser.svelte");
      const settings = readFileSync(new URL("../src/lib/settings/EditorLinksPage.svelte", import.meta.url), "utf8");
      expect(block(src, "select")).toBe(block(settings, "select"));
      for (const decl of ["font-size: 13px;", "padding: 5px 9px;", "border-radius: 6px;", "background: var(--surface, var(--bg));"]) expect(block(src, "select")).toContain(decl);
      expect(src).toContain('<select class="ctl" bind:this={control} bind:value={editor}>');
      expect(block(src, 'input[type="checkbox"]')).toContain("margin-left: 0;");
    });
  });

  describe("(pins) a re-mint changes every handle, and a control, its line and an open chooser all outlive it", () => {
    const left = () => SOURCE("LeftOff.svelte"), pad = () => SOURCE("Launchpad.svelte");
    test("LeftOff keys its buttons by target, so the focused one is the same element after a full check", () => {
      expect(count(left(), "{#each acts.buttons as b (b.target)}")).toBe(2);
      expect(left()).not.toContain("(b.handle)");
    });
    test("each component names a click by a stable key, never by the handle", () => {
      expect(left()).toContain("runs.github(actionKey(card.key, b.target), b.handle, openGithub)");
      expect(left()).toContain('runs.copy(actionKey(card.key, "copy"), copy.handles, copyPushCommand)');
      expect(left()).toContain("{#each lineOf(answer, card.key) as text, k (k)}");
      expect(pad()).toContain('runs.copy("onlyHere", copy.handles, copyPushCommand)');
      expect(pad()).toContain('answer?.key === "onlyHere"');
      const sugg = SOURCE("Suggested.svelte");
      expect(sugg).toContain("runs.copy(p.key, copy.handles, copyPushCommand)");
      expect(sugg).toContain("answer?.key === p.key");
      expect(sugg).toContain("runs.github(`suggestion:${s.n}`, button.handle, openGithub)");
      expect(sugg).toContain("answer?.key === `suggestion:${s.n}`");
      const rows = SOURCE("GitRows.svelte");
      expect(rows).toContain("runs.github(`${row.key}:${c.sha}`, arrow.button.handle, openGithub)");
      expect(rows).toContain("answer?.key === `${row.key}:${c.sha}`");
      expect(rows).toContain("runs.github(`${row.key}:row`, button.handle, openGithub)");
      expect(rows).toContain("answer?.key === `${row.key}:row`");
    });
    test("a line and the chooser are drawn from the flow's own card, outside the buttons' block, so an empty carrier does not close them", () => {
      const s = left();
      const block = s.indexOf("{#if acts !== null && (acts.buttons.length > 0 || acts.copy !== null)}");
      const closed = s.indexOf("{/if}\n      {#each lineOf(answer, card.key)");
      expect(block).toBeGreaterThan(-1);
      expect(closed).toBeGreaterThan(block);
      expect(s.indexOf("{#if editing.card === card.key}")).toBeGreaterThan(closed);
      expect(s.indexOf("<EditorChooser ")).toBeGreaterThan(s.indexOf("{#if editing.card === card.key}"));
      expect(s).toContain("editors.click(card.key, b, e.altKey)");
      expect(s).toContain("editors.open(editor, remember, liveEditorButton(acts?.buttons ?? [], editing.project))");
      const p = pad();
      expect(p).toContain("{#if gitTiles.tiles.length > 0 || gitTiles.more !== null || resume.length > 0 || editing.card !== null}");
      expect(p).toContain("{#if editing.card !== null}");
      expect(p).toContain("editors.open(editor, remember, liveEditorButton(resume.filter((r) => r.key === editing.card).map((r) => r.button), editing.project))");
    });
    test("every result line is announced through Today's one live region, never one inside a slide", () => {
      for (const name of ["LeftOff.svelte", "Launchpad.svelte", "Suggested.svelte", "GitRows.svelte"]) {
        expect(SOURCE(name)).toContain("getContext<ActionsAnnounce | undefined>(ACTIONS_ANNOUNCE)");
        expect(SOURCE(name)).toContain("announce)");
        expect(SOURCE(name)).not.toMatch(/aria-live|LiveRegion/);
      }
      for (const name of ["LeftOff.svelte", "Launchpad.svelte"]) expect(SOURCE(name)).toContain("publish: (s) => (editing = s), announce })");
    });
  });

  describe("(pins) the call sites name the wrappers, and the chooser's Open goes through chooseAndOpen", () => {
    test("each component imports the literal engine wrappers it clicks", () => {
      expect(SOURCE("GitRows.svelte")).toContain('import { openGithub } from "../engine";');
      expect(SOURCE("GitRows.svelte")).toContain(", openGithub)}");
      expect(SOURCE("GitRows.svelte")).not.toContain("copyPushCommand"); // What you did never draws Copy.
      expect(SOURCE("Suggested.svelte")).toContain('import { copyPushCommand, openGithub } from "../engine";');
      for (const name of ["Suggested.svelte", "LeftOff.svelte", "Launchpad.svelte"]) expect(SOURCE(name)).toContain(", copyPushCommand)}");
      expect(SOURCE("LeftOff.svelte")).toContain(", openGithub)}");
      for (const name of ["LeftOff.svelte", "Launchpad.svelte"]) {
        expect(SOURCE(name)).toContain("editorFlow({ editorList, editorOpen, editorChoiceSet, applySaved, publish:");
        expect(SOURCE(name)).toContain("getContext<ActionsSaved | undefined>(ACTIONS_SAVED)");
      }
      const model = readFileSync(new URL("../src/lib/actions.ts", import.meta.url), "utf8");
      expect(model.match(/chooseAndOpen\(/g)).toHaveLength(2); // Its definition and the flow's one call, for the chooser and the direct launch alike.
    });
    test("the deck passes the actions view to each slide that draws it, by name", () => {
      const deck = SOURCE("Deck.svelte");
      expect(deck).toContain('const actions = $derived(view.kind === "slides" ? view.actions : null);');
      for (const c0 of ["WhatYouDid", "LeftOff", "Suggested", "Launchpad"]) {
        const at0 = deck.indexOf(`<${c0}`);
        expect(deck.slice(at0, deck.indexOf("/>", at0))).toContain("{actions}");
      }
      expect(count(deck, "{actions}")).toBe(4);
    });
    test("source: everything a component holds under a stable key goes when the page key changes (the driver is tested in actions.check.ts)", () => {
      const wired = 'const newPage = onNewPage(() => {';
      const effect = "$effect.pre(() => { const key = pageKey(); untrack(() => newPage(key)); });";
      for (const [name, clears] of [["GitRows.svelte", "runs.reset();"], ["Suggested.svelte", "runs.reset();"], ["LeftOff.svelte", "runs.reset(); editors.reset();"], ["Launchpad.svelte", "runs.reset(); editors.reset();"]] as const) {
        const s = SOURCE(name);
        expect(s).toContain('getContext<ActionsPage | undefined>(ACTIONS_PAGE) ?? (() => null)');
        expect(s).toContain(`${wired} ${clears} });`);
        expect(s).toContain(effect);
      }
    });
    test("no status text is interpolated from a reply, and every action is a real button", () => {
      for (const name of ["GitRows.svelte", "LeftOff.svelte", "Suggested.svelte", "Launchpad.svelte", "EditorChooser.svelte"]) {
        const s = SOURCE(name);
        expect(s).not.toMatch(/\bmessage\b.*\berror\b|\.refused|\.failed|\{@html|href=/);
        expect(s).not.toMatch(/<a\b/);
      }
    });
  });
});
