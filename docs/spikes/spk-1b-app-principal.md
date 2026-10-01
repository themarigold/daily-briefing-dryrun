# SPK-1(b) — the app principal: TCC grant obtainability and durability

**Status: instrument built and locally smoke-tested; every TCC leg UNRUN.**
No macOS VM has been provided, and plan §6 (line 83) makes a disposable VM a **hard** prerequisite
for this spike. Nothing in this document was measured against a protected directory on the author's
machine, and nothing here may be read as an answer to the questions it poses.

---

## 1. What this spike is for

Plan R1 (line 21) rules that the product has **two** TCC principals:

- the **delegated** principal — the managed engine copy at `<state>/daily-briefing`, signed with
  `Daily Briefing (local) Signing` and `--identifier local.daily-briefing`, which holds the
  author's live Files-and-Folders grant across rebuilds. SPK-1(a) owns that one.
- the **app** principal — the `.app` itself. A GUI-initiated run spawns the engine as a child, and
  the child's *responsible process* is the `.app`, so the `.app` needs its own grant. Plan line 21
  further asserts, from delta-verify H, that **an ad-hoc-signed `.app` has a cdhash-bound
  designated requirement, so every rebuild or update revokes the grant.**

SPK-1(b) answers three things the plan cannot settle on paper:

1. **Obtainability** — does a protected-directory read from the `.app` process raise the first-run
   TCC prompt, and does granting it work?
2. **Inheritance** — does a plain child process of the `.app` read the same directory under the
   app's grant? Plan line 43 names the consequence: *"if child inheritance fails, GUI-initiated
   runs fall back to routing through the managed copy (launchd one-shot) or the app principal joins
   the guided-grant flow; recorded before T16/T17 build."*
3. **Durability** — does an ad-hoc rebuild revoke the grant (confirming delta-verify H), and does
   signing with a stable self-signed identity make it survive?

### What the product does with the probe afterwards

Plan line 21 is explicit and this spike does not relax it: in the shipped app the same read is a
**revocation detector only** — it fires when a protected root is in scope AND a prior app-principal
grant is recorded, never as an acquisition trigger outside the guided flow, so the
deselected-by-default protected-roots graft keeps its no-unexplained-prompt property. T17 owns that
wiring. This spike is the measurement instrument, not the product feature.

---

## 2. The instrument

`gui/src-tauri/src/probe.rs`, reached as:

```
<bundle>/Contents/MacOS/daily-briefing-gui --tcc-probe <directory>
```

It opens no window, builds no `tauri::Builder`, reads no capability, spawns no sidecar, and exits 0
after printing **one** JSON object to stdout. The probe is selected only when `--tcc-probe` is
argv[1]; every other argv — including `--tcc-probe` in second position — falls through to the
ordinary launch. `gui/src-tauri/tests/tcc_probe.rs` (22 tests) pins the gate, the errno
classification, the child classifier, the per-entry drain, the `childStderr` cap and the JSON key
set; `gui/src-tauri/tests/probe_feature_gate.rs` pins the feature gate described next.

### 2.1 DISCLOSED DEVIATION from plan line 43 — an argv mode, not a separate probe bundle

Plan line 43 says SPK-1(b) *"runs immediately after scaffold T6/T7 using a **minimal probe
bundle**"*. This instrument is not that: it is an argv mode inside the product's own shell. The
deviation is deliberate and it is the only shape that answers the question asked.

**Why.** SPK-1(b) is about the **app principal**, and to macOS a principal is a bundle identifier
plus a designated requirement. A minimal probe bundle would necessarily carry a different
identifier and a different DR from the one the product ships, so its TCC prompt, its grant and its
revocation-on-rebuild behaviour would all be facts about *that* bundle. Every leg below — B1's
prompt wording, B5's revocation, B7–B9's survival across re-signs — would then have measured a
principal the product never ships. The probe has to run from inside the bundle whose identifier is
`com.themarigold.daily-briefing`, and that bundle is the shell.

**What the deviation costs, and how it is bounded.** The cost is an extra argv surface on a signed
application. That is paid for with a **compile-time gate**: the probe lives behind the `tcc-probe`
cargo feature, **off by default**, so a default build compiles neither `probe.rs` nor the dispatch
call in `main.rs`, and the string `--tcc-probe` is absent from the binary altogether. The release
artifact therefore has no probe to reason about — there is nothing to reach, not merely nothing
that should be reached.

A cargo feature rather than `#[cfg(debug_assertions)]` because SPK-2's Gatekeeper, hardened-runtime
and DR legs need a **release-profile** bundle: a probe that existed only in debug builds could not
be carried by the artifact those legs measure.

Four tests hold the guarantee. Three of them are `#[cfg]`'d on the feature and assert against the
**built binary** rather than the source; the fourth is **ungated** and asserts against the manifest,
because the `cfg`'d three cannot say anything about which configuration they were compiled into:

| Test | Build | Asserts |
| --- | --- | --- |
| `binary_does_not_carry_the_probe_flag` | default | the literal `--tcc-probe` is **absent** from `daily-briefing-gui` |
| `binary_carries_the_probe_flag` | `--features tcc-probe` | it is **present** |
| `the_bundled_binary_answers_the_probe_flag` | `--features tcc-probe` | exec'ing the binary with `--tcc-probe <dir>` gives exit 0 and the documented JSON — the only test that covers `main.rs`'s two wiring lines, whose deletion previously left every test green while turning the probe invocation into a window launch |
| `the_probe_feature_is_not_a_default_feature` | **both** | nothing reachable from `default` in `Cargo.toml`'s `[features]` enables `tcc-probe` |

**Why the fourth exists, MEASURED.** The first row is the load-bearing one, and it is
`#[cfg(not(feature = "tcc-probe"))]` — so a single line, `default = ["tcc-probe"]` under
`[features]`, does not *fail* it, it *deletes* it. With that line added to a scratch copy of the
crate, plain `cargo test` reported **39 passed / 0 failed** while
`strings -a target/debug/daily-briefing-gui | grep -c -- '--tcc-probe'` reported **1**: the release
default carried the argv surface and every test agreed it did not. The ungated fourth test reads
the `[features]` table directly and resolves `default` transitively (so
`default = ["spike"]` / `spike = ["tcc-probe"]` is caught too). Seen-red on the same scratch copy:
with the line present it fails; with it removed the suite is green.

**Building the spike bundle** (the VM legs below are run against this, never against a default
build):

```
export PATH="$HOME/.cargo/bin:$PATH"
bash gui/scripts/build-sidecar.sh
(cd gui && cargo tauri build --debug --bundles app --features tcc-probe)
```

`cargo tauri build` forwards unrecognised flags to `cargo build`, so `--features tcc-probe` reaches
the crate. Drop that flag and the bundle builds fine and answers `--tcc-probe` with a window — which
is why the flag is stated here and in `gui/src-tauri/Cargo.toml` rather than left to memory.

```json
{
  "dir": "<the directory probed>",
  "app": "ok" | "denied" | "error:<ERRNO|Kind>",
  "child": "ok" | "denied" | "error:<ERRNO|exit-N|signalled|spawn-Kind>",
  "childExit": <int|null>,
  "childStderr": "<trimmed, ≤512 chars>",
  "bundleId": "com.themarigold.daily-briefing",
  "executable": "<path of the running binary>"
}
```

- `app` is `std::fs::read_dir` from **this** process — the app principal. `EPERM` (what macOS
  returns for a TCC-refused `opendir`) and `EACCES` both classify as `denied`; `ENOENT`/`ENOTDIR`
  are reported by name so a wrong path is never read as a refused grant.
- `child` is `/bin/ls -- <dir>` — a plain, unrelated system tool, chosen because the question is
  whether *any* child inherits the app's attribution. Re-executing this binary as its own child
  would have given a numeric errno but would also have changed the thing being measured. The `--`
  is load-bearing and was added after review: without it, `--tcc-probe -laR` reported
  `child: "ok"` for a directory `ls` never opened, because `ls` had taken the operand as flags and
  listed the working directory (MEASURED).
- `childStderr` is an addition to the shape the task specified. It is load-bearing: `ls` exits 1
  for a denial and 1 for a missing path alike, so the `child` verdict is derived from `ls`'s prose
  and without the prose nobody reading a VM transcript could re-derive it. The verdict is taken
  from the segment after the **final** `": "` of `ls`'s message — never a substring search over the
  whole line, which read the diagnosis off the *operand* for a directory named `Permission denied`
  (MEASURED).
- `bundleId` is a constant (the probe never builds a Tauri context);
  `the_bundle_id_constant_matches_tauri_conf_json` pins it to `tauri.conf.json`'s `identifier`,
  which plan line 25 freezes as `com.themarigold.daily-briefing`.

### 2.2 Reading the two legs together — a reader-side check, not a JSON field

The JSON reports the two legs independently and **does not** cross-check them. That is deliberate:
the spike's most important positive result is a *disagreement* (`app` = `ok` with `child` = `denied`
is B3's negative branch, the whole point of leg B3), so a `"consistent": false` field would flag the
finding as a fault. The cross-check belongs to whoever reads the transcript, and this is it:

| `app` | `child` | Read it as |
| --- | --- | --- |
| `ok` | `ok` | the app holds the grant **and** a plain child inherits the attribution (B3 positive) |
| `ok` | `denied` | the app holds the grant, attribution is **not** inherited — plan line 43's negative branch (B3 negative). Not an instrument fault |
| `denied` | `denied` | no grant in force for either. Check `childStderr` says *Operation not permitted* before reading this as TCC rather than mode bits |
| `denied` | `ok` | **suspect the instrument.** The two legs read the same path by construction, so this should be unreachable; re-run B4 before recording anything |
| `error:*` | `error:*` | the path or environment is wrong — the leg did not run. Both legs agreeing on `ENOENT` is the healthy form of this |
| `error:*` | `ok`, or the reverse | **suspect the argv.** Legs that disagree about whether the path even exists cannot both be about that path — this is exactly what a mis-parsed operand looked like before the `--` fix |

`childStderr` is the tiebreaker in every ambiguous row: it is the raw sentence the kernel produced,
so a verdict can always be re-derived by hand rather than trusted.

### Local smoke receipts (this machine, scratchpad directories only — NOT TCC evidence)

Run against `/private/tmp/.../scratchpad/spk1b-probe-dir`, which is not protected and raises no
prompt, from a bundle built with `--features tcc-probe`. These establish that the instrument runs
headlessly from both binary paths. They say nothing about TCC.

| # | Binary | Directory | Output |
| --- | --- | --- | --- |
| L1 | `target/debug/daily-briefing-gui` | readable scratch dir | `{"app":"ok","child":"ok","childExit":0,…}` exit 0 |
| L2 | `Daily Briefing.app/Contents/MacOS/daily-briefing-gui` | same | `{"app":"ok","child":"ok","childExit":0,…}` exit 0 |
| L3 | bundled binary | `<scratch>/no-such-dir` | `{"app":"error:ENOENT","child":"error:ENOENT","childExit":1,…}` exit 0 |
| L4 | bundled binary | *(operand omitted)* | usage on stderr, exit 2 |
| L5 | bundled binary | `-laR` (a dash-leading operand) | `{"app":"error:ENOENT","child":"error:ENOENT",…}` exit 0 — **before the `--` fix this returned `child":"ok"`** |
| L6 | bundled binary | `<scratch>/Permission denied/nope` | `{"app":"error:ENOENT","child":"error:ENOENT",…}` exit 0 — **before the tail-anchored match this returned `child":"denied"`** |

No window appeared, no `daily-briefing-gui` process remained, and `pgrep -fl daily-briefing-gui`
was empty afterwards.

The gate itself is measured in both directions on the same artifacts:
`strings -a "Daily Briefing.app/Contents/MacOS/daily-briefing-gui" | grep -c -- --tcc-probe` → **1**
for the `--features tcc-probe` bundle and **0** for a default one. The default binary was **not**
run with the flag, and must not be: with the probe compiled out that argv is an ordinary launch.

Both of those measurements are *of a build*, and which build a plain `cargo test` produces is
decided by the manifest. `the_probe_feature_is_not_a_default_feature` (ungated) is what pins that
last step — see the table in §2.1 and the 39-passed/0-failed measurement beneath it.

**The bundled executable is `Contents/MacOS/daily-briefing-gui`** — measured from the built bundle's
`CFBundleExecutable`, even though `productName` is `Daily Briefing`. The bundle directory is
`Daily Briefing.app`.

---

## 3. VM protocol

**Prerequisite (plan §6, line 83): a disposable macOS VM or a second account, snapshot-capable.**
Every leg below mutates the TCC database of the machine it runs on. None of them may be run on the
author's machine.

### Setup

1. Fresh macOS VM (the ruling target is macOS 15+, since plan line 27's Gatekeeper graft is about
   15+ behaviour; the author's host is 26.5.2 and the VM should match or exceed the oldest
   supported release).
2. Snapshot as `clean`.
3. On the build host: `bash gui/scripts/build-sidecar.sh` then
   `cd gui && cargo tauri build --debug --bundles app --features tcc-probe`. **The
   `--features tcc-probe` is not optional** — without it the probe is compiled out and
   `--tcc-probe <dir>` is an ordinary launch, i.e. a window (§2.1). Confirm before copying:
   `strings "…/Daily Briefing.app/Contents/MacOS/daily-briefing-gui" | grep -c -- --tcc-probe`
   must be non-zero. Then copy
   `gui/src-tauri/target/debug/bundle/macos/Daily Briefing.app` into the VM (any transport; note
   whether the transport applied `com.apple.quarantine`, and record `xattr -l` before the first
   run — it changes what SPK-2's Gatekeeper legs see, not what this spike's legs see).
4. Put the app somewhere stable, e.g. `/Applications/Daily Briefing.app`. Do **not** launch it.
5. Create a marker file inside the protected root so a grant is distinguishable from an empty
   directory: `touch ~/Documents/spk1b-marker.txt`.

### Running a leg

```
"/Applications/Daily Briefing.app/Contents/MacOS/daily-briefing-gui" --tcc-probe ~/Documents
```

Record the JSON verbatim, plus whether a TCC prompt appeared and what it named as the requesting
application. `tccutil reset SystemPolicyDocumentsFolder com.themarigold.daily-briefing` resets a
grant between legs **in the VM only** — the plan's never-touch list forbids `tccutil` anywhere else.

### Legs

Every `status` below is **UNRUN**. `observed` stays empty until a VM exists.

| Leg | Command / action | Expected | Observed | Status |
| --- | --- | --- | --- | --- |
| B1 | probe `~/Documents`, ad-hoc `.app`, first ever run | a TCC prompt naming *Daily Briefing*; `app` = `denied` if dismissed | | UNRUN |
| B2 | grant at the prompt, re-run the same command | `app` = `ok` | | UNRUN |
| B3 | same run as B2 — read the `child` field | **the decision point.** `ok` ⇒ inheritance holds; `denied` ⇒ plan line 43's negative branch | | UNRUN |
| B4 | from snapshot `clean`: probe, **deny** at the prompt | `app` = `denied`, `childStderr` mentions *Operation not permitted* | | UNRUN |
| B5 | with B2's grant in force: rebuild ad-hoc on the host (new cdhash), replace the `.app`, probe again | `app` = `denied` — i.e. delta-verify H confirmed | | UNRUN |
| B6 | after B5: re-grant through System Settings → Privacy & Security → Files and Folders | `app` = `ok` again; record how many clicks | | UNRUN |
| B7 | from `clean`: sign the `.app` with a stable self-signed identity (SPK-2 variant (c)), install, probe, grant | `app` = `ok`; DR contains no cdhash | | UNRUN |
| B8 | rebuild + re-sign with the **same** identity, replace, probe | `app` = `ok` **without a new prompt** — the grant survived | | UNRUN |
| B9 | rebuild + re-sign a **second** time, replace, probe | `app` = `ok`, still no new prompt | | UNRUN |
| B10 | with the app grant in force, run `schedule install --invoker app` and confirm the managed copy's own grant is separate | both principals hold grants independently | | UNRUN |
| B11 | *(only if B3 = `denied`)* route a GUI-initiated run through the managed copy via a launchd one-shot and confirm it reads the protected repo | the fallback works end to end | | UNRUN |
| B12 | *(post-enrollment, deferred)* re-sign with a Developer ID, replace, probe | exactly **one** re-prompt at the transition, then stable | | UNRUN |

12 legs, 12 UNRUN.

B5 has a companion warning that is easy to get wrong: **a mutation that did not apply is not
evidence.** Confirm with `codesign -d --verbose=4` that the replacement bundle's CDHash actually
differs from the one that held the grant before reading `denied` as revocation. If the cdhash is
unchanged, the leg measured nothing.

---

## 4. The B3 decision table — write the answer here before T16/T17 build

Plan line 43 requires this recorded **before** the T16/T17 build starts.

| B3 result | What it means | Consequence for the build |
| --- | --- | --- |
| `child` = `ok` | A plain child of the `.app` inherits the app's TCC attribution. | GUI-initiated runs may spawn the engine sidecar directly, as the T7 capability already allows. T17's app-principal work is the grant flow plus the revocation detector, nothing more. The app principal still needs its own grant (B1/B2) — inheritance is about the *child*, not about the app being exempt. |
| `child` = `denied` while `app` = `ok` | Attribution is not inherited: the child is judged on its own code identity. | **Plan line 43's negative branch, quoted verbatim:** *"GUI-initiated runs fall back to routing through the managed copy (launchd one-shot) **or the app principal joins the guided-grant flow**"*. So: (i) route GUI-initiated runs through the managed copy via a launchd one-shot, so the read happens under the delegated principal that already holds the grant — this keeps the T7 allowlist engine-only but adds a launchd round trip and a new failure surface; or (ii) **the app principal joins the guided-grant flow** — which is the second of the plan's two principals asking for its own grant, not a third principal. Option (i) is the plan's first-named fallback. Recording which, and why, is a T17 gate. |
| `app` = `denied` after B2 granted | The grant did not take, or the probe is measuring the wrong thing. | Stop. Re-run B4 to confirm the probe distinguishes denial from error, and check `childStderr`. Do not build a grant flow on an instrument that cannot show a grant working. |
| `app` = `error:*` on any leg | Path or environment problem, not TCC. | Fix the path; the leg did not run. |

---

## 4a. What T17 BUILT before this spike ran, and what still depends on it

⚠ **T17 shipped in B6 with every row of §4 still UNRUN.** The plan's ordering put this spike before
the T16/T17 build; no VM exists, so the build had to be correct in BOTH branches instead of waiting
for the answer. What that means concretely:

- **The `child = ok` row is NOT assumed.** The Schedule & Access panel guides BOTH principals — the
  app (the prompt-driven read) and the managed engine copy (reveal in Finder + System Settings) —
  whenever a protected root is in scope. If inheritance turns out to hold, the managed-copy step is
  one guided step more than strictly necessary; if it does not, the briefing still works. The
  asymmetry of those two costs is the whole reason for the choice.
- **The `child = denied` row's DECISION IS RECORDED AS (ii), provisionally.** Between the plan's two
  fallbacks, B6 takes *"the app principal joins the guided-grant flow"* rather than *"route
  GUI-initiated runs through the managed copy (launchd one-shot)"*. Reasons, stated so the gate can
  be re-opened against them: (ii) needs no new exec surface at all — the app's commands stay
  engine-only and the capability gains no launchd entry — while (i) adds a launchd round trip, a new
  failure mode for a user-initiated run, and a step whose latency the user is watching. **This is a
  choice made without the measurement**, and it is provisional: if the VM shows `child = denied` AND
  the guided app-principal grant proves unobtainable or too fragile (per row 3), (i) is still
  available and costs a new command, a grant and its own review.
- **What the product calls is NOT this module.** `src/access.rs` owns the shipped read
  (`access_probe`); `src/probe.rs` stays the spike instrument and stays behind the `tcc-probe`
  feature. Since B6 the CLASSIFIER is shared — `probe.rs` delegates to `access::classify_dir_error`
  and maps its answer to the wire strings §2 documents — so the spike and the product cannot disagree
  about what an errno means (`docs/gui-seam.md` §11e, deviation 90).
- **Plan line 21's rule is implemented, not deferred.** `access::probe_advice(in_scope,
  grant_recorded)` gates the launch-time read to the revocation case and nothing else;
  `tests/access.rs` pins the table.

**Still owed by this spike, and still owed to the build:** whether the app principal's grant is
OBTAINABLE at all (B1/B2), whether it SURVIVES a rebuild (the cdhash-bound DR question), and the
inheritance answer that decides whether the managed-copy step above is necessary or merely
belt-and-braces.

---

## 5. What is deliberately not here

- **No result.** Every row above is UNRUN and stays UNRUN until a VM exists (plan §6, line 83).
- **No entitlement claims.** Hardened runtime and entitlements are SPK-2's subject; see
  `spk-2-gatekeeper-signing.md`.
- **No product wiring.** This MODULE is not called from the app at launch and is not part of a
  default build at all. The product's own read is `access::access_probe` (B6/T17), which implements
  plan line 21's revocation-detector-only rule — see §4a.
