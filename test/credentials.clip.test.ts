import "./fixtures/isolate-state";
import { expect, test } from "bun:test";
import { CREDENTIAL_PATTERNS, clipBeforeCredential } from "../src/transcripts/credentials";
import { doneSubjectAsShown } from "../src/postcheck";
import { reduce, STAGE1_TEXT_CAP } from "../src/reduce";

const tokens: Record<string, string> = {
  "provider-key": "sk-" + "a".repeat(25),
  "aws-access-key-id": "AKIAIOSFODNN7EXAMPLE",
  "github-token": "ghp_" + "a".repeat(25),
  "slack-token": "xoxb-" + "a".repeat(25),
  "private-key-block": "-----BEGIN RSA PRIVATE KEY-----",
  "jwt": "eyJabcdefgh.abcdefgh.abcdefgh",
  "env-assignment": "PASSWORD=abcdefghijklmno",
  "auth-header": "Authorization: Bearer abcdefghijklmno",
  "url-userinfo": "https://user:SECRETMARK@host/repo",
};

test("clipping plants cover every credential class", () => {
  expect(Object.keys(tokens).sort()).toEqual(CREDENTIAL_PATTERNS.map((p) => p.name).sort());
});

for (const [name, token] of Object.entries(tokens)) test(`raw clips avoid splitting ${name}`, () => {
  const pattern = CREDENTIAL_PATTERNS.find((p) => p.name === name)!;
  const match = new RegExp(pattern.re.source, pattern.re.flags).exec(token)!;
  expect(match).not.toBeNull();
  // Arrange for the stage-1 boundary to land just inside the full match, including its delimiters.
  const prefix = "x".repeat(STAGE1_TEXT_CAP - match.index - 2) + " ";
  const raw = prefix + token + " tail";
  const start = prefix.length + match.index;
  const end = start + match[0].length;
  expect(start).toBeLessThan(STAGE1_TEXT_CAP);
  expect(end).toBeGreaterThan(STAGE1_TEXT_CAP);
  const expected = raw.slice(0, start);
  expect(clipBeforeCredential(raw, STAGE1_TEXT_CAP)).toBe(expected);
  expect(doneSubjectAsShown(raw)).toBe(expected);
  const act = { source: "git", kind: "commit", event_id: "aaa1111", repo: "/r", text: raw + " ".repeat(1000) } as const;
  const ctx = reduce([act], { maxChars: 600 });
  expect(ctx.note).toContain("context trimmed");
  expect(ctx.repos[0]!.activities[0]!.text).toBe(expected);
  expect(clipBeforeCredential(raw, start)).toBe(expected); // at start, no partial match
  if (name === "url-userinfo") {
    expect(clipBeforeCredential(raw, end)).toBe(expected); // preserve its required @ lookahead, too
    expect(clipBeforeCredential(raw, end + 1)).toBe(raw.slice(0, end + 1));
  } else expect(clipBeforeCredential(raw, end)).toBe(raw.slice(0, end)); // complete credential stays raw
});

test("clips account for overlapping spans, keep plain text and retain complete credentials", () => {
  const raw = "fix https://user:SECRETMARK;PASSWORD=abcdefgh@host/repo tail";
  const cut = raw.indexOf("abcdefgh") + 2;
  expect(clipBeforeCredential(raw, cut)).toBe("fix https://");
  expect(clipBeforeCredential("plain text", 5)).toBe("plain");
  expect(clipBeforeCredential(raw, raw.length)).toBe(raw);
  expect(clipBeforeCredential(raw, 0)).toBe("");
});


test("a URL cut exactly before its required @ delimiter backs up in both raw-input paths", () => {
  const lead = "fix https://user:SECRETMARK";
  const raw = lead + "p".repeat(STAGE1_TEXT_CAP - lead.length) + "@host/repo" + " ".repeat(1000);
  expect(raw[STAGE1_TEXT_CAP]).toBe("@");
  expect(clipBeforeCredential(raw, STAGE1_TEXT_CAP)).toBe("fix https://");
  expect(doneSubjectAsShown(raw)).toBe("fix https://");
  const ctx = reduce([{ source: "git", kind: "commit", event_id: "aaa1111", repo: "/r", text: raw }], { maxChars: 600 });
  expect(ctx.note).toContain("context trimmed");
  expect(ctx.repos[0]!.activities[0]!.text).toBe("fix https://");
});
