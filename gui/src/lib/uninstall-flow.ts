/**
 * T20's uninstall: the confirmation copy, and what the panel shows after an attempt. PURE, so both
 * are tested without a webview (`gui/tests-web/access.check.ts`).
 *
 * ⚠ THE CONFIRMATION NAMES THE FILE AND THE CONSEQUENCE, and neither half is decoration. The
 * appendix's own T20 requires *"an explicit confirmation naming the file being removed"*; the
 * consequence — no more briefings until a scheduler is installed again — is the other half, because
 * under plan R1 the OS trigger is the ONLY thing that delivers (there is no app-owned tick), so
 * removing it stops the product. Batch 2 (spec 3.4.8): it names a file only when a unit file IS
 * there — with none, `unitPath` is the engine's computed default, a file nobody found — and says what
 * stops by the scheduler's LABEL, which is how the engine unregisters it (`bootout`, `stop`).
 *
 * ⚠ AND A SCHEDULER THIS APP DID NOT SET UP IS NOT REMOVED BY DEFAULT. `docs/gui-seam.md` §3: the app
 * removes with `--invoker app`, and the engine refuses (exit 2) whenever something is installed that
 * no readable record says this app set up — a terminal record, a malformed one, a unit or a
 * registration with no record (Batch 2 spec 3.1.1) — unless `--take-over` is passed. Taking it over is
 * a second, explicit confirmation, which shows what the engine found.
 */
import type { EngineOutcome } from "./engine";
import { LEAD_NO_OWNER, manualStepsClosing } from "./app-uninstall";
import type { Os } from "./platform";
import type { ScheduleState } from "./state";
// ⚠ THE SAME `Stage` AS THE INSTALL FLOW'S, imported rather than redeclared: both are drawn by the
// same three arms and share `ForeignOwnerDialog`, so a second five-member union would be a copy
// that could drift by one member without either side noticing.
import type { StageResult } from "./install-flow";

/** The copy the first confirmation shows. */
export interface UninstallConfirmation {
  /** The unit file that will be removed: `ScheduleState.unitPath`, but only when `unitPresent` says a
   *  unit file is there. `null` otherwise — then the engine's path is a computed default. */
  unitPath: string | null;
  /** Who owns the record now (`ScheduleState.owner`). When it is not this app — `cli`, or nothing
   *  readable — the engine refuses the first attempt (exit 2), and `body` says a second confirmation
   *  follows. Also `null` with NO state read at all (M9 round 2), when it is unknown rather than absent,
   *  and `body` then says nothing about who set the scheduler up. */
  owner: "cli" | "app" | null;
  /** What will be removed, in words. */
  title: string;
  /** What stops. Rendered as text. */
  body: string;
  /** The destructive button's label. */
  confirmLabel: string;
}

/**
 * What stops, by the scheduler's label (spec 3.4.8): the engine unregisters by the exact label, never
 * through whatever a file names.
 *
 * ⚠ ON macOS IT CLAIMS A LOADED JOB ONLY WHEN ONE MAY BE THERE (checkpoint M6b). With `registered`
 * `false` — a record or a unit file with nothing loaded, as in the scheduler-broken phase when the unit is
 * there — the check found no job, so it says the label is unregistered only if it is still loaded. `true` and `null` (the check could
 * not run) keep the spec's wording. With no state read at all (`undefined`, M9 round 2) nothing is known,
 * so it claims no loaded job either. Linux's and the plain wording claim nothing is loaded.
 *
 * @param registered `ScheduleState.registered` as the panel last saw it — `null` when the check could not
 *   run — or `undefined` when there is no state
 */
function stops(os: Os, registered: boolean | null | undefined): string {
  if (os === "macos") {
    return registered === true || registered === null
      ? "unloads the loaded job `local.daily-briefing`"
      : "unregisters `local.daily-briefing` if it is still loaded";
  }
  if (os === "linux") return "stops the `daily-briefing` timer and service";
  return "unregisters the background scheduler from the operating system";
}

/**
 * The first confirmation, worded for the state the panel last saw.
 *
 * ⚠ IT NEVER CLAIMS TO KNOW A FILE IT WAS NOT TOLD ABOUT. With no unit file present the body names no
 * path — not even the one `schedule status --json` computes when there is none (spec 3.4.8) — and says
 * what stops instead. The whole design keeps unit paths on the engine's side.
 *
 * ⚠ NOR ANYTHING FROM A STATE IT DOES NOT HAVE (M9 round 2). The control can be drawn with no state (a failed
 * removal, then a refresh that read nothing), and then the owner is unknown, not absent: no ownership sentence
 * at all — an app-owned scheduler would get no second confirmation, so promising one would be wrong, and the
 * engine's own refusal (exit 2) brings the second question whenever it is needed — and no loaded job.
 *
 * @param os the OS this window runs on (`platform.ts`), for what stops
 */
export function uninstallConfirmation(state: ScheduleState | null, os: Os): UninstallConfirmation {
  const unitPath = state?.unitPresent === true ? state.unitPath : null;
  const owner = state?.owner ?? null;
  const stopped = stops(os, state?.registered);
  const what =
    unitPath !== null
      ? `This removes the background scheduler's trigger file, ${unitPath}, and ${stopped}.`
      : `This ${stopped}.`;
  const consequence =
    " Nothing will generate a briefing after that — not on a timer, and not while this app is open — until a scheduler is installed again. Your config, your settings and every briefing already in the archive are untouched.";
  // Spec 3.4.3: a null owner has its own wording, never the terminal's. No state: no ownership sentence.
  const ownership =
    state === null
      ? ""
      : owner === "cli"
        ? " This schedule was installed from the command line, not by this app, so removing it needs a second confirmation."
        : owner === null
          ? " Nothing records who set up this background scheduler. Removing it needs a second confirmation."
          : "";
  return {
    unitPath,
    owner,
    title: "Remove the background scheduler?",
    body: `${what}${consequence}${ownership}`,
    confirmLabel: "Remove the background scheduler",
  };
}

/**
 * What the panel shows after one `schedule uninstall --invoker app [--take-over]`.
 *
 * ⚠ EXIT 1 IS "NOTHING WAS INSTALLED", AND IT IS KEYED ON THE EXIT CODE. `docs/gui-seam.md` §3: the
 * classifier invents no reason string for it, so it arrives as `{ kind: "failed", reason: null }` with
 * `exitCode: 1`. Batch 2 (spec 3.4.7): the line is the ENGINE's own stdout line, which a genuine exit 1
 * always prints; an exit 1 with nothing on stdout is a crash (spec §2 point 17) and shows as failed,
 * with its stderr.
 *
 * ⚠ AND EVERY EXIT 2 WITHOUT TAKE-OVER IS THE FOREIGN-OWNER STAGE, WHATEVER OWNER THE SCREEN LAST READ
 * (Batch 2 spec 3.4.3). Uninstall has no confirmation gate, so its exit 2 only ever means "not yours",
 * and the cached owner can be stale — so it is not an input here (`install-flow.ts`'s `afterInstall`
 * still keys on it, because install's exit 2 is also a withheld confirmation). The stage carries the
 * engine's stderr, which names what was found — including the unit files a take-over removes. A
 * take-over refused again is a failure, never a second dialog.
 *
 * Exit 3 (spec 3.4.6) and anything else show the engine's stderr verbatim; the panel offers Try again.
 *
 * @param takeOver whether this attempt already passed `--take-over`
 */
export function afterUninstall(outcome: EngineOutcome, takeOver: boolean): StageResult {
  // ⚠ VERBATIM (checkpoint M6b): never trimmed — leading whitespace and line breaks are the engine's, and
  // the screen draws it pre-wrapped. Only a stderr of nothing but whitespace counts as having said nothing.
  const stderr = outcome.stderr.trim() !== "" ? outcome.stderr : "";
  const stdout = outcome.stdout.trim();
  if (outcome.operation === "schedule-uninstall" && outcome.exitCode === 1) {
    return stdout !== "" ? { stage: "done", message: stdout } : { stage: "failed", message: stderr };
  }
  switch (outcome.outcome.kind) {
    case "delivered":
      return { stage: "done", message: stdout };
    case "configError":
      return { stage: takeOver ? "failed" : "foreign-owner", message: stderr };
    default:
      return { stage: "failed", message: stderr !== "" ? stderr : stdout };
  }
}

/**
 * The foreign-owner dialog's lead for the removal (spec 3.4.3): with no owner on record, "A background
 * scheduler is set up, but nothing records who set it up." — the Uninstall screen's lead for the same
 * case (`app-uninstall.ts`). Otherwise `undefined`, so `ForeignOwnerDialog` keeps today's lead, as the
 * install flow's dialog does. With NO state read the caller passes no lead at all (`ScheduleUninstall`, M9
 * round 2): an unknown owner is not a null one.
 *
 * @param owner `ScheduleState.owner` as the panel last saw it
 */
export function foreignOwnerLead(owner: string | null): string | undefined {
  return owner === null ? LEAD_NO_OWNER : undefined;
}

/** "Keep the existing one" (spec 3.4.5): the flow ends here, and says that nothing changed. */
export function afterKeep(): StageResult {
  return { stage: "done", message: "Kept — nothing was removed." };
}

/**
 * The line the Schedule screen shows once a removal attempt has ended (spec 3.4.4).
 *
 * ⚠ ITS TEXT IS THE ENGINE'S, VERBATIM — rendered as text, never markup — or the app's own short word
 * when the engine said nothing. When it carries the manual steps, `closing` is the app's own closing
 * line, said once after it (spec 3.1.8 "Framing"; plan SQ6): the engine's `--invoker app` stderr ends the
 * steps with none.
 */
export interface UninstallLine {
  /** `done` — removed, nothing installed, or kept — is drawn quietly; `failed` in the danger colour. */
  kind: "done" | "failed";
  line: string;
  closing: string | null;
}

/** An ended attempt's line; `null` while there is none to show (idle, running, or the foreign-owner
 *  dialog, which asks instead). */
export function uninstallLine(result: StageResult): UninstallLine | null {
  if (result.stage === "done") {
    return { kind: "done", line: result.message !== "" ? result.message : "Removed.", closing: manualStepsClosing(result.message) };
  }
  if (result.stage === "failed") {
    return {
      kind: "failed",
      line: result.message !== "" ? result.message : "That did not work.",
      closing: manualStepsClosing(result.message),
    };
  }
  return null;
}
