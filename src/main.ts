#!/usr/bin/env bun
// src/main.ts
// ⚠ The shebang is LOAD-BEARING for `package.json#bin`, not decoration. On POSIX, npm links a bin
// target by symlink and hands execution to the kernel, which reads line 1 — a `bin` pointing at a
// TypeScript file with no shebang installs cleanly and then fails at first invocation, which is the
// worst shape of publish defect (it passes every local gate and breaks only for the consumer).
// Bun/TypeScript both strip a leading shebang, and `bun build --compile` embeds its own, so this is
// inert for every path except the installed-from-npm one it exists for.
import { loadConfig, initConfig, configPath, resolveRecapCampaigns, type InitApiOptions } from "./config";
import { resolveApiKey, keyStatusLine, DEFAULT_KEY_ENV } from "./apiKey";
import { chmod } from "node:fs/promises";
import { assertInitSafeArgv } from "./harden";
import { type RepoProbe } from "./extractor";
import { renderBriefing, stripControl } from "./render";
import { redactCredentials } from "./transcripts/credentials";
import { diagCrash, diagError } from "./diag";
import { checkRanToday, stampToday, stampTick, localDateStr, latestBriefingPath, archivedBriefingPath, markerExists, markerPath, rotateLogIfLarge, readLastRunDate, writeLastSkip, clearLastSkip } from "./marker";
import { warnFor, isInaccessible, type GuardOpts } from "./protectedPath";
import { ProviderError, type Provider } from "./types";
import { parseFloor, isPastFloor } from "./schedule";
import { clearLastLimit } from "./account";
import { runCore, type CoreResult } from "./core";
import { section } from "./generator";
import { TIMEOUT_MS } from "./provider";
import { acquireRunLock } from "./runlock";
import { notify, notifyPayload } from "./notify";
import { autoUpdateCheck, checkForUpdate, type UpdateCheckDeps, type UpdateCheckResult } from "./updateCheck";
import {
  envelopeFrom, gateEnvelope, redactEnvelope, resolveJsonOutPath, statusReport, doctorReport, validateCandidate,
  type RunEnvelope, type SkipReason,
} from "./json";
import { access, constants as FS_CONSTANTS } from "node:fs/promises";
import { dirname } from "node:path";
import pkg from "../package.json"; // single source of truth for --version (bundled by `bun build --compile`)

const { W_OK } = FS_CONSTANTS;

export type RunDeps = {
  provider?: Provider;   // default: hardenedProvider(cfg.provider, …) — which wraps a BYOCliProvider
  guard?: GuardOpts;     // §5.11 classification injection (tests)
  probe?: RepoProbe;     // repo-readability probe (tests)
  retryDelaysMs?: number[];              // transient-provider retry schedule (tests inject short ones)
  sleep?: (ms: number) => Promise<void>; // injectable for tests
  statusNow?: (repo: string) => Promise<string>; // render-time working-tree re-check (tests inject drift)
  netProbe?: () => Promise<boolean>;     // network-reachability probe (tests)
  powerProbe?: (args: string[]) => Promise<{ code: number; out: string }>; // darkwake probe (tests)
  powerPlatform?: NodeJS.Platform;       // darkwake platform (tests) — see core.ts RunDeps for why this must be injectable
  netGraceMs?: number;                   // network-gate bounds (tests inject short ones)
  netPollMs?: number;
  now?: () => Date;                      // injectable clock for the floor gate (tests pin it; production uses real time)
  interactive?: boolean;                 // TTY at the entry point → floor-exempt (dispatch passes isTTY; tests default false for determinism)
  /** Phase E (E11): the automatic update check's seams (`fetch`, `now`, the state-file path). Read ONLY
   *  by `run()`'s post-run call below — never by the pipeline, whose `deps` spread carries it inert. */
  updateCheck?: UpdateCheckDeps;
};

// The pipeline (discover → … → generate → drift) and its helpers — blockedDelivery,
// workingTreeDriftWarnings, PROVIDER_RETRY_DELAYS_MS — live in ./core, ONE implementation shared with
// the eval harness. Re-exported so existing importers (tests) keep their `../src/main` path.
export { blockedDelivery, workingTreeDriftWarnings } from "./core";

// The init-time repo-access preflight now lives in ./preflight — `doctor --json` (src/json.ts) needs
// the same walk, and json.ts is imported by THIS file, so leaving it here closed a module cycle that
// deadlocked the real `doctor` for 20 s. See that file's header for the measurement. Re-exported so
// every existing `import { preflightRepos } from "../src/main"` is untouched.
import { preflightRepos } from "./preflight";
export { preflightRepos };

/** Why `p` could not be written, or `undefined` when it looks writable. NON-DESTRUCTIVE: it asks
 *  `access(2)` for permission and never opens or truncates the target, which is what lets it run at
 *  the TOP of a run — before anything renders — rather than at the write, which is too late to report
 *  (see `emit`). TOCTOU by nature, and that is fine: it is a DIAGNOSTIC, the real write still happens
 *  and still fails open, and the cases it exists to catch (a GUI-supplied path in a directory that is
 *  gone or unwritable) are static for the length of a run. */
async function unwritableReason(p: string): Promise<string | undefined> {
  try { if (await Bun.file(p).exists()) { await access(p, W_OK); return undefined; } }
  catch (e) { return (e as NodeJS.ErrnoException).code ?? String(e); }
  // The target does not exist yet. `Bun.write` CREATES missing parents, so the question is whether the
  // nearest EXISTING ancestor is writable — not whether the immediate parent happens to exist, which
  // would warn about `--json-out sub/env.json` on a path Bun would have made without complaint.
  for (let dir = dirname(p); ; ) {
    try { await access(dir, W_OK); return undefined; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return code ?? String(e);
      const up = dirname(dir);
      if (up === dir) return "ENOENT";     // walked to the root without finding anything
      dir = up;
    }
  }
}

// The net-gate diagnostic line — shell-owned I/O, emitted on the success path AND on a provider
// failure (via the net runCore attaches to the error), so a network-caused failure still shows why.
function emitNetMessage(net: { online: boolean; waitedMs: number } | null | undefined): void {
  if (!net) return;
  const s = Math.round(net.waitedMs / 1000);
  if (!net.online) console.error(`⚠ no network after ~${s}s — calling the provider anyway (forced run)`);
  else if (net.waitedMs > 0) console.error(`waited ~${s}s for the network to come up`);
}

/** The one line a usage-limited tick leaves in briefing.log. Exported and pure so the WORDING is
 *  testable: it was a template literal ending in a hardcoded "no other account is available" until
 *  2026-08-24, when the live failover test printed exactly that on the tick that marked the primary
 *  while the fallback sat unmarked and delivered two minutes later. Nothing could assert a string
 *  built inline at its only call site, so the falsehood shipped through ten review rounds.
 *
 *  The reset is stated ONLY for a parsed one — a probe deadline is a one-hour guess, and calling it a
 *  reset would claim knowledge the system does not have. `exhausted === false` rather than a truthy
 *  test: an absent payload keeps the conservative wording instead of promising a retry that may not come. */
export function limitedSkipMessage(limited: CoreResult["limited"]): string {
  // A PROBE mark does not prove a usage limit. `recordAuthProbe` writes one for a non-limit failure on
  // a fallback (the likeliest cause being a config dir that was never logged into), and a limit whose
  // reset would not parse writes one too — this branch cannot tell them apart. Saying "at its usage
  // limit" for a broken login would be the same false-cause defect one clause to the left, so a probe
  // gets the weaker, always-true wording instead. A parsed reset is the only case that names the cause.
  // `until` is guarded as well as `isProbe`: the exhausted branch reads it from state and falls back to
  // "", so a corrupt account-state.json could otherwise render "at its usage limit until " with nothing.
  const state = limited?.isProbe === false && limited.until
    ? `is at its usage limit until ${limited.until}`
    : "is unavailable";
  const tail = limited?.exhausted === false
    ? "the next tick will use another account"
    : "no other account is available; will retry next interval";
  // The label is arbitrary config text; every other config-derived line in run() is stripped.
  return `skipped: account "${stripControl(limited?.label ?? "?")}" ${state} — ${tail}`;
}

/** The two ADDITIVE output flags (gui-tauri T1). Deliberately a THIRD parameter rather than fields on
 *  `RunDeps`: that bag is injected test seams, and a real user-facing flag living there would read as
 *  one. Both are `run`-only — `dispatch` refuses them on `init`.
 *
 *  ⚠ `json` REPLACES stdout; `jsonOut` leaves stdout byte-identical and writes the envelope to a file.
 *  The split is forced by a measured coupling, not taste: the launchd plist points StandardOutPath at
 *  `briefing.log`, and `audit.lastBriefing` (audit.ts:218) slices from the last `☀️ … briefing —`
 *  header to EOF as the text it grades. A scheduled run that captured structure on stdout would leave
 *  briefing.log with no briefing in it, and every app-delivered day would vanish from the self-audit
 *  corpus. So the scheduled path keeps markdown on stdout and takes its structure via `jsonOut`. */
export type RunOutput = {
  json?: boolean;
  jsonOut?: string;
};

/** One `daily-briefing run`: the briefing (`runBriefing`, below), THEN — Phase E (E11) — the
 *  opt-in automatic update check.
 *
 *  ⚠ THE CHECK RUNS AFTER `runBriefing` HAS RETURNED, and that ordering is the whole design (plan §5
 *  decision 5). By then every write the run makes has happened — the briefing file, the dated archive,
 *  the day marker, the envelope on stdout and in the `--json-out` sidecar — and the run lock is
 *  RELEASED (`runBriefing`'s `finally`), so delivery never waits on the network and a GUI "Run now" is
 *  never refused as `concurrent` while a check is in flight. The exit code is decided before the check
 *  starts and returned unchanged.
 *
 *  ⚠ ONLY RIGHT AFTER A DELIVERED BRIEFING (user-directed, 2026-10-01, Phase E M5b — it reverses M4's
 *  "after ANY scheduled tick", gate skips included). The signal is the envelope's own `delivered`
 *  field (`RunEnvelope.delivered`, computed by `envelopeFrom` in src/json.ts: exit 0 AND neither
 *  blocked nor offline-skipped), carried out of `runBriefing` by `emit` — the one function every
 *  non-throwing return passes through — so the gate reads the SAME fact the run reports rather than a
 *  second derivation of it. It is true on exactly one return: the last one, after `stampToday`
 *  succeeded. Every gate skip (already ran, below the floor, no config, a concurrent run), an
 *  offline/darkwake/limited skip, a blocked or parse-empty run, a failed marker write, a provider
 *  failure and a crash leave it false. Exit code 0 is NOT the signal: most of those skips exit 0 too.
 *
 *  ⚠ AND ONLY ON A NON-TTY, NON-`--json` RUN — the launchd/systemd tick. A human at a terminal and the
 *  desktop app's `run --json` never run it, so neither ever waits on it. `--json-out` alone does not
 *  exempt a run: the scheduled path writes no envelope to stdout, and the check writes nothing to it.
 *
 *  ⚠ IT REACHES NO CHANNEL THE RUN REPORTS: no stdout/stderr byte, nothing in `struct.warnings`,
 *  `runtimeWarnings` or the envelope's `warnings` — its one output is `<state>/update-check.json`
 *  (src/updateCheck.ts). `test/update-check.test.ts` pins that byte-for-byte against a disabled run.
 *  A run that THROWS (a crash) rethrows before reaching it, unchanged. */
export async function run(force: boolean, deps: RunDeps = {}, out: RunOutput = {}): Promise<number> {
  const { code, delivered } = await runBriefing(force, deps, out);
  if (delivered && !(deps.interactive ?? false) && !out.json) {
    // `.catch` on top of autoUpdateCheck's own total try/catch — the notify()-call rule above: a
    // feature whose failure mode would be "the run reported something it should not" gets both.
    await autoUpdateCheck(deps.updateCheck).catch(() => {});
  }
  return code;
}

/** What `runBriefing` hands back to `run()`: the exit code, and the `delivered` field of the envelope
 *  it emitted — the post-run update check's gate (see `run`). */
type BriefingOutcome = { code: number; delivered: boolean };

async function runBriefing(force: boolean, deps: RunDeps, out: RunOutput): Promise<BriefingOutcome> {
  // ⚠ FIRST LINE OF THE FUNCTION, ahead of the log rotation and the tick heartbeat, because the
  // contract for the shape guard is "throws BEFORE any write" — and `stampTick` is a write. It is
  // pure, so hoisting it costs nothing. `dispatch` guards too (turning the throw into exit 2); this
  // call is what protects the exported `run()` that tests and future callers drive directly.
  const jsonOutPath = out.jsonOut === undefined ? undefined : resolveJsonOutPath(out.jsonOut);
  // Bound the launchd stdout log before anything writes to it this tick (it appends every ~10-min
  // run and never rotates). No-op when absent (interactive/non-launchd) or small; never fatal.
  await rotateLogIfLarge().catch(() => {});
  const now = deps.now?.() ?? new Date();  // injectable clock; only the floor gate needs determinism
  // TICK HEARTBEAT — BEFORE every gate below, deliberately. The three gates that follow (once-per-day,
  // no-config, morning floor) all `return 0` SILENTLY and write nothing, so without this a tick that
  // fired is indistinguishable from a tick that never happened — the exact ambiguity that left day
  // 34's 110-minute first-wake gap undiagnosable. Diagnostic only; never fatal (stampTick swallows).
  // ⚠ The two arguments are DIFFERENT UNITS on purpose — a UTC instant and the LOCAL day it belongs
  // to — and the day-35 defect was born here by keying the count off the first. stampTick keys off
  // the second and stores it explicitly; do not "tidy" these into one value. See its docstring.
  await stampTick(now.toISOString(), localDateStr(now));
  const localDate = localDateStr(now);

  // ── the machine-readable surfaces (T1), set up BEFORE any gate so that every return below — not
  // just the delivering one — can emit an envelope. A GUI that only learned about successful runs
  // would have nothing to show on the mornings that matter.
  // ⚠ THE SIDECAR'S WRITABILITY IS DECIDED HERE, BEFORE ANYTHING RENDERS — see `emit` below for why
  // the obvious place (the write's own `.catch`) is the wrong one. Non-destructive by construction:
  // it asks the filesystem for permission, it does not open or truncate the target.
  const jsonOutProblem = jsonOutPath === undefined ? undefined : await unwritableReason(jsonOutPath);
  if (jsonOutProblem !== undefined) {
    console.error(stripControl(`⚠ --json-out ${jsonOutPath} is not writable (${jsonOutProblem}) — the envelope will not be saved; the briefing itself is unaffected`));
  }
  /** Set at the one `console.log(rendered)` below. Read by `emit` — see its comment. */
  let renderedToStdout = false;
  // ⚠ RETURNS `env.delivered` BESIDE THE EXIT CODE (Phase E M5b): every non-throwing return of this
  // function is `return emit(…)` or `return skip(…)` (which ends in `emit`), so this is the one place
  // `run()`'s update-check gate can read what the run actually reported — see `run`.
  const emit = async (env: RunEnvelope): Promise<BriefingOutcome> => {
    // ── E1: THE ENVELOPE'S CREDENTIAL REDACTION — once, here, BEFORE the split between stdout and the
    // `--json-out` file, so both channels serialise the SAME redacted line and cannot disagree. Every
    // envelope — `envelopeFrom` AND `gateEnvelope` — reaches the process boundary only through `emit`.
    // `markdown` is already redacted (`rendered`, below) and is left byte-identical to stdout; `struct`,
    // `warnings` and `discIssues` carry git-, provider- and fs-derived text (see `redactEnvelope`).
    // ⚠ OUTPUT-SIDE ONLY: `r.struct` itself is never redacted, so nothing downstream of the pipeline —
    // and nothing in the eval harness, which never builds an envelope — sees a redacted struct.
    const line = JSON.stringify(redactEnvelope(env));
    if (out.json) console.log(line);
    if (jsonOutPath !== undefined) {
      // A new failure mode belonging to a new flag: reported, but it must NOT move the exit code —
      // whether the briefing was delivered is not a fact about whether its sidecar file landed.
      //
      // ⚠ AND IT MUST NOT BE REPORTED HERE ON A DELIVERED RUN. `emit` runs LAST on the delivering
      // path — after `console.log(rendered)` — and the launchd plist points StandardOutPath AND
      // StandardErrorPath at the same briefing.log, where `audit.lastBriefing` slices from the last
      // "☀️ … briefing —" header to EOF. Measured: a failing sidecar write put
      // "could not write --json-out …: EACCES" inside that slice, i.e. fed the audit judge a line of
      // our own diagnostics as part of the briefing text it grades — in the one flag whose entire
      // justification (RunOutput's docstring) is keeping briefing.log a valid audit corpus.
      // So the diagnosis is hoisted to `unwritableReason` above, which runs before any render, and
      // this catch stays SILENT once the briefing is on stdout. That leaves ONE residual: a target
      // writable at the top of the run and not by the end (a disk that filled mid-generation) goes
      // unreported on a delivered, non-`--json` run. Stated rather than hidden, and it is the right
      // side of the trade — the alternative is corrupting the corpus every time it happens. Every
      // other shape still reports: `--json` substitutes stdout so nothing is rendered there, and
      // every non-delivering return reaches `emit` before any render.
      await Bun.write(jsonOutPath, `${line}\n`).catch((e) => {
        if (!renderedToStdout) console.error(stripControl(`could not write --json-out ${jsonOutPath}: ${e}`));
      });
    }
    return { code: env.exitCode, delivered: env.delivered };
  };
  /** Record WHY this tick delivered nothing, then emit + return. Fail-open at every step: a
   *  diagnostic must never be the reason a morning is lost (same rule as `stampTick` above).
   *
   *  `net` is threaded through for the ONE gate return that has one — the provider failure, which
   *  prints `emitNetMessage(err.net)` to stderr a line earlier. Without it the envelope for the most
   *  operationally interesting failure was strictly poorer than the stderr beside it. */
  const skip = async (
    reason: SkipReason, exitCode: number, detail?: string,
    net?: { online: boolean; waitedMs: number } | null,
  ): Promise<BriefingOutcome> => {
    await writeLastSkip({ iso: now.toISOString(), localDate, reason, ...(detail ? { detail } : {}) })
      .catch(() => {});
    return emit(gateEnvelope({ exitCode, runDate: localDate, skipReason: reason, net: net ?? null }));
  };

  const interactive = deps.interactive ?? false; // set by dispatch from isTTY; tests default false
  // CHECKED unconditionally, OBEYED only when not forced. The check repairs an unreadable marker, and
  // a forced run needs that repair too: it skips the guard but still stamps at the end, so it would
  // otherwise hit the same EACCES one line from the finish and report "not marking today done".
  const marker = await checkRanToday();
  // Reported here, never inside marker.ts — run() owns all I/O. Not gated on `interactive`, unlike the
  // line below: a repaired marker is exactly the kind of event that must survive in briefing.log for
  // the launchd runs nobody watches.
  if (marker.repair === "rewritten") {
    console.error("day marker was unreadable; today's briefing is already archived, so the marker was rebuilt — skipping this tick");
  } else if (marker.repair === "cleared") {
    console.error("day marker was unreadable and today has no archived briefing; the marker was cleared and this tick will generate one");
  } else if (marker.repair === "failed") {
    console.error(stripControl(`day marker at ${markerPath()} is unreadable AND could not be replaced — the state directory itself may be broken. Claiming the day rather than regenerating every ~10 minutes; fix its permissions to resume briefings.`));
  }
  if (!force && marker.ranToday) {
    if (interactive) console.error("Already ran today. Use --force to regenerate."); // not silent for a human
    return skip("already-ran", 0); // once-per-morning guard
  }
  let cfg;
  try { cfg = await loadConfig(); }
  catch (e) {
    const noConfig = e instanceof Error && e.message === "no-config";
    if (noConfig && !force) {
      // Scheduled tick on a config-less machine: a FRESH install (no marker EVER) stays silent — no
      // per-tick spam before `init`. A config that VANISHED after working (a marker exists) is a
      // regression → surface it (repeats every ~10 min until fixed; accepted: visibility > silence).
      if (await markerExists()) console.error(`No config, but a briefing ran before — did the config move/get deleted? Re-create it: \`daily-briefing init\` (${configPath()}).`);
      return skip("no-config", 0);
    }
    // A forced run, OR any non-"no-config" load error (malformed JSON, perms) is a real error →
    // surface it and exit 2 (today's behavior), regardless of force. NOT silenced.
    if (noConfig) console.error(`No config. Run \`daily-briefing init\` (writes ${configPath()}).`);
    // `diagError`, not a bare console.error: the message can quote the config's own text (a Bun JSON
    // parse error echoes the offending token; a validator error quotes the value it rejected), and
    // fd 2 is briefing.log under launchd. `skip`'s detail below is redacted by `writeLastSkip`.
    else diagError(`Config error: ${e}`);
    return skip(noConfig ? "no-config" : "config-error", 2, String(e));
  }

  // Morning floor: gates only the SCHEDULED (non-interactive) agent — below it a scheduled tick no-ops
  // silently (no per-tick log spam; git state is identical whenever we generate). An interactive run (a
  // human at the terminal) or --force is floor-exempt: they explicitly asked for the briefing now.
  const floor = parseFloor(cfg.morningTime);
  if (!force && !interactive && !isPastFloor(now, floor.minutes)) return skip("below-floor", 0);

  // ── THE RUN LOCK (backlog IN-5). It closes the check-then-act race between `checkRanToday` above
  // and `stampToday` below: today that window is nearly unreachable (only the 600 s launchd tick
  // invokes the pipeline), but a GUI "run now" firing mid-tick makes it reachable, and the result is
  // two provider calls and two deliveries for one day.
  //
  // ⚠ IT SITS BESIDE THE MARKER AND CHANGES NO GATE. Every gate above ran in its original order with
  // its original messages; the lock is taken here, after them, so the configured `provider.timeoutMs`
  // is available to bound staleness — and a fresh, live holder is the ONLY thing that stops a run.
  // See runlock.ts for why every other condition fails OPEN.
  //
  // ⚠ AND THE MARKER IS RE-READ UNDER IT, which is the half that actually closes the race: the lock
  // alone only serialises, so a second run that arrives one instant after the first STAMPED would
  // still generate. The re-read uses `readLastRunDate` — a total, non-repairing read (marker.ts:163)
  // — deliberately NOT `checkRanToday`, whose repair path must keep running exactly once, where it
  // already does.
  // `invoker` is DERIVED, not a flag. Slice 4's `--invoker app|cli` is a property of
  // `schedule install`, and inventing a second spelling of it here would give the two room to drift
  // before either has a user.
  //
  // ⚠ TIER B (spec §4.8/§4.9): the staleness bound widens by B's phase bound ONLY when the mode resolves
  // to `trial`/`on`. Spec §4.8 gives the resolver exactly two call sites on this same input — here and
  // `runCore`, which gates the phase with it — so the two cannot disagree. A malformed key resolves to
  // `off`, so a typo can never widen the lock; its warning is §4.8's to push onto the page from
  // `runCore`, and this site discards it.
  const recapMode = resolveRecapCampaigns(cfg.recapCampaigns).mode;
  const lock = await acquireRunLock({
    invoker: interactive ? "cli" : "scheduled",
    timeoutMs: cfg.provider.timeoutMs ?? TIMEOUT_MS,
    recapCampaigns: recapMode !== "off",
  });
  if (!lock.acquired) {
    console.error(`skipped: another daily-briefing run is already in progress (pid ${lock.holder.pid}, started ${lock.holder.startedIso}) — will retry next interval`);
    return skip("concurrent", 0, `held by pid ${lock.holder.pid} (${lock.holder.invoker}) since ${lock.holder.startedIso}`);
  }
  // ⚠ ONE `try` spanning the whole remainder of run(), so the `finally` below releases on EVERY exit
  // path — the nine `return`s, a rethrown non-ProviderError, anything unforeseen. A lock that
  // outlives its process is the one way this mechanism could cost a morning.
  // The body is left at its original indentation so this change reads as a wrapper rather than as a
  // rewrite of the pipeline shell.
  try {
  // ⚠ `localDateStr(new Date())` — the REAL clock, NOT `localDate` (which comes from the injected
  // `deps.now`). It has to match `checkRanToday`'s own comparison (marker.ts:203) exactly, or this
  // would answer a different question than the gate it is backing up.
  //
  // ⚠ UNREACHABLE IN A SINGLE-PROCESS TEST, and that is a property of the race rather than an
  // omission: gate 1 and this read compare the same file against the same date, so on a static
  // filesystem they always agree. Only a stamp landing BETWEEN them — i.e. another process
  // delivering while this one sat in `loadConfig` — separates the two, which is precisely the
  // check-then-act window IN-5 names. Kept and documented rather than dropped, on the same reasoning
  // posture.test.ts gives for pinning its unreachable mixed state: a guard's contract should not
  // depend on how narrow today's window happens to be.
  if (!force && (await readLastRunDate()) === localDateStr(new Date())) {
    if (interactive) console.error("Already ran today. Use --force to regenerate.");
    return skip("already-ran", 0, "another run stamped the day while this one was starting");
  }

  // The whole pipeline (discover → extract → resolve → today/mergedToday → reduce → net-gate →
  // generate → drift) lives in runCore() — ONE implementation, shared with the eval harness. run() is
  // the thin shell: it owns the gates above and the render/stamp/exit + all stderr I/O below. The
  // floor warning is shell-owned config, so it's threaded in via preWarnings.
  // Tier B (spec §4.10 1, Appendix D8): `recapInvocation` feeds B's record — `invoker` is the same
  // derivation the lock above records, `json` whether this run is `run --json`. `main.ts` passes no
  // `grouper` and no `persistRecapRecord`, so production always takes `runCore`'s fallbacks.
  let r;
  try {
    r = await runCore(cfg, {
      ...deps, preWarnings: floor.warning ? [floor.warning] : [],
      recapInvocation: { invoker: interactive ? "cli" : "scheduled", json: !!out.json },
    }, force);
  } catch (e) {
    // Surface the pre-provider diagnostics runCore attached (pipeline warnings + net-gate outcome)
    // even though the pipeline failed — old inline run() printed them BEFORE the provider, so a
    // network-caused failure still shows the reason. Order matches old: warnings → net → the error.
    const err = e as ProviderError; // .warnings/.net attached by runCore for any Error
    // stripControl on every terminal line that can carry git/fs-derived text (repo paths, a provider
    // CLI's stderr): the same terminal-escape-injection class the render boundary closes (a repo path
    // or filename can legally contain ANSI/control bytes) reaches the terminal here too.
    for (const w of err.warnings ?? []) diagError(stripControl(`⚠ ${w}`));
    emitNetMessage(err.net);
    if (e instanceof ProviderError) {
      // ⚠ `diagError`: `e.message` is up to 600 characters of the CLI's OWN stdout+stderr (provider.ts
      // builds `diag` from both streams), so an auth failure that echoes the key back arrives here
      // verbatim. stripControl stays — control bytes and credential shapes are different classes.
      diagError(stripControl(`Briefing provider failed (${e.code}): ${e.message}`));
      // `err.net` is threaded so the envelope carries what the stderr line above already said: this
      // is the most operationally interesting failure, and "the provider failed" without "and the
      // network was down for 25s" is the half of it a GUI cannot reconstruct.
      return await skip("provider-fail", 1, `${e.code}: ${e.message}`, err.net);
    }
    // ⚠ EMIT BEFORE RETHROWING. Every other return in run() leaves a record; this one used to leave
    // NEITHER a last-skip entry NOR an envelope, so a crash was indistinguishable from "the scheduler
    // never ran" — the exact question `marker.ts`'s LastSkip docstring says the file exists to answer
    // — and a `--json-out` consumer polling the sidecar read the PREVIOUS run's envelope as today's
    // outcome. Fail-open like every other diagnostic here: it cannot change the crash exit, because
    // the rethrow below is untouched and `skip` swallows its own failures.
    await skip("crashed", 1, e instanceof Error ? `${e.name}: ${e.message}` : String(e), err.net)
      .catch(() => {});
    throw e; // non-ProviderError: diagnostics surfaced; rethrow to preserve the crash exit
  }

  // Surface every protected-path/read + pipeline issue (§5.11): discovery-side issues have no warning
  // string of their own, so format them here; the rest are already strings in r.warnings. Whenever
  // runCore built a discovery summary (v0.2.1 §2.4.2: an empty-window or blocked run, or — r8 — a
  // provider run whose window has no commits), r.warnings ends with it, so it prints AFTER every
  // per-folder line it summarises — nothing here is deduplicated.
  for (const w of [...r.discIssues.map(warnFor), ...r.warnings]) diagError(stripControl(`⚠ ${w}`));

  // Empty run + an inaccessible repo we tried to read = delivery FAILURE, not a quiet day (§5.11):
  // don't stamp, exit non-zero so the next run retries once access is fixed. Since v0.2.1 (§2.4.5) also
  // when discovery found no repos and a configured search folder itself could not be read or was
  // missing (`r.discoveryBlocked`) — a forced run included, so `--force` cannot stamp that day either.
  if (r.blocked) {
    console.error(r.discoveryBlocked
      ? "No repositories were found, and a folder listed in Folders to search could not be read or found — today NOT marked done. Fix access (see warnings above) and re-run."
      : "Some configured repo(s) could not be read and no other activity was found — today NOT marked done. Fix access (see warnings above) and re-run.");
    // The summary is the skip detail whenever one exists — discovery-blocked, or extraction-blocked
    // beside a counted discovery issue — so Today and Schedule can say WHICH folder. A blocked run with
    // no counted issue keeps the old record, no detail. `writeLastSkip` redacts `detail` at the file.
    await writeLastSkip({
      iso: now.toISOString(), localDate, reason: "blocked",
      ...(r.discoverySummary !== undefined ? { detail: r.discoverySummary } : {}),
    }).catch(() => {});
    return await emit(envelopeFrom(r, "", 1));
  }
  // Scheduled tick still offline after the grace: the provider was NOT called — skip without stamping;
  // the ~10-min interval loop retries. (A forced offline run proceeds; see the net message just below.)
  if (r.offlineSkipped) {
    // Distinct line per reason: the remedy differs, and an undistinguished failure block was
    // misdiagnosed twice on 2026-08-08 before `pmset` settled it.
    // THREE ways, not two. A limited tick reusing the offline branch would print "skipped: no network
    // after ~0s" every 600s for the length of the outage — a false diagnosis, which is precisely the
    // class of failure this feature exists to end.
    // The reset time is printed ONLY when it was parsed from the message: a probe deadline is a
    // one-hour guess, and stating it as a reset would claim knowledge the system does not have.
    // ⚠ The second half is `exhausted`, COMPUTED in runCore — not a fixed phrase. It was a hardcoded
    // "no other account is available" until 2026-08-24, when the live failover test printed it on the
    // tick that marked the primary while the fallback sat unmarked and delivered two minutes later.
    // This is the ONLY line a limited tick leaves in briefing.log, so a false one misleads precisely
    // when someone is reading the log to diagnose an outage. `=== false` rather than a truthy test:
    // an absent `limited` keeps the conservative wording instead of promising a retry that may not come.
    // ⚠ `diagError` for the `limited` arm: `limitedSkipMessage` is built from `r.limited`, which is
    // PARSED OUT OF the provider's own rejection line (provider.ts's `limitMatch`), so it carries
    // provider text. The other two arms are engine-authored and have nothing to redact.
    diagError(r.skipReason === "darkwake"
      ? "skipped: machine is in a maintenance darkwake (no display power) — the provider cannot complete here; will retry next interval"
      : r.skipReason === "limited"
      ? limitedSkipMessage(r.limited)
      : `skipped: no network after ~${Math.round((r.net?.waitedMs ?? 0) / 1000)}s — will retry next interval`);
    // `r.skipReason` is already one of offline/darkwake/limited — the closed SKIP_REASONS vocabulary
    // is a superset of the pipeline's own, so no translation table is needed here (and cannot drift).
    await writeLastSkip({
      iso: now.toISOString(), localDate,
      reason: r.skipReason ?? "offline",
      ...(r.limited ? { detail: limitedSkipMessage(r.limited) } : {}),
    }).catch(() => {});
    return await emit(envelopeFrom(r, "", 0));
  }
  // Net-gate message (null net = empty/blocked, no gate). !online here implies a forced run proceeded.
  emitNetMessage(r.net);

  // Provenance BEFORE the rendered briefing, deliberately. The launchd plist points StandardOutPath and
  // StandardErrorPath at the SAME briefing.log, and audit's lastBriefing() slices from the last "☀️ …
  // briefing —" header to EOF — so a line emitted after the render would be fed to the audit judge as
  // part of the briefing text it grades. Anything before the header is outside that slice.
  // Absent on a single-account machine (see CoreResult.account), so existing logs are unchanged.
  if (r.account) console.error(`briefing generated by account "${stripControl(r.account)}"`);

  // ── T8.1: OUTPUT-SIDE credential scan, sinks 1-3 (stdout, briefing-latest.md, briefing.log).
  //
  // REDACT IN PLACE, never abort: aborting would break the git briefing, which invariant 8 forbids.
  //
  // ⚠ UNCONDITIONAL since 2026-08-25. It was gated on `transcripts.enabled`, on the reasoning that
  // with the feature off "nothing new reaches this string". True of TRANSCRIPT text and irrelevant to
  // the risk: the very next line of that comment said this fires on "a branch name, a commit subject,
  // a provider diagnostic" — all of which are git-derived and all of which survive the feature being
  // off. So the gate removed the scan from exactly the text it was described as protecting, and it did
  // so invisibly: turning transcripts off for unrelated reasons (their attribution rules cannot resolve
  // a multi-session workflow) silently disabled credential redaction. Nothing in the config hinted at
  // the coupling. A security control must not ride on an unrelated feature flag.
  //
  // The false-positive worry the gate existed for is already handled INSIDE the matcher, not here:
  // `provider-key`'s generic `sk-`/`pk-`/`rk-`/`ak-` branch requires a >=20-char UNHYPHENATED run
  // precisely because branch names like `pk-refactor-the-whole-thing` were measured matching a looser
  // tail at C2. Its `sk-ant-` branch (user-directed 2026-10-02) takes hyphens, since a real key's
  // base64url body has them, and keeps slugs out by a 40-character floor instead (credentials.ts).
  //
  // ⚠ It can never fire INSIDE a why, and that is the shared-matcher guarantee, not luck: a turn that
  // passed the ingest scan cannot match output-side because both scans use the SAME pattern module.
  const rendered = redactCredentials(renderBriefing(r.struct));
  // ⚠ THE ONE STDOUT SUBSTITUTION, and the ONLY behavioural difference `--json` makes. Everything
  // above and below — every stderr line, every file written, every exit code — is untouched, and the
  // envelope carries this exact string in its `markdown` field, so the two modes cannot disagree
  // about what the briefing said. `--json-out` does not take this branch at all: its stdout stays
  // byte-identical, which is what keeps briefing.log a valid audit corpus (see RunOutput's docstring).
  if (!out.json) { console.log(rendered); renderedToStdout = true; }

  // Soft-parse failure (only when the window had activity): the model output didn't parse into any
  // section — a broken run, not a quiet day. Don't stamp; the next scheduled run retries.
  if (!r.emptyWindow) {
    // Derived from `rawText`, NOT from `r.struct`, and that distinction is the whole gate.
    // `generateBriefing` backfills a resume bullet for every Tier-1 unit the model omitted
    // (`orderResumeByRank`), and it does so BEFORE this check ever runs — so a briefing truncated to
    // nothing still arrives here with a non-empty `resume` and gets stamped, behind bullets we wrote
    // ourselves. On this machine `hasResumptionState` is true most mornings, so the gate was very
    // nearly decorative. Since C1 the provider may deliberately return a truncated result, which makes
    // "parsed into nothing" reachable rather than theoretical.
    // Reuses the exported `section` rather than re-parsing: no new field, no signature change, and
    // `rawText` is "" on three paths and none of them reach this line: `blocked` and `offlineSkipped`
    // return earlier, and `emptyWindow` — which does NOT return early, it renders and stamps a genuine
    // quiet day — is excluded by the enclosing `if (!r.emptyWindow)`.
    //
    // THE COST, stated because it is a real regression in one scenario. A model that PERSISTENTLY
    // ignores the output format used to yield one stamped, backfill-only briefing per day; it now
    // yields none, and a provider call every ~10-minute tick until midnight. That is the intended
    // trade: a backfill-only briefing carries no recap, no suggestions and nothing the model
    // contributed, so delivering it silently and marking the day done teaches the user nothing while
    // hiding a broken integration indefinitely. Note the asymmetry with the provider's own fail-open —
    // a briefing known to be CUT OFF still stamps, because it carries real model content plus a
    // warning saying so.
    const parsedEmpty = ["RESUME", "RECAP", "SUGGESTIONS"].every((h) => section(r.rawText, h).length === 0);
    if (parsedEmpty) {
      console.error("Briefing did not parse into any section; not marking today done.");
      await writeLastSkip({ iso: now.toISOString(), localDate, reason: "parse-empty" }).catch(() => {});
      return await emit(envelopeFrom(r, rendered, 1, "parse-empty"));
    }
  }
  // The outage record is cleared once a briefing has actually been WRITTEN — not merely rendered.
  // `parsedEmpty` returns 1 between renderBriefing and here, and clearing there would destroy the cause
  // record without delivering anything: the cause IS the trigger, so the outage could then never be
  // reported. Unconditional on delivery, NOT gated on "a line was rendered" — on the ordinary failover
  // day missedDays is 0 and no line is due, and gating would leave the record alive to blame a later
  // laptop-closed weekend on the usage limit.
  await clearLastLimit().catch(() => {});
  await Bun.write(latestBriefingPath(), rendered).catch(() => {}); // clean overwritten copy the user/audit read
  // Dated archive alongside it — see archivedBriefingPath for why. Same fail-open `.catch` as the line
  // above (which now also swallows the date-shape throw): an archive that could not be written must
  // never cost the user their briefing, and the marker below is what decides delivery. One file per
  // DAY — a same-day regeneration replaces it, exactly as it replaces briefing-latest.md above.
  await Bun.write(archivedBriefingPath(r.runDate), rendered).catch(() => {});
  try { await stampToday(r.runDate); } // fail-closed: only on a successful delivery (incl. a genuine quiet day)
  catch (e) {
    console.error(stripControl(`could not write the day marker: ${e} — not marking today done`));
    await writeLastSkip({ iso: now.toISOString(), localDate, reason: "marker-fail", detail: String(e) }).catch(() => {});
    return await emit(envelopeFrom(r, rendered, 1, "marker-fail"));
  }
  // ── T7: the optional desktop notification.
  //
  // ⚠ STRICTLY AFTER `stampToday`, and that ordering is the whole safety argument. Every branch above
  // can still lose the day; from here on the day is DONE, so a notifier that hangs, crashes or does
  // not exist costs exactly nothing. Placing it one line earlier would let an absent `notify-send`
  // decide whether a briefing counted.
  //
  // ⚠ `.catch(() => {})` ON TOP of notify()'s own total try/catch — defence in depth for a call whose
  // failure mode is "the morning was delivered and then thrown away".
  //
  // ⚠ IT PRINTS NOTHING, EVER. StandardOut and StandardError both point at briefing.log and
  // `audit.lastBriefing` slices from the last briefing header to EOF, so any byte emitted here would
  // be handed to the audit judge AS BRIEFING TEXT. notify.ts writes to no stream and proc.run pipes
  // the child's; this call adds no logging of its own, on success or failure. Do not add one.
  //
  // ⚠ The BODY is a fixed template built from the run date and the briefing PATH — never briefing
  // text, never a repo-derived string.
  await notify(cfg, notifyPayload(r.runDate, latestBriefingPath())).catch(() => {});
  // ⚠ DELIVERED ⇒ NO SKIP RECORD. Removing it here rather than overwriting it with a "delivered"
  // entry is the contract stated in marker.ts: `last-skip.json` present means the LAST thing that
  // happened was a skip. Leaving yesterday's "offline" behind would make a delivered day read as a
  // failed one in the Schedule panel, which is exactly the mask this file exists to prevent.
  //
  // ⚠ AND IT LASTS ABOUT TEN MINUTES, WHICH IS CORRECT AND MUST NOT BE READ AS A FAULT. The plist
  // runs `run` on StartInterval 600, so the next tick hits the once-per-day gate above and writes
  // `reason: "already-ran"` straight back; every tick until midnight rewrites it. On a HEALTHY day
  // the file is therefore absent for ~10 minutes and present for the remaining ~17 hours.
  // ⚠ SO A CONSUMER MUST SWITCH ON `reason`, NEVER ON PRESENCE. "already-ran" is the steady state
  // AFTER a successful delivery — it means today already succeeded — and a Schedule panel keying
  // "is anything wrong?" off the file EXISTING would show a problem all day on a working machine.
  // Kept as a written skip rather than suppressed: `run-lock.test.ts` pins the gate's record, and the
  // record is what distinguishes "declined, because today is done" from "the scheduler never fired".
  await clearLastSkip().catch(() => {});
  return await emit(envelopeFrom(r, rendered, 0));
  } finally {
    await lock.release();
  }
}

/** Extracted from the old inline init block, WITHOUT its process.exit(0) — dispatch owns the only
 *  process.exit. Returns an exit code: 2 when it REFUSES the config (C1/B7), 0 otherwise. */
/** A3/T10. `--provider anthropic-api|openai-compatible` and its companions, parsed from argv.
 *
 *  Returns `undefined` when `--provider` is absent (the unchanged first-run path), or an error string
 *  the caller turns into exit 2. A REFUSAL rather than a guess when `--model` is missing: the project
 *  deliberately never picks a model on the user's behalf, because a silently-chosen model changes
 *  briefing content without a config change AND starts spending their money from a config they never
 *  read. */
export function parseInitApiFlags(argv: string[]): { api?: InitApiOptions; error?: string } {
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    return v === undefined || v.startsWith("--") ? "" : v;   // "" = present but with no value
  };
  // ⚠ MATCHES BOTH SPELLINGS — `--flag value` AND `--flag=value`. `valueOf` reads only the space form
  // (that is the documented shape and the one `--help` shows), but the REFUSALS below must see the
  // equals form too, or it escapes every check: `init --provider=anthropic-api --model=gpt` parsed as
  // "no --provider, no stray flags", returned `{}`, and silently wrote today's CLI template to a user
  // who believed they had just configured an API provider. Detecting it and refusing is right; quietly
  // accepting a second syntax is not, because only one of the two would then be tested.
  const present = (flag: string): boolean => argv.some((a) => a === flag || a.startsWith(`${flag}=`));
  const provider = valueOf("--provider");
  if (provider === undefined) {
    if (present("--provider")) {
      return { error: "init: --provider takes its value as a separate argument (`--provider anthropic-api`), not `--provider=…`" };
    }
    // The companions are meaningless on their own; accepting them silently would write today's CLI
    // template while the user believed they had configured an API provider.
    const stray = ["--model", "--base-url", "--api-key-env", "--api-key-file", "--api-key-command"].filter(present);
    if (stray.length) return { error: `init: ${stray.join(", ")} ${stray.length === 1 ? "requires" : "require"} --provider anthropic-api|openai-compatible` };
    return {};
  }
  const kind = provider === "anthropic-api" ? "anthropic" : provider === "openai-compatible" ? "openai-compatible" : undefined;
  if (kind === undefined) return { error: `init: --provider must be "anthropic-api" or "openai-compatible" (got ${provider === "" ? "no value" : JSON.stringify(provider)})` };
  const model = valueOf("--model");
  if (model === undefined || model === "") return { error: "init: --provider requires --model <id> — this project deliberately refuses to choose a model for you, because a silently-chosen model changes briefing content without a config change" };
  const baseUrl = valueOf("--base-url");
  if (baseUrl === "") return { error: "init: --base-url requires a URL" };
  if (kind === "openai-compatible" && baseUrl === undefined) return { error: 'init: --provider openai-compatible requires --base-url (e.g. "http://127.0.0.1:11434/v1" for Ollama)' };
  const keyEnv = valueOf("--api-key-env");
  const keyFile = valueOf("--api-key-file");
  const keyCmdRaw = valueOf("--api-key-command");
  for (const [flag, v] of [["--api-key-env", keyEnv], ["--api-key-file", keyFile], ["--api-key-command", keyCmdRaw]] as const) {
    if (v === "") return { error: `init: ${flag} requires a value` };
  }
  // ⚠ THE WHITESPACE SPLIT BELOW IS NOT A SHELL, AND THE TWO WAYS THAT BITES ARE REFUSED HERE RATHER
  // THAN SHIPPED AS A BROKEN CONFIG.
  //   • A QUOTE CHARACTER means the user expected shell quoting — the canonical macOS invocation is
  //     `security find-generic-password -s "my service" -w`, and splitting it produces the argv
  //     ["security","find-generic-password","-s","\"my","service\"","-w"], which spawns and fails every
  //     morning with only `apiKeyCommand (\`security\`) exited N` to show for it. An argument containing
  //     a space cannot be expressed through this flag at all; the config file's array form can, so the
  //     message says so.
  //   • A WHITESPACE-ONLY value splits to `[]`, which `validateProviderApi` then rejects on the very
  //     next load — init would have written a config that cannot be read back.
  let apiKeyCommand: string[] | undefined;
  if (keyCmdRaw !== undefined) {
    if (/["'`]/.test(keyCmdRaw)) {
      return { error: 'init: --api-key-command is split on whitespace and does not interpret quotes — for a command whose arguments contain spaces, set "provider.api.apiKeyCommand" in the config file as an argv array, e.g. ["my-keychain-helper", "--item", "my service", "--field", "password"]' };
    }
    apiKeyCommand = keyCmdRaw.split(/\s+/).filter((s) => s !== "");
    if (apiKeyCommand.length === 0) return { error: "init: --api-key-command requires a command to run" };
  }
  // ⚠ NO `--api-key` FLAG EXISTS, deliberately: a literal secret on a command line lands in shell
  // history and in the process table. The three indirect sources are the whole supported set here;
  // `provider.api.apiKey` remains editable in the file for someone who wants it.
  return {
    api: {
      kind, model,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(keyEnv !== undefined ? { apiKeyEnv: keyEnv } : {}),
      ...(keyFile !== undefined ? { apiKeyFile: keyFile } : {}),
      // An argv ARRAY is what the config stores (never a shell string); the split, and the two refusals
      // that make it safe, are above.
      ...(apiKeyCommand !== undefined ? { apiKeyCommand } : {}),
    },
  };
}

export async function init(deps: { load?: typeof loadConfig; write?: typeof initConfig; api?: InitApiOptions; env?: Record<string, string | undefined> } = {}): Promise<number> {
  const loadFn = deps.load ?? loadConfig;
  // `write` is injectable so a test can exercise init's LOGIC without initConfig's side effects — it
  // walks `homedir()` for repos and spawns `which claude`, which is read-only but can eat a 5s test
  // timeout on slow CI, and is nothing the argv-refusal path is about.
  const writeFn = deps.write ?? initConfig;
  const { path: p, wrote, cliFound } = await writeFn(undefined, deps.api);
  console.log(wrote
    ? `Wrote config template to ${p}. Edit it, then run \`daily-briefing\`.`
    : `Config already exists at ${p}; leaving it alone.`);
  // #13: don't let a missing AI CLI be a silent surprise at the first run — the config defaults to
  // `claude`, so a user with neither claude nor codex on PATH needs to install one (or edit provider.cli).
  // ⚠ Suppressed on the API branch: there is no CLI to be missing, and `initConfig` reports
  // `cliFound: false` there because it never looked.
  if (!cliFound && deps.api === undefined) {
    console.error(stripControl(`\n⚠ No AI CLI found on PATH (looked for claude, codex) — the config uses \`claude\` by default. Install it, or set \`provider.cli\` in ${p}, before running \`daily-briefing\`.`));
    // A3/T10: a SUGGESTION, never a silent write. A conventional key in the environment with no CLI
    // installed is the exact shape of "this person wants the API transport", but auto-writing one would
    // pick a model on their behalf and start spending their money from a config they never read — the
    // same provenance failure the required `model` field exists to prevent. So it names the command and
    // stops. `${ }` is not interpolated for the model on purpose: the user must type one.
    const env = deps.env ?? process.env;
    const present = (["anthropic", "openai-compatible"] as const).find((k) => (env[DEFAULT_KEY_ENV[k]] ?? "").trim() !== "");
    if (present !== undefined) {
      const flag = present === "anthropic" ? "anthropic-api" : "openai-compatible --base-url <url>";
      console.error(stripControl(`  $${DEFAULT_KEY_ENV[present]} is set, though — to use the API transport instead, run:  daily-briefing init --provider ${flag} --model <model-id>   (after deleting ${p})`));
    }
  }
  const loaded = await loadFn();
  // C1/B7: REFUSE a provider.argv that defeats hardening outright — but only here, while the user is
  // present to fix it. This genuinely exits non-zero rather than warning: an earlier version printed a
  // warning and still returned 0, which made the "hard-error at init" claim in the comment, the commit
  // message and a test name all false at once. A tick must still never fail on this — the user cannot act
  // on a briefing they never received — so the daily run warns and delivers.
  // ⚠ SKIPPED ON THE API BRANCH: `assertInitSafeArgv` refuses an argv that defeats flag injection, and
  // an API provider has no argv (the synthesized one is `[]`) and no flags to defeat. Running it would
  // be inert today and a trap the day someone gives it a new rule.
  if (loaded.provider.api === undefined) {
    try {
      assertInitSafeArgv(loaded.provider.argv);
    } catch (e) {
      console.error(stripControl(`\n✖ ${e instanceof Error ? e.message : String(e)}`));
      return 2;
    }
  } else {
    // Report the key STATUS while the user is present to fix it — and return 0 either way, matching the
    // existing `cliFound` precedent: a not-yet-set key warns but does not fail init. Every line here
    // names a SOURCE and never the value.
    const resolved = await resolveApiKey(loaded.provider.api, deps.env ?? process.env);
    for (const w of resolved.warnings) console.error(stripControl(`⚠ ${w}`));
    console.log(keyStatusLine(resolved));
    // Guarded on the file actually being there. In production it always is — `initConfig` returns
    // `wrote: false` only when `Bun.file(path).exists()` was true — but the guard is what keeps the
    // SUCCESS LINE honest: the `catch` below is deliberately silent, so without it a chmod that never
    // happened would still have printed "Set … to mode 600".
    if (loaded.provider.api.apiKey !== undefined && await Bun.file(p).exists()) {
      // The ruling's chmod, applied where it actually bites: the user hand-edited a plaintext key into
      // a file init already created. Tightening OUR OWN config file is the one side effect worth having.
      try { await chmod(p, 0o600); console.log(`Set ${p} to mode 600 (it contains a plaintext key).`); }
      catch { /* best effort — never fail init over a permission tweak */ }
    }
  }
  const issues = await preflightRepos(loaded);
  const blocked = issues.filter(isInaccessible);
  if (blocked.length) {
    console.error(`\n⚠ ${blocked.length} repo(s)/dir(s) could not be read:`);
    for (const i of blocked) console.error(stripControl(`  ${warnFor(i)}`));
    console.error(`\nGrant access (or move the repos out of protected folders) and re-run \`daily-briefing init\` to re-scan.`);
  }
  // Surface typo'd/nonexistent configured paths HERE (while the user is present to fix them) instead of
  // only in the next daily run's warnings — init's whole job is catching config problems up front.
  const notFound = issues.filter((i) => i.kind === "not-found");
  if (notFound.length) {
    console.error(`\n⚠ ${notFound.length} configured path(s) not found (typo, or a relative path?):`);
    for (const i of notFound) console.error(stripControl(`  ${warnFor(i)}`));
  }
  return 0;
}

const VERSION = pkg.version; // from package.json — no hardcoded duplicate to drift

function printUsage(): void {
  console.log(
`daily-briefing — a resumption-focused daily briefing from your local git activity, ready at your first
wake of the day (see morningTime: the floor it will not fire BEFORE, not a delivery time).

Usage:
  daily-briefing [run] [--force]   Generate today's briefing (the default command)
  daily-briefing init              Create/refresh the config (${configPath()})
  daily-briefing status --json     Report engine state (state paths, last run, last tick) — reads only
  daily-briefing doctor --json     Check repos, provider, network and power — never generates
  daily-briefing config validate --json (--file <path>|--stdin)
                                   Validate a CANDIDATE config with the validator the engine uses
  daily-briefing schedule install|uninstall|status|verify
                                   Install/remove the OS trigger that delivers your briefing
  daily-briefing update --check [--json]
                                   Ask GitHub whether a newer release exists — notify-only: it
                                   downloads and installs nothing, and exits 0 whatever it finds

Flags:
  --force, -f      Ignore the morning-time floor and the once-per-day guard
  --json           run: print the machine-readable envelope INSTEAD of the markdown briefing
                   schedule status|verify, update --check: print the report as JSON instead of text
  --json-out <p>   run: write that envelope to <p> and leave stdout exactly as it is
  --help,  -h      Show this help (anywhere on the line — \`run --help\` runs nothing)
  --version, -v    Show the version (anywhere on the line; runs nothing)

init flags (API provider — omit them all for the default CLI provider):
  --provider anthropic-api|openai-compatible
                   Use an API transport instead of spawning a CLI. Requires --model.
  --model <id>     REQUIRED with --provider. This tool never picks a model for you: a silently-chosen
                   model changes briefing content without a config change.
  --base-url <url> The endpoint. Required for openai-compatible (e.g. http://127.0.0.1:11434/v1 for
                   Ollama); optional for anthropic-api, which defaults to the public API.
  --api-key-env NAME | --api-key-file PATH | --api-key-command "cmd --args"
                   Where the key comes from. There is deliberately NO --api-key flag: a literal secret
                   on a command line lands in shell history and in the process table.
                   ⚠ --api-key-command is SPLIT ON WHITESPACE and does NOT interpret quotes. For a
                   helper whose arguments contain spaces, set "provider.api.apiKeyCommand" in the
                   config file as an argv array instead:
                     ["my-keychain-helper", "--item", "my service", "--field", "password"]
  Each flag takes its value as a SEPARATE argument (--model gpt-5), never --model=gpt-5.

schedule flags:
  --invoker app|cli        Which principal owns the trigger (default cli). The desktop app passes
                           \`app\`; \`schedule.json\` records it and a foreign owner is REFUSED (exit 2).
  --take-over              Claim a trigger owned by the other principal instead of refusing.
  --identity <name>        Code-signing identity for the managed macOS copy
                           (or set DBA_SIGN_IDENTITY). Degrades to ad-hoc with a warning.
  --no-verify              Skip the verification kickstart \`schedule install\` runs as its last step.
  --enable-linger          Linux: enable lingering so user timers still fire while you are logged
                           out. \`schedule install\` prints the exact command when it is needed.
  --confirm-experimental   Windows ONLY: actually register the scheduled task. Without it the task
                           XML is written and the exact command PRINTED but not executed, and the
                           install exits 2 (a required confirmation was not given) having written NO
                           schedule record — nothing was registered, so nothing claims to own it. The
                           Windows leg has NO runtime evidence and every surface says so.

\`schedule install\` copies the engine to a managed location under your own data directory and points
the OS trigger at THAT copy — never at the file you downloaded (an AppImage mount path is recreated on
every launch, and a copy is what can be signed). On macOS it also strips the download quarantine from
that copy and re-signs it with a stable local identity, which is what makes the folder-access grant
survive an update.

Exit codes — \`schedule install\`/\`uninstall\`: 0 ours (installed/refreshed/removed), 1 nothing found,
2 a foreign owner holds it OR a required confirmation was refused (see --confirm-experimental),
3 error. \`schedule verify\`: 0 the kick produced evidence that it reached the engine (a delivery, or a
skip the engine wrote), 1 the kick was accepted but produced NO NEW evidence — including the case
where today's briefing had already been delivered BEFORE the kick, which proves nothing about the
trigger — 3 the scheduler refused the kick. \`schedule status\` exits 0; it only reports.

\`update --check\` sends ONE anonymous HTTPS GET to api.github.com for this project's latest release:
this version in the User-Agent, no query string, no account or machine identifier. It always checks
when you run it. Set "updateCheck": { "enabled": true } in the config to let a scheduled run also check
on its own, right after it has delivered that day's briefing (about every "intervalHours", default
24, with an hour's slack) — off unless you turn it on.

The three read-only subcommands exist for the desktop app and for scripting; they require --json
because there is no human-readable form of them yet. None of them generates a briefing or writes
anything to the state directory.

A subcommand must come FIRST: \`daily-briefing status --json\`, never \`daily-briefing --json status\`
— the second is refused rather than silently treated as a full briefing run.
--json-out may not name a file the engine owns (briefing.log, last-run, run.lock, …); a relative
path resolves under the state directory, so give it a distinct name or an absolute path.`);
}

/** Pull `--json-out <path>`'s value out of argv. A MISSING value is an error rather than a silent
 *  no-op: `daily-briefing run --json-out` with nothing after it would otherwise run a full briefing
 *  and write no envelope, which is the H2 class — a flag that quietly falls through to a stateful run. */
function jsonOutArg(argv: string[]): { path?: string; error?: string } {
  const i = argv.indexOf("--json-out");
  if (i === -1) return {};
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("-")) return { error: "--json-out needs a path" };
  return { path: v };
}

/** Every new subcommand is JSON-only for now. Refusing loudly beats inventing a text format nobody
 *  specified, and — the H2 lesson — a subcommand that fell through to the default `run` case because
 *  its flag was missing would generate a briefing and stamp the day. */
function requireJson(cmd: string, argv: string[]): boolean {
  if (argv.includes("--json")) return true;
  console.error(`${cmd}: --json is required (there is no human-readable form of this subcommand yet)`);
  return false;
}

/** Read the CANDIDATE config for `config validate` from `--file <path>` or `--stdin`.
 *
 *  ⚠ A SOURCE IS REQUIRED — there is deliberately no "default to the installed config" fallback. The
 *  whole point of this subcommand is validating a config the Settings screen is ABOUT to write, and a
 *  silent fallback would answer a different question than the one asked (the installed config's
 *  validity is what `doctor --json` reports). It also made the command's answer depend on $HOME,
 *  which a validator of a candidate has no business doing.
 *
 *  `unreadable` is the exit-2 case. Unparseable JSON is NOT that case: it is an INVALID CANDIDATE,
 *  which is a payload answer, not a process failure. */
async function readCandidate(argv: string[]): Promise<{ raw?: unknown; unreadable?: string }> {
  const fi = argv.indexOf("--file");
  const path = fi !== -1 ? argv[fi + 1] : undefined;
  if (fi !== -1 && (path === undefined || path.startsWith("-"))) return { unreadable: "--file needs a path" };
  const useStdin = argv.includes("--stdin");
  if (!useStdin && path === undefined) {
    return { unreadable: "config validate: pass --file <path> or --stdin (the candidate config to check)" };
  }
  let text: string;
  try {
    text = useStdin ? await Bun.stdin.text() : await Bun.file(path!).text();
  } catch (e) {
    return { unreadable: `could not read ${useStdin ? "stdin" : path}: ${e}` };
  }
  try { return { raw: JSON.parse(text) }; }
  catch { return { raw: undefined }; }  // not JSON ⇒ an invalid candidate, reported in the payload
}

/** Leading flags that still mean the default `run` command. Anything else starting with `-` is
 *  refused — the H2 lesson: a typo'd flag must never fall through to a full generate + day-stamp. */
const RUN_LEADING_FLAGS = new Set(["--force", "-f", "--json", "--json-out"]);

/** Every token `dispatch` treats as a COMMAND. Kept beside the switch below and asserted against it by
 *  `test/dispatch.json.test.ts`, so a new subcommand cannot be added without becoming un-swallowable.
 *  ⚠ Slice 4 added `schedule`, and adding it HERE — not merely to the switch — is what keeps
 *  `daily-briefing --json schedule install` from routing to `run` and consuming the morning. */
const KNOWN_COMMANDS = new Set(["run", "init", "status", "doctor", "config", "help", "schedule", "update"]);

/** The verbs of `schedule`. Refused rather than defaulted: `daily-briefing schedule` with no verb must
 *  print usage and exit non-zero, never fall through to anything stateful (the H2 lesson). */
const SCHEDULE_VERBS = new Set(["install", "uninstall", "status", "verify"]);

/** Phase E (E11). `update`'s whole argv vocabulary: the one verb (`--check`) and its one flag. A bare
 *  `update`, any other token, or a repeated one is refused with usage and exit 2 — the SCHEDULE_VERBS
 *  rule. There is deliberately no verb that downloads or installs anything. */
const UPDATE_VERBS = new Set(["--check"]);
const UPDATE_FLAGS = new Set(["--json"]);

/** The one line a human `update --check` prints. Exported and pure so the WORDING is testable.
 *  `latest`/`url` are already constrained by src/updateCheck.ts (a bounded version string; this
 *  project's release page), and stripped of control bytes here anyway — they arrived over a network. */
export function renderUpdateResult(r: UpdateCheckResult): string {
  switch (r.status) {
    case "newer":
      return stripControl(`a newer version is available: ${r.latest ?? "?"} (you have ${r.current}) — ${r.url ?? ""}`.trimEnd());
    case "up-to-date":
      return stripControl(`up to date — you have ${r.current}${r.latest !== undefined && r.latest !== r.current ? ` (latest release: ${r.latest})` : ""}`);
    default:
      return stripControl(`could not check for updates (you have ${r.current}) — GitHub did not answer, or its answer could not be read. Nothing was downloaded.`);
  }
}

/** Pull `--flag <value>` out of argv. A MISSING value is an ERROR, never a silent default — the same
 *  rule `jsonOutArg` follows, for the same reason: `--invoker` with nothing after it must not quietly
 *  install under the wrong principal. */
function flagValue(argv: string[], flag: string): { value?: string; error?: string } {
  const i = argv.indexOf(flag);
  if (i === -1) return {};
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("-")) return { error: `${flag} needs a value` };
  return { value: v };
}

/**
 * The command token a `run`-shaped invocation would SWALLOW, if any.
 *
 * ⚠ THE H2 CLASS, REOPENED BY THIS SLICE'S OWN ADDITIONS, and measured rather than reasoned about.
 * `cmd` is argv[2] only when it does not start with `-`, so once `--json`/`--json-out` joined
 * RUN_LEADING_FLAGS, `daily-briefing --json status` routed to `run` and the `status` token was
 * DISCARDED SILENTLY: a Schedule panel polling that every few seconds performed a full pipeline run —
 * provider call, briefing-latest.md, dated archive, day stamp — and exited 0 with an envelope no
 * status parser recognises. The first such poll of the morning consumed the morning. It also made
 * `case "init"`'s own comment false: `init --json` is refused there, but `--json init` never reached it.
 *
 * ⚠ THE `--json-out` OPERAND IS SCANNED TOO, deliberately. `--json-out status --json` is ambiguous
 * between "write the sidecar to a file called status" and a mangled `status --json`, and the H2 rule
 * is that ambiguity resolves AWAY from a stateful run. The cost is that a sidecar may not be named
 * exactly a KNOWN_COMMANDS token (`run`/`init`/`status`/`doctor`/`config`/`help`/`schedule`/`update`);
 * `./status` or an absolute path still works.
 */
function swallowedCommand(argv: string[]): string | undefined {
  for (let i = 3; i < argv.length; i++) if (KNOWN_COMMANDS.has(argv[i]!)) return argv[i]!;
  return undefined;
}

export async function dispatch(
  argv: string[],
  // The three new surfaces are injectable for the same reason `run`/`init` already are: an argv test
  // must be able to assert WHERE a command routed without executing it. Here that is not merely
  // convenient — the real `doctorReport` spawns `which`, a provider `--help` and a TCP probe, so a
  // routing test that called it would be neither hermetic nor fast.
  deps: {
    run?: typeof run; init?: typeof init;
    status?: typeof statusReport; doctor?: typeof doctorReport; configValidate?: typeof validateCandidate;
    // ⚠ The two scheduling modules are injected as WHOLE MODULES and imported DYNAMICALLY below. Both
    // halves matter: injected, because a routing test must be able to assert that `schedule install`
    // routed without an `launchctl` ever being reached; dynamic, because a static import would pull the
    // installer — and its `proc.run` default exec — into every `daily-briefing run` process for a
    // subcommand the scheduled path never invokes.
    //   ⚠ THE SECOND HALF WAS FALSE WHEN FIRST WRITTEN, and the fix was to make it true rather than to
    //   soften it: `src/json.ts` — which the run path DOES import statically — imported `schedulePath`
    //   from `./schedule/install`, so the installer was evaluated on every single run and this comment
    //   described a laziness that did not exist. `schedulePath` now lives in `src/marker.ts` with the
    //   other state paths (the installer re-exports it), leaving these two `await import(...)` calls as
    //   the only edges into the scheduler.
    schedule?: typeof import("./schedule/install");
    scheduleStatus?: typeof import("./schedule/status");
    /** Phase E (E11): the manual check, injectable so a routing test never reaches the network. */
    updateCheck?: typeof checkForUpdate;
  } = {},
): Promise<number> {
  const runFn = deps.run ?? run;
  const initFn = deps.init ?? init;
  const first = argv[2];
  // Help/version are informational — they must NEVER trigger a stateful briefing run (the old
  // catch-all routed any leading flag, incl. --help, straight into a full generate + day-stamp).
  // ⚠ ANYWHERE IN ARGV, not only as argv[2], and BEFORE every other branch. This checked `first` only,
  // so `run --help`, `init --help` and `schedule install --help` EXECUTED the subcommand — a reviewer's
  // `run --help` stamped a real tick. There is no per-subcommand help, so every spelling prints the one
  // usage text. A `-h`/`-v` that was meant as a flag VALUE (`--model -h`) is read as help too: that
  // ambiguity resolves AWAY from a state change (the H2 rule), and help wins over version.
  const flags = argv.slice(2);
  if (first === "help" || flags.some((a) => a === "--help" || a === "-h")) { printUsage(); return 0; }
  if (flags.some((a) => a === "--version" || a === "-v")) { console.log(VERSION); return 0; }
  // A leading run-flag (bare `daily-briefing --force`, `daily-briefing --json`) still means the
  // default `run`, but reject an UNKNOWN leading flag instead of silently running.
  if (first && first.startsWith("-") && !RUN_LEADING_FLAGS.has(first)) {
    console.error(`unknown flag: ${first}`); printUsage(); return 2;
  }
  const cmd = first && !first.startsWith("-") ? first : "run";
  // ⚠ BEFORE the switch, so it covers BOTH spellings of the trap: a leading run-flag (`--json status`)
  // and the explicit default (`run status`). A subcommand must be argv[2]; anything else is a typo the
  // user can fix in a second, and the alternative is a silently consumed morning. See swallowedCommand.
  if (cmd === "run") {
    const swallowed = swallowedCommand(argv);
    if (swallowed !== undefined) {
      console.error(`${swallowed}: a subcommand must come FIRST — write \`daily-briefing ${swallowed} …\`, not \`daily-briefing ${stripControl(first ?? "run")} … ${swallowed}\` (which would run a briefing and stamp the day)`);
      printUsage();
      return 2;
    }
  }
  const wantsJson = argv.includes("--json");
  const jsonOut = jsonOutArg(argv);
  switch (cmd) {
    // interactive = a human at a TTY (launchd redirects stdout to the log → not a TTY) → floor-exempt.
    // interactive = a human at a TTY (stdin OR stdout — so `daily-briefing > out.md` still counts);
    // launchd redirects both to files/devnull → not a TTY → floor enforced for the scheduled agent.
    case "run": {
      if (jsonOut.error) { console.error(jsonOut.error); printUsage(); return 2; }
      // Shape-guard BEFORE run() is entered, so a traversal attempt exits 2 having written nothing —
      // not even the tick heartbeat. run() guards again for its own callers; both calls are pure.
      if (jsonOut.path !== undefined) {
        try { resolveJsonOutPath(jsonOut.path); }
        catch (e) { console.error(stripControl(String(e instanceof Error ? e.message : e))); return 2; }
      }
      return runFn(
        argv.includes("--force") || argv.includes("-f"),
        { interactive: Boolean(process.stdin.isTTY || process.stdout.isTTY) },
        { json: wantsJson, ...(jsonOut.path !== undefined ? { jsonOut: jsonOut.path } : {}) },
      );
    }
    // init now signals failure (C1/B7 refuses a provider.argv that defeats hardening), so propagate it.
    case "init":
      // Both output flags are `run`-only. Accepting them here would be harmless today and a trap
      // tomorrow: `init` writes a config and probes repos, so a caller that believed it was getting
      // an envelope would get a side effect and no answer.
      // ⚠ THIS ARM ONLY SEES `init --json`. The reversed spelling `--json init` never reaches it —
      // `cmd` would be "run" — and used to run a full briefing instead, which made the sentence above
      // false for half the argv space. `swallowedCommand` above is the half that closes it; the two
      // guards are complementary and `test/dispatch.json.test.ts` pins both orders.
      if (wantsJson || jsonOut.path !== undefined || jsonOut.error) {
        console.error("init: --json / --json-out are flags of `run`, not of `init`");
        return 2;
      }
      {
        // A3/T10: `--provider …` is parsed HERE, in dispatch, so a malformed flag set is refused
        // before anything is written. Exit 2 matches every other init refusal.
        const parsed = parseInitApiFlags(argv);
        if (parsed.error) { console.error(parsed.error); return 2; }
        return initFn(parsed.api !== undefined ? { api: parsed.api } : {});
      }
    // ── the read-only JSON surfaces. None of them reaches run(), init(), the provider or the marker.
    case "status": {
      if (!requireJson("status", argv)) return 2;
      console.log(JSON.stringify(await (deps.status ?? statusReport)()));
      return 0;
    }
    case "doctor": {
      if (!requireJson("doctor", argv)) return 2;
      // Exit 0 even when the verdict is `blocked`: doctor REPORTS a problem, it does not become one.
      console.log(JSON.stringify(await (deps.doctor ?? doctorReport)()));
      return 0;
    }
    case "config": {
      if (argv[3] !== "validate") {
        console.error(`unknown command: config ${argv[3] ?? ""}`.trim()); printUsage(); return 2;
      }
      if (!requireJson("config validate", argv)) return 2;
      const { raw, unreadable } = await readCandidate(argv);
      if (unreadable) { console.error(stripControl(unreadable)); return 2; }
      // Exit 0 whether or not the candidate is valid — validity is the PAYLOAD. A Settings screen
      // asking "is this config good?" gets an answer, not a process failure.
      console.log(JSON.stringify((deps.configValidate ?? validateCandidate)(raw)));
      return 0;
    }
    // ── Slice 4: the OS trigger. The ONLY way scheduling state transitions.
    case "schedule": {
      const verb = argv[3];
      // ⚠ NO DEFAULT VERB, deliberately. `daily-briefing schedule` is ambiguous between install and
      // status, and the H2 rule is that ambiguity resolves AWAY from a state change.
      if (verb === undefined || !SCHEDULE_VERBS.has(verb)) {
        console.error(verb === undefined
          ? "schedule: a verb is required — install | uninstall | status | verify"
          : `schedule: unknown verb ${stripControl(verb)} — expected install | uninstall | status | verify`);
        printUsage();
        return 2;
      }
      // Both output flags belong to `run`; accepting them here would promise an envelope and deliver
      // a side effect (the `init` rule, one arm to the left).
      if (jsonOut.path !== undefined || jsonOut.error) {
        console.error("schedule: --json-out is a flag of `run`, not of `schedule`");
        return 2;
      }
      const invokerArg = flagValue(argv, "--invoker");
      if (invokerArg.error) { console.error(invokerArg.error); return 2; }
      if (invokerArg.value !== undefined && invokerArg.value !== "app" && invokerArg.value !== "cli") {
        console.error(`schedule: --invoker must be "app" or "cli", got ${stripControl(invokerArg.value)}`);
        return 2;
      }
      const identityArg = flagValue(argv, "--identity");
      if (identityArg.error) { console.error(identityArg.error); return 2; }
      const invoker = (invokerArg.value ?? "cli") as "app" | "cli";
      const sched = deps.schedule ?? (await import("./schedule/install"));
      const statusMod = deps.scheduleStatus ?? (await import("./schedule/status"));
      switch (verb) {
        case "install":
          return sched.installSchedule({
            invoker,
            takeOver: argv.includes("--take-over"),
            noVerify: argv.includes("--no-verify"),
            enableLinger: argv.includes("--enable-linger"),
            confirmExperimental: argv.includes("--confirm-experimental"),
            ...(identityArg.value !== undefined ? { identity: identityArg.value } : {}),
            floorMinutes: (await floorMinutesFromConfig()),
          });
        case "uninstall":
          return sched.uninstallSchedule({ invoker, takeOver: argv.includes("--take-over") });
        case "status": {
          const report = await statusMod.scheduleStatusReport();
          // Unlike the A1 surfaces this one HAS a human form, so `--json` is optional here rather than
          // required — and the two are one function apart so they cannot disagree.
          console.log(wantsJson ? JSON.stringify(report) : statusMod.renderScheduleStatus(report));
          return 0;
        }
        default: {
          // ⚠ THE OUTCOME IS THE EXIT CODE. This arm returned a hardcoded 0 — so a kickstart the
          // scheduler REFUSED, and a poll that produced no evidence at all, both exited "success"
          // while the text said otherwise. A GUI or a script switching on the documented codes (the
          // reason they are documented) was told every verify passed. `verifyExitCode` owns the
          // mapping — 0 evidence appeared, 1 no NEW evidence, 3 the kick could not be issued — so the
          // code and `verdictLine` cannot drift apart.
          const v = await sched.verifySchedule({});
          console.log(wantsJson ? JSON.stringify(v) : sched.verdictLine(v));
          return sched.verifyExitCode(v);
        }
      }
    }
    // ── Phase E (E11): the manual, notify-only update check. ──────────────────────────────────────
    case "update": {
      const rest = argv.slice(3);
      const verbs = rest.filter((a) => UPDATE_VERBS.has(a));
      // ⚠ NO DEFAULT VERB and no unknown token (the SCHEDULE_VERBS rule): `daily-briefing update` alone
      // must print usage and exit 2, never guess. `--json-out` is `run`'s and is refused here with
      // every other stray token.
      if (verbs.length !== 1 || rest.some((a) => !UPDATE_VERBS.has(a) && !UPDATE_FLAGS.has(a)) ||
          rest.filter((a) => a === "--json").length > 1) {
        console.error(verbs.length === 0
          ? "update: --check is required — `daily-briefing update --check [--json]` (nothing is ever downloaded or installed)"
          : `update: unexpected argument(s) ${stripControl(rest.filter((a) => !UPDATE_VERBS.has(a) && !UPDATE_FLAGS.has(a)).join(" ") || rest.join(" "))} — expected \`update --check [--json]\``);
        printUsage();
        return 2;
      }
      // ALWAYS fetches — `intervalHours` gates only the automatic path — and rewrites the state file.
      // Exit 0 whatever the answer: `unknown` is a REPORT that the check could not be completed, the
      // `doctor` rule ("it reports a problem, it does not become one").
      const result = await (deps.updateCheck ?? checkForUpdate)();
      console.log(wantsJson ? JSON.stringify(result) : renderUpdateResult(result));
      return 0;
    }
    default: console.error(`unknown command: ${cmd}`); printUsage(); return 2;
  }
}

/** The morning floor the unit files are generated from — `parseFloor(cfg.morningTime)`, NEVER a
 *  literal 7/20 (T5). A missing or malformed config degrades to the default exactly as the run path
 *  does, so `schedule install` on a not-yet-`init`ed machine still writes a working unit. */
async function floorMinutesFromConfig(): Promise<number> {
  try { return parseFloor((await loadConfig()).morningTime).minutes; }
  catch { return parseFloor(undefined).minutes; }
}

/** The process entry, split out of the `import.meta.main` line so the CRASH SEAM is reachable by a
 *  test. `dispatch` already injects `run`, so a test can hand it one that throws and assert what
 *  lands on stderr — which is the only way to cover a path whose whole point is that it is reached
 *  when nothing else caught the error.
 *
 *  Exit code preserved: an escaping throw exited 1 under bun's own handler, and returns 1 here. */
export async function main(
  argv: string[], deps: Parameters<typeof dispatch>[1] = {},
): Promise<number> {
  try { return await dispatch(argv, deps); }
  catch (e) { diagCrash(e); return 1; }
}

if (import.meta.main) process.exit(await main(process.argv));
