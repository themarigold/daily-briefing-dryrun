import "./fixtures/isolate-state";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isRefusedCharacter } from "../src/summary/refused-chars";
import { validateSummary, validateSummaryText } from "../src/summary/validate";
import { redactCredentials } from "../src/transcripts/credentials";
import type { SummaryProject, SummaryTextWarning } from "../src/summary/validate";

const vectors = JSON.parse(readFileSync(new URL("../gui/src-tauri/tests/fixtures/summary-text-vectors.json", import.meta.url), "utf8")) as {
  text: { text: string; accepted: boolean }[];
};
const limits = JSON.parse(readFileSync(new URL("../gui/src-tauri/tests/fixtures/repos-request-limits.json", import.meta.url), "utf8")) as {
  chars: { cp: string; refused: boolean }[];
};

const cards = [
  { key: "project:app", label: "App" }, { key: "project:other", label: "Other" },
  { key: "other:", label: "Other" }, { key: "project:project:other", label: "project:Other" },
  { key: "project:mono/api", label: "mono/api" }, { key: "project:mono/web", label: "mono/web" },
  { key: "project:__proto__", label: "__proto__" }, { key: "project:constructor", label: "constructor" },
];
const project = <Points = SummaryProject["points"]>(
  points: Points | SummaryProject["points"] = ["Shipped work"], key = "project:app",
) => ({ key, points });
const raw = (projects: unknown = [project()], goodMorningSentence: unknown = "Ready for today") => JSON.stringify({ projects, goodMorningSentence });
const omitted: SummaryTextWarning[] = ["summary-text-omitted"];

describe("shared summary plain-text safety vectors", () => {
  test.each(vectors.text)("$accepted: $text", ({ text, accepted }) => {
    expect(validateSummaryText(text, 240)).toBe(accepted ? text.trim() : null);
    const result = validateSummary(raw([project([text])], text), cards);
    expect(result).toEqual({
      projects: accepted ? [project([text.trim()])] : [],
      goodMorningSentence: accepted ? text.trim() : null,
      warnings: accepted ? [] : omitted,
    });
  });

  test.each(limits.chars)("refused-character predicate parity: $cp", ({ cp, refused }) => {
    expect(isRefusedCharacter(String.fromCodePoint(parseInt(cp.slice(2), 16)))).toBe(refused);
  });

  test.each(["\u2028", "\u2029"])("line separators are refused separately from format parity: %s", (separator) => {
    expect(validateSummary(raw([project([`left${separator}right`])], `left${separator}right`), cards)).toEqual({
      projects: [], goodMorningSentence: null, warnings: omitted,
    });
  });

  test("unpaired UTF-16 surrogates are not Unicode scalars", () => {
    for (const s of ["\ud800", "\udfff", "x\ud800y"]) expect(validateSummaryText(s, 90)).toBeNull();
  });

  test("a key with an unpaired surrogate drops that entry alone, even when a card holds it", () => {
    for (const key of ["project:\ud800", "project:\udfff", "project:a\ud800b"]) {
      expect(validateSummary(raw([project(["Done"], key), project(["Done"])], null), [...cards, { key, label: "Held" }])).toEqual({
        projects: [project(["Done"])], goodMorningSentence: null, warnings: omitted,
      });
    }
    const paired = "project:\ud83e\udd80";
    expect(validateSummary(raw([project(["Done"], paired)], null), [{ key: paired, label: "Crab" }])).toEqual({
      projects: [project(["Done"], paired)], goodMorningSentence: null, warnings: [],
    });
  });
});

describe("summary shape and caps", () => {
  test.each(["bad JSON", "{}", "[]", "null", raw({}, null), raw([], 42), raw([null]),
    raw([{ key: "project:app" }]), raw([project([42])]), raw([{ ...project(), extra: true }]),
    JSON.stringify({ projects: [], goodMorningSentence: null, extra: true }),
  ])("wrong JSON/shape yields no summary: %s", (s) => expect(validateSummary(s, cards)).toBeNull());

  test("one JSON object only, with no surrounding code fences or trailing object", () => {
    expect(validateSummary(raw() + "{}", cards)).toBeNull();
    expect(validateSummary("```json\n" + raw() + "\n```", cards)).toBeNull();
  });

  test("raw cap is exactly 64 KiB of UTF-8, including whitespace", () => {
    const base = raw();
    expect(validateSummary(base + " ".repeat(65536 - Buffer.byteLength(base)), cards)).not.toBeNull();
    expect(validateSummary(base + " ".repeat(65537 - Buffer.byteLength(base)), cards)).toBeNull();
    const unicode = raw([project(["🦀"])], null);
    expect(validateSummary(unicode + " ".repeat(65536 - Buffer.byteLength(unicode)), cards)).not.toBeNull();
    expect(validateSummary(unicode + " ".repeat(65537 - Buffer.byteLength(unicode)), cards)).toBeNull();
  });

  test("64 project entries accepted, 65 rejected, even for unknown keys", () => {
    const allowed = Array.from({ length: 65 }, (_, n) => ({ key: `project:p${n}`, label: `P${n}` }));
    const entries = allowed.map(({ key }) => project(["Done"], key));
    expect(validateSummary(raw(entries.slice(0, 64), null), allowed)?.projects).toHaveLength(64);
    expect(validateSummary(raw(entries, null), allowed)).toBeNull();
    expect(validateSummary(raw(entries, null), [])).toBeNull();
  });

  test("point cap is 1–3; exceeding it invalidates the whole key", () => {
    for (const n of [1, 3]) expect(validateSummary(raw([project(Array(n).fill("Done"))], null), cards)?.projects[0]?.points).toHaveLength(n);
    for (const n of [0, 4]) expect(validateSummary(raw([project(Array(n).fill("Done"))], null), cards)).toEqual({ projects: [], goodMorningSentence: null, warnings: omitted });
  });

  test("points count 1–90 scalars after trimming, sentence counts 1–240", () => {
    for (const s of ["x", "🦀"]) {
      expect(validateSummary(raw([project([s.repeat(90)])], s.repeat(240)), cards)?.warnings).toEqual([]);
      expect(validateSummary(raw([project([s.repeat(91)])], s.repeat(241)), cards)).toEqual({ projects: [], goodMorningSentence: null, warnings: omitted });
    }
    expect(validateSummary(raw([project(["  x  "])], "  y  "), cards)).toEqual({ projects: [project(["x"])], goodMorningSentence: "y", warnings: [] });
    expect(validateSummary(raw([], null), cards)).toEqual({ projects: [], goodMorningSentence: null, warnings: [] });
  });
});

describe("summary membership, duplicates and independent fallback", () => {
  test("keys use exact Map membership, with Other, reserved-looking labels and independent sub-projects", () => {
    const projects = cards.map(({ key }) => project(["Done"], key));
    expect(validateSummary(raw(projects, null), cards)).toEqual({ projects, goodMorningSentence: null, warnings: [] });
    for (const key of ["App", "project:APP", "project:app ", "__proto__", "constructor", "other", "project:missing"]) {
      expect(validateSummary(raw([project(["Dropped"], key), project()], null), cards)).toEqual({ projects: [project()], goodMorningSentence: null, warnings: omitted });
    }
  });

  test("duplicates invalidate that key, including a duplicate with invalid points", () => {
    expect(validateSummary(raw([project(), project(["**bad**"]), project(["Keep"], "other:")]), cards)).toEqual({
      projects: [project(["Keep"], "other:")], goodMorningSentence: "Ready for today", warnings: omitted,
    });
  });

  test("partial points remain with no code-picked filler; no valid points means fallback", () => {
    expect(validateSummary(raw([project(["Keep one", "**bad**", "Keep two"])]), cards)).toEqual({
      projects: [project(["Keep one", "Keep two"])], goodMorningSentence: "Ready for today", warnings: omitted,
    });
    expect(validateSummary(raw([project(["**bad**"])], "Good sentence"), cards)).toEqual({ projects: [], goodMorningSentence: "Good sentence", warnings: omitted });
  });

  test("sentence failure does not discard valid project points", () => {
    expect(validateSummary(raw([project()], "https://bad.example"), cards)).toEqual({ projects: [project()], goodMorningSentence: null, warnings: omitted });
  });

  test("diagnostics are deduplicated fixed codes and do not echo rejected text", () => {
    const result = validateSummary(raw([project(["<SECRET>"]), project(["www.SECRET"], "project:unknown")], "**SECRET**"), cards);
    expect(result).toEqual({ projects: [], goodMorningSentence: null, warnings: omitted });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});

// Engine only (R2-O4): Rust's stored-text check is structural, so these stay out of the shared summary-text-vectors.json.
describe("a credential shape in model text", () => {
  const CREDENTIALS = [
    ["a GitHub token", `Rotated ghp_${"a1B2".repeat(9)} today`],
    ["an Anthropic key", `The sk-ant-api03-${"a1B2c3".repeat(8)} key was added`],
    ["an AWS key id", `Used AKIA${"ABCDEFGHIJKLMNOP"} for the upload`],
    ["an env assignment", `Set API_KEY=${"fixtureSecretValue1234"} in the job`],
  ] as const;
  test.each(CREDENTIALS)("%s is dropped from a point and from the sentence, by the fixed code", (_name, text) => {
    expect(redactCredentials(text)).not.toBe(text);          // the premise: the engine's own redactor would change it
    expect(validateSummaryText(text, 240)).toBeNull();
    expect(validateSummary(raw([project(["Kept point", text])], text), cards)).toEqual({
      projects: [{ key: "project:app", points: ["Kept point"] }],
      goodMorningSentence: null,
      warnings: ["summary-text-omitted"],
    });
  });
  test("ordinary text around the word key is kept", () => {
    for (const text of ["Added the API key setting to the page", "Token refresh is tested", "Password rules are documented"]) {
      expect(validateSummaryText(text, 240)).toBe(text);
    }
  });
  // The known cost, accepted: the rule is the engine's own redactor, which fails closed, so a harmless assignment goes too.
  test("the rule's known cost: an ordinary assignment is dropped, an ordinary mention of a key is kept", () => {
    expect(validateSummaryText("Set MAX_TOKENS=1000000000 for the batch job", 240)).toBeNull();
    expect(validateSummaryText("Added the API key setting to the page", 240)).toBe("Added the API key setting to the page");
  });
});
