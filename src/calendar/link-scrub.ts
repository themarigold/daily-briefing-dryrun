// src/calendar/link-scrub.ts — the calendar-scoped scrub for LINK-SHAPED strings (v0.3.0, plan M2a; spec r4
// §4.2 "Never leaks": "`status --json`'s `configError` text additionally passes a calendar-scoped scrub for
// link-shaped strings").
//
// WHY A SECOND PASS. `configError` is a config load error's own message, and a parse or validation error can
// quote the config's text (`src/json.ts`, the E11 rule). It already passes `redactCredentials`, but those
// shared patterns (`src/transcripts/credentials.ts`) know nothing of calendar links — and they are NOT changed
// for this, because they also feed transcript ingest, where widening them changes what is dropped (spec §4.2).
// A calendar link's URL never belongs in config.json (`resolveCalendar` refuses a literal `url`), but the
// likeliest mistake puts it exactly there, and a JSON syntax error a few characters away would quote it.
//
// WHAT IS LINK-SHAPED, deliberately broad — over-scrubbing an error message costs a few characters of
// diagnosis, under-scrubbing costs the user's calendar:
//   • anything with a scheme and `//` — `https://`, `webcal://`, `http://`, any other — including the
//     JSON-escaped spelling (`https:\/\/`) and the percent-encoded one (`https%3A%2F%2F`) — and, for `http`, `https`
//     and `webcal` only, ONE separator then a host (`https:/host`, `https:\host\path`);
//   • any token naming an `.ics` file, with or without a host (`/private-…/basic.ics`), whole — so a quote
//     that began mid-URL loses all of it WHEN THE QUOTED PART STILL NAMES THE `.ics` FILE. Google's secret
//     address always ends `…/basic.ics`, so a mid-URL quote of it that runs to the end is caught
//     (`ical/me%40example.com/private-…/basic.ics`) — the case this rule was written for, and Google's only;
//   • a dotted host followed by a path with no scheme at all (`calendar.google.com/calendar/ical/…`), from the
//     start of the host's first label on.
// ⚠ THE MID-URL GAP, measured at the M2a checkpoint: a quote that begins AFTER the host and names no `.ics`
// file matches none of the three rules and survives whole — iCloud's `published/2/<token>` (its links carry no
// `.ics` at all), and an Outlook link quoted as `owa/calendar/<guid>/<token>/` or cut before its
// `calendar.ics`. (An Outlook fragment that still holds the mailbox's `@<domain>/` loses everything from the
// domain on, through the host rule; the `<guid>` before it stays.) Closing it would mean scrubbing every long
// token, which would also eat the paths and ids the message exists to report. The input is a config error
// message, and a link reaches config.json only through the mistake `resolveCalendar` already refuses; quoted
// whole, with its scheme or its host, every shape above is caught. `test/calendar-link-scrub.test.ts` pins
// the gap as KNOWN MISS rows, so a change in either direction is seen.
// A token runs to the next whitespace, quote, angle bracket or backtick. The config file's own path — the
// other thing such a message names — is not link-shaped on any supported system (no dotted label is followed
// by `/` in `~/.config/daily-briefing/config.json` or `~/Library/Application Support/daily-briefing/…`), and
// `test/calendar-link-scrub.test.ts` pins that it survives.
//
// WIRED (M5): `status --json`'s `configError` applies it after `redactCredentials`, and every calendar surface that
// prints a link `name` (src/calendar/status.ts `shownLinkName`). Pure; never throws; a
// non-string comes back unchanged (the `redactCredentials` rule).

/** What a link-shaped string becomes. */
export const CALENDAR_LINK_SCRUBBED = "[link removed]";

/** A token's characters: anything but whitespace, quotes, angle brackets and backticks. */
const T = String.raw`[^\s"'<>\x60]`;

// LINEAR in the text, however long the error, because no pattern can rescan one run of characters from every
// position inside it: the scheme is at most 32 characters (RFC 3986 sets no bound; real ones are far shorter),
// and the other two may START only where their run starts (the lookbehinds). Measured, not assumed: the first
// version (an unbounded scheme, a host rule that could start after any `.`) did not finish
// `"a.".repeat(100_000)` in two minutes; `test/calendar-link-scrub.test.ts` times that input and its kin.
// The four link shapes, as NAMED constants (PR 1 final review round 4, L4) — exported, patterns unchanged, for
// `safeLabel`'s label link rule (src/failover.ts). `LINK_PATTERNS` is built from them, in this order.
// scheme://… — plain, JSON-escaped (`\/\/`), or percent-encoded (`%3A%2F%2F`). The lookbehind is letters
// only, so `me%40https://…` still matches from the `h`; the bounded scheme is what keeps it linear.
// Final harden r3: also the backslash forms (`https:\\host`, `%5C`) a WHATWG parser reads as `//`.
export const SCHEME_LINK_RE = new RegExp(String.raw`(?<![a-z])[a-z][a-z0-9+.\-]{0,31}(?::(?:\\?\/|\\){2}|%3a(?:%2f|%5c){2})${T}*`, "gi");
// Post-convergence LOW, `clean.ts`'s SPECIAL_URL_RE mirrored: http/https/webcal with ONE separator (or any run of
// `/` `\` `%2F` `%5C`) then a host — `https:\intranet\<token>`, which a WHATWG parser reads as `https://intranet/…`
// and the host rule below misses (no dot). Linear: a fixed scheme literal; the separator run and host are disjoint.
export const ONE_SEPARATOR_LINK_RE = new RegExp(String.raw`(?<![a-z])(?:https?|webcal)(?::|%3a)(?=(?:[\/\\]|%2f|%5c)+[a-z0-9])${T}*`, "gi");
// any token naming an .ics file, from the token's start — before the host rule, so a
// quote that began mid-URL loses its whole token, not only the part from the host on
export const ICS_LINK_RE = new RegExp(String.raw`(?<!${T})${T}*\.ics(?![a-z0-9])${T}*`, "gi");
// host.tld/path, no scheme — from the start of the dotted run only (a `.` before it is part of the run)
export const HOST_PATH_LINK_RE = new RegExp(String.raw`(?<![a-z0-9.\-])(?:[a-z0-9\-]+\.)+[a-z]{2,63}(?::\d{1,5})?(?:\\?\/|\\)${T}*`, "gi");
const LINK_PATTERNS: readonly RegExp[] = [SCHEME_LINK_RE, ONE_SEPARATOR_LINK_RE, ICS_LINK_RE, HOST_PATH_LINK_RE];

/** `text` with every link-shaped string replaced by CALENDAR_LINK_SCRUBBED. See the header. */
export function scrubCalendarLinks(text: string): string {
  if (typeof text !== "string") return text;
  let out = text;
  for (const re of LINK_PATTERNS) out = out.replace(re, CALENDAR_LINK_SCRUBBED);
  return out;
}
