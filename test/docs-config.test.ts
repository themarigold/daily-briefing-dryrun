// test/docs-config.test.ts — docs/CONFIG.md cannot drift from the `Config` type (Phase E, E16).
//
// WHY THIS EXISTS. CONFIG.md is the one place a stranger learns what each key means. A key added to
// `src/types.ts` without an entry there is a setting nobody can find; an entry left behind after a key
// is removed documents a setting that does nothing. Both happen silently, so the key list is read from
// the type itself rather than copied into this file: a hand-written list here would be a third copy
// that drifts with the other two.
//
// WHAT IS COVERED, exactly (plan §4 M5, E16): every top-level property of `Config`, plus one level
// under `provider` and `updateCheck`. Nothing deeper: `provider.api`'s own fields are a table inside
// its entry, not headings.
//
// THE HEADING RULE. A CONFIG.md heading whose text starts with a backtick is a KEY heading and must be
// exactly `### \`<key>\``. Any other heading is prose (a section title). So a heading that names a key
// that does not exist, or a nested key that is not covered (`provider.api.kind`), fails here rather than
// passing as prose. Headings inside fenced code blocks are not headings.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname);
const TYPES = `${ROOT}src/types.ts`;
const DOC = `${ROOT}docs/CONFIG.md`;

/** The nested objects whose own keys get an entry each. */
const NESTED = ["provider", "updateCheck"] as const;

/** The property names of a type literal, in source order. */
function members(lit: ts.TypeLiteralNode): string[] {
  const out: string[] = [];
  for (const m of lit.members) {
    if (ts.isPropertySignature(m) && m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) out.push(m.name.text);
  }
  return out;
}

/** Every covered key, read from `export type Config = { … }` with the TypeScript compiler API. */
function coveredKeys(): { keys: string[]; topLevel: string[]; nestedFound: string[] } {
  const src = ts.createSourceFile(TYPES, readFileSync(TYPES, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let config: ts.TypeLiteralNode | undefined;
  for (const st of src.statements) {
    if (ts.isTypeAliasDeclaration(st) && st.name.text === "Config" && ts.isTypeLiteralNode(st.type)) config = st.type;
  }
  if (!config) throw new Error("src/types.ts has no `export type Config = { … }` type literal — the drift guard cannot read the keys");
  const topLevel = members(config);
  const keys = [...topLevel];
  const nestedFound: string[] = [];
  for (const m of config.members) {
    if (!ts.isPropertySignature(m) || !m.name || !ts.isIdentifier(m.name)) continue;
    const name = m.name.text;
    if (!(NESTED as readonly string[]).includes(name)) continue;
    if (!m.type || !ts.isTypeLiteralNode(m.type)) {
      throw new Error(`Config.${name} is no longer an inline object type — decide how CONFIG.md covers its keys, then update this test`);
    }
    nestedFound.push(name);
    for (const sub of members(m.type)) keys.push(`${name}.${sub}`);
  }
  return { keys, topLevel, nestedFound };
}

/** Headings outside fenced code blocks, with the 1-based line each starts on. */
function headings(md: string): { level: number; text: string; line: number }[] {
  const out: { level: number; text: string; line: number }[] = [];
  let fenced = false;
  md.split("\n").forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; return; }
    if (fenced) return;
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(raw);
    if (m) out.push({ level: m[1]!.length, text: m[2]!, line: i + 1 });
  });
  return out;
}

/** Key headings (the backtick rule above), plus every heading that starts like one but is malformed. */
function keyHeadings(md: string): { names: string[]; malformed: string[] } {
  const names: string[] = [];
  const malformed: string[] = [];
  for (const h of headings(md)) {
    if (!h.text.startsWith("`")) continue;
    const m = /^`([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)`$/.exec(h.text);
    if (h.level !== 3 || !m) malformed.push(`line ${h.line}: ${"#".repeat(h.level)} ${h.text}`);
    else names.push(m[1]!);
  }
  return { names, malformed };
}

/** The body of each key entry: from its heading to the next heading of any level. */
function entryBodies(md: string): Map<string, string> {
  const lines = md.split("\n");
  const hs = headings(md);
  const bodies = new Map<string, string>();
  hs.forEach((h, i) => {
    const m = /^`([^`]+)`$/.exec(h.text);
    if (h.level !== 3 || !m) return;
    const end = i + 1 < hs.length ? hs[i + 1]!.line - 1 : lines.length;
    bodies.set(m[1]!, lines.slice(h.line, end).join("\n"));
  });
  return bodies;
}

test("the walk of the Config type is not vacuous", () => {
  const { keys, topLevel, nestedFound } = coveredKeys();
  // The plan's floor: these three must be found, or the walk has stopped reading the real type.
  for (const k of ["provider", "updateCheck", "networkProbeHosts"]) expect(topLevel).toContain(k);
  expect(nestedFound.sort()).toEqual([...NESTED].sort());
  // Measured at this commit: 17 top-level keys, 8 under provider, 2 under updateCheck. Floored a few
  // below, so a deleted key still passes here (the comparison below is what catches it in the doc).
  expect(topLevel.length).toBeGreaterThanOrEqual(15);
  expect(keys.filter((k) => k.startsWith("provider.")).length).toBeGreaterThanOrEqual(6);
  expect(keys).toContain("updateCheck.enabled");
  expect(keys).toContain("updateCheck.intervalHours");
});

test("docs/CONFIG.md has exactly one entry per covered Config key, and no entry for anything else", () => {
  const { keys } = coveredKeys();
  const { names, malformed } = keyHeadings(readFileSync(DOC, "utf8"));
  expect(malformed, "headings that start with a backtick must be exactly ### `<key>`").toEqual([]);
  const missing = keys.filter((k) => !names.includes(k));
  const unknown = names.filter((n) => !keys.includes(n));
  const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
  expect(missing, "Config keys with no CONFIG.md entry").toEqual([]);
  expect(unknown, "CONFIG.md entries that name no covered Config key").toEqual([]);
  expect(duplicated, "CONFIG.md keys with more than one entry").toEqual([]);
});

test("every CONFIG.md entry states its type and its default", () => {
  const bodies = entryBodies(readFileSync(DOC, "utf8"));
  expect(bodies.size).toBeGreaterThanOrEqual(20);
  const incomplete = [...bodies].filter(([, b]) => !b.includes("**Type:**") || !b.includes("**Default:**")).map(([k]) => k);
  expect(incomplete, "entries missing a **Type:** or **Default:** label").toEqual([]);
});
