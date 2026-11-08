// test/provider.scrub.test.ts — `provider key scrub-backup --json` (provider-fallback plan P2-M3-T2; spec r9 §4 secrets,
// §6 "Finalization is retryable"), driven through the real `providerMain`.
//
// After the app saves a migrated reference it calls `scrub-backup` (inside the Rust `KeyScrubBackup` command, which
// holds `ConfigSaver.lock`, so no save rewrites `.bak` meanwhile — P3-M1-T1), and on open it runs it again whenever
// `.bak` holds such a literal. The scrub removes from `<config>.bak` (gui/src-tauri/src/config_save.rs:705, the
// config's own name plus `.bak`) every LITERAL key — `provider.api.apiKey`, `fallbacks[i].api.apiKey` — that the
// current saved config no longer holds, atomically (temp + rename beside it), preserving `.bak`'s mode. This file pins:
// which literals go and which stay, that a no-op writes nothing, that an absent `.bak` is never created, the refusals
// (a `.bak` that is a symlink or not a file, not JSON or too large; a current config missing or invalid), the atomic
// write (mode kept, nothing staged left behind, a swapped `.bak` never overwritten), the dead-pid temp sweep, the read
// bound, and that no key, label or `.bak` byte reaches output. Since the P2-M3 checkpoint, also: a literal that was its
// entry's only key source becomes the unset sentinel `KEY_MOVED_ENV` (so a restored `.bak` is a named `key-unavailable`
// skip — through `resolveApiKey`, the transport and a walk — never a read of the kind's default variable), the read's
// O_NOFOLLOW open and inode check, the strict UTF-8 decode, `otherCopies` for a hard-linked `.bak`, and the timeout's
// `reason`.
//
// The config is always an injected temp file (`configFile`), never the real one; the file imports the isolation
// fixture (CONFIG_TRIGGERS: `providerMain(`). No key store is reached: the scrub never stores or deletes a key.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, afterEach, beforeAll } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveApiKey, DEFAULT_KEY_ENV } from "../src/apiKey";
import { validateConfig } from "../src/config";
import { resolveProviderList } from "../src/providerList";
import { runCore } from "../src/core";
import { failoverReason } from "../src/failover";
import { ProviderError, type Config } from "../src/types";
import { AnthropicApiProvider } from "../src/providers/anthropic";
import { buildRepo } from "./fixtures/build-repo";
import { startFakeApi, okJson, type FakeApi } from "./helpers/fakeApi";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { providerMain, BACKUP_MAX_BYTES, KEY_MOVED_ENV, type ProviderCliDeps } from "../src/providerCli";
import { BRIEFING, freshStateDir, tempDir, walkDeps } from "./helpers/walk";

guardNetworkForThisFile();

const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
afterAll(() => { process.env.DAILY_BRIEFING_STATE_DIR = prevState; });

/** Literal keys, distinct so "which one went" is observable. */
const OLD1 = "sk-ant-api03_ScRuB.item1-old~0123+456/789=abc";
const OLD2 = "sk-or-v1_ScRuB.fallback-old~9876+543/210=zyx";
const KEPT = "sk-ant-api03_ScRuB.still-held~1111+222/333=kpt";
/** Labels shaped like secrets: never echoed (hub Q25). */
const LABEL1 = "Item1-label-sk-LABELSECRET-one";
const LABEL2 = "Fallback-label-sk-LABELSECRET-two";
/** A pid above every platform's pid_max (macOS 99 999, Linux at most 2^22): `kill(pid, 0)` answers ESRCH. */
const DEAD_PID = 2147483646;

const anthropic = (key: Record<string, unknown>) => ({ api: { kind: "anthropic", model: "m", ...key } });
const REF = { apiKeyCommand: ["/nonexistent/key-helper", "--print"] };

/** The `.bak` of the usual migrate flow: item 1's and a fallback's old literals, a literal the current config still
 *  holds, and fields around them that must survive untouched. */
const BAK = {
  repos: [], morningTime: "07:20",
  provider: { label: LABEL1, ...anthropic({ apiKey: OLD1, maxTokens: 900 }) },
  fallbacks: [
    { label: LABEL2, ...anthropic({ apiKeyEnv: "SOME_VAR", apiKey: OLD2 }) },
    { label: "F-kept", ...anthropic({ apiKey: KEPT }) },
    { label: "F-cli", cli: "/nonexistent/claude", argv: [], promptVia: "stdin" },
  ],
};
/** The current config after the app saved the migrated references: OLD1 and OLD2 are gone, KEPT is still a literal. */
const CURRENT = {
  repos: [], morningTime: "07:20",
  provider: { label: LABEL1, ...anthropic({ ...REF, maxTokens: 900 }) },
  fallbacks: [
    { label: LABEL2, ...anthropic({ apiKeyEnv: "SOME_VAR", ...REF }) },
    { label: "F-kept", ...anthropic({ apiKey: KEPT }) },
    { label: "F-cli", cli: "/nonexistent/claude", argv: [], promptVia: "stdin" },
  ],
};

/** A config folder holding `config.json` (0600) and, unless `bak` is undefined, `config.json.bak` (mode `bakMode`). */
function folder(current: unknown, bak?: unknown, bakMode = 0o600): { file: string; bak: string; dir: string } {
  const dir = tempDir("dba-scrub-cfg-");
  const file = join(dir, "config.json");
  if (current !== undefined) { writeFileSync(file, typeof current === "string" ? current : JSON.stringify(current, null, 2)); chmodSync(file, 0o600); }
  const bakPath = `${file}.bak`;
  if (bak !== undefined) { writeFileSync(bakPath, typeof bak === "string" ? bak : `${JSON.stringify(bak, null, 2)}\n`); chmodSync(bakPath, bakMode); }
  return { file, bak: bakPath, dir };
}

/** Everything about the folder a write could change: each entry's kind, bytes, mode, mtime and inode. */
function snapshot(dir: string): string {
  return JSON.stringify(readdirSync(dir).sort().map((n) => {
    const st = lstatSync(join(dir, n));
    return [n, st.isFile() ? readFileSync(join(dir, n), "base64") : st.isSymbolicLink() ? "symlink" : "other", st.mode, st.mtimeMs, st.ino];
  }));
}

const home = tempDir("dba-scrub-home-");
async function scrub(file: string, deps: ProviderCliDeps = {}, args: string[] = []) {
  const out: string[] = [], err: string[] = [];
  const code = await providerMain(["key", "scrub-backup", ...args, "--json"], { configFile: file, home, env: {}, out: (s) => out.push(s), err: (s) => err.push(s), isTTY: false, ...deps });
  const last = out.at(-1);
  return { code, out, err, text: [...out, ...err].join("\n"), json: last !== undefined ? JSON.parse(last) as Record<string, unknown> : undefined };
}
const SECRETS = [OLD1, OLD2, KEPT, "LABELSECRET", "ScRuB"];
const leaks = (text: string): string[] => SECRETS.filter((s) => text.includes(s));

describe("provider key scrub-backup --json: removes from .bak only the literals the current config no longer holds", () => {
  test("removes the two literals the config no longer holds, keeps the one it still holds, and leaves every other field as it was", async () => {
    freshStateDir();
    const f = folder(CURRENT, BAK);
    const r = await scrub(f.file);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ schemaVersion: 1, ok: true, removed: 2 });
    const after = JSON.parse(readFileSync(f.bak, "utf8"));
    const expected = structuredClone(BAK) as unknown as { provider: { api: Record<string, unknown> }; fallbacks: { api: Record<string, unknown> }[] };
    // Item 1's literal was its ONLY key source: it becomes the named, unset sentinel variable (spec §6 — a restored .bak
    // is a named `key-unavailable` skip, never a silent read of the kind's default variable). The fallback has another
    // source (`apiKeyEnv: SOME_VAR`), so its literal is simply deleted.
    delete expected.provider.api.apiKey;
    expected.provider.api.apiKeyEnv = KEY_MOVED_ENV;
    delete expected.fallbacks[0]!.api.apiKey;
    expect(after).toEqual(expected);
    // Never blanked: the validator refuses `apiKey: ""` (src/config.ts), so a restored .bak stays loadable.
    expect("apiKey" in after.provider.api).toBe(false);
    expect("apiKey" in after.fallbacks[0].api).toBe(false);
    expect(after.fallbacks[0].api.apiKeyEnv).toBe("SOME_VAR");
    expect(after.fallbacks[1].api.apiKey).toBe(KEPT);
    expect(readFileSync(f.bak, "utf8").endsWith("}\n")).toBe(true);
    // The current config is read, never written.
    expect(JSON.parse(readFileSync(f.file, "utf8"))).toEqual(CURRENT);
    expect(leaks(r.text)).toEqual([]);
    expect(r.err).toEqual([]);
  });

  test("a literal the config still holds ANYWHERE — another entry, an argv element, or the same key with surrounding whitespace — is kept", async () => {
    freshStateDir();
    const bak = { repos: [], provider: anthropic({ apiKey: OLD1 }), fallbacks: [{ label: "a", ...anthropic({ apiKey: OLD2 }) }, { label: "b", ...anthropic({ apiKey: ` ${KEPT}\n` }) }] };
    const current = {
      repos: [], provider: anthropic({ apiKeyCommand: ["/nonexistent/echo", OLD1] }),
      // whitespace on EITHER side: the config's OLD2 is padded, the backup's KEPT is
      fallbacks: [{ label: "x", ...anthropic({ apiKey: `\t${OLD2} ` }) }, { label: "b", ...anthropic({ apiKey: KEPT }) }],
    };
    const f = folder(current, bak);
    const before = snapshot(f.dir);
    const r = await scrub(f.file);
    expect(r.json).toEqual({ schemaVersion: 1, ok: true, removed: 0 });
    // A no-op writes NOTHING: same bytes, same mtime, same inode.
    expect(snapshot(f.dir)).toBe(before);
  });

  test("an absent .bak is a no-op: removed 0, and no .bak is created", async () => {
    freshStateDir();
    const f = folder(CURRENT);
    const before = snapshot(f.dir);
    const r = await scrub(f.file);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ schemaVersion: 1, ok: true, removed: 0 });
    expect(existsSync(f.bak)).toBe(false);
    expect(snapshot(f.dir)).toBe(before);
  });

  test("a .bak with no literal at all (references only, or a CLI) is a no-op", async () => {
    freshStateDir();
    const f = folder(CURRENT, CURRENT_NO_LITERAL());
    const before = snapshot(f.dir);
    expect((await scrub(f.file)).json).toEqual({ schemaVersion: 1, ok: true, removed: 0 });
    expect(snapshot(f.dir)).toBe(before);
  });

  test("odd shapes in .bak — fallbacks not a list, api not an object, a non-string or blank apiKey — are left alone, not refused", async () => {
    freshStateDir();
    for (const bak of [
      { provider: { api: "nope" }, fallbacks: { 0: { api: { apiKey: OLD2 } } } },
      { provider: { api: { apiKey: 12345678 } }, fallbacks: [null, 7, { api: [OLD2] }, { api: { apiKey: "   " } }] },
      [OLD1],
      '"just a string"',   // a JSON string document (folder() writes a string verbatim)
    ]) {
      const f = folder(CURRENT, bak);
      const before = snapshot(f.dir);
      const r = await scrub(f.file);
      expect(`${JSON.stringify(bak)} → ${JSON.stringify(r.json)}`).toBe(`${JSON.stringify(bak)} → ${JSON.stringify({ schemaVersion: 1, ok: true, removed: 0 })}`);
      expect(snapshot(f.dir)).toBe(before);
    }
  });
});

function CURRENT_NO_LITERAL() {
  return { repos: [], provider: anthropic(REF), fallbacks: [{ label: "F-cli", cli: "/nonexistent/claude", argv: [], promptVia: "stdin" }] };
}

describe("the write: atomic, mode-preserving, never through a symlink, never over a swapped .bak", () => {
  for (const mode of [0o600, 0o400, 0o640]) {
    test(`keeps .bak's mode (${mode.toString(8)}), replaces it by rename (a new inode), and leaves nothing staged beside it`, async () => {
      freshStateDir();
      const f = folder(CURRENT, BAK, mode);
      const ino = statSync(f.bak).ino;
      const r = await scrub(f.file);
      expect(r.json).toEqual({ schemaVersion: 1, ok: true, removed: 2 });
      expect(statSync(f.bak).mode & 0o7777).toBe(mode);
      expect(statSync(f.bak).ino).not.toBe(ino);
      expect(readdirSync(f.dir).sort()).toEqual(["config.json", "config.json.bak"]);
    });
  }

  test("a symlinked .bak is refused (config) and neither the link nor its target changes", async () => {
    freshStateDir();
    const f = folder(CURRENT);
    const target = join(tempDir("dba-scrub-target-"), "real.bak");
    writeFileSync(target, JSON.stringify(BAK)); chmodSync(target, 0o600);
    symlinkSync(target, f.bak);
    const before = [snapshot(f.dir), readFileSync(target, "utf8"), statSync(target).mtimeMs];
    const r = await scrub(f.file);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ schemaVersion: 1, ok: false, code: "config" });
    // Refused by the lstat, before any open (the O_NOFOLLOW open is the second line, for a link swapped in after it).
    expect(String(r.json!.error)).toContain("not a regular file");
    expect([snapshot(f.dir), readFileSync(target, "utf8"), statSync(target).mtimeMs]).toEqual(before);
    expect(leaks(r.text)).toEqual([]);
  });

  test("a .bak that is a directory is refused (config), nothing written", async () => {
    freshStateDir();
    const f = folder(CURRENT);
    mkdirSync(f.bak);
    const before = snapshot(f.dir);
    const r = await scrub(f.file);
    expect(r.json).toMatchObject({ ok: false, code: "config" });
    expect(String(r.json!.error)).toContain("not a regular file");
    expect(snapshot(f.dir)).toBe(before);
  });

  test("a .bak swapped for another file between the read and the rename is never overwritten: refused, the new .bak kept, nothing staged left", async () => {
    freshStateDir();
    const f = folder(CURRENT, BAK);
    const other = `${JSON.stringify({ ...BAK, morningTime: "06:00" })}\n`;
    const r = await scrub(f.file, {
      beforeBackupRename: async () => { writeFileSync(join(f.dir, "swap"), other); chmodSync(join(f.dir, "swap"), 0o600); renameSync(join(f.dir, "swap"), f.bak); },
    });
    // `reason: "changed"` (P3-M4 checkpoint): the app retries it, by the field, never by the message.
    expect(r.json).toMatchObject({ ok: false, code: "config", reason: "changed" });
    expect(readFileSync(f.bak, "utf8")).toBe(other);
    expect(readdirSync(f.dir).sort()).toEqual(["config.json", "config.json.bak"]);
    expect(leaks(r.text)).toEqual([]);
  });

  test("a .bak removed before the rename is not re-created", async () => {
    freshStateDir();
    const f = folder(CURRENT, BAK);
    const { unlinkSync } = await import("node:fs");
    const r = await scrub(f.file, { beforeBackupRename: async () => { unlinkSync(f.bak); } });
    expect(r.json).toMatchObject({ ok: false, code: "config", reason: "changed" });
    expect(readdirSync(f.dir).sort()).toEqual(["config.json"]);
  });

  test("a failed rename is write-failed: .bak unchanged, the staged copy (which holds the literals) removed", async () => {
    freshStateDir();
    const f = folder(CURRENT, BAK);
    const before = snapshot(f.dir);
    const r = await scrub(f.file, { beforeBackupRename: async () => { throw new Error(`EIO ${OLD1}`); } });
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, code: "write-failed" });
    expect(snapshot(f.dir)).toBe(before);
    expect(leaks(r.text)).toEqual([]);
  });

  test("a dead writer's staged scrub copy beside .bak is swept (it holds literals); a live one's, and anything else, is kept", async () => {
    freshStateDir();
    const f = folder(CURRENT);
    const dead = `.config.json.bak.scrub-${DEAD_PID}-abc123`;
    const live = `.config.json.bak.scrub-${process.pid}-def456`;
    const lookalike = `.config.json.bak.scrub-${DEAD_PID}-abc123.keep`;
    for (const n of [dead, live, lookalike]) writeFileSync(join(f.dir, n), OLD1);
    const r = await scrub(f.file);
    expect(r.json).toEqual({ schemaVersion: 1, ok: true, removed: 0 });
    expect(readdirSync(f.dir).sort()).toEqual([live, lookalike, "config.json"].sort());
  });
});

describe("refusals: nothing written, nothing echoed", () => {
  const refused = async (f: { file: string; dir: string }, deps: ProviderCliDeps = {}) => {
    const before = snapshot(f.dir);
    const r = await scrub(f.file, deps);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ schemaVersion: 1, ok: false, code: "config" });
    expect(snapshot(f.dir)).toBe(before);
    expect(leaks(r.text)).toEqual([]);
    return r;
  };

  test("a .bak that is not JSON is refused without echoing a byte of it", async () => {
    freshStateDir();
    await refused(folder(CURRENT, `{"provider": {"api": {"apiKey": "${OLD1}"`));
  });

  test(`a .bak larger than BACKUP_MAX_BYTES (${BACKUP_MAX_BYTES}) is refused`, async () => {
    freshStateDir();
    const r = await refused(folder(CURRENT, JSON.stringify({ ...BAK, pad: "x".repeat(BACKUP_MAX_BYTES) })));
    expect(String(r.json!.error)).toContain("larger than");   // the cap, not a truncated read failing to parse
  });

  test("a missing current config is refused — it cannot say which literals it still holds — and .bak keeps all of them", async () => {
    freshStateDir();
    const f = folder(undefined, BAK);
    expect(String((await refused(f)).json!.error)).toContain("no config at");
    expect(readFileSync(f.bak, "utf8")).toContain(OLD1);
  });

  test("a current config that is not JSON, or not valid, is refused", async () => {
    freshStateDir();
    await refused(folder(`{"provider": ${OLD1}`, BAK));
    await refused(folder({ repos: [], provider: { label: LABEL1, api: { kind: "anthropic", model: "m", apiKey: "" } } }, BAK));
  });

  test("an unreadable current config is refused", async () => {
    freshStateDir();
    await refused(folder(CURRENT, BAK), { readConfig: async () => { throw new Error(`EACCES ${OLD1}`); } });
  });

  test("the reads are bounded: a config read that never answers is refused in time, nothing written", async () => {
    freshStateDir();
    const t0 = performance.now();
    const r = await refused(folder(CURRENT, BAK), { readConfig: () => new Promise<string | undefined>(() => {}), scrubReadMs: 150 });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(String(r.json!.error)).toContain("in time");
  });

  test("scrub-backup takes no operand: an --index is usage", async () => {
    freshStateDir();
    const f = folder(CURRENT, BAK);
    const before = snapshot(f.dir);
    const r = await scrub(f.file, {}, ["--index", "0"]);
    expect(r.json).toMatchObject({ ok: false, code: "usage" });
    expect(snapshot(f.dir)).toBe(before);
  });
});

// ── P2-M3 milestone checkpoint (2026-10-17) ─────────────────────────────────────────────────────────

/** A secret-shaped decoy for the kind's DEFAULT key variable: a restored `.bak` must never read it. */
const DECOY = "sk-ant-api03-ZZscrubDEFAULTdecoy-0000";

describe("a scrubbed literal that was its entry's only key source becomes the named, unset sentinel (spec §6)", () => {
  test("only a literal with no other source gets the sentinel; one beside apiKeyEnv, apiKeyFile or apiKeyCommand is just deleted", async () => {
    freshStateDir();
    const others: Record<string, unknown>[] = [{ apiKeyEnv: "SOME_VAR" }, { apiKeyFile: "/nonexistent/key.txt" }, { apiKeyCommand: ["/nonexistent/helper"] }];
    const bak = { repos: [], provider: anthropic({ apiKey: OLD1 }), fallbacks: others.map((o, i) => ({ label: `o${i}`, ...anthropic({ ...o, apiKey: OLD2 }) })) };
    const current = { repos: [], provider: anthropic(REF), fallbacks: others.map((o, i) => ({ label: `o${i}`, ...anthropic(o) })) };
    const f = folder(current, bak);
    const r = await scrub(f.file);
    expect(r.json).toEqual({ schemaVersion: 1, ok: true, removed: 4 });
    const after = JSON.parse(readFileSync(f.bak, "utf8"));
    expect(after.provider.api).toEqual({ kind: "anthropic", model: "m", apiKeyEnv: KEY_MOVED_ENV });
    expect(after.fallbacks.map((x: { api: unknown }) => x.api)).toEqual(others.map((o) => ({ kind: "anthropic", model: "m", ...o })));
    expect(leaks(r.text)).toEqual([]);
  });

  test("a restored .bak loads, and its key read names the sentinel and never falls back to the default variable", async () => {
    freshStateDir();
    const bak = { repos: [], provider: { label: "Item1", ...anthropic({ apiKey: OLD1 }) }, fallbacks: [{ label: "Fb", api: { kind: "openai-compatible", model: "m", baseUrl: "https://api.example.test/v1", apiKey: OLD2 } }] };
    const f = folder({ repos: [], provider: { label: "Item1", ...anthropic(REF) } }, bak);
    expect((await scrub(f.file)).json).toEqual({ schemaVersion: 1, ok: true, removed: 2 });
    const restored = validateConfig(JSON.parse(readFileSync(f.bak, "utf8")), home);   // the validator accepts the sentinel
    const list = resolveProviderList(restored, home, {});
    expect(list.entries.map((e) => e.provider.api?.apiKeyEnv)).toEqual([KEY_MOVED_ENV, KEY_MOVED_ENV]);
    for (const e of list.entries) {
      const api = e.provider.api!;
      const env = { [DEFAULT_KEY_ENV[api.kind]]: DECOY };
      const k = await resolveApiKey(api, env);
      expect([k.key, k.source]).toEqual([undefined, "none"]);
      expect(k.warnings.some((w) => w.includes(`$${KEY_MOVED_ENV}`))).toBe(true);
      expect(k.warnings.join("\n")).not.toContain(DECOY);
    }
  });

  test("the transport answers it as key-missing — the walk's `key-unavailable` — naming the sentinel, and sends nothing", async () => {
    freshStateDir();
    const s = await startFakeApi(okJson({ content: [{ type: "text", text: BRIEFING }], stop_reason: "end_turn" }));
    try {
      const api = { kind: "anthropic" as const, model: "m", baseUrl: s.origin, apiKeyEnv: KEY_MOVED_ENV };
      const e = await new AnthropicApiProvider(api, { env: { [DEFAULT_KEY_ENV.anthropic]: DECOY } }).generate("x")
        .then(() => undefined as unknown as ProviderError, (x) => x as ProviderError);
      expect(e).toBeInstanceOf(ProviderError);
      expect(failoverReason(e, "anthropic")).toBe("key-unavailable");
      expect(e.message).toContain(KEY_MOVED_ENV);
      expect(s.requests).toHaveLength(0);
    } finally { await s.stop(); }
  });

  describe("end to end through a walk", () => {
    let repo = "";
    const servers: FakeApi[] = [];
    beforeAll(async () => { repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]); });
    afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });

    test("a restored .bak's sentinel entry is a named key-unavailable attempt, its default variable is never sent, and the walk moves on", async () => {
      freshStateDir();
      const item1 = await startFakeApi(okJson({ content: [{ type: "text", text: BRIEFING }], stop_reason: "end_turn" })); servers.push(item1);
      const ok = await startFakeApi(okJson({ choices: [{ index: 0, message: { role: "assistant", content: BRIEFING }, finish_reason: "stop" }] })); servers.push(ok);
      const bak = { repos: [repo], provider: { label: "Item1", ...anthropic({ baseUrl: item1.origin, apiKey: OLD1 }) },
        fallbacks: [{ label: "Ok", api: { kind: "openai-compatible", model: "llama3", baseUrl: `${ok.origin}/v1` } }] };
      const f = folder({ repos: [repo], provider: { label: "Item1", ...anthropic({ baseUrl: item1.origin, ...REF }) } }, bak);
      expect((await scrub(f.file)).json).toEqual({ schemaVersion: 1, ok: true, removed: 1 });
      const restored = validateConfig(JSON.parse(readFileSync(f.bak, "utf8")), home) as Config;
      // The kind's default variable holds a decoy for this walk only: had the entry fallen back to it, item 1 would
      // have sent it and won.
      const v = DEFAULT_KEY_ENV.anthropic, prev = process.env[v];
      process.env[v] = DECOY;
      try {
        const r = await runCore(restored, walkDeps());
        expect(r.account).toBe("Ok");
        expect(r.attempts?.map((a) => [a.label, a.outcome, a.reason])).toEqual([["Item1", "failed", "key-unavailable"], ["Ok", "won", undefined]]);
        expect(item1.requests).toHaveLength(0);
        // (The variable's NAME is in the failed entry's own key warning and error — pinned by the two tests above; a
        // walk that moves on reports only the winner's runtime warnings, src/core.ts `late`.)
      } finally { if (prev === undefined) delete process.env[v]; else process.env[v] = prev; }
    });
  });

  test("the sentinel is a variable nothing sets: no source file names it but its definition, and no test spells it", () => {
    expect(process.env[KEY_MOVED_ENV]).toBeUndefined();
    expect(Object.values(DEFAULT_KEY_ENV)).not.toContain(KEY_MOVED_ENV);
    const root = join(import.meta.dir, "..");
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d, { withFileTypes: true })) {
        if (n.name === "node_modules" || n.name === "target" || n.name.startsWith(".")) continue;
        const p = join(d, n.name);
        if (n.isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|mjs|cjs|rs|sh|json|plist|toml|md)$/.test(n.name) && readFileSync(p, "utf8").includes(KEY_MOVED_ENV)) hits.push(relative(root, p));
      }
    };
    for (const sub of ["src", "scripts", "test", "gui/src-tauri/src", "gui/src"]) if (existsSync(join(root, sub))) walk(join(root, sub));
    expect(hits).toEqual(["src/providerCli.ts"]);
    expect(readFileSync(join(root, "src/providerCli.ts"), "utf8").split(KEY_MOVED_ENV).length - 1).toBe(1);
  });
});

describe("P2-M3 checkpoint: the read's own guards, the decode, other names, the timeout reason", () => {
  test("a .bak swapped for another regular file after the lstat (inside the config read) is refused — retry — and nothing is written", async () => {
    freshStateDir();
    const f = folder(CURRENT, BAK);
    const other = `${JSON.stringify(BAK)}\n`;
    let before = "";
    const r = await scrub(f.file, {
      readConfig: async (file) => {
        writeFileSync(join(f.dir, "swap"), other); chmodSync(join(f.dir, "swap"), 0o600); renameSync(join(f.dir, "swap"), f.bak);
        before = snapshot(f.dir);
        return readFileSync(file, "utf8");
      },
    });
    expect(r.json).toMatchObject({ schemaVersion: 1, ok: false, code: "config", reason: "changed" });
    expect(String(r.json!.error)).toContain("changed while it was read — retry");
    expect(snapshot(f.dir)).toBe(before);
    expect(readFileSync(f.bak, "utf8")).toContain(OLD1);
    expect(leaks(r.text)).toEqual([]);
  });

  test("a .bak swapped for a symlink after the lstat is never followed: refused at the open, the target untouched, nothing written", async () => {
    freshStateDir();
    const f = folder(CURRENT, BAK);
    const target = join(tempDir("dba-scrub-target-"), "real.bak");
    writeFileSync(target, `${JSON.stringify(BAK)}\n`); chmodSync(target, 0o600);
    const targetBefore = [readFileSync(target, "base64"), statSync(target).mtimeMs, statSync(target).ino];
    let before = "";
    const r = await scrub(f.file, {
      readConfig: async (file) => {
        unlinkSync(f.bak); symlinkSync(target, f.bak);
        before = snapshot(f.dir);
        return readFileSync(file, "utf8");
      },
    });
    expect(r.json).toMatchObject({ schemaVersion: 1, ok: false, code: "config" });
    // Not a "changed — retry": a symlink stays a symlink, so the app does not retry it.
    expect(r.json!.reason).toBeUndefined();
    // The O_NOFOLLOW open refuses it (ELOOP) — not the inode check behind it, which would say "changed while it was read".
    expect(String(r.json!.error)).toContain("the settings backup could not be read — nothing was changed");
    expect(snapshot(f.dir)).toBe(before);
    expect(lstatSync(f.bak).isSymbolicLink()).toBe(true);
    expect([readFileSync(target, "base64"), statSync(target).mtimeMs, statSync(target).ino]).toEqual(targetBefore);
    expect(leaks(r.text)).toEqual([]);
  });

  test("a .bak that is not valid UTF-8 is refused (config), never re-encoded, nothing written", async () => {
    freshStateDir();
    const text = `${JSON.stringify({ ...BAK, morningTime: "07:2@" }, null, 2)}\n`;
    const [a, b] = text.split("@") as [string, string];
    const f = folder(CURRENT);
    writeFileSync(f.bak, Buffer.concat([Buffer.from(a), Buffer.from([0xff]), Buffer.from(b)])); chmodSync(f.bak, 0o600);
    const before = snapshot(f.dir);
    const r = await scrub(f.file);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ schemaVersion: 1, ok: false, code: "config" });
    expect(String(r.json!.error)).toContain("UTF-8");
    expect(snapshot(f.dir)).toBe(before);
    expect(leaks(r.text)).toEqual([]);
  });

  test("a member NAME in the current config holds no key: a .bak literal spelled like one is still removed", async () => {
    freshStateDir();
    const f = folder({ ...CURRENT, [OLD1]: true, extra: { [OLD2]: 1 } }, BAK);
    expect((await scrub(f.file)).json).toEqual({ schemaVersion: 1, ok: true, removed: 2 });
    expect(readFileSync(f.bak, "utf8")).not.toContain(OLD1);
    expect(readFileSync(f.bak, "utf8")).not.toContain(OLD2);
  });

  test("another hard link to .bak (a crashed save's staged .prev) keeps the literals: the answer says otherCopies, never a path", async () => {
    freshStateDir();
    const f = folder(CURRENT, BAK);
    const prev = join(f.dir, `.config.json.save-${DEAD_PID}-1-1.prev`);
    linkSync(f.bak, prev);
    const r = await scrub(f.file);
    expect(r.json).toEqual({ schemaVersion: 1, ok: true, removed: 2, otherCopies: true });
    expect(readFileSync(f.bak, "utf8")).not.toContain(OLD1);
    expect(readFileSync(prev, "utf8")).toContain(OLD1);     // not ours to remove: config_save.rs's next save sweeps it
    expect(r.out.join("\n")).not.toContain(".prev");
  });

  test("a no-op over a linked .bak says nothing about other copies (they hold what .bak holds)", async () => {
    freshStateDir();
    const f = folder(CURRENT, CURRENT_NO_LITERAL());
    linkSync(f.bak, join(f.dir, `.config.json.save-${DEAD_PID}-1-1.prev`));
    expect((await scrub(f.file)).json).toEqual({ schemaVersion: 1, ok: true, removed: 0 });
  });

  test("a timed-out read is `config` with reason timeout; every other refusal carries no reason", async () => {
    freshStateDir();
    const r = await scrub(folder(CURRENT, BAK).file, { readConfig: () => new Promise<string | undefined>(() => {}), scrubReadMs: 150 });
    expect(r.json).toMatchObject({ schemaVersion: 1, ok: false, code: "config", reason: "timeout" });
    const other = await scrub(folder(CURRENT, "{not json").file);
    expect(other.json).toMatchObject({ ok: false, code: "config" });
    expect("reason" in other.json!).toBe(false);
  });
});
