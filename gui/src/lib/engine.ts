/**
 * The webview's whole view of the engine: thirty-three typed `invoke()` wrappers — thirteen engine
 * operations, the five provider-fallback key and reset commands (PR 3), the candidate check that is
 * the only route to `provider test`, Replace's three pending-reset store commands, the briefing
 * redesign B1's live git check (`reposStatus`, gated in Rust), its C's four live calendar-details
 * commands (`calendarDetailsOpen`, `calendarDetailsGet`, `calendarJoin`, `calendarAppOpen`), its B2's
 * five opening commands (`openGithub`, `copyPushCommand`, `editorList`, `editorOpen`, `editorChoiceSet`), and its A2's
 * read of the stored AI summary (`readLatestSummary`).
 * (`config validate --file` and `provider key delete-all` have no wrapper since PR 3 final r1: the
 * first handed the webview every literal `apiKey` of the file it named, the second deleted every app
 * key in one call; Rust runs both itself, behind the settings guard and uninstall's gates.)
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
 * ⚠ THE CALLER-SUPPLIED STRINGS — `runToFile`'s name and (PR 3) the
 * provider commands' key, key id, label and candidate text — are validated IN RUST before any
 * spawn. A refusal arrives as `EngineError { kind: "invalidInput" }` naming the class, and no
 * process was created. Do not pre-validate them here: a second copy of the rules in TypeScript is
 * the drift this design exists to prevent. (`providerReset`'s exactly-one-target rule is the one
 * exception, and it is a shape, not a rule about a value: the wrapper refuses both-or-neither with
 * Rust's own refusal, which `tests-web/provider-ops.check.ts` reads from the Rust source.)
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
import type { EditorChoice, EditorId } from "./app-prefs-store";
import type { SlideId } from "./deck";
import type { FieldNote } from "./files";

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
 * whose result line says "See Details."), or a run that threw. A `delivered` or `skipped` run
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
  | { kind: "spawn"; detail: string }
  /** v0.3.0 (plan M8): a calendar operation outlived its own bound and was stopped (its process
   *  group killed). `operation` is the Rust `Operation::name` (`calendar-test`, …); `seconds` the bound. */
  | { kind: "timeout"; operation: string; seconds: number }
  /** v0.3.0 (plan M8): not on this platform — the Mac Calendar app source off macOS. Nothing ran. */
  | { kind: "unsupported"; detail: string };

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
 * `run --json [--force] [--now]`. A briefing generation; `force` bypasses the day marker and the
 * morning-time floor, `now` the floor alone (the app's Run now: still once a day).
 *
 * ⚠ ONE AT A TIME. A second call while one is running is refused with
 * `EngineError { kind: "busy" }` — it is not queued, because a second briefing generation must not
 * be *delayed* into happening.
 */
export function run<P = unknown>(opts: { force?: boolean; now?: boolean } = {}): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_run", { force: opts.force === true, now: opts.now === true });
}

/**
 * `run --json [--force] [--now] --json-out <name>`. The envelope also lands in a file under the engine's
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
  opts: { force?: boolean; now?: boolean } = {},
): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_run_to_file", { name, force: opts.force === true, now: opts.now === true });
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

/* ── calendar (v0.3.0, plan M8) ──────────────────────────────────────────────────────────────── */
//
// The four calendar ENGINE operations. Each takes no operand (the argv is fixed literals in Rust) and
// carries its own bound in Rust (`Operation::timeout`): past it the call rejects with
// `{ kind: "timeout" }`. The payloads are the engine's `calendar … --json` shapes
// (`src/calendar/types.ts`: `CalendarStatusJson`, `CalendarListJson`, `CalendarTestJson`) — typed by
// the caller (M9), left `unknown` here. None ever carries a link URL. Link FILES are written by
// `lib/calendar.ts`, not by an engine operation.

/** `calendar status --json` — the configuration and each source's last SCHEDULED read. A read
 *  (no in-flight guard); 30 s bound. Makes no network call and never prompts. */
export function calendarStatus<P = unknown>(): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_calendar_status");
}

/** `calendar list --json` — the Mac calendars (`macos: null` off macOS) and the configured links,
 *  never a URL. A read; 30 s bound. On macOS it cannot raise the permission prompt. */
export function calendarList<P = unknown>(): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_calendar_list");
}

/** `calendar test --json` — Settings' "Test": read every source NOW (link fetches, the Mac helper).
 *  NOT mutating (works while a run is in flight); 75 s bound. Counts only, never titles. */
export function calendarTest<P = unknown>(): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_calendar_test");
}

/**
 * `calendar connect mac --json` — Settings' "Allow access": install or update the Calendar Reader
 * helper copy and request access while the user is present.
 *
 * ⚠ MUTATING: it takes the in-flight guard (`{ kind: "busy" }` beside a run or a schedule change) and
 * is bounded at 150 s (the helper's own 120 s dialog limit plus headroom). Off macOS it rejects with `{ kind: "unsupported" }` and nothing runs — the Mac
 * toggle is not shown there anyway (spec §2).
 */
export function calendarConnectMac<P = unknown>(): Promise<EngineOutcome<P>> {
  return invoke<EngineOutcome<P>>("engine_calendar_connect_mac");
}

/* ── provider fallback (PR 3, P3-M1; docs/gui-seam.md §1d, §1e) ──────────────────────────────── */
//
// The five `engine_provider_*` commands (`src-tauri/src/engine.rs`) and the candidate check
// (`provider_candidate_check`, `src-tauri/src/config_save.rs`). All five engine commands are
// MUTATING (the in-flight guard holds them: `{ kind: "busy" }` beside a run, a schedule change or
// another provider operation) and carry their own bound in Rust (`{ kind: "timeout" }` past it).
// None takes a path. Each resolves with the engine's ONE JSON line as `payload`:
//
//   ⚠ SWITCH ON THE PAYLOAD'S `ok`, `code` AND `reason`, NEVER ON `outcome` OR `exitCode`. Exit 1 is
//   both `write-failed` and a crash, exit 2 both `usage` and `config` (gui-seam §1d). A `null`
//   payload means the engine printed no JSON line — it CRASHED; treat that as a crash, not a refusal.
//
// ⚠ NO MESSAGE THE ENGINE ANSWERS ECHOES A LABEL, A KEY OR A CONFIG VALUE: word a refusal by `code`
// and `reason`, never by parsing `error`.

/** The engine's `code` on a refusal (`src/providerCli.ts` `FailCode`). */
export type ProviderFailCode = "usage" | "config" | "lock-held" | "write-failed";

/**
 * A refusal's `reason`: the key store's own (`src/keyStore.ts` `KeyFailReason`) on `write-failed`;
 * `invalid-key` / `invalid-id` on `usage`; and on `config`, `timeout` (a read timed out — retry),
 * `changed` (`key scrub-backup`: `.bak` changed while it was read or scrubbed — retry; P3-M4
 * checkpoint) or `invalid-key` (`key migrate`'s literal outside the key rule; `provider test`'s literal
 * holding whitespace or a control character after trimming). Absent on every other refusal.
 * ⚠ `timeout` is the same on both platforms; word it per platform — macOS "unlock your keychain,
 * then retry", elsewhere "the key folder did not answer in time — retry".
 */
export type ProviderFailReason =
  | "invalid-key"
  | "invalid-id"
  | "keychain-refused"
  | "refused"
  | "timeout"
  | "changed"
  | "add-failed"
  | "readback-failed"
  | "readback-mismatch"
  | "failed"
  | "cap"
  | "unsupported-platform"
  | "keys-folder"
  | "write-failed"
  | "collision";

/** What removing a failed `key set` / `key migrate`'s half-stored key did (`src/keyStore.ts` `Cleanup`). */
export type KeyCleanup = "deleted" | "not-found" | "failed" | "timeout";

/** `{ok: false, …}` — any provider verb's refusal (gui-seam §1d). */
export interface ProviderRefusal {
  schemaVersion: number;
  ok: false;
  code: ProviderFailCode;
  /** `"<verb>: <message>"`, fixed text. For display only; never parse it. */
  error: string;
  reason?: ProviderFailReason;
  /** A failed `key set` / `key migrate`: present when there was something to remove. */
  cleanup?: KeyCleanup;
  /** A failed `key set` / `key migrate` whose stored key is UNCONFIRMED removed: retry
   *  `providerKeyDelete(keyId)`. Not a secret. Absent means nothing to retry (§1d). */
  keyId?: string;
  /** `key delete-all`'s refusal: how many it removed — on a `timeout`, a lower bound. */
  deleted?: number;
}

/** The reference the app saves into the entry: macOS a Keychain lookup, elsewhere a key file. Save
 *  exactly as answered. Never the key. */
export type AppKeyReference = { apiKeyCommand: string[] } | { apiKeyFile: string };

/** `key set`'s success: the new id and the reference to save. */
export type KeySetAnswer = { schemaVersion: number; ok: true; keyId: string } & AppKeyReference;

/** `key migrate`'s success: `key set`'s, plus the entry's `revision` — compare it with the row the
 *  app shows for that index before saving, and `providerKeyDelete(keyId)` on a mismatch. */
export type KeyMigrateAnswer = KeySetAnswer & { revision: string };

/** `key delete`: `true` it removed that key; `false` it removed nothing (not proof none is left). */
export interface KeyDeleteAnswer {
  schemaVersion: number;
  ok: true;
  deleted: boolean;
}

/** `key scrub-backup`: how many literal keys it removed from `.bak`; `otherCopies: true` when a
 *  link left after the scrub command's own sweep of crashed saves' copies still holds one (gui-seam §1d). */
export interface KeyScrubBackupAnswer {
  schemaVersion: number;
  ok: true;
  removed: number;
  otherCopies?: true;
}

/** `reset`: whether there were marks to clear. */
export interface ProviderResetAnswer {
  schemaVersion: number;
  ok: true;
  cleared: boolean;
}

/** A failed Test's classifier reason (`src/failover.ts` `FailoverReason`) — never provider text. */
export type FailoverReason =
  | "usage"
  | "rate-limited"
  | "auth"
  | "key-unavailable"
  | "not-installed"
  | "not-found"
  | "prompt-too-long"
  | "rejected-request"
  | "unreachable"
  | "empty-answer"
  | "unusable-answer"
  | "cli-failure"
  | "insecure-endpoint";

/** `test`'s answer. A Test that FAILED is still `ok: true`; `passed` is the verdict. `recorded:
 *  false` comes with `notRecorded`: `lock-held` ("not saved — a briefing was running") or
 *  `write-failed` ("not saved — the status file could not be written"). */
export interface ProviderTestAnswer {
  schemaVersion: number;
  ok: true;
  passed: boolean;
  reason?: FailoverReason;
  /** When the probe finished (ISO instant). */
  at: string;
  recorded: boolean;
  notRecorded?: "lock-held" | "write-failed";
}

/** One `config validate --json` `providers` row (gui-seam §1d): one per entry the combined list
 *  resolves, `index` the `--index` numbering. `testTimeoutMs` is the Test's bound — pass it as it
 *  is (`testModeFor`); the app never decides "loopback" itself — `loopback` is the engine's answer
 *  (the same decision `testTimeoutMs` came from; `false` for a CLI entry and an API entry with no
 *  `baseUrl`), read by the network-check prompt (`networkAskNeeded`) and never sent back.
 *  `keyMoved` is the engine's answer to "did PR 2's scrub move this entry's key out?" (`false` for a CLI entry), read
 *  from the SAVED config's rows by the row status ("key moved — add a key") so the app never spells the sentinel.
 *  `appOwnedKey` without `appKeyId` means the entry may read ANY app key. */
export interface ProviderValidateRow {
  index: number;
  testTimeoutMs: number;
  loopback: boolean;
  /** Follow-up 4: the entry needs NO key at all — the engine's one no-key rule (an `openai-compatible` entry at a
   *  loopback host, src/providers/endpoint.ts `keyOptional`). Read by Add (`provider-flows.ts` `startAdd`), which
   *  never decides the kind or the host itself, and never sent back. */
  keyOptional: boolean;
  keyMoved: boolean;
  appOwnedKey?: true;
  appKeyId?: string;
}

/** `config validate --json`'s report, as the candidate check hands it back (`src/json.ts`
 *  `ConfigValidateReport`). Validity is `valid`, never the exit code. */
export interface ConfigValidateReport {
  schemaVersion: number;
  valid: boolean;
  errors: FieldNote[];
  warnings: FieldNote[];
  /** The config as the pipeline would see it, or `null` when invalid. Unread by the app. */
  normalized: unknown;
  /** `[]` when the candidate does not validate far enough, or its `provider.accounts` is broken. */
  providers: ProviderValidateRow[];
}

/**
 * `provider key set --json` — store a pasted key; the answer carries the reference to save.
 *
 * ⚠ THE KEY IS THIS CALL'S ONE ARGUMENT AND GOES NOWHERE ELSE. Rust writes it to the engine's stdin
 * (never argv, never an `Operation`, never a log line); this wrapper does not log it, wrap it in an
 * error, or keep it. Rust refuses only an empty key or one over 4 KiB (`invalidInput`, field `key`,
 * value never echoed); the key rule itself is the engine's (`code: "usage"`, `reason: "invalid-key"`).
 * Bounded at 19 s.
 */
export function providerKeySet(key: string): Promise<EngineOutcome<KeySetAnswer | ProviderRefusal>> {
  return invoke<EngineOutcome<KeySetAnswer | ProviderRefusal>>("engine_provider_key_set", { key });
}

/** `provider key migrate --index <n> --json` — move entry n's legacy literal key from the SAVED
 *  config into the key store (nothing is written to the config). Bounded at 19 s. */
export function providerKeyMigrate(index: number): Promise<EngineOutcome<KeyMigrateAnswer | ProviderRefusal>> {
  return invoke<EngineOutcome<KeyMigrateAnswer | ProviderRefusal>>("engine_provider_key_migrate", { index });
}

/** `provider key delete --id <keyId> --json` — remove one app-owned key. `id` is `k-` and 12
 *  lowercase hex digits (Rust refuses anything else). Bounded at 15 s. */
export function providerKeyDelete(id: string): Promise<EngineOutcome<KeyDeleteAnswer | ProviderRefusal>> {
  return invoke<EngineOutcome<KeyDeleteAnswer | ProviderRefusal>>("engine_provider_key_delete", { id });
}

/** `provider key scrub-backup --json` — remove from `.bak` the literal keys the saved config no
 *  longer holds. Rust holds the settings save lock across it, so a save started meanwhile waits.
 *  Idempotent: call it on every open (gui-seam §1d). Bounded at 15 s. */
export function providerKeyScrubBackup(): Promise<EngineOutcome<KeyScrubBackupAnswer | ProviderRefusal>> {
  return invoke<EngineOutcome<KeyScrubBackupAnswer | ProviderRefusal>>("engine_provider_key_scrub_backup");
}

/** `providerReset`'s target: the entry's position, or its label. */
export type ResetTarget = { index: number; label?: never } | { label: string; index?: never };

/**
 * `provider reset (--index <n> | --label-stdin) --json` — clear one entry's marks. Bounded at 15 s.
 *
 * ⚠ A LABEL TRAVELS ON STDIN, NEVER ARGV (Rust writes `{"label": …}`; a label is user text and
 * `--help` is a legal one). Exactly one of `index` and `label`: both or neither is refused HERE,
 * before any IPC, with the refusal Rust itself answers (`invalidInput`, field `index/label`) — a
 * `null` counts as absent, as Rust's `Option` reads it, and is not sent. Every other check (an empty
 * label, a NUL, an index out of range) is Rust's.
 */
export function providerReset(target: ResetTarget): Promise<EngineOutcome<ProviderResetAnswer | ProviderRefusal>> {
  const { index, label } = target as { index?: number | null; label?: string | null };
  const hasIndex = index !== undefined && index !== null;
  const hasLabel = label !== undefined && label !== null;
  if (hasIndex === hasLabel) {
    const refusal: EngineError = {
      kind: "invalidInput",
      field: "index/label",
      reason: "exactly one of the two is required",
    };
    return Promise.reject(refusal);
  }
  return invoke<EngineOutcome<ProviderResetAnswer | ProviderRefusal>>(
    "engine_provider_reset",
    hasIndex ? { index } : { label },
  );
}

/** What the candidate check does: `config validate`, or `provider test` of one entry. */
export type CheckMode = "validate" | { test: { index: number; testTimeoutMs: number } };

/**
 * The Test mode for a `config validate` row: its `index` and its `testTimeoutMs`, UNCHANGED, and
 * nothing else — Rust's `CheckMode` refuses an unknown field, so a whole row (with `appOwnedKey` /
 * `appKeyId`) would be refused. Rust adds nothing to the bound; it clamps it to 17 s – 30 min.
 */
export function testModeFor(row: ProviderValidateRow): CheckMode {
  return { test: { index: row.index, testTimeoutMs: row.testTimeoutMs } };
}

/** What a candidate check answered (`config_save::CheckOutcome`). */
export type CheckOutcome =
  /** `config validate --json`'s report, verbatim. An invalid candidate is `valid: false`, not an error. */
  | { kind: "validated"; report: ConfigValidateReport }
  /** `provider test --json`'s line, verbatim — a pass, a failure, or the engine's refusal (switch on
   *  `ok` and `code`). `boundMs` is the bound Rust applied (the row's value, clamped). */
  | { kind: "tested"; answer: ProviderTestAnswer | ProviderRefusal; boundMs: number }
  /** Refused before anything was staged: the `calendar` block holds a link address (the save path's answer), or
   *  (PR 3 final r1) a key slot holds a literal other than the redaction placeholder (one note, field `apiKey`). */
  | { kind: "invalid"; errors: FieldNote[]; warnings: FieldNote[] };

/** Why a candidate check did not answer (`config_save::CheckError`). Nothing was written to the config. */
export type CheckError =
  | { kind: "notJson"; detail: string }
  | { kind: "tooLarge"; bytes: number; limit: number }
  | { kind: "candidateDir"; detail: string }
  /** The Test's `index` is not one Rust accepts. Nothing was staged. */
  | { kind: "invalidInput"; field: string; reason: string }
  /** Another state-changing operation is running: a Test is refused, not queued. */
  | { kind: "busy"; running: string }
  | { kind: "timeout"; operation: string; seconds: number }
  /** The engine could not be run, crashed, or gave no usable JSON reply — or Uninstall removed the settings in this
   *  app session (Rust's `SETTINGS_REMOVED_BY_UNINSTALL`, a save's words), refused before anything is staged. */
  | { kind: "engine"; detail: string };

/**
 * Validate or Test a CANDIDATE config without saving it — the Providers screen's "Check" and
 * "Test". JSON text and a closed mode, no path: Rust stages the candidate itself (a private file it
 * removes on every outcome) and runs `config validate --file` or `provider test --file --index`.
 * Rejects with a `CheckError` (or, for an argument Rust cannot deserialise — a mode with an extra
 * field, a negative index — Tauri's own error string). A validate runs beside a Test; a second Test
 * is `busy`. Pass a Test's mode through `testModeFor`.
 */
export function providerCandidateCheck(text: string, mode: CheckMode): Promise<CheckOutcome> {
  return invoke<CheckOutcome>("provider_candidate_check", { text, mode });
}

/* ── the pending-reset store (P3-M4-T3, `src-tauri/src/pending_resets.rs`) ─────────────────────────── */
//
// Replace brackets the save with two `provider reset`s; Rust keeps the record between them in the app's
// `pending-resets.json` and retries it every 15 s (and at start) whatever screen is shown. Each command
// takes the entry's label (as written — its identity) and the NEW key id `key set` answered; never a path,
// never a key. Rust sends the label to the engine on STDIN.

/** `provider_pending_reset_add`'s answer (`pending_resets::AddOutcome`). */
export type PendingAddOutcome =
  /** The pre-save reset succeeded: save now. The record stays until `flush`. */
  | { kind: "reset" }
  /** A briefing holds the run lock (or another engine operation runs): show `REPLACE_WAITING_LINE`, call again in 15 s. */
  | { kind: "retry" }
  /** Any other refusal; the record was dropped. Word it by `code` / `reason`, never by parsing `detail`. */
  | { kind: "refused"; code: string | null; reason: string | null; detail: string };

/** `provider_pending_reset_flush`'s answer (`pending_resets::FlushOutcome`). */
export type PendingFlushOutcome =
  | { kind: "reset" }
  /** The post-save reset waits on a run; Rust's retry task finishes it. */
  | { kind: "retry" }
  /** The record was being discarded and the saved config does not use the key under this label. */
  | { kind: "discarding" }
  | { kind: "refused"; code: string | null; reason: string | null; detail: string };

/** `provider_pending_reset_drop`'s answer (`pending_resets::DropOutcome`). */
export type PendingDropOutcome =
  /** The saved entry under this label already uses the new key (its save landed): nothing deleted. */
  | { kind: "promoted" }
  | { kind: "deleted" }
  /** The delete was refused `busy`; Rust's retry task deletes the key. */
  | { kind: "deletePending" }
  | { kind: "kept"; why: "otherLabel" | "unverified" }
  | { kind: "deleteFailed"; detail: string };

/** Why a pending-reset command did not answer (`pending_resets::PendingError`). */
export type PendingError =
  | { kind: "invalidInput"; field: string; reason: string }
  | { kind: "store"; detail: string }
  | { kind: "engine"; detail: string };

/** Replace, before the save: record the pending reset and run the pre-save `provider reset` by label. */
export function providerPendingResetAdd(label: string, newKeyId: string): Promise<PendingAddOutcome> {
  return invoke<PendingAddOutcome>("provider_pending_reset_add", { label, newKeyId });
}

/** Replace, after the save landed: the post-save reset (Rust retries it while a run holds the lock). */
export function providerPendingResetFlush(label: string, newKeyId: string): Promise<PendingFlushOutcome> {
  return invoke<PendingFlushOutcome>("provider_pending_reset_flush", { label, newKeyId });
}

/** Discard or cancel an unsaved replacement — AFTER any save of the editor's own has settled. The new key is deleted
 *  only when the saved config references it nowhere; a replacement whose save landed is kept (`promoted`). */
export function providerPendingResetDrop(label: string, newKeyId: string): Promise<PendingDropOutcome> {
  return invoke<PendingDropOutcome>("provider_pending_reset_drop", { label, newKeyId });
}

// ── The briefing redesign's B1: the live git check (`repos_status`, src-tauri/src/repos.rs) ──────────────────
//
// Today's drivers (`git-live.ts`) ask on the page key, focus, the minute tick and the current slide; RUST gates the
// ask (the window's visibility, the current slide, a stat of each repo's git metadata, one check in flight) and
// answers from what it holds when the gate says no. Rust validates the request (at most 64 cards and 64 branch
// entries, keys of at most 80 characters, 1-40 hex tokens, branch names of at most 255 bytes, no control or format
// character) and refuses the WHOLE request on one bad entry, so `reposRequest` (`git-detail.ts`) never builds one.
// The webview never chooses the scope: the gate does.

/** Why the webview asks: today's page loaded or changed, the window regained focus, or the minute tick. */
export type ReposReason = "first" | "focus" | "minute";

/** `repos_status`'s one argument (`repos::ReposIpcRequest`; an unknown member is refused). `current` is the deck's
 *  current slide, or null (the slides off, or the Full briefing view: no check). */
export type ReposStatusRequest = {
  labels: { key: string; tokens: string[] }[];
  branches: { key: string; name: string }[];
  pageDate: string;
  reason: ReposReason;
  current: SlideId | null;
};

/** The live git check. The reply is the engine's `ReposReply` plus `gate`, `heldAt`, `uncommittedAt` and
 *  `unknownRepos` (or those four alone, `gate: "noResult"`); its typed model is `git-detail.ts`'s. */
export function reposStatus<R = unknown>(request: ReposStatusRequest): Promise<R> {
  return invoke<R>("repos_status", { request });
}

/* ── the live calendar details (briefing redesign C, wave-2 plan C-M3-T9) ──────────────────────────────────────────
 * Today's meeting links, people and notes, read live in Rust and never saved (`src-tauri/src/calendar_details.rs`).
 * ⚠ NO REPLY CARRIES A URL: an event names only its Join host, and Join is by handle, opened by Rust. Every request is
 * `deny_unknown_fields` Rust-side, so a URL cannot be sent either. Callers: Today's driver (`open`), the meeting card
 * and tile (`get`, `join`, `app`). */

/** Why the webview asks: `became-current` ONLY for the user's own move onto the calendar slide or the launchpad. */
export type CalendarDetailsReason = "became-current" | "focus" | "timer";

/** One live event (`EventView`): no URL, only the Join host. */
export interface CalendarDetailsEvent {
  handle: string;
  title: string;
  location: string | null;
  rowText: string;
  time: unknown;
  status: string;
  ended: boolean;
  linkState: "none" | "one" | "several";
  joinHost: string | null;
  serviceName?: string;
  needsConfirm: boolean;
  fromMac: boolean;
}

/** One source (`SourceView`): `status` only when it was read; a skipped source shows `last` ("not read yet" when null). */
export interface CalendarDetailsSource {
  id: string;
  kind: string;
  status?: string;
  reason?: string;
  skipped: boolean;
  last: { status: string; reason?: string; at: string } | null;
}

export type CalendarDetailsOpenReply =
  | { gate: "none" }
  | { refused: "hidden" | "calendar-off" }
  | { failed: string }
  | {
      gate: "held" | "read";
      readAt: string;
      readerOutdated: boolean;
      events: CalendarDetailsEvent[];
      sources: CalendarDetailsSource[];
    };

export type CalendarDetailsGetReply =
  /** Null people means the details were unavailable; an empty list means there were no other attendees. `notes` is the
   *  core view's; `otherNotes` (calendar near-duplicates spec §5) each other merged view's, in merge order, its title
   *  null when it equals the shown title. Missing on an unmerged event or from an older engine. */
  | { people: { name: string | null; organiser: boolean }[] | null; notes: string | null; otherNotes?: { title: string | null; notes: string }[] }
  | { refused: "stale" };

export type CalendarJoinReply =
  | { opened: true }
  | { ask: string; serviceName?: string }
  | { refused: "stale" | "several" | "no-link" | "invalid-link" }
  | { failed: "opener" };

/** Ask for today's live details; Rust decides whether to read (`decide`). `current` is the deck's current slide. */
export function calendarDetailsOpen(reason: CalendarDetailsReason, current: SlideId | null): Promise<CalendarDetailsOpenReply> {
  return invoke<CalendarDetailsOpenReply>("calendar_details_open", { request: { reason, current } });
}

/** One card's people and notes, from Rust's map by handle (reads nothing). */
export function calendarDetailsGet(handle: string): Promise<CalendarDetailsGetReply> {
  return invoke<CalendarDetailsGetReply>("calendar_details_get", { request: { handle } });
}

/** Join by handle; `confirmed` only after the user answered the ask-first question. */
export function calendarJoin(handle: string, confirmed: boolean): Promise<CalendarJoinReply> {
  return invoke<CalendarJoinReply>("calendar_join", { request: { handle, confirmed } });
}

/** Open in Calendar (macOS only): the Calendar app itself, nothing from the event. */
export function calendarAppOpen(): Promise<void> {
  return invoke<void>("calendar_app_open");
}

/* ── opening things from the deck (briefing redesign B2, wave-3 plan B2-M4-T12) ────────────────────────────────────
 * GitHub links, the copied push command and Open in editor (`src-tauri/src/actions.rs`, `editor.rs`).
 * ⚠ THE WEBVIEW NAMES A HANDLE, A STABLE PROJECT KEY OR A CLOSED EDITOR TOKEN, NEVER A URL, PATH OR COMMAND, and no reply
 * carries one. What a click opens or copies is read from what Rust holds, and Rust judges it again at the click. A reply's
 * code is the whole answer; each is a value here rather than a rejection, because Rust answers it as one. */

export type OpenGithubReply =
  | { opened: true }
  | { refused: "stale" | "links-off" | "unknown-repo" | "not-pushed" | "invalid-target" | "ambiguous" | "host" }
  | { failed: "opener" };

export type CopyPushCommandReply =
  | { copied: true }
  /** At least one command's remote is `origin` only because nothing selected one among several. A fixed word, never a name. */
  | { copiedToOrigin: true }
  | { refused: "stale" | "unknown-repo" | "unsafe-name" | "no-remote" | "ambiguous" | "name-mismatch" | "transport" }
  | { failed: "clipboard" };

/** One project a choice can be remembered for. `not-checked`: configured, with no key from the engine yet, so no choice. */
export interface EditorProjectRow {
  project: string | null;
  label: string;
  choice: EditorChoice | null;
  availability: "ready" | "not-checked";
}

export type EditorListReply =
  | {
      editors: { editor: EditorId; label: string }[];
      projects: EditorProjectRow[];
      discoveryConfigured: boolean;
      /** Only when the ask named a handle; `null` with no editor installed. */
      preselect?: EditorId | null;
    }
  | { refused: "unsupported" | "stale" }
  | { failed: "detection" };

export type EditorOpenReply =
  | { opened: true }
  | { refused: "unsupported" | "stale" | "no-editor" | "invalid-folder" }
  | { failed: "editor" };

export type EditorChoiceSetReply =
  | { saved: true; revision: number }
  | { refused: "unsupported" | "stale" | "unknown-editor" | "preferences-full" }
  | { failed: "preferences" };

/** Open one held GitHub target by handle. */
export function openGithub(handle: string): Promise<OpenGithubReply> {
  return invoke<OpenGithubReply>("open_github", { request: { handle } });
}

/** Copy the push command of one card's held branches, by handle. Rust builds the text; the reply never holds it. */
export function copyPushCommand(handles: string[]): Promise<CopyPushCommandReply> {
  return invoke<CopyPushCommandReply>("copy_push_command", { request: { handles } });
}

/** The installed editors and the project inventory; with a held editor handle, also that folder's `preselect`. */
export function editorList(handle?: string): Promise<EditorListReply> {
  return invoke<EditorListReply>("editor_list", { request: handle === undefined ? {} : { handle } });
}

/** Open a held folder in a named editor, by handle. */
export function editorOpen(handle: string, editor: EditorId): Promise<EditorOpenReply> {
  return invoke<EditorOpenReply>("editor_open", { request: { handle, editor } });
}

/** Remember a project's editor, or `"ask"`, by the project's stable key. */
export function editorChoiceSet(project: string, editor: EditorChoice): Promise<EditorChoiceSetReply> {
  return invoke<EditorChoiceSetReply>("editor_choice_set", { request: { project, editor } });
}

/* ── the stored AI summary (briefing redesign A2, plan A2-M4-T13) ──────────────────────────────────────────────────
 * Rust re-checks the page's identity and revalidates every stored point and sentence (`src-tauri/src/summary.rs`).
 * Stored keys are checked by syntax only, so card membership is the caller's. The request is two 64-hex identities
 * and `deny_unknown_fields`, so a path cannot be sent; no raw response or filesystem error comes back. */

/** One project's stored points (`summary::SummaryProject`). */
export interface SummaryProject {
  key: string;
  points: string[];
}

/** A code a stored record can carry (`src/summary/store.ts`). Rust's enum also holds `summary-config-invalid`, which
 *  appears in status only: a record carrying it is refused whole, so a reply never holds it. */
export type SummaryWarningCode = "summary-unavailable" | "summary-text-omitted" | "summary-usage-limit";

/** `warnings` are fixed codes, never text. `{ state: "unavailable", warnings: [] }` is also ordinary absence. */
export type SummaryReply =
  | {
      state: "ready";
      pageHash: string;
      pageVersion: string;
      revision: number;
      projects: SummaryProject[];
      goodMorningSentence: string | null;
      warnings: SummaryWarningCode[];
    }
  | { state: "pending" | "unavailable"; warnings: SummaryWarningCode[] };

/** Why the read refused (`summary::SummaryReadError`): only a bad identity. Every other failure is ordinary absence. */
export type SummaryReadError = { kind: "invalidOperand" };

/** The summary bound to this page identity. Rejects with a `SummaryReadError` only for a bad identity. */
export function readLatestSummary(pageHash: string, pageVersion: string): Promise<SummaryReply> {
  return invoke<SummaryReply>("read_latest_summary", { request: { pageHash, pageVersion } });
}

/**
 * ⚠ TWO ENGINE SURFACES HAVE NO WRAPPER HERE, ON PURPOSE, and the capability grants neither:
 *
 *   - `init` and its provider flags — the first-run wizard (T16). The Settings screen (T15, B5)
 *     edits an EXISTING config through `config_save` (`lib/files.ts`) and never runs `init`.
 *   - `calendar add-link` / `remove-link` — they read the URL on STDIN, which the app's spawns never
 *     give the engine; the Rust side writes and removes the managed link file itself
 *     (`lib/calendar.ts`). (`calendar` as a whole was on this list until v0.3.0's M8 added the four
 *     operations above, in the same release as the engine's M5 subcommands.)
 *
 *
 * And one OPERATION has no command of its own: `provider test` takes a candidate FILE, so the webview
 * reaches it only through `providerCandidateCheck` above, which stages the file in Rust (PR 3).
 *
 * `schedule verify` was on this list until B6 (T20) — the kickstart is still ENGINE-SIDE, and that
 * wrapper re-issues the same engine-side kick — and `update --check` was until Phase E, when E11 gave
 * the engine the subcommand and E12 added `updateCheck()` above.
 */
