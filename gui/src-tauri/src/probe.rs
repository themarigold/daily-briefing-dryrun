//! `--tcc-probe <dir>` — the SPK-1(b) app-principal TCC probe.
//!
//! ## What this answers, and why it has to live in the shell
//!
//! Plan R1 rules that the product has **two** TCC principals. The delegated one (the managed
//! engine copy under `<state>/daily-briefing`, signed with the stable local identity and
//! `--identifier local.daily-briefing`) is settled and holds the author's live grant. The **app**
//! principal is not: when the GUI spawns the engine, the child's *responsible process* is the
//! `.app`, so the `.app` needs its own Files-and-Folders grant, and an ad-hoc-signed `.app` has a
//! cdhash-bound designated requirement that every rebuild invalidates (plan R1, delta-verify H).
//!
//! SPK-1(b) asks two questions that only a real bundle on a real machine can answer:
//!
//!   1. **Obtainability** — does a protected-directory read from the `.app` process raise the
//!      first-run TCC prompt, and does granting it work?
//!   2. **Inheritance** — does a plain child process of the `.app` (here `/bin/ls`) read the same
//!      directory under the app's grant, or is it denied? A denial is the plan's *negative
//!      branch*: GUI-initiated runs would then have to route through the managed copy via a
//!      launchd one-shot, or the app principal joins the guided-grant flow.
//!
//! Both legs must run **from inside the bundle** (`Contents/MacOS/<exe> --tcc-probe <dir>`),
//! because the principal under test is the bundle, not this crate's `target/debug` binary.
//! `docs/spikes/spk-1b-app-principal.md` is the protocol; every protected-path leg there is VM
//! only and currently UNRUN.
//!
//! ## The gate — TWO gates, and the outer one is compile-time
//!
//! **This whole module is behind the `tcc-probe` cargo feature, which is OFF by default.** A
//! default build — which is what a release bundle is — does not compile `probe.rs`, does not
//! compile `main.rs`'s dispatch call, and does not contain the string `--tcc-probe` anywhere in the
//! binary. `tests/probe_feature_gate.rs` asserts both directions against the built executable.
//!
//! Those two assertions are each `cfg`'d on the feature, so between them they cover every way the
//! *gates* could rot — and none of the way the *default build* could stop being a default build.
//! One manifest line, `default = ["tcc-probe"]`, silently swaps which of the two is compiled:
//! MEASURED, `cargo test` was 39 passed / 0 failed with the flag present in the plain binary. The
//! third test in that file, `the_probe_feature_is_not_a_default_feature`, is UNGATED and pins the
//! manifest itself — nothing reachable from `default` may enable `tcc-probe`. With all three, the
//! guarantee stated above is what is actually enforced, rather than a claim two `cfg`'d tests
//! could only make about whichever build they were compiled into.
//!
//! That gate is a deviation from plan line 43, which names a *"minimal probe bundle"*, and the
//! deviation is deliberate and disclosed in `docs/spikes/spk-1b-app-principal.md` §2: the question
//! SPK-1(b) asks is about the **app principal**, and a principal is a bundle id plus a designated
//! requirement. A separate probe bundle would carry a different identifier and a different DR, so
//! it would measure a different principal and answer a different question. The probe therefore has
//! to live in the shipping shell's own bundle — but it must not live in the shipping *binary*, and
//! the feature is what separates those two requirements. Spike bundles are built with
//! `--features tcc-probe` (the exact command is in spk-1b §2); release builds are not.
//!
//! The inner, runtime gate: the probe is selected **only** when `--tcc-probe` is argv[1]. Anything
//! else — no arguments, a different first argument, even `--tcc-probe` in second position — falls
//! through to the ordinary `run()` launch untouched. Nothing here constructs a `tauri::Builder`,
//! opens a window, reads the capability allowlist, or spawns the engine sidecar: the probe returns
//! an exit code from `main` before any of that exists. That is what makes it safe to run headlessly
//! from a terminal.
//!
//! ## What the product does with this later (T17)
//!
//! Plan line 21 is explicit that the shipped app-principal probe is a **revocation detector only**
//! — it fires when a protected root is in scope AND a prior app-principal grant is recorded, never
//! as an acquisition trigger outside the guided flow, so that the deselected-by-default
//! protected-roots graft keeps its no-unexplained-prompt property. This module is the measurement
//! instrument for the spike; T17 decides how (and how rarely) the product calls the same read.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::access::{
    classify_dir_error, verdict_from_entries as access_verdict_from_entries, DirAccess,
};

/// The one argv token that selects the probe. Public so the tests assert the gate against the
/// literal the binary actually matches on, rather than a copy of it.
pub const PROBE_FLAG: &str = "--tcc-probe";

/// The frozen bundle identifier (plan R1: `com.themarigold.daily-briefing`, superseding
/// gui-tauri T6/T22's `dev.dailybriefing.app`).
///
/// It is a constant here rather than a read of the Tauri config because the probe deliberately
/// never builds a `tauri::Context` — see the gate note above. `tests/tcc_probe.rs` pins it against
/// `tauri.conf.json`'s `identifier`, so the two cannot drift silently.
pub const BUNDLE_ID: &str = "com.themarigold.daily-briefing";

/// The child the probe spawns. A plain system tool on purpose: the question is whether TCC
/// attribution is inherited by *any* child of the `.app`, and the engine sidecar would add its own
/// signature, its own bundle membership and its own failure modes to a one-bit answer.
///
/// Not `cfg`-gated for Windows. This is a macOS spike; on a platform without `/bin/ls` the spawn
/// simply fails and the `child` leg reports `error:spawn-NotFound`, which is the honest answer
/// there and keeps the module free of platform branches it would never exercise.
const CHILD_PROGRAM: &str = "/bin/ls";

/// Raw errno values.
///
/// ⚠ RE-EXPORTED FROM [`crate::access`] SINCE B6, NOT DEFINED TWICE. T17 needed the same four
/// numbers and the same directory-read classification in the SHIPPING build, and this module is
/// behind a cargo feature that is off there — so the classifier moved to `access.rs` and this one
/// maps its answer to the wire strings SPK-1(b)'s JSON promises. Two copies of "is this errno a TCC
/// denial" is the divergence that would have the spike and the product disagree about a machine
/// they both measured.
///
/// `pub` so `errno_constants_are_what_this_os_reports` in `tests/tcc_probe.rs` can pin **these**
/// bindings — not a second copy of the literals — against `std::io::Error::from_raw_os_error`. The
/// earlier version of that test asserted the stdlib's behaviour on the literals `1`/`13`/`2`, which
/// is a true statement about macOS that says nothing about the constants: renumbering `EPERM` left
/// it green. It now fails.
pub use crate::access::{EACCES, ENOENT, ENOTDIR, EPERM};

/// How much of `/bin/ls`'s stderr survives into the JSON receipt, in **chars** (not bytes — the
/// cap is applied with `chars().take(..)` so a multi-byte path can never be cut mid-codepoint).
pub const CHILD_STDERR_CAP: usize = 512;

/// What `main` should do with this argv.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    /// No probe flag in position 1 — launch the app exactly as before.
    Normal,
    /// `--tcc-probe <dir>`.
    Probe(PathBuf),
    /// The flag was present but the rest of the argv was not usable. Carries the message to print
    /// on stderr; `main` exits 2.
    Usage(String),
}

/// Decide the mode from a full argv, argv[0] included.
///
/// Strict on purpose. `--tcc-probe` takes exactly one operand, and a second operand is a usage
/// error rather than something silently ignored: an operator who typed
/// `--tcc-probe ~/Documents ~/Desktop` in a VM must not be told about only one of them.
pub fn parse_mode<I: IntoIterator<Item = OsString>>(argv: I) -> Mode {
    let mut args = argv.into_iter().skip(1);
    let Some(first) = args.next() else {
        return Mode::Normal;
    };
    if first != OsStr::new(PROBE_FLAG) {
        return Mode::Normal;
    }
    let Some(dir) = args.next() else {
        return Mode::Usage(format!("{PROBE_FLAG} needs exactly one directory operand"));
    };
    if args.next().is_some() {
        return Mode::Usage(format!("{PROBE_FLAG} takes exactly one directory operand"));
    }
    Mode::Probe(PathBuf::from(dir))
}

/// One leg's verdict, as it appears in the JSON.
///
/// A plain `String` rather than an enum: the `error:` arm carries an open-ended payload (an errno
/// name, an `ErrorKind`, an exit status) and an enum with a `String` variant would be the same
/// thing wearing a type.
pub type Verdict = String;

/// [`DirAccess`] in the wire vocabulary this spike's JSON promises.
///
/// The typed answer is [`crate::access`]'s; the STRINGS are this module's, because
/// `docs/spikes/spk-1b-app-principal.md` §2 documents them and a VM transcript is read against that
/// document.
fn verdict_of(access: DirAccess) -> Verdict {
    match access {
        DirAccess::Ok { .. } => "ok".to_string(),
        DirAccess::Denied { .. } => "denied".to_string(),
        DirAccess::NotFound => "error:ENOENT".to_string(),
        DirAccess::NotADirectory => "error:ENOTDIR".to_string(),
        DirAccess::Error { detail } => format!("error:{detail}"),
    }
}

/// Classify a failed directory read.
///
/// `EPERM`/`EACCES` is the answer SPK-1(b) exists to detect: macOS returns `EPERM` ("Operation not
/// permitted") for a TCC-denied `opendir`, and `EACCES` is the ordinary filesystem-permission
/// denial. Everything else is reported with its errno name so a VM transcript distinguishes "the
/// path was wrong" from "the grant was refused" without a second run.
///
/// ⚠ THE RULE ITSELF LIVES IN [`crate::access::classify_dir_error`] SINCE B6 — see the errno
/// constants above.
pub fn classify_io_error(err: &std::io::Error) -> Verdict {
    verdict_of(classify_dir_error(err))
}

/// Classify `/bin/ls`'s result.
///
/// ⚠ This reads **stderr text**, and that is a real weakness rather than a stylistic one: `ls`
/// exits 1 for a denial and 1 for a missing path alike, so the only signal that separates them is
/// the message. The alternative — re-executing this binary as its own child so the child could
/// report a numeric errno — was rejected because it changes the thing being measured: the spike
/// asks whether an *ordinary* child inherits the app's TCC attribution, and a child that is the
/// same signed Mach-O as the parent is not ordinary.
///
/// The mitigation is that the raw stderr ships in the JSON (`childStderr`), so every
/// classification in a VM transcript can be re-derived by hand.
///
/// ## Why the match is anchored to the tail, and not a `contains`
///
/// MEASURED: with a substring search over the whole line, a directory named
/// `<scratch>/Permission denied` whose *child* path does not exist produced
/// `child = "denied"` from the stderr `ls: …/Permission denied/nope: No such file or directory`.
/// The diagnosis was read off the operand. Since `ls`'s format is
/// `ls: <operand>: <diagnosis>`, the diagnosis is the segment after the **last** `": "` of the
/// **last** line, and only that segment is matched — an operand can contain anything and still not
/// be mistaken for the kernel's answer. Exit status is consulted first, so a successful listing is
/// never re-derived from prose at all.
pub fn classify_child_output(status: Option<i32>, stderr: &str) -> Verdict {
    // The status is the only non-stringly signal there is, so it goes first: success is success
    // whatever the path happens to spell.
    if status == Some(0) {
        return "ok".to_string();
    }
    let last_line = stderr
        .lines()
        .rfind(|line| !line.trim().is_empty())
        .unwrap_or("");
    // `rsplit(": ").next()` is the segment after the final `": "`, i.e. the diagnosis, and falls
    // back to the whole line when `ls` said something with no separator in it at all.
    let diagnosis = last_line.rsplit(": ").next().unwrap_or(last_line).trim();
    match diagnosis {
        "Operation not permitted" | "Permission denied" => "denied".to_string(),
        "No such file or directory" => "error:ENOENT".to_string(),
        "Not a directory" => "error:ENOTDIR".to_string(),
        _ => match status {
            Some(code) => format!("error:exit-{code}"),
            None => "error:signalled".to_string(),
        },
    }
}

/// Trim `/bin/ls`'s stderr and cap it at [`CHILD_STDERR_CAP`] **chars**.
///
/// A free function rather than two lines inside [`run_probe`] because the cap is a promise the
/// spike doc makes (spk-1b §2, `childStderr`: *"trimmed, ≤512 chars"*) and the child that would
/// exercise it is `/bin/ls`, which cannot be made to emit 512 characters on demand. A promise no
/// test can break is not a promise; this is the seam that lets one break it.
pub fn cap_child_stderr(raw: &str) -> String {
    raw.trim().chars().take(CHILD_STDERR_CAP).collect()
}

/// One probe run's findings.
#[derive(Debug, Clone)]
pub struct ProbeReport {
    pub dir: PathBuf,
    pub app: Verdict,
    pub child: Verdict,
    /// `None` when the child was killed by a signal or could not be spawned — serialised as
    /// `null`, never as a fabricated `-1`.
    pub child_exit: Option<i32>,
    /// Trimmed, and capped at [`CHILD_STDERR_CAP`] **chars** (see [`cap_child_stderr`]) so a
    /// pathological `ls` cannot turn the one-line receipt into a wall of text.
    pub child_stderr: String,
    pub bundle_id: &'static str,
    pub executable: Option<PathBuf>,
}

impl ProbeReport {
    /// The single JSON object the probe prints.
    ///
    /// `childStderr` is an addition to the shape SPK-1(b) specified, and a deliberate one: the
    /// `child` verdict above is derived from `ls`'s prose, so without the prose the verdict is
    /// unfalsifiable by the person reading the VM transcript.
    pub fn to_json(&self) -> String {
        serde_json::json!({
            "dir": self.dir.to_string_lossy(),
            "app": self.app,
            "child": self.child,
            "childExit": self.child_exit,
            "childStderr": self.child_stderr,
            "bundleId": self.bundle_id,
            "executable": self.executable.as_ref().map(|p| p.to_string_lossy()),
        })
        .to_string()
    }
}

/// Collapse an opened directory's per-entry results into one verdict: the **first** entry error
/// wins, and a directory that enumerates clean is the only `"ok"`.
///
/// Generic over the item type purely so it is testable: `std::fs::DirEntry` cannot be constructed
/// in a test, and the only portable way to make a real directory fail mid-enumeration is a `chmod`
/// race — over an iterator of `Result`s the contract is exercised directly. The drain is
/// load-bearing: a TCC-refused directory can `opendir` and then fail per entry, so replacing it
/// with a bare `"ok"` would turn a denial into a pass.
///
/// ⚠ SINCE B6 THIS IS A THIN MAP over [`crate::access::verdict_from_entries`] — the rule is shared
/// with the shipped `access_probe`, which is not compiled with this module (see the errno constants
/// above). What is B6-specific here is only the VERDICT STRINGS, which `docs/spikes/spk-1b-app-principal.md`
/// §2 documents and a VM transcript is read against.
pub fn verdict_from_entries<T, I>(entries: I) -> Verdict
where
    I: IntoIterator<Item = Result<T, std::io::Error>>,
{
    verdict_of(access_verdict_from_entries(entries))
}

/// Read `dir` from **this** process — the app principal.
///
/// `read_dir` alone is not enough to conclude anything: it is the `opendir` that TCC refuses, but
/// a directory that opens can still fail per-entry, so the iterator is drained by
/// [`verdict_from_entries`] and the first entry error wins.
fn probe_app_leg(dir: &Path) -> Verdict {
    verdict_of(crate::access::read_dir_access(dir))
}

/// Run the probe against `dir`. Never panics and never propagates: every failure mode is a
/// verdict, because a probe that dies instead of reporting tells the VM operator nothing.
pub fn run_probe(dir: &Path) -> ProbeReport {
    let app = probe_app_leg(dir);

    // `--` before the operand, and it is not a nicety. MEASURED without it:
    // `--tcc-probe -laR` reported `child: "ok"` — `ls` had parsed the operand as FLAGS and listed
    // the working directory instead, so the child leg returned a verdict about a directory it was
    // never pointed at, while the app leg correctly said `error:ENOENT`. In a VM transcript that is
    // an inheritance answer invented out of an argv typo.
    let (child, child_exit, child_stderr) =
        match Command::new(CHILD_PROGRAM).arg("--").arg(dir).output() {
            Ok(out) => {
                let code = out.status.code();
                let stderr = cap_child_stderr(&String::from_utf8_lossy(&out.stderr));
                (classify_child_output(code, &stderr), code, stderr)
            }
            Err(e) => (
                format!("error:spawn-{:?}", e.kind()),
                None,
                format!("could not spawn {CHILD_PROGRAM}: {e}"),
            ),
        };

    ProbeReport {
        dir: dir.to_path_buf(),
        app,
        child,
        child_exit,
        child_stderr,
        bundle_id: BUNDLE_ID,
        executable: std::env::current_exe().ok(),
    }
}

/// The whole of what `main` adds. `None` means "this was an ordinary launch, carry on"; `Some(n)`
/// means the process is done and should exit with `n`.
///
/// Kept here rather than in `main.rs` so the gate is reachable from `tests/`: a gate that only
/// exists inside `fn main` is a gate no test can fail.
pub fn dispatch<I: IntoIterator<Item = OsString>>(argv: I) -> Option<i32> {
    match parse_mode(argv) {
        Mode::Normal => None,
        Mode::Probe(dir) => {
            println!("{}", run_probe(&dir).to_json());
            Some(0)
        }
        Mode::Usage(message) => {
            eprintln!("daily-briefing-gui: {message}");
            eprintln!("usage: daily-briefing-gui {PROBE_FLAG} <directory>");
            Some(2)
        }
    }
}
