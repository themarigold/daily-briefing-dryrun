//! T17 — the macOS Files-and-Folders / Full Disk Access grant flow, and the app's OWN TCC
//! principal.
//!
//! ## Two principals, not one — and the appendix says otherwise
//!
//! gui-tauri T17 opens with *"TCC attributes access to the responsible process — the .app bundle —
//! not the sidecar, so the APP must hold the grant and the sidecar inherits it."* Plan R1 replaces
//! that with **two** principals, and this module is built for the version where inheritance does
//! NOT happen, because SPK-1(b) has not run:
//!
//!   * **The delegated principal** — the managed engine copy at `<state>/daily-briefing`, signed
//!     with the stable local identity `local.daily-briefing`. It is what launchd executes at 07:20,
//!     it holds the grant across rebuilds, and it is replaced ONLY by an explicit `schedule
//!     install`. Its grant is acquired by a guided step: reveal the copy in Finder
//!     ([`access_reveal_engine`]), then add it in System Settings ([`SettingsPane`]).
//!   * **The app principal** — this `.app`, which is the responsible process for a GUI-initiated
//!     run. Its grant is acquired by the prompt-driven [`access_probe`] read.
//!
//! **Both are guided whenever a protected root is in scope.** `docs/spikes/spk-1b-app-principal.md`
//! §4's negative branch (the child is judged on its own code identity, so the sidecar does not
//! inherit the app's grant) is UNRUN, and the flow is correct in both branches only if it never
//! assumes inheritance: guiding both principals costs one extra step in the branch where
//! inheritance turns out to hold, and is the difference between a working briefing and a silently
//! empty one in the branch where it does not.
//!
//! ## What is CONDITIONAL, and what never fires on its own
//!
//! Plan R1: grant acquisition runs *"whenever protected-root repos are in scope"* — at onboarding
//! if selected there, or later through the always-available Schedule & Access panel. The
//! app-principal probe at LAUNCH is *"ONLY a revocation detector — when a protected root is in
//! scope AND a prior app-principal grant is recorded; it never fires as an acquisition trigger
//! outside the guided flow"*, so the deselected-by-default protected-roots graft keeps its
//! no-unexplained-prompt property.
//!
//! That rule is [`probe_advice`], a pure two-input function, and it is the ONLY thing that tells
//! the webview a launch-time probe is appropriate. The probe command itself is reachable from the
//! guided flow as well — Rust cannot tell a guided click from an ungated one, and pretending it
//! could would put the honest gate somewhere it is not.
//!
//! ## What never crosses the IPC boundary
//!
//!   * **No path, in either direction as an operand.** [`access_probe`] takes a [`ProtectedRoot`]
//!     — a closed four-member enum — and joins it onto the app's own `HOME`; the webview cannot
//!     name a directory. [`access_reveal_engine`] takes nothing and reads `binPath` from
//!     `schedule status --json`.
//!   * **No URL.** [`access_open_settings`] takes a [`SettingsPane`], also closed, and maps it to
//!     one of three fixed literals ([`SETTINGS_FILES_AND_FOLDERS`], [`SETTINGS_FULL_DISK_ACCESS`],
//!     [`SETTINGS_PRIVACY_ROOT`]).
//!   * **No file CONTENTS.** The probe counts directory entries and never opens one — see
//!     [`read_dir_access`].
//!
//! ## `tauri-plugin-opener` is a dependency and is NOT registered
//!
//! `open_url` and `reveal_item_in_dir` are free functions in that crate (2.5.5,
//! `src/open.rs`, `src/reveal_item_in_dir.rs`); the plugin's `init()` is never called, so its
//! commands do not exist at runtime at all and the capability grants no `opener:*` permission.
//! `tests/capability.rs`'s `the_webview_cannot_reach_the_opener_plugin` pins the refusal. ⚠ The
//! refusal's SHAPE is not the shell's (round 1, measured): because the crate is in
//! `[dependencies]`, `tauri-build` collects its ACL manifest (`gen/schemas/acl-manifests.json`
//! has an `opener` entry), so a `plugin:opener|open_url` call is refused by the ACL — *"opener.
//! open_url not allowed. Permissions associated with this command: …"* — one layer BEFORE the
//! missing registration could answer `Plugin not found` (the shell's refusal, whose crate is in no
//! dependency table). Same verdict, different doorman. Every call goes through [`OpenSink`], so a
//! test asserts the URL or the path that was CHOSEN and nothing is ever opened.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::briefing_files::{
    absolute, engine_paths, failure_detail, read_single_link_text_capped, read_text_capped,
};
use crate::engine::{Engine, EngineClient, NoProgress, Operation, Outcome};
use crate::shell::ENGINE_READ_TIMEOUT;

/* ── the protected roots ──────────────────────────────────────────────────────────────────────── */

/// The four macOS-protected, home-relative folders, as PATH SEGMENTS.
///
/// ⚠ THE SOURCE OF TRUTH IS THE ENGINE, and this is a copy that a test refuses to let drift:
/// `src/protectedPath.ts`'s `defaultProtectedRoots` (`join(home, "Desktop")`,
/// `"Documents"`, `"Downloads"`, `join(home, "Library", "Mobile Documents")` — the iCloud Drive
/// container root). `tests/access.rs`'s `the_protected_roots_are_the_engines`
/// parses that function and compares, because the app's idea of "in scope" and the ENGINE's idea of
/// "this EPERM is a TCC denial" have to be the same list or the panel offers a grant for a folder
/// the engine never classifies, and stays silent for one it does.
///
/// Removable and network volumes are a separate TCC category and are deliberately absent, as they
/// are in the engine.
pub const PROTECTED_ROOT_SEGMENTS: &[(&str, &[&str])] = &[
    ("desktop", &["Desktop"]),
    ("documents", &["Documents"]),
    ("downloads", &["Downloads"]),
    ("icloud", &["Library", "Mobile Documents"]),
];

/// Which protected root a caller means. A CLOSED SET, deliberately: this is the operand
/// [`access_probe`] takes, and an enum is what makes "the webview cannot name a directory" true by
/// construction rather than by validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProtectedRoot {
    Desktop,
    Documents,
    Downloads,
    /// `~/Library/Mobile Documents` — the iCloud Drive container root.
    Icloud,
}

impl ProtectedRoot {
    /// The wire spelling, and the key [`RootInScope::key`] carries.
    pub fn key(self) -> &'static str {
        match self {
            ProtectedRoot::Desktop => "desktop",
            ProtectedRoot::Documents => "documents",
            ProtectedRoot::Downloads => "downloads",
            ProtectedRoot::Icloud => "icloud",
        }
    }

    /// Parse a key back. `None` for anything else — no fallback root, because a typo that resolved
    /// to `~/Desktop` would raise a TCC prompt nobody asked for.
    pub fn from_key(key: &str) -> Option<Self> {
        match key {
            "desktop" => Some(ProtectedRoot::Desktop),
            "documents" => Some(ProtectedRoot::Documents),
            "downloads" => Some(ProtectedRoot::Downloads),
            "icloud" => Some(ProtectedRoot::Icloud),
            _ => None,
        }
    }

    /// Every member, in the engine's own order.
    pub fn all() -> [ProtectedRoot; 4] {
        [
            ProtectedRoot::Desktop,
            ProtectedRoot::Documents,
            ProtectedRoot::Downloads,
            ProtectedRoot::Icloud,
        ]
    }

    /// This root under `home`.
    pub fn path(self, home: &Path) -> PathBuf {
        let mut p = home.to_path_buf();
        for segment in PROTECTED_ROOT_SEGMENTS
            .iter()
            .find(|(key, _)| *key == self.key())
            .map(|(_, segments)| *segments)
            .unwrap_or(&[])
        {
            p.push(segment);
        }
        p
    }
}

/// Every protected root under `home`, paired with its key.
pub fn protected_roots(home: &Path) -> Vec<(ProtectedRoot, PathBuf)> {
    ProtectedRoot::all()
        .into_iter()
        .map(|root| (root, root.path(home)))
        .collect()
}

/// Whether `path` is at or under `root`, separator-aware.
///
/// ⚠ A PORT OF THE ENGINE'S `matchProtectedRoot`, INCLUDING ITS CASE RULE. `src/protectedPath.ts`
/// compares case-insensitively on darwin and win32 (default APFS and NTFS are case-insensitive), so
/// a config that spells `~/desktop/proj` is classified `tcc-denied` there — and a panel that
/// matched case-sensitively would call the same path out of scope and offer no grant for it.
/// Separator-aware in both: `/a/Desktopfoo` does not match `/a/Desktop`.
pub fn is_under(path: &str, root: &str, case_insensitive: bool) -> bool {
    let (p, r) = if case_insensitive {
        (path.to_lowercase(), root.to_lowercase())
    } else {
        (path.to_string(), root.to_string())
    };
    if r.is_empty() {
        return false;
    }
    p == r || p.starts_with(&format!("{r}{}", std::path::MAIN_SEPARATOR))
}

/// Whether this platform's filesystem is case-insensitive by default, as the ENGINE decides it
/// (`classifyReadError`: `platform === "darwin" || platform === "win32"`).
pub fn case_insensitive_for(os: &str) -> bool {
    os == "macos" || os == "windows"
}

/// A leading `~` expanded against `home` — a PORT OF THE ENGINE'S `expandTilde`, rule for rule
/// (`src/config.ts`: `~` alone → home; `~/` or `~\` → `join(home, rest)`; **`~user` is NOT
/// expanded**, and neither is a `~` anywhere but the front).
///
/// ⚠ WHY THIS EXISTS (round 1): the engine expands `~` in `repos`/`discoverRoots` at config LOAD,
/// but [`scope_of`] reads the RAW config file — so a repo spelled `~/Desktop/proj` string-matched
/// as not-under `/Users/x/Desktop` and was silently invisible to the config-side scope source.
/// §11d's whole reason for that source is the protected discovery root with no repo yet, which is
/// exactly the state a `~`-spelled entry sat in.
pub fn expand_tilde(p: &str, home: &Path) -> String {
    if p == "~" {
        return home.to_string_lossy().into_owned();
    }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        return home.join(rest).to_string_lossy().into_owned();
    }
    p.to_string()
}

/* ── scope ────────────────────────────────────────────────────────────────────────────────────── */

/// One protected root that something in this config actually reaches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootInScope {
    /// The operand [`access_probe`] takes for this root.
    pub key: &'static str,
    /// The absolute path, for display. The app never receives one back.
    pub path: String,
    /// Paths under this root the ENGINE classified `tcc-denied` right now.
    pub denied: Vec<DeniedPath>,
    /// Why this root is in scope: a configured repo, a configured discovery root, or a path the
    /// engine reported. Display only.
    pub because: Vec<String>,
}

/// A `tcc-denied` repo, with the engine's own advice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeniedPath {
    pub path: String,
    /// ⚠ `doctor --json`'s `advice`, VERBATIM — it is `warnFor(issue)` (`src/protectedPath.ts`) and
    /// the appendix requires it shown unmodified. Nothing here rewrites, truncates or re-words it;
    /// `gui/tests-web/access.check.ts` compares the rendered text against `warnFor()`'s own output.
    pub advice: String,
}

/// Doctor's repo row, as much of it as scope detection reads.
///
/// ⚠ `rename_all` IS NOT INHERITED FROM THE OUTER TYPE. Without it here, `issue_kind` looks for
/// `issue_kind` in an envelope that spells it `issueKind`, `#[serde(default)]` makes the miss
/// silent, and EVERY tcc-denied row reads as not-denied — the panel would list the root and offer
/// no advice for it. (Measured: `a_tcc_denied_row_carries_the_engines_advice_unmodified` went red
/// on exactly that.)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DoctorRepo {
    path: String,
    #[serde(default)]
    issue_kind: Option<String>,
    #[serde(default)]
    advice: Option<String>,
}

/// The `doctor --json` fields this module reads. Everything else is ignored, because the envelope
/// is frozen ADDITIVE-ONLY and a `deny_unknown_fields` here would break on the next added key.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DoctorView {
    #[serde(default)]
    repos: Vec<DoctorRepo>,
    #[serde(default)]
    repos_timed_out: bool,
    #[serde(default)]
    verdict: Option<String>,
}

/// The config fields scope detection reads. Both are optional in the engine's schema.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigRoots {
    #[serde(default)]
    repos: Option<Vec<String>>,
    #[serde(default)]
    discover_roots: Option<Vec<String>>,
}

/// Decide which protected roots this configuration reaches, and what the engine says about them.
///
/// ⚠ TWO SOURCES, BECAUSE NEITHER COVERS THE OTHER. `doctor --json`'s `repos[]` is the union of the
/// repos discovery FOUND and the paths preflight had an ISSUE with, so it sees a repo under
/// `~/Documents` that was reached through a `discoverRoots` entry of `~` — which the config alone
/// does not show. The CONFIG shows a `discoverRoots` entry that IS a protected root and has not
/// produced a repo yet — which doctor does not list, because there is nothing there to list, and
/// which is exactly the state a user is in while they are still setting the app up.
///
/// A root is in scope if EITHER names a path at or under it. `denied` carries only what doctor
/// reported as `tcc-denied` now.
///
/// ⚠ `draft` (B8, T16): paths the WIZARD's not-yet-saved draft names (`repos` + `discoverRoots`
/// as typed), treated exactly as configured entries — expanded and matched the same way, and
/// landing in `because` under the same de-duplication. The wizard writes the config once at the
/// end, so at its folder-access step the scope the user is ABOUT to configure exists nowhere on
/// disk; this is the one place it enters the computation. Every non-wizard caller passes `&[]`.
pub fn scope_of(
    doctor: &Value,
    config: Option<&Value>,
    draft: &[String],
    home: &Path,
    case_insensitive: bool,
) -> Vec<RootInScope> {
    let view: DoctorView = serde_json::from_value(doctor.clone()).unwrap_or(DoctorView {
        repos: Vec::new(),
        repos_timed_out: false,
        verdict: None,
    });
    let roots = config
        .and_then(|c| serde_json::from_value::<ConfigRoots>(c.clone()).ok())
        .unwrap_or_default();
    // ⚠ EXPANDED AS THE ENGINE WOULD EXPAND THEM ([`expand_tilde`]), against the same `home` the
    // roots were built from — and the EXPANDED spelling is what lands in `because`, so a config
    // entry and the doctor row for the same repo de-duplicate instead of listing twice.
    let configured: Vec<String> = roots
        .repos
        .unwrap_or_default()
        .into_iter()
        .chain(roots.discover_roots.unwrap_or_default())
        .chain(draft.iter().cloned())
        .map(|p| expand_tilde(&p, home))
        .collect();

    let mut out: Vec<RootInScope> = Vec::new();
    for (root, path) in protected_roots(home) {
        let root_str = path.to_string_lossy().into_owned();
        let mut because: Vec<String> = Vec::new();
        let mut denied: Vec<DeniedPath> = Vec::new();
        for candidate in &configured {
            // `contains`: a draft entry that repeats a configured one (the wizard pre-populates
            // its draft FROM the config on a re-run) must not list the same path twice.
            if is_under(candidate, &root_str, case_insensitive) && !because.contains(candidate) {
                because.push(candidate.clone());
            }
        }
        for repo in &view.repos {
            if !is_under(&repo.path, &root_str, case_insensitive) {
                continue;
            }
            if !because.contains(&repo.path) {
                because.push(repo.path.clone());
            }
            if repo.issue_kind.as_deref() == Some("tcc-denied") {
                denied.push(DeniedPath {
                    path: repo.path.clone(),
                    // The engine always writes advice for an issue; an envelope without one is
                    // reported as the empty string rather than given wording invented here.
                    advice: repo.advice.clone().unwrap_or_default(),
                });
            }
        }
        if because.is_empty() {
            continue;
        }
        out.push(RootInScope {
            key: root.key(),
            path: root_str,
            denied,
            because,
        });
    }
    out
}

/// The most draft paths [`access_snapshot`] accepts, and the longest single entry (bytes).
///
/// Bounds, not semantics: a draft entry is prefix-MATCHED and DISPLAYED, never opened, joined or
/// spawned — the probe path itself is always built from the closed [`ProtectedRoot`] enum. The
/// caps keep a hostile webview from stuffing the snapshot, and the character rule keeps §5's
/// rendering discipline (`because` is shown as text; control characters have no place in a path a
/// person typed into the wizard).
pub const MAX_DRAFT_PATHS: usize = 64;
pub const MAX_DRAFT_PATH_BYTES: usize = 1024;

/// Refuse a wizard draft before anything runs: too many entries, an empty entry, an entry over
/// [`MAX_DRAFT_PATH_BYTES`], one carrying an ASCII control character (NUL included), or — round
/// 1 — one carrying a zero-width or bidirectional FORMAT character, which is invisible or able
/// to reorder what §5's text rendering shows (a display-spoof class the ASCII rule missed).
pub fn checked_draft(draft: &[String]) -> Result<(), String> {
    if draft.len() > MAX_DRAFT_PATHS {
        return Err(format!(
            "{} draft paths were sent; at most {MAX_DRAFT_PATHS} are accepted",
            draft.len()
        ));
    }
    for (i, entry) in draft.iter().enumerate() {
        if entry.is_empty() {
            return Err(format!("draft path {} is empty", i + 1));
        }
        if entry.len() > MAX_DRAFT_PATH_BYTES {
            return Err(format!(
                "draft path {} is {} bytes; at most {MAX_DRAFT_PATH_BYTES} are accepted",
                i + 1,
                entry.len()
            ));
        }
        if entry.chars().any(|c| c.is_ascii_control()) {
            return Err(format!("draft path {} contains a control character", i + 1));
        }
        // U+200B zero-width space; U+202A–E and U+2066–9, the BiDi embedding/override/isolate
        // controls; U+2028/9, JavaScript's line separators. No path a person typed contains any.
        const FORMAT_CONTROLS: &[char] = &[
            '\u{200B}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}', '\u{202E}', '\u{2028}',
            '\u{2029}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}',
        ];
        if entry.chars().any(|c| FORMAT_CONTROLS.contains(&c)) {
            return Err(format!(
                "draft path {} contains an invisible or bidirectional format character",
                i + 1
            ));
        }
    }
    Ok(())
}

/* ── the app-principal read ───────────────────────────────────────────────────────────────────── */

/// Raw errno values. Spelled out rather than taken from `libc` so this classifier reads without a
/// second crate's table beside it; `tests/access.rs`'s `the_errno_constants_are_what_this_os_reports`
/// pins THESE bindings against `std::io::Error::from_raw_os_error`.
pub const EPERM: i32 = 1;
pub const ENOENT: i32 = 2;
pub const EACCES: i32 = 13;
pub const ENOTDIR: i32 = 20;

/// What a directory read said, classified.
///
/// ⚠ `EPERM` AND `EACCES` ARE BOTH `Denied`, AND THE DISTINCTION THE ENGINE MAKES IS NOT AVAILABLE
/// HERE. `src/protectedPath.ts` calls an `EPERM` under a protected root a TCC denial and an
/// `EACCES` an ordinary permission problem; this probe is always pointed AT a protected root, so
/// the root half of that test is already true — but macOS returns `EPERM` for TCC and a
/// `chmod 000` directory returns `EACCES`, and nothing in the errno tells the two apart beyond
/// that. The verdict says `denied` for both and the caller is told the errno.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DirAccess {
    /// The directory opened and enumerated cleanly. `entries` is a COUNT.
    Ok { entries: usize },
    /// `EPERM` (a TCC denial on macOS) or `EACCES` (ordinary permissions).
    Denied { errno: i32 },
    /// `ENOENT` — nothing there. Not a grant problem: a repo configured under a folder that does
    /// not exist is a typo, and the engine reports it as `not-found` too.
    NotFound,
    /// `ENOTDIR` — the path exists and is not a directory.
    NotADirectory,
    /// Anything else, with the OS's own number or `ErrorKind` name.
    Error { detail: String },
}

/// Classify a failed directory read.
pub fn classify_dir_error(err: &std::io::Error) -> DirAccess {
    match err.raw_os_error() {
        Some(errno @ (EPERM | EACCES)) => DirAccess::Denied { errno },
        Some(ENOENT) => DirAccess::NotFound,
        Some(ENOTDIR) => DirAccess::NotADirectory,
        Some(other) => DirAccess::Error {
            detail: format!("errno-{other}"),
        },
        None => DirAccess::Error {
            detail: format!("{:?}", err.kind()),
        },
    }
}

/// Collapse an opened directory's per-entry results into one verdict: the FIRST entry error wins,
/// and a directory that enumerates clean is the only `Ok`.
///
/// ⚠ THE DRAIN IS LOAD-BEARING. A TCC-refused directory can `opendir` and then fail per entry, so
/// treating a successful `read_dir` as a pass would turn a denial into a grant. Generic over the
/// item type because `std::fs::DirEntry` cannot be constructed in a test and the only portable way
/// to make a real directory fail mid-enumeration is a `chmod` race.
pub fn verdict_from_entries<T, I>(entries: I) -> DirAccess
where
    I: IntoIterator<Item = Result<T, std::io::Error>>,
{
    let mut count = 0usize;
    for entry in entries {
        match entry {
            Err(e) => return classify_dir_error(&e),
            Ok(_) => count += 1,
        }
    }
    DirAccess::Ok { entries: count }
}

/// Read `dir` from THIS process — the app principal, which is what makes this the prompt trigger.
///
/// ⚠ A COUNT, NEVER CONTENTS, AND THAT IS THE WHOLE OF WHAT IS READ. TCC gates the `opendir`, so
/// enumerating the directory is sufficient to answer "may this principal read here" — and it is
/// also the LEAST the question can be answered with. Names are not collected, no entry is opened,
/// no metadata beyond what `read_dir` itself yields is requested, and the count is the only thing
/// that reaches the webview. Reading a file under a user's `~/Documents` to prove the app can read
/// `~/Documents` would put its bytes in this process for no additional fact.
pub fn read_dir_access(dir: &Path) -> DirAccess {
    match std::fs::read_dir(dir) {
        Err(e) => classify_dir_error(&e),
        Ok(entries) => verdict_from_entries(entries),
    }
}

/* ── the launch gate, and the post-update check ───────────────────────────────────────────────── */

/// Whether a launch-time app-principal probe is appropriate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProbeAdvice {
    /// Do not read anything. Either nothing protected is in scope, or no grant was ever observed —
    /// and in the second case a read would be an ACQUISITION trigger, i.e. an unexplained system
    /// prompt outside the guided flow.
    None,
    /// A grant was recorded and something protected is in scope: read once, to find out whether the
    /// grant is still there. A revoked grant is the failure plan R1 calls the worst user-visible
    /// outcome in the design — the app updates, the next morning's briefing is empty, and the cause
    /// is invisible.
    RevocationCheck,
}

/// Plan R1's rule, as two inputs and nothing else.
///
/// ⚠ BOTH CONDITIONS, AND THE SECOND ONE IS THE WHOLE POINT. Dropping `grant_recorded` turns this
/// into an acquisition trigger at every launch, which is exactly the "no unexplained prompts"
/// property the deselected-by-default protected-roots graft exists to keep.
pub fn probe_advice(in_scope: bool, grant_recorded: bool) -> ProbeAdvice {
    if in_scope && grant_recorded {
        ProbeAdvice::RevocationCheck
    } else {
        ProbeAdvice::None
    }
}

/// Whether this launch is the first, the same version as the last, or a new one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VersionChange {
    /// Nothing was recorded — this app has not run before (or its state was cleared).
    FirstLaunch,
    Same,
    /// ⚠ THE CASE T21's KEPT HALF EXISTS FOR. An ad-hoc-signed `.app` has a cdhash-bound designated
    /// requirement, so every rebuild or update REVOKES the app principal's grant (plan R1,
    /// delta-verify H). A new version plus a protected root in scope is the moment to look.
    Changed {
        from: String,
    },
}

/// Compare the recorded version with this build's.
pub fn version_change(recorded: Option<&str>, current: &str) -> VersionChange {
    match recorded {
        None => VersionChange::FirstLaunch,
        Some(v) if v == current => VersionChange::Same,
        Some(v) => VersionChange::Changed {
            from: v.to_string(),
        },
    }
}

/* ── the app-owned record ─────────────────────────────────────────────────────────────────────── */

/// The name of the app-owned state file, under Tauri's `app_data_dir()`.
///
/// ⚠ NEVER THE ENGINE'S STATE DIRECTORY. Plan R1 and the T17 brief both say so, and the reason is
/// ownership: `<state>/` is the ENGINE's, shared with every CLI user, read by `status --json` and
/// bounded by `scripts/uninstall.sh`'s explicit list. A file the app invented there would be state
/// the engine never declared, that the CLI's uninstaller does not remove, and that a second GUI
/// version would have to keep reading forever.
pub const STORE_FILE: &str = "access-state.json";

/// What the app remembers about access between launches. Two facts, both app-owned.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AccessRecord {
    /// ⚠ "OBSERVED", NOT "GRANTED". Nothing here can grant anything; this is set when a read of a
    /// protected root from this process SUCCEEDED, which is the only evidence the app can have.
    pub app_principal_grant_observed: bool,
    /// The app version at the previous launch, for [`version_change`].
    pub last_launch_version: Option<String>,
}

/// The record's size cap. It holds a boolean and a version string; 64 KiB is four orders of
/// magnitude of headroom and still a bound on a file this app will read at every launch.
pub const MAX_RECORD_BYTES: u64 = 64 * 1024;

/// Read the record. A missing, unreadable or malformed file is `Default` — the app has simply not
/// observed anything — because a panel that refused to open over its own cache would be worse than
/// one that re-asks a question it already knew the answer to.
///
/// ⚠ `read_text_capped`, NOT the single-link form. The no-follow rule applies (a symlink at this
/// name is something else's file, as it is for a briefing), but the HARD-LINK rule does not: that
/// one exists for the CONFIG, a file the user hand-edits and dotfiles-manages, where a rename
/// detaching a second name loses somebody's link. This record is app-owned, tiny, and degrades to
/// `Default` — the refusal would buy nothing here.
pub fn read_record(dir: &Path) -> AccessRecord {
    match read_text_capped(&dir.join(STORE_FILE), MAX_RECORD_BYTES) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => AccessRecord::default(),
    }
}

/// Write the record, creating the directory. Returns the OS's own words on failure: the caller
/// reports "this will be asked again next time" rather than failing the operation the record was
/// only a by-product of.
///
/// ⚠ TEMP-THEN-RENAME, NOT TRUNCATE-THEN-WRITE (round 1, GA3). `std::fs::write` truncates first,
/// so a crash mid-write MANUFACTURES exactly the malformed record whose degrade-to-`Default`
/// (above, pinned) then silently turns the next launch's revocation CHECK back into a suppressed
/// probe. The rename is the same shape `config_save` uses, minus its backup/hard-link machinery
/// (see `read_record`'s note on why that does not apply here). The temp name carries the pid and a
/// sequence number so two concurrent commands of this app never stage into the same file; a temp
/// orphaned by a crash is inert — nothing reads any name but [`STORE_FILE`].
pub fn write_record(dir: &Path, record: &AccessRecord) -> Result<(), String> {
    use std::io::Write;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(STORE_FILE);
    let text = serde_json::to_string_pretty(record)
        .map_err(|e| format!("the access record could not be serialised: {e}"))?;
    let tmp = dir.join(format!(
        "{STORE_FILE}.tmp-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let staged = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()
    })();
    if let Err(e) = staged {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{}: {e}", tmp.display()));
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })
}

/* ── the System Settings deep links ───────────────────────────────────────────────────────────── */

/// Files and Folders — the narrow grant, per-folder.
///
/// ⚠ UNVERIFIED ON macOS 26 (appendix T17 names this URL; nothing in this build has opened it).
/// [`SettingsPane::PrivacyRoot`] is the fallback the panel offers beside the step-by-step text, and
/// the panel says in words that the deep link may land on the Privacy list rather than the pane.
pub const SETTINGS_FILES_AND_FOLDERS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Files";

/// Full Disk Access — the broad grant. UNVERIFIED on macOS 26, as above.
pub const SETTINGS_FULL_DISK_ACCESS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/// The Privacy & Security root — the fallback, and the least version-specific of the three.
pub const SETTINGS_PRIVACY_ROOT: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy";

/// Which System Settings pane to open. A CLOSED SET: the webview never supplies a URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingsPane {
    FilesAndFolders,
    FullDiskAccess,
    PrivacyRoot,
}

impl SettingsPane {
    pub fn url(self) -> &'static str {
        match self {
            SettingsPane::FilesAndFolders => SETTINGS_FILES_AND_FOLDERS,
            SettingsPane::FullDiskAccess => SETTINGS_FULL_DISK_ACCESS,
            SettingsPane::PrivacyRoot => SETTINGS_PRIVACY_ROOT,
        }
    }
}

/* ── the opener sink ──────────────────────────────────────────────────────────────────────────── */

/// Where an "open this" ends up.
///
/// ⚠ A TRAIT SO THE SUITE NEVER OPENS ANYTHING. Opening the real URL would launch System Settings
/// on the machine running the tests, and revealing a path would raise a Finder window; both are
/// side effects on a developer's session that no assertion needs. Every test manages a recording
/// sink and asserts the URL or path that was CHOSEN.
pub trait OpenSink: Send + Sync {
    fn open_url(&self, url: &str) -> Result<(), String>;
    fn reveal(&self, path: &Path) -> Result<(), String>;
}

/// The shipping sink: `tauri-plugin-opener`'s free functions.
///
/// ⚠ FREE FUNCTIONS, NOT THE PLUGIN. `tauri_plugin_opener::init()` is never called, so the plugin
/// contributes no live commands and the webview has nothing to be granted — see the module header.
pub struct SystemOpener;

impl OpenSink for SystemOpener {
    fn open_url(&self, url: &str) -> Result<(), String> {
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
    }

    fn reveal(&self, path: &Path) -> Result<(), String> {
        tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
    }
}

/* ── managed state ────────────────────────────────────────────────────────────────────────────── */

/// Everything T17 needs that is not the engine: where to open things, where `HOME` is, and where
/// the app's own record lives.
///
/// ⚠ THE THREE OVERRIDES EXIST FOR ONE REASON EACH, and all three are test-only. `HOME` decides
/// which directories the probe would READ, and pointing it at a tempdir is what keeps the suite
/// away from the developer's real `~/Desktop` — a read there would raise a real TCC prompt or
/// consume a real grant. The store directory is `app_data_dir()`, which on `MockRuntime` is the
/// developer's REAL one (the same trap `ConfigSaver::with_candidate_dir` exists for). The sink is
/// above.
pub struct AccessState {
    opener: Arc<dyn OpenSink>,
    home: Option<PathBuf>,
    store_dir: Option<PathBuf>,
}

impl Default for AccessState {
    fn default() -> Self {
        Self {
            opener: Arc::new(SystemOpener),
            home: None,
            store_dir: None,
        }
    }
}

impl AccessState {
    pub fn with_opener(mut self, opener: Arc<dyn OpenSink>) -> Self {
        self.opener = opener;
        self
    }

    /// **Test harness only** — see the struct docs.
    pub fn with_home(mut self, home: impl Into<PathBuf>) -> Self {
        self.home = Some(home.into());
        self
    }

    /// **Test harness only** — see the struct docs.
    pub fn with_store_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.store_dir = Some(dir.into());
        self
    }

    /// The home directory the protected roots are resolved under — the override, else `HOME`
    /// (`USERPROFILE` on Windows), else `/`. The same rule `engine::home_dir` follows, and for the
    /// same reason: a missing `HOME` is a broken session, not a reason to refuse to open.
    pub fn home(&self) -> PathBuf {
        if let Some(home) = &self.home {
            return home.clone();
        }
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        std::env::var_os(key)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"))
    }

    fn store_dir<R: Runtime>(&self, app: &AppHandle<R>) -> Result<PathBuf, AccessError> {
        if let Some(dir) = &self.store_dir {
            return Ok(dir.clone());
        }
        app.path().app_data_dir().map_err(|e| AccessError::Store {
            detail: format!("this app's data directory could not be resolved: {e}"),
        })
    }
}

/* ── errors ───────────────────────────────────────────────────────────────────────────────────── */

/// Why an access command could not answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AccessError {
    /// An engine read failed; `detail` carries the engine's own words.
    Engine { detail: String },
    /// This platform has no folder-access flow at all (T17 is macOS only).
    Unsupported { detail: String },
    /// There is no managed engine copy to reveal — nothing has been installed yet.
    NoManagedEngine { detail: String },
    /// The opener refused or failed.
    Opener { detail: String },
    /// The app's own record could not be resolved or written.
    Store { detail: String },
    /// B8 (T16): the wizard's draft paths were refused before anything ran ([`checked_draft`]).
    InvalidDraft { detail: String },
}

/* ── the snapshot ─────────────────────────────────────────────────────────────────────────────── */

/// What the Schedule & Access panel needs in one answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessSnapshot {
    /// False off macOS. Every other field is then empty and the panel renders nothing at all —
    /// appendix T17: *"Assert non-macOS builds never show this step."*
    pub supported: bool,
    /// The protected roots this configuration reaches, with the engine's advice for each denied
    /// path under them. EMPTY means the grant flow is not needed.
    pub roots: Vec<RootInScope>,
    /// `doctor --json`'s verdict, verbatim (`ready` / `degraded` / `blocked`), or `null` when the
    /// envelope did not carry one.
    pub doctor_verdict: Option<String>,
    /// ⚠ TRUE WHEN DOCTOR'S REPO WALK HIT ITS DEADLINE, so `roots` is PARTIAL. Reported rather than
    /// hidden: a short list that looks complete is how a blocked repo becomes invisible.
    pub repos_timed_out: bool,
    /// True once a read of a protected root from THIS process has succeeded at least once.
    pub grant_observed: bool,
    /// Rust's own answer to "should the app read a protected root at launch" — [`probe_advice`].
    pub probe_advice: ProbeAdvice,
    /// Which root that launch-time read should use — the first in scope. `null` when
    /// `probeAdvice` is `none`.
    pub probe_root: Option<&'static str>,
    /// Whether this launch is on a different app version from the last.
    pub version_change: VersionChange,
    pub app_version: &'static str,
    /// The managed engine copy `schedule status --json` reports, for the guided reveal step's
    /// wording. `null` when nothing is installed. DISPLAY ONLY: [`access_reveal_engine`] re-reads
    /// it rather than taking it back.
    pub managed_engine_path: Option<String>,
    /// Non-fatal trouble: the config could not be read, the record could not be written, the
    /// schedule could not be read. The panel still works; it says what it could not do.
    pub notes: Vec<String>,
}

impl AccessSnapshot {
    /// The answer on a platform with no folder-access flow.
    pub fn unsupported(app_version: &'static str) -> Self {
        Self {
            supported: false,
            roots: Vec::new(),
            doctor_verdict: None,
            repos_timed_out: false,
            grant_observed: false,
            probe_advice: ProbeAdvice::None,
            probe_root: None,
            version_change: VersionChange::Same,
            app_version,
            managed_engine_path: None,
            notes: Vec::new(),
        }
    }
}

/// What one app-principal read found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub root: &'static str,
    /// The directory that was read, for the panel's wording.
    pub path: String,
    pub access: DirAccess,
    /// True when this read caused "grant observed" to be recorded for the first time.
    pub recorded: bool,
    /// Set when the record could not be written — the read still answered.
    pub note: Option<String>,
}

/* ── the engine reads ─────────────────────────────────────────────────────────────────────────── */

/// One read-only engine envelope, through the same client and the same 30 s timeout as the
/// watcher's reads. `pub(crate)`: B8's `cli_shim` reads `schedule status --json` the same way.
pub(crate) async fn read_envelope(client: &EngineClient, op: Operation) -> Result<Value, String> {
    let what = op.argv().join(" ");
    let outcome =
        match tokio::time::timeout(ENGINE_READ_TIMEOUT, client.invoke(op, &NoProgress)).await {
            Err(_) => return Err(format!("`{what}` did not answer in time and was stopped")),
            Ok(Err(e)) => return Err(e.to_string()),
            Ok(Ok(outcome)) => outcome,
        };
    let ok = matches!(
        outcome.outcome,
        Outcome::Delivered | Outcome::Skipped { .. }
    );
    match (ok, &outcome.payload) {
        (true, Some(payload)) => Ok(payload.clone()),
        _ => Err(failure_detail(&what, &outcome)),
    }
}

/// The engine's config text, as JSON, or why there is none. NOT an error for the caller: a machine
/// with no config yet has no protected roots configured either, which is a perfectly ordinary state
/// for this panel to be in.
async fn read_config(client: &EngineClient) -> Result<Value, String> {
    let paths = engine_paths(client).await?;
    let path = absolute(
        "status --json",
        "paths.configPath",
        paths.config_path.as_ref(),
    )?;
    let text = read_single_link_text_capped(&path, crate::config_save::MAX_CONFIG_BYTES)
        .map_err(|r| r.describe(&path, crate::config_save::MAX_CONFIG_BYTES))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

/* ── the commands ─────────────────────────────────────────────────────────────────────────────── */

/// The Schedule & Access panel's state — and the once-per-launch post-update check.
///
/// ⚠ IT WRITES ONE THING, AND IT IS NOT A SIDE EFFECT OF A READ BY ACCIDENT. `lastLaunchVersion` is
/// advanced to this build's version AFTER `versionChange` has been computed from the old value —
/// **unless doctor's repo walk timed out** (round 1): a timed-out walk leaves `roots` empty even
/// when protected roots are reachable, every display path for the post-update notice requires a
/// root in scope, and an advance on that call would consume the one `changed` answer on a snapshot
/// that could never show it. Deferring the write costs nothing — the next finished walk still
/// reports `changed` exactly once. That is the post-update check plan R1 keeps from T21: the FIRST
/// call after an update whose walk finished reports `changed`, every later one reports `same`.
/// (The webview does NOT keep the banner across snapshots: a manual Re-check replaces a `changed`
/// snapshot with a `same` one and the notice goes away — `launchActions` gates the launch-time
/// display, and that is the whole of the keeping.) Nothing else here writes.
///
/// ⚠ THREE ENGINE SPAWNS PER CALL — `status --json` (to locate the config), `doctor --json` (the
/// repo walk, up to 20 s) and `schedule status --json` (the managed copy's path). This is called on
/// mount and by the Re-check button, never on a timer, and it is NOT what the live `state:changed`
/// feed costs.
#[tauri::command]
pub async fn access_snapshot<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    access: State<'_, AccessState>,
    draft: Option<Vec<String>>,
) -> Result<AccessSnapshot, AccessError> {
    let version = env!("CARGO_PKG_VERSION");
    if !cfg!(target_os = "macos") {
        return Ok(AccessSnapshot::unsupported(version));
    }
    // B8 (T16): the wizard's not-yet-saved draft paths, unioned into scope so its folder-access
    // step can guide grants for a configuration that exists nowhere on disk yet ([`scope_of`]).
    // Bounded and character-checked BEFORE any engine spawn; absent everywhere else.
    let draft = draft.unwrap_or_default();
    checked_draft(&draft).map_err(|detail| AccessError::InvalidDraft { detail })?;
    let client = engine.client().map_err(|e| AccessError::Engine {
        detail: e.to_string(),
    })?;
    let mut notes: Vec<String> = Vec::new();

    let doctor = read_envelope(client, Operation::Doctor)
        .await
        .map_err(|detail| AccessError::Engine { detail })?;
    let config = match read_config(client).await {
        Ok(value) => Some(value),
        Err(detail) => {
            notes.push(format!(
                "The config could not be read, so only the folders the engine already reported are \
                 listed here: {detail}"
            ));
            None
        }
    };
    let managed_engine_path = match read_envelope(client, Operation::ScheduleStatus).await {
        Ok(value) => value
            .get("binPath")
            .and_then(Value::as_str)
            .map(str::to_string),
        Err(detail) => {
            notes.push(format!(
                "The background scheduler's own record could not be read, so the managed engine \
                 copy is not named below: {detail}"
            ));
            None
        }
    };

    let home = access.home();
    let roots = scope_of(
        &doctor,
        config.as_ref(),
        &draft,
        &home,
        case_insensitive_for("macos"),
    );
    let view: DoctorView = serde_json::from_value(doctor).unwrap_or(DoctorView {
        repos: Vec::new(),
        repos_timed_out: false,
        verdict: None,
    });

    let dir = access.store_dir(&app)?;
    let record = read_record(&dir);
    let version_change = version_change(record.last_launch_version.as_deref(), version);
    // ⚠ NOT ADVANCED WHILE THE WALK TIMED OUT — see the command docs above (round 1).
    if !view.repos_timed_out && record.last_launch_version.as_deref() != Some(version) {
        let next = AccessRecord {
            last_launch_version: Some(version.to_string()),
            ..record.clone()
        };
        if let Err(detail) = write_record(&dir, &next) {
            notes.push(format!(
                "This app's own access record could not be written, so the post-update check will \
                 run again next time: {detail}"
            ));
        }
    }

    let advice = probe_advice(!roots.is_empty(), record.app_principal_grant_observed);
    let probe_root = match advice {
        ProbeAdvice::None => None,
        ProbeAdvice::RevocationCheck => roots.first().map(|r| r.key),
    };

    Ok(AccessSnapshot {
        supported: true,
        roots,
        doctor_verdict: view.verdict,
        repos_timed_out: view.repos_timed_out,
        grant_observed: record.app_principal_grant_observed,
        probe_advice: advice,
        probe_root,
        version_change,
        app_version: version,
        managed_engine_path,
        notes,
    })
}

/// Read ONE protected root from this process — the app principal, and on macOS the system prompt's
/// trigger.
///
/// ⚠ THE OPERAND IS A [`ProtectedRoot`], NOT A PATH. The four members are the engine's own
/// `defaultProtectedRoots`, joined onto this process's `HOME` in Rust. There is no argument that
/// could name another directory.
///
/// ⚠ AND THIS IS THE ONE COMMAND WHOSE GATE IS NOT IN RUST. Plan R1 confines a launch-time read to
/// the revocation case ([`probe_advice`]); a read from the GUIDED flow is a read the user asked
/// for, and Rust cannot tell the two callers apart. The panel is what honours the rule, and
/// `gui/tests-web/access.check.ts` pins that the launch path calls this only when the snapshot's
/// `probeAdvice` says so.
///
/// Records "grant observed" on success. Never clears it on a denial: the record's job is to decide
/// whether a launch-time read is a revocation CHECK or an acquisition trigger, and a machine that
/// had a grant and lost it is still a machine where checking is the right thing to do.
#[tauri::command]
pub async fn access_probe<R: Runtime>(
    app: AppHandle<R>,
    access: State<'_, AccessState>,
    root: ProtectedRoot,
) -> Result<ProbeResult, AccessError> {
    if !cfg!(target_os = "macos") {
        return Err(AccessError::Unsupported {
            detail: "folder-access grants are a macOS feature; nothing here applies on this \
                     platform"
                .into(),
        });
    }
    let home = access.home();
    let path = root.path(&home);
    let dir_access = read_dir_access(&path);

    let dir = access.store_dir(&app)?;
    let record = read_record(&dir);
    let mut recorded = false;
    let mut note = None;
    if matches!(dir_access, DirAccess::Ok { .. }) && !record.app_principal_grant_observed {
        let next = AccessRecord {
            app_principal_grant_observed: true,
            ..record
        };
        match write_record(&dir, &next) {
            Ok(()) => recorded = true,
            Err(detail) => {
                note = Some(format!(
                    "The folder could be read, but this app could not remember that: {detail}"
                ))
            }
        }
    }

    Ok(ProbeResult {
        root: root.key(),
        path: path.to_string_lossy().into_owned(),
        access: dir_access,
        recorded,
        note,
    })
}

/// Reveal the MANAGED ENGINE COPY in Finder — the delegated principal's guided step.
///
/// ⚠ THE PATH COMES FROM THE ENGINE, NOT FROM THE WEBVIEW. `schedule status --json`'s `binPath` is
/// the copy `schedule install` made and signed (`src/schedule/install.ts`); this command re-reads
/// it rather than accepting the one the panel is displaying, so a stale or forged value cannot
/// reach `reveal_item_in_dir`. It must be absolute, and the answer is the path that was revealed so
/// the panel can say which file to drag.
#[tauri::command]
pub async fn access_reveal_engine(
    engine: State<'_, Engine>,
    access: State<'_, AccessState>,
) -> Result<String, AccessError> {
    let client = engine.client().map_err(|e| AccessError::Engine {
        detail: e.to_string(),
    })?;
    let envelope = read_envelope(client, Operation::ScheduleStatus)
        .await
        .map_err(|detail| AccessError::Engine { detail })?;
    // ⚠ THE ABSENT CASE IS CHECKED FIRST, and that order is the message. `absolute` refuses a
    // missing field too, but its wording ("`status --json` did not report …") would blame the
    // engine for a machine that simply has no schedule installed yet — the ordinary state before
    // the install step runs.
    let bin = match envelope.get("binPath").and_then(Value::as_str) {
        Some(value) => value.to_string(),
        None => {
            return Err(AccessError::NoManagedEngine {
                detail: "no background scheduler is installed yet, so there is no managed engine \
                         copy to reveal"
                    .into(),
            })
        }
    };
    let path = absolute("schedule status --json", "binPath", Some(&bin))
        .map_err(|detail| AccessError::Engine { detail })?;
    access
        .opener
        .reveal(&path)
        .map_err(|detail| AccessError::Opener { detail })?;
    Ok(path.to_string_lossy().into_owned())
}

/// Open one of three fixed System Settings deep links.
///
/// ⚠ NO URL CROSSES THE BOUNDARY. The operand is a [`SettingsPane`]; the URL is a `&'static str`
/// chosen here. The answer is the URL that was opened, so the panel can print it as the manual
/// fallback when the deep link does not land where it should — which is UNVERIFIED on macOS 26 (see
/// [`SETTINGS_FILES_AND_FOLDERS`]).
#[tauri::command]
pub async fn access_open_settings(
    access: State<'_, AccessState>,
    pane: SettingsPane,
) -> Result<String, AccessError> {
    if !cfg!(target_os = "macos") {
        return Err(AccessError::Unsupported {
            detail: "these System Settings panes are macOS's; there is nothing to open here".into(),
        });
    }
    let url = pane.url();
    access
        .opener
        .open_url(url)
        .map_err(|detail| AccessError::Opener { detail })?;
    Ok(url.to_string())
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &[
    "access_snapshot",
    "access_probe",
    "access_reveal_engine",
    "access_open_settings",
];
