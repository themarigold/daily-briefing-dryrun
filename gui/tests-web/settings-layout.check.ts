/**
 * User-directed 2026-10-22, after the A + D preview: the AI providers page's layout P-A (compact rows that open in
 * place, a status sentence, "Try again now", row 1's own settings, Test all, today's briefing), the guided Add, and the
 * Calendar page's master switch box, ENABLED/DISABLED label and C-A rows. The decisions are pinned by value against
 * the model files (`settings-model.ts`, `provider-flows.ts`, `calendar-settings.ts`); the drawing and wiring below
 * them. Read-only engine imports only (as `settings.check.ts`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { render } from "svelte/server";

import { validateConfig } from "../../src/config";
import { resolveProviderList } from "../../src/providerList";
import * as settingsModel from "../src/lib/settings-model";
import * as flows from "../src/lib/provider-flows";
import * as calModel from "../src/lib/calendar-settings";
import { providersView, writeField, SECTIONS, type Draft, type ProvidersView, type RowStatusView, type StatusProviderRow } from "../src/lib/settings-model";
import { NOTICE_PREFIX } from "../src/lib/briefing-md";
import { localDate } from "../src/lib/today";
import ProvidersList from "../src/lib/ProvidersList.svelte";
import SettingsForm from "../src/routes/SettingsForm.svelte";
import CalendarSettings from "../src/lib/CalendarSettings.svelte";
import type { CalendarLinkInfo, CalendarListJson, CalendarStatusJson } from "../src/lib/calendar-contract";

// Dynamic access, so this file loads (and fails test by test) on a base that has none of these yet.
const sm = settingsModel as unknown as Record<string, unknown>;
const fm = flows as unknown as Record<string, unknown>;
const cm = calModel as unknown as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fn = <T>(mod: Record<string, unknown>, name: string): T => mod[name] as T;

const src = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const CLAUDE = { cli: "claude", argv: ["-p"], promptVia: "stdin" };
const CODEX = { cli: "codex", argv: ["exec"], promptVia: "stdin" };
const NOW = new Date(2026, 9, 18, 12, 0, 0);
const iso = (h: number, m: number, day = 18): string => new Date(2026, 9, day, h, m, 0).toISOString();
const text = (v: unknown): string => JSON.stringify(v, null, 2);
const parse = (s: string): Draft => JSON.parse(s) as Draft;
type Readable = Extract<ProvidersView, { readable: true }>;
const view = (input: Parameters<typeof providersView>[0]): Readable => {
  const v = providersView(input);
  if (!v.readable) throw new Error(`unreadable: ${v.message}`);
  return v;
};
const row = (v: Readable, label: string) => {
  const r = v.rows.find((x) => x.label === label);
  if (r === undefined) throw new Error(`no row ${label}`);
  return r as typeof r & Record<string, unknown>;
};
const statusRow = (index: number, label: string, kind: string, status: StatusProviderRow["status"]): StatusProviderRow => ({ index, label, kind, status, revision: `rev-${index}` });
const flat = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
/** A reader's text: a block's tags as a space, inline ones as nothing. */
const words = (html: string): string => html.replace(/<\/?(p|div|li|label|fieldset|legend)\b[^>]*>/g, " ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").replace(/ ([.,;])/g, "$1").trim();

/* The fixture: the mockup's list, in the app's own data. */
const LIST = {
  repos: ["/x"],
  provider: { ...CLAUDE, accounts: [{ label: "work" }, { label: "home", configDir: "~/.claude-home" }] },
  fallbacks: [
    { label: "codex", ...CODEX },
    { label: "backup", api: { kind: "anthropic", model: "claude-sonnet-4-5", apiKeyCommand: ["/usr/bin/security", "find-generic-password"] } },
    { label: "local", api: { kind: "openai-compatible", model: "llama3.1", baseUrl: "http://127.0.0.1:11434/v1" } },
    { label: "remote", api: { kind: "openai-compatible", model: "m", baseUrl: "https://user:pw@models.example.com/v1?x=1", apiKeyEnv: "K" } },
  ],
};
const LIST_TEXT = text(LIST);
const ROWS: StatusProviderRow[] = [
  statusRow(0, "work", "cli", { kind: "out-of-usage", until: iso(12, 0) }),
  statusRow(1, "home", "cli", { kind: "not-tested" }),
  statusRow(2, "codex", "cli", { kind: "key-accepted", at: iso(7, 5) }),
  statusRow(3, "backup", "anthropic", { kind: "working", at: iso(7, 24) }),
  statusRow(4, "local", "openai-compatible", { kind: "paused", until: iso(15, 0), reason: "unreachable" }),
  statusRow(5, "remote", "openai-compatible", { kind: "not-working", since: iso(6, 0, 17), reason: "auth" }),
];
const VALIDATE = [3].map((index) => ({ index, testTimeoutMs: 1, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true as const }));
const fullView = (over: Partial<Parameters<typeof providersView>[0]> = {}): Readable =>
  view({ draft: parse(LIST_TEXT), savedText: LIST_TEXT, rows: ROWS, validateRows: VALIDATE, now: NOW, os: "macos", ...over });

/* ══ AI providers: the decisions ══════════════════════════════════════════════════════════════════════════════════ */

describe("P-A: each row's plain-words line (providerSubline), from the row's own block", () => {
  test("by kind: Claude by its credential, Codex, another command, Anthropic with its key's home, a named local service, a host — never the address or a key reference", () => {
    const v = fullView();
    expect(v.rows.map((r) => [r.label, (r as unknown as Record<string, unknown>)["subline"]])).toEqual([
      ["work", "Claude Code · your subscription login"],
      ["home", "Claude Code · your subscription login"],
      // Round 9 (L7): how Codex signs in is Codex's own.
      ["codex", "Codex · command-line tool"],
      ["backup", "Anthropic API · claude-sonnet-4-5 · key in your Keychain"],
      ["local", "Ollama on this Mac · llama3.1"],
      ["remote", "OpenAI-compatible · m · models.example.com · key from an environment variable"],
    ]);
    // Never the address's user name, password, path or query; never a key reference.
    for (const r of v.rows) expect({ r: r.label, leak: /pw|user:|\?x=|security|find-generic/.test(String((r as unknown as Record<string, unknown>)["subline"])) }).toEqual({ r: r.label, leak: false });
  });

  test("the rest of the cases, one by one", () => {
    const sub = fn<(e: { label: string; block: Record<string, unknown>; configDir?: string }, os?: string, appOwned?: boolean, keyMoved?: boolean) => string>(sm, "providerSubline");
    const e = (block: Record<string, unknown>) => ({ label: "x", block });
    expect(sub(e({ ...CLAUDE, credential: "env-api-key" }), "macos")).toBe("Claude Code · its API key from your environment");
    expect(sub(e({ cli: "/opt/homebrew/bin/claude", argv: ["-p", "--x"], promptVia: "stdin" }), "macos")).toBe("Claude Code · your subscription login");
    expect(sub(e({ cli: "C:\\Tools\\codex.exe", argv: [], promptVia: "stdin" }), "windows")).toBe("Codex · command-line tool");
    expect(sub(e({ cli: "my-llm\u0007", argv: [], promptVia: "arg" }), "linux")).toBe("my-llm · command-line tool");
    expect(sub(e({ cli: "", argv: [], promptVia: "stdin" }), "macos")).toBe("Command-line tool");
    expect(sub(e({ api: { kind: "anthropic", model: "m" } }), "macos")).toBe("Anthropic API · m · no key");
    expect(sub(e({ api: { kind: "anthropic", model: "m", baseUrl: "https://gw.example.com", apiKey: "sk-x" } }), "macos")).toBe("Anthropic API · m · gw.example.com · key written in the settings file");
    expect(sub(e({ api: { kind: "anthropic", model: "m", apiKeyCommand: ["op"] } }), "macos")).toBe("Anthropic API · m · key from a command");
    expect(sub(e({ api: { kind: "anthropic", model: "m", apiKeyFile: "/k" } }), "linux", true)).toBe("Anthropic API · m · key in the app's key folder");
    expect(sub(e({ api: { kind: "anthropic", model: "m", apiKeyFile: "/k" } }), "linux")).toBe("Anthropic API · m · key from a file");
    expect(sub(e({ api: { kind: "anthropic", model: "m", apiKeyEnv: "X" } }), "macos", false, true)).toBe("Anthropic API · m · needs a key");
    expect(sub(e({ api: { kind: "openai-compatible", model: "gpt", baseUrl: "https://api.openai.com/v1", apiKeyCommand: ["k"] } }), "macos", true)).toBe("OpenAI · gpt · key in your Keychain");
    expect(sub(e({ api: { kind: "openai-compatible", model: "q", baseUrl: "http://127.0.0.1:1234/v1" } }), "linux")).toBe("LM Studio on this computer · q");
    expect(sub(e({ api: { kind: "openai-compatible", model: "q", baseUrl: "http://localhost:8000/v1" } }), "macos")).toBe("OpenAI-compatible · q · on this Mac");
    expect(sub(e({ api: { kind: "openai-compatible", model: "q", baseUrl: "not a url" } }), "macos")).toBe("OpenAI-compatible · q");
  });
});

describe("P-A: the opened row's status sentence (statusSentence) — only what the engine's row status says", () => {
  test("every status kind, and the next provider named only where one follows", () => {
    // Round 11 (L1): the fifth argument says whether the row is the FIRST provider; only the first one's mark hands the
    // briefing to the next provider — a backup's is skipped while an earlier one works.
    const say = (s: RowStatusView, now: Date, isCli: boolean, isLast: boolean, isFirst = true) =>
      fn<(s: RowStatusView, now: Date, isCli: boolean, isLast: boolean, isFirst: boolean) => { lead: string; rest: string | null }>(sm, "statusSentence")(s, now, isCli, isLast, isFirst);
    expect(say({ kind: "out-of-usage", until: iso(12, 0) }, NOW, true, false)).toEqual({ lead: "Out of usage until 12:00.", rest: "Until then your briefing is written by the next provider." });
    expect(say({ kind: "out-of-usage", until: iso(12, 0) }, NOW, true, true)).toEqual({ lead: "Out of usage until 12:00.", rest: null });
    expect(say({ kind: "paused", until: iso(15, 0), reason: "unreachable" }, NOW, false, false)).toEqual({ lead: "Paused until 15:00 after it could not be reached.", rest: "Until then the next provider is tried first." });
    for (const last of [false, true]) {
      expect(say({ kind: "out-of-usage", until: iso(12, 0) }, NOW, true, last, false)).toEqual({ lead: "Out of usage until 12:00.", rest: "It is skipped until then." });
      expect(say({ kind: "paused", until: iso(15, 0), reason: "unreachable" }, NOW, false, last, false)).toEqual({ lead: "Paused until 15:00 after it could not be reached.", rest: "It is skipped until then." });
    }
    expect(say({ kind: "not-working", since: iso(6, 0, 17), reason: "auth" }, NOW, false, true)).toEqual({ lead: "Not working since Sat 06:00: key or login rejected.", rest: null });
    expect(say({ kind: "working", at: iso(7, 24) }, NOW, false, true)).toEqual({ lead: "Working: wrote a briefing at 07:24.", rest: null });
    expect(say({ kind: "working", at: iso(7, 24, 16) }, NOW, false, true)).toEqual({ lead: "Working: wrote a briefing on Fri at 07:24.", rest: null });
    expect(say({ kind: "working", at: iso(7, 24, 1) }, NOW, false, true)).toEqual({ lead: "Working: wrote a briefing on 1 Oct.", rest: null });
    expect(say({ kind: "key-accepted", at: iso(7, 5) }, NOW, false, true)).toEqual({ lead: "Key accepted at 07:05.", rest: null });
    expect(say({ kind: "key-accepted", at: iso(7, 5) }, NOW, true, true)).toEqual({ lead: "Test passed at 07:05.", rest: null });
    expect(say({ kind: "not-tested" }, NOW, true, true)).toEqual({ lead: "Not tested yet.", rest: null });
    expect(say({ kind: "invalid", reason: "bad\u0007" }, NOW, true, true)).toEqual({ lead: "Invalid: bad.", rest: null });
  });

  test("on the row: the sentence, the remedy it still needs, and the mark that offers Try again now", () => {
    const v = fullView();
    const s = (l: string) => row(v, l)["sentence"];
    expect(s("work")).toEqual({ lead: "Out of usage until 12:00.", rest: "Until then your briefing is written by the next provider.", remedy: null });
    // Round 11 (L1): "local" is a backup — while the first provider works, its pause changes nothing for the briefing.
    expect(s("local")).toEqual({ lead: "Paused until 15:00 after it could not be reached.", rest: "It is skipped until then.", remedy: "Check the network and the address, then press Test. Try again now ends the pause." });
    expect(s("remote")).toEqual({ lead: "Not working since Sat 06:00: key or login rejected.", rest: null, remedy: "Check this provider's key or login, then press Test." });
    expect(v.rows.map((r) => [r.label, (r as unknown as Record<string, unknown>)["marked"]])).toEqual([
      ["work", true], ["home", false], ["codex", false], ["backup", false], ["local", true], ["remote", false],
    ]);
    // The compact tag: the status's own words, except an invalid entry's "invalid" (its reason is the sentence).
    expect(v.rows.map((r) => (r as unknown as Record<string, unknown>)["tag"])).toEqual(["out of usage until 12:00", "not tested", "key accepted", "working", "paused until 15:00 after unreachable", "not working since Sat 06:00: key or login rejected"]);
    const bad = fullView({ rows: ROWS.map((r, i) => (i === 2 ? { index: 2, label: "codex", kind: "invalid", status: { kind: "invalid" as const, reason: "a long reason" } } : r)) });
    expect([row(bad, "codex")["tag"], row(bad, "codex")["sentence"]]).toEqual(["invalid", { lead: "Invalid: a long reason.", rest: null, remedy: "The briefing skips it. Fix it with Edit settings as JSON on Settings → Advanced, or remove it." }]);
    // The rows the engine has not answered for say so, in a sentence.
    const unsaved = view({ draft: parse(LIST_TEXT), savedText: text({ ...LIST, fallbacks: [] }), rows: null, now: NOW });
    expect(row(unsaved, "codex")["sentence"]).toEqual({ lead: "Not saved yet.", rest: null, remedy: "Save to start using it." });
    expect(row(view({ draft: parse(LIST_TEXT), savedText: null, rows: null, now: NOW }), "codex")["sentence"]).toEqual({ lead: "Its status is not known yet.", rest: null, remedy: null });
  });

  test("Reset is \"Try again now\": its result lines say what it did (clears the marks; the next run tries it)", () => {
    expect(sm["TRY_AGAIN_LABEL"]).toBe("Try again now");
    const o = (payload: unknown) => ({ operation: "provider-reset", outcome: { kind: "delivered" }, exitCode: 0, payload, stdout: "", stderr: "" }) as never;
    expect(settingsModel.resetResultLine(o({ schemaVersion: 1, ok: true, cleared: true }))).toBe("Its pauses were cleared: the next run tries it again.");
    expect(settingsModel.resetResultLine(o({ schemaVersion: 1, ok: true, cleared: false }))).toBe("There was nothing to clear: the next run tries it as usual.");
    expect(settingsModel.resetResultLine(o(null))).toBe("Not cleared: the engine did not answer (it stopped before replying).");
    expect(settingsModel.resetResultLine(o({ schemaVersion: 1, ok: false, code: "lock-held", error: "x" }))).toBe("Not cleared: a briefing is running — try again in a minute.");
  });
});

describe("P-A: what a row says about settings it does not edit (facts)", () => {
  test("row 1 edits its own; its other logins share them; a backup tool's are read-only lines; an API backup's are its line", () => {
    const v = fullView();
    expect(v.rows.map((r) => [r.label, (r as unknown as Record<string, unknown>)["facts"]])).toEqual([
      ["work", []],
      ["home", ["Tool and Account are shared with work."]],
      ["codex", ["Tool: Codex (codex)", "Account: The tool's own sign-in"]],
      ["backup", []],
      ["local", []],
      ["remote", []],
    ]);
    const other = view({ draft: parse(text({ provider: CLAUDE, fallbacks: [{ label: "x", cli: "my-llm", argv: [], promptVia: "stdin", credential: "env-api-key" }] })), savedText: null, rows: null, now: NOW });
    expect(row(other, "x")["facts"]).toEqual(["Tool: my-llm", "Account: The API key in my environment"]);
    expect(sm["BACKUP_SETTINGS_NOTE"]).toBe("Only the first provider's settings are changed here. To change another's tool, account, model or address, move it to the top of the list, or use Edit settings as JSON on Settings → Advanced.");
  });
});

describe("P-A: Test all — each row's own Test, one after another", () => {
  test("its label, and when it waits", () => {
    const t = (over: Partial<Parameters<typeof providersView>[0]> = {}) => (fullView(over) as unknown as Record<string, unknown>)["testAll"];
    expect(t()).toEqual({ text: "Test all — uses a little of your plan", enabled: true, why: null });
    expect(t({ testing: "work" })).toEqual({ text: "Test all — uses a little of your plan", enabled: false, why: "Wait for the test or step in progress to finish." });
    expect(t({ testingAll: true })).toEqual({ text: "Testing all…", enabled: false, why: "Wait for the test or step in progress to finish." });
    expect(t({ resetting: "work" })).toMatchObject({ enabled: false });
    // While Test all runs, every row's Test waits too (one row op at a time, as Test is).
    expect(fullView({ testingAll: true }).rows.every((r) => !r.test.enabled)).toBe(true);
    const apiOnly = text({ provider: { api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } } });
    expect((view({ draft: parse(apiOnly), savedText: apiOnly, rows: null, now: NOW }) as unknown as Record<string, unknown>)["testAll"]).toEqual({ text: "Test all", enabled: true, why: null });
    const literal = text({ provider: { api: { kind: "anthropic", model: "m", apiKey: "sk" } } });
    expect((view({ draft: parse(literal), savedText: literal, rows: null, now: NOW }) as unknown as Record<string, unknown>)["testAll"]).toEqual({ text: "Test all", enabled: false, why: "No provider can be tested now: each row says why." });
  });

  // Round 9 (H1): the source pin that stood here held the old loop verbatim — the loop that tested nothing, as the hold
  // it set disabled every row's Test before it read them. Behaviour now, in settings-r9.check.ts; the shell's wiring:
  test("wired: Settings hands its run to testAllInTurn, with the view, the hold and each row's own Test", () => {
    const shell = src("routes/Settings.svelte").replace(/\s+/g, " ");
    expect(shell).toContain("async function onprovidertestall(): Promise<void> { if (providers === undefined || providerTestingAll) return; await testAllInTurn( providers, () => providers, (on) => (providerTestingAll = on), (label, draftIndex) => onprovidertest(label, draftIndex, true), ); }");
    expect(shell).toContain("testingAll: providerTestingAll,");
  });
});

describe("P-A: today's briefing, from today's page's own lines", () => {
  const page = (date: string, notices: string[]) => [...notices.map((n) => NOTICE_PREFIX + n), `☀️  Daily briefing — ${date}`, "", "▶ Recap", "   • x"].join("\n");
  const today = localDate(NOW);
  const line = fn<(t: string | null, m: string | null, now: Date) => unknown>(sm, "todaysBriefing");

  test("a skipped provider and the one used, with the page's write time; a not-tried one; none is no line", () => {
    expect(line(page(today, ['Skipped "work": out of usage until 12:00 — used "backup"']), iso(7, 24), NOW)).toEqual({ skipped: [{ name: "work", why: "out of usage until 12:00" }], used: "backup", at: "07:24" });
    expect(line(page(today, ['Not tried "work": out of usage until 12:00']), iso(7, 24), NOW)).toEqual({ skipped: [{ name: "work", why: "not tried (out of usage until 12:00)" }], used: null, at: "07:24" });
    expect(line(page(today, ['Not tried "a": paused until 15:00 after unreachable', 'Skipped "b": key or login rejected — used "c"', "this run used about 3k tokens"]), null, NOW)).toEqual({
      skipped: [{ name: "a", why: "not tried (paused until 15:00 after unreachable)" }, { name: "b", why: "key or login rejected" }],
      used: "c",
      at: null,
    });
    // Nobody skipped: no line names the winner (the page's `provider` is the command or model, not the entry).
    expect(line(page(today, []), iso(7, 24), NOW)).toBeNull();
    // Not today's page, or no page: nothing.
    expect(line(page("2026-10-17", ['Skipped "work": out of usage — used "backup"']), iso(7, 24, 17), NOW)).toBeNull();
    expect(line(null, null, NOW)).toBeNull();
    // A write time from another day is not "at".
    expect((line(page(today, ['Skipped "w": x — used "b"']), iso(23, 0, 17), NOW) as { at: unknown }).at).toBeNull();
  });

  test("the engine writes exactly these lines (src/failover.ts noticeLines)", () => {
    const failover = readFileSync(new URL("../../src/failover.ts", import.meta.url), "utf8");
    expect(failover).toContain('out.push(`${NOTICE_PREFIX}Skipped "${safeLabel(a.label)}": ${failedWording(a, now)} — used "${safeLabel(winner)}"`);');
    expect(failover).toContain('if (a.reason === "usage") return `Not tried "${safeLabel(a.label)}": out of usage until ${until}`;');
  });

  test("on the view, from the latest page and its mtime; Settings reads both", () => {
    const v = fullView({ latestPage: page(today, ['Skipped "work": out of usage — used "backup"']), latestMtime: iso(7, 24) }) as unknown as Record<string, unknown>;
    expect(v["today"]).toEqual({ skipped: [{ name: "work", why: "out of usage" }], used: "backup", at: "07:24" });
    expect((fullView() as unknown as Record<string, unknown>)["today"]).toBeNull();
    const shell = src("routes/Settings.svelte").replace(/\s+/g, " ");
    expect(shell).toContain("latestPage: latestPage,");
    expect(shell).toContain("latestMtime: latestMtime,");
    expect(shell).toContain("const file = await readLatestBriefing();");
  });
});

describe("P-A: the first provider's command cannot change to another tool while its logins have folders (handover's open bug)", () => {
  const draft = () => parse(LIST_TEXT);
  const toolField = SECTIONS.flatMap((s) => s.fields).find((f) => f.id === "provider.cli")!;
  const commandField = fn<Record<string, unknown>>(sm, "TOOL_COMMAND_FIELD") as never;

  // Measured with the engine's own functions (`config validate` builds its report from these; `src/json.ts` itself is
  // not imported here — it reaches the scheduler installer, coexistence.check.ts's pin; the full report was measured
  // in build-d9/probe-folder/probe.ts: valid, no errors, one advisory "never logged in" warning, rows 0 and 1).
  test("measured: the engine accepts such a list — no error, no structural accounts warning — and runs Codex once per login, the folder as CLAUDE_CONFIG_DIR", () => {
    const codex = { repos: ["/x"], provider: { ...LIST.provider, ...CODEX } };
    const cfg = validateConfig(structuredClone(codex), "/nonexistent-home");
    const list = resolveProviderList(cfg, "/nonexistent-home", {}, () => true);
    expect(list.accountsBroken).toBe(false);
    expect(list.dropped).toEqual([]);
    expect(list.warnings.filter((w) => w.endsWith("— account failover disabled"))).toEqual([]);
    expect(list.entries.map((e) => [e.label, e.provider.cli, e.configDir ?? null])).toEqual([["work", "codex", null], ["home", "codex", "/nonexistent-home/.claude-home"]]);
  });

  test("refused, with the reason, from the Tool choice and from Other's command; a Claude path or a list without folders is not", () => {
    const d = draft();
    const why = 'Not changed: "home" has a login folder, which only Claude Code reads. Remove those logins, or clear their login folders, first.';
    expect(writeField(d, toolField, "codex")).toBe(why);
    expect(writeField(d, commandField, "codex")).toBe(why);
    expect((d["provider"] as Record<string, unknown>)["cli"]).toBe("claude");
    expect(writeField(d, commandField, "/opt/homebrew/bin/claude")).toBeNull();
    const plainList = parse(text({ ...LIST, provider: CLAUDE }));
    expect(writeField(plainList, toolField, "codex")).toBeNull();
    expect((plainList["provider"] as Record<string, unknown>)["cli"]).toBe("codex");
  });
});

/* ══ the guided Add ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe("P-Add: the guided Add's choices make today's add forms", () => {
  const docs = readFileSync(new URL("../../docs/PROVIDERS.md", import.meta.url), "utf8");
  type Inputs = Record<string, string>;
  const form = fn<(c: string, v: Inputs) => unknown>(fm, "guidedForm");
  const takesKey = fn<(c: string, s: string) => boolean>(fm, "guidedTakesKey");
  const typed = (over: Inputs = {}): Inputs => ({ label: "n", tool: "codex", command: "c", args: "a", service: "openai", model: "m", address: "https://h/v1", configDir: "~/.d", ...over });

  test("every preset address is docs/PROVIDERS.md's own", () => {
    const services = sm["API_SERVICES"] as { id: string; baseUrl: string | null; kind: string; keyless: boolean }[];
    expect(services.map((s) => [s.id, s.kind, s.baseUrl, s.keyless])).toEqual([
      ["anthropic", "anthropic", null, false],
      ["openai", "openai-compatible", "https://api.openai.com/v1", false],
      ["ollama", "openai-compatible", "http://127.0.0.1:11434/v1", true],
      ["lmstudio", "openai-compatible", "http://127.0.0.1:1234/v1", true],
      ["other", "openai-compatible", null, false],
    ]);
    for (const s of services.filter((x) => x.baseUrl !== null)) expect({ id: s.id, inDocs: docs.includes(`"baseUrl": "${s.baseUrl}"`) }).toEqual({ id: s.id, inDocs: true });
    const label = fn<(s: unknown, os?: string) => string>(sm, "serviceLabel");
    expect(services.map((s) => label(s, "macos"))).toEqual(["Anthropic", "OpenAI", "Ollama on this Mac", "LM Studio on this Mac", "Other OpenAI-compatible service"]);
    expect(label(services[2], "linux")).toBe("Ollama on this computer");
  });

  test("each choice reads only its own inputs; each service fills in its address", () => {
    expect(form("subscription", typed())).toEqual({ kind: "cli", label: "n", model: "", baseUrl: "", configDir: "", tool: "codex", command: "c", args: "a" });
    expect(form("login", typed())).toEqual({ kind: "login", label: "n", model: "", baseUrl: "", configDir: "~/.d" });
    expect(form("api", typed({ service: "anthropic" }))).toEqual({ kind: "anthropic", label: "n", model: "m", baseUrl: "", configDir: "" });
    expect(form("api", typed({ service: "openai" }))).toEqual({ kind: "openai-compatible", label: "n", model: "m", baseUrl: "https://api.openai.com/v1", configDir: "" });
    expect(form("api", typed({ service: "ollama" }))).toMatchObject({ kind: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" });
    expect(form("api", typed({ service: "lmstudio" }))).toMatchObject({ kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1" });
    expect(form("api", typed({ service: "other" }))).toMatchObject({ kind: "openai-compatible", baseUrl: "https://h/v1" });
    expect(["anthropic", "openai", "ollama", "lmstudio", "other"].map((s) => takesKey("api", s))).toEqual([true, true, false, false, true]);
    expect(takesKey("subscription", "openai")).toBe(false);
    expect(takesKey("login", "openai")).toBe(false);
  });

  test("the forms are today's, through today's request builder (no new add path)", () => {
    const d = parse(text({ provider: CLAUDE }));
    expect(flows.addRequestFrom(d, form("api", typed({ service: "ollama", model: "llama3.1" })) as never)).toEqual({ label: "n", block: { api: { kind: "openai-compatible", model: "llama3.1", baseUrl: "http://127.0.0.1:11434/v1" } } });
    expect(flows.addRequestFrom(d, form("subscription", typed()) as never)).toEqual({ label: "n", block: CODEX });
    expect(flows.addRequestFrom(d, form("login", typed()) as never)).toEqual({ label: "n", block: CLAUDE, configDir: "~/.d" });
  });
});

/* ══ Calendar: the decisions ══════════════════════════════════════════════════════════════════════════════════════ */

describe("Calendar: the master box, the Connections label and help", () => {
  test("by value", () => {
    expect([cm["MASTER_TITLE"], cm["MASTER_LINE"]]).toEqual(["Show today's calendar in your briefing", "The AI then fits its suggestions around your meetings."]);
    const label = fn<(on: boolean) => unknown>(cm, "connectionsLabel");
    expect([label(true), label(false)]).toEqual([{ text: "Enabled", tone: "on" }, { text: "Disabled", tone: "off" }]);
    const help = fn<(on: boolean, mac: boolean) => unknown>(cm, "connectionsHelp");
    expect(help(true, true)).toEqual({ text: "Your Mac's Calendar app, and private calendar links from Google, Outlook, iCloud or another calendar.", off: false });
    expect(help(true, false)).toEqual({ text: "Private calendar links from Google, Outlook, iCloud or another calendar.", off: false });
    expect(help(false, true)).toEqual({ text: "The calendar is off, so these aren't read. Turn it on above.", off: true });
    expect(help(false, false)).toEqual(help(false, true));
  });
});

describe("Calendar C-A: each row's line, inline tag and in-row action", () => {
  const cal = (id: string, selected: boolean) => ({ id, title: id, account: "iCloud", editable: true, type: "standard" as const, selected });
  const granted = { status: "ok" as const, calendars: [cal("a", true), cal("b", true), cal("c", false)] };
  const macRow = fn<(macOn: boolean, mac: unknown, calOn: boolean, tag: unknown) => unknown>(cm, "macRow");
  const macAction = fn<(macOn: boolean, mac: unknown, calOn: boolean) => unknown>(cm, "macRowAction");
  const linkAction = fn<(l: CalendarLinkInfo, seen: unknown, calOn: boolean) => unknown>(cm, "linkRowAction");
  const linkLine = fn<(l: CalendarLinkInfo) => string>(cm, "linkRowLine");

  test("the Mac row: what it reads, its tag without the count, and its action (today's two labels)", () => {
    expect(macRow(true, granted, true, { text: "allowed · 2 calendars", tone: "ok" })).toEqual({ line: "Reads 2 calendars on this Mac", tag: { text: "allowed", tone: "ok" } });
    expect(macRow(true, { ...granted, calendars: [cal("a", true)] }, true, { text: "allowed · 1 calendar", tone: "ok" })).toEqual({ line: "Reads 1 calendar on this Mac", tag: { text: "allowed", tone: "ok" } });
    // Round 9 (L13): the Mac switch on and the calendar off: its "off" says it is the calendar's.
    expect(macRow(true, granted, false, { text: "off", tone: "muted" })).toEqual({ line: "2 calendars chosen on this Mac", tag: { text: "off (calendar off)", tone: "muted" } });
    expect(macRow(false, granted, true, { text: "off", tone: "muted" })).toEqual({ line: "Every account you added on this Mac", tag: { text: "off", tone: "muted" } });
    expect(macRow(true, { status: "not-granted", calendars: [] }, true, { text: "needs access", tone: "warn" })).toEqual({ line: "Every account you added on this Mac", tag: { text: "needs access", tone: "warn" } });
    expect(macRow(true, null, true, null)).toEqual({ line: "Every account you added on this Mac", tag: null });
    expect(macAction(true, { status: "not-granted", calendars: [] }, true)).toEqual({ label: "Allow access", target: "allow" });
    expect(macAction(true, { status: "helper-missing", calendars: [] }, true)).toEqual({ label: "Allow access", target: "allow" });
    expect(macAction(true, { ...granted, notices: ["helper-outdated"] }, true)).toEqual({ label: "Update the calendar reader", target: "update" });
    // No action that today's details do not draw (System Settings answers), none while off, none for a fine source.
    for (const s of ["write-only", "denied", "restricted", "timeout"]) expect({ s, a: macAction(true, { status: s, calendars: [] }, true) }).toEqual({ s, a: null });
    expect(macAction(true, { status: "not-granted", calendars: [] }, false)).toBeNull();
    expect(macAction(false, { status: "not-granted", calendars: [] }, true)).toBeNull();
    expect(macAction(true, granted, true)).toBeNull();
  });

  test("a link row: Google only from stored data, never the name; its action follows today's prompts", () => {
    const base: CalendarLinkInfo = { id: "team", name: "Team (Google)", confirmedOwner: null, urlFrom: "file", fileStatus: "ok", configuredOwner: "me@x.example" };
    expect(linkLine(base)).toBe("Calendar link");
    expect(linkLine({ ...base, urlPathOwner: "me@example.com" })).toBe("Google calendar link");
    const seen = (over: Record<string, unknown> = {}) => ({ read: { at: iso(7, 21), status: "ok" }, test: undefined, notices: [], declined: false, ...over });
    expect(linkAction({ ...base, configuredOwner: undefined, urlPathOwner: "a@b.example" }, seen(), true)).toEqual({ label: "Check the address", target: "confirm" });
    expect(linkAction({ ...base, configuredOwner: undefined, urlPathOwner: "a@b.example" }, seen({ declined: true }), true)).toEqual({ label: "Add your email", target: "owner" });
    expect(linkAction({ ...base, configuredOwner: undefined, urlFrom: "env" }, seen(), true)).toEqual({ label: "Add your email", target: "owner" });
    expect(linkAction(base, seen({ notices: ["identity-unknown"] }), true)).toEqual({ label: "Add your email", target: "owner" });
    expect(linkAction(base, seen(), true)).toBeNull();
    // A problem outranks the owner questions (the row says "couldn't read"); off, nothing.
    expect(linkAction({ ...base, configuredOwner: undefined, urlFrom: "env" }, seen({ read: { at: iso(7, 21), status: "timeout" } }), true)).toBeNull();
    expect(linkAction({ ...base, configuredOwner: undefined, fileStatus: "missing" }, seen(), true)).toBeNull();
    expect(linkAction({ ...base, configuredOwner: undefined, urlFrom: "env" }, seen(), false)).toBeNull();
  });

  test("Add a connection…: the Mac Calendar app only where it is shown and not on yet", () => {
    const choices = fn<(show: boolean, on: boolean) => string[]>(cm, "connectionChoices");
    expect([choices(true, false), choices(true, true), choices(false, false)]).toEqual([["mac", "link"], ["link"], ["link"]]);
  });
});

/* ══ the drawing and the wiring ═══════════════════════════════════════════════════════════════════════════════════ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const list = (props: Record<string, unknown>): string => flat(render(ProvidersList as any, { props }).body);
const noop = (): void => {};
/** A row's `<li>`, found by its head's `aria-controls`. */
const liOf = (html: string, i: number): string => {
  const at = html.indexOf(`aria-controls="prov-row-${i}"`);
  return html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at) + 5);
};
const headOf = (li: string): string => li.slice(li.indexOf('<button type="button" class="head'), li.indexOf("</button>", li.indexOf('class="head')) + 9);

describe("P-A drawn: compact rows that open in place", () => {
  const props = { view: fullView(), onmove: noop, onremove: noop, ontest: noop, onreset: noop, onfolder: noop, ontestall: noop };

  test("each row: the grip, its number, then a header button — chevron, name in bold, · what it is, the status tag — controlling its details; rows start closed", () => {
    const b = list(props);
    for (const [i, r] of fullView().rows.entries()) {
      // Round 9 (L3): a row whose status is bad (here "remote", not working) opens by itself; every other starts closed.
      const open = r.status.tone === "bad";
      const li = liOf(b, i);
      // Round 10 (M5): the grip, not the row, is draggable.
      expect(li).toMatch(new RegExp(`^<li class="row[^"]*">\\s*<div class="line[^"]*">\\s*<span class="grip[^"]*" aria-hidden="true" draggable="true">⋮⋮</span>\\s*<span class="position[^"]*" aria-hidden="true">${i + 1}</span>\\s*<button type="button" class="head ctl[^"]*" aria-expanded="${open}" aria-controls="prov-row-${i}">`));
      const head = headOf(li);
      expect(head).toMatch(/<svg class="chev[^"]*" viewBox="0 0 16 16" aria-hidden="true"/);
      expect(head).toContain(`<span class="label`);
      expect(words(head)).toBe(`${r.display} · ${(r as unknown as Record<string, string>)["subline"]} ● ${(r as unknown as Record<string, string>)["tag"]}`);
      expect(head).toMatch(new RegExp(`<span class="status tone-${r.status.tone}[^"]*"><span[^>]*aria-hidden="true"[^>]*>●</span> `));
      expect(li).toMatch(new RegExp(`<div class="details[^"]*" id="prov-row-${i}"${open ? "" : ' hidden=""'}>`));
    }
    expect(fullView().rows.filter((r) => r.status.tone === "bad").map((r) => r.label)).toEqual(["remote"]);
  });

  test("an opened row, in order: the sentence (bold lead) with Try again now on a marked row, its remedy, row 1's own settings, the login folder, then the buttons", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fields = ((): unknown => undefined) as any;
    const b = list({ ...props, openRows: ["work", "local", "codex", "home"], firstFields: fields });
    const work = liOf(b, 0);
    expect(headOf(work)).toMatch(/aria-expanded="true"/);
    expect(work).toMatch(/id="prov-row-0">/);
    const d = work.slice(work.indexOf('id="prov-row-0"'));
    const order = ["<strong>Out of usage until 12:00.</strong> Until then your briefing is written by the next provider.", ">Try again now</button>", "Login folder (Claude logins only", ">Test — uses a little of your plan</button>", ">Move down</button>", ">Remove</button>"].map((s) => d.indexOf(s));
    expect(order.every((x, n) => x > -1 && (n === 0 || x > order[n - 1]!))).toBe(true);
    expect(d).not.toContain(">Move up</button>");
    // A paused row: its remedy says what Try again now does.
    const local = liOf(b, 4);
    expect(local).toContain("Check the network and the address, then press Test. Try again now ends the pause.");
    expect(local).toContain(">Try again now</button>");
    expect(local).toContain(">Move up</button>");
    // An unmarked row: no Try again now; a backup tool's settings as read-only lines; a login's shared ones.
    expect(liOf(b, 2)).not.toContain("Try again now");
    expect(liOf(b, 2)).toContain('<p class="fact');
    expect(words(liOf(b, 2))).toContain("Tool: Codex (codex) Account: The tool's own sign-in");
    expect(words(liOf(b, 1))).toContain("Tool and Account are shared with work.");
    // The last row: no Move down.
    expect(liOf(b, 5)).not.toContain(">Move down</button>");
  });

  test("source pins: the open rows are the user's, kept by label; a click flips its own row; a row never closes by itself; focus stays on the head", () => {
    const pl = src("lib/ProvidersList.svelte");
    expect(pl).toContain("rows = withRowOpen(rows, label, !isOpen(label));");
    expect(pl).toContain("const isOpen = (label: string): boolean => isSet(rows.open, label);");
    expect(pl).toMatch(/\$effect\(\(\) => \{\n\s*const now = needs;\n\s*untrack\(\(\) => \(rows = nextOpenRows\(rows, now\)\)\);\n\s*\}\);/);
    expect(pl.replace(/\s+/g, " ")).toContain(
      "out[r.label] = (i === 0 && firstNeedsOpen) || replacing?.label === r.label || replaceFor === r.label || confirmFor === r.label || r.banner !== null || r.notes.some(failedTest) || r.status.tone === \"bad\";",
    );
    expect(pl).toContain('const failedTest = (line: string): boolean => line.startsWith(TEST_FAILED_PREFIX) || line.startsWith("Not tested");');
  });

  test("a row opens by itself when it needs the user: a key written in the settings file, a failed Test; never otherwise — and never takes the focus", () => {
    const pl = src("lib/ProvidersList.svelte");
    const lit = text({ repos: ["/x"], provider: CLAUDE, fallbacks: [{ label: "Lit", api: { kind: "anthropic", model: "m", apiKey: "(a literal API key is stored in config.json; Daily Briefing never displays it)" } }, { label: "B", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }] });
    const v = view({ draft: parse(lit), savedText: lit, rows: null, now: NOW, os: "macos", results: { B: ["Test failed: key or login rejected.", "Check this provider's key or login, then press Test."] } });
    const b = list({ view: v, ontest: noop });
    expect([0, 1, 2].map((i) => /aria-expanded="(\w+)"/.exec(headOf(liOf(b, i)))?.[1])).toEqual(["false", "true", "true"]);
    const passed = view({ draft: parse(lit), savedText: lit, rows: null, now: NOW, os: "macos", results: { B: ["Test passed."] } });
    expect(/aria-expanded="(\w+)"/.exec(headOf(liOf(list({ view: passed, ontest: noop }), 2)))?.[1]).toBe("false");
    // Round 9 (L8): the one focus move is "Add a provider…"'s, to the form it opened — never a row's opening by itself.
    // Round 10 (M4): and `focusAfter`'s, after the user's own Move, Try again now, refused Add or Close, and only when
    // the focus fell to the page; round 11 (L6): after the user's own Add was taken, once its panel draws a control.
    expect(pl).not.toMatch(/autofocus/);
    expect(pl.match(/\.focus\(/g)).toHaveLength(2);
    expect(pl).toMatch(/async function focusAfter\(targets: \(\) => \(HTMLElement \| null\)\[\]\): Promise<void> \{\s*await tick\(\);\s*const now = document\.activeElement;\s*if \(now !== null && now !== document\.body\) return;/);
    expect(pl.match(/focusAfter\(/g)).toHaveLength(6);
    expect(pl).toMatch(/else addFocusOwed = adding !== null;/);
    expect(pl).toMatch(/\$effect\(\(\) => \{\s*if \(adding === null \|\| adding\.busy\) return;\s*if \(!addFocusOwed\) return;\s*addFocusOwed = false;\s*void focusAfter\(\(\) => \[firstAddControl\(\)\]\);\s*\}\);/);
    expect(pl).toMatch(/async function openForm\(\): Promise<void> \{\s*formOpen = true;\s*await tick\(\);\s*document\.querySelector<HTMLElement>\('\.add\.guided input\[name="prov-add-choice"\]:checked'\)\?\.focus\(\);\s*\}/);
    // Rows are keyed by label, so an open row stays open across a reorder or a status refresh.
    expect(pl).toContain("{#each view.rows as row, i (row.label)}");
  });

  test("the Test all footer: its label, disabled with its reason while a row op runs, wired to the parent", () => {
    expect(list(props)).toMatch(/<div class="foot[^"]*">\s*<button type="button"(?![^>]*disabled)[^>]*>Test all — uses a little of your plan<\/button>/);
    const busy = list({ ...props, view: fullView({ testing: "work" }) });
    expect(busy).toMatch(/<button type="button"(?=[^>]* disabled="")(?=[^>]* title="Wait for the test or step in progress to finish\.")[^>]*>Test all — uses a little of your plan<\/button>/);
    expect(busy).toContain('<p class="why foot-why');
    expect(list({ ...props, ontestall: undefined })).not.toContain("Test all");
    const sf = src("routes/SettingsForm.svelte").replace(/\s+/g, " ");
    expect(sf).toContain("ontestall={onprovidertestall}");
  });

  test("row 1's own settings: the form's provider fields (Tool, Account), inside row 1's details; the provider boxes are gone; a field error opens row 1", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const form = (d: Draft, errors: Record<string, string> = {}) => flat(render(SettingsForm as any, { props: { draft: d, errors, onfield: noop, onnotifycommand: noop, ondefault: noop, onremovekey: noop, sections: ["Provider (command-line tool)", "Provider (API)"] } }).body);
    const b = form(parse(LIST_TEXT));
    const row1 = b.slice(b.indexOf('id="prov-row-0"'), b.indexOf('id="prov-row-1"'));
    expect(row1).toContain('<div class="rowfields');
    expect(row1).toMatch(/<label for="f-provider\.cli"[^>]*>Tool<\/label>/);
    expect(row1).toMatch(/<label for="f-provider\.credential"[^>]*>Account<\/label>/);
    expect(b.indexOf('id="f-provider.cli"')).toBe(b.lastIndexOf('id="f-provider.cli"'));
    expect(b).not.toMatch(/<legend[^>]*><h4[^>]*>Provider \(/);
    // Closed by default; a field error on row 1 opens it (so a refused Save's reveal can reach the field).
    expect(headOf(liOf(b, 0))).toMatch(/aria-expanded="false"/);
    const bad = form(parse(LIST_TEXT), { "provider.credential": "must be one of: subscription, env-api-key" });
    expect(headOf(liOf(bad, 0))).toMatch(/aria-expanded="true"/);
    expect(liOf(bad, 0)).toContain("must be one of: subscription, env-api-key");
    // An API row 1: its model, address, key file and key command are its own settings there.
    const api = form(parse(text({ repos: ["/x"], provider: { label: "Main", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } } })));
    const apiRow = liOf(api, 0);
    for (const id of ["provider.api.kind", "provider.api.model", "provider.api.baseUrl", "provider.api.apiKeyFile", "provider.api.apiKeyCommand"]) expect({ id, inRow1: apiRow.includes(`id="f-${id}"`) }).toEqual({ id, inRow1: true });
  });

  test("Today's briefing above the list: the skipped name struck through, the used one green, the words saying both", () => {
    const today = localDate(NOW);
    const latestPage = [`${NOTICE_PREFIX}Skipped "work": out of usage — used "backup"`, `☀️  Daily briefing — ${today}`, "", "▶ Recap", "   • x"].join("\n");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = flat(render(SettingsForm as any, { props: { draft: parse(LIST_TEXT), errors: {}, onfield: noop, onnotifycommand: noop, ondefault: noop, onremovekey: noop, sections: ["Provider (command-line tool)", "Provider (API)"], providers: fullView({ latestPage, latestMtime: iso(7, 24) }) } }).body);
    const p = b.slice(b.indexOf('<p class="today'), b.indexOf("</p>", b.indexOf('<p class="today')));
    expect(words(p)).toBe("Today's briefing: work out of usage, so backup wrote it at 07:24.");
    expect(p).toMatch(/<span class="chip skip[^"]*">work<\/span>/);
    expect(p).toMatch(/<span class="chip used[^"]*">backup<\/span>/);
    expect(b.indexOf('<p class="today')).toBeLessThan(b.indexOf("Providers, in order"));
    const css = src("routes/SettingsForm.svelte");
    expect(css).toMatch(/\.chip\.skip \{\s*color: var\(--muted\);\s*text-decoration: line-through;\s*\}/);
    expect(css).toMatch(/\.chip\.used \{\s*color: var\(--state-done\);\s*border-color: var\(--state-done\);\s*font-weight: 600;\s*\}/);
    // No page today: no line.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(flat(render(SettingsForm as any, { props: { draft: parse(LIST_TEXT), errors: {}, onfield: noop, onnotifycommand: noop, ondefault: noop, onremovekey: noop, sections: ["Provider (command-line tool)", "Provider (API)"], providers: fullView() } }).body)).not.toContain('class="today');
  });
});

describe("P-Add drawn: the guided Add", () => {
  const add = (over: Record<string, unknown> = {}) => list({ view: fullView(), onadd: () => true, addFormOpen: true, loginOf: "work", ...over });
  const optionsOf = (b: string, from: string): string[] => {
    const at = b.indexOf(from);
    return [...b.slice(at, b.indexOf("</select>", at)).matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]!.trim());
  };

  test("three radio cards, a title and one muted line each; the chosen one marked", () => {
    const b = add();
    const cards = [...b.matchAll(/<label class="card[^"]*">\s*<input type="radio" name="prov-add-choice" value="(\w+)"( checked="")?[^>]*\/>\s*<span class="card-words[^"]*"><span class="card-title[^"]*">([^<]*)<\/span><span class="card-line[^"]*">([^<]*)<\/span>/g)].map((m) => [m[1], m[2] !== undefined, m[3], m[4]]);
    expect(cards).toEqual([
      ["subscription", true, "A subscription you already have", "Claude Code, Codex, or another command-line tool you're logged into. No key needed."],
      // Round 10 (L5): a local model needs no key.
      ["api", false, "An API key", "Anthropic, OpenAI, or a local model (Ollama, LM Studio). Pay per use; the app keeps the key in your Keychain. A local model on this Mac needs no key."],
      ["login", false, "Another Claude account", "A second Claude login, used when the first runs out."],
    ]);
    expect(b).toMatch(/<label class="card[^"]* on">/);
    expect(b).not.toContain("Kind");
    // Off macOS the key's home is named as there.
    expect(add({ view: fullView({ os: "linux" }) })).toContain("the app keeps the key in your key folder.");
  });

  test("the subscription choice: Tool (and Other's command and arguments), then Name; Add and test says it uses the plan", () => {
    const b = add();
    expect(optionsOf(b, "Tool")).toEqual(["Claude Code (claude)", "Codex (codex)", "Other…"]);
    expect(b.indexOf("Tool")).toBeLessThan(b.indexOf("Name (it cannot be changed later)"));
    expect(b).toMatch(/<button type="button"[^>]*>Cancel<\/button>\s*<button type="button" class="primary[^"]*"[^>]*>Add and test — uses a little of your plan<\/button>/);
    expect(add({ addFormTool: "other" })).toContain("Command (its name if it is on your PATH, or its full path)");
  });

  test("the API choice: Service, the filled-in address as a muted line (the Address field for Other only), Model, the key (none for a local model), Name", () => {
    const anth = add({ addFormChoice: "api", addFormService: "anthropic" });
    expect(optionsOf(anth, "Service")).toEqual(["Anthropic", "OpenAI", "Ollama on this Mac", "LM Studio on this Mac", "Other OpenAI-compatible service"]);
    expect(anth).not.toContain("Address");
    expect(anth).toContain("API key (the app stores it for you, never in the settings file)");
    const oai = add({ addFormChoice: "api", addFormService: "openai" });
    expect(oai).toMatch(/<p class="note[^"]*">Address: https:\/\/api\.openai\.com\/v1 \(filled in for you\)<\/p>/);
    expect(oai).not.toContain("Address (for example");
    const ollama = add({ addFormChoice: "api", addFormService: "ollama" });
    expect(ollama).toContain("Address: http://127.0.0.1:11434/v1 (filled in for you)");
    expect(ollama).not.toContain('type="password"');
    expect(ollama).toContain("No key is needed for a model running on this Mac.");
    expect(add({ addFormChoice: "api", addFormService: "lmstudio" })).toContain("Address: http://127.0.0.1:1234/v1 (filled in for you)");
    const other = add({ addFormChoice: "api", addFormService: "other" });
    expect(other).toContain("Address (for example https://host/v1");
    expect(other).toContain('type="password"');
    expect(other).toContain("Leave the key empty for a model running on this computer");
    const order = ["Service", "Address (for example", "Model", "API key (", "Name ("].map((s) => other.indexOf(s));
    expect(order.every((x, n) => x > -1 && (n === 0 || x > order[n - 1]!))).toBe(true);
    expect(other).toMatch(/class="primary[^"]*">Add and test<\/button>/);
  });

  test("Another Claude account: the login folder, then Name — offered only with a Claude first tool, as today's login", () => {
    const b = add({ addFormChoice: "login" });
    expect(b).toContain("Login folder (the second account's own; it shares work's tool and account)");
    expect(b).toContain("Add and test — uses a little of your plan");
    // With no Claude first tool it is not offered, and a stale choice falls back to the subscription one.
    const none = add({ addFormChoice: "login", loginOf: null });
    expect(none).not.toContain("Another Claude account");
    expect(none).toContain("Tool");
  });
});

describe("Calendar drawn: the switch, the label and the C-A rows", () => {
  const WL: CalendarListJson = {
    schemaVersion: 1,
    macos: { status: "ok", calendars: [{ id: "A", title: "Home", account: "iCloud", editable: true, type: "standard", selected: true }] },
    links: [
      { id: "team", name: "Team", urlPathOwner: "me@example.com", confirmedOwner: "me@example.com", urlFrom: "file", fileStatus: "ok" },
      { id: "family", name: "Family", confirmedOwner: null, urlFrom: "file", fileStatus: "ok" },
    ],
  };
  const ST: CalendarStatusJson = { schemaVersion: 1, enabled: true, enabledSet: true, macSupported: true, configWarnings: [], sources: [] };
  const CFG = (enabled: boolean) => JSON.stringify({ calendar: { enabled, macos: { calendars: "editable" }, links: [{ id: "team" }, { id: "family" }] } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cal = (enabled: boolean, os = "macos") => flat(render(CalendarSettings as any, { props: { os, initial: { configText: CFG(enabled), list: WL, status: { ...ST, enabled } } } }).body);
  const rowOf = (html: string, id: string): string => {
    const at = html.indexOf(`aria-controls="${id}"`);
    return html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at) + 5);
  };

  test("a row needing the user: its one action in the row, before the chevron's row end; tinted; the link line says Google only from stored data", () => {
    const b = cal(true);
    const family = rowOf(b, "cal-src-link-family");
    expect(family).toMatch(/^<li class="item src[^"]* needs">/);
    expect(words(family.slice(0, family.indexOf('<div class="details')))).toBe("Family Calendar link · ● add your email Add your email");
    expect(family).toMatch(/<\/button> <button type="button" class="act[^"]*">Add your email<\/button>/);
    const team = rowOf(b, "cal-src-link-team");
    expect(team).not.toMatch(/ needs">/);
    expect(words(team.slice(0, team.indexOf('<div class="details')))).toBe("Team Google calendar link · ● not read yet");
    expect(team).not.toContain('class="act');
    const mac = rowOf(b, "cal-src-macos");
    expect(words(mac.slice(0, mac.indexOf('<div class="details')))).toBe("Mac Calendar app Reads 1 calendar on this Mac · ● allowed");
  });

  test("off: the master switch off, DISABLED, the help in --danger, every tag off, no row needing anything, no action", () => {
    const b = cal(false);
    expect(b).toMatch(/<span class="badge badge-off[^"]*">Disabled<\/span>/);
    expect(b).not.toContain('class="act');
    expect(b).not.toMatch(/ needs">/);
    expect(b).toContain("The calendar is off, so these aren't read. Turn it on above.");
    const css = src("lib/CalendarSettings.svelte");
    expect(css).toMatch(/\.box > \.help\.offhelp \{\s*color: var\(--danger\);\s*\}/);
  });

  test("the switch: a native checkbox with role=switch, its look this component's own — focus ring, reduced motion", () => {
    const sw = src("lib/Switch.svelte");
    expect(sw).toContain('type="checkbox"');
    expect(sw).toContain('role="switch"');
    expect(sw).toMatch(/\.switch:focus-visible \{\s*outline: 2px solid var\(--accent\);\s*outline-offset: 2px;\s*\}/);
    expect(sw).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.switch,\s*\.switch::before \{\s*transition: none;\s*\}\s*\}/);
    expect(sw).toMatch(/\.switch \{[^}]*background: var\(--muted\);/);
    expect(sw).toMatch(/\.switch:checked \{\s*background: var\(--state-done\);\s*\}/);
    expect(sw).toMatch(/\.switch::before \{[^}]*background: var\(--tile\);/);
    // It writes exactly what the checkbox wrote: `calendar.enabled`, through the same function.
    const c = src("lib/CalendarSettings.svelte");
    expect(c).toContain('<Switch id="cal-master" describedby="cal-master-line" checked={calendarOn(block)} disabled={busy || block === null} onchange={(on) => setEnabled(on)} />');
    // Round 10 (H1): and answers the write's promise, so the switch shows the file's value once it settles.
    expect(c).toContain('return write(() => editBlock((b) => withEnabled(b, on), deps, describeFailure), "Calendar setting saved.");');
    expect(sw.replace(/\s+/g, " ")).toContain("async function changed(box: HTMLInputElement): Promise<void> { try { await onchange(box.checked); } finally { box.checked = checked; } }");
    expect(sw).toContain("onchange={(e) => void changed(e.currentTarget)}");
  });

  test("Add a connection…: opens the link flow at once when the Mac source is on or not shown; otherwise asks", () => {
    const c = src("lib/CalendarSettings.svelte").replace(/\s+/g, " ");
    // Round 9 (L8): each then moves the focus to what it opened (Settings only: `focusFirst`).
    expect(c).toContain("function addConnection(): void { if (connectionChoices(showMac, macOn).length === 1) { openAdd(); void focusFirst(ADD_FIRST); } else { choosing = true; void focusFirst(PICKER_FIRST); } }");
    expect(c).toContain("function chooseMac(): void { choosing = false; void setMac(true); void focusFirst([MAC_HEAD]); }");
    expect(c).toContain("const MAC_HEAD = '.calendar.panel button.head[aria-controls=\"cal-src-macos\"]';");
    // Round 10 (L4): the add flow's first control is its chosen provider, else its first field.
    expect(c).toContain("const ADD_FIRST = ['.calendar.panel .add:not(.picker) input[name=\"cal-provider\"]:checked', \".calendar.panel .add:not(.picker) input\"];");
    expect(c).toContain("function chooseLink(): void { choosing = false; openAdd(); void focusFirst(ADD_FIRST); }");
    expect(c).toContain('<p>What do you want to connect?</p> <div class="row"> <button type="button" disabled={busy} onclick={chooseMac}>Mac Calendar app</button> <button type="button" disabled={busy} onclick={chooseLink}>Calendar link</button>');
  });
});

/* ══ contrast: the label tints, the switch, the amber row (component colours; look.check.ts covers app.css's) ═════ */

describe("contrast, measured from the sources' own values in both themes", () => {
  const app = src("app.css");
  const appDark = app.slice(app.indexOf("@media (prefers-color-scheme: dark)"));
  const cal = src("lib/CalendarSettings.svelte");
  const calDark = cal.slice(cal.indexOf("@media (prefers-color-scheme: dark)"));
  const tok = (sheet: string, name: string): string => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(sheet)?.[1] ?? "";
  const lum = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string): number => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100;
  };
  const themes = [
    ["light", app, cal.slice(cal.indexOf(".panel {"))],
    ["dark", appDark, calDark],
  ] as const;

  test("ENABLED (--state-done on its tint) and DISABLED (--danger on its tint) ≥ 4.5:1; the amber row's words and tag ≥ 4.5:1", () => {
    const got: Record<string, number> = {};
    for (const [theme, sheet, comp] of themes) {
      const on = tok(comp, "--tint-on");
      const off = tok(comp, "--tint-off");
      const needs = tok(comp, "--tint-needs");
      expect([on, off, needs].every((h) => /^#[0-9a-f]{6}$/.test(h))).toBe(true);
      got[`${theme} enabled`] = ratio(tok(sheet, "--state-done"), on);
      got[`${theme} disabled`] = ratio(tok(sheet, "--danger"), off);
      got[`${theme} amber row: name`] = ratio(tok(sheet, "--fg"), needs);
      got[`${theme} amber row: line`] = ratio(tok(sheet, "--muted"), needs);
      got[`${theme} amber row: tag`] = ratio(tok(sheet, "--tag-local"), needs);
    }
    for (const [what, r] of Object.entries(got)) expect({ what, ok: r >= 4.5 }).toEqual({ what, ok: true });
    // The measured values, for the record (the PR's contrast table).
    expect(got).toEqual({
      "light enabled": 4.58, "light disabled": 5.59, "light amber row: name": 15.1, "light amber row: line": 5, "light amber row: tag": 5.14,
      "dark enabled": 7.67, "dark disabled": 5.68, "dark amber row: name": 12.1, "dark amber row: line": 4.94, "dark amber row: tag": 7.44,
    });
  });

  test("the switch: its track against its thumb and against the tile ≥ 3:1, on and off; its focus ring ≥ 3:1 on the tile", () => {
    const got: Record<string, number> = {};
    for (const [theme, sheet] of themes) {
      const tile = tok(sheet, "--tile");
      for (const [state, track] of [["off", tok(sheet, "--muted")], ["on", tok(sheet, "--state-done")]] as const) {
        got[`${theme} ${state}: track/thumb`] = ratio(track, tile);
      }
      got[`${theme} focus ring`] = ratio(tok(sheet, "--accent"), tile);
    }
    for (const [what, r] of Object.entries(got)) expect({ what, ok: r >= 3 }).toEqual({ what, ok: true });
    expect(got).toEqual({
      "light off: track/thumb": 5.74, "light on: track/thumb": 5.02, "light focus ring": 14.26,
      "dark off: track/thumb": 5.56, "dark on: track/thumb": 9.54, "dark focus ring": 6.02,
    });
  });
});
