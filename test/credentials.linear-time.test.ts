// test/credentials.linear-time.test.ts — the credential matcher runs in LINEAR time, and the rewrite that
// made it so changed nothing that is redacted or detected (2026-10-09).
//
// Measured before the fix (bun 1.3.14, this machine): `jwt` and `env-assignment` were QUADRATIC in a single
// long token. 100k chars of `_eyJ` (or `-eyJ`) took ~9.5 s through the jwt pattern alone, and 100k of
// `SECRET` (or `TOKEN_`) ~1.8 s through env-assignment; doubling the input quadrupled the time, and every
// entry point paid it — `matchesCredential`/`ingestScan` (ingest), `redactCredentials`, `credentialHits`,
// and the any-case pair twice over. Cause, per pattern:
//   - env-assignment: `[A-Z0-9_]*WORD[A-Z0-9_]*` — two stars around the credential word, so a long name
//     with no `=` after it retried every split at every occurrence of the word;
//   - jwt: every `eyJ` after a `_`/`-` is a valid start, and each start scanned its first segment to the
//     end of the same base64url run before failing.
// The rewrites (see the comments on both patterns in src/transcripts/credentials.ts) are argued
// output-preserving there; THIS file is the evidence:
//   1. a DIFFERENTIAL of the original eight classes against a frozen pre-fix table and functions
//      (test/fixtures/credentials-pre-linear.ts), over (a) every string literal in the existing credential
//      tests, (b) a curated corpus of real-looking secrets and near-misses, (c) seeded pseudo-random strings
//      biased toward the patterns' alphabets and prefixes, and (d) long-run adversarial shapes (every
//      formerly-quadratic one among them) at lengths the old code still finishes;
//   2. a TIMING bound (500 ms per 200k chars) and a GROWTH check per entry point on long adversarial inputs.
// The deliberate 2026-10-24 url-userinfo coverage addition is excluded from the LIVE table only for
// the differential, never from its inputs (which include credential URLs) or from timing. The frozen
// fixture is untouched. Test-local sequential runners compare the original classes and exact spans on
// all inputs. On URL-free inputs, production detection is compared directly; production redaction is
// compared to an independent union of the FROZEN patterns' original spans. The 2026-10-29 overlap fix
// deliberately removes tails the old sequential redactors leaked, and merges adjacent replacements.
// This does not prove production equivalence on URL-bearing inputs (covered by dedicated tests).
// Also measured once at the fix, not re-run here: every input the 18 credential-importing test files
// passed to ANY entry point during a full, all-passing run of those files (173,189 unique strings,
// captured in an instrumented scratch copy) gave the same output from both tables — 0 differences across
// all six entry points and all 16 patterns.
import { test, expect, describe } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  CREDENTIAL_PATTERNS, CREDENTIAL_PATTERNS_ANY_CASE,
  REDACTION, credentialHits, ingestScan, matchesCredential, matchesCredentialAnyCase, redactCredentials, redactCredentialsAnyCase,
  redactCredentialsWithSecret,
} from "../src/transcripts/credentials";
import {
  PRE_LINEAR_PATTERNS, PRE_LINEAR_PATTERNS_ANY_CASE,
  preCredentialHits, preIngestScan, preMatchesCredential, preMatchesCredentialAnyCase, preRedactCredentials,
  preRedactCredentialsAnyCase,
} from "./fixtures/credentials-pre-linear";

const REWRITTEN = ["env-assignment", "jwt"];
/** Per-test timeout for the corpus and timing tests: they take seconds, over bun's 5 s default under load. */
const SLOW_TEST_MS = 60_000;

// ── deterministic PRNG (mulberry32) ──────────────────────────────────────────────────────────────
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B64URL = ALNUM + "_-";
const UPPER_NAME = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
const runOf = (alpha: string, n: number, rnd: () => number) => {
  let s = "";
  for (let i = 0; i < n; i++) s += alpha[Math.floor(rnd() * alpha.length)];
  return s;
};
const rep = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

// ── (a) every string literal in the existing credential tests ──────────────────────────────────────
// Read with TypeScript's own parser (as isolation.meta.test.ts does), with a small constant folder so a
// token spelled `"AKIA" + "…"`, `"x".repeat(40)`, `` `…${CONST}…` `` or through a same-file `const` is
// fed whole as well as in pieces. Plus every source line and each file entire, so tokens are also seen
// in the surrounding code text.
function literalsOf(src: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const consts = new Map<string, string>();
  const out: string[] = [];
  const fold = (n: ts.Node): string | undefined => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) return fold(n.expression);
    if (ts.isIdentifier(n)) return consts.get(n.text);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = fold(n.left), r = fold(n.right);
      return l !== undefined && r !== undefined ? l + r : undefined;
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "repeat"
        && n.arguments.length === 1 && ts.isNumericLiteral(n.arguments[0]!)) {
      const base = fold(n.expression.expression), k = Number(n.arguments[0]!.text);
      return base !== undefined && Number.isInteger(k) && base.length * k <= 20_000 ? base.repeat(k) : undefined;
    }
    if (ts.isTemplateExpression(n)) {
      let s = n.head.text;
      for (const span of n.templateSpans) {
        const v = fold(span.expression);
        if (v === undefined) return undefined;
        s += v + span.literal.text;
      }
      return s;
    }
    return undefined;
  };
  // Two passes over `const NAME = <foldable>` so a const built from an earlier const resolves too.
  const collectConsts = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const v = fold(n.initializer);
      if (v !== undefined) consts.set(n.name.text, v);
    }
    ts.forEachChild(n, collectConsts);
  };
  collectConsts(sf);
  collectConsts(sf);
  const visit = (n: ts.Node) => {
    const v = fold(n);
    if (v !== undefined) out.push(v);
    if (ts.isTemplateExpression(n)) out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const TEST_DIR = new URL("./", import.meta.url).pathname;
const SELF = "credentials.linear-time.test.ts";
const IMPORTS_CREDENTIALS = /from\s+["'][^"']*transcripts\/credentials["']/;
const credentialTestFiles: string[] = [];
for (const f of new Glob("**/*.test.ts").scanSync({ cwd: TEST_DIR })) {
  if (f === SELF) continue;
  if (IMPORTS_CREDENTIALS.test(readFileSync(TEST_DIR + f, "utf8"))) credentialTestFiles.push(f);
}
credentialTestFiles.sort();

const existingInputs = new Set<string>();
for (const f of credentialTestFiles) {
  const src = readFileSync(TEST_DIR + f, "utf8");
  existingInputs.add(src);
  for (const line of src.split("\n")) existingInputs.add(line);
  for (const lit of literalsOf(src, f)) existingInputs.add(lit);
}

// ── (b) curated: real-looking secrets, every pattern's target, and the near-misses its guards keep out ──
// Assembled from pieces at runtime so no whole provider-format secret sits in the source.
const j = (...parts: string[]) => parts.join("");
const TOKENS: string[] = [
  // AWS
  j("AKIA", "IOSFODNN7EXAMPLE"), j("ASIA", "Y34FZKBOKMUTVV7A"), j("AKIA", "IOSFODNN7EXAMPL"), j("AKIA", "IOSFODNN7EXAMPLEX"),
  j("aws_secret_access_key = ", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
  j("AWS_SECRET_ACCESS_KEY=", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
  // GitHub
  ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].map((p) => j(p, "16C7e42F292c6912E7710c838347Ae178B4a")),
  j("ghp_", "short123"), j("github_pat_", "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV"),
  // Slack
  ...["xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-"].map((p) => j(p, "123456789012-123456789012-", "AbCdEfGhIjKlMnOpQrStUvWx")),
  j("xoxb-", "123456789012-abcdefghijkl"), j("xoxb-", "12345"), j("xoxe-", "1-abcdefghijklmnop"),
  j("https://hooks.slack.com/services/", "T00000000/B00000000/", "XXXXXXXXXXXXXXXXXXXXXXXX"),
  // Stripe-, OpenAI- and Anthropic-shaped keys (provider-key owns `sk-`/`pk-`/`rk-`/`ak-`; Stripe's `_`
  // form is NOT matched)
  j("sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc"), j("pk", "_test_", "TYooMQauvdEDq54NiTphI7jx"), j("rk", "_live_", "51H8xAbCdEfGh"),
  j("sk-", "4eC39HqLyjWDarjtT1zdp7dc"), j("pk-", "live-", "4eC39HqLyjWDarjtT1zdp7dc"), j("rk-", "a-b-c-", "4eC39HqLyjWDarjtT1zdp7dc"),
  j("ak-", "1234567-", "abcdefghijklmnopqrstuvwx"), j("sk-", "proj-", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefABCDEF"),
  j("sk-", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefABCDEF"),
  j("sk-ant-", "api03-", "AbCdEfGh_IjKlMnOp-QrStUvWxYz0123456789", "abcdefghij-klmnopqrst_uvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab", "AA"),
  j("sk-ant-", "admin01-", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcdefghijklmnop"),
  j("sk-ant-", "feature-branch-name"), j("sk-ant-", "x".repeat(39)), j("sk-ant-", "x".repeat(40)),
  // JWT / JWE
  j("eyJ", "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0", ".", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"),
  j("eyJ", "hbGciOiJSUzI1NiJ9", ".", "eyJpc3MiOiJodHRwczovL2V4YW1wbGUuY29tIn0", ".", "AbC-dEf_GhI-jKl_MnO"),
  j("eyJ", "hbGciOiJSU0EtT0FFUCJ9", ".", "OKOawDo13gRp2ojaHV7LFpZcgV7T6DVZKTyKOMTYUmKoTCVJRgckCL9kiMT03JGe", ".", "48V1_ALb6US04U3b", ".", "5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4vpzs9tX_EFShS8iB7j6ji", ".", "XFBoMYUZodetZdvTiFvSkQ"),
  j("eyJ", "abcdefgh", ".", "abcdefgh", ".", "abcdefgh"), j("eyJ", "abcdefg", ".", "abcdefgh", ".", "abcdefgh"),
  j("eyJ", "abcdefgh", ".", "abcdefgh", ".", "abcdefgh", "-"), j("eyJ", "abcdefgh", ".", "abcdefgh", ".", "abcdefgh", "---", "_x"),
  j("eyJ", "aaaa_eyJbbbbbbbb", ".", "cccccccc", ".", "dddddddd"), j("eyJ", "a-eyJbbbbbbbb", ".", "cccccccc", ".", "dd-eyJdddddddd"),
  j("xeyJ", "abcdefgh_eyJabcdefgh", ".", "abcdefgh", ".", "abcdefgh"),
  j("eyJ", "abcdefgh", ".", "abcdefgh", ".", "abcdefgh", "---", "eyJabcdefgh", ".", "abcdefgh", ".", "abcdefgh"),
  j("eyJ", "abcdefgh", ".", "abcdefgh", ".", "abcd-eyJefgh", ".", "abcdefgh", ".", "abcdefgh"),
  // PEM
  j("-----BEGIN RSA ", "PRIVATE KEY-----\n", "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB", "\n-----END RSA ", "PRIVATE KEY-----"),
  "-----BEGIN PRIVATE KEY-----", "-----BEGIN EC PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY-----",
  "-----BEGIN PGP PRIVATE KEY BLOCK-----", "-----BEGIN ENCRYPTED PRIVATE KEY-----", "-----BEGIN PUBLIC KEY-----",
  "-----BEGIN DSA PRIVATE KEY-----",
  // Authorization headers
  "Authorization: Bearer abcdef1234567890", "authorization:basic dXNlcjpwYXNzd29yZA==", "Authorization: Token 0123456789abcdef",
  "AUTHORIZATION :  Bearer   a.b.c~d+e/f=g-h", "Authorization: Bearer short", "Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==",
  "Authorization: Digest username=\"x\"", "Authorization: Bearer\n0123456789abcdef",
  // KEY=value lines
  'export API_KEY="0123456789abcdef"', "DB_PASSWORD='correct-horse-battery'", "SECRET_KEY_BASE=abcdef0123456789abcdef",
  "API_TOKEN:=s3cr3tvalue1234", "PASSWD = hunter2hunter2", "MY_PRIVATE_KEY=abcdefgh12345678", "ACCESS_KEY: notassigned",
  "token=lowercase12345", "PATH=/usr/bin:/bin", "TOKEN=short", "SECRET=\nnextline12345", "GITHUB_TOKEN=" + j("ghp_", "16C7e42F292c6912E7710c838347Ae178B4a"),
  "APIKEY=`backticked12345`", "X_SECRET_Y_TOKEN_Z=abcdefgh12345678", "NOT_A_CREDENTIAL=abcdefgh12345678",
  "docker run -e POSTGRES_PASSWORD=mysecretpassword postgres", "mysql -p S3cretPW", '{"apiKey":"sk-abcdefghijklmnopqrstuvwx"}',
  "//registry.npmjs.org/:_authToken=" + j("npm_", "abcdefghijklmnopqrstuvwxyz0123456789"), "https://user:p4ssw0rd@example.com/repo.git",
  "TOKEN TOKEN TOKEN = value12345", "SECRETSECRETSECRET=abcdefgh12345678", "SECRETSECRETSECRET abcdefgh12345678",
  "aws_access_key_id=AKIAIOSFODNN7EXAMPLE", "api_key = abcdefgh12345678",
  // slug guards and the other near-misses the pattern comments record
  "pk-refactor-the-whole-thing", "ak-47-cleanup-pass-two", "sk-scikit-learn-experiments-branch", "rk-remove-legacy-adapters-now",
  "feat/asiapacificexpansion", "task-runner", "disk-cleanup", "rotateAKIAIOSFODNN7EXAMPLE", "tasksk-abcdefghijklmnopqrstuvwx",
  "x_sk-scikit-learn-experiments-branch_v2",
];
const CONTEXTS: ((t: string) => string)[] = [
  (t) => t, (t) => `prefix ${t} suffix`, (t) => `_${t}`, (t) => `${t}_old`, (t) => `x${t}`, (t) => `${t}x`,
  (t) => t.toLowerCase(), (t) => t.toUpperCase(), (t) => `"${t}"`, (t) => `'${t}'.`, (t) => `Bearer ${t}`,
  (t) => `export API_TOKEN=${t}`, (t) => `line one\n${t}\nline three`, (t) => `${t} ${t}`, (t) => `${t}_${t}`, (t) => `${t}-${t}`,
  (t) => `(${t}),`, (t) => `you wrote: "export KEY=${t}"`, (t) => `see ${t}... then ${t.slice(0, Math.floor(t.length / 2))}`,
];
const curated = new Set<string>();
for (const t of TOKENS) for (const c of CONTEXTS) curated.add(c(t));

// ── (c) seeded pseudo-random strings, biased toward the patterns' alphabets and prefixes ──────────────
const PIECES = [
  "sk-", "sk-ant-", "sk-ant-api03-", "pk-", "rk-", "ak-", "AKIA", "ASIA", "ghp_", "gho_", "ghu_", "ghs_", "ghr_",
  "xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-", "eyJ", "eyj", "EYJ", "-----BEGIN ", "RSA ", "EC ", "OPENSSH ", "PGP ",
  "PRIVATE KEY-----", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "APIKEY", "API_KEY", "ACCESS_KEY", "PRIVATE_KEY",
  "secret", "token", "Authorization", "authorization", ":", ": ", "Bearer ", "Basic ", "Token ", "=", ":=", " = ",
  "'", '"', "`", ".", "..", "_", "-", "--", " ", "  ", "\n", "\t", "/", "+", "~",
];
const ALPHABETS = [
  ALNUM, B64URL, UPPER_NAME, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "0123456789abcdef", "abcdefghijklmnopqrstuvwxyz",
  ALNUM + "+/=", B64URL + ".",
];
/** Run lengths at and around each pattern's quantifier floors (aws 16, github/provider 20, sk-ant 40, …). */
const PINNED_LENGTHS = [7, 8, 9, 10, 15, 16, 17, 19, 20, 21, 39, 40, 41];
const KEYWORDS = ["SECRET", "TOKEN", "PASSWORD", "PASSWD", "APIKEY", "API_KEY", "ACCESS_KEY", "PRIVATE_KEY"];
/** Whole near-tokens, one per class, with every length straddling that class's floor. */
const nearToken = (rnd: () => number): string => {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const run = (alpha: string, ns: number[]) => runOf(alpha, pick(ns), rnd);
  switch (Math.floor(rnd() * 10)) {
    case 0: return pick(["AKIA", "ASIA"]) + run("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", [15, 16, 17]);
    case 1: return `gh${pick([..."pousrx"])}_` + run(ALNUM, [19, 20, 21]);
    case 2: return `xox${pick([..."abprsx"])}-` + run(ALNUM + "-", [9, 10, 11, 30]);
    case 3: return `${pick(["sk", "pk", "rk", "ak"])}-` + Array.from({ length: Math.floor(rnd() * 5) }, () => run(ALNUM, [1, 4, 8, 9]) + "-").join("") + run(ALNUM, [19, 20, 21]);
    case 4: return "sk-ant-" + run(B64URL, [39, 40, 41, 90]);
    case 5: return "eyJ" + run(B64URL, [7, 8, 9, 30]) + "." + run(B64URL, [7, 8, 9]) + "." + run(B64URL, [7, 8, 9, 20]) + pick(["", "-", "--", "_"]);
    // An `eyJ` before another in the same run (glued to a letter or not): the shape jwt's start rule decides.
    case 9: return pick(["", "x", "_", "-", "x_"]) + "eyJ" + run(B64URL, [0, 1, 4, 9]) + pick(["_", "-"]) + "eyJ" + run(B64URL, [7, 8, 9])
      + "." + run(B64URL, [7, 8, 9]) + "." + run(B64URL, [7, 8, 9]);
    case 6: return `-----BEGIN ${pick(["", "RSA ", "EC ", "OPENSSH ", "PGP ", "DSA "])}PRIVATE KEY-----`;
    case 7: return run(UPPER_NAME, [0, 1, 3]) + pick(KEYWORDS) + run(UPPER_NAME, [0, 2]) + pick(["=", ":=", " = ", ":", " ", "\n="])
      + pick(["", "'", '"', " "]) + run(ALNUM + "/+=-", [7, 8, 9]);
    default: return pick(["Authorization", "authorization"]) + pick([":", " : ", ""]) + pick(["Bearer ", "Basic ", "Token ", "Bearer"])
      + run(ALNUM + "._~+/=-", [7, 8, 9]);
  }
};
const random = new Set<string>();
{
  const rnd = prng(0x5eed_c0de);
  while (random.size < 4000) {
    let s = "";
    const parts = 1 + Math.floor(rnd() * 24);
    for (let i = 0; i < parts; i++) {
      const r = rnd();
      s += r < 0.15 ? nearToken(rnd)
        : r < 0.6 ? PIECES[Math.floor(rnd() * PIECES.length)]!
        : runOf(ALPHABETS[Math.floor(rnd() * ALPHABETS.length)]!, rnd() < 0.4
          ? PINNED_LENGTHS[Math.floor(rnd() * PINNED_LENGTHS.length)]!
          : 1 + Math.floor(rnd() * (rnd() < 0.8 ? 12 : 60)), rnd);
    }
    random.add(s);
    // A case-scrambled twin feeds the any-case clones.
    random.add(s.replace(/[a-z]/gi, (ch) => (rnd() < 0.5 ? ch.toLowerCase() : ch.toUpperCase())));
  }
}

// Adversarial shapes: long runs of what each pattern's prefix and charset accept, every formerly-quadratic
// shape among them. The differential (d) takes them small, where the old code still finishes; the timing
// tests take them at 100k and 200k.
const ADVERSARIAL_SHAPES: Record<string, (n: number) => string> = {
  "SECRET run": (n) => rep("SECRET", n),
  "secret run": (n) => rep("secret", n),
  "Secret run": (n) => rep("Secret", n),
  "TOKEN_ run": (n) => rep("TOKEN_", n),
  "SECRET then spaces": (n) => "SECRET" + " ".repeat(n - 6),
  "SECRET= then spaces": (n) => "SECRET=" + " ".repeat(n - 7),
  "_eyJ run": (n) => rep("_eyJ", n),
  "-eyJ run": (n) => rep("-eyJ", n),
  "-eyj run": (n) => rep("-eyj", n),
  "_eyj run": (n) => rep("_eyj", n),
  "_eyJ run then a segment": (n) => rep("_eyJ", n - 11) + ".abcdefghij",
  "eyJ + base64url": (n) => "eyJ" + runOf(B64URL, n - 3, prng(n)),
  "-sk-ant- run": (n) => rep("-sk-ant-", n),
  "_sk- run": (n) => rep("_sk-", n),
  "-xoxb- run": (n) => rep("-xoxb-", n),
  "_ghp_ run": (n) => rep("_ghp_", n),
  "_AKIA run": (n) => rep("_AKIA", n),
  "Authorization: then spaces": (n) => "Authorization:" + " ".repeat(n - 14),
  "base64url": (n) => runOf(B64URL, n, prng(n + 1)),
  "A run": (n) => rep("A", n),
  "URL username without @": (n) => "https://" + "a".repeat(n),
  "URL colons without @": (n) => "https://user:" + ":".repeat(n),
  // n repetitions, so the timing sizes below exercise 600k and 1.2M characters here.
  "URL repeated schemes without @": (n) => "a://b:".repeat(n),
};
const adversarialSmall = new Set<string>();
for (const g of Object.values(ADVERSARIAL_SHAPES)) for (const n of [97, 1000, 3000]) adversarialSmall.add(g(n));

// ── the differential ─────────────────────────────────────────────────────────────────────────────
type Entry = [name: string, now: (s: string) => unknown, pre: (s: string) => unknown];
const ENTRIES: Entry[] = [
  ["redactCredentials", redactCredentials, preRedactCredentials],
  ["redactCredentialsAnyCase", redactCredentialsAnyCase, preRedactCredentialsAnyCase],
  ["matchesCredential", matchesCredential, preMatchesCredential],
  ["matchesCredentialAnyCase", matchesCredentialAnyCase, preMatchesCredentialAnyCase],
  ["credentialHits", (s) => credentialHits(s).join(","), (s) => preCredentialHits(s).join(",")],
  ["ingestScan", (s) => JSON.stringify(ingestScan(s)), (s) => JSON.stringify(preIngestScan(s))],
];

// Project out ONLY the deliberately added class. Compare all the old classes on the entire corpus,
// including URLs; skipping credential-bearing strings would lose unrelated matches in those strings.
const LEGACY_PATTERNS = CREDENTIAL_PATTERNS.filter((p) => p.name !== "url-userinfo");
const LEGACY_REGEXES = LEGACY_PATTERNS.map((p) => p.re);
const LEGACY_ANY_CASE = CREDENTIAL_PATTERNS_ANY_CASE.filter((_, i) => CREDENTIAL_PATTERNS[i]!.name !== "url-userinfo");
const legacyMatches = (s: string, patterns: readonly RegExp[]) =>
  patterns.some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(s));
const legacyRedact = (s: string, patterns: readonly RegExp[]) =>
  patterns.reduce((out, re) => out.replace(new RegExp(re.source, re.flags), REDACTION), s);
const DIFFERENTIAL_ENTRIES: Entry[] = [
  ["redactCredentials", (s) => legacyRedact(s, LEGACY_REGEXES), preRedactCredentials],
  ["redactCredentialsAnyCase", (s) => legacyRedact(legacyRedact(s, LEGACY_REGEXES), LEGACY_ANY_CASE), preRedactCredentialsAnyCase],
  ["matchesCredential", (s) => legacyMatches(s, LEGACY_REGEXES), preMatchesCredential],
  ["matchesCredentialAnyCase", (s) => legacyMatches(s, LEGACY_ANY_CASE), preMatchesCredentialAnyCase],
  ["credentialHits", (s) => LEGACY_PATTERNS.filter((p) => legacyMatches(s, [p.re])).map((p) => p.name).join(","),
    (s) => preCredentialHits(s).join(",")],
  ["ingestScan", (s) => JSON.stringify(legacyMatches(s, LEGACY_REGEXES) ? { ok: false, reason: "credential-hit" } : { ok: true }),
    (s) => JSON.stringify(preIngestScan(s))],
];

/** Independent bounded-corpus oracle: mark each character covered by the frozen patterns, then emit
 *  one replacement per covered run. No production merge/stream-selection logic is reused. */
function frozenSpanUnion(text: string, patterns: readonly RegExp[]): string {
  const covered = new Uint8Array(text.length);
  for (const re of patterns) for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
    covered.fill(1, m.index, m.index + m[0].length);
  }
  const parts: string[] = [];
  let copied = 0;
  for (let i = 0; i < text.length; i++) {
    if (!covered[i]) continue;
    parts.push(text.slice(copied, i), REDACTION);
    while (covered[i]) i++;
    copied = i;
  }
  parts.push(text.slice(copied));
  return parts.join("");
}

/** Test-local sequential runners on every input, production entry points on URL-free inputs, AND every
 *  original pattern on its own in both cases — a per-pattern difference could
 *  otherwise hide behind an earlier pattern's redaction in the sequential `replace` chain. */
function differences(corpus: Iterable<string>): string[] {
  const out: string[] = [];
  for (const s of corpus) {
    for (const [name, now, pre] of DIFFERENTIAL_ENTRIES) {
      const a = pre(s), b = now(s);
      if (a !== b) out.push(`${name} on ${JSON.stringify(s).slice(0, 160)}: was ${JSON.stringify(a)}, now ${JSON.stringify(b)}`);
    }
    if (!s.includes("://")) for (const [name, now, pre] of ENTRIES) {
      const original = PRE_LINEAR_PATTERNS.map(({ re }) => re);
      const a = name === "redactCredentials" ? frozenSpanUnion(s, original)
        : name === "redactCredentialsAnyCase" ? frozenSpanUnion(s, [...original, ...PRE_LINEAR_PATTERNS_ANY_CASE])
        : pre(s);
      const b = now(s);
      if (a !== b) out.push(`production ${name} on ${JSON.stringify(s).slice(0, 160)}: was ${JSON.stringify(a)}, now ${JSON.stringify(b)}`);
    }
    for (let i = 0; i < PRE_LINEAR_PATTERNS.length; i++) {
      for (const [label, o, n] of [
        ["", PRE_LINEAR_PATTERNS[i]!.re, LEGACY_PATTERNS[i]!.re],
        ["/i", PRE_LINEAR_PATTERNS_ANY_CASE[i]!, LEGACY_ANY_CASE[i]!],
      ] as const) {
        // NUL marks each match, so the comparison sees every match's exact span.
        const a = s.replace(new RegExp(o.source, o.flags), "\u0000"), b = s.replace(new RegExp(n.source, n.flags), "\u0000");
        if (a !== b) out.push(`${PRE_LINEAR_PATTERNS[i]!.name}${label} on ${JSON.stringify(s).slice(0, 160)}`);
      }
    }
  }
  return out;
}

/** Per-pattern hit counts under the OLD table — the non-vacuity floor for each corpus. */
function hitsByPattern(corpus: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(PRE_LINEAR_PATTERNS.map((p) => [p.name, 0]));
  for (const s of corpus) for (const name of preCredentialHits(s)) out[name]!++;
  return out;
}

describe("differential: the frozen pre-fix matcher and the live original classes agree", () => {
  test("premise: the frozen copy is the pre-fix table — same classes, and only the two rewritten patterns differ", () => {
    expect(PRE_LINEAR_PATTERNS.map((p) => p.name)).toEqual(LEGACY_PATTERNS.map((p) => p.name));
    const differing = LEGACY_PATTERNS
      .filter((p, i) => p.re.source !== PRE_LINEAR_PATTERNS[i]!.re.source || p.re.flags !== PRE_LINEAR_PATTERNS[i]!.re.flags)
      .map((p) => p.name)
      .sort();
    expect(differing).toEqual(REWRITTEN);
  });

  test("premise: only the new URL class is excluded from the differential, and timing uses the full table", () => {
    expect(CREDENTIAL_PATTERNS.map((p) => p.name)).toEqual(["url-userinfo", ...PRE_LINEAR_PATTERNS.map((p) => p.name)]);
    const url = "https://user:p4ssw0rd@example.com/repo.git";
    expect(preRedactCredentials(url)).toBe(url);
    expect(legacyRedact(url, LEGACY_REGEXES)).toBe(url);
    expect(redactCredentials(url)).toBe(`https://${REDACTION}@example.com/repo.git`);
    expect(credentialHits(url)).toEqual(["url-userinfo"]);
  });

  test(`(a) every literal, line and file of the existing credential tests`, () => {
    // Floor: the glob must still find the credential tests (18 at the time of writing).
    expect(credentialTestFiles.length).toBeGreaterThanOrEqual(15);
    expect(existingInputs.size).toBeGreaterThan(5_000);
    const hits = hitsByPattern(existingInputs);
    for (const [name, n] of Object.entries(hits)) expect(`${name}: ${n > 0}`).toBe(`${name}: true`);
    expect(differences(existingInputs)).toEqual([]);
  }, SLOW_TEST_MS);

  test("(b) curated real-looking secrets and near-misses, each in many contexts", () => {
    const hits = hitsByPattern(curated);
    for (const name of REWRITTEN) expect(hits[name]!).toBeGreaterThan(100);
    for (const [name, n] of Object.entries(hits)) expect(`${name}: ${n > 0}`).toBe(`${name}: true`);
    expect(differences(curated)).toEqual([]);
  }, SLOW_TEST_MS);

  test("(c) seeded pseudo-random strings biased toward the patterns' alphabets and prefixes", () => {
    expect(random.size).toBeGreaterThanOrEqual(4000);
    const hits = hitsByPattern(random);
    for (const [name, n] of Object.entries(hits)) expect(`${name}: ${n > 0}`).toBe(`${name}: true`);
    expect(differences(random)).toEqual([]);
  }, SLOW_TEST_MS);

  test("(d) every adversarial shape, at lengths the old code still finishes", () => {
    expect(differences(adversarialSmall)).toEqual([]);
  }, SLOW_TEST_MS);
});

// ── timing ───────────────────────────────────────────────────────────────────────────────────────
// A generous absolute bound at size 200k (the input length for most shapes; the repeated-schemes shape is
// 6x that), and a growth check, both on CPU time (see `cpuMs`): doubling
// the input must not come close to 4x the time (quadratic is 4x, linear 2x). Best of 2 interleaved
// rounds per size against noise, plus a small absolute slack. At the rewrite, linear was ~15-70 ms per
// call at 200k (all eight original patterns scan the input; the any-case entry points twice); the old
// code took 1.8-10 s per call at 100k. The bound is checked at the smaller size first, so a regression fails at 100k instead
// of grinding through 200k.
// The shapes cover the formerly quadratic runs in each case the any-case clones see, ordinary long
// input, and the new URL rule's long usernames, colons and repeated schemes (up to 1.2M chars).
// The bound is BOUND_MS per BOUND_CHARS of input (never below BOUND_MS): an input of 200k chars or less
// gets 500 ms, and a longer one a proportional bound, so the 1.2M-char repeated-schemes shape gets 3000 ms
// (measured 2026-10-29 for that shape: the any-case redactor took 304 ms locally, linear there, and 566 ms
// on the CI runner, where the old flat 500 ms failed it before growth was checked). The growth check
// below is what rejects superlinear time, at every length.
const BOUND_MS = 500;
const BOUND_CHARS = 200_000;
const boundFor = (s: string): number => BOUND_MS * Math.max(1, s.length / BOUND_CHARS);
const GROWTH_RATIO = 3;
const GROWTH_SLACK_MS = 5;
const SIZES = [100_000, 200_000];
const TIMING_SHAPES = [
  "SECRET run", "secret run", "TOKEN_ run", "_eyJ run", "_eyj run", "-eyJ run", "-eyj run", "_eyJ run then a segment", "SECRET then spaces", "base64url",
  "URL username without @", "URL colons without @", "URL repeated schemes without @",
];

/** This process's CPU time for one call, NOT wall time. Measured: with every core busy, wall-clock
 *  growth for a linear call read 9.4 → 45.0 ms (a false "quadratic") because the scheduler preempted
 *  the larger run; CPU time is not charged for time spent descheduled. */
function cpuMs(fn: (s: string) => unknown, s: string): number {
  const before = process.cpuUsage();
  fn(s);
  const d = process.cpuUsage(before);
  return (d.user + d.system) / 1000;
}

describe("timing: every entry point is linear on long adversarial input", () => {
  test("premise: every timing shape exists", () => {
    for (const shape of TIMING_SHAPES) expect(`${shape}: ${shape in ADVERSARIAL_SHAPES}`).toBe(`${shape}: true`);
  });
  for (const shape of TIMING_SHAPES) {
    const gen = ADVERSARIAL_SHAPES[shape]!;
    test(shape, () => {
      if (shape.startsWith("URL ")) {
        // Non-vacuity: the timing run must include the URL matcher, not just the old fast table.
        expect(credentialHits(gen(200) + " https://user:pw@host")).toContain("url-userinfo");
        expect(matchesCredential(gen(200))).toBe(false);
      }
      for (const [name, fn] of ENTRIES) {
        fn(gen(200));   // warm the regex compile
        const inputs = SIZES.map(gen);
        const best = SIZES.map(() => Infinity);
        // Two interleaved rounds (small, large, small, large), so a burst of load lands on both sizes.
        for (let round = 0; round < 2; round++) {
          inputs.forEach((s, i) => {
            const ms = cpuMs(fn, s);
            if (round === 0) {
              const bound = boundFor(s);
              const shown = bound.toFixed(0);
              expect(`${name} @ ${s.length} chars: ${ms < bound ? "under" : `${ms.toFixed(0)} ms, over`} ${shown} ms`)
                .toBe(`${name} @ ${s.length} chars: under ${shown} ms`);
            }
            best[i] = Math.min(best[i]!, ms);
          });
        }
        for (let i = 1; i < best.length; i++) {
          const [prev, cur] = [best[i - 1]!, best[i]!];
          const ok = cur < GROWTH_RATIO * prev + GROWTH_SLACK_MS;
          expect(`${name} ${SIZES[i - 1]}→${SIZES[i]}: ${ok ? "linear" : `${prev.toFixed(1)} → ${cur.toFixed(1)} ms`}`)
            .toBe(`${name} ${SIZES[i - 1]}→${SIZES[i]}: linear`);
        }
      }
    }, SLOW_TEST_MS);
  }
});

describe("timing: original-text span union", () => {
  for (const [name, unit, replacement, redactors] of [
    ["many overlapping matches", "TOKEN=Authorization: Bearer ghp_" + "a".repeat(25) + " ", `${REDACTION} `,
      [redactCredentials, redactCredentialsAnyCase, (s: string) => redactCredentialsWithSecret(s, "ghp_" + "a".repeat(25))]],
    ["any-case overlapping matches", "token=authorization: bearer ghp_" + "a".repeat(25) + " ", `${REDACTION} `,
      [redactCredentialsAnyCase]],
    ["many URL/env overlaps", "https://user:TOKEN=abcdefgh@SECRETMARK/repo ", `https://${REDACTION} `,
      [redactCredentials, redactCredentialsAnyCase, (s: string) => redactCredentialsWithSecret(s, "unrelated-secret")]],
  ] as const) {
    test(name, () => {
      for (const redact of redactors) {
        expect(redact(unit.repeat(10))).toBe(replacement.repeat(10));
        const counts = SIZES.map((size) => Math.ceil(size / unit.length));
        const inputs = counts.map((count) => unit.repeat(count));
        const best = SIZES.map(() => Infinity);
        for (let round = 0; round < 2; round++) for (const [i, input] of inputs.entries()) {
          const ms = cpuMs(redact, input);
          expect(ms).toBeLessThan(BOUND_MS);
          expect(redact(input)).toBe(replacement.repeat(counts[i]!));
          best[i] = Math.min(best[i]!, ms);
        }
        expect(best[1]!).toBeLessThan(GROWTH_RATIO * best[0]! + GROWTH_SLACK_MS);
      }
    }, SLOW_TEST_MS);
  }
});
