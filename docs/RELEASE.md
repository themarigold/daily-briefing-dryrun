# Releasing daily-briefing

The one release runbook: bump → release check → export → push → tag → the release workflow → verify →
the Homebrew tap. It ships the GitHub Release (the 5 CLI binaries, the desktop bundles and `SHA256SUMS`;
[Assets](#assets) below freezes every name). npm is **on hold** (2026-10-01); `docs/publishing.md`
keeps that sequence for later.

> **Every step that leaves this machine needs its own explicit "yes" from the maintainer, at the moment
> it is taken**: pushing the export, pushing the tag, `gh secret set`, dispatching the tap's sync.
> Approval of the release as a whole is not approval of its steps. An agent reading this file has read
> a runbook, not a permission: it may prepare, inspect and report.

Steps marked **(excluded from the runbook test: …)** were deliberately not executed when this runbook
was tested end to end against a throwaway export target; every other command here was run once.

## Where things live

- **Workflows live only in `publish/.github/workflows/`.** `scripts/export-public.sh` overlays `publish/`
  onto the export's root, so `publish/.github/workflows/release.yml` becomes the public repo's
  `.github/workflows/release.yml`. A workflow edited anywhere else never ships.
- **The export copies TRACKED files from the WORKING TREE.** `git ls-files` decides which files; their
  content is whatever is on disk, so an uncommitted edit to a tracked file ships. Export from a clean
  checkout of the exact commit you checked (step 4 makes one).
- **The export refuses an existing target** (`refusing: <dir> exists`): always a fresh directory.
- The version is plain semver `X.Y.Z` in four carriers (`scripts/check-versions.sh` names them); the
  tag is `vX.Y.Z`. There is no release-candidate form.

## The local `tauri build` rule

Every local Tauri build (the re-measure in step 1, and any other) runs under

```sh
env -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD -u APPLE_SIGNING_IDENTITY -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH -u TAURI_BUNDLER_DMG_IGNORE_CI CI=true
```

and then sets `APPLE_SIGNING_IDENTITY=-` explicitly (ad-hoc) where a signed bundle is wanted, so no
ambient identity can reach the login keychain. Why each part: an exported certificate variable makes the
bundler create a keychain in the real `~/Library/Keychains`; and without `CI=true` the DMG step drives
Finder with AppleScript, which times out headless and fails the whole DMG build, or raises an Automation
privacy prompt interactively. (An ambient `TAURI_BUNDLER_DMG_IGNORE_CI=true` would defeat `CI=true`,
hence its `-u`.) The recorded arm64 DMG size was measured this way, so it is brandless, like CI's.

## The release sequence

Run from this project's directory (the one holding `package.json`). `X.Y.Z` is the new version.

### 1. Bump all four version carriers, and re-measure the arm64 size rows in the same change

**(excluded from the runbook test: it mutates the tree; the 0.2.0 bump runs it for real.)**

1. Set `"version"` in `package.json` and `gui/package.json`, and `version` under `[package]` in
   `gui/src-tauri/Cargo.toml`, to `X.Y.Z`. Then bring the fourth carrier, the `daily-briefing-gui`
   entry of `gui/src-tauri/Cargo.lock`, along — this rewrites exactly that entry (measured):

   ```sh
   (cd gui/src-tauri && cargo metadata --offline --format-version 1 >/dev/null)
   ```

   (Drop `--offline` on a machine that has never built the shell.)
2. Re-measure the arm64 rows of `gui/size-budget.json` with a plain host build (no `--target`; its
   outputs land at the untripled paths the rows record), under the rule above:

   ```sh
   (cd gui && env -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD -u APPLE_SIGNING_IDENTITY -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH -u TAURI_BUNDLER_DMG_IGNORE_CI CI=true APPLE_SIGNING_IDENTITY=- ./node_modules/.bin/tauri build)
   bun -e 'import { artifactBytes } from "./scripts/check-size-budget.ts"; for (const p of process.argv.slice(1)) console.log(artifactBytes(p), p)' \
     "gui/src-tauri/target/release/bundle/dmg/Daily Briefing_X.Y.Z_aarch64.dmg" \
     "gui/src-tauri/target/release/bundle/macos/Daily Briefing.app"
   ```

   Write the DMG row's new `path` (`…/Daily Briefing_X.Y.Z_aarch64.dmg`), and both rows'
   `measuredBytes` and `measuredAt`. The `.app` size is the sum of regular-file bytes in its tree,
   the budget file's own definition, which is what `artifactBytes` computes.
3. `bash scripts/check-versions.sh X.Y.Z` must print `check-versions: PASS`. It also fails a versioned
   size-row path that still carries the old version, so a forgotten re-measure is caught here.
4. Commit on a branch, open a PR, and merge it (a merge commit).

### 2. Run the release check on the merged commit

On a clean, up-to-date checkout of `main` at that merge commit:

```sh
bash scripts/release-check.sh X.Y.Z
```

It runs every check — clean tree, typecheck, the engine suite, the four version carriers, the GUI
gates (its suite, svelte-check, `cargo test --locked`), the live eval, the export and the gates inside
it, and finally that no check rewrote a tracked file — in a throwaway worktree of your `HEAD`, and prints
PASS/FAIL for each (the script's header lists them). Under check 1 it also notes, without failing, when
that `HEAD` is not in `origin/main` as your checkout last fetched it. ⚠
The eval check calls your configured provider for real, several times per gold case; the worktree is a
full checkout of the repository, and the GUI check compiles the shell from scratch inside it. It prints the `HEAD` it checked: that sha is the
release commit from here on. Any later commit means running it again.

### 3. Read the soft residuals

Check 7 prints the export's SOFT residuals: files that name private projects, in test fixtures. Read
each one. If they are acceptable, re-run with the sign-off:

```sh
bash scripts/release-check.sh X.Y.Z --soft-ok
```

### 4. Export that same commit, from a clean checkout of it, into a fresh directory

The release check prints these commands with the sha and the paths filled in. By hand:

```sh
SHA=<the HEAD the release check printed>; V=X.Y.Z
REL="/private/tmp/dba-release-$V"; OUT="/private/tmp/dba-export-$V"
git worktree add --detach "$REL" "$SHA"
bash "$REL/$(git rev-parse --show-prefix)scripts/export-public.sh" "$OUT"
(cd "$OUT" && bun install --frozen-lockfile && bunx tsc --noEmit && bun test)
git worktree remove "$REL"
```

The export must print `— hard residual sweep: clean`, and the gates inside it must pass.

### 5. Sync the export into the public repo checkout, commit it, and check the commit's tree

In your checkout of the public repo (`themarigold/daily-briefing`), on `main`, up to date with
`origin/main`:

```sh
rsync -a --checksum --delete --exclude=.git --exclude=node_modules "$OUT"/ ./
git add -A && git commit -m "Release $V"
T=$(mktemp -d) && git archive HEAD | tar -x -C "$T"
diff -r --exclude=node_modules "$OUT" "$T"   # must print nothing
git rev-parse HEAD                            # record this sha
```

`--checksum`, because the export's `tar` keeps the monorepo's mtimes and rsync's default quick check
skips a file whose size and mtime already match, leaving the old content in place. `--delete`, so a
file gone from the export goes from the public repo too. The two excludes keep the public repo's `.git`
and leave out the `node_modules` the gates just installed in the export. `git add -A`, not
`git commit -a`, which stages only files git already tracks. The `diff` reads the **commit**, not the
working tree: a `diff` against `.` passes over a file rsync copied in but the commit left out, whether
through `commit -a` or because `.gitignore` ignores it. If it prints anything, stop, fix the sync,
commit again and re-check. Record the full sha only once it prints nothing.

**Never tag a commit made directly in the public repo.** That tree has no identity sweep (the export
script, which holds it, does not ship), so the export is the only identity gate. A change merged there
(a contributor PR) must be carried back to the monorepo first, or the next export reverts it.

### 6. Push — its own yes

**(excluded from the runbook test: a public push.)**

```sh
git push origin main
git ls-remote origin refs/heads/main   # must print the sha step 5 recorded
```

The push's own output will not do: its `old..new` line gives only a short form, and a first push prints
`[new branch]` and no sha. **If the push is rejected** (`! [rejected] main -> main (fetch first)`), do
**not** follow git's hint to `git pull`, and do not merge or rebase in any form: the result is a commit
whose tree the export sweep never saw, and a sha recorded after it would pass every later check. Carry
the contributor's change back to the monorepo, re-run steps 2-4, rebuild the commit on the fetched
branch without merging (`git fetch origin && git checkout -B main origin/main`, then step 5 again),
record the new sha, and push again. If `ls-remote` ever prints anything but the recorded sha, stop:
nothing gets tagged.

### 7. Tag that sha — its own yes

**(excluded from the runbook test: a tag and a public push.)**

```sh
git tag vX.Y.Z <sha>
git rev-parse 'vX.Y.Z^{commit}'            # must print <sha>
git push --no-follow-tags origin vX.Y.Z    # the output must have a [new tag] line for vX.Y.Z
```

**Name the sha:** a bare `git tag vX.Y.Z` tags whatever `HEAD` is by now. **Not `--follow-tags`:** it
carries only annotated tags, so the lightweight tag above is silently left behind (exit 0,
`Everything up-to-date`) and `release.yml` never fires. A named refspec fails loudly when it matches no
local ref or more than one, but **not** when its only match is a *branch* named `vX.Y.Z` — that pushes
as `[new branch]`, exits 0, and fires nothing — which is why the check is the `[new tag]` line and not
the exit code. (Measured in a throwaway bare repo, 2026-09-21 and 2026-09-22.)

### 8. Watch the release workflow

**(excluded from the runbook test: it watches a live workflow run.)**

```sh
gh run list -R themarigold/daily-briefing --workflow release.yml -L 1
gh run watch <run-id> -R themarigold/daily-briefing --exit-status
```

`gate` (typecheck, tests, `scripts/check-versions.sh` against the tag, the signing mode) → the CLI
binaries and the bundle legs in parallel → `release`. A failed bundle leg does not stop the release: its
marker says `build-failed`, its assets are absent, and the notes name it. A missing or `size-rejected`
required marker fails `release` (the [Bundle-status contract](#bundle-status-contract) below).

### 9. Verify every asset and `SHA256SUMS`

**(excluded from the runbook test: it reads the live release.)**

```sh
gh release view vX.Y.Z -R themarigold/daily-briefing --json assets --jq '.assets[].name' | LC_ALL=C sort
D=$(mktemp -d) && gh release download vX.Y.Z -R themarigold/daily-briefing -D "$D" && (cd "$D" && shasum -a 256 -c SHA256SUMS)
gh release view vX.Y.Z -R themarigold/daily-briefing --json body --jq .body
```

The asset list must be exactly the [Assets](#assets) names for `X.Y.Z`, minus the assets of any leg the
notes name as not built; every `shasum` line must say `OK`; and the notes' signing label must match the
mode the `gate` job logged (`UNSIGNED (ad-hoc) RELEASE` unless the signing secrets are set).

### 10. Confirm the Homebrew tap picked it up

**(excluded from the runbook test: it reads, and may dispatch, the live tap.)**

The tap is `themarigold/homebrew-tap`. Its `Sync formula` workflow (`.github/workflows/sync-formula.yml`)
runs every 6 hours (`17 */6 * * *`) and on `workflow_dispatch`: `scripts/sync-formula.sh` reads the
latest release's tag and `SHA256SUMS`, takes the lines for the four CLI binaries
(`daily-briefing-darwin-arm64`, `-darwin-x64`, `-linux-arm64`, `-linux-x64`, matched as
` daily-briefing-<platform>` at the END of a line — so `SHA256SUMS` must keep bare basenames), rewrites
`Formula/daily-briefing.rb` and commits it. (Read from the tap with `gh api`, 2026-10-01.)

```sh
gh workflow run sync-formula.yml -R themarigold/homebrew-tap      # optional, its own yes: skip the wait
gh api repos/themarigold/homebrew-tap/contents/Formula/daily-briefing.rb --jq .content | base64 -d | grep -F 'version "X.Y.Z"'
```

### 11. Announce

**(excluded from the runbook test: a public action.)**

## The release signing identity (before the first signed release)

Without it the macOS app ships ad-hoc signed, and the release notes disclose that each update needs the
macOS folder-access grant again. A stable self-signed identity ends that. The recipe below is the one
already debugged for the local identity (`scripts/install.sh`, `src/schedule/install.ts`), with its
own CN. Two details matter: the certificate needs `keyUsage=digitalSignature`, the `codeSigning`
extended key usage and `CA:FALSE`, or `codesign` reports "no identity found" even though it lists; and
the p12 must be `-legacy` with a non-empty password, or `security import` reports a bogus "MAC
verification failed". It needs OpenSSL 3 from Homebrew: `/usr/bin/openssl` is LibreSSL, whose `pkcs12`
has no `-legacy` (its `req` does have `-addext`; measured with LibreSSL 3.3.6, 2026-10-01). The first line
below asks Homebrew where its copy is, so it is not tied to one prefix (`/opt/homebrew` on Apple silicon,
`/usr/local` by default on Intel; only the former measured here), and fails if `openssl@3` is not
installed (`brew install openssl@3`). The recipe **ends at the p12 file**: never import it into your
login keychain. The release workflow imports it into a dedicated keychain of its own.

```sh
OPENSSL="$(brew --prefix --installed openssl@3)/bin/openssl" && "$OPENSSL" version   # must print OpenSSL 3.x
D="$(mktemp -d /private/tmp/dba-signing.XXXXXX)" && cd "$D"
"$OPENSSL" req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes \
  -subj "/CN=Daily Briefing Release Signing" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning"
"$OPENSSL" x509 -in cert.pem -noout -text | grep -A1 -E "Basic Constraints|Key Usage"
PW="$("$OPENSSL" rand -base64 24)"; export PW
"$OPENSSL" pkcs12 -export -legacy -macalg sha1 -inkey key.pem -in cert.pem -out release-signing.p12 -passout env:PW
"$OPENSSL" pkcs12 -legacy -in release-signing.p12 -passin env:PW -nokeys | "$OPENSSL" x509 -noout -subject
base64 -i release-signing.p12 | tr -d '\n' > release-signing.p12.b64
```

The `x509 -text` line must show `CA:FALSE`, `Digital Signature` and `Code Signing`, each `critical`;
the read-back must print `subject=CN=Daily Briefing Release Signing`. Keep `release-signing.p12` and
`$PW` somewhere safe (a password manager): every release must be signed by this same certificate,
because a new one is a new designated requirement — the very re-grant this exists to end. Then add the
two repository secrets, each its own yes, and delete the directory:

**(excluded from the runbook test: `gh secret set` writes to the repository.)**

```sh
gh secret set DBA_SIGNING_P12 -R themarigold/daily-briefing < release-signing.p12.b64
printf '%s' "$PW" | gh secret set DBA_SIGNING_P12_PASSWORD -R themarigold/daily-briefing
cd / && rm -rf "$D"
```

The workflow's identity name comes from the repository **variable** `DBA_SIGNING_IDENTITY`, which
defaults to `Daily Briefing Release Signing`; set it only if the CN differs. Both secrets set means a
signed release; neither means unsigned; exactly one fails the `gate` job by name.

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

### Runners

Every bundle leg builds, tests and smokes on a runner of its own architecture. Nothing is
cross-built to ship, and nothing runs under Rosetta.

| Leg | Runner | Notes |
|---|---|---|
| `macos-arm64` | `macos-26` (Apple silicon) | |
| `macos-x64` | `macos-26-intel` (Intel) | The smoke runs the x64 sidecar's `--version` natively. The leg also cross-builds the `aarch64-apple-darwin` sidecar before its GUI tests, because `gui/size-budget.json` records that file and the size-budget stale-row test re-stats it. So `cargo test` runs with no `--skip` on both macOS legs. |
| `linux-x86_64` | `ubuntu-22.04` (pinned: it sets the oldest glibc and webkit2gtk the Linux bundles run on) | `cargo test` skips exactly the one stale-row test. The AppImage carries the engine at `usr/libexec/daily-briefing/daily-briefing` and a shell wrapper at `usr/bin/daily-briefing` (linuxdeploy's RPATH rewrite breaks the engine in `usr/bin`; `docs/gui-seam.md` §15a). The smoke checks that layout, the engine byte-identical to the built sidecar, and `--version` through the wrapper. The .deb ships the engine itself at `usr/bin/daily-briefing`. |
| `windows-x64` | `windows-latest` | informational |

The public `ci.yml` runs its full macOS `cargo test` on `macos-26`. `macos-14` is not used anywhere: it
is being retired (actions/runner-images#13518), and the x64 sidecar that was cross-built for it died
with SIGILL under that runner's Rosetta (M2b dry run, 2026-10-01). Runner choice user-directed
2026-10-01.

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
