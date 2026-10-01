#!/usr/bin/env bash
# nesting-probe.sh — does the macOS signing path cover the NESTED externalBin sidecar? (T23/B23)
#
# THE QUESTION (appendix T23, RISK:HIGH): when a signingIdentity is configured, does
# tauri-bundler sign `Contents/MacOS/daily-briefing` (the sidecar it copied in under the BARE
# name — the `-<triple>` suffix is stripped at copy time, tauri-bundler 2.9.4
# settings.rs::copy_binaries), or does a signed .app ship an unsigned nested Mach-O that fails
# validation on the user's machine?
#
# THE SOURCE ANSWER: the bundler signs it. bundle/macos/app.rs 99-105 pushes every copied
# externalBin as a SignTarget (is_an_executable: true), :107-111 adds the main binary,
# :122-125 pushes the .app itself LAST, and sign.rs :53 iterates IN ORDER — sidecar and main
# binary first, bundle last ("signing must be done inside out", app.rs:120-121). Each target
# gets `codesign --force -s <identity> [--options runtime] [--entitlements <file>]`
# (sign.rs:64-69 → tauri-macos-sign 2.3.4 keychain.rs:221-239); `--options runtime` is
# applied because is_an_executable && hardened_runtime (true in tauri.macos.conf.json), and
# :129 runs `xattr -crs` on the bundle first.
#
# WHAT THIS PROBE PROVES — AND WHAT IT CANNOT (round 1 caught the earlier header
# overclaiming "re-demonstrates MECHANICALLY"). The probe REPLAYS the sequence above ITSELF,
# ad-hoc (`-s -`, no identity exists on this machine), on a SCRATCH COPY of an already-built
# .app, then interrogates the result with codesign. Its green therefore proves the sequence
# is SUFFICIENT — signing exactly {each externalBin, the main binary, the bundle, in that
# order, with those flags} covers the nested sidecar and survives a deep strict verify. It
# does NOT prove that tauri-bundler still PERFORMS that sequence: nothing here reads the
# bundler, so if a tauri bump stopped signing sidecars tomorrow this probe would print the
# same verdict. THAT guarantee is the source leg's — the app.rs/sign.rs cites above — and
# must be RE-READ ON EVERY TAURI BUMP. The scope bails below keep the probe honest about
# file sets the bundler does NOT sign (it would happily sign them itself and green over a
# bundle the real build ships broken). Two negative controls prove the checks can go red:
#   A. strip the sidecar's signature after the full sequence → `--verify --deep` must FAIL
#      (the deep verifier really does look at the nested binary);
#   B. on a FRESH copy, skip the sidecar pre-sign and sign only the bundle → either codesign
#      itself refuses, or the deep verify fails — an unsigned sidecar cannot ride silently.
#      (Whichever way it lands is recorded; both are "cannot ride".)
#
# SCOPE GUARDS: ad-hoc signatures on scratch COPIES under a private temp dir only; the built
# .app is never modified, nothing is installed, nothing is launched, no keychain is touched.
# SCOPE BAILS (exit 2, round 1): the bundler's signing pass covers frameworks, externalBins,
# the main binary and the bundle — NOTHING ELSE. So the probe refuses to run when
# `bundle.macOS.files` is non-empty in the merged conf (copy_custom_files_to_bundle,
# app.rs:183-209, pushes NOTHING into sign_paths — such a Mach-O ships UNSIGNED), when
# Contents/{Plugins,Helpers,XPCServices,Libraries} exist (the bundler's nested-code walk,
# app.rs:44-51, is reachable only from copy_frameworks_to_bundle), when Contents/Frameworks
# is non-empty (unimplemented first member of the sequence), or when Contents/MacOS holds
# any executable beyond the merged conf's externalBin set. What ad-hoc CANNOT answer stays
# registered as VM-gated in docs/gui-seam.md §15c: a real Developer ID chain, notarization,
# and `spctl` ACCEPTANCE (spctl on the unsigned build is a separate read-only floor
# observation).
#
# Usage: bash gui/scripts/nesting-probe.sh "<path to built .app>"

set -euo pipefail

[ "$(uname -s)" = "Darwin" ] && : || { echo "nesting-probe: macOS only (codesign)"; exit 2; }

APP_SRC="${1:-}"
[ -n "$APP_SRC" ] && [ -d "$APP_SRC" ] && [ -f "$APP_SRC/Contents/Info.plist" ] || {
  echo "nesting-probe: pass the path to a built .app (Contents/Info.plist not found under '${APP_SRC:-<missing>}')" >&2
  exit 2
}

SRC_TAURI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../src-tauri" && pwd)"
ENTITLEMENTS="$SRC_TAURI/entitlements.plist"
[ -f "$ENTITLEMENTS" ] || { echo "nesting-probe: $ENTITLEMENTS is missing" >&2; exit 2; }

# SCOPE BAIL 1 (conf): the bundler NEVER signs a Mach-O placed via bundle.macOS.files
# (copy_custom_files_to_bundle, app.rs:183-209, pushes nothing into sign_paths) — but this
# probe, which enumerates from the filesystem, WOULD sign it and go green over a bundle the
# real build ships broken. Refuse to run if the merged conf (base + macos sibling, RFC 7396
# semantics at this key) carries any files entry. The same read yields the merged
# externalBin basenames (the bundler strips the -<triple> suffix at copy time — §15b dev
# 154), which the enumeration below is checked against.
command -v python3 >/dev/null 2>&1 || { echo "nesting-probe: python3 is required for the merged-conf scope check" >&2; exit 2; }
CONF_SCOPE="$(/usr/bin/env python3 - "$SRC_TAURI" <<'PY'
import json, os, sys

root = sys.argv[1]
def load(name):
    with open(os.path.join(root, name)) as f:
        return json.load(f)

base = load("tauri.conf.json")
plat = load("tauri.macos.conf.json")

def mac_section(conf):
    b = conf.get("bundle")
    m = b.get("macOS") if isinstance(b, dict) else None
    return m if isinstance(m, dict) else {}

# RFC 7396 at bundle.macOS.files: a platform object merges per-key over the base (a null
# member deletes); a platform null deletes the whole key; a non-object replaces it.
base_files = mac_section(base).get("files")
merged = dict(base_files) if isinstance(base_files, dict) else {}
plat_mac = mac_section(plat)
if "files" in plat_mac:
    pf = plat_mac["files"]
    if pf is None:
        merged = {}
    elif isinstance(pf, dict):
        for k, v in pf.items():
            if v is None:
                merged.pop(k, None)
            else:
                merged[k] = v
    else:
        merged = {"<non-object files value>": pf}
print(len(merged))

# bundle.externalBin: arrays replace wholesale under a merge patch.
plat_bundle = plat.get("bundle") if isinstance(plat.get("bundle"), dict) else {}
base_bundle = base.get("bundle") if isinstance(base.get("bundle"), dict) else {}
if "externalBin" in plat_bundle:
    ext = plat_bundle["externalBin"]
else:
    ext = base_bundle.get("externalBin")
for e in sorted(os.path.basename(e) for e in (ext or [])):
    print(e)
PY
)"
FILES_COUNT="$(printf '%s\n' "$CONF_SCOPE" | head -n 1)"
EXPECTED_SIDECARS="$(printf '%s\n' "$CONF_SCOPE" | tail -n +2)"
[ "$FILES_COUNT" = "0" ] || {
  echo "nesting-probe: bundle.macOS.files is non-empty in the merged conf ($FILES_COUNT entries) — the bundler never signs those files (app.rs:183-209), so this probe cannot vouch for the bundle; extend the probe first" >&2
  exit 2
}

SCRATCH="$(mktemp -d -t b23-nesting-probe)"
trap 'rm -rf "$SCRATCH"' EXIT
APP="$SCRATCH/probe/$(basename "$APP_SRC")"
mkdir -p "$SCRATCH/probe"
cp -R "$APP_SRC" "$APP"

MAIN_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
[ -n "$MAIN_NAME" ] || { echo "nesting-probe: no CFBundleExecutable" >&2; exit 2; }

# Frameworks would be signed FIRST (app.rs:93-95). This bundle ships none; if one ever
# appears, extend this probe rather than silently skipping a member of the sequence.
if [ -d "$APP/Contents/Frameworks" ] && [ -n "$(ls -A "$APP/Contents/Frameworks")" ]; then
  echo "nesting-probe: Contents/Frameworks is non-empty — extend the probe to sign frameworks first (app.rs:93-95)" >&2
  exit 2
fi

# SCOPE BAIL 2 (bundle layout): the bundler's nested-code walk (NESTED_CODE_FOLDER,
# app.rs:44-51) is reachable only from copy_frameworks_to_bundle — code that lands in these
# folders any other way is never signed by the bundler, so a probe green over it would lie.
for d in Plugins Helpers XPCServices Libraries; do
  if [ -d "$APP/Contents/$d" ]; then
    echo "nesting-probe: Contents/$d exists — the bundler signs nested code there only via copy_frameworks_to_bundle (app.rs:44-51); extend the probe before trusting any verdict" >&2
    exit 2
  fi
done

# The sidecar set, enumerated from the FILESYSTEM (every regular executable in
# Contents/MacOS that is not the main executable) — NOT from the bundler, which derives its
# SignTargets from the externalBins it copies (app.rs:99-105). MUST be non-empty — this app
# ships exactly one externalBin, so an empty enumeration means the probe is broken (wrong
# path, renamed binary), not that there is nothing to check. And it must match the merged
# conf's externalBin set EXACTLY (scope bail 3 below): an extra executable here is one the
# bundler never signed, and this probe signing it would prove nothing about the real build.
SIDECARS=()
while IFS= read -r f; do
  [ "$(basename "$f")" = "$MAIN_NAME" ] && continue
  SIDECARS+=("$f")
done < <(find "$APP/Contents/MacOS" -type f -perm +111 | sort)
[ "${#SIDECARS[@]}" -ge 1 ] || {
  echo "nesting-probe: enumerated ZERO sidecars in Contents/MacOS (main: $MAIN_NAME) — the probe found nothing to probe" >&2
  exit 1
}

# SCOPE BAIL 3 (exact set): enumerated executables == merged conf's externalBin basenames.
ENUMERATED="$(for s in "${SIDECARS[@]}"; do basename "$s"; done | sort)"
[ "$ENUMERATED" = "$EXPECTED_SIDECARS" ] || {
  echo "nesting-probe: Contents/MacOS executables do not match the merged conf's externalBin set — enumerated: [$(printf '%s' "$ENUMERATED" | tr '\n' ' ')] expected: [$(printf '%s' "$EXPECTED_SIDECARS" | tr '\n' ' ')]. The bundler signs only externalBins it copied (app.rs:99-105); an extra Mach-O here (bundle.macOS.files? a stray copy?) ships unsigned and this probe cannot vouch for it" >&2
  exit 2
}

sign_one() { codesign --force -s - --options runtime --entitlements "$ENTITLEMENTS" "$1"; }

echo "== probe: bundler sequence (ad-hoc) on scratch copy"
echo "   main:     $MAIN_NAME"
for s in "${SIDECARS[@]}"; do echo "   sidecar:  ${s#"$APP/"}"; done

# The bundler's order: xattr -crs on the bundle (app.rs:127-129), then sidecars, main binary,
# bundle last (sign_paths order; sign.rs:53 iterates in order).
xattr -crs "$APP"
for s in "${SIDECARS[@]}"; do sign_one "$s"; done
sign_one "$APP/Contents/MacOS/$MAIN_NAME"
sign_one "$APP"

echo "== assert: nested sidecar carries the ad-hoc + runtime signature AND the entitlements"
for s in "${SIDECARS[@]}"; do
  INFO="$(codesign -dv --verbose=4 "$s" 2>&1)"
  echo "$INFO" | grep -q "^Signature=adhoc$" || { echo "FAIL: sidecar not ad-hoc signed:"; echo "$INFO"; exit 1; }
  echo "$INFO" | grep -q "flags=.*runtime" || { echo "FAIL: sidecar lacks the runtime flag:"; echo "$INFO"; exit 1; }
  # The entitlements must have LANDED, not merely been passed: a file codesign silently
  # ignored would leave the flags green and the blob absent (round 1).
  codesign -d --entitlements :- "$s" 2>/dev/null | grep -q "com.apple.security.app-sandbox" || {
    echo "FAIL: sidecar's entitlements did not land (no app-sandbox key in the embedded blob): ${s#"$APP/"}"
    exit 1
  }
  echo "   ${s#"$APP/"}: $(echo "$INFO" | grep '^CodeDirectory')"
done

echo "== assert: the signed bundle passes a deep, strict verify"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 || { echo "FAIL: deep verify of the bundler-sequence copy failed"; exit 1; }
echo "   codesign -dv on the bundle:"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E '^(Identifier|Format|Signature|CodeDirectory|flags)' | sed 's/^/   /' || true

echo "== negative control A: strip the sidecar signature → deep verify must FAIL"
codesign --remove-signature "${SIDECARS[0]}"
if codesign --verify --deep --strict "$APP" 2>/dev/null; then
  echo "FAIL: deep verify PASSED over an unsigned nested sidecar — the check proves nothing"
  exit 1
fi
echo "   red as required (deep verify rejects the stripped sidecar)"

echo "== negative control B: fresh copy, bundle signed WITHOUT pre-signing the sidecar"
APP_B="$SCRATCH/probe-b/$(basename "$APP_SRC")"
mkdir -p "$SCRATCH/probe-b"
cp -R "$APP_SRC" "$APP_B"
xattr -crs "$APP_B"
B_SIGN_RC=0
B_SIGN_OUT="$(sign_one "$APP_B" 2>&1)" || B_SIGN_RC=$?
if [ "$B_SIGN_RC" -ne 0 ]; then
  echo "   codesign on the bundle itself REFUSED (rc=$B_SIGN_RC): $(echo "$B_SIGN_OUT" | head -2)"
else
  if codesign --verify --deep --strict "$APP_B" 2>/dev/null; then
    echo "FAIL: bundle-only signing produced a deep-verifiable app over an unsigned sidecar"
    exit 1
  fi
  echo "   bundle sign succeeded but deep verify is red — unsigned sidecar cannot ride silently"
fi

echo "PROBE VERDICT: the replayed sequence (sidecar first, bundle last) covers the nested"
echo "externalBin; both negative controls are red. This proves the sequence SUFFICIENT — that"
echo "tauri-bundler still PERFORMS it is the source leg (app.rs/sign.rs cites in the header;"
echo "re-read on every tauri bump). Real-identity + spctl-acceptance legs are VM-gated"
echo "(docs/gui-seam.md §15c)."
