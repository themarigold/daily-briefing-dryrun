// test/credentials.span-termination.test.ts — the span-union scan must always advance.
//
// `redactCredentialSpans` (credentials.ts) moves each pattern's stream forward only through `exec`.
// A clone without the `g` flag restarts at 0 on every call, and a global regex that matches "" does
// not move past the empty match by itself: either would spin forever inside every redactor. Neither
// is reachable with today's table, so two things are pinned here: (1) the table really has neither
// property, and (2) the routine terminates, with the right output, when a pattern does.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { CREDENTIAL_PATTERNS, CREDENTIAL_PATTERNS_ANY_CASE, redactCredentials } from "../src/transcripts/credentials";

const MODULE = resolve(import.meta.dir, "../src/transcripts/credentials.ts");

// Texts that exercise every table entry (fake credentials only) plus plain prose and "".
const SAMPLES = [
  "",
  "plain prose with no secret: a-b, c.d; e/f?g#h",
  "clone https://user:hunter2pw@example.test/repo.git",
  `sk-${"A".repeat(24)} sk-ant-api03-${"B".repeat(48)} AKIA${"C".repeat(16)}`,
  `ghp_${"d".repeat(24)} xoxb-${"1".repeat(12)} -----BEGIN RSA PRIVATE KEY-----`,
  `eyJ${"e".repeat(10)}.${"f".repeat(10)}.${"g".repeat(10)} API_TOKEN=abcdefgh1 Authorization: Bearer abcdefgh1`,
];

describe("every table entry can advance a span scan", () => {
  const table: Array<[string, RegExp]> = [
    ...CREDENTIAL_PATTERNS.map((p): [string, RegExp] => [p.name, p.re]),
    ...CREDENTIAL_PATTERNS_ANY_CASE.map((re, i): [string, RegExp] => [`${CREDENTIAL_PATTERNS[i]!.name} (any case)`, re]),
  ];

  test("both tables are the same length and non-empty (the loop below is not vacuous)", () => {
    expect(CREDENTIAL_PATTERNS.length).toBeGreaterThan(0);
    expect(CREDENTIAL_PATTERNS_ANY_CASE.length).toBe(CREDENTIAL_PATTERNS.length);
  });

  for (const [name, re] of table) {
    test(`${name}: global, and never matches the empty string`, () => {
      expect(re.flags).toContain("g");
      for (const text of SAMPLES) {
        const empties = [...text.matchAll(new RegExp(re.source, re.flags))].filter((m) => m[0] === "");
        expect(empties.map((m) => m.index), JSON.stringify(text)).toEqual([]);
      }
    });
  }

  test("the samples really do hit the table (a sample set that matches nothing pins nothing)", () => {
    const hit = new Set(CREDENTIAL_PATTERNS.filter((p) => SAMPLES.some((s) => new RegExp(p.re.source, p.re.flags).test(s))).map((p) => p.name));
    expect([...hit].sort()).toEqual(CREDENTIAL_PATTERNS.map((p) => p.name).sort());
    expect(redactCredentials(SAMPLES[2]!)).toBe("clone https://[redacted]@example.test/repo.git");
  });
});

describe("an injected non-global or empty-matching pattern terminates", () => {
  // Run in a CHILD with a timeout: an infinite loop in synchronous code cannot be interrupted by the
  // test runner's own timeout, so an in-process regression would hang the whole run instead of failing.
  const cases: Array<[string, string, string]> = [
    // [pattern literal, input, expected]
    ["/a/", "a-b-a", "[redacted]-b-[redacted]"],            // non-global: would restart at 0 forever
    ["/x?/g", "a-b", "a-b"],                                 // only empty matches: nothing to redact
    ["/b?/", "a-b-b", "a-[redacted]-[redacted]"],           // non-global AND empty-matching between hits
    ["/(?=b)/g", "abab", "abab"],                            // zero-width lookahead at every `b`
  ];

  test("each case returns the expected text within the deadline", () => {
    const code = [
      `import { redactCredentialSpansForTests as r } from ${JSON.stringify(MODULE)};`,
      `const cases = [${cases.map(([re, input]) => `[${re}, ${JSON.stringify(input)}]`).join(", ")}];`,
      `console.log(JSON.stringify(cases.map(([re, input]) => r(input, [re]))));`,
    ].join("\n");
    const p = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(p.signalCode ?? null, p.stderr.toString()).toBeNull();
    expect(p.exitCode).toBe(0);
    expect(JSON.parse(p.stdout.toString())).toEqual(cases.map(([, , expected]) => expected));
  }, 20_000);   // above the child's 10 s deadline, so a hang fails on the child's kill, not a runner timeout
});
