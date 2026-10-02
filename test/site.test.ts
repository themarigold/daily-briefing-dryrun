// test/site.test.ts — the static landing page makes no network request of its own, and its links
// go where they say (Phase E, E18).
//
// ⚠ A RECORDED DOWNGRADE. The appendix's T17 asked for a RUNTIME check: load `site/index.html` from
// file:// in a browser and assert zero network requests. This toolchain has no headless browser, so
// what runs here is static (plan §4 M5, E18).
//
// THE THREAT MODEL. `site/index.html` is written and edited by hand. What this file guards against is an
// ACCIDENTAL external request: an edit that adds a web font, an image, an embed, an analytics snippet or a
// resource hint. It does not prove that no deliberately crafted page could make a request (three review
// rounds found encoding and parse-differential tricks that the denylist scan below missed), and it does
// not try to: it fails closed instead. There are three layers, and only the first is a runtime control:
//
// 1. THE PAGE'S OWN CONTENT-SECURITY-POLICY. A browser refuses every fetch the policy governs
//    (`default-src 'none'`, bar the stylesheet that `style-src 'self'` lets through) and every inline
//    style and script. This test pins the policy; it cannot run it. It pins it BYTE FOR BYTE: exactly one
//    CSP <meta>, first in <head>, whose `content` equals `POLICY` with no parsing at all, because a parse
//    can be fooled (`default-src&#32;*` reads as one harmless directive to a scan that does not decode
//    character references, while a browser decodes it to `default-src *`, which wins). Two things are
//    outside CSP: resource hints (a `<link rel="preconnect">` opened a connection under this exact
//    policy, measured in a headless browser, and `dns-prefetch` is outside CSP by spec) and navigation (a
//    link the visitor clicks). The allowlist refuses every resource hint, and lets a link go only to an
//    id on the page or to an allowlisted host.
// 2. AN ALLOWLIST (`allowlistProblems`, `cssAllowlistProblems`). Whatever it does not list fails, so a
//    construct nobody thought of is refused rather than passed:
//    - elements: the ones the page uses, and a few inline and text elements (`ELEMENTS`). Every `<`
//      followed by a letter, ANYWHERE in the page (comments, attribute values and raw text included), is
//      read as a start tag (`everyTag`), so an element cannot hide where a browser reads the text
//      differently; the price is that tag-like text in those places fails too;
//    - attributes: `class`, `id` and `aria-label` on any element; `lang` on <html>; a <meta> that is
//      exactly `charset="utf-8"`, a `name` (viewport, description) with its `content`, or the policy;
//      exactly one <link>, `rel="stylesheet" href="style.css"` to the byte; and `href` on <a>, either
//      `#id` naming an id on the page, the id spelled as a letter and then letters, digits, `_` or `-`
//      (so the fragment holds nothing a URL parser percent-encodes or a browser percent-decodes before
//      it looks the id up; an id spelled otherwise, such as `v1.2`, is refused even when the page has
//      it, with a message that says so), or an https URL to github.com or brew.sh in printable ASCII with
//      no `%`, `\`, `&`, `@`, `..` segment, or `:` after the host (no port, not even the default `:443`
//      or an empty one, which a URL parser drops: the authority is checked as written). No attribute
//      appears twice. Everything else (`style`, `src`, `srcset`, `on*`, `ping`, `target`, `rel` on <a>,
//      `data-*`, …) fails because it is not listed;
//    - characters: no `&` in the page but the text entities `&amp;`, `&lt;` and `&gt;`, and none inside a
//      tag, so no attribute value means anything but what this file reads; and no control character but
//      tab and newline, in the page and in its CSS alike: no NUL, no ESC, and no CR, so a CRLF line
//      ending fails (`.gitattributes` checks site/ out with `eol=lf`, so a Windows checkout does not);
//    - every CSS file under site/: no backslash (so no escape: every name and string is spelled as it is
//      read), no at-rule but `@media`, no quoted string but a font name (`[A-Za-z0-9 -]+`), and no
//      `url(`, `image-set(`, `cross-fade(`, `image(`, `element(` or `src(` outside a comment;
//    - the files (`siteEntryProblems`, `encodingProblems`): site/ holds exactly index.html and style.css,
//      with no other file, directory, dotfile or symlink, and each is read as UTF-8 by a decoder that
//      throws on a malformed byte, with no byte-order mark and no U+FEFF anywhere. A browser takes a BOM
//      over everything else, so a stylesheet saved as UTF-16 with one (`FF FE`) is CSS to a browser and,
//      read leniently as UTF-8, letters split by NULs that no rule above matches (a review measured it in
//      headless Chrome: the `url()` applied, and only the policy stopped the fetch).
// 3. THE DENYLIST SCAN from the earlier rounds (`pageProblems`, `policyProblems`, `cssProblems`), kept
//    because its messages name the problem: an external or missing resource, a `<link>` that is not a
//    stylesheet, a character reference in a URL-bearing attribute or in the policy, a `..` segment, a
//    script, a nested document, an inline handler, a `javascript:` URL, inline CSS, a refresh, a ping, a
//    form target, a policy directive naming more than 'self' or 'none', a CSS `url()`, `@import` or quoted
//    URL that leaves site/, and a link to a host outside the allowlist. It models the HTML and CSS
//    tokenizers, but not completely: it does not decode character references, and an escaped `)` in an
//    unquoted `url()` once desynced its CSS reader. The allowlist is what fails closed.
//
// site/ holds exactly index.html and style.css (layer 2's file rule), so no page of its own sits beside the
// page unread, whatever its extension: a review measured Chrome rendering an `.ehtml`, `.rss` and `.xbl`
// from file://, none of which the older `DOCUMENT_FILE` check (a list of document extensions, kept for its
// message) knows. A file Finder or an editor drops there (`.DS_Store`, a swap file) fails too: delete it.
// The one exception: a Finder `.DS_Store` that git IGNORES is left out of the real site/'s listing (the
// export copies `git ls-files`, so it can never be published); tracked, or outside a git checkout, it fails.
// RESIDUAL: a browser may look up a favicon by itself; nothing here controls that.
//
// The checkers are pure functions over text, bytes or a listing, and the first tests below run them
// against planted bad input, so a checker that stopped matching would fail here rather than pass the real
// page vacuously.
import { test, expect } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname);
const SITE = join(ROOT, "site");
const PAGE = join(SITE, "index.html");

/** Hosts a visitor may be sent to by a link. Links only: no resource may load from anywhere. */
const LINK_HOSTS = ["github.com", "brew.sh"];

/** Attributes that make the browser fetch something as the page loads. `href` is handled apart: it is a
 *  clickable link on `<a>` and `<area>` only (LINK_ELEMENTS), and a resource on every other element. */
const RESOURCE_ATTRS = ["src", "srcset", "imagesrcset", "poster", "data", "background", "manifest", "xlink:href"];
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);
/** Attributes holding a URL, which may carry no `&`: this scan does not decode character references. */
const URL_ATTRS = new Set([...RESOURCE_ATTRS, "href", "action", "formaction", "ping"]);
const LINK_ELEMENTS = new Set(["a", "area"]);
/** Elements that load a whole document of their own, which this scan would not read. */
const NESTED_DOCUMENTS = new Set(["iframe", "frame", "object", "embed"]);

/** Attributes refused whatever their value (bar the one policy `http-equiv`), and why. */
function refusedAttr(tag: string, name: string, value: string): string | null {
  if (name.startsWith("on")) return "an inline event handler: its requests are invisible to a static scan";
  if (name === "ping") return "a ping: following the link would also send a request to the ping URL";
  if (name === "attributionsrc") return "an attribution source: the browser sends it a request of its own";
  if (name === "action" || name === "formaction") return "a form target: submitting would send a request";
  if (name === "srcdoc") return "an inline document this scan does not read";
  if (name === "style") return "inline CSS: the page's policy allows none, so its CSS lives in style.css";
  if (tag === "meta" && name === "http-equiv" && value.toLowerCase() !== "content-security-policy") {
    return "a refresh navigates or loads, and the only http-equiv the page may carry is its Content-Security-Policy";
  }
  return null;
}

/** A `javascript:` URL, after the whitespace and control characters a browser strips or ignores. */
const isJavascriptUrl = (v: string) => v.replace(/[\x00-\x20]/g, "").toLowerCase().startsWith("javascript:");

/** A–Z to a–z and nothing else, as the HTML tokenizer lowercases names: `toLowerCase()` would also turn
 *  the Kelvin sign (U+212A) into `k`, merging two attribute names a browser keeps apart. */
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (c) => c.toLowerCase());

type Tag = { name: string; attrs: Map<string, string>; repeated: string[]; end: number; selfClosing: boolean };

const TAG_NAME = /[^\t\n\f\r />]*/y;
const GAP = /[\t\n\f\r /]*/y;
const ATTR_NAME = /[^\t\n\f\r />][^\t\n\f\r />=]*/y;
const EQUALS = /[\t\n\f\r ]*=[\t\n\f\r ]*/y;
const VALUE = /"([^"]*)"?|'([^']*)'?|([^\t\n\f\r >]*)/y;

/**
 * The tag whose name starts at `s[at]` (just after its `<` or `</`), read the way an HTML tokenizer
 * reads it rather than with one regex: `/` separates attributes (`<svg/onload=…>`), a quoted value may
 * hold `>`, an unquoted value runs to whitespace or `>`, names are lowercased in ASCII only, and a
 * repeated attribute keeps its FIRST value (as a browser does), and its name is listed in `repeated`.
 * Character references are not decoded. `end` is the index just past the tag; `selfClosing` is a `/` just
 * before its `>` (not one inside an unquoted value).
 */
function readTag(s: string, at: number): Tag {
  TAG_NAME.lastIndex = at;
  const name = asciiLower(TAG_NAME.exec(s)![0]);
  const attrs = new Map<string, string>();
  const repeated: string[] = [];
  let p = TAG_NAME.lastIndex;
  let selfClosing = false;
  for (;;) {
    const gapAt = p;
    GAP.lastIndex = p; GAP.exec(s); p = GAP.lastIndex;
    if (p >= s.length) break;
    if (s[p] === ">") { selfClosing = p > gapAt && s[p - 1] === "/"; p++; break; }
    ATTR_NAME.lastIndex = p;
    const key = asciiLower(ATTR_NAME.exec(s)![0]); // s[p] is not whitespace, `/` or `>`, so this matches
    p = ATTR_NAME.lastIndex;
    let v = "";
    EQUALS.lastIndex = p;
    if (EQUALS.exec(s)) {
      VALUE.lastIndex = EQUALS.lastIndex;
      const vm = VALUE.exec(s)!;
      v = vm[1] ?? vm[2] ?? vm[3] ?? "";
      p = VALUE.lastIndex;
    }
    if (!attrs.has(key)) attrs.set(key, v);
    else repeated.push(key);
  }
  return { name, attrs, repeated, end: p, selfClosing };
}

/**
 * Every `<` followed by a letter, anywhere in the text, read as a start tag: a superset of the start
 * tags any browser builds from it. Every network rule runs over this, so a tag cannot slip past them by
 * hiding where a tokenizer without a tree builder would misjudge the context (foreign content, a
 * comment's end, `<select>`, a CDATA section).
 */
function everyTag(html: string): Tag[] {
  return [...html.matchAll(/<(?=[A-Za-z])/g)].map((m) => readTag(html, m.index! + 1));
}

/** Elements whose content a browser reads as text, not tags, up to the matching end tag. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);

/** Where a comment ends when its `<!--` finishes just before `s[i]`, by the HTML tokenizer's rules. */
function commentEnd(s: string, i: number): number {
  if (s.startsWith(">", i)) return i + 1; // `<!-->`
  if (s.startsWith("->", i)) return i + 2; // `<!--->`
  const ends = [s.indexOf("-->", i), s.indexOf("--!>", i)].filter((e) => e !== -1);
  if (ends.length === 0) return s.length;
  const e = Math.min(...ends);
  return e + (s.startsWith("-->", e) ? 3 : 4);
}

/**
 * The start tags in the order a browser reads them, as far as a tokenizer without a tree builder can
 * tell: a comment ends where a browser ends it (`-->`, `--!>`, or an abrupt `<!-->` / `<!--->`), `<!…>`,
 * `<?…>` and `</…>` run to their `>`, and a raw-text element's content (`<title>`, `<style>`, …) is
 * skipped to its end tag — except inside an `<svg>` or `<math>` (up to its matching end tag, nested
 * ones counted), where those elements are not raw text. An HTML tag that breaks out of foreign content
 * (`<p>`, `<div>`, …) is not modelled. Best effort, and used ONLY to collect the ids a `#fragment` link
 * may name, so a link to a section that was commented out fails; none of the network rules depend on it.
 */
function documentTags(html: string): Tag[] {
  const out: Tag[] = [];
  let foreign: string | null = null; // the <svg> or <math> we are inside, if any
  let depth = 0; // how many of that element are open
  let i = 0;
  while ((i = html.indexOf("<", i)) !== -1) {
    const next = html[i + 1] ?? "";
    if (/[A-Za-z]/.test(next)) {
      const t = readTag(html, i + 1);
      out.push(t);
      i = t.end;
      if ((t.name === "svg" || t.name === "math") && (foreign ?? t.name) === t.name && !t.selfClosing) {
        foreign = t.name;
        depth++;
      }
      if (!foreign && RAW_TEXT.has(t.name)) {
        const end = new RegExp(`</${t.name}[\\t\\n\\f\\r />]`, "gi"); // `t.name` is one of RAW_TEXT's plain words
        end.lastIndex = i;
        i = end.exec(html)?.index ?? html.length;
      }
    } else if (html.startsWith("<!--", i)) {
      i = commentEnd(html, i + 4);
    } else if (next === "/" && /[A-Za-z]/.test(html[i + 2] ?? "")) {
      const t = readTag(html, i + 2); // an end tag: its attributes are read (and dropped) like a start tag's
      i = t.end;
      if (t.name === foreign && --depth === 0) foreign = null;
    } else if (foreign && html.startsWith("<![CDATA[", i)) {
      const e = html.indexOf("]]>", i + 9);
      i = e === -1 ? html.length : e + 3;
    } else if (next === "!" || next === "?" || next === "/") {
      const e = html.indexOf(">", i + 2); // a doctype, a bogus comment, or `</>`
      i = e === -1 ? html.length : e + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** `u` as a URL parser starts reading it: ASCII tabs and newlines removed, C0 controls and spaces trimmed. */
const urlText = (u: string) => u.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
const hasScheme = (u: string) => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(urlText(u));
/** `//host`, and `\\host` or `/\host`, which a URL parser reads the same way against an http(s) or file base. */
const isProtocolRelative = (u: string) => /^[\\/]{2}/.test(urlText(u));
const isRelative = (u: string) => urlText(u) !== "" && !hasScheme(u) && !isProtocolRelative(u);
/** `s` percent-decoded, or null where a `%` starts no valid escape (`decodeURIComponent` throws there). */
const percentDecoded = (s: string): string | null => { try { return decodeURIComponent(s); } catch { return null; } };
/** The path a URL parser reads (tabs and newlines gone, so `.\t.` is `..`), percent-decoded (`%2e%2e` too),
 *  or null when it holds a malformed `%` escape. */
const pathPart = (u: string) => percentDecoded(urlText(u).split(/[?#]/)[0]!);
const MALFORMED = "has a malformed percent-escape";

/** A resource reference is acceptable when it is relative, has no `..` segment (resolving one lexically
 *  could turn a host-like prefix such as `&sol;&sol;host/..` into a path that exists), AND names a file
 *  that exists under `base`. `\` counts as `/`, as a URL parser reads it against an http(s) or file base. */
function resourceProblem(u: string, base: string): string | null {
  if (!isRelative(u)) return `not a relative path: ${JSON.stringify(u)}`;
  const p = pathPart(u);
  if (p === null) return `${MALFORMED}: ${JSON.stringify(u)}`;
  if (p.split(/[\\/]/).includes("..")) return `has a ".." path segment: ${JSON.stringify(u)}`;
  if (p === "") return null;
  const abs = resolve(base, p);
  if (abs !== SITE && !abs.startsWith(`${SITE}/`)) return `resolves outside site/: ${JSON.stringify(u)}`;
  if (!existsSync(abs)) return `names a file that does not exist: ${JSON.stringify(u)}`;
  return null;
}

/** Every problem in a page: resource references, scripts, inline CSS, the policy's sources, and links. */
function pageProblems(html: string, base: string): { problems: string[]; links: number; resources: number } {
  const problems: string[] = [];
  let links = 0, resources = 0, policies = 0;
  const ids = new Set(documentTags(html).flatMap((t) => [t.attrs.get("id"), t.name === "a" ? t.attrs.get("name") : undefined])
    .filter((v): v is string => v !== undefined));
  for (const t of everyTag(html)) {
    if (t.name === "script") problems.push("a <script> element: the page must carry no script");
    if (NESTED_DOCUMENTS.has(t.name)) problems.push(`<${t.name}> a nested document this scan does not read`);
    if (t.name === "link") {
      // An allowlist, not a list of hints to refuse: the policy does not govern preconnect or dns-prefetch.
      const rel = t.attrs.get("rel") ?? "";
      const types = asciiLower(rel).split(/[\t\n\f\r ]+/).filter(Boolean);
      if (types.length !== 1 || types[0] !== "stylesheet") {
        problems.push(`<link rel> is ${JSON.stringify(rel)}, not exactly "stylesheet": a resource hint (preconnect, dns-prefetch) connects whatever the policy says, and other link types load on their own`);
      }
    }
    if (t.name === "style") {
      problems.push("<style> inline CSS: the page's policy allows none, so its CSS lives in style.css");
      const close = /<\/style/gi;
      close.lastIndex = t.end;
      for (const p of cssProblems(html.slice(t.end, close.exec(html)?.index ?? html.length), base)) problems.push(`<style> ${p}`);
    }
    for (const attr of RESOURCE_ATTRS) {
      const v = t.attrs.get(attr);
      if (v === undefined) continue;
      const candidates = SRCSET_ATTRS.has(attr) ? v.split(",").map((c) => c.trim().split(/\s+/)[0]!).filter(Boolean) : [v];
      for (const c of candidates) {
        resources++;
        const p = resourceProblem(c, base);
        if (p) problems.push(`<${t.name} ${attr}> ${p}`);
      }
    }
    for (const [name, v] of t.attrs) {
      const why = refusedAttr(t.name, name, v);
      if (why) problems.push(`<${t.name} ${name}> ${why}`);
      if (isJavascriptUrl(v)) problems.push(`<${t.name} ${name}> holds a javascript: URL`);
      if ((URL_ATTRS.has(name) || /url\(/i.test(v)) && v.includes("&")) {
        problems.push(`<${t.name} ${name}> holds a character reference (\`&\`), which this scan does not decode: a URL-bearing attribute may carry none`);
      }
      // A style attribute is CSS, and so is an SVG presentation attribute such as `fill="url(…)"`; both
      // are declarations, not a stylesheet.
      if (name === "style" || /url\(/i.test(v)) for (const p of cssProblems(v, base, true)) problems.push(`<${t.name} ${name}> ${p}`);
    }
    if (t.name === "meta" && (t.attrs.get("http-equiv") ?? "").toLowerCase() === "content-security-policy") {
      policies++;
      for (const p of policyContentProblems(t.attrs.get("content") ?? "")) problems.push(`<meta http-equiv> ${p}`);
    }
    const href = t.attrs.get("href");
    if (href === undefined) continue;
    if (!LINK_ELEMENTS.has(t.name)) {
      resources++;
      const p = resourceProblem(href, base);
      if (p) problems.push(`<${t.name} href> ${p}`);
      continue;
    }
    links++;
    if (href.startsWith("#")) {
      const id = percentDecoded(href.slice(1));
      if (id === null) problems.push(`<${t.name} href="${href}"> ${MALFORMED}`);
      else if (href.length > 1 && !ids.has(id)) problems.push(`<${t.name} href="${href}"> names no id on the page`);
    } else if (/^https:\/\//i.test(href)) {
      let host: string | null = null;
      try { host = new URL(href).hostname.toLowerCase(); } catch { /* reported below */ }
      if (host === null) problems.push(`<${t.name} href="${href}"> is not a URL a URL parser accepts`);
      else if (!LINK_HOSTS.includes(host)) problems.push(`<${t.name} href="${href}"> leaves for a host outside the allowlist (${host})`);
    } else if (hasScheme(href) || isProtocolRelative(href)) {
      problems.push(`<${t.name} href="${href}"> is external but not an https link to an allowlisted host`);
    } else {
      const p = resourceProblem(href, base);
      if (p) problems.push(`<${t.name} href> ${p}`);
    }
  }
  if (policies > 1) problems.push(`<meta http-equiv> more than one Content-Security-Policy (${policies}): the page carries exactly one`);
  return { problems, links, resources };
}

/**
 * A policy is acceptable when `default-src` is exactly 'none', so are `base-uri` and `form-action` (which
 * do not fall back to it), and no directive names any source but 'self' or 'none'. A browser keeps the
 * first of a repeated directive; every copy is checked here.
 */
function policyContentProblems(policy: string): string[] {
  const problems: string[] = [];
  // A browser decodes character references in the attribute before it parses the policy, and this does
  // not: `default-src&#32;*` would read here as one unknown directive and to a browser as `default-src *`.
  if (policy.includes("&")) problems.push("CSP holds a character reference (`&`), which this scan does not decode: the policy may carry none");
  const first = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/[\t\n\f\r ]+/);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!first.has(key)) first.set(key, sources);
    const loose = sources.filter((s) => s.toLowerCase() !== "'self'" && s.toLowerCase() !== "'none'");
    if (loose.length > 0) problems.push(`CSP ${key} allows more than 'self' or 'none': ${loose.join(" ")}`);
  }
  for (const d of ["default-src", "base-uri", "form-action"]) {
    const v = first.get(d);
    if (v === undefined || v.length !== 1 || v[0]!.toLowerCase() !== "'none'") {
      problems.push(`CSP ${d} must be exactly 'none' (it is ${v === undefined ? "missing" : JSON.stringify(v.join(" "))})`);
    }
  }
  return problems;
}

/** The policy must come FIRST: doctype, `<html>`, `<head>`, then the CSP <meta>, with only whitespace
 *  between, so nothing can load before it applies and no comment or stray text can move it out of <head>. */
const POLICY_FIRST = /^\uFEFF?<!doctype html>[\t\n\f\r ]*<html(?:[\t\n\f\r ][^<>]*)?>[\t\n\f\r ]*<head>[\t\n\f\r ]*<meta http-equiv="Content-Security-Policy" content="([^"<>]*)">/i;

/** The page's policy: present, first in <head>, and strict. */
function policyProblems(html: string): string[] {
  const m = POLICY_FIRST.exec(html);
  if (!m) return ["the page must open with <!doctype html>, <html>, <head> and then its Content-Security-Policy <meta>, before anything else"];
  return policyContentProblems(m[1]!);
}

const CSS_NAME_CHAR = /[A-Za-z0-9_\u0080-\uffff-]/;
const CSS_NEWLINE = /[\n\r\f]/;
/** At-rules whose block holds style rules, as a stylesheet's top level does. */
const GROUPING_AT_RULES = new Set(["media", "supports", "layer", "container", "scope", "document", "-moz-document", "starting-style"]);

/** The CSS escape whose backslash is at `s[i]`: its text, and the index after it. */
function cssEscape(s: string, i: number): [string, number] {
  const hex = /[0-9A-Fa-f]{1,6}/y;
  hex.lastIndex = i + 1;
  const h = hex.exec(s);
  if (!h) return [s[i + 1] ?? "", i + 2];
  let j = hex.lastIndex;
  if (s.startsWith("\r\n", j)) j += 2;
  else if (/[\t\n\f\r ]/.test(s[j] ?? "")) j++;
  const cp = parseInt(h[0], 16);
  return [cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff ? "\ufffd" : String.fromCodePoint(cp), j];
}

/** A CSS name (identifier) starting at `s[i]`, escapes decoded, and the index after it. */
function cssName(s: string, i: number): [string, number] {
  let out = "";
  while (i < s.length) {
    if (CSS_NAME_CHAR.test(s[i]!)) out += s[i++];
    else if (s[i] === "\\" && i + 1 < s.length && !CSS_NEWLINE.test(s[i + 1]!)) { const [c, j] = cssEscape(s, i); out += c; i = j; }
    else break;
  }
  return [out, i];
}

/** The quoted CSS string opening at `s[i]`, escapes decoded, and the index after it. An unescaped newline
 *  ends it (a bad string, which the browser drops — it is checked all the same). */
function cssString(s: string, i: number): [string, number] {
  const quote = s[i];
  let out = "";
  let j = i + 1;
  while (j < s.length) {
    const c = s[j]!;
    if (c === quote) return [out, j + 1];
    if (CSS_NEWLINE.test(c)) return [out, j];
    if (c !== "\\") { out += c; j++; continue; }
    if (j + 1 >= s.length) { j++; continue; }
    if (CSS_NEWLINE.test(s[j + 1]!)) { j += s.startsWith("\r\n", j + 1) ? 3 : 2; continue; } // a line continuation
    const [e, k] = cssEscape(s, j);
    out += e;
    j = k;
  }
  return [out, j];
}

/** Skips CSS whitespace and comments from `s[i]`. */
function cssSkip(s: string, i: number): number {
  for (;;) {
    while (/[\t\n\f\r ]/.test(s[i] ?? "")) i++;
    if (!s.startsWith("/*", i)) return i;
    const e = s.indexOf("*/", i + 2);
    i = e === -1 ? s.length : e + 2;
  }
}

/**
 * CSS read much as a CSS tokenizer reads it (not exactly: an escaped `)` in an unquoted `url()` ends the
 * argument here and not in a browser, which `cssAllowlistProblems` closes by refusing every backslash):
 * comments are skipped (but a `/*` inside a string is not a comment), strings and names have their
 * escapes decoded (so `\75 rl(` is `url(`). Every `url()` and
 * `@import` must name a relative file that exists; any other quoted string, wherever it sits
 * (`image-set()`, `-webkit-image-set()`, `cross-fade()`, a function not invented yet), must not be an
 * absolute or protocol-relative URL. That last rule also refuses prose such as `content: "Note: x"`,
 * which looks like a scheme; the page's CSS has none. Its one exception is a string inside `[…]` in the
 * selector of a style rule at a stylesheet's top level or in a grouping at-rule (`@media`, `@supports`,
 * …): `a[href^="https://"]` names an attribute value to match, and a string inside a `[…]` block is
 * never an argument a fetching function reads. In a declaration block (nested rules included), an
 * at-rule's prelude, or a `style` attribute (`declarations`), every string is checked.
 */
function cssProblems(css: string, base: string, declarations = false): string[] {
  const problems: string[] = [];
  const reference = (what: string, u: string) => { const p = resourceProblem(u, base); if (p) problems.push(`${what} ${p}`); };
  // What each open `{` holds: rules (whose preludes are selectors) or declarations.
  const blocks: ("rules" | "decls")[] = [declarations ? "decls" : "rules"];
  let statementAt = 0; // where the current rule or declaration began: just after the last `{`, `}` or `;`
  let brackets = 0; // open `[` since then
  let inSelector = false; // the outermost of them sits in a style rule's selector
  let i = 0;
  while (i < css.length) {
    const c = css[i]!;
    if (css.startsWith("/*", i)) {
      const e = css.indexOf("*/", i + 2);
      i = e === -1 ? css.length : e + 2;
    } else if (c === '"' || c === "'") {
      const [v, j] = cssString(css, i);
      if (!(brackets > 0 && inSelector) && !isRelative(v) && urlText(v) !== "") {
        problems.push(`a quoted string is an absolute or protocol-relative URL: ${JSON.stringify(v)}`);
      }
      i = j;
    } else if (c === "[") {
      if (brackets++ === 0) inSelector = blocks[blocks.length - 1] === "rules" && css[cssSkip(css, statementAt)] !== "@";
      i++;
    } else if (c === "]") {
      if (brackets > 0) brackets--;
      i++;
    } else if (c === "{" || c === "}" || c === ";") {
      if (c === "{") {
        // A grouping at-rule's block holds rules, if it is itself among rules; every other block holds declarations.
        const at = cssSkip(css, statementAt);
        const grouping = css[at] === "@" && GROUPING_AT_RULES.has(asciiLower(cssName(css, at + 1)[0]));
        blocks.push(blocks[blocks.length - 1] === "rules" && grouping ? "rules" : "decls");
      } else if (c === "}" && blocks.length > 1) {
        blocks.pop();
      }
      statementAt = i + 1;
      brackets = 0;
      i++;
    } else if (c === "@") {
      const [name, j] = cssName(css, i + 1);
      i = j > i + 1 ? j : i + 1;
      if (name.toLowerCase() !== "import") continue;
      const k = cssSkip(css, i);
      if (css[k] === '"' || css[k] === "'") { const [v, e] = cssString(css, k); reference("@import", v); i = e; }
    } else if (CSS_NAME_CHAR.test(c) || (c === "\\" && i + 1 < css.length && !CSS_NEWLINE.test(css[i + 1]!))) {
      const [name, j] = cssName(css, i);
      i = j;
      if (name.toLowerCase() !== "url" || css[i] !== "(") continue;
      const k = cssSkip(css, i + 1);
      if (css[k] === '"' || css[k] === "'") {
        const [v, e] = cssString(css, k);
        reference("url()", v);
        i = e;
      } else {
        // An unquoted url() runs to `)` with no comments inside it; its escapes are decoded too.
        const close = css.indexOf(")", k);
        const raw = css.slice(k, close === -1 ? css.length : close);
        let v = "";
        for (let p = 0; p < raw.length;) {
          if (raw[p] === "\\" && p + 1 < raw.length) { const [e, q] = cssEscape(raw, p); v += e; p = q; } else v += raw[p++];
        }
        reference("url()", v.trim());
        i = close === -1 ? css.length : close + 1;
      }
    } else {
      i++;
    }
  }
  return problems;
}

/** The stylesheets the page links. */
function stylesheets(html: string): string[] {
  return everyTag(html).filter((t) => t.name === "link" && (t.attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet"))
    .map((t) => t.attrs.get("href") ?? "");
}

/** A file a browser opens as a document of its own. An .svg is one when it is linked or opened, so it
 *  counts even though the policy would block it as an <img>; so do an XSLT sheet (XML), a PDF (the
 *  browser's viewer follows its links and runs its actions) and a Safari .webarchive (a page with its
 *  subresources). */
const DOCUMENT_FILE = /\.(?:x?html?|xht|shtml?|mht(?:ml)?|svgz?|xml|xslt?|pdf|webarchive)$/i;

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => statSync(join(dir, f)).isFile()).sort();
}

// ── the allowlist: what the page and its CSS may hold; anything not listed fails ────────────────────

/** The page's policy, compared byte for byte with its CSP <meta>'s `content`: nothing is parsed, so no
 *  character reference, spacing or repeated directive can make a browser read a policy this test did not. */
const POLICY = "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'";

/** The elements the page may use: the ones it does, and a few harmless inline and text elements. */
const ELEMENTS = new Set([
  "html", "head", "meta", "title", "link", "body", "header", "nav", "main", "section", "div", "span",
  "h1", "h2", "h3", "p", "ul", "li", "a", "code", "pre", "strong", "footer",
  "em", "b", "i", "small", "ol", "br", "hr", "kbd",
]);
/** Attributes any element may carry: text a browser never fetches. */
const GLOBAL_ATTRS = new Set(["class", "id", "aria-label"]);
/** What else each element may carry; `allowlistProblems` checks the values. */
const ELEMENT_ATTRS = new Map([
  ["html", new Set(["lang"])],
  ["meta", new Set(["charset", "name", "http-equiv", "content"])],
  ["link", new Set(["rel", "href"])],
  ["a", new Set(["href"])],
]);
const META_NAMES = new Set(["viewport", "description"]);

/** The line `s[i]` is on, for messages. */
const lineOf = (s: string, i: number) => s.slice(0, i).split("\n").length;

/** Every control character in `s` but tab and newline: NUL, ESC (which switches ISO-2022-JP), and CR, so a
 *  CRLF line ending fails. One rule for the page and its CSS alike. */
const controlCharacters = (s: string) => [...s.matchAll(/[\x00-\x08\x0b-\x1f\x7f]/g)].map((m) =>
  `a control character (U+${m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}) at line ${lineOf(s, m.index!)}: only tab and newline may appear`);

/** The one spelling of a fragment link the allowlist reads: `#`, a letter, then letters, digits, `_` or `-`. */
const ID_LINK = /^#[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * An `<a href>` the allowlist accepts: `#id` (ID_LINK) naming an id on the page, or an https URL to a
 * LINK_HOSTS host, written in printable ASCII with nothing for a parser to decode or resolve: no `%`, `\`
 * or `&`, no userinfo (`@`), no `:` after the host (so no port), and no `..` path segment.
 */
function allowedLink(href: string, ids: Set<string>): boolean {
  if (ID_LINK.test(href)) return ids.has(href.slice(1));
  if (!/^https:\/\/[\x21-\x7e]+$/.test(href) || /[%\\&@]/.test(href)) return false;
  // The authority as written: a URL parser drops a default port (`:443`) and an empty one (`:`), so
  // `url.port` below is "" for both. With `\` and `@` refused above, the authority runs to `/`, `?` or `#`.
  const authority = href.slice("https://".length).split(/[/?#]/)[0]!;
  if (authority.includes(":")) return false;
  if (href.split(/[?#]/)[0]!.split("/").includes("..")) return false;
  let url: URL;
  try { url = new URL(href); } catch { return false; }
  // …and it must BE the host the parser read: a parser skips extra slashes after `https:`, so in
  // `https:///github.com:443/` the authority as written is empty and the port check above saw nothing.
  return authority === url.hostname && url.port === "" && LINK_HOSTS.includes(url.hostname);
}

/**
 * Every way a page departs from the allowlist (the file header lists it). Elements and attributes are read
 * with `everyTag`, so a tag in a comment, an attribute value or raw text is held to it too.
 */
function allowlistProblems(html: string): string[] {
  const problems: string[] = [];
  const out = (p: string) => problems.push(`allowlist: ${p}`);
  // Characters. A tag's span runs from its `<` to its end as `readTag` reads it, end tags included.
  const spans = [...html.matchAll(/<\/?(?=[A-Za-z])/g)].map((m): [number, number] => [m.index!, readTag(html, m.index! + m[0].length).end]);
  for (const m of html.matchAll(/&/g)) {
    const i = m.index!;
    if (spans.some(([s, e]) => s < i && i < e)) {
      out(`"&" inside a tag at line ${lineOf(html, i)}: a browser decodes a character reference in an attribute and this scan does not, so no tag may carry one`);
    } else if (!/^&(?:amp|lt|gt);/.test(html.slice(i, i + 5))) {
      out(`"&" at line ${lineOf(html, i)} is not one of the text entities &amp; &lt; &gt;: ${JSON.stringify(html.slice(i, i + 12))}`);
    }
  }
  for (const p of controlCharacters(html)) out(p);
  // Elements and attributes.
  const ids = new Set(documentTags(html).map((t) => t.attrs.get("id")).filter((v): v is string => v !== undefined));
  let links = 0, policies = 0;
  for (const t of everyTag(html)) {
    const at = (k: string) => t.attrs.get(k);
    if (!ELEMENTS.has(t.name)) out(`<${t.name}> is not an element the page may use`);
    const own = ELEMENT_ATTRS.get(t.name);
    for (const name of t.attrs.keys()) {
      if (!GLOBAL_ATTRS.has(name) && !own?.has(name)) out(`<${t.name} ${name}> is not an attribute <${t.name}> may carry`);
    }
    for (const name of t.repeated) out(`<${t.name} ${name}> is repeated: an attribute appears once`);
    if (t.name === "meta") {
      if (t.attrs.has("http-equiv")) policies++;
      const shape = [...t.attrs.keys()].filter((k) => !GLOBAL_ATTRS.has(k)).sort().join(" ");
      if (shape === "charset") {
        if (at("charset") !== "utf-8") out(`<meta charset> is ${JSON.stringify(at("charset"))}, not "utf-8": another encoding could read the page differently from this test`);
      } else if (shape === "content name") {
        if (!META_NAMES.has(at("name")!)) out(`<meta name> is ${JSON.stringify(at("name"))}, not viewport or description`);
      } else if (shape === "content http-equiv") {
        if (at("http-equiv") !== "Content-Security-Policy") out(`<meta http-equiv> is ${JSON.stringify(at("http-equiv"))}: the only http-equiv is "Content-Security-Policy"`);
        if (at("content") !== POLICY) out(`<meta http-equiv> content is not byte-equal to POLICY: ${JSON.stringify(at("content"))}`);
      } else {
        out(`<meta> carries ${JSON.stringify(shape)}: a <meta> is exactly charset, name and content, or http-equiv and content`);
      }
    }
    if (t.name === "link") {
      links++;
      if (at("rel") !== "stylesheet" || at("href") !== "style.css") {
        out(`<link> is rel=${JSON.stringify(at("rel"))} href=${JSON.stringify(at("href"))}, not exactly rel="stylesheet" href="style.css"`);
      }
    }
    const href = at("href");
    if (t.name === "a" && href !== undefined && !allowedLink(href, ids)) {
      if (href.startsWith("#") && !ID_LINK.test(href)) {
        out(`<a href=${JSON.stringify(href)}> is a fragment not spelled as the allowlist reads one ("#", a letter, then letters, digits, "_" or "-"), whether or not the page has that id`);
      } else {
        out(`<a href=${JSON.stringify(href)}> is neither "#id" naming an id on the page nor a plain https URL to ${LINK_HOSTS.join(" or ")}`);
      }
    }
  }
  if (links !== 1) out(`the page has ${links} <link> elements, not exactly one (its stylesheet)`);
  if (policies !== 1) out(`the page has ${policies} <meta http-equiv>, not exactly one (its Content-Security-Policy)`);
  // The encoding floor: exactly one <meta charset> (its value is checked above), serialized completely
  // within the page's first 1024 bytes, which is all a browser's encoding prescan reads (HTML, "prescan a
  // byte stream to determine its encoding"). Absent or later, a browser may decode the page with an
  // encoding of its own choosing before it gets there, and read text this test reads otherwise.
  const charsets = [...html.matchAll(/<(?=[A-Za-z])/g)]
    .map((m) => readTag(html, m.index! + 1))
    .filter((t) => t.name === "meta" && t.attrs.has("charset"));
  if (charsets.length !== 1) {
    out(`the page has ${charsets.length} <meta charset>, not exactly one (utf-8, within the first 1024 bytes)`);
  } else if (new TextEncoder().encode(html.slice(0, charsets[0]!.end)).length > 1024) {
    out(`<meta charset> ends at byte ${new TextEncoder().encode(html.slice(0, charsets[0]!.end)).length}: it must sit wholly within the first 1024 bytes, all a browser's encoding prescan reads`);
  }
  return problems;
}

/** CSS functions that fetch or paint an image, matched as text in any case (so `-webkit-image-set(` and
 *  `-moz-element(` too) wherever they sit outside comments and strings. */
const CSS_FETCHING = /url\(|image-set\(|cross-fade\(|image\(|element\(|src\(/gi;
/** The one kind of string the stylesheet holds: a font family name. */
const CSS_FONT_NAME = /^[A-Za-z0-9 -]+$/;

/**
 * Every way a stylesheet departs from the CSS allowlist (the file header lists it). With no backslash
 * there is no escape, so comments and strings can be cut out exactly (a `/*` inside a string is not a
 * comment, and a quote inside a comment is not a string); each is blanked to spaces, keeping line
 * numbers, and what is left is read as plain text.
 */
function cssAllowlistProblems(css: string): string[] {
  const problems: string[] = [];
  const out = (p: string) => problems.push(`allowlist: ${p}`);
  for (const p of controlCharacters(css)) out(p);
  const backslash = css.indexOf("\\");
  if (backslash !== -1) out(`a backslash at line ${lineOf(css, backslash)}: a CSS escape can spell any name or string, so the stylesheet may carry none`);
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  let code = "";
  for (let i = 0; i < css.length;) {
    const c = css[i]!;
    if (css.startsWith("/*", i)) {
      const e = css.indexOf("*/", i + 2);
      const end = e === -1 ? css.length : e + 2;
      code += blank(css.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c && !CSS_NEWLINE.test(css[j]!)) j++;
      const closed = css[j] === c;
      const text = css.slice(i + 1, j);
      if (!closed) out(`a quoted string at line ${lineOf(css, i)} is not closed on its line`);
      else if (!CSS_FONT_NAME.test(text)) out(`a quoted string at line ${lineOf(css, i)} is not a font name (letters, digits, spaces, hyphens): ${JSON.stringify(text)}`);
      const end = closed ? j + 1 : j;
      code += blank(css.slice(i, end));
      i = end;
    } else {
      code += c;
      i++;
    }
  }
  for (const m of code.matchAll(/@/g)) {
    if (!/^@media[\t\n\f\r (]/.test(code.slice(m.index!, m.index! + 7))) {
      out(`an at-rule other than @media at line ${lineOf(code, m.index!)}: ${JSON.stringify(code.slice(m.index!).split(/[\s{;(]/)[0])}`);
    }
  }
  for (const m of code.matchAll(CSS_FETCHING)) out(`a ${JSON.stringify(m[0])} function at line ${lineOf(code, m.index!)}: the stylesheet may fetch nothing`);
  return problems;
}

// ── the allowlist's file rule: exactly two files, both strict UTF-8 ─────────────────────────────────

/** The whole of site/: these two files, and nothing else. */
const SITE_FILES = ["index.html", "style.css"];
type SiteEntry = { path: string; kind: "file" | "directory" | "symlink" | "other" };

/** Every entry under `dir`, recursively, dotfiles and directories included, as paths relative to it, sorted.
 *  Read with lstat: a symlink is listed as one, never followed. */
function siteEntries(dir: string, sub = ""): SiteEntry[] {
  return readdirSync(join(dir, sub)).sort().flatMap((name): SiteEntry[] => {
    const path = sub === "" ? name : `${sub}/${name}`;
    const s = lstatSync(join(dir, path));
    const kind = s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "directory" : s.isFile() ? "file" : "other";
    return kind === "directory" ? [{ path, kind }, ...siteEntries(dir, path)] : [{ path, kind }];
  });
}

/** Whether `rel` (under `dir`) is a Finder `.DS_Store` that git ignores there: `git check-ignore` without
 *  --no-index, so a TRACKED one is not ignored (it would be exported), and outside a checkout nothing is. */
function ignoredFinderFile(dir: string, rel: string): boolean {
  if (rel.split("/").at(-1) !== ".DS_Store") return false;
  const r = Bun.spawnSync(["git", "-C", dir, "check-ignore", "-q", "--", rel], { stdout: "ignore", stderr: "ignore" });
  return r.exitCode === 0;
}
/** A site directory's entries and files as this test judges them: an ignored `.DS_Store` left out. */
const judgedEntries = (dir: string) => siteEntries(dir).filter((e) => !(e.kind === "file" && ignoredFinderFile(dir, e.path)));
const judgedFiles = (dir: string) => filesUnder(dir).filter((f) => !ignoredFinderFile(dir, f));

/** Every way a listing of site/ departs from SITE_FILES. It fails closed: a page under an extension nobody
 *  listed, a directory, a dotfile or a symlink is refused rather than left unread. */
function siteEntryProblems(entries: SiteEntry[]): string[] {
  const problems: string[] = [];
  for (const e of entries) {
    if (e.kind === "symlink") problems.push(`site/${e.path} is a symlink: site/ holds none, since a link can name a file outside it`);
    else if (e.kind === "directory") problems.push(`site/${e.path}/ is a directory: site/ holds only ${SITE_FILES.join(" and ")}`);
    else if (e.kind === "other") problems.push(`site/${e.path} is not a regular file`);
    else if (!SITE_FILES.includes(e.path)) problems.push(`site/${e.path} is not ${SITE_FILES.join(" or ")}: a browser could open it beside the page, and this test does not read it (delete it, or teach this test to read it)`);
  }
  for (const f of SITE_FILES) if (!entries.some((e) => e.path === f && e.kind === "file")) problems.push(`site/${f} is missing, or not a regular file`);
  return problems;
}

/** UTF-8 as a browser decodes a page or stylesheet that carries no byte-order mark, except that a malformed
 *  byte throws (a browser would read U+FFFD) and a leading BOM is kept as U+FEFF (the default decoder
 *  drops one silently), so both can be refused. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Why a file's bytes are not text this test reads exactly as a browser does, or []. */
function encodingProblems(bytes: Uint8Array): string[] {
  const problems: string[] = [];
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    problems.push("starts with a UTF-8 byte-order mark (EF BB BF): a browser takes a BOM over the page's <meta charset>, so no file may carry one");
  }
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    const head = [...bytes.subarray(0, 4)].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
    problems.push(`is not valid UTF-8 (it starts ${head}): a UTF-16 byte-order mark (FF FE or FE FF) makes a browser read the file as UTF-16, and this test would read letters split by NULs`);
    return problems;
  }
  for (const m of text.matchAll(/\uFEFF/g)) problems.push(`holds a U+FEFF (a byte-order mark, or a zero-width no-break space) at line ${lineOf(text, m.index!)}`);
  return problems;
}

/** `bytes` as text, decoded by UTF8; it throws, naming the file, when `encodingProblems` finds any. */
function siteText(bytes: Uint8Array, name: string): string {
  const problems = encodingProblems(bytes);
  if (problems.length > 0) throw new Error(`${name} ${problems.join("; ")}`);
  return UTF8.decode(bytes);
}

/** A file under site/ as text: every read of one goes through here. */
const readSiteText = (file: string) => siteText(readFileSync(file), `site/${relative(SITE, file)}`);

// A complete document head carrying a given policy, for the planted rows below.
const withPolicy = (policy: string, rest = "") =>
  `<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="${policy}">${rest}`;
const STRICT = "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'";
// A whole page the allowlist accepts (the policy, a charset, the stylesheet) around a planted body.
const allowedPage = (body: string, policy = POLICY) =>
  withPolicy(policy, `<meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`);

// ── the checkers catch what they exist for (planted input, never the real page) ───────────────────

test("the checkers flag every kind of external or broken reference", () => {
  const bad = [
    '<img src="https://example.com/a.png">',
    '<img src="//cdn.example.com/a.png">',
    '<img src="data:image/png;base64,AAAA">',
    '<img srcset="style.css 1x, https://example.com/b.png 2x">',
    '<link rel="stylesheet" href="https://fonts.example.com/css">',
    '<link rel="icon" href="missing.ico">',
    '<script src="app.js"></script>',
    '<a href="https://example.com/">x</a>',
    '<a href="http://github.com/x">x</a>',
    '<a href="#nowhere">x</a>',
    '<a href="no-such-page.html">x</a>',
    '<div style="background: url(https://example.com/bg.png)"></div>',
    '<style>@import "https://example.com/x.css";</style>',
  ];
  for (const b of bad) {
    expect(pageProblems(b, SITE).problems.length, `not flagged: ${b}`).toBeGreaterThan(0);
  }
  for (const b of ["a { background: url(https://example.com/x.png) }", "@import 'https://example.com/x.css';", "a { background: url(//x.example/y.png) }"]) {
    expect(cssProblems(b, SITE).length, `not flagged: ${b}`).toBeGreaterThan(0);
  }
  // …and pass what is fine: an allowlisted link, a fragment that exists, a relative file that exists,
  // and a url() inside a CSS comment.
  const ok = '<p id="here"></p><a href="#here">a</a><a href="https://github.com/x">b</a><a href="https://brew.sh">c</a><link rel="stylesheet" href="style.css">';
  expect(pageProblems(ok, SITE).problems).toEqual([]);
  expect(cssProblems("/* no url(https://example.com) here */ a { color: red }", SITE)).toEqual([]);
  // …nor do the stricter rules below refuse ordinary markup: plain <meta>, a `>` and an apostrophe
  // inside quoted values, a self-closing tag, an attribute that merely contains "on".
  const okToo = '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p id="t" class="button"></p>'
    + '<a href="#t" title="it\'s a > b">a</a><br/><img alt="a > b" src="style.css"><a href="https://github.com/x" aria-label="go">b</a>';
  expect(pageProblems(okToo, SITE).problems).toEqual([]);
});

test("each later rule reports its own problem (inline handlers, javascript:, refresh, ping, form targets, imagesrcset, SVG href, srcdoc, and the tokenizer cases)", () => {
  // Matched BY MESSAGE, so a rule that stopped biting fails here by name instead of hiding behind an
  // older rule that happens to flag the same input (the link rules also flag the javascript: and
  // <base> inputs, for two).
  const named: [string, RegExp][] = [
    [`<body onload="fetch('https://example.com/')">`, /^<body onload> an inline event handler/],
    [`<svg/onload="fetch('https://example.com/')">`, /^<svg onload> an inline event handler/],
    [`<a href="  java\tscript:fetch('https://example.com/')">x</a>`, /^<a href> holds a javascript: URL/],
    [`<meta http-equiv="refresh" content="0; url=https://example.com/">`, /^<meta http-equiv> a refresh/],
    [`<a href="https://github.com/x" ping="https://example.com/t">x</a>`, /^<a ping> a ping/],
    [`<form action="https://example.com/submit"></form>`, /^<form action> a form target/],
    [`<button formaction="https://example.com/submit">x</button>`, /^<button formaction> a form target/],
    [`<link rel="preload" as="image" href="style.css" imagesrcset="https://example.com/a.png 1x">`, /^<link imagesrcset> not a relative path/],
    [`<svg><image href="https://github.com/a.png"/></svg>`, /^<image href> not a relative path/],
    [`<svg><use xlink:href="https://example.com/s.svg#i"/></svg>`, /^<use xlink:href> not a relative path/],
    [`<base href="https://example.com/">`, /^<base href> not a relative path/],
    [`<html manifest="https://example.com/app.appcache">`, /^<html manifest> not a relative path/],
    [`<iframe srcdoc="<img src=https://example.com/a.png>"></iframe>`, /^<iframe srcdoc> an inline document/],
    // The tokenizer: a `>` inside a quoted value, a repeated attribute (the browser keeps the first),
    // and a raw-text element whose content looks like an unclosed tag.
    [`<img alt=">" src="https://example.com/a.png">`, /^<img src> not a relative path/],
    [`<img src="https://example.com/a.png" src="style.css">`, /^<img src> not a relative path/],
    [`<title>x<a title="</title><img src="https://example.com/a.png">`, /^<img src> not a relative path/],
    // No context hides a tag: inside <svg>/<math> a <title> or <style> is NOT raw text; a comment ends
    // at `<!-->` and is not opened inside an attribute value; a raw-text start tag inside <select> is
    // ignored by some parsers; CDATA ends where a quoted value would not. Comments are scanned as well.
    [`<svg><title><img src=https://example.invalid/x.png></title></svg>`, /^<img src> not a relative path/],
    [`<math><mi><style><img src=https://example.invalid/x.png></style></mi></math>`, /^<img src> not a relative path/],
    [`<p title="<!--"><img src=https://example.com/a.png><p title="-->">`, /^<img src> not a relative path/],
    [`<!--><img src=https://example.com/a.png><!-- -->`, /^<img src> not a relative path/],
    [`<!--->--!><img src=https://example.com/a.png>-->`, /^<img src> not a relative path/],
    [`<!-- <img src="https://example.com/a.png"> -->`, /^<img src> not a relative path/],
    [`<select><style><input type=image src=https://example.com/a.png></style></select>`, /^<input src> not a relative path/],
    [`<svg><![CDATA[<p title="]]><img src=https://example.com/a.png>">]]></svg>`, /^<img src> not a relative path/],
    // Later rules: nested documents, attribution requests, inline CSS, an SVG attribute's url().
    [`<iframe src="index.html"></iframe>`, /^<iframe> a nested document/],
    [`<object data="style.css"></object>`, /^<object> a nested document/],
    [`<a href="https://github.com/x" attributionsrc="https://example.com/r">x</a>`, /^<a attributionsrc> an attribution source/],
    [`<p style="color: red">x</p>`, /^<p style> inline CSS/],
    [`<style>p { color: red }</style>`, /^<style> inline CSS/],
    [`<svg><rect fill="url(https://example.com/p.svg#g)"/></svg>`, /^<rect fill> url\(\) not a relative path/],
    // CSS image-set() with a quoted absolute URL, in a style attribute and in a <style> element.
    [`<div style="background-image: image-set('https://example.com/a.png' 1x)"></div>`, /^<div style> a quoted string is an absolute/],
    [`<div style="background-image: -webkit-image-set(&quot;x&quot; 1x, '//example.com/a.png' 2x)"></div>`, /^<div style> a quoted string is an absolute/],
    [`<style>a { background-image: image-set("https://example.com/a.png" 1x) }</style>`, /^<style> a quoted string is an absolute/],
  ];
  for (const [b, why] of named) {
    const { problems } = pageProblems(b, SITE);
    expect(problems.some((p) => why.test(p)), `${b} -> ${JSON.stringify(problems)}`).toBe(true);
  }
  // Fragment links resolve against the ids a browser builds: a section that was commented out is
  // gone, and a `<!-->` comment hides nothing after it.
  expect(pageProblems(`<!-- <p id="y"> --><a href="#y">x</a>`, SITE).problems).toEqual([`<a href="#y"> names no id on the page`]);
  expect(pageProblems(`<!--><p id="x"><!-- --><a href="#x">x</a>`, SITE).problems).toEqual([]);
});

test("character references, resource hints and `..` segments are refused, and names are lowercased in ASCII only", () => {
  const CHARREF = (el: string, attr: string) => new RegExp(`^<${el} ${attr}> holds a character reference`);
  const DOTS = (el: string, attr: string) => new RegExp(`^<${el} ${attr}> has a "\\.\\." path segment`);
  const REL = /^<link rel> is .*, not exactly "stylesheet"/;
  // Every message listed must appear, so each rule is shown to bite on these inputs by itself. Undecoded,
  // the first three read as a relative path to style.css, which exists; a browser decodes them to
  // `//evil.example/…` and `https://evil.example/…`, and a preconnect is not governed by the policy.
  const all: [string, RegExp[]][] = [
    [`<link rel="preconnect" href="&sol;&sol;evil.example/../style.css">`, [CHARREF("link", "href"), REL, DOTS("link", "href")]],
    [`<link rel="preconnect" href="https&colon;&sol;&sol;evil.example/../style.css">`, [CHARREF("link", "href"), REL, DOTS("link", "href")]],
    [`<a href="&sol;&sol;evil.example/../style.css">x</a>`, [CHARREF("a", "href"), DOTS("a", "href")]],
  ];
  for (const [b, whys] of all) {
    const { problems } = pageProblems(b, SITE);
    for (const why of whys) expect(problems.some((p) => why.test(p)), `${b} -> ${why} -> ${JSON.stringify(problems)}`).toBe(true);
  }
  // Exactly one problem each: the rule under test, with nothing else flagging the input.
  const only: [string, RegExp][] = [
    [`<img src="style.css?&amp;">`, CHARREF("img", "src")],
    [`<svg><rect fill="url(style.css#&#x67;)"/></svg>`, CHARREF("rect", "fill")],
    [`<link rel=dns-prefetch href=style.css>`, REL],
    [`<link rel="preload" as="style" href="style.css">`, REL],
    [`<link rel="stylesheet icon" href="style.css">`, REL],
    [`<link href="style.css">`, REL],
    [`<link rel="stylesheet" href="./x/../style.css">`, DOTS("link", "href")],
    [`<img src="x/%2e%2e/style.css">`, DOTS("img", "src")],
    [`<img src="x\\..\\style.css">`, DOTS("img", "src")],
    [`<img src="x/.\t./style.css">`, DOTS("img", "src")],
    [`<a href="./x/../index.html">x</a>`, DOTS("a", "href")],
    // The Kelvin sign (U+212A) is not `k` to a browser: the first attribute is another name, so the second
    // is the one it loads, not a repeat to drop.
    [`<svg><image xlin\u212A:href="style.css" xlink:href="https://example.com/a.png"/></svg>`, /^<image xlink:href> not a relative path/],
    [`<body bac\u212Aground="style.css" background="https://example.com/a.png">`, /^<body background> not a relative path/],
  ];
  for (const [b, why] of only) {
    const { problems } = pageProblems(b, SITE);
    expect(problems.length === 1 && why.test(problems[0]!), `${b} -> ${JSON.stringify(problems)}`).toBe(true);
  }
  // …and pass what is fine: `rel` in any ASCII case with spaces around it, `.` segments, `&` outside a URL.
  expect(pageProblems(`<link rel=" StyleSheet " href="./style.css"><p title="a &amp; b"></p>`, SITE).problems).toEqual([]);
  // Ids after an <svg> closes: a <title> is raw text again (a `<svg/>` closes at once), while a nested
  // <svg> keeps its parent open.
  expect(pageProblems(`<svg></svg><title><p id="z"></title><a href="#z">x</a>`, SITE).problems).toEqual([`<a href="#z"> names no id on the page`]);
  expect(pageProblems(`<svg/><title><p id="z"></title><a href="#z">x</a>`, SITE).problems).toEqual([`<a href="#z"> names no id on the page`]);
  expect(pageProblems(`<svg><svg></svg><title><p id="w"></title></svg><a href="#w">x</a>`, SITE).problems).toEqual([]);
});

test("the policy is required, first in <head>, the only http-equiv, and names nothing but 'self' or 'none'", () => {
  // The real page's policy, and a page that carries it, pass.
  expect(policyProblems(withPolicy(STRICT))).toEqual([]);
  expect(pageProblems(withPolicy(STRICT, '<link rel="stylesheet" href="style.css">'), SITE).problems).toEqual([]);
  const named: [string, RegExp][] = [
    // Missing, or not first: after a stylesheet, after a comment, or in <body>.
    [`<!doctype html><html lang="en"><head><title>x</title><link rel="stylesheet" href="style.css">`, /^the page must open with/],
    [`<!doctype html><html><head><link rel="stylesheet" href="style.css"><meta http-equiv="Content-Security-Policy" content="${STRICT}">`, /^the page must open with/],
    [`<!doctype html><html><head><!-- x --><meta http-equiv="Content-Security-Policy" content="${STRICT}">`, /^the page must open with/],
    [`<!doctype html><html><head>x<meta http-equiv="Content-Security-Policy" content="${STRICT}">`, /^the page must open with/],
    // Too loose.
    [withPolicy("default-src *; base-uri 'none'; form-action 'none'"), /^CSP default-src allows more than 'self' or 'none': \*/],
    [withPolicy("default-src 'none'; img-src https:; base-uri 'none'; form-action 'none'"), /^CSP img-src allows more than 'self' or 'none': https:/],
    [withPolicy("default-src 'none'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'"), /^CSP style-src allows more/],
    [withPolicy("default-src 'self'; base-uri 'none'; form-action 'none'"), /^CSP default-src must be exactly 'none'/],
    [withPolicy("default-src 'none'; style-src 'self'"), /^CSP base-uri must be exactly 'none'/],
    [withPolicy("default-src 'none'; style-src 'self'; base-uri 'none'"), /^CSP form-action must be exactly 'none'/],
  ];
  for (const [doc, why] of named) {
    const problems = policyProblems(doc);
    expect(problems.some((p) => why.test(p)), `${doc} -> ${JSON.stringify(problems)}`).toBe(true);
  }
  // The scan of the whole page: a second http-equiv (a refresh), a second policy, a loose policy anywhere.
  const inPage: [string, RegExp][] = [
    [withPolicy(STRICT, `<meta http-equiv="refresh" content="0; url=https://example.com/">`), /^<meta http-equiv> a refresh/],
    [withPolicy(STRICT, `<meta http-equiv="Content-Security-Policy" content="${STRICT}">`), /^<meta http-equiv> more than one Content-Security-Policy/],
    [`<body><meta http-equiv="content-security-policy" content="default-src https:">`, /^<meta http-equiv> CSP default-src allows more/],
  ];
  for (const [doc, why] of inPage) {
    const { problems } = pageProblems(doc, SITE);
    expect(problems.some((p) => why.test(p)), `${doc} -> ${JSON.stringify(problems)}`).toBe(true);
  }
});

test("CSS is read like a CSS tokenizer reads it: every quoted string and url() argument, wherever it sits", () => {
  const named: [string, RegExp][] = [
    [`a { background-image: image-set("https://example.com/a.png" 1x) }`, /^a quoted string is an absolute/],
    [`a { background-image: -webkit-image-set(url(style.css) 1x, '//example.com/a.png' 2x) }`, /^a quoted string is an absolute/],
    [`a { background-image: cross-fade(50% image-set("https://example.com/a.png"), url(style.css)) }`, /^a quoted string is an absolute/],
    [`a { background-image: image-set("\\\\\\\\example.com/a.png" 1x) }`, /^a quoted string is an absolute/], // \\example.com
    [`a { background-image: image-set("\\68 ttps://example.com/a.png" 1x) }`, /^a quoted string is an absolute/], // \68 is h
    [`a { background-image: image-set("ht\\\ntps://example.com/a.png" 1x) }`, /^a quoted string is an absolute/], // a line continuation
    [`a { background: \\75 rl(https://example.com/a.png) }`, /^url\(\) not a relative path/], // \75 is u
    [`a { background: url( "https://example.com/a.png" ) }`, /^url\(\) not a relative path/],
    [`a { background: url(\\68 ttps://example.com/a.png) }`, /^url\(\) not a relative path/],
    [`a { content: "/*"; background: url(https://example.com/a.png) } /* */`, /^url\(\) not a relative path/],
    [`@import url("https://example.com/x.css");`, /^url\(\) not a relative path/],
    [`@import /* c */ "missing.css";`, /^@import names a file that does not exist/],
    [`a { background: url(missing.png) }`, /^url\(\) names a file that does not exist/],
    [`a { background: url(x/../style.css) }`, /^url\(\) has a "\.\." path segment/],
    // A selector's `[…]` is exempt; nothing else is: a declaration after one, a `[…]` in a declaration
    // value, a nested rule, an at-rule's prelude, and a `]` inside a string that does not close it.
    [`a[href^="https://"] { background-image: image-set("https://example.com/a.png" 1x) }`, /^a quoted string is an absolute/],
    [`a[x="]"] { background-image: image-set("https://example.com/a.png" 1x) }`, /^a quoted string is an absolute/],
    [`a { --x: ["https://example.com/a.png"] }`, /^a quoted string is an absolute/],
    [`a { & [href^="https://example.com/"] { color: red } }`, /^a quoted string is an absolute/],
    [`@supports selector(a[href^="https://example.com/"]) { a { color: red } }`, /^a quoted string is an absolute/],
    [`@media print { a[href] { background-image: image-set("https://example.com/a.png" 1x) } }`, /^a quoted string is an absolute/],
  ];
  for (const [css, why] of named) {
    const problems = cssProblems(css, SITE);
    expect(problems.some((p) => why.test(p)), `${css} -> ${JSON.stringify(problems)}`).toBe(true);
  }
  // A style attribute is declarations, so a `[…]` in it is not a selector.
  expect(cssProblems(`--x: ["https://example.com/a.png"]`, SITE, true).some((p) => /^a quoted string is an absolute/.test(p))).toBe(true);
  expect(pageProblems(`<div style='--x: ["https://example.com/a.png"]'></div>`, SITE).problems.some((p) => /^<div style> a quoted string is an absolute/.test(p))).toBe(true);
  // …and pass ordinary CSS: font names in quotes, a `/*` inside a string, a commented-out image-set,
  // and an attribute selector whose value is a URL prefix, at top level, in @media and in :not().
  expect(cssProblems(`a { font-family: "Segoe UI", 'Helvetica Neue'; content: "/*" } /* image-set("https://example.com/x.png" 1x) */ b { background: url(style.css) }`, SITE)).toEqual([]);
  expect(cssProblems(`a[href^="https://"]::after{content:" ↗"}`, SITE)).toEqual([]);
  expect(cssProblems(`@media (min-width: 1px) { a[href^="https://"]::after { content: " ↗" } } a:not([href^='//']) { color: red }`, SITE)).toEqual([]);
});

test("a malformed percent-escape or an unparseable https URL is reported, not thrown", () => {
  const named: [string, RegExp][] = [
    [`<img src="%zz.png">`, /^<img src> has a malformed percent-escape/],
    [`<a href="#%">x</a>`, /^<a href="#%"> has a malformed percent-escape/],
    [`<a href="https://[x/">x</a>`, /^<a href="https:\/\/\[x\/"> is not a URL a URL parser accepts/],
  ];
  for (const [b, why] of named) {
    let problems: string[] = [];
    expect(() => { problems = pageProblems(b, SITE).problems; }, b).not.toThrow();
    expect(problems.some((p) => why.test(p)), `${b} -> ${JSON.stringify(problems)}`).toBe(true);
  }
  let css: string[] = [];
  expect(() => { css = cssProblems(`a { background: url(%zz.png) }`, SITE); }).not.toThrow();
  expect(css.some((p) => /^url\(\) has a malformed percent-escape/.test(p)), JSON.stringify(css)).toBe(true);
});

test("the allowlist refuses whatever it does not list: the policy to the byte, elements, attributes, links, `&` and control characters", () => {
  const A = (s: string) => new RegExp(`^allowlist: ${s}`);
  const ELEMENT = (el: string) => A(`<${el}> is not an element`);
  const ATTR = (el: string, at: string) => A(`<${el} ${at}> is not an attribute`);
  const LINK = A(`<a href=.*> is neither`);
  const FRAGMENT = A(`<a href=.*> is a fragment not spelled as the allowlist reads one`);
  const AMP_IN_TAG = A(`"&" inside a tag`);
  const AMP_TEXT = A(`"&" at line \\d+ is not one of the text entities`);
  const NOT_POLICY = A(`<meta http-equiv> content is not byte-equal to POLICY`);
  // `default-src&#32;*` is one unknown directive to a scan that does not decode, and `default-src *` to a
  // browser, which keeps the first `default-src` (measured in headless Chrome: CSS and SVG fetches went out).
  const decoyPolicy = allowedPage("", `default-src&#32;*; ${POLICY}`);
  // Every message listed must appear, so each rule is shown to bite on its row by itself.
  const rows: [string, RegExp[]][] = [
    [decoyPolicy, [NOT_POLICY, AMP_IN_TAG]],
    [allowedPage("", POLICY.replace("; ", ";  ")), [NOT_POLICY]], // one extra space
    [allowedPage("", POLICY.replace("'none'", "'NONE'")), [NOT_POLICY]], // the same policy to a browser
    [allowedPage(`<meta http-equiv="Content-Security-Policy" content="${POLICY}">`), [A("the page has 2 <meta http-equiv>")]],
    [allowedPage(`<meta http-equiv="refresh" content="0; url=https://example.com/">`), [A(`<meta http-equiv> is "refresh"`), A("the page has 2 <meta http-equiv>")]],
    [allowedPage(`<meta charset="iso-2022-jp">`), [A(`<meta charset> is "iso-2022-jp"`)]],
    [allowedPage(`<meta name="referrer" content="unsafe-url">`), [A(`<meta name> is "referrer"`)]],
    [allowedPage(`<meta property="og:image" content="https://example.com/a.png">`), [ATTR("meta", "property"), A(`<meta> carries "content property"`)]],
    // Elements, wherever a tag sits: SVG animation that sets an href, an image even when relative, and tags
    // inside a comment or an attribute value.
    [allowedPage(`<svg><set attributeName="href" to="http://x"/></svg>`), [ELEMENT("svg"), ELEMENT("set"), ATTR("set", "attributename"), ATTR("set", "to")]],
    [allowedPage(`<svg><a><animate attributeName="href" values="http://x"/></a></svg>`), [ELEMENT("svg"), ELEMENT("animate"), ATTR("animate", "values")]],
    [allowedPage(`<img src="x.png">`), [ELEMENT("img"), ATTR("img", "src")]],
    [allowedPage(`<!-- <img src="x.png"> -->`), [ELEMENT("img"), ATTR("img", "src")]],
    [allowedPage(`<p class="<picture>">x</p>`), [ELEMENT("picture")]],
    [allowedPage(`<title><img src="x.png"></title>`), [ELEMENT("img")]],
    [allowedPage(`<template><img src="x.png"></template>`), [ELEMENT("template"), ELEMENT("img")]],
    // Attributes.
    [allowedPage(`<a href="https://github.com/x" target="_blank">x</a>`), [ATTR("a", "target")]],
    [allowedPage(`<a href="https://github.com/x" rel="noopener">x</a>`), [ATTR("a", "rel")]],
    [allowedPage(`<p style="color:red">x</p>`), [ATTR("p", "style")]],
    [allowedPage(`<p onclick="x()" data-x="1" title="t">x</p>`), [ATTR("p", "onclick"), ATTR("p", "data-x"), ATTR("p", "title")]],
    [allowedPage(`<p id="a" id="b">x</p>`), [A("<p id> is repeated")]],
    [allowedPage(`<link rel="preconnect" href="https://example.com/">`), [A(`<link> is rel="preconnect"`), A("the page has 2 <link> elements")]],
    [allowedPage(`<link rel="stylesheet" href="./style.css">`), [A(`<link> is rel="stylesheet" href="./style.css"`), A("the page has 2 <link> elements")]],
    // Links: off the host list (including a host that merely starts with one), and anything a parser decodes
    // or resolves.
    [allowedPage(`<a href="https://evil.example/">x</a>`), [LINK]],
    [allowedPage(`<a href="https://github.com.evil.example/">x</a>`), [LINK]],
    [allowedPage(`<a href="http://github.com/x">x</a>`), [LINK]],
    [allowedPage(`<a href="#nowhere">x</a>`), [LINK]],
    [allowedPage(`<a href="style.css">x</a>`), [LINK]],
    [allowedPage(`<a href="https://github.com/x/../y">x</a>`), [LINK]],
    [allowedPage(`<a href="https://github.com/%2e%2e/y">x</a>`), [LINK]],
    [allowedPage(`<a href="https://github.com\\@evil.example/">x</a>`), [LINK]],
    [allowedPage(`<a href="https://evil.example@github.com/">x</a>`), [LINK]],
    [allowedPage(`<a href="https://github.com:8443/">x</a>`), [LINK]],
    [allowedPage(`<a href="https://git\thub.com/">x</a>`), [LINK]],
    // A port the URL parser drops, the default one or an empty one, is refused as written.
    [allowedPage(`<a href="https://github.com:443/x">x</a>`), [LINK]],
    [allowedPage(`<a href="https://brew.sh:/">x</a>`), [LINK]],
    // …and so is one hidden behind extra slashes, which a parser skips (the written authority is empty),
    // as is the extra-slash spelling itself, and an authority the parser rewrites (case).
    [allowedPage(`<a href="https:///github.com:443/x">x</a>`), [LINK]],
    [allowedPage(`<a href="https:////brew.sh:/">x</a>`), [LINK]],
    [allowedPage(`<a href="https:///github.com/x">x</a>`), [LINK]],
    [allowedPage(`<a href="https://GitHub.com/x">x</a>`), [LINK]],
    // A fragment spelled otherwise than ID_LINK is refused with its own message, even when the page has the id.
    [allowedPage(`<p id="v1.2"></p><a href="#v1.2">x</a>`), [FRAGMENT]],
    [allowedPage(`<a href="#">x</a>`), [FRAGMENT]],
    // Characters: a reference in text, any `&` in a tag, and a control character (ESC switches ISO-2022-JP).
    [allowedPage(`<p>a &#x26; b</p>`), [AMP_TEXT]],
    [allowedPage(`<p>a &amp b</p>`), [AMP_TEXT]],
    [allowedPage(`<p class="a&amp;b">x</p>`), [AMP_IN_TAG]],
    [allowedPage(`<p>a\x1b$Bb</p>`), [A(`a control character \\(U\\+001B\\)`)]],
    [allowedPage(`<p>a\rb</p>`), [A(`a control character \\(U\\+000D\\)`)]],
    // Not a page at all: no policy, no stylesheet, no charset.
    [`<p>x</p>`, [A("the page has 0 <link> elements"), A("the page has 0 <meta http-equiv>"), A("the page has 0 <meta charset>")]],
    // The encoding floor: a page with no <meta charset>, one with two, and one whose charset sits past the
    // first 1024 bytes (behind a long description).
    [withPolicy(POLICY, `<link rel="stylesheet" href="style.css"></head><body></body></html>`), [A("the page has 0 <meta charset>")]],
    [allowedPage(`<meta charset="utf-8">`), [A("the page has 2 <meta charset>")]],
    [withPolicy(POLICY, `<meta name="description" content="${"x".repeat(1024)}"><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body></body></html>`),
      [A("<meta charset> ends at byte \\d+: it must sit wholly within the first 1024 bytes")]],
  ];
  for (const [doc, whys] of rows) {
    const problems = allowlistProblems(doc);
    for (const why of whys) expect(problems.some((p) => why.test(p)), `${doc} -> ${why} -> ${JSON.stringify(problems)}`).toBe(true);
  }
  // The fragment message replaces the link one, which would say the page has no such id when it has.
  const v12 = allowlistProblems(allowedPage(`<p id="v1.2"></p><a href="#v1.2">x</a>`));
  expect(v12.filter((p) => LINK.test(p)), JSON.stringify(v12)).toEqual([]);
  // The decoy policy is refused by the denylist's own policy parser too, in both places it runs.
  expect(policyProblems(decoyPolicy).some((p) => /^CSP holds a character reference/.test(p)), JSON.stringify(policyProblems(decoyPolicy))).toBe(true);
  expect(pageProblems(decoyPolicy, SITE).problems.some((p) => /^<meta http-equiv> CSP holds a character reference/.test(p))).toBe(true);
  // …and pass what is listed: every allowed element, the three text entities, ids, both hosts, a query and a
  // fragment on a link, and a GitHub compare URL's `...` (not a `..` segment).
  const ok = allowedPage(`<header class="top" id="t"><nav aria-label="x"><a href="#t">t</a></nav></header><main><section id="s">`
    + `<h1>a</h1><h2>b</h2><h3>c</h3><p>1 &lt; 2 &amp;&amp; 3 &gt; 2 <em>e</em> <b>b</b> <i>i</i> <small>s</small> <kbd>k</kbd>`
    + ` <strong>s</strong> <code>c</code> <span>s</span><br></p><hr><ul><li>x</li></ul><ol><li>y</li></ol><pre>p</pre>`
    + `<div><a href="https://github.com/a/b/compare/v1...v2?x=1#y">g</a> <a href="https://brew.sh">b</a></div></section></main>`
    + `<footer>f</footer>`);
  expect(allowlistProblems(ok)).toEqual([]);
  expect(pageProblems(ok, SITE).problems).toEqual([]);
  expect(policyProblems(ok)).toEqual([]);
});

test("the CSS allowlist refuses a backslash, a control character, any at-rule but @media, any string but a font name, and every fetching function", () => {
  const A = (s: string) => new RegExp(`^allowlist: ${s}`);
  const CONTROL = (hex: string) => A(`a control character \\(U\\+${hex}\\) at line \\d+`);
  const BACKSLASH = A("a backslash");
  const AT = A("an at-rule other than @media");
  const STRING = A("a quoted string at line \\d+ is not a font name");
  const FETCH = A(`a "[^"]+" function`);
  const rows: [string, RegExp[]][] = [
    // `cssProblems` ends an unquoted url() at its first `)`, escaped or not, so `\)` desyncs it: it then reads
    // `' ) } b { … } c { content: '` as one string, while a browser ends the bad url at `)` and loads the
    // second url(). No backslash, no escape.
    [`a { background: url(#\\) ' ) } b { background: url(https://example.com/x.png) } c { content: ' }`, [BACKSLASH, FETCH]],
    [`a { font-family: "Segoe\\20UI" }`, [BACKSLASH]],
    [`@font-face{}`, [AT]],
    [`@import "style.css";`, [AT]],
    [`@media print { @supports (display: grid) { a { color: red } } }`, [AT]],
    [`@MEDIA print { a { color: red } }`, [AT]],
    [`a { font-family: "https://x" }`, [STRING]],
    // Round 3 let a string inside a selector's `[…]` through (nothing fetches it). The allowlist does not, a
    // deliberate re-tightening: the stylesheet has no attribute selector, and a font name is the only string
    // it needs.
    [`a[title="a:b"] { color: red }`, [STRING]],
    [`a { font-family: "" }`, [STRING]],
    [`a { font-family: "Segoe UI }`, [A("a quoted string at line \\d+ is not closed")]],
    // A `/*` inside a string is not a comment: the url() after it is code.
    [`a { font-family: "x/*" } b { background: url(x.png) } /* */`, [STRING, FETCH]],
    [`a { background: URL(x.png) }`, [FETCH]],
    [`a { background: -webkit-image-set(x 1x) }`, [FETCH]],
    [`a { background: image-set(x 1x) }`, [FETCH]],
    [`a { background: cross-fade(a, b) }`, [FETCH]],
    [`a { background: image(x) }`, [FETCH]],
    [`a { background: -moz-element(#x) }`, [FETCH]],
    [`a { background: src(x) }`, [FETCH]],
    // Control characters, as in the page: a CR (so a CRLF line ending), an ESC, and NULs, which are how a
    // UTF-16LE stylesheet reads as UTF-8 (`u\0r\0l\0(` matches no rule above, and is CSS to a browser).
    [`a { color: red }\r\nb { color: blue }`, [CONTROL("000D")]],
    [`a { color: red }\x1b`, [CONTROL("001B")]],
    ["body{background:url(x.png)}".split("").join("\0"), [CONTROL("0000")]],
  ];
  for (const [css, whys] of rows) {
    const problems = cssAllowlistProblems(css);
    for (const why of whys) expect(problems.some((p) => why.test(p)), `${css} -> ${why} -> ${JSON.stringify(problems)}`).toBe(true);
  }
  // …and pass what is listed: @media, font names in either quote, and a url() or quote inside a comment.
  expect(cssAllowlistProblems(`/* no url(x) or "quote: here" */ @media (prefers-color-scheme: dark) { a { font-family: "Segoe UI", 'Liberation Mono', serif } }`)).toEqual([]);
});

// ── the real page ────────────────────────────────────────────────────────────────────────────────

test("site/index.html makes no external request, carries no script, and every link resolves or is allowlisted", () => {
  const html = readSiteText(PAGE);
  const { problems, links, resources } = pageProblems(html, dirname(PAGE));
  expect(problems).toEqual([]);
  // Floors, so a parser that stopped seeing tags fails here instead of passing an empty page.
  expect(links).toBeGreaterThanOrEqual(10);
  expect(resources).toBeGreaterThanOrEqual(1);
});

test("site/index.html opens with its Content-Security-Policy, and the policy is strict", () => {
  expect(policyProblems(readSiteText(PAGE))).toEqual([]);
});

test("site/index.html passes the allowlist: its policy to the byte, and only listed elements, attributes and characters", () => {
  // The allowlist's own floors (exactly one policy, exactly one <link>) fail an empty or unread page.
  expect(allowlistProblems(readSiteText(PAGE))).toEqual([]);
});

test("every CSS file under site/ passes the CSS allowlist", () => {
  const css = judgedFiles(SITE).filter((f) => f.toLowerCase().endsWith(".css"));
  expect(css).toContain("style.css");
  for (const f of css) expect(cssAllowlistProblems(readSiteText(join(SITE, f))), f).toEqual([]);
});

test("the page's one stylesheet, and every other CSS file under site/, loads nothing", () => {
  const html = readSiteText(PAGE);
  const sheets = stylesheets(html);
  expect(sheets).toEqual(["style.css"]);
  for (const s of sheets) {
    const file = join(SITE, s);
    expect(statSync(file).isFile()).toBe(true);
    expect(cssProblems(readSiteText(file), dirname(file))).toEqual([]);
  }
  // Every .css file, linked or not: a stylesheet can be reached by an @import, or by a link whose
  // `rel` is spelled with a character reference.
  const css = judgedFiles(SITE).filter((f) => f.toLowerCase().endsWith(".css"));
  expect(css).toContain("style.css");
  for (const f of css) {
    const file = join(SITE, f);
    expect(cssProblems(readSiteText(file), dirname(file)), f).toEqual([]);
  }
});

test("site/ holds no document but index.html, so nothing the page could open goes unread", () => {
  for (const f of ["a.htm", "a.HTML", "a.xhtml", "a.xht", "a.shtml", "a.mht", "a.mhtml", "a.svg", "a.svgz", "a.xml",
    "a.xsl", "a.xslt", "a.pdf", "a.PDF", "a.webarchive"]) {
    expect(DOCUMENT_FILE.test(f), f).toBe(true);
  }
  expect(DOCUMENT_FILE.test("style.css")).toBe(false);
  // A planted listing of site/: a .pdf beside the page, in a subfolder, is a second document.
  expect(["index.html", "notes/guide.pdf", "style.css"].filter((f) => DOCUMENT_FILE.test(f))).toEqual(["index.html", "notes/guide.pdf"]);
  const documents = judgedFiles(SITE).filter((f) => DOCUMENT_FILE.test(f));
  expect(documents, "a second document under site/ needs this test to read it too").toEqual(["index.html"]);
});

test("site/ holds exactly index.html and style.css: no other file, directory, dotfile or symlink", () => {
  const F = (path: string): SiteEntry => ({ path, kind: "file" });
  const two = [F("index.html"), F("style.css")];
  // Planted listings, as the test above plants names: nothing is written under site/.
  const rows: [string, SiteEntry[], RegExp][] = [
    // An extension DOCUMENT_FILE does not list, which Chrome renders from file:// all the same.
    ["an extra .ehtml", [F("about.ehtml"), ...two], /^site\/about\.ehtml is not index\.html or style\.css/],
    ["an extra .rss", [F("feed.rss"), ...two], /^site\/feed\.rss is not index\.html or style\.css/],
    ["a nested directory", [...two, { path: "x", kind: "directory" }, F("x/a.css")], /^site\/x\/ is a directory/],
    ["a nested directory's file", [...two, { path: "x", kind: "directory" }, F("x/a.css")], /^site\/x\/a\.css is not index\.html or style\.css/],
    ["a dotfile", [F(".notes.xbl"), ...two], /^site\/\.notes\.xbl is not index\.html or style\.css/],
    ["a symlink", [...two, { path: "about.html", kind: "symlink" }], /^site\/about\.html is a symlink/],
    ["the stylesheet as a symlink", [F("index.html"), { path: "style.css", kind: "symlink" }], /^site\/style\.css is a symlink/],
    ["a fifo", [...two, { path: "p", kind: "other" }], /^site\/p is not a regular file/],
    ["no stylesheet", [F("index.html")], /^site\/style\.css is missing/],
  ];
  for (const [what, entries, why] of rows) {
    const problems = siteEntryProblems(entries);
    expect(problems.some((p) => why.test(p)), `${what} -> ${JSON.stringify(problems)}`).toBe(true);
  }
  expect(siteEntryProblems(two)).toEqual([]);
  // The real site/, every entry read with lstat: exactly the two files (a git-ignored .DS_Store aside, below).
  const entries = judgedEntries(SITE);
  expect(siteEntryProblems(entries)).toEqual([]);
  expect(entries).toEqual(two);
});

test("a Finder .DS_Store in site/ is left out only while git ignores it: tracked, unignored or outside a checkout, it fails", () => {
  const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-site-dsstore-")));
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=f", "-c", "user.email=f@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
    expect(`git ${args.join(" ")}: ${r.exitCode} ${r.stderr}`).toBe(`git ${args.join(" ")}: 0 `);
  };
  // `finderAfterCommit`: the .DS_Store appears only after the fixture commit, so `add -A` cannot stage it.
  const site = (name: string, ignore: boolean, track: boolean, inGit = true, finderAfterCommit = false) => {
    const repo = join(base, name);
    mkdirSync(join(repo, "site"), { recursive: true });
    for (const f of SITE_FILES) writeFileSync(join(repo, "site", f), "x\n");
    const finder = () => writeFileSync(join(repo, "site", ".DS_Store"), new Uint8Array([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]));
    if (!finderAfterCommit) finder();
    if (inGit) {
      if (ignore) writeFileSync(join(repo, ".gitignore"), ".DS_Store\n");
      git(repo, "init", "-q");
      // Only this repo's own .gitignore decides: `ignoredFinderFile` runs git with the inherited environment,
      // where a user's global excludes file (which often lists .DS_Store) would otherwise ignore it too.
      git(repo, "config", "core.excludesFile", "/dev/null");
      git(repo, "add", "-A");
      if (track) git(repo, "add", "-f", "site/.DS_Store");
      git(repo, "commit", "-qm", "fixture");
    }
    if (finderAfterCommit) finder();
    return join(repo, "site");
  };
  // The fixture's premise, read the way the judge reads it (inherited environment, `git -C <site>`):
  // tracked = `ls-files --error-unmatch` exits 0; ignored = `check-ignore -q` exits 0 (1 = not ignored).
  const gitRc = (dir: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "ignore", stderr: "ignore" }).exitCode;
  const premise = (dir: string) =>
    `tracked ${gitRc(dir, "ls-files", "--error-unmatch", "--", ".DS_Store") === 0}, check-ignore ${gitRc(dir, "check-ignore", "-q", "--", ".DS_Store")}`;
  const two = SITE_FILES.map((path) => ({ path, kind: "file" as const }));
  // Ignored and untracked: never exported, so left out.
  const ignored = site("ignored", true, false);
  expect(premise(ignored)).toBe("tracked false, check-ignore 0");
  expect(judgedEntries(ignored)).toEqual(two);
  expect(judgedFiles(site("ignored2", true, false))).toEqual(SITE_FILES);
  // Tracked despite the ignore rule, not ignored at all (and untracked: it appeared after the commit), or no
  // checkout (the export): listed, and refused.
  const tracked = site("tracked", true, true);
  const unignored = site("unignored", false, false, true, true);
  expect(premise(tracked)).toBe("tracked true, check-ignore 1");
  expect(premise(unignored)).toBe("tracked false, check-ignore 1");
  for (const [what, dir] of [["tracked", tracked], ["not ignored", unignored], ["no checkout", site("nogit", true, false, false)]] as const) {
    const problems = siteEntryProblems(judgedEntries(dir));
    expect(`${what}: ${JSON.stringify(problems)}`).toMatch(/site\/\.DS_Store is not index\.html or style\.css/);
    expect(judgedFiles(dir)).toContain(".DS_Store");
  }
  // Only a Finder file: another ignored name is still listed.
  const other = site("other", true, false);
  writeFileSync(join(dirname(other), ".gitignore"), ".DS_Store\n*.swp\n");
  writeFileSync(join(other, ".index.html.swp"), "x");
  expect(judgedFiles(other)).toContain(".index.html.swp");
});

test("every file under site/ is strict UTF-8: no malformed byte, no byte-order mark, no U+FEFF", () => {
  const utf8 = (s: string) => new TextEncoder().encode(s);
  // A stylesheet that fetches, saved as UTF-16 with a byte-order mark: CSS to a browser.
  const le = new Uint8Array(Buffer.from("body{background-image:url(http://example.com/x.png)}", "utf16le"));
  const be = le.map((_, i) => le[i ^ 1]!); // each byte pair swapped
  const utf16le = new Uint8Array([0xff, 0xfe, ...le]);
  const utf16be = new Uint8Array([0xfe, 0xff, ...be]);
  const NOT_UTF8 = /^is not valid UTF-8/;
  const rows: [string, Uint8Array, RegExp][] = [
    ["UTF-16LE with a BOM", utf16le, NOT_UTF8],
    ["UTF-16BE with a BOM", utf16be, NOT_UTF8],
    ["Latin-1", new Uint8Array([0x61, 0xe9, 0x62]), NOT_UTF8],
    ["a UTF-8 BOM", new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("a { color: red }")]), /^starts with a UTF-8 byte-order mark/],
    ["a U+FEFF after the start", utf8("a {\uFEFF color: red }"), /^holds a U\+FEFF .* at line 1$/],
  ];
  for (const [what, bytes, why] of rows) {
    const problems = encodingProblems(bytes);
    expect(problems.some((p) => why.test(p)), `${what} -> ${JSON.stringify(problems)}`).toBe(true);
    // …and a read of it throws, naming the file, rather than handing a checker text a browser reads otherwise.
    expect(() => siteText(bytes, "site/style.css"), what).toThrow(/^site\/style\.css (is not valid UTF-8|starts with a UTF-8 byte-order mark|holds a U\+FEFF)/);
  }
  // Read leniently, as `readFileSync(…, "utf8")` read it, the UTF-16LE sheet's NULs split every name and every
  // `url(`; the CSS allowlist's control-character rule is the only one that still sees it.
  expect(cssAllowlistProblems(Buffer.from(utf16le).toString("utf8")).some((p) => /^allowlist: a control character \(U\+0000\)/.test(p))).toBe(true);
  // …and pass plain UTF-8, non-ASCII included.
  expect(encodingProblems(utf8("/* ↗ é */ a { color: red }"))).toEqual([]);
  expect(siteText(utf8("a ↗"), "site/x")).toBe("a ↗");
  // The real files: every one under site/, each through the strict decoder.
  const files = judgedFiles(SITE);
  expect(files).toEqual(expect.arrayContaining(SITE_FILES));
  for (const f of files) expect(encodingProblems(readFileSync(join(SITE, f))), `site/${f}`).toEqual([]);
});

test("the page has the sections the plan names, and its downloads point at the latest release", () => {
  const html = readSiteText(PAGE);
  for (const id of ["what", "sample", "download", "privacy", "links"]) expect(html).toContain(`id="${id}"`);
  expect(html).toContain('href="https://github.com/themarigold/daily-briefing/releases/latest"');
  // The sample is invented, and says so.
  expect(html).toMatch(/invented example/i);
});
