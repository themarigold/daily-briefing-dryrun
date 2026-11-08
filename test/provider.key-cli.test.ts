// test/provider.key-cli.test.ts — `provider key set`, `key delete` and `key delete-all` (provider-fallback plan
// P2-M2-T3; spec r9 §4 secrets, §6 "Engine operations"), driven through the real `providerMain`.
//
// The store itself is pinned by test/keyStore.mac.test.ts (the Keychain, fake-only) and test/keyStore.linux.test.ts
// (the file store); this file pins what the COMMAND adds: the key read on stdin (never argv; a TTY refused; the read
// bounded in bytes and in time), the dead-pid temp sweep before `set` and `delete-all`, the id check before `delete`,
// the answer's shape, the per-platform timeout wording, `set` waiting out the attempt the file store abandoned, and
// that the secret reaches no argv, no output and no state file.
//
// ⚠ FAKE-ONLY (hub Q27): the darwin cases go through an in-memory Keychain behind the `keyStore.exec` TEST seam. The
// one case with NO exec injected proves the production default is the store's own BACKSTOPPED exec: it is refused
// before anything is spawned — and the preload spawn guard would fail this file if anything were. No literal here names the
// Keychain tool — argv comes from SECURITY_BIN — so this file needs no REACH_CONDITIONAL entry.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { link as fsLink } from "node:fs/promises";
import { join } from "node:path";
import { providerMain, readStdinBounded, KEY_PRE_STORE_MS, KEY_STDIN_MAX_BYTES, type ProviderCliDeps } from "../src/providerCli";
import { APP_KEY_SERVICE, SECURITY_BIN } from "../src/appKeyNames";
import { appKeyCommand, KEY_CLEANUP_MS, KEY_ID_RE, KEY_NOT_FOUND_EXIT, KEY_OP_DEADLINE_MS, loginKeychainPath, type AppKeyDeps, type KeyExec } from "../src/keyStore";
import type { RunResult } from "../src/proc";
import { freshStateDir, tempDir } from "./helpers/walk";

const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
afterAll(() => { process.env.DAILY_BRIEFING_STATE_DIR = prevState; });

const KEY = "sk-ant-api03_AbC.def~ghi+jkl/mno=pqr-STU";
const HOME = "/Users/fake person";
const LOGIN = loginKeychainPath(HOME);
/** A pid above every platform's pid_max (macOS 99 999, Linux at most 2^22): `kill(pid, 0)` answers ESRCH. */
const DEAD_PID = 2147483646;

// ── a compact in-memory Keychain behind a recording exec (the full fake is test/keyStore.mac.test.ts's) ──

type Call = { cmd: string[]; input?: string };
const result = (code: number, out = ""): RunResult => ({ out, err: "", code, complete: true, spawned: true, signal: null, timedOut: false });
const wordsOfLine = (line: string): string[] =>
  (line.match(/"[^"]*"|\S+/g) ?? []).map((w) => (w.startsWith('"') && w.endsWith('"') ? w.slice(1, -1) : w));
/** The value after `flag` in `words`. */
const after = (words: string[], flag: string): string | undefined => { const i = words.indexOf(flag); return i >= 0 ? words[i + 1] : undefined; };

function fakeKeychain(o: { corrupt?: boolean; stall?: "add"; deleteCode?: number } = {}) {
  const items = new Map<string, string>();               // account → value
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
      const hit = acct ?? [...items.keys()][0];
      if (hit === undefined || !items.has(hit)) return result(KEY_NOT_FOUND_EXIT);
      items.delete(hit);
      return result(0);
    }
    return result(1);
  };
  return { exec, calls, items };
}
/** Every word of every call: argv elements, and the words of any stdin line. */
const argvWords = (calls: Call[]): string[] => calls.flatMap((c) => c.cmd);
const stdinWords = (calls: Call[]): string[] => calls.flatMap((c) => (c.input !== undefined ? wordsOfLine(c.input) : []));

// ── the command ─────────────────────────────────────────────────────────────────────────────────────

/** Run `provider <args>` with captured output, a non-TTY stdin and the given store seams. */
async function cli(args: string[], deps: ProviderCliDeps = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await providerMain(args, { out: (s) => out.push(s), err: (s) => err.push(s), isTTY: false, ...deps });
  const last = out.at(-1);
  return { code, out, err, text: [...out, ...err].join("\n"), json: last !== undefined ? JSON.parse(last) as Record<string, unknown> : undefined };
}
const stdin = (s: string) => async () => s;
const mac = (exec: KeyExec, extra: AppKeyDeps = {}): AppKeyDeps => ({ platform: "darwin", exec, home: HOME, env: {}, ...extra });
const linux = (extra: AppKeyDeps = {}): AppKeyDeps => ({ platform: "linux", ...extra });

/** Every regular file under `dir`, relative to it. */
function filesUnder(dir: string, rel = ""): string[] {
  if (!existsSync(join(dir, rel))) return [];
  return readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel === "" ? n : join(rel, n);
    const st = lstatSync(join(dir, r));
    return st.isDirectory() ? filesUnder(dir, r) : st.isFile() ? [r] : [];
  });
}
/** The state files (relative paths) whose bytes hold `secret`. */
const holding = (state: string, secret: string): string[] =>
  filesUnder(state).filter((f) => readFileSync(join(state, f), "utf8").includes(secret)).sort();

/** `<state>/keys`, created 0700, holding the named files (each 0600). */
function keysWith(state: string, names: string[]): string {
  const dir = join(state, "keys");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  for (const n of names) { writeFileSync(join(dir, n), "sk-temp-secret-bytes"); chmodSync(join(dir, n), 0o600); }
  return dir;
}
const tmpName = (id: string, pid: number, seq = 1): string => `.${id}.${pid}.${seq}.tmp`;
const A = "k-aaaaaaaaaaaa", B = "k-bbbbbbbbbbbb";

/** The deadline for a test whose premise is "link(2) is in flight when the deadline fires". The store must reach link
 *  first — a temp write and its fsync — which took over 100 ms on a loaded CI runner (2026-10-30), so a 100 ms deadline
 *  fired before link was ever called. A link that is held, or sleeps this long from when it is entered, is in flight
 *  when this deadline fires however long the store took to reach it. */
const IN_FLIGHT_DEADLINE_MS = 1000;
/** How long a sleeping link takes from when it is entered: a margin past the deadline, since timers are not exact (a link
 *  sleeping exactly the deadline once landed before the deadline's timer ran), and well inside a 3 s cleanup budget. */
const LINK_PAST_DEADLINE_MS = IN_FLIGHT_DEADLINE_MS + 500;

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
}

describe("provider key set --json: the key on stdin, stored, read back, answered by reference", () => {
  test("darwin: answers exactly {schemaVersion, ok, keyId, apiKeyCommand}, the reference the store built, and stores the TRIMMED key", async () => {
    freshStateDir();
    const kc = fakeKeychain();
    const r = await cli(["key", "set", "--json"], { readStdin: stdin(`  ${KEY}\n`), keyStore: mac(kc.exec) });
    expect(r.code).toBe(0);
    expect(Object.keys(r.json!).sort()).toEqual(["apiKeyCommand", "keyId", "ok", "schemaVersion"]);
    expect(r.json).toMatchObject({ schemaVersion: 1, ok: true });
    const keyId = String(r.json!.keyId);
    expect(KEY_ID_RE.test(keyId)).toBe(true);
    expect(r.json!.apiKeyCommand).toEqual(appKeyCommand(keyId, LOGIN));
    expect([...kc.items.entries()]).toEqual([[keyId, KEY]]);
    expect(r.err).toEqual([]);
  });

  test("linux: answers exactly {schemaVersion, ok, keyId, apiKeyFile}, a file under <state>/keys holding the trimmed key", async () => {
    const state = freshStateDir();
    const r = await cli(["key", "set", "--json"], { readStdin: stdin(`${KEY}\r\n`), keyStore: linux() });
    expect(r.code).toBe(0);
    expect(Object.keys(r.json!).sort()).toEqual(["apiKeyFile", "keyId", "ok", "schemaVersion"]);
    const keyId = String(r.json!.keyId);
    expect(r.json!.apiKeyFile).toBe(join(state, "keys", `${keyId}.key`));
    expect(readFileSync(String(r.json!.apiKeyFile), "utf8")).toBe(KEY);
  });

  test("argv and the Keychain account (-a) carry the keyId — never a label of the saved config", async () => {
    freshStateDir();
    const dir = tempDir("dba-keycli-cfg-");
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ repos: [], provider: { cli: "/nonexistent/claude", argv: [], promptVia: "stdin", accounts: [{ label: "Work-login-label" }] } }));
    const kc = fakeKeychain();
    const r = await cli(["key", "set", "--json"], { configFile, readStdin: stdin(KEY), keyStore: mac(kc.exec) });
    const keyId = String(r.json!.keyId);
    expect(kc.calls.map((c) => c.cmd[1])).toEqual(["-i", "find-generic-password"]);
    const add = wordsOfLine(kc.calls[0]!.input!.trim());
    expect([after(add, "-s"), after(add, "-a")]).toEqual([APP_KEY_SERVICE, keyId]);
    expect(after(kc.calls[1]!.cmd, "-a")).toBe(keyId);
    expect([...argvWords(kc.calls), ...stdinWords(kc.calls)].filter((w) => w.includes("Work-login-label"))).toEqual([]);
  });

  test("the secret never appears in the spawned argv, stdout, stderr, the JSON or any state file (darwin)", async () => {
    const state = freshStateDir();
    const kc = fakeKeychain();
    const ok = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: mac(kc.exec) });
    expect(ok.code).toBe(0);
    expect(argvWords(kc.calls).filter((w) => w.includes(KEY))).toEqual([]);
    expect(stdinWords(kc.calls).filter((w) => w === KEY).length).toBe(1);      // it travels on the add's STDIN only
    expect(ok.text).not.toContain(KEY);
    expect(holding(state, KEY)).toEqual([]);
    // …and on the failure paths: a mismatch whose cleanup fails, and a stalled add.
    for (const kc2 of [fakeKeychain({ corrupt: true, deleteCode: 1 }), fakeKeychain({ stall: "add" })]) {
      // Budgets above the store's call floor (`KEY_CALL_MIN_MS`, r2 L2), so each failure path is really reached.
      const r = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: mac(kc2.exec, { deadlineMs: 150, cleanupMs: 100 }) });
      expect(r.code).toBe(1);
      expect(r.text).not.toContain(KEY);
      expect(r.text).not.toContain("corrupted-value-123");
      expect(argvWords(kc2.calls).filter((w) => w.includes(KEY))).toEqual([]);
    }
    expect(holding(state, KEY)).toEqual([]);
  });

  test("the secret never appears in stdout, stderr, the JSON or any state file but its own key file (linux)", async () => {
    const state = freshStateDir();
    const r = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: linux() });
    expect(r.code).toBe(0);
    expect(r.text).not.toContain(KEY);
    expect(holding(state, KEY)).toEqual([join("keys", `${String(r.json!.keyId)}.key`)]);
  });

  test("a key in ARGV is refused as an unexpected argument, and never echoed; nothing is stored", async () => {
    freshStateDir();
    const kc = fakeKeychain();
    const r = await cli(["key", "set", KEY, "--json"], { readStdin: stdin(KEY), keyStore: mac(kc.exec) });
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, code: "usage" });
    expect(r.text).not.toContain(KEY);
    expect(kc.calls).toEqual([]);
  });

  test("a key-shaped DASH token in argv is never echoed: only a plain flag-shaped name is (A4)", async () => {
    freshStateDir();
    for (const [tok, shown] of [[`-${KEY}`, "(an argument)"], [`--${KEY}`, "(an argument)"], ["-K", "(an argument)"], ["--Index", "(an argument)"],
      ["--sk-ant", "--sk-ant"], [`--frob=${KEY}`, "--frob"], ["-x", "-x"], [KEY, "(an argument)"]] as const) {
      const kc = fakeKeychain();
      const r = await cli(["key", "set", "--json", tok], { readStdin: stdin(KEY), keyStore: mac(kc.exec) });
      expect(`${tok.slice(0, 12)} → ${r.code} ${String(r.json?.error)}`).toBe(`${tok.slice(0, 12)} → 2 key set: unexpected argument ${shown}`);
      expect(r.text).not.toContain(KEY);
      expect(kc.calls).toEqual([]);
    }
  });

  test("a TTY stdin is refused before anything is touched: no store call, no sweep", async () => {
    const state = freshStateDir();
    const dir = keysWith(state, [tmpName(A, DEAD_PID)]);
    const kc = fakeKeychain();
    let reads = 0;
    const r = await cli(["key", "set", "--json"], { isTTY: true, readStdin: async () => { reads++; return KEY; }, keyStore: mac(kc.exec) });
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, code: "usage" });
    expect(String(r.json!.error)).toContain("terminal");
    expect([reads, kc.calls.length]).toEqual([0, 0]);
    expect(readdirSync(dir)).toEqual([tmpName(A, DEAD_PID)]);
  });

  test("a key outside the charset, an empty stdin and an oversized one are refused (usage) before any store call or sweep, never echoed", async () => {
    const state = freshStateDir();
    const dir = keysWith(state, [tmpName(A, DEAD_PID)]);
    for (const bad of ["", "   \n", "short", `${KEY} with-space`, `${KEY}"quote`, "x".repeat(KEY_STDIN_MAX_BYTES + 1)]) {
      const kc = fakeKeychain();
      const r = await cli(["key", "set", "--json"], { readStdin: stdin(bad), keyStore: mac(kc.exec) });
      expect(`${bad.length} → ${r.code} ${r.json?.code} / ${kc.calls.length}`).toBe(`${bad.length} → 2 usage / 0`);
      // The key rule's refusal carries `reason: "invalid-key"`, as the store's own would (A2); the byte cap's does not.
      expect(`${bad.length} → ${r.json?.reason}`).toBe(`${bad.length} → ${bad.length > KEY_STDIN_MAX_BYTES ? "undefined" : "invalid-key"}`);
      if (bad.trim().length >= 5) expect(r.text).not.toContain(bad.trim().slice(0, 40));
      // the byte cap answers first for an oversized stdin (the charset would refuse it too, later)
      if (bad.length > KEY_STDIN_MAX_BYTES) expect(String(r.json?.error)).toContain("too large");
    }
    expect(readdirSync(dir)).toEqual([tmpName(A, DEAD_PID)]);
  });

  test("a stdin that never closes is cut at the pre-store budget: refused, nothing stored", async () => {
    freshStateDir();
    const kc = fakeKeychain();
    const t0 = performance.now();
    const r = await cli(["key", "set", "--json"], { readStdin: () => new Promise<string>(() => {}), preStoreMs: 150, keyStore: mac(kc.exec) });
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, code: "usage" });
    expect(kc.calls).toEqual([]);
  });

  test("a sweep that does not finish in the pre-store budget does not hold the store call", async () => {
    const state = freshStateDir();
    keysWith(state, [tmpName(A, DEAD_PID)]);
    const kc = fakeKeychain();
    const t0 = performance.now();
    const r = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), preStoreMs: 150, keyStore: mac(kc.exec, { isAlive: () => new Promise<boolean>(() => {}) }) });
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.code).toBe(0);
    expect(kc.calls.length).toBe(2);
  });

  // Spec r9 §6: the app's `key set` timeout is 19 s, the engine's worst case (1 + 10 + 3 = 14 s) + its 5 s margin.
  test("the bounds: the pre-store work, the store's deadline and its cleanup fit inside the app's 19 s key-set timeout less its 5 s margin", () => {
    expect(KEY_PRE_STORE_MS + KEY_OP_DEADLINE_MS + KEY_CLEANUP_MS).toBeLessThanOrEqual(14_000);
    expect(KEY_PRE_STORE_MS).toBeLessThanOrEqual(1_000);
  });
});

describe("the bounded stdin read", () => {
  test("reads a small stdin whole, and stops pulling once past the cap", async () => {
    const enc = new TextEncoder();
    const small = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode("ab")); c.enqueue(enc.encode("cd\n")); c.close(); } });
    expect(await readStdinBounded(16, small)).toBe("abcd\n");
    let pulls = 0;
    // "Endless" but finite (closes after 1000 pulls), so a reader that drains it all fails the count below, never hangs.
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulls++; if (pulls > 1000) c.close(); else c.enqueue(enc.encode("x".repeat(100))); } });
    const got = await readStdinBounded(250, endless);
    expect(got.length).toBeGreaterThan(250);
    expect(pulls).toBeLessThan(10);
  });
});

describe("the timeout wording, per platform", () => {
  test("darwin: a stalled Keychain says \"unlock your keychain, then retry\" (write-failed, reason timeout, exit 1)", async () => {
    freshStateDir();
    const kc = fakeKeychain({ stall: "add" });
    const r = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: mac(kc.exec, { deadlineMs: 150, cleanupMs: 100 }) });
    expect(kc.calls.length).toBeGreaterThan(0);              // above the call floor: the stalled add was really started
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, code: "write-failed", reason: "timeout" });
    expect(String(r.json!.error)).toContain("unlock your keychain, then retry");
  });

  test("linux: a stalled key folder says \"the key folder did not answer in time — retry\", never the Keychain", async () => {
    freshStateDir();
    const g = gate();
    const r = await cli(["key", "set", "--json"], {
      readStdin: stdin(KEY), keyStore: linux({ link: async () => { await g.wait; }, deadlineMs: 50, cleanupMs: 100 }),
    });
    g.open();
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, code: "write-failed", reason: "timeout" });
    expect(String(r.json!.error)).toContain("the key folder did not answer in time — retry");
    expect(r.text.toLowerCase()).not.toContain("keychain");
  });

  test("a cleanup that could not be confirmed is said so (darwin: a mismatch whose delete fails)", async () => {
    freshStateDir();
    const kc = fakeKeychain({ corrupt: true, deleteCode: 1 });
    const r = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: mac(kc.exec) });
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, code: "write-failed", reason: "readback-mismatch", cleanup: "failed" });
    expect(String(r.json!.error)).toContain("could not be confirmed removed");
  });

  // P2-M2 milestone checkpoint LOW 5 (plan hub "Into P3" (3)): an unconfirmed cleanup carries the keyId — not a secret —
  // so the app's pending-reset store can retry `key delete --id`; a confirmed one has nothing left to name.
  test("an UNCONFIRMED cleanup carries the keyId of what may remain (darwin failed, linux timeout); a confirmed one does not", async () => {
    freshStateDir();
    const unsureMac = fakeKeychain({ corrupt: true, deleteCode: 1 });
    const a = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: mac(unsureMac.exec) });
    expect(a.json).toMatchObject({ ok: false, reason: "readback-mismatch", cleanup: "failed" });
    const added = wordsOfLine(unsureMac.calls[0]!.input!.trim());
    expect(a.json!.keyId).toBe(after(added, "-a")!);    // the very id the add stored under
    expect(KEY_ID_RE.test(String(a.json!.keyId))).toBe(true);

    const sureMac = fakeKeychain({ corrupt: true });
    const b = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: mac(sureMac.exec) });
    expect(b.json).toMatchObject({ ok: false, reason: "readback-mismatch", cleanup: "deleted" });
    expect("keyId" in b.json!).toBe(false);

    freshStateDir();
    const c = await cli(["key", "set", "--json"], {
      readStdin: stdin(KEY), keyStore: linux({ newId: () => A, link: () => new Promise<void>(() => {}), deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 300 }),
    });
    expect(c.json).toMatchObject({ ok: false, reason: "timeout", cleanup: "timeout", keyId: A });

    freshStateDir();
    const d = await cli(["key", "set", "--json"], {
      // The link sleeps past a full deadline from when it is entered: in flight at the deadline, ended inside the budget.
      readStdin: stdin(KEY), keyStore: linux({ newId: () => B, link: async () => { await Bun.sleep(LINK_PAST_DEADLINE_MS); }, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 3000 }),
    });
    // A TIMEOUT always carries the keyId, whatever its cleanup answered (A1): a timed-out store call's `not-found` is
    // not proof that nothing landed (a Keychain add killed mid-write), so the rule is one for both platforms.
    expect(d.json).toMatchObject({ ok: false, reason: "timeout", cleanup: "not-found", keyId: B });
    expect(String(d.json!.error)).toContain("could not be confirmed removed");
    expect(a.text + b.text + c.text + d.text).not.toContain(KEY);
  }, 15_000);                                                // two Linux timeouts of IN_FLIGHT_DEADLINE_MS plus their budgets

  test("darwin: a timed-out add whose cleanup answers not-found still carries the keyId (the add may yet land — A1)", async () => {
    freshStateDir();
    const kc = fakeKeychain({ stall: "add" });               // the add never answers; the cleanup delete finds nothing
    // Above the store's call floor (`KEY_CALL_MIN_MS`, r2 L2), so the add is really started and really times out.
    const r = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: mac(kc.exec, { deadlineMs: 150, cleanupMs: 100 }) });
    const added = wordsOfLine(kc.calls[0]!.input!.trim());
    expect(r.json).toMatchObject({ ok: false, code: "write-failed", reason: "timeout", cleanup: "not-found", keyId: after(added, "-a")! });
    expect(String(r.json!.error)).toContain("could not be confirmed removed");
    expect(r.text).not.toContain(KEY);
  });
});

describe("key set waits out the attempt the file store abandoned (P2-M2-T2 checkpoint, carried item 1)", () => {
  test("a link still in flight at the deadline has SETTLED by the time key set returns", async () => {
    const state = freshStateDir();
    let entered = false;
    let settled = false;
    const link = async (from: string, to: string) => {
      entered = true;
      await Bun.sleep(LINK_PAST_DEADLINE_MS);                 // past the deadline from when it is entered, inside the 3 s budget
      try { await fsLink(from, to); } finally { settled = true; }
    };
    const r = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: linux({ link, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 3000 }) });
    expect([entered, settled]).toEqual([true, true]);
    expect(r.json).toMatchObject({ ok: false, code: "write-failed", reason: "timeout", cleanup: "not-found" });
    expect(filesUnder(join(state, "keys"))).toEqual([]);
  });

  test("…but only for what is left of the shared cleanup budget: an attempt that never ends cannot hold key set", async () => {
    freshStateDir();
    const t0 = performance.now();
    const r = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: linux({ link: () => new Promise<void>(() => {}), deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 300 }) });
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(IN_FLIGHT_DEADLINE_MS + 250); // it did wait (deadline + most of the budget)…
    expect(took).toBeLessThan(IN_FLIGHT_DEADLINE_MS + 2400);          // …and was bounded
    expect(r.json).toMatchObject({ ok: false, reason: "timeout", cleanup: "timeout" });
    expect(String(r.json!.error)).toContain("could not be confirmed removed");
  });
});

describe("the dead-pid temp sweep, before key set and key delete-all", () => {
  const LIVE = [tmpName(B, process.pid), tmpName(B, 1, 2)];   // this process, and pid 1 (alive; kill answers EPERM)
  const NEVER = [`${A}.key`, ".k-aaaaaaaaaaaa.0.1.tmp", ".notakey.2147483646.1.tmp", `${tmpName(A, DEAD_PID)}.bak`, "k-aaaaaaaaaaaa.2147483646.1.tmp"];

  test("key set (linux): a dead pid's temp file is swept; a live pid's temp, a published key and look-alikes are kept", async () => {
    const state = freshStateDir();
    const dir = keysWith(state, [tmpName(A, DEAD_PID), tmpName(A, DEAD_PID, 7), ...LIVE, ...NEVER]);
    const r = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: linux() });
    expect(r.code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([...LIVE, ...NEVER, `${String(r.json!.keyId)}.key`].sort());
  });

  test("key set (darwin): the sweep runs too — the file store's leftovers hold a secret whatever the platform", async () => {
    const state = freshStateDir();
    const dir = keysWith(state, [tmpName(A, DEAD_PID), ...LIVE]);
    const r = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: mac(fakeKeychain().exec) });
    expect(r.code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([...LIVE].sort());
  });

  test("the liveness seam decides: only a pid it calls dead is swept", async () => {
    const state = freshStateDir();
    const dir = keysWith(state, [tmpName(A, 4242), tmpName(B, 4343)]);
    const asked: number[] = [];
    const r = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: linux({ isAlive: (pid) => { asked.push(pid); return pid === 4343; } }) });
    expect(r.code).toBe(0);
    expect(asked.sort()).toEqual([4242, 4343]);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([tmpName(B, 4343)]);
  });

  // C1: delete-all is the uninstall leg — every app-shaped file goes, a LIVE pid's temp included (it holds the key too),
  // and then keys/ itself; a file that is not the app's stays, with the folder, and is counted in `kept`.
  test("key delete-all (linux): the keys and EVERY app temp (live pids too) are removed, then keys/ itself", async () => {
    const state = freshStateDir();
    const dir = keysWith(state, [`${A}.key`, `${B}.key`, tmpName(A, DEAD_PID), ...LIVE]);
    const r = await cli(["key", "delete-all", "--json"], { keyStore: linux() });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ schemaVersion: 1, ok: true, deleted: 2 });
    expect(existsSync(dir)).toBe(false);
  });

  test("key delete-all (linux): a file that is not the app's stays, with keys/, and is counted in kept", async () => {
    const state = freshStateDir();
    const dir = keysWith(state, [`${A}.key`, ...LIVE, ...NEVER]);
    const r = await cli(["key", "delete-all", "--json"], { keyStore: linux() });
    expect(r.code).toBe(0);
    const strangers = NEVER.filter((n) => n !== `${A}.key`);
    expect(r.json).toEqual({ schemaVersion: 1, ok: true, deleted: 1, kept: strangers.length });
    expect(readdirSync(dir).sort()).toEqual([...strangers].sort());
  });

  test("a keys/ that is a symlink is never swept through", async () => {
    const state = freshStateDir();
    const elsewhere = tempDir("dba-keycli-elsewhere-");
    writeFileSync(join(elsewhere, tmpName(A, DEAD_PID)), "x");
    symlinkSync(elsewhere, join(state, "keys"));
    const r = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: mac(fakeKeychain().exec) });
    expect(r.code).toBe(0);
    expect(readdirSync(elsewhere)).toEqual([tmpName(A, DEAD_PID)]);
  });
});

describe("provider key delete --id and key delete-all", () => {
  test("delete refuses an invalid id (usage, exit 2) before any store call, and never echoes it", async () => {
    freshStateDir();
    for (const bad of ["k-0123456789AB", "k-0123456789a", "k-0123456789abc", "0123456789ab", "sk-ant-api03-not-an-id", "k-0123456789ab "]) {
      const kc = fakeKeychain();
      const r = await cli(["key", "delete", "--id", bad, "--json"], { keyStore: mac(kc.exec) });
      expect(`${JSON.stringify(bad)} → ${r.code} ${r.json?.code} / ${kc.calls.length}`).toBe(`${JSON.stringify(bad)} → 2 usage / 0`);
      expect(r.text).not.toContain(bad.trim());
      expect(String(r.json?.error)).toContain("--id must be");     // refused here, not left to the store's own check
      expect(r.json?.reason).toBe("invalid-id");                   // …with the store's reason all the same (A2)
    }
    const missing = await cli(["key", "delete", "--json"], { keyStore: mac(fakeKeychain().exec) });
    expect([missing.code, missing.json?.code]).toEqual([2, "usage"]);
  });

  test("delete removes that one key (darwin, linux); a missing one answers deleted:false", async () => {
    freshStateDir();
    const kc = fakeKeychain();
    kc.items.set(A, "value-a-123456"); kc.items.set(B, "value-b-123456");
    const r = await cli(["key", "delete", "--id", A, "--json"], { keyStore: mac(kc.exec) });
    expect(r.json).toEqual({ schemaVersion: 1, ok: true, deleted: true });
    expect([...kc.items.keys()]).toEqual([B]);
    expect(after(kc.calls[0]!.cmd, "-a")).toBe(A);
    expect((await cli(["key", "delete", "--id", A, "--json"], { keyStore: mac(kc.exec) })).json).toEqual({ schemaVersion: 1, ok: true, deleted: false });

    const state = freshStateDir();
    const dir = keysWith(state, [`${A}.key`, `${B}.key`]);
    expect((await cli(["key", "delete", "--id", A, "--json"], { keyStore: linux() })).json).toEqual({ schemaVersion: 1, ok: true, deleted: true });
    expect(readdirSync(dir)).toEqual([`${B}.key`]);
  });

  // PR 2 final r2 L1: the documented retry reaches a stuck temp — a dead writer's `.<id>.<pid>.<seq>.tmp` holds the key.
  test("linux: delete --id also removes that id's dead-writer temp (deleted:true with no key file); a live one's stays", async () => {
    const state = freshStateDir();
    const dir = keysWith(state, [tmpName(A, DEAD_PID), tmpName(A, process.pid), tmpName(B, DEAD_PID)]);
    expect((await cli(["key", "delete", "--id", A, "--json"], { keyStore: linux() })).json).toEqual({ schemaVersion: 1, ok: true, deleted: true });
    expect(readdirSync(dir).sort()).toEqual([tmpName(A, process.pid), tmpName(B, DEAD_PID)].sort());
  });

  // PR 2 final r2 M1: a set whose id's name is TAKEN (another key) and whose temp then sticks answers WITHOUT that id,
  // so the app's retry cannot delete the other key.
  test("linux: a taken name with a stuck temp answers cleanup failed and NO keyId; the other key is untouched", async () => {
    const state = freshStateDir();
    const dir = keysWith(state, [`${A}.key`]);
    const link = async (): Promise<void> => { chmodSync(dir, 0o500); throw Object.assign(new Error("taken"), { code: "EEXIST" }); };
    try {
      const r = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: linux({ newId: () => A, link }) });
      expect([r.code, r.json?.code, r.json?.reason, r.json?.cleanup, "keyId" in (r.json ?? {})]).toEqual([1, "write-failed", "write-failed", "failed", false]);
    } finally { chmodSync(dir, 0o700); }
    expect(readFileSync(join(dir, `${A}.key`), "utf8")).toBe("sk-temp-secret-bytes");
  });

  // PR 2 final r3 L1: the same rule for the TIMEOUT answer (reviewers A and B's probe, through providerMain). The
  // deadline fires while link(2) is still in flight on a name another key already holds — the store's answer is built
  // before its EEXIST is seen (test/keyStore.linux.test.ts pins that premise) — so the cleanup's finding, another inode
  // under the final name, is what keeps the id out of it; with the id, the retry `key delete --id` deletes the other key.
  test("linux: a deadline that fires while link(2) is in flight on a TAKEN name answers timeout with NO keyId; the other key is untouched", async () => {
    const state = freshStateDir();
    const dir = keysWith(state, [`${A}.key`]);
    let links = 0, settled = 0;
    const link = async (): Promise<void> => {
      links++;
      await Bun.sleep(LINK_PAST_DEADLINE_MS);                 // past the deadline from when it is entered
      settled++;
      throw Object.assign(new Error("taken"), { code: "EEXIST" });
    };
    const r = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: linux({ newId: () => A, link, deadlineMs: IN_FLIGHT_DEADLINE_MS }) });
    expect([r.code, r.json?.code, r.json?.reason, r.json?.cleanup, "keyId" in (r.json ?? {})]).toEqual([1, "write-failed", "timeout", "not-found", false]);
    expect(links).toBe(1);                                     // one link, cut by the deadline: no fresh id was tried
    for (let i = 0; i < 50 && settled < links; i++) await Bun.sleep(20);
    expect(settled).toBe(1);
    await Bun.sleep(50);                                       // the abandoned attempt: no fresh id, nothing published
    expect(readdirSync(dir)).toEqual([`${A}.key`]);
    expect(readFileSync(join(dir, `${A}.key`), "utf8")).toBe("sk-temp-secret-bytes");
  });

  test("delete-all empties the service (darwin) and keys/ (linux)", async () => {
    freshStateDir();
    const kc = fakeKeychain();
    for (const id of [A, B, "k-cccccccccccc"]) kc.items.set(id, `value-${id}`);
    const r = await cli(["key", "delete-all", "--json"], { keyStore: mac(kc.exec) });
    expect(r.json).toEqual({ schemaVersion: 1, ok: true, deleted: 3 });
    expect(kc.items.size).toBe(0);

    const state = freshStateDir();
    const dir = keysWith(state, [`${A}.key`, `${B}.key`, tmpName(A, DEAD_PID)]);
    expect((await cli(["key", "delete-all", "--json"], { keyStore: linux() })).json).toEqual({ schemaVersion: 1, ok: true, deleted: 2 });
    expect(existsSync(dir)).toBe(false);                     // the emptied folder is removed too (C1)
  });

  test("a store failure is write-failed (exit 1) with the store's reason; delete-all also says how many it removed", async () => {
    freshStateDir();
    const kc = fakeKeychain({ deleteCode: 1 });
    kc.items.set(A, "value-a-123456");
    const del = await cli(["key", "delete", "--id", A, "--json"], { keyStore: mac(kc.exec) });
    expect([del.code, del.json?.code, del.json?.reason]).toEqual([1, "write-failed", "failed"]);
    const all = await cli(["key", "delete-all", "--json"], { keyStore: mac(kc.exec) });
    expect([all.code, all.json?.code, all.json?.reason, all.json?.deleted]).toEqual([1, "write-failed", "failed", 0]);
  });
});

describe("production: no exec is injected, so the store's own BACKSTOPPED exec is the one used (carried item 4)", () => {
  test("key set, key delete and key delete-all on darwin are each refused by the backstop before any spawn", async () => {
    freshStateDir();
    const set = await cli(["key", "set", "--json"], { readStdin: stdin(KEY), keyStore: { platform: "darwin" } });
    const del = await cli(["key", "delete", "--id", A, "--json"], { keyStore: { platform: "darwin" } });
    const all = await cli(["key", "delete-all", "--json"], { keyStore: { platform: "darwin" } });
    for (const r of [set, del, all]) expect([r.code, r.json?.code, r.json?.reason]).toEqual([1, "write-failed", "refused"]);
    expect(set.text).not.toContain(KEY);
  });
});
