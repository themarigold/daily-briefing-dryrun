// test/provider.openai-compat.test.ts — A3/T5. One transport for OpenAI, Ollama, LM Studio and vLLM.
//
// Two compatibility choices carry this design, and both are pinned directly rather than argued:
// `Authorization` is OMITTED (not sent empty) when no key resolved, and `max_tokens` is OMITTED unless
// the user asked for it. Everything else mirrors the Anthropic suite because the plumbing is shared.
import { test, expect, afterEach } from "bun:test";
import { startFakeApi, okJson, status, slow, badJson, type FakeApiHandler } from "./helpers/fakeApi";
import { OpenAiCompatibleProvider } from "../src/providers/openaiCompatible";
import { ProviderError, API_LABEL_OPENAI, type ProviderApi } from "../src/types";
import { isPostureWarning, posturePhrase, API_TRUNCATION_SENTINEL, API_CLEARTEXT_SENTINEL } from "../src/eval/posture";
import { matchesCredential } from "../src/transcripts/credentials";
import { guardNetworkForThisFile } from "./helpers/netGuard";

guardNetworkForThisFile();

const SENTINEL = "sk-proj-ZZTOPSECRETsentinelVALUE-do-not-log-0000";

/**
 * ⚠ A SECOND SENTINEL, AND IT IS SHAPED SO THE SHAPE-REDACTOR CANNOT SEE IT. A bare 32-hex string is
 * exactly what Azure OpenAI issues, and it matches NONE of `CREDENTIAL_PATTERNS` — asserted below
 * rather than assumed, because the whole value of this sentinel is that assumption being true.
 *
 * WHY A SECOND ONE IS NEEDED. `SENTINEL` above is `sk-proj-…`, which `redactCredentials` recognises,
 * so the echoed-body leak test passed WITHOUT the transport ever scrubbing the key it actually holds —
 * it was measuring the shape list, not the transport. (The shaped sentinel stays in use for the ladder
 * assertions, where the stated rationale — "shaped like a real key, so a pattern matching real keys
 * matches this one" — is the correct choice and no redaction is involved.)
 */
const OPAQUE_SENTINEL = "9f3c1ab47d2e4f8b90c5a61d7e3b2c48";

const servers: { stop(): Promise<void> }[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });
const serve = async (h: FakeApiHandler) => { const s = await startFakeApi(h); servers.push(s); return s; };

const reply = (content: string, finish = "stop") =>
  ({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }] });

const api = (baseUrl: string, extra: Partial<ProviderApi> = {}): ProviderApi =>
  ({ kind: "openai-compatible", model: "llama3", baseUrl, ...extra });

/** Keyless by default — the local-model case, which is the majority of this transport's users. */
const local = (baseUrl: string, extra: Partial<ProviderApi> = {}, timeoutMs = 5_000) =>
  new OpenAiCompatibleProvider(api(baseUrl, extra), { timeoutMs, env: {} });

const keyed = (baseUrl: string, extra: Partial<ProviderApi> = {}, key = SENTINEL) =>
  new OpenAiCompatibleProvider(api(baseUrl, { apiKeyEnv: "K", ...extra }), { timeoutMs: 5_000, env: { K: key } });

// ── the request ───────────────────────────────────────────────────────────────────────────────────

test("⚠ the prompt reaches the wire BYTE-IDENTICAL, as exactly one user message", async () => {
  const s = await serve(okJson(reply("out")));
  const prompt = "line one\r\n\tline two  🌅 \"quoted\" \\backslash\\ trailing  ";
  await local(`${s.origin}/v1`).generate(prompt);
  const body = JSON.parse(s.requests[0]!.bodyText) as Record<string, unknown>;
  expect(body.messages).toEqual([{ role: "user", content: prompt }]);
});

test("⚠ the body's KEY SET is exactly {model, messages} by default — max_tokens ONLY when configured", async () => {
  // OpenAI has been migrating newer models to `max_completion_tokens` while Ollama and vLLM accept
  // `max_tokens`; omission is the compatible superset and lets the server's own default apply. Asserted
  // on the key set so an addition of ANY kind fails loudly.
  const s = await serve(okJson(reply("out")));
  await local(`${s.origin}/v1`).generate("p");
  expect(Object.keys(JSON.parse(s.requests[0]!.bodyText) as object).sort()).toEqual(["messages", "model"]);

  const t = await serve(okJson(reply("out")));
  await local(`${t.origin}/v1`, { maxTokens: 512 }).generate("p");
  const body = JSON.parse(t.requests[0]!.bodyText) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model"]);
  expect(body.max_tokens).toBe(512);
});

test("⚠ Authorization is OMITTED ENTIRELY with no key — not sent as an empty Bearer", async () => {
  // Ollama and LM Studio need no key, and some servers reject a malformed header outright — so a
  // well-meaning `Bearer ` turns a working local setup into a 401.
  const s = await serve(okJson(reply("out")));
  await local(`${s.origin}/v1`).generate("p");
  expect("authorization" in s.requests[0]!.headers).toBe(false);

  const k = await serve(okJson(reply("out")));
  await keyed(`${k.origin}/v1`).generate("p");
  expect(k.requests[0]!.headers.authorization).toBe(`Bearer ${SENTINEL}`);
});

test("trailing-slash and no-trailing-slash baseUrls produce the IDENTICAL request URL", async () => {
  for (const suffix of ["/v1", "/v1/", "/v1///"]) {
    const s = await serve(okJson(reply("out")));
    await local(`${s.origin}${suffix}`).generate("p");
    expect(`${suffix} → ${s.requests[0]!.path}`).toBe(`${suffix} → /v1/chat/completions`);
  }
  // …and a root baseUrl (LM Studio's default shape) still lands somewhere sane.
  const r = await serve(okJson(reply("out")));
  await local(r.origin).generate("p");
  expect(r.requests[0]!.path).toBe("/chat/completions");
});

// ── the response ──────────────────────────────────────────────────────────────────────────────────

test("the content of choices[0] is the result; finish_reason length warns exactly once", async () => {
  const s = await serve(okJson(reply("hello there")));
  expect(await local(`${s.origin}/v1`).generate("p")).toBe("hello there");

  const t = await serve(okJson(reply("cut off here", "length")));
  const p = local(`${t.origin}/v1`, { maxTokens: 16 });
  expect(await p.generate("p")).toBe("cut off here");
  const truncation = p.runtimeWarnings.filter((w) => w.includes(API_TRUNCATION_SENTINEL));
  expect(truncation).toHaveLength(1);
  expect(isPostureWarning(truncation[0]!)).toBe(false);
});

test("a 200 with no usable content is empty-output; an unparseable 200 is retryable", async () => {
  for (const body of [{ choices: [] }, { choices: [{ message: { content: "" } }] }, { choices: [{ message: {} }] }, {}]) {
    const s = await serve(okJson(body));
    await expect(local(`${s.origin}/v1`).generate("p")).rejects.toMatchObject({ code: "empty-output" });
  }
  const bad = await serve(badJson());
  await expect(local(`${bad.origin}/v1`).generate("p")).rejects.toMatchObject({ code: "nonzero-exit" });
});

// ── the mapping, mirroring T4 ─────────────────────────────────────────────────────────────────────

test("the status→code table mirrors the Anthropic transport's — the mapping is shared, so it must", async () => {
  const cases: [number, string][] = [
    [400, "missing-binary"], [401, "missing-binary"], [403, "missing-binary"], [404, "missing-binary"],
    [408, "nonzero-exit"], [409, "nonzero-exit"], [500, "nonzero-exit"], [503, "nonzero-exit"], [529, "nonzero-exit"],
  ];
  for (const [code, expected] of cases) {
    const s = await serve(status(code, { error: { message: "x" } }));
    let got = "(no throw)";
    try { await local(`${s.origin}/v1`).generate("p"); } catch (e) { got = (e as ProviderError).code; }
    expect(`${code} → ${got}`).toBe(`${code} → ${expected}`);
  }
  const short = await serve(status(429, { error: { message: "slow" } }, { "retry-after": "20" }));
  await expect(local(`${short.origin}/v1`).generate("p")).rejects.toMatchObject({ code: "nonzero-exit" });
  const wall = await serve(status(429, { error: { message: "quota" } }, { "retry-after": "7200" }));
  await expect(local(`${wall.origin}/v1`).generate("p")).rejects.toMatchObject({ code: "usage-limit" });
});

test("a handler that sleeps past timeoutMs produces `timeout`", async () => {
  const s = await serve(slow(2_000));
  const p = new OpenAiCompatibleProvider(api(`${s.origin}/v1`), { timeoutMs: 60, env: {} });
  await expect(p.generate("x")).rejects.toMatchObject({ code: "timeout" });
});

// ── config-shaped failures ────────────────────────────────────────────────────────────────────────

test("a missing baseUrl is a PERMANENT config error naming the fix, not a network failure", async () => {
  // `validateProviderApi` permits an absent baseUrl because there is no universal default endpoint for
  // this kind, so the transport is where it becomes an error — permanent, because no retry invents a URL.
  const p = new OpenAiCompatibleProvider({ kind: "openai-compatible", model: "m" }, { env: {} });
  let e: ProviderError | undefined;
  try { await p.generate("x"); } catch (x) { e = x as ProviderError; }
  expect(e?.code).toBe("missing-binary");
  expect(e?.message).toContain("baseUrl");
});

test("a NON-loopback endpoint with no key fails permanently before anything is sent", async () => {
  const s = await serve(okJson(reply("x")));
  // `serve` binds 127.0.0.1, so force the non-loopback branch with a hostname the derivation treats as
  // remote while the port is still the live one — the assertion is about the PRE-FLIGHT refusal.
  const p = new OpenAiCompatibleProvider(
    { kind: "openai-compatible", model: "m", baseUrl: s.origin.replace("127.0.0.1", "example.invalid") },
    { env: {} },
  );
  await expect(p.generate("x")).rejects.toMatchObject({ code: "missing-binary" });
  expect(s.requests).toHaveLength(0);
});

// ── the cleartext warning ─────────────────────────────────────────────────────────────────────────

test("⚠ plain http to a NON-loopback endpoint warns ONCE; loopback http is silent", async () => {
  // The whole briefing context — commit subjects, file paths, branch names — would cross the network in
  // cleartext. But a daily warning for a correct LOCAL configuration is how people learn to ignore
  // warnings, so loopback must be silent and remote must not be.
  const remote = new OpenAiCompatibleProvider(
    { kind: "openai-compatible", model: "m", baseUrl: "http://gpu-box.corp.test:8000/v1", apiKeyEnv: "K" },
    { env: { K: SENTINEL } },
  );
  const hits = remote.runtimeWarnings.filter((w) => w.includes(API_CLEARTEXT_SENTINEL));
  expect(hits).toHaveLength(1);
  expect(hits[0]).toContain("gpu-box.corp.test:8000");
  // ⚠ IT MUST NAME THE CREDENTIAL, not just the repository metadata. This is exactly the case where a
  // key is REQUIRED (a non-loopback endpoint), so the key itself crosses the wire unencrypted in a
  // header — the strictly larger fact. An earlier wording named only "the whole briefing context
  // (commit subjects, file paths, branch names)", so a user could reasonably read it, judge the trade
  // acceptable, and never learn their key was being broadcast.
  expect(hits[0]).toMatch(/API key/i);
  expect(hits[0]).toMatch(/unencrypted|cleartext/i);
  expect(hits[0]).toMatch(/header/i);
  // …and the key is still SENT: a deliberate configuration is honoured, not quietly overridden.
  expect(remote.runtimeWarnings.join(" ")).not.toContain(SENTINEL);
  // NOT posture: it describes the confidentiality of the wire, not the provider's authority.
  expect(isPostureWarning(hits[0]!)).toBe(false);
  expect(posturePhrase(remote.runtimeWarnings)).toBe("unhardened (api provider)");

  for (const u of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "https://api.openai.com/v1"]) {
    const p = new OpenAiCompatibleProvider({ kind: "openai-compatible", model: "m", baseUrl: u }, { env: {} });
    expect(`${u}: ${p.runtimeWarnings.filter((w) => w.includes(API_CLEARTEXT_SENTINEL)).length}`).toBe(`${u}: 0`);
  }
});

// ── posture and secrecy ───────────────────────────────────────────────────────────────────────────

test("the carve-out warning is present and the label is the stable transport constant", async () => {
  const s = await serve(okJson(reply("x")));
  const p = local(`${s.origin}/v1`);
  expect(p.label).toBe(API_LABEL_OPENAI);
  expect(p.runtimeWarnings.filter((w) => w.includes("no CLI process to harden"))).toHaveLength(1);
  expect(posturePhrase(p.runtimeWarnings)).toBe("unhardened (api provider)");
});

test("⚠ SENTINEL LEAK: the key never appears in the label, the warnings, or ANY thrown message", async () => {
  const bodies: [string, FakeApiHandler][] = [
    ["ok", okJson(reply("fine"))],
    ["401 echoing the key", status(401, { error: { message: `bad key ${SENTINEL}` } })],
    ["500 echoing the key", status(500, `upstream said ${SENTINEL}`)],
    ["unparseable 200 echoing the key", status(200, `<html>${SENTINEL}</html>`)],
  ];
  for (const [name, h] of bodies) {
    const s = await serve(h);
    const p = keyed(`${s.origin}/v1`);
    let thrown = "";
    try { await p.generate("prompt"); } catch (e) { thrown = `${(e as Error).message}`; }
    const surface = JSON.stringify({ label: p.label, warnings: p.runtimeWarnings, thrown });
    expect(`${name}: ${surface.includes(SENTINEL)}`).toBe(`${name}: false`);
  }
});

// ── the 429 wall inference is TRANSPORT-SPECIFIC ──────────────────────────────────────────────────

test("⚠ a bare 429 from an openai-compatible server is TRANSIENT — the wall inference is Anthropic-only", async () => {
  // THE BUG THIS PINS. `mapStatus` took no transport kind, so the Anthropic-documented rule "an absent
  // retry-after on a 429 is evidence of a WALL" ran for every openai-compatible server too — where it
  // is simply false. Ollama, vLLM, LM Studio and most gateways return a bare 429 for ordinary
  // back-pressure. The consequence was not a wrong log line: `usage-limit` with no resetAt sends
  // core.ts down the quiet-skip path, benches the account on a ONE-HOUR probe mark, delivers no
  // briefing, shows no error, and later emits a spurious recovery-outage line — for a limit that would
  // have cleared on the second retry 45 s later.
  //
  // The three shapes below are the ones real servers actually send.
  const shapes: [string, unknown, Record<string, string>][] = [
    // OpenAI's own rate limit, no retry-after at all.
    ["OpenAI, no header", { error: { message: "Rate limit reached for gpt-4 in organization org-x on requests per min. Limit: 3/min." } }, {}],
    // A gateway that writes a UNIT SUFFIX — not conforming, so `retryAfterMs` reads it as ABSENT. It
    // must therefore be treated as absent, i.e. transient, not as a wall.
    ["gateway, `30s` suffix", { error: { message: "too many requests" } }, { "retry-after": "30s" }],
    // vLLM: the queue is full, and it reports only the x-ratelimit family.
    ["vLLM, x-ratelimit only", { error: { message: "queue full" } }, { "x-ratelimit-reset-requests": "60" }],
  ];
  for (const [name, body, headers] of shapes) {
    const s = await serve(status(429, body, headers));
    let e: ProviderError | undefined;
    try { await local(`${s.origin}/v1`).generate("p"); } catch (x) { e = x as ProviderError; }
    expect(`${name}: ${e?.code}`).toBe(`${name}: nonzero-exit`);
    expect(`${name}: ${e?.resetAt}`).toBe(`${name}: undefined`);
  }
});

test("…but POSITIVE evidence still makes an openai-compatible 429 a wall", async () => {
  // The split is wrong in both directions if collapsed. A transport that can never report a wall burns
  // the whole retry schedule against a cap, so the positive signals stay live for BOTH transports.
  const capped = await serve(status(429, { error: { message: "over quota", details: { error_code: "enforced_spend_limit_reached" } } }));
  await expect(local(`${capped.origin}/v1`).generate("p")).rejects.toMatchObject({ code: "usage-limit" });

  const dated = await serve(status(429, { error: { message: "quota exhausted. You will regain access on 2026-10-01 at 00:00 UTC." } }));
  let e: ProviderError | undefined;
  try { await local(`${dated.origin}/v1`).generate("p"); } catch (x) { e = x as ProviderError; }
  expect(e?.code).toBe("usage-limit");
  expect(e?.resetAt).toBe("2026-10-01T00:00:00.000Z");

  // …and a conforming retry-after longer than the whole retry budget, which is the transport-agnostic
  // arithmetic rule rather than a vendor inference.
  const long = await serve(status(429, { error: { message: "slow" } }, { "retry-after": "7200" }));
  await expect(local(`${long.origin}/v1`).generate("p")).rejects.toMatchObject({ code: "usage-limit" });
});

// ── the literal-key scrub ─────────────────────────────────────────────────────────────────────────

test("⚠ SENTINEL LEAK, UNSHAPED KEY: a key the shape-redactor cannot see is still scrubbed by VALUE", async () => {
  // The premise, asserted rather than assumed — if this ever becomes true the test below goes vacuous.
  expect(matchesCredential(OPAQUE_SENTINEL)).toBe(false);

  const bodies: [string, FakeApiHandler][] = [
    ["401 echoing the key", status(401, { error: { message: `Incorrect API key provided: ${OPAQUE_SENTINEL}` } })],
    ["500 echoing the key", status(500, `upstream rejected ${OPAQUE_SENTINEL}`)],
    ["unparseable 200 echoing the key", status(200, `<html>token ${OPAQUE_SENTINEL} invalid</html>`)],
    // ⚠ THE KEY STRADDLES THE 300-CHAR DIAGNOSTIC BOUNDARY. The slice used to run BEFORE redaction, so
    // half a key survived as text no pattern could ever match again. Scrub, then redact, then slice.
    ["429 with the key at the slice boundary", status(429, `${"x".repeat(290)}${OPAQUE_SENTINEL} trailing`, { "retry-after": "10" })],
  ];
  for (const [name, h] of bodies) {
    const s = await serve(h);
    const p = keyed(`${s.origin}/v1`, {}, OPAQUE_SENTINEL);
    let thrown = "";
    try { await p.generate("prompt"); } catch (e) { thrown = `${(e as Error).message}`; }
    const surface = JSON.stringify({ label: p.label, warnings: p.runtimeWarnings, thrown });
    expect(`${name}: ${surface.includes(OPAQUE_SENTINEL)}`).toBe(`${name}: false`);
    // …and not merely absent because the whole body was dropped: the diagnostic still carries context.
    expect(`${name}: ${thrown.length > 0}`).toBe(`${name}: true`);
  }
});

// ── the configured query string ───────────────────────────────────────────────────────────────────

test("⚠ a baseUrl's QUERY STRING reaches the wire — a gateway's api-version parameter is load-bearing", async () => {
  // The URL was rebuilt from `origin + pathname`, silently discarding `search`. A gateway that requires
  // `?api-version=…` then answered an opaque 4xx naming nothing, while `doctor` reported a baseUrl that
  // was not the one being called.
  const s = await serve(okJson(reply("out")));
  await local(`${s.origin}/v1?api-version=2024-10-21&deployment=gpt4o`).generate("p");
  expect(s.requests[0]!.path).toBe("/v1/chat/completions?api-version=2024-10-21&deployment=gpt4o");

  // A FRAGMENT is dropped — it is meaningless in HTTP and never leaves a client anyway.
  const f = await serve(okJson(reply("out")));
  await local(`${f.origin}/v1#anchor`).generate("p");
  expect(f.requests[0]!.path).toBe("/v1/chat/completions");
});

// ── the abort that lands mid-body ─────────────────────────────────────────────────────────────────

test("⚠ a timeout DURING THE BODY READ is `timeout`, not `the body is not JSON`", async () => {
  // Both existing timeout tests use a handler that sleeps BEFORE returning a Response, so the abort
  // always lands in the fetch catch. A wedged gateway — or a dropped connection on a long generation —
  // sends headers and then stalls MID-BODY, which is the shape the capped streaming reader exists for.
  // That path swallowed the abort, returned the partial bytes, failed to parse them, and reported
  // "HTTP 200 but the body is not JSON — {"choices":[{"message":{"content":"hel" — misattributing the
  // timeout to the server's JSON and never naming the ceiling the operator can raise.
  const s = await serve(() => new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"choices":[{"message":{"content":"hel'));
        // …and then never closes. The AbortController is the only thing that ends this.
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));
  const p = new OpenAiCompatibleProvider(api(`${s.origin}/v1`), { timeoutMs: 300, env: {} });
  let e: ProviderError | undefined;
  try { await p.generate("x"); } catch (x) { e = x as ProviderError; }
  expect(e?.code).toBe("timeout");
  expect(e?.message).toContain("300ms");
  expect(e?.message).not.toMatch(/not JSON/);
});
