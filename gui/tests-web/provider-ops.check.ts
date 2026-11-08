/**
 * P3-M1-T3 — the webview's wrappers for the five `engine_provider_*` commands (P3-M1-T1,
 * `src-tauri/src/engine.rs`) and the candidate check (P3-M1-T2, `src-tauri/src/config_save.rs`),
 * in `src/lib/engine.ts`; the contract is `docs/gui-seam.md` §1d and §1e.
 *
 * What is pinned here:
 *   1. each wrapper invokes its command with exactly the argument shape Rust reads — and the names
 *      are Rust's own parameters, parsed from the Rust source at test time, not a third spelling;
 *   2. the key reaches `invoke` as its one argument and nowhere else: nothing the wrapper logs,
 *      throws or returns carries it;
 *   3. a Test's `testTimeoutMs` is the validate row's, unchanged, and only `index` and
 *      `testTimeoutMs` are sent (Rust's `CheckMode` refuses any other field);
 *   4. `providerReset` refuses both-or-neither of `index` / `label` before invoking, with Rust's own
 *      refusal (read from `engine_provider_reset`'s body);
 *   5. the TypeScript `CheckError` / `CheckOutcome` unions name exactly Rust's variants and fields;
 *   6. (P3-M4-T3) the pending-reset store's three wrappers: each command and its arguments are Rust's
 *      (`src-tauri/src/pending_resets.rs`), every command there has one wrapper, and the answer and
 *      error unions name exactly Rust's variants and fields.
 *
 * ⚠ THE IPC IS A RECORDER, NOT TAURI: `@tauri-apps/api/core`'s `invoke` calls
 * `window.__TAURI_INTERNALS__.invoke(cmd, args)`, which each test installs (the
 * `coexistence.check.ts` `uninstallExecute` pattern). Nothing here spawns anything.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  providerCandidateCheck,
  providerKeyDelete,
  providerKeyMigrate,
  providerKeyScrubBackup,
  providerKeySet,
  providerPendingResetAdd,
  providerPendingResetDrop,
  providerPendingResetFlush,
  providerReset,
  testModeFor,
  type ProviderValidateRow,
} from "../src/lib/engine";

const GUI = join(import.meta.dir, "..");
const ENGINE_RS = readFileSync(join(GUI, "src-tauri", "src", "engine.rs"), "utf8");
const CONFIG_SAVE_RS = readFileSync(join(GUI, "src-tauri", "src", "config_save.rs"), "utf8");
const PENDING_RS = readFileSync(join(GUI, "src-tauri", "src", "pending_resets.rs"), "utf8");
const ENGINE_TS = readFileSync(join(GUI, "src", "lib", "engine.ts"), "utf8");

/* ── the recorder ─────────────────────────────────────────────────────────────────────────────── */

type Call = [string, unknown];
let calls: Call[] = [];
let answer: (command: string, args: unknown) => Promise<unknown> = async () => ({});
const g = globalThis as { window?: unknown };
let hadWindow = false;
let windowBefore: unknown;

/** Every console method, recorded instead of printed, so a test can assert nothing was logged. */
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
let logged: unknown[][] = [];
let consoleBefore: Partial<Record<(typeof CONSOLE_METHODS)[number], unknown>> = {};

beforeEach(() => {
  calls = [];
  answer = async () => ({});
  hadWindow = "window" in g;
  windowBefore = g.window;
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: unknown) => {
        calls.push([command, args]);
        return answer(command, args);
      },
    },
  };
  logged = [];
  consoleBefore = {};
  const c = console as unknown as Record<string, unknown>;
  for (const m of CONSOLE_METHODS) {
    consoleBefore[m] = c[m];
    c[m] = (...args: unknown[]) => {
      logged.push(args);
    };
  }
});

afterEach(() => {
  if (hadWindow) g.window = windowBefore;
  else delete g.window;
  const c = console as unknown as Record<string, unknown>;
  for (const m of CONSOLE_METHODS) c[m] = consoleBefore[m];
});

/* ── Rust's parameters, parsed ─────────────────────────────────────────────────────────────────── */

/** A `#[tauri::command]`'s webview-supplied parameters, camelCased as Tauri reads them (the
 *  injected `AppHandle` / `State` are not sent). */
function rustParams(source: string, command: string): string[] {
  const signature =
    source.match(new RegExp(`pub async fn ${command}<R: Runtime>\\(([\\s\\S]*?)\\)\\s*->`))?.[1] ?? "";
  if (signature === "") throw new Error(`no command ${command} in the Rust source`);
  // `:(?!:)` — a path inside a type (`State<'_, crate::config_save::ConfigSaver>`) is not a parameter.
  return [...signature.matchAll(/(?:^|,)\s*(\w+)\s*:(?!:)\s*(AppHandle|State)?/g)]
    .filter((m) => m[2] === undefined)
    .map((m) => (m[1] ?? "").replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase()));
}

/** A Rust enum's variants as `{kind, fields}` the way serde tags them (`tag = "kind"`, camelCase
 *  variant names). A variant's FIELDS are camelCased only where serde would camelCase them: the
 *  variant carries `#[serde(rename_all = "camelCase")]`, or the enum `rename_all_fields =
 *  "camelCase"` — the enum's own `rename_all` renames the VARIANTS, never their fields. Otherwise a
 *  field is expected as spelt in Rust (snake_case); a `#[serde(rename = "…")]` on a field wins. */
function rustVariants(source: string, name: string): Map<string, string[]> {
  const found = source.match(new RegExp(`((?:#\\[[^\\n]*\\]\\n)*)pub enum ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (found === null) throw new Error(`no enum ${name} in the Rust source`);
  const enumCamel = /#\[serde\([^\n]*\brename_all_fields = "camelCase"/.test(found[1] ?? "");
  const code = (found[2] ?? "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  const camel = (f: string) => f.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
  const out = new Map<string, string[]>();
  for (const m of code.matchAll(/^((?:[ \t]*#\[[^\n]*\][ \t]*\n)*)[ \t]*([A-Z]\w*)\s*(?:\{([^}]*)\})?\s*,?[ \t]*$/gm)) {
    const kind = (m[2] ?? "").replace(/^./, (c) => c.toLowerCase());
    const variantCamel = enumCamel || /#\[serde\([^\n]*\brename_all = "camelCase"/.test(m[1] ?? "");
    const fields = [...(m[3] ?? "").matchAll(/(?:#\[serde\(rename = "(\w+)"\)\]\s*)?(\w+)\s*:/g)].map(
      (f) => f[1] ?? (variantCamel ? camel(f[2] ?? "") : (f[2] ?? "")),
    );
    out.set(kind, fields);
  }
  return out;
}

/** A TypeScript tagged union in `engine.ts` as `{kind, fields}`: each `| { kind: "…"; a: …; b: … }`. */
function tsVariants(name: string): Map<string, string[]> {
  const body = ENGINE_TS.match(new RegExp(`export type ${name} =([\\s\\S]*?);\\n\\n`))?.[1];
  if (body === undefined) throw new Error(`no type ${name} in engine.ts`);
  const code = body
    .split("\n")
    .filter((l) => !/^\s*(\/\*\*|\*|\/\/)/.test(l))
    .join("\n");
  const out = new Map<string, string[]>();
  for (const m of code.matchAll(/\|\s*\{\s*kind:\s*"(\w+)";?([^}]*)\}/g)) {
    const fields = [...(m[2] ?? "").matchAll(/(\w+)\??\s*:/g)].map((f) => f[1] ?? "");
    out.set(m[1] ?? "", fields);
  }
  return out;
}

/* ── 1. the commands and their argument shapes ─────────────────────────────────────────────────── */

describe("each wrapper invokes its command with the argument shape Rust reads", () => {
  const KEY = "sk-test-0123456789abcdef-KEYBYTES";
  const ROW: ProviderValidateRow = { index: 2, testTimeoutMs: 137_000, loopback: true, keyOptional: true, keyMoved: false };
  const CASES: { run: () => Promise<unknown>; command: string; args: Record<string, unknown> }[] = [
    { run: () => providerKeySet(KEY), command: "engine_provider_key_set", args: { key: KEY } },
    { run: () => providerKeyMigrate(3), command: "engine_provider_key_migrate", args: { index: 3 } },
    { run: () => providerKeyDelete("k-0123456789ab"), command: "engine_provider_key_delete", args: { id: "k-0123456789ab" } },
    { run: () => providerKeyScrubBackup(), command: "engine_provider_key_scrub_backup", args: {} },
    { run: () => providerReset({ index: 0 }), command: "engine_provider_reset", args: { index: 0 } },
    { run: () => providerReset({ label: "--help" }), command: "engine_provider_reset", args: { label: "--help" } },
    {
      run: () => providerCandidateCheck('{"repos":[]}', "validate"),
      command: "provider_candidate_check",
      args: { text: '{"repos":[]}', mode: "validate" },
    },
    {
      run: () => providerCandidateCheck('{"repos":[]}', testModeFor(ROW)),
      command: "provider_candidate_check",
      args: { text: '{"repos":[]}', mode: { test: { index: 2, testTimeoutMs: 137_000 } } },
    },
  ];

  for (const c of CASES) {
    test(`${c.command} ${JSON.stringify(Object.keys(c.args))}`, async () => {
      await c.run();
      // `invoke` itself defaults a missing argument object to `{}`; either way Rust reads none.
      expect(calls.map(([cmd, args]) => [cmd, args ?? {}])).toEqual([[c.command, c.args]]);
    });
  }

  test("the argument names are Rust's own parameters, camelCased the way Tauri reads them", () => {
    const sent = new Map<string, Set<string>>();
    for (const c of CASES) {
      const names = sent.get(c.command) ?? new Set<string>();
      for (const k of Object.keys(c.args)) names.add(k);
      sent.set(c.command, names);
    }
    for (const [command, names] of sent) {
      const source = command === "provider_candidate_check" ? CONFIG_SAVE_RS : ENGINE_RS;
      expect([command, [...names].sort()]).toEqual([command, rustParams(source, command).sort()]);
    }
  });

  test("every provider command Rust registers has exactly one wrapper here, and `provider test` has none of its own", () => {
    const registered = (source: string): string[] =>
      [...(source.match(/pub const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/)?.[1] ?? "").matchAll(/"(\w+)"/g)].map(
        (m) => m[1] ?? "",
      );
    const provider = [
      ...registered(ENGINE_RS).filter((n) => n.startsWith("engine_provider_")),
      ...registered(CONFIG_SAVE_RS).filter((n) => n.startsWith("provider_")),
    ];
    expect(provider.sort()).toEqual(
      [
        "engine_provider_key_set",
        "engine_provider_key_migrate",
        "engine_provider_key_delete",
        "engine_provider_key_scrub_backup",
        "engine_provider_reset",
        "provider_candidate_check",
      ].sort(),
    );
    for (const name of provider) {
      expect([name, [...ENGINE_TS.matchAll(new RegExp(`invoke<[^(]*>\\(\\s*"${name}"`, "g"))].length]).toEqual([name, 1]);
    }
    // The Test reaches the engine only through the staging command: no command name for it at all.
    expect(ENGINE_TS).not.toMatch(/"engine_provider_test"|"provider_test"/);
    // PR 3 final r1: the two commands no app code called are gone from Rust and from here — the
    // report with every literal `apiKey` (`config validate --file`) and the one-call key wipe.
    for (const gone of ["engine_config_validate", "engine_provider_key_delete_all"]) {
      expect([gone, ENGINE_TS.includes(`"${gone}"`), ENGINE_RS.includes(`"${gone}"`)]).toEqual([gone, false, false]);
    }
  });
});

/* ── 2. the key ────────────────────────────────────────────────────────────────────────────────── */

describe("the key goes to Rust as the one argument and nowhere else", () => {
  const KEY = "sk-ant-api03-SECRETSECRETSECRET-0123456789";

  test("an answer: the key is in the call's argument only — not logged, not in what the wrapper returns", async () => {
    answer = async () => ({
      operation: "provider-key-set",
      outcome: { kind: "delivered" },
      exitCode: 0,
      payload: { schemaVersion: 1, ok: true, keyId: "k-0123456789ab", apiKeyFile: "/state/keys/k-0123456789ab.key" },
      stdout: "",
      stderr: "",
    });
    const out = await providerKeySet(KEY);
    expect(calls).toEqual([["engine_provider_key_set", { key: KEY }]]);
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(logged).toEqual([]);
  });

  test("a refusal: Rust's error comes back unchanged, carrying no key, and nothing is logged", async () => {
    const refusal = { kind: "invalidInput", field: "key", reason: "is too large" };
    answer = async () => {
      throw refusal;
    };
    let caught: unknown;
    try {
      await providerKeySet(KEY);
    } catch (e) {
      caught = e;
    }
    expect(caught).toEqual(refusal);
    expect(JSON.stringify(caught)).not.toContain(KEY);
    expect(String(caught)).not.toContain(KEY);
    expect(logged).toEqual([]);
  });

  test("an IPC that throws synchronously: the wrapper adds nothing of its own (no wrapping error that quotes its argument)", async () => {
    const err = new Error("ipc down");
    g.window = {
      __TAURI_INTERNALS__: {
        invoke: () => {
          throw err;
        },
      },
    };
    let caught: unknown;
    try {
      await providerKeySet(KEY);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
    expect(logged).toEqual([]);
  });

  test("source pin: engine.ts never logs, and the key is never kept beyond the call", () => {
    expect(ENGINE_TS).not.toMatch(/\bconsole\s*\./);
    const body = ENGINE_TS.match(/export function providerKeySet\(([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(body).not.toBe("");
    // One statement: the invoke. No module-level variable, no object other than the argument.
    expect(body).toMatch(/return invoke<[^(]*>\("engine_provider_key_set", \{ key \}\);/);
    expect(body.split("\n").filter((l) => /\S/.test(l) && !/^\s*(\/\/|\*|\/\*\*)/.test(l)).length).toBe(2);
  });
});

/* ── 3. the Test's bound ───────────────────────────────────────────────────────────────────────── */

describe("a Test's bound is the validate row's testTimeoutMs, unchanged, for every entry kind", () => {
  // Rows exactly as `config validate --json` reports them: remote and CLI 80 000; loopback the
  // effective `timeoutMs` + 17 000 (a fractional one rounded up by the engine); a hand-edited value
  // over the 30-minute cap — the app passes it as it is and Rust clamps it.
  const ROWS: ProviderValidateRow[] = [
    { index: 0, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false },
    { index: 1, testTimeoutMs: 80_000, loopback: false, keyOptional: false, keyMoved: false, appOwnedKey: true, appKeyId: "k-0123456789ab" },
    { index: 2, testTimeoutMs: 137_000, loopback: true, keyOptional: true, keyMoved: false, appOwnedKey: true },
    { index: 3, testTimeoutMs: 17_001, loopback: true, keyOptional: true, keyMoved: true },
    { index: 4, testTimeoutMs: 1_800_000, loopback: true, keyOptional: false, keyMoved: false },
    { index: 5, testTimeoutMs: 9_999_999, loopback: true, keyOptional: true, keyMoved: false },
  ];

  for (const row of ROWS) {
    test(`row ${JSON.stringify(row)}`, async () => {
      await providerCandidateCheck("{}", testModeFor(row));
      // Exactly `index` and `testTimeoutMs`: Rust's `CheckMode` is `deny_unknown_fields`, so a row's
      // `loopback` / `keyOptional` / `keyMoved` / `appOwnedKey` / `appKeyId` sent along would refuse the Test.
      expect(calls).toEqual([
        ["provider_candidate_check", { text: "{}", mode: { test: { index: row.index, testTimeoutMs: row.testTimeoutMs } } }],
      ]);
    });
  }

  test("the wire names are Rust's: `CheckMode::Test { index, testTimeoutMs }`, closed", () => {
    expect(rustVariants(CONFIG_SAVE_RS, "CheckMode")).toEqual(
      new Map([
        ["validate", []],
        ["test", ["index", "testTimeoutMs"]],
      ]),
    );
    expect(CONFIG_SAVE_RS).toMatch(/#\[serde\(rename_all = "camelCase", deny_unknown_fields\)\]\npub enum CheckMode/);
  });
});

/* ── 4. reset's one target ─────────────────────────────────────────────────────────────────────── */

describe("providerReset takes exactly one of index and label, as Rust does", () => {
  /** Rust's own refusal for both-or-neither, read from `engine_provider_reset`'s body. */
  const RUST_REFUSAL = (() => {
    const body = ENGINE_RS.match(/pub async fn engine_provider_reset<R: Runtime>\([\s\S]*?\n\}/)?.[0] ?? "";
    const m = /_ => \{\s*return Err\(EngineError::InvalidInput \{\s*field: "([^"]+)"\.into\(\),\s*reason: "([^"]+)"\.into\(\),/.exec(body);
    if (m === null) throw new Error("engine_provider_reset's both-or-neither refusal is not where this test reads it");
    return { kind: "invalidInput", field: m[1], reason: m[2] };
  })();

  const BAD: unknown[] = [{}, { index: 1, label: "x" }, { index: null, label: null }, { index: undefined }, { label: "x", index: 0 }];
  for (const target of BAD) {
    test(`refused before invoking: ${JSON.stringify(target)}`, async () => {
      let caught: unknown;
      try {
        await providerReset(target as never);
      } catch (e) {
        caught = e;
      }
      expect(caught).toEqual(RUST_REFUSAL);
      expect(calls).toEqual([]);
      expect(logged).toEqual([]);
    });
  }

  test("a null beside the given one counts as absent, as Rust's `Option` reads it, and is not sent", async () => {
    await providerReset({ index: 4, label: null } as never);
    await providerReset({ index: null, label: "Claude login 2" } as never);
    expect(calls).toEqual([
      ["engine_provider_reset", { index: 4 }],
      ["engine_provider_reset", { label: "Claude login 2" }],
    ]);
  });

  test("everything else about the operands is Rust's: an empty label and index 0 are sent as they are", async () => {
    // Index 0 is item 1 (a falsy number, not an absent one); an empty label is Rust's to refuse.
    await providerReset({ index: 0 });
    await providerReset({ label: "" });
    expect(calls).toEqual([
      ["engine_provider_reset", { index: 0 }],
      ["engine_provider_reset", { label: "" }],
    ]);
  });
});

/* ── 5. the wire types match the Rust ──────────────────────────────────────────────────────────── */

describe("the TypeScript unions name exactly Rust's serde variants and fields", () => {
  test("CheckError", () => {
    expect(tsVariants("CheckError")).toEqual(rustVariants(CONFIG_SAVE_RS, "CheckError"));
  });
  test("CheckOutcome", () => {
    expect(tsVariants("CheckOutcome")).toEqual(rustVariants(CONFIG_SAVE_RS, "CheckOutcome"));
  });
  test("EngineError", () => {
    expect(tsVariants("EngineError")).toEqual(rustVariants(ENGINE_RS, "EngineError"));
  });
  test("the parsers are not vacuous", () => {
    expect(rustVariants(CONFIG_SAVE_RS, "CheckError").size).toBe(7);
    expect(rustVariants(CONFIG_SAVE_RS, "CheckOutcome").get("tested")).toEqual(["answer", "boundMs"]);
    expect(rustVariants(CONFIG_SAVE_RS, "CheckOutcome").get("invalid")).toEqual(["errors", "warnings"]);
  });
  test("a variant's fields are camelCased only where serde camelCases them", () => {
    const rs = (enumAttrs: string, variantAttr: string) =>
      `${enumAttrs}pub enum E {\n    /// doc\n${variantAttr}    Tested { answer: Value, bound_ms: u64 },\n    Plain { bound_ms: u64, #[serde(rename = "givenName")] given_name: u64 },\n}\n`;
    const tagged = '#[derive(Serialize)]\n#[serde(tag = "kind", rename_all = "camelCase")]\n';
    // The enum's `rename_all` renames variants only: both variants' fields stay snake_case.
    expect(rustVariants(rs(tagged, ""), "E")).toEqual(
      new Map([
        ["tested", ["answer", "bound_ms"]],
        ["plain", ["bound_ms", "givenName"]],
      ]),
    );
    // A variant's own `rename_all` camelCases that variant's fields, and only that variant's.
    expect(rustVariants(rs(tagged, '    #[serde(rename_all = "camelCase")]\n'), "E")).toEqual(
      new Map([
        ["tested", ["answer", "boundMs"]],
        ["plain", ["bound_ms", "givenName"]],
      ]),
    );
    // The enum's `rename_all_fields` camelCases every variant's fields.
    expect(
      rustVariants(rs('#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]\n', ""), "E"),
    ).toEqual(
      new Map([
        ["tested", ["answer", "boundMs"]],
        ["plain", ["boundMs", "givenName"]],
      ]),
    );
  });
});

/* ── 6. the pending-reset store (P3-M4-T3) ─────────────────────────────────────────────────────── */

describe("the pending-reset store's wrappers are Rust's commands, arguments and answers", () => {
  const ID = "k-0123456789ab";
  const CASES: { run: () => Promise<unknown>; command: string }[] = [
    { run: () => providerPendingResetAdd("--help", ID), command: "provider_pending_reset_add" },
    { run: () => providerPendingResetFlush("--help", ID), command: "provider_pending_reset_flush" },
    { run: () => providerPendingResetDrop("--help", ID), command: "provider_pending_reset_drop" },
  ];
  for (const c of CASES) {
    test(`${c.command} {label, newKeyId}`, async () => {
      await c.run();
      expect(calls).toEqual([[c.command, { label: "--help", newKeyId: ID }]]);
      expect(rustParams(PENDING_RS, c.command).sort()).toEqual(["label", "newKeyId"]);
    });
  }

  test("every command pending_resets.rs registers has exactly one wrapper", () => {
    const registered = [...(PENDING_RS.match(/pub const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1] ?? "");
    expect(registered.sort()).toEqual(CASES.map((c) => c.command).sort());
    for (const name of registered) expect([name, [...ENGINE_TS.matchAll(new RegExp(`invoke<[^(]*>\\(\\s*"${name}"`, "g"))].length]).toEqual([name, 1]);
  });

  test("the answer and error unions name exactly Rust's variants and fields", () => {
    for (const [rust, ts] of [
      ["AddOutcome", "PendingAddOutcome"],
      ["FlushOutcome", "PendingFlushOutcome"],
      ["DropOutcome", "PendingDropOutcome"],
      ["PendingError", "PendingError"],
    ] as const) {
      const r = rustVariants(PENDING_RS, rust);
      const t = tsVariants(ts);
      expect([ts, [...t.keys()].sort()]).toEqual([ts, [...r.keys()].sort()]);
      for (const [kind, fields] of r) expect([ts, kind, (t.get(kind) ?? []).sort()]).toEqual([ts, kind, [...fields].sort()]);
    }
    // prove-it 3b: the parse saw the unions, not nothing.
    expect([...rustVariants(PENDING_RS, "AddOutcome").keys()]).toEqual(["reset", "retry", "refused"]);
    expect(rustVariants(PENDING_RS, "AddOutcome").get("refused")).toEqual(["code", "reason", "detail"]);
    expect([...rustVariants(PENDING_RS, "DropOutcome").keys()]).toEqual(["promoted", "deleted", "deletePending", "kept", "deleteFailed"]);
    expect(rustVariants(PENDING_RS, "PendingError").get("invalidInput")).toEqual(["field", "reason"]);
    expect(tsVariants("PendingFlushOutcome").get("discarding")).toEqual([]);
    // `kept`'s reason is `KeptWhy`, serialised camelCase.
    expect(PENDING_RS).toMatch(/#\[serde\(rename_all = "camelCase"\)\]\npub enum KeptWhy \{/);
    expect(ENGINE_TS).toContain('| { kind: "kept"; why: "otherLabel" | "unverified" }');
  });
});
