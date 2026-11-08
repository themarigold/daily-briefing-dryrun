// src/providers/http.ts — A3/T4+T5. The transport plumbing the two API providers share.
//
// ⚠ AN ABSTRACTION WITH EXACTLY TWO CONSUMERS, and that is a deliberate exception rather than an
// oversight. The two wire formats differ in auth header, endpoint path, request body key names,
// response shape AND truncation signal — so a single parameterized provider would be a
// branch-per-field config object, which is precisely what "no new abstraction without three cases"
// exists to refuse. What is GENUINELY shared is none of that: abort/timeout, a bounded body read,
// redaction, and the status→ProviderErrorCode table. Two 60-line functions over one plumbing module,
// not one 120-line function with a shape map.
//
// ⚠ NO RETRY LOOP LIVES HERE. `withRetry` (provider.ts, driven by core.ts) is the single retry
// authority. A provider-internal loop underneath it multiplies attempts — 3 x 4 calls, ~10 minutes —
// which is the same reasoning provider.ts gives for keeping the hardening ladder's rungs single
// attempts. `Retry-After` is therefore SURFACED (in the message and in `resetAt`), never slept on.
import { ProviderError, type FailCause, type ProviderErrorCode } from "../types";
import { dropTrailingPartialToken, redactCredentialsWithSecret } from "../transcripts/credentials";
import { printableEndpoint, endpointHasWithheldParts } from "./endpoint";

/** Diagnostic slice, matching `provider.ts`'s 300-char cap on a CLI's stderr/stdout. Same number on
 *  purpose: the two paths produce the same kind of line and a reader should not have to know which
 *  transport produced the one in front of them. */
export const DIAG_CHARS = 300;

/** Hard ceiling on how much of a response body is read at all. A provider that returns a gigabyte —
 *  a misconfigured `baseUrl` pointed at a file server, a gateway streaming an error page — must not be
 *  able to exhaust memory on the 07:20 run. Generous relative to a briefing (the default token budget
 *  is 200 KB of CONTEXT and the model's reply is far smaller), tiny relative to the hazard. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * The transient-vs-wall split for HTTP 429, as a NAMED CONSTANT rather than a config knob.
 *
 * DERIVED FROM THE RETRY BUDGET: `PROVIDER_RETRY_DELAYS_MS` in core.ts is `[45_000, 90_000]`, so the
 * schedule can absorb 135 s of waiting. A 429 whose `retry-after` fits inside that budget WILL clear on
 * a later attempt, so it is transient (`nonzero-exit`, retryable). One that does not is a wall: taking
 * the quiet-skip path is right, and retrying is three doomed calls per tick.
 *
 * ⚠ THE SPLIT IS THE SUBTLEST PART OF THIS DESIGN, in both directions. Mapping EVERY 429 to
 * `usage-limit` would record an account mark for a 30-second rate limit — a missed briefing and a
 * spurious recovery-outage line for a condition that would have cleared on the second retry. Mapping
 * every 429 to `nonzero-exit` would burn the whole schedule against a spend cap that cannot clear
 * until the first of the month.
 *
 * ⚠ IT LIVES HERE, NOT BESIDE `PROVIDER_RETRY_DELAYS_MS`, FOR ONE MECHANICAL REASON: core.ts imports
 * the factory which imports this module, so importing core.ts back would close a cycle and leave this
 * constant possibly-undefined at module-evaluation time. The derivation is therefore pinned by a TEST
 * (`test/provider.anthropic.test.ts`) that asserts this equals `sum(PROVIDER_RETRY_DELAYS_MS)`, which
 * is strictly stronger than adjacency: changing the retry schedule turns that test red.
 */
export const USAGE_WALL_RETRY_AFTER_MS = 135_000;

// The three A3 warning sentinels live in `src/eval/posture.ts`, beside `TRUNCATION_SENTINEL` and for
// the same reason: the classifier and the constant it keys on belong together, and the emission sites
// duplicate the substring INLINE so the source-scanning guard can see the channel at all.

export type ApiPostInput = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  /** The transport label, used in error messages so a reader can tell the two apart. */
  label: string;
  /** WHICH WIRE PROTOCOL THIS IS. Not cosmetic: the 429 wall inference below is documented for the
   *  Anthropic API and is FALSE for every other openai-compatible server, so the mapping has to know
   *  which one it is looking at. Required rather than defaulted — a default would silently hand a new
   *  transport the semantics of whichever one was written first. */
  kind: "anthropic" | "openai-compatible";
  /** ⚠ THE RESOLVED API KEY, PASSED IN ONLY SO IT CAN BE SCRUBBED OUT AGAIN. Never added to a header
   *  here and never logged; `diagnostic()` removes literal occurrences of it from any text that can
   *  leave this module. See the note on `diagnostic`. */
  secret?: string;
  /** Injected in tests only to prove the abort path without a real clock. Production passes nothing. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Overrides MAX_RESPONSE_BYTES. A TEST SEAM, and a necessary one: `fetch` delivers a body of a few
   *  megabytes in one or two chunks, so a body merely a little over the production cap is read whole and
   *  the truncation branch never runs — a "cap" test written that way passes without exercising the cap.
   *  A small cap makes the mechanism itself observable. Production passes nothing. */
  maxBytes?: number;
  /** Provider fallback (P1-M3-T5): the walk's per-attempt deadline, COMBINED with this call's own timeout — either
   *  aborts the fetch, and either is reported as `timeout`. Absent ⇒ exactly today's request. */
  signal?: AbortSignal;
};

/**
 * Redact the union of shape and literal-secret spans on the original text, THEN flatten and clip.
 * Either sequential replacement order can consume part of the other's match. Shape matching also
 * catches upstream credentials; literal matching catches this key even when its shape is unknown
 * (Azure's 32-hex keys, Google AI Studio keys, or self-hosted tokens). Whitespace normalization and
 * clipping must wait too, since either can destroy the original match and leave a prefix exposed.
 */
export function diagnostic(text: string, secret?: string): string {
  return redactCredentialsWithSecret(text, secret).replace(/\s+/g, " ").trim().slice(0, DIAG_CHARS);
}

/**
 * THE REQUEST TARGET AS IT MAY BE PRINTED — origin + pathname, never the query.
 *
 * ⚠ `input.url` IS THE WIRE URL AND MUST NOT REACH A MESSAGE. `requestUrl` (endpoint.ts) deliberately
 * PRESERVES the configured query string because a gateway's `?api-version=…` is load-bearing — which
 * means a `baseUrl` carrying `?api_key=…` is carried too. A ProviderError message reaches stderr,
 * briefing.log, the persisted last-skip detail and the JSON envelope, so interpolating the wire URL put
 * that credential in every one of them, contradicting the README's "withheld from every printed
 * surface" promise about a baseUrl query.
 *
 * The withheld-query MARKER mirrors `doctor --json`'s `baseUrlQueryWithheld` flag: a reader is told
 * something was held back rather than quietly shown a different URL from the one the run called.
 * Unparseable input can only arrive from a caller that did not build its URL with `requestUrl`; it is
 * named as such rather than printed, because the one thing that must never happen here is echoing it.
 */
export function printableTarget(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return "(unprintable url)"; }
  return printableEndpoint(u) + (endpointHasWithheldParts(u) ? " (query withheld)" : "");
}

/** Read at most `maxBytes`, then stop. `res.text()` has no ceiling at all.
 *
 *  ⚠ THE BOUND IS `maxBytes` PLUS ONE CHUNK, not `maxBytes` exactly — the loop appends a chunk and then
 *  checks the total, because a reader cannot deliver half a chunk. That is the right trade: the hazard is
 *  an UNBOUNDED body (a misconfigured baseUrl pointed at a file server, a gateway streaming an error
 *  page), and one chunk of slack is a fixed cost, not an unbounded one. Said explicitly because the
 *  obvious test — a body a little over the cap — passes without the truncation branch ever running.
 *
 *  ⚠ RETURNS `complete` AS WELL AS THE TEXT, and the caller needs it. A body that ended because the
 *  ABORT fired mid-read used to be indistinguishable from a body that simply was not JSON, so a
 *  timeout landing after the response headers was reported as "HTTP 200 but the body is not JSON" —
 *  the ceiling the operator could actually raise was never named, and the message quoted a truncated
 *  body prefix instead. `complete` is false when the read throws OR reaches the byte cap before EOF. */
async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; complete: boolean }> {
  if (!res.body) return { text: "", complete: true };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) { await reader.cancel().catch(() => {}); break; }
    }
  } catch {
    // A body that errors mid-read still yields whatever arrived; the caller's JSON parse will fail and
    // classify it as a retryable unparseable response, which is the honest verdict for a broken read —
    // UNLESS it was our own abort, which `complete: false` plus the signal lets the caller detect.
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { joined.set(c, at); at += c.byteLength; }
  return { text: new TextDecoder().decode(joined), complete };
}

const DAY3 = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const MON3 = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const HMS = "\\d{2}:\\d{2}:\\d{2}";
/** RFC 9110 §5.6.7's three HTTP-date forms, and nothing else (PR 1 final review round 3, L8): `Date.parse` alone is
 *  lenient — it reads `"1.5"`, `"Oct 17"` and `"10/17/2026"` as dates — so a header must match one of these first. */
const IMF_FIXDATE = new RegExp(`^${DAY3}, \\d{2} ${MON3} \\d{4} ${HMS} GMT$`);
const RFC850_DATE = new RegExp(`^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-${MON3}-\\d{2} ${HMS} GMT$`);
const ASCTIME_DATE = new RegExp(`^${DAY3} ${MON3} (?: \\d|\\d{2}) ${HMS} \\d{4}$`);

/** `retry-after` in SECONDS, or as an HTTP-date in one of RFC 9110's three forms (an asctime date is GMT, so it is
 *  parsed as GMT, never in the local zone). Returns milliseconds from `now`, or undefined for anything else. */
export function retryAfterMs(header: string | null, now: Date): number | undefined {
  if (header === null) return undefined;
  const t = header.trim();
  if (t === "") return undefined;
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  let at: number;
  if (IMF_FIXDATE.test(t) || RFC850_DATE.test(t)) at = Date.parse(t);
  else if (ASCTIME_DATE.test(t)) at = Date.parse(`${t} GMT`);
  else return undefined;
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now.getTime());
}

/** `retry-after` as origin/main read it — seconds, or anything `Date.parse` accepts, however lenient — in ms from `now`.
 *  KEPT for the two WALL verdicts and `resetAt` (PR 1 final review round 5, M1; requirement 9): a single entry's wall
 *  decisions must stay origin/main's — with ONE exception: a `retry-after` past `Date`'s range, on which origin/main
 *  threw a RangeError, is now a wall with no `resetAt` (round 3 L7). Only the carried transient wait
 *  (`StatusMapping.retryAfterMs`, read by `withEntryRetry`) uses the strict `retryAfterMs`. */
export function legacyRetryAfterMs(header: string | null, now: Date): number | undefined {
  if (header === null) return undefined;
  const t = header.trim();
  if (t === "") return undefined;
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const at = Date.parse(t);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now.getTime());
}

/** The spend-cap 429 names its resume time in the message: "You will regain access on 2026-09-01 at
 *  00:00 UTC." Parsed rather than guessed, because the alternative — a one-hour probe mark — would make
 *  the tool re-probe a wall that cannot lift for weeks. Returns undefined when the sentence is absent,
 *  and core.ts then falls back to its existing probe behaviour. */
export function parseRegainAccess(message: string): string | undefined {
  const m = /regain access on (\d{4})-(\d{2})-(\d{2})(?: at (\d{2}):(\d{2}))?\s*UTC/i.exec(message);
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:00.000Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export type StatusMapping = { code: ProviderErrorCode; resetAt?: string; failCause?: FailCause; retryAfterMs?: number };

/** A 400 body that names the PROMPT'S LENGTH (Anthropic's "prompt is too long: N tokens > M maximum", the
 *  OpenAI-family "maximum context length" / `context_length_exceeded`). Matched on the parsed error's message
 *  and code only, before the body is dropped. */
const PROMPT_LENGTH_RE = /prompt is too long|maximum context length|context[_ ]length[_ ]exceeded|input is too long|too many (?:input )?tokens/i;

/**
 * HTTP status → one of the FIVE frozen `ProviderErrorCode` members. No sixth code: the union is frozen
 * and its count is pinned by test/types.test.ts, and the members already encode the SEMANTICS callers
 * need rather than their literal English.
 *
 * ⚠ `missing-binary` IS A PARTIAL MISNOMER HERE and that is stated rather than fixed by widening a
 * frozen union. What it MEANS to every caller is "permanent for this run — do not retry": `withRetry`
 * rethrows it with zero attempts. A bad or absent API key is permanent in exactly that sense, and
 * mapping it to `nonzero-exit` instead would burn three calls and ~135 s of backoff every 600 s tick
 * against a key that will never work. Every message produced on that path names the KEY SOURCE and
 * never says "install a CLI".
 *
 * TAXONOMY VERIFIED AGAINST LIVE DOCUMENTATION, 2026-09-14 — not inferred:
 *   https://platform.claude.com/docs/en/api/errors  and  https://platform.claude.com/docs/en/api/rate-limits
 *   400 invalid_request_error · 401 authentication_error · 402 billing_error · 403 permission_error
 *   404 not_found_error · 409 conflict_error · 413 request_too_large · 429 rate_limit_error
 *   500 api_error · 504 timeout_error · 529 overloaded_error
 * Two findings from that read are load-bearing and neither was guessable:
 *   (a) THE SPEND-CAP 429 CARRIES NO `retry-after` HEADER and keeps failing until access resumes. It is
 *       distinguished by `error.details.error_code === "enforced_spend_limit_reached"`, and its message
 *       names the resume instant. An absent `retry-after` on a 429 is therefore evidence of a WALL, not
 *       of a short rate limit — the opposite of the natural assumption.
 *   (b) A USER-SET spend limit returns 400 `invalid_request_error`, not 429, with a message beginning
 *       "You have reached your specified API usage limits". A 400 is otherwise permanent-and-not-a-wall,
 *       so without this clause a self-imposed budget cap would take the noisy failure path forever
 *       instead of the quiet skip it deserves.
 *
 * ⚠ AND THAT DOCUMENTATION IS ABOUT ONE VENDOR, SO `kind` IS A PARAMETER RATHER THAN AN ASSUMPTION.
 * Finding (a) — "an absent `retry-after` on a 429 means a WALL" — is the exact opposite of how every
 * other openai-compatible server behaves: Ollama, vLLM, LM Studio and most gateways return a bare 429
 * for ordinary back-pressure with no header at all, and OpenAI itself omits it on plenty of 429s. When
 * that inference ran for those servers, a thirty-second rate limit benched the account for an hour on
 * a one-hour probe mark, took the quiet `return 0` skip (no briefing, no visible error) and later
 * emitted a spurious recovery-outage line — precisely the failure the note at the top of
 * USAGE_WALL_RETRY_AFTER_MS says the split exists to prevent. So:
 *   • anthropic          → keep the documented inference, plus the positive signals.
 *   • openai-compatible  → a 429 is a wall ONLY on POSITIVE EVIDENCE (the spend-cap `error_code`, the
 *                          `regain access on …` sentence, or a `retry-after` longer than the whole
 *                          retry budget). Everything else stays `nonzero-exit` and is retried.
 * The WALL verdicts read `retry-after` as origin/main did (`legacyRetryAfterMs`, lenient
 * `Date.parse`; round 5 M1): an unparseable one (`"30s"`) is treated as ABSENT — on the openai-compatible
 * side that cannot conjure a wall out of a transient limit, on the anthropic side it is the documented
 * inference. The carried transient wait uses the strict RFC 9110 parse (`retryAfterMs`) instead. A
 * `retry-after` beyond `Date`'s range is a wall with no `resetAt` (round 3 L7), never a thrown RangeError —
 * the one case where the verdict differs from origin/main, which threw there.
 */
export function mapStatus(
  status: number, headers: Headers, bodyText: string, now: Date,
  kind: "anthropic" | "openai-compatible",
): StatusMapping {
  let body: Record<string, unknown> | undefined;
  try { body = JSON.parse(bodyText) as Record<string, unknown>; } catch { body = undefined; }
  const err = (body?.error ?? {}) as Record<string, unknown>;
  const message = typeof err.message === "string" ? err.message : "";
  const details = (err.details ?? {}) as Record<string, unknown>;
  const errorCode = typeof details.error_code === "string" ? details.error_code : "";

  if (status === 429) {
    const afterHeader = headers.get("retry-after");
    // TWO readings of one header (round 5 M1): the walls and `resetAt` use origin/main's lenient one (origin's verdicts,
    // except a value past `Date`'s range, where origin threw — round 3 L7); the strict RFC 9110 one is only the
    // transient wait carried to `withEntryRetry` (a gateway's odd header must not set how long an earlier entry sleeps).
    const afterMs = legacyRetryAfterMs(afterHeader, now);
    const waitMs = retryAfterMs(afterHeader, now);
    const regainAt = parseRegainAccess(message);
    // POSITIVE evidence of a wall, true for either transport: the documented spend-cap error code, or a
    // body that names the instant access resumes.
    const provenWall = errorCode === "enforced_spend_limit_reached" || regainAt !== undefined;
    // The vendor-documented INFERENCE. Anthropic only — see the ⚠ above. On origin/main's lenient reading (round 5 M1):
    // an absent or unparseable header (`"30s"`) is a wall; one `Date.parse` reads (`… +0000`, an ISO instant) is a wait.
    const inferredWall = kind === "anthropic" && afterMs === undefined;
    if (provenWall || inferredWall) {
      return { code: "usage-limit", ...(regainAt ? { resetAt: regainAt } : {}) };
    }
    if (afterMs !== undefined && afterMs > USAGE_WALL_RETRY_AFTER_MS) {
      // An absurd `retry-after` (`"99999999999999"`) lands past `Date`'s range, where `toISOString` throws a RangeError —
      // a non-ProviderError, which would stop the walk (PR 1 final review round 3, L7). It is still a wall; with no
      // reset the walk's own probe mark applies.
      const reset = new Date(now.getTime() + afterMs);
      return { code: "usage-limit", ...(Number.isFinite(reset.getTime()) ? { resetAt: reset.toISOString() } : {}) };
    }
    // transient: the retry schedule outlasts it. A parsed `retry-after` rides along (provider fallback):
    // an earlier walk entry waits that long instead of its fixed ~5 s when it is short enough.
    return { code: "nonzero-exit", ...(waitMs !== undefined ? { retryAfterMs: waitMs } : {}) };
  }

  if (status === 400 && /You have reached your specified (workspace )?API usage limits/i.test(message)) {
    return { code: "usage-limit", ...(parseRegainAccess(message) ? { resetAt: parseRegainAccess(message)! } : {}) };
  }

  // 402 Payment Required — Anthropic's `billing_error`, and the same meaning on every other vendor: the
  // credits ran out. That is a WALL, not a permanent defect, and it belongs on the same path as the 400
  // usage-limit clause directly above: the quiet skip, one account mark, and a recovery-outage line when
  // it lifts. Mapping it to `missing-binary` gave it the loud permanent-failure path instead — a
  // `Briefing provider failed` line every 600 s tick forever, with no mark, no recovery line and nothing
  // core.ts's limit machinery could see. DELIBERATELY NO `resetAt`: a top-up has no schedule, so core.ts's
  // one-hour probe mark is exactly the right fallback here.
  if (status === 402) return { code: "usage-limit" };

  // Provider fallback: a prompt too long for THIS model is permanent here and tells the walk to move on
  // without a mark. 413 always; a 400 only when its body names the prompt's length (the spend-cap 400
  // above is matched first and stays a wall).
  const errCode = typeof err.code === "string" ? err.code : "";
  if (status === 413 || (status === 400 && (PROMPT_LENGTH_RE.test(message) || PROMPT_LENGTH_RE.test(errCode)))) {
    return { code: "missing-binary", failCause: "prompt-too-long" };
  }

  // 408 Request Timeout and 409 conflict are the only retryable 4xx; everything else in that range is a
  // property of the request or the account and will not change within a run.
  if (status === 408 || status === 409) return { code: "nonzero-exit" };
  if (status >= 400 && status < 500) return { code: "missing-binary" };
  return { code: "nonzero-exit" };       // 5xx incl. 500/502/503/504 and 529 overloaded — all retryable
}

/**
 * POST a JSON body and return the PARSED JSON of a 2xx. Every failure leaves as a `ProviderError` whose
 * `code` is one of the frozen five; `durationMs` is stamped by the calling provider exactly as
 * `BYOCliProvider.generate` stamps it.
 */
export async function postJson(input: ApiPostInput): Promise<unknown> {
  const now = input.now ?? (() => new Date());
  const doFetch = input.fetchImpl ?? fetch;
  const ctl = new AbortController();
  // The ONLY timeout on this path. `provider.timeoutMs` bounds a spawned CLI and bounds this call the
  // same way, so the two transports share one knob and one meaning.
  const timer = setTimeout(() => ctl.abort(), input.timeoutMs);
  // The caller's deadline aborts the same controller, so every abort path below (before the headers, mid-body)
  // reads it exactly as it reads the timeout. Removed again however the call ends.
  const onCallerAbort = (): void => ctl.abort();
  if (input.signal?.aborted) { clearTimeout(timer); throw new ProviderError("timeout", `${input.label}: the attempt's deadline passed before the request was sent`); }
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    return await postJsonWith(input, ctl, timer, now, doFetch);
  } finally {
    input.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** The `timeout` for an aborted request: this call's own timeout, or the caller's deadline (P1-M3-T5). */
function abortedError(input: ApiPostInput): ProviderError {
  return input.signal?.aborted
    ? new ProviderError("timeout", `${input.label}: the attempt's deadline passed during the request`)
    : new ProviderError("timeout", `${input.label} timed out after ${input.timeoutMs}ms`);
}

async function postJsonWith(
  input: ApiPostInput, ctl: AbortController, timer: ReturnType<typeof setTimeout>, now: () => Date, doFetch: typeof fetch,
): Promise<unknown> {
  let res: Response;
  try {
    // `redirect: "error"`, never fetch's default `"follow"` (Phase E M5b checkpoint) — the same rule
    // as src/updateCheck.ts's request, for a sharper reason. MEASURED (bun 1.3.14, two loopback
    // ports, i.e. cross-origin): a followed 307/308 RE-SENDS this POST — the whole prompt — with
    // Anthropic's `x-api-key` header to whatever the Location names, and a 301/302 turns into a GET
    // that still carries `x-api-key` (bun drops only `authorization` cross-origin). A redirect now
    // REJECTS instead (an Error, code `UnexpectedRedirect`), and the catch below words it as a
    // permanent failure (`missing-binary`, see there).
    // ⚠ THE TRADE-OFF, stated in docs/CONFIG.md: an endpoint that redirects (an `http://` URL whose
    // server answers with a redirect to `https://`, a moved gateway) now fails every attempt instead
    // of silently following — `baseUrl` must name the final URL.
    res = await doFetch(input.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...input.headers },
      body: JSON.stringify(input.body),
      signal: ctl.signal,
      redirect: "error",
    });
  } catch (e) {
    clearTimeout(timer);
    if (ctl.signal.aborted) throw abortedError(input);
    // ⚠ A REFUSED REDIRECT IS WORDED HERE, NOT QUOTED: bun's message for it names the WIRE URL
    // ("UnexpectedRedirect fetching \"<url>\"…", measured), query and all — exactly what
    // `printableTarget` exists to withhold.
    // ⚠ PERMANENT, NOT RETRIED (Phase E M5b fix round 2): `missing-binary`, the code `mapStatus` gives a
    // permanent 4xx — "permanent for this run, do not retry" (see the misnomer note there). Nothing a
    // retry 45 s or 90 s later can change: the endpoint is configured to a URL that redirects, and
    // only a `baseUrl` edit fixes that. As the retryable `nonzero-exit` it cost every tick ~135 s of
    // backoff and two more requests that could only fail the same way. The next tick still tries
    // again, as it does after any permanent failure.
    if ((e as { code?: unknown } | null)?.code === "UnexpectedRedirect") {
      const refused = new ProviderError("missing-binary", `${input.label}: ${printableTarget(input.url)} answered with a redirect, which is not followed — the prompt and the key are never re-sent to another address. Set baseUrl to the final URL.`);
      refused.failCause = "redirect-refused";
      throw refused;
    }
    // Connect refused, DNS failure, TLS failure. Retryable: a wake-before-wifi morning looks exactly
    // like this, and it is the case the whole retry schedule exists for.
    // ⚠ `printableTarget`, NEVER `input.url` — the wire URL keeps the configured query, which can carry
    // a credential. See `printableTarget`.
    throw new ProviderError("nonzero-exit", `${input.label}: request to ${printableTarget(input.url)} failed — ${diagnostic(e instanceof Error ? e.message : String(e), input.secret)}`);
  }

  let read: { text: string; complete: boolean };
  try { read = await readCapped(res, input.maxBytes ?? MAX_RESPONSE_BYTES); }
  finally { clearTimeout(timer); }
  const text = read.text;

  // ⚠ CHECKED BEFORE ANYTHING PARSES. The abort can fire AFTER the response headers arrive — a wedged
  // gateway or a dropped connection on a long generation sends headers and then stalls mid-body, which
  // is the shape this capped streaming reader exists for. Without this the read ended early, the partial
  // body failed to parse, and the run reported "HTTP 200 but the body is not JSON" with a truncated body
  // prefix: the timeout misattributed to the server's JSON, and the one knob the operator could actually
  // raise never named. `complete` distinguishes our abort from a body that genuinely was not JSON.
  if (!read.complete && ctl.signal.aborted) {
    throw abortedError(input);
  }

  // An errored/capped read may end halfway through ANY credential shape, before its delimiter or
  // minimum length. Withhold the final token before shape/literal redaction; whitespace proves the
  // preceding token ended. With no whitespace the entire partial text is withheld. Keep `text` for
  // status classification/parsing, so diagnostic minimisation does not change provider semantics.
  const diagnosticText = read.complete ? text : dropTrailingPartialToken(text);

  if (!res.ok) {
    const { code, resetAt, failCause, retryAfterMs: afterMs } = mapStatus(res.status, res.headers, text, now(), input.kind);
    const err = new ProviderError(code, `${input.label}: HTTP ${res.status} — ${diagnostic(diagnosticText, input.secret) || "(no body)"}`);
    if (resetAt !== undefined) err.resetAt = resetAt;
    if (failCause !== undefined) err.failCause = failCause;
    if (afterMs !== undefined) err.retryAfterMs = afterMs;
    err.httpStatus = res.status;
    throw err;
  }

  try { return JSON.parse(text) as unknown; }
  catch {
    // A 200 whose body is not JSON is a proxy, a captive portal or a gateway error page. Retryable: it
    // is far more often a transient piece of network furniture than a permanent condition.
    const err = new ProviderError("nonzero-exit", `${input.label}: HTTP 200 but the body is not JSON — ${diagnostic(diagnosticText, input.secret) || "(empty body)"}`);
    err.httpStatus = res.status;
    throw err;
  }
}
