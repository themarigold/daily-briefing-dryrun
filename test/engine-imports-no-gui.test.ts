// test/engine-imports-no-gui.test.ts — no engine file (src/, test/, scripts/) imports GUI code statically.
// CI type-checks the engine (`bunx tsc --noEmit` in daily_briefing_application/) BEFORE it installs the GUI's
// packages, and the GUI's module graph reaches `@tauri-apps/api`. A static import of gui/ code from an engine file
// therefore passes on a machine where gui/node_modules exists and fails on CI (measured 2026-10-29, PR #673's
// first run). A test that needs a GUI model loads it at run time by path (see test/calendar-details.verb.test.ts).
// The file is parsed by TypeScript and its module declarations are read, so comments, strings and regex literals
// never count, and every static form does: `import`, `import type`, side-effect `import "…"`, `export … from`,
// `export * as X from`, `import x = require("…")`, an `import("…")` type, and a literal `import("…")` or
// `require("…")` call, compact or multi-line. Only a computed run-time specifier is allowed.
import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");
const scratchDir = (): string => removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-gui-trace-")));
const GUI = join(ROOT, "gui") + sep;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(p);
  }
  return out;
}

/** The relative specifiers of `text`'s static imports and re-exports that resolve, from `file`, into gui/. */
function guiImports(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const specs: string[] = [];
  const literal = (n: ts.Node | undefined): void => {
    if (n !== undefined && ts.isStringLiteralLike(n)) specs.push(n.text);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) literal(n.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) literal(n.moduleReference.expression);
    // `import("…").T` in a type: tsc loads that module's types.
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) literal(n.argument.literal);
    // `import("…")` and `require("…")` with a literal: tsc follows those too. A computed specifier (a path built
    // at run time) is not followed, and is how a test loads GUI code on purpose.
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) literal(n.arguments[0]);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return specs.filter((s) => s.startsWith(".") && (resolve(dirname(file), s) + sep).startsWith(GUI));
}

test("premise: the scanner sees every static form and ignores comments, strings and run-time loads", () => {
  const f = join(ROOT, "test", "x.test.ts");
  const hits = (text: string): number => guiImports(f, text).length;
  expect(hits(`import { a } from "../gui/src/lib/x";`)).toBe(1);
  expect(hits(`import type { A } from "../gui/src/lib/x";`)).toBe(1);
  expect(hits(`import{a}from"../gui/x"`)).toBe(1);
  expect(hits(`import"../gui/x"`)).toBe(1);
  expect(hits(`import { a } from /* c */ "../gui/x";`)).toBe(1);
  expect(hits(`import {\n  a,\n  b,\n} from "../gui/src/lib/x";`)).toBe(1);
  expect(hits(`export { a } from "../gui/src/lib/x";`)).toBe(1);
  expect(hits(`export * from "../gui/src/lib/x";`)).toBe(1);
  expect(hits(`export * as Gui from "../gui/src/lib/x";`)).toBe(1);
  expect(hits(`import x = require("../gui/src/lib/x");`)).toBe(1);
  expect(hits(`const r = /import "..\\/gui\\/x"/;`)).toBe(0);
  expect(hits(`type E = import("../gui/src/lib/x").LiveEvent;`)).toBe(1);
  expect(hits(`async function f() { const m = await import("../gui/src/lib/x"); }`)).toBe(1);
  expect(hits(`const m = require("../gui/src/lib/x");`)).toBe(1);
  expect(hits(`// imported from "../gui/x"`)).toBe(0);
  expect(hits("const s = `import { a } from \"../gui/x\";`;")).toBe(0);
  expect(hits(`await import(join(ROOT, "gui/src/lib/x.ts"));`)).toBe(0);
  expect(hits(`import { b } from "../src/gui-words";`)).toBe(0);
  expect(hits(`import { c } from "./gui/x";`)).toBe(0);   // test/gui/, not the package's gui/
});

test("no engine file imports gui/ code statically", () => {
  const files = ["src", "test", "scripts"].flatMap((d) => tsFiles(join(ROOT, d)));
  expect(files.length).toBeGreaterThan(100);
  const hits = files.flatMap((f) => guiImports(f, readFileSync(f, "utf8")).map((s) => `${relative(ROOT, f)}: ${s}`));
  expect(hits).toEqual([]);
});

// ── a GUI module an engine test loads at run time must not reach a GUI package ──────────────────────────────────
// CI runs the engine's `bun test` before it installs the GUI's packages too, so a GUI module loaded by path must not
// import `@tauri-apps/*` (or any other package) at run time, through any chain of relative imports. PR #674's first
// run failed this way: calendar-detail.ts → deck.ts → git-detail.ts → settings-model.ts → engine.ts → @tauri-apps.
// Locally gui/node_modules exists, so only this static trace shows it before CI does.
/** The GUI modules engine tests load at run time (by path). Add a module here when a test starts loading it. */
const RUNTIME_GUI_MODULES = ["gui/src/lib/calendar-detail.ts", "gui/src/lib/run-result.ts"];

/** The run-time import edges of one module: `import type` and `export type` are erased; with the GUI's
 *  `verbatimModuleSyntax`, `import { type A }` is NOT (it keeps a side-effect import), so it counts. */
function runtimeSpecifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
  const out: string[] = [];
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && !s.importClause?.isTypeOnly) out.push(s.moduleSpecifier.text);
    if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) && !s.isTypeOnly) out.push(s.moduleSpecifier.text);
  }
  // A literal `import("…")` anywhere in the module is a run-time edge too.
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] !== undefined
      && ts.isStringLiteralLike(n.arguments[0])) out.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function resolveModule(from: string, spec: string): string | null {
  // Bun resolves `./x.js` to `./x.ts` when only the .ts exists, as TypeScript does.
  const asTs = spec.endsWith(".js") ? [`${spec.slice(0, -3)}.ts`] : [];
  for (const c of [...asTs, `${spec}.ts`, spec, join(spec, "index.ts")]) {
    const p = resolve(dirname(from), c);
    try { if (statSync(p).isFile()) return p; } catch { /* not this candidate */ }
  }
  return null;
}

/** Every package import reachable at run time from `start`, each with the chain that reaches it. */
function packagesReached(start: string): string[] {
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  const found: string[] = [];
  const chain = (f: string): string => {
    const names: string[] = [];
    for (let c: string | null = f; c !== null; c = parent.get(c) ?? null) names.unshift(relative(ROOT, c));
    return names.join(" → ");
  };
  while (queue.length > 0) {
    const f = queue.shift()!;
    for (const spec of runtimeSpecifiers(f)) {
      if (!spec.startsWith(".")) { found.push(`${chain(f)} → ${spec}`); continue; }
      const p = resolveModule(f, spec);
      if (p === null) { found.push(`${chain(f)} → ${spec} (unresolved)`); continue; }
      // Only TypeScript modules are traced; any other file (a .js, a .svelte) is reported, never skipped silently.
      if (!p.endsWith(".ts")) { found.push(`${chain(f)} → ${spec} (not a .ts module; cannot trace)`); continue; }
      if (!parent.has(p)) { parent.set(p, f); queue.push(p); }
    }
  }
  return found;
}

test("premise: the run-time trace finds a package import through a chain, and skips type-only imports", () => {
  const dir = scratchDir();
  writeFileSync(join(dir, "a.ts"), `import type { T } from "./t";\nimport { b } from "./b";\nexport const a = b;\n`);
  writeFileSync(join(dir, "t.ts"), `import { x } from "@tauri-apps/api/core";\nexport type T = typeof x;\n`);
  writeFileSync(join(dir, "b.ts"), `import { type C } from "./c";\nexport const b = 1;\n`);
  writeFileSync(join(dir, "c.ts"), `import { invoke } from "@tauri-apps/api/core";\nexport type C = typeof invoke;\n`);
  const hits = packagesReached(join(dir, "a.ts"));
  expect(hits.length).toBe(1);   // through b.ts's inline-type import (kept at run time), not through t.ts's `import type`
  expect(hits[0]).toEndWith("b.ts → " + relative(ROOT, join(dir, "c.ts")) + " → @tauri-apps/api/core");
});

test("premise: a .js specifier resolves to its .ts; a dynamic literal import is an edge; a non-.ts module is reported", () => {
  const dir = scratchDir();
  writeFileSync(join(dir, "a.ts"), `import { b } from "./b.js";\nexport async function f() { return import("./d"); }\nexport const a = b;\n`);
  writeFileSync(join(dir, "b.ts"), `export const b = 1;\n`);
  writeFileSync(join(dir, "d.ts"), `import V from "./V.svelte";\nexport const d = V;\n`);
  writeFileSync(join(dir, "V.svelte"), `<script>import { x } from "@tauri-apps/api/core";</script>\n`);
  const hits = packagesReached(join(dir, "a.ts"));
  expect(hits.length).toBe(1);
  expect(hits[0]).toEndWith(relative(ROOT, join(dir, "d.ts")) + " → ./V.svelte (not a .ts module; cannot trace)");
});

test("no GUI module an engine test loads at run time reaches a package import", () => {
  for (const m of RUNTIME_GUI_MODULES) expect([m, packagesReached(join(ROOT, m))]).toEqual([m, []]);
});
