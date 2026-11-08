// src/failover.ts — the walk's failure classifier and its reason table (provider-fallback plan P1-M3-T2; spec r9
// §5 step 5).
//
// PURE: `failoverReason(err, kind)` reads only `code`, `httpStatus`, `retryAfterMs` and `failCause` — the
// structured fields the transports set at their boundary (P1-M3-T1) — never the message, which is provider text.
// The table is frozen and its wordings never interpolate provider text: the two placeholders, `{until}` and
// `{status}`, are filled from structured fields by `reasonWording`.
import type { Attempt, FailCause, ProviderError } from "./types";
import { redactCredentials } from "./transcripts/credentials";
import { HOST_PATH_LINK_RE, ICS_LINK_RE, ONE_SEPARATOR_LINK_RE, SCHEME_LINK_RE } from "./calendar/link-scrub";

/** The entry kind the classifier needs: a spawned CLI, or one of the two HTTP transports. */
export type EntryKind = "cli" | "anthropic" | "openai-compatible";

export type FailoverReason =
  | "usage" | "rate-limited" | "auth" | "key-unavailable" | "not-installed" | "not-found" | "prompt-too-long"
  | "rejected-request" | "unreachable" | "empty-answer" | "unusable-answer" | "cli-failure" | "insecure-endpoint";

/** Which mark a failure writes (spec r9 §5): `usage` — today's reset, or 1 h, item 1 included;
 *  `hour-non-first` — 1 h, never on the current item 1; `hour-non-first-claude-login` — the same, for Claude
 *  CLI logins only; `none` — no mark. */
export type MarkClass = "usage" | "hour-non-first" | "hour-non-first-claude-login" | "none";

export type ReasonRow = { readonly wording: string; readonly mark: MarkClass; readonly retryable: boolean };

const row = (wording: string, mark: MarkClass, retryable = false): ReasonRow => Object.freeze({ wording, mark, retryable });

/** THE reason table. `retryable` is the reason's default; `unreachable` is retryable except after a timeout
 *  (`isRetryableFailure`), because a timeout already spent the whole attempt budget. */
export const FAILOVER_REASONS: Readonly<Record<FailoverReason, ReasonRow>> = Object.freeze({
  "usage": row("out of usage until {until}", "usage"),
  "rate-limited": row("rate-limited", "none", true),
  "auth": row("key or login rejected", "hour-non-first"),
  "key-unavailable": row("key couldn't be read — if the Keychain was locked, unlock it or cancel the dialog it left", "hour-non-first"),
  "not-installed": row("CLI not installed", "hour-non-first"),
  "not-found": row("model or endpoint not found", "hour-non-first"),
  "prompt-too-long": row("prompt too long for this model", "none"),
  "rejected-request": row("request rejected (HTTP {status})", "none"),
  "unreachable": row("unreachable", "none", true),
  "empty-answer": row("empty answer", "none", true),
  "unusable-answer": row("answer wasn't a usable briefing", "hour-non-first"),
  "cli-failure": row("unrecognised CLI failure", "hour-non-first-claude-login", true),
  "insecure-endpoint": row("refused to send the key over plain http — use https", "none"),
});

type Classified = Pick<ProviderError, "code" | "httpStatus" | "retryAfterMs" | "failCause">;

/**
 * The reason for one entry's `ProviderError`. Never `unusable-answer`: that one is the walk's own, for a
 * returned answer with no briefing section (`hasBriefingSection`). Order matters: the tags first (each is
 * set exactly where its cause is known), then the usage wall, then the HTTP status, then the code.
 */
export function failoverReason(err: Classified, kind: EntryKind): FailoverReason {
  switch (err.failCause) {
    case "insecure-endpoint": return "insecure-endpoint";
    case "key-missing": return "key-unavailable";
    case "enoent": return "not-installed";
    case "prompt-too-long": return "prompt-too-long";
    case "redirect-refused": return "rejected-request";
  }
  if (err.code === "usage-limit") return "usage";
  if (err.code === "timeout") return "unreachable";
  if (err.code === "empty-output") return "empty-answer";
  const s = err.httpStatus;
  if (s !== undefined) {
    if (s === 401 || s === 403) return "auth";
    if (s === 404) return "not-found";
    if (s === 429) return "rate-limited";
    // Every other 4xx — 408 and 409 included — is `rejected-request` (spec r9 §5 step 5). This drives only the WALK:
    // `withRetry` keeps its own rule and still retries a 408/409 (`mapStatus` → nonzero-exit), so a single-entry
    // config behaves exactly as before (codex review MED, reversing the earlier parity call).
    if (s >= 400 && s < 500) return "rejected-request";
    return "unreachable";   // 5xx and a non-JSON 200
  }
  if (kind === "cli") return "cli-failure";
  // An HTTP transport's error with no status: a refused connection, DNS or TLS (`nonzero-exit`), or a
  // permanent refusal raised before any request (`missing-binary` without a tag).
  return err.code === "missing-binary" ? "rejected-request" : "unreachable";
}

/** May the walk retry this entry (spec r9 §5 `withEntryRetry`)? The reason's flag, except that a timeout is
 *  never retried. */
export function isRetryableFailure(err: Classified, kind: EntryKind): boolean {
  const reason = failoverReason(err, kind);
  if (reason === "unreachable" && err.code === "timeout") return false;
  return FAILOVER_REASONS[reason].retryable;
}

/** A reason's wording, with `{until}` and `{status}` filled from structured fields only. A `rejected-request`
 *  with no status drops its "(HTTP …)", and a refused redirect says so. */
export function reasonWording(reason: FailoverReason, f: { until?: string; httpStatus?: number; failCause?: FailCause } = {}): string {
  if (reason === "rejected-request" && f.failCause === "redirect-refused") return "redirect refused";
  const w = FAILOVER_REASONS[reason].wording;
  return (f.httpStatus === undefined ? w.replace(" (HTTP {status})", "") : w.replace("{status}", String(f.httpStatus)))
    .replace("{until}", f.until ?? "its reset");
}

// ── The walk's reporting wording (provider fallback P1-M7-T2; spec r9 §5 "Reporting", step 7) ──────────────────────
// PURE, and built only from structured fields (`Attempt`) and config labels — never from provider text — so a
// carried calendar block or an echoed key can never reach a notice, the aggregate message or the skip detail.

/** The fixed prefix of every notice line, so the app's `classifyLine` can recognise one (U+2139 U+FE0E, a space). */
export const NOTICE_PREFIX = "ℹ︎ ";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** A reset or mark end for a reader, in LOCAL time: `HH:MM` when it falls on `now`'s local date, `Ddd HH:MM` on any
 *  other day (spec r9 §5: "09:00" today, "Tue 09:00" on a later day) — and `Ddd D Mon HH:MM` (`Mon 19 Oct 09:00`) when
 *  it is six or more calendar days away (PR 1 final review round 3, L9): marks run to 8 days, so a weekday alone would
 *  read as this week's — 7 days out is today's weekday. The one formatter: the notices, the aggregate failure, the
 *  paused line (P1-M7-T3) and the out-of-usage detail (P1-M9-T2) all use it. An unreadable instant reads "its reset",
 *  the table's own fallback. */
export function formatResetTime(instant: string | Date, now: Date): string {
  const t = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(t.getTime())) return "its reset";
  const hm = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  // Calendar days between the two LOCAL dates (rounded: a DST day is 23 or 25 hours long).
  const days = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
    - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400e3);
  if (days === 0) return hm;
  return Math.abs(days) >= 6 ? `${WEEKDAYS[t.getDay()]} ${t.getDate()} ${MONTHS[t.getMonth()]} ${hm}` : `${WEEKDAYS[t.getDay()]} ${hm}`;
}

/** A dropped entry's reason, for the "invalid entry — …, fix it in Settings" line (spec r9 §4's drop reasons). */
export const DROP_WORDING: Readonly<Record<string, string>> = Object.freeze({
  "bad-shape": "not a valid provider entry",
  "duplicate-label": "its label is already used by an earlier entry",
  "config-dir": "a login folder applies to a Claude CLI entry only",
  "duplicate-login": "the same Claude login as an earlier entry",
});

/** A tried entry's reason in words, its `{until}` filled with the formatted reset. */
function failedWording(a: Attempt, now: Date): string {
  const reason = (a.reason ?? "cli-failure") as FailoverReason;
  if (!(reason in FAILOVER_REASONS)) return "failed";
  return reasonWording(reason, {
    ...(a.until !== undefined ? { until: formatResetTime(a.until, now) } : {}),
    ...(a.httpStatus !== undefined ? { httpStatus: a.httpStatus } : {}),
  });
}

/** The "Not tried" line body for a mark-skipped or dropped entry; undefined for any other outcome. */
function notTriedLine(a: Attempt, now: Date): string | undefined {
  const until = formatResetTime(a.until ?? "", now);
  if (a.outcome === "skipped-by-mark") {
    if (a.reason === "usage") return `Not tried "${safeLabel(a.label)}": out of usage until ${until}`;
    const after = a.reason === undefined || a.reason === "earlier-failure" || !(a.reason in FAILOVER_REASONS)
      ? "earlier failures" : FAILOVER_REASONS[a.reason as FailoverReason].wording;
    return `Not tried "${safeLabel(a.label)}": paused until ${until} after ${after}`;
  }
  if (a.outcome === "dropped") {
    return `Not tried "${safeLabel(a.label)}": invalid entry — ${DROP_WORDING[a.reason ?? ""] ?? "not a valid provider entry"}, fix it in Settings`;
  }
  return undefined;
}

/** The lines above a delivered briefing's title (spec r9 §5 "Line wording"), for a combined list of two or more: one
 *  per failed entry, one per mark-skipped or dropped entry, in list order, then the cost line when there is one. An
 *  entry not reached says nothing, and neither does the winner itself (row 2's unusable last entry is `failed`). */
export function noticeLines(attempts: readonly Attempt[], winner: string, now: Date, cost?: string): string[] {
  const out: string[] = [];
  for (const a of attempts) {
    if (a.outcome === "won" || (a.label === winner && a.outcome !== "dropped")) continue;   // the winner's row only (L2)
    if (a.outcome === "failed") out.push(`${NOTICE_PREFIX}Skipped "${safeLabel(a.label)}": ${failedWording(a, now)} — used "${safeLabel(winner)}"`);
    else {
      const line = notTriedLine(a, now);
      if (line !== undefined) out.push(NOTICE_PREFIX + line);
    }
  }
  if (cost !== undefined) out.push(NOTICE_PREFIX + cost);
  return out;
}

/** One line per tried, mark-skipped and dropped entry, in list order — the body of the aggregate failure and of the
 *  unusable-answer detail. `except` leaves out one label (the last entry, named by its own first line). */
function entryLines(attempts: readonly Attempt[], now: Date, except?: string): string[] {
  const lines: string[] = [];
  for (const a of attempts) {
    if (a.label === except && a.outcome !== "dropped") continue;   // the named row only, never a dropped twin (L2)
    if (a.outcome === "failed") lines.push(`Failed "${safeLabel(a.label)}": ${failedWording(a, now)}`);
    else {
      const line = notTriedLine(a, now);
      if (line !== undefined) lines.push(line);
    }
  }
  return lines;
}

/** The aggregate failure's message (spec r9 §5 step 7 row 3): the count line first — the FAILED notification shows
 *  only the first line, capped at 180 characters, so it names no label — N counting TRIED entries only; then one line
 *  per tried, mark-skipped and dropped entry, in list order. */
export function aggregateFailureMessage(attempts: readonly Attempt[], now: Date): string {
  const failed = attempts.filter((a) => a.outcome === "failed");
  return [`${failed.length} provider${failed.length === 1 ? "" : "s"} failed — open Settings → Providers`, ...entryLines(attempts, now)].join("\n");
}

/** Step 7 row 2's skip detail (the last entry returned an answer with no briefing section): an engine-worded first line
 *  naming that entry — the FAILED notification's body — then the earlier entries' lines (P1-M7 checkpoint MED 3). */
export function unusableAnswerMessage(attempts: readonly Attempt[], last: string, now: Date): string {
  return [`"${noticeLabel(last)}" returned no usable briefing — open Settings → Providers`, ...entryLines(attempts, now, last)].join("\n");
}

/** The longest label the row-2 first line carries, so that line stays within the FAILED notification's 180 characters
 *  (P1-M8 checkpoint LOW 8): 180 minus the fixed text around it, counted in code points. */
export const NOTICE_LABEL_MAX = 180 - Array.from('"" returned no usable briefing — open Settings → Providers').length;

/** A config label as every notice, failure detail, entry line and report row carries it (P1-M9 checkpoint MED 2,
 *  MED 3, LOW 5; P1-M10 checkpoint MED 1; hub Q25, "Q25 extended" — PR 1 final review round 2, M1, M3). Masked WHOLE
 *  (`MASKED_LABEL`) when it holds:
 *    • ANY control or format character (`\p{Cc}`, `\p{Cf}`: tabs, BEL, zero-width spaces, soft hyphens, bidi
 *      overrides). No legitimate label holds one, `config validate` already warns, and every partial treatment of one
 *      (removing it, replacing it) was shown to hide or rejoin a key. ⚠ An emoji ZWJ sequence (`👨‍💻`) is therefore
 *      masked too — accepted;
 *    • a credential shape (`redactCredentials` changes it), also once its invisible splitters are removed
 *      (`hasSplitCredential`: a key split by a combining mark, a non-ASCII space or an ignorable character, round 3 L3;
 *      a plain ASCII space is a word boundary, round 4 M2);
 *    • a link (`labelHasLink`).
 *  Otherwise the label as written. */
export function safeLabel(label: string): string {
  if (FORMAT_OR_CONTROL.test(label)) return MASKED_LABEL;
  if (redactCredentials(label) !== label || labelHasLink(label) || hasSplitCredential(label)) return MASKED_LABEL;
  return label;
}

/** Characters that can split a key without changing how it reads (PR 1 final review round 3, L3): marks (`U+0301`,
 *  VS16), every NON-ASCII space separator (NBSP, `U+3000`), lone surrogates and default-ignorable code points (`U+3164`,
 *  the Hangul filler, which is a letter by category). ⚠ A plain ASCII space is a WORD BOUNDARY and is never rejoined
 *  (round 4 M2): rejoining it masked ordinary labels (`ASIA PACIFIC ACCOUNT 01` reads as an AWS key id), so a key
 *  split by plain spaces is a stated residual. */
const SPLITTER_RUN = /(?:[\p{M}\p{Cs}\p{Default_Ignorable_Code_Point}]|(?! )\p{Z})+/u;
/** Past this many pieces a split label is no name: masked. */
const SPLIT_WORDS_MAX = 64;
/** Past this many code points a SPLIT label is no name either: masked before any rejoin (PR 1 final review round 5,
 *  L1). The window loop is O(pieces² × length) — measured 2.5 s for a 64 KB label of 64 pieces — so the piece cap
 *  alone does not bound it; with both caps a rejoin is at most 64² windows of at most 1 024 code points. */
const SPLIT_LABEL_MAX = 1024;

/** Does a key appear once the label's invisible splitters are removed (round 3 L3)? `redactCredentials` needs a
 *  boundary on either side of a key, so removing every splitter at once could glue a key to a neighbouring piece. Every
 *  WINDOW of consecutive pieces is rejoined instead (round 4 M2: not only each suffix, so `AKIA1234<NBSP>567890ABCDEF
 *  prod` is seen with its boundary after it). */
function hasSplitCredential(label: string): boolean {
  const words = label.split(SPLITTER_RUN).filter((w) => w !== "");
  if (words.length < 2) return false;            // nothing was split; the whole-label check above already ran
  if (words.length > SPLIT_WORDS_MAX) return true;
  if (label.length > SPLIT_LABEL_MAX && Array.from(label).length > SPLIT_LABEL_MAX) return true;
  for (let i = 0; i < words.length; i++) {
    let window = "";
    for (let j = i; j < words.length; j++) {
      window += words[j];
      if (j > i && redactCredentials(window) !== window) return true;
    }
  }
  return false;
}

/** What `safeLabel` shows for a label that holds (or is) a key, a link or a control/format character. */
export const MASKED_LABEL = "[redacted label]";
/** Control and format characters, and the line and paragraph separators (`U+2028`, `U+2029`; round 3 L3). */
const FORMAT_OR_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Does a LABEL hold a link (M3)? The calendar scrub's first three shapes — any `scheme://` (plain, escaped or
 *  percent-encoded), the http/https/webcal one-separator form, any token naming an `.ics` file — are links outright;
 *  its fourth, a bare `host.tld/path`, is a link only when its path holds a secret-shaped run (16 or more of
 *  `[A-Za-z0-9_%-]`), so a model name like `openrouter.ai/sonnet` or `ollama.local/llama3` stays a label while every
 *  private calendar address (Google `…/private-<hex>/basic.ics`, iCloud `…/published/2/<token>`, Outlook
 *  `…/reachcalendar.ics`) is caught. The patterns are link-scrub.ts's own, unchanged. */
function labelHasLink(label: string): boolean {
  for (const re of OUTRIGHT_LINK_RES) if (re.test(label)) return true;
  for (const m of label.matchAll(HOST_PATH_LINK_RE)) {
    const path = m[0].slice(m[0].search(/[\\/]/) + 1);
    if (/[A-Za-z0-9_%-]{16,}/.test(path)) return true;
  }
  return false;
}

/** The link shapes that are links outright, as NON-global copies built once (a global regex's `test` is stateful). The
 *  host/path shape stays link-scrub's own global constant: `matchAll` clones it, so its `lastIndex` is never shared. */
const OUTRIGHT_LINK_RES: readonly RegExp[] = [SCHEME_LINK_RE, ONE_SEPARATOR_LINK_RE, ICS_LINK_RE].map((re) => new RegExp(re.source, re.flags.replace("g", "")));

/** `safeLabel`, then cut to `NOTICE_LABEL_MAX` code points (never splitting a surrogate pair) with an ellipsis. */
function noticeLabel(label: string): string {
  const clean = Array.from(safeLabel(label));
  return clean.length <= NOTICE_LABEL_MAX ? clean.join("") : `${clean.slice(0, NOTICE_LABEL_MAX - 1).join("")}…`;
}

/** The out-of-usage notification body (spec r9 §5 Reporting, requirement 11; P1-M9-T2): the first line of a step-7
 *  row-1 skip's detail. It names a time ONLY when `until` is set and `isProbe` is false — every involved usage mark has
 *  a parsed reset, and `until` is the earliest — through `formatResetTime`; otherwise it drops the "until <time>". */
export function outOfUsageLine(limited: { until: string; isProbe: boolean }, now: Date): string {
  const when = limited.until && !limited.isProbe ? ` until ${formatResetTime(limited.until, now)}` : "";
  return `No briefing yet today — every provider is out of usage${when}. It will arrive once one resets, if your Mac is awake.`;
}
