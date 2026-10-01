//! T23 (B23) — per-platform packaging config, signing parameterization and the size budget
//! (docs/gui-seam.md §15).
//!
//! The per-platform bundle targets live in PLATFORM-SPECIFIC CONF FILES
//! (`tauri.macos.conf.json` / `tauri.linux.conf.json` / `tauri.windows.conf.json`), merged
//! over `tauri.conf.json` by JSON Merge Patch (RFC 7396 — tauri-utils 2.9.3
//! `config/parse.rs:185`, `json_patch::merge`; arrays replace wholesale). That is the shape
//! T24's CI matrix drives: every job runs a plain `tauri build [--target <triple>]` and the
//! conf — not a per-job `--bundles` flag — says what a platform ships. Because a merge patch
//! lets ANY key in a platform file silently override the base on that platform only, these
//! tests pin the EXACT key sets of all three platform files, not just the values they carry.
//!
//! What is asserted here:
//!   * base `tauri.conf.json` carries NO `bundle.targets` — the platform files are the only
//!     authority (a base value would be dead config that springs to life when a platform file
//!     is deleted; the absence pin plus the exact-three sibling SET-EQUALITY pin — the shared
//!     discovery walk in `tests/common/mod.rs`, also asserted by `capability.rs`'s security
//!     angle — make both a missing file AND a fourth sibling visible);
//!   * macOS ships `["app","dmg"]`, built separately per arch (NOT universal — §15a), with
//!     the DMG geometry EXACTLY as the B22 handoff drew the background for (§14a: window
//!     660×400, app at (180,210), Applications at (480,210) — y differs from the bundler's
//!     170 default, so an explicit pin is load-bearing), and the @1x background committed by
//!     B22 (the retina choice is §15b's deviation 151);
//!   * Linux ships `["appimage","deb"]`, Windows `["nsis"]` with the downloaded-bootstrapper
//!     WebView2 mode (CI-only experimental — appendix binding C3);
//!   * signing is PARAMETERIZED AND EMPTY: `signingIdentity` present-as-null (unsigned build
//!     today — tauri-bundler 2.9.4 `sign.rs:19-44` returns no keychain when the identity is
//!     None and `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD` are absent, which are the CI
//!     secret names T24 wires), `hardenedRuntime` true, and an entitlements file that is
//!     EXPLICITLY not-sandboxed and carries NO hardened-runtime exceptions (§15b);
//!   * `bundle.licenseFile` stays ABSENT in EVERY conf file — B22's pin (`icons.rs`, dev 149)
//!     covers the base conf; a platform file could merge one back in on that platform alone,
//!     which is exactly the drift channel the DMG's `--eula` udifrez LPic panel would ride;
//!   * the committed size budget (`gui/size-budget.json`) parses, carries the appendix
//!     ceilings, and matches a re-stat of every artifact that exists here — SYMMETRICALLY:
//!     recorded actual and on-disk size must sit within the >20% bound of EACH OTHER, so an
//!     inflated baseline cannot disarm the regression gate. A measured row whose path is
//!     missing while its PARENT DIRECTORY exists (`binaries/` for the sidecar) FAILS as
//!     stale — that still catches the version-bump orphan (bundle/dmg/ present, versioned
//!     file gone) while a partial build (`--bundles app`, no dmg/) or a fresh clone skips.
//!     libtest swallows stdout on pass, so no claim rests on a printed skip.
//!     `measuredBytes: null` rows are ceiling-only (no builder for that platform/arch on
//!     this machine — §15c). The >20% regression predicate is unit-tested on both sides of
//!     its boundary.
//!
//! CI wiring of the budget (fail the release job on regression) is T24's, in `publish/` only.
//! The nested-sidecar signing PROBE is `gui/scripts/nesting-probe.sh` — a floor observation
//! over a built .app, not a committed test (§14c's convention for bundle-content legs).

mod common;

use std::path::{Path, PathBuf};

fn src_tauri(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn conf(rel: &str) -> serde_json::Value {
    let bytes = std::fs::read(src_tauri(rel)).unwrap_or_else(|e| panic!("{rel} is readable: {e}"));
    serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("{rel} is JSON: {e}"))
}

fn keys(v: &serde_json::Value, what: &str) -> Vec<String> {
    v.as_object()
        .unwrap_or_else(|| panic!("{what} is an object"))
        .keys()
        .cloned()
        .collect()
}

/// Base conf: no `bundle.targets` (platform files are the only authority), and the sibling
/// set on disk is EXACTLY the three recorded files. Deleting or renaming a platform file must
/// fail HERE, because at build time it fails nowhere: the schema default (`targets: "all"`
/// semantics) quietly bundles everything, including installers no one budgeted or branded.
/// The set is pinned by EQUALITY over the shared discovery walk (`tests/common/mod.rs` — the
/// same walk `capability.rs`'s security angle asserts against, so the two suites cannot
/// drift apart around it): a FOURTH sibling (`tauri.ios.conf.json` is a real merge target —
/// tauri-utils `config/parse.rs:58`) is an unbudgeted targets channel nothing else on this
/// machine ever reads, and a broken walk fails equality instead of silently checking
/// nothing (B23 round-1 M10/M6).
#[test]
fn the_platform_conf_files_are_the_only_targets_authority() {
    let base = conf("tauri.conf.json");
    assert!(
        base["bundle"].get("targets").is_none(),
        "tauri.conf.json grew a bundle.targets — per-platform targets live ONLY in the \
         tauri.<platform>.conf.json files (§15a); a base value is dead config that takes over \
         when a platform file goes missing"
    );
    assert_eq!(
        common::platform_config_siblings_on_disk(),
        [
            "tauri.linux.conf.json",
            "tauri.macos.conf.json",
            "tauri.windows.conf.json"
        ],
        "the platform conf sibling set drifted off §15a's three files — a missing file means \
         the schema default quietly bundles everything on that platform; an EXTRA sibling is \
         a silent per-platform targets/override channel no other test reads. Extend §15a \
         deliberately or remove the file"
    );
}

/// Every platform file carries EXACTLY the keys §15a records — a JSON Merge Patch means any
/// extra key here silently overrides the base conf on that platform only, which is the least
/// visible drift channel this repo has.
#[test]
fn the_platform_conf_files_carry_exactly_the_recorded_keys() {
    for (rel, bundle_keys) in [
        ("tauri.macos.conf.json", vec!["macOS", "targets"]),
        ("tauri.linux.conf.json", vec!["targets"]),
        ("tauri.windows.conf.json", vec!["targets", "windows"]),
    ] {
        let c = conf(rel);
        let mut top = keys(&c, rel);
        top.sort();
        assert_eq!(
            top,
            vec!["$schema", "bundle"],
            "{rel} top-level keys drifted — every key here overrides the base conf on this \
             platform via merge patch; extend §15a deliberately or remove the key"
        );
        let mut b = keys(&c["bundle"], &format!("{rel} bundle"));
        b.sort();
        assert_eq!(
            b, bundle_keys,
            "{rel} bundle keys drifted (same merge-patch hazard)"
        );
    }
}

#[test]
fn the_per_platform_targets_are_the_recorded_ones() {
    let expect = [
        ("tauri.macos.conf.json", vec!["app", "dmg"]),
        ("tauri.linux.conf.json", vec!["appimage", "deb"]),
        ("tauri.windows.conf.json", vec!["nsis"]),
    ];
    for (rel, want) in expect {
        let c = conf(rel);
        let got: Vec<&str> = c["bundle"]["targets"]
            .as_array()
            .unwrap_or_else(|| panic!("{rel} bundle.targets is an array"))
            .iter()
            .map(|v| v.as_str().expect("targets entries are strings"))
            .collect();
        assert_eq!(got, want, "{rel} bundle.targets drifted off §15a's set");
    }
}

/// The DMG geometry is the §14a handoff, verbatim: the background was DRAWN for window
/// 660×400 with the app icon footprint centered at (180,210) and the Applications drop link
/// at (480,210) — the arrow spans exactly that gap, so moving any number here means
/// regenerating `branding/dmg-background.svg` first. The y=210 pins are load-bearing against
/// the bundler defaults (170); the 660×400 pin is load-bearing against a future bundler
/// default change. The background is B22's @1x PNG (retina choice recorded as deviation 151);
/// its 660×400 pixel dimensions are pinned by `icons.rs`. Icon size is NOT configurable in
/// DmgConfig (tauri-utils 2.9.3) — the 128px the handoff names is `bundle_dmg`'s own default
/// (`ICON_SIZE=128`, tauri-bundler 2.9.4 `dmg/bundle_dmg:27`), measured, nothing to pin here.
#[test]
fn the_dmg_wiring_is_the_b22_handoff() {
    let c = conf("tauri.macos.conf.json");
    let dmg = &c["bundle"]["macOS"]["dmg"];
    assert_eq!(
        dmg["background"].as_str(),
        Some("branding/dmg-background.png"),
        "dmg background must be B22's @1x asset (§14a handoff; deviation 151)"
    );
    assert!(
        src_tauri("branding/dmg-background.png").is_file(),
        "the wired dmg background asset is missing"
    );
    assert_eq!(
        (
            dmg["windowSize"]["width"].as_u64(),
            dmg["windowSize"]["height"].as_u64()
        ),
        (Some(660), Some(400)),
        "dmg window size must stay the geometry the background was drawn for (§14a)"
    );
    assert_eq!(
        (
            dmg["appPosition"]["x"].as_u64(),
            dmg["appPosition"]["y"].as_u64()
        ),
        (Some(180), Some(210)),
        "dmg app position must stay the §14a handoff (the arrow points at this footprint)"
    );
    assert_eq!(
        (
            dmg["applicationFolderPosition"]["x"].as_u64(),
            dmg["applicationFolderPosition"]["y"].as_u64()
        ),
        (Some(480), Some(210)),
        "dmg Applications position must stay the §14a handoff"
    );
    let mut dmg_keys = keys(dmg, "bundle.macOS.dmg");
    dmg_keys.sort();
    assert_eq!(
        dmg_keys,
        vec![
            "appPosition",
            "applicationFolderPosition",
            "background",
            "windowSize"
        ],
        "bundle.macOS.dmg keys drifted — §15a records exactly the handoff geometry"
    );
}

/// Signing is parameterized and EMPTY: `signingIdentity` is PRESENT AS NULL (the recorded
/// "this is the parameterization point" marker — a CI leg either fills it or imports a
/// certificate via the `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD` env pair, which
/// tauri-bundler consumes with a null identity: sign.rs:19-36), `hardenedRuntime` stays true
/// (--options runtime at sign time), and the entitlements file is wired. Today, with no
/// identity and no certificate env, the build is UNSIGNED — exactly as before this change.
///
/// ⚠ THE RFC 7396 NULL-DELETE TRAP (round 1): a null in a merge patch DELETES the key
/// (`json-patch` `lib.rs:672-674`), so `signingIdentity: null` does NOT survive the merge —
/// the merged config simply lacks the key (behaviourally identical today: `Option` → None) —
/// and it would silently DELETE an identity someone later puts in the BASE `tauri.conf.json`,
/// yielding an unsigned macOS build with no error. The marker exists in the FILE only. Safe
/// fill routes: the `APPLE_SIGNING_IDENTITY` env var (wins outright — tauri-cli
/// `rust.rs:1467-1475`), `--config` (merged strictly after the platform file), or the
/// certificate pair above. The base-conf route is the trapped one; don't use it.
#[test]
fn the_signing_parameters_are_present_and_empty() {
    let c = conf("tauri.macos.conf.json");
    let mac = &c["bundle"]["macOS"];
    let mac_keys = {
        let mut k = keys(mac, "bundle.macOS");
        k.sort();
        k
    };
    assert_eq!(
        mac_keys,
        vec!["dmg", "entitlements", "hardenedRuntime", "signingIdentity"],
        "bundle.macOS keys drifted off §15a's recorded set"
    );
    assert!(
        mac.get("signingIdentity").is_some() && mac["signingIdentity"].is_null(),
        "signingIdentity must be PRESENT AND NULL — present so the parameterization point \
         stays recorded, null so today's build stays unsigned (§15a)"
    );
    assert_eq!(
        mac["hardenedRuntime"].as_bool(),
        Some(true),
        "hardenedRuntime must stay true — the sign step's --options runtime depends on it"
    );
    assert_eq!(
        mac["entitlements"].as_str(),
        Some("entitlements.plist"),
        "entitlements wiring drifted"
    );
}

/// The entitlements file says NOT SANDBOXED explicitly, and carries NO hardened-runtime
/// exception entitlements — the hardened-runtime question for the Bun sidecar
/// (`disable-library-validation`, possibly `allow-jit`) is deliberately deferred, and it
/// re-opens at the FIRST SIGNED BUILD, not the notarization pass: `sign.rs:68` applies
/// `--options runtime` plus this file to every executable target the moment ANY identity
/// exists, including CI's self-signed certificate — spk-2's G8 is the recorded check (§15b
/// dev 153). A key added here would ride into every signed build unexamined. One
/// `com.apple.security.` occurrence total: the explicit app-sandbox=false.
///
/// AND NO `--` SEQUENCE OUTSIDE COMMENT DELIMITERS (dev 153, corrected in round 1): AMFI's
/// entitlements parser rejects a literal `--` INSIDE an XML comment (`AMFIUnserializeXML:
/// syntax error`) while `plutil -lint` passes the same file — comments themselves are fine
/// (measured: 12 codesign-green comment variants incl. repo-style headers; only `--`
/// reproduces the error). The natural phrasing for THIS file (`codesign --options runtime`,
/// `--eula`) is exactly the trap, so the pin is mechanical: strip the `<!--`/`-->`
/// delimiters, then no `--` may remain anywhere. A header comment that avoids `--` is
/// permitted.
#[test]
fn the_entitlements_are_not_sandboxed_and_carry_no_exceptions() {
    let text = std::fs::read_to_string(src_tauri("entitlements.plist"))
        .expect("entitlements.plist is readable");
    let without_delimiters = text.replace("<!--", "").replace("-->", "");
    assert!(
        !without_delimiters.contains("--"),
        "entitlements.plist carries a `--` sequence outside comment delimiters — AMFI \
         rejects `--` inside an XML comment while plutil -lint passes it (§15b dev 153), \
         and nothing before the first signed build would catch it; write flag pairs without \
         the double hyphen (e.g. 'codesign options runtime')"
    );
    let body = text
        .split("<plist")
        .nth(1)
        .expect("entitlements.plist carries a <plist> element");
    let normalized: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        normalized.contains("<key>com.apple.security.app-sandbox</key> <false/>"),
        "entitlements must EXPLICITLY set com.apple.security.app-sandbox to false (§15a); \
         got: {normalized}"
    );
    assert_eq!(
        body.matches("com.apple.security.").count(),
        1,
        "the plist body carries an entitlement beyond the explicit app-sandbox=false — \
         hardened-runtime exceptions are the notarization pass's deliberate decision (§15b), \
         not a default to accrete"
    );
}

/// `bundle.licenseFile` stays absent in EVERY conf file. `icons.rs` pins the base conf
/// (dev 149); a platform file could merge it back in on one platform only — the macOS file
/// is the live hazard (the DMG target is exactly where `--eula` → udifrez LPic bites).
#[test]
fn no_conf_file_reintroduces_the_license_file() {
    for rel in [
        "tauri.conf.json",
        "tauri.macos.conf.json",
        "tauri.linux.conf.json",
        "tauri.windows.conf.json",
    ] {
        let c = conf(rel);
        assert!(
            c.get("bundle").and_then(|b| b.get("licenseFile")).is_none(),
            "{rel} carries bundle.licenseFile — the click-through DMG EULA (dev 149) must \
             not return via a platform merge patch; reintroduction is a recorded decision, \
             not drift"
        );
    }
}

/// Windows ships NSIS with the downloaded-bootstrapper WebView2 mode (smallest installer;
/// CI-only experimental per binding C3). `silent: true` is the tauri-utils default made
/// explicit — the platform file is the record, not the schema's memory.
#[test]
fn the_windows_webview_mode_is_the_downloaded_bootstrapper() {
    let c = conf("tauri.windows.conf.json");
    let mode = &c["bundle"]["windows"]["webviewInstallMode"];
    assert_eq!(
        mode["type"].as_str(),
        Some("downloadBootstrapper"),
        "webviewInstallMode drifted off the appendix's downloaded-bootstrapper choice"
    );
    assert_eq!(
        mode["silent"].as_bool(),
        Some(true),
        "bootstrapper silent flag drifted"
    );
    let mut win_keys = keys(&c["bundle"]["windows"], "bundle.windows");
    win_keys.sort();
    assert_eq!(
        win_keys,
        vec!["webviewInstallMode"],
        "bundle.windows keys drifted"
    );
    // Below the bundle.windows pin, nothing else on a macOS host ever reads this file
    // (read_from(Target::MacOS) never opens it) — a typo'd key inside webviewInstallMode
    // would otherwise surface first on T24's Windows job (WebviewInstallMode is
    // deny_unknown_fields upstream: loud there, but LATE). Pin the exact set here.
    let mut mode_keys = keys(mode, "bundle.windows.webviewInstallMode");
    mode_keys.sort();
    assert_eq!(
        mode_keys,
        vec!["silent", "type"],
        "webviewInstallMode keys drifted — this host never parses the file at build time, \
         so this pin is its only local reader"
    );
}

// ───────────────────────────── size budget ─────────────────────────────

/// The >20% regression predicate, in ONE place (the JSON carries data, this carries the
/// rule): a current size is a regression iff it exceeds the recorded actual by MORE than 20%.
/// Integer math — no float rounding at the boundary.
fn is_size_regression(measured_bytes: u64, current_bytes: u64) -> bool {
    (current_bytes as u128) * 100 > (measured_bytes as u128) * 120
}

#[test]
fn the_regression_predicate_turns_exactly_past_twenty_percent() {
    // Exactly +20% is NOT a regression ("fail on >20%"), one byte past it is.
    assert!(!is_size_regression(100, 120));
    assert!(is_size_regression(100, 121));
    // Non-decimal-friendly base: 61,810,018 * 1.2 = 74,172,021.6 → 74,172,021 passes,
    // 74,172,022 fails.
    assert!(!is_size_regression(61_810_018, 74_172_021));
    assert!(is_size_regression(61_810_018, 74_172_022));
    // Shrinking is never a regression.
    assert!(!is_size_regression(100, 80));
}

fn budget() -> serde_json::Value {
    let path = src_tauri("../size-budget.json");
    let bytes =
        std::fs::read(&path).unwrap_or_else(|e| panic!("gui/size-budget.json is readable: {e}"));
    serde_json::from_slice(&bytes).expect("gui/size-budget.json is JSON")
}

/// Sum of regular-file bytes under a path — a file is its own size; an .app is the sum over
/// its tree (symlinks not followed; their targets live outside the artifact).
fn artifact_bytes(path: &Path) -> u64 {
    let meta = std::fs::symlink_metadata(path)
        .unwrap_or_else(|e| panic!("{} is statable: {e}", path.display()));
    if meta.is_file() {
        return meta.len();
    }
    let mut total = 0u64;
    for entry in
        std::fs::read_dir(path).unwrap_or_else(|e| panic!("{} is readable: {e}", path.display()))
    {
        let p = entry.expect("dir entry").path();
        let m = std::fs::symlink_metadata(&p).expect("entry statable");
        if m.is_file() {
            total += m.len();
        } else if m.is_dir() {
            total += artifact_bytes(&p);
        } // symlinks: counted as zero — they resolve outside or inside the tree either way
    }
    total
}

/// The budget file's SHAPE and CEILINGS: exactly the recorded rows, each with the four
/// fields, budgets pinned to the appendix numbers (decimal MB — the appendix's sidecar
/// anchor 61,677,922 ≈ 61.7 MB reads decimal), a measured row always names its path and
/// date, and the sidecar block carries both recorded anchors (current measured governs).
#[test]
fn the_size_budget_file_is_schema_valid_and_carries_the_appendix_ceilings() {
    let b = budget();
    let mut top = keys(&b, "size-budget.json");
    top.sort();
    assert_eq!(top, vec!["artifacts", "comment", "sidecar"]);

    let sidecar = &b["sidecar"];
    let mut sc_keys = keys(sidecar, "sidecar");
    sc_keys.sort();
    assert_eq!(
        sc_keys,
        vec![
            "appendixAnchorBytes",
            "b22FloorBytes",
            "measuredAt",
            "measuredBytes",
            "path"
        ],
        "sidecar block fields drifted — every other object in this file is pinned exactly; \
         an unrecognized key (say ignoreRegression) would be dead data nothing enforces"
    );
    assert_eq!(
        sidecar["appendixAnchorBytes"].as_u64(),
        Some(61_677_922),
        "the appendix anchor is a recorded constant (appendix T23); it does not move"
    );
    assert_eq!(
        sidecar["b22FloorBytes"].as_u64(),
        Some(61_810_018),
        "B22's floor measurement is a recorded constant; it does not move"
    );
    assert!(
        sidecar["measuredBytes"].is_u64(),
        "sidecar.measuredBytes is measured here"
    );
    assert!(sidecar["path"].is_string() && sidecar["measuredAt"].is_string());

    let artifacts = b["artifacts"].as_object().expect("artifacts is an object");
    let expected_budgets: &[(&str, Option<u64>)] = &[
        ("app-aarch64-apple-darwin", None),
        ("app-x86_64-apple-darwin", None),
        ("dmg-aarch64-apple-darwin", Some(45_000_000)),
        ("dmg-x86_64-apple-darwin", Some(45_000_000)),
        ("deb-x86_64-unknown-linux-gnu", Some(80_000_000)),
        ("appimage-x86_64-unknown-linux-gnu", Some(160_000_000)),
        ("nsis-x86_64-pc-windows-msvc", Some(70_000_000)),
    ];
    let mut got: Vec<&String> = artifacts.keys().collect();
    got.sort();
    let mut want: Vec<&str> = expected_budgets.iter().map(|(k, _)| *k).collect();
    want.sort();
    assert_eq!(
        got, want,
        "artifact row set drifted — extend §15a deliberately"
    );

    for (key, want_budget) in expected_budgets {
        let row = &artifacts[*key];
        let mut row_keys = keys(row, key);
        row_keys.retain(|k| k != "note");
        row_keys.sort();
        assert_eq!(
            row_keys,
            vec!["budgetBytes", "measuredAt", "measuredBytes", "path"],
            "{key}: row fields drifted"
        );
        match want_budget {
            Some(ceiling) => assert_eq!(
                row["budgetBytes"].as_u64(),
                Some(*ceiling),
                "{key}: budget ceiling drifted off the appendix number"
            ),
            None => assert!(
                row["budgetBytes"].is_null(),
                "{key}: budgetBytes must be LITERALLY null (informational row — no appendix \
                 ceiling); any other non-u64 value would silently satisfy an \
                 as_u64()==None comparison"
            ),
        }
        if row["measuredBytes"].is_u64() {
            assert!(
                row["path"].is_string() && row["measuredAt"].is_string(),
                "{key}: a measured row must name its artifact path and measurement date"
            );
        } else {
            assert!(
                row["measuredBytes"].is_null(),
                "{key}: measuredBytes is bytes or null, nothing else"
            );
        }
    }
}

/// Re-stat every artifact the budget claims to have measured, on the machine that has it.
///
/// A measured row whose artifact EXISTS must re-stat within the >20% bound IN BOTH
/// DIRECTIONS — current >20% over recorded is a regression; recorded >20% over current is an
/// inflated baseline that would disarm the gate (round-1 M2: only deflation was red before) —
/// and under its ceiling.
///
/// A measured row whose artifact is ABSENT while its artifact ROOT exists
/// (`target/release/bundle`; `binaries/` for the sidecar) FAILS: the row is STALE. The paths
/// carry the version string, so a version bump orphans a row BY CONSTRUCTION, and libtest
/// swallows stdout on passing tests, so a printed "skip" is indistinguishable from
/// enforcement under the floor command (round-1 H1: all three "loud" claims were inverted —
/// zero output ever reached anyone). Only when the root itself is absent (fresh clone —
/// nothing was ever built here) does the row skip; null rows are ceiling-only by design.
/// T24's CI, which builds every artifact, re-measures at release time.
#[test]
fn the_recorded_actuals_match_a_re_stat_of_what_exists_here() {
    let b = budget();
    let gui_dir = src_tauri("..");

    // Symmetric re-stat: recorded and current must be within the >20% bound of EACH OTHER.
    fn assert_close(key: &str, recorded: u64, current: u64) {
        assert!(
            !is_size_regression(recorded, current),
            "{key} regressed >20%: recorded {recorded}, current {current} — shrink the \
             artifact or re-measure deliberately (size-budget.json)"
        );
        assert!(
            !is_size_regression(current, recorded),
            "{key}: recorded actual {recorded} is >20% ABOVE the on-disk {current} — an \
             inflated baseline disarms the regression gate; re-measure honestly"
        );
    }

    // Sidecar first: measured on every machine that ran build-sidecar.sh. `binaries/`
    // existing means sidecars ARE built here, so a missing recorded path is a stale row,
    // not a fresh clone.
    let sidecar = &b["sidecar"];
    let sc_rel = sidecar["path"].as_str().expect("sidecar.path");
    let sc_path = gui_dir.join(sc_rel);
    let sc_measured = sidecar["measuredBytes"]
        .as_u64()
        .expect("sidecar.measuredBytes");
    if sc_path.is_file() {
        let current = artifact_bytes(&sc_path);
        assert_close("sidecar", sc_measured, current);
    } else {
        assert!(
            !src_tauri("binaries").exists(),
            "size-budget.json sidecar row is STALE: src-tauri/binaries exists but the \
             recorded path ({sc_rel}) does not — re-measure and update the row"
        );
        // Fresh clone: build-sidecar.sh never ran here — the one legitimate skip.
    }

    for (key, row) in b["artifacts"].as_object().expect("artifacts") {
        let Some(measured) = row["measuredBytes"].as_u64() else {
            // Ceiling-only row: no builder for this platform/arch on this machine (§15c).
            continue;
        };
        let rel = row["path"].as_str().expect("measured row has a path");
        let path = gui_dir.join(rel);
        if !path.exists() {
            // Gate on the row path's PARENT, not the shared bundle root: a partial build
            // (`--bundles app` with no dmg/) leaves bundle/ present but dmg/ absent, and
            // that row is unbuilt, not stale. The version-bump orphan is still caught —
            // there bundle/dmg/ exists and only the versioned file is gone.
            let parent_exists = path.parent().map(|p| p.exists()).unwrap_or(false);
            assert!(
                !parent_exists,
                "{key} row is STALE: {} exists but the recorded path \
                 ({rel}) does not — the paths carry the version string, so a version bump \
                 orphans a row by construction; re-measure and update size-budget.json",
                path.parent().unwrap().display()
            );
            continue; // That artifact class was never built here (fresh clone or partial build).
        }
        let current = artifact_bytes(&path);
        assert_close(key, measured, current);
        if let Some(ceiling) = row["budgetBytes"].as_u64() {
            assert!(
                current <= ceiling,
                "{key} is over its budget ceiling: {current} > {ceiling}"
            );
        }
    }
}
