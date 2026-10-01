// test/apiKey.test.ts — A3/T3. The four-rung ladder, and the leak test that is not optional.
//
// ⚠ THE SENTINEL LEAK TEST IS THE POINT OF THIS FILE. This is the one new place the project handles a
// secret, and the whole invariant — the key value never reaches a warning, an error, a log line or any
// returned field but `key` — is one careless template literal away from being false. So a distinctive
// value goes in and every non-`key` byte that comes out is searched for it.
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiKey, keyStatusLine, DEFAULT_KEY_ENV, PLAINTEXT_KEY_SENTINEL } from "../src/apiKey";
import type { ProviderApi } from "../src/types";
import type { RunResult } from "../src/proc";

/** Distinctive enough that a substring match cannot be an accident, and shaped like a real key so a
 *  redaction pattern that happens to match real keys would also match this one. */
const SENTINEL = "sk-ant-api03-ZZTOPSECRETsentinelVALUE-do-not-log-0000";

const anthropic = (extra: Partial<ProviderApi> = {}): ProviderApi => ({ kind: "anthropic", model: "m", ...extra });

const fakeRun = (r: Partial<RunResult>) => async (): Promise<RunResult> =>
  ({ out: "", err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false, ...r });

/** Every string a caller could ever print, EXCEPT `key`. If the sentinel is in any of them, we leaked. */
const printableSurface = (r: Awaited<ReturnType<typeof resolveApiKey>>) =>
  JSON.stringify({ source: r.source, detail: r.detail, warnings: r.warnings, status: keyStatusLine(r) });

// ── rung 1: env ───────────────────────────────────────────────────────────────────────────────────

test("rung 1: a NAMED environment variable resolves, and empty/whitespace counts as absent", async () => {
  const api = anthropic({ apiKeyEnv: "MY_KEY" });
  const hit = await resolveApiKey(api, { MY_KEY: `  ${SENTINEL}  ` });
  expect(hit.key).toBe(SENTINEL);                       // trimmed — a stray newline is not part of a key
  expect(hit.source).toBe("env");
  expect(hit.detail).toBe("MY_KEY");

  const blank = await resolveApiKey(api, { MY_KEY: "   " });
  expect(blank.key).toBeUndefined();
  expect(blank.warnings.join(" ")).toContain("MY_KEY");  // names the variable, so it is actionable
});

test("rung 1 DEFAULT: the conventional variable is consulted only when NO rung is configured", async () => {
  // ⚠ THIS IS THE AMBIENT-KEY RULE. Once the user names a file or a command, there is NO silent
  // fallback to the environment — that fallback is how a key you believed you had retired keeps being
  // spent, which is the exact failure this project has already paid for once.
  const env = { ANTHROPIC_API_KEY: SENTINEL, OPENAI_API_KEY: SENTINEL };
  expect((await resolveApiKey(anthropic(), env)).detail).toBe(DEFAULT_KEY_ENV.anthropic);
  expect((await resolveApiKey({ kind: "openai-compatible", model: "m", baseUrl: "https://x.test" }, env)).detail)
    .toBe(DEFAULT_KEY_ENV["openai-compatible"]);

  // …but with ANOTHER rung configured, the ambient variable is invisible.
  const withFile = await resolveApiKey(anthropic({ apiKeyFile: "/nope/missing" }), env);
  expect(withFile.key).toBeUndefined();
  expect(withFile.source).toBe("none");
});

// ── rung 2: file ──────────────────────────────────────────────────────────────────────────────────

test("rung 2: a 0600 file resolves (trailing newline trimmed); a 0644 file is REFUSED", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dba-apikey-"));
  try {
    const good = join(dir, "key600");
    await writeFile(good, `${SENTINEL}\n`);
    await chmod(good, 0o600);
    const ok = await resolveApiKey(anthropic({ apiKeyFile: good }), {});
    expect(ok.key).toBe(SENTINEL);
    expect(ok.source).toBe("file");

    // ⚠ REFUSED, NOT CHMOD'D. Silently widening or narrowing permissions on somebody else's file is a
    // side effect a config reader has no business having — and reading it anyway would make the check
    // theatre. Same spirit as harden.ts's `safeOwnDir`, which refuses rather than repairs.
    const loose = join(dir, "key644");
    await writeFile(loose, SENTINEL);
    await chmod(loose, 0o644);
    const refused = await resolveApiKey(anthropic({ apiKeyFile: loose }), {});
    expect(refused.key).toBeUndefined();
    expect(refused.warnings.join(" ")).toMatch(/group- or world-readable/);
    expect(refused.warnings.join(" ")).toContain("644");
    expect(printableSurface(refused)).not.toContain(SENTINEL);

    // A file that exists but is empty, and one that does not exist at all, each warn distinctly.
    const empty = join(dir, "empty");
    await writeFile(empty, "\n  \n");
    await chmod(empty, 0o600);
    expect((await resolveApiKey(anthropic({ apiKeyFile: empty }), {})).warnings.join(" ")).toMatch(/is empty/);
    expect((await resolveApiKey(anthropic({ apiKeyFile: join(dir, "absent") }), {})).warnings.join(" "))
      .toMatch(/could not be read/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── rung 3: command ───────────────────────────────────────────────────────────────────────────────

test("rung 3: a REAL child's stdout becomes the key", async () => {
  const r = await resolveApiKey(anthropic({ apiKeyCommand: ["printf", "%s\\n", SENTINEL] }), {});
  expect(r.key).toBe(SENTINEL);
  expect(r.source).toBe("command");
  expect(r.detail).toBe("printf");
});

test("rung 3: nonzero exit, empty stdout, an unspawnable command and a TIMEOUT each warn — and NONE shows output", async () => {
  // ⚠ NOTHING from the child's stdout or stderr ever reaches a warning. stdout IS the secret, and a
  // keychain helper's stderr routinely echoes the item it was asked for. Only the exit code and argv[0].
  const fail = await resolveApiKey(anthropic({ apiKeyCommand: ["sh", "-c", `printf %s ${SENTINEL} >&2; exit 3`] }), {});
  expect(fail.key).toBeUndefined();
  expect(fail.warnings.join(" ")).toContain("exited 3");
  expect(printableSurface(fail)).not.toContain(SENTINEL);

  const silent = await resolveApiKey(anthropic({ apiKeyCommand: ["true"] }), {});
  expect(silent.warnings.join(" ")).toMatch(/printed nothing/);

  const missing = await resolveApiKey(anthropic({ apiKeyCommand: ["dba-no-such-helper-xyzzy"] }), {});
  expect(missing.key).toBeUndefined();
  expect(missing.warnings.join(" ")).toMatch(/could not be run|exited/);

  // A REAL timeout against a REAL child, with the ceiling injected so the test does not wait 5 s.
  const slow = await resolveApiKey(anthropic({ apiKeyCommand: ["sleep", "5"] }), {}, { commandTimeoutMs: 250 });
  expect(slow.key).toBeUndefined();
  expect(slow.warnings.join(" ")).toMatch(/did not finish within 250ms|exited/);
});

test("rung 3: a child that leaves a GRANDCHILD holding stdout does not yield a truncated key", async () => {
  // The held-pipe hazard `proc.run` exists for. The parent exits immediately; a backgrounded child keeps
  // the inherited pipe open, so stdout never reaches EOF. `run` reports `complete: false` → `code: -1`,
  // and this ladder must treat that as NO KEY rather than as a possibly-truncated one — a truncated key
  // would 401 every morning with a diagnostic pointing at the wrong thing.
  const r = await resolveApiKey(
    anthropic({ apiKeyCommand: ["sh", "-c", `printf %s ${SENTINEL}; sleep 4 &`] }),
    {}, { commandTimeoutMs: 1_000 },
  );
  expect(r.key).toBeUndefined();
  expect(printableSurface(r)).not.toContain(SENTINEL);
});

// ── rung 4: plaintext ─────────────────────────────────────────────────────────────────────────────

test("rung 4: a literal apiKey WORKS but warns on every run", async () => {
  const r = await resolveApiKey(anthropic({ apiKey: SENTINEL }), {});
  expect(r.key).toBe(SENTINEL);
  expect(r.source).toBe("config");
  expect(r.warnings.join(" ")).toContain(PLAINTEXT_KEY_SENTINEL);
  // Supported rather than refused, because refusing it pushes people toward a machine-wide
  // `export ANTHROPIC_API_KEY` — the exact ambient-key pattern this repo's README already warns about.
  expect(printableSurface(r)).not.toContain(SENTINEL);
});

// ── precedence ────────────────────────────────────────────────────────────────────────────────────

test("⚠ precedence is PINNED: env > file > command > config, first hit wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dba-apikey-prec-"));
  try {
    const f = join(dir, "k");
    await writeFile(f, "from-file");
    await chmod(f, 0o600);
    const all: ProviderApi = anthropic({
      apiKeyEnv: "E", apiKeyFile: f, apiKeyCommand: ["printf", "%s", "from-command"], apiKey: "from-config",
    });
    expect((await resolveApiKey(all, { E: "from-env" })).key).toBe("from-env");
    expect((await resolveApiKey(all, {})).key).toBe("from-file");
    await chmod(f, 0o644);                                  // file now refused → falls through
    expect((await resolveApiKey(all, {})).key).toBe("from-command");
    const noCmd = anthropic({ apiKeyEnv: "E", apiKeyFile: f, apiKey: "from-config" });
    expect((await resolveApiKey(noCmd, {})).key).toBe("from-config");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── the no-key cases ──────────────────────────────────────────────────────────────────────────────

test("a LOOPBACK openai-compatible endpoint with no key configured returns no key and NO warning", async () => {
  // Ollama and LM Studio need no key. A daily warning for a correct configuration is how users learn to
  // ignore warnings, so this case must be silent — and the non-loopback case must not be.
  for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://127.0.1.1:8000/v1", "http://[::1]:11434/v1"]) {
    const r = await resolveApiKey({ kind: "openai-compatible", model: "m", baseUrl: url }, {});
    expect(`${url}: key=${r.key} warnings=${r.warnings.length}`).toBe(`${url}: key=undefined warnings=0`);
  }
  const remote = await resolveApiKey({ kind: "openai-compatible", model: "m", baseUrl: "https://api.openai.com/v1" }, {});
  expect(remote.warnings.join(" ")).toMatch(/no key found/);
  // 0.0.0.0 is a BIND address, not a destination — a config naming it is a mistake worth warning about.
  const anyAddr = await resolveApiKey({ kind: "openai-compatible", model: "m", baseUrl: "http://0.0.0.0:11434/v1" }, {});
  expect(anyAddr.warnings.join(" ")).toMatch(/no key found/);
});

test("the inapplicable CLI-shaped settings each warn exactly once, and say what to do instead", async () => {
  const r = await resolveApiKey(anthropic({ apiKeyEnv: "E" }), { E: SENTINEL }, {
    providerCredential: "env-api-key", providerHarden: false, providerAccounts: [{ label: "a" }],
  });
  const joined = r.warnings.join("\n");
  expect(joined).toContain("provider.credential");
  expect(joined).toContain("provider.harden");
  expect(joined).toContain("provider.accounts");
  expect(r.warnings).toHaveLength(3);
  expect(r.key).toBe(SENTINEL);                 // …and they do not interfere with resolution
  expect(printableSurface(r)).not.toContain(SENTINEL);
});

// ── the leak test ─────────────────────────────────────────────────────────────────────────────────

test("⚠ SENTINEL LEAK: no rung puts the key value into ANY field but `key`", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dba-apikey-leak-"));
  try {
    const f = join(dir, "k");
    await writeFile(f, SENTINEL);
    await chmod(f, 0o600);
    const cases: [string, ProviderApi, Record<string, string | undefined>][] = [
      ["env", anthropic({ apiKeyEnv: "E" }), { E: SENTINEL }],
      ["default env", anthropic(), { ANTHROPIC_API_KEY: SENTINEL }],
      ["file", anthropic({ apiKeyFile: f }), {}],
      ["command", anthropic({ apiKeyCommand: ["printf", "%s", SENTINEL] }), {}],
      ["config", anthropic({ apiKey: SENTINEL }), {}],
    ];
    for (const [name, api, env] of cases) {
      const r = await resolveApiKey(api, env);
      expect(`${name}: resolved`).toBe(`${name}: ${r.key === SENTINEL ? "resolved" : "NOT RESOLVED"}`);
      expect(`${name}: ${printableSurface(r).includes(SENTINEL)}`).toBe(`${name}: false`);
    }
    // …and the FAILING rungs too, which is where a diagnostic is most tempted to quote what it saw.
    const failures: [string, ProviderApi][] = [
      ["command stderr", anthropic({ apiKeyCommand: ["sh", "-c", `printf %s ${SENTINEL} >&2; exit 1`] })],
      ["command stdout nonzero", anthropic({ apiKeyCommand: ["sh", "-c", `printf %s ${SENTINEL}; exit 1`] })],
    ];
    for (const [name, api] of failures) {
      const r = await resolveApiKey(api, {});
      expect(`${name}: ${printableSurface(r).includes(SENTINEL)}`).toBe(`${name}: false`);
      expect(`${name}: ${r.key}`).toBe(`${name}: undefined`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keyStatusLine names the SOURCE and never the value", () => {
  expect(keyStatusLine({ key: SENTINEL, source: "env", detail: "MY_KEY", warnings: [] })).toBe("API key: found in $MY_KEY");
  expect(keyStatusLine({ key: SENTINEL, source: "file", detail: "/p/k", warnings: [] })).toContain("/p/k");
  expect(keyStatusLine({ key: SENTINEL, source: "command", detail: "helper", warnings: [] })).toContain("helper");
  expect(keyStatusLine({ source: "none", warnings: [] })).toMatch(/not found/);
  for (const s of ["env", "file", "command", "config"] as const) {
    expect(keyStatusLine({ key: SENTINEL, source: s, detail: "d", warnings: [] })).not.toContain(SENTINEL);
  }
});

test("an INJECTED exec covers the rung-3 branches without a spawn (the shape the providers use)", async () => {
  const ok = await resolveApiKey(anthropic({ apiKeyCommand: ["helper"] }), {}, { exec: fakeRun({ out: ` ${SENTINEL}\n` }) });
  expect(ok.key).toBe(SENTINEL);
  const dead = await resolveApiKey(anthropic({ apiKeyCommand: ["helper"] }), {}, { exec: fakeRun({ spawned: false, code: -1 }) });
  expect(dead.warnings.join(" ")).toMatch(/could not be run/);
  const late = await resolveApiKey(anthropic({ apiKeyCommand: ["helper"] }), {}, { exec: fakeRun({ timedOut: true, code: -1 }) });
  expect(late.warnings.join(" ")).toMatch(/did not finish/);
});

test("⚠ the two no-key cases do NOT share a line — a loopback endpoint needs no key", async () => {
  // Found by RUNNING the documented init command, not by reading: a correctly-configured Ollama user was
  // told "not found — set it", which is advice that cannot be acted on.
  const local = await resolveApiKey({ kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:11434/v1" }, {});
  expect(local.optional).toBe(true);
  expect(keyStatusLine(local)).toMatch(/not required/);
  const remote = await resolveApiKey({ kind: "openai-compatible", model: "m", baseUrl: "https://api.openai.com/v1" }, {});
  expect(remote.optional).toBeUndefined();
  expect(keyStatusLine(remote)).toMatch(/not found/);
});
