// src/json.ts — the MACHINE-READABLE SURFACES (gui-tauri T1–T4).
//
// The engine's only output has always been markdown on stdout. A desktop shell cannot import this
// code (15 of 26 src modules use Bun.* APIs), so its entire API is spawning the binary — which means
// every fact the GUI needs has to leave the process as structured text. This module is where those
// shapes are built, and nowhere else builds them.
//
// ⚠ NOT IN `types.ts`, DELIBERATELY. That file is frozen ("only ADDITIVE, optional fields may be
// appended") because later-slice consumers depend on its shapes. These four surfaces are NEW
// contracts with their own version field and their own freeze rule (additive-only; anything else
// bumps `schemaVersion`), so they get their own module rather than an exemption in a frozen one.
//
// ⚠ READ-ONLY, and the one write is the caller's rather than this module's. `envelopeFrom` is a pure
// projection of a CoreResult; `statusReport` reads the state directory and writes NOTHING — it must
// be safe to poll every few seconds, which is why it must never reach `checkRanToday`, the function
// that REPAIRS (i.e. writes) an unreadable marker; `doctorReport` never calls `provider.generate`
// (no allowance burned, no cost) and never stamps; `validateCandidate` is pure over a candidate.
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { homedir } from "node:os";
import pkg from "../package.json";
import type { BriefingStruct, Config } from "./types";
import type { CoreResult } from "./core";
import { warnFor, isInaccessible, type PathIssue, type PathIssueKind } from "./protectedPath";
import { redactCredentials, redactCredentialsAnyCase } from "./transcripts/credentials";
import {
  supportDir, markerPath, tickPath, logPath, latestBriefingPath, lastSkipPath, readLastRunDate,
  readLastSkip, schedulePath, recapCampaignsPath, updateCheckPath, type LastSkip,
} from "./marker";
import { publicResult, readUpdateCheckState, resolveUpdateCheck, type UpdateCheckResult } from "./updateCheck";
import { runLockPath } from "./runlock";
import { resolveNotify } from "./notify";
// ⚠ Slice 4's `schedulePath` comes from ./marker, NOT from ./schedule/install — even though the
// installer re-exports it. A static edge from this module (which the run path imports) into the
// installer would pull the installer and its `proc.run` default exec into every `daily-briefing run`
// process, which is precisely what main.ts's dynamic import of that module exists to avoid.
import { accountStatePath } from "./account";
import {
  configPath, loadConfig, validateConfig, resolveTranscripts, resolveAccounts, resolveVerdictPaths,
  compileExcludePatterns, discoverRepos, resolveCliPath as whichOnPath,
  DEFAULT_EXCLUDE_COMMIT_PATTERNS, DEFAULT_NETWORK_PROBE_HOSTS,
} from "./config";
import { resolveApiKey } from "./apiKey";
import { deriveProbeHosts, endpointUrl, isLoopbackHost, printableEndpoint, endpointHasWithheldParts } from "./providers/endpoint";
import { parseFloor, isPastFloor, DEFAULT_MORNING_TIME } from "./schedule";
import { resolveProbeHosts, defaultNetProbe } from "./net";
import { isFullyAwake } from "./power";
import { probeCapabilities } from "./probe";
import { claudeShaped, WANTED_FLAGS } from "./harden";
// ⚠ From ./preflight, NOT from ./main — main.ts imports THIS module, and a dynamic `import("./main")`
// here was measured deadlocking the real `doctor --json` for 20 s (see src/preflight.ts's header).
import { preflightRepos } from "./preflight";
import { mapLimit, REPO_SCAN_CONCURRENCY } from "./extractor";
import { isPartialClone } from "./git";

/** Bumped only by a BREAKING change. Every field added below is additive and leaves this at 1. */
export const JSON_SCHEMA_VERSION = 1;

// ── the skip vocabulary ─────────────────────────────────────────────────────────────────────────

/** Every reason `run()` can return WITHOUT delivering a briefing, as a closed set.
 *
 *  ⚠ CLOSED ON PURPOSE. `<state>/last-skip.json` and the run envelope both carry one of these, and a
 *  GUI switches on it to decide what to tell the user — so a free-text reason invented at one return
 *  site is a silent gap in that switch. Adding a return path to `run()` means adding its reason here,
 *  and `test/json-surfaces.test.ts` pins that every non-delivering return writes one of them. */
export const SKIP_REASONS = [
  "already-ran",      // the once-per-day marker was already stamped for today
  "no-config",        // scheduled tick on a machine with no config (fresh install, or one that vanished)
  "config-error",     // the config exists but is malformed/unreadable → exit 2
  "below-floor",      // a scheduled, non-interactive tick before `morningTime`
  "concurrent",       // another run holds <state>/run.lock (see runlock.ts)
  "offline",          // the network gate never came up within the grace → provider NOT called
  "darkwake",         // maintenance darkwake: the provider call cannot complete here
  "limited",          // every configured account is at its usage limit
  "blocked",          // zero activity AND a repo we tried to read was inaccessible → do NOT stamp
  "provider-fail",    // the provider errored (after retries) → exit 1
  "parse-empty",      // the model's output parsed into no section at all → exit 1
  "marker-fail",      // the briefing was written but the day marker could not be → exit 1
  "crashed",          // a non-ProviderError escaped the pipeline; the envelope is emitted, then rethrown
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

// ── shared: where the engine keeps its state ────────────────────────────────────────────────────

/** Every state-dir path the GUI would otherwise recompute.
 *
 *  ⚠ THIS EXISTS SO THERE IS ONE IMPLEMENTATION OF `stateDirFor`. Reimplementing "macOS →
 *  ~/Library/Application Support, Windows → %LOCALAPPDATA%, else XDG, and DAILY_BRIEFING_STATE_DIR
 *  overrides all three" (marker.ts:9-14) plus configPath's own XDG rule (config.ts:47) in Rust or in
 *  a webview is four platform branches that would drift on the first change — and the failure would
 *  be a shell watching a directory the engine no longer writes to. */
export type StatePaths = {
  stateDir: string;
  configPath: string;
  markerPath: string;
  tickPath: string;
  logPath: string;
  latestBriefingPath: string;
  briefingsDir: string;
  accountStatePath: string;
  lastSkipPath: string;
  runLockPath: string;
  /** Slice 4 — `<state>/schedule.json`, the single-owner scheduling record. ADDITIVE.
   *  Declared here rather than only in src/schedule/install.ts so `engineOwns` protects it from
   *  `--json-out` by EXISTING rather than by being remembered — the property that docstring claims. */
  schedulePath: string;
  /** Tier B — `<state>/recap-campaigns.jsonl`, the recap-campaigns trial record (spec §4.10 1). ADDITIVE,
   *  and here for `schedulePath`'s reason: `engineOwns` protects it from `--json-out` by EXISTING. The
   *  app's Rust mirror is `serde(default)` without `deny_unknown_fields`, so it needs no change. */
  recapCampaignsPath: string;
  /** Phase E (E11) — `<state>/update-check.json`, the opt-in update check's last answer. ADDITIVE, and
   *  here for `schedulePath`'s reason: `engineOwns` protects it from `--json-out` by EXISTING. */
  updateCheckPath: string;
};

export function briefingsDir(): string {
  return join(supportDir(), "briefings");
}

export function statePaths(): StatePaths {
  return {
    stateDir: supportDir(),
    configPath: configPath(),
    markerPath: markerPath(),
    tickPath: tickPath(),
    logPath: logPath(),
    latestBriefingPath: latestBriefingPath(),
    briefingsDir: briefingsDir(),
    accountStatePath: accountStatePath(),
    lastSkipPath: lastSkipPath(),
    runLockPath: runLockPath(),
    schedulePath: schedulePath(),
    recapCampaignsPath: recapCampaignsPath(),
    updateCheckPath: updateCheckPath(),
  };
}

// ── T1: the run envelope ────────────────────────────────────────────────────────────────────────

export type EnvelopeIssue = { path: string; kind: PathIssueKind; message: string };

export type RunEnvelope = {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  ok: boolean;                 // exitCode === 0
  exitCode: number;
  delivered: boolean;          // a briefing was rendered, written and stamped
  runDate: string;             // the LOCAL date the run belongs to
  skipReason: SkipReason | null;
  blocked: boolean;
  emptyWindow: boolean;
  limited: CoreResult["limited"] | null;
  account: string | null;
  net: { online: boolean; waitedMs: number } | null;
  /** ⚠ BYTE-IDENTICAL to what a no-flag run prints on stdout. It is the SAME string object the shell
   *  renders, passed in rather than re-rendered here — a second `renderBriefing` call would be a
   *  second implementation of the briefing, free to drift from the one the user reads. "" when no
   *  briefing was produced. */
  markdown: string;
  /** `null` on every path that returned before the pipeline built one (a gate skip, a config error). */
  struct: BriefingStruct | null;
  warnings: string[];
  discIssues: EnvelopeIssue[];
  paths: StatePaths;
};

/** Project a completed pipeline run into the envelope. Pure: no I/O beyond `statePaths()`'s pure
 *  path math, and it makes no exit-code decisions of its own — `exitCode` is what the shell decided.
 *
 *  `skipReason` is an OPTIONAL fourth argument for the two non-delivering returns the pipeline cannot
 *  name itself: a soft parse failure and a failed day-marker write both happen in the shell, AFTER a
 *  CoreResult exists, and both exit 1. Inferring one from the exit code would label the other wrong. */
export function envelopeFrom(
  r: CoreResult, rendered: string, exitCode: number, skipReason?: SkipReason,
): RunEnvelope {
  // `blocked` and `offlineSkipped` are the two families of non-delivery the pipeline itself reports;
  // a non-zero exit covers the rest (provider failure surfaces as a throw, so it never reaches here).
  const delivered = exitCode === 0 && !r.blocked && !r.offlineSkipped;
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    ok: exitCode === 0,
    exitCode,
    delivered,
    runDate: r.runDate,
    // `skipReason` is the pipeline's own field where it has one; `blocked` has no entry there (it is
    // a separate boolean on CoreResult) so it is folded in, because a consumer asking "why did
    // nothing arrive" must not have to know which of the two fields carries the answer.
    skipReason: skipReason ?? r.skipReason ?? (r.blocked ? "blocked" : null),
    blocked: r.blocked,
    emptyWindow: r.emptyWindow,
    limited: r.limited ?? null,
    account: r.account ?? null,
    net: r.net,
    markdown: rendered,
    struct: r.struct,
    warnings: r.warnings,
    // The discovery-side issues have no warning string of their own (main.ts formats them at the
    // terminal boundary); carry BOTH the machine-readable kind and the human advice so the GUI can
    // show the same sentence the CLI prints without owning a second copy of the wording.
    discIssues: r.discIssues.map((i) => ({ path: i.path, kind: i.kind, message: warnFor(i) })),
    paths: statePaths(),
  };
}

/** E1 (#496 follow-up) — the envelope's credential redaction. A recursive map that applies the SAME
 *  `redactCredentials` that produces `markdown` (main.ts, `redactCredentials(renderBriefing(r.struct))`)
 *  to every string leaf and returns a NEW value; non-strings pass through, and the input is never
 *  mutated.
 *
 *  ⚠ WHY A RECURSIVE MAP AND NOT A FIELD LIST. Before this, the envelope carried the raw `r.struct`
 *  beside a redacted `markdown`, so a key the briefing file showed as `[redacted]` was still in the
 *  `--json-out` sidecar and on `run --json`'s stdout (the GUI's struct-vs-file block check,
 *  gui/src/lib/today.ts, was the only thing keeping it off screen). A list of "the fields that can carry
 *  git-derived text" goes stale on the next additive field; a map over every leaf covers fields that do
 *  not exist yet.
 *
 *  ⚠ OBJECT KEYS ARE REDACTED TOO — AND CASE-INSENSITIVELY, which leaves do not need. `whys` is keyed
 *  by `norm(label)` — a git-derived folder name — and `norm` LOWERCASES. Four classes (aws-access-key-id,
 *  jwt, private-key-block, env-assignment) are case-sensitive, so the shared matcher alone left
 *  `api_token=…` and `akia…` (trivially reversible) in a key while the label beside it was redacted.
 *  A key therefore gets `redactCredentials` first and then case-insensitive clones of the same
 *  patterns (`redactKey` = `redactCredentialsAnyCase`, credentials.ts, which applies
 *  `CREDENTIAL_PATTERNS_ANY_CASE` and which the Stage-2 record labels also use). The shared matcher's
 *  semantics are untouched.
 *  For a whys key that makes the redacted key equal `norm(redactCredentials(label))`, so the render
 *  lookup `whys[norm(label)]` still finds the why after redaction. A key with no match is returned
 *  byte-identical. Two keys that redact to the same text collide and the later wins; only keys that
 *  each contained a credential can collide. The case-insensitive pass can redact a key whose label the
 *  case-sensitive pass did not (e.g. `MyAPI_TOKEN=…`); that loses the why line, which fails closed.
 *
 *  ⚠ FAIL CLOSED ON SHAPE. The value is first normalised through `JSON.parse(JSON.stringify(v))`, so
 *  what is redacted is EXACTLY what would be serialised: a class instance, a boxed `new String(…)` or an
 *  object with its own `toJSON` used to pass through (or survive the rebuild) and serialise raw.
 *  ⚠ No string-level `redactCredentials(JSON.stringify(…))` backstop: env-assignment's value class admits
 *  `\`, so it can eat the backslash of an escaped quote and corrupt the JSON.
 *
 *  ⚠ OUTPUT-ONLY. Applied once at the output boundary — `emit` in main.ts, before it splits between
 *  stdout and the `--json-out` file. The in-memory struct the run, postcheck and the eval harness read
 *  is never passed through this: eval reads `runCore`'s struct directly (src/eval/run-case.ts) and never
 *  sees an envelope. */
export function redactStruct<T>(v: T): T {
  // `JSON.stringify(undefined)` is undefined, and there is nothing to serialise either way.
  if (v === undefined) return v;
  return redactJson(JSON.parse(JSON.stringify(v))) as T;
}

/** KEYS only (see `redactStruct`): the shared case-sensitive pass, then its case-insensitive clones. */
const redactKey = redactCredentialsAnyCase;

/** The map over a JSON value (the output of `JSON.parse`, so every object is plain).
 *  ⚠ KEYS ARE DEFINED, NOT ASSIGNED. `JSON.parse` makes a key spelled `__proto__` an ordinary own
 *  property (reachable: `whys` is keyed by a git-derived folder name), but `out["__proto__"] = x` hits
 *  the inherited setter — a string value was silently DROPPED and an object value became `out`'s
 *  prototype. `defineProperty` keeps it an own, enumerable key that serialises like any other. */
function redactJson(v: unknown): unknown {
  if (typeof v === "string") return redactCredentials(v);
  if (Array.isArray(v)) return v.map(redactJson);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      Object.defineProperty(out, redactKey(k), { value: redactJson(x), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return v;
}

/** The envelope as it may leave the process — `emit`'s one call (main.ts). `struct`, `warnings` and
 *  `discIssues` (path AND message: the message embeds the path) go through `redactStruct`; that covers
 *  `gateEnvelope`'s `warnings` too, since every envelope reaches the boundary through here.
 *  NOT touched: `markdown` (already redacted, and it must stay byte-identical to the same run's stdout),
 *  `paths` (the engine's own state-path math, which consumers open), and the rest — booleans, numbers,
 *  closed-vocabulary reasons, `net`, and the account LABEL in `account`/`limited`, which is user config
 *  text rather than git- or provider-derived (out of E1's channel list; stated, not overlooked).
 *  Exported, rather than inlined in `emit`, because no `run()` return populates `gateEnvelope`'s
 *  `warnings` today — this is the only seam that channel can be tested through. */
export function redactEnvelope(env: RunEnvelope): RunEnvelope {
  return {
    ...env,
    struct: redactStruct(env.struct),
    warnings: redactStruct(env.warnings),
    discIssues: redactStruct(env.discIssues),
  };
}

/** The envelope for a run that returned BEFORE the pipeline produced a CoreResult — the marker gate,
 *  the floor gate, a missing/malformed config, a lock held by another run. There is no struct and no
 *  markdown on these paths, and saying so with `null`/"" is the honest shape; a synthesised empty
 *  BriefingStruct would claim a briefing was computed and found empty, which is a different fact.
 *
 *  `net` is OPTIONAL and exists for the one gate return that HAS a net record: the provider-failure
 *  path prints `emitNetMessage(err.net)` to stderr and then returns through here, so without this the
 *  envelope for the most operationally interesting failure was strictly poorer than the stderr the
 *  CLI had just written — a GUI could not tell whether the network was up or how long the gate waited.
 *  Every other gate genuinely has no net record and passes nothing, which stays `null`. */
export function gateEnvelope(args: {
  exitCode: number; runDate: string; skipReason: SkipReason; warnings?: string[];
  net?: { online: boolean; waitedMs: number } | null;
}): RunEnvelope {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    ok: args.exitCode === 0,
    exitCode: args.exitCode,
    delivered: false,
    runDate: args.runDate,
    skipReason: args.skipReason,
    blocked: false,
    emptyWindow: false,
    limited: null,
    account: null,
    net: args.net ?? null,
    markdown: "",
    struct: null,
    warnings: args.warnings ?? [],
    discIssues: [],
    paths: statePaths(),
  };
}

/** Is `p` the directory `dir`, or something inside it? Compared on the separator so `/state/briefingsX`
 *  is not mistaken for a child of `/state/briefings`. */
function insideOrIs(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * What the engine itself owns at `resolved`, or `undefined` when nothing does.
 *
 * ⚠ DERIVED FROM `statePaths()`, never from a hand-kept list, so a state file added later is
 * protected by EXISTING rather than by being remembered here. It is checked three ways because a
 * caller can name the same file three ways: the absolute path, the bare name resolved under the state
 * dir, and a path inside the dated-archive directory.
 */
function engineOwns(resolved: string, stateDir: string): string | undefined {
  const sp = statePaths();
  const owned: [string, string][] = [
    [sp.configPath, "config file"],
    [sp.markerPath, "day marker"],
    [sp.tickPath, "tick heartbeat"],
    [sp.logPath, "launchd briefing log"],
    [sp.latestBriefingPath, "latest briefing"],
    [sp.accountStatePath, "account state"],
    [sp.lastSkipPath, "last-skip record"],
    [sp.runLockPath, "run lock"],
    [sp.schedulePath, "schedule ownership record"],
    [sp.recapCampaignsPath, "recap-campaigns record"],
    [sp.updateCheckPath, "update-check record"],
  ];
  for (const [path, what] of owned) if (resolved === path) return what;
  // The bare-name form under whichever state dir the caller resolved against — `statePaths()` reads
  // the ambient one, and the two agree in production, but the seam must not be a way around this.
  const names = new Map(owned.filter(([p]) => insideOrIs(p, sp.stateDir)).map(([p, w]) => [basename(p), w]));
  for (const dir of [stateDir, sp.stateDir]) {
    if (resolved === dir) return "state directory";
    if (dirname(resolved) === dir) { const w = names.get(basename(resolved)); if (w) return w; }
    if (insideOrIs(resolved, join(dir, "briefings"))) return "dated briefing archive";
  }
  if (insideOrIs(resolved, sp.briefingsDir)) return "dated briefing archive";
  return undefined;
}

/** Shape-guard for `--json-out <path>`, modelled on `archivedBriefingPath`'s (marker.ts:141-149) for
 *  the same measured reason: that helper was found escaping the state dir entirely on a `..` input.
 *  Absolute paths are taken as given (the GUI writes to its own temp dir); anything else is resolved
 *  UNDER the state dir, and a `..` segment — the traversal — is refused rather than normalised away.
 *
 *  ⚠ AND A TARGET THE ENGINE OWNS IS REFUSED, which is the half the model above did NOT supply.
 *  `archivedBriefingPath` is safe because it constrains its component to `YYYY-MM-DD.md`; this guard
 *  inherited the traversal check without that naming constraint, so with the state dir as the DEFAULT
 *  resolution root every engine file was an addressable target and `emit` writes with TRUNCATING
 *  `Bun.write`. Both consequences were measured:
 *    `--json-out briefing.log` truncated the append-only launchd log that `audit.lastBriefing`,
 *      `coverageGaps` and `missingSameDay` grade — the audit corpus RunOutput's docstring exists to
 *      protect (36 bytes → 3).
 *    `--json-out last-run` was worse because of ORDER: on the delivering path `emit` runs AFTER
 *      `stampToday`, so the run delivered, stamped, then overwrote the marker with the envelope; the
 *      next tick's `readLastRunDate` returned that blob, `ranToday` was false, and the day regenerated.
 *  Refusing is safe here in a way it would not be inside `run()`: this is a pure shape check that
 *  `dispatch` evaluates BEFORE run() is entered, so the answer is exit 2 with nothing written — never
 *  a lost morning. */
export function resolveJsonOutPath(p: string, stateDir: string = supportDir()): string {
  if (typeof p !== "string" || p.trim() === "") {
    throw new Error("--json-out: expected a path");
  }
  if (p.includes("\0")) throw new Error("--json-out: path contains a NUL byte");
  if (p.split(/[\\/]/).includes("..")) {
    throw new Error(`--json-out: path may not contain "..", got ${JSON.stringify(p)}`);
  }
  const resolved = isAbsolute(p) ? p : join(stateDir, p);
  const owns = engineOwns(resolved, stateDir);
  if (owns) {
    throw new Error(`--json-out: ${resolved} is the engine's ${owns} — writing the envelope there would destroy it; pick another name or an absolute path outside the state directory`);
  }
  return resolved;
}

// ── T2: `status --json` — a pure state-dir read ─────────────────────────────────────────────────

export type StatusReport = {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  /** ADDITIVE beyond the task spec: the GUI ships a bundled engine AND can be pointed at a
   *  separately-installed managed copy, so engine/app version SKEW is a state the Schedule panel has
   *  to be able to show. Without it the panel can only guess. */
  engineVersion: string;
  platform: NodeJS.Platform;
  paths: StatePaths;
  configExists: boolean;
  /** `null` when the config loaded (or is simply absent). A STRING when the file exists but could not
   *  be read or validated — without this field a malformed config is indistinguishable from a missing
   *  one, and `morningTime` below would silently report the default as though it were configured. */
  configError: string | null;
  lastRunDate: string | null;
  /** The `<state>/last-skip.json` record, or `null` when absent or corrupt.
   *
   *  ⚠ ADDITIVE, and it exists because the alternative was worse: this surface's stated job is
   *  answering "it is 09:00 and no briefing arrived — did the run decline, and for what reason?", and
   *  without the record it exposed only `paths.lastSkipPath`, i.e. it told the shell where to go open
   *  and parse a second file AND re-implement `readLastSkip`'s corrupt-record tolerance. That made
   *  `readLastSkip` a function with no src/ caller at all, which is how a reader contract rots.
   *  ⚠ READ-ONLY like everything else here: `readLastSkip` returns `undefined` rather than repairing. */
  lastSkip: LastSkip | null;
  lastTick: { iso: string; localDate: string; count: number } | null;
  latestBriefingMtime: string | null;
  archivedDates: string[];
  logBytes: number | null;
  morningTime: { value: string; minutes: number; warning: string | null };
  isPastFloor: boolean;
  /** Phase E (E11) — the opt-in update check's LAST answer, read from `<state>/update-check.json` with
   *  NO network (the check itself is `update --check`, or a scheduled run's automatic path). `null`
   *  when no check has run or the record is unreadable. ADDITIVE-OPTIONAL: a reader written against
   *  the earlier schema never sees this key, and the desktop app reads it through its existing
   *  `engine_status` grant. The response's cache tag (`etag`) is internal and never reported. */
  updateCheck?: UpdateCheckResult | null;
};

/** The heartbeat line's format, verbatim from `stampTick` (marker.ts:87). Kept as one shared regex
 *  literal rather than two spellings: a legacy line without `local=` must read as "no tick", exactly
 *  as the writer's own reset branch treats it, and a second spelling here could drift from that. */
const TICK_RE = /^(\S+)\s+local=(\S+)\s+today=(\d+)$/;

export function parseTickLine(text: string): StatusReport["lastTick"] {
  const m = text.trim().match(TICK_RE);
  return m ? { iso: m[1]!, localDate: m[2]!, count: Number(m[3]) } : null;
}

/**
 * Read everything a GUI needs about engine state. Creates nothing, repairs nothing, stamps nothing —
 * `test/json-surfaces.test.ts` asserts that with a filesystem snapshot taken before and after.
 *
 * ⚠ IT READS THE MARKER FILE DIRECTLY rather than calling `checkRanToday`. That function is the
 * obvious one to reach for and it is the one trap in this surface: on an unreadable marker it
 * UNLINKS and REWRITES (marker.ts:212-218). A status call is polled; a polled repair is a write loop.
 */
export async function statusReport(deps: { now?: () => Date } = {}): Promise<StatusReport> {
  const now = deps.now?.() ?? new Date();
  const paths = statePaths();

  const configExists = await Bun.file(paths.configPath).exists().catch(() => false);
  let cfg: Config | undefined;
  let configError: string | null = null;
  if (configExists) {
    try { cfg = await loadConfig(); }
    // Redacted: a parse or validation error can quote the config's own text (the E11 rule — see
    // `validateCandidate`'s return).
    catch (e) { configError = redactCredentials(e instanceof Error ? e.message : String(e)); }
  }

  const floor = parseFloor(cfg?.morningTime);
  const morningTime: unknown = cfg?.morningTime ?? DEFAULT_MORNING_TIME;
  const lastTickText = await Bun.file(paths.tickPath).text().catch(() => "");
  const archived = await readdir(briefingsDir()).catch(() => [] as string[]);
  const latestStat = await stat(paths.latestBriefingPath).catch(() => null);
  const logStat = await stat(paths.logPath).catch(() => null);

  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    engineVersion: pkg.version,
    platform: process.platform,
    paths,
    configExists,
    configError,
    lastRunDate: (await readLastRunDate()) ?? null,
    lastSkip: (await readLastSkip()) ?? null,
    lastTick: parseTickLine(lastTickText),
    latestBriefingMtime: latestStat ? latestStat.mtime.toISOString() : null,
    archivedDates: archived
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .map((n) => n.slice(0, 10))
      .sort(),
    logBytes: logStat ? logStat.size : null,
    morningTime: {
      // ⚠ THE IMPORTED DEFAULT, not a second literal. `minutes` below comes from `parseFloor`, which
      // derives from DEFAULT_MORNING_TIME; a hardcoded "07:20" here made the SAME object free to
      // become internally inconsistent the day that constant changes — `value` reporting the old
      // default while `minutes` reported the new one, and a Schedule panel displaying a floor the
      // engine does not use. Exactly the drift StatePaths' docstring above exists to prevent.
      // Redacted like `warning` below, which quotes the same string: an INVALID value is reported
      // verbatim here (minutes falls back to the default), and is a config echo like any other.
      // ⚠ ALWAYS A STRING, its declared type: `loadConfig` deliberately does not validate `morningTime`
      // (config.ts — `parseFloor` degrades a bad one), so a hand-edited 720 / true / {} arrives here as
      // itself. It is reported as its JSON spelling, the one `warning` quotes — and redacting the raw
      // value used to THROW on it (round-2 harden D-M1), crashing `status --json` outright.
      value: redactCredentials(typeof morningTime === "string" ? morningTime : JSON.stringify(morningTime)),
      minutes: floor.minutes,
      warning: floor.warning === undefined ? null : redactCredentials(floor.warning),
    },
    isPastFloor: isPastFloor(now, floor.minutes),
    updateCheck: await readUpdateCheckState().then((st) => (st === undefined ? null : publicResult(st)), () => null),
  };
}

// ── T4: `config validate --json` ────────────────────────────────────────────────────────────────

export type FieldNote = { field: string; message: string };

export type ConfigValidateReport = {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  valid: boolean;
  errors: FieldNote[];
  warnings: FieldNote[];
  /** The config as the pipeline would see it (paths ~-expanded), or `null` when invalid. */
  normalized: Config | null;
};

/** `validateConfig` throws `config error: "<field>" must be …`; recover the field name for a form
 *  that wants to highlight one input. Best-effort by construction — a message with no quoted field
 *  yields "", never a wrong guess. */
function fieldOf(message: string): string {
  return /"([^"]+)"/.exec(message)?.[1] ?? "";
}

/**
 * THE SINGLE VALIDATOR. A Settings screen calls this before writing a config, and it must agree with
 * `loadConfig` exactly — so it CALLS `validateConfig`, the same function `loadConfig` calls, rather
 * than reimplementing any part of it. The degradation cases (a bad `morningTime`, a malformed
 * transcripts block, bad probe hosts, an uncompilable exclude pattern, malformed accounts) are read
 * from the same `parseFloor` / `resolveTranscripts` / `resolveProbeHosts` / `compileExcludePatterns`
 * / `resolveAccounts` helpers the pipeline reads them from, for the same reason.
 *
 * ⚠ ERRORS IS AT MOST ONE ENTRY, and that is a property of `validateConfig`, not a simplification
 * here: it THROWS on the first problem it finds. Reporting an array anyway keeps the shape stable if
 * it ever accumulates, and keeps the GUI from having to special-case one-vs-many.
 */
export function validateCandidate(
  raw: unknown,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): ConfigValidateReport {
  let normalized: Config | null = null;
  const errors: FieldNote[] = [];
  try {
    normalized = validateConfig(raw, home);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push({ field: fieldOf(message), message });
  }

  const warnings: FieldNote[] = [];
  if (normalized) {
    const floor = parseFloor(normalized.morningTime);
    if (floor.warning) warnings.push({ field: "morningTime", message: floor.warning });
    const tr = resolveTranscripts(normalized.transcripts, home, env);
    if (tr.warning) warnings.push({ field: "transcripts", message: tr.warning });
    const hosts = resolveProbeHosts(normalized.networkProbeHosts);
    if (hosts.warning) warnings.push({ field: "networkProbeHosts", message: hosts.warning });
    const { invalid } = compileExcludePatterns(normalized.excludeCommitPatterns ?? DEFAULT_EXCLUDE_COMMIT_PATTERNS);
    for (const p of invalid) {
      warnings.push({ field: "excludeCommitPatterns", message: `not a valid regex, ignored: ${p}` });
    }
    for (const w of resolveAccounts(normalized.provider?.accounts, home, env).warnings) {
      warnings.push({ field: "provider.accounts", message: w });
    }
    // Slice 4 T7. Read from `resolveNotify` — the same function the delivery path reads it from —
    // for the same reason every other line in this block does: a Settings screen must be told what
    // the engine will actually do, not what a second copy of the rules here would predict. A
    // malformed block is a WARNING, never an error: it degrades to "off" and the briefing still runs.
    const notifyCheck = resolveNotify(normalized.notify);
    if (notifyCheck.warning) warnings.push({ field: "notify", message: notifyCheck.warning });
    // IN-2. Same rule as every line above: the verdict-path marker's own resolver, so a malformed
    // value is reported here exactly when the engine will disable the marker for it.
    const verdictCheck = resolveVerdictPaths(normalized.verdictPaths);
    if (verdictCheck.warning) warnings.push({ field: "verdictPaths", message: verdictCheck.warning });
    // Phase E (E11). The update check's own resolver, for the same reason. This report (and `doctor
    // --json`, which builds its `config` block from it) is the ONLY place a malformed `updateCheck`
    // block is ever surfaced: no run reports it, by design (src/updateCheck.ts's header).
    const updateCheck = resolveUpdateCheck(normalized.updateCheck);
    if (updateCheck.warning) warnings.push({ field: "updateCheck", message: updateCheck.warning });
  }

  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    valid: errors.length === 0,
    // ⚠ REDACTED HERE, the one place every FieldNote leaves through: `config validate --json` prints
    // this report and `doctor --json` builds its `config` block from it. Several messages ECHO a config
    // value (`not a valid regex, ignored: <pattern>`, a `morningTime` that is not HH:MM, a validator
    // error quoting what it got), and the run envelope already redacts the same strings (E1) — so the
    // read-only surfaces were the raw copy. `normalized` is NOT touched: it is the caller's own config
    // handed back to the caller, which a Settings screen writes.
    errors: errors.map(redactNote),
    warnings: warnings.map(redactNote),
    normalized,
  };
}

/** A FieldNote with the shared redaction applied to both strings (the output-boundary rule above). */
function redactNote(n: FieldNote): FieldNote {
  return { field: redactCredentials(n.field), message: redactCredentials(n.message) };
}

// ── T3: `doctor --json` — preflight + capability probe, no generate, no stamp ───────────────────

export type DoctorReport = {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  engineVersion: string;
  config: { exists: boolean; valid: boolean; errors: FieldNote[]; warnings: FieldNote[] };
  repos: {
    path: string; ok: boolean; issueKind: PathIssueKind | null; advice: string | null;
    /** ADDITIVE-OPTIONAL, present only as `true`: the repo is a PARTIAL clone (`git clone --filter`),
     *  so git itself may download missing file contents from its own remote while the tool reads its
     *  history. Detected read-only (`isPartialClone`, src/git.ts). A FACT, NOT A FAULT: it leaves `ok`
     *  and the verdict alone. */
    partialClone?: true;
    /** ADDITIVE-OPTIONAL, like `provider.notes`: facts about this repo that are not faults. Today only
     *  `PARTIAL_CLONE_NOTE`. */
    notes?: string[];
  }[];
  discoveredCount: number;
  /** TRUE when the repo walk hit its bound and the `repos` list is therefore PARTIAL. `preflightRepos`
   *  descends `discoverRoots`, which on a big home directory is slow; a doctor that hangs is a doctor
   *  nobody runs, so the walk is raced against a deadline and its incompleteness is REPORTED rather
   *  than hidden behind a short list that looks complete. */
  reposTimedOut: boolean;
  provider: {
    cli: string; found: boolean; path: string | null;
    hardeningAvailable: boolean; flags: string[]; anomalies: string[];
    /** ⚠ FACTS THAT ARE NOT FAULTS, and the reason this field exists rather than another `anomalies`
     *  entry: `anomalies.length > 0` drives the verdict to `degraded`, so putting the API carve-out
     *  there made `ready` UNREACHABLE for every api config — a perfectly correct install with a
     *  resolved key and an https endpoint reported as a broken machine on every run. That is the exact
     *  argument `src/eval/posture.ts` makes for the fifth posture phrase (`unhardened (api provider)`)
     *  existing at all, and doctor was contradicting it. Additive-optional, like `api` below: a reader
     *  written against the pre-A3 schema never sees this key. */
    notes?: string[];
    /** A3-D. Present ONLY for a `provider.api` config — ADDITIVE-OPTIONAL, like every other field this
     *  frozen JSON contract has gained: a GUI written against the pre-A3 schema sees the same
     *  `provider` object it always saw, with one extra key it can ignore.
     *
     *  ⚠ `keySource` REPORTS RESOLUTION STATUS AND NOTHING ELSE. Which source answered, and whether it
     *  answered — never the key, never a prefix, never its LENGTH. A diagnostic surface that leaks a
     *  secret is worse than no diagnostic, and length is a leak: it identifies the vendor and narrows a
     *  brute force. `detail` is a variable NAME, a PATH or a command's argv[0] — all of them things the
     *  user already wrote into the config themselves. */
    api?: {
      kind: "anthropic" | "openai-compatible";
      model: string;
      /** The endpoint the run would actually use, INCLUDING the Anthropic default when none is set —
       *  "what will this talk to" is the question doctor is asked, not "what did you type".
       *
       *  ⚠ ORIGIN + PATHNAME ONLY. The query string is DELIBERATELY WITHHELD: `validateProviderApi`
       *  refuses userinfo outright, which leaves `?api_key=…` as the one remaining place a credential
       *  can hide in a baseUrl — and `doctor --json` is the output people paste into bug reports.
       *  `baseUrlQueryWithheld` says when something was held back, so this never silently shows a
       *  different URL from the one the run uses. The query IS still sent on the wire (a gateway's
       *  `api-version` parameter is load-bearing); see `requestUrl` in providers/endpoint.ts. */
      baseUrl: string | null;
      /** True when `baseUrl` above omitted a query string or fragment that the request will carry. */
      baseUrlQueryWithheld?: boolean;
      /** ⚠ STATUS, NEVER A VALUE — and `found: null` is a THIRD state, not a fancy `false`. Rung 3
       *  (`apiKeyCommand`) is NOT EXECUTED by doctor: `executed: false` says so, and `found` is null
       *  because nothing was looked for. `detail` for that rung is argv[0] alone. */
      keySource: { source: string; found: boolean | null; detail: string | null; executed?: false };
    };
  };
  network: { hostsConfigured: number; enabled: boolean; reachable: boolean; waitedMs: number };
  power: { fullyAwake: boolean };
  verdict: "ready" | "blocked" | "degraded";
};

export const DOCTOR_WALK_MS = 20_000;

/** The whole partial-clone pass is bounded by this: doctor answers by then, and no probe starts after
 *  it (a probe already in flight ends within `isPartialClone`'s own timeout). A repo it did not reach
 *  simply gets no note. */
export const DOCTOR_PARTIAL_CLONE_MS = 5_000;

/** The one line `doctor` attaches to a partial clone (user-approved 2026-10-01, known item 1 "A+"). */
export const PARTIAL_CLONE_NOTE =
  "partial clone: while the tool reads this repository's history, git itself may download missing file contents from the repository's own remote, with your usual git credentials (the tool never fetches)";

export type DoctorDeps = {
  now?: () => Date;
  /** Injected so a test can assert the tcc-denied advice and the 'blocked' verdict without a
   *  TCC-protected directory on the runner. */
  preflight?: (cfg: Config) => Promise<PathIssue[]>;
  discover?: (cfg: Config) => Promise<{ repos: string[]; issues: PathIssue[] }>;
  which?: (cli: string) => Promise<string | undefined>;
  capabilities?: typeof probeCapabilities;
  netProbe?: () => Promise<boolean>;
  powerProbe?: (args: string[]) => Promise<{ code: number; out: string }>;
  powerPlatform?: NodeJS.Platform;
  walkMs?: number;
  /** The partial-clone probe and its overall bound — injectable so a test can assert the bound. */
  partialClone?: (repo: string) => Promise<boolean>;
  partialCloneMs?: number;
};

/**
 * Report what would happen if a briefing ran, WITHOUT running one.
 *
 * ⚠ IT NEVER CALLS `provider.generate` AND NEVER TOUCHES THE MARKER. Those two sentences are the
 * whole contract: a diagnostic that burns a provider allowance is one the user learns not to run,
 * and a diagnostic that stamps the day marker would consume the morning it was invoked to explain.
 * `test/json-surfaces.test.ts` asserts both against an injected provider seam and a state snapshot.
 *
 * ⚠ THE `provider.api` BRANCH IS HERE AS OF A3-D. It reports the transport kind, the model, the
 * endpoint and the key-source RESOLUTION STATUS, and it SKIPS the CLI probe entirely — there is no
 * binary to find and no `--help` to spawn, so reporting `found: false` for a perfectly working API
 * config (which is what the CLI arm would do against a synthesized label) would be a false negative
 * that drives the verdict to `blocked`.
 */
export async function doctorReport(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const walkMs = deps.walkMs ?? DOCTOR_WALK_MS;
  const configExists = await Bun.file(configPath()).exists().catch(() => false);
  // ⚠ THE PARSE ERROR IS REPORTED, NOT SWALLOWED. This used to be `.json().catch(() => undefined)`,
  // which fed `undefined` to validateCandidate and made the commonest config breakage — a trailing
  // comma — report "the config is not a JSON object" with an empty `field`. Measured against
  // `{ "repos": ["/tmp/x"],\n}`: `status --json` said configError = "Failed to parse JSON" (it takes
  // the loadConfig path, where the error propagates) while `doctor --json` said the file is not an
  // object and returned verdict "blocked". The file IS an object; it has a syntax error. So the
  // surface whose entire purpose is DIAGNOSIS named the wrong cause, and two surfaces the same GUI
  // polls contradicted each other about one file. Both now read it the same way — `Bun.file().json()`
  // — and report the same message, which is the agreement the module header claims one level down.
  let raw: unknown;
  let readError: string | undefined;
  if (configExists) {
    try { raw = await Bun.file(configPath()).json(); }
    catch (e) { readError = e instanceof Error ? e.message : String(e); }
  }
  const check: ConfigValidateReport = readError === undefined
    ? validateCandidate(raw)
    : { schemaVersion: JSON_SCHEMA_VERSION, valid: false, errors: [redactNote({ field: "", message: readError })], warnings: [], normalized: null };
  const cfg = check.normalized;

  let repos: DoctorReport["repos"] = [];
  let discoveredCount = 0;
  let reposTimedOut = false;
  if (cfg) {
    const preflight = deps.preflight ?? ((c: Config) => preflightRepos(c));
    const discover = deps.discover ?? ((c: Config) => discoverRepos(c));
    // Race BOTH walks against one deadline. `Promise.race` cannot cancel the loser, but the process
    // is per-invocation and the abandoned walk simply finishes into nothing — the same "abandon, do
    // not await" shape `net.ts`'s connect race uses, and for the same reason.
    const deadline = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), walkMs).unref?.());
    const walked = await Promise.race([
      (async () => ({
        issues: await preflight(cfg),
        found: (await discover(cfg)).repos,
      }))(),
      deadline,
    ]);
    if (walked === "timeout") reposTimedOut = true;
    else {
      discoveredCount = walked.found.length;
      const byPath = new Map(walked.issues.map((i) => [i.path, i]));
      const all = [...new Set([...walked.found, ...walked.issues.map((i) => i.path)])].sort();
      // Partial clones, among the repos that read fine: `git config` per repo (read-only, no network),
      // bounded as a whole so a wedged git cannot hold doctor — a repo not reached gets no note.
      // ⚠ ONE DEADLINE, SHARED WITH THE WORKERS (round-2 harden): a race alone only stopped AWAITING the
      // scan, and every worker went on taking queued repos — each a `git config` spawn — after doctor
      // had returned. Once the timer fires no probe STARTS; one already in flight is bounded by
      // `isPartialClone`'s own per-call timeout (2 s, then SIGKILL — src/git.ts `runGit`).
      const partial = new Set<string>();
      const okPaths = all.filter((p) => !byPath.has(p));
      const probe = deps.partialClone ?? isPartialClone;
      let pastDeadline = false;
      const deadlineHit = new Promise<void>((r) => {
        setTimeout(() => { pastDeadline = true; r(); }, deps.partialCloneMs ?? DOCTOR_PARTIAL_CLONE_MS).unref?.();
      });
      // ⚠ A PROBE THAT THROWS OR REJECTS IS A "NO" (round-3 harden A3-L1). `isPartialClone` fails open
      // on everything itself; this catch is per probe as well, so no failure — an injected probe, or a
      // future one — leaves this pass. Before it, an early rejection won the race below and doctor threw.
      // (A late one was always handled: `Promise.race` attaches a handler to `probing`.) It is a note,
      // never a reason for doctor not to answer.
      const probing = mapLimit(okPaths, REPO_SCAN_CONCURRENCY, async (p) => {
        if (pastDeadline) return;
        let yes = false;
        try { yes = await probe(p); } catch { /* fail open: no note */ }
        if (yes) partial.add(p);
      });
      await Promise.race([probing, deadlineHit]);
      pastDeadline = true;   // either way the pass is over: nothing starts once doctor stops listening
      repos = all.map((p) => {
        const issue = byPath.get(p);
        return {
          path: p,
          ok: !issue,
          issueKind: issue?.kind ?? null,
          advice: issue ? warnFor(issue) : null,
          ...(partial.has(p) ? { partialClone: true as const, notes: [PARTIAL_CLONE_NOTE] } : {}),
        };
      });
    }
  }

  // ── provider ────────────────────────────────────────────────────────────────────────────────────
  const cli = cfg?.provider?.cli ?? "";
  const apiCfg = cfg?.provider?.api;
  const which = deps.which ?? whichOnPath;
  // A3-D: the CLI probe is SKIPPED for an API config. `which("anthropic-api")` would answer "not
  // found" for a label that was never meant to be a binary, and `found: false` drives the verdict to
  // `blocked` — so the probe is not merely uninformative here, it is actively wrong.
  const resolved = cli && apiCfg === undefined ? await which(cli).catch(() => undefined) : undefined;
  // A configured ABSOLUTE path that `which` cannot answer for is still findable — check it directly
  // rather than reporting "not found" for a perfectly good `/opt/homebrew/bin/claude`.
  const absExists = !resolved && cli && apiCfg === undefined && isAbsolute(cli) ? await Bun.file(cli).exists().catch(() => false) : false;
  const providerPath = resolved ?? (absExists ? cli : null);
  // `found` means "the transport this config selects can be reached". For an API provider there is no
  // binary to find, and the reachability question is answered by the `network` block below instead.
  const found = apiCfg !== undefined ? true : providerPath !== null;

  const flags: string[] = [];
  const anomalies: string[] = [];
  // Facts that are NOT faults — see the field's comment. Nothing here touches the verdict.
  const notes: string[] = [];
  const hardeningAvailable = apiCfg === undefined && found && claudeShaped(cli) && cfg?.provider?.harden !== false;
  let apiReport: NonNullable<DoctorReport["provider"]["api"]> | undefined;
  if (apiCfg !== undefined) {
    const endpoint = endpointUrl(apiCfg);
    // ⚠ `skipCommand` — DOCTOR MUST NOT SPAWN. main.ts introduces the doctor/status/schedule block as
    // "the read-only JSON surfaces", and an unqualified `resolveApiKey` made that false for an api
    // config: it executed the user's configured keychain helper, which can block for its whole 5 s
    // ceiling or raise an authorization dialog on an unattended `daily-briefing doctor --json`.
    const key = await resolveApiKey(apiCfg, process.env, { skipCommand: true });
    apiReport = {
      kind: apiCfg.kind,
      model: apiCfg.model,
      // origin + pathname ONLY — the query can carry a credential. See the field's comment.
      baseUrl: endpoint ? printableEndpoint(endpoint) : null,
      ...(endpoint && endpointHasWithheldParts(endpoint) ? { baseUrlQueryWithheld: true } : {}),
      // Status only. See the type's comment: no value, no prefix, no length.
      keySource: {
        source: key.source,
        found: key.executed === false ? null : key.key !== undefined,
        detail: key.detail ?? null,
        ...(key.executed === false ? { executed: false as const } : {}),
      },
    };
    // The same honest line the posture column carries, so `doctor` and an EVAL.md row agree about what
    // this run's hardening posture is rather than one of them implying `full`. A NOTE, not an anomaly:
    // it is true of every correct api install, and as an anomaly it made `ready` unreachable for all of
    // them.
    notes.push(`\`${cli}\` is an API provider — there is no CLI process to harden, so no isolation flags are injected`);
    // ⚠ MIRRORS THE TRANSPORT'S OWN RULE rather than restating it loosely: a LOOPBACK
    // openai-compatible endpoint (Ollama, LM Studio, a local vLLM) needs no key at all, and
    // `OpenAiCompatibleProvider` only refuses a missing key for a non-loopback host. Reporting an
    // anomaly here for a correct local setup would make `doctor` disagree with the run it describes —
    // and it would read as a fault the user has to fix. Caught by test/api-surfaces.test.ts, not by
    // reading.
    const keyOptional = apiCfg.kind === "openai-compatible" && endpoint !== undefined && isLoopbackHost(endpoint.hostname);
    // ⚠ `key.executed === false` is NOT "no key". Rung 3 was deliberately not run (see `skipCommand`
    // above), so claiming the run would fail permanently would be a diagnosis of something never tested.
    if (key.key === undefined && key.executed !== false && !keyOptional) anomalies.push("no API key resolved from provider.api's configured sources — the run would fail permanently");
    if (key.executed === false) notes.push(`provider.api.apiKeyCommand (\`${key.detail}\`) is configured; \`doctor\` does not run it — this check is read-only, so the key's availability is unverified here`);
    if (endpoint === undefined) anomalies.push("provider.api.baseUrl is missing or unparseable, so the endpoint could not be determined");
    else if (endpoint.protocol === "http:" && !isLoopbackHost(endpoint.hostname)) {
      // Names the CREDENTIAL, not just the context — the request carries the key in a header, and a
      // non-loopback endpoint is exactly the case that requires one. Same wording decision as the
      // transport's own runtime warning in providers/base.ts.
      anomalies.push(`your API key and the briefing context would be sent in cleartext over plain http to ${endpoint.host} — the key travels unencrypted in a request header`);
    }
  } else if (hardeningAvailable) {
    const caps = await (deps.capabilities ?? probeCapabilities)(providerPath!, WANTED_FLAGS, {});
    if (caps.kind === "ok") flags.push(...[...caps.supported].sort());
    else anomalies.push(caps.reason);
  } else if (found && !claudeShaped(cli)) {
    anomalies.push(`\`${cli}\` is not recognised as the claude CLI, so no isolation flags are injected`);
  } else if (found && cfg?.provider?.harden === false) {
    anomalies.push("provider hardening is DISABLED by config (provider.harden: false)");
  }

  // ── network: ONE probe, never the gate's polling loop (doctor reports, it does not wait for a morning).
  // A3-D/T9: the SAME derivation the run uses, so doctor reports the gate the morning would actually
  // apply — a loopback API endpoint shows `enabled: false` rather than two unreachable anycast hosts.
  const { hosts } = resolveProbeHosts(
    cfg?.networkProbeHosts,
    (apiCfg !== undefined ? deriveProbeHosts(apiCfg) : undefined) ?? DEFAULT_NETWORK_PROBE_HOSTS,
  );
  const enabled = hosts.length > 0;
  const netStart = Date.now();
  // An EMPTY host list is the documented "skip the gate" switch (net.ts:29), so it is reported as
  // DISABLED — not as unreachable, which would read as a fault the user has to fix.
  const reachable = enabled ? await (deps.netProbe ?? defaultNetProbe(hosts))().catch(() => false) : false;
  const waitedMs = enabled ? Date.now() - netStart : 0;

  const fullyAwake = await isFullyAwake(deps.powerPlatform, deps.powerProbe);

  const anyInaccessible = repos.some((r) => r.issueKind !== null && isInaccessible({ path: r.path, kind: r.issueKind }));
  const verdict: DoctorReport["verdict"] =
    !check.valid || !found || anyInaccessible ? "blocked"
    : anomalies.length > 0 || check.warnings.length > 0 || (enabled && !reachable) || !fullyAwake || reposTimedOut ? "degraded"
    : "ready";

  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    engineVersion: pkg.version,
    config: { exists: configExists, valid: check.valid, errors: check.errors, warnings: check.warnings },
    repos,
    discoveredCount,
    reposTimedOut,
    provider: { cli, found, path: providerPath, hardeningAvailable, flags, anomalies, ...(notes.length ? { notes } : {}), ...(apiReport ? { api: apiReport } : {}) },
    network: { hostsConfigured: hosts.length, enabled, reachable, waitedMs },
    power: { fullyAwake },
    verdict,
  };
}
