//! The engine client — the ONLY code in this app that spawns the sidecar (T8), and the only place
//! the launchd environment is reproduced (T9).
//!
//! ## What changed, and why this module exists at all
//!
//! B1 shipped the seam as a `shell:allow-execute` capability: the webview called
//! `Command.sidecar(...)` and Tauri's shell scope decided which argv was allowed. That design was
//! MEASURED to have a ceiling — `tauri-plugin-shell` looks a sidecar's scope entry up with
//! `iter().find(|s| s.name == command_name)` and every sidecar entry necessarily shares one name,
//! so only the FIRST entry was ever consulted and the app could reach exactly one subcommand
//! (`status --json`). `capabilities/README.md` keeps the history note; the measurement itself is in
//! git history, in B1's `capabilities/default.json` and its `tests/capability_allowlist.rs` (which
//! this change renames to `tests/capability.rs` and rewrites).
//!
//! This module lifts that ceiling by moving the decision one layer in:
//!
//!   * **The webview has no shell access at all.** `tauri-plugin-shell` is not a dependency of this
//!     crate any more and is not registered on the builder; the capability grants no `shell:*`
//!     permission. The plugin also forwarded frontend-supplied `cwd` and `env` straight past the
//!     scope (`commands.rs:149-155`) — `DAILY_BRIEFING_STATE_DIR` and `XDG_CONFIG_HOME` are a second
//!     control channel into the engine — and that gap closes with it, because nothing the webview
//!     sends reaches the child's environment now.
//!   * **Argv is constructed here, in Rust, from [`Operation`]** — an enum that is exhaustive over
//!     the operations the app may perform: the engine surface minus `init` and `help`. A caller
//!     picks an operation; it never spells an argv.
//!   * **Each operation is one `#[tauri::command]`**, so `capabilities/default.json` names the
//!     operations the webview may invoke *individually*. One enum-taking command would have made
//!     "may read status" and "may generate a briefing" the same grant.
//!
//! ## The two caller-supplied strings, and where they are refused
//!
//! Only two operands are not fixed literals: `run --json-out <name>` and
//! `config validate --file <path>`. Both are parsed into newtypes ([`JsonOutName`],
//! [`ConfigFilePath`]) that cannot be constructed without passing the validator, so an
//! [`Operation`] carrying an unvalidated string is unrepresentable rather than merely unlikely.
//! `--json-out` is a port of the capability regex B1 measured, character class for character
//! class. `--file` is deliberately WIDER than B1's regex: that regex refused every directory the
//! engine and the app naturally use (`~/.config/…` for a dot-leading segment, `~/Library/Application
//! Support/…` for a space), and neither refusal had a threat model on this path — the argv is
//! handed to `execve` as a vector with no shell in between, and the engine reads the operand whole.
//! See [`json_out_name`] and [`config_file_path`], and `capabilities/README.md`.
//!
//! The invoker on `schedule install`/`uninstall` is NOT caller-supplied either: the commands pass
//! [`Invoker::App`] unconditionally. The engine's foreign-owner refusal keys on the record's
//! `invoker`, and a webview that could spell `--invoker cli` could forge that record. The Rust side
//! knows it is the app.
//!
//! ## What is deliberately NOT here (plan R1 deviations from gui-tauri T8)
//!
//!   * **No `runs.jsonl` journal.** R1 deleted that arm ("runs.jsonl arm deleted"). The appendix's
//!     T8 specifies an app-owned journal under `<appDataDir>`; there is none.
//!   * **No `run_scheduled()` / tick.** R1 defers the app-owned tick out of 0.2.0 — the OS
//!     scheduler is the only trigger. The appendix's launchd-equivalence contract (append the
//!     sidecar's stdout+stderr to `briefing.log` in launchd's order) belongs to that deferred arm
//!     and is not built, so this module never writes to `briefing.log`.
//!   * **No `init()`.** Settings (T15, B5) edits an EXISTING config through `config_save`, which
//!     validates with `config validate`; creating the first config is the wizard's (T16, B8) and
//!     its shape is not designed yet — an operation the UI cannot drive is a surface nobody
//!     reviewed (`docs/gui-seam.md` §10e).
//!   * **No `calendar`, no `update --check`.** R1's forward list carries both; the ENGINE does not
//!     (`src/main.ts`'s `KNOWN_COMMANDS` is `run | init | status | doctor | config | help |
//!     schedule`, and anything else exits 2). This enum is exhaustive over the operations the app
//!     may perform — the engine surface minus `init` and `help` — not over R1's forward list,
//!     because a typed operation that cannot run is a command that reports failure for a reason the
//!     user cannot act on.
//!
//! ## What B6 ADDED here, and the one thing that did not change
//!
//! `schedule verify` was in the list above until B6 (T20). The kickstart is still engine-side —
//! `schedule install` performs it as its last step (plan R1) — and that is exactly why a re-run
//! needs a surface: the Schedule & Access panel's post-install loop re-issues the SAME engine-side
//! kick rather than reaching for `launchctl`, so the app's exec surface stays engine-only.
//! [`Operation::ScheduleVerify`] is therefore `schedule verify --json`, and it is **mutating**: the
//! kick starts the live launchd/systemd job, which generates a briefing and stamps the day.
//!
//! Nothing else in this module moved. The spawn path, the environment plan
//! ([`EngineClient::env_plan`], [`FORWARDED_ENV`], [`launchd_path`]), the process-group kill and
//! both operand validators are untouched by B6.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

/* ── the operation surface ────────────────────────────────────────────────────────────────────── */

/// Who owns the OS schedule record — `schedule.json`'s `invoker` (`docs/gui-seam.md` §3).
///
/// Deliberately NOT `Deserialize`: no `#[tauri::command]` takes one, and without the derive none
/// can. The app always installs as [`Invoker::App`]; `Cli` exists so the enum is the engine's whole
/// vocabulary and the argv tests can spell both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invoker {
    App,
    Cli,
}

impl Invoker {
    fn as_str(self) -> &'static str {
        match self {
            Invoker::App => "app",
            Invoker::Cli => "cli",
        }
    }
}

/// Every engine invocation this app can make. Exhaustive over the operations the app may perform —
/// the engine surface minus `init` and `help` — as `src/main.ts` dispatches it today; see the
/// module header for what is deliberately absent and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Operation {
    /// `run --json [--force] [--json-out <name>]`.
    ///
    /// `--json` is unconditional: the app always wants the envelope on stdout. `--json-out` is
    /// additive (the engine writes the same envelope to a file and leaves stdout alone about it),
    /// not an alternative.
    Run {
        force: bool,
        json_out: Option<JsonOutName>,
    },
    /// `status --json` — a pure state-dir read. `--json` is REQUIRED; there is no human form.
    Status,
    /// `doctor --json` — preflight + capability probe. Exits 0 even when the verdict is `blocked`.
    Doctor,
    /// `config validate --json --file <path>` — validates a CANDIDATE config. Exits 0 whether or
    /// not the candidate is valid; validity is the payload.
    ConfigValidate { file: ConfigFilePath },
    /// `schedule install --invoker <who> [--take-over]`.
    ScheduleInstall { invoker: Invoker, take_over: bool },
    /// `schedule uninstall --invoker <who> [--take-over]`.
    ScheduleUninstall { invoker: Invoker, take_over: bool },
    /// `schedule status --json`.
    ScheduleStatus,
    /// `schedule verify --json` (T20) — re-issue the verification KICKSTART `schedule install`
    /// already performs as its last step, and report what evidence appeared.
    ///
    /// ⚠ MUTATING, AND THAT IS NOT A JUDGEMENT CALL. `verifySchedule` (`src/schedule/install.ts`)
    /// kicks the REGISTERED trigger — `launchctl kickstart` on macOS — so the live launchd job
    /// runs the engine, which may generate a briefing, write the archive and stamp the day. It
    /// looks like a read (it "checks" something) and is the most expensive write the app can
    /// issue; [`Operation::is_mutating`] says so and the in-flight guard holds it.
    ///
    /// ⚠ EXIT CODES ARE NOT THE USUAL ONES (`src/main.ts`, `verifyExitCode`): `0` evidence
    /// appeared that the kick reached the engine · `1` the kick was accepted and produced NO NEW
    /// evidence (inconclusive — including `already-delivered-before-kick`, which proves nothing) ·
    /// `3` the scheduler refused the kick. `2` is never used here, so [`Outcome::ConfigError`]
    /// cannot arise from it.
    ScheduleVerify,
}

impl Operation {
    /// The argv the engine receives, argv[0] excluded.
    ///
    /// ⚠ THE SUBCOMMAND IS ALWAYS FIRST. `src/main.ts` refuses `--json status` with exit 2, and
    /// before that guard existed it routed to `run` and discarded the token — so a panel polling
    /// every few seconds performed a full pipeline run and the first poll of the morning consumed
    /// the morning (`docs/gui-seam.md` §1). Nothing here accepts a caller-supplied leading flag;
    /// there is no argv position a caller can reach that is not an operand of a fixed flag.
    pub fn argv(&self) -> Vec<String> {
        let mut argv: Vec<String> = Vec::new();
        match self {
            Operation::Run { force, json_out } => {
                argv.push("run".into());
                argv.push("--json".into());
                if *force {
                    argv.push("--force".into());
                }
                if let Some(name) = json_out {
                    argv.push("--json-out".into());
                    argv.push(name.as_str().into());
                }
            }
            Operation::Status => {
                argv.push("status".into());
                argv.push("--json".into());
            }
            Operation::Doctor => {
                argv.push("doctor".into());
                argv.push("--json".into());
            }
            Operation::ConfigValidate { file } => {
                argv.push("config".into());
                argv.push("validate".into());
                argv.push("--json".into());
                argv.push("--file".into());
                argv.push(file.as_str().into());
            }
            Operation::ScheduleInstall { invoker, take_over } => {
                argv.push("schedule".into());
                argv.push("install".into());
                argv.push("--invoker".into());
                argv.push(invoker.as_str().into());
                if *take_over {
                    argv.push("--take-over".into());
                }
            }
            Operation::ScheduleUninstall { invoker, take_over } => {
                argv.push("schedule".into());
                argv.push("uninstall".into());
                argv.push("--invoker".into());
                argv.push(invoker.as_str().into());
                if *take_over {
                    argv.push("--take-over".into());
                }
            }
            Operation::ScheduleStatus => {
                argv.push("schedule".into());
                argv.push("status".into());
                argv.push("--json".into());
            }
            Operation::ScheduleVerify => {
                argv.push("schedule".into());
                argv.push("verify".into());
                argv.push("--json".into());
            }
        }
        argv
    }

    /// A short, stable name for logs, events and the [`EngineError::Busy`] message.
    pub fn name(&self) -> &'static str {
        match self {
            Operation::Run { .. } => "run",
            Operation::Status => "status",
            Operation::Doctor => "doctor",
            Operation::ConfigValidate { .. } => "config-validate",
            Operation::ScheduleInstall { .. } => "schedule-install",
            Operation::ScheduleUninstall { .. } => "schedule-uninstall",
            Operation::ScheduleStatus => "schedule-status",
            Operation::ScheduleVerify => "schedule-verify",
        }
    }

    /// Whether stdout is expected to be exactly one JSON document.
    ///
    /// ⚠ NOT A UNIVERSAL PROPERTY, which is the trap this method exists to avoid. `schedule
    /// install` and `schedule uninstall` have no `--json` form at all (`src/main.ts`: the flag is
    /// accepted on `schedule status` and `schedule verify` only) — they narrate on stdout.
    /// Treating a parse failure as [`Outcome::Failed`] for those would report every successful
    /// install as malformed output.
    pub fn expects_json(&self) -> bool {
        !matches!(
            self,
            Operation::ScheduleInstall { .. } | Operation::ScheduleUninstall { .. }
        )
    }

    /// Whether this operation can change state — a briefing, a day stamp, an OS schedule.
    ///
    /// This is what the in-flight guard keys on. It is deliberately NOT "every operation": the
    /// appendix's requirement is *one in-flight RUN*, and a `status` poll refused because a run is
    /// in flight would make a polling panel fail exactly when it has the most to show. What must
    /// never happen twice at once is a generation or a schedule mutation.
    ///
    /// ⚠ `ScheduleVerify` IS IN THIS SET ALTHOUGH ITS VERB READS LIKE A CHECK (T20). It kicks the
    /// registered trigger, so the engine runs under launchd and may deliver a briefing and stamp
    /// the day — a `schedule verify` racing a `Run Now` is two generations, which is the one thing
    /// this guard exists to prevent. `schedule status` remains a read and remains unguarded.
    pub fn is_mutating(&self) -> bool {
        matches!(
            self,
            Operation::Run { .. }
                | Operation::ScheduleInstall { .. }
                | Operation::ScheduleUninstall { .. }
                | Operation::ScheduleVerify
        )
    }
}

/* ── the two caller-supplied operands ─────────────────────────────────────────────────────────── */

/// Why an operand was refused. One variant per class, so a refusal is a fact the caller can act on
/// rather than "did not match a pattern".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputRefusal {
    /// The empty string, or an empty path segment (a `//` or a trailing `/`).
    Empty,
    /// A NUL byte. It would truncate the argv string at the syscall boundary.
    Nul,
    /// Whitespace. For `--json-out` that is ANY whitespace: a bare filename has no business
    /// containing one. For `--file` it is any whitespace OTHER THAN U+0020 — a plain space is a
    /// legitimate path character (`~/Library/Application Support/…`) and the argv is a vector, so
    /// nothing re-tokenises it; a tab, a newline or a NBSP in a path is still a value that reads
    /// as two on a log line.
    Whitespace,
    /// A control character (`char::is_control`) in a `--file` path. Nothing legitimate puts one
    /// in a filename, and it is what makes a terminal or a log render a different string from the
    /// one the syscall received. Checked AFTER [`InputRefusal::Whitespace`], so a tab or a newline
    /// — which is both — is reported as whitespace.
    ControlCharacter,
    /// A Unicode FORMAT character (general category `Cf`) — see [`REFUSED_FORMAT_CHARACTERS`] for
    /// the exact list and why it is a list. It is neither `char::is_control` (which is `Cc` only)
    /// nor `char::is_whitespace`, so it slipped past both of the checks above until this class
    /// existed; a bidi override is the same hazard they exist for, one layer up — it reorders how
    /// the path RENDERS without changing a byte of what `execve` receives. Checked AFTER those two
    /// so a tab or a newline keeps reporting its own class.
    FormatCharacter,
    /// A leading `-`. The value is spliced into an argv, so `-rf` or `--help` is a string that
    /// reads as a FLAG to whatever parses it next.
    LeadingDash,
    /// A path separator where a bare filename was required.
    Separator,
    /// A `--json-out` name starting with `.` — which is how `..` is excluded from a bare filename,
    /// and which also excludes a dotfile name, deliberately: the envelope lands in the engine's
    /// state directory and a hidden file there is not a thing anyone asked for.
    DotSegment,
    /// A `--file` path with a `.` or `..` segment — compared literally, so `.config` and `.local`
    /// are admitted while traversal is not.
    Traversal,
    /// A relative path where an absolute one was required.
    NotAbsolute,
    /// A `--json-out` character outside `[A-Za-z0-9._-]` that is not one of the classes above —
    /// notably not a [`InputRefusal::FormatCharacter`], which is split out of this class precisely
    /// because it is the invisible one.
    DisallowedCharacter,
    /// A segment longer than [`MAX_SEGMENT_CHARS`].
    SegmentTooLong,
    /// More than [`MAX_PATH_SEGMENTS`] segments.
    TooManySegments,
    /// A `--json-out` name that does not end in `.json`.
    NotJsonExtension,
    /// A `--json-out` name the ENGINE READS but does not refuse (B25 round-1 fix M4, measured):
    /// the engine's own `--json-out` guard (`src/json.ts`, `engineOwns`) derives its refusal list
    /// from `statePaths()`, and `transcript-health.json` — read and merged by `src/core.ts`
    /// (`emptyHealth()` spread, the §3.8 warning triggers) — has no `statePaths()` entry, so the
    /// engine ACCEPTS it and overwrites the whole health history with a run envelope (measured: 14
    /// seeded days → 0). Every OTHER engine-read state-dir `.json` is refused engine-side, which
    /// makes this an omission, not a design choice. The canonical fix is engine-side (a
    /// `transcriptHealthPath` in `statePaths()` + `engineOwns`'s `owned` list) and is registered
    /// as a Phase C follow-up (`docs/gui-seam.md` §16b dev 164 — the engine tree is read-only in
    /// B25); THIS refusal closes the app-reachable path (`engine_run_to_file`) now.
    EngineReadName,
}

impl InputRefusal {
    /// A sentence for the webview. Deliberately does NOT echo the offending value: the caller
    /// supplied it and already has it, and not round-tripping an attacker-influenceable string
    /// back into a render surface is free here.
    pub fn message(self) -> &'static str {
        match self {
            InputRefusal::Empty => "is empty (or has an empty path segment)",
            InputRefusal::Nul => "contains a NUL byte",
            InputRefusal::Whitespace => "contains whitespace",
            InputRefusal::ControlCharacter => "contains a control character",
            InputRefusal::FormatCharacter => {
                "contains a Unicode format character (category Cf — a bidi override, a zero-width \
                 space or joiner, or a byte-order mark)"
            }
            InputRefusal::LeadingDash => "starts with a dash, which reads as a flag in an argv",
            InputRefusal::Separator => "contains a path separator; a bare filename was required",
            InputRefusal::DotSegment => "starts with a dot",
            InputRefusal::Traversal => "has a `.` or `..` path segment",
            InputRefusal::NotAbsolute => "is not an absolute path",
            InputRefusal::DisallowedCharacter => "contains a character outside [A-Za-z0-9._-]",
            InputRefusal::SegmentTooLong => "has a path segment longer than 64 characters",
            InputRefusal::TooManySegments => "has more than 16 path segments",
            InputRefusal::NotJsonExtension => "does not end in .json",
            InputRefusal::EngineReadName => {
                "is transcript-health.json — a state file the engine reads (its health history), \
                 not a free envelope name; writing a run envelope there would destroy that history"
            }
        }
    }
}

/// The Unicode FORMAT characters (general category `Cf`) both operand validators refuse, as
/// inclusive ranges.
///
/// ⚠ **AN EXPLICIT LIST RATHER THAN A CRATE.** Rust's standard library has no `Cf` predicate:
/// `char::is_control` is `Cc` ONLY (33 code points) and `char::is_whitespace` is `White_Space`,
/// and MEASURED against this validator before the list existed, every character below was
/// ADMITTED — U+202E RIGHT-TO-LEFT OVERRIDE included. Getting the category from
/// `unicode-general-category` or `unicode-properties` would add a dependency, and its tables, to a
/// validator whose whole claim is that it is small enough to read.
///
/// ⚠ **THE LIST IS THE ACTIONABLE SUBSET OF `Cf`, NOT A BMP SUBSET** — and that distinction is the
/// round-3 correction. This paragraph used to justify stopping at the BMP with "most of them
/// plane-1 formatting nobody puts in a path", which was wrong twice over: U+FFF9–U+FFFB are BMP,
/// and the TAG CHARACTERS are plane-14 formatting that is precisely what someone puts in a path —
/// an invisible mirror of ASCII, the classic hidden-payload set. MEASURED against Python 3's
/// bundled UCD (16.0.0), the category is **170** code points; the ranges below refuse **123** of
/// them: the bidi controls and isolates, the zero-width spaces/joiners, the BOM, the soft hyphen,
/// the interlinear annotation marks, and the language tag plus its 96 tag characters.
///
/// The **47 still ADMITTED** are named, because "we did not get to it" is not a reason:
/// U+0600–U+0605, U+06DD, U+070F, U+0890–U+0891, U+08E2 (Arabic/Syriac number, footnote, ayah,
/// abbreviation and currency marks), U+110BD, U+110CD (Kaithi number signs), U+13430–U+1343F
/// (Egyptian hieroglyph format controls), U+1BCA0–U+1BCA3 (Duployan shorthand), U+1D173–U+1D17A
/// (musical beam/phrase marks) — scribal and notational marks that render as marks, and none of
/// which reorders or conceals the text around it. **U+206A–U+206F is the honest exception**:
/// deprecated since Unicode 5.1, still invisible, and admitted here only because it neither
/// reorders (the bidi controls do) nor joins (U+2060–U+2064 do), so it can pad a rendered path
/// but not make it read as a different one. Widening the list is a one-line diff with a test —
/// the same standard [`MAX_SEGMENT_CHARS`] is held to.
///
/// ⚠ **THIS IS ABOUT RENDERING, NOT ABOUT `execve`.** A format character cannot change which file
/// the engine opens. It is refused because the engine's own stderr echoes the path back — a failed
/// `config validate --file` prints `could not read ${path}` (`src/main.ts:773-787`) and the
/// engine's `stripControl` (`src/render.ts`) strips `[\x00-\x1f\x7f-\x9f]` only, so the bytes
/// survive — and that stderr reaches the webview verbatim, as `EngineOutcome.stderr` and as each
/// `ProgressEvent.line`. MEASURED end to end: `config validate --json --file /<U+202E>evil.json`
/// against the real sidecar exits 2 and writes the path verbatim TWICE to stderr.
pub const REFUSED_FORMAT_CHARACTERS: &[(char, char)] = &[
    ('\u{00AD}', '\u{00AD}'),   // SOFT HYPHEN
    ('\u{061C}', '\u{061C}'),   // ARABIC LETTER MARK
    ('\u{180E}', '\u{180E}'),   // MONGOLIAN VOWEL SEPARATOR
    ('\u{200B}', '\u{200F}'),   // ZERO WIDTH SPACE … RIGHT-TO-LEFT MARK (ZWSP/ZWNJ/ZWJ/LRM/RLM)
    ('\u{202A}', '\u{202E}'),   // LEFT-TO-RIGHT EMBEDDING … RIGHT-TO-LEFT OVERRIDE
    ('\u{2060}', '\u{2064}'),   // WORD JOINER … INVISIBLE PLUS
    ('\u{2066}', '\u{2069}'),   // LRI / RLI / FSI / POP DIRECTIONAL ISOLATE (U+2065 is unassigned)
    ('\u{FEFF}', '\u{FEFF}'),   // ZERO WIDTH NO-BREAK SPACE (byte-order mark)
    ('\u{FFF9}', '\u{FFFB}'),   // INTERLINEAR ANNOTATION ANCHOR / SEPARATOR / TERMINATOR
    ('\u{E0001}', '\u{E0001}'), // LANGUAGE TAG (deprecated)
    ('\u{E0020}', '\u{E007F}'), // TAG CHARACTERS: an invisible mirror of ASCII, plus CANCEL TAG
];

/// Whether `c` is one of [`REFUSED_FORMAT_CHARACTERS`].
pub fn is_refused_format_character(c: char) -> bool {
    REFUSED_FORMAT_CHARACTERS
        .iter()
        .any(|(lo, hi)| c >= *lo && c <= *hi)
}

/// The per-segment character ceiling, ported from the capability's `{0,63}` (a leading character
/// plus 63). Arbitrary-but-generous rather than principled — widen it deliberately, with a test.
/// Counted in `char`s, not bytes, so a non-ASCII segment is measured the way a user reads it.
pub const MAX_SEGMENT_CHARS: usize = 64;

/// The path-depth ceiling, ported from the capability's `(…/){0,15}` plus the final segment.
pub const MAX_PATH_SEGMENTS: usize = 16;

/// A validated `run --json-out` operand: a BARE FILENAME ending in `.json`.
///
/// Ported from the capability validator `[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json`. No separator can
/// appear, so traversal is unreachable here rather than merely caught later by the engine's own
/// `resolveJsonOutPath` guard (`src/json.ts`); a relative name resolves under the engine's state
/// directory, and the engine additionally refuses names it owns (`briefing.log`, `last-run`, …) —
/// with one measured gap, `transcript-health.json`, refused HERE instead
/// ([`InputRefusal::EngineReadName`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonOutName(String);

impl JsonOutName {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A validated `config validate --file` operand: an ABSOLUTE path with no empty, `.` or `..`
/// segment, no NUL, no control character, no Unicode format character
/// ([`REFUSED_FORMAT_CHARACTERS`]), no whitespace other than U+0020, at most
/// [`MAX_PATH_SEGMENTS`] segments of at most [`MAX_SEGMENT_CHARS`] characters each.
///
/// ⚠ DELIBERATELY WIDER THAN THE CAPABILITY REGEX IT REPLACES
/// (`/([A-Za-z0-9_-][A-Za-z0-9._-]{0,63}/){0,15}[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}`). That regex
/// refused a dot-leading segment (to exclude `..` without lookahead) and every character outside
/// its ASCII class (whitespace included) — which refused `$HOME/.config/daily-briefing/config.json`,
/// the engine's own default config path, and everything under `~/Library/Application Support/`,
/// which is both the engine's state directory and Tauri's `app_data_dir`. Neither refusal was a
/// security control: the value is one element of the argv VECTOR `tokio::process::Command` hands
/// to `execve` (see [`EngineClient::invoke`] — there is no shell to re-tokenise a space), the
/// engine reads the operand whole (`src/main.ts`, `readCandidate`: `Bun.file(path).text()`), and a
/// symlink walks through a `..` rule anyway. What is still refused is what can change the string
/// between the caller and the syscall (NUL), make a log line lie about it (control characters,
/// non-space whitespace, and — since round 2 — Unicode format characters: a bidi override is
/// neither control nor whitespace and reorders how the path renders, and the engine's OWN stderr
/// echoes the path back verbatim, so this is a live surface rather than a hypothetical one; see
/// [`REFUSED_FORMAT_CHARACTERS`] for the measurement), or is not a candidate file's path at all
/// (relative, empty segment, traversal, the two ceilings).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigFilePath(String);

impl ConfigFilePath {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The `--json-out` preamble, before anything shape-specific: empty, NUL, and ANY whitespace. A
/// bare filename has no legitimate whitespace in it. (`--file` does its own preamble inline —
/// it admits U+0020 — see [`config_file_path`].)
fn reject_argv_hazards(value: &str) -> Result<(), InputRefusal> {
    if value.is_empty() {
        return Err(InputRefusal::Empty);
    }
    if value.contains('\0') {
        return Err(InputRefusal::Nul);
    }
    // `char::is_whitespace` rather than `is_ascii_whitespace`: U+00A0 and friends are just as
    // capable of hiding a second token from a human reading a log line.
    if value.chars().any(char::is_whitespace) {
        return Err(InputRefusal::Whitespace);
    }
    Ok(())
}

/// Classify a character that is not an allowed *interior* character, so every refusal names its
/// own class instead of collapsing to "disallowed".
fn classify_bad_char(c: char) -> InputRefusal {
    match c {
        '/' | '\\' => InputRefusal::Separator,
        '-' => InputRefusal::LeadingDash,
        '.' => InputRefusal::DotSegment,
        // `--json-out` already refused every one of these as "outside [A-Za-z0-9._-]", so this
        // changes no verdict — only the reason. It is the one refusal class whose offending
        // character is INVISIBLE, which is exactly when "contains a disallowed character" leaves
        // the caller with nothing to look for.
        c if is_refused_format_character(c) => InputRefusal::FormatCharacter,
        _ => InputRefusal::DisallowedCharacter,
    }
}

/// Parse a `--json-out` operand, or say exactly why not.
pub fn json_out_name(value: &str) -> Result<JsonOutName, InputRefusal> {
    reject_argv_hazards(value)?;
    // The `.json` suffix must be TERMINAL — `out.json.exe` is not a JSON envelope name.
    let stem = value
        .strip_suffix(".json")
        .ok_or(InputRefusal::NotJsonExtension)?;
    let mut chars = stem.chars();
    let first = chars.next().ok_or(InputRefusal::Empty)?;
    if !first.is_ascii_alphanumeric() {
        return Err(classify_bad_char(first));
    }
    // 1 leading character + `{0,63}`, exactly as the capability spells it.
    if stem.chars().count() > MAX_SEGMENT_CHARS {
        return Err(InputRefusal::SegmentTooLong);
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
            return Err(classify_bad_char(c));
        }
    }
    // ⚠ THE ASYMMETRY THIS GUARDS (B25 round-1 fix M4): the engine refuses `--json-out` names it
    // OWNS (`briefing.log`, `last-run`, `account-state.json`, …) but its refusal list is derived
    // from `statePaths()`, and `transcript-health.json` — a file the engine READS on every run —
    // has no entry there, so the engine accepts it and clobbers its own health history. Refused
    // HERE, exactly, until the engine-side list gains the entry (Phase C follow-up, `docs/
    // gui-seam.md` §16b dev 164). See [`InputRefusal::EngineReadName`] for the measurement.
    // ASCII-case-insensitive: the default APFS volume is case-INSENSITIVE, so
    // `Transcript-Health.json` opens the same file the exact spelling would clobber.
    if value.eq_ignore_ascii_case("transcript-health.json") {
        return Err(InputRefusal::EngineReadName);
    }
    Ok(JsonOutName(value.to_string()))
}

/// Parse a `--file` operand, or say exactly why not. See [`ConfigFilePath`] for what is refused and
/// why the shape is wider than `--json-out`'s.
pub fn config_file_path(value: &str) -> Result<ConfigFilePath, InputRefusal> {
    if value.is_empty() {
        return Err(InputRefusal::Empty);
    }
    if value.contains('\0') {
        return Err(InputRefusal::Nul);
    }
    // U+0020 is admitted; every other whitespace character is not. Checked before the control
    // check so that a tab or a newline — both — is reported as the class a reader expects.
    if value.chars().any(|c| c.is_whitespace() && c != ' ') {
        return Err(InputRefusal::Whitespace);
    }
    if value.chars().any(char::is_control) {
        return Err(InputRefusal::ControlCharacter);
    }
    // Checked LAST of the three character classes, so a character that is also whitespace or a
    // control reports the class a reader expects. See [`REFUSED_FORMAT_CHARACTERS`].
    if value.chars().any(is_refused_format_character) {
        return Err(InputRefusal::FormatCharacter);
    }
    let rest = value.strip_prefix('/').ok_or(InputRefusal::NotAbsolute)?;
    let segments: Vec<&str> = rest.split('/').collect();
    if segments.len() > MAX_PATH_SEGMENTS {
        return Err(InputRefusal::TooManySegments);
    }
    for segment in segments {
        if segment.is_empty() {
            return Err(InputRefusal::Empty);
        }
        // An explicit comparison, which the hand-written validator can express and the regex
        // could not: `.` and `..` are refused, `.config` and `.local` are admitted.
        if segment == "." || segment == ".." {
            return Err(InputRefusal::Traversal);
        }
        if segment.chars().count() > MAX_SEGMENT_CHARS {
            return Err(InputRefusal::SegmentTooLong);
        }
    }
    Ok(ConfigFilePath(value.to_string()))
}

/* ── T9: the launchd environment, reproduced ──────────────────────────────────────────────────── */

/// The PATH the engine's own launchd generator puts in the plist, reproduced for every spawn this
/// app makes.
///
/// ⚠ WHY THIS EXISTS AT ALL, and why it will not reproduce in development. A GUI app launched from
/// Finder or as a login item gets a MINIMAL environment, not the user's interactive shell PATH — so
/// the sidecar would fail to find `claude`/`codex` and every morning would end in a
/// missing-binary ProviderError with a confusing message. `cargo tauri dev` inherits the
/// developer's shell PATH and hides it completely. This only shows up for the stranger, which is
/// the whole audience.
///
/// ⚠ THE SOURCE OF TRUTH IS `src/schedule/install.ts`, NOT `scripts/install.sh`. The appendix cites
/// `install.sh:82`; that line is GONE — A2 deleted the checked-in plist template and the `sed` that
/// filled it, and moved unit generation into the engine (`scripts/install.sh`'s "THE PLIST HALF IS
/// DELEGATED TO THE BINARY" note). The value now lives in `installSchedule`'s `ScheduleOpts`
/// (`src/schedule/install.ts`, the `pathEnv:` line), which `src/schedule/units.ts` writes into the
/// plist's `EnvironmentVariables`. `tests/engine_env.rs` parses that line at test time and compares
/// it to this function character for character, so the two cannot diverge silently.
pub fn launchd_path(home: &Path) -> String {
    let local_bin = home.join(".local").join("bin");
    format!(
        "{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        local_bin.display()
    )
}

/// The variables forwarded from the app's own environment, when present.
///
/// Everything else is dropped, PATH included — PATH is always [`launchd_path`] (or an explicit
/// override), never inherited, and `path_is_never_inherited` pins that. This list is the small set
/// a launchd-started process also receives from the user's session: the engine resolves its state
/// directory from `HOME` (`src/marker.ts`), git reads `HOME` for its config, and the rest are
/// locale/temp conveniences that cost nothing and whose absence produces confusing failures.
pub const FORWARDED_ENV: &[&str] = &["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TZ"];

/// The idle-sleep guard the plist wraps the engine in: `/usr/bin/caffeinate -i <bin> run`
/// (`src/schedule/units.ts`, `launchdPlist`).
///
/// R1 grafts this onto ALL app spawns, not only scheduled ones ("PATH parity + caffeinate on app
/// spawns"): a user-clicked run makes the same 30-120s provider call, and a machine that idles to
/// sleep halfway through loses it just as thoroughly.
///
/// ⚠ THE PROCESS TOPOLOGY IS NOT WHAT THE COMMAND LINE SUGGESTS. `caffeinate -i <utility>` does
/// not run the utility as its child: it forks, the CHILD becomes the assertion holder (the
/// `/usr/bin/caffeinate` you see in `ps`), and the ORIGINAL pid `exec`s the utility. MEASURED: the
/// pid returned by the spawn is the sidecar itself, and `/usr/bin/caffeinate -i …` is a child of
/// it. So killing the spawned PID kills the sidecar and the caffeinate child exits with its parent
/// — but the sidecar's own children (git, the provider CLI, an `apiKeyCommand` helper) are not
/// reached by a signal to that one pid, and used to be left to pid 1. A signal to the process
/// GROUP reaches all of them, the assertion holder included, since it is the sidecar's child: that
/// is what `ProcessGroupKill` sends and why every spawn here gets a group of its own. (Named in
/// plain backticks, not linked: that type is `#[cfg(unix)]` and this constant is not, so an
/// intra-doc link here is a `broken_intra_doc_links` warning on a non-unix doc build.)
pub const CAFFEINATE: &str = "/usr/bin/caffeinate";

/* ── the outcome ──────────────────────────────────────────────────────────────────────────────── */

/// What the engine's exit code meant, classified.
///
/// ⚠ `Delivered` IS WIDER THAN THE WORD SUGGESTS, stated here rather than left to be inferred. For
/// [`Operation::Run`] it means what it says — the envelope's `delivered` is true. For every other
/// operation it means "exit 0, here is the payload": `status` delivers a report, not a briefing.
/// The alternative was a second success variant that every caller would have to handle identically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    /// Exit 0, and (for `run`) the envelope says a briefing was delivered.
    Delivered,
    /// Exit 0 and the envelope says `delivered: false`. `reason` is the envelope's `skipReason`
    /// verbatim — one of `src/json.ts`'s `SKIP_REASONS`, never a string invented here.
    Skipped { reason: Option<String> },
    /// Exit 1, any other non-zero exit, a signal, or output that should have been JSON and was not.
    /// The raw stdout and stderr are retained on [`EngineOutcome`]; nothing is discarded and
    /// nothing panics.
    Failed { reason: Option<String> },
    /// Exit 2 — the engine's refusal code: a bad config, a bad flag, a foreign schedule owner, or a
    /// required confirmation withheld (`docs/gui-seam.md` §3). The stderr text is what explains
    /// which, and it is surfaced verbatim.
    ConfigError,
}

/// One completed invocation. The classification is the small part; the raw material always
/// survives beside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineOutcome {
    /// Which operation produced this, by [`Operation::name`].
    pub operation: String,
    pub outcome: Outcome,
    /// `None` when the child was killed by a signal — serialised as `null`, never a fabricated -1.
    pub exit_code: Option<i32>,
    /// The parsed JSON envelope, when the operation produces one and it parsed.
    pub payload: Option<serde_json::Value>,
    /// Everything the engine wrote to stdout, verbatim.
    pub stdout: String,
    /// Everything the engine wrote to stderr, verbatim — the same bytes the progress channel
    /// carried, kept so a caller that missed the events still has them.
    pub stderr: String,
}

/// Every way an invocation can fail before or around the engine, as opposed to *in* it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EngineError {
    /// A caller-supplied operand was refused. **No spawn happened.**
    InvalidInput { field: String, reason: String },
    /// Another state-changing invocation is already in flight in this process. A typed refusal, not
    /// a queue: a second briefing generation must not be *delayed* into happening, it must not
    /// happen.
    Busy { running: String },
    /// The bundled sidecar could not be located beside the executable.
    SidecarUnresolved { detail: String },
    /// The process could not be spawned, or died in a way the OS reported rather than the engine.
    Spawn { detail: String },
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::InvalidInput { field, reason } => write!(f, "{field} {reason}"),
            EngineError::Busy { running } => {
                write!(f, "an engine {running} is already running")
            }
            EngineError::SidecarUnresolved { detail } => {
                write!(f, "could not locate the bundled engine: {detail}")
            }
            EngineError::Spawn { detail } => write!(f, "could not run the engine: {detail}"),
        }
    }
}

impl std::error::Error for EngineError {}

/* ── the in-flight guard ──────────────────────────────────────────────────────────────────────── */

/// The name of the state-changing operation currently in flight, if any.
///
/// A `std::sync::Mutex` held only across the swap — never across an await — rather than an async
/// mutex, because the whole point is that a second caller is REFUSED rather than parked.
static IN_FLIGHT: Mutex<Option<&'static str>> = Mutex::new(None);

/// RAII: the slot is cleared on every exit path, including a dropped future.
///
/// ⚠ A COMMAND FUTURE IS NEVER DROPPED MID-FLIGHT; ONE CALLER'S IS. A `#[tauri::command] async fn`
/// body runs detached on Tauri's runtime — `respond_async_serialized` hands it to
/// `crate::async_runtime::spawn` (tauri `src/ipc/mod.rs`, via the macro's wrapper) — so a webview
/// that navigates away does not cancel it, and app exit (`AppHandle::exit`, after which tauri's
/// `App::run` ends the process with `std::process::exit`, `src/app.rs`) drops nothing. There is no
/// cancel command. The one shipped caller that DOES drop an invocation is `shell::EngineSnapshots`,
/// whose 30 s read timeout abandons a hung `status`/`schedule status` — a read, which this guard
/// never holds (`is_mutating` is false for both). The guard still clears on drop because a guard
/// that could wedge closed is worse than one whose drop path is rarely taken.
///
/// The guard remembers which operation it holds and clears the slot only if that is still what is
/// there — so a guard whose slot was somehow taken over by a later holder cannot release the later
/// holder's turn on its way out.
struct InFlight {
    name: &'static str,
}

impl InFlight {
    fn try_acquire(op: &Operation) -> Result<Option<Self>, EngineError> {
        if !op.is_mutating() {
            return Ok(None);
        }
        let mut slot = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        match *slot {
            Some(running) => Err(EngineError::Busy {
                running: running.to_string(),
            }),
            None => {
                let name = op.name();
                *slot = Some(name);
                Ok(Some(InFlight { name }))
            }
        }
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        let mut slot = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        if *slot == Some(self.name) {
            *slot = None;
        }
    }
}

/* ── the process-group kill ───────────────────────────────────────────────────────────────────── */

/// RAII: SIGKILLs the child's whole PROCESS GROUP when an abandoned invocation drops it.
///
/// ⚠ WHY A GROUP AND NOT THE SPAWNED PID. `kill_on_drop` signals the pid tokio spawned and nothing
/// else. Under `caffeinate -i` that pid IS the sidecar (see [`CAFFEINATE`]), so the sidecar does
/// die — but a `launchctl list` the sidecar forked is re-parented to pid 1 and runs on. MEASURED
/// before this guard existed, with a fake sidecar that forks rather than `exec`s: the read timed
/// out, the sidecar's pid was gone, its `sleep 41` child was still running.
/// [`EngineClient::invoke`] therefore spawns into a NEW process group and this guard signals the
/// GROUP, which reaches the sidecar, the `caffeinate` assertion holder (the sidecar's own child),
/// and anything else the sidecar started that is still in the group when the drop happens.
///
/// That last qualifier is the honest boundary and it is not a loophole: a drop can only occur
/// while the invocation is still in flight, which means the sidecar has not exited or something
/// holding its pipes has not. A descendant that outlives BOTH — the sidecar gone, its own stdio
/// elsewhere — ends the invocation normally instead, and a normal end deliberately leaves it
/// alone (below).
///
/// ⚠ WHAT MAKES THE SIGNAL SAFE, spelled out because a `killpg` at the wrong id is a SIGKILL to
/// every process in a group this app never created:
///
///   * **The id is the child's own pid.** `process_group(0)` is `setpgid(0, 0)` in the child, so
///     the group's id and the child's pid are one number, and the group holds only this spawn's
///     own descendants.
///   * **That pid cannot have been recycled while the guard is armed**, because the armed window
///     and the un-reaped window are made to be the same window. A pid — hence the group id that
///     equals it — is not reused while the process is still a zombie awaiting its reaper, and
///     `wait()` is what reaps it. So [`EngineClient::invoke`] drains both pipes FIRST and calls
///     `wait()` afterwards, disarming on its return: the child stays un-reaped for as long as
///     anything it started still holds a pipe open. See the comment above that `wait()` for why
///     the obvious ordering — all three in one `join!` — cannot have both this property and the
///     one below. **The `wait()` error paths split**: `ECHILD` means some other reaper took the
///     child, so the pid MAY be free — certainly free only if the group is empty too, which cannot
///     be tested without a race — and the guard gives the group up rather than risk a recycled id.
///     Any OTHER error leaves the child's state genuinely unknown (it may still be running) and
///     keeps the guard armed. The residual on the `ECHILD` path is `kill_on_drop`'s `kill(pid)`,
///     one process wide where this guard is a whole group wide — not the same exposure, which is
///     why the two are treated differently.
///   * **Two ids are refused outright**: anything `<= 1`, and this process's own group whatever
///     its number. MEASURED, because the obvious reading of the first one is wrong and far too
///     reassuring: `killpg(p, s)` is `kill(-p, s)`, so `killpg(1, …)` is `kill(-1, …)` — the
///     BROADCAST form, every process this uid owns, not "init's group". (`killpg(1, 0)` and
///     `kill(1, 0)` both return `EPERM`, and `killpg(-1, 0)` returns `EPERM` where a real empty
///     group returns `ESRCH`.) And `0` means *this process's own group*. So the refusals stand
///     between a mistake here and, respectively, every process the user owns and this app's own
///     group — the app, or the test runner.
///
/// ⚠ A NORMAL EXIT IS NOT A DROP. The guard is disarmed on a completed `wait()`, so an engine run
/// that deliberately left something behind is left alone; only an ABANDONED invocation takes its
/// group with it. The one shipped caller that abandons one is `shell::EngineSnapshots`'s read
/// timeout (`shell::ENGINE_READ_TIMEOUT`).
///
/// ⚠ AND THE SIGNAL IS `SIGKILL`, WITH NO `SIGTERM` GRACE — a deliberate choice, and one NO TEST
/// PINS: swapping it for `SIGTERM` reddens nothing, because every fake in the suite dies on either.
/// Stated here rather than left to read as covered, on the same footing as
/// [`ProcessGroupKill::is_signalable`]'s refusals. A descendant is therefore killed mid-write —
/// a `git` left with an `index.lock`, a helper interrupted between `tmp` and rename. That is a
/// property of the mechanism rather than a cost the app pays today: the only shipped drop is the
/// read timeout, and the two read operations fork nothing worse than read-only probes
/// (`status --json` is file reads; `schedule status` shells out to `launchctl list` on macOS and
/// `systemctl is-enabled` / `loginctl show-user` on Linux — this guard is unix-wide, not
/// macOS-only, so the inventory has to be too). It would start
/// costing that the moment a MUTATING invocation became droppable. Under the old single-pid kill
/// descendants were spared only by being orphaned, which is the thing this closes, and a hung read
/// leaving a live `launchctl` behind was judged the worse of the two.
///
/// `pub` for one reason: [`ProcessGroupKill::is_signalable`] is the refusal that stands between a
/// mistake here and a SIGKILL to the app's own group, the two ids it rejects cannot be provoked
/// through [`EngineClient::invoke`] without killing the test runner, and the test that pins them
/// (`tests/engine_client.rs`) is a separate crate. Nothing constructs this outside
/// [`EngineClient::invoke`]. (The prose references elsewhere — `shell::ENGINE_READ_TIMEOUT`,
/// `docs/gui-seam.md` §6/§8/§9 — are plain backticks and would resolve to a private item just as
/// well; they are not a reason.)
#[cfg(unix)]
pub struct ProcessGroupKill {
    /// The group to signal — `None` once disarmed, and `None` when no id could be established that
    /// passes [`ProcessGroupKill::is_signalable`].
    pgid: Option<libc::pid_t>,
}

#[cfg(unix)]
impl ProcessGroupKill {
    /// Arm over `child`'s process group.
    ///
    /// `child.id()` is `None` only once the child has been reaped, which cannot be the case here —
    /// this runs immediately after `spawn`. (It is emphatically NOT true in general that a reaped
    /// child means nothing left to signal: a reaped sidecar whose forked `launchctl` is still
    /// running is the exact case this guard exists for. That is why [`EngineClient::invoke`] is
    /// careful about WHEN the reaping happens.)
    ///
    /// ⚠ THE ID IS A PID, AND ONLY `process_group(0)` MAKES IT A GROUP ID. [`Self::is_signalable`]
    /// cannot tell the difference, so removing that one line in [`EngineClient::invoke`] would
    /// leave this signalling a plain pid interpreted as a group. What catches that is behavioural,
    /// not structural: `tests/watcher.rs`'s
    /// `a_timed_out_read_kills_the_sidecar_and_the_children_it_forked` asserts the sidecar's own
    /// pgid EQUALS its pid, and that the forked child dies — both of which fail without the group.
    fn arm(child: &tokio::process::Child) -> Self {
        Self {
            pgid: child
                .id()
                .and_then(|pid| libc::pid_t::try_from(pid).ok())
                .filter(|pgid| Self::is_signalable(*pgid)),
        }
    }

    /// Whether `pgid` is an id this process may SIGKILL — the refusals in the struct docs, and the
    /// reason the struct is `pub`.
    ///
    /// ⚠ THE TEST THAT PINS THIS PINS THE PREDICATE, NOT ITS WIRING, and the gap is disclosed
    /// rather than papered over: deleting the `.filter(…)` in [`Self::arm`] leaves the whole suite
    /// green, because neither refused id is reachable through [`EngineClient::invoke`] — a spawned
    /// child's pid can be neither `<= 1` nor equal to its parent's process group, which is pinned
    /// for as long as this process is a member of it (a process-group id is reserved for the
    /// group's LIFETIME, not its leader's — an orphaned group whose leader died still holds its
    /// number). That unreachability is the whole reason this predicate is defence against a FUTURE
    /// second construction site, and it is why a behavioural test for it cannot exist without
    /// inventing one.
    pub fn is_signalable(pgid: libc::pid_t) -> bool {
        // SAFETY: `getpgrp` takes no arguments, dereferences nothing, and is defined to succeed.
        let own = unsafe { libc::getpgrp() };
        pgid > 1 && pgid != own
    }

    /// Give up the group: the child exited on its own terms.
    fn disarm(&mut self) {
        self.pgid = None;
    }
}

#[cfg(unix)]
impl Drop for ProcessGroupKill {
    fn drop(&mut self) {
        if let Some(pgid) = self.pgid {
            // SAFETY: `killpg` takes two integers, dereferences nothing, and cannot invalidate
            // anything Rust owns. Why this id is the right one, and why it cannot have been
            // recycled, is the struct's doc comment.
            //
            // The return value is deliberately ignored, and the errnos are MEASURED rather than
            // guessed — `ESRCH` is the obvious guess and is the one that essentially cannot happen
            // here. While the guard is armed the child is by construction un-reaped, so the group
            // always still has a member: the outcome is `0` when something in it was signalled, and
            // `EPERM` on macOS when the only member left is the zombie leader (measured: zombie-only
            // group → EPERM; the same id after reaping → ESRCH; a live member → 0). `ESRCH` would
            // mean the child had already been reaped, which is the state this guard disarms in. All
            // are benign and a drop has no one to report to — but a future
            // `if errno != ESRCH { log }` would fire on every ordinary timeout.
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
    }
}

/* ── the progress channel ─────────────────────────────────────────────────────────────────────── */

/// Where a stderr line goes while the engine is still running.
///
/// ⚠ STDERR ONLY, and VERBATIM. The engine's diagnostics are the user-facing explanation of what
/// it is doing and why it stopped; paraphrasing them in the shell would mean maintaining a second,
/// worse copy of every message. Stdout is not streamed: for the JSON operations it is one envelope
/// that means nothing until it is complete, and for the others it is narration the caller gets in
/// [`EngineOutcome::stdout`] anyway.
pub trait ProgressSink: Send + Sync {
    fn stderr_line(&self, operation: &str, line: &str);
}

/// A sink that drops everything — the read-only operations, and any caller that does not want the
/// events.
pub struct NoProgress;

impl ProgressSink for NoProgress {
    fn stderr_line(&self, _operation: &str, _line: &str) {}
}

/// The payload of an `engine:progress` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub operation: String,
    /// One stderr line, with its terminator removed and nothing else changed.
    pub line: String,
}

/// The shipping sink: emits `engine:progress` to the webview.
pub struct AppProgress<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> AppProgress<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> ProgressSink for AppProgress<R> {
    fn stderr_line(&self, operation: &str, line: &str) {
        // A failed emit is not a reason to fail the run: the briefing matters, the progress line
        // does not. The line still reaches the caller in `EngineOutcome::stderr`.
        let _ = self.app.emit(
            "engine:progress",
            ProgressEvent {
                operation: operation.to_string(),
                line: line.to_string(),
            },
        );
    }
}

/* ── the client ───────────────────────────────────────────────────────────────────────────────── */

/// The sidecar, and the environment it is spawned into.
///
/// ⚠ THE PROGRAM IS NEVER CALLER-SUPPLIED. [`EngineClient::bundled`] resolves it from the
/// executable's own directory; [`EngineClient::with_program`] exists for the test harness. No
/// `#[tauri::command]` in this module takes a program, a path to one, an environment, or a working
/// directory — which is the property the shell plugin could not give us (it forwarded frontend
/// `cwd` and `env` straight to the child).
#[derive(Debug, Clone)]
pub struct EngineClient {
    program: PathBuf,
    path_env: Option<String>,
    caffeinate: PathBuf,
    extra_env: Vec<(OsString, OsString)>,
}

impl EngineClient {
    /// The bundled sidecar, resolved the way `tauri-plugin-shell` resolves it.
    pub fn bundled() -> Result<Self, EngineError> {
        Ok(Self::with_program(bundled_sidecar_path()?))
    }

    /// A client over an explicit program. **Test harness only** — see the struct docs.
    pub fn with_program(program: PathBuf) -> Self {
        Self {
            program,
            path_env: None,
            caffeinate: PathBuf::from(CAFFEINATE),
            extra_env: Vec::new(),
        }
    }

    /// Override the PATH applied to every spawn.
    ///
    /// No Settings field feeds this: B5's T15 writes the engine's USER config only (plan R1), and the
    /// spawn PATH is an app setting (`docs/gui-seam.md` §10g, deviation 51). The parameter exists
    /// so a later field is a wiring change rather than a redesign, and so a test can assert an
    /// override is honoured.
    pub fn with_path_override(mut self, path: impl Into<String>) -> Self {
        self.path_env = Some(path.into());
        self
    }

    /// Point the caffeinate wrapper somewhere else. **Test harness only**: it is what lets a test
    /// exercise the missing-caffeinate fallback without removing a system binary.
    pub fn with_caffeinate_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.caffeinate = path.into();
        self
    }

    /// Add one environment variable to the child. **Test harness only** — this is how a test
    /// points the engine at a sandbox (`DAILY_BRIEFING_STATE_DIR`, `XDG_CONFIG_HOME`). Nothing the
    /// webview sends reaches here.
    pub fn with_env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.extra_env.push((key.into(), value.into()));
        self
    }

    /// The program that is actually executed, and the argv it receives — caffeinate wrapping
    /// included. Split out of [`EngineClient::invoke`] so a test can assert the composition
    /// without spawning anything.
    pub fn command_line(&self, op: &Operation) -> (PathBuf, Vec<String>) {
        let argv = op.argv();
        if cfg!(target_os = "macos") {
            if self.caffeinate.exists() {
                let mut wrapped = Vec::with_capacity(argv.len() + 2);
                wrapped.push("-i".to_string());
                wrapped.push(self.program.to_string_lossy().into_owned());
                wrapped.extend(argv);
                return (self.caffeinate.clone(), wrapped);
            }
            // ⚠ FALL BACK, NEVER FAIL. A machine without `/usr/bin/caffeinate` can still produce a
            // briefing; it just might idle to sleep during a long provider call. Refusing to run
            // would turn a degradation into an outage.
            eprintln!(
                "daily-briefing: {} is missing — spawning the engine directly. A long provider \
                 call may be interrupted by idle sleep.",
                self.caffeinate.display()
            );
        }
        (self.program.clone(), argv)
    }

    /// The environment the child gets: cleared, then [`FORWARDED_ENV`] from this process, then
    /// PATH, then the harness overrides.
    ///
    /// ⚠ PATH IS SET LAST AMONG THE INHERITED ONES AND IS NEVER FORWARDED. That ordering is the
    /// whole of T9's first half: inheriting the developer's shell PATH is the failure that does not
    /// reproduce in development and only ever bites the stranger.
    pub fn env_plan(&self) -> Vec<(OsString, OsString)> {
        let mut plan: Vec<(OsString, OsString)> = Vec::new();
        for key in FORWARDED_ENV {
            if let Some(value) = std::env::var_os(key) {
                plan.push((OsString::from(*key), value));
            }
        }
        let path = self
            .path_env
            .clone()
            .unwrap_or_else(|| launchd_path(&home_dir()));
        plan.push((OsString::from("PATH"), OsString::from(path)));
        plan.extend(self.extra_env.iter().cloned());
        plan
    }

    /// Spawn, stream, classify.
    ///
    /// Everything this future owns — the child, both pipe readers, the in-flight guard — is owned
    /// by the future itself rather than by detached tasks, so dropping it drops all of them.
    ///
    /// ⚠ WHAT A DROP ACTUALLY KILLS, measured rather than inferred from the command line. On macOS
    /// the spawned pid is the SIDECAR — `caffeinate -i` `exec`s the utility into its own pid and
    /// forks the assertion holder as the utility's child (see [`CAFFEINATE`]). `kill_on_drop`
    /// signals THAT PID and no other, which used to leave the sidecar's OWN children — git, the
    /// provider CLI, an `apiKeyCommand` helper, a `launchctl list` — running as orphans of pid 1.
    /// On unix the spawn is now put in a process group of its own (`process_group(0)`) and
    /// `ProcessGroupKill` SIGKILLs that group on the drop, so the children go with it; that
    /// guard's docs carry why the id it signals is safe (plain backticks for the same
    /// `#[cfg(unix)]` reason as [`CAFFEINATE`]). Non-unix keeps `kill_on_drop` alone.
    ///
    /// Where a drop is actually reached: command bodies run detached on Tauri's runtime and are
    /// never dropped (see [`InFlight`]), but `shell::EngineSnapshots` drops a READ that exceeds its
    /// 30 s timeout — so a timed-out `schedule status`, and anything it forked, are killed together
    /// (`tests/watcher.rs`, `a_timed_out_read_kills_the_sidecar_and_the_children_it_forked`). A
    /// generation is never dropped this way; if one ever outlives its caller that is the engine's
    /// own concern — its `run.lock` (`src/runlock.ts`) refuses a second generation while one is
    /// still running, and it does not care who the first one's parent was.
    pub async fn invoke(
        &self,
        op: Operation,
        sink: &dyn ProgressSink,
    ) -> Result<EngineOutcome, EngineError> {
        let _guard = InFlight::try_acquire(&op)?;

        let (program, argv) = self.command_line(&op);
        let mut cmd = tokio::process::Command::new(&program);
        cmd.args(&argv)
            .env_clear()
            .envs(self.env_plan())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            // ⚠ KEPT, THOUGH THE UNIX SUITE NO LONGER PINS IT: on unix every drop the tests
            // exercise is now covered by the group kill, so deleting this stays green. It is the
            // only mechanism on non-unix, and the stated residual on the `ECHILD` path below.
            .kill_on_drop(true);
        // ⚠ ITS OWN PROCESS GROUP, so an abandoned invocation can take what the sidecar forked with
        // it rather than only the sidecar — see [`ProcessGroupKill`]. `0` means "the child's own
        // pid becomes the group's id", which is what makes the id safe to signal later.
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = cmd.spawn().map_err(|e| EngineError::Spawn {
            detail: format!("{}: {e}", program.display()),
        })?;
        // ⚠ ARMED HERE, AND DECLARED AFTER `child` — both halves are load-bearing. Locals drop in
        // reverse declaration order, so this guard's `killpg` runs BEFORE the `Child` is dropped
        // and reaped, which is what keeps the group id from being recycled out from under the
        // signal. Arming before the pipes are taken means the `?`s below kill the group too.
        #[cfg(unix)]
        let mut group = ProcessGroupKill::arm(&child);
        // Both pipes were configured above, so neither `take` can be `None`; the `ok_or` is here so
        // a future refactor that drops a `.stdout(piped())` fails as an error rather than a panic.
        let stdout = child.stdout.take().ok_or_else(|| EngineError::Spawn {
            detail: "the child has no stdout pipe".into(),
        })?;
        let stderr = child.stderr.take().ok_or_else(|| EngineError::Spawn {
            detail: "the child has no stderr pipe".into(),
        })?;

        let name = op.name();
        // ⚠ THE PIPES ARE DRAINED FIRST AND `wait()` COMES AFTER, WHICH IS THE WHOLE SAFETY
        // ARGUMENT — it is not the obvious ordering, and joining all three (the earlier shape)
        // breaks it two different ways depending on where the guard is disarmed.
        //
        // `wait()` REAPS the child the moment it returns; tokio says so itself (`Child::id`: "Once
        // the child has been polled to completion this will return None … the OS identifier could
        // be reused once the process has completed"). A reaped pid is a reusable pid, and this
        // guard's id IS that pid. Meanwhile the two readers run to EOF, which a descendant that
        // inherited the pipes holds open after the sidecar itself is gone (MEASURED:
        // `/bin/sh -c 'sleep 3 & exit 0' | cat` takes 3 s).
        //
        // So: reaping inside the join and disarming AFTER it leaves the guard armed over a reaped
        // pid. How wide that window is depends on the group: an id stays pinned while the group
        // still has members, so the exposure needs a pipe-holder that has LEFT the group (a
        // `setsid` daemon, or an fd handed to an unrelated process) — narrow, but the failure is a
        // `killpg` of a group this app never created, including a concurrent read's. Reaping
        // inside the join and disarming THERE is safe but gives the descendant back its orphan:
        // the guard is already disarmed when the timeout fires. Draining first removes the window
        // entirely AND keeps the kill. The child stays an un-reaped zombie — pid pinned, therefore
        // process-group id pinned — for exactly as long as anything it started still holds a pipe,
        // which is exactly as long as the group is still worth killing.
        //
        // ⚠ AND THE ORDERING DEPENDS ON `stdin` BEING `null()` ABOVE. tokio's `wait()` drops the
        // child's stdin first, precisely to avoid the deadlock where a child blocks on input the
        // parent never closes (`tokio::process`, `Child::wait`); with `wait()` moved after the
        // readers, a refactor to `.stdin(piped())` would deadlock on a pipe only that `wait()`
        // closes. `tests/watcher.rs`'s `a_timed_out_read_kills_a_child_that_outlived_the_sidecar`
        // is what pins this ordering.
        let (out, err) = tokio::join!(read_all(stdout), stream_stderr(stderr, name, sink));
        let status = child.wait().await;
        // ⚠ `ECHILD` GIVES THE GROUP UP; EVERY OTHER ERROR KEEPS IT. Another error leaves the
        // child's state unknown — it may well still be running — so the guard stays armed and the
        // `?` below takes the group with the dropped future. `ECHILD` means something else already
        // reaped the child, and the honest statement is that the pid MAY then be free: a
        // process-group id is pinned for the group's LIFETIME, so it is certainly free only if the
        // group is also empty, which cannot be tested cheaply or without a race. This path
        // therefore gives up a kill that might still have been correct, rather than risk
        // `killpg`ing a recycled id — and with every spawn now a group leader whose pgid equals
        // its pid, the likeliest owner of a recycled one is this app's own concurrent read
        // (`shell.rs`: the watcher's reads and `state_snapshot`'s overlap). The residual is
        // `kill_on_drop`'s `kill(pid)`: one process wide, where this guard is a group wide.
        //
        // ⚠ NOTHING TESTS THIS ARM, and that is said rather than left to be assumed: deleting it
        // leaves the suite green, because `ECHILD` needs a foreign reaper (a `waitpid(-1)` or
        // `SIGCHLD → SIG_IGN` elsewhere in the process) and this app has none. It is defence
        // against a future one — the same standing as [`ProcessGroupKill::is_signalable`]'s
        // refusals.
        #[cfg(unix)]
        match &status {
            Ok(_) => group.disarm(),
            Err(e) if e.raw_os_error() == Some(libc::ECHILD) => group.disarm(),
            Err(_) => {}
        }
        let status = status.map_err(|e| EngineError::Spawn {
            detail: format!("waiting for the engine failed: {e}"),
        })?;

        Ok(classify(&op, status.code(), out, err))
    }
}

/// Where the bundled sidecar sits at runtime.
///
/// ⚠ REPLICATED FROM `tauri-plugin-shell`, NOT CALLED INTO IT, and the reason is T9. The plugin's
/// Rust-side API (`Shell::sidecar`, `lib.rs:67-69` → `Command::new_sidecar`) does bypass the IPC
/// scope entirely — the scope only exists inside `commands.rs`'s `prepare_cmd` (`:99-146`), which
/// is reached from the `execute`/`spawn` IPC handlers and nowhere else — so it would have been a
/// legitimate way to resolve the path. But `Command::new_sidecar` fixes the child's PROGRAM to the
/// sidecar, and caffeinate wrapping needs the program to be `/usr/bin/caffeinate` with the sidecar
/// as an argument. The plugin's `Command` exposes no way to change that, so the path is resolved
/// here and the spawn is ours.
///
/// The resolution itself is `relative_command_path` (`process/mod.rs:120-151`): the directory of
/// `tauri::utils::platform::current_exe()`, hopping up one level when it is `deps/` (a `cargo test`
/// binary), joined with the sidecar's file name — the LAST component of the `externalBin` entry, as
/// `scope.rs:303-313` takes it — plus `.exe` on Windows. `tauri_build::build()` is what puts the
/// file there: it copies `binaries/daily-briefing-<triple>` to `target/<profile>/daily-briefing`
/// and refuses to compile the crate when the source is missing.
///
/// ⚠ AND THE PATH IS STATTED, because the spawn cannot tell a missing sidecar from a failing one.
/// MEASURED: on macOS the caffeinate-wrapped spawn of a nonexistent program does not fail — the
/// program that `Command::spawn` starts is `/usr/bin/caffeinate`, which exists, and it is
/// caffeinate's `exec` that fails, so the result is an ordinary `Failed { reason: "exit-127" }`
/// with `No such file or directory` on stderr. Statting here is what turns "the sidecar is not
/// there" into [`EngineError::SidecarUnresolved`] with the path in it, at startup, rather than an
/// exit code the user has to decode after clicking.
///
/// ⚠ AND EXISTENCE IS NOT ENOUGH — see [`resolve_sidecar`]. MEASURED: a DIRECTORY at the sidecar
/// path, and a regular file with mode `0o644`, both passed the bare existence stat and both then
/// produced `Failed { reason: "exit-126" }` with `daily-briefing: Permission denied` — i.e.
/// exactly the undecodable exit code the stat exists to prevent, one class over.
pub fn bundled_sidecar_path() -> Result<PathBuf, EngineError> {
    let exe =
        tauri::utils::platform::current_exe().map_err(|e| EngineError::SidecarUnresolved {
            detail: format!("current_exe: {e}"),
        })?;
    resolve_sidecar(&exe)
}

/// [`sidecar_path_beside`] plus the stat. Split from [`bundled_sidecar_path`] so a test can point
/// it at a directory it controls rather than at the test binary's own.
///
/// The stat requires a REGULAR, EXECUTABLE file, not merely an existing path, and the detail says
/// which of the three it was. `metadata` follows symlinks, so a symlinked sidecar is judged by its
/// target — which is what `execve` will do too.
pub fn resolve_sidecar(exe: &Path) -> Result<PathBuf, EngineError> {
    let path = sidecar_path_beside(exe)?;
    let meta = std::fs::metadata(&path).map_err(|e| EngineError::SidecarUnresolved {
        detail: format!("{}: {e}", path.display()),
    })?;
    if !meta.is_file() {
        return Err(EngineError::SidecarUnresolved {
            detail: format!(
                "{}: not a regular file (it is a {})",
                path.display(),
                if meta.is_dir() {
                    "directory"
                } else {
                    "special file"
                }
            ),
        });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode();
        if mode & 0o111 == 0 {
            return Err(EngineError::SidecarUnresolved {
                detail: format!(
                    "{}: not executable (mode {:04o})",
                    path.display(),
                    mode & 0o7777
                ),
            });
        }
    }
    Ok(path)
}

/// Where the sidecar WOULD be for an executable at `exe` — the pure half of the resolution, with
/// no filesystem access.
pub fn sidecar_path_beside(exe: &Path) -> Result<PathBuf, EngineError> {
    let dir = exe.parent().ok_or_else(|| EngineError::SidecarUnresolved {
        detail: format!("{} has no parent directory", exe.display()),
    })?;
    let base = if dir.ends_with("deps") {
        dir.parent().unwrap_or(dir)
    } else {
        dir
    };
    let name = if cfg!(windows) {
        "daily-briefing.exe"
    } else {
        "daily-briefing"
    };
    Ok(base.join(name))
}

/// The user's home directory, read the same way the engine reads it (`os.homedir()` → `$HOME` on
/// POSIX). Falling back to `/` rather than failing: a missing `HOME` is a broken session, and a
/// PATH of `/.local/bin:…` still finds `/usr/bin/git` — which is a worse briefing, not no app.
fn home_dir() -> PathBuf {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

async fn read_all<Rd: tokio::io::AsyncRead + Unpin>(mut rd: Rd) -> Vec<u8> {
    let mut buf = Vec::new();
    // A read error mid-stream keeps whatever arrived: partial output is evidence, and losing it
    // would turn a diagnosable failure into an empty one.
    let _ = rd.read_to_end(&mut buf).await;
    buf
}

/// Read stderr, handing each line to the sink as it arrives and keeping the raw bytes.
async fn stream_stderr<Rd: tokio::io::AsyncRead + Unpin>(
    rd: Rd,
    operation: &str,
    sink: &dyn ProgressSink,
) -> Vec<u8> {
    let mut reader = BufReader::new(rd);
    let mut raw: Vec<u8> = Vec::new();
    let mut line: Vec<u8> = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        raw.extend_from_slice(&line);
        let text = String::from_utf8_lossy(&line);
        sink.stderr_line(operation, text.trim_end_matches(['\n', '\r']));
    }
    raw
}

/// Exit code + output → [`EngineOutcome`]. Pure, and therefore testable without a process.
pub fn classify(
    op: &Operation,
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
) -> EngineOutcome {
    let stdout = String::from_utf8_lossy(&stdout).into_owned();
    let stderr = String::from_utf8_lossy(&stderr).into_owned();
    let payload: Option<serde_json::Value> = if op.expects_json() {
        serde_json::from_str(stdout.trim()).ok()
    } else {
        None
    };

    let reason_from_payload = |key: &str| -> Option<String> {
        payload
            .as_ref()
            .and_then(|p| p.get(key))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };

    let outcome = match exit_code {
        Some(0) => {
            if op.expects_json() && payload.is_none() {
                // ⚠ DEGRADE, NEVER PANIC. A zero exit with unparseable output is the engine having
                // been replaced, truncated or wrapped by something that printed first; the raw
                // stdout is retained above so the user can see what actually came back.
                Outcome::Failed {
                    reason: Some("malformed-json".to_string()),
                }
            } else if payload
                .as_ref()
                .and_then(|p| p.get("delivered"))
                .and_then(serde_json::Value::as_bool)
                == Some(false)
            {
                Outcome::Skipped {
                    reason: reason_from_payload("skipReason"),
                }
            } else {
                Outcome::Delivered
            }
        }
        Some(1) => Outcome::Failed {
            reason: reason_from_payload("skipReason"),
        },
        Some(2) => Outcome::ConfigError,
        Some(other) => Outcome::Failed {
            reason: Some(format!("exit-{other}")),
        },
        None => Outcome::Failed {
            reason: Some("signalled".to_string()),
        },
    };

    EngineOutcome {
        operation: op.name().to_string(),
        outcome,
        exit_code,
        payload,
        stdout,
        stderr,
    }
}

/* ── the IPC surface ──────────────────────────────────────────────────────────────────────────── */
//
// ONE COMMAND PER OPERATION, and that is the design decision the capability rests on: the grant is
// per command name, so `capabilities/default.json` can say "this webview may read status and
// validate a config" distinctly from "this webview may generate a briefing and install a
// schedule". A single command taking the operation as a parameter would collapse all nine into
// one grant and put the distinction back inside application code, which is where B1's ceiling
// measurement found it was not enforceable.
//
// None of these takes a program, an environment, a working directory or a raw argv. The only
// caller-supplied values are the two operands above, and both are parsed before any spawn. The
// invoker on the schedule mutations is not caller-supplied either (see `Invoker`).

/// The engine client, as Tauri managed state.
///
/// `lib.rs::run()` manages one, built from [`EngineClient::bundled`] ONCE at startup, and every
/// command reads it back through `tauri::State`. Two things follow from that shape:
///
///   * **The app starts even when the sidecar is missing.** The `Result` is stored, not
///     unwrapped; each command returns the stored [`EngineError::SidecarUnresolved`] at call time,
///     with the path it looked at, instead of the app refusing to launch or the click producing an
///     exit-127 to decode.
///   * **The client is injectable.** `tests/capability.rs` manages an [`Engine`] over a fake
///     sidecar under a tempdir and drives all nine commands through real IPC, so every command
///     BODY is executed by a test rather than only reached. The previous shape — the commands
///     calling `EngineClient::bundled()` inline — left six of the (then) eight bodies unreachable by any
///     test, which a mutation (`engine_schedule_install` replaced by a constant `Ok`) confirmed
///     with a green suite.
///
/// A newtype rather than a bare `Result<EngineClient, EngineError>` because `tauri::State` keys
/// managed values by TYPE — one value per type — and a name that says what it is beats a `Result`
/// nobody else may manage.
pub struct Engine(pub Result<EngineClient, EngineError>);

impl Engine {
    /// The client, or the startup error it failed with.
    pub fn client(&self) -> Result<&EngineClient, EngineError> {
        self.0.as_ref().map_err(Clone::clone)
    }
}

macro_rules! run_op {
    ($app:expr, $engine:expr, $op:expr) => {{
        let op = $op;
        let sink = AppProgress::new($app);
        $engine.client()?.invoke(op, &sink).await
    }};
}

#[tauri::command]
pub async fn engine_status<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
) -> Result<EngineOutcome, EngineError> {
    run_op!(app, engine, Operation::Status)
}

#[tauri::command]
pub async fn engine_doctor<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
) -> Result<EngineOutcome, EngineError> {
    run_op!(app, engine, Operation::Doctor)
}

#[tauri::command]
pub async fn engine_run<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    force: bool,
) -> Result<EngineOutcome, EngineError> {
    run_op!(
        app,
        engine,
        Operation::Run {
            force,
            json_out: None
        }
    )
}

#[tauri::command]
pub async fn engine_run_to_file<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    name: String,
    force: bool,
) -> Result<EngineOutcome, EngineError> {
    let json_out = json_out_name(&name).map_err(|reason| EngineError::InvalidInput {
        field: "name".into(),
        reason: reason.message().into(),
    })?;
    run_op!(
        app,
        engine,
        Operation::Run {
            force,
            json_out: Some(json_out)
        }
    )
}

#[tauri::command]
pub async fn engine_config_validate<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    file: String,
) -> Result<EngineOutcome, EngineError> {
    let file = config_file_path(&file).map_err(|reason| EngineError::InvalidInput {
        field: "file".into(),
        reason: reason.message().into(),
    })?;
    run_op!(app, engine, Operation::ConfigValidate { file })
}

/// `schedule install --invoker app [--take-over]`. The invoker is fixed: this IS the app.
#[tauri::command]
pub async fn engine_schedule_install<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    take_over: bool,
) -> Result<EngineOutcome, EngineError> {
    run_op!(
        app,
        engine,
        Operation::ScheduleInstall {
            invoker: Invoker::App,
            take_over
        }
    )
}

/// `schedule uninstall --invoker app [--take-over]`. The invoker is fixed: this IS the app.
#[tauri::command]
pub async fn engine_schedule_uninstall<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    take_over: bool,
) -> Result<EngineOutcome, EngineError> {
    run_op!(
        app,
        engine,
        Operation::ScheduleUninstall {
            invoker: Invoker::App,
            take_over
        }
    )
}

#[tauri::command]
pub async fn engine_schedule_status<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
) -> Result<EngineOutcome, EngineError> {
    run_op!(app, engine, Operation::ScheduleStatus)
}

/// `schedule verify --json` (T20) — re-issue the engine-side verification kickstart.
///
/// ⚠ THIS IS A WRITE, AND IT IS GUARDED AS ONE. See [`Operation::ScheduleVerify`]: the kick starts
/// the registered trigger, so a briefing can be generated and the day stamped. A second one while
/// any mutating operation is in flight is refused with [`EngineError::Busy`], not queued.
///
/// ⚠ AND ITS EXIT CODES DO NOT MEAN WHAT THE OTHERS DO. `1` here is "the kick was accepted and
/// produced no NEW evidence" — inconclusive, not broken — which the classifier reports as
/// [`Outcome::Failed`] with the envelope's own `skipReason` (there is none, so `null`). The panel
/// reads the ENVELOPE's `outcome` field for the verdict, never the exit class alone
/// (`gui/src/lib/verify-flow.ts`).
#[tauri::command]
pub async fn engine_schedule_verify<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
) -> Result<EngineOutcome, EngineError> {
    run_op!(app, engine, Operation::ScheduleVerify)
}

/// Every command name this module exposes, in the order `lib.rs` registers them.
///
/// `build.rs` autogenerates one `allow-<command>` permission per entry and
/// `capabilities/default.json` grants exactly these; `tests/capability.rs` asserts the three lists
/// agree, so a command added here without a grant fails a test rather than shipping unreachable,
/// and a grant without a command fails rather than lingering as a permission for nothing.
pub const COMMANDS: &[&str] = &[
    "engine_status",
    "engine_doctor",
    "engine_run",
    "engine_run_to_file",
    "engine_config_validate",
    "engine_schedule_install",
    "engine_schedule_uninstall",
    "engine_schedule_status",
    "engine_schedule_verify",
];
