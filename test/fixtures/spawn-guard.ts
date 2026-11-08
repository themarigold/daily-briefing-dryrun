// test/fixtures/spawn-guard.ts — the state of the run-wide spawn guard (provider-fallback plan P1-M1-T2).
//
// No test may reach the real Keychain tool. test/preload.ts installs a guard over `Bun.spawn` and
// `Bun.spawnSync` (array and object forms) that refuses any spawn whose program the guard MATCHES, from a
// test that has not opted in, and RECORDS it: `proc.run` swallows a throwing spawn into `spawned: false`
// (src/proc.ts), and `src/apiKey.ts` turns that into a quiet key warning, so the throw alone would hide the
// attempt. preload's `afterEach` fails the test from the record, as it does for the isolation tripwire.
//
// ⚠ THIS FILE HOLDS NO BINARY NAME. The match literals live in test/preload.ts, which is not a `*.test.ts`
// file and is imported by nothing, so the never-reach scanner (test/isolation.meta.test.ts) never reads them.
// This file IS read by that scanner, as a helper of every test that imports it, so a name here would be
// inherited by each of them. preload hands its matcher to `installSpawnGuard`; everything here is generic.
//
// The opt-in is PER TEST: preload's `afterEach` clears it after every test (and its `beforeEach` refuses
// one left over from a hook outside any test), so a file that needs it sets it in its own `beforeEach`.
// Opting in is allowed only from the files in OPT_IN_FILES, checked statically by
// test/preload.guard.test.ts (`optInFileProblems`).
//
// A refusal record carries the program and the call stack, never the rest of the argv: a Keychain argv can
// hold the key itself (`add-generic-password … -w <key>`).
//
// ⚠ ITS LIMITS, stated rather than closed:
//   • It judges EVERY argv element, and every WORD of each (split on whitespace, quotes, `=` and shell
//     punctuation and `$`, backslashes stripped — `shellWords`, src/shellWords.ts, which `namesAppService` in
//     src/providerList.ts shares), so a wrapper
//     that runs the tool as an argument — `env <tool>`, `sh -c "… <tool> …"`, `xcrun <tool>`,
//     `arch -arm64 <tool>` — is refused too (codex review HIGH), and so is a word behind a leading option cluster
//     (`env -S<tool> …`, `-iS<tool>`). What it cannot see is a name built INSIDE the child: a shell variable, quote
//     concatenation (`sec"uri"ty`, which a shell joins into one word after this split), a glob (`/usr/bin/sec*`), a
//     script file that names the tool, a PATH lookup of a renamed copy.
//   • FALSE POSITIVES are accepted: any word whose basename is the tool's name is refused, so a test spawning
//     `git commit -m "Security fix"` fails. That fails LOUD, with the stack, which is the safe direction.
//   • It is IN-PROCESS only, and covers `Bun.spawn` / `Bun.spawnSync` — which `node:child_process` routes through, so
//     `spawnSync` / `execFileSync` from that module ARE refused (MEASURED 2026-10-16 with a look-alike path: one
//     record). It does NOT see `Bun.$` (measured: no record) — a shell template spawns outside these two entry points
//     — so test/isolation.meta.test.ts forbids every spawn construct, `Bun.$` and `$\`` included, in a test file that
//     imports the app's key-name constants. Nor does it see anything a CHILD process spawns. In a child engine that
//     inherits DBA_TEST_UNIT_DIR, the key store's production backstop (`backstopped` in src/keyStore.ts, P2-M2-T1)
//     refuses a Keychain call with no scratch-keychain operand — but ONLY the key store's own calls (`keychainSet`,
//     `keychainDelete`, `keychainDeleteAll` with no exec injected). Every other Keychain call a child makes is NOT
//     covered: the morning key read runs a configured `apiKeyCommand` through proc's `run` directly
//     (src/apiKey.ts, rung 3), outside the backstop, so a child engine whose config names a real key command would run
//     it. Keeping such a config out of a child's test fixtures is the test's job.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { shellWords } from "../../src/shellWords";

type Recorder = (argv: string[], opts: unknown) => unknown;

/** The files (relative to test/) allowed to opt in. The plan had P2-M2-T1 add `keyStore.mac.test.ts` for scratch-keychain
 *  cases; hub Q27 (user, 2026-10-17) made the Keychain tests fake-only, so nothing else opts in. */
export const OPT_IN_FILES: readonly string[] = ["preload.guard.test.ts"];

let matcher: ((program: string) => boolean) | undefined;
let originals: { spawn: typeof Bun.spawn; spawnSync: typeof Bun.spawnSync } | undefined;
let guards: { spawn: typeof Bun.spawn; spawnSync: typeof Bun.spawnSync } | undefined;
let optedIn = false;
let recorder: Recorder | undefined;
const violations: string[] = [];

const where = (): string => (new Error().stack ?? "").split("\n").slice(3, 15).join("\n");

/** The words of one argv element, as a shell would split it (and the element itself), each ALSO with any leading
 *  option cluster removed at every split point — `-Ssecurity` yields `security` — so a flag joined to its value
 *  cannot hide the tool. */
function wordsOf(element: string): string[] {
  const words = [element, ...shellWords(element)];   // the one shared tokenizer (src/shellWords.ts, L5)
  const out: string[] = [];
  for (const w of words) {
    out.push(w);
    const cluster = /^-[A-Za-z]+/.exec(w)?.[0];
    if (cluster) for (let i = 2; i <= cluster.length; i++) out.push(w.slice(i));
  }
  return out;
}

/** The argv a spawn call names, for either form: `(cmd, opts)` or `({ cmd, ...opts })`, each element in its
 *  string form (as the spawn would coerce it). Undefined only when there is no array to judge: a non-string
 *  element must not exempt the call (P1-M1 checkpoint LOW). */
function argvOf(first: unknown): string[] | undefined {
  const cmd = Array.isArray(first) ? first : (first as { cmd?: unknown } | null)?.cmd;
  return Array.isArray(cmd) ? cmd.map((c) => String(c)) : undefined;
}

function guarded<F extends (...a: never[]) => unknown>(which: "Bun.spawn" | "Bun.spawnSync", original: F): F {
  return ((...args: unknown[]) => {
    const argv = argvOf(args[0]);
    const program = argv?.[0];
    const hit = argv?.find((a) => wordsOf(a).some((w) => isGuarded(w)));
    if (program !== undefined && hit !== undefined) {
      if (!optedIn) {
        violations.push(`${which} of ${JSON.stringify(program)}${hit !== program ? " (the tool named inside its argv)" : ""} from a test that did not opt in (test/fixtures/spawn-guard.ts) — refused, so nothing ran:\n${where()}`);
        throw new Error(`spawn guard: ${which} of ${JSON.stringify(program)} refused — this test has not opted in`);
      }
      if (recorder) return recorder(argv!, Array.isArray(args[0]) ? args[1] : args[0]);
    }
    return (original as unknown as (...a: unknown[]) => unknown)(...args);
  }) as unknown as F;
}

/** Install the guard over `Bun.spawn` and `Bun.spawnSync`, BY ASSIGNMENT (not `spyOn`, which a test's
 *  `mock.restore()` would undo). test/preload.ts only, once. */
export function installSpawnGuard(matches: (program: string) => boolean): void {
  if (matcher) throw new Error("spawn guard: already installed (test/preload.ts installs it once)");
  matcher = matches;
  originals = { spawn: Bun.spawn, spawnSync: Bun.spawnSync };
  guards = { spawn: guarded("Bun.spawn", originals.spawn), spawnSync: guarded("Bun.spawnSync", originals.spawnSync) };
  reinstallSpawnGuard();
}

/** Put the guard back (after a test replaced it). */
export function reinstallSpawnGuard(): void {
  if (!guards) return;
  Bun.spawn = guards.spawn;
  Bun.spawnSync = guards.spawnSync;
}

/** Are both entry points still the guard's? A `spyOn` restored by its test puts the guard back, so this
 *  is false only while something replaced them and did not restore. */
export function spawnGuardInstalled(): boolean {
  return guards !== undefined && Bun.spawn === guards.spawn && Bun.spawnSync === guards.spawnSync;
}

/** Would the guard refuse a spawn of `program` (an absolute path or a bare name)? */
export function isGuarded(program: string): boolean {
  return matcher !== undefined && matcher(program);
}

/** Every refusal recorded since the last call, oldest first; the record is emptied. */
export function takeGuardViolations(): string[] {
  return violations.splice(0);
}

/** Let this test's guarded spawns through to the real spawn. From an OPT_IN_FILES file's `beforeEach`. */
export function optInForThisTest(): void {
  optedIn = true;
  recorder = undefined;
}

/** Opt in, and hand this test's guarded spawns to `fn` instead of any real spawn. */
export function useRecorderForThisTest(fn: Recorder): void {
  optedIn = true;
  recorder = fn;
}

/** Is an opt-in set? */
export function spawnOptInSet(): boolean {
  return optedIn;
}

/** Clear the opt-in and the recorder. preload's hooks, after every test. */
export function resetSpawnOptIn(): void {
  optedIn = false;
  recorder = undefined;
}

/** Record a violation found by preload's hooks (an opt-in left over outside a test). */
export function recordGuardViolation(text: string): void {
  violations.push(text);
}

/** The bare identifiers, not a call shape: an aliased import (`{ optInForThisTest as letMe }`) still names one. */
const OPT_IN_CALL = /\b(?:optInForThisTest|useRecorderForThisTest)\b/;

/** The OPT_IN_FILES check over `testDir`: every `.ts` there (outside fixtures/spawn-guard.ts, which defines
 *  the calls) that opts in must be listed in `listed`, and every listed file must exist. A mention in a
 *  comment counts as an opt-in, which errs loud. */
export function optInFileProblems(testDir: string, listed: readonly string[] = OPT_IN_FILES): string[] {
  const problems: string[] = [];
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === "node_modules" ? [] : walk(p)) : n.endsWith(".ts") ? [p] : [];
  });
  for (const abs of walk(testDir)) {
    const rel = relative(testDir, abs);
    if (rel === join("fixtures", "spawn-guard.ts")) continue;
    if (OPT_IN_CALL.test(readFileSync(abs, "utf8")) && !listed.includes(rel)) problems.push(`${rel} opts in to the spawn guard but is not in OPT_IN_FILES (test/fixtures/spawn-guard.ts)`);
  }
  for (const rel of listed) {
    let ok = false;
    try { ok = statSync(join(testDir, rel)).isFile(); } catch { /* missing */ }
    if (!ok) problems.push(`OPT_IN_FILES lists ${rel}, which does not exist`);
  }
  return problems;
}
