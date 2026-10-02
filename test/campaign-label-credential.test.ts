import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// test/campaign-label-credential.test.ts — a campaign header must never carry a credential that the
// output-side redaction cannot see.
//
// Reported by a cold reviewer on 2026-10-01 and reproduced here before the fix: tier 3 of
// `campaignKey` builds its label from the LOWER-CASED subject, and four `CREDENTIAL_PATTERNS` classes
// (aws-access-key-id, jwt, private-key-block, env-assignment) are case-sensitive. Two commits titled
// `chore: AKIAIOSFODNN7EXAMPLE rotated in a.ts` / `… b.ts` rendered the header
// `akiaiosfodnn7example rotated — 2 commits (Sep 4)` in BOTH `redactCredentials(renderBriefing(s))`
// (the briefing file) and the redacted JSON envelope — a lower-cased AWS key id is trivially
// reversible, so that is a leak. env-assignment leaks a second way no pattern can catch on the label
// at all: tier 3's tokenizer drops the `=`, so `API_TOKEN=s3cr3tvalue1234` keys `api_token
// s3cr3tvalue1234` — the VALUE, with nothing left for any pattern to anchor on.
//
// The fix fails closed in `campaignKey`, on the SUBJECT and on the finished LABEL: either carrying a
// known-shaped credential in ANY case keys no campaign, so its commit renders under its file cluster. The plants mirror
// envelope-redaction.test.ts's — one per class, checked against `CREDENTIAL_PATTERNS` so a class added
// to the matcher without a plant here fails the premise test.
import { test, expect, describe } from "bun:test";
import { clusterRecap, campaignKey } from "../src/generator";
import { renderBriefing } from "../src/render";
import { redactStruct } from "../src/json";
import { CREDENTIAL_PATTERNS, matchesCredential, redactCredentials } from "../src/transcripts/credentials";
import type { ReducedContext, Activity, BriefingStruct } from "../src/types";

type Row = { file: string; added: number; removed: number };
const d4 = "2026-09-04T10:00:00-07:00";
const commit = (sha: string, subject: string, file: string): Activity =>
  ({ source: "git", kind: "commit", event_id: sha, repo: "/r", timestamp: d4, text: subject,
     meta: { diffstat: [{ file, added: 10, removed: 0 } as Row] } });
const ctxOf = (acts: Activity[]): ReducedContext => ({ repos: [{ repo: "/r", summary: "", activities: acts }] });
type Entry = { repo: string; text: string; evidence?: string; group?: string };
const bullets = (acts: Activity[]): Entry[] => acts.map((a) => ({ repo: "r", text: `prose ${a.event_id}`, evidence: a.event_id }));

/** Same plants as envelope-redaction.test.ts, and the SECRET part of each (what must not reach an
 *  output in any case — `API_TOKEN` is a variable name, the value is the secret). */
const TOKENS: Record<string, { token: string; secret: string }> = {
  "provider-key": { token: "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", secret: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" },
  "aws-access-key-id": { token: "AKIAIOSFODNN7EXAMPLE", secret: "AKIAIOSFODNN7EXAMPLE" },
  "github-token": { token: "ghp_AbCdEfGhIjKlMnOpQrStUv123456", secret: "AbCdEfGhIjKlMnOpQrStUv123456" },
  "slack-token": { token: "xoxb-123456789012-abcdefghijkl", secret: "123456789012-abcdefghijkl" },
  "private-key-block": { token: "-----BEGIN RSA PRIVATE KEY-----", secret: "BEGIN RSA PRIVATE KEY" },
  // Only [A-Za-z0-9_.] — no `-`, so tier 3's tokenizer keeps the whole JWT as ONE token.
  "jwt": { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
           secret: "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" },
  "env-assignment": { token: "API_TOKEN=s3cr3tvalue1234", secret: "s3cr3tvalue1234" },
  "auth-header": { token: "Authorization: Bearer abcdef1234567890", secret: "abcdef1234567890" },
};

/** Two commits that share a tier-3 phrase led by the token, on DIFFERENT files — two file atoms, so
 *  before the fix they merged into one campaign under the token-led label. */
const windowFor = (token: string) => {
  const acts = [commit("1111111aaaa", `chore: ${token} rotated in a.ts`, "a.ts"),
                commit("2222222bbbb", `chore: ${token} rotated in b.ts`, "b.ts")];
  return { acts, out: clusterRecap(bullets(acts), ctxOf(acts)) as Entry[] };
};
const structOf = (recap: Entry[]): BriefingStruct =>
  ({ date: "2026-09-05", machineScope: "x", provider: "p", resume: [], suggestions: [], recap } as BriefingStruct);
const containsCI = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());

describe("campaign labels never carry a credential past redaction", () => {
  test("premise: one plant per CREDENTIAL_PATTERNS class, and each plant matches its class", () => {
    expect(Object.keys(TOKENS).sort()).toEqual(CREDENTIAL_PATTERNS.map((p) => p.name).sort());
    for (const { token } of Object.values(TOKENS)) expect(matchesCredential(token)).toBe(true);
  });

  test("premise: the same window with a CLEAN token still forms a tier-3 campaign (the guard is what refuses)", () => {
    const { out } = windowFor("keyring");
    expect(out.map((e) => e.group)).toEqual(["keyring rotated — 2 commits (Sep 4)", "keyring rotated — 2 commits (Sep 4)"]);
  });

  // The reported repro, verbatim, through both output channels.
  test("AKIAIOSFODNN7EXAMPLE: no group carries it, in the briefing file or the JSON envelope", () => {
    const { out } = windowFor("AKIAIOSFODNN7EXAMPLE");
    const md = redactCredentials(renderBriefing(structOf(out)));
    const json = JSON.stringify(redactStruct(structOf(out)));
    expect(containsCI(md, "AKIAIOSFODNN7EXAMPLE")).toBe(false);
    expect(containsCI(json, "AKIAIOSFODNN7EXAMPLE")).toBe(false);
    // Fell back to the file clusters — each a single commit, so ungrouped.
    expect(out.map((e) => e.group)).toEqual([undefined, undefined]);
  });

  for (const [name, { token, secret }] of Object.entries(TOKENS)) {
    test(`${name}: the secret reaches neither output channel, in any case`, () => {
      const { out } = windowFor(token);
      const md = redactCredentials(renderBriefing(structOf(out)));
      const json = JSON.stringify(redactStruct(structOf(out)));
      expect(containsCI(md, secret)).toBe(false);
      expect(containsCI(json, secret)).toBe(false);
      // …and not merely because the label happened to split the secret apart (provider-key, slack and
      // auth-header labels would be `sk ant` / `xoxb …` / `authorization bearer` without the guard —
      // cold review round 1): the campaign itself is refused.
      expect(out.map((e) => e.group)).toEqual([undefined, undefined]);
    });

    // Fail closed on case alone: a subject that spells the token in a different case than the
    // case-sensitive class expects must not key a campaign either (the label would print it). A Map,
    // so a token that is already all-lower (or all-upper) runs once per distinct spelling.
    const variants = new Map([[token.toUpperCase(), "upper"], [token.toLowerCase(), "lower"], [token, "as issued"]]);
    for (const [variant, spelled] of variants) {
      test(`${name}: campaignKey refuses a subject carrying it (${spelled})`, () => {
        expect(campaignKey(`chore: ${variant} rotated in a.ts`)).toBeUndefined();
        expect(campaignKey(`M8: ${variant} rotated`)).toBeUndefined();   // tier 2 too: one rule, every tier
      });
    }
  }

  // Cold review round 1: tier 3 can MANUFACTURE a match the raw subject lacks, so the finished label
  // is checked too. `_` is a word character, so `_AKIA…` has no `\b` before the key id in the subject;
  // the leading strip drops the `_` and the label gains one. A Kelvin sign (U+212A) is not folded to
  // `k` by a non-unicode `/i`, but `toLowerCase` folds it to ASCII `k`.
  const KELVIN = "\u212A";
  const AWS = TOKENS["aws-access-key-id"]!.token, JWT = TOKENS["jwt"]!.token;
  const manufactured: Record<string, string> = {
    "Kelvin-sign K": AWS.replace("K", KELVIN),
  };
  // ⚠ INVERTED PREMISE, by the USER'S DECISION (2026-10-02, Phase E final harden E16 "Close both"): the
  // shared matcher now catches a key id glued to `_` in the RAW subject (credentials.ts, the
  // aws-access-key-id lookbehind), so these two no longer need the label-side check — the subject
  // check refuses them first. Every assertion after the premise is unchanged; the label-side check
  // stays pinned by the Kelvin row above, which still escapes the raw subject.
  // The JWT row joined them by a second decision (user-directed 2026-10-02, "yes, close the underscore
  // ones": the same lookbehind on jwt, github-token and provider-key), so `_eyJ…` is refused at the
  // subject too — its premise inverted, every assertion after it unchanged.
  const closedAtTheSubject: Record<string, string> = {
    "leading underscore": `_${AWS}`,
    "parenthesised leading underscore": `(_${AWS})`,
    "leading underscore JWT": `_${JWT}`,
  };
  for (const [why, tok] of [...Object.entries(manufactured), ...Object.entries(closedAtTheSubject)]) {
    test(`label-side check: ${why} keys no campaign and reaches neither channel`, () => {
      // premise: the raw subject escapes the shared matcher — except the rows closed at the subject
      expect(matchesCredential(`chore: ${tok} rotated`)).toBe(why in closedAtTheSubject);
      const { out } = windowFor(tok);
      expect(out.map((e) => e.group)).toEqual([undefined, undefined]);
      const md = redactCredentials(renderBriefing(structOf(out)));
      const json = JSON.stringify(redactStruct(structOf(out)));
      const lowered = tok.toLowerCase().replace(/^[^a-z0-9]+/, "").replace(/\)$/, "");
      expect(containsCI(md, lowered)).toBe(false);
      expect(containsCI(json, lowered)).toBe(false);
    });
  }

  test("a credential commit dissolves only ITS atom: the clean commits keep their campaign under a clean label", () => {
    const acts = [commit("1111111aaaa", "chore: keyring rotated in a.ts", "a.ts"),
                  commit("2222222bbbb", "chore: keyring rotated in b.ts", "b.ts"),
                  commit("3333333cccc", "chore: keyring rotated AKIAIOSFODNN7EXAMPLE in c.ts", "c.ts")];
    const out = clusterRecap(bullets(acts), ctxOf(acts)) as Entry[];
    expect(out.map((e) => e.group)).toEqual(["keyring rotated — 2 commits (Sep 4)", "keyring rotated — 2 commits (Sep 4)", undefined]);
  });
});
