//! T14 — the schedule state machine. **ONE function**, and the app's only opinion about what the
//! engine's state means.
//!
//! ## Why this is a Rust PORT and not an import
//!
//! `src/schedule/status.ts:4`, verbatim: *"the desktop app cannot import this engine (15 of 26 src
//! modules use Bun.* APIs)"*. The app's whole view of scheduling is `status --json` plus
//! `schedule status --json` plus `<state>/last-skip.json` — three JSON envelopes — so the mapping
//! from those to "what do I tell the user" has to exist somewhere on this side of the seam. It
//! exists here, ONCE: [`derive`] is the only place that decides, the tray status line and the
//! Schedule screen both render its output (including [`ScheduleState::status_line`], the one
//! sentence both show), and neither recomputes any part of it.
//!
//! ## Pure, with one stated exception
//!
//! [`derive`] performs no file I/O and reads no clock. `now` is an operand ([`Now`]), produced by
//! [`now_local`] — deliberately outside `derive` so the table test can put the machine at any
//! instant. The ONE thing `derive` consults that is not an operand is the local zone, and only to
//! render the delivery clock time in [`ScheduleState::status_line`] ([`local_hhmm_from_iso`]);
//! `tests/shell.rs`'s `the_delivered_line_is_a_local_clock_time` pins that conversion in child
//! processes with a fixed `TZ`.
//!
//! [`next_boundary`] is the second pure function here: the next instant at which `derive`'s answer
//! can change with no file changing at all — the floor, the stale deadline, local midnight. The
//! watcher (`watcher.rs`) wakes at those instants, because a scheduler that has DIED writes
//! nothing, and a state that is only recomputed on file events would never say so. The third,
//! [`crosses_read_boundary`], says which of those wakes must READ the engine again rather than
//! re-derive: the ones where the engine's own answer turns too.
//!
//! ## What the state set is, and what happened to the appendix's five
//!
//! gui-tauri T14 enumerated five states (DELIVERED / WAITING-FOR-FLOOR / WAITING-FOR-WAKE /
//! SKIPPED-WITH-REASON / HEARTBEAT-STALE) and sourced the skip reason from `runs.jsonl` in app
//! mode or a `briefing.log` tail in delegated mode. Plan R1 **supersedes** that enumeration:
//! scheduling is delegated-only in 0.2.0, there is no `runs.jsonl` and no app-owned tick, and the
//! skip reason comes from `<state>/last-skip.json`, which is a closed vocabulary rather than a log
//! scrape. The re-derived set is [`Phase`].
//!
//! ## Three traps this file exists to not fall into
//!
//! 1. ⚠ **`last-skip.json` PRESENT IS THE STEADY STATE OF A HEALTHY DAY.** `src/main.ts:484-497`
//!    and `src/marker.ts:118-124`: the record is removed on delivery and recreated ~10 minutes
//!    later by the next tick hitting the once-per-day gate, with `reason: "already-ran"`, and every
//!    tick until midnight rewrites it. So it is absent for ~10 minutes and present for ~17 hours on
//!    a working machine. **Switch on `reason`, never on presence** — which is why
//!    [`SkipReason::is_noise`] exists and why `already-ran` cannot reach [`Phase::Skipped`].
//! 2. ⚠ **`ticksToday` is `null`, never `0`, when the heartbeat cannot be parsed**
//!    (`src/schedule/status.ts:28-41`). `0` is the value that reads as "launchd never fired", so a
//!    pre-2026-08-20 heartbeat line reported as `0` shows a healthy machine as a dead scheduler.
//!    [`Phase::UnknownTick`] is that case, and [`ScheduleState::ticks_today`] stays `None`.
//! 3. ⚠ **NEVER NAME A RESET TIME FOR A `limited` SKIP.** `src/main.ts:106-121`
//!    (`limitedSkipMessage`) names one only when `limited.isProbe === false` AND `limited.until` is
//!    present, because a probe deadline is a one-hour guess. This module mirrors that discipline by
//!    CONSTRUCTION rather than by re-implementing it: the only text a `limited` phase carries is
//!    the engine's own `detail` string, which already made that decision. There is no field here a
//!    reset time could be invented into. See [`Phase::Skipped`].

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/* ── the closed skip vocabulary ───────────────────────────────────────────────────────────────── */

/// `src/json.ts`'s `SKIP_REASONS`, ported literal for literal.
///
/// ⚠ PINNED AGAINST THE ENGINE AT TEST TIME, not trusted to stay in step by convention:
/// `tests/schedule_state.rs`'s `the_skip_vocabulary_matches_the_engine` parses EVERY quoted token
/// inside the array literal in `src/json.ts` and compares the list to this slice, in order. The
/// engine's own docstring calls the set "CLOSED ON PURPOSE … a GUI switches on it to decide what to
/// tell the user — so a free-text reason invented at one return site is a silent gap in that
/// switch". This is that switch.
pub const SKIP_REASONS: &[&str] = &[
    "already-ran",
    "no-config",
    "config-error",
    "below-floor",
    "concurrent",
    "offline",
    "darkwake",
    "limited",
    "blocked",
    "provider-fail",
    "parse-empty",
    "marker-fail",
    "write-fail",
    "crashed",
];

/// One `SKIP_REASONS` member, or a typed [`SkipReason::Unknown`] carrying whatever the engine
/// actually wrote.
///
/// ⚠ THE `Unknown` ARM IS NOT DEFENSIVE PADDING. `schedule status --json` is frozen
/// ADDITIVE-ONLY (`docs/gui-seam.md` §2) and a future engine may add a reason before this app is
/// rebuilt; a `match` that panicked, or a parse that returned `Err`, would turn a new engine
/// diagnostic into a dead Schedule panel. The raw string is kept so the screen can still show the
/// engine's own `detail` line beside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    AlreadyRan,
    NoConfig,
    ConfigError,
    BelowFloor,
    Concurrent,
    Offline,
    Darkwake,
    Limited,
    Blocked,
    ProviderFail,
    ParseEmpty,
    MarkerFail,
    WriteFail,
    Crashed,
    Unknown(String),
}

impl SkipReason {
    /// Total: every string maps to a variant, and an unrecognised one keeps its bytes.
    pub fn parse(raw: &str) -> Self {
        match raw {
            "already-ran" => SkipReason::AlreadyRan,
            "no-config" => SkipReason::NoConfig,
            "config-error" => SkipReason::ConfigError,
            "below-floor" => SkipReason::BelowFloor,
            "concurrent" => SkipReason::Concurrent,
            "offline" => SkipReason::Offline,
            "darkwake" => SkipReason::Darkwake,
            "limited" => SkipReason::Limited,
            "blocked" => SkipReason::Blocked,
            "provider-fail" => SkipReason::ProviderFail,
            "parse-empty" => SkipReason::ParseEmpty,
            "marker-fail" => SkipReason::MarkerFail,
            "write-fail" => SkipReason::WriteFail,
            "crashed" => SkipReason::Crashed,
            other => SkipReason::Unknown(other.to_string()),
        }
    }

    /// The engine's own spelling. What the webview receives, and what a `match` in TypeScript keys
    /// on — so the two sides switch on the SAME token the engine wrote.
    pub fn as_str(&self) -> &str {
        match self {
            SkipReason::AlreadyRan => "already-ran",
            SkipReason::NoConfig => "no-config",
            SkipReason::ConfigError => "config-error",
            SkipReason::BelowFloor => "below-floor",
            SkipReason::Concurrent => "concurrent",
            SkipReason::Offline => "offline",
            SkipReason::Darkwake => "darkwake",
            SkipReason::Limited => "limited",
            SkipReason::Blocked => "blocked",
            SkipReason::ProviderFail => "provider-fail",
            SkipReason::ParseEmpty => "parse-empty",
            SkipReason::MarkerFail => "marker-fail",
            SkipReason::WriteFail => "write-fail",
            SkipReason::Crashed => "crashed",
            SkipReason::Unknown(raw) => raw,
        }
    }

    /// Whether this is a member of the closed vocabulary. `false` only for [`SkipReason::Unknown`].
    pub fn is_known(&self) -> bool {
        !matches!(self, SkipReason::Unknown(_))
    }

    /// Whether a skip with this reason is a NORMAL, non-diagnostic outcome that a higher-priority
    /// phase already explains, so it must not surface as [`Phase::Skipped`].
    ///
    /// ⚠ THIS IS TRAP 1 IN THE MODULE HEADER, AS A PREDICATE.
    ///
    ///   * `already-ran` — the steady state for ~17 hours of every successful day. Today's delivery
    ///     is [`Phase::Delivered`], decided one step earlier from the marker.
    ///   * `below-floor` — every pre-floor tick writes one. That is [`Phase::WaitingForFloor`],
    ///     which says the same thing with the floor in it.
    ///   * `no-config` — [`Phase::NotConfigured`], decided first.
    ///   * `config-error` — [`Phase::ConfigError`], decided from `status`'s own `configError`,
    ///     which is CURRENT rather than "as of the last tick", and carries the loader's message. A
    ///     `config-error` skip record while `configError` is null means the config was fixed since.
    pub fn is_noise(&self) -> bool {
        matches!(
            self,
            SkipReason::AlreadyRan
                | SkipReason::BelowFloor
                | SkipReason::NoConfig
                | SkipReason::ConfigError
        )
    }
}

impl Serialize for SkipReason {
    /// As the engine's literal string — NOT as serde's default externally-tagged enum shape, which
    /// would send `{"unknown":"whatever"}` for the one arm a consumer most needs to render plainly.
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/* ── the inputs, as the engine spells them ────────────────────────────────────────────────────── */

/// `<state>/last-skip.json`, as `src/marker.ts:129-134` defines it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LastSkip {
    /// The UTC instant of the skipping tick.
    pub iso: String,
    /// The LOCAL day it belonged to.
    pub local_date: String,
    /// One of [`SKIP_REASONS`], as a string — kept raw here and parsed by [`SkipReason::parse`].
    pub reason: String,
    /// Free text for a human, never parsed. For `limited` it is `limitedSkipMessage`'s line — preceded,
    /// when every provider is out of usage (the engine's `allOutOfUsage`), by a FIRST line from
    /// `outOfUsageLine`, the notification body. The engine's text is the ONLY place a reset time may come
    /// from (module header, trap 3).
    pub detail: Option<String>,
    /// The engine's `allOutOfUsage` (provider fallback, spec r9 §5, requirement 11): `true` on a
    /// `limited` skip where EVERY provider is out of usage (step 7 row 1), which is what makes that
    /// skip notify ([`crate::notifications::skip_notify_class`]). The engine writes it only when
    /// true, so an absent field — every older engine, every other skip — reads as `false`.
    pub all_out_of_usage: bool,
}

/// The `lastTick` object on both envelopes: `<iso> local=<YYYY-MM-DD> today=<n>`, already parsed by
/// the engine (`src/json.ts`, `parseTickLine`). `null` there means the line did not parse — which
/// is NOT the same as "no ticks", hence `lastTickState` on the schedule envelope.
///
/// ⚠ `count` IS A `u64`: the engine's regex is `today=(\d+)`, and a `u32` here turned a count of
/// 2^32 into a parse failure of the WHOLE `status` envelope — i.e. no state at all.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TickLine {
    pub iso: String,
    pub local_date: String,
    pub count: u64,
}

/// `status --json`'s `morningTime`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MorningTime {
    /// `HH:MM` as CONFIGURED, or the engine's default. ⚠ When `warning` is set this is the invalid
    /// string the user wrote, not the floor in force — see [`display_floor`].
    pub value: String,
    /// Minutes since local midnight: the floor the engine actually USES (`parseFloor` falls back
    /// to the default for an invalid value).
    pub minutes: u32,
    pub warning: Option<String>,
}

impl Default for MorningTime {
    /// ⚠ A DEFAULT THAT IS NEVER A SILENT GUESS. `serde(default)` needs one for a malformed
    /// envelope; `07:20` / `440` is the engine's own `DEFAULT_MORNING_TIME`, so a degraded parse
    /// shows the same floor the engine would use rather than midnight — which would make every
    /// state read as "past the floor".
    fn default() -> Self {
        Self {
            value: "07:20".to_string(),
            minutes: 440,
            warning: None,
        }
    }
}

/// The subset of `status --json` this machine reads.
///
/// ⚠ EVERY FIELD IS `default`ED AND UNKNOWN FIELDS ARE IGNORED, on purpose: the envelope is frozen
/// additive-only, so a newer engine's extra keys must parse, and a malformed one must degrade to a
/// state rather than to an error. "No panic on garbage JSON" is a requirement, not an aspiration.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatusView {
    pub engine_version: Option<String>,
    pub config_exists: bool,
    /// A STRING when the config file exists but could not be loaded. `null` when it loaded, and
    /// also `null` when there is no config at all — which is why `configExists` is checked first.
    pub config_error: Option<String>,
    pub last_run_date: Option<String>,
    pub last_skip: Option<LastSkip>,
    pub last_tick: Option<TickLine>,
    /// `briefing-latest.md`'s mtime, ISO-8601 — the delivery TIME [`Phase::Delivered`] shows.
    pub latest_briefing_mtime: Option<String>,
    /// The summary record bound to the latest page: its identity, revision and state. The engine
    /// omits it while summaries are off or no record exists.
    ///
    /// ⚠ READ LENIENTLY ([`lenient_latest_summary_revision`]), like `providers` below, and so is
    /// [`Self::ai_summary_status`]: the container's `default` covers a MISSING member only, and a
    /// wrong-typed one would otherwise fail the whole envelope's parse.
    #[serde(deserialize_with = "lenient_latest_summary_revision")]
    pub latest_summary_revision: Option<LatestSummaryRevision>,
    /// The resolved `aiSummary` switch and its fixed warning codes. Absent reads as off.
    #[serde(deserialize_with = "lenient_ai_summary_status")]
    pub ai_summary_status: AiSummaryStatus,
    pub morning_time: MorningTime,
    pub paths: StatePaths,
    /// `status --json`'s `providers` (provider fallback P1-M10-T1): one row per combined-list entry
    /// and per DROPPED entry, in list order. Only each row's `kind` is read, to count the VALID
    /// entries ([`StatusView::valid_provider_entries`]) for the older-background-engine warning — the
    /// engine resolved the list; this app counts its answer and never resolves it a second time.
    ///
    /// ⚠ READ LENIENTLY ([`lenient_provider_rows`]): a `providers` that is not an array reads as no
    /// rows, rather than failing the WHOLE envelope's parse — which would blank the Schedule screen
    /// over a field only one warning reads. An older engine sends none: no rows.
    #[serde(deserialize_with = "lenient_provider_rows")]
    pub providers: Vec<ProviderRow>,
}

impl StatusView {
    /// The number of VALID combined-list entries the engine reported. ⚠ A dropped row (`kind:
    /// "invalid"`) does NOT count (plan Q18): one valid entry plus a dropped one behaves
    /// single-entry on old and new engines alike, so it is no reason to warn. A row with no `kind`
    /// is not evidence of an entry either.
    pub fn valid_provider_entries(&self) -> usize {
        self.providers
            .iter()
            .filter(|row| row.kind.as_deref().is_some_and(|kind| kind != "invalid"))
            .count()
    }
}

/// One `status --json` `providers` row, reduced to the one field this app reads. `kind` is the
/// entry's provider kind for a resolved entry and `"invalid"` for a dropped one (`src/json.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderRow {
    pub kind: Option<String>,
}

/// `providers`, never an error: an array's elements are read for a string `kind` (anything else is
/// a row with none); any other value is no rows.
fn lenient_provider_rows<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<ProviderRow>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(match value {
        serde_json::Value::Array(rows) => rows
            .iter()
            .map(|row| ProviderRow {
                kind: row
                    .get("kind")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            })
            .collect(),
        _ => Vec::new(),
    })
}

/// A stored summary record's state (`src/summary/store.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SummaryState {
    Pending,
    Ready,
    Unavailable,
}

/// Every fixed summary diagnostic. Codes only: the GUI maps them to text, so nothing a model, a
/// provider or a config wrote can reach a screen through this list. `SummaryConfigInvalid` comes
/// from the config resolver and appears in status only, never in a stored record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SummaryWarningCode {
    SummaryUnavailable,
    SummaryTextOmitted,
    SummaryUsageLimit,
    SummaryConfigInvalid,
}

/// `status --json`'s `latestSummaryRevision`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestSummaryRevision {
    pub page_hash: String,
    pub page_version: String,
    pub revision: u8,
    pub state: SummaryState,
}

/// `status --json`'s `aiSummaryStatus`. Bounded by construction: deduplicated fixed codes.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSummaryStatus {
    pub enabled: bool,
    pub warnings: Vec<SummaryWarningCode>,
}

/// Exactly 64 lowercase hex digits: a `pageHash` or `pageVersion`, never a path.
pub fn is_page_identity(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `latestSummaryRevision`, never an error: anything but a whole, consistent value reads as absent.
fn lenient_latest_summary_revision<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<LatestSummaryRevision>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    let identity = |name: &str| {
        value
            .get(name)
            .and_then(serde_json::Value::as_str)
            .filter(|text| is_page_identity(text))
            .map(str::to_string)
    };
    let state = value
        .get("state")
        .cloned()
        .and_then(|state| serde_json::from_value(state).ok());
    let revision = value.get("revision").and_then(serde_json::Value::as_u64);
    Ok(
        match (
            identity("pageHash"),
            identity("pageVersion"),
            state,
            revision,
        ) {
            (Some(page_hash), Some(page_version), Some(state), Some(revision))
                if revision == u64::from(state != SummaryState::Pending) =>
            {
                Some(LatestSummaryRevision {
                    page_hash,
                    page_version,
                    revision: u8::from(state != SummaryState::Pending),
                    state,
                })
            }
            _ => None,
        },
    )
}

/// `aiSummaryStatus`, never an error: anything but `{enabled: boolean, warnings: array}` reads as
/// off with no warnings. An unknown code in the array is dropped, and a repeat kept once.
fn lenient_ai_summary_status<'de, D: Deserializer<'de>>(d: D) -> Result<AiSummaryStatus, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    let enabled = value.get("enabled").and_then(serde_json::Value::as_bool);
    let rows = value.get("warnings").and_then(serde_json::Value::as_array);
    let (Some(enabled), Some(rows)) = (enabled, rows) else {
        return Ok(AiSummaryStatus::default());
    };
    let mut warnings = Vec::new();
    for code in rows
        .iter()
        .filter_map(|row| serde_json::from_value(row.clone()).ok())
    {
        if !warnings.contains(&code) {
            warnings.push(code);
        }
    }
    Ok(AiSummaryStatus { enabled, warnings })
}

/// The state-dir paths, straight from the engine. **Never recomputed app-side** — `src/json.ts`'s
/// `StatePaths` docstring is explicit that one implementation of `stateDirFor` is the whole point.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatePaths {
    pub state_dir: Option<String>,
    pub config_path: Option<String>,
    pub marker_path: Option<String>,
    pub tick_path: Option<String>,
    pub latest_briefing_path: Option<String>,
    pub briefings_dir: Option<String>,
    pub last_skip_path: Option<String>,
    pub schedule_path: Option<String>,
}

/// The subset of `schedule status --json` this machine reads (`src/schedule/status.ts:42-92`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScheduleView {
    pub engine_version: Option<String>,
    /// `null` when the platform has no scheduler or the probe could not run — NOT the same as
    /// `false`. `false` with a record present is [`Phase::SchedulerBroken`].
    pub registered: Option<bool>,
    pub record_present: bool,
    pub unit_present: bool,
    pub owner: Option<String>,
    pub invoker: Option<String>,
    pub unit_path: Option<String>,
    pub installed_at: Option<String>,
    /// The engine version recorded AT INSTALL TIME. Against `engineVersion` this is the skew the
    /// "update background engine" prompt keys on.
    pub installed_engine_version: Option<String>,
    /// `"absent"` | `"legacy"` | `"ok"`.
    pub last_tick_state: Option<String>,
    /// `null`, never `0`, when the heartbeat cannot be parsed (module header, trap 2).
    pub ticks_today: Option<u64>,
    pub ticks_expected_since_floor: Option<u64>,
    pub interval_sec: Option<u64>,
    pub experimental: bool,
    pub linger_state: Option<String>,
    pub last_skip: Option<LastSkip>,
    // ── Batch 2 (spec 3.1.5, 3.4.1). An older engine sends none of them, so each reads as "not
    // known" by `default`: `false`, `null`, `null`.
    /// The engine's `lstat` of `schedule.json`, readable or not — NOT [`Self::record_present`],
    /// which is a READABLE record (spec 3, "three record facts"). A malformed, symlinked or
    /// oversized record is `record_present: false` and `record_file_present: true`.
    pub record_file_present: bool,
    /// Why [`Self::registered`] is `null` (`"no-user-manager"`, `"no-gui-session"`, `"timeout"`,
    /// `"spawn"`, `"unexpected"`), and `null` whenever `registered` is not.
    pub registered_reason: Option<String>,
    /// The engine's manual removal steps for this machine's paths (spec 3.1.8), with no closing
    /// line; `null` off launchd and systemd (Windows and unsupported platforms).
    pub remove_steps: Option<String>,
    /// Provider fallback (P2-M5-T3, `docs/gui-seam.md` §2): the scheduled binary's version as it
    /// answers NOW (`<binPath> --version`, bounded) — `null` when there is no record, no absolute
    /// `binPath`, or the read failed. NOT [`Self::installed_engine_version`], the install-time
    /// record, which goes stale once the binary is replaced in place. An older engine sends none.
    pub scheduled_engine_version: Option<String>,
}

/* ── the older-background-engine warning (provider fallback spec §6, P3-M6-T2) ─────────────── */

/// The sentinel [`FIRST_SAME_RUN_SWITCHING_VERSION`] held until the v0.3.0 release step: "no released
/// version contains same-run switching yet — compare against this app's own version". So a build from
/// `main` before that release (app and engine both at the same version) never warned about its own engine.
///
/// ⚠ THE RELEASE STEP REPLACED IT (plan "Build conventions", spec §6): it set the constant to the
/// version being released, with previous release tag < constant ≤ that version.
/// `the_threshold_sentinel_is_replaced_before_any_release` (`tests/schedule_state.rs`) fails once
/// the crate version moves past [`SENTINEL_INTRODUCED_IN`] with the sentinel still here.
pub const UNSET_UNTIL_RELEASE: &str = "UNSET_UNTIL_RELEASE";

/// The first RELEASED engine version that contains provider fallback PR 1 (same-run switching, the
/// `fallbacks` reader) — or [`UNSET_UNTIL_RELEASE`].
///
/// Set by the v0.3.0 release step. Measured 2026-11-06: `gh release list -R norn-app/daily-briefing`
/// lists v0.2.0 as the latest release, and v0.2.0's tree has no `src/providerList.ts` (the contents
/// API answers 404), so v0.3.0 is the first release to contain PR 1 (#645, merged 2026-10-17).
pub const FIRST_SAME_RUN_SWITCHING_VERSION: &str = "0.3.0";

/// This crate's version when the sentinel landed — `gui/src-tauri/Cargo.toml`'s `[package]`
/// `version`, read at build time on 2026-10-18 (not assumed). Every release bumps the version past
/// it, which is what makes the guard test fire on a release that forgot the sentinel.
pub const SENTINEL_INTRODUCED_IN: &str = "0.2.1";

/// This app's own version — the other half of the lower-of rule.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Whether `version` is OLDER than `than`, by semver precedence (semver.org §11): numeric
/// major.minor.patch (`0.2.10` is newer than `0.2.9` — not today's string inequality), a
/// pre-release below its release, build metadata ignored. `None` when either side is not a bare
/// semver (the engine reads `scheduledEngineVersion` only when it is one, gui-seam §2).
pub fn version_older(version: &str, than: &str) -> Option<bool> {
    let (a, b) = (Semver::parse(version)?, Semver::parse(than)?);
    Some(a.cmp(&b) == std::cmp::Ordering::Less)
}

/// A parsed bare semver: `MAJOR.MINOR.PATCH[-PRE][+BUILD]`, the shape the engine's `VERSION_LINE`
/// accepts (`src/schedule/status.ts`). Its `Ord` is semver precedence; `BUILD` is dropped.
#[derive(Debug, PartialEq, Eq)]
struct Semver<'a> {
    core: [u64; 3],
    pre: Vec<&'a str>,
}

impl<'a> Semver<'a> {
    fn parse(text: &'a str) -> Option<Self> {
        let text = text.split_once('+').map_or(text, |(v, _build)| v);
        let (core_text, pre_text) = match text.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (text, None),
        };
        let mut core = [0u64; 3];
        let mut parts = core_text.split('.');
        for slot in &mut core {
            let part = parts.next()?;
            if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            *slot = part.parse().ok()?;
        }
        if parts.next().is_some() {
            return None;
        }
        let pre = match pre_text {
            None => Vec::new(),
            Some(pre) => {
                let ids: Vec<&str> = pre.split('.').collect();
                let well_formed = |id: &&str| {
                    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                };
                if !ids.iter().all(well_formed) {
                    return None;
                }
                ids
            }
        };
        Some(Self { core, pre })
    }
}

impl Ord for Semver<'_> {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        self.core.cmp(&other.core).then_with(|| {
            match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                // A pre-release sorts BELOW its release.
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => {
                    for (a, b) in self.pre.iter().zip(&other.pre) {
                        let numeric = |id: &str| -> Option<u64> {
                            if id.bytes().all(|b| b.is_ascii_digit()) {
                                id.parse().ok()
                            } else {
                                None
                            }
                        };
                        let order = match (numeric(a), numeric(b)) {
                            (Some(x), Some(y)) => x.cmp(&y),
                            // Numeric identifiers sort below alphanumeric ones.
                            (Some(_), None) => Ordering::Less,
                            (None, Some(_)) => Ordering::Greater,
                            (None, None) => a.cmp(b),
                        };
                        if order != Ordering::Equal {
                            return order;
                        }
                    }
                    self.pre.len().cmp(&other.pre.len())
                }
            }
        })
    }
}

impl PartialOrd for Semver<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// The older-background-engine warning, for BOTH owners (spec §6): the combined list has two or more
/// VALID entries, and the scheduled engine's MEASURED version is older than the LOWER of `threshold`
/// ([`FIRST_SAME_RUN_SWITCHING_VERSION`]) and `app_version`. The sentinel means "the app's own
/// version". An unknown or unreadable version is not evidence of age: no warning.
///
/// ⚠ NAMED LIMIT (spec §6): before the release, the bar is the app's own version, so a same-version
/// engine with and without same-run switching cannot be told apart; the guarantee holds for
/// released builds only.
pub fn older_engine_warning(
    valid_entries: usize,
    scheduled: Option<&str>,
    threshold: &str,
    app_version: &str,
) -> bool {
    if valid_entries < 2 {
        return false;
    }
    let Some(scheduled) = scheduled else {
        return false;
    };
    let bar = if threshold == UNSET_UNTIL_RELEASE {
        app_version
    } else {
        match version_older(threshold, app_version) {
            Some(true) => threshold,
            Some(false) => app_version,
            None => return false,
        }
    };
    version_older(scheduled, bar) == Some(true)
}

/// The release-step guard: `Err` while `threshold` is still the sentinel and `crate_version` has
/// moved past `introduced_in` (a release that forgot to set it), or when `threshold` is neither
/// the sentinel nor a bare semver (a typo would silently disable the warning).
pub fn sentinel_guard(
    threshold: &str,
    crate_version: &str,
    introduced_in: &str,
) -> Result<(), String> {
    if threshold != UNSET_UNTIL_RELEASE {
        return match Semver::parse(threshold) {
            Some(_) => Ok(()),
            None => Err(format!(
                "FIRST_SAME_RUN_SWITCHING_VERSION is {threshold:?}: neither {UNSET_UNTIL_RELEASE} \
                 nor a bare semver, so the older-engine warning could never fire"
            )),
        };
    }
    match version_older(introduced_in, crate_version) {
        Some(false) => Ok(()),
        Some(true) => Err(format!(
            "FIRST_SAME_RUN_SWITCHING_VERSION is still {UNSET_UNTIL_RELEASE}, but this crate is \
             {crate_version}, past {introduced_in} where the sentinel landed: the release step must \
             set it to the first released version containing provider fallback PR 1 (plan \
             \"Build conventions\"; spec §6)"
        )),
        None => Err(format!(
            "cannot compare the crate version {crate_version:?} with SENTINEL_INTRODUCED_IN \
             {introduced_in:?}: both must be bare semvers"
        )),
    }
}

/// The instant [`derive`] is evaluated at. An operand, so the machine reads no clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Now {
    /// `YYYY-MM-DD` in the LOCAL zone — the same unit `stampTick` and the marker key days by
    /// (`src/marker.ts:61-81`: the day-35 fix made the stored key and the compared key one string).
    /// Empty when no local conversion was available (see [`now_from_civil`]).
    pub local_date: String,
    /// Minutes since local midnight.
    pub minutes: u32,
    /// Seconds since the Unix epoch, for comparing against a tick's UTC instant.
    pub epoch_secs: i64,
}

/* ── the states ───────────────────────────────────────────────────────────────────────────────── */

/// Why a heartbeat cannot be judged. Carried by [`Phase::UnknownTick`] so the screen can say which.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TickProblem {
    /// The engine reported `lastTickState: "legacy"` — a pre-2026-08-20 line with no `local=`, or
    /// corruption. Its count is unknown.
    Legacy,
    /// The engine parsed the line, but its instant is not the `toISOString()` shape this app reads
    /// ([`parse_iso_utc`]), so its age cannot be computed.
    UnreadableInstant,
    /// The instant is more than [`FUTURE_TICK_SKEW_SECS`] AHEAD of this machine's clock — the
    /// clock was moved back, or the line was written under a different one. Its age is negative,
    /// and "the heartbeat is current" would be a claim this app cannot make.
    Future,
}

/// Exactly one of these comes out of [`derive`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
// ⚠ `rename_all_fields` AS WELL AS `rename_all`: on an enum, serde's container `rename_all`
// renames the VARIANTS only, so without the second attribute the fields inside a variant would
// reach the webview as `minutes_until_floor` while every other object in the payload is
// camelCase. `tests/schedule_state.rs`'s `the_wire_shape_is_camel_case_throughout` pins it.
#[serde(
    tag = "phase",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Phase {
    /// No config file at all. Nothing will ever deliver.
    NotConfigured,
    /// The config file exists and does not load (`status`'s `configError`). Nothing will deliver
    /// until it is fixed — but a briefing may ALREADY have been delivered today, and saying "not
    /// delivered" then would be false; `delivered_today` / `delivered_at` keep that fact visible.
    ConfigError {
        /// The loader's message, verbatim.
        detail: String,
        delivered_today: bool,
        /// `briefing-latest.md`'s mtime, when `delivered_today`.
        delivered_at: Option<String>,
    },
    /// No `<state>/schedule.json`. **Nothing will trigger a run** — loud, and fixable with one
    /// button. `docs/gui-seam.md` §3: the record is authoritative and the unit merely corroborates,
    /// so `recordPresent` is what this keys on; `unitPresent` and `registered` ride along on
    /// [`ScheduleState`] so the screen can say "a unit exists but nothing owns it".
    NotScheduled,
    /// A record exists, but its unit FILE is gone (`unitPresent: false`) or the OS does not have it
    /// loaded (`registered: false`) — the "somebody deleted my plist" case
    /// `src/schedule/status.ts:48-50` names. As loud as [`Phase::NotScheduled`], for the same
    /// reason: no briefing will arrive on its own. `registered: null` (the probe could not run) is
    /// NOT this — unknown is not broken.
    SchedulerBroken,
    /// `last-run` is today's local date. `at` is `briefing-latest.md`'s mtime.
    Delivered { at: Option<String> },
    /// Before the floor. ⚠ The floor SUPPRESSES early ticks; it is not a delivery time — see
    /// [`ScheduleState::first_wake`], which says so in one sentence with the number in it.
    WaitingForFloor {
        floor: String,
        minutes_until_floor: u32,
    },
    /// Past the floor, undelivered, and the heartbeat is current. ⚠ **INFORMATIONAL, NEVER AN
    /// ERROR** — this is the ordinary "the laptop was shut at 07:20" morning, and the appendix's
    /// stated risk for T14 is a GUI that renders it red and makes the tool feel broken every day.
    WaitingForWake,
    /// The last tick declined to deliver, and said why. One phase per [`SKIP_REASONS`] member that
    /// can reach it (`already-ran`, `below-floor`, `no-config` and `config-error` cannot — see
    /// [`SkipReason::is_noise`]), distinguished by `reason`.
    ///
    /// ⚠ `detail` IS THE ENGINE'S OWN LINE, VERBATIM, and it is the only prose here. For `limited`
    /// it is `limitedSkipMessage`'s output, which names a reset time only when the engine parsed
    /// one — so this app cannot name one it does not have (module header, trap 3).
    Skipped {
        reason: SkipReason,
        detail: Option<String>,
        /// The UTC instant of the skipping tick, when the record carried one.
        iso: Option<String>,
    },
    /// The heartbeat has not advanced in more than `stale_after_secs` (2× the installed interval),
    /// or there is no heartbeat at all and it is past the floor.
    ///
    /// ⚠ IT CANNOT TELL "the scheduler is dead" FROM "the machine was asleep". 0.2.0 has no power
    /// history (the appendix's SLEPT state needed Electron's `powerMonitor`), so the copy must
    /// carry both readings — see `Schedule.svelte`.
    AgentStale {
        last_tick: Option<String>,
        stale_after_secs: u64,
    },
    /// The heartbeat exists and cannot be judged — see [`TickProblem`] for the three ways.
    /// ⚠ **UNKNOWN, NOT ZERO** (module header, trap 2).
    UnknownTick { cause: TickProblem },
}

/// The whole verdict: the phase, plus every fact the tray line and the Schedule screen render
/// beside it. One object so the two surfaces cannot disagree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleState {
    pub phase: Phase,
    /// The one-line status. **The tray renders it verbatim and so does the Schedule screen's
    /// badge** — it is on the wire precisely so the webview does not keep a second mapping from
    /// phase (or skip token) to words.
    pub status_line: String,
    /// The floor IN FORCE, as `HH:MM` — from the engine's `morningTime.minutes`, which is what
    /// `parseFloor` actually uses. For an invalid configured value that is the default, and
    /// `floor_warning` carries the engine's note saying so.
    pub floor: String,
    /// The engine's own warning about a malformed `morningTime`, if any.
    pub floor_warning: Option<String>,
    /// The one sentence that explains first-wake semantics, with the floor in it.
    pub first_wake: String,
    /// `null`, never `0`, when the heartbeat could not be parsed.
    pub ticks_today: Option<u64>,
    pub ticks_expected_since_floor: Option<u64>,
    pub last_tick: Option<TickLine>,
    /// `"cli"` or `"app"` — who installed the trigger.
    pub owner: Option<String>,
    pub invoker: Option<String>,
    pub unit_path: Option<String>,
    pub registered: Option<bool>,
    pub record_present: bool,
    pub unit_present: bool,
    pub engine_version: Option<String>,
    pub installed_engine_version: Option<String>,
    /// The "update background engine" prompt: the schedule is APP-owned, and its recorded engine
    /// version differs from the current one. R1: a re-run of `schedule install --invoker app`
    /// PRESERVES the existing notify value and owner. ⚠ NEVER for a CLI-owned schedule — R1:
    /// "CLI-owned installs refresh via install.sh as today", and an app-invoked install over a CLI
    /// record is a take-over, not an update.
    pub engine_update_available: bool,
    /// The installed interval, or `null` when it is missing or outside
    /// `1..=`[`MAX_INTERVAL_SECS`] — an interval this app will not compute staleness from.
    pub interval_sec: Option<u64>,
    /// True where the platform's scheduling leg carries no runtime evidence (Windows today). A
    /// surface must label such a schedule experimental rather than presenting it as working.
    pub experimental: bool,
    /// Linux only; `"disabled"` means the timer silently never fires while logged out.
    pub linger_state: Option<String>,
    /// [`ScheduleView::record_file_present`]: anything at `schedule.json`, readable or not. The
    /// phase still keys on [`Self::record_present`]; the Schedule screen's remove control reads
    /// this too (spec 3.4.1). `false` when the schedule envelope is missing.
    pub record_file_present: bool,
    /// [`ScheduleView::registered_reason`]: why [`Self::registered`] is `null`, verbatim.
    pub registered_reason: Option<String>,
    /// [`ScheduleView::remove_steps`]: the engine's manual removal steps, verbatim; `null` off
    /// launchd and systemd, or when the schedule envelope is missing.
    pub remove_steps: Option<String>,
    /// [`ScheduleView::scheduled_engine_version`]: the MEASURED version of the scheduled binary,
    /// straight through. The older-engine warning reads this, never the install-time record.
    pub scheduled_engine_version: Option<String>,
    /// The older-background-engine warning (spec §6): the combined list has two or more VALID
    /// entries and the scheduled engine is older than the first engine with same-run switching
    /// ([`older_engine_warning`]). ⚠ FOR BOTH OWNERS — unlike [`Self::engine_update_available`] —
    /// but the remedy differs: a CLI-owned schedule is updated the way it was installed, never
    /// through this app's install (which would be a take-over).
    pub older_engine_warning: bool,
}

impl ScheduleState {
    /// The tray's status line. The same string as [`ScheduleState::status_line`], which the screen
    /// renders — kept as a method so `shell.rs` reads as "the tray renders the state".
    pub fn tray_line(&self) -> String {
        self.status_line.clone()
    }
}

/// The one-line status for a phase. **Pure apart from the local zone** (the delivery clock time).
fn status_line(phase: &Phase, floor: &str) -> String {
    match phase {
        Phase::NotConfigured => "Not set up yet".to_string(),
        Phase::ConfigError {
            delivered_today,
            delivered_at,
            ..
        } => {
            if *delivered_today {
                format!("{} · config has an error", delivered_line(delivered_at))
            } else {
                "Config has an error".to_string()
            }
        }
        Phase::NotScheduled => "Scheduler not installed".to_string(),
        Phase::SchedulerBroken => "Scheduler not loaded".to_string(),
        Phase::Delivered { at } => delivered_line(at),
        Phase::WaitingForFloor { floor, .. } => format!("Waiting — first wake past {floor}"),
        Phase::WaitingForWake => format!("Waiting — first wake past {floor}"),
        Phase::Skipped { reason, .. } => match reason {
            SkipReason::Offline => "Offline".to_string(),
            SkipReason::Darkwake => "Waiting for a real wake".to_string(),
            SkipReason::Limited => "Provider limit reached".to_string(),
            SkipReason::Blocked => {
                "Blocked — a folder or repo could not be read or found".to_string()
            }
            SkipReason::Concurrent => "A run is already in progress".to_string(),
            SkipReason::ProviderFail => "The provider failed".to_string(),
            SkipReason::ParseEmpty => "The briefing came back empty".to_string(),
            SkipReason::MarkerFail => "Delivered, but the day marker failed".to_string(),
            SkipReason::WriteFail => "The briefing could not be saved".to_string(),
            SkipReason::Crashed => "The last run crashed".to_string(),
            // `is_noise` keeps these four out of `Phase::Skipped`; the arms exist because the match
            // is exhaustive and a `_` would hide a future reason behind a wrong line.
            SkipReason::ConfigError => "Config has an error".to_string(),
            SkipReason::AlreadyRan | SkipReason::BelowFloor | SkipReason::NoConfig => {
                "Not delivered today".to_string()
            }
            SkipReason::Unknown(raw) => format!("Skipped — {raw}"),
        },
        Phase::AgentStale { .. } => "Scheduler has not checked in".to_string(),
        Phase::UnknownTick { cause } => match cause {
            TickProblem::Legacy | TickProblem::UnreadableInstant => {
                "Heartbeat unreadable".to_string()
            }
            TickProblem::Future => "Heartbeat is dated in the future".to_string(),
        },
    }
}

/// "Delivered 07:24" in the LOCAL zone, or "Delivered today" when the time is unknown.
fn delivered_line(at: &Option<String>) -> String {
    match at.as_deref().and_then(local_hhmm_from_iso) {
        Some(hhmm) => format!("Delivered {hhmm}"),
        None => "Delivered today".to_string(),
    }
}

/* ── the machine ──────────────────────────────────────────────────────────────────────────────── */

/// How many multiples of the installed interval a heartbeat may fall behind before it reads as
/// stale. The appendix's own number ("last tick older than 2× the interval"); with the installed
/// `StartInterval 600` that is 20 minutes. Stale means STRICTLY more than this.
pub const STALE_INTERVAL_MULTIPLE: u64 = 2;

/// The largest interval this app computes staleness from. The engine installs 600
/// (`DEFAULT_INTERVAL_SEC`); an envelope reporting 0, or something past a day, is not an interval
/// to judge a heartbeat by — it is treated as unknown, which switches AGENT-STALE off rather than
/// firing it (0) or never firing it for a century (`u64::MAX`, which used to wrap to a negative
/// `i64` in the comparison).
pub const MAX_INTERVAL_SECS: u64 = 86_400;

/// How far AHEAD of this machine's clock a heartbeat may be before it reads as
/// [`TickProblem::Future`]. Small on purpose: the tick is written by this machine's own clock, so
/// the only honest source of a gap is an NTP step, which is seconds.
pub const FUTURE_TICK_SKEW_SECS: i64 = 120;

/// The installed interval, if it is one this app will judge staleness by.
fn valid_interval(schedule: Option<&ScheduleView>) -> Option<u64> {
    schedule
        .and_then(|s| s.interval_sec)
        .filter(|i| (1..=MAX_INTERVAL_SECS).contains(i))
}

/// `HH:MM` for minutes since midnight, when that is a time of day.
fn hhmm(minutes: u32) -> Option<String> {
    (minutes < 24 * 60).then(|| format!("{:02}:{:02}", minutes / 60, minutes % 60))
}

/// The floor to SHOW: the one in force (`minutes`), falling back to the configured string only
/// when `minutes` is not a time of day at all.
pub fn display_floor(morning: &MorningTime) -> String {
    hhmm(morning.minutes).unwrap_or_else(|| morning.value.clone())
}

/// The whole state machine. Pure apart from the local zone (see the module header).
///
/// ## Precedence, and why it is not the order the task text lists
///
/// The appendix and plan R1 both give the state set as a LIST; a list is not a precedence, and
/// several inputs match more than one member at once (past the floor, undelivered, a `limited`
/// skip recorded an hour ago, and a heartbeat that stopped ten minutes later — that is three). The
/// order below is therefore stated, tested (`every_row_yields_exactly_one_state`) and justified:
///
/// 1. **NOT-CONFIGURED** — nothing will EVER deliver; every later state would describe machinery
///    that has no work to do.
/// 2. **CONFIG-ERROR** — the config exists and does not load. Same argument, and `status`'s
///    `configError` is CURRENT rather than "as of the last tick", so it outranks the skip record.
///    It outranks DELIVERED too — tomorrow's briefing will not arrive — but CARRIES the delivery,
///    so the tray says "Delivered 07:24 · config has an error" rather than "not delivered".
/// 3. **NOT-SCHEDULED**, then **SCHEDULER-BROKEN** — nothing will trigger a run. Ranked above
///    DELIVERED deliberately: a briefing that arrived because somebody typed `daily-briefing` is
///    still a machine where tomorrow's will not arrive, and that is the fact worth one button.
/// 4. **DELIVERED** — today's marker is stamped. Ends the question.
/// 5. **SKIPPED** — today's skip record, minus the four reasons a higher phase already explains
///    ([`SkipReason::is_noise`]). A record from ANOTHER local day is ignored: it is yesterday's
///    story and rendering it today is exactly the mask `clearLastSkip` exists to prevent.
/// 6. **UNKNOWN-TICK** — the heartbeat cannot be judged ([`TickProblem`]), so neither staleness
///    nor (for `legacy`) a count can be computed. Any later state would be an assertion about a
///    number this app does not have.
/// 7. **AGENT-STALE** — ranked ABOVE the floor check, because staleness is a property of the
///    TRIGGER and the floor suppresses DELIVERY. At 06:00 with no tick since 22:00 the honest
///    answer is "nothing has checked in for eight hours", not "waiting for 07:20".
/// 8. **WAITING-FOR-FLOOR** / 9. **WAITING-FOR-WAKE** — the two ordinary mornings.
///
/// `schedule` is optional because the app must still say something useful when
/// `schedule status --json` failed while `status --json` succeeded. Without it there is no
/// interval, no `lastTickState` and no registration, so the schedule-derived checks in steps 3, 6
/// and 7 are skipped rather than guessed — a missing envelope must not manufacture a NOT-SCHEDULED
/// banner.
pub fn derive(
    status: &StatusView,
    last_skip: Option<&LastSkip>,
    schedule: Option<&ScheduleView>,
    now: &Now,
) -> ScheduleState {
    let floor = display_floor(&status.morning_time);
    let interval = valid_interval(schedule);

    let phase = derive_phase(status, last_skip, schedule, now, &floor, interval);

    let engine_version = status
        .engine_version
        .clone()
        .or_else(|| schedule.and_then(|s| s.engine_version.clone()));
    let owner = schedule.and_then(|s| s.owner.clone());
    let installed_engine_version = schedule.and_then(|s| s.installed_engine_version.clone());
    let engine_update_available = owner.as_deref() == Some("app")
        && match (&installed_engine_version, &engine_version) {
            (Some(installed), Some(current)) => installed != current,
            // Not knowing one of them is not evidence of skew, and a prompt to "update the
            // background engine" on a machine with no recorded install is a button that would do
            // nothing useful.
            _ => false,
        };

    let scheduled_engine_version = schedule.and_then(|s| s.scheduled_engine_version.clone());
    let older_engine_warning = older_engine_warning(
        status.valid_provider_entries(),
        scheduled_engine_version.as_deref(),
        FIRST_SAME_RUN_SWITCHING_VERSION,
        APP_VERSION,
    );

    ScheduleState {
        status_line: status_line(&phase, &floor),
        phase,
        first_wake: first_wake_sentence(&floor),
        floor,
        floor_warning: status.morning_time.warning.clone(),
        // ⚠ Straight through, INCLUDING the null. See trap 2.
        ticks_today: schedule.and_then(|s| s.ticks_today),
        ticks_expected_since_floor: schedule.and_then(|s| s.ticks_expected_since_floor),
        last_tick: status.last_tick.clone(),
        owner,
        invoker: schedule.and_then(|s| s.invoker.clone()),
        unit_path: schedule.and_then(|s| s.unit_path.clone()),
        registered: schedule.and_then(|s| s.registered),
        record_present: schedule.is_some_and(|s| s.record_present),
        unit_present: schedule.is_some_and(|s| s.unit_present),
        engine_version,
        installed_engine_version,
        engine_update_available,
        interval_sec: interval,
        experimental: schedule.is_some_and(|s| s.experimental),
        linger_state: schedule.and_then(|s| s.linger_state.clone()),
        // Straight through. None of the three feeds the phase: "unknown is not broken" stays
        // `derive_phase`'s step 3, which reads `registered == Some(false)` only.
        record_file_present: schedule.is_some_and(|s| s.record_file_present),
        registered_reason: schedule.and_then(|s| s.registered_reason.clone()),
        remove_steps: schedule.and_then(|s| s.remove_steps.clone()),
        scheduled_engine_version,
        older_engine_warning,
    }
}

fn derive_phase(
    status: &StatusView,
    last_skip: Option<&LastSkip>,
    schedule: Option<&ScheduleView>,
    now: &Now,
    floor: &str,
    interval: Option<u64>,
) -> Phase {
    let floor_minutes = status.morning_time.minutes;
    let tick_state = schedule.and_then(|s| s.last_tick_state.as_deref());
    // An empty local date (no local conversion) matches nothing, so the machine falls through to
    // the tick-based states rather than claiming a delivery it cannot date.
    let delivered_today = !now.local_date.is_empty()
        && status.last_run_date.as_deref() == Some(now.local_date.as_str());

    // 1 ── nothing will ever deliver.
    if !status.config_exists {
        return Phase::NotConfigured;
    }

    // 2 ── the config exists and does not load. `status` is current; the skip record is "as of the
    // last tick", so it is not consulted at all.
    if let Some(message) = &status.config_error {
        return Phase::ConfigError {
            detail: message.clone(),
            delivered_today,
            delivered_at: if delivered_today {
                status.latest_briefing_mtime.clone()
            } else {
                None
            },
        };
    }

    // 3 ── nothing owns the trigger, or what owns it is not there.
    if let Some(s) = schedule {
        if !s.record_present {
            return Phase::NotScheduled;
        }
        if s.registered == Some(false) || !s.unit_present {
            return Phase::SchedulerBroken;
        }
    }

    // 4 ── today is done.
    if delivered_today {
        return Phase::Delivered {
            at: status.latest_briefing_mtime.clone(),
        };
    }

    // 5 ── today's skip record, if it says anything a later phase does not.
    if let Some(skip) = last_skip {
        if !now.local_date.is_empty() && skip.local_date == now.local_date {
            let reason = SkipReason::parse(&skip.reason);
            if !reason.is_noise() {
                return Phase::Skipped {
                    reason,
                    detail: skip.detail.clone(),
                    iso: (!skip.iso.is_empty()).then(|| skip.iso.clone()),
                };
            }
        }
    }

    // 6 ── the heartbeat is there and cannot be judged. Nothing below can be computed from it.
    if tick_state == Some("legacy") {
        return Phase::UnknownTick {
            cause: TickProblem::Legacy,
        };
    }
    let tick_secs = match &status.last_tick {
        None => None,
        Some(tick) => match parse_iso_utc(&tick.iso) {
            Some(secs) => Some(secs),
            None => {
                return Phase::UnknownTick {
                    cause: TickProblem::UnreadableInstant,
                }
            }
        },
    };
    if let Some(secs) = tick_secs {
        if secs.saturating_sub(now.epoch_secs) > FUTURE_TICK_SKEW_SECS {
            return Phase::UnknownTick {
                cause: TickProblem::Future,
            };
        }
    }

    // 7 ── the heartbeat has stopped. Above the floor check: see the precedence note.
    if let Some(interval) = interval {
        // `interval <= MAX_INTERVAL_SECS`, so neither the product nor the cast can wrap.
        let stale_after = interval * STALE_INTERVAL_MULTIPLE;
        match tick_secs {
            Some(secs) if now.epoch_secs.saturating_sub(secs) > stale_after as i64 => {
                return Phase::AgentStale {
                    last_tick: status.last_tick.as_ref().map(|t| t.iso.clone()),
                    stale_after_secs: stale_after,
                };
            }
            // No heartbeat file at all AND the floor has passed: by now the trigger should have
            // fired at least once today. Before the floor this is an ordinary fresh install.
            None if tick_state == Some("absent") && now.minutes >= floor_minutes => {
                return Phase::AgentStale {
                    last_tick: None,
                    stale_after_secs: stale_after,
                };
            }
            _ => {}
        }
    }

    // 8 ── before the floor.
    if now.minutes < floor_minutes {
        return Phase::WaitingForFloor {
            floor: floor.to_string(),
            minutes_until_floor: floor_minutes - now.minutes,
        };
    }

    // 9 ── past the floor, undelivered, heartbeat current. The ordinary morning.
    Phase::WaitingForWake
}

/// The next instant (Unix seconds, strictly after `now`) at which [`derive`] over the SAME
/// envelopes can return a different state. `None` when there is no such instant this function can
/// name. **Pure.**
///
/// ⚠ THIS IS WHAT MAKES A DEAD SCHEDULER VISIBLE. A scheduler that has stopped writes nothing, so a
/// state recomputed only on file events would say "waiting" forever. The watcher wakes at the
/// instant this returns — and at least every `REDERIVE_EVERY` besides, which is what absorbs what
/// this cannot foresee (a DST day that is not 24 hours long, a clock step, a zone change). Whether
/// that wake is a pure re-derive or a real engine read is [`crosses_read_boundary`]'s call.
///
/// The candidates, each only when it lies in the future:
///   * **local midnight** — `delivered` becomes undelivered, and a skip record becomes
///     yesterday's. Computed from `now.minutes` and the seconds of `now.epoch_secs`, which assumes
///     a whole-minute zone offset (every zone in use today) and a 24-hour day (the cap covers DST).
///   * **every minute before the floor** — `minutesUntilFloor` is part of the state, and the floor
///     itself is a minute boundary.
///   * **the stale deadline** — the last tick plus [`STALE_INTERVAL_MULTIPLE`] × the interval,
///     plus one second (stale is STRICTLY more than that).
///   * **the end of a future tick** — the instant a [`TickProblem::Future`] tick comes within
///     [`FUTURE_TICK_SKEW_SECS`].
pub fn next_boundary(
    status: &StatusView,
    schedule: Option<&ScheduleView>,
    now: &Now,
) -> Option<i64> {
    let t = now.epoch_secs;
    let second_of_day = i64::from(now.minutes.min(24 * 60 - 1)) * 60 + t.rem_euclid(60);
    let midnight = (!now.local_date.is_empty()).then(|| t + (86_400 - second_of_day));
    let next_minute =
        (now.minutes < status.morning_time.minutes).then(|| t + (60 - t.rem_euclid(60)));
    let future_ends = status
        .last_tick
        .as_ref()
        .and_then(|tick| parse_iso_utc(&tick.iso))
        .map(|secs| secs - FUTURE_TICK_SKEW_SECS);
    [
        midnight,
        next_minute,
        future_ends,
        stale_deadline(status, schedule),
    ]
    .into_iter()
    .flatten()
    .filter(|&at| at > t)
    .min()
}

/// The first instant (Unix seconds) at which the heartbeat reads as stale: the last tick plus
/// [`STALE_INTERVAL_MULTIPLE`] × the interval, plus one second (stale is STRICTLY more than that).
/// `None` without a parseable tick or a valid interval.
fn stale_deadline(status: &StatusView, schedule: Option<&ScheduleView>) -> Option<i64> {
    status
        .last_tick
        .as_ref()
        .and_then(|tick| parse_iso_utc(&tick.iso))
        .zip(valid_interval(schedule))
        .map(|(secs, interval)| secs + (interval * STALE_INTERVAL_MULTIPLE) as i64 + 1)
}

/// Whether the clock moving from `before` to `after` crosses an instant at which the ENGINE's
/// answer can change as well as [`derive`]'s — so a caller holding envelopes read at `before` must
/// READ them again rather than re-derive. **Pure.**
///
/// ⚠ WHY A RE-DERIVE IS NOT ENOUGH AT THESE INSTANTS. `schedule status --json` recomputes
/// `ticksToday` (today's count, `0` for a tick from yesterday), `ticksExpectedSinceFloor` (`null`
/// before the floor) and the unit's registration on every call (`src/schedule/status.ts`), and a
/// scheduler that died or was unloaded writes nothing. So the moments where the answer turns —
///   * **the local date changing** (midnight, or a clock/zone step across one): yesterday's count is
///     not today's;
///   * **the floor**: the expected-ticks figure starts, and the first tick past it is due;
///   * **the stale deadline**: the heartbeat stopping is exactly when the unit may have been
///     unloaded, which only a fresh `registered` can tell from a sleeping machine;
///   * **the clock going BACKWARDS**: every instant above may have been re-crossed;
///
/// are the ones where envelopes read before them would be paired with a state derived after them.
/// Between them — the minute-by-minute countdown, the future-tick window — a pure re-derive is
/// exact.
pub fn crosses_read_boundary(
    status: &StatusView,
    schedule: Option<&ScheduleView>,
    before: &Now,
    after: &Now,
) -> bool {
    if after.epoch_secs < before.epoch_secs || after.local_date != before.local_date {
        return true;
    }
    let floor = status.morning_time.minutes;
    if before.minutes < floor && after.minutes >= floor {
        return true;
    }
    stale_deadline(status, schedule)
        .is_some_and(|deadline| before.epoch_secs < deadline && after.epoch_secs >= deadline)
}

/// The first-wake sentence, appendix §6 step 5 verbatim with the floor substituted.
///
/// ⚠ ONE SENTENCE, AND IT IS THE WHOLE MITIGATION for the single most common misreading of this
/// product: `morningTime` is a FLOOR that suppresses early ticks, not a delivery time.
pub fn first_wake_sentence(floor: &str) -> String {
    format!(
        "Your briefing is generated on the first check after {floor} once your machine is awake — \
         not at {floor}."
    )
}

/* ── instant arithmetic, hand-rolled and tested ───────────────────────────────────────────────── */

/// Parse EXACTLY the shape `new Date().toISOString()` produces — `YYYY-MM-DDTHH:MM:SS.sssZ`, or
/// the same without the three-digit fraction — into seconds since the Unix epoch. `None` for
/// anything else, including a calendar day that does not exist.
///
/// ⚠ HAND-ROLLED RATHER THAN A DATE CRATE, deliberately. The only instants this app parses are the
/// engine's own, written by one call in one format, and the only arithmetic is a difference in
/// seconds. `chrono`/`time` would add a dependency (and, for `time`, a local-offset API that
/// returns `None` in a multithreaded process) to do less than this does.
///
/// ⚠ STRICT, AND EVERY RULE IS ONE `toISOString()` OBEYS: the length is 20 or 24; every digit
/// position is an ASCII digit and every separator is the literal one; the month is 1-12 and the day
/// exists in that month of that (proleptic Gregorian) year; the hour is 0-23, the minute and second
/// 0-59 (a JavaScript `Date` has no leap second, so `:60` never comes from the engine). A shape it
/// does not recognise returns `None`, and the caller then declines to judge staleness rather than
/// judging it from a number it invented.
pub fn parse_iso_utc(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let separators: &[(usize, u8)] = match b.len() {
        20 => &[
            (4, b'-'),
            (7, b'-'),
            (10, b'T'),
            (13, b':'),
            (16, b':'),
            (19, b'Z'),
        ],
        24 => &[
            (4, b'-'),
            (7, b'-'),
            (10, b'T'),
            (13, b':'),
            (16, b':'),
            (19, b'.'),
            (23, b'Z'),
        ],
        _ => return None,
    };
    for (i, byte) in b.iter().enumerate() {
        match separators.iter().find(|(at, _)| *at == i) {
            Some((_, expected)) if byte != expected => return None,
            Some(_) => {}
            None if !byte.is_ascii_digit() => return None,
            None => {}
        }
    }
    // Every byte is now an ASCII digit or a separator, so these slices are digit runs.
    let num = |from: usize, to: usize| -> i64 {
        b[from..to]
            .iter()
            .fold(0, |acc, d| acc * 10 + i64::from(d - b'0'))
    };
    let (year, month, day) = (num(0, 4), num(5, 7), num(8, 10));
    let (hour, minute, second) = (num(11, 13), num(14, 16), num(17, 19));
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(y) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Days since 1970-01-01 for a proleptic-Gregorian civil date. Howard Hinnant's `days_from_civil`,
/// which is the algorithm the C++ standard's `<chrono>` uses; pinned by
/// `parse_iso_utc_agrees_with_known_instants`.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // March = 0
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// The inverse: a civil date for days since 1970-01-01. Hinnant's `civil_from_days`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// A broken-down wall-clock time: what `localtime_r` produces, minus what this module never reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CivilTime {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
}

/// `secs` as a UTC wall-clock time. **Compiled and tested on every platform**, because it is the
/// non-unix fallback of [`local_civil`] and a fallback nothing type-checks is a fallback that does
/// not build (measured: the previous `cfg(not(unix))` arm returned `Option<()>` and failed with
/// `E0609` the moment the cfg was flipped).
pub fn utc_civil(secs: i64) -> CivilTime {
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    let second_of_day = secs.rem_euclid(86_400);
    CivilTime {
        year,
        month,
        day,
        hour: (second_of_day / 3_600) as u32,
        minute: (second_of_day % 3_600 / 60) as u32,
    }
}

/// `HH:MM` in the LOCAL zone, from a UTC ISO instant. `None` when the instant does not parse.
///
/// Used for "Delivered 07:24": the mtime the engine reports is UTC, and a line showing a UTC clock
/// time would be wrong by the offset for most of the world.
pub fn local_hhmm_from_iso(iso: &str) -> Option<String> {
    let t = local_civil(parse_iso_utc(iso)?)?;
    Some(format!("{:02}:{:02}", t.hour, t.minute))
}

/// [`Now`] for `secs`, given its wall-clock breakdown. `None` (no local conversion) yields an EMPTY
/// local date, which matches no `lastRunDate` — so the machine falls through to the tick-based
/// states rather than claiming a delivery that did not happen.
pub fn now_from_civil(secs: i64, civil: Option<CivilTime>) -> Now {
    match civil {
        Some(t) => Now {
            local_date: format!("{:04}-{:02}-{:02}", t.year, t.month, t.day),
            minutes: t.hour * 60 + t.minute,
            epoch_secs: secs,
        },
        None => Now {
            local_date: String::new(),
            minutes: 0,
            epoch_secs: secs,
        },
    }
}

/* ── the one impure boundary ──────────────────────────────────────────────────────────────────── */

/// `secs` as LOCAL wall-clock time. `None` when the platform's conversion failed.
///
/// ⚠ ONLY THE CALL SITE IS PLATFORM-SELECTED. On unix it is `localtime_r` — the standard library
/// has no local-time conversion at all, which is the whole reason `libc` is a dependency of this
/// crate. Elsewhere it is [`utc_civil`]: **the tray and the Schedule screen show UTC clock times,
/// and "today" is the UTC date, on a non-unix build** until a local-time source is added there.
/// Windows is `experimental: true` on the engine's own scheduling surface, and the screen says so.
fn local_civil(secs: i64) -> Option<CivilTime> {
    #[cfg(unix)]
    {
        unix_local_civil(secs)
    }
    #[cfg(not(unix))]
    {
        Some(utc_civil(secs))
    }
}

#[cfg(unix)]
fn unix_local_civil(secs: i64) -> Option<CivilTime> {
    // SAFETY: `localtime_r` writes a complete `struct tm` through `out` and returns a pointer to it
    // (or null on failure). `t` outlives the call, `out` is a live, properly aligned stack value,
    // and nothing here retains a pointer past the call. `localtime_r` is the reentrant form
    // precisely so this is sound from any thread.
    let tm = unsafe {
        let t = secs as libc::time_t;
        let mut out: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&t, &mut out).is_null() {
            return None;
        }
        out
    };
    Some(CivilTime {
        year: i64::from(tm.tm_year) + 1900,
        month: u32::try_from(tm.tm_mon + 1).ok()?,
        day: u32::try_from(tm.tm_mday).ok()?,
        hour: u32::try_from(tm.tm_hour).ok()?,
        minute: u32::try_from(tm.tm_min).ok()?,
    })
}

/// Today, locally, for [`derive`]'s `now` operand.
///
/// ⚠ THIS IS THE ONLY CLOCK READ IN THE MODULE, and it is not inside the state machine. A caller
/// that wants a fixed instant builds [`Now`] itself; the table test does exactly that, and the
/// watcher takes its clock as an injectable function for the same reason.
pub fn now_local() -> Now {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    now_from_civil(secs, local_civil(secs))
}
