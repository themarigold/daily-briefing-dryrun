// src/calendar/clean.ts — CLEANING, ONCE, AT READ TIME (v0.3.0, plan M3a; spec r4 §6 "Cleaning").
//
// Every text field of every event is cleaned before anything else sees it — before the struct, the prompt
// or anything persisted: title, location, description, the organizer's and attendees' names, and an
// unclear-time event's `tzid` (feed text that reaches the stored struct and the rendered line). Producers —
// the link parser (M2c) and the Mac reader (M10c) — call `cleanCalEvent` on each event as they read it;
// `reconcileCalendar` assumes it has run.
//
// The rules, in order:
//   0. NFKC-fold before HTML stripping and after entity decoding;
//   1. strip HTML, decode entities, strip controls/invisibles and collapse whitespace;
//   2. bound the normalised input at a WORD boundary (65,536 characters), dropping any cut word whole;
//   3. redactCredentials BEFORE boilerplate cuts and URL replacement: URL tokenization stops at an
//      apostrophe even though it is a valid userinfo sub-delimiter, so replacing first can leak a tail.
//      The separate input bound limits work in this and subsequent passes. It is much larger than
//      the content caps so ordinary prose after a long URL or secret survives their replacement.
//   4. (descriptions) cut conferencing boilerplate;
//   5. replace URLs with `<host> link`, redact labelled secrets and dial-string codes;
//   6. normalise whitespace/controls, cap the CONTENT (title-class 120, description 400) at a word
//      boundary after shortening URLs, removing boilerplate and cleaning secrets, then final credential scrub.
//
// Every regex below starts only at the start of its run or is bounded, so the pass is linear in the input;
// `test/calendar-clean.test.ts` times each rule on `repeat(1e5)` inputs.
import { redactCredentials, REDACTION } from "../transcripts/credentials";
import type { CalEvent } from "./types";

/** Spec §6 caps, applied once here. Title, location, names and tzid share the title cap. */
export const CAL_TITLE_MAX = 120;
export const CAL_DESCRIPTION_MAX = 400;
/** Work bound for the credential/URL/secret passes, separate from the final display caps above. */
const CAL_INPUT_MAX = 64 * 1024;
/** RFC 5321's path limit; a longer "address" is not one. */
const EMAIL_MAX = 254;

const ELLIPSIS = "…";

// 1. HTML ──────────────────────────────────────────────────────────────────────────────────────────

/** A tag: `<`, a letter, `/`, `!` or `?`, then anything but angle brackets, then `>`. `[^<>]` keeps it
 *  linear (an unclosed `<` scans only to the next `<`); requiring a letter after `<` keeps `a < b and c > d`
 *  as text. Text inside a tag — an `href`, with whatever secret its URL carries — goes with the tag. */
const TAG_RE = /<[a-z\/!?][^<>]*>/gi;
const ENTITY_RE = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
};

function decodeEntity(whole: string, dec?: string, hex?: string, name?: string): string {
  if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  const cp = dec !== undefined ? Number(dec) : Number.parseInt(hex!, 16);
  // A NUL, a surrogate or past U+10FFFF is not text; the control strip after this removes C0/C1.
  return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : " ";
}

/** Exported unchanged for the live read's notes (redesign C, ./notes.ts). */
export function stripHtml(s: string): string {
  return s.replace(TAG_RE, " ").replace(ENTITY_RE, decodeEntity);
}

// 2 / 6 / 7. Control characters and whitespace ─────────────────────────────────────────────────────────

/** Line-breaking and spacing characters, all read as a space: the C0 whitespace, NEL (U+0085), and the
 *  Unicode line and paragraph separators (U+2028/U+2029), which a model may read as a line break. */
const BREAKS_RE = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
/** Removed outright: every other C0 control, DEL, C1, and the invisible format characters that reorder or
 *  hide text — bidi embeddings/overrides/isolates and marks (U+200E/F, U+202A–E, U+2066–9, and the Arabic letter
 *  mark U+061C), zero-width space, word joiner and friends, BOM, soft hyphen, the Mongolian vowel separator
 *  (U+180E), the interlinear annotation characters (U+FFF9–FFFB), the Unicode TAG block (U+E0000–E007F), and
 *  the blank-rendering characters the M2b checkpoint found surviving: the combining grapheme joiner (U+034F), the
 *  Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the Khmer inherent vowels (U+17B4/U+17B5), the shorthand
 *  format controls (U+1BCA0–1BCA3) and the musical-symbol format characters (U+1D173–1D17A). The variation
 *  selectors (U+FE00–FE0F, U+E0100–E01EF) stay: emoji presentation needs them.
 *  ⚠ THE TAG BLOCK is the "ASCII smuggling" channel: each tag character mirrors an ASCII one, renders as
 *  nothing, and is still read by a model — so a stranger's invite can carry an instruction no human sees. It
 *  lies outside the BMP, which is why this pattern carries the `u` flag (without it a class cannot name an
 *  astral code point; M3a checkpoint MEDIUM).
 *  ZWJ/ZWNJ (U+200C/D) stay: scripts and emoji sequences need them. Accepted residual: since they survive,
 *  they can still split a label or a scheme (`pass\u200ccode: 1234`, `https\u200d://…`) so the word rules
 *  below miss it — low risk, because only the text's own author can hide their own secret that way. */
/** Exported unchanged for the live read's notes (redesign C, ./notes.ts), which keep newlines. */
export const INVISIBLE_RE = /[\x00-\x08\x0e-\x1f\x7f-\x84\x86-\x9f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0\ufff9-\ufffb\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}]/gu;

function normaliseSpace(s: string): string {
  return s.replace(BREAKS_RE, " ").replace(INVISIBLE_RE, "").replace(/\s+/g, " ").trim();
}

// 3. Conferencing boilerplate ────────────────────────────────────────────────────────────────────────

/** The first of these markers starts the boilerplate block; everything from it on is cut. Case-insensitive
 *  literals (and one bounded run), so linear. Google Meet's block opens with `-::~:~::~`; Zoom's with "Join
 *  Zoom Meeting" or "… is inviting you to a scheduled Zoom meeting"; Teams' with a long underscore rule
 *  and "Microsoft Teams meeting" / "Join on your computer, mobile app or room device"; Webex's with
 *  "-- Do not delete or change any of the following text. --" or "join the Webex meeting". */
const BOILERPLATE_RE = new RegExp(
  [
    String.raw`-::~:~::~`,
    String.raw`_{10}`,
    String.raw`join zoom meeting`,
    String.raw`is inviting you to a scheduled zoom meeting`,
    String.raw`join (?:the )?microsoft teams meeting`,
    String.raw`microsoft teams meeting`,
    String.raw`join on your computer,? mobile app or room device`,
    String.raw`do not delete or change any of the following text`,
    String.raw`join (?:the )?webex meeting`,
    String.raw`webex meeting number`,
  ].join("|"),
  "i",
);

/** Dangling separators a cut leaves behind (`… renewal. --`), trimmed by a loop — a `[…]+$` regex would
 *  rescan a long run of them from every position. */
const SEPARATORS = " -–—_:|~";

/** Exported unchanged for the live read's notes (redesign C, ./notes.ts). */
export function cutBoilerplate(s: string): string {
  const m = BOILERPLATE_RE.exec(s);
  if (!m) return s;
  let end = m.index;
  while (end > 0 && SEPARATORS.includes(s[end - 1]!)) end--;
  return s.slice(0, end);
}

// 4. URLs ────────────────────────────────────────────────────────────────────────────────────────────

/** `scheme://…` — any scheme, bounded at 32 characters and starting only where its letters start (the
 *  lookbehind), so linear. The token runs to whitespace, a quote, an angle bracket or a backtick. Fix-round 1:
 *  also the percent-encoded (`https%3A%2F%2F…`) and JSON-escaped (`https:\/\/…`) spellings — a feed that quotes a
 *  link inside another link, or a JSON blob pasted into a title, carried it through whole. Final harden r3: and
 *  the backslash spellings (`https:\\host\path`, `https:/\host`, `%5C`), which browsers open as `https://host/path`. */
/** Exported unchanged (with the two below) for the live read's notes, which REMOVE links (redesign C, ./notes.ts). */
export const SCHEME_URL_RE = /(?<![a-z0-9+.\-])[a-z][a-z0-9+.\-]{0,31}(?::[\/\\]{2}|%3a(?:%2f|%5c){2})[^\s<>"'`]*/gi;
/** A match whose scheme separator is encoded or backslashed: its `%3A` `%2F` `%5C` `%40`, `\/` and `\` are read
 *  plainly to find the host. Final harden r3: the backslash spellings — `https:\\host\path`, which a WHATWG parser
 *  reads as `https://host/path` for the special schemes — and the separator `:` + any two of `/` `\`. */
const ENCODED_SCHEME_RE = /^[a-z][a-z0-9+.\-]*(?::[\/\\]?\\|%3a(?:%2f|%5c))/i;
const decodeForHost = (url: string): string => {
  if (!ENCODED_SCHEME_RE.test(url)) return url;
  const plain = url.replace(/%3a/gi, ":").replace(/%2f/gi, "/").replace(/%5c/gi, "\\").replace(/%40/gi, "@");
  // The separator first (`:\/\/`, or any two of `/` `\`), then every remaining `\/` and `\` read as `/`.
  return plain.replace(/^([a-z][a-z0-9+.\-]*):(?:\\\/\\\/|[\/\\]{2})/i, "$1://").replace(/\\\//g, "/").replace(/\\/g, "/");
};
/** A host with a path or a `www.` host, no scheme (`meet.google.com/abc-defg-hij`, `www.example.com`) —
 *  starting only at the start of the dotted run, and never after `@` (an email address is not a URL). */
export const BARE_URL_RE = /(?<![\w.@\-\/])(?:(?:[a-z0-9\-]{1,63}\.)+[a-z]{2,63}(?::\d{1,5})?\/[^\s<>"'`]*|www\.(?:[a-z0-9\-]{1,63}\.)+[a-z]{2,63}(?![a-z0-9\-])(?::\d{1,5})?)/gi;
/** Punctuation that ends a sentence rather than the URL. Trimmed by a backwards scan, never a `…+$` regex: an
 *  unanchored one retries a punctuation run inside the token at every position (quadratic; ~2.6 s at 60k). */
const URL_TRAIL = ".,;:!?)]}'\"";
function urlTrail(match: string): string {
  let end = match.length;
  while (end > 0 && URL_TRAIL.includes(match[end - 1]!)) end--;
  return match.slice(end);
}
const HOST_RE = /^(?:[a-z0-9\-]{1,63}\.)*[a-z0-9\-]{1,63}$/;

/** The host a URL names: no scheme, no userinfo, no port, lower-case, no `www.`; null when what is there is
 *  not a plain host name (or a bracketed IP literal). */
export function urlHost(url: string): string | null {
  const rest = url.replace(/^[a-z][a-z0-9+.\-]*:\/\//i, "");
  const end = rest.search(/[\/?#\\]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  let host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "").toLowerCase();
  if (/^\[[0-9a-f:.]+\]$/.test(host)) return host;
  host = host.replace(/^www\./, "");
  return host.length <= 253 && HOST_RE.test(host) && /[a-z]/.test(host) ? host : null;
}

function urlToHostLink(match: string): string {
  const trail = urlTrail(match);
  const url = trail ? match.slice(0, -trail.length) : match;
  const host = urlHost(decodeForHost(url));
  return (host ? `${host} link` : "link") + trail;
}

/** Post-convergence LOW: a calendar or web scheme (`http`, `https`, `webcal`) with ONE separator — or any run of
 *  `/` `\` `%2F` `%5C` — then a host: `https:/host`, `https:\host\path`, which a WHATWG parser reads as
 *  `https://host` for the special schemes (webcal is a calendar app's alias for https). Runs AFTER `SCHEME_URL_RE`,
 *  so it sees only what that rule left. Any other word followed by a colon is untouched. Linear: the scheme is a
 *  fixed literal, and the lookahead's separator run and its host character are disjoint. */
export const SPECIAL_URL_RE = /(?<![a-z0-9+.\-])(?:https?|webcal)(?::|%3a)(?=(?:[\/\\]|%2f|%5c)+[a-z0-9])[^\s<>"'`]*/gi;
/** Its separator run rewritten to `:\\`, so `decodeForHost` reads it (and any `%2F` `%5C` `%40`) plainly. */
const specialToHostLink = (match: string): string =>
  urlToHostLink(match.replace(/^([a-z]+)(?::|%3a)(?:[\/\\]|%2f|%5c)+/i, "$1:\\\\"));

function replaceUrls(s: string): string {
  return s.replace(SCHEME_URL_RE, urlToHostLink).replace(SPECIAL_URL_RE, specialToHostLink).replace(BARE_URL_RE, urlToHostLink);
}

// 5. Labelled secrets and dial strings ───────────────────────────────────────────────────────────────

/** Exported unchanged for the live read's notes (redesign C, ./notes.ts): a label at a line's end joins its value. */
export const LABELS = String.raw`passcode|password|pwd|pin|meeting[ \-]?id|access[ \-]?code|conference[ \-]?id|host[ \-]?key`;
/** Digit groups that read as one number (`845 1234 5678`, `123-456-789`), ending at a boundary — so
 *  `PIN: 1234 at 10am` stops at 1234 and `123abc` is not a number. */
const DIGITS = String.raw`\d+(?:[ .\-]\d+)*(?!\w)`;
/** A label, then EITHER an explicit separator and the value — a number, else one whitespace-free token — OR
 *  just a space and a value that starts with a digit (`PIN 1234`). The explicit separators: `:` `=` `#`, a
 *  fullwidth colon `：`, a hyphen or en dash (`Passcode - ZZx`, `PIN – 5555`), or "is" optionally followed by
 *  a colon (`Password is: ZZhunter`, M3a checkpoint LOW). A label followed by an ordinary word (`Password reset
 *  meeting`, `Pin the agenda`) is left alone, and so is a hyphenated word (`pin-up`): after a dash, a value that
 *  is not a number counts only when a space follows the dash (`Passcode - ZZx`). A `)` after
 *  the label covers Webex's "Meeting number (access code): …". Whitespace is single spaces by now, so every
 *  optional space is one character and the pattern is linear. */
const LABELLED_RE = new RegExp(
  String.raw`\b(${LABELS})\b(\)?(?: ?[:=#：] ?| ?[\-–] ?| is[:：] ?| is | ))(${DIGITS}|(?<=[:=#：] ?|[\-–] |is[:：] ?|is )[^\s]+)`,
  "gi",
);

/** Exported unchanged for the live read's notes (redesign C, ./notes.ts). */
export function redactLabelled(s: string): string {
  return s.replace(LABELLED_RE, (_m, label: string, sep: string) => `${label}${sep}${REDACTION}`);
}

/** A dial string: a run of digits and dial punctuation with no letters or spaces, starting where its run
 *  starts. It is treated as one only when it carries a pause or a tone (`;`, `#`, `,,`), or starts with `+`
 *  and has a `,` — so `1,000,000` is a number, not a dial string. */
const DIAL_RE = /(?<![\d+])\+?\d[\d,;#*\-.()]*/g;
const DIAL_DIGITS_RE = /([,;#]\*?)\d+/g;

/** Exported unchanged for the live read's notes (redesign C, ./notes.ts): rule 5's other half. */
export function redactDialStrings(s: string): string {
  return s.replace(DIAL_RE, (tok) =>
    /[;#]|,,/.test(tok) || (tok.startsWith("+") && tok.includes(",")) ? tok.replace(DIAL_DIGITS_RE, `$1${REDACTION}`) : tok);
}

// 8. Caps ────────────────────────────────────────────────────────────────────────────────────────────

/** `s` cut to at most `max` characters, ending in `…` when cut. The cut never splits a word: a word that
 *  would be cut is dropped whole (a field that is one giant word becomes `…`). */
export function capAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max - ELLIPSIS.length);
  if (s[max - ELLIPSIS.length] !== " ") {
    const sp = cut.lastIndexOf(" ");
    cut = sp === -1 ? "" : cut.slice(0, sp);
  }
  return cut.trimEnd() + ELLIPSIS;
}

// ── the pass ────────────────────────────────────────────────────────────────────────────────────────

export type CalTextKind = "title" | "description";

/** Clean one text field (spec §6). `kind` picks the cap (120 or 400) and whether conferencing boilerplate
 *  is cut (descriptions only). A non-string comes back as "". */
export function cleanCalendarText(text: string, kind: CalTextKind = "title"): string {
  if (typeof text !== "string") return "";
  // NFKC before AND after the HTML strip, before every word rule (final harden r2): a full-width
  // `ＨＴＴＰＳ://…` (or one spelled as `&#xFF28;…` entities) would slip past the URL and credential rules and
  // then be folded into a real URL by the prompt's own NFKC (`./prompt.ts` `field`). NFKC is linear.
  let s = normaliseSpace(stripHtml(text.normalize("NFKC")).normalize("NFKC"));
  const max = kind === "description" ? CAL_DESCRIPTION_MAX : CAL_TITLE_MAX;
  s = redactCredentials(capAtWord(s, CAL_INPUT_MAX));
  if (kind === "description") s = cutBoilerplate(s);
  s = redactDialStrings(redactLabelled(replaceUrls(s)));
  s = normaliseSpace(s);
  s = capAtWord(s, max);
  return redactCredentials(s);
}

/** Is `s` text that `cleanCalendarText(_, kind)` could have produced — a string within the kind's cap with no
 *  line break and no control or invisible character? The PARENT's check on the parse child's answer
 *  (`./parse-runner.ts`): cleaning runs in the child, and this refuses anything it did not clean. A check, not a
 *  second cleaning (cleaning is not idempotent). Linear. */
export function isCleanCalendarText(s: unknown, kind: CalTextKind = "title"): boolean {
  if (typeof s !== "string" || s.length > (kind === "description" ? CAL_DESCRIPTION_MAX : CAL_TITLE_MAX)) return false;
  return !BREAKS_ONE_RE.test(s) && !INVISIBLE_ONE_RE.test(s);
}
/** Non-global copies for `.test` (a global regex's `lastIndex` would make `.test` stateful). */
const BREAKS_ONE_RE = new RegExp(BREAKS_RE.source);
const INVISIBLE_ONE_RE = new RegExp(INVISIBLE_RE.source, "u");

/** An email address as identity matching and the locked prompt use it: a `mailto:` prefix dropped,
 *  control/invisible characters and spaces removed, lower-cased; `undefined` unless it is one plain
 *  `local@domain` with no spaces, brackets, quotes or separators. */
export function cleanEmail(email: string | undefined): string | undefined {
  if (typeof email !== "string") return undefined;
  const e = email.replace(BREAKS_RE, "").replace(INVISIBLE_RE, "").trim().replace(/^mailto:/i, "").toLowerCase();
  return e.length <= EMAIL_MAX && /^[^\s@<>()\[\]",;:\\]+@[^\s@<>()\[\]",;:\\]+$/.test(e) ? e : undefined;
}

/** An EVENT's address: NFKC-folded, then `cleanEmail` (final harden r2). The prompt NFKC-folds every value
 *  (`./prompt.ts` `field`), so a full-width `ｈｔｔｐｓ：／／host／x@y.z` that `cleanEmail` alone admits would reach
 *  the model as a real URL; folded first, its `:` fails the address rule. Config addresses keep plain
 *  `cleanEmail` (`./config.ts` `calendarEmail`), whose rule the desktop's Rust check mirrors. */
const eventEmail = (email: string | undefined): string | undefined =>
  cleanEmail(typeof email === "string" ? email.normalize("NFKC") : email);

const optText = (s: string | undefined, kind: CalTextKind): string | undefined => {
  if (typeof s !== "string") return undefined;
  const c = cleanCalendarText(s, kind);
  return c === "" ? undefined : c;
};

/** Every text field of `ev` cleaned (spec §6), the email addresses normalised. Pure; returns a new event.
 *  An empty optional field after cleaning is dropped; an empty title stays "" (rendered as "(no title)"). */
export function cleanCalEvent(ev: CalEvent): CalEvent {
  const out: CalEvent = {
    ...ev,
    title: cleanCalendarText(ev.title, "title"),
    attendees: (Array.isArray(ev.attendees) ? ev.attendees : []).map((a) => {
      const name = optText(a?.name, "title"), email = eventEmail(a?.email);
      return { ...(name !== undefined ? { name } : {}), ...(email !== undefined ? { email } : {}), ...(a?.status !== undefined ? { status: a.status } : {}) };
    }),
  };
  const location = optText(ev.location, "title");
  if (location !== undefined) out.location = location; else delete out.location;
  const description = optText(ev.description, "description");
  if (description !== undefined) out.description = description; else delete out.description;
  if (ev.organizer !== undefined) {
    const name = optText(ev.organizer.name, "title"), email = eventEmail(ev.organizer.email);
    if (name === undefined && email === undefined) delete out.organizer;
    else out.organizer = { ...(name !== undefined ? { name } : {}), ...(email !== undefined ? { email } : {}) };
  }
  if (ev.time?.kind === "unclear") out.time = { ...ev.time, tzid: cleanCalendarText(ev.time.tzid, "title") };
  return out;
}
