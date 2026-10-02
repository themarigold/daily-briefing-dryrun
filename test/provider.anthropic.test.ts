// test/provider.anthropic.test.ts — A3/T4. The native Anthropic Messages API transport.
//
// Driven against a REAL HTTP server on an ephemeral port (test/helpers/fakeApi.ts), pointed at through
// `provider.api.baseUrl` — a real config field taking a real URL, with NO test-only branch anywhere in
// `src/`. That is what makes these tests evidence about production rather than about a mock.
import { test, expect, afterEach } from "bun:test";
import { startFakeApi, okJson, status, slow, badJson, sse, type FakeApiHandler } from "./helpers/fakeApi";
import { AnthropicApiProvider, ANTHROPIC_DEFAULT_MAX_TOKENS, ANTHROPIC_VERSION } from "../src/providers/anthropic";
import { USAGE_WALL_RETRY_AFTER_MS, MAX_RESPONSE_BYTES, DIAG_CHARS, mapStatus, retryAfterMs, parseRegainAccess, postJson } from "../src/providers/http";
import { PROVIDER_RETRY_DELAYS_MS } from "../src/core";
import { withRetry } from "../src/provider";
import { ProviderError, API_LABEL_ANTHROPIC, type ProviderApi } from "../src/types";
import { isPostureWarning, posturePhrase, API_TRUNCATION_SENTINEL } from "../src/eval/posture";
import { guardNetworkForThisFile } from "./helpers/netGuard";

// Every case below is pointed at a fake server on 127.0.0.1; the guard turns "pointed at" into a
// mechanically enforced property rather than a reviewing habit. See test/helpers/netGuard.ts.
guardNetworkForThisFile();

const SENTINEL = "sk-ant-api03-ZZTOPSECRETsentinelVALUE-do-not-log-0000";

const servers: { stop(): Promise<void> }[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });
const serve = async (h: FakeApiHandler) => { const s = await startFakeApi(h); servers.push(s); return s; };

const textBody = (t: string, extra: Record<string, unknown> = {}) =>
  ({ content: [{ type: "text", text: t }], stop_reason: "end_turn", ...extra });

const api = (origin: string, extra: Partial<ProviderApi> = {}): ProviderApi =>
  ({ kind: "anthropic", model: "claude-sonnet-5", baseUrl: origin, apiKeyEnv: "K", ...extra });

const mk = (origin: string, extra: Partial<ProviderApi> = {}, timeoutMs = 5_000) =>
  new AnthropicApiProvider(api(origin, extra), { timeoutMs, env: { K: SENTINEL } });

// ── the retry-budget derivation ───────────────────────────────────────────────────────────────────

test("⚠ the 429 split constant IS the retry budget — pinned, not adjacent", () => {
  // The design puts this constant beside the retry schedule so the derivation is discoverable. It
  // cannot physically live there (core.ts imports the factory, which imports the provider, so importing
  // core.ts back would close a cycle and leave the constant undefined at module-evaluation time), so the
  // derivation is enforced HERE instead — which is strictly stronger than adjacency: changing the retry
  // schedule turns this red, whereas a comment two files away would not.
  expect(USAGE_WALL_RETRY_AFTER_MS).toBe(PROVIDER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
});

// ── the request ───────────────────────────────────────────────────────────────────────────────────

test("⚠ the prompt reaches the wire BYTE-IDENTICAL, as exactly one user message", async () => {
  // This is the no-comparability-boundary guarantee. `buildPrompt` builds the prompt upstream of the
  // transport; if anything here reshaped it, a briefing generated over HTTP would not be comparable with
  // one generated through the CLI, and every EVAL.md row would silently stop being comparable with the
  // rows above it.
  const s = await serve(okJson(textBody("out")));
  const prompt = "line one\r\n\tline two  🌅 \"quoted\" \\backslash\\ trailing  ";
  await mk(s.origin).generate(prompt);
  const body = JSON.parse(s.requests[0]!.bodyText) as Record<string, unknown>;
  expect((body.messages as { role: string; content: string }[])).toHaveLength(1);
  expect((body.messages as { role: string; content: string }[])[0]).toEqual({ role: "user", content: prompt });
});

test("⚠ the request body's KEY SET is exactly {model, max_tokens, messages} — nothing else, ever", async () => {
  // Asserted on the KEY SET rather than on the values, so a future "just add a system prompt" or "set
  // temperature to 0 for determinism" fails LOUDLY instead of quietly opening a comparability boundary.
  const s = await serve(okJson(textBody("out")));
  await mk(s.origin).generate("p");
  const body = JSON.parse(s.requests[0]!.bodyText) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model"]);
  expect(body.model).toBe("claude-sonnet-5");
  expect(body.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS);
  for (const forbidden of ["system", "temperature", "tools", "stop_sequences", "top_p", "stream"]) {
    expect(`${forbidden} present: ${forbidden in body}`).toBe(`${forbidden} present: false`);
  }
});

test("headers carry x-api-key and the PINNED anthropic-version, and the path is /v1/messages", async () => {
  const s = await serve(okJson(textBody("out")));
  await mk(s.origin).generate("p");
  const req = s.requests[0]!;
  expect(req.method).toBe("POST");
  expect(req.path).toBe("/v1/messages");
  expect(req.headers["x-api-key"]).toBe(SENTINEL);
  expect(req.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
  expect(req.headers["content-type"]).toBe("application/json");
});

test("a trailing slash and a base path both normalize to ONE request URL", async () => {
  for (const suffix of ["", "/", "///"]) {
    const s = await serve(okJson(textBody("out")));
    await mk(`${s.origin}${suffix}`).generate("p");
    expect(`${JSON.stringify(suffix)} → ${s.requests[0]!.path}`).toBe(`${JSON.stringify(suffix)} → /v1/messages`);
  }
  const g = await serve(okJson(textBody("out")));
  await mk(`${g.origin}/gateway/anthropic/`).generate("p");
  expect(g.requests[0]!.path).toBe("/gateway/anthropic/v1/messages");
});

test("maxTokens is honoured when configured", async () => {
  const s = await serve(okJson(textBody("out")));
  await mk(s.origin, { maxTokens: 777 }).generate("p");
  expect((JSON.parse(s.requests[0]!.bodyText) as Record<string, unknown>).max_tokens).toBe(777);
});

// ── the response ──────────────────────────────────────────────────────────────────────────────────

test("multi-block content concatenates IN ORDER; non-text blocks are ignored, not fatal", async () => {
  const s = await serve(okJson({
    content: [
      { type: "text", text: "A" },
      { type: "thinking", thinking: "should not appear" },
      { type: "text", text: "B" },
      { type: "tool_use", name: "x" },
      { type: "text", text: "C" },
    ],
    stop_reason: "end_turn",
  }));
  // Dropping the non-text blocks is right (nothing downstream consumes them); dropping the text BETWEEN
  // them would silently truncate the briefing, which is why order and completeness are both asserted.
  expect(await mk(s.origin).generate("p")).toBe("ABC");
});

test("stop_reason max_tokens returns the text AND adds exactly ONE truncation warning", async () => {
  const s = await serve(okJson(textBody("partial briefing", { stop_reason: "max_tokens" })));
  const p = mk(s.origin, { maxTokens: 32 });
  expect(await p.generate("prompt")).toBe("partial briefing");
  const truncation = p.runtimeWarnings.filter((w) => w.includes(API_TRUNCATION_SENTINEL));
  expect(truncation).toHaveLength(1);
  expect(truncation[0]).toContain("32");
  // ⚠ NOT a posture warning: the model hit its output ceiling, which says nothing about the provider's
  // authority. Classifying it as posture would flip the EVAL row to `degraded` for a full-size briefing.
  expect(isPostureWarning(truncation[0]!)).toBe(false);
});

test("a 200 that parses but carries no text is empty-output (retryable), not a silent empty briefing", async () => {
  for (const body of [{ content: [], stop_reason: "end_turn" }, { content: [{ type: "text", text: "   " }] }, {}]) {
    const s = await serve(okJson(body));
    await expect(mk(s.origin).generate("p")).rejects.toMatchObject({ code: "empty-output" });
  }
});

test("an unparseable 200 — a proxy page or an SSE body — is retryable, never half-understood", async () => {
  for (const [name, h] of [["html", badJson()], ["sse", sse()]] as const) {
    const s = await serve(h);
    let code = "";
    try { await mk(s.origin).generate("p"); } catch (e) { code = (e as ProviderError).code; }
    expect(`${name}: ${code}`).toBe(`${name}: nonzero-exit`);
  }
});

// ── the status→code mapping ───────────────────────────────────────────────────────────────────────

test("⚠ the status→code table, end to end against a real server", async () => {
  // TAXONOMY VERIFIED AGAINST LIVE DOCS (2026-09-14): platform.claude.com/docs/en/api/errors —
  // 400 invalid_request_error · 401 authentication_error · 402 billing_error · 403 permission_error ·
  // 404 not_found_error · 409 conflict_error · 413 request_too_large · 429 rate_limit_error ·
  // 500 api_error · 504 timeout_error · 529 overloaded_error.
  //
  // `missing-binary` means PERMANENT FOR THIS RUN (withRetry rethrows it with zero attempts) — a bad
  // key, a wrong model id or a revoked permission is permanent in exactly that sense, and mapping any of
  // them to `nonzero-exit` would burn three calls and ~135 s of backoff every 600 s tick forever.
  const cases: [number, string, string][] = [
    [400, "invalid_request_error", "missing-binary"],
    [401, "authentication_error", "missing-binary"],
    // 402 is NOT here — it is a WALL, not a permanent defect. Its own case is below.
    [403, "permission_error", "missing-binary"],
    [404, "not_found_error", "missing-binary"],
    [413, "request_too_large", "missing-binary"],
    [408, "timeout", "nonzero-exit"],
    [409, "conflict_error", "nonzero-exit"],
    [500, "api_error", "nonzero-exit"],
    [502, "bad_gateway", "nonzero-exit"],
    [503, "unavailable", "nonzero-exit"],
    [504, "timeout_error", "nonzero-exit"],
    [529, "overloaded_error", "nonzero-exit"],
  ];
  for (const [code, type, expected] of cases) {
    const s = await serve(status(code, { type: "error", error: { type, message: `${type} happened` } }));
    let got = "(no throw)";
    try { await mk(s.origin).generate("p"); } catch (e) { got = (e as ProviderError).code; }
    expect(`${code} ${type} → ${got}`).toBe(`${code} ${type} → ${expected}`);
  }
});

test("⚠ 429 SPLITS on retry-after: a short one is transient, a long one is a wall", async () => {
  // THE SUBTLEST CALL IN THIS DESIGN, and it is wrong in both directions if collapsed. Mapping every 429
  // to `usage-limit` records an account mark for a 30-second rate limit — a missed briefing and a
  // spurious recovery-outage line for a condition the second retry would have cleared. Mapping every 429
  // to `nonzero-exit` burns the whole schedule against a cap that cannot lift for weeks.
  const short = await serve(status(429, { error: { type: "rate_limit_error", message: "slow down" } }, { "retry-after": "30" }));
  let e: ProviderError | undefined;
  try { await mk(short.origin).generate("p"); } catch (x) { e = x as ProviderError; }
  expect(e?.code).toBe("nonzero-exit");
  expect(e?.resetAt).toBeUndefined();

  const long = await serve(status(429, { error: { type: "rate_limit_error", message: "slow down a lot" } }, { "retry-after": "3600" }));
  let w: ProviderError | undefined;
  try { await mk(long.origin).generate("p"); } catch (x) { w = x as ProviderError; }
  expect(w?.code).toBe("usage-limit");
  expect(Number.isNaN(Date.parse(w!.resetAt!))).toBe(false);
  expect(Date.parse(w!.resetAt!) - Date.now()).toBeGreaterThan(3_000_000);

  // The boundary itself, at the constant, so a future edit to the retry schedule cannot silently move it.
  const now = new Date("2026-09-14T00:00:00Z");
  const h = (sec: number) => new Headers({ "retry-after": String(sec) });
  expect(mapStatus(429, h(USAGE_WALL_RETRY_AFTER_MS / 1000), "{}", now, "anthropic").code).toBe("nonzero-exit");
  expect(mapStatus(429, h(USAGE_WALL_RETRY_AFTER_MS / 1000 + 1), "{}", now, "anthropic").code).toBe("usage-limit");
  // The boundary is TRANSPORT-AGNOSTIC — only the ABSENT-header inference is anthropic-only.
  expect(mapStatus(429, h(USAGE_WALL_RETRY_AFTER_MS / 1000), "{}", now, "openai-compatible").code).toBe("nonzero-exit");
  expect(mapStatus(429, h(USAGE_WALL_RETRY_AFTER_MS / 1000 + 1), "{}", now, "openai-compatible").code).toBe("usage-limit");
});

test("⚠ the SPEND-CAP 429 carries NO retry-after — absence is evidence of a WALL, not of a short limit", async () => {
  // Straight from the live docs: "the error type is rate_limit_error, the same as for a rate limit, but
  // the response has NO retry-after header… Retrying, including the SDKs' automatic retries, fails until
  // access resumes." That is the opposite of the natural assumption, which is why it is pinned.
  const body = {
    type: "error",
    error: {
      type: "rate_limit_error",
      message: "You have reached your API usage limits: your organization has crossed its monthly API usage threshold. You will regain access on 2026-10-01 at 00:00 UTC.",
      details: { error_code: "enforced_spend_limit_reached" },
    },
  };
  const s = await serve(status(429, body));
  let e: ProviderError | undefined;
  try { await mk(s.origin).generate("p"); } catch (x) { e = x as ProviderError; }
  expect(e?.code).toBe("usage-limit");
  // …and the resume instant is PARSED from the message rather than guessed. Without it core.ts falls
  // back to a one-hour probe mark and re-probes a wall that cannot lift for weeks.
  expect(e?.resetAt).toBe("2026-10-01T00:00:00.000Z");
});

test("⚠ 402 billing_error is a WALL, not a permanent defect — the quiet skip, with no resetAt", async () => {
  // A credit balance that ran out LIFTS ON TOP-UP. Mapping it to `missing-binary` (the generic 4xx
  // line) gave it the loud permanent-failure path: no account mark, no quiet skip, no recovery-outage
  // line when it cleared, and a `Briefing provider failed (missing-binary)` line every 600 s tick
  // forever. It belongs beside the 400 usage-limit clause — the same reasoning, the same path, and the
  // claim core.ts:529 already makes about exactly this case ("a credit-exhausted API key still throws
  // `usage-limit`, still records against the implicit label, still takes the quiet `return 0` skip").
  const s = await serve(status(402, { type: "error", error: { type: "billing_error", message: "Your credit balance is too low to access the Anthropic API." } }));
  let e: ProviderError | undefined;
  try { await mk(s.origin).generate("p"); } catch (x) { e = x as ProviderError; }
  expect(e?.code).toBe("usage-limit");
  // ⚠ NO `resetAt`, DELIBERATELY: a top-up has no schedule. core.ts then falls back to its ONE-HOUR
  // probe mark, which is exactly right here — re-probe soon, because the user can fix this any minute.
  expect(e?.resetAt).toBeUndefined();
  // Same on the other transport: 402 Payment Required means the same thing everywhere.
  expect(mapStatus(402, new Headers(), "", new Date(), "openai-compatible")).toEqual({ code: "usage-limit" });
});

test("a USER-SET spend limit returns 400, not 429 — and is still a quiet wall", async () => {
  // Also from the live docs, and not guessable: a limit the USER set returns 400 invalid_request_error
  // whose message begins "You have reached your specified API usage limits". A 400 is otherwise
  // permanent-and-not-a-wall, so without this clause a self-imposed budget cap takes the NOISY failure
  // path forever instead of the quiet skip it deserves.
  const s = await serve(status(400, {
    error: { type: "invalid_request_error", message: "You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC." },
  }));
  let e: ProviderError | undefined;
  try { await mk(s.origin).generate("p"); } catch (x) { e = x as ProviderError; }
  expect(e?.code).toBe("usage-limit");
  expect(e?.resetAt).toBe("2026-10-01T00:00:00.000Z");
  // The workspace variant of the same sentence.
  expect(mapStatus(400, new Headers(), JSON.stringify({ error: { message: "You have reached your specified workspace API usage limits." } }), new Date(), "anthropic").code)
    .toBe("usage-limit");
});

test("retry-after parses seconds AND an HTTP-date; an absent or junk header is undefined", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  expect(retryAfterMs("30", now)).toBe(30_000);
  expect(retryAfterMs(" 45 ", now)).toBe(45_000);
  expect(retryAfterMs("Mon, 14 Sep 2026 12:01:00 GMT", now)).toBe(60_000);
  expect(retryAfterMs(null, now)).toBeUndefined();
  expect(retryAfterMs("", now)).toBeUndefined();
  expect(retryAfterMs("soon", now)).toBeUndefined();
  // A date in the past clamps to 0 rather than going negative, which would read as "retry before now".
  expect(retryAfterMs("Mon, 14 Sep 2026 11:00:00 GMT", now)).toBe(0);
});

test("parseRegainAccess reads the documented sentence and nothing else", () => {
  expect(parseRegainAccess("You will regain access on 2026-09-01 at 00:00 UTC.")).toBe("2026-09-01T00:00:00.000Z");
  expect(parseRegainAccess("You will regain access on 2026-12-31 UTC")).toBe("2026-12-31T00:00:00.000Z");
  expect(parseRegainAccess("no such sentence here")).toBeUndefined();
  expect(parseRegainAccess("regain access on 9999-99-99 at 99:99 UTC")).toBeUndefined();
});

// ── timeout, connect failure, and the missing key ────────────────────────────────────────────────

test("a handler that sleeps past timeoutMs produces `timeout`, and the error is stamped with durationMs", async () => {
  const s = await serve(slow(2_000));
  const p = new AnthropicApiProvider(api(s.origin), { timeoutMs: 60, env: { K: SENTINEL } });
  let e: ProviderError | undefined;
  try { await p.generate("x"); } catch (x) { e = x as ProviderError; }
  expect(e?.code).toBe("timeout");
  // `durationMs` is what the B6 ladder's fail-fast gate reads; an unstamped error is invisible to it.
  expect(typeof e?.durationMs).toBe("number");
});

test("a connect failure (nothing listening) is RETRYABLE — a wake-before-wifi morning looks exactly like this", async () => {
  const s = await startFakeApi(okJson({}));
  const origin = s.origin;
  await s.stop();                               // the port is now closed
  const p = new AnthropicApiProvider(api(origin), { timeoutMs: 2_000, env: { K: SENTINEL } });
  let e: ProviderError | undefined;
  try { await p.generate("x"); } catch (x) { e = x as ProviderError; }
  expect(e?.code).toBe("nonzero-exit");
});

test("⚠ a connect failure names the PRINTABLE endpoint — a baseUrl query NEVER reaches the message", async () => {
  // THE LEAK THIS PINS. `requestUrl` deliberately PRESERVES the configured query (a gateway's
  // `?api-version=…` is load-bearing), so a `baseUrl` carrying `?api_key=…` is on the wire URL too. That
  // string used to be interpolated straight into the connect-failure ProviderError — and a ProviderError
  // message reaches stderr, briefing.log (main.ts), the persisted last-skip detail and the JSON envelope,
  // which is every surface README.md promises a baseUrl query is WITHHELD from.
  //
  // Driven the same way as the test above — a real fake server, stopped, so the port is genuinely closed
  // and this is the production connect-failure branch rather than a stubbed throw.
  const URL_SECRET = "qk-URLSECRET-do-not-log-1111";
  const s = await startFakeApi(okJson({}));
  const origin = s.origin;
  await s.stop();                               // the port is now closed
  const p = new AnthropicApiProvider(
    api(`${origin}/gw?api_key=${URL_SECRET}`),
    { timeoutMs: 2_000, env: { K: SENTINEL } },
  );
  let e: ProviderError | undefined;
  try { await p.generate("x"); } catch (x) { e = x as ProviderError; }
  expect(e?.code).toBe("nonzero-exit");
  expect(e!.message).not.toContain(URL_SECRET);  // ← the whole point
  expect(e!.message).not.toContain("api_key");
  // …and it is still DIAGNOSTIC: the path the run actually called is named, plus doctor's own
  // "something was held back" marker, so nobody is quietly shown a different URL from the real one.
  expect(e!.message).toContain(`${origin}/gw/v1/messages`);
  expect(e!.message).toContain("query withheld");
});

test("no key is PERMANENT, and the message names the SOURCE rather than telling you to install a CLI", async () => {
  const s = await serve(okJson(textBody("out")));
  const p = new AnthropicApiProvider(api(s.origin, { apiKeyEnv: "ABSENT_VAR" }), { env: {} });
  let e: ProviderError | undefined;
  try { await p.generate("x"); } catch (x) { e = x as ProviderError; }
  expect(e?.code).toBe("missing-binary");        // = "permanent for this run", see http.ts's misnomer note
  expect(e?.message).toContain("ABSENT_VAR");
  expect(e?.message).not.toMatch(/install/i);
  expect(s.requests).toHaveLength(0);            // …and nothing was ever sent
});

// ── posture and secrecy ───────────────────────────────────────────────────────────────────────────

test("the hardening carve-out warning is present, IS posture, and yields the fifth phrase", async () => {
  const s = await serve(okJson(textBody("out")));
  const p = mk(s.origin);
  await p.generate("x");
  const carve = p.runtimeWarnings.filter((w) => w.includes("no CLI process to harden"));
  expect(carve).toHaveLength(1);
  expect(isPostureWarning(carve[0]!)).toBe(true);
  expect(posturePhrase(p.runtimeWarnings)).toBe("unhardened (api provider)");
  // An https endpoint raises no cleartext warning.
  expect(p.runtimeWarnings.some((w) => w.includes("cleartext"))).toBe(false);
});

test("⚠ SENTINEL LEAK: the key never appears in the label, the warnings, or ANY thrown message", async () => {
  const bodies: [string, FakeApiHandler][] = [
    ["ok", okJson(textBody("fine"))],
    ["401 echoing the key", status(401, { error: { type: "authentication_error", message: `invalid key ${SENTINEL}` } })],
    ["500 echoing the key", status(500, `server said ${SENTINEL}`)],
    ["unparseable 200 echoing the key", status(200, `<html>${SENTINEL}</html>`)],
  ];
  for (const [name, h] of bodies) {
    const s = await serve(h);
    const p = mk(s.origin);
    let thrown = "";
    try { await p.generate("prompt"); } catch (e) { thrown = `${(e as Error).message}`; }
    const surface = JSON.stringify({ label: p.label, warnings: p.runtimeWarnings, thrown });
    expect(`${name}: ${surface.includes(SENTINEL)}`).toBe(`${name}: false`);
  }
});

test("the label is the stable transport constant", async () => {
  const s = await serve(okJson(textBody("x")));
  expect(mk(s.origin).label).toBe(API_LABEL_ANTHROPIC);
});

test("⚠ the response body is CAPPED — a pathological body fails loudly instead of exhausting memory", async () => {
  // `res.text()` has no ceiling at all. A misconfigured `baseUrl` pointed at a file server, or a gateway
  // streaming an error page, must not be able to eat the 07:20 run's memory. The capped read stops, the
  // truncated bytes fail to parse, and the result is a RETRYABLE failure — loud, bounded, and honest.
  //
  // ⚠ DRIVEN THROUGH A SMALL INJECTED CAP, and that is not a shortcut. Measured first with a body a
  // little over the 8 MB production cap: `fetch` delivered it in one chunk, the loop appended it and
  // only THEN crossed the cap, so the whole body was read and the request SUCCEEDED — a test written
  // that way asserts nothing. The mechanism is only observable when several chunks are needed.
  //
  // ⚠ AND THE CHUNK BOUNDARIES ARE THE TEST'S, NOT THE TRANSPORT'S (round-2 review, MEASURED). The
  // first version served 200 KB over a real loopback socket and trusted `fetch` to split it. It
  // usually does — and in 2 of 30 measured runs on an IDLE machine it delivered the whole body as
  // ONE chunk, which `readCapped` appends before checking the ceiling, so the COMPLETE body was
  // read, parsed fine, nothing threw, and `expect(e?.code)` got `undefined`. That intermittent is
  // not about the product: the "cap plus one chunk" bound is deliberate and documented at
  // `readCapped`. It is the fixture asserting a property of TCP delivery it cannot control. So the
  // body is streamed here in explicit fixed-size writes, which makes crossing the ceiling MID-BODY
  // true by construction, under any load, on any machine. Everything else about the case is
  // unchanged — this is still the real `postJson`, the real `readCapped`, and a real Response.
  const CHUNK = 1_024, CAP = 4_096;
  const body = JSON.stringify({ content: [{ type: "text", text: "y".repeat(50_000) }] });
  let pulled = 0;
  const chunked = new ReadableStream<Uint8Array>({
    pull(c) {
      const at = pulled * CHUNK;
      if (at >= body.length) { c.close(); return; }
      c.enqueue(new TextEncoder().encode(body.slice(at, at + CHUNK)));
      pulled++;
    },
  });
  const fetchImpl = (async () => new Response(chunked, {
    status: 200, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
  let e: ProviderError | undefined;
  try {
    await postJson({
      url: "http://127.0.0.1:1/v1/messages", headers: {}, body: { x: 1 },
      timeoutMs: 10_000, label: "anthropic-api", kind: "anthropic", maxBytes: CAP, fetchImpl,
    });
  } catch (x) { e = x as ProviderError; }
  expect(e?.code).toBe("nonzero-exit");
  expect(e?.message).toMatch(/not JSON/);
  // The read STOPPED at the ceiling — one chunk of slack, never the whole body. Without this the
  // case would still pass if `readCapped` read everything and the parse failed for another reason.
  expect(pulled).toBeLessThanOrEqual(CAP / CHUNK + 1);
  expect(pulled * CHUNK).toBeLessThan(body.length);
  // …and the diagnostic is CAPPED too, so a megabyte of junk never reaches a briefing warning or the log.
  expect(e!.message.length).toBeLessThan(DIAG_CHARS + 200);

  // The production default is unchanged and generous relative to any real briefing.
  expect(MAX_RESPONSE_BYTES).toBe(8 * 1024 * 1024);
}, 30_000);

// ── redirects are refused, never followed (Phase E M5b checkpoint) ─────────────────────────────────

test("⚠ postJson asks fetch to REFUSE redirects — `redirect: \"error\"` on the request it builds", async () => {
  // Fetch's default is `"follow"`. MEASURED (bun 1.3.14, two loopback ports): a followed 307/308
  // re-sends the POST — the prompt — with `x-api-key` to the Location's host, and a 301/302 becomes a
  // GET that still carries `x-api-key`. The init is asserted directly so the setting cannot quietly go.
  const inits: RequestInit[] = [];
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    inits.push(init);
    return new Response(JSON.stringify(textBody("ok")), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  await postJson({
    url: "http://127.0.0.1:1/v1/messages", headers: { "x-api-key": SENTINEL }, body: { x: 1 },
    timeoutMs: 5_000, label: "anthropic-api", kind: "anthropic", fetchImpl,
  });
  expect(inits).toHaveLength(1);
  expect(inits[0]!.redirect).toBe("error");
  expect(inits[0]!.method).toBe("POST");
});

test("⚠ a redirecting endpoint: nothing reaches the Location, and the failure is PERMANENT (never retried) — query withheld", async () => {
  // End to end, real servers: the endpoint answers 307 to a SECOND server (another port, so another
  // origin). Followed, that second server would receive the prompt and the key; refused, it receives
  // NOTHING. The thrown error is the permanent kind (`missing-binary`, as a permanent 4xx — fix round
  // 2: it was the retryable `nonzero-exit`, which bought ~135 s of backoff per tick for a failure only
  // a baseUrl edit can fix), and — because bun's own message for a refused redirect quotes the wire
  // URL — its words are ours, with the query withheld.
  const URL_SECRET = "qk-REDIRECTSECRET-do-not-log-2222";
  const elsewhere = await serve(okJson(textBody("followed")));
  const endpoint = await serve(() => new Response(null, { status: 307, headers: { location: `${elsewhere.origin}/v1/messages` } }));
  for (const redirectStatus of [307, 308, 302, 301]) {
    endpoint.setHandler(() => new Response(null, { status: redirectStatus, headers: { location: `${elsewhere.origin}/v1/messages` } }));
    const p = new AnthropicApiProvider(api(`${endpoint.origin}/gw?api_key=${URL_SECRET}`), { timeoutMs: 5_000, env: { K: SENTINEL } });
    let e: ProviderError | undefined;
    try { await p.generate("THE-PROMPT"); } catch (x) { e = x as ProviderError; }
    expect(`${redirectStatus} → ${e?.code}`).toBe(`${redirectStatus} → missing-binary`);
    expect(e!.message).toContain("redirect");
    expect(e!.message).toContain("Set baseUrl to the final URL");
    expect(e!.message).toContain(`${endpoint.origin}/gw/v1/messages`);
    expect(e!.message).toContain("query withheld");
    expect(e!.message).not.toContain(URL_SECRET);
    expect(e!.message).not.toContain(elsewhere.origin);
    expect(e!.message).not.toContain(SENTINEL);
  }
  // PREMISE: the endpoint really was asked (four times), and the Location really was never reached.
  expect(endpoint.requests).toHaveLength(4);
  expect(elsewhere.requests).toEqual([]);
  // …and the run's retry schedule spends nothing on it: ONE request, no backoff sleep.
  const sleeps: number[] = [];
  const p = new AnthropicApiProvider(api(`${endpoint.origin}/gw`), { timeoutMs: 5_000, env: { K: SENTINEL } });
  await expect(withRetry(() => p.generate("THE-PROMPT"), PROVIDER_RETRY_DELAYS_MS, async (ms) => void sleeps.push(ms)))
    .rejects.toThrow("answered with a redirect");
  expect(sleeps).toEqual([]);
  expect(endpoint.requests).toHaveLength(5);
  expect(elsewhere.requests).toEqual([]);
});
