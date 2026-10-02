// test/credentials.gaps.test.ts — two measured CREDENTIAL_PATTERNS gaps, closed by the user's decision
// (Phase E final harden, user-directed 2026-10-02: "Close both"), plus the `_xoxb-…` variant the same
// change closes. Each case is checked on BOTH matchers — the shared case-sensitive one
// (`matchesCredential` / `redactCredentials` / `ingestScan`) and its case-insensitive clones
// (`matchesCredentialAnyCase` / `redactCredentialsAnyCase`), which are built FROM the shared patterns.
//
//   1. a key id glued to a preceding `_`: `rotate_AKIA…` had no `\b` before AKIA (`_` is a word
//      character), so the key id escaped every redaction;
//   2. an env-style assignment spelled `:=` (`API_TOKEN:=…`, Make / Go): the pattern required `=` right
//      after the name;
//   3. `_xoxb-…` — a Slack token glued to `_`, the same `\b` gap as 1;
//   4. the same `_` glue in front of a GitHub token (`_ghp_…`, every `gh[pousr]_` prefix), a provider
//      key (`MY_KEY_sk-…` — and `_pk-`/`_rk-`/`_ak-`, which share that one pattern) and a JWT
//      (`x_eyJ….….…`): closed by a second decision (user-directed 2026-10-02, "yes, close the
//      underscore ones"), the same lookbehind as 1 and 3.
//   5. a `_` glued AFTER the token (round-2 harden B-M1, the same underscore decision): the trailing `\b`
//      still let `AKIA…_old`, `ghp_…_v2` and `sk-ant-…_x` pass whole, and cut `xoxb-…-abcdefghijkl_old`
//      back to its last hyphen so the tail leaked. Closed with `(?![A-Za-z0-9])` — `\b` minus the
//      underscore, the trailing twin of the lookbehind — on aws, github, provider-key and slack. NOT on
//      jwt: its segments already include `_`, so a trailing `_…` is absorbed into the match (pinned).
//
// NOT closed here — recorded known limits by the user's decision: a Kelvin sign (U+212A) inside
// `API_TOKEN` or a key id (a non-unicode `/i` never folds it to `k`, so this change cannot reach it;
// theoretical), and a key glued to a LETTER (`rotateAKIA…`, `tasksk-…` — closing it would over-redact
// words such as `task-`/`disk-` and breaks the clones' superset property, see credentials.ts). The
// guards at the bottom pin what must STILL not match, and that the any-case matcher stays a superset
// of the shared one.
import { test, expect, describe } from "bun:test";
import {
  matchesCredential, matchesCredentialAnyCase, redactCredentials, redactCredentialsAnyCase, ingestScan,
  credentialHits, REDACTION,
} from "../src/transcripts/credentials";

const AWS = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "s3cr3tvalue1234";
const SLACK = "xoxb-123456789012-abcdefghijkl";
// The same plants as envelope-redaction.test.ts / campaign-label-credential.test.ts.
const GH_RUN = "AbCdEfGhIjKlMnOpQrStUv123456";
const GH = `ghp_${GH_RUN}`;
const SK_RUN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SK = `sk-ant-api03-${SK_RUN}`;
const JWT_SIG = "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const JWT = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${JWT_SIG}`;
const LONG_RUN = "0123456789abcdefghijklmn";

/** [case, text, the part that must not survive, the class that must fire] */
const GAPS: [string, string, string, string][] = [
  ["key id glued to `_`", `rotate_${AWS} now`, AWS.slice(4), "aws-access-key-id"],
  ["key id glued to `_`, at the start", `_${AWS}`, AWS.slice(4), "aws-access-key-id"],
  ["ASIA key id glued to `_`", `tmp_ASIAIOSFODNN7EXAMPLE`, "IOSFODNN7EXAMPLE", "aws-access-key-id"],
  ["`:=` assignment", `API_TOKEN:=${SECRET}`, SECRET, "env-assignment"],
  ["`:=` assignment with spaces", `export DB_PASSWORD := ${SECRET}`, SECRET, "env-assignment"],
  ["`:=` assignment, quoted", `GITHUB_TOKEN:="${SECRET}"`, SECRET, "env-assignment"],
  ["slack token glued to `_`", `x_${SLACK}`, SLACK.slice(5), "slack-token"],
  // 4. — the second decision ("yes, close the underscore ones").
  ["github token glued to `_`", `x_${GH} now`, GH_RUN, "github-token"],
  ["github token glued to `_`, at the start", `_${GH}`, GH_RUN, "github-token"],
  ...[..."ousr"].map((c): [string, string, string, string] =>
    [`gh${c}_ token glued to \`_\``, `tok_gh${c}_${GH_RUN}`, GH_RUN, "github-token"]),
  ["provider key glued to `_`", `MY_KEY_${SK} now`, SK_RUN, "provider-key"],
  ["bare sk- key glued to `_`, at the start", `_sk-${LONG_RUN}`, LONG_RUN, "provider-key"],
  ["pk- key glued to `_` (the same pattern)", `cfg_pk-live-${SK_RUN}`, SK_RUN, "provider-key"],
  ["jwt glued to `_`", `x_${JWT} now`, JWT_SIG, "jwt"],
  ["jwt glued to `_`, at the start", `_${JWT}`, JWT_SIG, "jwt"],
  // 5. — a `_` glued AFTER the token (round-2 harden B-M1).
  ["key id with a `_` glued after", `${AWS}_old`, AWS.slice(4), "aws-access-key-id"],
  ["key id with a `_` on both sides", `_${AWS}_`, AWS.slice(4), "aws-access-key-id"],
  ["ASIA key id with a `_` glued after", `ASIAIOSFODNN7EXAMPLE_tmp`, "IOSFODNN7EXAMPLE", "aws-access-key-id"],
  ["github token with a `_` glued after", `${GH}_v2`, GH_RUN, "github-token"],
  ...[..."ousr"].map((c): [string, string, string, string] =>
    [`gh${c}_ token with a \`_\` glued after`, `gh${c}_${GH_RUN}_x`, GH_RUN, "github-token"]),
  ["provider key with a `_` glued after", `${SK}_x`, SK_RUN, "provider-key"],
  ["bare sk- key with a `_` on both sides", `_sk-${LONG_RUN}_`, LONG_RUN, "provider-key"],
  ["pk- key with a `_` glued after (the same pattern)", `pk-live-${SK_RUN}_old`, SK_RUN, "provider-key"],
  // The tail is the point: the old match stopped at the last hyphen and left `abcdefghijkl` in clear.
  ["slack token with a `_` glued after — its TAIL", `${SLACK}_old`, SLACK.slice(SLACK.lastIndexOf("-") + 1), "slack-token"],
  ["slack token with a `_` on both sides", `x_${SLACK}_old`, SLACK.slice(SLACK.lastIndexOf("-") + 1), "slack-token"],
  // jwt was never open here — its segment class includes `_`, so the match runs on through `_old`.
  ["jwt with a `_` glued after (absorbed, not a gap)", `x_${JWT}_old now`, JWT_SIG, "jwt"],
];

/** The C2 branch slugs (transcripts-transform.test.ts) with a `_` glued in front — and (5.) behind: the
 *  lookarounds now let the `_` through, so only the long-unhyphenated-run rule keeps these out — which
 *  it must. */
const UNDERSCORE_SLUGS = [
  "feat_sk-scikit-learn-experiments-branch", "x_pk-refactor-the-whole-thing", "_ak-47-cleanup-pass-two",
  "my_rk-remove-legacy-adapters-now", "_task-management-system-upgrade", "_risk-averse-decision-making-model",
  "feat_sk-scikit-learn-experiments-branch_v2", "x_pk-refactor-the-whole-thing_old", "_ak-47-cleanup-pass-two_",
  "sk-scikit-learn-experiments-branch_v2", "rk-remove-legacy-adapters-now_wip",
];
/** A key glued to a LETTER (or digit): NOT closed, a recorded known limit by the user's decision —
 *  the same lookbehind is what keeps a word ending in `sk`/`pk`/`rk`/`ak` (`task-`, `disk-`) out. */
const LETTER_GLUED = [
  `rotate${AWS}`, `tasksk-${LONG_RUN}`, `task-${LONG_RUN}`, `disk-${LONG_RUN}`, `xghp_${GH_RUN}`,
  `9ghp_${GH_RUN}`, `x${JWT}`,
];

describe("the closed gaps — every matcher, both redactors, and ingest", () => {
  for (const [name, text, secret, cls] of GAPS) {
    test(name, () => {
      expect(matchesCredential(text)).toBe(true);
      expect(credentialHits(text)).toContain(cls);
      expect(matchesCredentialAnyCase(text)).toBe(true);
      expect(redactCredentials(text)).toContain(REDACTION);
      expect(redactCredentials(text)).not.toContain(secret);
      expect(redactCredentialsAnyCase(text)).not.toContain(secret);
      expect(ingestScan(text)).toEqual({ ok: false, reason: "credential-hit" });
    });
  }

  test("the lower-cased spellings are caught by the any-case clones (a normaliser lower-cases labels)", () => {
    for (const text of [`rotate_${AWS.toLowerCase()}`, `api_token:=${SECRET}`, `x_${SLACK}`]) {
      expect(`${text}: ${matchesCredentialAnyCase(text)}`).toBe(`${text}: true`);
      expect(redactCredentialsAnyCase(text)).toContain(REDACTION);
    }
  });

  test("4.: every re-cased spelling of the `_`-glued gh/sk/jwt plants is caught by the any-case clones", () => {
    for (const tok of [GH, SK, JWT]) {
      for (const text of [`x_${tok.toLowerCase()}`, `X_${tok.toUpperCase()}`, `_${tok.toLowerCase()}`]) {
        expect(`${text}: ${matchesCredentialAnyCase(text)}`).toBe(`${text}: true`);
        expect(redactCredentialsAnyCase(text)).toContain(REDACTION);
      }
    }
  });

  test("5.: every re-cased spelling of the trailing-`_` aws/gh/sk/slack plants is caught by the any-case clones", () => {
    for (const tok of [AWS, GH, SK, SLACK]) {
      for (const text of [`${tok.toLowerCase()}_old`, `${tok.toUpperCase()}_OLD`, `_${tok.toLowerCase()}_`]) {
        expect(`${text}: ${matchesCredentialAnyCase(text)}`).toBe(`${text}: true`);
        expect(redactCredentialsAnyCase(text)).toContain(REDACTION);
      }
    }
  });

  // Round-4 harden B4-L3: titled "the glue word kept" until now, but the last cases pin glue AFTER an
  // sk-ant- key (and jwt's, GAPS above) being ABSORBED — the key's own alphabet includes `_`.
  test("the whole credential is redacted; the glue word before it is kept, and after it unless the key's own alphabet absorbs it (sk-ant-, jwt)", () => {
    expect(redactCredentials(`rotate_${AWS} now`)).toBe(`rotate_${REDACTION} now`);
    expect(redactCredentials(`x_${SLACK} y`)).toBe(`x_${REDACTION} y`);
    expect(redactCredentials(`x_${GH} y`)).toBe(`x_${REDACTION} y`);
    expect(redactCredentials(`MY_KEY_${SK} y`)).toBe(`MY_KEY_${REDACTION} y`);
    expect(redactCredentials(`x_${JWT} y`)).toBe(`x_${REDACTION} y`);
    // 5. — the glue AFTER the token is kept too; only the token goes.
    expect(redactCredentials(`${AWS}_old y`)).toBe(`${REDACTION}_old y`);
    expect(redactCredentials(`${SLACK}_old y`)).toBe(`${REDACTION}_old y`);
    expect(redactCredentials(`${GH}_v2 y`)).toBe(`${REDACTION}_v2 y`);
    // A generic provider key keeps the glue after it, as before…
    expect(redactCredentials(`sk-${LONG_RUN}_x y`)).toBe(`${REDACTION}_x y`);
    expect(redactCredentials(`pk-live-${SK_RUN}_old y`)).toBe(`${REDACTION}_old y`);
    // …but an `sk-ant-` key of real length (SK has 42 characters after `sk-ant-`, over the 40 floor) is
    // matched as BASE64URL since round-3 harden D3-L1 (user-directed 2026-10-02), so a `_x` glued after
    // it is absorbed, exactly as jwt's is (above) — more is redacted, nothing of the key is left.
    expect(redactCredentials(`${SK}_x y`)).toBe(`${REDACTION} y`);
    expect(redactCredentials(`_${AWS}_`)).toBe(`_${REDACTION}_`);
  });
});

describe("the any-case matcher stays a SUPERSET of the shared one", () => {
  test("everything the shared matcher catches, in the corpus below and in every gap case, the clones catch too", () => {
    const corpus = [...GAPS.map(([, t]) => t), `rotate${AWS}`, `X${AWS}`, `rotate_${AWS.toLowerCase()}`,
      "feat/southeastasiapacificexpansion", `_${SLACK}`, `API_TOKEN:=${SECRET}`, `MyAPI_TOKEN=${SECRET}`,
      ...LETTER_GLUED, ...UNDERSCORE_SLUGS, `x_${GH.toLowerCase()}`, `x_${JWT.toLowerCase()}`, `_${SK.toUpperCase()}`];
    for (const t of corpus) {
      if (matchesCredential(t)) expect(`${t}: ${matchesCredentialAnyCase(t)}`).toBe(`${t}: true`);
    }
  });
});

describe("over-redaction guards — what must STILL not match", () => {
  test("a key id inside a longer UPPER-CASE / digit run is not a key id", () => {
    // A predecessor that could extend the id (A-Z, 0-9) still blocks the match, as `\b` did.
    // And (5.) a successor that could extend it, as `\b` did: the trailing lookahead excludes A-Z, a-z, 0-9.
    for (const text of [`X${AWS}`, `9${AWS}`, `${AWS}X`, `${AWS}x`, `${AWS}9`, `_${AWS}X`]) {
      expect(`${text}: ${matchesCredential(text)}`).toBe(`${text}: false`);
    }
  });

  test("the any-case clone does not fire inside a lower-case word", () => {
    // `\b` used to keep `…asia` + 16 letters out; the lookbehind must too, or a branch like this is lost.
    for (const text of ["feat/southeastasiapacificexpansion", "eurasiapacificexpansion2"]) {
      expect(`${text}: ${matchesCredentialAnyCase(text)}`).toBe(`${text}: false`);
    }
  });

  test("assignments that are not credentials, and a `:` that is not `:=`", () => {
    for (const text of ["PATH=/usr/bin:/bin", "GOPATH := /home/me/go", "TOKEN: abcdefghijkl", "x_xoxz-123456789012-abcdefghijkl"]) {
      expect(`${text}: ${matchesCredential(text)}`).toBe(`${text}: false`);
    }
  });

  test("4.: the C2 branch-slug guards still hold with a `_` glued in front (no long unhyphenated run)", () => {
    // transcripts-transform.test.ts pins these slugs bare; the lookbehind must not change their verdict.
    for (const text of UNDERSCORE_SLUGS) {
      expect(`${text}: ${matchesCredential(text)} ${matchesCredentialAnyCase(text)}`).toBe(`${text}: false false`);
      expect(ingestScan(text)).toEqual({ ok: true });
    }
  });

  test("4.: a key glued to a LETTER is still not a key — the recorded known limit, and what keeps `task-`/`disk-` out", () => {
    for (const text of LETTER_GLUED) {
      expect(`${text}: ${matchesCredential(text)} ${matchesCredentialAnyCase(text)}`).toBe(`${text}: false false`);
    }
  });
});
