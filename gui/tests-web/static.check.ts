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
 * - **Style (Step 0, hub spec "Constraints").** No `style` attribute in any form, static text
 *   included. The one allowed style is a custom property whose value is a single call to a geometry
 *   helper (`clampPct`, `clampInt`): `style:--x={clampPct(…)}` on an element, or
 *   `--x={clampPct(…)}` on a component (Svelte turns a component's `--x` into an inline style),
 *   and likewise for `clampInt`. Inside SVG (an `<svg>` subtree, or any
 *   SVG-only element such as a component that is just a `<path>`), every attribute whose value holds
 *   an expression must be a number literal (a minus sign allowed), such a call, or a conditional
 *   whose every branch is one of these; static text stays allowed (an icon's `d`, `points`), and
 *   `class`, `role`, `id`, `aria-*`, `data-*` and `on*` are exempt. HTML under `<foreignObject>` is
 *   HTML again (its attributes are not geometry) until another `<svg>`. Outside SVG the same holds
 *   only for a table's `width`/`height` (`table`, `td`, `th`, `col`, `colgroup`, `hr`, `pre`: a
 *   presentational size); `<canvas width={n}>` is not a style. Presentational attributes (`bgcolor`,
 *   `color`, `face`, `align`, `valign`, `border`, `cellpadding`, `cellspacing`, MathML's `mathcolor`,
 *   `mathbackground`, `mathsize`) are refused like the URL attributes, and so is a `<style>`
 *   element in markup (the component's own top-level `<style>`, with no attributes, is its
 *   stylesheet and stays allowed).
 *   Two deliberate asymmetries: a style directive or a component `--x` takes ONLY a helper call (not
 *   a bare number, so `style:--n={12}` is refused — write the number in CSS), while an SVG attribute
 *   also takes a number literal (`<rect width={4}>`); and in an SVG attribute that mixes text and an
 *   expression (`d="M{clampPct(a, b)} 0"`) the text parts are accepted, since they are written in the
 *   source and no engine text can reach them — only the expression parts are checked.
 *   A "helper" is a local name bound by an `import { … } from` that resolves to `lib/ui/geometry`
 *   (aliases allowed) and bound nowhere else in the component — not in a script, an `{#each}`, a
 *   snippet, `let:`, `{@const}` or `{#await}`. Its imported name must be one of `geometry.ts`'s
 *   value exports, read at test time, each of which must CALL both `Math.min(` and `Math.max(` — a
 *   check of presence, not proof that the result is clamped; the helpers' own behaviour tests
 *   (`clampPct`, `clampInt`, in `look.check.ts`) cover that.
 *   Transitions and animations (`transition:`, `in:`, `out:`, `animate:`) may only be Svelte's own
 *   `fade`, `fly`, `blur`, `slide`, `scale`, `draw` (from `svelte/transition`) and `flip` (from
 *   `svelte/animate`), imported and not shadowed: a custom one can return CSS built from any string,
 *   and even Svelte's `fly` (`x`, `y`) and `blur` (`amount`) splice a string parameter's unit into
 *   the CSS, so for those the parameter must be an object literal whose text keys are numbers or
 *   helper calls (`TRANSITION_TEXT_KEYS`). No code names `style` (as an identifier or a string), the
 *   CSSOM (`cssText`, `setProperty`, `insertRule`, `styleSheets`, `adoptedStyleSheets`,
 *   `CSSStyleSheet`, `attributeStyleMap`), attribute nodes (`.attributes`, `createAttribute*`,
 *   `getAttributeNode*`, `get/setNamedItem*`) or Web Animations (`.animate`). No string names a
 *   module under `svelte/internal` or `svelte/legacy` (their `set_style`, `set_attribute` and `html`
 *   are the primitives these rules refuse), and every `import()` names a plain string.
 *
 * ⚠ WHAT A STATIC SCAN CANNOT SEE: a property name computed at run time (`el["inner" + "HTML"]`,
 * `el["st" + "yle"]`, `Reflect.set(el, k, v)`, `Object.assign(el, { [k]: v })` — a literal `"style"`
 * or `{ style }` IS refused, a computed one is not), a sink reached through an alias
 * (`const d = document; d.write(…)`, `const a = el.animate; a.call(el, …)` once `.animate` was
 * spelled some other computed way), a bare `open(url)` (not refused: `History.svelte` has a local
 * `open`), whatever a dependency does, and these routes to a style or a geometry that name nothing
 * this scan refuses (deliberate obfuscation, listed here rather than chased in code): Web
 * Animations built as objects (`new KeyframeEffect(…)`, `new Animation(…)`), `CSS.registerProperty`,
 * fonts loaded from script (`new FontFace(…)`, `document.fonts`), a CSS `attr()` in a stylesheet
 * reading an exempt `data-*` attribute, `<font size>`, and MathML's `<mspace width>`. Also not
 * checked, each bounded: `type={…}` on `ol`/`ul`/`li` (presentational, but only a list-marker
 * keyword); `height={…}` on `tr`/`thead`/`tbody`/`tfoot` (only parsed as a number); and a non-SVG
 * element inside a `{#snippet}` defined outside `<svg>` and `{@render}`ed inside one, which the
 * SVG rule does not follow.
 *
 * Code this scan refuses although it is harmless — D and A rewrite it, the scan is not loosened:
 * `in:fly={SHARED_OPTS}` (write the object literal in place); `in:fly={{ y: +8 }}` (a unary plus is
 * not a number literal: write `8`); `in:fly={{ x: "100%" }}` or `x: dir * 40` (the slide glide uses
 * the CSS track of A's plan design, not `fly`); `import("./x.json", { with: … })` (a static import);
 * `<style lang="…">` (no attribute on the component's own `<style>`); a component prop named
 * `color`, `align`, `border`, `face` or `valign` (rename the prop); `<path d={ICONS[id]}>` (one
 * snippet or `{#if}` branch per icon, each with a static `d`); `y={i * 10}` (a helper call over a
 * 0-100 viewBox, e.g. `clampPct(i, n)`); `<svg width={size}>` (size the svg in CSS); `hidden={…}`,
 * `inert={…}` or `title={…}` on an `<svg>` or an SVG child (wrap it in `{#if}` instead of hiding it,
 * and name it with a `<title>` child or `aria-label`); and `style:--i={cond ? 0 : clampInt(i, n)}`
 * (a style directive takes one helper call only: move the condition into the helper's argument,
 * `clampInt(cond ? 0 : i, n)`); a dynamic `viewBox={…}` (a fixed `viewBox="0 0 100 100"` with
 * helper positions inside it); the same helper imported in both `<script module>` and `<script>`
 * (import it once); `x={-clampPct(a, b)}` (fold the sign into the helper's inputs, or use a fixed
 * `transform`); and `<svg focusable={false}>` (write `focusable="false"`).
 *
 * The runtime backstop is the webview's CSP, from
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
import { dirname, extname, join, resolve } from "node:path";
import { parse } from "svelte/compiler";
import ts from "typescript";

const SRC = new URL("../src/", import.meta.url).pathname;
const SELF = new URL(import.meta.url).pathname;
const TAURI_CONF = new URL("../src-tauri/tauri.conf.json", import.meta.url).pathname;
const GEOMETRY_SRC = new URL("../src/lib/ui/geometry.ts", import.meta.url).pathname;

/** Element names that are SVG wherever they appear (so a component that is only a `<path>` counts). */
const SVG_ELEMENTS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath",
  "defs", "symbol", "use", "marker", "mask", "pattern", "clipPath", "linearGradient", "radialGradient", "stop",
  "animate", "animateMotion", "animateTransform", "set", "mpath", "filter", "foreignObject", "switch", "view",
  "desc", "metadata", "image",
]);
const isSvgElement = (name: string) => SVG_ELEMENTS.has(name) || /^fe[A-Z]/.test(name);
/** Attributes inside SVG that may hold any expression: none of them is geometry or paint. */
const svgExempt = (name: string) => ["class", "role", "id"].includes(name) || /^(aria|data)-/.test(name) || /^on/.test(name);
/** Components whose `--x` attributes Svelte turns into an inline style. */
const CSS_PROP_TARGETS = new Set(["Component", "SvelteComponent", "SvelteSelf", "SvelteElement"]);

/**
 * Svelte's own transition and animate functions this check accepts, each with the parameters that
 * reach the generated CSS AS TEXT — read from `node_modules/svelte/src/transition/index.js` and
 * `src/animate/index.js` (svelte 5.57.0). `fly`'s `x`/`y` and `blur`'s `amount` go through
 * `split_css_unit`, which keeps any trailing text (`[^\s]*`) as the "unit" and splices it into the
 * CSS. Every other parameter only reaches arithmetic (`delay`, `duration`, `easing`, `opacity`,
 * `start`, `speed`) or picks a fixed string (`slide`'s `axis`). `crossfade` is a factory that returns
 * transitions, not one, and is not accepted as a directive. Re-read these when svelte is upgraded.
 */
const TRANSITION_TEXT_KEYS: Record<string, readonly string[]> = {
  blur: ["amount"],
  draw: [],
  fade: [],
  fly: ["x", "y"],
  scale: [],
  slide: [],
};
const ANIMATE_TEXT_KEYS: Record<string, readonly string[]> = { flip: [] };

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
  // Step 0's style rule: a <style> element in MARKUP (the component's own top-level <style> is its
  // stylesheet, parsed apart from the markup, and stays allowed) is a handle for script-side CSS.
  "style",
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
  // Step 0's style rule: presentational attributes the browser maps to CSS.
  "align",
  "bgcolor",
  "border",
  "cellpadding",
  "cellspacing",
  "color",
  "face",
  "mathbackground",
  "mathcolor",
  "mathsize",
  "valign",
]);

/** HTML elements whose `width` / `height` are presentational sizes (mapped to CSS). */
const TABLE_SIZED = new Set(["table", "td", "th", "col", "colgroup", "hr", "pre"]);

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
  // Step 0's style rule: no script writes a style — not the element's, not through the CSSOM, and
  // not through an attribute node (`style` as an identifier OR a string covers `.style`, `["style"]`,
  // `const { style } = el`, `Object.assign(el, { style })`, `Reflect.set(el, "style", …)`).
  "adoptedStyleSheets",
  "attributeStyleMap",
  "createAttribute",
  "createAttributeNS",
  "cssText",
  "CSSStyleSheet",
  "getAttributeNode",
  "getAttributeNodeNS",
  "getNamedItem",
  "getNamedItemNS",
  "insertRule",
  "setNamedItem",
  "setNamedItemNS",
  "setProperty",
  "style",
  "styleSheets",
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
  // Step 0's style rule (`style` itself is a banned name): Web Animations take keyframes of any CSS,
  // and attribute nodes are a way around `setAttribute`.
  { name: ".animate", seq: [DOT, is("animate")] },
  { name: '["animate"]', seq: [is("["), stringOf("animate"), is("]")] },
  { name: ".attributes", seq: [DOT, is("attributes")] },
  { name: '["attributes"]', seq: [is("["), stringOf("attributes"), is("]")] },
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
  // Svelte's internal modules hand out the very primitives these rules refuse (`set_style`,
  // `set_attribute`, `html`): no string may name one, whether it is an import, a re-export or an
  // `import()`; and an `import()` must name a plain string, or nothing here could check it.
  for (const t of tokens) {
    const m = STRING_KINDS.has(t.kind) ? /^svelte\/(internal|legacy)(\/|$)/.exec(t.value) : null;
    if (m) found.add(`svelte/${m[1]}`);
  }
  tokens.forEach((t, i) => {
    if (t.text !== "import" || tokens[i + 1]?.text !== "(") return;
    const arg = tokens[i + 2];
    if (!arg || !STRING_KINDS.has(arg.kind) || tokens[i + 3]?.text !== ")") found.add("import() of a computed module");
  });
  return [...found].sort();
}

/* ── geometry helpers (Step 0's style rule) ───────────────────────────────────────────────────── */

/** Whether code CALLS both `Math.min(` and `Math.max(` (tokens, so a comment does not count). */
function clamps(code: string, where: string): boolean {
  const t = moduleTokens(code, where);
  const calls = (fn: string) => t.some((_, i) => t[i]?.text === "Math" && t[i + 1]?.text === "." && t[i + 2]?.text === fn && t[i + 3]?.text === "(");
  return calls("min") && calls("max");
}

/**
 * The helpers a module exports, each with whether its own declaration clamps (calls both
 * `Math.min(` and `Math.max(`: presence, not proof of a clamped result). Only `export function f` and
 * `export const f = …` are read; type-only exports (`export type`, `export interface`,
 * `export type { … }`) are not values and are skipped; any other export form is listed as a helper
 * that does not clamp, so it fails the check rather than slipping past it.
 */
export function geometryHelpers(source: string): { name: string; clamps: boolean }[] {
  const sf = ts.createSourceFile("geometry.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: { name: string; clamps: boolean }[] = [];
  const exported = (s: ts.Statement) =>
    ts.isExportDeclaration(s) ||
    ts.isExportAssignment(s) ||
    (ts.canHaveModifiers(s) && (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  const typeOnly = (s: ts.Statement) =>
    ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s) || (ts.isExportDeclaration(s) && s.isTypeOnly);
  for (const s of sf.statements) {
    if (!exported(s) || typeOnly(s)) continue;
    if (ts.isFunctionDeclaration(s) && s.name) {
      out.push({ name: s.name.text, clamps: clamps(s.getText(sf), "geometry.ts") });
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        out.push({ name: ts.isIdentifier(d.name) ? d.name.text : "(an export this check does not read)", clamps: clamps(d.getText(sf), "geometry.ts") });
      }
    } else {
      out.push({ name: "(an export this check does not read)", clamps: false });
    }
  }
  return out;
}

/** `lib/ui/geometry.ts`'s exports, read at test time. */
const GEOMETRY_HELPERS = geometryHelpers(readFileSync(GEOMETRY_SRC, "utf8"));
/** The only calls a style directive or a geometry expression may hold: the helpers that clamp. */
const CLAMPING_HELPERS: ReadonlySet<string> = new Set(GEOMETRY_HELPERS.filter((h) => h.clamps).map((h) => h.name));

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

/** A template value (an attribute's or a directive's) as its parts: `true` (no value) is none. */
const valueParts = (value: unknown): Node[] => (Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : []);

/** The names an ESTree binding pattern binds. */
function patternNames(p: unknown): string[] {
  const x = p as { type?: string; name?: unknown; properties?: unknown[]; elements?: unknown[]; argument?: unknown; left?: unknown };
  switch (x?.type) {
    case "Identifier":
      return [String(x.name)];
    case "ObjectPattern":
      return (x.properties ?? []).flatMap((q) => {
        const r = q as { type?: string; value?: unknown; argument?: unknown };
        return patternNames(r.type === "RestElement" ? r.argument : r.value);
      });
    case "ArrayPattern":
      return (x.elements ?? []).flatMap(patternNames);
    case "RestElement":
      return patternNames(x.argument);
    case "AssignmentPattern":
      return patternNames(x.left);
    default:
      return [];
  }
}

/** Every name a template binds: `{#each}` items and indexes, snippet parameters, `let:`, `{@const}`,
 *  `{#await}` results, and (conservatively) the parameters of any function written in it. */
function templateBindings(root: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown): void => {
    if (typeof v !== "object" || v === null || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) return v.forEach(visit);
    const n = v as Record<string, unknown> & { type?: string };
    switch (n.type) {
      case "EachBlock":
        out.push(...patternNames(n.context));
        if (typeof n.index === "string") out.push(n.index);
        break;
      case "SnippetBlock":
        out.push(...((n.parameters as unknown[] | undefined) ?? []).flatMap(patternNames));
        break;
      case "LetDirective":
        out.push(...(n.expression ? patternNames(n.expression) : [String(n.name)]));
        break;
      case "ConstTag":
        out.push(...(((n.declaration as { declarations?: { id: unknown }[] })?.declarations ?? []).flatMap((d) => patternNames(d.id))));
        break;
      case "AwaitBlock":
        out.push(...patternNames(n.value), ...patternNames(n.error));
        break;
      case "ArrowFunctionExpression":
      case "FunctionExpression":
      case "FunctionDeclaration":
        out.push(...((n.params as unknown[] | undefined) ?? []).flatMap(patternNames));
        break;
    }
    for (const [k, child] of Object.entries(n)) if (k !== "metadata" && k !== "loc") visit(child);
  };
  visit(root);
  return out;
}

/** What a `<script>` binds: its imports (local name, imported name, specifier) and every other name. */
function scriptBindings(code: string, where: string): { imports: { local: string; imported: string; from: string }[]; names: string[] } {
  const sf = ts.createSourceFile(where, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: { local: string; imported: string; from: string }[] = [];
  const names: string[] = [];
  const bound = (n: ts.BindingName): string[] =>
    ts.isIdentifier(n) ? [n.text] : n.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bound(e.name)));
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const from = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
      const clause = node.importClause;
      // A type-only import binds no value: never a helper or a transition.
      if (!clause || clause.isTypeOnly) return;
      if (clause.name) imports.push({ local: clause.name.text, imported: "default", from });
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) imports.push({ local: nb.name.text, imported: "*", from });
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) if (!el.isTypeOnly) imports.push({ local: el.name.text, imported: (el.propertyName ?? el.name).text, from });
      }
      return;
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) names.push(...bound(node.name));
    else if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { imports, names };
}

const GEOMETRY_BASE = GEOMETRY_SRC.replace(/\.ts$/, "");

/** What a component contains that this check refuses. `helpers` are the geometry exports it accepts. */
export function componentOffences(source: string, where: string, helpers: ReadonlySet<string> = CLAMPING_HELPERS): string[] {
  const ast = parse(source, { modern: true }) as unknown as {
    fragment: Node;
    instance?: { content: Node } | null;
    module?: { content: Node } | null;
    options?: { namespace?: string } | null;
    css?: { attributes?: unknown[] } | null;
  };
  // Which local names are the real geometry helpers, and the real Svelte transitions: bound once, by
  // an import from the right module, and bound nowhere else in the component.
  const scripts = [ast.instance, ast.module].flatMap((s) =>
    s ? [scriptBindings(source.slice(s.content.start, s.content.end), `${where} <script>`)] : [],
  );
  const imports = scripts.flatMap((s) => s.imports);
  const elsewhere = new Set([...scripts.flatMap((s) => s.names), ...templateBindings(ast.fragment)]);
  const once = (local: string) => !elsewhere.has(local) && imports.filter((i) => i.local === local).length === 1;
  const fromGeometry = (spec: string) => spec.startsWith(".") && resolve(dirname(where), spec).replace(/\.(ts|js)$/, "") === GEOMETRY_BASE;
  const named = (i: { imported: string }) => i.imported !== "default" && i.imported !== "*";
  const helperLocals = new Set(imports.filter((i) => fromGeometry(i.from) && helpers.has(i.imported) && once(i.local)).map((i) => i.local));
  /** Local name → imported name, for the accepted functions of one Svelte module. */
  const localsFrom = (mod: string, accepted: Record<string, readonly string[]>) =>
    new Map(imports.filter((i) => i.from === mod && named(i) && Object.hasOwn(accepted, i.imported) && once(i.local)).map((i) => [i.local, i.imported]));
  const transitions = localsFrom("svelte/transition", TRANSITION_TEXT_KEYS);
  const animations = localsFrom("svelte/animate", ANIMATE_TEXT_KEYS);

  /** A call to an accepted helper, `helper(…)`, by the name its geometry import bound. */
  const isHelperCall = (e: unknown): boolean => {
    const x = e as { type?: string; callee?: { type?: string; name?: string } };
    return x?.type === "CallExpression" && x.callee?.type === "Identifier" && helperLocals.has(String(x.callee.name));
  };
  /** A number literal, or a minus sign on one. */
  const isNumber = (e: unknown): boolean => {
    const x = e as { type?: string; value?: unknown; operator?: string; argument?: unknown };
    if (x?.type === "UnaryExpression" && x.operator === "-") return isNumber(x.argument);
    return x?.type === "Literal" && typeof x.value === "number";
  };
  /** A number, a helper call, or a conditional whose every branch is one of these (recursively). */
  const isAcceptable = (e: unknown): boolean => {
    const x = e as { type?: string; consequent?: unknown; alternate?: unknown };
    if (x?.type === "ConditionalExpression") return isAcceptable(x.consequent) && isAcceptable(x.alternate);
    return isNumber(e) || isHelperCall(e);
  };
  /** A value that is exactly one `{helper(…)}`, quoted or not. */
  const isOneHelperCall = (value: unknown): boolean => {
    const parts = valueParts(value);
    return parts.length === 1 && parts[0]!.type === "ExpressionTag" && isHelperCall(parts[0]!.expression);
  };
  /** An accepted transition's parameter: free unless the function puts some keys into CSS as text,
   *  in which case it must be an object literal whose text keys are acceptable (no spread, no
   *  computed or quoted keys, no shorthand). */
  const paramsOk = (textKeys: readonly string[], expression: unknown): boolean => {
    if (textKeys.length === 0 || expression === null || expression === undefined) return true;
    const obj = expression as { type?: string; properties?: unknown[] };
    if (obj.type !== "ObjectExpression") return false;
    return (obj.properties ?? []).every((p) => {
      const prop = p as { type?: string; computed?: boolean; key?: { type?: string; name?: string }; value?: unknown };
      if (prop.type !== "Property" || prop.computed || prop.key?.type !== "Identifier") return false;
      return !textKeys.includes(String(prop.key.name)) || isAcceptable(prop.value);
    });
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
  /** `inSvg`: the node is an SVG element, inside one, or an attribute of one. */
  const walk = (node: Node, parent: Node | null, inSvg: boolean): void => {
    if (!TEMPLATE_TYPES.has(node.type)) {
      throw new Error(`${where}:${node.start}: template node type ${node.type} is unknown to static.check.ts`);
    }
    let svg = inSvg;
    const name = String(node.name);
    switch (node.type) {
      case "HtmlTag":
        found.push("{@html}");
        break;
      case "SvelteElement":
        found.push("<svelte:element>");
        break;
      case "RegularElement":
        if (BANNED_ELEMENTS.has(name.toLowerCase())) found.push(`<${name}>`);
        svg = inSvg || isSvgElement(name);
        break;
      case "Attribute":
      case "BindDirective":
        if (BANNED_ATTRIBUTES.has(name.toLowerCase())) {
          found.push(`${node.type === "BindDirective" ? "bind:" : ""}${name}=`);
        }
        if (node.type !== "Attribute") break;
        // Step 0's style rule (hub spec, "Constraints"): no style attribute in any form, static text
        // included — the only allowed style is a custom property from a geometry helper.
        if (name.toLowerCase() === "style") found.push("style=");
        // A component's `--x` becomes an inline style: only `--x={helper(…)}`.
        if (parent !== null && CSS_PROP_TARGETS.has(parent.type) && name.startsWith("--") && !isOneHelperCall(node.value)) found.push(`${name}=`);
        // Inside SVG every attribute is geometry or paint unless exempt; outside it, a table's width and
        // height are presentational sizes. Static text is fine (an icon's `d="M…"`); every expression
        // must be a number literal, a call to a clamping helper, or a conditional of those.
        if (
          parent?.type === "RegularElement" &&
          ((inSvg && !svgExempt(name)) ||
            (!inSvg && TABLE_SIZED.has(String(parent.name).toLowerCase()) && ["width", "height"].includes(name.toLowerCase())))
        ) {
          const exprs = valueParts(node.value).filter((p) => p.type === "ExpressionTag");
          if (exprs.some((p) => !isAcceptable(p.expression))) found.push(`${name}={…}`);
        }
        break;
      case "StyleDirective":
        // `style:--x={helper(…)}` only: a custom property, whose value is ONE call to a clamping helper.
        if (!name.startsWith("--") || !isOneHelperCall(node.value)) found.push(`style:${name}=`);
        break;
      case "TransitionDirective": {
        // A custom transition can return `{ css: () => anyString }`: only Svelte's own; and even
        // Svelte's `fly` and `blur` splice a string parameter's unit into the CSS (see TRANSITION_TEXT_KEYS).
        const kind = node.intro && node.outro ? "transition" : node.intro ? "in" : "out";
        const fn = transitions.get(name);
        if (fn === undefined || !paramsOk(TRANSITION_TEXT_KEYS[fn]!, node.expression)) found.push(`${kind}:${name}`);
        break;
      }
      case "AnimateDirective": {
        const fn = animations.get(name);
        if (fn === undefined || !paramsOk(ANIMATE_TEXT_KEYS[fn]!, node.expression)) found.push(`animate:${name}`);
        break;
      }
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
      // foreignObject's own attributes are SVG; its children are HTML again (until another <svg>).
      const childSvg = node.type === "RegularElement" && name === "foreignObject" && key === "fragment" ? false : svg;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) walk(child, node, childSvg);
        else if (typeof child === "object" && child !== null && key !== "value") {
          throw new Error(`${where}:${node.start}: ${node.type}.${key} holds an object this check does not read`);
        }
      }
    }
  };
  walk(ast.fragment, null, ast.options?.namespace === "svg");
  // The component's own <style> takes no attributes (svelte 5.57 ignores `bind:this` there, measured;
  // refusing any attribute keeps it from becoming a handle if that ever changes).
  if ((ast.css?.attributes ?? []).length > 0) found.push("<style>");
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

  test("exactly one file under gui/src is named geometry.*, the .ts the helper list is read from", () => {
    // `fromGeometry` accepts an import with or without an extension; a second `geometry.js` beside it
    // could be what the bundler resolves while the helper list is read from `geometry.ts`.
    const named = files(SRC).filter((p) => /^geometry\.[^/]+$/.test(p.split("/").pop()!));
    expect(named).toEqual([GEOMETRY_SRC]);
  });

  test("every export of lib/ui/geometry.ts is a clamping helper, and there is at least one", () => {
    expect(GEOMETRY_HELPERS.length).toBeGreaterThan(0);
    expect(GEOMETRY_HELPERS.filter((h) => !h.clamps)).toEqual([]);
    expect(GEOMETRY_HELPERS.map((h) => h.name)).toContain("clampPct");
    expect(GEOMETRY_HELPERS.map((h) => h.name)).toContain("clampInt");
  });

  test("the svelte the transition table was read from is the one installed: an upgrade fails here and forces a re-read", () => {
    const named = /\(svelte (\d+\.\d+\.\d+)\)/.exec(readFileSync(SELF, "utf8"))?.[1];
    const installed = (JSON.parse(readFileSync(new URL("../node_modules/svelte/package.json", import.meta.url).pathname, "utf8")) as { version: string }).version;
    expect(named).toBe("5.57.0");
    expect(installed).toBe(named!);
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

  /* Step 0's style rule. Planted sources sit at `gui/src/lib/planted.svelte`, so a relative import
     resolves the way a real component's does; `GEO` is the one import that makes `clampPct` a helper. */
  const PLANTED = join(SRC, "lib", "planted.svelte");
  const lib = (s: string) => componentOffences(s, PLANTED);
  const GEO = '<script lang="ts">import { clampPct } from "./ui/geometry";</script>\n';

  test("Step 0's style rule: the only style is a custom property from a clamping geometry helper", () => {
    // Allowed: a custom property whose value is ONE call to the imported helper, quoted or not.
    expect(lib(GEO + "<div style:--w={clampPct(n, 10)}></div>")).toEqual([]);
    expect(lib(GEO + '<div style:--w="{clampPct(n, 10)}"></div>')).toEqual([]);
    // …and the whole-number helper, for a count (A's deck track: the slide count).
    expect(lib('<script lang="ts">import { clampInt } from "./ui/geometry";</script>\n<div style:--n={clampInt(count, 12)}></div>')).toEqual([]);
    // Refused: any other value, any other property, the shorthand, and a static value.
    expect(lib(GEO + "<div style:--w={label}></div>")).toEqual(["style:--w="]);
    expect(lib(GEO + "<div style:--w={clampPct(n, 10) + label}></div>")).toEqual(["style:--w="]);
    expect(lib(GEO + '<div style:--w="{clampPct(n, 10)}px"></div>')).toEqual(["style:--w="]);
    expect(lib(GEO + "<div style:--w={notAHelper(n)}></div>")).toEqual(["style:--w="]);
    expect(lib(GEO + '<div style:--w="40"></div>')).toEqual(["style:--w="]);
    expect(lib(GEO + "<div style:--w></div>")).toEqual(["style:--w="]);
    expect(lib(GEO + "<div style:color={c}></div>")).toEqual(["style:color="]);
    expect(lib(GEO + "<div style:color={clampPct(n, 10)}></div>")).toEqual(["style:color="]);
    expect(lib(GEO + "<div style:color|important={clampPct(n, 10)}></div>")).toEqual(["style:color="]);
    // Refused: a style attribute in any form, static text included, on an element or a component.
    expect(lib(GEO + '<div style="color: red"></div>')).toEqual(["style="]);
    expect(lib(GEO + "<div style={s}></div>")).toEqual(["style="]);
    expect(lib(GEO + '<div STYLE="color: red"></div>')).toEqual(["style="]);
    expect(lib(GEO + '<div style="--w: {clampPct(n, 10)}"></div>')).toEqual(["style="]);
    expect(lib(GEO + '<Comp style="color: red" />')).toEqual(["style="]);
  });

  test("Step 0's style rule: a helper counts only when it is the import from lib/ui/geometry (no look-alike)", () => {
    const refused = (s: string) => expect({ s, got: lib(s) }).toEqual({ s, got: ["style:--w="] });
    const accepted = (s: string) => expect({ s, got: lib(s) }).toEqual({ s, got: [] });
    const USE = "<div style:--w={clampPct(n, 10)}></div>";
    refused(USE); // not imported at all
    refused(`<script lang="ts">const clampPct = (s: string) => s;</script>${USE}`);
    refused(`<script lang="ts">function clampPct(s: string) { return s; }</script>${USE}`);
    refused(`<script module lang="ts">const clampPct = (s: string) => s;</script>${USE}`);
    refused(`<script lang="ts">import { clampPct } from "./evil";</script>${USE}`);
    refused(`<script lang="ts">import { clampPct } from "../ui/geometry";</script>${USE}`); // a different path
    refused(`<script lang="ts">import { identity as clampPct } from "./ui/geometry";</script>${USE}`);
    refused(`<script lang="ts">import clampPct from "./ui/geometry";</script>${USE}`);
    refused(`<script lang="ts">import { clampPct } from "./ui/geometry"; const f = (clampPct: number) => clampPct;</script>${USE}`);
    // (A second top-level `clampPct` is a parse error; a nested one, however deep, still refuses.)
    refused(`<script lang="ts">import { clampPct } from "./ui/geometry"; function g(o: any) { let { a: [clampPct] } = o; return clampPct; }</script>${USE}`);
    refused(`${GEO}<button onclick={(clampPct) => clampPct}>b</button>${USE}`);
    refused(`${GEO}{#each fns as clampPct}${USE}{/each}`);
    refused(`${GEO}{#each fns as { clampPct }}${USE}{/each}`);
    refused(`${GEO}{#each xs as x, clampPct}${USE}{/each}`);
    refused(`${GEO}{#snippet s(clampPct)}${USE}{/snippet}`);
    refused(`${GEO}<Comp let:clampPct>${USE}</Comp>`);
    refused(`${GEO}{#if ok}{@const clampPct = (s) => s}${USE}{/if}`);
    refused(`${GEO}{#await p then clampPct}${USE}{/await}`);
    refused(`${GEO}{#await p}x{:catch clampPct}${USE}{/await}`);
    refused('<script lang="ts">import * as g from "./ui/geometry";</script><div style:--w={g.clampPct(n, 10)}></div>');
    // Accepted: the real import, by alias, with the extension, or by another path to the same file.
    accepted(`${GEO}${USE}`);
    accepted('<script lang="ts">import { clampPct as pct } from "./ui/geometry";</script><div style:--w={pct(n, 10)}></div>');
    accepted(`<script lang="ts">import { clampPct } from "./ui/geometry.ts";</script>${USE}`);
    accepted(`<script lang="ts">import { clampPct } from "../lib/ui/geometry";</script>${USE}`);
    // A renamed destructure binds the NEW name, so the import is still the only `clampPct`.
    accepted(`<script lang="ts">import { clampPct } from "./ui/geometry"; let { clampPct: c } = $props();</script>${USE}`);
  });

  test("Step 0's style rule: a component's CSS custom property (an inline style) only from a helper", () => {
    expect(lib(GEO + "<Comp --w={clampPct(n, 10)} />")).toEqual([]);
    expect(lib(GEO + "<Comp --w={label} />")).toEqual(["--w="]);
    expect(lib(GEO + '<Comp --w="red" />')).toEqual(["--w="]);
    expect(lib(GEO + '<Comp --w="{clampPct(n, 10)}%" />')).toEqual(["--w="]);
    expect(lib(GEO + "<svelte:self --w={label} />")).toEqual(["--w="]);
    expect(lib(GEO + "<svelte:component this={C} --w={label} />")).toEqual(["--w="]);
    expect(lib(GEO + '<svelte:element this="div" --w={label}></svelte:element>')).toEqual(["<svelte:element>", "--w="]);
  });

  test("Step 0's style rule: inside SVG every expression attribute is a number or a helper call", () => {
    const ok = (s: string) => expect({ s, got: lib(GEO + s) }).toEqual({ s, got: [] });
    const no = (s: string, ...want: string[]) => expect({ s, got: lib(GEO + s) }).toEqual({ s, got: want });
    // Static text stays allowed (an icon's d and points); numbers, negative numbers and helper calls too.
    ok('<svg viewBox="0 0 10 10"><path d="M0 0L10 10" /></svg>');
    ok('<svg><polyline points="0,0 5,5 10,0" /></svg>');
    ok("<svg><rect width={clampPct(n, 10)} height={4} x={0} y={-2.5} /></svg>");
    ok("<svg><circle cx={clampPct(i, n)} cy={5} r={3} /></svg>");
    // The exempt names, and text content (a text node, not an attribute).
    ok('<svg class={c} role="img" aria-label={label} id={id} data-k={k} onclick={f}><title>{label}</title><text x={0}>{label}</text></svg>');
    // Refused: any other expression, on any attribute, on the svg itself and its children.
    no("<svg><path d={label} /></svg>", "d={…}");
    no('<svg><path d="M{label} 0" /></svg>', "d={…}");
    no("<svg><rect width={n} /></svg>", "width={…}");
    no('<svg><rect width={clampPct(n, 10) + "%"} /></svg>', "width={…}");
    no("<svg><rect width={-n} /></svg>", "width={…}");
    no('<svg><line x1={a} y1={0} x2={clampPct(b, 4)} y2="1" /></svg>', "x1={…}");
    no("<svg><polyline points={pts} /></svg>", "points={…}");
    no("<svg><g transform={t}></g></svg>", "transform={…}");
    no("<svg viewBox={vb}></svg>", "viewBox={…}");
    no("<svg width={w}></svg>", "width={…}");
    no("<svg><rect rx={r} fill={c} stroke-dasharray={d} /></svg>", "rx={…}", "fill={…}", "stroke-dasharray={…}");
    no('<svg><rect><animate attributeName="x" to={label} /></rect></svg>', "to={…}");
    // An SVG element outside an <svg> (a component that is only a path) is SVG too.
    no("<path d={label} />", "d={…}");
    no("<g><rect height={h} /></g>", "height={…}");
    // A component compiled in the SVG namespace is SVG throughout, even under a name this list lacks.
    no('<svelte:options namespace="svg" /><my-shape width={n} />', "width={…}");
    ok("<my-shape width={n} />");
    // Outside SVG nothing here is a style sink: no geometry rule.
    ok("<canvas width={n} height={h}></canvas>");
    ok("<input size={n} />");
    ok("<Bar width={n} d={label} />");
  });

  test("Step 0's style rule: a geometry helper must clamp, and only geometry.ts's value exports count", () => {
    const bad = geometryHelpers("export function grow(n: number): number { return n * 2; }");
    expect(bad).toEqual([{ name: "grow", clamps: false }]);
    expect(geometryHelpers("export function half(n: number) { return Math.min(100, n); }")).toEqual([{ name: "half", clamps: false }]);
    expect(geometryHelpers("export const c = (n: number) => Math.min(100, Math.max(0, n));")).toEqual([{ name: "c", clamps: true }]);
    // A clamp mentioned only in a comment is not a clamp.
    expect(geometryHelpers("// Math.min( Math.max(\nexport function f(n: number) { return n; }")).toEqual([{ name: "f", clamps: false }]);
    // Each export is judged by its OWN declaration: a clamping neighbour does not make another clamp.
    const clampFirst = "export function a(n: number) { return Math.min(1, Math.max(0, n)); }\n";
    expect(geometryHelpers(`${clampFirst}export function b(n: number) { return n; }`)).toEqual([{ name: "a", clamps: true }, { name: "b", clamps: false }]);
    expect(geometryHelpers(`${clampFirst}export const b = (n: number) => n;`)).toEqual([{ name: "a", clamps: true }, { name: "b", clamps: false }]);
    expect(geometryHelpers("export const a = (n: number) => Math.min(1, Math.max(0, n)), b = (n: number) => n;")).toEqual([{ name: "a", clamps: true }, { name: "b", clamps: false }]);
    // An export form this check does not read is never a helper; a type-only export is not a value.
    expect(geometryHelpers("const g = 1;\nexport { g };")).toEqual([{ name: "(an export this check does not read)", clamps: false }]);
    expect(geometryHelpers("export type P = number;\nexport interface Q { a: number }\ntype R = 1;\nexport type { R };\nexport function c(n: number) { return Math.min(1, Math.max(0, n)); }")).toEqual([{ name: "c", clamps: true }]);
    // With only an unclamped helper on offer, its call is refused, even when imported from geometry.ts.
    const unclamped = new Set(bad.filter((h) => h.clamps).map((h) => h.name));
    const GROW = '<script lang="ts">import { grow } from "./ui/geometry";</script>';
    expect(componentOffences(`${GROW}<div style:--w={grow(n)}></div>`, PLANTED, unclamped)).toEqual(["style:--w="]);
    expect(componentOffences(`${GROW}<svg><rect width={grow(n)} /></svg>`, PLANTED, unclamped)).toEqual(["width={…}"]);
  });

  test("Step 0's style rule: no script writes a style (element style, CSSOM)", () => {
    expect(mod("el.style.cssText = s")).toEqual(["cssText", "style"]);
    expect(mod("el.style.setProperty('--w', s)")).toEqual(["setProperty", "style"]);
    expect(mod("node.style.width = s")).toEqual(["style"]);
    expect(mod("el.style = s")).toEqual(["style"]);
    expect(mod("el?.style.color = s")).toEqual(["style"]);
    expect(mod('el["style"].color = s')).toEqual(["style"]);
    expect(mod("sheet.insertRule(r)")).toEqual(["insertRule"]);
    expect(mod("document.adoptedStyleSheets = [s]")).toEqual(["adoptedStyleSheets"]);
    expect(mod("const s = new CSSStyleSheet()")).toEqual(["CSSStyleSheet"]);
    expect(mod("document.styleSheets[0]")).toEqual(["styleSheets"]);
    expect(svelte('<script lang="ts">const act = (n: HTMLElement) => { n.style.color = c; };</script><div use:act></div>')).toEqual(["style"]);
    expect(svelte("<div {@attach (n) => { n.style.width = w; }}></div>")).toEqual(["style"]);
    expect(svelte("<button onclick={(e) => e.currentTarget.style.setProperty('--w', s)}>b</button>")).toEqual(["setProperty", "style"]);
  });

  test("Step 0's style rule: `style` itself, attribute nodes and Web Animations are refused in code", () => {
    // Refused: every route to an inline style that does not spell `.style` (review round 2).
    expect(mod("const { style } = el; style.color = c;")).toEqual(["style"]);
    expect(mod("Object.assign(el, { style: s })")).toEqual(["style"]);
    expect(mod('Reflect.set(el, "style", s)')).toEqual(["style"]);
    expect(mod("const k = `style`; el[k] = s;")).toEqual(["style"]);
    expect(mod('const a = document.createAttribute("style"); a.value = s; el.attributes.setNamedItem(a);')).toEqual([".attributes", "createAttribute", "setNamedItem", "style"]);
    expect(mod('el.attributes.getNamedItem("style").value = s')).toEqual([".attributes", "getNamedItem", "style"]);
    expect(mod("el.attributes.item(0).value = s")).toEqual([".attributes"]);
    expect(mod('el["attributes"][0].value = s')).toEqual(['["attributes"]']);
    expect(mod("el.attributes.setNamedItemNS(a)")).toEqual([".attributes", "setNamedItemNS"]);
    expect(mod("document.createAttributeNS(null, k)")).toEqual(["createAttributeNS"]);
    expect(mod("el.getAttributeNode(k).value = s")).toEqual(["getAttributeNode"]);
    expect(mod('el.attributeStyleMap.set("color", s)')).toEqual(["attributeStyleMap"]);
    expect(mod("el.animate([{ color: s }], 300)")).toEqual([".animate"]);
    expect(mod("el?.animate([{ color: s }])")).toEqual([".animate"]);
    expect(mod('el["animate"]([{ color: s }])')).toEqual(['["animate"]']);
    expect(mod("Element.prototype.animate.call(el, k)")).toEqual([".animate"]);
    expect(svelte("<div {@attach (n) => { n.animate([{ color: c }], 300); }}></div>")).toEqual([".animate"]);
    // Accepted: the neighbours that only share a spelling.
    expect(mod('import { flip } from "svelte/animate";')).toEqual([]);
    expect(svelte('<script lang="ts">import { flip } from "svelte/animate";</script>{#each xs as x (x)}<div animate:flip></div>{/each}')).toEqual([]);
    expect(mod("const animate = true; const lifestyle = 1; const s = \"styles\"; const styled = 2;")).toEqual([]);
    expect(svelte("<p>style</p><style>p { color: red; }</style>")).toEqual([]);
  });

  test("Step 0's style rule: no module under svelte/internal or svelte/legacy, and no computed import()", () => {
    expect(mod('import { set_style, set_attribute, html } from "svelte/internal/client";')).toEqual(["svelte/internal"]);
    expect(mod('import * as i from "svelte/internal";')).toEqual(["svelte/internal"]);
    expect(mod('export { html } from "svelte/internal/server";')).toEqual(["svelte/internal"]);
    expect(mod('const m = await import("svelte/internal/client");')).toEqual(["svelte/internal"]);
    expect(mod('import { run } from "svelte/legacy";')).toEqual(["svelte/legacy"]);
    expect(mod('const m = await import("svelte/" + x);')).toEqual(["import() of a computed module"]);
    expect(mod("const m = await import(`svelte/${x}`);")).toEqual(["import() of a computed module"]);
    expect(mod("const m = await import(spec);")).toEqual(["import() of a computed module"]);
    expect(svelte('<script lang="ts">import { set_attribute } from "svelte/internal/client";</script>')).toEqual(["svelte/internal"]);
    // Accepted: Svelte's public modules, a plain lazy import, and a look-alike name.
    expect(mod('import { mount } from "svelte"; import { fade } from "svelte/transition"; import { flip } from "svelte/animate";')).toEqual([]);
    expect(mod('const m = await import("./lazy");')).toEqual([]);
    expect(mod('const w = "svelte/internals-explained";')).toEqual([]);
  });

  test("Step 0's style rule: Svelte's own transitions — a parameter that reaches CSS as text must be a number or a helper call", () => {
    // Read from node_modules/svelte/src/transition/index.js: `fly` passes `x` and `y`, and `blur` passes
    // `amount`, through split_css_unit, whose unit (`[^\s]*`) is spliced into the CSS text. Every other
    // parameter of every accepted function (fade, fly, blur, slide, scale, draw; animate's flip) only
    // reaches arithmetic (`delay`, `duration`, `easing`, `opacity`, `start`, `speed`) or a fixed choice
    // (`slide`'s `axis`). `crossfade` is a factory, not a transition, and is refused as a directive.
    const FX =
      '<script lang="ts">import { fade, fly, blur, slide, scale, draw, crossfade } from "svelte/transition"; import { flip } from "svelte/animate"; import { clampPct } from "./ui/geometry";</script>';
    const ok = (s: string) => expect({ s, got: lib(FX + s) }).toEqual({ s, got: [] });
    const no = (s: string, ...want: string[]) => expect({ s, got: lib(FX + s) }).toEqual({ s, got: want });
    ok("<div in:fly={{ y: 8, duration: d, easing: e, opacity: o, delay: t }}></div>");
    ok("<div in:fly={{ x: -8 }}></div>");
    ok("<div in:fly={{ y: clampPct(n, 10) }}></div>");
    ok("<div in:fly={{ y: open ? 8 : -8 }}></div>");
    ok("<div in:fly></div>");
    ok("<div transition:blur={{ amount: 4, duration: d }}></div>");
    ok("<div in:fade={opts}></div>");
    ok("<div in:slide={{ axis: a, duration: d }}></div>");
    ok("<div in:scale={{ start: s, opacity: o }}></div>");
    ok("{#each xs as x (x)}<div animate:flip={opts}></div>{/each}");
    ok('<svg><path in:draw={opts} d="M0 0" /></svg>');
    no("<div in:fly={{ y: label }}></div>", "in:fly");
    no('<div in:fly={{ x: "8px; color: red" }}></div>', "in:fly");
    no('<div out:fly={{ y: n + "px" }}></div>', "out:fly");
    no("<div in:fly={{ y }}></div>", "in:fly");
    no("<div in:fly={opts}></div>", "in:fly");
    no("<div in:fly={{ ...opts }}></div>", "in:fly");
    no('<div in:fly={{ ["y"]: label }}></div>', "in:fly");
    no('<div in:fly={{ "y": label }}></div>', "in:fly");
    no("<div in:fly={{ y: open ? label : 8 }}></div>", "in:fly");
    no("<div transition:blur={{ amount: label }}></div>", "transition:blur");
    no("<div transition:blur={o}></div>", "transition:blur");
    no("<div in:crossfade={{ key: k }}></div>", "in:crossfade");
  });

  test("Step 0's style rule: transitions and animations only from svelte/transition and svelte/animate", () => {
    const FX = '<script lang="ts">import { fade, slide, fly } from "svelte/transition"; import { flip } from "svelte/animate";</script>';
    expect(svelte(`${FX}{#each xs as x (x)}<div transition:fade in:fly={{ y: 4 }} out:slide animate:flip></div>{/each}`)).toEqual([]);
    expect(svelte('<script lang="ts">import type { fade } from "svelte/transition";</script><div transition:fade></div>')).toEqual(["transition:fade"]);
    const MY = '<script lang="ts">const my = () => ({ css: () => label });</script>';
    expect(svelte(`${MY}<div transition:my></div>`)).toEqual(["transition:my"]);
    expect(svelte(`${MY}<div in:my></div>`)).toEqual(["in:my"]);
    expect(svelte(`${MY}<div out:my></div>`)).toEqual(["out:my"]);
    expect(svelte('<script lang="ts">const flip = () => ({ css: () => label });</script>{#each xs as x (x)}<div animate:flip></div>{/each}')).toEqual(["animate:flip"]);
    expect(svelte('<script lang="ts">import { fade } from "./fx";</script><div transition:fade></div>')).toEqual(["transition:fade"]);
    expect(svelte('<script lang="ts">import { flip } from "svelte/transition";</script>{#each xs as x (x)}<div animate:flip></div>{/each}')).toEqual(["animate:flip"]);
    expect(svelte(`${FX}{#each fns as fade}<div transition:fade></div>{/each}`)).toEqual(["transition:fade"]);
    expect(svelte('<script lang="ts">import * as fx from "svelte/transition";</script><div transition:fx.fade></div>')).toEqual(["transition:fx.fade"]);
    // A name every object inherits is not one of the accepted functions.
    expect(svelte('<script lang="ts">import { toString, constructor } from "svelte/transition";</script><div in:toString></div><div out:constructor></div>')).toEqual(["in:toString", "out:constructor"]);
    expect(svelte('<script lang="ts">import { valueOf } from "svelte/animate";</script>{#each xs as x (x)}<div animate:valueOf></div>{/each}')).toEqual(["animate:valueOf"]);
  });

  test("Step 0's style rule: SVG holds image and inheritance; HTML under foreignObject is HTML again; a conditional of acceptable values is acceptable", () => {
    const ok = (s: string) => expect({ s, got: lib(GEO + s) }).toEqual({ s, got: [] });
    const no = (s: string, ...want: string[]) => expect({ s, got: lib(GEO + s) }).toEqual({ s, got: want });
    no("<svg><image width={n} /></svg>", "width={…}");
    no("<image width={n} />", "width={…}");
    no("<svg><my-shape width={n} /></svg>", "width={…}"); // not an SVG name: refused by inheritance alone
    no("<svg><g><g><my-shape cx={n} /></g></g></svg>", "cx={…}");
    // foreignObject's own attributes are SVG geometry; its HTML children are HTML (no SVG rule)...
    no("<svg><foreignObject width={n} x={0}><div title={label}><span class={c}>{label}</span></div></foreignObject></svg>", "width={…}");
    ok("<svg><foreignObject width={4} height={2}><p title={label}>x</p></foreignObject></svg>");
    // ...until an <svg> inside it starts the rule again.
    no("<svg><foreignObject width={4}><svg><rect width={n} /></svg></foreignObject></svg>", "width={…}");
    // A conditional whose every branch is acceptable is acceptable (recursively).
    ok("<svg><rect opacity={open ? 1 : 0.4} tabindex={open ? 0 : -1} width={open ? clampPct(a, b) : 0} /></svg>");
    ok("<svg><rect x={a ? (b ? 1 : -2) : clampPct(c, d)} /></svg>");
    no("<svg><rect opacity={open ? label : 1} /></svg>", "opacity={…}");
    no("<svg><rect x={a ? (b ? 1 : label) : 2} /></svg>", "x={…}");
  });

  test("Step 0's style rule: presentational HTML attributes, table sizes, and a <style> element in markup", () => {
    const ok = (s: string) => expect({ s, got: lib(GEO + s) }).toEqual({ s, got: [] });
    const no = (s: string, ...want: string[]) => expect({ s, got: lib(GEO + s) }).toEqual({ s, got: want });
    // Presentational attributes map to CSS; refused in any form (as the URL attributes are).
    no("<table><tbody><tr><td bgcolor={label}>x</td></tr></tbody></table>", "bgcolor=");
    no("<p><font color={label} face={f}>x</font></p>", "color=", "face=");
    no('<math><mi mathcolor={c} mathbackground="red" mathsize={s}>x</mi></math>', "mathcolor=", "mathbackground=", "mathsize=");
    no('<table border={b} cellpadding="2" cellspacing={c}><tbody><tr><td align="left" valign={v}>x</td></tr></tbody></table>', "border=", "cellpadding=", "cellspacing=", "align=", "valign=");
    no('<Comp color="red" />', "color=");
    // A table's width and height are presentational sizes: only a number or a helper call.
    no("<table><tbody><tr><td width={label}>x</td></tr></tbody></table>", "width={…}");
    no("<table height={h}><tbody><tr><td>x</td></tr></tbody></table>", "height={…}");
    no("<table><tbody><tr><td WIDTH={label} Height={h}>x</td></tr></tbody></table>", "WIDTH={…}", "Height={…}"); // any case, as HTML reads it
    ok("<table width={4}><tbody><tr><td width={clampPct(a, b)} colspan={n}>x</td></tr></tbody></table>");
    ok("<canvas width={n} height={h}></canvas>");
    ok("<input size={n} />");
    // A <style> element in markup is a handle for script-side CSS (bind:this + textContent).
    no("<div><style>p {}</style></div>", "<style>");
    no("<svelte:head><style>p {}</style></svelte:head>", "<style>");
    no("<svg><style>.a {}</style></svg>", "<style>");
    no("<style bind:this={st}>p {}</style><p>x</p>", "<style>");
    // The component's own top-level <style> is its stylesheet, not markup.
    ok("<p>x</p>\n<style>p { color: red; }</style>");
  });

  test("Step 0's style rule: a type-only import is never a helper or a transition", () => {
    const USE = "<div style:--w={clampPct(n, 10)}></div>";
    expect(lib(`<script lang="ts">import type { clampPct } from "./ui/geometry";</script>${USE}`)).toEqual(["style:--w="]);
    expect(lib(`<script lang="ts">import { type clampPct } from "./ui/geometry";</script>${USE}`)).toEqual(["style:--w="]);
    expect(lib('<script lang="ts">import { type clampPct as pct } from "./ui/geometry";</script><div style:--w={pct(n, 10)}></div>')).toEqual(["style:--w="]);
    expect(lib(`<script lang="ts">import { clampPct, type Other } from "./ui/geometry";</script>${USE}`)).toEqual([]);
    expect(lib('<script lang="ts">import { type fly } from "svelte/transition";</script><div in:fly></div>')).toEqual(["in:fly"]);
  });

  test("every file type is accounted for", () => {
    expect(fileOffences("x.mts", "el.innerHTML = s;")).toEqual(["innerHTML"]);
    expect(fileOffences("x.cjs", "document.write(s)")).toEqual(["document.write"]);
    expect(fileOffences("x.css", "p { color: red }")).toEqual([]);
    expect(fileOffences("x.html", "<a href=x>")).toEqual(["an unscanned file type (.html)"]);
    expect(() => fileOffences("x.ts", "const = ;")).toThrow("does not parse");
  });
});
