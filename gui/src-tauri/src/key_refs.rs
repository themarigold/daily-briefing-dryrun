//! Which saved entries reference an app key id — the answers the pending-reset store
//! (`crate::pending_resets`, P3-M4-T3, [`entries_referencing_key`]) and the uninstall refusal
//! (`crate::uninstall`, P3-M6-T4, [`any_app_key_referenced`]) consume, both over one join.
//!
//! ⚠ RUST DOES NOT DECIDE WHICH KEY AN ENTRY READS. That is the engine's `config validate` rows'
//! `appKeyId` / `appOwnedKey` (`docs/gui-seam.md` §1d, the PR 3 start decision, 2026-10-18): the
//! engine's `isAppOwnedKey` is the WIDE rule (the Keychain tool reached through `PATH`, `-s<svc>`
//! joined, a `..` alias or a hard link into `<state>/keys/`), and a second, narrower matcher here
//! would miss exactly the hand-edited references that rule exists to catch. A row names the entry
//! by its `index` only — no label — so what this module adds is the JOIN: row index → the entry's
//! label, through [`combined_entries`], the list enumeration the settings guard already used
//! (`config_save::combined_labels`, P3-M2-T1, moved here and now built on it). It is NOT a second
//! list resolver: it reads the written list the way the guard always has, and every decision about
//! which entries RUN (a dropped fallback, a broken `accounts`) stays the engine's — when the rows
//! and the written list do not line up one for one, the answer is [`KeyRefs::Unknown`].
//!
//! A key in doubt is KEPT: a stray Keychain item costs nothing; a deleted one in use skips a
//! briefing. So [`KeyRefs::verdict`] answers [`RefVerdict::Unreferenced`] — the one verdict that
//! lets a caller delete — only when every entry has a row and no row names the id or may read any
//! app key.

use serde_json::Value;

/// The engine's label rule (`nonEmpty`, `src/providerList.ts`): a string that is not empty after
/// JavaScript's `trim()` — Unicode white space and line terminators, plus U+FEFF, but not U+0085.
pub(crate) fn engine_label(v: Option<&Value>) -> Option<&str> {
    let js_space = |c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}';
    v.and_then(Value::as_str)
        .filter(|s| !s.trim_matches(js_space).is_empty())
}

/// Item 1's label when nothing names it — the engine's `DEFAULT_LABEL` (`src/account.ts`), also
/// the list writer's (`gui/src/lib/provider-list.ts`).
pub(crate) const DEFAULT_ITEM1_LABEL: &str = "default";

/// One entry of the combined list AS WRITTEN, at its `--index` position.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ListEntry<'a> {
    /// The entry's label as the engine reads it ([`engine_label`]; item 1 resolved), or `None`
    /// for an entry with no usable label (the engine drops such a fallback).
    pub label: Option<&'a str>,
    /// The object holding the entry's provider block: `provider` for item 1, `provider.accounts[j]`
    /// for login `j` (its `api` is item 1's — a login is CLI), `fallbacks[i]` for a fallback. Read by
    /// uninstall's settings leg (`crate::uninstall`, `key_files_in`), which walks every entry's `api`
    /// block for an `apiKeyFile` (P3-M6-T4).
    pub block: &'a Value,
}

/// The combined list of `root`, as written, one [`ListEntry`] per `--index` position: item 1's
/// logins — `provider.accounts` when item 1 is a CLI provider (no `api`) and `accounts[0]` has a
/// usable label — else item 1 itself, labelled `provider.label` or `"default"`; then every
/// `fallbacks` element, in order. A position whose label is unusable is KEPT (label `None`), so the
/// positions are the engine's `--index` numbering whenever the engine resolves the list as written.
///
/// This is the settings guard's enumeration (P3-M2-T1, formerly `config_save::combined_labels`,
/// which now reads its labels from here): the branch taken for item 1 is exactly the one
/// `config_save`'s `owner` takes. Whether `resolveAccounts` ACCEPTS the logins is the engine's
/// (it checks login directories on disk) — under a broken `accounts` the engine's rows are `[]`,
/// which [`entries_referencing_key`] reads as [`KeyRefs::Unknown`].
pub fn combined_entries(root: &Value) -> Vec<ListEntry<'_>> {
    let mut entries = Vec::new();
    if let Some(provider) = root.get("provider").filter(|p| p.is_object()) {
        let is_api = provider.get("api").is_some();
        let logins = provider
            .get("accounts")
            .and_then(Value::as_array)
            .filter(|a| {
                !is_api
                    && a.first()
                        .and_then(|l| engine_label(l.get("label")))
                        .is_some()
            });
        match logins {
            Some(logins) => entries.extend(logins.iter().map(|l| ListEntry {
                label: engine_label(l.get("label")),
                block: l,
            })),
            None => entries.push(ListEntry {
                label: Some(engine_label(provider.get("label")).unwrap_or(DEFAULT_ITEM1_LABEL)),
                block: provider,
            }),
        }
    }
    if let Some(fallbacks) = root.get("fallbacks").and_then(Value::as_array) {
        entries.extend(fallbacks.iter().map(|f| ListEntry {
            label: engine_label(f.get("label")),
            block: f,
        }));
    }
    entries
}

/// Which saved entries reference one app key id, by label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyRefs {
    /// The rows cannot vouch for every entry: no rows (the config does not resolve, or its
    /// `provider.accounts` is broken), a written entry with no row (the engine dropped it, but its
    /// reference is still in the file), a row the written list has no labelled entry for, or a
    /// malformed row: no usable `index`, or (PR 3 final r4, C5) an `appOwnedKey` that is present
    /// and not a boolean or an `appKeyId` that is present and not a string ([`row_key`]). Nothing
    /// can be said; every key is kept.
    Unknown,
    Known {
        /// The labels whose row's `appKeyId` IS the id.
        definite: Vec<String>,
        /// The labels whose row is `appOwnedKey` with no `appKeyId` — an entry that may read ANY app
        /// key (`docs/gui-seam.md` §1d; hub P3-M1-T1 checkpoint (2)).
        possible: Vec<String>,
    },
}

/// What a caller holding a `(label, keyId)` may do with the key, decided from [`KeyRefs`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefVerdict {
    /// The saved entry under this label reads the id: the save that put it there landed.
    UnderLabel,
    /// Only entries under OTHER labels read the id (the same save renamed the row and replaced its
    /// key — a hand edit, the editor offers no rename): keep the key.
    OtherLabel,
    /// It cannot be told (no usable rows, or a row that may read any app key): keep the key.
    Uncertain,
    /// No saved entry reads it, and the rows vouch for every entry: the one verdict that lets a
    /// caller delete it.
    Unreferenced,
}

impl KeyRefs {
    /// The three-way rule (plan Q11, hub Q21), with "in doubt" as its own verdict.
    pub fn verdict(&self, label: &str) -> RefVerdict {
        match self {
            KeyRefs::Unknown => RefVerdict::Uncertain,
            KeyRefs::Known { definite, possible } => {
                if definite.iter().any(|l| l == label) {
                    RefVerdict::UnderLabel
                } else if !definite.is_empty() {
                    RefVerdict::OtherLabel
                } else if !possible.is_empty() {
                    RefVerdict::Uncertain
                } else {
                    RefVerdict::Unreferenced
                }
            }
        }
    }
}

/// The rows of `config`'s `config validate` report, each paired with the label of the written
/// entry at its `index` — the JOIN both answers below are built on — or `None` when the rows cannot
/// vouch for every entry: no written entries, a row count that is not the entry count, a row with
/// no usable `index`, an index out of range or seen twice, or a row naming an unlabelled entry. So a
/// dropped entry's reference, which the engine reports no row for, can never be missed.
fn joined_rows<'a>(config: &'a Value, rows: &'a [Value]) -> Option<Vec<(&'a str, &'a Value)>> {
    let entries = combined_entries(config);
    // The `rows.len() > entries.len()` half of this is a FAST PATH, not the guarantee (PR 3 final
    // r1, C5): an extra row must repeat an index or name one out of range, which the `seen` slots
    // below refuse anyway. The `<` half is load-bearing — a missing row is caught only here.
    if entries.is_empty() || rows.len() != entries.len() {
        return None;
    }
    let mut seen = vec![false; entries.len()];
    let mut joined = Vec::with_capacity(rows.len());
    for row in rows {
        let index = row
            .get("index")
            .and_then(Value::as_u64)
            .and_then(|i| usize::try_from(i).ok())?;
        let (entry, slot) = (entries.get(index)?, seen.get_mut(index)?);
        if std::mem::replace(slot, true) {
            return None;
        }
        joined.push((entry.label?, row));
    }
    Some(joined)
}

/// The labels of the entries of `config` (the SAVED config) whose `config validate` row — `rows`,
/// the report's `providers`, from validating exactly those bytes — references `key_id`.
///
/// Joined by position: the rows and [`combined_entries`] must line up one for one (as many rows as
/// written entries, each index once, each naming a labelled entry), or the answer is
/// [`KeyRefs::Unknown`] — so a dropped entry's reference, which the engine reports no row for, can
/// never be missed. One malformed row ([`row_key`]) makes the answer [`KeyRefs::Unknown`] too.
pub fn entries_referencing_key(config: &Value, rows: &[Value], key_id: &str) -> KeyRefs {
    let Some(joined) = joined_rows(config, rows) else {
        return KeyRefs::Unknown;
    };
    let mut definite = Vec::new();
    let mut possible = Vec::new();
    for (label, row) in joined {
        match row_key(row) {
            None => return KeyRefs::Unknown,
            Some(RowKey::Id(id)) if id == key_id => definite.push(label.to_string()),
            Some(RowKey::Any) => possible.push(label.to_string()),
            Some(RowKey::Id(_) | RowKey::NotAppKey) => {}
        }
    }
    KeyRefs::Known { definite, possible }
}

/// What one `config validate` row says about its entry's key ([`row_key`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RowKey<'a> {
    /// No app key: neither field, or `appOwnedKey: false` with no `appKeyId`.
    NotAppKey,
    /// `appOwnedKey: true` with no `appKeyId` — the entry may read ANY app key.
    Any,
    /// `appKeyId` names this id (with `appOwnedKey` absent or a boolean).
    Id(&'a str),
}

/// The one reader of a row's two key fields, shared by both answers so they read one shape (PR 3
/// final r4, C5): `None` — MALFORMED — when `appOwnedKey` is present and not a boolean, or
/// `appKeyId` is present and not a string. Each caller fails closed on `None`.
fn row_key(row: &Value) -> Option<RowKey<'_>> {
    let owned = match row.get("appOwnedKey") {
        None => false,
        Some(v) => v.as_bool()?,
    };
    match row.get("appKeyId") {
        Some(v) => v.as_str().map(RowKey::Id),
        None if owned => Some(RowKey::Any),
        None => Some(RowKey::NotAppKey),
    }
}

/// Whether ANY entry of `config` may read ANY app key, from its `config validate` rows — uninstall's
/// question about a KEPT schedule's config (P3-M6-T4, the PR 3 start decision): `Some(false)` only
/// when the rows vouch for every entry ([`joined_rows`]) and none says the entry's key is the app's;
/// `Some(true)` when one does; `None` when the rows cannot vouch. Fails closed on the row's shape
/// ([`row_key`]): an `appKeyId` of any value, or an `appOwnedKey` that is present and not `false`,
/// counts — a malformed row among them.
pub fn any_app_key_referenced(config: &Value, rows: &[Value]) -> Option<bool> {
    let joined = joined_rows(config, rows)?;
    Some(
        joined
            .iter()
            .any(|(_, row)| row_key(row) != Some(RowKey::NotAppKey)),
    )
}
