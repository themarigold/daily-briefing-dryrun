// test/provider.entry-retry.test.ts — `withEntryRetry`, an earlier walk entry's one quick retry (provider-fallback
// plan P1-M3-T4; spec r9 §5). Driven with an injected sleeper and clock: nothing here waits for real.
import { test, expect, describe } from "bun:test";
import { ENTRY_RETRY_DELAY_MS, withEntryRetry } from "../src/provider";
import { ProviderError, LostLockError, type ProviderErrorCode } from "../src/types";

/** A clock advanced by the fake attempts, and a sleeper that records instead of waiting. */
function harness() {
  let t = Date.parse("2026-10-16T07:20:00Z");
  const sleeps: number[] = [];
  return {
    now: () => new Date(t),
    advance: (ms: number) => { t += ms; },
    sleeper: async (ms: number) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

/** `fn` that fails with each error in turn (advancing the clock by its duration), then returns "ok". */
function failing(h: ReturnType<typeof harness>, fails: { code: ProviderErrorCode; tookMs?: number; retryAfterMs?: number; httpStatus?: number }[]) {
  let calls = 0;
  const fn = async (): Promise<string> => {
    const f = fails[calls++];
    if (!f) return "ok";
    h.advance(f.tookMs ?? 100);
    const e = new ProviderError(f.code, "x");
    if (f.retryAfterMs !== undefined) e.retryAfterMs = f.retryAfterMs;
    if (f.httpStatus !== undefined) e.httpStatus = f.httpStatus;
    throw e;
  };
  return { fn, calls: () => calls };
}

describe("withEntryRetry", () => {
  test("a fast retryable failure is retried ONCE after ~5 s", async () => {
    const h = harness();
    const f = failing(h, [{ code: "nonzero-exit", tookMs: 900 }]);
    expect(await withEntryRetry(f.fn, h.sleeper, h.now, "anthropic")).toBe("ok");
    expect(f.calls()).toBe(2);
    expect(h.sleeps).toEqual([ENTRY_RETRY_DELAY_MS]);
    expect(ENTRY_RETRY_DELAY_MS).toBe(5_000);
  });

  test("only once: a second failure is thrown, not retried again", async () => {
    const h = harness();
    const f = failing(h, [{ code: "nonzero-exit" }, { code: "empty-output" }]);
    await expect(withEntryRetry(f.fn, h.sleeper, h.now, "cli")).rejects.toMatchObject({ code: "empty-output" });
    expect(f.calls()).toBe(2);
  });

  test("retryAfterMs ≤ 30 s is waited instead; > 30 s moves on with no retry", async () => {
    const h = harness();
    const f = failing(h, [{ code: "nonzero-exit", httpStatus: 429, retryAfterMs: 20_000 }]);
    expect(await withEntryRetry(f.fn, h.sleeper, h.now, "anthropic")).toBe("ok");
    expect(h.sleeps).toEqual([20_000]);
    const h30 = harness();
    const at = failing(h30, [{ code: "nonzero-exit", httpStatus: 429, retryAfterMs: 30_000 }]);
    expect(await withEntryRetry(at.fn, h30.sleeper, h30.now, "anthropic")).toBe("ok");
    expect(h30.sleeps).toEqual([30_000]);
    const h2 = harness();
    const g = failing(h2, [{ code: "nonzero-exit", httpStatus: 429, retryAfterMs: 31_000 }]);
    await expect(withEntryRetry(g.fn, h2.sleeper, h2.now, "anthropic")).rejects.toMatchObject({ retryAfterMs: 31_000 });
    expect([g.calls(), h2.sleeps]).toEqual([1, []]);
  });

  test("no retry after a timeout, a non-retryable reason, or an attempt of 60 s or more", async () => {
    const cases: [string, { code: ProviderErrorCode; tookMs?: number; httpStatus?: number }][] = [
      ["timeout", { code: "timeout", tookMs: 120_000 }],
      // A FAST timeout too (P1-M3 checkpoint LOW): the slow one above is also stopped by the 60 s gate, so on
      // its own it cannot show the timeout exception at all.
      ["fast timeout", { code: "timeout", tookMs: 100 }],
      ["auth (401)", { code: "missing-binary", httpStatus: 401 }],
      ["usage", { code: "usage-limit" }],
      ["a 5xx that took 60 s", { code: "nonzero-exit", httpStatus: 503, tookMs: 60_000 }],
    ];
    for (const [name, fail] of cases) {
      const h = harness();
      const f = failing(h, [fail]);
      await expect(withEntryRetry(f.fn, h.sleeper, h.now, "anthropic")).rejects.toBeInstanceOf(ProviderError);
      expect(`${name}: calls ${f.calls()}, sleeps ${h.sleeps.length}`).toBe(`${name}: calls 1, sleeps 0`);
    }
    // …and just under 60 s still retries.
    const h = harness();
    const f = failing(h, [{ code: "nonzero-exit", httpStatus: 503, tookMs: 59_999 }]);
    expect(await withEntryRetry(f.fn, h.sleeper, h.now, "anthropic")).toBe("ok");
  });

  test("a non-ProviderError is rethrown at once", async () => {
    const h = harness();
    let calls = 0;
    await expect(withEntryRetry(async () => { calls++; throw new LostLockError(); }, h.sleeper, h.now, "cli")).rejects.toBeInstanceOf(LostLockError);
    await expect(withEntryRetry(async () => { calls++; throw new TypeError("bug"); }, h.sleeper, h.now, "cli")).rejects.toBeInstanceOf(TypeError);
    expect([calls, h.sleeps]).toEqual([2, []]);
  });
});

describe("LostLockError", () => {
  test("is a plain Error subclass, never a ProviderError", () => {
    const e = new LostLockError();
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ProviderError);
    expect(e.name).toBe("LostLockError");
  });
});
