// test/fakeApi.test.ts — A3/T12. The harness's own tests.
//
// Every prompt-byte-identity assertion in the two provider suites rests on this file's capture being
// exact. A harness that silently re-serialized the body would make those assertions pass while proving
// nothing — so the capture, the port allocation and the shutdown are pinned here, first.
import { test, expect, afterEach } from "bun:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Glob } from "bun";
import { startFakeApi, openFakeApis, okJson, status, badJson, slow, sse } from "./helpers/fakeApi";

const started: { stop(): Promise<void> }[] = [];
afterEach(async () => { while (started.length) await started.pop()!.stop(); });
const track = async (h: Parameters<typeof startFakeApi>[0]) => {
  const s = await startFakeApi(h);
  started.push(s);
  return s;
};

test("two servers started concurrently get DIFFERENT ephemeral ports", async () => {
  const [a, b] = await Promise.all([track(okJson({ a: 1 })), track(okJson({ b: 2 }))]);
  expect(a.origin).not.toBe(b.origin);
  // …and both actually answer, so "different" is not "one of them failed to bind".
  expect(await (await fetch(a.origin)).json()).toEqual({ a: 1 });
  expect(await (await fetch(b.origin)).json()).toEqual({ b: 2 });
});

test("the captured body is BYTE-EQUAL to what was sent — the mechanism the byte-identity assertions rest on", async () => {
  const s = await track(okJson({ ok: true }));
  // Deliberately awkward bytes: a CRLF, a tab, a lone emoji, a NBSP, trailing whitespace and a
  // character that JSON.stringify would re-escape differently if anything re-serialized on the way.
  const payload = JSON.stringify({ prompt: "line one\r\n\tline two  🌅 \\\" end  " });
  await fetch(`${s.origin}/v1/messages`, { method: "POST", body: payload, headers: { "content-type": "application/json" } });
  expect(s.requests).toHaveLength(1);
  expect(s.requests[0]!.bodyText).toBe(payload);
  expect(s.requests[0]!.method).toBe("POST");
  expect(s.requests[0]!.path).toBe("/v1/messages");
  expect(s.requests[0]!.headers["content-type"]).toBe("application/json");
});

test("the capture happens BEFORE the handler, so a throwing handler still leaves the bytes behind", async () => {
  const s = await track(() => { throw new Error("handler exploded"); });
  const res = await fetch(`${s.origin}/x`, { method: "POST", body: "the-bytes" });
  expect(res.status).toBe(500);                   // contained by the harness's `error` hook
  expect(s.requests.at(0)?.bodyText).toBe("the-bytes");

  // ⚠ BOTH ARMS, because they take DIFFERENT PATHS through the shutdown race and only one of them is
  // the arm that race rewired. A synchronous throw never reaches `Promise.race` at all — the handler
  // is evaluated before the race is constructed — so the case above pins the pre-race path. An ASYNC
  // rejection is the one that flows through the race and must still reach `error()`.
  s.setHandler(async () => { throw new Error("handler exploded later"); });
  const late = await fetch(`${s.origin}/y`, { method: "POST", body: "more-bytes" });
  expect(late.status).toBe(500);
  expect(s.requests.at(1)?.bodyText).toBe("more-bytes");
});

test("setHandler swaps behaviour mid-test, and the query string survives into `path`", async () => {
  const s = await track(status(503, "down"));
  expect((await fetch(`${s.origin}/a?b=c`)).status).toBe(503);
  s.setHandler(okJson({ up: true }));
  expect((await fetch(`${s.origin}/a?b=c`)).status).toBe(200);
  expect(s.requests.map((r) => r.path)).toEqual(["/a?b=c", "/a?b=c"]);
});

test("stop(true) really closes the listener — a later fetch FAILS", async () => {
  const s = await startFakeApi(okJson({ ok: true }));
  const origin = s.origin;
  expect((await fetch(origin)).status).toBe(200);
  await s.stop();
  await expect(fetch(origin)).rejects.toThrow();
});

test("⚠ stop() RELEASES a handler that never answers — the teardown cannot WAIT on one", async () => {
  // THE FLAKE THIS PINS. `core.api-provider.test.ts`'s T6 serves a handler that never resolves and
  // relies on the CLIENT aborting; its `afterEach` then stops the server, and `server.stop(true)` can
  // wait on that unsettled handler forever. Measurement, CI run and the hook-budget rule are in
  // property 3 of `helpers/fakeApi.ts` — deliberately NOT restated here, because the version of this
  // comment that did restate them shipped the same wrong number in four places at once.
  //
  // ⚠ WHY THE FLAG AND NOT THE CLOCK, stated correctly. `expect(elapsed).toBeLessThan(…)` would ALSO
  // fail today — with `releaseParked()` removed this test hangs deterministically every run, burning
  // the body's 5000 ms here and then the `afterEach`'s 5000 ms on the second stop(); it is not 1 run
  // in 320 (that rate belongs to T6's incidental shape; this test forces the park by construction).
  // So the flag buys no faster or more reliable failure TODAY. What it buys is that the
  // test cannot go VACUOUS LATER: if a future bun cancels the handler on client abort, or the request
  // stops landing, nothing is parked, `stop()` is trivially fast, and a timing assertion goes green
  // while proving nothing. The flag fails instead, because the release it names never fired.
  const s = await track(() => new Promise<Response>(() => {}));
  const ctl = new AbortController();
  const reqDone = fetch(s.origin, { method: "POST", body: "x", signal: ctl.signal }).catch(() => "aborted");
  // Polled, not slept: a fixed sleep is the same class of bet on a loaded machine that this test exists
  // to remove, and a request that never landed would make the park — and so the assertion — vacuous.
  // ⚠ The 2 s deadline IS itself a wall-clock bound, in a test about removing those. It is bounded
  // deliberately: landing measures ~7 ms, so the headroom is ~280×, and blowing it yields a plain
  // assertion failure at the line below rather than a hang — the failure mode this file exists to avoid.
  const deadline = Date.now() + 2_000;
  while (s.requests.length === 0 && Date.now() < deadline) await Bun.sleep(5);
  expect(s.requests).toHaveLength(1);
  ctl.abort();
  await reqDone;
  expect(s.releasedParked).toBe(false);      // the client is gone; the handler is STILL parked
  await s.stop();                            // …and the afterEach's second stop() is a no-op
  expect(s.releasedParked).toBe(true);       // only the shutdown's release ended it
});

test("the registry drains — a stopped server is no longer counted as live", async () => {
  const before = openFakeApis();
  const s = await startFakeApi(okJson({}));
  expect(openFakeApis()).toBe(before + 1);
  await s.stop();
  expect(openFakeApis()).toBe(before);
});

test("the canned handlers produce the shapes the mapping tables need", async () => {
  const s = await track(badJson());
  const bad = await fetch(s.origin);
  expect(bad.status).toBe(200);
  await expect(bad.json()).rejects.toThrow();     // an unparseable 200, as advertised

  s.setHandler(sse());
  expect(await (await fetch(s.origin)).text()).toContain("event: message_start");

  s.setHandler(status(429, { error: { type: "rate_limit_error" } }, { "retry-after": "30" }));
  const limited = await fetch(s.origin);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("30");

  const t0 = Date.now();
  s.setHandler(slow(60));
  await fetch(s.origin);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
});

// ── the lifecycle guard ───────────────────────────────────────────────────────────────────────────
test("every test file that starts a fake server also shuts one down", async () => {
  // The harness's stated contract is "stop() from an afterEach or a finally". A contract nobody can see
  // broken is one that breaks: a leaked listener does not fail a test, it makes some LATER file flaky on
  // a busy machine and the blame lands on the provider code. So the contract is asserted statically.
  const testDir = resolve(import.meta.dir);
  const files: string[] = [];
  for await (const f of new Glob("**/*.test.ts").scan({ cwd: testDir })) files.push(f);
  // Floor, so a broken glob fails loudly rather than passing over an empty set.
  expect(files.length).toBeGreaterThanOrEqual(105);

  const users: string[] = [];
  const offenders: string[] = [];
  for (const rel of files) {
    const abs = resolve(testDir, rel);
    const src = readFileSync(abs, "utf8");
    // Resolve one level of test-local helper import, so a file that wraps startFakeApi in its own
    // helper is still seen (the shape `sourceWithHelpers` uses in isolation.meta.test.ts).
    let union = src;
    for (const m of src.matchAll(/from\s*["'](\.[^"']+)["']/g)) {
      for (const cand of [m[1]!, `${m[1]!}.ts`]) {
        const p = resolve(dirname(abs), cand);
        if (p.startsWith(testDir) && existsSync(p) && statSync(p).isFile()) { union += `\n${readFileSync(p, "utf8")}`; break; }
      }
    }
    if (!/\bstartFakeApi\s*\(/.test(union)) continue;
    users.push(rel);
    if (!/\bafterEach\s*\(/.test(src) && !/\bfinally\s*\{/.test(src)) {
      offenders.push(`${rel} starts a fake API server but has neither an afterEach nor a finally — a leaked listener becomes a flaky failure in a DIFFERENT file`);
    }
  }
  expect(offenders).toEqual([]);
  // NOT VACUOUS: if the detector stops matching, this test would pass over an empty set while every
  // provider suite leaked. FOUR files use the harness at this commit — core.api-provider,
  // provider.anthropic, provider.openai-compat and this file — so the floor is 4, not the 2 that stood
  // here while the comment claimed three. A floor two below actual lets half the harness's users fall
  // out of the detector silently, which is the exact failure this assertion says it prevents.
  // ⚠ DELIBERATELY EXACT, unlike the `>= 105` file floor above, which carries slack on purpose because
  // test files come and go. Harness users are four named files; removing one is a real change to what
  // this guard covers, so it SHOULD turn this red and be updated here rather than pass unnoticed.
  expect(users.length).toBeGreaterThanOrEqual(4);
});
