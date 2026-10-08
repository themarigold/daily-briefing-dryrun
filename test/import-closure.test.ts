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

test("stripComments strips the comments after a template literal holding `${…}` substitutions", () => {
  // The hand-rolled scanner this helper used before TypeScript's parser compared the `}` closing a
  // substitution at the wrong brace depth: it never went back into the template, read the rest of the file
  // with code and template text swapped, and kept every later comment (350 kept `//` lines in src/main.ts,
  // the first at line 112, measured 2026-10-05).
  const src = [
    'const who = "x";',
    "const t = `a ${who} b`;",
    "// line comment after the template",
    "/* block comment after the template */",
    'const after = "kept"; // trailing comment',
    "const u = `${ { k: `in ${who}` }.k } // template text, not a comment /* nor this */`;",
    "// a second line comment",
    "/* a second block comment */",
  ].join("\n");
  const out = stripComments(src);
  expect(out.length).toBe(src.length);                             // blanked in place: nothing moves
  expect(out.split("\n").length).toBe(src.split("\n").length);
  expect(out).toContain("const t = `a ${who} b`;");
  expect(out).not.toContain("line comment after the template");
  expect(out).not.toContain("block comment after the template");
  expect(out).not.toContain("trailing comment");
  expect(out).toContain('const after = "kept";');
  // Nested braces and a nested template inside a substitution: the template text survives verbatim.
  expect(out).toContain("const u = `${ { k: `in ${who}` }.k } // template text, not a comment /* nor this */`;");
  expect(out).not.toContain("a second line comment");
  expect(out).not.toContain("a second block comment");

  // The walker reads the same stripping: a commented-out import after a template is no edge, a real one is.
  const pkg = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tierb-closure-tpl-")));
  mkdirSync(join(pkg, "src"));
  const write = (rel: string, body: string) => writeFileSync(join(pkg, rel), body);
  write("src/root.ts", [
    'const who = "x";',
    "export const t = `a ${who} b`;",
    '// import { c } from "./commented";',
    '/* import { d } from "./blocked"; */',
    'export { v } from "./value";',
  ].join("\n"));
  write("src/commented.ts", "export const c = 1;");
  write("src/blocked.ts", "export const d = 2;");
  write("src/value.ts", "export const v = 3;");
  expect(importClosure(["src/root.ts"], pkg)).toEqual(["src/root.ts", "src/value.ts"]);
});

test("stripComments reads regex, division, `!` and `++` as TypeScript does: no shape blanks code or keeps a comment", () => {
  // Shapes where guessing regex-vs-division from the token before each `/` goes wrong — in main's scanner,
  // in that scanner with its `${…}` depth fixed, or in a patch to it tried on this branch (review,
  // 2026-10-05) — plus two the parser must get right itself: a block comment against code, and a JSDoc tag
  // holding `//` (parsed as JSDoc, a trailing-comment scan from the tag's `{type}` blanks the code after
  // it). A wrong guess kept every later comment or opened a phantom block comment at a later `/*` and
  // blanked the imports behind it, so each shape is followed by comments (one spanning a CRLF and a
  // U+2028), imports and template text holding `//`, `/*` and `*/`, and the whole output is pinned.
  const tail = [
    '// a later line comment: import("./from-line-comment")',
    '/* a later block comment: import("./from-block-comment") */',
    '/* a block comment over two lines,\r\n   import("./from-two-lines") \u2028 */',
    'import("./after");',
    "const glob = `**/*.ts // not a comment`;",
    'import("./after-glob");',
    "const end = `*/`;",
  ];
  const blanked = (line: string) => line.replace(/[^\r\n\u2028]/g, " ");   // a comment-only line: spaces, line breaks kept
  const strippedTail = [...tail.slice(0, 3).map(blanked), ...tail.slice(3)];
  expect(valueImportSpecifiers(strippedTail.join("\n"))).toEqual(["./after", "./after-glob"]);
  // Each shape, and what it strips to when it holds a comment of its own.
  const shapes: Record<string, { code: string; stripped?: string }> = {
    bangAfterKeyword: { code: "function f(s: string) { return! /[/*]/.test(s); }" },        // prefix `!`: a regex follows
    bangAfterIfHead: { code: "if (x)!/[/*]/.test(s);" },
    nonNullThenSlash: { code: "function f(d: number[], u: string) {\n  log(`${d[0]! / 1000}/${u}`);\n}" },   // postfix `!`: a division
    nonNullAfterCall: { code: "function f() {\n  log(`${g()! / 2}/${h}`);\n}" },
    nonNullSpaced: { code: "const x = 2; const n = x ! / /[/*]/.source.length;" },
    postfixIncThenSlash: { code: "function f(i: number, u: string) {\n  log(`${i++ / 2}/${u}`);\n}" },
    postfixIncThenRegex: { code: "let i = 2;\nconst t = `${i++ / /[/*]/.source.length}`;" },
    postfixDecDivision: { code: "function f(i: number) {\n  log(`${i-- / 2}`);\n}" },
    regexAfterIfHead: { code: "if (x) /`/.test(y);" },
    regexAfterExportDefault: { code: "export default /`/;" },
    regexAfterLineComment: { code: "const res = [\n  /x/, // the form\n  /y`/,\n];", stripped: "const res = [\n  /x/,            \n  /y`/,\n];" },
    blockCommentAgainstCode: { code: "const a = 1;/* c */const b = 2;", stripped: "const a = 1;       const b = 2;" },
    jsdocTagHoldingSlashes: { code: "/** @returns {number} // the count */ export function f() { return 1; }", stripped: `${blanked("/** @returns {number} // the count */")} export function f() { return 1; }` },
  };
  for (const [name, { code, stripped }] of Object.entries(shapes)) {
    const out = stripComments([code, ...tail].join("\n"));
    expect({ name, out }).toEqual({ name, out: [stripped ?? code, ...strippedTail].join("\n") });
  }
});

test("stripComments blanks a comment at end of file, and reads a `.tsx` file as TSX — so does importClosure", () => {
  const eof = "const a = 1; // last, no newline";
  expect(stripComments(eof)).toBe(`const a = 1;${" ".repeat(eof.length - 12)}`);
  // JSX text is not a comment. Read as plain TypeScript, the `/*` in it would open one and blank the import;
  // read as TSX, text that STARTS with `/*` or `//` still looks like one to TypeScript's comment scan.
  const view = 'export const el = <p>globs like src/*.ts</p>;\nimport("./after");';
  expect(stripComments(view, "view.tsx")).toBe(view);
  expect(stripComments(view)).not.toContain("./after");                  // not vacuous: the dialect decides it
  for (const text of ["/*", " // not a comment", "{a}/* b", "\n  /* not a comment either"]) {   // after a tag, or a line break
    const jsx = `export const el = <p>${text}</p>;\nimport("./after");`;
    expect({ text, out: stripComments(jsx, "view.tsx") }).toEqual({ text, out: jsx });
  }
  const realInJsx = 'export const el = <p>{/* a real comment */}</p>;';  // a comment in a JSX expression is real
  expect(stripComments(realInJsx, "view.tsx")).toBe(realInJsx.replace("/* a real comment */", " ".repeat(20)));
  const pkg = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tierb-closure-tsx-")));
  mkdirSync(join(pkg, "src"));
  writeFileSync(join(pkg, "src/root.ts"), 'import { el } from "./view";\nexport const use = el;');
  writeFileSync(join(pkg, "src/view.tsx"), view);
  writeFileSync(join(pkg, "src/after.ts"), "export {};");
  expect(importClosure(["src/root.ts"], pkg)).toEqual(["src/after.ts", "src/root.ts", "src/view.tsx"]);
});
