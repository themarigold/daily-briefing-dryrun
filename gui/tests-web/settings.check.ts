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
import { readFileSync } from "node:fs";
import { render } from "svelte/server";

import { describeFailure, REDACTED_API_KEY, type SaveOutcome } from "../src/lib/files";
import {
  allQuotes,
  ARGV_NOTE,
  fieldIsLive,
  formSubmission,
  getPath,
  hasPath,
  isCustomNotify,
  isDirty,
  jsonEqual,
  keepSettings,
  keptAfterSave,
  liveErrors,
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

const ENGINE = new URL("../../", import.meta.url).pathname;
const FULL = readFileSync(new URL("../src-tauri/tests/fixtures/config-full.json", import.meta.url), "utf8");
const API = readFileSync(new URL("../src-tauri/tests/fixtures/config-api.json", import.meta.url), "utf8");
const PLACEHOLDER = "(a literal API key is stored in config.json; Daily Briefing never displays it)";

test("the TS wire contract's placeholder and error kinds are Rust's", () => {
  const rust = readFileSync(new URL("../src-tauri/src/config_save.rs", import.meta.url), "utf8");
  expect(REDACTED_API_KEY).toBe(PLACEHOLDER);
  expect(rust.replace(/\s+/g, " ")).toContain(`"${PLACEHOLDER}"`);
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
  expect(rust).toContain('if text.starts_with("number out of range")');
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
    (getPath(draft, ["provider", "accounts"]) as Draft[])[1]!["x-note"] = "keep me";
    expect(readField(draft, field("provider.accounts"))).toBe("primary\nbackup = ~/.claude-backup");
    expect(writeField(draft, field("provider.accounts"), "backup = ~/.other\nprimary\n")).toBeNull();
    expect(getPath(draft, ["provider", "accounts"])).toEqual([
      { label: "backup", configDir: "~/.other", "x-note": "keep me" },
      { label: "primary" },
    ]);
    expect(writeField(draft, field("provider.accounts"), " = /x")).toContain("no label");

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
    expect(writeField(draft, field("provider.cli"), "")).toBeNull();
    expect(getPath(draft, ["provider", "cli"])).toBe("");
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
    expect(body).toContain("A literal API key is stored in the config file");
    expect(body).toContain("Remove the stored key");
    expect(body).not.toContain(PLACEHOLDER);
    expect(body).not.toContain("SENTINEL");
    expect(body).toContain("Neither this app nor the background scheduler passes your shell");
    removeStoredApiKey(draft);
    expect(hasPath(draft, ["provider", "api", "apiKey"])).toBe(false);
    expect(formHtml(draft)).not.toContain("Remove the stored key");
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
    // And the form shows them.
    const body = formHtml(parse(FULL));
    expect(body).toContain("per-repo project-root globs; [] = force single-unit despite a manifest");
  });

  test("field errors and engine values stay text", () => {
    const draft = parse(FULL);
    draft.morningTime = HOSTILE;
    const body = formHtml(draft, { lookbackCapDays: `must be a number ${HOSTILE}` });
    expect(body).not.toContain("<img");
    expect(body).toContain('class="field-error');
  });
});

describe("the save decision (review round 1)", () => {
  test("W5: a live field error blocks the save; a hidden or disabled field's does not", () => {
    const draft = parse(FULL);
    expect(formSubmission(draft, FULL, { lookbackCapDays: "must be a number" })).toEqual({
      kind: "blocked",
      message: "Not saved: fix the fields marked above first.",
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
    const svelte = readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(svelte).toContain("const sent = { base: doc.base, text };");
    expect(svelte).toContain("const result = await configSave(text, sent.base); answered = result.kind;");
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
    expect(describeFailure({ kind: "apiKeyChanged" })).toContain("cannot be set or changed from this app");
    expect(describeFailure({ kind: "conflict", path: "/c" })).toContain("changed on disk after it was loaded");
    expect(describeFailure({ kind: "noConfig", path: "/c" })).toContain("daily-briefing init");
  });
});
