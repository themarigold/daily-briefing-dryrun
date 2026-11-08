/**
 * What the "Install / repair scheduler" flow shows after an attempt. PURE, so the rule is tested
 * without a webview (`gui/tests-web/render.check.ts`).
 *
 * ⚠ A FOREIGN OWNER IS DECIDED FROM `schedule status`'s `owner`, NOT FROM EXIT 2 ALONE. The engine
 * refuses `schedule install --invoker app` over a record whose `owner` is not `app`
 * (`src/schedule/install.ts`, `existing.owner !== invoker && !takeOver`) with exit 2 — but exit 2 is
 * also a withheld confirmation (Windows' unconfirmed registration) and every other engine refusal
 * (`docs/gui-seam.md` §3). Offering "take over" for those would be a destructive button answering a
 * question nobody asked, so they show the engine's stderr verbatim instead.
 */
import type { EngineOutcome } from "./engine";

export type Stage = "idle" | "running" | "foreign-owner" | "done" | "failed";

export interface StageResult {
  stage: Stage;
  /** Engine output, verbatim (trimmed). Rendered as text. */
  message: string;
}

/**
 * Whether a completed install attempt should ARM the post-install verification loop.
 *
 * ⚠ ONLY A `done` INSTALL KICKS (round 1). The loop's kick makes the LIVE launchd job run the
 * engine — a mutating side effect — and the shipped B6 wiring bumped the trigger for EVERY
 * completed attempt, so a foreign-owner REFUSAL (exit 2) opened the keep-or-take-over dialog and
 * simultaneously kicked the CLI's live job: a mutation riding on a refused action. This predicate
 * is the ONE place that gate lives (`ScheduleInstall.svelte` applies it to `afterInstall`'s
 * stage); there is nothing to verify about an install that did not happen.
 */
export function armsVerify(stage: Stage): boolean {
  return stage === "done";
}

/**
 * Whether the install control is BUSY — its call is running, or its foreign-owner dialog is open and waiting for
 * Keep or Take over (design 2026-10-31 r6 §3). The wizard holds Back, Finish and "Finish setup later" on it:
 * leaving would unmount the control mid-install or with the dialog unanswered. `ScheduleInstall` reports it
 * through its optional `onbusy` on every stage change.
 */
export function installBusy(stage: Stage): boolean {
  return stage === "running" || stage === "foreign-owner";
}

/**
 * @param takeOver whether this attempt already passed `--take-over`
 * @param owner `ScheduleState.owner` as the screen last saw it — `null` when there is no record
 */
export function afterInstall(
  outcome: EngineOutcome,
  takeOver: boolean,
  owner: string | null,
): StageResult {
  const stderr = outcome.stderr.trim();
  switch (outcome.outcome.kind) {
    case "delivered":
      return { stage: "done", message: outcome.stdout.trim() };
    case "configError":
      if (!takeOver && owner !== null && owner !== "app") {
        return { stage: "foreign-owner", message: stderr };
      }
      return { stage: "failed", message: stderr };
    default:
      return { stage: "failed", message: stderr !== "" ? stderr : outcome.stdout.trim() };
  }
}

/**
 * What the older-background-engine warning offers (spec §6, P3-M6-T2): `"update"` — this app's own
 * "Update background engine" install — only for an APP-owned schedule; words otherwise: `"cli"` for a
 * CLI-owned schedule (update it from the command line), `"unknown"` when the owner is `null` or one
 * this app does not know (PR 3 final r5, H6: it cannot say who installed it, so it does not claim
 * the command line did).
 *
 * ⚠ A CLI-OWNED (or unknown-owner) SCHEDULE NEVER ROUTES INTO AN INSTALL. This app's install over a
 * record it does not own is refused with exit 2 and lands in the foreign-owner stage above
 * (`afterInstall`), whose keep-or-take-over dialog belongs to install refusals — not to a warning
 * about an engine the CLI installed. The remedy there is to update that engine the way it was
 * installed, which the screen says in words.
 */
export function olderEngineRemedy(owner: string | null): "update" | "cli" | "unknown" {
  return owner === "app" ? "update" : owner === "cli" ? "cli" : "unknown";
}
