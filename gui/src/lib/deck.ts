/**
 * The deck's model (the briefing redesign's A; spec `2026-10-19-redesign-A-deck-design.md`): today's
 * briefing page, as the `Block[]` Today already reads (`./briefing-md`, `./today`'s `Source`), mapped to
 * the slides' data.
 *
 * ⚠ PURE. No I/O, no clock of its own (today's date is an input), and no HTML strings: every value here
 * is plain text that a component draws as a text node.
 *
 * ⚠ IT READS THE PAGE AS THE ENGINE WRITES IT, AND REFUSES WHAT IT CANNOT PLACE. Each block goes to one
 * place by its kind and its section ([`routeBlock`], the table the A spec asks the plan to pin). A page
 * it cannot map — no title, a section's content with its heading missing, or a `text` block inside a
 * mapped section — is answered as such ([`mapPage`]), and Today shows the classic view instead: the
 * deck never guesses at a line.
 */
import { actionsView, type ActionsInput, type ActionsView } from "./actions";
import { blockText, type Block } from "./briefing-md";
import { norm } from "./briefing-struct";
import {
  CALENDAR_CLOCKS_BACK_TEXT,
  CALENDAR_CLOCKS_FORWARD_TEXT,
  CALENDAR_NO_EVENTS_TEXT,
  CALENDAR_NOT_CONNECTED_TEXT,
  CALENDAR_STATUS_TEXT,
  CALENDAR_UNAVAILABLE_TEXT,
} from "./calendar-contract";
import { gitDetailView, launchpadHeading, type GitDetailInput, type GitDetailView } from "./git-detail";
import { calendarDetailView, type CalendarDetail, type CalendarDetailView } from "./calendar-detail";
import { assignSlots } from "./project-color";
import { briefingDate, localDate, type Banner, type TodayModel } from "./today";

/**
 * `src/subprojects.ts`, `VERDICT_MARKER_PREFIX` (five spaces, U+2691, a space): the line the engine writes
 * under a suggestion that cites a commit on a configured verdict path. The reader has no case for it (it
 * arrives as a `text` block); the deck attaches it to the suggestion above. Pinned against the engine's
 * constant in `tests-web/deck.check.ts`.
 */
export const VERDICT_MARKER_PREFIX = "     ⚑ ";

/** The page's sections the deck knows, by their heading's words (`src/render.ts`). */
export type SectionKey = "leftOff" | "whatYouDid" | "todaySoFar" | "calendar" | "suggested";

const SECTION_HEADINGS: readonly (readonly [SectionKey, string])[] = [
  ["leftOff", "Where you left off"],
  ["whatYouDid", "What you did"],
  ["todaySoFar", "Today so far"],
  ["calendar", "Today's calendar"],
  ["suggested", "Suggested next"],
];

/** Where a block sits: in a known section, under a `▶` heading the deck does not know, or before any heading. */
export type Where = SectionKey | "unknown" | "outside";

/** Where a block goes. `cannotMap` means the whole page falls back to the classic view. */
export type Destination =
  | "needsALook" // Good morning's "needs a look" tile
  | "pageDate" // Good morning: the page's date (the stale check)
  | "fullOnly" // shown only in the Full briefing (the classic view)
  | "split" // a heading: splits the sections, not drawn
  | "resumeItem" // Where you left off: a resume card
  | "branchTag" // Where you left off: its project's branch tag
  | "projectCard" // What you did: its project's card (or "Other")
  | "mergedRow" // What you did: the card's "Merged:" row and the PR count, never a point
  | "todaySoFar" // the end of its project's card, under "Today so far"
  | "suggestion" // Suggested for today: a numbered card
  | "subtitleDisclosure" // What you did: the subtitle's disclosure (the remainder)
  | "whyNext" // the card or resume item of the labelled line after it
  | "emptyState" // the slide's empty state
  | "quietDay" // What you did: "No commits in this window"
  | "calendar" // Today's calendar: an event row or a status line
  | "verdictMarker" // attached to the suggestion above it
  | "cannotMap";

const BRANCH_LINE = /^(On branch |Detached HEAD at )/;
const MORE_LINE = /^\(\+\d+ more\)$/;

/** A line's `[label]` prefix and the rest. `label` is null when there is none; `[]` gives `""`. */
export function parseLabel(text: string): { label: string | null; rest: string } {
  const m = /^\[([^\]]*)\] ?([\s\S]*)$/.exec(text);
  return m === null ? { label: null, rest: text } : { label: m[1]!, rest: m[2]! };
}

const isMerge = (text: string): boolean => parseLabel(text).rest.startsWith("\u{1F500}");

/**
 * The full `BlockKind` → destination table (A spec, "Where each line kind goes"; plan A-M3-T5). A line
 * kind in a known section where the table gives it no place is the page's "content with its heading
 * missing" (`cannotMap`); under an unknown heading everything is Full briefing only.
 */
export function routeBlock(block: Block, where: Where): Destination {
  const text = blockText(block);
  const known = where !== "unknown" && where !== "outside";
  const sectionBound = (inSection: Destination | null): Destination =>
    inSection !== null ? inSection : where === "unknown" ? "fullOnly" : "cannotMap";
  switch (block.kind) {
    case "notice":
    case "outage":
    case "warnings":
      return "needsALook";
    case "title":
      return "pageDate";
    case "legend":
    case "footer":
      return "fullOnly";
    case "heading":
      return "split";
    case "bullet":
      return sectionBound(
        where === "leftOff"
          ? BRANCH_LINE.test(parseLabel(text).rest)
            ? "branchTag"
            : "resumeItem"
          : where === "whatYouDid"
            ? isMerge(text)
              ? "mergedRow"
              : "projectCard"
            : where === "todaySoFar"
              ? "todaySoFar"
              : where === "suggested"
                ? "suggestion"
                : null,
      );
    case "nested":
    case "nested2":
      return sectionBound(where === "whatYouDid" ? "projectCard" : null);
    case "notShown":
      return sectionBound(where === "whatYouDid" ? (MORE_LINE.test(text) ? "subtitleDisclosure" : "projectCard") : null);
    case "coverage":
      return sectionBound(where === "whatYouDid" ? "subtitleDisclosure" : null);
    case "why":
      // The engine writes why lines only in Where you left off and What you did (`render.ts`'s `whyFor`).
      return sectionBound(where === "leftOff" || where === "whatYouDid" ? "whyNext" : null);
    case "placeholder":
      return sectionBound(
        where === "leftOff" && text === "(nothing in progress)"
          ? "emptyState"
          : where === "whatYouDid" && text === "(no commits in the window)"
            ? "quietDay"
            : where === "suggested" && text === "(none)"
              ? "emptyState"
              : null,
      );
    case "calendar":
      return sectionBound(where === "calendar" ? "calendar" : null);
    case "text":
      if (where === "suggested" && text.startsWith(VERDICT_MARKER_PREFIX)) return "verdictMarker";
      return known ? "cannotMap" : "fullOnly";
    default: {
      const unhandled: never = block.kind;
      return unhandled;
    }
  }
}

/** The labels that depend on whether the page is today's (A spec, "A stale page"). */
export interface PageLabels {
  /** "Your last briefing, from Thursday 16 October" on a stale page; null on today's (the greeting). */
  title: string | null;
  suggested: string;
  todaySoFar: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Sakamoto's month offsets for the Gregorian weekday. */
const WEEKDAY_OFFSETS = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];

/**
 * `2025-10-16` → `Thursday 16 October`: the page's own calendar date, by integer arithmetic. No clock is
 * read, so no time zone can move the weekday (a `Date`'s local `getDay` would, off UTC).
 */
export function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const yy = m < 3 ? y - 1 : y;
  const day = (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + WEEKDAY_OFFSETS[m - 1]! + d) % 7;
  return `${WEEKDAYS[day]} ${d} ${MONTHS[m - 1]}`;
}

/** Every label relative to the page's date, never to now: stale when the page is not today's. */
export function pageLabels(pageDate: string, today: string): PageLabels {
  return pageDate === today
    ? { title: null, suggested: "Suggested for today", todaySoFar: "Today so far" }
    : { title: `Your last briefing, from ${longDate(pageDate)}`, suggested: "Suggested then", todaySoFar: "Later that day" };
}

/** One commit line on a project card, as the page has it (the text after the `[label]` prefix). */
export interface CardLine {
  kind: "bullet" | "nested" | "nested2" | "notShown";
  text: string;
  /** A cluster, story, campaign or Stage-1 group header (a line with members under it): shown as the
   *  disclosure's group heading, never a point. */
  header: boolean;
}

/** One of a card's points: a recap sentence from the page, unchanged and drawn whole, wrapped (polish §1). */
export interface Point {
  text: string;
}

/** One project's card on What you did. `key` is the label as the engine normalises it; `""` is "Other". */
export interface ProjectCard {
  key: string;
  /** The label as first written ANYWHERE on the page, the same on every slide (round-4 L7); "Other" for the unlabelled card. */
  label: string;
  /** The colour slot (`./project-color`); null for "Other". */
  slot: number | null;
  /** Every commit line of the project in What you did, in page order. */
  lines: CardLine[];
  /** The 🔀 lines of the project in What you did (the "Merged:" row). */
  mergedLines: string[];
  /** The project's "Today so far" lines, 🔀 rows included (outside the window). */
  todaySoFar: string[];
  /** Distinct SHA tokens over `lines` ([`isCountedToken`]); 0 reads "Details ›". */
  commits: number;
  /** Distinct PR numbers in `mergedLines`, in page order. */
  merged: number[];
  /** "Merged: #644, #638", or null with no 🔀 line. */
  mergedRow: string | null;
  /** Up to 3 ([`pickPoints`]). */
  points: Point[];
  /** The why lines (`— you wrote: "…"`) the engine wrote before this project's first line. */
  why: string[];
}

/* ── points (A spec, "The rule for picking them") ─────────────────────────────────────────────── */

/** A line's sentence: its text without the evidence parenthetical (from the last two spaces and `(`). */
export function sentenceOf(text: string): string {
  const at = text.lastIndexOf("  (");
  return at === -1 ? text : text.slice(0, at);
}

/**
 * A header's stated size, N, from the engine's header forms (`src/generator.ts`): `X — N commits (dates)`,
 * `X — N of M commits touching it (grouped: …)` and `<campaign> — N of M commits naming it (grouped: …)`.
 */
function statedCount(header: string): number | null {
  const m = /\s—\s(\d+)(?: of \d+)? commits?\b/.exec(sentenceOf(header));
  return m === null ? null : Number(m[1]);
}

/** A What-you-did line in the page's structure: `•` at level 1, `◦` under it, `▪` under that. */
interface LineNode {
  key: string;
  line: CardLine;
  /** Page order. */
  index: number;
  children: LineNode[];
}

interface PointGroup {
  key: string;
  members: LineNode[];
  size: number;
  index: number;
}

/**
 * The groups the five-step rule reads off the structure (A spec, by `render.ts`'s line structure):
 * a `◦` with `▪` members is a group; other `◦` lines belong to the `•` above — one group with it when
 * it holds no `◦` group headers, else each lone `◦` is a group of one; a flat `•` is a group of one.
 * A group's size is its header's stated count, else its member count.
 */
function pointGroups(roots: LineNode[]): PointGroup[] {
  const groups: PointGroup[] = [];
  const single = (n: LineNode): PointGroup => ({ key: n.key, members: [n], size: 1, index: n.index });
  const ofHeader = (h: LineNode): PointGroup => ({
    key: h.key,
    members: h.children,
    size: statedCount(h.line.text) ?? h.children.length,
    index: h.index,
  });
  for (const root of roots) {
    if (root.children.length === 0) groups.push(single(root));
    else if (!root.children.some((c) => c.children.length > 0)) groups.push(ofHeader(root));
    else for (const c of root.children) groups.push(c.children.length > 0 ? ofHeader(c) : single(c));
  }
  return groups;
}

/** A card's points: the 3 largest groups (ties by page order), each giving its first-listed member's
 *  sentence. Members under another project's header give that header's card nothing. */
function pickPoints(key: string, groups: PointGroup[]): Point[] {
  return groups
    .filter((g) => g.key === key)
    .map((g) => ({ ...g, members: g.members.filter((m) => m.key === key) }))
    .filter((g) => g.members.length > 0)
    .sort((a, z) => z.size - a.size || a.index - z.index)
    .slice(0, 3)
    .map((g) => ({ text: sentenceOf(g.members[0]!.line.text) }));
}

/* ── counting (A spec, "Counting") ────────────────────────────────────────────────────────────── */

/**
 * The deck's SHA-token rule: a hex token of 4 to 40 characters, all-digit ones included (real SHAs can
 * be all digits). ⚠ A KNOWN DISPLAY LIMIT, NOT THE ENGINE'S RULE: the engine counts a commit as shown by
 * prefix-matching its commit list, which the deck does not have, so to keep words like "added" from
 * counting, a token shorter than 7 characters counts only if it holds a digit. Not the reader's
 * `isShaShaped`, which rejects all-digit ids.
 */
export function isCountedToken(tok: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(tok) && (tok.length >= 7 || /[0-9]/.test(tok));
}

/** `src/sha.ts`, `evidenceTokens` then `bareToken`: parens stripped, not split on, so
 *  `2ee0ae5 (src/main.ts)` yields both halves; adornments and trailing punctuation removed. */
export function splitTokens(evidence: string): string[] {
  return evidence
    .split(/[,\s]+/)
    .map((t) => t.replace(/[()]/g, ""))
    .filter(Boolean)
    .map((t) => t.replace(/^[`'"[{*_]+/, "").replace(/[`'"\]}*_.,;:!?]+$/, ""));
}

/** A commit line's SHA tokens, lowercased: inside its evidence parenthetical — from the LAST two spaces
 *  and `(` to the end of the line, so a sentence's own parentheses are never read — or, on a not-shown
 *  line, its SHA field. */
export function lineTokens(line: CardLine): string[] {
  let field: string[];
  if (line.kind === "notShown") {
    field = line.text.split(" ").slice(0, 1);
  } else {
    const at = line.text.lastIndexOf("  (");
    field = at === -1 ? [] : splitTokens(line.text.slice(at + 2));
  }
  return field.filter(isCountedToken).map((t) => t.toLowerCase());
}

/** The PR numbers of one 🔀 line: `🔀 N PRs merged (#a, #b)`, `🔀 1 PR merged (#a)`, or the older
 *  `🔀 Merged #N`. Anything else names none. */
export function mergedPrs(line: string): number[] {
  const list = /^\u{1F500} \d+ PRs? merged \(([^)]*)\)/u.exec(line);
  if (list !== null) return [...list[1]!.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  const one = /^\u{1F500} Merged #(\d+)/u.exec(line);
  return one === null ? [] : [Number(one[1])];
}

export interface DeckSection {
  /** null for a `▶` heading the deck does not know. */
  key: SectionKey | null;
  /** The heading's words, without the `▶ `. */
  heading: string;
  blocks: Block[];
}

export interface WhatYouDid {
  /** Page order of first appearance; the "Other" card, if any, last. */
  cards: ProjectCard[];
  /** Cards with window lines (not "Other", not a project with only "Today so far" lines). */
  projects: number;
  /** The header's `X of Y` gives Y; the bare header's N counts bullets, so then the section's distinct
   *  SHA tokens, 🔀 lines excluded (never the cards' sum, which double-counts a SHA under two labels). */
  commits: number;
  /** Distinct PR numbers in the section's 🔀 lines, per project. */
  prs: number;
  /** The unlabelled coverage lines, for the subtitle's disclosure; never a card's count. */
  remainder: { header: string | null; more: string | null; moreCount: number };
  /** The section says "(no commits in the window)". */
  quiet: boolean;
  /** "N projects · N commits · N PRs merged"; the commits part is left out when there are projects but no counted
   *  commit (round-1 L2). */
  subtitle: string;
  /** "No commits in this window" on a quiet day (today-only cards follow it); else null. */
  emptyText: string | null;
}

/** A branch line, parsed only from the code-built shapes (`src/git.ts`). */
export type BranchTag =
  | {
      kind: "branch";
      name: string;
      /** From `(ahead N, behind M)`; null for `(no upstream)`. */
      ahead: number | null;
      /** From `(ahead N, behind M)`; null for `(no upstream)`. */
      behind: number | null;
    }
  | { kind: "detached"; sha: string };

/**
 * The words beside a branch tag (user-directed 2026-10-21): "ahead N" and "behind N", each only when N is
 * above 0, ahead first (git's own order); nothing for `(no upstream)` or a detached HEAD.
 */
export function branchCounts(tag: BranchTag): string[] {
  if (tag.kind !== "branch") return [];
  return [
    ...(tag.ahead !== null && tag.ahead > 0 ? [`ahead ${tag.ahead}`] : []),
    ...(tag.behind !== null && tag.behind > 0 ? [`behind ${tag.behind}`] : []),
  ];
}

/** One project's card on Where you left off. */
export interface ResumeCard {
  key: string;
  label: string;
  slot: number | null;
  /** Its resume bullets, as written (and a branch line the deck cannot parse, kept as a line). */
  items: string[];
  branch: BranchTag | null;
  /** The why lines written before its first line. */
  why: string[];
}

export interface LeftOff {
  cards: ResumeCard[];
  /** The section says "(nothing in progress)". */
  empty: boolean;
}

/** One numbered suggestion. No label (or an empty `[]` one) means no pill: `key`, `label` and `slot` null. */
export interface SuggestionCard {
  n: number;
  key: string | null;
  label: string | null;
  slot: number | null;
  /** As written, provenance (`(from resume)`, a stash label) included. */
  text: string;
  /** The verdict marker line under it (`⚑ …`), or null. */
  marker: string | null;
}

export interface Suggested {
  /** "Suggested for today", or "Suggested then" on a stale page. */
  title: string;
  cards: SuggestionCard[];
  /** The section says "(none)". */
  empty: boolean;
}

export interface DeckPage {
  pageDate: string;
  stale: boolean;
  labels: PageLabels;
  sections: DeckSection[];
  /** Good morning's "needs a look": the notices, the outage line and every `⚠` warnings block, verbatim. */
  needsALook: string[];
  /** Each project's colour slot, by normalised label, one per project across every slide. */
  slots: Record<string, number | null>;
  whatYouDid: WhatYouDid;
  leftOff: LeftOff;
  suggested: Suggested;
  /** Only when the page has a `▶ Today's calendar` heading; else no calendar slide. */
  calendar: CalendarSlide | null;
}

/* ── the calendar (A spec, "Today's calendar" and the launchpad's meeting tile) ───────────────── */

/** What the calendar slide says on a page that is not today's. */
export const CALENDAR_STALE_TEXT = "Calendar shows on today's briefing";

/** A timed event, parsed from its line. Instants are LOCAL wall times on the page's date (the renderer's
 *  zone, the Mac's current one: a limitation until C). */
export interface CalendarEvent {
  title: string;
  /** The start's instant, for the running / next maths. For a start before the page's day ("since yesterday",
   *  "since Oct 14") it is that day's LOCAL MIDNIGHT, not the real start time, which the page does not say:
   *  so it is never drawn as a time ([`startLabel`]). */
  startMs: number;
  /** The page's own words for a start that is not today's `HH:MM` ("since yesterday", "since Oct 14",
   *  "Oct 17 09:00"); null for today's. */
  since: string | null;
  /** Equal to `startMs` for a zero-length event (a bare start). */
  endMs: number;
  tentative: boolean;
  /** `· ended`: the event had ended when the page was written; never a tile. */
  ended: boolean;
}

/** One line of the calendar section, as the page has it. A status line is never parsed as an event; an
 *  event line the grammar does not recognise has no `event`. The page's `all day — …` and `time unclear (…)` rows
 *  (`src/render.ts`'s `calEventLine`) are their own kinds (redesign C, wave-2 plan C-M4-T12), for the calendar
 *  slide's all-day strip: NEVER a `CalendarEvent` span, so `events`, the tiles, the next meeting and the subtitle
 *  never see them. `title` is what follows the time, the trailing ` · tentative` / ` · ended` marks removed, then the
 *  merge mark (calendar near-duplicates, spec §6). */
export type CalendarRow =
  | { kind: "status"; text: string }
  | { kind: "more"; text: string }
  | { kind: "allDay"; text: string; title: string }
  | { kind: "unclear"; text: string; title: string }
  | { kind: "event"; text: string; event: CalendarEvent | null };

export interface CalendarSlide {
  stale: boolean;
  /** The section's lines; empty on a stale page. */
  rows: CalendarRow[];
  /** The rows' parsed timed events, in page order; empty on a stale page. */
  events: CalendarEvent[];
  /** [`CALENDAR_STALE_TEXT`] on a stale page, else null. */
  staleText: string | null;
}

const CAL_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HHMM = "([01]\\d|2[0-3]):([0-5]\\d)";
const MON_DAY = `(${CAL_MONTHS.join("|")}) (\\d{1,2})`;

/** A local wall time: the engine renderer's `new Date(y, m, d, …)` idiom (DST-safe date arithmetic). */
function wallMs(y: number, m: number, d: number, hh = 0, mm = 0): number {
  return new Date(y, m - 1, d, hh, mm).getTime();
}

/** The two instants' local wall times are the same, to the minute. */
function sameWall(a: number, b: number): boolean {
  const x = new Date(a);
  const z = new Date(b);
  return (
    x.getFullYear() === z.getFullYear() &&
    x.getMonth() === z.getMonth() &&
    x.getDate() === z.getDate() &&
    x.getHours() === z.getHours() &&
    x.getMinutes() === z.getMinutes()
  );
}

const HOUR = 3_600_000;

/** The LATER of a wall time's instants: when the clocks went back across it, the repeated hour's wall times
 *  happen twice. For an end marked "clocks go back", which by the mark is after the change. */
function laterWallMs(y: number, m: number, d: number, hh = 0, mm = 0): number {
  const t = wallMs(y, m, d, hh, mm);
  const shift = Math.abs(new Date(t + 3 * HOUR).getTimezoneOffset() - new Date(t - 3 * HOUR).getTimezoneOffset()) * 60_000;
  return Math.max(...[t - shift, t, t + shift].filter((x) => sameWall(x, t)));
}

/** `<Mon D>` on the page's calendar: the latest such day on or before the page (`back`), or the first on
 *  or after it, for a start that is still to come. */
function monDayYear(pageDate: string, mon: string, day: number, back: boolean): [number, number, number] {
  const [y, m, d] = pageDate.split("-").map(Number) as [number, number, number];
  const month = CAL_MONTHS.indexOf(mon) + 1;
  const after = month > m || (month === m && day > d);
  const before = month < m || (month === m && day < d);
  return [back && after ? y - 1 : !back && before ? y + 1 : y, month, day];
}

/** An end's `<Mon D>`: the first such day on or after the START's day (an end is never before its start;
 *  it may be before the page, for an event that ended before it). */
function monDayFrom(startMs: number, mon: string, day: number): [number, number, number] {
  const s = new Date(startMs);
  const month = CAL_MONTHS.indexOf(mon) + 1;
  const before = month < s.getMonth() + 1 || (month === s.getMonth() + 1 && day < s.getDate());
  return [before ? s.getFullYear() + 1 : s.getFullYear(), month, day];
}

interface WhenPoint {
  ms: number;
  /** Today's `HH:MM` (a start), or today's `HH:MM` or `24:00` (an end): the only pair written with `–`. */
  today: boolean;
}

function parseStart(s: string, pageDate: string): WhenPoint | null {
  const [y, m, d] = pageDate.split("-").map(Number) as [number, number, number];
  let r = new RegExp(`^${HHMM}$`).exec(s);
  if (r !== null) return { ms: wallMs(y, m, d, Number(r[1]), Number(r[2])), today: true };
  if (s === "since yesterday") return { ms: wallMs(y, m, d - 1), today: false };
  r = new RegExp(`^since ${MON_DAY}$`).exec(s);
  if (r !== null) {
    const [yy, mm, dd] = monDayYear(pageDate, r[1]!, Number(r[2]), true);
    return { ms: wallMs(yy, mm, dd), today: false };
  }
  r = new RegExp(`^${MON_DAY} ${HHMM}$`).exec(s);
  if (r !== null) {
    const [yy, mm, dd] = monDayYear(pageDate, r[1]!, Number(r[2]), false);
    return { ms: wallMs(yy, mm, dd, Number(r[3]), Number(r[4])), today: false };
  }
  return null;
}

/** An end, after `startMs`. `back` (the span is marked "clocks go back"): the end is after the change, so a
 *  wall time the change repeated is its later instant (`01:45–01:15 (clocks go back)` ends after it starts). */
function parseEnd(s: string, pageDate: string, startMs: number, back: boolean): WhenPoint | null {
  const [y, m, d] = pageDate.split("-").map(Number) as [number, number, number];
  const wall = back ? laterWallMs : wallMs;
  let r = new RegExp(`^${HHMM}$`).exec(s);
  if (r !== null) return { ms: wall(y, m, d, Number(r[1]), Number(r[2])), today: true };
  if (s === "24:00") return { ms: wall(y, m, d + 1), today: true };
  r = new RegExp(`^${HHMM} tomorrow$`).exec(s);
  if (r !== null) return { ms: wall(y, m, d + 1, Number(r[1]), Number(r[2])), today: false };
  r = new RegExp(`^${MON_DAY} ${HHMM}$`).exec(s);
  if (r !== null) {
    const [yy, mm, dd] = monDayFrom(startMs, r[1]!, Number(r[2]));
    return { ms: wall(yy, mm, dd, Number(r[3]), Number(r[4])), today: false };
  }
  return null;
}

/** `calTimedSpan`'s grammar (`src/render.ts`): a bare start, or start `–` end exactly when both are today's
 *  (the end may be `24:00`), else start ` → ` end; then an optional DST mark. Anything else: null. */
function parseWhen(raw: string, pageDate: string): { startMs: number; endMs: number; since: string | null } | null {
  const back = raw.endsWith(CALENDAR_CLOCKS_BACK_TEXT);
  const when = back
    ? raw.slice(0, -CALENDAR_CLOCKS_BACK_TEXT.length)
    : raw.endsWith(CALENDAR_CLOCKS_FORWARD_TEXT)
      ? raw.slice(0, -CALENDAR_CLOCKS_FORWARD_TEXT.length)
      : raw;
  const arrow = when.split(" → ");
  const dash = when.split("–");
  /** The start's own words, kept when it is not today's `HH:MM` (round-1 M3). */
  const sinceOf = (start: WhenPoint, words: string): string | null => (start.today ? null : words);
  if (arrow.length === 2) {
    const start = parseStart(arrow[0]!, pageDate);
    const end = start === null ? null : parseEnd(arrow[1]!, pageDate, start.ms, back);
    if (start === null || end === null || (start.today && end.today)) return null;
    return { startMs: start.ms, endMs: end.ms, since: sinceOf(start, arrow[0]!) };
  }
  if (dash.length === 2 && arrow.length === 1) {
    const start = parseStart(dash[0]!, pageDate);
    const end = start === null ? null : parseEnd(dash[1]!, pageDate, start.ms, back);
    if (start === null || end === null || !start.today || !end.today) return null;
    return { startMs: start.ms, endMs: end.ms, since: null };
  }
  if (arrow.length === 1 && dash.length === 1) {
    const start = parseStart(when, pageDate);
    return start === null ? null : { startMs: start.ms, endMs: start.ms, since: sinceOf(start, when) };
  }
  return null;
}

const STATUS_SENTENCES = Object.values(CALENDAR_STATUS_TEXT);

/** A key-c merge's mark (calendar near-duplicates, spec 2026-10-31 §6), as the engine's `calEventLine` writes it from
 *  the struct's decided `merged`: ` · on N calendars` or ` · N copies`, N an integer ≥ 2. */
export type MergeMark = { kind: "calendars" | "copies"; count: number };

/** The merge mark's grammar (spec §6). Not `/g`: these are run with `exec`, which would keep state on a global one. */
const MERGE_MARK_GRAMMAR: readonly { kind: MergeMark["kind"]; re: RegExp }[] = [
  { kind: "calendars", re: / · on ([2-9]|[1-9]\d+) calendars$/ },
  { kind: "copies", re: / · ([2-9]|[1-9]\d+) copies$/ },
];

/** The merge mark ending `w` and `w` without it (mark null, `w` unchanged, when none matches the grammar). `w` must
 *  already be without ` · ended` and ` · tentative`: the engine writes the merge mark before them. */
export function splitMergeMark(w: string): { rest: string; mark: MergeMark | null } {
  for (const g of MERGE_MARK_GRAMMAR) {
    const m = g.re.exec(w);
    if (m !== null) return { rest: w.slice(0, m.index), mark: { kind: g.kind, count: Number(m[1]) } };
  }
  return { rest: w, mark: null };
}

/** `text` without its trailing ` · ended`, then ` · tentative` (the merge mark kept), in reverse of the order the engine
 *  writes them. The first two steps of [`unmarked`]; also the compare form of `assignRows`' exact step
 *  (`lib/calendar-detail.ts`): a live `rowText` gains ` · ended` once a meeting is over, and tentative can change after
 *  the morning read, neither of which the page's row tracks (plan §1.1, M7 interpretation 1). */
export function statusless(text: string): string {
  let t = text;
  if (t.endsWith(" · ended")) t = t.slice(0, -" · ended".length);
  if (t.endsWith(" · tentative")) t = t.slice(0, -" · tentative".length);
  return t;
}

/** A row's "what" without its trailing marks, stripped in reverse of the order the engine writes them: ` · ended`,
 *  then ` · tentative`, then the merge mark (spec §6). */
export function unmarked(what: string): string {
  return splitMergeMark(statusless(what)).rest;
}

/** One calendar line (the text after the `   ◦ ` prefix), classified and, for a timed event, parsed. */
export function parseCalendarLine(text: string, pageDate: string): CalendarRow {
  if (
    text === CALENDAR_NOT_CONNECTED_TEXT ||
    text === CALENDAR_UNAVAILABLE_TEXT ||
    text === CALENDAR_NO_EVENTS_TEXT ||
    STATUS_SENTENCES.some((s) => text.endsWith(`: ${s}`))
  ) {
    return { kind: "status", text };
  }
  if (/^\+\d+ more$/.test(text)) return { kind: "more", text };
  if (text.startsWith("all day — ")) return { kind: "allDay", text, title: unmarked(text.slice("all day — ".length)) };
  const unclear = /^time unclear \(.*?\) {2}/.exec(text);
  if (unclear !== null) return { kind: "unclear", text, title: unmarked(text.slice(unclear[0].length)) };
  const cut = text.indexOf("  ");
  const span = cut === -1 ? null : parseWhen(text.slice(0, cut), pageDate);
  if (span === null) return { kind: "event", text, event: null };
  const what = text.slice(cut + 2);
  const ended = what.endsWith(" · ended");
  const tentative = what.endsWith(ended ? " · tentative · ended" : " · tentative");
  return { kind: "event", text, event: { title: unmarked(what), startMs: span.startMs, since: span.since, endMs: span.endMs, tentative, ended } };
}

/** The launchpad's meeting tile: `soon` from 30 minutes before, `imminent` at 5 or less, `now` during. */
export interface MeetingTile {
  state: "soon" | "imminent" | "now";
  /** Whole minutes until the start (0 while it runs). */
  minutes: number;
  event: CalendarEvent;
}

const MINUTE = 60_000;

/** The events that can be tiles on `pageDate` at `now`: only on today's page (by `now`'s local date, so it
 *  rolls over at midnight), not `· ended`, and with a span that covers some of the page's day. */
function todaysEvents(pageDate: string, events: CalendarEvent[], now: number): CalendarEvent[] {
  if (localDate(new Date(now)) !== pageDate) return [];
  const [y, m, d] = pageDate.split("-").map(Number) as [number, number, number];
  const dayStart = wallMs(y, m, d);
  const dayEnd = wallMs(y, m, d + 1);
  return events.filter((e) =>
    !e.ended && (e.startMs === e.endMs ? e.startMs >= dayStart && e.startMs < dayEnd : e.startMs < dayEnd && e.endMs > dayStart),
  );
}

/** The meeting tile at `now`, or null: a running meeting first, else the soonest within 30 minutes. */
export function meetingTile(pageDate: string, events: CalendarEvent[], now: number): MeetingTile | null {
  const candidates = todaysEvents(pageDate, events, now);
  const running = candidates.find((e) => e.startMs <= now && now < e.endMs);
  if (running !== undefined) return { state: "now", minutes: 0, event: running };
  const next = candidates
    .filter((e) => e.startMs > now && e.startMs - now <= 30 * MINUTE)
    .sort((a, z) => a.startMs - z.startMs)[0];
  if (next === undefined) return null;
  const minutes = Math.ceil((next.startMs - now) / MINUTE);
  return { state: minutes <= 5 ? "imminent" : "soon", minutes, event: next };
}

/** The next-meeting glance tile: the running meeting, else the soonest still to come today. */
export function nextMeeting(pageDate: string, events: CalendarEvent[], now: number): CalendarEvent | null {
  const candidates = todaysEvents(pageDate, events, now);
  const running = candidates.find((e) => e.startMs <= now && now < e.endMs);
  if (running !== undefined) return running;
  return candidates.filter((e) => e.startMs >= now).sort((a, z) => a.startMs - z.startMs)[0] ?? null;
}

/** Good morning's glance tile: [`nextMeeting`]'s event, and its heading — "Now" while it runs (the launchpad's
 *  word), "Next meeting" before it starts (round-2 M1: a running meeting is not the next one). */
export interface GlanceMeeting {
  heading: "Now" | "Next meeting";
  event: CalendarEvent;
}

export function glanceMeeting(pageDate: string, events: CalendarEvent[], now: number): GlanceMeeting | null {
  const event = nextMeeting(pageDate, events, now);
  if (event === null) return null;
  return { heading: event.startMs <= now && now < event.endMs ? "Now" : "Next meeting", event };
}

/** An instant's local `HH:MM` (the tiles' times). */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * What the tiles draw for an event's start (round-1 M3): today's start as its local `HH:MM`, and a start before
 * today as the page's own words ("since yesterday"), never the local midnight its instant stands for ("00:00").
 */
export function startLabel(e: CalendarEvent): string {
  return e.since ?? clockTime(e.startMs);
}

/** The meeting tile's words, so colour is never the only signal (hub, Accessibility). */
export function meetingTileText(tile: MeetingTile): string {
  return tile.state === "now" ? "Now" : `In ${tile.minutes} ${tile.minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * A What-you-did card's count beside its pill (A-M6 reading): "N commits", or for a card with activity
 * but no counted commit, never "0 commits" — a merge-only card names its PRs ("1 PR merged", "N PRs
 * merged"), and a card whose commits carry no SHA shows no count (its disclosure reads "Details ›").
 */
export function cardCountLabel(card: ProjectCard): string | null {
  if (card.commits > 0) return card.commits === 1 ? "1 commit" : `${card.commits} commits`;
  if (card.merged.length > 0) return card.merged.length === 1 ? "1 PR merged" : `${card.merged.length} PRs merged`;
  return null;
}

/** The launchpad's mood line: a claim about now, so drawn on today's page only (round-2 L5, `Launchpad.svelte`). */
export function moodLine(tile: MeetingTile | null): string {
  // "A meeting is in progress." while it runs: the user's wording, 2026-10-21 (the A spec names only the other
  // two; a meeting having started does not mean the user joined it, so it says nothing about the user).
  return tile === null ? "Nothing needs you right now." : tile.state === "now" ? "A meeting is in progress." : "A meeting is coming up.";
}

/* ── the slide list, the reducer and the input (A spec, "The deck", "Empty and failure states") ── */

/** The slides, in order. The calendar slide only with a calendar section, or on a live calendar day (`DeckInput.calendarOn`). */
export type SlideId = "goodMorning" | "whatYouDid" | "leftOff" | "suggested" | "calendar" | "launchpad";

/**
 * What Today draws. One slide (Good morning) while the page loads, after a read error and before the first
 * briefing; the classic view, with the reason, when a loaded page cannot be mapped.
 */
export type DeckView =
  | {
      kind: "slides";
      slides: SlideId[];
      page: DeckPage;
      goodMorning: GoodMorning;
      /** B1: the live git check's view (`git-detail.ts`); null when Today passes no `gitDetail`. */
      git: GitDetailView | null;
      /** B2: buttons from current held handles, separate from B1 rows and A2 summaries. */
      actions: ActionsView | null;
      /** C: today's calendar details read live (`calendar-detail.ts`), or null (no calendar slide, a stale page, or
       *  no `calendarDetail` input). */
      live: CalendarDetailView | null;
    }
  | { kind: "single"; slides: ["goodMorning"]; reason: "loading" | "error" | "empty"; goodMorning: GoodMorning }
  | { kind: "classic"; reason: CannotMapReason; line: string };

/** Validated Rust payload, held by Today's identity/revision gate. Keys still need current-card membership. */
export interface SummaryInput {
  pageHash: string;
  pageVersion: string;
  projects: { key: string; points: string[] }[];
  goodMorningSentence: string | null;
}

/**
 * The deck's input: Today's model (the Block list and Today's status inputs), today's date, the first name
 * (from the app-prefs store), and four RESERVED names, each defined by the project that fills it (B1, C, B2,
 * A2). B1's `gitDetail` (`git-detail.ts`), C's `calendarDetail` (`calendar-detail.ts`), B2's `actions` and A2's `summary` are
 * all defined.
 *
 * ⚠ NO CLOCK (round-1 L4). The page's mapping does not depend on the time of day, only on `today`; the
 * clock (`now`) goes from Today to the components that draw time (the meeting tiles), so the minute tick
 * and a focus re-read never re-map the page.
 */
export interface DeckInput {
  model: TodayModel;
  today: string;
  firstName: string | null;
  /** B1: git detail (PRs, branches, pushes): what `git-live.ts` holds for today's page (`git-detail.ts`). */
  gitDetail?: GitDetailInput | undefined;
  /** C: the live calendar's detail, as Today's calendar driver holds it (`lib/calendar-live.ts`). */
  calendarDetail?: CalendarDetail;
  /** PB-M4: the calendar is "on" (the Today store's `calendar status` reply; absent reads false). On today's page with
   *  no section it makes a live calendar day: the calendar slide and the live read. */
  calendarOn?: boolean;
  /** B2: links, Compare, the editor. */
  actions?: ActionsInput | undefined;
  /** A2: the AI's short summary. */
  summary?: SummaryInput | null;
}

/** The type-level check that the four reserved names are optional: none set, and it must still type-check
 *  (exported: `noUnusedLocals`). */
export const DECK_INPUT_WITHOUT_RESERVED = {
  model: {
    status: null,
    banners: [],
    source: { kind: "none" },
    staleDate: null,
    quiet: false,
    quietWithWarning: false,
    loading: true,
    empty: false,
  },
  today: "2026-10-16",
  firstName: null,
} satisfies DeckInput;

/** The deck for Today's current state. */
export function deckView(input: DeckInput): DeckView {
  const { model, today, firstName, calendarDetail } = input;
  const single = (reason: "loading" | "error" | "empty"): DeckView => ({
    kind: "single",
    slides: ["goodMorning"],
    reason,
    goodMorning: goodMorning({ model, page: null, firstName, today }),
  });
  if (model.loading) return single("loading");
  if (model.empty) return single("empty");
  if (model.source.kind === "none") return single("error");
  const mappedPage = mapPage(model.source.blocks, today);
  if (!mappedPage.ok) return { kind: "classic", reason: mappedPage.reason, line: mappedPage.line };
  const p = mappedPage.page;
  const identity = model.pageIdentity;
  const summary = !model.quiet && identity && input.summary?.pageHash === identity.pageHash
    && input.summary.pageVersion === identity.pageVersion ? input.summary : null;
  if (summary) {
    // Exact membership only: never normalise or render an unknown wire key. Other entries still apply.
    const points = new Map(summary.projects.map((project) => [project.key, project.points]));
    for (const card of p.whatYouDid.cards) {
      const replacement = points.get(card.key === "" ? "other:" : `project:${card.key}`);
      if (replacement?.length) card.points = replacement.map((text) => ({ text }));
    }
  }
  // PB-M4 (spec §5): a live calendar day — today's page, no section, the calendar on — has the slide too.
  const liveDay = p.calendar === null && !p.stale && input.calendarOn === true;
  const slides: SlideId[] = ["goodMorning", "whatYouDid", "leftOff", "suggested", ...(p.calendar !== null || liveDay ? (["calendar"] as const) : []), "launchpad"];
  const live = calendarDetail === undefined ? null : calendarDetailView(p, calendarDetail, liveDay);
  return {
    kind: "slides",
    slides,
    page: p,
    goodMorning: { ...goodMorning({ model, page: p, firstName, today }), aiSentence: summary?.goodMorningSentence ?? null },
    git: input.gitDetail === undefined ? null : gitDetailView(p, input.gitDetail, today),
    actions: input.actions === undefined ? null : actionsView(p, input.actions, input.gitDetail?.reply ?? null),
    live,
  };
}

/**
 * Each slide's heading, as the slide itself draws it (round-1 L3): the dots are named by it, so a dot says
 * "Suggested then" on an older page and "Good morning, Sam" with a name, as the heading it moves to does.
 * `deck-render.check.ts` compares every dot's name with the drawn `<h2>` of its slide.
 */
export function slideHeadings(view: Exclude<DeckView, { kind: "classic" }>): Record<SlideId, string> {
  const page = view.kind === "slides" ? view.page : null;
  return {
    goodMorning: view.goodMorning.greeting,
    // B1: What you did draws the window title once the live git check answers (`WhatYouDid.svelte`).
    whatYouDid: view.kind === "slides" ? (view.git?.title ?? "What you did") : "What you did",
    leftOff: "Where you left off",
    suggested: page?.suggested.title ?? "Suggested for today",
    calendar: page?.calendar?.stale === true ? "Calendar" : "Today's calendar",
    // Polish §6: "Before you start" while an amber tile waits (`launchpadHeading`, the rule Launchpad draws).
    launchpad: view.kind === "slides" ? launchpadHeading(view.git) : "You're all set",
  };
}

/** Where the deck is: the slide, how many there are, and which What-you-did cards are open. */
export interface DeckNav {
  index: number;
  count: number;
  open: string[];
}

export type DeckAction =
  | { type: "next" }
  | { type: "previous" }
  | { type: "jump"; index: number }
  | { type: "openAll"; keys: string[] }
  | { type: "closeAll" }
  /** One card's disclosure button (A-M5): opens it, or closes it if it is open. */
  | { type: "toggle"; key: string }
  /** A run finished or the file was rewritten: back to Good morning, with the new slide count. */
  | { type: "briefingChanged"; count: number };

/** The deck's navigation, pure. Bounds follow the slide list; a jump outside it changes nothing. */
export function deckReducer(s: DeckNav, a: DeckAction): DeckNav {
  switch (a.type) {
    case "next":
      return { ...s, index: Math.min(s.index + 1, s.count - 1) };
    case "previous":
      return { ...s, index: Math.max(s.index - 1, 0) };
    case "jump":
      return Number.isInteger(a.index) && a.index >= 0 && a.index < s.count ? { ...s, index: a.index } : s;
    case "openAll":
      return { ...s, open: [...a.keys] };
    case "closeAll":
      return { ...s, open: [] };
    case "toggle":
      return { ...s, open: s.open.includes(a.key) ? s.open.filter((k) => k !== a.key) : [...s.open, a.key] };
    case "briefingChanged":
      return { index: 0, count: a.count, open: [] };
  }
}

/** `src/git.ts`'s branch-line shapes; anything else is not a tag. */
export function parseBranch(text: string): BranchTag | null {
  const ab = /^On branch (\S+) \(ahead (\d+), behind (\d+)\)$/.exec(text);
  if (ab !== null) return { kind: "branch", name: ab[1]!, ahead: Number(ab[2]), behind: Number(ab[3]) };
  const nu = /^On branch (\S+) \(no upstream\)$/.exec(text);
  if (nu !== null) return { kind: "branch", name: nu[1]!, ahead: null, behind: null };
  const dh = /^Detached HEAD at ([0-9a-f]{7})$/.exec(text);
  return dh === null ? null : { kind: "detached", sha: dh[1]! };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * What you did's subtitle: "N projects · N commits · N PRs merged". Round-1 L2: never "0 commits" beside projects —
 * their lines carry no SHA the deck can count (the page's own header may say "1 commit"), so the commits part is left
 * out rather than contradict it. B1 builds the same words with its live PR count (`git-detail.ts`).
 */
export function subtitleOf(projects: number, commits: number, prs: number): string {
  return [
    plural(projects, "project", "projects"),
    ...(projects > 0 && commits === 0 ? [] : [plural(commits, "commit", "commits")]),
    `${plural(prs, "PR", "PRs")} merged`,
  ].join(" · ");
}

/**
 * Why a page cannot be mapped: the A spec's three rules (no title; a known section's content with its
 * heading missing; a `text` block inside a mapped section), and `unattached-line`: a line whose OWNER is
 * missing, the second rule's case one level down (a why line with no labelled line after it, a verdict
 * marker with no suggestion above it or a second one under the same suggestion). Its own name so the
 * archive probe (A-M6-T13) can group it apart.
 */
export type CannotMapReason = "no-title" | "content-without-heading" | "text-in-section" | "unattached-line";

export type MapResult =
  | { ok: true; page: DeckPage }
  | {
      ok: false;
      reason: CannotMapReason;
      /** The line that decided it ("" for no title). */
      line: string;
      /** That line's block index in the page (-1 for no title): the archive probe names a failure by it. */
      index: number;
    };

/** A `▶` heading's section, or null for a heading the deck does not know (exported for the archive probe). */
export function sectionKeyOf(heading: string): SectionKey | null {
  return SECTION_HEADINGS.find(([, words]) => heading.startsWith(words))?.[0] ?? null;
}

const LABELLED_KINDS = new Set(["bullet", "nested", "nested2", "notShown"]);

/** `YYYY-MM-DD` names a real calendar day: month 1-12 and a day that month has (round-1 L6). Integer
 *  arithmetic only, like [`longDate`]: no clock, no zone. */
export function isCalendarDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return y > 0 && days !== undefined && d >= 1 && d <= days;
}

/** A loaded page → the slides' data, or why it cannot be mapped. */
export function mapPage(blocks: Block[], today: string): MapResult {
  const pageDate = briefingDate(blocks);
  // A title whose date is not a real day (month 13, day 00) is no title: the deck never draws
  // "Your last briefing, from undefined 5 undefined" (round-1 L6).
  if (pageDate === null || !isCalendarDate(pageDate)) return { ok: false, reason: "no-title", line: "", index: -1 };

  const sections: DeckSection[] = [];
  const needsALook: string[] = [];
  const labelsInOrder: string[] = [];
  const cards = new Map<string, ProjectCard>();
  const cardFor = (label: string | null): ProjectCard => {
    const key = norm(label ?? "");
    let card = cards.get(key);
    if (card === undefined) {
      card = {
        key,
        label: key === "" ? "Other" : label!,
        slot: null,
        lines: [],
        mergedLines: [],
        todaySoFar: [],
        commits: 0,
        merged: [],
        mergedRow: null,
        points: [],
        why: [],
      };
      cards.set(key, card);
    }
    return card;
  };

  let whatYouDidHeading = "";
  const remainder: WhatYouDid["remainder"] = { header: null, more: null, moreCount: 0 };
  let quiet = false;
  const resumeCards = new Map<string, ResumeCard>();
  const resumeFor = (label: string | null): ResumeCard => {
    const key = norm(label ?? "");
    let card = resumeCards.get(key);
    if (card === undefined) {
      card = { key, label: key === "" ? "Other" : label!, slot: null, items: [], branch: null, why: [] };
      resumeCards.set(key, card);
    }
    return card;
  };
  let leftOffEmpty = false;
  let hasCalendar = false;
  const calendarRows: CalendarRow[] = [];
  const suggestions: SuggestionCard[] = [];
  let suggestedEmpty = false;
  /** Why lines waiting for the labelled line after them. A section that ends with one waiting is not a
   *  page the engine wrote (it emits a why only before its label's line), so no why is ever dropped. */
  let pendingWhy: string[] = [];
  /** The first waiting why's block index. */
  let pendingWhyAt = -1;
  const refuseWaitingWhy = (): MapResult | null =>
    pendingWhy.length > 0 ? { ok: false, reason: "unattached-line", line: pendingWhy[0]!, index: pendingWhyAt } : null;
  /** What you did's structure, for the points: level-1 nodes, and the open `•` and `◦`. */
  const roots: LineNode[] = [];
  let openL1: LineNode | null = null;
  let openL2: LineNode | null = null;
  let lineIndex = 0;

  let where: Where = "outside";
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi]!;
    const text = blockText(b);
    if (b.kind === "heading") {
      const key = sectionKeyOf(text);
      where = key ?? "unknown";
      if (key === "whatYouDid") whatYouDidHeading = text;
      if (key === "calendar") hasCalendar = true;
      sections.push({ key, heading: text, blocks: [] });
      const waiting = refuseWaitingWhy();
      if (waiting !== null) return waiting;
      continue;
    }
    sections[sections.length - 1]?.blocks.push(b);
    const dest = routeBlock(b, where);
    if (dest === "cannotMap") {
      return { ok: false, reason: b.kind === "text" ? "text-in-section" : "content-without-heading", line: text, index: bi };
    }
    const { label, rest } = parseLabel(text);
    if (where !== "unknown" && LABELLED_KINDS.has(b.kind) && label !== null) labelsInOrder.push(label);
    switch (dest) {
      case "needsALook":
        needsALook.push(text);
        break;
      case "projectCard": {
        const card = cardFor(label);
        const line: CardLine = { kind: b.kind as CardLine["kind"], text: rest, header: false };
        card.lines.push(line);
        card.why.push(...pendingWhy);
        pendingWhy = [];
        if (b.kind !== "notShown") {
          const node: LineNode = { key: card.key, line, index: lineIndex++, children: [] };
          if (b.kind === "bullet") {
            roots.push(node);
            openL1 = node;
            openL2 = null;
          } else if (b.kind === "nested") {
            (openL1?.children ?? roots).push(node);
            openL2 = node;
          } else {
            (openL2?.children ?? roots).push(node);
          }
        }
        break;
      }
      case "mergedRow": {
        const card = cardFor(label);
        card.mergedLines.push(rest);
        card.why.push(...pendingWhy);
        pendingWhy = [];
        openL1 = null;
        openL2 = null;
        break;
      }
      case "whyNext":
        if (pendingWhy.length === 0) pendingWhyAt = bi;
        pendingWhy.push(text);
        break;
      case "resumeItem":
      case "branchTag": {
        const card = resumeFor(label);
        const tag = dest === "branchTag" ? parseBranch(rest) : null;
        if (tag !== null && card.branch === null) card.branch = tag;
        else card.items.push(rest);
        card.why.push(...pendingWhy);
        pendingWhy = [];
        break;
      }
      case "suggestion": {
        const key = label === null || norm(label) === "" ? null : norm(label);
        suggestions.push({ n: suggestions.length + 1, key, label: key === null ? null : label, slot: null, text: rest, marker: null });
        break;
      }
      case "verdictMarker": {
        const above = suggestions[suggestions.length - 1];
        if (above === undefined || above.marker !== null) return { ok: false, reason: "unattached-line", line: text, index: bi };
        above.marker = text.trim();
        break;
      }
      case "emptyState":
        if (where === "leftOff") leftOffEmpty = true;
        else suggestedEmpty = true;
        break;
      case "calendar":
        calendarRows.push(parseCalendarLine(text, pageDate));
        break;
      case "todaySoFar":
        cardFor(label).todaySoFar.push(rest);
        break;
      case "subtitleDisclosure":
        if (b.kind === "coverage") remainder.header = text;
        else {
          remainder.more = text;
          remainder.moreCount = Number(/\d+/.exec(text)![0]);
        }
        break;
      case "quietDay":
        quiet = true;
        break;
      default:
        break;
    }
  }
  const waiting = refuseWaitingWhy();
  if (waiting !== null) return waiting;

  const markHeaders = (nodes: LineNode[]): void => {
    for (const n of nodes) {
      n.line.header = n.children.length > 0;
      markHeaders(n.children);
    }
  };
  markHeaders(roots);
  const groups = pointGroups(roots);

  const sectionTokens = new Set<string>();
  const prKeys = new Set<string>();
  for (const c of cards.values()) {
    const tokens = new Set(c.lines.flatMap(lineTokens));
    c.commits = tokens.size;
    for (const t of tokens) sectionTokens.add(t);
    c.merged = [...new Set(c.mergedLines.flatMap(mergedPrs))];
    c.mergedRow = c.merged.length > 0 ? `Merged: ${c.merged.map((n) => `#${n}`).join(", ")}` : null;
    for (const n of c.merged) prKeys.add(`${c.key}\u001f${n}`);
    c.points = pickPoints(c.key, groups);
  }
  const ofTotal = /— \d+ of (\d+) commits?\b/.exec(whatYouDidHeading);

  const slotList = assignSlots(labelsInOrder);
  // A Map, not an object: a label is repo text, and `constructor` or `__proto__` must not reach an inherited
  // property (round-1 L8). The page's `slots` is a copy with no prototype, for the same reason.
  const slotOf = new Map<string, number | null>();
  // Round-4 L7: ONE spelling per project, on every slide — the first one the page writes (page order across all its
  // sections), as its colour is the first-seen label's.
  const spellingOf = new Map<string, string>();
  labelsInOrder.forEach((label, i) => {
    const key = norm(label);
    if (key !== "" && !slotOf.has(key)) {
      slotOf.set(key, slotList[i] ?? null);
      spellingOf.set(key, label);
    }
  });
  const slots = Object.create(null) as Record<string, number | null>;
  for (const [key, slot] of slotOf) slots[key] = slot;
  const ordered = [...cards.values()].filter((c) => c.key !== "");
  const other = cards.get("");
  for (const c of ordered) {
    c.slot = slotOf.get(c.key) ?? null;
    c.label = spellingOf.get(c.key) ?? c.label;
  }
  for (const c of resumeCards.values()) {
    c.slot = c.key === "" ? null : (slotOf.get(c.key) ?? null);
    if (c.key !== "") c.label = spellingOf.get(c.key) ?? c.label;
  }
  for (const s of suggestions) {
    s.slot = s.key === null ? null : (slotOf.get(s.key) ?? null);
    if (s.key !== null) s.label = spellingOf.get(s.key) ?? s.label;
  }

  const projects = ordered.filter((c) => c.lines.length > 0 || c.mergedLines.length > 0).length;
  const commits = ofTotal !== null ? Number(ofTotal[1]) : sectionTokens.size;
  const prs = prKeys.size;
  const labels = pageLabels(pageDate, today);
  const stale = pageDate !== today;
  const calendar: CalendarSlide | null = !hasCalendar
    ? null
    : stale
      ? { stale: true, rows: [], events: [], staleText: CALENDAR_STALE_TEXT }
      : {
          stale: false,
          rows: calendarRows,
          events: calendarRows.flatMap((r) => (r.kind === "event" && r.event !== null ? [r.event] : [])),
          staleText: null,
        };
  return {
    ok: true,
    page: {
      pageDate,
      stale,
      labels,
      sections,
      needsALook,
      slots,
      whatYouDid: {
        cards: other === undefined ? ordered : [...ordered, other],
        projects,
        commits,
        prs,
        remainder,
        quiet,
        subtitle: subtitleOf(projects, commits, prs),
        emptyText: quiet ? "No commits in this window" : null,
      },
      leftOff: { cards: [...resumeCards.values()], empty: leftOffEmpty },
      suggested: { title: labels.suggested, cards: suggestions, empty: suggestedEmpty },
      calendar,
    },
  };
}

/* ── Good morning (A spec, "Good morning (M1)") ───────────────────────────────────────────────── */

/** `TodayView.svelte`'s quiet-day lines, word for word (pinned by `tests-web/deck.check.ts`). */
export const QUIET_DAY_LINE = "A quiet day: there were no commits in the briefing's window.";
export const QUIET_WITH_WARNING_LINE = "A quiet day: no commits in the window. See the warning below.";

/** The work line's label (user-directed 2026-10-22, Good morning option 2): `workLine` starts with it and a
 *  space, and the slide draws it bold before the counts. */
export const WORK_LABEL = "Your recent work:";

/** One project's commit bar (numbers only). */
export interface CommitBar {
  key: string;
  label: string;
  slot: number | null;
  commits: number;
}

export interface GoodMorning {
  /** The separate AI sentence, never the heading or live work line. */
  aiSentence: string | null;
  /** "Good morning, Sam", "Good morning", or on a stale page "Your last briefing, from …". */
  greeting: string;
  /** The page is an older one (`page.stale`; false with no page): the ONE stale source Good morning reads (round-4 L9) —
   *  the greeting is then the sentence with its date, and no second date line is drawn. */
  stale: boolean;
  /** The page's date ("Friday 16 October"), or today's when there is no page. */
  date: string;
  /** Everything the current Today screen shows above the briefing, unchanged: the status line and every banner. */
  status: TodayModel["status"];
  banners: Banner[];
  quietLine: string | null;
  /** "Your recent work: 3 projects · 120 commits · 6 PRs merged" (`WORK_LABEL`, a space, the counts); null with
   *  nothing to count. */
  workLine: string | null;
  bars: CommitBar[];
  firstSuggestion: SuggestionCard | null;
  needsALook: string[];
}

/** Good morning's data, in every state: `page` is null while loading, on a read error and before the first briefing. */
export function goodMorning(input: { model: TodayModel; page: DeckPage | null; firstName: string | null; today: string }): GoodMorning {
  const { model, page, firstName, today } = input;
  const w = page?.whatYouDid ?? null;
  const name = firstName !== null && firstName !== "" ? firstName : null;
  return {
    aiSentence: null,
    greeting: page !== null && page.stale ? page.labels.title! : name !== null ? `Good morning, ${name}` : "Good morning",
    stale: page !== null && page.stale,
    date: longDate(page?.pageDate ?? today),
    status: model.status,
    banners: model.banners,
    quietLine: model.quietWithWarning ? QUIET_WITH_WARNING_LINE : model.quiet ? QUIET_DAY_LINE : null,
    workLine: w !== null && (w.projects > 0 || w.commits > 0 || w.prs > 0) ? `${WORK_LABEL} ${w.subtitle}` : null,
    // COMMIT bars: a project with no counted commit (merge-only, or every SHA stripped) has none — a
    // zero-length bar says nothing, and its PRs are in the Your-recent-work line (A-M6 reading).
    bars: (w?.cards ?? [])
      .filter((c) => c.key !== "" && c.commits > 0)
      .map((c) => ({ key: c.key, label: c.label, slot: c.slot, commits: c.commits })),
    firstSuggestion: page?.suggested.cards[0] ?? null,
    needsALook: page?.needsALook ?? [],
  };
}
