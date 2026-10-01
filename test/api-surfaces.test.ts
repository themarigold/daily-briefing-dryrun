import "./fixtures/isolate-state";   // armed before this file's first save, from any cwd (see test/fixtures/isolate-state.ts)
// test/api-surfaces.test.ts — A3/T9 + T10 + A3-D. The probe-host derivation, `init --provider`, and
// the `doctor --json` api branch.
//
// ⚠ XDG_CONFIG_HOME IS REDIRECTED FOR THE WHOLE FILE. `initConfig()` WRITES the real user config and
// `doctorReport()` READS it; without this the tests would create — or be shaped by — whatever the
// developer happens to have installed. DAILY_BRIEFING_STATE_DIR is redirected for the same reason on
// the state side.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initConfig, configPath, validateConfig, type InitApiOptions } from "../src/config";
import { resolveProbeHosts } from "../src/net";
import { DEFAULT_NETWORK_PROBE_HOSTS } from "../src/config";
import { deriveProbeHosts, endpointUrl, isLoopbackHost, portOf, ANTHROPIC_DEFAULT_BASE_URL } from "../src/providers/endpoint";
import { init, parseInitApiFlags, dispatch } from "../src/main";
import { doctorReport } from "../src/json";
import type { ProviderApi } from "../src/types";
import { guardNetworkForThisFile } from "./helpers/netGuard";

// `doctorReport` runs the REAL probe-host derivation and the REAL key ladder against configs written
// here, so a stray non-loopback host in a fixture is an outbound connection. Enforced, not reviewed.
guardNetworkForThisFile();

let cfgHome = "";
let stateDir = "";
const prev: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ["XDG_CONFIG_HOME", "DAILY_BRIEFING_STATE_DIR", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) prev[k] = process.env[k];
  cfgHome = await mkdtemp(join(tmpdir(), "dba-api-cfg-"));
  stateDir = await mkdtemp(join(tmpdir(), "dba-api-surf-state-"));
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(cfgHome, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(async () => { await rm(configPath(), { force: true }); });

// ── T9: the derivation ────────────────────────────────────────────────────────────────────────────

test("⚠ T9: resolveProbeHosts(undefined) with NO fallback argument is byte-identical to today", () => {
  // The additive parameter must be invisible to every existing caller — this pins the legacy call shape,
  // which is the whole basis for claiming a CLI user sees no change.
  expect(resolveProbeHosts(undefined)).toEqual({ hosts: DEFAULT_NETWORK_PROBE_HOSTS });
  expect(resolveProbeHosts([])).toEqual({ hosts: [] });
  expect(resolveProbeHosts([{ host: "h", port: 1 }])).toEqual({ hosts: [{ host: "h", port: 1 }], warning: undefined });
  expect(resolveProbeHosts("nope").hosts).toEqual(DEFAULT_NETWORK_PROBE_HOSTS);
});

test("T9: an EXPLICIT value always wins over the fallback — `[]` included", () => {
  const fb = [{ host: "api.example.test", port: 443 }];
  expect(resolveProbeHosts(undefined, fb).hosts).toEqual(fb);
  // ⚠ `[]` is the documented skip switch, so it must survive the fallback rather than be "corrected".
  expect(resolveProbeHosts([], fb).hosts).toEqual([]);
  expect(resolveProbeHosts([{ host: "pinned", port: 99 }], fb).hosts).toEqual([{ host: "pinned", port: 99 }]);
  // A MALFORMED value falls back to the fallback, not to anycast — the caller's fallback is what "the
  // defaults" means once one has been supplied.
  expect(resolveProbeHosts("garbage", fb).hosts).toEqual(fb);
});

test("T9: the derivation table", () => {
  const d = (api: ProviderApi) => deriveProbeHosts(api);
  expect(d({ kind: "anthropic", model: "m" })).toEqual([{ host: "api.anthropic.com", port: 443 }]);
  expect(d({ kind: "anthropic", model: "m", baseUrl: "https://gw.corp.test:8443/anthropic" })).toEqual([{ host: "gw.corp.test", port: 8443 }]);
  expect(d({ kind: "openai-compatible", model: "m", baseUrl: "https://api.openai.com/v1" })).toEqual([{ host: "api.openai.com", port: 443 }]);
  expect(d({ kind: "openai-compatible", model: "m", baseUrl: "http://gpu.lan:8000/v1" })).toEqual([{ host: "gpu.lan", port: 8000 }]);
  // Loopback DISABLES the gate; an unparseable/absent endpoint yields NO OPINION (undefined), which the
  // caller turns into the anycast default rather than silently disabling the gate on a typo.
  for (const u of ["http://localhost:11434/v1", "http://127.0.0.1:1234", "http://127.0.1.1:8000", "http://[::1]:11434", "https://x.localhost/v1"]) {
    expect(`${u} → ${JSON.stringify(d({ kind: "openai-compatible", model: "m", baseUrl: u }))}`).toBe(`${u} → []`);
  }
  expect(d({ kind: "openai-compatible", model: "m" })).toBeUndefined();
});

test("T9: the loopback predicate and the default-port arithmetic", () => {
  expect(isLoopbackHost("127.0.0.1")).toBe(true);
  expect(isLoopbackHost("127.255.255.254")).toBe(true);
  expect(isLoopbackHost("LOCALHOST")).toBe(true);
  expect(isLoopbackHost("::1")).toBe(true);
  // ⚠ 0.0.0.0 is a BIND address, not a destination: a config naming it is a mistake worth probing.
  expect(isLoopbackHost("0.0.0.0")).toBe(false);
  expect(isLoopbackHost("128.0.0.1")).toBe(false);
  expect(isLoopbackHost("api.anthropic.com")).toBe(false);
  expect(portOf(new URL("https://h.test"))).toBe(443);
  expect(portOf(new URL("http://h.test"))).toBe(80);
  expect(portOf(new URL("http://h.test:8080"))).toBe(8080);
  expect(endpointUrl({ kind: "anthropic", model: "m" })?.toString()).toBe(`${ANTHROPIC_DEFAULT_BASE_URL}/`);
});

// ── T10: init flag parsing ────────────────────────────────────────────────────────────────────────

const argv = (...rest: string[]) => ["bun", "main.ts", "init", ...rest];

test("T10: with NO --provider, parsing is a no-op — the unchanged first-run path", () => {
  expect(parseInitApiFlags(argv())).toEqual({});
  expect(parseInitApiFlags(argv("--force"))).toEqual({});
});

test("T10: the companion flags REQUIRE --provider, rather than being silently ignored", () => {
  // Accepting them alone would write today's CLI template while the user believed they had configured
  // an API provider — a silent wrong-transport, which is the whole class this slice is careful about.
  expect(parseInitApiFlags(argv("--model", "x")).error).toMatch(/requires --provider/);
  expect(parseInitApiFlags(argv("--base-url", "http://x")).error).toMatch(/requires --provider/);
  expect(parseInitApiFlags(argv("--model", "x", "--base-url", "http://x")).error).toMatch(/require --provider/);
});

test("⚠ T10: the `--flag=value` SPELLING cannot slip past the refusals", () => {
  // MEASURED ESCAPE. The refusals used `argv.includes(flag)` and the reader used `argv.indexOf(flag)`,
  // so neither saw the equals form: `init --provider=anthropic-api --model=gpt` parsed to `{}` — no
  // error, no api block — and init then wrote today's CLI TEMPLATE to someone who had just asked for an
  // API provider. Silence is the worst possible answer here, so both halves are refused explicitly.
  expect(parseInitApiFlags(argv("--provider=anthropic-api", "--model=gpt")).error).toMatch(/--provider takes its value as a separate argument/);
  expect(parseInitApiFlags(argv("--provider=anthropic-api", "--model=gpt")).api).toBeUndefined();
  expect(parseInitApiFlags(argv("--model=gpt")).error).toMatch(/requires --provider/);
  expect(parseInitApiFlags(argv("--api-key-file=/k")).error).toMatch(/requires --provider/);
});

test("⚠ T10: --api-key-command REFUSES quotes and a whitespace-only value rather than shredding argv", () => {
  // The flag SPLITS ON WHITESPACE and is not a shell. Two ways that used to bite silently:
  //  • quotes: `-s "my service"` became four argv elements, spawning a command that fails every morning
  //    with nothing but `apiKeyCommand (\`…\`) exited N` to explain it;
  //  • whitespace only: it split to `[]`, and init wrote a config `validateProviderApi` rejects on the
  //    very next load — an install that cannot run.
  const quoted = parseInitApiFlags(argv("--provider", "anthropic-api", "--model", "m", "--api-key-command", 'helper --item "my service"'));
  expect(quoted.error).toMatch(/does not interpret quotes/);
  expect(quoted.error).toMatch(/apiKeyCommand/);          // …and names the config-file array form
  expect(quoted.api).toBeUndefined();
  for (const blank of ["   ", "\t", " \t "]) {
    expect(parseInitApiFlags(argv("--provider", "anthropic-api", "--model", "m", "--api-key-command", blank)).error)
      .toMatch(/requires a command to run/);
  }
});

test("T10: --provider REFUSES to proceed without --model — this project never picks a model for you", () => {
  expect(parseInitApiFlags(argv("--provider", "anthropic-api")).error).toMatch(/--model/);
  expect(parseInitApiFlags(argv("--provider", "anthropic-api", "--model")).error).toMatch(/--model/);
  expect(parseInitApiFlags(argv("--provider", "gemini", "--model", "x")).error).toMatch(/anthropic-api/);
  // openai-compatible has no universal default endpoint, so a baseUrl is mandatory there.
  expect(parseInitApiFlags(argv("--provider", "openai-compatible", "--model", "m")).error).toMatch(/--base-url/);
});

test("T10: a complete flag set parses into the config block", () => {
  expect(parseInitApiFlags(argv("--provider", "anthropic-api", "--model", "claude-sonnet-5")).api)
    .toEqual({ kind: "anthropic", model: "claude-sonnet-5" });
  expect(parseInitApiFlags(argv("--provider", "openai-compatible", "--model", "llama3", "--base-url", "http://127.0.0.1:11434/v1", "--api-key-env", "MY_KEY")).api)
    .toEqual({ kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1", apiKeyEnv: "MY_KEY" });
  // The command is stored as an ARGV ARRAY, never a shell string — this is where the flag becomes one.
  expect(parseInitApiFlags(argv("--provider", "anthropic-api", "--model", "m", "--api-key-command", "my-helper --field password")).api?.apiKeyCommand)
    .toEqual(["my-helper", "--field", "password"]);
});

test("⚠ T10: there is deliberately NO --api-key flag — a secret on a command line lands in shell history", () => {
  // Parsed as an unknown flag, i.e. ignored, rather than accepted: the three indirect sources are the
  // whole supported set here. `provider.api.apiKey` stays editable in the FILE for someone who wants it.
  expect(parseInitApiFlags(argv("--provider", "anthropic-api", "--model", "m", "--api-key", "sk-secret")).api)
    .toEqual({ kind: "anthropic", model: "m" });
});

// ── T10: what init WRITES ─────────────────────────────────────────────────────────────────────────

const written = async (): Promise<Record<string, unknown>> => JSON.parse(await Bun.file(configPath()).text());

test("T10: a no-flag init writes TODAY'S template, unchanged", async () => {
  const r = await initConfig(async () => "/usr/local/bin/claude");
  expect(r.wrote).toBe(true);
  const c = await written();
  const p = c.provider as Record<string, unknown>;
  // The CLI branch is byte-for-byte what it was: the triple, both discoverable defaults, and the
  // hardcoded anycast pair. `api` must not appear.
  expect(p.cli).toBe("/usr/local/bin/claude");
  expect(p.argv).toEqual(["-p"]);
  expect(p.promptVia).toBe("stdin");
  expect(p.harden).toBe(true);
  expect(p.credential).toBe("subscription");
  expect(p.api).toBeUndefined();
  expect(c.networkProbeHosts).toEqual(DEFAULT_NETWORK_PROBE_HOSTS);
});

test("T10: --provider anthropic-api writes an api block with NO cli/argv/promptVia and NO credential", async () => {
  await initConfig(async () => undefined, { kind: "anthropic", model: "claude-sonnet-5" });
  const c = await written();
  const p = c.provider as Record<string, unknown>;
  // The mutual exclusion is respected BY THE WRITER, not only by the validator — writing the triple here
  // would produce a config that `validateConfig` throws on, i.e. an init that creates a broken install.
  expect(Object.keys(p)).toEqual(["api"]);
  expect(p.api).toEqual({ kind: "anthropic", model: "claude-sonnet-5" });
  // …and the derived probe hosts, NOT the anycast pair.
  expect(c.networkProbeHosts).toEqual([{ host: "api.anthropic.com", port: 443 }]);
  // The written config must round-trip through the validator, or init created an install that cannot run.
  expect(() => validateConfig(c, "/home/x")).not.toThrow();
});

test("⚠ T10: a LOOPBACK openai-compatible init writes `networkProbeHosts: []` — the proof T9 is not dead on new installs", async () => {
  // `initConfig` writes networkProbeHosts EXPLICITLY, and the runtime derivation fires only when the key
  // is ABSENT — so writing the anycast pair here would make T9 dead on every freshly initialized
  // install, which is the trap the design calls out by name.
  await initConfig(async () => undefined, { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1" });
  const c = await written();
  expect(c.networkProbeHosts).toEqual([]);
  expect(() => validateConfig(c, "/home/x")).not.toThrow();
});

test("T10: a written api config is mode 0600, and every flag reaches the file", async () => {
  const opts: InitApiOptions = {
    kind: "openai-compatible", model: "m", baseUrl: "https://gpu.corp.test/v1",
    apiKeyEnv: "E", apiKeyFile: "/k", apiKeyCommand: ["helper", "--x"],
  };
  await initConfig(async () => undefined, opts);
  const c = await written();
  expect((c.provider as Record<string, unknown>).api).toEqual(opts);
  // An api config is a credential-adjacent file BY CONSTRUCTION — `apiKey` is a supported field and this
  // is the file people paste it into.
  expect(((await stat(configPath())).mode & 0o777).toString(8)).toBe("600");
});

test("T10: initConfig still returns early and writes NOTHING when a config exists", async () => {
  await writeFile(configPath(), JSON.stringify({ provider: { cli: "claude", argv: [], promptVia: "stdin" } }), { mode: 0o644 });
  const before = await Bun.file(configPath()).text();
  const r = await initConfig(async () => undefined, { kind: "anthropic", model: "m" });
  expect(r.wrote).toBe(false);
  expect(await Bun.file(configPath()).text()).toBe(before);
});

test("T10: init REPORTS key status and returns 0 either way (the cliFound precedent)", async () => {
  const lines: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    expect(await init({ api: { kind: "anthropic", model: "m", apiKeyEnv: "DBA_TEST_PRESENT" }, env: { DBA_TEST_PRESENT: "value" } })).toBe(0);
    expect(lines.join("\n")).toContain("API key: found in $DBA_TEST_PRESENT");
    await rm(configPath(), { force: true });
    lines.length = 0;
    expect(await init({ api: { kind: "anthropic", model: "m", apiKeyEnv: "DBA_TEST_ABSENT" }, env: {} })).toBe(0);
    expect(lines.join("\n")).toMatch(/API key: not found/);
    // ⚠ NEVER the value, on either branch.
    expect(lines.join("\n")).not.toContain("value");
  } finally { console.log = log; console.error = err; }
});

test("T10: dispatch refuses a malformed --provider with exit 2 BEFORE anything is written", async () => {
  let called = 0;
  const code = await dispatch(argv("--provider", "gemini", "--model", "x"), { init: async () => { called++; return 0; } });
  expect(code).toBe(2);
  expect(called).toBe(0);
  expect(await Bun.file(configPath()).exists()).toBe(false);
});

// ── A3-D: the doctor branch ───────────────────────────────────────────────────────────────────────

const doctorDeps = {
  preflight: async () => [],
  discover: async () => ({ repos: [], issues: [] }),
  netProbe: async () => true,
  powerPlatform: "linux" as NodeJS.Platform,
};

test("⚠ A3-D: doctor reports the api branch, SKIPS the CLI probe, and never touches the key value", async () => {
  await writeFile(configPath(), JSON.stringify({
    repos: [], provider: { api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyEnv: "DBA_DOCTOR_KEY" } },
  }));
  const prevKey = process.env.DBA_DOCTOR_KEY;
  process.env.DBA_DOCTOR_KEY = "sk-ant-SECRETsentinel";
  try {
    let whichCalls = 0;
    const r = await doctorReport({ ...doctorDeps, which: async () => { whichCalls++; return undefined; } });
    // The probe is SKIPPED: `which("anthropic-api")` would answer "not found" for a label that was never
    // meant to be a binary, and `found: false` drives the verdict to `blocked` for a working config.
    expect(whichCalls).toBe(0);
    expect(r.provider.found).toBe(true);
    expect(r.provider.path).toBeNull();
    expect(r.provider.hardeningAvailable).toBe(false);
    expect(r.provider.api).toEqual({
      kind: "anthropic",
      model: "claude-sonnet-5",
      baseUrl: "https://api.anthropic.com/",
      keySource: { source: "env", found: true, detail: "DBA_DOCTOR_KEY" },
    });
    // ⚠ NO `baseUrlQueryWithheld` KEY when there is nothing to withhold — the flag means something.
    expect("baseUrlQueryWithheld" in (r.provider.api as object)).toBe(false);
    // ⚠ STATUS ONLY. Never the value, never a prefix, never its LENGTH — length identifies the vendor
    // and narrows a brute force, and a diagnostic surface that leaks a secret is worse than none.
    const json = JSON.stringify(r);
    expect(json).not.toContain("sk-ant-SECRETsentinel");
    expect(json).not.toContain(String("sk-ant-SECRETsentinel".length));
    // The honest posture line, so doctor and an EVAL row cannot disagree about this run's hardening —
    // but as a NOTE, not an anomaly. ⚠ IT USED TO BE AN ANOMALY, and `anomalies.length > 0` drives the
    // verdict, so `ready` was UNREACHABLE for every API config: a correct install with a resolved key
    // and an https endpoint was reported as a broken machine on every single run. src/eval/posture.ts
    // makes precisely that argument for the fifth posture phrase existing at all, and doctor was
    // contradicting its own posture column.
    expect(r.provider.notes?.join(" ")).toContain("no CLI process to harden");
    expect(r.provider.anomalies).toEqual([]);
    expect(r.verdict).toBe("ready");
  } finally {
    if (prevKey === undefined) delete process.env.DBA_DOCTOR_KEY; else process.env.DBA_DOCTOR_KEY = prevKey;
  }
});

test("A3-D: a missing key and a cleartext endpoint are reported as anomalies, not hidden", async () => {
  await writeFile(configPath(), JSON.stringify({
    repos: [],
    provider: { api: { kind: "openai-compatible", model: "m", baseUrl: "http://gpu.corp.test:8000/v1", apiKeyEnv: "DBA_NOT_SET_AT_ALL" } },
  }));
  const r = await doctorReport(doctorDeps);
  expect(r.provider.api?.keySource).toEqual({ source: "none", found: false, detail: null });
  const anomalies = r.provider.anomalies.join(" | ");
  expect(anomalies).toContain("no API key resolved");
  expect(anomalies).toContain("cleartext");
  expect(r.verdict).toBe("degraded");
  // The network block reports the DERIVED gate, so doctor describes the gate the morning would apply.
  expect(r.network.hostsConfigured).toBe(1);
  expect(r.network.enabled).toBe(true);
});

test("⚠ A3-D: `doctor --json` NEVER SPAWNS the configured apiKeyCommand — it is a read-only surface", async () => {
  // MEASURED SIDE EFFECT. doctor called `resolveApiKey(apiCfg, process.env)` with no opts, so rung 3 ran
  // the user's configured binary — while main.ts introduces this whole block as "the read-only JSON
  // surfaces. None of them reaches run(), init(), the provider or the marker." It also reinstates the
  // exact hazard src/apiKey.ts's header gives as the reason there is NO built-in keychain: a macOS
  // keychain read for an item created by another binary raises an authorization DIALOG, so a scripted
  // or unattended `daily-briefing doctor --json` could block for the full 5 s ceiling or pop a prompt.
  //
  // The property is asserted with a REAL side effect, not a mock: the helper below writes a file if it
  // ever runs. A spy that merely counts calls would pass against a doctor that spawned by some other
  // route; a file that must not exist cannot.
  const canary = join(cfgHome, "apiKeyCommand-was-executed");
  const helper = join(cfgHome, "leaky-helper.sh");
  await writeFile(helper, `#!/bin/sh\ntouch ${JSON.stringify(canary)}\necho sk-should-never-be-read\n`, { mode: 0o755 });
  await writeFile(configPath(), JSON.stringify({
    repos: [],
    provider: { api: { kind: "anthropic", model: "m", apiKeyCommand: [helper, "--item", "secret-item-name"] } },
  }));

  const r = await doctorReport(doctorDeps);
  expect(await Bun.file(canary).exists()).toBe(false);          // ⚠ THE ASSERTION THIS TEST EXISTS FOR

  // …and the STATUS is still reported, with the command NAME only. `found: null` is a third state —
  // not "no key", which would be a diagnosis of something that was never tested — and `executed: false`
  // says so in the payload rather than leaving a reader to infer it.
  expect(r.provider.api?.keySource).toEqual({ source: "command", found: null, detail: helper, executed: false });
  // ⚠ argv[0] ONLY: later elements routinely name the keychain ITEM being fetched.
  expect(JSON.stringify(r)).not.toContain("secret-item-name");
  expect(JSON.stringify(r)).not.toContain("sk-should-never-be-read");
  // Not an anomaly — nothing is known to be wrong. A note that says what was not checked.
  expect(r.provider.notes?.join(" ")).toContain("does not run it");
  expect(r.provider.anomalies.join(" ")).not.toContain("no API key resolved");
});

test("⚠ A3-D: doctor prints the baseUrl WITHOUT its query string — a query is where a key can still hide", async () => {
  // `validateProviderApi` refuses USERINFO outright, which leaves `?api_key=…` as the one remaining
  // place a credential fits in a baseUrl — and it was rendered verbatim by `endpoint.toString()`, into
  // the output people paste into bug reports. The query is still SENT (see the transport tests); it is
  // only withheld from print, and the withholding is announced rather than silent.
  await writeFile(configPath(), JSON.stringify({
    repos: [],
    provider: { api: { kind: "openai-compatible", model: "m", baseUrl: "https://gw.corp.test/v1?api_key=sk-ant-api03-ZZSECRETZZ&api-version=2024-10-21#frag", apiKeyEnv: "DBA_NOT_SET_AT_ALL" } },
  }));
  const r = await doctorReport(doctorDeps);
  expect(r.provider.api?.baseUrl).toBe("https://gw.corp.test/v1");
  expect(r.provider.api?.baseUrlQueryWithheld).toBe(true);
  const json = JSON.stringify(r);
  expect(json).not.toContain("sk-ant-api03-ZZSECRETZZ");
  expect(json).not.toContain("api_key=");
});

test("⚠ the config-error message for an unparseable baseUrl does not echo its query either", () => {
  // Second surface, same class: main.ts prints `config error:` on EVERY 600 s tick, so this string
  // lands in briefing.log forever. A scheme-less baseUrl is exactly what reaches this throw.
  let msg = "";
  try {
    validateConfig({ provider: { api: { kind: "anthropic", model: "m", baseUrl: "gw.corp.test/v1?api_key=sk-ant-api03-ZZSECRETZZ" } } }, "/home/x");
  } catch (e) { msg = (e as Error).message; }
  expect(msg).toMatch(/not a valid URL/);
  expect(msg).not.toContain("sk-ant-api03-ZZSECRETZZ");
  expect(msg).not.toContain("api_key=");
  expect(msg).toContain("gw.corp.test/v1");               // …still enough to identify what was rejected
});

test("A3-D: a LOOPBACK api config reports the gate as DISABLED rather than unreachable", async () => {
  await writeFile(configPath(), JSON.stringify({
    repos: [], provider: { api: { kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:11434/v1" } },
  }));
  const r = await doctorReport(doctorDeps);
  expect(r.network.enabled).toBe(false);
  expect(r.network.hostsConfigured).toBe(0);
  // A keyless loopback endpoint is a CORRECT configuration, so it raises no missing-key anomaly.
  expect(r.provider.anomalies.join(" ")).not.toContain("no API key resolved");
});

test("A3-D: a CLI config's doctor output is UNCHANGED — no `api` key appears at all", async () => {
  await writeFile(configPath(), JSON.stringify({
    repos: [], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" },
  }));
  let whichCalls = 0;
  const r = await doctorReport({ ...doctorDeps, which: async () => { whichCalls++; return "/usr/local/bin/claude"; }, capabilities: async () => ({ kind: "ok", supported: new Set(["--tools"]) }) as never });
  expect(whichCalls).toBe(1);                 // the CLI probe still runs for a CLI config
  expect("api" in r.provider).toBe(false);    // ADDITIVE-OPTIONAL: absent, not null
  expect(r.provider.found).toBe(true);
  expect(r.provider.hardeningAvailable).toBe(true);
});
