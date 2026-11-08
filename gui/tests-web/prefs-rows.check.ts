/**
 * A-M7-T15 — A's two Settings rows on General (`src/lib/settings/PrefsRows.svelte`; redesign A spec, "The slides
 * switch" and "First name"): "Your first name" and "Show the briefing as slides", applied at once through
 * `app-prefs-store.ts`, each with its own saved / failed line, and one line when the store's load failed. They fill
 * D's reserved `prefsRows` slot (D spec, "The reserved-row contract") and are not inputs of D's `changedPages`.
 *
 * Methods: SERVER RENDER of `PrefsRows` with the store seeded through `loadAppPrefs()` over a recorded IPC (loaded,
 * load failed) and with the lines a set leaves (a refused name, a saved one: a server render runs no handler, so
 * those states come in through the `initial` prop, which the app never passes); SOURCE PINS for the wiring (the
 * snippet in `Settings.svelte`, the self-closing tag, GeneralPage's reserved place, the handlers as written); PURE
 * for `changedPages` and for the rows' decisions (`src/lib/settings/prefs-rows.ts`: what each set's answer does,
 * which the handlers only call).
 *
 * ⚠ THE IPC IS A RECORDER, NOT TAURI (the `app-prefs.check.ts` pattern): `invoke` calls
 * `window.__TAURI_INTERNALS__.invoke(cmd, args)`, installed per test. Nothing here reaches a real store.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { render } from "svelte/server";

import PrefsRows from "../src/lib/settings/PrefsRows.svelte";
import { appPrefs, loadAppPrefs, setFirstName, setSlides, type AppPrefsSetOutcome } from "../src/lib/app-prefs-store";
import { changedPages } from "../src/lib/settings/pages";
import { flushesOnUnmount, nameAfterSet, sendsName, sendsSlides, slidesAfterSet } from "../src/lib/settings/prefs-rows";

type Json = Record<string, unknown>;
let calls: [string, Json | undefined][] = [];
let handler: (command: string, args: Json | undefined) => unknown;
const g = globalThis as { window?: unknown };
let hadWindow = false;
let windowBefore: unknown;

beforeEach(() => {
  calls = [];
  handler = () => {
    throw new Error("no handler set");
  };
  hadWindow = "window" in g;
  windowBefore = g.window;
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: Json | undefined) => {
        calls.push([command, args === undefined ? undefined : structuredClone(args)]);
        try {
          return Promise.resolve(handler(command, args));
        } catch (e) {
          return Promise.reject(e);
        }
      },
    },
  };
});

afterEach(async () => {
  // Leave the module store at its defaults for whichever check file runs next in this process.
  handler = () => ({ slides: true });
  await loadAppPrefs();
  if (hadWindow) g.window = windowBefore;
  else delete g.window;
});

const src = (rel: string): string => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
// Comments, whitespace and the scope classes removed (`svelte-…`), so the markup reads as written.
const flat = (s: string): string =>
  s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .replace(/ ?\bsvelte-[a-z0-9]+\b/g, "")
    .replace(/ class=""/g, "");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const html = (props: Record<string, unknown> = {}): string => flat(render(PrefsRows as any, { props }).body);
const seed = async (answer: unknown): Promise<void> => {
  handler = () => {
    if (answer instanceof Error || (typeof answer === "object" && answer !== null && "kind" in answer)) throw answer;
    return answer;
  };
  await loadAppPrefs();
};
const badLines = (body: string): string[] => [...body.matchAll(/<p class="(?:[^"]* )?bad(?: [^"]*)?"[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]!);
/** Each row's live region (round-1 M8): its class and its text, in page order. */
const liveLines = (body: string): [string, string][] =>
  [...body.matchAll(/<p class="(line[^"]*)"[^>]* aria-live="polite">([^<]*)<\/p>/g)].map((m) => [m[1]!, m[2]!]);

const TOO_LONG = "Your first name can be at most 40 characters.";
const STORE_FAILURE = { kind: "store", detail: "this app's data directory could not be resolved: no home" };

describe("PrefsRows: server render with a seeded store", () => {
  test("loaded (Sam, slides on): the name in its labelled input, Turn off, no failure line", async () => {
    await seed({ firstName: "Sam", slides: true });
    const b = html();
    expect(b).toContain('<label for="pref-first-name">Your first name</label>');
    expect(b).toMatch(/<input id="pref-first-name" type="text"[^>]* value="Sam"/);
    expect(b).toContain("<h5>Show the briefing as slides</h5>");
    expect(b).toContain("Today shows the briefing as slides, one slide at a time (the default).");   // round-2 L7
    expect(b).not.toContain("one card at a time");
    expect(b).toMatch(/<button[^>]*>Turn off<\/button>/);
    expect(b).not.toContain(">Turn on</button>");
    expect(badLines(b)).toEqual([]);
    expect(b).not.toContain('class="saved');
    expect(b).not.toContain("aria-describedby");
    // Round-1 M8: each row's live region is drawn, empty, before anything is said in it.
    expect(liveLines(b)).toEqual([["line", ""], ["line", ""]]);
    // Every row is in one Tile under one small-caps group name, as D's General groups are.
    expect(b).toContain('<h4>Today</h4>');
    expect(b.match(/class="block"/g)?.length).toBe(2);
  });

  test("slides off: the classic-view sentence and Turn on", async () => {
    await seed({ slides: false });
    const b = html();
    expect(b).toContain("Today shows the whole briefing on one page, the classic view.");
    expect(b).toMatch(/<button[^>]*>Turn on<\/button>/);
    expect(b).not.toContain(">Turn off</button>");
    expect(b).toMatch(/<input id="pref-first-name" type="text"[^>]* value=""/);
  });

  test("load failed: ONE failure line, and the defaults (name empty, slides on) still drawn and usable", async () => {
    await seed(STORE_FAILURE);
    const b = html();
    expect(badLines(b)).toEqual([
      `Your app preferences could not be read, so the defaults are in use: ${STORE_FAILURE.detail}`,
    ]);
    expect(b).toMatch(/<input id="pref-first-name" type="text"[^>]* value=""/);
    expect(b).toMatch(/<button[^>]*>Turn off<\/button>/);
    expect(b).not.toMatch(/ disabled/);
  });

  test("a refused name: the typed value stays in the input, Rust's sentence inline under it, as text", async () => {
    await seed({ firstName: "Sam", slides: true });
    const typed = "<b>" + "x".repeat(41) + "</b>";
    const b = html({ initial: { name: typed, nameLine: { ok: false, text: TOO_LONG } } });
    expect(b).toContain(`value="&lt;b>${"x".repeat(41)}&lt;/b>"`);
    expect(badLines(b)).toEqual([TOO_LONG]);
    // Round-1 M8: in the row's one polite live region (as "Saved." is), so the refusal is announced.
    expect(b).toContain(`<p class="line bad" id="pref-first-name-line" aria-live="polite">${TOO_LONG}</p>`);
    expect(b).not.toContain('role="status"');
    expect(b).toMatch(/<input id="pref-first-name"[^>]* aria-describedby="pref-first-name-line" aria-invalid="true"/);
    expect(b).not.toContain("<b>x");
    // The line belongs to the name's row; the slides row has no line.
    const nameRow = b.slice(b.indexOf('<label for="pref-first-name"'), b.indexOf("<h5>Show the briefing as slides</h5>"));
    expect(badLines(nameRow)).toEqual([TOO_LONG]);
  });

  test("each row's saved line is its own, and a hostile message stays text", async () => {
    await seed({ firstName: "Sam", slides: true });
    const b = html({
      initial: { nameLine: { ok: true, text: "Saved." }, slidesLine: { ok: false, text: "<img src=x onerror=1>" } },
    });
    const at = b.indexOf("<h5>Show the briefing as slides</h5>");
    expect(b.slice(0, at)).toContain('<p class="line" id="pref-first-name-line" aria-live="polite">Saved.</p>');
    expect(liveLines(b)).toEqual([["line", "Saved."], ["line bad", "&lt;img src=x onerror=1>"]]);
    expect(b).toMatch(/<input id="pref-first-name"[^>]* aria-describedby="pref-first-name-line"/);
    expect(b).not.toMatch(/<input id="pref-first-name"[^>]* aria-invalid/);
    expect(b.slice(at)).not.toContain('class="saved"');
    expect(b.slice(at)).not.toContain(">Saved.<");
    expect(badLines(b.slice(at))).toEqual(["&lt;img src=x onerror=1>"]);
    expect(b).not.toContain("<img");
  });
});

describe("PrefsRows: source pins", () => {
  // The rows are PrefsRowsBody.svelte since round-3 M1 (PrefsRows.svelte is their gate, pinned below).
  const rows = src("lib/settings/PrefsRowsBody.svelte");
  const rowsFlat = rows.replace(/\s+/g, " ");

  test("it writes only through the app-prefs store: no draft, no field writer, no config command", () => {
    const imports = [...rows.matchAll(/^\s*import\s+(?:type\s+)?[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../app-prefs-store", "../ui/Tile.svelte", "./prefs-rows", "svelte"]);
    // The code and markup, comments removed (the header comment explains what the rows do not touch).
    const code = rows.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const banned of ["draft", "onfield", "settings-model", "config_", "invoke(", "{@html"]) expect(code).not.toContain(banned);
    expect(rows).toContain("await setFirstName(sent)");
    expect(rows).toContain("await setSlides(on)");
  });

  test("the name saves on blur or Enter; the handler is prefs-rows.ts's decisions and the busy flag, as written", () => {
    expect(rowsFlat).toContain('onblur={() => void saveName()}');
    expect(rowsFlat).toContain('onkeydown={(e) => { if (e.key === "Enter") void saveName(); }}');
    expect(rowsFlat).toContain(
      "async function saveName(): Promise<void> { const sent = name; " +
        "if (!sendsName({ value: sent, lastSent, busy: busyName })) return; busyName = true; lastSent = sent; nameLine = null; " +
        "let again = false; try { const outcome = await setFirstName(sent); " +
        'const after = nameAfterSet({ sent, input: name, outcome, stored: appPrefs().firstName ?? "" }); ' +
        "name = after.name; lastSent = after.lastSent; nameLine = after.line; again = after.again; " +
        "} finally { busyName = false; } if (again && !destroyed) void saveName(); }",
    );
  });

  test("round-1 M8: each row has ONE polite live region, ALWAYS drawn, whose text is \"\", \"Saved.\" or the sentence — a refusal is announced as a save is", () => {
    const code = rows.replace(/<!--[\s\S]*?-->/g, "");
    expect(code).toContain(
      '<p class="line" class:bad={nameLine !== null && !nameLine.ok} id="pref-first-name-line" aria-live="polite">{nameLine?.text ?? ""}</p>',
    );
    expect(code).toContain('<p class="line" class:bad={slidesLine !== null && !slidesLine.ok} aria-live="polite">{slidesLine?.text ?? ""}</p>');
    expect(code.match(/aria-live=/g)).toHaveLength(2);
    // Not inside an {#if}: each region is in its row's block, at the block's own level.
    for (const line of code.split("\n").filter((l) => l.includes('aria-live="polite"'))) expect(line.startsWith("    <p ")).toBe(true);
    expect(code).not.toMatch(/\{#if (nameLine|slidesLine)/);
    expect(code).not.toContain('role="status"');
    // The input keeps its description and its invalid state.
    expect(code).toContain('aria-describedby={nameLine !== null ? "pref-first-name-line" : undefined}');
    expect(code).toContain('aria-invalid={nameLine !== null && !nameLine.ok ? "true" : undefined}');
  });

  test("round-1 Q01: `lastSent` starts as the STORED name, so a blur with no edit sends nothing", () => {
    expect(rows).toContain("  const start = appPrefs();\n");
    expect(rows).toContain('  let lastSent = start.firstName ?? "";\n');
    expect(rows.match(/let lastSent = /g)).toHaveLength(1);
    // …and with the stored name as `lastSent`, that blur is no send (prefs-rows.ts's guard).
    expect(sendsName({ value: "Sam", lastSent: "Sam", busy: false })).toBe(false);
  });

  test("the slides control: prefs-rows.ts's decisions, the busy flag, and ONE button (round-3 L6), NEVER disabled (round-4 M2), aria-busy while busy", () => {
    expect(rowsFlat).toContain(
      "async function setSlidesTo(on: boolean): Promise<void> { if (!sendsSlides(busySlides)) return; busySlides = true; " +
        "slidesLine = null; try { const outcome = await setSlides(on); " +
        "const after = slidesAfterSet({ requested: on, outcome, stored: appPrefs().slides }); " +
        "slides = after.slides; slidesLine = after.line; } finally { busySlides = false; } }",
    );
    // Round-3 L6: ONE button whose label and action follow the value, never two swapped by an {#if} (focus stays on it
    // after a set instead of falling to the page).
    expect(rows).toContain('<button aria-busy={busySlides ? "true" : undefined} onclick={() => void setSlidesTo(!slides)}>{slides ? "Turn off" : "Turn on"}</button>');
    // Round-4 M2: a disabled button loses focus in WebKit while the set is in flight; the second click is dropped by
    // `sendsSlides(busySlides)` instead (the handler's first line, pinned above).
    expect(rows.replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(/\bdisabled=/);
    expect(rows).toMatch(/button\[aria-busy="true"\] \{\s*color: var\(--muted\);/);
    expect(rows.split("<button").length - 1).toBe(1);
    expect(rows).not.toMatch(/\{#if slides\}/);
    // The handler, evaluated: it asks for the other value.
    const at = rows.indexOf("onclick={() => void setSlidesTo(!slides)}");
    const expr = rows.slice(at + "onclick={".length, rows.indexOf("}>", at));
    for (const slides of [true, false]) {
      const asked: boolean[] = [];
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      (new Function("setSlidesTo", "slides", `return (${expr});`)((on: boolean) => asked.push(on), slides) as () => void)();
      expect({ slides, asked }).toEqual({ slides, asked: [!slides] });
    }
  });

  test("round-3 M1: PrefsRows is the rows' GATE — a muted Loading… until the store has settled, then the rows; nothing else of D's page changes", () => {
    const gate = src("lib/settings/PrefsRows.svelte");
    const imports = [...gate.matchAll(/^\s*import\s+(?:type\s+)?[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../app-prefs-store", "./PrefsRowsBody.svelte", "./prefs-rows", "svelte"]);
    const flat = gate.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s+/g, " ");
    expect(flat).toContain("let settled = $state(appPrefsSettled());");
    expect(flat).toContain(
      "onMount(() => { settled = appPrefsSettled(); if (settled) return; const stop = onAppPrefsChange(() => { if (appPrefsSettled()) { settled = true; stop(); } }); return stop; });",
    );
    expect(flat).toContain('{#if settled} <PrefsRowsBody initial={seed} /> {:else} <p class="loading">Loading…</p> {/if}');
    expect(gate).toMatch(/\.loading \{\s*margin: 0 0 14px;\s*color: var\(--muted\);/);
  });

  test("Settings.svelte: imports PrefsRows, declares the snippet at the top level, passes it on the self-closing tag", () => {
    const s = src("routes/Settings.svelte");
    expect(s).toContain('  import PrefsRows from "../lib/settings/PrefsRows.svelte";\n');
    const snip = s.indexOf("\n{#snippet prefsRows()}\n  <PrefsRows />\n{/snippet}\n");
    expect(snip).toBeGreaterThan(s.indexOf("</script>"));
    expect(snip).toBeLessThan(s.indexOf('<section class="settings">'));
    expect(s.split("<PrefsRows").length - 1).toBe(1);
    const open = s.indexOf("<SettingsPages");
    const close = s.indexOf("/>", open);
    const tag = s.slice(open, close + 2);
    expect(tag).toContain("\n    {prefsRows}\n");
    expect(tag.slice(1)).not.toContain("<");
    // No children: what follows the self-closing tag is the section's end.
    expect(s.slice(close + 2).trimStart().startsWith("</section>")).toBe(true);
  });

  test("GeneralPage draws prefsRows in the reserved place: after the Updates group, the page's last markup", () => {
    const gp = src("lib/settings/GeneralPage.svelte");
    const at = gp.indexOf("{@render prefsRows?.()}");
    expect(at).toBeGreaterThan(gp.indexOf("<legend><h4>Updates</h4></legend>"));
    expect(gp.slice(at + "{@render prefsRows?.()}".length).trimStart().startsWith("<style>")).toBe(true);
  });
});

describe("changedPages has no app-preference input (pure)", () => {
  // Checkpoint LOW 4: the runtime half (set both preferences, the same input marks no page) could not fail — the
  // input never held them. What can fail is the signature: ONE argument, whose fields are the config state only,
  // from a module that does not read the app-prefs store.
  test("its one input holds the config state only, and pages.ts never reads the app-prefs store", () => {
    const pages = src("lib/settings/pages.ts");
    const body = pages.slice(pages.indexOf("export interface ChangeInput {"), pages.indexOf("\n}\n", pages.indexOf("export interface ChangeInput {")));
    const fields = [...body.matchAll(/^  (\w+)\??:/gm)].map((m) => m[1]);
    expect(fields).toEqual(["tab", "loadedText", "draft", "raw", "flowPending", "writtenOn"]);
    expect(pages).toContain("export function changedPages(input: ChangeInput): PageId[] {");
    expect(changedPages.length).toBe(1);
    expect(pages).not.toContain("app-prefs");
  });
});

/* ── checkpoint MED: the rows' decisions, pure (`src/lib/settings/prefs-rows.ts`) ─────────────────────────────── */

describe("prefs-rows.ts: what each answer does", () => {
  const OK: AppPrefsSetOutcome = { ok: true };
  const REFUSED: AppPrefsSetOutcome = { ok: false, message: TOO_LONG, refused: true };
  const STORE: AppPrefsSetOutcome = { ok: false, message: STORE_FAILURE.detail, refused: false };

  test("a name send goes out only when not busy and the value differs from the last sent", () => {
    expect(sendsName({ value: "Sam", lastSent: "", busy: false })).toBe(true);
    expect(sendsName({ value: "Sam", lastSent: "Sam", busy: false })).toBe(false);
    expect(sendsName({ value: "Sam", lastSent: "", busy: true })).toBe(false);
    expect(sendsName({ value: "", lastSent: "Sam", busy: false })).toBe(true);
  });

  test("saved, no typing meanwhile: the input shows what the store kept (trimmed), and nothing is sent again", () => {
    expect(nameAfterSet({ sent: "  Sam ", input: "  Sam ", outcome: OK, stored: "Sam" })).toEqual({
      name: "Sam",
      lastSent: "Sam",
      line: { ok: true, text: "Saved." },
      again: false,
    });
    // Empty unsets it.
    expect(nameAfterSet({ sent: " ", input: " ", outcome: OK, stored: "" })).toEqual({ name: "", lastSent: "", line: { ok: true, text: "Saved." }, again: false });
  });

  test("LOW 2: saved while the user typed: the newer text is kept, and sent once the set ends", () => {
    const after = nameAfterSet({ sent: "Al", input: "Alex", outcome: OK, stored: "Al" });
    expect(after).toEqual({ name: "Alex", lastSent: "Al", line: { ok: true, text: "Saved." }, again: true });
    // The follow-up send goes out (the component calls saveName again; this is its guard).
    expect(sendsName({ value: after.name, lastSent: after.lastSent, busy: false })).toBe(true);
    // Typed back to what the store kept: kept, and the follow-up sends nothing.
    const same = nameAfterSet({ sent: " Sam", input: "Sam", outcome: OK, stored: "Sam" });
    expect(sendsName({ value: same.name, lastSent: same.lastSent, busy: false })).toBe(false);
  });

  test("refused: the typed value stays, Rust's sentence is the line, and Enter or blur does not resend it", () => {
    const typed = "x".repeat(41);
    const after = nameAfterSet({ sent: typed, input: typed, outcome: REFUSED, stored: "Sam" });
    expect(after).toEqual({ name: typed, lastSent: typed, line: { ok: false, text: TOO_LONG }, again: false });
    expect(sendsName({ value: after.name, lastSent: after.lastSent, busy: false })).toBe(false);
    // Typed meanwhile: the newer text is kept and sent.
    const newer = nameAfterSet({ sent: typed, input: "Sam2", outcome: REFUSED, stored: "Sam" });
    expect(newer).toEqual({ name: "Sam2", lastSent: typed, line: { ok: false, text: TOO_LONG }, again: true });
  });

  test("LOW 3: a store failure keeps the text and its line, and Enter or blur retries without an edit", () => {
    const after = nameAfterSet({ sent: "Alex", input: "Alex", outcome: STORE, stored: "Sam" });
    expect(after).toEqual({ name: "Alex", lastSent: "Sam", line: { ok: false, text: STORE_FAILURE.detail }, again: false });
    expect(sendsName({ value: after.name, lastSent: after.lastSent, busy: false })).toBe(true);
  });

  test("slides: a click goes out only when not busy; the row shows the STORE's value, never the requested one", () => {
    expect(sendsSlides(false)).toBe(true);
    expect(sendsSlides(true)).toBe(false);
    expect(slidesAfterSet({ requested: false, outcome: OK, stored: false })).toEqual({ slides: false, line: { ok: true, text: "Saved." } });
    expect(slidesAfterSet({ requested: false, outcome: STORE, stored: true })).toEqual({
      slides: true,
      line: { ok: false, text: STORE_FAILURE.detail },
    });
    expect(slidesAfterSet({ requested: true, outcome: STORE, stored: false }).slides).toBe(false);
  });
});

/* ── round-3 M1: Settings mounted while the startup load is still in flight ───────────────────── */

describe("round-4 M3 / post-cap M1: a remount waits for a set in flight; the rows never follow the store, so a refused name stays", () => {
  // A test here swaps in an IPC that waits; the recorder comes back after it, for afterEach's own load.
  let recorder: unknown;
  beforeEach(() => (recorder = g.window));
  afterEach(() => {
    g.window = recorder;
  });

  test("post-cap M1: a refused name, then the slides row's set lands — the refused text, its line and aria-invalid all stay", () => {
    // The rows do not follow the store: no subscription in the body, and only saveName ever writes the name or its line.
    const body = src("lib/settings/PrefsRowsBody.svelte");
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("onAppPrefsChange");
    expect(code).not.toContain("onMount");
    const script = code.slice(0, code.indexOf("</script>"));
    const slidesFn = script.slice(script.indexOf("async function setSlidesTo("));
    expect(slidesFn).not.toMatch(/\b(name|lastSent|nameLine) = /);
    // The two answers, as the row applies them: the refusal keeps the typed text and its line; the slides answer that
    // lands next (the store now holds the OLD name) gives the slides row its value and touches nothing of the name row.
    const typed = "x".repeat(41);
    const refused = nameAfterSet({ sent: typed, input: typed, outcome: { ok: false, message: TOO_LONG, refused: true }, stored: "Sam" });
    expect(refused).toEqual({ name: typed, lastSent: typed, line: { ok: false, text: TOO_LONG }, again: false });
    const slidesNext = slidesAfterSet({ requested: false, outcome: { ok: true }, stored: false });
    expect(Object.keys(slidesNext).sort()).toEqual(["line", "slides"]);
  });

  test("scoped-review M1: the rows FLUSH the name when they unmount — typed and unsent, it goes now; unchanged, or refused on screen, nothing goes", () => {
    // Typed meanwhile ("Al" in flight, "Alex" in the input): flushed.
    expect(flushesOnUnmount({ name: "Alex", lastSent: "Al", line: null })).toBe(true);
    // Typed and never blurred, the store's name in lastSent: flushed.
    expect(flushesOnUnmount({ name: "Sam B", lastSent: "Sam", line: { ok: true, text: "Saved." } })).toBe(true);
    // Unchanged: nothing.
    expect(flushesOnUnmount({ name: "Sam", lastSent: "Sam", line: null })).toBe(false);
    // A refused name on screen (it is lastSent too): nothing; nor with a failure line up.
    const typed = "x".repeat(41);
    expect(flushesOnUnmount({ name: typed, lastSent: typed, line: { ok: false, text: TOO_LONG } })).toBe(false);
    expect(flushesOnUnmount({ name: "Alex", lastSent: "Sam", line: { ok: false, text: STORE_FAILURE.detail } })).toBe(false);
    // Wired: on destroy, mark destroyed and flush through the store; a follow-up queued by an answer never runs after.
    const body = src("lib/settings/PrefsRowsBody.svelte").replace(/^\s*\/\/.*$/gm, "").replace(/\s+/g, " ");
    expect(body).toContain("onDestroy(() => { destroyed = true; if (flushesOnUnmount({ name, lastSent, line: nameLine })) void setFirstName(name); });");
    expect(body).toContain("if (again && !destroyed) void saveName();");
  });

  test("scoped-review M1, the chained case: \"Al\" in flight, \"Alex\" typed, Settings left (flushed) and reopened — the new rows wait for BOTH and show \"Alex\"", async () => {
    await seed({ firstName: "Sam", slides: true });
    const answers: ((v: unknown) => void)[] = [];
    g.window = { __TAURI_INTERNALS__: { invoke: () => new Promise((resolve) => answers.push(resolve)) } };
    const first = setFirstName("Al");   // the old rows' save, in flight
    // The old rows unmount with "Alex" typed: flushesOnUnmount says send it now (what onDestroy does).
    expect(flushesOnUnmount({ name: "Alex", lastSent: "Al", line: null })).toBe(true);
    const flushed = setFirstName("Alex");
    expect(html()).toContain("Loading…");   // the reopened Settings
    answers[0]!({ firstName: "Al", slides: true, revision: undefined });   // "Al" lands first
    await first;
    expect(html()).toContain("Loading…");   // "Alex" still in flight: the gate still waits
    answers[1]!({ firstName: "Alex", slides: true });
    await flushed;
    const after = html();
    expect(after).not.toContain("Loading…");
    expect(after).toMatch(/<input id="pref-first-name" type="text"[^>]* value="Alex"/);
    expect(appPrefs().firstName).toBe("Alex");
  });

  test("Settings reopened while an earlier visit's set is in flight: Loading…, then the rows with the value that set saved", async () => {
    await seed({ firstName: "Sam", slides: true });
    let answer: (v: unknown) => void = () => {};
    g.window = { __TAURI_INTERNALS__: { invoke: () => new Promise((resolve) => (answer = resolve)) } };
    const pending = setSlides(false);   // the earlier visit's Turn off, still in flight
    const during = html();   // the new visit's rows
    expect(during).toContain("Loading…");
    expect(during).not.toContain("Turn off");
    answer({ firstName: "Sam", slides: false });   // no revision: the store's is process-wide (file-order independence)
    await pending;
    const after = html();
    expect(after).not.toContain("Loading…");
    expect(after).toMatch(/<button[^>]*>Turn on<\/button>/);
    expect(after).toContain("Today shows the whole briefing on one page, the classic view.");
  });
});

describe("round-3 M1: the rows wait for the store (a delayed load)", () => {
  // Each test swaps in an IPC that waits; the recorder comes back after it, for afterEach's own load.
  let recorder: unknown;
  beforeEach(() => (recorder = g.window));
  afterEach(() => {
    g.window = recorder;
  });

  test("drawn while app_prefs_get is in flight: Loading…, no rows, no defaults; once it settles: the STORED values", async () => {
    let answer: (v: unknown) => void = () => {};
    g.window = {
      __TAURI_INTERNALS__: {
        invoke: (command: string) => {
          calls.push([command, undefined]);
          return new Promise((resolve) => (answer = resolve));
        },
      },
    };
    const load = loadAppPrefs();
    const during = html();
    expect(during).toMatch(/<p class="loading">Loading…<\/p>/);
    expect(during).not.toContain("pref-first-name");
    expect(during).not.toContain("Turn off");
    answer({ firstName: "Sam", slides: false });
    await load;
    const after = html();
    expect(after).not.toContain("Loading…");
    expect(after).toMatch(/<input id="pref-first-name" type="text"[^>]* value="Sam"/);
    expect(after).toMatch(/<button[^>]*>Turn on<\/button>/);
  });

  test("a FAILED load settles too: the rows draw the defaults and the one failure line, never Loading… for ever", async () => {
    let fail: (e: unknown) => void = () => {};
    g.window = { __TAURI_INTERNALS__: { invoke: () => new Promise((_, reject) => (fail = reject)) } };
    const load = loadAppPrefs();
    expect(html()).toContain("Loading…");
    fail(STORE_FAILURE);
    await load;
    const after = html();
    expect(after).not.toContain("Loading…");
    expect(badLines(after)).toEqual([`Your app preferences could not be read, so the defaults are in use: ${STORE_FAILURE.detail}`]);
  });
});
