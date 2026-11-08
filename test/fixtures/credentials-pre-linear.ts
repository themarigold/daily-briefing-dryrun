// test/fixtures/credentials-pre-linear.ts — ⚠ TEST-ONLY. A FROZEN copy of `src/transcripts/credentials.ts`
// as it stood at cceec6f7c, BEFORE the 2026-10-09 linear-time rewrites of `jwt` and `env-assignment`.
//
// It exists for ONE job: test/credentials.linear-time.test.ts runs it beside the live module and asserts
// the two produce the same output, so the rewrite is proven to be a performance fix and not a coverage
// change. Nothing under src/ may import it. Do NOT "fix" or update these patterns: they are the
// reference. A later DELIBERATE coverage change to the live table will make that differential fail —
// that is the differential doing its job; update this copy (or retire the differential) in the same
// change, and say so.
//
// Pattern sources and function bodies are verbatim from the base commit; only the comments are dropped
// and the exports renamed.

export const PRE_LINEAR_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "provider-key", re: /(?<![A-Za-z0-9])(?:sk-ant-[A-Za-z0-9_-]{40,}|(?:sk|pk|rk|ak)-(?:[A-Za-z0-9]{1,8}-){0,3}[A-Za-z0-9]{20,})(?![A-Za-z0-9])/g },
  { name: "aws-access-key-id", re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g },
  { name: "github-token", re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g },
  { name: "slack-token", re: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9])/g },
  { name: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: "jwt", re: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "env-assignment", re: /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*:?=\s*["']?[^\s"'`]{8,}/g },
  { name: "auth-header", re: /\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
];

const REDACTION = "[redacted]";

export const PRE_LINEAR_PATTERNS_ANY_CASE: readonly RegExp[] = PRE_LINEAR_PATTERNS.map(
  (p) => new RegExp(p.re.source, p.re.flags.includes("i") ? p.re.flags : p.re.flags + "i"),
);

export function preMatchesCredential(text: string): boolean {
  return PRE_LINEAR_PATTERNS.some((p) => new RegExp(p.re.source, p.re.flags.replace("g", "")).test(text));
}

export function preMatchesCredentialAnyCase(text: string): boolean {
  return PRE_LINEAR_PATTERNS_ANY_CASE.some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(text));
}

export function preRedactCredentials(text: string): string {
  if (typeof text !== "string") return text;
  let out = text;
  for (const p of PRE_LINEAR_PATTERNS) out = out.replace(new RegExp(p.re.source, p.re.flags), REDACTION);
  return out;
}

export function preRedactCredentialsAnyCase(text: string): string {
  if (typeof text !== "string") return text;
  let out = preRedactCredentials(text);
  for (const re of PRE_LINEAR_PATTERNS_ANY_CASE) out = out.replace(new RegExp(re.source, re.flags), REDACTION);
  return out;
}

export function preCredentialHits(text: string): string[] {
  return PRE_LINEAR_PATTERNS
    .filter((p) => new RegExp(p.re.source, p.re.flags.replace("g", "")).test(text))
    .map((p) => p.name);
}

export function preIngestScan(text: string): { ok: true } | { ok: false; reason: "credential-hit" } {
  return preMatchesCredential(text) ? { ok: false, reason: "credential-hit" } : { ok: true };
}
