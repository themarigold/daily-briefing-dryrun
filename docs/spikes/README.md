# Spikes

Phase-B spikes for the 0.2.0 completion build. Each one is a question the plan could not settle on
paper, an instrument built to answer it, and a register of what has and has not been measured.

| Spike | Question | Instrument | Local status | VM legs |
| --- | --- | --- | --- | --- |
| [SPK-1(b)](spk-1b-app-principal.md) | Can the `.app` obtain a Files-and-Folders grant, does a child process inherit it, and does the grant survive a rebuild? | `--tcc-probe <dir>` in the Rust shell behind the off-by-default `tcc-probe` cargo feature (`gui/src-tauri/src/probe.rs`; 22 tests under the feature, plus 4 gate tests — 3 split across the two feature configurations and 1 ungated pin on the manifest) | instrument built, smoke-tested against scratch directories only | 12, all UNRUN |
| [SPK-2](spk-2-gatekeeper-signing.md) | What does Gatekeeper do to each signing variant, does a stable identity give a DR that survives rebuilds, and does hardened runtime need `allow-jit`? | `gui/scripts/spk2-scratch-build.sh` | read-only measurements DONE for variants (0)/(a)/(b); variant (c) BLOCKED | 12, all UNRUN |

SPK-1(a) (delegated-grant durability) and SPK-1(c) (CI-p12 DR stability) are not in this directory:
SPK-1(a) is a pure VM spike with no artifact to build here, and SPK-1(c) is a pre-first-signed-release
checklist item in plan §6. SPK-3 is informational and lands at the end of Phase B.

---

## Consolidated UNRUN register

**24 legs. 24 UNRUN. 0 run.** One of the 24 — **G10** — is additionally **BLOCKED locally** for a
measured reason (SPK-2 variant (c) production; see below). It is counted once, inside the 24, and
its status is `UNRUN (BLOCKED locally)`: there is no twenty-fifth leg.

### What unblocks them

**A disposable macOS VM, or a second macOS account, snapshot-capable** — plan §6 (line 83) makes
this a **HARD** prerequisite: *"disposable macOS VM/second account — HARD prereq for SPK-1(a/b),
T16 install-path, T17, T19/T20 live legs, T23 installs, T25 uninstall-consent, T26; each named leg
without it ships on stated evidence + UNRUN in §7"*. None of these legs may run on the author's
machine: each one mutates the live TCC database, the Gatekeeper approval state, or both.

Every SPK-1(b) leg additionally needs a bundle built **with the probe compiled in**:
`cargo tauri build --debug --bundles app --features tcc-probe`. A default build has no
`--tcc-probe` mode at all (SPK-1(b) §2.1), and running that argv against one is an ordinary launch.

**Five legs need more than a VM**, and they are the same dependency four times over:

- **B7, B8, B9** (does a stable-identity `.app` obtain the grant, and does it survive one rebuild,
  then two?) each require **SPK-2 variant (c)** — the stable-identity signed bundle — which is the
  artifact G10 exists to produce and which is **BLOCKED locally**. These three are the whole
  positive half of SPK-1(b)'s durability question, and they are blocked on the same thing G10/G11
  are. Until variant (c) can be produced somewhere, B7–B9 cannot start.
- **G10/G11** (produce and re-produce SPK-2 variant (c)) additionally need a host where the signing
  identity is reachable through the keychain search list — a CI runner, or a VM where mutating the
  search list is acceptable. See SPK-2 §2.2(ii) for the measured reason this is not the author's
  machine.
- **B12 / G12** are post-enrollment and stay deferred until plan line 84's per-action yes.

### SPK-1(b) — app principal (12 legs)

| Leg | What it decides | Status |
| --- | --- | --- |
| B1 | does a first probe of `~/Documents` raise the TCC prompt for the `.app`? | UNRUN |
| B2 | does granting it make the app leg read? | UNRUN |
| B3 | **does a child process inherit the app's attribution?** (plan line 43's branch point) | UNRUN |
| B4 | does denying produce `denied` rather than an error? (instrument control) | UNRUN |
| B5 | does an ad-hoc rebuild revoke the grant? (delta-verify H) | UNRUN |
| B6 | how many clicks does re-granting cost? | UNRUN |
| B7 | does a stable-identity `.app` obtain the grant? | UNRUN (needs SPK-2 variant (c) — G10) |
| B8 | does the grant survive one rebuild under the same identity? | UNRUN (needs SPK-2 variant (c) — G10) |
| B9 | does it survive a second? | UNRUN (needs SPK-2 variant (c) — G10) |
| B10 | do the two principals hold grants independently? | UNRUN |
| B11 | *(conditional on B3 = denied)* does the launchd one-shot fallback work? | UNRUN |
| B12 | *(post-enrollment)* exactly one re-prompt at the Developer ID transition? | UNRUN |

### SPK-2 — Gatekeeper and signing (12 legs)

| Leg | What it decides | Status |
| --- | --- | --- |
| G1 | first-launch wording, unsigned + quarantined | UNRUN |
| G2 | first-launch wording, ad-hoc + quarantined | UNRUN |
| G3 | first-launch wording, stable identity + hardened runtime + quarantined | UNRUN |
| G4 | does System Settings → Privacy & Security → Open Anyway clear the block? | UNRUN |
| G5 | does `xattr -dr com.apple.quarantine` clear it? | UNRUN |
| G6 | is right-click → Open really absent on macOS 15+? (plan line 27's graft) | UNRUN |
| G7 | does the WKWebView shell render under hardened runtime **without** `allow-jit`? | UNRUN |
| G8 | does the Bun sidecar complete a full run under hardened runtime **without** `allow-jit`? | UNRUN |
| G9 | *(conditional)* what is the **minimal** entitlement set? | UNRUN |
| G10 | can variant (c) be produced at all, and what are its flags? | UNRUN (**BLOCKED locally** — SPK-2 §2.2(ii)) |
| G11 | **does a stable identity's DR survive two real rebuilds?** | UNRUN |
| G12 | *(post-enrollment)* does notarization make `spctl` accept? | UNRUN |

---

## What HAS been measured, so it is not mistaken for a leg

These are local, read-only, and none of them touches TCC, Gatekeeper approval state, or a protected
directory.

- The probe runs headlessly from `target/debug/daily-briefing-gui` **and** from
  `Daily Briefing.app/Contents/MacOS/daily-briefing-gui`, against scratchpad directories, opening no
  window and leaving no process. It reports `ok`/`ok` for a readable directory, `error:ENOENT` for a
  missing one, and exits 2 on a usage error. (SPK-1(b) §2.)
- The `tcc-probe` feature gate holds in both directions on the built binary:
  `strings -a … | grep -c -- --tcc-probe` is **1** for a `--features tcc-probe` bundle and **0** for
  a default one, and `tests/probe_feature_gate.rs` asserts each in its own build. Those two
  assertions are `cfg`'d on the feature, so a fourth, **ungated** test in the same file pins the
  manifest — nothing reachable from `default` may enable `tcc-probe`. Without it, adding that one
  line made `cargo test` report **39 passed / 0 failed** while the default binary carried the flag
  (measured). (SPK-1(b) §2.1.)
- The bundle `cargo tauri build --debug --bundles app` emits is **linker-signed only** — no sealed
  resources, Info.plist not bound, identifier `daily_briefing_gui-<hash>` rather than the frozen
  bundle id, and `codesign --verify --deep --strict` fails on it. (SPK-2 §2.2(i).)
- An ad-hoc-signed bundle's designated requirement is **`cdhash H"…"` and nothing else** — no
  `identifier` clause, even when `--identifier` is passed — and it changes across two builds. This
  confirms plan line 21 / delta-verify H for the ad-hoc case. (SPK-2 §2.1.)
- `spctl --assess --type execute` rejects every locally built variant (exit 3 for (a) and (b),
  exit 1 for the as-built bundle, which fails structurally before Gatekeeper gets an opinion).
- `codesign --keychain <scratch-keychain>` cannot use an identity that
  `security find-identity -p codesigning <scratch-keychain>` reports as **matching** — and which
  `find-identity -v` reports as **0 valid** — on macOS 26.5.2. It reproduces with and without
  `--keychain`, by name and by SHA-1, on a fresh non-Apple binary, while ad-hoc signing of that
  same binary succeeds. Untrustedness is **not** the cause: the author's login identity
  `Daily Briefing (local) Signing` is equally untrusted and equally 0-valid, and the installed
  engine at `~/Library/Application Support/daily-briefing/daily-briefing` is signed with it
  (`Authority=Daily Briefing (local) Signing`, DR `identifier "local.daily-briefing" and
  certificate leaf = H"309bb0e7…"`), so `install.sh` did not fall back to ad-hoc. Search-list
  lookup is the leading candidate and stays **UNVERIFIED** — proving it needs a search-list
  mutation, which is forbidden here. Full framing and the CI consequence in SPK-2 §2.2(ii).

The positive half of the DR story — that a stable self-signed identity yields a DR **without** a
cdhash — is **not** in that list. It is G11, and it is UNRUN.

---

## SPK-3 — the end-of-Phase-B informational close (2026-09-17)

The plan names SPK-3 three times (`2026-09-14-completion-build-plan.md:43,74,84`) — twice as
the Phase-B item, defined only as *"informational, end of Phase B"*, and once at `:84`
scheduling a post-enrollment SPK-3/SPK-2 rerun, which qualifies calling this a close. This section is that close-out, read as the
consolidation the other two spikes' registers were building toward: what Phase B's builds
MEASURED that bears on the spike questions, and how the unblock paths changed. Nothing here is a
new leg; every line cites the register that carries the measurement.

### The register arithmetic did not move

**24 legs. 24 UNRUN. 0 run.** Phase B built and reviewed its tasks (T6–T25 as plan line 74 enumerates them — T24's CI
matrix is Phase E's, T21 folded into T17) without running a single VM leg,
exactly as the plan's HARD-prerequisite line prescribes. G10 remains `UNRUN (BLOCKED locally)`;
B7–B9 remain blocked on it.

### What Phase B measured that the spike questions consume

- **The nested-sidecar signing question is answered from source, ahead of any signed build.**
  tauri-bundler 2.9.4 collects each copied `externalBin` as a `SignTarget` before the `.app` and
  signs inside-out, so SPK-2's variant-(c) production (G10) will cover the sidecar with no
  post-bundle step — and a binary placed via `bundle.macOS.files` is NOT signed, which the probe
  script now bails on rather than green-lighting. (`docs/gui-seam.md` §15a; the probe is
  `gui/scripts/nesting-probe.sh`, whose header states what it can and cannot prove.)
- **Hardened runtime and the app's entitlements land on the Bun sidecar at the FIRST signed
  build**, not at notarization — `--options runtime` applies to every executable SignTarget and
  the same entitlements file is applied per target. G8's question (does the sidecar complete a
  run under hardened runtime without `allow-jit`?) is therefore answerable at the first CI
  build that has `APPLE_CERTIFICATE`, and needs only the stable self-signed identity, not a
  Developer ID. (§15b dev 153's re-gate; SPK-2 §4's Legs table carries G8.)
- **The AMFI entitlements trap is narrower than first recorded**: codesign accepts XML comments
  in an entitlements file; what AMFI rejects — and `plutil -lint` does not catch — is a literal
  `--` inside a comment. The shipped file is comment-free and the constraint is suite-pinned.
  (§15b dev 153, re-caused from a 12-green-comment-variant measurement plus the `--`
  reproduction.)
- **`spctl` reason strings for unsigned variants are now recorded** (structural
  `code has no resources but signature indicates they must be present` rc=1 for the as-built
  bundle; plain `rejected` rc=3 ad-hoc): the `unnotarized`-wording leg stays VM-gated because no
  local variant can produce it. (§15a/§15c.)
- **The keychain-import mechanics behind SPK-2 §2.2(ii) are corroborated from source**: the
  bundler's cert path creates and search-lists a keychain under `$HOME/Library/Keychains`,
  cleanup is `Drop`-only, and the gate is env presence, not CI — recorded with the explicit
  `security delete-keychain` instruction in the T24 handoff. G10's unblock path is unchanged (a
  CI runner or a VM where search-list mutation is acceptable) and is now a secrets change plus a
  documented cleanup step — though §2.2(ii)'s (α) and the recipe itself stay UNVERIFIED.
  (§15c's T24 handoff; §15b dev 152 for the secret shape.)
- **T25's uninstall and coexistence legs shipped with their VM halves registered, not faked** —
  the real-install matrix, both ownership transitions, the consented uninstall's real leg and
  the login item are enumerated in §16c, joining the same VM queue as the 24 spike legs.
- **One case-sensitivity fact with spike-adjacent teeth**: the default APFS volume is
  case-insensitive, so any exact-name refusal list must compare case-insensitively — recorded
  and pinned on the `--json-out` path (`gui/src-tauri/src/engine.rs:543-545`,
  `tests/engine_client.rs:654-666`). Worth remembering when the TCC probe's path comparisons
  meet a real VM.

### What the VM inherits, in one line

When the disposable VM exists, the queue is: SPK-1(b) B1–B6 + B10/B11 on a
`--features tcc-probe` bundle · SPK-2 G1/G2/G6 (+ their G4/G5 arms) on scratch variants · G10
wherever the identity is search-list reachable (CI or the VM) · then G3/G7–G9 + G11 on
variant (c) · then B7–B9 · plus the §16c/§15c task legs (installs,
transitions, uninstall-consent, DMG layout, visual register). B12/G12 stay behind plan line
84's per-action yes.
