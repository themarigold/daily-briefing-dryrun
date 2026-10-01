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
//     `json.ts:48`) is not an edge. The stripper is a small state machine rather than a regex, because
//     `"**/*.ts"` in a string opens a phantom block comment under a naive `/\/\*[\s\S]*?\*\//` and that
//     phantom can swallow a later dynamic import — the one direction this walker must not err in.
//     String, template (with `${…}` nesting) and regex literals are stepped over; the regex-vs-division
//     call is the usual previous-token heuristic (`(`, `=`, `,`, `:`, `[`, `!`, `&`, `|`, `?`, `{`,
//     `;`, `}` or `return`/`typeof`/… before the `/` means a regex). A wrong call here is bounded to the
//     rest of one line or one literal, and imports never share a line with either;
//   · only RELATIVE specifiers (`./`, `../`) are followed. `node:fs`, `bun`, `svelte/compiler` are not
//     files of this package. A specifier resolves to the first of: the literal path (when it exists as a
//     file), `<p>.ts`, `<p>.tsx`, `<p>.mts`, `<p>/index.ts`, and a `.js`/`.mjs` spelling to its `.ts`
//     twin. Whatever resolves is followed and parsed the same way (`.svelte` and `.json` included — a
//     `<script>` block's imports are still imports; a JSON file simply has none).
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

/** Words after which a `/` begins a regex literal rather than a division. */
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
/** Punctuation after which a `/` begins a regex literal. `)` and `]` are deliberately absent: `(a + b) / c`. */
const REGEX_AFTER_PUNCT = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/** Comments blanked out (each comment character becomes a space, so nothing else moves — the walker's
 *  own outputs never cite offsets, but a caller diffing two strippings should see the same shape). */
export function stripComments(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  /** The last significant (non-space) character before `i`, and the identifier ending there, if any. */
  const before = (at: number): { ch: string; word: string } => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(src[j]!)) j--;
    if (j < 0) return { ch: "", word: "" };
    let k = j;
    while (k >= 0 && /[\w$]/.test(src[k]!)) k--;
    return { ch: src[j]!, word: src.slice(k + 1, j + 1) };
  };
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  // Template literals nest through `${ … }`: each entry is the brace depth at which the enclosing
  // template resumes. Code mode is the stack being empty or the top's depth being open.
  const templates: number[] = [];
  let braces = 0;
  while (i < n) {
    const c = src[i]!, d = src[i + 1];
    if (c === "/" && d === "/") {                                   // line comment
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j); i = j; continue;
    }
    if (c === "/" && d === "*") {                                   // block comment
      let j = src.indexOf("*/", i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j); i = j; continue;
    }
    if (c === '"' || c === "'") {                                   // string literal: step over it
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") { if (src[j] === "\\") j++; j++; }
      i = j + 1; continue;
    }
    if (c === "`") {                                                // template literal: step to `${` or the closing tick
      i = skipTemplate(src, i + 1, templates);
      continue;
    }
    if (templates.length && c === "}" && braces === templates[templates.length - 1]) {
      templates.pop();                                              // `${ … }` closed: back inside the template text
      i = skipTemplate(src, i + 1, templates);
      continue;
    }
    if (c === "{") braces++;
    else if (c === "}") braces--;
    else if (c === "/") {                                           // regex literal or division
      const { ch, word } = before(i);
      const isRegex = ch === "" || REGEX_AFTER_PUNCT.has(ch) || (/[\w$]/.test(ch) && REGEX_AFTER_WORD.has(word));
      if (isRegex) {
        let j = i + 1, inClass = false;
        while (j < n && src[j] !== "\n") {
          const r = src[j]!;
          if (r === "\\") { j += 2; continue; }
          if (inClass) { if (r === "]") inClass = false; }
          else if (r === "[") inClass = true;
          else if (r === "/") break;
          j++;
        }
        i = j + 1; continue;
      }
    }
    i++;
  }
  return out.join("");

  /** From just after a backtick (or a closing `}`), step over template text until its closing tick —
   *  returning the index after it — or until a `${`, pushing the current brace depth and returning the
   *  index after the `{` so the expression is read as code. */
  function skipTemplate(s: string, from: number, stack: number[]): number {
    let j = from;
    while (j < s.length) {
      const t = s[j]!;
      if (t === "\\") { j += 2; continue; }
      if (t === "`") return j + 1;
      if (t === "$" && s[j + 1] === "{") { stack.push(braces); braces++; return j + 2; }
      j++;
    }
    return j;
  }
}

/** Every relative specifier this (already comment-stripped) source VALUE-imports, in source order. */
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
    const stripped = stripComments(readFileSync(file, "utf8"));
    for (const spec of valueImportSpecifiers(stripped)) {
      const target = resolveSpecifier(file, spec);
      if (target !== undefined && !seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
  return [...seen].map((f) => relative(pkg, f).split(sep).join("/")).sort();
}
