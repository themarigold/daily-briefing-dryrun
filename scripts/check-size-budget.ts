#!/usr/bin/env bun
// check-size-budget.ts — the release-time size gate (Phase E, E3), wired by the bundle legs.
//
// Usage: bun scripts/check-size-budget.ts <path> <budget-row>
//   <path>        the built artifact: a file, or for an `app-*` row the `.app` DIRECTORY
//   <budget-row>  a key under `artifacts` in gui/size-budget.json (e.g. dmg-aarch64-apple-darwin)
//
// Why a script and not `cargo test`: gui/src-tauri/tests/packaging.rs re-stats only rows whose
// recorded path exists locally and SKIPS a row whose parent directory is absent, so on CI (where the
// recorded untripled paths are never built) it measures nothing. This reads the same budget against
// the file the leg actually staged, and never skips: an unknown row or a missing path FAILS.
//
// Size: a file's byte length; for an `.app` directory, the sum of regular-file bytes in its tree,
// symlinks counted as zero — the budget file's own definition, and packaging.rs `artifact_bytes`.
// Checks, per row:
//   - budgetBytes non-null  -> size must be <= budgetBytes (the ceiling);
//   - measuredBytes non-null -> SYMMETRIC 20% drift: neither size may exceed the other by more than
//     20% (the B23 pin; an inflated baseline disarms the gate as surely as a grown artifact). The
//     predicate is packaging.rs `is_size_regression`, copied exactly: exceeded when a*100 > b*120;
//   - both null -> passes on existence alone, and says so.
// Exit 0 = pass, 1 = fail (including usage errors), always with one line per check on stdout/stderr.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface BudgetRow {
  budgetBytes: number | null;
  measuredBytes: number | null;
  path?: string | null;
}

/** packaging.rs `is_size_regression`, verbatim in meaning: `current` exceeds `measured` by MORE
 *  than 20%. Integer arithmetic in BigInt so no float rounding can move the boundary. */
export function isSizeRegression(measured: number, current: number): boolean {
  return BigInt(current) * 100n > BigInt(measured) * 120n;
}

/** Bytes of a file, or the sum of regular-file bytes under a directory (symlinks count as zero,
 *  as in packaging.rs `artifact_bytes`). Throws if the path cannot be statted. */
export function artifactBytes(path: string): number {
  const st = lstatSync(path);
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const name of readdirSync(path)) {
    const p = join(path, name);
    const m = lstatSync(p);
    if (m.isFile()) total += m.size;
    else if (m.isDirectory()) total += artifactBytes(p);
  }
  return total;
}

export interface Verdict { ok: boolean; lines: string[] }

/** Judge `path` against `rowName` in a parsed budget. Pure apart from reading the path. */
export function checkSize(budget: unknown, rowName: string, path: string): Verdict {
  const lines: string[] = [];
  const fail = (msg: string): Verdict => ({ ok: false, lines: [...lines, `FAIL: ${msg}`] });
  const artifacts = (budget as { artifacts?: Record<string, BudgetRow> } | null)?.artifacts;
  if (artifacts === null || typeof artifacts !== "object") return fail("size budget has no `artifacts` table");
  if (!Object.prototype.hasOwnProperty.call(artifacts, rowName)) {
    return fail(`unknown budget row '${rowName}' (known: ${Object.keys(artifacts).join(", ")})`);
  }
  const row = artifacts[rowName]!;
  const { budgetBytes, measuredBytes } = row;
  for (const [k, v] of [["budgetBytes", budgetBytes], ["measuredBytes", measuredBytes]] as const) {
    if (v !== null && !(typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) {
      return fail(`row '${rowName}' has a malformed ${k}: ${JSON.stringify(v)}`);
    }
  }

  let st;
  try { st = lstatSync(path); } catch { return fail(`${rowName}: path '${path}' does not exist`); }
  const wantDir = rowName.startsWith("app-");
  if (wantDir && !st.isDirectory()) return fail(`${rowName}: an app row measures a .app DIRECTORY, and '${path}' is not one`);
  if (!wantDir && !st.isFile()) return fail(`${rowName}: '${path}' is not a regular file`);

  const size = artifactBytes(path);
  lines.push(`${rowName}: ${path} = ${size} bytes${wantDir ? " (sum of regular files in the tree)" : ""}`);
  let ok = true;

  if (budgetBytes === null) {
    lines.push("  ceiling: none (budgetBytes null)");
  } else if (size > budgetBytes) {
    ok = false;
    lines.push(`FAIL: ceiling: ${size} > budgetBytes ${budgetBytes}`);
  } else {
    lines.push(`  ceiling: ok (${size} <= ${budgetBytes})`);
  }

  if (measuredBytes === null) {
    lines.push("  drift: not checked (measuredBytes null — this row is unmeasured)");
  } else if (isSizeRegression(measuredBytes, size)) {
    ok = false;
    lines.push(`FAIL: drift: ${size} is more than 20% above the recorded ${measuredBytes} — shrink the artifact or re-measure deliberately`);
  } else if (isSizeRegression(size, measuredBytes)) {
    ok = false;
    lines.push(`FAIL: drift: the recorded ${measuredBytes} is more than 20% above ${size} — an inflated baseline disarms the gate; re-measure honestly`);
  } else {
    lines.push(`  drift: ok (within 20% of the recorded ${measuredBytes})`);
  }

  if (budgetBytes === null && measuredBytes === null) {
    lines.push("  both budgetBytes and measuredBytes are null: passes on existence alone");
  }
  return { ok, lines };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error("usage: bun scripts/check-size-budget.ts <path> <budget-row>");
    process.exit(1);
  }
  const [path, row] = args as [string, string];
  const budgetPath = resolve(import.meta.dir, "../gui/size-budget.json");
  let budget: unknown;
  try {
    budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  } catch (e) {
    console.error(`FAIL: cannot read ${budgetPath}: ${(e as Error).message}`);
    process.exit(1);
  }
  const v = checkSize(budget, row, path);
  for (const l of v.lines) (l.startsWith("FAIL") ? console.error : console.log)(l);
  console.log(v.ok ? `size gate: PASS (${row})` : `size gate: FAIL (${row})`);
  process.exit(v.ok ? 0 : 1);
}
