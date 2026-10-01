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
