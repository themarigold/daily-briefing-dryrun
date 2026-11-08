/**
 * PR D round 10 fix pass: the behaviours the round's reviewers found broken (M1–M3, the LOWs), driven through the model,
 * the shell's own pure steps and server renders rather than pinned as source. Every new name is read dynamically, so
 * this file loads (and fails test by test) on the base, 8c3cd5057. Read-only engine imports only (as
 * `settings-r9.check.ts`). The client-only fixes (H1's switch, M4's focus, M5's drag, L4's radio) are checked in a
 * browser on the preview; the PR notes give the probe and its numbers. Round 11 (L8): M1's tests, which drove a
 * hand-built copy of the shell's wiring, moved to `settings-r11.check.ts` with the rule that replaced theirs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { render } from "svelte/server";

import { noticeLines } from "../../src/failover";
import * as settingsModel from "../src/lib/settings-model";
import * as pagesModel from "../src/lib/settings/pages";
import { providersView, SECTIONS, writeField, type Draft, type Field, type ProvidersView } from "../src/lib/settings-model";
import { changedPages } from "../src/lib/settings/pages";
import { localDate } from "../src/lib/today";
import ProvidersList from "../src/lib/ProvidersList.svelte";
import SettingsForm from "../src/routes/SettingsForm.svelte";
import CalendarSettings from "../src/lib/CalendarSettings.svelte";
import type { CalendarListJson, CalendarStatusJson, CalendarTestJson } from "../src/lib/calendar-contract";

const sm = settingsModel as unknown as Record<string, unknown>;
const fn = <T>(mod: Record<string, unknown>, name: string): T => {
  const f = mod[name];
  if (f === undefined) throw new Error(`${name} is not exported`);
  return f as T;
};

const CLAUDE = { cli: "claude", argv: ["-p"], promptVia: "stdin" };
const NOW = new Date(2026, 9, 18, 12, 0, 0);
const text = (v: unknown): string => JSON.stringify(v, null, 2);
const parse = (s: string): Draft => JSON.parse(s) as Draft;
const flat = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
const words = (html: string): string => html.replace(/<\/?(p|div|li|label|fieldset|legend)\b[^>]*>/g, " ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").replace(/ ([.,;])/g, "$1").trim();
const noop = (): void => {};
const PROVIDER_SECTIONS = ["Provider (command-line tool)", "Provider (API)"];

/* ══ M1: moved ══════════════════════════════════════════════════════════════════════════════════════════════════ */

// Round 11 (M1, L8): round 10's M1 tests drove a HAND-BUILT COPY OF THE SHELL'S WIRING (a `Shell` class re-doing
// `onfield`, the form's `ontoolother` and the row 1 effect around the real `toolRowsAfter`), and pinned the rule round 11
// replaced: a refused tool value is no longer an error at all. Their four paths, (a)–(d), and round 9's L5 now live in
// `settings-r11.check.ts`, adapted to the new rule, through the real decision functions (`fieldEdited`, `toolRowsAfter`,
// `toolRowsAfterSave`, `toolShown`); its `Shell` still copies the ORDER of the shell's calls, and says so.

/* ══ M2: "another provider wrote it", wherever the entry not tried stands ═════════════════════════════════════════ */

describe("M2: Today's briefing names no wrong writer when the page names none", () => {
  const LIST_TEXT = text({ repos: ["/x"], provider: { ...CLAUDE, accounts: [{ label: "work" }] }, fallbacks: [{ label: "backup", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }] });
  const until = new Date(NOW.getTime() + 3 * 3600e3).toISOString();
  const line = (lines: string[]): string => {
    const page = [...lines, `☀️  Daily briefing — ${localDate(NOW)}`, "", "▶ Recap", "   • x"].join("\n");
    const providers = providersView({ draft: parse(LIST_TEXT), savedText: LIST_TEXT, rows: null, now: NOW, latestPage: page, latestMtime: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = flat(render(SettingsForm as any, { props: { draft: parse(LIST_TEXT), errors: {}, onfield: noop, onnotifycommand: noop, ondefault: noop, onremovekey: noop, sections: PROVIDER_SECTIONS, providers } }).body);
    const at = b.indexOf('<p class="today');
    return at === -1 ? "" : words(b.slice(at, b.indexOf("</p>", at)));
  };

  test("the entry not tried is FIRST (the next one wrote it) and AFTER the winner (the first one wrote it): one true sentence for both, from the engine's own notice lines", () => {
    // `src/failover.ts` `noticeLines`, as the engine writes them on each day.
    const firstSkipped = noticeLines([{ label: "work", kind: "cli", outcome: "skipped-by-mark", reason: "usage", until } as never, { label: "backup", kind: "anthropic", outcome: "won" } as never], "backup", NOW);
    const laterSkipped = noticeLines([{ label: "work", kind: "cli", outcome: "won" } as never, { label: "backup", kind: "anthropic", outcome: "skipped-by-mark", reason: "unreachable", until } as never], "work", NOW);
    expect(firstSkipped).toHaveLength(1);
    expect(laterSkipped).toHaveLength(1);
    for (const lines of [firstSkipped, laterSkipped]) {
      const said = line(lines);
      expect(said).toMatch(/^Today's briefing: \w+ not tried \(.+\), so another provider wrote it\.$/);
      expect(said).not.toContain("next provider");
    }
    expect(line(laterSkipped)).toStartWith("Today's briefing: backup not tried");
  });

  test("docs/PROVIDERS.md says the same", () => {
    const docs = readFileSync(new URL("../../docs/PROVIDERS.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(docs).toContain("(or, on a day the page names none, that another provider wrote it)");
    expect(docs).not.toContain("that the next provider wrote it");
  });
});

/* ══ M3: a stale or switched-off "Test now" answer never outranks the source ══════════════════════════════════════ */

describe("M3: a Mac source that is itself switched off never shows a failed test", () => {
  const T = `${localDate(new Date())}T07:20:00`;
  const MAC_OK: CalendarListJson["macos"] = { status: "ok", calendars: [{ id: "c1", title: "Home", account: "iCloud", editable: true, type: "standard", selected: true }] };
  const failed: CalendarTestJson = { schemaVersion: 1, ranAt: T, incomplete: true, sources: [{ id: "macos", kind: "macos", status: "timeout", eventsToday: null, durationMs: 5 }] };
  const status = (enabled: boolean): CalendarStatusJson => ({ schemaVersion: 1, enabled, enabledSet: true, macSupported: true, configWarnings: [], sources: [] });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const draw = (initial: Record<string, unknown>): string => flat(render(CalendarSettings as any, { props: { os: "macos", initial } }).body);
  const macRowOf = (b: string): string => {
    const at = b.indexOf('aria-controls="cal-src-macos"');
    return b.slice(b.lastIndexOf("<li", at), b.indexOf("</li>", at));
  };
  const tag = (li: string): string => /<span class="tag tone-(\w+)[^"]*"><span aria-hidden="true">●<\/span> ([^<]*)<\/span>/.exec(li)?.slice(1).join(":") ?? "";

  test("calendar off, the Mac source switched off, a failed test from this mount: its row says off, stays closed, and shows no Test line", () => {
    const b = draw({ configText: JSON.stringify({ calendar: { enabled: false, links: [] } }), list: { schemaVersion: 1, macos: MAC_OK, links: [] }, status: status(false), test: failed });
    const li = macRowOf(b);
    expect(tag(li)).toBe("muted:off");
    expect(li).toContain('aria-expanded="false"');
    expect(li).not.toContain("Test:");
    expect(li).not.toMatch(/class="item src[^"]* needs/);
  });

  test("controls: the Mac source ON with the calendar off still shows its failed test (round 9, M2); the calendar on, a Mac source off says off", () => {
    const on = draw({ configText: JSON.stringify({ calendar: { enabled: false, macos: { calendars: "editable" }, links: [] } }), list: { schemaVersion: 1, macos: MAC_OK, links: [] }, status: status(false), test: failed });
    expect(tag(macRowOf(on))).toBe("warn:couldn't read");
    expect(macRowOf(on)).toContain("Test:");
    const calOn = draw({ configText: JSON.stringify({ calendar: { enabled: true, links: [] } }), list: { schemaVersion: 1, macos: MAC_OK, links: [] }, status: status(true), test: failed });
    expect(tag(macRowOf(calOn))).toBe("muted:off");
  });
});

/* ══ the LOWs ════════════════════════════════════════════════════════════════════════════════════════════════════ */

describe("L1: the Tool choice marks only the paths it changed", () => {
  const L = text({ repos: ["/x"], provider: CLAUDE });
  const field = (id: string): Field => SECTIONS.flatMap((s) => s.fields).find((x) => x.id === id)!;
  type WrittenBy = (f: Field, was?: Draft, now?: Draft) => Record<string, string>;

  test("an Advanced edit of the arguments, then \"Other…\" chosen (nothing written): the Advanced dot stays, AI providers gets none", () => {
    const writtenBy = pagesModel.writtenBy as unknown as WrittenBy;
    const d = parse(L);
    const step = (f: Field, v: string, on: Record<string, string>): Record<string, string> => {
      const was = structuredClone(d);
      expect(writeField(d, f, v)).toBeNull();
      return { ...on, ...writtenBy(f, was, d) };
    };
    let on = step(field("provider.argv"), "-p\n--verbose", {});
    on = step(field("provider.cli"), "other", on);
    expect(on).toEqual({ "provider.argv": "advanced" });
    const input = { tab: "form", loadedText: L, draft: d, raw: L, flowPending: false, writtenOn: on } as unknown as Parameters<typeof changedPages>[0];
    expect(changedPages(input)).toEqual(["advanced"]);
    // A named tool that changes them marks them all, as before.
    on = step(field("provider.cli"), "codex", on);
    expect(on).toEqual({ "provider.argv": "providers", "provider.cli": "providers" });
    // Without the drafts, every path the field can write (round 9's contract).
    expect(writtenBy(field("provider.cli"))).toEqual({ "provider.cli": "providers", "provider.argv": "providers", "provider.promptVia": "providers" });
  });
});

describe("L5: the guided Add's API card says a local model needs no key", () => {
  type Readable = Extract<ProvidersView, { readable: true }>;
  const view = (os: "macos" | "linux"): Readable => {
    const t = text({ repos: ["/x"], provider: CLAUDE });
    const v = providersView({ draft: parse(t), savedText: t, rows: null, now: NOW, os });
    if (!v.readable) throw new Error("unreadable");
    return v;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const card = (os: "macos" | "linux"): string => /<input type="radio" name="prov-add-choice" value="api"[^>]*\/>\s*<span class="card-words[^"]*"><span class="card-title[^"]*">[^<]*<\/span><span class="card-line[^"]*">([^<]*)<\/span>/.exec(flat(render(ProvidersList as any, { props: { view: view(os), onadd: () => true, addFormOpen: true } }).body))?.[1] ?? "";

  test("on this Mac, and on this computer elsewhere — after the key store's sentence", () => {
    expect(card("macos")).toBe("Anthropic, OpenAI, or a local model (Ollama, LM Studio). Pay per use; the app keeps the key in your Keychain. A local model on this Mac needs no key.");
    expect(card("linux")).toBe("Anthropic, OpenAI, or a local model (Ollama, LM Studio). Pay per use; the app keeps the key in your key folder. A local model on this computer needs no key.");
    // True of every service the card names as local (`API_SERVICES`' own `keyless`).
    const services = fn<{ name: string; keyless?: boolean; local?: boolean }[]>(sm, "API_SERVICES");
    expect(services.filter((s) => s.local === true).map((s) => [s.name, s.keyless === true])).toEqual([["Ollama", true], ["LM Studio", true]]);
  });
});
