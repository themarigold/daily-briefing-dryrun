//! B8 — the "install command-line tool" Settings action (plan R1 line 27's
//! "`daily-briefing-app` + CLI-shim Settings action", deferred to this batch by
//! `docs/gui-seam.md` deviation 63; the design record is §13). The phrase's NAME half is not the
//! shim's: `daily-briefing-app` is the APP BUNDLE's executableName (design appendix `:189`), a
//! packaging concern deferred to the packaging tasks — deviation 131 as amended in round 1.
//!
//! ## What it is
//!
//! A symlink at [`SHIM_DIR`]`/`[`SHIM_NAME`] pointing at the MANAGED ENGINE COPY — the file
//! `schedule install` puts at `<state>/daily-briefing` and `schedule status --json` reports as
//! `binPath` — so `daily-briefing` resolves in a terminal for a user who set the product up
//! through the app and never ran `scripts/install.sh`. (The CLI's own install script keeps the
//! binary in the state directory and puts nothing on PATH either, so this action serves both
//! audiences; the target is re-read from the engine on every call, never taken from the webview —
//! the same rule as `access_reveal_engine`.)
//!
//! ## The rules, all four load-bearing
//!
//! - **Explicit user action.** Three commands, each a button on the Settings screen; nothing here
//!   runs at launch, on a timer, or as a side effect of anything else.
//! - **The target path is shown.** [`cli_shim_status`] names the shim path, what currently sits
//!   there, and the target an install would point it at; the panel renders all three.
//! - **Reversible.** [`cli_shim_remove`] deletes the symlink — and ONLY a symlink this module
//!   would have made (one whose target is the managed copy, or at least sits in the engine's
//!   state directory).
//! - **A foreign file is never overwritten or removed.** Anything else at the name — a real
//!   binary, somebody's script, a symlink into another tree — is [`ShimError::Foreign`], shown,
//!   and left exactly as it is.
//!
//! ## The sink, and what is UNRUN
//!
//! `/usr/local/bin` is outside every sandbox this suite may write to, so the real filesystem leg
//! is behind [`ShimSink`] — the `RecordingOpener` pattern. The un-overridden default pairing —
//! the real [`SystemShim`] over the real [`SHIM_DIR`] — is constructed only in `lib.rs`; tests DO
//! construct [`SystemShim`] (its own unit test drives it against a scratch tree), but **no test
//! points a real sink at the real directory**: every test-managed [`CliShimState`] carries
//! `with_dir`/`with_sink`, a discipline `tests/cli_shim.rs` pins with a source scan rather than
//! leaving to convention (round 1). The real `/usr/local/bin` write is therefore VM-gated
//! (`docs/gui-seam.md` §13's UNRUN register), like every other real-world effect in this app.
//!
//! `/usr/local/bin` is root-owned on a stock Mac (and may not exist at all on Apple Silicon), so
//! an unprivileged app must expect `EACCES`/`ENOENT` — but that backstop is NOT universal:
//! on the machine this was built on the directory is `drwxrwxr-x <installing user>:admin`
//! (measured 2026-09-17; the owner is the user who set the machine up, NOT root — round 1
//! mis-transcribed it as `root:admin`), so an admin user's app can write it without any prompt.
//! The refusals above are the protection; the permission error is only the common case. When it
//! does refuse:
//! [`ShimError::NeedsManualStep`] carries the EXACT command the user can run in their own
//! terminal, with their own authority — this app never escalates, never shells out, and never
//! runs `sudo`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::access::read_envelope;
use crate::briefing_files::{absolute, engine_paths};
use crate::engine::{Engine, EngineClient, Operation};

/// Where the shim goes. The one directory that is on every stock macOS `PATH` and writable
/// without a package manager — when it is writable at all (see the module header).
pub const SHIM_DIR: &str = "/usr/local/bin";

/// The shim's name: what a CLI user types. `scripts/install.sh` installs the engine into the
/// STATE directory and puts nothing on PATH, so this name is free unless the user made their own
/// link — which the foreign-file rule then protects.
pub const SHIM_NAME: &str = "daily-briefing";

/* ── the sink ─────────────────────────────────────────────────────────────────────────────────── */

/// What sits at the shim path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inspect {
    Missing,
    /// A symlink, and where it points (the raw link target, resolved to nothing).
    Symlink(PathBuf),
    /// Something else: a regular file, a directory, … (`&'static str` names the kind).
    Other(&'static str),
}

/// The filesystem effects, injectable so no test touches `/usr/local/bin`.
pub trait ShimSink: Send + Sync {
    fn inspect(&self, path: &Path) -> std::io::Result<Inspect>;
    /// Create `path` as a symlink to `target` — EXCLUSIVELY (`EEXIST` when anything appeared).
    fn create(&self, path: &Path, target: &Path) -> std::io::Result<()>;
    /// Replace the symlink at `path` with one to `target`, atomically (temp name + rename).
    /// Called only after [`classify`] said what is there is OURS.
    fn replace(&self, path: &Path, target: &Path) -> std::io::Result<()>;
    fn remove(&self, path: &Path) -> std::io::Result<()>;
}

/// The real filesystem. Constructed in `lib.rs` only; tests inject fakes or scratch directories.
pub struct SystemShim;

impl ShimSink for SystemShim {
    fn inspect(&self, path: &Path) -> std::io::Result<Inspect> {
        match std::fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Inspect::Missing),
            Err(e) => Err(e),
            Ok(meta) if meta.file_type().is_symlink() => {
                std::fs::read_link(path).map(Inspect::Symlink)
            }
            Ok(meta) if meta.file_type().is_dir() => Ok(Inspect::Other("a directory")),
            Ok(meta) if meta.file_type().is_file() => Ok(Inspect::Other("a regular file")),
            Ok(_) => Ok(Inspect::Other("a special file")),
        }
    }

    #[cfg(unix)]
    fn create(&self, path: &Path, target: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, path)
    }

    #[cfg(not(unix))]
    fn create(&self, _path: &Path, _target: &Path) -> std::io::Result<()> {
        Err(std::io::Error::other("symlinks are unix-only here"))
    }

    #[cfg(unix)]
    fn replace(&self, path: &Path, target: &Path) -> std::io::Result<()> {
        // Temp symlink + rename: atomic on the same filesystem, and the temp name is this
        // module's own (`config_save`'s naming discipline: pid PLUS a counter — round 1, so two
        // replaces from one process can never share a temp name; the webview-side `shimBusy`
        // flag in `AppSettings.svelte` is the ONLY serialisation of these commands, and it is a
        // UI convenience, not a lock).
        let Some(dir) = path.parent() else {
            return Err(std::io::Error::other(
                "the shim path has no parent directory",
            ));
        };
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let tmp = dir.join(format!(
            ".{SHIM_NAME}.shim-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&tmp);
        std::os::unix::fs::symlink(target, &tmp)?;
        std::fs::rename(&tmp, path).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
    }

    #[cfg(not(unix))]
    fn replace(&self, _path: &Path, _target: &Path) -> std::io::Result<()> {
        Err(std::io::Error::other("symlinks are unix-only here"))
    }

    fn remove(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }
}

/* ── managed state ────────────────────────────────────────────────────────────────────────────── */

/// The sink and the directory, both overridable by tests ONLY.
pub struct CliShimState {
    sink: Arc<dyn ShimSink>,
    dir: PathBuf,
}

impl Default for CliShimState {
    fn default() -> Self {
        Self {
            sink: Arc::new(SystemShim),
            dir: PathBuf::from(SHIM_DIR),
        }
    }
}

impl CliShimState {
    /// Test harness only.
    pub fn with_sink(mut self, sink: Arc<dyn ShimSink>) -> Self {
        self.sink = sink;
        self
    }

    /// Test harness only: point the shim at a scratch directory instead of `/usr/local/bin`.
    pub fn with_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.dir = dir.into();
        self
    }

    pub fn shim_path(&self) -> PathBuf {
        self.dir.join(SHIM_NAME)
    }
}

/* ── classification (pure) ────────────────────────────────────────────────────────────────────── */

/// What the name currently is, judged against what the engine reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ShimState {
    /// Nothing at the name.
    Absent,
    /// A symlink to the CURRENT managed copy.
    Current,
    /// A symlink of OURS — its target sits in the engine's state directory — but not the current
    /// `binPath`. Replaceable and removable.
    #[serde(rename_all = "camelCase")]
    Stale { points_to: String },
    /// Anything else: not this module's to touch. `detail` says what it is.
    #[serde(rename_all = "camelCase")]
    Foreign {
        points_to: Option<String>,
        detail: String,
    },
}

/// The ownership rule, in one pure function: a symlink is OURS exactly when its target is the
/// managed copy (`binPath`) or at least a name DIRECTLY inside the engine's state directory —
/// parent EQUALITY, not a prefix and not a name: a nested path under the state dir is foreign,
/// and so is a link into some other directory that happens to be called `daily-briefing`
/// (both pinned, round 1). Everything else — a non-symlink, a link into any other tree — is
/// foreign, whoever made it.
pub fn classify(inspect: &Inspect, bin_path: Option<&Path>, state_dir: Option<&Path>) -> ShimState {
    match inspect {
        Inspect::Missing => ShimState::Absent,
        Inspect::Other(what) => ShimState::Foreign {
            points_to: None,
            detail: format!("{what} already holds this name"),
        },
        Inspect::Symlink(target) => {
            if bin_path.is_some_and(|bin| target == bin) {
                return ShimState::Current;
            }
            // `dir.parent().is_some()`: a state dir that IS the filesystem root can own nothing —
            // `/`'s children are every top-level path on the machine, so parent equality alone
            // would call `/bin` "ours" (round 1's degenerate shape; the managed state dir is
            // always a real directory with a parent).
            if state_dir.is_some_and(|dir| dir.parent().is_some() && target.parent() == Some(dir)) {
                return ShimState::Stale {
                    points_to: target.display().to_string(),
                };
            }
            ShimState::Foreign {
                points_to: Some(target.display().to_string()),
                detail: "a symbolic link that does not point at Daily Briefing's engine".into(),
            }
        }
    }
}

/* ── wire types ───────────────────────────────────────────────────────────────────────────────── */

/// What the Settings panel shows. The manual-command WORDING lives webview-side
/// (`gui/src/lib/shim.ts`), composed from these paths — pure and pinned there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliShimStatus {
    /// False off unix — the whole action is then absent.
    pub supported: bool,
    /// `<SHIM_DIR>/<SHIM_NAME>`, for display.
    pub shim_path: String,
    /// The managed engine copy an install would point at (`schedule status --json`'s `binPath`),
    /// `null` while no background scheduler is installed.
    pub target: Option<String>,
    #[serde(flatten)]
    pub state: ShimState,
}

/// Why a shim command did not do what was asked. Tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShimError {
    /// An engine read failed; `detail` carries the engine's own words.
    Engine { detail: String },
    /// Not a unix platform: no symlinks, no `/usr/local/bin`.
    Unsupported { detail: String },
    /// No managed engine copy exists yet (`binPath` absent): install the scheduler first.
    NoManagedEngine { detail: String },
    /// The name is held by something this module did not make. Nothing was touched.
    Foreign { path: String, detail: String },
    /// The filesystem refused (permissions, or the directory does not exist). `command` is the
    /// exact line the user can run themselves; this app never escalates.
    NeedsManualStep { command: String, detail: String },
    /// Any other sink failure.
    Sink { detail: String },
}

/// POSIX single-quoting for the manual `sudo` lines. This is not optional hardening: the stock
/// target ALWAYS needs it — `binPath` lives under `~/Library/Application Support/daily-briefing`,
/// whose SPACE breaks an unquoted line on every stock macOS install (round 1, measured: `ln`
/// refused 6 words; the same rule as the engine's `systemdQuote`, `src/schedule/units.ts:147`,
/// which Rust cannot import). A `'` inside becomes `'\''`; nothing else needs escaping inside
/// single quotes.
fn sh_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

/// The exact line a user can run when installing needs authority this app does not have.
/// Shell-quoted; pinned by a `tests/cli_shim.rs` round trip through `sh`'s own word-splitting
/// with a spaced fixture path.
pub fn manual_install_command(bin: &Path, shim: &Path) -> String {
    format!("sudo ln -sfn {} {}", sh_quote(bin), sh_quote(shim))
}

/// The removal counterpart of [`manual_install_command`], same quoting rule.
pub fn manual_remove_command(shim: &Path) -> String {
    format!("sudo rm {}", sh_quote(shim))
}

fn manual_or_sink(e: std::io::Error, command: String) -> ShimError {
    use std::io::ErrorKind;
    match e.kind() {
        ErrorKind::PermissionDenied | ErrorKind::NotFound | ErrorKind::ReadOnlyFilesystem => {
            ShimError::NeedsManualStep {
                command,
                detail: e.to_string(),
            }
        }
        _ => ShimError::Sink {
            detail: e.to_string(),
        },
    }
}

/* ── the engine reads ─────────────────────────────────────────────────────────────────────────── */

/// `binPath` (absent = no scheduler installed yet) and the state directory, from the engine.
async fn engine_targets(
    client: &EngineClient,
) -> Result<(Option<PathBuf>, Option<PathBuf>), ShimError> {
    let engine_err = |detail: String| ShimError::Engine { detail };
    let schedule = read_envelope(client, Operation::ScheduleStatus)
        .await
        .map_err(engine_err)?;
    let bin = match schedule.get("binPath").and_then(Value::as_str) {
        Some(value) => Some(
            absolute(
                "schedule status --json",
                "binPath",
                Some(&value.to_string()),
            )
            .map_err(engine_err)?,
        ),
        None => None,
    };
    let paths = engine_paths(client).await.map_err(engine_err)?;
    // The same `absolute()` rule as `binPath` (round 1): a relative state dir would make the
    // ownership judgement depend on this app's working directory.
    let state_dir = paths
        .state_dir
        .as_ref()
        .map(|dir| absolute("status --json", "paths.stateDir", Some(dir)))
        .transpose()
        .map_err(engine_err)?;
    Ok((bin, state_dir))
}

fn client_of(engine: &Engine) -> Result<&EngineClient, ShimError> {
    engine.client().map_err(|e| ShimError::Engine {
        detail: e.to_string(),
    })
}

fn gate() -> Result<(), ShimError> {
    if cfg!(unix) {
        Ok(())
    } else {
        Err(ShimError::Unsupported {
            detail: "the command-line shim is a symlink in /usr/local/bin, which only exists on \
                     unix platforms"
                .into(),
        })
    }
}

async fn status_of(shim: &CliShimState, client: &EngineClient) -> Result<CliShimStatus, ShimError> {
    let (bin, state_dir) = engine_targets(client).await?;
    let path = shim.shim_path();
    let inspect = shim.sink.inspect(&path).map_err(|e| ShimError::Sink {
        detail: format!("reading {}: {e}", path.display()),
    })?;
    Ok(CliShimStatus {
        supported: true,
        shim_path: path.display().to_string(),
        target: bin.as_ref().map(|b| b.display().to_string()),
        state: classify(&inspect, bin.as_deref(), state_dir.as_deref()),
    })
}

/* ── the commands ─────────────────────────────────────────────────────────────────────────────── */

/// What is at the shim name, what an install would point it at, and whose it is. Read-only:
/// two engine spawns (`schedule status --json`, `status --json`) and one `lstat`/`readlink`.
#[tauri::command]
pub async fn cli_shim_status(
    engine: State<'_, Engine>,
    shim: State<'_, CliShimState>,
) -> Result<CliShimStatus, ShimError> {
    if !cfg!(unix) {
        return Ok(CliShimStatus {
            supported: false,
            shim_path: shim.shim_path().display().to_string(),
            target: None,
            state: ShimState::Absent,
        });
    }
    status_of(&shim, client_of(&engine)?).await
}

/// Create (or repair) the shim. Refuses a foreign file; `Current` is an idempotent no-op.
///
/// ⚠ THE TARGET IS RE-READ FROM THE ENGINE, never taken from the webview — the command takes no
/// argument at all. A missing managed copy is a refusal pointing at the scheduler install, not a
/// link to a file that does not exist.
#[tauri::command]
pub async fn cli_shim_install(
    engine: State<'_, Engine>,
    shim: State<'_, CliShimState>,
) -> Result<CliShimStatus, ShimError> {
    gate()?;
    let client = client_of(&engine)?;
    let (bin, state_dir) = engine_targets(client).await?;
    let Some(bin) = bin else {
        return Err(ShimError::NoManagedEngine {
            detail: "no background scheduler is installed yet, so there is no managed engine \
                     copy to link to"
                .into(),
        });
    };
    let path = shim.shim_path();
    let shown = path.display().to_string();
    let manual = manual_install_command(&bin, &path);
    let inspect = shim
        .sink
        .inspect(&path)
        .map_err(|e| manual_or_sink(e, manual.clone()))?;
    match classify(&inspect, Some(&bin), state_dir.as_deref()) {
        ShimState::Foreign { detail, .. } => {
            return Err(ShimError::Foreign {
                path: shown,
                detail,
            })
        }
        ShimState::Current => {}
        ShimState::Absent => {
            // Exclusive: a foreign file that appeared since the inspect fails with EEXIST
            // rather than being replaced.
            shim.sink
                .create(&path, &bin)
                .map_err(|e| manual_or_sink(e, manual.clone()))?;
        }
        ShimState::Stale { .. } => {
            // Ours: replace atomically (temp symlink + rename).
            shim.sink
                .replace(&path, &bin)
                .map_err(|e| manual_or_sink(e, manual.clone()))?;
        }
    }
    status_of(&shim, client).await
}

/// Remove the shim — only when it is OURS ([`classify`]). `Absent` is an idempotent no-op; a
/// foreign file is refused and untouched.
#[tauri::command]
pub async fn cli_shim_remove(
    engine: State<'_, Engine>,
    shim: State<'_, CliShimState>,
) -> Result<CliShimStatus, ShimError> {
    gate()?;
    let client = client_of(&engine)?;
    let (bin, state_dir) = engine_targets(client).await?;
    let path = shim.shim_path();
    let shown = path.display().to_string();
    let manual = manual_remove_command(&path);
    let inspect = shim
        .sink
        .inspect(&path)
        .map_err(|e| manual_or_sink(e, manual.clone()))?;
    match classify(&inspect, bin.as_deref(), state_dir.as_deref()) {
        ShimState::Foreign { detail, .. } => {
            return Err(ShimError::Foreign {
                path: shown,
                detail,
            })
        }
        ShimState::Absent => {}
        ShimState::Current | ShimState::Stale { .. } => {
            shim.sink
                .remove(&path)
                .map_err(|e| manual_or_sink(e, manual.clone()))?;
        }
    }
    status_of(&shim, client).await
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &["cli_shim_status", "cli_shim_install", "cli_shim_remove"];
