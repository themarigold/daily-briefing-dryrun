// src/calendar/config.ts — the ONE reader of `Config.calendar` (v0.3.0, plan M1; spec r4 §2, §4.2).
//
// The optional-feature style of `resolveVerdictPaths` / `resolveRecapCampaigns` (src/config.ts) and
// `resolveUpdateCheck` (src/updateCheck.ts): pure, NEVER throws, B1-style degradation.
//   • absent (`undefined` / `null`) ⇒ off, with NO warning — unset is the default, not a typo;
//   • malformed ⇒ off, plus exactly ONE warning, chosen from the fixed texts below. All-or-nothing, for the
//     reason `verdictPaths` gives: a partially applied block is invisible state — a link the user believes
//     is connected but was silently dropped is the failure this avoids;
//   • two problems that are NOT malformations and keep the rest of the block: a link carrying a literal
//     `url` (that link is skipped, spec §2), and a `macos` block on a system that is not macOS (ignored).
//
// ⚠ EVERY WARNING IS FIXED TEXT AND NEVER QUOTES A CONFIGURED VALUE (spec §2). Not the id, not the name, not
// an address, not a variable name: a link's URL is a secret, and the likeliest mistakes put it exactly where
// a value would be echoed — pasted into `name`, into `urlEnv`, or into a `url` field. The warnings will reach
// the briefing's `⚠` line and `calendar status --json` (M4/M5); `test/calendar-config.test.ts` drives a
// sentinel URL through every field and asserts it never comes back out.
//
// Called by `runCore` (M4: the step, the lock), by `calendar …` (M5, src/calendar/cli.ts) and by the diagnostics.
import { CALENDAR_MACOS_SOURCE_ID } from "./render-contract";
import { cleanEmail } from "./clean";

/** A link id: the only part of a link used in a file name (`<state>/calendar/links/<id>.url`, spec §2). The
 *  Rust writer (W2) enforces the same grammar. */
export const CALENDAR_LINK_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** At most this many links (spec §2; §3's aggregate limits assume it). */
export const CALENDAR_MAX_LINKS = 10;

/** Ids a link may not take. `macos` is the Mac Calendar source's own id in `CalendarStruct.sources` and in
 *  `calendar … --json` (`CALENDAR_MACOS_SOURCE_ID`), so a link of that name would be ambiguous wherever a
 *  source is named by id. Refused exactly like an id outside the grammar. */
export const CALENDAR_RESERVED_LINK_IDS: readonly string[] = Object.freeze([CALENDAR_MACOS_SOURCE_ID]);

const OFF = " — calendar off";

/** The resolver's warnings, all of them. Every one is a constant; none is ever built from config input. */
export const CALENDAR_CONFIG_WARNINGS = Object.freeze({
  shape: 'config: "calendar" must be an object with only "enabled", "emails", "macos" and "links"' + OFF,
  enabled: 'config: "calendar.enabled" must be true or false' + OFF,
  emails: 'config: "calendar.emails" must be an array of email addresses' + OFF,
  macos: 'config: "calendar.macos" must be { "calendars"?: "editable" | "all" | [{ "id", "title", "account" }] }' + OFF,
  links: 'config: "calendar.links" must be an array of at most 10 links' + OFF,
  linkShape: 'config: each "calendar.links" entry must be an object with only "id", "name", "owner", "confirmedOwner", "urlEnv" and "urlCommand"' + OFF,
  linkId: 'config: a "calendar.links" id must be 1 to 32 lowercase letters, digits or hyphens, start with a letter or digit, and not be "macos"' + OFF,
  linkIdDuplicate: 'config: two "calendar.links" entries have the same id' + OFF,
  linkName: 'config: a "calendar.links" name must be non-empty text on one line, and not a web address' + OFF,
  linkOwner: 'config: a "calendar.links" owner or confirmedOwner must be an email address' + OFF,
  linkUrlEnv: 'config: a "calendar.links" urlEnv must be an environment variable name (letters, digits and underscores)' + OFF,
  linkUrlCommand: 'config: a "calendar.links" urlCommand must be a non-empty array of non-empty strings (the command and its arguments, not one shell string)' + OFF,
  linkUrlBoth: 'config: a "calendar.links" entry may set urlEnv or urlCommand, not both' + OFF,
  /** Final harden r3: its own text — a web address pasted into a urlCommand argument is not a shape mistake. */
  linkUrlCommandAddress: 'config: a "calendar.links" urlCommand argument holds a web address — a calendar link\'s address is a secret and never belongs in the config file; use a command that prints it' + OFF,
  /** Not a malformation: that link is skipped, the rest of the block stands. Emitted once however many
   *  links carry the field. */
  literalUrl: 'config: a "calendar.links" entry has a "url" field — a calendar link\'s address is a secret and is never read from the config file, so that link is skipped; delete the field and keep the address in the link\'s own file, an environment variable (urlEnv) or a command (urlCommand)',
  /** Not a malformation: the Mac source is ignored, the rest of the block stands. */
  macosNotHere: 'config: "calendar.macos" applies only on macOS and is ignored on this system',
} as const);

export type CalendarConfigWarning = (typeof CALENDAR_CONFIG_WARNINGS)[keyof typeof CALENDAR_CONFIG_WARNINGS];

/** One Mac calendar chosen explicitly (spec §2). Only `id` selects; `title` and `account` keep the config
 *  readable and are what Settings shows. */
export type CalendarMacosChoice = { id: string; title: string; account: string };

/** Which Mac calendars are read: `"editable"` (the default — calendars you can edit, Birthdays excluded),
 *  `"all"`, or an explicit list. */
export type CalendarMacosSelection = "editable" | "all" | CalendarMacosChoice[];

/** Where a link's URL comes from — the rung of the credential ladder (spec §2; `src/calendar/link-url.ts`).
 *  Exactly one per link, decided by the config alone: `urlCommand` ⇒ command, `urlEnv` ⇒ env, neither ⇒
 *  the managed file. ONLY the configured source is tried (the `src/apiKey.ts` rule): a link that names an
 *  environment variable never silently falls back to an old managed file. */
export type CalendarLinkSource =
  | { urlFrom: "file" }
  | { urlFrom: "env"; urlEnv: string }
  | { urlFrom: "command"; urlCommand: string[] };

export type ResolvedCalendarLink = {
  id: string;
  /** Free-text display label, trimmed. */
  name?: string;
  /** The configured address this link belongs to, lower-cased. Recognises your accept or decline only —
   *  never makes you the organizer (spec §4.2). */
  owner?: string;
  /** The address taken from the link's URL path that the user confirmed is theirs at setup (spec §4.2:
   *  "until confirmed, that address only recognises accepts and declines"), lower-cased. The confirmation
   *  holds only while the URL path still carries THIS address, so replacing the link with one to someone
   *  else's calendar cannot inherit it. Read by the parser (M2c); written by setup (M5's `add-link`, W2). */
  confirmedOwner?: string;
} & CalendarLinkSource;

export type ResolvedCalendar = {
  /** `calendar.enabled === true`. False when the block is absent or malformed. */
  enabled: boolean;
  /** Extra addresses that are "you" (spec §2), lower-cased and de-duplicated. */
  emails: string[];
  /** The Mac source's selection; absent when the block has no `macos`, or on a system that is not macOS. */
  macos?: { calendars: CalendarMacosSelection };
  /** In config order, minus any link skipped for a literal `url`. */
  links: ResolvedCalendarLink[];
  /** Fixed texts from `CALENDAR_CONFIG_WARNINGS`; empty when the block is absent or clean. */
  warnings: CalendarConfigWarning[];
};

export type ResolveCalendarOpts = {
  /** Injected so the not-macOS rule is testable on any machine. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
};

/** A malformation, carrying the one warning it resolves to. Internal control flow only: never escapes
 *  `resolveCalendar`. */
class Malformed {
  constructor(readonly warning: CalendarConfigWarning) {}
}

const W = CALENDAR_CONFIG_WARNINGS;

/** `calendar` off, with the given warning (or none). A fresh object per call: callers may push into it. */
function off(warning?: CalendarConfigWarning): ResolvedCalendar {
  return { enabled: false, emails: [], links: [], warnings: warning ? [warning] : [] };
}

/** An OWN data property's value, or `undefined` when absent or `null` — every optional key in the block
 *  treats `null` as unset, as `author` and `subprojects` do in src/config.ts, so a writer that serialises
 *  "none" as `null` does not switch the calendar off. An accessor is read by descriptor and never invoked
 *  (the `resolveRecapCampaigns` rule); it is a bad shape. */
function own(obj: object, key: string, bad: CalendarConfigWarning): unknown {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (d === undefined) return undefined;
  if (!("value" in d)) throw new Malformed(bad);
  return d.value ?? undefined;
}

/** Throws unless `v` is a plain (non-array) object carrying no key outside `allowed`. A typo'd sibling
 *  (`"enable"`, `"urlenv"`) is refused rather than ignored: ignored, `"urlenv"` would quietly send the link
 *  to the managed file instead of the variable the user named. */
function objectWithOnly(v: unknown, allowed: readonly string[], bad: CalendarConfigWarning): object {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Malformed(bad);
  for (const k of Reflect.ownKeys(v)) if (typeof k !== "string" || !allowed.includes(k)) throw new Malformed(bad);
  return v;
}

/** The elements of an array, by own index. `Array.from` would invoke an accessor element; this refuses it. */
function elements(v: unknown[], bad: CalendarConfigWarning): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < v.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, i);
    if (d !== undefined && !("value" in d)) throw new Malformed(bad);
    out.push(d?.value);
  }
  return out;
}

/** C0 and C1 controls plus the two Unicode line breaks — anything that could start a line of its own. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A deliberately plain address check: one `@`, a non-empty local part, a dotted domain, and none of the
 *  characters that would make it a URL, a path, or a display-name form. Not RFC 5322 — the addresses it
 *  guards are compared against iCalendar `mailto:` values and EventKit emails, never sent anywhere. */
const EMAIL_RE = /^[^\s@/\\:<>()[\],;"']+@[^\s@/\\:<>()[\],;"']+\.[^\s@/\\:<>()[\],;"'.]+$/;

/** The address, trimmed and lower-cased, or `undefined` when it is not one. Exported for `./link-parse.ts`, which reads
 *  a Google URL-path owner with the same check as a configured one. */
export function calendarEmail(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  // ⚠ AGREES WITH `cleanEmail` (src/calendar/clean.ts) — M2c review LOW. An address carrying a character that
  // `cleanEmail` strips (a zero-width space, a soft hyphen, a bidi mark …) passed here, then failed the parse
  // child's request check (`cleanEmail(e) === e`), so that link came back `bad-request` on every run. Refused here
  // instead, with the field's existing fixed warning, so the user is told at config time.
  return s.length <= 254 && !CONTROL_RE.test(s) && EMAIL_RE.test(s) && cleanEmail(s) === s ? s : undefined;
}

/** POSIX-portable environment variable names. Also what stops a URL pasted into `urlEnv` from being
 *  accepted as a "name" that a later message would print. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function parseEmails(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Malformed(W.emails);
  const out: string[] = [];
  for (const e of elements(v, W.emails)) {
    const addr = calendarEmail(e);
    if (addr === undefined) throw new Malformed(W.emails);
    out.push(addr);
  }
  return [...new Set(out)];
}

function parseMacos(v: unknown): { calendars: CalendarMacosSelection } | undefined {
  if (v === undefined) return undefined;
  const m = objectWithOnly(v, ["calendars"], W.macos);
  const c = own(m, "calendars", W.macos);
  if (c === undefined || c === "editable" || c === "all") return { calendars: c ?? "editable" };
  if (!Array.isArray(c)) throw new Malformed(W.macos);
  const chosen: CalendarMacosChoice[] = [];
  for (const e of elements(c, W.macos)) {
    const o = objectWithOnly(e, ["id", "title", "account"], W.macos);
    const id = own(o, "id", W.macos), title = own(o, "title", W.macos), account = own(o, "account", W.macos);
    if (typeof id !== "string" || id.trim() === "" || typeof title !== "string" || typeof account !== "string") {
      throw new Malformed(W.macos);
    }
    chosen.push({ id, title, account });
  }
  return { calendars: chosen };
}

const LINK_KEYS = ["id", "name", "owner", "confirmedOwner", "urlEnv", "urlCommand", "url"] as const;

/** One entry, or `"skip"` when it carries a literal `url`. The `url` check comes FIRST, before any other
 *  field is judged: an entry holding a secret in the config file is reported as exactly that, whatever else
 *  is wrong with it. */
function parseLink(e: unknown): ResolvedCalendarLink | "skip" {
  if (typeof e !== "object" || e === null || Array.isArray(e)) throw new Malformed(W.linkShape);
  if (own(e, "url", W.linkShape) !== undefined) return "skip";
  const o = objectWithOnly(e, LINK_KEYS, W.linkShape);

  const id = own(o, "id", W.linkId);
  if (typeof id !== "string" || !CALENDAR_LINK_ID_RE.test(id) || CALENDAR_RESERVED_LINK_IDS.includes(id)) {
    throw new Malformed(W.linkId);
  }

  const rawName = own(o, "name", W.linkName);
  let name: string | undefined;
  if (rawName !== undefined) {
    // A scheme separator refused (any spelling, `calendarTextHasScheme`): the URL pasted into the label field is the one mistake that would put the secret into
    // `calendar list --json`, which prints `name`.
    if (typeof rawName !== "string" || rawName.trim() === "" || CONTROL_RE.test(rawName) || calendarTextHasScheme(rawName)) {
      throw new Malformed(W.linkName);
    }
    name = rawName.trim();
  }

  const addr = (key: "owner" | "confirmedOwner"): string | undefined => {
    const v = own(o, key, W.linkOwner);
    if (v === undefined) return undefined;
    const a = calendarEmail(v);
    if (a === undefined) throw new Malformed(W.linkOwner);
    return a;
  };
  const owner = addr("owner");
  const confirmedOwner = addr("confirmedOwner");

  const urlEnv = own(o, "urlEnv", W.linkUrlEnv);
  if (urlEnv !== undefined && (typeof urlEnv !== "string" || !ENV_NAME_RE.test(urlEnv))) throw new Malformed(W.linkUrlEnv);

  const rawCmd = own(o, "urlCommand", W.linkUrlCommand);
  let urlCommand: string[] | undefined;
  if (rawCmd !== undefined) {
    if (!Array.isArray(rawCmd) || rawCmd.length === 0) throw new Malformed(W.linkUrlCommand);
    const argv = elements(rawCmd, W.linkUrlCommand);
    if (argv.some((a) => typeof a !== "string" || a === "")) throw new Malformed(W.linkUrlCommand);
    // Final harden r2: a URL-shaped argument is the link's address pasted into the command (`["echo",
    // "https://…/basic.ics"]`) — a secret in config.json. Malformed; final harden r3: with its OWN fixed warning.
    if (argv.some((a) => calendarArgIsUrlShaped(a as string))) throw new Malformed(W.linkUrlCommandAddress);
    urlCommand = argv as string[];
  }
  if (urlEnv !== undefined && urlCommand !== undefined) throw new Malformed(W.linkUrlBoth);

  const source: CalendarLinkSource = urlCommand !== undefined ? { urlFrom: "command", urlCommand }
    : urlEnv !== undefined ? { urlFrom: "env", urlEnv: urlEnv as string }
    : { urlFrom: "file" };
  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(confirmedOwner !== undefined ? { confirmedOwner } : {}),
    ...source,
  };
}

function parseLinks(v: unknown): { links: ResolvedCalendarLink[]; skippedUrl: boolean } {
  if (v === undefined) return { links: [], skippedUrl: false };
  // The cap counts every entry, skipped ones included: it bounds what the user wrote, not what survived.
  if (!Array.isArray(v) || v.length > CALENDAR_MAX_LINKS) throw new Malformed(W.links);
  const links: ResolvedCalendarLink[] = [];
  let skippedUrl = false;
  for (const e of elements(v, W.linkShape)) {
    const link = parseLink(e);
    if (link === "skip") { skippedUrl = true; continue; }
    if (links.some((l) => l.id === link.id)) throw new Malformed(W.linkIdDuplicate);
    links.push(link);
  }
  return { links, skippedUrl };
}

/** The `config validate` ERROR for a literal `url` in the calendar block, a URL-shaped `urlCommand` argument
 *  (final harden r2), or a web address in a link name, owner or email (r3) — fixed text; never quotes the value. The desktop's generic save returns the SAME text when it
 *  refuses such a candidate before staging it (`gui/src-tauri/src/config_save.rs`, `CALENDAR_SECRET_ERROR`;
 *  `gui/tests-web/calendar.check.ts` pins the two equal). */
export const CALENDAR_LITERAL_URL_ERROR = 'config error: the "calendar" block holds a link address (a "url" field, or a web address in a urlCommand argument, a link name, an owner or an email) — a calendar link\'s address is a secret and is never stored in the config file; delete it and add the link with `daily-briefing calendar add-link` (or give it a urlEnv, or a urlCommand that prints the address)';

/** Does the calendar block hold a literal `url` key — ANY case (`URL`, `Url`), at ANY depth — or a URL-shaped
 *  `urlCommand` argument (`calendarArgIsUrlShaped`, final harden r2)? `config validate` makes either an ERROR
 *  (fix-round 1): `resolveCalendar` only skips (or switches off) the link, but a candidate that validated would be
 *  written by the desktop's generic config save, secret and all. Pure; never throws (a hostile value reads as
 *  "yes", the safe answer). ITERATIVE, with NO depth limit (final harden r2): the recursive walk stopped at depth
 *  16 and answered "no" below it — failing OPEN on a `url` nested 17 deep. Cycles are visited once. */
export function calendarBlockHasLiteralUrl(raw: unknown): boolean {
  try {
    const seen = new Set<object>();
    const stack: unknown[] = [raw];
    while (stack.length > 0) {
      const v = stack.pop();
      if (typeof v !== "object" || v === null || seen.has(v)) continue;
      seen.add(v);
      if (Array.isArray(v)) { for (const x of v) stack.push(x); continue; }
      for (const k of Object.keys(v)) {
        const child = (v as Record<string, unknown>)[k];
        const key = k.toLowerCase();
        if (key === "url") return true;
        if (key === "urlcommand") {
          const args = Array.isArray(child) ? child : [child];
          if (args.some((a) => typeof a === "string" && calendarArgIsUrlShaped(a))) return true;
        }
        // Final harden r3: a web address in a link's name, owner or confirmedOwner, or in an `emails` entry — the
        // fields that are not meant to hold one — is the same secret in the wrong field. The desktop refused it only
        // AFTER staging the candidate file; now its generic save refuses it before, and so does this ERROR.
        if (TEXT_FIELD_KEYS.includes(key)) {
          const texts = key === "emails" && Array.isArray(child) ? child : [child];
          if (texts.some((t) => typeof t === "string" && calendarTextHasScheme(t))) return true;
        }
        stack.push(child);
      }
    }
    return false;
  } catch { return true; }
}

/** A scheme separator in any spelling: `:` then two of `/` and `\` in any mix — plain `://`, the JSON-escaped
 *  `:\/\/` (whose `:\/` matches), and the backslash forms a WHATWG parser reads as `//` for the special schemes
 *  (`https:\\host\path`, final harden r3) — or the percent-encoded `%3a` with two of `%2f` / `%5c`. Every match
 *  starts at its `:`/`%3a`, so matches never overlap and the desktop's hand count (`scheme_separators`) agrees. */
const SCHEME_SEP_RE = /:[\/\\]{2}|%3a(?:%2f|%5c){2}/gi;
/** A token naming an `.ics` file. */
const ICS_RE = /\.ics(?![a-z0-9])/i;
/** A dotted host followed by a path separator (`/` or `\`, or — post-convergence LOW — the percent-encoded `%2f` /
 *  `%5c`, any case: `host.example%2Fcalendar%2Fbasic.ics`), with an optional port — starting only where its run
 *  starts, the last label 2 to 63 letters (`calendar.example.com/…`). */
const DOTTED_HOST_PATH_RE = /(?<![a-z0-9.\-])(?:[a-z0-9\-]+\.)+[a-z]{2,63}(?::\d{1,5})?(?:[\/\\]|%2f|%5c)/i;
/** The block's text fields that are never meant to hold a web address (`calendarBlockHasLiteralUrl`). */
const TEXT_FIELD_KEYS: readonly string[] = ["name", "owner", "confirmedowner", "emails"];

/** Does `text` carry a scheme separator in any spelling (`SCHEME_SEP_RE`)? */
export function calendarTextHasScheme(text: string): boolean {
  return (text.match(SCHEME_SEP_RE)?.length ?? 0) > 0;
}
/** A 1Password secret reference (`op://vault/item/field`) is a POINTER to the address, not the address: the
 *  documented way to keep it out of config.json (docs/PROVIDERS.md), pinned as accepted by the shared fixture. */
const OP_REFERENCE_RE = /^op:\/\//i;

/** Is one `urlCommand` argument URL-shaped (final harden r2, narrowed r3) — a scheme separator (`SCHEME_SEP_RE`,
 *  any spelling, ANY scheme) other than one leading `op://` secret reference, or an `.ics` file name AFTER A DOTTED
 *  HOST (`calendar.example.com/…/basic.ics`)? A bare `.ics` path is not an address: `["pass", "show",
 *  "calendar/work.ics"]` names a password-store ENTRY, and switching the calendar off for it was wrong. Nor is a
 *  host path alone (`pass` and browserpass name entries `example.com/user` — where the address is meant to live).
 *  ASCII case-insensitive and hand-checkable, because the desktop's Rust `check_calendar_block` mirrors it
 *  (`url_shaped_arg`); the shared `calendar_block_cases.json` pins both. */
export function calendarArgIsUrlShaped(arg: string): boolean {
  const separators = arg.match(SCHEME_SEP_RE)?.length ?? 0;
  return separators > (OP_REFERENCE_RE.test(arg) ? 1 : 0) || (ICS_RE.test(arg) && DOTTED_HOST_PATH_RE.test(arg));
}

/** `Config.calendar` → the resolved calendar configuration. Pure; never throws. See the header. */
export function resolveCalendar(raw: unknown, opts: ResolveCalendarOpts = {}): ResolvedCalendar {
  if (raw === undefined || raw === null) return off();
  try {
    const block = objectWithOnly(raw, ["enabled", "emails", "macos", "links"], W.shape);
    const enabled = own(block, "enabled", W.enabled);
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Malformed(W.enabled);
    const emails = parseEmails(own(block, "emails", W.emails));
    // Validated on every system, so a block is malformed or not regardless of where it is read.
    let macos = parseMacos(own(block, "macos", W.macos));
    const { links, skippedUrl } = parseLinks(own(block, "links", W.links));

    const warnings: CalendarConfigWarning[] = [];
    if (skippedUrl) warnings.push(W.literalUrl);
    if (macos !== undefined && (opts.platform ?? process.platform) !== "darwin") {
      warnings.push(W.macosNotHere);
      macos = undefined;
    }
    return { enabled: enabled === true, emails, ...(macos !== undefined ? { macos } : {}), links, warnings };
  } catch (e) {
    // Anything else that throws while being inspected (a hostile Proxy — `runCore` takes a `Config` from any
    // caller, not only JSON) degrades the same way, so the briefing never pays for a malformed block.
    return off(e instanceof Malformed ? e.warning : W.shape);
  }
}
