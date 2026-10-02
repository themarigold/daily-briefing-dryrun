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
    access, autostart, briefing_files, cli_shim, config_save, engine, notifications, shell,
    uninstall,
};

/// Every `#[tauri::command]` this app exposes, in the order [`crate::handler`] registers them.
///
/// ⚠ THE APP-LEVEL LIST IS A CONCATENATION, NOT A SPELLING OF ITS OWN. Nine module lists as of
/// Phase E M5b: `engine::COMMANDS` (the engine seam's), `shell::COMMANDS` (T11), B5's
/// `briefing_files::COMMANDS` (T12/T13's two reads) and `config_save::COMMANDS` (T15's read,
/// save and the Quit offer — grown by B8's `config_create`), B6's `access::COMMANDS` (T17's
/// folder-access flow), B7's `notifications::COMMANDS` (T18's two), B8's
/// `cli_shim::COMMANDS` (dev 63's three), B25's `uninstall::COMMANDS` (T25's preview +
/// consent-gated execute), and M5b's `autostart::COMMANDS` (T19's ON/OFF and the wizard's
/// default, replacing the plugin's own enable/disable grants); each module owns the names it
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
        .copied()
        .collect()
}
