import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_PATTERNS, CREDENTIAL_PATTERNS_ANY_CASE, REDACTION,
  redactCredentials, redactCredentialsAnyCase, redactCredentialsWithSecret,
} from "../src/transcripts/credentials";
import { parseBriefing } from "../src/generator";
import { renderBriefing } from "../src/render";

const overlaps = [
  // The earlier table entry starts before the later entry, which extends its end.
  ["TOKEN=Authorization: Bearer SECRETMARK1234", REDACTION],
  ["https://user:TOKEN=abcdefgh@SECRETMARK/repo", `https://${REDACTION}`],
  // Reverse start order: the later table entry starts before the URL match.
  ["TOKEN=https://user:SECRETMARK@host/repo", REDACTION],
] as const;

describe("original-text credential span union", () => {
  for (const [input, expected] of overlaps) {
    test(`all redactors cover the full overlap: ${input}`, () => {
      for (const redact of [redactCredentials, redactCredentialsAnyCase]) {
        expect(redact(`before ${input} after`)).toBe(`before ${expected} after`);
      }
      for (const secret of [undefined, "", "unrelated-literal-secret"]) {
        expect(redactCredentialsWithSecret(`before ${input} after`, secret))
          .toBe(`before ${expected} after`);
      }
    });

    test(`rendered briefing covers the full overlap: ${input}`, () => {
      const output = "## RESUME\n- [demo] Keep working\n## RECAP\n- [demo] Finished setup | evidence: abc1234\n## SUGGESTIONS\n- Inspect " + input;
      const raw = renderBriefing(parseBriefing(output, {
        date: "2026-10-24", machineScope: "test", provider: "test",
      }));
      expect(raw).toContain(input); // prove the plant reached the output redactor intact
      const page = redactCredentials(raw);
      expect(page).toContain(`Inspect ${expected}`);
      expect(page).toContain("Keep working");
      expect(page).not.toContain("SECRETMARK");
    });
  }

  test("any-case spans are collected before either case can destroy an overlap", () => {
    for (const input of [
      "token=Authorization: Bearer SECRETMARK1234",
      "https://user:token=abcdefgh@SECRETMARK/repo",
    ]) {
      const expected = input.startsWith("https://") ? `https://${REDACTION}` : REDACTION;
      expect(redactCredentialsAnyCase(`before ${input} after`)).toBe(`before ${expected} after`);
      expect(redactCredentialsAnyCase(input.toLowerCase())).toBe(expected);
    }
  });

  test("adjacent pattern spans produce one replacement", () => {
    const input = "-----BEGIN PRIVATE KEY-----ghp_" + "a".repeat(25);
    for (const redact of [redactCredentials, redactCredentialsAnyCase, redactCredentialsWithSecret]) {
      expect(redact(`before ${input} after`)).toBe(`before ${REDACTION} after`);
    }
  });

  test("ordinary separated matches keep the previous sequential output byte-for-byte", () => {
    const input = "before https://user:pw@host/repo between TOKEN=abcdefgh then Authorization: Bearer abcdefghijkl after";
    const patterns = CREDENTIAL_PATTERNS.map(({ re }) => re);
    const sequential = (res: readonly RegExp[]) => res.reduce(
      (out, re) => out.replace(new RegExp(re.source, re.flags), REDACTION), input,
    );
    const expected = `before https://${REDACTION}@host/repo between ${REDACTION} then ${REDACTION} after`;
    expect(sequential(patterns)).toBe(expected);
    expect(sequential([...patterns, ...CREDENTIAL_PATTERNS_ANY_CASE])).toBe(expected);
    expect(redactCredentials(input)).toBe(expected);
    expect(redactCredentialsAnyCase(input)).toBe(expected);
    expect(redactCredentialsWithSecret(input)).toBe(expected);
    expect(redactCredentialsWithSecret(input, "absent-secret")).toBe(expected);
    expect(redactCredentials("ordinary text PATH=/usr/bin task-runner")).toBe("ordinary text PATH=/usr/bin task-runner");
  });
});
