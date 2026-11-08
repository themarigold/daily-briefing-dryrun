// test/failover.classifier.test.ts — the pure failure classifier and its reason table (src/failover.ts,
// provider-fallback plan P1-M3-T2; spec r9 §5 step 5).
//
// One case per table row, built as the transports really build their errors (mapStatus for HTTP, the
// failCause tags from P1-M3-T1), so the classifier is tested against what reaches it.
import { test, expect, describe } from "bun:test";
import { ProviderError, type FailCause, type ProviderErrorCode } from "../src/types";
import { mapStatus } from "../src/providers/http";
import { FAILOVER_REASONS, failoverReason, isRetryableFailure, reasonWording, type FailoverReason } from "../src/failover";

function err(code: ProviderErrorCode, o: { httpStatus?: number; failCause?: FailCause; retryAfterMs?: number; message?: string } = {}): ProviderError {
  const e = new ProviderError(code, o.message ?? "provider text that must never reach a wording");
  if (o.httpStatus !== undefined) e.httpStatus = o.httpStatus;
  if (o.failCause !== undefined) e.failCause = o.failCause;
  if (o.retryAfterMs !== undefined) e.retryAfterMs = o.retryAfterMs;
  return e;
}

/** An HTTP error exactly as postJson builds it from a status and a body. */
function http(status: number, body: unknown = {}, headers: Record<string, string> = {}): ProviderError {
  const m = mapStatus(status, new Headers(headers), JSON.stringify(body), new Date("2026-10-16T07:20:00Z"), "anthropic");
  const e = err(m.code, { httpStatus: status, ...(m.failCause ? { failCause: m.failCause } : {}), ...(m.retryAfterMs !== undefined ? { retryAfterMs: m.retryAfterMs } : {}) });
  if (m.resetAt) e.resetAt = m.resetAt;
  return e;
}

describe("one case per table row", () => {
  const rows: [FailoverReason, ProviderError, "cli" | "anthropic" | "openai-compatible"][] = [
    ["usage", err("usage-limit"), "cli"],
    ["usage", http(429), "anthropic"],                                   // the 429 wall
    ["usage", http(402), "anthropic"],
    ["usage", http(400, { error: { message: "You have reached your specified API usage limits." } }), "anthropic"],
    ["rate-limited", http(429, {}, { "retry-after": "20" }), "anthropic"],
    ["auth", http(401), "anthropic"],
    ["auth", http(403), "openai-compatible"],
    ["key-unavailable", err("missing-binary", { failCause: "key-missing" }), "anthropic"],
    ["not-installed", err("missing-binary", { failCause: "enoent" }), "cli"],
    ["not-found", http(404), "anthropic"],
    ["prompt-too-long", http(413), "anthropic"],
    ["prompt-too-long", http(400, { error: { message: "prompt is too long: 215000 tokens > 200000 maximum" } }), "anthropic"],
    ["rejected-request", http(400, { error: { message: "messages: field required" } }), "anthropic"],
    ["rejected-request", http(422), "openai-compatible"],
    ["rejected-request", err("missing-binary", { failCause: "redirect-refused" }), "anthropic"],
    ["unreachable", http(503), "anthropic"],
    // 408 and 409 are "other 4xx" (spec r9 §5 step 5): `rejected-request`, for the WALK. `withRetry` keeps its own
    // rule (it still retries their `nonzero-exit`), so single-entry behaviour does not depend on this classifier.
    ["rejected-request", http(408), "anthropic"],
    ["rejected-request", http(409), "openai-compatible"],
    ["rejected-request", http(418), "anthropic"],
    ["unreachable", http(529), "anthropic"],
    ["unreachable", err("nonzero-exit"), "anthropic"],                   // connect refused, DNS, TLS
    ["unreachable", err("timeout"), "anthropic"],
    ["unreachable", err("timeout"), "cli"],
    ["unreachable", err("nonzero-exit", { httpStatus: 200 }), "openai-compatible"],   // non-JSON 200
    ["empty-answer", err("empty-output"), "cli"],
    ["empty-answer", err("empty-output"), "anthropic"],
    ["cli-failure", err("nonzero-exit"), "cli"],
    ["insecure-endpoint", err("missing-binary", { failCause: "insecure-endpoint" }), "openai-compatible"],
  ];
  for (const [reason, e, kind] of rows) {
    test(`${kind}: ${e.code}${e.httpStatus ? ` HTTP ${e.httpStatus}` : ""}${e.failCause ? ` (${e.failCause})` : ""} → ${reason}`, () => {
      expect(failoverReason(e, kind)).toBe(reason);
    });
  }

  test("every reason the classifier returns, plus unusable-answer (the walk's own), is a table row — thirteen", () => {
    const fromErrors = new Set(rows.map(([r]) => r));
    expect([...fromErrors, "unusable-answer"].sort()).toEqual(Object.keys(FAILOVER_REASONS).sort());
    expect(Object.keys(FAILOVER_REASONS).length).toBe(13);
  });
});

describe("the distinctions the table exists for", () => {
  test("two 400s that differ only by body classify differently", () => {
    const tooLong = http(400, { error: { message: "prompt is too long: 9 tokens > 8 maximum" } });
    const plain = http(400, { error: { message: "unknown field" } });
    expect([failoverReason(tooLong, "anthropic"), failoverReason(plain, "anthropic")]).toEqual(["prompt-too-long", "rejected-request"]);
  });

  test("a timeout is unreachable and NOT retryable, while a 5xx is retryable", () => {
    expect(failoverReason(err("timeout"), "anthropic")).toBe("unreachable");
    expect(isRetryableFailure(err("timeout"), "anthropic")).toBe(false);
    expect(isRetryableFailure(err("timeout"), "cli")).toBe(false);
    expect(isRetryableFailure(http(503), "anthropic")).toBe(true);
    expect(isRetryableFailure(err("nonzero-exit"), "anthropic")).toBe(true);
  });

  test("retryable: unreachable (not a timeout), rate-limited, empty-answer, cli-failure — and nothing else", () => {
    const retryable = Object.entries(FAILOVER_REASONS).filter(([, r]) => r.retryable).map(([k]) => k).sort();
    expect(retryable).toEqual(["cli-failure", "empty-answer", "rate-limited", "unreachable"]);
    expect(isRetryableFailure(http(429, {}, { "retry-after": "20" }), "anthropic")).toBe(true);
    expect(isRetryableFailure(err("empty-output"), "cli")).toBe(true);
    expect(isRetryableFailure(err("nonzero-exit"), "cli")).toBe(true);
    for (const e of [http(401), http(404), http(413), err("usage-limit"), err("missing-binary", { failCause: "key-missing" })]) {
      expect(isRetryableFailure(e, "anthropic")).toBe(false);
    }
  });

  test("a 429 wall is usage", () => {
    expect(failoverReason(http(429), "anthropic")).toBe("usage");
  });

  test("failCause insecure-endpoint on missing-binary reads insecure-endpoint", () => {
    expect(failoverReason(err("missing-binary", { failCause: "insecure-endpoint" }), "anthropic")).toBe("insecure-endpoint");
  });
});

describe("the table", () => {
  test("is frozen, row by row", () => {
    expect(Object.isFrozen(FAILOVER_REASONS)).toBe(true);
    for (const r of Object.values(FAILOVER_REASONS)) expect(Object.isFrozen(r)).toBe(true);
  });

  test("mark classes are the spec's", () => {
    const marks = Object.fromEntries(Object.entries(FAILOVER_REASONS).map(([k, r]) => [k, r.mark]));
    expect(marks).toEqual({
      "usage": "usage", "rate-limited": "none", "auth": "hour-non-first", "key-unavailable": "hour-non-first",
      "not-installed": "hour-non-first", "not-found": "hour-non-first", "prompt-too-long": "none",
      "rejected-request": "none", "unreachable": "none", "empty-answer": "none", "unusable-answer": "hour-non-first",
      "cli-failure": "hour-non-first-claude-login", "insecure-endpoint": "none",
    });
  });

  test("wordings never interpolate provider text: only {until} and {status}, filled from structured fields", () => {
    for (const [k, r] of Object.entries(FAILOVER_REASONS)) {
      expect(`${k}: ${(r.wording.match(/\{[^}]*\}/g) ?? []).filter((p) => p !== "{until}" && p !== "{status}").join(",")}`).toBe(`${k}: `);
    }
    expect(reasonWording("usage", { until: "08:00" })).toBe("out of usage until 08:00");
    expect(reasonWording("rejected-request", { httpStatus: 422 })).toBe("request rejected (HTTP 422)");
    // No status: no "(HTTP ?)"; a refused redirect says so (P1-M3 checkpoint LOW).
    expect(reasonWording("rejected-request")).toBe("request rejected");
    expect(reasonWording("rejected-request", { failCause: "redirect-refused" })).toBe("redirect refused");
    expect(reasonWording("unreachable")).toBe("unreachable");
    // A provider message never reaches a wording, whatever it says.
    const e = err("nonzero-exit", { message: "SECRET-BODY-TEXT" });
    expect(reasonWording(failoverReason(e, "cli"))).not.toContain("SECRET");
  });
});
