/**
 * PR D round 12 fix pass: the behaviours the round's reviewers found (M1, the LOWs) driven through the model's and the
 * shell's own pure functions and server renders, and (M2) the display wiring a server render cannot run, pinned. Every
 * new name is read dynamically, so this file loads (and fails test by test) on the base, b353eb1cf. No engine import.
 *
 * ⚠ R12-M1's `Shell` is, like round 11's, a HAND-BUILT COPY OF THE SHELL'S WIRING (`routes/Settings.svelte`): what it
 * copies is the ORDER of the calls — a gesture counted on its press (`gestured`), `onfield` (`writeField`, then
 * `fieldEdited` with `noteStamp`), the two `$effect.pre`s (`toolRowsAfter`, `toolRowsDrawn`), a landed save's
 * `toolRowsAfterSave` with the gesture that pressed Save — and every decision is the real function's. The source pins in
 * R12-M2 hold the copied order to the shell's own text. What a control SHOWS after a refusal is DOM only: the probe
 * `tests-web/probes/tool-rows-display.ts` measures it in a browser (its header says how to run it).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { render } from "svelte/server";

import * as settingsModel from "../src/lib/settings-model";
import * as pagesModel from "../src/lib/settings/pages";
import * as calModel from "../src/lib/calendar-settings";
import {
  formSubmission,
  liveErrors,
  moveProvider,
  providersView,
  readField,
  SECTIONS,
  setLoginFolder,
  writeField,
  type Draft,
  type Field,
} from "../src/lib/settings-model";
import { firstRowLabel, NO_REDRAW, toolRowsAfter, type Redraw } from "../src/lib/settings/pages";
import { nextOpenRows } from "../src/lib/calendar-settings";
import SettingsForm from "../src/routes/SettingsForm.svelte";
import ProvidersList from "../src/lib/ProvidersList.svelte";
import CalendarSettings from "../src/lib/CalendarSettings.svelte";
import type { CalendarListJson, CalendarStatusJson } from "../src/lib/calendar-contract";

const sm = settingsModel as unknown as Record<string, unknown>;
const pm = pagesModel as unknown as Record<string, unknown>;
const cm = calModel as unknown as Record<string, unknown>;
const fn = <T>(mod: Record<string, unknown>, name: string): T => {
  const f = mod[name];
  if (f === undefined) throw new Error(`${name} is not exported`);
  return f as T;
};
/** A name the base may not have (b353eb1cf): the Shell then calls the base's own function the base's way, so on the base
 *  each behaviour test fails at its behaviour, not at a missing name. */
const opt = <T>(mod: Record<string, unknown>, name: string): T | undefined => mod[name] as T | undefined;
const src = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
/** A source file with its `//` comments dropped and its whitespace folded, as the pins read it. */
const code = (f: string): string =>
  src(f)
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");

const CLAUDE = { cli: "claude", argv: ["-p"], promptVia: "stdin" };
const CODEX = { cli: "codex", argv: ["exec"], promptVia: "stdin" };
const API = { kind: "anthropic", model: "m", apiKeyEnv: "K" };
const text = (v: unknown): string => JSON.stringify(v, null, 2);
const parse = (s: string): Draft => JSON.parse(s) as Draft;
const flat = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
const noop = (): void => {};
const PROVIDER_SECTIONS = ["Provider (command-line tool)", "Provider (API)", "Advanced"];
const field = (id: string): Field => SECTIONS.flatMap((s) => s.fields).find((f) => f.id === id)!;
const TOOL = field("provider.cli");
const COMMAND = (): Field => fn<Field>(sm, "TOOL_COMMAND_FIELD");
const ARGS = (): Field => fn<Field>(sm, "TOOL_ARGS_FIELD");

type Note = { id: string; text: string; seq: number; accounts: string };
type Rows = { label: string | null; other: boolean; note: Note | null };
type Marks = { errors: Record<string, string>; redraw: Redraw; tool: Rows };

/** The shell's wiring, in miniature (see the header): the calls in the shell's order, each decision the real one. */
class Shell {
  draft: Draft;
  errors: Record<string, string> = {};
  redraw: Redraw = NO_REDRAW;
  rows: Rows = { label: null, other: false, note: null };
  /** The shell's `gesture`: counted on every pointer press and key press (`gestured`, capture phase). */
  gesture = 0;
  constructor(public saved: string) {
    this.draft = parse(saved);
    this.sync();
  }
  /** A pointer press or a key press: the next gesture. Its focus move, and the `change` that fires with it, come after. */
  press(): number {
    this.gesture += 1;
    return this.gesture;
  }
  /** The shell's two `$effect.pre`s: row 1's (`toolRowsAfter`), then the note's (`toolRowsDrawn`). */
  sync(): void {
    const next = toolRowsAfter(this.rows as never, firstRowLabel(this.draft), this.errors, this.redraw) as unknown as { rows: Rows; errors: Record<string, string>; redraw: Redraw } | null;
    if (next !== null) {
      this.rows = next.rows;
      this.errors = next.errors;
      this.redraw = next.redraw;
    }
    const drawn = opt<(d: Draft, r: Rows) => Rows>(pm, "toolRowsDrawn");
    if (drawn !== undefined) this.rows = drawn(this.draft, this.rows);
  }
  /** `onfield`: `writeField`, then `fieldEdited`, the note stamped with the gesture now (`noteStamp`). */
  field(f: Field, value: string): string | null {
    const refused = writeField(this.draft, f, value);
    const born = opt<(d: Draft, seq: number) => { seq: number; accounts: string }>(pm, "noteStamp")?.(this.draft, this.gesture);
    const next = fn<(m: Marks, f: Field, v: string, r: string | null, b: unknown) => Marks>(pm, "fieldEdited")({ errors: this.errors, redraw: this.redraw, tool: this.rows }, f, value, refused, born);
    this.errors = next.errors;
    this.redraw = next.redraw;
    this.rows = next.tool;
    this.sync();
    return refused;
  }
  folder(label: string, dir: string): void {
    expect(setLoginFolder(this.draft, label, dir)).toBeNull();
    this.sync();
  }
  move(from: number, to: number): void {
    expect(moveProvider(this.draft, from, to, "macos")).toBeNull();
    this.sync();
  }
  /** The bar's Save, sent from gesture `sent` (`barSave`'s `at`), LANDED: the form's text saved, the file drawn, then
   *  `toolRowsAfterSave`. Answers the text it saved. */
  landed(typing: boolean, sent: number): string {
    const save = formSubmission(this.draft, this.saved, this.errors);
    expect(save.kind).toBe("save");
    this.saved = (save as { text: string }).text;
    this.draft = parse(this.saved);
    this.sync();
    this.rows = fn<(r: Rows, typing: boolean, sent: number) => Rows>(pm, "toolRowsAfterSave")(this.rows, typing, sent);
    this.sync();
    return this.saved;
  }
  /** As drawn: the Tool's selected option, Other's command (null: not drawn), the note drawn under a tool control (its
   *  field's id and text), and whether Save is refused. No tool control ever holds an error. */
  check(): { tool: string | null; command: string | null; note: { id: string; text: string } | null; blocked: boolean } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = flat(render(SettingsForm as any, { props: { draft: this.draft, errors: this.errors, onfield: noop, onnotifycommand: noop, ondefault: noop, onremovekey: noop, sections: PROVIDER_SECTIONS, redraw: this.redraw.count, toolOther: this.rows.other, toolNote: this.rows.note } }).body);
    for (const id of ["provider.cli", "provider.cli.other", "provider.argv.other"]) expect({ id, error: this.errors[id] ?? "" }).toEqual({ id, error: "" });
    const select = /<select id="f-provider\.cli"[^>]*>(.*?)<\/select>/.exec(b)?.[1];
    const tool = select === undefined ? null : (/<option value="(\w+)" selected=""/.exec(select)?.[1] ?? null);
    const m = /<input id="f-provider\.cli\.other"([^>]*)>/.exec(b);
    const command = m === null ? null : (/ value="([^"]*)"/.exec(m[1]!)?.[1] ?? "");
    if (command !== null) expect(command).toBe(readField(this.draft, COMMAND()));
    const notes = [...b.matchAll(/<div class="field[^"]*">\s*<label for="f-([^"]+)"(?:(?!<div class="field).)*?<p class="note refused[^"]*" role="status">([^<]*)<\/p>/g)].map((n) => ({ id: n[1]!, text: n[2]! }));
    expect(notes.length).toBeLessThanOrEqual(1);
    const blocked = formSubmission(this.draft, this.saved, this.errors).kind === "blocked";
    expect({ blocked, live: Object.keys(liveErrors(this.draft, this.errors)).length > 0 }).toEqual({ blocked, live: blocked });
    return { tool, command, note: notes[0] ?? null, blocked };
  }
}

// "home" has a login folder: the first provider's command cannot change to another tool (`toolSwitchRefusal`).
const LOGINS = [{ label: "work" }, { label: "home", configDir: "~/.claude-home" }];
const A = text({ repos: ["/x"], morningTime: "07:20", provider: { ...CLAUDE, accounts: LOGINS }, fallbacks: [{ label: "cx", ...CODEX }, { label: "api", api: API }] });
const NOT_CHANGED = /^Not changed: "home" has a login folder/;

/* ══ R12-M1: a refusal born in the gesture that pressed Save survives that save ═══════════════════════════════════════ */

describe("R12-M1: a refused command typed in Other's row, then Save clicked — the one gesture — still says it was not taken", () => {
  test("the click's press, the field's change refusing \"codex\", the save it sends landing: Other stays open on the draft's command with the note, and the file keeps claude", () => {
    const s = new Shell(A);
    s.press();
    s.field(field("morningTime"), "08:00");
    s.press();
    s.field(TOOL, "other");
    // Typing "codex" in Other's command, then a press on Save: the press is a gesture; the focus leaves the field and
    // its `change` fires in that same gesture — refused — before the click sends the save.
    const sent = s.press();
    expect(s.field(COMMAND(), "codex")).toMatch(NOT_CHANGED);
    expect(s.check()).toMatchObject({ tool: "other", command: "claude", note: { id: "provider.cli.other" }, blocked: false });
    const saved = s.landed(false, sent);
    expect((parse(saved)["provider"] as Record<string, unknown>)["cli"]).toBe("claude");
    expect((parse(saved) as Record<string, unknown>)["morningTime"]).toBe("08:00");
    const after = s.check();
    expect(after).toMatchObject({ tool: "other", command: "claude", blocked: false });
    expect(after.note?.id).toBe("provider.cli.other");
    expect(after.note?.text).toMatch(NOT_CHANGED);
  });

  test("a refused Tool choice in the same gesture as the save keeps its note too; Other is not opened for it", () => {
    const s = new Shell(A);
    s.press();
    s.field(field("morningTime"), "08:00");
    const sent = s.press();
    expect(s.field(TOOL, "codex")).toMatch(NOT_CHANGED);
    s.landed(false, sent);
    expect(s.check()).toMatchObject({ tool: "claude", command: null, note: { id: "provider.cli" }, blocked: false });
  });

  test("a note born in an EARLIER gesture still goes with the save that lands (round 11's rule), and Other closes over the named tool", () => {
    const s = new Shell(A);
    s.press();
    s.field(TOOL, "other");
    s.press();
    expect(s.field(COMMAND(), "codex")).toMatch(NOT_CHANGED);
    s.press();
    s.field(field("morningTime"), "08:00");
    s.landed(false, s.press());
    expect(s.check()).toEqual({ tool: "claude", command: null, note: null, blocked: false });
  });

  test("the note that survived goes with the next save, sent from a later gesture", () => {
    const s = new Shell(A);
    s.press();
    s.field(field("morningTime"), "08:00");
    s.press();
    s.field(TOOL, "other");
    const sent = s.press();
    s.field(COMMAND(), "codex");
    s.landed(false, sent);
    expect(s.check().note?.id).toBe("provider.cli.other");
    s.press();
    s.field(field("morningTime"), "09:00");
    s.landed(false, s.press());
    expect(s.check()).toEqual({ tool: "claude", command: null, note: null, blocked: false });
  });

  test("the pieces: `toolRowsAfterSave` keeps a note born in or after the save's gesture, and opens Other for one under Other's rows only", () => {
    const after = fn<(r: Rows, typing: boolean, sent: number) => Rows>(pm, "toolRowsAfterSave");
    const note = (id: string, seq: number): Note => ({ id, text: "Not changed: why", seq, accounts: "null" });
    for (const [seq, kept] of [[4, false], [5, true], [6, true]] as const) {
      expect(after({ label: "work", other: true, note: note("provider.cli.other", seq) }, false, 5)).toEqual({ label: "work", other: kept, note: kept ? note("provider.cli.other", seq) : null });
    }
    expect(after({ label: "work", other: false, note: note("provider.argv.other", 5) }, false, 5).other).toBe(true);
    expect(after({ label: "work", other: false, note: note("provider.cli", 5) }, false, 5)).toEqual({ label: "work", other: false, note: note("provider.cli", 5) });
    // Typing in the tool rows keeps Other as before (round 11).
    expect(after({ label: "work", other: true, note: null }, true, 5).other).toBe(true);
    expect(after({ label: "work", other: true, note: null }, false, 5).other).toBe(false);
    expect(fn<(d: Draft, seq: number) => unknown>(pm, "noteStamp")(parse(A), 3)).toEqual({ seq: 3, accounts: JSON.stringify(LOGINS) });
  });
});

/* ══ R12-L1: the note goes with its control, and with the logins it names ═════════════════════════════════════════════ */

describe("R12-L1: a note on Other's command never outlives its control or the condition it names", () => {
  // Row 1's own arguments are no named tool's, so the Tool shows Other… and its rows without "Other…" being chosen.
  const B = text({ repos: ["/x"], provider: { cli: "claude", argv: ["-p", "--x"], promptVia: "stdin", accounts: LOGINS }, fallbacks: [{ label: "cx", ...CODEX }] });

  test("Other's rows stop being drawn (Advanced's arguments read as Claude Code again): the note goes, and does not come back when they are drawn again", () => {
    const s = new Shell(B);
    expect(s.check().tool).toBe("other");
    s.press();
    expect(s.field(COMMAND(), "codex")).toMatch(NOT_CHANGED);
    expect(s.check().note?.id).toBe("provider.cli.other");
    s.press();
    expect(s.field(field("provider.argv"), "-p")).toBeNull();
    expect(s.check()).toMatchObject({ tool: "claude", command: null, note: null });
    expect(s.rows.note).toBeNull();
    s.press();
    expect(s.field(field("provider.argv"), "-p\n--y")).toBeNull();
    expect(s.check()).toMatchObject({ tool: "other", command: "claude", note: null });
  });

  test("home's login folder cleared through the Login folder field: the note naming it goes (Other's and the Tool's)", () => {
    const s = new Shell(A);
    s.press();
    s.field(TOOL, "other");
    s.press();
    s.field(COMMAND(), "codex");
    expect(s.check().note?.id).toBe("provider.cli.other");
    s.press();
    s.folder("home", "");
    expect(s.check()).toMatchObject({ tool: "other", command: "claude", note: null, blocked: false });
    // Now nothing refuses the change it named.
    s.press();
    expect(s.field(COMMAND(), "codex")).toBeNull();
    const t = new Shell(A);
    t.press();
    t.field(TOOL, "codex");
    expect(t.check().note?.id).toBe("provider.cli");
    t.press();
    t.folder("home", "~/.claude-other");
    expect(t.check().note).toBeNull();
  });

  test("a backup moved, an edit elsewhere, a save that drew the same logins: row 1's logins unchanged, the note stays", () => {
    const s = new Shell(A);
    s.press();
    s.field(TOOL, "other");
    const sent = s.press();
    s.field(COMMAND(), "codex");
    s.move(3, 2);
    expect(firstRowLabel(s.draft)).toBe("work");
    s.field(field("morningTime"), "08:00");
    expect(s.check().note?.id).toBe("provider.cli.other");
    s.landed(false, sent);
    expect(s.check().note?.id).toBe("provider.cli.other");
  });

  test("the pieces: `toolRowsDrawn` answers its rows unchanged while the note is drawn and its logins hold; a Tool note stays while row 1 is a command-line tool", () => {
    const drawn = fn<(d: Draft | null, r: Rows) => Rows>(pm, "toolRowsDrawn");
    const d = parse(A);
    const accounts = JSON.stringify(LOGINS);
    const rows: Rows = { label: "work", other: true, note: { id: "provider.cli.other", text: "n", seq: 1, accounts } };
    expect(drawn(d, rows)).toBe(rows);
    expect(drawn(d, { ...rows, other: false }).note).toBeNull();
    const tool: Rows = { label: "work", other: false, note: { id: "provider.cli", text: "n", seq: 1, accounts } };
    expect(drawn(d, tool)).toBe(tool);
    expect(drawn(d, { ...tool, note: { ...tool.note!, accounts: "null" } }).note).toBeNull();
    expect(drawn(null, tool).note).toBeNull();
    // Row 1 an API provider: no Tool is drawn.
    expect(drawn(parse(text({ repos: ["/x"], provider: { label: "api", api: API } })), { ...tool, note: { ...tool.note!, accounts: "null" } }).note).toBeNull();
    const none: Rows = { label: "work", other: false, note: null };
    expect(drawn(d, none)).toBe(none);
  });
});

/* ══ R12-L2: an empty "Command to run" is refused as a note ═══════════════════════════════════════════════════════════ */

describe("R12-L2: Other's command left empty is a note under it, never `cli: \"\"` in the file", () => {
  test("cleared and committed: refused, the draft keeps its command, the input shows it, Save sends it", () => {
    const s = new Shell(text({ repos: ["/x"], provider: { cli: "my-llm", argv: [], promptVia: "stdin" } }));
    expect(s.check()).toMatchObject({ tool: "other", command: "my-llm" });
    s.press();
    const refused = s.field(COMMAND(), "  ");
    expect(refused).toMatch(/^Not changed: the command to run cannot be empty/);
    expect(refused).toBe(fn<string>(sm, "EMPTY_COMMAND_REFUSAL"));
    expect(s.check()).toMatchObject({ tool: "other", command: "my-llm", note: { id: "provider.cli.other", text: refused }, blocked: false });
    s.press();
    s.field(field("morningTime"), "08:00");
    const saved = s.landed(false, s.press());
    expect((parse(saved)["provider"] as Record<string, unknown>)["cli"]).toBe("my-llm");
  });
});

/* ══ R12-L3: the Mac row's switch waits while the calendar block cannot be read ═══════════════════════════════════════ */

describe("R12-L3: the Mac Calendar app's switch is disabled while the file's calendar block cannot be read", () => {
  const WL: CalendarListJson = {
    schemaVersion: 1,
    macos: { status: "ok", calendars: [{ id: "A", title: "Home", account: "iCloud", editable: true, type: "standard", selected: true }] },
    links: [],
  };
  const ST: CalendarStatusJson = { schemaVersion: 1, enabled: true, enabledSet: true, macSupported: true, configWarnings: [], sources: [] };
  const macSwitch = (configText: string): string => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = flat(render(CalendarSettings as any, { props: { os: "macos", initial: { configText, list: WL, status: ST } } }).body);
    const m = /<input type="checkbox" role="switch"[^>]*aria-label="Read the Mac Calendar app"[^>]*\/>/.exec(b);
    expect(m).not.toBeNull();
    return m![0];
  };
  const master = (configText: string): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    /<input type="checkbox" role="switch"[^>]*id="cal-master"[^>]*\/>|<input id="cal-master"[^>]*\/>/.exec(flat(render(CalendarSettings as any, { props: { os: "macos", initial: { configText, list: WL, status: ST } } }).body))?.[0] ?? "";

  test("a `calendar` that is not an object: the Mac switch, like the master switch, is disabled", () => {
    const bad = JSON.stringify({ calendar: 5 });
    expect(macSwitch(bad)).toContain('disabled=""');
    expect(master(bad)).toContain('disabled=""');
  });

  test("a readable block: the Mac switch is enabled", () => {
    expect(macSwitch(JSON.stringify({ calendar: { enabled: true, macos: { calendars: "editable" } } }))).not.toContain("disabled");
  });
});

/* ══ R12-L4: a provider labelled `__proto__` or `constructor` ═══════════════════════════════════════════════════════════ */

describe("R12-L4: label-keyed records hold every label as their own key — `__proto__` and `constructor` included", () => {
  const D = text({ repos: ["/x"], provider: { label: "__proto__", ...CLAUDE }, fallbacks: [{ label: "constructor", ...CODEX }, { label: "toString", ...CODEX }] });
  const view = (results: Record<string, readonly string[]>) => providersView({ draft: parse(D), savedText: D, rows: null, now: new Date(2026, 9, 18, 12), results, pending: {} });

  test("the providers list draws with no results yet (the shell's `{}`), and a row's result lines are its own", () => {
    const v = view({});
    expect(v.readable).toBe(true);
    if (!v.readable) return;
    expect(v.rows.map((r) => [r.label, r.notes])).toEqual([["__proto__", []], ["constructor", []], ["toString", []]]);
    const w = view({ ["__proto__"]: ["Test failed: no"] });
    if (!w.readable) throw new Error("unreadable");
    expect(w.rows.map((r) => r.notes)).toEqual([["Test failed: no"], [], []]);
  });

  test("a `__proto__` row whose Test failed opens by itself; `constructor` opens when it starts open; the others stay closed", () => {
    const v = view({ ["__proto__"]: ["Test failed: no"] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = flat(render(ProvidersList as any, { props: { view: v, openRows: ["constructor"], onmove: noop, onremove: noop, ontest: noop, onreset: noop, onfolder: noop } }).body);
    const expanded = (i: number): string | undefined => new RegExp(`aria-expanded="(true|false)" aria-controls="prov-row-${i}"`).exec(b)?.[1];
    expect([0, 1, 2].map(expanded)).toEqual(["true", "true", "false"]);
    expect(b).toMatch(/<div class="details[^"]*" id="prov-row-0">/);
    expect(b).toMatch(/<div class="details[^"]*" id="prov-row-1">/);
    expect(b).toMatch(/<div class="details[^"]*" id="prov-row-2" hidden="">/);
  });

  test("`nextOpenRows` and `withRowOpen`: own keys only, no prototype, the user's choice kept", () => {
    const needs = Object.fromEntries([["__proto__", true], ["constructor", false], ["toString", false]]) as Record<string, boolean>;
    const rows = nextOpenRows({ open: {}, needed: {} }, needs);
    expect(Object.getPrototypeOf(rows.open)).toBeNull();
    expect(Object.keys(rows.open)).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.hasOwn(rows.open, "__proto__") && rows.open["__proto__"] === true).toBe(true);
    const isSet = fn<(r: Record<string, boolean>, k: string) => boolean>(cm, "isSet");
    expect(["__proto__", "constructor", "toString", "valueOf"].map((k) => isSet(rows.open, k))).toEqual([true, false, false, false]);
    const opened = fn<(r: typeof rows, k: string, o: boolean) => typeof rows>(cm, "withRowOpen")(rows, "constructor", true);
    expect(opened).not.toBe(rows);
    expect(isSet(rows.open, "constructor")).toBe(false);
    expect(["__proto__", "constructor", "toString"].map((k) => isSet(opened.open, k))).toEqual([true, true, false]);
    // Seen before, the user's open and closed choices are kept.
    const later = nextOpenRows(fn<(r: typeof rows, k: string, o: boolean) => typeof rows>(cm, "withRowOpen")(opened, "__proto__", false), needs);
    expect(["__proto__", "constructor", "toString"].map((k) => isSet(later.open, k))).toEqual([false, true, false]);
  });
});

/* ══ R12-M2: the round 11 display mechanism and the Calendar Test wiring, pinned ═══════════════════════════════════════ */

describe("R12-M2: what a tool control shows after a refusal, and a running Test's generations — the wiring a server render cannot run", () => {
  test("SettingsForm: every tool control is given the draft's value back once its edit is handled (`showDraft`), from both of its call sites", () => {
    const f = code("routes/SettingsForm.svelte");
    // The mechanism: after the flush, the element shows what the shell decided (`toolShown`), if it is still there.
    expect(f).toContain("function showDraft(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, field: Field): void { void tick().then(() => { if (el.isConnected) el.value = shown(field); }); }");
    expect(f).toContain("const shown = (field: Field): string => toolShown(draft, field, toolOther);");
    // Other's command and arguments: `changed`, for exactly those two rows.
    expect(f).toContain("function changed(field: Field, e: Event): void { onfield(field, value(e)); if (isToolRow(field)) showDraft(e.currentTarget as HTMLInputElement | HTMLTextAreaElement, field); }");
    expect(f).toContain("const isToolRow = (field: Field): boolean => field === TOOL_COMMAND_FIELD || field === TOOL_ARGS_FIELD;");
    // …which the text input and the lines textarea commit through (Other's command is a text field, its arguments lines).
    expect(f.split("onchange={(e) => changed(field, e)}").length - 1).toBe(2);
    expect(COMMAND().kind).toBe("text");
    expect(ARGS().kind).toBe("lines");
    // The Tool choice: its own select, showing `shown`, given the draft back after `onfield`.
    expect(f).toContain('<select id="f-{field.id}" value={shown(field)} onchange={(e) => { onfield(field, value(e)); showDraft(e.currentTarget as HTMLSelectElement, field); }} >');
    // The ids `typingInToolRows` looks for.
    expect(f.split('id="f-{field.id}"').length - 1).toBeGreaterThanOrEqual(4);
  });

  test("Settings: \"typing in the tool rows\" is the focus on one of their controls, and a landed save asks it", () => {
    const s = code("routes/Settings.svelte");
    expect(s).toContain("const typingInToolRows = (): boolean => TOOL_FIELD_IDS.some((id) => document.activeElement?.id === `f-${id}`);");
    expect(s).toContain("if (landed !== null) toolRows = toolRowsAfterSave(toolRows, typingInToolRows(), landed.at);");
    expect(s.split("typingInToolRows()").length - 1).toBe(1);
    expect(fn<string[]>(pm, "TOOL_FIELD_IDS")).toEqual(["provider.cli", "provider.cli.other", "provider.argv.other"]);
  });

  test("Settings: round 12's wiring — gestures counted before the focus moves, each note stamped, the bar's Save carrying its gesture, the note's effect", () => {
    const s = code("routes/Settings.svelte");
    expect(s).toContain("<svelte:window onpointerdowncapture={gestured} onkeydowncapture={gestured} />");
    expect(s).toContain("let gesture = 0; const gestured = (): void => { gesture += 1; };");
    expect(s).toContain("const next = fieldEdited({ errors, redraw, tool: toolRows }, field, value, refused, noteStamp(draft, gesture));");
    expect(s).toContain("$effect.pre(() => { const kept = toolRowsDrawn(draft, toolRows); if (kept !== toolRows) untrack(() => (toolRows = kept)); });");
    expect(s).toContain("const at = gesture; if (tab === \"form\") await saveForm(at); else await submit(raw, false, editNow(), at);");
    expect(s).toContain("async function saveForm(at: number = gesture): Promise<void> {");
    expect(s).toContain("await submit(send.text, send.askedNetwork, { tab: \"form\", draft: parseDraft(send.text), raw }, at);");
    expect(s).toContain("async function submit(text: string, askedNetwork = false, from: Edit = editNow(), at: number = gesture): Promise<boolean> {");
    expect(s).toContain("await load(true, { sent, from, at });");
  });

  test("CalendarSettings: a landed write moves its sources' generations; a Test applies its answer against the generations it started with", () => {
    const c = code("lib/CalendarSettings.svelte");
    expect(c).toContain("function forgetTests(keys: readonly string[]): void { const next = testsAfterWrite(mode, { tests, gens: testGens }, keys); if (next.tests !== tests) tests = next.tests; testGens = next.gens; }");
    expect(c).toContain("let testGens = $state.raw<Record<string, number>>({});");
    expect(c).toContain('if (result.ok) { message = { bad: false, text: done }; warnings = result.warnings; forgetTests(touches); onconfigchanged(); }');
    const run = c.slice(c.indexOf("async function runTest(): Promise<void> {"), c.indexOf("function openAdd(): void {"));
    expect(run).toContain("async function runTest(): Promise<void> { if (testing) return; testing = true; testError = null; const started = testGens; const answer = await readTest(() => calendarTest(), describeFailure);");
    expect(run).toContain("tests = testsAfterAnswer({ tests, gens: testGens }, answer.test.sources, started); testedAt = answer.test.ranAt;");
    expect(run.split("tests =").length - 1).toBe(1);
    expect(run).not.toContain("Object.fromEntries");
  });
});
