/**
 * The webview's whole view of the engine: ten typed `invoke()` wrappers.
 *
 * ⚠ THIS MODULE NO LONGER SPELLS AN ARGV, AND THAT IS THE CHANGE. B1's version imported
 * `@tauri-apps/plugin-shell` and assembled argv here; `src-tauri/capabilities/README.md` records
 * what that was measured to cost. Two things, both structural:
 *
 *   1. **A first-match ceiling.** `tauri-plugin-shell` resolves a sidecar's scope key from its
 *      `externalBin` path and looks it up with `find`, so every entry in the capability shared one
 *      name and only the first was ever consulted. Exactly one argv was reachable, and a foreign
 *      one was not refused — it was *replaced* by the allowlisted one. Eight builders here called
 *      the sidecar and all eight ran `status --json`, so `scheduleInstall()` returned exit 0 having
 *      installed nothing. The revision before this one made them throw `UnreachableUnderCeiling`
 *      rather than lie.
 *   2. **A second control channel.** The plugin forwarded frontend-supplied `cwd` and `env` past
 *      the scope untouched, and `DAILY_BRIEFING_STATE_DIR` / `XDG_CONFIG_HOME` redirect every path
 *      the engine reads.
 *
 * Both are gone because the mechanism is gone: **this webview cannot spawn anything.** The shell
 * plugin is not installed, the capability grants no `shell:*` permission, and every invocation
 * below is a `#[tauri::command]` whose argv is constructed in `src-tauri/src/engine.rs` from a typed
 * operation enum. There is no `UnreachableUnderCeiling` any more — these functions run.
 *
 * ⚠ TWO STRINGS ARE STILL CALLER-SUPPLIED — `runToFile`'s name and `configValidate`'s file — and
 * they are validated IN RUST before any spawn. A refusal arrives as
 * `EngineError { kind: "invalidInput" }` naming the class, and no process was created. Do not
 * pre-validate them here: a second copy of the rules in TypeScript is the drift this design exists
 * to prevent.
 *
 * ⚠ THE INVOKER IS NOT CALLER-SUPPLIED. `scheduleInstall`/`scheduleUninstall` take `takeOver`
 * only; the Rust commands pass `--invoker app` unconditionally, because the engine's foreign-owner
 * refusal keys on the record's `invoker` and a webview that could spell `cli` could forge it.
 *
 * ⚠ THE ENGINE CLIENT IS RESOLVED ONCE, AT STARTUP. A missing sidecar does not stop the app from
 * opening; every function below then rejects with `{ kind: "sidecarUnresolved", detail }` naming
 * the path the shell looked at.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * What the engine's exit code meant, classified in Rust.
 *
 * ⚠ `delivered` IS WIDER THAN THE WORD SUGGESTS. For `run` it means a briefing was delivered; for
 * every other operation it means "exit 0, here is the payload" — `status` delivers a report, not a
 * briefing.
 */
export type Outcome =
  | { kind: "delivered" }
  /** Exit 0, and the envelope says `delivered: false`. `reason` is the engine's own `skipReason`. */
  | { kind: "skipped"; reason: string | null }
  /** Exit 1, any other non-zero exit, a signal, or output that should have been JSON and was not. */
  | { kind: "failed"; reason: string | null }
  /** Exit 2 — a bad config, a bad flag, a foreign schedule owner, or a withheld confirmation. */
  | { kind: "configError" };

/** One completed invocation. The classification is the small part; the raw output survives beside it. */
export interface EngineOutcome<P = unknown> {
  /** Which operation produced this — `run`, `status`, `schedule-install`, … */
  operation: string;
  outcome: Outcome;
  /** `null` when the child was killed by a signal, never a fabricated -1. */
  exitCode: number | null;
  /** The parsed JSON envelope, when the operation produces one and it parsed. */
  payload: P | null;
  /** Everything the engine wrote to stdout, verbatim. */
  stdout: string;
  /** Everything the engine wrote to stderr, verbatim — the same text the progress events carried. */
  stderr: string;
}

/**
 * The last Run Now, as Today needs it: the finished invocation, the `catch` path (the run threw
 * before an outcome existed — a `busy` refusal, an unresolved sidecar, a spawn failure), or no run
 * yet (`null`, which is also the state WHILE a run is in flight).
 */
export type LastRunResult = { outcome: EngineOutcome } | { threw: true } | null;

/**
 * Whether Today's "Details" disclosure (the engine's stderr for the run) starts OPEN (v0.2.1 §2.1).
 * The lines are the engine's diagnostics — `postcheck-info …`, `waited ~0s …` — which say nothing to a
 * user whose run went fine, so it is collapsed unless they explain a problem: a `failed` run (exit 1 —
 * `blocked` included — another non-zero exit, a signal, or non-JSON output), a `configError` (exit 2,
 * whose result line says "see Details below"), or a run that threw. A `delivered` or `skipped` run
 * stays collapsed: for `skipped` the result line already names the reason. Reads the outcome's
 * `.outcome.kind`.
 */
export function detailsOpen(run: LastRunResult): boolean {
  if (run === null) return false;
  if ("threw" in run) return true;
  switch (run.outcome.outcome.kind) {
    case "failed":
    case "configError":
      return true;
    case "delivered":
    case "skipped":
      return false;
  }
}

/** Why an invocation failed before or around the engine, as opposed to *in* it. */
export type EngineError =
  /** An operand was refused. **No process was spawned.** */
  | { kind: "invalidInput"; field: string; reason: string }
  /** Another state-changing invocation is in flight. A refusal, not a queue. */
  | { kind: "busy"; running: string }
  | { kind: "sidecarUnresolved"; detail: string }
  | { kind: "spawn"; detail: string };

/** One stderr line, as it arrives. */
export interface ProgressEvent {
  operation: string;
  /** Verbatim, with only its line terminator removed. */
  line: string;
}

/**
 * Subscribe to the engine's stderr while it runs.
 *
 * ⚠ RENDER THESE AS TEXT, NEVER AS MARKUP (`docs/gui-seam.md` §5). The engine's diagnostics
 * interpolate repo-controlled strings — branch names, commit subjects, file paths — which are
 * attacker-influenced in the general case.
 */
export function onProgress(handler: (event: ProgressEvent) => void): Promise<UnlistenFn> {
  return listen<ProgressEvent>("engine:progress", (e) => handler(e.payload));
}

/* ── read-only ────────────────────────────────────────────────────────────────────────────────── */

/**
 * The engine's update-check answer (Phase E, E11) — `update --check --json`'s payload, and
 * `status --json`'s `updateCheck`. Mirrors `UpdateCheckResult` in `src/updateCheck.ts`.
 * ⚠ `latest` and `url` arrived over a network: render them as text, never as markup or a link.
 */
export interface UpdateCheckResult {
  status: "up-to-date" | "newer" | "unknown";
  /** The running engine's version. */
  current: string;
  /** The latest release's version; absent when the check could not read one. */
  latest?: string;
  /** This project's release page for `latest`. */
  url?: string;
  /** When the check finished (UTC ISO-8601). */
  checkedAt: string;
}

/**
 * `status --json`, MINIMALLY typed (Phase E, E12): only the fields this webview reads. The engine's
 * full report is `StatusReport` in `src/json.ts`; it is frozen additive-only, so a field missing
 * here is simply unread, never wrong. `updateCheck` is optional and nullable: absent from an older
 * engine, `null` before any check has run.
 */
export interface StatusReport {
  schemaVersion: number;
  engineVersion?: string;
  updateCheck?: UpdateCheckResult | null;
}

/** `status --json` — a pure state-dir read. Safe to call every few seconds. */
export function status<P = StatusReport>(): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_status");
}

/** `doctor --json`. Exits 0 even when the verdict is `blocked`: doctor REPORTS a problem. */
export function doctor<P = unknown>(): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_doctor");
}

/**
 * `config validate --json --file <path>` — validates a CANDIDATE config, never the installed one.
 * Validity is the PAYLOAD, not the exit code.
 *
 * `file` must be an absolute path with no `.`/`..` segment, no NUL, no control character and no
 * whitespace other than a plain space (so `~/.config/…` and `~/Library/Application Support/…`
 * are fine); anything else is refused in Rust before any spawn. `--stdin` is deliberately not
 * offered.
 */
export function configValidate<P = unknown>(source: { file: string }): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_config_validate", { file: source.file });
}

/**
 * `schedule status --json` — the scheduling API, FROZEN ADDITIVE-ONLY (gui-seam §2).
 *
 * ⚠ `ticksToday` is `null`, never `0`, when the heartbeat cannot be parsed: `0` reads as "launchd
 * never fired", so rendering a `null` as `0` shows a healthy machine as a dead scheduler.
 */
export function scheduleStatus<P = unknown>(): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_schedule_status");
}

/* ── state-changing ───────────────────────────────────────────────────────────────────────────── */

/**
 * `run --json [--force]`. A briefing generation; `force` bypasses the day marker.
 *
 * ⚠ ONE AT A TIME. A second call while one is running is refused with
 * `EngineError { kind: "busy" }` — it is not queued, because a second briefing generation must not
 * be *delayed* into happening.
 */
export function run<P = unknown>(opts: { force?: boolean } = {}): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_run", { force: opts.force === true });
}

/**
 * `run --json --json-out <name> [--force]`. The envelope also lands in a file under the engine's
 * STATE directory — never the cwd (`src/json.ts`, `resolveJsonOutPath`).
 *
 * `name` is a BARE FILENAME ending in `.json`: no separator may appear, so it always resolves
 * inside the state directory, and the engine additionally refuses names it owns (`briefing.log`,
 * `last-run`, `run.lock`, …). The Rust side also refuses `transcript-health.json` (any letter
 * case) — a file the engine READS, absent from its own refusal list until the Phase C follow-up
 * (deviation 164). Anything else is refused in Rust before any spawn.
 */
export function runToFile<P = unknown>(
  name: string,
  opts: { force?: boolean } = {},
): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_run_to_file", { name, force: opts.force === true });
}

/**
 * `schedule install --invoker app [--take-over]`. The invoker is fixed in Rust (see the header).
 *
 * A FOREIGN OWNER IS REFUSED with exit 2 → `{ kind: "configError" }` (gui-seam §3). Offer the user
 * keep-existing — the app becomes a viewer — or an explicit take-over. Never replace a
 * configuration the user set up deliberately, and never pass `takeOver` without having asked.
 */
export function scheduleInstall<P = unknown>(
  opts: { takeOver?: boolean } = {},
): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_schedule_install", {
    takeOver: opts.takeOver === true,
  });
}

/**
 * `schedule uninstall --invoker app [--take-over]`. The invoker is fixed in Rust (see the header).
 *
 * ⚠ Exit 1 means NOTHING WAS FOUND TO REMOVE (gui-seam §3), and it arrives as
 * `{ kind: "failed", reason: null }` with `exitCode: 1` — the classifier invents no reason string
 * for it. Key a "nothing to remove" rendering on `operation === "schedule-uninstall" &&
 * exitCode === 1`, not on `reason`.
 */
export function scheduleUninstall<P = unknown>(
  opts: { takeOver?: boolean } = {},
): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_schedule_uninstall", {
    takeOver: opts.takeOver === true,
  });
}

/**
 * `schedule verify --json` (T20) — re-issue the verification KICKSTART `schedule install` already
 * performs as its last step, and report what evidence appeared.
 *
 * ⚠ THIS IS A WRITE. The kick makes the REGISTERED trigger run the engine, so a briefing can be
 * generated and the day stamped. It takes the same in-flight guard as `run` and `scheduleInstall`:
 * a second mutating call while one is in flight is refused with `{ kind: "busy" }`.
 *
 * ⚠ AND THE EXIT CODE IS NOT THE VERDICT. `1` here means "the kick was accepted and produced NO NEW
 * evidence" — inconclusive, not broken — which arrives as `{ kind: "failed", reason: null }`. Read
 * the ENVELOPE's own `outcome` field instead; `lib/verify-flow.ts` is the one place that does, and
 * it is what keeps `already-delivered-before-kick` from being rendered as a success (gui-seam §3:
 * *"never render it as a successful verification"*).
 */
export function scheduleVerify<P = unknown>(): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_schedule_verify");
}

/**
 * `update --check --json` (Phase E, E12) — the Settings screen's "Check now": the ENGINE's manual,
 * notify-only update check. It always asks (the config's `intervalHours` gates only the engine's own
 * scheduled-run check), rewrites the engine's update-check record, and resolves with the result
 * object as `payload` — `status: "unknown"` when GitHub did not answer, which is still exit 0.
 *
 * ⚠ NOT A WRITE THE GUARD CARES ABOUT: it takes no in-flight slot, so it works while a run is in
 * flight (`src-tauri/src/engine.rs`, `Operation::UpdateCheck`). ⚠ THE ONE CALL SITE is the button
 * (`lib/UpdateCheck.svelte`); nothing calls it on mount, on a timer, or from the wizard.
 */
export function updateCheck(): Promise<EngineOutcome<UpdateCheckResult>> {
  return invoke<EngineOutcome<UpdateCheckResult>>("engine_update_check");
}

/**
 * ⚠ TWO ENGINE SURFACES HAVE NO WRAPPER HERE, ON PURPOSE, and the capability grants neither:
 *
 *   - `init` and its provider flags — the first-run wizard (T16). The Settings screen (T15, B5)
 *     edits an EXISTING config through `config_save` (`lib/files.ts`) and never runs `init`.
 *   - `calendar` — plan R1's forward list carries it; the ENGINE does not (`src/main.ts` dispatches
 *     run | init | status | doctor | config | help | schedule | update and exits 2 on anything
 *     else). B1 allowlisted it ahead of the engine; a typed command for a subcommand that does not
 *     exist is a function that reports failure for a reason the user cannot act on, so the
 *     operation enum is exhaustive over the operations the app may perform instead — the engine
 *     surface minus `init` and `help`.
 *
 * `schedule verify` was on this list until B6 (T20) — the kickstart is still ENGINE-SIDE, and that
 * wrapper re-issues the same engine-side kick — and `update --check` was until Phase E, when E11 gave
 * the engine the subcommand and E12 added `updateCheck()` above.
 */
