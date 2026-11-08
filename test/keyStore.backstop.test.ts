// test/keyStore.backstop.test.ts — the key store's production backstop (provider-fallback plan P2-M2-T1, Build
// conventions "No test reaches the real Keychain", part 4).
//
// Whenever DBA_TEST_UNIT_DIR is set — test/fixtures/isolate-state.ts arms it in every test process — the key store's
// DEFAULT exec refuses, before anything runs, every Keychain call that carries no explicit scratch-keychain operand:
// a call that names the login keychain, or none at all (which searches the default list, the login keychain
// included). The same pattern as `defaultExec` in src/schedule/install.ts, which refuses scheduler changes. It is a
// BACKSTOP for a test that forgets to inject the exec — and for a child engine that inherits the variable, which the
// in-process spawn guard (test/preload.ts) cannot see — never a way to write a test.
//
// Driven two ways: `backstopped` over a RECORDING inner exec (so "let through" is observed without spawning), and the
// store's real default exec with NO exec injected, whose refusals must come back before any spawn. Should the backstop
// ever let one through, the run-wide spawn guard refuses the spawn and fails the test: this file never opts in.
// It holds no literal naming the tool (argv from SECURITY_BIN), so it needs no REACH_CONDITIONAL entry.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { APP_KEY_SERVICE, SECURITY_BIN } from "../src/appKeyNames";
import type { RunResult } from "../src/proc";
import {
  appKeyCommand, backstopArmed, backstopped, isScratchKeychain, keychainDelete, keychainDeleteAll, keychainSet, loginKeychainPath,
  KEYCHAIN_CALL_REFUSED, type KeyExec,
} from "../src/keyStore";

const HOME = "/nonexistent-dba-home";
const LOGIN = loginKeychainPath(HOME);
const SCRATCH = "/private/tmp/dba-keystore-scratch/test.keychain-db";
const ID = "k-0123456789ab";
const KEY = "sk-test-0123456789";

/** The four call shapes the store makes, against keychain `kc`: the add (stdin), the read-back, a delete, a delete-all. */
const shapes = (kc: string): { name: string; cmd: string[]; input?: string }[] => [
  { name: "add", cmd: [SECURITY_BIN, "-i"], input: `add-generic-password -s ${APP_KEY_SERVICE} -a ${ID} -w "${KEY}" "${kc}"\n` },
  { name: "read-back", cmd: appKeyCommand(ID, kc) },
  { name: "delete", cmd: [SECURITY_BIN, "delete-generic-password", "-s", APP_KEY_SERVICE, "-a", ID, kc] },
  { name: "delete-all", cmd: [SECURITY_BIN, "delete-generic-password", "-s", APP_KEY_SERVICE, kc] },
];

function recorder() {
  const calls: { cmd: string[]; input?: string }[] = [];
  const ok: RunResult = { out: "", err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false };
  const exec: KeyExec = async (cmd, opts) => { calls.push({ cmd, ...(opts?.input !== undefined ? { input: opts.input } : {}) }); return ok; };
  return { exec, calls };
}
const ARMED = { DBA_TEST_UNIT_DIR: "/private/tmp/dba-isolated-units-x" };

describe("the backstop over a recording exec", () => {
  test("refuses the add, the read-back, a delete and a delete-all that name the login keychain — the inner exec never runs", async () => {
    const rec = recorder();
    const guarded = backstopped(rec.exec, ARMED);
    for (const s of shapes(LOGIN)) {
      const r = await guarded(s.cmd, { timeoutMs: 1000, ...(s.input !== undefined ? { input: s.input } : {}) });
      expect(`${s.name} → ${r.spawned} ${r.err}`).toBe(`${s.name} → false ${KEYCHAIN_CALL_REFUSED}`);
    }
    expect(rec.calls).toEqual([]);
  });

  test("refuses a call with NO keychain operand (it would search the default list), and an add with no stdin", async () => {
    const rec = recorder();
    const guarded = backstopped(rec.exec, ARMED);
    for (const [cmd, input] of [
      [[SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-w"], undefined],
      [[SECURITY_BIN, "delete-generic-password", "-s", APP_KEY_SERVICE], undefined],
      [[SECURITY_BIN, "-i"], undefined],
      [[SECURITY_BIN, "-i"], `add-generic-password -s ${APP_KEY_SERVICE} -a ${ID} -w "${KEY}"\n`],
      [[SECURITY_BIN, "-i"], `add-generic-password -s ${APP_KEY_SERVICE} -a ${ID} -w "${KEY}" "${SCRATCH}"\nadd-generic-password -s x -a y -w z "${LOGIN}"\n`],
      [[SECURITY_BIN], undefined],
    ] as [string[], string | undefined][]) {
      const r = await guarded(cmd, { timeoutMs: 1000, ...(input !== undefined ? { input } : {}) });
      expect(`${cmd.slice(1).join(" ")} → ${r.err}`).toBe(`${cmd.slice(1).join(" ")} → ${KEYCHAIN_CALL_REFUSED}`);
    }
    expect(rec.calls).toEqual([]);
  });

  test("lets the same four calls through, unchanged, when the operand names a scratch keychain", async () => {
    const rec = recorder();
    const guarded = backstopped(rec.exec, ARMED);
    for (const s of shapes(SCRATCH)) {
      const r = await guarded(s.cmd, { timeoutMs: 1000, ...(s.input !== undefined ? { input: s.input } : {}) });
      expect(`${s.name} → ${r.code}`).toBe(`${s.name} → 0`);
    }
    expect(rec.calls).toEqual(shapes(SCRATCH).map((s) => ({ cmd: s.cmd, ...(s.input !== undefined ? { input: s.input } : {}) })));
  });

  test("a hand-built environment WITHOUT the variable is still refused: process.env carries it in every test process", async () => {
    expect(process.env.DBA_TEST_UNIT_DIR).toBeTruthy();
    const rec = recorder();
    const r = await backstopped(rec.exec, {})(appKeyCommand(ID, LOGIN), { timeoutMs: 1000 });
    expect(r.err).toBe(KEYCHAIN_CALL_REFUSED);
    expect(rec.calls).toEqual([]);
  });

  // P2-M2 milestone checkpoint LOW 2: every case above runs ARMED, so a backstop that refused everything — production
  // included — would stay green. The arming test is a pure predicate over both environments, and an UNARMED pair (no
  // variable in either; process.env is never mutated here, an explicit empty one is passed) lets a login-keychain call
  // through to the inner exec unchanged.
  test("the arming predicate: armed by either environment, and by neither only when the variable is absent or empty", () => {
    expect(backstopArmed({}, {})).toBe(false);
    expect(backstopArmed({ DBA_TEST_UNIT_DIR: "" }, { DBA_TEST_UNIT_DIR: "" })).toBe(false);
    expect(backstopArmed(ARMED, {})).toBe(true);
    expect(backstopArmed({}, ARMED)).toBe(true);
    expect(backstopArmed({})).toBe(true);        // the default second environment is process.env, armed in every test
  });

  test("UNARMED, a login-keychain call (each of the four shapes) reaches the inner exec unchanged", async () => {
    const rec = recorder();
    const guarded = backstopped(rec.exec, {}, {});
    for (const s of shapes(LOGIN)) {
      const r = await guarded(s.cmd, { timeoutMs: 1000, ...(s.input !== undefined ? { input: s.input } : {}) });
      expect(`${s.name} → ${r.spawned} ${r.code}`).toBe(`${s.name} → true 0`);
    }
    expect(rec.calls).toEqual(shapes(LOGIN).map((s) => ({ cmd: s.cmd, ...(s.input !== undefined ? { input: s.input } : {}) })));
  });

  // P2-M2-T1 checkpoint LOW 2: the operand check was purely positional — "the last word" — so a call whose last word
  // was a scratch path but was CONSUMED as an option's value (and so searched the default list), or a verb the store
  // never uses, rode through. Each of these is refused now; the store's own shapes still pass (the test above).
  test("refuses calls whose last word looks scratch but is not a keychain operand, and every verb the store never uses", async () => {
    const rec = recorder();
    const guarded = backstopped(rec.exec, ARMED);
    const probes: { name: string; cmd: string[]; input?: string }[] = [
      { name: "find: -a consumes the path", cmd: [SECURITY_BIN, "find-generic-password", "-s", "svc", "-a", "/tmp/x.keychain"] },
      { name: "find: -s consumes the path", cmd: [SECURITY_BIN, "find-generic-password", "-a", ID, "-w", "-s", SCRATCH] },
      { name: "delete: -a consumes the path", cmd: [SECURITY_BIN, "delete-generic-password", "-s", APP_KEY_SERVICE, "-a", SCRATCH] },
      { name: "default-keychain -s", cmd: [SECURITY_BIN, "default-keychain", "-s", "/tmp/x.keychain"] },
      { name: "list-keychains -d user -s", cmd: [SECURITY_BIN, "list-keychains", "-d", "user", "-s", "/tmp/x.keychain"] },
      { name: "an unknown flag", cmd: [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-g", SCRATCH] },
      { name: "two operands", cmd: [SECURITY_BIN, "delete-generic-password", "-s", APP_KEY_SERVICE, SCRATCH, SCRATCH] },
      { name: "a dangling option", cmd: [SECURITY_BIN, "find-generic-password", "-s"] },
      { name: "a scratch path with no verb", cmd: [SECURITY_BIN, SCRATCH] },
      { name: "-i with a second argv word", cmd: [SECURITY_BIN, "-i", SCRATCH], input: `add-generic-password -s x -a y -w "${KEY}" "${SCRATCH}"\n` },
      { name: "a binary that is not the store's", cmd: ["/bin/echo", "find-generic-password", "-s", APP_KEY_SERVICE, SCRATCH] },
      { name: "add: -w consumes the only scratch-looking word", cmd: [SECURITY_BIN, "-i"], input: `add-generic-password -s ${APP_KEY_SERVICE} -a ${ID} -w "${SCRATCH}"\n` },
      { name: "add: a verb the store never sends on stdin", cmd: [SECURITY_BIN, "-i"], input: `default-keychain -s "${SCRATCH}"\n` },
      { name: "add: an unbalanced quote", cmd: [SECURITY_BIN, "-i"], input: `add-generic-password -s ${APP_KEY_SERVICE} -a ${ID} -w "${KEY} "${SCRATCH}"\n` },
      { name: "add: a quote joined to a word", cmd: [SECURITY_BIN, "-i"], input: `add-generic-password -s ${APP_KEY_SERVICE} -a ${ID} -w x"${KEY}" "${SCRATCH}"\n` },
      { name: "add: a backslash", cmd: [SECURITY_BIN, "-i"], input: `add-generic-password -s ${APP_KEY_SERVICE} -a ${ID} -w "a\\" "${SCRATCH}"\n` },
      // P2-M2-T2 checkpoint LOW 3: a single quote may group words for the tool's reader, so this line's scratch-looking
      // last word could be the tail of the -s value and the call name NO keychain. Refused, like a backslash.
      { name: "-i: a single quote that may join the keychain to -s", cmd: [SECURITY_BIN, "-i"], input: `find-generic-password -s '${APP_KEY_SERVICE} /tmp/a'b.keychain\n` },
      { name: "add: a single quote in the key", cmd: [SECURITY_BIN, "-i"], input: `add-generic-password -s ${APP_KEY_SERVICE} -a ${ID} -w "a'b" "${SCRATCH}"\n` },
    ];
    for (const p of probes) {
      const r = await guarded(p.cmd, { timeoutMs: 1000, ...(p.input !== undefined ? { input: p.input } : {}) });
      expect(`${p.name} → ${r.err}`).toBe(`${p.name} → ${KEYCHAIN_CALL_REFUSED}`);
    }
    expect(rec.calls).toEqual([]);
  });

  test("what counts as a scratch keychain: absolute, a .keychain(-db) file, never login-named, never under Library/Keychains", () => {
    for (const ok of [SCRATCH, "/tmp/a b/x.keychain", "/var/folders/q/T/dba-kc-1/k.keychain-db"]) expect(`${ok} → ${isScratchKeychain(ok)}`).toBe(`${ok} → true`);
    for (const bad of [LOGIN, "/tmp/login.keychain-db", "/tmp/LOGIN.keychain", "/Library/Keychains/System.keychain",
      "/Users/u/library/keychains/x.keychain-db", "x.keychain-db", "~/x.keychain-db", "/tmp/~x.keychain-db", "/tmp/../x.keychain-db",
      '/tmp/"x.keychain-db', "/tmp/x\\y.keychain-db", "/tmp/x\n.keychain-db", "/tmp/x.txt", "", "-w"]) {
      expect(`${JSON.stringify(bad)} → ${isScratchKeychain(bad)}`).toBe(`${JSON.stringify(bad)} → false`);
    }
  });

  // P2-M2-T1 checkpoint LOW 3: an unnormalized spelling slipped past the `Library/Keychains` test — the kernel folds
  // `//` and `/./`, the substring test did not. Only a path already in normal form is a scratch keychain.
  test("an unnormalized path is never a scratch keychain: doubled separators and `.` segments", () => {
    for (const bad of ["/Users/h/Library//Keychains/other.keychain-db", "/Library//Keychains/System.keychain",
      "/Users/h/Library/./Keychains/x.keychain-db", "//tmp/x.keychain-db", "/tmp//x.keychain-db", "/tmp/./x.keychain-db"]) {
      expect(`${JSON.stringify(bad)} → ${isScratchKeychain(bad)}`).toBe(`${JSON.stringify(bad)} → false`);
    }
  });
});

describe("the store's real default exec, no exec injected", () => {
  // A fake home, so even the refused argv names no real file. If the backstop ever let a call through, `proc.run` would
  // reach `Bun.spawn`, which the run-wide spawn guard refuses and records — failing this test from preload's afterEach.
  test("keychainSet, keychainDelete and keychainDeleteAll are each refused before any spawn", async () => {
    const deps = { home: HOME, env: {} };
    const s = await keychainSet(KEY, deps);
    expect(s.ok ? "ok" : `${s.reason}/${s.cleanup ?? "none"}`).toBe("refused/none");
    const d = await keychainDelete(ID, deps);
    expect(d.ok ? "ok" : d.reason).toBe("refused");
    const a = await keychainDeleteAll(deps);
    expect(a.ok ? "ok" : `${a.reason}/${a.deleted}`).toBe("refused/0");
  });
});
