/**
 * The ESCAPE-FIRST briefing renderer (T13, and Today's fallback — plan R1: "History escape-first
 * renderer"; the appendix's Electron T9 UI line and §8 "markdown rendering").
 *
 * ⚠ IT CHANGES PRESENTATION ONLY. The briefing bytes are `renderBriefing`'s output
 * (`src/render.ts`), read verbatim; nothing here writes them back, and the archive is the
 * engine's calibration corpus.
 *
 * ⚠ IT PRODUCES A MODEL, NOT MARKUP. `renderMarkdown` returns `Block[]` — each block a list of
 * typed `Span`s carrying plain strings — and `BriefingView.svelte` turns that into DOM nodes with
 * `{}` interpolation (Svelte sets text nodes; it never parses a string as HTML). There is no HTML
 * string anywhere on this path, so there is nothing for a hostile commit subject to break out of:
 * `<img src=x onerror=…>` is TEXT from the first byte to the last. `gui/tests-web/static.check.ts`
 * refuses `{@html}` and every DOM HTML setter across `gui/src`.
 *
 * ⚠ ESCAPE ALL, THEN A FIXED ALLOWLIST OF INLINE FORMS — and nothing else:
 *   - `**bold**` → a strong span;
 *   - `` `code` `` → a code span;
 *   - `[label](url)` → a LINK span only when `url` parses as `http:` or `https:`. Every other
 *     scheme (`javascript:`, `data:`, `file:`, a relative path) stays literal text, brackets and all.
 *     ⚠ A link span is NOT NAVIGABLE: it renders its label and its target as text, with no `href`
 *     at all — the webview has no route to an opener (since B6 `tauri-plugin-opener` IS a
 *     dependency, but Rust-side free functions only: never registered, no webview grant, no JS
 *     package), and an anchor in this webview would navigate the app's OWN window to a remote
 *     page (docs/gui-seam.md §10);
 *   - `![alt](src)` → literal text. Images are never rendered;
 *   - a SHA-shaped token (the engine's own `isShaShaped` rule, `src/sha.ts`) → a styled span, NOT a
 *     link — no repo-URL guessing, and bare URLs are never linkified either.
 *
 * ⚠ LINE SHAPES ARE THE ENGINE'S, and they are a closed set (`renderBriefing` is the only producer).
 * Each line is classified by its fixed prefix; an unknown line — an older archive, a hand edit —
 * degrades to a `text` block, never to an error and never to markup.
 */

export type SpanKind = "text" | "strong" | "code" | "sha" | "link";

export interface Span {
  kind: SpanKind;
  text: string;
  /** Only on `link` spans, and only ever an `http:`/`https:` URL. Shown as text, never navigated. */
  href?: string;
}

export type BlockKind =
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
  | "footer" // — generated locally via <provider>
  | "text"; // any other line

export interface Block {
  kind: BlockKind;
  spans: Span[];
}

/* ── the engine's line prefixes (pinned against `src/` by gui/tests-web/briefing.check.ts) ────── */

/** `src/subprojects.ts`, `LEGEND_PREFIX`. */
export const LEGEND_PREFIX = "   (labels: ";
/** `src/subprojects.ts`, `NOT_SHOWN_PREFIX` (five spaces, a middle dot, a space). */
export const NOT_SHOWN_PREFIX = "     · ";
/** `src/transcripts/frame.ts`, `WHY_PREFIX`. */
export const WHY_PREFIX = '   — you wrote: "';

const BULLET = "   • ";
const NESTED = "      ◦ ";
/** `src/render.ts`, `CAMPAIGN_L3_PREFIX` (tier B, spec §4.7): nine spaces, U+25AA, one space — a Stage-1
 *  group's member under a campaign, the third level. Classified before the fallbacks; an archived
 *  two-level page carries no such line, so its classification is unchanged. Pinned against `src/`. */
export const NESTED2 = "         ▪ ";
const HEADING = "▶ ";
const INDENT = "   ";
const PLACEHOLDERS = new Set(["(nothing in progress)", "(none)", "(no commits in the window)"]);
/** Both header spellings: "Morning" was dropped on 2026-08-17 and older archives still carry it. */
const TITLE = /^☀️?\s+(Daily|Morning) briefing\b/;

/** Lines longer than this are shown as plain text: the inline scan is per-position, and a
 *  1 MiB single-line file must not cost a quadratic parse. A briefing line is ~100-300 chars. */
export const MAX_INLINE_CHARS = 2000;

/** The engine's `isShaShaped` (`src/sha.ts`), for tokens of 7+ characters. */
export function isShaShaped(tok: string): boolean {
  if (!/^[0-9a-f]{4,40}$/i.test(tok)) return false;
  if (!/[a-f]/i.test(tok)) return false;
  return /[0-9]/.test(tok) || tok.length >= 7;
}

/** The URL if it is an absolute `http:`/`https:` URL with no whitespace or control character; else null. */
export function safeHref(raw: string): string | null {
  if (!/^https?:\/\//i.test(raw) || /[\s\x00-\x1f\x7f]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function pushText(spans: Span[], text: string): void {
  if (text === "") return;
  const sha = /\b[0-9a-fA-F]{7,40}\b/g;
  let last = 0;
  for (const m of text.matchAll(sha)) {
    if (!isShaShaped(m[0])) continue;
    const at = m.index ?? 0;
    if (at > last) spans.push({ kind: "text", text: text.slice(last, at) });
    spans.push({ kind: "sha", text: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) spans.push({ kind: "text", text: text.slice(last) });
}

const IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/y;
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/y;
const STRONG = /\*\*([^*\n]+)\*\*/y;
const CODE = /`([^`\n]+)`/y;

/** One line's inline content → spans. Everything not matched by the allowlist is text. */
export function inlineSpans(src: string): Span[] {
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
export function classifyLine(line: string): { kind: BlockKind; text: string } | null {
  if (line.trim() === "") return null;
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
  if (line.startsWith("— generated locally via ")) return { kind: "footer", text: line };
  return { kind: "text", text: line };
}

/** A briefing's markdown → blocks. Pure. */
export function renderMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const classified = classifyLine(line);
    if (classified === null) continue;
    blocks.push({ kind: classified.kind, spans: inlineSpans(classified.text) });
  }
  return blocks;
}

/** A block's visible text, as `BriefingView` renders it. */
export function blockText(block: Block): string {
  return block.spans.map((s) => (s.kind === "link" ? `${s.text} (${s.href ?? ""})` : s.text)).join("");
}
