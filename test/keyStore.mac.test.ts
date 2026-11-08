// test/keyStore.mac.test.ts — the macOS Keychain key store (provider-fallback plan P2-M2-T1; spec r9 §6 `key set`,
// `key delete`, `key delete-all`, §9 the day-0 spike).
//
// ⚠ FAKE-ONLY, BY USER DECISION (hub Q27, 2026-10-17): no automated test runs the real Keychain tool, not even
// against a throwaway keychain. Every behaviour the plan put on a scratch keychain is driven here through an injected
// exec backed by an IN-MEMORY fake Keychain (`fakeKeychain` below), which parses the same command shapes the tool
// takes: the `-i` add line on stdin, and the argv of the read-back and the deletes. So this file runs on every OS, and
// it never opts in to the spawn guard (test/fixtures/spawn-guard.ts `OPT_IN_FILES`): a spawn from here is refused and
// fails the test. What the fake cannot prove — that the real tool parses the add line as the fake does, that it exits
// 44 for "not found", that a quoted keychain path is honoured — is the real-Mac sitting's (plan "Real-Mac sitting").
//
// ⚠ NO LITERAL HERE NAMES THE TOOL: argv is built from SECURITY_BIN (src/appKeyNames.ts), which the never-reach
// scanner (test/isolation.meta.test.ts) does not read, so this file needs no REACH_CONDITIONAL entry.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { APP_KEY_SERVICE, SECURITY_BIN } from "../src/appKeyNames";
import { isAppOwnedKey, type ListEntry } from "../src/providerList";
import type { RunResult } from "../src/proc";
import {
  appKeyCommand, keychainDelete, keychainDeleteAll, keychainSet, loginKeychainPath, newKeyId, normalizeKey,
  KEY_CLEANUP_MS, KEY_DELETE_ALL_MAX_ITERATIONS, KEY_ID_RE, KEY_NOT_FOUND_EXIT, KEY_OP_DEADLINE_MS,
  type KeyExec, type KeyStoreDeps,
} from "../src/keyStore";

const HOME = "/Users/fake person";                       // a space, so the stdin operand must be quoted
const LOGIN = `${HOME}/Library/Keychains/login.keychain-db`;
const SCRATCH = "/private/tmp/dba-keystore-scratch/test.keychain-db";
const KEY = "sk-ant-api03_AbC.def~ghi+jkl/mno=pqr-STU";

type Call = { cmd: string[]; input?: string; timeoutMs?: number };
const result = (code: number, out = "", err = ""): RunResult =>
  ({ out, err, code, complete: true, spawned: true, signal: null, timedOut: false });

/** The words of one `-i` stdin line, as the tool reads them: whitespace-separated, a double-quoted run is one word. */
const wordsOfLine = (line: string): string[] =>
  (line.match(/"[^"]*"|\S+/g) ?? []).map((w) => (w.startsWith('"') && w.endsWith('"') ? w.slice(1, -1) : w));

/** `-s svc -a acct -w [value] … keychain`: the options the store uses, and the trailing keychain operand. */
function parseOptions(words: string[], wTakesValue: boolean) {
  const o: { s?: string; a?: string; w?: string | true; keychain?: string } = {};
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "-s") o.s = words[++i];
    else if (w === "-a") o.a = words[++i];
    else if (w === "-w") o.w = wTakesValue ? words[++i] : true;
    else if (i === words.length - 1) o.keychain = w;
    else throw new Error(`fake Keychain: unexpected word ${JSON.stringify(w)}`);
  }
  return o;
}

/**
 * An in-memory Keychain behind a recording exec. Items are keyed by (keychain, service, account). `corrupt` changes the
 * value the add STORES (the spike's malformed line: exit 0, the wrong value kept); `addCode` / `findCode` force an exit;
 * `stall` makes the named operation never answer.
 */
function fakeKeychain(o: {
  corrupt?: (v: string) => string; addCode?: number; findCode?: number; deleteCode?: number;
  stall?: "add" | "find" | "delete"; addOutput?: string; addDelayMs?: number;
} = {}) {
  const items = new Map<string, string>();
  const calls: Call[] = [];
  const k = (kc: string, s: string, a: string) => `${kc}\u0000${s}\u0000${a}`;
  const never = new Promise<RunResult>(() => {});
  const exec: KeyExec = async (cmd, opts) => {
    calls.push({ cmd: [...cmd], ...(opts?.input !== undefined ? { input: opts.input } : {}), ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    if (cmd[0] !== SECURITY_BIN) return result(127);
    if (cmd[1] === "-i") {
      if (o.stall === "add") return never;
      if (o.addDelayMs) await Bun.sleep(o.addDelayMs);
      for (const line of (opts?.input ?? "").split("\n").filter((l) => l.trim() !== "")) {
        const [verb, ...rest] = wordsOfLine(line);
        if (verb !== "add-generic-password") return result(1);
        const p = parseOptions(rest, true);
        if (o.addCode !== undefined) return result(o.addCode, o.addOutput ?? "", o.addOutput ?? "");
        const id = k(p.keychain!, p.s!, p.a!);
        if (items.has(id)) return result(45);                // duplicate: never overwritten without -U
        items.set(id, (o.corrupt ?? ((v: string) => v))(String(p.w)));
      }
      return result(0, o.addOutput ?? "", o.addOutput ?? "");
    }
    const p = parseOptions(cmd.slice(2), false);
    if (cmd[1] === "find-generic-password") {
      if (o.stall === "find") return never;
      if (o.findCode !== undefined) return result(o.findCode);
      const v = items.get(k(p.keychain!, p.s!, p.a!));
      return v === undefined ? result(KEY_NOT_FOUND_EXIT) : result(0, `${v}\n`);
    }
    if (cmd[1] === "delete-generic-password") {
      if (o.stall === "delete") return never;
      if (o.deleteCode !== undefined) return result(o.deleteCode);
      const hit = [...items.keys()].find((x) => x.startsWith(`${p.keychain}\u0000${p.s}\u0000`) && (p.a === undefined || x === k(p.keychain!, p.s!, p.a)));
      if (hit === undefined) return result(KEY_NOT_FOUND_EXIT);
      items.delete(hit);
      return result(0);
    }
    return result(1);
  };
  return { exec, calls, items, values: () => [...items.values()] };
}

const deps = (exec: KeyExec, extra: KeyStoreDeps = {}): KeyStoreDeps => ({ exec, home: HOME, env: {}, ...extra });
/** Every word of every call — argv elements and stdin words — for the "where does X appear" assertions. */
const everyWord = (calls: Call[]): string[] => calls.flatMap((c) => [...c.cmd, ...(c.input !== undefined ? wordsOfLine(c.input) : [])]);
/** The keychain operand of a call: the last stdin word for the `-i` add, else the last argv element. */
const operandOf = (c: Call): string => (c.cmd[1] === "-i" ? wordsOfLine(c.input!.trim()).at(-1)! : c.cmd.at(-1)!);

describe("ids and the key itself", () => {
  test("newKeyId issues k-<12 hex>, a fresh one every time", () => {
    const ids = Array.from({ length: 200 }, () => newKeyId());
    for (const id of ids) expect(id).toMatch(/^k-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(200);
    expect(KEY_ID_RE.test("k-0123456789ab")).toBe(true);
    for (const bad of ["k-0123456789AB", "k-0123456789a", "k-0123456789abc", "x-0123456789ab", " k-0123456789ab", "k-0123456789ab\n"]) {
      expect(`${JSON.stringify(bad)} → ${KEY_ID_RE.test(bad)}`).toBe(`${JSON.stringify(bad)} → false`);
    }
  });

  test("a new id per key: the same key stored twice is two items, and nothing is overwritten", async () => {
    const kc = fakeKeychain();
    const a = await keychainSet(KEY, deps(kc.exec));
    const b = await keychainSet(KEY, deps(kc.exec));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.keyId).toMatch(/^k-[0-9a-f]{12}$/);
    expect(b.keyId).not.toBe(a.keyId);
    expect(kc.items.size).toBe(2);
    // Never the update flag (which would overwrite an existing item), never -A (any app may read the item).
    expect(everyWord(kc.calls).filter((w) => w === "-U" || w === "-A")).toEqual([]);
  });

  test("trimming: surrounding whitespace is removed before the key is checked and stored", async () => {
    const kc = fakeKeychain();
    const r = await keychainSet(`  \t${KEY}\r\n `, deps(kc.exec));
    expect(r.ok).toBe(true);
    expect(kc.values()).toEqual([KEY]);
    expect(normalizeKey(` ${KEY}\n`)).toBe(KEY);
  });

  test("charset and length are refused BEFORE any exec call: [A-Za-z0-9._~+/=-], 8 to 512 characters", async () => {
    for (const ok of ["a".repeat(8), "Z".repeat(512), "aA0._~+/=-"]) expect(`${ok.length} → ${normalizeKey(ok)}`).toBe(`${ok.length} → ${ok}`);
    const bad = ["", "       ", "a".repeat(7), "a".repeat(513), "sk-abc def12", 'sk-abc"def12', "sk-abc\\def12", "sk-abc'def12",
      "sk-abc\ndef12", "sk-abc\tdef12", "sk-abcdéf12", "sk-abc;def12", "sk-abc$def12", "sk-abc`def12", "sk-abc\u0000def12"];
    for (const b of bad) {
      const kc = fakeKeychain();
      const r = await keychainSet(b, deps(kc.exec));
      expect(`${JSON.stringify(b)} → ${r.ok ? "ok" : r.reason} / ${kc.calls.length} calls`).toBe(`${JSON.stringify(b)} → invalid-key / 0 calls`);
      expect(normalizeKey(b)).toBeUndefined();
    }
  });
});

describe("keychainSet: the add, then the read-back", () => {
  test("the add is `-i` with the command on STDIN: the key is never in argv", async () => {
    const kc = fakeKeychain();
    const r = await keychainSet(KEY, deps(kc.exec));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const add = kc.calls[0]!;
    expect(add.cmd).toEqual([SECURITY_BIN, "-i"]);
    expect(add.input).toBe(`add-generic-password -s ${APP_KEY_SERVICE} -a ${r.keyId} -w "${KEY}" "${LOGIN}"\n`);
    expect(kc.calls.every((c) => c.cmd.every((a) => !a.includes(KEY)))).toBe(true);
    expect(kc.calls.slice(1).every((c) => c.input === undefined)).toBe(true);   // nothing else carries a stdin payload
  });

  test("the read-back runs exactly the reference the morning run will run, and the reference is app-owned", async () => {
    const kc = fakeKeychain();
    const r = await keychainSet(KEY, deps(kc.exec));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.apiKeyCommand).toEqual([SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-a", r.keyId, "-w", LOGIN]);
    expect(r.apiKeyCommand).toEqual(appKeyCommand(r.keyId, LOGIN));
    expect(kc.calls.map((c) => c.cmd)).toEqual([[SECURITY_BIN, "-i"], r.apiKeyCommand]);
    const entry = { label: "k", provider: { api: { kind: "anthropic", model: "m", apiKeyCommand: r.apiKeyCommand } } } as unknown as ListEntry;
    expect(isAppOwnedKey(entry, "/nonexistent-keys")).toBe(true);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  test("all of the add's output is discarded: nothing it prints reaches the outcome", async () => {
    const echo = `echoed ${KEY} and a password prompt`;
    for (const kc of [fakeKeychain({ addOutput: echo }), fakeKeychain({ addOutput: echo, addCode: 1 })]) {
      const r = await keychainSet(KEY, deps(kc.exec));
      expect(JSON.stringify(r)).not.toContain("echoed");
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
  });

  test("a malformed line is caught by the read-back (spec §9: exit 0, the WRONG value stored) and the failed id deleted", async () => {
    const wrong = `${KEY}" "${LOGIN}`;                                  // what the spike's unclosed quote stored
    const kc = fakeKeychain({ corrupt: () => wrong });
    const r = await keychainSet(KEY, deps(kc.exec));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("readback-mismatch");
    expect(r.cleanup).toBe("deleted");
    const id = /-a (k-[0-9a-f]{12})/.exec(kc.calls[0]!.input!)![1]!;
    expect(kc.calls.at(-1)!.cmd).toEqual([SECURITY_BIN, "delete-generic-password", "-s", APP_KEY_SERVICE, "-a", id, LOGIN]);
    expect(kc.items.size).toBe(0);                                       // no item holding a wrong value is left behind
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(r)).not.toContain("Keychains");
  });

  test("a read-back that fails deletes the id", async () => {
    for (const code of [KEY_NOT_FOUND_EXIT, 1, 51]) {
      const kc = fakeKeychain({ findCode: code });
      const r = await keychainSet(KEY, deps(kc.exec));
      expect(r.ok ? "ok" : `${r.reason}/${r.cleanup}`).toBe("readback-failed/deleted");
      expect(kc.items.size).toBe(0);
    }
  });

  test("an add that exits non-zero, cleanly, deletes nothing (the id may name an item that is not this call's)", async () => {
    for (const code of [1, 45]) {
      const kc = fakeKeychain({ addCode: code });
      const r = await keychainSet(KEY, deps(kc.exec));
      expect(r.ok ? "ok" : `${r.reason}/${r.cleanup ?? "none"}`).toBe("add-failed/none");
      expect(kc.calls.map((c) => c.cmd[1])).toEqual(["-i"]);
    }
  });

  test("an add killed at its bound (timedOut) is treated as a timeout and its id deleted", async () => {
    const kc = fakeKeychain();
    const exec: KeyExec = async (cmd, opts) =>
      cmd[1] === "-i" ? { ...result(1), signal: "SIGKILL", timedOut: true } : kc.exec(cmd, opts);
    const r = await keychainSet(KEY, deps(exec));
    expect(r.ok ? "ok" : `${r.reason}/${r.cleanup}`).toBe("timeout/not-found");
    expect(kc.calls.at(-1)!.cmd[1]).toBe("delete-generic-password");
  });

  // P2-M2-T1 checkpoint LOW 6: the two cleanup branches no test reached. Each add really STORES the item, then reports
  // an exit the store cannot read, so a store that stopped cleaning up would leave the item behind (items.size 1).
  test("an add that ends unreadably WITHOUT timedOut — killed, or cut short — still deletes its id", async () => {
    for (const odd of [
      { name: "killed, not by our bound", r: { signal: "SIGKILL", timedOut: false, code: -1, complete: true } },
      { name: "cut short", r: { complete: false, code: -1 } },
    ]) {
      const kc = fakeKeychain();
      const exec: KeyExec = async (cmd, opts) => {
        const real = await kc.exec(cmd, opts);
        return cmd[1] === "-i" ? { ...real, ...odd.r } : real;
      };
      const r = await keychainSet(KEY, deps(exec));
      expect(`${odd.name} → ${r.ok ? "ok" : `${r.reason}/${r.cleanup ?? "none"}`} items=${kc.items.size}`)
        .toBe(`${odd.name} → add-failed/deleted items=0`);
    }
  });

  test("a read-back whose output was truncated fails, even when what was read matches, and deletes the id", async () => {
    const kc = fakeKeychain();
    const exec: KeyExec = async (cmd, opts) => {
      const real = await kc.exec(cmd, opts);
      return cmd[1] === "find-generic-password" ? { ...real, outTruncated: true } : real;
    };
    const r = await keychainSet(KEY, deps(exec));
    expect(`${r.ok ? "ok" : `${r.reason}/${r.cleanup ?? "none"}`} items=${kc.items.size}`).toBe("readback-failed/deleted items=0");
  });

  test("a stalled add hits the deadline and the id is deleted", async () => {
    const kc = fakeKeychain({ stall: "add" });
    const t0 = performance.now();
    const r = await keychainSet(KEY, deps(kc.exec, { deadlineMs: 80, cleanupMs: 80 }));
    const took = performance.now() - t0;
    expect(r.ok ? "ok" : r.reason).toBe("timeout");
    if (r.ok) return;
    expect(r.message).toContain("unlock your keychain, then retry");
    const id = /-a (k-[0-9a-f]{12})/.exec(kc.calls[0]!.input!)![1]!;
    expect(kc.calls.map((c) => c.cmd)).toEqual([[SECURITY_BIN, "-i"], [SECURITY_BIN, "delete-generic-password", "-s", APP_KEY_SERVICE, "-a", id, LOGIN]]);
    expect(took).toBeGreaterThanOrEqual(75);
    expect(took).toBeLessThan(80 + 80 + 400);
  });

  test("a stalled read-back hits the deadline and the id is deleted", async () => {
    const kc = fakeKeychain({ stall: "find" });
    const r = await keychainSet(KEY, deps(kc.exec, { deadlineMs: 80, cleanupMs: 80 }));
    expect(r.ok ? "ok" : `${r.reason}/${r.cleanup}`).toBe("timeout/deleted");
    expect(kc.items.size).toBe(0);
  });

  test("ONE deadline covers the add and the read-back together: a slow add leaves the read-back only what is left", async () => {
    const kc = fakeKeychain({ addDelayMs: 120, stall: "find" });
    const t0 = performance.now();
    const r = await keychainSet(KEY, deps(kc.exec, { deadlineMs: 200, cleanupMs: 50 }));
    const took = performance.now() - t0;
    expect(r.ok ? "ok" : r.reason).toBe("timeout");
    const [add, find] = kc.calls;
    expect(add!.timeoutMs).toBeLessThanOrEqual(200);
    expect(find!.timeoutMs).toBeLessThanOrEqual(200 - 110);              // the add's 120 ms came off the read-back's bound
    expect(took).toBeLessThan(200 + 50 + 300);                           // not 200 + 200
  });

  test("the cleanup delete is bounded on its own: a stalled delete cannot hold the outcome", async () => {
    const kc = fakeKeychain({ stall: "delete", corrupt: () => "a-wrong-value" });
    const t0 = performance.now();
    const r = await keychainSet(KEY, deps(kc.exec, { deadlineMs: 500, cleanupMs: 80 }));
    const took = performance.now() - t0;
    expect(r.ok ? "ok" : `${r.reason}/${r.cleanup}`).toBe("readback-mismatch/timeout");
    expect(took).toBeLessThan(80 + 400);
  });

  // The budget these feed — 1 s pre-store + 10 s + 3 s = 14 s, the app's 19 s `key set` timeout less its 5 s margin —
  // is pinned once, in test/provider.key-cli.test.ts ("the bounds: …"), which owns the pre-store term (B9).
  test("the production bounds: 10 s over add and read-back, 3 s for the cleanup", () => {
    expect(KEY_OP_DEADLINE_MS).toBe(10_000);
    expect(KEY_CLEANUP_MS).toBe(3_000);
  });
});

describe("the keychain operand: explicit and absolute on every call", () => {
  test("every call names <home>/Library/Keychains/login.keychain-db as its keychain, and no word holds a `~`", async () => {
    expect(loginKeychainPath(HOME)).toBe(LOGIN);
    const kc = fakeKeychain({ corrupt: () => "wrong-value" });           // add, read-back, cleanup delete
    await keychainSet(KEY, deps(kc.exec));
    await keychainDelete("k-0123456789ab", deps(kc.exec));
    await keychainDeleteAll(deps(kc.exec));
    expect(new Set(kc.calls.map((c) => c.cmd[1]))).toEqual(new Set(["-i", "find-generic-password", "delete-generic-password"]));
    for (const c of kc.calls) expect(`${c.cmd[1]} → ${operandOf(c)}`).toBe(`${c.cmd[1]} → ${LOGIN}`);
    // The key's own charset allows `~` (it is a password, not a path); no OTHER word may hold one.
    expect(everyWord(kc.calls).filter((w) => w.includes("~") && w !== KEY)).toEqual([]);
  });

  test("the home folder comes from the seam, and one that is not absolute is refused before any exec call", async () => {
    for (const home of ["~", "~/x", "relative/home", "", "/Users/a\"b", "/Users/a\nb", "/Users/a'b"]) {
      const kc = fakeKeychain();
      const outcomes = [await keychainSet(KEY, deps(kc.exec, { home })), await keychainDelete("k-0123456789ab", deps(kc.exec, { home })), await keychainDeleteAll(deps(kc.exec, { home }))];
      expect(`${JSON.stringify(home)} → ${outcomes.map((o) => (o.ok ? "ok" : o.reason)).join(",")} / ${kc.calls.length}`).toBe(`${JSON.stringify(home)} → keychain-refused,keychain-refused,keychain-refused / 0`);
    }
  });

  test("under the DBA_ENGINE_TEST_KEYCHAIN interlock every call names that keychain instead", async () => {
    const kc = fakeKeychain();
    const env = { DBA_ENGINE_TEST_KEYCHAIN: SCRATCH };
    const r = await keychainSet(KEY, deps(kc.exec, { env }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.apiKeyCommand.at(-1)).toBe(SCRATCH);
    await keychainDelete("k-0123456789ab", deps(kc.exec, { env }));
    await keychainDeleteAll(deps(kc.exec, { env }));
    for (const c of kc.calls) expect(operandOf(c)).toBe(SCRATCH);
  });

  test("without the interlock the module names no keychain but the login one — the script's DBA_TEST_KEYCHAIN is not it", async () => {
    const kc = fakeKeychain();
    await keychainSet(KEY, deps(kc.exec, { env: { DBA_TEST_KEYCHAIN: SCRATCH, DBA_ENGINE_TEST_KEYCHAIN: "" } }));
    await keychainDeleteAll(deps(kc.exec, { env: { DBA_TEST_KEYCHAIN: SCRATCH } }));
    expect(kc.calls.length).toBeGreaterThan(0);
    for (const c of kc.calls) expect(operandOf(c)).toBe(LOGIN);
  });

  test("an interlock that does not name a scratch keychain is refused before any exec call", async () => {
    for (const bad of [LOGIN, "/tmp/x/login.keychain-db", "/tmp/x/Login.keychain", "/Library/Keychains/System.keychain",
      "/Users/x/Library/Keychains/other.keychain-db", "relative/test.keychain-db", "~/test.keychain-db", "/tmp/x/../y/test.keychain-db",
      '/tmp/x/a"b.keychain-db', "/tmp/x/a\nb.keychain-db", "/tmp/x/a'b.keychain-db", "/tmp/x/test.txt", "/tmp/x/test.keychain-db -A"]) {
      const kc = fakeKeychain();
      const env = { DBA_ENGINE_TEST_KEYCHAIN: bad };
      const outcomes = [await keychainSet(KEY, deps(kc.exec, { env })), await keychainDelete("k-0123456789ab", deps(kc.exec, { env })), await keychainDeleteAll(deps(kc.exec, { env }))];
      expect(`${JSON.stringify(bad)} → ${outcomes.map((o) => (o.ok ? "ok" : o.reason)).join(",")} / ${kc.calls.length}`).toBe(`${JSON.stringify(bad)} → keychain-refused,keychain-refused,keychain-refused / 0`);
    }
  });
});

describe("keychainDelete and keychainDeleteAll", () => {
  test("delete validates the id against k-[0-9a-f]{12} before any exec call", async () => {
    for (const bad of ["", "k-0123456789AB", "k-0123", "k-0123456789ab -s x", "-a", "k-0123456789ab\n", "../k-0123456789ab"]) {
      const kc = fakeKeychain();
      const r = await keychainDelete(bad, deps(kc.exec));
      expect(`${JSON.stringify(bad)} → ${r.ok ? "ok" : r.reason} / ${kc.calls.length}`).toBe(`${JSON.stringify(bad)} → invalid-id / 0`);
    }
  });

  test("delete removes that one item; a missing id answers deleted:false; any other exit is a failure", async () => {
    const kc = fakeKeychain();
    const a = await keychainSet(KEY, deps(kc.exec)), b = await keychainSet(KEY, deps(kc.exec));
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(await keychainDelete(a.keyId, deps(kc.exec))).toEqual({ ok: true, deleted: true });
    expect(kc.calls.at(-1)!.cmd).toEqual([SECURITY_BIN, "delete-generic-password", "-s", APP_KEY_SERVICE, "-a", a.keyId, LOGIN]);
    expect(kc.items.size).toBe(1);
    expect(await keychainDelete(a.keyId, deps(kc.exec))).toEqual({ ok: true, deleted: false });
    const failing = fakeKeychain({ deleteCode: 1 });
    const f = await keychainDelete(b.keyId, deps(failing.exec));
    expect(f.ok ? "ok" : f.reason).toBe("failed");
  });

  test("a stalled delete is bounded by the deadline", async () => {
    const r = await keychainDelete("k-0123456789ab", deps(fakeKeychain({ stall: "delete" }).exec, { deadlineMs: 60 }));
    expect(r.ok ? "ok" : r.reason).toBe("timeout");
  });

  test("deleteAll loops until not-found, naming the service and the keychain and NO account, and empties the service", async () => {
    const kc = fakeKeychain();
    for (let i = 0; i < 3; i++) await keychainSet(KEY, deps(kc.exec));
    kc.calls.length = 0;
    expect(await keychainDeleteAll(deps(kc.exec))).toEqual({ ok: true, deleted: 3 });
    expect(kc.items.size).toBe(0);
    expect(kc.calls.map((c) => c.cmd)).toEqual(Array(4).fill([SECURITY_BIN, "delete-generic-password", "-s", APP_KEY_SERVICE, LOGIN]));
    expect(await keychainDeleteAll(deps(kc.exec))).toEqual({ ok: true, deleted: 0 });
  });

  test("deleteAll stops at its named cap when not-found never comes", async () => {
    let n = 0;
    const exec: KeyExec = async () => { n++; return result(0); };
    const r = await keychainDeleteAll(deps(exec));
    expect(r.ok ? "ok" : r.reason).toBe("cap");
    expect(n).toBe(KEY_DELETE_ALL_MAX_ITERATIONS);
    expect(r.deleted).toBe(KEY_DELETE_ALL_MAX_ITERATIONS);
    expect(KEY_DELETE_ALL_MAX_ITERATIONS).toBeGreaterThanOrEqual(64);
  });

  test("deleteAll stops on a failing exit, and on its deadline", async () => {
    let n = 0;
    const failing: KeyExec = async () => (++n < 3 ? result(0) : result(1));
    const f = await keychainDeleteAll(deps(failing));
    expect(f.ok ? "ok" : `${f.reason}/${f.deleted}`).toBe("failed/2");
    const t = await keychainDeleteAll(deps(fakeKeychain({ stall: "delete" }).exec, { deadlineMs: 60 }));
    expect(t.ok ? "ok" : `${t.reason}/${t.deleted}`).toBe("timeout/0");
  });

  test("an exec that throws is a failure, never a crash", async () => {
    const boom: KeyExec = () => { throw new Error("boom"); };
    const s = await keychainSet(KEY, deps(boom)), d = await keychainDelete("k-0123456789ab", deps(boom)), a = await keychainDeleteAll(deps(boom));
    expect([s, d, a].map((o) => (o.ok ? "ok" : o.reason))).toEqual(["add-failed", "failed", "failed"]);
    expect(JSON.stringify([s, d, a])).not.toContain("boom");
  });
});
