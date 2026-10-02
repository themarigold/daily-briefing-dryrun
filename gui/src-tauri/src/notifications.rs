//! T18 — desktop notifications, DELEGATED-WATCHER ARM ONLY (B7).
//!
//! ## The one notification source in this build
//!
//! Plan R1 defers the app-owned tick out of 0.2.0, so there is no app-run outcome to notify from.
//! The only source is B4's watcher: every snapshot it announces passes through [`on_snapshot`],
//! and a PURE state machine ([`Observation`]) decides whether this snapshot is NEWS — a delivery
//! the app watched happen, or a failure the engine recorded today — or merely the state the world
//! was already in. The distinction is a TRANSITION: the first snapshot after startup is absorbed as
//! the baseline and never fires, because a briefing that was already delivered when the app opened
//! is not an event, it is furniture.
//!
//! ## The classes, and the never-notify rule
//!
//!   * **DELIVERED** — the watcher observed BOTH `last-run` flip to today (the derived phase
//!     becoming `delivered`, deduped by the run DATE) AND `briefing-latest.md` change (its mtime
//!     differing from the baseline the machine holds). Title carries the date; the body is the
//!     briefing's first resume line; the click route is Today.
//!   * **FAILED** — today's skip record says the engine TRIED and failed: `provider-fail` (after
//!     the engine's own retries), `parse-empty`, `marker-fail`, `crashed`. The body is the engine's
//!     literal error line (the skip record's `detail` — the engine redacts its own diagnostics
//!     since PR #496, so it is relayed without app-side redaction; control characters are still
//!     stripped, §5's sanitization boundary, which is not redaction). Click route: the Schedule
//!     screen — there is no Diagnostics route in this app (deviation register, `docs/gui-seam.md`
//!     §12b).
//!   * **BLOCKED** — the `blocked` skip: zero activity AND an unreadable repo. Click route: the
//!     Schedule screen, whose Schedule & Access panel is the T17 grant flow.
//!   * **NEVER for a legitimate skip.** [`skip_notify_class`] enumerates the ENGINE's whole
//!     `SKIP_REASONS` vocabulary (pinned against `src/json.ts` by
//!     `the_skip_vocabulary_matches_the_engine`) and maps `already-ran`, `below-floor`, `offline`,
//!     `darkwake`, `concurrent`, `limited`, `no-config` and `config-error` to SILENCE — notifying
//!     on normal behaviour trains the user to ignore the app, and the standing conditions among
//!     them (`no-config`, `config-error`) are what the tray line and the window already say all
//!     day. An UNKNOWN reason is silence too (the additive rule: a reason this build has never
//!     heard of must not surprise anyone; the Schedule screen still renders it). The appendix's
//!     "quiet-day" is not a member — the engine emits no such skip; a quiet day is a DELIVERED
//!     briefing (`(no commits in the window)`) and notifies as one.
//!
//! ## Notify ownership — the resolved-capability rule (plan T18, R1)
//!
//! The app suppresses its own DELIVERED notification only when the ENGINE's `notify` config
//! RESOLVES to an actual emitter on this platform — `src/notify.ts`'s `notifyArgv(...) !== null`,
//! NOT "configured ≠ off" (`"auto"` on Windows resolves to nothing at all, and keying on the raw
//! value would produce a double silence). The engine exposes no resolved value on any JSON surface;
//! what it exposes is the PURE, exported `notifyArgv` itself, which `docs/gui-seam.md` §4 names as
//! the GUI's suppression predicate. [`engine_will_notify`] is that predicate ported member for
//! member, evaluated over the `notify` value of the config file the app already reads
//! (`status --json` → `paths.configPath`), and pinned against the engine's own function:
//! `tests/fixtures/notify_predicate.json` is replayed through THIS port by
//! `tests/notifications.rs` and through the engine's `notifyArgv` by
//! `gui/tests-web/notify.check.ts`, so the two cannot drift silently.
//!
//! Suppression is scoped to DELIVERED alone: the engine's notifier fires only on the delivered
//! path (`src/main.ts:489` is the one `notify(...)` call), so suppressing FAILED or BLOCKED would
//! be a double silence under every possible config.
//!
//! ## Permission — no prompt from a background fire, ever
//!
//! The plugin's desktop permission API is a stub: `permission_state()` and `request_permission()`
//! both return `Granted` unconditionally (`tauri-plugin-notification-2.4.0/src/desktop.rs`), and
//! the REAL macOS ask happens at the first actual post. So the honest gate is the app's OWN
//! opt-in record ([`NotifyRecord::enabled`]): `None` (never asked) and `Some(false)` both mean a
//! firing is recorded as suppressed and nothing is posted — no notification and no OS prompt can
//! come out of a background event before the user enables notifications in the Settings/Schedule
//! UI, where the ask carries its explanation. T16's wizard (B8) wires its notifications step
//! through the same `notify_set_enabled` command.
//!
//! ## What is real, and what is VM-gated
//!
//! Every post goes through the injectable [`NotifySink`]; the suite manages a recording sink and
//! NEVER posts (a real post from an unsigned test bundle is the appendix's UNVERIFIED leg —
//! `docs/gui-seam.md` §12c). The shipped path — `tauri-plugin-notification`'s
//! `builder().title(…).body(…).show()` — is reached only from `lib.rs`'s app, whose managed
//! [`NotifyState`] carries no injected sink. The click ROUTE is computed and carried on every
//! [`Notification`] so a sink (and a future plugin that delivers desktop click events) has it;
//! the 2.4.0 desktop plugin fires no click event at all (its `show()` detaches and discards the
//! handle), so the shipped click behaviour is the OS's default activation — §12b's register entry.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::briefing_files::read_text_capped;
use crate::schedule_state::{Phase, SkipReason, StatusView};
use crate::watcher::Snapshot;

/* ── the classes ──────────────────────────────────────────────────────────────────────────────── */

/// The three notification classes T18 ships. A CLOSED set: anything else is silence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotifyClass {
    Delivered,
    Failed,
    Blocked,
}

impl NotifyClass {
    /// Where a click on this class's notification should land, as an `app:navigate` target.
    ///
    /// ⚠ FAILED and BLOCKED both route to `"schedule"`: there is no Diagnostics route in this app
    /// (the appendix's wording maps to the Schedule screen — deviation register), and the T17
    /// Schedule & Access flow LIVES on the Schedule screen. The route is carried on the
    /// [`Notification`] for the sink; the shipped desktop plugin cannot deliver a click (module
    /// header), so today it documents intent and serves the recording sink's assertions.
    pub fn route(self) -> &'static str {
        match self {
            NotifyClass::Delivered => "today",
            NotifyClass::Failed | NotifyClass::Blocked => "schedule",
        }
    }

    /// The wire spelling, for `notify_status` and the suppression record.
    pub fn as_str(self) -> &'static str {
        match self {
            NotifyClass::Delivered => "delivered",
            NotifyClass::Failed => "failed",
            NotifyClass::Blocked => "blocked",
        }
    }
}

/// Which notification class a skip reason belongs to, or `None` for silence.
///
/// ⚠ EXHAUSTIVE OVER THE CLOSED VOCABULARY, NO WILDCARD ARM except the typed `Unknown` — so a
/// `SkipReason` variant added tomorrow is a COMPILE error here, forcing the notify decision to be
/// made rather than defaulted. The silence arms, each with its reason:
///
///   * `already-ran`, `below-floor` — the ordinary day, ~17 hours of it.
///   * `offline`, `darkwake` — the machine's own mornings; the next tick retries.
///   * `concurrent` — another run holds the lock (a manual run raced the tick); transient.
///   * `limited` — every account at its usage limit; the engine keeps trying and may deliver when
///     the limit resets, and the Today screen carries the engine's own `detail` line with the
///     reset time where one is honest. A 07:20 banner would be noise about a state that may
///     resolve itself by 09:00.
///   * `no-config`, `config-error` — STANDING conditions, rewritten by every tick (144/day): the
///     tray line and the Schedule screen show them all day, and a daily banner for a state that
///     does not change trains the user to swipe it away.
///   * `Unknown(_)` — the additive rule: an engine newer than this app must not surprise the user
///     with a banner this build has no wording for. Silence, and the Schedule screen still shows
///     the raw reason.
pub fn skip_notify_class(reason: &SkipReason) -> Option<NotifyClass> {
    match reason {
        SkipReason::ProviderFail
        | SkipReason::ParseEmpty
        | SkipReason::MarkerFail
        | SkipReason::Crashed => Some(NotifyClass::Failed),
        SkipReason::Blocked => Some(NotifyClass::Blocked),
        SkipReason::AlreadyRan
        | SkipReason::BelowFloor
        | SkipReason::NoConfig
        | SkipReason::ConfigError
        | SkipReason::Concurrent
        | SkipReason::Offline
        | SkipReason::Darkwake
        | SkipReason::Limited => None,
        SkipReason::Unknown(_) => None,
    }
}

/* ── §5's sanitization boundary, and the body builders ────────────────────────────────────────── */

/// The engine's `stripControl` (`src/render.ts`), ported: C0, DEL and C1 removed.
///
/// ⚠ NOT REDACTION. The brief forbids app-side redaction of engine text (the engine redacts its
/// own diagnostics since PR #496); this is `docs/gui-seam.md` §5's sanitization boundary, which
/// every new render surface re-implements — a notification body is a render surface, and skip
/// details interpolate repo-controlled strings in the general case. Pinned against the engine's
/// literal by `tests/notifications.rs`'s `strip_control_matches_the_engines`.
pub fn strip_control(s: &str) -> String {
    s.chars()
        .filter(|c| {
            let n = *c as u32;
            !(n <= 0x1f || (0x7f..=0x9f).contains(&n))
        })
        .collect()
}

/// The longest body a notification carries. Banners truncate around 120–180 characters; the cap
/// exists so a multi-kilobyte `detail` line cannot be handed to the notifier verbatim.
pub const MAX_BODY_CHARS: usize = 180;

/// One line, control-stripped, capped at [`MAX_BODY_CHARS`] (with an ellipsis when cut).
pub fn notification_line(s: &str) -> String {
    let line = strip_control(s.lines().next().unwrap_or(""))
        .trim()
        .to_string();
    if line.chars().count() <= MAX_BODY_CHARS {
        return line;
    }
    let mut cut: String = line.chars().take(MAX_BODY_CHARS - 1).collect();
    cut.push('…');
    cut
}

/// Strip the markdown markers a resume bullet can carry, so a notification body reads as plain
/// text: inline code fences (`` ` ``), bold (`**`), and `[text](url)` links reduced to their text.
///
/// ⚠ DELIBERATELY NOT a markdown renderer, and deliberately narrow: `_` is untouched (snake_case
/// repo and branch names are everywhere in these bullets), and a bare `[label]` without a
/// following `(…)` is untouched too — the engine's own `[${r.repo}]` prefix is exactly that
/// shape. This is display cleanup on top of §5's boundary ([`notification_line`] still strips
/// control characters and caps), not a second sanitizer.
pub fn strip_markdown_markers(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        // `[text](url)` → `text`. Only when the closing bracket is IMMEDIATELY followed by a
        // parenthesised target — anything else keeps its brackets. The close is the MATCHING
        // bracket (depth-counted), not the first `]`: link text can itself carry brackets
        // (`[text with [nested] info](url)`, `[[foo]](url)`), and the first-`]` scan found no
        // `(` after the inner close and left the whole segment unprocessed (round 2, GE2). One
        // level is enough — the extracted text is emitted as-is, so an inner bare `[label]`
        // survives exactly like a standalone one (the engine's own `[${r.repo}]` shape), while
        // an inner `[x](y)` link is reached again by the ordinary scan when the OUTER pair does
        // not form a link.
        if chars[i] == '[' {
            let mut depth = 0usize;
            let mut close = None;
            for (j, c) in chars.iter().enumerate().skip(i) {
                match c {
                    '[' => depth += 1,
                    ']' => {
                        depth -= 1;
                        if depth == 0 {
                            close = Some(j);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            if let Some(close) = close {
                if chars.get(close + 1) == Some(&'(') {
                    if let Some(end) = chars[close + 2..].iter().position(|c| *c == ')') {
                        out.extend(&chars[i + 1..close]);
                        i = close + 2 + end + 1;
                        continue;
                    }
                }
            }
        }
        if chars[i] == '*' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            continue;
        }
        if chars[i] == '`' {
            i += 1;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// The briefing's first resume line: the first `   • ` bullet after the first `▶ ` heading.
///
/// The prefixes are the engine's own (`src/render.ts`: `L.push(\`▶ Where you left off${stamp}\`)`
/// and the `   • [${r.repo}] ${r.text}` bullets — branch state first, then resume, which is also
/// the reading order the render puts them in). `(nothing in progress)` mornings have no bullet and
/// fall back to the fixed body. Pinned against the engine's literals by
/// `the_resume_prefixes_are_the_engines`. The bullet text is user prose in the general case, so
/// its markdown markers are stripped for the banner ([`strip_markdown_markers`]).
pub fn first_resume_line(markdown: &str) -> Option<String> {
    let mut past_heading = false;
    for line in markdown.lines() {
        if !past_heading {
            if line.starts_with("▶ ") {
                past_heading = true;
            }
            continue;
        }
        if line.starts_with("▶ ") {
            return None; // the next section began; this morning has no resume bullet
        }
        if line.starts_with("   • ") {
            let text = line.trim_start().trim_start_matches("• ").trim();
            if !text.is_empty() {
                let plain = strip_markdown_markers(text);
                let plain = plain.trim();
                if !plain.is_empty() {
                    return Some(notification_line(plain));
                }
            }
        }
    }
    None
}

/* ── the notify-ownership predicate (plan T18, resolved-capability form) ──────────────────────── */

/// `src/notify.ts`'s `resolveNotify`, classified for display: what the engine treats this value as.
pub fn classify_notify(value: Option<&Value>) -> &'static str {
    match value {
        None | Some(Value::Null) => "off",
        Some(Value::String(s)) if s == "off" => "off",
        Some(Value::String(s)) if s == "auto" => "auto",
        Some(v) if crate::config_save::is_custom_notify(v) => "custom",
        Some(_) => "invalid", // resolveNotify: off, with a validate-time warning
    }
}

/// `notifyArgv(platform, cfg, payload) !== null`, ported (`src/notify.ts:114-136`).
///
/// `os` is `std::env::consts::OS` spelling (`"macos"` / `"linux"` / `"windows"`), mapped onto the
/// engine's `darwin` / `linux` / `win32` branches. The custom-command arm reduces exactly: with the
/// engine's always-non-empty payload (`NOTIFY_TITLE` is a constant, the body a template, the path
/// a state-dir path), a substituted first element is empty only when the configured element is the
/// empty string — so the port needs no payload at all, which is the reason `notifyArgv` was made
/// pure in the first place. The known Linux residual (`"auto"` resolves to `notify-send` whether
/// or not it is installed) is the ENGINE's stated contract (§4), ported as-is rather than
/// second-guessed with a PATH lookup this predicate must not do.
pub fn engine_will_notify(os: &str, notify: Option<&Value>) -> bool {
    match classify_notify(notify) {
        "off" | "invalid" => false,
        "custom" => notify
            .and_then(|v| v.get("command"))
            .and_then(Value::as_array)
            .and_then(|c| c.first())
            .and_then(Value::as_str)
            .is_some_and(|first| !first.is_empty()),
        "auto" => os == "macos" || os == "linux",
        _ => unreachable!("classify_notify is total"),
    }
}

/// Why the engine's config could not be read here — the distinction `notify_status` reports.
/// Classified from the READ ERROR itself, never from a post-hoc `exists()` (racy, and a
/// permission error would read as "no config").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigUnreadable {
    /// `ENOENT` at open time — no file (including a dangling symlink, which the engine's own
    /// read also fails on and treats as no-config).
    Absent,
    /// Present but not usable here: an I/O error, not a regular file, over the cap, not UTF-8.
    Unreadable,
}

/// Read the ENGINE's config file the way the ENGINE reads it: **following symlinks**.
///
/// ⚠ DELIBERATELY NOT [`read_text_capped`]'s no-follow read, and the difference is the point. The
/// engine loads this file with `Bun.file(configPath()).json()` (`src/config.ts`, `loadConfig`),
/// which follows links — and a stow/chezmoi-managed `~/.config/daily-briefing/config.json` IS a
/// symlink in ordinary use. The ownership predicate exists to MIRROR the engine's resolution;
/// refusing the link here read "off" where the engine read `"auto"`, so the app posted a second
/// DELIVERED banner beside the engine's (fail-open double-notify — deviation 118). The no-follow
/// discipline stays right for the BRIEFING reads it was built for: those paths live in the
/// engine-written state dir and their content is rendered, whereas this read only mirrors a
/// config the user already controls — following the user's own link grants nothing they did not
/// already have. `O_NONBLOCK` is kept so a FIFO at the path cannot hang the fire path; the
/// [`crate::config_save::MAX_CONFIG_BYTES`] cap is kept (over-cap reads as unreadable — the same
/// deviation registers that residual).
pub fn read_engine_config_text(path: &Path) -> Result<String, ConfigUnreadable> {
    use std::io::Read;
    #[cfg(unix)]
    let opened = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)
    };
    #[cfg(not(unix))]
    let opened = std::fs::File::open(path);
    let file = opened.map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ConfigUnreadable::Absent,
        _ => ConfigUnreadable::Unreadable,
    })?;
    let meta = file.metadata().map_err(|_| ConfigUnreadable::Unreadable)?;
    if !meta.is_file() {
        return Err(ConfigUnreadable::Unreadable);
    }
    let cap = crate::config_save::MAX_CONFIG_BYTES;
    let mut buf = Vec::new();
    file.take(cap + 1)
        .read_to_end(&mut buf)
        .map_err(|_| ConfigUnreadable::Unreadable)?;
    if buf.len() as u64 > cap {
        return Err(ConfigUnreadable::Unreadable);
    }
    String::from_utf8(buf).map_err(|_| ConfigUnreadable::Unreadable)
}

/// The `notify` value of the config at `config_path`, or `None` when there is no file, it is not
/// JSON, or it has no such key — all of which the engine treats as "off". Read errors degrade to
/// `None` for the same reason a malformed `notify` degrades to silence in the engine: the
/// suppression decision must never be the thing that fails. The read follows symlinks
/// ([`read_engine_config_text`] — the engine-mirroring read, deviation 118).
pub fn read_notify_value(config_path: Option<&str>) -> Option<Value> {
    let path = config_path.filter(|p| !p.is_empty())?;
    let text = read_engine_config_text(Path::new(path)).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    parsed.get("notify").cloned()
}

/* ── the facts a snapshot carries, and the transition machine ─────────────────────────────────── */

/// What one snapshot says that the notification decision reads. Extracted by [`facts_of`], pure
/// from there on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    /// Whether the snapshot carried a STRUCTURALLY REAL `status --json` payload: one that parses
    /// AND reports `paths.stateDir`, which the engine emits unconditionally (`src/json.ts`'s
    /// `statusReport` returns `paths: statePaths()` on every path). A snapshot without one —
    /// [`Snapshot::unavailable`] (a failed retry attempt, which `shell::start_watcher_with`
    /// deliberately announces), or JSON that merely happens to parse into the all-`default`
    /// `StatusView` shape (`{}` does — round 2's second content-free primer) — says nothing about
    /// the world; [`Observation::observe`] must never use it as the absorption baseline (see the
    /// machine's docs — the content-free-primer hole).
    pub has_status: bool,
    /// `briefing-latest.md`'s mtime as `status --json` reports it, delivered or not — the baseline
    /// side of the "briefing changed" half of the DELIVERED rule.
    pub briefing_mtime: Option<String>,
    /// The RAW `status.lastRunDate`, whatever the derived phase says — what the PRIMING branch
    /// absorbs as the DELIVERED dedupe key. [`Facts::delivered_date`] is this same field gated by
    /// `Phase::Delivered`, and the gate is exactly what round 2 measured being shadowed
    /// (`derive_phase` decides `NotScheduled`/`SchedulerBroken`/`ConfigError` first — deviation
    /// 121), so absorption must read the raw field or a shadowed-phase primer absorbs nothing.
    pub last_run_date: Option<String>,
    /// Today's delivery, when the derived phase says so: the run DATE (`status.lastRunDate`) —
    /// the dedupe key the plan names. The FIRING side keeps this phase-gated form on purpose
    /// (deviation 121: a delivery under a scheduler-trouble phase does not notify).
    pub delivered_date: Option<String>,
    /// Today's NOTIFIABLE skip: class, the skip's local date (the dedupe key), the engine's
    /// `detail` line and its raw reason. `Phase::Skipped` has already filtered other days' records
    /// and the noise reasons (which are all in the silence set anyway).
    pub skip: Option<SkipFact>,
    /// The RAW `last-skip` record's dedupe key — (class, localDate) for a notifiable reason —
    /// independent of the derived phase, for the same priming reason as
    /// [`Facts::last_run_date`]: `Phase::Skipped` is shadowed by the same scheduler-trouble
    /// phases, so a primer must absorb the record the payload actually carries. Any date is
    /// absorbed as-is: an old record's key can never block a new day's firing (the dedupe is per
    /// date), and today's key is exactly the stale banner this exists to swallow.
    pub raw_skip_key: Option<(NotifyClass, String)>,
    /// `paths.configPath` / `paths.latestBriefingPath`, for the ownership predicate and the
    /// DELIVERED body.
    pub config_path: Option<String>,
    pub briefing_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkipFact {
    pub class: NotifyClass,
    /// The skip's LOCAL date (`last-skip.json`'s `localDate`).
    pub date: String,
    pub detail: Option<String>,
    pub reason: String,
}

/// Read the facts out of a watcher snapshot. Total: a snapshot with no state or no status yields
/// the empty facts, which the machine treats as "nothing to say".
pub fn facts_of(snapshot: &Snapshot) -> Facts {
    let status: Option<StatusView> = snapshot
        .status
        .as_ref()
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let mut facts = Facts::default();
    if let Some(status) = &status {
        // Structurally real, not merely parseable: every `StatusView` field is `#[serde(default)]`
        // (frozen-envelope robustness), so `{}` parses too — and primed the machine with an empty
        // ledger in round 2. `paths.stateDir` is the discriminator because the engine emits it
        // unconditionally (`json.ts`: `paths: statePaths()`); a payload without it was not
        // produced by any version of `status --json` and must not serve as a baseline.
        facts.has_status = status
            .paths
            .state_dir
            .as_deref()
            .is_some_and(|p| !p.is_empty());
        facts.briefing_mtime = status.latest_briefing_mtime.clone();
        facts.last_run_date = status.last_run_date.clone();
        facts.config_path = status.paths.config_path.clone();
        facts.briefing_path = status.paths.latest_briefing_path.clone();
    }
    // The RAW skip key, independent of the derived phase (the priming branch's evidence — see the
    // field docs). The watcher copies `last_skip` straight off the status payload.
    if let Some(skip) = &snapshot.last_skip {
        if !skip.local_date.is_empty() {
            if let Some(class) = skip_notify_class(&SkipReason::parse(&skip.reason)) {
                facts.raw_skip_key = Some((class, skip.local_date.clone()));
            }
        }
    }
    let Some(state) = &snapshot.schedule_state else {
        return facts;
    };
    match &state.phase {
        Phase::Delivered { .. } => {
            facts.delivered_date = status.and_then(|s| s.last_run_date);
        }
        Phase::Skipped { reason, detail, .. } => {
            if let Some(class) = skip_notify_class(reason) {
                // `Phase::Skipped` is derived from TODAY's record, so the record is present and
                // its `localDate` is the skip's day; a snapshot that somehow lacks it has no
                // honest dedupe key, and silence beats a key invented here.
                if let Some(skip) = &snapshot.last_skip {
                    if !skip.local_date.is_empty() {
                        facts.skip = Some(SkipFact {
                            class,
                            date: skip.local_date.clone(),
                            detail: detail.clone(),
                            reason: reason.as_str().to_string(),
                        });
                    }
                }
            }
        }
        _ => {}
    }
    facts
}

/// One decision to notify. What the machine emits and the gates then admit or suppress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Firing {
    Delivered {
        date: String,
    },
    Skip {
        class: NotifyClass,
        date: String,
        detail: Option<String>,
        reason: String,
    },
}

impl Firing {
    pub fn class(&self) -> NotifyClass {
        match self {
            Firing::Delivered { .. } => NotifyClass::Delivered,
            Firing::Skip { class, .. } => *class,
        }
    }

    pub fn date(&self) -> &str {
        match self {
            Firing::Delivered { date } => date,
            Firing::Skip { date, .. } => date,
        }
    }
}

/// The transition machine. **Pure**: no clock, no I/O — snapshots in, firings out.
///
/// ⚠ THE FIRST OBSERVATION IS ABSORBED, NEVER FIRED. At app start the world is already in some
/// state; a briefing delivered before launch, or a failure recorded an hour ago, is not something
/// the app OBSERVED happen. The plan's rule is written as an observation ("fire when it observes
/// BOTH…"), and absorption is what makes it one.
///
/// ⚠ ONLY A STRUCTURALLY REAL STATUS PAYLOAD CAN PRIME, AND PRIMING ABSORBS THE RAW EVIDENCE.
/// `shell::start_watcher_with` deliberately announces every failing retry attempt, and a failed
/// `status --json` read is `Snapshot::unavailable` — whose facts are EMPTY, not a statement that
/// nothing was delivered. Priming from one would make the next good snapshot look like a fresh
/// delivery of a briefing that predates the app (baseline `None`, no fired dates — both fire
/// conditions satisfied by a morning that already happened), and the stale FAILED banner is the
/// same hole. Round 2 measured that `status == None` was NOT the unique unsafe primer, so the
/// rule has two halves:
///
///   * **What may prime**: a payload that parses AND reports `paths.stateDir`
///     ([`Facts::has_status`]). Every `StatusView` field is defaulted, so `{}` parses too and
///     carries nothing — it must wait like `Snapshot::unavailable` does.
///   * **What priming records**: the RAW fields, not the phase-derived views. A well-formed
///     payload can report `latestBriefingMtime: null` (the engine derives it as
///     `stat(...).catch(() => null)` — `src/json.ts` — so a deleted `briefing-latest.md` or a
///     transient stat failure is `null` inside a valid payload), and scheduler trouble shadows
///     the phase (`NotScheduled`/`SchedulerBroken`/`ConfigError` precede `Delivered` and
///     `Skipped` in `derive_phase` — deviation 121), which left `delivered_date`/`skip` empty at
///     prime time and the round-1 HIGH's symptom reachable through a status-bearing snapshot.
///     So absorption inserts `fired[Delivered]` from [`Facts::last_run_date`] (raw
///     `status.lastRunDate`) and the skip key from [`Facts::raw_skip_key`] (the raw `last-skip`
///     record), whatever the derived phase says.
///
/// Absorbing the primer's own `lastRunDate` is correct even for a delivery that lands BETWEEN
/// the primer and the next snapshot on the same date: if `last-run` already said today at prime
/// time, that delivery predates or coincides with the primer — the machine notifies deliveries
/// it OBSERVES happen, not mornings it walks in on (a same-day `--force` regenerate is the same
/// date and is the dedupe rule's own case). The residual this leaves, stated honestly: a
/// structurally real payload whose OTHER reads all transiently failed (`lastRunDate: null`,
/// mtime `null` — indistinguishable from a fresh install) primes with an empty ledger, and a
/// delivered snapshot after it fires. That direction is kept deliberately: treating a real
/// payload's `null`s as suspect would silence the genuine fresh-install first delivery, which
/// IS an observed transition.
///
/// ⚠ THE DEDUPE KEY IS THE DATE, PER CLASS. A watcher double-fire, five rapid events, a re-derive,
/// a `--force` regenerate later the same day — all map to a (class, date) the map already holds
/// and stay silent. In-memory only, deliberately: across a restart the first snapshot is absorbed,
/// which covers the same ground without a file.
///
/// ⚠ THE BRIEFING BASELINE MOVES ONLY AT ABSORPTION AND AT A DELIVERED FIRING. The engine's stamp
/// and its briefing write can land in TWO batches (>1 s apart — `watcher.rs`'s measured rates), so
/// the mtime seen at the flip equals the PREVIOUS batch's; a baseline that tracked every snapshot
/// would erase the change before the flip arrived and the delivery would never fire. The one case
/// absorption knowingly costs: an app started BETWEEN the briefing write and the stamp absorbs the
/// new mtime and stays silent for that delivery — the letter of "observed BOTH halves".
#[derive(Debug, Default)]
pub struct Observation {
    primed: bool,
    baseline_mtime: Option<String>,
    /// The last date each class fired (or was absorbed) for.
    fired: BTreeMap<NotifyClass, String>,
}

impl Observation {
    pub fn observe(&mut self, facts: &Facts) -> Vec<Firing> {
        if !self.primed {
            // A snapshot without a structurally real status payload carries no baseline and no
            // dedupe evidence — it must not prime (struct docs: the content-free-primer hole).
            // Wait for one that does.
            if !facts.has_status {
                return Vec::new();
            }
            self.primed = true;
            self.baseline_mtime = facts.briefing_mtime.clone();
            // The RAW evidence, not the phase-derived views: `delivered_date` and `skip` are
            // empty whenever scheduler trouble shadows the phase (struct docs, deviation 121),
            // and priming from them let the next good snapshot fire a morning that predates the
            // app — round 2's MED.
            if let Some(date) = &facts.last_run_date {
                self.fired.insert(NotifyClass::Delivered, date.clone());
            }
            if let Some((class, date)) = &facts.raw_skip_key {
                self.fired.insert(*class, date.clone());
            }
            return Vec::new();
        }
        let mut out = Vec::new();
        if let Some(date) = &facts.delivered_date {
            let briefing_changed =
                facts.briefing_mtime.is_some() && facts.briefing_mtime != self.baseline_mtime;
            let new_date = self.fired.get(&NotifyClass::Delivered) != Some(date);
            if new_date && briefing_changed {
                self.fired.insert(NotifyClass::Delivered, date.clone());
                self.baseline_mtime = facts.briefing_mtime.clone();
                out.push(Firing::Delivered { date: date.clone() });
            }
        }
        if let Some(skip) = &facts.skip {
            if self.fired.get(&skip.class) != Some(&skip.date) {
                self.fired.insert(skip.class, skip.date.clone());
                out.push(Firing::Skip {
                    class: skip.class,
                    date: skip.date.clone(),
                    detail: skip.detail.clone(),
                    reason: skip.reason.clone(),
                });
            }
        }
        out
    }
}

/* ── what gets posted ─────────────────────────────────────────────────────────────────────────── */

/// One notification, fully built: what a sink posts and a test asserts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub class: NotifyClass,
    pub title: String,
    pub body: String,
    /// The `app:navigate` target a click should reach ([`NotifyClass::route`]). Carried for the
    /// sink; the 2.4.0 desktop plugin delivers no click event (module header).
    pub route: &'static str,
}

/// Build the notification for a firing. `briefing` is `briefing-latest.md`'s text where the
/// DELIVERED body wants its first resume line; everything passes the §5 boundary
/// ([`notification_line`]).
pub fn build_notification(firing: &Firing, briefing: Option<&str>) -> Notification {
    match firing {
        Firing::Delivered { date } => {
            let date = notification_line(date);
            let body = briefing
                .and_then(first_resume_line)
                .unwrap_or_else(|| format!("Your briefing for {date} is ready."));
            Notification {
                class: NotifyClass::Delivered,
                title: format!("Daily briefing — {date}"),
                body,
                route: NotifyClass::Delivered.route(),
            }
        }
        Firing::Skip {
            class,
            date,
            detail,
            reason,
        } => {
            let date = notification_line(date);
            let title = match class {
                NotifyClass::Blocked => format!("Briefing blocked — {date}"),
                _ => format!("Briefing failed — {date}"),
            };
            let body = match detail.as_deref().map(notification_line) {
                Some(line) if !line.is_empty() => line,
                _ => match class {
                    NotifyClass::Blocked => "A repository could not be read, so no briefing was \
                                             generated. Open the Schedule screen to restore \
                                             folder access."
                        .to_string(),
                    _ => format!("The engine's run failed ({}).", notification_line(reason)),
                },
            };
            Notification {
                class: *class,
                title,
                body,
                route: class.route(),
            }
        }
    }
}

/* ── the sink, the record, and the suppression log ────────────────────────────────────────────── */

/// Where a notification goes. A trait so the suite records instead of posting: a real post from
/// the test runner is a banner on the developer's screen at best and, from an unsigned bundle,
/// the appendix's UNVERIFIED leg (`docs/gui-seam.md` §12c).
pub trait NotifySink: Send + Sync {
    fn post(&self, notification: &Notification) -> Result<(), String>;
}

/// The app's opt-in record — `<app_data_dir>/notify-state.json`.
///
/// `enabled` is three-valued on purpose: `None` is NEVER ASKED (the Settings/Schedule UI surfaces
/// the explained ask; nothing posts), `Some(false)` is asked-and-declined, `Some(true)` is the
/// opt-in. The same reasoning as `access.rs`'s record: app-owned, tiny, degrades to `Default`
/// (never asked) rather than refusing to answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotifyRecord {
    pub enabled: Option<bool>,
}

/// The record's file name, and its size cap (a single optional boolean; the cap is a bound, not a
/// budget).
pub const STORE_FILE: &str = "notify-state.json";
pub const MAX_RECORD_BYTES: u64 = 64 * 1024;

/// Read the record; missing/unreadable/malformed is `Default` (never asked). Same posture as
/// `access::read_record`, for the same reason.
///
/// ⚠ DELIBERATELY NOT `autostart::read_record`'s absent-vs-unusable split, and the difference is
/// the failure DIRECTION: this record's `Default` is "never asked", which fails toward SILENCE —
/// nothing posts and no OS prompt can appear — so degrading every read failure to it costs one
/// withheld banner at worst. The autostart record's `Default` pre-ticks the wizard's
/// "Start at login" (B7: it re-fired the default-ON one-shot), leading toward an ACTION that would
/// re-create a login item over a user's recorded OFF, which is why that module reads a
/// present-but-unusable file as the user's last known choice instead.
pub fn read_record(dir: &Path) -> NotifyRecord {
    match read_text_capped(&dir.join(STORE_FILE), MAX_RECORD_BYTES) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => NotifyRecord::default(),
    }
}

/// Write the record, temp-then-rename (the `access::write_record` shape — a truncate-then-write
/// crash would manufacture the malformed record whose degrade-to-`Default` silently forgets the
/// user's choice).
///
/// ⚠ THROUGH `autostart::replace_atomically` (Phase E final harden, known item 8), for the reason
/// `access::write_record` gives: the temp was a `File::create`, which follows a symlink planted at
/// its predictable name; it is now created `O_CREAT|O_EXCL` with an explicit mode, a clash left as
/// it was and the next name tried.
pub fn write_record(dir: &Path, record: &NotifyRecord) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(record)
        .map_err(|e| format!("the notification record could not be serialised: {e}"))?;
    crate::autostart::replace_atomically(&dir.join(STORE_FILE), text.as_bytes())
}

/// One firing that was decided and then NOT posted, and why — what `notify_status` shows so the
/// Settings/Schedule UI can say "a delivery was observed while notifications were off".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suppressed {
    pub class: &'static str,
    pub date: String,
    /// `"never-asked"` | `"disabled"` | `"engine-notifies"` | `"post-failed"`.
    ///
    /// ⚠ `post-failed` IS SINK-ONLY ON THE SHIPPED PLUGIN (deviation 120): 2.4.0's desktop
    /// `show()` spawns the post detached and DISCARDS the error, so [`post_via_plugin`] cannot
    /// return `Err` — an OS-refused post today leaves `notify_status` reporting enabled with an
    /// empty log. The arm is kept because the recording sink exercises the path and a future
    /// plugin version may return errors; it is not evidence the app can detect delivery failure.
    pub reason: &'static str,
}

/// How many suppressions are kept for the UI. A bound, newest last.
pub const MAX_SUPPRESSED: usize = 8;

/// T18's managed state: the transition machine, the sink, the suppression log, and the test
/// overrides (the same trio of reasons as `AccessState`'s — `app_data_dir()` on MockRuntime is
/// the developer's real one, and the default sink posts real banners).
#[derive(Default)]
pub struct NotifyState {
    observation: Mutex<Observation>,
    /// `None` = the shipped plugin path ([`post_via_plugin`], reachable only from the real app in
    /// `lib.rs`). Tests always inject a recorder.
    sink: Option<Arc<dyn NotifySink>>,
    store_dir: Option<PathBuf>,
    suppressed: Mutex<Vec<Suppressed>>,
}

impl NotifyState {
    /// **Test harness only** — a recording sink instead of the plugin.
    pub fn with_sink(mut self, sink: Arc<dyn NotifySink>) -> Self {
        self.sink = Some(sink);
        self
    }

    /// **Test harness only** — see the struct docs.
    pub fn with_store_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.store_dir = Some(dir.into());
        self
    }

    fn store_dir<R: Runtime>(&self, app: &AppHandle<R>) -> Result<PathBuf, String> {
        if let Some(dir) = &self.store_dir {
            return Ok(dir.clone());
        }
        app.path()
            .app_data_dir()
            .map_err(|e| format!("this app's data directory could not be resolved: {e}"))
    }

    fn note_suppressed(&self, entry: Suppressed) {
        if let Ok(mut log) = self.suppressed.lock() {
            log.push(entry);
            let len = log.len();
            if len > MAX_SUPPRESSED {
                log.drain(..len - MAX_SUPPRESSED);
            }
        }
    }

    pub fn suppressed(&self) -> Vec<Suppressed> {
        self.suppressed
            .lock()
            .map(|l| l.clone())
            .unwrap_or_default()
    }
}

/// The shipped post: `tauri-plugin-notification`'s builder. Reached only when no sink is
/// injected, i.e. only in `lib.rs`'s real app — the plugin must be REGISTERED there
/// (`NotificationExt` resolves managed plugin state).
///
/// ⚠ ON 2.4.0 THIS CANNOT FAIL, AND THAT IS A BLIND SPOT, NOT A GUARANTEE (deviation 120): the
/// desktop `show()` spawns notify-rust detached and discards its error (`src/desktop.rs`), so an
/// OS-refused post still returns `Ok` here. Delivery failure is undetectable on this plugin
/// version; the `Err` arm below serves a future plugin that reports one, and the tests' failing
/// sink is what exercises the `post-failed` path today.
fn post_via_plugin<R: Runtime>(app: &AppHandle<R>, n: &Notification) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&n.title)
        .body(&n.body)
        .show()
        .map_err(|e| e.to_string())
}

/* ── the decision, end to end ─────────────────────────────────────────────────────────────────── */

/// Feed one announced snapshot through the machine and the gates. Called by the shipping sink
/// (`shell::AppState::changed`) for every snapshot it announces; a no-op on an app that does not
/// manage [`NotifyState`] (every pre-B7 test fixture).
///
/// The gates, in order, for each firing:
///   1. **Opt-in** — [`NotifyRecord::enabled`] must be `Some(true)`; `None`/`Some(false)` record
///      `never-asked`/`disabled` and post nothing (module header: no OS prompt from a background
///      fire).
///   2. **Ownership, DELIVERED only** — [`engine_will_notify`] over the config's `notify` value:
///      when the ENGINE's config resolves to an actual emitter on this platform, the app's own
///      delivery banner would be the double the plan forbids, and `engine-notifies` is recorded
///      instead.
///   3. **Post**, through the injected sink or the plugin. A failed post is recorded
///      (`post-failed`) and never propagates: a notification must never be the reason anything
///      else fails — the engine's own posture (`src/notify.ts`), kept. ⚠ On the shipped 2.4.0
///      plugin the failure can never be OBSERVED ([`post_via_plugin`]'s docs; deviation 120) —
///      the arm is real only through an injected sink today.
pub fn on_snapshot<R: Runtime>(app: &AppHandle<R>, snapshot: &Snapshot) {
    let Some(state) = app.try_state::<NotifyState>() else {
        return;
    };
    let facts = facts_of(snapshot);
    let firings = match state.observation.lock() {
        Ok(mut observation) => observation.observe(&facts),
        Err(_) => return,
    };
    if firings.is_empty() {
        return;
    }
    let record = match state.store_dir(app) {
        Ok(dir) => read_record(&dir),
        // No store: the safe reading is "never asked", which posts nothing.
        Err(_) => NotifyRecord::default(),
    };
    for firing in firings {
        let class = firing.class();
        let date = firing.date().to_string();
        match record.enabled {
            Some(true) => {}
            Some(false) => {
                state.note_suppressed(Suppressed {
                    class: class.as_str(),
                    date,
                    reason: "disabled",
                });
                continue;
            }
            None => {
                state.note_suppressed(Suppressed {
                    class: class.as_str(),
                    date,
                    reason: "never-asked",
                });
                continue;
            }
        }
        if class == NotifyClass::Delivered {
            let value = read_notify_value(facts.config_path.as_deref());
            if engine_will_notify(std::env::consts::OS, value.as_ref()) {
                state.note_suppressed(Suppressed {
                    class: class.as_str(),
                    date,
                    reason: "engine-notifies",
                });
                continue;
            }
        }
        let briefing = if class == NotifyClass::Delivered {
            facts
                .briefing_path
                .as_deref()
                .and_then(|p| read_text_capped(Path::new(p), 1024 * 1024).ok())
        } else {
            None
        };
        let notification = build_notification(&firing, briefing.as_deref());
        let posted = match &state.sink {
            Some(sink) => sink.post(&notification),
            None => post_via_plugin(app, &notification),
        };
        if let Err(e) = posted {
            eprintln!("daily-briefing: a notification could not be posted ({e})");
            state.note_suppressed(Suppressed {
                class: class.as_str(),
                date,
                reason: "post-failed",
            });
        }
    }
}

/* ── the commands ─────────────────────────────────────────────────────────────────────────────── */

/// What the ENGINE's `notify` config resolves to, for the Settings/Schedule UI — computed HERE so
/// the predicate has exactly one implementation (a TypeScript copy is the drift §4 warns about).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineNotifyProbe {
    /// `"off"` | `"auto"` | `"custom"` | `"invalid"` | `"no-config"` | `"unreadable"`.
    pub value: &'static str,
    /// [`engine_will_notify`] on THIS platform — true means the app suppresses its own DELIVERED
    /// notification.
    pub will_notify: bool,
}

/// `notify_status`'s answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyStatus {
    /// The app's opt-in: `null` = never asked (the UI surfaces the explained ask).
    pub enabled: Option<bool>,
    pub engine: EngineNotifyProbe,
    pub suppressed: Vec<Suppressed>,
}

/// Why a notify command could not answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NotifyError {
    Engine { detail: String },
    Store { detail: String },
}

/// The Settings/Schedule UI's one read: the opt-in record, the ENGINE's resolved notify value
/// (one `status --json` spawn to locate the config, then a local read), and the suppression log.
/// Called on the Settings screen's mount and when the Schedule screen surfaces the ask — never on
/// a timer.
#[tauri::command]
pub async fn notify_status<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, crate::engine::Engine>,
    state: State<'_, NotifyState>,
) -> Result<NotifyStatus, NotifyError> {
    let dir = state
        .store_dir(&app)
        .map_err(|detail| NotifyError::Store { detail })?;
    let record = read_record(&dir);
    let engine_probe = match engine.client() {
        Err(e) => {
            return Err(NotifyError::Engine {
                detail: e.to_string(),
            })
        }
        Ok(client) => {
            match crate::briefing_files::engine_paths(client).await {
                Err(detail) => return Err(NotifyError::Engine { detail }),
                Ok(paths) => match paths.config_path.as_deref().filter(|p| !p.is_empty()) {
                    None => EngineNotifyProbe {
                        value: "no-config",
                        will_notify: false,
                    },
                    Some(path) => {
                        match read_engine_config_text(Path::new(path)) {
                            // Classified from the read error itself, never a post-hoc `exists()`
                            // (racy, and a permission error would read as "no config"). No file
                            // yet is an ordinary state; anything else unreadable is reported as
                            // such rather than guessed at.
                            Err(ConfigUnreadable::Absent) => EngineNotifyProbe {
                                value: "no-config",
                                will_notify: false,
                            },
                            Err(ConfigUnreadable::Unreadable) => EngineNotifyProbe {
                                value: "unreadable",
                                will_notify: false,
                            },
                            Ok(text) => match serde_json::from_str::<Value>(&text) {
                                Err(_) => EngineNotifyProbe {
                                    value: "unreadable",
                                    will_notify: false,
                                },
                                Ok(parsed) => {
                                    let value = parsed.get("notify");
                                    EngineNotifyProbe {
                                        value: classify_notify(value),
                                        will_notify: engine_will_notify(
                                            std::env::consts::OS,
                                            value,
                                        ),
                                    }
                                }
                            },
                        }
                    }
                },
            }
        }
    };
    Ok(NotifyStatus {
        enabled: record.enabled,
        engine: engine_probe,
        suppressed: state.suppressed(),
    })
}

/// The explained ask's answer — a USER GESTURE in the Settings/Schedule UI (and B8's wizard
/// step). Writes the opt-in record; posts nothing itself. The first actual post afterwards is
/// what triggers the OS's own registration/prompt, which is exactly the "requested with an
/// explanation, never on first fire" ordering: the explanation is on the screen the user just
/// acted on.
#[tauri::command]
pub async fn notify_set_enabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, NotifyState>,
    enabled: bool,
) -> Result<NotifyRecord, NotifyError> {
    let dir = state
        .store_dir(&app)
        .map_err(|detail| NotifyError::Store { detail })?;
    let record = NotifyRecord {
        enabled: Some(enabled),
    };
    write_record(&dir, &record).map_err(|detail| NotifyError::Store { detail })?;
    Ok(record)
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &["notify_status", "notify_set_enabled"];
