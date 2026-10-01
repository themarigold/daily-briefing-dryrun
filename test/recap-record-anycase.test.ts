import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// test/recap-record-anycase.test.ts — normalised text in the Stage-2 RECORD carries no credential past
// redaction, and neither do PR branch words (which also reach the provider prompt). The prompt is not a
// redaction boundary otherwise: it carries raw subjects and the raw labelKey, as Stage 1's does.
//
// Found by the lower-cased-string sweep for #563 and reproduced here before the fix:
//   · `labels[].label` / `campaigns[].label` in `recap-campaigns.jsonl` are the item's `labelKey`,
//     which is `norm(repo)` — LOWER-CASED — and `cleanField` redacts case-sensitively only. Four
//     classes (aws-access-key-id, jwt, private-key-block, env-assignment) stop matching once
//     lower-cased, so a repo folder named like a key id landed in the record as `akia…`.
//   · `branchWords` turns every `/ . _ -` run of a merged PR's branch into a space. That breaks jwt
//     (dots), github-token (`_`), provider-key and slack-token (hyphens), so a credential in a branch
//     name reached the record's `prFact` (and the provider prompt) with nothing left to match.
import { test, expect, describe } from "bun:test";
import {
  recordLabels, recordCampaigns, attachPrFacts, branchWords, formatRecapRecordLine,
  type CampaignItem, type RecapRecordV2,
} from "../src/recapCampaigns";
import { norm } from "../src/subprojects";
import { CREDENTIAL_PATTERNS, REDACTION, matchesCredential } from "../src/transcripts/credentials";

const TOKENS: Record<string, { token: string; secret: string }> = {
  "provider-key": { token: "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", secret: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" },
  "aws-access-key-id": { token: "AKIAIOSFODNN7EXAMPLE", secret: "AKIAIOSFODNN7EXAMPLE" },
  "github-token": { token: "ghp_AbCdEfGhIjKlMnOpQrStUv123456", secret: "AbCdEfGhIjKlMnOpQrStUv123456" },
  "slack-token": { token: "xoxb-123456789012-abcdefghijkl", secret: "abcdefghijkl" },
  "private-key-block": { token: "-----BEGIN RSA PRIVATE KEY-----", secret: "BEGIN RSA PRIVATE KEY" },
  "jwt": { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
           // The run BEFORE the `_`: `branchWords` turns `_` into a space, so the whole signature would
           // never appear verbatim and the branch test would pass vacuously.
           secret: "dozjgNryP4J3jVmNHl0w5N" },
  "env-assignment": { token: "API_TOKEN=s3cr3tvalue1234", secret: "s3cr3tvalue1234" },
  "auth-header": { token: "Authorization: Bearer abcdef1234567890", secret: "abcdef1234567890" },
};
const containsCI = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());

const item = (over: Partial<CampaignItem>): CampaignItem =>
  ({ id: "G1", kind: "single", labelKey: "repo", entries: [0], commits: ["a".repeat(40)], texts: ["did a thing"], fact: "no PR fact", ...over });
/** The record line with only the fields this file is about; `formatRecapRecordLine` walks every leaf. */
const line = (labels: RecapRecordV2["labels"], campaigns: RecapRecordV2["campaigns"]) =>
  formatRecapRecordLine({ v: 2, labels, campaigns } as unknown as RecapRecordV2);

test("premise: one plant per CREDENTIAL_PATTERNS class, and each plant matches its class", () => {
  expect(Object.keys(TOKENS).sort()).toEqual(CREDENTIAL_PATTERNS.map((p) => p.name).sort());
  for (const { token } of Object.values(TOKENS)) expect(matchesCredential(token)).toBe(true);
});

describe("record labels (norm(repo), lower-cased) are redacted in any case", () => {
  for (const [name, { token, secret }] of Object.entries(TOKENS)) {
    test(`${name}: neither labels[] nor campaigns[] carries the secret`, () => {
      const it = item({ labelKey: norm(token) });
      const out = line(recordLabels([it]), recordCampaigns([{ title: "a title", labelKey: it.labelKey, items: [it] }]));
      expect(containsCI(out, secret)).toBe(false);
    });
  }

  test("the join key survives: labels[] and campaigns[] redact one label to the SAME string", () => {
    const it = item({ labelKey: norm(TOKENS["aws-access-key-id"]!.token) });
    const labels = recordLabels([it]);
    const campaigns = recordCampaigns([{ title: "a title", labelKey: it.labelKey, items: [it] }]);
    expect(labels[0]!.label).toBe(REDACTION);
    expect(campaigns[0]!.label).toBe(labels[0]!.label);
  });

  test("a credential-free label is unchanged", () => {
    const it = item({ labelKey: "accountant_ai" });
    expect(recordLabels([it])).toEqual([{ label: "accountant_ai", offered: 1 }]);
    expect(recordCampaigns([{ title: "t", labelKey: "accountant_ai", items: [it] }])[0]!.label).toBe("accountant_ai");
  });
});

describe("PR branch words carry no credential the separator strip broke apart", () => {
  for (const [name, { token, secret }] of Object.entries(TOKENS)) {
    test(`${name}: a branch carrying it reaches neither the fact nor the record`, () => {
      const branch = `me/${token}`;
      const [it] = attachPrFacts([item({})], new Map([["a".repeat(40), { number: 12, branch }]]));
      expect(containsCI(it!.fact, secret)).toBe(false);
      const out = line([], recordCampaigns([{ title: "t", labelKey: "repo", items: [it!] }]));
      expect(containsCI(out, secret)).toBe(false);
    });
  }

  // Review round 1 (LOW): the two halves of the branch check, each pinned by a fixture only it catches.
  test("any case: a LOWER-cased key id in a branch is refused (the case-sensitive matcher misses it)", () => {
    const branch = `me/${TOKENS["aws-access-key-id"]!.token.toLowerCase()}`;
    expect(matchesCredential(branch)).toBe(false);   // premise
    expect(branchWords(branch)).toBe(REDACTION);
  });

  test("after the strip: `x_AKIA…` has no \\b in the raw branch, but its words do", () => {
    const branch = `x_${TOKENS["aws-access-key-id"]!.token}`;
    expect(matchesCredential(branch)).toBe(false);   // premise: `_` is a word character
    expect(branchWords(branch)).toBe(REDACTION);
  });

  test("a credential-free branch renders its words exactly as before", () => {
    expect(branchWords("feat/dba-e-m1a_envelope.redaction")).toBe("feat dba e m1a envelope redaction");
    const [it] = attachPrFacts([item({})], new Map([["a".repeat(40), { number: 7, branch: "fix/x-y" }]]));
    expect(it!.fact).toBe("merged in PR #7 (fix x y)");
  });
});
