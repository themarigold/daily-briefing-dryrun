// test/helpers/netGuard.ts — A3. THE SUITE MUST NOT TALK TO THE INTERNET.
//
// WHY THIS EXISTS AS A MECHANISM RATHER THAN A CONVENTION. Before this guard, one provider test built
// an `api: { kind: "anthropic", model: "m", apiKeyEnv: … }` config with NO baseUrl and NO injected
// `fetchImpl`, then called `generate()`. An absent baseUrl on the anthropic kind means the PRODUCTION
// DEFAULT, so every `bun test` run made a real POST to https://api.anthropic.com/v1/messages carrying a
// secret-shaped sentinel in an `x-api-key` header — and the test's own comment said "the endpoint is
// unreachable; the failure is irrelevant". Nothing was red, because the transport turns a failed
// request into exactly the error the test was ignoring. A convention cannot catch that; the failure
// mode of getting it wrong is silence.
//
// TWO SOCKETS ARE COVERED, because the provider stack opens two different kinds:
//   • `fetch` — the transports (src/providers/http.ts).
//   • `Bun.connect` — the network gate's TCP probe (src/net.ts), reached whenever a test lets the real
//     `defaultNetProbe` run over a derived host list. A hostname there is resolved by the machine's
//     DNS before anything is refused, so even a guaranteed-unroutable name is an outbound lookup.
//
// LOOPBACK IS ALLOWED, and only loopback: `startFakeApi` binds 127.0.0.1, which is the whole point of
// having a fake server. The definition is deliberately the SAME one production uses
// (`isLoopbackHost`), so the guard cannot drift from the code it polices.
//
// ⚠ SCOPE: the API test files install it. `test/net.test.ts` deliberately connects to RFC 5737
// TEST-NET and RFC 5737-reserved addresses to prove the probe's timeout race, which is a different
// contract and is left alone.
import { expect, afterAll } from "bun:test";
import { isLoopbackHost } from "../../src/providers/endpoint";

export type NetGuard = {
  /** Every non-loopback destination attempted, in order. Empty is the passing state. */
  readonly attempts: string[];
};

function hostOf(input: unknown): string | undefined {
  try {
    if (typeof input === "string") return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input instanceof Request) return new URL(input.url).hostname;
    const u = (input as { url?: unknown } | null)?.url;
    if (typeof u === "string") return new URL(u).hostname;
  } catch { /* an unparseable target cannot be a remote host we can name */ }
  return undefined;
}

/**
 * Call at the TOP LEVEL of an API test file. Patches `fetch` and `Bun.connect` for the whole file, and
 * fails the file in `afterAll` if anything was attempted.
 *
 * A non-loopback destination is RECORDED and then THROWN on, and both halves are needed. The throw
 * fails at the call site, which points at the offending line. The record is what makes it
 * UNSWALLOWABLE — the transports turn a failed request into exactly the retryable error these tests
 * routinely ignore, which is precisely how the original leak stayed invisible while looking green.
 */
export function guardNetworkForThisFile(): NetGuard {
  const attempts: string[] = [];
  const realFetch = globalThis.fetch;
  const realConnect = Bun.connect;

  const refuse = (what: string, host: string): never => {
    const target = `${what} → ${host}`;
    attempts.push(target);
    throw new Error(`netGuard: a test tried to reach a NON-LOOPBACK host (${target}). Point it at startFakeApi's origin, or inject a fetchImpl/netProbe.`);
  };

  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const host = hostOf(input);
    if (host !== undefined && !isLoopbackHost(host)) refuse("fetch", host);
    return (realFetch as (a: unknown, b?: unknown) => Promise<Response>)(input, init);
  }) as typeof fetch;

  Bun.connect = ((opts: unknown) => {
    const host = (opts as { hostname?: unknown })?.hostname;
    if (typeof host === "string" && host !== "" && !isLoopbackHost(host)) refuse("Bun.connect", host);
    return (realConnect as (o: unknown) => unknown)(opts);
  }) as typeof Bun.connect;

  afterAll(() => {
    globalThis.fetch = realFetch;
    Bun.connect = realConnect;
    expect(attempts).toEqual([]);
  });
  return { attempts };
}
