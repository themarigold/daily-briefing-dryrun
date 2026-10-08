// test/helpers/importClosure.ts — the VALUE-import closure walker (tier B, T1.0; plan §2, §6 L1).
//
// A plain module, NOT a `.test.ts` file: importing a test file re-registers its tests. It is read by
// two callers with different questions —
//   · the milestone sync's re-freeze decision (plan §6 L1, D19): "did upstream touch a file the render
//     golden or the cluster golden can reach?" — the closure of `src/render.ts` / `src/generator.ts`;
//   · T4.4's import guard: "can any of B's three modules reach `src/core`, `src/runlock` or `src/main`
//     by ANY route?" — a transitive walk, because `json.ts:29` reaches `runlock` in one hop and a
//     line-local grep of the new modules would never see it.
//
// What counts as an edge, and in which direction this walker errs:
//   · a static `import … from "./x"` (default, namespace, named — a MULTI-LINE specifier list included:
//     base `src/` has five, `json.ts:25`, `:36`, `main.ts:27`, `schedule/status.ts:22`,
//     `schedule/install.ts:41`, and a line-based walker misses every one of them while still printing
//     the same file counts for the two goldens), a side-effect `import "./x"`, an `export … from "./x"`
//     and a code-level literal `import("./x")`;
//   · `import type … from` and `export type … from` are SKIPPED — erased at compile time, they load
//     nothing. A value-import whose specifier list happens to name only types
//     (`import { type A } from "./x"`) STILL COUNTS: the walker over-approximates, so it can raise a
//     false alarm but never miss a route;
//   · comments are stripped first, so a commented-out `import("./main")` (`preflight.ts:5`,
//     `json.ts:51`) is not an edge. The comment ranges come from TypeScript's own parser (`typescript`,
//     the package's peer dependency, already read by `test/docs-config.test.ts`), not from a regex or a
//     scanner of our own. A naive `/\/\*[\s\S]*?\*\//` opens a phantom block comment at `"**/*.ts"` in a
//     string, and that phantom can swallow a later dynamic import — the one direction this walker must not
//     err in. The hand-rolled scanner that replaced the regex had to guess regex-vs-division from the
//     token before each `/`, and review on 2026-10-05 found guesses that went wrong both ways: after `i++`,
//     `x!`, `if (x)` or `export default`, a misread `/` either kept every later comment or blanked a later
//     import. The parser decides those the way the compiler does, in the dialect the file's extension
//     names (`.tsx` as TSX, `.json` as JSON). An extension TypeScript does not know, `.svelte`, is parsed
//     as TypeScript, markup included, as the scanner did before it; none is reachable from `src/`
//     (measured 2026-10-05);
//   · only RELATIVE specifiers (`./`, `../`) are followed. `node:fs`, `bun`, `svelte/compiler` are not
//     files of this package. A specifier resolves to the first of: the literal path (when it exists as a
//     file), `<p>.ts`, `<p>.tsx`, `<p>.mts`, `<p>/index.ts`, and a `.js`/`.mjs` spelling to its `.ts`
//     twin. Whatever resolves is followed, stripped and scanned the same way (`.svelte` and `.json`
//     included — a `<script>` block's imports are still imports; a JSON file simply has none).
//
// `importClosure(roots, pkgDir)` returns the SORTED, `pkgDir`-relative, POSIX-spelled list of every file
// reachable from `roots` (roots included), `roots` being `pkgDir`-relative too. Measured at the base this
// walker was frozen with (`d51f53621`; `src/` unchanged at `0452dfe55`): `src/render.ts` reaches 16
// files and `src/generator.ts` 14 — the lists in plan §6 L1.
//
// ⚠ Never name a state-dir sink here, even in prose: this file sits under `test/` and
// `test/isolation.meta.test.ts`'s scanners read every `.ts` file there.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

/** Characters `stripComments` never blanks, so a comment spanning lines keeps every line break. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/** Comments blanked out (each comment character becomes a space and line breaks stay, so nothing else
 *  moves — the walker's own outputs never cite offsets, but a caller diffing two strippings, or pinning
 *  whole lines, should see the same shape). Every comment is trivia next to some token, so asking for the
 *  ranges around every node and token (the end-of-file token included) finds them. Both calls are needed:
 *  TypeScript reports a comment on the same line after a token only as that token's TRAILING comment.
 *  JSDoc is left unparsed (`ParseNone`): parsed, its tags hold nodes (a `{type}`), and the trailing-comment
 *  scan from such a node's end reads a `//` inside the JSDoc as a line comment that runs past the JSDoc's
 *  end and blanks code. Kept as text: a `#!` line (not a comment), and comments in the trivia right after a
 *  merge-conflict marker (TypeScript stops scanning there).
 *  `fileName` picks the dialect: `.tsx` as TSX, `.json` as JSON, anything TypeScript does not know as TS. */
export function stripComments(src: string, fileName = "strip.ts"): string {
  const out = src.split("");
  const file = ts.createSourceFile(fileName, src, { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone });
  const blank = (r: ts.CommentRange) => { for (let k = r.pos; k < r.end; k++) if (!LINE_BREAK.test(out[k]!)) out[k] = " "; };
  const nodes: ts.Node[] = [];
  const inJsxText = new Uint8Array(src.length);
  // A stack rather than recursion: a long `a + b + …` chain nests deep enough to overflow the call stack.
  const pending: ts.Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    nodes.push(node);
    if (node.kind === ts.SyntaxKind.JsxText) inJsxText.fill(1, node.pos, node.end);
    for (const child of node.getChildren(file)) pending.push(child);
  }
  // No scan starts inside JSX text: it is not trivia, but TypeScript's comment scan reads a `//` or `/*` at
  // its start (`<p>/*</p>`) as a comment that can run on and blank code, and no real comment starts there.
  // Each position is scanned once per direction: that `a + b + …` chain starts one node per term at the
  // same offset, and rescanning there would collect the same comments for every node.
  const leadingDone = new Set<number>(), trailingDone = new Set<number>();
  for (const { pos, end } of nodes) {
    if (!inJsxText[pos] && !leadingDone.has(pos)) { leadingDone.add(pos); ts.getLeadingCommentRanges(src, pos)?.forEach(blank); }
    if (!inJsxText[end] && !trailingDone.has(end)) { trailingDone.add(end); ts.getTrailingCommentRanges(src, end)?.forEach(blank); }
  }
  return out.join("");
}

/** Every relative specifier this (already comment-stripped) source VALUE-imports: static imports, then
 *  re-exports, then side-effect and dynamic imports, each kind in source order. */
export function valueImportSpecifiers(stripped: string): string[] {
  const found: string[] = [];
  // `import <clause> from "x"`: default, `* as ns`, `{ … }` — the braces span lines — or default+named.
  // Group 1 catches the `type` keyword of a type-only import, which loads nothing and is skipped.
  const staticImport = /\bimport\s+(type\s+)?(?:[\w$]+\s*(?:,\s*)?)?(?:\*\s*as\s+[\w$]+|\{[^}]*\})?\s*from\s*["']([^"'\n]+)["']/g;
  const reExport = /\bexport\s+(type\s+)?(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"'\n]+)["']/g;
  const sideEffect = /\bimport\s*["']([^"'\n]+)["']/g;
  const dynamic = /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
  for (const re of [staticImport, reExport]) {
    for (const m of stripped.matchAll(re)) if (!m[1]) found.push(m[2]!);
  }
  for (const re of [sideEffect, dynamic]) {
    for (const m of stripped.matchAll(re)) found.push(m[1]!);
  }
  return found.filter((s) => s.startsWith("./") || s.startsWith("../"));
}

const isFile = (p: string): boolean => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } };

/** The file a relative specifier names, or undefined when nothing on disk answers to it. */
export function resolveSpecifier(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, resolve(base, "index.ts")];
  const js = /\.(m?js)$/.exec(base);
  if (js) candidates.push(base.slice(0, -js[1]!.length) + (js[1] === "mjs" ? "mts" : "ts"));
  return candidates.find(isFile);
}

/** The sorted, `pkgDir`-relative closure of `roots` (themselves `pkgDir`-relative) under value imports. */
export function importClosure(roots: string[], pkgDir: string): string[] {
  const pkg = resolve(pkgDir);
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) {
    const abs = resolve(pkg, r);
    if (!isFile(abs)) throw new Error(`importClosure: root ${r} is not a file under ${pkg}`);
    if (!seen.has(abs)) { seen.add(abs); queue.push(abs); }
  }
  while (queue.length) {
    const file = queue.shift()!;
    const stripped = stripComments(readFileSync(file, "utf8"), file);
    for (const spec of valueImportSpecifiers(stripped)) {
      const target = resolveSpecifier(file, spec);
      if (target !== undefined && !seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
  return [...seen].map((f) => relative(pkg, f).split(sep).join("/")).sort();
}
