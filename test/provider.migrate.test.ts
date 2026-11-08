// test/provider.migrate.test.ts — `provider key migrate --index <n> --json` (provider-fallback plan P2-M3-T1; spec r9
// §4 "Indexes" and secrets, §6 `provider key migrate`), driven through the real `providerMain`.
//
// Migrate reads entry n's legacy literal `apiKey` from the SAVED config and stores it the way `key set` does — the same
// store call, the same answer `{schemaVersion, ok, keyId, apiKeyCommand | apiKeyFile}` — and writes NOTHING to the
// config: the app saves the new reference itself, then runs `key scrub-backup` (P2-M3-T2). This file pins what the
// command adds over `key set` (test/provider.key-cli.test.ts): which entries hold "a legacy literal", the `--index`
// refusals it shares with `reset` (a dropped entry, a broken `accounts`, out of range), the charset refusal of a
// literal BEFORE any store call, the config file left byte- and mtime-identical, the pre-store budget over the config
// read and the sweep, and that neither the literal nor the entry's label reaches argv, output or a state file.
//
// ⚠ FAKE-ONLY (hub Q27): the darwin cases go through an in-memory Keychain behind the `keyStore.exec` TEST seam; the one
// case with NO exec injected proves production uses the store's own BACKSTOPPED exec. No literal here names the
// Keychain tool — argv comes from SECURITY_BIN — so this file needs no REACH_CONDITIONAL entry. The config is always an
// injected temp file (`configFile`), never the real one; the file imports the isolation fixture (CONFIG_TRIGGERS).
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { providerMain, KEY_PRE_STORE_MS, type ProviderCliDeps } from "../src/providerCli";
import { APP_KEY_SERVICE, SECURITY_BIN } from "../src/appKeyNames";
import { appKeyCommand, KEY_CLEANUP_MS, KEY_ID_RE, KEY_NOT_FOUND_EXIT, KEY_OP_DEADLINE_MS, loginKeychainPath, type AppKeyDeps, type KeyExec } from "../src/keyStore";
import type { RunResult } from "../src/proc";
import { validateConfig } from "../src/config";
import { entryRevision, resolveProviderList } from "../src/providerList";
import { acquireRunLock, runLockPath } from "../src/runlock";
import { TIMEOUT_MS } from "../src/provider";
import { freshStateDir, tempDir } from "./helpers/walk";

const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
afterAll(() => { process.env.DAILY_BRIEFING_STATE_DIR = prevState; });

/** The legacy literals: in the store's charset, and distinct, so "which one was stored" is observable. */
const KEY1 = "sk-ant-api03_MiGrAtE.item1~0123+456/789=abc-XYZ";
const KEY2 = "sk-or-v1_MiGrAtE.fallback~9876+543/210=zyx-ABC";
/** Labels shaped like secrets: a label is user text that must never be echoed (hub Q25), nor be a Keychain account. */
const LABEL1 = "Item1-label-sk-LABELSECRET-one";
const LABEL2 = "Fallback-label-sk-LABELSECRET-two";
const HOME = "/Users/fake person";
const LOGIN = loginKeychainPath(HOME);
/** A pid above every platform's pid_max (macOS 99 999, Linux at most 2^22): `kill(pid, 0)` answers ESRCH. */
const DEAD_PID = 2147483646;
const A = "k-aaaaaaaaaaaa";

// ── a compact in-memory Keychain behind a recording exec (test/provider.key-cli.test.ts's twin) ─────────

type Call = { cmd: string[]; input?: string };
const result = (code: number, out = ""): RunResult => ({ out, err: "", code, complete: true, spawned: true, signal: null, timedOut: false });
const wordsOfLine = (line: string): string[] =>
  (line.match(/"[^"]*"|\S+/g) ?? []).map((w) => (w.startsWith('"') && w.endsWith('"') ? w.slice(1, -1) : w));
const after = (words: string[], flag: string): string | undefined => { const i = words.indexOf(flag); return i >= 0 ? words[i + 1] : undefined; };

function fakeKeychain(o: { corrupt?: boolean; stall?: "add"; deleteCode?: number } = {}) {
  const items = new Map<string, string>();
  const calls: Call[] = [];
  const exec: KeyExec = async (cmd, opts) => {
    calls.push({ cmd: [...cmd], ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    if (cmd[0] !== SECURITY_BIN) return result(127);
    if (cmd[1] === "-i") {
      if (o.stall === "add") return new Promise<RunResult>(() => {});
      const w = wordsOfLine((opts?.input ?? "").trim());
      items.set(after(w, "-a")!, o.corrupt ? "corrupted-value-123" : after(w, "-w")!);
      return result(0);
    }
    const acct = after(cmd, "-a");
    if (cmd[1] === "find-generic-password") { const v = items.get(acct!); return v === undefined ? result(KEY_NOT_FOUND_EXIT) : result(0, `${v}\n`); }
    if (cmd[1] === "delete-generic-password") {
      if (o.deleteCode !== undefined) return result(o.deleteCode);
      if (acct === undefined || !items.has(acct)) return result(KEY_NOT_FOUND_EXIT);
      items.delete(acct);
      return result(0);
    }
    return result(1);
  };
  return { exec, calls, items };
}
const allWords = (calls: Call[]): string[] => calls.flatMap((c) => [...c.cmd, ...(c.input !== undefined ? wordsOfLine(c.input) : [])]);

// ── configs ─────────────────────────────────────────────────────────────────────────────────────────

const anthropic = (key: Record<string, unknown>) => ({ api: { kind: "anthropic", model: "m", ...key } });
const remote = (key: Record<string, unknown>) => ({ api: { kind: "openai-compatible", model: "m", baseUrl: "https://example.invalid/v1", ...key } });
const LOCAL = { api: { kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9/v1" } };
const CLI = { cli: "/nonexistent/claude", argv: [], promptVia: "stdin" };

/** The fixture list. Index → what it is:
 *   0 item 1, an API entry with a literal (surrounded by whitespace: the store trims it)
 *   1 a key command          2 a literal (LABEL2)      3 a key file        4 a key env var
 *   5 a loopback model with no key at all             6 a CLI entry       7 a key env var AND a literal */
const LIST = {
  provider: { label: LABEL1, ...anthropic({ apiKey: `  ${KEY1}\n` }) },
  fallbacks: [
    { label: "F-command", ...anthropic({ apiKeyCommand: ["/nonexistent/key-helper", "--print"] }) },
    { label: LABEL2, ...remote({ apiKey: KEY2 }) },
    { label: "F-file", ...anthropic({ apiKeyFile: "/nonexistent/folder/k.key" }) },
    { label: "F-env", ...anthropic({ apiKeyEnv: "SOME_KEY_VAR" }) },
    { label: "F-local", ...LOCAL },
    { label: "F-cli", ...CLI },
    { label: "F-env-and-literal", ...anthropic({ apiKeyEnv: "SOME_KEY_VAR", apiKey: KEY2 }) },
  ],
};

/** A config file in a temp folder, 0600 as `init` writes one; returns its path. */
function configFile(cfg: Record<string, unknown>): string {
  const dir = tempDir("dba-migrate-cfg-");
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({ repos: [], ...cfg }, null, 2));
  chmodSync(p, 0o600);
  return p;
}

/** Everything about the config folder a write could change: each file's bytes, mode and mtime. */
function snapshot(file: string): string {
  const dir = join(file, "..");
  return JSON.stringify(readdirSync(dir).sort().map((n) => {
    const st = statSync(join(dir, n));
    return [n, readFileSync(join(dir, n), "base64"), st.mode, st.mtimeMs, st.size];
  }));
}

// ── the command ─────────────────────────────────────────────────────────────────────────────────────

const home = tempDir("dba-migrate-home-");
/** Run `provider <args>` against `file` with captured output, a non-TTY stdin and the given store seams. */
async function cli(args: string[], file: string, deps: ProviderCliDeps = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await providerMain(args, { configFile: file, home, env: {}, out: (s) => out.push(s), err: (s) => err.push(s), isTTY: false, ...deps });
  const last = out.at(-1);
  return { code, out, err, text: [...out, ...err].join("\n"), json: last !== undefined ? JSON.parse(last) as Record<string, unknown> : undefined };
}
const migrate = (n: number | string, file: string, deps: ProviderCliDeps = {}) => cli(["key", "migrate", "--index", String(n), "--json"], file, deps);
const mac = (exec: KeyExec, extra: AppKeyDeps = {}): AppKeyDeps => ({ platform: "darwin", exec, home: HOME, env: {}, ...extra });
const linux = (extra: AppKeyDeps = {}): AppKeyDeps => ({ platform: "linux", ...extra });

function filesUnder(dir: string, rel = ""): string[] {
  if (!existsSync(join(dir, rel))) return [];
  return readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel === "" ? n : join(rel, n);
    const st = lstatSync(join(dir, r));
    return st.isDirectory() ? filesUnder(dir, r) : st.isFile() ? [r] : [];
  });
}
const holding = (state: string, secret: string): string[] =>
  filesUnder(state).filter((f) => readFileSync(join(state, f), "utf8").includes(secret)).sort();

/** `<state>/keys`, 0700, holding the named files (each 0600). */
function keysWith(state: string, names: string[]): string {
  const dir = join(state, "keys");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  for (const n of names) { writeFileSync(join(dir, n), "sk-temp-secret-bytes"); chmodSync(join(dir, n), 0o600); }
  return dir;
}
const deadTemp = `.${A}.${DEAD_PID}.1.tmp`;

describe("provider key migrate --index n --json: the entry's literal, stored as key set stores it, answered by reference", () => {
  test("darwin, item 1: answers exactly {schemaVersion, ok, keyId, apiKeyCommand} and stores the TRIMMED literal under a fresh id", async () => {
    freshStateDir();
    const file = configFile(LIST);
    const kc = fakeKeychain();
    const r = await migrate(0, file, { keyStore: mac(kc.exec) });
    expect(r.code).toBe(0);
    expect(Object.keys(r.json!).sort()).toEqual(["apiKeyCommand", "keyId", "ok", "revision", "schemaVersion"]);
    expect(r.json).toMatchObject({ schemaVersion: 1, ok: true });
    const keyId = String(r.json!.keyId);
    expect(KEY_ID_RE.test(keyId)).toBe(true);
    expect(r.json!.apiKeyCommand).toEqual(appKeyCommand(keyId, LOGIN));
    expect([...kc.items.entries()]).toEqual([[keyId, KEY1]]);
    // the same store call as key set: the add on stdin, then the read-back of the very reference it answers with
    expect(kc.calls.map((c) => c.cmd[1])).toEqual(["-i", "find-generic-password"]);
    expect(kc.calls[1]!.cmd).toEqual(appKeyCommand(keyId, LOGIN));
    expect(r.err).toEqual([]);
  });

  test("darwin, a fallback: stores THAT entry's literal (index 2 → KEY2), and the Keychain account is the keyId, never the label", async () => {
    freshStateDir();
    const kc = fakeKeychain();
    const r = await migrate(2, configFile(LIST), { keyStore: mac(kc.exec) });
    expect(r.code).toBe(0);
    const keyId = String(r.json!.keyId);
    expect([...kc.items.entries()]).toEqual([[keyId, KEY2]]);
    const add = wordsOfLine(kc.calls[0]!.input!.trim());
    expect([after(add, "-s"), after(add, "-a")]).toEqual([APP_KEY_SERVICE, keyId]);
    expect(allWords(kc.calls).filter((w) => w.includes("LABELSECRET"))).toEqual([]);
  });

  test("linux: answers exactly {schemaVersion, ok, keyId, apiKeyFile}, a file under <state>/keys holding the trimmed literal", async () => {
    const state = freshStateDir();
    const r = await migrate(0, configFile(LIST), { keyStore: linux() });
    expect(r.code).toBe(0);
    expect(Object.keys(r.json!).sort()).toEqual(["apiKeyFile", "keyId", "ok", "revision", "schemaVersion"]);
    const keyId = String(r.json!.keyId);
    expect(r.json!.apiKeyFile).toBe(join(state, "keys", `${keyId}.key`));
    expect(readFileSync(String(r.json!.apiKeyFile), "utf8")).toBe(KEY1);
  });

  test("an entry with a literal BESIDE a reference (apiKeyEnv + apiKey) migrates its literal: the literal is what sits in the file", async () => {
    freshStateDir();
    const kc = fakeKeychain();
    const r = await migrate(7, configFile(LIST), { keyStore: mac(kc.exec) });
    expect(r.code).toBe(0);
    expect([...kc.items.values()]).toEqual([KEY2]);
  });

  test("a new id per migrate: migrating the same entry twice stores two items and overwrites nothing", async () => {
    freshStateDir();
    const file = configFile(LIST);
    const kc = fakeKeychain();
    const a = await migrate(0, file, { keyStore: mac(kc.exec) });
    const b = await migrate(0, file, { keyStore: mac(kc.exec) });
    expect(a.json!.keyId).not.toBe(b.json!.keyId);
    expect(kc.items.size).toBe(2);
  });

  test("the answer carries THAT entry's revision — the row revision status --json gives it (entryRevision) — so the app can confirm which entry it migrated", async () => {
    freshStateDir();
    const file = configFile(LIST);
    const list = resolveProviderList(validateConfig(JSON.parse(readFileSync(file, "utf8")), home), home, {});
    for (const n of [0, 2, 7]) {
      const r = await migrate(n, file, { keyStore: mac(fakeKeychain().exec) });
      expect(r.code).toBe(0);
      expect(`${n} → ${String(r.json!.revision)}`).toBe(`${n} → ${entryRevision(list.entries[n]!)}`);
    }
    // distinct entries, distinct revisions: the field names the entry, it is not a constant
    expect(new Set([0, 2, 7].map((n) => entryRevision(list.entries[n]!))).size).toBe(3);
  });

  // PR 2 final harden round 3, M2: the contract tells the app to compare migrate's `revision` with the one in the entry's
  // `status --json` row, so the row must carry it (the app may not re-implement `entryRevision`). The status report
  // reads the config at `configPath()`, so the fixture is written there, under a temp XDG_CONFIG_HOME.
  test("each resolved status --json row carries its entry's revision, equal to key migrate's answer; a dropped row carries none", async () => {
    freshStateDir();
    const { statusReport } = await import("../src/json");
    const { configPath } = await import("../src/config");
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempDir("dba-migrate-xdg-");
    const write = (cfg: Record<string, unknown>) => {
      const file = configPath();
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify({ repos: [], ...cfg }, null, 2));
      chmodSync(file, 0o600);
      return file;
    };
    try {
      const file = write(LIST);
      const rows = (await statusReport()).providers;
      expect(rows.map((r) => typeof r.revision)).toEqual(Array(8).fill("string"));
      for (const n of [0, 2, 7]) {
        const r = await migrate(n, file, { keyStore: mac(fakeKeychain().exec) });
        expect(r.code).toBe(0);
        expect(`${n} → ${String(r.json!.revision)}`).toBe(`${n} → ${rows[n]!.revision}`);
      }
      expect(new Set(rows.map((r) => r.revision)).size).toBe(8);                // one per entry, not a constant
      // A dropped entry (migrate refuses such a config — fix it first) has no entry, so its row has no revision; the
      // resolved rows beside it keep theirs, unchanged.
      write({ ...LIST, fallbacks: [...LIST.fallbacks, { label: "F-broken" }] });
      const withDrop = (await statusReport()).providers;
      expect(withDrop.map((r) => [r.kind === "invalid", "revision" in r])).toEqual([...Array(8).fill([false, true]), [true, false]]);
      expect(withDrop.slice(0, 8).map((r) => r.revision)).toEqual(rows.map((r) => r.revision));
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });

  test("it takes no run lock: it migrates while a briefing holds the lock, and leaves the holder's run.lock byte- and mtime-identical", async () => {
    freshStateDir();
    const file = configFile(LIST);
    const holder = await acquireRunLock({ invoker: "scheduled", timeoutMs: TIMEOUT_MS, path: runLockPath() });
    if (!holder.acquired) throw new Error("expected the lock");
    try {
      const before = readFileSync(runLockPath(), "base64"), mtime = statSync(runLockPath()).mtimeMs;
      await Bun.sleep(20);                                     // a write inside the same mtime tick would hide otherwise
      const kc = fakeKeychain();
      const r = await migrate(0, file, { keyStore: mac(kc.exec) });
      expect(r.code).toBe(0);
      expect([...kc.items.values()]).toEqual([KEY1]);
      expect(readFileSync(runLockPath(), "base64")).toBe(before);
      expect(statSync(runLockPath()).mtimeMs).toBe(mtime);
    } finally { await holder.release(); }
  });

  test("it runs the dead-pid temp sweep first, as key set does", async () => {
    const state = freshStateDir();
    const dir = keysWith(state, [deadTemp, `${A}.key`]);
    const r = await migrate(0, configFile(LIST), { keyStore: mac(fakeKeychain().exec) });
    expect(r.code).toBe(0);
    expect(readdirSync(dir)).toEqual([`${A}.key`]);
  });
});

describe("the config is READ, never written", () => {
  test("the config file's bytes, mode and mtime, and its folder's contents, are unchanged — on success and on refusal (darwin, linux)", async () => {
    const file = configFile(LIST);
    const before = snapshot(file);
    await Bun.sleep(20);                                       // a write inside the same mtime tick would hide otherwise
    for (const n of [0, 2, 1, 6, 99]) {
      freshStateDir();
      await migrate(n, file, { keyStore: mac(fakeKeychain().exec) });
      await migrate(n, file, { keyStore: linux() });
    }
    expect(snapshot(file)).toBe(before);
  });
});

describe("what is refused: no literal, a dropped entry, a broken accounts list, a bad index — each before any store call or sweep", () => {
  test("an entry without a literal is refused (config, exit 2): a key command, a key file, a key env var, no key at all, a CLI entry", async () => {
    const state = freshStateDir();
    const dir = keysWith(state, [deadTemp]);
    const file = configFile(LIST);
    for (const n of [1, 3, 4, 5, 6]) {
      const kc = fakeKeychain();
      const r = await migrate(n, file, { keyStore: mac(kc.exec) });
      expect(`${n} → ${r.code} ${r.json?.code} / ${kc.calls.length}`).toBe(`${n} → 2 config / 0`);
      expect(String(r.json?.error)).toMatch(n === 6 ? /CLI/ : /no literal/);
      expect(r.text).not.toContain("LABELSECRET");
      expect(r.text).not.toContain("F-");
    }
    expect(readdirSync(dir)).toEqual([deadTemp]);
  });

  test("item 1 as a CLI with two logins: both logins are refused as CLI entries; the fallback after them migrates", async () => {
    freshStateDir();
    const file = configFile({
      provider: { ...CLI, accounts: [{ label: "Login A" }, { label: "Login B", configDir: join(home, ".claude-b") }] },
      fallbacks: [{ label: "F", ...anthropic({ apiKey: KEY2 }) }],
    });
    for (const n of [0, 1]) {
      const kc = fakeKeychain();
      const r = await migrate(n, file, { keyStore: mac(kc.exec) });
      expect(`${n} → ${r.code} ${r.json?.code} / ${kc.calls.length}`).toBe(`${n} → 2 config / 0`);
    }
    const kc = fakeKeychain();
    const ok = await migrate(2, file, { keyStore: mac(kc.exec) });
    expect(ok.code).toBe(0);
    expect([...kc.items.values()]).toEqual([KEY2]);
  });

  test("a list with a dropped entry is refused — even when the target itself holds a literal", async () => {
    freshStateDir();
    const file = configFile({ ...LIST, fallbacks: [...LIST.fallbacks, { label: "Broken" }] });
    const kc = fakeKeychain();
    const r = await migrate(0, file, { keyStore: mac(kc.exec) });
    expect([r.code, r.json?.code, kc.calls.length]).toEqual([2, "config", 0]);
    expect(String(r.json?.error)).toContain("skipped at run time");
    expect(r.text).not.toContain(KEY1);
  });

  test("a structurally broken provider.accounts is refused", async () => {
    freshStateDir();
    const file = configFile({ provider: { ...CLI, accounts: [{ label: "" }, { label: "B" }] }, fallbacks: [{ label: "F", ...anthropic({ apiKey: KEY2 }) }] });
    const kc = fakeKeychain();
    const r = await migrate(1, file, { keyStore: mac(kc.exec) });
    expect([r.code, r.json?.code, kc.calls.length]).toEqual([2, "config", 0]);
    expect(String(r.json?.error)).toContain("provider.accounts");
  });

  test("out of range is a config refusal; a missing, negative or non-numeric --index a usage one", async () => {
    freshStateDir();
    const file = configFile(LIST);
    const kc = fakeKeychain();
    const out = await migrate(8, file, { keyStore: mac(kc.exec) });
    expect([out.code, out.json?.code]).toEqual([2, "config"]);
    for (const v of ["-1", "x", "1.5", "01e1", ""]) {
      const r = await migrate(v, file, { keyStore: mac(kc.exec) });
      expect(`${JSON.stringify(v)} → ${r.code} ${r.json?.code}`).toBe(`${JSON.stringify(v)} → 2 usage`);
    }
    const none = await cli(["key", "migrate", "--json"], file, { keyStore: mac(kc.exec) });
    expect([none.code, none.json?.code]).toEqual([2, "usage"]);
    expect(kc.calls).toEqual([]);
  });

  test("a missing or invalid saved config is a config refusal", async () => {
    freshStateDir();
    const kc = fakeKeychain();
    const missing = await migrate(0, join(tempDir("dba-migrate-none-"), "config.json"), { keyStore: mac(kc.exec) });
    expect([missing.code, missing.json?.code]).toEqual([2, "config"]);
    const invalid = await migrate(0, configFile({ provider: { api: { kind: "anthropic", apiKey: KEY1 } } }), { keyStore: mac(kc.exec) });
    expect([invalid.code, invalid.json?.code]).toEqual([2, "config"]);
    expect(invalid.text).not.toContain(KEY1);
    // No `reason`: only a read that timed out carries one (`timeout`, so the app tells "retry" from "fix your config"),
    // and a literal outside the key rule (`invalid-key`, A2).
    expect(missing.json && "reason" in missing.json).toBe(false);
    expect(invalid.json && "reason" in invalid.json).toBe(false);
    expect(kc.calls).toEqual([]);
  });

  // `config`, not `usage`: the header's code table keeps `usage` for malformed argv or stdin, and the argv here is
  // well formed — the defect is in the SAVED config, which the user (or the app) fixes there.
  test("a literal outside the store's charset is refused (config) before any store call or sweep, and never echoed", async () => {
    const state = freshStateDir();
    const dir = keysWith(state, [deadTemp]);
    for (const bad of ["short", "sk-ant has-a-space-inside-it", 'sk-ant-quote"inside-it', "sk-ant-back\\slash-inside", "x".repeat(513)]) {
      const kc = fakeKeychain();
      const r = await migrate(1, configFile({ provider: CLI, fallbacks: [{ label: "F", ...anthropic({ apiKey: bad }) }] }), { keyStore: mac(kc.exec) });
      expect(`${bad.slice(0, 12)} → ${r.code} ${r.json?.code} / ${kc.calls.length}`).toBe(`${bad.slice(0, 12)} → 2 config / 0`);
      expect(r.text).not.toContain(bad.slice(0, 40));
      expect(String(r.json?.error)).toContain("literal");
      expect(r.json?.reason).toBe("invalid-key");          // the key rule's reason, as key set's (A2)
    }
    expect(readdirSync(dir)).toEqual([deadTemp]);
  });
});

// The checkpoint MED: a key the app stores is refused over plain http to a non-loopback host — at run time
// (`insecureEndpoint`, src/core.ts) and by P2-M5-T2's `config validate` rule — so migrating such an entry would store a
// key the app could then never save (an orphan) or save an entry that fails every tick. One predicate decides all
// three (`cleartextRemote`, src/providers/endpoint.ts).
describe("an entry whose endpoint is plain http on a non-loopback host is refused before any store call or sweep", () => {
  const HTTP_LABEL = "Http-label-sk-LABELSECRET-three";
  const plain = [
    { what: "openai-compatible on a LAN address", api: { kind: "openai-compatible", model: "m", baseUrl: "http://192.168.1.5/v1" } },
    { what: "openai-compatible on a remote name", api: { kind: "openai-compatible", model: "m", baseUrl: "http://example.invalid/v1" } },
    { what: "anthropic with an http baseUrl", api: { kind: "anthropic", model: "m", baseUrl: "http://anthropic-gw.example.invalid" } },
  ];

  test("refused (config, exit 2) with fixed text: zero store calls, a dead temp left unswept, no host and no label in the output", async () => {
    for (const p of plain) {
      const state = freshStateDir();
      const dir = keysWith(state, [deadTemp]);
      const file = configFile({ provider: CLI, fallbacks: [{ label: HTTP_LABEL, api: { ...p.api, apiKey: KEY2 } }] });
      const kc = fakeKeychain();
      const r = await migrate(1, file, { keyStore: mac(kc.exec) });
      expect(`${p.what} → ${r.code} ${r.json?.code} / ${kc.calls.length}`).toBe(`${p.what} → 2 config / 0`);
      expect(String(r.json?.error)).toContain("plain http on a non-loopback host");
      expect(String(r.json?.error)).toContain("https");
      for (const leak of ["192.168", "example.invalid", "anthropic-gw", "LABELSECRET", KEY2]) expect(r.text).not.toContain(leak);
      expect(readdirSync(dir)).toEqual([deadTemp]);
      // the file store too: nothing written under keys/
      const lx = await migrate(1, file, { keyStore: linux() });
      expect([lx.code, lx.json?.code]).toEqual([2, "config"]);
      expect(readdirSync(dir)).toEqual([deadTemp]);
      expect(holding(state, KEY2)).toEqual([]);
    }
  });

  test("loopback http (127.0.0.1, localhost) and https still migrate", async () => {
    for (const baseUrl of ["http://127.0.0.1:9/v1", "http://localhost:9/v1", "https://example.invalid/v1"]) {
      freshStateDir();
      const kc = fakeKeychain();
      const r = await migrate(1, configFile({ provider: CLI, fallbacks: [{ label: "F", api: { kind: "openai-compatible", model: "m", baseUrl, apiKey: KEY2 } }] }), { keyStore: mac(kc.exec) });
      expect(`${baseUrl} → ${r.code}`).toBe(`${baseUrl} → 0`);
      expect([...kc.items.values()]).toEqual([KEY2]);
    }
  });
});

describe("neither the literal nor the label reaches argv, output or a state file", () => {
  test("darwin: success, a mismatch whose cleanup fails, and a stalled add", async () => {
    const state = freshStateDir();
    const file = configFile(LIST);
    const kc = fakeKeychain();
    const ok = await migrate(0, file, { keyStore: mac(kc.exec) });
    expect(ok.code).toBe(0);
    expect(kc.calls.flatMap((c) => c.cmd).filter((w) => w.includes(KEY1))).toEqual([]);
    expect(allWords(kc.calls).filter((w) => w === KEY1).length).toBe(1);      // on the add's STDIN only
    for (const kc2 of [fakeKeychain({ corrupt: true, deleteCode: 1 }), fakeKeychain({ stall: "add" })]) {
      // Budgets above the store's call floor (`KEY_CALL_MIN_MS`, r2 L2), so each failure path is really reached.
      const r = await migrate(2, file, { keyStore: mac(kc2.exec, { deadlineMs: 150, cleanupMs: 100 }) });
      expect(r.code).toBe(1);
      expect(r.json).toMatchObject({ ok: false, code: "write-failed" });
      expect(r.text).not.toContain(KEY2);
      expect(r.text).not.toContain("corrupted-value-123");
      expect(kc2.calls.flatMap((c) => c.cmd).filter((w) => w.includes(KEY2))).toEqual([]);
      for (const t of [ok.text, r.text]) expect(t).not.toContain("LABELSECRET");
    }
    expect(ok.text).not.toContain(KEY1);
    expect(holding(state, KEY1)).toEqual([]);
    expect(holding(state, KEY2)).toEqual([]);
  });

  test("darwin: a failure carries the store's reason, cleanup and — when the cleanup is unconfirmed — the keyId, as key set's does", async () => {
    freshStateDir();
    const kc = fakeKeychain({ corrupt: true, deleteCode: 1 });
    const r = await migrate(0, configFile(LIST), { keyStore: mac(kc.exec) });
    expect(r.json).toMatchObject({ ok: false, code: "write-failed", reason: "readback-mismatch", cleanup: "failed" });
    expect(r.json!.keyId).toBe(after(wordsOfLine(kc.calls[0]!.input!.trim()), "-a")!);
    expect(String(r.json!.error)).toMatch(/^key migrate: /);
    expect(String(r.json!.error)).toContain("could not be confirmed removed");
  });

  test("linux: the literal is in no state file but its own key file, and in no output; a stalled folder says retry, never the Keychain", async () => {
    const state = freshStateDir();
    const file = configFile(LIST);
    const r = await migrate(2, file, { keyStore: linux() });
    expect(r.code).toBe(0);
    expect(r.text).not.toContain(KEY2);
    expect(r.text).not.toContain("LABELSECRET");
    expect(holding(state, KEY2)).toEqual([join("keys", `${String(r.json!.keyId)}.key`)]);
    freshStateDir();
    const stalled = await migrate(0, file, { keyStore: linux({ link: () => new Promise<void>(() => {}), deadlineMs: 50, cleanupMs: 100 }) });
    expect(stalled.json).toMatchObject({ ok: false, code: "write-failed", reason: "timeout" });
    expect(String(stalled.json!.error)).toContain("the key folder did not answer in time — retry");
    expect(stalled.text).not.toContain(KEY1);
  });
});

describe("the pre-store budget: the config read and the sweep share KEY_PRE_STORE_MS", () => {
  test("a config read that never finishes is cut at the budget: refused (config), nothing stored", async () => {
    freshStateDir();
    const kc = fakeKeychain();
    const t0 = performance.now();
    const r = await migrate(0, configFile(LIST), { preStoreMs: 150, readConfig: () => new Promise<string | undefined>(() => {}), keyStore: mac(kc.exec) });
    expect(performance.now() - t0).toBeLessThan(3000);
    expect([r.code, r.json?.code]).toEqual([2, "config"]);
    // `reason: "timeout"`, as `key scrub-backup`'s timed-out read: the app's cue to retry rather than send the user to
    // fix the config (P2-M5 checkpoint MED 2).
    expect(r.json?.reason).toBe("timeout");
    expect(String(r.json?.error)).toContain("in time");
    expect(kc.calls).toEqual([]);
  });

  test("a sweep that does not finish in what the config read left of the budget does not hold the store call", async () => {
    const state = freshStateDir();
    keysWith(state, [deadTemp]);
    const kc = fakeKeychain();
    const t0 = performance.now();
    const r = await migrate(0, configFile(LIST), { preStoreMs: 150, keyStore: mac(kc.exec, { isAlive: () => new Promise<boolean>(() => {}) }) });
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.code).toBe(0);
    expect(kc.calls.length).toBe(2);
  });

  // ⚠ The bounded part only: list resolution's synchronous `existsSync` per login `configDir` (src/config.ts
  // `resolveAccounts`) is outside `within`, so a hung mount there is a residual this sum does not cover.
  test("the bounds: the pre-store work, the store's deadline and its cleanup — key set's bounded worst case, so the app gives migrate key set's timeout", () => {
    expect(KEY_PRE_STORE_MS + KEY_OP_DEADLINE_MS + KEY_CLEANUP_MS).toBeLessThanOrEqual(14_000);
  });
});

describe("production: no exec is injected, so the store's own BACKSTOPPED exec is the one used", () => {
  test("key migrate on darwin is refused by the backstop before any spawn", async () => {
    freshStateDir();
    const r = await migrate(0, configFile(LIST), { keyStore: { platform: "darwin" } });
    expect([r.code, r.json?.code, r.json?.reason]).toEqual([1, "write-failed", "refused"]);
    expect(r.text).not.toContain(KEY1);
  });
});
