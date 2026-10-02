/**
 * B25 (T25) — the "Uninstall app" Settings action's webview half.
 *
 * ⚠ THIS FILE IS THE WIRE CONTRACT for `src-tauri/src/uninstall.rs`: every field and every tag
 * mirrors the Rust `Serialize` types exactly. Change them together or not at all.
 *
 * ⚠ NO DECISION LIVES HERE. WHAT may be removed is Rust's: the app-file list is enumerated in
 * `uninstall.rs` (the module constants), the engine-state list mirrors `scripts/uninstall.sh`'s
 * bounded list and is pinned against it at test time, and the engine state dir is the ENGINE's
 * answer — the webview can name no path. What lives here is the invoke wrappers, the consent
 * boolean, and the WORDING — which must name the briefing archive out loud, because the
 * consented leg is the one surface in this app that can remove it.
 */
import { invoke } from "@tauri-apps/api/core";

export type EntryKind = "file" | "glob" | "dir";

export type PreviewEntry = { name: string; kind: EntryKind; present: boolean };

export type UninstallPreview = {
  appDataDir: string;
  appConfigDir: string;
  appEntries: PreviewEntry[];
  /** `status --json`'s `paths.stateDir`; `null` with `engineError` set when the engine could not answer. */
  engineStateDir: string | null;
  engineError: string | null;
  engineEntries: PreviewEntry[];
  /** `is_enabled()`'s answer; `null` when it could not be read. */
  autostartEnabled: boolean | null;
  autostartError: string | null;
  /** Whether the engine's `schedule.json` is there. While it is, a consented run removes NOTHING
   *  of the engine's (the schedule it records would keep running the engine copy and re-create
   *  what was removed) and reports {@link UninstallReport.engineRefused} instead; {@link
   *  consentLabel} says so, with the way out, before consent is given. `false` when the engine
   *  state dir was not resolved — UNKNOWN then, not absent: `engineError` is set (cap round). */
  scheduleRecordPresent: boolean;
  /** The first scheduler unit file the engine writes (Rust's `schedule_unit_files`) that is there,
   *  with or without a record; `null` when none is. A consented run refuses while one is (an older
   *  install's record-less unit runs the very engine copy the box would delete), so
   *  {@link consentLabel} reads it too. */
  scheduleUnitFile: string | null;
  /** `std::env::consts::OS` (`"macos"`, `"linux"`, …): where the engine copy lives is per platform. */
  os: string;
};

export type RemovalOutcome =
  | { result: "removed" }
  | { result: "absent" }
  | { result: "failed"; detail: string };

export type ActionReport = { name: string; outcome: RemovalOutcome };

export type UninstallReport = {
  autostart: RemovalOutcome;
  app: ActionReport[];
  /** True when at least one engine entry was ACTUALLY removed — derived from the outcomes, not
   *  echoed from the consent flag (consent over an empty dir, or with every removal refused,
   *  reports false). */
  engineStateRemoved: boolean;
  /** Empty unless consented — and empty when the leg was refused ({@link engineRefused}). */
  engine: ActionReport[];
  /** Set when consent was given but a schedule record — or, with none, a scheduler unit file — was
   *  there, so the engine leg removed NOTHING: ONE refusal for the whole leg (Rust's
   *  `REFUSED_FOR_SCHEDULE`, or `refused_for_unit` naming the unit), naming the way out. */
  engineRefused: string | null;
  /** The directory the consented engine leg targeted (`status --json` re-resolved at execute
   *  time, the same call path the preview used); `null` when the leg was not attempted or the
   *  engine could not answer; set on a refusal too (the directory the refused leg targeted). The
   *  done view renders it so the consented target is auditable. */
  engineStateDir: string | null;
  engineError: string | null;
  /** Whether `schedule.json` was there at EXECUTE time — read whether or not the box was ticked, so
   *  {@link doneNotes} warns from what is on disk after the run, not from the preview. `null` when
   *  the engine could not name its state dir at execute time (unknown, not absent). */
  scheduleRecordPresent: boolean | null;
  /** The unit file there at EXECUTE time, or `null` — ticked or not; the record's look (G4-L1). */
  scheduleUnitFile: string | null;
  /** `std::env::consts::OS` — the last step (how the app itself is removed) is per platform. */
  os: string;
};

/** Read-only: one engine spawn (`status --json`), one `is_enabled()` read, and `lstat`s. */
export function uninstallPreview(): Promise<UninstallPreview> {
  return invoke<UninstallPreview>("uninstall_preview");
}

/** Perform it. `removeEngineState` is the EXPLICIT consent for the engine-data leg. */
export function uninstallExecute(removeEngineState: boolean): Promise<UninstallReport> {
  return invoke<UninstallReport>("uninstall_execute", { removeEngineState });
}

/* ── the wording, pure so `tests-web` can pin it ──────────────────────────────────────────────── */

/** What the un-consented action does — the app's own pieces only. Shown before the preview, so
 *  before this app has asked Rust which platform it is on: the last sentence names both. */
export const UNINSTALL_EXPLANATION =
  "Removes this app's background pieces: its start-at-login entry and its own settings files. " +
  "Your briefings, your configuration and the background engine are not touched unless you also " +
  "tick the box below. The app itself is removed afterwards: on macOS by dragging it out of " +
  "Applications, on Linux by removing the .deb or deleting the AppImage.";

/**
 * The Schedule screen's own removal button (`ScheduleUninstall.svelte`) — the way out the
 * schedule-record refusal names. `tests-web/coexistence.check.ts` pins it against the RENDERED
 * button and `tests/uninstall.rs` against the component's source, so a rename cannot leave the
 * advice pointing at nothing.
 */
export const REMOVE_SCHEDULE_BUTTON = "Remove background scheduler…";

/** The way out of an installed schedule, as a clause: the Schedule screen's button for a schedule
 *  this app installed, the engine's own subcommand for one installed from a terminal. Shared by
 *  {@link SCHEDULE_RECORD_RULE} and the done view's warning ({@link doneNotes}). */
export const SCHEDULE_WAY_OUT =
  `remove the schedule first (Schedule screen → ${REMOVE_SCHEDULE_BUTTON}), or run ` +
  "`daily-briefing schedule uninstall` if you installed it from the terminal";

/**
 * The way out of a STALE record (Phase E final harden round 3, B3-L1) — one the way out above
 * cannot reach: an unparseable or dangling `schedule.json` still refuses the engine leg, but the
 * Schedule screen then draws no removal button and `daily-briefing schedule uninstall` exits
 * "Nothing installed" before it unlinks the record (`src/schedule/install.ts`,
 * `uninstallSchedule`). The SHARED sentence, word for word: `docs/INSTALL.md` carries the same.
 */
export const STALE_RECORD_CLAUSE =
  "If the Schedule screen shows no schedule and `daily-briefing schedule uninstall` reports " +
  "nothing installed, the record is stale: delete `schedule.json` from the engine's folder, then " +
  "run Uninstall again.";

/**
 * The one sentence for the schedule-record rule. `docs/INSTALL.md` and `scripts/uninstall.sh` state
 * the same RULE in their own words (INSTALL.md has the stale-record clause that ends this word for
 * word); Rust's `REFUSED_FOR_SCHEDULE` carries this sentence verbatim. Uninstall removes none of the
 * engine's data while a schedule is installed: it would keep running the engine copy.
 */
export const SCHEDULE_RECORD_RULE =
  "Uninstall removes none of the engine's data while a background schedule is installed: " +
  `${SCHEDULE_WAY_OUT}, then run Uninstall again. ${STALE_RECORD_CLAUSE}`;

/**
 * The way out of a record-LESS scheduler unit file (Phase E final harden round 4, B4-L6), as a
 * clause. Not {@link SCHEDULE_WAY_OUT}: the Schedule screen offers its removal only where there is a
 * record (`routes/Schedule.svelte` draws `ScheduleUninstall` under `recordPresent`), and the engine's
 * own subcommand unloads and unlinks a present unit with no record (`src/schedule/install.ts`,
 * `uninstallSchedule`).
 */
export const UNIT_WAY_OUT =
  "run `daily-briefing schedule uninstall` in a terminal, which removes that unit file";

/**
 * The rule sentence for a record-LESS unit (round 4, B4-L6) — its own, the way out first, and no
 * stale-RECORD clause: there is no record to delete. Rust's `REFUSED_FOR_UNIT_RULE` is this
 * sentence, word for word (`tests-web/coexistence.check.ts` parses it), carried by the refusal
 * `refused_for_unit` reports — last, but for a systemd unit's exact command (cap round, G5-2).
 */
export const SCHEDULE_UNIT_RULE =
  "Uninstall removes none of the engine's data while a background scheduler unit file is there: " +
  `${UNIT_WAY_OUT}, then run Uninstall again.`;

/** Why a systemd unit needs its own command (cap round, G5-2) — Rust's `UNIT_DIR_CLAUSE`, word for
 *  word (`tests-web/coexistence.check.ts` parses it); it ends {@link unitCommandNote}. */
export const UNIT_DIR_CLAUSE =
  "`daily-briefing schedule uninstall` looks for it only under `$XDG_CONFIG_HOME/systemd/user`, or " +
  "`~/.config/systemd/user` when XDG_CONFIG_HOME is unset.";

/**
 * The command that removes a unit file from a terminal when it is a systemd unit —
 * `<config>/systemd/user/<name>`, the Linux shape of Rust's `schedule_unit_files` — else `null` (the
 * macOS plist: the rule's own command stands). Cap round (G5-2): this app looks under BOTH
 * `$XDG_CONFIG_HOME/systemd/user` and `~/.config/systemd/user`, but `daily-briefing schedule
 * uninstall` looks only under the one ITS environment names (`src/schedule/install.ts`, `unitDir`),
 * so from a terminal with another `XDG_CONFIG_HOME` it reports nothing installed and the unit keeps
 * refusing. The command sets `XDG_CONFIG_HOME` to the unit's own config directory, single-quoted for a
 * POSIX shell (each `'` as `'\''`). Rust's `unit_uninstall_command` is the same rule. Text only:
 * every string here is `{}`-interpolated, never `{@html}`.
 */
export function unitUninstallCommand(unitFile: string): string | null {
  const config = /^([\s\S]+)\/systemd\/user\/[^/]+$/.exec(unitFile)?.[1];
  if (config === undefined) return null;
  return `XDG_CONFIG_HOME='${config.split("'").join("'\\''")}' daily-briefing schedule uninstall`;
}

/** The sentence beside the unit's way out for a unit {@link unitUninstallCommand} has a command for
 *  (the rule constants cannot carry the path), as a suffix with its leading space; `""` otherwise.
 *  Rust's `unit_command_note` is the same sentence. */
function unitCommandNote(unitFile: string): string {
  const command = unitUninstallCommand(unitFile);
  return command === null
    ? ""
    : ` To remove this unit file from a terminal, run \`${command}\`: ${UNIT_DIR_CLAUSE}`;
}

/** Whether a consented run will refuse the engine leg, as far as the preview can tell: a schedule
 *  record, or a scheduler unit file, is there (Rust's `remove_engine_state`). */
export function scheduleBlocks(preview: UninstallPreview): boolean {
  return preview.scheduleRecordPresent || preview.scheduleUnitFile !== null;
}

/**
 * Where the background engine copy lives, said only where the box does NOT remove it (Phase E final
 * harden round 3, B3-L6). `src/schedule/install.ts`'s `managedBinPath` puts it IN the state folder
 * on macOS — where the consented list's `daily-briefing` removes it — and OUTSIDE it on Linux, in the
 * XDG data dir (`docs/INSTALL.md`'s "Where things live"), which the box never touches.
 */
function engineCopyNote(os: string): string {
  if (os === "macos") return "";
  if (os === "linux") {
    return (
      " On Linux the background engine copy the command-line tool and scheduler use is not in that " +
      "folder — it is in ~/.local/share/daily-briefing/ by default — and this does not remove it."
    );
  }
  return " The background engine copy is not removed by this.";
}

/**
 * The consent checkbox's label. ⚠ It NAMES the archive — and, where the box removes it, the engine
 * copy; where it does not, it says so — because this is the one surface in the app that can remove
 * the briefing history, and a consent that does not say so is not consent (`docs/gui-seam.md` §16,
 * deviation 159).
 */
export function consentLabel(preview: UninstallPreview): string {
  const where = preview.engineStateDir === null ? "" : ` in ${preview.engineStateDir}`;
  const copy =
    preview.os === "macos"
      ? " — plus the background engine copy the command-line tool and scheduler use."
      : ".";
  const head =
    `Also remove the engine's data${where}: the whole briefing archive and its log — your ` +
    `briefing history, which cannot be recovered${copy}${engineCopyNote(preview.os)}`;
  if (scheduleBlocks(preview)) {
    // ⚠ The box removes NOTHING while a schedule record — or, with none, a scheduler unit file — is
    // there (`uninstall.rs`, `REFUSED_FOR_SCHEDULE` / `refused_for_unit`; rounds 2 and 3): that
    // schedule would keep running the engine copy and re-create the archive. So the label says so
    // BEFORE consent, with the way out — and makes no parity claim with the script, which refuses in
    // this state too. It says what IS there, not that a schedule is installed: a record can be stale
    // (B3-L1). A record-less unit gets its OWN rule, the way out first and no stale-RECORD clause
    // (round 4, B4-L6).
    if (preview.scheduleRecordPresent) {
      return (
        `${head} A background schedule record (schedule.json) is there right now, so ticking this ` +
        `removes nothing. ${SCHEDULE_RECORD_RULE}`
      );
    }
    const unit = preview.scheduleUnitFile ?? "";
    // ⚠ Cap round (A5-L1): with `engineError` set the record is UNKNOWN, not absent — an app-owned
    // one is the Schedule screen's to remove (`schedule uninstall` refuses it as foreign) — so this
    // claims no "no schedule record" and gives the record's way out. On Linux both unit cases add the
    // exact command for the unit's own directory (`unitCommandNote`, G5-2).
    if (preview.engineError !== null) {
      return (
        `${head} A background scheduler unit file (${unit}) is there right now, so ticking this ` +
        `removes nothing; the engine could not say whether a schedule record is there too. ` +
        `${SCHEDULE_RECORD_RULE}${unitCommandNote(unit)}`
      );
    }
    return (
      `${head} A background scheduler unit file (${unit}) is there right now, with no schedule ` +
      `record, so ticking this removes nothing. ${SCHEDULE_UNIT_RULE}${unitCommandNote(unit)}`
    );
  }
  // ⚠ The parity claim is about the LIST (pinned against the script by `tests/uninstall.rs`), and it
  // is qualified: a schedule installed after this preview refuses the leg at execute time, exactly
  // as the script refuses while one is installed (`docs/INSTALL.md`). ⚠ macOS ONLY (round 4,
  // B4-L5): `scripts/uninstall.sh` is a macOS source-checkout script (its folder is
  // `~/Library/Application Support/daily-briefing`), so elsewhere there is no script to be at parity
  // with, and the label says only the qualification.
  const unlessScheduled =
    "while a background schedule is installed; nothing else in that folder is touched.";
  if (preview.os === "macos") {
    return (
      `${head} The same files \`bash scripts/uninstall.sh\` removes from that folder, and none of them ` +
      unlessScheduled
    );
  }
  return `${head} None of the engine's data is removed ${unlessScheduled}`;
}

/**
 * The execute button's words (Phase E final harden round 3, A3-L2): what clicking WILL do. Ticked
 * while the preview saw a schedule record or unit file, the engine leg is refused, so the button
 * must not promise engine data — nor while the engine could not say where its data lives
 * (`engineError`, round 4 B4-L7): the leg then removes nothing unless the engine answers by the time
 * of the click, which is what the view's own note under the box says.
 */
export function executeLabel(consent: boolean, preview: UninstallPreview): string {
  if (!consent) return "Remove app pieces";
  if (scheduleBlocks(preview)) return "Remove app pieces (engine data stays while a schedule is there)";
  if (preview.engineError !== null) {
    return "Remove app pieces (engine data stays while the engine cannot say where it is)";
  }
  return "Remove app pieces and engine data";
}

/** One sentence for the scheduler, which this action deliberately does NOT touch. */
export const SCHEDULER_NOTE =
  "The background scheduler itself is not changed here. If you no longer want scheduled briefings, " +
  `remove it first on the Schedule screen (${REMOVE_SCHEDULE_BUTTON}); while it is installed, ` +
  "Uninstall removes none of the engine's data.";

/** One line per report entry, for the done view. */
export function outcomeLine(report: ActionReport): string {
  switch (report.outcome.result) {
    case "removed":
      return `${report.name}: removed`;
    case "absent":
      return `${report.name}: was not there`;
    case "failed":
      return `${report.name}: could not be removed (${report.outcome.detail})`;
  }
}

/** The autostart leg's line, worded as the login item it is. */
export function autostartLine(outcome: RemovalOutcome): string {
  switch (outcome.result) {
    case "removed":
      return "Start-at-login entry: removed";
    case "absent":
      return "Start-at-login entry: was not enabled";
    case "failed":
      return `Start-at-login entry: could not be removed (${outcome.detail})`;
  }
}

/** The done view's closing words, in the order it draws them: a warning (or none), then the finish. */
export type DoneNotes = { warning: string | null; finish: string };

/**
 * The last step, when nothing is left in the way — per platform (Phase E final harden round 3,
 * B3-L6): the macOS app is dragged to the Trash; the Linux one is removed the way it was installed,
 * in `docs/INSTALL.md`'s own words for the .deb and the AppImage.
 */
export function finishLine(os: string): string {
  if (os === "macos") return "To finish, quit the app and drag it from Applications to the Trash.";
  if (os === "linux") {
    return (
      "To finish, quit the app and remove it the way you installed it: `sudo apt remove " +
      "daily-briefing` for the .deb, or delete the `.AppImage` file."
    );
  }
  return "To finish, quit the app and remove it the way you installed it.";
}

/**
 * What the done view says after the per-entry lines (Phase E final harden round 2 R4; round 3
 * A3-L2, B3-L1).
 *
 * ⚠ A SCHEDULE OUTLIVES THE APP. Uninstall never removes the background schedule (`uninstall.rs`
 * module header), and the trigger it records runs the engine copy, not the app — so deleting the app
 * leaves it running every morning, provider calls included. Whenever the EXECUTE-time check found a
 * schedule record or unit file (`scheduleRecordPresent`, `scheduleUnitFile` — read box ticked or
 * not), or the engine leg was refused, the WARNING says so and names the way out — plus the
 * stale-record clause when it was a record, since a record nothing removes is the one dead end; a
 * record-LESS unit's own way out, {@link UNIT_WAY_OUT}, when it was only a unit (round 4, B4-L6) — and
 * the view draws it BEFORE the finish line. A refused run also says to run Uninstall again, since
 * the engine's data is still there. When the execute-time check could not name the state dir
 * (`scheduleRecordPresent: null`) and found no unit, the warning is the HEDGED one: unknown is not
 * absent. With a unit and an unknown record it names the unit, hedged, with the record's way out
 * (cap round, A5-L1); a named systemd unit also gets the exact command for its directory (G5-2).
 */
export function doneNotes(report: UninstallReport): DoneNotes {
  const finish = finishLine(report.os);
  const refused = report.engineRefused !== null;
  const record = report.scheduleRecordPresent === true;
  const unit = report.scheduleUnitFile;
  if (refused || record || unit !== null) {
    // A record-less unit: its own way out, and no stale-RECORD clause (round 4, B4-L6). The report's
    // facts are the look the gate refused on (`uninstall.rs` `ScheduleSeen`, round 4 G4-L1), so a
    // unit refusal always arrives here with `unit` set. ⚠ Record-less only when the record is KNOWN
    // absent (cap round, A5-L1): `null` is unknown — a unit then gets the record's way out, hedged.
    const unitOnly = unit !== null && report.scheduleRecordPresent === false;
    const unitUnknown = unit !== null && report.scheduleRecordPresent === null;
    const there = unitOnly
      ? `A background scheduler unit file is still there (${unit})`
      : unitUnknown
        ? `A background scheduler unit file is still there (${unit}; the engine could not say ` +
          "whether a schedule record is there too)"
        : "A background schedule record is still there";
    const wayOut = unitOnly ? `${UNIT_WAY_OUT}.` : `${SCHEDULE_WAY_OUT}. ${STALE_RECORD_CLAUSE}`;
    // The exact command for a systemd unit's own directory (G5-2), only where the unit is named.
    const note = unit !== null && (unitOnly || unitUnknown) ? unitCommandNote(unit) : "";
    return {
      warning:
        `${there}, and while that schedule is installed it keeps running the engine after the app ` +
        `is deleted: ${wayOut}${note}`,
      finish: refused
        ? "Then run Uninstall again — the engine's data was not removed (above). " + finish
        : finish,
    };
  }
  if (report.scheduleRecordPresent === null) {
    return {
      warning:
        "The engine could not say whether a background schedule is installed. If one is, it keeps " +
        `running the engine after the app is deleted: ${SCHEDULE_WAY_OUT}.`,
      finish,
    };
  }
  return { warning: null, finish };
}
