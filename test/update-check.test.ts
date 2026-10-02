import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// test/update-check.test.ts — Phase E E11: the opt-in, notify-only update check.
//
// ⚠ NO TEST HERE MAY REACH THE NETWORK. Every check runs against an INJECTED fetch, and `globalThis.fetch`
// is replaced for the whole file by a spy that THROWS — so a default path that slipped through would fail
// loudly here (and be counted) rather than quietly reach api.github.com. `afterAll` asserts the spy was
// never called.
//
// The file is organised by the plan's test list (§4 M4, E11 "Tests"):
//   • the request and its answers — 200 newer / same / older, `v`-prefixed and bare tags, 304, timeout,
//     DNS failure, malformed JSON, an HTML error page → the right status, silent, never throws;
//   • never delays delivery — the fetch is called exactly once, AFTER the briefing file and the marker;
//   • posture regression — a failing check AND a `newer` result leave `mergeWarnings`, the posture line,
//     the envelope's `warnings` and stdout/stderr byte-identical to a disabled run;
//   • a `--json` run and a TTY run never fetch; disabled by default → zero calls;
//   • ONLY A DELIVERED RUN CHECKS (Phase E M5b, user-directed 2026-10-01) — a gate skip, an offline /
//     darkwake skip, a provider failure, a parse-empty run and a crash make zero calls.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { buildRepo } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { dispatch, renderUpdateResult, run } from "../src/main";
import { resolveJsonOutPath, statePaths, statusReport, validateCandidate, type RunEnvelope, type SkipReason } from "../src/json";
import { latestBriefingPath, markerPath, archivedBriefingPath, localDateStr, updateCheckPath } from "../src/marker";
import {
  checkForUpdate, compareVersions, isDue, parseVersion, readUpdateCheckState, resolveUpdateCheck,
  DEFAULT_INTERVAL_HOURS, RELEASES_PAGE, UPDATE_CHECK_CONFIG_WARNING, UPDATE_CHECK_URL,
  type FetchLike, type UpdateCheckResult,
} from "../src/updateCheck";
import { mergeWarnings, postureLine, posturePhrase } from "../src/eval/posture";
import { ProviderError, type Provider } from "../src/types";

// ── the network tripwire ────────────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let globalFetchCalls = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    globalFetchCalls++;
    throw new Error("update-check.test.ts: the REAL fetch was reached — every check here must be injected");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  expect(globalFetchCalls).toBe(0);
});

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────

const RELEASE_HTML = "https://github.com/themarigold/daily-briefing/releases/tag/v0.2.0";
type Call = { url: string; init: RequestInit };

/** A fetch stand-in that records every call and answers with `respond`. */
function fakeFetch(respond: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond({ url, init }, calls.length);
  };
  return { fn, calls };
}

const release = (tag: string, etag = '"abc123"', htmlUrl: string = RELEASE_HTML) =>
  new Response(JSON.stringify({ tag_name: tag, html_url: htmlUrl, name: `Release ${tag}`, assets: [] }), {
    status: 200, headers: { "content-type": "application/json", etag },
  });

function scratchState(): { dir: string; path: string } {
  const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-e11-uc-")));
  return { dir, path: join(dir, "update-check.json") };
}

/** Capture EVERY console and stream write for the duration of `fn`. */
async function silently<T>(fn: () => Promise<T>): Promise<{ value: T; printed: string[] }> {
  const printed: string[] = [];
  const o = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  const ow = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  const sink = (...a: unknown[]) => { printed.push(a.map(String).join(" ")); };
  console.log = sink; console.error = sink; console.warn = sink; console.info = sink; console.debug = sink;
  process.stdout.write = ((c: unknown) => { printed.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { printed.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    return { value: await fn(), printed };
  } finally {
    Object.assign(console, o);
    process.stdout.write = ow.out as typeof process.stdout.write;
    process.stderr.write = ow.err as typeof process.stderr.write;
  }
}

const V = "0.1.1";   // the "running" version the unit tests pin, independent of package.json

// ── versions ────────────────────────────────────────────────────────────────────────────────────

describe("version comparison (appendix T11: strip a leading v, compare numeric major.minor.patch)", () => {
  test("newer / same / older, with and without the v", () => {
    const table: [string, string, string][] = [
      ["0.1.1", "v0.2.0", "newer"], ["0.1.1", "0.2.0", "newer"], ["0.1.1", "v0.1.2", "newer"],
      ["0.1.1", "v1.0.0", "newer"], ["0.9.9", "0.10.0", "newer"],   // numeric, not lexicographic
      ["0.1.1", "v0.1.1", "up-to-date"], ["0.1.1", "0.1.1", "up-to-date"],
      ["0.2.0", "v0.1.9", "up-to-date"], ["1.0.0", "0.99.99", "up-to-date"],
      ["0.2.0", "v0.2.0-rc.1", "up-to-date"],  // a pre-release tail never makes a version newer
      ["0.1.1", "latest", "unknown"], ["0.1.1", "v0.2", "unknown"], ["0.1.1", "", "unknown"],
      ["0.1.1", "v0.2.0 ; rm -rf /", "unknown"], ["0.1.1", "\u001b[31m0.2.0", "unknown"],
      ["not-a-version", "0.2.0", "unknown"],
    ];
    for (const [cur, latest, want] of table) expect(`${cur} vs ${latest} → ${compareVersions(cur, latest)}`).toBe(`${cur} vs ${latest} → ${want}`);
  });

  test("parseVersion is bounded — a long or oversized tag is not a version", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion(`v1.2.3-${"a".repeat(80)}`)).toBeUndefined();
    expect(parseVersion("1234567890.0.0")).toBeUndefined();
  });

  test("package.json's own version parses — the running side of every comparison", () => {
    expect(parseVersion(pkg.version)).toBeDefined();
  });
});

// ── config ──────────────────────────────────────────────────────────────────────────────────────

describe("resolveUpdateCheck — B1 style: OFF by default, OFF (with a warning) on any malformed value, never throws", () => {
  test("absent / null is OFF with no warning; the default interval is 24 h", () => {
    for (const raw of [undefined, null]) expect(resolveUpdateCheck(raw)).toEqual({ enabled: false, intervalHours: 24 });
    expect(DEFAULT_INTERVAL_HOURS).toBe(24);
  });

  test("well-formed values resolve, boundaries included", () => {
    expect(resolveUpdateCheck({})).toEqual({ enabled: false, intervalHours: 24 });
    expect(resolveUpdateCheck({ enabled: false })).toEqual({ enabled: false, intervalHours: 24 });
    expect(resolveUpdateCheck({ enabled: true })).toEqual({ enabled: true, intervalHours: 24 });
    expect(resolveUpdateCheck({ enabled: true, intervalHours: 1 })).toEqual({ enabled: true, intervalHours: 1 });
    expect(resolveUpdateCheck({ enabled: true, intervalHours: 720 })).toEqual({ enabled: true, intervalHours: 720 });
  });

  test("every malformed shape is OFF with the fixed warning — the failure direction is never ON", () => {
    const accessor = Object.defineProperty({}, "enabled", { get: () => true, enumerable: true });
    const bad: unknown[] = [
      true, "yes", 1, [], [{ enabled: true }],
      { enabled: "true" }, { enabled: 1 }, { enabled: true, intervalHours: 0 }, { enabled: true, intervalHours: 721 },
      { enabled: true, intervalHours: 1.5 }, { enabled: true, intervalHours: "24" }, { enabled: true, intervalHours: Number.NaN },
      { enable: true }, { enabled: true, extra: 1 },   // a typo'd or unknown sibling key is invisible state
      accessor,
      new Proxy({}, { ownKeys() { throw new Error("hostile"); } }),
    ];
    for (const raw of bad) {
      const r = resolveUpdateCheck(raw);
      const label = (() => { try { return String(JSON.stringify(raw)); } catch { return "a hostile Proxy"; } })();
      expect({ raw: label, enabled: r.enabled, warning: r.warning }).toEqual({ raw: label, enabled: false, warning: UPDATE_CHECK_CONFIG_WARNING });
    }
  });

  test("`config validate --json` reports a malformed block as a WARNING on `updateCheck` and stays valid", () => {
    const base = { provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } };
    const bad = validateCandidate({ ...base, updateCheck: { enabled: "yes", intervalHours: 9999 } });
    expect(bad.valid).toBe(true);
    expect(bad.warnings).toEqual([{ field: "updateCheck", message: UPDATE_CHECK_CONFIG_WARNING }]);
    // FIXED TEXT: the configured value is never echoed back.
    expect(JSON.stringify(bad.warnings)).not.toContain("9999");
    const good = validateCandidate({ ...base, updateCheck: { enabled: true, intervalHours: 6 } });
    expect(good.warnings.filter((w) => w.field === "updateCheck")).toEqual([]);
    expect(good.normalized?.updateCheck).toEqual({ enabled: true, intervalHours: 6 });
  });
});

describe("isDue", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const at = (iso: string) => ({ status: "up-to-date" as const, current: V, checkedAt: iso });
  test("absent, unreadable, old enough, or in the future ⇒ due; fresher than the interval less the slack ⇒ not", () => {
    expect(isDue(undefined, 24, now)).toBe(true);
    expect(isDue(at("garbage"), 24, now)).toBe(true);
    expect(isDue(at("2026-09-30T12:00:00Z"), 24, now)).toBe(true);      // exactly 24 h
    expect(isDue(at("2026-09-30T13:00:00Z"), 24, now)).toBe(true);      // exactly 23 h: the slack's edge
    expect(isDue(at("2026-09-30T13:00:01Z"), 24, now)).toBe(false);     // 1 s inside it
    expect(isDue(at("2026-10-01T10:59:59Z"), 1, now)).toBe(true);
    expect(isDue(at("2026-10-01T11:30:00Z"), 1, now)).toBe(true);       // 1 h interval: the slack is HALF of it, 30 min
    expect(isDue(at("2026-10-01T11:30:01Z"), 1, now)).toBe(false);      // so 29m59s is still too fresh
    expect(isDue(at("2026-10-02T12:00:00Z"), 24, now)).toBe(true);      // a future stamp cannot silence it
  });

  test("the daily cadence: a tick a minute EARLIER than yesterday's is due; one two hours earlier is not (D1)", () => {
    // Without the slack, a scheduled run that delivered at 08:00:00 yesterday and at 07:59:00 today found
    // the record 23h59m old, not due — and the default daily check fired every OTHER day.
    expect(isDue(at("2026-09-30T12:01:00Z"), DEFAULT_INTERVAL_HOURS, now)).toBe(true);    // 23h59m old
    expect(isDue(at("2026-09-30T14:00:00Z"), DEFAULT_INTERVAL_HOURS, now)).toBe(false);   // 22h old
    expect(DEFAULT_INTERVAL_HOURS).toBe(24);
  });
});

// ── the request and its answers ─────────────────────────────────────────────────────────────────

describe("checkForUpdate: one request, every answer mapped, silent, never throws", () => {
  test("the request is exactly the documented one: GET, no query, Accept + User-Agent and nothing else", async () => {
    const { path } = scratchState();
    const f = fakeFetch(() => release("v0.2.0"));
    await checkForUpdate({ fetch: f.fn, path, version: V });
    expect(f.calls.length).toBe(1);
    const call = f.calls[0]!;
    expect(call.url).toBe(UPDATE_CHECK_URL);
    expect(call.url).toBe("https://api.github.com/repos/themarigold/daily-briefing/releases/latest");
    expect(new URL(call.url).search).toBe("");
    expect(call.init.method).toBe("GET");
    expect(call.init.headers).toEqual({ Accept: "application/vnd.github+json", "User-Agent": `daily-briefing/${V}` });
    expect(call.init.body).toBeUndefined();
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    // A redirect is refused, never followed: under fetch's default `"follow"` it would re-send these
    // headers to whatever host the Location named (see the redirect test below).
    expect(call.init.redirect).toBe("error");
    expect(Object.keys(call.init).sort()).toEqual(["headers", "method", "redirect", "signal"]);
  });

  test("a redirect is never followed: it is the ordinary `unknown` — exit 0, the usual output and nothing else, no other host reached", async () => {
    // A stand-in with bun's REAL redirect semantics, measured against a localhost 302 on bun 1.3.14:
    // the default (`"follow"`) re-sends the request — User-Agent included — to the Location's host and
    // returns THAT host's answer; `redirect: "error"` rejects with an Error whose code is
    // `UnexpectedRedirect`. So the old request shape is red here (a foreign `newer`), not just untested.
    const followed: Call[] = [];
    const redirecting: FetchLike = async (url, init) => {
      if ((init.redirect ?? "follow") === "error") {
        throw Object.assign(new Error(`UnexpectedRedirect fetching "${url}".`), { code: "UnexpectedRedirect" });
      }
      followed.push({ url: "https://elsewhere.example/latest", init });
      return release("v99.0.0", '"elsewhere"', "https://elsewhere.example/download");
    };
    for (const json of [false, true]) {
      const { path } = scratchState();
      const c = capture();
      let code: number;
      try {
        code = await dispatch(["bun", "bin", "update", "--check", ...(json ? ["--json"] : [])],
          { updateCheck: () => checkForUpdate({ fetch: redirecting, path }) });
      } finally { c.restore(); }
      expect(code).toBe(0);
      expect(c.err).toEqual([]);
      expect(c.out.length).toBe(1);
      const printed = json ? (JSON.parse(c.out[0]!) as UpdateCheckResult) : undefined;
      if (printed) expect([printed.status, printed.current, "latest" in printed, "url" in printed]).toEqual(["unknown", pkg.version, false, false]);
      else expect(c.out).toEqual([renderUpdateResult({ status: "unknown", current: pkg.version, checkedAt: "x" })]);
      // The record says the same, and caches nothing to replay.
      const onDisk = await readUpdateCheckState(path);
      expect([onDisk?.status, onDisk?.etag]).toEqual(["unknown", undefined]);
    }
    expect(followed).toEqual([]);
  });

  test("200 newer (v-prefixed tag): `newer`, the version without its v, the release page; the ETag is stored, never returned", async () => {
    const { path } = scratchState();
    const f = fakeFetch(() => release("v0.2.0", '"etag-1"'));
    const now = new Date("2026-10-01T08:00:00Z");
    const { value: r, printed } = await silently(() => checkForUpdate({ fetch: f.fn, path, version: V, now: () => now }));
    expect(r).toEqual({ status: "newer", current: V, latest: "0.2.0", url: RELEASE_HTML, checkedAt: now.toISOString() });
    expect("etag" in r).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...r, etag: '"etag-1"' });
    expect(printed).toEqual([]);
  });

  test("200 same / older / unprefixed: `up-to-date`", async () => {
    for (const [tag, latest] of [["v0.1.1", "0.1.1"], ["0.1.1", "0.1.1"], ["v0.1.0", "0.1.0"], ["0.0.9", "0.0.9"]] as const) {
      const { path } = scratchState();
      const r = await checkForUpdate({ fetch: fakeFetch(() => release(tag)).fn, path, version: V });
      expect(`${tag} → ${r.status} ${r.latest}`).toBe(`${tag} → up-to-date ${latest}`);
    }
    const { path } = scratchState();
    const bare = await checkForUpdate({ fetch: fakeFetch(() => release("0.3.0")).fn, path, version: V });
    expect([bare.status, bare.latest]).toEqual(["newer", "0.3.0"]);
  });

  test("304: the ETag is replayed as If-None-Match and the answer comes from the cached release", async () => {
    const { path } = scratchState();
    await checkForUpdate({ fetch: fakeFetch(() => release("v0.2.0", '"etag-304"')).fn, path, version: V });
    const f = fakeFetch(() => new Response(null, { status: 304 }));
    const r = await checkForUpdate({ fetch: f.fn, path, version: V });
    expect((f.calls[0]!.init.headers as Record<string, string>)["If-None-Match"]).toBe('"etag-304"');
    expect([r.status, r.latest, r.url]).toEqual(["newer", "0.2.0", RELEASE_HTML]);
    // The cache survives a 304, so the next one still validates…
    expect(JSON.parse(readFileSync(path, "utf8")).etag).toBe('"etag-304"');
    // …and is re-compared against the RUNNING version: after an upgrade the same cached release is up to date.
    const after = await checkForUpdate({ fetch: fakeFetch(() => new Response(null, { status: 304 })).fn, path, version: "0.2.0" });
    expect(after.status).toBe("up-to-date");
  });

  test("a 304 with nothing cached cannot be answered from nothing: `unknown`, and no If-None-Match was sent", async () => {
    const { path } = scratchState();
    const f = fakeFetch(() => new Response(null, { status: 304 }));
    const r = await checkForUpdate({ fetch: f.fn, path, version: V });
    expect(r.status).toBe("unknown");
    expect(f.calls[0]!.init.headers).not.toHaveProperty("If-None-Match");
  });

  test("timeout: a fetch that never settles is answered `unknown` within the cap", async () => {
    const { path } = scratchState();
    let aborted = false;
    const f: FetchLike = (_u, init) => new Promise(() => { init.signal?.addEventListener("abort", () => { aborted = true; }); });
    const t0 = Date.now();
    const { value: r, printed } = await silently(() => checkForUpdate({ fetch: f, path, version: V, timeoutMs: 60 }));
    expect(r.status).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(aborted).toBe(true);                       // the request itself was cancelled, not just abandoned
    expect(printed).toEqual([]);
  });

  test("DNS failure / refused connection / malformed JSON / an HTML error page / a bad tag: `unknown`, silent, never throws", async () => {
    const cases: [string, FetchLike][] = [
      ["dns", async () => { throw Object.assign(new TypeError("fetch failed"), { code: "ENOTFOUND" }); }],
      ["refused", async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); }],
      ["malformed json", async () => new Response("{\"tag_name\": \"v0.2.0\"", { status: 200 })],
      ["html 200", async () => new Response("<html><body>Unicorn!</body></html>", { status: 200, headers: { "content-type": "text/html" } })],
      ["html 503", async () => new Response("<html>503</html>", { status: 503, headers: { "content-type": "text/html" } })],
      ["404 (no release yet)", async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })],
      ["403 (rate limited)", async () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 })],
      ["no tag", async () => new Response(JSON.stringify({ name: "x" }), { status: 200 })],
      ["junk tag", async () => release("nightly-build")],
      ["null body", async () => new Response("null", { status: 200 })],
    ];
    for (const [name, fn] of cases) {
      const { path } = scratchState();
      const { value: r, printed } = await silently(() => checkForUpdate({ fetch: fn, path, version: V }));
      expect(`${name}: ${r.status} ${r.latest ?? "-"} ${r.url ?? "-"} printed=${printed.length}`).toBe(`${name}: unknown - - printed=0`);
      // A failure leaves no cache behind to validate against.
      expect(`${name}: ${"etag" in JSON.parse(readFileSync(path, "utf8"))}`).toBe(`${name}: false`);
    }
  });

  test("a foreign html_url is replaced by this project's releases page, never relayed", async () => {
    const { path } = scratchState();
    const r = await checkForUpdate({ fetch: fakeFetch(() => release("v0.2.0", '"e"', "https://evil.example/download")).fn, path, version: V });
    expect(r.url).toBe(RELEASES_PAGE);
  });

  test("a 304 never replays a record the 200 path would not have written: a bad url / latest / etag is NO record (D3)", async () => {
    const good = { status: "newer", current: V, latest: "0.2.0", url: RELEASE_HTML, checkedAt: "2026-10-01T08:00:00.000Z", etag: '"e-good"' };
    // CONTRAST first: a well-formed hand-written record IS replayed — so the refusals below are the
    // validation's doing, not a reader that ignores hand-written files.
    {
      const { path } = scratchState();
      writeFileSync(path, JSON.stringify(good));
      const f = fakeFetch(() => new Response(null, { status: 304 }));
      const r = await checkForUpdate({ fetch: f.fn, path, version: V });
      expect((f.calls[0]!.init.headers as Record<string, string>)["If-None-Match"]).toBe('"e-good"');
      expect([r.status, r.latest, r.url]).toEqual(["newer", "0.2.0", RELEASE_HTML]);
    }
    const bad: [string, Record<string, unknown>][] = [
      ["a foreign url", { url: "https://evil.example/download" }],
      ["a url with a control byte", { url: `${RELEASE_HTML}\u001b[2J` }],
      ["a url over 256 chars", { url: `${RELEASE_HTML}/${"a".repeat(260)}` }],
      ["a non-version latest", { latest: "nightly" }],
      ["a latest carrying an escape", { latest: "0.2.0\u001b[31m" }],
      ["a latest that is not a string", { latest: 2 }],
      ["an unusable etag", { etag: '"e"\r\nX-Injected: 1' }],
    ];
    for (const [name, override] of bad) {
      const { path } = scratchState();
      writeFileSync(path, JSON.stringify({ ...good, ...override }));
      expect(`${name}: ${JSON.stringify(await readUpdateCheckState(path))}`).toBe(`${name}: undefined`);
      const f = fakeFetch(() => new Response(null, { status: 304 }));
      const r = await checkForUpdate({ fetch: f.fn, path, version: V });
      // Nothing cached ⇒ no If-None-Match, and a 304 cannot be answered from nothing.
      expect(`${name}: ${"If-None-Match" in (f.calls[0]!.init.headers as Record<string, string>)}`).toBe(`${name}: false`);
      expect(`${name}: ${r.status} ${r.latest ?? "-"} ${r.url ?? "-"}`).toBe(`${name}: unknown - -`);
    }
  });

  test("the release body is read through a 64 KiB cap: a larger answer, declared or streamed, is `unknown` (C4)", async () => {
    const { MAX_RELEASE_BODY_BYTES } = await import("../src/updateCheck");
    expect(MAX_RELEASE_BODY_BYTES).toBe(64 * 1024);
    const json = (pad: number) => JSON.stringify({ tag_name: "v0.2.0", html_url: RELEASE_HTML, pad: "x".repeat(pad) });
    // CONTRAST: a valid release just under the cap still answers.
    {
      const { path } = scratchState();
      const body = json(MAX_RELEASE_BODY_BYTES - 200);
      expect(body.length).toBeLessThanOrEqual(MAX_RELEASE_BODY_BYTES);
      const r = await checkForUpdate({ fetch: async () => new Response(body, { status: 200 }), path, version: V });
      expect([r.status, r.latest]).toEqual(["newer", "0.2.0"]);
    }
    // A DECLARED length over the cap is refused before a byte is read — even though the body itself
    // (small, valid) would have parsed as `newer`. `highWaterMark: 0` (round-3 harden G3-6): the default
    // strategy PRE-PULLS one chunk on construction (measured in Bun), so a `pulled <= 1` bound could not
    // tell "never read" from "read the first chunk"; with no pre-pull, any read at all shows as a pull.
    {
      const { path } = scratchState();
      let pulled = 0;
      const small = new TextEncoder().encode(json(0));
      const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(small); c.close(); } }, { highWaterMark: 0 });
      const res = new Response(stream, { status: 200, headers: { "content-length": String(MAX_RELEASE_BODY_BYTES + 1) } });
      const r = await checkForUpdate({ fetch: async () => res, path, version: V });
      expect(r.status).toBe("unknown");
      expect(pulled).toBe(0);
    }
    // …and a body that really IS oversized, with its length declared: refused up front too, unread.
    {
      const { path } = scratchState();
      let pulled = 0;
      const whole = new TextEncoder().encode(json(2 * MAX_RELEASE_BODY_BYTES));
      const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(whole); c.close(); } }, { highWaterMark: 0 });
      const res = new Response(stream, { status: 200, headers: { "content-length": String(whole.length) } });
      const r = await checkForUpdate({ fetch: async () => res, path, version: V });
      expect(r.status).toBe("unknown");
      expect(pulled).toBe(0);
    }
    // NO declared length, a valid JSON body that streams past the cap: refused once the count passes it,
    // and the stream is not drained to its end.
    {
      const { path } = scratchState();
      const whole = new TextEncoder().encode(json(4 * MAX_RELEASE_BODY_BYTES));
      const CHUNK = 4096;
      let served = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (served >= whole.length) { c.close(); return; }
          c.enqueue(whole.subarray(served, served + CHUNK));
          served += CHUNK;
        },
      });
      const res = new Response(stream, { status: 200 });
      expect(res.headers.get("content-length")).toBeNull();     // PREMISE: the length really is absent
      const r = await checkForUpdate({ fetch: async () => res, path, version: V });
      expect(r.status).toBe("unknown");
      expect(served).toBeLessThan(whole.length);                 // stopped early, never buffered the whole answer
      expect(served).toBeLessThanOrEqual(MAX_RELEASE_BODY_BYTES + 4 * CHUNK);
    }
  });

  test("an unwritable state path still answers — the record is lost, the check is not", async () => {
    const { dir } = scratchState();
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const r = await checkForUpdate({ fetch: fakeFetch(() => release("v0.2.0")).fn, path: join(blocker, "update-check.json"), version: V });
    expect(r.status).toBe("newer");
  });

  test("concurrent writers leave ONE complete, valid result (temp file + rename)", async () => {
    const { dir, path } = scratchState();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      checkForUpdate({ fetch: fakeFetch(() => release(i % 2 ? "v0.2.0" : "v0.1.1")).fn, path, version: V })));
    const onDisk = await readUpdateCheckState(path);
    expect(onDisk).toBeDefined();
    const { etag: _e, ...pub } = onDisk!;
    expect(results).toContainEqual(pub);
    // …and no temp file is left behind.
    expect(readdirSync(dir)).toEqual(["update-check.json"]);
  });
});

// ── the manual command ──────────────────────────────────────────────────────────────────────────

/** Capture what a command or a run writes, until `restore()`: `console.log` / `info` / `debug` → `out`,
 *  `console.error` / `warn` → `err`, AND the raw `process.stdout.write` / `process.stderr.write` under
 *  them — the same breadth `silently()` gives the unit tests, so a leak through a direct stream write
 *  lands in the run's captured stdout/stderr (and fails the byte comparisons below) instead of escaping
 *  to the runner's own output. On bun the console does not route through the stream `write`s
 *  (`src/diag.ts:16-18`), so nothing is captured twice. */
function capture() {
  const out: string[] = [], err: string[] = [];
  const o = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  const ow = { out: process.stdout.write, err: process.stderr.write };
  const lineTo = (sink: string[]) => (...a: unknown[]) => { sink.push(a.map(String).join(" ")); };
  const chunk = (c: unknown) => (typeof c === "string" ? c : c instanceof Uint8Array ? new TextDecoder().decode(c) : String(c));
  console.log = lineTo(out); console.info = lineTo(out); console.debug = lineTo(out);
  console.error = lineTo(err); console.warn = lineTo(err);
  process.stdout.write = ((c: unknown) => { out.push(chunk(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { err.push(chunk(c)); return true; }) as typeof process.stderr.write;
  return {
    out, err,
    restore: () => {
      Object.assign(console, o);
      process.stdout.write = ow.out;
      process.stderr.write = ow.err;
    },
  };
}

describe("`daily-briefing update --check [--json]`", () => {
  test("--json prints the result object (no etag) and exits 0 — for newer, up-to-date AND unknown", async () => {
    for (const [fn, status] of [
      [fakeFetch(() => release("v99.0.0")).fn, "newer"],
      [fakeFetch(() => release(`v${pkg.version}`)).fn, "up-to-date"],
      [(async () => { throw new TypeError("fetch failed"); }) as FetchLike, "unknown"],
    ] as const) {
      const { path } = scratchState();
      const c = capture();
      let code: number;
      try { code = await dispatch(["bun", "bin", "update", "--check", "--json"], { updateCheck: () => checkForUpdate({ fetch: fn, path }) }); }
      finally { c.restore(); }
      expect(code).toBe(0);
      expect(c.out.length).toBe(1);
      const printed = JSON.parse(c.out[0]!) as UpdateCheckResult;
      expect(printed.status).toBe(status);
      expect(printed.current).toBe(pkg.version);
      expect("etag" in printed).toBe(false);
      expect(c.err).toEqual([]);
    }
  });

  test("the text form says up to date, or the new version and its URL, or that the check could not complete", () => {
    expect(renderUpdateResult({ status: "up-to-date", current: "0.2.0", latest: "0.2.0", checkedAt: "x" })).toBe("up to date — you have 0.2.0");
    expect(renderUpdateResult({ status: "newer", current: "0.1.1", latest: "0.2.0", url: RELEASE_HTML, checkedAt: "x" }))
      .toBe(`a newer version is available: 0.2.0 (you have 0.1.1) — ${RELEASE_HTML}`);
    expect(renderUpdateResult({ status: "unknown", current: "0.1.1", checkedAt: "x" })).toContain("could not check for updates");
  });

  test("a bare `update`, another verb, a stray flag, or `--json update` exits 2 and never checks", async () => {
    let checks = 0;
    const deps = { updateCheck: async () => { checks++; return { status: "unknown" as const, current: "x", checkedAt: "x" }; }, run: (async () => { throw new Error("run reached"); }) as never };
    for (const argv of [["update"], ["update", "--json"], ["update", "now"], ["update", "--check", "--json-out", "x.json"],
                        ["update", "--check", "--check"], ["update", "--check", "--json", "--json"], ["update", "--check", "--force"],
                        ["--json", "update", "--check"], ["run", "update"]]) {
      const c = capture();
      let code: number;
      try { code = await dispatch(["bun", "bin", ...argv], deps); } finally { c.restore(); }
      expect(`${argv.join(" ")} → ${code}`).toBe(`${argv.join(" ")} → 2`);
    }
    expect(checks).toBe(0);
  });
});

// ── the state surfaces ──────────────────────────────────────────────────────────────────────────

function withEnv(cfgObj: unknown): { stateDir: string; cfgPath: string; cleanup: () => void } {
  const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-e11-cfg-")));
  const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-e11-state-")));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  const cfgPath = join(cfgHome, "daily-briefing", "config.json");
  writeFileSync(cfgPath, JSON.stringify(cfgObj));
  const prevXdg = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  return {
    stateDir, cfgPath,
    cleanup: () => {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
    },
  };
}

const PROV = { cli: "claude", argv: ["-p"], promptVia: "stdin" as const };

describe("the state file is the engine's: status --json reads it (no network), --json-out cannot target it", () => {
  test("status --json: null before any check, the public result (no etag) after one, null when corrupt", async () => {
    const env = withEnv({ provider: PROV });
    try {
      expect(statePaths().updateCheckPath).toBe(join(env.stateDir, "update-check.json"));
      expect(updateCheckPath()).toBe(statePaths().updateCheckPath);
      expect((await statusReport()).updateCheck).toBeNull();
      const r = await checkForUpdate({ fetch: fakeFetch(() => release("v0.2.0", '"tag"')).fn, version: V });
      expect(existsSync(updateCheckPath())).toBe(true);      // the DEFAULT path is the state dir's
      const s = await statusReport();
      expect(s.updateCheck).toEqual(r);
      expect(JSON.stringify(s)).not.toContain('"tag"');
      writeFileSync(updateCheckPath(), "{ not json");
      expect((await statusReport()).updateCheck).toBeNull();
    } finally { env.cleanup(); }
  });

  test("--json-out naming update-check.json is refused, relative and absolute", () => {
    const env = withEnv({ provider: PROV });
    try {
      for (const target of ["update-check.json", statePaths().updateCheckPath]) {
        expect(() => resolveJsonOutPath(target)).toThrow("is the engine's update-check record");
      }
    } finally { env.cleanup(); }
  });
});

// ── the automatic path, through a real run() ────────────────────────────────────────────────────

const MODEL_OUT = "## RESUME\n- [r] resume here\n## RECAP\n- [r] did x | evidence: abc123\n## SUGGESTIONS\n- do y";
const AFTER_FLOOR = () => new Date(2026, 6, 16, 9, 0);
const NET = { now: AFTER_FLOOR, netProbe: async () => true, netGraceMs: 30, netPollMs: 10, retryDelaysMs: [], sleep: async () => {} };
const yesterdayISO = () => new Date(Date.now() - 864e5).toISOString();
const STUB: Provider = { async generate() { return MODEL_OUT; } };

type RunCapture = { code: number; stdout: string; stderr: string; envelope: RunEnvelope };

/** One forced run with `--json-out` (so the envelope is readable) — NOT `--json`, so it is the shape of
 *  the scheduled tick, the only shape the automatic path runs on. */
async function oneRun(sidecar: string, extra: Record<string, unknown> = {}, out: { json?: boolean } = {}): Promise<RunCapture> {
  const c = capture();
  let code: number;
  try {
    code = await run(true, { ...NET, provider: STUB, ...extra }, { jsonOut: sidecar, ...out });
  } finally { c.restore(); }
  return { code, stdout: c.out.join("\n"), stderr: c.err.join("\n"), envelope: JSON.parse(readFileSync(sidecar, "utf8")) as RunEnvelope };
}

describe("the automatic path: only on a non-TTY, non---json run that DELIVERED; disabled by default", () => {
  test("disabled by default: no `updateCheck` key ⇒ ZERO network calls (the global spy included) and no state file", async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    for (const cfg of [{}, { updateCheck: { enabled: false } }, { updateCheck: { intervalHours: 1 } }, { updateCheck: { enabled: "true" } }]) {
      const env = withEnv({ provider: PROV, networkProbeHosts: [], excludeCommitPatterns: [], repos: [repo], ...cfg });
      try {
        const before = globalFetchCalls;
        // No injected fetch at all: the DEFAULT path, which would reach the global spy.
        const r = await oneRun(join(env.stateDir, "env.json"));
        expect(r.code).toBe(0);
        expect(globalFetchCalls - before).toBe(0);
        expect(existsSync(updateCheckPath())).toBe(false);
        // NON-VACUITY: the state dir IS writable — the run stamped the day in it — so the absent record
        // above is the gate's doing, not an unwritable directory's.
        expect(existsSync(markerPath())).toBe(true);
      } finally { env.cleanup(); }
    }
  });

  test("a --json run and a TTY run never call fetch, even enabled and due", async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    const env = withEnv({ provider: PROV, networkProbeHosts: [], excludeCommitPatterns: [], repos: [repo], updateCheck: { enabled: true } });
    try {
      const f = fakeFetch(() => release("v99.0.0"));
      const sidecar = join(env.stateDir, "env.json");
      await oneRun(sidecar, { updateCheck: { fetch: f.fn } }, { json: true });
      await oneRun(sidecar, { updateCheck: { fetch: f.fn }, interactive: true });
      expect(f.calls.length).toBe(0);
      expect(existsSync(updateCheckPath())).toBe(false);
      // PREMISE: the same config on the scheduled shape DOES check — so the two zeros above are the gates.
      await oneRun(sidecar, { updateCheck: { fetch: f.fn } });
      expect(f.calls.length).toBe(1);
    } finally { env.cleanup(); }
  });

  test("never delays delivery: fetch is called EXACTLY once, after the briefing file, the archive, the marker and the envelope are written, with the run lock released", async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    const env = withEnv({ provider: PROV, networkProbeHosts: [], excludeCommitPatterns: [], repos: [repo], updateCheck: { enabled: true } });
    try {
      const sidecar = join(env.stateDir, "env.json");
      const seen: Record<string, boolean | string>[] = [];
      const f = fakeFetch(() => {
        const today = localDateStr(new Date());
        seen.push({
          briefing: existsSync(latestBriefingPath()),
          archive: existsSync(archivedBriefingPath(today)),
          marker: existsSync(markerPath()) ? readFileSync(markerPath(), "utf8").trim() : "",
          envelope: existsSync(sidecar),
          lock: existsSync(statePaths().runLockPath),
        });
        return release("v99.0.0");
      });
      const r = await oneRun(sidecar, { updateCheck: { fetch: f.fn } });
      expect(r.code).toBe(0);
      expect(f.calls.length).toBe(1);
      expect(seen).toEqual([{ briefing: true, archive: true, marker: localDateStr(new Date()), envelope: true, lock: false }]);
      // …and its answer landed in the state file, and only there.
      expect((await readUpdateCheckState())?.status).toBe("newer");
    } finally { env.cleanup(); }
  });

  test("most ticks stop at the state-file read: a fresh record means no request; an old one means one", async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    const env = withEnv({ provider: PROV, networkProbeHosts: [], excludeCommitPatterns: [], repos: [repo], updateCheck: { enabled: true, intervalHours: 6 } });
    try {
      const sidecar = join(env.stateDir, "env.json");
      const f = fakeFetch(() => release("v99.0.0"));
      const t = new Date("2026-10-01T06:00:00Z");
      await oneRun(sidecar, { updateCheck: { fetch: f.fn, now: () => t } });
      expect(f.calls.length).toBe(1);
      await oneRun(sidecar, { updateCheck: { fetch: f.fn, now: () => new Date(t.getTime() + 4 * 3_600_000) } });
      expect(f.calls.length).toBe(1);                           // 4 h < 6 h less the 1 h slack: not due
      await oneRun(sidecar, { updateCheck: { fetch: f.fn, now: () => new Date(t.getTime() + 6 * 3_600_000) } });
      expect(f.calls.length).toBe(2);                           // 6 h: due
    } finally { env.cleanup(); }
  });

  // ⚠ INVERTED in Phase E M5b, by the USER'S DECISION (2026-10-01): "the automatic update check runs
  // ONLY right after a DELIVERED briefing". Until then this test pinned the opposite — "a gate-skip tick
  // (already ran today) still runs a due check" — which was M4's as-built behaviour. It is not a
  // loosening: the assertion is as strict as before, on the other side of the decision.
  test("a gate-skip tick (already ran today) does NOT check — even enabled and due, and even though it exits 0", async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    const env = withEnv({ provider: PROV, networkProbeHosts: [], excludeCommitPatterns: [], repos: [repo], updateCheck: { enabled: true } });
    try {
      writeFileSync(markerPath(), localDateStr(new Date()));
      const f = fakeFetch(() => release("v99.0.0"));
      const c = capture();
      let code: number;
      try { code = await run(false, { ...NET, provider: STUB, updateCheck: { fetch: f.fn } }); } finally { c.restore(); }
      expect(code).toBe(0);                                     // exit 0 — so exit 0 is not what gates the check
      expect(f.calls.length).toBe(0);
      expect(existsSync(updateCheckPath())).toBe(false);
      // NON-VACUITY: the tick really was the gate skip (its record is written) and printed nothing.
      expect(JSON.parse(readFileSync(statePaths().lastSkipPath, "utf8")).reason).toBe("already-ran");
      expect([c.out, c.err]).toEqual([[], []]);
      // PREMISE: the same config, with the check still due, DOES check on a run that delivers.
      await oneRun(join(env.stateDir, "env.json"), { updateCheck: { fetch: f.fn } });
      expect(f.calls.length).toBe(1);
    } finally { env.cleanup(); }
  });

  test("no run that did not deliver ever checks — every skip, every failure, a crash — and the envelope says why", async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    const BEFORE_FLOOR = () => new Date(2026, 6, 16, 5, 0);
    const linux = { powerPlatform: "linux" as NodeJS.Platform };
    const asleep = { powerPlatform: "darwin" as NodeJS.Platform, powerProbe: async () => ({ code: 0, out: "Current System Capabilities are: CPU Disk Network" }) };
    const cases: { name: string; force: boolean; deps: Record<string, unknown>; skip: SkipReason; throws?: boolean }[] = [
      { name: "below the morning floor", force: false, deps: { ...linux, now: BEFORE_FLOOR }, skip: "below-floor" },
      { name: "offline after the grace", force: false, deps: { ...linux, netProbe: async () => false }, skip: "offline" },
      { name: "a maintenance darkwake", force: false, deps: asleep, skip: "darkwake" },
      { name: "a provider failure", force: true, deps: { provider: { async generate() { throw new ProviderError("nonzero-exit", "boom"); } } }, skip: "provider-fail" },
      { name: "a briefing that parsed into nothing", force: true, deps: { provider: { async generate() { return "no sections at all"; } } }, skip: "parse-empty" },
      { name: "a crash (a non-provider throw)", force: true, deps: { provider: { async generate() { throw new TypeError("kaboom"); } } }, skip: "crashed", throws: true },
    ];
    for (const k of cases) {
      const env = withEnv({ provider: PROV, networkProbeHosts: [], excludeCommitPatterns: [], repos: [repo], updateCheck: { enabled: true } });
      try {
        const sidecar = join(env.stateDir, "env.json");
        const f = fakeFetch(() => release("v99.0.0"));
        const c = capture();
        let threw = false;
        try {
          await run(k.force, { ...NET, provider: STUB, ...k.deps, updateCheck: { fetch: f.fn } }, { jsonOut: sidecar });
        } catch { threw = true; } finally { c.restore(); }
        const envelope = JSON.parse(readFileSync(sidecar, "utf8")) as RunEnvelope;
        expect({ name: k.name, threw, delivered: envelope.delivered, skip: envelope.skipReason, fetches: f.calls.length, record: existsSync(updateCheckPath()) })
          .toEqual({ name: k.name, threw: k.throws ?? false, delivered: false, skip: k.skip, fetches: 0, record: false });
      } finally { env.cleanup(); }
    }
  });
});

// ── posture regression: byte-for-byte against a disabled run ───────────────────────────────────

/** A network probe that answers only once the millisecond clock has moved on, so `waitForNetwork`
 *  (src/net.ts:119-120 — `start = Date.now()`, then `waitedMs: Date.now() - start` even when the FIRST
 *  probe answers) reports `waitedMs >= 1` on EVERY run, and `run()`'s `emitNetMessage` (src/main.ts:99)
 *  prints its "waited ~0s for the network to come up" stderr line on both runs of a pair rather than on
 *  whichever one happened to straddle a millisecond tick. With `NET`'s `async () => true` that coin-flip
 *  was measured at 2 of 525 runs (0.4%) — a one-sided stderr line the byte comparison below would read as
 *  the update check's doing. This fixes the INPUT; every byte of the compared output is still compared.
 *  The spin is bounded on the monotonic clock: should a frozen `Date` (`setSystemTime`, process-wide)
 *  ever leak into this file, it gives up after 50 ms instead of hanging — and both runs then see the
 *  same frozen clock, so they still agree. */
const tickingProbe = async (): Promise<boolean> => {
  const t = Date.now();
  const giveUp = performance.now() + 50;
  while (Date.now() === t && performance.now() < giveUp) { /* normally ≤ 1 ms */ }
  return true;
};

/** Every channel the eval-integrity invariant covers, flattened into ONE list of lines that each carry
 *  their channel's name, so a mismatch prints as a line diff in which every line says where it came
 *  from (`+ "stderr │ …"`) — instead of two opaque multi-kilobyte strings (the one red this pin has
 *  produced had its output lost and could not be attributed). LOSSLESS, so this is the byte comparison
 *  itemised, not relaxed: each tag is constant per channel, stdout/stderr split on "\n" (`join` gives
 *  back the exact bytes), warning entries are JSON-encoded (injective), and an absent list is a line of
 *  its own, distinct from an empty one. */
const channels = (r: RunCapture): string[] => {
  const list = (name: string, v: unknown): string[] =>
    Array.isArray(v) ? v.map((w) => `${name} │ ${JSON.stringify(w)}`) : [`${name} │ (not a list: ${v === undefined ? "absent" : JSON.stringify(v)})`];
  return [
    `exit code │ ${r.code}`,
    ...r.stdout.split("\n").map((l) => `stdout │ ${l}`),
    ...r.stderr.split("\n").map((l) => `stderr │ ${l}`),
    ...list("envelope.warnings", r.envelope.warnings),
    ...list("struct.warnings", r.envelope.struct?.warnings),
    ...list("mergeWarnings", mergeWarnings(r.envelope.struct, r.envelope)),
  ];
};

describe("posture regression — a failing check AND a `newer` result change NOTHING the run reports", () => {
  const variants: [string, () => FetchLike, UpdateCheckResult["status"]][] = [
    ["a failing check (DNS)", () => (async () => { throw new TypeError("fetch failed"); }) as FetchLike, "unknown"],
    ["a `newer` result", () => fakeFetch(() => release("v99.0.0")).fn, "newer"],
  ];
  for (const [name, mkFetch, wantStatus] of variants) {
    test(name, async () => {
      const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
      const base = { provider: PROV, networkProbeHosts: [], excludeCommitPatterns: [], repos: [repo] };
      const env = withEnv(base);
      try {
        const sidecar = join(env.stateDir, "env.json");
        // The rendered briefing stamps the local HH:MM (`stateAsOf`), so the pair must fall in ONE minute
        // for a byte comparison to be meaningful; a pair that straddles a minute boundary is re-run.
        // ⚠ EACH ATTEMPT STARTS WITHOUT A RECORD. A retry used to keep attempt 1's `update-check.json`,
        // so the retried enabled run was NOT DUE (intervalHours) and fetched nothing — the comparison then
        // pitted a disabled run against an enabled run that never checked, and the non-vacuity read below
        // was reading attempt 1's state. The fetch count is taken per attempt, on the COMPARED pair.
        let disabled!: RunCapture, enabled!: RunCapture;
        let disabledFetches = 0, enabledFetches = 0;
        const counted = (f: FetchLike, bump: () => void): FetchLike => async (url, init) => { bump(); return f(url, init); };
        for (let attempt = 0; attempt < 3; attempt++) {
          rmSync(updateCheckPath(), { force: true });
          expect(existsSync(updateCheckPath())).toBe(false);
          disabledFetches = 0; enabledFetches = 0;
          const m0 = new Date().getMinutes();
          writeFileSync(env.cfgPath, JSON.stringify(base));
          disabled = await oneRun(sidecar, { netProbe: tickingProbe, updateCheck: { fetch: counted(mkFetch(), () => { disabledFetches++; }) } });
          writeFileSync(env.cfgPath, JSON.stringify({ ...base, updateCheck: { enabled: true } }));
          enabled = await oneRun(sidecar, { netProbe: tickingProbe, updateCheck: { fetch: counted(mkFetch(), () => { enabledFetches++; }) } });
          if (new Date().getMinutes() === m0) break;
        }
        // NON-VACUITY: the check really ran on the COMPARED enabled run (exactly one fetch, and none on
        // the disabled run), and the record it left — the only one, since each attempt starts without
        // one — gave the variant's answer.
        expect({ disabledFetches, enabledFetches }).toEqual({ disabledFetches: 0, enabledFetches: 1 });
        expect((await readUpdateCheckState())?.status).toBe(wantStatus);
        // Every channel at once, reported BY CHANNEL with a readable diff — then the byte-for-byte
        // assertions below, unchanged, so nothing this pin compared before is compared less strictly.
        expect(channels(enabled)).toStrictEqual(channels(disabled));
        // stdout / stderr: byte-identical.
        expect(enabled.stdout).toBe(disabled.stdout);
        expect(enabled.stderr).toBe(disabled.stderr);
        expect(enabled.code).toBe(disabled.code);
        expect(enabled.stdout.length).toBeGreaterThan(0);        // a delivered briefing, not two empty strings
        // The envelope's `warnings`, the struct's `warnings`: unchanged.
        expect(enabled.envelope.warnings).toEqual(disabled.envelope.warnings);
        expect(enabled.envelope.struct?.warnings).toEqual(disabled.envelope.struct?.warnings);
        // mergeWarnings adds nothing, and the posture line still reads `posture: full`.
        const merged = (e: RunEnvelope) => mergeWarnings(e.struct, e);
        expect(merged(enabled.envelope)).toEqual(merged(disabled.envelope));
        expect(posturePhrase(merged(enabled.envelope))).toBe("full");
        expect(postureLine(merged(enabled.envelope))).toBe("posture: full");
        // …and no update wording reached any of those channels. (Not the whole envelope: its `paths`
        // block lists `updateCheckPath` by design — a path, not a result.)
        for (const text of [enabled.stdout, enabled.stderr, JSON.stringify(enabled.envelope.warnings), JSON.stringify(enabled.envelope.struct)]) {
          expect(text).not.toContain("99.0.0");
          expect(text.toLowerCase()).not.toContain("update");
        }
      } finally { env.cleanup(); }
    });
  }
});

// The uninstall removal is pinned where uninstall.sh is RUN, not grepped: test/maintenance.test.ts and
// test/uninstall.test.ts create `update-check.json` with every other artifact and assert the script removes
// it (and, on every refusal path, that it is left untouched); gui/src-tauri/tests/uninstall.rs pins the
// desktop app's list to the script's.
