import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_PATTERNS, CREDENTIAL_PATTERNS_ANY_CASE, REDACTION, credentialHits, ingestScan,
  matchesCredential, matchesCredentialAnyCase, redactCredentials, redactCredentialsAnyCase,
} from "../src/transcripts/credentials";

const POSITIVE: [string, string][] = [
  ["https://user:pass@host", `https://${REDACTION}@host`],
  ["http://user:pass@host/x", `http://${REDACTION}@host/x`],
  ["ssh://user:pw@host:22/x", `ssh://${REDACTION}@host:22/x`],
  ["git+https://user:pw@host/repo.git", `git+https://${REDACTION}@host/repo.git`],
  ["https://x-access-token:TOKEN@github.com/o/r.git", `https://${REDACTION}@github.com/o/r.git`],
  ["https://us%3Aer:p%40ss%3Aword@host/x", `https://${REDACTION}@host/x`],
  ["HTTPS://User:PaSs@HOST/x", `HTTPS://${REDACTION}@HOST/x`],
  ["a1.+-://user:pw@host", `a1.+-://${REDACTION}@host`],
  ["https://:pw@host", `https://${REDACTION}@host`],
  ["https://user:@host", `https://${REDACTION}@host`],
  ["https://user:p:a:ss@host", `https://${REDACTION}@host`],
  ["https://u@ser:p@ss@host/x", `https://${REDACTION}@host/x`],
  ["https://üser:密碼@host/x", `https://${REDACTION}@host/x`],
  ["https://user:pass@host/x at the start", `https://${REDACTION}@host/x at the start`],
  ["at the end https://user:pass@host/x", `at the end https://${REDACTION}@host/x`],
  ["(https://user:pass@host/x)", `(https://${REDACTION}@host/x)`],
  ['"https://user:pass@host/x"', `"https://${REDACTION}@host/x"`],
  ["'https://user:pass@host/x'", `'https://${REDACTION}@host/x'`],
  ["`https://user:pass@host/x`", `\`https://${REDACTION}@host/x\``],
  ["https://a:one@first/x http://b:two@second/y ssh://c:three@third:22/z",
    `https://${REDACTION}@first/x http://${REDACTION}@second/y ssh://${REDACTION}@third:22/z`],
];
// RFC sub-delimiters, percent escapes and Unicode stay admitted; text delimiters do not.
const PUNCTUATION = "!$&'()*+,;=-._~%";
POSITIVE.push([
  `https://u${PUNCTUATION}:p${PUNCTUATION}:@host/x`, `https://${REDACTION}@host/x`,
]);

describe("URL userinfo with a password", () => {
  for (const [input, expected] of POSITIVE) {
    test(`redacts only userinfo: ${input}`, () => {
      expect(credentialHits(input)).toEqual(["url-userinfo"]);
      expect(matchesCredential(input)).toBe(true);
      expect(redactCredentials(input)).toBe(expected);
      expect(redactCredentialsAnyCase(input)).toBe(expected);
      expect(redactCredentials(expected)).toBe(expected);
      expect(matchesCredential(expected)).toBe(false);
      expect(ingestScan(input)).toEqual({ ok: false, reason: "credential-hit" });
    });
  }

  test("case-folded text stays covered, and the any-case clone is a superset", () => {
    const index = CREDENTIAL_PATTERNS.findIndex((p) => p.name === "url-userinfo");
    expect(index).toBeGreaterThanOrEqual(0);
    const shared = CREDENTIAL_PATTERNS[index]!.re;
    const clone = CREDENTIAL_PATTERNS_ANY_CASE[index]!;
    expect(clone.source).toBe(shared.source);
    expect(clone.flags).toContain("i");
    for (const [input, expected] of POSITIVE) {
      for (const text of [input, input.toLowerCase(), input.toUpperCase()]) {
        expect(matchesCredentialAnyCase(text)).toBe(true);
      }
      expect(redactCredentialsAnyCase(input.toLowerCase())).toBe(expected.toLowerCase());
    }
  });

  test("ingestScan drops a transcript why containing a credential URL", () => {
    const why = "I prefer this remote https://user:SECRETMARK@host/repo because it is reproducible";
    expect(ingestScan(why)).toEqual({ ok: false, reason: "credential-hit" });
  });
});

const NEGATIVE = [
  "ssh://git@host", "https://user@host", "git@github.com:org/repo", "user@example.com", "@mention",
  "https://host:8443/", "https://host/a:b@c", "https://host/a@b:c", "https://host?next=a:b@c",
  "https://host#next=a:b@c", "https://host/path?next=user:pw@host", "user:pw@host", "//user:pw@host",
  "1://user:pw@host", "https://host/ https://user@other/a:b@c", "https://user:pw/segment@host",
  "https://user:pw?query@host", "https://user:pw#fragment@host", "https://user:pw\n@host",
  "https://user:pw @host", "https://user:pw\t@host", "task-runner disk-cleanup asiapacific",
];
describe("URL userinfo: ordinary text and non-password URLs stay unchanged", () => {
  for (const input of NEGATIVE) {
    test(input, () => {
      // Non-vacuity: exercise the new class even before it is added to the shared table.
      const pattern = CREDENTIAL_PATTERNS.find((p) => p.name === "url-userinfo");
      expect(pattern).toBeDefined();
      expect(new RegExp(pattern!.re.source, "i").test(input)).toBe(false);
      expect(credentialHits(input)).toEqual([]);
      expect(matchesCredential(input)).toBe(false);
      expect(matchesCredentialAnyCase(input)).toBe(false);
      expect(redactCredentials(input)).toBe(input);
      expect(redactCredentialsAnyCase(input)).toBe(input);
      expect(ingestScan(input)).toEqual({ ok: true });
    });
  }
});


describe("URL userinfo overlap: union every original credential span", () => {
  const overlaps: [string, string][] = [
    ["env-assignment", "PASSWORD=abcdefgh"],
    ["github-token", "ghp_" + "a".repeat(25)],
    ["jwt", "eyJabcdefgh.abcdefgh.abcdefgh"],
    ["provider-key", "sk-" + "a".repeat(25)],
  ];
  for (const [name, token] of overlaps) {
    test(name, () => {
      const input = `https://user:SECRETMARK;${token}@host/repo`;
      expect(credentialHits(input)).toContain(name);
      expect(credentialHits(input)).toContain("url-userinfo");
      expect(matchesCredential(input)).toBe(true);
      expect(matchesCredentialAnyCase(input)).toBe(true);
      expect(ingestScan(input)).toEqual({ ok: false, reason: "credential-hit" });
      // The original env-assignment also covers @host/repo; retaining it leaks part of that match.
      const expected = name === "env-assignment" ? `https://${REDACTION}` : `https://${REDACTION}@host/repo`;
      for (const redact of [redactCredentials, redactCredentialsAnyCase]) {
        expect(redact(input)).toBe(expected);
      }
      expect(redactCredentialsAnyCase(input.toLowerCase())).toBe(expected);
    });
  }
  test("auth-header after the password (its required whitespace cannot occur inside userinfo)", () => {
    const input = "https://user:SECRETMARK@host/repo Authorization: Bearer abcdefghijklmnop";
    expect(credentialHits(input)).toContain("auth-header");
    expect(credentialHits(input)).toContain("url-userinfo");
    for (const redact of [redactCredentials, redactCredentialsAnyCase]) {
      expect(redact(input)).toBe(`https://${REDACTION}@host/repo ${REDACTION}`);
    }
    expect(matchesCredential(input)).toBe(true);
    expect(matchesCredentialAnyCase(input)).toBe(true);
    expect(ingestScan(input).ok).toBe(false);
  });
});

describe("URL userinfo respects surrounding JSON and markup", () => {
  const inputs = [
    '{"endpoint":"https://host:8443","email":"ops@example.com"}',
    '<a href="https://host:8443">ops@example.com</a>',
    '`https://host:8443`@ops',
    '[server](<https://host:8443>)@ops',
    '["https://host:8443","ops@example.com"]',
    ...['"', '<', '>', '`', '{', '}', '|', String.fromCharCode(92), '^', '[', ']']
      .flatMap((delimiter) => [
        `https://host${delimiter}:8443@ops`, // username boundary
        `https://host:8443${delimiter}@ops`, // password boundary
      ]),
  ];
  for (const input of inputs) test(input, () => {
    expect(credentialHits(input)).toEqual([]);
    expect(matchesCredential(input)).toBe(false);
    expect(matchesCredentialAnyCase(input)).toBe(false);
    expect(redactCredentials(input)).toBe(input);
    expect(redactCredentialsAnyCase(input)).toBe(input);
    expect(ingestScan(input)).toEqual({ ok: true });
  });
});
