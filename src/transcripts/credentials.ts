// Slice 1.5 T2.3 — the credential module. ONE module, TWO call sites (§3.3 / A10).
//
// ⚠ The shared-matcher guarantee is what keeps invariant 5 true. Both scans use these patterns, so a
// turn that PASSED the ingest scan cannot match output-side, which means redaction can never fire
// inside a why — it fires only on git-derived or diagnostic text. Split the patterns and invariant 5
// ("byte-equal on every path and sink") and the redact-in-place rule are in direct conflict with no
// stated precedence.
//
// ⚠ HONEST SCOPE. The claim is NOT "credentials get detection". It is: KNOWN-SHAPED credentials get
// detection; unknown-shaped ones fall back to the PII posture (opt-in + minimisation + own-account +
// never-persist-raw). These patterns close literal STRINGS, not classes — `mysql -p S3cretPW`
// (spaced), `cookie:session=…` (lowercase), `Set-Cookie:`, `TOKEN: 'sk-…'`, a newline between `=`
// and the value, and `{"apiKey":"sk-…"}` all still pass. `scheme://user:password@host` IS caught
// (userinfo only), EXCEPT a password holding a raw `/ ? # ^ { } | \ [ ]` (the RFC 3986 tradeoff at
// the url-userinfo pattern below) or a whole URL that is escaped or percent-encoded (`https:\/\/…`,
// `https%3A%2F%2F…`): those pass. Say "these literals are caught", never "the class is closed".
//
// Entropy scoring was DELETED, not deferred: zero measured true positives and two HIGH findings.

export type CredentialPattern = { name: string; re: RegExp };

/** Global-flagged for span scans; every stateful use clones the regex first, and
 *  `test` is never called on these directly (see `matchesCredential`) — a global regex's `test` is
 *  stateful and would alternate true/false across calls on the same input. */
export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  // Output redaction unions all original-text spans, including overlaps with env-assignment.
  // URL userinfo with a password (2026-10-24): `https://user:pw@host/x` →
  // `https://[redacted]@host/x`. The first `:` separates username and password; either may be empty.
  // Both exclude whitespace, `/`, `?`, `#` and text delimiters forbidden unencoded in RFC 3986
  // userinfo (double quotes, angle/square brackets, backtick, braces, pipe, backslash, caret); the
  // username also excludes `:`. RFC sub-delims such as apostrophe, parentheses, comma and semicolon
  // stay admitted, trading ambiguous adjacent punctuation for matching valid password spellings.
  // Percent escapes, Unicode and raw `@` remain admitted;
  // the greedy password ends at the LAST `@` in that authority, so `u@ser:p@ss@host` leaves no tail.
  // A username alone, a port, and `:`/`@` in a path/query/fragment cannot match.
  // ⚠ LINEAR TIME: a match STARTS only after `://`, checked by a bounded (at most 34-char)
  // lookbehind. Neither forward class crosses `/`, so scans from successive starts cannot overlap;
  // excluding `:` from the username also leaves only ONE username/password split to try. Keep this
  // anchor — an unanchored userinfo scan retries the same long run at every character (quadratic).
  // Both scheme classes spell out upper AND lower case, so the /i clone stays a superset without
  // changing any delimiter; ordinary lower-case words gain no match.
  // KNOWN FAIL-CLOSED COST, accepted: a container image reference with a tag and a digest has the
  // same shape, so `docker://alpine:3.18@sha256:…` renders as `docker://[redacted]@sha256:…`.
  { name: "url-userinfo", re: /(?<=[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/)[^\s/:?#"<>`{}|\\^\[\]]*:[^\s/?#"<>`{}|\\^\[\]]*(?=@)/g },
  // Provider-issued key shapes with a distinctive prefix.
  // ⚠ The tail must be an UNHYPHENATED run of >=20 alnum chars, with at most a few short
  // hyphenated label segments before it (`pk-live-<long run>`). Real `sk-ant-` keys do NOT fit this
  // shape — they have their own branch, below.
  // A `[A-Za-z0-9_-]{16,}` tail matched initials-prefixed BRANCH NAMES — measured at C2,
  // `pk-refactor-the-whole-thing`, `ak-47-cleanup-pass-two`, `sk-scikit-learn-experiments-branch`
  // and `rk-remove-legacy-adapters-now` all hit. Ingest fails CLOSED, so each of those silently
  // dropped an entire why — deflating the one number 1.5a exists to produce, in the direction that
  // would make 1.5b conclude "not enough whys". The long unhyphenated run is what actually
  // distinguishes a key from a slug.
  // The lookarounds instead of `\b` at either end: see the note on aws-access-key-id below. They apply
  // to the whole alternation, so `_pk-`/`_rk-`/`_ak-` are closed with `_sk-`, and `…_x` after the run
  // with them — the slug guard above (the long unhyphenated run) is unchanged and still keeps
  // `x_sk-scikit-learn-…_v2` out.
  // ⚠ AND AN `sk-ant-` BRANCH FIRST (user-directed 2026-10-02, round-3 harden D3-L1: "Close it"). A REAL
  // Anthropic key is `sk-ant-<label>-` + ~95 BASE64URL characters (`sk-ant-api03-…AA`), and base64url
  // includes `-` and `_` — so the run rule above, right for slugs, is wrong for these keys: on 10,000
  // realistic `api03` keys it missed 41% outright (ingest PASSED them) and cut 53% at a `-`/`_`,
  // leaving a mean of 54 key characters in clear. This branch takes everything after `sk-ant-` that is
  // base64url, once that is >= 40 characters: a real key has ~100 there, and the 40 is this prefix's
  // slug guard (a short `sk-ant-` branch slug stays out; test/credentials.anthropic-keys.test.ts pins both
  // sides, and the recorded cost — a 40+-character `sk-ant-…` slug IS redacted). The trailing lookahead
  // is unchanged and trivially met here, since the run stops only at a character outside base64url; so,
  // as with jwt below, a `_…`/`-…` glued AFTER such a key is absorbed into the match rather than hiding
  // any of it. The generic branch is untouched and still owns `sk-`, `pk-`, `rk-`, `ak-` and a short
  // `sk-ant-` (under the floor), so every slug guard above holds as before.
  { name: "provider-key", re: /(?<![A-Za-z0-9])(?:sk-ant-[A-Za-z0-9_-]{40,}|(?:sk|pk|rk|ak)-(?:[A-Za-z0-9]{1,8}-){0,3}[A-Za-z0-9]{20,})(?![A-Za-z0-9])/g },
  // ⚠ A LOOKBEHIND, NOT A LEADING `\b`, on provider-key, aws-access-key-id, github-token, slack-token
  // and jwt (user-directed 2026-10-02, Phase E final harden — aws and slack first, "Close both"; then
  // github, provider-key and jwt, "yes, close the underscore ones"): `_` is a word character, so
  // `rotate_AKIA…`, `x_xoxb-…`, `_ghp_…`, `MY_KEY_sk-…` and `x_eyJ….….…` had no boundary before the
  // token and escaped every redaction. `(?<![A-Za-z0-9])` is `\b` minus the underscore.
  // ⚠ AND ITS TWIN, A LOOKAHEAD, NOT A TRAILING `\b`, on provider-key, aws-access-key-id, github-token
  // and slack-token (round-2 harden, the same underscore decision): `AKIA…_old`, `ghp_…_v2` and
  // `sk-ant-…_x` had no boundary AFTER the token and passed whole, and `xoxb-…-abcdefghijkl_old` matched
  // only up to its last hyphen, so the tail leaked. `(?![A-Za-z0-9])` is `\b` minus the underscore, on
  // the other side. jwt keeps its trailing `\b`: its segment class already contains `_`, so a trailing
  // `_…` is absorbed into the match rather than hiding it.
  // So a `_` glued on EITHER side no longer hides a token, while a letter or digit there still blocks
  // the match exactly as before — `XAKIA…` / `AKIA…X` (a longer run, not a key id) stay out, and the
  // case-insensitive clones below, which add only the `i` flag, stay a SUPERSET of these patterns and
  // never fire inside a lower-case word (`…asiapacific…`). An `(?<![A-Z0-9])` would also have closed
  // `rotateAKIA…`, but under `i` it excludes every letter, so the clone would MISS what this pattern
  // catches — measured, and refused.
  // NOT closed, stated — recorded known limits by the user's decision: a key glued to a LETTER
  // (`rotateAKIA…`, `tasksk-…`; closing it would over-redact words such as `task-`/`disk-` and breaks
  // the any-case clones), and a Kelvin-sign K lookalike (U+212A; theoretical).
  { name: "aws-access-key-id", re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g },
  { name: "github-token", re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g },
  { name: "slack-token", re: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9])/g },
  { name: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  // ⚠ LINEAR-TIME REWRITES of jwt and env-assignment (2026-10-09) — same matches, same spans; the
  // differential in test/credentials.linear-time.test.ts runs a frozen copy of the old table beside these.
  // Both old shapes were QUADRATIC in one long token: 100k chars of `_eyJ` took ~9.5 s, 100k of
  // `SECRET` ~1.8 s, and the case-insensitive clones the same again.
  // jwt: every `eyJ` after a `_`/`-` is a fresh start, and each start scanned its first segment to the
  // end of the shared base64url run. The added `(?<!…)` refuses a start that has an earlier valid start
  // in the SAME run — that earlier one ends its first segment at the same place, and a longer segment
  // only helps, so it matches whenever the later one would and the later one is never what `test` or
  // `replace` reports. (A run cannot straddle a previous match's end, because a match ends at a `\b`
  // with only `-` after it in the run.) The `*?` finds the NEAREST earlier start, which is what keeps
  // the refusal itself linear; `(?=eyJ)` keeps that lookbehind off every other position.
  { name: "jwt", re: /(?<![A-Za-z0-9])(?=eyJ)(?<!(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]*?)eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // `KEY=value` shapes: an env-var-looking name containing a credential word, assigned a non-trivial
  // value on the SAME line. The name test is what keeps `PATH=/usr/bin` out. `:=` (Make, Go) is the
  // same assignment and is matched too (user-directed 2026-10-02: `API_TOKEN:=…` used to escape).
  // The name was `[A-Z0-9_]*(?:WORD)[A-Z0-9_]*`: two stars around the word, so a long name with no `=`
  // after it retried every split at every word occurrence. Neither `\s`, `:` nor `=` is a name
  // character, so the name can only ever end at the END of its run — the lookahead asks "does that run
  // contain a credential word" once, and one star consumes the run. `\b` is load-bearing: every name
  // character is a word character, so it admits only the run START as a candidate.
  { name: "env-assignment", re: /\b(?=[A-Z0-9_]*?(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY))[A-Z0-9_]*\s*:?=\s*["']?[^\s"'`]{8,}/g },
  // Auth headers.
  { name: "auth-header", re: /\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
];

/** True when text contains a known-shaped credential. Uses a fresh non-global clone so the shared
 *  global patterns' `lastIndex` can never leak between calls — the classic stateful-regex bug, and
 *  a nasty one here because a false negative silently ships a secret. */
export function matchesCredential(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((p) => new RegExp(p.re.source, p.re.flags.replace("g", "")).test(text));
}

/** Case-INSENSITIVE clones of `CREDENTIAL_PATTERNS`, for text that was case-folded (or may have been)
 *  before it reaches an output. Most classes lack the `i` flag, and for four of them
 *  (aws-access-key-id, jwt, private-key-block, env-assignment) lower-casing breaks the match, so a
 *  lower-cased `akia…` key id or `eyj…` JWT — trivially reversible, so still a leak — no longer
 *  matches the shared set. The shared matcher's semantics are untouched:
 *  `matchesCredential`/`redactCredentials`/`ingestScan` never read these. Consumers, through
 *  `matchesCredentialAnyCase` / `redactCredentialsAnyCase`: `json.ts`'s envelope KEY redaction (`norm`
 *  lowercases `whys` keys), `generator.ts`'s `campaignKey` (tier 3 lowercases the subject it builds a
 *  header label from), and `recapCampaigns.ts`'s record labels and PR branch words. Global-flagged
 *  like the originals; clone before stateful use. */
export const CREDENTIAL_PATTERNS_ANY_CASE: readonly RegExp[] = CREDENTIAL_PATTERNS.map(
  (p) => new RegExp(p.re.source, p.re.flags.includes("i") ? p.re.flags : p.re.flags + "i"),
);

/** True when text contains a known-shaped credential in ANY letter case (see
 *  `CREDENTIAL_PATTERNS_ANY_CASE`). Fresh non-global clones, as in `matchesCredential`. */
export function matchesCredentialAnyCase(text: string): boolean {
  return CREDENTIAL_PATTERNS_ANY_CASE.some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(text));
}

/** Union original-text spans from both the shared patterns and case-insensitive clones: for text a
 *  normaliser may have case-folded (`norm` lowercases labels). Text with no match in either case is
 *  returned byte-identical; a clone's additional matches are redacted too, which fails closed. Consumers:
 *  `json.ts`'s envelope KEYS (every key; the `whys` keys are `norm(label)`) and `recapCampaigns.ts`'s
 *  record LABELS (`norm(repo)`). Cost, stated: a lower-case word shaped like a key id — `asia` plus 16
 *  alnum, e.g. a branch `feat/asiapacificexpansion` (or, since the trailing lookahead, `…_v2`) — is
 *  redacted too; 0 of 527 real PR branches, and 0 of 542 re-measured (round-2 harden, 2026-10-02:
 *  this repo's merged-PR branch names, raw and space-split, before and after the lookahead). */
export function redactCredentialsAnyCase(text: string): string {
  return redactCredentialSpans(text, [...CREDENTIAL_PATTERNS.map(({ re }) => re), ...CREDENTIAL_PATTERNS_ANY_CASE]);
}

/** Which patterns matched — for telemetry and for tests, never for a message shown to a user
 *  (naming the pattern would advertise what was found). */
/** ⚠ TEST-ONLY today. Written for telemetry, but no counter consumes it — a hit is recorded as
 *  the `credential-hit` DropReason, which carries no pattern name (naming the pattern in a stored
 *  record would advertise what was found). Kept because the per-pattern tests assert against it. */
export function credentialHits(text: string): string[] {
  return CREDENTIAL_PATTERNS
    .filter((p) => new RegExp(p.re.source, p.re.flags.replace("g", "")).test(text))
    .map((p) => p.name);
}

export const REDACTION = "[redacted]";

/** OUTPUT-SIDE: redact in place, NEVER abort the write. Aborting would break the git briefing, which
 *  invariant 8 forbids.
 *  ⚠ A NON-STRING COMES BACK UNCHANGED rather than throwing — the rule `redactJson` (json.ts) applies to
 *  a non-string leaf. The type says string, but a hand-edited config value is whatever the file holds:
 *  `status --json` once handed this a `morningTime` of 720 and `.replace` threw (round-2 harden D-M1).
 *  A caller that needs a string spells the value itself first (json.ts reports `JSON.stringify`). */
export function redactCredentials(text: string): string {
  return redactCredentialSpans(text, CREDENTIAL_PATTERNS.map(({ re }) => re));
}

/** Redact known shapes AND the optional resolved secret in the same original-text span union. */
export function redactCredentialsWithSecret(text: string, secret?: string): string {
  return redactCredentialSpans(text, CREDENTIAL_PATTERNS.map(({ re }) => re), secret);
}

/** Scan every pattern and the optional literal against the ORIGINAL text. Either sequential order
 *  can destroy an overlapping match and leave part of a credential behind. Merge overlapping and
 *  adjacent spans before replacing anything. Each regex supplies an ordered stream of matches;
 *  merging a fixed number of streams avoids an O(n log n) sort and keeps the scan linear. Literal
 *  searches advance past each occurrence, as split(secret) did, without treating the key as a regex.
 *  ⚠ EVERY STREAM MUST ADVANCE, or the loop never ends: each clone is forced global (a non-`g` `exec`
 *  restarts at 0 forever) and an EMPTY match is skipped by stepping `lastIndex` past it (a global
 *  regex does not move on its own after an empty match). No table entry is either today — pinned in
 *  test/credentials.span-termination.test.ts — so this changes nothing for them; it makes a future
 *  entry unable to hang every redactor. */
function redactCredentialSpans(text: string, patterns: readonly RegExp[], secret = ""): string {
  if (typeof text !== "string") return text;
  const scans = patterns.map((re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  const next = (re: RegExp): RegExpExecArray | null => {
    let m = re.exec(text);
    while (m && m[0] === "") { re.lastIndex++; m = re.exec(text); }
    return m;
  };
  const matches = scans.map(next);
  let literal = secret ? text.indexOf(secret) : -1;
  let start = -1, end = -1, copied = 0;
  const parts: string[] = [];
  for (;;) {
    let nextStart = literal < 0 ? Infinity : literal;
    let nextEnd = nextStart + secret.length;
    let pattern = -1;
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      if (match && match.index < nextStart) {
        nextStart = match.index;
        nextEnd = match.index + match[0].length;
        pattern = i;
      }
    }
    if (nextStart === Infinity) break;
    if (pattern < 0) literal = text.indexOf(secret, nextEnd);
    else matches[pattern] = next(scans[pattern]!);

    if (nextStart > end) {
      if (start >= 0) {
        parts.push(text.slice(copied, start), REDACTION);
        copied = end;
      }
      start = nextStart;
      end = nextEnd;
    } else end = Math.max(end, nextEnd);
  }
  if (start < 0) return text;
  parts.push(text.slice(copied, start), REDACTION, text.slice(end));
  return parts.join("");
}

/** Test seam only: the span union with an injected pattern list. Production callers use the three
 *  `redactCredentials*` wrappers above. */
export { redactCredentialSpans as redactCredentialSpansForTests };

/** An incomplete stream can stop before a credential's delimiter or minimum length arrives. Only
 *  whitespace proves the preceding token ended: withhold its unfinished tail BEFORE redaction.
 *  No whitespace means no complete token; trailing whitespace means the whole prefix can stay. */
export function dropTrailingPartialToken(text: string): string {
  let end = text.length;
  while (end > 0 && !/\s/.test(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** INGEST-SIDE: FAIL CLOSED — a credential hit drops the why ENTIRELY and the bullet renders bare.
 *
 *  ⚠ Under quotation (§3.5) this is not optional. The emitted text IS the user's turn, so a redacted
 *  span would ship as `you wrote: "export KEY=[redacted]"` — an artefact that advertises a secret's
 *  existence and location while adding nothing. Dropping is both safer and more useful.
 *  Returns the reason code rather than a boolean so the caller records the right DropReason. */
export function ingestScan(text: string): { ok: true } | { ok: false; reason: "credential-hit" } {
  return matchesCredential(text) ? { ok: false, reason: "credential-hit" } : { ok: true };
}

/** Clip RAW provider input without leaving a credential prefix that output redaction cannot match.
 *  Inspect spans in the uncut text; a cut inside any match backs up to its start. Complete credentials
 *  remain raw by design. URL spans include their required @ lookahead delimiter. Descending starts also cover chains of overlapping classes regardless of
 *  table order. Only spans starting before the cap matter (at most maxChars per pattern). */
export function clipBeforeCredential(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const spans: { start: number; end: number }[] = [];
  for (const { name, re } of CREDENTIAL_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      if (m.index >= maxChars) break;
      spans.push({ start: m.index, end: m.index + m[0].length + (name === "url-userinfo" ? 1 : 0) });
    }
  }
  let cut = maxChars;
  for (const { start, end } of spans.sort((a, b) => b.start - a.start)) {
    if (start < cut && cut < end) cut = start;
  }
  return text.slice(0, cut);
}
