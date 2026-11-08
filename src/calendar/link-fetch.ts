// src/calendar/link-fetch.ts — the private-link TRANSPORT (v0.3.0, plan M2a; spec r4 §3, §4.2 "Fetch" and
// "Never leaks", §8 statuses).
//
// ONE entry point, `fetchCalendarLink`: resolve the link's URL through M1's credential ladder
// (`./link-url.ts`), then one HTTPS GET with manual, re-checked redirects, a deadline measured from the
// network gate, and two streamed byte caps. It returns the body's BYTES or a typed failure. Parsing is M2c's,
// the Worker is M2b's, and M4 wires it into the run and `calendar test` (src/calendar/pipeline.ts, via `fetchCalendarUrl`).
//
// ⚠ THE URL IS A SECRET (spec §2, §4.2 "Never leaks"). It lives in this module's local variables and in the
// requests handed to the injected `fetch`, and nowhere else:
//   • an outcome carries a status and machine-readable codes — never text, never a URL, a host, a Location
//     header, a response body (except an `ok` outcome's `body`), or anything taken from an error;
//   • nothing here logs, warns or builds a message;
//   • every error is DISCARDED, never inspected: Bun's own fetch error carries the request URL in its `path`
//     field (measured, bun 1.3.14, a refused loopback connection), so not even "just the error code" is kept.
// `test/calendar-link-fetch.test.ts` drives a sentinel URL through every status and reason below (`internal`,
// which carries nothing by construction, has its own exact-shape test) and searches what comes back.
//
// NEVER THROWS: every path returns an outcome.
//
// THE OUTCOME → STATUS MAP (statuses from the fixed §8 list; `reason` is never rendered — it is for
// `calendar test --json` and the health file, so Settings can say what is wrong):
//   credential ladder `missing` / `refused` / `failed`  → `malformed`, `reason` = M1's own code, `from` = the rung
//                                                          (hub decision for M2a: no new status)
//   the configured URL: unparseable, not https (after the
//   `webcal://` rewrite), a non-default port, userinfo  → `malformed`  (url-invalid | url-not-https | url-port | url-userinfo)
//   a disallowed redirect (see below)                   → `link-redirected`
//   HTTP 401 / 403 / 404 / 410                          → `link-refused` (http-refused)                 — §8
//   HTTP 408 / 429 / 5xx                                → `incomplete` (http-unavailable)   ┐ not listed in the spec:
//   any other non-2xx, non-3xx status                   → `malformed`  (http-status)        ┘ this module's call, below
//   fetch rejected (DNS, connect, TLS) — `offline: true`→ `offline` (unreachable)
//                                      — otherwise      → `incomplete` (unreachable)  — §3: "a single unreachable link
//                                                          host is not 'offline': that link is marked incomplete"
//   the deadline                                        → `timeout` (deadline)
//   over 16 MB for this link                            → `too-large` (link-cap)
//   over the shared 32 MB, all links together           → `incomplete` (total-cap) — §3: "anything beyond marks
//                                                          the source incomplete"; the link is not too large
//                                                          itself, the run's total ran out (hub decision, M2a
//                                                          checkpoint)
//   the body stream failed part-way                     → `incomplete` (body-error)
//
// THE ANSWERS THE SPEC DOES NOT LIST, decided here and stated so a reviewer can disagree with one line each:
//   • 408, 429 and 5xx are the HOST's trouble, transient by definition (overloaded, rate-limiting, down for
//     maintenance). That is §3's "one dead host" in all but transport, so it gets the same answer:
//     `incomplete`, and the briefing still stamps.
//   • every other status (400, 405, 406, 451 …, and a status 0, which a non-Bun fetch can report) says
//     the request as configured is one the host will not serve, and retrying will not change that. Not
//     `link-refused`: §8 pins that to exactly 401/403/404/410. So `malformed` — "the calendar could not be
//     read" — with the status in `httpStatus` for Settings.
//   • any 2xx is success; the body is read whatever the exact code (a 204's empty body is M2c's parse error).
//   • a 3xx that is not 301/302/303/307/308 (300, 304, 305, 306 …) is not followed: `link-redirected`.
//
// REDIRECTS, MANUALLY: `redirect: "manual"` (bun 1.3.14 hands back the 3xx with its raw `Location`, relative
// or not — measured), at most CALENDAR_LINK_MAX_REDIRECTS, and EVERY hop re-checked against the CONFIGURED
// URL: `https`, the default port, no userinfo, the same registrable domain as the configured host
// (`sameRegistrableDomain` below — an equivalence, so anchoring on the configured host and chaining hop to hop
// agree today; the anchor keeps it so if the rule ever stops being one), and never a URL already requested. `webcal://` is rewritten only for the configured URL; a
// `Location` naming it is refused like any other non-https hop.
import type { CalendarLinkSource } from "./config";
import { resolveLinkUrl, type LinkUrlFrom, type LinkUrlOpts, type LinkUrlOutcome } from "./link-url";
import type { CalendarReadStatus } from "./types";

/** Each link's deadline, measured from the moment the network gate resolved (spec §3, §4.2) — the caller
 *  passes that moment as `startedAt`, so time spent before the fetch (the credential ladder's `urlCommand`,
 *  up to 5 s) comes out of the same ten seconds. */
export const CALENDAR_LINK_DEADLINE_MS = 10_000;

/** One link's body, at most (spec §3: "16 MB per link"). Binary megabytes. Counted as the body STREAMS, so an
 *  absent or lying `content-length` cannot make this read more than the cap; exactly the cap is accepted. */
export const CALENDAR_LINK_MAX_BYTES = 16 * 1024 * 1024;

/** Every link's body together, at most (spec §3: "32 MB in total") — the default limit of a
 *  `linkByteBudget()`, which the caller shares across one run's links. */
export const CALENDAR_LINKS_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** Redirects followed, at most (spec §4.2). A fourth redirect answer is `link-redirected`. */
export const CALENDAR_LINK_MAX_REDIRECTS = 3;

/** The fetch this module calls. Injected in every test (with `test/helpers/netGuard.ts` installed); the
 *  default, resolved at call time, is the global `fetch`. */
export type CalendarFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The 32 MB aggregate, as an ACCOUNTING OBJECT the caller creates once per run and hands to every link's
 *  fetch. `used` counts the bytes held by links that are still reading or have succeeded: a link that fails —
 *  for any reason, the deadline included — gives its bytes back AT ONCE, in the same turn it fails, because
 *  they were discarded and will never reach the parser, which is what the aggregate bounds. Links read
 *  concurrently, so the link whose chunk would cross the limit is the one that fails — and only that one: a
 *  give-back deferred past that turn let two interleaved links both fail on one crossing (measured). */
export type LinkByteBudget = { readonly limit: number; used: number };

/** A fresh aggregate for one run. */
export function linkByteBudget(limit: number = CALENDAR_LINKS_MAX_TOTAL_BYTES): LinkByteBudget {
  return { limit, used: 0 };
}

/** M1's reason codes — carried as they are when the credential ladder is what failed. */
export type LinkUrlReason = Exclude<LinkUrlOutcome, { status: "ok" }>["reason"];

/** This module's reason codes. Spelled so that none collides with an M1 code (pinned by a type-level check
 *  in the test file): `reason` alone says which stage failed. */
export type LinkTransportReason =
  // the configured URL — `malformed`
  | "url-invalid"            // not a URL at all
  | "url-not-https"          // any scheme but https (after the `webcal://` rewrite)
  | "url-port"               // a port other than 443
  | "url-userinfo"           // a username or password in the URL
  // a redirect — `link-redirected`
  | "redirect-not-https"     // http (a downgrade), webcal, or anything else
  | "redirect-port"
  | "redirect-userinfo"
  | "redirect-cross-domain"  // outside the configured host's registrable domain, or unsure (see below)
  | "redirect-limit"         // a redirect answer after CALENDAR_LINK_MAX_REDIRECTS were followed
  | "redirect-loop"          // back to a URL already requested
  | "redirect-no-location"   // a 301/302/303/307/308 with no Location
  | "redirect-bad-location"  // a Location that does not parse
  | "redirect-unsupported"   // a 3xx this module does not follow
  // an HTTP answer
  | "http-refused"           // 401/403/404/410 — `link-refused`
  | "http-unavailable"       // 408/429/5xx — `incomplete`
  | "http-status"            // any other non-2xx — `malformed`
  // the connection, the clock, the size, the body
  | "unreachable"            // fetch rejected: `offline` when the caller says the machine is, else `incomplete`
  | "deadline"               // `timeout`
  | "link-cap"               // over CALENDAR_LINK_MAX_BYTES — `too-large`
  | "total-cap"              // over the shared budget — `incomplete` (the run's total ran out, not this link)
  | "body-error"             // the body stream failed part-way — `incomplete`
  | "internal";              // a throw nothing above anticipated (unreachable by construction) — `incomplete`

export type LinkFetchReason = LinkUrlReason | LinkTransportReason;

/** The statuses a link fetch can end in: a subset of §8's fixed list, by construction. */
export type LinkFetchStatus = Extract<
  CalendarReadStatus, "ok" | "link-refused" | "link-redirected" | "malformed" | "timeout" | "offline" | "too-large" | "incomplete"
>;

export type LinkFetchOk = {
  status: "ok";
  /** The response body, whole. Bytes, not text: decoding is the parser's (M2c), and bytes cross into a
   *  Worker (M2b) by transfer rather than by copy. */
  body: Uint8Array;
  /** Redirects followed, 0 to CALENDAR_LINK_MAX_REDIRECTS. */
  redirects: number;
};

export type LinkFetchFailure = {
  status: Exclude<LinkFetchStatus, "ok">;
  /** Machine-readable cause. Never rendered into the briefing (its status line is §8's fixed text). */
  reason: LinkFetchReason;
  /** Present only when the credential ladder failed: which rung (`file`, `env`, `command`). */
  from?: LinkUrlFrom;
  /** The HTTP status of the answer that ended the fetch, when one did. */
  httpStatus?: number;
};

export type LinkFetchOutcome = LinkFetchOk | LinkFetchFailure;

export type LinkFetchOpts = LinkUrlOpts & {
  /** When the network gate resolved, in ms on `now`'s clock (spec §3: the step starts there). REQUIRED: the
   *  deadline is defined from it. A `startedAt` in the future is treated as now — the deadline is never
   *  longer than CALENDAR_LINK_DEADLINE_MS. */
  startedAt: number;
  /** This run's shared aggregate, from `linkByteBudget()`. REQUIRED: one per run, handed to every link. */
  budget: LinkByteBudget;
  /** The caller's verdict that the MACHINE is offline (its machine-level network probe failed, spec §3).
   *  Only then is a connection failure `offline`; otherwise one unreachable host is `incomplete`. */
  offline?: boolean;
  /** Defaults to the global `fetch`. */
  fetch?: CalendarFetch;
  /** Defaults to `Date.now`. */
  now?: () => number;
};

// ── the registrable-domain rule ─────────────────────────────────────────────────────────────────────
//
// There is no public-suffix list in this repo and no runtime dependencies (spec §4.2's parse bullet), so this
// is a CONSERVATIVE stand-in for one, and it refuses when unsure:
//   1. an identical host passes (compared lower-case, as `URL` already normalises it);
//   2. an IP address, a single-label host, or a host with an empty label (a trailing dot) has no registrable
//      domain here, so only rule 1 can pass it;
//   3. a host under a SHARED-HOSTING domain (below) — where unrelated customers share the last two labels at
//      any depth — likewise passes only rule 1;
//   4. otherwise the registrable domain is the last two labels, or the last THREE when those two look like a
//      public suffix: listed below, or a two-letter country code under a second-level label of at most three
//      characters (co.uk, com.au, ne.jp, or.kr, org.nz …). A host that IS such a suffix has none.
// Two hosts pass when rule 1 holds or both have the same registrable domain. iCloud's `p01-calendars.icloud.com`
// → `p52-calendars.icloud.com` hops pass (icloud.com); `calendar.google.com` → `google.com.example.net` does not.
//
// ⚠ EVERY ENTRY IN BOTH LISTS ONLY MAKES THE RULE STRICTER — a wrong entry can refuse a legitimate redirect,
// never admit a foreign one — so the lists are examples, not an inventory. The rule's KNOWN GAPS, all in the
// admitting direction and all deeper than two labels: an unlisted shared-hosting domain (`a.example-host.com`
// → `b.example-host.com` passes); a three-label public suffix (`a.k12.ma.us` → `b.k12.ma.us`, a
// `*.sch.uk` school, a Japanese city suffix); a shared host under a country registry (`a.blogspot.co.uk` →
// `b.blogspot.co.uk`). Each still keeps the request on https, port 443, within three hops and inside the same
// public registry as the configured host. Its KNOWN FALSE REFUSALS: a short brand under a country code
// (`cal.ab.io` → `www.ab.io` — the country-code heuristic reads `ab.io` as a registry), and two distinct
// registrable domains run by one company (`outlook.office365.com` → `outlook.office.com`). Those end as
// `link-redirected`, which names the link and asks nothing of the parser — the safe direction. Gate G3 (spec
// §9) measures the real providers' redirects.

/** Two-label public suffixes the country-code heuristic does not catch (a longer second-level label, or one
 *  under a generic top-level domain). */
const MULTI_PART_SUFFIXES: ReadonlySet<string> = new Set([
  "gouv.fr", "govt.nz", "police.uk", "nhs.uk",
  "uk.com", "us.com", "eu.com", "gb.com", "de.com", "br.com", "cn.com", "jpn.com", "ru.com", "za.com", "co.com",
  "uk.net", "gb.net", "se.net",
]);

/** Domains whose subdomains belong to unrelated customers. */
const SHARED_HOSTING_SUFFIXES: ReadonlySet<string> = new Set([
  "github.io", "gitlab.io", "herokuapp.com", "appspot.com", "blogspot.com", "cloudfront.net", "amazonaws.com",
  "azurewebsites.net", "netlify.app", "vercel.app", "pages.dev", "workers.dev", "web.app", "firebaseapp.com",
  "onrender.com", "fly.dev", "ngrok.io", "ngrok-free.app", "duckdns.org", "dyndns.org",
]);

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** The registrable domain under the rule above, or `undefined` when the rule has none for this host. */
function registrableDomain(host: string): string | undefined {
  // `URL` keeps an IPv6 literal's brackets in `hostname` (measured, bun 1.3.14); any `:` is an address.
  if (host.includes(":") || host.startsWith("[") || IPV4_RE.test(host)) return undefined;
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => l === "")) return undefined;
  const last2 = labels.slice(-2).join(".");
  if (SHARED_HOSTING_SUFFIXES.has(last2)) return undefined;
  const tld = labels[labels.length - 1]!, sld = labels[labels.length - 2]!;
  const suffixLabels = MULTI_PART_SUFFIXES.has(last2) || (tld.length === 2 && sld.length <= 3) ? 2 : 1;
  if (labels.length <= suffixLabels) return undefined;
  return labels.slice(-(suffixLabels + 1)).join(".");
}

/** May a redirect go from the configured host `configured` to `target`? See the rule above. Exported for its
 *  own table test. */
export function sameRegistrableDomain(configured: string, target: string): boolean {
  const a = configured.toLowerCase(), b = target.toLowerCase();
  if (a === b) return true;
  const ra = registrableDomain(a);
  return ra !== undefined && ra === registrableDomain(b);
}

// ── the URL checks ──────────────────────────────────────────────────────────────────────────────────

const WEBCAL_RE = /^webcal:\/\//i;

/** The configured URL, `webcal://` rewritten to `https://`, or the reason it is refused. The rewrite is
 *  textual and comes first: `URL` parses `webcal:` as a non-special scheme, with different rules. */
function configuredUrl(raw: string): URL | LinkTransportReason {
  const text = WEBCAL_RE.test(raw) ? `https://${raw.slice("webcal://".length)}` : raw;
  let u: URL;
  try { u = new URL(text); } catch { return "url-invalid"; }
  if (u.protocol !== "https:") return "url-not-https";
  // `URL` normalises an explicit `:443` on https to "", so "" is exactly "the default port".
  if (u.port !== "") return "url-port";
  if (u.username !== "" || u.password !== "") return "url-userinfo";
  u.hash = "";
  return u;
}

/** Why a redirect to `next` is refused, or `undefined` when it may be followed. Always against the
 *  CONFIGURED URL. */
function hopProblem(next: URL, configured: URL): LinkTransportReason | undefined {
  if (next.protocol !== "https:") return "redirect-not-https";
  if (next.port !== "") return "redirect-port";
  if (next.username !== "" || next.password !== "") return "redirect-userinfo";
  if (!sameRegistrableDomain(configured.hostname, next.hostname)) return "redirect-cross-domain";
  return undefined;
}

// ── the transfer ────────────────────────────────────────────────────────────────────────────────────

const FOLLOWED = new Set([301, 302, 303, 307, 308]);
const REFUSED = new Set([401, 403, 404, 410]);

const fail = (status: LinkFetchFailure["status"], reason: LinkTransportReason, httpStatus?: number): LinkFetchFailure =>
  httpStatus === undefined ? { status, reason } : { status, reason, httpStatus };

/** This link's share of the work in flight: the bytes it holds against the budget, and the body reader the
 *  deadline must cancel. */
type Progress = { budget: LinkByteBudget; bytes: number; reader?: ReadableStreamDefaultReader<Uint8Array> };

/** Give this link's bytes back to the shared budget. Idempotent, so every failure path may call it. */
function giveBack(link: Progress): void {
  link.budget.used -= link.bytes;
  link.bytes = 0;
}

/** Release a response we will not read. Best-effort: the body may be null, locked, or already gone. */
function discard(res: Response): void {
  try { res.body?.cancel().catch(() => {}); } catch { /* nothing to release */ }
}

/** Read the body under both caps. Stops reading — cancels the stream and gives the link's bytes back — the
 *  moment either cap would be exceeded, the deadline fires, or the stream fails. Adds nothing to the budget
 *  once the deadline has fired. */
async function readBody(res: Response, redirects: number, signal: AbortSignal, link: Progress): Promise<LinkFetchOutcome> {
  const budget = link.budget;
  // A declared length over either cap is refused unread; an absent or lying one is caught as the bytes come.
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared)) {
    if (declared > CALENDAR_LINK_MAX_BYTES) { discard(res); return fail("too-large", "link-cap"); }
    if (declared > budget.limit - budget.used) { discard(res); return fail("incomplete", "total-cap"); }
  }
  if (res.body === null) return { status: "ok", body: new Uint8Array(0), redirects };
  const reader = res.body.getReader();
  link.reader = reader;
  const chunks: Uint8Array[] = [];
  let finished = false;
  try {
    for (;;) {
      let step: Awaited<ReturnType<typeof reader.read>>;
      try { step = await reader.read(); } catch { return signal.aborted ? fail("timeout", "deadline") : fail("incomplete", "body-error"); }
      // The deadline fired while that read was pending (cancelling the reader resolves it): count nothing more.
      if (signal.aborted) return fail("timeout", "deadline");
      if (step.done) break;
      const chunk: unknown = step.value;
      // A real body yields bytes; anything else would put NaN into a budget other links share.
      if (!(chunk instanceof Uint8Array)) return fail("incomplete", "body-error");
      if (link.bytes + chunk.byteLength > CALENDAR_LINK_MAX_BYTES) return fail("too-large", "link-cap");
      if (budget.used + chunk.byteLength > budget.limit) return fail("incomplete", "total-cap");
      chunks.push(chunk);
      link.bytes += chunk.byteLength;
      budget.used += chunk.byteLength;
    }
    finished = true;
  } finally {
    // STOP READING: every early return above leaves the stream mid-flight. Not awaited — a stream that never
    // settles its cancel must not hold the morning. And give the bytes back now, before another link's chunk
    // is counted.
    if (!finished) {
      reader.cancel().catch(() => {});
      giveBack(link);
    }
  }
  return { status: "ok", body: Buffer.concat(chunks, link.bytes), redirects };
}

/** The request loop: GET, follow allowed redirects, classify the final answer, read the body. Never throws
 *  for anything a fetch or a response can do; a throw from elsewhere is the caller's `internal`. */
async function exchange(start: URL, opts: LinkFetchOpts, signal: AbortSignal, link: Progress): Promise<LinkFetchOutcome> {
  const fetchFn: CalendarFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const seen = new Set<string>([start.href]);
  let url = start;
  for (let redirects = 0; ;) {
    // After the deadline the race has already answered; a fetch that ignored the abort must not lead to one
    // more request (the next hop) or one more read.
    if (signal.aborted) return fail("timeout", "deadline");
    let res: Response;
    try {
      res = await fetchFn(url.href, { method: "GET", redirect: "manual", signal });
    } catch {
      // The error is dropped unread (see the header: Bun's carries the URL). Which failure it was — DNS,
      // refused, reset, TLS — is not distinguished; all are "this host did not answer".
      if (signal.aborted) return fail("timeout", "deadline");
      return opts.offline === true ? fail("offline", "unreachable") : fail("incomplete", "unreachable");
    }
    const status = res.status;

    if (status >= 300 && status <= 399) {
      discard(res);
      if (!FOLLOWED.has(status)) return fail("link-redirected", "redirect-unsupported", status);
      if (redirects >= CALENDAR_LINK_MAX_REDIRECTS) return fail("link-redirected", "redirect-limit", status);
      const location = res.headers.get("location");
      if (location === null || location.trim() === "") return fail("link-redirected", "redirect-no-location", status);
      let next: URL;
      try { next = new URL(location, url); } catch { return fail("link-redirected", "redirect-bad-location", status); }
      next.hash = "";
      const problem = hopProblem(next, start);
      if (problem !== undefined) return fail("link-redirected", problem, status);
      if (seen.has(next.href)) return fail("link-redirected", "redirect-loop", status);
      seen.add(next.href);
      url = next;
      redirects++;
      continue;
    }

    if (status < 200 || status > 299) {
      discard(res);
      if (REFUSED.has(status)) return fail("link-refused", "http-refused", status);
      if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return fail("incomplete", "http-unavailable", status);
      return fail("malformed", "http-status", status);
    }

    if (signal.aborted) { discard(res); return fail("timeout", "deadline"); }
    return await readBody(res, redirects, signal, link);
  }
}

/** The deadline around `exchange`: an abort for a well-behaved fetch, a race for anything that ignores it (a
 *  stand-in that never settles, a body read that hangs), so the bound is this function's property rather
 *  than the fetch's — the `src/updateCheck.ts` shape. The link's bytes go back to the budget on any failure:
 *  in `readBody` for its own, in the timer for the deadline, and once more after the race (idempotent) for a
 *  throw neither saw. */
async function transfer(start: URL, opts: LinkFetchOpts): Promise<LinkFetchOutcome> {
  const now = opts.now ?? Date.now;
  const left = opts.startedAt + CALENDAR_LINK_DEADLINE_MS - now();
  const remaining = Number.isFinite(left) ? Math.min(left, CALENDAR_LINK_DEADLINE_MS) : CALENDAR_LINK_DEADLINE_MS;
  if (remaining <= 0) return fail("timeout", "deadline");

  const controller = new AbortController();
  const link: Progress = { budget: opts.budget, bytes: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<LinkFetchOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      link.reader?.cancel().catch(() => {});
      giveBack(link);
      resolve(fail("timeout", "deadline"));
    }, remaining);
    (timer as { unref?: () => void }).unref?.();
  });
  let out: LinkFetchOutcome;
  try {
    out = await Promise.race([exchange(start, opts, controller.signal, link), deadline]);
  } catch {
    out = fail("incomplete", "internal");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Tears down whatever is still in flight on a failure; a no-op after a body read to the end.
    controller.abort();
  }
  if (out.status !== "ok") giveBack(link);
  return out;
}

/** Fetch one calendar link: its URL from the credential ladder, then the transfer above. Never throws; see
 *  the header for the outcome map and what an outcome can never carry. */
export async function fetchCalendarLink(
  link: { id: string } & CalendarLinkSource, opts: LinkFetchOpts,
): Promise<LinkFetchOutcome> {
  try {
    const credential = await resolveLinkUrl(link, opts);
    if (credential.status !== "ok") return { status: "malformed", reason: credential.reason, from: credential.from };
    return await fetchCalendarUrl(credential.url, opts);
  } catch {
    // Unreachable by construction (the ladder and the transfer return outcomes); kept so "never throws"
    // does not rest on that. Nothing from the error is kept.
    return fail("incomplete", "internal");
  }
}

/** The transfer alone, for a URL the caller already resolved through `resolveLinkUrl` (M4's pipeline does, once,
 *  because the parse step needs the URL for the link's identity — `linkIdentity` in `./link-parse.ts` — and a
 *  second ladder read would run a `urlCommand` twice). Same rules, same outcomes, same "never throws". */
export async function fetchCalendarUrl(rawUrl: string, opts: LinkFetchOpts): Promise<LinkFetchOutcome> {
  try {
    const start = configuredUrl(rawUrl);
    if (typeof start === "string") return fail("malformed", start);
    return await transfer(start, opts);
  } catch {
    return fail("incomplete", "internal");
  }
}

/** Is this a URL `fetchCalendarUrl` would request at all (https after the `webcal://` rewrite, the default port, no
 *  userinfo)? For `calendar add-link` (M5), which refuses to store anything else. Answers a code, never text. */
export function calendarUrlProblem(rawUrl: string): Extract<LinkTransportReason, `url-${string}`> | undefined {
  const u = configuredUrl(rawUrl);
  return typeof u === "string" ? (u as Extract<LinkTransportReason, `url-${string}`>) : undefined;
}
