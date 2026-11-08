// test/preload.guard.test.ts — the run-wide spawn guard (test/preload.ts + test/fixtures/spawn-guard.ts;
// provider-fallback plan P1-M1-T2).
//
// ⚠ THIS FILE HOLDS NO LITERAL NAMING THE KEYCHAIN TOOL, and must not: the never-reach scanner
// (test/isolation.meta.test.ts) reads this file and the helpers it imports, but never src/, so every program
// name here is built at runtime from `SECURITY_BIN` (src/appKeyNames.ts). And every spawn this file lets
// reach a real `Bun.spawn` names the LOOK-ALIKE `/nonexistent/bin/<basename>`, so a broken guard or recorder
// hits ENOENT and spawns nothing. The absolute path and the bare name are checked through the matcher only.
//
// This file is in OPT_IN_FILES. Each test that triggers a refusal reads and clears its own record, so
// preload's `afterEach` stays green. The hook-order cases (a record left by a file's `afterAll`, an opt-in
// left set, a replaced guard) can only be seen from outside the process, so they run a child `bun test`
// with this package's preload over fixture files in a temp folder.
import "./fixtures/isolate-state";
import { test, expect, describe, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import {
  OPT_IN_FILES, isGuarded, optInFileProblems, optInForThisTest, spawnGuardInstalled, takeGuardViolations, useRecorderForThisTest,
} from "./fixtures/spawn-guard";
import { SECURITY_BIN } from "../src/appKeyNames";
import { run } from "../src/proc";

const TEST_DIR = new URL("./", import.meta.url).pathname;
const BARE = basename(SECURITY_BIN);
const LOOK = "/nonexistent/bin/" + BARE;
/** Stands for a key on a Keychain argv: a refusal record must never carry it. */
const KEY = "ZZKEYSENTINEL0000";

const REFUSED = /spawn guard: Bun\.spawn(?:Sync)? of .* refused/;

describe("the matcher", () => {
  test("matches the tool by absolute path and by basename, and nothing else", () => {
    expect(isGuarded(SECURITY_BIN)).toBe(true);
    expect(isGuarded(BARE)).toBe(true);
    expect(isGuarded(LOOK)).toBe(true);
    // The volume is case-insensitive (APFS default): another casing names the same inode (checkpoint MED).
    const upper = BARE.toUpperCase(), title = BARE[0]!.toUpperCase() + BARE.slice(1);
    for (const variant of [SECURITY_BIN.replace(BARE, title), SECURITY_BIN.replace(BARE, upper), upper, title, "/nonexistent/bin/" + upper]) {
      expect(`${variant} → ${isGuarded(variant)}`).toBe(`${variant} → true`);
    }
    for (const other of ["/usr/bin/git", "git", SECURITY_BIN + "-helper", "in" + BARE, "/opt/" + BARE + "d", process.execPath]) {
      expect(`${other} → ${isGuarded(other)}`).toBe(`${other} → false`);
    }
  });

  test("the guard is installed over both entry points", () => {
    expect(spawnGuardInstalled()).toBe(true);
  });
});

describe("a test that has not opted in", () => {
  const forms: [string, () => unknown][] = [
    ["Bun.spawn, array form", () => Bun.spawn([LOOK, "add-generic-password", "-w", KEY])],
    ["Bun.spawn, object form", () => Bun.spawn({ cmd: [LOOK, "add-generic-password", "-w", KEY] })],
    ["Bun.spawnSync, array form", () => Bun.spawnSync([LOOK, "add-generic-password", "-w", KEY])],
    ["Bun.spawnSync, object form", () => Bun.spawnSync({ cmd: [LOOK, "add-generic-password", "-w", KEY] })],
  ];
  for (const [name, spawn] of forms) {
    test(`${name}: refused (not ENOENT), and recorded with the program but not the rest of the argv`, () => {
      expect(spawn).toThrow(REFUSED);
      const seen = takeGuardViolations();
      expect(seen.length).toBe(1);
      expect(seen[0]).toContain(JSON.stringify(LOOK));
      expect(seen[0]).toContain("did not opt in");
      expect(seen[0]).not.toContain(KEY);
    });
  }

  test("a non-string argv[0] is judged by its string form, and a non-string later argument does not exempt the call", () => {
    // P1-M1 checkpoint LOW: requiring EVERY element to be a string let `[LOOK, 1]` through unjudged.
    expect(() => Bun.spawnSync([LOOK, 1 as unknown as string])).toThrow(REFUSED);
    expect(() => Bun.spawnSync([{ toString: () => LOOK } as unknown as string])).toThrow(REFUSED);
    expect(() => Bun.spawn({ cmd: [LOOK, 2 as unknown as string] })).toThrow(REFUSED);
    expect(takeGuardViolations().length).toBe(3);
  });

  test("a WRAPPER is refused too: the tool anywhere in the argv, or as a word inside a shell string (codex review HIGH)", () => {
    // Every case names the look-alike only: if the guard missed one, the wrapper would hit ENOENT, never the tool.
    const wrapped: string[][] = [
      ["/usr/bin/env", LOOK, "find-generic-password", "-w"],
      ["/nonexistent/bin/env", LOOK],
      ["/nonexistent/bin/sh", "-c", `${LOOK} find-generic-password -s x -w`],
      ["/nonexistent/bin/sh", "-c", `k=$(${LOOK} find-generic-password -w); echo $k`],
      ["/nonexistent/bin/sh", "-c", `true;${BARE} -h`],
      ["/nonexistent/bin/xcrun", BARE, "find-identity"],
      ["/nonexistent/bin/arch", "-arm64", LOOK.toUpperCase()],
      // `env -S` joined to its value, and a value with spaces after it (codex HIGH): a leading option cluster is
      // stripped before the word is judged.
      ["/usr/bin/env", `-S${LOOK} find-generic-password -w`],
      ["/usr/bin/env", "-S", `${LOOK} find-generic-password -w`],
      ["/usr/bin/env", `-iS${BARE}`],
      // PR 1 final review round 3 L2: a backslash-newline is a line continuation, so the name split across one is
      // still the tool (the shared tokenizer, `shellWords`, removes it before the split).
      ["/nonexistent/bin/sh", "-c", `${LOOK.slice(0, -3)}\\\n${LOOK.slice(-3)} -h`],
    ];
    for (const argv of wrapped) {
      expect(() => Bun.spawnSync(argv)).toThrow(REFUSED);
    }
    expect(takeGuardViolations().length).toBe(wrapped.length);
    // …while an argument that merely CONTAINS the word is not the tool.
    expect(() => Bun.spawnSync(["/nonexistent/bin/env", "insecurity", `${BARE}-helper`, "com.apple.security.app-sandbox"])).toThrow(/ENOENT/);
    expect(takeGuardViolations()).toEqual([]);
  });

  test("a spawn that proc.run swallows into `spawned: false` is still recorded", async () => {
    const r = await run([LOOK, "find-generic-password", "-w", KEY]);
    expect(r.spawned).toBe(false);
    expect(r.err).toMatch(REFUSED);
    const seen = takeGuardViolations();
    expect(seen.length).toBe(1);
    expect(seen[0]).not.toContain(KEY);
  });

  test("an unguarded program passes straight through", () => {
    const r = Bun.spawnSync([process.execPath, "--version"]);
    expect(r.success).toBe(true);
    expect(takeGuardViolations()).toEqual([]);
  });
});

describe("opted in with a recorder (set in beforeEach)", () => {
  const calls: { argv: string[]; opts: unknown }[] = [];
  const MARK = { recorded: true };
  beforeEach(() => {
    calls.length = 0;
    useRecorderForThisTest((argv, opts) => { calls.push({ argv, opts }); return MARK; });
  });

  test("every form goes to the recorder, never a real spawn", () => {
    expect(Bun.spawn([LOOK, "a"], { stdout: "pipe" }) as unknown).toBe(MARK);
    expect(Bun.spawn({ cmd: [LOOK, "b"] }) as unknown).toBe(MARK);
    expect(Bun.spawnSync([LOOK, "c"]) as unknown).toBe(MARK);
    expect(Bun.spawnSync({ cmd: [LOOK, "d"] }) as unknown).toBe(MARK);
    expect(calls.map((c) => c.argv)).toEqual([[LOOK, "a"], [LOOK, "b"], [LOOK, "c"], [LOOK, "d"]]);
    expect(calls[0]!.opts).toEqual({ stdout: "pipe" });
    expect(takeGuardViolations()).toEqual([]);
  });
});

describe("opted in without a recorder", () => {
  beforeEach(() => optInForThisTest());

  test("the call reaches the real spawn (the look-alike: ENOENT, nothing runs), unrecorded", () => {
    expect(() => Bun.spawnSync([LOOK])).toThrow(/ENOENT/);
    expect(() => Bun.spawnSync([LOOK])).not.toThrow(REFUSED);
    expect(takeGuardViolations()).toEqual([]);
  });
});

describe("the opt-in is per test", () => {
  test("(1 of 2) opts in, in the test body", () => {
    optInForThisTest();
    expect(() => Bun.spawnSync([LOOK])).toThrow(/ENOENT/);
  });

  test("(2 of 2) the next test is refused again: preload's afterEach cleared it", () => {
    expect(() => Bun.spawnSync([LOOK])).toThrow(REFUSED);
    expect(takeGuardViolations().length).toBe(1);
  });
});

describe("OPT_IN_FILES", () => {
  test("ships this file alone, and the suite matches it", () => {
    expect([...OPT_IN_FILES]).toEqual(["preload.guard.test.ts"]);
    expect(optInFileProblems(TEST_DIR)).toEqual([]);
  });

  test("the check fails for an unlisted file that opts in, and for a listed file that does not exist", () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-optin-")));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "listed.test.ts"), "beforeEach(() => optInForThisTest());\n");
    writeFileSync(join(dir, "sub", "rogue.test.ts"), "beforeEach(() => useRecorderForThisTest(() => 0));\n");
    writeFileSync(join(dir, "quiet.test.ts"), "test('x', () => {});\n");
    // An aliased import opts in under another name: the bare identifier is what counts (checkpoint LOW).
    writeFileSync(join(dir, "alias.test.ts"), "import { optInForThisTest as letMe } from './fixtures/spawn-guard';\nbeforeEach(() => letMe());\n");
    const unlisted = (rel: string) => `${rel} opts in to the spawn guard but is not in OPT_IN_FILES (test/fixtures/spawn-guard.ts)`;
    expect(optInFileProblems(dir, ["listed.test.ts"]).sort()).toEqual([unlisted("alias.test.ts"), unlisted(join("sub", "rogue.test.ts"))].sort());
    expect(optInFileProblems(dir, ["listed.test.ts", "alias.test.ts", join("sub", "rogue.test.ts"), "gone.test.ts"])).toEqual(["OPT_IN_FILES lists gone.test.ts, which does not exist"]);
  });
});

// ── preload's hooks, seen from a child run ───────────────────────────────────────────────────────────

const PRELOAD = resolve(TEST_DIR, "preload.ts");
const GUARD = resolve(TEST_DIR, "fixtures", "spawn-guard.ts");

/** Run `files` (name → source) as a child `bun test` with this package's preload, from a temp folder (so no
 *  bunfig is read), in the order given. The child's output goes to stderr; both streams are returned. */
function childRun(files: Record<string, string>): { code: number; out: string } {
  const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-guard-child-")));
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
  const r = Bun.spawnSync([process.execPath, "test", "--preload", PRELOAD, ...Object.keys(files).map((n) => `./${n}`)], {
    cwd: dir, env: { ...process.env }, stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString() };
}

const header = `import { test, expect, afterAll } from "bun:test";
import { optInForThisTest, takeGuardViolations } from ${JSON.stringify(GUARD)};
const LOOK = ${JSON.stringify(LOOK)};
const refuse = () => { try { Bun.spawnSync([LOOK]); } catch { /* refused and recorded */ } };
void optInForThisTest; void takeGuardViolations; void expect;
`;

describe("preload's hooks (child bun test)", () => {
  test("a record left by a file's afterAll fails the NEXT file's first test, and the last file's fails preload's afterAll", () => {
    const r = childRun({
      "a.test.ts": `${header}test("a-first", () => {});\nafterAll(refuse);\n`,
      "b.test.ts": `${header}test("b-first", () => {});\ntest("b-second", () => {});\nafterAll(refuse);\n`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("(fail) b-first");
    expect(r.out).not.toContain("(fail) a-first");
    expect(r.out).not.toContain("(fail) b-second");
    expect(r.out).toContain("(fail) (unnamed)");
    expect(r.out.split("did not opt in").length - 1).toBeGreaterThanOrEqual(2);
    expect(r.out).toMatch(/ 2 pass\n/);
    expect(r.out).toMatch(/ 2 fail\n/);
  }, 30_000);

  test("an opt-in left set outside a test fails the next test, and preload's afterAll for the last file", () => {
    const r = childRun({
      "c.test.ts": `${header}test("c-first", () => {});\nafterAll(() => optInForThisTest());\n`,
      "d.test.ts": `${header}test("d-first", () => {});\ntest("d-second", () => {});\nafterAll(() => optInForThisTest());\n`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("(fail) d-first");
    expect(r.out).not.toContain("(fail) c-first");
    expect(r.out).not.toContain("(fail) d-second");
    expect(r.out).toContain("(fail) (unnamed)");
    expect(r.out).toContain("opt-in was set outside a test");
    expect(r.out).toContain("opt-in was left set after the last test");
  }, 30_000);

  test("replacing either installed entry point turns preload's afterEach red, and the guard is put back", () => {
    const r = childRun({
      "e.test.ts": `${header}test("e-replaces-sync", () => { Bun.spawnSync = (() => { throw new Error("replaced"); }) as any; });
test("e-after-sync", () => { refuse(); expect(takeGuardViolations().length).toBe(1); });
test("e-replaces-spawn", () => { Bun.spawn = (() => { throw new Error("replaced"); }) as any; });
test("e-after-spawn", () => { expect(() => Bun.spawn([LOOK])).toThrow(/spawn guard/); expect(takeGuardViolations().length).toBe(1); });
`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("(fail) e-replaces-sync");
    expect(r.out).toContain("(fail) e-replaces-spawn");
    expect(r.out).not.toContain("(fail) e-after-sync");
    expect(r.out).not.toContain("(fail) e-after-spawn");
    expect(r.out.split("no longer the spawn guard").length - 1).toBe(2);
    expect(r.out).toMatch(/ 2 pass\n/);
  }, 30_000);

  test("a clean child run stays green (the cases above are not failing for some other reason)", () => {
    const r = childRun({ "f.test.ts": `${header}test("f-only", () => { refuse(); expect(takeGuardViolations().length).toBe(1); });\n` });
    expect(r.out).toMatch(/ 1 pass\n/);
    expect(r.code).toBe(0);
  }, 30_000);
});
