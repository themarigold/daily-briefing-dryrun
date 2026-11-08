// test/provider.cancel.test.ts — the attempt-deadline cancellation seam (provider-fallback plan P1-M3-T5; spec r9
// §5 step 4). An aborted `GenerateOpts.signal` stops an attempt: after key resolution, before the POST, during
// the POST, and on a CLI's child. With no signal, nothing changes.
//
// Against a real local HTTP server (test/helpers/fakeApi.ts) and real children; key commands go through an
// injected exec, so nothing here spawns a key helper.
import "./fixtures/isolate-state";   // hardenedProvider( below can reach <state>/provider-cwd without a stateDir
import { test, expect, afterEach, describe } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { startFakeApi, okJson, slow, type FakeApiHandler } from "./helpers/fakeApi";
import { hardenedProvider } from "../src/harden";
import { postJson } from "../src/providers/http";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { AnthropicApiProvider, ANTHROPIC_DEFAULT_MAX_TOKENS } from "../src/providers/anthropic";
import { OpenAiCompatibleProvider } from "../src/providers/openaiCompatible";
import { BYOCliProvider, KILL_GRACE_MS } from "../src/provider";
import { ProviderError, type ProviderApi } from "../src/types";
import type { RunOpts, RunResult } from "../src/proc";

guardNetworkForThisFile();

const servers: { stop(): Promise<void> }[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });
const serve = async (h: FakeApiHandler) => { const s = await startFakeApi(h); servers.push(s); return s; };

const KEY = "sk-ant-api03-ZZcancelSENTINEL-0000";
const textBody = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const api = (origin: string, extra: Partial<ProviderApi> = {}): ProviderApi =>
  ({ kind: "anthropic", model: "claude-sonnet-5", baseUrl: origin, apiKeyEnv: "K", ...extra });

/** A key helper the test releases by hand: `exec` resolves only when `release()` is called. */
function heldKey() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const calls: string[][] = [];
  const exec = async (argv: string[], _o?: RunOpts): Promise<RunResult> => {
    calls.push(argv);
    await gate;
    return { out: `${KEY}\n`, err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false };
  };
  return { exec, release: () => release(), calls };
}

const fail = (p: Promise<unknown>): Promise<ProviderError> => p.then(() => { throw new Error("did not throw"); }, (x) => x as ProviderError);

describe("an HTTP attempt", () => {
  test("a key that resolves after the signal fired sends no request", async () => {
    const s = await serve(okJson(textBody("out")));
    const k = heldKey();
    const p = new AnthropicApiProvider(api(s.origin, { apiKeyEnv: undefined, apiKeyCommand: ["helper"] }), { env: {}, keyOpts: { exec: k.exec } });
    const ctl = new AbortController();
    const attempt = fail(p.generate("p", { signal: ctl.signal }));
    await Bun.sleep(20);
    expect(k.calls.length).toBe(1);          // the key read is under way
    ctl.abort();
    k.release();
    const e = await attempt;
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.code).toBe("timeout");
    expect(s.requests).toHaveLength(0);
  });

  test("an already-aborted signal sends nothing (openai-compatible, keyless loopback)", async () => {
    const s = await serve(okJson({ choices: [{ message: { content: "x" } }] }));
    const p = new OpenAiCompatibleProvider({ kind: "openai-compatible", model: "m", baseUrl: s.origin }, { env: {} });
    const ctl = new AbortController();
    ctl.abort();
    expect((await fail(p.generate("p", { signal: ctl.signal }))).code).toBe("timeout");
    expect(s.requests).toHaveLength(0);
  });

  test("a signal fired during the POST aborts it", async () => {
    const s = await serve(slow(5_000, textBody("late")));
    const p = new AnthropicApiProvider(api(s.origin), { env: { K: KEY }, timeoutMs: 30_000 });
    const ctl = new AbortController();
    const started = performance.now();
    setTimeout(() => ctl.abort(), 150);
    const e = await fail(p.generate("p", { signal: ctl.signal }));
    expect(e.code).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(s.requests).toHaveLength(1);
  });

  test("an entry whose key resolves after the deadline AND after a later entry already won sends nothing", async () => {
    const s = await serve(okJson(textBody("winner")));
    const k = heldKey();
    const late = new AnthropicApiProvider(api(s.origin, { apiKeyEnv: undefined, apiKeyCommand: ["helper"] }), { env: {}, keyOpts: { exec: k.exec } });
    const next = new AnthropicApiProvider(api(s.origin), { env: { K: KEY } });
    const deadline = new AbortController();
    const first = fail(late.generate("p", { signal: deadline.signal }));
    await Bun.sleep(20);
    deadline.abort();                                     // the walk's per-attempt deadline passes…
    expect(await next.generate("p")).toBe("winner");      // …the next entry runs and wins…
    expect(s.requests).toHaveLength(1);
    k.release();                                          // …and only then does the stuck key read return
    expect((await first).code).toBe("timeout");
    await Bun.sleep(50);
    expect(s.requests).toHaveLength(1);                   // the late entry sent nothing
  });

  test("with no signal, the request bytes are identical to today's (and to an unfired signal's)", async () => {
    const s = await serve(okJson(textBody("out")));
    const p = () => new AnthropicApiProvider(api(s.origin), { env: { K: KEY } });
    await p().generate("the prompt");
    await p().generate("the prompt", { signal: new AbortController().signal });
    const [a, b] = s.requests;
    expect(a!.bodyText).toBe(JSON.stringify({ model: "claude-sonnet-5", max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS, messages: [{ role: "user", content: "the prompt" }] }));
    expect(b!.bodyText).toBe(a!.bodyText);
    expect(b!.headers).toEqual(a!.headers);
    expect(b!.path).toBe(a!.path);
  });
});

describe("a CLI attempt", () => {
  test("is killed on the signal well within KILL_GRACE_MS", async () => {
    const p = new BYOCliProvider({ cli: "sh", argv: ["-c", "sleep 30"], promptVia: "stdin" }, { flushMs: 100 });
    const ctl = new AbortController();
    const started = performance.now();
    setTimeout(() => ctl.abort(), 150);
    const e = await fail(p.generate("p", { signal: ctl.signal }));
    expect(e.code).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(KILL_GRACE_MS);
  });

  test("a child that ignores SIGTERM is SIGKILLed after the grace", async () => {
    const p = new BYOCliProvider({ cli: "sh", argv: ["-c", 'trap "" TERM; sleep 30'], promptVia: "stdin" }, { flushMs: 100, killGraceMs: 300 });
    const ctl = new AbortController();
    const started = performance.now();
    setTimeout(() => ctl.abort(), 150);
    expect((await fail(p.generate("p", { signal: ctl.signal }))).code).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test("an already-aborted signal spawns nothing", async () => {
    const p = new BYOCliProvider({ cli: "definitely-not-a-real-cli-xyz", argv: [], promptVia: "stdin" });
    const ctl = new AbortController();
    ctl.abort();
    const e = await fail(p.generate("p", { signal: ctl.signal }));
    expect(e.code).toBe("timeout");        // not missing-binary: no spawn was attempted
  });

  test("with no signal, a CLI attempt is unchanged", async () => {
    const p = new BYOCliProvider({ cli: "echo", argv: [], promptVia: "arg" });
    expect(await p.generate("hello")).toBe("hello\n");
    expect(await p.generate("hello", { signal: new AbortController().signal })).toBe("hello\n");
  });
});

// ── P1-M3 checkpoint: through the hardened provider, and the listener/double-fire seams ──────────────────

/** Wrap `signal`'s add/removeEventListener so a test can see which "abort" listeners were left attached. */
function spied(signal: AbortSignal) {
  const added: EventListenerOrEventListenerObject[] = [], removed: EventListenerOrEventListenerObject[] = [];
  const add = signal.addEventListener.bind(signal), rem = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((t: string, l: EventListenerOrEventListenerObject, o?: unknown) => { if (t === "abort") added.push(l); add(t, l, o as AddEventListenerOptions); }) as typeof signal.addEventListener;
  signal.removeEventListener = ((t: string, l: EventListenerOrEventListenerObject, o?: unknown) => { if (t === "abort") removed.push(l); rem(t, l, o as EventListenerOptions); }) as typeof signal.removeEventListener;
  return { added, removed, leftAttached: () => added.filter((l) => !removed.includes(l)) };
}

describe("the hardened provider passes the deadline to every spawn", () => {
  test("hardenedProvider(<sh fake>).generate(p, {signal}) kills the child on abort", async () => {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cancel-hp-")));
    const hp = hardenedProvider({ cli: "sh", argv: ["-c", "sleep 30"], promptVia: "stdin" }, { stateDir: state, flushMs: 100, timeoutMs: 20_000 });
    const ctl = new AbortController();
    const started = performance.now();
    setTimeout(() => ctl.abort(), 150);
    expect((await fail(hp.generate("p", { signal: ctl.signal }))).code).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(KILL_GRACE_MS);
  }, 30_000);

  test("the cwd respawn after an aborted attempt spawns nothing", async () => {
    // A fake claude that answers the probe, logs each real start, makes its private cwd unusable (the
    // condition harden.ts answers with a respawn in the process cwd), then hangs. The abort kills it; the
    // respawn must see the same aborted signal and never start a second child.
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cancel-respawn-")));
    const state = join(dir, "state"), log = join(dir, "starts.log");
    // (The cwd is spoiled by NAME below, never by comparing against `state`: $PWD is the realpath.)
    const cli = join(dir, "claude");
    writeFileSync(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources --strict-mcp-config --no-session-persistence'; exit 0; fi
echo "start $PWD" >> '${log}'
case "$PWD" in */provider-cwd) chmod 000 "$PWD" ;; esac
sleep 30
`, { mode: 0o755 });
    // Its first exec, spent here and not inside the 3 s probe: on macOS a fresh script's first exec took a median of
    // 0.7 s and up to 1.8 s at load 6-9, against 4 ms for the second.
    Bun.spawnSync([cli, "--help"], { stdout: "ignore", stderr: "ignore" });
    const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { stateDir: state, flushMs: 100, probeMs: 3_000, timeoutMs: 20_000 });
    const ctl = new AbortController();
    try {
      const attempt = fail(hp.generate("p", { signal: ctl.signal }));
      // Abort once the first child has started (and spoiled its cwd). Waiting on that, not on a short fixed time: under
      // load the abort used to land before any child had started, and starts.log did not exist to read.
      for (const giveUp = performance.now() + 20_000; !existsSync(log) && performance.now() < giveUp; ) await Bun.sleep(20);
      await Bun.sleep(50);
      ctl.abort();
      const e = await attempt;
      expect(e.code).toBe("timeout");
      await Bun.sleep(300);
      const starts = readFileSync(log, "utf8").trim().split("\n");
      expect(starts.length).toBe(1);
      // The premise: it ran in the private cwd (matched by name: $PWD is the realpath, /private/var/… on macOS)…
      expect(starts[0]).toEndWith("/state/provider-cwd");
      expect(hp.runtimeWarnings.some((w) => w.includes("became unusable"))).toBe(true);   // …and the respawn branch was taken
    } finally {
      // The spoiled cwd is made removable again whatever failed above, so the run-end drain can delete it.
      if (existsSync(join(state, "provider-cwd"))) chmodSync(join(state, "provider-cwd"), 0o700);
    }
  }, 30_000);
});

describe("listeners and the double fire", () => {
  test("postJson removes its abort listener however the call ends", async () => {
    const s = await serve(okJson(textBody("out")));
    for (const handler of [okJson(textBody("out")), slow(10, textBody("x"))]) {
      s.setHandler(handler);
      const ctl = new AbortController();
      const sig = spied(ctl.signal);
      await postJson({ url: `${s.origin}/v1/messages`, headers: {}, body: {}, timeoutMs: 5_000, label: "t", kind: "anthropic", signal: ctl.signal });
      expect(sig.added.length).toBe(1);
      expect(sig.leftAttached()).toEqual([]);
    }
    // …and on a failure.
    const failing = new AbortController();
    const sig = spied(failing.signal);
    s.setHandler(() => new Response("{}", { status: 500 }));
    await fail(postJson({ url: `${s.origin}/v1/messages`, headers: {}, body: {}, timeoutMs: 5_000, label: "t", kind: "anthropic", signal: failing.signal }));
    expect(sig.added.length).toBe(1);
    expect(sig.leftAttached()).toEqual([]);
  });

  test("a CLI attempt removes its abort listener when it ends", async () => {
    const ctl = new AbortController();
    const sig = spied(ctl.signal);
    expect(await new BYOCliProvider({ cli: "echo", argv: [], promptVia: "arg" }).generate("hi", { signal: ctl.signal })).toBe("hi\n");
    expect(sig.added.length).toBe(1);
    expect(sig.leftAttached()).toEqual([]);
  });

  test("the timer and the signal both firing send SIGTERM once, not twice", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cancel-double-")));
    const log = join(dir, "terms.log");
    // Traps TERM (logs it, keeps running) so the kill path reaches its SIGKILL after the grace.
    const p = new BYOCliProvider(
      { cli: "sh", argv: ["-c", `trap 'echo TERM >> "${log}"' TERM; while :; do sleep 0.05; done`], promptVia: "stdin" },
      { timeoutMs: 100, killGraceMs: 800, flushMs: 100 },
    );
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);           // after the timer fired, before the SIGKILL
    expect((await fail(p.generate("p", { signal: ctl.signal }))).code).toBe("timeout");
    await Bun.sleep(100);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["TERM"]);
  }, 30_000);
});
