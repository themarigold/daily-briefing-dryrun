// test/check-size-budget.test.ts — scripts/check-size-budget.ts (Phase E, E3): the release-time size
// gate the bundle legs run against the files they staged.
//
// The predicate is a SECOND copy of gui/src-tauri/tests/packaging.rs `is_size_regression` (Rust and
// TypeScript cannot share one), so its boundary rows below are packaging.rs's own
// (`the_regression_predicate_turns_exactly_past_twenty_percent`), copied value for value: if either
// copy moves, one of the two suites goes red.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { artifactBytes, checkSize, isSizeRegression } from "../scripts/check-size-budget";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "check-size-budget.ts");

const scratch = () => removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-sizegate-")));
/** A file of exactly `bytes` bytes (sparse: no disk cost even at release sizes). */
function sized(dir: string, name: string, bytes: number): string {
  const p = join(dir, name);
  writeFileSync(p, "");
  truncateSync(p, bytes);
  return p;
}

const budget = (row: { budgetBytes: number | null; measuredBytes: number | null }) => ({
  artifacts: { "dmg-test": { ...row, path: "x" }, "app-test": { ...row, path: "x" } },
});

describe("isSizeRegression — packaging.rs's boundary rows", () => {
  test("exactly +20% is not a regression; one byte past it is; shrinking never is", () => {
    expect(isSizeRegression(100, 120)).toBe(false);
    expect(isSizeRegression(100, 121)).toBe(true);
    expect(isSizeRegression(61_810_018, 74_172_021)).toBe(false);
    expect(isSizeRegression(61_810_018, 74_172_022)).toBe(true);
    expect(isSizeRegression(100, 80)).toBe(false);
  });
});

describe("artifactBytes", () => {
  test("a file is its length; a directory is the sum of regular files in its tree, symlinks zero", () => {
    const d = scratch();
    expect(artifactBytes(sized(d, "f", 1234))).toBe(1234);
    const app = join(d, "X.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    sized(join(app, "Contents", "MacOS"), "bin", 1000);
    sized(join(app, "Contents"), "Info.plist", 200);
    sized(app, "top", 30);
    symlinkSync(join(d, "f"), join(app, "Contents", "link"));     // would add 1234 if followed
    expect(artifactBytes(app)).toBe(1230);
  });
});

describe("checkSize", () => {
  test("ceiling only (measuredBytes null): under passes, at passes, over fails; drift not checked", () => {
    const d = scratch();
    const b = budget({ budgetBytes: 1000, measuredBytes: null });
    expect(checkSize(b, "dmg-test", sized(d, "a", 999)).ok).toBe(true);
    const at = checkSize(b, "dmg-test", sized(d, "b", 1000));
    expect(at.ok).toBe(true);
    expect(at.lines.join("\n")).toMatch(/drift: not checked/);
    const over = checkSize(b, "dmg-test", sized(d, "c", 1001));
    expect(over.ok).toBe(false);
    expect(over.lines.join("\n")).toMatch(/FAIL: ceiling: 1001 > budgetBytes 1000/);
  });

  test("measured only (budgetBytes null): symmetric 20% drift, both directions", () => {
    const d = scratch();
    const b = budget({ budgetBytes: null, measuredBytes: 1000 });
    expect(checkSize(b, "dmg-test", sized(d, "a", 1200)).ok).toBe(true);
    expect(checkSize(b, "dmg-test", sized(d, "b", 834)).ok).toBe(true);      // 1000*100 <= 834*120
    const grown = checkSize(b, "dmg-test", sized(d, "c", 1201));
    expect(grown.ok).toBe(false);
    expect(grown.lines.join("\n")).toMatch(/more than 20% above the recorded 1000/);
    const inflated = checkSize(b, "dmg-test", sized(d, "e", 833));            // 1000*100 > 833*120
    expect(inflated.ok).toBe(false);
    expect(inflated.lines.join("\n")).toMatch(/inflated baseline/);
  });

  test("both set: each check bites on its own", () => {
    const d = scratch();
    const b = budget({ budgetBytes: 1100, measuredBytes: 1000 });
    expect(checkSize(b, "dmg-test", sized(d, "a", 1050)).ok).toBe(true);
    expect(checkSize(b, "dmg-test", sized(d, "b", 1150)).ok).toBe(false);    // over ceiling, within drift
    expect(checkSize(b, "dmg-test", sized(d, "c", 500)).ok).toBe(false);     // under ceiling, drifted
  });

  test("both null: passes on existence alone, and says so", () => {
    const d = scratch();
    const v = checkSize(budget({ budgetBytes: null, measuredBytes: null }), "dmg-test", sized(d, "a", 5));
    expect(v.ok).toBe(true);
    expect(v.lines.join("\n")).toMatch(/passes on existence alone/);
  });

  test("an app row measures a directory, a file row a regular file — the wrong kind fails", () => {
    const d = scratch();
    const b = budget({ budgetBytes: null, measuredBytes: null });
    const app = join(d, "A.app");
    mkdirSync(app);
    sized(app, "x", 10);
    expect(checkSize(b, "app-test", app).ok).toBe(true);
    expect(checkSize(b, "app-test", sized(d, "f", 10)).ok).toBe(false);
    expect(checkSize(b, "dmg-test", app).ok).toBe(false);
  });

  test("an unknown row, a missing path, a malformed row: FAIL, never skip", () => {
    const d = scratch();
    const b = budget({ budgetBytes: 10, measuredBytes: null });
    const unknown = checkSize(b, "dmg-nope", sized(d, "a", 1));
    expect(unknown.ok).toBe(false);
    expect(unknown.lines.join("\n")).toMatch(/unknown budget row 'dmg-nope'/);
    const missing = checkSize(b, "dmg-test", join(d, "absent.dmg"));
    expect(missing.ok).toBe(false);
    expect(missing.lines.join("\n")).toMatch(/does not exist/);
    expect(checkSize({ artifacts: { "dmg-test": { budgetBytes: "1", measuredBytes: null } } }, "dmg-test", sized(d, "b", 1)).ok).toBe(false);
    expect(checkSize({}, "dmg-test", sized(d, "c", 1)).ok).toBe(false);
    expect(checkSize(b, "toString", sized(d, "e", 1)).ok).toBe(false);       // no prototype keys as rows
  });
});

describe("the CLI against the real gui/size-budget.json", () => {
  const real = JSON.parse(readFileSync(join(ROOT, "gui", "size-budget.json"), "utf8")) as {
    artifacts: Record<string, { budgetBytes: number | null; measuredBytes: number | null }>;
  };
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["bun", SCRIPT, ...args], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  test("a row with a ceiling: its recorded size passes, one byte over the ceiling fails", () => {
    const [name, row] = Object.entries(real.artifacts).find(([k, r]) => !k.startsWith("app-") && r.budgetBytes !== null)!;
    const d = scratch();
    const target = row.measuredBytes ?? row.budgetBytes!;
    const okSize = Math.min(row.budgetBytes!, target);
    expect(run(sized(d, "ok", okSize), name)).toMatchObject({ code: 0 });
    const over = run(sized(d, "over", row.budgetBytes! + 1), name);
    expect(over.code).toBe(1);
    expect(over.out).toMatch(/FAIL: ceiling/);
  });

  test("an unknown row and a missing path exit 1; wrong arity exits 1", () => {
    const d = scratch();
    expect(run(sized(d, "a", 1), "no-such-row").code).toBe(1);
    const firstRow = Object.keys(real.artifacts).find((k) => !k.startsWith("app-"))!;
    expect(run(join(d, "absent"), firstRow).code).toBe(1);
    expect(run(sized(d, "b", 1)).code).toBe(1);
  });
});
