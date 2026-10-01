/**
 * ⚠ NO RAW HTML SINK, NO NAVIGATION AND NO EMBEDDED RESOURCE ANYWHERE IN `gui/src`
 * (`docs/gui-seam.md` §5, §10c, deviation 39). Every engine-derived string is `{}`-interpolated and
 * drawn as a text node; this file refuses the ways around that — by STRUCTURE, not by substring.
 * Review round 2 measured 20 evasions of the round-1 substring scan (`{ @html s}`, a `//` inside a
 * string hiding the code after it, a `.mts` module, `<a\n{href}>`, `<svelte:element>`, …).
 *
 * - **Components** are parsed with the installed `svelte/compiler` (`parse`, modern AST). Refused
 *   anywhere in a template: `{@html}` in any spacing; an element in `BANNED_ELEMENTS`;
 *   `<svelte:element>` (its tag is computed); an attribute or `bind:` directive named in
 *   `BANNED_ATTRIBUTES`, however its value is written — literal, `{expr}` or the `{href}` shorthand
 *   (no element is exempt); a spread attribute on an element (a component's spread lands in that
 *   component, whose own file is scanned).
 * - **Code** — every `<script>` block, every expression in a template, and every module — is
 *   tokenized by the installed TypeScript (modules and scripts through its parser, which must accept
 *   them without a diagnostic; template expressions through its scanner). A comment is trivia and a
 *   string is one token. Refused: an identifier, or a string literal, in `BANNED_NAMES`; the token
 *   sequences in `BANNED_SEQUENCES`, whatever the spacing between them.
 * - **Every file** under `gui/src` is classified by extension; one this check does not know fails
 *   it, so a new kind of file cannot slip past unscanned.
 *
 * ⚠ WHAT A STATIC SCAN CANNOT SEE: a property name computed at run time (`el["inner" + "HTML"]`,
 * `Reflect.set(el, k, v)`, `Object.assign(el, { [k]: v })`), a sink reached through an alias
 * (`const d = document; d.write(…)`), a bare `open(url)` (not refused: `History.svelte` has a local
 * `open`), and whatever a dependency does. The runtime backstop is the webview's CSP, from
 * `src-tauri/tauri.conf.json` (the test below checks this quote against that file):
 *
 *     default-src 'self'; img-src 'self' asset: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; form-action 'self'
 *
 * It refuses remote and inline script (so an injected `onerror=` does not run), remote images, a
 * `<base>` retarget and a form post away. It does NOT refuse a top-level navigation — that is what
 * the no-`href` rule above is for.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { parse } from "svelte/compiler";
import ts from "typescript";

const SRC = new URL("../src/", import.meta.url).pathname;
const SELF = new URL(import.meta.url).pathname;
const TAURI_CONF = new URL("../src-tauri/tauri.conf.json", import.meta.url).pathname;

/** Elements no component may contain: each navigates, embeds, fetches or retargets. */
const BANNED_ELEMENTS = new Set([
  "a",
  "area",
  "base",
  "embed",
  "form",
  "frame",
  "iframe",
  "img",
  "link",
  "meta",
  "object",
  "portal",
  "script",
]);

/** Attributes (and `bind:` targets) no element may carry. Compared lower-cased. */
const BANNED_ATTRIBUTES = new Set([
  "action",
  "background",
  "formaction",
  "href",
  "http-equiv",
  "innerhtml",
  "outerhtml",
  "ping",
  "poster",
  "src",
  "srcdoc",
  "srcset",
  "xlink:href",
]);

/** Identifiers — or string literals, for `el["innerHTML"]` — no code may contain. */
const BANNED_NAMES = new Set([
  "createContextualFragment",
  "createElement",
  "createElementNS",
  "DOMParser",
  "execCommand",
  "innerHTML",
  "insertAdjacentHTML",
  "outerHTML",
  "parseHTMLUnsafe",
  "setAttribute",
  "setAttributeNode",
  "setAttributeNodeNS",
  "setAttributeNS",
  "setHTMLUnsafe",
  "srcdoc",
]);

interface Token {
  kind: ts.SyntaxKind;
  /** The source text (for a string: with its quotes). */
  text: string;
  /** A string-like literal's cooked value; otherwise the text. */
  value: string;
}

type Match = (t: Token) => boolean;
const is =
  (...texts: string[]): Match =>
  (t) =>
    texts.includes(t.text);
const DOT = is(".", "?.");
const ASSIGN = is("=", "+=", "||=", "&&=", "??=");
const STRING_KINDS = new Set([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral]);
const stringOf =
  (...values: string[]): Match =>
  (t) =>
    STRING_KINDS.has(t.kind) && values.includes(t.value);
const URL_PROPERTIES = ["href", "src", "action", "formAction"];

/** Token sequences no code may contain. */
const BANNED_SEQUENCES: { name: string; seq: Match[] }[] = [
  { name: "document.write", seq: [is("document"), DOT, is("write", "writeln")] },
  { name: "window.open", seq: [is("window", "globalThis", "self"), DOT, is("open")] },
  { name: "location.assign", seq: [is("location"), DOT, is("assign")] },
  { name: "location.replace", seq: [is("location"), DOT, is("replace")] },
  { name: "location =", seq: [is("location"), ASSIGN] },
  { name: ".href =", seq: [DOT, is(...URL_PROPERTIES), ASSIGN] },
  { name: '["href"] =', seq: [is("["), stringOf(...URL_PROPERTIES), is("]"), ASSIGN] },
];

/* ── tokenizing ───────────────────────────────────────────────────────────────────────────────── */

function tokenOf(kind: ts.SyntaxKind, text: string, value: string): Token {
  return { kind, text, value: STRING_KINDS.has(kind) ? value : text };
}

/** A whole module or `<script>` body, through TypeScript's parser: every leaf token in order,
 *  comments (JSDoc included) excluded. Throws if the parser reports a diagnostic, because a parser
 *  that recovered from an error may have skipped the very tokens this check looks for. */
export function moduleTokens(code: string, where: string): Token[] {
  const sf = ts.createSourceFile(where, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    throw new Error(`${where}: does not parse (${ts.flattenDiagnosticMessageText(first?.messageText, " ")})`);
  }
  const out: Token[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) {
        const value = (node as { text?: unknown }).text;
        out.push(tokenOf(node.kind, node.getText(sf), typeof value === "string" ? value : ""));
      }
      return;
    }
    kids.forEach(visit);
  };
  visit(sf);
  return out;
}

/** A regular expression may start after these (and after any keyword but the value-like ones). */
function regexMayFollow(prev: ts.SyntaxKind | undefined): boolean {
  if (prev === undefined) return true;
  const valueLike = [
    ts.SyntaxKind.Identifier,
    ts.SyntaxKind.PrivateIdentifier,
    ts.SyntaxKind.NumericLiteral,
    ts.SyntaxKind.BigIntLiteral,
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.RegularExpressionLiteral,
    ts.SyntaxKind.CloseParenToken,
    ts.SyntaxKind.CloseBracketToken,
    ts.SyntaxKind.CloseBraceToken,
    ts.SyntaxKind.ThisKeyword,
    ts.SyntaxKind.SuperKeyword,
    ts.SyntaxKind.NullKeyword,
    ts.SyntaxKind.TrueKeyword,
    ts.SyntaxKind.FalseKeyword,
    ts.SyntaxKind.PlusPlusToken,
    ts.SyntaxKind.MinusMinusToken,
  ];
  return !valueLike.includes(prev);
}

/** A template EXPRESSION (a fragment, not a program), through TypeScript's scanner — with the
 *  template-literal and regular-expression rescans the parser would do. Throws on a scanner error
 *  (an unterminated string would otherwise swallow the code after it). */
export function expressionTokens(code: string, where: string): Token[] {
  const errors: string[] = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, code, (m) =>
    errors.push(m.message),
  );
  const out: Token[] = [];
  const stack: ("brace" | "template")[] = [];
  let prev: ts.SyntaxKind | undefined;
  for (;;) {
    let kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFileToken) break;
    if (kind === ts.SyntaxKind.OpenBraceToken) {
      stack.push("brace");
    } else if (kind === ts.SyntaxKind.TemplateHead) {
      stack.push("template");
    } else if (kind === ts.SyntaxKind.CloseBraceToken) {
      if (stack[stack.length - 1] === "template") {
        kind = scanner.reScanTemplateToken(false);
        if (kind === ts.SyntaxKind.TemplateTail) stack.pop();
      } else {
        stack.pop();
      }
    } else if (
      (kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) &&
      regexMayFollow(prev)
    ) {
      kind = scanner.reScanSlashToken();
    }
    out.push(tokenOf(kind, scanner.getTokenText(), scanner.getTokenValue()));
    prev = kind;
  }
  if (errors.length > 0) throw new Error(`${where}: does not tokenize (${errors[0]})`);
  return out;
}

/** What a token stream contains that this check refuses. */
export function codeOffences(tokens: Token[]): string[] {
  const found = new Set<string>();
  const names = tokens.filter(
    (t) =>
      t.kind === ts.SyntaxKind.Identifier ||
      t.kind === ts.SyntaxKind.PrivateIdentifier ||
      STRING_KINDS.has(t.kind),
  );
  for (const t of names) {
    const name = t.kind === ts.SyntaxKind.PrivateIdentifier ? t.text.slice(1) : t.value;
    if (BANNED_NAMES.has(name)) found.add(name);
  }
  for (const { name, seq } of BANNED_SEQUENCES) {
    for (let i = 0; i + seq.length <= tokens.length; i++) {
      if (seq.every((m, j) => m(tokens[i + j] as Token))) found.add(name);
    }
  }
  return [...found].sort();
}

/* ── components ───────────────────────────────────────────────────────────────────────────────── */

/** Every node type a template may contain. An unknown one fails the scan (teach it here first). */
const TEMPLATE_TYPES = new Set([
  "Fragment",
  "Text",
  "Comment",
  "RegularElement",
  "Component",
  "SvelteElement",
  "SvelteComponent",
  "SvelteSelf",
  "SvelteHead",
  "SvelteBody",
  "SvelteWindow",
  "SvelteDocument",
  "SvelteFragment",
  "SvelteBoundary",
  "SlotElement",
  "TitleElement",
  "ExpressionTag",
  "HtmlTag",
  "ConstTag",
  "DebugTag",
  "RenderTag",
  "AttachTag",
  "IfBlock",
  "EachBlock",
  "AwaitBlock",
  "KeyBlock",
  "SnippetBlock",
  "Attribute",
  "SpreadAttribute",
  "BindDirective",
  "OnDirective",
  "ClassDirective",
  "StyleDirective",
  "UseDirective",
  "TransitionDirective",
  "AnimateDirective",
  "LetDirective",
]);
/** Template node keys whose value is JavaScript (an ESTree node, or a list of them). */
const CODE_KEYS = new Set(["expression", "test", "context", "key", "tag", "declaration", "parameters", "identifiers", "error"]);
/** Keys that are neither template nor code. */
const SKIPPED_KEYS = new Set(["type", "start", "end", "name", "name_loc", "loc", "metadata", "raw", "data", "modifiers", "index", "fragment_loc"]);
const SPREAD_TARGETS = new Set(["Component", "SvelteComponent", "SvelteSelf"]);

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}
const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

/** What a component contains that this check refuses. */
export function componentOffences(source: string, where: string): string[] {
  const ast = parse(source, { modern: true }) as unknown as {
    fragment: Node;
    instance?: { content: Node } | null;
    module?: { content: Node } | null;
  };
  const found: string[] = [];
  for (const script of [ast.instance, ast.module]) {
    if (script) {
      const code = source.slice(script.content.start, script.content.end);
      found.push(...codeOffences(moduleTokens(code, `${where} <script>`)));
    }
  }
  const code = (value: unknown): void => {
    for (const n of Array.isArray(value) ? value : [value]) {
      if (!isNode(n)) continue;
      const text = source.slice(n.start, n.end);
      found.push(...codeOffences(expressionTokens(text, `${where}:${n.start}`)));
    }
  };
  const walk = (node: Node, parent: Node | null): void => {
    if (!TEMPLATE_TYPES.has(node.type)) {
      throw new Error(`${where}:${node.start}: template node type ${node.type} is unknown to static.check.ts`);
    }
    switch (node.type) {
      case "HtmlTag":
        found.push("{@html}");
        break;
      case "SvelteElement":
        found.push("<svelte:element>");
        break;
      case "RegularElement":
        if (BANNED_ELEMENTS.has(String(node.name).toLowerCase())) found.push(`<${String(node.name)}>`);
        break;
      case "Attribute":
      case "BindDirective":
        if (BANNED_ATTRIBUTES.has(String(node.name).toLowerCase())) {
          found.push(`${node.type === "BindDirective" ? "bind:" : ""}${String(node.name)}=`);
        }
        break;
      case "SpreadAttribute":
        if (parent !== null && !SPREAD_TARGETS.has(parent.type)) found.push(`{...spread} on <${String(parent.name)}>`);
        break;
    }
    for (const [key, value] of Object.entries(node)) {
      if (SKIPPED_KEYS.has(key)) continue;
      if (CODE_KEYS.has(key) || (key === "value" && node.type === "AwaitBlock")) {
        code(value);
        continue;
      }
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) walk(child, node);
        else if (typeof child === "object" && child !== null && key !== "value") {
          throw new Error(`${where}:${node.start}: ${node.type}.${key} holds an object this check does not read`);
        }
      }
    }
  };
  walk(ast.fragment, null);
  return found;
}

/* ── the files ────────────────────────────────────────────────────────────────────────────────── */

const MODULE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
/** Files that hold no code and no markup. */
const INERT_EXTENSIONS = new Set([".css"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** What `path` contains that this check refuses; an unknown extension is itself an offence. */
export function fileOffences(path: string, source = readFileSync(path, "utf8")): string[] {
  const ext = extname(path);
  if (ext === ".svelte") return componentOffences(source, path);
  if (MODULE_EXTENSIONS.has(ext)) return codeOffences(moduleTokens(source, path));
  if (INERT_EXTENSIONS.has(ext)) return [];
  return [`an unscanned file type (${ext || "no extension"})`];
}

describe("gui/src", () => {
  test("no raw HTML sink, navigation or embedded resource in any file", () => {
    const all = files(SRC);
    expect(all.filter((p) => p.endsWith(".svelte")).length).toBeGreaterThan(5);
    expect(all.filter((p) => MODULE_EXTENSIONS.has(extname(p))).length).toBeGreaterThan(5);
    const offenders = all.flatMap((path) => fileOffences(path).map((o) => `${path}: ${o}`));
    expect(offenders).toEqual([]);
  });

  test("comments are not code: the sources mention the sinks in prose and still pass", () => {
    const mentioning = files(SRC).filter((p) => /\{@html|innerHTML/.test(readFileSync(p, "utf8")));
    expect(mentioning.length).toBeGreaterThan(0);
    for (const p of mentioning) expect({ p, offences: fileOffences(p) }).toEqual({ p, offences: [] });
  });

  test("the CSP quoted in this file's header is the one the app ships", () => {
    const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8")) as { app: { security: { csp: string } } };
    expect(conf.app.security.csp).toContain("script-src 'self'");
    expect(readFileSync(SELF, "utf8")).toContain(` *     ${conf.app.security.csp}\n`);
  });
});

/**
 * prove-it 3b: each evasion review round 2 planted against the round-1 scan, and the classes this
 * scan claims — each must be refused. (`static-planted` in the round-2 probe also planted these in
 * real files and watched this suite go red.)
 */
describe("the scan refuses what it claims to", () => {
  const svelte = (s: string) => componentOffences(s, "planted.svelte");
  const mod = (s: string) => codeOffences(moduleTokens(s, "planted.ts"));

  test("raw HTML, in any spacing, and never from a comment", () => {
    expect(svelte("<p>{ @html s}</p>")).toEqual(["{@html}"]);
    expect(svelte("<p>{@html\n  s}</p>")).toEqual(["{@html}"]);
    expect(svelte("<!-- {@html s} --><p>{s}</p>")).toEqual([]);
  });

  test("anchors, embeds and URL attributes, however they are written", () => {
    expect(svelte("<a\n{href}>x</a>")).toEqual(["<a>", "href="]);
    expect(svelte("<A href={u}>x</A>")).toEqual(["href="]); // a component's prop: refused too
    expect(svelte('<svelte:element this={"a"} {href}>x</svelte:element>')).toEqual(["<svelte:element>", "href="]);
    expect(svelte('<meta http-equiv="refresh" content="0;url=https://x.invalid">')).toEqual(["<meta>", "http-equiv="]);
    expect(svelte("<div {...rest}></div>")).toEqual(["{...spread} on <div>"]);
    expect(svelte("<Comp {...rest} />")).toEqual([]);
    expect(svelte('<button formaction="https://x.invalid">b</button>')).toEqual(["formaction="]);
    expect(svelte("<div contenteditable bind:innerHTML={s}></div>")).toEqual(["bind:innerHTML="]);
    expect(svelte('<svg><image xlink:href="https://x.invalid/p.png" /></svg>')).toEqual(["xlink:href="]);
    for (const el of ["iframe", "object", "form"]) expect(svelte(`<${el}></${el}>`)).toEqual([`<${el}>`]);
    for (const el of ["embed", "base", "img", "link"]) expect(svelte(`<${el}>`)).toEqual([`<${el}>`]);
  });

  test("code in a template expression is scanned", () => {
    expect(svelte("<button onclick={() => { el.innerHTML = s }}>x</button>")).toEqual(["innerHTML"]);
    expect(svelte("{#if (location = u)}x{/if}")).toEqual(["location ="]);
    expect(svelte("<p>{`${el.outerHTML}`}</p>")).toEqual(["outerHTML"]);
  });

  test("a string cannot hide code, and a comment cannot fake it", () => {
    expect(mod('const s = "a // b"; el.innerHTML = s;')).toEqual(["innerHTML"]);
    expect(mod("const s = 'a /* b'; el.innerHTML = s; const t = '*/';")).toEqual(["innerHTML"]);
    expect(mod("const r = /\\/\\//; el.innerHTML = s;")).toEqual(["innerHTML"]);
    expect(mod("const t = `x ${'`'} y`; el.innerHTML = s;")).toEqual(["innerHTML"]);
    expect(mod("// el.innerHTML = s\n/* document.write(s) */\nconst ok = 1;")).toEqual([]);
    expect(svelte('<script lang="ts">\n  const s = "a // b"; el.innerHTML = s;\n</script>')).toEqual(["innerHTML"]);
  });

  test("the round-2 needles, whatever the spacing", () => {
    expect(mod("el.setHTMLUnsafe(s)")).toEqual(["setHTMLUnsafe"]);
    expect(mod("Document.parseHTMLUnsafe(s)")).toEqual(["parseHTMLUnsafe"]);
    expect(mod("range.createContextualFragment(s)")).toEqual(["createContextualFragment"]);
    expect(mod("el.setAttributeNS(null, 'href', u)")).toEqual(["setAttributeNS"]);
    expect(mod("location . assign(u)")).toEqual(["location.assign"]);
    expect(mod("window.location.replace(u)")).toEqual(["location.replace"]);
    expect(mod("document\n  .write(s)")).toEqual(["document.write"]);
    expect(mod("a.href\n=\nu")).toEqual([".href ="]);
    expect(mod("a.href += u")).toEqual([".href ="]);
    expect(mod('a["href"] = u')).toEqual(['["href"] =']);
    expect(mod('el["innerHTML"] = s')).toEqual(["innerHTML"]);
    expect(mod('document.createElement("a")')).toEqual(["createElement"]);
    expect(mod("window.open(u)")).toEqual(["window.open"]);
    // Reading is not writing.
    expect(mod("const same = a.href === b.href; const h = url.href;")).toEqual([]);
  });

  test("every file type is accounted for", () => {
    expect(fileOffences("x.mts", "el.innerHTML = s;")).toEqual(["innerHTML"]);
    expect(fileOffences("x.cjs", "document.write(s)")).toEqual(["document.write"]);
    expect(fileOffences("x.css", "p { color: red }")).toEqual([]);
    expect(fileOffences("x.html", "<a href=x>")).toEqual(["an unscanned file type (.html)"]);
    expect(() => fileOffences("x.ts", "const = ;")).toThrow("does not parse");
  });
});
