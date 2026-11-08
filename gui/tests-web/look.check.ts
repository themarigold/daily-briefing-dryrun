/**
 * Step 0, the shared look (hub spec "Step 0: the shared look (spec)"; plan S0-M1).
 *
 * S0-M1-T1 — project colours. `gui/src/lib/project-color.ts` maps a project label to one of 12
 * palette slots: the label normalised by the GUI's port of the engine's `norm`, then djb2 over its
 * code points with a 32-bit wrap, modulo 12; on one page, the next free slot on a collision.
 *
 * ⚠ THE VECTORS BELOW ARE NOT COMPUTED BY THE CODE UNDER TEST. They are the literal output of
 * `gui/tests-web/probes/project-color-vectors.swift`, a separate Swift program that takes the RAW
 * labels and implements `norm`, the old local app's hash (`daily_briefing/BriefingSlides/
 * SlideContent.swift`, `pillHue`, modulo 12 instead of 360) and the page rule itself. So this check
 * can fail, and the GUI's `norm` port is under test as well. To regenerate, or to confirm the block
 * is unchanged, from `gui/`:
 *
 *     swift tests-web/probes/project-color-vectors.swift \
 *       | diff - <(sed -n '/^\/\/ BEGIN swift-vectors/,/^\/\/ END swift-vectors/p' tests-web/look.check.ts)
 *
 * Never edit the block by hand.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRawSnippet } from "svelte";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";

import { norm as engineNorm } from "../../src/subprojects";
import { norm as guiNorm } from "../src/lib/briefing-struct";
import { assignSlots, PALETTE_SLOTS, paletteClass, preferredSlot } from "../src/lib/project-color";
import { focusHeading, nextLiveText } from "../src/lib/ui/a11y";
import ActionButton from "../src/lib/ui/ActionButton.svelte";
import Card from "../src/lib/ui/Card.svelte";
import { clampInt, clampPct } from "../src/lib/ui/geometry";
import LiveRegion from "../src/lib/ui/LiveRegion.svelte";
import { durations, GLIDE_MS, HIGHLIGHT_MS, OPEN_MS, prefersReducedMotion, REDUCED_MOTION_QUERY } from "../src/lib/ui/motion";
import Pill from "../src/lib/ui/Pill.svelte";
import StatusTag from "../src/lib/ui/StatusTag.svelte";
import { TAG_WORDS } from "../src/lib/ui/tag-kind";
import Tile from "../src/lib/ui/Tile.svelte";

const PROJECT_COLOR_SRC = new URL("../src/lib/project-color.ts", import.meta.url).pathname;

// BEGIN swift-vectors (generated, from gui/: swift tests-web/probes/project-color-vectors.swift)
const SLOT_VECTORS: ReadonlyArray<readonly [string, number]> = [
  ["mono", 2],
  ["Mono", 2],
  ["**Mono**", 2],
  ["`mono`", 2],
  ["Mono.", 2],
  ["  Mono!? ", 2],
  ["\u{9}MONO\u{A}", 2],
  ["accountant_ai", 2],
  ["quant_stocks", 8],
  ["quant_options", 9],
  ["daily_briefing_application", 4],
  ["btc_forecaster_live", 2],
  ["ai_news", 3],
  ["Personal Code", 8],
  ["personal_code", 11],
  ["Mixed_Case-Name", 9],
  ["`**Deep**`", 3],
  ["a.b.c.", 11],
  ["x", 9],
  ["", 5],
  ["**", 5],
  ["Caf\u{E9}", 4],
  ["\u{C9}COLE", 1],
  ["e\u{301}cole", 6],
  ["na\u{EF}ve-app", 4],
  ["\u{1F680} launch", 0],
  ["rocket \u{1F680}", 1],
  ["\u{65E5}\u{672C}\u{8A9E}", 8],
  ["cafe\u{301}", 9],
  ["\u{FEFF}mono", 2],
  ["mono\u{85}", 3],
  ["\u{3000}mono\u{2028}", 2],
  ["proj-y", 2],
];
const PAGE_VECTORS: ReadonlyArray<readonly [readonly string[], readonly (number | null)[]]> = [
  [["proj-a", "proj-m", "proj-b", "proj-j", "proj-v", "proj-w", "proj-d", "proj-e", "proj-f", "proj-g", "proj-h", "proj-i", "proj-n"], [2, 3, 4, 11, 0, 1, 5, 6, 7, 8, 9, 10, 3]],
  [["Mono", "proj-x", "mono", "**Mono**", "`mono`.", "proj-l"], [2, 1, 2, 2, 2, 3]],
  [["proj-a", "proj-m", "proj-b", "proj-c", "proj-d", "proj-e", "proj-f", "proj-g", "proj-h", "proj-i", "proj-k", "proj-y"], [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1]],
  [["caf\u{E9}", "cafe\u{301}", "Caf\u{E9}"], [4, 9, 4]],
  [["Mono", "", "**", "mono", "dba", "proj-c"], [2, null, null, 2, 4, 5]],
];
// END swift-vectors

describe("project-color: label → slot (vectors from the Swift oracle)", () => {
  test("the vector list is big enough to mean something, and covers the hard cases", () => {
    // Floors, so a shrunk list fails loudly rather than passing over nothing.
    expect(SLOT_VECTORS.length).toBeGreaterThanOrEqual(20);
    const labels = SLOT_VECTORS.map(([l]) => l);
    expect(labels.some((l) => [...l].some((ch) => ch.codePointAt(0)! > 0xffff))).toBe(true); // an emoji
    expect(labels.some((l) => [...l].some((ch) => { const c = ch.codePointAt(0)!; return c > 0x7f && c <= 0xffff; }))).toBe(true);
    expect(labels).toContain("**Mono**");
    expect(labels).toContain("`mono`");
    expect(labels).toContain("Mono.");
    // Every slot the oracle produced is a real slot.
    for (const [, s] of SLOT_VECTORS) expect(Number.isInteger(s) && s >= 0 && s < 12).toBe(true);
  });

  test("preferredSlot gives the oracle's slot for every raw label", () => {
    expect(SLOT_VECTORS.map(([l]) => [l, preferredSlot(l)])).toEqual(SLOT_VECTORS.map(([l, s]) => [l, s]));
  });

  test("there are exactly 12 slots", () => {
    expect(PALETTE_SLOTS).toBe(12);
  });

  test("decorated spellings of one project land on one slot (normalised first)", () => {
    const mono = preferredSlot("mono");
    for (const l of ["Mono", "**Mono**", "`mono`", "Mono.", "  Mono!? ", "\tMONO\n"]) expect(preferredSlot(l)).toBe(mono);
  });

  test("it normalises with the GUI's one port of norm, never a copy of its own", () => {
    const src = readFileSync(PROJECT_COLOR_SRC, "utf8");
    expect(src).toMatch(/import\s*\{[^}]*\bnorm\b[^}]*\}\s*from\s*"\.\/briefing-struct"/);
  });
});

describe("project-color: one page's assignment (vectors from the Swift oracle)", () => {
  test("the page vectors force the next free slot, the wrap, and the 13th label's reuse", () => {
    const [labels, slots] = PAGE_VECTORS[0]!;
    expect(labels.length).toBe(13);
    // The first twelve take every slot exactly once; the 13th repeats its preferred slot.
    expect([...slots.slice(0, 12)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(slots[12]).toBe(slots[1]!); // proj-n prefers proj-m's taken slot
  });

  test("assignSlots gives the oracle's slots, in page order", () => {
    for (const [labels, slots] of PAGE_VECTORS) expect(assignSlots(labels)).toEqual([...slots]);
  });

  test("Mono and mono share one slot and take no second one", () => {
    expect(assignSlots(["Mono", "mono"])).toEqual([preferredSlot("mono"), preferredSlot("mono")]);
    const [labels, slots] = PAGE_VECTORS[1]!;
    expect(labels.filter((l) => guiNorm(l) === "mono").length).toBe(4);
    expect(new Set(slots.filter((_, i) => guiNorm(labels[i]!) === "mono")).size).toBe(1);
  });

  test("a label that normalises to nothing takes no slot (null), so it never costs a project its colour", () => {
    const [labels, slots] = PAGE_VECTORS[4]!;
    const empty = labels.filter((l) => guiNorm(l) === "");
    expect(empty.length).toBeGreaterThanOrEqual(2);
    // null exactly where the label is empty…
    expect(labels.map((l) => guiNorm(l) === "")).toEqual(slots.map((s) => s === null));
    // …and the projects after it get the slots they would get with the empty labels left out.
    const projects = labels.filter((l) => guiNorm(l) !== "");
    expect(slots.filter((s) => s !== null)).toEqual(assignSlots(projects));
    expect(assignSlots(["", "**", "`*`"])).toEqual([null, null, null]);
  });

  test("it returns slot numbers only, never a style string", () => {
    const out = assignSlots(["a", "b", "c"]);
    expect(out.every((s) => typeof s === "number" && Number.isInteger(s) && s >= 0 && s < 12)).toBe(true);
    expect(assignSlots([])).toEqual([]);
  });

  test("the TWELFTH distinct label, whose preferred slot is taken, gets the one free slot", () => {
    const [labels, slots] = PAGE_VECTORS[2]!;
    expect(labels.length).toBe(12);
    expect(new Set(labels.map(guiNorm)).size).toBe(12);
    const twelfth = SLOT_VECTORS.find(([l]) => l === labels[11])!; // its preferred slot, from the oracle
    expect(slots.slice(0, 11)).toContain(twelfth[1]); // …is already taken by the first eleven
    expect([...slots].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test("paletteClass: a slot's class name, clamped to the palette; null (and NaN) is the neutral pc-other", () => {
    for (let s = 0; s < 12; s++) expect(paletteClass(s)).toBe(`pc-${s}`);
    const cases: [number | null, string][] = [[null, "pc-other"], [NaN, "pc-other"], [-1, "pc-0"], [-50, "pc-0"], [-0.5, "pc-0"], [12, "pc-11"], [99, "pc-11"], [2.7, "pc-2"], [Infinity, "pc-11"], [-Infinity, "pc-0"]];
    for (const [slot, want] of cases) expect({ slot, cls: paletteClass(slot) }).toEqual({ slot, cls: want });
    // Every name it can return is a class app.css defines.
    const defined = new Set(parseCss(readFileSync(APP_CSS, "utf8")).map((r) => r.selector));
    for (const s of [null, ...Array.from({ length: 12 }, (_, i) => i)]) expect(defined.has(`.${paletteClass(s)}`)).toBe(true);
  });

  test("(source pin) Pill draws its class through paletteClass, not a copy of its own", () => {
    const pill = uiSource("Pill.svelte");
    expect(pill).toMatch(/import \{[^}]*\bpaletteClass\b[^}]*\} from "\.\.\/project-color"/);
    // Outside its doc comment, Pill has no clamp and no class name of its own.
    expect(pill.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/Math\.(min|max|trunc)|pc-other|`pc-/);
  });

  test("a composed and a decomposed é are two labels with two slots (keys are code points, not canonical equivalence)", () => {
    const [labels, slots] = PAGE_VECTORS[3]!;
    expect(labels[0]).not.toBe(labels[1]);
    expect(labels[0]!.normalize("NFC")).toBe(labels[1]!.normalize("NFC")); // canonically equivalent…
    expect(slots[0]).not.toBe(slots[1]); // …and still two projects
    expect(slots[2]).toBe(slots[0]!); // `Café` is the composed one again
  });

  test("property: any 12 labels that normalise differently get a permutation of 0-11 (fixed seed)", () => {
    // mulberry32, a fixed seed: deterministic, so a failure reproduces.
    let seed = 0x5eed1234;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const ALPHABET = "abcdefghijklmnopqrstuvwxyz_-*`. MÉé\u{1F680}";
    let pages = 0;
    for (let n = 0; n < 300; n++) {
      const labels: string[] = [];
      const keys = new Set<string>();
      while (labels.length < 12) {
        const len = 1 + Math.floor(rand() * 8);
        const l = Array.from({ length: len }, () => [...ALPHABET][Math.floor(rand() * [...ALPHABET].length)]!).join("");
        if (guiNorm(l) === "" || keys.has(guiNorm(l))) continue; // an empty label is not a project (null)
        keys.add(guiNorm(l));
        labels.push(l);
      }
      expect({ labels, slots: [...assignSlots(labels)].sort((a, b) => a - b) }).toEqual({ labels, slots: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
      pages++;
    }
    expect(pages).toBe(300);
  });
});

describe("norm: the GUI's port agrees with the engine's (the hub's engine-vector pin)", () => {
  // The GUI port is `gui/src/lib/briefing-struct.ts` `norm`; the engine's is `src/subprojects.ts` `norm`.
  const PARITY = [
    ...SLOT_VECTORS.map(([l]) => l),
    "***",
    "a!!!",
    "x. ",
    " .x",
    "MiXeD`*`Case",
    "trailing?!.,;:",
    "inner.dots.stay",
    "  **spaced**  .",
    "\u{130}stanbul",
    "\u{39F}\u{394}\u{39F}\u{3A3}",
    "Stra\u{DF}e",
    "\u{FEFF}bom",
    "tab\tinside",
  ];

  test("the two are separate implementations (so this compares something)", () => {
    expect(guiNorm).not.toBe(engineNorm);
  });

  test("they agree on every vector", () => {
    expect(PARITY.length).toBeGreaterThanOrEqual(40);
    expect(PARITY.map(guiNorm)).toEqual(PARITY.map(engineNorm));
  });
});

/* ── S0-M1-T2: the tokens and the palette in app.css, and their contrast ─────────────────────────
 *
 * Method: pure model over `app.css` READ AS TEXT. A string render cannot switch the
 * `prefers-color-scheme` media query, so the two themes are resolved here the way the cascade
 * resolves them: the light values are the top-level rules; the dark values are the light ones
 * overlaid by the rules inside the file's one `@media (prefers-color-scheme: dark)` block.
 *
 * Contrast is WCAG 2.x: relative luminance from sRGB, ratio (L1 + 0.05) / (L2 + 0.05). Text must
 * reach 4.5:1 (AA); non-text signals (tag colours, state outlines) 3:1 (WCAG 1.4.11). Each signal
 * is measured against BOTH the tile (`--tile`) and the page background (`--bg`), in both themes.
 */

const APP_CSS = new URL("../src/app.css", import.meta.url).pathname;

interface CssRule {
  selector: string;
  decls: Map<string, string>;
  /** Offset of the rule's opening brace in the source (for cascade order). */
  at: number;
  children: CssRule[];
}

/** A small parser for this one stylesheet: rules, nested one level in `@media`, no strings with braces. */
function parseCss(source: string): CssRule[] {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length));
  const parse = (from: number, to: number): CssRule[] => {
    const rules: CssRule[] = [];
    let i = from;
    while (i < to) {
      const open = src.indexOf("{", i);
      if (open < 0 || open >= to) break;
      let depth = 1;
      let j = open + 1;
      for (; j < to && depth > 0; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
      }
      const close = j - 1;
      const selector = src.slice(i, open).trim();
      const inner = src.slice(open + 1, close);
      const isAt = selector.startsWith("@");
      const decls = new Map<string, string>();
      if (!isAt) {
        for (const d of inner.split(";")) {
          const k = d.indexOf(":");
          if (k < 0) continue;
          decls.set(d.slice(0, k).trim(), d.slice(k + 1).trim());
        }
      }
      rules.push({ selector, decls, at: open, children: isAt ? parse(open + 1, close) : [] });
      i = close + 1;
    }
    return rules;
  };
  return parse(0, src.length);
}

const DARK_QUERY = "@media (prefers-color-scheme: dark)";

/** The declarations a selector resolves to in each theme, by cascade order (later wins). */
function resolve(rules: CssRule[], selector: string): { light: Map<string, string>; dark: Map<string, string> } {
  const light = new Map<string, string>();
  for (const r of rules) if (r.selector === selector) for (const [k, v] of r.decls) light.set(k, v);
  const dark = new Map(light);
  for (const m of rules.filter((r) => r.selector === DARK_QUERY)) {
    for (const r of m.children) if (r.selector === selector) for (const [k, v] of r.decls) dark.set(k, v);
  }
  return { light, dark };
}

/** `#rgb` or `#rrggbb` → [r, g, b] in 0-255; anything else throws (a signal colour must be a plain hex). */
function hex(value: string | undefined): [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((value ?? "").trim());
  if (!m) throw new Error(`not a hex colour: ${JSON.stringify(value)}`);
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)) as [number, number, number];
}

/** An sRGB channel (0-255) to linear light: the one transfer function, for WCAG luminance and OKLab. */
function lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string | undefined, b: string | undefined): number {
  const [la, lb] = [luminance(hex(a)), luminance(hex(b))];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Every pair below `min`, as readable lines (an empty list is a pass). */
function shortfalls(pairs: ReadonlyArray<readonly [string, string | undefined, string | undefined]>, min: number): string[] {
  return pairs.flatMap(([what, fg, bg]) => {
    const c = contrast(fg, bg);
    return c >= min ? [] : [`${what}: ${fg} on ${bg} is ${c.toFixed(2)}:1, below ${min}:1`];
  });
}

/**
 * OKLab (Björn Ottosson, "A perceptual color space for image processing", 2020): linear sRGB → LMS
 * → cube root → Lab, with the published matrices. Used only to measure how far apart two palette
 * backgrounds look; the anchor test below pins it to the published value for sRGB red.
 */
function oklab(value: string | undefined): [number, number, number] {
  const [r, g, b] = hex(value).map(lin) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Euclidean distance in OKLab (ΔEOK). */
function deltaE(a: string | undefined, b: string | undefined): number {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

const THEMES = ["light", "dark"] as const;
const PILL_CLASSES = [...Array.from({ length: 12 }, (_, i) => `.pc-${i}`), ".pc-other"];
const TAG_TOKENS = ["--tag-merged", "--tag-branch", "--tag-main", "--tag-local"];
/** Each tag's fill. `--tag-local-bg` is `transparent`: local work is a dashed outline, not a fill. */
const TAG_FILL_TOKENS = TAG_TOKENS.map((t) => `${t}-bg`);
const STATE_TOKENS = ["--state-live", "--state-done", "--state-wait"];
const SUNRISE_TOKENS = ["--sunrise-1", "--sunrise-2", "--sunrise-3"];
/** The tokens `app.css` had before Step 0, with their values (pinned unchanged below). */
const BEFORE_STEP0 = {
  light: { "--bg": "#fbfaf8", "--fg": "#1c1a17", "--muted": "#6b6560", "--line": "#e2ddd6", "--panel": "#f3f0eb", "--accent": "#1f2a44", "--on-accent": "#fbfaf8", "--danger": "#a3341f" },
  dark: { "--bg": "#17151a", "--fg": "#ece8e3", "--muted": "#9c948c", "--line": "#322d36", "--panel": "#201d25", "--accent": "#d68b3a", "--on-accent": "#17151a", "--danger": "#e08b78" },
};
/** The motion tokens: the same in both themes, so they have no dark value (the reduced-motion block zeroes them). */
const MOTION_TOKENS = ["--glide-ms", "--open-ms"];
const REDUCE_QUERY = "@media (prefers-reduced-motion: reduce)";

/** What a stylesheet does that the theme model would not see: a custom property declared outside an
 *  exact `:root` (or a palette class's own `--pc-bg` / `--pc-fg`), and a selector that mentions a
 *  palette class without being exactly one. Either would change a colour the contrast rows never read. */
function tokenRuleOffences(rules: CssRule[], palette: readonly string[]): string[] {
  const out: string[] = [];
  const all = rules.flatMap((r) => (r.selector.startsWith("@") ? r.children : [r]));
  for (const r of all) {
    const custom = [...r.decls.keys()].filter((k) => k.startsWith("--"));
    const isPalette = palette.includes(r.selector);
    if (r.selector.includes(".pc-") && !isPalette) out.push(`selector "${r.selector}" names a palette class but is not one`);
    if (r.selector === ":root") continue;
    const allowed = isPalette ? ["--pc-bg", "--pc-fg"] : [];
    for (const k of custom.filter((c) => !allowed.includes(c))) out.push(`"${r.selector}" declares ${k} outside :root`);
  }
  return out;
}

describe("app.css: the contrast model itself (prove-it 3b)", () => {
  test("it returns the published ratios", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#fff", "#000")).toBeCloseTo(21, 5); // order and short form do not matter
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2); // the classic lightest AA grey on white
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2); // …and the one just below it
    expect(contrast("#123456", "#123456")).toBeCloseTo(1, 5);
  });

  test("a deliberately low pair is caught, and a non-hex value is refused", () => {
    expect(shortfalls([["low", "#777777", "#ffffff"]], 4.5)).toHaveLength(1);
    expect(shortfalls([["ok", "#767676", "#ffffff"]], 4.5)).toEqual([]);
    expect(shortfalls([["outline", "#c99a4a", "#ffffff"]], 3)).toHaveLength(1);
    expect(() => contrast("var(--x)", "#ffffff")).toThrow();
    expect(() => contrast(undefined, "#ffffff")).toThrow();
  });

  test("the parser resolves a dark override and keeps a light-only value", () => {
    const rules = parseCss(":root { --a: #111; --b: #222; } /* { */ @media (prefers-color-scheme: dark) { :root { --a: #eee; } }");
    const t = resolve(rules, ":root");
    expect([t.light.get("--a"), t.light.get("--b"), t.dark.get("--a"), t.dark.get("--b")]).toEqual(["#111", "#222", "#eee", "#222"]);
  });

  test("OKLab gives the published value for sRGB red, white and black, and ΔE is a distance", () => {
    // Ottosson's published OKLab for #ff0000: L 0.62796, a 0.22486, b 0.12585.
    const [L, a, b] = oklab("#ff0000");
    expect(L).toBeCloseTo(0.62796, 4);
    expect(a).toBeCloseTo(0.22486, 4);
    expect(b).toBeCloseTo(0.12585, 4);
    expect(oklab("#ffffff")[0]).toBeCloseTo(1, 4);
    expect(oklab("#000000")[0]).toBeCloseTo(0, 6);
    expect(deltaE("#ffffff", "#000000")).toBeCloseTo(1, 4);
    expect(deltaE("#d6ebe7", "#d6ebe7")).toBe(0);
    expect(deltaE("#123456", "#654321")).toBeCloseTo(deltaE("#654321", "#123456"), 12);
  });

  test("a colour declared where the model does not look is caught (planted)", () => {
    const P = [".pc-0", ".pc-3"];
    const planted = (css: string) => tokenRuleOffences(parseCss(css), P);
    expect(planted(":root { --a: #111; } .pc-3 { background: #fff; color: #000; --pc-bg: #fff; --pc-fg: #000; }")).toEqual([]);
    expect(planted(".pc-3, .pc-x { color: #eee; }")).toHaveLength(1);
    expect(planted(".x .pc-3 { color: #eee; }")).toHaveLength(1);
    expect(planted(":root, .x { --state-wait: #000; }")).toHaveLength(1);
    expect(planted(".x { --state-wait: #000; }")).toHaveLength(1);
    expect(planted("@media (prefers-color-scheme: dark) { .x { --tile: #000; } }")).toHaveLength(1);
    expect(planted(".pc-0 { --other: #000; }")).toHaveLength(1);
    expect(planted("@media (prefers-reduced-motion: reduce) { :root { --open-ms: 0ms; } }")).toEqual([]);
  });
});

describe("app.css: the Step 0 tokens and the 12 palette pairs", () => {
  const css = readFileSync(APP_CSS, "utf8");
  const rules = parseCss(css);
  const root = resolve(rules, ":root");
  const darkBlocks = rules.filter((r) => r.selector === DARK_QUERY);
  const darkRoot = darkBlocks.flatMap((m) => m.children).filter((r) => r.selector === ":root");

  test("there is exactly one dark-mode block and one reduced-motion block, and the tokens sit in :root and in them", () => {
    expect(darkBlocks).toHaveLength(1);
    expect(rules.filter((r) => r.selector === REDUCE_QUERY)).toHaveLength(1);
    expect(rules.filter((r) => r.selector.startsWith("@") && r.selector !== DARK_QUERY && r.selector !== REDUCE_QUERY)).toEqual([]);
    expect(darkRoot).toHaveLength(1);
    // The reduced-motion block holds only a :root, and only motion tokens.
    const reduce = rules.find((r) => r.selector === REDUCE_QUERY)!;
    expect(reduce.children.map((c) => c.selector)).toEqual([":root"]);
    expect([...reduce.children[0]!.decls.keys()].sort()).toEqual(["--glide-ms", "--open-ms"]);
  });

  test("no colour is declared where the theme model does not look (custom properties only in :root; .pc-* only as itself)", () => {
    expect(tokenRuleOffences(rules, PILL_CLASSES)).toEqual([]);
  });

  test("the CSS motion tokens are motion.ts's durations, and drop to 0 under reduced motion", () => {
    expect(root.light.get("--glide-ms")).toBe(`${GLIDE_MS}ms`);
    expect(root.light.get("--open-ms")).toBe(`${OPEN_MS}ms`);
    const reduce = rules.find((r) => r.selector === REDUCE_QUERY)!.children[0]!;
    expect([reduce.decls.get("--glide-ms"), reduce.decls.get("--open-ms")]).toEqual(["0ms", "0ms"]);
    // …and the dark block does not touch them.
    expect([darkRoot[0]!.decls.has("--glide-ms"), darkRoot[0]!.decls.has("--open-ms")]).toEqual([false, false]);
  });

  test("the small-caps label class: small caps, tabular numbers, --muted (≥ 4.5:1 on --tile, --bg and --panel, both themes)", () => {
    const caps = rules.filter((r) => r.selector === ".caps");
    expect(caps).toHaveLength(1);
    const d = caps[0]!.decls;
    expect([d.get("font-variant-caps"), d.get("font-variant-numeric"), d.get("color")]).toEqual(["all-small-caps", "tabular-nums", "var(--muted)"]);
    expect(d.has("letter-spacing")).toBe(true);
    const pairs = THEMES.flatMap((th) => (["--tile", "--bg", "--panel"] as const).map((bg) => [`--muted on ${bg} ${th}`, root[th].get("--muted"), root[th].get(bg)] as const));
    expect(shortfalls(pairs, 4.5)).toEqual([]);
  });

  test("--control (inactive dots, chevrons) ≥ 3:1 against --tile, --bg and --panel, both themes", () => {
    const pairs = THEMES.flatMap((th) => (["--tile", "--bg", "--panel"] as const).map((bg) => [`--control on ${bg} ${th}`, root[th].get("--control"), root[th].get(bg)] as const));
    expect(pairs).toHaveLength(6);
    expect(shortfalls(pairs, 3)).toEqual([]);
  });

  test("ActionButton's kinds are readable: --on-accent on --accent, and --danger on --tile and --bg, ≥ 4.5:1, both themes", () => {
    const pairs = THEMES.flatMap((th) => [
      [`--on-accent on --accent ${th}`, root[th].get("--on-accent"), root[th].get("--accent")] as const,
      [`--danger on --tile ${th}`, root[th].get("--danger"), root[th].get("--tile")] as const,
      [`--danger on --bg ${th}`, root[th].get("--danger"), root[th].get("--bg")] as const,
    ]);
    expect(shortfalls(pairs, 4.5)).toEqual([]);
  });

  test("a disabled ActionButton (any kind) is --muted on --tile, ≥ 4.5:1, both themes", () => {
    const pairs = THEMES.map((th) => [`disabled: --muted on --tile ${th}`, root[th].get("--muted"), root[th].get("--tile")] as const);
    expect(shortfalls(pairs, 4.5)).toEqual([]);
  });

  test("non-text rings ≥ 3:1, both themes: Card's highlight (--accent on --panel and --bg) and ActionButton's focus outline (--accent on --tile, --panel and --bg)", () => {
    const pairs = THEMES.flatMap((th) => [
      ...(["--panel", "--bg"] as const).map((bg) => [`Card highlight --accent on ${bg} ${th}`, root[th].get("--accent"), root[th].get(bg)] as const),
      ...(["--tile", "--panel", "--bg"] as const).map((bg) => [`button focus --accent on ${bg} ${th}`, root[th].get("--accent"), root[th].get(bg)] as const),
    ]);
    expect(pairs).toHaveLength(10);
    expect(shortfalls(pairs, 3)).toEqual([]);
    // …and those ARE the colours the components draw the rings in.
    expect(rulesMatching(styleOf(uiSource("Card.svelte")), /\.highlighted\b/).join(" ")).toContain("var(--accent)");
    expect(rulesMatching(styleOf(uiSource("ActionButton.svelte")), /\.action:focus-visible/).join(" ")).toContain("outline: 2px solid var(--accent)");
  });

  test("every new token, and the kept --on-accent, has a light value and its own dark value", () => {
    // The list is :root's own custom properties, minus the pre-Step-0 tokens and the motion tokens, so
    // a token added later without a dark value fails here without anyone updating a list.
    const before = Object.keys(BEFORE_STEP0.light);
    const added = [...root.light.keys()].filter((k) => k.startsWith("--") && !before.includes(k) && !MOTION_TOKENS.includes(k));
    // A floor and the known families, so a parser that read nothing would not pass over an empty list.
    expect(added.length).toBeGreaterThanOrEqual(18);
    for (const t of ["--tile", "--tile-border", "--tile-shadow", "--control", ...STATE_TOKENS, ...TAG_TOKENS, ...TAG_FILL_TOKENS, ...SUNRISE_TOKENS]) {
      expect({ t, listed: added.includes(t) }).toEqual({ t, listed: true });
    }
    for (const t of [...added, "--on-accent"]) {
      expect({ t, light: root.light.has(t) }).toEqual({ t, light: true });
      expect({ t, dark: darkRoot[0]!.decls.has(t) }).toEqual({ t, dark: true });
    }
  });

  test("the twelve slot classes and the neutral one each declare only --pc-bg and --pc-fg (they paint nothing), with a dark override", () => {
    // A class that only sets custom properties can sit on any element (A's `▸` markers on a list)
    // without tinting it; Pill paints itself from them.
    const darkChildren = darkBlocks[0]!.children;
    for (const cls of PILL_CLASSES) {
      const top = rules.filter((r) => r.selector === cls);
      const dark = darkChildren.filter((r) => r.selector === cls);
      expect({ cls, top: top.length, dark: dark.length }).toEqual({ cls, top: 1, dark: 1 });
      for (const r of [top[0]!, dark[0]!]) {
        expect({ cls, keys: [...r.decls.keys()].sort() }).toEqual({ cls, keys: ["--pc-bg", "--pc-fg"] });
      }
      // Cascade order: the light rule must come before the dark block, or the dark override would lose.
      expect(top[0]!.at).toBeLessThan(darkBlocks[0]!.at);
    }
    // No slot beyond the palette.
    expect(rules.filter((r) => /^\.pc-\d+$/.test(r.selector)).length).toBe(PALETTE_SLOTS);
  });

  test("text contrast ≥ 4.5:1 for all 12 pill pairs and the neutral pill, both themes", () => {
    const pairs = PILL_CLASSES.flatMap((cls) => {
      const p = resolve(rules, cls);
      return THEMES.map((th) => [`${cls} ${th}`, p[th].get("--pc-fg"), p[th].get("--pc-bg")] as const);
    });
    expect(pairs).toHaveLength(26);
    // …and those custom properties ARE what the pill paints with.
    const pill = declarations(rulesMatching(styleOf(uiSource("Pill.svelte")), /^\s*\.pill\s*$/));
    expect({ background: pill.get("background"), color: pill.get("color") }).toEqual({ background: "var(--pc-bg)", color: "var(--pc-fg)" });
    expect(shortfalls(pairs, 4.5)).toEqual([]);
  });

  test("non-text contrast ≥ 3:1 for the four tag colours (also on --panel, their Card) and the three state outlines, against --tile and --bg, both themes", () => {
    const pairs = [...TAG_TOKENS, ...STATE_TOKENS].flatMap((t) =>
      THEMES.flatMap((th) =>
        (TAG_TOKENS.includes(t) ? (["--tile", "--bg", "--panel"] as const) : (["--tile", "--bg"] as const)).map(
          (bg) => [`${t} on ${bg} ${th}`, root[th].get(t), root[th].get(bg)] as const,
        ),
      ),
    );
    expect(pairs).toHaveLength(4 * 2 * 3 + 3 * 2 * 2);
    expect(shortfalls(pairs, 3)).toEqual([]);
  });

  test("text contrast ≥ 4.5:1 for the state colours used as label text (the meeting tile's orange 5-minute label is --state-live), against --tile and --bg, both themes", () => {
    // A spec: the meeting tile's label "turns orange when the meeting is 5 minutes or less away"; the
    // approved mockup (launchpad-sharp.html, `.t.soon .k`) colours it with the live (orange) state.
    // All three state colours are held to the text bar, so whichever one a label uses is readable.
    const pairs = STATE_TOKENS.flatMap((t) =>
      THEMES.flatMap((th) =>
        (["--tile", "--bg"] as const).map((bg) => [`${t} text on ${bg} ${th}`, root[th].get(t), root[th].get(bg)] as const),
      ),
    );
    expect(pairs).toHaveLength(12);
    expect(shortfalls(pairs, 4.5)).toEqual([]);
  });

  test("there is exactly one top-level :root, and it comes before the dark block", () => {
    // A second top-level :root after the media block would beat the dark values in a real cascade,
    // while this model (which overlays the dark block last) would still resolve the dark ones.
    const tops = rules.filter((r) => r.selector === ":root");
    expect(tops).toHaveLength(1);
    expect(tops[0]!.at).toBeLessThan(darkBlocks[0]!.at);
  });

  test("text contrast ≥ 4.5:1 for --fg and --muted on each sunrise stop, both themes", () => {
    // The Good morning screen draws its text (the date in --muted) on the sunrise gradient.
    const pairs = SUNRISE_TOKENS.flatMap((s) =>
      THEMES.flatMap((th) => (["--fg", "--muted"] as const).map((fg) => [`${fg} on ${s} ${th}`, root[th].get(fg), root[th].get(s)] as const)),
    );
    expect(pairs).toHaveLength(12);
    expect(shortfalls(pairs, 4.5)).toEqual([]);
  });

  test("…and BETWEEN the stops: --fg and --muted ≥ 4.55:1 everywhere along the gradient, both themes", () => {
    // The mockups draw it as `linear-gradient(135deg, --hero1, --hero2 55%, --hero3)`: with hex stops
    // the browser blends each ADJACENT pair in sRGB, and the blend can dip below both ends. So each
    // pair is sampled at 1/64 steps, each channel rounded to 8 bits as the screen does.
    const toHex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    const low: string[] = [];
    let samples = 0;
    for (const th of THEMES) {
      for (let s = 0; s + 1 < SUNRISE_TOKENS.length; s++) {
        const [a, b] = [hex(root[th].get(SUNRISE_TOKENS[s]!)), hex(root[th].get(SUNRISE_TOKENS[s + 1]!))];
        for (let i = 0; i <= 64; i++) {
          const mix = toHex(a.map((v, k) => Math.round(v + (b[k]! - v) * (i / 64))));
          for (const fg of ["--fg", "--muted"] as const) {
            samples++;
            const c = contrast(root[th].get(fg), mix);
            if (c < 4.55) low.push(`${fg} on ${SUNRISE_TOKENS[s]}→${SUNRISE_TOKENS[s + 1]} at ${i}/64 ${th}: ${c.toFixed(3)}`);
          }
        }
      }
    }
    expect(samples).toBe(2 * 2 * 65 * 2);
    expect(low).toEqual([]);
  });

  test("Good morning option 2 (user-directed 2026-10-22): what sits ON the sunrise card reaches its contrast against every stop and every blend, both themes", () => {
    // Since option 2 the gradient covers the whole slide, so controls sit on it. `--control` is not 3:1 there
    // (2.97:1, the token's own note), so the card's controls get their own surface. PINNED first, so what is
    // measured below is what the components draw:
    //   Run now and the i: a --tile fill, --fg text, a 1px --muted border (the control's boundary on the card);
    //   Start: the --accent fill (its boundary) with --on-accent text; all three are `.ctl`, whose focus ring is
    //   --accent (app.css); text drawn straight on the card is --fg, --muted or --danger.
    const rc = readFileSync(new URL("../src/lib/RunControls.svelte", import.meta.url), "utf8");
    const gm = readFileSync(new URL("../src/lib/deck/GoodMorning.svelte", import.meta.url), "utf8");
    const body = (src: string, selector: string): string => {
      const style = src.slice(src.indexOf("<style>"));
      const m = new RegExp(`\\n\\s*${selector.replace(/\./g, "\\.")} \\{([^}]*)\\}`).exec(style);
      return (m?.[1] ?? "").replace(/\s+/g, " ");
    };
    for (const [what, decls] of [["RunControls .run", body(rc, ".run")], ["RunControls .info", body(rc, ".info")]] as const) {
      expect({ what, fill: decls.includes("background: var(--tile);"), text: decls.includes("color: var(--fg);"), edge: decls.includes("border: 1px solid var(--muted);") }).toEqual({
        what,
        fill: true,
        text: true,
        edge: true,
      });
    }
    const start = body(gm, ".start");
    expect([start.includes("background: var(--accent);"), start.includes("color: var(--on-accent);")]).toEqual([true, true]);
    expect(rc).toContain('<button type="button" class="ctl run"');
    expect(rc).toMatch(/<button\s+type="button"\s+class="ctl info"/);
    expect(gm).toContain('<button type="button" class="ctl start"');
    expect(css).toMatch(/\.ctl\.ctl:focus-visible \{\s*outline: 2px solid var\(--accent\);/);
    expect(body(gm, ".sunrise")).toContain("background: linear-gradient(140deg, var(--sunrise-1), var(--sunrise-2) 55%, var(--sunrise-3));");
    // The OPEN i (checkpoint M1): a --fg edge and inset ring on the --panel fill, its glyph --fg — not the focus ring.
    const open = (/\n\s*\.info\[aria-expanded="true"\] \{([^}]*)\}/.exec(rc.slice(rc.indexOf("<style>")))?.[1] ?? "").replace(/\s+/g, " ");
    expect([open.includes("background: var(--panel);"), open.includes("border-color: var(--fg);"), open.includes("box-shadow: inset 0 0 0 1px var(--fg);"), open.includes("outline")]).toEqual([
      true,
      true,
      true,
      false,
    ]);

    // The measurement: each adjacent pair of stops, sampled at 1/64 steps with 8-bit channels (the test above's
    // method; the 0/64 and 64/64 samples are the stops themselves).
    const toHex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    const low: string[] = [];
    let samples = 0;
    for (const th of THEMES) {
      for (let s = 0; s + 1 < SUNRISE_TOKENS.length; s++) {
        const [a, b] = [hex(root[th].get(SUNRISE_TOKENS[s]!)), hex(root[th].get(SUNRISE_TOKENS[s + 1]!))];
        for (let i = 0; i <= 64; i++) {
          const mix = toHex(a.map((v, k) => Math.round(v + (b[k]! - v) * (i / 64))));
          samples++;
          const at = `${SUNRISE_TOKENS[s]}→${SUNRISE_TOKENS[s + 1]} at ${i}/64 ${th}`;
          // Boundaries and the focus ring (non-text, 3:1): the controls' --muted edge, Start's --accent fill, the ring,
          // and the open i's --fg edge.
          for (const edge of ["--muted", "--accent", "--fg"]) {
            const c = contrast(root[th].get(edge), mix);
            if (c < 3) low.push(`${edge} (boundary) on ${at}: ${c.toFixed(3)}`);
          }
          // Text drawn straight on the card (4.5:1): the greeting, date, work line, COMMITS, banners' bad tone.
          for (const fg of ["--fg", "--muted", "--danger"]) {
            const c = contrast(root[th].get(fg), mix);
            if (c < 4.5) low.push(`${fg} (text) on ${at}: ${c.toFixed(3)}`);
          }
          // The commit bars (non-text, 3:1) along the blends too, not only at the stops (the --pc-fg test).
          for (const cls of PILL_CLASSES) {
            const c = contrast(resolve(rules, cls)[th].get("--pc-fg"), mix);
            if (c < 3) low.push(`${cls} --pc-fg on ${at}: ${c.toFixed(3)}`);
          }
        }
      }
    }
    expect(samples).toBe(2 * 2 * 65);
    expect(low).toEqual([]);
    // On the controls' own surfaces: their text on --tile, and Start's text on its fill (4.5:1).
    const own = THEMES.flatMap((th) => [
      [`--fg on --tile ${th}`, root[th].get("--fg"), root[th].get("--tile")] as const,
      [`--danger on --tile ${th}`, root[th].get("--danger"), root[th].get("--tile")] as const,
      [`--on-accent on --accent ${th}`, root[th].get("--on-accent"), root[th].get("--accent")] as const,
      [`--fg on --panel (the open i) ${th}`, root[th].get("--fg"), root[th].get("--panel")] as const,
    ]);
    expect(shortfalls(own, 4.5)).toEqual([]);
  });

  test("tag words are text: each tag colour ≥ 4.5:1 on its own fill, on --tile and on --bg, both themes", () => {
    // The approved tag scheme (tag-colors.html, scheme 1) draws the tag's WORD in the tag colour on a
    // tinted fill. Local work has no fill (a dashed outline, hub spec "Status tags"): its fill token
    // is `transparent`, so its word sits on whatever holds it — a Card (--panel), a tile or the page.
    const pairs = TAG_TOKENS.flatMap((t, i) =>
      THEMES.flatMap((th) => {
        const fill = root[th].get(TAG_FILL_TOKENS[i]!);
        const under = fill === "transparent" ? ["--panel", "--tile", "--bg"] : [TAG_FILL_TOKENS[i]!, "--tile", "--bg"];
        return under.map((bg) => [`${t} on ${bg} ${th}`, root[th].get(t), root[th].get(bg)] as const);
      }),
    );
    expect(pairs).toHaveLength(24);
    expect(shortfalls(pairs, 4.5)).toEqual([]);
    for (const th of THEMES) {
      expect(TAG_FILL_TOKENS.map((t) => root[th].get(t) === "transparent")).toEqual([false, false, false, true]);
    }
  });

  test("slots 4-11 are told apart: every background pair involving one of them is ΔEOK ≥ 0.035, both themes", () => {
    // Slots 0-3 and the neutral pill are the approved mockups' colours (launchpad-sharp.html --p1..p4,
    // --pg) and are not re-spaced here; every pair that includes a slot 4-11 must be at least 0.035
    // apart (the palette was chosen at ≥ 0.036; the floor sits just under it, so a re-tune cannot drift).
    const bgs = PILL_CLASSES.map((cls) => ({ cls, p: resolve(rules, cls) }));
    const close: string[] = [];
    let pairsChecked = 0;
    for (const th of THEMES) {
      for (let i = 0; i < bgs.length; i++) {
        for (let j = i + 1; j < bgs.length; j++) {
          const involves = [bgs[i]!.cls, bgs[j]!.cls].some((c) => /^\.pc-([4-9]|1[01])$/.test(c));
          if (!involves) continue;
          pairsChecked++;
          const d = deltaE(bgs[i]!.p[th].get("--pc-bg"), bgs[j]!.p[th].get("--pc-bg"));
          if (d < 0.035) close.push(`${bgs[i]!.cls}↔${bgs[j]!.cls} ${th}: ${d.toFixed(3)}`);
        }
      }
    }
    // 13 backgrounds, of which the 5 fixed ones form 10 pairs: (78 - 10) pairs per theme.
    expect(pairsChecked).toBe(2 * (78 - 10));
    expect(close).toEqual([]);
  });

  test("no two palette backgrounds are alike: EVERY pair, the mockups' slots 0-3 and the neutral one included, is ΔEOK ≥ 0.025, both themes", () => {
    // A lower floor than slots 4-11's, because the mockups' own closest pair (pc-0 ↔ pc-other) is
    // about 0.027; it still catches two classes given one colour.
    const bgs = PILL_CLASSES.map((cls) => ({ cls, p: resolve(rules, cls) }));
    const close: string[] = [];
    let pairsChecked = 0;
    for (const th of THEMES) {
      for (let i = 0; i < bgs.length; i++) {
        for (let j = i + 1; j < bgs.length; j++) {
          pairsChecked++;
          const d = deltaE(bgs[i]!.p[th].get("--pc-bg"), bgs[j]!.p[th].get("--pc-bg"));
          if (d < 0.025) close.push(`${bgs[i]!.cls}↔${bgs[j]!.cls} ${th}: ${d.toFixed(4)}`);
        }
      }
    }
    expect(pairsChecked).toBe(2 * 78);
    expect(close).toEqual([]);
  });

  test("the existing tokens are unchanged in both themes", () => {
    for (const th of THEMES) {
      expect(Object.fromEntries(Object.keys(BEFORE_STEP0[th]).map((k) => [k, root[th].get(k)]))).toEqual(BEFORE_STEP0[th]);
    }
  });

  test("A's bars and markers: every --pc-fg ≥ 3:1 against --bg, --tile, --panel and the three sunrise stops, both themes", () => {
    // `--pc-fg` is the bar and marker colour (non-text, 3:1); `--pc-bg` is only the pill's tint.
    const pairs = PILL_CLASSES.flatMap((cls) => {
      const p = resolve(rules, cls);
      return THEMES.flatMap((th) =>
        (["--bg", "--tile", "--panel", ...SUNRISE_TOKENS] as const).map((bg) => [`${cls} --pc-fg on ${bg} ${th}`, p[th].get("--pc-fg"), root[th].get(bg)] as const),
      );
    });
    expect(pairs).toHaveLength(13 * 2 * 6);
    expect(shortfalls(pairs, 3)).toEqual([]);
  });

  test("a visually-hidden utility class, .sr-only, with the standard rules", () => {
    const sr = rules.filter((r) => r.selector === ".sr-only");
    expect(sr).toHaveLength(1);
    expect(Object.fromEntries(sr[0]!.decls)).toEqual({
      position: "absolute",
      width: "1px",
      height: "1px",
      margin: "-1px",
      padding: "0",
      overflow: "hidden",
      "clip-path": "inset(50%)",
      "white-space": "nowrap",
      border: "0",
    });
  });
});

/* ── S0-M2-T3: the base components (lib/ui) ────────────────────────────────────────────────────────
 *
 * Method: server render with `svelte/server` (the shipped compiler, through the loader), plus source
 * pins for what a string render cannot show (the CSS that ellipsizes, the focus rule that lifts it).
 */

const UI_SRC = new URL("../src/lib/ui/", import.meta.url).pathname;
const uiSource = (name: string) => readFileSync(`${UI_SRC}${name}`, "utf8");

function html(component: unknown, props: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(component as any, { props })
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A child snippet that renders one element holding `text` (escaped by the test, as Svelte would). */
const child = (text: string) => createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

/** The class tokens of the first element whose class list contains `marker`. */
function classesOf(markup: string, marker: string): string[] {
  for (const m of markup.matchAll(/class="([^"]*)"/g)) {
    const list = m[1]!.split(/\s+/);
    if (list.includes(marker)) return list;
  }
  return [];
}

/** The text of the element (no markup inside), between its tags. */
const textOf = (markup: string) => markup.replace(/<[^>]*>/g, "").trim();

/** The body of the `<style>` block, comments removed. */
const styleOf = (source: string) => (/<style>([\s\S]*?)<\/style>/.exec(source)?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of every rule in a style body whose selector matches `selector`. */
function rulesMatching(style: string, selector: RegExp): string[] {
  return [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => selector.test(m[1]!)).map((m) => m[2]!.replace(/\s+/g, " ").trim());
}

/** A selector's specificity [ids, classes + attributes + pseudo-classes, types], for the simple
 *  selectors these stylesheets use (no `:is()` / `:not()` arguments, no pseudo-elements). */
function specificity(selector: string): [number, number, number] {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):[\w-]+/g) ?? []).length;
  const types = (selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+/g, " ").match(/[a-z][\w-]*/gi) ?? []).length;
  return [ids, classes, types];
}

/** Whether specificity `a` is strictly greater than `b`. */
const outranks = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
};

/** Rule bodies (in source order) as property → value, the LAST declaration of a property winning. */
function declarations(bodies: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of bodies.join(";").split(";")) {
    const k = d.indexOf(":");
    if (k >= 0) out.set(d.slice(0, k).trim(), d.slice(k + 1).trim());
  }
  return out;
}

const LONG = "a-very-long-project-label-that-goes-on-and-on-".repeat(3).slice(0, 100);

describe("lib/ui: Pill", () => {
  test("draws its label as text, with the full text in title, as the palette slot's class", () => {
    const out = html(Pill, { palette: 3, label: "accountant_ai" });
    // The label's text, with a break opportunity after its "_" (wave 2 polish §6).
    expect(out).toMatch(/^<span [^>]*>accountant_<wbr\s*\/?>ai<\/span>$/);
    expect(out).toContain('title="accountant_ai"');
    expect(classesOf(out, "pill")).toContain("pc-3");
  });

  test("every palette slot 0-11 draws pc-{slot}; null draws the neutral pc-other", () => {
    for (let s = 0; s < 12; s++) expect(classesOf(html(Pill, { palette: s, label: "x" }), "pill").filter((c) => c.startsWith("pc-"))).toEqual([`pc-${s}`]);
    expect(classesOf(html(Pill, { palette: null, label: "Other" }), "pill").filter((c) => c.startsWith("pc-"))).toEqual(["pc-other"]);
  });

  test("a palette slot outside 0-11 is clamped: never an unknown class", () => {
    const cases: [number, string][] = [[-1, "pc-0"], [-50, "pc-0"], [12, "pc-11"], [99, "pc-11"], [2.7, "pc-2"], [Infinity, "pc-11"], [-Infinity, "pc-0"], [NaN, "pc-other"]];
    for (const [palette, want] of cases) {
      expect({ palette, cls: classesOf(html(Pill, { palette, label: "x" }), "pill").filter((c) => c.startsWith("pc-")) }).toEqual({ palette, cls: [want] });
    }
  });

  test("its prop is not Svelte's reserved `slot`: a Pill as a child of Card and of ActionButton compiles, and `slot={…}` would not", () => {
    // Through TEMPLATE syntax, compiled in memory (no file is written): `slot={…}` on a component's
    // child is a compile error, and a static `slot="3"` would silently move the pill into a legacy slot.
    expect(uiSource("Pill.svelte")).not.toMatch(/\bslot\s*[:?]/);
    const wrapper = (attr: string) => `<script lang="ts">
  import Card from "./Card.svelte";
  import ActionButton from "./ActionButton.svelte";
  import Pill from "./Pill.svelte";
  let s = $state(4);
</script>
<Card><Pill ${attr} label="in a card" /></Card>
<ActionButton onclick={() => {}}><Pill ${attr} label="in a button" /></ActionButton>
`;
    const out = compile(wrapper("palette={s}"), { generate: "server", runes: true, filename: `${UI_SRC}Wrapper.svelte` });
    expect(out.warnings).toEqual([]);
    // Both Pills receive `palette` as a prop.
    expect(out.js.code.match(/\bpalette: s\b/g) ?? []).toHaveLength(2);
    // The same template with the reserved name does not compile: this is why the prop was renamed.
    let code = "";
    try {
      compile(wrapper("slot={s}"), { generate: "server", runes: true, filename: `${UI_SRC}Wrapper.svelte` });
    } catch (e) {
      code = String((e as { code?: unknown }).code);
    }
    expect(code).toBe("slot_attribute_invalid");
  });

  test("a 100-character label is all there, as text and in title", () => {
    expect(LONG).toHaveLength(100);
    const out = html(Pill, { palette: 0, label: LONG });
    expect(textOf(out)).toBe(LONG);
    expect(out).toContain(`title="${LONG}"`);
  });

  // Wave 2 polish §6 (plan PA-M3-T3): a label breaks after "_" first ("daily_briefing_" / "application", never
  // "daily_briefing_a" / "pplication"). Every pill draws the breaks: a non-wrap pill wraps too when its button or
  // summary has keyboard focus.
  test("every pill, wrap or not, draws a <wbr> after each \"_\", and the label's text and title are unchanged", () => {
    const label = "daily_briefing_application";
    for (const wrap of [true, false, undefined]) {
      const raw = render(Pill as never, { props: { palette: 4, label, wrap } }).body;
      const out = html(Pill, { palette: 4, label, wrap });
      expect({ wrap, out }).toEqual({ wrap, out: expect.stringMatching(/>daily_<wbr\s*\/?>briefing_<wbr\s*\/?>application<\/span>$/) });
      expect({ wrap, breaks: out.match(/<wbr\b/g)?.length }).toEqual({ wrap, breaks: 2 });
      expect({ wrap, title: out.includes(`title="${label}"`) }).toEqual({ wrap, title: true });
      // Its text — comments (Svelte's each/if markers) and tags stripped — is the label, no character added.
      const text = raw.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "");
      expect({ wrap, text }).toEqual({ wrap, text: label });
    }
  });

  test("the parts keep every character: no \"_\" draws no <wbr>; leading, trailing and doubled \"_\" are kept", () => {
    const textOfRaw = (label: string) =>
      render(Pill as never, { props: { palette: 0, label } }).body.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "");
    for (const [label, breaks] of [["Personal Code", 0], ["x", 0], ["", 0], ["ai_", 0], ["_ai", 1], ["a__b", 2], ["_", 0]] as const) {
      const out = html(Pill, { palette: 0, label });
      expect({ label, breaks: out.match(/<wbr\b/g)?.length ?? 0 }).toEqual({ label, breaks });
      expect({ label, text: textOfRaw(label) }).toEqual({ label, text: label });
    }
    // A break is AFTER the "_", never before it, and never after the last character.
    expect(html(Pill, { palette: 0, label: "a__b" })).toMatch(/>a_<wbr\s*\/?>_<wbr\s*\/?>b<\/span>$/);
    expect(html(Pill, { palette: 0, label: "ai_" })).toMatch(/>ai_<\/span>$/);
  });

  test("(source pin) the label is drawn as its \"_\"-ended parts, each a text node; the breaks are markup, not a string", () => {
    const source = uiSource("Pill.svelte");
    expect(source).toContain(
      `<span class="pill {cls}" class:wrap title={label}>{#each parts as p, i (i)}{p}{#if i < parts.length - 1}<wbr />{/if}{/each}</span>`,
    );
    expect(source).not.toMatch(/\{@html/);
    // The five `Pill … wrap` callers are unchanged (the screenshot pass checks each).
    const callers = [
      ["lib/deck/WhatYouDid.svelte", `<Pill palette={card.slot} label={card.label} wrap />`],
      ["lib/deck/LeftOff.svelte", `<Pill palette={card.slot} label={card.label} wrap />`],
      ["lib/deck/Suggested.svelte", `<Pill palette={p.pill.slot} label={p.pill.label} wrap />`],
      ["lib/deck/Suggested.svelte", `<Pill palette={s.slot} label={s.label} wrap />`],
      ["lib/deck/GoodMorning.svelte", `<Pill palette={bar.slot} label={bar.label} wrap />`],
    ] as const;
    const SRC_ROOT = new URL("../src/", import.meta.url).pathname;
    for (const [file, call] of callers) expect({ file, has: readFileSync(`${SRC_ROOT}${file}`, "utf8").includes(call) }).toEqual({ file, has: true });
    const all = new Bun.Glob("**/*.svelte").scanSync(SRC_ROOT);
    let wraps = 0;
    for (const f of all) wraps += (readFileSync(`${SRC_ROOT}${f}`, "utf8").match(/<Pill\b[^>]*\swrap\b[^>]*\/>/g) ?? []).length;
    expect(wraps).toBe(5);
  });

  test("(source pin) .pill.wrap and the focused holder's rule keep overflow-wrap: anywhere, never break-word", () => {
    const style = styleOf(uiSource("Pill.svelte"));
    const wrap = declarations(rulesMatching(style, /^\s*\.pill\.wrap\s*$/));
    const lift = declarations(rulesMatching(style, /:focus-visible/));
    expect({ wrap: wrap.get("overflow-wrap"), lift: lift.get("overflow-wrap"), maxWidth: wrap.get("max-width") })
      .toEqual({ wrap: "anywhere", lift: "anywhere", maxWidth: "none" });
    expect(style).not.toMatch(/break-word/);
    expect(style).not.toMatch(/word-break/);
  });

  test("engine text stays text", () => {
    const out = html(Pill, { palette: 1, label: '<img src=x onerror="alert(1)">' });
    expect(out).not.toContain("<img");
    // The text node is escaped by Svelte (`<` → `&lt;`), and so is the title attribute (`"` → `&quot;`).
    expect(out.endsWith('>&lt;img src=x onerror="alert(1)"></span>')).toBe(true);
    expect(out).toContain('title="&lt;img src=x onerror=&quot;alert(1)&quot;>"');
  });
});

describe("lib/ui: StatusTag", () => {
  // `local` says "not pushed": true on macOS, Windows and Linux alike (B1's "never pushed" / "N not pushed").
  const WORDS: Record<string, string> = { merged: "merged", branch: "branch", main: "main", local: "not pushed" };

  test("draws its word for every kind (colour is never the only signal), in its kind's class", () => {
    for (const [kind, word] of Object.entries(WORDS)) {
      const out = html(StatusTag, { kind });
      expect({ kind, text: textOf(out) }).toEqual({ kind, text: word });
      expect(out).toContain(`title="${word}"`);
      expect(classesOf(out, "tag")).toContain(kind);
    }
  });

  test("draws its label when given, instead of the word", () => {
    const out = html(StatusTag, { kind: "branch", label: "Detached HEAD at e7b732b" });
    expect(textOf(out)).toBe("Detached HEAD at e7b732b");
    expect(out).toContain('title="Detached HEAD at e7b732b"');
    expect(classesOf(out, "tag")).toContain("branch");
  });

  test("a blank label falls back to the kind's word, so a tag is never empty (colour never the only signal)", () => {
    for (const label of ["", "   ", "\t\n"]) {
      for (const [kind, word] of Object.entries(WORDS)) {
        const out = html(StatusTag, { kind, label });
        expect({ kind, label, text: textOf(out) }).toEqual({ kind, label, text: word });
        expect(out).toContain(`title="${word}"`);
      }
    }
  });

  test("a 100-character label is all there, as text and in title", () => {
    const out = html(StatusTag, { kind: "merged", label: LONG });
    expect(textOf(out)).toBe(LONG);
    expect(out).toContain(`title="${LONG}"`);
  });

  test("(source pin) each kind is coloured by its S0-M1 tokens; local is a dashed outline on a transparent fill", () => {
    const style = styleOf(uiSource("StatusTag.svelte"));
    for (const kind of ["merged", "branch", "main", "local"]) {
      const decls = rulesMatching(style, new RegExp(`\\.${kind}\\b`)).join(" ");
      expect({ kind, color: decls.includes(`color: var(--tag-${kind})`) }).toEqual({ kind, color: true });
      expect({ kind, fill: decls.includes(`background: var(--tag-${kind}-bg)`) }).toEqual({ kind, fill: true });
    }
    expect(rulesMatching(style, /\.local\b/).join(" ")).toContain("border: 1px dashed var(--tag-local)");
  });

  test("(source pin) the Kind type lives in a .ts module a pure .ts file can import, and StatusTag re-exports it; the doc says a label must keep the kind clear", () => {
    // A `.ts` importer of a type from a `.svelte` file fails `tsc` (TS2614: the ambient `*.svelte`
    // module has only a default export), so A's `deck.ts` imports `Kind` from `tag-kind.ts`.
    expect(uiSource("tag-kind.ts")).toMatch(/export type Kind = "merged" \| "branch" \| "main" \| "local";/);
    expect(TAG_WORDS).toEqual(WORDS);
    const src = uiSource("StatusTag.svelte");
    const moduleScript = /<script lang="ts" module>([\s\S]*?)<\/script>/.exec(src)?.[1] ?? "";
    expect(moduleScript).toMatch(/import type \{ Kind \} from "\.\/tag-kind";/);
    expect(moduleScript).toMatch(/export type \{ Kind \};/);
    expect(src).toMatch(/a caller that passes `label` must/);
  });
});

describe("lib/ui: Pill's shape (user-directed option F: round on one line, soft corners when wrapped)", () => {
  const style = styleOf(uiSource("Pill.svelte"));
  const base = declarations(rulesMatching(style, /^\s*\.pill\s*$/));
  const rem = (v: string | undefined) => {
    const m = /^(\d*\.?\d+)rem$/.exec(v ?? "");
    if (!m) throw new Error(`not a rem length: ${JSON.stringify(v)}`);
    return Number(m[1]);
  };

  test("the base radius is at least half a one-line pill's height, from the rule's own font-size, line-height and padding (so one line stays fully round)", () => {
    const [top, , bottom = top] = (base.get("padding") ?? "").split(/\s+/);
    const lineHeight = Number(base.get("line-height"));
    expect(Number.isFinite(lineHeight) && lineHeight > 0).toBe(true);
    const oneLine = rem(base.get("font-size")) * lineHeight + rem(top) + rem(bottom); // 0.78 × 1.4 + 0.1 + 0.1 = 1.292rem
    const radius = rem(base.get("border-radius"));
    expect({ radius, half: oneLine / 2, round: radius >= oneLine / 2 }).toEqual({ radius, half: oneLine / 2, round: true });
    // …and not a "pill at any height" radius: a wrapped pill gets soft corners, not a stadium.
    expect(radius).toBeLessThan(oneLine);
  });

  test("a wrapped pill gets 0.2rem more room top and bottom, and keeps the side padding", () => {
    const wrap = declarations(rulesMatching(style, /^\s*\.pill\.wrap\s*$/));
    expect({ top: wrap.get("padding-top"), bottom: wrap.get("padding-bottom") }).toEqual({ top: "0.2rem", bottom: "0.2rem" });
    expect([...wrap.keys()].filter((k) => k === "padding" || k === "padding-left" || k === "padding-right")).toEqual([]);
  });
});

describe("lib/ui: the ellipsis and its focus rule (Pill and StatusTag)", () => {
  for (const [file, cls] of [["Pill.svelte", "pill"], ["StatusTag.svelte", "tag"]] as const) {
    test(`${file} with wrap: the full label is always drawn, with no ellipsis (for a long label outside a control)`, () => {
      const C = file === "Pill.svelte" ? Pill : StatusTag;
      const base = file === "Pill.svelte" ? { palette: 0 } : { kind: "branch" };
      const wrapped = html(C, { ...base, label: LONG, wrap: true });
      expect(classesOf(wrapped, cls)).toContain("wrap");
      expect(textOf(wrapped)).toBe(LONG);
      expect(classesOf(html(C, { ...base, label: LONG }), cls)).not.toContain("wrap");
      expect(classesOf(html(C, { ...base, label: LONG, wrap: false }), cls)).not.toContain("wrap");
      // (source pin) `.{cls}.wrap` outranks `.{cls}` (two classes to one), and its declarations win.
      const style = styleOf(uiSource(file));
      const selectors = [...style.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1]!.trim()).filter((s) => /\.wrap\b/.test(s));
      expect({ file, selectors }).toEqual({ file, selectors: [`.${cls}.wrap`] });
      const won = declarations([...rulesMatching(style, new RegExp(`^\\s*\\.${cls}\\s*$`)), ...rulesMatching(style, new RegExp(`^\\s*\\.${cls}\\.wrap\\s*$`))]);
      const want = { "max-width": "none", overflow: "visible", "text-overflow": "clip", "white-space": "normal", "overflow-wrap": "anywhere" };
      expect({ file, won: Object.fromEntries(Object.keys(want).map((k) => [k, won.get(k)])) }).toEqual({ file, won: want });
    });

    test(`(source pin) ${file} ellipsizes by CSS only, and a focused holder lifts it`, () => {
      const source = uiSource(file);
      const style = styleOf(source);
      // Declarations are read as the cascade reads them: the last one of a property wins.
      const base = declarations(rulesMatching(style, new RegExp(`^\\s*\\.${cls}\\s*$`)));
      const want = { "max-width": "100%", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" };
      expect({ file, base: Object.fromEntries(Object.keys(want).map((k) => [k, base.get(k)])) }).toEqual({ file, base: want });
      // The lift: ONE rule, keyed on keyboard focus of the HOLDER (a button or a summary that contains
      // the label, a descendant combinator), never any focused ancestor, a sibling, or a tabindex.
      const selectors = [...style.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1]!.trim()).filter((s) => s.includes(":focus-visible"));
      expect({ file, selectors }).toEqual({ file, selectors: [`:global(:is(button, summary):focus-visible) .${cls}`] });
      const lift = declarations(rulesMatching(style, /:focus-visible/));
      expect({ file, ws: lift.get("white-space"), overflow: lift.get("overflow") }).toEqual({ file, ws: "normal", overflow: "visible" });
      // No longhand put back what the shorthand lifted.
      expect({ file, longhands: [...lift.keys()].filter((k) => /^overflow-[xy]$|^(overflow-)?clip/.test(k)) }).toEqual({ file, longhands: [] });
      expect(source).not.toMatch(/tabindex/);
      expect(source).toMatch(/title=\{/);
    });
  }
});

describe("lib/ui: Card, Tile and ActionButton", () => {
  test("Card is an article on the tinted panel surface, holding its children", () => {
    const out = html(Card, { children: child("body") });
    expect(out).toMatch(/^<article class="card[^"]*"><span>body<\/span><\/article>$/);
    expect(html(Card, { label: "accountant_ai", children: child("b") })).toContain('aria-label="accountant_ai"');
    expect(rulesMatching(styleOf(uiSource("Card.svelte")), /\.card\b/).join(" ")).toContain("background: var(--panel)");
  });

  test("Card takes an id (a jump target) and a highlight ring, whose transition stops under reduced motion", () => {
    expect(html(Card, { id: "card-mono", children: child("b") })).toMatch(/^<article [^>]*id="card-mono"/);
    expect(html(Card, { children: child("b") })).not.toContain("id=");
    expect(classesOf(html(Card, { highlighted: true, children: child("b") }), "card")).toContain("highlighted");
    expect(classesOf(html(Card, { highlighted: false, children: child("b") }), "card")).not.toContain("highlighted");
    const style = styleOf(uiSource("Card.svelte"));
    expect(rulesMatching(style, /\.highlighted\b/).join(" ")).toContain("box-shadow: 0 0 0 2px var(--accent)");
    expect(rulesMatching(style, /^\s*\.card\s*$/).join(" ")).toContain("transition: box-shadow var(--open-ms)");
    // The reduced-motion block turns the transition off (as well as the token going to 0).
    const reduce = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\}\s*\}/.exec(style)?.[1] ?? "";
    expect(reduce.replace(/\s+/g, " ")).toContain(".card { transition: none;");
  });

  test("Tile is a section on the neutral tile surface (tile, hairline border, soft shadow)", () => {
    const out = html(Tile, { children: child("body") });
    expect(out).toMatch(/^<section class="tile[^"]*"><span>body<\/span><\/section>$/);
    expect(html(Tile, { label: "Schedule", children: child("b") })).toContain('aria-label="Schedule"');
    const decls = rulesMatching(styleOf(uiSource("Tile.svelte")), /\.tile\b/).join(" ");
    for (const d of ["background: var(--tile)", "border: 1px solid var(--tile-border)", "box-shadow: var(--tile-shadow)"]) expect({ d, has: decls.includes(d) }).toEqual({ d, has: true });
    // A label makes the section a landmark region: the doc says so, for D's groups (heading, no label).
    expect(uiSource("Tile.svelte")).toMatch(/landmark/);
  });

  test("Tile's state outline: live (orange) or done (green) draws its class, outlined in its state colour; there is no wait outline", () => {
    for (const state of ["live", "done"]) {
      const cls = classesOf(html(Tile, { state, children: child("b") }), "tile");
      expect({ state, cls: cls.filter((c) => ["live", "done", "wait"].includes(c)) }).toEqual({ state, cls: [state] });
      const decls = rulesMatching(styleOf(uiSource("Tile.svelte")), new RegExp(`\\.${state}\\b`)).join(" ");
      expect({ state, border: decls.includes(`border-color: var(--state-${state})`) }).toEqual({ state, border: true });
      expect({ state, ring: decls.includes(`box-shadow: 0 0 0 1px var(--state-${state})`) }).toEqual({ state, ring: true });
    }
    // The hub's state outlines are orange and green only; the mockup's wait colours a label, not a tile.
    expect(uiSource("Tile.svelte")).not.toMatch(/\bwait\b|--state-wait/);
    expect(classesOf(html(Tile, { state: "wait", children: child("b") }), "tile").filter((c) => ["live", "done", "wait"].includes(c))).toEqual([]);
    expect(classesOf(html(Tile, { children: child("b") }), "tile").filter((c) => ["live", "done", "wait"].includes(c))).toEqual([]);
  });

  test("ActionButton is a real <button type=\"button\">, holding its children, and can be disabled", () => {
    const out = html(ActionButton, { onclick: () => {}, children: child("Run now") });
    expect(out).toMatch(/^<button type="button" class="action[^"]*"><span>Run now<\/span><\/button>$/);
    expect(html(ActionButton, { onclick: () => {}, disabled: true, children: child("Run now") })).toMatch(/<button[^>]* disabled[ >=]/);
    expect(uiSource("ActionButton.svelte")).toMatch(/<button\s+type="button"/);
    // (source pin) the click handler is on the button itself (a server render cannot click).
    expect(uiSource("ActionButton.svelte").replace(/<script[\s\S]*?<\/script>/, "")).toMatch(/<button\b[^>]*\{onclick\}[^>]*>/);
  });

  test("a disabled ActionButton of any kind draws one readable look: --muted on --tile (the kind's fill does not survive)", () => {
    const style = styleOf(uiSource("ActionButton.svelte"));
    const disabled = rulesMatching(style, /^\s*\.action:disabled\s*$/).join(" ");
    for (const d of ["background: var(--tile)", "color: var(--muted)", "border-color: var(--line)"]) expect({ d, has: disabled.includes(d) }).toEqual({ d, has: true });
    // `.action:disabled` (two classes' worth) outranks `.primary` / `.danger` (one): no kind rule may
    // be more specific than that, or its fill would come back.
    const kindSelectors = [...style.matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()).filter((s) => /\.(primary|danger)\b/.test(s));
    expect(kindSelectors).toEqual([".primary", ".danger"]);
  });

  test("ActionButton's explicit props: label → aria-label, kind → class, expanded → aria-expanded, current → aria-current", () => {
    const b = (props: Record<string, unknown>) => html(ActionButton, { onclick: () => {}, children: child("x"), ...props });
    expect(b({ label: "Next slide" })).toContain('aria-label="Next slide"');
    expect(b({})).not.toMatch(/aria-(label|expanded|current)=|title=/);
    // title (a general-purpose tooltip) is drawn when given, and only then.
    expect(b({ title: "Morning time" })).toMatch(/^<button [^>]*title="Morning time"/);
    expect(classesOf(b({ kind: "primary" }), "action")).toContain("primary");
    expect(classesOf(b({ kind: "danger" }), "action")).toContain("danger");
    expect(classesOf(b({ kind: "default" }), "action").filter((c) => c === "primary" || c === "danger")).toEqual([]);
    expect(b({ expanded: true })).toContain('aria-expanded="true"');
    expect(b({ expanded: false })).toContain('aria-expanded="false"');
    expect(b({ current: true })).toContain('aria-current="page"');
    expect(b({ current: false })).not.toContain("aria-current");
    const style = styleOf(uiSource("ActionButton.svelte"));
    const primary = rulesMatching(style, /\.primary\b/).join(" ");
    for (const d of ["background: var(--accent)", "color: var(--on-accent)"]) expect({ d, has: primary.includes(d) }).toEqual({ d, has: true });
    const danger = rulesMatching(style, /\.danger\b/).join(" ");
    for (const d of ["color: var(--danger)", "border-color: var(--danger)"]) expect({ d, has: danger.includes(d) }).toEqual({ d, has: true });
  });

  test("(source pin) ActionButton's doc: ordinary text buttons only; navigation controls are local buttons that take app.css's ctl class", () => {
    const doc = /<script lang="ts">([\s\S]*?)<\/script>/.exec(uiSource("ActionButton.svelte"))?.[1] ?? "";
    expect(doc).toMatch(/ordinary text buttons/);
    expect(doc).toMatch(/navigation controls[^]*?local `<button>`s[^]*?class="ctl"/i);
    // `current` is not "a sidebar's current page": ActionButton draws no current look.
    expect(doc).not.toMatch(/sidebar's current page/);
    // The default kind's --line border is below 3:1; the doc says the text carries the boundary.
    expect(doc).toMatch(/1\.4\.11/);
  });

  test("the specificity counter (prove-it 3b): ids, then classes / attributes / pseudo-classes, then types", () => {
    expect(specificity(".a")).toEqual([0, 1, 0]);
    expect(specificity(".chev.svelte-x1")).toEqual([0, 2, 0]);
    expect(specificity(".ctl.ctl:disabled")).toEqual([0, 3, 0]);
    expect(specificity("button:disabled")).toEqual([0, 1, 1]);
    expect(specificity("#x .y[data-k] li:hover")).toEqual([1, 3, 1]);
  });

  test("app.css's .ctl outranks a local one-class rule: each selector is above (0,2,0), the specificity of a Svelte-scoped `.chev`", () => {
    // app.css comes BEFORE every component's CSS in the bundle (main.ts imports it before App), so at
    // equal specificity a local rule would win; .ctl must be strictly more specific.
    const css = parseCss(readFileSync(APP_CSS, "utf8"));
    const ctl = css.filter((r) => /\.ctl\b/.test(r.selector)).map((r) => r.selector);
    expect(ctl).toHaveLength(2);
    for (const s of ctl) expect({ s, above: outranks(specificity(s), [0, 2, 0]) }).toEqual({ s, above: true });
  });

  test("app.css's opt-in .ctl class: the same focus ring and disabled look as ActionButton, by class only", () => {
    const css = parseCss(readFileSync(APP_CSS, "utf8"));
    const ring = css.filter((r) => r.selector === ".ctl.ctl:focus-visible");
    const off = css.filter((r) => r.selector === ".ctl.ctl:disabled");
    expect([ring.length, off.length]).toEqual([1, 1]);
    expect(Object.fromEntries(ring[0]!.decls)).toEqual({ outline: "2px solid var(--accent)", "outline-offset": "2px" });
    expect(Object.fromEntries(off[0]!.decls)).toEqual({ background: "var(--tile)", color: "var(--muted)", "border-color": "var(--line)", cursor: "default" });
    // ActionButton's own scoped rules are the same declarations (so a nav button and an action look alike).
    const style = styleOf(uiSource("ActionButton.svelte"));
    expect(Object.fromEntries(declarations(rulesMatching(style, /^\s*\.action:focus-visible\s*$/)))).toEqual(Object.fromEntries(ring[0]!.decls));
    expect(Object.fromEntries(declarations(rulesMatching(style, /^\s*\.action:disabled\s*$/)))).toEqual(Object.fromEntries(off[0]!.decls));
    // Opt-in: no app.css rule styles focus or disabled on anything but .ctl, so no existing control changes.
    const all = css.flatMap((r) => (r.selector.startsWith("@") ? r.children : [r]));
    expect(all.map((r) => r.selector).filter((s) => /:focus|:disabled/.test(s)).sort()).toEqual([".ctl.ctl:disabled", ".ctl.ctl:focus-visible"]);
    // (The ring's --accent ≥ 3:1 on --tile, --panel and --bg is the "non-text rings" rows above.)
  });

  test("(source pin) in every lib/ui stylesheet the base rule comes FIRST, so each variant, :disabled and @media override comes after it", () => {
    // A variant (`.local`, `.primary`, `.live`, `.highlighted`, …) has the base rule's specificity, so
    // only source order makes it win; a variant moved above its base silently loses (round 5).
    const bases: [string, string][] = [["Pill.svelte", "pill"], ["StatusTag.svelte", "tag"], ["Card.svelte", "card"], ["Tile.svelte", "tile"], ["ActionButton.svelte", "action"]];
    for (const [file, base] of bases) {
      const top = parseCss(styleOf(uiSource(file)));
      expect({ file, first: top[0]?.selector }).toEqual({ file, first: `.${base}` });
      // …and it is the only top-level rule for the bare base (an override sits in a later @media block).
      expect({ file, bases: top.filter((r) => r.selector === `.${base}`).length }).toEqual({ file, bases: 1 });
      expect({ file, more: top.length > 1 }).toEqual({ file, more: true });
    }
    // LiveRegion has no stylesheet of its own (app.css's .sr-only); every other component is listed.
    expect(uiSource("LiveRegion.svelte")).not.toMatch(/<style\b/);
  });

  test("no lib/ui component carries a tabindex", () => {
    for (const f of ["Pill.svelte", "StatusTag.svelte", "Card.svelte", "Tile.svelte", "ActionButton.svelte", "LiveRegion.svelte"]) {
      expect({ f, tabindex: /tabindex/.test(uiSource(f)) }).toEqual({ f, tabindex: false });
    }
  });
});

/* ── S0-M2-T4: motion, accessibility and geometry helpers ───────────────────────────────────────── */

describe("lib/ui/geometry: clampPct, a percentage in 0-100", () => {
  test("it is 100 · n / max, clamped to 0-100", () => {
    expect(clampPct(5, 10)).toBe(50);
    expect(clampPct(1, 3)).toBeCloseTo(33.333, 3);
    expect(clampPct(10, 10)).toBe(100);
    expect(clampPct(0, 10)).toBe(0);
  });

  test("negative, huge, NaN and Infinity inputs stay inside 0-100", () => {
    const cases: [number, number, number][] = [
      [-3, 10, 0],
      [1e300, 1e-300, 100],
      [1e12, 10, 100],
      [NaN, 10, 0],
      [5, NaN, 0],
      [Infinity, 10, 100],
      [-Infinity, 10, 0],
      [5, Infinity, 0],
      [Infinity, Infinity, 0],
    ];
    for (const [n, max, want] of cases) expect({ n, max, got: clampPct(n, max) }).toEqual({ n, max, got: want });
  });

  test("max 0 (or below) gives 0, never NaN or Infinity", () => {
    // Negative n with a negative max would otherwise give a positive ratio (-5 / -10 → 50).
    for (const [n, max] of [[0, 0], [5, 0], [-5, 0], [5, -10], [-5, -10], [-1, -1e308]] as const) {
      expect({ n, max, got: clampPct(n, max) }).toEqual({ n, max, got: 0 });
    }
  });

  test("for any input it returns a finite number in 0-100", () => {
    const odd = [-Infinity, -1e308, -1, -0, 0, 1e-320, 0.5, 1, 7, 1e308, Infinity, NaN];
    for (const n of odd) for (const max of odd) {
      const v = clampPct(n, max);
      expect({ n, max, ok: Number.isFinite(v) && v >= 0 && v <= 100 }).toEqual({ n, max, ok: true });
    }
  });
});

describe("lib/ui/geometry: clampInt, a whole number in 0..max (a count or an index)", () => {
  test("it truncates toward zero and stays inside 0..max", () => {
    const cases: [number, number, number][] = [
      [5, 12, 5],
      [0, 12, 0],
      [12, 12, 12],
      [2.9, 12, 2],
      [11.99, 12, 11],
      [12.5, 12, 12],
      [10, 3.7, 3], // a fractional max is truncated too
    ];
    for (const [n, max, want] of cases) expect({ n, max, got: clampInt(n, max) }).toEqual({ n, max, got: want });
  });

  test("negative, huge, NaN and Infinity inputs give a whole number inside 0..max", () => {
    const cases: [number, number, number][] = [
      [-3, 12, 0],
      [-0.5, 12, 0],
      [1e12, 12, 12],
      [1e300, 12, 12],
      [NaN, 12, 0],
      [Infinity, 12, 0],
      [-Infinity, 12, 0],
      [5, NaN, 0],
      [5, Infinity, 0],
      [5, -Infinity, 0],
    ];
    for (const [n, max, want] of cases) expect({ n, max, got: clampInt(n, max) }).toEqual({ n, max, got: want });
    expect(Object.is(clampInt(-0.5, 12), 0)).toBe(true); // +0, never -0
  });

  test("max 0 (or below) gives 0", () => {
    for (const [n, max] of [[0, 0], [5, 0], [-5, 0], [5, -1], [-5, -10], [5, 0.5]] as const) {
      expect({ n, max, got: clampInt(n, max) }).toEqual({ n, max, got: 0 });
    }
  });

  test("for any input it returns a finite whole number in 0..max", () => {
    const odd = [-Infinity, -1e308, -1, -0, 0, 1e-320, 0.5, 1, 7, 12, 1e308, Infinity, NaN];
    for (const n of odd) for (const max of odd) {
      const v = clampInt(n, max);
      const ok = Number.isInteger(v) && !Object.is(v, -0) && v >= 0 && (v === 0 || v <= Math.trunc(max));
      expect({ n, max, ok }).toEqual({ n, max, ok: true });
    }
  });
});

describe("lib/ui/motion: durations and reduced motion", () => {
  test("a jumped-to project's brief highlight is held HIGHLIGHT_MS, longer than the glide, and reduced motion does not shorten it", () => {
    expect(HIGHLIGHT_MS).toBe(1200);
    expect(HIGHLIGHT_MS).toBeGreaterThan(GLIDE_MS);
    // The highlight is a state, not an animation: under reduced motion it still shows (its ring just
    // does not fade), so `durations` does not carry or zero it.
    expect(Object.keys(durations(true))).toEqual(["glideMs", "openMs"]);
    expect(readFileSync(`${UI_SRC}motion.ts`, "utf8")).toMatch(/HIGHLIGHT_MS[\s\S]*not[^.]*reduced motion|reduced motion[^.]*not[\s\S]*HIGHLIGHT_MS/);
  });

  test("the glide is about 0.38 s, and the open is shorter", () => {
    expect(GLIDE_MS).toBe(380);
    expect(OPEN_MS).toBeGreaterThan(0);
    expect(OPEN_MS).toBeLessThan(GLIDE_MS);
  });

  test("under reduced motion every duration is 0", () => {
    expect(durations(false)).toEqual({ glideMs: GLIDE_MS, openMs: OPEN_MS });
    expect(durations(true)).toEqual({ glideMs: 0, openMs: 0 });
  });

  test("the reduced-motion query is the system one, read through matchMedia when there is one", () => {
    expect(REDUCED_MOTION_QUERY).toBe("(prefers-reduced-motion: reduce)");
    const asked: string[] = [];
    const media = (matches: boolean) => (q: string) => (asked.push(q), { matches });
    expect(prefersReducedMotion(media(true))).toBe(true);
    expect(prefersReducedMotion(media(false))).toBe(false);
    expect(asked).toEqual([REDUCED_MOTION_QUERY, REDUCED_MOTION_QUERY]);
    expect(prefersReducedMotion(undefined)).toBe(false); // no matchMedia (the server render): motion on
  });

  test("with NO argument it reads the webview's own matchMedia, as a method of globalThis", () => {
    const g = globalThis as { matchMedia?: unknown };
    const had = Object.prototype.hasOwnProperty.call(g, "matchMedia");
    const before = g.matchMedia;
    const calls: { q: string; self: unknown }[] = [];
    try {
      for (const matches of [true, false]) {
        g.matchMedia = function (this: unknown, q: string) {
          calls.push({ q, self: this });
          return { matches };
        };
        expect(prefersReducedMotion()).toBe(matches);
      }
      expect(calls.map((c) => c.q)).toEqual([REDUCED_MOTION_QUERY, REDUCED_MOTION_QUERY]);
      expect(calls.every((c) => c.self === globalThis)).toBe(true); // a real webview's matchMedia throws on any other `this`
      delete g.matchMedia;
      expect(prefersReducedMotion()).toBe(false); // none at all: motion on
    } finally {
      if (had) g.matchMedia = before;
      else delete g.matchMedia;
    }
  });
});

describe("lib/ui/a11y: focus-on-heading and the live region's text", () => {
  const fakeNode = () => {
    const calls: unknown[] = [];
    const raw = { isConnected: true, focus: (opts?: unknown) => calls.push(opts ?? null) };
    return { calls, raw, node: raw as unknown as HTMLElement };
  };
  /** Lets every queued microtask run: a timer fires only once the microtask queue is empty. */
  const settle = () => new Promise<void>((done) => setTimeout(done, 0));

  test("focusHeading focuses the node (without scrolling) when active, and again when it becomes active, once the current flush is over", async () => {
    const a = fakeNode();
    const handle = focusHeading(a.node, true);
    expect(a.calls).toEqual([]); // deferred: not during the action's own mount
    await settle();
    expect(a.calls).toEqual([{ preventScroll: true }]);
    handle?.update?.(false);
    await settle();
    expect(a.calls).toHaveLength(1);
    handle?.update?.(true);
    expect(a.calls).toHaveLength(1); // deferred: not during the action's update
    await settle();
    expect(a.calls).toEqual([{ preventScroll: true }, { preventScroll: true }]); // both calls, never a scroll
    const b = fakeNode();
    focusHeading(b.node, false);
    await settle();
    expect(b.calls).toEqual([]);
    const c = fakeNode();
    focusHeading(c.node, undefined); // `use:focusHeading` with no argument: focus on mount
    await settle();
    expect(c.calls).toHaveLength(1);
  });

  test("focusHeading focuses AFTER the parent's template effects: a slide still inert when the action runs gets focus once inert is cleared", async () => {
    // Svelte runs an action's mount and update before the parent's template effects (svelte 5.57.0,
    // `src/internal/client/dom/elements/actions.js`), so a deck that marks off-screen slides `inert`
    // still has `inert` on the new slide then, and a focus at that moment lands on <body>. Here the
    // fake node records whether it was inert when focused; the "parent effect" clears it synchronously
    // after the action has run, as the same flush would.
    const inertAtFocus: boolean[] = [];
    const n = { isConnected: true, inert: true, focus: () => inertAtFocus.push(n.inert) };
    const handle = focusHeading(n as unknown as HTMLElement, true);
    n.inert = false;
    await settle();
    expect(inertAtFocus).toEqual([false]);
    handle?.update?.(false); // the user moves away…
    n.inert = true;
    handle?.update?.(true); // …and back: a change to true again
    n.inert = false;
    await settle();
    expect(inertAtFocus).toEqual([false, false]);
  });

  test("focusHeading focuses only when its argument TURNS true: an update that repeats true, or passes undefined, focuses nothing", async () => {
    // svelte 5.57.0 calls `update` on the first re-run of the action's argument even when the value
    // has not changed (`prev` starts as `{}`, `src/internal/client/dom/elements/actions.js:20-36`).
    const a = fakeNode();
    const ha = focusHeading(a.node, true);
    ha?.update?.(true); // the first re-run, same value
    await settle();
    expect(a.calls).toHaveLength(1); // the mount's focus only
    ha?.update?.(false);
    ha?.update?.(true);
    await settle();
    expect(a.calls).toHaveLength(2); // true → false → true: a second focus
    const b = fakeNode();
    const hb = focusHeading(b.node, false);
    hb?.update?.(true);
    await settle();
    expect(b.calls).toHaveLength(1); // false → true
    hb?.update?.(undefined);
    await settle();
    expect(b.calls).toHaveLength(1); // undefined: no focus
    hb?.update?.(true);
    await settle();
    expect(b.calls).toHaveLength(2); // undefined → true: "from anything but true" includes undefined
  });

  test("focusHeading focuses nothing that is gone by then: a destroyed action, or a node no longer in the document", async () => {
    const a = fakeNode();
    focusHeading(a.node, true)?.destroy?.();
    await settle();
    expect(a.calls).toEqual([]);
    const b = fakeNode();
    b.raw.isConnected = false;
    focusHeading(b.node, true);
    await settle();
    expect(b.calls).toEqual([]);
    const c = fakeNode();
    focusHeading(c.node, false)?.update?.(true);
    c.raw.isConnected = false; // removed before the microtask runs
    await settle();
    expect(c.calls).toEqual([]);
  });

  test("nextLiveText: a new message is set; the same message again changes so it is heard again; empty clears", () => {
    expect(nextLiveText("", "Running")).toBe("Running");
    expect(nextLiveText("Running", "Done")).toBe("Done");
    expect(nextLiveText("Running", "Running")).toBe("Running\u00a0");
    expect(nextLiveText("Running\u00a0", "Running")).toBe("Running");
    expect(nextLiveText("Running", "")).toBe("");
    expect(nextLiveText("", "")).toBe(""); // empty stays empty: no repeat mark on nothing
    // The repeat mark is written as an escape, never as an invisible literal character.
    expect(uiSource("a11y.ts")).not.toContain("\u00a0");
    expect(uiSource("a11y.ts")).toContain('"\\u00a0"');
  });

  test("LiveRegion renders its text inside an aria-live=\"polite\" element, visually hidden", () => {
    const out = html(LiveRegion, { text: "Running 2 of 5" });
    expect(out).toMatch(/^<p class="live[^"]*" aria-live="polite">Running 2 of 5<\/p>$/);
    expect(html(LiveRegion, { text: "" })).toMatch(/^<p class="live[^"]*" aria-live="polite"><\/p>$/);
    // Visually hidden by app.css's one .sr-only (its rules are pinned above), not a copy of its own.
    expect(classesOf(out, "live")).toEqual(["live", "sr-only"]);
    expect(uiSource("LiveRegion.svelte")).not.toMatch(/<style\b/);
  });

  test("LiveRegion draws nextLiveText's repeat mark as it is, so a repeated message is a change", () => {
    // Read the raw render: `html()` folds whitespace, and U+00A0 is whitespace to a regular expression.
    const text = nextLiveText("Running", "Running");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = render(LiveRegion as any, { props: { text } }).body;
    expect(body).toContain(">Running\u00a0</p>");
  });
  // (That the helpers build no DOM and write no style is `static.check.ts`'s scan of all of gui/src,
  // which lib/ui is part of; it is not repeated here.)
});
