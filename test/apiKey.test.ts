// test/apiKey.test.ts — A3/T3. The four-rung ladder, and the leak test that is not optional.
//
// ⚠ THE SENTINEL LEAK TEST IS THE POINT OF THIS FILE. This is the one new place the project handles a
// secret, and the whole invariant — the key value never reaches a warning, an error, a log line or any
// returned field but `key` — is one careless template literal away from being false. So a distinctive
// value goes in and every non-`key` byte that comes out is searched for it.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiKey, keyStatusLine, DEFAULT_KEY_ENV, PLAINTEXT_KEY_SENTINEL } from "../src/apiKey";
import { ProviderError, type ProviderApi } from "../src/types";
import type { RunResult } from "../src/proc";
import { AnthropicApiProvider } from "../src/providers/anthropic";
import { failoverReason } from "../src/failover";
import { isAppOwnedKey, type ListEntry } from "../src/providerList";
import { keysDir } from "../src/marker";
import { appKeyFileRelation, readsAsAppKeyFile, strictReadFolder } from "../src/keyFile";
import { ASYNC_FS, type AsyncFsOps } from "../src/strictFile";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

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

// ── rung 2 under <state>/keys/: the strict reader (provider-fallback P2-M5-T1, spec r9 §6 "Strict reader") ──────────
//
// A file in the app's key folder is one the APP wrote (`k-<12 hex>.key`, 0600, one link, in a 0700 folder), so the
// morning rung reads it only through the strict reader, opening the path AS CONFIGURED. Anything else there — a
// wrong name (judged on the canonical path, so a symlinked alias cannot borrow a good name), a symlink, a second
// hard link, a loose mode, another owner — is refused with a warning and never handed to the lax mode-only check.
// Every other `apiKeyFile` keeps today's check exactly. Each case builds its own `<root>/state/keys` and passes it
// as `keysDir`; one case drives the production default, `keysDir()`, inside the isolated state dir.

const GOOD = "k-0123456789ab.key";

/** Does the volume `tmpdir()` is on fold case? Measured once: a folder made lower-case, looked up upper-case. */
const TMP_FOLDS_CASE = (() => {
  const probe = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-apikey-case-")));
  mkdirSync(join(probe, "case"));
  return existsSync(join(probe, "CASE"));
})();

/** `<root>/state/keys` (0700) holding GOOD = SENTINEL (0600), and an empty `<root>/outside`. */
function keyFolder(): { root: string; keys: string; good: string; outside: string } {
  const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-apikey-keys-")));
  const keys = join(root, "state", "keys");
  mkdirSync(keys, { recursive: true });
  chmodSync(keys, 0o700);
  const good = join(keys, GOOD);
  writeFileSync(good, `${SENTINEL}\n`);
  chmodSync(good, 0o600);
  const outside = join(root, "outside");
  mkdirSync(outside);
  return { root, keys, good, outside };
}
/** A private (0600) file holding SENTINEL — what the LAX check would happily read. */
function privateFile(path: string): string {
  writeFileSync(path, SENTINEL);
  chmodSync(path, 0o600);
  return path;
}
/** A `statFile` that records every path the LAX check was asked about, answering as the real one does. */
function laxSpy() {
  const asked: string[] = [];
  const statFile = async (p: string) => { asked.push(p); try { return { mode: statSync(p).mode }; } catch { return undefined; } };
  return { asked, statFile };
}

describe("rung 2 under <state>/keys/ — the strict reader", () => {
  test("an app key file the app wrote resolves through the strict reader, never the lax check", async () => {
    const { keys, good } = keyFolder();
    const lax = laxSpy();
    const r = await resolveApiKey(anthropic({ apiKeyFile: good }), {}, { keysDir: keys, statFile: lax.statFile });
    expect([r.key, r.source, r.detail]).toEqual([SENTINEL, "file", good]);
    expect(r.warnings).toEqual([]);
    expect(lax.asked).toEqual([]);
  });

  test("a keys/ path whose basename is not k-<12 hex>.key is REFUSED, never handed to the lax check", async () => {
    const { keys } = keyFolder();
    for (const name of ["notes.key", "k-0123456789AB.key", "k-0123456789ab.key.bak", "k-0123456789a.key", "anthropic-key"]) {
      const p = privateFile(join(keys, name));
      const lax = laxSpy();
      const r = await resolveApiKey(anthropic({ apiKeyFile: p }), {}, { keysDir: keys, statFile: lax.statFile });
      expect(`${name}: ${r.key} ${r.source}`).toBe(`${name}: undefined none`);
      expect(`${name}: ${r.warnings.join(" ")}`).toMatch(/refusing to read provider\.api\.apiKeyFile .* not an app key file/);
      expect(`${name}: lax asked ${lax.asked.length}`).toBe(`${name}: lax asked 0`);
      expect(printableSurface(r)).not.toContain(SENTINEL);
    }
    // A keys/ name that does not exist yet with a wrong basename is refused by its name too (not "could not be read").
    const missing = await resolveApiKey(anthropic({ apiKeyFile: join(keys, "not-yet.key") }), {}, { keysDir: keys });
    expect(missing.warnings.join(" ")).toMatch(/not an app key file/);
  });

  test("the basename is judged on the CANONICAL path: a symlinked alias cannot borrow a good name, nor a symlinked parent", async () => {
    const { root, keys, outside } = keyFolder();
    const target = privateFile(join(keys, "notes.txt"));
    // The alias's OWN name passes the pattern; the file it IS does not.
    const alias = join(outside, "k-aaaaaaaaaaaa.key");
    symlinkSync(target, alias);
    const viaAlias = await resolveApiKey(anthropic({ apiKeyFile: alias }), {}, { keysDir: keys });
    expect([viaAlias.key, viaAlias.source]).toEqual([undefined, "none"]);
    expect(viaAlias.warnings.join(" ")).toMatch(/not an app key file/);
    // A symlinked PARENT into keys/.
    symlinkSync(keys, join(root, "keys-alias"));
    const viaParent = await resolveApiKey(anthropic({ apiKeyFile: join(root, "keys-alias", "notes.txt") }), {}, { keysDir: keys });
    expect([viaParent.key, viaParent.source]).toEqual([undefined, "none"]);
    expect(viaParent.warnings.join(" ")).toMatch(/not an app key file/);
    // ⚠ The warning names the path AS CONFIGURED and nothing it resolves to: not the folder, not the target's name.
    for (const r of [viaAlias, viaParent]) {
      expect(r.warnings.join(" ")).not.toContain(keys);
      expect(printableSurface(r)).not.toContain(SENTINEL);
    }
    expect(viaAlias.warnings.join(" ")).not.toContain("notes.txt");
  });

  test("an alias to a GOOD app key file is still read only as configured — so the strict reader refuses it", async () => {
    const { root, keys, good, outside } = keyFolder();
    const alias = join(outside, "my.key");
    symlinkSync(good, alias);
    symlinkSync(keys, join(root, "keys-alias"));
    // …and a RELATIVE spelling of the good file itself that goes through `..`: `strictReadFolder` (src/keyFile.ts)
    // trusts a relative parent only when the path has NO `..` segment, so this one is handed `keys`, whose exact-name
    // test refuses it. Spelled explicitly from a fixed cwd (the key folder's root), never `relative(process.cwd(), …)`,
    // whose answer has a `..` only when TMPDIR sits outside the cwd (P2-M5 checkpoint B2).
    const cwd = process.cwd();
    process.chdir(root);
    try {
      for (const p of [alias, join(root, "keys-alias", GOOD), `state/keys/../keys/${GOOD}`]) {
        const lax = laxSpy();
        const r = await resolveApiKey(anthropic({ apiKeyFile: p }), {}, { keysDir: keys, statFile: lax.statFile });
        expect(`${p}: ${r.key} ${r.source}`).toBe(`${p}: undefined none`);
        expect(r.warnings.join(" ")).toMatch(/refusing to read provider\.api\.apiKeyFile .* app's key folder/);
        expect(lax.asked).toEqual([]);
      }
      // The contrast, from the same cwd: a relative spelling with NO `..` whose parent is canonically keys/ IS read —
      // by the strict reader, still never the lax check (the docstring's rule, so the case above is refused for its `..`).
      const lax = laxSpy();
      const plain = await resolveApiKey(anthropic({ apiKeyFile: `state/keys/${GOOD}` }), {}, { keysDir: keys, statFile: lax.statFile });
      expect([plain.key, plain.source]).toEqual([SENTINEL, "file"]);
      expect(lax.asked).toEqual([]);
    } finally { process.chdir(cwd); }
  });

  test("a keys/ file failing the strict reader — symlink out, second hard link, loose mode, another owner, loose folder — is refused by name", async () => {
    const cases: [string, (f: ReturnType<typeof keyFolder>) => string, RegExp, { owner?: boolean }?][] = [
      // A symlink INSIDE keys/ that resolves OUTSIDE it: the lax check would read the outside file.
      // Its target carries a good name too, so the NAME test passes and the strict reader is what refuses it.
      ["symlink out", (f) => { const p = join(f.keys, "k-bbbbbbbbbbbb.key"); symlinkSync(privateFile(join(f.outside, "k-dddddddddddd.key")), p); return p; }, /file-symlink/],
      ["second hard link", (f) => { linkSync(f.good, join(f.outside, "copy")); return f.good; }, /file-hardlinked/],
      ["group-readable", (f) => { chmodSync(f.good, 0o640); return f.good; }, /file-permissions/],
      ["folder group-readable", (f) => { chmodSync(f.keys, 0o750); return f.good; }, /dir-permissions/],
      ["another owner", (f) => f.good, /file-owner/, { owner: true }],
    ];
    for (const [name, make, reason, o] of cases) {
      const f = keyFolder();
      const p = make(f);
      const lax = laxSpy();
      const r = await resolveApiKey(anthropic({ apiKeyFile: p }), {}, {
        keysDir: f.keys, statFile: lax.statFile,
        ...(o?.owner ? { keyFileOwnerCheck: (_st: { uid: number }, which: "dir" | "file") => which === "dir" } : {}),
      });
      expect(`${name}: ${r.key} ${r.source}`).toBe(`${name}: undefined none`);
      expect(`${name}: ${r.warnings.join(" ")}`).toMatch(/refusing to read provider\.api\.apiKeyFile .* app's key folder/);
      expect(`${name}: ${r.warnings.join(" ")}`).toMatch(reason);
      expect(`${name}: lax asked ${lax.asked.length}`).toBe(`${name}: lax asked 0`);
      expect(`${name}: ${printableSurface(r).includes(SENTINEL)}`).toBe(`${name}: false`);
      expect(`${name}: ${r.warnings.join(" ").includes(f.outside)}`).toBe(`${name}: false`);
    }
  });

  test("a hard link OUTSIDE keys/ to an app key file IS an app key file (hub Q26): strict, so refused", async () => {
    const { keys, good, outside } = keyFolder();
    const hard = join(outside, "hard.key");
    linkSync(good, hard);
    const lax = laxSpy();
    const r = await resolveApiKey(anthropic({ apiKeyFile: hard }), {}, { keysDir: keys, statFile: lax.statFile });
    expect([r.key, r.source]).toEqual([undefined, "none"]);
    expect(lax.asked).toEqual([]);
  });

  test("a refused keys/ file behaves as today's failed file rung: warned, then the later rungs are tried", async () => {
    const { keys } = keyFolder();
    const bad = privateFile(join(keys, "notes.key"));
    const viaCmd = await resolveApiKey(anthropic({ apiKeyFile: bad, apiKeyCommand: ["helper"] }), {},
      { keysDir: keys, exec: fakeRun({ out: "from-command\n" }) });
    expect([viaCmd.key, viaCmd.source]).toEqual(["from-command", "command"]);
    expect(viaCmd.warnings.join(" ")).toMatch(/not an app key file/);
    // …and with no later rung, no key: the provider then raises the named `key-unavailable` skip.
    const none = await resolveApiKey(anthropic({ apiKeyFile: bad }), { ANTHROPIC_API_KEY: "ambient" }, { keysDir: keys });
    expect([none.key, none.source]).toEqual([undefined, "none"]);
    let fetched = 0;
    const p = new AnthropicApiProvider(anthropic({ apiKeyFile: bad }), {
      env: {}, keyOpts: { keysDir: keys }, fetchImpl: (async () => { fetched++; return new Response("{}"); }) as unknown as typeof fetch,
    });
    const err = await p.generate("hi").then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(failoverReason(err as ProviderError, "anthropic")).toBe("key-unavailable");
    expect(fetched).toBe(0);
    expect(p.runtimeWarnings.join(" ")).toMatch(/not an app key file/);
  });

  test("⚠ a non-keys/ apiKeyFile behaves EXACTLY as today — the lax check, today's words — whatever keys/ holds", async () => {
    const f = keyFolder();
    // keys/ holds a hard-to-walk corner (hub Q26's incomplete walk): it must not turn the user's own file strict.
    mkdirSync(join(f.keys, "locked"));
    chmodSync(join(f.keys, "locked"), 0o300);
    try {
      const own = privateFile(join(f.outside, "anthropic-key"));
      const lax = laxSpy();
      const ok = await resolveApiKey(anthropic({ apiKeyFile: own }), {}, { keysDir: f.keys, statFile: lax.statFile });
      expect([ok.key, ok.source, ok.detail]).toEqual([SENTINEL, "file", own]);
      expect(ok.warnings).toEqual([]);
      expect(lax.asked).toEqual([own]);
      // A loose mode: today's refusal, word for word.
      const loose = privateFile(join(f.outside, "loose"));
      chmodSync(loose, 0o644);
      const refused = await resolveApiKey(anthropic({ apiKeyFile: loose }), {}, { keysDir: f.keys });
      expect(refused.warnings).toEqual([`api key: refusing to read provider.api.apiKeyFile ${loose} — it is group- or world-readable (mode 644); run \`chmod 600\` on it`]);
      // Missing and empty: today's words. A k-<hex>.key NAME outside keys/ is not an app key file either.
      expect((await resolveApiKey(anthropic({ apiKeyFile: join(f.outside, "absent") }), {}, { keysDir: f.keys })).warnings)
        .toEqual([`api key: provider.api.apiKeyFile ${join(f.outside, "absent")} could not be read`]);
      const empty = join(f.outside, "empty");
      writeFileSync(empty, "\n");
      chmodSync(empty, 0o600);
      expect((await resolveApiKey(anthropic({ apiKeyFile: empty }), {}, { keysDir: f.keys })).warnings)
        .toEqual([`api key: provider.api.apiKeyFile ${empty} is empty`]);
      const lookalike = privateFile(join(f.outside, GOOD));
      expect((await resolveApiKey(anthropic({ apiKeyFile: lookalike }), {}, { keysDir: f.keys })).key).toBe(SENTINEL);
      // A sibling folder whose name merely STARTS with `keys` is outside.
      mkdirSync(join(f.root, "state", "keysX"));
      const sib = privateFile(join(f.root, "state", "keysX", "notes.key"));
      expect((await resolveApiKey(anthropic({ apiKeyFile: sib }), {}, { keysDir: f.keys })).key).toBe(SENTINEL);
      // A user's own file under a state dir with NO keys/ at all.
      expect((await resolveApiKey(anthropic({ apiKeyFile: own }), {}, { keysDir: join(f.root, "no-keys") })).key).toBe(SENTINEL);
    } finally { chmodSync(join(f.keys, "locked"), 0o700); }
  });

  test("agreement with isAppOwnedKey: every key file it calls app-owned is read only by the strict reader", async () => {
    const f = keyFolder();
    symlinkSync(f.keys, join(f.root, "keys-alias"));
    linkSync(f.good, join(f.outside, "hard.key"));
    mkdirSync(join(f.keys, "sub"));
    symlinkSync(join(f.keys, "sub"), join(f.outside, "link"));
    const owned = [
      f.good, join(f.keys, "notes.key"), join(f.root, "keys-alias", GOOD), join(f.outside, "hard.key"),
      `${f.outside}/link/../${GOOD}`,       // RAW: `join` would fold the `..` the kernel resolves through `link`
    ];
    for (const p of owned) {
      const entry = { provider: { cli: "x", argv: [], promptVia: "stdin", api: anthropic({ apiKeyFile: p }) } } as unknown as ListEntry;
      expect(`${p}: ${isAppOwnedKey(entry, f.keys)}`).toBe(`${p}: true`);
      const lax = laxSpy();
      await resolveApiKey(anthropic({ apiKeyFile: p }), {}, { keysDir: f.keys, statFile: lax.statFile });
      expect(`${p}: lax asked ${lax.asked.length}`).toBe(`${p}: lax asked 0`);
    }
  });

  // P2-M5-T1 checkpoint LOW 1: an incomplete walk of keys/ (here keys/ itself 0300 — enterable, not listable) leaves a
  // hard link OUTSIDE keys/ to a genuine key with relation `unknown`. A second link is what makes it strict; a user's own
  // single-link file keeps today's lax read (requirement 9).
  test("an incomplete walk: a hard link outside keys/ to a genuine key is REFUSED; a single-link user file is read as today", async () => {
    const f = keyFolder();
    const hard = join(f.outside, "hard.key");
    linkSync(f.good, hard);
    const named = join(f.outside, GOOD);                    // a hard link that ALSO borrows a good basename
    linkSync(f.good, named);
    const own = privateFile(join(f.outside, "anthropic-key"));
    chmodSync(f.keys, 0o300);
    try {
      for (const p of [hard, named]) {
        expect(`${p}: ${appKeyFileRelation(p, f.keys)}`).toBe(`${p}: unknown`);   // the branch under test
        const lax = laxSpy();
        const r = await resolveApiKey(anthropic({ apiKeyFile: p }), {}, { keysDir: f.keys, statFile: lax.statFile });
        expect(`${p}: ${r.key} ${r.source}`).toBe(`${p}: undefined none`);
        expect(`${p}: lax asked ${lax.asked.length}`).toBe(`${p}: lax asked 0`);
        expect(r.warnings.join(" ")).toMatch(/refusing to read provider\.api\.apiKeyFile .* it is, or may name, a file in the app's key folder/);
        expect(printableSurface(r)).not.toContain(SENTINEL);
        expect(r.warnings.join(" ")).not.toContain(f.keys);
      }
      expect(appKeyFileRelation(own, f.keys)).toBe("unknown");
      const lax = laxSpy();
      const ok = await resolveApiKey(anthropic({ apiKeyFile: own }), {}, { keysDir: f.keys, statFile: lax.statFile });
      expect([ok.key, ok.source, ok.detail]).toEqual([SENTINEL, "file", own]);
      expect(ok.warnings).toEqual([]);
      expect(lax.asked).toEqual([own]);
    } finally { chmodSync(f.keys, 0o700); }
  });

  // P2-M5-T1 checkpoint LOW 2: the configured path and keysDir() may reach the SAME folder through different symlinked
  // ancestors; a genuine single-link key there is read, in both directions. The final folder itself must still not be
  // a symlink (the "alias to a GOOD app key file" case above).
  test("a genuine key reached through a different symlinked ANCESTOR of keys/ is read, both directions", async () => {
    const f = keyFolder();
    symlinkSync(join(f.root, "state"), join(f.root, "state-alias"));
    const aliasKeys = join(f.root, "state-alias", "keys");
    for (const [name, path, keys] of [
      ["keys via alias, path real", f.good, aliasKeys],
      ["keys real, path via alias", join(aliasKeys, GOOD), f.keys],
    ] as const) {
      const lax = laxSpy();
      const r = await resolveApiKey(anthropic({ apiKeyFile: path }), {}, { keysDir: keys, statFile: lax.statFile });
      expect(`${name}: ${r.key} ${r.source} ${r.detail}`).toBe(`${name}: ${SENTINEL} file ${path}`);
      expect(`${name}: ${r.warnings.join(" ")}`).toBe(`${name}: `);
      expect(`${name}: lax asked ${lax.asked.length}`).toBe(`${name}: lax asked 0`);
    }
    // …and a wrong name reached that way is still refused by its name, a second link still by the strict reader.
    privateFile(join(f.keys, "notes.key"));
    const r1 = await resolveApiKey(anthropic({ apiKeyFile: join(aliasKeys, "notes.key") }), {}, { keysDir: f.keys });
    expect([r1.key, r1.warnings.join(" ")]).toEqual([undefined, expect.stringMatching(/not an app key file/)]);
    linkSync(f.good, join(f.outside, "copy"));
    const r2 = await resolveApiKey(anthropic({ apiKeyFile: join(aliasKeys, GOOD) }), {}, { keysDir: f.keys });
    expect([r2.key, r2.warnings.join(" ")]).toEqual([undefined, expect.stringMatching(/file-hardlinked/)]);
  });

  // P2-M5-T4 checkpoint LOW 5: `canonicalPath` case-folds on darwin, so on a case-SENSITIVE volume a sibling folder
  // `<state>/Keys/` compares equal to `<state>/keys/`. It is a different folder: the strict reader must be handed keys/
  // (which refuses the path by name), never the sibling (which it would read as if it were the app's folder). Skipped
  // by name where the test volume folds case, since `Keys` there IS `keys` (the symlinked-ANCESTOR case above covers
  // that a genuine alias still reads). On Linux nothing folds, so the sibling never compared equal: the answer holds.
  test.skipIf(TMP_FOLDS_CASE)("a different-CASE sibling of keys/ on a case-sensitive volume is not keys/: the strict reader gets keys/, and refuses", async () => {
    const f = keyFolder();
    const sibling = join(f.root, "state", "Keys");
    mkdirSync(sibling);
    chmodSync(sibling, 0o700);
    const p = privateFile(join(sibling, GOOD));
    expect(await strictReadFolder(p, f.keys)).toBe(f.keys);
    if (process.platform === "darwin") {
      // Folded equal on darwin, so the morning rung reads it strictly — and the reader, handed keys/, refuses it by name.
      expect(await readsAsAppKeyFile(p, f.keys)).toBe(true);
      const lax = laxSpy();
      const r = await resolveApiKey(anthropic({ apiKeyFile: p }), {}, { keysDir: f.keys, statFile: lax.statFile });
      expect([r.key, r.source]).toEqual([undefined, "none"]);
      expect(r.warnings.join(" ")).toMatch(/name-invalid/);
      expect(lax.asked).toEqual([]);
    }
  });

  // P2-M5-T1 checkpoint LOW 4: the one deliberate DISAGREEMENT with isAppOwnedKey (src/keyFile.ts header, difference
  // 2): a symlink entry in keys/ pointing OUTSIDE names a file that is not the app's, so it is not app-owned — yet the
  // morning rung reads it strictly, which refuses it as a symlink rather than reading the file it points at.
  test("a symlink entry in keys/ pointing outside: NOT app-owned, yet strict on the morning rung (refused as a symlink)", async () => {
    const f = keyFolder();
    const p = join(f.keys, "k-bbbbbbbbbbbb.key");
    symlinkSync(privateFile(join(f.outside, "k-dddddddddddd.key")), p);
    const entry = { provider: { cli: "x", argv: [], promptVia: "stdin", api: anthropic({ apiKeyFile: p }) } } as unknown as ListEntry;
    expect(isAppOwnedKey(entry, f.keys)).toBe(false);
    expect(await readsAsAppKeyFile(p, f.keys)).toBe(true);
    const lax = laxSpy();
    const r = await resolveApiKey(anthropic({ apiKeyFile: p }), {}, { keysDir: f.keys, statFile: lax.statFile });
    expect([r.key, r.source]).toEqual([undefined, "none"]);
    expect(r.warnings.join(" ")).toMatch(/file-symlink/);
    expect(lax.asked).toEqual([]);
  });

  test("the production default is keysDir(): a wrong name there is refused with no keysDir passed", async () => {
    const keys = keysDir();
    const existed = existsSync(keys);
    mkdirSync(keys, { recursive: true });
    chmodSync(keys, 0o700);
    const p = privateFile(join(keys, "notes.key"));
    try {
      const r = await resolveApiKey(anthropic({ apiKeyFile: p }), {});
      expect([r.key, r.source]).toEqual([undefined, "none"]);
      expect(r.warnings.join(" ")).toMatch(/not an app key file/);
    } finally {
      rmSync(p, { force: true });
      if (!existed) rmSync(keys, { recursive: true, force: true });
    }
  });
});

// PR 2 final harden round 3, M1: the key-folder test runs on EVERY `apiKeyFile` — a user's own file outside keys/ too —
// and it stats and walks. Run synchronously, a stat stalled on a dead mount blocked the event loop, so the walk's
// attempt deadline and `provider test`'s could not fire (reviewer A measured 1812 ms for a 300 ms Test). It is async now.
describe("rung 2's key-folder test is ASYNC: a stalled mount cannot block the event loop (final harden r3, M1)", () => {
  /** `ASYNC_FS` with every call held until `release()` — a dead mount — counting the calls it was asked. */
  function stalledFs() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let asked = 0;
    const ops = Object.fromEntries(Object.entries(ASYNC_FS).map(([op, f]) =>
      [op, async (p: string) => { asked++; await gate; return (f as (p: string) => Promise<unknown>)(p); }])) as AsyncFsOps;
    return { ops, release, asked: () => asked };
  }

  test("a stat stalled on a user's own apiKeyFile leaves a 300 ms timer free to fire; once released, the same answer as today", async () => {
    const { keys, outside } = keyFolder();
    const own = privateFile(join(outside, "user.key"));
    const fs = stalledFs();
    const t0 = performance.now();
    const pending = resolveApiKey(anthropic({ apiKeyFile: own }), {}, { keysDir: keys, keyFileFs: fs.ops });
    const first = await Promise.race([pending.then(() => "resolved"), new Promise<string>((r) => setTimeout(() => r("timer"), 300))]);
    expect(first).toBe("timer");
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(fs.asked()).toBeGreaterThan(0);                     // the rung asked the injected fs — else the timer proves nothing
    fs.release();
    const r = await pending;
    expect([r.key, r.source, r.detail]).toEqual([SENTINEL, "file", own]);
    expect(r.warnings).toEqual([]);
  });

  test("all three key-folder questions run on the injected fs: a genuine key's name test and folder test ask it too", async () => {
    const { keys, good } = keyFolder();
    const asked: string[] = [];
    const ops = Object.fromEntries(Object.entries(ASYNC_FS).map(([op, f]) =>
      [op, (p: string) => { asked.push(`${op} ${p}`); return (f as (p: string) => Promise<unknown>)(p); }])) as AsyncFsOps;
    const r = await resolveApiKey(anthropic({ apiKeyFile: good }), {}, { keysDir: keys, keyFileFs: ops });
    expect([r.key, r.source]).toEqual([SENTINEL, "file"]);
    // `readsAsAppKeyFile` (its canonical test answers app-key at once) and `isAppKeyFileName` each realpath the path;
    // only `strictReadFolder` asks the native realpath, of the parent (= keys/) and of keys/.
    expect(asked.filter((a) => a === `realpath ${good}`)).toHaveLength(2);
    expect(asked.filter((a) => a === `realpathNative ${keys}`)).toHaveLength(2);
  });
});
