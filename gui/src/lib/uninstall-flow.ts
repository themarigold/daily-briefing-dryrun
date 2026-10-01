/**
 * T20's uninstall: the confirmation copy, and what the panel shows after an attempt. PURE, so both
 * are tested without a webview (`gui/tests-web/access.check.ts`).
 *
 * ⚠ THE CONFIRMATION NAMES THE FILE AND THE CONSEQUENCE, and neither half is decoration. The
 * appendix's own T20 requires *"an explicit confirmation naming the file being removed"*; the
 * consequence — no more briefings until a scheduler is installed again — is the other half, because
 * under plan R1 the OS trigger is the ONLY thing that delivers (there is no app-owned tick), so
 * removing it stops the product.
 *
 * ⚠ AND A FOREIGN OWNER IS NOT UNINSTALLED BY DEFAULT. `docs/gui-seam.md` §3: the app installs with
 * `--invoker app`, and a record owned by someone else is REFUSED with exit 2 unless `--take-over` is
 * passed. The app is a VIEWER of a CLI-owned schedule; taking it over is a second, explicit
 * confirmation naming both the file and the owner it replaces.
 */
import type { EngineOutcome } from "./engine";
import type { ScheduleState } from "./state";
// ⚠ THE SAME `Stage` AS THE INSTALL FLOW'S, imported rather than redeclared: both are drawn by the
// same three arms and share `ForeignOwnerDialog`, so a second five-member union would be a copy
// that could drift by one member without either side noticing.
import type { StageResult } from "./install-flow";

/** The copy the first confirmation shows. */
export interface UninstallConfirmation {
  /** `ScheduleState.unitPath` — the file that will be removed. `null` when the engine reports none. */
  unitPath: string | null;
  /** Who owns the record now (`ScheduleState.owner`). */
  owner: "cli" | "app" | null;
  /** True when the owner is not this app, so removing it needs the take-over confirmation. */
  foreign: boolean;
  /** What will be removed, in words. */
  title: string;
  /** What stops. Rendered as text. */
  body: string;
  /** The destructive button's label. */
  confirmLabel: string;
}

/**
 * The first confirmation, worded for the state the panel last saw.
 *
 * ⚠ IT NEVER CLAIMS TO KNOW A FILE IT WAS NOT TOLD ABOUT. With no `unitPath` the body says so
 * rather than naming a path this app computed — the whole design keeps unit paths on the engine's
 * side (`schedule status --json`).
 */
export function uninstallConfirmation(state: ScheduleState | null): UninstallConfirmation {
  const unitPath = state?.unitPath ?? null;
  const owner = state?.owner ?? null;
  const foreign = owner !== null && owner !== "app";
  const what =
    unitPath !== null
      ? `This removes the background scheduler's trigger file, ${unitPath}, and unloads it from the operating system.`
      : "This removes the background scheduler's trigger and unloads it from the operating system. The engine did not report a file path for it.";
  const consequence =
    " Nothing will generate a briefing after that — not on a timer, and not while this app is open — until a scheduler is installed again. Your config, your settings and every briefing already in the archive are untouched.";
  const ownership = foreign
    ? ` This schedule was installed from the command line, not by this app, so removing it needs a second confirmation.`
    : "";
  return {
    unitPath,
    owner,
    foreign,
    title: "Remove the background scheduler?",
    body: `${what}${consequence}${ownership}`,
    confirmLabel: "Remove the background scheduler",
  };
}

/**
 * What the panel shows after one `schedule uninstall --invoker app [--take-over]`.
 *
 * ⚠ EXIT 1 IS "THERE WAS NOTHING TO REMOVE", AND IT IS KEYED ON THE EXIT CODE. `docs/gui-seam.md`
 * §3: the classifier invents no reason string for it, so it arrives as
 * `{ kind: "failed", reason: null }` with `exitCode: 1` — and a panel keying on `reason` would show
 * an empty error for a perfectly ordinary outcome. The key is
 * `operation === "schedule-uninstall" && exitCode === 1`.
 *
 * ⚠ AND A FOREIGN OWNER IS DECIDED FROM `owner`, NOT FROM EXIT 2 ALONE — the same rule
 * `install-flow.ts`'s `afterInstall` follows, for the same reason: exit 2 is also a withheld
 * confirmation and every other engine refusal, and offering "take over" for those would be a
 * destructive button answering a question nobody asked.
 *
 * @param takeOver whether this attempt already passed `--take-over`
 * @param owner `ScheduleState.owner` as the panel last saw it
 */
export function afterUninstall(
  outcome: EngineOutcome,
  takeOver: boolean,
  owner: string | null,
): StageResult {
  const stderr = outcome.stderr.trim();
  if (outcome.operation === "schedule-uninstall" && outcome.exitCode === 1) {
    return {
      stage: "done",
      message:
        "There was nothing to remove — no background scheduler is installed for this engine.",
    };
  }
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
