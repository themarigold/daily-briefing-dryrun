/**
 * T15 — the Settings form model and screens.
 *
 * What only the webview side can pin: that the form edits the LOADED object in place (unknown keys
 * and key order survive; an untouched form serialises back to the file's exact bytes, so Rust sees
 * a no-op), that it has no `transcripts` field and never shows a stored key, that its help text is
 * the engine's own words, and that the save report shows errors and warnings distinctly. The save
 * PATH — where, validation, atomicity, the human gates — is Rust's, and `src-tauri/tests/config_save.rs`
 * drives it.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxy } from "svelte/internal/client";
import { render } from "svelte/server";

// READ-ONLY imports of the engine's own repo discovery and key ladder, so the help text for those
// fields is checked against what the engine does (M3b checkpoint fix), not against a paraphrase.
// The same for the prompt budget (`reduce`) and the search setting's name (`discoverySummary`).
import { resolveApiKey } from "../../src/apiKey";
import { discoverRepos, validateConfig } from "../../src/config";
import { claudeShaped } from "../../src/harden";
import { API_TIMEOUT_MS, TIMEOUT_MS } from "../../src/provider";
import { resolveProviderList } from "../../src/providerList";
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "../../src/providers/anthropic";
import { discoverySummary } from "../../src/discoverySummary";
import { reduce } from "../../src/reduce";
import type { Activity } from "../../src/types";

import { describeFailure, REDACTED_API_KEY, type SaveOutcome } from "../src/lib/files";
import {
  allQuotes,
  ARGV_NOTE,
  fieldIsLive,
  formSubmission,
  getPath,
  hasPath,
  hasStoredApiKey,
  isCustomNotify,
  isDirty,
  jsonEqual,
  keepSettings,
  keptAfterSave,
  liveErrors,
  moveProvider,
  notifyOffer,
  offerNote,
  offerTakeable,
  rawFromDraft,
  readField,
  readNotifyCommand,
  removeStoredApiKey,
  SECTIONS,
  sectionsFor,
  settleKeptSettings,
  takeKeptSettings,
  useDefault,
  useEmptyList,
  writeField,
  writeNotifyCommand,
  type Draft,
  type Field,
  type KeptSettings,
} from "../src/lib/settings-model";
import SaveReport from "../src/routes/SaveReport.svelte";
import SettingsForm from "../src/routes/SettingsForm.svelte";

// P3-M4-T1 — "Providers, in order". The engine's own row status and wording, READ-ONLY (none reaches the scheduler
// installer, which `coexistence.check.ts`'s import pin forbids here): the precedence the app shows is the engine's.
import { HOUR_MARK_REASONS } from "../../src/account";
import { FAILOVER_REASONS } from "../../src/failover";
import { rowStatus } from "../../src/providerStatus";
import type { CheckOutcome, ConfigValidateReport, EngineOutcome, ProviderRefusal, ProviderResetAnswer, ProviderValidateRow } from "../src/lib/engine";
import ProvidersList from "../src/lib/ProvidersList.svelte";
import { insertEntry, readProviderList, writeProviderList } from "../src/lib/provider-list";
import {
  applyNetworkAnswer,
  CLI_TEST_NOTE,
  judgeLineFor,
  KEY_MOVED_LINE,
  KEYCHAIN_DIALOG_REMEDY,
  keyTimeoutLine,
  markNetworkAsked,
  NETWORK_ASK,
  networkAskNeeded,
  networkAsked,
  notRecordedLine,
  parseStatusProviders,
  PROVIDERS_TITLE,
  providersView,
  reasonWords,
  remedyFor,
  removeProvider,
  REPLACE_WAITING_LINE,
  resetResultLine,
  saveGate,
  saveGateFailure,
  setLoginFolder,
  statusLine,
  testPlan,
  testResultLines,
  type ProvidersView,
  type StatusProviderRow,
} from "../src/lib/settings-model";
import * as settingsModel from "../src/lib/settings-model";
import * as flowsModule from "../src/lib/provider-flows";
import { JUDGE_LINE } from "../src/lib/wizard";

const ENGINE = new URL("../../", import.meta.url).pathname;
const FULL = readFileSync(new URL("../src-tauri/tests/fixtures/config-full.json", import.meta.url), "utf8");
const API = readFileSync(new URL("../src-tauri/tests/fixtures/config-api.json", import.meta.url), "utf8");
const PLACEHOLDER = "(a literal API key is stored in config.json; Daily Briefing never displays it)";

test("the TS wire contract's placeholder and error kinds are Rust's", () => {
  const rust = readFileSync(new URL("../src-tauri/src/config_save.rs", import.meta.url), "utf8");
  expect(REDACTED_API_KEY).toBe(PLACEHOLDER);
  expect(codeOf(rust).replace(/\s+/g, " ")).toContain(`"${PLACEHOLDER}"`);
  // Every `SaveError` variant is a `kind` the webview can word.
  const block = /pub enum SaveError \{([\s\S]*?)\n\}/.exec(rust)?.[1] ?? "";
  const variants = [...block.matchAll(/^    ([A-Z]\w*)\b/gm)].map((m) => m[1] ?? "");
  expect(variants.length).toBeGreaterThanOrEqual(12);
  for (const v of variants) {
    const kind = v.charAt(0).toLowerCase() + v.slice(1);
    expect({ kind, worded: describeFailure({ kind }) !== JSON.stringify({ kind }) }).toEqual({ kind, worded: true });
  }
  expect(describeFailure({ kind: "tooLarge", bytes: 2_000_000, limit: 1_048_576 })).toContain("over the 1048576-byte limit");
  // Review round 2: a refused parse is not called "not JSON" — `1e400` is well-formed JSON.
  const range = "number out of range at line 3 column 14: the JSON is well-formed, but …";
  for (const kind of ["notJson", "onDiskNotJson"]) {
    const words = describeFailure({ kind, path: "/c/config.json", detail: range });
    expect(words).toContain("could not be read as a JSON object (number out of range");
    expect(words).not.toContain("not valid JSON");
    expect(words).not.toContain("is not a JSON object");
  }
  expect(codeOf(rust)).toContain('if text.starts_with("number out of range")');
  const bak = describeFailure({ kind: "backupNotAFile", path: "/c/config.json.bak", detail: "a directory" });
  expect(bak).toContain("/c/config.json.bak, is a directory, not a regular file");
  expect(bak).toContain("Move it out of the way");
});

/**
 * Review round 2 (V1): `fsync` has no runtime observable here (no file-ops trait; syscall tracing
 * needs root), so the calls are pinned in the SOURCE. Presence checks only, over comment-stripped
 * text: stripping too much can only make this fail, never pass.
 */
describe("config_save.rs fsyncs before it renames (source pin)", () => {
  const rust = readFileSync(new URL("../src-tauri/src/config_save.rs", import.meta.url), "utf8");
  const code = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ");
  /** The body of `fn <name>(`, by brace matching from the first `{` after the signature. */
  const body = (name: string): string => {
    const at = rust.search(new RegExp(`\\bfn ${name}\\b`));
    expect({ name, found: at >= 0 }).toEqual({ name, found: true });
    const open = rust.indexOf("{\n", at);
    let depth = 0;
    for (let i = open; i < rust.length; i++) {
      if (rust[i] === "{") depth++;
      if (rust[i] === "}" && --depth === 0) return code(rust.slice(open, i + 1));
    }
    throw new Error(`fn ${name} has no end`);
  };

  test("each staged file is written, then synced, and the sync's error is returned", () => {
    const w = body("write_new_file");
    const write = w.indexOf("file.write_all(bytes)?;");
    const sync = w.indexOf("file.sync_all() })();");
    expect({ write, sync }).toEqual({ write: expect.any(Number), sync: expect.any(Number) });
    expect(write).toBeGreaterThan(0);
    expect(sync).toBeGreaterThan(write);
    expect(w).toContain("if written.is_err() { let _ = std::fs::remove_file(path); } written }");
  });

  test("both staged files are durable before the re-read and before any rename", () => {
    const r = body("replace_config_file_with_link");
    const tmp = r.indexOf("write_new_file(&tmp, new_bytes, new_mode)");
    const backup = r.indexOf("write_new_file( &backup_tmp, expected_current.as_bytes(),");
    const reread = r.indexOf("read_existing(path)");
    const keep = r.indexOf("keep_previous_backup(");
    const firstRename = r.indexOf("std::fs::rename(");
    const finalRename = r.indexOf("std::fs::rename(&tmp, path)");
    for (const [what, at] of Object.entries({ tmp, backup, reread, keep, firstRename, finalRename })) {
      expect({ what, found: at >= 0 }).toEqual({ what, found: true });
    }
    expect(tmp).toBeLessThan(reread);
    expect(backup).toBeLessThan(reread);
    expect(reread).toBeLessThan(keep);
    expect(keep).toBeLessThan(firstRename);
    // …and the directory is synced after the final rename.
    const dirSync = r.indexOf("if let Ok(d) = std::fs::File::open(dir) { let _ = d.sync_all(); }");
    expect(dirSync).toBeGreaterThan(finalRename);
    // `replace_config_file` is the production path and adds nothing between.
    expect(body("replace_config_file")).toContain("|from, to| std::fs::hard_link(from, to), before_rename,");
  });

  test("the pin can fail: a body without the sync is not accepted", () => {
    const stripped = code("let written = (|| { file.write_all(bytes)?; Ok(()) })();");
    expect(stripped.indexOf("file.sync_all() })();")).toBe(-1);
    expect(code("// file.sync_all() })();\nOk(())")).not.toContain("sync_all");
  });
});
const HOSTILE = '<img src=x onerror="alert(1)">';

const parse = (s: string): Draft => JSON.parse(s) as Draft;
const out = (d: Draft): string => JSON.stringify(d, null, 2);
/** A source file as CODE: `/* … *\/` blocks, `//` line comments (at a line's start or after a space or tab — so
 *  `https://` inside a string stays) and `<!-- … -->` removed, newlines kept. Every positive source pin here matches
 *  this, so a commented-out copy of the pinned line can never satisfy it (P3-M4 checkpoint). The copy in
 *  `provider-flows.check.ts` is the same; a check file cannot import another without running its tests twice. */
const codeOf = (src: string): string =>
  src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1")
    .replace(/(^|[ \t])\/\/[^\n]*/gm, "$1")
    .replace(/[ \t]+$/gm, "");
const field = (id: string): Field => {
  const f = SECTIONS.flatMap((s) => s.fields).find((x) => x.id === id);
  if (f === undefined) throw new Error(`no field ${id}`);
  return f;
};

function formHtml(draft: Draft, errors: Record<string, string> = {}): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(SettingsForm as any, {
    props: { draft, errors, onfield: () => {}, onnotifycommand: () => {}, ondefault: () => {}, onremovekey: () => {} },
  })
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ");
}

/** Engine source with comment markers removed and whitespace collapsed, so a quote that spans
 *  comment lines can be found as the sentence it is. */
function flatSource(rel: string): string {
  return readFileSync(`${ENGINE}${rel}`, "utf8")
    .split("\n")
    .map((l) => l.replace(/^\s*(\/\*\*|\/\/|\*\/|\*)?\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

describe("the fixtures and the format", () => {
  test("the Rust fixtures are JSON.stringify(x, null, 2) output", () => {
    for (const text of [FULL, API]) {
      expect(JSON.stringify(JSON.parse(text), null, 2)).toBe(text);
    }
  });

  test("an untouched form serialises back to the file's exact bytes", () => {
    for (const text of [FULL, API]) {
      const draft = parse(text);
      for (const section of sectionsFor(draft)) {
        for (const f of section.fields) {
          // Reading every field and writing the same value back is a no-op.
          expect(writeField(draft, f, readField(draft, f))).toBeNull();
        }
      }
      expect(out(draft)).toBe(text);
    }
  });
});

describe("the form model", () => {
  test("has no transcripts field, and the form never mentions it", () => {
    const ids = SECTIONS.flatMap((s) => s.fields.map((f) => f.path.join(".")));
    expect(ids.some((p) => p.startsWith("transcripts"))).toBe(false);
    expect(formHtml(parse(FULL)).toLowerCase()).not.toContain("transcript");
    // The block itself survives an edit untouched.
    const draft = parse(FULL);
    writeField(draft, field("lookbackCapDays"), "9");
    expect(getPath(draft, ["transcripts"])).toEqual(parse(FULL).transcripts);
  });

  test("an edit changes that field only, in place: unknown keys and order survive", () => {
    const draft = parse(FULL);
    expect(writeField(draft, field("lookbackCapDays"), "9")).toBeNull();
    expect(out(draft)).toBe(FULL.replace('"lookbackCapDays": 7', '"lookbackCapDays": 9'));

    const d2 = parse(FULL);
    expect(writeField(d2, field("provider.timeoutMs"), "900000")).toBeNull();
    expect(writeField(d2, field("morningTime"), "06:45")).toBeNull();
    expect(Object.keys(d2)).toEqual(Object.keys(parse(FULL)));
    expect(Object.keys(d2.provider as Draft)).toEqual(Object.keys(parse(FULL).provider as Draft));
    expect(d2["$comment"]).toBe(parse(FULL)["$comment"]);
    expect(d2["x-middle"]).toEqual(parse(FULL)["x-middle"]);
    expect(d2["zz-unicode"]).toBe(parse(FULL)["zz-unicode"]);
    expect((d2.provider as Draft)["x-provider-extra"]).toEqual({ kept: true });
  });

  test("list fields: lines in, arrays out; objects matched so their unknown keys survive", () => {
    const draft = parse(FULL);
    // P3-M4-T1: the logins are no longer a text field — "Providers, in order" edits them (below). A reorder there
    // keeps a login's unknown keys, as the old free-text field's label matching did.
    (getPath(draft, ["provider", "accounts"]) as Draft[])[1]!["x-note"] = "keep me";
    expect(moveProvider(draft, 1, 0)).toBeNull();
    expect(getPath(draft, ["provider", "accounts"])).toEqual([
      { label: "backup", configDir: "~/.claude-backup", "x-note": "keep me" },
      { label: "primary" },
    ]);

    expect(readField(draft, field("subprojects"))).toBe("alpha: \nbeta: packages/*, apps/web");
    expect(writeField(draft, field("subprojects"), "beta: packages/*\ngamma:")).toBeNull();
    expect(getPath(draft, ["subprojects"])).toEqual([
      { repo: "beta", roots: ["packages/*"] },
      { repo: "gamma", roots: [] },
    ]);
    expect(writeField(draft, field("subprojects"), "no colon here")).not.toBeNull();

    expect(readField(draft, field("networkProbeHosts"))).toBe("1.1.1.1:443\n8.8.8.8:443");
    expect(writeField(draft, field("networkProbeHosts"), "localhost:11434")).toBeNull();
    expect(getPath(draft, ["networkProbeHosts"])).toEqual([{ host: "localhost", port: 11434 }]);
    for (const bad of ["no-port", "host:0", "host:70000", "host:12.5", ":443"]) {
      expect(writeField(draft, field("networkProbeHosts"), bad)).not.toBeNull();
    }
    expect(getPath(draft, ["networkProbeHosts"])).toEqual([{ host: "localhost", port: 11434 }]);
  });

  test("emptiness: [] where it means something, the default only when asked for", () => {
    const draft = parse(FULL);
    // `networkProbeHosts: []` disables the gate: an emptied box writes [], it does not remove the key.
    expect(writeField(draft, field("networkProbeHosts"), "")).toBeNull();
    expect(getPath(draft, ["networkProbeHosts"])).toEqual([]);
    useDefault(draft, field("networkProbeHosts"));
    expect(hasPath(draft, ["networkProbeHosts"])).toBe(false);
    // An empty box over an ABSENT defaultable key leaves it absent; only the toggle writes [].
    expect(writeField(draft, field("networkProbeHosts"), "")).toBeNull();
    expect(hasPath(draft, ["networkProbeHosts"])).toBe(false);
    useEmptyList(draft, field("networkProbeHosts"));
    expect(getPath(draft, ["networkProbeHosts"])).toEqual([]);
    expect(writeField(draft, field("networkProbeHosts"), "h:1")).toBeNull();
    useEmptyList(draft, field("networkProbeHosts"));
    expect(getPath(draft, ["networkProbeHosts"])).toEqual([{ host: "h", port: 1 }]);
    // A required list keeps an empty array; an optional one whose absence means the same is removed.
    expect(writeField(draft, field("provider.argv"), "")).toBeNull();
    expect(getPath(draft, ["provider", "argv"])).toEqual([]);
    expect(writeField(draft, field("auditJudgeArgv"), "")).toBeNull();
    expect(hasPath(draft, ["auditJudgeArgv"])).toBe(false);
    // An optional scalar is removed; a required one is kept empty.
    expect(writeField(draft, field("provider.timeoutMs"), "")).toBeNull();
    expect(hasPath(draft, ["provider", "timeoutMs"])).toBe(false);
    // User-directed 2026-10-22 (P2): the command is typed in Other's own row; the Command choice itself takes a tool.
    // Round 12 (L2): an empty command is refused, never written (the engine's check takes any string).
    const cli = getPath(draft, ["provider", "cli"]);
    expect(writeField(draft, settingsModel.TOOL_COMMAND_FIELD, "")).toBe(settingsModel.EMPTY_COMMAND_REFUSAL);
    expect(writeField(draft, settingsModel.TOOL_COMMAND_FIELD, "   ")).toBe(settingsModel.EMPTY_COMMAND_REFUSAL);
    expect(getPath(draft, ["provider", "cli"])).toBe(cli);
    // Numbers and choices are checked before anything changes.
    expect(writeField(draft, field("lookbackCapDays"), "four")).toBe("must be a number");
    expect(getPath(draft, ["lookbackCapDays"])).toBe(7);
    expect(writeField(draft, field("provider.promptVia"), "pipe")).toContain("must be one of");
    expect(writeField(draft, field("provider.harden"), "false")).toBeNull();
    expect(getPath(draft, ["provider", "harden"])).toBe(false);
  });

  test("notify: off, auto, a command, or absent", () => {
    const draft = parse(FULL);
    expect(readField(draft, field("notify"))).toBe("command");
    expect(readNotifyCommand(draft)).toBe("/usr/local/bin/push\n{title}\n{body}\n{path}");
    writeNotifyCommand(draft, "/bin/echo\n{title}");
    expect(getPath(draft, ["notify"])).toEqual({ command: ["/bin/echo", "{title}"] });
    expect(writeField(draft, field("notify"), "auto")).toBeNull();
    expect(getPath(draft, ["notify"])).toBe("auto");
    expect(writeField(draft, field("notify"), "")).toBeNull();
    expect(hasPath(draft, ["notify"])).toBe(false);
    expect(writeField(draft, field("notify"), "command")).toBeNull();
    expect(getPath(draft, ["notify"])).toEqual({ command: [] });
  });

  test("an API provider gets the API section, and the stored key is never rendered", () => {
    const draft = parse(API.replace("sk-ant-SENTINEL-DO-NOT-LEAK-0000", PLACEHOLDER));
    const titles = sectionsFor(draft).map((s) => s.title);
    expect(titles).toContain("Provider (API)");
    expect(titles).not.toContain("Provider (command-line tool)");
    const body = formHtml(draft);
    // The fixture's list is readable, so the row banner speaks for item 1's key, not the old notice (P3-M4 checkpoint).
    expect(body).toContain(settingsModel.literalBanner(undefined));
    expect(body).not.toContain("Remove the stored key");
    expect(body).not.toContain(PLACEHOLDER);
    expect(body).not.toContain("SENTINEL");
    expect(body).toContain("Neither this app nor the background scheduler passes your shell");
    removeStoredApiKey(draft);
    expect(hasPath(draft, ["provider", "api", "apiKey"])).toBe(false);
    expect(formHtml(draft)).not.toContain(settingsModel.literalBanner(undefined));
    // A CLI config shows the CLI section only.
    expect(sectionsFor(parse(FULL)).map((s) => s.title)).toContain("Provider (command-line tool)");
    expect(sectionsFor(parse(FULL)).map((s) => s.title)).not.toContain("Provider (API)");
  });

  test("help text is the engine's own words, verbatim", () => {
    const quotes = allQuotes();
    expect(quotes.length).toBeGreaterThanOrEqual(15);
    const cache = new Map<string, string>();
    for (const q of quotes) {
      const src = cache.get(q.source) ?? flatSource(q.source);
      cache.set(q.source, src);
      expect({ quote: q.text, found: src.includes(q.text.replace(/\s+/g, " ")) }).toEqual({ quote: q.text, found: true });
    }
    // prove-it 3b: a paraphrase is not found.
    expect(flatSource("src/types.ts").includes("repos to remove from the briefing")).toBe(false);
    // v0.2.1 §4.1: the form shows each field's plain `help` instead — no quote, no `(src/…)` tag.
    const body = formHtml(parse(FULL));
    expect(body).toContain(field("subprojects").help);
    expect(body).not.toContain("per-repo project-root globs; [] = force single-unit despite a manifest");
    expect(body).not.toContain("(src/");
  });

  test("field errors and engine values stay text", () => {
    const draft = parse(FULL);
    draft.morningTime = HOSTILE;
    const body = formHtml(draft, { lookbackCapDays: `must be a number ${HOSTILE}` });
    expect(body).not.toContain("<img");
    expect(body).toContain('class="field-error');
  });
});

/* ── v0.2.1 §4.1: plain help, and the Advanced section (drawn open since redesign D) ─────────── */

describe("v0.2.1 §4.1: Settings help and Advanced", () => {
  const ALL = SECTIONS.flatMap((s) => s.fields);
  // Spec §4.1's twelve labels, as field ids, in the spec's order.
  const ADVANCED = [
    "subprojects", // Sub-project roots
    "provider.argv", // Arguments
    "provider.promptVia", // How the prompt is passed
    "provider.harden", // Harden the provider call
    // P3-M4-T1: "Failover accounts, in order" is gone — replaced by "Providers, in order", which is not a field.
    "provider.api.maxTokens", // Maximum output tokens
    "provider.api.apiKeyEnv", // Key environment variable
    "provider.timeoutMs", // Timeout (milliseconds)
    "tokenBudget.maxChars", // Prompt budget
    "excludeCommitPatterns", // Commit subjects to ignore
    "auditJudgeArgv", // Extra arguments for the audit judge
    "networkProbeHosts", // Connectivity check targets
  ];
  const CLI_ONLY = ["provider.argv", "provider.promptVia", "provider.harden"];
  const API_ONLY = ["provider.api.maxTokens", "provider.api.apiKeyEnv"];
  const api = () => parse(API.replace("sk-ant-SENTINEL-DO-NOT-LEAK-0000", PLACEHOLDER));

  test("every one of the 29 fields has non-empty help, and every quote is still in the model", () => {
    // 29 until P3-M4-T1, which replaced the accounts field with the providers list; 29 again from A2-M5-T15 (AI summaries).
    expect(ALL).toHaveLength(29);
    for (const f of ALL) expect({ id: f.id, help: f.help.trim().length > 0 }).toEqual({ id: f.id, help: true });
    // The quote is kept, undisplayed — the verbatim test above still checks each one.
    expect(allQuotes().length).toBe(ALL.filter((f) => f.quote !== undefined).length);
  });

  test("provider help names the engine's default output cap and per-transport timeouts", () => {
    expect(field("provider.api.maxTokens").help).toContain(
      `limit of ${ANTHROPIC_DEFAULT_MAX_TOKENS.toLocaleString("en-US")} tokens`,
    );
    const minuteWords = ["zero", "one", "two", "three", "four", "five"];
    expect(field("provider.timeoutMs").help).toContain(
      `default is ${minuteWords[TIMEOUT_MS / 60_000]} minutes for a command-line provider and ${minuteWords[API_TIMEOUT_MS / 60_000]} minutes for an API provider`,
    );
  });

  test("help is plain: one or two sentences, no file name, no code term", () => {
    const BANNED = ["src/", ".ts", "argv", "no-op", "`"];
    for (const f of ALL) {
      const found = BANNED.filter((b) => f.help.includes(b));
      expect({ id: f.id, found }).toEqual({ id: f.id, found: [] });
      const sentences = f.help.split(/[.!?](?:\s|$)/).filter((x) => x.trim() !== "").length;
      expect({ id: f.id, sentences: sentences >= 1 && sentences <= 2 }).toEqual({ id: f.id, sentences: true });
    }
    // The spec's own example, word for word.
    expect(field("morningTime").help).toBe(
      "Your briefing is generated on the first check after this time once your machine is awake.",
    );
    // The deny-list can fail.
    for (const leak of ["see src/types.ts", "the argv list", "a no-op", "`x`"]) {
      expect({ leak, caught: BANNED.some((b) => leak.includes(b)) }).toEqual({ leak, caught: true });
    }
  });

  test("Advanced holds exactly the listed fields, last; the other eighteen stay in their sections", () => {
    const titles = SECTIONS.map((s) => s.title);
    expect(titles[titles.length - 1]).toBe("Advanced");
    const advanced = SECTIONS.find((s) => s.title === "Advanced")!;
    // Redesign D: Advanced has its own page and is drawn open; no section is collapsed any more.
    expect("collapsed" in advanced).toBe(false);
    expect(advanced.fields.map((f) => f.id)).toEqual(ADVANCED);
    expect(SECTIONS.filter((s) => "collapsed" in s)).toHaveLength(0);
    const rest = SECTIONS.filter((s) => s !== advanced).map((s) => [s.title, s.fields.map((f) => f.id)]);
    expect(rest).toEqual([
      ["Repositories", ["repos", "discoverRoots", "excludeRepos"]],
      // Post-cap (R5-M6): the group is "You", as the S-A mockup's; the fields and the engine's keys are unchanged.
      ["You", ["author.names", "author.emails"]],
      ["Provider (command-line tool)", ["provider.cli", "provider.credential"]],
      ["Provider (API)", ["provider.api.kind", "provider.api.model", "provider.api.baseUrl", "provider.api.apiKeyFile", "provider.api.apiKeyCommand"]],
      // Redesign D, user-directed 2026-10-21: Morning time comes before Look back (the approved S-A mockup's order).
      ["Briefing", ["morningTime", "lookbackCapDays", "aiSummary.enabled"]],
      ["Notifications from the engine", ["notify"]],
      ["Update check", ["updateCheck.enabled", "updateCheck.intervalHours"]],
    ]);
    expect(rest.flatMap(([, ids]) => ids as string[])).toHaveLength(18);
    // CLI-only and API-only fields say so themselves; the timeout applies to both.
    for (const id of CLI_ONLY) expect({ id, when: field(id).when }).toEqual({ id, when: "cli" });
    for (const id of API_ONLY) expect({ id, when: field(id).when }).toEqual({ id, when: "api" });
    expect(ALL.filter((f) => f.when !== undefined).map((f) => f.id).sort()).toEqual([...CLI_ONLY, ...API_ONLY].sort());
  });

  test("sectionsFor filters Advanced's fields by provider", () => {
    const ids = (d: Draft, title: string) =>
      sectionsFor(d).find((s) => s.title === title)?.fields.map((f) => f.id) ?? [];
    expect(ids(parse(FULL), "Advanced")).toEqual(ADVANCED.filter((id) => !API_ONLY.includes(id)));
    expect(ids(api(), "Advanced")).toEqual(ADVANCED.filter((id) => !CLI_ONLY.includes(id)));
    // Nowhere else either: a filtered field is not live, so its stale error cannot block a save.
    expect(fieldIsLive(api(), field("provider.argv"))).toBe(false);
    expect(fieldIsLive(parse(FULL), field("provider.api.maxTokens"))).toBe(false);
    expect(fieldIsLive(api(), field("provider.api.maxTokens"))).toBe(true);
    expect(fieldIsLive(parse(FULL), field("provider.argv"))).toBe(true);
  });

  test("the form draws Advanced as a plain section, open, at the bottom, with only the provider's own fields", () => {
    for (const [draft, kept, hidden] of [
      [parse(FULL), "provider.argv", "provider.api.maxTokens"],
      [api(), "provider.api.maxTokens", "provider.argv"],
    ] as const) {
      const body = formHtml(draft);
      // No disclosure at all: Advanced is a fieldset with its own legend, like every other section.
      expect(body).not.toContain("<details");
      const legend = body.search(/<legend[^>]*><h4[^>]*>Advanced<\/h4><\/legend>/);
      expect(legend).toBeGreaterThan(-1);
      const start = body.lastIndexOf("<fieldset", legend);
      const end = body.indexOf("</fieldset>", legend) + "</fieldset>".length;
      expect(start).toBeGreaterThan(-1);
      const inside = body.slice(start, end);
      const before = body.slice(0, start);
      expect(inside).toContain(`id="f-${kept}"`);
      expect(body).not.toContain(`id="f-${hidden}"`);
      expect(inside).toContain('id="f-provider.timeoutMs"');
      // The eighteen are outside it, and nothing follows it.
      expect(before).toContain('id="f-morningTime"');
      expect(inside).not.toContain('id="f-morningTime"');
      expect(body.slice(end)).not.toContain('class="field');
    }
  });
  // Redesign D (D-M2-T3): the two tests that existed only because Advanced was collapsed ("Advanced opens when one
  // of its fields has a live error" and the `ontoggle` re-open pin) are replaced by `blockedPages`
  // (settings-pages.check.ts: the page holding a save-blocking field, and Save refusing exactly then), and by the
  // save bar's render (D-M4-T6), which names that page as a button.
});

/* ── Redesign D (D-M2-T3): SettingsForm draws the sections it is given ──────────────────────────── */

describe("D-M2-T3: the sections prop, and the providers list only with a provider section", () => {
  const LIST = /<legend[^>]*><h4[^>]*>Providers, in order<\/h4><\/legend>/g;
  const NOTICE = "A literal API key is stored in the config file";
  // User-directed 2026-10-22 (P-A): the note under the list (P4's goes with the first provider's box) — drawn with a
  // readable list of two or more, since it speaks of the other rows.
  const NOTE = "Only the first provider's settings are changed here.";
  const legendAt = (body: string, title: string): number =>
    body.search(new RegExp(`<legend[^>]*><h4[^>]*>${title.replace(/[()]/g, "\\$&")}</h4></legend>`));
  const draw = (draft: Draft, sections?: string[], errors: Record<string, string> = {}): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(SettingsForm as any, {
      props: { draft, errors, onfield: () => {}, onnotifycommand: () => {}, ondefault: () => {}, onremovekey: () => {}, ...(sections ? { sections } : {}) },
    })
      .body.replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, " ");
  // An API item 1 with a stored key and a list that cannot be read (two entries labelled "default"): the one draft
  // on which the stored-key notice is drawn, so its absence below is not vacuous.
  const unreadable = (): Draft => ({
    ...parse(API.replace("sk-ant-SENTINEL-DO-NOT-LEAK-0000", PLACEHOLDER)),
    fallbacks: [{ label: "default", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }],
  });

  test("with no sections prop every section is drawn, the list, the notice and the note with them, as today", () => {
    const body = draw(unreadable());
    expect(body.match(LIST)).toHaveLength(1);
    expect(body).toContain(NOTICE);
    // P-A: with no rows to speak of, no note; the provider box stays while the list cannot be read (no row 1 to hold it).
    expect(body).not.toContain(NOTE);
    for (const title of ["Repositories", "You", "Provider (API)", "Briefing", "Notifications from the engine", "Update check", "Advanced"]) {
      expect({ title, drawn: legendAt(body, title) > -1 }).toEqual({ title, drawn: true });
    }
    // A readable list of two or more: the note, and no provider box (its fields are row 1's).
    const two = parse(out({ ...parse(FULL), fallbacks: [{ label: "B", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }] }));
    const readable = draw(two);
    expect(readable).toContain(NOTE);
    expect(legendAt(readable, "Provider (command-line tool)")).toBe(-1);
    expect(readable).toContain('id="f-provider.credential"');
  });

  test("a page other than AI providers never contains the list, the notice or the note", () => {
    for (const draft of [parse(FULL), unreadable()]) {
      for (const sections of [["Briefing"], ["Repositories", "You"], ["Advanced"], ["Notifications from the engine"], ["Update check"]]) {
        const body = draw(draft, sections);
        // Exactly the named sections are drawn, in the model's order.
        const drawn = [...body.matchAll(/<legend[^>]*><h4[^>]*>([^<]*)<\/h4><\/legend>/g)].map((m) => m[1]);
        expect({ sections, drawn }).toEqual({ sections, drawn: sections });
        expect({ sections, lists: (body.match(LIST) ?? []).length, notice: body.includes(NOTICE), note: body.includes(NOTE) }).toEqual({
          sections,
          lists: 0,
          notice: false,
          note: false,
        });
      }
    }
    // With the prop, the provider-shape filter still applies: on its own page Advanced draws only the provider's
    // own fields (a command-line config: the arguments, no output-token limit; an API config: the reverse).
    for (const [draft, kept, hidden] of [
      [parse(FULL), "provider.argv", "provider.api.maxTokens"],
      [unreadable(), "provider.api.maxTokens", "provider.argv"],
    ] as const) {
      const body = draw(draft, ["Advanced"]);
      expect({ kept, drawn: body.includes(`id="f-${kept}"`) }).toEqual({ kept, drawn: true });
      expect({ hidden, drawn: body.includes(`id="f-${hidden}"`) }).toEqual({ hidden, drawn: false });
    }
  });

  test("a field error on Advanced is drawn inside the Advanced section, on its own page", () => {
    const body = draw(parse(FULL), ["Advanced"], { "provider.timeoutMs": "must be a number" });
    const legend = legendAt(body, "Advanced");
    expect(legend).toBeGreaterThan(-1);
    const inside = body.slice(body.lastIndexOf("<fieldset", legend), body.indexOf("</fieldset>", legend));
    expect(inside).toContain('<p class="field-error svelte-');
    expect(inside).toContain("must be a number");
  });

  test("the sections are drawn in the model's order, whatever order the prop names them in", () => {
    const body = draw(parse(FULL), ["Advanced", "You", "Repositories"]);
    expect([...body.matchAll(/<legend[^>]*><h4[^>]*>([^<]*)<\/h4><\/legend>/g)].map((m) => m[1])).toEqual(["Repositories", "You", "Advanced"]);
  });

  test("with the two provider sections, the list is drawn once, holding the first provider's own fields (P-A); an unreadable list keeps the provider box after it", () => {
    const providers = ["Provider (command-line tool)", "Provider (API)"];
    // P-A: a readable list draws the draft's provider fields inside row 1, and no provider box.
    const readable = draw(parse(FULL), providers);
    expect(readable.match(LIST)).toHaveLength(1);
    const ol = readable.slice(readable.indexOf('<ol class="list'), readable.indexOf("</ol>"));
    expect(ol).toContain('id="f-provider.cli"');
    expect(ol).toContain('id="f-provider.credential"');
    expect(ol.indexOf('id="f-provider.cli"')).toBeGreaterThan(ol.indexOf('id="prov-row-0"'));
    expect(ol.indexOf('id="f-provider.cli"')).toBeLessThan(ol.indexOf('id="prov-row-1"') === -1 ? Infinity : ol.indexOf('id="prov-row-1"'));
    for (const title of providers) expect({ title, drawn: legendAt(readable, title) }).toEqual({ title, drawn: -1 });
    // Unreadable: no row 1 to hold them, so the draft's own provider shape keeps its box, after the list.
    const body = draw(unreadable(), providers);
    expect(body.match(LIST)).toHaveLength(1);
    const list = body.search(/<legend[^>]*><h4[^>]*>Providers, in order<\/h4><\/legend>/);
    expect(list).toBeGreaterThan(-1);
    expect(list).toBeLessThan(legendAt(body, "Provider (API)"));
    expect(legendAt(body, "Provider (command-line tool)")).toBe(-1);
    // The stored-key notice comes with the list, on the draft that has one.
    expect(body).toContain(NOTICE);
  });
});

/* ── Redesign D (D-M1-T1): each section names the Settings page that draws it ──────────────────── */

describe("D-M1-T1: every section, and so every field, is on exactly one Settings page", () => {
  // The D spec's table: Repositories and Author (titled "You" since post-cap R5-M6) on Projects; the two provider sections on AI providers;
  // Briefing and Update check on General; the engine's notification setting and Advanced on Advanced.
  const PAGE_OF: [string, string][] = [
    ["Repositories", "projects"],
    ["You", "projects"],
    ["Provider (command-line tool)", "providers"],
    ["Provider (API)", "providers"],
    ["Briefing", "general"],
    ["Notifications from the engine", "advanced"],
    ["Update check", "general"],
    ["Advanced", "advanced"],
  ];

  test("each section, in the model's order, has its page", () => {
    expect(SECTIONS.map((s) => [s.title, s.page])).toEqual(PAGE_OF);
  });

  test("every field is on exactly one of the four config pages, computed from SECTIONS", () => {
    const CONFIG_PAGES = ["general", "projects", "providers", "advanced"];
    const pagesOf = new Map<string, string[]>();
    for (const s of SECTIONS) for (const f of s.fields) pagesOf.set(f.id, [...(pagesOf.get(f.id) ?? []), s.page]);
    expect(pagesOf.size).toBe(29);
    for (const [id, pages] of pagesOf) {
      expect({ id, one: pages.length === 1 && CONFIG_PAGES.includes(pages[0]!) }).toEqual({ id, one: true });
    }
    // The engine's own `notify` is the one field that changed page: it is on Advanced now.
    expect(pagesOf.get("notify")).toEqual(["advanced"]);
  });

  test("the engine's notification field is named for the engine and says the app stays quiet while it is active", () => {
    const notify = field("notify");
    expect(notify.label).toBe("Notifications from the engine");
    // "on this platform", as the line under the app's own control frames it (`engineNotifyLine`, `notify.ts`).
    expect(notify.help).toContain("While it is active on this platform, this app stays quiet about deliveries and still reports failures.");
  });
});

/* ── post-convergence LOW pass: Advanced help, and one name for the search setting ─────────────── */

describe("Advanced help says what each field governs, and the search setting has one name", () => {
  test("Prompt budget bounds the repository detail — what the engine's reduce() measures — not the whole prompt", () => {
    const help = field("tokenBudget.maxChars").help;
    expect(help).toContain("repository detail");
    expect(help).toContain("the instructions around it are not counted");
    expect(help).not.toContain("sends to the AI");
    // reduce() measures the repository context alone: at exactly its length nothing is trimmed; one
    // character under it, the detail is trimmed (and a note says so).
    const acts: Activity[] = [{ source: "git", kind: "commit", event_id: "e1", repo: "/r", text: "x".repeat(400) }];
    const whole = JSON.stringify(reduce(acts, { maxChars: Number.MAX_SAFE_INTEGER })).length;
    expect(reduce(acts, { maxChars: whole }).note).toBeUndefined();
    expect(reduce(acts, { maxChars: whole - 1 }).note).toBeDefined();
  });

  test("the audit judge's options are for the developer self-audit, which the engine's run never reads", () => {
    expect(field("auditJudgeArgv").help).toContain("developer self-audit, which this app never runs");
    // In the engine's runtime source only its type and the config check name it; the self-audit script reads it.
    const users = readdirSync(`${ENGINE}src`, { recursive: true })
      .map(String)
      .filter((rel) => rel.endsWith(".ts") && readFileSync(`${ENGINE}src/${rel}`, "utf8").includes("auditJudgeArgv"));
    expect(users.sort()).toEqual(["config.ts", "types.ts"]);
    expect(readFileSync(`${ENGINE}scripts/audit.ts`, "utf8")).toContain("cfg.auditJudgeArgv");
  });

  test("Arguments names the tool its options are for", () => {
    expect(field("provider.argv").help).toContain("the command-line tool");
    expect(field("provider.argv").help).not.toContain("that tool");
  });

  test("the search setting is labelled in the engine summary's own words", () => {
    const label = field("discoverRoots").label;
    expect(label).toBe("Folders to search");
    const said = discoverySummary([{ path: "/x/typo", kind: "not-found" }], { noRepos: true, home: "/h" })!;
    expect(said).toContain(`No repositories were found in ${label}.`);
    expect(said).toContain(`listed in ${label} (/x/typo)`);
  });
});

/* ── M3b checkpoint fix: help that says what the ENGINE does ──────────────────────────────────── */

describe("M3b checkpoint: the help for repositories and key sources matches the engine", () => {
  test("Repositories and the folders to search are either/or, as the engine's discoverRepos is", async () => {
    const repos = field("repos").help;
    const roots = field("discoverRoots").help;
    // The old wording promised the opposite ("in addition to", "on every run").
    expect(repos).not.toContain("in addition to");
    expect(roots).not.toContain("on every run");
    expect(repos).toContain(
      "When this list has anything in it, the briefing reads only these and does not search the folders below for more.",
    );
    expect(roots).toContain("but only while the Repositories list above is empty.");
    // "below" and "above" are true on screen: the list is drawn before the folders.
    const body = formHtml(parse(FULL));
    expect(body.indexOf('id="f-repos"')).toBeGreaterThan(0);
    expect(body.indexOf('id="f-repos"')).toBeLessThan(body.indexOf('id="f-discoverRoots"'));
    expect(body).toContain(repos);
    expect(body).toContain(roots);
    // …and the engine does what the two strings say, on a folder holding one repository.
    const scratch = mkdtempSync(join(tmpdir(), "dba-m3b-roots-"));
    try {
      const found = join(scratch, "proj");
      mkdirSync(join(found, ".git"), { recursive: true });
      const provider = { cli: "claude", argv: ["-p"], promptVia: "stdin" as const };
      // The list empty: the folder is searched, and its repository is read.
      expect((await discoverRepos({ discoverRoots: [scratch], provider })).repos).toEqual([found]);
      // Anything in the list: the same folder is not searched, and only the list is read.
      const listed = join(scratch, "listed-elsewhere");
      expect(await discoverRepos({ repos: [listed], discoverRoots: [scratch], provider })).toEqual({
        repos: [listed],
        issues: [],
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("the key file and key command say a higher source wins, as the engine's resolveApiKey does", async () => {
    const file = field("provider.api.apiKeyFile").help;
    const command = field("provider.api.apiKeyCommand").help;
    // The old wording promised every run ("each time it writes your briefing").
    for (const help of [file, command]) expect(help).not.toContain("each time");
    expect(file).toContain("unless the key environment variable has already supplied a key.");
    expect(command).toContain("unless the key environment variable or the key file has already supplied a key.");
    // …and the engine's ladder is that order, first hit wins: environment variable, file, command.
    const scratch = mkdtempSync(join(tmpdir(), "dba-m3b-key-"));
    try {
      const keyFile = join(scratch, "key");
      writeFileSync(keyFile, "from-file\n");
      chmodSync(keyFile, 0o600);
      const api = {
        kind: "anthropic" as const,
        model: "m",
        apiKeyEnv: "DBA_M3B_KEY",
        apiKeyFile: keyFile,
        apiKeyCommand: ["key-helper"],
      };
      let ran = 0;
      const exec = async () => {
        ran += 1;
        return { out: "from-command", err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false };
      };
      const env = await resolveApiKey(api, { DBA_M3B_KEY: "from-env" }, { exec });
      expect([env.source, env.key, ran]).toEqual(["env", "from-env", 0]);
      const fromFile = await resolveApiKey(api, {}, { exec });
      expect([fromFile.source, fromFile.key, ran]).toEqual(["file", "from-file", 0]);
      const fromCommand = await resolveApiKey({ ...api, apiKeyFile: join(scratch, "missing") }, {}, { exec });
      expect([fromCommand.source, fromCommand.key, ran]).toEqual(["command", "from-command", 1]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("R3-H2 (pre-existing on main, fixed in PR D): the model on the draft the app really holds, a Svelte $state proxy", () => {
  // Every other test here hands the model a plain object, and the server renders see one too. In the app `draft` is
  // `$state`, whose `delete` keeps the key on the proxy's target with an emptied source: its `getOwnPropertyDescriptor`
  // trap still answers for it, so `hasOwnProperty` said a removed key was there. That made "Use the engine's default"
  // a no-op on screen (the box stayed enabled, unticking wrote nothing back, the file lost its `[]`). This builds the
  // same proxy the client runtime builds for `$state` (svelte 5.57.0, `src/internal/client/proxy.js`).
  const live = (text: string): Draft => proxy(parse(text)) as Draft;
  const text = (d: unknown): string => JSON.stringify(d, null, 2);
  const hosts = field("networkProbeHosts");

  test("the premise: on the proxy, hasOwnProperty still answers for a deleted key, and Object.keys does not list it", () => {
    const draft = live(FULL);
    delete draft["networkProbeHosts"];
    expect(Object.prototype.hasOwnProperty.call(draft, "networkProbeHosts")).toBe(true);
    expect(Object.keys(draft)).not.toContain("networkProbeHosts");
    expect("networkProbeHosts" in draft).toBe(false);
  });

  test("tick, then untick: the key goes, the field is disabled, and the explicit [] comes back", () => {
    const draft = live(text({ ...parse(FULL), networkProbeHosts: [] }));
    expect([hasPath(draft, hosts.path), fieldIsLive(draft, hosts)]).toEqual([true, true]);
    useDefault(draft, hosts);
    expect([hasPath(draft, hosts.path), fieldIsLive(draft, hosts)]).toEqual([false, false]);
    expect(liveErrors(draft, { networkProbeHosts: '"bad" is not `host:port`' })).toEqual({});
    expect("networkProbeHosts" in parse(rawFromDraft(draft))).toBe(false);
    useEmptyList(draft, hosts);
    expect(getPath(draft, hosts.path)).toEqual([]);
    expect(parse(rawFromDraft(draft))["networkProbeHosts"]).toEqual([]);
    // Back where it was loaded, so the form is clean again (the bar hides).
    expect(isDirty({ base: "b", loadedText: text({ ...parse(FULL), networkProbeHosts: [] }), tab: "form", draft, raw: "", errors: {} })).toBe(false);
  });

  test("an emptied box on a defaulted key leaves it absent (writeField's empty branch), and a present one keeps []", () => {
    const draft = live(FULL);
    useDefault(draft, hosts);
    expect(writeField(draft, hosts, "")).toBeNull();
    expect(hasPath(draft, hosts.path)).toBe(false);
    useEmptyList(draft, hosts);
    expect(writeField(draft, hosts, "h:1")).toBeNull();
    expect(writeField(draft, hosts, "")).toBeNull();
    expect(getPath(draft, hosts.path)).toEqual([]);
  });

  test("the stored literal key: removed on the proxy, it is gone for hasStoredApiKey too", () => {
    const draft = live(API);
    expect(hasStoredApiKey(draft)).toBe(true);
    removeStoredApiKey(draft);
    expect(hasStoredApiKey(draft)).toBe(false);
  });

  // Final round 4 (delta nit): what this shows, and only that — the old `hasOwnProperty` reading passes it too (its
  // deleted key's value still compares unequal), so it is not the proxy trap's pin: `hasPath`'s tests above are.
  test("jsonEqual on a $state draft with a key deleted and another added: equal to the plain object with those keys, in either order, and not to the one it was loaded from", () => {
    const a = live(text({ x: 1, y: 2 }));
    delete a["y"];
    a["z"] = 3;
    expect(jsonEqual(parse(text({ x: 1, y: 2 })), a)).toBe(false);
    expect(jsonEqual(a, parse(text({ x: 1, z: 3 })))).toBe(true);
    expect(jsonEqual(parse(text({ x: 1, z: 3 })), a)).toBe(true);
  });
});

describe("the save decision (review round 1)", () => {
  test("W5: a live field error blocks the save; a hidden or disabled field's does not", () => {
    const draft = parse(FULL);
    expect(formSubmission(draft, FULL, { lookbackCapDays: "must be a number" })).toEqual({
      kind: "blocked",
      message: "Not saved: fix the marked fields first.",
    });
    expect(formSubmission(draft, FULL, { lookbackCapDays: "" }).kind).not.toBe("blocked");
    // An API-only field on a CLI config is hidden…
    expect(fieldIsLive(draft, field("provider.api.model"))).toBe(false);
    expect(formSubmission(draft, FULL, { "provider.api.model": "stale" }).kind).toBe("unchanged");
    // …and a defaultable list switched to the engine's default is disabled.
    useDefault(draft, field("networkProbeHosts"));
    expect(fieldIsLive(draft, field("networkProbeHosts"))).toBe(false);
    expect(liveErrors(draft, { networkProbeHosts: '"x" is not `host:port`' })).toEqual({});
    expect(formSubmission(draft, FULL, { networkProbeHosts: "bad" }).kind).toBe("save");
    useEmptyList(draft, field("networkProbeHosts"));
    expect(liveErrors(draft, { networkProbeHosts: "bad" })).toEqual({ networkProbeHosts: "bad" });
  });

  test("an untouched form saves nothing, even where JavaScript re-spells the file", () => {
    for (const text of [FULL, API]) {
      expect(formSubmission(parse(text), text, {})).toEqual({ kind: "unchanged" });
    }
    // Spellings JSON.stringify changes: 1.0, 5e1, -0, an integer-like key listed after others.
    const odd = '{\n  "lookbackCapDays": 7.0,\n  "x-a": 5e1,\n  "x-b": -0,\n  "zz": 1,\n  "42": "late"\n}';
    expect(JSON.stringify(parse(odd), null, 2)).not.toBe(odd);
    expect(formSubmission(parse(odd), odd, {})).toEqual({ kind: "unchanged" });
    // An edit is a save of the whole draft, as the raw tab would show it.
    const edited = parse(odd);
    writeField(edited, field("lookbackCapDays"), "6");
    expect(formSubmission(edited, odd, {})).toEqual({ kind: "save", text: rawFromDraft(edited) });
    // No loaded text to compare with: save.
    expect(formSubmission(parse(FULL), null, {}).kind).toBe("save");
  });

  test("W6: the raw tab shows exactly the draft — the key placeholder, never a key", () => {
    const draft = parse(API.replace("sk-ant-SENTINEL-DO-NOT-LEAK-0000", PLACEHOLDER));
    const raw = rawFromDraft(draft);
    expect(raw).toBe(JSON.stringify(draft, null, 2));
    expect(raw).toContain(PLACEHOLDER);
    expect(raw).not.toContain("SENTINEL");
    expect(JSON.parse(raw)).toEqual(draft);
  });

  test("W6 (round 2): the raw text keeps every key the form does not know, in place", () => {
    // config-api.json's keys are all form-known, so a raw text that dropped unknown keys passed
    // the test above. config-full.json carries `$comment`, `x-middle`, `zz-unicode`, an unknown key
    // inside `provider`, and `transcripts`, which is not a form field at all.
    const raw = rawFromDraft(parse(FULL));
    expect(raw).toBe(FULL);
    const back = parse(raw);
    for (const key of ["$comment", "x-middle", "zz-unicode", "transcripts"]) {
      expect({ key, kept: Object.prototype.hasOwnProperty.call(back, key) }).toEqual({ key, kept: true });
    }
    expect((back.provider as Draft)["x-provider-extra"]).toEqual({ kept: true });
    // And after an edit, too — the text a form save sends.
    const edited = parse(FULL);
    writeField(edited, field("lookbackCapDays"), "5");
    expect(rawFromDraft(edited)).toBe(FULL.replace('"lookbackCapDays": 7', '"lookbackCapDays": 5'));
  });

  test("JSON equality: order-free objects, value-equal numbers, nothing looser", () => {
    expect(jsonEqual(JSON.parse('{"a":1,"b":[1,2]}'), JSON.parse('{"b":[1.0,2],"a":1e0}'))).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: null })).toBe(false);
    expect(jsonEqual({ a: undefined }, { b: undefined })).toBe(false);
    expect(jsonEqual("1", 1)).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
    expect(jsonEqual([], {})).toBe(false);
  });

  test("an unsaved draft is kept across leaving the screen; a clean one is not", () => {
    const base: KeptSettings = { base: "b", loadedText: FULL, tab: "form", draft: parse(FULL), raw: FULL, errors: {} };
    expect(isDirty(base)).toBe(false);
    keepSettings(base);
    expect(takeKeptSettings()).toBeNull();

    const edited = parse(FULL);
    writeField(edited, field("lookbackCapDays"), "3");
    const dirty = { ...base, draft: edited, errors: { morningTime: "x" } };
    expect(isDirty(dirty)).toBe(true);
    keepSettings(dirty);
    expect(takeKeptSettings()).toEqual(dirty);
    expect(takeKeptSettings()).toBeNull(); // taken once

    // The raw tab: reformatted-but-equal is clean; changed or unparseable is dirty.
    const minified = JSON.stringify(parse(FULL));
    expect(isDirty({ ...base, tab: "raw", raw: minified })).toBe(false);
    expect(isDirty({ ...base, tab: "raw", raw: FULL.replace('"lookbackCapDays": 7', '"lookbackCapDays": 8') })).toBe(true);
    expect(isDirty({ ...base, tab: "raw", raw: "{ half-typed" })).toBe(true);
  });

  test("round 2 (V2): a draft kept while its own save was in flight is dropped when the save lands", () => {
    const edited = parse(FULL);
    writeField(edited, field("lookbackCapDays"), "3");
    const sentText = rawFromDraft(edited);
    const leftMidSave: KeptSettings = { base: "b1", loadedText: FULL, tab: "form", draft: edited, raw: FULL, errors: {} };
    const sent = { base: "b1", text: sentText };
    // Landed (or was already on disk): the kept draft IS the file now.
    expect(keptAfterSave(leftMidSave, sent, "saved")).toBeNull();
    expect(keptAfterSave(leftMidSave, sent, "unchanged")).toBeNull();
    // Did not land: still the user's unsaved edit.
    expect(keptAfterSave(leftMidSave, sent, "invalid")).toBe(leftMidSave);
    expect(keptAfterSave(leftMidSave, sent, "failed")).toBe(leftMidSave);
    // Another load's draft is not this save's business.
    expect(keptAfterSave(leftMidSave, { ...sent, base: "b0" }, "saved")).toBe(leftMidSave);
    // Typed after pressing Save: kept (its save will be refused as a conflict, and says so).
    const more = parse(sentText);
    writeField(more, field("morningTime"), "06:00");
    const typedOn = { ...leftMidSave, draft: more };
    expect(keptAfterSave(typedOn, sent, "saved")).toBe(typedOn);
    // The raw tab compares the raw text, as values (formatting is not a difference).
    const raw: KeptSettings = { ...leftMidSave, tab: "raw", draft: null, raw: JSON.stringify(parse(sentText)) };
    expect(keptAfterSave(raw, sent, "saved")).toBeNull();
    expect(keptAfterSave({ ...raw, raw: "{ half" }, sent, "saved")).not.toBeNull();
    expect(keptAfterSave(null, sent, "saved")).toBeNull();

    // The module state, as Settings.svelte drives it: unmounted mid-save, then the save lands.
    keepSettings(leftMidSave);
    settleKeptSettings(sent, "saved");
    expect(takeKeptSettings()).toBeNull();
    keepSettings(leftMidSave);
    settleKeptSettings(sent, "invalid");
    expect(takeKeptSettings()).toEqual(leftMidSave);
  });

  test("Settings.svelte settles the kept draft after every save it sends", () => {
    const svelte = codeOf(readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    expect(svelte).toContain("const sent = { base: doc.base, text };");
    // The save's own answer, inside `saveRemovingKeys`'s save step (provider-flows.ts): `answered` is set the moment
    // `configSave` answers, whatever the key steps after it do.
    expect(svelte).toContain("const saved = await configSave(text, sent.base); answered = saved.kind; return saved;");
    expect(svelte).toMatch(/\} finally \{ saving = false;[^}]*settleKeptSettings\(sent, answered\);/);
  });

  test("provider.timeoutMs is editable for both provider kinds", () => {
    for (const text of [FULL, API]) {
      const live = sectionsFor(parse(text)).flatMap((s) => s.fields.map((f) => f.id));
      expect(live.filter((id) => id === "provider.timeoutMs")).toHaveLength(1);
    }
    const draft = parse(API.replace("sk-ant-SENTINEL-DO-NOT-LEAK-0000", PLACEHOLDER));
    expect(writeField(draft, field("provider.timeoutMs"), "300000")).toBeNull();
    expect(getPath(draft, ["provider", "timeoutMs"])).toBe(300000);
    expect(formHtml(draft)).toContain('id="f-provider.timeoutMs"');
  });

  test("M1: the argument field says what init refuses and that this screen does not check it", () => {
    const argv = field("provider.argv");
    expect(argv.note).toBe(ARGV_NOTE);
    for (const words of ["--tools", "--settings", "daily-briefing init", "config validate", "without a warning"]) {
      expect(ARGV_NOTE).toContain(words);
    }
    expect(argv.quote?.source).toBe("src/harden.ts");
    // The flags named are the engine's INIT_REFUSED list, read from the source.
    const harden = readFileSync(`${ENGINE}src/harden.ts`, "utf8");
    const refused = /const INIT_REFUSED: readonly string\[\] = \[([^\]]*)\]/.exec(harden)?.[1] ?? "";
    expect(refused.split(",").map((f) => f.trim().replace(/"/g, ""))).toEqual(["--tools", "--settings"]);
    // Round 2 (V1): `init` refuses these with `harden: false` too — the note must not say otherwise.
    expect(ARGV_NOTE).not.toMatch(/provider\.harden|harden: ?false|unless/);
    const main = readFileSync(`${ENGINE}src/main.ts`, "utf8");
    expect(main).toContain("if (loaded.provider.api === undefined) {\n    try {\n      assertInitSafeArgv(loaded.provider.argv);");
    // The check's only input is the argv: it cannot see `harden`.
    expect(harden).toContain("export function assertInitSafeArgv(argv: readonly string[]): void {");
    // …although its refusal still names `harden: false` as the way out (deviation 62's Phase C
    // item). When the engine rewords it, this line goes red: update the deviation with it.
    expect(harden).toContain('remove it, or set "provider.harden": false to opt out of hardening deliberately');
    expect(formHtml(parse(FULL))).toContain("Leave out --tools and --settings");
  });
});

describe("the Quit dialog's notify offer (review round 1)", () => {
  const withNotify = (v: unknown) => JSON.stringify({ ...parse(FULL), notify: v }, null, 2);
  const without = (() => {
    const d = parse(FULL);
    delete d.notify;
    return JSON.stringify(d, null, 2);
  })();

  test("offered only where it changes something, as the engine reads the value", () => {
    expect(notifyOffer(withNotify("auto"))).toEqual({ kind: "already" });
    expect(notifyOffer(FULL)).toEqual({ kind: "custom" });
    expect(notifyOffer(withNotify("off"))).toEqual({ kind: "offer", current: "off" });
    expect(notifyOffer(without)).toEqual({ kind: "offer", current: "off" });
    expect(notifyOffer(withNotify(null))).toEqual({ kind: "offer", current: "off" });
    for (const bad of ["loud", { command: [] }, { command: [1] }, { cmd: ["x"] }, ["osascript"], 3]) {
      expect(isCustomNotify(bad)).toBe(false);
      expect(notifyOffer(withNotify(bad))).toEqual({ kind: "offer", current: "invalid" });
    }
    expect(notifyOffer(null)).toEqual({ kind: "unknown" });
    expect(notifyOffer("{ not json")).toEqual({ kind: "unknown" });
  });

  test("the button and the line for each state", () => {
    expect(offerTakeable({ kind: "offer", current: "off" })).toBe(true);
    expect(offerTakeable({ kind: "unknown" })).toBe(true);
    for (const kind of ["checking", "already", "custom"] as const) {
      expect(offerTakeable({ kind })).toBe(false);
      expect(offerNote({ kind })).not.toBeNull();
    }
    expect(offerNote({ kind: "offer", current: "off" })).toBeNull();
    expect(offerNote({ kind: "offer", current: "invalid" })).toContain("currently posts nothing");
    expect(offerNote({ kind: "unknown" })).toBeNull();
  });
});

describe("SaveReport.svelte", () => {
  const report = (outcome: SaveOutcome | null, failure = "") =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(SaveReport as any, { props: { outcome, failure } })
      .body.replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, " ");

  test("errors and warnings are shown distinctly", () => {
    const body = report({
      kind: "invalid",
      errors: [{ field: "lookbackCapDays", message: 'config error: "lookbackCapDays" must be a number, not "4"' }],
      warnings: [{ field: "morningTime", message: `invalid morningTime "25:99" — using the default 07:20 ${HOSTILE}` }],
    });
    const errors = /<div class="report errors[^"]*">([\s\S]*?)<\/div>/.exec(body)?.[1] ?? "";
    const warnings = /<div class="report warnings[^"]*">([\s\S]*?)<\/div>/.exec(body)?.[1] ?? "";
    expect(errors).toContain("Not saved");
    expect(errors).toContain("must be a number");
    // Post-cap (visual LOW 4, pre-existing on main): a space between the field and its message, in both lists (the
    // space inside `{#if}` was trimmed at the block's end: "lookbackCapDaysconfig error").
    expect(errors).toContain("<code>lookbackCapDays</code> config error");
    expect(warnings).toContain("<code>morningTime</code> invalid morningTime");
    expect(errors).not.toContain("morningTime");
    expect(warnings).toContain("do not block saving");
    expect(warnings).toContain("using the default 07:20");
    expect(warnings).not.toContain("lookbackCapDays");
    expect(body).not.toContain("<img");
  });

  test("a save with warnings says it saved; unchanged and refusals have their own lines", () => {
    const saved = report({
      kind: "saved",
      path: "/c/config.json",
      backupPath: "/c/config.json.bak",
      warnings: [{ field: "morningTime", message: "degraded" }],
    });
    expect(saved).toContain("Saved to /c/config.json");
    expect(saved).toContain("/c/config.json.bak");
    expect(saved).toContain("Saved with warnings");
    expect(saved).not.toContain("report errors");
    expect(report({ kind: "unchanged", path: "/c" })).toContain("Nothing changed, so nothing was written.");
    const refused = report(null, describeFailure({ kind: "transcriptsChanged" }));
    expect(refused).toContain("transcripts setting cannot be changed from this app");
    expect(refused).toContain("report failure");
    const keyChanged = describeFailure({ kind: "apiKeyChanged" });
    expect(keyChanged).toContain("cannot be set or changed from this app");
    // P3-M2-T1 checkpoint: the refusal also covers an owner change, an endpoint change and a shared name, and
    // names no single slot (`provider.api`) — the guard covers every `apiKey` slot.
    // Redesign D final round 1 (M6): the endpoint is named as the form names it, "Address" (with the kind of API).
    expect(keyChanged).toContain("cannot move to another provider, to another kind of API, or to another address (host or port)");
    expect(keyChanged).not.toMatch(/endpoint/i);
    expect(keyChanged).toContain("whose name another provider also uses");
    expect(keyChanged).not.toContain("provider.api");
    // Checkpoint P3-M6 (carried item C): no platform's store named — this line has no OS in reach.
    expect(keyChanged).not.toContain("Keychain");
    // PR 3 final r4 (H6): a key typed in (only the draft holds it) gets no Move button; the advice is the draft-only
    // banner's (`literalDraftBanner`): remove it in the JSON editor, then Replace key. (D-M5-T9: the editor is named
    // by the button that opens it and its page.)
    expect(keyChanged).toContain("A key the saved settings already hold: move it to the app's key store first (the provider's Move this key button), or remove it.");
    expect(keyChanged).toContain("A key typed in here: remove it with Edit settings as JSON on Settings → Advanced (or discard your changes), then give the provider its key with Replace key.");
    // PR 3 final r5 (B4 = H7): Replace key needs a SAVED entry; one not saved yet has two ways that work.
    expect(keyChanged).toContain(
      "For a provider not saved yet, Replace key is not offered: save it without the key first, or remove it and add it with Add a provider, which takes a pasted key.",
    );
    expect(describeFailure({ kind: "conflict", path: "/c" })).toContain("changed on disk after it was loaded");
    expect(describeFailure({ kind: "noConfig", path: "/c" })).toContain("daily-briefing init");
  });
});

/* ── P3-M4-T1: "Providers, in order" — the list, row statuses, Reset, the judge line, the save gate, the copy ── */

/** PR 2's scrub sentinel, from the engine↔app contract (`docs/gui-seam.md` §1d) — not from `src/providerCli.ts`,
 *  which reaches the scheduler installer (the `provider-list.check.ts` precedent). */
const DOC_KEY_MOVED_ENV = (() => {
  const src = readFileSync(new URL("../../docs/gui-seam.md", import.meta.url), "utf8");
  const m = /`apiKeyEnv: "([A-Z_]+)"`, a variable nothing sets/.exec(src);
  if (m === null) throw new Error("the scrub sentinel is not named in docs/gui-seam.md");
  return m[1]!;
})();

const ENGINE_MAIN = `${ENGINE}src/main.ts`;

/** A fully sandboxed engine (the `coexistence.check.ts` shape): scratch HOME, config, state and unit dirs, a
 *  replacement env (no ANTHROPIC_API_KEY, no CLAUDE_CONFIG_DIR unless given), UTC. Nothing real is read or written. */
function engineSandbox(extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "dba-p3m4t1-"));
  const home = join(root, "home");
  const config = join(root, "config");
  const state = join(root, "state");
  const units = join(root, "units");
  for (const d of [home, join(config, "daily-briefing"), state, units]) mkdirSync(d, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: config,
    DAILY_BRIEFING_STATE_DIR: state,
    DBA_TEST_UNIT_DIR: units,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TZ: "UTC",
    ...extraEnv,
  };
  const run = (args: string[]): { code: number; stdout: string; stderr: string } => {
    const p = Bun.spawnSync(["bun", ENGINE_MAIN, ...args], { cwd: ENGINE, env, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  };
  return {
    state,
    saveConfig: (text: string) => writeFileSync(join(config, "daily-briefing", "config.json"), text),
    status: (): unknown => JSON.parse(run(["status", "--json"]).stdout) as unknown,
    /** `config validate --json --file <candidate>` — the report the save gate reads (through Rust, in the app). */
    validate: (text: string): ConfigValidateReport => {
      const file = join(root, "candidate.json");
      writeFileSync(file, text);
      return JSON.parse(run(["config", "validate", "--json", "--file", file]).stdout) as ConfigValidateReport;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const CLAUDE_CLI = { cli: "claude", argv: ["-p"], promptVia: "stdin" };
const cfgText = (v: Draft): string => JSON.stringify(v, null, 2);
const validated = (report: ConfigValidateReport): CheckOutcome => ({ kind: "validated", report });
const NOW = new Date("2026-10-18T12:00:00Z");
const view = (input: Parameters<typeof providersView>[0]): Extract<ProvidersView, { readable: true }> => {
  const v = providersView(input);
  if (!v.readable) throw new Error(`unreadable: ${v.message}`);
  return v;
};
/** The list as `readProviderList` reads it (a refusal is a fixture bug). */
const entriesOf = (d: Draft) => {
  const r = readProviderList(d);
  if (!r.ok) throw new Error(`unreadable: ${r.reason}`);
  return r.entries;
};
const rowOf = (v: Extract<ProvidersView, { readable: true }>, label: string) => {
  const r = v.rows.find((x) => x.label === label);
  if (r === undefined) throw new Error(`no row ${label}`);
  return r;
};
const statusRow = (index: number, label: string, kind: string, status: StatusProviderRow["status"]): StatusProviderRow => ({
  index,
  label,
  kind,
  status,
  ...(status.kind === "invalid" ? {} : { revision: `rev-${index}` }),
});

describe("P3-M4-T1: the accounts field is replaced by the providers list", () => {
  test("no \"Failover accounts\" field; the form draws \"Providers, in order\" with every entry, in order", () => {
    expect(SECTIONS.flatMap((s) => s.fields).some((f) => f.path.join(".") === "provider.accounts")).toBe(false);
    const draft = parse(FULL);
    const body = formHtml(draft);
    expect(body).not.toContain("Failover accounts");
    expect(body).toContain(PROVIDERS_TITLE);
    expect(PROVIDERS_TITLE).toBe("Providers, in order");
    expect(body.indexOf(">primary<")).toBeGreaterThan(0);
    expect(body.indexOf(">primary<")).toBeLessThan(body.indexOf(">backup<"));
    // An untouched form still writes nothing (the list is read, never rewritten, until an edit).
    expect(formSubmission(draft, FULL, {})).toEqual({ kind: "unchanged" });
  });

  test("remove and the login folder edit the list through the list writer; nothing renames", () => {
    // A login's folder: the second login's own changes in place in a fresh draft — but compaction KEEPS (hub, checkpoint
    // P3-M3): a login stays in `accounts` only on the folder it was read with, so a changed one becomes a `fallbacks`
    // block (item 1's settings with it), and a login after a changed item 1 does too. Written out by hand.
    const second = parse(FULL);
    expect(setLoginFolder(second, "backup", "~/.other")).toBeNull();
    expect(getPath(second, ["provider", "accounts"])).toEqual([{ label: "primary" }]);
    const block = { cli: "claude", argv: ["-p", "--model", "sonnet"], promptVia: "stdin", timeoutMs: 600000, harden: true, credential: "subscription", "x-provider-extra": { kept: true } };
    expect(second.fallbacks).toEqual([{ label: "backup", configDir: "~/.other", ...block }]);
    const draft = parse(FULL);
    expect(setLoginFolder(draft, "primary", "~/.claude-main")).toBeNull();
    expect(getPath(draft, ["provider", "accounts"])).toEqual([{ label: "primary", configDir: "~/.claude-main" }]);
    expect(draft.fallbacks).toEqual([{ label: "backup", configDir: "~/.claude-backup", ...block }]);
    // Blank removes the folder (the tool's own login).
    expect(setLoginFolder(draft, "primary", "  ")).toBeNull();
    expect(getPath(draft, ["provider", "accounts"])).toEqual([{ label: "primary" }]);
    expect(removeProvider(draft, "backup")).toBeNull();
    expect(getPath(draft, ["provider", "accounts"])).toEqual([{ label: "primary" }]);
    expect(hasPath(draft, ["fallbacks"])).toBe(false);
    // The last provider cannot go, and the draft is unchanged by a refusal.
    const before = out(draft);
    expect(removeProvider(draft, "primary")).toContain("at least one provider");
    expect(out(draft)).toBe(before);
    // Everything else in the config survives a list edit, key order included.
    expect(Object.keys(draft)).toEqual(Object.keys(parse(FULL)));
    expect((draft.provider as Draft)["x-provider-extra"]).toEqual({ kept: true });
  });

  test("a move that would shift a stored literal key is refused and changes nothing", () => {
    const saved = cfgText({
      provider: CLAUDE_CLI,
      fallbacks: [
        { label: "Anthropic key", api: { kind: "anthropic", model: "m", apiKey: REDACTED_API_KEY } },
        { label: "Local", api: { kind: "openai-compatible", model: "l", baseUrl: "http://127.0.0.1:11434/v1" } },
      ],
    });
    const draft = parse(saved);
    expect(moveProvider(draft, 2, 1)).toContain("Move the key to the Keychain first");
    expect(moveProvider(draft, 2, 1, "macos")).toBe(moveProvider(draft, 2, 1));
    // Checkpoint P3-M6 (carried item C): the platform's own store elsewhere, never "Keychain".
    for (const os of ["linux", "windows"] as const) {
      const said = moveProvider(draft, 2, 1, os);
      expect({ os, said }).toEqual({ os, said: '"Anthropic key" has an API key stored in the settings file, and that key cannot change its place in the list. Move the key to the key folder first.'.replace(/^/, "Not changed: ") });
      // A removal that shifts the literal is refused the same way, and says the same store.
      const shifted = parse(cfgText({ provider: CLAUDE_CLI, fallbacks: [{ label: "Local", api: { kind: "openai-compatible", model: "l", baseUrl: "http://127.0.0.1:11434/v1" } }, { label: "Anthropic key", api: { kind: "anthropic", model: "m", apiKey: REDACTED_API_KEY } }] }));
      expect({ os, said: removeProvider(shifted, "Local", os) }).toEqual({ os, said: said });
      expect(removeProvider(shifted, "Local")).toContain("Move the key to the Keychain first");
    }
    expect(out(draft)).toBe(out(parse(saved)));
    // A move that leaves the literal where it is goes through.
    expect(moveProvider(draft, 0, 0)).toBeNull();
  });
});

describe("P3-M4-T1: row statuses — the engine's rows, through `status --json`", () => {
  test("a dropped entry reads \"invalid\", with a remedy (a real `status --json`, sandboxed)", () => {
    const sb = engineSandbox();
    try {
      const text = cfgText({
        repos: ["/nonexistent/repo"],
        provider: CLAUDE_CLI,
        fallbacks: [{ label: "Codex", cli: "codex", argv: ["exec"], promptVia: "stdin", configDir: "~/.codex-b" }],
        networkProbeHosts: [],
      });
      sb.saveConfig(text);
      const rows = parseStatusProviders(sb.status());
      expect(rows?.map((r) => [r.index, r.kind])).toEqual([[0, "cli"], [1, "invalid"]]);
      const row = rowOf(view({ draft: parse(text), savedText: text, rows, now: NOW }), "Codex");
      expect(row.status.text.startsWith("invalid: ")).toBe(true);
      expect(row.status.text).toContain("configDir");
      expect(row.status.remedy).toContain("remove it");
      expect(row.status.tone).toBe("bad");
    } finally {
      sb.cleanup();
    }
  });

  test("a failed Test with no run reads \"not working since\" (the engine's own record, through `status --json`)", () => {
    const sb = engineSandbox();
    try {
      const text = cfgText({
        repos: ["/nonexistent/repo"],
        provider: CLAUDE_CLI,
        fallbacks: [{ label: "Anthropic key", api: { kind: "anthropic", model: "m", apiKeyEnv: "DBA_NO_SUCH_KEY" } }],
        networkProbeHosts: [],
      });
      sb.saveConfig(text);
      const first = parseStatusProviders(sb.status());
      const revision = first?.[1]?.revision;
      expect(typeof revision).toBe("string");
      expect(first?.[1]?.status).toEqual({ kind: "not-tested" });
      const at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      writeFileSync(
        join(sb.state, "provider-status.json"),
        JSON.stringify({
          labels: {
            "Anthropic key": {
              revision,
              lastTest: { at, revision, ok: false, reason: "auth" },
              failingSince: { at, revision },
            },
          },
        }),
      );
      const rows = parseStatusProviders(sb.status());
      expect(rows?.[1]?.status).toEqual({ kind: "not-working", since: at, reason: "auth" });
      const row = rowOf(view({ draft: parse(text), savedText: text, rows, now: new Date() }), "Anthropic key");
      expect(row.status.text.startsWith("not working since ")).toBe(true);
      expect(row.status.text.endsWith(": key or login rejected")).toBe(true);
      expect(row.status.remedy).toBe(remedyFor("auth"));
    } finally {
      sb.cleanup();
    }
  });

  test("row-status precedence: the engine's (rowStatus), then the app's own — invalid, key moved, not saved yet", () => {
    const rev = "r1";
    const at = (h: number) => new Date(Date.UTC(2026, 9, 18, h)).toISOString();
    const failedTest = { lastTest: { at: at(10), revision: rev, ok: false, reason: "auth" as const }, failingSince: { at: at(10), revision: rev } };
    const usage = { entry: { label: "x" }, reason: "usage" as const, until: at(15) };
    const hour = { entry: { label: "x" }, reason: "auth" as const, until: at(13) };
    const e = { label: "x", revision: rev };
    const line = (s: ReturnType<typeof rowStatus>) => statusLine(s, NOW).text;
    // The engine decides the order; the app words what it decided.
    expect(line(rowStatus(e, failedTest, [usage, hour], NOW))).toBe("out of usage until 15:00");
    expect(line(rowStatus(e, failedTest, [hour], NOW))).toBe("paused until 13:00 after key or login rejected");
    expect(line(rowStatus(e, failedTest, [], NOW))).toBe("not working since 10:00: key or login rejected");
    expect(line(rowStatus(e, { ...failedTest, lastRun: { at: at(11), revision: rev, ok: true } }, [], NOW))).toBe("working");
    expect(line(rowStatus(e, { lastTest: { at: at(9), revision: rev, ok: true } }, [], NOW))).toBe("key accepted");
    expect(line(rowStatus(e, { lastTest: { at: at(9), revision: "older", ok: false, reason: "auth" } }, [], NOW))).toBe("not tested");
    expect(line({ kind: "paused", until: at(13), reason: "earlier-failure" })).toBe("paused until 13:00 after earlier failures");
    expect(statusLine({ kind: "out-of-usage", until: at(9 + 24 * 2) }, NOW).text).toBe("out of usage until Tue 09:00");

    // The app's own layer, over the engine's rows: invalid (a dropped entry) first, then a key the engine says was
    // moved out (the SAVED config's `config validate` row, `keyMoved`), then an entry the saved config does not hold
    // yet; an edited entry keeps its row's status and says it is unsaved.
    const saved = cfgText({
      provider: CLAUDE_CLI,
      fallbacks: [
        { label: "Broken", cli: "codex", argv: ["exec"], promptVia: "stdin", configDir: "~/.c" },
        { label: "Moved", api: { kind: "anthropic", model: "m", apiKeyEnv: DOC_KEY_MOVED_ENV } },
        { label: "Edited", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } },
      ],
    });
    const sb = engineSandbox();
    let validateRows: ProviderValidateRow[];
    try {
      validateRows = sb.validate(saved).providers;
    } finally {
      sb.cleanup();
    }
    // The engine's rows: the dropped entry has none (its place kept); only "Moved" says keyMoved.
    expect(validateRows.map((r) => [r.index, r.keyMoved])).toEqual([[0, false], [2, true], [3, false]]);
    const rows = [
      statusRow(0, "default", "cli", { kind: "working", at: at(8) }),
      statusRow(1, "Broken", "invalid", { kind: "invalid", reason: 'fallbacks[0] "Broken": "configDir" applies to a Claude CLI entry only' }),
      statusRow(2, "Moved", "anthropic", { kind: "not-working", since: at(7), reason: "key-unavailable" }),
      statusRow(3, "Edited", "anthropic", { kind: "key-accepted", at: at(9) }),
    ];
    const draft = parse(saved);
    ((draft.fallbacks as Draft[])[2]!.api as Draft).model = "m2";
    const fresh = writeProviderList(draft, insertEntry(entriesOf(draft), 4, { label: "New", block: { api: { kind: "anthropic", model: "m", apiKeyEnv: "N" } } }));
    if (!fresh.ok) throw new Error("insert refused");
    const v = view({ draft: fresh.config, savedText: saved, rows, now: NOW, validateRows });
    expect(rowOf(v, "default").status.text).toBe("working");
    expect(rowOf(v, "Broken").status.text.startsWith("invalid: ")).toBe(true);
    expect(rowOf(v, "Moved").status.text).toBe(KEY_MOVED_LINE);
    expect(rowOf(v, "Edited").status.text).toBe("key accepted");
    expect(rowOf(v, "Edited").notes.join(" ")).toContain("not saved yet");
    expect(rowOf(v, "New").status.text).toBe("not saved yet");
    expect(rowOf(v, "default").notes).toEqual([]);
  });

  // P3-M4-T2 checkpoint: the app no longer spells the scrub sentinel. "key moved — add a key" is read from the SAVED
  // config's `config validate` row (`keyMoved`, gui-seam §1d), never matched in the entry's text.
  test("\"key moved\" is the engine's answer: shown only when the saved entry's validate row says keyMoved: true", () => {
    const saved = cfgText({
      provider: CLAUDE_CLI,
      fallbacks: [
        { label: "Moved", api: { kind: "anthropic", model: "m", apiKeyEnv: DOC_KEY_MOVED_ENV } },
        { label: "Env", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } },
      ],
    });
    const sb = engineSandbox();
    let real: ProviderValidateRow[];
    try {
      real = sb.validate(saved).providers;
    } finally {
      sb.cleanup();
    }
    expect(real.map((r) => [r.index, r.keyMoved])).toEqual([[0, false], [1, true], [2, false]]);
    const statusRows = [
      statusRow(0, "default", "cli", { kind: "working", at: NOW.toISOString() }),
      statusRow(1, "Moved", "anthropic", { kind: "not-tested" }),
      statusRow(2, "Env", "anthropic", { kind: "not-tested" }),
    ];
    const draft = parse(saved);
    const at = (validateRows: ProviderValidateRow[] | null, rows: StatusProviderRow[] | null = statusRows, d: Draft = draft) =>
      view({ draft: d, savedText: saved, rows, now: NOW, validateRows });

    // The engine's rows say so: key moved, a remedy, and Test waits for a key.
    const moved = rowOf(at(real), "Moved");
    // PR 3 final r5 (H9): the control that gives it a key is Replace key, so the words name it.
    expect(moved.status).toEqual({ text: KEY_MOVED_LINE, remedy: "Its key was removed from the settings file. Give it a key with Replace key.", tone: "bad" });
    expect(moved.test).toEqual({ text: "Test", enabled: false, why: "Give it a key with Replace key first." });
    expect(rowOf(at(real), "Env").status.text).toBe("not tested");
    // Even with no `status --json` rows, the saved config's validate row is enough.
    expect(rowOf(at(real, null), "Moved").status.text).toBe(KEY_MOVED_LINE);

    // The sentinel still in the entry's text, but rows that say false: the plain status, and Test is offered.
    const notMoved = rowOf(at(real.map((r) => ({ ...r, keyMoved: false }))), "Moved");
    expect(notMoved.status.text).toBe("not tested");
    expect(notMoved.test.enabled).toBe(true);
    // No validate rows (unread, or the check failed), or none for that entry: never "key moved".
    expect(rowOf(at(null), "Moved").status.text).toBe("not tested");
    expect(rowOf(at(null), "Moved").test.enabled).toBe(true);
    expect(rowOf(at(null, null), "Moved").status.text).toBe("status unknown");
    expect(rowOf(at(real.filter((r) => r.index !== 1)), "Moved").status.text).toBe("not tested");
    expect(rowOf(view({ draft, savedText: saved, rows: statusRows, now: NOW }), "Moved").status.text).toBe("not tested");

    // The row, not the text, decides: a row saying keyMoved on an entry with an ordinary apiKeyEnv shows it.
    expect(rowOf(at(real.map((r) => ({ ...r, keyMoved: r.index === 2 }))), "Env").status.text).toBe(KEY_MOVED_LINE);
    // A NEW entry carrying the sentinel has no saved row: "not saved yet", as any unsaved entry.
    const added = writeProviderList(parse(saved), insertEntry(entriesOf(parse(saved)), 3, { label: "New", block: { api: { kind: "anthropic", model: "m", apiKeyEnv: DOC_KEY_MOVED_ENV } } }));
    if (!added.ok) throw new Error("insert refused");
    expect(rowOf(at(real, statusRows, added.config), "New").status.text).toBe("not saved yet");
    // An edited saved entry: the status is still the saved settings' (with the unsaved note), but its Test — of the
    // DRAFT — is offered: the engine has not answered for the edit.
    const edited = parse(saved);
    ((edited.fallbacks as Draft[])[0]!.api as Draft).apiKeyEnv = "NEW_KEY";
    const e = rowOf(at(real, statusRows, edited), "Moved");
    expect(e.status.text).toBe(KEY_MOVED_LINE);
    expect(e.notes.join(" ")).toContain("not saved yet");
    expect(e.test.enabled).toBe(true);
  });

  // PR 3 final r1 (C1, mutant M21): `keyMoved` is joined to the SAVED list by the saved index, never the draft's. An
  // entry inserted or moved ABOVE the moved one shifts every draft index below it; the line stays on its entry.
  test("\"key moved\" stays on its entry when the draft inserts or moves an entry above it", () => {
    const saved = cfgText({
      provider: CLAUDE_CLI,
      fallbacks: [
        { label: "Moved", api: { kind: "anthropic", model: "m", apiKeyEnv: DOC_KEY_MOVED_ENV } },
        { label: "Env", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } },
      ],
    });
    const sb = engineSandbox();
    let real: ProviderValidateRow[];
    try {
      real = sb.validate(saved).providers;
    } finally {
      sb.cleanup();
    }
    expect(real.map((r) => [r.index, r.keyMoved])).toEqual([[0, false], [1, true], [2, false]]);
    const statusRows = [
      statusRow(0, "default", "cli", { kind: "working", at: NOW.toISOString() }),
      statusRow(1, "Moved", "anthropic", { kind: "not-tested" }),
      statusRow(2, "Env", "anthropic", { kind: "not-tested" }),
    ];
    const inserted = writeProviderList(parse(saved), insertEntry(entriesOf(parse(saved)), 1, { label: "New", block: { api: { kind: "anthropic", model: "m", apiKeyEnv: "N" } } }));
    if (!inserted.ok) throw new Error("insert refused");
    const moved = parse(saved);
    expect(moveProvider(moved, 2, 1)).toBeNull();
    for (const [name, draft, order] of [
      ["inserted above", inserted.config, ["default", "New", "Moved", "Env"]],
      ["moved above", moved, ["default", "Env", "Moved"]],
    ] as const) {
      const v = view({ draft, savedText: saved, rows: statusRows, now: NOW, validateRows: real });
      expect({ name, order: v.rows.map((r) => r.label) }).toEqual({ name, order: [...order] });
      const m = rowOf(v, "Moved");
      expect({ name, draftIndex: m.draftIndex, savedIndex: m.savedIndex }).toEqual({ name, draftIndex: 2, savedIndex: 1 });
      expect({ name, status: m.status.text, test: m.test }).toEqual({ name, status: KEY_MOVED_LINE, test: { text: "Test", enabled: false, why: "Give it a key with Replace key first." } });
      // Every other row keeps its own answer: no "key moved", and its Test offered.
      for (const other of v.rows.filter((r) => r.label !== "Moved")) {
        expect({ name, label: other.label, moved: other.status.text === KEY_MOVED_LINE, test: other.test.enabled }).toEqual({ name, label: other.label, moved: false, test: true });
      }
      expect({ name, env: rowOf(v, "Env").status.text }).toEqual({ name, env: "not tested" });
    }
  });

  test("rows are joined by index only when the engine's rows match the saved list; otherwise none is", () => {
    // A structurally broken `accounts` (two logins on one directory) gives ONE engine row for item 1's logins
    // (gui-seam §1): joining by index would show one login's status on another.
    const saved = cfgText({ provider: { ...CLAUDE_CLI, accounts: [{ label: "a", configDir: "~/.x" }, { label: "b", configDir: "~/.x" }] } });
    const rows = [statusRow(0, "default", "cli", { kind: "working", at: NOW.toISOString() })];
    const v = view({ draft: parse(saved), savedText: saved, rows, now: NOW });
    expect(v.note).toContain("cannot be shown");
    for (const r of v.rows) {
      expect(r.status.text).toBe("status unknown");
      expect(r.reset?.enabled).toBe(false);
    }
    // A row of another kind at an index is not this entry's either.
    const one = cfgText({ provider: CLAUDE_CLI });
    expect(view({ draft: parse(one), savedText: one, rows: [statusRow(0, "default", "anthropic", { kind: "working", at: NOW.toISOString() })], now: NOW }).note).toContain("cannot be shown");
    // Malformed rows are refused whole.
    expect(parseStatusProviders({ providers: [{ index: 0, label: "x", kind: "cli", status: { kind: "nope" } }] })).toBeNull();
    expect(parseStatusProviders({})).toBeNull();
    expect(parseStatusProviders({ providers: [] })).toEqual([]);
  });
});

describe("P3-M4-T1: Reset and Migrate use the SAVED order, so they wait for unsaved list edits", () => {
  const saved = cfgText({
    provider: CLAUDE_CLI,
    fallbacks: [
      { label: "Literal", api: { kind: "anthropic", model: "m", apiKey: REDACTED_API_KEY } },
      { label: "Extra", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } },
    ],
  });
  const rows = [
    statusRow(0, "default", "cli", { kind: "not-tested" }),
    statusRow(1, "Literal", "anthropic", { kind: "not-tested" }),
    statusRow(2, "Extra", "anthropic", { kind: "not-tested" }),
  ];

  test("enabled on a clean list, each with its saved index", () => {
    const v = view({ draft: parse(saved), savedText: saved, rows, now: NOW });
    expect(v.dirty).toBe(false);
    expect(rowOf(v, "Extra").reset).toEqual({ enabled: true, why: null });
    expect(rowOf(v, "Extra").savedIndex).toBe(2);
    expect(rowOf(v, "Literal").migrate).toEqual({ enabled: true, why: null, text: "Move this key to the Keychain" });
    expect(rowOf(v, "Extra").migrate).toBeNull();
    // An edit outside the list does not make the list dirty.
    const other = parse(saved);
    other.lookbackCapDays = 3;
    expect(view({ draft: other, savedText: saved, rows, now: NOW }).dirty).toBe(false);
  });

  test("disabled while the list has unsaved edits, saying why; Test still runs (it tests the candidate)", () => {
    const draft = parse(saved);
    expect(removeProvider(draft, "Extra")).toBeNull();
    const v = view({ draft, savedText: saved, rows, now: NOW });
    expect(v.dirty).toBe(true);
    for (const label of ["default", "Literal"]) {
      expect(rowOf(v, label).reset?.enabled).toBe(false);
      expect(rowOf(v, label).reset?.why).toContain("Save or discard");
    }
    expect(rowOf(v, "Literal").migrate?.enabled).toBe(false);
    expect(rowOf(v, "Literal").migrate?.why).toContain("Save or discard");
    expect(rowOf(v, "default").test.enabled).toBe(true);
    // A change to `provider` alone — a reorder of item 1's logins — is a list edit too.
    const logins = cfgText({ provider: { ...CLAUDE_CLI, accounts: [{ label: "a" }, { label: "b", configDir: "~/.b" }] } });
    const swapped = parse(logins);
    expect(moveProvider(swapped, 1, 0)).toBeNull();
    expect(hasPath(swapped, ["fallbacks"])).toBe(false);
    const loginRows = [statusRow(0, "a", "cli", { kind: "not-tested" }), statusRow(1, "b", "cli", { kind: "not-tested" })];
    const sv = view({ draft: swapped, savedText: logins, rows: loginRows, now: NOW });
    expect(sv.dirty).toBe(true);
    expect(rowOf(sv, "a").reset?.enabled).toBe(false);
    // A literal-key entry is not tested until its key is moved (the app never holds the literal, spec §6).
    expect(rowOf(v, "Literal").test.enabled).toBe(false);
    // An entry the saved config does not hold has no saved index: no Reset at all.
    const added = writeProviderList(parse(saved), insertEntry(entriesOf(parse(saved)), 3, { label: "New", block: { ...CLAUDE_CLI } }));
    if (!added.ok) throw new Error("insert refused");
    expect(rowOf(view({ draft: added.config, savedText: saved, rows, now: NOW }), "New").reset).toBeNull();
  });
});

describe("P3-M4-T1: the judge line", () => {
  test("shown for a save that changes `provider` or its logins, including a compaction; not for anything else", () => {
    expect(JUDGE_LINE).toBe("The audit judge follows your first provider and its logins.");
    const edited = parse(FULL);
    writeField(edited, field("lookbackCapDays"), "3");
    expect(judgeLineFor(FULL, out(edited))).toBeNull();
    // A fallback alone is not the judge's.
    const withFallback = parse(FULL);
    withFallback.fallbacks = [{ label: "Local", api: { kind: "openai-compatible", model: "l", baseUrl: "http://127.0.0.1:1/v1" } }];
    const savedWithFallback = out(withFallback);
    const fb = parse(savedWithFallback);
    ((fb.fallbacks as Draft[])[0]!.api as Draft).model = "l2";
    expect(judgeLineFor(savedWithFallback, out(fb))).toBeNull();
    // A reorder of the logins is.
    const swapped = parse(FULL);
    expect(moveProvider(swapped, 1, 0)).toBeNull();
    expect(judgeLineFor(FULL, out(swapped))).toBe(JUDGE_LINE);
    // A compaction that moves a login out of `accounts` (below a fallback) is.
    const compacted = parse(savedWithFallback);
    expect(moveProvider(compacted, 1, 2)).toBeNull();
    expect(getPath(compacted, ["provider", "accounts"])).toEqual([{ label: "primary" }]);
    expect((compacted.fallbacks as Draft[]).map((f) => f.label)).toEqual(["Local", "backup"]);
    expect(judgeLineFor(savedWithFallback, out(compacted))).toBe(JUDGE_LINE);
    // An item-1 setting edited in the form is too.
    const argv = parse(FULL);
    writeField(argv, field("provider.argv"), "-p");
    expect(judgeLineFor(FULL, out(argv))).toBe(JUDGE_LINE);
  });

  test("Settings.svelte shows it only after a save that landed", () => {
    const svelte = codeOf(readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    expect(svelte).toContain("const judge = judgeLineFor(doc.text, text);");
    expect(svelte).toContain('if (result.kind === "saved") { void onconfigsaved(); judgeLine = judge;');
    // Redesign D (D-M4-T8): the line is drawn in the save bar's outcome area, which the shell hands it.
    const bar = codeOf(readFileSync(new URL("../src/lib/settings/SaveBar.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    expect(bar).toMatch(/\{#if judgeLine !== null\} <p class="muted judge">\{judgeLine\}<\/p> \{\/if\}/);
    expect(svelte).toContain("{judgeLine}");
  });
});

describe("P3-M4-T1: the save gate — refused only for a STRUCTURAL `provider.accounts` warning (Q4)", () => {
  test("two logins on one directory: a hand edit is flagged STRUCTURALLY and the gate refuses; the form's edit is an ERROR", () => {
    const sb = engineSandbox();
    try {
      // Hand-written (the raw tab, or the file): `accounts` itself is broken — the engine warns, it does not error,
      // so without the gate this would save.
      const hand = parse(FULL);
      delete ((hand.provider as Draft).accounts as Draft[])[1]!.configDir;
      const report = sb.validate(out(hand));
      expect(report.valid).toBe(true);
      expect(report.providers).toEqual([]);
      const gate = saveGate(validated(report));
      expect(gate.kind).toBe("refuse");
      expect(gate.kind === "refuse" ? gate.message : "").toContain("two accounts pointing at the same login directory");
      // The same collision made in the editor (a login's folder set to the other's): compaction makes the changed
      // login a `fallbacks` block, which the engine reports as an ERROR (a duplicate login, dropped) — refused by the
      // save path itself, so the gate has nothing to add.
      const draft = parse(FULL);
      expect(setLoginFolder(draft, "primary", "~/.claude-backup")).toBeNull();
      const edited = sb.validate(out(draft));
      expect(edited.valid).toBe(false);
      expect(edited.errors.map((e) => e.message).join(" ")).toContain("is the same Claude login");
      expect(saveGate(validated(edited))).toEqual({ kind: "allow" });
    } finally {
      sb.cleanup();
    }
  });

  test("a valid list with ADVISORY warnings saves: an unlogged login folder, an ambient CLAUDE_CONFIG_DIR", () => {
    const sb = engineSandbox({ CLAUDE_CONFIG_DIR: "/nonexistent/ambient" });
    try {
      const report = sb.validate(FULL);
      const accounts = report.warnings.filter((w) => w.field === "provider.accounts").map((w) => w.message);
      expect(accounts.some((m) => m.includes("has never been logged in"))).toBe(true);
      expect(report.warnings.some((w) => w.message.includes("CLAUDE_CONFIG_DIR is set in the environment"))).toBe(true);
      expect(report.providers.length).toBe(2);
      expect(saveGate(validated(report))).toEqual({ kind: "allow" });
    } finally {
      sb.cleanup();
    }
  });

  test("a codex entry with a login folder cannot be moved to item 1: the list writer blocks it, in words (was a KNOWN GAP)", () => {
    // Checkpoint P3-M3 left two collisions to this gate. `config validate` reports the first (above) structurally; this
    // one, as item 1, it reports only as the ADVISORY "never been logged in" warning, so the gate would let it save. As a
    // fallback the same entry is a validate ERROR (dropped as `config-dir`). Plan hub "(BUILD, P3-M4-T1, 2026-10-18)
    // Decided" (2): the engine keeps it advisory (requirement 9), and the LIST WRITER refuses the move
    // (`config-dir-on-non-claude`, pinned in provider-list.check.ts), as it refuses `config-dir-on-api`.
    const sb = engineSandbox();
    try {
      const saved = cfgText({
        repos: ["/nonexistent/repo"],
        provider: CLAUDE_CLI,
        fallbacks: [{ label: "Codex", cli: "codex", argv: ["exec"], promptVia: "stdin", configDir: "~/.codex-b" }],
      });
      const asFallback = sb.validate(saved);
      expect(asFallback.valid).toBe(false);
      const draft = parse(saved);
      expect(moveProvider(draft, 1, 0)).toBe(
        'Not changed: "Codex" has a login folder, and only a Claude command-line login can use one as the first provider. Clear its login folder first.',
      );
      // Nothing changed: the draft still reads as saved.
      expect(out(draft)).toBe(out(parse(saved)));
      // What the block prevents, measured on the engine: the same list written by hand (codex item 1 with that folder)
      // validates, with no structural warning, so the save gate alone would have let it through.
      const byHand = cfgText({
        repos: ["/nonexistent/repo"],
        provider: { cli: "codex", argv: ["exec"], promptVia: "stdin", accounts: [{ label: "Codex", configDir: "~/.codex-b" }] },
        fallbacks: [{ label: "default", ...CLAUDE_CLI }],
      });
      const report = sb.validate(byHand);
      expect(report.valid).toBe(true);
      expect(report.warnings.some((w) => w.message.endsWith("— account failover disabled"))).toBe(false);
      expect(saveGate(validated(report))).toEqual({ kind: "allow" });
      // And such an existing config still loads and round-trips through the list editor unchanged (requirement 9).
      const existing = parse(byHand);
      expect(moveProvider(existing, 1, 1)).toBeNull();
      expect(out(existing)).toBe(out(parse(byHand)));
    } finally {
      sb.cleanup();
    }
  });

  test("the rule: field `provider.accounts` AND the suffix; errors are the save path's; a failed check refuses", () => {
    const report = (warnings: { field: string; message: string }[], valid = true): ConfigValidateReport => ({
      schemaVersion: 1,
      valid,
      errors: valid ? [] : [{ field: "lookbackCapDays", message: "bad" }],
      warnings,
      normalized: null,
      providers: [],
    });
    const structural = 'config: "provider.accounts" has duplicate labels, and limit marks are keyed by label — account failover disabled';
    expect(saveGate(validated(report([{ field: "provider.accounts", message: structural }]))).kind).toBe("refuse");
    expect(saveGate(validated(report([{ field: "morningTime", message: `x — account failover disabled` }])))).toEqual({ kind: "allow" });
    expect(saveGate(validated(report([{ field: "provider.accounts", message: "an advisory note" }])))).toEqual({ kind: "allow" });
    // An invalid candidate is not refused HERE: `configSave` refuses it and the report lists the errors.
    expect(saveGate(validated(report([], false)))).toEqual({ kind: "allow" });
    expect(saveGate({ kind: "invalid", errors: [{ field: "calendar", message: "a link" }], warnings: [] })).toEqual({ kind: "allow" });
    // A check that could not run refuses — except the two refusals the save path gives itself, word for word.
    for (const e of [{ kind: "timeout", operation: "config-validate", seconds: 30 }, { kind: "engine", detail: "crashed" }, { kind: "candidateDir", detail: "x" }]) {
      const g = saveGateFailure(e);
      expect(g.kind).toBe("refuse");
      expect(g.kind === "refuse" ? g.message : "").toContain("could not be checked");
    }
    expect(saveGateFailure({ kind: "notJson", detail: "x" })).toEqual({ kind: "allow" });
    expect(saveGateFailure({ kind: "tooLarge", bytes: 2, limit: 1 })).toEqual({ kind: "allow" });
  });

  test("Settings.svelte validates the candidate through the candidate check BEFORE `configSave`, on every save", () => {
    const svelte = codeOf(readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    const check = svelte.indexOf('const gate = await gateCheck(text);');
    const save = svelte.indexOf("const saved = await configSave(text, sent.base);");
    expect(check).toBeGreaterThan(0);
    expect(save).toBeGreaterThan(check);
    expect(svelte).toContain('saveGate(await providerCandidateCheck(text, "validate"))');
    expect(svelte).toContain('if (gate.kind === "refuse") { failure = gate.message; return false; }');
  });
});

describe("P3-M4-T1: the network-check prompt", () => {
  const off = cfgText({ provider: CLAUDE_CLI, networkProbeHosts: [] });
  const REMOTE = { api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } };
  const LOCAL = { timeoutMs: 1_000, api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1" } };
  const adding = (...added: [string, Draft][]): Draft => {
    const d = parse(off);
    let entries = entriesOf(d);
    for (const [label, block] of added) entries = insertEntry(entries, entries.length, { label, block });
    const w = writeProviderList(d, entries);
    if (!w.ok) throw new Error("refused");
    return w.config;
  };
  const withAdded = adding(["Anthropic key", REMOTE]);
  /** The candidate's own `config validate` rows, from the REAL engine — `loopback` is the engine's, never decided here. */
  const rowsFor = (candidate: Draft) => {
    const sb = engineSandbox();
    try {
      return sb.validate(out(candidate)).providers;
    } finally {
      sb.cleanup();
    }
  };
  const remoteRows = rowsFor(withAdded);

  test("asked when an entry is added while `networkProbeHosts` is [], and only then", () => {
    expect(remoteRows.map((r) => r.loopback)).toEqual([false, false]);
    expect(networkAskNeeded(off, withAdded, false, remoteRows)).toBe(true);
    expect(networkAskNeeded(off, parse(off), false, rowsFor(parse(off)))).toBe(false);
    expect(networkAskNeeded(off, { ...withAdded, networkProbeHosts: [{ host: "h", port: 1 }] }, false, remoteRows)).toBe(false);
    const absent = { ...withAdded };
    delete absent.networkProbeHosts;
    expect(networkAskNeeded(off, absent, false, remoteRows)).toBe(false);
  });

  // Plan hub "(BUILD, P3-M4-T1, 2026-10-18) Decided" (1): only a REMOTE added entry asks — a yes on a local-only list
  // would make a network outage skip a briefing the local model could have produced. "Remote" is the engine's answer
  // (`config validate`'s row `loopback: false`), never the app's own reading of the URL.
  test("adding a loopback-only entry does not ask; adding a remote one does; a mix asks", () => {
    const local = adding(["Local model", LOCAL]);
    const localRows = rowsFor(local);
    expect(localRows.map((r) => [r.index, r.loopback])).toEqual([[0, false], [1, true]]);
    expect(networkAskNeeded(off, local, false, localRows)).toBe(false);
    expect(networkAskNeeded(off, withAdded, false, remoteRows)).toBe(true);
    const both = adding(["Local model", LOCAL], ["Anthropic key", REMOTE]);
    expect(networkAskNeeded(off, both, false, rowsFor(both))).toBe(true);
    // The EXISTING item 1 is remote (a CLI), but it was not added: it never asks on its own.
    expect(localRows[0]!.loopback).toBe(false);
  });

  test("no row saying `loopback: false` for an added entry, no ask: rows unknown, or the entry has no row", () => {
    expect(networkAskNeeded(off, withAdded, false)).toBe(false);
    expect(networkAskNeeded(off, withAdded, false, null)).toBe(false);
    // An added entry the engine drops has no row of its own (its index is skipped).
    expect(networkAskNeeded(off, withAdded, false, remoteRows.filter((r) => r.index !== 1))).toBe(false);
    // The rows are joined by POSITION (the `--index` numbering), not by label: a loopback row at the added entry's
    // index means that entry is loopback.
    expect(networkAskNeeded(off, withAdded, false, remoteRows.map((r) => (r.index === 1 ? { ...r, loopback: true } : r)))).toBe(false);
    // PR 3 final r1 (C4, mutant M39): only `loopback: false` says remote. A row MISSING the field (or with anything but
    // `false`) has not said so: the user is not asked. The same rows saying `false` do ask.
    const unsaid = remoteRows.map((r) => {
      const { loopback: _dropped, ...rest } = r;
      return rest as unknown as ProviderValidateRow;
    });
    expect(unsaid.every((r) => !("loopback" in r))).toBe(true);
    expect(networkAskNeeded(off, withAdded, false, unsaid)).toBe(false);
    expect(networkAskNeeded(off, withAdded, false, remoteRows.map((r) => ({ ...r, loopback: undefined as unknown as boolean })))).toBe(false);
    expect(networkAskNeeded(off, withAdded, false, remoteRows)).toBe(true);
  });

  test("asked once, defaulting to yes, for a remote add: the answer is applied and not asked again", () => {
    expect(NETWORK_ASK.defaultYes).toBe(true);
    expect(networkAskNeeded(off, withAdded, false, remoteRows)).toBe(true);
    expect(networkAskNeeded(off, withAdded, true, remoteRows)).toBe(false);
    const yes = structuredClone(withAdded);
    applyNetworkAnswer(yes, NETWORK_ASK.defaultYes);
    expect(hasPath(yes, ["networkProbeHosts"])).toBe(false);
    expect(networkAskNeeded(off, yes, false, remoteRows)).toBe(false);
  });

  test("once: after the first answer it is not asked again; the answer defaults to yes, which turns the check back on", () => {
    expect(NETWORK_ASK.defaultYes).toBe(true);
    expect(NETWORK_ASK.question).toContain("network check");
    expect(networkAsked()).toBe(false);
    markNetworkAsked();
    expect(networkAsked()).toBe(true);
    expect(networkAskNeeded(off, withAdded, networkAsked())).toBe(false);
    const yes = structuredClone(withAdded);
    applyNetworkAnswer(yes, true);
    expect(hasPath(yes, ["networkProbeHosts"])).toBe(false);
    const no = structuredClone(withAdded);
    applyNetworkAnswer(no, false);
    expect(getPath(no, ["networkProbeHosts"])).toEqual([]);
    // Settings.svelte: the box starts ticked, the answer is applied before the save, and the ask is spent on a save
    // that landed.
    const svelte = codeOf(readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    expect(svelte).toContain("let networkYes = $state(NETWORK_ASK.defaultYes);");
    expect(svelte).toContain("if (askNetwork) applyNetworkAnswer(draft, networkYes);");
    expect(svelte).toContain("if (askedNetwork) markNetworkAsked();");
  });
});

describe("P3-M4-T1: Test, Reset and the copy", () => {
  test("Test passes the validate row's `testTimeoutMs` unchanged, and refuses an entry with no row", () => {
    const report: ConfigValidateReport = {
      schemaVersion: 1,
      valid: true,
      errors: [],
      warnings: [],
      normalized: null,
      providers: [
        { index: 0, testTimeoutMs: 80_000, loopback: false },
        { index: 2, testTimeoutMs: 617_000, loopback: true, appOwnedKey: true, appKeyId: "k-0123456789ab" },
      ],
    };
    expect(testPlan(validated(report), 2)).toEqual({ kind: "test", mode: { test: { index: 2, testTimeoutMs: 617_000 } } });
    expect(testPlan(validated(report), 1).kind).toBe("refuse");
    const broken = { ...report, providers: [], warnings: [{ field: "provider.accounts", message: "x — account failover disabled" }] };
    expect(testPlan(validated(broken), 0)).toEqual({ kind: "refuse", message: expect.stringContaining("logins") });
    const invalid = { ...report, valid: false, providers: [], errors: [{ field: "fallbacks[0]", message: "bad shape" }] };
    expect(testPlan(validated(invalid), 0)).toEqual({ kind: "refuse", message: expect.stringContaining("bad shape") });
  });

  test("a Test's answer in words: passed, failed with its remedy, not recorded, refused", () => {
    const tested = (answer: unknown): CheckOutcome => ({ kind: "tested", answer: answer as never, boundMs: 80_000 });
    expect(testResultLines(tested({ schemaVersion: 1, ok: true, passed: true, at: NOW.toISOString(), recorded: true }))).toEqual(["Test passed."]);
    const failed = testResultLines(
      tested({ schemaVersion: 1, ok: true, passed: false, reason: "key-unavailable", at: NOW.toISOString(), recorded: false, notRecorded: "lock-held" }),
    );
    expect(failed[0]).toBe("Test failed: key couldn't be read.");
    expect(failed).toContain(remedyFor("key-unavailable"));
    expect(failed).toContain("Its result was not saved — a briefing was running.");
    expect(testResultLines(tested({ schemaVersion: 1, ok: false, code: "config", error: "test: x", reason: "timeout" })).join(" ")).toContain("retry");
    expect(notRecordedLine("lock-held")).toBe("not saved — a briefing was running");
    expect(notRecordedLine("write-failed")).toBe("not saved — the status file could not be written");
  });

  test("a Reset's answer in words", () => {
    const o = (payload: ProviderResetAnswer | ProviderRefusal | null): EngineOutcome<ProviderResetAnswer | ProviderRefusal> => ({
      operation: "provider-reset",
      outcome: { kind: "delivered" },
      exitCode: 0,
      payload,
      stdout: "",
      stderr: "",
    });
    expect(resetResultLine(o({ schemaVersion: 1, ok: true, cleared: true }))).toContain("cleared");
    expect(resetResultLine(o({ schemaVersion: 1, ok: true, cleared: false }))).toContain("nothing to clear");
    expect(resetResultLine(o({ schemaVersion: 1, ok: false, code: "lock-held", error: "reset: x" }))).toContain("a briefing is running");
    expect(resetResultLine(o({ schemaVersion: 1, ok: false, code: "config", error: "reset: x" }))).toContain("invalid");
    expect(resetResultLine(o(null))).toContain("did not answer");
  });

  test("the three copy strings, the sentinel and the replace-waiting line", () => {
    // 1. `key-unavailable`'s remedy names the Keychain dialog.
    expect(KEYCHAIN_DIALOG_REMEDY).toBe("if a Keychain dialog is on screen, unlock it or cancel it");
    expect(remedyFor("key-unavailable")).toContain(KEYCHAIN_DIALOG_REMEDY);
    expect(statusLine({ kind: "not-working", since: NOW.toISOString(), reason: "key-unavailable" }, NOW).remedy).toContain(KEYCHAIN_DIALOG_REMEDY);
    // 2. Test on a command-line entry says it uses a little of the plan; an API entry's does not.
    expect(CLI_TEST_NOTE).toBe("uses a little of your plan");
    const saved = cfgText({ provider: CLAUDE_CLI, fallbacks: [{ label: "API", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }] });
    const v = view({ draft: parse(saved), savedText: saved, rows: null, now: NOW });
    expect(rowOf(v, "default").test.text).toContain(CLI_TEST_NOTE);
    expect(rowOf(v, "API").test.text).not.toContain(CLI_TEST_NOTE);
    // 3. A key store timeout, per platform (hub P2-M2): the Keychain on macOS, the key folder elsewhere.
    expect(keyTimeoutLine("macos")).toBe("unlock your keychain, then retry");
    expect(keyTimeoutLine("linux")).toBe("the key folder did not answer in time — retry");
    // The scrub's sentinel is "key moved — add a key", never an environment-variable source (hub P2-M3 (3)). The app
    // reads it from the engine's rows (`keyMoved`) and keeps no copy of the sentinel (P3-M4-T2 checkpoint).
    expect(KEY_MOVED_LINE).toBe("key moved — add a key");
    expect(Object.keys(settingsModel)).not.toContain("KEY_MOVED_ENV");
    expect(readFileSync(new URL("../src/lib/settings-model.ts", import.meta.url), "utf8")).not.toContain(DOC_KEY_MOVED_ENV);
    // A replace waiting on the run lock (P3-M4-T3 sets it; the row shows it).
    expect(REPLACE_WAITING_LINE).toBe("a briefing is running — the key will be replaced when it finishes");
    const waiting = view({ draft: parse(saved), savedText: saved, rows: null, now: NOW, pending: { API: "replace-waiting" } });
    expect(rowOf(waiting, "API").notes).toContain(REPLACE_WAITING_LINE);
  });

  test("the app's reason words are the engine's wording, for every reason; every reason has a remedy", () => {
    for (const [reason, row] of Object.entries(FAILOVER_REASONS)) {
      const engineWords = row.wording.split(" — ")[0]!.replace(" until {until}", "").replace(" (HTTP {status})", "");
      expect({ reason, words: reasonWords(reason) }).toEqual({ reason, words: engineWords });
      expect({ reason, remedy: remedyFor(reason).length > 0 }).toEqual({ reason, remedy: true });
    }
    for (const reason of HOUR_MARK_REASONS) expect({ reason, worded: reasonWords(reason) !== reason || reason === "auth" }).toEqual({ reason, worded: true });
    expect(reasonWords("earlier-failure")).toBe("earlier failures");
  });

  test("labels are control-stripped at display, and stay text", () => {
    const label = `Bell\u0007 login\u001b[31m ${HOSTILE}`;
    const saved = cfgText({ provider: { ...CLAUDE_CLI, accounts: [{ label }, { label: "two", configDir: "~/.b" }] } });
    const v = view({ draft: parse(saved), savedText: saved, rows: null, now: NOW });
    expect(v.rows[0]!.label).toBe(label);
    expect(v.rows[0]!.display).toBe(`Bell login[31m ${HOSTILE}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = render(ProvidersList as any, { props: { view: v } }).body;
    expect(body).not.toMatch(/[\u0007\u001b]/);
    expect(body).not.toContain("<img");
    expect(body).toContain("Bell login[31m");
  });

  // User-directed 2026-10-22 (P-A): Reset is "Try again now", drawn on a row with a mark (out of usage, or paused) only;
  // Move up / Move down only where each can act; every button inside the row's details.
  test("ProvidersList draws the rows in order with drag, Move up/down, Test, Try again now (disabled while dirty) and Remove", () => {
    const saved = cfgText({ provider: CLAUDE_CLI, fallbacks: [{ label: "API", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }] });
    const rows = [
      statusRow(0, "default", "cli", { kind: "out-of-usage", until: NOW.toISOString() }),
      statusRow(1, "API", "anthropic", { kind: "paused", until: NOW.toISOString(), reason: "unreachable" }),
    ];
    const noop = () => {};
    const html = (v: ProvidersView) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render(ProvidersList as any, { props: { view: v, onmove: noop, onremove: noop, ontest: noop, onreset: noop, onfolder: noop } })
        .body.replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\s+/g, " ");
    const clean = html(view({ draft: parse(saved), savedText: saved, rows, now: NOW }));
    expect(clean.indexOf(">default<")).toBeLessThan(clean.indexOf(">API<"));
    expect(clean.match(/draggable="true"/g)).toHaveLength(2);
    expect(clean.match(/>Move up<\/button>/g)).toHaveLength(1);
    expect(clean.match(/>Move down<\/button>/g)).toHaveLength(1);
    expect(clean.indexOf(">Move down</button>")).toBeLessThan(clean.indexOf('id="prov-row-1"'));
    expect(clean.indexOf(">Move up</button>")).toBeGreaterThan(clean.indexOf('id="prov-row-1"'));
    expect(clean).toContain(`Test — ${CLI_TEST_NOTE}`);
    expect(clean).toContain("</span> out of usage until");
    expect(clean.match(/<button[^>]*>Try again now<\/button>/g)).toHaveLength(2);
    expect(clean).not.toMatch(/<button[^>]*disabled[^>]*>Try again now<\/button>/);
    expect(clean).not.toContain(">Reset<");
    expect(clean.match(/>Remove<\/button>/g)).toHaveLength(2);
    // The add flow is P3-M4-T2's: no Add button until its handler is passed.
    expect(clean).not.toContain("Add a provider");
    // No mark, no Try again now.
    const plain = html(view({ draft: parse(saved), savedText: saved, rows: [statusRow(0, "default", "cli", { kind: "working", at: NOW.toISOString() }), statusRow(1, "API", "anthropic", { kind: "not-tested" })], now: NOW }));
    expect(plain).not.toContain("Try again now");
    const draft = parse(saved);
    expect(removeProvider(draft, "API")).toBeNull();
    const dirty = html(view({ draft, savedText: saved, rows, now: NOW }));
    expect(dirty).toMatch(/<button[^>]*disabled[^>]*>Try again now<\/button>/);
    expect(dirty).toContain("Save or discard");
  });
});

/* ── P3-M4-T4: a key written in the settings file ───────────────────────────────────────────────── */

describe("P3-M4-T4: an entry holding a literal key shows a banner, and Test stays disabled until the key is moved or removed", () => {
  const PH = REDACTED_API_KEY;
  const saved = cfgText({
    provider: CLAUDE_CLI,
    fallbacks: [
      { label: "Lit", api: { kind: "anthropic", model: "m", apiKey: PH } },
      { label: "Env", api: { kind: "anthropic", model: "m", apiKeyEnv: "MINE", apiKey: PH } },
      { label: "Cmd", api: { kind: "anthropic", model: "m", apiKeyCommand: ["pass", "show", "x"], apiKey: PH } },
      { label: "File", api: { kind: "anthropic", model: "m", apiKeyFile: "/home/me/key", apiKey: PH } },
      { label: "Plain", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } },
    ],
  });
  const rows = [
    statusRow(0, "default", "cli", { kind: "not-tested" }),
    statusRow(1, "Lit", "anthropic", { kind: "not-tested" }),
    statusRow(2, "Env", "anthropic", { kind: "not-tested" }),
    statusRow(3, "Cmd", "anthropic", { kind: "not-tested" }),
    statusRow(4, "File", "anthropic", { kind: "not-tested" }),
    statusRow(5, "Plain", "anthropic", { kind: "not-tested" }),
  ];
  const at = (os: "macos" | "linux") => view({ draft: parse(saved), savedText: saved, rows, now: NOW, os });
  const offer = (r: ReturnType<typeof rowOf>) => (r.migrate !== null ? "migrate" : r.removeLiteral !== null ? "remove" : "none");

  test("the slot a moved key takes is the store's: the Keychain lookup on macOS, a key file elsewhere", () => {
    expect(settingsModel.migrateSlot("macos")).toBe("apiKeyCommand");
    for (const os of ["linux", "windows", "other"] as const) expect(settingsModel.migrateSlot(os)).toBe("apiKeyFile");
  });

  test("migrate is offered only when the moved key would neither take nor outrank a source of the user's own; otherwise remove-with-confirmation, never both", () => {
    // macOS (the reference is an apiKeyCommand): only an apiKeyCommand of the user's blocks it.
    const mac = at("macos");
    expect(["Lit", "Env", "Cmd", "File", "Plain"].map((l) => [l, offer(rowOf(mac, l))])).toEqual([
      ["Lit", "migrate"],
      ["Env", "migrate"], // apiKeyEnv outranks the new reference: kept, still the key read
      ["Cmd", "remove"], // the slot is the user's own
      ["File", "migrate"], // apiKeyFile outranks the new apiKeyCommand: kept, still the key read
      ["Plain", "none"],
    ]);
    // Elsewhere (an apiKeyFile): the user's apiKeyCommand ranks BELOW a key file, so a moved key would outrank it and
    // become the key read — not offered.
    const linux = at("linux");
    expect(["Lit", "Env", "Cmd", "File", "Plain"].map((l) => [l, offer(rowOf(linux, l))])).toEqual([
      ["Lit", "migrate"],
      ["Env", "migrate"],
      ["Cmd", "remove"],
      ["File", "remove"],
      ["Plain", "none"],
    ]);
    expect(settingsModel.migrateBlockedBy({ api: { apiKeyCommand: ["x"], apiKey: PH } }, "apiKeyCommand")).toBe("apiKeyCommand");
    expect(settingsModel.migrateBlockedBy({ api: { apiKeyEnv: "E", apiKey: PH } }, "apiKeyFile")).toBeNull();
    // No platform known: both slots count (the conservative answer).
    expect(settingsModel.migrateBlockedBy({ api: { apiKeyFile: "/f", apiKey: PH } }, null)).toBe("apiKeyFile");
  });

  test("docs/PROVIDERS.md states the rule as the code applies it, and Remove's scope as Settings keeps it (PR 3 final r4, H2/H3)", () => {
    const doc = readFileSync(new URL("../../docs/PROVIDERS.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    // H2: a source that ranks ABOVE the slot (an environment variable) gets Move, as the table above says.
    expect(doc).not.toContain("would be used before it, or would be outranked");
    expect(doc).toContain(
      "already holds the place the moved key would take (a command on macOS, a key file elsewhere), or ranks below that place so the moved key would be used before it (a command, off macOS)",
    );
    expect(doc).toContain("A source that ranks above that place, such as an environment variable, stays in front of the moved key, so the key is moved.");
    // H3: only the Remove button, in this visit to Settings, queues a key delete (`removedLabels`; not kept on leaving).
    expect(doc).toContain("only for an entry removed with the **Remove** button during this visit to Settings");
    expect(doc).toContain("An entry deleted with Edit settings as JSON on Settings → Advanced, or whose removal you save only after leaving Settings and coming back, keeps its stored key; an Uninstall removes it.");
  });

  test("docs/PROVIDERS.md's status list carries the app's own statuses, worded as the app shows them (PR 3 final r5, B6)", () => {
    const doc = readFileSync(new URL("../../docs/PROVIDERS.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    // User-directed 2026-10-22 (P-A): the paragraph describes the compact rows now (the list moved with its words).
    const list = doc.slice(doc.indexOf("and its status ("), doc.indexOf(") — that opens in place"));
    expect(list.length).toBeGreaterThan(0);
    expect(list).toContain(", not saved yet,");
    // PR 3 final, the second post-cap fix (N4): the row the app shows when it has no status for a saved entry.
    expect(list).toContain(", status unknown,");
    expect(list).toContain(`${KEY_MOVED_LINE}: its key was removed from the settings file, so give it one with **Replace key**`);
  });

  test("each literal row carries its banner, Test disabled with the reason, and the status row's revision", () => {
    const mac = at("macos");
    for (const l of ["Lit", "Env"]) {
      expect(rowOf(mac, l).banner).toBe(settingsModel.literalBanner("macos"));
      expect(rowOf(mac, l).test).toMatchObject({ enabled: false, why: "Move this key to the Keychain first." });
      expect(rowOf(mac, l).migrate).toEqual({ enabled: true, why: null, text: "Move this key to the Keychain" });
    }
    expect(rowOf(mac, "Cmd").banner).toBe(settingsModel.LITERAL_FALLBACK_BANNER);
    expect(rowOf(mac, "Cmd").test).toMatchObject({ enabled: false, why: "Remove the key written in settings first." });
    expect(rowOf(mac, "Cmd").removeLiteral).toEqual({ enabled: true, why: null });
    expect(rowOf(mac, "Plain").banner).toBeNull();
    expect(rowOf(mac, "Plain").test.enabled).toBe(true);
    expect(rowOf(mac, "Lit").revision).toBe("rev-1");
    expect(rowOf(view({ draft: parse(saved), savedText: saved, rows: null, now: NOW, os: "macos" }), "Lit").revision).toBeNull();
    // The fallback banner says the written key is used only when the user's own source fails.
    expect(settingsModel.LITERAL_FALLBACK_BANNER).toContain("used only when your own key source fails");
    // While the list has unsaved edits both wait, as Reset does.
    const draft = parse(saved);
    expect(removeProvider(draft, "Plain")).toBeNull();
    const dirty = view({ draft, savedText: saved, rows, now: NOW, os: "macos" });
    expect(rowOf(dirty, "Lit").migrate?.enabled).toBe(false);
    expect(rowOf(dirty, "Cmd").removeLiteral?.enabled).toBe(false);
    expect(rowOf(dirty, "Cmd").removeLiteral?.why).toContain("Save or discard");
    // And while a key is being moved, nothing else on the list runs.
    const moving = view({ draft: parse(saved), savedText: saved, rows, now: NOW, os: "macos", migrating: "Lit" });
    expect(rowOf(moving, "Plain").test.enabled).toBe(false);
    expect(rowOf(moving, "Cmd").removeLiteral?.enabled).toBe(false);
    expect(rowOf(moving, "Plain").reset?.enabled).toBe(false);
  });

  test("ProvidersList draws the banner, the migrate button, and the remove path behind a confirmation — never migrate on an occupied slot", () => {
    const noop = () => {};
    const html = (os: "macos" | "linux", confirm: string | null = null) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render(ProvidersList as any, { props: { view: at(os), ontest: noop, onmigrate: noop, onremoveliteral: noop, confirmRemoveFor: confirm } })
        .body.replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\s+/g, " ");
    const body = html("macos");
    const rowHtml = (b: string, label: string): string => {
      const start = b.indexOf(`>${label}<`);
      const end = b.indexOf("</li>", start);
      return b.slice(start, end);
    };
    const lit = rowHtml(body, "Lit");
    expect(lit).toContain(settingsModel.literalBanner("macos"));
    expect(lit).toMatch(/<button[^>]*>Move this key to the Keychain<\/button>/);
    expect(lit).toMatch(/<button[^>]*disabled[^>]*>Test<\/button>/);
    expect(lit).not.toContain(settingsModel.REMOVE_LITERAL_BUTTON);
    const cmd = rowHtml(body, "Cmd");
    expect(cmd).toContain(settingsModel.LITERAL_FALLBACK_BANNER);
    expect(cmd).not.toContain("Move this key to the Keychain");
    expect(cmd).toMatch(new RegExp(`<button[^>]*>${settingsModel.REMOVE_LITERAL_BUTTON}</button>`));
    expect(cmd).toMatch(/<button[^>]*disabled[^>]*>Test<\/button>/);
    // The confirmation is drawn only once asked for, and says the key goes from the settings AND the backup.
    expect(body).not.toContain(settingsModel.REMOVE_LITERAL_CONFIRM);
    const asked = rowHtml(html("macos", "Cmd"), "Cmd");
    expect(asked).toContain(settingsModel.REMOVE_LITERAL_CONFIRM);
    expect(settingsModel.REMOVE_LITERAL_CONFIRM).toContain("removed from the settings when they are saved, and then from their backup");
    // PR 3 final r4 (H5): the backup's clean-up can fail, or another name for the backup can keep the key
    // (`scrubLines`): the confirmation promises no more than that the app says so.
    expect(settingsModel.REMOVE_LITERAL_CONFIRM).toContain("if the backup cannot be cleaned, or another file still holds the key, the app says so");
    expect(settingsModel.REMOVE_LITERAL_CONFIRM).not.toContain("cannot be brought back");
    expect(asked).toMatch(/<button[^>]*>Remove it<\/button>/);
    expect(asked).toMatch(/<button[^>]*>Cancel<\/button>/);
    // Linux: the File row is occupied too — no move button of either wording.
    expect(rowHtml(html("linux"), "File")).not.toContain("Move this key to the");
    // …and the Lit row's button is the key folder's (finding 5).
    expect(rowHtml(html("linux"), "Lit")).toMatch(/<button[^>]*>Move this key to the key folder<\/button>/);
    expect(html("linux")).not.toContain("Keychain");
    // The remove button calls nothing until confirmed: its click only opens the confirmation.
    const src = codeOf(readFileSync(new URL("../src/lib/ProvidersList.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    expect(src).toContain("onclick={() => (confirmFor = row.label)}>{REMOVE_LITERAL_BUTTON}</button");
    expect(src.split("onremoveliteral(").length - 1).toBe(1);
    expect(src).toMatch(/onclick=\{\(\) => \{ confirmFor = null; onremoveliteral\(row\.label, savedIndex\); \}\}>Remove it<\/button/);
  });
});

/* ── PR 3 final r4 (H1): while the screen is busy, no control of the list is live ─────────────────────────── */

describe("PR 3 final r4 (H1): while the screen is busy, Add, Replace, the written-key actions and Remove are not live", () => {
  const PH = REDACTED_API_KEY;
  const saved = cfgText({
    provider: CLAUDE_CLI,
    fallbacks: [
      { label: "Lit", api: { kind: "anthropic", model: "m", apiKey: PH } },
      { label: "Cmd", api: { kind: "anthropic", model: "m", apiKeyCommand: ["pass", "show", "x"], apiKey: PH } },
      { label: "Plain", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } },
    ],
  });
  const rows = [
    statusRow(0, "default", "cli", { kind: "not-tested" }),
    statusRow(1, "Lit", "anthropic", { kind: "not-tested" }),
    statusRow(2, "Cmd", "anthropic", { kind: "not-tested" }),
    statusRow(3, "Plain", "anthropic", { kind: "not-tested" }),
  ];
  type Input = Parameters<typeof providersView>[0];
  const at = (over: Partial<Input> = {}) => view({ draft: parse(saved), savedText: saved, rows, now: NOW, os: "macos", ...over });
  /** Each thing that makes the screen busy, as `Settings.svelte` hands it to the view. */
  const BUSY: [string, Partial<Input>][] = [
    ["saving", { saving: true }],
    ["adding", { adding: true }],
    ["replacing", { replacing: "Plain" }],
    ["testing", { testing: "Plain" }],
    ["resetting", { resetting: "Plain" }],
    ["migrating", { migrating: "Lit" }],
  ];

  test("busy: a save, an add, a replacement, or a Test, Reset or key move running — and nothing else", () => {
    expect(at().busy).toBe(false);
    expect(at({ saving: false, adding: false, replacing: null, testing: null, resetting: null, migrating: null }).busy).toBe(false);
    for (const [name, over] of BUSY) expect([name, at(over).busy]).toEqual([name, true]);
  });

  // PR 3 final r5 (C4): Reset waits for a row op only (a Test, Reset or key move); a save, an add or a replacement
  // leaves it live. Kills `savedAction(rowOp)` → `savedAction(busy)`.
  test("Reset stays enabled while saving, adding or replacing; only a row's Test, Reset or key move disables it", () => {
    for (const r of at().rows) expect([r.label, r.reset]).toEqual([r.label, { enabled: true, why: null }]);
    for (const [name, over] of BUSY) {
      const rowOp = !("saving" in over || "adding" in over || "replacing" in over);
      for (const r of at(over).rows) expect([name, r.label, r.reset]).toEqual([name, r.label, { enabled: !rowOp, why: null }]);
    }
  });

  test("Move this key and Remove the key written in settings are disabled whenever busy — exactly when literalRun refuses them", () => {
    const idle = at();
    expect([rowOf(idle, "Lit").migrate?.enabled, rowOf(idle, "Cmd").removeLiteral?.enabled]).toEqual([true, true]);
    for (const [name, over] of BUSY) {
      const v = at(over);
      expect([name, rowOf(v, "Lit").migrate?.enabled, rowOf(v, "Cmd").removeLiteral?.enabled]).toEqual([name, false, false]);
    }
  });

  test("Remove is disabled whenever busy, and not offered at all on the row whose replacement is in progress", () => {
    const idle = at();
    for (const r of idle.rows) expect([r.label, r.remove]).toEqual([r.label, { enabled: true, why: null }]);
    for (const [name, over] of BUSY) {
      const v = at(over);
      for (const r of v.rows) {
        const expected = over.replacing === r.label ? null : { enabled: false, why: null };
        expect([name, r.label, r.remove]).toEqual([name, r.label, expected]);
      }
    }
    // The replacement's row has no Remove even once nothing runs (its Save, Test again and Discard are on that row).
    expect(rowOf(at({ replacing: "Plain" }), "Plain").remove).toBeNull();
    expect(rowOf(at({ replacing: "Plain" }), "Lit").remove).not.toBeNull();
  });

  const noop = () => {};
  const html = (props: Record<string, unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(ProvidersList as any, { props })
      .body.replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, " ");
  const rowHtml = (b: string, label: string): string => {
    const start = b.indexOf(`>${label}<`);
    return b.slice(start, b.indexOf("</li>", start));
  };
  /** A button with exactly this text, live or disabled (Svelte adds its own class, so attributes are matched loosely). */
  const live = (text: string) => new RegExp(`<button(?![^>]*disabled)[^>]*>${text}</button>`, "g");
  const dead = (text: string) => new RegExp(`<button[^>]*disabled[^>]*>${text}</button>`, "g");

  test("ProvidersList draws Remove, Move this key and Remove the key written in settings disabled while busy, and no Remove on the replacement's row", () => {
    const idle = html({ view: at(), onremove: noop, onmigrate: noop, onremoveliteral: noop });
    expect(idle.match(live("Remove"))).toHaveLength(4);
    expect(idle).not.toMatch(dead("Remove"));
    expect(rowHtml(idle, "Lit")).toMatch(live("Move this key to the Keychain"));
    expect(rowHtml(idle, "Cmd")).toMatch(live(settingsModel.REMOVE_LITERAL_BUTTON));
    for (const [name, over] of BUSY) {
      const busy = html({ view: at(over), onremove: noop, onmigrate: noop, onremoveliteral: noop });
      const shown = over.replacing === undefined ? 4 : 3;
      expect([name, busy.match(dead("Remove"))?.length, live("Remove").test(busy)]).toEqual([name, shown, false]);
      expect([name, dead("Move this key to the Keychain").test(rowHtml(busy, "Lit"))]).toEqual([name, true]);
      expect([name, dead(settingsModel.REMOVE_LITERAL_BUTTON).test(rowHtml(busy, "Cmd"))]).toEqual([name, true]);
    }
    // An open confirmation's "Remove it" is disabled too.
    const confirming = html({ view: at({ adding: true }), onremoveliteral: noop, confirmRemoveFor: "Cmd" });
    expect(rowHtml(confirming, "Cmd")).toMatch(dead("Remove it"));
    const replacing = html({ view: at({ replacing: "Plain" }), onremove: noop });
    expect(rowHtml(replacing, "Plain")).not.toContain(">Remove</button>");
    expect(rowHtml(replacing, "Lit")).toContain(">Remove</button>");
  });

  test("an open Add form's \"Add and test\" is disabled while busy; an open Replace field's \"Replace and test\" while replaceable says no", () => {
    // P-Add: the API choice's button says "Add and test" alone (the subscription's adds "— uses a little of your plan").
    const addAt = (over: Partial<Input>) => html({ view: at(over), onadd: noop, addFormOpen: true, addFormChoice: "api" });
    expect(addAt({})).toMatch(live("Add and test"));
    for (const [name, over] of BUSY) expect([name, dead("Add and test").test(addAt(over))]).toEqual([name, true]);
    // Its Cancel stays: the form can always be closed.
    expect(addAt({ saving: true })).toMatch(live("Cancel"));
    const replaceAt = (offered: boolean) => html({ view: at(), onreplace: noop, replaceable: () => offered, replaceOpenFor: "Plain" });
    expect(rowHtml(replaceAt(true), "Plain")).toMatch(live("Replace and test"));
    expect(rowHtml(replaceAt(false), "Plain")).toMatch(dead("Replace and test"));
    // Its Cancel stays: the field can always be closed, and closing it clears the key.
    expect(rowHtml(replaceAt(false), "Plain")).toMatch(live("Cancel"));
  });

  test("a pasted key is cleared only when it is handed over: Add and Replace refuse before touching it while not live", () => {
    const src = codeOf(readFileSync(new URL("../src/lib/ProvidersList.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    // P-Add: the guided form makes today's AddForm (`guidedForm`); a choice that takes no key hands over none.
    expect(src).toMatch(
      /function submitAdd\(\): void \{ if \(onadd === undefined \|\| busy\) return; const form: AddForm = guidedForm\(shownChoice, \{ label, tool, command, args, service, model, address: baseUrl, configDir \}\); if \(!onadd\(form, guidedTakesKey\(shownChoice, service\) \? key : ""\)\) return; key = "";/,
    );
    expect(src).toMatch(
      /function submitReplace\(row: ProviderRowView\): void \{ if \(onreplace === undefined \|\| replaceable\?\.\(row\) !== true\) return; const pasted = replaceKey; replaceKey = ""; onreplace\(row\.label, pasted\); closeReplace\(\); \}/,
    );
    // The busy state is the parent's (the view's), never re-decided here.
    expect(src).toContain("const busy = $derived(!view.readable || view.busy);");
    // Round 10 (M4): the button runs `submitAdd` through `addAndTest`, which only moves the focus after a refusal.
    expect(src).toContain('<button type="button" class="primary" disabled={busy} onclick={addAndTest}>{shownChoice === "api" ? "Add and test" : `Add and test — ${CLI_TEST_NOTE}`}</button>');
    // Round 11 (L6): a take owes the focus to the add's panel, paid once it draws a control.
    expect(src.replace(/\s+/g, " ")).toMatch(/function addAndTest\(\): void \{ submitAdd\(\); if \(formOpen\) void focusAfter\(\(\) => \[closeIn\(\)\]\); else addFocusOwed = adding !== null; \}/);
    expect(src).toContain(
      '<button type="button" class="primary" disabled={replaceable?.(row) !== true} onclick={() => submitReplace(row)}>Replace and test</button>',
    );
    expect(src).toContain("{#if onremove !== undefined && row.remove !== null}");
    expect(src).toContain('<button type="button" disabled={!row.remove.enabled} onclick={() => onremove(row.label)}>Remove</button>');
  });

  test("Settings.svelte hands the view its busy state, and Replace, Move and Remove-written-key read it back from the view", () => {
    const settings = codeOf(readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    expect(settings).toContain("saving, adding: adding !== null, replacing: replacing?.label ?? null, testing: providerTesting, resetting: providerResetting,");
    expect(settings).toContain("migrating: providerMigrating,");
    expect(settings).toContain("const providersBusy = $derived(providers?.readable !== true || providers.busy);");
    expect(settings).toContain("replaceable: (row) => replaceOffered(row, providersBusy),");
    const at = settings.indexOf("function literalRun(");
    const run = settings.slice(at, settings.indexOf(" function ", at + 1));
    expect(run).toContain("if (providersBusy) return null;");
    // No second, hand-written busy test is left in literalRun.
    expect(run).not.toContain("adding !== null");
    expect(run).not.toContain("saving ||");
  });
});

/* ── PR 3 final r4 follow-up: a pending add's or replacement's Save waits for the form's Save ──────────────── */

describe("PR 3 final r4 (H1 follow-up): a pending add's or replacement's Save is not live while the form saves", () => {
  const saved = cfgText({ provider: CLAUDE_CLI, fallbacks: [{ label: "Plain", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }] });
  const rows = [statusRow(0, "default", "cli", { kind: "not-tested" }), statusRow(1, "Plain", "anthropic", { kind: "not-tested" })];
  const v = view({ draft: parse(saved), savedText: saved, rows, now: NOW, os: "macos" });
  const noop = () => {};
  const html = (props: Record<string, unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(ProvidersList as any, { props: { view: v, ...props } })
      .body.replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, " ");
  const live = (text: string) => new RegExp(`<button(?![^>]*disabled)[^>]*>${text}</button>`);
  const dead = (text: string) => new RegExp(`<button[^>]*disabled[^>]*>${text}</button>`);

  test("pendingSaveLive: Save and Save anyway are live only when the flow's own step and the form's Save are both idle", () => {
    const { pendingSaveLive } = flowsModule;
    expect(pendingSaveLive({ busy: false, saving: false })).toBe(true);
    expect(pendingSaveLive({ busy: false, saving: true })).toBe(false);
    expect(pendingSaveLive({ busy: true, saving: false })).toBe(false);
    expect(pendingSaveLive({ busy: true, saving: true })).toBe(false);
  });

  test("the add's Save / Save anyway are drawn disabled while the form saves; Test again and Discard stay live (their handlers do not wait for it)", () => {
    const adding = (passed: boolean, saving: boolean) => ({ busy: false, saving, lines: [], pending: { passed, ran: true } });
    expect(html({ onadd: noop, adding: adding(true, false) })).toMatch(live("Save"));
    expect(html({ onadd: noop, adding: adding(true, true) })).toMatch(dead("Save"));
    const anyway = html({ onadd: noop, adding: adding(false, true) });
    expect(anyway).toMatch(dead("Save anyway"));
    expect(anyway).toMatch(live("Test again"));
    expect(anyway).toMatch(live("Discard"));
    expect(html({ onadd: noop, adding: adding(false, false) })).toMatch(live("Save anyway"));
  });

  test("the replacement's Save / Save anyway likewise; Test again and Discard stay as their handlers decide", () => {
    const replacing = (passed: boolean, saving: boolean) => ({ label: "Plain", busy: false, waiting: false, saving, lines: [], pending: { passed, ran: true } });
    const at = (r: ReturnType<typeof replacing>) => html({ onreplace: noop, replacing: r });
    expect(at(replacing(true, false))).toMatch(live("Save"));
    expect(at(replacing(true, true))).toMatch(dead("Save"));
    const anyway = at(replacing(false, true));
    expect(anyway).toMatch(dead("Save anyway"));
    expect(anyway).toMatch(live("Test again"));
    expect(anyway).toMatch(live("Discard"));
    expect(at(replacing(false, false))).toMatch(live("Save anyway"));
  });

  test("wiring: the parent hands each view the form's `saving`; every Save / Save anyway reads pendingSaveLive; the handlers' refusals are those gates", () => {
    const list = codeOf(readFileSync(new URL("../src/lib/ProvidersList.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    const settings = codeOf(readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    for (const flow of ["adding", "replacing"]) {
      expect(list).toContain(`<button type="button" class="primary" disabled={!pendingSaveLive(${flow})} onclick={() => on${flow === "adding" ? "add" : "replace"}save?.()}>Save</button>`);
      expect(list).toContain(`<button type="button" disabled={!pendingSaveLive(${flow})} onclick={() => on${flow === "adding" ? "add" : "replace"}save?.()}>Save anyway</button>`);
    }
    // Exactly four Save buttons read it, and no Save of a pending flow is gated on `busy` alone any more.
    expect(list.split("disabled={!pendingSaveLive(").length - 1).toBe(4);
    expect(list).not.toMatch(/disabled=\{(adding|replacing)\.busy\} onclick=\{\(\) => on(add|replace)save/);
    expect(settings).toMatch(/busy: adding\.busy, saving, lines: adding\.lines,/);
    expect(settings).toMatch(/busy: replacing\.busy, waiting: replacing\.waiting, saving, lines: replacing\.lines,/);
    // The handlers refuse on exactly these: their own step running, or the form's Save.
    expect(settings).toContain("if (p == null || adding?.busy || saving || doc === null || draft === null) return;");
    expect(settings).toContain("if (r == null || p == null || r.busy || saving || doc === null || draft === null) return;");
    // Test again and Discard refuse only on their own step (their buttons' `busy` / replaceDiscardable).
    expect(settings).toContain("if (p == null || adding?.busy || draft === null) return;");
    expect(settings).toContain("if (p == null || adding?.busy) return;");
    expect(settings).toContain("if (r?.pending == null || r.busy || draft === null) return;");
    expect(settings).toContain('if (r?.pending == null || replaceSteps.running === "discard") return [];');
  });
});

/* ── P3-M4 checkpoint: the key store's name per platform, the draft-only banner, the old item-1 notice ─────── */

describe("P3-M4 checkpoint: per-platform key-store wording, the draft-only literal, and the old item-1 notice", () => {
  const PH = REDACTED_API_KEY;
  const saved = cfgText({
    provider: CLAUDE_CLI,
    fallbacks: [
      { label: "Lit", api: { kind: "anthropic", model: "m", apiKey: PH } },
      { label: "Plain", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } },
    ],
  });
  const rows = [
    statusRow(0, "default", "cli", { kind: "not-tested" }),
    statusRow(1, "Lit", "anthropic", { kind: "not-tested" }),
    statusRow(2, "Plain", "anthropic", { kind: "not-tested" }),
  ];

  test("keyStoreName: the Keychain on macOS, the key folder elsewhere (keyTimeoutLine's precedent)", () => {
    expect(settingsModel.keyStoreName("macos")).toBe("Keychain");
    for (const os of ["linux", "windows", "other"] as const) expect(settingsModel.keyStoreName(os)).toBe("key folder");
  });

  test("the banner, the button and Test's reason say the platform's store; macOS's wording is unchanged, byte for byte", () => {
    // The macOS strings as they shipped in 9501d6898.
    expect(settingsModel.literalBanner("macos")).toBe(
      "This provider's API key is written in the settings file. Move it to the Keychain: the app keeps it there, and the settings file keeps only a reference to it. It cannot be tested until then.",
    );
    expect(settingsModel.migrateButtonText("macos")).toBe("Move this key to the Keychain");
    const mac = view({ draft: parse(saved), savedText: saved, rows, now: NOW, os: "macos" });
    expect(rowOf(mac, "Lit").test.why).toBe("Move this key to the Keychain first.");
    for (const os of ["linux", "windows"] as const) {
      const v = view({ draft: parse(saved), savedText: saved, rows, now: NOW, os });
      const lit = rowOf(v, "Lit");
      expect({ os, banner: lit.banner, button: lit.migrate?.text, why: lit.test.why }).toEqual({
        os,
        banner: "This provider's API key is written in the settings file. Move it to the key folder: the app keeps it there, and the settings file keeps only a reference to it. It cannot be tested until then.",
        button: "Move this key to the key folder",
        why: "Move this key to the key folder first.",
      });
    }
  });

  test("a literal only in the DRAFT (Save would refuse it) gets its own banner, no move or remove, and says what to do (G19)", () => {
    const draft = parse(saved);
    ((draft["fallbacks"] as Record<string, unknown>[])[1]!["api"] as Record<string, unknown>)["apiKey"] = "typed-in-0123456789";
    for (const os of ["macos", "linux"] as const) {
      const v = view({ draft, savedText: saved, rows, now: NOW, os });
      const plain = rowOf(v, "Plain");
      expect({ os, banner: plain.banner, migrate: plain.migrate, remove: plain.removeLiteral }).toEqual({
        os,
        banner: settingsModel.literalDraftBanner(os, true),
        migrate: null,
        remove: null,
      });
      expect(plain.test).toMatchObject({ enabled: false, why: "Remove the key typed into the settings first." });
    }
    // It does not promise a move it cannot offer; it says Save refuses it, and where to put the key instead.
    const words = settingsModel.literalDraftBanner("macos", true);
    expect(words).not.toMatch(/^.*Move it to/);
    expect(words).toContain("Save refuses");
    expect(words).toContain("Remove it with Edit settings as JSON on Settings → Advanced");
    expect(words).not.toContain("Raw JSON");
    expect(words).toContain("Replace key");
    expect(settingsModel.literalDraftBanner("macos", true)).toContain("Keychain");
    expect(settingsModel.literalDraftBanner("linux", true)).toContain("key folder");
    expect(settingsModel.literalDraftBanner("linux", true)).not.toContain("Keychain");
  });

  /* PR 3 final r5 (B4 = H7): Replace key is offered on a SAVED entry only (`replaceOffered`), so an entry not saved yet
   * whose literal was typed in the JSON editor is told the two ways that work: Add a provider (which takes a pasted key), or
   * save it without the key and then Replace key. The saved entry's advice is unchanged. */
  test("a typed-in literal on an entry NOT saved yet is advised Add a provider, or save it key-less and then Replace key", () => {
    const draft = parse(saved);
    (draft["fallbacks"] as Record<string, unknown>[]).push({ label: "New", api: { kind: "anthropic", model: "m", apiKey: "typed-in-0123456789" } });
    for (const os of ["macos", "linux"] as const) {
      const v = view({ draft, savedText: saved, rows, now: NOW, os });
      const row = rowOf(v, "New");
      expect(row.savedIndex).toBeNull();
      expect({ os, banner: row.banner }).toEqual({ os, banner: settingsModel.literalDraftBanner(os, false) });
      // The saved entry with a typed-in literal keeps the saved-entry advice.
      const plainDraft = parse(saved);
      ((plainDraft["fallbacks"] as Record<string, unknown>[])[1]!["api"] as Record<string, unknown>)["apiKey"] = "typed-in-0123456789";
      expect(rowOf(view({ draft: plainDraft, savedText: saved, rows, now: NOW, os }), "Plain").banner).toBe(settingsModel.literalDraftBanner(os, true));
    }
    const unsaved = settingsModel.literalDraftBanner("macos", false);
    expect(unsaved).toContain("Save refuses");
    expect(unsaved).toContain("not saved yet");
    expect(unsaved).toContain("Add a provider");
    expect(unsaved).toContain("save it without the key");
    expect(unsaved).toContain("save it without the key and give it its key with Replace key");
    expect(unsaved).toContain("Keychain");
    expect(settingsModel.literalDraftBanner("linux", false)).toContain("key folder");
    // The saved-entry advice stays as it was.
    expect(settingsModel.literalDraftBanner("macos", true)).toBe(
      "This provider has an API key typed into the settings, and Save refuses it: the app never writes a new key into the settings file. Remove it with Edit settings as JSON on Settings → Advanced (or discard your changes), then give the provider its key with Replace key, which keeps it in the Keychain.",
    );
  });

  test("the old item-1 notice is drawn only when the providers list cannot be read; otherwise the row banner owns item 1", () => {
    const apiItem1 = cfgText({ provider: { label: "Main", api: { kind: "anthropic", model: "m", apiKey: PH } } });
    const readable = formHtml(parse(apiItem1));
    expect(readable).not.toContain("Remove the stored key");
    expect(readable).not.toContain("A literal API key is stored in the config file");
    expect(readable).toContain(settingsModel.literalBanner(undefined));
    // Unreadable (two providers share a label): the list shows its message and no rows, so the notice stays.
    const dup = cfgText({
      provider: { label: "Main", api: { kind: "anthropic", model: "m", apiKey: PH } },
      fallbacks: [{ label: "Main", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }],
    });
    const unreadable = formHtml(parse(dup));
    expect(unreadable).toContain("two providers share a label");
    expect(unreadable).toContain("Remove the stored key");
  });
});

/* ── user-directed 2026-10-22: AI providers usability (P1–P5, after the A + D preview) ─────────── */

const uxNoop = () => {};
const listHtml = (props: Record<string, unknown>): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(ProvidersList as any, { props })
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ");
const uxSaved = cfgText({ provider: CLAUDE_CLI, fallbacks: [{ label: "Codex", cli: "codex", argv: ["exec"], promptVia: "stdin" }] });
const uxView = (text: string = uxSaved) => view({ draft: parse(text), savedText: text, rows: null, now: NOW, os: "macos" });

describe("P1: the Add form offers a command-line tool", () => {
  const addHtml = (over: Record<string, unknown> = {}) => listHtml({ view: uxView(), onadd: () => true, addFormOpen: true, ...over });
  const optionsOf = (b: string, from: string): string[] => {
    const at = b.indexOf(from);
    const sel = b.slice(at, b.indexOf("</select>", at));
    return [...sel.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]!.trim());
  };

  // User-directed 2026-10-22 (P-Add): the Kind dropdown is the guided Add's three choices; the command-line tool is
  // "A subscription you already have" (pins moved with it, P1's behaviour kept).
  const choicesOf = (b: string): string[] => [...b.matchAll(/<span class="card-title[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]!);
  test("the choices: a subscription (a command-line tool), an API key — and another Claude account only with a Claude first tool", () => {
    expect(choicesOf(addHtml())).toEqual(["A subscription you already have", "An API key"]);
    expect(choicesOf(addHtml({ loginOf: "default" }))).toEqual(["A subscription you already have", "An API key", "Another Claude account"]);
    expect(addHtml()).not.toContain("<option value=\"anthropic\">Anthropic API</option>");
  });

  test("the subscription choice: a tool choice (Claude Code, Codex, Other…), no model, address, key or login folder", () => {
    const cli = addHtml({ addFormChoice: "subscription" });
    expect(optionsOf(cli, "Tool")).toEqual(["Claude Code (claude)", "Codex (codex)", "Other…"]);
    for (const absent of ["Model", "Address (", "API key (", "Login folder"]) expect({ absent, shown: cli.includes(absent) }).toEqual({ absent, shown: false });
    // A named tool needs nothing more; Other asks for the command and its arguments, one per line.
    expect(cli).not.toContain("Command (");
    const other = addHtml({ addFormChoice: "subscription", addFormTool: "other" });
    expect(other).toContain("Command (its name if it is on your PATH, or its full path)");
    expect(other).toContain("Arguments (one per line; the prompt is passed on standard input)");
    expect(other).toMatch(/<textarea[^>]*>/);
  });

  test("its Test button says it uses a little of the plan, as a command-line row's Test does; an API key's does not", () => {
    const button = (b: string) => b.match(/<button[^>]*class="primary[^"]*"[^>]*>([^<]*)<\/button>/)?.[1];
    expect(button(addHtml({ addFormChoice: "subscription" }))).toBe(`Add and test — ${CLI_TEST_NOTE}`);
    expect(button(addHtml({ addFormChoice: "login", loginOf: "default" }))).toBe(`Add and test — ${CLI_TEST_NOTE}`);
    expect(button(addHtml({ addFormChoice: "api", addFormService: "anthropic" }))).toBe("Add and test");
    expect(button(addHtml({ addFormChoice: "api", addFormService: "other" }))).toBe("Add and test");
    // The row's own Test says the same words.
    expect(rowOf(uxView(), "Codex").test.text).toBe(`Test — ${CLI_TEST_NOTE}`);
  });

  test("the form hands its tool, command and arguments to the parent, and a command-line add no key", () => {
    const src = codeOf(readFileSync(new URL("../src/lib/ProvidersList.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    expect(src).toContain("const form: AddForm = guidedForm(shownChoice, { label, tool, command, args, service, model, address: baseUrl, configDir });");
    expect(src).toContain('if (!onadd(form, guidedTakesKey(shownChoice, service) ? key : "")) return;');
  });
});

describe("P2: the first provider's Command is the same tool choice: Claude Code, Codex or Other…", () => {
  const withProvider = (provider: Draft): Draft => ({ ...parse(FULL), provider });
  const cmd = () => field("provider.cli");
  const sm = settingsModel as unknown as Record<string, unknown>;
  const COMMAND = () => sm["TOOL_COMMAND_FIELD"] as Field;
  const ARGS = () => sm["TOOL_ARGS_FIELD"] as Field;

  test("Command is a choice of tools, not a text box", () => {
    expect(cmd().kind).toBe("tool");
    expect(cmd().path).toEqual(["provider", "cli"]);
  });

  test("a file shows as the tool it is: Claude only by the engine's `claudeShaped`, with that tool's exact arguments", () => {
    const cases: [Draft, string][] = [
      [CLAUDE_CLI, "claude"],
      [{ ...CLAUDE_CLI, cli: "/opt/homebrew/bin/claude" }, "claude"],
      [{ ...CLAUDE_CLI, cli: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd" }, "claude"],
      [{ cli: "codex", argv: ["exec"], promptVia: "stdin" }, "codex"],
      [{ cli: "/usr/local/bin/codex", argv: ["exec"], promptVia: "stdin" }, "codex"],
      // Neither preset: its own values, as Other.
      [{ ...CLAUDE_CLI, argv: ["-p", "--model", "sonnet"] }, "other"],
      [{ ...CLAUDE_CLI, promptVia: "arg" }, "other"],
      [{ ...CLAUDE_CLI, cli: "claude-wrapper" }, "other"],
      [{ cli: "codex", argv: ["-p"], promptVia: "stdin" }, "other"],
      [{ cli: "gemini", argv: ["-p"], promptVia: "stdin" }, "other"],
    ];
    for (const [provider, shown] of cases) expect({ provider, shown: readField(withProvider(provider), cmd()) }).toEqual({ provider, shown });
    // The Claude rule is the engine's (`claudeShaped`; its Windows spellings are pinned in provider-list.check.ts): the
    // path counts, the wrapper does not.
    expect([claudeShaped("/opt/homebrew/bin/claude"), claudeShaped("claude-wrapper")]).toEqual([true, false]);
  });

  test("choosing a tool sets the command AND its arguments: claude → codex no longer keeps -p", () => {
    const d = withProvider({ ...CLAUDE_CLI, timeoutMs: 600000, credential: "subscription", accounts: [{ label: "work" }] });
    expect(writeField(d, cmd(), "codex")).toBeNull();
    expect(d["provider"]).toEqual({ cli: "codex", argv: ["exec"], promptVia: "stdin", timeoutMs: 600000, credential: "subscription", accounts: [{ label: "work" }] });
    // In place: every key keeps its position.
    expect(Object.keys(d["provider"] as Draft)).toEqual(["cli", "argv", "promptVia", "timeoutMs", "credential", "accounts"]);
    expect(readField(d, cmd())).toBe("codex");
    expect(writeField(d, cmd(), "claude")).toBeNull();
    expect(getPath(d, ["provider", "cli"])).toBe("claude");
    expect(getPath(d, ["provider", "argv"])).toEqual(["-p"]);
    // The engine takes what each choice writes.
    for (const tool of ["claude", "codex"]) {
      const e = withProvider({ ...CLAUDE_CLI });
      writeField(e, cmd(), tool);
      expect(validateConfig(e as never, "/nonexistent-home").provider).toMatchObject({ argv: tool === "codex" ? ["exec"] : ["-p"], promptVia: "stdin" });
    }
  });

  test("a path to the same tool is kept when its tool is chosen; a different tool's path is not", () => {
    const d = withProvider({ cli: "/opt/homebrew/bin/claude", argv: ["-p", "--model", "sonnet"], promptVia: "arg" });
    expect(writeField(d, cmd(), "claude")).toBeNull();
    expect(d["provider"]).toEqual({ cli: "/opt/homebrew/bin/claude", argv: ["-p"], promptVia: "stdin" });
    expect(writeField(d, cmd(), "codex")).toBeNull();
    expect(getPath(d, ["provider", "cli"])).toBe("codex");
  });

  test("Other changes nothing by itself; anything else is refused and changes nothing", () => {
    const d = withProvider({ ...CLAUDE_CLI });
    const before = JSON.stringify(d);
    expect(writeField(d, cmd(), "other")).toBeNull();
    expect(JSON.stringify(d)).toBe(before);
    expect(writeField(d, cmd(), "bogus")).toBe("must be Claude Code, Codex or Other…");
    expect(writeField(d, cmd(), "")).toBe("must be Claude Code, Codex or Other…");
    expect(JSON.stringify(d)).toBe(before);
  });

  test("Other's command and arguments write the first provider's own command and arguments, one per line", () => {
    expect([COMMAND().path, COMMAND().kind, COMMAND().required]).toEqual([["provider", "cli"], "text", true]);
    expect([ARGS().path, ARGS().kind, ARGS().required]).toEqual([["provider", "argv"], "lines", true]);
    // Their own ids: the Advanced page's Arguments field is drawn too, and an id is one element.
    expect([COMMAND().id, ARGS().id]).toEqual(["provider.cli.other", "provider.argv.other"]);
    const d = withProvider({ ...CLAUDE_CLI });
    expect(writeField(d, COMMAND(), " /opt/bin/gemini ")).toBeNull();
    expect(writeField(d, ARGS(), "-p\n --model x y \n")).toBeNull();
    expect(d["provider"]).toEqual({ cli: "/opt/bin/gemini", argv: ["-p", "--model x y"], promptVia: "stdin" });
    expect(readField(d, cmd())).toBe("other");
    for (const f of [COMMAND(), ARGS()]) {
      const found = ["src/", ".ts", "argv", "no-op", "`"].filter((b) => f.help.includes(b));
      expect({ id: f.id, found }).toEqual({ id: f.id, found: [] });
    }
  });

  test("the form draws the choice; Other shows its command and arguments, with the file's own values", () => {
    const providers = (d: Draft) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return render(SettingsForm as any, { props: { draft: d, errors: {}, onfield: () => {}, onnotifycommand: () => {}, ondefault: () => {}, onremovekey: () => {}, sections: ["Provider (command-line tool)", "Provider (API)"] } })
        .body.replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\s+/g, " ");
    };
    const select = (b: string) => b.slice(b.indexOf('<select id="f-provider.cli"'), b.indexOf("</select>", b.indexOf('<select id="f-provider.cli"')));
    const preset = providers(withProvider({ ...CLAUDE_CLI }));
    expect([...select(preset).matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]!.trim())).toEqual(["Claude Code (claude)", "Codex (codex)", "Other…"]);
    expect(select(preset)).toMatch(/<option value="claude"[^>]*selected/);
    expect(preset).not.toContain('id="f-provider.cli.other"');
    expect(preset).not.toContain('id="f-provider.argv.other"');
    const other = providers(withProvider({ cli: "gemini", argv: ["-p", "--yolo"], promptVia: "stdin" }));
    expect(select(other)).toMatch(/<option value="other"[^>]*selected/);
    expect(other).toMatch(/<input id="f-provider\.cli\.other"[^>]*value="gemini"/);
    expect(other).toMatch(/<textarea id="f-provider\.argv\.other"[^>]*>-p\n?--yolo<\/textarea>|<textarea id="f-provider\.argv\.other"[^>]*>-p --yolo<\/textarea>/);
  });
});

describe("P3: Credential offers two choices in words, and its help says only what the engine does", () => {
  const cred = () => field("provider.credential");
  const withProvider = (provider: Draft): Draft => ({ ...parse(FULL), provider });
  const providersPage = (d: Draft) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(SettingsForm as any, { props: { draft: d, errors: {}, onfield: () => {}, onnotifycommand: () => {}, ondefault: () => {}, onremovekey: () => {}, sections: ["Provider (command-line tool)", "Provider (API)"] } })
      .body.replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, " ");
  const select = (b: string) => b.slice(b.indexOf('<select id="f-provider.credential"'), b.indexOf("</select>", b.indexOf('<select id="f-provider.credential"')));
  const options = (b: string) => [...select(b).matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]!.trim()]);

  test("two choices, worded for a person — no \"Engine default\" beside \"subscription\", which the engine reads the same", () => {
    const b = providersPage(withProvider({ ...CLAUDE_CLI }));
    expect(options(b)).toEqual([
      ["subscription", "Its own login (subscription)"],
      ["env-api-key", "The API key in my environment"],
    ]);
  });

  test("absent shows as the first choice and is not written until the user changes it", () => {
    const absent = withProvider({ ...CLAUDE_CLI });
    expect(select(providersPage(absent))).toMatch(/<option value="subscription"[^>]*selected/);
    expect(select(providersPage(withProvider({ ...CLAUDE_CLI, credential: "env-api-key" })))).toMatch(/<option value="env-api-key"[^>]*selected/);
    // Drawn, not written: the draft still has no credential, and an untouched form saves nothing.
    expect(hasPath(absent, ["provider", "credential"])).toBe(false);
    expect(formSubmission(absent, out(absent), {})).toEqual({ kind: "unchanged" });
    // A change writes the chosen value, either one.
    expect(writeField(absent, cred(), "env-api-key")).toBeNull();
    expect(getPath(absent, ["provider", "credential"])).toBe("env-api-key");
    expect(writeField(absent, cred(), "subscription")).toBeNull();
    expect(getPath(absent, ["provider", "credential"])).toBe("subscription");
    // The other optional choices keep their "Engine default", exactly as before.
    expect(formHtml(parse(FULL))).toContain("Engine default");
  });

  test("the help is the engine's rule: ANTHROPIC_API_KEY withheld from the tool unless the second choice — Claude Code then uses its login; a tool that does not read it is unaffected", () => {
    const harden = readFileSync(new URL("../../src/harden.ts", import.meta.url), "utf8");
    expect(harden).toContain('const WITHHELD_ENV = ["ANTHROPIC_API_KEY"] as const;');
    // Withheld from EVERY command-line tool, not only Claude (the credential decision is not claude-specific).
    expect(harden).toContain('const envDelete = cfg.credential !== "env-api-key" ? WITHHELD_ENV : undefined;');
    expect(cred().help).toBe(
      "Its own login keeps the ANTHROPIC_API_KEY environment variable away from the tool, so Claude Code uses your subscription and a key there is never billed by accident; the other choice passes that key through. A tool that does not read that variable, such as Codex, works the same either way.",
    );
  });
});

// User-directed 2026-10-22 (P-A): P4's retitled first-provider box is REMOVED with the box (its fields are row 1's own
// now, settings-layout.check.ts); its pins moved here to say so, and to keep what P4 established true.
describe("P-A (replaces P4): no first-provider box; row 1 holds its fields; the note under the list says what is true", () => {
  const sm = settingsModel as unknown as Record<string, unknown>;
  const page = (d: Draft) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(SettingsForm as any, { props: { draft: d, errors: {}, onfield: () => {}, onnotifycommand: () => {}, ondefault: () => {}, onremovekey: () => {}, sections: ["Provider (command-line tool)", "Provider (API)"] } })
      .body.replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, " ");
  const legendsOf = (b: string) => [...b.matchAll(/<legend[^>]*><h4[^>]*>([^<]*)<\/h4><\/legend>/g)].map((m) => m[1]);
  const NOTE = "Only the first provider's settings are changed here. To change another's tool, account, model or address, move it to the top of the list, or use Edit settings as JSON on Settings → Advanced.";

  test("P4's heading, help and note are gone from the model and the page", () => {
    for (const gone of ["providerSectionHeading", "FIRST_PROVIDER_CLI_HELP", "FIRST_PROVIDER_NOTE"]) expect({ gone, there: gone in sm }).toEqual({ gone, there: false });
    const b = page(parse(FULL));
    expect(legendsOf(b)).toEqual(["Providers, in order"]);
    expect(b).not.toContain("First provider:");
    expect(b).not.toContain("These settings apply to the first provider");
  });

  test("the true note under the list — and moving a row to the top does make its settings row 1's", () => {
    const mixed = { provider: { ...CLAUDE_CLI }, fallbacks: [{ label: "API", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }] };
    const b = page(parse(cfgText(mixed)));
    expect(b).not.toContain("Switching between a command-line provider and an API provider");
    expect(b).toMatch(new RegExp(`<p class="muted[^"]*">${NOTE.replace(/[.()→]/g, "\\$&")}</p>`));
    // True: a list mixing kinds is valid (the engine refuses only ONE entry holding both `api` and `cli`)...
    expect(() => validateConfig(structuredClone(mixed) as never, "/nonexistent-home")).not.toThrow();
    expect(() => validateConfig({ provider: { ...CLAUDE_CLI, api: { kind: "anthropic", model: "m" } } } as never, "/nonexistent-home")).toThrow(/cannot be combined/);
    // ...and moving the API row to the top makes it the first provider: its row now holds the API fields.
    const d = parse(cfgText(mixed));
    expect(b).toContain('id="f-provider.credential"');
    expect(b).not.toContain('id="f-provider.api.model"');
    expect(moveProvider(d, 1, 0)).toBeNull();
    expect(sectionsFor(d).map((s) => s.title)).toContain("Provider (API)");
    const moved = page(d);
    const row1 = moved.slice(moved.indexOf('id="prov-row-0"'), moved.indexOf('id="prov-row-1"'));
    expect(row1).toContain('id="f-provider.api.model"');
    expect(moved).not.toContain('id="f-provider.credential"');
  });
});

describe("P5: the login folder is drawn only where the engine accepts one — and never hidden while one is written", () => {
  const CODEX_CLI = { cli: "codex", argv: ["exec"], promptVia: "stdin" };
  const text = cfgText({
    provider: { ...CLAUDE_CLI, accounts: [{ label: "work" }, { label: "home", configDir: "~/.claude-home" }] },
    fallbacks: [
      { label: "Brew", ...CLAUDE_CLI, cli: "/opt/homebrew/bin/claude", configDir: "~/.claude-brew" },
      { label: "Codex", ...CODEX_CLI },
      { label: "Stray", ...CODEX_CLI, configDir: "~/.codex-x" },
      { label: "API", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } },
    ],
  });
  const v = () => view({ draft: parse(text), savedText: text, rows: null, now: NOW, os: "macos" });
  const folderOf = (label: string) => (rowOf(v(), label) as unknown as Record<string, unknown>)["folder"];

  test("the row says whether its folder is drawn: a Claude tool (the engine's `claudeShaped`), or any entry already holding one", () => {
    expect(["work", "home", "Brew", "Codex", "Stray", "API"].map((l) => [l, folderOf(l)])).toEqual([
      ["work", true],
      ["home", true],
      ["Brew", true],
      ["Codex", false],
      ["Stray", true],
      ["API", false],
    ]);
  });

  test("non-vacuous: the engine drops the stray folder on Codex, so the row that holds it keeps its field (and the engine's word on it)", () => {
    const home = "/nonexistent-home";
    const list = resolveProviderList(validateConfig(JSON.parse(text), home), home, {}, () => true);
    expect(list.dropped.map((d) => [d.label, d.reason])).toEqual([["Stray", "config-dir"]]);
  });

  test("drawn: Claude rows and the stray one carry the field; the clean Codex row and the API row do not", () => {
    const b = listHtml({ view: v(), onfolder: uxNoop });
    const rowAt = (label: string) => {
      const start = b.indexOf(`<span class="label svelte-`, b.indexOf(`>${label}</span>`) - 60);
      return b.slice(start, b.indexOf("</li>", start));
    };
    for (const [label, drawn] of [["work", true], ["home", true], ["Brew", true], ["Codex", false], ["Stray", true], ["API", false]] as const) {
      expect({ label, drawn: rowAt(label).includes("Login folder (Claude logins only") }).toEqual({ label, drawn });
    }
    expect(rowAt("Stray")).toMatch(/value="~\/\.codex-x"/);
    const src = codeOf(readFileSync(new URL("../src/lib/ProvidersList.svelte", import.meta.url), "utf8")).replace(/\s+/g, " ");
    expect(src).toContain("{#if row.folder && onfolder !== undefined}");
  });
});
