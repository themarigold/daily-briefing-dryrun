//! The desktop shell for the daily-briefing engine.
//!
//! The shell deliberately owns almost nothing. `docs/gui-seam.md` §1 is the whole architecture:
//! 15 of 26 engine modules use `Bun.*` APIs, so there is no importable engine — the app's entire
//! API is argv plus stdout, and the engine is reached by spawning the bundled sidecar.
//!
//! **What changed in T8.** B1 shipped that seam as a `shell:allow-execute` capability: the webview
//! called `Command.sidecar(...)` and Tauri's shell scope decided which argv was allowed. That was
//! measured to have a first-match ceiling (exactly one argv reachable) and a second, wider gap —
//! the plugin forwarded frontend-supplied `cwd` and `env` past the scope untouched. Both are gone:
//!
//! > **The webview has no shell access at all.** `tauri-plugin-shell` is not a dependency of this
//! > crate, is not registered below, and the capability grants no `shell:*` permission. Every
//! > engine invocation is constructed Rust-side in [`engine`], from a typed operation enum, and
//! > exposed as one `#[tauri::command]` per operation so the capability can name them one at a
//! > time.
//!
//! The security posture in one sentence is therefore the opposite of B1's: **this crate adds the
//! only commands that can spawn anything, and they take no program, no argv, no environment and no
//! working directory.**
//!
//! `probe` is the one thing next to it, and it is deliberately *outside* that sentence rather than
//! an exception to it: it is a headless argv mode (`--tcc-probe <dir>`) that returns an exit code
//! from `main` **before** any Tauri builder, window, capability or sidecar exists, so it adds no
//! IPC command and widens nothing. **It is also not in a default build at all** — it is behind the
//! `tcc-probe` cargo feature, which is off unless a spike bundle asks for it, so the shipping
//! binary has no second argv surface to reason about. See `probe.rs` for both gates and for what
//! SPK-1(b) measures; `tests/probe_feature_gate.rs` is what keeps the compile-time one honest —
//! two `cfg`'d tests over the built binary for the gates themselves, plus one UNGATED test pinning
//! the manifest, because a `default = ["tcc-probe"]` line would otherwise turn the feature on and
//! compile the test that objects OUT of the build (MEASURED: 39 passed / 0 failed, flag present).

pub mod access;
pub mod autostart;
pub mod briefing_files;
pub mod cli_shim;
pub mod commands;
pub mod config_save;
pub mod engine;
pub mod notifications;
pub mod schedule_state;
pub mod shell;
pub mod uninstall;
pub mod watcher;

#[cfg(feature = "tcc-probe")]
pub mod probe;

use std::sync::Arc;

pub use commands::all_commands;

/// The invoke handler the app runs on.
///
/// Returned from a function rather than written inline in [`run`] so `tests/capability.rs` can
/// build a `MockRuntime` app around the SAME handler — the commands those tests drive through the
/// ACL are literally the ones that ship, not a copy of the list. The same reason [`run`] was split
/// out of `main` in B1, applied to the half that now matters.
pub fn handler<R: tauri::Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static
{
    tauri::generate_handler![
        engine::engine_status,
        engine::engine_doctor,
        engine::engine_run,
        engine::engine_run_to_file,
        engine::engine_config_validate,
        engine::engine_schedule_install,
        engine::engine_schedule_uninstall,
        engine::engine_schedule_status,
        engine::engine_schedule_verify,
        shell::state_snapshot,
        shell::open_today,
        shell::app_quit,
        briefing_files::read_latest_briefing,
        briefing_files::read_archived_briefing,
        config_save::config_read,
        config_save::config_save,
        config_save::config_offer_notify_auto,
        config_save::config_create,
        access::access_snapshot,
        access::access_probe,
        access::access_reveal_engine,
        access::access_open_settings,
        notifications::notify_status,
        notifications::notify_set_enabled,
        cli_shim::cli_shim_status,
        cli_shim::cli_shim_install,
        cli_shim::cli_shim_remove,
        uninstall::uninstall_preview,
        uninstall::uninstall_execute,
    ]
}

/// Build and run the app.
///
/// The engine client is resolved ONCE here and managed as state (`engine::Engine`), and the
/// `Result` is stored rather than unwrapped: an app whose sidecar is missing still opens its
/// window, and every engine command then returns `SidecarUnresolved` naming the path it looked at.
/// `expect`ing here would turn a diagnosable click into an app that never appears.
///
/// ⚠ `.build(…)` THEN `.run(shell::on_run_event)`, NOT `Builder::run`. The builder's own `run`
/// takes no run-loop callback, and the callback is where two things live: macOS `Reopen` (a Dock
/// click on an app whose window is hidden — without it, nothing appears) and the window's
/// close-to-tray decision (see `shell::on_run_event` for why it is not a per-window handler).
pub fn run() {
    let engine = engine::Engine(engine::EngineClient::bundled());
    if let Err(e) = &engine.0 {
        eprintln!("daily-briefing: {e}; every engine command will report this until it is fixed");
    }
    // The same `Result`, shared: T10's watcher and `state_snapshot` both read the engine, and both
    // must report a missing sidecar the way every other command does rather than panicking at
    // managed-state resolution.
    let snapshots = Arc::new(shell::EngineSnapshots::new(engine.0.clone()));
    let builder = tauri::Builder::default()
        // ⚠ FIRST, AND THAT IS THE PLUGIN'S OWN REQUIREMENT. `tauri-plugin-single-instance` takes
        // the lock in its setup hook; registered after a plugin that blocks, a second launch races
        // the first instead of focusing it. It exposes NO `#[tauri::command]` (measured: no
        // `#[tauri::command]` in its `src/`, and the crate ships no `permissions/` directory), so
        // it needs no grant.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = shell::open_today(app.clone());
        }))
        // Window size and position. Restored in the plugin's `on_window_ready` and saved on
        // `RunEvent::Exit` — entirely Rust-side, so its three commands are NOT granted.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(engine)
        .manage(snapshots)
        // The quit latch, what closing does, and the pending tray notice — per app.
        .manage(shell::ShellState::default())
        // T15's save lock. Candidate files go under `app_data_dir()/config-candidates`, resolved
        // per save (see `config_save::ConfigSaver`); the CONFIG path is always `status --json`'s.
        .manage(config_save::ConfigSaver::default())
        // T17's folder-access flow: the opener sink (the real one — `tauri-plugin-opener`'s free
        // functions), `HOME`, and the app-owned record under `app_data_dir()`. The plugin itself is
        // deliberately NOT registered below, so it contributes no live commands and the capability
        // grants no `opener:*` permission (`src/access.rs`'s header).
        .manage(access::AccessState::default())
        // B8 (dev 63): the CLI-shim Settings action. The DEFAULT state is the one place the real
        // filesystem sink ([`cli_shim::SystemShim`]) and the real `/usr/local/bin` are wired up;
        // every test manages its own state with a recording sink or a scratch directory.
        .manage(cli_shim::CliShimState::default())
        // T18: the notification decision machine. No sink is injected HERE and nowhere else: this
        // is the one place `notifications::on_snapshot` reaches the real plugin post. Tests manage
        // their own `NotifyState` with a recording sink (docs/gui-seam.md §12c).
        .manage(notifications::NotifyState::default())
        // T19: the default-ON one-shot's record and sink overrides — none in the real app, so
        // `autostart::startup` (below) reaches the real plugin manager.
        .manage(autostart::AutostartState::default())
        // B25 (T25): the uninstall action. The DEFAULT state is the one place the real
        // filesystem sink ([`uninstall::SystemFs`]) and the real app directories are wired up;
        // every test manages its own state with a recorder or scratch directories, because the
        // consented leg removes files by the ENGINE's reported state dir.
        .manage(uninstall::UninstallState::default())
        // T18's notification plugin, REGISTERED: `NotificationExt` resolves managed plugin state,
        // so the Rust-side post needs `init()`. Registration makes its three commands LIVE
        // (`notify`, `request_permission`, `is_permission_granted`) — the capability grants NONE
        // of them, and `tests/capability.rs` refuses `plugin:notification|*` behaviourally — the
        // tray's live-but-withheld command posture. Unlike the tray (which injects no script),
        // registration ALSO injects the plugin's `js_init_script` into every page: it replaces
        // `window.Notification` with an all-refused shim and fires an ungranted
        // `is_permission_granted` on load (ACL-rejected; an unhandled promise rejection in the
        // console). Nothing here consumes `window.Notification` — recorded in
        // `capabilities/README.md` and `docs/gui-seam.md` §12c.
        .plugin(tauri_plugin_notification::init())
        // T19's autostart plugin, `LaunchAgent` on macOS. Its three commands ARE granted — the
        // Settings toggle calls them from the webview, and `is_enabled()` is the REAL state the
        // toggle must reflect. ⚠ NO `.app_name(…)` and no builder form: the default derivation
        // (`package_info().name` = the productName, "Daily Briefing") is what the label test pins
        // against the CLI scheduler's `local.daily-briefing` (`tests/autostart.rs`).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // ONE menu handler for the tray AND the app menu; see `shell::on_menu_event`.
        .on_menu_event(shell::on_menu_event)
        .setup(|app| {
            shell::setup(app.handle());
            // T19's default-ON one-shot, AFTER the shell's setup: it can write a LaunchAgent
            // plist on first launch, and nothing about the window or the watcher depends on it.
            autostart::startup(app.handle());
            Ok(())
        })
        .invoke_handler(handler());
    // macOS only: Tauri's default app menu with its Quit replaced, so ⌘Q reaches the notice.
    // Elsewhere Tauri installs no app menu, and neither does this.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(shell::build_app_menu);
    builder
        .build(tauri::generate_context!())
        .expect("error while building the Daily Briefing shell")
        .run(shell::on_run_event);
}
