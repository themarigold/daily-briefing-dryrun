// test/providerCli.test.ts — `daily-briefing provider …`: the command scaffold, `--index` resolution and the label
// read from stdin (provider-fallback plan P2-M1-T1; spec r9 §4 "Indexes", §6 `provider reset`; hub Q3, Q20).
//
// Driven through the real `providerMain` with an injected config file, stdin reader and output sinks. Marks live in a
// fresh state folder per test (`freshStateDir`), so "reset resolved this label" is observed as "that label's mark —
// and only that one — is gone".
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerMain, resolveIndex, PROVIDER_RESET_BOUND_MS, PROVIDER_RESET_READ_MS, type ProviderCliDeps } from "../src/providerCli";
import { accountStatePath, PROBE_MS } from "../src/account";
import { resolveProviderList } from "../src/providerList";
import { validateConfig } from "../src/config";
import { freshStateDir, tempDir } from "./helpers/walk";

const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
afterAll(() => { process.env.DAILY_BRIEFING_STATE_DIR = prevState; });

const LOCAL = { api: { kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9/v1" } };
const CLI = { cli: "/nonexistent/claude", argv: [], promptVia: "stdin" };

/** A config file in a temp folder; returns its path. */
function configFile(cfg: Record<string, unknown>): string {
  const dir = tempDir("dba-pcli-cfg-");
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({ repos: [], ...cfg }));
  return p;
}

/** Marks for `labels` in the current state folder. */
function markAll(dir: string, labels: string[]): void {
  mkdirSync(dir, { recursive: true });
  const until = new Date(Date.now() + PROBE_MS).toISOString();
  const accounts: Record<string, unknown> = {};
  for (const l of labels) accounts[l] = { limitedUntil: until, isProbe: true, reason: "auth" };
  writeFileSync(accountStatePath(dir), JSON.stringify({ accounts }));
}
const marked = (dir: string): string[] => Object.keys(JSON.parse(readFileSync(accountStatePath(dir), "utf8")).accounts).sort();

/** Run `provider <args>` with captured output. */
async function cli(args: string[], deps: ProviderCliDeps = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await providerMain(args, { out: (s) => out.push(s), err: (s) => err.push(s), isTTY: false, ...deps });
  const last = out.at(-1);
  return { code, out, err, json: last !== undefined ? JSON.parse(last) as Record<string, unknown> : undefined };
}
const stdin = (v: unknown) => async () => (typeof v === "string" ? v : JSON.stringify(v));

describe("provider reset --label-stdin (hub Q20: the label on stdin, never argv)", () => {
  // Labels that dispatch would read as help or version anywhere in argv, and one that looks like a flag.
  const TRICKY = ["-h", "--help", "-v", "--old"];
  const cfg = () => configFile({ provider: CLI, fallbacks: [...TRICKY, "Plain"].map((label) => ({ label, ...LOCAL })) });

  test("resolves each label, including -h, --help, -v and --old, and clears only that label's mark", async () => {
    const file = cfg();
    for (const label of [...TRICKY, "Plain"]) {
      const d = freshStateDir();
      markAll(d, ["default", ...TRICKY, "Plain"]);
      const r = await cli(["reset", "--label-stdin", "--json"], { configFile: file, readStdin: stdin({ label }) });
      expect(`${label}: ${r.code} ${JSON.stringify(r.json)}`).toBe(`${label}: 0 ${JSON.stringify(r.json)}`);
      expect(r.json?.ok).toBe(true);
      expect(marked(d)).toEqual(["default", ...TRICKY, "Plain"].filter((l) => l !== label).sort());
    }
  });

  test("an unknown label is refused, and the label is never echoed", async () => {
    const d = freshStateDir();
    markAll(d, ["Plain"]);
    const r = await cli(["reset", "--label-stdin", "--json"], { configFile: cfg(), readStdin: stdin({ label: "sk-secret-shaped-label" }) });
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, code: "config" });
    expect(String(r.json?.error)).toContain("no entry");
    expect([...r.out, ...r.err].join("\n")).not.toContain("sk-secret-shaped-label");
    expect(marked(d)).toEqual(["Plain"]);
  });

  test("a dropped entry's label is refused as dropped", async () => {
    const d = freshStateDir();
    markAll(d, ["Broken"]);
    const file = configFile({ provider: CLI, fallbacks: [{ label: "Broken" }, { label: "Ok", ...LOCAL }] });
    const r = await cli(["reset", "--label-stdin", "--json"], { configFile: file, readStdin: stdin({ label: "Broken" }) });
    expect(r.code).toBe(2);
    expect(String(r.json?.error)).toContain("skipped at run time");
    expect(marked(d)).toEqual(["Broken"]);
    // a valid label beside a dropped entry still resolves: labels are identity, nothing is counted
    const ok = await cli(["reset", "--label-stdin", "--json"], { configFile: file, readStdin: stdin({ label: "Ok" }) });
    expect(ok.code).toBe(0);
  });

  test("both --index and --label-stdin, and neither, are refused before stdin is read", async () => {
    freshStateDir();
    let reads = 0;
    const readStdin = async () => { reads++; return JSON.stringify({ label: "Plain" }); };
    for (const args of [["reset", "--index", "0", "--label-stdin", "--json"], ["reset", "--json"]]) {
      const r = await cli(args, { configFile: cfg(), readStdin });
      expect(`${args.join(" ")} → ${r.code}`).toBe(`${args.join(" ")} → 2`);
      expect(r.json).toMatchObject({ ok: false, code: "usage" });
    }
    expect(reads).toBe(0);
  });

  test("the old argv form `--label <label>` is refused, and its value never echoed", async () => {
    freshStateDir();
    const r = await cli(["reset", "--label", "my-private-label", "--json"], { configFile: cfg() });
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, code: "usage" });
    expect([...r.out, ...r.err].join("\n")).not.toContain("my-private-label");
  });

  test("a TTY stdin is refused, and so is stdin that is not {\"label\": <non-empty string>}", async () => {
    freshStateDir();
    const tty = await cli(["reset", "--label-stdin", "--json"], { configFile: cfg(), isTTY: true, readStdin: stdin({ label: "Plain" }) });
    expect(tty.code).toBe(2);
    expect(String(tty.json?.error)).toContain("stdin");
    for (const bad of ["not json", "[]", '"Plain"', { label: "" }, { label: 3 }, { label: "Plain", extra: 1 }, {}]) {
      const r = await cli(["reset", "--label-stdin", "--json"], { configFile: cfg(), readStdin: stdin(bad) });
      expect(`${JSON.stringify(bad)} → ${r.code}`).toBe(`${JSON.stringify(bad)} → 2`);
    }
  });
});

describe("provider reset's reads are bounded (C2 / A5)", () => {
  test("a label stdin that never closes is cut at the pre-store budget: usage, nothing read or written", async () => {
    const d = freshStateDir();
    markAll(d, ["default", "Plain"]);
    let reads = 0;
    const t0 = performance.now();
    const r = await cli(["reset", "--label-stdin", "--json"], {
      configFile: configFile({ provider: CLI, fallbacks: [{ label: "Plain", ...LOCAL }] }),
      readStdin: () => new Promise<string>(() => {}), preStoreMs: 50, readConfig: async () => { reads++; return undefined; },
    });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect([r.code, r.json?.code, reads]).toEqual([2, "usage", 0]);
    expect(String(r.json?.error)).toContain("in time");
    expect(marked(d)).toEqual(["Plain", "default"]);
  });

  test("a saved-config read that stalls is cut at PROVIDER_RESET_READ_MS: config, reason timeout, no lock, no write", async () => {
    const d = freshStateDir();
    markAll(d, ["default", "F"]);
    const t0 = performance.now();
    const r = await cli(["reset", "--index", "1", "--json"], {
      configFile: configFile({ provider: CLI, fallbacks: [{ label: "F", ...LOCAL }] }),
      readConfig: () => new Promise<never>(() => {}), resetReadMs: 50,
    });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect([r.code, r.json?.code, r.json?.reason]).toEqual([2, "config", "timeout"]);
    expect(marked(d)).toEqual(["F", "default"]);
  });

  test("the reads' bound leaves the locked write room inside the app's 15 s (10 s engine bound)", () => {
    expect(PROVIDER_RESET_READ_MS).toBeLessThan(PROVIDER_RESET_BOUND_MS);
    expect(PROVIDER_RESET_BOUND_MS).toBe(10_000);
  });
});

describe("provider reset --index (spec r9 §4 Indexes; hub Q3)", () => {
  test("resolves a 0-based index in the combined list as written: item 1's logins, then fallbacks", async () => {
    const home = tempDir("dba-pcli-home-");
    const file = configFile({
      provider: { ...CLI, accounts: [{ label: "A" }, { label: "B", configDir: join(home, ".claude-b") }] },
      fallbacks: [{ label: "F", ...LOCAL }],
    });
    for (const [i, label] of [[0, "A"], [1, "B"], [2, "F"]] as const) {
      const d = freshStateDir();
      markAll(d, ["A", "B", "F"]);
      const r = await cli(["reset", "--index", String(i), "--json"], { configFile: file, home });
      expect(`${i}: ${r.code}`).toBe(`${i}: 0`);
      expect(marked(d)).toEqual(["A", "B", "F"].filter((l) => l !== label));
    }
  });

  test("a list with a dropped entry is refused", async () => {
    const d = freshStateDir();
    markAll(d, ["default"]);
    const r = await cli(["reset", "--index", "0", "--json"], { configFile: configFile({ provider: CLI, fallbacks: [{ label: "X" }] }) });
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, code: "config" });
    expect(String(r.json?.error)).toContain("skipped at run time");
    expect(marked(d)).toEqual(["default"]);
  });

  test("a structurally broken provider.accounts is refused (its logins collapse, so the app would count differently)", async () => {
    const d = freshStateDir();
    markAll(d, ["default"]);
    const r = await cli(["reset", "--index", "0", "--json"], { configFile: configFile({ provider: { ...CLI, accounts: [{ label: "" }, { label: "B" }] } }) });
    expect(r.code).toBe(2);
    expect(String(r.json?.error)).toContain("provider.accounts");
    expect(marked(d)).toEqual(["default"]);
  });

  test("ignored accounts beside an API item 1 do not refuse: both sides leave those logins out", async () => {
    const d = freshStateDir();
    markAll(d, ["default", "F"]);
    const file = configFile({ provider: { ...LOCAL, accounts: [{ label: "" }] }, fallbacks: [{ label: "F", ...LOCAL }] });
    const r = await cli(["reset", "--index", "1", "--json"], { configFile: file });
    expect(r.code).toBe(0);
    expect(marked(d)).toEqual(["default"]);
  });

  test("out of range, negative and non-numeric indexes are refused", async () => {
    const d = freshStateDir();
    markAll(d, ["default", "F"]);
    const file = configFile({ provider: CLI, fallbacks: [{ label: "F", ...LOCAL }] });
    for (const v of ["2", "-1", "x", "1.5", "01e1", ""]) {
      const r = await cli(["reset", "--index", v, "--json"], { configFile: file });
      expect(`${JSON.stringify(v)} → ${r.code}`).toBe(`${JSON.stringify(v)} → 2`);
    }
    expect(marked(d)).toEqual(["F", "default"]);
  });

  test("resolveIndex: refuses the broken-accounts list whatever its fallbacks, and counts entries otherwise", () => {
    const home = tempDir("dba-pcli-home-");
    const broken = resolveProviderList(validateConfig({ provider: { ...CLI, accounts: "nope" }, fallbacks: [{ label: "F", ...LOCAL }] }, home), home, {});
    expect(broken.accountsBroken).toBe(true);
    expect("error" in resolveIndex(broken, 0)).toBe(true);
    // B7: the refusal is STRUCTURAL (`accountsBroken`), never a match on the warning's wording: the same list with its
    // warnings dropped is still refused, and a list whose warning merely reads like one is not.
    expect("error" in resolveIndex({ ...broken, warnings: [] }, 0)).toBe(true);
    const fine = resolveProviderList(validateConfig({ provider: CLI, fallbacks: [{ label: "F", ...LOCAL }] }, home), home, {});
    expect(fine.accountsBroken).toBe(false);
    expect("entry" in resolveIndex({ ...fine, warnings: ['config: "provider.accounts" looks odd — account failover disabled'] }, 1)).toBe(true);
    const got = resolveIndex(fine, 1);
    expect("entry" in got && got.entry.label).toBe("F");
    expect("error" in resolveIndex(fine, 2)).toBe(true);
  });
});

describe("the scaffold", () => {
  test("--json is required, an unknown verb is refused, and a missing config is a config error", async () => {
    freshStateDir();
    const file = configFile({ provider: CLI });
    expect((await cli(["reset", "--index", "0"], { configFile: file })).code).toBe(2);
    for (const args of [[], ["--json"], ["frobnicate", "--json"], ["key", "--json"], ["key", "rotate", "--json"], ["reset", "--index", "0", "--json", "--json"]]) {
      const r = await cli(args, { configFile: file });
      expect(`${args.join(" ")} → ${r.code}`).toBe(`${args.join(" ")} → 2`);
    }
    const none = await cli(["reset", "--index", "0", "--json"], { configFile: join(tempDir("dba-pcli-none-"), "config.json") });
    expect(none.code).toBe(2);
    expect(none.json).toMatchObject({ ok: false, code: "config" });
  });

  // PR 2 final r3 L5: with no verb to name, the lines carry a sentinel in its place — `provider (no verb): …`, never
  // `provider provider: …` — and the unknown token itself is never echoed (it could be a key typed in the wrong place).
  test("a missing or unknown verb reads `provider (no verb)` / `provider (unknown verb)`, code usage, and echoes no token", async () => {
    freshStateDir();
    const file = configFile({ provider: CLI });
    const cases: [string[], string][] = [[["--json"], "(no verb)"], [[], "(no verb)"], [["sk-ant-TOKENsentinel", "--json"], "(unknown verb)"], [["key", "sk-ant-TOKENsentinel", "--json"], "(unknown verb)"]];
    for (const [args, sentinel] of cases) {
      const r = await cli(args, { configFile: file });
      expect([r.code, r.json?.code, String(r.json?.error).startsWith(`${sentinel}: `)]).toEqual([2, "usage", true]);
      expect(r.err).toHaveLength(1);
      expect(r.err[0]!.startsWith(`provider ${sentinel}: `)).toBe(true);
      expect([...r.out, ...r.err].join("\n")).not.toMatch(/provider provider|TOKENsentinel/);
    }
  });

  test("a verb spelled like an Object.prototype member (constructor, __proto__, toString…) is a usage refusal, never a crash", async () => {
    freshStateDir();
    const file = configFile({ provider: CLI });
    for (const v of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      for (const args of [[v, "--json"], ["key", v, "--json"]]) {
        const r = await cli(args, { configFile: file });
        expect(`${args.join(" ")} → ${r.code} ${r.json?.code}`).toBe(`${args.join(" ")} → 2 usage`);
      }
    }
  });

  test("every verb of the grammar is recognised (test is test/provider.test-cmd.test.ts's; key set, delete and delete-all test/provider.key-cli.test.ts's, migrate test/provider.migrate.test.ts's, scrub-backup test/provider.scrub.test.ts's)", async () => {
    freshStateDir();
    const file = configFile({ provider: CLI });
    // test is built (P2-M4): this entry's CLI does not exist, so the Test runs and fails as not-installed.
    const r = await cli(["test", "--file", file, "--index", "0", "--json"], { configFile: file });
    expect(r.json).toMatchObject({ schemaVersion: 1, ok: true, passed: false, reason: "not-installed", recorded: true });
    // scrub-backup is built (P2-M3-T2): with no .bak beside the config it is a no-op.
    expect((await cli(["key", "scrub-backup", "--json"], { configFile: file })).json).toEqual({ schemaVersion: 1, ok: true, removed: 0 });
  });

  test("a resolved reset with no state folder yet writes nothing it did not need", async () => {
    const d = freshStateDir();
    const r = await cli(["reset", "--index", "0", "--json"], { configFile: configFile({ provider: CLI }) });
    expect(r.code).toBe(0);
    expect(existsSync(accountStatePath(d))).toBe(false);
  });
});
