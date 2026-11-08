import "./fixtures/isolate-state";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { validateConfig } from "../src/config";
import type { Config } from "../src/types";
import type { ResolvedAiSummary } from "../src/summary/config";

// Dynamic import lets the independent Config contract fail on the base too, before the resolver exists.
const resolve = async (raw: unknown) => (await import("../src/summary/config")).resolveAiSummary(raw);
const OFF: ResolvedAiSummary = { enabled: false, warnings: [] };
const INVALID: ResolvedAiSummary = { enabled: false, warnings: ["summary-config-invalid"] };

test("Config.aiSummary is additive, optional and unknown", () => {
  const source = ts.createSourceFile("types.ts", readFileSync(new URL("../src/types.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const config = source.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "Config");
  expect(config && ts.isTypeLiteralNode(config.type)).toBe(true);
  if (!config || !ts.isTypeLiteralNode(config.type)) throw new Error("Config must remain a type literal");
  const field = config.type.members.find((node) => ts.isPropertySignature(node) && node.name.getText(source) === "aiSummary");
  expect(field, "Config must declare aiSummary").toBeDefined();
  if (!field || !ts.isPropertySignature(field)) throw new Error("Config.aiSummary is missing");
  expect(field.questionToken?.kind).toBe(ts.SyntaxKind.QuestionToken);
  expect(field.type?.kind).toBe(ts.SyntaxKind.UnknownKeyword);
});

describe("AI summary configuration", () => {
  test.each([
    ["absent", undefined],
    ["an empty block", {}],
    ["explicitly disabled", { enabled: false }],
  ])("%s is off without a warning", async (_label, raw) => {
    expect(await resolve(raw)).toEqual(OFF);
  });

  test("only enabled: true enables summaries", async () => {
    expect(await resolve({ enabled: true })).toEqual({ enabled: true, warnings: [] });
  });

  test.each([
    ["null", null], ["true", true], ["false", false], ["zero", 0], ["a number", 42],
    ["text", "true"], ["an array", []], ["an array containing a block", [{ enabled: true }]],
  ])("a non-object block (%s) is invalid", async (_label, raw) => {
    expect(await resolve(raw)).toEqual(INVALID);
  });

  test.each([
    ["null", null], ["text", "true"], ["a number", 1], ["an array", []], ["an object", {}],
  ])("a malformed enabled value (%s) is invalid", async (_label, enabled) => {
    expect(await resolve({ enabled })).toEqual(INVALID);
  });

  test.each([
    { enable: true }, { enabled: true, extra: true }, { enabled: false, extra: true },
  ])("unknown fields disable the entire block", async (raw) => {
    expect(await resolve(raw)).toEqual(INVALID);
  });

  test("a malformed value survives validateConfig for private resolution without a throw", async () => {
    const provider: Config["provider"] = { cli: "fixture-provider", argv: [], promptVia: "stdin" };
    const absent: Config = { provider };
    expect("aiSummary" in validateConfig(absent, "/unused-test-home")).toBe(false);
    for (const raw of [{}, { enabled: true }, { enabled: false }, "malformed", null, { extra: true }]) {
      const candidate: Config = { provider, aiSummary: raw };
      const validated = validateConfig(candidate, "/unused-test-home");
      expect(validated.aiSummary).toBe(raw);
      expect(validated.provider).toBe(provider);
      expect(Object.keys(validated)).not.toContain("warnings");
      expect(await resolve(validated.aiSummary)).toEqual(
        raw !== null && typeof raw === "object" && !Object.hasOwn(raw, "extra")
          ? { enabled: "enabled" in raw && raw.enabled === true, warnings: [] }
          : INVALID,
      );
    }
  });

  test("diagnostics contain exactly the fixed code, never configured values", async () => {
    const secret = "SUMMARY_CONFIG_SENTINEL";
    for (const raw of [{ enabled: secret }, { enabled: true, [secret]: secret }]) {
      const result = await resolve(raw);
      expect(result).toEqual(INVALID);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.warnings).toEqual(["summary-config-invalid"]);
    }
  });

  test("accessors and inspection failures degrade silently without invoking configured code", async () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, "enabled", { get() { reads++; throw new Error("not called"); } });
    expect(await resolve(accessor)).toEqual(INVALID);
    expect(reads).toBe(0);
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(await resolve(proxy)).toEqual(INVALID);
  });

  test("inherited enabled values cannot turn the feature on", async () => {
    expect(await resolve(Object.create({ enabled: true }))).toEqual(OFF);
  });

  test("unknown symbol and non-enumerable fields are malformed too", async () => {
    expect(await resolve({ enabled: true, [Symbol("extra")]: true })).toEqual(INVALID);
    expect(await resolve(Object.defineProperty({ enabled: true }, "extra", { value: true }))).toEqual(INVALID);
  });

  test("the resolver leaves its input untouched and returns fresh warning lists", async () => {
    const raw = Object.freeze({ enabled: true });
    expect(await resolve(raw)).toEqual({ enabled: true, warnings: [] });
    expect(raw).toEqual({ enabled: true });
    const first = await resolve({ enabled: "bad" });
    first.warnings.length = 0;
    expect(await resolve({ enabled: "bad" })).toEqual(INVALID);
    expect(await resolve(undefined)).toEqual(OFF);
  });
});
