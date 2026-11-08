/**
 * Redesign D — Settings as a sidebar of seven pages: the pure page logic (`gui/src/lib/settings/pages.ts`).
 *
 * `tests-web` renders on the server only, with no DOM and no events, so what the sidebar DOES — which page a field
 * is on, which pages are changed or need a look, the JSON editor's leave guard, the page a mount opens — is a pure
 * model, tested here directly (D spec "Tests", hub testing rule 4). One test per pure bullet of the D spec's
 * "New checks".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { describeFailure, settingsSaveRefusal } from "../src/lib/files";
import { createRawSnippet } from "svelte";
import { parse as parseSvelte } from "svelte/compiler";
import { render } from "svelte/server";

import CalendarSettings from "../src/lib/CalendarSettings.svelte";
import ProvidersList from "../src/lib/ProvidersList.svelte";
import AboutPage from "../src/lib/settings/AboutPage.svelte";
import EditorLinksPage from "../src/lib/settings/EditorLinksPage.svelte";
import GeneralPage from "../src/lib/settings/GeneralPage.svelte";
import SaveBar from "../src/lib/settings/SaveBar.svelte";
import SettingsPages from "../src/lib/settings/SettingsPages.svelte";

import type { UninstallReport } from "../src/lib/app-uninstall";
import {
  afterLanded,
  formSubmission,
  moveProvider,
  providersView,
  rawFromDraft,
  readField,
  remedyFor,
  removeProvider,
  removeStoredApiKey,
  SECTIONS,
  sectionKey,
  setLoginFolder,
  setPath,
  TEST_FAILED_PREFIX,
  testResultLines,
  writeField,
  type Draft,
  type Edit,
  type ProvidersView,
  type StatusProviderRow,
} from "../src/lib/settings-model";
import {
  attentionPages,
  backgroundReloadApplies,
  owedReloadRuns,
  type ScreenStamp,
  blockedPages,
  changedPages,
  configLoadFailed,
  configState,
  initialPage,
  lastShownReport,
  leaveJson,
  navigate,
  CONFIG_UNAVAILABLE_LINE,
  PAGES,
  RAW_TAB_LINE,
  rememberedPage,
  rememberPage,
  rememberShownReport,
  hasOutcome,
  keepClearScrolls,
  revealStillWanted,
  revealTakesFocus,
  shownFocus,
  nextReveal,
  fieldEdited,
  NO_REDRAW,
  NO_REVEAL,
  NO_TOOL_ROWS,
  revealFor,
  redrawAfterDefault,
  redrawAfterField,
  redrawAfterReset,
  saveBarShown,
  type ChangeInput,
  type PageId,
} from "../src/lib/settings/pages";
import { resetTodayStoreForTests, todayStore } from "../src/lib/today-store";
import { summaryStatusFromStatus } from "../src/lib/today";
import { draftFromConfig, emptyDraft, mergeConfig } from "../src/lib/wizard";

// PB-M6-T1 / plan §0.6: CalendarSettings and CalendarPage read the Today store (the Settings lock), so every test starts
// from a fresh store and ends with no write in flight and no flow running.
beforeEach(() => {
  resetTodayStoreForTests();
});
afterEach(() => {
  expect(todayStore().writesInFlight).toBe(0);
  expect(todayStore().flow.running).toBeNull();
});

const parse = (s: string): Draft => JSON.parse(s) as Draft;
const text = (d: unknown): string => JSON.stringify(d, null, 2);

/** A command-line item 1 with one API fallback, plus a field on every config page and some paths no field owns. */
const BASE = {
  repos: ["~/code/alpha"],
  author: { names: ["X Example"], emails: [] },
  provider: { cli: "claude", argv: ["-p"], promptVia: "stdin", timeoutMs: 600000 },
  fallbacks: [{ label: "backup", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }],
  lookbackCapDays: 4,
  morningTime: "07:20",
  notify: "off",
  updateCheck: { enabled: false },
  transcripts: { enabled: false },
};
const LOADED = text(BASE);
/** An API item 1 holding a literal key, for the stored-key removal. */
const WITH_KEY = text({ ...BASE, provider: { api: { kind: "anthropic", model: "m", apiKey: "sk-literal-in-the-file" } }, fallbacks: undefined });

const form = (draft: Draft | null, loadedText: string | null = LOADED, flowPending = false): ChangeInput => ({
  tab: "form",
  loadedText,
  draft,
  raw: loadedText ?? "",
  flowPending,
});
const raw = (rawText: string, loadedText: string = LOADED, flowPending = false): ChangeInput => ({
  tab: "raw",
  loadedText,
  draft: parse(loadedText),
  raw: rawText,
  flowPending,
});
/** The loaded draft with one edit applied. */
const edited = (edit: (d: Draft) => unknown, from: string = LOADED): Draft => {
  const d = parse(from);
  edit(d);
  return d;
};

describe("PAGES: seven entries, a More divider before the last two, every one shown", () => {
  test("the ids and labels in the sidebar's order", () => {
    expect(PAGES.map((p) => [p.id, p.label])).toEqual([
      ["general", "General"],
      ["projects", "Projects"],
      ["providers", "AI providers"],
      ["calendar", "Calendar"],
      ["editor", "Editor & links"],
      ["advanced", "Advanced"],
      ["about", "About & uninstall"],
    ]);
  });

  test("the More divider sits before Advanced and About; B2-M6-T16: Editor & links has content now, so no page is hidden", () => {
    expect(PAGES.filter((p) => p.more).map((p) => p.id)).toEqual(["advanced", "about"]);
    expect(PAGES.filter((p) => p.hidden).map((p) => p.id)).toEqual([]);
  });
});

// Final round 1 (L7): `fieldPage` had no caller in gui/src and is gone. Which page each field is on, and that it is on
// exactly one, is `settings.check.ts`'s D-M1-T1 test, computed from SECTIONS.

describe("changedPages: the per-page map against parseDraft(loadedText)", () => {
  test("a clean draft marks nothing", () => {
    expect(changedPages(form(parse(LOADED)))).toEqual([]);
    // A draft spelled differently but equal as JSON values is clean too.
    expect(changedPages(form(parse(LOADED), JSON.stringify(BASE)))).toEqual([]);
  });

  test("each model field marks the page its section names, provider fields on Advanced included", () => {
    const cases: [string[], unknown, string][] = [
      [["morningTime"], "08:00", "general"],
      [["lookbackCapDays"], 9, "general"],
      [["updateCheck", "enabled"], true, "general"],
      [["repos"], ["~/code/beta"], "projects"],
      [["author", "emails"], ["x@example.invalid"], "projects"],
      [["provider", "cli"], "codex", "providers"],
      [["provider", "timeoutMs"], 900000, "advanced"],
      [["provider", "argv"], ["-p", "--model", "opus"], "advanced"],
      [["notify"], "auto", "advanced"],
    ];
    for (const [path, value, page] of cases) {
      const pages = changedPages(form(edited((d) => setPath(d, path, value))));
      expect({ path: path.join("."), pages }).toEqual({ path: path.join("."), pages: [page] });
    }
    // Two pages at once come back in the sidebar's order.
    const both = edited((d) => {
      setPath(d, ["provider", "timeoutMs"], 1);
      setPath(d, ["repos"], []);
    });
    expect(changedPages(form(both))).toEqual(["projects", "advanced"]);
  });

  test("the list's own paths mark only AI providers: label, logins, login folder, fallbacks, the stored key", () => {
    const cases: [string, Draft, string][] = [
      ["provider.label", edited((d) => setPath(d, ["provider", "label"], "main")), LOADED],
      ["provider.accounts", edited((d) => setPath(d, ["provider", "accounts"], [{ label: "main" }, { label: "two", configDir: "~/.c2" }])), LOADED],
      ["provider.configDir", edited((d) => expect(setLoginFolder(d, "default", "~/.claude-other")).toBeNull()), LOADED],
      ["fallbacks", edited((d) => expect(removeProvider(d, "backup")).toBeNull()), LOADED],
      ["provider.api.apiKey", edited((d) => removeStoredApiKey(d), WITH_KEY), WITH_KEY],
    ];
    for (const [what, draft, loadedText] of cases) {
      expect({ what, pages: changedPages(form(draft, loadedText)) }).toEqual({ what, pages: ["providers"] });
    }
  });

  test("a row-1 move or removal, which replaces `provider` wholesale, marks only AI providers", () => {
    // Moving row 1 down changes `provider.argv` and `provider.timeoutMs` (Advanced's fields) as well as the list:
    // the list's entries differ, so every `provider.*` difference is AI providers'.
    const moved = edited((d) => expect(moveProvider(d, 0, 1)).toBeNull());
    expect(moved.provider).not.toEqual(BASE.provider);
    expect(changedPages(form(moved))).toEqual(["providers"]);
    const removed = edited((d) => expect(removeProvider(d, "default")).toBeNull());
    expect(changedPages(form(removed))).toEqual(["providers"]);
  });

  test("a row-1 move beside an edit outside `provider` still marks that edit's own page", () => {
    const both = edited((d) => {
      expect(moveProvider(d, 0, 1)).toBeNull();
      setPath(d, ["morningTime"], "08:00");
    });
    expect(changedPages(form(both))).toEqual(["general", "providers"]);
  });

  test("a container removed or replaced whole marks the pages of the fields inside it", () => {
    expect(changedPages(form(edited((d) => delete d["author"])))).toEqual(["projects"]);
    expect(changedPages(form(edited((d) => setPath(d, ["author"], "x"))))).toEqual(["projects"]);
    expect(changedPages(form(edited((d) => delete d["updateCheck"])))).toEqual(["general"]);
    // A type change with no field value behind it on either side marks the pages of the fields below that path:
    // here Advanced, through its field `tokenBudget.maxChars` (not the unowned-path fallback).
    const empty = text({ ...BASE, tokenBudget: {} });
    expect(changedPages(form(edited((d) => setPath(d, ["tokenBudget"], "x"), empty), empty))).toEqual(["advanced"]);
  });

  test("a field typed then cleared leaves its emptied parent behind: that marks the field's page, not Advanced", () => {
    // `setPath` creates a missing parent and `deletePath` keeps an emptied one, so on a config with no `author` or
    // `updateCheck`, typing a value and clearing it leaves `{}` where nothing was.
    const bare: Record<string, unknown> = { ...BASE };
    delete bare["author"];
    delete bare["updateCheck"];
    const loaded = text(bare);
    const fieldOf = (id: string) => SECTIONS.flatMap((s) => s.fields).find((f) => f.id === id)!;
    for (const [id, value, page] of [
      ["author.names", "Sam", "projects"],
      ["updateCheck.enabled", "true", "general"],
    ] as const) {
      const d = parse(loaded);
      expect(writeField(d, fieldOf(id), value)).toBeNull();
      expect(writeField(d, fieldOf(id), "")).toBeNull();
      expect({ id, left: d[id.split(".")[0]!] }).toEqual({ id, left: {} });
      expect({ id, pages: changedPages(form(d, loaded)) }).toEqual({ id, pages: [page] });
    }
    // A difference INSIDE a field's value (a hand-written object where the field expects a list, reachable through
    // the JSON editor) is that field's page too, not the unowned-path fallback.
    const odd = text({ ...BASE, author: { names: { first: "X" }, emails: [] } });
    expect(changedPages(form(edited((d) => setPath(d, ["author", "names", "first"], "Y"), odd), odd))).toEqual(["projects"]);
    // The same, written directly: an empty `author` or `updateCheck` against an absent one.
    expect(changedPages(form(parse(text({ ...bare, author: {} })), loaded))).toEqual(["projects"]);
    expect(changedPages(form(parse(text({ ...bare, updateCheck: {} })), loaded))).toEqual(["general"]);
  });

  test("a path no field owns marks Advanced: transcripts, verdictPaths, recapCampaigns, calendar, an unknown key", () => {
    const cases: [string, (d: Draft) => void][] = [
      ["transcripts", (d) => setPath(d, ["transcripts", "enabled"], true)],
      ["verdictPaths", (d) => setPath(d, ["verdictPaths"], ["~/notes"])],
      ["recapCampaigns", (d) => setPath(d, ["recapCampaigns"], [{ name: "q4" }])],
      ["calendar", (d) => setPath(d, ["calendar"], { sources: [] })],
      ["an unknown top-level key", (d) => setPath(d, ["x-unknown"], 1)],
      ["an unknown key inside provider, the list unchanged", (d) => setPath(d, ["provider", "x-extra"], { kept: true })],
      ["a removed key", (d) => delete d["transcripts"]],
    ];
    for (const [what, edit] of cases) {
      expect({ what, pages: changedPages(form(edited(edit))) }).toEqual({ what, pages: ["advanced"] });
    }
  });

  test("with the JSON editor open, only Advanced can be marked, and only when isDirty's raw branch is true", () => {
    // Reformatted but equal text: not a change.
    expect(changedPages(raw(JSON.stringify(BASE)))).toEqual([]);
    // A Briefing field changed in the text marks Advanced, not General.
    expect(changedPages(raw(text({ ...BASE, morningTime: "08:00" })))).toEqual(["advanced"]);
    // Unparseable text that differs from the loaded text is a change.
    expect(changedPages(raw("{ not json"))).toEqual(["advanced"]);
    // A pending flow marks nothing while the editor is open, and a stale draft is not read.
    expect(changedPages(raw(LOADED, LOADED, true))).toEqual([]);
    // Final round 1 (T-L): changed text with a pending flow marks only Advanced, not AI providers too.
    expect(changedPages(raw("{ not json", LOADED, true))).toEqual(["advanced"]);
    expect(changedPages({ ...raw(LOADED), draft: edited((d) => setPath(d, ["repos"], [])) })).toEqual([]);
  });

  test("apply-at-once writes and app preferences never mark a page", () => {
    // The engine-notify offer and the calendar's own writes save the file themselves and the screen reloads it:
    // the loaded text and the draft move together, so nothing is changed. App preferences are not config and are
    // not an input at all (ChangeInput holds the config's text, the draft, the JSON text, the tab and the flow).
    for (const after of [text({ ...BASE, notify: "auto" }), text({ ...BASE, calendar: { sources: [] } })]) {
      expect(changedPages(form(parse(after), after))).toEqual([]);
      expect(saveBarShown(form(parse(after), after), "ready")).toBe(false);
    }
    // Final round 1 (T-L9): the input's members as pages.ts declares them, read from the source at run time (a typed
    // literal here would be checked only by the type checker, which does not cover tests-web), so an app preference
    // or an apply-at-once flag added to ChangeInput fails here.
    const src = readFileSync(new URL("../src/lib/settings/pages.ts", import.meta.url), "utf8");
    const body = /export interface ChangeInput \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
    const members = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!).sort();
    // Round 9 (L6): and which page each edit was made on (`writtenOn`) — the form's own edits, never a preference.
    expect(members).toEqual(["draft", "flowPending", "loadedText", "raw", "tab", "writtenOn"]);
    // …and the shell builds it from exactly those (D-M4-T8 checkpoint pins the line verbatim).
    expect(readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8")).toContain(
      "const changeInput = $derived<ChangeInput>({ tab, loadedText: doc?.text ?? null, draft, raw, flowPending, writtenOn: written.for !== null && written.for === draft ? written.on : undefined });",
    );
  });

  test("a pending Add or Replace with a clean draft marks AI providers and asks for no bar; with a changed draft, both", () => {
    expect(changedPages(form(parse(LOADED), LOADED, true))).toEqual(["providers"]);
    expect(saveBarShown(form(parse(LOADED), LOADED, true), "ready")).toBe(false);
    const changed = edited((d) => setPath(d, ["morningTime"], "08:00"));
    expect(changedPages(form(changed, LOADED, true))).toEqual(["general", "providers"]);
    expect(saveBarShown(form(changed, LOADED, true), "ready")).toBe(true);
  });

  test("the bar shows for a changed draft or changed JSON text, never before the config is loaded", () => {
    expect(saveBarShown(form(parse(LOADED)), "ready")).toBe(false);
    expect(saveBarShown(form(edited((d) => setPath(d, ["repos"], []))), "ready")).toBe(true);
    expect(saveBarShown(raw(JSON.stringify(BASE)), "ready")).toBe(false);
    expect(saveBarShown(raw("{ not json"), "ready")).toBe(true);
    expect(saveBarShown(form(null, null), "ready")).toBe(false);
    expect(changedPages(form(null, null, false))).toEqual([]);
  });

  test("L2: no bar over a config no page can show — a kept draft over a file now unreadable, a failed reload", () => {
    // Discard stays reachable through General's Reload or Try again (the page says why).
    const dirty = form(edited((d) => setPath(d, ["repos"], [])));
    expect(saveBarShown(dirty, "ready")).toBe(true);
    expect(saveBarShown(dirty, "unavailable")).toBe(false);
    expect(saveBarShown(dirty, "loading")).toBe(false);
    expect(saveBarShown(raw("{ not json"), "unavailable")).toBe(false);
  });
});

describe("blockedPages: the pages holding a save-blocking live error (replaces the collapsed-Advanced pins)", () => {
  const cli = parse(LOADED);
  const api = parse(text({ ...BASE, provider: { api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } } }));

  test("an error on an Advanced field names Advanced; an error outside it names its own page", () => {
    expect(blockedPages(cli, { "provider.timeoutMs": "must be a number" })).toEqual(["advanced"]);
    expect(blockedPages(api, { "provider.api.maxTokens": "must be a number" })).toEqual(["advanced"]);
    expect(blockedPages(cli, { lookbackCapDays: "must be a number" })).toEqual(["general"]);
    expect(blockedPages(cli, { lookbackCapDays: "x", repos: "y", "provider.timeoutMs": "z" })).toEqual(["general", "projects", "advanced"]);
  });

  test("no error, a cleared error, or an error on a field that is not live blocks nothing", () => {
    expect(blockedPages(cli, {})).toEqual([]);
    expect(blockedPages(cli, { "provider.timeoutMs": "" })).toEqual([]);
    // API-only, on a command-line config: hidden, and Save does not refuse on it either.
    expect(blockedPages(cli, { "provider.api.maxTokens": "stale" })).toEqual([]);
  });

  test("Save refuses exactly when a page is named: formSubmission blocks iff blockedPages is non-empty", () => {
    // The cases of the old collapsed-Advanced pins (settings.check.ts, replaced in D-M2-T3), each with its pages.
    const apiText = text({ ...BASE, provider: { api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } } });
    const cases: [string, Draft, string, Record<string, string>, string[]][] = [
      ["an Advanced field's error", cli, LOADED, { "provider.timeoutMs": "must be a number" }, ["advanced"]],
      ["an API-only Advanced field's error on an API config", api, apiText, { "provider.api.maxTokens": "must be a number" }, ["advanced"]],
      ["no error", cli, LOADED, {}, []],
      ["an error outside Advanced", cli, LOADED, { lookbackCapDays: "must be a number" }, ["general"]],
      ["a cleared error", cli, LOADED, { "provider.timeoutMs": "" }, []],
      ["an error on a field that is not live", cli, LOADED, { "provider.api.maxTokens": "stale" }, []],
    ];
    for (const [what, draft, loadedText, errors, pages] of cases) {
      const blocked = formSubmission(draft, loadedText, errors).kind === "blocked";
      expect({ what, pages: blockedPages(draft, errors), blocked }).toEqual({ what, pages, blocked: pages.length > 0 });
    }
  });
});

describe("attentionPages: the dots follow today's messages only", () => {
  const NOW = new Date("2026-10-21T08:00:00Z");
  const at = NOW.toISOString();
  const status = (second: StatusProviderRow["status"]): StatusProviderRow[] => [
    { index: 0, label: "default", kind: "cli", status: { kind: "working", at } },
    { index: 1, label: "backup", kind: "anthropic", status: second },
  ];
  const view = (rows: StatusProviderRow[], extra: { keyMoved?: boolean; results?: Record<string, string[]> } = {}): ProvidersView =>
    providersView({
      draft: parse(LOADED),
      savedText: LOADED,
      rows,
      now: NOW,
      validateRows: [0, 1].map((index) => ({ index, testTimeoutMs: 1, loopback: false, keyOptional: false, keyMoved: index === 1 && extra.keyMoved === true })),
      results: extra.results ?? {},
    });
  const quiet = { providers: null, calendarOk: null, loadFailed: false, draft: parse(LOADED), errors: {} };

  test("AI providers: a provider whose last test failed, or that is \"key moved\"", () => {
    expect(attentionPages({ ...quiet, providers: view(status({ kind: "working", at })) })).toEqual([]);
    expect(attentionPages({ ...quiet, providers: view(status({ kind: "not-working", since: at, reason: "auth" })) })).toEqual(["providers"]);
    // An entry the engine reads as invalid (the briefing skips it) needs a look too: its status line is in the same
    // "bad" tone. (An extension of the D spec's list, kept by the orchestrator's call at the D-M1 checkpoint.)
    expect(attentionPages({ ...quiet, providers: view(status({ kind: "invalid", reason: "fallbacks[0]: no model" })) })).toEqual(["providers"]);
    expect(attentionPages({ ...quiet, providers: view(status({ kind: "not-tested" }), { keyMoved: true }) })).toEqual(["providers"]);
    // A failed Test whose result the engine could not record: the row's own result line says so.
    const failed = testResultLines({ kind: "tested", boundMs: 1, answer: { schemaVersion: 1, ok: true, passed: false, reason: "auth", at, recorded: false, notRecorded: "lock-held" } });
    expect(attentionPages({ ...quiet, providers: view(status({ kind: "not-tested" }), { results: { backup: failed } }) })).toEqual(["providers"]);
    const passed = testResultLines({ kind: "tested", boundMs: 1, answer: { schemaVersion: 1, ok: true, passed: true, at, recorded: true } });
    expect(attentionPages({ ...quiet, providers: view(status({ kind: "not-tested" }), { results: { backup: passed } }) })).toEqual([]);
    // Final round 1 (T-L): a row in the "warn" tone (out of usage, paused) is waiting, not failing: no dot.
    const later = new Date(NOW.getTime() + 3_600_000).toISOString();
    for (const second of [{ kind: "out-of-usage", until: later }, { kind: "paused", until: later, reason: "rate-limited" }] as StatusProviderRow["status"][]) {
      const v = view(status(second));
      expect(v.rows.map((r) => r.status.tone)).toEqual(["ok", "warn"]);
      expect({ second: second.kind, pages: attentionPages({ ...quiet, providers: v }) }).toEqual({ second: second.kind, pages: [] });
    }
  });

  test("the failed-Test words are one constant: testResultLines writes it and the dot reads it", () => {
    expect(TEST_FAILED_PREFIX).toBe("Test failed:");
    const failed = testResultLines({ kind: "tested", boundMs: 1, answer: { schemaVersion: 1, ok: true, passed: false, reason: "auth", at, recorded: true } });
    expect(failed[0]!.startsWith(`${TEST_FAILED_PREFIX} `)).toBe(true);
    // pages.ts spells no copy of its own: it imports the constant.
    const pages = readFileSync(new URL("../src/lib/settings/pages.ts", import.meta.url), "utf8");
    expect(pages).toMatch(/import \{[^}]*\bTEST_FAILED_PREFIX\b[^}]*\} from "\.\.\/settings-model";/);
    expect(pages).not.toContain('"Test failed:"');
    expect(pages).toContain("n.startsWith(TEST_FAILED_PREFIX)");
  });

  test("Calendar: a source that is not ok, as CalendarSettings reports it; General: a config that failed to load", () => {
    expect(attentionPages({ ...quiet, calendarOk: false })).toEqual(["calendar"]);
    expect(attentionPages({ ...quiet, calendarOk: true })).toEqual([]);
    expect(attentionPages({ ...quiet, loadFailed: true, draft: null })).toEqual(["general"]);
  });

  test("a clean draft with a live field error marks its page, whether or not the bar is shown", () => {
    expect(saveBarShown(form(parse(LOADED)), "ready")).toBe(false);
    expect(attentionPages({ ...quiet, errors: { morningTime: "Use HH:MM." } })).toEqual(["general"]);
    expect(attentionPages({ ...quiet, errors: { "provider.timeoutMs": "must be a number" } })).toEqual(["advanced"]);
    expect(attentionPages({ ...quiet, errors: { "provider.api.maxTokens": "stale" } })).toEqual([]);
  });

  test("several at once, in the sidebar's order", () => {
    expect(
      attentionPages({
        providers: view(status({ kind: "not-working", since: at, reason: "auth" })),
        calendarOk: false,
        loadFailed: false,
        draft: parse(LOADED),
        errors: { "provider.timeoutMs": "x", repos: "y" },
      }),
    ).toEqual(["projects", "providers", "calendar", "advanced"]);
  });
});

describe("leaveJson: the JSON editor's leave guard", () => {
  const REFUSED = "The JSON is not a JSON object, so the form cannot show it. Fix it or reload.";

  test("a JSON object is parsed back into a draft", () => {
    expect(leaveJson(LOADED)).toEqual({ ok: true, draft: parse(LOADED) });
  });

  test("anything that is not a JSON object is refused with today's message, \"raw JSON\" now \"JSON\"", () => {
    for (const t of ["{ not json", "[]", "\"text\"", "42", "null", ""]) {
      expect({ t, out: leaveJson(t) }).toEqual({ t, out: { ok: false, message: REFUSED } });
    }
  });
});

describe("initialPage and the remembered page: module state that outlives a mount", () => {
  const report = (): UninstallReport => ({}) as UninstallReport;

  test("a page passed to rememberPage is opened by initialPage when nothing is kept", () => {
    rememberPage("calendar");
    expect(rememberedPage()).toBe("calendar");
    expect(initialPage({ remembered: rememberedPage(), kept: null, report: null, lastShownReport: null })).toBe("calendar");
    expect(initialPage({ remembered: null, kept: null, report: null, lastShownReport: null })).toBe("general");
  });

  test("a kept raw tab opens Advanced with the editor, whatever was remembered; a kept form tab opens the remembered page", () => {
    expect(initialPage({ remembered: "projects", kept: { tab: "raw" }, report: null, lastShownReport: null })).toBe("advanced");
    expect(initialPage({ remembered: "projects", kept: { tab: "form" }, report: null, lastShownReport: null })).toBe("projects");
    expect(initialPage({ remembered: null, kept: { tab: "form" }, report: null, lastShownReport: null })).toBe("general");
  });

  test("a newer uninstall report opens About and wins over a kept raw tab", () => {
    const r = report();
    expect(initialPage({ remembered: "projects", kept: null, report: r, lastShownReport: null })).toBe("about");
    expect(initialPage({ remembered: "projects", kept: { tab: "raw" }, report: r, lastShownReport: null })).toBe("about");
    // A different object is a newer report, even after one was shown.
    expect(initialPage({ remembered: "projects", kept: null, report: report(), lastShownReport: r })).toBe("about");
  });

  test("the same report at a second mount, once shown, opens the remembered page; so does a null report after it", () => {
    const r = report();
    rememberShownReport(r);
    expect(lastShownReport()).toBe(r);
    expect(initialPage({ remembered: "projects", kept: null, report: r, lastShownReport: lastShownReport() })).toBe("projects");
    expect(initialPage({ remembered: "projects", kept: null, report: null, lastShownReport: lastShownReport() })).toBe("projects");
  });

  test("the shell's sequence: About answered, remembered and shown; the next mount with the same report stays on About", () => {
    const r = report();
    rememberPage("projects");
    rememberShownReport(null);
    const first = initialPage({ remembered: rememberedPage(), kept: null, report: r, lastShownReport: lastShownReport() });
    expect(first).toBe("about");
    // What the shell does when the answer is About (D-M4-T8).
    rememberShownReport(r);
    rememberPage(first);
    expect(initialPage({ remembered: rememberedPage(), kept: null, report: r, lastShownReport: lastShownReport() })).toBe("about");
  });
});

describe("navigate: a page change, with the JSON editor's rule", () => {
  const BAD = "[1, 2]";

  test("the sequence: a carried raw tab is never parsed off Advanced; leaving Advanced with bad JSON is refused; fixed, it applies showTab(\"form\")'s whole effect", () => {
    // About with a kept raw tab whose text is not an object → General: allowed, not parsed, the tab still raw.
    expect(navigate("about", "general", "raw", BAD, true)).toEqual({ kind: "moved", page: "general", tab: "raw" });
    // General → Advanced: the editor is open there.
    expect(navigate("general", "advanced", "raw", BAD, true)).toEqual({ kind: "moved", page: "advanced", tab: "raw" });
    // Advanced → General with the same text: refused, stays on Advanced, with the message.
    expect(navigate("advanced", "general", "raw", BAD, true)).toEqual({
      kind: "refused",
      page: "advanced",
      message: "The JSON is not a JSON object, so the form cannot show it. Fix it or reload.",
    });
    // The text fixed → General: the form tab, the parsed draft, and the errors and failure line cleared, so the
    // refusal's message and a live error held before the leave are gone after it. (The shell also draws the refused
    // inputs again from that draft, `redrawAfterReset`: the tests below and the D-M4-T8 pins.)
    expect(navigate("advanced", "general", "raw", LOADED, true)).toEqual({
      kind: "left-json",
      page: "general",
      tab: "form",
      draft: parse(LOADED),
      errors: {},
      failure: "",
    });
  });

  test("H1: a rejected input, then the editor left: the errors go, so that input must be drawn again from the draft, at every place that resets them", () => {
    // A value the form refuses is never written into the draft (`writeField`), so the input still shows the typed text
    // while the draft holds the old value: only the error says so.
    const draft = parse(LOADED);
    const field = SECTIONS.flatMap((s) => s.fields).find((f) => f.id === "lookbackCapDays")!;
    const refused = writeField(draft, field, "30 days");
    expect(refused).not.toBeNull();
    expect(readField(draft, field)).toBe("4");
    const errors = { lookbackCapDays: refused ?? "" };
    expect(blockedPages(draft, errors)).toEqual(["general"]);
    // The editor opened and left: the answer clears the errors, so nothing marks the field, the dot or the bar any more…
    const left = navigate("advanced", "general", "raw", rawFromDraft(draft), true);
    expect(left.kind).toBe("left-json");
    if (left.kind !== "left-json") return;
    expect(blockedPages(left.draft, left.errors)).toEqual([]);
    expect(attentionPages({ providers: null, calendarOk: null, loadFailed: false, draft: left.draft, errors: left.errors })).toEqual([]);
    // …and the draft still holds the old value, not the typed text: an input left as it was would show "30 days" with no
    // mark, and the next Save would write "4". Svelte does not rewrite an input whose value prop did not change, so the
    // shell marks the refused field (`redrawAfterField`) and, where it resets the errors, draws the marked fields again
    // (`redrawAfterReset`): SettingsForm keys EACH field on its own count.
    expect(readField(left.draft, field)).toBe("4");
    let r = redrawAfterField(NO_REDRAW, field.id, true);
    r = redrawAfterReset(r);
    expect(r.count[field.id]).toBe(1);
    const shell = readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(shell).toContain("let redraw = $state.raw<Redraw>(NO_REDRAW);");
    // The place that marks a field: a refused value (the engine-default toggle unmarks its own, final round 4) —
    // round 11 (M1): through `fieldEdited`, which marks every field's refused value but row 1's tool controls' (a note).
    expect(shell).toContain("function onfield(field: Field, value: string): void { if (draft === null) return; const was = $state.snapshot(draft) as Draft; const refused = writeField(draft, field, value);");
    expect(shell).toContain("const next = fieldEdited({ errors, redraw, tool: toolRows }, field, value, refused, noteStamp(draft, gesture)); errors = next.errors; redraw = next.redraw; toolRows = next.tool;");
    expect(fieldEdited({ errors: {}, redraw: NO_REDRAW, tool: NO_TOOL_ROWS }, field, "30 days", "must be a number", { seq: 0, accounts: "null" }).redraw).toEqual(redrawAfterField(NO_REDRAW, field.id, true));
    expect(shell).toContain("redraw = redrawAfterDefault(redraw, f.id);");
    // The places that reset the errors: the editor left (`openPage`), and every load the user asks for (Discard,
    // Reload, after a save) — each right where the errors are reset, and nowhere else. Post-cap (R5-H1): a Calendar
    // write and the engine-notify offer reset neither (`backgroundReload`, pinned in "Post-cap, section 1").
    expect(shell).toContain('if (next.kind === "left-json") { redraw = redrawAfterReset(redraw); draft = next.draft; errors = next.errors; failure = next.failure; toolRows = { ...toolRows, other: false, note: null }; }');
    expect(shell).toContain("if (kept === null) { draw(next); if (loadResets(landed !== null)) { redraw = redrawAfterReset(redraw); errors = {}; toolRows = { ...toolRows, other: false, note: null }; } reloadOwed = owedAfterLoad(false, asks, backgroundReloads); }");
    expect(shell.match(/redraw = redrawAfter\w+\(/g)).toEqual(["redraw = redrawAfterReset(", "redraw = redrawAfterDefault(", "redraw = redrawAfterReset("]);
    // Round 10 (M1), round 11 (L2): and row 1's own fields — another provider becoming row 1 resets them all, each with
    // its error (`toolRowsAfter`, the one effect); the other `next.redraw` is `onfield`'s (`fieldEdited`).
    expect(shell.match(/redraw = (reset|next)\.redraw;/g)).toEqual(["redraw = next.redraw;", "redraw = next.redraw;"]);
    expect(shell).not.toContain("resetFields(");
    expect(shell).toContain("const next = toolRowsAfter(toolRows, label, errors, redraw); if (next === null) return; toolRows = next.rows; errors = next.errors; redraw = next.redraw;");
    expect(shell).toContain("redraw={redraw.count}");
    const pages = readFileSync(new URL("../src/lib/settings/SettingsPages.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(pages).toContain("redraw: Record<string, number>;");
    expect(pages).toMatch(/onproviderremoveliteral, provideradd, providerreplace, redraw, toolOther, toolNote, \}/);
    const sf = readFileSync(new URL("../src/routes/SettingsForm.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    // Each field inside its own key, inside the one snippet every section draws (boxed or, since Part B, bare): the
    // providers list (a typed Add, a pasted key) is outside it. A field the user types in is drawn again only when it
    // is itself marked.
    expect(sf).toMatch(/\{#snippet fieldList\(fields: Field\[\]\)\} (<!--[^>]*--> )?\{#each fields as field \(field\.id\)\} \{#key redraw\[field\.id\] \?\? 0\}/);
    expect(sf).toContain("{/key} {/each} {/snippet}");
    expect(sf.indexOf("<ProvidersList")).toBeGreaterThan(sf.indexOf("{/snippet}"));
    // User-directed 2026-10-22 (P2): the boxed sections draw their fields with Other's two command-line rows added
    // (`withToolRows`), the bare ones as they are; both through the one snippet.
    expect(sf.match(/\{@render fieldList\(section\.fields\)\}/g)?.length).toBe(1);
    expect(sf.match(/\{@render fieldList\(withToolRows\(section\.fields\)\)\}/g)?.length).toBe(1);
    expect(sf).not.toMatch(/\bepoch\b/);
  });

  test("R2-M1 / R3-M2: the per-field redraw — only a field that may show what the draft does not hold is drawn again", () => {
    // A save landing, a Calendar write and the engine-notify offer all reload, and typed-but-uncommitted text is not
    // dirty, so the reload goes ahead: drawing a field again then destroys its input and what is typed in it. Round 2
    // keyed every field on one shared count, so a refused value ANYWHERE redrew them all; now each field has its own.
    expect(NO_REDRAW).toEqual({ pending: [], count: {} });
    expect(redrawAfterReset(NO_REDRAW)).toEqual({ pending: [], count: {} });
    // A refused value marks its field, once however often it is refused.
    let r = redrawAfterField(NO_REDRAW, "provider.timeoutMs", true);
    r = redrawAfterField(r, "provider.timeoutMs", true);
    expect(r).toEqual({ pending: ["provider.timeoutMs"], count: {} });
    // A value taken elsewhere marks nothing (its input shows what the draft now holds).
    r = redrawAfterField(r, "lookbackCapDays", false);
    expect(r.pending).toEqual(["provider.timeoutMs"]);
    // A second field refused: both are marked, in order.
    r = redrawAfterField(r, "networkProbeHosts", true);
    expect(r.pending).toEqual(["provider.timeoutMs", "networkProbeHosts"]);
    // A reset draws only the marked fields again, and clears the marks.
    const once = redrawAfterReset(r);
    expect(once).toEqual({ pending: [], count: { "provider.timeoutMs": 1, networkProbeHosts: 1 } });
    // Nothing marked: nothing drawn again, whatever was drawn before.
    expect(redrawAfterReset(once)).toEqual(once);
    // Refused again later: its count goes on from where it was; the other's stays.
    expect(redrawAfterReset(redrawAfterField(once, "provider.timeoutMs", true)).count).toEqual({ "provider.timeoutMs": 2, networkProbeHosts: 1 });
    // Refused, then fixed before the reset: its input shows the value the draft holds, so it keeps its node.
    expect(redrawAfterReset(redrawAfterField(redrawAfterField(once, "lookbackCapDays", true), "lookbackCapDays", false))).toEqual(once);
    // The functions never change their argument (the shell assigns the answer to `$state.raw`).
    expect(r.pending).toEqual(["provider.timeoutMs", "networkProbeHosts"]);
    // The shell's real sequence: a refused input (`onfield`'s write, as the shell's), then a fix.
    const draft = parse(LOADED);
    const field = SECTIONS.flatMap((s) => s.fields).find((f) => f.id === "lookbackCapDays")!;
    let seq = redrawAfterField(NO_REDRAW, field.id, writeField(draft, field, "30 days") !== null);
    expect(seq.pending).toEqual([field.id]);
    seq = redrawAfterField(seq, field.id, writeField(draft, field, "5") !== null);
    expect(seq.pending).toEqual([]);
  });

  test("R3-M1: ticking or unticking the engine default draws that field's list again at once, from the draft", () => {
    // The toggle clears the field's error; a refused text still in the box would then sit there unmarked, and an
    // untick would save [] under it. The list is keyed on the toggle's state, so it is drawn again from the draft (the
    // box the user pressed is outside that key and keeps the focus).
    const sf = readFileSync(new URL("../src/routes/SettingsForm.svelte", import.meta.url), "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
    expect(sf).toMatch(/\{\/if\} \{#key usesDefault\} <textarea id="f-\{field\.id\}" rows="3" spellcheck="false" disabled=\{usesDefault\}/);
    expect(sf.match(/\{#key /g)?.length).toBe(2);
    const shell = readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(shell).toContain(
      'function ondefault(f: Field, on: boolean): void { if (draft === null) return; if (on) useDefault(draft, f); else useEmptyList(draft, f); errors[f.id] = ""; redraw = redrawAfterDefault(redraw, f.id); }',
    );
  });

  test("any other change keeps the tab as it is", () => {
    expect(navigate("general", "projects", "form", "", true)).toEqual({ kind: "moved", page: "projects", tab: "form" });
    expect(navigate("advanced", "about", "form", BAD, true)).toEqual({ kind: "moved", page: "about", tab: "form" });
    // Staying on Advanced is not a leave.
    expect(navigate("advanced", "advanced", "raw", BAD, true)).toEqual({ kind: "moved", page: "advanced", tab: "raw" });
  });

  test("M2: with no editor drawn (the config not loaded), nothing is left or refused: every change moves, with the form tab", () => {
    // The trap: the editor open, the file made unreadable or not an object outside the app, then Discard → load(false):
    // the draft is null and `raw` is the file's text ("" after a parse error), the tab still raw, the editor no longer
    // drawn. Every sidebar click was refused, and General's Reload was out of reach. (The review's probe states.)
    for (const rawText of ["", "[]", "null", BAD]) {
      for (const to of ["general", "calendar", "about", "advanced"] as const) {
        expect({ rawText, to, nav: navigate("advanced", to, "raw", rawText, false) }).toEqual({ rawText, to, nav: { kind: "moved", page: to, tab: "form" } });
      }
    }
    // A raw tab carried onto another page is dropped the same way once no editor can be drawn.
    expect(navigate("about", "general", "raw", BAD, false)).toEqual({ kind: "moved", page: "general", tab: "form" });
    expect(navigate("general", "projects", "form", "", false)).toEqual({ kind: "moved", page: "projects", tab: "form" });
  });
});

describe("configState and configLoadFailed: one reading of the config's state, for the pages and the General dot", () => {
  const DOC = { path: "/c/config.json", exists: true, text: LOADED, base: "b", parseError: null, apiKeyRedacted: false };
  const cases: [string, string, typeof DOC | null, Draft | null, string, boolean][] = [
    ["loaded", "", DOC, parse(LOADED), "ready", false],
    ["loading", "", null, null, "loading", false],
    ["a read failure", "The config could not be read.", null, null, "unavailable", true],
    ["a read failure, an old document still held", "The config could not be read.", DOC, parse(LOADED), "unavailable", true],
    ["a read failure, a missing file's document still held", "The config could not be read.", { ...DOC, exists: false, text: null, base: null }, null, "unavailable", true],
    ["no file", "", { ...DOC, exists: false, text: null, base: null }, null, "unavailable", false],
    ["a parse error", "", { ...DOC, text: "{ x", parseError: "unexpected token" }, null, "unavailable", true],
    ["a parse error, a draft still held", "", { ...DOC, text: "{ x", parseError: "unexpected token" }, parse(LOADED), "unavailable", true],
    // L1: valid JSON that is not an object (`parseDraft` answers null): unavailable, and General says why with a dot.
    ["valid JSON, not an object: []", "", { ...DOC, text: "[]" }, null, "unavailable", true],
    ["valid JSON, not an object: null", "", { ...DOC, text: "null" }, null, "unavailable", true],
    ["valid JSON, not an object: 42", "", { ...DOC, text: "42" }, null, "unavailable", true],
  ];

  test("each state, and whether General gets its attention dot", () => {
    for (const [what, loadFailure, doc, draft, state, failed] of cases) {
      expect({ what, state: configState(loadFailure, doc, draft), failed: configLoadFailed(loadFailure, doc, draft) }).toEqual({ what, state, failed });
    }
  });
});

/* ── D-M4-T6: SaveBar — the bar, the draft's network question and the outcome area (server renders) ─── */

describe("D-M4-T6: SaveBar", () => {
  const QUESTION = "You added a provider while the network check is off.";
  const SAVED: Record<string, unknown> = { kind: "saved", path: "/c/config.json", backupPath: "/c/config.json.bak", warnings: [] };
  const BASE_PROPS = {
    current: "general",
    changed: [] as string[],
    shown: false,
    blocked: [] as string[],
    pendingFlow: null,
    saving: false,
    onsave: () => {},
    ondiscard: () => {},
    onopenpage: () => {},
    askNetwork: false,
    networkYes: true,
    outcome: null,
    failure: "",
    keyLines: [] as string[],
    judgeLine: null,
  };
  const bar = (props: Record<string, unknown>): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(SaveBar as any, { props: { ...BASE_PROPS, ...props } })
      .body.replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, " ");
  const text = (body: string): string => body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const buttons = (body: string): string[] => [...body.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1] ?? ""));

  test("a changed draft shows the bar — unsaved changes, Discard, Save — and names the OTHER changed pages", () => {
    const body = bar({ shown: true, current: "general", changed: ["general", "projects", "advanced"] });
    expect(text(body)).toContain("You have unsaved changes");
    expect(buttons(body)).toEqual(["Discard", "Save"]);
    expect(text(body)).toContain("also on Projects, Advanced");
    expect(text(body)).not.toContain("on General");
    // Changes only on another page: "on", not "also on".
    const elsewhere = text(bar({ shown: true, current: "about", changed: ["projects"] }));
    expect(elsewhere).toContain("on Projects");
    expect(elsewhere).not.toContain("also on");
    // Only the open page changed: no page list at all — the mockup's sentence (Part B).
    const only = text(bar({ shown: true, current: "projects", changed: ["projects"] }));
    expect(only).not.toMatch(/\bon (General|Projects)/);
    expect(only).toContain("You have unsaved changes on this page.");
    // Final round 1 (T-M2): "also on" because the open page changed too, whatever the count of the others.
    expect(text(bar({ shown: true, current: "general", changed: ["general", "projects"] }))).toContain("You have unsaved changes on this page — also on Projects.");
    expect(text(bar({ shown: true, current: "about", changed: ["projects", "advanced"] }))).toContain("You have unsaved changes on Projects, Advanced.");
    expect(text(bar({ shown: true, current: "about", changed: ["projects", "advanced"] }))).not.toContain("this page");
  });

  test("not shown: no bar, no Save, no Discard", () => {
    const body = bar({ shown: false, changed: ["providers"] });
    expect(text(body)).not.toContain("You have unsaved changes");
    expect(buttons(body)).toEqual([]);
  });

  test("a save-blocking field on another page is named as a button that opens it; one on the open page is not", () => {
    const body = bar({ shown: true, current: "general", changed: ["general"], blocked: ["advanced"] });
    expect(buttons(body)).toEqual(["Advanced", "Discard", "Save"]);
    expect(body).toMatch(/<button[^>]*>Advanced<\/button>/);
    expect(text(bar({ shown: true, current: "advanced", changed: ["advanced"], blocked: ["advanced"] }))).not.toContain("fix the marked fields on");
    // The button calls `onopenpage` with its page (source pin: a server render clicks nothing).
    const src = readFileSync(new URL("../src/lib/settings/SaveBar.svelte", import.meta.url), "utf8");
    expect(src).toContain("onclick={() => onopenpage(page)}");
    // Final round 1 (T-L): the names only in the shown bar, never on their own; and never the open page.
    expect(text(bar({ shown: false, current: "general", changed: ["general"], blocked: ["advanced"] }))).not.toContain("fix the marked fields");
    expect(buttons(bar({ shown: true, current: "projects", changed: ["projects"], blocked: ["projects", "advanced"] }))).toEqual(["Advanced", "Discard", "Save"]);
  });

  test("L5: two or more pages to fix are joined as words: \"on Projects and Advanced\", \"on Projects, AI providers and Advanced\"", () => {
    // The text as read: tags dropped with no space added (a button's edge is not a word break).
    const words = (body: string): string => body.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    const two = words(bar({ shown: true, current: "general", changed: ["general"], blocked: ["projects", "advanced"] }));
    expect(two).toContain("To save, fix the marked fields on Projects and Advanced");
    const three = words(bar({ shown: true, current: "general", changed: ["general"], blocked: ["general", "projects", "providers", "advanced"] }));
    expect(three).toContain("To save, fix the marked fields on Projects, AI providers and Advanced");
    expect(words(bar({ shown: true, current: "general", changed: ["general"], blocked: ["advanced"] }))).toContain("To save, fix the marked fields on Advanced");
    expect(buttons(bar({ shown: true, current: "general", changed: ["general"], blocked: ["projects", "providers", "advanced"] }))).toEqual(["Projects", "AI providers", "Advanced", "Discard", "Save"]);
  });

  test("a pending Add or Replace with a changed draft: the bar says Discard also cancels it, in its own words; with a clean draft, no bar", () => {
    expect(text(bar({ shown: true, changed: ["providers"], pendingFlow: "add" }))).toContain("Discard also cancels the provider being added.");
    // M4: a pending Replace is a key being replaced, not a provider being added.
    const replace = text(bar({ shown: true, changed: ["providers"], pendingFlow: "replace" }));
    expect(replace).toContain("Discard also cancels the key being replaced.");
    expect(replace).not.toContain("provider being added");
    expect(text(bar({ shown: true, changed: ["general"], pendingFlow: null }))).not.toContain("Discard also cancels");
    // Final round 1 (T-L): an edit on AI providers is not a pending flow.
    expect(text(bar({ shown: true, changed: ["providers"], pendingFlow: null }))).not.toContain("Discard also cancels");
    expect(text(bar({ shown: false, changed: ["providers"], pendingFlow: "add" }))).not.toContain("Discard also cancels");
  });

  test("the order: the network question, then Save, then the outcome area — so \"above\" in saveForm's message stays true", () => {
    const body = bar({ shown: true, changed: ["general"], askNetwork: true, failure: "Answer the network-check question above, then press Save again." });
    const question = body.indexOf(QUESTION);
    const save = body.search(/<button[^>]*>Save<\/button>/);
    const outcome = body.indexOf("Answer the network-check question above");
    expect([question > -1, save > question, outcome > save]).toEqual([true, true, true]);
    // The box is the bound answer, ticked by default; bound both ways, so the shell's `networkYes` (which `saveForm`
    // applies) is what the user ticked — a one-way `checked={networkYes}` renders the same and loses the answer.
    expect(body).toMatch(/<input type="checkbox"[^>]*checked/);
    const src = readFileSync(new URL("../src/lib/settings/SaveBar.svelte", import.meta.url), "utf8");
    expect(src).toContain('<input type="checkbox" bind:checked={networkYes} />');
    expect(src).toContain("networkYes = $bindable(),");
    expect(text(bar({ shown: true, changed: ["general"], askNetwork: false }))).not.toContain(QUESTION);
    // L4: the question goes with the bar (an edit put back makes the draft clean, and nothing is left to save).
    expect(text(bar({ shown: false, changed: [], askNetwork: true }))).not.toContain(QUESTION);
  });

  test("H2 / R2-M2: the question and the bar sit in ONE pinned dock; the outcome follows it in the page's flow", () => {
    const body = bar({ shown: true, changed: ["general"], askNetwork: true, failure: "Answer the network-check question above, then press Save again." });
    const dock = body.indexOf('<div class="dock');
    expect(dock).toBeGreaterThan(-1);
    expect(body.split('<div class="dock').length - 1).toBe(1);
    // The dock's own markup: from its tag to its closing tag (depth counted over divs).
    const closing = (from: number): number => {
      let depth = 0;
      for (const m of body.slice(from).matchAll(/<div\b[^>]*>|<\/div>/g)) {
        depth += m[0].startsWith("</") ? -1 : 1;
        if (depth === 0) return from + m.index! + m[0].length;
      }
      return -1;
    };
    const end = closing(dock);
    const inside = body.slice(dock, end);
    const at = [inside.indexOf(QUESTION), inside.search(/<button[^>]*>Save<\/button>/)];
    expect(at.every((i) => i > -1)).toBe(true);
    expect(at[0]!).toBeLessThan(at[1]!);
    // R2-M2: what a Save produces is NOT in the pinned dock (up to 220 of 420px there covered the focused control at
    // the minimum window): it is the next element, in the page's flow at its bottom, under the bar…
    expect(inside).not.toContain("Answer the network-check question above");
    expect(inside).not.toMatch(/class="outcome/);
    const rest = body.slice(end);
    expect(rest.trimStart().startsWith('<div class="outcome')).toBe(true);
    expect(rest).toContain("Answer the network-check question above");
    // …announced politely, focusable by script (R2-M3) and never by Tab.
    expect(rest).toMatch(/^\s*<div class="outcome[^"]*" aria-live="polite" tabindex="-1">/);
    // The dock is the sticky element; nothing inside it scrolls on its own any more (R2-L1: no scroll box to reach).
    const src = readFileSync(new URL("../src/lib/settings/SaveBar.svelte", import.meta.url), "utf8");
    const css = src.slice(src.indexOf("<style>") + "<style>".length).replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (sel: string): string => new RegExp(`(?:^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1]?.replace(/\s+/g, " ") ?? "";
    expect(rule(".dock")).toContain("position: sticky;");
    expect(rule(".dock")).toContain("bottom: 0;");
    expect(css.match(/position: sticky/g)?.length).toBe(1);
    expect(css).not.toMatch(/overflow|max-height/);
    // Final round 3 (R3-H1): no scroll padding on the document — with it, focusing or clicking the bar's OWN buttons
    // scrolled the page by half a window (the sticky bar's place in the flow is the page's end) — anywhere in D.
    for (const f of ["lib/settings/SaveBar.svelte", "lib/settings/SettingsPages.svelte", "routes/Settings.svelte", "routes/SettingsForm.svelte"]) {
      expect({ f, padding: /scroll-padding/.test(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")) }).toEqual({ f, padding: false });
    }
    // The clearance is on the pages' controls instead (WCAG 2.4.11: a control the keyboard or a reveal moves to is
    // placed above the dock), and the bar's own buttons, outside every page, get none. The dock's parts raise it
    // through `:has()`, each by its measured upper bound plus a margin (the PR body's table: the bar 51.8px, with the
    // pending line 72.5px, with pages to fix up to 138.1px, the question 92.8px more)…
    expect(rule(":global(html):has(.bar)")).toBe(" --dock-clear: calc(var(--dock-bar, 64px) + var(--dock-ask, 0px)); ");
    expect(rule(":global(html):has(.bar .muted)")).toContain("--dock-bar: 88px;");
    expect(rule(":global(html):has(.bar .fix)")).toContain("--dock-bar: 152px;");
    expect(rule(":global(html):has(.ask)")).toContain("--dock-ask: 100px;");
    // The pages-to-fix rule comes after the pending one, so with both lines the larger bound wins (equal specificity).
    expect(css.indexOf(":global(html):has(.bar .fix)")).toBeGreaterThan(css.indexOf(":global(html):has(.bar .muted)"));
    // …and where `:has()` is missing, `--dock-clear` is never set and the controls keep the plain bar's 64px, never 0.
    const pagesSrc = readFileSync(new URL("../src/lib/settings/SettingsPages.svelte", import.meta.url), "utf8");
    const pagesCss = pagesSrc.slice(pagesSrc.indexOf("<style>") + "<style>".length).replace(/\/\*[\s\S]*?\*\//g, "");
    const controls = /(?:^|\})\s*\[data-page\] :global\(:is\(input, select, textarea, button, \.field, \.field-error\)\)\s*\{([^}]*)\}/.exec(pagesCss);
    expect(controls?.[1]?.replace(/\s+/g, " ")).toBe(" scroll-margin-bottom: var(--dock-clear, 64px); ");
    expect(pagesCss.match(/scroll-margin/g)?.length).toBe(1);
    expect(pagesCss).not.toContain(":has(");
    expect(css.match(/--dock-clear/g)?.length).toBe(1);
    // Chrome does not scroll a control the keyboard reaches while part of it is in the window (measured: up to fully
    // under the dock at 560x420), so a page's control that takes a visible focus under the dock is scrolled into view
    // — which keeps that margin — and nothing else is: not the dock's own buttons, not a mouse press on a button.
    const pagesCode = pagesSrc.replace(/\s+/g, " ");
    expect(pagesCode).toContain('<div class="content" onfocusin={keepClear} use:revealOn={reveal}>');
    expect(pagesCode).toContain(
      'function keepClear(e: FocusEvent): void { const el = e.target; if (!(el instanceof HTMLElement) || el.closest("[data-page]") === null) return; const dock = (e.currentTarget as HTMLElement).querySelector(".dock"); if (dock === null) return; if (keepClearScrolls({ pointer: pressing, focusVisible: shownFocus(el), el: el.getBoundingClientRect(), dock: dock.getBoundingClientRect() })) el.scrollIntoView({ block: "nearest" }); }',
    );
    // An outcome with no bar still shows, after the (empty) dock (a save that landed hides the bar).
    const after = bar({ shown: false, outcome: SAVED });
    expect(after.indexOf("Saved to /c/config.json.")).toBeGreaterThan(after.indexOf('<div class="outcome'));
    expect(after.indexOf('<div class="outcome')).toBeGreaterThan(after.indexOf('<div class="dock'));
  });

  test("R2-L7: the outcome region is drawn with nothing in it, so a result arriving later is announced", () => {
    const empty = bar({});
    expect(empty).toMatch(/<div class="outcome[^"]*" aria-live="polite" tabindex="-1"><\/div>/);
    expect(bar({ shown: true, changed: ["general"] })).toMatch(/<div class="outcome[^"]*" aria-live="polite" tabindex="-1"><\/div>/);
    // The region itself is never inside a condition: its content is.
    const src = readFileSync(new URL("../src/lib/settings/SaveBar.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(src).toContain('<div class="outcome" aria-live="polite" tabindex="-1"> {#if outcomeShown}');
    const markup = src.slice(src.indexOf("</script>"), src.indexOf("<style>"));
    expect(markup.trim().endsWith("{/if} </div>")).toBe(true);
  });

  test("R3: after the user's action, ONE reveal request says where its result is shown; focus moves to a result only when the action left it on no control", () => {
    // Round 2's SaveBar remembered a press in two flags and acted when the bar hid: a stale flag moved focus later on
    // its own, an identical second refusal changed nothing it watched, and the Add/Replace flows' Saves and a refused
    // page change were not covered. Now the shell asks (`reveal`, a sequence number) and SettingsPages acts on each
    // new number once. SaveBar only draws.
    const src = readFileSync(new URL("../src/lib/settings/SaveBar.svelte", import.meta.url), "utf8");
    const code = src.slice(0, src.indexOf("</script>"));
    for (const gone of ["press(", "scrollToResult", "focusWhenHidden", "wasShown", "onfocuslost", "$effect", "queueMicrotask", ".focus(", "scrollIntoView", "bind:this"]) {
      expect({ gone, found: src.includes(gone) }).toEqual({ gone, found: false });
    }
    expect(code.replace(/\s+/g, " ")).toContain("const outcomeShown = $derived(hasOutcome({ outcome, failure, keyLines, judgeLine }));");
    const pages = readFileSync(new URL("../src/lib/settings/SettingsPages.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(pages).toContain('<div class="content" onfocusin={keepClear} use:revealOn={reveal}>');
    // The action: a new sequence number, once; never the first value it is given (a mount reveals nothing).
    expect(pages).toContain(
      "const revealOn: Action<HTMLElement, Reveal> = (node, first) => { let seen = first.seq; return { update(next: Reveal) { if (next.seq === seen) return; seen = next.seq; queueMicrotask(() => node.isConnected && show(node, next)); }, }; };",
    );
    // What each target does: the outcome scrolled into view (and focused only when focus is on no control, or the
    // pressed control is disabled); the open page's first marked field scrolled into view whole (control and error;
    // the final small fix, F4) and its control focused; the
    // open page's title focused and scrolled into view. A refusal whose marked field is not drawn falls to the title.
    expect(pages).toContain(
      "function show(content: HTMLElement, r: Reveal): void { if (!revealStillWanted(r, lastInput)) return; if (r.target === \"outcome\") { const o = content.querySelector(\".outcome\"); if (!(o instanceof HTMLElement)) return; o.scrollIntoView({ block: \"nearest\" }); if (revealTakesFocus(\"outcome\", r.focus, focusAt())) o.focus({ preventScroll: true }); return; } const box = content.querySelector(`[data-page=\"${page}\"]`); if (box === null) return; if (r.target === \"field\") { const field = box.querySelector(\".field-error\")?.closest(\".field\"); const control = field?.querySelector('[id^=\"f-\"]'); if (field instanceof HTMLElement && control instanceof HTMLElement) { const closed = field.closest(\"[hidden][id]\"); const head = closed === null ? null : box.querySelector(`[aria-controls=\"${closed.id}\"][aria-expanded=\"false\"]`); if (head instanceof HTMLElement) { head.click(); void tick().then(() => { field.scrollIntoView({ block: \"nearest\" }); control.focus({ preventScroll: true }); }); return; } field.scrollIntoView({ block: \"nearest\" }); control.focus({ preventScroll: true }); return; } } const title = box.querySelector(\"h3.title\"); if (title instanceof HTMLElement && revealTakesFocus(\"title\", r.focus, focusAt())) { title.focus({ preventScroll: true }); title.scrollIntoView({ block: \"nearest\" }); } }",
    );
    // The title is no longer re-keyed to fire the page-change helper again (round 2's `titleKey`).
    expect(pages).not.toContain("titleKey");
    expect(pages).toContain('{#snippet title(id: PageId)} <h3 class="title" tabindex="-1" use:focusHeading={focusTitle && page === id} use:toTop={focusTitle && page === id}>{label(id)}</h3>');
    // Who asks: the bar's Save and Discard, the Add and Replace flows' own Saves, a refused page change — never a
    // background reload (load, the Calendar's or the notify offer's reload, submit itself).
    const shell = readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(shell).toContain("let reveal = $state.raw<Reveal>(NO_REVEAL);");
    expect(shell).toContain(
      "function requestReveal(action: RevealAction, pressed?: Pressed): void { reveal = nextReveal(reveal, revealFor(action, { page, blocked, outcomeShown: hasOutcome({ outcome, failure, keyLines, judgeLine }), pressed })); }",
    );
    expect(shell.match(/(?<!let )(?<![\w.])reveal = /g)?.length).toBe(1);
    const body = (start: string, next: string): string => shell.slice(shell.indexOf(start), shell.indexOf(next, shell.indexOf(start)));
    // Final round 4: the flows' Saves say where and when they were pressed (R4-M6); the bar's fix button asks too (R4-M7).
    expect(shell.match(/requestReveal\("[\w-]+"(, pressed)?\)/g)).toEqual(['requestReveal("flow-save", pressed)', 'requestReveal("flow-save", pressed)', 'requestReveal("save", pressed)', 'requestReveal("discard")', 'requestReveal("fix-page")', 'requestReveal("refused-page")']);
    expect(shell.match(/requestReveal\(/g)?.length).toBe(7);
    expect(body("async function onproviderreplacesave()", "async function onproviderreplacediscard()")).toContain('if (result.kind === "cancelled") return; if (submitted) requestReveal("flow-save", pressed);');
    expect(body("async function onprovideraddsave()", "async function onprovideradddiscard()")).toContain(
      'if (!current) return; if (landed) adding = null; else adding = { busy: false, lines: ["Not saved yet (see why below): Save again, or Discard."], pending: p }; requestReveal("flow-save", pressed); }',
    );
    expect(shell).toContain('async function barSave(): Promise<void> { if (saving) return; const pressed: Pressed = { page, at: performance.now() }; const at = gesture; if (tab === "form") await saveForm(at); else await submit(raw, false, editNow(), at); requestReveal("save", pressed); }');
    expect(shell).toContain('async function barDiscard(): Promise<void> { await discardChanges(); requestReveal("discard"); }');
    expect(shell).toContain('if (next.kind === "refused") { failure = next.message; requestReveal("refused-page"); return false; }');
    for (const [start, next] of [
      ["async function load(", "onMount(() => {"],
      ["/** The one save path.", "/** The form's Save"],
      ["async function saveForm(", "async function barSave()"],
      ["async function discardChanges()", "async function refreshProviders()"],
      ["function calendarChangedConfig()", "function onfield("],
    ] as const) {
      expect({ start, asks: body(start, next).includes("requestReveal") }).toEqual({ start, asks: false });
    }
    expect(shell).not.toMatch(/refocusTitle|titleKey|onfocuslost/);
  });

  test("R3: revealFor, the target each action's result is shown at", () => {
    const here = (over: Partial<{ page: PageId; blocked: PageId[]; outcomeShown: boolean }> = {}) => ({ page: "advanced" as PageId, blocked: [] as PageId[], outcomeShown: true, ...over });
    // The bar's Save refused for a marked field on the open page (R3-M3): that field, focused — not the page's bottom.
    expect(revealFor("save", here({ blocked: ["general", "advanced"] }))).toEqual({ target: "field", focus: true });
    // Refused for fields on other pages only: the outcome (and the bar's "fix on" buttons); focus where it is.
    expect(revealFor("save", here({ blocked: ["general"] }))).toEqual({ target: "outcome", focus: false });
    // Any other result: the outcome; focus moves there only when the action left it on no control (the shell's "no").
    expect(revealFor("save", here())).toEqual({ target: "outcome", focus: false });
    // Nothing to show: the page's title, focused and scrolled into view.
    expect(revealFor("save", here({ outcomeShown: false }))).toEqual({ target: "title", focus: true });
    // A Discard, whatever the outcome area holds (the reload cleared it): the title.
    expect(revealFor("discard", here({ blocked: ["advanced"] }))).toEqual({ target: "title", focus: true });
    expect(revealFor("discard", here({ outcomeShown: false }))).toEqual({ target: "title", focus: true });
    // The Add and Replace flows' Saves (R3-M4) and a refused page change (the JSON editor left with bad text): their
    // result in the outcome area, scrolled into view; nothing at all when the area is empty (focus never stolen).
    for (const action of ["flow-save", "refused-page"] as const) {
      expect({ action, r: revealFor(action, here()) }).toEqual({ action, r: { target: "outcome", focus: false } });
      expect({ action, r: revealFor(action, here({ outcomeShown: false })) }).toEqual({ action, r: null });
      expect({ action, r: revealFor(action, here({ blocked: ["advanced"] })) }).toEqual({ action, r: { target: "outcome", focus: false } });
    }
  });

  test("R3: nextReveal numbers every request, so an identical second result acts again and nothing stays armed", () => {
    expect(NO_REVEAL.seq).toBe(0);
    const one = nextReveal(NO_REVEAL, { target: "outcome", focus: false });
    expect(one).toEqual({ seq: 1, target: "outcome", focus: false });
    const two = nextReveal(one, { target: "outcome", focus: false });
    expect(two).toEqual({ seq: 2, target: "outcome", focus: false });
    // No request (an empty area after a flow's Save): the last one stands, unchanged — the action sees no new number.
    expect(nextReveal(two, null)).toBe(two);
  });

  test("hasOutcome: the outcome area shows something — the one test SaveBar draws by and the shell reveals by", () => {
    const none = { outcome: null, failure: "", keyLines: [] as string[], judgeLine: null };
    expect(hasOutcome(none)).toBe(false);
    expect(hasOutcome({ ...none, outcome: SAVED })).toBe(true);
    expect(hasOutcome({ ...none, failure: "Not saved: fix the marked fields first." })).toBe(true);
    expect(hasOutcome({ ...none, keyLines: ["Removed the unused key."] })).toBe(true);
    expect(hasOutcome({ ...none, judgeLine: "The judge line." })).toBe(true);
  });

  test("a clean draft after a save: the outcome area, its key lines and the judge line show, with no bar", () => {
    const body = bar({ shown: false, outcome: SAVED, keyLines: ["Removed the key of \"old\"."], judgeLine: "The audit judge uses the new first provider." });
    expect(text(body)).toContain("Saved to /c/config.json.");
    expect(text(body)).toContain("Removed the key of \"old\".");
    expect(text(body)).toContain("The audit judge uses the new first provider.");
    expect(buttons(body)).toEqual([]);
    // Nothing to report and no bar: nothing drawn at all.
    expect(text(bar({}))).toBe("");
    // Each of the four keeps the area on its own: key lines arrive after "Discard changes" has cleared the outcome.
    expect(text(bar({ keyLines: ["Removed the unused key."] }))).toBe("Removed the unused key.");
    expect(text(bar({ judgeLine: "The judge line." }))).toBe("The judge line.");
    expect(text(bar({ failure: "Not saved: fix the marked fields first." }))).toBe("Not saved: fix the marked fields first.");
  });

  test("while saving, Save and Discard are disabled and Save says so", () => {
    const body = bar({ shown: true, changed: ["general"], saving: true });
    expect(buttons(body)).toEqual(["Discard", "Checking with the engine…"]);
    expect([...body.matchAll(/<button([^>]*)>/g)].every((m) => /\bdisabled\b/.test(m[1] ?? ""))).toBe(true);
  });
});

/* ── D-M4-T7: the seven pages, SettingsPages, and the Add's network question (server renders, source pins) ── */

describe("D-M4-T7: the pages and SettingsPages", () => {
  const FULL_TEXT = readFileSync(new URL("../src-tauri/tests/fixtures/config-full.json", import.meta.url), "utf8");
  const DOC = { path: "/Users/x/.config/daily-briefing/config.json", exists: true, text: FULL_TEXT, base: "b", parseError: null, apiKeyRedacted: false };
  const noop = (): void => {};
  const BASE_PROPS = (): Record<string, unknown> => ({
    page: "general",
    onpage: noop,
    attention: [],
    changed: [],
    tab: "form",
    raw: FULL_TEXT,
    draft: parse(FULL_TEXT),
    errors: {},
    onfield: noop,
    onnotifycommand: noop,
    ondefault: noop,
    onremovekey: noop,
    loadFailure: "",
    doc: DOC,
    restored: false,
    settingsRemovedByUninstall: false,
    onreload: noop,
    notify: null,
    notifyError: "",
    autostart: null,
    autostartError: "",
    onrefresh: noop,
    os: "macos",
    update: null,
    updateLoading: false,
    updateChecking: false,
    updateError: "",
    oncheck: noop,
    onconfigchanged: noop,
    onstatus: noop,
    onopenjson: noop,
    uninstallReport: null,
    uninstallRunning: false,
    onuninstallstarted: noop,
    onuninstallended: noop,
    networkAsk: false,
    networkYes: true,
  });
  const html = (component: unknown, props: Record<string, unknown>): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(component as any, { props }).body.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
  const pages = (over: Record<string, unknown> = {}): string => html(SettingsPages, { ...BASE_PROPS(), ...over });
  const IDS = ["general", "projects", "providers", "calendar", "editor", "advanced", "about"] as const;
  /** Each page's own markup: from its wrapper to the next page's wrapper (they are siblings, in order). */
  const slices = (body: string): Record<string, { at: number; text: string; hidden: boolean }> => {
    const out: Record<string, { at: number; text: string; hidden: boolean }> = {};
    const marks = [...body.matchAll(/<div data-page="(\w+)"([^>]*)>/g)];
    marks.forEach((m, i) => {
      const end = i + 1 < marks.length ? marks[i + 1]!.index! : body.length;
      out[m[1]!] = { at: m.index!, text: body.slice(m.index!, end), hidden: /\shidden(=""|\b)/.test(m[2] ?? "") };
    });
    return out;
  };
  /** Whether `at` sits inside a `hidden` div opened after `from` (the page's own wrapper is not hidden here). */
  const hiddenAt = (body: string, from: number, at: number): boolean => {
    const stack: boolean[] = [];
    const re = /<div\b([^>]*)>|<\/div>/g;
    re.lastIndex = from;
    for (let m = re.exec(body); m !== null && m.index < at; m = re.exec(body)) {
      if (m[0].startsWith("</")) stack.pop();
      else stack.push(/\shidden(=""|\b)/.test(m[1] ?? ""));
    }
    return stack.some(Boolean);
  };
  const legends = (s: string): string[] => [...s.matchAll(/<legend[^>]*><h4[^>]*>([^<]*)<\/h4><\/legend>/g)].map((m) => m[1]!);
  const count = (s: string, needle: string): number => s.split(needle).length - 1;

  test("SettingsPages draws all seven pages at once; exactly one, the active one, is not hidden", () => {
    for (const page of IDS) {
      const s = slices(pages({ page }));
      expect(Object.keys(s)).toEqual([...IDS]);
      expect({ page, shown: IDS.filter((id) => !s[id]!.hidden) }).toEqual({ page, shown: [page] });
    }
  });

  test("each page draws its own sections (a misspelled title in a page's `sections` draws nothing, and fails here)", () => {
    const s = slices(pages());
    // Part B (user-directed 2026-10-21): General's last group is ONE "Updates" group, the update-check box and the
    // engine's Update check fields together; the model's section keeps its title (the whole-form render's legend).
    expect(legends(s.general!.text)).toEqual(["Briefing", "Updates"]);
    expect(legends(s.projects!.text)).toEqual(["Repositories", "You"]);
    // User-directed 2026-10-22 (P-A): no first-provider box; its fields are the list's row 1's (P4's title went with it).
    expect(legends(s.providers!.text)).toEqual(["Providers, in order"]);
    expect(legends(s.advanced!.text)).toEqual(["Advanced", "Notifications from the engine"]);
    for (const id of ["calendar", "about"]) expect({ id, legends: legends(s[id]!.text) }).toEqual({ id, legends: [] });
    // B2-M6-T16: Editor & links draws its Editors group only once the inventory is ready (Q-L10); nothing before that.
    expect(legends(s.editor!.text)).toEqual([]);
    const ready = { state: "ready", editors: [], projects: [], discoveryConfigured: false };
    expect(legends(slices(pages({ page: "editor", editors: ready })).editor!.text)).toEqual(["Editors"]);
  });

  test("no page other than AI providers contains the providers list", () => {
    const s = slices(pages());
    for (const id of IDS) {
      expect({ id, lists: count(s[id]!.text, ">Providers, in order</h4></legend>") }).toEqual({ id, lists: id === "providers" ? 1 : 0 });
    }
  });

  test("while the JSON editor is open (tab raw), no page shows config fields: hidden below each page's own wrapper, one line per place; Advanced shows the editor", () => {
    for (const active of ["general", "projects", "providers", "advanced"] as const) {
      const body = pages({ page: active, tab: "raw" });
      const s = slices(body);
      const page = s[active]!;
      expect(page.hidden).toBe(false);
      // Every field input and the providers list on the active page sit inside a hidden element below the wrapper.
      const fields = [...page.text.matchAll(/id="f-[^"]+"|<fieldset class="providers/g)].map((m) => page.at + m.index!);
      expect(fields.length).toBeGreaterThan(0);
      for (const at of fields) expect({ active, at, hidden: hiddenAt(body, page.at, at) }).toEqual({ active, at, hidden: true });
      // The line, once per page (R2-L2: General's two form groups say it once, under Briefing); Advanced has the editor.
      const lines = { general: 1, projects: 1, providers: 1, advanced: 0 }[active];
      expect({ active, lines: count(page.text, RAW_TAB_LINE) }).toEqual({ active, lines });
    }
    const advanced = slices(pages({ page: "advanced", tab: "raw" })).advanced!.text;
    expect(advanced).toMatch(/<textarea[^>]*id="raw-config"/);
    expect(advanced).not.toContain(">Edit settings as JSON</button>");
    // The app's own controls still work: General's "This app" and Updates, and the Calendar page, are not hidden.
    const general = pages({ page: "general", tab: "raw" });
    const g = slices(general).general!;
    expect(hiddenAt(general, g.at, g.at + g.text.indexOf("This app"))).toBe(false);
    expect(hiddenAt(general, g.at, g.at + g.text.indexOf(">Updates<"))).toBe(false);
    // …and Advanced's Terminal command and About's Uninstall, the other app-only controls.
    const adv = pages({ page: "advanced", tab: "raw" });
    const a = slices(adv).advanced!;
    expect(a.text.indexOf("The daily-briefing command in Terminal")).toBeGreaterThan(-1);
    expect(hiddenAt(adv, a.at, a.at + a.text.indexOf("The daily-briefing command in Terminal"))).toBe(false);
    const about = pages({ page: "about", tab: "raw" });
    const b = slices(about).about!;
    expect(hiddenAt(about, b.at, b.at + b.text.indexOf("Uninstall app…"))).toBe(false);
  });

  test("a pending Add's network question reaches AI providers' list through SettingsPages, ProvidersPage and SettingsForm", () => {
    const provideradd = {
      onadd: () => true,
      adding: { busy: false, saving: false, lines: [], pending: { passed: true, ran: true } },
      loginOf: null,
      onaddsave: noop,
      onaddretest: noop,
      onadddiscard: noop,
      onaddclose: noop,
    };
    const QUESTION = "You added a provider while the network check is off.";
    expect(slices(pages({ page: "providers", provideradd, networkAsk: true })).providers!.text).toContain(QUESTION);
    expect(slices(pages({ page: "providers", provideradd, networkAsk: false })).providers!.text).not.toContain(QUESTION);
    // The chain binds the answer at each step.
    const at = (f: string) => readFileSync(new URL(`../src/lib/settings/${f}`, import.meta.url), "utf8");
    expect(at("SettingsPages.svelte")).toContain("<ProvidersPage {form} {tab} {config} {networkAsk} bind:networkYes />");
    expect(at("ProvidersPage.svelte")).toContain("{networkAsk} bind:networkYes />");
  });

  test("with the form tab, Advanced offers \"Edit settings as JSON\" and no editor; the button calls onopenjson", () => {
    const advanced = slices(pages({ page: "advanced" })).advanced!.text;
    expect(advanced).toContain(">Edit settings as JSON</button>");
    expect(advanced).not.toContain('id="raw-config"');
    expect(count(advanced, RAW_TAB_LINE)).toBe(0);
    const src = readFileSync(new URL("../src/lib/settings/AdvancedPage.svelte", import.meta.url), "utf8");
    expect(src).toContain("<ActionButton onclick={openJson}>Edit settings as JSON</ActionButton>");
    expect(src.replace(/\s+/g, " ")).toContain("function openJson(): void { opened = true; onopenjson(); }");
  });

  test("a config that cannot load (a parse error, a missing file, a read failure): no JSON button or editor; the other config pages point to General, over the raw-tab line", () => {
    for (const [what, over] of [
      ["parse error", { doc: { ...DOC, parseError: "unexpected token" }, draft: null }],
      // The file's state decides, not whether a draft is held (a kept draft from an earlier visit, say).
      ["parse error, a draft still held", { doc: { ...DOC, parseError: "unexpected token" } }],
      ["missing file", { doc: { ...DOC, exists: false, text: null, base: null }, draft: null }],
      ["read failure", { loadFailure: "The config could not be read.", doc: null, draft: null }],
      ["valid JSON, not an object", { doc: { ...DOC, text: "[]" }, draft: null }],
    ] as const) {
      for (const tab of ["form", "raw"] as const) {
        const s = slices(pages({ ...over, tab }));
        expect({ what, tab, button: s.advanced!.text.includes("Edit settings as JSON") }).toEqual({ what, tab, button: false });
        expect({ what, tab, editor: s.advanced!.text.includes('id="raw-config"') }).toEqual({ what, tab, editor: false });
        for (const id of ["projects", "providers", "advanced"]) {
          expect({ what, tab, id, line: count(s[id]!.text, CONFIG_UNAVAILABLE_LINE), raw: count(s[id]!.text, RAW_TAB_LINE) }).toEqual({ what, tab, id, line: 1, raw: 0 });
        }
        // General says why itself (the config-state message), and never points to itself.
        expect({ what, tab, self: s.general!.text.includes(CONFIG_UNAVAILABLE_LINE) }).toEqual({ what, tab, self: false });
      }
    }
    expect(slices(pages({ doc: { ...DOC, parseError: "unexpected token" }, draft: null })).general!.text).toContain("could not be read as a JSON object (unexpected token)");
    expect(slices(pages({ loadFailure: "The config could not be read.", doc: null, draft: null })).general!.text).toContain(">Try again</button>");
  });

  test("L1: a file that is valid JSON but not an object: General says so, with Reload, where the other pages point", () => {
    for (const fileText of ["[]", "null", "42"]) {
      const general = slices(pages({ doc: { ...DOC, text: fileText }, draft: null })).general!.text;
      // `config.json.bak` exists only once the app has saved (config_save.rs), hence "if there is one".
      const says = general.replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
      expect({ fileText, says: says.includes("This file is JSON but not a JSON object, so the settings cannot be shown here. Fix it in an editor, or restore config.json.bak if there is one.") }).toEqual({ fileText, says: true });
      expect({ fileText, reload: count(general, ">Reload</button>") }).toEqual({ fileText, reload: 1 });
    }
    // A loaded config shows neither.
    const loaded = slices(pages()).general!.text;
    expect(loaded).not.toContain("not a JSON object");
    expect(loaded).not.toContain(">Reload</button>");
  });

  test("M2: after the trap's Discard (the editor's tab raw, the file unreadable or not an object), General is open with its Reload, and nothing is hidden by the raw tab", () => {
    // navigate answers General with the form tab (pure test above); this is what that state draws.
    for (const doc of [{ ...DOC, text: null, parseError: "unexpected token" }, { ...DOC, text: "[]" }, { ...DOC, text: "null" }]) {
      const body = pages({ page: "general", tab: "form", doc, draft: null, raw: doc.text ?? "" });
      const g = slices(body).general!;
      expect(g.hidden).toBe(false);
      const reload = g.text.indexOf(">Reload</button>");
      expect({ text: doc.text, reload: reload > -1 && !hiddenAt(body, g.at, g.at + reload) }).toEqual({ text: doc.text, reload: true });
    }
  });

  test("General's Updates: the read in progress (updateLoading) and a check in progress (updateChecking) reach UpdateCheck each as itself", () => {
    const loading = slices(pages({ updateLoading: true, updateChecking: false })).general!.text;
    expect(loading).toContain("Reading the last update check…");
    expect(loading).toMatch(/<button type="button" class="check-now[^"]*">\s*Check now\s*<\/button>/);
    const checking = slices(pages({ updateLoading: false, updateChecking: true })).general!.text;
    expect(checking).not.toContain("Reading the last update check…");
    expect(checking).toMatch(/<button type="button" class="check-now[^"]*" disabled(="")?>\s*Checking…\s*<\/button>/);
  });

  test("the footer (the save bar) is drawn once, after the last page's wrapper, outside every hidden element, on every page", () => {
    const footer = createRawSnippet(() => ({ render: () => "<p>FOOTER-MARK</p>" }));
    for (const page of IDS) {
      const body = pages({ page, footer });
      const at = body.indexOf("FOOTER-MARK");
      expect({ page, count: count(body, "FOOTER-MARK") }).toEqual({ page, count: 1 });
      expect({ page, afterLastWrapper: at > body.lastIndexOf('data-page="') }).toEqual({ page, afterLastWrapper: true });
      // Directly in `.content`: every div opened after it (each page's wrapper, hidden or not) is closed again.
      const content = body.indexOf('<div class="content');
      expect(content).toBeGreaterThan(-1);
      const depth = [...body.slice(content, at).matchAll(/<div\b[^>]*>|<\/div>/g)].reduce((d, m) => d + (m[0].startsWith("</") ? -1 : 1), 0);
      expect({ page, depth }).toEqual({ page, depth: 1 });
    }
  });

  test("a field error shows on its own page, in every section a page draws (the form bundle's `errors` reaches each SettingsForm)", () => {
    let seen = 0;
    for (const s of SECTIONS) {
      const shown = slices(pages())[s.page]!.text;
      const f = s.fields.find((x) => shown.includes(`id="f-${x.id}"`));
      if (f === undefined) continue;
      seen++;
      const message = `ERROR-FOR-${f.id}`;
      const out = slices(pages({ errors: { [f.id]: message } }));
      expect({ section: s.title, on: IDS.filter((id) => out[id]!.text.includes(message)) }).toEqual({ section: s.title, on: [s.page] });
    }
    // Every section the full config draws (Provider (API) is not drawn for its command-line item 1).
    expect(seen).toBe(SECTIONS.length - 1);
  });

  test("GeneralPage: UpdateCheck's failure line shows with `error` set, and UpdateCheck is drawn after the Update check fields (V1)", () => {
    const body = slices(pages({ updateError: "The update check failed." })).general!.text;
    expect(body).toContain("The update check failed.");
    const group = body.search(/<legend[^>]*><h4[^>]*>Updates<\/h4><\/legend>/);
    expect(group).toBeGreaterThan(-1);
    // Final round 2 (V1, the S-A mockup's order): the automatic check, its hours, then Check now (its row, its last
    // result) and its paragraph — which names "the engine's "Check for updates automatically" setting" (R2-L10) and,
    // since final round 3 (V15), not where it is (no "above": the fields are not drawn while the config is unavailable
    // or the JSON editor is open); test/privacy-wording.test.ts refuses only retired phrases.
    const at = [
      body.indexOf('id="f-updateCheck.enabled"'),
      body.indexOf('id="f-updateCheck.intervalHours"'),
      body.search(/<button type="button" class="check-now/),
      body.indexOf("Check now asks once, right away"),
    ];
    expect(at.every((i) => i > group)).toBe(true);
    expect(at.every((i, n) => n === 0 || i > at[n - 1]!)).toBe(true);
    // No second box or heading: UpdateCheck's own "Updates" heading is gone (the group's legend says it), and the model's
    // section title is not drawn on General.
    // R2-L3: the group's one heading is the h4 inside its legend.
    expect(body.match(/<h\d[^>]*>Updates<\/h\d>/g)?.length).toBe(1);
    expect(body).toMatch(/<legend[^>]*><h4[^>]*>Updates<\/h4><\/legend>/);
    expect(body).not.toMatch(/<legend[^>]*><h4[^>]*>Update check<\/h4><\/legend>/);
    expect(body.match(/>Updates<\/h4><\/legend>/g)?.length).toBe(1);
    // Its order: Briefing, This app, Updates.
    expect(body.search(/<legend[^>]*><h4[^>]*>Briefing<\/h4><\/legend>/)).toBeLessThan(body.indexOf(">This app</h4>"));
    expect(body.indexOf(">This app</h4>")).toBeLessThan(group);
    // A line between the hours row and Check now's row only while the fields are drawn (none under the legend alone).
    expect(body).toMatch(/<div class="[^"]*\bsep\b[^"]*"><div class="updates/);
    const loading = slices(pages({ doc: null, draft: null })).general!.text;
    expect(loading).toMatch(/<div class="[^"]*"><div class="updates/);
    expect(loading).not.toMatch(/<div class="[^"]*\bsep\b[^"]*"><div class="updates/);
    // The first field drawn bare follows General's own legend, which SettingsForm's `legend + .field` cannot see: its
    // `:first-child` rule takes that line away, and the field is its wrapper's first child.
    const sfCss = readFileSync(new URL("../src/routes/SettingsForm.svelte", import.meta.url), "utf8");
    expect(/\n\s*\.field:first-child\s*\{\s*border-top: 0;\s*\}/.test(sfCss.slice(sfCss.indexOf("<style>")))).toBe(true);
    expect(body).toMatch(/<legend[^>]*><h4[^>]*>Updates<\/h4><\/legend>\s*<div[^>]*>\s*<div class="field\b/);
    const gp = readFileSync(new URL("../src/lib/settings/GeneralPage.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(gp).toContain('<div class:sep={config === "ready" && tab === "form" && form !== null}> <UpdateCheck {result} {loading} {checking} {error} {oncheck} /> </div>');
    // The paragraph's words: only the locator changed (V1, R2-L10, V15), every other word as before.
    const uc = readFileSync(new URL("../src/lib/UpdateCheck.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(uc).toContain(
      'Check now asks once, right away, whatever the automatic setting says — one request to GitHub carrying the engine\'s version and nothing else about you. Automatic checks are the engine\'s "Check for updates automatically" setting: off unless you turn them on, and when on they run from the background schedule, right after it has delivered that day\'s briefing — never on a run that skipped or failed. No briefing ever waits for one, and Run now never checks. Nothing is ever downloaded or installed.',
    );
    expect(uc).not.toContain("further down this screen");
    expect(uc).not.toMatch(/setting above|settings above/);
    // GeneralPage alone, too.
    const alone = html(GeneralPage, {
      form: null, tab: "form", config: "unavailable", loadFailure: "", doc: null, restored: false, settingsRemovedByUninstall: false, onreload: noop,
      notify: null, autostart: null, onrefresh: noop, os: "macos", result: null, loading: false, checking: false, error: "Check failed.", oncheck: noop,
    });
    expect(alone).toContain("Check failed.");
  });

  test("AboutPage shows the version it is given and the settings path as text", () => {
    const body = html(AboutPage, {
      version: "0.4.1", path: "/Users/x/.config/daily-briefing/config.json",
      onrefresh: noop, uninstallReport: null, uninstallRunning: false, onuninstallstarted: noop, onuninstallended: noop,
    });
    // Part B: the version is the page's lead line, "Daily Briefing <version>" (the mockup's).
    expect(body).toMatch(/<p class="lead[^"]*">Daily Briefing 0\.4\.1<\/p>/);
    expect(body).toMatch(/<code[^>]*>\/Users\/x\/\.config\/daily-briefing\/config\.json<\/code>/);
    expect(body).toContain("Uninstall app…");
    // Final round 1 (T-L): the version shows whether or not the path is known yet (it is the build's, not the file's).
    const noPath = html(AboutPage, { version: "0.4.1", path: null, onrefresh: noop, uninstallReport: null, uninstallRunning: false, onuninstallstarted: noop, onuninstallended: noop });
    expect(noPath).toContain("Daily Briefing 0.4.1");
    expect(noPath).not.toContain(">Settings file</h4>");
  });

  test("Final round 1 (T-L): Advanced's note on the redacted key shows with the editor exactly when the key was redacted", () => {
    const NOTE = "The stored API key is shown as a placeholder.";
    expect(slices(pages({ page: "advanced", tab: "raw", doc: { ...DOC, apiKeyRedacted: true } })).advanced!.text).toContain(NOTE);
    expect(slices(pages({ page: "advanced", tab: "raw", doc: { ...DOC, apiKeyRedacted: false } })).advanced!.text).not.toContain(NOTE);
    // With the form tab there is no editor, so no note about its text.
    expect(slices(pages({ page: "advanced", tab: "form", doc: { ...DOC, apiKeyRedacted: true } })).advanced!.text).not.toContain(NOTE);
  });

  test("Final round 1 (T-L): General says when a kept edit came back, and the shell clears that at every load", () => {
    const KEPT = "Your unsaved changes from earlier are still here.";
    expect(slices(pages({ restored: true })).general!.text).toContain(KEPT);
    expect(slices(pages({ restored: false })).general!.text).not.toContain(KEPT);
    const shell = readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(shell).toContain("async function load(keepReport: boolean, landed: { sent: SentSave; from: Edit; at: number } | null = null): Promise<void> { restored = false; const asks = backgroundReloads; try {");
    expect(shell).toContain("raw = k.raw; restored = true; reloadOwed = next.base !== k.base; openInitial(k);");
  });

  test("Final round 1 (T-L): while the config loads, General says so once and each config page says so too, never \"cannot be shown\"", () => {
    const s = slices(pages({ doc: null, draft: null }));
    expect(count(s.general!.text, "Loading the config…")).toBe(1);
    for (const id of ["projects", "providers", "advanced"]) {
      expect({ id, loading: count(s[id]!.text, "Loading the config…"), unavailable: count(s[id]!.text, CONFIG_UNAVAILABLE_LINE) }).toEqual({ id, loading: 1, unavailable: 0 });
    }
    for (const id of ["calendar", "about"]) expect({ id, loading: count(s[id]!.text, "Loading the config…") }).toEqual({ id, loading: 0 });
    expect(s.general!.text).not.toContain(CONFIG_UNAVAILABLE_LINE);
  });

  test("Part B: General's Briefing group puts Morning time before Look back (user-directed 2026-10-21)", () => {
    const g = slices(pages()).general!.text;
    expect(g.indexOf('<label for="f-morningTime"')).toBeGreaterThan(-1);
    expect(g.indexOf('<label for="f-morningTime"')).toBeLessThan(g.indexOf('<label for="f-lookbackCapDays"'));
  });

  test("Editor & links' lead: off macOS it says the editor is macOS-only; every other page's stays", () => {
    const line = (os: string, id: string): string | undefined => /<\/h3>\s*<p class="lead[^"]*">([^<]*)<\/p>/.exec(slices(pages({ os }))[id]!.text)?.[1];
    expect(line("macos", "editor")).toBe("Choose how projects open and whether GitHub links are shown.");
    for (const os of ["linux", "windows", "other"]) {
      expect(line(os, "editor")).toBe("Opening an editor is only available on macOS.");
      expect(line(os, "general")).toBe(line("macos", "general"));
      expect(line(os, "projects")).toBe(line("macos", "projects"));
    }
  });

  test("Part B: each page's title is followed by its lead line, as the mockup words it; About's lead is the version", () => {
    const LEADS: Record<string, string> = {
      general: "When your briefing arrives and how it reaches you.",
      projects: "Which work goes into your briefing.",
      providers: "Who writes your briefing. The first one that works is used; the rest are fallbacks.",
      calendar: "Show today's meetings in your briefing.",
      editor: "Choose how projects open and whether GitHub links are shown.",
      advanced: "You should not need these. Most change how the engine talks to the AI.",
    };
    const s = slices(pages({ version: "4.5.6" }));
    for (const [id, lead] of Object.entries(LEADS)) {
      expect({ id, lead: new RegExp(`</h3>\\s*<p class="lead[^"]*">${lead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "(?:'|&#39;)")}</p>`).test(s[id]!.text) }).toEqual({ id, lead: true });
    }
    expect(s.about!.text).toMatch(/<\/h3>\s*<p class="lead[^"]*">Daily Briefing 4\.5\.6<\/p>/);
    // One lead per page, Editor & links' among them (B2-M6-T16).
    for (const id of Object.keys(LEADS)) expect({ id, leads: count(s[id]!.text, 'class="lead') }).toEqual({ id, leads: 1 });
    expect(count(s.editor!.text, 'class="lead')).toBe(1);
  });

  test("M1/M5: every page opens with its title, a focusable <h3>, and its headings go down one level at a time", () => {
    const body = pages({ page: "general" });
    const s = slices(body);
    for (const p of PAGES) {
      const page = s[p.id]!.text;
      const title = new RegExp(`^<div data-page="${p.id}"[^>]*>\\s*<h3 class="title[^"]*" tabindex="-1">${p.label.replace("&", "&amp;")}</h3>`);
      expect({ id: p.id, titled: title.test(page) }).toEqual({ id: p.id, titled: true });
      // The outline from the page's title down: never a jump of more than one level, and nothing above h3.
      const levels = [...page.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
      expect(levels[0]).toBe(3);
      const jumps = levels.slice(1).filter((l, i) => l > levels[i]! + 1 || l < 3);
      expect({ id: p.id, levels, jumps }).toEqual({ id: p.id, levels, jumps: [] });
    }
    // About's path group has a heading of its own; the Terminal command and Uninstall sit under the title.
    expect(s.about!.text).toMatch(/<h4[^>]*>Settings file<\/h4>/);
    expect(s.advanced!.text).toMatch(/<h4[^>]*>The daily-briefing command in Terminal<\/h4>/);
    expect(s.about!.text).toMatch(/<h4[^>]*>Uninstall<\/h4>/);
  });

  test("SettingsPages forwards `version` to About and `prefsRows` into General's content", () => {
    const rows = createRawSnippet(() => ({ render: () => "<p>Reserved row text</p>" }));
    const s = slices(pages({ version: "9.8.7", prefsRows: rows }));
    expect(s.about!.text).toContain("Daily Briefing 9.8.7");
    expect(s.general!.text).toContain("Reserved row text");
    expect(count(pages({ version: "9.8.7", prefsRows: rows }), "Reserved row text")).toBe(1);
  });

  test("the sidebar: a button per shown page, the active one aria-current, the More divider before Advanced, Editor & links between Calendar and Advanced, the dots", () => {
    const body = pages({ page: "providers", attention: ["calendar"], changed: ["projects", "providers"] });
    const nav = body.slice(body.indexOf("<nav"), body.indexOf("</nav>"));
    const entries = [...nav.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
      attrs: m[1] ?? "",
      text: (m[2] ?? "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(),
    }));
    expect(entries.map((e) => e.text.replace(/ \(.*\)$/, ""))).toEqual(["General", "Projects", "AI providers", "Calendar", "Editor & links", "Advanced", "About & uninstall"]);
    expect(entries.filter((e) => /aria-current="page"/.test(e.attrs)).map((e) => e.text.replace(/ \(.*\)$/, ""))).toEqual(["AI providers"]);
    expect(nav.indexOf(">More<")).toBeGreaterThan(nav.indexOf("Calendar"));
    expect(nav.indexOf(">More<")).toBeLessThan(nav.indexOf("Advanced"));
    expect(entries.find((e) => e.text.startsWith("Calendar"))!.text).toContain("needs a look");
    expect(entries.find((e) => e.text.startsWith("Projects"))!.text).toContain("unsaved changes");
    expect(entries.find((e) => e.text.startsWith("General"))!.text).toBe("General");
    // Final round 1 (T-L): exactly one "More" label.
    expect(nav.split(">More<").length - 1).toBe(1);
    // M3: the two marks differ in shape, not only colour (the attention dot filled, the unsaved one a ring), each on its
    // own entry. Final round 3 (cold LOW): the state is said once, in the screen-reader text; the tooltip (the name
    // below 720px, where the label is hidden) is the label only, so a screen reader does not hear the state twice.
    const entry = (label: string) => entries.find((e) => e.text.startsWith(label))!;
    expect(nav).toMatch(/Calendar<\/span> <span class="dot attention[^"]*" aria-hidden="true"><\/span>/);
    expect(nav).toMatch(/Projects<\/span> <span class="dot unsaved[^"]*" aria-hidden="true"><\/span>/);
    expect(nav.match(/class="dot attention/g)?.length).toBe(1);
    expect(nav.match(/class="dot unsaved/g)?.length).toBe(2);
    expect(entry("Calendar").attrs).toContain('title="Calendar"');
    expect(entry("Projects").attrs).toContain('title="Projects"');
    expect(entry("General").attrs).toContain('title="General"');
    const both = pages({ page: "general", attention: ["providers"], changed: ["providers"] });
    expect(both).toContain('title="AI providers"');
    expect(both).not.toContain("— needs a look");
    expect(both.match(/needs a look/g)?.length).toBe(1);
    expect(both.match(/unsaved changes/g)?.length).toBe(1);
  });

  test("source pins: the sidebar's roles and the narrow-width breakpoint", () => {
    const src = readFileSync(new URL("../src/lib/settings/SettingsPages.svelte", import.meta.url), "utf8");
    expect(src).toContain('<nav class="sidebar" aria-label="Settings pages">');
    expect(src).toContain('aria-current={page === p.id ? "page" : undefined}');
    expect(src).toContain("onclick={() => onpage(p.id)}");
    expect(src).toContain("title={p.label}");
    expect(src).not.toContain("entryTitle");
    expect(src).toMatch(/@media \(max-width: 720px\) \{/);
  });

  test("M3: the marks' shapes and colours, each ≥ 3:1 against the sidebar in both themes (from the token values)", () => {
    const src = readFileSync(new URL("../src/lib/settings/SettingsPages.svelte", import.meta.url), "utf8");
    const css = src.slice(src.indexOf("<style>") + "<style>".length).replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (sel: string): string => new RegExp(`(?:^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    expect(rule(".dot")).toContain("width: 7px;");
    expect(rule(".dot")).toContain("height: 7px;");
    expect(rule(".dot")).toContain("border-radius: 50%;");
    expect(rule(".dot.attention")).toContain("background: var(--tag-local);");
    expect(rule(".dot.unsaved")).toContain("background: transparent;");
    expect(rule(".dot.unsaved")).toMatch(/border: 1\.5px solid var\(--accent\);/);
    // The sidebar's background, as the page draws it, in each theme.
    const appCss = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
    const dark = appCss.slice(appCss.indexOf("@media (prefers-color-scheme: dark)"));
    const token = (css: string, name: string): string => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(css)?.[1] ?? "";
    const lum = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string): number => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    expect(ratio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    for (const [theme, sheet] of [["light", appCss], ["dark", dark]] as const) {
      const side = sidebarBackground(src, theme, sheet);
      expect(side).toMatch(/^#[0-9a-f]{6}$/);
      for (const mark of ["--tag-local", "--accent"]) {
        const value = token(sheet, mark);
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
        expect({ theme, mark, ok: ratio(value, side) >= 3 }).toEqual({ theme, mark, ok: true });
      }
    }
  });

  test("source pin: every element carrying `hidden` in the D components is a bare div that no rule styles with display", () => {
    const dir = new URL("../src/lib/settings/", import.meta.url).pathname;
    const files = [...new Bun.Glob("*.svelte").scanSync({ cwd: dir })].sort();
    expect(files.length).toBeGreaterThan(8);
    let seen = 0;
    for (const f of files) {
      const src = readFileSync(`${dir}${f}`, "utf8");
      for (const m of src.matchAll(/<(\w+)([^>]*)\shidden=\{[^}]*\}([^>]*)>/g)) {
        seen++;
        expect({ f, tag: m[1], classed: /\bclass[=:]/.test(`${m[2]}${m[3]}`) }).toEqual({ f, tag: "div", classed: false });
      }
      const style = src.slice(src.indexOf("<style>"));
      expect({ f, divRule: /(^|[\s>+~,{}])div(\s*[{,:>[]|\s+\{)/.test(style) && /display/.test(style) }).toEqual({ f, divRule: false });
    }
    expect(seen).toBeGreaterThanOrEqual(8);
  });

  test("ProvidersList: a pending Add's network question sits immediately before the first button in .adding .actions", () => {
    const view = providersView({ draft: parse(FULL_TEXT), savedText: FULL_TEXT, rows: null, now: new Date() });
    const list = (props: Record<string, unknown>): string =>
      html(ProvidersList, { view, onadd: () => true, adding: { busy: false, saving: false, lines: [], pending: { passed: true, ran: true } }, ...props });
    const body = list({ networkAsk: true, networkYes: true });
    const actions = body.slice(body.indexOf('<div class="actions', body.indexOf('<div class="adding')));
    const question = actions.indexOf("You added a provider while the network check is off.");
    const firstButton = actions.indexOf("<button");
    expect(question).toBeGreaterThan(-1);
    expect(question).toBeLessThan(firstButton);
    // Nothing but the question's own block between it and that button (which is Save).
    expect(actions.slice(question, firstButton).replace(/<\/?(p|label|div|input)[^>]*>/g, "").replace(NETWORK_ASK_TEXT, "").trim()).toBe("");
    expect(actions.slice(firstButton)).toMatch(/^<button type="button" class="primary[^"]*"[^>]*>Save<\/button>/);
    expect(list({ networkAsk: false, networkYes: true })).not.toContain("You added a provider while the network check is off.");
    // Bound both ways down the chain, so the shell's `networkYes` is what was ticked.
    const src = readFileSync(new URL("../src/lib/ProvidersList.svelte", import.meta.url), "utf8");
    expect(src).toContain('<input type="checkbox" bind:checked={networkYes} />');
    expect(src).toContain("networkYes = $bindable(),");
    const form = readFileSync(new URL("../src/routes/SettingsForm.svelte", import.meta.url), "utf8");
    expect(form).toContain("{networkAsk}");
    expect(form).toContain("bind:networkYes");
  });
});

/** The question's text and its box's label, the words ProvidersList draws around the box. */
const NETWORK_ASK_TEXT = /You added a provider while the network check is off\.[^<]*|Turn the network check back on/g;

/* ── D-M4-T8: Settings.svelte is the shell (source pins: it loads in onMount and is never server-rendered) ── */

describe("D-M4-T8: the shell", () => {
  const SHELL = readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8");
  const code = SHELL.replace(/\s+/g, " ");
  const markup = SHELL.slice(SHELL.indexOf("</script>"));
  const shellTag = markup.slice(markup.indexOf("<SettingsPages"), markup.indexOf("/>", markup.indexOf("<SettingsPages")));
  const at = (f: string): string => readFileSync(new URL(`../src/lib/settings/${f}`, import.meta.url), "utf8");

  test("every page change goes through navigate, applies its answer whole, and is remembered", () => {
    expect(code).toContain(
      'function openPage(to: PageId, title = true): boolean { const next = navigate(page, to, tab, raw, config === "ready"); if (next.kind === "refused") { failure = next.message; requestReveal("refused-page"); return false; } if (next.kind === "left-json") { redraw = redrawAfterReset(redraw); draft = next.draft; errors = next.errors; failure = next.failure; toolRows = { ...toolRows, other: false, note: null }; } tab = next.tab; page = next.page; pageFocus = title; rememberPage(page); return true; }',
    );
    // The editor is drawn exactly when the config is ready (AdvancedPage), so that is what navigate is told (M2).
    expect(at("AdvancedPage.svelte").replace(/\s+/g, " ").replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ")).toContain(
      '{#if config === "ready"} <div class="group"><Tile><div class="json"> <h4>Settings file as JSON</h4> {#if tab === "raw"}',
    );
    // The sidebar and the save bar's "fix it on …" button (through `fixOn`, final round 4) both call it; nothing else
    // assigns the page but the mount.
    expect(shellTag).toContain("onpage={openPage}");
    expect(code).toContain("onopenpage={fixOn}");
    expect([...code.matchAll(/(?<!let )(?<![\w.])page = /g)].map((m) => code.slice(m.index!, m.index! + 20))).toEqual(["page = next.page; pa", "page = first; rememb"]);
    // …and navigate is what parses the JSON text when Advanced is left.
    const pages = readFileSync(new URL("../src/lib/settings/pages.ts", import.meta.url), "utf8");
    const nav = pages.slice(pages.indexOf("export function navigate("), pages.indexOf("\n}\n", pages.indexOf("export function navigate(")));
    expect(nav).toContain("const left = leaveJson(raw);");
  });

  test("the page a mount opens: the remembered one at first, then initialPage on all four exits of onMount; About remembers the report it showed, passed unchanged", () => {
    expect(code).toContain('let page = $state<PageId>(rememberedPage() ?? "general");');
    expect(code).toContain(
      'function openInitial(kept: { tab: "form" | "raw" } | null): void { const first = initialPage({ remembered: rememberedPage(), kept, report: uninstallReport, lastShownReport: lastShownReport() }); if (first === "about") rememberShownReport(uninstallReport); page = first; rememberPage(first); }',
    );
    // App passes the same report object to every mount until a new one arrives; a copy would never compare equal to
    // the one shown, so About would open on every mount.
    expect(code).not.toMatch(/\$state\.snapshot\(uninstallReport\)|\.\.\.uninstallReport|structuredClone\(uninstallReport\)/);
    const mount = code.slice(code.indexOf("onMount(() => {"), code.indexOf("onDestroy(() => {"));
    expect(mount).toContain("if (k === null) { void load(false); openInitial(null); return; }");
    expect(mount).toContain('draft = null; raw = ""; openInitial(null); return; }');
    expect(mount).toContain("restored = true; reloadOwed = next.base !== k.base; openInitial(k); })");
    expect(mount).toContain(".catch((e) => { loadFailure = describeFailure(e); openInitial(null); });");
    expect(mount.split("openInitial(").length - 1).toBe(4);
  });

  test("the JSON text is bound all the way down: the shell, SettingsPages, AdvancedPage, the textarea", () => {
    expect(shellTag).toContain("bind:raw");
    expect(at("SettingsPages.svelte")).toMatch(/<AdvancedPage [^>]*bind:raw/);
    expect(at("SettingsPages.svelte")).toContain("raw = $bindable(),");
    expect(at("AdvancedPage.svelte")).toContain("raw = $bindable(),");
    expect(at("AdvancedPage.svelte")).toContain('<textarea id="raw-config" rows="24" spellcheck="false" bind:value={raw} readonly={readOnly} aria-describedby={readOnly ? "raw-saving" : undefined} use:openedHere={opened}></textarea>');
  });

  test("M1: focus follows the user — a page change to the new page's title, the JSON button to the editor (focus is not server-renderable)", () => {
    // The shell flags a page change it made for the user (the sidebar, the bar's "fix it on …"); never the mount.
    expect(code).toContain("let pageFocus = $state(false);");
    // …and nothing else sets it (final round 3: the title after a Save or Discard is the shell's `reveal`).
    expect([...code.matchAll(/pageFocus = /g)].length).toBe(2);
    expect(shellTag).toContain("focusTitle={pageFocus}");
    // Each page's title takes focus when its page is opened that way (Step 0's helper, which moves focus only when its
    // argument turns true), and scrolls into view (L3): a page change keeps no scroll position of the last page.
    const sp = at("SettingsPages.svelte");
    expect(sp).toContain('import { focusHeading } from "../ui/a11y";');
    expect(sp.replace(/\s+/g, " ")).toContain(
      '<h3 class="title" tabindex="-1" use:focusHeading={focusTitle && page === id} use:toTop={focusTitle && page === id}>',
    );
    const toTop = sp.slice(sp.indexOf("const toTop"), sp.indexOf("};", sp.indexOf("const toTop")));
    expect(toTop).toContain('node.scrollIntoView({ block: "nearest" })');
    expect(toTop).toContain("if (next && !last)");
    // "Edit settings as JSON" replaces itself with the editor: focus goes to the editor, not to the page's body.
    const adv = at("AdvancedPage.svelte").replace(/\s+/g, " ");
    expect(adv).toContain("function openJson(): void { opened = true; onopenjson(); }");
    // Final round 4 (R4-L2): its own action, which also brings the editor's group to the window's top.
    expect(adv).toContain("use:openedHere={opened}");
    expect(adv).toContain("let opened = $state(false);");
  });

  test("T-H1: the kept state on leaving the screen, and its restore on return, are pinned whole (the editor's tab and text; the errors are kept but, since final round 4 (R4-M3), never restored)", () => {
    const destroy = code.slice(code.indexOf("onDestroy(() => {"), code.indexOf("/** The one save path."));
    expect(destroy).toContain(
      "keepSettings({ base: doc.base, loadedText: doc.text, tab, draft: draft === null ? null : $state.snapshot(draft), raw, errors: $state.snapshot(errors), });",
    );
    const mount = code.slice(code.indexOf("onMount(() => {"), code.indexOf("onDestroy(() => {"));
    expect(mount).toContain(
      "doc = { ...next, base: k.base, text: k.loadedText }; void refreshSavedRows(k.loadedText); tab = k.tab; draft = k.draft; raw = k.raw; restored = true; reloadOwed = next.base !== k.base; openInitial(k);",
    );
  });

  test("T-H2: load's try block, whole: the draft, the editor's text and the errors from the file, the inputs drawn again", () => {
    // Post-cap (R5-M2): unless a landed save's reload finds an edit typed while it was in flight (`afterLanded`).
    expect(code).toContain(
      'async function load(keepReport: boolean, landed: { sent: SentSave; from: Edit; at: number } | null = null): Promise<void> { restored = false; const asks = backgroundReloads; try { const next = await configRead(); const kept = landed === null ? null : afterLanded(landed.sent, landed.from, editNow(), next); if (kept === null) { draw(next); if (loadResets(landed !== null)) { redraw = redrawAfterReset(redraw); errors = {}; toolRows = { ...toolRows, other: false, note: null }; } reloadOwed = owedAfterLoad(false, asks, backgroundReloads); } else { doc = kept.doc; void refreshSavedRows(kept.doc.text); draft = kept.draft; raw = kept.raw; loadFailure = ""; reloadOwed = owedAfterLoad(kept.doc !== next, asks, backgroundReloads); } if (landed !== null) toolRows = toolRowsAfterSave(toolRows, typingInToolRows(), landed.at); } catch (e) { loadFailure = describeFailure(e); }',
    );
    expect(code).toContain('function draw(next: ConfigDocument): void { doc = next; void refreshSavedRows(next.text); draft = next.text === null ? null : parseDraft(next.text); raw = next.text ?? ""; loadFailure = ""; }');
  });

  test("T-H3: the form's Save reads the live errors at both of its decisions, so a marked field is never saved past", () => {
    const save = code.slice(code.indexOf("async function saveForm(at: number = gesture): Promise<void> {"), code.indexOf("function showTab(): void {"));
    const calls = [...save.matchAll(/formSubmission\(([^;]*)\);/g)].map((m) => m[1]);
    expect(calls).toEqual(["$state.snapshot(draft), doc.text, $state.snapshot(errors)", "$state.snapshot(draft), doc.text, $state.snapshot(errors)"]);
    // …and acts on each answer as written: a refusal shows its message, an untouched form saves nothing (the file is
    // not rewritten, no .bak), and only a "save" sends text.
    expect(save).toContain("switch (decision.kind) { case \"blocked\": outcome = null; failure = decision.message; return; case \"unchanged\": failure = \"\"; outcome = { kind: \"unchanged\", path: doc.path }; return; case \"save\": send = { text: decision.text, askedNetwork }; }");
    expect(save.match(/send = /g)?.length).toBe(1);
  });

  test("L1: while the JSON editor is open, the form's errors neither block the bar nor mark a page (the editor's Save never reads them)", () => {
    const bar = markup.slice(markup.indexOf("<SaveBar"), markup.indexOf("/>", markup.indexOf("<SaveBar")));
    expect(bar).toContain("{blocked}");
    // Final round 3: one derived list, read by the bar and by the reveal of a refused Save (the field to focus).
    expect(code).toContain('const blocked = $derived(tab === "raw" ? [] : blockedPages(draft, errors));');
    expect(code).toContain('draft, errors: tab === "raw" ? {} : errors }');
  });

  test("L8: \"Switch engine notifications to auto\" reloads the form after it saved, as the Calendar's own writes do", () => {
    const controls = readFileSync(new URL("../src/lib/settings/AppGeneralControls.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(controls).toContain("const outcome = await configOfferNotifyAuto(); offerResult = describeOffer(outcome); if (outcome.kind === \"saved\") onconfigchanged?.();");
    expect(controls).toContain("onconfigchanged?: (() => void) | undefined;");
    expect(asSetOf(tagsIn(at("SettingsPages.svelte"), "GeneralPage")[0]!.attrs)).toContain("{onconfigchanged}");
    expect(asSetOf(tagsIn(at("GeneralPage.svelte"), "AppGeneralControls")[0]!.attrs)).toContain("{onconfigchanged}");
    // The shell's handler is the Calendar's: reload at once on a clean draft, or owe the reload while an unsaved edit
    // is on screen (post-cap, R5-H1; a save from that edit is refused as a conflict, as for any outside change).
    expect(shellTag).toContain("onconfigchanged={calendarChangedConfig}");
  });

  test("showTab only opens the editor now; leaving it is navigate's, so the refusal's words live only in pages.ts", () => {
    expect(code).toContain('function showTab(): void { if (tab === "raw") return; if (draft !== null) { raw = rawFromDraft($state.snapshot(draft)); } failure = ""; tab = "raw"; }');
    expect(shellTag).toContain("onopenjson={() => showTab()}");
    expect(SHELL).not.toContain('showTab("form")');
    expect(SHELL).not.toContain("is not a JSON object");
    expect(SHELL).not.toContain('role="tablist"');
  });

  test("the save bar: Save sends the form or, with the editor open, the text; Discard is today's discardChanges; the question is above it", () => {
    const bar = markup.slice(markup.indexOf("<SaveBar"), markup.indexOf("/>", markup.indexOf("<SaveBar")));
    expect(bar).toContain("onsave={() => void barSave()}");
    expect(bar).toContain("ondiscard={() => void barDiscard()}");
    expect(code).toContain('async function barSave(): Promise<void> { if (saving) return; const pressed: Pressed = { page, at: performance.now() }; const at = gesture; if (tab === "form") await saveForm(at); else await submit(raw, false, editNow(), at); requestReveal("save", pressed); }');
    expect(code).toContain('async function barDiscard(): Promise<void> { await discardChanges(); requestReveal("discard"); }');
    expect(bar).toContain("bind:networkYes");
    expect(bar).toContain("{askNetwork}");
    expect(code).toContain('failure = "Answer the network-check question above, then press Save again.";');
    expect(code).not.toContain("question below");
    // The bar is the SettingsPages footer, under whichever page is open.
    expect(shellTag).toContain("{footer}");
  });

  test("the app's parts draw whatever the config's state: the shell guards nothing around SettingsPages, and the pages draw them while the config cannot load", () => {
    expect(markup.slice(0, markup.indexOf("<SettingsPages"))).not.toContain("{#if");
    for (const over of [{ loadFailure: "The config could not be read.", doc: null, draft: null }, { doc: null, draft: null }]) {
      const body = render(SettingsPages as never, {
        props: {
          ...(Object.fromEntries(Object.entries(SHELL_PROPS()))),
          ...over,
        },
      }).body;
      for (const part of ["This app", ">Updates<", "The daily-briefing command in Terminal", "Uninstall app…"]) {
        expect({ over: Object.keys(over).join(","), part, drawn: body.includes(part) }).toEqual({ over: Object.keys(over).join(","), part, drawn: true });
      }
    }
  });
});

/* ── D-M4-T8 checkpoint: the wiring, pinned on the parsed template ──────────────────────────────────────────────
 * A server render clicks nothing and the shell is never rendered (it loads in onMount), so which value each tag
 * passes — and which handler each button calls — is pinned on the template as the Svelte compiler parses it: every
 * attribute of the tag, as written. A dropped, added, swapped or one-way attribute fails here.
 * A tag with no spread is compared as a SET (`asSet`): order is meaningless there, and `x={x}` is read as its
 * shorthand `{x}` (the same prop), so a harmless reorder or spelling does not fail. A tag with a `{...spread}` is
 * compared in order, since what follows a spread overrides it. */

describe("D-M4-T8 checkpoint: the shell's and the pages' wiring", () => {
  const src = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  const SHELL = src("routes/Settings.svelte");
  const code = SHELL.replace(/\s+/g, " ");
  const one = (source: string, name: string): string[] => {
    const found = tagsIn(source, name);
    expect({ name, count: found.length }).toEqual({ name, count: 1 });
    return found[0]!.attrs;
  };
  /** A spread-free tag's attributes, order-free, `x={x}` as `{x}`. */
  const asSet = (attrs: string[]): string[] => attrs.map((a) => a.replace(/^(\w+)=\{\1\}$/, "{$1}")).sort();

  test("the shell's <SaveBar>: every attribute, as written (H1)", () => {
    expect(asSet(one(SHELL, "SaveBar"))).toEqual(asSet([
      "current={page}",
      "{changed}",
      "shown={saveBarShown(changeInput, config)}",
      "{blocked}",
      "{pendingFlow}",
      "{saving}",
      "onsave={() => void barSave()}",
      "ondiscard={() => void barDiscard()}",
      "onopenpage={fixOn}",
      "{askNetwork}",
      "bind:networkYes",
      "{outcome}",
      "{failure}",
      "{keyLines}",
      "{judgeLine}",
    ]));
  });

  test("the shell's <SettingsPages>: every attribute, as written — the binds, the dots, the config state, the form, the handlers (H1, M1)", () => {
    expect(asSet(one(SHELL, "SettingsPages"))).toEqual(asSet([
      "{page}",
      "onpage={openPage}",
      "{attention}",
      "{changed}",
      "{tab}",
      "bind:raw",
      "{jsonReadOnly}",
      "onopenjson={() => showTab()}",
      "{loadFailure}",
      "{doc}",
      "{restored}",
      "{settingsRemovedByUninstall}",
      "onreload={() => load(false)}",
      "{draft}",
      "{errors}",
      "{onfield}",
      "onnotifycommand={(v) => draft !== null && writeNotifyCommand(draft, v)}",
      "{ondefault}",
      "onremovekey={() => draft !== null && removeStoredApiKey(draft)}",
      "{providers}",
      "{providersMessage}",
      "{onprovidermove}",
      "{onproviderremove}",
      "{onproviderfolder}",
      "onprovidertest={(label, i) => void onprovidertest(label, i)}",
      // User-directed 2026-10-22 (P-A): Test all.
      "onprovidertestall={() => void onprovidertestall()}",
      // Round 10 (M4): the reset's promise is answered, so "Try again now" hands the focus on once it is done.
      "onproviderreset={(label, i) => onproviderreset(label, i)}",
      "onprovidermigrate={(label, i) => void onprovidermigrate(label, i)}",
      "onproviderremoveliteral={(label, i) => void onproviderremoveliteral(label, i)}",
      "provideradd={addHandlers}",
      "providerreplace={replaceHandlers}",
      // Round 10 (M1): row 1's "Other…" choice is the shell's.
      "toolOther={toolRows.other}",
      "toolNote={toolRows.note}",
      "networkAsk={askNetworkAdd}",
      "bind:networkYes",
      "notify={appNotify}",
      "notifyError={appNotifyError}",
      "autostart={appAutostart}",
      "autostartError={appAutostartError}",
      "onrefresh={loadApp}",
      "{os}",
      "{update}",
      "{updateLoading}",
      "{updateChecking}",
      "{updateError}",
      "oncheck={() => void checkNow()}",
      "onconfigchanged={calendarChangedConfig}",
      "onstatus={(ok) => (calendarOk = ok)}",
      // B2-M6-T16 (P-M8): the driver's published state and its two actions.
      "githubLinks={editorLinksState.githubLinks}",
      "linksBusy={editorLinksState.linksBusy}",
      "linksLine={editorLinksState.linksLine}",
      "onlinks={editorLinks.setLinks}",
      "editors={editorLinksState.editors}",
      "choiceLines={editorLinksState.choiceLines}",
      "onchoice={editorLinks.setChoice}",
      "{uninstallReport}",
      "{uninstallRunning}",
      "{onuninstallstarted}",
      "{onuninstallended}",
      "{footer}",
      // A-M7-T15: A's app-preference rows, General's reserved place (`prefs-rows.check.ts` pins the snippet).
      "{prefsRows}",
      "version={__APP_VERSION__}",
      "redraw={redraw.count}",
      "focusTitle={pageFocus}",
      "{reveal}",
      "{aiSummaryStatus}",
    ]));
  });

  test("the shell's derived lines the bar and the dots read, verbatim: the flow, the change input (the real tab), the config state, the dots", () => {
    for (const line of [
      // M4: a flow is pending when it runs or waits for its own Save or Discard — Add's rule, now Replace's too (a
      // refused Replace showing only Close is not pending) — and the bar is told which one.
      'const pendingFlow = $derived<"add" | "replace" | null>( adding !== null && (adding.busy || adding.pending !== null) ? "add" : replacing !== null && (replacing.busy || replacing.pending !== null) ? "replace" : null, );',
      "const flowPending = $derived(pendingFlow !== null);",
      "const changeInput = $derived<ChangeInput>({ tab, loadedText: doc?.text ?? null, draft, raw, flowPending, writtenOn: written.for !== null && written.for === draft ? written.on : undefined });",
      "const changed = $derived(changedPages(changeInput));",
      "const config = $derived(configState(loadFailure, doc, draft));",
      'const attention = $derived( attentionPages({ providers: providers ?? null, calendarOk, loadFailed: configLoadFailed(loadFailure, doc, draft), draft, errors: tab === "raw" ? {} : errors }), );',
    ]) {
      expect({ line, found: code.includes(line) }).toEqual({ line, found: true });
    }
  });

  test("the tab changes only where the editor opens (showTab), where a page change answers (openPage), and where a kept edit comes back", () => {
    // A `tab = "form"` anywhere else (in `load`, say) would hide the editor under the user after a save from it.
    expect([...code.matchAll(/(?<!let )(?<![\w.])tab = [^;]+;/g)].map((m) => m[0])).toEqual(['tab = k.tab;', 'tab = "raw";', "tab = next.tab;"]);
  });

  test("SettingsPages' form bundle, verbatim, and the config state from the same function as the shell's", () => {
    const pages = src("lib/settings/SettingsPages.svelte").replace(/\s+/g, " ");
    expect(pages).toContain(
      "const form: FormProps | null = $derived( draft === null ? null : { draft, errors, onfield, onnotifycommand, ondefault, onremovekey, providers, providersMessage, onprovidermove, onproviderremove, onproviderfolder, onprovidertest, onprovidertestall, onproviderreset, onprovidermigrate, onproviderremoveliteral, provideradd, providerreplace, redraw, toolOther, toolNote, }, );",
    );
    expect(pages).toContain("const config: ConfigState = $derived(configState(loadFailure, doc, draft));");
  });

  test("SettingsPages draws each page once, with every attribute as written (one Calendar panel; the Add's answer bound)", () => {
    const pages = src("lib/settings/SettingsPages.svelte");
    const expected: Record<string, string[]> = {
      GeneralPage: [
        "{form}", "{tab}", "{config}", "{loadFailure}", "{doc}", "{restored}", "{settingsRemovedByUninstall}", "{onreload}", "{notify}",
        "{notifyError}", "{autostart}", "{autostartError}", "{onrefresh}", "{os}", "result={update}", "loading={updateLoading}",
        "checking={updateChecking}", "error={updateError}", "{oncheck}", "{prefsRows}", "{onconfigchanged}", "{aiSummaryStatus}",
      ],
      ProjectsPage: ["{form}", "{tab}", "{config}"],
      ProvidersPage: ["{form}", "{tab}", "{config}", "{networkAsk}", "bind:networkYes"],
      CalendarPage: ["{os}", "{onconfigchanged}", "{onstatus}"],
      EditorLinksPage: ["{os}", "{githubLinks}", "{linksBusy}", "{linksLine}", "{onlinks}", "{editors}", "{choiceLines}", "{onchoice}"],
      AdvancedPage: ["{form}", "{tab}", "{config}", "bind:raw", "readOnly={jsonReadOnly}", "{onopenjson}", "apiKeyRedacted={doc?.apiKeyRedacted === true}", "{os}"],
      AboutPage: ["{version}", "path={doc?.path ?? null}", "{onrefresh}", "{uninstallReport}", "{uninstallRunning}", "{onuninstallstarted}", "{onuninstallended}"],
    };
    for (const [name, attrs] of Object.entries(expected)) expect({ name, attrs: asSet(one(pages, name)) }).toEqual({ name, attrs: asSet(attrs) });
  });

  test("every page's SettingsForm takes the whole bundle and its sections, and nothing that overrides a part of it", () => {
    const forms = (f: string): string[][] => tagsIn(src(`lib/settings/${f}`), "SettingsForm").map((t) => t.attrs);
    // Part B: the Update check fields are drawn bare, inside General's one Updates group.
    expect(forms("GeneralPage.svelte")).toEqual([["{...form}", 'sections={["Briefing"]}'], ["{...form}", 'sections={["Update check"]}', "bare"]]);
    expect(forms("ProjectsPage.svelte")).toEqual([["{...form}", 'sections={["Repositories", "You"]}']]);
    expect(forms("ProvidersPage.svelte")).toEqual([["{...form}", 'sections={["Provider (command-line tool)", "Provider (API)"]}', "{networkAsk}", "bind:networkYes"]]);
    expect(forms("AdvancedPage.svelte")).toEqual([["{...form}", 'sections={["Advanced"]}'], ["{...form}", 'sections={["Notifications from the engine"]}']]);
  });

  test("Check now reaches UpdateCheck untouched, and nothing on General or SettingsPages calls it on its own (no check on mount)", () => {
    const general = src("lib/settings/GeneralPage.svelte");
    const pages = src("lib/settings/SettingsPages.svelte");
    expect(asSet(one(general, "UpdateCheck"))).toEqual(asSet(["{result}", "{loading}", "{checking}", "{error}", "{oncheck}"]));
    // Its type, its destructuring, and passing it on: nothing else names it.
    for (const [f, s] of [["GeneralPage", general], ["SettingsPages", pages]] as const) {
      expect({ f, oncheck: s.match(/\boncheck\b/g)?.length ?? 0 }).toEqual({ f, oncheck: 3 });
      expect({ f, mountOrEffect: /\bonMount\b|\$effect\b/.test(s) }).toEqual({ f, mountOrEffect: false });
    }
  });

  test("SaveBar's buttons: Discard calls ondiscard, Save calls onsave (H1); all are Step 0's ActionButton (M2)", () => {
    const bar = src("lib/settings/SaveBar.svelte");
    const buttons = tagsIn(bar, "ActionButton");
    const discard = buttons.filter((b) => b.text.includes(">Discard</ActionButton>"));
    const save = buttons.filter((b) => b.attrs.includes('kind="primary"'));
    // R2-M3: through `press`, which remembers the user pressed it (the focus and the scroll after it).
    expect(discard.map((b) => asSet(b.attrs))).toEqual([asSet(["disabled={saving}", "onclick={ondiscard}"])]);
    expect(save.map((b) => asSet(b.attrs))).toEqual([asSet(['kind="primary"', "disabled={saving}", "onclick={onsave}"])]);
    expect(save[0]!.text).toContain('{saving ? "Checking with the engine…" : "Save"}');
    // The "fix it on …" names are ActionButtons too; no local <button> is left.
    expect(buttons.filter((b) => b.attrs.includes("onclick={() => onopenpage(page)}")).length).toBe(1);
    expect(buttons.length).toBe(3);
    expect(tagsIn(bar, "button")).toEqual([]);
    expect(bar).toContain('import ActionButton from "../ui/ActionButton.svelte";');
  });

  test("General's Try again and both Reloads read the config again (onreload), never the app's refresh: M2's way out", () => {
    const general = src("lib/settings/GeneralPage.svelte");
    const buttons = tagsIn(general, "ActionButton");
    expect(buttons.map((b) => b.text.replace(/<[^>]*>/g, "").trim())).toEqual(["Try again", "Reload", "Reload"]);
    for (const b of buttons) expect({ button: b.text, attrs: asSet(b.attrs) }).toEqual({ button: b.text, attrs: asSet(["onclick={onreload}"]) });
    // M2: Step 0's ActionButton, no local <button> left.
    expect(tagsIn(general, "button")).toEqual([]);
    // `onrefresh` (the app's own state) is named only in its type, its destructuring, and on AppGeneralControls.
    expect(general.match(/\bonrefresh\b/g)?.length ?? 0).toBe(3);
    expect(asSet(one(general, "AppGeneralControls"))).toEqual(asSet(["{notify}", "{notifyError}", "{autostart}", "{autostartError}", "{onrefresh}", "{os}", "{onconfigchanged}"]));
    // Advanced's "Edit settings as JSON" too.
    const adv = src("lib/settings/AdvancedPage.svelte");
    expect(tagsIn(adv, "ActionButton").map((b) => asSet(b.attrs))).toEqual([asSet(["onclick={openJson}"])]);
    expect(tagsIn(adv, "button")).toEqual([]);
  });
});

/** The sidebar's background colour in `theme`: its `.sidebar` rule's `background`, a `var()` resolved against the
 *  component's own custom properties (its top rules for light, its dark-scheme block for dark), then app.css's
 *  tokens (`appSheet`: the whole file for light, its dark block for dark). No background: the page's `--bg`. */
function sidebarBackground(src: string, theme: "light" | "dark", appSheet: string): string {
  const css = src.slice(src.indexOf("<style>")).replace(/\/\*[\s\S]*?\*\//g, "");
  // Part B: the tinted side panel (`.side`, the mockup's `--side`) holds the sticky `.sidebar`.
  const decl = /(?:^|\})\s*\.side\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const bg = /(?:^|;)\s*background:\s*([^;]+);/.exec(decl)?.[1]?.trim() ?? "var(--bg)";
  const name = /^var\((--[\w-]+)\)$/.exec(bg)?.[1];
  if (name === undefined) return bg;
  const darkAt = css.indexOf("@media (prefers-color-scheme: dark)");
  const local = theme === "dark" ? (darkAt >= 0 ? css.slice(darkAt) : "") : css.slice(0, darkAt >= 0 ? darkAt : css.length);
  const value = (sheet: string): string | undefined => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(sheet)?.[1];
  return value(local) ?? value(appSheet) ?? "";
}

/** A spread-free tag's attributes, order-free, `x={x}` as `{x}` (the checkpoint's `asSet`, for the describes above it). */
const asSetOf = (attrs: string[]): string[] => attrs.map((a) => a.replace(/^(\w+)=\{\1\}$/, "{$1}")).sort();

type TemplateNode = { type: string; name?: unknown; start: number; end: number; attributes?: TemplateNode[] };

/** Every element or component called `name` in a component's template (snippets included): its attributes' source
 *  text, whitespace collapsed, in order, and its whole source. */
function tagsIn(source: string, name: string): { attrs: string[]; text: string }[] {
  const ast = parseSvelte(source, { modern: true }) as unknown as { fragment: unknown };
  const out: { attrs: string[]; text: string }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const n = node as TemplateNode;
    if (n.name === name && Array.isArray(n.attributes)) {
      out.push({ attrs: n.attributes.map((a) => source.slice(a.start, a.end).replace(/\s+/g, " ")), text: source.slice(n.start, n.end) });
    }
    for (const [key, value] of Object.entries(n)) if (key !== "metadata" && key !== "loc") walk(value);
  };
  walk(ast.fragment);
  return out;
}

/** SettingsPages' required props, with nothing loaded (the shell's state before and around a config read). */
const SHELL_PROPS = (): Record<string, unknown> => {
  const noop = (): void => {};
  return {
    page: "general", onpage: noop, attention: [], changed: [], tab: "form", raw: "", onopenjson: noop,
    loadFailure: "", doc: null, restored: false, settingsRemovedByUninstall: false, onreload: noop,
    draft: null, errors: {}, onfield: noop, onnotifycommand: noop, ondefault: noop, onremovekey: noop,
    networkAsk: false, networkYes: true, notify: null, notifyError: "", autostart: null, autostartError: "",
    onrefresh: noop, os: "macos", update: null, updateLoading: true, updateChecking: false, updateError: "", oncheck: noop,
    onconfigchanged: noop, onstatus: noop, uninstallReport: null, uninstallRunning: false, onuninstallstarted: noop, onuninstallended: noop,
  };
};

/* D-M5-T10: the app's version on About. AboutPage renders a `version` prop (D-M4-T7) and SettingsPages forwards it
 * (its <AboutPage> attributes, D-M4-T8 checkpoint); what a server render cannot see is where the number comes from.
 * The build's `define` writes gui/package.json's version (the one the Tauri bundle carries: tauri.conf.json's
 * "version" points there) into the shell, which alone reads it; the test loader has no `define`, so a component
 * that read the global itself would throw under every render here. */
describe("D-M5-T10: the app version on About", () => {
  const GUI = new URL("../", import.meta.url).pathname;
  const read = (path: string): string => readFileSync(`${GUI}${path}`, "utf8");
  /** Code only: `//` line comments and `/* … *\/` blocks removed, whitespace runs as one space. */
  const codeOnly = (s: string): string => s.replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1").replace(/(^|[ \t])\/\/[^\n]*/gm, "$1").replace(/\s+/g, " ");

  test("the build defines __APP_VERSION__ from gui/package.json's version, which is the bundle's version too", () => {
    const vite = codeOnly(read("vite.config.ts"));
    expect(vite).toContain('import pkg from "./package.json";');
    expect(vite).toContain("define: { __APP_VERSION__: JSON.stringify(pkg.version), },");
    expect(vite.match(/__APP_VERSION__/g)).toEqual(["__APP_VERSION__"]);
    const pkg = JSON.parse(read("package.json")) as { version?: unknown };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect((JSON.parse(read("src-tauri/tauri.conf.json")) as { version?: unknown }).version).toBe("../package.json");
    expect(codeOnly(read("src/vite-env.d.ts"))).toContain("declare const __APP_VERSION__: string;");
  });

  test("only the shell reads it, once, on its <SettingsPages> tag; AboutPage and SettingsPages take it as a prop", () => {
    const files = [...new Bun.Glob("**/*.{ts,svelte}").scanSync({ cwd: `${GUI}src` })].sort();
    const readers = files.filter((f) => f !== "vite-env.d.ts" && codeOnly(read(`src/${f}`)).includes("__APP_VERSION__"));
    expect(readers).toEqual(["routes/Settings.svelte"]);
    expect(codeOnly(read("src/routes/Settings.svelte")).match(/__APP_VERSION__/g)).toEqual(["__APP_VERSION__"]);
    const pages = tagsIn(read("src/routes/Settings.svelte"), "SettingsPages");
    expect(pages.map((t) => t.attrs.filter((a) => a.includes("__APP_VERSION__")))).toEqual([["version={__APP_VERSION__}"]]);
    for (const f of ["lib/settings/AboutPage.svelte", "lib/settings/SettingsPages.svelte"]) {
      expect({ f, prop: codeOnly(read(`src/${f}`)).includes("version?: string | undefined;") }).toEqual({ f, prop: true });
    }
  });
});

/* D-M5-T11: keyboard, narrow width and the look. A server render has no layout, so the grid and the breakpoint are
 * pinned as the components' CSS (each rule read by its exact selector), and the tiles by where the render puts them. */
describe("D-M5-T11: keyboard, narrow width and the look", () => {
  const src = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  const styleOf = (s: string): string => s.slice(s.indexOf("<style>") + "<style>".length, s.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");
  /** The `@media (max-width: 720px)` block's inside, and the style without it. */
  const split = (css: string): { top: string; narrow: string } => {
    const at = css.indexOf("@media (max-width: 720px) {");
    if (at < 0) return { top: css, narrow: "" };
    let depth = 0;
    let end = at;
    for (let i = css.indexOf("{", at); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    return { top: css.slice(0, at) + css.slice(end + 1), narrow: css.slice(css.indexOf("{", at) + 1, end) };
  };
  /** Each rule's declarations by its selector list, whitespace collapsed (`a, b` as written). */
  const rules = (css: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.set(m[1]!.replace(/\s+/g, " ").trim(), m[2]!.replace(/\s+/g, " ").trim());
    return out;
  };
  const top = (path: string): Map<string, string> => rules(split(styleOf(src(path))).top);
  const narrow = (path: string): Map<string, string> => rules(split(styleOf(src(path))).narrow);

  const FULL_TEXT = readFileSync(new URL("../src-tauri/tests/fixtures/config-full.json", import.meta.url), "utf8");
  const DOC = { path: "/Users/x/.config/daily-briefing/config.json", exists: true, text: FULL_TEXT, base: "b", parseError: null, apiKeyRedacted: false };
  const body = (over: Record<string, unknown> = {}): string =>
    render(SettingsPages, { props: { ...SHELL_PROPS(), doc: DOC, draft: parse(FULL_TEXT), raw: FULL_TEXT, version: "1.2.3", ...over } }).body
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, " ");

  test("the sidebar is reachable by keyboard: native buttons in the tab order, the shared focus ring (.ctl), the open page announced", () => {
    const s = src("lib/settings/SettingsPages.svelte");
    const nav = s.slice(s.indexOf("<nav"), s.indexOf("</nav>"));
    const buttons = [...nav.matchAll(/<button\b([^>]*)>/g)].map((m) => m[1]!.replace(/\s+/g, " "));
    expect(buttons.length).toBe(1);
    expect(buttons[0]).toContain('type="button" class="entry ctl"');
    expect(nav).not.toMatch(/tabindex|disabled/);
    // The ring is app.css's `.ctl` one; a local :focus-visible rule would override it (app.css says why).
    expect([...top("lib/settings/SettingsPages.svelte").keys()].filter((k) => k.includes("focus"))).toEqual([]);
    // Below 720 px the label is clipped, never removed: it stays the button's accessible name (and its tooltip).
    const label = narrow("lib/settings/SettingsPages.svelte").get(".label") ?? "";
    expect(label).toContain("clip: rect(0 0 0 0);");
    // Final round 1 (T-L): taken out of the layout too, so the icon-only entry is not as wide as its clipped label.
    expect(label).toContain("position: absolute;");
    expect(label).not.toMatch(/display: none|visibility/);
    // …and never hidden from a screen reader: it is the entry's name (the icon is aria-hidden, the marks' words are
    // extra), at every width.
    expect(nav).toContain('<span class="label">{p.label}</span>');
    const navDrawn = body({ page: "calendar" });
    const labels = [...navDrawn.slice(navDrawn.indexOf("<nav"), navDrawn.indexOf("</nav>")).matchAll(/<span class="label\b[^"]*"([^>]*)>/g)];
    expect(labels.length).toBe(PAGES.filter((p) => !p.hidden).length);
    expect(labels.filter((m) => /aria-hidden|hidden/.test(m[1] ?? ""))).toEqual([]);
    const nav2 = body({ page: "calendar" });
    const drawn = [...nav2.slice(nav2.indexOf("<nav"), nav2.indexOf("</nav>")).matchAll(/<button([^>]*)>/g)].map((m) => m[1]!);
    expect(drawn.length).toBe(PAGES.filter((p) => !p.hidden).length);
    expect(drawn.every((a) => /class="entry ctl\b/.test(a) && !/tabindex|disabled/.test(a))).toBe(true);
  });

  /* Calendar is checked at the end of this test: since final round 2 (V3) its group is one Tile around CalendarSettings,
   * whose panel draws no box of its own there. Since Part B UpdateCheck is drawn inside the Updates group's tile
   * (user-directed 2026-10-21), with no box of its own. */
  test("every SettingsForm section, the providers list and each page group (This app, Updates, the Terminal command, the JSON editor, the settings file, Uninstall) sits in one Tile, whole; tiles never nest", () => {
    expect(src("routes/SettingsForm.svelte")).toContain('import Tile from "../lib/ui/Tile.svelte";');
    let pagesSeen = 0;
    for (const page of ["general", "projects", "providers", "advanced", "about"]) {
      const whole = body({ page });
      const from = whole.indexOf(`<div data-page="${page}"`);
      const next = whole.indexOf("<div data-page=", from + 1);
      // Everything up to the end of this page's wrapper (depths count from the start); marks only inside it.
      const b = whole.slice(0, next < 0 ? whole.length : next);
      expect(from).toBeGreaterThan(-1);
      pagesSeen++;
      /** The tile depth at each index: `<section class="tile` opens one, its `</section>` closes it. */
      const depthAt = (at: number): number => {
        const stack: boolean[] = [];
        for (const m of b.slice(0, at).matchAll(/<section\b([^>]*)>|<\/section>/g)) {
          if (m[0].startsWith("</")) stack.pop();
          else stack.push(/class="tile\b/.test(m[1] ?? ""));
        }
        return stack.filter(Boolean).length;
      };
      const marks: [string, RegExp][] = [
        ["a section", /<fieldset\b/g],
        ["This app", /<h4[^>]*>This app<\/h4>/g],
        ["the Terminal command", /<h4[^>]*>The daily-briefing command in Terminal<\/h4>/g],
        ["the JSON editor", /<h4[^>]*>Settings file as JSON<\/h4>/g],
        ["Uninstall", /<h4[^>]*>Uninstall<\/h4>/g],
        ["the settings path", /<h4[^>]*>Settings file<\/h4>/g],
      ];
      const seen: Record<string, number> = {};
      for (const [what, re] of marks) {
        for (const m of b.matchAll(re)) {
          if (m.index! < from) continue;
          seen[what] = (seen[what] ?? 0) + 1;
          expect({ page, what, depth: depthAt(m.index!) }).toEqual({ page, what, depth: 1 });
        }
      }
      // What each page holds, so a mark that moved off its page (or a page drawn empty) fails here too.
      const expected: Record<string, Record<string, number>> = {
        // Briefing, and Updates (the update-check box and the engine's two fields, one fieldset since Part B).
        general: { "a section": 2, "This app": 1 },
        projects: { "a section": 2 },
        // The list's own fieldset (user-directed 2026-10-22, P-A: the command-line section is no box of its own; its
        // fields are row 1's, inside the list's tile — the group below).
        providers: { "a section": 1 },
        advanced: { "a section": 2, "the Terminal command": 1, "the JSON editor": 1 },
        about: { Uninstall: 1, "the settings path": 1 },
      };
      expect({ page, seen }).toEqual({ page, seen: expected[page]! });
      for (const m of b.matchAll(/<section class="tile\b/g)) expect({ page, nested: depthAt(m.index!) }).toEqual({ page, nested: 0 });
      // T-M1 (final round 1, against Part B's structure): each group's FIRST and LAST parts sit in the SAME tile, so a
      // Tile drawn around the heading alone (the rest of the group outside it) fails. `[group, first, last]`, each a
      // text found after the page's wrapper; "last" is the group's final part as drawn with these props.
      const spans = [...b.matchAll(/<section class="tile\b[^>]*>/g)].map((m) => [m.index!, b.indexOf("</section>", m.index!)] as const);
      const tileOf = (at: number): number => spans.findIndex(([s, e]) => s < at && at < e);
      const after = (needle: string | RegExp, start = from): number => {
        const i = typeof needle === "string" ? b.indexOf(needle, start) : start + b.slice(start).search(needle);
        return i >= start ? i : -1;
      };
      const groups: Record<string, [string, RegExp | string, RegExp | string][]> = {
        general: [
          ["Briefing", /<legend[^>]*><h4[^>]*>Briefing<\/h4><\/legend>/, 'id="f-lookbackCapDays"'],
          ["This app", /<h4[^>]*>This app<\/h4>/, /<h5[^>]*>Start at login<\/h5>\s*<p class="muted[^"]*">Checking…<\/p>/],
          ["Updates", /<legend[^>]*><h4[^>]*>Updates<\/h4><\/legend>/, 'id="f-updateCheck.intervalHours"'],
        ],
        projects: [["You", /<legend[^>]*><h4[^>]*>You<\/h4><\/legend>/, 'id="f-author.emails"']],
        providers: [["Providers, in order (with row 1's own fields)", /<legend[^>]*><h4[^>]*>Providers, in order<\/h4><\/legend>/, 'id="f-provider.credential"']],
        advanced: [
          ["Notifications from the engine", /<legend[^>]*><h4[^>]*>Notifications from the engine<\/h4><\/legend>/, 'id="f-notify"'],
          ["the Terminal command", /<h4[^>]*>The daily-briefing command in Terminal<\/h4>/, /The daily-briefing command in Terminal<\/h4>\s*<p class="muted[^"]*">Checking…<\/p>/],
          ["the JSON editor", /<h4[^>]*>Settings file as JSON<\/h4>/, ">Edit settings as JSON</button>"],
        ],
        about: [
          ["the settings path", /<h4[^>]*>Settings file<\/h4>/, "/Users/x/.config/daily-briefing/config.json</code>"],
          ["Uninstall", /<h4[^>]*>Uninstall<\/h4>/, "Uninstall app…</button>"],
        ],
      };
      for (const [group, first, last] of groups[page]!) {
        const a = after(first);
        const z = after(last, a);
        expect({ page, group, found: a > -1 && z > -1 }).toEqual({ page, group, found: true });
        expect({ page, group, firstTile: tileOf(a) > -1, sameTile: tileOf(a) === tileOf(z) }).toEqual({ page, group, firstTile: true, sameTile: true });
      }
      // UpdateCheck's own box adds no tile: it sits inside the Updates group's.
      const updates = [...b.matchAll(/<div class="updates\b/g)].filter((m) => m.index! > from);
      expect(updates.length).toBe(page === "general" ? 1 : 0);
      for (const m of updates) expect({ page, what: "UpdateCheck", tile: tileOf(m.index!) === tileOf(after(/<legend[^>]*><h4[^>]*>Updates<\/h4><\/legend>/)) }).toEqual({ page, what: "UpdateCheck", tile: true });
    }
    expect(pagesSeen).toBe(5);
    // No Settings tile is a landmark (Tile.svelte: a group puts a heading inside and passes no label). User-directed
    // 2026-10-22: the Calendar page's panel draws its own Tiles (the master switch's box; Connections once its settings
    // are read — still reading here, so the one box), inside its section; the page adds none.
    const all = body({ page: "calendar" });
    expect([...all.matchAll(/<section class="tile\b[^>]*>/g)].filter((m) => /aria-label/.test(m[0]))).toEqual([]);
    const from = all.indexOf('<div data-page="calendar"');
    const cal = all.slice(from, all.indexOf("<div data-page=", from + 1));
    expect(cal.match(/<section class="tile\b/g)?.length).toBe(1);
    expect(cal).toMatch(/<section class="calendar[^"]*"[^>]*>\s*<section class="tile/);
    expect(cal).toContain("Reading the calendar settings…");
  });

  test("a setting is a row: the label and its help on the left, the control and its error on the right; one column below 720 px", () => {
    const form = top("routes/SettingsForm.svelte");
    const field = form.get(".field") ?? "";
    expect(field).toContain("display: grid;");
    // Part B (the S-A mockup's row): the words take the room, the control is as wide as it is, at the right.
    // R2-M4: the control's column is bounded (its own test below).
    expect(field).toContain("grid-template-columns: minmax(0, 1fr) fit-content(50%);");
    expect(field).toContain("grid-auto-flow: row dense;");
    expect(field).toContain("padding: 11px 14px;");
    expect(field).toContain("border-top: 1px solid var(--tile-border);");
    // A control spans two rows, so the help sits under the label, not below a tall control (the preview pass).
    expect(form.get(".field > *")).toBe("grid-column: 2; grid-row: span 2; justify-self: end;");
    expect(form.get(".field > label:not(.inline), .field > .help, .field > .help ~ .note")).toBe("grid-column: 1; grid-row: auto; justify-self: stretch;");
    const small = narrow("routes/SettingsForm.svelte");
    expect(small.get(".field")).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(small.get(".field > *, .field > label:not(.inline), .field > .help, .field > .help ~ .note")).toBe("grid-column: 1; grid-row: auto; justify-self: start;");
    // The rendered order those rules place: the label, the control, the error, then the help (Look back's row: since
    // Part B, Morning time is the first row).
    const b = body({ page: "general", errors: { lookbackCapDays: "Not a number." } });
    const rowAt = b.lastIndexOf('<div class="field', b.indexOf('<label for="f-lookbackCapDays"'));
    const row = b.slice(rowAt, b.indexOf("</div>", rowAt));
    const order = ["<label", "<input", 'class="field-error', 'class="help'].map((t) => row.indexOf(t));
    expect(order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1]!))).toBe(true);
    // The app's own controls: the words on the left, the buttons on the right, one column below 720 px.
    for (const f of ["lib/settings/AppGeneralControls.svelte", "lib/settings/CliShimControl.svelte"]) {
      const t = top(f);
      expect({ f, grid: t.get(".block") ?? "" }).toEqual({ f, grid: expect.stringContaining("display: grid;") });
      expect({ f, words: t.get(".block > *") ?? "" }).toEqual({ f, words: expect.stringContaining("grid-column: 1;") });
      expect({ f, buttons: t.get(".block > .row") ?? "" }).toEqual({ f, buttons: expect.stringContaining("grid-column: 2;") });
      expect({ f, narrow: narrow(f).get(".block > .row") ?? "" }).toEqual({ f, narrow: expect.stringContaining("grid-column: 1;") });
      expect({ f, one: narrow(f).get(".block") ?? "" }).toEqual({ f, one: expect.stringContaining("grid-template-columns: minmax(0, 1fr);") });
    }
  });

  test("labels on General, Projects and AI providers are plain words; the engine's terms stay on Advanced or in the help", () => {
    const ENGINE = /endpoint|argv|stdin|json|regular expression|millisecond|token|probe|harden|environment variable|base ?url/i;
    const plain = SECTIONS.filter((s) => s.page !== "advanced").flatMap((s) => s.fields.map((f) => f.label));
    expect(plain.length).toBeGreaterThan(15);
    expect(plain.filter((l) => ENGINE.test(l))).toEqual([]);
    const label = (id: string): string | undefined => SECTIONS.flatMap((s) => s.fields).find((f) => f.id === id)?.label;
    // The Add form's own words for the same two settings (ProvidersList's "Kind" and "Address").
    expect(label("provider.api.kind")).toBe("Kind of API");
    expect(label("provider.api.baseUrl")).toBe("Address");
    // M6: the remedies name the field by its label. (The reason words, "model or endpoint not found", are the
    // engine's own table, pinned to it by settings.check.ts, and stay.)
    for (const reason of ["not-found", "unreachable", "insecure-endpoint"]) {
      expect({ reason, remedy: remedyFor(reason), endpoint: /endpoint/i.test(remedyFor(reason)) }).toEqual({ reason, remedy: remedyFor(reason), endpoint: false });
    }
    expect(remedyFor("not-found")).toBe("Check the model name and the address, then press Test.");
    expect(remedyFor("unreachable")).toBe("Check the network and the address, then press Test.");
    expect(remedyFor("insecure-endpoint")).toBe("Change the address to an https one.");
  });

  /* Part B (user-directed 2026-10-21): the approved S-A mockup's look, measured against it with the preview harness
   * (the PR body's table). A server render has no layout, so the values are pinned as the components' CSS. Colours
   * with no Step 0 token are the components' own custom properties, light and dark; app.css and lib/ui are unchanged. */
  test("Part B: the S-A look, component-scoped — the side panel, its entries, the content surface, the titles, the groups, the rows, the strip", () => {
    const css = (path: string): string => styleOf(src(path)).replace(/\s+/g, " ");
    const rule = (sheet: string, sel: string): string =>
      new RegExp(`(?:^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(sheet)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    const dark = (sheet: string): string => {
      const at = sheet.indexOf("@media (prefers-color-scheme: dark) {");
      return at < 0 ? "" : sheet.slice(at + "@media (prefers-color-scheme: dark) {".length);
    };
    const sp = css("lib/settings/SettingsPages.svelte");
    // The mockup's own colours for the panel, the selected entry and the content surface, in each theme.
    for (const [name, light, night] of [["--side", "#efebe5", "#1b1820"], ["--sel", "#e2ddd5", "#2b2731"], ["--surface", "#f7f5f1", "#17151a"]] as const) {
      expect({ name, light: rule(sp, ".layout").includes(`${name}: ${light};`) }).toEqual({ name, light: true });
      expect({ name, dark: rule(dark(sp), ".layout").includes(`${name}: ${night};`) }).toEqual({ name, dark: true });
    }
    expect(rule(sp, ".side")).toContain("flex: 0 0 200px;");
    expect(rule(sp, ".side")).toContain("background: var(--side);");
    expect(rule(sp, ".side")).toContain("border-right: 1px solid var(--line);");
    expect(rule(sp, ".sidebar")).toContain("padding: 12px 8px;");
    expect(rule(sp, ".sidebar")).toContain("position: sticky;");
    expect(rule(sp, ".entry")).toContain("font-size: 13px;");
    expect(rule(sp, ".entry")).toContain("padding: 7px 10px;");
    expect(rule(sp, ".entry")).toContain("border-radius: 7px;");
    expect(rule(sp, ".entry")).toContain("border: 0;");
    expect(rule(sp, '.entry[aria-current="page"]')).toContain("background: var(--sel);");
    expect(rule(sp, '.entry[aria-current="page"]')).toContain("font-weight: 600;");
    expect(rule(sp, ".icon")).toContain("width: 15px;");
    expect(rule(sp, ".icon")).toContain("color: var(--muted);");
    expect(rule(sp, ".more")).toContain("font-size: 10.5px;");
    expect(rule(sp, ".more")).toContain("text-transform: uppercase;");
    expect(rule(sp, ".content")).toContain("background: var(--surface);");
    expect(rule(sp, ".title")).toContain("font-size: 20px;");
    expect(rule(sp, ".lead")).toContain("font-size: 13px;");
    expect(rule(sp, ".lead")).toContain("color: var(--muted);");
    // The groups' names: the mockup's small capitals, in --muted (its faint grey is below 4.5:1 on a tile).
    const sf = css("routes/SettingsForm.svelte");
    expect(rule(sf, "legend")).toContain("font-size: 11px;");
    expect(rule(sf, "legend")).toContain("text-transform: uppercase;");
    expect(rule(sf, "legend")).toContain("color: var(--muted);");
    expect(rule(sf, ".field > label:not(.inline)")).toContain("font-size: 13px;");
    expect(rule(sf, ".help, .note, .muted")).toContain("font-size: 12px;");
    expect(rule(sf, 'input[type="text"], select, textarea')).toContain("background: var(--surface, var(--bg));");
    expect(rule(sf, 'input[type="text"], select, textarea')).toContain("border: 1px solid var(--tile-border);");
    expect(rule(sf, "input.num")).toContain("text-align: right;");
    // The strip: the tile's fill, a top border only, the words in --muted at normal weight.
    const sb = css("lib/settings/SaveBar.svelte");
    expect(rule(sb, ".bar")).toContain("background: var(--tile);");
    expect(rule(sb, ".bar")).toContain("border-top: 1px solid var(--tile-border);");
    expect(rule(sb, ".bar")).toContain("padding: 10px 28px;");
    expect(rule(sb, ".unsaved")).toContain("font-weight: 400;");
    expect(rule(sb, ".unsaved")).toContain("color: var(--muted);");
    // The mockup's icons, one static path set per page, drawn in a 24-unit box.
    const icons = src("lib/settings/SettingsPages.svelte");
    expect(icons).toContain('<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">');
    expect(icons).toContain('<path d="M4 6h16M4 12h10M4 18h7" />');
    expect(icons).toContain('<path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" />');
  });

  test("R2-M5: the layout rounds its corners with overflow: clip, and nothing between the window and the sticky parts scrolls", () => {
    // `hidden`, `auto` or `scroll` on an ancestor makes it the scroll box the sidebar and the dock stick to, so the dock
    // sits at the bottom of a 1500px box, out of view (measured: its top from y=587 to y=1046), and round 1's H2 is back.
    const sheet = styleOf(src("lib/settings/SettingsPages.svelte"));
    expect(rules(sheet.split("@media (prefers-color-scheme: dark)")[0]!).get(".layout")).toContain("overflow: clip;");
    const ancestors = [".layout", ".side", ".sidebar", ".content"];
    const scrolling = /overflow(-[xy])?: (hidden|auto|scroll)/;
    // Every rule, the media blocks' included (a map by selector would keep only the last of each).
    let seen = 0;
    for (const m of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1]!.replace(/\s+/g, " ").trim();
      if (!ancestors.some((a) => sel.split(",").map((x) => x.trim()).includes(a))) continue;
      seen++;
      expect({ sel, scrolls: scrolling.test(m[2]!) }).toEqual({ sel, scrolls: false });
    }
    expect(seen).toBeGreaterThanOrEqual(6);
    // Every rule of the dock's own component and of the shell (the screen's section) too.
    for (const f of ["lib/settings/SaveBar.svelte", "routes/Settings.svelte"]) {
      expect({ f, scrolls: scrolling.test(styleOf(src(f))) }).toEqual({ f, scrolls: false });
    }
    // The pages' wrappers are the dock's siblings, never its ancestors: the footer is drawn after the last one, in .content.
    const markup = src("lib/settings/SettingsPages.svelte").replace(/\s+/g, " ");
    expect(markup).toContain('<AboutPage {version} path={doc?.path ?? null} {onrefresh} {uninstallReport} {uninstallRunning} {onuninstallstarted} {onuninstallended} /> </div> {@render footer?.()} </div> </div>');
  });

  test("R2-M4: the control column is bounded, so a long note or error beside a control never squeezes the label column to nothing", () => {
    // Measured at a4262a88d: `minmax(0, 1fr) auto` let Morning time's stored-time note size the auto track ("0px 420px").
    const field = top("routes/SettingsForm.svelte").get(".field") ?? "";
    const cols = /grid-template-columns: ([^;]+);/.exec(field)?.[1] ?? "";
    expect(cols).toBe("minmax(0, 1fr) fit-content(50%)");
    // The second track is never content-sized without a bound.
    expect(cols.split(/\s+(?![^(]*\))/)[1]).not.toMatch(/^(auto|max-content|min-content|minmax\([^,]+, (auto|max-content)\))$/);
  });

  test("R2-L8: a number field is the short right-aligned input; a text field is not", () => {
    const b = body({ page: "general" });
    const tag = (id: string, from: string = b): string => new RegExp(`<input[^>]*id="${id.replace(/\./g, "\\.")}"[^>]*>`).exec(from)?.[0] ?? "";
    expect(tag("f-lookbackCapDays")).toMatch(/class="[^"]*\bnum\b/);
    const api = render(SettingsPages, { props: { ...SHELL_PROPS(), doc: { ...DOC, text: WITH_KEY }, draft: parse(WITH_KEY), raw: WITH_KEY, page: "advanced" } }).body;
    const model = tag("f-provider.api.model", api);
    expect(model).not.toBe("");
    expect(model).not.toMatch(/\bnum\b/);
  });

  test("R2-L9: a group's first row draws no line above it (the legend is the group's top)", () => {
    const form = top("routes/SettingsForm.svelte");
    expect(form.get("legend + .field")).toBe("border-top: 0;");
    // …and the rule applies: in each drawn group the first row follows the legend directly.
    const whole = body({ page: "projects" });
    const from = whole.indexOf('<div data-page="projects"');
    const b = whole.slice(from, whole.indexOf("<div data-page=", from + 1));
    const firsts = [...b.matchAll(/<\/legend>\s*(<[a-z]+[^>]*>)/g)].map((m) => m[1]!);
    expect(firsts.length).toBe(2);
    for (const f of firsts) expect(f).toMatch(/^<div class="field\b/);
  });

  test("R2-L3: every Settings group is found by heading navigation: each group name is an <h4>, a form group's inside its legend", () => {
    for (const page of ["general", "projects", "providers", "advanced", "about"]) {
      const whole = body({ page });
      const from = whole.indexOf(`<div data-page="${page}"`);
      const next = whole.indexOf("<div data-page=", from + 1);
      const b = whole.slice(from, next < 0 ? whole.length : next);
      // A fieldset's legend holds its group's heading (legend content may be a heading), so the fieldset keeps its name.
      const legends = [...b.matchAll(/<legend[^>]*>([\s\S]*?)<\/legend>/g)].map((m) => m[1]!);
      expect(legends.length).toBeGreaterThan(page === "about" ? -1 : 0);
      for (const l of legends) expect({ page, l, heading: /^<h4\b[^>]*>[^<]+<\/h4>$/.test(l.trim()) }).toEqual({ page, l, heading: true });
      // Each tile's first heading is an h4: the group's name, whatever the group.
      for (const m of b.matchAll(/<section class="tile\b[^>]*>/g)) {
        const first = /<h([1-6])\b/.exec(b.slice(m.index!))?.[1];
        expect({ page, first }).toEqual({ page, first: "4" });
      }
    }
  });

  test("R2-L11: the marks are ≥ 3:1 against the selected entry too (where the unsaved ring usually sits)", () => {
    const sp = src("lib/settings/SettingsPages.svelte");
    const css = styleOf(sp);
    const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    const appCss = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
    const appDark = appCss.slice(appCss.indexOf("@media (prefers-color-scheme: dark)"));
    const hex = (sheet: string, name: string): string => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(sheet)?.[1] ?? "";
    const lum = (h: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string): number => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    // The selected entry's fill is the component's own --sel (the mockup's), light and dark.
    expect(rules(css).get('.entry[aria-current="page"]')).toContain("background: var(--sel);");
    const sel = { light: hex(css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)")), "--sel"), dark: hex(dark, "--sel") };
    expect(sel).toEqual({ light: "#e2ddd5", dark: "#2b2731" });
    const got: Record<string, number> = {};
    for (const [theme, sheet] of [["light", appCss], ["dark", appDark]] as const) {
      for (const mark of ["--tag-local", "--accent"]) {
        const value = hex(sheet, mark);
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
        got[`${theme} ${mark}`] = Math.round(ratio(value, sel[theme]) * 100) / 100;
        expect({ theme, mark, ok: ratio(value, sel[theme]) >= 3 }).toEqual({ theme, mark, ok: true });
      }
    }
    expect(got).toEqual({ "light --tag-local": 4.37, "light --accent": 10.55, "dark --tag-local": 7.37, "dark --accent": 5.3 });
  });

  test("V2: text and list rows are one column at every width — the control under its label and help, full width", () => {
    const form = top("routes/SettingsForm.svelte");
    expect(form.get(".field.wide")).toBe("grid-template-columns: minmax(0, 1fr); row-gap: 6px;");
    expect(form.get(".field.wide > *, .field.wide > label:not(.inline), .field.wide > .help, .field.wide > .help ~ .note")).toBe("grid-column: 1; grid-row: auto; justify-self: stretch;");
    expect(form.get(".field.wide > label:not(.inline)")).toBe("order: -2;");
    expect(form.get(".field.wide > .help")).toBe("order: -1;");
    expect(form.get(".field.wide > input, .field.wide > textarea")).toBe("width: 100%;");
    // Which rows: text and the three list kinds; a number, a select, the time and the notify row stay as rows.
    const b = body({ page: "general" }) + body({ page: "projects" }) + body({ page: "advanced" });
    const rowOf = (id: string): string => {
      const at = b.lastIndexOf('<div class="field', b.indexOf(`<label for="f-${id}"`));
      return /<div class="([^"]*)"/.exec(b.slice(at))?.[1] ?? "";
    };
    for (const id of ["repos", "excludeRepos", "author.names", "subprojects", "networkProbeHosts", "excludeCommitPatterns"]) expect({ id, wide: /\bwide\b/.test(rowOf(id)) }).toEqual({ id, wide: true });
    for (const id of ["lookbackCapDays", "morningTime", "updateCheck.enabled", "provider.promptVia", "provider.timeoutMs"]) expect({ id, wide: /\bwide\b/.test(rowOf(id)) }).toEqual({ id, wide: false });
    // Final round 3 (V9): the engine-notifications row while it shows its command's lines (the fixture's `notify` is a
    // command) is one column too; with a plain choice it stays a row. Its select keeps its own width.
    expect(rowOf("notify")).toMatch(/\bwide\b/);
    const plain = render(SettingsPages, { props: { ...SHELL_PROPS(), doc: DOC, draft: { ...parse(FULL_TEXT), notify: "auto" }, raw: FULL_TEXT, page: "advanced" } }).body;
    const at = plain.lastIndexOf('<div class="field', plain.indexOf('<label for="f-notify"'));
    expect(/<div class="([^"]*)"/.exec(plain.slice(at))?.[1]).not.toMatch(/\bwide\b/);
    expect(form.get(".field.wide > select")).toBe("justify-self: start;");
    const sf = src("routes/SettingsForm.svelte");
    expect(sf).toContain('<div class="field" class:wide={field.kind === "text" || field.kind === "lines" || field.kind === "subprojects" || field.kind === "hosts" || (field.kind === "notify" && current === "command")}>');
  });

  test("V11: a group named as its page (Advanced's first) keeps its name for the fieldset and heading navigation, drawn nowhere", () => {
    const b = body({ page: "advanced" });
    const from = b.indexOf('<div data-page="advanced"');
    const adv = b.slice(from, b.indexOf("<div data-page=", from + 1));
    expect(adv).toMatch(/<legend class="[^"]*\bsame\b[^"]*"><h4[^>]*>Advanced<\/h4><\/legend>/);
    // Final round 4 (V20): and the engine-notifications group, named as its one row; every other group's name shows
    // (General's Briefing, …).
    expect(b.match(/<legend class="[^"]*\bsame\b/g)?.length).toBe(2);
    expect(adv).toMatch(/<legend class="[^"]*\bsame\b[^"]*"><h4[^>]*>Notifications from the engine<\/h4><\/legend>/);
    expect(body({ page: "general" })).toMatch(/<legend class="svelte-[\w-]+"><h4[^>]*>Briefing<\/h4><\/legend>/);
    const form = top("routes/SettingsForm.svelte");
    expect(form.get("legend.same")).toBe("position: absolute; width: 1px; height: 1px; margin: 0; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;");
    expect(form.get("legend.same + .field")).toBe("margin-top: -0.65rem;");
  });

  // User-directed 2026-10-22: the page holds TWO groups, both drawn by the panel itself (the master switch's box, then
  // "Connections", small capitals), each a Tile; the page adds none (pins moved from "Sources" in one Tile).
  test("V3: Calendar's groups are Tiles — the master switch's box, then \"Connections\" in small capitals; the wizard's panel is unchanged", () => {
    const page = src("lib/settings/CalendarPage.svelte").replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
    // PB-M6-T1: the panel bound (its refresh after a flow) and the store's lock passed.
    expect(page).toContain('<div class="group"> <CalendarSettings bind:this={panel} {os} {onconfigchanged} {onstatus} locked={running !== null} /> </div>');
    expect(page).not.toContain("<Tile>");
    const cal = src("lib/CalendarSettings.svelte");
    const flat = cal.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
    // PB-M6-T1: the busy line, only while a calendar-question flow locks the panel, then the master switch's Tile.
    expect(flat).toContain('{#if mode === "settings"} {#if locked && busyLine !== null} <p class="mline" tabindex="-1">{busyLine}</p> {/if} <Tile> <div class="box master">');
    expect(flat).toContain('<Tile> <div class="box"> <div class="chead"> <h4>Connections</h4>');
    expect(cal).not.toContain("<h3>Calendar</h3>");
    expect(cal).not.toContain("<h4>Sources</h4>");
    const css = rules(styleOf(cal));
    expect(css.get(".panel")).not.toMatch(/border:|border-radius/);
    expect(css.get(".chead h4")).toContain("font-size: 11px;");
    expect(css.get(".chead h4")).toContain("text-transform: uppercase;");
    expect(css.get(".chead h4")).toContain("color: var(--muted);");
    // The wizard's mode draws neither the heading nor the panel class, nor a tile.
    const wiz = render(CalendarSettings, { props: { os: "linux", mode: "wizard", initial: { configText: "{}", list: null, status: null } } }).body;
    expect(wiz).not.toContain("Connections");
    expect(wiz).not.toContain('class="tile');
    // Final round 3 (delta LOW): read the section's whole class attribute — Svelte puts its scope class between the
    // static class and a `class:` one ("calendar svelte-… panel"), so a pattern on the attribute's start never saw it.
    const classOf = (body: string): string => /<section class="(calendar\b[^"]*)"/.exec(body)?.[1] ?? "<none>";
    expect(classOf(wiz)).toMatch(/^calendar svelte-\w+$/);
    expect(classOf(wiz)).not.toMatch(/\bpanel\b/);
    const settings = render(CalendarSettings, { props: { os: "linux", mode: "settings", initial: { configText: "{}", list: null, status: null } } }).body;
    expect(classOf(settings)).toMatch(/\bpanel\b/);
  });

  test("delta LOW: a group name's <h4> inside its legend takes the legend's look (no heading font or margins), in all three places", () => {
    for (const f of ["routes/SettingsForm.svelte", "lib/settings/GeneralPage.svelte", "lib/ProvidersList.svelte"]) {
      const css = rules(styleOf(src(f)));
      expect({ f, rule: css.get("legend h4") }).toEqual({ f, rule: "margin: 0; font: inherit;" });
    }
  });

  test("V4: the providers group's name is the small-capitals group name; its help 12px; the note on switching kinds after the groups", () => {
    const pl = rules(styleOf(src("lib/ProvidersList.svelte")));
    expect(pl.get("legend")).toContain("font-size: 11px;");
    expect(pl.get("legend")).toContain("text-transform: uppercase;");
    expect(pl.get("legend")).toContain("letter-spacing: 0.06em;");
    expect(pl.get("legend")).toContain("color: var(--muted);");
    expect(pl.get("legend")).toContain("font-weight: 400;");
    // Final round 3 (V16): placed as SettingsForm's legends are, to the pixel (it was 1-2px off with no padding).
    const sf = rules(styleOf(src("routes/SettingsForm.svelte")));
    for (const d of ["float: left;", "width: 100%;", "margin: calc(12px - 0.65rem) 0 0;"]) {
      expect({ d, providers: pl.get("legend")?.includes(d), form: sf.get("legend")?.includes(d) }).toEqual({ d, providers: true, form: true });
    }
    expect(pl.get("legend")).toContain("padding: 0 calc(14px - 0.8rem);");
    expect(sf.get("legend")).toContain("padding: 0 calc(14px - 0.8rem) 0;");
    expect(pl.get(".providers > .help")).toBe("clear: both; font-size: 12px;");
    const b = body({ page: "providers" });
    const from = b.indexOf('<div data-page="providers"');
    const page = b.slice(from, b.indexOf("<div data-page=", from + 1));
    // User-directed 2026-10-22 (P-A): the note under the list (settings-model's BACKUP_SETTINGS_NOTE), drawn with two or
    // more rows; P4's FIRST_PROVIDER_NOTE went with the first provider's box.
    const note = page.indexOf("Only the first provider's settings are changed here.");
    expect(note > -1).toBe((page.match(/<li class="row\b/g) ?? []).length > 1);
    if (note > -1) {
      expect(note).toBeGreaterThan(page.lastIndexOf("</fieldset>"));
      expect(page.slice(page.lastIndexOf("<p", note), note)).toMatch(/^<p class="muted/);
    }
    expect(page).not.toContain("To make another provider the first one");
  });

  // User-directed 2026-10-22 (P-A): the rows are compact heads that open in place (pins moved with the layout).
  test("V10 / P-A: the providers' rows are the mockup's flat items — edge to edge, a hairline between, the status at the right — opening in place; the buttons D's local look", () => {
    const pl = rules(styleOf(src("lib/ProvidersList.svelte")));
    expect(pl.get(".row")).toBe("border-top: 1px solid var(--tile-border); font-size: 13px;");
    expect(pl.get(".line")).toBe("display: flex; align-items: center; gap: 8px; padding-left: 14px;");
    expect(pl.get("button.head")).toBe("flex: 1; display: flex; align-items: baseline; gap: 10px; min-width: 0; margin: 0; padding: 9px 14px 9px 2px; border: 0; border-radius: 0; background: transparent; color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer; outline-offset: -2px;");
    expect(pl.get(".status")).toBe("flex: none; max-width: 45%; font-size: 11.5px; text-align: right;");
    expect(pl.get(".details")).toBe("padding: 2px 14px 12px 50px; display: flex; flex-direction: column; gap: 4px;");
    expect(pl.get(".details[hidden]")).toBe("display: none;");
    expect(pl.get(".list")).toBe("list-style: none; margin: 8px -0.8rem 0; padding: 0; display: flex; flex-direction: column; gap: 0;");
    expect(pl.get("button")).toBe("font: inherit; font-size: 12.5px; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--tile-border); background: var(--tile); color: var(--fg); cursor: pointer;");
    // No grey box: no fill, no radius on a row.
    expect(pl.get(".row")).not.toMatch(/background|border-radius|var\(--panel\)/);
    // The row draws its head (with the status), then in its details the sentence, the notes, the actions, in order.
    const view = providersView({ draft: parse(text({ ...BASE })), savedText: LOADED, rows: null, now: new Date() });
    const row = render(ProvidersList as never, { props: { view, ontest: () => {}, onmove: () => {}, onremove: () => {} } }).body.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
    const li = row.slice(row.indexOf('<li class="row'), row.indexOf("</li>"));
    const order = ['class="head', 'class="status', 'class="details', 'class="sentence', 'class="actions'].map((k) => li.indexOf(k));
    expect(order.every((i, n) => i > -1 && (n === 0 || i > order[n - 1]!))).toBe(true);
    // Move up / Move down only where each can act: the first row has Move down, no Move up.
    for (const name of ["Move down", "Test", "Remove"]) expect({ name, drawn: new RegExp(`<button[^>]*>\\s*${name}\\b`).test(li) }).toEqual({ name, drawn: true });
    expect(/>\s*Move up\b/.test(li)).toBe(false);
  });

  test("V5 / V14: the idle Uninstall button is the mockup's danger button — red words, a pale tint of red for its border; Working… is the disabled look", () => {
    const up = rules(styleOf(src("lib/settings/UninstallPanel.svelte")));
    expect(up.get(".idle button:not(:disabled)")).toBe("color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--tile));");
  });

  test("V12: the Terminal command, Edit settings as JSON, Settings file and Uninstall are headerless groups — the name is the row's 13px/600 label, still the group's <h4>", () => {
    const label = "font-size: 13px; font-weight: 600; color: var(--fg);";
    const cases: [string, string][] = [
      ["lib/settings/CliShimControl.svelte", "h4"],
      ["lib/settings/UninstallPanel.svelte", "h4"],
      ["lib/settings/AboutPage.svelte", "h4"],
      ["lib/settings/AdvancedPage.svelte", ".json > h4"],
    ];
    for (const [f, sel] of cases) {
      const r = rules(styleOf(src(f))).get(sel) ?? "";
      expect({ f, label: r.includes(label), smallCaps: /uppercase|letter-spacing|font-size: 11px/.test(r) }).toEqual({ f, label: true, smallCaps: false });
    }
    // Each still opens its tile with an <h4> (R2-L3), and the name is the label of the row the button sits beside.
    const b = body({ page: "advanced" }) + body({ page: "about" });
    for (const name of ["The daily-briefing command in Terminal", "Settings file as JSON", "Settings file", "Uninstall"]) {
      expect({ name, heading: b.includes(`>${name}</h4>`) }).toEqual({ name, heading: true });
    }
    // The button beside the label and its help: its grid area starts on the label's line.
    expect(top("lib/settings/CliShimControl.svelte").get(".block > .row")).toContain("grid-row: 1 / span 4;");
    expect(top("lib/settings/UninstallPanel.svelte").get(".block > .idle")).toContain("grid-row: 1 / span 2;");
    const json = rules(styleOf(src("lib/settings/AdvancedPage.svelte")));
    expect(json.get(".json")).toContain("display: grid;");
    expect(json.get(".row")).toBe("display: contents;");
    expect(json.get(".action")).toBe("grid-column: 2; grid-row: 1 / span 2; white-space: nowrap;");
  });

  test("V13: every group's last line ends at the row's 11px inset; Calendar's group keeps the 14px below it", () => {
    expect(rules(styleOf(src("lib/UpdateCheck.svelte"))).get(".updates")).toBe("clear: both; margin: 0 -0.8rem -0.65rem;");
    expect(rules(styleOf(src("lib/settings/AppGeneralControls.svelte"))).get(".block > p:last-of-type")).toBe("margin-bottom: 0;");
    expect(rules(styleOf(src("lib/settings/CliShimControl.svelte"))).get(".block > p:last-of-type")).toBe("margin-bottom: 0;");
    expect(rules(styleOf(src("lib/settings/UninstallPanel.svelte"))).get(".block > p:last-of-type, .block > .row:last-child")).toBe("margin-bottom: 0;");
    const cal = src("lib/settings/CalendarPage.svelte");
    // User-directed 2026-10-22: the panel draws its own two Tiles; the page's wrapper keeps the 14px below them.
    expect(cal.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ")).toContain('<div class="group"> <CalendarSettings bind:this={panel} {os} {onconfigchanged} {onstatus} locked={running !== null} /> </div>');
    expect(rules(styleOf(cal)).get(".group")).toBe("margin: 0 0 14px;");
  });

  test("V6: Morning time's two selects take the row's input look (MorningTimeSelect itself unchanged, shared with the Wizard)", () => {
    const form = top("routes/SettingsForm.svelte");
    expect(form.get(".field :global(.time select)")).toBe("font-size: 13px; padding: 5px 9px; border: 1px solid var(--tile-border); border-radius: 6px; background: var(--surface, var(--bg));");
    expect(form.get(".field :global(.time)")).toBe("margin-top: 0;");
  });

  test("V7: the small ones — plain icon strokes, entries stacked, room under the last group, About's path muted, the renamed groups", () => {
    const sp = rules(styleOf(src("lib/settings/SettingsPages.svelte")));
    expect(sp.get(".icon")).not.toMatch(/stroke-line(cap|join)/);
    expect(sp.get(".sidebar")).toContain("gap: 0;");
    // Each page ends 58px above the box (its last group's 14px and this): never the content's padding, which would
    // put a gap under the pinned bar.
    expect(sp.get("[data-page]")).toBe("padding-bottom: 44px;");
    expect(top("lib/settings/SettingsPages.svelte").get(".content")).toContain("padding: 22px var(--gutter) 0;");
    expect(rules(styleOf(src("lib/settings/AboutPage.svelte"))).get(".path")).toContain("color: var(--muted);");
    const b = body({ page: "advanced" });
    expect(b).toMatch(/<h4[^>]*>The daily-briefing command in Terminal<\/h4>/);
    expect(b).toMatch(/<h4[^>]*>Settings file as JSON<\/h4>/);
    expect(b).not.toContain("Command-line tool<");
    expect(b).not.toContain("All settings as JSON");
    // Left as it is (load-bearing): the engine-notify group keeps the section title the engine's remedy names
    // ("Fix it in Settings → Advanced, under Notifications from the engine.", notify.ts) and SECTIONS keys on.
    expect(b).toMatch(/<legend[^>]*><h4[^>]*>Notifications from the engine<\/h4><\/legend>/);
  });
});

describe("Final round 4, section 1: the redraw and a refused input", () => {
  const shellCode = (): string => readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");

  test("R4-M1: the engine-default toggle UNMARKS its field — its list was just drawn again from the draft (keyed on the toggle), so no later reset draws it again", () => {
    const id = "networkProbeHosts";
    // A refused text in the list, then the toggle: the list is drawn again at once, so its mark goes.
    expect(redrawAfterDefault(redrawAfterField(NO_REDRAW, id, true), id)).toEqual(NO_REDRAW);
    // Ticked and unticked with nothing refused (the form clean again): nothing is marked, so a reload landing while the
    // user types in that list (a Calendar write, the engine-notify offer) leaves its node — the probe's sequence f.
    const toggled = redrawAfterDefault(redrawAfterDefault(NO_REDRAW, id), id);
    expect(toggled).toEqual(NO_REDRAW);
    expect(redrawAfterReset(toggled).count).toEqual({});
    // Another field's mark is not touched, and its count goes on.
    const other = redrawAfterField({ pending: [], count: { [id]: 2 } }, "lookbackCapDays", true);
    expect(redrawAfterDefault(other, id)).toEqual({ pending: ["lookbackCapDays"], count: { [id]: 2 } });
    expect(shellCode()).toContain(
      'function ondefault(f: Field, on: boolean): void { if (draft === null) return; if (on) useDefault(draft, f); else useEmptyList(draft, f); errors[f.id] = ""; redraw = redrawAfterDefault(redraw, f.id); }',
    );
  });

  test("R4-M2, kept by post-cap R5-H1: a background reload never draws a marked field again nor clears its error", () => {
    // Round 4 made the reload WAIT while a field was marked, and remembered nothing, so the screen kept showing an old
    // file and every Save was refused as a conflict until Discard (R5-H1). Now the reload runs (the draft clean) and
    // the background path leaves `errors` and `redraw` as they are: a marked input's value prop does not change in a
    // Calendar or notify write, so Svelte leaves its text, focus and error alone. The user's own resets (Discard,
    // Reload, after a save, the editor left) still draw the marked fields again.
    const shell = shellCode();
    const bg = shell.slice(shell.indexOf("async function backgroundReload()"), shell.indexOf("$effect(() => { if (owedReloadRuns("));
    // Final small fix (test gap): an empty slice (a marker renamed or moved) passed the negative match; it is the
    // function, whole, before it is read.
    expect(bg.startsWith("async function backgroundReload(): Promise<void> { backgroundReloads += 1; const asked = screenStamp();")).toBe(true);
    expect(bg.trimEnd().endsWith("askNetworkFor = null; }")).toBe(true);
    expect(bg).not.toMatch(/redraw = |errors = |errors\[/);
    expect(shell).toContain("async function discardChanges(): Promise<void> {");
    expect(shell).toContain("onreload={() => load(false)}");
    const pagesSrc = readFileSync(new URL("../src/lib/settings/AppGeneralControls.svelte", import.meta.url), "utf8");
    expect(pagesSrc).toContain('if (outcome.kind === "saved") onconfigchanged?.();');
  });

  test("R4-M3 (pre-existing on main): a remount draws every field from the kept draft, so it restores no error", () => {
    // A refused value is never in the draft; the remounted input shows the draft's value. Restoring the old error then
    // marked text no longer on screen, and Save was refused for it with no way to clear it (high-rigor, p4).
    const mount = shellCode().slice(shellCode().indexOf("onMount(() => {"), shellCode().indexOf("onDestroy(() => {"));
    expect(mount.startsWith("onMount(() => { void loadApp();")).toBe(true);
    expect(mount).toContain("doc = { ...next, base: k.base, text: k.loadedText }; void refreshSavedRows(k.loadedText); tab = k.tab; draft = k.draft; raw = k.raw; restored = true; reloadOwed = next.base !== k.base; openInitial(k);");
    expect(mount).not.toMatch(/errors = /);
    // The kept draft saves as it is: with no errors restored nothing blocks it.
    const draft = parse(LOADED);
    draft["lookbackCapDays"] = 5;
    expect(formSubmission(draft, LOADED, {}).kind).toBe("save");
  });

  test("R4-M4 (pre-existing on main): the login folder's input shows what the draft holds after each change, so a refused folder never stays on screen", () => {
    const pl = readFileSync(new URL("../src/lib/ProvidersList.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(pl).toContain(
      'onchange={async (e) => { const input = e.currentTarget as HTMLInputElement; onfolder(row.label, input.value); await tick(); input.value = shownFolder(row.label); }}',
    );
    expect(pl).toContain('const shownFolder = (label: string): string => (view.readable ? (view.rows.find((r) => r.label === label)?.configDir ?? "") : "");');
    // The refusal itself (a Codex first entry cannot take a folder): the draft keeps its folder-less entry.
    const d = parse(text({ repos: ["~/code/alpha"], provider: { cli: "codex", argv: ["exec"], promptVia: "stdin" } }));
    // Post-cap (delta LOW-2): the input goes back at once, so the message says the folder was left as it was — not
    // "Clear its login folder first", which is the MOVE's remedy (a folder already there; pinned in settings.check.ts).
    expect(setLoginFolder(d, "default", "/tmp/x")).toBe(
      'Not changed: "default" is the first provider, and only a Claude command-line login can use a login folder there. Its login folder is left as it was.',
    );
    const v = providersView({ draft: d, savedText: rawFromDraft(d), rows: null, now: new Date() });
    expect(v.readable && v.rows[0]!.configDir).toBeNull();
  });
});

describe("Final round 4, section 2: focus and scroll", () => {
  const read = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  const flat = (f: string): string => read(f).replace(/\s+/g, " ");
  const here = (over: Partial<{ page: PageId; blocked: PageId[]; outcomeShown: boolean; pressed: { page: PageId; at: number } }> = {}) => ({ page: "providers" as PageId, blocked: [] as PageId[], outcomeShown: true, ...over });

  test("R4-M5: keepClearScrolls — a focus from a pointer press never moves the control under the pointer; the keyboard's still does", () => {
    const dock = { top: 588, bottom: 640 };
    const under = { top: 576, bottom: 607 };
    const keyboard = { pointer: false, focusVisible: true, el: under, dock };
    expect(keepClearScrolls(keyboard)).toBe(true);
    // A text field clicked, double-clicked or drag-selected matches `:focus-visible` too: the press decides.
    expect(keepClearScrolls({ ...keyboard, pointer: true })).toBe(false);
    // A focus the browser does not show (a button clicked, then focused by script) is left where it is.
    expect(keepClearScrolls({ ...keyboard, focusVisible: false })).toBe(false);
    // Clear of the dock, or no dock drawn (nothing to save): nothing to do.
    expect(keepClearScrolls({ ...keyboard, el: { top: 500, bottom: 588 } })).toBe(false);
    expect(keepClearScrolls({ ...keyboard, el: { top: 640, bottom: 670 } })).toBe(false);
    expect(keepClearScrolls({ ...keyboard, dock: { top: 640, bottom: 640 } })).toBe(false);
    // …even for a control across that line (post-cap: the round-5 delta's X5 survived, as no case straddled it).
    expect(keepClearScrolls({ ...keyboard, el: { top: 630, bottom: 650 }, dock: { top: 640, bottom: 640 } })).toBe(false);
    // Wholly under the dock, and partly under it from below.
    expect(keepClearScrolls({ ...keyboard, el: { top: 600, bottom: 630 } })).toBe(true);
    expect(keepClearScrolls({ ...keyboard, el: { top: 630, bottom: 660 } })).toBe(true);
  });

  test("R4-L3: shownFocus — an engine without `:focus-visible` (WebKitGTK before 2.36) throws on it; then the pointer alone decides", () => {
    expect(shownFocus({ matches: (s) => s === ":focus-visible" })).toBe(true);
    expect(shownFocus({ matches: () => false })).toBe(false);
    expect(
      shownFocus({
        matches: () => {
          throw new SyntaxError("':focus-visible' is not a valid selector");
        },
      }),
    ).toBe(true);
  });

  test("R4-M5 / R4-L3: the content's keepClear reads the press from the window and asks the two functions", () => {
    const pages = flat("lib/settings/SettingsPages.svelte");
    expect(pages).toContain(
      'function keepClear(e: FocusEvent): void { const el = e.target; if (!(el instanceof HTMLElement) || el.closest("[data-page]") === null) return; const dock = (e.currentTarget as HTMLElement).querySelector(".dock"); if (dock === null) return; if (keepClearScrolls({ pointer: pressing, focusVisible: shownFocus(el), el: el.getBoundingClientRect(), dock: dock.getBoundingClientRect() })) el.scrollIntoView({ block: "nearest" }); }',
    );
    expect(pages).not.toContain('matches(":focus-visible")');
    expect(pages).toContain("<svelte:window onpointerdown={pressed} onpointerup={released} onpointercancel={released} onkeydown={keyed} onwheel={scrolled} />");
    expect(pages).toContain("const pressed = (): void => { pressing = true; lastInput = performance.now(); };");
    expect(pages).toContain("const released = (): void => { pressing = false; };");
    expect(pages).toContain("const keyed = (): void => { pressing = false; lastInput = performance.now(); };");
    expect(pages).toContain("const scrolled = (): void => { lastInput = performance.now(); };");
  });

  test("R4-M6: a flow's Save that waited moves the view only on the page it was pressed on, and only if the user did nothing since", () => {
    const pressed = { page: "providers" as PageId, at: 1000 };
    // Pressed on AI providers, landed there: the outcome, stamped with the press.
    expect(revealFor("flow-save", here({ pressed }))).toEqual({ target: "outcome", focus: false, since: 1000 });
    // The user went to another page meanwhile: no request at all — the outcome area (aria-live) announces it.
    expect(revealFor("flow-save", here({ page: "general", pressed }))).toBeNull();
    expect(revealFor("flow-save", here({ pressed, outcomeShown: false }))).toBeNull();
    // On the page, but they pressed, typed or scrolled after the press: the request stands down when it acts.
    const r = nextReveal(NO_REVEAL, revealFor("flow-save", here({ pressed })));
    expect(revealStillWanted(r, 999)).toBe(true);
    expect(revealStillWanted(r, 1000)).toBe(true);
    expect(revealStillWanted(r, 1000.1)).toBe(false);
    // Every other request has no stamp and always acts.
    expect(revealStillWanted(nextReveal(NO_REVEAL, revealFor("save", here())), 1e12)).toBe(true);
    // The shell stamps both flows' Saves at the press, before anything is awaited, and hands the stamp over.
    const shell = flat("routes/Settings.svelte");
    const body = (start: string, next: string): string => shell.slice(shell.indexOf(start), shell.indexOf(next, shell.indexOf(start)));
    const replace = body("async function onproviderreplacesave()", "async function onproviderreplacediscard()");
    expect(replace).toContain('replacing = { ...r, busy: true, lines: [] }; replaceCancelled = false; const pressed: Pressed = { page, at: performance.now() };');
    expect(replace).toContain('if (result.kind === "cancelled") return; if (submitted) requestReveal("flow-save", pressed);');
    const add = body("async function onprovideraddsave()", "async function onprovideradddiscard()");
    expect(add).toContain("adding = { busy: true, lines: adding?.lines ?? [], pending: p }; const pressed: Pressed = { page, at: performance.now() };");
    expect(add).toContain('requestReveal("flow-save", pressed); }');
    expect(shell).toContain(
      "function requestReveal(action: RevealAction, pressed?: Pressed): void { reveal = nextReveal(reveal, revealFor(action, { page, blocked, outcomeShown: hasOutcome({ outcome, failure, keyLines, judgeLine }), pressed })); }",
    );
    // SettingsPages asks first, before any target.
    expect(flat("lib/settings/SettingsPages.svelte")).toContain("function show(content: HTMLElement, r: Reveal): void { if (!revealStillWanted(r, lastInput)) return;");
  });

  test("R4-M7: the bar's \"fix the marked fields on <page>\" opens that page at its first marked field, focused — not at its title", () => {
    expect(revealFor("fix-page", here())).toEqual({ target: "field", focus: true });
    expect(revealFor("fix-page", here({ blocked: [], outcomeShown: false }))).toEqual({ target: "field", focus: true });
    const shell = flat("routes/Settings.svelte");
    expect(shell).toContain('function fixOn(to: PageId): void { if (openPage(to, false)) requestReveal("fix-page"); }');
    // The page change itself does not focus the title then (the reveal does what it says; the title only when no
    // marked field is drawn), and every other page change still does.
    expect(shell).toContain("tab = next.tab; page = next.page; pageFocus = title; rememberPage(page); return true; }");
    expect(shell).toContain("function openPage(to: PageId, title = true): boolean {");
    expect(shell).toContain("onopenpage={fixOn}");
    expect(shell).toContain("onpage={openPage}");
  });

  test("R4-L1: revealTakesFocus — the title (a Discard's, a fallback's) takes the focus only from nothing, a disabled control or the dock", () => {
    for (const at of ["nothing", "disabled", "dock"] as const) expect({ at, t: revealTakesFocus("title", true, at) }).toEqual({ at, t: true });
    // A slow Discard (a pending Replace awaited), and the user clicked a field and typed meanwhile: left alone.
    expect(revealTakesFocus("title", true, "elsewhere")).toBe(false);
    // The outcome: when asked, or when the action left the focus on nothing or a disabled control (round 3's rule).
    expect(revealTakesFocus("outcome", true, "elsewhere")).toBe(true);
    expect(revealTakesFocus("outcome", false, "nothing")).toBe(true);
    expect(revealTakesFocus("outcome", false, "disabled")).toBe(true);
    expect(revealTakesFocus("outcome", false, "dock")).toBe(false);
    expect(revealTakesFocus("outcome", false, "elsewhere")).toBe(false);
    // The marked field: always (the bar's Save refused, or its fix button: answered at once).
    expect(revealTakesFocus("field", true, "elsewhere")).toBe(true);
    const pages = flat("lib/settings/SettingsPages.svelte");
    expect(pages).toContain(
      'function focusAt(): FocusAt { const a = document.activeElement; if (a === null || a === document.body) return "nothing"; if (a.matches(":disabled")) return "disabled"; return a.closest(".dock") !== null ? "dock" : "elsewhere"; }',
    );
    expect(pages).toContain('if (revealTakesFocus("outcome", r.focus, focusAt())) o.focus({ preventScroll: true }); return; }');
    expect(pages).toContain('const title = box.querySelector("h3.title"); if (title instanceof HTMLElement && revealTakesFocus("title", r.focus, focusAt())) { title.focus({ preventScroll: true }); title.scrollIntoView({ block: "nearest" }); } }');
  });

  test("R4-L2: the editor opened from the button takes the focus and brings its group to the window's top (the page got shorter under it)", () => {
    const adv = flat("lib/settings/AdvancedPage.svelte");
    expect(adv).toContain('<textarea id="raw-config" rows="24" spellcheck="false" bind:value={raw} readonly={readOnly} aria-describedby={readOnly ? "raw-saving" : undefined} use:openedHere={opened}></textarea>');
    expect(adv).toContain(
      'const openedHere: Action<HTMLTextAreaElement, boolean> = (node, active) => { if (active) queueMicrotask(() => { if (!node.isConnected) return; node.focus({ preventScroll: true }); node.closest(".group")?.scrollIntoView({ block: "start" }); }); };',
    );
    expect(adv).not.toContain("focusHeading");
  });
});

/* Final round 4, section 3 (user-directed 2026-10-21: the S-A mockup's look). As D-M5-T11, a server render has no
 * layout: the rules are pinned by their exact selectors, the markup by the render. */
describe("Final round 4, section 3: the look", () => {
  const src = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  const styleOf = (s: string): string => s.slice(s.indexOf("<style>") + "<style>".length, s.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");
  /** The inside of the first `@media <query> {` block, and the style without it. */
  const block = (css: string, query: string): { rest: string; inside: string } => {
    const at = css.indexOf(`@media ${query} {`);
    if (at < 0) return { rest: css, inside: "" };
    let depth = 0;
    for (let i = css.indexOf("{", at); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) return { rest: css.slice(0, at) + css.slice(i + 1), inside: css.slice(css.indexOf("{", at) + 1, i) };
    }
    return { rest: css, inside: "" };
  };
  const rules = (css: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.set(m[1]!.replace(/\s+/g, " ").trim(), m[2]!.replace(/\s+/g, " ").trim());
    return out;
  };
  const NARROW = "(max-width: 720px)";
  const DARK = "(prefers-color-scheme: dark)";
  const lum = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string): number => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  const appCss = src("app.css");
  const appDark = appCss.slice(appCss.indexOf("@media (prefers-color-scheme: dark)"));
  const token = (css: string, name: string): string => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(css)?.[1] ?? "";

  test("V17: Morning time's two selects sit in the row's control column, as every other control (MorningTimeSelect's own span, unchanged)", () => {
    const css = styleOf(src("routes/SettingsForm.svelte"));
    const { rest, inside } = block(css, NARROW);
    // SettingsForm's scoped `.field > *` never matches MorningTimeSelect's `.time` (another component's element), so
    // the span fell into the label's column: the label 24px from the row's top instead of 11-12px.
    expect(rules(rest).get(".field > :global(.time)")).toBe("grid-column: 2; grid-row: span 2; justify-self: end;");
    expect(rules(inside).get(".field > :global(.time)")).toBe("grid-column: 1; grid-row: auto; justify-self: start;");
    // The row rule it mirrors.
    expect(rules(rest).get(".field > *")).toBe("grid-column: 2; grid-row: span 2; justify-self: end;");
    expect(src("lib/MorningTimeSelect.svelte")).toContain('<span class="time">');
  });

  test("V18: the providers' status words in their tones — green working, amber waiting — each ≥ 4.5:1 on the tile in both themes", () => {
    const css = styleOf(src("lib/ProvidersList.svelte"));
    const { rest, inside } = block(css, DARK);
    const top = rules(rest);
    // `--ok` was defined nowhere, so `var(--ok, inherit)` drew "working" in the text colour.
    expect(css).not.toContain("--ok,");
    expect(top.get(".tone-ok")).toBe("color: var(--tone-ok);");
    expect(top.get(".tone-warn")).toBe("color: var(--tag-local);");
    expect(top.get(".tone-bad")).toBe("color: var(--danger);");
    const okLight = /--tone-ok:\s*(#[0-9a-f]{6})/.exec(top.get(".providers") ?? "")?.[1] ?? "";
    const okDark = /--tone-ok:\s*(#[0-9a-f]{6})/.exec(rules(inside).get(".providers") ?? "")?.[1] ?? "";
    expect([okLight, okDark]).toEqual(["#15803d", "#4ade80"]);
    for (const [theme, sheet, ok] of [["light", appCss, okLight], ["dark", appDark, okDark]] as const) {
      const tile = token(sheet, "--tile");
      expect(tile).toMatch(/^#[0-9a-f]{6}$/);
      for (const [tone, value] of [["ok", ok], ["warn", token(sheet, "--tag-local")]] as const) {
        expect({ theme, tone, ok: ratio(value, tile) >= 4.5 }).toEqual({ theme, tone, ok: true });
      }
    }
    expect(ratio(okLight, "#ffffff")).toBeCloseTo(5.02, 1);
  });

  // User-directed 2026-10-22 (P-A): the list's footer row holds Test all (when its handler is passed) and the primary
  // "Add a provider…", on the right (pin moved from `.add-row`).
  test("V19 / P-A: the list ends with the mockup's footer — Test all, then the primary \"Add a provider…\", on the right", () => {
    const view = providersView({ draft: parse(LOADED), savedText: LOADED, rows: null, now: new Date() });
    const b = render(ProvidersList, { props: { view, onadd: () => true } }).body.replace(/<!--[\s\S]*?-->/g, "");
    expect(b).toMatch(/<div class="foot[^"]*">\s*<button type="button" class="primary[^"]*">Add a provider…<\/button><\/div>\s*<\/fieldset>/);
    const both = render(ProvidersList, { props: { view, onadd: () => true, ontestall: () => {} } }).body.replace(/<!--[\s\S]*?-->/g, "");
    expect(both).toMatch(/<div class="foot[^"]*">\s*<button type="button"[^>]*>Test all — uses a little of your plan<\/button>\s*<button type="button" class="primary[^"]*">Add a provider…<\/button><\/div>\s*<\/fieldset>/);
    expect(rules(styleOf(src("lib/ProvidersList.svelte"))).get(".foot")).toBe("display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin: 0 -0.8rem; padding: 9px 14px; border-top: 1px solid var(--tile-border);");
  });

  test("V20: a one-field group whose name is its field's label (\"Notifications from the engine\") keeps its name for the fieldset, drawn once", () => {
    const sf = src("routes/SettingsForm.svelte").replace(/\s+/g, " ");
    // User-directed 2026-10-22 (P-A): P4's retitling went with the first provider's box; every section draws its title.
    expect(sf).toContain("<legend class:same={nameShownElsewhere(section)}><h4>{section.title}</h4></legend>");
    expect(sf).toContain(
      "const nameShownElsewhere = (s: { title: string; page: string; fields: Field[] }): boolean => PAGES.find((p) => p.id === s.page)?.label === s.title || (s.fields.length === 1 && s.fields[0]!.label === s.title);",
    );
    // The section's title is unchanged (the engine's remedy names it, and SECTIONS keys on it).
    expect(SECTIONS.find((s) => s.title === "Notifications from the engine")?.fields.map((f) => f.label)).toEqual(["Notifications from the engine"]);
    // Every other group's name shows: no other section is named as its only field.
    expect(SECTIONS.filter((s) => s.fields.length === 1 && s.fields[0]!.label === s.title).map((s) => s.title)).toEqual(["Notifications from the engine"]);
  });

  test("V21: the JSON editor's own label is the row's 12px muted help under the group's name, not a second bold line", () => {
    const adv = src("lib/settings/AdvancedPage.svelte");
    expect(rules(styleOf(adv)).get(".raw-label")).toBe("display: block; font-size: 12px; color: var(--muted);");
    expect(adv).toContain('<label class="raw-label" for="raw-config">The whole settings file, as JSON</label>');
  });
});

describe("Final round 4, section 4: the look rules a mutant could drop unseen, and the small ones", () => {
  const src = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  const styleOf = (s: string): string => s.slice(s.indexOf("<style>") + "<style>".length, s.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");
  /** Top-level rules only (no `@media` block's), by their selector lists. */
  const rules = (css: string): Map<string, string> => {
    const flat = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    const out = new Map<string, string>();
    for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.set(m[1]!.replace(/\s+/g, " ").trim(), m[2]!.replace(/\s+/g, " ").trim());
    return out;
  };
  const lum = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string): number => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };

  test("K12: the JSON editor's group lays every part across the row's full width but the label and its button", () => {
    // Without it the open editor was squeezed into the grid's first column (measured 432px → 220px wide).
    const json = rules(styleOf(src("lib/settings/AdvancedPage.svelte")));
    expect(json.get(".json > *")).toBe("grid-column: 1 / -1;");
    expect(json.get(".json > h4")).toContain("grid-column: 1;");
  });

  test("K10, K11, K13, K14, K18: the providers list's V10 rules — the hairline, the edges, the inset, the primary border", () => {
    const pl = rules(styleOf(src("lib/ProvidersList.svelte")));
    // User-directed 2026-10-22 (P-A): the hairline under the list is the footer row's own top border now (`.foot`, V19).
    expect(pl.get(".list:not(:last-child)")).toBeUndefined();
    expect(pl.get(".list:last-child")).toBe("margin-bottom: -0.65rem;");
    expect(pl.get(".providers > :not(legend, .list, .foot)")).toBe("margin-inline: calc(14px - 0.8rem);");
    expect(pl.get("button.primary")).toBe("background: var(--accent); color: var(--on-accent); border-color: var(--accent);");
    expect(pl.get(".providers > :last-child:not(.list, .foot)")).toBe("margin-bottom: calc(11px - 0.65rem);");
    expect(pl.get(".providers > .foot:last-child")).toBe("margin-bottom: -0.65rem;");
  });

  test("visual LOW: the form's placeholders in --muted, ≥ 4.5:1 on the inputs' surface in both themes (Chrome's own grey was 4.23:1 / 3.93:1)", () => {
    const sf = rules(styleOf(src("routes/SettingsForm.svelte")));
    expect(sf.get("input::placeholder, textarea::placeholder")).toBe("color: var(--muted); opacity: 1;");
    const app = src("app.css");
    const appDark = app.slice(app.indexOf("@media (prefers-color-scheme: dark)"));
    const sp = styleOf(src("lib/settings/SettingsPages.svelte"));
    const spDark = sp.slice(sp.indexOf("@media (prefers-color-scheme: dark)"));
    const hex = (css: string, name: string): string => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(css)?.[1] ?? "";
    for (const [theme, muted, surface] of [["light", hex(app, "--muted"), hex(sp, "--surface")], ["dark", hex(appDark, "--muted"), hex(spDark, "--surface")]] as const) {
      expect({ theme, muted, surface }).toEqual({ theme, muted: expect.stringMatching(/^#[0-9a-f]{6}$/), surface: expect.stringMatching(/^#[0-9a-f]{6}$/) });
      expect({ theme, ok: ratio(muted, surface) >= 4.5 }).toEqual({ theme, ok: true });
    }
  });

  test("visual LOW: the Terminal command's error ends at the row's 11px inset (no block margin under it)", () => {
    expect(rules(styleOf(src("lib/settings/CliShimControl.svelte"))).get(".bad")).toBe("margin: 4px 0 0; color: var(--danger); font-size: 12px;");
  });
});

describe("Post-cap, section 1: background reloads and saves (R5-H1, codex R5-M1, R5-M2)", () => {
  const shell = (): string => readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
  const fnOf = (code: string, start: string, next: string): string => code.slice(code.indexOf(start), code.indexOf(next, code.indexOf(start)));
  const quiet: ScreenStamp = { editing: false, saving: false, text: "form:{}", marked: [] };

  test("R5-H1: backgroundReloadApplies — a clean screen draws the file at once, a marked field included; an unsaved edit or a save in flight owes it", () => {
    expect(backgroundReloadApplies(quiet, quiet)).toBe(true);
    // A field still showing a refused value no longer holds the reload back (round 4's wait, never run): the shell's
    // background path keeps the mark and the error, so the field keeps its input.
    const marked: ScreenStamp = { ...quiet, marked: ["lookbackCapDays"] };
    expect(backgroundReloadApplies(marked, marked)).toBe(true);
    // An unsaved edit, or a save in flight, at either moment: owed.
    for (const over of [{ editing: true }, { saving: true }] as const) {
      expect({ over, asked: backgroundReloadApplies({ ...quiet, ...over }, quiet) }).toEqual({ over, asked: false });
      expect({ over, now: backgroundReloadApplies(quiet, { ...quiet, ...over }) }).toEqual({ over, now: false });
    }
  });

  test("codex R5-M1: the read in flight — typed, opened the editor or refused meanwhile: the read is not drawn", () => {
    // Typed and taken (the draft's text moved), even back to clean by the time the read answers.
    expect(backgroundReloadApplies(quiet, { ...quiet, text: "form:{\"lookbackCapDays\": 6}" })).toBe(false);
    // The JSON editor opened meanwhile (same content, another tab).
    expect(backgroundReloadApplies(quiet, { ...quiet, text: "raw:{}" })).toBe(false);
    // A value refused meanwhile (the draft unchanged, a field marked), and a mark that went (the value taken).
    expect(backgroundReloadApplies(quiet, { ...quiet, marked: ["lookbackCapDays"] })).toBe(false);
    expect(backgroundReloadApplies({ ...quiet, marked: ["lookbackCapDays"] }, quiet)).toBe(false);
    expect(backgroundReloadApplies({ ...quiet, marked: ["a", "b"] }, { ...quiet, marked: ["a"] })).toBe(false);
  });

  test("R5-H1: owedReloadRuns — an owed reload runs once the draft is clean and no save is in flight, and only then", () => {
    expect(owedReloadRuns(true, { editing: false, saving: false, tab: "form" })).toBe(true);
    expect(owedReloadRuns(true, { editing: true, saving: false, tab: "form" })).toBe(false);
    expect(owedReloadRuns(true, { editing: false, saving: true, tab: "form" })).toBe(false);
    expect(owedReloadRuns(false, { editing: false, saving: false, tab: "form" })).toBe(false);
  });

  test("R5-H1 wiring: both background writes go through backgroundReload, which asks twice, remembers what it owes, and draws without the user's resets", () => {
    const code = shell();
    expect(fnOf(code, "function calendarChangedConfig()", "/** A reload the user did not ask for")).toBe("function calendarChangedConfig(): void { void backgroundReload(); } ");
    expect(fnOf(code, "async function backgroundReload()", "$effect(() => { if (owedReloadRuns(")).toBe(
      "async function backgroundReload(): Promise<void> { backgroundReloads += 1; const asked = screenStamp(); reloadOwed = !backgroundReloadApplies(asked, asked); if (reloadOwed) return; let next: ConfigDocument; try { next = await configRead(); } catch (e) { if (!backgroundReloadApplies(asked, screenStamp())) { reloadOwed = true; return; } loadFailure = describeFailure(e); return; } if (!backgroundReloadApplies(asked, screenStamp())) { reloadOwed = true; return; } restored = false; draw(next); if (conflictShown !== null && failure === conflictShown.line) failure = conflictShown.loaded; conflictShown = null; providersMessage = \"\"; askNetworkFor = null; } ",
    );
    expect(code).toContain("$effect(() => { if (owedReloadRuns(reloadOwed, { editing, saving, tab })) void backgroundReload(); });");
    // What the stamp reads: the shell's own `editing` (the same isDirty the kept draft uses), `saving`, the edit as it
    // stands on its tab, and the marks.
    expect(code).toContain(
      "function screenStamp(): ScreenStamp { return { editing, saving, text: `${tab}:${tab === \"raw\" ? raw : draft === null ? \"\" : rawFromDraft($state.snapshot(draft) as Draft)}`, marked: redraw.pending }; }",
    );
    expect(code).toContain(
      "const editing = $derived( doc !== null && doc.base !== null && doc.text !== null && isDirty({ base: doc.base, loadedText: doc.text, tab, draft: draft === null ? null : ($state.snapshot(draft) as Draft), raw, errors: {} }), );",
    );
    // `draw` is the file drawn, nothing else: the user's resets (marks and errors) stay in `load`.
    expect(fnOf(code, "function draw(next: ConfigDocument): void {", "/** The edit on screen now")).toBe(
      'function draw(next: ConfigDocument): void { doc = next; void refreshSavedRows(next.text); draft = next.text === null ? null : parseDraft(next.text); raw = next.text ?? ""; loadFailure = ""; } ',
    );
    // A user's load reads the latest file, so it pays what is owed; Discard reloads unconditionally (delta X3).
    expect(code).toContain("if (kept === null) { draw(next); if (loadResets(landed !== null)) { redraw = redrawAfterReset(redraw); errors = {}; toolRows = { ...toolRows, other: false, note: null }; } reloadOwed = owedAfterLoad(false, asks, backgroundReloads); }");
    expect(fnOf(code, "async function discardChanges(): Promise<void> {", "async function refreshProviders()")).toBe(
      "async function discardChanges(): Promise<void> { const orphan = leaveAdd(addSteps.running, adding?.pending ?? null); const discarded = orphan === null ? null : discardAdd(orphan, os); addSteps.discard(); adding = null; const replaced = replacing?.pending != null ? await onproviderreplacediscard() : []; replaceSteps.discard(); replacing = null; await load(false); if (replaced.length > 0) keyLines = [...keyLines, ...replaced]; if (discarded !== null) void discarded.then((lines) => (keyLines = [...keyLines, ...lines])); } ",
    );
    expect(code.match(/reloadOwed = /g)?.length).toBe(8);
    // Tiny fix (T1): the third is submit's own run of a conflict's reload on a clean draft (`settings-final.check.ts`).
    expect(code.match(/backgroundReload\(\)/g)?.length).toBe(4);
  });

  const SENT_FROM = parse(LOADED);
  const doc = (text: string | null, base = "b2") => ({ path: "/c/config.json", exists: true, text, base, parseError: null, apiKeyRedacted: false });
  const form = (draft: Draft): Edit => ({ tab: "form", draft, raw: "" });
  const with_ = (d: Draft, over: Record<string, unknown>): Draft => ({ ...JSON.parse(JSON.stringify(d)), ...over });

  test("R5-M2: afterLanded — nothing typed while the save was in flight: the file is drawn (null)", () => {
    const sent = { base: "b1", text: rawFromDraft(with_(SENT_FROM, { lookbackCapDays: 6 })) };
    const at = form(with_(SENT_FROM, { lookbackCapDays: 6 }));
    expect(afterLanded(sent, at, form(with_(SENT_FROM, { lookbackCapDays: 6 })), doc(sent.text))).toBeNull();
    // Opening the editor on the same content is not an edit.
    expect(afterLanded(sent, at, { tab: "raw", draft: at.draft, raw: sent.text }, doc(sent.text))).toBeNull();
    // A flow's Save (its candidate is not the draft) with nothing typed meanwhile: the file, with the user's resets — the
    // test is the edit it was sent FROM, not the text sent (the round's own mutant C1).
    const candidate = with_(SENT_FROM, { lookbackCapDays: 9 });
    const flow = { base: "b1", text: rawFromDraft(candidate) };
    expect(afterLanded(flow, form(SENT_FROM), form(JSON.parse(JSON.stringify(SENT_FROM)) as Draft), doc(flow.text))).toBeNull();
    // No file after it (gone): the file as it is.
    expect(afterLanded(sent, at, form(with_(SENT_FROM, { lookbackCapDays: 7 })), doc(null))).toBeNull();
  });

  test("R5-M2: afterLanded — the bar's Save: an edit typed in flight is kept, the document is the file just saved", () => {
    const at = with_(SENT_FROM, { lookbackCapDays: 6 });
    const sent = { base: "b1", text: rawFromDraft(at) };
    const now = with_(at, { repos: ["~/code/gamma"] });
    const kept = afterLanded(sent, form(at), form(now), doc(sent.text, "b2"));
    expect(kept?.doc).toEqual(doc(sent.text, "b2"));
    expect(kept?.draft).toEqual(now);
    // …so it shows as unsaved against the new file, and its Save sends the new base.
    expect(formSubmission(kept!.draft!, kept!.doc.text, {}).kind).toBe("save");
  });

  test("R5-M2: afterLanded — a flow's Save (the candidate is not the draft): the edit typed in flight goes onto the saved text", () => {
    // An Add saved a candidate with a new fallback; the user changed General meanwhile.
    const at = SENT_FROM;
    const candidate = with_(at, { fallbacks: [...(at["fallbacks"] as unknown[]), { label: "second", api: { kind: "anthropic", model: "x" } }] });
    const sent = { base: "b1", text: rawFromDraft(candidate) };
    const kept = afterLanded(sent, form(at), form(with_(at, { lookbackCapDays: 6 })), doc(sent.text));
    expect(kept?.draft).toEqual(with_(candidate, { lookbackCapDays: 6 }));
    // Inside an object the same: a nested field typed in flight, a sibling key the save changed.
    const nested = with_(at, { provider: { ...(at["provider"] as object), timeoutMs: 1234 } });
    const cand2 = with_(at, { provider: { ...(at["provider"] as object), argv: ["-p", "--x"] } });
    const k2 = afterLanded({ base: "b1", text: rawFromDraft(cand2) }, form(at), form(nested), doc(rawFromDraft(cand2)));
    expect(k2?.draft?.["provider"]).toEqual({ cli: "claude", argv: ["-p", "--x"], promptVia: "stdin", timeoutMs: 1234 });
    // A key the user removed in flight stays removed; a key only the save added stays added.
    const removed = JSON.parse(JSON.stringify(at)) as Draft;
    delete removed["morningTime"];
    const k3 = afterLanded(sent, form(at), form(removed), doc(sent.text));
    // Final small fix (test gap): `k3 !== null && …` passed on a null answer; the answer is asserted first.
    expect(k3).not.toBeNull();
    expect("morningTime" in k3!.draft!).toBe(false);
    expect(k3?.draft?.["fallbacks"]).toEqual(candidate["fallbacks"]);
  });

  test("R5-M2: afterLanded — the JSON editor: its text typed in flight is kept as typed", () => {
    const at = with_(SENT_FROM, { lookbackCapDays: 6 });
    const sent = { base: "b1", text: rawFromDraft(at) };
    const typed = sent.text.replace('"morningTime": "07:20"', '"morningTime": "08:15"');
    const kept = afterLanded(sent, { tab: "raw", draft: null, raw: sent.text }, { tab: "raw", draft: null, raw: typed }, doc(sent.text));
    expect(kept).toEqual({ doc: doc(sent.text), draft: at, raw: typed });
    // Text that is not JSON yet is kept too.
    expect(afterLanded(sent, { tab: "raw", draft: null, raw: sent.text }, { tab: "raw", draft: null, raw: "{ half" }, doc(sent.text))?.raw).toBe("{ half");
  });

  test("R5-M2: afterLanded — another write landed between the save and the read: the edit stays on the text sent, with the base it was sent from (its save is a conflict)", () => {
    const at = with_(SENT_FROM, { lookbackCapDays: 6 });
    const sent = { base: "b1", text: rawFromDraft(at) };
    const other = rawFromDraft(with_(at, { notify: "auto" }));
    const kept = afterLanded(sent, form(at), form(with_(at, { repos: ["~/g"] })), doc(other, "b3"));
    expect(kept?.doc).toEqual({ ...doc(other, "b3"), text: sent.text, base: "b1" });
    expect(kept?.draft).toEqual(with_(at, { repos: ["~/g"] }));
  });

  test("R5-M2 wiring: every landed save passes what was sent and the edit it was sent from; the form's Save, the text it decided on", () => {
    const code = shell();
    expect(code).toContain("async function submit(text: string, askedNetwork = false, from: Edit = editNow(), at: number = gesture): Promise<boolean> {");
    expect(code).toContain("await load(true, { sent, from, at });");
    expect(code).toContain('if (send !== null) await submit(send.text, send.askedNetwork, { tab: "form", draft: parseDraft(send.text), raw }, at);');
    expect(code).toContain("const editNow = (): Edit => ({ tab, draft: draft === null ? null : ($state.snapshot(draft) as Draft), raw });");
    expect(code).toContain(
      "async function load(keepReport: boolean, landed: { sent: SentSave; from: Edit; at: number } | null = null): Promise<void> { restored = false; const asks = backgroundReloads; try { const next = await configRead(); const kept = landed === null ? null : afterLanded(landed.sent, landed.from, editNow(), next);",
    );
    // Kept: the document refreshed, the edit kept, the marks and errors left as they are (no field drawn again).
    expect(code).toContain(
      "} else { doc = kept.doc; void refreshSavedRows(kept.doc.text); draft = kept.draft; raw = kept.raw; loadFailure = \"\"; reloadOwed = owedAfterLoad(kept.doc !== next, asks, backgroundReloads); } if (landed !== null) toolRows = toolRowsAfterSave(toolRows, typingInToolRows(), landed.at); } catch (e) { loadFailure = describeFailure(e); }",
    );
  });

  test("R5-M3 (pre-existing on main): a save refused as a conflict says what the Settings screen offers, and owes the reload", () => {
    const conflict = { kind: "conflict", path: "/c/config.json" };
    // An unsaved edit on screen: the bar's Discard (the button's own name) loads the file.
    expect(settingsSaveRefusal(conflict, { editing: true, flow: false })).toEqual({
      line: "Not saved: /c/config.json changed on disk after it was loaded. Discard to load it, then make the change again.",
      reload: true,
      loaded: "Not saved: /c/config.json changed on disk after it was loaded. It is loaded again now: make the change again.",
    });
    // No unsaved edit (an Add's or a key action's save from a clean draft): the owed reload loads it at once.
    // (An Add's or Replace's, `flow`, says "Save again" instead: the final small fix, `settings-final.check.ts`.)
    expect(settingsSaveRefusal(conflict, { editing: false, flow: false })).toEqual({
      line: "Not saved: /c/config.json changed on disk after it was loaded. It is loaded again now: make the change again.",
      reload: true,
      loaded: "Not saved: /c/config.json changed on disk after it was loaded. It is loaded again now: make the change again.",
    });
    // Any other refusal: describeFailure's words, nothing owed.
    for (const e of [{ kind: "write", path: "/c", detail: "EACCES" }, { kind: "tooLarge", bytes: 9, limit: 1 }, new Error("x"), "s"]) {
      expect(settingsSaveRefusal(e, { editing: true, flow: false })).toEqual({ line: describeFailure(e), reload: false, loaded: describeFailure(e) });
    }
    // The words the other callers show are not Settings' (the wizard reloads by itself; the Calendar panel has no bar).
    expect(describeFailure(conflict)).toBe("Not saved: /c/config.json changed on disk after it was loaded. Reload it and make the change again.");
    const code = shell();
    expect(fnOf(code, "async function submit(", "/** The form's Save")).toContain(
      "} catch (e) { // Post-cap (R5-M3): a conflict names the screen's own way to load the file, and owes the reload. const refused = settingsSaveRefusal(e, { editing, flow: pendingFlow !== null }); failure = refused.line; if (refused.reload) { reloadOwed = true; conflictShown = refused; reloadNow = !editing; } } finally {",
    );
    expect(code).not.toContain("failure = describeFailure(e); } finally {");
  });
});

describe("Post-cap, section 2: the providers list's identity and the bar Save's reveal (R5-M4, R5-M5)", () => {
  const read = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\s+/g, " ");

  test("R5-M4: sectionKey — the two provider sections share one key, so a kind switch keeps the providers list (a typed Add) mounted", () => {
    expect(sectionKey("Provider (command-line tool)")).toBe(sectionKey("Provider (API)"));
    // Every other section keeps its own title, distinct from each other and from the providers' key.
    const others = SECTIONS.map((s) => s.title).filter((t) => !t.startsWith("Provider ("));
    expect(others.length).toBeGreaterThan(4);
    expect(new Set([...others.map(sectionKey), sectionKey("Provider (API)")]).size).toBe(others.length + 1);
    for (const t of others) expect(sectionKey(t)).toBe(t);
    // Wiring: the boxed sections (where the list is drawn, inside the first provider section's item) are keyed by it.
    const sf = read("routes/SettingsForm.svelte");
    // User-directed 2026-10-22 (P-A): "Today's briefing" sits before the list's Tile, in the same keyed item.
    const at = sf.indexOf("{#each drawn as section, i (sectionKey(section.title))} {#if i === providersAt}");
    expect(at).toBeGreaterThan(-1);
    const item = sf.slice(at, sf.indexOf("{#if !isProviderSection(section)", at));
    expect(item).toContain("<Tile> <ProvidersList");
    expect(item.indexOf("{#if providersShown.readable && providersShown.today !== null}")).toBeLessThan(item.indexOf("<Tile> <ProvidersList"));
    expect(sf.match(/\{#each drawn as section/g)?.length).toBe(2);
  });

  test("R5-M5: the bar's Save is stamped at the press like a flow's: the result moves nothing once the user moved on", () => {
    const pressed = { page: "advanced" as PageId, at: 1000 };
    const here = (over: Partial<{ page: PageId; blocked: PageId[]; outcomeShown: boolean }> = {}) => ({ page: "advanced" as PageId, blocked: [] as PageId[], outcomeShown: true, pressed, ...over });
    // Still on the page: the same targets as before (R3-M3's marked field, the outcome, the title), stamped.
    expect(revealFor("save", here())).toEqual({ target: "outcome", focus: false, since: 1000 });
    expect(revealFor("save", here({ blocked: ["advanced"] }))).toEqual({ target: "field", focus: true, since: 1000 });
    expect(revealFor("save", here({ outcomeShown: false }))).toEqual({ target: "title", focus: true, since: 1000 });
    // On another page now: nothing at all.
    expect(revealFor("save", here({ page: "projects" }))).toBeNull();
    expect(revealFor("save", here({ page: "projects", blocked: ["projects"] }))).toBeNull();
    // Stamped: it stands only while the user has pressed, typed or scrolled nothing since the press.
    const r = nextReveal(NO_REVEAL, revealFor("save", here()));
    expect(revealStillWanted(r, 999)).toBe(true);
    expect(revealStillWanted(r, 1000)).toBe(true);
    expect(revealStillWanted(r, 1001)).toBe(false);
    // Wiring: the stamp is taken at the press, before the save runs, on the clock SettingsPages records input with.
    const shell = read("routes/Settings.svelte");
    expect(shell).toContain('async function barSave(): Promise<void> { if (saving) return; const pressed: Pressed = { page, at: performance.now() }; const at = gesture; if (tab === "form") await saveForm(at); else await submit(raw, false, editNow(), at); requestReveal("save", pressed); }');
    expect(read("lib/settings/SettingsPages.svelte")).toContain("const keyed = (): void => { pressing = false; lastInput = performance.now(); };");
  });
});

/* ── B2-M6-T16: Settings → Editor & links (P-M8; §0's approved text). The harness renders props only; the driver is `actions.check.ts`'s. ── */

describe("B2-M6-T16: the Editor & links page", () => {
  const COPY_RISK = "Running copied text is the same as typing git push in that repository. Hooks, SSH commands and other repository settings still apply. Your shell environment or settings may differ or change after copying. On Windows, use Git Bash.";
  const EDITOR_RISK = "Your editor may run workspace tasks according to its trust settings.";
  const EDITOR_HELP = "Choose an installed editor, or ask each time. Hold Option while opening a project to choose again.";
  const LINKS_HELP = "Show buttons that open your work on GitHub.";
  const EMPTY = "No projects are configured. Add projects in Settings → Projects.";
  const DISCOVERY = "Projects will appear here after the next briefing checks your discovery folders.";
  const INSTALLED = [{ editor: "cursor", label: "Cursor" }, { editor: "zed", label: "Zed" }];
  type Row = { project: string | null; label: string; choice: string | null; availability: "ready" | "not-checked" };
  const ready = (projects: Row[], discoveryConfigured = false, editors: unknown[] = INSTALLED): unknown => ({ state: "ready", editors, projects, discoveryConfigured });
  const row = (label: string, choice: string | null = null, project: string | null = `key-${label}`): Row => ({ project, label, choice, availability: "ready" });
  const noop = (): void => {};
  const page = (over: Record<string, unknown> = {}): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(EditorLinksPage as any, { props: { os: "macos", githubLinks: true, linksBusy: false, linksLine: null, onlinks: noop, editors: { state: "idle" }, choiceLines: new Map(), onchoice: noop, ...over } })
      .body.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
  const decoded = (s: string): string => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'");
  const selects = (body: string): string[] => [...body.matchAll(/<select\b[\s\S]*?<\/select>/g)].map((m) => m[0]);
  const options = (select: string): { value: string; text: string; selected: boolean; disabled: boolean }[] =>
    [...select.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map((m) => ({
      value: /value="([^"]*)"/.exec(m[1]!)?.[1] ?? "",
      text: m[2]!,
      selected: /\sselected\b/.test(m[1]!),
      disabled: /\sdisabled\b/.test(m[1]!),
    }));
  const shown = (select: string): string[] => options(select).filter((o) => o.selected).map((o) => o.text);

  test("idle and loading draw nothing in the editors region; the switch still draws (Q-L10)", () => {
    for (const state of ["idle", "loading"]) {
      const body = page({ editors: { state } });
      expect({ state, editors: /Editors|<select|<fieldset/.test(body) }).toEqual({ state, editors: false });
      expect(body).toContain(">GitHub links</label>");
      expect(body).toContain('role="switch"');
      for (const absent of [EDITOR_HELP, EDITOR_RISK, EMPTY, DISCOVERY, "Could not list installed editors", "Loading"]) expect({ state, absent, drawn: decoded(body).includes(absent) }).toEqual({ state, absent, drawn: false });
    }
  });

  test("failed draws the approved editor_list failure line, under the group", () => {
    const body = page({ editors: { state: "failed" } });
    expect(body).toContain(">Could not list installed editors</p>");
    expect(body).toMatch(/<legend[^>]*><h4[^>]*>Editors<\/h4><\/legend>/);
    expect(body).not.toContain("<select");
  });

  test("on macOS: the switch with its label and help, the copy help, then one row per project with the editor help and risk", () => {
    const body = decoded(page({ editors: ready([row("app", "cursor"), row("lib", "ask")]) }));
    expect(body).toMatch(/<label[^>]*for="editor-links-github"[^>]*>GitHub links<\/label>/);
    expect(body).toMatch(/<input[^>]*id="editor-links-github"/);
    expect(body).toMatch(/<input[^>]*aria-describedby="editor-links-github-help"/);
    expect(body).toMatch(new RegExp(`<p id="editor-links-github-help"[^>]*>${LINKS_HELP}</p>`));
    expect(body).toContain(`>${COPY_RISK}</p>`);
    // The switch doesn't control Copy, so the help has its own box, after the switch's and before the editors'.
    const at = (text: string): number => { const i = body.indexOf(text); expect({ text, found: i >= 0 }).toEqual({ text, found: true }); return i; };
    const [links, copyHead, copyHelp, editors] = [at(">GitHub links</label>"), at(">Copy push command</h4>"), at(COPY_RISK), at(">Editors</h4>")];
    expect(links < copyHead && copyHead < copyHelp && copyHelp < editors).toBe(true);
    const between = body.slice(links, copyHead);
    expect(between).toContain('class="group');
    expect(body.slice(copyHelp, editors)).toContain('class="group');
    expect(body).toContain(`>${EDITOR_HELP}</p>`);
    expect(body).toContain(`>${EDITOR_RISK}</p>`);
    expect(body).toContain(">Editor for app</label>");
    expect(body).toContain(">Editor for lib</label>");
    expect(selects(body)).toHaveLength(2);
    expect(body).not.toContain(EMPTY);
    expect(body).not.toContain(DISCOVERY);
  });

  test("off macOS: only the GitHub links switch, whatever the view holds (B2 :77)", () => {
    for (const os of ["linux", "windows"]) {
      for (const editors of [{ state: "idle" }, { state: "loading" }, { state: "failed" }, ready([row("app", "cursor")])]) {
        const body = decoded(page({ os, editors }));
        expect(body).toContain(">GitHub links</label>");
        expect(body).toContain(`>${LINKS_HELP}</p>`);
        expect({ os, editors, rest: /Editors|<select|Could not list/.test(body) }).toEqual({ os, editors, rest: false });
        for (const absent of [COPY_RISK, "Copy push command", EDITOR_RISK, EDITOR_HELP, EMPTY, DISCOVERY]) expect({ os, absent, drawn: body.includes(absent) }).toEqual({ os, absent, drawn: false });
      }
    }
  });

  test("the switch shows the value, off as on; a set in flight marks the row busy and never disables it (focus stays, round-4 M2)", () => {
    expect(page({ githubLinks: true })).toMatch(/<input[^>]*role="switch"[^>]*\schecked\b/);
    expect(page({ githubLinks: false })).not.toMatch(/<input[^>]*role="switch"[^>]*\schecked\b/);
    const busy = page({ linksBusy: true });
    expect(busy).toMatch(/aria-busy="true"[^>]*><input[^>]*role="switch"/);
    expect(busy).not.toMatch(/<input[^>]*role="switch"[^>]*\sdisabled\b/);
    expect(page({ linksBusy: false })).not.toContain("aria-busy");
  });

  test("the links line: a polite live region, always drawn, with the fixed sentence and no path (P-M10)", () => {
    expect(page()).toMatch(/<p class="line[^"]*" aria-live="polite"><\/p>/);
    const body = page({ linksLine: { ok: false, text: "Could not save the GitHub links setting." } });
    expect(body).toMatch(/<p class="line[^"]*\bbad\b[^"]*" aria-live="polite">Could not save the GitHub links setting\.<\/p>/);
  });

  test("a resolved project with choice null shows Not chosen yet, distinct from a stored ask and from an unresolved row (R3-5)", () => {
    const never = selects(page({ editors: ready([row("app", null)]) }))[0]!;
    expect(shown(never)).toEqual(["Not chosen yet"]);
    expect(options(never).map((o) => o.text)).toEqual(["Not chosen yet", "Cursor", "Zed", "Ask each time"]);
    // Never a choice of its own: `editor_choice_set` never stores null.
    expect(options(never).find((o) => o.text === "Not chosen yet")).toEqual({ value: "", text: "Not chosen yet", selected: true, disabled: true });

    const ask = selects(page({ editors: ready([row("app", "ask")]) }))[0]!;
    expect(shown(ask)).toEqual(["Ask each time"]);
    expect(options(ask).map((o) => o.text)).toEqual(["Cursor", "Zed", "Ask each time"]);
    expect(options(ask).find((o) => o.text === "Ask each time")!.value).toBe("ask");

    const stored = selects(page({ editors: ready([row("app", "zed")]) }))[0]!;
    expect(shown(stored)).toEqual(["Zed"]);
    expect(options(stored).map((o) => [o.value, o.disabled])).toEqual([["cursor", false], ["zed", false], ["ask", false]]);

    const unresolved = page({ editors: ready([{ project: null, label: "web", choice: null, availability: "not-checked" }]) });
    expect(unresolved).toContain(">Not checked yet<");
    expect(unresolved).toContain(">web<");
    expect(unresolved).not.toContain("<select");
    expect(unresolved).not.toContain("Not chosen yet");
    expect(unresolved).not.toContain("Editor for");
  });

  test("an unresolved row whose own name cannot be shown says Not checked yet once, and offers nothing to launch or choose", () => {
    const body = page({ editors: ready([{ project: null, label: "Not checked yet", choice: null, availability: "not-checked" }]) });
    expect(body.split("Not checked yet").length - 1).toBe(1);
    expect(body).not.toContain("<select");
    expect(body).not.toMatch(/<button/);
  });

  test("a stored editor that is no longer installed: the fixed line, the control kept, and what the row holds still shown (P-M10)", () => {
    const body = page({ editors: ready([row("app", "cursor")], false, [{ editor: "zed", label: "Zed" }]) });
    expect(body).toContain(">The chosen editor is no longer installed.</p>");
    const select = selects(body)[0]!;
    expect(shown(select)).toEqual(["Cursor"]);
    // Not offered: it cannot be chosen again while it is gone.
    expect(options(select).find((o) => o.value === "cursor")!.disabled).toBe(true);
    expect(options(select).filter((o) => !o.disabled).map((o) => o.text)).toEqual(["Zed", "Ask each time"]);
    // Installed, or ask, or never chosen: no such line.
    for (const choice of ["zed", "ask", null]) expect(page({ editors: ready([row("app", choice)], false, [{ editor: "zed", label: "Zed" }]) })).not.toContain("no longer installed");
  });

  test("with no projects: the discovery hint when discovery is configured, else the empty state; neither once a project exists (O17, R4-2)", () => {
    const none = decoded(page({ editors: ready([], false) }));
    expect(none).toContain(`>${EMPTY}</p>`);
    expect(none).not.toContain(DISCOVERY);
    expect(none).not.toContain("<select");
    const discovery = decoded(page({ editors: ready([], true) }));
    expect(discovery).toContain(`>${DISCOVERY}</p>`);
    expect(discovery).not.toContain(EMPTY);
    expect(discovery).not.toContain("<select");
    expect(discovery).not.toContain("Not checked yet");
    const configured = decoded(page({ editors: ready([{ project: null, label: "web", choice: null, availability: "not-checked" }], true) }));
    expect(configured).not.toContain(EMPTY);
    expect(configured).not.toContain(DISCOVERY);
    expect(configured).toContain("Not checked yet");
  });

  test("a row's save line: a polite live region under that row only, with the mapped text", () => {
    const lines = new Map([["key-app", { ok: false, text: "Editor choices could not be saved: preferences are full." }]]);
    const body = page({ editors: ready([row("app", "zed"), row("lib", "zed")]), choiceLines: lines });
    expect(body.split("preferences are full").length - 1).toBe(1);
    expect(body).toMatch(/<p class="line[^"]*\bbad\b[^"]*" aria-live="polite">Editor choices could not be saved: preferences are full\.<\/p>/);
    expect(body.indexOf("preferences are full")).toBeLessThan(body.indexOf("Editor for lib"));
    expect([...body.matchAll(/<p class="line[^"]*" aria-live="polite">/g)]).toHaveLength(3);
  });

  test("keyboard reselection (B2 :71): each row is a native, labelled, enabled select; a change calls onchoice with the row's own key", () => {
    const body = page({ editors: ready([row("app", "zed"), row("lib", "cursor")]) });
    const ids = selects(body).map((s) => /id="([^"]*)"/.exec(s)![1]!);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(body).toContain(`for="${id}"`);
    for (const select of selects(body)) {
      expect(select.slice(0, select.indexOf(">"))).not.toMatch(/\sdisabled\b|tabindex/);
      expect(options(select).filter((o) => !o.disabled).length).toBeGreaterThan(1);
    }
    const source = readFileSync(new URL("../src/lib/settings/EditorLinksPage.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(source).toContain("onchange={(e) => onchoice(project, e.currentTarget.value as EditorChoice)}");
  });

  test("a refused save puts the select back: Svelte does not rewrite a select whose value prop did not change", () => {
    const source = readFileSync(new URL("../src/lib/settings/EditorLinksPage.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(source).toContain("use:showsStored={{ value: selected, line }}");
    expect(source).toContain("update(next) { node.value = next.value; }");
  });

  test("the page calls no IPC and reads no store: it takes props only (P-M8)", () => {
    const source = readFileSync(new URL("../src/lib/settings/EditorLinksPage.svelte", import.meta.url), "utf8");
    expect(source).not.toMatch(/import (?!type )[^;]*from "\.\.\/(engine|app-prefs-store|actions-live)"|@tauri-apps|invoke\(|onMount/);
    expect(source).toContain('import type { EditorChoice, EditorId } from "../app-prefs-store";');
  });

  test("each group sits in one Tile", () => {
    const body = page({ editors: ready([row("app", "zed")]) });
    expect(body.match(/<section class="tile/g)).toHaveLength(3);
    expect(body.indexOf('<section class="tile')).toBeLessThan(body.indexOf(">GitHub links</label>"));
    expect(body.lastIndexOf('<section class="tile')).toBeLessThan(body.indexOf(">Editors</h4>"));
    expect(body.lastIndexOf('<section class="tile')).toBeGreaterThan(body.indexOf(">Copy push command</h4>"));
    const second = body.indexOf('<section class="tile', body.indexOf('<section class="tile') + 1);
    expect(second).toBeGreaterThan(body.indexOf(">GitHub links</label>"));
    expect(second).toBeLessThan(body.indexOf(">Copy push command</h4>"));
  });
});

describe("B2-M6-T16: Settings owns the driver and passes the page's props (P-M8, Q-L5, Q-L8)", () => {
  const shell = readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
  const pagesSource = readFileSync(new URL("../src/lib/settings/SettingsPages.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");

  test("Q-L5: one effect opens the driver on page === \"editor\", so both assignments of `page` and a remembered page reach it", () => {
    expect(shell).toContain('$effect(() => { if (page === "editor") untrack(() => editorLinks.open()); });');
    expect(shell.split("editorLinks.open()").length - 1).toBe(1);
  });

  test("one instance per mount, its literal wrappers injected, disposed on unmount, its published state held in $state", () => {
    expect(shell.split("editorLinksLive(").length - 1).toBe(1);
    expect(shell).toContain("const editorLinks = untrack(() => editorLinksLive({ os, editorList, editorChoiceSet, setGithubLinks, publish: (s) => (editorLinksState = s) }));");
    expect(shell).toContain("let editorLinksState = $state.raw<EditorLinksState>(editorLinks.state());");
    expect(shell).toContain("onDestroy(() => editorLinks.dispose());");
  });

  test("Settings passes the state down; SettingsPages forwards it; every new prop is optional with a default (Q-L8)", () => {
    for (const attr of ["githubLinks={editorLinksState.githubLinks}", "linksBusy={editorLinksState.linksBusy}", "linksLine={editorLinksState.linksLine}", "onlinks={editorLinks.setLinks}", "editors={editorLinksState.editors}", "choiceLines={editorLinksState.choiceLines}", "onchoice={editorLinks.setChoice}"]) expect({ attr, passed: shell.includes(attr) }).toEqual({ attr, passed: true });
    expect(pagesSource).toContain("<EditorLinksPage {os} {githubLinks} {linksBusy} {linksLine} {onlinks} {editors} {choiceLines} {onchoice} />");
    for (const member of ["githubLinks?: boolean | undefined;", "linksBusy?: boolean | undefined;", "linksLine?: EditorLinksLine | null | undefined;", "onlinks?: ((on: boolean) => void) | undefined;", "editors?: EditorLinksView | undefined;", "choiceLines?: ReadonlyMap<string, EditorLinksLine> | undefined;", "onchoice?: ((project: string, choice: EditorChoice) => void) | undefined;"]) expect({ member, declared: pagesSource.includes(member) }).toEqual({ member, declared: true });
    for (const fallback of ["githubLinks = true,", "linksBusy = false,", "linksLine = null,", "onlinks = () => {},", 'editors = { state: "idle" },', "choiceLines = new Map(),", "onchoice = () => {},"]) expect({ fallback, declared: pagesSource.includes(fallback) }).toEqual({ fallback, declared: true });
  });
});

describe("A2 summary status callback wiring", () => {
  const flat = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8").replace(/\s+/g, " ");
  test("App owns the ordered driver and hands watcher events to its trigger, never a bare refresh", () => {
    const app = flat("App.svelte");
    expect(app).toContain("summaryStatusDriver({");
    expect(app).toContain("readSnapshot: stateSnapshot");
    expect(app).toContain("summaryState = next");
    expect(app).toContain("onconfigsaved={summaryStatus.saved}");
    expect(app).toContain("onstatusrefresh={refreshSummaryStatus}");
    expect(app).toContain("summaryStatusKnown={summaryState.known}");
    expect(app).toContain("aiSummaryStatus={summaryState.status}");
    expect(app).toContain("latestSummaryRevision={summaryState.revision}");
    expect(app).toMatch(/onStateChanged\(\(next\) => \{ applySnapshot\(next\); summaryStatus\.onWatcher\(next\);/);
    expect(app).not.toContain("void summaryStatus.refresh()");
    expect(app).toContain("summaryStatus.dispose()");
    expect(app.match(/summaryStatusDriver\(/g)).toHaveLength(1);
  });
  test("both save modes share the immediate, detached saved notification", () => {
    const settings = flat("routes/Settings.svelte");
    expect(settings).toContain("onconfigsaved: () => Promise<void>");
    expect(settings).toMatch(/if \(result.kind === "saved"\) \{ void onconfigsaved\(\);/);
    expect(settings).toContain("const saved = await configSave(text, sent.base); answered = saved.kind; return saved;");
    expect(settings).toContain("submit(raw)");
    expect(settings.indexOf("void onconfigsaved();")).toBeLessThan(settings.indexOf("await load(true, { sent, from, at })"));
  });
  test("Today only feeds the driver's publication and page identity into its per-mount payload reader", () => {
    const today = flat("routes/Today.svelte");
    expect(today).toContain("summaryReader({"); expect(today).toContain("readLatestSummary,");
    expect(today).toContain("refreshStatus: () => onstatusrefresh()");
    // App's one holder, never a module's: another App instance shares nothing.
    expect(today).toContain("kept: untrack(() => summaryKept)");
    expect(flat("App.svelte")).toContain("summaryKept={summaryStatus.kept}");
    expect(flat("lib/today-store.ts")).not.toMatch(/KeptSummary|SummaryInput/);
    expect(today).toContain("summaryLive.onMount()"); expect(today).toContain("summaryLive.dispose()");
    expect(today).toContain("summaryLive.onPage(");
    expect(today).toContain("const publication = { known: summaryStatusKnown, status: aiSummaryStatus, revision: latestSummaryRevision }");
    expect(today).toContain("summaryLive.onSnapshot(publication)");
    expect(today).not.toContain("summaryRevisionOf"); expect(today).not.toContain("summaryStatusOf");
    const minute = today.match(/function onMinute\(\): void \{([^}]+)\}/)![1]!;
    expect(minute).not.toMatch(/summary|statusrefresh/i);
  });
});

describe("A2-M5-T15: Settings → General → Briefing, AI summaries", () => {
  // The §0 table's words, written out here so a change to the code's copy turns these red.
  const SENTENCES = {
    "summary-unavailable": "AI summary unavailable; showing the existing card points.",
    "summary-text-omitted": "Some AI summary text was omitted.",
    "summary-usage-limit": "AI summary usage limit reached; showing the existing card points.",
    "summary-config-invalid": "AI summary setting is invalid; AI summaries are off.",
  } as const;
  const CODES = Object.keys(SENTENCES) as (keyof typeof SENTENCES)[];
  const ALL_SENTENCES = Object.values(SENTENCES);
  const WINDOWS_NOTE = "AI summaries are not available on Windows yet.";
  const noop = (): void => {};
  const flat = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8").replace(/\s+/g, " ");
  const FIELD = SECTIONS.flatMap((s) => s.fields).find((f) => f.id === "aiSummary.enabled");
  const field = () => FIELD!;
  const generalPage = (over: Record<string, unknown> = {}): string =>
    render(SettingsPages as never, {
      props: {
        page: "general", onpage: noop, attention: [], changed: [], tab: "form", raw: LOADED, draft: parse(LOADED), errors: {},
        onfield: noop, onnotifycommand: noop, ondefault: noop, onremovekey: noop, loadFailure: "",
        doc: { path: "/x/config.json", exists: true, text: LOADED, base: "b", parseError: null, apiKeyRedacted: false },
        restored: false, settingsRemovedByUninstall: false, onreload: noop, notify: null, notifyError: "", autostart: null, autostartError: "",
        onrefresh: noop, os: "macos", update: null, updateLoading: false, updateChecking: false, updateError: "", oncheck: noop,
        onconfigchanged: noop, onstatus: noop, onopenjson: noop, uninstallReport: null, uninstallRunning: false,
        onuninstallstarted: noop, onuninstallended: noop, networkAsk: false, networkYes: true,
        ...over,
      } as never,
    }).body.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").split('<div data-page="projects"')[0]!;
  /** The status as Settings gets it: the raw `status --json` envelope through the one parser. */
  const fromEnvelope = (aiSummaryStatus: unknown, rest: Record<string, unknown> = {}) => summaryStatusFromStatus({ ...rest, aiSummaryStatus });

  test("the field is a config field in General's Briefing section, in the spec's words, after Look back", () => {
    const section = SECTIONS.find((s) => s.title === "Briefing")!;
    expect(section.page).toBe("general");
    expect(section.fields.map((f) => f.id)).toEqual(["morningTime", "lookbackCapDays", "aiSummary.enabled"]);
    expect(field().path).toEqual(["aiSummary", "enabled"]);
    expect(field().label).toBe("AI summaries");
    expect(field().help).toBe("Short project points and a Good morning sentence, generated after your briefing. Shown on the desktop app's slides.");
    expect(field().kind).toBe("bool");
    // The same words as the update check's switch: a blank switch reads off, and this says why.
    expect(field().note).toBe("The engine default is off.");
    expect(field().note).toBe(SECTIONS.flatMap((s) => s.fields).find((f) => f.id === "updateCheck.enabled")!.note!);
    const g = generalPage();
    expect(g).toMatch(/<label for="f-aiSummary\.enabled"[^>]*>AI summaries<\/label>/);
    expect(g.slice(g.indexOf('<label for="f-aiSummary.enabled"'))).toContain("The engine default is off.");
    expect(g).toContain("Short project points and a Good morning sentence, generated after your briefing. Shown on the desktop app's slides.");
    expect(g.indexOf('<label for="f-lookbackCapDays"')).toBeLessThan(g.indexOf('<label for="f-aiSummary.enabled"'));
    // Editing it marks General, through the same page map as every other field.
    expect(changedPages(form(edited((d) => setPath(d, ["aiSummary", "enabled"], true))))).toEqual(["general"]);
    // Through the draft and save, never the app's own preferences.
    expect(flat("lib/settings/PrefsRows.svelte")).not.toMatch(/aiSummary|AI summar/);
    expect(flat("lib/app-prefs-store.ts")).not.toMatch(/aiSummary|AI summar/);
  });

  test.each(CODES)("%s draws its one fixed sentence under the Briefing form, and never the code", (code) => {
    const g = generalPage({ aiSummaryStatus: fromEnvelope({ enabled: code !== "summary-config-invalid", warnings: [code] }) });
    expect(g).toContain(`>${SENTENCES[code]}<`);
    for (const other of ALL_SENTENCES) if (other !== SENTENCES[code]) expect(g).not.toContain(other);
    expect(g).not.toContain(code);
    expect(g.indexOf('<label for="f-aiSummary.enabled"')).toBeLessThan(g.indexOf(SENTENCES[code]));
    expect(g.indexOf(SENTENCES[code])).toBeLessThan(g.indexOf(">Updates</h4>"));
  });

  test("several current codes draw one sentence each, once", () => {
    const g = generalPage({ aiSummaryStatus: fromEnvelope({ enabled: true, warnings: ["summary-text-omitted", "summary-config-invalid", "summary-text-omitted"] }) });
    expect(g.split(SENTENCES["summary-text-omitted"])).toHaveLength(2);
    expect(g.split(SENTENCES["summary-config-invalid"])).toHaveLength(2);
  });

  test.each([
    ["no status has been read", undefined],
    ["on, no warnings", { enabled: true, warnings: [] }],
    ["off, no warnings", { enabled: false, warnings: [] }],
  ])("%s draws no status sentence", (_name, status) => {
    const g = generalPage(status === undefined ? {} : { aiSummaryStatus: status });
    for (const sentence of ALL_SENTENCES) expect(g).not.toContain(sentence);
    expect(g).not.toContain(WINDOWS_NOTE);
  });

  test("an old-identity or unknown diagnostic never shows: only `aiSummaryStatus.warnings`' known codes reach the page", () => {
    // The engine keeps old-version and other-identity records out of `warnings` (test/summary.status.test.ts). The page
    // reads nothing else: a record's own state, or a code beside the list, draws nothing, and an unknown code is dropped.
    const stale = "a".repeat(64);
    const status = fromEnvelope({ enabled: true, warnings: ["summary-old-provider-said-this"] }, {
      latestSummaryRevision: { pageHash: stale, pageVersion: stale, revision: 1, state: "unavailable" },
      warnings: ["summary-unavailable"],
      diagnostics: ["summary-usage-limit"],
    });
    expect(status).toEqual({ enabled: true, warnings: [] });
    const g = generalPage({ aiSummaryStatus: status });
    for (const sentence of ALL_SENTENCES) expect(g).not.toContain(sentence);
    expect(g).not.toContain("summary-old-provider-said-this");
  });

  test.each([
    ["windows", true],
    ["macos", false],
    ["linux", false],
    ["other", false],
  ])("the Windows note on %s: %p", (os, shown) => {
    const g = generalPage({ os });
    expect(g.includes(WINDOWS_NOTE)).toBe(shown);
    if (shown) {
      // Under the field, whichever way the switch stands, and beside a current warning rather than in place of it.
      expect(g.indexOf('<label for="f-aiSummary.enabled"')).toBeLessThan(g.indexOf(WINDOWS_NOTE));
      expect(g.indexOf(WINDOWS_NOTE)).toBeLessThan(g.indexOf(">Updates</h4>"));
      const warned = generalPage({ os, aiSummaryStatus: fromEnvelope({ enabled: false, warnings: ["summary-config-invalid"] }) });
      expect(warned).toContain(WINDOWS_NOTE);
      expect(warned).toContain(SENTENCES["summary-config-invalid"]);
      expect(warned.indexOf(WINDOWS_NOTE)).toBeLessThan(warned.indexOf(SENTENCES["summary-config-invalid"]));
    }
  });

  test("the line goes with the form: nothing while the config is not loaded or the JSON editor is open", () => {
    const status = fromEnvelope({ enabled: true, warnings: ["summary-unavailable"] });
    const unloaded = generalPage({ os: "windows", aiSummaryStatus: status, draft: null, doc: null });
    expect(unloaded).not.toContain(WINDOWS_NOTE);
    expect(unloaded).not.toContain(SENTENCES["summary-unavailable"]);
    const raw = generalPage({ tab: "raw", aiSummaryStatus: status });
    // Inside ConfigGate's hidden wrapper, which closes before the line about the open editor.
    expect(raw.indexOf("<div hidden")).toBeGreaterThan(-1);
    expect(raw.indexOf("<div hidden")).toBeLessThan(raw.indexOf('<label for="f-aiSummary.enabled"'));
    expect(raw.indexOf('<label for="f-aiSummary.enabled"')).toBeLessThan(raw.indexOf(SENTENCES["summary-unavailable"]));
    expect(raw.indexOf(SENTENCES["summary-unavailable"])).toBeLessThan(raw.indexOf(RAW_TAB_LINE));
  });

  test("on and off round-trip through the draft, keeping the rest of the file and its order", () => {
    const draft = parse(LOADED);
    expect(readField(draft, field())).toBe("");
    expect(writeField(draft, field(), "true")).toBeNull();
    expect(draft["aiSummary"]).toEqual({ enabled: true });
    expect(readField(draft, field())).toBe("true");
    expect(writeField(draft, field(), "false")).toBeNull();
    expect(draft["aiSummary"]).toEqual({ enabled: false });
    expect(readField(draft, field())).toBe("false");
    const saved = JSON.parse(rawFromDraft(draft)) as Draft;
    expect(saved["aiSummary"]).toEqual({ enabled: false });
    expect(Object.keys(saved)).toEqual([...Object.keys(BASE), "aiSummary"]);
    expect(readField(saved, field())).toBe("false");
    // Back to the engine's default: the key goes, the block stays (the engine reads `{}` as off with no warning, M10).
    expect(writeField(draft, field(), "")).toBeNull();
    expect(draft["aiSummary"]).toEqual({});
    // An unreadable value shows as unset and is only replaced when the user chooses.
    expect(readField({ aiSummary: "yes" }, field())).toBe("");
    expect(readField({ aiSummary: { enabled: "yes" } }, field())).toBe("");
  });

  test("no default anywhere: an untouched save of a config without the key leaves it absent", () => {
    expect(formSubmission(parse(LOADED), LOADED, {})).toEqual({ kind: "unchanged" });
    // A save of another field does not bring it along.
    const edit = parse(LOADED);
    expect(writeField(edit, SECTIONS.flatMap((s) => s.fields).find((f) => f.id === "lookbackCapDays")!, "9")).toBeNull();
    const sent = formSubmission(edit, LOADED, {});
    expect(sent.kind).toBe("save");
    expect(JSON.parse((sent as { text: string }).text)).not.toHaveProperty("aiSummary");
  });

  test("the wizard's draft path neither adds it nor changes a stored one", () => {
    // `applyDraft` is private to wizard.ts; `mergeConfig("{}", …)` reaches it over an empty target.
    expect(mergeConfig("{}", emptyDraft())).not.toHaveProperty("aiSummary");
    expect(mergeConfig(LOADED, draftFromConfig(LOADED)!)).not.toHaveProperty("aiSummary");
    for (const stored of [{ enabled: false }, { enabled: true }, {}]) {
      const text2 = text({ ...BASE, aiSummary: stored });
      expect((mergeConfig(text2, draftFromConfig(text2)!) as Draft)["aiSummary"]).toEqual(stored);
    }
  });

  test("Q-L9: Settings parses the status from its own read, and App stays out of it", () => {
    const shell = flat("routes/Settings.svelte");
    const between = (from: string, to: string): string => shell.slice(shell.indexOf(from), shell.indexOf(to));
    const load = between("async function loadUpdate()", "async function checkNow()");
    expect(load).toContain("const report = await status();");
    // A landed save's own status read carries it too, so the line follows the setting it describes.
    const again = between("async function refreshProviders()", "async function readLatestPage(");
    // `payload: null` means the engine printed no JSON line, which says nothing about the setting. The parser alone would
    // answer it with "off, no warnings" and clear a still-true warning, so neither read asks it. Rendering runs no
    // script in this harness, so the two statements are pinned as source, with no third call to the parser beside them.
    expect(summaryStatusFromStatus(null)).toEqual({ enabled: false, warnings: [] });
    expect(load).toContain("if (report.payload !== null) aiSummaryStatus = summaryStatusFromStatus(report.payload);");
    expect(again).toContain("if (payload !== null) aiSummaryStatus = summaryStatusFromStatus(payload);");
    expect(shell.split("summaryStatusFromStatus(").length - 1).toBe(2);
    expect(shell).toMatch(/<SettingsPages [^]*?\{aiSummaryStatus\}[^]*?\/>/);
    expect(shell).not.toContain("summaryStatusOf");
    // Passed on, optional with a default at both steps (Q-L8), so the renders that pass nothing stay valid.
    const pagesSource = flat("lib/settings/SettingsPages.svelte");
    expect(pagesSource).toMatch(/<GeneralPage [^]*?\{aiSummaryStatus\}[^]*?\/>/);
    for (const source of [pagesSource, flat("lib/settings/GeneralPage.svelte")]) {
      expect(source).toContain("aiSummaryStatus?: SummaryStatus | undefined;");
      expect(source).toContain("aiSummaryStatus = { enabled: false, warnings: [] },");
    }
    const appSettings = flat("App.svelte").match(/<Settings [^]*?\/>/)![0];
    expect(appSettings).not.toContain("aiSummaryStatus");
  });
});
