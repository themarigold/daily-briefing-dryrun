/**
 * Engine-owned saved-page card projection. Mirrors briefing-md's visible parsing and
 * deck.ts's routing/population, including refusal paths and first display spelling.
 * GUI agreement tests pin this required copy; the engine never imports GUI code.
 */
import { CALENDAR_LINE_PREFIX, isCalendarHeading } from "../calendar/render-contract";
import { NOTICE_PREFIX } from "../failover";
import { CAMPAIGN_L3_PREFIX as NESTED2 } from "../render";
import { LEGEND_PREFIX, NOT_SHOWN_PREFIX, VERDICT_MARKER_PREFIX, norm } from "../subprojects";
import { WHY_PREFIX } from "../transcripts/frame";

export interface SummaryCard { key: string; label: string }

type SpanKind = "text" | "strong" | "code" | "sha" | "link";

interface Span {
  kind: SpanKind;
  text: string;
  /** Only on `link` spans, and only ever an `http:`/`https:` URL. Shown as text, never navigated. */
  href?: string;
}

type BlockKind =
  | "notice" // ℹ︎ Skipped "…": … — used "…" — a provider-walk line ABOVE the title (provider fallback)
  | "title" // ☀️  Daily briefing — <date>  (this machine: …)
  | "outage" // ⚠️  No briefing for N days — …
  | "legend" // (labels: … are areas of repo …)
  | "heading" // ▶ Where you left off / What you did / Today so far / Suggested next
  | "bullet" // • [repo] text
  | "nested" // ◦ [repo] text — a member under a clustered story line
  | "nested2" // ▪ [repo] text — a group member at the THIRD level, under a campaign (tier B)
  | "notShown" // · [label] sha subject — a commit the recap did not cover
  | "coverage" // ⚠ N in-window commit(s) NOT shown above:
  | "why" // — you wrote: "…"
  | "placeholder" // (nothing in progress) / (none) / (no commits in the window)
  | "warnings" // ⚠ a; b
  | "calendar" // ◦ a line inside the ▶ Today's calendar section (v0.3.0) — an event or a source's status
  | "footer" // — generated via <provider>  (archives before 0.2.0: — generated locally via <provider>)
  | "text"; // any other line

interface Block {
  kind: BlockKind;
  spans: Span[];
}

/* ── line prefixes the renderer writes as literals; the named ones are imported above ──────────── */

const BULLET = "   • ";
const NESTED = "      ◦ ";
const HEADING = "▶ ";
const INDENT = "   ";
const PLACEHOLDERS = new Set(["(nothing in progress)", "(none)", "(no commits in the window)"]);
/** Both header spellings: "Morning" was dropped on 2026-08-17 and older archives still carry it. */
const TITLE = /^☀️?\s+(Daily|Morning) briefing\b/;
/** Both footer spellings. `src/render.ts` writes `— generated via <provider>` since the Phase E final
 *  harden ("locally" was false for an API provider and for the default CLI provider); briefings
 *  archived before that carry `— generated locally via <provider>` and must still read as a footer. */
const FOOTER_PREFIXES = ["— generated via ", "— generated locally via "];

/** Lines longer than this are shown as plain text: the inline scan is per-position, and a
 *  1 MiB single-line file must not cost a quadratic parse. A briefing line is ~100-300 chars. */
const MAX_INLINE_CHARS = 2000;

/** The URL if it is an absolute `http:`/`https:` URL with no whitespace or control character; else null. */
function safeHref(raw: string): string | null {
  if (!/^https?:\/\//i.test(raw) || /[\s\x00-\x1f\x7f]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function pushText(spans: Span[], text: string): void {
  if (text !== "") spans.push({ kind: "text", text });
}

const IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/y;
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/y;
const STRONG = /\*\*([^*\n]+)\*\*/y;
const CODE = /`([^`\n]+)`/y;

/** One line's inline content → spans. Everything not matched by the allowlist is text. */
function inlineSpans(src: string): Span[] {
  const spans: Span[] = [];
  if (src.length > MAX_INLINE_CHARS) {
    spans.push({ kind: "text", text: src });
    return spans;
  }
  let text = "";
  const flush = () => {
    pushText(spans, text);
    text = "";
  };
  let i = 0;
  const at = (re: RegExp): RegExpExecArray | null => {
    re.lastIndex = i;
    return re.exec(src);
  };
  while (i < src.length) {
    const c = src[i];
    let m: RegExpExecArray | null;
    if (c === "!" && (m = at(IMAGE)) !== null) {
      // Never an image, never a link: the whole construct stays text.
      text += m[0];
      i += m[0].length;
    } else if (c === "[" && (m = at(LINK)) !== null) {
      const href = safeHref(m[2] ?? "");
      if (href === null) {
        text += m[0];
      } else {
        flush();
        spans.push({ kind: "link", text: m[1] ?? "", href });
      }
      i += m[0].length;
    } else if (c === "*" && (m = at(STRONG)) !== null) {
      flush();
      spans.push({ kind: "strong", text: m[1] ?? "" });
      i += m[0].length;
    } else if (c === "`" && (m = at(CODE)) !== null) {
      flush();
      spans.push({ kind: "code", text: m[1] ?? "" });
      i += m[0].length;
    } else {
      text += c;
      i += 1;
    }
  }
  flush();
  return spans;
}

/** Classify one line by its fixed prefix; return the kind and the text after the prefix. */
function classifyLine(line: string): { kind: BlockKind; text: string } | null {
  if (line.trim() === "") return null;
  if (line.startsWith(NOTICE_PREFIX)) return { kind: "notice", text: line };
  if (TITLE.test(line)) return { kind: "title", text: line };
  if (line.startsWith("⚠️  No briefing for")) return { kind: "outage", text: line };
  if (line.startsWith(HEADING)) return { kind: "heading", text: line.slice(HEADING.length) };
  if (line.startsWith(NESTED)) return { kind: "nested", text: line.slice(NESTED.length) };
  if (line.startsWith(NESTED2)) return { kind: "nested2", text: line.slice(NESTED2.length) };
  if (line.startsWith(NOT_SHOWN_PREFIX)) {
    return { kind: "notShown", text: line.slice(NOT_SHOWN_PREFIX.length) };
  }
  if (line.startsWith(BULLET)) return { kind: "bullet", text: line.slice(BULLET.length) };
  if (line.startsWith(LEGEND_PREFIX)) return { kind: "legend", text: line.slice(INDENT.length) };
  if (line.startsWith(WHY_PREFIX)) return { kind: "why", text: line.slice(INDENT.length) };
  if (line.startsWith(`${INDENT}⚠ `)) return { kind: "coverage", text: line.slice(INDENT.length) };
  if (line.startsWith(INDENT) && PLACEHOLDERS.has(line.slice(INDENT.length))) {
    return { kind: "placeholder", text: line.slice(INDENT.length) };
  }
  if (line.startsWith("⚠ ")) return { kind: "warnings", text: line };
  if (FOOTER_PREFIXES.some((p) => line.startsWith(p))) return { kind: "footer", text: line };
  return { kind: "text", text: line };
}

/** A briefing's markdown → blocks. Pure. */
function renderMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  /** Inside the calendar section: from its heading to the next `▶ ` heading (see the header). */
  let inCalendar = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith(HEADING)) inCalendar = isCalendarHeading(line);
    if (inCalendar && line.startsWith(CALENDAR_LINE_PREFIX)) {
      blocks.push({ kind: "calendar", spans: [{ kind: "text", text: line.slice(CALENDAR_LINE_PREFIX.length) }] });
      continue;
    }
    const classified = classifyLine(line);
    if (classified === null) continue;
    blocks.push({ kind: classified.kind, spans: inlineSpans(classified.text) });
  }
  return blocks;
}

/** A block's visible text, as `BriefingView` renders it. */
function blockText(block: Block): string {
  return block.spans.map((s) => (s.kind === "link" ? `${s.text} (${s.href ?? ""})` : s.text)).join("");
}

type SectionKey = "leftOff" | "whatYouDid" | "todaySoFar" | "calendar" | "suggested";

const SECTION_HEADINGS: readonly (readonly [SectionKey, string])[] = [
  ["leftOff", "Where you left off"],
  ["whatYouDid", "What you did"],
  ["todaySoFar", "Today so far"],
  ["calendar", "Today's calendar"],
  ["suggested", "Suggested next"],
];

/** Where a block sits: in a known section, under a `▶` heading the deck does not know, or before any heading. */
type Where = SectionKey | "unknown" | "outside";

/** Where a block goes. `cannotMap` means the whole page falls back to the classic view. */
type Destination =
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
function parseLabel(text: string): { label: string | null; rest: string } {
  const m = /^\[([^\]]*)\] ?([\s\S]*)$/.exec(text);
  return m === null ? { label: null, rest: text } : { label: m[1]!, rest: m[2]! };
}

const isMerge = (text: string): boolean => parseLabel(text).rest.startsWith("\u{1F500}");

/**
 * The full `BlockKind` → destination table (A spec, "Where each line kind goes"; plan A-M3-T5). A line
 * kind in a known section where the table gives it no place is the page's "content with its heading
 * missing" (`cannotMap`); under an unknown heading everything is Full briefing only.
 */
function routeBlock(block: Block, where: Where): Destination {
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


function isCalendarDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return y > 0 && days !== undefined && d >= 1 && d <= days;
}


/** Allowed summary keys, in the exact order the saved-page deck displays its cards. */
export function summaryCardsFromPage(pageText: string): SummaryCard[] {
  const blocks = renderMarkdown(pageText);
  const title = blocks.find((b) => b.kind === "title");
  const date = title && /briefing — (\d{4}-\d{2}-\d{2})/.exec(blockText(title))?.[1];
  if (!date || !isCalendarDate(date)) return [];

  const cards = new Map<string, SummaryCard>();
  const spellings = new Map<string, string>();
  let where: Where = "outside";
  let waitingWhy = false;
  let suggestion = false;
  let verdict = false;
  for (const block of blocks) {
    const text = blockText(block);
    if (block.kind === "heading") {
      if (waitingWhy) return [];
      where = SECTION_HEADINGS.find(([, words]) => text.startsWith(words))?.[0] ?? "unknown";
      continue;
    }
    const dest = routeBlock(block, where);
    if (dest === "cannotMap") return [];
    const { label } = parseLabel(text);
    const key = norm(label ?? "");
    if (where !== "unknown" && ["bullet", "nested", "nested2", "notShown"].includes(block.kind) && label !== null && key !== "" && !spellings.has(key)) {
      spellings.set(key, label);
    }
    if (dest === "projectCard" || dest === "mergedRow" || dest === "todaySoFar") {
      if (!cards.has(key)) cards.set(key, { key: key === "" ? "other:" : `project:${key}`, label: key === "" ? "Other" : label! });
      if (dest !== "todaySoFar") waitingWhy = false;
    } else if (dest === "whyNext") {
      waitingWhy = true;
    } else if (dest === "resumeItem" || dest === "branchTag") {
      waitingWhy = false;
    } else if (dest === "suggestion") {
      suggestion = true;
      verdict = false;
    } else if (dest === "verdictMarker") {
      if (!suggestion || verdict) return [];
      verdict = true;
    }
  }
  if (waitingWhy) return [];
  const ordered = [...cards].filter(([key]) => key !== "").map(([key, card]) => ({ ...card, label: spellings.get(key) ?? card.label }));
  const other = cards.get("");
  if (other) ordered.push(other);
  return ordered;
}
