# The capability — what the webview may ask the shell to do

`default.json` is the whole of what this webview may invoke. It grants **thirty-five** entries: the
two core event permissions `listen()` needs (`core:event:allow-listen`, `core:event:allow-unlisten`),
**ten** `allow-engine-*` permissions (Phase E's E12 adding `allow-engine-update-check` — see *Phase E's
update check*), T11's three `allow-state-snapshot` / `allow-open-today` /
`allow-app-quit`, B5's five `allow-read-latest-briefing` / `allow-read-archived-briefing` /
`allow-config-read` / `allow-config-save` / `allow-config-offer-notify-auto`, B6's four
`allow-access-snapshot` / `allow-access-probe` / `allow-access-reveal-engine` /
`allow-access-open-settings`, B7's two `allow-notify-status` / `allow-notify-set-enabled` (T18),
B8's four `allow-config-create` (T16's first-config path) and `allow-cli-shim-status` /
`allow-cli-shim-install` / `allow-cli-shim-remove` (dev 63's Settings action — see *B8's four*),
B25's two `allow-uninstall-preview` / `allow-uninstall-execute` (T25's Settings action — see
*B25's two*), Phase E M5b's two `allow-autostart-set-enabled` / `allow-autostart-wizard-default`
(the login item's ON/OFF, branded on macOS, and the wizard's pre-tick — see *Phase E M5b: the
login item*), and ONE plugin grant, T19's `autostart:allow-is-enabled` (B7 granted the plugin's
whole allow-set; M5b took back `allow-enable` / `allow-disable` — see *B7's two app commands, and
the first plugin grants*). **Nothing else: no
`core:default`, no `shell:*` permission of any kind, nothing for `tauri-plugin-notification`
(registered, live, refused — the tray's live-but-withheld command posture, though unlike the tray
it also injects an init script; see its ⚠ below), and nothing for the opener or window-state
plugins.**

⚠ **B6 ADDS A PLUGIN DEPENDENCY AND GRANTS IT NOTHING — and it goes further than that.**
`tauri-plugin-opener` `=2.5.5` is in `[dependencies]` because `src/access.rs` calls its FREE
functions (`open_url`, `reveal_item_in_dir`) Rust-side. `tauri_plugin_opener::init()` is **never
called**, so the plugin contributes no live commands — and the refusal's SHAPE is the ACL's, not
the shell's `Plugin not found` (round 1, measured): being in `[dependencies]` means `tauri-build`
collected the crate's ACL manifest, so `plugin:opener|*` is refused as *"not allowed. Permissions
associated with this command: …"* one layer before the missing registration could answer.
(`plugin:shell|*` genuinely IS `Plugin not found` — that crate is in no dependency table, so no
manifest exists for it.) The capability names no `opener:` permission;
`the_webview_cannot_reach_the_opener_plugin` pins the refusal, its ACL shape, and the absent
grant. **No JS package was added** either, so the webview has no opener client to reach for.
`tauri-plugin-dialog` is still not a dependency (`docs/gui-seam.md` §10, deviation 41).

The engine is not importable (`docs/gui-seam.md` §1: 15 of 26 `src/` modules use `Bun.*`), so the
app's entire API is argv plus stdout. What changed in T8 is **who spells that argv**: the webview
used to, through `tauri-plugin-shell`; now Rust does, in `src-tauri/src/engine.rs`, from a typed
operation enum. The webview picks an operation and cannot express anything else.

Everything below was measured against `tauri` 2.11.5 / `tauri-build` 2.6.3 / `tauri-utils` 2.9.3
(and, for the history section, `tauri-plugin-shell` 2.3.6, which is no longer a dependency in any
table) and is pinned by `../tests/capability.rs`, `../tests/engine_client.rs` and
`../tests/engine_env.rs`. Nothing here is inferred from the shape of a config.

## The design

| Layer | What it decides | Where |
| --- | --- | --- |
| The capability | which of the thirty-two app commands (ten engine operations, three shell commands, two briefing reads, four config commands, four access commands, two notify commands, three cli-shim commands, two uninstall commands, two autostart commands), which two core event commands, and which one autostart plugin command this webview may invoke | `default.json` |
| The app ACL manifest | that app commands are checked against a capability **at all** | `../build.rs` |
| `Operation` | the argv for each operation — fixed literals plus two validated operands | `../src/engine.rs` |
| The validators | whether a caller-supplied operand may reach an argv position | `../src/engine.rs` |
| The spawn | the program, the environment and the caffeinate wrapper | `../src/engine.rs` |

**One `#[tauri::command]` per operation, not one command taking the operation as an argument.** The
grant is per command name, so the capability can distinguish "may read status" from "may generate a
briefing and stamp the day". A single enum-taking command would collapse all ten into one grant
and move the distinction back into application code.

**The engine client is Tauri managed state** (`engine::Engine`, managed once in `lib.rs::run()`),
not something each command resolves for itself. That is what lets `../tests/capability.rs` inject
a fake sidecar and drive **all ten engine commands through real IPC**, asserting the argv each one
produces — so every command body is executed by a test, not merely reachable. It is also why the
app starts when the sidecar is missing: the startup `Result` is stored, and every command returns
`sidecarUnresolved` naming the path it looked at.

⚠ **An app ACL manifest is what makes this file mean anything, and that is not obvious.** Tauri 2
ACL-checks an application's own commands only when the app declared an ACL manifest —
`webview/mod.rs:1823-1826`: `if (plugin_command.is_some() || has_app_acl_manifest || !is_local)
&& request.cmd != FETCH_CHANNEL_DATA_COMMAND && invoke.acl.is_none() { reject }` (the exemption is
Tauri's own channel plumbing). Without a manifest, every `#[tauri::command]` in the crate is
reachable from the local webview whatever this file says. A capability referencing a permission no
manifest defines is a **compile error**, not a silent ungrant.

⚠ **The manifest has two sources, and either one alone keeps the gate up** — measured on a
disposable copy, all four combinations (the table is in `../build.rs`):

- `AppManifest::new().commands(…)` in `../build.rs` autogenerates an `allow-<command>` /
  `deny-<command>` pair per name into `../permissions/autogenerated/` (`tauri-build`
  `acl.rs:274-289`; the `_`→`-` slugify is `tauri-utils` `acl/build.rs:290`).
- The committed `../permissions/` directory: with the call removed, `app_manifest_permissions` falls
  through to its default `permissions/**/*` glob (`tauri-build` `acl.rs:300-328`) and finds the same
  files. `has_app_manifest` is `default_permission.is_some() || !permission_sets.is_empty() ||
  !permissions.is_empty()` (`acl.rs:408-410`), so either source makes it true.

Delete the directory with the call kept and it is regenerated; remove the call with the directory
kept and the glob finds it; remove **both** and the build fails (the grants reference permissions
nothing defines) — and only removing both *and then* editing this file to match reaches the ungated
state, where the structural tests go red. So the gate is pinned by `commands(…)` ∨ the committed
directory. The directory is committed because it is a **regenerable, tracked snapshot that makes the
manifest reviewable in a diff**, not because it is the sole gate — and because `tauri-utils` writes
it with `write_if_changed` and never deletes a file (`acl/build.rs:307-309`), a renamed command
leaves `<old>.toml` behind defining a permission nothing grants.
`autogenerated_permissions_match_the_command_set` reads the directory and catches exactly that;
`the_capability_grants_exactly_the_app_commands` pins this file's grants, `build.rs`'s list,
`commands::all_commands()` (engine, shell, briefing-file, config-save, access and — since B7 —
notification commands) and `lib.rs`'s `generate_handler!` against each other.

### The two caller-supplied operands

Only two argv positions are not fixed literals, and both are parsed into newtypes
(`JsonOutName`, `ConfigFilePath`) that cannot be constructed without passing the validator — so an
`Operation` carrying an unvalidated string is unrepresentable rather than merely unlikely. An
invalid operand is refused **before any process is created**, with a typed error naming the class.

| Flag | Accepts | Why that shape |
| --- | --- | --- |
| `--json-out` | a bare filename ending `.json`, first character ASCII alphanumeric (`first.is_ascii_alphanumeric()` in `../src/engine.rs`'s `json_out_name`), ≤ 64 characters before the suffix, no whitespace | No separator can appear, so traversal is unreachable at this layer rather than merely caught later by the engine's own `resolveJsonOutPath` guard. A bare name resolves under the engine's **state directory** (`src/json.ts`, `resolveJsonOutPath`: `isAbsolute(p) ? p : join(stateDir, p)`) — never the cwd — and the engine additionally refuses names it owns (`briefing.log`, `last-run`, `run.lock`, …). |
| `--file` | an absolute path with no empty, `.` or `..` segment; no NUL, no control character, no Unicode format character, no whitespace other than U+0020; ≤ 16 segments of ≤ 64 characters | The path's **shape** is checked (absolute, no traversal, bounded) and the things that can change the string between the caller and the syscall or make a log line lie about it are refused (NUL, control characters, non-space whitespace, format characters). A plain space, a dot-leading segment and a non-ASCII character are admitted: the value is one element of the argv **vector** `tokio::process::Command` hands to `execve` (`../src/engine.rs`, `EngineClient::invoke` — `cmd.args(&argv)`, no shell), and the engine reads the operand whole (`src/main.ts`, `readCandidate`: `Bun.file(path).text()`). |

`--json-out` is a **port of B1's capability validator, character class for character class**;
`the_operand_validators_agree_with_the_capability_regexes_they_port` compiles the original pattern
and requires agreement over a corpus. `--file` is **deliberately wider** than B1's regex, and the
same test states exactly where: B1's regex refused every dot-leading segment (its way of excluding
`..` without lookahead) and every character outside `[A-Za-z0-9._-]`, which refused
`$HOME/.config/daily-briefing/config.json` — the engine's own default config path — and everything
under `~/Library/Application Support/`, which is the engine's state directory **and** Tauri's
`app_data_dir`. Neither refusal was a security control (a symlink walks through a `..` rule; no shell
sees the space), so the port compares `.`/`..` literally and admits the rest. The test has a corpus
where port and regex agree and a corpus where the port admits and the regex refuses, asserts each as
such, and asserts the port is never *narrower* than the regex.

**The invoker on `schedule install`/`uninstall` is not caller-supplied.** The commands take
`takeOver` only and pass `--invoker app` unconditionally (`engine::Invoker` has no `Deserialize`, so
no command *can* take one). The engine's foreign-owner refusal keys on the record's `owner`
(`src/schedule/install.ts`, `existing.owner !== invoker`), which an install writes FROM `--invoker`;
a webview that could spell `--invoker cli` could forge the record that refusal protects.

`schedule verify` **was deliberately absent until B6** (T20), and the reason it was — the
verification kickstart is engine-side, inside `schedule install` (plan R1) — is unchanged: the new
operation RE-ISSUES that engine-side kick, so the app still reaches no `launchctl` and this file
still needs no launchctl entry. It is granted as a MUTATING command: the kick makes the live
scheduler run the engine, which can generate a briefing and stamp the day
(`docs/gui-seam.md` §11a). There is no `init` command — the first-run wizard is T16, and B5's
Settings screen edits an existing config through `config_save` rather than running `init` — and no
`--api-key` anywhere, because the engine has none: a literal secret on a command
line lands in shell history and in the process table.

`calendar` is also absent, and that is a **change from B1**, which allowlisted it ahead of the engine
per plan R1's forward list. It does not exist in the engine (`src/main.ts` dispatches `run | init |
status | doctor | config | help | schedule | update` and exits 2 on anything else), and a typed
command for a subcommand that does not exist is a function that reports failure for a reason the
user cannot act on. (`update --check` sat beside it on that list, for the same reason, until Phase E's
E11 gave the engine the subcommand; E12 then granted it — see *Phase E's update check* below.) The operation enum is exhaustive over the **operations the app may
perform** — the engine surface minus `init` and `help`, each excluded deliberately (`schedule
verify` was on that excluded list until B6 added it; the paragraph above says why and on what
terms) — not over R1's forward list; widening it is one enum variant, one command, one grant and
one line of justification.

### Phase E's update check (E12): `engine_update_check`

`update --check --json` — the Settings screen's "Check now" — is the tenth engine operation
(`Operation::UpdateCheck`). What the grant is, and what it is not:

- **No operand.** The argv is three fixed literals; the webview cannot shape the request, which the
  ENGINE builds (`src/updateCheck.ts`: one anonymous `GET` of the project's latest GitHub release, the
  version in the User-Agent, no query string). The webview itself still cannot reach any remote host —
  `tauri.conf.json`'s CSP is `default-src 'self'`, so there is no `connect-src` beyond the app.
- **Not mutating** (plan §5 decision 16). It changes no schedule and no briefing state; its one write
  is the engine's own atomic `<state>/update-check.json`. So `Operation::is_mutating` is false, it
  takes no in-flight guard, and "Check now" works while a run is in flight — both pinned in
  `../tests/engine_client.rs`.
- **Manual, not automatic.** It always fetches (the config's `intervalHours` gates only the engine's
  own scheduled-run check), and nothing in the webview calls it except the button. The result is read
  back later through the EXISTING `engine_status` grant (`status --json`'s `updateCheck` field), so no
  new read command exists.

### The three shell commands (T11), and the two plugins that got nothing

`state_snapshot`, `open_today` and `app_quit` are not `engine_*`: they spawn nothing. They are named
one at a time all the same, because the grant is per command name and "may raise the window" is not
"may quit the app".

| Command | Why it has to be a Rust command at all |
| --- | --- |
| `state_snapshot` | it runs `status --json` **then** `schedule status --json` through the managed `EngineClient` and derives the schedule state ONCE, in Rust. A webview doing this would be a second implementation of the state machine. |
| `open_today` | ⚠ **The webview has NO window permission at all** — and even `core:window:default` would not grant `show`, `hide`, `close`, `destroy` or `set_focus` (all declared `false` in `tauri-2.11.5/build.rs`'s `PLUGINS` table). The webview cannot raise its own window, and the tray, the single-instance callback, T16 and T18 all need something that can. It also emits `app:navigate` `"today"`. |
| `app_quit` | same reason, and it carries a guard: it REFUSES until the Quit notice has been shown this session, so a webview cannot close the app without the one dialog the appendix names as the most likely support complaint. |

**`tauri-plugin-single-instance` (2.4.4) and `tauri-plugin-window-state` (2.4.1) are dependencies and
neither is granted anything.** Measured, not assumed:

- single-instance's `src/` contains **no** `#[tauri::command]` and the crate ships **no**
  `permissions/` directory, so it contributes nothing to the ACL. There is nothing to grant.
- window-state exposes three (`save_window_state`, `restore_state`, `filename`), and the webview
  calls none of them: the plugin restores in `on_window_ready` and saves on `RunEvent::Exit`
  (`src/lib.rs:385-508`), entirely Rust-side. Granting `window-state:default` would hand the webview
  three functions nothing calls. `the_window_state_plugin_commands_are_not_granted` pins both halves
  — the commands are refused, and the capability names no `window-state:` permission.

⚠ **The structural test's filter is a LITERAL ALLOWLIST, not a prefix rule.** With plugins in the
picture the tempting rule is "ignore anything with a colon in it", which would silently admit
`shell:allow-execute` — the exact grant T8 exists to have removed — or `core:tray:allow-new`.
`NON_COMMAND_GRANTS` in `../tests/capability.rs` enumerates the core grants this app makes, and it is
exactly `core:event:allow-listen` and `core:event:allow-unlisten`. Everything else must be one of this
app's own commands. **Both grant forms are read**: a permission entry may be a string or an object
with an `identifier`, Tauri enforces both (measured: an object-form `core:window:allow-close` was
admitted while the previous string-only filter skipped it), and an entry with neither shape fails
the test.

### B5's five commands: two reads and the one config write

None of them takes a path, and none spawns anything but `status --json` and — for a save —
`config validate --json --file`, through the same managed `EngineClient`.

| Command | What bounds it |
| --- | --- |
| `read_latest_briefing` | takes nothing; reads `status --json`'s `paths.latestBriefingPath`; 1 MiB cap, UTF-8, the final component must not be a symlink (`O_NOFOLLOW` on unix), must be a regular file; never writes |
| `read_archived_briefing` | takes a DATE, parsed into `briefing_files::ArchiveDate` (ten bytes, a real calendar date) before anything else happens — traversal is unreachable by construction — then the same read under `paths.briefingsDir` |
| `config_read` | takes nothing; reads `paths.configPath`; a literal `provider.api.apiKey` never leaves Rust (a placeholder replaces it) |
| `config_save` | takes JSON text and a base token — the signature is pinned by `tests/config_save.rs`; writes only `paths.configPath` (never Tauri's `app_config_dir`), only after the ENGINE validated the candidate, atomically with a `.bak`; refuses any `transcripts` change and any new literal API key |
| `config_offer_notify_auto` | takes nothing; sets `notify: "auto"` through `config_save`'s pipeline; refused on Windows and over a custom notify command |

### B6's four: the folder-access flow (T17)

None of them takes a path or a URL, and that is by CONSTRUCTION rather than by validation — the two
operands that exist are closed enums, so there is no string a webview could send that names another
directory or another destination.

| Command | What bounds it |
| --- | --- |
| `access_snapshot` | takes an OPTIONAL `draft` (B8): up to 64 strings of ≤ 1024 bytes (both pinned as literals), no control characters and — since the B8 fix round — no zero-width/BiDi format characters, refused before any spawn (`access::checked_draft`) — the wizard's not-yet-saved repo/root paths, unioned into scope so its folder-access step can guide grants for a configuration not on disk yet. They are prefix-MATCHED and DISPLAYED only; the probe path is always built from the closed enum. Runs `status --json`, `doctor --json` and `schedule status --json`, and reports which macOS-protected folders this configuration reaches with the engine's own `tcc-denied` advice verbatim. Its ONE write is `lastLaunchVersion` in the app's own record — the post-update check (`docs/gui-seam.md` §11d) |
| `access_probe` | takes a `ProtectedRoot` (`desktop` / `documents` / `downloads` / `icloud`), joined onto the app's own `HOME` in Rust. Reads a directory LISTING — an entry COUNT reaches the webview, never a name or a byte. **The one command that can raise a macOS permission dialog**, which is why it is its own grant |
| `access_reveal_engine` | takes nothing; re-reads `binPath` from `schedule status --json` and reveals THAT, so a stale or forged value cannot reach `reveal_item_in_dir` |
| `access_open_settings` | takes a `SettingsPane` (`files-and-folders` / `full-disk-access` / `privacy-root`) and maps it to one of three `&'static str` URLs |

⚠ **The launch-time gate is Rust's, and the webview mirrors it.** `access::probe_advice(in_scope,
grant_recorded)` returns `revocation-check` for exactly one input pair; plan R1 (final-check M2)
confines a launch-time read to that case so the deselected-by-default protected-roots graft keeps its
no-unexplained-prompt property. Rust cannot tell a guided click from an ungated one, so the GUIDED
path is honoured by the panel — and `tests/access.rs` pins the gate, while
`gui/tests-web/access.check.ts` pins that the launch path reads `probeAdvice` rather than
re-deriving it.

⚠ **Every call to the opener goes through `access::OpenSink`**, so no test opens anything: opening
the real URL would launch System Settings on the machine running the suite and revealing a path would
raise a Finder window. Tests assert the URL or path that was CHOSEN.

The candidate file `config_save` validates is written under `app_data_dir()/config-candidates/`
(mode 0600, removed after validation) and passed to `config validate --file` through B3's
`config_file_path` validator, unchanged. `tests/capability.rs`'s
`the_b5_commands_are_admitted_and_run_their_own_code` drives all five through the ACL;
`tests/briefing_files.rs` and `tests/config_save.rs` drive their pipelines.

### B7's two app commands, and the first plugin grants (T18/T19)

**T18's two** are the app's notification opt-in, and neither can POST anything at all — posting is
a Rust decision driven by the watcher (`src/notifications.rs`, `on_snapshot`), gated by the record
these commands read and write:

| Command | What bounds it |
| --- | --- |
| `notify_status` | takes nothing; reads the app-owned opt-in record, the ENGINE's `notify` value (one `status --json` to locate the config, then a local read) with the resolved-capability predicate's answer computed in Rust (`docs/gui-seam.md` §12 — a TypeScript copy of that predicate is the drift §4 warns about), and the suppression log |
| `notify_set_enabled` | takes one boolean; writes `<app_data_dir>/notify-state.json`. It is the EXPLAINED ask's answer — a user gesture on the Settings/Schedule UI (and B8's wizard step). It posts nothing; the first real post afterwards is what triggers the OS's own registration |

**T19's grants were the first PLUGIN grants this capability ever carried.** B7 granted the whole
of `tauri-plugin-autostart 2.5.1`'s shipped allow-set — its `permissions/default.toml` is exactly
`allow-enable`, `allow-disable`, `allow-is-enabled` (read from the crate, not assumed). **Phase E
M5b keeps ONE of them:**

| Grant | Why the webview holds it |
| --- | --- |
| `autostart:allow-is-enabled` | the Settings toggle must reflect REAL state — a `stat` of `~/Library/LaunchAgents/<app name>.plist` — on every render, never a cached boolean (plan T19) |
| ~~`autostart:allow-enable`~~ | **withdrawn in M5b.** The plugin's `enable()` writes an UNBRANDED plist; with this grant the webview held a second ON that skipped the branding. Every ON is now `autostart_set_enabled` (below) |
| ~~`autostart:allow-disable`~~ | **withdrawn in M5b** with its twin, so ON and OFF are one app command, not an app command and a plugin command. The real `disable()` is still what removes the plist — reached Rust-side through `autostart::disable_now` (the toggle's OFF and T25's uninstall) |

⚠ **The plugin's `enable`/`disable` are now REFUSED to the webview**, and `is_enabled` admitted:
`the_webview_reaches_autostart_only_through_is_enabled_and_the_two_app_commands` asserts all three
against a mock app WITHOUT the plugin registered — the ACL answers before plugin dispatch, so the
grant (and the refusals, which are the ACL's own "Permissions associated with this command": the
crate is in `[dependencies]`) are proven while nothing real can run. The label the plugin derives
is pinned against the CLI scheduler's `local.daily-briefing` by `tests/autostart.rs`'s label test.

### Phase E M5b: the login item (T19 reworked, user-directed)

Two app commands replace the two withdrawn plugin grants. Neither takes a path, and NOTHING at
launch calls either — the app registers no login item until the setup wizard's last step (or the
Settings toggle) asks (`src/autostart.rs`; `tests/autostart.rs`'s
`nothing_registers_a_login_item_at_launch`).

| Command | What bounds it |
| --- | --- |
| `autostart_set_enabled` | takes ONE boolean. ON is the plugin's `enable()` — the same fixed plist as before (below) — followed, on macOS, by `brand_launch_agent`: parse that plist with the `plist` crate, refuse it unless its `Label` is this app's, add `AssociatedBundleIdentifiers` = `[tauri.conf.json's identifier]`, and replace the file atomically (a temp file CREATED with `create_new`, never opened through a planted link, mode 0644), keeping every other key. OFF is the plugin's `disable()`. Either way it records `<app_data_dir>/autostart-state.json` (a choice was made). The whole ON or OFF holds one change lock (`autostart::lock_changes`, shared with the uninstall's disable), so an OFF cannot land inside an ON's branding. The Settings toggle's ON/OFF and the wizard's Finish both come through here, so there is no unbranded ON. The webview then offers engine `notify: "auto"` after an OFF through the EXISTING `config_offer_notify_auto` grant (T11 rework) |
| `autostart_wizard_default` | takes nothing; READS that record and `is_enabled()` and answers the wizard's pre-tick: ON with no record (a fresh install, plan R1's default), else the real state — an ERROR when a choice is recorded but the state cannot be read, which the wizard treats as unknown and leaves alone. It enables nothing |

Both are driven against the recording sink and a scratch store (`tests/autostart.rs`,
`tests/capability.rs`); the branding against scratch plists only. The real `enable()`/`disable()`
and the rewrite of the real `~/Library/LaunchAgents` plist are VM-gated (`docs/gui-seam.md` §12c,
§12d), and whether macOS 13+ then shows "Daily Briefing" with the app's icon is **UNVERIFIED**
until the Phase F VM.

⚠ **Why the plist an ON writes is still safe, stated in full** (B7 round 1 asked for this to be
the register, not an implication). The plist the plugin's `enable` writes has exactly THREE inputs, and
every one is bound Rust-side at setup, none by the webview: the **Label/file name** is
`package_info().name` (the productName, "Daily Briefing" — pinned by the label test and by
`the_product_name_the_register_hardcodes_is_pinned`); the **program path** is `current_exe()`
(the running bundle — the webview supplies nothing); and the **args** are the `None` passed to
`init(MacosLauncher::LaunchAgent, None)` at registration, which is TEST-PINNED
(`lib_rs_registers_the_plugin_with_the_default_name`'s whitespace-stripped
compare — `auto-launch 0.5.0` writes `ProgramArguments = [app_path] + args`, so an unpinned args
vector would be launch-time argv this sentence silently depended on). M5b's branding adds a
FOURTH key with a fixed value (the bundle identifier, from `tauri.conf.json`), never a webview
input. The commands themselves take at most one boolean — there is no string a webview could send
that changes any of the inputs — and `disable` can only remove the one fixed path the same
derivation names. A command that could write an arbitrary plist, point one at another binary, or
smuggle argv would be none of these things; these can do exactly one thing each, to one file,
with fixed content.

⚠ **`tauri-plugin-notification` is REGISTERED and granted NOTHING.** Registration is what makes
the Rust-side post possible (`NotificationExt` resolves managed plugin state), and it makes the
plugin's three commands LIVE — so, as with the core tray feature's commands, the capability must
withhold them and `the_webview_cannot_reach_the_notification_plugin` refuses
`plugin:notification|notify` / `request_permission` / `is_permission_granted` behaviourally. The
plugin's `default` permission set (16 members, most mobile-only) is deliberately not granted in
any part: a webview that could post would put repo-influenced strings on the user's screen outside
the app's §5 boundary and outside the opt-in gate. ⚠ The tray comparison covers the COMMANDS only
— this plugin does one thing the tray never does: registration injects its `js_init_script` into
every page, which REPLACES `window.Notification` with an all-refused shim and fires an ungranted
`is_permission_granted` on load (rejected by this ACL, an unhandled promise rejection in the
console — `docs/gui-seam.md` §12c). Nothing in this webview consumes `window.Notification`
(grepped: zero uses), so the shim shadows an API nobody calls; it is noted so the console noise
and the shadowed global are a recorded surface rather than a surprise.

### B8's four: the first-config write (T16) and the CLI shim (dev 63)

| Command | What bounds it |
| --- | --- |
| `config_create` | takes JSON text — no path, no base token (there is no file to have changed). The do-not-clobber guarantee is the EXCLUSIVE create (`config_save::create_config_file`): a hard link from a staged, `fsync`ed temp onto the config name is atomic AND fails `EEXIST` when anything — a racing `daily-briefing init`, a dotfiles symlink — appeared, refused as `alreadyExists` and never replaced. The engine validates first (`config validate --json --file`, same candidate discipline as `config_save`); a literal key is refused outright — since the B8 fix round, any object key spelled `apiKey` case-insensitively, anywhere in the document (`apiKeyFile`/`apiKeyCommand` stay legal: the wizard's native-key path carries those REFERENCES, and the app never asks for, sets or echoes a key value); any `transcripts` block is refused (the human gate: on a create, the only unchanged value is absence). Owner-only mode when the candidate carries `provider.api`, as `initConfig` does |
| `cli_shim_status` | takes nothing; two engine reads (`schedule status --json` for `binPath`, `status --json` for the state dir) plus one `lstat`/`readlink` of `/usr/local/bin/daily-briefing`. Read-only |
| `cli_shim_install` | takes nothing — the symlink TARGET is re-read from `schedule status --json`'s `binPath` (the `access_reveal_engine` rule), never webview-supplied. Refuses when no managed copy exists; refuses a FOREIGN file at the name (`cli_shim::classify`: ours = the managed copy, or another name in the engine's state directory); exclusive symlink for a fresh install, temp-symlink + rename for repairing a stale one of ours. A permission refusal (root-owned or missing `/usr/local/bin`) returns the exact `sudo ln -sfn …` line — shell-quoted, since the B8 fix round: the real target path contains a space — for the USER to run; this app never escalates and never shells out |
| `cli_shim_remove` | takes nothing; removes ONLY a symlink `classify` calls ours; a foreign file is refused and untouched; nothing at the name is an idempotent no-op. Permission refusals return `sudo rm …` the same way |

The real `/usr/local/bin` leg is behind the injectable `ShimSink` and is **UNRUN in this suite**
(every test uses a recording sink or a scratch directory — `docs/gui-seam.md` §13's register);
`tests/cli_shim.rs` drives the real `SystemShim` against scratch paths only.

### B25's two: the uninstall action (T25)

| Command | What bounds it |
| --- | --- |
| `uninstall_preview` | takes nothing; one engine read (`status --json`, for `paths.stateDir`), one `is_enabled()` read through T19's sink-or-plugin resolution, and `lstat`s of the ENUMERATED names. Read-only — nothing is removed by a preview |
| `uninstall_execute` | takes exactly ONE boolean — the explicit consent for the engine-data leg — and no path anywhere: the app-file names are module constants (`uninstall.rs`: the three `STORE_FILE`s, the candidate dir, the window-state plugin's own `DEFAULT_FILENAME`), the engine-state names mirror `scripts/uninstall.sh`'s `$SUPPORT`-rooted list token for token (set-equality with a test-time PARSE of the script, `tests/uninstall.rs` — the T9 parity pattern), and the state dir is re-read from `status --json`. Without the flag the engine leg is not attempted at all. NEVER a recursive delete of the state dir (the one `remove_dir_all` is the `briefings` subdirectory the script itself `rm -rf`s; survivors pinned by test), never the launchd domain (the CLI's unit is `schedule uninstall`'s), and the login-item removal is T19's plugin `disable()` reused, not a plist removal of this module's own. ⚠ With consent this is the ONE webview-reachable surface that can remove the briefing archive — the consent wording must name it (`coexistence.check.ts` pins the label) — and `tests-web/history.check.ts` carries it as an enumerated, argued exception to its no-deletion-surface claim |

The real filesystem defaults are behind the injectable `UninstallFs` sink and the two directory
overrides; the real autostart-disable leg is **UNRUN in this suite** with the rest of T19
(`docs/gui-seam.md` §12c, §16c). `tests/uninstall.rs` drives the real `SystemFs` against scratch
directories only.

### Why not `core:default`

B1–B4 granted `core:default` "wholesale, as the surface the app needs to exist". MEASURED in round 1
of the B4 review, through the mock app: with it, the webview was ADMITTED to `plugin:tray|new`,
`get_by_id`, `remove_by_id`, `set_title`, `set_tooltip`, `set_visible`, `set_menu`;
`plugin:menu|new`, `set_as_app_menu`, `set_text`; `plugin:resources|close`; and
`plugin:event|emit` / `emit_to` — and a webview-emitted `state:changed` reached a Rust-side listener.
The webview imports exactly two things from `@tauri-apps/api`: `invoke` (for this app's own commands,
which need no core grant) and `listen` (which invokes `plugin:event|listen`, and whose returned
function invokes `plugin:event|unlisten`). So those two are granted and nothing else;
`the_webview_cannot_reach_the_tray_menu_resources_or_emit` pins the refusals (as the ACL's refusals,
not "command not found"), and `listen_and_unlisten_are_admitted` executes the two grants.

### No capability entry for the spawn itself

`/usr/bin/caffeinate`, the PATH, the sidecar's absolute path: none of them needs a scope entry,
because none of them is reachable from the webview. They are arguments to a `std`/`tokio` `Command`
constructed inside `engine.rs`, behind the ten engine commands above (the other twenty app
commands reach the engine only through the same client). B1 needed a pinned scope entry for
caffeinate precisely because the webview was the thing doing the spawning.

## History: the measured ceiling this replaced

Kept because it is the reason the design is what it is, and because a future contributor will
otherwise re-propose the thing that was measured not to work.

B1 shipped a `shell:allow-execute` scope with twenty-five argv entries, one per subcommand. It was
measured to enforce **normalisation, not rejection**:

1. A sidecar's scope key **is** its `externalBin` path, so every entry necessarily shared the name
   `binaries/daily-briefing`.
2. The lookup is `self.scopes.iter().find(|s| s.name == command_name)` — `find`, so the **first**
   entry won and the rest were never reached.
3. For an entry whose args are all fixed literals, `scope::_prepare` maps over the **allowed** list
   rather than the supplied one: each position emits its own literal whatever the caller sent.

So a foreign argv was not refused — it was discarded and replaced. Measured directly: sending
`["run", "--force"]` caused the engine to execute `status --json`. Security-wise that was strong
(exactly one argv was reachable) and functionally it was a ceiling: **the app could reach exactly one
subcommand**, and `scheduleInstall()` returned exit 0 having installed nothing. Entry order was
load-bearing, `status --json` was pinned as entry 0 because it is the only harmless one, and the
frontend's other seven builders threw rather than spawn.

B1's own conclusion was that lifting it needed argv built Rust-side behind a typed command with an
exhaustive operation enum. That is this change.

**The second thing that went with it.** `tauri-plugin-shell` forwarded two frontend-supplied fields
straight past the scope — `cwd` and `env` (`commands.rs:149-155`) — so the capability constrained
WHICH program ran with WHICH arguments and nothing else about the spawn. That mattered because
environment is a second control channel into the engine: `DAILY_BRIEFING_STATE_DIR`
(`src/marker.ts:10`) redirects every path it reads and `XDG_CONFIG_HOME` (`src/config.ts`,
`configPath()`) redirects the config it loads, so a webview that could reach `Command.sidecar` at all
could make `status --json` report on a directory of its choosing. The engine commands take no
environment, no working directory and no program, so there is nothing left to forward.

## Known gaps

- **The path validators cap depth and segment length.** `--file` accepts at most **16 segments** and
  at most **64 characters per segment**. A deeply nested or long-named path is refused with a typed
  reason (`SegmentTooLong` / `TooManySegments`) rather than the silent permission-layer refusal B1's
  regex gave. Both numbers are arbitrary-but-generous rather than principled; widen them
  deliberately, with a test.
- **`--file` no longer refuses dot-leading segments or spaces** — B1's regex did both, and that
  refused the engine's default config path and everything under `~/Library/Application Support/`.
  What is *still* refused, and why: NUL (truncates the argv string at the syscall boundary), control
  characters and whitespace other than U+0020 (make a terminal or a log render a string other than
  the one `execve` received), `.`/`..` segments (a candidate path with traversal in it is not a
  candidate path; the check is a literal comparison now, not the leading-character rule), relative
  paths and empty segments (not a file's path), and the two ceilings. Whitespace itself is **not** a
  hazard on this path because `tokio::process::Command` passes an argv vector to `execve` with no
  shell in between (`../src/engine.rs`, `EngineClient::invoke`: `cmd.args(&argv)`) — a space cannot
  become a second token. `--json-out` keeps refusing all whitespace and dot-leading names: it is a
  bare filename that lands in the engine's state directory, and there is no legitimate name of that
  shape.
- **A `--file` path segment MAY start with a dash** (`/-rf` is accepted), and that is deliberate
  rather than an oversight: the leading-dash hazard does not apply here because the value always
  begins with `/` — it can never be read as a flag by whatever parses the argv next. `--json-out` is
  the opposite case (a bare filename, whose first character IS the value's) and refuses it.
- **`--file` REFUSES Unicode format characters** (category `Cf` — bidi overrides and isolates, the
  zero-width space/joiners, the soft hyphen, the BOM, the interlinear annotation marks
  U+FFF9–U+FFFB, and U+E0001 plus the 96 TAG CHARACTERS U+E0020–U+E007F — an invisible mirror of
  ASCII), as `InputRefusal::FormatCharacter`. This was a deferred gap until round 2, on the
  reasoning that a format character cannot change what the engine opens and the app renders no
  path back. The second half was wrong, and it was measured:
  the ENGINE's own stderr echoes the operand — a failed `config validate --file` prints
  `could not read ${path}` (`src/main.ts:773-787`) and its `stripControl` (`src/render.ts`)
  strips `[\x00-\x1f\x7f-\x9f]` only, so the bytes survive — and that stderr reaches the webview
  verbatim, as `EngineOutcome.stderr` and as each `ProgressEvent.line`. MEASURED end to end:
  `config validate --json --file /<U+202E>evil.json` against the real sidecar exits 2 and writes
  the path verbatim TWICE to stderr. The list is enumerated in `engine::REFUSED_FORMAT_CHARACTERS`
  rather than taken from a Unicode-category crate (the standard library has no `Cf` predicate:
  `char::is_control` is `Cc` only), and widening it is a one-line diff with a test — which round 3
  did: the round-2 list stopped at the BMP, reasoning that the rest was "plane-1 formatting nobody
  puts in a path"; the tag characters are plane-14 formatting that is exactly what someone puts in
  a path. MEASURED against Python 3's bundled UCD 16.0.0 the category is **170** code points, of
  which the list now refuses **123**; the 47 still admitted are named in the constant's doc comment
  (Arabic/Syriac/Kaithi number and ayah marks, Egyptian hieroglyph and Duployan format controls,
  musical beam marks — and U+206A–U+206F, deprecated since Unicode 5.1, the one invisible group
  still admitted).
  `--json-out` refused all of them already, as "outside `[A-Za-z0-9._-]`"; it now reports the same
  `FormatCharacter` class, which changes no verdict and only names the one refusal whose offending
  character is invisible.
- **The in-flight guard covers state-changing operations only** — `run`, `schedule install`,
  `schedule uninstall` and, since B6, `schedule verify` (the partition is pinned literally by
  `the_in_flight_guard_covers_exactly_the_state_changing_operations`). A `status` or `doctor` poll
  is never refused with `Busy`, because a panel that stopped refreshing while a run was in flight
  would fail exactly when it has the most to show. The guard is also **in-process**: a CLI run
  started in a terminal is out of its scope, which is what the engine's own `run.lock` (backlog
  IN-5) is for.
- **There is no cancel, and a dropped invocation takes the sidecar's whole process group.** A
  command future is never dropped mid-flight (bodies run detached on Tauri's runtime; app exit is
  `AppHandle::exit`, which drops none of them). The one shipped drop is T10/T11's 30 s READ timeout
  (`shell::EngineSnapshots`), which abandons a hung `status --json` / `schedule status --json`. There
  `kill_on_drop` kills the spawned pid — which under `caffeinate -i` is the sidecar itself,
  caffeinate having `exec`ed it and forked the assertion holder as its child — and, on unix,
  `engine::ProcessGroupKill` SIGKILLs the group that spawn was given (`process_group(0)`), so a hung
  `launchctl list` the sidecar forked dies with it instead of outliving the timeout as an orphan
  (`docs/gui-seam.md` §8; deviation 30, retired). A GENERATION is never dropped this way, and the
  engine's `run.lock` handles a sidecar that outlives its caller.
- **`--json-out` cannot name a directory, so an envelope can only land in the ENGINE's state dir.**
  Plan R1 spells the flag `--json-out <path>`; this app accepts a bare `.json` FILENAME only,
  inherited from B1's capability regex, and the engine resolves a relative name under its own state
  directory (`src/json.ts`, `resolveJsonOutPath`). So a T10–T15 surface cannot ask for the envelope
  in Tauri's `app_data_dir`: it has to read it back out of the state directory, which `status`
  reports. Widening this means admitting a separator here, which is the one thing that makes
  traversal reachable at this layer — so it wants an absolute-path validator like `--file`'s, not a
  relaxed filename.

- **The two event grants admit ANY event name.** `core:event:allow-listen` is not scoped by event,
  so the webview may listen to every event the Rust side emits to it — which is the same set it is
  sent anyway. It cannot EMIT (`plugin:event|emit` is refused).
- **Two of Tauri's own init scripts call commands this capability refuses, deliberately.** In a
  debug build tauri injects a devtools hotkey that invokes `plugin:webview|internal_toggle_devtools`
  (`tauri-2.11.5/src/webview/plugin.rs:206-222`), and on macOS it injects a `window.print` shim that
  invokes `plugin:webview|print` (`:200-204`). Neither is granted, and both are refused by the
  permission layer (`the_webview_cannot_reach_the_tray_menu_resources_or_emit` pins it) — so a debug
  build's devtools hotkey is inert, and so is `window.print()` on macOS — because neither is
  something this app offers, and granting `core:webview:*` for them would hand the webview far more
  than two commands.
- **`HOME` is forwarded to the sidecar** (`engine::FORWARDED_ENV`), because the engine resolves its
  state directory from it and git reads its config from it. The test suite's sandboxing therefore
  rests on `DAILY_BRIEFING_STATE_DIR`, `XDG_CONFIG_HOME` and `DBA_TEST_UNIT_DIR` rather than on
  `HOME`; a future engine surface that read `~` directly would escape it. The tests assert the
  sandbox from `status`'s own reported paths rather than assuming it.
- **Nothing else is forwarded — including `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.** The forwarded
  set is pinned by literal (`the_forwarded_set_is_exactly_these_seven`) and by behaviour
  (`secrets_and_overrides_in_the_parent_never_reach_the_child`). That matches the launchd plist,
  which sets `PATH` only (`src/schedule/units.ts`), and it means the engine's `apiKeyEnv` rung
  (`src/apiKey.ts`) cannot resolve a key from the app any more than from launchd; a key must come
  from `apiKeyFile`, `apiKeyCommand` or the config. See `docs/gui-seam.md` §6 for the T15 note.
