//! The `tcc-probe` feature gate: asserted against the BUILT BINARY in both directions, and against
//! the MANIFEST that decides which of those two directions a plain `cargo build` produces.
//!
//! ## Why this file is not `cfg`'d, and why it scans bytes
//!
//! `tests/tcc_probe.rs` tests the probe and is therefore gated on the same feature as the probe —
//! with the feature off it does not compile, and cannot say anything. The property that has to
//! hold in a DEFAULT build is the opposite one: **that the probe is absent**. Only an ungated file
//! can assert that, and only a scan of the linked executable can assert it about the artifact that
//! actually ships rather than about the source that was meant to produce it.
//!
//! So: `binary_does_not_carry_the_probe_flag` runs in a default build and requires the literal
//! `--tcc-probe` to be ABSENT from `daily-briefing-gui`; `binary_carries_the_probe_flag` runs under
//! `--features tcc-probe` and requires it PRESENT. A release build that silently regained the argv
//! surface fails the first; a spike build that silently lost it fails the second. Neither can be
//! satisfied by reading the source.
//!
//! ## The hole those two leave, and the third test that closes it
//!
//! ⚠ Both of the above are `cfg`'d on the feature, and a `cfg` can only ever answer *"given this
//! build configuration, …"*. The configuration itself is chosen by the manifest — so one line,
//! `default = ["tcc-probe"]` under `[features]`, flips **which** of the two runs. A plain
//! `cargo test` then compiles `spike_build` instead of `default_build`, never runs
//! `binary_does_not_carry_the_probe_flag` at all, and reports every test green while the binary a
//! release bundle is made from carries the argv surface. MEASURED before this test existed: with
//! that one line added, `cargo test` was **39 passed / 0 failed** and
//! `strings -a target/debug/daily-briefing-gui | grep -c -- --tcc-probe` was **1**.
//!
//! `the_probe_feature_is_not_a_default_feature` is therefore UNGATED — compiled and run in *both*
//! configurations, because it is the one assertion that must not depend on the thing it is
//! checking. It reads this crate's own `Cargo.toml` and requires that nothing reachable from the
//! `default` feature enables `tcc-probe`. That is a claim about the SOURCE and not about the
//! artifact, which is exactly right for this one: the artifact-level tests are sound, and what was
//! missing was a pin on the input that decides which of them the compiler keeps.
//!
//! ## What the exec test is for
//!
//! The gate's only wiring point is two lines in `src/main.rs`. Deleting them left the entire
//! pre-review suite green — every probe test calls `dispatch` directly — while turning
//! `--tcc-probe <dir>` into an ordinary launch, i.e. a WINDOW. `the_bundled_binary_answers_the_
//! probe_flag` is the test that covers those two lines: it execs the built binary and requires the
//! documented JSON on stdout and exit 0.
//!
//! ⚠ It is deliberately written so that a missing wiring produces a FAILURE and not a hang or a
//! window: the child is spawned (never `output()`-ed, which would block forever on a process that
//! opened a window and waited for events), polled against a deadline, and killed if it expires —
//! and an expiry is a test failure, not a skip. On a headless CI host a Tauri launch dies
//! immediately; on a desktop it would not, which is exactly why the deadline is here and why the
//! seen-red probe for this test is run against a copy whose `run()` has been replaced by an
//! `exit`, never against one that could reach `tauri::Builder`.

#[cfg(not(feature = "tcc-probe"))]
mod default_build {
    /// A default build is what a release bundle is. It must not carry the probe's argv surface.
    #[test]
    fn binary_does_not_carry_the_probe_flag() {
        let bin = env!("CARGO_BIN_EXE_daily-briefing-gui");
        let bytes = std::fs::read(bin).expect("the built binary is readable");
        assert!(
            !super::contains(&bytes, b"--tcc-probe"),
            "{bin} contains the literal --tcc-probe in a DEFAULT build: the cfg gate on \
             src/probe.rs, src/lib.rs or src/main.rs is gone, and the shipped app has a second \
             argv mode nobody reviewed"
        );
    }
}

#[cfg(feature = "tcc-probe")]
mod spike_build {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    /// How long the probe may take to print one JSON object and exit. Generous by two orders of
    /// magnitude for the work it does; short enough that a wiring regression fails a suite rather
    /// than wedging it.
    const PROBE_DEADLINE: Duration = Duration::from_secs(20);

    /// The other direction of the gate: with the feature ON the surface must be there, or the
    /// spike bundle the VM legs are built from would answer nothing.
    #[test]
    fn binary_carries_the_probe_flag() {
        let bin = env!("CARGO_BIN_EXE_daily-briefing-gui");
        let bytes = std::fs::read(bin).expect("the built binary is readable");
        assert!(
            super::contains(&bytes, b"--tcc-probe"),
            "{bin} was built with --features tcc-probe but does not contain the flag"
        );
    }

    /// A scratch directory removed on every exit path, panics included.
    ///
    /// Deliberately simpler than `tests/tcc_probe.rs`'s namesake, which also has to restore mode
    /// bits on the way down: nothing here ever chmods, so a plain `remove_dir_all` in `Drop` is
    /// the whole job. Two short guards in two integration-test binaries, rather than a
    /// `tests/common/` module for one of them to pull in the other's chmod walk.
    struct ScratchDir {
        path: std::path::PathBuf,
    }

    impl ScratchDir {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("a clock after 1970")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "daily-briefing-tcc-gate-{tag}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("scratch dir");
            Self { path }
        }

        fn join(&self, name: &str) -> std::path::PathBuf {
            self.path.join(name)
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.path).ok();
        }
    }

    #[test]
    fn the_bundled_binary_answers_the_probe_flag() {
        // The whole body used to remove this directory with a bare call placed between the child's
        // exit and the assertions; every `expect` before that line leaked it. `Drop` does not care
        // where the test stops.
        let scratch = ScratchDir::new("exec");
        let dir = &scratch.path;
        std::fs::write(scratch.join("a-file"), b"x").expect("a file to list");

        let out_path = scratch.join("stdout.json");
        let out_file = std::fs::File::create(&out_path).expect("a file to capture stdout");

        // stdout goes to a FILE rather than a pipe: with a pipe, killing a child that never
        // exited would leave the read blocked, which is the hang this test exists to avoid.
        let mut child = Command::new(env!("CARGO_BIN_EXE_daily-briefing-gui"))
            .arg("--tcc-probe")
            .arg(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(out_file))
            .stderr(Stdio::null())
            .spawn()
            .expect("the built binary is executable");

        let deadline = Instant::now() + PROBE_DEADLINE;
        let status = loop {
            match child.try_wait().expect("try_wait") {
                Some(status) => break Some(status),
                None if Instant::now() >= deadline => {
                    child.kill().ok();
                    child.wait().ok();
                    break None;
                }
                None => std::thread::sleep(Duration::from_millis(25)),
            }
        };

        let mut stdout = String::new();
        std::fs::File::open(&out_path)
            .expect("the captured stdout")
            .read_to_string(&mut stdout)
            .expect("the captured stdout is text");

        let status = status.unwrap_or_else(|| {
            panic!(
                "the binary did not exit within {PROBE_DEADLINE:?} for `--tcc-probe <dir>`. \
                 src/main.rs's dispatch wiring is the first thing to check: without it this argv \
                 falls through to run() and the process waits on a window. stdout so far: \
                 {stdout:?}"
            )
        });
        assert_eq!(
            status.code(),
            Some(0),
            "`--tcc-probe <readable dir>` must exit 0; stdout was {stdout:?}"
        );

        let value: serde_json::Value = serde_json::from_str(stdout.trim())
            .unwrap_or_else(|e| panic!("stdout was not one JSON object ({e}): {stdout:?}"));
        let object = value.as_object().expect("a JSON object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        // The same key set `tests/tcc_probe.rs` pins on the in-process path, asserted here on the
        // path the VM operator actually uses: argv → binary → stdout.
        assert_eq!(
            keys,
            vec![
                "app",
                "bundleId",
                "child",
                "childExit",
                "childStderr",
                "dir",
                "executable"
            ]
        );
        assert_eq!(object["app"], "ok");
        assert_eq!(
            object["child"], "ok",
            "stderr was: {}",
            object["childStderr"]
        );
    }
}

/// Naive substring search over the binary's bytes. `memmem` would be a dependency for one call.
#[allow(dead_code)]
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

// ── the ungated pin ─────────────────────────────────────────────────────────────────────────────
// Everything below is compiled in BOTH configurations. See the "hole" section of the module doc.

/// The `[features]` table of this crate's own manifest: feature name → the features it enables.
///
/// Hand-parsed, and that is a deliberate call rather than laziness. `toml` is in the build graph
/// (via `tauri-build`) but not in ours; adding it as a `[dev-dependencies]` entry to read one table
/// would put a parser, its `serde` derive and three transitive crates into every `cargo test` of
/// this crate so that a 40-line scanner could be deleted. The input is not arbitrary TOML either —
/// it is a cargo feature table, whose values are arrays of bare double-quoted identifiers. The
/// scanner handles comments, single- and multi-line arrays, and quoted keys; it does NOT handle
/// escaped quotes inside strings, which a feature name cannot contain.
///
/// The parser's own failure mode is the dangerous one — a scanner that silently finds nothing
/// makes the assertion below vacuous — so the test cross-checks that it found `tcc-probe` itself
/// before believing anything about `default`.
fn feature_table(manifest: &str) -> std::collections::BTreeMap<String, Vec<String>> {
    // 1. Strip `#` comments, but not a `#` inside a quoted string.
    let mut stripped = String::with_capacity(manifest.len());
    for line in manifest.lines() {
        let mut quote: Option<char> = None;
        for ch in line.chars() {
            match quote {
                Some(q) => {
                    stripped.push(ch);
                    if ch == q {
                        quote = None;
                    }
                }
                None => {
                    if ch == '#' {
                        break;
                    }
                    if ch == '"' || ch == '\'' {
                        quote = Some(ch);
                    }
                    stripped.push(ch);
                }
            }
        }
        stripped.push('\n');
    }

    // 2. Keep only the body of the `[features]` table.
    let mut section = String::new();
    let mut inside = false;
    for line in stripped.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && !trimmed.starts_with("[[") {
            // A sub-table header (`[features.x]`) is not how cargo features are written; treating
            // it as "no longer the plain table" is the conservative reading either way.
            inside = trimmed == "[features]";
            continue;
        }
        if inside {
            section.push_str(line);
            section.push('\n');
        }
    }

    // 3. `key = [ "a", "b" ]`, arrays possibly spanning lines.
    let chars: Vec<char> = section.chars().collect();
    let mut table = std::collections::BTreeMap::new();
    let mut i = 0usize;
    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        let key_start = i;
        while i < chars.len() && chars[i] != '=' && chars[i] != '\n' {
            i += 1;
        }
        if i >= chars.len() || chars[i] == '\n' {
            continue; // not a `key = value` line; the outer loop resyncs on the next one
        }
        let key: String = chars[key_start..i]
            .iter()
            .collect::<String>()
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .to_string();
        i += 1; // past '='
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        let mut values: Vec<String> = Vec::new();
        if i < chars.len() && chars[i] == '[' {
            let mut depth = 0usize;
            let mut quote: Option<char> = None;
            let mut current = String::new();
            while i < chars.len() {
                let ch = chars[i];
                i += 1;
                match quote {
                    Some(q) if ch == q => {
                        values.push(std::mem::take(&mut current));
                        quote = None;
                    }
                    Some(_) => current.push(ch),
                    None => match ch {
                        '[' => depth += 1,
                        ']' => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        '"' | '\'' => quote = Some(ch),
                        _ => {}
                    },
                }
            }
        }
        table.insert(key, values);
    }
    table
}

/// Every feature of THIS crate that a plain `cargo build` turns on, `default` included.
///
/// Transitive on purpose: `default = ["spike"]` with `spike = ["tcc-probe"]` ships the probe just
/// as surely as naming it directly, and a test that only looked at `default`'s own array would
/// pass over it.
fn features_enabled_by_default(
    table: &std::collections::BTreeMap<String, Vec<String>>,
) -> std::collections::BTreeSet<String> {
    let mut reached = std::collections::BTreeSet::new();
    let mut pending: Vec<String> = table.get("default").cloned().unwrap_or_default();
    while let Some(feature) = pending.pop() {
        // `dep:x` activates an optional dependency and `pkg/feat` a dependency's feature; neither
        // names a feature of this crate, so neither can reach `tcc-probe` from here.
        if feature.starts_with("dep:") || feature.contains('/') {
            continue;
        }
        if !reached.insert(feature.clone()) {
            continue;
        }
        if let Some(enables) = table.get(&feature) {
            pending.extend(enables.iter().cloned());
        }
    }
    reached
}

/// The probe must not be reachable from the `default` feature set, in either build configuration.
///
/// This is the assertion the two `cfg`'d tests above cannot make, because the manifest line that
/// would break them is the same line that decides which of them is compiled.
#[test]
fn the_probe_feature_is_not_a_default_feature() {
    let manifest_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let manifest = std::fs::read_to_string(&manifest_path)
        .unwrap_or_else(|e| panic!("{} is readable: {e}", manifest_path.display()));
    let table = feature_table(&manifest);

    // The scanner's self-check, and it comes FIRST. Without it, a parse that found an empty table
    // would satisfy the real assertion below for the worst possible reason.
    assert!(
        table.contains_key("tcc-probe"),
        "the [features] scanner did not find `tcc-probe` in {} — it parsed {} feature(s): {:?}. \
         The assertion below would have passed vacuously, so this is a broken test, not a clean \
         manifest.",
        manifest_path.display(),
        table.len(),
        table.keys().collect::<Vec<_>>()
    );

    let enabled = features_enabled_by_default(&table);
    assert!(
        !enabled.contains("tcc-probe"),
        "`tcc-probe` is reachable from the `default` feature in {} (default enables {:?}). A plain \
         `cargo build` would then ship the probe's argv surface, and `cargo test` would compile \
         `binary_does_not_carry_the_probe_flag` OUT rather than fail it — the whole suite stays \
         green while the guarantee is gone. Remove it from `default`; spike bundles pass \
         `--features tcc-probe` explicitly.",
        manifest_path.display(),
        enabled
    );
}
