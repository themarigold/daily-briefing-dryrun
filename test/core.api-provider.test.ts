import "./fixtures/isolate-state";   // armed before this file's first save, from any cwd (see test/fixtures/isolate-state.ts)
// test/core.api-provider.test.ts — A3/T6+T7+T9+T13. The API transport through the REAL pipeline.
//
// ⚠ THIS FILE EXISTS BECAUSE `deps.provider` SKIPS EVERYTHING THAT MATTERS HERE. core.ts builds the
// transport only when no provider is injected, so a test that injects a double never exercises the
// factory, the owned-vs-laddered split, the limit recording, or the probe-host derivation. These run
// the real `buildProvider` against a real HTTP server and a real fake CLI on disk — the same argument
// test/account.failover.integration.test.ts makes for the CLI side.
//
// T7 IS THE HIGHEST-RISK EDIT IN THE SLICE. Until A3, one local named `hardened` meant both "we own the
// transport" (gating every WRITE to live account state) and "we have ladder members" (gating the B6
// ladder). An API provider is owned but has no ladder, so the two diverge — and BOTH wrong answers are
// silent. Each direction gets a pinning test below.
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCore } from "../src/core";
import { buildProvider, providerLabel } from "../src/providerFactory";
import { buildRepo } from "./fixtures/build-repo";
import { loadAccountState, accountStatePath, recordLimit, DEFAULT_LABEL } from "../src/account";
import { renderBriefing, API_NOTICE_TEXTS } from "../src/render";
import { ProviderError, API_LABEL_ANTHROPIC, type Config, type Provider } from "../src/types";
import { startFakeApi, okJson, status, type FakeApi, type FakeApiHandler } from "./helpers/fakeApi";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { deriveProbeHosts } from "../src/providers/endpoint";
import { posturePhrase } from "../src/eval/posture";

// ⚠ NOTHING IN THIS FILE MAY LEAVE THE MACHINE. It builds REAL providers from REAL configs, so a
// config that names no baseUrl silently means the production endpoint — which is how this file shipped
// a live POST to api.anthropic.com carrying a secret-shaped sentinel on every `bun test`. The guard
// covers `fetch` AND `Bun.connect`, and fails the file if either was pointed anywhere but loopback.
guardNetworkForThisFile();

const MODEL_OUTPUT = "RESUME\n- resumed\nRECAP\n- recapped\nSUGGESTIONS\n- suggested\n";
const SENTINEL = "sk-ant-api03-ZZTOPSECRETsentinelVALUE-do-not-log-0000";

let stateDir = "";
let repo = "";
let prevStateDir: string | undefined;
let prevKeyVar: string | undefined;

const servers: FakeApi[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
  await rm(accountStatePath(stateDir), { force: true });
});
const serve = async (h: FakeApiHandler): Promise<FakeApi> => { const s = await startFakeApi(h); servers.push(s); return s; };

beforeAll(async () => {
  // ⚠ EVERY runCore test must redirect the state dir or it writes the developer's REAL
  // account-state.json — core.ts's recording is now reachable on the API path too, which is exactly the
  // point of T7 and exactly what makes this mandatory rather than tidy.
  prevStateDir = process.env.DAILY_BRIEFING_STATE_DIR;
  stateDir = await mkdtemp(join(tmpdir(), "dba-api-state-"));
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  // The key is handed to the provider explicitly below, but the default-env rung would otherwise read
  // an ambient one from the developer's shell and make a "no key" assertion pass for the wrong reason.
  prevKeyVar = process.env.DBA_TEST_API_KEY;
  process.env.DBA_TEST_API_KEY = SENTINEL;
  repo = await buildRepo([
    { file: "a.ts", content: "one", isoDate: new Date(Date.now() - 2 * 86400e3).toISOString() },
    { file: "b.ts", content: "two", isoDate: new Date(Date.now() - 1 * 86400e3).toISOString() },
  ]);
});

afterAll(async () => {
  if (prevStateDir === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR;
  else process.env.DAILY_BRIEFING_STATE_DIR = prevStateDir;
  if (prevKeyVar === undefined) delete process.env.DBA_TEST_API_KEY;
  else process.env.DBA_TEST_API_KEY = prevKeyVar;
  await rm(stateDir, { recursive: true, force: true });
});

/** `powerPlatform: "linux"` short-circuits the darkwake gate; `retryDelaysMs: []` keeps a retryable
 *  failure from sleeping through the suite — the same shape the failover integration test uses. */
const deps = {
  netProbe: async () => true,
  powerPlatform: "linux" as NodeJS.Platform,
  sleep: async () => {},
  retryDelaysMs: [] as number[],
};

const apiCfg = (origin: string, extra: Record<string, unknown> = {}): Config => ({
  repos: [repo],
  provider: {
    cli: API_LABEL_ANTHROPIC, argv: [], promptVia: "stdin", timeoutMs: 10_000,
    api: { kind: "anthropic", model: "claude-sonnet-5", baseUrl: origin, apiKeyEnv: "DBA_TEST_API_KEY" },
    ...extra,
  },
} as Config);

/** A fake `claude` that answers the capability probe and then prints a fixed briefing, recording the
 *  prompt it received on stdin. The echo-parseable pattern the suite already uses — the prompt is built
 *  UPSTREAM of the transport, so a fake CLI measures exactly the same construction the real one would. */
async function fakeClaude(dir: string): Promise<string> {
  const p = join(dir, "claude");
  await writeFile(p, `#!/bin/sh
case " $* " in *" --help "*) echo "--tools --setting-sources --strict-mcp-config"; exit 0;; esac
cat > "${join(dir, "prompt.txt")}"
printf '%s' '${MODEL_OUTPUT.replace(/'/g, "'\\''")}'
`);
  await chmod(p, 0o755);
  return p;
}

const anthropicOk = okJson({ content: [{ type: "text", text: MODEL_OUTPUT }], stop_reason: "end_turn" });

// ── T6: the factory ───────────────────────────────────────────────────────────────────────────────

describe("T6 — buildProvider", () => {
  test("a CLI config yields ladder members; an api config yields runtimeWarnings and NO ladder", () => {
    const cli = buildProvider({ cli: "claude", argv: ["-p"], promptVia: "stdin" }, { stateDir });
    expect(typeof cli.laddered?.hardeningActive).toBe("function");
    expect(typeof cli.laddered?.disableHardening).toBe("function");
    expect(typeof cli.laddered?.probeWithoutHardening).toBe("function");
    expect(cli.provider.runtimeWarnings).toEqual([]);

    const api = buildProvider({
      cli: API_LABEL_ANTHROPIC, argv: [], promptVia: "stdin",
      api: { kind: "anthropic", model: "m", apiKeyEnv: "DBA_TEST_API_KEY" },
    });
    // ⚠ `laddered: undefined` means "no ladder", NOT "we did not build the transport". Conflating those
    // two meanings is precisely the defect T7 splits.
    expect(api.laddered).toBeUndefined();
    expect(Array.isArray(api.provider.runtimeWarnings)).toBe(true);
    expect(api.provider.runtimeWarnings.some((w) => w.includes("no CLI process to harden"))).toBe(true);
  });

  test("an api config plus `accounts` gets NO CLAUDE_CONFIG_DIR and DOES get the ignored-accounts warning", async () => {
    // ⚠ `fetchImpl` IS INJECTED AND THAT IS LOAD-BEARING, not tidiness. This config names no `baseUrl`,
    // and for the anthropic kind that means the PRODUCTION DEFAULT — so the previous version of this
    // test POSTed the sentinel below to api.anthropic.com on every single `bun test` run, while its own
    // comment claimed "the endpoint is unreachable; the failure is irrelevant". The warnings under
    // assertion are raised by the KEY LADDER and need no request at all, so the request is refused here
    // and the refusal counted.
    let outbound = 0;
    const built = buildProvider({
      cli: API_LABEL_ANTHROPIC, argv: [], promptVia: "stdin",
      accounts: [{ label: "primary" }, { label: "alt", configDir: "/tmp/alt" }],
      credential: "env-api-key", harden: false,
      api: { kind: "anthropic", model: "m", apiKeyEnv: "DBA_TEST_API_KEY" },
    }, {
      env: { CLAUDE_CONFIG_DIR: "/tmp/should-not-be-used" },
      api: { fetchImpl: (async () => { outbound++; throw new Error("no network in tests"); }) as unknown as typeof fetch },
    });
    // The key-ladder warnings are folded in lazily, on the first generate() — so force one.
    await built.provider.generate("x").catch(() => undefined);
    expect(outbound).toBe(1);          // …and it went to the injected impl, never to a socket
    const joined = built.provider.runtimeWarnings.join("\n");
    expect(joined).toContain("provider.accounts");
    expect(joined).toContain("provider.credential");
    expect(joined).toContain("provider.harden");
  });

  test("⚠ the api branch HONOURS opts.timeoutMs — the judges' 240 s budget is not thrown away", async () => {
    // MEASURED LOSS. The api branch built its opts from `cfg.timeoutMs` alone and never read
    // `opts.timeoutMs`, while scripts/audit.ts:557 and scripts/eval.ts both call
    // `buildProvider(judgeCfg, { timeoutMs: 240_000, … })` precisely because the judge prompt is the
    // longest call this tool makes. So on an API config the judges silently ran at TIMEOUT_MS =
    // 120 000 — half their stated allowance. The only guard was a source-TEXT regex asserting the
    // literal `240_000` appears in audit.ts, which passed vacuously while the value was discarded.
    //
    // Asserted BEHAVIOURALLY, against a handler that never answers: the abort is the observable.
    const s = await serve(() => new Promise<Response>(() => {}) as unknown as Response);
    const built = buildProvider({
      cli: API_LABEL_ANTHROPIC, argv: [], promptVia: "stdin",
      api: { kind: "anthropic", model: "m", baseUrl: s.origin, apiKeyEnv: "DBA_TEST_API_KEY" },
    }, { timeoutMs: 150 });
    let e: ProviderError | undefined;
    const startedAt = Date.now();
    try { await built.provider.generate("x"); } catch (x) { e = x as ProviderError; }
    expect(e?.code).toBe("timeout");
    expect(e?.message).toContain("150ms");
    expect(Date.now() - startedAt).toBeLessThan(3_000);        // …not the 120 s default

    // …and `cfg.timeoutMs` still applies when the caller states none, which is core.ts's own shape.
    const t = await serve(() => new Promise<Response>(() => {}) as unknown as Response);
    const fromCfg = buildProvider({
      cli: API_LABEL_ANTHROPIC, argv: [], promptVia: "stdin", timeoutMs: 120,
      api: { kind: "anthropic", model: "m", baseUrl: t.origin, apiKeyEnv: "DBA_TEST_API_KEY" },
    });
    await expect(fromCfg.provider.generate("x")).rejects.toMatchObject({ code: "timeout" });
  }, 15_000);

  test("providerLabel: a CLI run is BYTE-IDENTICAL; an API run carries the model", () => {
    expect(providerLabel({ cli: "claude", argv: ["-p"], promptVia: "stdin" })).toBe("claude");
    expect(providerLabel({ cli: "/opt/bin/codex", argv: [], promptVia: "arg" })).toBe("/opt/bin/codex");
    expect(providerLabel({
      cli: API_LABEL_ANTHROPIC, argv: [], promptVia: "stdin",
      api: { kind: "anthropic", model: "claude-sonnet-5" },
    })).toBe("anthropic-api (claude-sonnet-5)");
  });
});

// ── T7: the owned/laddered split ──────────────────────────────────────────────────────────────────

describe("T7 — the owned-vs-laddered split", () => {
  test("⚠ an API provider hitting a usage wall DOES record a mark — losing this is a silent outage", async () => {
    // The failure direction: gating the recording on `laddered` (which is undefined for an API run)
    // drops limit recording entirely. The user would get a bare error line every 600s, no quiet skip,
    // no recovery outage report, and no mark — an outage the tool cannot see it is in.
    const s = await serve(status(429, {
      error: {
        type: "rate_limit_error",
        message: "You have reached your API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.",
        details: { error_code: "enforced_spend_limit_reached" },
      },
    }));
    const r = await runCore(apiCfg(s.origin), deps);

    expect(r.skipReason).toBe("limited");
    expect(r.offlineSkipped).toBe(true);                     // the quiet `return 0` gate, reused intact
    expect(r.rawText).toBe("");
    // ⚠ `resetAt` PREFERRED over text-parsing the message. Without it `parseResetInstant` falls back to
    // a one-hour PROBE mark and the tool re-probes a wall that cannot lift until October.
    expect(r.limited?.isProbe).toBe(false);
    expect(r.limited?.until).toBe("2026-10-01T00:00:00.000Z");
    const st = await loadAccountState(stateDir);
    expect(st.lastLimit).toBeDefined();
    expect(Object.keys(st.accounts)).toHaveLength(1);        // the single implicit account
  });

  test("⚠ an INJECTED provider throwing usage-limit records NOTHING — a developer's eval must not write an outage", async () => {
    // The OTHER failure direction, and the pre-existing guarantee the split must not break: the eval
    // harness runs the real pipeline through runCore with an injected provider (src/eval/run-case.ts).
    const injected: Provider = {
      generate: async () => { throw new ProviderError("usage-limit", "walled"); },
    };
    await expect(runCore(apiCfg("http://127.0.0.1:9"), { ...deps, provider: injected })).rejects.toThrow();
    const st = await loadAccountState(stateDir);
    expect(st.lastLimit).toBeUndefined();
    expect(Object.keys(st.accounts)).toHaveLength(0);
  });

  test("⚠ an API provider NEVER enters the hardening ladder — exactly ONE call for a fast retryable failure", async () => {
    // The discriminator: with `retryDelaysMs: []` a laddered run makes THREE calls for a fast failure
    // (withRetry's one, then the ladder's two single-attempt rungs). An API run must make exactly one —
    // there are no flags to back off from, and asking the question costs two extra HTTP calls per tick.
    const s = await serve(status(500, { error: { type: "api_error", message: "boom" } }));
    await expect(runCore(apiCfg(s.origin), deps)).rejects.toMatchObject({ code: "nonzero-exit" });
    expect(s.requests).toHaveLength(1);
  });

  test("a successful API run CLEARS its mark, so a topped-up account is not benched forever", async () => {
    // Seeded with an EXPIRED mark rather than by walling the account first: a LIVE mark makes
    // `resolveAccount` return nothing and the next tick skips before the provider is ever built, so the
    // clearMark line would never be reached and the test would pass for the wrong reason. An expired
    // mark is selectable, which is exactly the state clearMark exists to tidy up.
    const past = new Date(Date.now() - 3 * 3600e3);
    await recordLimit(DEFAULT_LABEL, past, new Date(Date.now() - 4 * 3600e3), { isProbe: false, stateDir });
    expect((await loadAccountState(stateDir)).accounts[DEFAULT_LABEL]).toBeDefined();

    const ok = await serve(anthropicOk);
    const r = await runCore(apiCfg(ok.origin), deps);
    // DELIVERED — asserted on the gate fields rather than on bullet counts, which are a property of the
    // fixture's git history and of the generator's SHA verification, not of the transport.
    expect(r.skipReason).toBeUndefined();
    expect(r.offlineSkipped).toBe(false);
    expect(r.rawText).toContain("RECAP");
    // ⚠ OWNERSHIP question, not the ladder one: an API run owns its transport, so it must clear its own
    // mark. Gating clearMark on `laddered` would leave a stale mark behind on every API run forever.
    expect((await loadAccountState(stateDir)).accounts[DEFAULT_LABEL]).toBeUndefined();
  });

  test("the CLI usage-limit path is UNCHANGED — same mark, same skipReason, same limited payload", async () => {
    // The regression side of the split: a CLI run must behave exactly as it did before A3.
    const dir = await mkdtemp(join(tmpdir(), "dba-cli-limit-"));
    try {
      const p = join(dir, "claude");
      await writeFile(p, `#!/bin/sh
case " $* " in *" --help "*) echo "--tools"; exit 0;; esac
printf "You've hit your weekly limit \\302\\267 resets Aug 26 at 10pm (America/Los_Angeles)\\n"
exit 1
`);
      await chmod(p, 0o755);
      const cfg = { repos: [repo], provider: { cli: p, argv: [], promptVia: "stdin", timeoutMs: 20_000 } } as Config;
      const r = await runCore(cfg, { ...deps, now: () => new Date("2026-08-24T12:00:00-07:00") });
      expect(r.skipReason).toBe("limited");
      expect(r.offlineSkipped).toBe(true);
      expect(r.limited?.isProbe).toBe(false);              // parsed from the CLI's English, as before
      expect(r.limited?.exhausted).toBe(true);
      expect((await loadAccountState(stateDir)).lastLimit).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── T9: the derived probe hosts ───────────────────────────────────────────────────────────────────

describe("T9 — the derived network gate", () => {
  test("⚠ a LOOPBACK api endpoint disables the gate; an unreachable REMOTE one engages it", async () => {
    // Measured through the REAL gate — no injected `netProbe`, because injecting one bypasses the
    // derived host list entirely (core.ts prefers `deps.netProbe` over `defaultNetProbe(probeHosts)`) and
    // the test would then pass no matter what the derivation returned. The grace is shortened instead.
    //
    // THE ANTI-FEATURE THIS REMOVES: with the anycast default, a user on a plane with Ollama waits the
    // full 25 s grace for two unreachable hosts before EVERY briefing.
    const gate = { ...deps, netProbe: undefined, netGraceMs: 300, netPollMs: 100 };
    const s = await serve(okJson({ choices: [{ message: { content: MODEL_OUTPUT }, finish_reason: "stop" }] }));
    const loopback = {
      repos: [repo],
      provider: {
        cli: "openai-compatible", argv: [], promptVia: "stdin", timeoutMs: 10_000,
        api: { kind: "openai-compatible", model: "m", baseUrl: s.origin },
      },
    } as Config;
    const r = await runCore(loopback, gate);
    expect(r.offlineSkipped).toBe(false);
    expect(r.net?.online).toBe(true);
    expect(r.net?.waitedMs).toBeLessThan(200);          // the gate never polled

    // …and the same config pointed at a REMOTE endpoint DOES engage the gate, which is what proves the
    // derivation reached it rather than the gate being off for every api config.
    //
    // ⚠ TWO HALVES, AND THE SPLIT IS DELIBERATE — the earlier single-assertion version rested on the
    // machine's DNS REFUSING `dba-no-such-host.invalid`. That is an outbound lookup on every run, and a
    // wildcard or captive resolver that answers it (and listens on 443) turned this test red for
    // reasons having nothing to do with the code. So:
    //   (a) the DERIVATION is asserted directly and purely — no socket, no resolver;
    //   (b) the GATE's behaviour on an unreachable list is driven by an injected probe.
    // Together they carry what the one flaky assertion carried, and neither leaves the machine.
    const remoteApi = { kind: "openai-compatible", model: "m", baseUrl: "https://gw.corp.test/v1" } as const;
    expect(deriveProbeHosts(remoteApi)).toEqual([{ host: "gw.corp.test", port: 443 }]);   // (a) non-empty ⇒ the gate engages

    let probes = 0;
    const remote = {
      repos: [repo],
      provider: { cli: "openai-compatible", argv: [], promptVia: "stdin", timeoutMs: 10_000, api: remoteApi },
    } as Config;
    const skipped = await runCore(remote, {
      ...gate,
      netProbe: async () => { probes++; return false; },                                  // (b)
    });
    expect(skipped.skipReason).toBe("offline");
    expect(probes).toBeGreaterThan(0);
  }, 20_000);

  test("an EXPLICIT networkProbeHosts still wins over the derivation, `[]` included", async () => {
    const s = await serve(anthropicOk);
    let probes = 0;
    const cfg = { ...apiCfg(s.origin), networkProbeHosts: [{ host: "1.1.1.1", port: 443 }] } as Config;
    await runCore(cfg, { ...deps, netProbe: async () => { probes++; return true; } });
    expect(probes).toBe(1);                       // the config was honoured, not the derivation
  });
});

// ── T13: comparability ────────────────────────────────────────────────────────────────────────────

describe("T13 — the no-comparability-boundary claim, MEASURED", () => {
  test("⚠ the prompt is BYTE-IDENTICAL across transports, and the API request carries those exact bytes", async () => {
    // The design's central claim. `buildPrompt` runs upstream of the transport and its output has no
    // clock dependence, so the two runs are comparable by construction — but "by construction" is what
    // this test exists to replace with a measurement.
    const dir = await mkdtemp(join(tmpdir(), "dba-cli-prompt-"));
    try {
      const cli = await fakeClaude(dir);
      const cliCfg = { repos: [repo], provider: { cli, argv: [], promptVia: "stdin", timeoutMs: 20_000 } } as Config;
      const cliRun = await runCore(cliCfg, deps);

      const s = await serve(anthropicOk);
      const apiRun = await runCore(apiCfg(s.origin), deps);

      expect(apiRun.promptText).toBe(cliRun.promptText);
      expect(apiRun.promptText.length).toBeGreaterThan(50);      // not two empty strings agreeing
      // …and the bytes that reached the WIRE are those bytes, not a re-rendering of them.
      const body = JSON.parse(s.requests[0]!.bodyText) as { messages: { content: string }[] };
      expect(body.messages[0]!.content).toBe(cliRun.promptText);
      // The CLI's stdin got the same bytes, read back off disk.
      expect(await Bun.file(join(dir, "prompt.txt")).text()).toBe(cliRun.promptText);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the RENDERED briefing is structurally identical across transports, given the same model output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dba-cli-render-"));
    try {
      const cli = await fakeClaude(dir);
      const cliRun = await runCore({ repos: [repo], provider: { cli, argv: [], promptVia: "stdin", timeoutMs: 20_000 } } as Config, deps);
      const s = await serve(anthropicOk);
      const apiRun = await runCore(apiCfg(s.origin), deps);

      // The MODEL-DERIVED content must match exactly — that is what "no comparability boundary" means.
      for (const k of ["resume", "recap", "suggestions", "today", "windowMerges", "branchState"] as const) {
        expect(`${k}: ${JSON.stringify(apiRun.struct[k])}`).toBe(`${k}: ${JSON.stringify(cliRun.struct[k])}`);
      }

      // TWO fields differ, both deliberately and both PROVENANCE rather than content:
      //  • `provider` carries the model for an API run (and is byte-identical for a CLI run);
      //  • the API run's `struct.warnings` carries the hardening carve-out warning — the honest disclosure
      //    the design chose over an unearned `posture: full`, read by the posture readers. Since v0.2.1
      //    (§2.3) it does NOT render: renderBriefing drops that exact element (src/render.ts
      //    API_NOTICE_TEXTS), so the footer's `generated via <provider>` is the briefing's only mark of
      //    an API run. `strip` below is kept as-is; with the line gone it filters nothing on either side.
      expect(cliRun.struct.provider).toBe(cli);                        // CLI: byte-identical to before
      expect(apiRun.struct.provider).toBe("anthropic-api (claude-sonnet-5)");
      const carve = (apiRun.struct.warnings ?? []).filter((w) => w.includes("no CLI process to harden"));
      expect(carve).toHaveLength(1);                                   // the struct still carries it…
      expect(API_NOTICE_TEXTS).toContain(carve[0]!);
      expect(renderBriefing(apiRun.struct)).not.toContain("no CLI process to harden");   // …the briefing does not
      const strip = (m: string, provider: string) => m
        .split("\n")
        .filter((l) => !l.includes("no CLI process to harden"))
        .join("\n")
        .split(provider).join("<PROVIDER>")
        .replace(/\n{3,}/g, "\n\n");
      expect(strip(renderBriefing(apiRun.struct), apiRun.struct.provider))
        .toBe(strip(renderBriefing(cliRun.struct), cliRun.struct.provider));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an API run's posture is the fifth phrase, and its warnings reach the struct", async () => {
    const s = await serve(anthropicOk);
    const r = await runCore(apiCfg(s.origin), deps);
    expect(posturePhrase(r.struct.warnings ?? [])).toBe("unhardened (api provider)");
    // ⚠ Not `full` (nothing was hardened, so the claim would be unearned) and not `degraded` (nothing
    // malfunctioned) — the two misreports the carve-out exists to prevent.
  });

  test("⚠ SENTINEL LEAK: no key value reaches the struct, its warnings, or the rendered briefing", async () => {
    const s = await serve(anthropicOk);
    const r = await runCore(apiCfg(s.origin), deps);
    const surface = `${JSON.stringify(r.struct)}\n${renderBriefing(r.struct)}\n${r.promptText}\n${r.rawText}`;
    expect(surface.includes(SENTINEL)).toBe(false);
  });
});
