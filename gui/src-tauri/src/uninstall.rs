//! T25 (B25) — the Settings-side "Uninstall app" action.
//!
//! ## What it removes, and what it never touches
//!
//! Three legs, each reported separately (`docs/gui-seam.md` §16):
//!
//!   1. **The app's own autostart entry** — T19's plugin `disable()`, REUSED through
//!      `autostart::disable_now` (the same sink-or-plugin resolution the autostart commands use),
//!      never a hand-rolled plist removal. The real plugin leg is VM-gated exactly as T19's is
//!      (§12c); the suite drives a recording sink. Its read and `disable()` run under
//!      `autostart::lock_changes` — the same lock the toggle's ON holds across its branding
//!      `rename`, which could otherwise re-create the plist this leg just removed (Phase E M5b).
//!   2. **The app's own files** — the enumerated records in `app_data_dir()`
//!      ([`APP_DATA_FILES`], [`APP_DATA_DIRS`]) and the window-state file in `app_config_dir()`
//!      ([`APP_CONFIG_FILES`]). ⚠ TWO directories on purpose, MEASURED rather than assumed:
//!      `tauri-plugin-window-state` 2.4.1 saves through `app_config_dir()`
//!      (`src/lib.rs:122-124`), not `app_data_dir()` — the two coincide on macOS
//!      (`~/Library/Application Support/<bundle-id>`) and DIVERGE on Linux
//!      (`~/.config/<id>` vs `~/.local/share/<id>`), so a single-dir list would leave the
//!      window-state file behind on exactly the platform where nobody would notice.
//!   3. **Only behind the explicit `removeEngineState` consent flag** — the engine state
//!      directory's contents, and NOT one file more: [`ENGINE_STATE_REMOVALS`] mirrors
//!      `scripts/uninstall.sh`'s bounded list — its `rm … "$SUPPORT"/<token>` lines — token for
//!      token, and `tests/uninstall.rs` PARSES the script at test time and asserts set-equality
//!      (the T9 pathEnv parity pattern) — the two spellings cannot drift silently. The state dir is
//!      the ENGINE's answer (`status --json` → `paths.stateDir`, absolutised), never a webview
//!      operand. On Linux the same consent also covers the managed engine copies OUTSIDE that
//!      directory (Batch 2, spec 3.5.2; below).
//!
//! ⚠ **NEVER a recursive delete of the support directory.** The engine leg's only
//! `remove_dir_all`s are on the two SUBDIRECTORIES the script itself `rm -rf`s — `briefings` (the
//! archive) and `provider-cwd` (the provider's scratch working folder; a symlink there is unlinked,
//! never followed) — and every other entry is one named file or a one-star glob. Since Batch 2 the
//! list names every file the engine owns at the state root (spec 3.5.1: `src/json.ts`'s
//! `engineOwns`), so what it deliberately leaves is `schedule.json` — the scheduler's record, the
//! ENGINE's to remove (`schedule uninstall`, the scheduler step below; while it is there the leg is
//! refused) — and anything this module has never heard of, which `tests/uninstall.rs` pins as a
//! survivor. The CLI's own managed binary lives in this directory too on macOS, and on a machine
//! where the CLI is the user's daily tool an unconsented removal would break it: the reason the
//! leg is consent-gated at all. (The consented list DOES include `daily-briefing`, because the
//! script's does: consent here means "remove the engine's data and its managed copy", the same
//! meaning `bash scripts/uninstall.sh` has.)
//!
//! ⚠ **The Linux managed copy lives OUTSIDE the state dir** (Batch 2, spec 3.5.2):
//! `~/.local/share/daily-briefing/bin/daily-briefing`, and the same under `$XDG_DATA_HOME` when
//! this app has an absolute one ([`managed_engine_copies`]; never read from a record). Rust LOOKS
//! at each, and removes one only when the consented engine-data step actually runs — not refused,
//! the folder known — and then only after its ownership checks (`daily-briefing/` and `bin/` real
//! directories, not links, and all three this user's), with those two folders removed only if
//! empty, never recursively ([`engine_copy_leg`]). Otherwise each one there is kept, and the report
//! says why. They are reported in `engineCopies`, never in the engine's token list. The script has
//! no matching line — its paths are macOS-only — and on macOS there is no such candidate: the copy
//! is the state dir's `daily-briefing`, on the bounded list (spec question SQ5).
//!
//! ⚠ **While a schedule record exists the consented leg removes NOTHING** (Phase E final harden
//! round 2, A-M1 — superseding round 1's "keep only the engine copy"). `scripts/uninstall.sh`
//! removes nothing while `$RECORD` (`<state>/schedule.json`) exists until the engine has removed
//! its own schedule, and stops when no engine new enough to do that is there (its scheduler block,
//! Batch 2 spec 3.6.6): the trigger that
//! record describes — the CLI's OR this app's, both install the same `local.daily-briefing` unit —
//! runs the managed binary (`src/schedule/install.ts`, `managedBinPath`, the record's `binPath`),
//! calls the provider and writes this directory every time it delivers. Round 1 kept only
//! `daily-briefing` and deleted the rest; that left the schedule running the kept copy, calling the
//! provider every morning and RE-CREATING the archive and log the user had just consented to
//! delete. So while the GATE LOOK (below) sees a record, the leg removes nothing at all and reports
//! ONE refusal ([`UninstallReport::engine_refused`], [`REFUSED_FOR_SCHEDULE`]). Since Batch 2 the
//! scheduler step (below) has asked the engine to remove the scheduler BEFORE that look, so a
//! record the gate still sees is one the engine left behind, or one installed in between. The
//! record's owner is deliberately NOT read by the gate: an unreadable or foreign record refuses
//! exactly like this app's own. The login-item and app-file legs run as before.
//!
//! ⚠ **An unreadable record refuses too** (round 3, B3-L1): an unparseable record, or a dangling
//! symlink, still refuses the leg (it fails toward not deleting). Since Batch 2's engine work (M3,
//! spec 3.1.2) the engine counts such a record as INSTALLED: `daily-briefing schedule uninstall`
//! from a terminal removes it (exit 0), and the app's call is refused as not this app's (exit 2) —
//! so here the scheduler step answers `ScheduleForeign` unless the webview sent `removeAny`, and
//! with `removeAny` the engine removes the record before the gate looks. The Schedule screen offers
//! its removal for such a record too (spec 3.4.1: the record FILE, readable or not), so no record
//! is a dead end any more, and [`REFUSED_FOR_SCHEDULE`] names only those two ways out (spec 3.6.1,
//! 3.6.4: its old "the record is stale: delete `schedule.json`" clause is gone).
//!
//! ⚠ **A scheduler UNIT FILE with no record refuses the same way** (round 3, D3-L4). An older install
//! (`scripts/install.sh`, or an engine from before the record existed), or a terminal install under
//! another `$XDG_CONFIG_HOME`, can leave a unit the engine writes —
//! `~/Library/LaunchAgents/local.daily-briefing.plist`, or on Linux
//! `daily-briefing.{service,timer}` under either `systemd/user` folder ([`schedule_unit_files`]) —
//! with no `schedule.json`, and that unit runs the very copy the consented leg would delete. So the
//! legs also refuse while the gate look sees one of those FILES: a presence check (`lstat`) only —
//! this module never asks `launchctl` or `systemctl` anything — and the refusal
//! ([`refused_for_unit`]) names the unit and the command that removes it, first, with no record
//! clause: there is no record (round 4, B4-L6; it used to be [`REFUSED_FOR_SCHEDULE`] with the unit
//! appended). After the scheduler step, such a unit is one the app-spawned engine could not see
//! ([`REFUSED_FOR_UNIT_RULE`] says why its way out is the terminal).
//!
//! ⚠ **The report says what the gate saw** (round 4, G4-L1): the legs are refused on ONE look
//! ([`ScheduleSeen`]) and the report states that same look — never a second sample. Since Batch 2
//! `uninstall_execute` looks twice, for two different jobs: a FIRST look before the scheduler step,
//! which only feeds detection (spec 3.3.3), and the GATE look after it, which the legs are refused
//! on and the report states (`scheduleRecordPresent`, `scheduleUnitFile`, `schedule.leftover`).
//!
//! ## The scheduler step, and the order of everything (Batch 2, spec 3.3.4)
//!
//! `uninstall_execute` removes the scheduler FIRST, through the engine, so the legs after it are
//! not refused by a schedule this app installed (Batch 2 item 20):
//!
//!   1. **The reads and a first look** — `status --json` (the state dir); `schedule status --json`
//!      (the engine's own facts: a read that fails is "status unreadable", never the all-default
//!      view, [`engine_schedule_view`]); and a first [`ScheduleSeen::look`]. A scheduler is
//!      DETECTED when that look sees a record or a unit, or the read says `recordFilePresent` or
//!      `registered: true`. Its owner is `app` only when the read succeeded with a readable record
//!      owned by `app` (spec 3.3.3) — never from Rust's own look, which reads no owner.
//!   2. **The settings lock** ([`ConfigSaver`]'s), awaited here when the settings will be removed
//!      and held to the end, so a save cannot re-create a file behind that leg — taken BEFORE the
//!      gate look, so nothing is awaited between that look and the legs.
//!   3. **The scheduler** ([`SchedulerChoice`]): `keep` calls nothing; `removeOwn` refuses an
//!      unreadable status (`ScheduleFailed`, [`SCHEDULE_STATUS_UNREADABLE`]) or a detected
//!      scheduler not owned by `app` (`ScheduleForeign`, so the webview asks), and otherwise runs
//!      `schedule uninstall --invoker app`; `removeAny` runs it with `--take-over`. The engine's
//!      answer maps as spec 3.3.4.3 says (`remove_scheduler`). On EVERY `Err` nothing has been
//!      removed and no later step runs: this step is before all of them.
//!   4. **The login item** — leg 1 below, moved after the scheduler step, otherwise unchanged.
//!   5. **The gate look** — a fresh [`ScheduleSeen::look`], with nothing awaited between it and
//!      the legs.
//!   6. **Engine data**, if consented and not refused: [`REFUSED_FOR_KEPT_SCHEDULER`] first (`keep`
//!      with a scheduler detected by either look), then the gate look's own refusal. The Linux
//!      engine copies are looked at here too, and removed only when this step runs
//!      ([`engine_copy_leg`]).
//!   7. **Settings**, if consented and not refused — [`REFUSED_FOR_KEPT_SCHEDULER`], then the gate
//!      look's refusal, then (this step only) an error when the engine's `configPath` is unknown —
//!      under the lock of step 2, which is still held ([`settings_leg`], below).
//!   8. **The app's own files** (leg 2 below).
//!
//! ## The settings leg (Batch 2, spec 3.5.3) — it removes the user's settings and API key files
//!
//! ⚠ **Only behind the explicit `removeSettings` consent, and only in the folder the ENGINE names**:
//! the parent of `status --json`'s absolute `paths.configPath` (never a path computed from `HOME`
//! here). Its whole reach is: each key file a readable config names (`provider.api.apiKeyFile`,
//! `~`-expanded) — removed FIRST, and only when it is a regular file whose parent IS that folder by
//! identity (device and inode after `canonicalize`) and is not `config.json` or `config.json.bak` by
//! identity; then `config.json`, then `config.json.bak` (unlinked: a link loses the link, never its
//! target); then the folder itself, only if it is now empty, through the non-recursive
//! [`UninstallFs::remove_empty_dir`]. A folder that is a link is not entered. A key file that will
//! not unlink stops the leg with both configs kept. `.config.json.save-*` staged copies are named,
//! not removed. Once the `config.json` step has completed, [`ConfigSaver`]'s "settings removed"
//! latch is set before the save lock is let go, so every later settings write in this app session
//! refuses — `uninstall_execute` itself never does.
//!
//! ⚠ **What this deliberately does NOT do:** it never runs `launchctl` or `systemctl` itself (spec
//! 3.3.9), and it never removes a scheduler unit or record by a file removal. The scheduler is the
//! ENGINE's to remove: step 3 asks `daily-briefing schedule uninstall` — the same subcommand the
//! Schedule screen's own flow (`ScheduleUninstall.svelte`) runs — which acts by label, removes the
//! unit and the record itself, and says success only once its own check finds the job gone.
//! Whatever `scripts/uninstall.sh` does about the scheduler's unit (`$PLIST`) or record (`$RECORD`)
//! is likewise never one of its `$SUPPORT`-rooted `rm` lines — which is why the parity list below
//! is exactly that subset.
//!
//! ⚠ **The consented leg can remove the briefing archive** (`briefings/`, `briefing.log`) — the
//! one surface in the app that can, and the reason the flag defaults OFF and the dialog names the
//! archive explicitly. This is an uninstall with consent, not a pruning offer; T13's
//! retention-stays-unbounded rule is about the app's ordinary surfaces and is unchanged
//! (`docs/gui-seam.md` §16, deviation 159).
//!
//! Every removal goes through the injectable [`UninstallFs`] sink (the B8 `ShimSink` pattern), and
//! every look but one (a linked settings config, read through outside it — the sink's docs); the
//! real [`SystemFs`] is constructed in `lib.rs` only, and every test drives a recorder or a scratch
//! directory.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::briefing_files::{
    absolute, engine_paths, engine_schedule_view, read_text_capped, ReadRefusal,
};
use crate::config_save::ConfigSaver;
use crate::engine::{
    Engine, EngineClient, EngineError, EngineOutcome, Invoker, NoProgress, Operation,
};
use crate::schedule_state::ScheduleView;
use crate::{access, autostart, config_save, notifications};

/* ── the bounded lists ────────────────────────────────────────────────────────────────────────── */

/// How one engine-state entry is removed — the same three shapes the script's `rm` lines have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    /// `rm -f "$SUPPORT"/<name>` — one file.
    File,
    /// `rm -f "$SUPPORT"/<prefix>*<suffix>` — direct children matching the one-star pattern.
    Glob,
    /// `rm -rf "$SUPPORT"/<name>` — one directory, recursively. The ONLY recursive removals in
    /// this module are the entries carrying this kind.
    Dir,
}

/// One engine-state removal, spelled EXACTLY as `scripts/uninstall.sh` spells it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineEntry {
    /// The `$SUPPORT`-relative token from the script — a bare name or a one-star glob, never a
    /// path (no separator; `tests/uninstall.rs` pins that too).
    pub token: &'static str,
    pub kind: EntryKind,
}

/// The consent-gated engine-state list: `scripts/uninstall.sh`'s `$SUPPORT`-rooted removals (its
/// `rm … "$SUPPORT"/<token>` lines), token for token. Set-equality with a test-time PARSE of the script is pinned by
/// `tests/uninstall.rs` (`the_engine_list_is_the_scripts_support_rooted_list`), so editing either
/// side alone goes red. Nothing the script does about `$PLIST` is here — module header.
pub const ENGINE_STATE_REMOVALS: &[EngineEntry] = &[
    EngineEntry {
        token: "daily-briefing",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "wake-schedule.json",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "briefing.log",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "briefing-latest.md",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "briefing.log.1",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "transcript-health.json",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "audit-*.md",
        kind: EntryKind::Glob,
    },
    EngineEntry {
        token: "briefings",
        kind: EntryKind::Dir,
    },
    // Phase E (E11): the opt-in update check's last answer, `src/updateCheck.ts`.
    EngineEntry {
        token: "update-check.json",
        kind: EntryKind::File,
    },
    // Batch 2 (spec 3.5.1): the rest of what the engine owns at the state root (`src/json.ts`'s
    // `engineOwns`) — the day marker and tick (`src/marker.ts`), the skip record, the run lock
    // (`src/runlock.ts`), the account store (`src/account.ts`) and the recap-campaigns record.
    EngineEntry {
        token: "last-run",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "last-tick",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "last-skip.json",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "run.lock",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "account-state.json",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "recap-campaigns.jsonl",
        kind: EntryKind::File,
    },
    // Batch 2 (spec 3.5.1): the provider's scratch working folder (`src/harden.ts`), removed with
    // its contents the way `briefings` is. `remove_dir_all` removes a top-level symlink itself
    // without following it (`tests/uninstall.rs` pins that).
    EngineEntry {
        token: "provider-cwd",
        kind: EntryKind::Dir,
    },
];

/// The engine's single-owner schedule record, `<state>/schedule.json` (`src/schedule/install.ts`,
/// `schedulePath`) — `scripts/uninstall.sh`'s `$RECORD`. Never removed here; while it EXISTS, the
/// consented leg removes nothing and reports [`REFUSED_FOR_SCHEDULE`] (module header).
pub const SCHEDULE_RECORD: &str = "schedule.json";

/// The launchd unit the engine writes on macOS — `src/schedule/units.ts`'s `SCHEDULE_LABEL` plus
/// `.plist` (`src/schedule/install.ts`, `unitPaths`). `tests/uninstall.rs` parses `units.ts` for it.
pub const LAUNCHD_UNIT: &str = "local.daily-briefing.plist";

/// The systemd user units the engine writes on Linux — `src/schedule/units.ts`'s
/// `SYSTEMD_SERVICE_NAME` and `SYSTEMD_TIMER_NAME`. `tests/uninstall.rs` parses `units.ts` for them.
pub const SYSTEMD_UNITS: &[&str] = &["daily-briefing.service", "daily-briefing.timer"];

/// Why the consented engine-data and settings legs removed nothing when the GATE look — after the
/// scheduler step — still sees a schedule RECORD ([`UninstallReport::engine_refused`],
/// `SettingsReport::refused`): one the engine left behind, or one installed in between. In the
/// report's own words, with the way out named exactly, and of "these files": since Batch 2 the
/// refusal covers the settings step too (spec 3.6.4). `Remove background scheduler…` is the
/// Schedule screen's own button (`gui/src/lib/ScheduleUninstall.svelte`; `tests/uninstall.rs` pins
/// the label against that file), and the rule sentence is `lib/app-uninstall.ts`'s
/// `SCHEDULE_RECORD_RULE` (which `tests-web` holds this text to). The owner is not read (module
/// header), so both ways out are named — and both reach every record: the Schedule screen shows its
/// button whenever the engine sees the record FILE, readable or not (spec 3.4.1), and the engine
/// counts a malformed or dangling record as installed and removes it (spec 3.1.2). So no record is
/// a dead end, and the old stale-record clause ("delete `schedule.json`") is gone (spec 3.6.1). A
/// record-LESS unit file has its own refusal, [`refused_for_unit`] (round 4, B4-L6).
pub const REFUSED_FOR_SCHEDULE: &str = "a background schedule's record (schedule.json) is still \
     there, and while that schedule is installed it keeps running the background engine copy, \
     which needs these files. Uninstall removes none of these files while a background schedule \
     is installed: remove the schedule first (Schedule screen → Remove background scheduler…), or \
     run `daily-briefing schedule uninstall` if you installed it from the terminal, then run \
     Uninstall again.";

/// Why the consented legs removed nothing while a scheduler is being KEPT (Batch 2, spec 3.3.5.1):
/// the call said `keep`, and a scheduler was detected — by the first look or the reads, or by the
/// gate look, a registration with no files included. Checked BEFORE the gate look's own refusal. A
/// kept scheduler still runs the engine copy and writes the state folder, so it still needs these
/// files. With `keep` and nothing detected, nothing is refused (decision A, round-5 cap).
/// `lib/app-uninstall.ts`'s `REFUSED_FOR_KEPT_SCHEDULER` is this text;
/// `tests-web/coexistence.check.ts` holds the two equal.
pub const REFUSED_FOR_KEPT_SCHEDULER: &str =
    "A background scheduler is being kept, and it still needs these files.";

/// `removeOwn` with the scheduler's status unreadable (spec 3.3.4.3): Rust cannot tell whose
/// scheduler it would remove, so it removes none and says so (`UninstallError::ScheduleFailed`).
pub const SCHEDULE_STATUS_UNREADABLE: &str = "Couldn't read the background scheduler's status.";

/// The rule sentence for a scheduler unit file with NO record (round 4, B4-L6) — its own, way out
/// first — of "these files", as [`REFUSED_FOR_SCHEDULE`] is (Batch 2, spec 3.6.4).
///
/// ⚠ WHY THE TERMINAL, NOT THE SCHEDULE SCREEN (rewritten in Batch 2: the old reason — "the Schedule
/// screen offers its removal only where there is a record" — is false since spec 3.4.1, which shows
/// that button for a unit too). The refusal comes from the GATE look, after the scheduler step: a
/// unit the engine THIS app spawns can see is one that step already removed, or failed on with an
/// `Err` and nothing removed. So the unit named here is one only this module's look sees — in
/// practice a terminal install under a custom `$XDG_CONFIG_HOME` (spec §7), which that engine never
/// reads (`engine::FORWARDED_ENV`), so the Schedule screen never shows it either. From a terminal
/// the engine's own subcommand removes a unit with no record: it unregisters the job by its label
/// and then deletes the unit files (`src/schedule/install.ts`, `uninstallSchedule`); for a systemd
/// unit [`refused_for_unit`] adds the exact command for the unit's own folder
/// ([`unit_command_note`]). `lib/app-uninstall.ts`'s `SCHEDULE_UNIT_RULE` is this sentence;
/// `tests-web/coexistence.check.ts` holds the two equal.
pub const REFUSED_FOR_UNIT_RULE: &str = "Uninstall removes none of these files while a background \
     scheduler unit file is there: run `daily-briefing schedule uninstall` in a terminal, which \
     removes that scheduler and its unit file, then run Uninstall again.";

/// The refusal for a scheduler unit file with NO record (module header, round 3 D3-L4): the unit
/// the gate look still sees, why it refuses, then [`REFUSED_FOR_UNIT_RULE`] (round 4, B4-L6 — it
/// used to be [`REFUSED_FOR_SCHEDULE`] with the unit appended), and for a systemd unit the exact
/// command beside it, [`unit_command_note`] (cap round, G5-2: the rule cannot carry the unit's path).
pub fn refused_for_unit(unit: &Path) -> String {
    let refused = format!(
        "a background scheduler unit file ({}) is still there with no schedule record, and while \
         it is installed it keeps running the background engine copy, which needs these files. \
         {REFUSED_FOR_UNIT_RULE}",
        unit.display()
    );
    match unit_command_note(unit) {
        Some(note) => format!("{refused} {note}"),
        None => refused,
    }
}

/// Why a systemd unit needs its own command (cap round, G5-2), ending [`unit_command_note`]. The
/// webview's `UNIT_DIR_CLAUSE` (`lib/app-uninstall.ts`) is this sentence; `tests-web` holds the two
/// equal.
pub const UNIT_DIR_CLAUSE: &str = "`daily-briefing schedule uninstall` looks for it only under \
     `$XDG_CONFIG_HOME/systemd/user`, or `~/.config/systemd/user` when XDG_CONFIG_HOME is unset.";

/// The command that removes `unit` from a terminal when it is a systemd unit —
/// `<config>/systemd/user/<name>`, [`schedule_unit_files`]' Linux shape — else `None` (the macOS
/// plist, whose command is the rule's own, or a path that is not UTF-8).
///
/// ⚠ WHY (cap round, G5-2): this app looks under BOTH `$XDG_CONFIG_HOME/systemd/user` and
/// `~/.config/systemd/user`, but `daily-briefing schedule uninstall` looks only under the one ITS
/// environment names (`src/schedule/install.ts`, `unitDir`: `XDG_CONFIG_HOME ?? ~/.config`). From a
/// terminal whose `XDG_CONFIG_HOME` is not the found unit's, it reports nothing installed and the
/// unit keeps refusing the leg. So the command sets `XDG_CONFIG_HOME` to the unit's OWN config
/// directory — right for either directory, whatever the terminal has set — single-quoted for a POSIX
/// shell (each `'` as `'\''`), so a space or a quote in the path cannot split or end the value.
/// The webview builds no copy of this command (Batch 2): it shows the report's
/// `schedule.leftoverCommands` ([`leftover_commands`]) and every refusal text verbatim.
pub fn unit_uninstall_command(unit: &Path) -> Option<String> {
    let (dir, name) = unit.to_str()?.rsplit_once('/')?;
    let config = dir.strip_suffix("/systemd/user")?;
    if config.is_empty() || name.is_empty() {
        return None;
    }
    Some(format!(
        "XDG_CONFIG_HOME='{}' daily-briefing schedule uninstall",
        config.replace('\'', r"'\''")
    ))
}

/// The sentence beside [`REFUSED_FOR_UNIT_RULE`] for a unit [`unit_uninstall_command`] has a command
/// for, else `None`. It ends in [`UNIT_DIR_CLAUSE`], the half `tests-web` pins to the webview's.
pub fn unit_command_note(unit: &Path) -> Option<String> {
    unit_uninstall_command(unit).map(|command| {
        format!("To remove this unit file from a terminal, run `{command}`: {UNIT_DIR_CLAUSE}")
    })
}

/// The report's `schedule.leftoverCommands` (Batch 2, spec 3.3.6): for a `leftover` unit OUTSIDE
/// the unit folder of the engine this app spawns, its per-path [`unit_uninstall_command`]; nothing
/// otherwise. `engine_units` are that engine's own unit files — [`schedule_unit_files`] with NO
/// `$XDG_CONFIG_HOME`, because the app-spawned engine never sees one (`engine::FORWARDED_ENV`) — so
/// a unit among them is named by the engine's own steps (`removeSteps`), and one elsewhere (a
/// terminal install under a custom `$XDG_CONFIG_HOME`, spec §7) is not. Only a systemd unit has a
/// command of its own; the macOS plist has one folder. **Pure.**
pub fn leftover_commands(unit: Option<&Path>, engine_units: &[PathBuf]) -> Vec<String> {
    unit.filter(|unit| !engine_units.iter().any(|own| own.as_path() == *unit))
        .and_then(unit_uninstall_command)
        .into_iter()
        .collect()
}

/// The scheduler unit files the ENGINE writes on `os` (`std::env::consts::OS` spelling), for the
/// user whose home is `home` — `src/schedule/install.ts`'s `unitPaths` without its
/// `DBA_TEST_UNIT_DIR` test override. **Pure**, so both platforms' answers are pinned on either.
///
///   * `macos`: `~/Library/LaunchAgents/local.daily-briefing.plist`.
///   * `linux`: `daily-briefing.service` and `.timer` under `<config>/systemd/user`, for EACH of
///     `$XDG_CONFIG_HOME` (when this app was given one) and `~/.config`. The engine uses the first
///     when set, but the engine THIS app spawns never sees it (`engine::FORWARDED_ENV` clears it),
///     while one run from a terminal may have — so both are checked; an extra presence check can
///     only refuse more, never delete more.
///   * anything else: none (no desktop build ships there; the Windows task XML lives in the state
///     dir under a name the consented list does not touch).
pub fn schedule_unit_files(os: &str, home: &Path, xdg_config_home: Option<&Path>) -> Vec<PathBuf> {
    match os {
        "macos" => vec![home.join("Library").join("LaunchAgents").join(LAUNCHD_UNIT)],
        "linux" => {
            let mut configs: Vec<PathBuf> = Vec::new();
            if let Some(xdg) = xdg_config_home.filter(|p| !p.as_os_str().is_empty()) {
                configs.push(xdg.to_path_buf());
            }
            let default = home.join(".config");
            if !configs.contains(&default) {
                configs.push(default);
            }
            configs
                .iter()
                .flat_map(|config| {
                    SYSTEMD_UNITS
                        .iter()
                        .map(move |unit| config.join("systemd").join("user").join(unit))
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

/// The Linux engine copies an uninstall looks at (Batch 2, spec 3.5.2) —
/// `src/schedule/install.ts`'s `managedBinPath` on Linux,
/// `<data>/daily-briefing/bin/daily-briefing`, for `os` (`std::env::consts::OS` spelling).
/// **Pure**, so the answer is pinned on any platform.
///
///   * `linux`: under `~/.local/share`, plus under `$XDG_DATA_HOME` when this app was given one
///     that is ABSOLUTE and differs. A value that is not absolute is ignored, as the XDG
///     base-directory spec requires, so a relative one can never point the removal at this app's
///     working folder. The engine uses `$XDG_DATA_HOME` when set, but the engine THIS app spawns
///     never sees it, while one run from a terminal may have — so both are looked at; each is
///     removed only after [`engine_copy_leg`]'s ownership checks.
///   * anything else: none. On macOS the managed copy is the state dir's `daily-briefing`, already
///     on [`ENGINE_STATE_REMOVALS`] (spec question SQ5); on Windows it is in the state dir too.
pub fn managed_engine_copies(os: &str, home: &Path, xdg_data_home: Option<&Path>) -> Vec<PathBuf> {
    if os != "linux" {
        return Vec::new();
    }
    let copy = |data: &Path| data.join("daily-briefing").join("bin").join("daily-briefing");
    let mut copies = vec![copy(&home.join(".local").join("share"))];
    if let Some(xdg) = xdg_data_home.filter(|p| p.is_absolute()) {
        let other = copy(xdg);
        if !copies.contains(&other) {
            copies.push(other);
        }
    }
    copies
}

/// The first of `unit_files` that is there (`lstat`: a dangling symlink counts) — never a
/// scheduler query.
fn present_unit(fs: &dyn UninstallFs, unit_files: &[PathBuf]) -> Option<PathBuf> {
    unit_files.iter().find(|p| fs.exists(p)).cloned()
}

/// ONE look at what refuses the consented engine leg: the record and the unit files that are there
/// (the first of them is the one a refusal names). ⚠ The gate refuses on it AND the report states it
/// (round 4, G4-L1): the report used to sample the unit before the execute-time `status --json`
/// spawn while the gate looked again after it, so a unit that appeared in between was refused on but
/// reported absent — and the done view gave a stale-RECORD warning for a unit refusal. One
/// observation, taken immediately before the first removal, cannot disagree with itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleSeen {
    /// `<state>/schedule.json` is there ([`UninstallFs::exists`]).
    pub record: bool,
    /// The first of the unit files that is there, record or not — the first of [`Self::units`]: the one
    /// a refusal names, and the report's `scheduleUnitFile`.
    pub unit: Option<PathBuf>,
    /// EVERY unit file there (`lstat`, as [`present_unit`]), in the platform's order — the report's
    /// `schedule.leftover` names each (M9 LOW pass, L8: on Linux the service and the timer).
    pub units: Vec<PathBuf>,
}

impl ScheduleSeen {
    /// Look, once. Both are always looked at, so the report has both facts whichever refuses.
    pub fn look(fs: &dyn UninstallFs, state_dir: &Path, unit_files: &[PathBuf]) -> Self {
        Self::with_record(fs.exists(&state_dir.join(SCHEDULE_RECORD)), fs, unit_files)
    }

    /// The unit half of the look, beside a record fact already taken (`false` where no state dir is
    /// known to hold one) — the one place [`Self::unit`] is derived from [`Self::units`].
    fn with_record(record: bool, fs: &dyn UninstallFs, unit_files: &[PathBuf]) -> Self {
        let units: Vec<PathBuf> = unit_files.iter().filter(|p| fs.exists(p)).cloned().collect();
        Self {
            record,
            unit: units.first().cloned(),
            units,
        }
    }

    /// The refusal this observation means — the record's first, else the record-less unit's — or
    /// `None` when nothing refuses.
    pub fn refusal(&self) -> Option<String> {
        if self.record {
            return Some(REFUSED_FOR_SCHEDULE.to_string());
        }
        self.unit.as_deref().map(refused_for_unit)
    }
}

/// The app-owned records in `app_data_dir()` — the three `STORE_FILE` constants, referenced from
/// their owning modules so a rename there is a compile error here, not a leftover file.
pub const APP_DATA_FILES: &[&str] = &[
    autostart::STORE_FILE,
    notifications::STORE_FILE,
    access::STORE_FILE,
];

/// App-owned directories in `app_data_dir()`: T15's candidate staging dir (normally empty — every
/// save sweeps its own temp files — but a crash mid-save can leave one behind).
pub const APP_DATA_DIRS: &[&str] = &[config_save::CANDIDATE_SUBDIR];

/// App-owned files in `app_config_dir()`: the window-state plugin's file, named by the PLUGIN's
/// own constant so the two cannot drift (module header for the two-directory measurement).
pub const APP_CONFIG_FILES: &[&str] = &[tauri_plugin_window_state::DEFAULT_FILENAME];

/* ── the sink ─────────────────────────────────────────────────────────────────────────────────── */

/// What an `lstat` says an entry is ([`Lstat::kind`]) — the entry itself, never what a link points
/// at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LstatKind {
    File,
    Symlink,
    Dir,
    /// A FIFO, a socket, a device.
    Other,
}

/// [`UninstallFs::kind`]'s answer (Batch 2, spec 3.5.4): one `lstat`. The owner, identity and link
/// count are `None` off unix, where they cannot be read — so every check that needs them fails
/// toward keeping ([`engine_copy_leg`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lstat {
    pub kind: LstatKind,
    /// The owning uid.
    pub uid: Option<u32>,
    /// `(device, inode)`: the file's identity, whatever its name.
    pub id: Option<(u64, u64)>,
    /// How many directory entries name this file (for spec 3.5.3's other-link notes).
    pub links: Option<u64>,
    /// A symlink's target text, as written — never resolved. `None` for any other kind.
    pub link_target: Option<PathBuf>,
}

/// The filesystem effects, injectable so the suite can record or sandbox them (B8's `ShimSink`
/// shape). EVERY REMOVAL the module makes goes through here, and every look but one: a settings
/// config that is a LINK is read through by `notifications::read_engine_config_text`, outside the
/// sink ([`ConfigSeen::key_ref`]) — a read only, and only after this sink's `kind` said "link".
pub trait UninstallFs: Send + Sync {
    /// `symlink_metadata` presence — a broken symlink counts as present (it is removable), and so
    /// does a path that cannot be told absent ([`SystemFs::exists`]).
    fn exists(&self, path: &Path) -> bool;
    fn remove_file(&self, path: &Path) -> std::io::Result<()>;
    /// Called ONLY on the [`EntryKind::Dir`] entries and [`APP_DATA_DIRS`] — never on a state,
    /// data or config directory itself. `tests/uninstall.rs` pins the survivors.
    fn remove_dir_all(&self, path: &Path) -> std::io::Result<()>;
    /// Direct-child names of `dir`, for the one-star globs. Names, never paths.
    fn list_dir(&self, dir: &Path) -> std::io::Result<Vec<String>>;
    // ── Batch 2 (spec 3.5.4).
    /// One `lstat` of `path` ([`Lstat`]): the entry's own type, owner, identity and link count, and
    /// a symlink's target text. Never follows the last component.
    fn kind(&self, path: &Path) -> std::io::Result<Lstat>;
    /// `path` resolved: every symlink followed, `.` and `..` gone.
    fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf>;
    /// `path` as UTF-8 text of at most `max_bytes`, refusing a symlink, anything that is not a
    /// regular file, and a larger file — [`read_text_capped`]'s no-follow, non-blocking read.
    fn read_small(&self, path: &Path, max_bytes: u64) -> Result<String, ReadRefusal>;
    /// Remove `path` only if it is an EMPTY directory. NEVER recurses: a directory with anything in
    /// it is refused, and so is a file, and nothing is removed. Its two callers (the Linux copy's
    /// folders, the settings folder) check [`UninstallFs::kind`] first, so it is only ever asked
    /// about a real directory.
    fn remove_empty_dir(&self, path: &Path) -> std::io::Result<()>;
}

/// The real filesystem. Constructed in `lib.rs` only; tests inject fakes or scratch directories.
pub struct SystemFs;

impl UninstallFs for SystemFs {
    /// ⚠ ONLY "NO SUCH ENTRY" IS ABSENT (round 4, A4-L3). `NotFound`, and `NotADirectory` (a path
    /// component is a file, so nothing can be under it), say the entry is not there. Any other
    /// failure — `EACCES` on a parent that cannot be searched, an I/O error, a symlink loop on the
    /// way — says only that `lstat` could not answer, and counts as PRESENT: the record and unit
    /// gates refuse on a file they cannot rule out (`remove_engine_state`'s docs). It used to be
    /// `symlink_metadata(path).is_ok()`, which read every one of those as "absent".
    fn exists(&self, path: &Path) -> bool {
        match std::fs::symlink_metadata(path) {
            Ok(_) => true,
            Err(e) => !matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ),
        }
    }
    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }
    fn remove_dir_all(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_dir_all(path)
    }
    fn list_dir(&self, dir: &Path) -> std::io::Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            names.push(entry?.file_name().to_string_lossy().into_owned());
        }
        Ok(names)
    }
    fn kind(&self, path: &Path) -> std::io::Result<Lstat> {
        let meta = std::fs::symlink_metadata(path)?;
        let file_type = meta.file_type();
        let kind = if file_type.is_symlink() {
            LstatKind::Symlink
        } else if file_type.is_dir() {
            LstatKind::Dir
        } else if file_type.is_file() {
            LstatKind::File
        } else {
            LstatKind::Other
        };
        let link_target = if file_type.is_symlink() {
            std::fs::read_link(path).ok()
        } else {
            None
        };
        #[cfg(unix)]
        let (uid, id, links) = {
            use std::os::unix::fs::MetadataExt;
            (
                Some(meta.uid()),
                Some((meta.dev(), meta.ino())),
                Some(meta.nlink()),
            )
        };
        // Off unix there is no owner, identity or link count to read: unknown, so every check that
        // needs one keeps the file (§1.7's `#[cfg(not(unix))]` arm).
        #[cfg(not(unix))]
        let (uid, id, links) = (None, None, None);
        Ok(Lstat {
            kind,
            uid,
            id,
            links,
            link_target,
        })
    }
    fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf> {
        std::fs::canonicalize(path)
    }
    fn read_small(&self, path: &Path, max_bytes: u64) -> Result<String, ReadRefusal> {
        read_text_capped(path, max_bytes)
    }
    /// `rmdir`: refused for a non-empty directory or a file (on unix, for a symlink too) — never a
    /// recursion.
    fn remove_empty_dir(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_dir(path)
    }
}

/* ── managed state ────────────────────────────────────────────────────────────────────────────── */

/// The sink, the two app directories and the home the scheduler unit files are looked for under,
/// overridable by tests ONLY (the `MockRuntime` `app_data_dir()` is the developer's REAL one — the
/// `ConfigSaver`/`AccessState` trap — and the real home holds the developer's real
/// `local.daily-briefing` unit, which would refuse every consented test run).
pub struct UninstallState {
    fs: Arc<dyn UninstallFs>,
    app_data_dir: Option<PathBuf>,
    app_config_dir: Option<PathBuf>,
    home_dir: Option<PathBuf>,
    xdg_config_home: Option<PathBuf>,
    engine_copies: Option<Vec<PathBuf>>,
}

impl Default for UninstallState {
    fn default() -> Self {
        Self {
            fs: Arc::new(SystemFs),
            app_data_dir: None,
            app_config_dir: None,
            home_dir: None,
            xdg_config_home: None,
            engine_copies: None,
        }
    }
}

impl UninstallState {
    /// Test harness only.
    pub fn with_fs(mut self, fs: Arc<dyn UninstallFs>) -> Self {
        self.fs = fs;
        self
    }
    /// Test harness only.
    pub fn with_app_data_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.app_data_dir = Some(dir.into());
        self
    }
    /// Test harness only.
    pub fn with_app_config_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.app_config_dir = Some(dir.into());
        self
    }
    /// Test harness only — the home [`schedule_unit_files`] and [`managed_engine_copies`] are
    /// resolved under, and a `~` in a settings key path expands to ([`settings_leg`]; the settings
    /// FOLDER is always the engine's `configPath`'s). An overridden home also drops the ambient
    /// `$XDG_CONFIG_HOME` and `$XDG_DATA_HOME` (spec 3.5.2), so a test sees only the units and
    /// copies it planted, and can never resolve a developer's real Linux engine copy.
    pub fn with_home_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.home_dir = Some(dir.into());
        self
    }
    /// Test harness only — the Linux engine copies to look at, INSTEAD of
    /// [`managed_engine_copies`]' answer for this platform (none on macOS), so the copy leg's
    /// wiring is driven on any platform. Every path a test passes is under its own scratch home.
    pub fn with_engine_copies(mut self, copies: Vec<PathBuf>) -> Self {
        self.engine_copies = Some(copies);
        self
    }
    /// Test harness only — a `$XDG_CONFIG_HOME` to look under as well, beside the overridden home
    /// (and only with one: without [`Self::with_home_dir`] the process's own is used). It is how a
    /// test plants a unit outside the engine's own folder (spec 3.3.6, `leftover_commands`).
    pub fn with_xdg_config_home(mut self, dir: impl Into<PathBuf>) -> Self {
        self.xdg_config_home = Some(dir.into());
        self
    }

    /// The home and the `$XDG_CONFIG_HOME` the unit files are resolved under: the overrides, or
    /// else `HOME` (`USERPROFILE` on Windows, else `/` — `engine::home_dir`'s rule, the way the
    /// engine reads it) and this app's own `$XDG_CONFIG_HOME`.
    fn unit_roots(&self) -> (PathBuf, Option<PathBuf>) {
        if let Some(home) = &self.home_dir {
            return (home.clone(), self.xdg_config_home.clone());
        }
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let home = std::env::var_os(key)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"));
        let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
        (home, xdg)
    }

    /// The scheduler unit files to look for: [`schedule_unit_files`] for this platform, under
    /// [`Self::unit_roots`].
    fn unit_files(&self) -> Vec<PathBuf> {
        let (home, xdg) = self.unit_roots();
        schedule_unit_files(std::env::consts::OS, &home, xdg.as_deref())
    }

    /// The unit files of the engine THIS app spawns — under the home only: that engine never sees
    /// `$XDG_CONFIG_HOME` (`engine::FORWARDED_ENV`), so these are the ones its own removal steps
    /// name ([`leftover_commands`]).
    fn engine_unit_files(&self) -> Vec<PathBuf> {
        let (home, _) = self.unit_roots();
        schedule_unit_files(std::env::consts::OS, &home, None)
    }

    /// The engine copies [`managed_engine_copies`] names on `os`, under the home and the
    /// `$XDG_DATA_HOME` this state resolves them with: an overridden home with NO `$XDG_DATA_HOME`
    /// (spec 3.5.2 — the ambient one is dropped, as `$XDG_CONFIG_HOME` is), or else `HOME` and this
    /// app's own `$XDG_DATA_HOME`. `os` is an operand so the drop is pinned on any platform
    /// (`tests/uninstall.rs`).
    pub fn engine_copies_on(&self, os: &str) -> Vec<PathBuf> {
        let (home, _) = self.unit_roots();
        let xdg_data_home = if self.home_dir.is_some() {
            None
        } else {
            std::env::var_os("XDG_DATA_HOME").map(PathBuf::from)
        };
        managed_engine_copies(os, &home, xdg_data_home.as_deref())
    }

    /// The engine copies the uninstall looks at: the test harness's ([`Self::with_engine_copies`]),
    /// or this platform's ([`Self::engine_copies_on`]).
    fn engine_copies(&self) -> Vec<PathBuf> {
        self.engine_copies
            .clone()
            .unwrap_or_else(|| self.engine_copies_on(std::env::consts::OS))
    }

    fn data_dir<R: Runtime>(&self, app: &AppHandle<R>) -> Result<PathBuf, UninstallError> {
        if let Some(dir) = &self.app_data_dir {
            return Ok(dir.clone());
        }
        app.path()
            .app_data_dir()
            .map_err(|e| UninstallError::Store {
                detail: format!("this app's data directory could not be resolved: {e}"),
            })
    }

    fn config_dir<R: Runtime>(&self, app: &AppHandle<R>) -> Result<PathBuf, UninstallError> {
        if let Some(dir) = &self.app_config_dir {
            return Ok(dir.clone());
        }
        app.path()
            .app_config_dir()
            .map_err(|e| UninstallError::Store {
                detail: format!("this app's config directory could not be resolved: {e}"),
            })
    }
}

/* ── wire types ───────────────────────────────────────────────────────────────────────────────── */

/// Why a command could not answer at all. Per-entry failures are [`Outcome::Failed`] in the
/// report instead — one unremovable file must not hide what WAS removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UninstallError {
    /// An app directory could not be resolved; `detail` says which and why.
    Store { detail: String },
    // ── The scheduler step's refusals (Batch 2, spec 3.3.4.3, 3.3.7). On every one of them
    // `uninstall_execute` has removed nothing, and none of its later steps ran.
    /// A scheduler this app did not install was detected (or the engine answered exit 2 without
    /// take-over), and the call did not say to remove it: the webview asks first.
    ScheduleForeign { message: String },
    /// The scheduler step could not finish: the status read was unreadable, or the engine's
    /// `schedule uninstall` failed. `message` is the engine's stderr, or Rust's own sentence.
    ScheduleFailed { message: String },
    /// Another engine operation was in flight (the in-flight guard).
    Busy { message: String },
}

/// What `uninstall_execute`'s scheduler step is asked to do — its `schedule` argument (Batch 2,
/// spec 3.3.2). A missing `schedule` is [`SchedulerChoice::RemoveOwn`]: safe as a default, because
/// neither Rust (spec 3.3.4.3) nor the engine (spec 3.1.1) lets it act on a scheduler this app did
/// not install. The values are new, so they are named for what they do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SchedulerChoice {
    /// Remove this app's own scheduler, if there is one: `schedule uninstall --invoker app`.
    RemoveOwn,
    /// Remove whatever scheduler is there: `schedule uninstall --invoker app --take-over`.
    RemoveAny,
    /// Leave it. The engine is not called; a scheduler detected then refuses the data legs
    /// ([`REFUSED_FOR_KEPT_SCHEDULER`]).
    Keep,
}

/// What the scheduler step did (Batch 2, spec 3.3.6), as the report states it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SchedulerOutcome {
    /// The engine's `schedule uninstall` exited 0: its own check found the job gone.
    Removed,
    /// Nothing to remove: the engine's genuine exit 1 (its line on stdout, and nothing the status
    /// read had just reported against it), or `keep` with nothing detected by a check that ran.
    Absent,
    /// `keep`, with a scheduler detected — whether or not the check could run.
    Kept,
    /// `keep`, nothing detected, and a check that could not run (`registered: null`, or the status
    /// unreadable): there may be a scheduler nobody could see.
    NotChecked,
}

/// `UninstallReport::schedule` (Batch 2, spec 3.3.6-3.3.7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerReport {
    pub outcome: SchedulerOutcome,
    /// What the GATE look still saw, for any outcome: the record's path (when the state dir is
    /// known) and every unit file there, in the platform's order (M9 LOW pass, L8) — the same look
    /// the legs were refused on.
    pub leftover: Vec<String>,
    /// For a `leftover` unit outside the engine's own unit folder, its per-path command
    /// ([`leftover_commands`]); empty when there is none.
    pub leftover_commands: Vec<String>,
    /// The engine's manual removal steps from the status read (spec 3.1.8, no closing line), or
    /// `null` when that read failed — the webview then substitutes its static per-OS copy. Strictly
    /// the engine's: Rust holds no copy of its own.
    pub remove_steps: Option<String>,
}

/// One entry of the preview: what would be removed, and whether anything is there now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEntry {
    /// The bare name (or the glob token) inside its directory — never a full path.
    pub name: String,
    pub kind: EntryKind,
    /// For a glob: at least one match exists.
    pub present: bool,
}

/// `uninstall_preview`'s answer: the enumerated lists, resolved and inspected — nothing removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallPreview {
    pub app_data_dir: String,
    pub app_config_dir: String,
    pub app_entries: Vec<PreviewEntry>,
    /// `status --json`'s `paths.stateDir`; `null` with `engineError` set when the engine could
    /// not answer (the app legs are still previewable and executable).
    pub engine_state_dir: Option<String>,
    pub engine_error: Option<String>,
    pub engine_entries: Vec<PreviewEntry>,
    /// `is_enabled()`'s answer; `null` when it could not be read (`autostartError` says why).
    pub autostart_enabled: Option<bool>,
    pub autostart_error: Option<String>,
    /// Whether `<engine state dir>/schedule.json` exists (this module's own `lstat` look). Since
    /// Batch 2 it feeds the webview's detection (spec 3.3.3: a scheduler on disk is removed first,
    /// or asked about), no longer a block on the consent boxes: the gate look at execute time is
    /// what refuses ([`REFUSED_FOR_SCHEDULE`], module header). `false` when the engine state dir
    /// could not be resolved (nothing engine-side is offered).
    pub schedule_record_present: bool,
    /// The first scheduler unit file the engine writes ([`schedule_unit_files`]) that is there —
    /// with or without a record. Detection too (spec 3.3.3); the gate look refuses on one at
    /// execute time (module header, round 3 D3-L4). `None` when none is.
    pub schedule_unit_file: Option<String>,
    // ── Batch 2 (spec 3.3.1): the preview's SECOND engine read, `schedule status --json`
    // ([`engine_schedule_view`]). Every fact below is the ENGINE's, beside Rust's own look above.
    // When that read failed, `schedule_status_unreadable` is true and each fact is unknown
    // (`null`, or `false` for the file fact) — which is NOT an all-default read: a read that
    // answered and reported nothing leaves `schedule_status_unreadable` false.
    /// The record's owner (`"cli"` / `"app"`), `null` when no readable record says.
    pub schedule_owner: Option<String>,
    /// `true` / `false` from the engine's registration check; `null` when the check could not
    /// run (`schedule_registered_reason` says why) or the read failed.
    pub schedule_registered: Option<bool>,
    /// Why `schedule_registered` is `null`, verbatim (`"no-user-manager"`, `"no-gui-session"`,
    /// `"timeout"`, `"spawn"`, `"unexpected"`).
    pub schedule_registered_reason: Option<String>,
    /// The engine's manual removal steps (spec 3.1.8), no closing line; `null` off launchd and
    /// systemd, or when the read failed (the webview then substitutes its static copy).
    pub schedule_remove_steps: Option<String>,
    /// The second read failed or timed out, or printed an envelope this app cannot read.
    pub schedule_status_unreadable: bool,
    /// The engine's `lstat` of `schedule.json`, readable or not (spec 3, "three record facts"), so
    /// the webview's detection matches Rust's (spec 3.3.3) even when `status --json` failed and
    /// [`Self::schedule_record_present`] could not look. `false` when the read failed.
    pub schedule_record_file_present: bool,
    /// The folder holding the engine's config: the parent of `status --json`'s `paths.configPath`,
    /// or `null` when that is unknown (not reported, relative, or the read failed).
    pub settings_folder: Option<String>,
    /// `std::env::consts::OS`: where the engine copy lives, and how the app itself is removed, is
    /// per platform (round 3, B3-L6), and the webview words it from this.
    pub os: String,
}

/// What happened to one entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum Outcome {
    Removed,
    Absent,
    Failed { detail: String },
}

/// One removal's report line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionReport {
    pub name: String,
    pub outcome: Outcome,
}

/// What happened to one path the report names in full (Batch 2, spec 3.3.7): removed; not there;
/// kept, with the reason; or a removal that failed, with the error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PathOutcome {
    Removed,
    Absent,
    Kept,
    Failed,
}

/// One full-path report line (Batch 2, spec 3.3.7) — `engineCopies`' shape: the path, shown with
/// `~` for home; what happened; and why, for `kept` and `failed` (`null` otherwise). Kept out of
/// the engine's [`ActionReport`] list, whose names are bare tokens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathReport {
    pub path: String,
    pub outcome: PathOutcome,
    pub reason: Option<String>,
}

/// Why a Linux engine copy that is there was kept when the engine-data box was not ticked (spec
/// 3.3.7, verbatim).
pub const COPY_NOT_ASKED: &str = "not asked";

/// `UninstallReport::settings` (Batch 2, spec 3.3.7, 3.5.3) — ALWAYS present. With `asked: false`
/// it only names the folder that stays. [`settings_leg`] fills it when the leg runs.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsReport {
    /// The settings box was ticked (`removeSettings: true`).
    pub asked: bool,
    /// The settings folder — the parent of `status --json`'s `paths.configPath`, the preview's
    /// `settingsFolder` — or `null` when that is unknown.
    pub folder: Option<String>,
    /// One line per distinct `provider.api.apiKeyFile` the readable configs name (spec 3.5.3 step
    /// 2), in the order named, the path after `~` expansion (a relative one as written): `removed`
    /// (its `reason` the other-link note when another link still holds it), `absent`, `kept` with
    /// why, or `failed` with the error. A path that IS `config.json` or `config.json.bak` by
    /// identity is "handled with <config> below", with that config's outcome.
    pub key_files: Vec<PathReport>,
    /// A config could not be read or parsed (or was a link whose target could not be read), so its
    /// key reference is unknown; any key file that survives is among [`Self::remaining`].
    pub key_refs_unknown: bool,
    /// The names steps 3-4 removed: `config.json`, `config.json.bak`. Key files are reported once,
    /// in [`Self::key_files`].
    pub removed: Vec<String>,
    /// Every name still in the folder after the leg, sorted — kept key files, another name still
    /// holding a removed file, staged copies, anything this module has never heard of.
    pub remaining: Vec<String>,
    /// Why the leg removed nothing, by rule: spec 3.3.5's refusal (a kept scheduler, or what the
    /// gate look saw), or a settings folder that is a link ([`settings_folder_link`]).
    pub refused: Option<String>,
    /// Why the leg could not run or finish: the `configPath` unknown (spec 3.3.5.3), a folder that
    /// is not one, a key file that would not unlink (the leg stopped there, both configs kept), a
    /// config that would not unlink.
    pub error: Option<String>,
    /// Spec 3.3.7's `notes: [string]`, always present (added at M5b, recorded in the spec's §16
    /// "Build corrections"). The facts spec 3.5.3 says the report gives that the names alone cannot
    /// carry, as sentences: a config that was a link ([`config_link_note`], or what became of its
    /// target, [`linked_config_note`]), a config removed while another link still holds it
    /// ([`config_other_link_note`]), and the staged copies ([`staged_copies_note`]). Key-file notes
    /// stay in [`Self::key_files`]' reasons.
    pub notes: Vec<String>,
}

/// `uninstall_execute`'s answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallReport {
    /// The T19 leg: `Removed` = the login item was disabled, `Absent` = it was not enabled.
    pub autostart: Outcome,
    /// The app-file legs, one line per enumerated entry.
    pub app: Vec<ActionReport>,
    /// True when at least one engine entry was ACTUALLY removed — derived from the outcomes,
    /// never echoed from the consent operand: consent over an empty state dir (all `Absent`), or
    /// with every removal refused (all `Failed`), reports false. (Round-1 fix F4: the old
    /// `consent && no resolution error` spelling reported true while every entry had failed.)
    pub engine_state_removed: bool,
    /// Empty unless consented — and empty when the leg was refused ([`Self::engine_refused`]).
    pub engine: Vec<ActionReport>,
    /// Set when consent was given but the leg removed NOTHING: a scheduler was being kept
    /// ([`REFUSED_FOR_KEPT_SCHEDULER`], checked first, state dir known or not — Batch 2), or the
    /// gate look saw a schedule record (only where the state dir resolved) — or, with none, a
    /// scheduler unit file, state dir known or not (M9 round 2: spec 3.3.5 puts this before an
    /// unknown dir, whose [`Self::engine_error`] is then set too) ([`REFUSED_FOR_SCHEDULE`] or
    /// [`refused_for_unit`]; module header). ONE refusal for the whole leg rather than a line per
    /// entry: no entry was attempted.
    pub engine_refused: Option<String>,
    /// The directory the consented engine leg targeted — `status --json`'s answer at EXECUTE
    /// time, absolutised, so the report names where the removals landed (round-1 fix M3: consent
    /// is rendered against the preview's resolution, and this is the auditable record of the
    /// execute-time one; both go through the same `engine_paths` read and `absolute` rule, so they
    /// can diverge only if the engine's own answer changed between the two spawns). `None` when the
    /// leg was not attempted or the engine could not answer; SET on a refusal too when it is known
    /// (the directory the refused leg targeted — a record's, a record-less unit's or a kept
    /// scheduler's alike).
    pub engine_state_dir: Option<String>,
    /// Set when consent was given but the engine could not name its state dir.
    pub engine_error: Option<String>,
    /// Whether `<state>/schedule.json` was there at EXECUTE time — checked whether or not consent
    /// was given (round 3, A3-L2), so the report states what is on disk after the run rather than
    /// what the preview saw (the done screen draws what remains from `schedule.leftover`, the same
    /// look — Batch 2, spec 3.6.3). With [`Self::schedule_unit_file`] it is ONE
    /// look ([`ScheduleSeen`], round 4 G4-L1) — the GATE look, taken after the scheduler step
    /// (Batch 2), the one the legs are refused on. `None` when the engine could not name its state
    /// dir at execute time.
    pub schedule_record_present: Option<bool>,
    /// The first scheduler unit file ([`schedule_unit_files`]) that was there at EXECUTE time, or
    /// `None` — checked whether or not consent was given; the same look as the record's.
    pub schedule_unit_file: Option<String>,
    /// Batch 2 (spec 3.3.6): what the scheduler step did, what the gate look still saw, and the
    /// ways to remove what may remain.
    pub schedule: SchedulerReport,
    /// Batch 2 (spec 3.3.7, 3.5.2): one line per Linux engine copy looked at
    /// ([`managed_engine_copies`], [`engine_copy_leg`]) — ALWAYS present, as an array: empty where
    /// there are no candidates, so `[]` on macOS (spec question SQ5).
    pub engine_copies: Vec<PathReport>,
    /// Batch 2 (spec 3.3.7, 3.5.3): the settings leg — ALWAYS present; with the box unticked it
    /// only names the folder that stays ([`SettingsReport`]).
    pub settings: SettingsReport,
    /// `std::env::consts::OS` — the done view's last step is per platform (round 3, B3-L6).
    pub os: String,
}

/* ── the removals, sink-driven and directly testable ──────────────────────────────────────────── */

fn remove_file_at(fs: &dyn UninstallFs, dir: &Path, name: &str) -> Outcome {
    match fs.remove_file(&dir.join(name)) {
        Ok(()) => Outcome::Removed,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Outcome::Absent,
        Err(e) => Outcome::Failed {
            detail: e.to_string(),
        },
    }
}

fn remove_dir_at(fs: &dyn UninstallFs, dir: &Path, name: &str) -> Outcome {
    match fs.remove_dir_all(&dir.join(name)) {
        Ok(()) => Outcome::Removed,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Outcome::Absent,
        Err(e) => Outcome::Failed {
            detail: e.to_string(),
        },
    }
}

/// `prefix*suffix` over a DIRECT-CHILD name. One star only — the script's `audit-*.md` shape;
/// `tests/uninstall.rs` pins that every glob token here has exactly one.
fn glob_matches(token: &str, name: &str) -> bool {
    let Some((prefix, suffix)) = token.split_once('*') else {
        return false;
    };
    name.len() >= prefix.len() + suffix.len() && name.starts_with(prefix) && name.ends_with(suffix)
}

fn remove_glob_at(fs: &dyn UninstallFs, dir: &Path, token: &str) -> Outcome {
    let names = match fs.list_dir(dir) {
        Ok(names) => names,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Outcome::Absent,
        Err(e) => {
            return Outcome::Failed {
                detail: e.to_string(),
            }
        }
    };
    let mut removed = false;
    let mut failures = Vec::new();
    for name in names.iter().filter(|n| glob_matches(token, n)) {
        match fs.remove_file(&dir.join(name)) {
            Ok(()) => removed = true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => failures.push(format!("{name}: {e}")),
        }
    }
    if !failures.is_empty() {
        return Outcome::Failed {
            detail: failures.join("; "),
        };
    }
    if removed {
        Outcome::Removed
    } else {
        Outcome::Absent
    }
}

/// The app-file legs: the records and candidate dir in `data_dir`, the window-state file in
/// `config_dir`. Enumerated removals only; the directories themselves are left in place.
pub fn remove_app_files(
    fs: &dyn UninstallFs,
    data_dir: &Path,
    config_dir: &Path,
) -> Vec<ActionReport> {
    let mut report = Vec::new();
    for name in APP_DATA_FILES {
        report.push(ActionReport {
            name: (*name).into(),
            outcome: remove_file_at(fs, data_dir, name),
        });
    }
    for name in APP_DATA_DIRS {
        report.push(ActionReport {
            name: (*name).into(),
            outcome: remove_dir_at(fs, data_dir, name),
        });
    }
    for name in APP_CONFIG_FILES {
        report.push(ActionReport {
            name: (*name).into(),
            outcome: remove_file_at(fs, config_dir, name),
        });
    }
    report
}

/// The consented engine leg: exactly [`ENGINE_STATE_REMOVALS`], each joined onto the ENGINE's
/// reported state dir. Never the directory itself — module header.
///
/// `Err` is the REFUSAL, and it means nothing was touched: while a [`SCHEDULE_RECORD`] exists the
/// leg removes nothing at all and answers [`REFUSED_FOR_SCHEDULE`]; with no record, while one of
/// `unit_files` ([`schedule_unit_files`]) exists, it answers [`refused_for_unit`] (module header).
/// Both are checked ONCE ([`ScheduleSeen::look`]), before the first removal, the way
/// `scripts/uninstall.sh` checks `$RECORD` before its `rm` lines, and a file that cannot be told
/// absent (`exists` is an `lstat`: a dangling symlink, or a path `lstat` cannot answer for, still
/// counts — [`SystemFs::exists`]) refuses — it fails toward not deleting.
pub fn remove_engine_state(
    fs: &dyn UninstallFs,
    state_dir: &Path,
    unit_files: &[PathBuf],
) -> Result<Vec<ActionReport>, String> {
    remove_engine_state_as_seen(
        fs,
        state_dir,
        &ScheduleSeen::look(fs, state_dir, unit_files),
    )
}

/// [`remove_engine_state`], gated on a look the caller has just taken and REPORTS
/// (`uninstall_execute`, round 4 G4-L1) — so the refusal and the report's schedule facts are one
/// observation. The caller takes it immediately before this call, with nothing awaited between.
fn remove_engine_state_as_seen(
    fs: &dyn UninstallFs,
    state_dir: &Path,
    seen: &ScheduleSeen,
) -> Result<Vec<ActionReport>, String> {
    if let Some(refused) = seen.refusal() {
        return Err(refused);
    }
    Ok(ENGINE_STATE_REMOVALS
        .iter()
        .map(|entry| ActionReport {
            name: entry.token.into(),
            outcome: match entry.kind {
                EntryKind::File => remove_file_at(fs, state_dir, entry.token),
                EntryKind::Glob => remove_glob_at(fs, state_dir, entry.token),
                EntryKind::Dir => remove_dir_at(fs, state_dir, entry.token),
            },
        })
        .collect())
}

/* ── the Linux engine copies (Batch 2, spec 3.5.2) ───────────────────────────────────────────── */

/// `path` as the report shows it (spec 3.3.7): `~/…` when it is under `home`, else in full. A home
/// of `/` (no `HOME` at all) contracts nothing.
fn shown(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if home.parent().is_some() && !rest.as_os_str().is_empty() => {
            format!("~/{}", rest.display())
        }
        _ => path.display().to_string(),
    }
}

/// This process's uid, for [`engine_copy_leg`]'s ownership checks.
#[cfg(unix)]
fn current_uid() -> Option<u32> {
    // SAFETY: `getuid` takes no arguments, cannot fail and touches no memory.
    Some(unsafe { libc::getuid() })
}

/// Off unix there is no uid to compare (§1.7's `#[cfg(not(unix))]` arm): unknown, so every copy
/// that is there is kept. No copy is a candidate off Linux anyway ([`managed_engine_copies`]).
#[cfg(not(unix))]
fn current_uid() -> Option<u32> {
    None
}

/// `stat` is owned by `uid` — both known and equal — else why not, naming `name`.
fn owned_by(stat: &Lstat, uid: Option<u32>, name: &str) -> Result<(), String> {
    match (stat.uid, uid) {
        (Some(owner), Some(uid)) if owner == uid => Ok(()),
        (Some(_), Some(_)) => Err(format!("{name} belongs to another user")),
        _ => Err(format!("{name}'s owner couldn't be checked")),
    }
}

/// Spec 3.5.2's check on one folder above a copy (`daily-briefing/` or `bin/`): a REAL directory —
/// an `lstat`, so a symlink is not one — owned by `uid`. `Err` is the reason it fails.
fn owned_folder(
    fs: &dyn UninstallFs,
    dir: &Path,
    uid: Option<u32>,
    home: &Path,
) -> Result<(), String> {
    let name = shown(dir, home);
    match fs.kind(dir) {
        Ok(stat) => match stat.kind {
            LstatKind::Dir => owned_by(&stat, uid, &name),
            LstatKind::Symlink => Err(format!("{name} is a link, not a real folder")),
            LstatKind::File | LstatKind::Other => Err(format!("{name} is not a folder")),
        },
        Err(e) => Err(format!("{name} couldn't be checked ({e})")),
    }
}

/// Once the step has UNLINKED a copy that passed every check (or found it gone at that unlink):
/// `bin/`, then `daily-briefing/`, each removed ONLY if it is empty
/// ([`UninstallFs::remove_empty_dir`], never a recursion) and only while both still pass
/// [`owned_folder`]. Best effort: a folder with anything else in it simply stays. Never for a copy
/// that was not there at the look (spec 3.5.2 sequences the folders AFTER removing the copy;
/// checkpoint M5b F6) — those folders are left as they are.
fn tidy_copy_folders(
    fs: &dyn UninstallFs,
    folder: &Path,
    bin: &Path,
    home: &Path,
    uid: Option<u32>,
) {
    let both_ours =
        owned_folder(fs, folder, uid, home).is_ok() && owned_folder(fs, bin, uid, home).is_ok();
    if both_ours && fs.remove_empty_dir(bin).is_ok() {
        let _ = fs.remove_empty_dir(folder);
    }
}

/// One copy's outcome and reason ([`engine_copy_leg`]).
fn copy_outcome(
    fs: &dyn UninstallFs,
    copy: &Path,
    home: &Path,
    uid: Option<u32>,
    kept_because: Option<&str>,
) -> (PathOutcome, Option<String>) {
    let name = shown(copy, home);
    let (Some(bin), Some(folder)) = (copy.parent(), copy.parent().and_then(Path::parent)) else {
        return (
            PathOutcome::Kept,
            Some(format!("{name} has no folder above it")),
        );
    };
    let stat = match fs.kind(copy) {
        Ok(stat) => stat,
        // Not there: nothing to remove, so neither folder above it is touched either, whether or
        // not the step runs ([`tidy_copy_folders`] follows only a removal).
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return (PathOutcome::Absent, None);
        }
        Err(e) => {
            let reason = kept_because.map_or_else(
                || format!("{name} couldn't be checked ({e})"),
                str::to_string,
            );
            return (PathOutcome::Kept, Some(reason));
        }
    };
    if let Some(reason) = kept_because {
        return (PathOutcome::Kept, Some(reason.to_string()));
    }
    let checked = owned_folder(fs, folder, uid, home)
        .and_then(|()| owned_folder(fs, bin, uid, home))
        .and_then(|()| match stat.kind {
            LstatKind::File | LstatKind::Symlink => owned_by(&stat, uid, &name),
            LstatKind::Dir => Err(format!("{name} is a folder, not the engine's file")),
            LstatKind::Other => Err(format!("{name} is not a regular file or a link")),
        });
    if let Err(reason) = checked {
        return (PathOutcome::Kept, Some(reason));
    }
    // `remove_file` is an unlink: a symlinked copy loses the link, never what it points at.
    match fs.remove_file(copy) {
        Ok(()) => {
            tidy_copy_folders(fs, folder, bin, home, uid);
            (PathOutcome::Removed, None)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tidy_copy_folders(fs, folder, bin, home, uid);
            (PathOutcome::Absent, None)
        }
        Err(e) => (PathOutcome::Failed, Some(e.to_string())),
    }
}

/// Spec 3.5.2: the Linux engine copies ([`managed_engine_copies`]), each LOOKED AT (`lstat`) and
/// reported, the path shown with `~` for `home`.
///
///   * `kept_because` is `Some(reason)` when the engine-data step does not run — not asked
///     ([`COPY_NOT_ASKED`]), refused (the refusal's own text: a kept scheduler may still run that
///     binary, its unit's `ExecStart`), or the state folder unknown (the engine's error). A copy
///     that is there is then `kept`, untouched, with that reason; one that is not is `absent`.
///   * `None` when the step runs (consented, not refused, the folder known). A copy is removed ONLY
///     when `daily-briefing/` and `bin/` above it are real directories, not symlinks, the copy is
///     a file or a symlink, and all three are owned by `uid` — unlink permission comes from the
///     folder, so another user's copy in a shared, writable folder would otherwise go. Otherwise
///     it is `kept`, and the reason says why. Then, once the copy is removed, `bin/` and
///     `daily-briefing/` go only if empty ([`tidy_copy_folders`]); a copy that is not there tidies
///     no folder.
///
/// `uid` is this process's ([`current_uid`]); `None` keeps every copy that is there. Nothing but
/// each copy and, when empty, its two folders is ever removed; the path is never read from a
/// record.
pub fn engine_copy_leg(
    fs: &dyn UninstallFs,
    copies: &[PathBuf],
    home: &Path,
    uid: Option<u32>,
    kept_because: Option<&str>,
) -> Vec<PathReport> {
    copies
        .iter()
        .map(|copy| {
            let (outcome, reason) = copy_outcome(fs, copy, home, uid, kept_because);
            PathReport {
                path: shown(copy, home),
                outcome,
                reason,
            }
        })
        .collect()
}

/* ── the settings leg (Batch 2, spec 3.5.3) ─────────────────────────────────────────────────── */

/// The engine's config, in the settings folder (`src/config.ts`, `configPath`).
pub const SETTINGS_CONFIG: &str = "config.json";

/// The app's backup of the previous settings (`config_save`'s replace keeps them under this name),
/// which can hold a deleted inline key — so the leg removes it too (decision A).
pub const SETTINGS_BACKUP: &str = "config.json.bak";

/// Spec 3.5.3's other-link note: a removed file another link still holds (and so may still hold an
/// API key). A key file's line carries it as its reason; a config's removal as
/// [`config_other_link_note`].
pub const OTHER_LINK_NOTE: &str = "another link to the same file still exists";

/// Spec 3.5.3's description of `.config.json.save-*` leftovers — a killed save's staged copies,
/// which are named, not removed (decision A).
pub const STAGED_COPIES_NOTE: &str = "staged copies of earlier settings, which may hold a key";

/// A key path's reason when it IS `config` by identity (spec 3.5.3 step 2): left to steps 3-4.
pub fn handled_with(config: &str) -> String {
    format!("handled with {config} below")
}

/// A relative key path's reason, verbatim from spec 3.5.3: the engine resolves it against its own
/// working folder, not the settings folder, so it is never removed (§2 point 12).
pub fn relative_key_reason(path: &str) -> String {
    format!(
        "your settings name it by a relative path ({path}); if it is in this folder it is listed \
         below"
    )
}

/// Spec 3.5.3 step 1: a config that was a link — the link removed (or, since the M9 LOW pass, L7,
/// kept by a leg that stopped or could not unlink it), `target` kept.
pub fn config_link_note(name: &str, target: &Path) -> String {
    format!(
        "{name} was a link to {}; that file was kept and may hold your API key.",
        target.display()
    )
}

/// A linked config's note — a removed one's, and since the M9 LOW pass (L7) a kept or failed one's
/// too — from what its target is AFTER the leg (checkpoint M5b F3) — so
/// it never says a file "was kept" that this leg removed. `target` is the link's text; an `lstat`
/// of it (joined onto `folder` when relative, as the link itself resolves) once steps 2-4 are done:
///   * still there, or it cannot be told: spec 3.5.3's own words, [`config_link_note`];
///   * not there, and it is a key file step 2 removed (`removed_keys`, the same path): "… which was
///     removed as your API key file.";
///   * not there otherwise (a dangling link, or the other config, which steps 3-4 removed): "…
///     which isn't there."
fn linked_config_note(
    fs: &dyn UninstallFs,
    folder: &Path,
    name: &str,
    target: &Path,
    removed_keys: &[PathBuf],
) -> String {
    let resolved = folder.join(target);
    match fs.kind(&resolved) {
        Err(e) if not_there(&e) => {
            let what = if removed_keys.iter().any(|key| *key == resolved) {
                "was removed as your API key file"
            } else {
                "isn't there"
            };
            format!("{name} was a link to {}, which {what}.", target.display())
        }
        _ => config_link_note(name, target),
    }
}

/// Spec 3.5.3 steps 3-4: a config removed while another link still holds the same file.
pub fn config_other_link_note(name: &str) -> String {
    format!("{name} removed; {OTHER_LINK_NOTE}")
}

/// Spec 3.5.3: the staged copies still in the folder, named, by [`STAGED_COPIES_NOTE`].
pub fn staged_copies_note(names: &[String]) -> String {
    format!("{}: {STAGED_COPIES_NOTE}", names.join(", "))
}

/// Spec 3.5.3: a settings folder that is a link is not entered.
pub fn settings_folder_link(target: &Path) -> String {
    format!(
        "The settings folder is a link to {}; nothing inside it was removed.",
        target.display()
    )
}

/// A key file left alone because the leg had already stopped at one that would not unlink.
const KEY_NOT_ATTEMPTED: &str =
    "not removed: the settings removal stopped at an API key file that couldn't be removed";

/// `NotFound`, or `NotADirectory` (a path component is a file): nothing is there.
fn not_there(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

/// `src/config.ts`'s `expandTilde`: a leading `~` — alone, `~/` or `~\` — against `home`; any other
/// path untouched (so `~user/…` stays relative, as the engine leaves it).
fn expand_tilde(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    match path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

/// What one config says of its key file (spec 3.5.3 step 1).
enum KeyRef {
    /// Not there, or names none.
    None,
    /// `provider.api.apiKeyFile`, as written.
    Named(String),
    /// It could not be read or parsed: `keyRefsUnknown`.
    Unknown,
}

/// `provider.api.apiKeyFile` in a config's text — the one key reference spec 3.5.3 step 2 acts on.
/// Text that is not a JSON object, or a reference that is not a string, is [`KeyRef::Unknown`].
fn key_ref_in(text: &str) -> KeyRef {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) if value.is_object() => match value.pointer("/provider/api/apiKeyFile") {
            None => KeyRef::None,
            Some(serde_json::Value::String(path)) => KeyRef::Named(path.clone()),
            Some(_) => KeyRef::Unknown,
        },
        _ => KeyRef::Unknown,
    }
}

/// One config file as step 1 saw it (`lstat`).
struct ConfigSeen {
    name: &'static str,
    path: PathBuf,
    /// `Ok(None)`: not there. `Err`: `lstat` could not answer.
    stat: Result<Option<Lstat>, String>,
}

impl ConfigSeen {
    fn look(fs: &dyn UninstallFs, folder: &Path, name: &'static str) -> Self {
        let path = folder.join(name);
        let stat = match fs.kind(&path) {
            Ok(stat) => Ok(Some(stat)),
            Err(e) if not_there(&e) => Ok(None),
            Err(e) => Err(e.to_string()),
        };
        Self { name, path, stat }
    }

    fn lstat(&self) -> Option<&Lstat> {
        self.stat.as_ref().ok().and_then(Option::as_ref)
    }

    /// Its identity, `(device, inode)` of the entry itself.
    fn id(&self) -> Option<(u64, u64)> {
        self.lstat().and_then(|stat| stat.id)
    }

    /// Spec 3.5.3 step 1's read, for its key reference only. A regular file is read with the sink's
    /// no-follow, non-blocking read; a LINK is read through, by
    /// `notifications::read_engine_config_text` — the engine's own follow-the-link reading, which
    /// opens non-blocking, needs a regular target and stops at [`config_save::MAX_CONFIG_BYTES`] —
    /// and never by a no-follow read, which would call every linked config unreadable. Both at most
    /// 1 MiB. Anything else, or any refusal, is [`KeyRef::Unknown`].
    fn key_ref(&self, fs: &dyn UninstallFs) -> KeyRef {
        let stat = match &self.stat {
            Ok(None) => return KeyRef::None,
            Ok(Some(stat)) => stat,
            Err(_) => return KeyRef::Unknown,
        };
        let text = match stat.kind {
            LstatKind::File => fs
                .read_small(&self.path, config_save::MAX_CONFIG_BYTES)
                .ok(),
            LstatKind::Symlink => notifications::read_engine_config_text(&self.path).ok(),
            LstatKind::Dir | LstatKind::Other => None,
        };
        text.as_deref().map_or(KeyRef::Unknown, key_ref_in)
    }
}

/// What step 2 makes of one key path.
enum KeyVerdict {
    /// Not removed; why.
    Kept(String),
    /// Nothing there.
    Absent,
    /// The same file as `configs[i]`, by identity: left to steps 3-4.
    HandledWith(usize),
    /// Removable: a regular file whose folder IS the settings folder. Its link count, for the
    /// other-link note.
    Eligible(Option<u64>),
}

/// Spec 3.5.3 step 2's conditions on one key path, `path` already `~`-expanded (`raw` as the
/// settings name it). Removed only if ALL hold: absolute; its parent is the settings folder by
/// identity (`(device, inode)` after `canonicalize` — `folder_id` — so a case-insensitive volume or
/// a sibling folder whose NAME starts the same cannot fool a string comparison); not the same file
/// as a config, by identity, whatever its name or link count; and an `lstat` shows a regular file.
/// An identity that cannot be read (off unix) fails toward keeping.
fn key_verdict(
    fs: &dyn UninstallFs,
    raw: &str,
    path: &Path,
    folder_id: Option<(u64, u64)>,
    configs: &[ConfigSeen],
) -> KeyVerdict {
    if !path.is_absolute() {
        return KeyVerdict::Kept(relative_key_reason(raw));
    }
    let stat = match fs.kind(path) {
        Ok(stat) => stat,
        Err(e) if not_there(&e) => return KeyVerdict::Absent,
        Err(e) => return KeyVerdict::Kept(format!("it couldn't be checked ({e})")),
    };
    let parent_id = path
        .parent()
        .and_then(|parent| fs.canonicalize(parent).ok())
        .and_then(|parent| fs.kind(&parent).ok())
        .and_then(|parent| parent.id);
    match (parent_id, folder_id) {
        (Some(parent), Some(folder)) if parent == folder => {}
        (Some(_), Some(_)) => return KeyVerdict::Kept("it isn't in the settings folder".into()),
        _ => {
            return KeyVerdict::Kept(
                "its folder couldn't be compared with the settings folder".into(),
            )
        }
    }
    if let Some(i) = stat
        .id
        .and_then(|id| configs.iter().position(|config| config.id() == Some(id)))
    {
        return KeyVerdict::HandledWith(i);
    }
    match stat.kind {
        LstatKind::File => KeyVerdict::Eligible(stat.links),
        LstatKind::Symlink => KeyVerdict::Kept("it is a link, not the key file itself".into()),
        LstatKind::Dir => KeyVerdict::Kept("it is a folder, not a file".into()),
        LstatKind::Other => KeyVerdict::Kept("it isn't a regular file".into()),
    }
}

/// THE SETTINGS LEG (Batch 2, spec 3.5.3), on the folder holding `config_path` — the ENGINE's
/// `configPath`, absolute, never a path computed here. Runs only when consented and not refused
/// (`uninstall_execute`, under the save lock); `home` is what a `~` in a key path expands to.
/// Returns the report and whether step 3 COMPLETED — `config.json` removed or found absent — which
/// is when the caller sets the "settings removed" latch (step 6).
///
///   * **A folder that is a link is not entered** (nothing inside it is removed:
///     [`settings_folder_link`]); one that is not a folder is not entered either.
///   * **1.** `lstat` `config.json` and `config.json.bak`, and read each that is a regular file of at
///     most 1 MiB, or a link (read through, [`ConfigSeen::key_ref`]), for `provider.api.apiKeyFile`.
///     One that cannot be read or parsed sets `keyRefsUnknown`, and is still removed.
///   * **2. Key files FIRST**, so a crash between steps cannot leave a key file no config names:
///     each distinct reference, `~`-expanded, is removed only on [`key_verdict`]'s conditions.
///     One that will not unlink STOPS the leg here: both configs are kept so a retry can still
///     identify it, and no latch is due.
///   * **3.** `config.json`, **4.** `config.json.bak` — unlinked: a link loses the link, never its
///     target, and its note, written once both steps are done, says what became of that target
///     ([`linked_config_note`]) — for a linked config the leg kept or failed to unlink too (M9 LOW
///     pass, L7); another link still holding a removed file — one this leg did not remove itself (L6)
///     — gets [`config_other_link_note`].
///   * **5.** The folder, with the NON-recursive [`UninstallFs::remove_empty_dir`], only if it is
///     now empty — so `.config.json.save-*` staged copies, which are named, not removed
///     ([`staged_copies_note`]), keep it.
///
/// ⚠ ITS WHOLE REACH: a key file only when its parent IS the folder by identity, the two config
/// names in the folder, and the folder itself when empty — all through `fs`. Nothing is removed
/// recursively, and nothing outside the folder.
pub fn settings_leg(
    fs: &dyn UninstallFs,
    config_path: &Path,
    home: &Path,
) -> (SettingsReport, bool) {
    let mut report = SettingsReport {
        asked: true,
        ..SettingsReport::default()
    };
    let Some(folder) = config_path.parent() else {
        report.error = Some(format!(
            "the engine's settings file ({}) has no folder",
            config_path.display()
        ));
        return (report, false);
    };
    report.folder = Some(folder.display().to_string());
    let folder_is_there = match fs.kind(folder) {
        Ok(stat) => match stat.kind {
            LstatKind::Dir => true,
            LstatKind::Symlink => {
                let target = stat.link_target.unwrap_or_default();
                report.refused = Some(settings_folder_link(&target));
                return (report, false);
            }
            LstatKind::File | LstatKind::Other => {
                report.error = Some(format!(
                    "{} is not a folder, so nothing in it was removed",
                    folder.display()
                ));
                return (report, false);
            }
        },
        // Nothing there: every step below finds its file absent.
        Err(e) if not_there(&e) => false,
        Err(e) => {
            report.error = Some(format!(
                "the settings folder couldn't be checked ({e}), so nothing in it was removed"
            ));
            return (report, false);
        }
    };

    // ── 1. The two configs, and the key files they name.
    let configs = [
        ConfigSeen::look(fs, folder, SETTINGS_CONFIG),
        ConfigSeen::look(fs, folder, SETTINGS_BACKUP),
    ];
    let mut named: Vec<(String, PathBuf)> = Vec::new();
    for config in &configs {
        match config.key_ref(fs) {
            KeyRef::None => {}
            KeyRef::Unknown => report.key_refs_unknown = true,
            KeyRef::Named(raw) => {
                let path = expand_tilde(&raw, home);
                if !named.iter().any(|(_, seen)| *seen == path) {
                    named.push((raw, path));
                }
            }
        }
    }

    // ── 2. Key files first.
    let folder_id = fs
        .canonicalize(folder)
        .ok()
        .and_then(|folder| fs.kind(&folder).ok())
        .and_then(|folder| folder.id);
    let mut handled: Vec<(usize, usize)> = Vec::new();
    let mut stopped: Option<String> = None;
    // The key files this step unlinked, for a linked config's note ([`linked_config_note`]).
    let mut removed_keys: Vec<PathBuf> = Vec::new();
    for (raw, path) in &named {
        let shown = path.display().to_string();
        let (outcome, reason) = match key_verdict(fs, raw, path, folder_id, &configs) {
            KeyVerdict::Kept(reason) => (PathOutcome::Kept, Some(reason)),
            KeyVerdict::Absent => (PathOutcome::Absent, None),
            KeyVerdict::HandledWith(config) => {
                handled.push((report.key_files.len(), config));
                // Its outcome is that config's, filled in after steps 3-4.
                (PathOutcome::Kept, Some(handled_with(configs[config].name)))
            }
            KeyVerdict::Eligible(_) if stopped.is_some() => {
                (PathOutcome::Kept, Some(KEY_NOT_ATTEMPTED.to_string()))
            }
            KeyVerdict::Eligible(links) => match fs.remove_file(path) {
                Ok(()) => {
                    removed_keys.push(path.clone());
                    (
                        PathOutcome::Removed,
                        links
                            .is_some_and(|links| links > 1)
                            .then(|| OTHER_LINK_NOTE.to_string()),
                    )
                }
                Err(e) if not_there(&e) => (PathOutcome::Absent, None),
                Err(e) => {
                    stopped = Some(shown.clone());
                    (PathOutcome::Failed, Some(e.to_string()))
                }
            },
        };
        report.key_files.push(PathReport {
            path: shown,
            outcome,
            reason,
        });
    }

    // ── 3-4. The configs — unless the leg stopped at a key file, when both are KEPT.
    let mut errors: Vec<String> = Vec::new();
    let mut outcomes = [PathOutcome::Kept; 2];
    if let Some(key) = &stopped {
        errors.push(format!(
            "the API key file {key} couldn't be removed, so {SETTINGS_CONFIG} and \
             {SETTINGS_BACKUP} were kept: they name it, so another Uninstall can still find it"
        ));
    } else {
        for (config, outcome) in configs.iter().zip(outcomes.iter_mut()) {
            *outcome = match fs.remove_file(&config.path) {
                Ok(()) => {
                    report.removed.push(config.name.to_string());
                    PathOutcome::Removed
                }
                Err(e) if not_there(&e) => PathOutcome::Absent,
                Err(e) => {
                    errors.push(format!("{} couldn't be removed ({e})", config.name));
                    PathOutcome::Failed
                }
            };
        }
    }
    // Their notes, in order, once BOTH steps are done — a link's target may be the key file step 2
    // removed, or the other config, which step 3 or 4 removed only just now (F3) — or once the leg
    // stopped before them. A config that was a link gets its note whether it was removed, KEPT (the
    // stop) or not removed (a failed unlink): its target was kept and may hold the key either way (M9
    // LOW pass, L7). One found absent has none. The other-link note is a REMOVED config's, and only
    // while a link survives the leg: the links this leg removed — configs of the same identity, this
    // one included — are counted out first, so two configs that were the only two links to one file,
    // both removed, say nothing of the kind (L6). An identity that cannot be read counts this one only.
    let removed_links = |config: &ConfigSeen| -> u64 {
        let same = configs.iter().zip(outcomes).filter(|(other, outcome)| {
            *outcome == PathOutcome::Removed && other.id().is_some() && other.id() == config.id()
        });
        (same.count() as u64).max(1)
    };
    for (config, outcome) in configs.iter().zip(outcomes) {
        if outcome == PathOutcome::Absent {
            continue;
        }
        match config.lstat() {
            Some(stat) if stat.kind == LstatKind::Symlink => {
                report.notes.push(linked_config_note(
                    fs,
                    folder,
                    config.name,
                    stat.link_target.as_deref().unwrap_or(Path::new("")),
                    &removed_keys,
                ));
            }
            Some(stat)
                if outcome == PathOutcome::Removed
                    && stat.links.is_some_and(|links| links > removed_links(config)) =>
            {
                report.notes.push(config_other_link_note(config.name));
            }
            _ => {}
        }
    }
    for (line, config) in handled {
        report.key_files[line].outcome = outcomes[config];
    }
    // Step 3 completed — `config.json` removed, or found absent — and only then (spec 3.5.3 step 6).
    let latch = stopped.is_none()
        && matches!(outcomes[0], PathOutcome::Removed | PathOutcome::Absent);

    // ── 5. The folder, only if it is now empty: never a recursion.
    if stopped.is_none() && folder_is_there {
        let _ = fs.remove_empty_dir(folder);
    }

    // What is still there.
    match fs.list_dir(folder) {
        Ok(mut names) => {
            names.sort();
            report.remaining = names;
        }
        Err(e) if not_there(&e) => {}
        Err(e) => errors.push(format!("the settings folder couldn't be listed ({e})")),
    }
    let staged_prefix = config_save::staged_prefix(SETTINGS_CONFIG);
    let staged: Vec<String> = report
        .remaining
        .iter()
        .filter(|name| name.starts_with(&staged_prefix))
        .cloned()
        .collect();
    if !staged.is_empty() {
        report.notes.push(staged_copies_note(&staged));
    }
    if !errors.is_empty() {
        report.error = Some(errors.join("; "));
    }
    (report, latch)
}

/// For [`EntryKind::Glob`] entries the `PathBuf` is the DIRECTORY the token matches inside; for
/// the other kinds it is the entry itself.
fn preview_entries(
    fs: &dyn UninstallFs,
    entries: impl IntoIterator<Item = (String, EntryKind, PathBuf)>,
) -> Vec<PreviewEntry> {
    entries
        .into_iter()
        .map(|(name, kind, path)| {
            let present = match kind {
                EntryKind::Glob => fs
                    .list_dir(&path)
                    .map(|names| names.iter().any(|n| glob_matches(&name, n)))
                    .unwrap_or(false),
                _ => fs.exists(&path),
            };
            PreviewEntry {
                name,
                kind,
                present,
            }
        })
        .collect()
}

fn app_preview(fs: &dyn UninstallFs, data_dir: &Path, config_dir: &Path) -> Vec<PreviewEntry> {
    let mut entries: Vec<(String, EntryKind, PathBuf)> = Vec::new();
    for name in APP_DATA_FILES {
        entries.push(((*name).into(), EntryKind::File, data_dir.join(name)));
    }
    for name in APP_DATA_DIRS {
        entries.push(((*name).into(), EntryKind::Dir, data_dir.join(name)));
    }
    for name in APP_CONFIG_FILES {
        entries.push(((*name).into(), EntryKind::File, config_dir.join(name)));
    }
    preview_entries(fs, entries)
}

fn engine_preview(fs: &dyn UninstallFs, state_dir: &Path) -> Vec<PreviewEntry> {
    preview_entries(
        fs,
        ENGINE_STATE_REMOVALS.iter().map(|e| {
            let path = match e.kind {
                EntryKind::Glob => state_dir.to_path_buf(),
                _ => state_dir.join(e.token),
            };
            (e.token.to_string(), e.kind, path)
        }),
    )
}

/* ── the engine read ──────────────────────────────────────────────────────────────────────────── */

// Both commands read `status --json` through `engine_paths` and absolutise what they use from it
// with `absolute` (`cli_shim::engine_targets`' rule: a relative dir would make a removal target
// depend on this app's working directory) — `paths.stateDir`, and `paths.configPath` for the
// settings folder.

fn client_of(engine: &Engine) -> Result<&EngineClient, String> {
    engine.client().map_err(|e| e.to_string())
}

/* ── the scheduler step (Batch 2, spec 3.3.3-3.3.4) ──────────────────────────────────────────── */

/// Spec 3.3.3: whether `seen` and the status read detect a scheduler — a record or a unit on disk,
/// the engine's `lstat` of the record (`recordFilePresent`, which covers a state dir Rust could not
/// name), or `registered: true`. `status` is `None` when the read was unreadable.
fn detects_scheduler(seen: &ScheduleSeen, status: Option<&ScheduleView>) -> bool {
    seen.record
        || seen.unit.is_some()
        || status.is_some_and(|view| view.record_file_present || view.registered == Some(true))
}

/// Spec 3.3.3: the owner is `app` ONLY when the status read succeeded with a READABLE record
/// (`recordPresent`) whose owner is `app` — never from Rust's own look, which reads no owner.
fn owned_by_app(view: &ScheduleView) -> bool {
    view.record_present && view.owner.as_deref() == Some("app")
}

/// `ScheduleForeign`'s message when Rust itself refuses (`removeOwn`, a detected scheduler that is
/// not this app's): what was found, in the engine's own refusal's words (`src/schedule/install.ts`,
/// `uninstallSchedule`), so the two sources of the same refusal read alike.
fn not_this_apps(seen: &ScheduleSeen, view: &ScheduleView) -> String {
    let record = seen.record || view.record_file_present;
    let owner = view
        .owner
        .as_deref()
        .filter(|_| view.record_present && record);
    let found = match (owner, &seen.unit) {
        (Some("cli"), _) => "a schedule record set up from the terminal".to_string(),
        (Some(other), _) => format!("a schedule record set up from \"{other}\""),
        (None, _) if record => "a schedule record whose owner can't be read".to_string(),
        (None, Some(unit)) => format!(
            "the unit file {}, with no schedule record",
            unit.display()
        ),
        (None, None) => "a registration with no files".to_string(),
    };
    format!(
        "This background scheduler wasn't set up by this app ({found}). Removing it needs your \
         go-ahead."
    )
}

/// The exit-1 rule's second half (spec 3.3.4.3): the step-1 read SUCCEEDED and the engine reported
/// nothing installed — no record file, no unit file, `registered` not `true`. `null` is allowed:
/// the engine's own check has just run again.
fn engine_saw_nothing(view: &ScheduleView) -> bool {
    !view.record_file_present && !view.unit_present && view.registered != Some(true)
}

/// A failed removal's message (spec 3.3.4.3): the engine's stderr, verbatim but for its trailing
/// newline — every screen shows it as it is, and a stable reason leads with the manual steps — or,
/// when it wrote none, Rust's own sentence.
fn removal_message(outcome: &EngineOutcome) -> String {
    let stderr = outcome.stderr.trim_end();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    match outcome.exit_code {
        Some(1) if !outcome.stdout.trim().is_empty() => {
            "The engine reported nothing to remove, but the scheduler's status read just before it \
             found something or could not be read, so that answer wasn't trusted."
                .to_string()
        }
        Some(code) => format!(
            "Removing the background scheduler failed (exit status {code}), and the engine gave \
             no reason."
        ),
        None => "Removing the background scheduler was stopped by a signal before it finished."
            .to_string(),
    }
}

/// Step 3's engine call: `schedule uninstall --invoker app [--take-over]`, and its answer mapped
/// (spec 3.3.4.3). `status` is step 1's read (`None`: unreadable).
///
///   * exit 0 → [`SchedulerOutcome::Removed`];
///   * exit 1 → [`SchedulerOutcome::Absent`] ONLY when the engine printed its line on stdout (a
///     genuine exit 1 always does; a crash prints only to stderr) AND step 1's read succeeded and
///     saw nothing ([`engine_saw_nothing`]); otherwise `ScheduleFailed`;
///   * exit 2 without take-over → `ScheduleForeign` (the engine's own refusal);
///   * busy (the in-flight guard) → `Busy`;
///   * anything else — exit 3, exit 2 with take-over, any other code, a signal death, a spawn
///     error, an unresolved sidecar — → `ScheduleFailed`, with the engine's stderr or the error's
///     text.
///
/// ⚠ NO RUST READ TIMEOUT (spec 3.1.4, "Rust timeout"), like every other mutating engine call: the
/// engine's own deadline (45 s from its entry) bounds it, and a timeout here could not stop the
/// engine's effects — only report a removal as failed while it went on.
async fn remove_scheduler(
    engine: &Engine,
    take_over: bool,
    status: Option<&ScheduleView>,
) -> Result<SchedulerOutcome, UninstallError> {
    let failed = |message: String| UninstallError::ScheduleFailed { message };
    let client = engine.client().map_err(|e| failed(e.to_string()))?;
    let op = Operation::ScheduleUninstall {
        invoker: Invoker::App,
        take_over,
    };
    let outcome = client.invoke(op, &NoProgress).await.map_err(|e| match e {
        EngineError::Busy { .. } => UninstallError::Busy {
            message: e.to_string(),
        },
        other => failed(other.to_string()),
    })?;
    match outcome.exit_code {
        Some(0) => Ok(SchedulerOutcome::Removed),
        Some(1)
            if !outcome.stdout.trim().is_empty() && status.is_some_and(engine_saw_nothing) =>
        {
            Ok(SchedulerOutcome::Absent)
        }
        Some(2) if !take_over => Err(UninstallError::ScheduleForeign {
            message: removal_message(&outcome),
        }),
        _ => Err(failed(removal_message(&outcome))),
    }
}

/* ── the commands ─────────────────────────────────────────────────────────────────────────────── */

/// What an uninstall would remove, resolved and inspected. Read-only: two engine spawns
/// (`status --json`, then `schedule status --json`), one `is_enabled()` read, and `lstat`s.
#[tauri::command]
pub async fn uninstall_preview<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    state: State<'_, UninstallState>,
) -> Result<UninstallPreview, UninstallError> {
    let data_dir = state.data_dir(&app)?;
    let config_dir = state.config_dir(&app)?;
    let app_entries = app_preview(state.fs.as_ref(), &data_dir, &config_dir);
    let client = client_of(&engine);
    // The first read, `status --json`: the state dir, absolutised, and — since Batch 2 — the
    // settings folder from the same envelope (spec 3.3.1).
    let paths = match &client {
        Ok(client) => engine_paths(client).await,
        Err(detail) => Err(detail.clone()),
    };
    let (engine_state_dir_path, engine_error) = match paths
        .as_ref()
        .map_err(String::clone)
        .and_then(|p| absolute("status --json", "paths.stateDir", p.state_dir.as_ref()))
    {
        Ok(dir) => (Some(dir), None),
        Err(detail) => (None, Some(detail)),
    };
    // `configPath`'s parent, or unknown: a missing or relative `configPath` is never resolved
    // against this app's working directory (`absolute`'s rule, the state dir's too).
    let settings_folder = paths
        .as_ref()
        .ok()
        .and_then(|p| absolute("status --json", "paths.configPath", p.config_path.as_ref()).ok())
        .and_then(|config| config.parent().map(|dir| dir.display().to_string()));
    // The second read, `schedule status --json` (spec 3.3.1). A failed one is "status unreadable",
    // with every schedule fact unknown — which is NOT the all-default view a read that answered
    // and reported nothing gives, so the two stay apart here.
    let schedule = match &client {
        Ok(client) => engine_schedule_view(client).await.ok(),
        Err(_) => None,
    };
    let schedule_status_unreadable = schedule.is_none();
    let schedule = schedule.unwrap_or_default();
    let engine_entries = engine_state_dir_path
        .as_deref()
        .map(|dir| engine_preview(state.fs.as_ref(), dir))
        .unwrap_or_default();
    let schedule_record_present = engine_state_dir_path
        .as_deref()
        .is_some_and(|dir| state.fs.exists(&dir.join(SCHEDULE_RECORD)));
    let schedule_unit_file =
        present_unit(state.fs.as_ref(), &state.unit_files()).map(|unit| unit.display().to_string());
    let (autostart_enabled, autostart_error) = match autostart::enabled_now(&app) {
        Ok(enabled) => (Some(enabled), None),
        Err(detail) => (None, Some(detail)),
    };
    Ok(UninstallPreview {
        app_data_dir: data_dir.display().to_string(),
        app_config_dir: config_dir.display().to_string(),
        app_entries,
        engine_state_dir: engine_state_dir_path.map(|d| d.display().to_string()),
        engine_error,
        engine_entries,
        autostart_enabled,
        autostart_error,
        schedule_record_present,
        schedule_unit_file,
        schedule_owner: schedule.owner,
        schedule_registered: schedule.registered,
        schedule_registered_reason: schedule.registered_reason,
        schedule_remove_steps: schedule.remove_steps,
        schedule_status_unreadable,
        schedule_record_file_present: schedule.record_file_present,
        settings_folder,
        os: std::env::consts::OS.to_string(),
    })
}

/// Perform the uninstall, in spec 3.3.4's order (module header): the engine reads and a first look,
/// the settings lock, the SCHEDULER step, the login item, the gate look, then the legs.
///
///   * `remove_engine_state` is the EXPLICIT consent flag for the engine-data leg.
///   * `remove_settings` (Batch 2; missing = false) is the settings leg's consent: when true the save
///     lock is taken (step 2) and held to the end, and the leg ([`settings_leg`]) runs at step 7
///     unless refused (spec 3.3.5) — then, once its `config.json` step has completed, the
///     [`ConfigSaver`]'s "settings removed" latch is set before that lock is let go.
///   * `schedule` (Batch 2; missing = [`SchedulerChoice::RemoveOwn`]) is what the scheduler step
///     does.
///
/// It always READS: two engine spawns (`status --json`, then `schedule status --json`) and
/// `lstat`s, and — unless `schedule` is `keep` — it asks the engine to remove the scheduler (a
/// third, MUTATING spawn, under the in-flight guard). On every `Err` from the scheduler step nothing
/// has been removed and no later step has run. Per-entry failures are reported, not thrown; the
/// report says exactly what happened to each enumerated name.
#[tauri::command]
pub async fn uninstall_execute<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    state: State<'_, UninstallState>,
    saver: State<'_, ConfigSaver>,
    remove_engine_state: bool,
    remove_settings: Option<bool>,
    schedule: Option<SchedulerChoice>,
) -> Result<UninstallReport, UninstallError> {
    let data_dir = state.data_dir(&app)?;
    let config_dir = state.config_dir(&app)?;
    let choice = schedule.unwrap_or(SchedulerChoice::RemoveOwn);
    let fs = state.fs.as_ref();
    let unit_files = state.unit_files();
    // One look: the record (only where the state dir is known — `None` in the report: unknown) and
    // the unit files there, which are under the home and so always looked for.
    let look = |dir: &Result<PathBuf, String>| match dir {
        Ok(dir) => ScheduleSeen::look(fs, dir, &unit_files),
        Err(_) => ScheduleSeen::with_record(false, fs, &unit_files),
    };

    // ── 1. The engine reads and the first look (spec 3.3.4.1). The state dir is resolved through
    // the SAME `engine_paths` read `uninstall_preview` used — a `status --json` spawn, read-only,
    // never a webview-echoed path. A failed `schedule status --json` is "status unreadable"
    // (`None`), never the all-default view. The first look only feeds detection.
    let client = client_of(&engine);
    let paths = match &client {
        Ok(client) => engine_paths(client).await,
        Err(detail) => Err(detail.clone()),
    };
    // Both absolutised from the ONE `status --json` read (`absolute`'s rule: a relative path would
    // make a removal target depend on this app's working directory): the state dir, and — for the
    // settings leg, spec 3.5.3 — the engine's `configPath`, whose parent is the settings folder.
    let resolved = paths
        .as_ref()
        .map_err(String::clone)
        .and_then(|p| absolute("status --json", "paths.stateDir", p.state_dir.as_ref()));
    let config_path = paths
        .as_ref()
        .map_err(String::clone)
        .and_then(|p| absolute("status --json", "paths.configPath", p.config_path.as_ref()));
    let status = match &client {
        Ok(client) => engine_schedule_view(client).await.ok(),
        Err(_) => None,
    };
    let first = look(&resolved);
    let detected_first = detects_scheduler(&first, status.as_ref());

    // ── 2. The settings lock (spec 3.3.4.2): awaited HERE, when the settings will be removed, and
    // held to the end of this function — so a save cannot re-create a file behind that leg, and so
    // nothing is awaited between the gate look (5) and the legs.
    let _settings_lock = if remove_settings == Some(true) {
        Some(saver.lock.lock().await)
    } else {
        None
    };

    // ── 3. The scheduler (spec 3.3.4.3). Every `?` here returns before anything is removed.
    let removed = match choice {
        SchedulerChoice::Keep => None,
        SchedulerChoice::RemoveOwn => {
            let Some(view) = status.as_ref() else {
                return Err(UninstallError::ScheduleFailed {
                    message: SCHEDULE_STATUS_UNREADABLE.to_string(),
                });
            };
            if detected_first && !owned_by_app(view) {
                return Err(UninstallError::ScheduleForeign {
                    message: not_this_apps(&first, view),
                });
            }
            Some(remove_scheduler(&engine, false, status.as_ref()).await?)
        }
        SchedulerChoice::RemoveAny => Some(remove_scheduler(&engine, true, status.as_ref()).await?),
    };

    // ── 4. Leg 1 — the login item, through T19's own disable (reused, not forked). `is_enabled`
    // first: the plugin's `disable()` on an absent entry is not a removal to report as one. Read
    // and disable run under the login-item change lock, so a concurrent ON's branding cannot
    // re-create the plist between them (`autostart::lock_changes`). The guard is dropped at the end
    // of this block; nothing below awaits.
    let autostart_outcome = match autostart::lock_changes(&app) {
        Err(detail) => Outcome::Failed { detail },
        Ok(held) => match autostart::enabled_now(&app) {
            Ok(false) => Outcome::Absent,
            Ok(true) => match autostart::disable_now(&app, &held) {
                Ok(()) => Outcome::Removed,
                Err(detail) => Outcome::Failed { detail },
            },
            Err(detail) => Outcome::Failed { detail },
        },
    };

    // ── 5. ⚠ THE GATE LOOK (spec 3.3.4.5; round 4, G4-L1): the legs are refused on it and the
    // report states it — one observation, so the two cannot disagree. Nothing is awaited between
    // it and the legs below, so it is as fresh as a look can be.
    let gate = look(&resolved);
    let detected = detected_first || gate.record || gate.unit.is_some();
    let outcome = removed.unwrap_or(if detected {
        SchedulerOutcome::Kept
    } else if status.as_ref().is_none_or(|view| view.registered.is_none()) {
        SchedulerOutcome::NotChecked
    } else {
        SchedulerOutcome::Absent
    });
    // Spec 3.3.5.1: `keep` with a scheduler detected — by either look or the reads — refuses the
    // data legs first. With nothing detected nothing is refused, even when the check could not run.
    let kept_refusal = (choice == SchedulerChoice::Keep && detected)
        .then(|| REFUSED_FOR_KEPT_SCHEDULER.to_string());

    // ── 6. Engine data, consent-gated, at the directory resolved in step 1, echoed into the report
    // so the consented target is auditable after the fact (round-1 fix M3). Refused — nothing
    // removed, the directory still named, the refusal reported once — by a kept scheduler first,
    // then by what the gate look saw (module header), in spec 3.3.5's order: when the engine could
    // not name the directory, the gate's refusal still leads and the unknown folder is said after
    // it, as the settings leg does (M9 round 2; the gate then sees a unit only — no record without
    // a folder to look in).
    let (engine_report, engine_dir, engine_refused, engine_error) = if !remove_engine_state {
        (Vec::new(), None, None, None)
    } else if let Some(refused) = kept_refusal.clone() {
        // Refused before the folder matters; when the engine could not name it, that is said too.
        (
            Vec::new(),
            resolved.as_ref().ok().map(|dir| dir.display().to_string()),
            Some(refused),
            resolved.as_ref().err().cloned(),
        )
    } else {
        match &resolved {
            Ok(dir) => match remove_engine_state_as_seen(fs, dir, &gate) {
                Ok(report) => (report, Some(dir.display().to_string()), None, None),
                Err(refused) => (
                    Vec::new(),
                    Some(dir.display().to_string()),
                    Some(refused),
                    None,
                ),
            },
            Err(detail) => (Vec::new(), None, gate.refusal(), Some(detail.clone())),
        }
    };
    // The Linux engine copies (spec 3.5.2), part of the same step and so after the same gate look:
    // always LOOKED AT, removed only when the step above actually ran — consented, not refused, the
    // folder known — and otherwise each one there is kept, with why: not asked, the refusal, or the
    // engine's error. Nothing is awaited here either.
    let copies_kept_because = if remove_engine_state {
        engine_refused.clone().or_else(|| engine_error.clone())
    } else {
        Some(COPY_NOT_ASKED.to_string())
    };
    let (home, _) = state.unit_roots();
    let engine_copies = engine_copy_leg(
        fs,
        &state.engine_copies(),
        &home,
        current_uid(),
        copies_kept_because.as_deref(),
    );

    // ── 7. Settings (spec 3.5.3), consent-gated, at the folder of the ENGINE's `configPath` from
    // step 1 — never a path computed here — under the save lock step 2 took and still holds
    // (`_settings_lock` lives to the end of this function). Refused, in spec 3.3.5's order and
    // removing nothing: by a kept scheduler, then by what the gate look saw (the engine leg's own
    // texts), then — this step only — with an error when the `configPath` is unknown. Nothing is
    // awaited here either.
    let settings_folder = config_path
        .as_ref()
        .ok()
        .and_then(|path| path.parent())
        .map(|folder| folder.display().to_string());
    let settings = if remove_settings != Some(true) {
        // Not asked: the report only names the folder that stays.
        SettingsReport {
            folder: settings_folder,
            ..SettingsReport::default()
        }
    } else if let Some(refused) = kept_refusal.or_else(|| gate.refusal()) {
        SettingsReport {
            asked: true,
            folder: settings_folder,
            refused: Some(refused),
            error: config_path.as_ref().err().cloned(),
            ..SettingsReport::default()
        }
    } else {
        match &config_path {
            Err(detail) => SettingsReport {
                asked: true,
                error: Some(detail.clone()),
                ..SettingsReport::default()
            },
            Ok(config_path) => {
                let (report, config_step_completed) = settings_leg(fs, config_path, &home);
                // Spec 3.5.3 step 6: the latch, set BEFORE the lock is released — `_settings_lock`
                // is still held here — so every save queued behind this leg, or later in this app
                // session, refuses. Not set by a refused leg, nor one that stopped at a key file.
                if config_step_completed {
                    saver.mark_settings_removed();
                }
                report
            }
        }
    };

    // ── 8. Leg 2 — the app's own files.
    let app_report = remove_app_files(fs, &data_dir, &config_dir);

    // The report's scheduler facts: the gate look's, and the ways out of what it still saw.
    let mut leftover = Vec::new();
    if let (Ok(dir), true) = (&resolved, gate.record) {
        leftover.push(dir.join(SCHEDULE_RECORD).display().to_string());
    }
    // Every unit file the gate look saw, in the platform's order (M9 LOW pass, L8), not the first
    // alone.
    leftover.extend(gate.units.iter().map(|unit| unit.display().to_string()));
    let schedule = SchedulerReport {
        outcome,
        leftover,
        leftover_commands: leftover_commands(gate.unit.as_deref(), &state.engine_unit_files()),
        remove_steps: status.and_then(|view| view.remove_steps),
    };

    Ok(UninstallReport {
        autostart: autostart_outcome,
        app: app_report,
        // Derived from what HAPPENED, not from what was asked (round-1 fix F4).
        engine_state_removed: engine_report
            .iter()
            .any(|r| matches!(r.outcome, Outcome::Removed)),
        engine: engine_report,
        engine_state_dir: engine_dir,
        engine_refused,
        engine_error,
        schedule_record_present: resolved.is_ok().then_some(gate.record),
        schedule_unit_file: gate.unit.map(|unit| unit.display().to_string()),
        schedule,
        engine_copies,
        settings,
        os: std::env::consts::OS.to_string(),
    })
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &["uninstall_preview", "uninstall_execute"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_glob_token_matches_the_scripts_shape() {
        assert!(glob_matches("audit-*.md", "audit-2026-09-17.md"));
        assert!(glob_matches("audit-*.md", "audit-.md"));
        assert!(!glob_matches("audit-*.md", "audit-2026-09-17.txt"));
        assert!(!glob_matches("audit-*.md", "briefing.log"));
        // The overlap trap: prefix and suffix must not share characters of a too-short name.
        assert!(!glob_matches("audit-*.md", "audit-"));
        assert!(!glob_matches("no-star", "no-star"));
    }
}
