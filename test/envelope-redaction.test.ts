import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// test/envelope-redaction.test.ts — Phase E, E1 (#496 follow-up): the run envelope is redacted.
//
// Before E1 the briefing (`markdown`) was redacted and the envelope beside it was not: `struct`,
// `warnings` and `discIssues` went out raw on `run --json`'s stdout and into the `--json-out` file, and
// `last-skip.json`'s free-text `detail` was written raw. E1 maps `redactCredentials` over every string
// leaf at the output boundary (`redactEnvelope`, called once by `emit` before it splits) and over
// `detail` at the file boundary (`writeLastSkip`).
//
// The existing render fixtures carry no credential-shaped strings, so EVERY test here plants its own
// and proves the plant is there before asserting it is gone.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepo, commitFiles } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { RENDER_CORPUS } from "./fixtures/render-corpus";
import { MORNING_STRUCT } from "./fixtures/campaign-morning";
import { run } from "../src/main";
import { envelopeFrom, gateEnvelope, redactEnvelope, redactStruct, type RunEnvelope } from "../src/json";
import type { CoreResult } from "../src/core";
import { renderBriefing } from "../src/render";
import { lastBriefing } from "../src/audit";
import { norm } from "../src/subprojects";
import {
  CREDENTIAL_PATTERNS, REDACTION, credentialHits, matchesCredential, redactCredentials,
} from "../src/transcripts/credentials";
import {
  posturePhrase, mergeWarnings, isPostureWarning,
  TRUNCATION_SENTINEL, API_TRUNCATION_SENTINEL, API_TRANSPORT_SENTINEL, API_CLEARTEXT_SENTINEL,
} from "../src/eval/posture";
import { ProviderError, type BriefingStruct, type Provider } from "../src/types";

// ── the plants: one token per CREDENTIAL_PATTERNS class ──────────────────────────────────────────

/** Keyed by pattern NAME, and checked against `CREDENTIAL_PATTERNS` below, so a class added to the
 *  matcher without a token here fails the premise test rather than silently shrinking the corpus. */
const TOKENS: Record<string, string> = {
  "provider-key": "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  "aws-access-key-id": "AKIAIOSFODNN7EXAMPLE",
  "github-token": "ghp_AbCdEfGhIjKlMnOpQrStUv123456",
  "slack-token": "xoxb-123456789012-abcdefghijkl",
  "private-key-block": "-----BEGIN RSA PRIVATE KEY-----",
  "jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "env-assignment": "API_TOKEN=s3cr3tvalue1234",
  "auth-header": "Authorization: Bearer abcdef1234567890",
};
const CLASSES = CREDENTIAL_PATTERNS.map((p) => p.name);
const GH = TOKENS["github-token"]!;

/** The SECRET part of each token — what must never reach an output in ANY case. Not the whole token
 *  where that would false-positive: `API_TOKEN` (a variable NAME) is not secret, the value is. Matched
 *  case-insensitively, because `norm` lowercases `whys` keys and the four case-sensitive classes stop
 *  matching once lowercased — a lowercased AWS key id is trivially reversible, so it is still a leak. */
const SECRETS: Record<string, string> = {
  "provider-key": "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  "aws-access-key-id": "AKIAIOSFODNN7EXAMPLE",
  "github-token": "AbCdEfGhIjKlMnOpQrStUv123456",
  "slack-token": "123456789012-abcdefghijkl",
  "private-key-block": "BEGIN RSA PRIVATE KEY",
  "jwt": "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "env-assignment": "s3cr3tvalue1234",
  "auth-header": "abcdef1234567890",
};
const leaksSecret = (text: string, cls: string) => text.toLowerCase().includes(SECRETS[cls]!.toLowerCase());

test("premise: every CREDENTIAL_PATTERNS class has a token here, and each token matches ITS OWN class", () => {
  expect(Object.keys(TOKENS).sort()).toEqual([...CLASSES].sort());
  for (const name of CLASSES) {
    expect(`${name}: ${credentialHits(TOKENS[name]!).includes(name)}`).toBe(`${name}: true`);
    expect(redactCredentials(TOKENS[name]!)).toBe(REDACTION);
    // …and its SECRET part is really inside it, and is not something the redaction marker contains.
    expect(`${name}: ${leaksSecret(TOKENS[name]!, name)}`).toBe(`${name}: true`);
    expect(`${name}: ${leaksSecret(REDACTION, name)}`).toBe(`${name}: false`);
  }
  expect(Object.keys(SECRETS).sort()).toEqual([...CLASSES].sort());
});

// ── redactStruct: the map itself ─────────────────────────────────────────────────────────────────

describe("redactStruct", () => {
  test("redacts every string leaf and every object key, passes non-strings through, and never mutates", () => {
    const input = {
      a: `x ${GH} y`, n: 3, b: true, u: undefined, z: null,
      list: [`${GH}`, 7, { deep: [`p ${GH}`] }],
      whys: { [`k ${GH}`]: `v ${GH}` },
    };
    const before = JSON.stringify(input);
    const out = redactStruct(input);
    expect(JSON.stringify(input)).toBe(before);              // the input is untouched
    expect(out).not.toBe(input);                             // …and a NEW value comes back
    expect(JSON.stringify(out)).not.toContain(GH);
    expect(out.a).toBe(`x ${REDACTION} y`);
    expect([out.n, out.b, out.u, out.z]).toEqual([3, true, undefined, null]);
    expect(out.list).toEqual([REDACTION, 7, { deep: [`p ${REDACTION}`] }]);
    expect(out.whys).toEqual({ [`k ${REDACTION}`]: `v ${REDACTION}` });
  });

  test("a value with nothing to redact comes back deep-equal", () => {
    for (const { struct } of RENDER_CORPUS) expect(redactStruct(struct)).toEqual(struct);
  });

  // D1 (fixed): `whys` is keyed by `norm(label)`, which LOWERCASES, and four classes are case-sensitive.
  // Measured before the fix: `api_token=9f3a1c0b7e2d4a5f` and `akia…` survived in a key verbatim.
  test("a whys KEY is redacted case-insensitively, to exactly norm(redactCredentials(label))", () => {
    for (const cls of CLASSES) {
      const label = `Proj ${TOKENS[cls]!}`;
      const key = norm(label);
      const out = redactStruct({ whys: { [key]: "why" } });
      expect(`${cls}: ${Object.keys(out.whys)[0]}`).toBe(`${cls}: ${norm(redactCredentials(label))}`);
      expect(`${cls}: ${leaksSecret(JSON.stringify(out), cls)}`).toBe(`${cls}: false`);
    }
    // The dispatcher's measured case, verbatim.
    expect(JSON.stringify(redactStruct({ whys: { "proj api_token=9f3a1c0b7e2d4a5f": "why" } }))).not.toContain("9f3a1c0b7e2d4a5f");
  });

  test("a key with nothing to redact is returned byte-identical", () => {
    const keys = ["Mixed Case-Key_1", "daily_briefing_application", "sk-short", "path/to/akia", "__x__"];
    const out = redactStruct(Object.fromEntries(keys.map((k) => [k, 1])));
    expect(Object.keys(out)).toEqual(keys);
  });

  // D2 (Phase E final harden): a key spelled `__proto__` — reachable, `whys` is keyed by a git-derived
  // folder name — went through `out[key] = …`, hit the inherited setter and was DROPPED (a string) or
  // became the object's prototype (an object). It must survive like any other key.
  test("a `__proto__` key is kept as an ordinary key, in the value AND in its serialisation", () => {
    const parsed = JSON.parse(`{"whys":{"__proto__":"why","normal":"ok"},"nested":{"__proto__":{"polluted":"${GH}"}}}`);
    expect(Object.keys(parsed.whys)).toEqual(["__proto__", "normal"]);      // PREMISE: JSON.parse makes it an own key
    const out = redactStruct(parsed) as { whys: Record<string, unknown>; nested: Record<string, unknown> };
    expect(Object.keys(out.whys)).toEqual(["__proto__", "normal"]);
    expect(Object.getOwnPropertyDescriptor(out.whys, "__proto__")?.value).toBe("why");
    expect(Object.getPrototypeOf(out.nested)).toBe(Object.prototype);       // not re-parented onto the value
    expect(JSON.stringify(out)).toBe(`{"whys":{"__proto__":"why","normal":"ok"},"nested":{"__proto__":{"polluted":"${REDACTION}"}}}`);
    // …and the envelope boundary is the same function.
    const env = redactEnvelope(envelopeFrom(coreResult({ struct: { ...STRUCT, whys: parsed.whys } as BriefingStruct }), "", 0));
    expect(JSON.stringify(env.struct)).toContain(`"whys":{"__proto__":"why","normal":"ok"}`);
  });

  // Fix 2: the map used to pass anything non-plain through UNREDACTED, and a plain object's own `toJSON`
  // survived the rebuild and ran AFTER redaction. What is redacted must be what is serialised.
  test("fails closed on non-plain values: class instance, boxed String, own toJSON", () => {
    class Holder { constructor(public text: string) {} }
    class WithProto { get hidden() { return GH; } own = `own ${GH}`; }
    const input = {
      instance: new Holder(`x ${GH}`),
      proto: new WithProto(),
      boxed: new String(GH),
      viaToJSON: { toJSON() { return `t ${GH}`; } },
      nested: [new Holder(GH), { toJSON: () => ({ [`k ${GH}`]: GH }) }],
    };
    // PREMISE: every one of these serialises the token when NOT redacted.
    const raw = JSON.stringify(input);
    expect(raw.split(GH).length - 1).toBe(7);
    const text = JSON.stringify(redactStruct(input));
    expect(text).not.toContain(GH);
    expect(matchesCredential(text)).toBe(false);
    expect(text.split(REDACTION).length - 1).toBe(7);
    // …and the envelope boundary is the same function.
    const env = redactEnvelope(envelopeFrom(coreResult({ warnings: [new String(GH) as unknown as string] }), "", 0));
    expect(JSON.stringify(env)).not.toContain(GH);
  });
});

// ── per channel, at the boundary function `emit` calls ────────────────────────────────────────────

const STRUCT: BriefingStruct = { date: "2026-09-14", machineScope: "host", provider: "claude", resume: [], recap: [], suggestions: [] };

function coreResult(over: Partial<CoreResult> = {}): CoreResult {
  return {
    emptyWindow: false, blocked: false, offlineSkipped: false, net: { online: true, waitedMs: 0 },
    struct: STRUCT, rawText: "", promptText: "p", ctx: { repos: [] }, units: [], activities: [], repos: [],
    runDate: "2026-09-14", discIssues: [], extrIssues: [], warnings: [], today: [],
    windowStartUtc: "2026-09-10T00:00:00.000Z",
    ...over,
  };
}

describe("redactEnvelope — each channel, planted at its own source", () => {
  const channels: { name: string; env: () => RunEnvelope; read: (e: RunEnvelope) => string }[] = [
    {
      name: "struct (a commit subject)",
      env: () => envelopeFrom(coreResult({ struct: { ...STRUCT, today: [{ repo: "r", text: `chore: drop ${GH} from CI (abc1234)` }] } }), "", 0),
      read: (e) => JSON.stringify(e.struct),
    },
    {
      name: "warnings",
      env: () => envelopeFrom(coreResult({ warnings: [`provider hardening: the CLI rejected an injected flag: ${GH}`] }), "", 0),
      read: (e) => JSON.stringify(e.warnings),
    },
    {
      name: "discIssues[].message (and its path)",
      env: () => envelopeFrom(coreResult({ discIssues: [{ path: `/tmp/missing-${GH}`, kind: "not-found" }] }), "", 0),
      read: (e) => JSON.stringify(e.discIssues),
    },
    {
      // ⚠ NO `run()` RETURN PASSES `warnings` TO `gateEnvelope` TODAY (every `skip()` call omits it), so
      // this channel is reachable only here. It is covered anyway because `emit` redacts every envelope.
      name: "gateEnvelope warnings",
      env: () => gateEnvelope({ exitCode: 0, runDate: "2026-09-14", skipReason: "below-floor", warnings: [`gate note ${GH}`] }),
      read: (e) => JSON.stringify(e.warnings),
    },
  ];
  for (const ch of channels) {
    test(ch.name, () => {
      const raw = ch.env();
      expect(ch.read(raw)).toContain(GH);                       // PREMISE: the plant is in the raw envelope
      const safe = redactEnvelope(raw);
      expect(ch.read(safe)).not.toContain(GH);
      expect(ch.read(safe)).toContain(REDACTION);               // …because it was redacted, not dropped
      expect(matchesCredential(JSON.stringify(safe))).toBe(false);
      expect(ch.read(raw)).toContain(GH);                       // the raw envelope (the run's value) is not mutated
    });
  }

  test("markdown and paths are left exactly as they were", () => {
    const md = `☀️  Daily briefing — x\n${REDACTION}`;
    const raw = envelopeFrom(coreResult(), md, 0);
    const safe = redactEnvelope(raw);
    expect(safe.markdown).toBe(md);
    expect(safe.paths).toEqual(raw.paths);
  });
});

// ── per channel, END TO END: stdout AND the --json-out file of a real run() ───────────────────────

const PROV = { cli: "claude", argv: ["-p"], promptVia: "stdin" as const };
const MODEL_OUT = "## RESUME\n- [r] resume here\n## RECAP\n- [r] did x | evidence: abc123\n## SUGGESTIONS\n- do y";
const AFTER_FLOOR = () => new Date(2026, 6, 16, 9, 0);
const yesterdayISO = () => new Date(Date.now() - 864e5).toISOString();
const NET = { now: AFTER_FLOOR, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 };

function withEnv(cfgObj: unknown): { stateDir: string; cleanup: () => void } {
  const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-e1-cfg-")));
  const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-e1-state-")));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify(cfgObj));
  const prevXdg = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  return {
    stateDir,
    cleanup: () => {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
    },
  };
}

function captureConsole() {
  const out: string[] = [], err: string[] = [];
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  return { out, err, restore: () => { console.log = oLog; console.error = oErr; } };
}

/** One run with BOTH flags: stdout is the envelope (`--json`) and the file is the envelope
 *  (`--json-out`), so each channel is checked on both outputs from one run. */
async function bothChannels(cfg: Record<string, unknown>, provider: Provider, expectThrow = false) {
  const env = withEnv({ provider: PROV, networkProbeHosts: [], excludeCommitPatterns: [], ...cfg });
  const outPath = join(env.stateDir, "sidecar.json");
  const cap = captureConsole();
  try {
    const p = run(true, { ...NET, retryDelaysMs: [], sleep: async () => {}, provider }, { json: true, jsonOut: outPath });
    if (expectThrow) await p.catch(() => {}); else await p;
  } finally { cap.restore(); env.cleanup(); }
  const stdout = cap.out.join("\n");
  const file = readFileSync(outPath, "utf8");
  const lastSkip = (() => { try { return readFileSync(join(env.stateDir, "last-skip.json"), "utf8"); } catch { return ""; } })();
  return { stdout, file, stdoutEnv: JSON.parse(cap.out.at(-1)!) as RunEnvelope, fileEnv: JSON.parse(file) as RunEnvelope, lastSkip };
}

function expectBothClean(r: { stdout: string; file: string }) {
  for (const [name, text] of [["stdout", r.stdout], ["--json-out", r.file]] as const) {
    expect(`${name}: ${text.includes(GH)}`).toBe(`${name}: false`);
    expect(`${name}: ${matchesCredential(text)}`).toBe(`${name}: false`);
  }
}

describe("run --json + --json-out: each channel is redacted on stdout AND in the file", () => {
  test("struct — a credential in a COMMIT SUBJECT", async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    const subject = `chore: drop ${GH} from the deploy script`;
    await commitFiles(repo, ["b.txt"], { message: subject, isoDate: new Date(Date.now() - 60_000).toISOString() });
    // PREMISE: the plant is in git, where the pipeline reads it.
    const log = Bun.spawnSync(["git", "-C", repo, "log", "-1", "--format=%s"]).stdout.toString();
    expect(log).toContain(GH);
    const r = await bothChannels({ repos: [repo] }, { async generate() { return MODEL_OUT; } });
    expectBothClean(r);
    // …and the subject really reached the struct: its surrounding words are there, with the token
    // replaced. Without this the test passes whenever the subject simply never made it into the struct.
    const want = `chore: drop ${REDACTION} from the deploy script`;
    expect(JSON.stringify(r.stdoutEnv.struct)).toContain(want);
    expect(JSON.stringify(r.fileEnv.struct)).toContain(want);
    // The markdown was already redacted before E1 and is unchanged by it.
    expect(r.stdoutEnv.markdown).toContain(want);
  });

  test("warnings — a pipeline warning (envelope `warnings`) and a provider runtime warning (struct's copy)", async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    // Envelope `warnings` is CoreResult.warnings — the pipeline list. The floor warning quotes the
    // configured value back (schedule.ts parseFloor), so a credential pasted into the config reaches it.
    const morningTime = `at ${GH}`;
    // A provider's runtime warnings go to `struct.warnings` only (core.ts folds them in after generate).
    const rw = `provider hardening: the CLI rejected an injected flag; its stderr said ${GH}`;
    const provider = { async generate() { return MODEL_OUT; }, runtimeWarnings: [rw] } as Provider;
    const r = await bothChannels({ repos: [repo], morningTime }, provider);
    expectBothClean(r);
    for (const e of [r.stdoutEnv, r.fileEnv]) {
      // PREMISE + assertion in one: the warning is there, carrying the surrounding text, token replaced.
      const floor = e.warnings.find((w) => w.startsWith("invalid morningTime"));
      expect(floor).toBeDefined();
      expect(floor!).toContain(`at ${REDACTION}`);
      expect(e.struct!.warnings ?? []).toContain(redactCredentials(rw));
      expect(redactCredentials(rw)).not.toBe(rw);
    }
  });

  test("discIssues — a repo path carrying a credential-shaped segment", async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    const missing = join(removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-e1-miss-"))), `missing-${GH}`);
    // Discovery issues come only from `discoverRoots` (an explicit `repos` list short-circuits the walk,
    // config.ts discoverRepos). The repo is a root itself, so it is still found and the run delivers.
    const r = await bothChannels({ discoverRoots: [repo, missing] }, { async generate() { return MODEL_OUT; } });
    expectBothClean(r);
    for (const e of [r.stdoutEnv, r.fileEnv]) {
      const issue = e.discIssues.find((i) => i.kind === "not-found");
      expect(issue).toBeDefined();                              // PREMISE: the issue was raised
      expect(issue!.message).toContain(`missing-${REDACTION}`); // the message carried the path, redacted
      expect(issue!.path).toContain(`missing-${REDACTION}`);
    }
  });

  test("skip detail — a provider error echoing a key, in last-skip.json (and nowhere in either envelope)", async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    const msg = `claude exited 1: Invalid API key: ${GH} (request failed)`;
    const r = await bothChannels({ repos: [repo] }, { async generate() { throw new ProviderError("nonzero-exit", msg); } });
    expectBothClean(r);
    expect(r.stdoutEnv.skipReason).toBe("provider-fail");
    const skip = JSON.parse(r.lastSkip) as { reason: string; detail?: string };
    expect(skip.reason).toBe("provider-fail");                  // PREMISE: the record was written
    expect(skip.detail).toBe(`nonzero-exit: ${redactCredentials(msg)}`);
    expect(r.lastSkip).not.toContain(GH);
    expect(matchesCredential(r.lastSkip)).toBe(false);
  });

  test("skip detail — a crash message, in last-skip.json", async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    const r = await bothChannels({ repos: [repo] }, { async generate() { throw new TypeError(`blew up on ${GH}`); } }, true);
    expectBothClean(r);
    const skip = JSON.parse(r.lastSkip) as { reason: string; detail?: string };
    expect(skip.reason).toBe("crashed");
    expect(skip.detail).toBe(`TypeError: blew up on ${REDACTION}`);
  });
});

// ── the property: rendering the redacted struct = redacting the rendered struct ──────────────────
//
// Over corpus variants with ONE planted token per CREDENTIAL_PATTERNS class in EVERY string leaf, at
// two whitespace-delimited positions (leading, trailing). `whys` keys are `norm(label)` in a real struct,
// so they are re-keyed to the planted label's `norm` — otherwise every why would silently fall out of
// both renders and the why lines would go untested.

const CORPUS: { name: string; struct: BriefingStruct }[] = [...RENDER_CORPUS, { name: "campaign morning", struct: MORNING_STRUCT }];
const POSITIONS = ["leading", "trailing"] as const;
type Position = (typeof POSITIONS)[number];
const plantOne = (s: string, tok: string, pos: Position) => (pos === "leading" ? `${tok} ${s}` : `${s} ${tok}`);

function plantAll(v: unknown, tok: string, pos: Position): unknown {
  if (typeof v === "string") return plantOne(v, tok, pos);
  if (Array.isArray(v)) return v.map((x) => plantAll(x, tok, pos));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = k === "whys"
        ? Object.fromEntries(Object.entries(x as Record<string, string>).map(([wk, wv]) => [norm(plantOne(wk, tok, pos)), plantOne(wv, tok, pos)]))
        : plantAll(x, tok, pos);
    }
    return out;
  }
  return v;
}

/** ⚠ MEASURED DIVERGENCE — REPORTED, NOT FIXED, AND NOT WEAKENED. These variants run the property under
 *  `test.failing` with the assertion unchanged, so the day the cause is fixed the suite says so.
 *  They do not leak: the safety tests above run on every variant, these included.
 *
 *  D2 — `env-assignment`'s value class `[^\s"'\`]{8,}` is greedy across the renderer's own punctuation:
 *  when the token ENDS a leaf and the renderer appends `)`, `]`, `,` or `;`, the post-render scan swallows
 *  that character and the per-leaf scan cannot. Measured on every fixture at the trailing position
 *  (12 variants).
 *
 *  (D1 — a lowercased `whys` key escaping the four case-sensitive classes — was FIXED by redacting keys
 *  case-insensitively in `redactStruct`; its 28 variants outside D2 now pass the property unpinned.) */
const knownDivergence = (_s: BriefingStruct, cls: string, pos: Position): string | null =>
  cls === "env-assignment" && pos === "trailing" ? "D2" : null;

describe("property: renderBriefing(redactStruct(s)) === redactCredentials(renderBriefing(s))", () => {
  for (const { name, struct } of CORPUS) {
    for (const cls of CLASSES) {
      for (const pos of POSITIONS) {
        const s = plantAll(struct, TOKENS[cls]!, pos) as BriefingStruct;
        const label = `${name} / ${cls} / ${pos}`;
        test(`${label} — non-vacuous, and neither side leaks`, () => {
          const rendered = renderBriefing(s);
          // NON-VACUITY: the plant reached the page, so redaction has something to do.
          expect(rendered).not.toBe(redactCredentials(rendered));
          expect(matchesCredential(renderBriefing(redactStruct(s)))).toBe(false);
          expect(matchesCredential(redactCredentials(rendered))).toBe(false);
          expect(matchesCredential(JSON.stringify(redactStruct(s)))).toBe(false);
          // …and CASE-INSENSITIVELY: `matchesCredential` is case-sensitive, so on its own it was blind to
          // a lowercased `whys` key (D1). PREMISE first: the planted struct does serialise the secret.
          expect(leaksSecret(JSON.stringify(s), cls)).toBe(true);
          expect(leaksSecret(JSON.stringify(redactStruct(s)), cls)).toBe(false);
        });
        const known = knownDivergence(struct, cls, pos);
        (known ? test.failing : test)(`${label} — property${known ? ` (known divergence ${known})` : ""}`, () => {
          expect(renderBriefing(redactStruct(s))).toBe(redactCredentials(renderBriefing(s)));
        });
      }
    }
  }

  test("the divergence list is exactly what was measured: 12 of 192 variants", () => {
    let n = 0, known = 0;
    for (const { struct } of CORPUS) for (const cls of CLASSES) for (const pos of POSITIONS) {
      n++; if (knownDivergence(struct, cls, pos)) known++;
    }
    expect([n, known]).toEqual([CORPUS.length * CLASSES.length * 2, 12]);
    expect(CORPUS.length).toBe(12);
  });
});

// ── posture invariance: redaction cannot move the posture phrase ─────────────────────────────────
//
// `posturePhrase` classifies by SUBSTRING (posture.ts), so a redaction that cut into a sentinel would
// flip an EVAL.md row. The fixtures carry every posture marker — read from posture.ts's own source so a
// marker added there is covered here without an edit — and every sentinel and carve-out phrase.

function postureMarkers(): string[] {
  const src = readFileSync(join(import.meta.dir, "..", "src", "eval", "posture.ts"), "utf8");
  const block = /const POSTURE_MARKERS = \[([\s\S]*?)\] as const;/.exec(src)?.[1] ?? "";
  const code = block.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  return [...new Set([...code.matchAll(/"([^"]+)"/g)].map((m) => m[1]!))];
}

describe("posture invariance: posturePhrase(mergeWarnings(redactStruct(s))) === posturePhrase(mergeWarnings(s))", () => {
  const markers = postureMarkers();
  const base = (warnings: string[]): BriefingStruct => ({ ...STRUCT, warnings });
  const FIXTURES: { name: string; s: BriefingStruct }[] = [
    { name: "no warnings", s: base([]) },
    { name: "truncation + cleartext only (not posture)", s: base([`provider ${TRUNCATION_SENTINEL}`, `the model ${API_TRUNCATION_SENTINEL}`, `prompt ${API_CLEARTEXT_SENTINEL}`]) },
    { name: "opt-out", s: base(["provider hardening DISABLED by config (provider.harden: false)"]) },
    { name: "non-claude CLI", s: base(["provider hardening skipped: codex is not recognised as the claude CLI"]) },
    { name: "api transport", s: base([`provider hardening n/a: ${API_TRANSPORT_SENTINEL}`]) },
    { name: "every carve-out at once", s: base([
      "provider hardening DISABLED by config", "provider hardening skipped: x is not recognised as the claude CLI",
      `provider hardening n/a: ${API_TRANSPORT_SENTINEL}`,
    ]) },
    ...markers.map((m) => ({ name: `marker "${m}"`, s: base([`prefix ${m} suffix`]) })),
    { name: "every marker and sentinel together", s: base([
      ...markers.map((m) => `w ${m} w`), `x ${TRUNCATION_SENTINEL}`, `y ${API_TRUNCATION_SENTINEL}`, `z ${API_CLEARTEXT_SENTINEL}`,
    ]) },
  ];

  test("premise: the source parse found the marker list, and the fixtures reach every phrase", () => {
    expect(markers.length).toBeGreaterThanOrEqual(6);   // six at the time of writing
    for (const m of markers) expect(`${m}: ${isPostureWarning(`x ${m} x`)}`).toBe(`${m}: true`);
    const phrases = new Set(FIXTURES.map((f) => posturePhrase(mergeWarnings(f.s))));
    expect([...phrases].sort()).toEqual(["degraded", "full", "off (by config)", "unhardened (api provider)", "unhardened (non-claude CLI)"]);
  });

  for (const f of FIXTURES) {
    test(`${f.name} — without a plant`, () => {
      expect(posturePhrase(mergeWarnings(redactStruct(f.s)))).toBe(posturePhrase(mergeWarnings(f.s)));
    });
    for (const cls of CLASSES) for (const pos of POSITIONS) {
      test(`${f.name} — ${cls} planted (${pos})`, () => {
        const s = plantAll(f.s, TOKENS[cls]!, pos) as BriefingStruct;
        if ((f.s.warnings ?? []).length) {
          // NON-VACUITY: the warnings really were rewritten by the redaction.
          expect(mergeWarnings(redactStruct(s))).not.toEqual(mergeWarnings(s));
        }
        expect(posturePhrase(mergeWarnings(redactStruct(s)))).toBe(posturePhrase(mergeWarnings(s)));
        // …and the plant itself did not move the phrase either, so the comparison is against the real one.
        expect(posturePhrase(mergeWarnings(s))).toBe(posturePhrase(mergeWarnings(f.s)));
      });
    }
  }
});

// ── the audit corpus: briefing.log still holds the redacted markdown — MEASURED ─────────────────
//
// Under launchd, StandardOutPath IS briefing.log and `audit.lastBriefing` grades what follows the last
// header in it. This runs the real CLI the way the plist does — `run --force --json-out <p>` with stdout
// redirected to a briefing.log in a scratch state dir — and reads the file back.
test("briefing.log still holds the redacted markdown, byte-identical to the envelope's", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const subject = `chore: drop ${GH} from the deploy script`;
  await commitFiles(repo, ["b.txt"], { message: subject, isoDate: new Date(Date.now() - 60_000).toISOString() });
  const home = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-e1-home-")));
  const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-e1-cfg2-")));
  const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-e1-state2-")));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  const cli = join(home, "fake-provider.sh");
  writeFileSync(cli, `#!/bin/sh
cat > /dev/null
printf '## RESUME\\n- [r] rotate %s out of CI\\n## RECAP\\n- [r] did y | evidence: abc123\\n## SUGGESTIONS\\n- something else\\n' "${GH}"
`, { mode: 0o755 });
  writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify({
    repos: [repo], excludeCommitPatterns: [], lookbackCapDays: 30,
    networkProbeHosts: [],                       // the explicit skip switch — this test opens no socket
    provider: { cli, argv: [], promptVia: "stdin" },
  }));
  const logPath = join(stateDir, "briefing.log");
  const outPath = join(stateDir, "sidecar.json");
  const proc = Bun.spawn(["bun", "run", "src/main.ts", "run", "--force", "--json-out", outPath], {
    cwd: import.meta.dir.replace(/\/test$/, ""),
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: cfgHome, DAILY_BRIEFING_STATE_DIR: stateDir },
    stdout: Bun.file(logPath), stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);

  const log = readFileSync(logPath, "utf8");
  const envelope = JSON.parse(readFileSync(outPath, "utf8")) as RunEnvelope;
  const graded = lastBriefing(log);
  // PREMISES: a briefing was delivered, and both plants (model text AND commit subject) reached it.
  expect(envelope.delivered).toBe(true);
  expect(graded).toContain("briefing —");
  expect(graded).toContain(`rotate ${REDACTION} out of CI`);
  expect(JSON.stringify(envelope.struct)).toContain(`chore: drop ${REDACTION} from the deploy script`);
  // THE MEASUREMENT: the log carries exactly the envelope's markdown, redacted, and nothing raw.
  expect(log.trimEnd()).toBe(envelope.markdown.trimEnd());
  expect(log).not.toContain(GH);
  expect(matchesCredential(log)).toBe(false);
  expect(readFileSync(outPath, "utf8")).not.toContain(GH);
  expect(stderr).not.toContain(GH);
}, 30000);
