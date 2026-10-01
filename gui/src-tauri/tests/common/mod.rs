//! Scaffolding shared by the integration tests (`engine_client.rs`, `engine_env.rs`,
//! `engine_env_parent.rs`, `capability.rs`, `watcher.rs`, `shell.rs`, `packaging.rs`).
//!
//! ⚠ B2 DELIBERATELY DUPLICATED ITS `ScratchDir` RATHER THAN MAKING A MODULE LIKE THIS ONE
//! (`tests/probe_feature_gate.rs`: *"Two short guards in two integration-test binaries, rather than
//! a `tests/common/` module for one of them to pull in the other's chmod walk"*), and that call is
//! not being overturned — it is a different call on the same axis. What is shared here is a
//! **fake-sidecar generator**: a script writer plus a set of canned engine behaviours that both
//! files need to agree on exactly, because the point of the fakes is that the two files are
//! exercising the SAME contract (exit code → outcome; argv → environment) from two directions. Two
//! copies of a twenty-line guard cannot drift in a way that matters; two copies of "what the engine
//! prints for exit 2" can.
//!
//! By that same test, [`process_gone`] and [`ReapTagged`] live here rather than in one caller:
//! `watcher.rs` asserts a timed-out read KILLED a fake's forked child and `engine_client.rs`
//! asserts a completed one LEFT it alone, so "what counts as gone" is a contract the two are
//! reading from opposite sides — and a drifted copy would make one of them pass vacuously.
//!
//! Nothing here spawns the real engine. See each caller for the sandbox rules.

#![allow(dead_code)] // each test binary uses a subset; an unused helper here is not a defect

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use daily_briefing_gui_lib::access::OpenSink;

/// A uniquely-named temporary directory, removed on every exit path including a panic.
///
/// Its path deliberately carries `tag`, and that is load-bearing for `engine_env.rs`: the
/// caffeinate tests find the process tree they created by matching the tag in `pgrep -fl` output,
/// so the tag has to be unique per test AND visible in the child's argv. The uniqueness itself
/// comes from [`SCRATCH_SEQ`], not from the timestamp — see that constant for what was measured.
pub struct ScratchDir {
    pub path: PathBuf,
}

/// The uniqueness in a [`ScratchDir`] name. **The timestamp is not it.**
///
/// ⚠ MEASURED, and this counter is the fix for a real flake. `SystemTime::now()` on this machine
/// has **1000 ns granularity** (16000 samples across 8 threads yielded 1753 distinct values), and
/// every test in a binary runs on a parallel thread against the same pid — so `{tag}-{pid}-{nanos}`
/// is not unique. A 5-thread barrier-released `ScratchDir::new("ipc")`, repeated 2000 times,
/// produced a duplicate name in **1379 trials**. A duplicate name means two `ScratchDir`s own ONE
/// directory and the first [`Drop`] `remove_dir_all`s the other's fake sidecar mid-run: observed
/// twice as `every_command_body_runs_through_real_ipc_against_a_fake_sidecar` failing with
/// `exitCode: 127` and `…/engine.sh: No such file or directory`.
///
/// A process-wide counter cannot collide within a process, and the pid cannot collide across two
/// live ones — so the pair is unique where the clock was not. The pid and the timestamp are kept
/// because a `ScratchDir` name is also a diagnostic: a leftover directory says which process and
/// when.
static SCRATCH_SEQ: AtomicU64 = AtomicU64::new(0);

impl ScratchDir {
    pub fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("a clock after 1970")
            .as_nanos();
        let seq = SCRATCH_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "daily-briefing-t8-{tag}-{}-{nanos}-{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("scratch dir");
        Self { path }
    }

    pub fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    /// The unique substring of this directory's name, for process-tree matching.
    pub fn tag(&self) -> String {
        self.path
            .file_name()
            .expect("a scratch dir has a name")
            .to_string_lossy()
            .into_owned()
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.path).ok();
    }
}

/* ── T17's opener sink ────────────────────────────────────────────────────────────────────────── */

/// An [`OpenSink`] that RECORDS instead of opening.
///
/// ⚠ THE WHOLE REASON `access::OpenSink` IS A TRAIT. The shipping sink calls
/// `tauri-plugin-opener`'s `open_url` / `reveal_item_in_dir`, which on this machine would launch
/// System Settings and raise a Finder window — a side effect on the developer's own session that no
/// assertion needs. Every access test asserts the URL or path that was CHOSEN, and nothing is ever
/// opened. Shared here rather than duplicated because `capability.rs` and `access.rs` both need the
/// same "never actually open anything" guarantee, and a second copy that forgot it would be
/// invisible until it opened something.
#[derive(Default)]
pub struct RecordingOpener {
    pub urls: Mutex<Vec<String>>,
    pub reveals: Mutex<Vec<PathBuf>>,
    /// When set, both calls FAIL with this text — the sink's error path, which the commands turn
    /// into `AccessError::Opener`.
    pub fail: Option<String>,
}

impl RecordingOpener {
    pub fn failing(detail: &str) -> Self {
        Self {
            fail: Some(detail.to_string()),
            ..Self::default()
        }
    }

    pub fn urls(&self) -> Vec<String> {
        self.urls.lock().expect("the recorded urls").clone()
    }

    pub fn reveals(&self) -> Vec<PathBuf> {
        self.reveals.lock().expect("the recorded reveals").clone()
    }
}

impl OpenSink for RecordingOpener {
    fn open_url(&self, url: &str) -> Result<(), String> {
        self.urls
            .lock()
            .expect("the recorded urls")
            .push(url.to_string());
        match &self.fail {
            Some(detail) => Err(detail.clone()),
            None => Ok(()),
        }
    }

    fn reveal(&self, path: &Path) -> Result<(), String> {
        self.reveals
            .lock()
            .expect("the recorded reveals")
            .push(path.to_path_buf());
        match &self.fail {
            Some(detail) => Err(detail.clone()),
            None => Ok(()),
        }
    }
}

/* ── T18/T19's sinks ──────────────────────────────────────────────────────────────────────────── */

/// A [`NotifySink`] that RECORDS instead of posting.
///
/// ⚠ THE WHOLE REASON `notifications::NotifySink` IS A TRAIT. The shipping sink posts through
/// `tauri-plugin-notification`, which on this machine would put a real banner on the developer's
/// screen — and a real post from an UNSIGNED test bundle is the appendix's UNVERIFIED leg
/// (`docs/gui-seam.md` §12c). Every notify test asserts the notification that was BUILT, and
/// nothing is ever posted.
#[derive(Default)]
pub struct RecordingNotifySink {
    pub posted: Mutex<Vec<daily_briefing_gui_lib::notifications::Notification>>,
    /// When set, every post FAILS with this text — the `post-failed` suppression path.
    pub fail: Option<String>,
}

impl RecordingNotifySink {
    pub fn failing(detail: &str) -> Self {
        Self {
            fail: Some(detail.to_string()),
            ..Self::default()
        }
    }

    pub fn posted(&self) -> Vec<daily_briefing_gui_lib::notifications::Notification> {
        self.posted.lock().expect("the recorded posts").clone()
    }
}

impl daily_briefing_gui_lib::notifications::NotifySink for RecordingNotifySink {
    fn post(
        &self,
        notification: &daily_briefing_gui_lib::notifications::Notification,
    ) -> Result<(), String> {
        self.posted
            .lock()
            .expect("the recorded posts")
            .push(notification.clone());
        match &self.fail {
            Some(detail) => Err(detail.clone()),
            None => Ok(()),
        }
    }
}

/// An [`AutostartSink`] that RECORDS instead of enabling or disabling.
///
/// The shipping sink's `enable()` WRITES `~/Library/LaunchAgents/<app name>.plist` and its
/// `disable()` REMOVES it — the REAL legs are VM-gated (§12c), so every test counts calls
/// instead. `enabled` is what `is_enabled()` answers (B25: the uninstall leg reads it first).
#[derive(Default)]
pub struct RecordingAutostartSink {
    pub enables: Mutex<u32>,
    pub disables: Mutex<u32>,
    /// What `is_enabled()` reports. Defaults false (a fresh machine).
    pub enabled: Mutex<bool>,
    pub fail: Option<String>,
}

impl RecordingAutostartSink {
    pub fn failing(detail: &str) -> Self {
        Self {
            fail: Some(detail.to_string()),
            ..Self::default()
        }
    }

    pub fn reporting_enabled(enabled: bool) -> Self {
        let sink = Self::default();
        *sink.enabled.lock().expect("the recorded enabled state") = enabled;
        sink
    }

    pub fn enables(&self) -> u32 {
        *self.enables.lock().expect("the recorded enables")
    }

    pub fn disables(&self) -> u32 {
        *self.disables.lock().expect("the recorded disables")
    }
}

impl daily_briefing_gui_lib::autostart::AutostartSink for RecordingAutostartSink {
    fn enable(&self) -> Result<(), String> {
        *self.enables.lock().expect("the recorded enables") += 1;
        match &self.fail {
            Some(detail) => Err(detail.clone()),
            None => Ok(()),
        }
    }

    fn disable(&self) -> Result<(), String> {
        *self.disables.lock().expect("the recorded disables") += 1;
        match &self.fail {
            Some(detail) => Err(detail.clone()),
            None => {
                *self.enabled.lock().expect("the recorded enabled state") = false;
                Ok(())
            }
        }
    }

    fn is_enabled(&self) -> Result<bool, String> {
        match &self.fail {
            Some(detail) => Err(detail.clone()),
            None => Ok(*self.enabled.lock().expect("the recorded enabled state")),
        }
    }
}

/// `ps`'s state letters for `pid`, or `""` when there is no such process.
///
/// The raw form, because ZOMBIE-vs-ABSENT is a distinction one caller has to make: `watcher.rs`
/// pins that a timed-out read's sidecar is `Z` — exited but deliberately NOT yet reaped — while
/// the invocation is still in flight, and [`process_gone`] folds exactly that distinction away.
pub fn process_stat(pid: &str) -> String {
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", pid])
        .output()
        .expect("ps runs");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Whether `pid` is gone (or only a zombie awaiting its reaper).
///
/// A zombie counts as gone because a fake sidecar is the test process's own child and stays one
/// until tokio's orphan queue drains it.
///
/// ⚠ BOTH BRANCHES ARE LOAD-BEARING, AND THEY SERVE DIFFERENT PROCESSES — MEASURED, because the
/// obvious guess is wrong. The SIDECAR reaches this through `Z`: it is the test process's own
/// child, and `engine::EngineClient::invoke` deliberately holds it un-reaped while the pipes drain.
/// The fake's own FORKED CHILD reaches it through the EMPTY branch: a child is reparented to pid 1
/// when its parent EXITS, not when the parent is reaped, so the sleeper's `ppid` is already 1 while
/// the fake shell is still a zombie — and once killed, launchd reaps it out of existence within
/// milliseconds rather than leaving it as one. (Measured both fake shapes, the `wait`ing and the
/// exiting one: `ppid=1` with the shell still `Z`; `ps -o stat=` empty at t+20 ms after the kill.)
/// So neither branch may be dropped: requiring `Z` would fail every forked-child assertion, and
/// requiring emptiness would fail every sidecar one.
pub fn process_gone(pid: &str) -> bool {
    let stat = process_stat(pid);
    stat.is_empty() || stat.starts_with('Z')
}

/// Kills whatever still carries `tag` in its argv when dropped — the safety net for a test whose
/// fake backgrounds a long sleeper.
///
/// It is NOT cleanup for an expected orphan. Since a dropped invocation kills the whole process
/// group (`engine::ProcessGroupKill`), a survivor is what a FAILING assertion leaves behind — plus,
/// in `engine_client.rs`, the deliberately-kept background child of a COMPLETED invocation, which
/// that test kills here rather than leaving to run out its sleep.
pub struct ReapTagged(pub String);

impl Drop for ReapTagged {
    fn drop(&mut self) {
        let _ = std::process::Command::new("pkill")
            .args(["-KILL", "-f", &self.0])
            .status();
    }
}

/// Write an executable `/bin/sh` script standing in for the engine sidecar.
///
/// A script rather than a compiled stub because the thing under test is the SPAWN — argv,
/// environment, pipes, exit status, caffeinate wrapping — and a script exercises every one of them
/// through the same syscalls a real binary would.
pub fn fake_sidecar(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write the fake sidecar");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("make the fake sidecar executable");
    }
    path
}

/// A `run --json` envelope with only the fields `src/engine.rs` classifies on. Deliberately NOT the
/// full `RunEnvelope` (`src/json.ts`): a fixture that mirrored every field would be a second,
/// rotting copy of the engine's schema, and the classifier reads exactly two keys.
pub fn envelope(delivered: bool, skip_reason: Option<&str>, exit_code: i32) -> String {
    let skip = match skip_reason {
        Some(r) => format!("\"{r}\""),
        None => "null".to_string(),
    };
    format!(
        "{{\"schemaVersion\":1,\"ok\":{},\"exitCode\":{exit_code},\"delivered\":{delivered},\
         \"skipReason\":{skip}}}",
        exit_code == 0
    )
}

/// Shell-escape for single quotes, so an envelope can be embedded in a `printf '%s'` argument.
pub fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A fake that prints `stdout_text`, prints `stderr_lines` one per line to stderr, and exits `code`.
pub fn canned(
    dir: &Path,
    name: &str,
    stdout_text: &str,
    stderr_lines: &[&str],
    code: i32,
) -> PathBuf {
    let mut body = String::new();
    for line in stderr_lines {
        body.push_str(&format!("printf '%s\\n' {} >&2\n", sq(line)));
    }
    if !stdout_text.is_empty() {
        body.push_str(&format!("printf '%s' {}\n", sq(stdout_text)));
    }
    body.push_str(&format!("exit {code}\n"));
    fake_sidecar(dir, name, &body)
}

/// A fake that never exits on its own. Used for the in-flight guard and the nothing-left-behind
/// assertions.
///
/// ⚠ IT `exec`s THE SLEEPER, AND THE SLEEPER IS A SYMLINK NAMED INTO THE SCRATCH DIR. Both halves
/// are load-bearing:
///
///   * `exec` makes the spawned pid BE the sleeper — the honest shape for a test about what
///     killing the SPAWNED PID reaches, because the real sidecar is a binary, not a shell that
///     forks one. Historically it also avoided an orphan: without it `/bin/sh` forked `sleep` as a
///     child, `kill_on_drop` killed the shell, and the `sleep` was orphaned to pid 1 (MEASURED:
///     two `sleep 30` processes left behind per suite run by the busy test alone). That reason is
///     now history — a dropped invocation kills the whole process group
///     (`engine::ProcessGroupKill`), so a forking fake is not orphaned either, and
///     `watcher.rs`'s `a_timed_out_read_kills_the_sidecar_and_the_children_it_forked` deliberately
///     builds one to prove it. The first reason still stands on its own.
///   * The symlink puts the scratch directory's unique tag into the sleeper's argv[0]. `exec sleep
///     30` would leave an argv of `sleep 30` with nothing to `pgrep -f` for, so a leak would be
///     invisible to the test that exists to catch it. Through `<dir>/sleep` the kernel runs
///     `/bin/sleep` and `ps` reports the path it was invoked as — MEASURED.
pub fn sleeper(dir: &Path, name: &str, seconds: u32) -> PathBuf {
    let link = dir.join("sleep");
    #[cfg(unix)]
    if !link.exists() {
        std::os::unix::fs::symlink("/bin/sleep", &link).expect("symlink the sleeper into scratch");
    }
    #[cfg(not(unix))]
    let link = PathBuf::from("sleep");
    fake_sidecar(dir, name, &format!("exec \"{}\" {seconds}", link.display()))
}

/// The fake `tests/capability.rs` manages as the app's engine: records the argv it received, one
/// token per line, in `argv_file`; prints a minimal valid envelope when the argv asked for `--json`
/// (so the classifier sees `Delivered` rather than `malformed-json`); exits 0. It never reads any
/// path it is handed, so the `--file` operand it echoes back can be anything the validator admits.
pub fn ipc_sidecar(dir: &Path, name: &str, argv_file: &Path) -> PathBuf {
    let body = format!(
        "printf '%s\\n' \"$@\" > \"{}\"\ncase \" $* \" in *\" --json \"*) printf '%s' {} ;; esac\nexit 0",
        argv_file.display(),
        sq(&envelope(true, None, 0)),
    );
    fake_sidecar(dir, name, &body)
}

/// A fake that dumps its entire environment, one `KEY=VALUE` per line, and exits 0.
///
/// `exec /usr/bin/env` rather than a shell loop: the shell adds `PWD`, `SHLVL` and `_` to its own
/// environment, and `exec`ing replaces the shell image so those additions are still visible — which
/// is why `engine_env.rs` names them explicitly as shell artefacts rather than pretending the set
/// is pristine. `/usr/bin/env` is reachable because `/usr/bin` is in the PATH under test.
pub fn env_dumper(dir: &Path, name: &str) -> PathBuf {
    fake_sidecar(dir, name, "exec /usr/bin/env")
}

/// Parse `KEY=VALUE` lines out of [`env_dumper`]'s stdout.
///
/// Here rather than in a test file for the reason the module header gives: it is one half of a
/// fake's CONTRACT — `env_dumper` `exec`s `/usr/bin/env` and this is what reads that back — and
/// `engine_env.rs` and `engine_env_parent.rs` both need to agree with it exactly.
pub fn parse_env(stdout: &str) -> BTreeMap<String, String> {
    stdout
        .lines()
        .filter_map(|line| {
            line.split_once('=')
                .map(|(k, v)| (k.to_string(), v.to_string()))
        })
        .collect()
}

/// A fake that prints its own argv, one token per line, and exits 0.
pub fn argv_dumper(dir: &Path, name: &str) -> PathBuf {
    fake_sidecar(dir, name, "for a in \"$@\"; do printf '%s\\n' \"$a\"; done")
}

/// The three environment overrides that keep a real-engine spawn away from the developer's state.
///
/// * `DAILY_BRIEFING_STATE_DIR` (`src/marker.ts:10`) — every state path.
/// * `XDG_CONFIG_HOME` (`src/config.ts`, `configPath()`) — the config the engine loads.
/// * `DBA_TEST_UNIT_DIR` (`src/schedule/install.ts:130`, checked FIRST) — the launchd/systemd unit
///   directory, which is otherwise `~/Library/LaunchAgents`.
///
/// ⚠ RESIDUAL, stated rather than glossed, and inherited from B1's note: `HOME` itself is still
/// forwarded (`engine::FORWARDED_ENV`), so a future engine surface that reads `~` directly rather
/// than through one of the three overrides above would escape this sandbox. Every operation this
/// suite executes resolves its paths through them — which the tests assert, rather than assume, by
/// requiring `status`'s reported paths to sit under the sandbox root.
pub fn sandbox_env(dir: &Path) -> Vec<(String, String)> {
    let state = dir.join("state");
    let config = dir.join("config");
    let units = dir.join("units");
    for d in [&state, &config, &units] {
        std::fs::create_dir_all(d).expect("sandbox subdirectory");
    }
    vec![
        (
            "DAILY_BRIEFING_STATE_DIR".to_string(),
            state.display().to_string(),
        ),
        ("XDG_CONFIG_HOME".to_string(), config.display().to_string()),
        ("DBA_TEST_UNIT_DIR".to_string(), units.display().to_string()),
    ]
}

/// Like [`ipc_sidecar`], but APPENDS its argv instead of truncating.
///
/// ⚠ THE APPEND IS THE POINT, and it is why this is not a parameter on `ipc_sidecar`. One IPC
/// message used to mean one engine spawn, so recording "the argv" in a truncating write was exact.
/// `state_snapshot` (T11) invokes the engine TWICE — `status --json` then `schedule status --json`
/// — and a truncating fake would report only the second, making "did it read status at all?"
/// unanswerable. Callers of the original keep its exactly-one-argv semantics; this one is for the
/// commands that fan out.
pub fn appending_ipc_sidecar(dir: &Path, name: &str, argv_file: &Path) -> PathBuf {
    let body = format!(
        "printf '%s\\n' \"$@\" >> \"{}\"\ncase \" $* \" in *\" --json \"*) printf '%s' {} ;; esac\nexit 0",
        argv_file.display(),
        sq(&envelope(true, None, 0)),
    );
    fake_sidecar(dir, name, &body)
}

/// A fake engine that answers `status --json` and `schedule status --json` with envelopes SHAPED
/// like the real ones, derived from what is actually on disk under `state_dir`.
///
/// ⚠ IT READS THE STATE DIRECTORY RATHER THAN RETURNING A CONSTANT, because the property
/// `tests/watcher.rs` is testing is that a change on disk reaches the webview — and a fake whose
/// answer never changed would make that test pass while the watcher emitted the same stale payload
/// forever. It still WRITES nothing: `the_watcher_never_writes` hashes the tree around it.
///
/// The fields are the subset `schedule_state::StatusView` / `ScheduleView` read. A fixture
/// mirroring every field of `src/json.ts`'s `StatusReport` would be a second, rotting copy of the
/// engine's schema — the same call `common::envelope` already makes.
///
/// ⚠ LIKE THE ENGINE, IT RECOMPUTES THE PER-READ FACTS ON EVERY CALL (`src/schedule/status.ts`):
/// `ticksToday` is the heartbeat's count when its `local=` date is today (by `date`, in the local
/// zone), `0` for a parsed line from another day, and `null` for a legacy or absent one; and
/// `registered` is `false` while the file [`unloaded_flag`] names exists — OUTSIDE the state
/// directory, because a real `launchctl bootout` writes nothing the watcher can see.
pub fn state_sidecar(
    dir: &Path,
    name: &str,
    state_dir: &Path,
    argv_file: Option<&Path>,
) -> PathBuf {
    let record = argv_file
        .map(|p| format!("printf '%s\\n' \"$@\" >> \"{}\"\n", p.display()))
        .unwrap_or_default();
    let state = state_dir.display();
    let unloaded = unloaded_flag(dir, name);
    let unloaded = unloaded.display();
    let body = format!(
        r#"{record}STATE="{state}"
today="$(date +%Y-%m-%d)"
registered=true
[ -f "{unloaded}" ] && registered=false
run_date=""
[ -f "$STATE/last-run" ] && run_date="$(head -1 "$STATE/last-run" | tr -d '\n')"
tick_line=""
[ -f "$STATE/last-tick" ] && tick_line="$(head -1 "$STATE/last-tick" | tr -d '\n')"
tick_json=null
tick_state=absent
ticks_today=null
case "$tick_line" in
  "") tick_state=absent ;;
  *" local="*" today="*)
     tick_state=ok
     iso="${{tick_line%% *}}"
     rest="${{tick_line#* local=}}"
     local_date="${{rest%% *}}"
     count="${{tick_line##*today=}}"
     tick_json="{{\"iso\":\"$iso\",\"localDate\":\"$local_date\",\"count\":$count}}"
     if [ "$local_date" = "$today" ]; then ticks_today=$count; else ticks_today=0; fi
     ;;
  *) tick_state=legacy ;;
esac
mtime=null
[ -f "$STATE/briefing-latest.md" ] && mtime='"2026-09-16T07:24:00.000Z"'
skip=null
[ -f "$STATE/last-skip.json" ] && skip="$(cat "$STATE/last-skip.json")"
record_present=false
[ -f "$STATE/schedule.json" ] && record_present=true
case "$1:$2" in
  status:--json)
    printf '%s' "{{\"schemaVersion\":1,\"engineVersion\":\"0.1.1\",\"platform\":\"darwin\",\"paths\":{{\"stateDir\":\"$STATE\",\"configPath\":\"$STATE/config.json\",\"markerPath\":\"$STATE/last-run\",\"tickPath\":\"$STATE/last-tick\",\"latestBriefingPath\":\"$STATE/briefing-latest.md\",\"briefingsDir\":\"$STATE/briefings\",\"lastSkipPath\":\"$STATE/last-skip.json\",\"schedulePath\":\"$STATE/schedule.json\"}},\"configExists\":true,\"configError\":null,\"lastRunDate\":$([ -n "$run_date" ] && printf '"%s"' "$run_date" || printf null),\"lastSkip\":$skip,\"lastTick\":$tick_json,\"latestBriefingMtime\":$mtime,\"archivedDates\":[],\"logBytes\":null,\"morningTime\":{{\"value\":\"07:20\",\"minutes\":440,\"warning\":null}},\"isPastFloor\":true}}"
    ;;
  schedule:status)
    printf '%s' "{{\"schemaVersion\":1,\"engineVersion\":\"0.1.1\",\"platform\":\"darwin\",\"registered\":$registered,\"recordPresent\":$record_present,\"unitPresent\":$record_present,\"owner\":\"app\",\"invoker\":\"app\",\"kind\":\"launchd\",\"unitPath\":\"$STATE/units/local.daily-briefing.plist\",\"installedAt\":\"2026-09-01T00:00:00.000Z\",\"installedEngineVersion\":\"0.1.1\",\"lingerState\":\"not-applicable\",\"lastTickState\":\"$tick_state\",\"lastTick\":$tick_json,\"ticksToday\":$ticks_today,\"ticksExpectedSinceFloor\":11,\"lastDelivery\":null,\"lastSkip\":$skip,\"morningTime\":{{\"value\":\"07:20\",\"minutes\":440,\"warning\":null}},\"isPastFloor\":true,\"intervalSec\":600,\"experimental\":false,\"paths\":{{\"schedulePath\":\"$STATE/schedule.json\",\"unitPaths\":[]}}}}"
    ;;
esac
exit 0"#
    );
    fake_sidecar(dir, name, &body)
}

/// The flag file that makes [`state_sidecar`] `name` in `dir` report `registered: false` — the
/// stand-in for a unit that was unloaded behind the app's back.
pub fn unloaded_flag(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.unloaded"))
}

/// A fake engine for T17's access snapshot: `status --json` names `config_path`, `doctor --json`
/// prints the repo rows in `doctor_repos_json` VERBATIM, and `schedule status --json` reports
/// `bin_path` (or `null` when it is `None`).
///
/// ⚠ THE DOCTOR ROWS ARE THE TEST'S OWN JSON, not a shape invented here, because what
/// `access::scope_of` reads is the ENGINE's `advice` string — `warnFor(issue)` verbatim — and a fake
/// that generated its own wording would let the app's rendering drift from the engine's while every
/// assertion stayed green. `gui/tests-web/access.check.ts` is where that string is compared against
/// `warnFor()` itself.
///
/// Every path it reports is the caller's, so no test using it can reach a real protected folder.
pub fn access_sidecar(
    dir: &Path,
    name: &str,
    config_path: &Path,
    doctor_repos_json: &str,
    bin_path: Option<&Path>,
    argv_file: &Path,
) -> PathBuf {
    let config = config_path.display();
    let bin = match bin_path {
        Some(p) => format!("\\\"{}\\\"", p.display()),
        None => "null".to_string(),
    };
    let body = format!(
        r#"printf '%s\n' "$@" >> "{argv}"
CONFIG="{config}"
case "$1:$2" in
  status:--json)
    printf '%s' "{{\"schemaVersion\":1,\"engineVersion\":\"0.1.1\",\"platform\":\"darwin\",\"paths\":{{\"stateDir\":\"$(dirname "$CONFIG")\",\"configPath\":\"$CONFIG\",\"markerPath\":\"$(dirname "$CONFIG")/last-run\",\"tickPath\":\"$(dirname "$CONFIG")/last-tick\",\"latestBriefingPath\":\"$(dirname "$CONFIG")/briefing-latest.md\",\"briefingsDir\":\"$(dirname "$CONFIG")/briefings\",\"lastSkipPath\":\"$(dirname "$CONFIG")/last-skip.json\",\"schedulePath\":\"$(dirname "$CONFIG")/schedule.json\"}},\"configExists\":true,\"configError\":null,\"lastRunDate\":null,\"lastSkip\":null,\"lastTick\":null,\"latestBriefingMtime\":null,\"archivedDates\":[],\"logBytes\":null,\"morningTime\":{{\"value\":\"07:20\",\"minutes\":440,\"warning\":null}},\"isPastFloor\":true}}"
    ;;
  doctor:--json)
    printf '%s' {repos}
    ;;
  schedule:status)
    printf '%s' "{{\"schemaVersion\":1,\"engineVersion\":\"0.1.1\",\"platform\":\"darwin\",\"registered\":true,\"recordPresent\":true,\"unitPresent\":true,\"owner\":\"app\",\"invoker\":\"app\",\"kind\":\"launchd\",\"unitPath\":\"$(dirname "$CONFIG")/units/local.daily-briefing.plist\",\"binPath\":{bin},\"installedAt\":\"2026-09-01T00:00:00.000Z\",\"installedEngineVersion\":\"0.1.1\",\"lingerState\":\"not-applicable\",\"lastTickState\":\"absent\",\"lastTick\":null,\"ticksToday\":null,\"ticksExpectedSinceFloor\":null,\"lastDelivery\":null,\"lastSkip\":null,\"morningTime\":{{\"value\":\"07:20\",\"minutes\":440,\"warning\":null}},\"isPastFloor\":true,\"intervalSec\":600,\"experimental\":false,\"paths\":{{\"schedulePath\":\"$(dirname "$CONFIG")/schedule.json\",\"unitPaths\":[]}}}}"
    ;;
esac
exit 0"#,
        argv = argv_file.display(),
        repos = sq(&format!(
            "{{\"schemaVersion\":1,\"engineVersion\":\"0.1.1\",\"config\":{{\"exists\":true,\"valid\":true,\"errors\":[],\"warnings\":[]}},\"repos\":{doctor_repos_json},\"discoveredCount\":0,\"reposTimedOut\":false,\"provider\":{{\"cli\":\"claude\",\"found\":true,\"path\":\"/usr/bin/claude\",\"hardeningAvailable\":true,\"flags\":[],\"anomalies\":[]}},\"network\":{{\"hostsConfigured\":1,\"enabled\":true,\"reachable\":true,\"waitedMs\":1}},\"power\":{{\"fullyAwake\":true}},\"verdict\":\"blocked\"}}"
        )),
    );
    fake_sidecar(dir, name, &body)
}

/// [`access_sidecar`], except `doctor --json` answers with the CURRENT CONTENT of `doctor_file` —
/// a WHOLE doctor envelope the test writes and rewrites between calls. Exists for the sequences a
/// fixed fake cannot play: the post-update check across a repo walk that TIMES OUT on one call and
/// finishes on the next (`reposTimedOut` flips, the repo rows change).
pub fn access_sidecar_doctor_file(
    dir: &Path,
    name: &str,
    config_path: &Path,
    doctor_file: &Path,
    bin_path: Option<&Path>,
    argv_file: &Path,
) -> PathBuf {
    let config = config_path.display();
    let bin = match bin_path {
        Some(p) => format!("\\\"{}\\\"", p.display()),
        None => "null".to_string(),
    };
    let body = format!(
        r#"printf '%s\n' "$@" >> "{argv}"
CONFIG="{config}"
case "$1:$2" in
  status:--json)
    printf '%s' "{{\"schemaVersion\":1,\"engineVersion\":\"0.1.1\",\"platform\":\"darwin\",\"paths\":{{\"stateDir\":\"$(dirname "$CONFIG")\",\"configPath\":\"$CONFIG\",\"markerPath\":\"$(dirname "$CONFIG")/last-run\",\"tickPath\":\"$(dirname "$CONFIG")/last-tick\",\"latestBriefingPath\":\"$(dirname "$CONFIG")/briefing-latest.md\",\"briefingsDir\":\"$(dirname "$CONFIG")/briefings\",\"lastSkipPath\":\"$(dirname "$CONFIG")/last-skip.json\",\"schedulePath\":\"$(dirname "$CONFIG")/schedule.json\"}},\"configExists\":true,\"configError\":null,\"lastRunDate\":null,\"lastSkip\":null,\"lastTick\":null,\"latestBriefingMtime\":null,\"archivedDates\":[],\"logBytes\":null,\"morningTime\":{{\"value\":\"07:20\",\"minutes\":440,\"warning\":null}},\"isPastFloor\":true}}"
    ;;
  doctor:--json)
    cat "{doctor}"
    ;;
  schedule:status)
    printf '%s' "{{\"schemaVersion\":1,\"engineVersion\":\"0.1.1\",\"platform\":\"darwin\",\"registered\":true,\"recordPresent\":true,\"unitPresent\":true,\"owner\":\"app\",\"invoker\":\"app\",\"kind\":\"launchd\",\"unitPath\":\"$(dirname "$CONFIG")/units/local.daily-briefing.plist\",\"binPath\":{bin},\"installedAt\":\"2026-09-01T00:00:00.000Z\",\"installedEngineVersion\":\"0.1.1\",\"lingerState\":\"not-applicable\",\"lastTickState\":\"absent\",\"lastTick\":null,\"ticksToday\":null,\"ticksExpectedSinceFloor\":null,\"lastDelivery\":null,\"lastSkip\":null,\"morningTime\":{{\"value\":\"07:20\",\"minutes\":440,\"warning\":null}},\"isPastFloor\":true,\"intervalSec\":600,\"experimental\":false,\"paths\":{{\"schedulePath\":\"$(dirname "$CONFIG")/schedule.json\",\"unitPaths\":[]}}}}"
    ;;
esac
exit 0"#,
        argv = argv_file.display(),
        doctor = doctor_file.display(),
    );
    fake_sidecar(dir, name, &body)
}

/// A fake engine for B5's file reads and config saves: `status --json` reports `state_dir` and
/// `config_path` as the engine's paths, and `config validate --json --file <f>` answers from the
/// candidate's CONTENT, the way the real validator answers from its fields:
///
/// * a candidate containing `__invalid__` → `valid: false`, one error (on `lookbackCapDays`);
/// * one containing `__warn__` → `valid: true`, one warning (on `morningTime`);
/// * one containing `__garbage__` → exit 0 with stdout that is not JSON;
/// * anything else → `valid: true`, no notes.
///
/// Two behaviours stand in for the world outside the app:
/// * a candidate containing `__rewrite__` → before answering, the fake copies
///   `<record_dir>/rewrite-with.json` over `config_path` IN PLACE — an editor saving the file while
///   the app is validating (the only thing that makes the fake touch `config_path`);
/// * while `<record_dir>/slow-validate` exists, each validation holds a `validating` marker in
///   `record_dir` for one second and appends `overlap` to `overlap.txt` if it finds another
///   validation's marker already there.
///
/// ⚠ IT RECORDS WHAT IT WAS ASKED TO VALIDATE, in `record_dir`: every argv (appended to
/// `argv.txt`), and the candidate's PATH (`validated-paths.txt`), BYTES (`validated-<n>.json`,
/// copied while the file still exists) and permission bits with its directory's
/// (`validated-modes.txt`, `<file> <dir>` in octal) — so a test can assert the candidate lived under
/// the app's candidate directory, owner-only, held exactly the bytes that were then written, and was
/// removed afterwards. It writes nothing anywhere else.
pub fn files_sidecar(
    dir: &Path,
    name: &str,
    state_dir: &Path,
    config_path: &Path,
    record_dir: &Path,
) -> PathBuf {
    let state = state_dir.display();
    let config = config_path.display();
    let rec = record_dir.display();
    let body = format!(
        r#"printf '%s\n' "$@" >> "{rec}/argv.txt"
STATE="{state}"
CONFIG="{config}"
case "$1:$2" in
  status:--json)
    printf '%s' "{{\"schemaVersion\":1,\"engineVersion\":\"0.1.1\",\"platform\":\"darwin\",\"paths\":{{\"stateDir\":\"$STATE\",\"configPath\":\"$CONFIG\",\"markerPath\":\"$STATE/last-run\",\"tickPath\":\"$STATE/last-tick\",\"latestBriefingPath\":\"$STATE/briefing-latest.md\",\"briefingsDir\":\"$STATE/briefings\",\"lastSkipPath\":\"$STATE/last-skip.json\",\"schedulePath\":\"$STATE/schedule.json\"}},\"configExists\":true,\"configError\":null,\"lastRunDate\":null,\"lastSkip\":null,\"lastTick\":null,\"latestBriefingMtime\":null,\"archivedDates\":[],\"logBytes\":null,\"morningTime\":{{\"value\":\"07:20\",\"minutes\":440,\"warning\":null}},\"isPastFloor\":true}}"
    ;;
  config:validate)
    f="$5"
    n="$(ls "{rec}" | grep -c '^validated-[0-9]')"
    printf '%s\n' "$f" >> "{rec}/validated-paths.txt"
    cp "$f" "{rec}/validated-$n.json"
    d="$(dirname "$f")"
    # Portable mode read: GNU `stat -c %a` first, BSD `stat -f %Lp` only when that FAILED, each value
    # captured from one successful command alone. (GNU `stat -f` is --file-system: it prints filesystem
    # info to stdout, so `stat -f ... || stat -c ...` emitted that junk plus the mode on Linux.)
    fm="$(stat -c %a "$f" 2>/dev/null)" || fm="$(stat -f %Lp "$f")"
    dm="$(stat -c %a "$d" 2>/dev/null)" || dm="$(stat -f %Lp "$d")"
    printf '%s %s\n' "$fm" "$dm" >> "{rec}/validated-modes.txt"
    if [ -e "{rec}/slow-validate" ]; then
      [ -e "{rec}/validating" ] && printf 'overlap\n' >> "{rec}/overlap.txt"
      : > "{rec}/validating"
      sleep 1
      rm -f "{rec}/validating"
    fi
    if grep -q '__rewrite__' "$f"; then
      cp "{rec}/rewrite-with.json" "$CONFIG"
    fi
    if grep -q '__garbage__' "$f"; then
      printf '%s' 'this is not JSON'
    elif grep -q '__invalid__' "$f"; then
      printf '%s' '{{"schemaVersion":1,"valid":false,"errors":[{{"field":"lookbackCapDays","message":"config error: \"lookbackCapDays\" must be a positive number"}}],"warnings":[],"normalized":null}}'
    elif grep -q '__warn__' "$f"; then
      printf '%s' '{{"schemaVersion":1,"valid":true,"errors":[],"warnings":[{{"field":"morningTime","message":"morningTime \"25:99\" is not a valid HH:MM; using 07:20"}}],"normalized":{{}}}}'
    else
      printf '%s' '{{"schemaVersion":1,"valid":true,"errors":[],"warnings":[],"normalized":{{}}}}'
    fi
    ;;
esac
exit 0"#
    );
    fake_sidecar(dir, name, &body)
}

/// Every Tauri configuration file sitting in `src-tauri/` OTHER than the single
/// `tauri.conf.json` the suites read, sorted.
///
/// ONE walk, TWO enforcing suites — and by this module's own sharing test (see the module
/// doc), that is exactly what belongs here: `capability.rs` walks the discovered set as the
/// SECURITY angle (plain JSON, bundle-only keys — §15b dev 156) and `packaging.rs` pins the
/// targets authority over the same set, reading one contract from two directions. Both
/// callers first assert the discovered set EQUALS exactly the three recorded platform files
/// (`tauri.linux.conf.json`, `tauri.macos.conf.json`, `tauri.windows.conf.json`), so a
/// neutered walk (empty discovery) fails BOTH suites instead of leaving a vacuous green, and
/// a FOURTH sibling — even a bundle-only one; `tauri.ios.conf.json` is a real merge target
/// (`config/parse.rs:58`) — is refused outright rather than admitted key-bounded (B23
/// round-1 M10/M6: both holes were measured before this was shared).
///
/// Why the walk matters at all — `tauri-utils` `config/parse.rs:180-186`: `read_from` parses
/// `tauri.conf.json` and then JSON-Merge-Patches (RFC 7396) a PLATFORM SIBLING over it —
/// `tauri.{macos,linux,windows,android,ios}.conf.json`, the `.json5` spelling of the same, or
/// `Tauri.<platform>.toml` (`:51-75`) — before anything else (the ACL resolve included) sees
/// the config.
///
/// The match is deliberately WIDER than the upstream name list — any `*.conf.json[5]`, or any
/// `tauri.*.toml` — so a platform Tauri adds later is caught without anyone remembering to
/// edit a hardcoded list here. It is case-insensitive because `does_supported_file_name_exist`
/// (`config/parse.rs:210`) resolves those names with `Path::exists`, which on macOS's and
/// Windows's case-insensitive filesystems matches regardless of case.
pub fn platform_config_siblings_on_disk() -> Vec<String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut out = Vec::new();
    for entry in std::fs::read_dir(root).expect("src-tauri/ is readable") {
        let path = entry.expect("a readable directory entry").path();
        if path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        let is_a_tauri_config = lower.ends_with(".conf.json")
            || lower.ends_with(".conf.json5")
            || (lower.starts_with("tauri.") && lower.ends_with(".toml"));
        if is_a_tauri_config && lower != "tauri.conf.json" {
            out.push(name.to_string());
        }
    }
    out.sort();
    out
}
