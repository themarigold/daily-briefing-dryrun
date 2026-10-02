// test/credentials.anthropic-keys.test.ts — REAL-SHAPED Anthropic keys are redacted WHOLE (user-directed
// 2026-10-02, Phase E final harden round 3, D3-L1: "Close it").
//
// A real key is `sk-ant-<label>-<body>`: `sk-ant-api03-` + 95 base64url characters ending `AA`, and the
// same shape under other labels (`admin01`, `oat01`, …). Base64url includes `-` and `_`, so the body is
// usually SPLIT into runs. The old provider-key shape needed one unbroken alnum run of >= 20 right after
// at most three short labels, so it either missed a real key entirely or matched only its first run.
// Measured on this file's own seeded corpus before the fix (10,000 `api03` keys): 4,089 not matched at
// all (so ingest PASSED them), 5,267 only partly redacted (a mean of 54 key characters left in clear,
// at most 77), 644 redacted whole.
//
// The fix gives `sk-ant-` its own branch inside provider-key: everything after `sk-ant-` that is
// base64url, once it is at least 40 characters long. The 40 is the slug guard for this prefix — a real
// key carries ~100 characters there, and initials-prefixed branch slugs (the C2 regression class,
// transcripts-transform.test.ts) are far shorter. The generic `sk-`/`pk-`/`rk-`/`ak-` branch is
// unchanged, so its slug guards (pinned below with `_` glue on either side) still hold.
import { test, expect, describe } from "bun:test";
import {
  matchesCredential, matchesCredentialAnyCase, redactCredentials, redactCredentialsAnyCase, ingestScan,
  credentialHits, REDACTION,
} from "../src/transcripts/credentials";

/** mulberry32 — seeded, so every run checks the same keys and a failure names a reproducible one. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const rnd = seeded(20261002);
const body = (n: number) => Array.from({ length: n }, () => B64URL[Math.floor(rnd() * 64)]!).join("");
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;

/** 10,000 `sk-ant-api03-` + 95 base64url + `AA` — the shape of a real API key. */
const API03 = Array.from({ length: 10_000 }, () => `sk-ant-api03-${body(95)}AA`);
/** 2,500 more: other labels, body lengths 80–120, half ending `AA` and half not. */
const LABELS = ["admin01", "oat01", "ort01", "sid01", "api01", "api02", "api03"] as const;
const VARIANTS = Array.from({ length: 2_500 }, (_, i) => {
  const n = 80 + Math.floor(rnd() * 41);
  return `sk-ant-${pick(LABELS)}-${i % 2 ? body(n) + "AA" : body(n + 2)}`;
});
const KEYS = [...API03, ...VARIANTS];

/** The longest run of the key's characters still present in `out`, if it is 8 or more; else 0. */
function leftover(key: string, out: string): number {
  // Fast path (the passing case, 12,500 keys x 13 contexts x 2 paths): one set of `out`'s 8-grams.
  const grams = new Set<string>();
  for (let i = 0; i + 8 <= out.length; i++) grams.add(out.slice(i, i + 8));
  let any = false;
  for (let i = 0; i + 8 <= key.length && !any; i++) any = grams.has(key.slice(i, i + 8));
  if (!any) return 0;
  let worst = 0;
  for (let n = 8; n <= key.length; n++) {
    let found = false;
    for (let i = 0; i + n <= key.length && !found; i++) found = out.includes(key.slice(i, i + n));
    if (!found) break;
    worst = n;
  }
  return worst;
}

/** [name, wrap] — a key in the places a key really turns up. `absorbs` marks a context whose glue AFTER
 *  the key is itself base64url: the match runs on through it, exactly as jwt's does (see credentials.ts). */
const CONTEXTS: { name: string; wrap: (k: string) => string; absorbs?: string; want?: string }[] = [
  { name: "bare", wrap: (k) => k },
  { name: "commit subject", wrap: (k) => `chore: rotate ${k} after it leaked` },
  { name: "KEY=…", wrap: (k) => `KEY=${k}` },
  // env-assignment then takes the whole `NAME=[redacted]`, as it always did for a credential-named variable.
  { name: "export ANTHROPIC_API_KEY=…", wrap: (k) => `export ANTHROPIC_API_KEY=${k}`, want: `export ${REDACTION}` },
  { name: "double-quoted", wrap: (k) => `"${k}"` },
  { name: "single-quoted", wrap: (k) => `'${k}'` },
  { name: "JSON value", wrap: (k) => `{"apiKey":"${k}"}` },
  { name: "branch-like", wrap: (k) => `feat/${k}` },
  { name: "`_` glued before", wrap: (k) => `MY_KEY_${k} now` },
  { name: "end of a sentence", wrap: (k) => `the key was ${k}.` },
  { name: "in parentheses", wrap: (k) => `(${k})` },
  { name: "on its own line", wrap: (k) => `line one\n${k}\nline three` },
  { name: "`_` glued after", wrap: (k) => `${k}_old y`, absorbs: "_old" },
];

const fail = (bad: string[]) => expect(`${bad.length} failing: ${bad.slice(0, 3).join(" | ")}`).toBe("0 failing: ");

describe("real-shaped sk-ant- keys: every one redacted whole, on every path", () => {
  test("PREMISE: the corpus carries the shape that broke the old pattern", () => {
    // The old tail was one unbroken alnum run of >= 20 right after the label. A body whose FIRST run is
    // shorter than that defeated it outright; without many of those this file would prove nothing.
    const shortFirstRun = API03.filter((k) => /^[A-Za-z0-9]{0,19}[-_]/.test(k.slice("sk-ant-api03-".length)));
    expect(shortFirstRun.length).toBeGreaterThan(3_000);
    expect(API03.every((k) => k.length === 13 + 95 + 2 && k.endsWith("AA"))).toBe(true);
    expect(new Set(KEYS).size).toBe(KEYS.length);
    expect(KEYS.filter((k) => /[-_]/.test(k.slice(7))).length).toBeGreaterThan(KEYS.length * 0.9);
  });

  test("matchesCredential, matchesCredentialAnyCase, ingest and credentialHits: all 12,500", () => {
    const bad: string[] = [];
    for (const k of KEYS) {
      if (!matchesCredential(k)) bad.push(`matchesCredential ${k}`);
      if (!matchesCredentialAnyCase(k)) bad.push(`matchesCredentialAnyCase ${k}`);
      if (ingestScan(k).ok) bad.push(`ingestScan ${k}`);
      if (!credentialHits(k).includes("provider-key")) bad.push(`credentialHits ${k}`);
    }
    fail(bad);
  });

  for (const c of CONTEXTS) {
    test(`redactCredentials and redactCredentialsAnyCase leave nothing of the key — ${c.name}`, () => {
      const bad: string[] = [];
      for (const k of KEYS) {
        const text = c.wrap(k);
        // Exactly the context with the key (and any absorbed glue) replaced — not merely "something redacted".
        const want = c.want ?? (c.absorbs ? text.replace(k + c.absorbs, REDACTION) : text.replace(k, REDACTION));
        for (const [path, out] of [["redactCredentials", redactCredentials(text)], ["redactCredentialsAnyCase", redactCredentialsAnyCase(text)]] as const) {
          if (out !== want) bad.push(`${path}: ${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
          const left = leftover(k, out);
          if (left) bad.push(`${path}: ${left} key chars left in ${JSON.stringify(out)}`);
        }
        if (ingestScan(text).ok) bad.push(`ingestScan passed ${JSON.stringify(text)}`);
      }
      fail(bad);
    });
  }

  test("a re-cased key (a normaliser lower-cases labels) is redacted whole by the any-case path", () => {
    const bad: string[] = [];
    for (const k of KEYS.slice(0, 2_000)) {
      for (const t of [k.toLowerCase(), k.toUpperCase(), `x_${k.toLowerCase()}`]) {
        const out = redactCredentialsAnyCase(t);
        if (!matchesCredentialAnyCase(t)) bad.push(`not matched: ${t}`);
        const left = leftover(t, out);
        if (left) bad.push(`${left} chars left: ${out}`);
      }
    }
    fail(bad);
  });

  test("the any-case matcher stays a SUPERSET of the shared one on this corpus and its slugs", () => {
    const corpus = [...KEYS.slice(0, 500), ...KEYS.slice(0, 500).map((k) => k.toUpperCase()), ...SK_ANT_SLUGS, ...GENERIC_SLUGS];
    const bad = corpus.filter((t) => matchesCredential(t) && !matchesCredentialAnyCase(t));
    fail(bad);
  });
});

/** Exactly 39 characters after `sk-ant-` — one under the floor (round-4 harden B4-L2). With the
 *  recorded-cost slug below at exactly 40, the floor is pinned from both sides: before these two the
 *  nearest slug under it was 24 characters and the cost case 41, so any floor from 25 to 41 passed
 *  every credential test (a floor-30 mutant survived all of them, measured by the reviewer). */
const SK_ANT_SLUG_39 = "sk-ant-design-table-pagination-and-sorting-fix";
/** Exactly 40 characters after `sk-ant-` — the floor itself, so it IS redacted (the recorded cost). */
const SK_ANT_SLUG_40 = "sk-ant-design-table-pagination-plus-sorting-fix";
/** Slug-shaped `sk-ant-…` text under the 40-character floor — an initials-prefixed branch about Ant
 *  Design, an ant-colony simulation. Not keys, and ingest must not drop a why that names one. */
const SK_ANT_SLUGS = [
  "sk-ant-design-upgrade", "feat/sk-ant-design-migration-to-v5", "sk-ant-colony-simulation-v2_wip",
  "x_sk-ant-design-table-fixes_v2", "sk-ant-api03-", "an sk-ant- key", "sk-ant-api03-...AA", SK_ANT_SLUG_39,
];
/** The C2 slug guards (transcripts-transform.test.ts), with `_` glue on either side — the generic branch
 *  is unchanged, so these stay out exactly as before. */
const GENERIC_SLUGS = [
  "sk-scikit-learn-experiments-branch", "pk-refactor-the-whole-thing", "ak-47-cleanup-pass-two",
  "rk-remove-legacy-adapters-now", "feat_sk-scikit-learn-experiments-branch_v2", "x_pk-refactor-the-whole-thing_old",
  "_ak-47-cleanup-pass-two_", "my_rk-remove-legacy-adapters-now", "sk-scikit-learn-experiments-branch_v2",
];

describe("over-redaction guards — what must STILL not match", () => {
  test("sk-ant- slugs under the 40-character floor — one at 39 characters included — and the prefix alone", () => {
    expect(SK_ANT_SLUG_39.length - "sk-ant-".length).toBe(39);   // PREMISE: the slug sits right at the floor
    for (const t of SK_ANT_SLUGS) {
      expect(`${t}: ${matchesCredential(t)} ${matchesCredentialAnyCase(t)} ${ingestScan(t).ok}`).toBe(`${t}: false false true`);
      expect(redactCredentials(t)).toBe(t);
    }
  });

  test("the generic sk-/pk-/rk-/ak- slug guards, `_` glued on either side", () => {
    for (const t of GENERIC_SLUGS) {
      expect(`${t}: ${matchesCredential(t)} ${matchesCredentialAnyCase(t)} ${ingestScan(t).ok}`).toBe(`${t}: false false true`);
    }
  });

  test("a key glued to a LETTER or digit is still not a key — the recorded known limit, unchanged", () => {
    for (const k of KEYS.slice(0, 200)) {
      for (const t of [`x${k}`, `task${k}`, `9${k}`]) {
        // Not at the glued position. (A body can, rarely, hold its own `_sk-`… — so compare the
        // redaction to the key's position instead of asserting no match anywhere.)
        expect(redactCredentials(t).startsWith(t.slice(0, t.indexOf("sk-ant-") + 7))).toBe(true);
      }
    }
  });

  test("RECORDED COST, not an endorsement: an sk-ant- slug of 40+ characters after the prefix IS redacted", () => {
    // The floor is a length, so a long enough slug behind this exact prefix crosses it. 5 of the 542
    // merged-PR branch names in this repo are 40+ characters after their `type/` prefix, so this needs
    // a branch that is both that long AND named `sk-ant-…`. Pinned AT the floor (exactly 40), so a
    // floor raised by even one is seen; SK_ANT_SLUG_39 above sees one lowered.
    const t = SK_ANT_SLUG_40;
    expect(t.length - "sk-ant-".length).toBe(40);
    expect(matchesCredential(t)).toBe(true);
    expect(redactCredentials(`k ${t} y`)).toBe(`k ${REDACTION} y`);
  });
});

describe("the short sk-ant- fixtures other files plant keep their verdicts", () => {
  // Round-4 harden B4-L3: this title said "(by the generic branch)" for both, which was true of the
  // second only. The first has 42 characters after `sk-ant-` — over the floor, so the sk-ant- branch takes it;
  // the second has 34 — under it, so only the generic branch (an unbroken run of >= 20) can.
  test("a short unbroken key is still caught — by the sk-ant- branch at 40+ characters after the prefix, by the generic branch under it — and redacted whole", () => {
    for (const [k, after] of [["sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", 42], ["sk-ant-api03-ZZTOPSECRETsentinelVALUE0000", 34]] as const) {
      expect(`${k}: ${k.length - "sk-ant-".length}`).toBe(`${k}: ${after}`);
      expect(redactCredentials(`k ${k} y`)).toBe(`k ${REDACTION} y`);
    }
  });

  test("a sentinel with hyphens in its body is now redacted whole, not cut at its first hyphen", () => {
    const k = "sk-ant-api03-ZZTOPSECRETsentinelVALUE-do-not-log-0000";
    expect(redactCredentials(`k ${k} y`)).toBe(`k ${REDACTION} y`);
  });
});
