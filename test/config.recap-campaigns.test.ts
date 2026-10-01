// test/config.recap-campaigns.test.ts — tier B, T4.1: `resolveRecapCampaigns(raw)` (src/config.ts), the ONE
// reader of `Config.recapCampaigns` (spec §4.8, Appendix D7). Pure, never throws: absent ⇒ `off` with no
// warning; anything that is not EXACTLY `{ mode: "off" | "trial" | "on" }` ⇒ `off` plus a fixed-text warning.
// Plan-added tests (tierb-plan §4 T4.1); §7 assigns T4.1 no `[TB-…]` case — P11a is T4.4's, through the page.
import { test, expect } from "bun:test";
import { resolveRecapCampaigns, validateConfig } from "../src/config";

// The warning as a LITERAL, not the source's text: a mutant that re-words it or echoes the configured
// value must fail here, and comparing against the string it mutated would pass (the verdictPaths rule,
// test/in2-verdict-marker.test.ts).
const WARNING = 'config: "recapCampaigns" must be { mode: "off" | "trial" | "on" } — recap campaigns off';

const PROVIDER = { cli: "claude", argv: ["-p"], promptVia: "stdin" as const };

// Every JSON-producible bad shape, plus the non-JSON ones a `Config` built in code can still carry.
const BAD: [string, unknown][] = [
  ["a bare mode string", "on"], ["a bare trial string", "trial"], ["a bare off string", "off"], ["an empty string", ""],
  ["a number", 1], ["zero", 0], ["NaN", NaN], ["true", true], ["false", false],
  ["an empty array", []], ["an array of a mode", ["on"]], ["an array of the shape", [{ mode: "on" }]],
  ["an empty object", {}], ["mode undefined", { mode: undefined }], ["mode null", { mode: null }],
  ["mode a number", { mode: 1 }], ["mode a boolean", { mode: true }], ["mode an object", { mode: {} }],
  ["mode an array", { mode: ["on"] }], ["mode upper-case", { mode: "ON" }], ["mode title-case", { mode: "Trial" }],
  ["mode leading space", { mode: " on" }], ["mode trailing space", { mode: "off " }], ["mode empty", { mode: "" }],
  ["mode an unknown word", { mode: "enabled" }], ["a mis-cased key", { Mode: "on" }], ["a different key", { enabled: true }],
  ["a plural key", { modes: "on" }],
  // "EXACTLY": any other own key beside `mode` is a bad shape, whichever mode it carries.
  ["on plus an extra key", { mode: "on", extra: true }], ["trial plus an extra key", { mode: "trial", enabled: true }],
  ["off plus an extra key", { mode: "off", note: "" }], ["an undefined extra key", { mode: "on", later: undefined }],
  ["a symbol extra key", { mode: "on", [Symbol("x")]: 1 }],
  ["parsed JSON with an extra key", JSON.parse('{"mode":"trial","x":1}')],
  ["an inherited mode only", Object.create({ mode: "on" })],
  ["an accessor mode", { get mode() { return "on"; } }],
];

test("resolveRecapCampaigns maps every D7 shape", () => {
  // Absent: undefined/null ⇒ off with NO warning key at all (toStrictEqual: `warning: undefined` fails).
  expect(resolveRecapCampaigns(undefined)).toStrictEqual({ mode: "off" });
  expect(resolveRecapCampaigns(null)).toStrictEqual({ mode: "off" });

  // The three good shapes, each resolved to itself with no warning.
  for (const mode of ["off", "trial", "on"] as const) {
    expect(resolveRecapCampaigns({ mode })).toStrictEqual({ mode });
    expect(resolveRecapCampaigns(JSON.parse(JSON.stringify({ mode })))).toStrictEqual({ mode });
    expect(resolveRecapCampaigns(Object.assign(Object.create(null), { mode }))).toStrictEqual({ mode });
  }

  // Every bad shape ⇒ off PLUS a warning.
  for (const [what, raw] of BAD) {
    expect({ what, r: resolveRecapCampaigns(raw) })
      .toStrictEqual({ what, r: { mode: "off", warning: expect.stringContaining('"recapCampaigns"') } });
  }

  // The real load path: validateConfig spreads the key through unvalidated (config.ts:227), so what the
  // resolver sees from a config file is exactly what the user wrote.
  const load = (recapCampaigns: unknown) =>
    resolveRecapCampaigns(validateConfig(JSON.parse(JSON.stringify({ provider: PROVIDER, recapCampaigns })), "/home/x").recapCampaigns);
  expect(load({ mode: "trial" })).toStrictEqual({ mode: "trial" });
  expect(load({ mode: "on", extra: 1 })).toStrictEqual({ mode: "off", warning: expect.stringContaining('"recapCampaigns"') });
  expect(resolveRecapCampaigns(validateConfig({ provider: PROVIDER }, "/home/x").recapCampaigns)).toStrictEqual({ mode: "off" });
});

test("resolveRecapCampaigns never throws", () => {
  const revocable = Proxy.revocable({ mode: "on" }, {});
  revocable.revoke();   // every operation on a revoked proxy throws — Array.isArray included
  const circular: Record<string, unknown> = { mode: "on" };
  circular.self = circular;
  const hostile: [string, unknown][] = [
    ["a revoked proxy", revocable.proxy],
    ["a proxy whose ownKeys throws", new Proxy({ mode: "on" }, { ownKeys() { throw new Error("boom"); } })],
    ["a proxy whose descriptor lookup throws", new Proxy({ mode: "on" }, { getOwnPropertyDescriptor() { throw new Error("boom"); } })],
    ["a throwing accessor", { get mode(): string { throw new Error("boom"); } }],
    ["a bigint", 1n], ["a symbol", Symbol("on")], ["a function", () => "on"], ["a class", class { static mode = "on"; }],
    ["a Map", new Map([["mode", "on"]])], ["a Date", new Date(0)], ["a circular object", circular],
    ["a deeply nested value", { mode: { mode: { mode: "on" } } }],
  ];
  for (const [what, raw] of hostile) {
    let r: ReturnType<typeof resolveRecapCampaigns> | undefined;
    expect(() => { r = resolveRecapCampaigns(raw); }).not.toThrow();
    expect({ what, r }).toStrictEqual({ what, r: { mode: "off", warning: expect.stringContaining('"recapCampaigns"') } });
  }

  // Pure: an accessor is never invoked, a frozen input is accepted (a write would throw in module strict
  // mode), and the same input gives the same answer every time.
  let calls = 0;
  expect(resolveRecapCampaigns({ get mode() { calls++; return "on"; } }).mode).toBe("off");
  expect(calls).toBe(0);
  const frozen = Object.freeze({ mode: "trial" });
  expect(resolveRecapCampaigns(frozen)).toStrictEqual({ mode: "trial" });
  expect(resolveRecapCampaigns(frozen)).toStrictEqual(resolveRecapCampaigns(frozen));
  expect(frozen).toStrictEqual({ mode: "trial" });
});

test("the malformed-config warning is fixed text with no label", () => {
  // Bad values that CARRY labels — as a mode, a stray key, a key name, an array entry, a bracketed page
  // label. The warning renders in the page's ⚠ line, which feeds audit.coverageGaps' haystack, so an echo
  // would "name" that lane on exactly the misconfigured morning.
  const LABELS = ["quant_stocks", "personal_code", "accountant_ai"];
  const carrying: unknown[] = [
    "quant_stocks", { mode: "quant_stocks" }, { mode: "on", repo: "personal_code" }, { personal_code: "on" },
    ["accountant_ai"], { mode: "on\n[quant_stocks]" }, { mode: "trial", labels: LABELS }, { mode: 7, why: "accountant_ai" },
  ];
  for (const raw of carrying) {
    const r = resolveRecapCampaigns(raw);
    expect(r).toStrictEqual({ mode: "off", warning: WARNING });   // identical for every bad value
    for (const l of LABELS) expect(r.warning).not.toContain(l);
    expect(r.warning).not.toMatch(/[\n[\]]/);                     // one line, no `[label]`-shaped bracket
  }
  // …and the same fixed text for every other bad shape, so nothing about the value leaks through.
  for (const [, raw] of BAD) expect(resolveRecapCampaigns(raw).warning).toBe(WARNING);
});
