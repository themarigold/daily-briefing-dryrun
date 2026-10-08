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
 * booleans, the scheduler step's REQUEST (Batch 2: which `schedule` value to send, which Rust's own
 * detection and refusals stand behind), and the WORDING — which must name the briefing archive out
 * loud, because the consented leg is the one surface in this app that can remove it.
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
  /** Rust's own `lstat` look at the engine's `schedule.json` (spec 3, "three record facts"). One of
   *  the facts {@link schedulerBranch} detects a scheduler by (spec 3.3.3); read nowhere else in the
   *  webview. `false` when the engine state dir was not resolved — UNKNOWN then, not absent:
   *  `engineError` is set (cap round). */
  scheduleRecordPresent: boolean;
  /** The first scheduler unit file the engine writes (Rust's `schedule_unit_files`) that is there,
   *  with or without a record; `null` when none is. Detection too ({@link schedulerBranch}). */
  scheduleUnitFile: string | null;
  // ── Batch 2 (spec 3.3.1): the preview's SECOND engine read, `schedule status --json`. Every fact
  // below is the ENGINE's, beside Rust's own look above. When that read failed,
  // `scheduleStatusUnreadable` is true and each fact is unknown (`null`, or `false` for the file
  // fact) — NOT the same as a read that answered and reported nothing, which leaves it false.
  /** The record's owner, `null` when no readable record says. */
  scheduleOwner: "cli" | "app" | null;
  /** The engine's registration check: `null` when it could not run (`scheduleRegisteredReason`
   *  says why) or the read failed. */
  scheduleRegistered: boolean | null;
  /** Why `scheduleRegistered` is `null`, verbatim (`"no-user-manager"`, `"no-gui-session"`,
   *  `"timeout"`, `"spawn"`, `"unexpected"`). */
  scheduleRegisteredReason: string | null;
  /** The engine's manual removal steps, with no closing line; `null` off launchd and systemd, or
   *  when the read failed. */
  scheduleRemoveSteps: string | null;
  /** The second read failed or timed out, or printed an envelope Rust cannot read. */
  scheduleStatusUnreadable: boolean;
  /** The engine's `lstat` of `schedule.json`, readable or not, so the webview's detection matches
   *  Rust's even when `engineStateDir` is `null` and `scheduleRecordPresent` could not look. */
  scheduleRecordFilePresent: boolean;
  /** The folder holding the engine's config (`configPath`'s parent); `null` when unknown. */
  settingsFolder: string | null;
  /** `std::env::consts::OS` (`"macos"`, `"linux"`, …): where the engine copy lives is per platform. */
  os: string;
};

/**
 * Why `uninstall_preview` or `uninstall_execute` answered `Err` — Rust's `UninstallError`, tagged by
 * `kind`. {@link executeFailure} turns the three Batch 2 kinds into spec 3.3.8's branches. On every
 * scheduler-step kind Rust has removed nothing (spec 3.3.4.3).
 */
export type UninstallError =
  /** An app directory could not be resolved. */
  | { kind: "store"; detail: string }
  /** A scheduler this app did not install was detected, and the call did not say to remove it. */
  | { kind: "scheduleForeign"; message: string }
  /** The scheduler step could not finish: the status was unreadable, or the engine's removal failed. */
  | { kind: "scheduleFailed"; message: string }
  /** Another engine operation was in flight. */
  | { kind: "busy"; message: string };

export type RemovalOutcome =
  | { result: "removed" }
  | { result: "absent" }
  | { result: "failed"; detail: string };

export type ActionReport = { name: string; outcome: RemovalOutcome };

/** What happened to one path the report names in full — Rust's `PathOutcome` (Batch 2, spec 3.3.7):
 *  removed; not there; kept, with the reason; or a removal that failed, with the error. */
export type PathOutcome = "removed" | "absent" | "kept" | "failed";

/** One full-path report line — Rust's `PathReport` (Batch 2, spec 3.3.7), the shape of
 *  {@link UninstallReport.engineCopies}: the path, shown with `~` for home; what happened; and why,
 *  for `kept` and `failed` (`null` otherwise). The done screen lists each one once, by its outcome:
 *  {@link removedList} or {@link stillOnThisMachine}. */
export type PathReport = { path: string; outcome: PathOutcome; reason: string | null };

/** What the scheduler step did — Rust's `SchedulerOutcome` (Batch 2, spec 3.3.6): the engine removed
 *  it; there was nothing to remove; it was kept (`keep`, a scheduler detected); or it was kept with
 *  nothing detected by a check that could not run. */
export type SchedulerOutcome = "removed" | "absent" | "kept" | "notChecked";

/** What `uninstall_execute`'s scheduler step is asked to do — its `schedule` argument, Rust's
 *  `SchedulerChoice` (Batch 2, spec 3.3.2): remove this app's own scheduler, if there is one; remove
 *  whatever scheduler is there; or leave it. Rust reads a missing one as `removeOwn`. */
export type SchedulerChoice = "removeOwn" | "removeAny" | "keep";

/** {@link UninstallReport.schedule} — Rust's `SchedulerReport` (Batch 2, spec 3.3.6-3.3.7). The done
 *  screen draws it with {@link schedulerOutcomeLine} and {@link stillOnThisMachine}. */
export type SchedulerReport = {
  outcome: SchedulerOutcome;
  /** What the gate look still saw, for any outcome: the record's path and every unit file there, in
   *  the platform's order (M9 LOW pass, L8: on Linux the service AND the timer) — the same look the
   *  legs were refused on. */
  leftover: string[];
  /** For a leftover unit outside the engine's own unit folder (a custom `XDG_CONFIG_HOME`), its
   *  per-path command; empty when there is none. */
  leftoverCommands: string[];
  /** The engine's manual removal steps (no closing line), or `null` when the status read failed —
   *  the done screen then substitutes its static per-OS copy. */
  removeSteps: string | null;
};

/** {@link UninstallReport.settings} — Rust's `SettingsReport` (Batch 2, spec 3.3.7, 3.5.3). ALWAYS
 *  present; with `asked: false` it only names the folder that stays. The done screen draws it with
 *  {@link removedList} and {@link stillOnThisMachine}. */
export type SettingsReport = {
  /** The settings box was ticked (`removeSettings: true`). */
  asked: boolean;
  /** The settings folder (`configPath`'s parent, the preview's `settingsFolder`); `null` when unknown. */
  folder: string | null;
  /** One line per distinct `provider.api.apiKeyFile` the readable configs name, its `path` in full
   *  after `~` expansion (a relative one as written, never `~`-shortened): `removed` (its
   *  `reason` the other-link note when another link still holds the file), `absent`, `kept` with
   *  why, or `failed` with the error. A path that IS `config.json` or `config.json.bak` reads
   *  "handled with <config> below", with that config's outcome. */
  keyFiles: PathReport[];
  /** A config could not be read or parsed, so its key reference is unknown. */
  keyRefsUnknown: boolean;
  /** The names removed besides the key files: `config.json`, `config.json.bak`. */
  removed: string[];
  /** Every name still in the settings folder after the run, sorted. */
  remaining: string[];
  /** Why nothing was removed, by rule: a kept scheduler's or the gate look's refusal, or a settings
   *  folder that is a link. */
  refused: string | null;
  /** Why the step could not run or finish (the settings folder unknown, a key file or config that
   *  would not unlink). */
  error: string | null;
  /** Spec 3.3.7's `notes: [string]`, always present (added at M5b, recorded in the spec's §16
   *  "Build corrections"): Rust-written sentences for what the names cannot say — a config that
   *  was a link (and what became of its target), a config removed while another link still holds
   *  it, and the staged `.config.json.save-*` copies. Key-file notes stay in
   *  `keyFiles[].reason`. The done screen says each once, where it belongs: a target that is gone
   *  with the removals ({@link removedList}), what remains under {@link stillOnThisMachine}. */
  notes: string[];
};

export type UninstallReport = {
  autostart: RemovalOutcome;
  app: ActionReport[];
  /** True when at least one engine entry was ACTUALLY removed — derived from the outcomes, not
   *  echoed from the consent flag (consent over an empty dir, or with every removal refused,
   *  reports false). */
  engineStateRemoved: boolean;
  /** Empty unless consented — and empty when the leg was refused ({@link engineRefused}). */
  engine: ActionReport[];
  /** Set when consent was given but the leg was refused, so it removed NOTHING: ONE refusal for the
   *  whole leg, shown verbatim ({@link engineDataLine}) — a kept scheduler (Rust's
   *  `REFUSED_FOR_KEPT_SCHEDULER`), or what the gate look still saw: a schedule record
   *  (`REFUSED_FOR_SCHEDULE`) or, with none, a scheduler unit file (`refused_for_unit`, naming it). */
  engineRefused: string | null;
  /** The directory the consented engine leg targeted (`status --json` re-resolved at execute
   *  time, the same call path the preview used); `null` when the leg was not attempted or the
   *  engine could not answer; set on a refusal too (the directory the refused leg targeted). The
   *  done view renders it so the consented target is auditable. */
  engineStateDir: string | null;
  engineError: string | null;
  /** Whether `schedule.json` was there at the GATE look — read whether or not the box was ticked.
   *  `null` when the engine could not name its state dir at execute time (unknown, not absent). The
   *  done screen draws what remains from {@link schedule}'s `leftover`, the same look. */
  scheduleRecordPresent: boolean | null;
  /** The unit file the GATE look saw, or `null` — ticked or not; the record's look (G4-L1). */
  scheduleUnitFile: string | null;
  /** Batch 2 (spec 3.3.6): what the scheduler step did, what the gate look still saw, and the ways to
   *  remove what may remain. */
  schedule: SchedulerReport;
  /** Batch 2 (spec 3.3.7, 3.5.2): one line per Linux engine copy Rust looked at
   *  (`~/.local/share/daily-briefing/bin/daily-briefing`, and the same under an absolute
   *  `$XDG_DATA_HOME`). ALWAYS present, as an array: empty where there are no candidates, so `[]` on
   *  macOS, whose copy is the state dir's `daily-briefing`. A copy that is there and was not asked
   *  about is `kept` with the reason "not asked". */
  engineCopies: PathReport[];
  /** Batch 2 (spec 3.3.7, 3.5.3): the settings step — ALWAYS present; with the box unticked it only
   *  names the folder that stays. */
  settings: SettingsReport;
  /** `std::env::consts::OS` — the last step (how the app itself is removed) is per platform. */
  os: string;
};

/** Read-only: two engine spawns (`status --json`, `schedule status --json`), one `is_enabled()`
 *  read, and `lstat`s. */
export function uninstallPreview(): Promise<UninstallPreview> {
  return invoke<UninstallPreview>("uninstall_preview");
}

/** Perform it. `removeEngineState` is the EXPLICIT consent for the engine-data leg, `removeSettings`
 *  the consent for the settings leg, and `schedule` what the scheduler step does (Batch 2, spec
 *  3.3.2); {@link executeArgs} and {@link uninstallAnyway} say which. All three are always sent. The
 *  two Batch 2 ones default to what Rust reads a missing one as — `false` and `"removeOwn"` — so a
 *  caller that passes only the engine-data consent sends what it always meant. */
export function uninstallExecute(
  removeEngineState: boolean,
  removeSettings = false,
  schedule: SchedulerChoice = "removeOwn",
): Promise<UninstallReport> {
  return invoke<UninstallReport>("uninstall_execute", { removeEngineState, removeSettings, schedule });
}

/* ── the wording, pure so `tests-web` can pin it ──────────────────────────────────────────────── */

/** What the un-consented action does — ONE sentence about the app's own pieces (Batch 2, spec
 *  3.6.2). Shown before the preview too, so it names no platform and no box: how the app itself is
 *  removed is the done screen's {@link finishLine}, and the scheduler is said once, by the
 *  scheduler line ({@link schedulerBranch}). */
export const UNINSTALL_EXPLANATION =
  "Removes this app's start-at-login entry and its own files; your briefing archive and settings " +
  "stay unless you choose to remove them.";

/** How long Uninstall takes (spec 3.1.4, "User-facing time"), said next to its button: the engine's
 *  scheduler removal is bounded by its own deadline, after two engine reads of at most 30 s each. */
export const UNINSTALL_TIME_SENTENCE = "This usually takes under a minute, and at most about two.";

/**
 * The Schedule screen's own removal button (`ScheduleUninstall.svelte`) — the way out the
 * schedule-record refusal names. `tests-web/coexistence.check.ts` pins it against the RENDERED
 * button and `tests/uninstall.rs` against the component's source, so a rename cannot leave the
 * advice pointing at nothing.
 */
export const REMOVE_SCHEDULE_BUTTON = "Remove background scheduler…";

/* The refusal texts' TS twins (Batch 2, spec 3.6.4). Rust writes every refusal the done screen shows
 * (`report.engineRefused`, `settings.refused`, a kept copy's reason) and the webview shows it
 * verbatim, so nothing here composes one: these constants are the halves of the four Rust ↔ TS pairs
 * `tests-web/coexistence.check.ts` parses the Rust literals against, so neither side can change its
 * words alone. Since Batch 2 a refusal covers the settings step as well as the engine's data, so the
 * rules speak of "these files". */

/** The way out of an installed schedule, as a clause: the Schedule screen's button, or the engine's
 *  own subcommand for a schedule installed from a terminal. {@link SCHEDULE_RECORD_RULE} carries it,
 *  between the rule's head and ", then run Uninstall again." */
export const SCHEDULE_WAY_OUT =
  `remove the schedule first (Schedule screen → ${REMOVE_SCHEDULE_BUTTON}), or run ` +
  "`daily-briefing schedule uninstall` if you installed it from the terminal";

/**
 * The one sentence for the schedule-record rule — the refusal when the GATE look (after the
 * scheduler step) still sees `schedule.json`: one the engine left behind, or one installed in
 * between. Rust's `REFUSED_FOR_SCHEDULE` carries this sentence verbatim. Both ways out reach every
 * record: the Schedule screen's button shows whenever the engine sees the record FILE (spec 3.4.1),
 * and the engine counts a malformed or dangling record as installed and removes it (spec 3.1.2), so
 * no record is a dead end any more and no stale-record clause follows (spec 3.6.1).
 */
export const SCHEDULE_RECORD_RULE =
  "Uninstall removes none of these files while a background schedule is installed: " +
  `${SCHEDULE_WAY_OUT}, then run Uninstall again.`;

/**
 * The way out of a scheduler unit file with NO record, as a clause. The terminal, not the Schedule
 * screen: a unit the engine THIS app spawns can see is one the scheduler step already removed (or
 * failed on, with an error and nothing removed), so the unit this refusal names is one only Rust's
 * look sees — a terminal install under a custom `$XDG_CONFIG_HOME` (spec §7), which that engine never
 * reads (Rust's `FORWARDED_ENV`) and the Schedule screen therefore never shows. From a terminal the
 * engine's own subcommand removes a unit with no record — it unregisters the job by its label, then
 * deletes the unit files (`src/schedule/install.ts`, `uninstallSchedule`) — and for a systemd unit
 * Rust adds the exact command for the unit's own folder (`unit_command_note`).
 */
export const UNIT_WAY_OUT =
  "run `daily-briefing schedule uninstall` in a terminal, which removes that scheduler and its unit file";

/**
 * The rule sentence for a record-LESS unit — its own, the way out first. Rust's
 * `REFUSED_FOR_UNIT_RULE` is this sentence, word for word (`tests-web/coexistence.check.ts` parses
 * it), carried by the refusal `refused_for_unit` reports — last, but for a systemd unit's exact
 * command.
 */
export const SCHEDULE_UNIT_RULE =
  "Uninstall removes none of these files while a background scheduler unit file is there: " +
  `${UNIT_WAY_OUT}, then run Uninstall again.`;

/** Why a systemd unit needs its own command (cap round, G5-2) — Rust's `UNIT_DIR_CLAUSE`, word for
 *  word (`tests-web/coexistence.check.ts` parses it); it ends Rust's `unit_command_note`. */
export const UNIT_DIR_CLAUSE =
  "`daily-briefing schedule uninstall` looks for it only under `$XDG_CONFIG_HOME/systemd/user`, or " +
  "`~/.config/systemd/user` when XDG_CONFIG_HOME is unset.";

/**
 * Why the consented legs removed nothing while a scheduler is being KEPT (Batch 2, spec 3.3.5.1):
 * `keep` was sent and a scheduler was detected. Rust's `REFUSED_FOR_KEPT_SCHEDULER`, word for word —
 * `tests-web/coexistence.check.ts` holds the two equal.
 */
export const REFUSED_FOR_KEPT_SCHEDULER =
  "A background scheduler is being kept, and it still needs these files.";

/** Where `src/schedule/install.ts`'s `managedBinPath` puts the Linux engine copy by default — the
 *  copy Rust's `managed_engine_copies` looks at (spec 3.5.2), outside the state folder. */
const LINUX_ENGINE_COPY = "~/.local/share/daily-briefing/bin/daily-briefing";

/**
 * Where the background engine copy goes, as a clause after the archive (spec 3.6.2): on macOS it is
 * IN the state folder (`managedBinPath`), where the consented list's `daily-briefing` removes it; on
 * Linux it is OUTSIDE it, in the XDG data dir, and since Batch 2 the same consented step removes it
 * too (spec 3.5.2, Rust's `engine_copy_leg`, after its ownership checks); elsewhere the box does not
 * remove it, and {@link consentLabel}'s second sentence says so.
 */
function engineCopyNote(os: string): string {
  if (os === "macos") return ", and the background engine copy";
  if (os === "linux") return `, and the background engine copy at ${LINUX_ENGINE_COPY}`;
  return "";
}

/** The sentence a consent label adds when the engine could not say where its files are (spec
 *  3.6.2: the third sentence, only when the box is blocked). Rust re-reads the folder at execute
 *  time, so "until it can" is literal: an engine that answers by then is acted on. */
function unknownFolder(what: string): string {
  return `The engine couldn't say where ${what}, so this removes nothing until it can.`;
}

/**
 * The engine-data box's label (spec 3.6.2: at most two sentences, plus one only when the box is
 * blocked). ⚠ It NAMES the archive and that it cannot be recovered — and the engine copy where the
 * box removes it — because this is the one surface in the app that can remove the briefing history,
 * and a consent that does not say so is not consent (`docs/gui-seam.md` §16, deviation 159). Its
 * lead, "Also remove the engine's data", is quoted by the History screen (`routes/History.svelte`).
 *
 * "Blocked" here is the engine's folder being unknown (`engineError`). The other block, "Keep it
 * running", is said once for both boxes by {@link consentBoxes}' note. A scheduler on disk no longer
 * blocks the box: the scheduler step runs first, and Rust's refusals stay the backstop (spec 3.3.5),
 * reported on the done screen.
 *
 * ⚠ The script-parity claim is macOS only (round 4, B4-L5): `scripts/uninstall.sh` is a macOS
 * source-checkout script, and its `rm` list is pinned equal to Rust's by `tests/uninstall.rs`.
 */
export function consentLabel(preview: UninstallPreview): string {
  const where = preview.engineStateDir === null ? "" : ` in ${preview.engineStateDir}`;
  const head =
    `Also remove the engine's data${where}: your whole briefing archive and its log, which cannot be ` +
    `recovered${engineCopyNote(preview.os)}.`;
  const bound =
    preview.os === "macos"
      ? "These are the files `bash scripts/uninstall.sh` removes; nothing else in that folder is touched."
      : preview.os === "linux"
        ? "Nothing else in that folder is touched."
        : "The background engine copy is not removed by this; nothing else in that folder is touched.";
  const blocked = preview.engineError === null ? "" : ` ${unknownFolder(`its data lives (${preview.engineError})`)}`;
  return `${head} ${bound}${blocked}`;
}

/** The settings box's label (spec 3.5.3: "Also remove my settings and API key file (in <folder>)",
 *  off by default), naming the folder it empties — the preview's `settingsFolder`. With that folder
 *  unknown the box is blocked, and the label says so in its one extra sentence (spec 3.6.2). */
export function settingsLabel(preview: UninstallPreview): string {
  const head = "Also remove my settings and API key file";
  return preview.settingsFolder === null
    ? `${head}. ${unknownFolder("they are")}`
    : `${head} (in ${preview.settingsFolder}).`;
}

/**
 * The execute button's words (Phase E final harden round 3, A3-L2): what clicking WILL do, read from
 * what it will SEND ({@link executeArgs}, so "Keep it running" — which sends both boxes as false —
 * reads as app pieces only). A ticked box whose folder the engine could not name removes nothing
 * unless the engine answers by the click (round 4, B4-L7), so the button does not promise it.
 */
export function executeLabel(sent: Consents, preview: UninstallPreview): string {
  const removes: string[] = [];
  let staysData = false;
  let staysSettings = false;
  if (sent.removeEngineState) {
    if (preview.engineError === null) removes.push("engine data");
    else staysData = true;
  }
  if (sent.removeSettings) {
    if (preview.settingsFolder !== null) removes.push("settings");
    else staysSettings = true;
  }
  const what =
    removes.length === 2
      ? "app pieces, engine data and settings"
      : removes.length === 1
        ? `app pieces and ${removes[0]}`
        : "app pieces";
  const stays =
    staysData && staysSettings
      ? " (engine data and settings stay while the engine cannot say where they are)"
      : staysData
        ? " (engine data stays while the engine cannot say where it is)"
        : staysSettings
          ? " (settings stay while the engine cannot say where they are)"
          : "";
  return `Remove ${what}${stays}`;
}

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

/**
 * The autostart leg's line, worded as the login item it is, per platform (spec 3.6.5). On macOS the
 * entry is a LaunchAgent whose program is this app itself, and Rust only deletes its file — it never
 * unloads it, which would quit the app mid-Uninstall (spec §2 point 2) — so `launchctl` may keep
 * listing it until logout (item 23); the line says so, and that it will not open the app again.
 */
export function autostartLine(outcome: RemovalOutcome, os: string): string {
  switch (outcome.result) {
    case "removed":
      return os === "macos"
        ? "Start-at-login entry: removed. It won't open the app at your next login, though macOS may keep " +
            "listing it until you log out."
        : "Start-at-login entry: removed.";
    case "absent":
      return "Start-at-login entry: was not enabled";
    case "failed":
      return `Start-at-login entry: could not be removed (${outcome.detail})`;
  }
}

/**
 * The last step — per platform (Phase E final harden round 3, B3-L6): the macOS app is dragged to the
 * Trash; the Linux one is removed the way it was installed, in `docs/INSTALL.md`'s own words for the
 * .deb and the AppImage. The done screen draws it LAST, after "Still on this machine"
 * ({@link stillOnThisMachine}), so whatever stays is read before the app is deleted. (Batch 2, spec
 * 3.6.3: the old `doneNotes` warning that came before it is gone — the scheduler is said once, by
 * {@link schedulerOutcomeLine} and that block — and so is its "run Uninstall again" prefix: every
 * refusal leaves the scheduler under "Still on this machine", which ends with that advice once.)
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

/* ── Batch 2: the scheduler step's choice, its errors, and the done screen (spec 3.3.8, 3.6.3) ──── */
//
// Pure, so `tests-web` reaches every branch without a click; the Uninstall screen draws what these
// return. ⚠ STILL NO DECISION LIVES HERE that Rust does not take again: what the webview sends is a
// request, and Rust's own detection (spec 3.3.3) and refusals (3.3.5) stand behind it. The webview
// reads the preview's scheduler facts only through these helpers (the "no `.scheduleRecordPresent`
// in the view" pin, `tests-web/coexistence.check.ts`).

/** Spec 3.3.8: each registration-check reason (`scheduleRegisteredReason`) as a plain phrase. A Map,
 *  not an object literal, so a token such as `constructor` cannot reach a prototype member. */
const REASON_PHRASES = new Map<string, string>([
  ["no-user-manager", "the system's user services couldn't be reached"],
  ["no-gui-session", "this isn't a desktop session"],
  ["timeout", "the check took too long"],
  ["spawn", "the check couldn't start"],
  ["unexpected", "the system gave an unexpected answer"],
]);
const UNEXPECTED_PHRASE = "the system gave an unexpected answer";

/** A reason as the user reads it — never its token. One this app does not know (a newer engine's), or
 *  none, reads as the unexpected answer it is. */
export function reasonPhrase(reason: string | null): string {
  return REASON_PHRASES.get(reason ?? "") ?? UNEXPECTED_PHRASE;
}

/** Spec 3.3.8's three lead sentences, one per case of a scheduler this app did not set up. */
const LEAD_FROM_TERMINAL = "A background scheduler was set up from the terminal.";
/** Also the Schedule screen's foreign-owner dialog lead for a null owner (spec 3.4.3; `uninstall-flow.ts`). */
export const LEAD_NO_OWNER = "A background scheduler is set up, but nothing records who set it up.";
const LEAD_UNREADABLE = "Something of a background scheduler is on this computer, but its status couldn't be read.";

/**
 * What the Uninstall screen says about the scheduler, and whether it asks (spec 3.3.8):
 *   • `none` — nothing detected, and the check ran: no scheduler text;
 *   • `own` — the app's own scheduler: one line, no choice;
 *   • `unchecked` — nothing on disk, and the check could not run (or the status read failed): one line
 *     with the reason;
 *   • `other` — any other scheduler: its lead sentence, and the radio group ({@link SCHEDULER_OPTIONS}).
 * The first three send `removeOwn`; `other` sends what the radio group says ({@link executeArgs}).
 */
export type SchedulerBranch =
  | { kind: "none" }
  | { kind: "own"; line: string }
  | { kind: "unchecked"; line: string }
  | { kind: "other"; lead: string };

/**
 * The preview's branch. Detection is Rust's (spec 3.3.3), as far as the preview can tell it: Rust's
 * own look at the record or a unit, the engine's `lstat` of the record, or a registration. The owner
 * is `app` only when the status read succeeded and a readable record says so.
 *
 * `foreign` is the `ScheduleForeign` answer (spec 3.3.8): the preview has been re-read, and the radio
 * group is ALWAYS shown, because the refusal is itself the detection. A re-read that finds nothing of
 * another's — nothing at all, a check that could not run, or (a race) the app's own record — gets the
 * null-owner lead.
 */
export function schedulerBranch(preview: UninstallPreview, foreign = false): SchedulerBranch {
  const unreadable = preview.scheduleStatusUnreadable;
  const detected =
    preview.scheduleRecordPresent ||
    preview.scheduleUnitFile !== null ||
    preview.scheduleRecordFilePresent ||
    preview.scheduleRegistered === true;
  if (detected) {
    if (!foreign && !unreadable && preview.scheduleOwner === "app") {
      return { kind: "own", line: "The background scheduler this app set up is removed too." };
    }
    const lead = unreadable ? LEAD_UNREADABLE : preview.scheduleOwner === "cli" ? LEAD_FROM_TERMINAL : LEAD_NO_OWNER;
    return { kind: "other", lead };
  }
  if (foreign) return { kind: "other", lead: LEAD_NO_OWNER };
  if (unreadable || preview.scheduleRegistered === null) {
    const why = unreadable ? "its status couldn't be read" : reasonPhrase(preview.scheduleRegisteredReason);
    return { kind: "unchecked", line: `Couldn't check for a background scheduler (${why}).` };
  }
  return { kind: "none" };
}

/** The radio group's two answers (spec 3.3.8). */
export type SchedulerOption = Extract<SchedulerChoice, "keep" | "removeAny">;

/** The radio group, in the order it is drawn: "Keep it running" FIRST, as `ForeignOwnerDialog` puts
 *  Keep first, and preselected ({@link DEFAULT_SCHEDULER_OPTION}), so keeping is the default. */
export const SCHEDULER_OPTIONS: readonly { choice: SchedulerOption; label: string }[] = [
  { choice: "keep", label: "Keep it running" },
  { choice: "removeAny", label: "Remove it" },
];
export const DEFAULT_SCHEDULER_OPTION: SchedulerOption = "keep";

/** The two consent boxes, as the user ticked them. */
export type Consents = { removeEngineState: boolean; removeSettings: boolean };

/** {@link uninstallExecute}'s three arguments. */
export type ExecuteArgs = Consents & { schedule: SchedulerChoice };

/** The engine-data and settings boxes under the radio group's answer: with "Keep it running" on a
 *  scheduler that asks, they are unticked and disabled (`locked`), and `note` says why — Rust's own
 *  refusal sentence, since a kept scheduler still needs those files (spec 3.3.5.1). */
export function consentBoxes(branch: SchedulerBranch, option: SchedulerOption): { locked: boolean; note: string | null } {
  const locked = branch.kind === "other" && option === "keep";
  return { locked, note: locked ? REFUSED_FOR_KEPT_SCHEDULER : null };
}

/** What the Uninstall button sends (spec 3.3.8): `removeOwn` with the boxes as ticked, unless the
 *  branch asks; then the radio group's answer — and under `keep` both boxes as false, whatever the
 *  view still holds. */
export function executeArgs(branch: SchedulerBranch, consents: Consents, option: SchedulerOption): ExecuteArgs {
  if (branch.kind === "other" && option === "keep") {
    return { removeEngineState: false, removeSettings: false, schedule: "keep" };
  }
  return {
    removeEngineState: consents.removeEngineState,
    removeSettings: consents.removeSettings,
    schedule: branch.kind === "other" ? "removeAny" : "removeOwn",
  };
}

/** The consent view's answers: the two boxes and the radio group's. */
export type ConsentState = Consents & { option: SchedulerOption };

/**
 * The radio group's answer, as chosen (spec 3.3.8: under "Keep it running" the boxes are "unticked and
 * disabled"; checkpoint M6a F1). "Keep it running" CLEARS both boxes — their values, not only how they
 * are drawn — so a later "Remove it" starts from unticked boxes, and ticks the screen showed cleared
 * never come back. "Remove it" leaves the boxes as they are. The consent view's radio group goes
 * through this, and so does a `ScheduleForeign`'s reset to the default ({@link stateAfterFailure}).
 */
export function chooseSchedulerOption(option: SchedulerOption, consents: Consents): ConsentState {
  if (option === "keep") return { removeEngineState: false, removeSettings: false, option };
  return { removeEngineState: consents.removeEngineState, removeSettings: consents.removeSettings, option };
}

export const TRY_AGAIN = "Try again";
export const UNINSTALL_ANYWAY = "Uninstall anyway";

/** The app's own closing line after manual steps (spec 3.1.8 "Framing"): the steps carry none, and
 *  each surface adds its own, once, after them. */
export const MANUAL_STEPS_APP_CLOSING = "Then press Remove again, or run Uninstall again.";

/** The first line of the engine's manual steps (`src/schedule/install.ts`, `manualRemoveSteps`); the
 *  static copies below begin with it, and their pin holds them to the engine's text. */
const STEPS_FRAMING = "Run these in a terminal (bash or zsh) inside your desktop session.";

/** The app's closing line for an engine text shown verbatim (spec 3.1.8 "Framing"; plan SQ6):
 *  {@link MANUAL_STEPS_APP_CLOSING} when the text carries the manual steps — the engine's `--invoker app`
 *  stderr ends them with no closing line of its own — else `null`. Said once, after the text, never
 *  folded into it. The Uninstall screen's errors ({@link executeFailure}) and the Schedule screen's
 *  outcome line (`uninstall-flow.ts`, `uninstallLine`) both go through this one rule. */
export function manualStepsClosing(text: string): string | null {
  return text.includes(STEPS_FRAMING) ? MANUAL_STEPS_APP_CLOSING : null;
}

/** One of spec 3.3.8's three execute errors, as the screen shows it: `message` verbatim (the engine's
 *  stderr, or Rust's own sentence); `closing` — {@link MANUAL_STEPS_APP_CLOSING} — when that message
 *  carries the manual steps, else `null`; and the buttons beside it, in order. `scheduleForeign` has
 *  none: the screen re-reads the preview and shows the radio group (`schedulerBranch(preview, true)`),
 *  whose answer the Uninstall button sends. */
export type ExecuteFailure = {
  kind: "scheduleForeign" | "scheduleFailed" | "busy";
  message: string;
  closing: string | null;
  buttons: string[];
};

/** `uninstall_execute`'s rejection as one of spec 3.3.8's branches; `null` for any other failure (a
 *  `store` error, an IPC failure), which the screen shows as it did before. */
export function executeFailure(e: unknown): ExecuteFailure | null {
  if (typeof e !== "object" || e === null) return null;
  const { kind, message } = e as { kind?: unknown; message?: unknown };
  if (typeof message !== "string") return null;
  const closing = manualStepsClosing(message);
  switch (kind) {
    case "scheduleForeign":
      return { kind, message, closing, buttons: [] };
    case "scheduleFailed":
      return { kind, message, closing, buttons: [TRY_AGAIN, UNINSTALL_ANYWAY] };
    case "busy":
      return { kind, message, closing, buttons: [TRY_AGAIN] };
    default:
      return null;
  }
}

/** What the Uninstall screen holds after one of spec 3.3.8's three execute errors ({@link stateAfterFailure}). */
export type FailureState = ConsentState & {
  /** The radio group ALWAYS shows: set by `ScheduleForeign`, whose refusal is itself the detection, and
   *  kept by the other two, so an earlier refusal still shows the group. */
  foreign: boolean;
  /** "Uninstall anyway" — the form that sent the call. Undone by `ScheduleForeign` (its radio group asks
   *  afresh); KEPT by the other two (checkpoint M6a follow-up), because Try again re-sends what that form
   *  sent, and the consent view drawn, disabled, while the retry is in flight must be that form — not
   *  the user's earlier ticks under the scheduler line or a radio group the call is not sending. */
  anyway: boolean;
  /** Re-read the preview before the error is shown (`ScheduleForeign` only). */
  reread: boolean;
};

/**
 * The Uninstall screen's state after `uninstall_execute` answered one of spec 3.3.8's three errors — pure
 * (checkpoint M6a F4), so what each kind leaves behind is tested, not only its source text.
 *   • `ScheduleForeign` — `foreign` set, the radio group back to its default ("Keep it running", which
 *     clears the boxes: {@link chooseSchedulerOption}), and a re-read of the preview requested; the
 *     group then shows whatever the re-read finds ({@link schedulerBranch}).
 *   • `ScheduleFailed`, `Busy` — the consent view's state as it was, `foreign` and `anyway` included;
 *     their panels answer them, and Try again sends what was sent — drawn, while it is in flight, as the
 *     form that sent it (checkpoint M6a follow-up: a locked "Uninstall anyway" form's retry showed the
 *     user's earlier ticks for as long as it ran, though it correctly sent them as false).
 * Only `ScheduleForeign` undoes "Uninstall anyway". `AppSettings.svelte` applies the whole result, then
 * re-reads when asked, then shows the error.
 */
export function stateAfterFailure(
  failure: ExecuteFailure,
  current: ConsentState & { foreign: boolean; anyway: boolean },
): FailureState {
  if (failure.kind === "scheduleForeign") {
    return { ...chooseSchedulerOption(DEFAULT_SCHEDULER_OPTION, current), foreign: true, anyway: false, reread: true };
  }
  return {
    removeEngineState: current.removeEngineState,
    removeSettings: current.removeSettings,
    option: current.option,
    foreign: current.foreign,
    anyway: current.anyway,
    reread: false,
  };
}

/**
 * "Uninstall anyway", after `ScheduleFailed` (spec 3.3.8): it sends `keep`, in one of two forms by
 * what the preview detected. Nothing detected (the check could not run, nothing on disk): the boxes
 * are sent as they are (decision 2026-10-04, option A), and the sentence says they still apply only
 * when one is ticked (M9 LOW pass, L4). A scheduler detected: the boxes are unticked
 * and disabled, as under "Keep it running", and sent as false — Rust would refuse those legs anyway
 * (spec 3.3.5.1), and stays the backstop if it detects one the preview did not.
 */
export function uninstallAnyway(
  branch: SchedulerBranch,
  consents: Consents,
): { sentence: string; locked: boolean; args: ExecuteArgs } {
  if (branch.kind === "own" || branch.kind === "other") {
    return {
      sentence:
        "The background scheduler stays, and it still needs its files, so your data and settings are kept. The " +
        "steps to remove it yourself are shown afterwards.",
      locked: true,
      args: { removeEngineState: false, removeSettings: false, schedule: "keep" },
    };
  }
  // M9 LOW pass (L4): the boxes are named only when one is ticked — with neither, there is nothing to apply.
  const ticked = consents.removeEngineState || consents.removeSettings;
  return {
    sentence: ticked
      ? "Any background scheduler that may still exist stays registered. Your ticked boxes still apply, and the " +
        "steps to remove it yourself are shown afterwards if it may still be there."
      : "Any background scheduler that may still exist stays registered. The steps to remove it yourself are shown " +
        "afterwards if it may still be there.",
    locked: false,
    args: { removeEngineState: consents.removeEngineState, removeSettings: consents.removeSettings, schedule: "keep" },
  };
}

/** What "Uninstall anyway" will do, said UNDER its button on the `ScheduleFailed` panel, before it is
 *  clicked (checkpoint M6a F6): {@link uninstallAnyway}'s sentence for the branch the consent view will
 *  draw — the same words its keep form then shows. `null` on a panel without that button. */
export function anywayNote(failure: ExecuteFailure, branch: SchedulerBranch, consents: Consents): string | null {
  return failure.buttons.includes(UNINSTALL_ANYWAY) ? uninstallAnyway(branch, consents).sentence : null;
}

/* The static per-OS manual steps for the DEFAULT paths (spec 3.3.6), written in the engine's own
 * `"$HOME"/'…'` form, so they hold for any home. The done screen shows them when the report's
 * `removeSteps` is `null` (the status read failed); Rust keeps no copy. ⚠ A COPY OF THE ENGINE'S TEXT:
 * `tests-web/coexistence.check.ts` pins each one literally equal to `manualRemoveSteps`' output for the
 * default paths, so a change on either side fails there. */
const STATIC_STEPS_MACOS = [
  STEPS_FRAMING,
  "1. Unregister the job:",
  "   launchctl bootout gui/$(id -u)/local.daily-briefing; launchctl bootout user/$(id -u)/local.daily-briefing",
  "2. Wait a few seconds.",
  '3. Confirm it is gone. Each of these must report not found: it prints "Could not find service", or its last line is "exit 113".',
  '   launchctl print gui/$(id -u)/local.daily-briefing; echo "exit $?"',
  '   launchctl print user/$(id -u)/local.daily-briefing; echo "exit $?"',
  '   launchctl list local.daily-briefing; echo "exit $?"',
  '   If the first one says "Could not find domain", this terminal is not in your desktop session (over SSH, for example): run these steps from a desktop session instead. The second one may say "Could not find domain"; that is fine.',
  "   If the last one still finds the job (one loaded in another session), run this in the same terminal, wait a few seconds, and confirm again:",
  "   launchctl remove local.daily-briefing",
  "4. Delete the files:",
  `   rm -f -- "$HOME"/'Library/LaunchAgents/local.daily-briefing.plist' "$HOME"/'Library/Application Support/daily-briefing/schedule.json'`,
].join("\n");

const STATIC_STEPS_LINUX = [
  STEPS_FRAMING,
  '1. Unregister the timer and service (a "not found" from disable is fine):',
  "   systemctl --user stop daily-briefing.timer daily-briefing.service; systemctl --user disable daily-briefing.timer",
  "2. Confirm they are gone:",
  "   systemctl --user is-active daily-briefing.timer daily-briefing.service",
  "   must print only inactive, failed or unknown, and",
  "   systemctl --user is-enabled daily-briefing.timer",
  "   must print static, disabled, linked, linked-runtime, masked, masked-runtime, bad or not-found, or report that the unit file does not exist.",
  "3. Delete the files and reload:",
  `   rm -f -- "$HOME"/'.config/systemd/user/daily-briefing.timer' "$HOME"/'.config/systemd/user/daily-briefing.service' "$HOME"/'.local/state/daily-briefing/schedule.json'; systemctl --user daemon-reload; systemctl --user reset-failed daily-briefing.timer daily-briefing.service`,
].join("\n");

/** The static steps for `os` (`std::env::consts::OS`); `null` where spec 3.1 does not apply. */
export function staticRemoveSteps(os: string): string | null {
  if (os === "macos") return STATIC_STEPS_MACOS;
  if (os === "linux") return STATIC_STEPS_LINUX;
  return null;
}

/** The done screen's scheduler outcome line (spec 3.6.3): drawn for every report, once, and OUTSIDE
 *  "Still on this machine", so each thing is said once. */
export function schedulerOutcomeLine(outcome: SchedulerOutcome): string {
  switch (outcome) {
    case "removed":
      return "Background scheduler: removed";
    case "absent":
      return "Background scheduler: none was found";
    case "kept":
      return "Background scheduler: kept";
    case "notChecked":
      return "Background scheduler: not checked — the check couldn't run";
  }
}

/* The settings step's notes (spec 3.3.7 `notes`, 3.5.3; the §16 build corrections) are Rust's sentences,
 * shown verbatim — but each is said ONCE, where it belongs (spec 3.6.3; checkpoint M6a F2): a REMOVED linked
 * config whose target is GONE is a removal's note ({@link removedList}); what may remain — a kept target, a
 * linked config Rust kept (M9 LOW pass, L7), another link still holding a removed config, the staged copies —
 * is under {@link stillOnThisMachine}.
 * The place is read from Rust's own fixed words, never guessed: these are their TS twins, and
 * `tests-web/coexistence.check.ts` parses `uninstall.rs` to hold each equal, and to hold Rust to the
 * note builders placed here. A note this screen does not know stays under "Still on this machine". */

/** Rust's `STAGED_COPIES_NOTE`, word for word: the staged copies' note is `"<names>: <this>"`. */
export const STAGED_COPIES_NOTE = "staged copies of earlier settings, which may hold a key";

/** Rust's `linked_config_note` words for a target that is GONE after the leg — `"<name> was a link to
 *  <target>, which <one of these>."`: removed as the key file, or not there (§16, "the linked-config
 *  note says what became of its target"). A target still there ends "; that file was kept and may hold
 *  your API key." instead. */
export const LINK_TARGET_GONE = ["was removed as your API key file", "isn't there"] as const;

const STAGED_SUFFIX = `: ${STAGED_COPIES_NOTE}`;
const GONE_ENDINGS = LINK_TARGET_GONE.map((what) => `, which ${what}.`);
/** Rust's `config_save::staged_prefix(SETTINGS_CONFIG)`: every staged copy's name starts with it. */
const STAGED_PREFIX = ".config.json.save-";

/** `notes`, by where the done screen says each one. A note about a GONE target is a removal's only when the
 *  config it names was removed (`removed`): since the M9 LOW pass (L7) Rust also writes the note for a linked
 *  config it KEPT (the leg stopped at a key file, or its unlink failed), and that link is still there. */
function placeNotes(notes: string[], removed: string[]): { gone: string[]; staged: string[]; remaining: string[] } {
  const placed = { gone: [] as string[], staged: [] as string[], remaining: [] as string[] };
  for (const note of notes) {
    if (note.endsWith(STAGED_SUFFIX)) placed.staged.push(note);
    else if (
      removed.some((name) => note.startsWith(`${name} was a link to `)) &&
      GONE_ENDINGS.some((end) => note.endsWith(end))
    ) {
      placed.gone.push(note);
    } else placed.remaining.push(note);
  }
  return placed;
}

/** The names a staged-copies note names (Rust joins them with ", "). Only a piece that starts with
 *  {@link STAGED_PREFIX} is one (M9 LOW pass, L21): a staged copy whose own name holds ", " splits into
 *  pieces, and a piece that is not a staged name must not hide a real file of that name from the folder's
 *  line. */
function stagedNames(note: string): string[] {
  return note
    .slice(0, -STAGED_SUFFIX.length)
    .split(", ")
    .filter((piece) => piece.startsWith(STAGED_PREFIX));
}

/** One line of "Still on this machine": prose, or `code` — text the user copies as it is (the manual
 *  steps, a per-path command), drawn as-is. */
export type StillLine = { kind: "text" | "code"; text: string };

/** A kept or failed path, with its reason when it has one. */
function pathLine(what: string, report: PathReport): string {
  return `${what}${report.reason === null ? "" : `: ${report.reason}`} (${report.path})`;
}

/**
 * The done screen's "Still on this machine" block (spec 3.6.3): only what remains, in this order —
 *   1. the scheduler, when `kept`, `notChecked` or anything is `leftover`: what is left, then the
 *      manual steps (the engine's `removeSteps`, or the static copy for this OS when that is `null`),
 *      then each of `leftoverCommands`, then the app's closing line, once;
 *   2. the settings: the folder when the box was not ticked; otherwise why the step removed nothing or
 *      stopped, the key files kept or not removed, the unknown key reference, the names still in the
 *      folder — ONE line, the staged copies named once in it, with their description (Rust's note) —
 *      and the notes about what remains (a kept link target, another link still holding a file);
 *   3. the Linux engine copies kept or not removed.
 * Nothing here was removed: removals are {@link removedList}'s — a linked config's note about a target
 * that is gone included — and the scheduler's outcome is {@link schedulerOutcomeLine}'s.
 */
export function stillOnThisMachine(report: UninstallReport): StillLine[] {
  const lines: StillLine[] = [];
  const text = (t: string) => lines.push({ kind: "text", text: t });
  const code = (t: string) => lines.push({ kind: "code", text: t });

  const schedule = report.schedule;
  if (schedule.outcome === "kept" || schedule.outcome === "notChecked" || schedule.leftover.length > 0) {
    if (schedule.leftover.length > 0) text(`Background scheduler: ${schedule.leftover.join(", ")}`);
    else if (schedule.outcome === "kept") text("Background scheduler: still set up");
    else text("Background scheduler: any that may exist is still set up");
    const steps = schedule.removeSteps ?? staticRemoveSteps(report.os);
    if (steps !== null) code(steps);
    for (const command of schedule.leftoverCommands) code(command);
    if (steps !== null || schedule.leftoverCommands.length > 0) text(MANUAL_STEPS_APP_CLOSING);
  }

  const settings = report.settings;
  if (!settings.asked) {
    text(
      settings.folder === null
        ? "Your settings folder (the engine couldn't say where it is)"
        : `Your settings folder: ${settings.folder}`,
    );
  } else {
    // Refused AND unknown (a kept scheduler, with `configPath` unknown): one line, led by the refusal.
    // The engine data's own refusal is already on the screen ({@link engineDataLine}); the same one
    // here is pointed at, not said twice (spec 3.6.3, "each thing is said once").
    if (settings.refused !== null) {
      const unknown = settings.error === null ? "" : ` The engine also couldn't say where they are (${settings.error}).`;
      const why = settings.refused === report.engineRefused ? `${SAME_REASON}.` : ` — ${settings.refused}`;
      text(`Settings: nothing removed${why}${unknown}`);
    } else if (settings.error !== null) {
      text(`Settings: ${settings.error}`);
    }
    for (const key of settings.keyFiles) {
      if (key.outcome === "kept") text(pathLine("Key file kept", key));
      if (key.outcome === "failed") text(pathLine("Key file couldn't be removed", key));
    }
    if (settings.keyRefsUnknown) {
      text("A settings file couldn't be read, so its key file couldn't be identified; check the names below.");
    }
    // The staged copies are among `remaining` AND named by their note: said once, by the note, in the
    // folder's one line — after the other names.
    const notes = placeNotes(settings.notes, settings.removed);
    const staged = new Set(notes.staged.flatMap(stagedNames));
    const others = settings.remaining.filter((name) => !staged.has(name));
    const inFolder = [...(others.length > 0 ? [others.join(", ")] : []), ...notes.staged];
    if (inFolder.length > 0) {
      const where = settings.folder === null ? "" : ` (${settings.folder})`;
      text(`In your settings folder${where}: ${inFolder.join("; ")}`);
    }
    for (const note of notes.remaining) text(note);
  }

  for (const copy of report.engineCopies) {
    if (copy.outcome === "kept") {
      // Kept for the engine data's own refusal (spec 3.5.2): pointed at, not said twice.
      const same = report.engineRefused !== null && copy.reason === report.engineRefused;
      text(same ? `Engine copy kept${SAME_REASON} (${copy.path})` : pathLine("Engine copy kept", copy));
    }
    if (copy.outcome === "failed") text(pathLine("Engine copy couldn't be removed", copy));
  }
  return lines;
}

/** How "Still on this machine" points at a refusal the engine-data line already gives in full. */
const SAME_REASON = ", for the same reason as the engine data";

/**
 * The done screen's "Removed" list: the completed removals the per-entry lines do not already give —
 * each key file removed or already gone (with its note), the settings names removed (spec 3.5.3: every
 * name removed is listed), then the notes on a removed linked config whose target is gone too (removed
 * as the key file, or not there; checkpoint M6a F2), and the Linux engine copies removed. When the
 * settings step ran and no settings file names a key file, it says so, where the key files would be.
 * Nothing here goes under {@link stillOnThisMachine}.
 */
export function removedList(report: UninstallReport): string[] {
  const lines: string[] = [];
  const settings = report.settings;
  if (settings.asked) {
    for (const key of settings.keyFiles) {
      const note = key.reason === null ? "" : `; ${key.reason}`;
      if (key.outcome === "removed") lines.push(`API key file removed (${key.path})${note}`);
      if (key.outcome === "absent") lines.push(`API key file was already gone (${key.path})${note}`);
    }
    const ran = settings.refused === null && settings.error === null;
    if (ran && settings.keyFiles.length === 0 && !settings.keyRefsUnknown) {
      lines.push("No key file is named in your settings.");
    }
    for (const name of settings.removed) lines.push(`Settings file removed (${name})`);
    lines.push(...placeNotes(settings.notes, settings.removed).gone);
  }
  for (const copy of report.engineCopies) {
    if (copy.outcome === "removed") lines.push(`Engine copy removed (${copy.path})`);
  }
  return lines;
}

/**
 * The engine-data leg's one line when it removed nothing, for the per-entry report; `null` otherwise.
 * Two cases, each ONE line:
 *   • REFUSED (`engineRefused`): "engine data: nothing removed — <the refusal verbatim>". When the folder
 *     was unknown as well (`keep` with a detected scheduler while `status --json` failed — Rust then sets
 *     both `engineRefused` and `engineError`), the engine's error follows the refusal in the same line, so
 *     "not removed" is not said twice;
 *   • ERROR only (`engineError`, the consented leg could not run because the engine could not say where its
 *     data lives): "engine data: not removed — <the error>".
 */
export function engineDataLine(report: UninstallReport): string | null {
  if (report.engineRefused !== null) {
    const unknown =
      report.engineError === null ? "" : ` The engine also couldn't say where its data lives (${report.engineError}).`;
    return `engine data: nothing removed — ${report.engineRefused}${unknown}`;
  }
  if (report.engineError !== null) return `engine data: not removed — ${report.engineError}`;
  return null;
}
