//! The app-level command list.
//!
//! ⚠ ITS OWN MODULE FOR A MEASURED REASON, not for tidiness. This function was written in
//! `lib.rs`, next to [`crate::run`], and `tests/capability.rs` calls it — which made the linker
//! pull `lib.rs`'s codegen unit, and with it `run()`'s `tauri::generate_context!()` expansion,
//! into a test binary that has a `generate_context!` of its own. Both emit the macOS
//! `__EMBED_INFO_PLIST` static, so every `cargo test` printed
//! `warning: linker stderr: ld: duplicate symbol '__EMBED_INFO_PLIST'`. MEASURED both ways on a
//! disposable copy: absent at 4e8bd4fb0, present with the function in `lib.rs`, absent again with
//! it here. The warning was benign — `ld` deduplicates identical `__TEXT,__info_plist` data — but
//! a build that prints a duplicate-symbol warning every time is a build whose next, real
//! duplicate-symbol warning nobody reads.

use crate::{
    access, actions, app_prefs, autostart, briefing_files, calendar, calendar_details, cli_shim,
    config_save, editor, engine, notifications, pending_resets, repos, shell, summary, uninstall,
};

/// Every `#[tauri::command]` this app exposes, in the order [`crate::handler`] registers them.
///
/// ⚠ THE APP-LEVEL LIST IS A CONCATENATION, NOT A SPELLING OF ITS OWN. Seventeen module lists (ten
/// as of v0.3.0 M8, plus provider fallback PR 3's `pending_resets`, the briefing redesign's
/// `app_prefs`, its B1's `repos`, the live git check, its C's `calendar_details`, its B2's `actions` and `editor`, and its A2's `summary`): `engine::COMMANDS` (the engine seam's), `shell::COMMANDS` (T11), B5's
/// `briefing_files::COMMANDS` (T12/T13's two reads) and `config_save::COMMANDS` (T15's read,
/// save and the Quit offer — grown by B8's `config_create` and provider fallback PR 3's
/// `provider_candidate_check`), B6's `access::COMMANDS` (T17's
/// folder-access flow), B7's `notifications::COMMANDS` (T18's two), B8's
/// `cli_shim::COMMANDS` (dev 63's three), B25's `uninstall::COMMANDS` (T25's preview +
/// consent-gated execute), M5b's `autostart::COMMANDS` (T19's ON/OFF and the wizard's
/// default, replacing the plugin's own enable/disable grants), and v0.3.0 M8's
/// `calendar::COMMANDS` (the link-file write and removal and the `calendar` block save — the four
/// calendar ENGINE operations are in `engine::COMMANDS`) — and provider fallback PR 3's
/// `pending_resets::COMMANDS` (P3-M4-T3's three: the Replace flow's add, flush and drop) — and the
/// briefing redesign's `app_prefs::COMMANDS` (A-M1's get and set of the first name and the slides
/// switch) — and its B1's `repos::COMMANDS` (the live git check, `repos_status`) — and its C's
/// `calendar_details::COMMANDS` (wave 2's four live calendar-details commands) — and its B2's
/// `actions::COMMANDS` and `editor::COMMANDS` (GitHub links and the copied push command; Open in
/// editor) — and its A2's
/// `summary::COMMANDS` (the one summary read); each module owns
/// the names it
/// defines, and this is
/// the ORDER the four pinned spellings (the invoke handler, `build.rs`,
/// `capabilities/default.json`, and each module's `COMMANDS`) are compared as. B3 compared
/// `engine::COMMANDS` directly; adding a command outside `engine` is what made an app-level list
/// necessary, and `tests/capability.rs` compares against THIS function — so the pin was extended
/// rather than loosened to a prefix match.
pub fn all_commands() -> Vec<&'static str> {
    engine::COMMANDS
        .iter()
        .chain(shell::COMMANDS.iter())
        .chain(briefing_files::COMMANDS.iter())
        .chain(config_save::COMMANDS.iter())
        .chain(access::COMMANDS.iter())
        .chain(notifications::COMMANDS.iter())
        .chain(cli_shim::COMMANDS.iter())
        .chain(uninstall::COMMANDS.iter())
        .chain(autostart::COMMANDS.iter())
        .chain(calendar::COMMANDS.iter())
        .chain(pending_resets::COMMANDS.iter())
        .chain(app_prefs::COMMANDS.iter())
        .chain(repos::COMMANDS.iter())
        .chain(calendar_details::COMMANDS.iter())
        .chain(actions::COMMANDS.iter())
        .chain(editor::COMMANDS.iter())
        .chain(summary::COMMANDS.iter())
        .copied()
        .collect()
}
