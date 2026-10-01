//! T22 (B22) — the icon set, the menubar TEMPLATE icons and the license wiring, asserted at the
//! byte level (docs/gui-seam.md §14).
//!
//! Everything under `icons/` and the PNGs under `branding/` are DERIVED — regenerated
//! deterministically from the three hand-authored SVG sources by
//! `gui/scripts/generate-branding.sh`, whose `--check` mode is the regeneration-idempotence
//! assertion (fresh regeneration must be byte-identical to the committed files). That check is
//! PART OF THIS SUITE on macOS (`regeneration_check_gate`) — the only OS whose renderers can
//! run it, and nothing else runs it at all (CI is ubuntu-only and runs no cargo). The rest of
//! these tests assert the properties of what is COMMITTED, so a deleted, truncated, or
//! wrong-format derived file fails on every OS even without the script (a hand-edit that
//! keeps the container well-formed — e.g. corrupted IDAT behind an intact magic + IEND — is
//! caught only by the macOS gate):
//!
//!   * the `.icns` really contains every size slot macOS wants, in the canonical sorted element
//!     order deviation 147 promises (a byte-level container walk, not `iconutil` — no
//!     subprocess, no tool version in the loop);
//!   * every icon `tauri.conf.json` references exists on disk AND is a complete file of its
//!     claimed format — and so is every OTHER committed file under `icons/` (the Windows/Store
//!     tiles no build here consumes; existence alone let a zero-byte tile ride to bundle day);
//!   * the menubar template PNGs are genuinely BLACK + ALPHA ONLY — any non-black RGB under
//!     nonzero alpha is the "amateur menubar icon" the appendix warns about, shipped by accident;
//!   * the license really is wired to land inside the .app (`bundle.resources` map), and the file
//!     the wiring points at really is the MIT text. The resources map is the ONLY license
//!     wiring: the macOS .app bundler has no license handling of its own (measured,
//!     tauri-bundler 2.9.4), and `bundle.licenseFile` is DELIBERATELY ABSENT — dmg is a macOS
//!     target via `tauri.macos.conf.json` (§15a; B23 removed the base `targets`), and there it
//!     would ship a click-through DMG EULA (§14b dev 149);
//!   * the bundle identifier stays the R1-frozen one, on the DEFAULT test flavor (the
//!     `tcc_probe.rs` pin of the same constant is feature-gated).
//!
//! The VISUAL legs (light/dark/tinted menubar, busy wallpaper, DMG layout) are VM-gated and
//! registered in §14c, not faked here.

use std::path::{Path, PathBuf};

fn src_tauri(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn read(rel: &str) -> Vec<u8> {
    std::fs::read(src_tauri(rel)).unwrap_or_else(|e| panic!("{rel} is readable: {e}"))
}

/// A PNG whose bytes are COMPLETE: the leading magic AND the trailing empty IEND chunk. The
/// magic and IHDR live in the first bytes, so "starts like a PNG" survives truncation
/// (measured: mutation B22-5's 100-byte truncation did exactly that); a PNG's LAST chunk is
/// always the empty IEND, so requiring it is the cheap totality witness.
fn assert_png_complete(what: &str, bytes: &[u8]) {
    assert!(
        bytes.len() > 24 && bytes[..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A],
        "{what} is not a PNG"
    );
    assert!(
        bytes.ends_with(&[0x00, 0x00, 0x00, 0x00, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82]),
        "{what} does not end with the IEND chunk — truncated or trailing-garbage PNG"
    );
}

/// Walk an ICNS container and return its element type codes, validating the container shape as
/// it goes (magic, header length, per-element bounds). A zeroed or truncated container fails
/// the header-length check before any element is read.
fn icns_element_types(what: &str, bytes: &[u8]) -> Vec<String> {
    assert!(
        bytes.len() >= 8,
        "{what}: icns too short: {} bytes",
        bytes.len()
    );
    assert_eq!(&bytes[0..4], b"icns", "{what}: icns magic");
    let total = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    assert_eq!(
        total,
        bytes.len(),
        "{what}: icns header length matches the file"
    );
    let mut types = Vec::new();
    let mut off = 8;
    while off < bytes.len() {
        assert!(
            off + 8 <= bytes.len(),
            "{what}: truncated element header at {off}"
        );
        let ty = String::from_utf8_lossy(&bytes[off..off + 4]).into_owned();
        let len = u32::from_be_bytes([
            bytes[off + 4],
            bytes[off + 5],
            bytes[off + 6],
            bytes[off + 7],
        ]) as usize;
        assert!(
            len >= 8 && off + len <= bytes.len(),
            "{what}: element '{ty}' has bad length {len} at {off}"
        );
        types.push(ty);
        off += len;
    }
    types
}

/// Walk an ICO directory and validate that every image entry's claimed data range lies inside
/// the file. The magic and directory live in the first bytes and the image data at the end, so
/// magic alone survives truncation — the bounds are the totality witness, derived from the
/// file's own claims rather than an arbitrary size floor.
fn assert_ico_complete(what: &str, bytes: &[u8]) {
    assert!(
        bytes.len() >= 6,
        "{what}: too short for an ICO header: {} bytes",
        bytes.len()
    );
    assert_eq!(
        &bytes[0..4],
        &[0x00, 0x00, 0x01, 0x00],
        "{what}: ICO magic (reserved=0, type=1)"
    );
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    assert!(count > 0, "{what}: ICO carries zero images");
    assert!(
        bytes.len() >= 6 + 16 * count,
        "{what}: ICO directory truncated ({count} entries claimed, {} bytes)",
        bytes.len()
    );
    for i in 0..count {
        let e = 6 + 16 * i;
        let size =
            u32::from_le_bytes([bytes[e + 8], bytes[e + 9], bytes[e + 10], bytes[e + 11]]) as usize;
        let off = u32::from_le_bytes([bytes[e + 12], bytes[e + 13], bytes[e + 14], bytes[e + 15]])
            as usize;
        assert!(
            size > 0 && off >= 6 + 16 * count && off + size <= bytes.len(),
            "{what}: ICO entry {i} claims bytes {off}..{} outside the file ({} bytes)",
            off + size,
            bytes.len()
        );
    }
}

/// Dispatch a committed icon asset to its format's completeness check by extension.
fn assert_icon_asset_complete(what: &str, path: &Path, bytes: &[u8]) {
    match path.extension().and_then(|e| e.to_str()) {
        Some("png") => assert_png_complete(what, bytes),
        Some("icns") => {
            let types = icns_element_types(what, bytes);
            assert!(!types.is_empty(), "{what}: icns carries zero elements");
        }
        Some("ico") => assert_ico_complete(what, bytes),
        other => panic!(
            "{what} has unexpected extension {other:?} — the pipeline ships only png/icns/ico; \
             extend this dispatch deliberately"
        ),
    }
}

/// Every size slot a macOS app icon wants, present in the generated `.icns` — and the element
/// sequence pinned EXACTLY to deviation 147's canonical order (sorted by four-byte type code;
/// `icns-canonical.ts`). The table is the full 16/32/128/256/512pt ladder at @1x and @2x: the
/// 16 and 32 @1x slots ride in the legacy 24-bit types (`is32`/`il32`, each with its 8-bit
/// mask), everything else in the PNG-bearing `ic*` types. `tauri icon` 2.11.4 emits exactly
/// these twelve elements in hash-map order; the pipeline sorts them so regeneration is
/// byte-stable (§14a). The presence loop gives the per-slot diagnostics; the sequence assert
/// kills a reordered or junk-element container the slot check alone would pass.
#[test]
fn the_icns_carries_every_required_size() {
    let types = icns_element_types("icons/icon.icns", &read("icons/icon.icns"));
    let required: &[(&str, &str)] = &[
        ("is32", "16×16 @1x (24-bit)"),
        ("s8mk", "16×16 @1x alpha mask"),
        ("ic11", "16×16 @2x"),
        ("il32", "32×32 @1x (24-bit)"),
        ("l8mk", "32×32 @1x alpha mask"),
        ("ic12", "32×32 @2x"),
        ("ic07", "128×128 @1x"),
        ("ic13", "128×128 @2x"),
        ("ic08", "256×256 @1x"),
        ("ic14", "256×256 @2x"),
        ("ic09", "512×512 @1x"),
        ("ic10", "512×512 @2x"),
    ];
    for (ty, what) in required {
        assert!(
            types.iter().any(|t| t == ty),
            "icon.icns is missing '{ty}' ({what}); it carries {types:?}"
        );
    }
    let canonical = [
        "ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14", "il32", "is32", "l8mk",
        "s8mk",
    ];
    assert_eq!(
        types, canonical,
        "icon.icns element sequence is not deviation 147's canonical sorted order — \
         regenerate via gui/scripts/generate-branding.sh; never hand-edit the container"
    );
}

/// Every path `bundle.icon` names exists on disk AND is a complete file of its claimed format,
/// and the list still carries the two platform-required container formats. The conf ships
/// inside the binary, but the bundler resolves this list against the filesystem at bundle time
/// — and it does not validate content, so a zero-byte or truncated icon is a shipped-broken
/// artifact, not a bundle-day error.
#[test]
fn every_icon_the_conf_references_exists() {
    let conf: serde_json::Value =
        serde_json::from_slice(&read("tauri.conf.json")).expect("tauri.conf.json is JSON");
    let list = conf["bundle"]["icon"]
        .as_array()
        .expect("bundle.icon is an array");
    assert!(!list.is_empty(), "bundle.icon is empty");
    for entry in list {
        let rel = entry.as_str().expect("bundle.icon entries are strings");
        assert!(
            src_tauri(rel).is_file(),
            "bundle.icon references '{rel}', which does not exist under src-tauri/"
        );
        assert_icon_asset_complete(rel, Path::new(rel), &read(rel));
    }
    for must in ["icons/icon.icns", "icons/icon.ico"] {
        assert!(
            list.iter().any(|e| e.as_str() == Some(must)),
            "bundle.icon no longer lists {must} — macOS/Windows lose their container format"
        );
    }
}

/// EVERY committed file under `icons/` is a complete, well-formed asset — not just the five
/// the conf references. The Windows/Store tiles (`Square*`, `StoreLogo`) and `64x64.png` are
/// consumed only by bundlers this repo does not build today (§14c), so nothing else would
/// notice a zeroed or truncated tile before a store submission. readdir, not a name list: a
/// list drifts when the pipeline's output set changes; the per-extension format checks do not.
/// (A DELETED file is invisible to readdir — that is `regeneration_check_gate`'s kill: the
/// script enumerates the derived set and `--check` fails on a missing destination.)
#[test]
fn every_committed_icon_is_complete_and_well_formed() {
    let mut seen = 0usize;
    for entry in std::fs::read_dir(src_tauri("icons")).expect("icons/ is readable") {
        let path = entry.expect("icons/ entry is readable").path();
        let what = format!(
            "icons/{}",
            path.file_name()
                .expect("icons/ entry has a name")
                .to_string_lossy()
        );
        // Finder's .DS_Store (and any other dotfile) is machine noise, not a shipped asset —
        // git never tracks one here, and the pipeline never emits one.
        if what.starts_with("icons/.") {
            continue;
        }
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{what} is readable: {e}"));
        assert_icon_asset_complete(&what, &path, &bytes);
        seen += 1;
    }
    assert!(seen > 0, "icons/ is empty");
}

/// The bundle identifier is the R1-frozen `com.themarigold.daily-briefing`, asserted on the
/// DEFAULT test flavor. `tests/tcc_probe.rs` pins the same constant against its compiled-in
/// `BUNDLE_ID`, but that whole file is feature-gated (`--features tcc-probe`), so before this
/// test an identifier edit survived the default `cargo test` floor.
#[test]
fn the_bundle_identifier_is_the_r1_frozen_one() {
    let conf: serde_json::Value =
        serde_json::from_slice(&read("tauri.conf.json")).expect("tauri.conf.json is JSON");
    assert_eq!(
        conf["identifier"].as_str(),
        Some("com.themarigold.daily-briefing"),
        "identifier drifted off the R1-frozen bundle id (plan:25; §14a) — the appendix's \
         dev.dailybriefing.app is SUPERSEDED and must not return"
    );
}

/// The menubar TEMPLATE icons are BLACK + ALPHA ONLY: every pixel with nonzero alpha has
/// r = g = b = 0, with the antialiasing carried entirely in the alpha channel. macOS recolours
/// template images for light, dark and tinted menu bars (`shell.rs` sets
/// `icon_as_template(true)`); one colored pixel and the recolouring ships a wrong-in-dark-mode
/// icon — the appendix's "immediate 'this is amateur' signal". Dimensions are pinned to the
/// MEASURED 18pt the tray actually renders at (tray-icon 0.24.2 forces menu-bar images to 18pt
/// logical height — §14b dev 146), so 18px @1x / 36px @2x are pixel-perfect.
#[test]
fn the_menubar_template_icons_are_black_plus_alpha_only() {
    for (rel, side) in [
        ("icons/tray-template.png", 18u32),
        ("icons/tray-template@2x.png", 36u32),
    ] {
        let bytes = read(rel);
        let img = tauri::image::Image::from_bytes(&bytes)
            .unwrap_or_else(|e| panic!("{rel} decodes as PNG: {e}"));
        assert_eq!(
            (img.width(), img.height()),
            (side, side),
            "{rel} dimensions"
        );
        let rgba = img.rgba();
        let mut visible = 0usize;
        for (i, px) in rgba.as_chunks::<4>().0.iter().enumerate() {
            let (r, g, b, a) = (px[0], px[1], px[2], px[3]);
            if a > 0 {
                visible += 1;
                assert!(
                    r == 0 && g == 0 && b == 0,
                    "{rel}: pixel {i} is rgba({r},{g},{b},{a}) — a template icon must be \
                     black+alpha only (regenerate via gui/scripts/generate-branding.sh; never \
                     hand-edit the PNG)"
                );
            }
        }
        assert!(visible > 0, "{rel} is fully transparent — no glyph at all");
    }
}

/// The MIT license text is wired to land INSIDE the .app: `bundle.resources` maps the
/// SUB-PROJECT root LICENSE (`daily_briefing_application/LICENSE` — the repo root carries
/// none) to `Contents/Resources/LICENSE`. That map is the ONLY license wiring: the macOS
/// .app bundler has no license handling of its own (measured, §14a), and `bundle.licenseFile`
/// is DELIBERATELY ABSENT — dmg is a macOS target via `tauri.macos.conf.json` (§15a; the base
/// conf carries no `targets` since B23), and tauri-bundler feeds `licenseFile` to the DMG as a
/// click-through EULA (`--eula` → udifrez LPic: an Agree/Disagree panel before the volume even
/// mounts), which a permissive MIT text does not warrant (§14b dev 149; T23 owns any
/// deliberate reintroduction). The pointed-at file must really be the MIT text: a moved or
/// rewritten LICENSE fails here, not on bundle day.
#[test]
fn the_license_is_wired_into_the_bundle() {
    let conf: serde_json::Value =
        serde_json::from_slice(&read("tauri.conf.json")).expect("tauri.conf.json is JSON");
    assert!(
        conf["bundle"].get("licenseFile").is_none(),
        "bundle.licenseFile reappeared — on the default `tauri build` it ships a click-through \
         DMG EULA (§14b dev 149); reintroducing it is T23's deliberate call, not drift"
    );
    assert_eq!(
        conf["bundle"]["resources"]["../../LICENSE"].as_str(),
        Some("LICENSE"),
        "bundle.resources must map the sub-project root LICENSE into \
         Contents/Resources/LICENSE — it is the only wiring that puts the MIT text in the \
         .app (§14a)"
    );
    let license = std::fs::read_to_string(src_tauri("../../LICENSE")).expect("LICENSE is readable");
    assert!(
        license.starts_with("MIT License"),
        "../../LICENSE no longer starts with 'MIT License'"
    );
    assert!(
        license.contains("Permission is hereby granted, free of charge"),
        "../../LICENSE no longer carries the MIT grant text"
    );
}

/// The three hand-authored SVG sources and every committed derived raster exist, at the exact
/// pixel dimensions the pipeline promises (IHDR width/height — a byte read, not a decode) and
/// complete to the trailing IEND. `generate-branding.sh --check` asserts the derived bytes;
/// this asserts presence and shape so a deleted or truncated asset fails in `cargo test` on
/// every OS too. The DMG background is ASSET-ONLY here: T23 wires `bundle.macOS.dmg`
/// (geometry handoff recorded in §14a).
#[test]
fn the_branding_sources_and_derived_rasters_are_present_and_sized() {
    for src in [
        "branding/master.svg",
        "branding/tray-template.svg",
        "branding/dmg-background.svg",
    ] {
        assert!(src_tauri(src).is_file(), "{src} is missing");
    }
    for (rel, w, h) in [
        ("branding/icon-1024.png", 1024u32, 1024u32),
        ("branding/dmg-background.png", 660, 400),
        ("branding/dmg-background@2x.png", 1320, 800),
        ("icons/icon.png", 512, 512),
    ] {
        let bytes = read(rel);
        assert_png_complete(rel, &bytes);
        let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        assert_eq!((width, height), (w, h), "{rel} dimensions");
    }
}

/// §14a's regeneration/idempotence gate, wired into the DEFAULT floor on the only OS that can
/// run it: `--check` regenerates every derived asset into scratch (writing nothing inside the
/// repo) and byte-compares all 22 against the committed files. macOS-gated because the
/// pipeline's renderers are (`sips` exists only on macOS); CI is ubuntu-only and runs no
/// cargo, so before this test NOTHING ran the check — reversed icns element order, a
/// truncated derived PNG or a stale regeneration all survived `cargo test`.
#[cfg(target_os = "macos")]
#[test]
fn regeneration_check_gate() {
    let script = src_tauri("../scripts/generate-branding.sh");
    let out = std::process::Command::new("bash")
        .arg(&script)
        .arg("--check")
        .output()
        .unwrap_or_else(|e| panic!("bash {} --check runs: {e}", script.display()));
    assert!(
        out.status.success(),
        "generate-branding.sh --check failed — the committed derived assets are not what the \
         sources regenerate:\n--- stdout ---\n{}--- stderr ---\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
