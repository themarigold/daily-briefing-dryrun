// test/eval-cleanup.test.ts — the gold eval CLI drains its registered temp dirs on exit (user-directed
// one-off edit to scripts/eval.ts, 2026-10-19), and that cleanup can never change the CLI's exit code.
//
// The CLI itself is not run here: it calls a live provider. So the hook is CUT OUT of scripts/eval.ts's own source
// and run in a child process: the child runs eval.ts's real hook text, not a copy of it. Test 1 pins where the hook
// sits and what it may not touch; tests 2 and 3 run it, with a drain that succeeds and with one that fails.
// Not covered, by design: termination by a signal, where the "exit" event does not fire (scripts/eval.ts says so).
import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const ROOT = join(import.meta.dir, "..");
const SRC = readFileSync(join(ROOT, "scripts/eval.ts"), "utf8");
const HOOK_START = '  process.on("exit", () => {\n';
const HOOK_END = "\n  });\n";

/** eval.ts's exit hook, exactly as written there: from `process.on("exit"` to the first `  });` closing it. */
function hookSource(): string {
  const start = SRC.indexOf(HOOK_START);
  expect(start).toBeGreaterThan(-1);
  expect(SRC.indexOf(HOOK_START, start + 1)).toBe(-1);
  const end = SRC.indexOf(HOOK_END, start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end + HOOK_END.length);
}

/** Run eval.ts's hook in a child with TMPDIR `tmp`: it registers a `dba-eval-repo-` dir (as run-case does), records
 *  the dir's path in `made`, runs `before` (a statement, given the dir as `dir`), then exits 1. */
function runHook(tmp: string, made: string, before = "") {
  const script = [
    'import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { tmpdir } from "node:os";',
    `import { removeAtRunEnd, removeRegisteredTempDirs } from ${JSON.stringify(join(ROOT, "test/fixtures/temp-dirs.ts"))};`,
    hookSource(),
    'const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-eval-repo-")));',
    'writeFileSync(join(dir, "file"), "x");',
    `writeFileSync(${JSON.stringify(made)}, dir);`,
    before,
    "process.exit(1);",
  ].join("\n");
  return Bun.spawnSync(["bun", "-e", script], { env: { ...process.env, TMPDIR: tmp }, stdout: "pipe", stderr: "pipe" });
}

test("scripts/eval.ts registers the exit hook first in main(), and the hook only drains and warns", () => {
  expect(SRC).toContain('import { removeRegisteredTempDirs } from "../test/fixtures/temp-dirs";');
  // The whole hook, pinned: a drain in a try, and a catch that only warns.
  expect(hookSource()).toBe(
    '  process.on("exit", () => {\n    try {\n      removeRegisteredTempDirs();\n    } catch (e) {\n' +
    "      console.error(`eval: temp-dir cleanup: ${e instanceof Error ? e.message : String(e)}`);\n    }\n  });\n",
  );
  // Registered before any case runs: the first statement of main(), after its comment.
  expect(SRC).toMatch(/async function main\(\) \{\n(?:  \/\/[^\n]*\n)+  process\.on\("exit"/);
});

test("eval.ts's hook, in a child that exits 1, removes a registered dir and keeps the exit code", () => {
  const box = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-evalclean-")));
  const made = join(box, "made");
  const child = runHook(box, made);
  expect(child.exitCode).toBe(1);
  const dir = readFileSync(made, "utf8");
  expect(dir.startsWith(box)).toBe(true);
  expect(existsSync(dir)).toBe(false);
  expect(child.stderr.toString()).not.toContain("temp-dir cleanup");
});

test("eval.ts's hook, when the drain fails, warns on stderr and still keeps the exit code", () => {
  const box = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-evalclean-")));
  const tmp = join(box, "ro");
  mkdirSync(tmp);
  const made = join(box, "made");
  // The registered dir's parent made read-only before exit: the dir cannot be unlinked, so the drain throws.
  const child = runHook(tmp, made, `chmodSync(${JSON.stringify(tmp)}, 0o500);`);
  try {
    expect(child.exitCode).toBe(1);
    const dir = readFileSync(made, "utf8");
    expect(existsSync(dir)).toBe(true);
    expect(child.stderr.toString()).toContain("eval: temp-dir cleanup: could not remove 1 temp dir(s)");
  } finally {
    chmodSync(tmp, 0o700);
  }
});
