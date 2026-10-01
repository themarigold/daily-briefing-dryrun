// test/import-closure.test.ts — pins `test/helpers/importClosure.ts` (tier B, T1.0) on a fixture tree
// this test writes itself, one edge of each kind the walker must follow or skip. The real closures
// (`src/render.ts` → 16 files, `src/generator.ts` → 14 at the freeze base) are the plan's Verify line,
// not a pin here: they move with upstream, which is exactly why the sync re-runs the walker.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { importClosure, stripComments, valueImportSpecifiers } from "./helpers/importClosure";

test("importClosure follows value imports across lines and skips type-only and commented imports", () => {
  const pkg = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tierb-closure-")));
  mkdirSync(join(pkg, "src"));
  mkdirSync(join(pkg, "lib"));
  const write = (rel: string, body: string) => writeFileSync(join(pkg, rel), body);
  write("src/root.ts", [
    'import { a } from "./value";',                        // a value edge
    'import type { T } from "./typeonly";',               // type-only: erased, NOT an edge
    'export { r } from "./reexport";',                    // `export … from`
    'export type { RT } from "./reexport-type";',         // type-only re-export: NOT an edge
    '// import { c } from "./commented";',                // commented out (line): NOT an edge
    '/* import { d } from "./blocked"; */',               // commented out (block): NOT an edge
    'const glob = "**/*.ts"; // a `/*` inside a string must not open a phantom block comment',
    "const re = /[*`]\\/\\//g; // a regex carrying `*`, a backtick and `//` must not desync the stripper",
    "import {",                                           // a MULTI-LINE specifier list
    "  m1,",
    "  m2,",
    '} from "./multi";',
    'export async function go() { return (await import("./dynamic")).x; }',   // a code-level dynamic import
    "export const use = () => [a, r, m1, m2, glob, re];",
  ].join("\n"));
  write("src/value.ts", 'export const a = 1;');
  write("src/typeonly.ts", 'export type T = number; import "./typeonly-dep";');       // reachable ONLY through the type edge
  write("src/typeonly-dep.ts", "export {};");
  write("src/reexport.ts", 'export const r = 2;');
  write("src/reexport-type.ts", 'export type RT = string; import "./reexport-type-dep";');
  write("src/reexport-type-dep.ts", "export {};");
  write("src/commented.ts", "export const c = 3;");
  write("src/blocked.ts", "export const d = 4;");
  write("src/multi.ts", 'import { deep } from "../lib/deep";\nexport const m1 = deep, m2 = deep;');   // transitive, one level down
  write("lib/deep.ts", "export const deep = 5;");
  write("src/dynamic.ts", 'export const x = 6;');

  expect(importClosure(["src/root.ts"], pkg)).toEqual([
    "lib/deep.ts",
    "src/dynamic.ts",
    "src/multi.ts",
    "src/reexport.ts",
    "src/root.ts",
    "src/value.ts",
  ]);

  // Not vacuous: each skipped file really exists and really is one hop from the root, so its absence is
  // the walker's decision and not a resolver miss.
  const stripped = stripComments(readFileSync(join(pkg, "src/root.ts"), "utf8"));
  expect(stripped).not.toContain("./commented");
  expect(stripped).not.toContain("./blocked");
  expect(stripped).toContain('"**/*.ts"');                       // the string survived the stripper intact
  expect(valueImportSpecifiers(stripped)).toEqual(["./value", "./multi", "./reexport", "./dynamic"]);
  expect(importClosure(["src/typeonly.ts"], pkg)).toEqual(["src/typeonly-dep.ts", "src/typeonly.ts"]);
  expect(importClosure(["src/reexport-type.ts"], pkg)).toEqual(["src/reexport-type-dep.ts", "src/reexport-type.ts"]);
});
