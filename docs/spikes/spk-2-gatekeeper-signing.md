# SPK-2 — Gatekeeper, signing variants, and what enrollment would buy

**Status: local read-only measurements DONE; every launch leg UNRUN; variant (c) BLOCKED locally.**
The enrollment recommendation at the end is a **conditioned decision table**, not a recommendation.
Plan line 84 makes Apple Developer enrollment a per-action-yes item *conditioned on SPK-2*, and no
row of it may be read as settled while its legs are UNRUN.

---

## 1. The instrument

`gui/scripts/spk2-scratch-build.sh <output-dir> [path/to/Some.app]`

Takes a built `.app` and produces throwaway copies under an output directory **outside the git
worktree root** (enforced by a PHYSICAL-path prefix check, not by convention), then measures each
with tools that only read. Nothing is installed, launched, opened or registered; `spctl --assess`
only evaluates.

**"Physical" is the load-bearing word, and it was `pwd` rather than `pwd -P` until review.** `pwd`
reports bash's *logical* directory — `..` folded out, every symlink left standing — so two spellings
of a path inside the worktree got past the guard, both MEASURED with the variant bundles and
`measurements.txt` landing inside the repository: an out-dir naming a **symlink** that lives outside
the worktree and points into it, and an out-dir typed **`/tmp/…`** for a worktree under
`/private/tmp/…` (on macOS `/tmp` is a symlink to `/private/tmp`, and `/tmp/…` is the spelling a
human types). Both sides of the comparison now resolve with `pwd -P`. The claim is exactly
"symlinks and `..` are canonicalised" — a bind mount or a second filesystem path to the same inode
is not covered.

The prefix is the **worktree root** (`git rev-parse --show-toplevel`, falling back to the project
directory outside a git checkout) rather than this project's own directory, and the distinction is
not pedantry: this project is one directory of a monorepo, so an earlier version of the check
resolved against `daily_briefing_application/` and **accepted the monorepo root itself** as an
output directory (measured during review). A refusal now also unwinds exactly the directories the
script created on the way in — it used to `rmdir` only the leaf, leaving the parents of a refused
nested path inside the tree it had just declined to write to.

| Variant | How it is made |
| --- | --- |
| (0) as-built | the source bundle, measured **in place**, never copied or modified |
| (a) unsigned | `codesign --remove-signature` on every Mach-O and on the bundle |
| (b) ad-hoc ×2 | `codesign --force -s - --identifier com.themarigold.daily-briefing`, nested Mach-O first |
| (c) stable ×2 | the same, with a stable self-signed identity, `--options runtime` and an entitlements file |

The `×2` pairs are what answer the spike's actual question. Plan line 21 asserts that an ad-hoc
`.app` has a **cdhash-bound designated requirement**, so a rebuild revokes the TCC grant, while a
stable identity gives a DR that survives. That is a claim about the **DR string**, so the script
diffs the DR string across the pair.

**What "two builds" means here, stated plainly.** Variant 2 of each pair is not a second
`cargo tauri build`. It is variant 1's input with one extra file under `Contents/Resources/`, added
*before* signing. A bundle signature seals its resource directory into the CodeDirectory, so that
is a genuine cdhash change arriving the same way a rebuild's would — and, unlike a second
`cargo build`, guaranteed to differ rather than merely likely to. **A two-real-rebuild leg is in the
VM/CI register below (G11) and is UNRUN.**

### Keychain hygiene

The stable identity is created with the same OpenSSL recipe the project already uses for
`Daily Briefing (local) Signing` (`scripts/install.sh:25-60`, `src/schedule/install.ts:320-346`),
with one difference that is the whole point: **the keychain is a file under the output directory**,
referenced only by explicit `--keychain`, and deleted on exit including on failure. The login
keychain is never imported into, never added to a search list, never made default, and its existing
identities are never used — a scratch bundle signed with `Daily Briefing (local) Signing` would
inherit that identity's designated requirement and with it whatever TCC grants are keyed to it.

---

## 2. Local measurements — macOS 26.5.2 (25F84), arm64, Xcode 26.6

Source: `gui/src-tauri/target/debug/bundle/macos/Daily Briefing.app`, built with
`cargo tauri build --debug --bundles app` — a **default** build, i.e. the shipping shape, with no
`tcc-probe` feature. (SPK-2 is about what a stranger downloads; SPK-1(b)'s spike bundle is a
different artifact and is not what these numbers describe.) Full transcript: re-run the script; it
writes `measurements.txt` next to the variants. The table below was re-measured after the review
round, so the hashes are this build's, not the first draft's.

| Variant | `codesign -dvv` identifier / flags | CDHash | Designated requirement | `--verify --deep --strict` | `spctl --assess --type execute` |
| --- | --- | --- | --- | --- | --- |
| (0) as-built | `daily_briefing_gui-402e307b5ff6fa3d`, `flags=0x20002(adhoc,linker-signed)`, `Info.plist=not bound`, `Sealed Resources=none` | `306867f4…f783` | `cdhash H"306867f4…f783"` | **exit 1** — *code has no resources but signature indicates they must be present* | **exit 1** — same message |
| (a) unsigned | *code object is not signed at all* | — | — | exit 1 | **exit 3** — `rejected`, `source=no usable signature` |
| (b) adhoc-1 | `com.themarigold.daily-briefing`, `flags=0x2(adhoc)`, `Info.plist entries=15`, `Sealed Resources version=2 rules=13 files=2` | `2f8bc58f…714b` | `cdhash H"2f8bc58f…714b"` | exit 0 — *valid on disk*, *satisfies its Designated Requirement* | **exit 3** — `rejected` |
| (b) adhoc-2 | same identifier/flags, `Sealed Resources … files=3` | `74e47337…5f2d` | `cdhash H"74e47337…5f2d"` | exit 0 | **exit 3** — `rejected` |
| (c) stable-1/2 | **NOT PRODUCED** | — | — | — | — |

`xattr -l` on every variant: `com.apple.provenance` only. **No `com.apple.quarantine`** — these
bundles were built locally and never downloaded, so none of the local measurements exercise the
quarantine path. That is exactly why §4's Gatekeeper legs have to run in a VM against a genuinely
downloaded artifact.

### 2.1 DR stability across two builds — the measurement the spike exists for

```
adhoc  cdhash build-1: 2f8bc58fe78ccda41223f4705263abfac843714b
adhoc  cdhash build-2: 74e47337954c87d28adfa0fa00bc01d407b65f2d
adhoc  cdhash: DIFFERENT (as a rebuild would be)
adhoc  DR build-1: # designated => cdhash H"2f8bc58fe78ccda41223f4705263abfac843714b"
adhoc  DR build-2: # designated => cdhash H"74e47337954c87d28adfa0fa00bc01d407b65f2d"
adhoc  DR: CHANGED across the two builds → a TCC grant keyed on it is REVOKED

stable: NOT MEASURED (a variant was not produced)
```

**Plan R1 / delta-verify H (line 21) is confirmed for the ad-hoc case, and confirmed more sharply
than it was stated.** The DR of an ad-hoc-signed bundle is *only* `cdhash H"…"` — it carries **no
`identifier` clause at all**, even though `--identifier com.themarigold.daily-briefing` was passed
and `codesign -dvv` reports that identifier. So the grant is keyed to the bytes and nothing else.

**The positive half — that a stable identity's DR omits the cdhash — is UNMEASURED.** It is the
half that justifies the CI p12, and it stays UNVERIFIED until G10/G11 run.

### 2.2 Two findings the plan and appendix did not have

**(i) The bundle `cargo tauri build` produces is not bundle-signed at all.** Variant (0) carries
only the *linker's* ad-hoc signature: the identifier is the Rust crate hash
(`daily_briefing_gui-402e307b5ff6fa3d`, not the frozen bundle id), the Info.plist is not bound, no
resources are sealed, and `codesign --verify --deep --strict` **fails** with *"code has no resources
but signature indicates they must be present"*. Variant (b) — one `codesign -s -` pass over the
nested Mach-O and then the bundle — is what produces a structurally valid ad-hoc bundle. So
"ad-hoc-signed `.app`" in the plan describes variant (b), and the artifact the build currently
emits is a step below that. Measured on the **debug** bundle; whether a release
`cargo tauri build` differs is **UNVERIFIED** here. T23/T4 need to know this either way.

**(ii) `codesign --keychain <scratch>` cannot use an identity that `security find-identity` reports
as MATCHING in that same keychain.** Measured on macOS 26.5.2:

```
security create-keychain -p <pw> <scratch>.keychain-db          → OK
security import id.p12 -k <scratch> -P <pw> -A                  → OK
security set-key-partition-list -S apple-tool:,apple: -s -k <pw> → OK
security find-identity -p codesigning <scratch>                 → Matching identities
                                                                  1) <hash> "SPK2 Scratch Signing" (CSSMERR_TP_NOT_TRUSTED)
                                                                  1 identities found
                                                                  Valid identities only
                                                                  0 valid identities found
security find-identity -v -p codesigning <scratch>              → 0 valid identities found
codesign --force --keychain <scratch> --sign "SPK2 Scratch Signing" <binary>
                                                                → "SPK2 Scratch Signing: no identity found"  (exit 1)
```

**The framing this section carried before review — "codesign cannot find what find-identity lists"
— was misleading, and the `-v` line above is why.** `find-identity` reports the scratch identity as
*matching* and simultaneously reports **zero valid** identities; the tidy contradiction was
manufactured by quoting only the first half. The script now records **both** listings and
codesign's own stderr into `measurements.txt`, so the next reader is not dependent on this
paragraph's phrasing.

What actually reproduces, stated without the framing:

- the failure occurs **with and without** `--keychain`, by identity **name** and by **SHA-1 hash**,
  against the keychain path with and without the `-db` suffix, and with the keychain freshly
  unlocked in the same shell invocation (lens A, T2–T5 of the review round);
- on a **fresh non-Apple binary** (a copy of `/bin/echo`), so it is not a property of the bundle;
- **ad-hoc signing of that same binary succeeds**, so `codesign` itself is working.

**`CSSMERR_TP_NOT_TRUSTED` is not the explanation, and this is now measured rather than asserted.**
The author's own login-keychain identity `Daily Briefing (local) Signing` reports the *same*
untrusted status and is *also* absent from `find-identity -v` (`0 valid identities found`) — and
`codesign` signs with it anyway. The proof is the installed engine, read only:

```
codesign -dvv  ~/Library/Application Support/daily-briefing/daily-briefing
  → Identifier=local.daily-briefing
    Authority=Daily Briefing (local) Signing
    Signed Time=Sep 15, 2026 at 3:50:38 PM
codesign -d --requirements -  (same path)
  → designated => identifier "local.daily-briefing"
       and certificate leaf = H"309bb0e7280358b776f60d67b7d45af6cc031b4e"
security find-identity    -p codesigning  → 2 identities found, both (CSSMERR_TP_NOT_TRUSTED)
security find-identity -v -p codesigning  → 0 valid identities found
```

So the engine on this machine is **identity-signed, not ad-hoc** — `scripts/install.sh` did not
fall back — and it was signed with an identity that is untrusted and lists as 0-valid. That makes
the doc's premise ("install.sh signs with it") *checked* rather than assumed, and it retires one of
the two candidate causes:

- **(α) search-list lookup** — `codesign` resolves identities through the keychain *search list*,
  which `--keychain` does not extend. **Leading candidate.** It is the only one of the two that
  survives the paragraph above: the login identity differs from the scratch identity in exactly one
  relevant respect, namely that its keychain is on the search list.
- **(γ) untrusted identity** — `CSSMERR_TP_NOT_TRUSTED` / 0-valid makes the identity unusable.
  **Cannot be the whole story**, by the measurement above: the login identity has both properties
  and signs.
- **(β) a `security import` into a non-search-list keychain leaves the identity unusable to
  `codesign`** — still open, and not separable from (α) without the experiment below.

**(α) remains UNVERIFIED.** Proving it requires mutating the keychain search list
(`security list-keychains -d user -s …`) or signing with the author's own key, both forbidden on
this machine; the distinguishing experiment therefore moves to the VM/CI register as part of G10.

**Why this matters beyond the spike.** The operational consequence is the same under (α) or (β) and
belongs in the T4/SPK-1(c) CI work: **a CI recipe that imports the stable p12 into a temporary
keychain cannot rely on `--keychain` alone**; it must also put that keychain on the search list,
which is what every working CI recipe does and which is harmless on a throwaway runner. That
recommendation is itself **UNVERIFIED** — it follows from the failure above plus the standard
recipe, and nothing here measured the positive case.

The script keeps a `SPK2_IDENTITY=<name>` path for exactly that environment: it signs the
`stable-*` variants with an identity reachable through the **ambient** search list. It is
deliberately not the default, because on a developer machine the ambient list is the login keychain.

---

## 3. Hardened runtime and `allow-jit` — UNVERIFIED, and it is two questions, not one

Under hardened runtime this bundle has **two** Mach-O principals, and the JIT question is different
for each. The script therefore writes two entitlements files and gates them with one toggle,
`SPK2_ALLOW_JIT=app|sidecar|both` (default: **neither**).

| Principal | Where its JavaScript JIT runs | What the sources say | Status |
| --- | --- | --- | --- |
| the shell (`Contents/MacOS/daily-briefing-gui`) | Tauri renders through **WKWebView**, whose JavaScript executes in Apple's own out-of-process `com.apple.WebKit.WebContent`, signed by Apple with its own entitlements | the appendix's `allow-jit` + `allow-unsigned-executable-memory` pair (appendix:191) belongs to the **Electron** approach and is attributed there to *"(Chromium)"*, which embeds its JIT **in-process**. The appendix never lists entitlements for the Tauri approach, and where it comes closest (appendix:921) it hedges: *"the minimal entitlement set (likely allow-jit, possibly allow-unsigned-executable-memory)"* | **UNVERIFIED.** Not decidable without rendering a window, which is a VM leg (G7). |
| the engine sidecar (`Contents/MacOS/daily-briefing`) | a `bun build --compile` binary — JavaScriptCore, **in its own process** | appendix:713 measured only that such a binary *accepts* `--options runtime` and still answers `--version`; appendix:741 (T3a) records that this *"covers only the trivial path"* and that a full run under hardened runtime is unmeasured | **UNVERIFIED.** G8. |

An entitlement added on a guess is worse than one absent: it is a permanent widening that nobody can
later argue down without re-running the leg that should have decided it. Both default to empty and
the toggle is explicit.

---

## 4. Gatekeeper protocol — VM only

**Prerequisite: a disposable macOS VM (plan §6, line 83), and the artifact must arrive the way a
stranger's would** — downloaded over the network so `com.apple.quarantine` is actually set. A
`scp`'d or shared-folder copy may carry no quarantine attribute, in which case the leg measures
nothing. Record `xattr -l` **before** the first open, every time.

### The macOS 15+ path (plan line 27's mandatory graft)

Plan line 27 grafts the corrected copy: *"removed from the Finder contextual menu on macOS 15+ →
System Settings → Privacy & Security → Open Anyway"*, with `xattr -dr` in TROUBLESHOOTING — an
obligation on T15/T23 to **write** that troubleshooting section, not a description of one that
exists. There is no TROUBLESHOOTING document in the repository today. The appendix records the same
correction as a FATAL against the gui-tauri approach (appendix:880: the right-click→Open
instruction *"is dead on macOS 15+"*). The protocol below tests the copy that ships, not the copy
that was superseded.

**Apple-documented behaviour, none of it measured here.** Every numbered step below is what Apple's
published guidance and the appendix say happens; G1–G6 are the legs that would turn it into a
measurement, and they are UNRUN. Read the list as the hypothesis those legs test, never as a
result:

1. Double-click the app → *"Apple could not verify … is free of malware"*, with **no** Open option.
2. System Settings → Privacy & Security → scroll to Security → *"Open Anyway"* next to the blocked
   app → authenticate → **expected**: the app opens and macOS remembers the approval for that exact
   bundle. That this clears the block on the target macOS is precisely what **G4** decides; the
   enrollment table below treats a G4 failure as a release blocker for exactly that reason.
3. Alternative, to be documented in TROUBLESHOOTING by T15/T23 (plan line 27):
   `xattr -dr com.apple.quarantine "/Applications/Daily Briefing.app"`. Recursive, because a `.app`
   is a directory. **G5** is the leg that confirms it.
4. **Expected**, on the same documented behaviour: every rebuild arrives as a new download, carries
   a fresh `com.apple.quarantine`, and repeats the dance — which is the user-facing cost the
   enrollment table below prices. Unmeasured here: no leg has yet downloaded a second build.

### Legs

Every `status` is **UNRUN**.

| Leg | Action | Expected | Observed | Status |
| --- | --- | --- | --- | --- |
| G1 | download variant (a) unsigned, confirm `com.apple.quarantine` set, double-click | blocked; wording recorded verbatim | | UNRUN |
| G2 | same for variant (b) ad-hoc | blocked; wording recorded verbatim — and whether it differs from G1 | | UNRUN |
| G3 | same for variant (c) stable + hardened runtime | blocked; wording recorded verbatim | | UNRUN |
| G4 | System Settings → Privacy & Security → Open Anyway, for each of G1–G3 | opens; approval remembered | | UNRUN |
| G5 | `xattr -dr com.apple.quarantine <app>` then double-click, for each | opens with no dialog | | UNRUN |
| G6 | right-click → Open on macOS 15+ | **absent** — confirming plan line 27's graft and appendix:880 | | UNRUN |
| G7 | variant (c) with **no** `allow-jit`: open, confirm the webview renders and the UI is interactive | renders ⇒ the shell needs no JIT entitlement | | UNRUN |
| G8 | variant (c) with **no** `allow-jit`: a full `daily-briefing run` through the sidecar against a fixture repo + stub provider | completes ⇒ the sidecar needs no JIT entitlement | | UNRUN |
| G9 | if G7 or G8 fails: repeat with `SPK2_ALLOW_JIT=app` / `sidecar` / `both` | identifies the **minimal** set, not a superset | | UNRUN |
| G10 | produce variant (c) at all, on a host where the identity is reachable (CI runner, or a VM where the search list may be mutated); while there, run the (α)-vs-(β) experiment of §2.2(ii) — import to a temporary keychain, sign with `--keychain` alone, then add it to the search list and sign again | `codesign -dvv` shows `flags=0x10000(runtime)` and a non-adhoc signature | | UNRUN (**BLOCKED locally** — §2.2(ii)) |
| G11 | variant (c) across **two real rebuilds**: cdhash differs, DR string identical | DR omits the cdhash ⇒ the TCC grant survives — the positive half of §2.1 | | UNRUN |
| G12 | *(post-enrollment, deferred)* Developer ID + notarize + staple | `spctl --assess --type execute` → **accepted**, `source=Notarized Developer ID` | | UNRUN |

**12 legs, 12 UNRUN.** One of the twelve — **G10** — is additionally **BLOCKED locally**: variant
(c) cannot be produced on the author's machine, for the measured reason in §2.2(ii). It is counted
once, inside the twelve, and its status is `UNRUN (BLOCKED locally)`. An earlier draft counted it
both inside the twelve and again as "one further leg", which made the register add to 25.

---

## 5. Enrollment — a conditioned decision table, not a recommendation

Plan line 84 lists Apple Developer Program enrollment (~$99/yr) as an after-the-build per-action-yes
item **conditioned on SPK-2**. Every row below is conditional on legs that are UNRUN. **No row is a
recommendation today.**

| If the VM legs show… | Then the cost of shipping without enrollment is… | And the enrollment call is… |
| --- | --- | --- |
| G11 passes (stable-identity DR omits the cdhash) **and** G7/G8 pass without `allow-jit` | a first-launch Gatekeeper dialog per download, cleared once via Open Anyway, plus **one** re-grant when a Developer ID eventually lands (appendix:18) | **defer.** The self-signed path holds the TCC grant across updates, which is the expensive failure. Enrollment buys a smoother first launch and notarized auto-update, both of which can wait for the post-enrollment slice. |
| G11 **fails** (the stable identity's DR still moves across rebuilds) | every update silently revokes repo access, and plan R1's interim disclosure becomes permanent | **enroll before first release.** The whole self-signed strategy rests on G11; without it the product's day-30 story is the one the appendix calls the sharpest risk (appendix:18). |
| G7 or G8 needs `allow-jit`, and G9 finds a minimal set | an entitlements file in the release pipeline, and hardened runtime becomes load-bearing rather than optional | **neutral on its own** — it is a packaging change, not an enrollment argument. Record the minimal set; do not widen beyond it. |
| G7/G8 fail even with `both` entitlements | hardened runtime is not viable for this bundle, and notarization (which requires it) is unreachable | **do not enroll yet.** Enrollment buys notarization, and notarization would be blocked. Fix the runtime question first. |
| G4 fails (Open Anyway does not clear the block on the target macOS) | a stranger has no working first-run path at all | **enroll before first release**, and treat it as a release blocker, not a polish item. |
| G1–G3 wording differs materially between variants | the INSTALL/TROUBLESHOOTING copy must branch per variant | affects docs (T15), not enrollment. |

The pre-first-signed-release checklist in plan §6 (line 84) already names SPK-1(c) and *"create the
stable p12 + password as public-repo secrets — this is also what stabilizes the APP principal's
DR, ending per-update re-grants"*. **G11 is the leg that decides whether that sentence is true.**

---

## 6. Reproducing the local half

```
export PATH="$HOME/.cargo/bin:$PATH"
bash gui/scripts/build-sidecar.sh
(cd gui && cargo tauri build --debug --bundles app)
bash gui/scripts/spk2-scratch-build.sh /some/scratch/dir/outside/the/git/worktree
```

The script refuses an output directory inside the git worktree (and removes the directories it
created on the way to that refusal), writes `measurements.txt` alongside the variants, and deletes
its scratch keychain on exit. It launches nothing.

### What the run leaves behind, and why

On exit the script removes **only the secret material**: the scratch keychain
(`security delete-keychain` then `rm -f`) and `.identity/`, which holds the PEM private key and the
p12. That trap fires on failure as well as success.

Everything else **stays on purpose — it is the output, not residue**:

| Left in the output directory | Why it must be |
| --- | --- |
| `unsigned/`, `adhoc-1/`, `adhoc-2/` (and `stable-1/`, `stable-2/` where producible) | these ARE the artifacts §4's VM legs are run against; G1–G3 download them |
| `measurements.txt` | the transcript §2's tables are read off, including the two `find-identity` listings and codesign's own stderr |
| `entitlements-app.plist`, `entitlements-sidecar.plist` | what was actually sealed into the variants, which is unreconstructible from the bundles alone |

Delete the output directory yourself when the legs that need it are done. Because the guard refuses
anywhere inside the worktree, nothing of this ever lands in the repository.
