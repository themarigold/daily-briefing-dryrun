/**
 * v0.2.1 §3.1 — ONE NAME FOR THE SETTING: "Morning time" (user decision, 2026-10-03).
 *
 * The static labels, hints and notes of the wizard, Settings and Today say neither "floor" (any case,
 * whole word) nor "Earliest time" (any case). ONE sentence is exempt, exactly: the wizard keeps "This is
 * the <strong>earliest</strong> time, not an exact one", which explains the setting. Its pieces are
 * scanned one by one ("earliest" alone is not an offence) AND joined, where it reads "earliest time" —
 * so `scanned()` removes exactly `KEPT_SENTENCE` (whitespace collapsed) before the bans are tested, and
 * any other "earliest time" in the same text is still caught.
 *
 * NOT scanned, by design:
 * - briefing content — a commit subject may say "floor";
 * - code comments — spec §3.1 lets them keep the old words. That is why component text is read from
 *   the compiler's AST (a comment is its own node there; a `<script>` is not template), never by a
 *   regex over the `.svelte` source;
 * - machine codes (`below-floor`, `waiting-for-floor`, the `floor` step id) — never shown;
 * - each Settings field's `quote`: a verbatim mirror of an engine source comment, pinned by its own
 *   test (`settings.check.ts`) and kept in the model, undisplayed, by spec §4.1. Since M3b the form
 *   renders `help` in its place, so nothing of it reaches the markup — and the markup is scanned whole,
 *   so a quote rendered again would be scanned like any other text.
 *
 * ⚠ ONE LIST. `userText()` is every string this file scans, from three sources: the models' strings,
 * the components' static template text, and server-rendered markup. Each Settings field's `help`
 * (M3b, spec §4.1) is in `modelText()` beside `label`, `note` and `placeholder`, and in the markup.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "svelte/compiler";
import { render } from "svelte/server";

import { REDACTED_API_KEY } from "../src/lib/files";
import { storedTimeNote } from "../src/lib/morning-time";
import { SECTIONS, type Draft } from "../src/lib/settings-model";
import { todayModel } from "../src/lib/today";
import {
  draftFromConfig,
  emptyDraft,
  firstWakeSentence,
  loginItemNote,
  saveGateBlocker,
  stepBlocker,
  STEP_ORDER,
  type WizardDraft,
} from "../src/lib/wizard";
import SettingsForm from "../src/routes/SettingsForm.svelte";
import TodayView from "../src/routes/TodayView.svelte";
import Wizard from "../src/routes/Wizard.svelte";

const SRC = new URL("../src/", import.meta.url).pathname;
const FULL = readFileSync(new URL("../src-tauri/tests/fixtures/config-full.json", import.meta.url), "utf8");
const API = readFileSync(new URL("../src-tauri/tests/fixtures/config-api.json", import.meta.url), "utf8");

const BANNED: { name: string; re: RegExp }[] = [
  { name: '"floor"', re: /\bfloor\b/i },
  { name: '"Earliest time"', re: /earliest time/i },
];
/** The one exempt sentence (spec §3.1 keeps it), as it reads once its `<strong>` is joined and its
 *  whitespace collapsed. Removed only as this exact, case-sensitive whole. */
const KEPT_SENTENCE = "This is the earliest time, not an exact one.";

/** The bans a text breaks, after whitespace is collapsed and `KEPT_SENTENCE` is removed. */
function scanned(text: string): string[] {
  const t = text.replace(/\s+/g, " ").split(KEPT_SENTENCE).join(" ");
  return BANNED.filter((b) => b.re.test(t)).map((b) => b.name);
}

interface Scanned {
  where: string;
  text: string;
}

/* ── 1. the models' strings ───────────────────────────────────────────────────────────────────── */

function modelText(): Scanned[] {
  const out: Scanned[] = [];
  for (const section of SECTIONS) {
    out.push({ where: `Settings section`, text: section.title });
    for (const f of section.fields) {
      // ⚠ NOT `f.quote` (see the header). `f.help` (M3b, spec §4.1) is what the form shows instead.
      for (const [key, text] of [["label", f.label], ["help", f.help], ["note", f.note], ["placeholder", f.placeholder]] as const) {
        if (text !== undefined) out.push({ where: `Settings ${f.id}.${key}`, text });
      }
    }
  }
  // The Settings field's notes for a stored value that is not HH:MM.
  for (const stored of ["7:05", "7:5", 720]) {
    out.push({ where: `Settings morningTime note (${String(stored)})`, text: storedTimeNote(stored) ?? "" });
  }
  // Every reason the wizard gives for not moving on, from drafts that trip each one.
  const blocked: WizardDraft[] = [
    { ...emptyDraft(), providerPath: "api", apiModel: "" },
    { ...emptyDraft(), providerPath: "api", apiModelConfirmed: false },
    { ...emptyDraft(), providerPath: "api", apiModelConfirmed: true },
    { ...emptyDraft(), providerPath: "local" },
    { ...emptyDraft(), providerPath: "local", localBaseUrl: "http://127.0.0.1:11434/v1" },
    { ...emptyDraft(), rootHome: false },
    { ...emptyDraft(), floor: "late" },
  ];
  for (const step of STEP_ORDER) {
    for (const d of blocked) {
      const why = stepBlocker(step, d);
      if (why !== null) out.push({ where: `wizard stepBlocker(${step})`, text: why });
    }
  }
  for (const s of [
    { seedFailed: true, recovered: false, acknowledged: false },
    { seedFailed: false, recovered: true, acknowledged: false },
  ]) {
    out.push({ where: "wizard saveGateBlocker", text: saveGateBlocker(s) ?? "" });
  }
  out.push({ where: "wizard loginItemNote", text: loginItemNote({ kind: "pending" }, null) ?? "" });
  out.push({ where: "wizard loginItemNote", text: loginItemNote({ kind: "failed", detail: "x" }, null) ?? "" });
  out.push({ where: "wizard firstWakeSentence", text: firstWakeSentence("07:20") });
  out.push({ where: "wizard floorNote", text: draftFromConfig('{"morningTime":"7:5"}')?.floorNote ?? "" });
  return out;
}

/* ── 2. the components' static template text, from the AST ────────────────────────────────────── */

interface Node {
  type: string;
  [key: string]: unknown;
}
const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

/** Attributes that are never shown as text. Every other static attribute value is scanned
 *  (`aria-label`, `title`, `placeholder`, a component's `label="…"`, an `<input>`'s or `<textarea>`'s
 *  `value` — the text the field shows, …). `value` is hidden on an `<option>` alone: there it is the code
 *  the select writes, and the option's label is its own text, which is scanned. */
const NOT_SHOWN = new Set(["class", "id", "for", "type", "name", "role", "rows", "spellcheck", "style"]);
const notShown = (attribute: string, element: string | undefined): boolean =>
  NOT_SHOWN.has(attribute) || (attribute === "value" && element === "option");
/** Template-node keys that hold JavaScript or bookkeeping — the same split `static.check.ts` walks. */
const CODE_KEYS = new Set(["expression", "test", "context", "key", "tag", "declaration", "parameters", "identifiers", "error"]);
const SKIPPED_KEYS = new Set(["type", "start", "end", "name", "name_loc", "loc", "metadata", "raw", "data", "modifiers", "index", "fragment_loc"]);

/** The string literals an expression can DISPLAY: the branches of a `?:`, either side of `??`/`||`/
 *  `&&` and of a string `+`, a template's text. A comparison's operand (`step === "floor"`) is not
 *  displayed, and is not collected. */
function shownLiterals(e: Node): string[] {
  const sub = (k: string) => (isNode(e[k]) ? shownLiterals(e[k] as Node) : []);
  switch (e.type) {
    case "Literal":
      return typeof e.value === "string" ? [e.value] : [];
    case "TemplateLiteral":
      return [
        ...(e.quasis as { value: { cooked: string | null } }[]).map((q) => q.value.cooked ?? ""),
        ...(e.expressions as Node[]).flatMap(shownLiterals),
      ];
    case "ConditionalExpression":
      return [...sub("consequent"), ...sub("alternate")];
    case "LogicalExpression":
      return [...sub("left"), ...sub("right")];
    case "BinaryExpression":
      return e.operator === "+" ? [...sub("left"), ...sub("right")] : [];
    default:
      return [];
  }
}

/** Every piece of text a component's template can show without a runtime value: text nodes, static
 *  attribute values, displayed literals. Comments are skipped; `<script>` and `<style>` are not part
 *  of the template. */
function templateText(source: string): string[] {
  const ast = parse(source, { modern: true }) as unknown as { fragment: Node };
  const out: string[] = [];
  // `element` is the name of the element (or component) whose attributes are being walked.
  const walk = (node: Node, element?: string): void => {
    switch (node.type) {
      case "Comment":
        return;
      case "Text":
        out.push(String(node.data));
        return;
      case "ExpressionTag":
        out.push(...shownLiterals(node.expression as Node));
        return;
      case "Attribute": {
        if (notShown(String(node.name).toLowerCase(), element)) return;
        for (const part of Array.isArray(node.value) ? node.value : [node.value]) if (isNode(part)) walk(part);
        return;
      }
    }
    const owner = Array.isArray(node.attributes) && typeof node.name === "string" ? node.name.toLowerCase() : element;
    for (const [key, value] of Object.entries(node)) {
      if (SKIPPED_KEYS.has(key) || CODE_KEYS.has(key) || (key === "value" && node.type === "AwaitBlock")) continue;
      for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) walk(child, owner);
    }
  };
  walk(ast.fragment);
  return out;
}

/** The three screens and every component they import, transitively (so a new child is scanned
 *  without being listed here). Paths relative to `gui/src/`. */
function screenComponents(): string[] {
  const seen = new Set<string>();
  const queue = ["routes/Wizard.svelte", "routes/Settings.svelte", "routes/Today.svelte"];
  while (queue.length > 0) {
    const rel = queue.shift()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const source = readFileSync(join(SRC, rel), "utf8");
    for (const m of source.matchAll(/^\s*import\s+\w+\s+from\s+"(\.{1,2}\/[^"]+\.svelte)";/gm)) {
      queue.push(join(dirname(rel), m[1]!));
    }
  }
  return [...seen].sort();
}

function componentText(): Scanned[] {
  return screenComponents().flatMap((rel) => {
    const texts = templateText(readFileSync(join(SRC, rel), "utf8"));
    // Each piece, and the pieces joined in order (the text as it reads across inline elements).
    return [...texts.map((text) => ({ where: rel, text })), { where: `${rel} (joined)`, text: texts.join("") }];
  });
}

/* ── 3. server-rendered markup ────────────────────────────────────────────────────────────────── */

const flat = (body: string): string => body.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");

function renderedText(): Scanned[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ssr = (c: unknown, props: Record<string, unknown>) => flat(render(c as any, { props }).body);
  const form = (draft: Draft) =>
    ssr(SettingsForm, {
      draft,
      errors: {},
      onfield: () => {},
      onnotifycommand: () => {},
      ondefault: () => {},
      onremovekey: () => {},
    });
  const withMorning = (v: string) => ({ ...(JSON.parse(FULL) as Draft), morningTime: v });
  const api = JSON.parse(API.replace("sk-ant-SENTINEL-DO-NOT-LEAK-0000", REDACTED_API_KEY)) as Draft;
  const empty = todayModel({ snapshot: null, latest: { state: "none" }, lastRun: null, today: "2026-10-03" });
  return [
    { where: "Wizard (step 1)", text: ssr(Wizard, { scheduleState: null, os: "macos" }) },
    { where: "Wizard (step 1, Linux)", text: ssr(Wizard, { scheduleState: null, os: "linux" }) },
    { where: "SettingsForm (config-full)", text: form(JSON.parse(FULL) as Draft) },
    { where: "SettingsForm (config-api)", text: form(api) },
    { where: "SettingsForm (7:05)", text: form(withMorning("7:05")) },
    { where: "SettingsForm (7:5)", text: form(withMorning("7:5")) },
    {
      where: "TodayView (no briefing yet)",
      text: ssr(TodayView, { model: empty, running: false, progress: [], runResult: "", detailsOpen: false, onrun: () => {} }),
    },
  ];
}

/** THE list. */
function userText(): Scanned[] {
  return [...modelText(), ...componentText(), ...renderedText()];
}

/* ── the tests ────────────────────────────────────────────────────────────────────────────────── */

describe('v0.2.1 §3.1: the setting is called "Morning time" — never "floor", never "Earliest time"', () => {
  test("no scanned label, hint or note says either", () => {
    const offences = userText().flatMap((s) =>
      scanned(s.text).map((name) => `${s.where}: ${name} in ${JSON.stringify(s.text.slice(0, 200))}`),
    );
    expect(offences).toEqual([]);
  });

  test("the scan is not vacuous: it reaches the three screens, the new name and the kept sentence", () => {
    const all = userText();
    const components = screenComponents();
    for (const rel of [
      "routes/Wizard.svelte",
      "lib/MorningTimeSelect.svelte",
      "lib/ScheduleAccess.svelte",
      "routes/Settings.svelte",
      "routes/SettingsForm.svelte",
      "routes/Today.svelte",
      "routes/TodayView.svelte",
    ]) {
      expect({ rel, scanned: components.includes(rel) }).toEqual({ rel, scanned: true });
    }
    const said = (where: RegExp, text: string) => all.some((s) => where.test(s.where) && s.text.includes(text));
    expect(said(/^routes\/Wizard\.svelte$/, "Morning time")).toBe(true);
    expect(said(/^routes\/Wizard\.svelte \(joined\)$/, "This is the earliest time, not an")).toBe(true);
    // The exemption is load-bearing, and exact: the joined wizard text DOES read "earliest time", and
    // it is the whole kept sentence that `scanned()` removes.
    const joined = all.find((s) => s.where === "routes/Wizard.svelte (joined)")!.text;
    expect(BANNED.some((b) => b.re.test(joined))).toBe(true);
    expect(joined.replace(/\s+/g, " ")).toContain(KEPT_SENTENCE);
    expect(scanned(joined)).toEqual([]);
    expect(said(/^routes\/Wizard\.svelte$/, "Step 6 of 7 — your morning time")).toBe(true);
    expect(said(/^Settings morningTime\.label$/, "Morning time")).toBe(true);
    expect(said(/^wizard stepBlocker\(floor\)$/, "Choose a morning time.")).toBe(true);
    expect(said(/^routes\/TodayView\.svelte$/, "your morning time has passed")).toBe(true);
    expect(said(/^SettingsForm \(config-full\)$/, "Morning time")).toBe(true);
    expect(said(/^TodayView \(no briefing yet\)$/, "No briefing yet")).toBe(true);
    expect(said(/^Wizard \(step 1\)$/, "Set up Daily Briefing")).toBe(true);
  });

  test("the scan can fail: the old wording is caught, and comments and machine codes are not scanned", () => {
    for (const old of [
      "Morning floor (HH:MM)", "Earliest time (24-hour HH:MM)", "once the morning floor has passed", "FLOOR",
      "Pick your earliest time", "EARLIEST TIME",
      // The exemption is the kept sentence exactly: a variant of it, or another offence beside it, is caught.
      "This is the Earliest time, not an exact one.", "This is the earliest time.",
      "This is the earliest time, not an exact one. Earliest time (HH:MM)",
    ]) {
      expect({ old, caught: scanned(old).length > 0 }).toEqual({ old, caught: true });
    }
    // The kept sentence — as the source spells it across lines, too — and the new name are not.
    for (const fine of ["This is the earliest time, not an exact one.", "This is the earliest time, not an\n        exact one.", "Morning time", "floorWarning"]) {
      expect({ fine, caught: scanned(fine).length > 0 }).toEqual({ fine, caught: false });
    }
    // A template comment, a script comment, a comparison and a class name are not shown text…
    const probe = templateText(
      '<script lang="ts">\n  // the floor\n  let step = "floor";\n</script>\n<!-- the floor -->\n' +
        '<p class="floor">{step === "floor" ? "Morning time" : "Earliest time"}</p>\n' +
        '<label for="floor">Morning time</label>',
    );
    expect(probe.filter((t) => t.trim() !== "")).toEqual(["Morning time", "Earliest time", "Morning time"]);
    // …while shown text in each of those positions is (the last one would be an offence).
    expect(templateText('<input aria-label="The floor" />')).toEqual(["The floor"]);
    // An input's or textarea's static `value` is the text the field shows, and is scanned; an option's is
    // the code its select writes (its label is its text, scanned), and is not.
    expect(templateText('<input value="Earliest time" />')).toEqual(["Earliest time"]);
    expect(templateText('<textarea value="the floor"></textarea>')).toEqual(["the floor"]);
    expect(templateText('<select><option value="floor">Morning time</option></select>')).toEqual(["Morning time"]);
    expect(scanned(templateText('<input value="Earliest time" />').join(""))).toEqual(['"Earliest time"']);
  });
});

/* ── v0.2.1 §3.5: the same AST scan, for the Mac ──────────────────────────────────────────────── */

describe("v0.2.1 §3.5: Wizard.svelte's own text names the Mac only where the step is macOS-only", () => {
  test("every static Mac/macOS string is the folder-access step's, or the gated protected-folders note", () => {
    // Every other OS-dependent string comes from `wizardOsWording` (`wizard.check.ts` executes it and
    // pins where the template uses it). A new hard-coded "Mac" in any step that Linux reaches fails here.
    const said = templateText(readFileSync(join(SRC, "routes/Wizard.svelte"), "utf8"))
      .map((t) => t.replace(/\s+/g, " ").trim())
      .filter((t) => /\bMac\b|macOS/.test(t));
    expect(said).toEqual([
      "Step 4 of 7 — macOS folder access",
      "These three are macOS-protected and start UNTICKED on purpose: nothing should trigger a permission dialog you did not choose. Tick one only if your repositories live there — the next step then walks you through the grant.",
      "Some folders you chose are ones macOS protects. The engine cannot read them — and your briefing is quietly thinner — until access is granted. This is the same panel the Schedule screen carries, so you can redo any of it later.",
    ]);
  });
});
