//! The stored AI summary: Rust's own check of its text and record, and the read that binds a sidecar
//! to the latest page. The webview is handed validated strings and fixed codes, or ordinary absence.
//!
//! ## Rust's copy of the engine's rules
//!
//! `src/summary/validate.ts` and `src/summary/store.ts` write the record; this module does not trust
//! that they did. Both languages run `summary-text-vectors.json` and `summary-record-vectors.json`.
//! The SHA-shape rule is a port of `isShaShaped`, `evidenceTokens` and `bareToken` (`src/sha.ts`), and
//! a stored record is refused whole, as `parseSummaryRecord` refuses it: nothing here repairs one.
//!
//! The formatting predicates need no translation, but three things around them were chosen so the two
//! regex engines answer alike. Only strings already clear of controls, U+0085, U+FEFF and U+2028/9
//! reach them, which is where JavaScript's `\s` and `trim` differ from Rust's. Case folding is written
//! out for `www.`, because under `iu` Bun's negated class matches U+212A and U+017F (measured) and
//! `(?i)` would not. And serde's own decode supplies the refusals the engine hand-writes: a repeated
//! key, a BOM, trailing text, a lone surrogate escape, and any number not spelled as an unsigned
//! integer.
//!
//! ## What is deliberately absent
//!
//! Card membership (only the webview holds the page's cards), the `aiSummary` switch (the webview's
//! status gate), and any clock: the sidecar's date is the delivery marker's, from `status --json`.

use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
use tauri::State;

use crate::access::read_envelope;
use crate::briefing_files::{absolute, archive_date, read_latest_briefing_at, read_text_capped};
use crate::engine::{is_refused_format_character, Engine, EngineClient, Operation};
use crate::schedule_state::{is_page_identity, StatusView, SummaryState, SummaryWarningCode};

/// The whole stored record, in UTF-8 bytes (`MAX_RECORD_BYTES`, `src/summary/store.ts`).
pub const MAX_RECORD_BYTES: usize = 64 * 1024;
const MAX_PROJECTS: usize = 64;
const MAX_POINTS: usize = 3;
const MAX_POINT_SCALARS: usize = 90;
const MAX_SENTENCE_SCALARS: usize = 240;

/* ── the wire ─────────────────────────────────────────────────────────────────────────────────── */

/// `read_latest_summary`'s operand: two opaque identities, never a path.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SummaryRequest {
    pub page_hash: String,
    pub page_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SummaryProject {
    pub key: String,
    pub points: Vec<String>,
}

/// What the webview receives. `Unavailable` with no warnings is also ordinary absence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SummaryReply {
    #[serde(rename_all = "camelCase")]
    Ready {
        page_hash: String,
        page_version: String,
        revision: u8,
        projects: Vec<SummaryProject>,
        good_morning_sentence: Option<String>,
        warnings: Vec<SummaryWarningCode>,
    },
    Pending {
        warnings: Vec<SummaryWarningCode>,
    },
    Unavailable {
        warnings: Vec<SummaryWarningCode>,
    },
}

impl SummaryReply {
    fn absent() -> Self {
        Self::Unavailable {
            warnings: Vec::new(),
        }
    }
}

/// An operand that is not a 64-hex identity. Refused before the engine is asked or a file is opened,
/// and distinct from absence: the webview only ever sends what a page read gave it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SummaryReadError {
    InvalidOperand,
}

/* ── the stored text ──────────────────────────────────────────────────────────────────────────── */

static FORMATTING: LazyLock<[Regex; 7]> = LazyLock::new(|| {
    [
        r"\*\*[^\s*]([^*]*[^\s*])?\*\*",
        r"__[^\s_]([^_]*[^\s_])?__",
        r"\*[^\s*]([^*]*[^\s*])?\*",
        r"^#+ ",
        r"^([-*] |[0-9]+\. )",
        r"\[[^\]]*\]\([^)]*\)",
        r"`",
    ]
    .map(|pattern| Regex::new(pattern).expect("a literal pattern"))
});
static CITATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[^\s:]*[A-Za-z0-9_-]\.[A-Za-z0-9]+:[1-9][0-9]*[,.;:)]*$")
        .expect("a literal pattern")
});
static EXTENSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.([A-Za-z0-9]+):").expect("a literal pattern"));
static SCHEME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(^|[^A-Za-z0-9])[A-Za-z][A-Za-z0-9+.-]*:\S").expect("a literal pattern")
});
static WWW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[^A-Za-z0-9])[wW][wW][wW]\.\S").expect("a literal pattern"));
static BRANCH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:(?:[-*•◦▪]|\[[^\]]*\])\s*)*(On branch |Detached HEAD at )")
        .expect("a literal pattern")
});
/// A dot-label that names a web domain, so `evil.com:443` is never a file citation.
const WEB_EXTENSIONS: [&str; 9] = ["com", "org", "net", "io", "dev", "co", "ai", "edu", "gov"];

fn refused_scalar(c: char) -> bool {
    c <= '\u{1f}'
        || ('\u{7f}'..='\u{9f}').contains(&c)
        || matches!(c, '\u{2028}' | '\u{2029}')
        || is_refused_format_character(c)
}

/// `isShaShaped`: 4-40 hex digits in either case, with a letter, and a digit or at least seven long.
/// All-digit dates and PR numbers and short all-letter words are not SHAs.
fn is_sha_shaped(token: &str) -> bool {
    (4..=40).contains(&token.len())
        && token.bytes().all(|b| b.is_ascii_hexdigit())
        && token.bytes().any(|b| b.is_ascii_alphabetic())
        && (token.bytes().any(|b| b.is_ascii_digit()) || token.len() >= 7)
}

/// `evidenceTokens` then `bareToken`, then the shape.
fn names_a_sha(text: &str) -> bool {
    text.split(|c: char| c == ',' || c.is_whitespace())
        .map(|token| token.replace(['(', ')'], ""))
        .any(|token| {
            is_sha_shaped(
                token
                    .trim_start_matches(['`', '\'', '"', '[', '{', '*', '_'])
                    .trim_end_matches([
                        '`', '\'', '"', ']', '}', '*', '_', '.', ',', ';', ':', '!', '?',
                    ]),
            )
        })
}

fn has_url_marker(text: &str) -> bool {
    text.split_whitespace().any(|token| {
        if WWW.is_match(token) {
            return true;
        }
        // A file citation is exempt from the scheme rule only; `www.` above has already been checked.
        let citation = CITATION.is_match(token)
            && EXTENSION.captures(token).is_some_and(|found| {
                !WEB_EXTENSIONS.contains(&found[1].to_ascii_lowercase().as_str())
            });
        !citation && SCHEME.is_match(token)
    })
}

/// `validateSummaryText`: the trimmed text if it is one safe plain-text line of at most `max_scalars`
/// Unicode scalars. Structural safety only; it says nothing about whether the text is true.
pub fn validate_summary_text(value: &str, max_scalars: usize) -> Option<&str> {
    // Before the trim, so it cannot hide a trailing line break or control.
    if value.chars().any(refused_scalar) {
        return None;
    }
    let text = value.trim();
    let scalars = text.chars().count();
    let unsafe_text = scalars == 0
        || scalars > max_scalars
        || text.contains(['<', '>'])
        || FORMATTING.iter().any(|pattern| pattern.is_match(text))
        || BRANCH.is_match(text)
        || has_url_marker(text)
        || names_a_sha(text);
    (!unsafe_text).then_some(text)
}

/// The same check for a stored string, which must already be exactly what the check would keep.
fn stored_text_is_safe(value: &str, max_scalars: usize) -> bool {
    validate_summary_text(value, max_scalars) == Some(value)
}

/* ── the stored record ────────────────────────────────────────────────────────────────────────── */

/// A required member that may be `null`. A plain `Option` would read a missing one as `null` too.
fn required_nullable<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::deserialize(d)
}

/// Schema 1, by its exact fields. `u8` takes only an unsigned integer spelling: serde_json decodes
/// `1.0`, `1e0` and `-0` as floats, which an integer field refuses.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredRecord {
    schema_version: u8,
    page_date: String,
    page_hash: String,
    page_version: String,
    state: SummaryState,
    revision: u8,
    projects: Vec<SummaryProject>,
    #[serde(deserialize_with = "required_nullable")]
    good_morning_sentence: Option<String>,
    warnings: Vec<SummaryWarningCode>,
}

/// A card's machine key. Syntax only, with no trim: `project:foo ` is a real key, and membership is
/// the webview's. `norm` cannot decide this, because it is not idempotent.
fn is_stored_key(key: &str) -> bool {
    key == "other:"
        || key
            .strip_prefix("project:")
            .is_some_and(|name| !name.is_empty())
}

fn ready_values_are_valid(record: &StoredRecord) -> bool {
    let mut keys = HashSet::new();
    record.projects.len() <= MAX_PROJECTS
        && record.projects.iter().all(|project| {
            is_stored_key(&project.key)
                && keys.insert(project.key.as_str())
                && (1..=MAX_POINTS).contains(&project.points.len())
                && project
                    .points
                    .iter()
                    .all(|point| stored_text_is_safe(point, MAX_POINT_SCALARS))
        })
        && record
            .good_morning_sentence
            .as_deref()
            .is_none_or(|sentence| stored_text_is_safe(sentence, MAX_SENTENCE_SCALARS))
}

/// A record's whole text, bound to one date and identity, as the reply it allows. Any failure is
/// `None`, with no reason: a stored record is refused whole and never quoted back.
pub fn parse_stored_record(
    raw: &str,
    date: &str,
    hash: &str,
    version: &str,
) -> Option<SummaryReply> {
    if raw.len() > MAX_RECORD_BYTES {
        return None;
    }
    let record: StoredRecord = serde_json::from_str(raw).ok()?;
    let bound = record.schema_version == 1
        && record.page_date == date
        && record.page_hash == hash
        && record.page_version == version;
    let revision_matches = record.revision == u8::from(record.state != SummaryState::Pending);
    // Deduplicated, and the config code is status-only: a sidecar never carries it.
    let warnings_ok = record.warnings.iter().enumerate().all(|(i, code)| {
        *code != SummaryWarningCode::SummaryConfigInvalid && !record.warnings[..i].contains(code)
    });
    if !bound || !revision_matches || !warnings_ok {
        return None;
    }
    if record.state == SummaryState::Ready {
        if !ready_values_are_valid(&record) {
            return None;
        }
        return Some(SummaryReply::Ready {
            page_hash: record.page_hash,
            page_version: record.page_version,
            revision: record.revision,
            projects: record.projects,
            good_morning_sentence: record.good_morning_sentence,
            warnings: record.warnings,
        });
    }
    if !record.projects.is_empty() || record.good_morning_sentence.is_some() {
        return None;
    }
    Some(match record.state {
        SummaryState::Pending => SummaryReply::Pending {
            warnings: record.warnings,
        },
        _ => SummaryReply::Unavailable {
            warnings: record.warnings,
        },
    })
}

/// M5's date rule, the engine's `validDate`, for the delivery marker's date. `marker.ts` checks shape
/// only, so `2026-02-30` can arrive here. [`archive_date`] is the same calendar except that it refuses
/// year 0000, which the engine admits (measured); year 0400 has the same leap rule.
pub fn is_summary_date(value: &str) -> bool {
    match value.strip_prefix("0000") {
        Some(rest) => archive_date(&format!("0400{rest}")).is_ok(),
        None => archive_date(value).is_ok(),
    }
}

/* ── the read ─────────────────────────────────────────────────────────────────────────────────── */

fn read_bound_record(
    status: &StatusView,
    request: &SummaryRequest,
    opening: &mut impl FnMut(&Path),
) -> Option<SummaryReply> {
    let date = status
        .last_run_date
        .as_deref()
        .filter(|d| is_summary_date(d))?;
    let paths = &status.paths;
    let page_path = absolute(
        "status --json",
        "paths.latestBriefingPath",
        paths.latest_briefing_path.as_ref(),
    )
    .ok()?;
    let briefings = absolute(
        "status --json",
        "paths.briefingsDir",
        paths.briefings_dir.as_ref(),
    )
    .ok()?;
    // Every failure below is absence: a page read's error text holds its path and the OS error.
    opening(&page_path);
    let page = read_latest_briefing_at(&page_path).ok()?;
    let (hash, version) = (&request.page_hash, &request.page_version);
    if page.page_hash.as_ref() != Some(hash) || page.page_version.as_ref() != Some(version) {
        return None;
    }
    // As the engine's reader: the sidecar's parent must be a real directory, not a symlink to one.
    if !std::fs::symlink_metadata(&briefings).ok()?.is_dir() {
        return None;
    }
    let record_path = briefings.join(format!("{date}.{hash}.{version}.summary.json"));
    opening(&record_path);
    let raw = read_text_capped(&record_path, MAX_RECORD_BYTES as u64).ok()?;
    parse_stored_record(&raw, date, hash, version)
}

fn check_operands(request: &SummaryRequest) -> Result<(), SummaryReadError> {
    if is_page_identity(&request.page_hash) && is_page_identity(&request.page_version) {
        Ok(())
    } else {
        Err(SummaryReadError::InvalidOperand)
    }
}

/// [`read_latest_summary_with`], telling `opening` each path just before it is opened. The operands
/// are checked first, so a refused one reaches neither the engine nor the filesystem.
pub async fn read_latest_summary_observed(
    client: &EngineClient,
    request: &SummaryRequest,
    mut opening: impl FnMut(&Path) + Send,
) -> Result<SummaryReply, SummaryReadError> {
    check_operands(request)?;
    let Ok(envelope) = read_envelope(client, Operation::Status).await else {
        return Ok(SummaryReply::absent());
    };
    let Ok(status) = serde_json::from_value::<StatusView>(envelope) else {
        return Ok(SummaryReply::absent());
    };
    Ok(read_bound_record(&status, request, &mut opening).unwrap_or_else(SummaryReply::absent))
}

/// The summary bound to the latest page's identity, or ordinary absence.
pub async fn read_latest_summary_with(
    client: &EngineClient,
    request: &SummaryRequest,
) -> Result<SummaryReply, SummaryReadError> {
    read_latest_summary_observed(client, request, |_| {}).await
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &["read_latest_summary"];

/// The webview's one read of the stored summary. No engine verb of its own: `status --json`, then the
/// read above.
///
/// ⚠ A CLIENT THAT FAILED AT STARTUP IS ABSENCE, NOT AN ERROR. The other reads copy this error's text
/// across IPC (`BriefingError::Engine`), and it holds the path the app looked at; nothing but fixed
/// codes crosses here, and `SummaryReadError` has no member that could carry it.
#[tauri::command]
pub async fn read_latest_summary(
    engine: State<'_, Engine>,
    request: SummaryRequest,
) -> Result<SummaryReply, SummaryReadError> {
    check_operands(&request)?;
    let Ok(client) = engine.client() else {
        return Ok(SummaryReply::absent());
    };
    read_latest_summary_with(client, &request).await
}
