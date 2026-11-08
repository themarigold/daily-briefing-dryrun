/**
 * Redesign D — the final small fix, after the post-cap scoped review (user-directed 2026-10-22: one small fix that
 * REMOVES the races rather than handling them more cleverly). Its own file, so the Calendar restyle built beside it
 * (which may move pins into `settings-pages.check.ts`) merges without a conflict here.
 *
 * Server-side only, like every `tests-web` file: the decisions are pure functions tested by value, and each call site
 * is pinned by its source text. The behaviour in a browser is the probes' (the PR body's "Final small fix" table).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { render } from "svelte/server";

import AdvancedPage from "../src/lib/settings/AdvancedPage.svelte";
import { afterLanded, rawFromDraft, type Draft, type Edit } from "../src/lib/settings-model";
import { describeFailure, settingsSaveRefusal } from "../src/lib/files";
import { JSON_SAVING_LINE, jsonEditorReadOnly, loadResets, owedAfterLoad, owedReloadRuns } from "../src/lib/settings/pages";

/** A source file with its whitespace collapsed, as the other wiring pins read it. */
const src = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\s+/g, " ");
/** `code` from `start` up to the next `next` after it; refuses (throws) when either is missing, so a pin read from a
 *  slice can never pass on an empty one. */
const between = (code: string, start: string, next: string): string => {
  const a = code.indexOf(start);
  const b = a < 0 ? -1 : code.indexOf(next, a + start.length);
  if (a < 0 || b < 0) throw new Error(`not found: ${a < 0 ? start : next}`);
  return code.slice(a, b);
};

describe("F1: a save that landed never resets a field refused while it was in flight", () => {
  test("loadResets: a load the user asked for makes the user's resets; the reload after a landed save makes none", () => {
    expect(loadResets(false)).toBe(true);
    expect(loadResets(true)).toBe(false);
  });

  test("wiring: load asks loadResets with whether a save landed, and resets the marks and the errors only on its yes", () => {
    const load = between(src("routes/Settings.svelte"), "async function load(", "onMount(() => {");
    // Round 10 (M1): and "Other…" closes with them (the tool rows' choice is the shell's); round 11 (M1): the note goes.
    expect(load).toContain("if (kept === null) { draw(next); if (loadResets(landed !== null)) { redraw = redrawAfterReset(redraw); errors = {}; toolRows = { ...toolRows, other: false, note: null }; }");
    // Round 11 (M1, delta LOW): a landed save — kept edit or not — drops the note and closes Other unless the user is
    // typing in the tool rows (`toolRowsAfterSave`); it resets no mark and no error.
    expect(load).toContain("if (landed !== null) toolRows = toolRowsAfterSave(toolRows, typingInToolRows(), landed.at); } catch (e) {");
    expect(load.match(/toolRows = /g)?.length).toBe(2);
    // The only resets in load are those two, under that guard.
    expect(load.match(/redraw = /g)?.length).toBe(1);
    expect(load.match(/errors = /g)?.length).toBe(1);
  });
});

describe("F2: while any save is in flight the JSON editor is read-only, so nothing typed there is lost or undoes it", () => {
  test("jsonEditorReadOnly: a save of the one save path (the bar's, an Add's, a key action's) or a Replace's Save, its wait included", () => {
    expect(jsonEditorReadOnly({ saving: false, replaceSaving: false })).toBe(false);
    expect(jsonEditorReadOnly({ saving: true, replaceSaving: false })).toBe(true);
    expect(jsonEditorReadOnly({ saving: false, replaceSaving: true })).toBe(true);
    expect(jsonEditorReadOnly({ saving: true, replaceSaving: true })).toBe(true);
    expect(JSON_SAVING_LINE).toBe("Saving — you can edit again when it finishes.");
  });

  const advanced = (readOnly: boolean): string =>
    render(AdvancedPage, {
      props: { form: null, tab: "raw", config: "ready", raw: "{}", onopenjson: () => {}, apiKeyRedacted: false, os: "mac", readOnly },
    }).body;

  test("AdvancedPage: read-only, the textarea says so (readonly, not disabled: it keeps the focus, the selection and the scroll) and one line says why", () => {
    const locked = advanced(true);
    expect(locked).toMatch(/<textarea id="raw-config"[^>]* readonly[^>]* aria-describedby="raw-saving"/);
    expect(locked).not.toMatch(/<textarea[^>]* disabled/);
    expect(locked).toMatch(new RegExp(`<p class="muted saving svelte-[a-z0-9]+" id="raw-saving">${JSON_SAVING_LINE}</p>`));
    const open = advanced(false);
    expect(open).toMatch(/<textarea id="raw-config"/);
    expect(open).not.toMatch(/<textarea[^>]* readonly/);
    expect(open).not.toContain("aria-describedby");
    expect(open).not.toContain(JSON_SAVING_LINE);
  });

  test("wiring: the shell decides it from `saving` and the Replace's Save (a $state), and hands it down to the textarea", () => {
    const shell = src("routes/Settings.svelte");
    expect(shell).toContain("const jsonReadOnly = $derived(jsonEditorReadOnly({ saving, replaceSaving: replaceSaving !== null }));");
    expect(shell).toContain("let replaceSaving = $state.raw<Promise<ReplaceSaveResult> | null>(null);");
    // Set as the Replace's Save starts (its wait on a running briefing included), cleared when it ends.
    expect(between(shell, "const run = saveReplace(p, next.text, {", "const result = await run;")).toMatch(/\}\); replaceSaving = run; $/);
    expect(shell).toContain("if (replaceSaving === run) replaceSaving = null;");
    // The declaration, the set and the clear: nothing else writes it.
    expect(shell.match(/replaceSaving = /g)?.length).toBe(3);
    expect(between(shell, "<SettingsPages", "/>")).toContain("{jsonReadOnly}");
    const pages = src("lib/settings/SettingsPages.svelte");
    expect(pages).toContain("jsonReadOnly: boolean;");
    expect(between(pages, "<AdvancedPage", "/>")).toContain("readOnly={jsonReadOnly}");
    expect(src("lib/settings/AdvancedPage.svelte")).toContain("readOnly: boolean;");
  });

  // The editor opened (read-only) while the save was in flight, after the user changed the FORM meanwhile: its text is
  // the form's draft (it cannot be typed in), so the landing carries that draft onto the text saved, as for the form,
  // and the editor shows the result — an Add's provider is not dropped by the next Save.
  const BASE: Draft = { repos: ["~/a"], provider: { cli: "claude", argv: ["-p"] }, lookbackCapDays: 4 };
  const doc = (text: string) => ({ path: "/c", exists: true, text, base: "b2", parseError: null, apiKeyRedacted: false });
  const candidate: Draft = { ...BASE, fallbacks: [{ label: "second", api: { kind: "anthropic", model: "x" } }] };
  const sent = { base: "b1", text: rawFromDraft(candidate) };
  const from: Edit = { tab: "form", draft: BASE, raw: "" };

  test("afterLanded: the editor opened during the flight over a form edit — the edit goes onto the saved text, and the editor shows it", () => {
    const edited: Draft = { ...BASE, lookbackCapDays: 6 };
    const kept = afterLanded(sent, from, { tab: "raw", draft: edited, raw: rawFromDraft(edited) }, doc(sent.text));
    expect(kept?.draft).toEqual({ ...candidate, lookbackCapDays: 6 });
    expect(kept?.raw).toBe(rawFromDraft({ ...candidate, lookbackCapDays: 6 }));
    // Nothing edited in the form: the file, drawn (null).
    expect(afterLanded(sent, from, { tab: "raw", draft: BASE, raw: rawFromDraft(BASE) }, doc(sent.text))).toBeNull();
    // The editor's own save, its text untouched in flight: the file (null) — typing there is not possible now.
    expect(afterLanded(sent, { tab: "raw", draft: null, raw: sent.text }, { tab: "raw", draft: null, raw: sent.text }, doc(sent.text))).toBeNull();
  });
});

describe("F3: an owed reload never runs while the JSON editor is open", () => {
  test("owedReloadRuns: on the form, once the draft is clean and no save runs; never with the editor open — it runs when the editor is left", () => {
    expect(owedReloadRuns(true, { editing: false, saving: false, tab: "form" })).toBe(true);
    // A keystroke that makes the editor's text equal the file made the screen clean and ran the reload, which rewrote
    // the text under the caret (delta, midtype): with the editor open it waits.
    expect(owedReloadRuns(true, { editing: false, saving: false, tab: "raw" })).toBe(false);
    expect(owedReloadRuns(true, { editing: true, saving: false, tab: "form" })).toBe(false);
    expect(owedReloadRuns(true, { editing: false, saving: true, tab: "form" })).toBe(false);
    expect(owedReloadRuns(false, { editing: false, saving: false, tab: "form" })).toBe(false);
  });

  test("wiring: the effect passes the shell's own tab, so leaving the editor (the tab back to the form) runs what is owed", () => {
    expect(src("routes/Settings.svelte")).toContain("$effect(() => { if (owedReloadRuns(reloadOwed, { editing, saving, tab })) void backgroundReload(); });");
  });
});

describe("Tiny fix T1: a conflict refused on a clean draft loads the file at once, the JSON editor open or not", () => {
  test("wiring: submit notes a conflict on a clean draft and, the save over, runs the reload itself — so its line's \"It is loaded again now\" is true with the editor open", () => {
    // Before, the reload was only owed, and with the editor open (F3) nothing ran it: the line said the file was
    // loaded again while the editor still showed the old text (delta MED-1, `f3-conflict.cjs`). The editor was
    // read-only for the whole save (F2), so nothing typed there can be lost.
    const submit = between(src("routes/Settings.svelte"), "async function submit(", "/** The form's Save");
    expect(submit).toContain("let reloadNow = false; try {");
    expect(between(submit, "} catch (e) {", "} finally {")).toContain(
      "failure = refused.line; if (refused.reload) { reloadOwed = true; conflictShown = refused; reloadNow = !editing; }",
    );
    // After `saving = false` (a reload asked while a save runs is only owed), and not once the screen was left.
    expect(between(submit, "} finally {", "return answered")).toMatch(
      /^\} finally \{ saving = false; .*settleKeptSettings\(sent, answered\); if \(reloadNow && !left\) void backgroundReload\(\); \} $/,
    );
    expect(src("routes/Settings.svelte").match(/void backgroundReload\(\)/g)?.length).toBe(3);
  });

  test("F3 stands: an owed reload still never runs on its own while the editor is open (nothing typed there is rewritten)", () => {
    expect(owedReloadRuns(true, { editing: false, saving: false, tab: "raw" })).toBe(false);
    expect(src("routes/Settings.svelte")).toContain("$effect(() => { if (owedReloadRuns(reloadOwed, { editing, saving, tab })) void backgroundReload(); });");
  });
});

describe("F4: the refused Save's reveal brings the whole field into view — the control and its error — then focuses the control", () => {
  test("show: the field (control and error) is scrolled into view, not the error alone (which left the control above the window)", () => {
    const pages = src("lib/settings/SettingsPages.svelte");
    expect(between(pages, 'if (r.target === "field") {', "const title = ")).toBe(
      // User-directed 2026-10-22 (P-A): a field in a closed row (AI providers' row 1) opens that row first.
      "if (r.target === \"field\") { const field = box.querySelector(\".field-error\")?.closest(\".field\"); const control = field?.querySelector('[id^=\"f-\"]'); if (field instanceof HTMLElement && control instanceof HTMLElement) { const closed = field.closest(\"[hidden][id]\"); const head = closed === null ? null : box.querySelector(`[aria-controls=\"${closed.id}\"][aria-expanded=\"false\"]`); if (head instanceof HTMLElement) { head.click(); void tick().then(() => { field.scrollIntoView({ block: \"nearest\" }); control.focus({ preventScroll: true }); }); return; } field.scrollIntoView({ block: \"nearest\" }); control.focus({ preventScroll: true }); return; } } ",
    );
    expect(pages).not.toContain("error.scrollIntoView(");
  });

  test("the field keeps the dock's height clear below it, as the controls and errors do", () => {
    const pagesSrc = readFileSync(new URL("../src/lib/settings/SettingsPages.svelte", import.meta.url), "utf8");
    const css = pagesSrc.slice(pagesSrc.indexOf("<style>")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
    expect(css).toContain("[data-page] :global(:is(input, select, textarea, button, .field, .field-error)) { scroll-margin-bottom: var(--dock-clear, 64px); }");
  });
});

describe("The LOWs: the conflict's words, and what a reload owes", () => {
  const conflict = { kind: "conflict", path: "/c/config.json" };
  const changed = "Not saved: /c/config.json changed on disk after it was loaded.";

  test("settingsSaveRefusal: an Add's or Replace's conflict on a clean draft says what works — Save again, which tests it first, then Save once more (tiny fix, delta L1)", () => {
    expect(settingsSaveRefusal(conflict, { editing: false, flow: true })).toEqual({
      line: `${changed} It is loaded again now: Save again: it tests the provider first, then Save once more.`,
      reload: true,
      loaded: `${changed} It is loaded again now: Save again: it tests the provider first, then Save once more.`,
    });
    // A key action on a clean draft (no flow): the change is made again.
    expect(settingsSaveRefusal(conflict, { editing: false, flow: false })).toEqual({
      line: `${changed} It is loaded again now: make the change again.`,
      reload: true,
      loaded: `${changed} It is loaded again now: make the change again.`,
    });
  });

  test("settingsSaveRefusal: over an unsaved edit it points at Discard; once the owed reload has drawn the file, the words say it is loaded", () => {
    expect(settingsSaveRefusal(conflict, { editing: true, flow: false })).toEqual({
      line: `${changed} Discard to load it, then make the change again.`,
      reload: true,
      loaded: `${changed} It is loaded again now: make the change again.`,
    });
    expect(settingsSaveRefusal(conflict, { editing: true, flow: true })).toEqual({
      line: `${changed} Discard to load it, then make the change again.`,
      reload: true,
      loaded: `${changed} It is loaded again now: Save again: it tests the provider first, then Save once more.`,
    });
    // Any other refusal: describeFailure's words, nothing owed, nothing to change.
    for (const e of [{ kind: "write", path: "/c", detail: "EACCES" }, new Error("x")]) {
      const d = describeFailure(e);
      expect(settingsSaveRefusal(e, { editing: true, flow: true })).toEqual({ line: d, reload: false, loaded: d });
    }
  });

  test("wiring: submit tells it whether a flow is pending; the owed reload, once it draws the file, swaps a conflict line still shown for its loaded words", () => {
    const shell = src("routes/Settings.svelte");
    expect(between(shell, "} catch (e) {", "} finally { saving = false;")).toContain(
      "const refused = settingsSaveRefusal(e, { editing, flow: pendingFlow !== null }); failure = refused.line; if (refused.reload) { reloadOwed = true; conflictShown = refused; reloadNow = !editing; }",
    );
    expect(between(shell, "async function backgroundReload()", "$effect(() => {")).toContain(
      "restored = false; draw(next); if (conflictShown !== null && failure === conflictShown.line) failure = conflictShown.loaded; conflictShown = null;",
    );
    // Set by the refusal, cleared by the reload that drew the file: nothing else writes it.
    expect(shell.match(/conflictShown = /g)?.length).toBe(2);
  });

  test("owedAfterLoad: a user load pays an owed reload only when no background write arrived after its read started", () => {
    expect(owedAfterLoad(false, 3, 3)).toBe(false);
    expect(owedAfterLoad(false, 3, 4)).toBe(true);
    // The kept edit's own reason (another write between the save and its read) stands either way.
    expect(owedAfterLoad(true, 3, 3)).toBe(true);
    expect(owedAfterLoad(true, 3, 5)).toBe(true);
  });

  test("wiring: each background reload asked is counted as it starts (a write's, or an owed one), and load reads the count before its read", () => {
    const shell = src("routes/Settings.svelte");
    // (Counted in `backgroundReload`, not in `calendarChangedConfig`, which `calendar.check.ts` pins whole.)
    expect(shell).toContain("async function backgroundReload(): Promise<void> { backgroundReloads += 1; const asked = screenStamp();");
    expect(shell).toContain("let backgroundReloads = 0;");
    expect(shell.match(/backgroundReloads \+= 1/g)?.length).toBe(1);
    const load = between(shell, "async function load(", "onMount(() => {");
    expect(load).toContain("restored = false; const asks = backgroundReloads; try { const next = await configRead();");
    expect(load).toContain("reloadOwed = owedAfterLoad(false, asks, backgroundReloads); } else {");
    expect(load).toContain("reloadOwed = owedAfterLoad(kept.doc !== next, asks, backgroundReloads); }");
  });

  test("wiring: a kept edit restored from an earlier visit owes the reload when the file moved on meanwhile", () => {
    const mount = between(src("routes/Settings.svelte"), "onMount(() => {", "onDestroy(() => {");
    expect(mount).toContain("draft = k.draft; raw = k.raw; restored = true; reloadOwed = next.base !== k.base; openInitial(k);");
  });

  test("wiring: a background read that fails while the screen changed owes the reload rather than hide the edit behind the failure", () => {
    expect(between(src("routes/Settings.svelte"), "async function backgroundReload()", "$effect(() => {")).toContain(
      "} catch (e) { if (!backgroundReloadApplies(asked, screenStamp())) { reloadOwed = true; return; } loadFailure = describeFailure(e); return; }",
    );
  });
});

describe("Test gaps (rebase survivors B6 and B7)", () => {
  const doc = (text: string) => ({ path: "/c", exists: true, text, base: "b2", parseError: null, apiKeyRedacted: false });
  const at: Draft = { repos: ["~/a"], provider: { cli: "claude", argv: ["-p"] }, lookbackCapDays: 4 };
  const form = (draft: Draft): Edit => ({ tab: "form", draft, raw: "" });

  test("B7: the edit sent from has no `fallbacks` and the save (an Add) added them: the kept draft keeps them", () => {
    const candidate: Draft = { ...at, fallbacks: [{ label: "second", api: { kind: "anthropic", model: "x" } }] };
    const sent = { base: "b1", text: rawFromDraft(candidate) };
    const kept = afterLanded(sent, form(at), form({ ...at, lookbackCapDays: 6 }), doc(sent.text));
    expect(kept?.draft).toEqual({ ...candidate, lookbackCapDays: 6 });
  });

  test("B6: a top-level key neither the edit sent from nor the save had, added in flight, is kept", () => {
    const sent = { base: "b1", text: rawFromDraft(at) };
    const kept = afterLanded(sent, form({ ...at, lookbackCapDays: 5 }), form({ ...at, lookbackCapDays: 5, morningTime: "08:00" }), doc(sent.text));
    expect(kept).not.toBeNull();
    expect(kept!.draft).toEqual({ ...at, morningTime: "08:00" });
  });
});
