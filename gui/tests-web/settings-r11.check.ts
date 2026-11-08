/**
 * PR D round 11 fix pass: the behaviours the round's reviewers found broken (M1, M2, the LOWs), driven through the
 * model's and the shell's own pure functions and server renders rather than pinned as source. Every new name is read
 * dynamically, so this file loads (and fails test by test) on the base, ff3fe50fd. Read-only engine imports only.
 *
 * ⚠ R11-M1's `Shell` is a HAND-BUILT COPY OF THE SHELL'S WIRING (`routes/Settings.svelte`), not the shell itself: a
 * server render runs no effect and no event. What it copies is only the ORDER of the calls — `onfield` (`writeField`,
 * then `fieldEdited`), the one `$effect.pre` on row 1 (`toolRowsAfter`), `load`'s resets, a landed save's
 * (`toolRowsAfterSave`) — and every decision is the real function's, so a change in any of them is seen here. What a
 * control SHOWS after a refused edit (the draft's value put back into it, `SettingsForm`'s `showDraft`) is DOM only: it
 * is measured in a browser on the preview, with the client-only fixes (L3's grip, L5's lines, L6's focus); the PR notes
 * give the probe and its numbers. R11-L7's pin (the wizard's second wording change against main) is beside the first one,
 * in `calendar.check.ts`.
 *
 * Round 12: the `Shell` follows the shell's round 12 wiring too — each edit is its own gesture and a note is stamped
 * with it (`noteStamp`), every change of the draft or the rows passes `toolRowsDrawn` (R12-L1: the note goes with its
 * control and with a change of row 1's logins), and a landed save is sent from a later gesture than every edit here
 * (`toolRowsAfterSave`'s `sent`). Round 12's own cases are in `settings-r12.check.ts`.
 */
import { describe, expect, test } from "bun:test";
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
  removeProvider,
  SECTIONS,
  setLoginFolder,
  writeField,
  type Draft,
  type Field,
  type ProvidersView,
  type StatusProviderRow,
} from "../src/lib/settings-model";
import { firstRowLabel, NO_REDRAW, redrawAfterField, redrawAfterReset, toolRowsAfter, type Redraw } from "../src/lib/settings/pages";
import SettingsForm from "../src/routes/SettingsForm.svelte";
import type { CalendarTestSource } from "../src/lib/calendar-contract";

const sm = settingsModel as unknown as Record<string, unknown>;
const pm = pagesModel as unknown as Record<string, unknown>;
const cm = calModel as unknown as Record<string, unknown>;
const fn = <T>(mod: Record<string, unknown>, name: string): T => {
  const f = mod[name];
  if (f === undefined) throw new Error(`${name} is not exported`);
  return f as T;
};

const CLAUDE = { cli: "claude", argv: ["-p"], promptVia: "stdin" };
const CODEX = { cli: "codex", argv: ["exec"], promptVia: "stdin" };
const API = { kind: "anthropic", model: "m", apiKeyEnv: "K" };
const NOW = new Date(2026, 9, 18, 12, 0, 0);
const iso = (h: number, m: number, day = 18): string => new Date(2026, 9, day, h, m, 0).toISOString();
const text = (v: unknown): string => JSON.stringify(v, null, 2);
const parse = (s: string): Draft => JSON.parse(s) as Draft;
const flat = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
const noop = (): void => {};
const PROVIDER_SECTIONS = ["Provider (command-line tool)", "Provider (API)", "Advanced"];
const field = (id: string): Field => SECTIONS.flatMap((s) => s.fields).find((f) => f.id === id)!;

/* ══ R11-M1 (with R10-M1's four paths): a tool control's refusal is a note, never an error ══════════════════════════ */

describe("R11-M1: a refused value on row 1's tool controls never blocks Save — the control shows the draft, a note says why", () => {
  const TOOL = field("provider.cli");
  const COMMAND = (): Field => fn<Field>(sm, "TOOL_COMMAND_FIELD");
  const ARGS = (): Field => fn<Field>(sm, "TOOL_ARGS_FIELD");
  const IDS = ["provider.cli", "provider.cli.other", "provider.argv.other"];
  type Rows = { label: string | null; other: boolean; note: { id: string; text: string; seq?: number; accounts?: string } | null };
  type Marks = { errors: Record<string, string>; redraw: Redraw; tool: Rows };

  /** The shell's wiring, in miniature (see the header): the calls in the shell's order, each decision the real one. */
  class Shell {
    draft: Draft;
    errors: Record<string, string> = {};
    redraw: Redraw = NO_REDRAW;
    rows: Rows = { label: null, other: false, note: null };
    /** Round 12: the shell's gesture count; each `field` is a gesture of its own. */
    gesture = 0;
    constructor(public saved: string) {
      this.draft = parse(saved);
      this.sync();
    }
    /** The shell's `$effect.pre` on row 1. */
    sync(): void {
      const next = toolRowsAfter(this.rows as never, firstRowLabel(this.draft), this.errors, this.redraw) as unknown as { rows: Rows; errors: Record<string, string>; redraw: Redraw } | null;
      if (next !== null) {
        this.rows = next.rows;
        this.errors = next.errors;
        this.redraw = next.redraw;
      }
      // Round 12 (L1): the shell's second `$effect.pre`.
      this.rows = fn<(d: Draft, r: Rows) => Rows>(pm, "toolRowsDrawn")(this.draft, this.rows);
    }
    /** `onfield`: `writeField`, then `fieldEdited` (round 12: stamped with the gesture, `noteStamp`). */
    field(f: Field, value: string): string | null {
      this.gesture += 1;
      const refused = writeField(this.draft, f, value);
      const born = fn<(d: Draft, seq: number) => unknown>(pm, "noteStamp")(this.draft, this.gesture);
      const next = fn<(m: Marks, f: Field, v: string, r: string | null, b: unknown) => Marks>(pm, "fieldEdited")({ errors: this.errors, redraw: this.redraw, tool: this.rows }, f, value, refused, born);
      this.errors = next.errors;
      this.redraw = next.redraw;
      this.rows = next.tool;
      this.sync();
      return refused;
    }
    move(from: number, to: number): void {
      expect(moveProvider(this.draft, from, to, "macos")).toBeNull();
      this.sync();
    }
    remove(label: string): void {
      expect(removeProvider(this.draft, label, "macos")).toBeNull();
      this.sync();
    }
    folder(label: string, dir: string): void {
      expect(setLoginFolder(this.draft, label, dir)).toBeNull();
      this.sync();
    }
    /** `draw`: a background reload — a new draft, the errors, marks and tool rows as they are. */
    draw(next: string = this.saved): void {
      this.draft = parse(next);
      this.sync();
    }
    /** A user's load (Discard, Reload): `draw`, then `load`'s resets. */
    load(next: string = this.saved): void {
      this.draft = parse(next);
      this.errors = {};
      this.redraw = redrawAfterReset(this.redraw);
      this.rows = { ...this.rows, other: false, note: null };
      this.sync();
    }
    /** A save that landed (`load(true, …)`): the saved file drawn, then `toolRowsAfterSave`. */
    landed(typing: boolean): void {
      this.saved = text(this.draft);
      this.draft = parse(this.saved);
      this.sync();
      // Round 12 (M1): the Save is pressed in a gesture after every edit here (`settings-r12.check.ts` has the same one).
      this.gesture += 1;
      this.rows = fn<(r: Rows, typing: boolean, sent: number) => Rows>(pm, "toolRowsAfterSave")(this.rows, typing, this.gesture);
      this.sync();
    }
    body(): string {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return flat(render(SettingsForm as any, { props: { draft: this.draft, errors: this.errors, onfield: noop, onnotifycommand: noop, ondefault: noop, onremovekey: noop, sections: PROVIDER_SECTIONS, redraw: this.redraw.count, toolOther: this.rows.other, toolNote: this.rows.note } }).body);
    }
    /** As drawn: the Tool choice's selected option, Other's inputs (null: not drawn), the note under a tool control
     *  (with the id of the field it is drawn in), and whether Save is refused — checking THE RULE on the way: no tool
     *  control ever holds an error, every input shows the draft, and Save is refused only for a drawn field's error. */
    check(): { tool: string | null; command: string | null; args: string | null; note: { id: string; text: string } | null; blocked: boolean } {
      const b = this.body();
      for (const id of IDS) expect({ id, error: this.errors[id] ?? "" }).toEqual({ id, error: "" });
      const select = /<select id="f-provider\.cli"[^>]*>(.*?)<\/select>/.exec(b)?.[1];
      const tool = select === undefined ? null : (/<option value="(\w+)" selected=""/.exec(select)?.[1] ?? null);
      /** An input's value, or a textarea's text (its line breaks are spaces here: `flat` folds whitespace runs). */
      const input = (id: string): string | null => {
        const m = new RegExp(`<(input|textarea) id="f-${id.replace(/\./g, "\\.")}"([^>]*)>([^<]*)`).exec(b);
        if (m === null) return null;
        return m[1] === "input" ? (/ value="([^"]*)"/.exec(m[2]!)?.[1] ?? "") : m[3]!.trim();
      };
      const one = (s: string): string => s.replace(/\s+/g, " ").trim();
      const command = input("provider.cli.other");
      const args = input("provider.argv.other");
      if (tool !== null) expect(tool).toBe(fn<(d: Draft, f: Field, o: boolean) => string>(pm, "toolShown")(this.draft, TOOL, this.rows.other));
      if (command !== null) expect(command).toBe(readField(this.draft, COMMAND()));
      if (args !== null) expect(args).toBe(one(readField(this.draft, ARGS())));
      const notes = [...b.matchAll(/<div class="field[^"]*">\s*<label for="f-([^"]+)"(?:(?!<div class="field).)*?<p class="note refused[^"]*" role="status">([^<]*)<\/p>/g)].map((m) => ({ id: m[1]!, text: m[2]! }));
      expect(notes.length).toBeLessThanOrEqual(1);
      const blocked = formSubmission(this.draft, this.saved, this.errors).kind === "blocked";
      expect({ blocked, liveErrors: Object.keys(liveErrors(this.draft, this.errors)).length > 0 }).toEqual({ blocked, liveErrors: blocked });
      return { tool, command, args, note: notes[0] ?? null, blocked };
    }
  }

  // "home" has a login folder: the first provider's command cannot change to another tool (`toolSwitchRefusal`).
  const LOGINS = [{ label: "work" }, { label: "home", configDir: "~/.claude-home" }];
  const A = text({ repos: ["/x"], morningTime: "07:20", provider: { ...CLAUDE, accounts: LOGINS }, fallbacks: [{ label: "cx", ...CODEX }, { label: "api", api: API }] });
  const NOT_CHANGED = /^Not changed: "home" has a login folder/;

  test("R11-M1: Codex refused on the Tool, then Advanced's arguments changed: the Tool shows Other… with the draft's command, and nothing refuses Save", () => {
    const s = new Shell(A);
    expect(s.field(TOOL, "codex")).toMatch(NOT_CHANGED);
    const refused = s.check();
    expect(refused).toMatchObject({ tool: "claude", command: null, blocked: false });
    expect(refused.note?.id).toBe("provider.cli");
    expect(refused.note?.text).toMatch(NOT_CHANGED);
    // Advanced's own arguments field: the block is no named tool now, so the Tool shows Other… and its rows.
    expect(s.field(field("provider.argv"), "-p\n--verbose")).toBeNull();
    const after = s.check();
    expect(after).toMatchObject({ tool: "other", command: "claude", blocked: false });
    expect(after.args).toBe("-p --verbose");
    const save = formSubmission(s.draft, A, s.errors);
    expect(save.kind).toBe("save");
    expect((JSON.parse((save as { text: string }).text).provider as Record<string, unknown>)["cli"]).toBe("claude");
  });

  test("(a) a refused Other command, then a background reload: Other stays open on the same row 1, its input shows the draft's command, and Save is not refused", () => {
    const s = new Shell(A);
    s.field(TOOL, "other");
    expect(s.field(COMMAND(), "codex")).toMatch(NOT_CHANGED);
    expect(s.check()).toMatchObject({ tool: "other", command: "claude", note: { id: "provider.cli.other" }, blocked: false });
    s.draw();
    expect(s.check()).toMatchObject({ tool: "other", command: "claude", blocked: false });
    // An edit elsewhere saves; nothing hidden refuses it.
    s.field(field("morningTime"), "08:00");
    expect(formSubmission(s.draft, A, s.errors).kind).toBe("save");
  });

  test("(b) a refused Other command on a row 1 with its own arguments, then two backups reordered: the input shows what Save sends", () => {
    const B = text({ repos: ["/x"], provider: { cli: "claude", argv: ["-p", "--verbose"], promptVia: "stdin", accounts: LOGINS }, fallbacks: [{ label: "cx", ...CODEX }, { label: "api", api: API }] });
    const s = new Shell(B);
    expect(s.check().tool).toBe("other");
    expect(s.field(COMMAND(), "codex")).toMatch(NOT_CHANGED);
    s.move(3, 2);
    expect(firstRowLabel(s.draft)).toBe("work");
    const c = s.check();
    expect(c).toMatchObject({ tool: "other", command: "claude", blocked: false });
    // The note stays with row 1 (row 1 did not change).
    expect(c.note?.id).toBe("provider.cli.other");
  });

  test("(c) a refused Other command, then a login folder changed (the provider object replaced, row 1 the same): Other stays, nothing refuses Save — and (round 12, L1) the note goes with the logins it named", () => {
    const s = new Shell(A);
    s.field(TOOL, "other");
    s.field(COMMAND(), "codex");
    expect(s.check().note?.id).toBe("provider.cli.other");
    const before = s.draft["provider"];
    s.folder("home", "~/.claude-two");
    expect(s.draft["provider"]).not.toBe(before);
    expect(s.check()).toMatchObject({ tool: "other", command: "claude", note: null, blocked: false });
  });

  test("(d) Codex refused on the Tool, then the Codex backup moved to the top: the note goes with the old row 1, the Tool shows the new one's tool, Save goes through", () => {
    const s = new Shell(A);
    s.field(TOOL, "codex");
    s.move(2, 0);
    expect(firstRowLabel(s.draft)).toBe("cx");
    expect(s.check()).toEqual({ tool: "codex", command: null, args: null, note: null, blocked: false });
    expect(formSubmission(s.draft, A, s.errors).kind).toBe("save");
  });

  test("a row 1 removed, and a background reload whose row 1 is another: the same reset; a backup removed keeps it", () => {
    const r = new Shell(A);
    r.field(TOOL, "other");
    r.field(COMMAND(), "codex");
    r.remove("api");
    expect(r.check()).toMatchObject({ tool: "other", note: { id: "provider.cli.other" }, blocked: false });
    r.remove("work");
    expect(firstRowLabel(r.draft)).toBe("home");
    expect(r.check()).toMatchObject({ tool: "claude", command: null, note: null, blocked: false });
    const s = new Shell(A);
    s.field(TOOL, "codex");
    s.draw(text({ repos: ["/x"], provider: { label: "solo", ...CODEX } }));
    expect(s.rows).toEqual({ label: "solo", other: false, note: null });
    expect(s.check()).toMatchObject({ tool: "codex", note: null });
  });

  test("the note goes with the next edit of a tool control (and a refusal there replaces it), a row 1 change, a load, and a save that lands", () => {
    const s = new Shell(A);
    s.field(TOOL, "codex");
    expect(s.check().note?.id).toBe("provider.cli");
    // An edit elsewhere keeps it.
    s.field(field("morningTime"), "08:00");
    expect(s.check().note?.id).toBe("provider.cli");
    // The Tool's next edit, taken: gone.
    s.field(TOOL, "claude");
    expect(s.check().note).toBeNull();
    // A refusal in Other's command, then its next edit, taken.
    s.field(TOOL, "other");
    s.field(COMMAND(), "codex");
    expect(s.check().note?.id).toBe("provider.cli.other");
    s.field(COMMAND(), "/opt/bin/claude");
    expect(s.check()).toMatchObject({ note: null, tool: "other", command: "/opt/bin/claude" });
    // A row 1 change.
    s.field(COMMAND(), "codex");
    s.move(2, 0);
    expect(s.check().note).toBeNull();
    s.move(0, 2);
    // Back on row 1, Other closed: the Tool shows the draft's tool ("/opt/bin/claude -p" reads as Claude Code).
    expect(s.check()).toMatchObject({ note: null, tool: "claude", command: null });
    // A load (Discard, Reload).
    s.field(TOOL, "codex");
    s.load();
    expect(s.check()).toMatchObject({ note: null, tool: "claude" });
    // A save that lands.
    s.field(TOOL, "codex");
    s.field(field("morningTime"), "09:00");
    s.landed(false);
    expect(s.check()).toMatchObject({ note: null, tool: "claude", blocked: false });
  });

  test("delta LOW: after a save that lands, \"Other…\" is not left open over a file whose tool is a named one — unless the user is typing in the tool rows", () => {
    const s = new Shell(A);
    s.field(TOOL, "other");
    s.field(field("morningTime"), "08:00");
    expect(s.check()).toMatchObject({ tool: "other", command: "claude" });
    s.landed(false);
    expect(s.check()).toMatchObject({ tool: "claude", command: null });
    const t = new Shell(A);
    t.field(TOOL, "other");
    t.field(field("morningTime"), "08:00");
    t.landed(true);
    expect(t.check()).toMatchObject({ tool: "other", command: "claude" });
    // A file whose tool is no named one shows Other… whatever the choice (the control).
    const u = new Shell(text({ repos: ["/x"], provider: { cli: "my-llm", argv: [], promptVia: "stdin" } }));
    u.field(field("morningTime"), "08:00");
    u.landed(false);
    expect(u.check()).toMatchObject({ tool: "other", command: "my-llm" });
  });

  test("a value taken: Other's typed command keeps Other open even when it reads as a named tool; a named tool chosen closes it", () => {
    const s = new Shell(text({ repos: ["/x"], provider: { ...CLAUDE } }));
    s.field(TOOL, "other");
    expect(s.field(COMMAND(), "claude")).toBeNull();
    expect(s.check()).toMatchObject({ tool: "other", command: "claude", note: null });
    s.field(TOOL, "codex");
    expect(s.check()).toMatchObject({ tool: "codex", command: null, note: null, blocked: false });
  });

  test("round 9's L5, through the same rule: \"Other…\" goes after a Discard and after a move that changes row 1; it stays after a move that does not", () => {
    const s = new Shell(A);
    s.field(TOOL, "other");
    expect(s.check().tool).toBe("other");
    s.load();
    expect(s.check().tool).toBe("claude");
    s.field(TOOL, "other");
    s.move(3, 2);
    expect(s.check().tool).toBe("other");
    // The API backup on top: no Tool drawn; back again, the Tool shows the draft's tool (Other closed with row 1).
    s.move(2, 0);
    expect(s.check().tool).toBeNull();
    s.move(0, 2);
    expect(s.check().tool).toBe("claude");
  });

  test("the pieces: `fieldEdited` puts a refused tool value in the note and any other field's in the errors, marked", () => {
    const edited0 = fn<(m: Marks, f: Field, v: string, r: string | null, b: { seq: number; accounts: string }) => Marks>(pm, "fieldEdited");
    // Round 12: every note is stamped with the gesture and row 1's logins it was born with.
    const born = { seq: 7, accounts: "null" };
    const edited = (m: Marks, f: Field, v: string, r: string | null): Marks => edited0(m, f, v, r, born);
    const start: Marks = { errors: { x: "y" }, redraw: NO_REDRAW, tool: { label: "work", other: false, note: null } };
    for (const f of [TOOL, COMMAND(), ARGS()]) {
      const r = edited(start, f, "v", "Not changed: why");
      expect(r).toEqual({ errors: { x: "y" }, redraw: NO_REDRAW, tool: { label: "work", other: false, note: { id: f.id, text: "Not changed: why", ...born } } });
    }
    expect(edited(start, TOOL, "other", null).tool).toEqual({ label: "work", other: true, note: null });
    expect(edited({ ...start, tool: { label: "work", other: true, note: { id: "provider.cli", text: "n", ...born } } }, TOOL, "claude", null).tool).toEqual({ label: "work", other: false, note: null });
    expect(edited(start, ARGS(), "-p", null).tool).toEqual({ label: "work", other: true, note: null });
    const timeout = field("provider.timeoutMs");
    expect(edited(start, timeout, "abc", "must be a number")).toEqual({ errors: { x: "y", "provider.timeoutMs": "must be a number" }, redraw: redrawAfterField(NO_REDRAW, timeout.id, true), tool: start.tool });
    expect(fn<string[]>(pm, "TOOL_FIELD_IDS")).toEqual(IDS);
  });
});

/* ══ R11-L2: every row 1 field's error and shown value reset when another provider becomes row 1 ═══════════════════ */

describe("R11-L2: Advanced's row 1 fields (max tokens, timeout, …) reset with the rest of row 1 when another provider becomes row 1", () => {
  // Only the base's own functions, as the shell calls them for a field that is not a tool control (`onfield`), so this
  // fails on ff3fe50fd for the reason the delta reviewer measured, not for a missing name.
  const step = (draft: Draft, errors: Record<string, string>, redraw: Redraw, rows: unknown) => {
    const next = toolRowsAfter(rows as never, firstRowLabel(draft), errors, redraw);
    return next === null ? { errors, redraw, rows } : { errors: next.errors, redraw: next.redraw, rows: next.rows as unknown };
  };

  test("a refused max tokens on an API row 1, a CLI provider moved up and back: no error comes back, the input is drawn again, Save is not refused", () => {
    const L = text({ repos: ["/x"], provider: { label: "api1", api: API }, fallbacks: [{ label: "cx", ...CODEX }] });
    const draft = parse(L);
    let s = step(draft, {}, NO_REDRAW, { label: null, other: false, note: null });
    const max = field("provider.api.maxTokens");
    const refused = writeField(draft, max, "abc");
    expect(refused).toBe("must be a number");
    s = { ...s, errors: { ...s.errors, [max.id]: refused! }, redraw: redrawAfterField(s.redraw, max.id, true) };
    expect(formSubmission(draft, L, s.errors).kind).toBe("blocked");
    expect(moveProvider(draft, 1, 0, "macos")).toBeNull();
    s = step(draft, s.errors, s.redraw, s.rows);
    expect(s.errors[max.id] ?? "").toBe("");
    expect(s.redraw.count[max.id]).toBe(1);
    expect(s.redraw.pending).not.toContain(max.id);
    expect(moveProvider(draft, 1, 0, "macos")).toBeNull();
    s = step(draft, s.errors, s.redraw, s.rows);
    expect(firstRowLabel(draft)).toBe("api1");
    expect(formSubmission(draft, L, s.errors)).toEqual({ kind: "unchanged" });
  });

  test("a refused timeout on a CLI row 1, an API provider moved up: the same; a backup moved (row 1 the same) keeps the error and its mark", () => {
    const L = text({ repos: ["/x"], provider: { label: "work", ...CLAUDE }, fallbacks: [{ label: "cx", ...CODEX }, { label: "api", api: API }] });
    const draft = parse(L);
    let s = step(draft, {}, NO_REDRAW, { label: null, other: false, note: null });
    const timeout = field("provider.timeoutMs");
    const refused = writeField(draft, timeout, "soon");
    s = { ...s, errors: { ...s.errors, [timeout.id]: refused! }, redraw: redrawAfterField(s.redraw, timeout.id, true) };
    expect(moveProvider(draft, 2, 1, "macos")).toBeNull();
    s = step(draft, s.errors, s.redraw, s.rows);
    expect([s.errors[timeout.id], s.redraw.pending]).toEqual(["must be a number", [timeout.id]]);
    expect(moveProvider(draft, 1, 0, "macos")).toBeNull();
    s = step(draft, s.errors, s.redraw, s.rows);
    expect([s.errors[timeout.id], s.redraw.count[timeout.id]]).toEqual(["", 1]);
    expect(formSubmission(draft, L, s.errors).kind).toBe("save");
  });

  test("the set: every field under `provider` (Advanced's included), and nothing else", () => {
    const ids = fn<string[]>(pm, "ROW_ONE_FIELD_IDS");
    expect(ids).toEqual(SECTIONS.flatMap((s) => s.fields).filter((f) => f.path[0] === "provider").map((f) => f.id));
    for (const id of ["provider.cli", "provider.credential", "provider.argv", "provider.promptVia", "provider.harden", "provider.timeoutMs", "provider.api.maxTokens", "provider.api.model"]) expect(ids).toContain(id);
    expect(ids).not.toContain("morningTime");
  });
});

/* ══ R11-M2, R11-L4: a Test still running when a write lands never brings back the answer the write dropped ═════════ */

describe("R11-M2: per-source generations — a Test's answer is shown only for sources no write changed while it ran", () => {
  type State = { tests: Record<string, CalendarTestSource>; gens: Record<string, number> };
  const afterWrite = (): ((mode: "settings" | "wizard", s: State, keys: string[]) => State) => fn(cm, "testsAfterWrite");
  const afterAnswer = (): ((s: State, sources: CalendarTestSource[], started: Record<string, number>) => Record<string, CalendarTestSource>) => fn(cm, "testsAfterAnswer");
  const key = calModel.sourceKey;
  const MAC = key("macos", "macos");
  const mac = (status: CalendarTestSource["status"]): CalendarTestSource => ({ id: "macos", kind: "macos", status, eventsToday: status === "ok" ? 1 : null, durationMs: 5 });
  const link = (id: string, status: CalendarTestSource["status"]): CalendarTestSource => ({ id, kind: "link", status, eventsToday: status === "ok" ? 2 : null, durationMs: 5 });

  test("Allow access lands while a Test runs: the Test's stale \"couldn't read\" for the Mac source is not shown; its other answers are", () => {
    // The last answer showed the Mac source failing; a new Test starts (its generations recorded) …
    let s: State = { tests: { [MAC]: mac("not-granted") }, gens: {} };
    const started = s.gens;
    // … Allow access lands: the answer goes, the generation moves …
    s = afterWrite()("settings", s, [MAC]);
    expect(s).toEqual({ tests: {}, gens: { [MAC]: 1 } });
    // … and the Test, run before access was granted, answers.
    const shown = afterAnswer()(s, [mac("not-granted"), link("work", "ok")], started);
    expect(Object.keys(shown)).toEqual([key("link", "work")]);
    // The NEXT Test, started after the write, is shown whole.
    expect(afterAnswer()(s, [mac("ok"), link("work", "ok")], s.gens)).toEqual({ [MAC]: mac("ok"), [key("link", "work")]: link("work", "ok") });
  });

  test("a write to one link moves only that link; a write with no answer to drop still moves its generation", () => {
    let s: State = { tests: { [key("link", "a")]: link("a", "offline"), [key("link", "b")]: link("b", "ok") }, gens: {} };
    const started = { ...s.gens };
    s = afterWrite()("settings", s, [key("link", "a")]);
    expect(Object.keys(s.tests)).toEqual([key("link", "b")]);
    s = afterWrite()("settings", s, [MAC]);
    expect(s.gens).toEqual({ [key("link", "a")]: 1, [MAC]: 1 });
    expect(afterAnswer()(s, [link("a", "offline"), link("b", "timeout"), mac("timeout")], started)).toEqual({ [key("link", "b")]: link("b", "timeout") });
  });

  test("the wizard's step behaves as it always did: a write drops nothing and moves nothing, and every answer is shown", () => {
    const s: State = { tests: { [MAC]: mac("not-granted") }, gens: {} };
    expect(afterWrite()("wizard", s, [MAC])).toBe(s);
    expect(afterAnswer()(s, [mac("not-granted")], {})).toEqual({ [MAC]: mac("not-granted") });
    // And in Settings, an answer with no write in between replaces the shown answers whole, as before.
    expect(afterAnswer()({ tests: { [key("link", "gone")]: link("gone", "ok") }, gens: { [MAC]: 2 } }, [mac("ok")], { [MAC]: 2 })).toEqual({ [MAC]: mac("ok") });
  });
});

/* ══ R11-L1: a backup's out-of-usage and paused sentences ═══════════════════════════════════════════════════════════ */

describe("R11-L1: only row 1's mark hands the briefing to the next provider; a backup's is skipped", () => {
  type Readable = Extract<ProvidersView, { readable: true }>;
  const row = (index: number, label: string, kind: string, status: StatusProviderRow["status"]): StatusProviderRow => ({ index, label, kind, status, revision: `rev-${index}` });
  const L = text({ repos: ["/x"], provider: { label: "first", ...CLAUDE }, fallbacks: [{ label: "usage", ...CODEX }, { label: "paused", api: API }, { label: "last", api: { ...API, model: "n" } }] });

  test("row 1 working, a backup out of usage, a backup paused: each backup says it is skipped until then, never that the next provider writes the briefing", () => {
    const rows = [
      row(0, "first", "cli", { kind: "working", at: iso(7, 24) }),
      row(1, "usage", "cli", { kind: "out-of-usage", until: iso(13, 0) }),
      row(2, "paused", "anthropic", { kind: "paused", until: iso(15, 0), reason: "unreachable" }),
      row(3, "last", "anthropic", { kind: "out-of-usage", until: iso(14, 0) }),
    ];
    const v = providersView({ draft: parse(L), savedText: L, rows, now: NOW }) as Readable;
    const sentence = (label: string) => (v.rows.find((r) => r.label === label) as unknown as { sentence: { lead: string; rest: string | null } }).sentence;
    expect(sentence("usage")).toMatchObject({ lead: "Out of usage until 13:00.", rest: "It is skipped until then." });
    expect(sentence("paused")).toMatchObject({ lead: "Paused until 15:00 after it could not be reached.", rest: "It is skipped until then." });
    expect(sentence("last")).toMatchObject({ lead: "Out of usage until 14:00.", rest: "It is skipped until then." });
    for (const r of v.rows) expect(JSON.stringify((r as unknown as { sentence: unknown }).sentence)).not.toContain("next provider");
  });

  test("row 1 out of usage keeps its sentence (the next provider does write the briefing), and says none when it is the only one", () => {
    const rows = [row(0, "first", "cli", { kind: "out-of-usage", until: iso(13, 0) }), row(1, "usage", "cli", { kind: "working", at: iso(7, 0) }), row(2, "paused", "anthropic", { kind: "not-tested" }), row(3, "last", "anthropic", { kind: "not-tested" })];
    const v = providersView({ draft: parse(L), savedText: L, rows, now: NOW }) as Readable;
    expect((v.rows[0] as unknown as { sentence: unknown }).sentence).toMatchObject({ rest: "Until then your briefing is written by the next provider." });
    const say = fn<(s: StatusProviderRow["status"], now: Date, isCli: boolean, isLast: boolean, isFirst: boolean) => { rest: string | null }>(sm, "statusSentence");
    expect(say({ kind: "out-of-usage", until: iso(13, 0) }, NOW, true, true, true).rest).toBeNull();
  });
});
