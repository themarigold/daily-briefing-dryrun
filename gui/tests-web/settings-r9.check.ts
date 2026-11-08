/**
 * PR D round 9 fix pass: the behaviours four reviewers (H1), the cold reviewer and codex (M1), and the round's other
 * findings (M2–M4, the LOWs) found broken, each driven through the model or a render rather than pinned as source.
 * Every new name is read dynamically, so this file loads (and fails test by test) on the base, 43553ad66. Read-only
 * engine imports only (as `settings-layout.check.ts`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { render } from "svelte/server";

import { CALENDAR_CONFIG_WARNINGS, resolveCalendar } from "../../src/calendar/config";
import * as settingsModel from "../src/lib/settings-model";
import * as calModel from "../src/lib/calendar-settings";
import * as pagesModel from "../src/lib/settings/pages";
import { formSubmission, providersView, SECTIONS, statusLine, writeField, type Draft, type Field, type ProvidersView, type StatusProviderRow } from "../src/lib/settings-model";
import { blockedPages, changedPages } from "../src/lib/settings/pages";
import { NOTICE_PREFIX } from "../src/lib/briefing-md";
import { localDate } from "../src/lib/today";
import ProvidersList from "../src/lib/ProvidersList.svelte";
import SettingsForm from "../src/routes/SettingsForm.svelte";
import CalendarSettings from "../src/lib/CalendarSettings.svelte";
import type { CalendarListJson, CalendarStatusJson, CalendarTestJson } from "../src/lib/calendar-contract";

const sm = settingsModel as unknown as Record<string, unknown>;
const cm = calModel as unknown as Record<string, unknown>;
const pm = pagesModel as unknown as Record<string, unknown>;
const fn = <T>(mod: Record<string, unknown>, name: string): T => {
  const f = mod[name];
  if (f === undefined) throw new Error(`${name} is not exported`);
  return f as T;
};

const CLAUDE = { cli: "claude", argv: ["-p"], promptVia: "stdin" };
const CODEX = { cli: "codex", argv: ["exec"], promptVia: "stdin" };
const NOW = new Date(2026, 9, 18, 12, 0, 0);
const iso = (h: number, m: number, day = 18): string => new Date(2026, 9, day, h, m, 0).toISOString();
const text = (v: unknown): string => JSON.stringify(v, null, 2);
const parse = (s: string): Draft => JSON.parse(s) as Draft;
const flat = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
const words = (html: string): string => html.replace(/<\/?(p|div|li|label|fieldset|legend)\b[^>]*>/g, " ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").replace(/ ([.,;])/g, "$1").trim();
type Readable = Extract<ProvidersView, { readable: true }>;
const readable = (v: ProvidersView | undefined): Readable => {
  if (v === undefined || !v.readable) throw new Error("unreadable view");
  return v;
};
const statusRow = (index: number, label: string, kind: string, status: StatusProviderRow["status"]): StatusProviderRow => ({ index, label, kind, status, revision: `rev-${index}` });
const noop = (): void => {};

/* ══ H1: Test all tests each eligible row, in turn ══════════════════════════════════════════════════════════════ */

describe("H1: Test all runs each eligible row's own Test, in order, holding the others", () => {
  type Run = (start: ProvidersView, current: () => ProvidersView | undefined, hold: (on: boolean) => void, test: (label: string, draftIndex: number) => Promise<void>) => Promise<string[]>;
  // Four rows: a Claude login, Codex, an API row with a key written in the settings file (its Test is not offered: it
  // must be moved first), and an API row with its key in the environment.
  const LIST = {
    repos: ["/x"],
    provider: { ...CLAUDE, accounts: [{ label: "work" }] },
    fallbacks: [
      { label: "codex", ...CODEX },
      { label: "lit", api: { kind: "anthropic", model: "m", apiKey: "(a literal API key is stored in config.json; Daily Briefing never displays it)" } },
      { label: "env", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } },
    ],
  };
  const LIST_TEXT = text(LIST);

  /** The shell, in miniature: its `testingAll` and `testing`, the view derived from them, and a Test that records
   *  what the screen offered while it ran. */
  function shell(draft: Draft = parse(LIST_TEXT)) {
    const s = { testingAll: false, testing: null as string | null, holds: [] as boolean[] };
    const current = (): ProvidersView => providersView({ draft, savedText: LIST_TEXT, rows: null, now: NOW, os: "macos", testingAll: s.testingAll, testing: s.testing });
    const seen: { label: string; draftIndex: number; othersHeld: boolean; testAllHeld: boolean; ownText: string }[] = [];
    const test = async (label: string, draftIndex: number): Promise<void> => {
      s.testing = label;
      const v = readable(current());
      seen.push({
        label,
        draftIndex,
        othersHeld: v.rows.filter((r) => r.label !== label).every((r) => !r.test.enabled),
        testAllHeld: v.testAll?.enabled === false,
        ownText: v.rows.find((r) => r.label === label)!.test.text,
      });
      await Promise.resolve();
      s.testing = null;
    };
    return { s, current, test, seen, hold: (on: boolean) => (s.holds.push(on), (s.testingAll = on)) };
  }

  test("each row whose Test is live is tested, in the list's order, with its own draft index; the written-key row is passed over", async () => {
    const run = fn<Run>(sm, "testAllInTurn");
    const sh = shell();
    const start = readable(sh.current());
    // What the user saw when pressing Test all: three rows' Tests live, the written-key row's not (with its reason).
    expect(start.rows.map((r) => [r.label, r.test.enabled])).toEqual([["work", true], ["codex", true], ["lit", false], ["env", true]]);
    expect(start.testAll?.enabled).toBe(true);
    const tested = await run(start, sh.current, sh.hold, sh.test);
    expect(tested).toEqual(["work", "codex", "env"]);
    expect(sh.seen.map((x) => [x.label, x.draftIndex])).toEqual([["work", 0], ["codex", 1], ["env", 3]]);
    // While each one runs, every other row's Test and Test all itself are held; the running row says so.
    expect(sh.seen.every((x) => x.othersHeld && x.testAllHeld)).toBe(true);
    expect(sh.seen.map((x) => x.ownText)).toEqual(["Testing…", "Testing…", "Testing…"]);
    // The hold was taken once and given back once, and the screen is free again.
    expect(sh.s.holds).toEqual([true, false]);
    expect(readable(sh.current()).rows.map((r) => r.test.enabled)).toEqual([true, true, false, true]);
  });

  test("the hold is given back when a row's Test throws; nothing runs when Test all is not offered", async () => {
    const run = fn<Run>(sm, "testAllInTurn");
    const sh = shell();
    await expect(run(readable(sh.current()), sh.current, sh.hold, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(sh.s.holds).toEqual([true, false]);
    // A Test already running (Test all disabled): no run, no hold.
    const busy = shell();
    busy.s.testing = "work";
    expect(await run(readable(busy.current()), busy.current, busy.hold, busy.test)).toEqual([]);
    expect(busy.s.holds).toEqual([]);
  });

  test("during the run: a row moved is tested at its new place; a row removed, or one whose own Test went (a key typed in), is passed over", async () => {
    const run = fn<Run>(sm, "testAllInTurn");
    const draft = parse(LIST_TEXT);
    const sh = shell(draft);
    const start = readable(sh.current());
    const fallbacks = draft["fallbacks"] as Record<string, unknown>[];
    const order: [string, number][] = [];
    await run(start, sh.current, sh.hold, async (label, i) => {
      order.push([label, i]);
      if (label === "work") {
        // Codex removed, and "env" given a key written in the settings file, while the first Test ran.
        fallbacks.splice(0, 1);
        (fallbacks.find((f) => f["label"] === "env")!["api"] as Record<string, unknown>)["apiKey"] = "sk";
      }
    });
    expect(order).toEqual([["work", 0]]);
    const moved = parse(LIST_TEXT);
    const sh2 = shell(moved);
    const order2: [string, number][] = [];
    await run(readable(sh2.current()), sh2.current, sh2.hold, async (label, i) => {
      order2.push([label, i]);
      if (label === "work") {
        const f = moved["fallbacks"] as unknown[];
        f.unshift(f.pop()); // "env" moved up, before Codex
      }
    });
    expect(order2).toEqual([["work", 0], ["codex", 2], ["env", 1]]);
  });

  test("the bug, measured: the loop that read the rows after taking the hold found no row to test", () => {
    // The view under the hold, as the old handler read it: every row's Test disabled, so it skipped them all.
    const held = readable(providersView({ draft: parse(LIST_TEXT), savedText: LIST_TEXT, rows: null, now: NOW, os: "macos", testingAll: true }));
    expect(held.rows.filter((r) => r.test.enabled !== false)).toEqual([]);
    // docs/PROVIDERS.md's promise, which the run above keeps.
    expect(readFileSync(new URL("../../docs/PROVIDERS.md", import.meta.url), "utf8").replace(/\s+/g, " ")).toContain("**Test all** runs each row's Test in turn.");
  });
});

/* ══ M1: a refused value in Other's rows — round 11 (M1): a note that blocks nothing ════════════════════════════════ */

// Round 9 made a refused value in Other's rows an error that blocked Save; rounds 10 and 11 found that error drifting
// from what was drawn, three times. Round 11 (M1) replaced the rule: a refused tool value is never written, so nothing
// waits on it — it is a note under the control (`settings/pages.ts` `fieldEdited`; `settings-r11.check.ts` drives it).
describe("M1, as round 11 has it: a refused value in Other's command leaves the draft as it was, blocks nothing, and is said in a note", () => {
  // "home" has a login folder: the first provider's command cannot change to another tool (`toolSwitchRefusal`).
  const TEXT = text({ repos: ["/x"], morningTime: "07:20", provider: { ...CLAUDE, accounts: [{ label: "work" }, { label: "home", configDir: "~/.claude-home" }] } });
  const command = (): Field => fn<Field>(sm, "TOOL_COMMAND_FIELD");
  const field = (id: string): Field => SECTIONS.flatMap((s) => s.fields).find((f) => f.id === id)!;
  type Marks = { errors: Record<string, string>; redraw: { pending: string[]; count: Record<string, number> }; tool: { label: string | null; other: boolean; note: { id: string; text: string } | null } };

  test("refused in Other's command: the draft keeps its command, no error is kept, Save goes through with another edit, and no page is named", () => {
    const draft = parse(TEXT);
    const refused = writeField(draft, command(), "codex");
    expect(refused).toContain("Not changed:");
    expect((draft["provider"] as Record<string, unknown>)["cli"]).toBe("claude");
    const marks = fn<(m: Marks, f: Field, v: string, r: string | null) => Marks>(pm, "fieldEdited")({ errors: {}, redraw: { pending: [], count: {} }, tool: { label: "work", other: true, note: null } }, command(), "codex", refused);
    expect(marks.errors).toEqual({});
    expect(marks.tool.note).toEqual({ id: command().id, text: refused! });
    expect(formSubmission(draft, TEXT, marks.errors)).toEqual({ kind: "unchanged" });
    writeField(draft, field("morningTime"), "08:00");
    expect(formSubmission(draft, TEXT, marks.errors).kind).toBe("save");
    expect(blockedPages(draft, marks.errors)).toEqual([]);
  });

  test("drawn: the note is in row 1, under Other's command, as a note — not a field error", () => {
    const draft = parse(text({ repos: ["/x"], provider: { cli: "my-llm", argv: [], promptVia: "stdin", accounts: [{ label: "work" }, { label: "home", configDir: "~/.h" }] } }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = flat(render(SettingsForm as any, { props: { draft, errors: {}, onfield: noop, onnotifycommand: noop, ondefault: noop, onremovekey: noop, sections: ["Provider (command-line tool)", "Provider (API)"], toolNote: { id: "provider.cli.other", text: "Not changed: x" } } }).body);
    const row1 = b.slice(b.lastIndexOf("<li", b.indexOf('aria-controls="prov-row-0"')), b.indexOf('id="prov-row-1"'));
    const box = row1.slice(row1.indexOf('<label for="f-provider.cli.other"'), row1.indexOf('<label for="f-provider.argv.other"'));
    expect(box).toMatch(/<p class="note refused[^"]*" role="status">Not changed: x<\/p>/);
    expect(row1).not.toContain('<p class="field-error');
  });
});

/* ══ M2: a failed "Test now" shows while the calendar is off ══════════════════════════════════════════════════════ */

const T = `${localDate(new Date())}T07:20:00`;
const MAC_LIST: CalendarListJson = {
  schemaVersion: 1,
  macos: { status: "ok", calendars: [{ id: "c1", title: "Home", account: "iCloud", editable: true, type: "standard", selected: true }] },
  links: [
    { id: "work", confirmedOwner: "me@x.example", urlPathOwner: "me@x.example", urlFrom: "file", fileStatus: "ok" },
    { id: "team", confirmedOwner: "me@x.example", urlPathOwner: "me@x.example", urlFrom: "file", fileStatus: "ok" },
  ],
};
const status = (enabled: boolean, configWarnings: string[] = []): CalendarStatusJson => ({
  schemaVersion: 1,
  enabled,
  enabledSet: true,
  macSupported: true,
  configWarnings,
  sources: [
    { id: "macos", kind: "macos", lastScheduledRead: { at: T, status: "ok" } },
    { id: "work", kind: "link", lastScheduledRead: { at: T, status: "ok" } },
    { id: "team", kind: "link", lastScheduledRead: { at: T, status: "ok" } },
  ],
});
const OFF = JSON.stringify({ calendar: { enabled: false, macos: { calendars: "editable" }, links: [{ id: "work" }, { id: "team" }] } });
const failedTest: CalendarTestJson = {
  schemaVersion: 1,
  ranAt: T,
  incomplete: false,
  sources: [
    { id: "macos", kind: "macos", status: "timeout", eventsToday: null, durationMs: 5 },
    { id: "work", kind: "link", status: "offline", eventsToday: null, durationMs: 5 },
    { id: "team", kind: "link", status: "ok", eventsToday: 2, durationMs: 5 },
  ],
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const drawCal = (initial: Record<string, unknown>): string => render(CalendarSettings as any, { props: { os: "macos", initial } }).body.replace(/<!--[\s\S]*?-->/g, "");
const rowOf = (html: string, id: string): string => {
  const at = html.indexOf(`aria-controls="${id}"`);
  return at === -1 ? "" : html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at) + "</li>".length);
};
const headOf = (row: string): string => row.slice(row.indexOf("<button"), row.indexOf("</button>") + "</button>".length);
const tagOf = (row: string): string | null => /<span class="tag tone-(\w+)[^"]*"><span aria-hidden="true">●<\/span> ([^<]*)<\/span>/.exec(headOf(row))?.slice(1, 3).join(":") ?? null;

describe("M2: while the calendar is off, a source this screen's Test now failed on shows its failure", () => {
  test("the decision: a failed test shows the source's own warning (or \"couldn't read\"); a passing or no test keeps \"off\"; on, the source's own tag", () => {
    const shown = fn<(on: boolean, tag: unknown, test?: unknown) => unknown>(cm, "shownSourceTag");
    const failed = { id: "work", kind: "link", status: "offline", eventsToday: null, durationMs: 5 };
    const ok = { ...failed, status: "ok", eventsToday: 1 };
    const warn = { text: "couldn't read", tone: "warn" };
    const linkTag = calModel.linkSourceTag({ id: "work", urlFrom: "file", fileStatus: "ok", confirmedOwner: null }, { read: null, test: failed as never, notices: [], declined: false, today: "2026-10-22" });
    expect(linkTag).toEqual(warn);
    expect(shown(false, linkTag, failed)).toEqual(warn);
    expect(shown(false, { text: "needs access", tone: "warn" }, failed)).toEqual({ text: "needs access", tone: "warn" });
    expect(shown(false, null, failed)).toEqual(warn);
    expect(shown(false, { text: "read today 07:20", tone: "ok" }, ok)).toEqual({ text: "off", tone: "muted" });
    expect(shown(false, linkTag, undefined)).toEqual({ text: "off", tone: "muted" });
    expect(shown(true, linkTag, failed)).toEqual(linkTag);
  });

  test("drawn: the failed link and the failed Mac source say so and open, with their Test line; the passing link stays off and closed", () => {
    const b = drawCal({ configText: OFF, list: MAC_LIST, status: status(false), test: failedTest });
    const work = rowOf(b, "cal-src-link-work");
    expect(tagOf(work)).toBe("warn:couldn't read");
    expect(headOf(work)).toMatch(/aria-expanded="true"/);
    expect(work).toContain("Test: could not be reached — no network");
    const mac = rowOf(b, "cal-src-macos");
    expect(tagOf(mac)).toBe("warn:couldn't read");
    expect(headOf(mac)).toMatch(/aria-expanded="true"/);
    expect(mac).toContain("Test: did not answer in time");
    const team = rowOf(b, "cal-src-link-team");
    expect(tagOf(team)).toBe("muted:off");
    expect(headOf(team)).toMatch(/aria-expanded="false"/);
    // Untested, everything is C1's "off", closed.
    const untested = drawCal({ configText: OFF, list: MAC_LIST, status: status(false) });
    for (const id of ["cal-src-link-work", "cal-src-link-team"]) expect({ id, tag: tagOf(rowOf(untested, id)) }).toEqual({ id, tag: "muted:off" });
    expect(headOf(rowOf(untested, "cal-src-link-work"))).toMatch(/aria-expanded="false"/);
  });
});

/* ══ M3: the engine's own on/off ═════════════════════════════════════════════════════════════════════════════════ */

describe("M3: Settings shows the calendar off when the engine turned it off for settings it cannot read", () => {
  const BROKEN = { enabled: true, emails: "not-a-list", links: [{ id: "work" }] };

  test("measured: the engine reads that block as off, with the emails warning", () => {
    const r = resolveCalendar(BROKEN, { platform: "darwin" });
    expect(r.enabled).toBe(false);
    expect(r.warnings).toEqual([CALENDAR_CONFIG_WARNINGS.emails]);
  });

  test("the decision: the file's switch, and the engine's answer once known", () => {
    const readOn = fn<(b: unknown, s: CalendarStatusJson | null) => boolean>(cm, "calendarReadOn");
    expect(readOn(BROKEN, status(false, [CALENDAR_CONFIG_WARNINGS.emails]))).toBe(false);
    expect(readOn(BROKEN, null)).toBe(true);
    expect(readOn({ enabled: true }, status(true))).toBe(true);
    expect(readOn({ enabled: false }, status(true))).toBe(false);
    expect(calModel.calendarOn(BROKEN)).toBe(true);
    const help = fn<(on: boolean, mac: boolean, unreadable?: boolean) => { text: string; off: boolean }>(cm, "connectionsHelp");
    // Round 10 (H1): and the switch cannot save meanwhile — the line says where the settings are fixed.
    expect(help(false, true, true)).toEqual({
      text: "The calendar is off until the problem below is fixed: the engine could not read its settings, and until then this page cannot save them, its switch included. Fix them with Edit settings as JSON on Settings → Advanced.",
      off: true,
    });
    expect(help(false, true)).toEqual({ text: "The calendar is off, so these aren't read. Turn it on above.", off: true });
  });

  test("drawn: the switch shows the file's on (it cannot save until the settings are fixed — round 10, H1), the label DISABLED, the line saying why, the engine's warning below it, and every tag off", () => {
    const b = drawCal({ configText: JSON.stringify({ calendar: BROKEN }), list: { schemaVersion: 1, macos: null, links: [MAC_LIST.links[0]!] }, status: { ...status(false, [CALENDAR_CONFIG_WARNINGS.emails]), sources: [] } });
    expect(b).toMatch(/<input id="cal-master" type="checkbox" role="switch" class="switch[^"]*" aria-describedby="cal-master-line" checked=""/);
    expect(b).toMatch(/<span class="badge badge-off[^"]*">Disabled<\/span>/);
    expect(b).toMatch(/<p class="help[^"]* offhelp" id="cal-conn-help">The calendar is off until the problem below is fixed: the engine could not read its settings, and until then this page cannot save them, its switch included\. Fix them with Edit settings as JSON on Settings → Advanced\.<\/p>/);
    expect(b).toContain(`Your calendar settings could not be read: ${CALENDAR_CONFIG_WARNINGS.emails}`);
    expect(b.indexOf("offhelp")).toBeLessThan(b.indexOf("Your calendar settings could not be read"));
    expect(tagOf(rowOf(b, "cal-src-link-work"))).toBe("muted:off");
    // The same block while the engine's status is unknown: the file's on (no claim either way yet).
    const unknown = drawCal({ configText: JSON.stringify({ calendar: BROKEN }), list: { schemaVersion: 1, macos: null, links: [MAC_LIST.links[0]!] }, status: null });
    expect(unknown).toMatch(/<span class="badge badge-on[^"]*">Enabled<\/span>/);
  });
});

/* ══ M4: today's line on a fallback day with no winner named ════════════════════════════════════════════════════ */

describe("M4: Today's briefing on the day the first provider was not tried", () => {
  const page = (notices: string[]) => [...notices.map((n) => NOTICE_PREFIX + n), `☀️  Daily briefing — ${localDate(NOW)}`, "", "▶ Recap", "   • x"].join("\n");
  const LIST_TEXT = text({ repos: ["/x"], provider: { ...CLAUDE, accounts: [{ label: "work" }] }, fallbacks: [{ label: "backup", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }] });
  const line = (latestPage: string, latestMtime: string | null): string => {
    const providers = providersView({ draft: parse(LIST_TEXT), savedText: LIST_TEXT, rows: null, now: NOW, latestPage, latestMtime });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = flat(render(SettingsForm as any, { props: { draft: parse(LIST_TEXT), errors: {}, onfield: noop, onnotifycommand: noop, ondefault: noop, onremovekey: noop, sections: ["Provider (command-line tool)", "Provider (API)"], providers } }).body);
    return words(b.slice(b.indexOf('<p class="today'), b.indexOf("</p>", b.indexOf('<p class="today'))));
  };

  // Round 10 (M2): "another provider", not "the next": the entry not tried may come after the winner
  // (`settings-r10.check.ts` drives both positions through the engine's own notice lines).
  test("a whole sentence: who was not tried, that another provider wrote it, and when", () => {
    expect(line(page(['Not tried "work": out of usage until 12:00']), iso(7, 24))).toBe("Today's briefing: work not tried (out of usage until 12:00), so another provider wrote it at 07:24.");
    expect(line(page(['Not tried "work": out of usage until 12:00']), null)).toBe("Today's briefing: work not tried (out of usage until 12:00), so another provider wrote it.");
    // The engine named the winner: as before.
    expect(line(page(['Skipped "work": out of usage — used "backup"']), iso(7, 24))).toBe("Today's briefing: work out of usage, so backup wrote it at 07:24.");
  });

  test("docs/PROVIDERS.md says the same", () => {
    const docs = readFileSync(new URL("../../docs/PROVIDERS.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(docs).toContain("which one wrote the briefing (or, on a day the page names none, that another provider wrote it), when one was skipped.");
  });
});

/* ══ the LOWs ════════════════════════════════════════════════════════════════════════════════════════════════════ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const list = (props: Record<string, unknown>): string => flat(render(ProvidersList as any, { props }).body);
const liOf = (html: string, i: number): string => {
  const at = html.indexOf(`aria-controls="prov-row-${i}"`);
  return html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at) + 5);
};
const expanded = (html: string, i: number): string | undefined => /aria-expanded="(\w+)"/.exec(liOf(html, i))?.[1];

describe("the LOWs", () => {
  test("L3: a row whose status is bad opens by itself (invalid, key moved out, not working); a fine one stays closed", () => {
    const L = text({ repos: ["/x"], provider: CLAUDE, fallbacks: [{ label: "a", ...CODEX }, { label: "b", ...CODEX }, { label: "c", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }, { label: "d", ...CODEX }] });
    const rows = [
      statusRow(0, "default", "cli", { kind: "working", at: iso(7, 0) }),
      statusRow(1, "a", "invalid", { kind: "invalid", reason: "bad" }),
      statusRow(2, "b", "cli", { kind: "not-working", since: iso(6, 0), reason: "auth" }),
      statusRow(3, "c", "anthropic", { kind: "not-tested" }),
      statusRow(4, "d", "cli", { kind: "paused", until: iso(15, 0), reason: "unreachable" }),
    ];
    const validateRows = [{ index: 3, testTimeoutMs: 1, loopback: false, keyOptional: false, keyMoved: true, appOwnedKey: false as const }];
    const v = providersView({ draft: parse(L), savedText: L, rows, validateRows, now: NOW, os: "macos" });
    const b = list({ view: v, ontest: noop });
    expect([0, 1, 2, 3, 4].map((i) => expanded(b, i))).toEqual(["false", "true", "true", "true", "false"]);
  });

  test("L6: the Tool choice and Other's rows mark AI providers only; an Advanced edit of the same path still marks Advanced", () => {
    const writtenBy = fn<(f: Field) => Record<string, string>>(pm, "writtenBy");
    const tool = SECTIONS.flatMap((s) => s.fields).find((f) => f.id === "provider.cli")!;
    const argv = SECTIONS.flatMap((s) => s.fields).find((f) => f.id === "provider.argv")!;
    const L = text({ repos: ["/x"], provider: CLAUDE });
    const form = (draft: Draft, writtenOn?: Record<string, string>) => ({ tab: "form" as const, loadedText: L, draft, raw: L, flowPending: false, writtenOn });
    // Codex chosen: provider.cli, argv and promptVia written from AI providers.
    const d = parse(L);
    writeField(d, tool, "codex");
    expect(changedPages(form(d) as never)).toEqual(["providers", "advanced"]);
    let on = writtenBy(tool);
    expect(on).toEqual({ "provider.cli": "providers", "provider.argv": "providers", "provider.promptVia": "providers" });
    expect(changedPages(form(d, on) as never)).toEqual(["providers"]);
    // Then an argument edited on Advanced: Advanced is marked again.
    writeField(d, argv, "exec\n--x");
    on = { ...on, ...writtenBy(argv) };
    expect(changedPages(form(d, on) as never)).toEqual(["providers", "advanced"]);
    // Only Other's arguments edited: AI providers, not Advanced.
    const o = parse(L);
    const otherArgs = fn<Field>(sm, "TOOL_ARGS_FIELD");
    writeField(o, otherArgs, "-p\n--y");
    expect(changedPages(form(o, writtenBy(otherArgs)) as never)).toEqual(["providers"]);
    expect(writtenBy(fn<Field>(sm, "TOOL_COMMAND_FIELD"))).toEqual({ "provider.cli": "providers" });
  });

  test("L7, L11, L12: words that claim only what the app knows", () => {
    // L11: the stray login folder's invalid row names its one-click fix; the engine's words are matched.
    const reason = fn<string>(sm, "STRAY_FOLDER_REASON");
    expect(readFileSync(new URL("../../src/providerList.ts", import.meta.url), "utf8")).toContain(`'${reason}'`);
    expect(statusLine({ kind: "invalid", reason: `config: fallbacks[0] "x": ${reason} — this fallback is skipped` }, NOW).remedy).toBe("The briefing skips it. Clear its login folder below, or remove it.");
    expect(statusLine({ kind: "invalid", reason: "other" }, NOW).remedy).toBe("The briefing skips it. Fix it with Edit settings as JSON on Settings → Advanced, or remove it.");
    // L12: the pause's reason as a sentence says it.
    const say = settingsModel.statusSentence;
    expect(say({ kind: "paused", until: iso(15, 0), reason: "unreachable" }, NOW, false, true).lead).toBe("Paused until 15:00 after it could not be reached.");
    expect(say({ kind: "paused", until: iso(15, 0), reason: "rate-limited" }, NOW, false, true).lead).toBe("Paused until 15:00 after it was rate-limited.");
    expect(say({ kind: "paused", until: iso(15, 0), reason: "newer-reason" }, NOW, false, true).lead).toBe("Paused until 15:00 after newer-reason.");
    // L7: another tool's account is its own sign-in; Claude's still names the subscription.
    const L = text({ repos: ["/x"], provider: CLAUDE, fallbacks: [{ label: "x", cli: "my-llm", argv: [], promptVia: "stdin" }, { label: "c2", ...CLAUDE, configDir: "~/.c2" }] });
    const v = readable(providersView({ draft: parse(L), savedText: L, rows: null, now: NOW }));
    expect(v.rows.map((r) => r.facts)).toEqual([[], ["Tool: my-llm", "Account: The tool's own sign-in"], ["Tool: Claude Code (claude)", "Account: Its own login (subscription)"]]);
  });

  test("L13: while the calendar is off, the Mac switch is described by the off line, and its tag says whose switch is off", () => {
    const b = drawCal({ configText: OFF, list: MAC_LIST, status: status(false) });
    const mac = rowOf(b, "cal-src-macos");
    expect(mac).toMatch(/<input type="checkbox" role="switch" class="switch[^"]*" aria-label="Read the Mac Calendar app" aria-describedby="cal-conn-help" checked=""/);
    expect(tagOf(mac)).toBe("muted:off (calendar off)");
    expect(b).toContain('id="cal-conn-help"');
    // On: no description, its own tag.
    const on = drawCal({ configText: JSON.stringify({ calendar: { ...JSON.parse(OFF).calendar, enabled: true } }), list: MAC_LIST, status: status(true) });
    expect(rowOf(on, "cal-src-macos")).not.toContain("aria-describedby");
  });

  test("L15: row 1's Login folder carries the mockup's help line; other rows do not", () => {
    const L = text({ repos: ["/x"], provider: { ...CLAUDE, accounts: [{ label: "work" }, { label: "home", configDir: "~/.h" }] } });
    const v = providersView({ draft: parse(L), savedText: L, rows: null, now: NOW });
    const b = list({ view: v, onfolder: noop, openRows: ["work", "home"] });
    const help = fn<string>(sm, "FIRST_FOLDER_HELP");
    expect(help).toBe("Only for a second Claude account. Leave empty to use the tool's own login.");
    expect(liOf(b, 0)).toContain(help);
    expect(liOf(b, 1)).not.toContain(help);
  });
});
