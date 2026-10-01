// test/helpers/fakeApi.ts — A3/T12. A real HTTP server on an ephemeral port, for the two API providers.
//
// WHY THIS IS A NEW PATTERN AND WHY IT IS BUILT FIRST. Before Slice 2 this repo contained ZERO HTTP:
// `grep -rn "Bun\.serve|await fetch|globalThis.fetch" src scripts test` matched nothing. So there was
// no house style to copy and no lifecycle convention to inherit — and the failure mode of getting it
// wrong is not a red test, it is a LEAKED LISTENER that turns into a flaky cross-file failure someone
// later misattributes to the provider code. Hence the harness lands before anything that uses it.
//
// THREE PROPERTIES, each deliberate:
//
//  1. `port: 0`. `bun test` runs files concurrently, so a fixed port is a collision waiting for a busy
//     machine. The kernel picks; the caller reads `origin` back off the server.
//  2. The request is CAPTURED BEFORE the handler runs, body included, as exact bytes. The byte-identity
//     assertions in the provider tests (the prompt reaches the wire unchanged) rest entirely on this —
//     so the capture is the thing under test in `fakeApi.test.ts`, not an incidental convenience.
//  3. `stop()` RELEASES ANY PARKED HANDLER and then calls `server.stop(true)`. Both halves are load-bearing
//     and only the second was here originally. `server.stop(true)` closes keep-alive sockets, without which
//     an idle connection holds the port and the process alive — but it still WAITS on a handler whose
//     promise has not settled, and a handler that never answers is exactly what an abort/timeout test
//     serves. MEASURED on bun 1.3.14: with a never-settling handler, `stop(true)` almost always resolves
//     in 0-1 ms; when it does not, it NEVER RETURNS — still parked when the probe gave up at 12 s. The
//     counts, not a derived rate: linux (`oven/bun:1.3.14`, `--cpus=2`) 2 hangs / 800 abort→stop cycles
//     on the pre-fix helper and 0 / 800 after, an earlier linux probe 1 / 320, and darwin reproduces it
//     unmutated too — see `docs/flake-chase-2026-09-15.md` for the arms. That is a race against the
//     client's abort, not a slow machine, and it is what turned
//     `core.api-provider.test.ts`'s T6 red on CI (run 36002014603 attempt 1): the test body finished in
//     276 ms and its `afterEach` burned bun's whole 5000 ms hook budget. ⚠ A test's own `}, 15_000)`
//     argument does NOT extend its hooks — hooks get a flat 5000 ms (measured) — so a teardown that can
//     wait on a handler is a flake no per-test timeout can cover. Racing every handler against the
//     shutdown removes the wait by construction, for every caller, rather than asking each never-answering
//     handler to remember to settle itself.
//     Callers MUST invoke `stop()` from an `afterEach` or a `finally` — statically enforced in
//     `test/fakeApi.test.ts`, because a convention nobody can see broken is a convention that breaks.
//
// Tests point `provider.api.baseUrl` at `origin`. That is a REAL config field taking a real URL — there
// is no test-only branch anywhere in `src/`, which is the property that makes these tests evidence
// about production rather than about a mock.

/** One request, exactly as it arrived. `bodyText` is the raw body — never re-serialized JSON. */
export type CapturedRequest = {
  method: string;
  /** Path plus query, e.g. `/v1/messages`. */
  path: string;
  url: string;
  /** Lower-cased header names (fetch normalizes them), so assertions need not guess the casing. */
  headers: Record<string, string>;
  bodyText: string;
};

export type FakeApiHandler = (req: CapturedRequest) => Response | Promise<Response>;

export type FakeApi = {
  /** `http://127.0.0.1:<ephemeral>` — no trailing slash. Assign straight to `provider.api.baseUrl`. */
  origin: string;
  /** Every request received, in arrival order, captured before the handler ran. */
  requests: CapturedRequest[];
  /** Swap the handler mid-test (e.g. fail once, then succeed). */
  setHandler(h: FakeApiHandler): void;
  /** True once `stop()` has released a handler that was STILL IN FLIGHT — which includes a merely-slow
   *  handler that would have answered, not only one that never would. Exposed so the release is
   *  ASSERTABLE: it is what keeps a test of this mechanism from going vacuous if the handler stops
   *  being parked (a runtime that cancels it on client abort, or a request that never lands). */
  readonly releasedParked: boolean;
  stop(): Promise<void>;
};

/** Every server this module has started and not yet stopped. Exported so the harness's own test can
 *  assert the registry drains — a leak is then a failing assertion rather than a slow, confusing suite. */
const live = new Set<FakeApi>();

/** The shutdown's private sentinel — see the race in `startFakeApi`. Module-private and unique by
 *  construction, so no handler return value can be mistaken for it however it was typed. */
const PARKED: unique symbol = Symbol("fake-api parked");
export const openFakeApis = (): number => live.size;

export async function startFakeApi(handler: FakeApiHandler): Promise<FakeApi> {
  let current = handler;
  const requests: CapturedRequest[] = [];

  // Settled by `stop()`, and raced against every handler below. A handler that never answers — the
  // shape an abort/timeout test serves — otherwise leaves a promise pending that `server.stop(true)`
  // can wait on forever; see property 3 in the header for the measurement. ⚠ It releases ANY handler
  // still in flight, not only one that would never answer: a `slow()` handler mid-sleep loses the race
  // too, which is why the two provider suites' teardown no longer sits out its 2 s sleep. No client
  // reads the 503 — `server.stop(true)` closes the socket before it can be written (measured: the
  // client sees a closed connection, not a 503).
  let releaseParked!: () => void;
  let releasedParked = false;
  const parked = new Promise<typeof PARKED>((resolve) => { releaseParked = () => resolve(PARKED); });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      // Read the body FIRST and capture unconditionally, so a handler that throws — or one that never
      // looks at the body — still leaves the bytes behind for the assertion.
      const bodyText = await req.text();
      const u = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      const captured: CapturedRequest = {
        method: req.method,
        path: `${u.pathname}${u.search}`,
        url: req.url,
        headers,
        bodyText,
      };
      requests.push(captured);
      // ⚠ RACED, NOT AWAITED DIRECTLY — what this removes is the case where the handler never settles
      // and holds the shutdown open. Error containment is unchanged in both directions: a handler that
      // REJECTS rejects the race, and one that throws SYNCHRONOUSLY never reaches the race at all
      // (`current(captured)` is evaluated before `Promise.resolve` is), so both still land on the
      // `error()` hook below. `PARKED` is the release's sentinel — module-private, so unlike `null` it
      // cannot be forged by a handler cast past `FakeApiHandler` (this suite does cast handlers, e.g.
      // `core.api-provider.test.ts`'s `as unknown as Response`), and it keeps the throwaway 503 off the
      // path of every ordinary request.
      const settled = await Promise.race([Promise.resolve(current(captured)), parked]);
      if (settled === PARKED) {
        releasedParked = true;
        return new Response("fake-api stopped", { status: 503 });
      }
      return settled;
    },
    // A handler that throws must become a 500 the client can see, NOT an unhandled server error: Bun
    // surfaces the latter as a test failure in whichever file happens to be running, which is the same
    // misattribution class the `stop(true)` rule exists to prevent. The capture above has already run.
    error() {
      return new Response("fake-api handler threw", { status: 500 });
    },
  });

  const api: FakeApi = {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    setHandler(h) { current = h; },
    get releasedParked() { return releasedParked; },
    async stop() {
      // FIRST, release anything still parked, so the shutdown below has nothing left to wait on.
      releaseParked();
      // `true` = close in-flight and idle keep-alive connections. Without it a pooled socket from a
      // previous `fetch` keeps the listener alive past the test that owned it.
      await server.stop(true);
      live.delete(api);
    },
  };
  live.add(api);
  return api;
}

// ── canned handlers ───────────────────────────────────────────────────────────────────────────────
// Deliberately thin: each is one `new Response(...)`. They exist so a status-mapping table reads as a
// table rather than as twelve inline Response constructions.

/** 200 with a JSON body. */
export const okJson = (body: unknown): FakeApiHandler => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** An arbitrary status with an arbitrary body (string as-is, object JSON-encoded). */
export const status = (code: number, body: unknown = "", headers: Record<string, string> = {}): FakeApiHandler => () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status: code, headers });

/** 200 whose body is NOT parseable JSON — the "unparseable 200" arm of the mapping. */
export const badJson = (): FakeApiHandler => () =>
  new Response("<html>gateway says hello</html>", { status: 200, headers: { "content-type": "application/json" } });

/** Sleeps `ms` before answering, so an AbortController timeout can be exercised for real. */
export const slow = (ms: number, body: unknown = { ok: true }): FakeApiHandler => async () => {
  await new Promise((r) => setTimeout(r, ms));
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

/** An SSE-shaped 200. Pins that the non-streaming path treats it as an unparseable body rather than
 *  silently half-understanding it — this design explicitly does not do streaming. */
export const sse = (): FakeApiHandler => () =>
  new Response("event: message_start\ndata: {\"type\":\"message_start\"}\n\n", {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
