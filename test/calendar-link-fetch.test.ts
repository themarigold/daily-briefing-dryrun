// test/calendar-link-fetch.test.ts — the private-link transport (v0.3.0 plan M2a; spec r4 §3, §4.2 "Fetch"
// and "Never leaks", §8).
//
// NO NETWORK: every fetch here is an injected fake keyed by URL, and `netGuard` is installed for the file, so
// a fetch that slipped through to the real one would fail the file. No real 10 s wait: deadlines are driven by
// an injected clock and a `startedAt` already nearly ten seconds old.
//
// Layout: one MATRIX of cases — every rule of §4.2's Fetch bullet, every redirect case, the HTTP answers,
// connection failure, the deadline, both caps, and every credential-ladder failure — each pinned to its exact
// outcome and to the exact URLs requested (so a refused redirect target is proven never requested). Then the
// properties a table cannot show (streamed caps stop reading, the shared budget, the deadline's anchor), the
// registrable-domain rule's own table, and last the URL-LEAK SENTINEL sweep over the whole matrix — the point
// of this file (the `test/calendar-link-url.test.ts` rule).
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import {
  CALENDAR_LINK_DEADLINE_MS, CALENDAR_LINK_MAX_BYTES, CALENDAR_LINK_MAX_REDIRECTS, CALENDAR_LINKS_MAX_TOTAL_BYTES,
  fetchCalendarLink, linkByteBudget, sameRegistrableDomain,
  type CalendarFetch, type LinkByteBudget, type LinkFetchOpts, type LinkFetchOutcome, type LinkTransportReason, type LinkUrlReason,
} from "../src/calendar/link-fetch";
import { calendarLinkFilePath, calendarLinksDir } from "../src/calendar/link-url";
import type { CalendarLinkSource } from "../src/calendar/config";
import { CALENDAR_STATUS_TEXT } from "../src/calendar/render-contract";
import type { RunResult } from "../src/proc";

guardNetworkForThisFile();

// ── the sentinel ───────────────────────────────────────────────────────────────────────────────────

/** The distinctive part of every secret URL below; a partial leak would still carry it. */
const TOKEN = "ZZSENTINELcafe0000";
/** A Google-secret-address-shaped link, and an iCloud shared link (`webcal://`, as iCloud hands it out). */
const G = `https://calendar.google.com/calendar/ical/me%40example.com/private-${TOKEN}/basic.ics`;
const ICLOUD = `webcal://p01-calendars.icloud.com/published/2/${TOKEN}`;
const ICLOUD_HTTPS = `https://p01-calendars.icloud.com/published/2/${TOKEN}`;
/** A same-domain URL carrying the token, for redirect chains: a `Location` is as secret as the link. */
const gHop = (n: number | string) => `https://calendar.google.com/calendar/ical/hop-${n}-${TOKEN}.ics`;
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

// ── fakes ──────────────────────────────────────────────────────────────────────────────────────────

type Route = (init: RequestInit) => Response | Promise<Response>;
type Routes = Record<string, Route>;
type Link = { id: string } & CalendarLinkSource;

const ENV_LINK: Link = { id: "work", urlFrom: "env", urlEnv: "CAL_URL" };

const ok = (body: BodyInit | null = ICS, headers?: HeadersInit): Route => () => new Response(body, { status: 200, headers });
const answer = (status: number): Route => () => new Response([204, 304].includes(status) ? null : `status ${status} ${TOKEN}`, { status });
const redirect = (status: number, location?: string): Route => () =>
  new Response(null, { status, headers: location === undefined ? {} : { location } });

/** A Bun-shaped connection failure: the message and the `path` field both carry the URL (measured, bun 1.3.14). */
const connectionError = (url: string) => Object.assign(new Error(`Unable to connect. Is the computer able to access the url? ${url}`), { code: "ConnectionRefused", path: url });

/** A fetch that answers from `routes` by exact URL, records every request, and fails like Bun's does for a
 *  URL it has no route for. */
function fakeFetch(routes: Routes, requested: string[], inits: RequestInit[] = []): CalendarFetch {
  return async (url, init) => {
    requested.push(url);
    inits.push(init);
    const route = routes[url];
    if (route === undefined) throw connectionError(url);
    return route(init);
  };
}

/** A pull-driven body of `chunk`-byte chunks with counters: how many chunks were PULLED (highWaterMark 0, so a
 *  pull happens only when the reader asks) and whether the stream was cancelled. `chunks` closes after that
 *  many; `stallAfter` hangs forever after that many; `errorAfter` errors after that many. */
function body(o: { chunk: number; chunks?: number; stallAfter?: number; errorAfter?: number }) {
  const stats = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      stats.pulls++;
      if (o.chunks !== undefined && stats.pulls > o.chunks) { c.close(); return; }
      if (o.errorAfter !== undefined && stats.pulls > o.errorAfter) { c.error(connectionError(G)); return; }
      if (o.stallAfter !== undefined && stats.pulls > o.stallAfter) return new Promise<void>(() => {});
      c.enqueue(new Uint8Array(o.chunk));
    },
    cancel() { stats.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, stats };
}

const fakeRun = (r: Partial<RunResult>) => async (): Promise<RunResult> =>
  ({ out: "", err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false, ...r });

type Run = { outcome: LinkFetchOutcome; requested: string[] };

/** One fetch: `url` (when given) reaches the link through the env rung, the fake answers from `routes`. */
async function via(url: string | undefined, routes: Routes, o: { link?: Link; opts?: Partial<LinkFetchOpts> } = {}): Promise<Run> {
  const requested: string[] = [];
  const outcome = await fetchCalendarLink(o.link ?? ENV_LINK, {
    stateDir: "/nonexistent",
    env: url === undefined ? {} : { CAL_URL: url },
    startedAt: Date.now(),
    budget: linkByteBudget(),
    fetch: fakeFetch(routes, requested),
    ...o.opts,
  });
  return { outcome, requested };
}

/** A comparable view of an outcome: a failure as it is, an `ok` without its bytes. */
const summary = (o: LinkFetchOutcome) => (o.status === "ok" ? { status: o.status, redirects: o.redirects, bytes: o.body.byteLength } : o);

/** A temp state folder holding the link's managed file at `fileMode`. */
function managed(content: string, fileMode = 0o600): string {
  const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cal-fetch-")));
  mkdirSync(calendarLinksDir(root), { recursive: true });
  chmodSync(calendarLinksDir(root), 0o700);
  writeFileSync(calendarLinkFilePath(root, "work"), content);
  chmodSync(calendarLinkFilePath(root, "work"), fileMode);
  return root;
}

// ── the matrix ─────────────────────────────────────────────────────────────────────────────────────

type Case = { label: string; run: () => Promise<Run>; expect: ReturnType<typeof summary>; requested: string[] };

const okResult = (redirects = 0, bytes = ICS.length) => ({ status: "ok" as const, redirects, bytes });
const failed = (status: Exclude<LinkFetchOutcome["status"], "ok">, reason: LinkTransportReason, httpStatus?: number) =>
  (httpStatus === undefined ? { status, reason } : { status, reason, httpStatus });
const ladder = (reason: LinkUrlReason, from: "file" | "env" | "command") => ({ status: "malformed" as const, reason, from });
const T0 = 1_760_000_000_000;

const MATRIX: Case[] = [
  // the configured URL
  { label: "https, 200", run: () => via(G, { [G]: ok() }), expect: okResult(), requested: [G] },
  { label: "webcal:// is rewritten to https://", run: () => via(ICLOUD, { [ICLOUD_HTTPS]: ok() }), expect: okResult(), requested: [ICLOUD_HTTPS] },
  { label: "WEBCAL:// in capitals, too", run: () => via(ICLOUD.replace("webcal", "WEBCAL"), { [ICLOUD_HTTPS]: ok() }), expect: okResult(), requested: [ICLOUD_HTTPS] },
  { label: "an explicit :443 is the default port", run: () => via(G.replace(".com/", ".com:443/"), { [G]: ok() }), expect: okResult(), requested: [G] },
  { label: "the fragment is never sent", run: () => via(`${G}#frag-${TOKEN}`, { [G]: ok() }), expect: okResult(), requested: [G] },
  { label: "malformed URL: not a URL", run: () => via(`not a url ${TOKEN}`, {}), expect: failed("malformed", "url-invalid"), requested: [] },
  { label: "malformed URL: a broken host", run: () => via(`https://[${TOKEN}/basic.ics`, {}), expect: failed("malformed", "url-invalid"), requested: [] },
  { label: "non-https: http", run: () => via(G.replace("https:", "http:"), {}), expect: failed("malformed", "url-not-https"), requested: [] },
  { label: "non-https: webcals", run: () => via(ICLOUD.replace("webcal:", "webcals:"), {}), expect: failed("malformed", "url-not-https"), requested: [] },
  { label: "non-https: file", run: () => via(`file:///tmp/${TOKEN}.ics`, {}), expect: failed("malformed", "url-not-https"), requested: [] },
  { label: "non-default port", run: () => via(G.replace(".com/", ".com:8443/"), {}), expect: failed("malformed", "url-port"), requested: [] },
  { label: "non-default port, through webcal", run: () => via(ICLOUD.replace(".com/", ".com:80/"), {}), expect: failed("malformed", "url-port"), requested: [] },
  { label: "userinfo: a username", run: () => via(G.replace("https://", "https://me@"), {}), expect: failed("malformed", "url-userinfo"), requested: [] },
  { label: "userinfo: a password", run: () => via(G.replace("https://", `https://me:${TOKEN}@`), {}), expect: failed("malformed", "url-userinfo"), requested: [] },

  // redirects
  { label: "a relative same-host redirect is followed", run: () => via(G, { [G]: redirect(302, `/calendar/ical/hop-1-${TOKEN}.ics`), [gHop(1)]: ok() }), expect: okResult(1), requested: [G, gHop(1)] },
  ...[301, 302, 303, 307, 308].map((s): Case => ({
    label: `${s} is followed`, run: () => via(G, { [G]: redirect(s, gHop(s)), [gHop(s)]: ok() }), expect: okResult(1), requested: [G, gHop(s)],
  })),
  {
    label: "an iCloud pNN hop passes (p01-calendars → p52-calendars, same registrable domain)",
    run: () => via(ICLOUD, { [ICLOUD_HTTPS]: redirect(301, ICLOUD_HTTPS.replace("p01", "p52")), [ICLOUD_HTTPS.replace("p01", "p52")]: ok() }),
    expect: okResult(1), requested: [ICLOUD_HTTPS, ICLOUD_HTTPS.replace("p01", "p52")],
  },
  {
    label: `${CALENDAR_LINK_MAX_REDIRECTS} hops, then 200`,
    run: () => via(G, { [G]: redirect(302, gHop(1)), [gHop(1)]: redirect(302, gHop(2)), [gHop(2)]: redirect(302, gHop(3)), [gHop(3)]: ok() }),
    expect: okResult(3), requested: [G, gHop(1), gHop(2), gHop(3)],
  },
  {
    label: "4 hops: the fourth redirect is refused and never requested",
    run: () => via(G, { [G]: redirect(302, gHop(1)), [gHop(1)]: redirect(302, gHop(2)), [gHop(2)]: redirect(302, gHop(3)), [gHop(3)]: redirect(302, gHop(4)), [gHop(4)]: ok() }),
    expect: failed("link-redirected", "redirect-limit", 302), requested: [G, gHop(1), gHop(2), gHop(3)],
  },
  { label: "cross-domain", run: () => via(G, { [G]: redirect(302, `https://evil.example.net/${TOKEN}`) }), expect: failed("link-redirected", "redirect-cross-domain", 302), requested: [G] },
  { label: "cross-domain, a look-alike prefix", run: () => via(G, { [G]: redirect(302, `https://calendar.google.com.evil.example.net/${TOKEN}`) }), expect: failed("link-redirected", "redirect-cross-domain", 302), requested: [G] },
  { label: "http downgrade, same host", run: () => via(G, { [G]: redirect(301, gHop(1).replace("https:", "http:")) }), expect: failed("link-redirected", "redirect-not-https", 301), requested: [G] },
  { label: "a webcal:// Location is not rewritten", run: () => via(G, { [G]: redirect(302, gHop(1).replace("https:", "webcal:")) }), expect: failed("link-redirected", "redirect-not-https", 302), requested: [G] },
  { label: "port change, same host", run: () => via(G, { [G]: redirect(302, gHop(1).replace(".com/", ".com:8443/")) }), expect: failed("link-redirected", "redirect-port", 302), requested: [G] },
  { label: "userinfo in the Location", run: () => via(G, { [G]: redirect(302, gHop(1).replace("https://", `https://u:${TOKEN}@`)) }), expect: failed("link-redirected", "redirect-userinfo", 302), requested: [G] },
  { label: "a looping redirect (A → B → A)", run: () => via(G, { [G]: redirect(302, gHop("b")), [gHop("b")]: redirect(302, G) }), expect: failed("link-redirected", "redirect-loop", 302), requested: [G, gHop("b")] },
  { label: "a redirect to itself", run: () => via(G, { [G]: redirect(307, G) }), expect: failed("link-redirected", "redirect-loop", 307), requested: [G] },
  { label: "a redirect with no Location", run: () => via(G, { [G]: redirect(302) }), expect: failed("link-redirected", "redirect-no-location", 302), requested: [G] },
  { label: "a Location that does not parse", run: () => via(G, { [G]: redirect(302, `https://[${TOKEN}`) }), expect: failed("link-redirected", "redirect-bad-location", 302), requested: [G] },
  { label: "300 is not followed", run: () => via(G, { [G]: redirect(300, gHop(1)) }), expect: failed("link-redirected", "redirect-unsupported", 300), requested: [G] },
  { label: "304 is not followed", run: () => via(G, { [G]: answer(304) }), expect: failed("link-redirected", "redirect-unsupported", 304), requested: [G] },
  {
    label: "every hop is checked: a chain that leaves the domain on its third step is stopped there, unrequested",
    run: () => via(ICLOUD, {
      [ICLOUD_HTTPS]: redirect(302, `https://p52-calendars.icloud.com/${TOKEN}`),
      [`https://p52-calendars.icloud.com/${TOKEN}`]: redirect(302, `https://www.icloud.com/${TOKEN}`),
      [`https://www.icloud.com/${TOKEN}`]: redirect(302, `https://icloud.example.org/${TOKEN}`),
    }),
    expect: failed("link-redirected", "redirect-cross-domain", 302),
    requested: [ICLOUD_HTTPS, `https://p52-calendars.icloud.com/${TOKEN}`, `https://www.icloud.com/${TOKEN}`],
  },

  // HTTP answers
  ...[401, 403, 404, 410].map((s): Case => ({ label: `HTTP ${s}`, run: () => via(G, { [G]: answer(s) }), expect: failed("link-refused", "http-refused", s), requested: [G] })),
  ...[500, 502, 503, 504, 408, 429].map((s): Case => ({ label: `HTTP ${s}`, run: () => via(G, { [G]: answer(s) }), expect: failed("incomplete", "http-unavailable", s), requested: [G] })),
  ...[400, 405, 451].map((s): Case => ({ label: `HTTP ${s}`, run: () => via(G, { [G]: answer(s) }), expect: failed("malformed", "http-status", s), requested: [G] })),
  { label: "HTTP 204: ok, empty", run: () => via(G, { [G]: answer(204) }), expect: okResult(0, 0), requested: [G] },
  { label: "HTTP 203: any 2xx is read", run: () => via(G, { [G]: () => new Response(ICS, { status: 203 }) }), expect: okResult(), requested: [G] },

  // the connection
  { label: "DNS / connection failure, machine online: one dead host is incomplete", run: () => via(G, {}), expect: failed("incomplete", "unreachable"), requested: [G] },
  { label: "DNS / connection failure, the caller says the machine is offline", run: () => via(G, {}, { opts: { offline: true } }), expect: failed("offline", "unreachable"), requested: [G] },
  {
    label: "a fetch that throws synchronously",
    run: () => via(G, {}, { opts: { fetch: ((url: string) => { throw connectionError(url); }) as unknown as CalendarFetch } }),
    expect: failed("incomplete", "unreachable"), requested: [],
  },
  { label: "a redirect to a dead host", run: () => via(G, { [G]: redirect(302, gHop(1)) }), expect: failed("incomplete", "unreachable"), requested: [G, gHop(1)] },

  // the deadline (no real 10 s wait: `startedAt` is already nearly, or fully, ten seconds old)
  { label: "the deadline already passed: nothing is requested", run: () => via(G, { [G]: ok() }, { opts: { startedAt: Date.now() - CALENDAR_LINK_DEADLINE_MS } }), expect: failed("timeout", "deadline"), requested: [] },
  { label: "timeout: a fetch that never answers", run: () => via(G, { [G]: () => new Promise<Response>(() => {}) }, { opts: { startedAt: Date.now() - CALENDAR_LINK_DEADLINE_MS + 40 } }), expect: failed("timeout", "deadline"), requested: [G] },
  {
    label: "timeout: a well-behaved fetch rejects on the abort",
    run: () => via(G, { [G]: (init) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(connectionError(G)))) }, { opts: { startedAt: Date.now() - CALENDAR_LINK_DEADLINE_MS + 40 } }),
    expect: failed("timeout", "deadline"), requested: [G],
  },
  { label: "timeout: the body stalls mid-stream", run: () => via(G, { [G]: () => new Response(body({ chunk: 1024, stallAfter: 2 }).stream) }, { opts: { startedAt: Date.now() - CALENDAR_LINK_DEADLINE_MS + 60 } }), expect: failed("timeout", "deadline"), requested: [G] },

  // the size caps
  { label: "oversize, streamed: over 16 MB with no content-length", run: () => via(G, { [G]: () => new Response(body({ chunk: 64 * 1024 }).stream) }), expect: failed("too-large", "link-cap"), requested: [G] },
  { label: "oversize, declared: a content-length over 16 MB", run: () => via(G, { [G]: ok(body({ chunk: 1 }).stream, { "content-length": String(CALENDAR_LINK_MAX_BYTES + 1) }) }), expect: failed("too-large", "link-cap"), requested: [G] },
  {
    label: "oversize, aggregate: the shared budget has less left than this body",
    run: () => { const b = linkByteBudget(); b.used = b.limit - 10; return via(G, { [G]: ok(ICS) }, { opts: { budget: b } }); },
    expect: failed("incomplete", "total-cap"), requested: [G],
  },
  {
    label: "oversize, aggregate, declared",
    run: () => { const b = linkByteBudget(); b.used = b.limit - 10; return via(G, { [G]: ok(ICS, { "content-length": "11" }) }, { opts: { budget: b } }); },
    expect: failed("incomplete", "total-cap"), requested: [G],
  },
  { label: "the body fails part-way", run: () => via(G, { [G]: () => new Response(body({ chunk: 1024, errorAfter: 3 }).stream) }), expect: failed("incomplete", "body-error"), requested: [G] },

  // the credential ladder: every failure is `malformed` with M1's reason and rung, and nothing is requested
  { label: "ladder: env unset", run: () => via(undefined, {}), expect: ladder("env-unset", "env"), requested: [] },
  { label: "ladder: env too long", run: () => via(G.repeat(100), {}), expect: ladder("too-long", "env"), requested: [] },
  { label: "ladder: managed file missing", run: () => via(undefined, {}, { link: { id: "work", urlFrom: "file" }, opts: { stateDir: removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cal-fetch-"))) } }), expect: ladder("file-missing", "file"), requested: [] },
  { label: "ladder: managed file readable by others", run: () => via(undefined, {}, { link: { id: "work", urlFrom: "file" }, opts: { stateDir: managed(G, 0o644) } }), expect: ladder("file-permissions", "file"), requested: [] },
  { label: "ladder: managed file on win32", run: () => via(undefined, {}, { link: { id: "work", urlFrom: "file" }, opts: { stateDir: managed(G), platform: "win32" } }), expect: ladder("unsupported-platform", "file"), requested: [] },
  { label: "ladder: a failing urlCommand (exit 1, the URL on both streams)", run: () => via(undefined, {}, { link: { id: "work", urlFrom: "command", urlCommand: ["pass", "show", "cal/work"] }, opts: { exec: fakeRun({ code: 1, out: G, err: G }) } }), expect: ladder("command-exit", "command"), requested: [] },
  { label: "ladder: urlCommand timed out", run: () => via(undefined, {}, { link: { id: "work", urlFrom: "command", urlCommand: ["pass"] }, opts: { exec: fakeRun({ timedOut: true, code: -1, out: G, err: G }) } }), expect: ladder("command-timeout", "command"), requested: [] },
  { label: "ladder: urlCommand could not start", run: () => via(undefined, {}, { link: { id: "work", urlFrom: "command", urlCommand: ["pass"] }, opts: { exec: fakeRun({ spawned: false, code: -1 }) } }), expect: ladder("command-not-run", "command"), requested: [] },
  { label: "ladder: urlCommand printed nothing (the URL on stderr)", run: () => via(undefined, {}, { link: { id: "work", urlFrom: "command", urlCommand: ["pass"] }, opts: { exec: fakeRun({ out: "", err: G }) } }), expect: ladder("command-empty", "command"), requested: [] },
  { label: "ladder: the command runner throws", run: () => via(undefined, {}, { link: { id: "work", urlFrom: "command", urlCommand: ["pass"] }, opts: { exec: async () => { throw new Error(G); } } }), expect: ladder("read-error", "command"), requested: [] },
  {
    label: "ladder: a urlCommand that took the whole deadline leaves none for the fetch",
    run: () => {
      let clock = T0;
      return via(undefined, { [G]: ok() }, {
        link: { id: "work", urlFrom: "command", urlCommand: ["pass"] },
        opts: { startedAt: T0, now: () => clock, exec: async () => { clock += CALENDAR_LINK_DEADLINE_MS; return fakeRun({ out: G })(); } },
      });
    },
    expect: failed("timeout", "deadline"), requested: [],
  },
  { label: "ladder: urlCommand ok, then the fetch", run: () => via(undefined, { [G]: ok() }, { link: { id: "work", urlFrom: "command", urlCommand: ["pass"] }, opts: { exec: fakeRun({ out: `${G}\nlogin: me` }) } }), expect: okResult(), requested: [G] },
];

describe("the matrix: every case ends in its exact outcome, having requested exactly these URLs", () => {
  for (const c of MATRIX) {
    test(c.label, async () => {
      const { outcome, requested } = await c.run();
      expect(summary(outcome)).toEqual(c.expect);
      expect(requested).toEqual(c.requested);
    });
  }

  test("every status the matrix produces is on spec §8's fixed list, and each has its fixed line", async () => {
    const statuses = new Set(MATRIX.map((c) => c.expect.status));
    for (const s of statuses) if (s !== "ok") expect(Object.keys(CALENDAR_STATUS_TEXT)).toContain(s);
    // All eight a link fetch can end in are exercised.
    expect([...statuses].sort()).toEqual(["incomplete", "link-redirected", "link-refused", "malformed", "offline", "ok", "timeout", "too-large"]);
  });
});

// ── the request itself ─────────────────────────────────────────────────────────────────────────────

test("the request: one GET, redirect: manual, an AbortSignal, no headers and no body carrying anything", async () => {
  const requested: string[] = [], inits: RequestInit[] = [];
  const o = await fetchCalendarLink(ENV_LINK, { stateDir: "/nonexistent", env: { CAL_URL: G }, startedAt: Date.now(), budget: linkByteBudget(), fetch: fakeFetch({ [G]: ok() }, requested, inits) });
  expect(o.status).toBe("ok");
  expect(requested).toEqual([G]);
  expect(inits.length).toBe(1);
  const { signal, ...rest } = inits[0]!;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(rest).toEqual({ method: "GET", redirect: "manual" });
  if (o.status === "ok") expect(new TextDecoder().decode(o.body)).toBe(ICS);
});

test("an answer that is not read is released: a refused body and a redirect's body are cancelled", async () => {
  for (const [label, status, headers] of [["404", 404, {}], ["302", 302, { location: gHop(1) }]] as const) {
    const b = body({ chunk: 16 });
    const r = await via(G, { [G]: () => new Response(b.stream, { status, headers }), [gHop(1)]: ok() });
    expect(`${label}: ${r.outcome.status}`).toBe(`${label}: ${status === 404 ? "link-refused" : "ok"}`);
    expect(`${label} cancelled: ${b.stats.cancelled}`).toBe(`${label} cancelled: true`);
  }
});

test("never throws: a fetch that hands back something that is not a Response is an internal failure, and the budget is untouched", async () => {
  const budget = linkByteBudget();
  const r = await via(G, { [G]: () => ({}) as Response }, { opts: { budget } });
  expect(r.outcome).toEqual({ status: "incomplete", reason: "internal" });
  expect(budget.used).toBe(0);
});

test("a chunk that is not bytes is a body error, and never puts NaN into the shared budget", async () => {
  const budget = linkByteBudget();
  const stream = new ReadableStream({ start(c) { c.enqueue("text, not bytes"); c.close(); } });
  const r = await via(G, { [G]: () => ({ status: 200, headers: new Headers(), body: stream }) as unknown as Response }, { opts: { budget } });
  expect(r.outcome).toEqual({ status: "incomplete", reason: "body-error" });
  expect(budget.used).toBe(0);
});

// ── the caps ───────────────────────────────────────────────────────────────────────────────────────

describe("the size caps are STREAMED: reading stops at the first chunk over a cap", () => {
  const CHUNK = 64 * 1024;

  test("the constants are the spec's: 16 MB per link, 32 MB in total, 10 s, 3 redirects", () => {
    expect(CALENDAR_LINK_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(CALENDAR_LINKS_MAX_TOTAL_BYTES).toBe(32 * 1024 * 1024);
    expect(CALENDAR_LINK_DEADLINE_MS).toBe(10_000);
    expect(CALENDAR_LINK_MAX_REDIRECTS).toBe(3);
    expect(linkByteBudget()).toEqual({ limit: 32 * 1024 * 1024, used: 0 });
  });

  test("per link: an endless body is read only to the first chunk over 16 MB, then cancelled; its bytes go back", async () => {
    const b = body({ chunk: CHUNK });
    const budget = linkByteBudget();
    budget.used = 1000;
    const r = await via(G, { [G]: () => new Response(b.stream) }, { opts: { budget } });
    expect(r.outcome).toEqual({ status: "too-large", reason: "link-cap" });
    // 256 chunks fill 16 MB exactly; the 257th crosses it. Never more than one pull past that.
    expect(b.stats.pulls).toBeGreaterThanOrEqual(257);
    expect(b.stats.pulls).toBeLessThanOrEqual(258);
    expect(b.stats.cancelled).toBe(true);
    expect(budget.used).toBe(1000);
  });

  test("per link: exactly 16 MB is accepted, and held against the budget", async () => {
    const b = body({ chunk: CHUNK, chunks: CALENDAR_LINK_MAX_BYTES / CHUNK });
    const budget = linkByteBudget();
    const r = await via(G, { [G]: () => new Response(b.stream) }, { opts: { budget } });
    expect(summary(r.outcome)).toEqual({ status: "ok", redirects: 0, bytes: CALENDAR_LINK_MAX_BYTES });
    expect(budget.used).toBe(CALENDAR_LINK_MAX_BYTES);
  });

  test("per link: a declared content-length over 16 MB is refused without reading a byte", async () => {
    const b = body({ chunk: CHUNK });
    const r = await via(G, { [G]: () => new Response(b.stream, { headers: { "content-length": String(CALENDAR_LINK_MAX_BYTES + 1) } }) });
    expect(r.outcome).toEqual({ status: "too-large", reason: "link-cap" });
    expect(b.stats.pulls).toBe(0);
    expect(b.stats.cancelled).toBe(true);
  });

  test("aggregate: a declared content-length over what the budget has left is refused without reading a byte", async () => {
    // The per-link declared case's twin (M2a checkpoint LOW): the same "refused unread" promise, for the 32 MB
    // total. And the status is `incomplete`, not `too-large` (spec §3: "anything beyond marks the source
    // incomplete") — this link is not over its own cap; the run's total ran out.
    const b = body({ chunk: CHUNK });
    const budget = linkByteBudget();
    budget.used = budget.limit - 10;
    const r = await via(G, { [G]: () => new Response(b.stream, { headers: { "content-length": "11" } }) }, { opts: { budget } });
    expect(r.outcome).toEqual({ status: "incomplete", reason: "total-cap" });
    expect(b.stats.pulls).toBe(0);
    expect(b.stats.cancelled).toBe(true);
    expect(budget.used).toBe(budget.limit - 10);
  });

  test("aggregate: three 12 MB links share 32 MB — the third stops at the limit, is cancelled, and gives its bytes back", async () => {
    const budget = linkByteBudget();
    const chunks = (12 * 1024 * 1024) / CHUNK;
    const bodies = [body({ chunk: CHUNK, chunks }), body({ chunk: CHUNK, chunks }), body({ chunk: CHUNK, chunks })];
    const outcomes: LinkFetchOutcome[] = [];
    for (const b of bodies) outcomes.push((await via(G, { [G]: () => new Response(b.stream) }, { opts: { budget } })).outcome);
    expect(outcomes.map((o) => o.status)).toEqual(["ok", "ok", "incomplete"]);
    expect(outcomes[2]).toEqual({ status: "incomplete", reason: "total-cap" });
    expect(budget.used).toBe(24 * 1024 * 1024);
    // 8 MB was left: 128 chunks fit, the 129th crosses.
    expect(bodies[2]!.stats.pulls).toBeGreaterThanOrEqual(129);
    expect(bodies[2]!.stats.pulls).toBeLessThanOrEqual(130);
    expect(bodies[2]!.stats.cancelled).toBe(true);
  });

  test("aggregate: two links reading AT THE SAME TIME through one budget — exactly one crosses, the other's bytes stay", async () => {
    const budget: LinkByteBudget = linkByteBudget(1_000);
    const run = () => via(G, { [G]: () => new Response(body({ chunk: 100, chunks: 6 }).stream) }, { opts: { budget } });
    const [a, b] = await Promise.all([run(), run()]);
    expect([a.outcome.status, b.outcome.status].sort()).toEqual(["incomplete", "ok"]);
    expect(budget.used).toBe(600);
  });

  test("a link that fails for any reason gives its bytes back: a body error part-way, and a stall cut by the deadline", async () => {
    const budget = linkByteBudget();
    const erroring = body({ chunk: 1024, errorAfter: 5 });
    expect((await via(G, { [G]: () => new Response(erroring.stream) }, { opts: { budget } })).outcome).toEqual({ status: "incomplete", reason: "body-error" });
    expect(budget.used).toBe(0);
    const stalling = body({ chunk: 1024, stallAfter: 5 });
    const r = await via(G, { [G]: () => new Response(stalling.stream) }, { opts: { budget, startedAt: Date.now() - CALENDAR_LINK_DEADLINE_MS + 80 } });
    expect(r.outcome).toEqual({ status: "timeout", reason: "deadline" });
    expect(stalling.stats.cancelled).toBe(true);
    expect(budget.used).toBe(0);
  });
});

// ── the deadline ───────────────────────────────────────────────────────────────────────────────────

describe("the deadline is measured from the caller's start time", () => {
  test("a never-answering fetch with 30 ms left of the caller's ten seconds ends in ~30 ms, and its signal is aborted", async () => {
    const inits: RequestInit[] = [];
    const t = Date.now();
    const o = await fetchCalendarLink(ENV_LINK, {
      stateDir: "/nonexistent", env: { CAL_URL: G }, budget: linkByteBudget(),
      startedAt: T0 - CALENDAR_LINK_DEADLINE_MS + 30, now: () => T0,
      fetch: fakeFetch({ [G]: () => new Promise<Response>(() => {}) }, [], inits),
    });
    expect(o).toEqual({ status: "timeout", reason: "deadline" });
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(inits[0]!.signal!.aborted).toBe(true);
  });

  test("a fetch that ignores the abort and answers late leads to no further request: the next hop is never asked for", async () => {
    const requested: string[] = [];
    const late: Route = () => new Promise<Response>((resolve) => setTimeout(() => resolve(redirect(302, gHop(1))({})), 120));
    const o = await fetchCalendarLink(ENV_LINK, {
      stateDir: "/nonexistent", env: { CAL_URL: G }, budget: linkByteBudget(),
      startedAt: Date.now() - CALENDAR_LINK_DEADLINE_MS + 30, fetch: fakeFetch({ [G]: late, [gHop(1)]: ok() }, requested),
    });
    expect(o).toEqual({ status: "timeout", reason: "deadline" });
    await new Promise((r) => setTimeout(r, 250));   // well past the late answer
    expect(requested).toEqual([G]);
  });

  test("the timer is armed with what is LEFT of the ten seconds, and never more than ten (a future start time is clamped)", async () => {
    const real = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number) => { delays.push(ms ?? 0); return real(fn, ms); }) as typeof setTimeout;
    try {
      const at = (startedAt: number) => fetchCalendarLink(ENV_LINK, {
        stateDir: "/nonexistent", env: { CAL_URL: G }, budget: linkByteBudget(), startedAt, now: () => T0, fetch: fakeFetch({ [G]: ok() }, []),
      });
      expect((await at(T0 - 2_500)).status).toBe("ok");
      expect((await at(T0 + 60_000)).status).toBe("ok");
    } finally {
      globalThis.setTimeout = real;
    }
    expect(delays).toContain(7_500);
    expect(delays).toContain(10_000);
    expect(delays.every((d) => d <= 10_000)).toBe(true);
  });
});

// ── the registrable-domain rule ────────────────────────────────────────────────────────────────────

test("sameRegistrableDomain: conservative, and refuses when unsure", () => {
  const pass: [string, string][] = [
    ["p01-calendars.icloud.com", "p52-calendars.icloud.com"],   // the hop spec §4.2 names
    ["p01-caldav.icloud.com", "www.icloud.com"],
    ["calendar.google.com", "calendar.google.com"],
    ["calendar.google.com", "www.google.com"],
    ["calendar.google.com", "google.com"],
    ["a.example.co.uk", "b.example.co.uk"],                     // a country registry: three labels
    ["cal.example.com.au", "example.com.au"],
    ["cal.example.gouv.fr", "www.example.gouv.fr"],             // a listed registry the heuristic misses
    ["alice.github.io", "alice.github.io"],                     // an identical host always passes
    ["1.2.3.4", "1.2.3.4"],
    ["[::1]", "[::1]"],
    ["intranet", "intranet"],
  ];
  const refuse: [string, string][] = [
    ["calendar.google.com", "evil.example.net"],
    ["calendar.google.com", "calendar.google.com.evil.example.net"],   // a look-alike prefix
    ["calendar.google.com", "google.co"],
    ["outlook.office365.com", "outlook.office.com"],            // one company, two registrable domains: refused (G3 measures)
    ["a.example.co.uk", "evil.co.uk"],                          // the registry itself is not a shared domain
    ["a.example.co.uk", "co.uk"],
    ["example.co.uk", "other.co.uk"],
    ["alice.github.io", "mallory.github.io"],                   // shared hosting: only an identical host
    ["x.s3.amazonaws.com", "y.s3.amazonaws.com"],
    ["cal.ab.io", "www.ab.io"],                                 // unsure (a short name under a country code): refused
    ["1.2.3.4", "1.2.3.5"],                                     // addresses: only an identical one
    ["[::1]", "[::2]"],
    ["icloud.com.", "p01.icloud.com"],                          // a trailing dot: an empty label
    ["intranet", "x.intranet"],                                 // a single label has no registrable domain
    ["a.uk.com", "b.uk.com"],                                   // a listed generic-TLD registry
  ];
  for (const [a, b] of pass) expect(`${a} → ${b}: ${sameRegistrableDomain(a, b)}`).toBe(`${a} → ${b}: true`);
  for (const [a, b] of refuse) expect(`${a} → ${b}: ${sameRegistrableDomain(a, b)}`).toBe(`${a} → ${b}: false`);
  // Case does not matter (URL lower-cases hosts already; the rule does not depend on it).
  expect(sameRegistrableDomain("P01-Calendars.iCloud.com", "p52-calendars.icloud.COM")).toBe(true);
});

test("the two reason families never share a spelling (type-level), so `reason` alone names the stage that failed", () => {
  type Overlap = Extract<LinkUrlReason, LinkTransportReason>;
  const noOverlap: [Overlap] extends [never] ? true : false = true;
  expect(noOverlap).toBe(true);
});

// ── the sentinel sweep ─────────────────────────────────────────────────────────────────────────────

/** Run `fn` with every console method and both process streams captured; returns what was written. */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; written: string }> {
  const chunks: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const saved = methods.map((m) => console[m]);
  const out = process.stdout.write, err = process.stderr.write;
  for (const m of methods) console[m] = (...a: unknown[]) => { chunks.push(a.map(String).join(" ")); };
  process.stdout.write = ((c: unknown) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { chunks.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    return { value: await fn(), written: chunks.join("\n") };
  } finally {
    methods.forEach((m, i) => { console[m] = saved[i]!; });
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

/** The only keys an outcome may carry. A `url`, `location`, `host`, `message` or `error` key is a leak shape
 *  even before its value is read. */
const ALLOWED_KEYS = new Set(["status", "reason", "from", "httpStatus", "body", "redirects"]);

test("URL-LEAK SENTINEL: across the whole matrix the URL reaches no outcome, no throw, and nothing written anywhere", async () => {
  const thrown: string[] = [];
  const { value: runs, written } = await captured(async () => {
    const got: { label: string; run?: Run }[] = [];
    for (const c of MATRIX) {
      try { got.push({ label: c.label, run: await c.run() }); }
      catch (e) { thrown.push(`${c.label}: ${String(e)} ${JSON.stringify(e)}`); got.push({ label: c.label }); }
    }
    return got;
  });

  expect(thrown).toEqual([]);   // never throws — and so no thrown message to leak through
  let carried = 0;
  for (const { label, run } of runs) {
    const o = run!.outcome;
    for (const k of Object.keys(o)) expect(`${label}: key ${k} allowed ${ALLOWED_KEYS.has(k)}`).toBe(`${label}: key ${k} allowed true`);
    // The whole outcome, an `ok` one's body included (decoded), searched for the token.
    const text = o.status === "ok" ? `${JSON.stringify({ ...o, body: undefined })} ${new TextDecoder().decode(o.body)}` : JSON.stringify(o);
    expect(`${label}: ${text}`).not.toContain(TOKEN);
    // Not vacuous: the sentinel really went out — the fake was asked for a URL carrying it.
    if (run!.requested.some((u) => u.includes(TOKEN))) carried++;
  }
  expect(carried).toBeGreaterThanOrEqual(40);
  expect(written).not.toContain(TOKEN);
});
