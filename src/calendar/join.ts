// src/calendar/join.ts — pure Join candidates from RAW details (redesign C, "Join links", decisions of 2026-10-19
// and U5 of 2026-10-23; wave-2 plan C-M2-T4), plus producerKeys/placeKeyText/LINK_KEYS_MAX shared by both producers
// on the morning and details paths. Rust validates again before opening anything (C-M3-T9); this module opens no link.
//
// THE RULES
//   • A KNOWN-HOST candidate is a link on one of four services with that service's join path (`KNOWN`): Zoom
//     (`zoom.us`, `zoomgov.com` and their subdomains, `/j/<digits>`), Google Meet (`meet.google.com/<code>`), Teams
//     (`teams.microsoft.com` and `teams.live.com`, each with `/l/meetup-join/…` or `/meet/…`) and Webex (a `*.webex.com` site's `j.php`,
//     `/meet/…` or `/join/…`). Dial-in, help, options, support and agenda links never match a join path.
//   • The fields are read in order: the event's URL field, then the location, then the notes. The FIRST field holding a
//     known-host candidate wins; that field gives "several" (no Join) only when it holds two DIFFERENT ones, compared
//     by lower-cased host and path, ignoring the query and the fragment. One exception, Teams' own layout: a field
//     holding exactly one `/meet/<id>` link and one `/l/meetup-join/` link, on the same Teams host, is one meeting, joined
//     through `/meet/` (`teamsInvitePair`).
//   • With no known-host candidate in any field, another host asks first ("other"): from the URL field or the
//     location AS WRITTEN (the whole field when it is one URL, else the first https URL in it); from the notes only
//     the five other meeting services (`NOTES_SERVICES`, U5), named in the question ("service"). Any other notes link
//     never becomes Join.
//   • https only; no userinfo and no written port, checked on the RAW string's authority (the WHATWG parser drops a
//     written default port, so `https://zoom.us:443/…` would otherwise pass). The host is the parser's: lower-cased,
//     in its ASCII (punycode) form, so a look-alike Unicode host reads `xn--…`.

import { createHash } from "node:crypto";
import { BARE_URL_RE, INVISIBLE_RE, SCHEME_URL_RE, SPECIAL_URL_RE, stripHtml } from "./clean";

/** The four known services, by product name, as the launchpad's "Join now on {name}" names them. */
export const KNOWN_JOIN_HOSTS = ["Zoom", "Google Meet", "Teams", "Webex"] as const;
export type KnownJoinHost = (typeof KNOWN_JOIN_HOSTS)[number];

/** One known service: which hosts, and which paths on them are join links. */
const KNOWN: readonly { name: KnownJoinHost; host: (h: string) => boolean; path: (p: string) => boolean }[] = [
  { name: "Zoom", host: (h) => isOrUnder(h, "zoom.us") || isOrUnder(h, "zoomgov.com"), path: (p) => /^\/j\/\d+\/?$/.test(p) },
  { name: "Google Meet", host: (h) => h === "meet.google.com", path: (p) => /^\/[a-z]+(?:-[a-z]+)+\/?$/i.test(p) },
  {
    name: "Teams",
    host: (h) => h === "teams.microsoft.com" || h === "teams.live.com",
    path: (p) => p.startsWith("/l/meetup-join/") || p.startsWith("/meet/"),
  },
  {
    name: "Webex",
    host: (h) => h.endsWith(".webex.com") && !["www.webex.com", "help.webex.com", "support.webex.com"].includes(h),
    path: (p) => /^\/[^/]+\/j\.php$/i.test(p) || /^\/(?:meet|join)\/[^/]+\/?$/i.test(p),
  },
];

/** The five other meeting services a notes link may name (U5; the user may add or drop one). Each host and its
 *  subdomains. UNVERIFIED: their join-URL host patterns (source: C spec). */
export const NOTES_SERVICES: readonly { name: string; hosts: readonly string[] }[] = [
  { name: "Whereby", hosts: ["whereby.com"] },
  { name: "Jitsi", hosts: ["meet.jit.si"] },
  { name: "GoTo", hosts: ["meet.goto.com", "global.gotomeeting.com"] },
  { name: "BlueJeans", hosts: ["bluejeans.com"] },
  { name: "Amazon Chime", hosts: ["chime.aws"] },
];

export type JoinCandidate =
  | { kind: "known" | "other"; url: string; host: string }
  | { kind: "service"; url: string; host: string; serviceName: string }
  | { kind: "several" };

/** The raw fields Join reads (`CalRawDetails` without its people). */
export type JoinFields = { url?: string | undefined; location?: string | undefined; notes?: string | undefined };

function isOrUnder(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

/** Every https link in a text, in order: up to whitespace, a quote, an angle bracket or a backtick, with sentence
 *  punctuation after it dropped and an HTML-escaped `&amp;` read as `&`. */
const HTTPS_RE = /https:\/\/[^\s<>"'`]+/gi;
const URL_TRAILING_PUNCTUATION = ".,;:!?)]}";
/** A non-global copy: repeated URL checks must not depend on `lastIndex`. */
const INVISIBLE_URL_RE = new RegExp(INVISIBLE_RE.source, "u");
function httpsLinks(text: string): string[] {
  return [...text.matchAll(HTTPS_RE)].map((m) => {
    const raw = m[0];
    let end = raw.length;
    // Scan only the suffix: an unanchored regex retries a long internal punctuation run at every position.
    while (end > 0 && URL_TRAILING_PUNCTUATION.includes(raw[end - 1]!)) end--;
    return raw.slice(0, end).replace(/&amp;/gi, "&");
  });
}

type Valid = { url: string; host: string; key: string; path: string };

/** A link Join may use, or null: https, no userinfo and no written port on the raw authority, and a host the parser
 *  reads. `key` is the comparison form (host and path, no query or fragment). */
function valid(raw: string): Valid | null {
  // A backslash is read as `/` by the parser for https, so `https://a.example\@zoom.us/…` names a.example while it
  // reads as zoom.us: refused outright (a real meeting link never carries one).
  if (!/^https:\/\//i.test(raw) || raw.includes("\\") || INVISIBLE_URL_RE.test(raw)) return null;
  const rest = raw.slice("https://".length);
  const end = rest.search(/[/?#\\]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  if (authority === "" || authority.includes("@") || authority.includes(":")) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "" || u.hostname === "") return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  return { url: raw, host, path, key: `${host}${path.replace(/\/+$/, "")}` };
}

function knownIn(text: string | undefined): Valid[] {
  if (!text) return [];
  const out: Valid[] = [];
  for (const raw of httpsLinks(text)) {
    const v = valid(raw);
    if (v && KNOWN.some((k) => k.host(v.host) && k.path(v.path)) && !out.some((o) => o.key === v.key)) out.push(v);
  }
  return out;
}

/** A Teams invite names its meeting twice (measured on two real invites, 2026-11-02): "Join:" with a `/meet/<id>`
 *  link, and "System reference" with the same meeting's `/l/meetup-join/<thread>` link. The two ids cannot be matched
 *  (a numeric id and a thread id), so exactly one of each, on the same Teams host, is read as one candidate: the
 *  `/meet/` link, the one the invite labels Join. Any other mix (a second `/meet/` or `/l/meetup-join/` link, another
 *  host or service) is left as it is. The two-hit guard is the one that matters: a third distinct known-host join link, of any service, stays "several";
 *  help, options and other non-join links never reach `hits`. Only the Join side needs an id. */
function teamsInvitePair(hits: Valid[]): Valid[] {
  if (hits.length !== 2 || hits[0]!.host !== hits[1]!.host) return hits;
  const teams = KNOWN.find((k) => k.name === "Teams")!;
  if (!teams.host(hits[0]!.host)) return hits;
  const meet = hits.filter((v) => /^\/meet\/[^/]+/.test(v.path));
  const meetup = hits.filter((v) => v.path.startsWith("/l/meetup-join/"));
  return meet.length === 1 && meetup.length === 1 ? meet : hits;
}

/** A field "as written": the whole field when it is one https URL, else the first https URL found in it. */
function asWritten(text: string | undefined): Valid | null {
  if (!text) return null;
  const whole = text.trim();
  if (/^https:\/\/\S+$/i.test(whole)) return valid(whole);
  const first = httpsLinks(text)[0];
  return first === undefined ? null : valid(first);
}

/** The event's Join candidate (see the header), or null for no Join. */
export function joinCandidate(fields: JoinFields): JoinCandidate | null {
  for (const text of [fields.url, fields.location, fields.notes]) {
    const hits = teamsInvitePair(knownIn(text));
    if (hits.length > 1) return { kind: "several" };
    if (hits.length === 1) return { kind: "known", url: hits[0]!.url, host: hits[0]!.host };
  }
  for (const text of [fields.url, fields.location]) {
    const v = asWritten(text);
    if (v) return { kind: "other", url: v.url, host: v.host };
  }
  if (fields.notes) {
    for (const raw of httpsLinks(fields.notes)) {
      const v = valid(raw);
      const service = v && NOTES_SERVICES.find((s) => s.hosts.some((h) => isOrUnder(v.host, h)));
      if (v && service) return { kind: "service", url: v.url, host: v.host, serviceName: service.name };
    }
  }
  return null;
}

// ── Producer keys and Join across views (calendar near-duplicates, key c; spec 2026-10-31 §3 placeKey, §4, §5) ─────
//
// The two producers (the Mac reader's `macEventFrom` and the link parser's `baseEvent`) call `producerKeys` on each
// event's RAW location and notes, before cleaning. The three keys are engine-internal: they cross the parse pipe and
// reach reconcile, and never the struct, page, prompt, details JSON, Rust, webview or any file (spec §4 "Boundary").

/** The three optional engine-internal producer keys (spec §4): each a lower-case SHA-256 hex digest. */
export type ProducerKeys = { meetingKey?: string; placeKey?: string; linkKeys?: string[] };

/** linkKeys keeps at most this many values, after sorting (spec §4). */
export const LINK_KEYS_MAX = 8;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The meeting identity of one known-host link: `{ id }` (provider + NUL + id, before hashing), `{ id: null }` for a
 *  known-host link that carries no key (Webex j.php without MTID, an empty or malformed Teams id), or null when the
 *  link is not a known-host link at all (spec §4 "Providers"). */
function meetingIdentity(v: Valid): { id: string | null } | null {
  const service = KNOWN.find((k) => k.host(v.host) && k.path(v.path));
  if (!service) return null;
  switch (service.name) {
    case "Zoom": {
      const digits = /^\/j\/(\d+)\/?$/.exec(v.path)![1]!;
      return { id: `${isOrUnder(v.host, "zoomgov.com") ? "zoomgov" : "zoom"}\u0000${digits}` };
    }
    case "Google Meet":
      return { id: `meet\u0000${v.path.replace(/\//g, "").toLowerCase()}` };
    case "Teams": {
      const meetup = v.path.startsWith("/l/meetup-join/");
      const segment = v.path.slice(meetup ? "/l/meetup-join/".length : "/meet/".length).split("/")[0]!;
      if (segment === "") return { id: null };
      if (!meetup) return { id: `teams-meet\u0000${segment}` };
      let thread: string;
      try { thread = decodeURIComponent(segment); } catch { return { id: null }; }
      return thread === "" ? { id: null } : { id: `teams\u0000${thread.toLowerCase()}` };
    }
    case "Webex": {
      if (/^\/[^/]+\/j\.php$/i.test(v.path)) {
        const mtid = new URL(v.url).searchParams.get("MTID");
        return mtid === null || mtid === "" ? { id: null } : { id: `webex\u0000${mtid}` };
      }
      // A personal room: the site plus the lower-cased name, `/meet/<name>` and `/join/<name>` alike.
      const name = /^\/(?:meet|join)\/([^/]+)\/?$/i.exec(v.path)![1]!;
      return { id: `webex-room\u0000${v.host}/${name.toLowerCase()}` };
    }
  }
}

/** The per-candidate meeting key of ONE URL by the provider rules (spec §4, §5 "Per-candidate meeting key"):
 *  undefined when the URL is not a valid known-host link, or is one that carries no key. */
export function candidateMeetingKey(url: string): string | undefined {
  const v = valid(url);
  const ident = v && meetingIdentity(v);
  return ident && ident.id !== null ? sha256(ident.id) : undefined;
}

/** The event's matching meeting key (spec §4 "Fields read"): the raw location, then the raw notes. The first field
 *  holding any known-host link decides, and the later field is never read. No key when that field holds a keyless
 *  known-host link (even beside a keyed one) or two different meeting keys. Every link is classified on its own:
 *  unlike `knownIn`, nothing is collapsed by host and path (`j.php?MTID=1` beside `j.php?MTID=2` is two meetings). */
function fieldsMeetingKey(fields: readonly (string | undefined)[]): string | undefined {
  for (const text of fields) {
    if (typeof text !== "string") continue;
    const ids: (string | null)[] = [];
    for (const raw of httpsLinks(text)) {
      const v = valid(raw);
      const ident = v && meetingIdentity(v);
      if (ident) ids.push(ident.id);
    }
    if (ids.length === 0) continue;
    if (ids.some((id) => id === null) || new Set(ids).size !== 1) return undefined;
    return sha256(ids[0]!);
  }
  return undefined;
}

/** The raw location's link facts (spec §4 "Raw-location link facts"): one key per valid https link, hashing the
 *  lower-cased host, the path without trailing slashes and the query re-serialised with its pairs sorted by name then
 *  value; the fragment ignored. Sorted, deduped, the first `LINK_KEYS_MAX` kept; undefined when there are none. */
function linkKeysOf(location: string | undefined): string[] | undefined {
  if (typeof location !== "string") return undefined;
  const keys = new Set<string>();
  for (const raw of httpsLinks(location)) {
    const v = valid(raw);
    if (!v) continue;
    const pairs = [...new URL(v.url).searchParams].sort(([an, av], [bn, bv]) => (an < bn ? -1 : an > bn ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
    const query = new URLSearchParams(pairs).toString();
    keys.add(sha256(`${v.host}${v.path.replace(/\/+$/, "")}${query === "" ? "" : `?${query}`}`));
  }
  const out = [...keys].sort().slice(0, LINK_KEYS_MAX);
  return out.length === 0 ? undefined : out;
}

/** Whole-token replacements, then the trailing country forms placeKey drops once (spec §3 rule 4). A Map, so a token
 *  named like an `Object.prototype` key ("constructor") is never looked up on the prototype. */
const PLACE_ABBREVIATIONS: ReadonlyMap<string, string> = new Map([
  ["street", "st"], ["avenue", "ave"], ["road", "rd"], ["boulevard", "blvd"], ["drive", "dr"], ["suite", "ste"],
]);
const PLACE_COUNTRIES: readonly (readonly string[])[] = [["united", "states"], ["usa"], ["us"]];
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Every placeKey step but the hash (spec §3 rule 4): NFKC, `stripHtml`, NFKC, invisible characters removed (the
 *  cleaner's prefix without its whitespace pass); every URL form replaced by a space in `replaceUrls` order;
 *  lower-cased; punctuation and symbols to spaces; collapsed and trimmed; whole-token abbreviations; one trailing
 *  country form dropped; collapsed and trimmed again. "" means no placeKey. */
export function placeKeyText(location: string): string {
  if (typeof location !== "string") return "";
  let s = stripHtml(location.normalize("NFKC")).normalize("NFKC").replace(INVISIBLE_RE, "");
  s = s.replace(SCHEME_URL_RE, " ").replace(SPECIAL_URL_RE, " ").replace(BARE_URL_RE, " ");
  s = collapse(s.toLowerCase().replace(/[\p{P}\p{S}]/gu, " "));
  const tokens = s === "" ? [] : s.split(" ").map((t) => PLACE_ABBREVIATIONS.get(t) ?? t);
  for (const country of PLACE_COUNTRIES) {
    if (tokens.length >= country.length && country.every((c, i) => tokens[tokens.length - country.length + i] === c)) {
      tokens.splice(tokens.length - country.length);
      break;
    }
  }
  return collapse(tokens.join(" "));
}

/** An event's three producer keys from its RAW location and notes (spec §4): the one entry point both producers call.
 *  Absent keys are omitted, never empty. */
export function producerKeys(raw: { location?: string | undefined; notes?: string | undefined }): ProducerKeys {
  const out: ProducerKeys = {};
  const meetingKey = fieldsMeetingKey([raw.location, raw.notes]);
  if (meetingKey !== undefined) out.meetingKey = meetingKey;
  const place = typeof raw.location === "string" ? placeKeyText(raw.location) : "";
  if (place !== "") out.placeKey = sha256(place);
  const linkKeys = linkKeysOf(raw.location);
  if (linkKeys !== undefined) out.linkKeys = linkKeys;
  return out;
}

/** The Join candidate across a key-c merge's views (spec §5 "Join"), each view given with its own raw fields and trust
 *  tier, core first and then merge order. Each view's candidate is its own `joinCandidate`; any "several" gives
 *  "several". A known-host candidate overrides another view's "other"/"service" candidate only when its own view's
 *  tier is the same or better; otherwise they disagree. Two known-host candidates agree by per-candidate meeting key
 *  (keyed vs keyless always differ; two keyless compare by host and path); others compare by host and path. When all
 *  remaining candidates agree, the first by (tier, given order) is returned whole; with none, null. */
export function joinAcross(views: readonly { fields: JoinFields; tier: 1 | 2 | 3 }[]): JoinCandidate | null {
  const found: { cand: Exclude<JoinCandidate, { kind: "several" }>; tier: 1 | 2 | 3; at: number }[] = [];
  for (const [at, view] of views.entries()) {
    const cand = joinCandidate(view.fields);
    if (cand === null) continue;
    if (cand.kind === "several") return { kind: "several" };
    found.push({ cand, tier: view.tier, at });
  }
  const known = found.filter((f) => f.cand.kind === "known");
  const remaining = found.filter((f) => f.cand.kind === "known" || !known.some((k) => k.tier <= f.tier));
  if (remaining.length === 0) return null;
  const identity = (c: Exclude<JoinCandidate, { kind: "several" }>): string => {
    const hostPath = `path\u0000${valid(c.url)?.key ?? c.url}`;
    if (c.kind !== "known") return `${c.kind === "service" ? "other" : c.kind}\u0000${hostPath}`;
    const key = candidateMeetingKey(c.url);
    return key === undefined ? `known\u0000keyless\u0000${hostPath}` : `known\u0000key\u0000${key}`;
  };
  if (new Set(remaining.map((f) => identity(f.cand))).size !== 1) return { kind: "several" };
  remaining.sort((a, b) => a.tier - b.tier || a.at - b.at);
  return remaining[0]!.cand;
}
