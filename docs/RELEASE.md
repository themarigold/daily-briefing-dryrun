# Releasing daily-briefing

> The full runbook (bump, release check, export, tag, verify) is still to be written; this file
> starts with the part every release script builds against: the frozen asset names and the
> bundle-status contract.

## Assets

These names are **frozen**. `gui/scripts/stage-bundles.sh` renames Tauri's outputs into them, and
`scripts/release-collect.sh` refuses any attach set that holds anything else.

| Asset | Name | Source |
|---|---|---|
| CLI binaries (5) | `daily-briefing-darwin-arm64`, `daily-briefing-darwin-x64`, `daily-briefing-linux-x64`, `daily-briefing-linux-arm64`, `daily-briefing-windows-x64.exe` | the release workflow's cross-compile loop, unchanged |
| macOS DMG | `daily-briefing-<v>-darwin-arm64.dmg`, `daily-briefing-<v>-darwin-x64.dmg` | renamed from Tauri's `Daily Briefing_<v>_aarch64.dmg` / `Daily Briefing_<v>_x64.dmg` |
| Linux AppImage | `daily-briefing-<v>-linux-x86_64.AppImage` | renamed from `Daily Briefing_<v>_amd64.AppImage` |
| Linux deb | `daily-briefing_<v>_amd64.deb` | renamed from `Daily Briefing_<v>_amd64.deb` (Debian convention) |
| Checksums | `SHA256SUMS`: every other asset, bare basenames (computed from inside `dist/`), `LC_ALL=C` sorted, never listing itself | `scripts/release-collect.sh` |
| Windows NSIS | none: a workflow artifact only, never attached | — |

`<v>` is plain semver, `X.Y.Z`: the tag without its leading `v`. There is no release-candidate form.

The attach set is the flat directory `dist/`, which holds **only** names from this table. Markers and
release notes never live in `dist/`.

Lowercase, hyphenated, no spaces: the names match the CLI asset convention users already verify
against, and nothing has to cope with a space in an asset name.

Where Tauri writes its outputs: `gui/src-tauri/target/<triple>/release/bundle/{dmg,macos,deb,appimage}/`
for a `tauri build --target <triple>` build (measured for `aarch64-apple-darwin`: the `.app` lands at
`.../bundle/macos/Daily Briefing.app`, and its main executable is `Contents/MacOS/daily-briefing-gui`
beside the sidecar `Contents/MacOS/daily-briefing`). A plain host build (no `--target`) writes the
same tree under `gui/src-tauri/target/release/bundle/`, which is the path the arm64 rows of
`gui/size-budget.json` record.

### Bundle-status contract

Each bundle leg of the release workflow reports what it built through a marker. The workflow and
`scripts/release-collect.sh` are both built against this table.

| Item | Value |
|---|---|
| Legs | `macos-arm64`, `macos-x64`, `linux-x86_64` (**required**: the marker must be present); `windows-x64` (informational) |
| Marker artifact | `marker-<leg>`, uploaded from an `if: always()` step, holding one file `<leg>.status` |
| Marker body | exactly one token and a newline: `built`, `build-failed` or `size-rejected` |
| Derivation | a step with id `marker` and `if: always()`, after `smoke` and before every upload, sets `steps.marker.outputs.status`. It reads `.outcome` (never `.conclusion`) of an enumerated list of step ids and nothing else: `gui-tests`, `build`, `stage`, `size`, `smoke` for the macOS and Linux legs; `build` alone for Windows. None of them carries `continue-on-error`. `steps.size.outcome == 'failure'` → `size-rejected`; all enumerated `success` → `built`; anything else → `build-failed` |
| Bundle artifact | `bundle-<leg>`, uploaded with `if: always() && steps.marker.outputs.status == 'built'`; holds the frozen-name files flat |
| Marker upload | `if: always()`, after the bundle upload |
| Job tail | the macOS legs' keychain cleanup (unconditional `if: always()`) is the last step, outside the derivation |
| CLI artifact | `cli-binaries`, the 5 binaries flat |
| Windows artifact | `windows-nsis`, which matches no download pattern in the release job |
| Release download | `pattern: cli-binaries` and `pattern: bundle-*` into `dist/`; `pattern: marker-*` into `markers/`; all `merge-multiple: true`. The `bundle-*` step (id `dl-bundles`) and the `marker-*` step are `continue-on-error: true`; collect keeps it fail-closed |
| Signing mode | computed **once**, in a `gate` step with id `signing-mode` that evaluates `secrets.DBA_SIGNING_P12 != '' && secrets.DBA_SIGNING_P12_PASSWORD != ''` in its `run:` (never materialising a secret value into env), writes `mode=signed\|unsigned` to `$GITHUB_OUTPUT`, and FAILS with a named error when exactly one secret is set. `gate` exposes it as the job output `signing`; the macOS legs and `release` read `needs.gate.outputs.signing`. The Linux and Windows legs pass the literal `unsigned`. Each macOS leg's smoke step proves its artifact matches the mode (E5), so the notes label cannot disagree with what shipped. The marker body stays one token. Collect receives the mode as its `<signed\|unsigned>` argument. (Beside `signing`, `gate` also exposes the job output `identity`, the signing identity's name from the repo variable `DBA_SIGNING_IDENTITY`; E5.) |
| Notes | rendered from `docs/release-notes.template.md` to a file outside `dist/`, passed with `--notes-file` |

**Collect rules** (`scripts/release-collect.sh <dist> <markers> <version> <signed|unsigned> <dl-bundles-outcome> <notes-out>`),
every one checked, all failures printed, exit 1 if any:

- a required leg's marker absent, or its body not exactly one of the three tokens plus a newline → FAIL;
- `size-rejected` → FAIL;
- `built` ⇒ that leg's frozen names are in `dist/`, else FAIL;
- `build-failed` ⇒ that leg's names are absent (present → FAIL), and the notes name the leg;
- the `dl-bundles` outcome not `success` while any marker says `built` → FAIL (a partial download never
  ships); an outcome that is not `success`, `failure`, `cancelled` or `skipped` → FAIL;
- the windows marker is read for the notes only: absent or any body is never a FAIL;
- any other file in `markers/` → FAIL;
- `dist/` not flat (a subdirectory or link), or holding anything but a frozen name for this version → FAIL,
  named; a Windows installer (`*setup*.exe`, `*.msi`) → FAIL;
- any of the 5 CLI binaries missing → FAIL;
- a signing argument other than exactly `signed` or `unsigned` (an empty value means the gate job's
  output was lost) → FAIL;
- the notes file inside `dist/` → FAIL.

Only on a full pass does it write `dist/SHA256SUMS` and the notes.

### The other release scripts

- `gui/scripts/stage-bundles.sh <bundle-dir> <version> <out-dir> <kinds>` (`<kinds>`: `dmg`, or
  `appimage,deb`): globs each kind **by version**, requires exactly one match, and copies it to its
  frozen name.
- `bun scripts/check-size-budget.ts <path> <budget-row>`: the staged file (or, for an `app-*` row, the
  `.app` directory) against its row in `gui/size-budget.json`: the ceiling where `budgetBytes` is set,
  the symmetric 20% drift where `measuredBytes` is set, existence alone where both are null. An unknown
  row or a missing path fails; nothing is skipped.
- `gui/scripts/ci-tauri-build.sh <rust-target-triple> <signed|unsigned>`: the only way the release
  workflow runs `tauri build`, on every bundle leg. The mode is explicit (never defaulted): `unsigned`
  is ad-hoc on macOS (`APPLE_SIGNING_IDENTITY=-`) and no identity elsewhere; `signed` requires the
  identity the workflow's keychain import put in `APPLE_SIGNING_IDENTITY`, and is refused off macOS. Any
  `APPLE_CERTIFICATE*`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` or `APPLE_API_*` variable arriving
  in its environment is refused; notarization input comes only through `DBA_NOTARIZE_*`, and reaches
  Tauri only as one complete set, in signed mode.
- `scripts/check-versions.sh <version>`: `package.json`, `gui/package.json`,
  `gui/src-tauri/Cargo.toml` and the `daily-briefing-gui` entry of `gui/src-tauri/Cargo.lock` must all
  equal `<version>`, and every `gui/size-budget.json` path carrying a `_X.Y.Z_` version segment must
  carry `_<version>_`. Bundle names take their version from `gui/package.json`, through
  `gui/src-tauri/tauri.conf.json`'s `"version": "../package.json"`.
